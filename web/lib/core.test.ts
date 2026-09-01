import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { Times, Scheduling, Money, weekday, BUSINESS_TZ, Shift } from "./core";

// Helper: build a business-zone DateTime from a stored-format string.
const at = (s: string) => DateTime.fromFormat(s, "yyyy-MM-dd'T'HH:mm:ss", { zone: BUSINESS_TZ });

const DAY = "07:00";
const dayShift: Shift = { startTime: "07:00", endTime: "18:00" };
const nightShift: Shift = { startTime: "18:00", endTime: "00:00" }; // overnight

describe("Money.round2 (banker's rounding)", () => {
  it("rounds half to even at 2 decimals", () => {
    expect(Money.round2(1.005)).toBe(1.0); // 0 is even -> down
    expect(Money.round2(1.015)).toBe(1.02); // 1 is odd -> up
    expect(Money.round2(1.025)).toBe(1.02); // 2 is even -> down
    expect(Money.round2(1.035)).toBe(1.04); // 3 is odd -> up
  });
  it("leaves already-2dp values alone", () => {
    expect(Money.round2(27)).toBe(27);
    expect(Money.round2(18.5)).toBe(18.5);
  });
});

describe("Money helpers", () => {
  it("hours = round2(seconds/3600)", () => {
    expect(Money.hours(3600)).toBe(1);
    expect(Money.hours(1800)).toBe(0.5);
    expect(Money.hours(5400)).toBe(1.5);
  });
  it("pay = round2(hours * rate)", () => {
    expect(Money.pay(1.5, 18)).toBe(27);
    expect(Money.pay(2, 20)).toBe(40);
  });
  it("owedDue ceils a positive balance, else 0", () => {
    expect(Money.owedDue(0)).toBe(0);
    expect(Money.owedDue(0.01)).toBe(1);
    expect(Money.owedDue(5)).toBe(5);
    expect(Money.owedDue(5.4)).toBe(6);
    expect(Money.owedDue(-3)).toBe(0);
  });
  it("splitPayout routes overpayment into tips", () => {
    expect(Money.splitPayout(100, 0, 80)).toEqual([80, 20]);
    expect(Money.splitPayout(50, 5, 80)).toEqual([50, 5]);
    expect(Money.splitPayout(80, 10, 80)).toEqual([80, 10]);
  });
});

describe("Times round-trip", () => {
  it("formats and parses the stored format", () => {
    const s = "2025-01-06T07:30:00";
    expect(Times.format(at(s))).toBe(s);
  });
});

describe("weekday convention (0=Mon..6=Sun)", () => {
  it("maps Luxon weekday correctly", () => {
    expect(weekday(at("2025-01-06T00:00:00"))).toBe(0); // Monday
    expect(weekday(at("2025-01-12T00:00:00"))).toBe(6); // Sunday
  });
});

describe("Scheduling.shiftEnd (overnight)", () => {
  it("keeps same day when end > start", () => {
    const d = at("2025-01-06T00:00:00");
    expect(Times.format(Scheduling.shiftEnd(d, "07:00", "18:00"))).toBe("2025-01-06T18:00:00");
  });
  it("rolls to next day when end <= start", () => {
    const d = at("2025-01-06T00:00:00");
    expect(Times.format(Scheduling.shiftEnd(d, "18:00", "00:00"))).toBe("2025-01-07T00:00:00");
  });
});

describe("Scheduling.shiftsOverlap", () => {
  it("detects overlap and non-overlap", () => {
    expect(Scheduling.shiftsOverlap({ startTime: "07:00", endTime: "12:00" }, { startTime: "11:00", endTime: "15:00" })).toBe(true);
    expect(Scheduling.shiftsOverlap({ startTime: "07:00", endTime: "12:00" }, { startTime: "12:00", endTime: "15:00" })).toBe(false);
  });
});

describe("Scheduling.resolveClockIn", () => {
  const grace = 15;
  it("allows within-grace early, recorded at scheduled start", () => {
    const now = at("2025-01-06T06:50:00");
    const r = Scheduling.resolveClockIn("Kay", [dayShift], [], now, grace);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Times.format(r.start)).toBe("2025-01-06T07:00:00");
      expect(Times.format(Scheduling.clockInTime(now, r.start))).toBe("2025-01-06T07:00:00");
    }
  });
  it("records at 'now' once the shift has started", () => {
    const now = at("2025-01-06T07:30:00");
    const r = Scheduling.resolveClockIn("Kay", [dayShift], [], now, grace);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Times.format(Scheduling.clockInTime(now, r.start))).toBe("2025-01-06T07:30:00");
  });
  it("blocks too-early", () => {
    const r = Scheduling.resolveClockIn("Kay", [dayShift], [], at("2025-01-06T06:40:00"), grace);
    expect(r).toEqual({ ok: false, message: "Too early — next shift starts at 7:00 AM." });
  });
  it("blocks after the shift ended", () => {
    const r = Scheduling.resolveClockIn("Kay", [dayShift], [], at("2025-01-06T18:30:00"), grace);
    expect(r).toEqual({ ok: false, message: "Shift already ended at 6:00 PM." });
  });
  it("blocks when not scheduled today", () => {
    const r = Scheduling.resolveClockIn("Kay", [], [], at("2025-01-06T09:00:00"), grace);
    expect(r).toEqual({ ok: false, message: "Kay is not scheduled to work today." });
  });
  it("allows an early clock-in for tomorrow's first shift near midnight", () => {
    const now = at("2025-01-06T23:50:00");
    const r = Scheduling.resolveClockIn("Lou", [], [{ startTime: "00:00", endTime: "07:00" }], now, grace);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Times.format(r.start)).toBe("2025-01-07T00:00:00");
  });
});

describe("Scheduling.clockOutTime", () => {
  it("caps at the scheduled end", () => {
    const cin = at("2025-01-06T07:00:00");
    const end = at("2025-01-06T18:00:00");
    expect(Times.format(Scheduling.clockOutTime(at("2025-01-06T19:00:00"), end, cin))).toBe("2025-01-06T18:00:00");
  });
  it("uses now when before the end", () => {
    const cin = at("2025-01-06T07:00:00");
    const end = at("2025-01-06T18:00:00");
    expect(Times.format(Scheduling.clockOutTime(at("2025-01-06T17:00:00"), end, cin))).toBe("2025-01-06T17:00:00");
  });
  it("never precedes the clock-in", () => {
    const cin = at("2025-01-06T07:00:00");
    expect(Times.format(Scheduling.clockOutTime(at("2025-01-06T06:00:00"), null, cin))).toBe("2025-01-06T07:00:00");
  });
});

describe("Scheduling.shiftOf (overnight matching)", () => {
  it("matches an overnight shift for a late clock-in", () => {
    const cin = at("2025-01-06T18:05:00");
    const w = Scheduling.shiftOf([nightShift], cin, 15);
    expect(w).not.toBeNull();
    if (w) expect(Times.format(w[1])).toBe("2025-01-07T00:00:00");
  });
});
