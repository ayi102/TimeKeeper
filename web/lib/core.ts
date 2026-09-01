import { DateTime } from "luxon";
import Decimal from "decimal.js";

/**
 * Pure business logic ported from the Android app's core/Scheduling.kt (itself a
 * port of the Pi's Python). Kept behaviorally identical so migrated data and
 * computed totals match the tablet exactly.
 *
 * Times are seconds-precision local wall-clock ISO strings ("yyyy-MM-ddTHH:mm:ss"),
 * never UTC/epoch. Because serverless runs in UTC, every "now" and every parse is
 * pinned to the business timezone (BUSINESS_TZ) so wall-clock math (schedules,
 * grace windows, overnight shifts) behaves like it did on the tablet.
 *
 * Weekday convention: 0 = Monday .. 6 = Sunday (Python's weekday()).
 */

export const BUSINESS_TZ = process.env.TIMEKEEPER_TZ || "America/New_York";

const STORE_FMT = "yyyy-MM-dd'T'HH:mm:ss";
const LABEL_FMT = "h:mm a";

// Luxon DateTime can't use JS relational operators under TS; compare via millis.
const before = (a: DateTime, b: DateTime) => a.toMillis() < b.toMillis();
const after = (a: DateTime, b: DateTime) => a.toMillis() > b.toMillis();
const notBefore = (a: DateTime, b: DateTime) => a.toMillis() >= b.toMillis();

export interface Shift {
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
}

export type ClockInResult =
  | { ok: true; start: DateTime; end: DateTime }
  | { ok: false; message: string };

/** Stored timestamps: Python-compatible local ISO strings, pinned to BUSINESS_TZ. */
export const Times = {
  parse(s: string): DateTime {
    return DateTime.fromFormat(s, STORE_FMT, { zone: BUSINESS_TZ });
  },
  format(dt: DateTime): string {
    return dt.setZone(BUSINESS_TZ).toFormat(STORE_FMT);
  },
  now(): DateTime {
    return DateTime.now().setZone(BUSINESS_TZ).set({ millisecond: 0 });
  },
};

/** Python-style weekday for a DateTime: Monday=0 .. Sunday=6. */
export function weekday(dt: DateTime): number {
  return dt.weekday - 1; // Luxon: Monday=1 .. Sunday=7
}

