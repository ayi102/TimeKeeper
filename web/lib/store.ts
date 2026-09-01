import { DateTime } from "luxon";
import { sql } from "./db";
import { Times, Money, Shift } from "./core";

/**
 * Data access — the cloud port of Db.kt. Money/hours totals are computed in TS
 * (not SQL) using the same Money helpers as the tablet, so rounding and accrual
 * of still-open entries match byte-for-byte.
 */

// ---------- shared helpers ----------

function secondsWorked(clockIn: string, clockOut: string | null, now: DateTime): number {
  const start = Times.parse(clockIn);
  const end = clockOut ? Times.parse(clockOut) : now;
  return Math.max(0, end.diff(start, "seconds").seconds);
}

// ---------- employees ----------

export interface Emp { id: number; name: string; clockedIn: boolean; }
export interface EmpAdmin { id: number; name: string; rate: number; active: boolean; }

export async function employees(): Promise<Emp[]> {
  const rows = await sql()`
    select e.id, e.name,
           exists(select 1 from time_entries t where t.employee_id = e.id and t.clock_out is null) as in_now
    from employees e where e.active = true order by lower(e.name)`;
  return rows.map((r) => ({ id: Number(r.id), name: r.name, clockedIn: r.in_now }));
}

export async function employeesAdmin(): Promise<EmpAdmin[]> {
  const rows = await sql()`
    select id, name, hourly_rate, active from employees order by active desc, lower(name)`;
  return rows.map((r) => ({ id: Number(r.id), name: r.name, rate: Number(r.hourly_rate), active: r.active }));
}

export async function employeeName(id: number): Promise<string | null> {
  const rows = await sql()`select name from employees where id = ${id} and active = true`;
  return rows.length ? rows[0].name : null;
}

export async function addEmployee(name: string, rate: number): Promise<number> {
  const [row] = await sql()`insert into employees (name, hourly_rate) values (${name}, ${rate}) returning id`;
  return Number(row.id);
}

export async function updateEmployee(id: number, name: string, rate: number): Promise<void> {
  await sql()`update employees set name = ${name}, hourly_rate = ${rate} where id = ${id}`;
}

export async function setEmployeeActive(id: number, active: boolean): Promise<void> {
  await sql()`update employees set active = ${active} where id = ${id}`;
}

export async function deleteEmployee(id: number): Promise<void> {
  // FK cascade removes entries/payments/schedules/alerts.
  await sql()`delete from employees where id = ${id}`;
}

// ---------- summary / finance ----------

export interface Summary {
  id: number; name: string; hours: number; pay: number;
  paid: number; owed: number; owedDue: number; tips: number;
}

export async function summarize(now: DateTime): Promise<Summary[]> {
  const emps = await sql()`select id, name, hourly_rate from employees order by active desc, lower(name)`;
  const entries = await sql()`select employee_id, clock_in, clock_out from time_entries`;
  const pays = await sql()`select employee_id, amount, tip from payments`;

  const secs = new Map<number, number>();
  for (const e of entries) {
    const id = Number(e.employee_id);
    secs.set(id, (secs.get(id) ?? 0) + secondsWorked(e.clock_in, e.clock_out, now));
  }
  const paidM = new Map<number, number>();
  const tipM = new Map<number, number>();
  for (const p of pays) {
    const id = Number(p.employee_id);
    paidM.set(id, (paidM.get(id) ?? 0) + Number(p.amount));
    tipM.set(id, (tipM.get(id) ?? 0) + Number(p.tip));
  }
  return emps.map((e) => {
    const id = Number(e.id);
    const hours = Money.hours(secs.get(id) ?? 0);
    const pay = Money.pay(hours, Number(e.hourly_rate));
    const paid = Money.round2(paidM.get(id) ?? 0);
    const owed = Money.round2(pay - paid);
    return { id, name: e.name, hours, pay, paid, owed, owedDue: Money.owedDue(owed), tips: Money.round2(tipM.get(id) ?? 0) };
  });
}

export interface Finance {
  name: string; earned: number; paid: number; owed: number; owedDue: number; tips: number;
}

export async function financeFor(id: number, now: DateTime): Promise<Finance | null> {
  const emp = await sql()`select name, hourly_rate from employees where id = ${id}`;
  if (!emp.length) return null;
  const entries = await sql()`select clock_in, clock_out from time_entries where employee_id = ${id}`;
  const pays = await sql()`select amount, tip from payments where employee_id = ${id}`;
  let s = 0;
  for (const e of entries) s += secondsWorked(e.clock_in, e.clock_out, now);
  let paid = 0, tips = 0;
  for (const p of pays) { paid += Number(p.amount); tips += Number(p.tip); }
  const hours = Money.hours(s);
  const pay = Money.pay(hours, Number(emp[0].hourly_rate));
  const owed = Money.round2(pay - Money.round2(paid));
  return { name: emp[0].name, earned: pay, paid: Money.round2(paid), owed, owedDue: Money.owedDue(owed), tips: Money.round2(tips) };
}

