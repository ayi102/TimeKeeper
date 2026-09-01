import { DateTime } from "luxon";
import { Times, Scheduling, Money, weekday, Shift } from "./core";
import * as store from "./store";

/**
 * Pay + behavior analytics.
 *
 * Pay uses the paid clock_in/clock_out (same math as everywhere else).
 *
 * Behavior compares the RAW taps (actual_in/actual_out) against the shift the tap
 * actually falls inside — never a "nearest" guess — so a clock-in at a time that
 * isn't on the schedule is counted as a worked shift but NOT flagged late/early
 * (otherwise imperfect schedules produce nonsense). Late/early need a real tap-in;
 * overtime/forgot-out need a real tap-out. "Missed" is day-level: a scheduled,
 * already-past day with zero clock-ins. Behavior covers the last BEHAVIOR_DAYS.
 */

const GRACE = Number(process.env.TIMEKEEPER_EARLY_GRACE_MIN ?? 15);
const LATE_MIN = 5;
const EARLY_MIN = 3;
const OT_MIN = 5;
const BEHAVIOR_DAYS = 90;
const MONTHS_BACK = 3;

export interface MonthPay { month: string; hours: number; pay: number; }
export interface WorkerInsight {
  id: number; name: string; rate: number; active: boolean;
  thisMonth: { hours: number; pay: number };
  lastMonth: { hours: number; pay: number };
  allTime: { hours: number; pay: number; paid: number; owed: number };
  months: MonthPay[];
  behavior: { shifts: number; late: number; tooEarly: number; overtime: number; forgotOut: number; missed: number };
}

/** The shift window that actually contains `t` (within the early grace), or null. */
function containingShift(shifts: Shift[], t: DateTime): [DateTime, DateTime] | null {
  const date = t.startOf("day");
  for (const s of shifts) {
    const start = Scheduling.combine(date, s.startTime);
    const end = Scheduling.shiftEnd(date, s.startTime, s.endTime);
    if (t.toMillis() >= start.minus({ minutes: GRACE }).toMillis() && t.toMillis() < end.toMillis()) return [start, end];
  }
  return null;
}

