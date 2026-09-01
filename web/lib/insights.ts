import { DateTime } from "luxon";
import { Times, Scheduling, Money, weekday, Shift } from "./core";
import * as store from "./store";

/**
 * Pay + behavior analytics. Pay comes from the paid clock_in/clock_out (same as
 * everywhere else). Behavior (late / early / overtime / forgot / missed) compares
 * the RAW taps (actual_in/actual_out) against each entry's scheduled shift.
 * Behavior is measured over the last BEHAVIOR_DAYS; pay is monthly + all-time.
 */

const GRACE = Number(process.env.TIMEKEEPER_EARLY_GRACE_MIN ?? 15);
const LATE_MIN = 5;   // arrived > 5 min after start → late
const EARLY_MIN = 3;  // tapped in > 3 min before start → early
const OT_MIN = 5;     // tapped out > 5 min after end → overtime
const BEHAVIOR_DAYS = 90;

export interface MonthPay { month: string; hours: number; pay: number; }
export interface WorkerInsight {
  id: number; name: string; rate: number; active: boolean;
  thisMonth: { hours: number; pay: number };
  lastMonth: { hours: number; pay: number };
  allTime: { hours: number; pay: number; paid: number; owed: number };
  months: MonthPay[];
  behavior: { shifts: number; late: number; tooEarly: number; overtime: number; forgotOut: number; missed: number };
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
  for (let i = 5; i >= 0; i--) monthLabels.push(now.minus({ months: i }).toFormat("yyyy-MM"));
  const win = now.minus({ days: BEHAVIOR_DAYS });

  const secByEmpMonth = new Map<string, number>();
  const beh = new Map<number, { shifts: number; late: number; tooEarly: number; overtime: number; forgotOut: number }>();
  const cinByEmpDate = new Map<string, DateTime[]>();
  for (const e of emps) beh.set(e.id, { shifts: 0, late: 0, tooEarly: 0, overtime: 0, forgotOut: 0 });

  for (const en of entries) {
    const cin = Times.parse(en.clockIn);
    const month = cin.toFormat("yyyy-MM");
    const cout = en.clockOut ? Times.parse(en.clockOut) : now;
    const secs = Math.max(0, cout.diff(cin, "seconds").seconds);
    secByEmpMonth.set(`${en.employeeId}:${month}`, (secByEmpMonth.get(`${en.employeeId}:${month}`) ?? 0) + secs);

    const key = `${en.employeeId}:${cin.toFormat("yyyy-MM-dd")}`;
    if (!cinByEmpDate.has(key)) cinByEmpDate.set(key, []);
    cinByEmpDate.get(key)!.push(en.actualIn ? Times.parse(en.actualIn) : cin);

    if (cin.toMillis() >= win.toMillis()) {
      const b = beh.get(en.employeeId);
      if (!b) continue;
      const actualIn = en.actualIn ? Times.parse(en.actualIn) : cin;
      const w = Scheduling.shiftOf(schedByEmpWd.get(`${en.employeeId}:${weekday(actualIn)}`) ?? [], actualIn, GRACE);
      b.shifts++;
      if (w) {
        const [start, end] = w;
        if (actualIn.toMillis() > start.plus({ minutes: LATE_MIN }).toMillis()) b.late++;
        if (actualIn.toMillis() < start.minus({ minutes: EARLY_MIN }).toMillis()) b.tooEarly++;
        if (en.actualOut && Times.parse(en.actualOut).toMillis() > end.plus({ minutes: OT_MIN }).toMillis()) b.overtime++;
      }
      if (!en.actualOut) b.forgotOut++;
    }
  }

  // Missed shifts (forgot to clock in): scheduled, already-ended shifts in the
  // window with no clock-in in their window.
  const missed = new Map<number, number>();
  for (const e of emps) missed.set(e.id, 0);
  let d = win.startOf("day");
  const today = now.startOf("day");
  while (d.toMillis() < today.toMillis()) {
    const wd = weekday(d);
    for (const e of emps) {
      for (const sh of schedByEmpWd.get(`${e.id}:${wd}`) ?? []) {
        const start = Scheduling.combine(d, sh.startTime);
        const end = Scheduling.shiftEnd(d, sh.startTime, sh.endTime);
        if (end.toMillis() > now.toMillis()) continue; // not over yet
        const cins = cinByEmpDate.get(`${e.id}:${d.toFormat("yyyy-MM-dd")}`) ?? [];
        const graceStart = start.minus({ minutes: GRACE });
        const clockedIn = cins.some((c) => c.toMillis() >= graceStart.toMillis() && c.toMillis() < end.toMillis());
        if (!clockedIn) missed.set(e.id, (missed.get(e.id) ?? 0) + 1);
      }
    }
    d = d.plus({ days: 1 });
  }

  const workers: WorkerInsight[] = emps.map((e) => {
    const monthPay = (m: string) => {
      const hours = Money.hours(secByEmpMonth.get(`${e.id}:${m}`) ?? 0);
      return { hours, pay: Money.pay(hours, e.rate) };
    };
    const run = running.get(e.id);
    const b = beh.get(e.id)!;
    return {
      id: e.id, name: e.name, rate: e.rate, active: e.active,
      thisMonth: monthPay(thisMonth),
      lastMonth: monthPay(lastMonth),
      allTime: { hours: run?.hours ?? 0, pay: run?.pay ?? 0, paid: run?.paid ?? 0, owed: run?.owedDue ?? 0 },
      months: monthLabels.map((m) => ({ month: m, ...monthPay(m) })),
      behavior: { ...b, missed: missed.get(e.id) ?? 0 },
    };
  });

  const sum = (f: (w: WorkerInsight) => number) => Money.round2(workers.reduce((a, w) => a + f(w), 0));
  return {
    thisMonth, lastMonth, months: monthLabels, behaviorDays: BEHAVIOR_DAYS,
    workers,
    totals: {
      thisMonthPay: sum((w) => w.thisMonth.pay),
      thisMonthHours: Money.round2(workers.reduce((a, w) => a + w.thisMonth.hours, 0)),
      lastMonthPay: sum((w) => w.lastMonth.pay),
      allTimePay: sum((w) => w.allTime.pay),
      owed: sum((w) => w.allTime.owed),
    },
  };
}