// ---------- payments ----------

export interface Payment { id: number; paidAt: string; amount: number; tip: number; note: string; }

export async function payments(id: number): Promise<Payment[]> {
  const rows = await sql()`
    select id, paid_at, amount, tip, coalesce(note,'') as note
    from payments where employee_id = ${id} order by paid_at desc`;
  return rows.map((r) => ({ id: Number(r.id), paidAt: r.paid_at, amount: Number(r.amount), tip: Number(r.tip), note: r.note }));
}

export async function addPayment(id: number, amount: number, tip: number, note: string, now: DateTime): Promise<void> {
  await sql()`insert into payments (employee_id, amount, tip, paid_at, note)
              values (${id}, ${amount}, ${tip}, ${Times.format(now)}, ${note})`;
}

export async function deletePayment(id: number): Promise<void> {
  await sql()`delete from payments where id = ${id}`;
}

// ---------- time entries ----------

export interface EntryRow { id: number; clockIn: string; clockOut: string | null; hours: number; open: boolean; }
export interface OpenEntry { id: number; clockIn: string; }

export async function entriesFor(id: number, now: DateTime): Promise<EntryRow[]> {
  const rows = await sql()`select id, clock_in, clock_out from time_entries where employee_id = ${id} order by clock_in desc`;
  return rows.map((r) => {
    const out = r.clock_out as string | null;
    return { id: Number(r.id), clockIn: r.clock_in, clockOut: out, hours: Money.hours(secondsWorked(r.clock_in, out, now)), open: out == null };
  });
}

export async function openEntry(id: number): Promise<OpenEntry | null> {
  const rows = await sql()`select id, clock_in from time_entries where employee_id = ${id} and clock_out is null limit 1`;
  return rows.length ? { id: Number(rows[0].id), clockIn: rows[0].clock_in } : null;
}

export interface OpenEntryFull { id: number; employeeId: number; clockIn: string; }
export async function openEntries(): Promise<OpenEntryFull[]> {
  const rows = await sql()`select id, employee_id, clock_in from time_entries where clock_out is null`;
  return rows.map((r) => ({ id: Number(r.id), employeeId: Number(r.employee_id), clockIn: r.clock_in }));
}

export async function insertClockIn(id: number, clockIn: string, actualIn: string): Promise<void> {
  await sql()`insert into time_entries (employee_id, clock_in, actual_in) values (${id}, ${clockIn}, ${actualIn})`;
}

export async function closeEntry(id: number, clockOut: string, actualOut: string): Promise<void> {
  await sql()`update time_entries set clock_out = ${clockOut}, actual_out = ${actualOut} where id = ${id}`;
}

export async function autoClose(id: number, clockOut: string): Promise<void> {
  await sql()`update time_entries set clock_out = ${clockOut} where id = ${id}`;
}

export async function addEntry(id: number, clockIn: string, clockOut: string | null): Promise<void> {
  await sql()`insert into time_entries (employee_id, clock_in, actual_in, clock_out, actual_out)
              values (${id}, ${clockIn}, ${clockIn}, ${clockOut}, ${clockOut})`;
}

export async function updateEntry(id: number, clockIn: string, clockOut: string | null): Promise<void> {
  await sql()`update time_entries set clock_in = ${clockIn}, clock_out = ${clockOut} where id = ${id}`;
}

export async function deleteEntry(id: number): Promise<void> {
  await sql()`delete from time_entries where id = ${id}`;
}

// ---------- schedules ----------

export async function schedulesFor(id: number, weekday: number): Promise<Shift[]> {
  const rows = await sql()`
    select start_time, end_time from schedules where employee_id = ${id} and weekday = ${weekday} order by start_time`;
  return rows.map((r) => ({ startTime: r.start_time, endTime: r.end_time }));
}

export interface SchedRow { weekday: number; start: string; end: string; }
export async function schedulesOf(id: number): Promise<SchedRow[]> {
  const rows = await sql()`
    select weekday, start_time, end_time from schedules where employee_id = ${id} order by weekday, start_time`;
  return rows.map((r) => ({ weekday: r.weekday, start: r.start_time, end: r.end_time }));
}

export async function replaceSchedules(id: number, shifts: SchedRow[]): Promise<void> {
  await sql().begin(async (tx) => {
    await tx`delete from schedules where employee_id = ${id}`;
    for (const s of shifts) {
      await tx`insert into schedules (employee_id, weekday, start_time, end_time)
               values (${id}, ${s.weekday}, ${s.start}, ${s.end})`;
    }
  });
}

// ---------- missed-clock-in support ----------