export async function computeInsights(now: DateTime = Times.now()) {
  const emps = await store.employeesAdmin();
  const entries = await store.allTimeEntries();
  const scheds = await store.allSchedules();
  const running = new Map((await store.summarize(now)).map((s) => [s.id, s]));

  const schedByEmpWd = new Map<string, Shift[]>();
  for (const s of scheds) {
    const k = `${s.employeeId}:${s.weekday}`;
    if (!schedByEmpWd.has(k)) schedByEmpWd.set(k, []);
    schedByEmpWd.get(k)!.push({ startTime: s.start, endTime: s.end });
  }

  const thisMonth = now.toFormat("yyyy-MM");
  const lastMonth = now.minus({ months: 1 }).toFormat("yyyy-MM");
  const monthLabels: string[] = [];
  for (let i = MONTHS_BACK - 1; i >= 0; i--) monthLabels.push(now.minus({ months: i }).toFormat("yyyy-MM"));
  const win = now.minus({ days: BEHAVIOR_DAYS });

  const secByEmpMonth = new Map<string, number>();
  const beh = new Map<number, WorkerInsight["behavior"]>();
  const cinByEmpDate = new Map<string, DateTime[]>();
  for (const e of emps) beh.set(e.id, { shifts: 0, late: 0, tooEarly: 0, overtime: 0, forgotOut: 0, missed: 0 });

  for (const en of entries) {
    const cin = Times.parse(en.clockIn);
    const month = cin.toFormat("yyyy-MM");
    const cout = en.clockOut ? Times.parse(en.clockOut) : now;
    secByEmpMonth.set(`${en.employeeId}:${month}`, (secByEmpMonth.get(`${en.employeeId}:${month}`) ?? 0) + Math.max(0, cout.diff(cin, "seconds").seconds));

    const dateKey = `${en.employeeId}:${cin.toFormat("yyyy-MM-dd")}`;
    if (!cinByEmpDate.has(dateKey)) cinByEmpDate.set(dateKey, []);
    cinByEmpDate.get(dateKey)!.push(en.actualIn ? Times.parse(en.actualIn) : cin);

    if (cin.toMillis() < win.toMillis()) continue;
    const b = beh.get(en.employeeId);
    if (!b) continue;
    b.shifts++;

    // Late / early only judged from a real tap-in inside a real shift window.
    if (en.actualIn) {
      const ai = Times.parse(en.actualIn);
      const w = containingShift(schedByEmpWd.get(`${en.employeeId}:${weekday(ai)}`) ?? [], ai);
      if (w) {
        if (ai.toMillis() > w[0].plus({ minutes: LATE_MIN }).toMillis()) b.late++;
        if (ai.toMillis() < w[0].minus({ minutes: EARLY_MIN }).toMillis()) b.tooEarly++;
        if (en.actualOut && Times.parse(en.actualOut).toMillis() > w[1].plus({ minutes: OT_MIN }).toMillis()) b.overtime++;
      }
      // Tapped in but never tapped out = genuinely forgot to clock out.
      if (!en.actualOut) b.forgotOut++;
    }
  }

  // Missed = a scheduled, already-past DAY with no clock-in at all.
  let d = win.startOf("day");
  const today = now.startOf("day");
  while (d.toMillis() < today.toMillis()) {
    const wd = weekday(d);
    for (const e of emps) {
      const shifts = schedByEmpWd.get(`${e.id}:${wd}`) ?? [];
      if (shifts.length === 0) continue;
      // only if every shift that day is already over
      const allOver = shifts.every((s) => Scheduling.shiftEnd(d, s.startTime, s.endTime).toMillis() <= now.toMillis());
      if (!allOver) continue;
      const cins = cinByEmpDate.get(`${e.id}:${d.toFormat("yyyy-MM-dd")}`) ?? [];
      if (cins.length === 0) beh.get(e.id)!.missed++;
    }
    d = d.plus({ days: 1 });
  }

  const workers: WorkerInsight[] = emps.map((e) => {
    const monthPay = (m: string) => {
      const hours = Money.hours(secByEmpMonth.get(`${e.id}:${m}`) ?? 0);
      return { hours, pay: Money.pay(hours, e.rate) };
    };
    const run = running.get(e.id);
    return {
      id: e.id, name: e.name, rate: e.rate, active: e.active,
      thisMonth: monthPay(thisMonth),
      lastMonth: monthPay(lastMonth),
      allTime: { hours: run?.hours ?? 0, pay: run?.pay ?? 0, paid: run?.paid ?? 0, owed: run?.owedDue ?? 0 },
      months: monthLabels.map((m) => ({ month: m, ...monthPay(m) })),
      behavior: beh.get(e.id)!,
    };
  });

  const monthlyCost = monthLabels.map((m) => ({
    month: m,
    cost: Money.round2(workers.reduce((a, w) => a + (w.months.find((x) => x.month === m)?.pay ?? 0), 0)),
    hours: Money.round2(workers.reduce((a, w) => a + (w.months.find((x) => x.month === m)?.hours ?? 0), 0)),
  }));

  const sum = (f: (w: WorkerInsight) => number) => Money.round2(workers.reduce((a, w) => a + f(w), 0));
  return {
    thisMonth, lastMonth, months: monthLabels, behaviorDays: BEHAVIOR_DAYS,
    workers, monthlyCost,
    totals: {
      thisMonthPay: sum((w) => w.thisMonth.pay),
      thisMonthHours: Money.round2(workers.reduce((a, w) => a + w.thisMonth.hours, 0)),
      lastMonthPay: sum((w) => w.lastMonth.pay),
      allTimePay: sum((w) => w.allTime.pay),
      owed: sum((w) => w.allTime.owed),
    },
  };
}