export const Scheduling = {
  /** A date + "HH:MM" combined into a DateTime in the business zone. */
  combine(date: DateTime, hhmm: string): DateTime {
    const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
    return date.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  },

  /** End instant of a shift; an end <= start means it runs overnight (next day). */
  shiftEnd(date: DateTime, start: string, end: string): DateTime {
    const e = Scheduling.combine(date, end);
    return end <= start ? e.plus({ days: 1 }) : e;
  },

  shiftsOverlap(a: Shift, b: Shift): boolean {
    const d = DateTime.fromObject({ year: 2000, month: 1, day: 1 }, { zone: BUSINESS_TZ });
    const a1 = Scheduling.combine(d, a.startTime);
    const a2 = Scheduling.shiftEnd(d, a.startTime, a.endTime);
    const b1 = Scheduling.combine(d, b.startTime);
    const b2 = Scheduling.shiftEnd(d, b.startTime, b.endTime);
    return before(a1, b2) && before(b1, a2);
  },

  /**
   * Decide whether a clock-in is allowed right now, and at what shift window.
   * Mirrors Scheduling.resolveClockIn: within-grace early is allowed (recorded at
   * the scheduled start); too-early or after-end is blocked; no shift today blocks.
   */
  resolveClockIn(
    name: string,
    todays: Shift[],
    tomorrows: Shift[],
    now: DateTime,
    graceMin: number
  ): ClockInResult {
    const grace = { minutes: graceMin };
    const today = now.startOf("day");
    const todayWin = todays
      .map((s) => [Scheduling.combine(today, s.startTime), Scheduling.shiftEnd(today, s.startTime, s.endTime)] as [DateTime, DateTime])
      .sort((x, y) => x[0].toMillis() - y[0].toMillis());

    for (const [s, e] of todayWin) {
      if (notBefore(now, s.minus(grace)) && before(now, e)) return { ok: true, start: s, end: e };
    }

    const tomorrow = today.plus({ days: 1 });
    const tomorrowWins = tomorrows
      .map((s) => [Scheduling.combine(tomorrow, s.startTime), Scheduling.shiftEnd(tomorrow, s.startTime, s.endTime)] as [DateTime, DateTime])
      .sort((x, y) => x[0].toMillis() - y[0].toMillis());
    const nextTomorrow = tomorrowWins[0];
    if (nextTomorrow) {
      const [s, e] = nextTomorrow;
      if (notBefore(now, s.minus(grace)) && before(now, s)) return { ok: true, start: s, end: e };
    }

    if (todays.length === 0) return { ok: false, message: `${name} is not scheduled to work today.` };

    const upcoming = todayWin.map((w) => w[0]).filter((s) => before(now, s.minus(grace)));
    if (upcoming.length > 0) {
      const soonest = upcoming.reduce((m, s) => (before(s, m) ? s : m));
      return { ok: false, message: `Too early — next shift starts at ${soonest.toFormat(LABEL_FMT)}.` };
    }

    const lastEnd = todayWin.reduce((m, w) => (after(w[1], m) ? w[1] : m), todayWin[0][1]);
    return { ok: false, message: `Shift already ended at ${lastEnd.toFormat(LABEL_FMT)}.` };
  },

  /** The shift window that a recorded clock-in belongs to (for capping clock-out). */
  shiftOf(shifts: Shift[], cin: DateTime, graceMin: number): [DateTime, DateTime] | null {
    const grace = { minutes: graceMin };
    const date = cin.startOf("day");
    const wins = shifts.map(
      (s) => [Scheduling.combine(date, s.startTime), Scheduling.shiftEnd(date, s.startTime, s.endTime)] as [DateTime, DateTime]
    );
    for (const w of wins) {
      if (notBefore(cin, w[0].minus(grace)) && before(cin, w[1])) return w;
    }
    if (wins.length === 0) return null;
    return wins.reduce((best, w) =>
      Math.abs(w[0].toMillis() - cin.toMillis()) < Math.abs(best[0].toMillis() - cin.toMillis()) ? w : best
    );
  },

  /** Recorded clock-in: at "now" if the shift already started, else at the start. */
  clockInTime(now: DateTime, start: DateTime): DateTime {
    return after(now, start) ? now : start;
  },

  /** Recorded clock-out: capped at the scheduled end, never before the clock-in. */
  clockOutTime(now: DateTime, shiftEnd: DateTime | null, cin: DateTime): DateTime {
    let out = now;
    if (shiftEnd && after(now, shiftEnd)) out = shiftEnd;
    if (before(out, cin)) out = cin;
    return out;
  },

  fmtTime(dt: DateTime): string {
    return dt.toFormat(LABEL_FMT);
  },
};

export const Money = {
  // Banker's rounding (HALF_EVEN) to match the Kotlin BigDecimal / Python round(),
  // so historical cents agree with the tablet.
  round2(x: number): number {
    return new Decimal(x).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN).toNumber();
  },
  hours(seconds: number): number {
    return Money.round2(seconds / 3600);
  },
  pay(hours: number, rate: number): number {
    return Money.round2(hours * rate);
  },
  /** Whole-dollar "owed due" shown to the admin (ceil of a positive balance). */
  owedDue(owed: number): number {
    return owed > 0 ? Math.ceil(owed) : 0;
  },
  /** Split a payout into pay vs tip: overpayment beyond what's owed becomes tip. */
  splitPayout(amount: number, tip: number, owedExact: number): [number, number] {
    const owed = Math.max(0, Money.round2(owedExact));
    const over = Money.round2(amount - owed);
    return over > 0
      ? [Money.round2(owed), Money.round2(tip + over)]
      : [Money.round2(amount), Money.round2(tip)];
  },
};