export async function activeWorkers(): Promise<{ id: number; name: string }[]> {
  const rows = await sql()`select id, name from employees where active = true`;
  return rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

export async function clockInsOn(id: number, dateISO: string): Promise<DateTime[]> {
  const rows = await sql()`
    select clock_in from time_entries where employee_id = ${id} and substr(clock_in, 1, 10) = ${dateISO}`;
  return rows.map((r) => Times.parse(r.clock_in));
}

export async function alertExists(id: number, shiftKey: string): Promise<boolean> {
  const rows = await sql()`select 1 from clockin_alerts where employee_id = ${id} and shift_date = ${shiftKey}`;
  return rows.length > 0;
}

export async function recordAlert(id: number, shiftKey: string, sentAt: string): Promise<void> {
  await sql()`insert into clockin_alerts (employee_id, shift_date, sent_at)
              values (${id}, ${shiftKey}, ${sentAt}) on conflict (employee_id, shift_date) do nothing`;
}

/** Per-worker worked seconds for entries whose clock-in DATE is in [start, end]. */
export async function periodSeconds(startISO: string, endISO: string, now: DateTime): Promise<Map<number, number>> {
  const rows = await sql()`select employee_id, clock_in, clock_out from time_entries`;
  const out = new Map<number, number>();
  for (const r of rows) {
    const d = r.clock_in.slice(0, 10);
    if (d < startISO || d > endISO) continue;
    const id = Number(r.employee_id);
    out.set(id, (out.get(id) ?? 0) + secondsWorked(r.clock_in, r.clock_out, now));
  }
  return out;
}

// ---------- medications ----------

export interface MedSlotRow { weekday: number; time: string; }
export interface Med { id: number; name: string; notes: string; active: boolean; slots: MedSlotRow[]; }
export interface DueMed { name: string; notes: string; }

export async function meds(): Promise<Med[]> {
  const slotRows = await sql()`select medication_id, weekday, time_of_day from med_times order by weekday, time_of_day`;
  const byMed = new Map<number, MedSlotRow[]>();
  for (const r of slotRows) {
    const id = Number(r.medication_id);
    if (!byMed.has(id)) byMed.set(id, []);
    byMed.get(id)!.push({ weekday: r.weekday, time: r.time_of_day });
  }
  const rows = await sql()`select id, name, notes, active from medications order by active desc, lower(name)`;
  return rows.map((r) => ({ id: Number(r.id), name: r.name, notes: r.notes, active: r.active, slots: byMed.get(Number(r.id)) ?? [] }));
}

export async function saveMed(id: number | null, name: string, notes: string, slots: MedSlotRow[]): Promise<number> {
  return await sql().begin(async (tx) => {
    let medId: number;
    if (id != null) {
      await tx`update medications set name = ${name}, notes = ${notes} where id = ${id}`;
      medId = id;
    } else {
      const [row] = await tx`insert into medications (name, notes) values (${name}, ${notes}) returning id`;
      medId = Number(row.id);
    }
    await tx`delete from med_times where medication_id = ${medId}`; // cascade clears med_fired
    for (const s of slots) {
      await tx`insert into med_times (medication_id, weekday, time_of_day) values (${medId}, ${s.weekday}, ${s.time})`;
    }
    return medId;
  });
}

export async function setMedActive(id: number, active: boolean): Promise<void> {
  await sql()`update medications set active = ${active} where id = ${id}`;
}

export async function deleteMed(id: number): Promise<void> {
  await sql()`delete from medications where id = ${id}`; // cascade clears med_times + med_fired
}

/** Meds whose scheduled time just arrived today (within 90s) and not yet fired. */
export async function medsDue(now: DateTime): Promise<DueMed[]> {
  const today = now.toFormat("yyyy-MM-dd");
  const wd = now.weekday - 1;
  const cands = await sql()`
    select mt.id, m.name, m.notes, mt.time_of_day
    from med_times mt join medications m on m.id = mt.medication_id
    where m.active = true and mt.weekday = ${wd}`;
  const due: DueMed[] = [];
  for (const c of cands) {
    const [h, m] = (c.time_of_day as string).split(":").map((x: string) => parseInt(x, 10));
    if (Number.isNaN(h) || Number.isNaN(m)) continue;
    const sched = now.set({ hour: h, minute: m, second: 0, millisecond: 0 });
    const diff = now.diff(sched, "seconds").seconds;
    if (diff >= 0 && diff <= 90) {
      const rows = await sql()`
        insert into med_fired (med_time_id, fired_date) values (${Number(c.id)}, ${today})
        on conflict do nothing returning med_time_id`;
      if (rows.length) due.push({ name: c.name, notes: c.notes });
    }
  }
  return due;
}

// ---------- settings (admin PIN + mail) ----------

export async function getSetting(key: string): Promise<string | null> {
  const rows = await sql()`select value from settings where key = ${key}`;
  return rows.length ? rows[0].value : null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await sql()`insert into settings (key, value) values (${key}, ${value})
              on conflict (key) do update set value = excluded.value`;
}

export async function getAdminPin(): Promise<string> {
  return (await getSetting("admin_pin")) ?? process.env.TIMEKEEPER_ADMIN_PIN ?? "1234";
}
