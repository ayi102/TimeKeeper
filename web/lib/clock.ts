import { DateTime } from "luxon";
import { Times, Scheduling, weekday } from "./core";
import * as store from "./store";

/**
 * Clock in/out state machine — the port of Clock.kt. Same rules: schedule-enforced,
 * multi-shift, overnight-aware; clock-in recorded at the scheduled start, clock-out
 * capped at the scheduled end.
 */

const GRACE = Number(process.env.TIMEKEEPER_EARLY_GRACE_MIN ?? 15);
const OVERTIME = Number(process.env.TIMEKEEPER_OVERTIME_MIN ?? 60);

export interface ClockResult {
  ok: boolean;
  action?: "in" | "out";
  name: string;
  time?: string;
  message?: string;
}

export async function toggle(empId: number, now: DateTime = Times.now()): Promise<ClockResult> {
  const name = await store.employeeName(empId);
  if (!name) return { ok: false, name: "", message: "Unknown worker." };

  const open = await store.openEntry(empId);
  if (open) {
    // CLOCK OUT: cap at the matched shift's scheduled end.
    const cin = Times.parse(open.clockIn);
    const shift = Scheduling.shiftOf(await store.schedulesFor(empId, weekday(cin)), cin, GRACE);
    const out = Scheduling.clockOutTime(now, shift ? shift[1] : null, cin);
    await store.closeEntry(open.id, Times.format(out), Times.format(now));
    return { ok: true, action: "out", name, time: Scheduling.fmtTime(out) };
  }

  // CLOCK IN: pick the shift; record at the scheduled start.
  const todays = await store.schedulesFor(empId, weekday(now));
  const tomorrows = await store.schedulesFor(empId, weekday(now.plus({ days: 1 })));
  const r = Scheduling.resolveClockIn(name, todays, tomorrows, now, GRACE);
  if (!r.ok) return { ok: false, name, message: r.message };
  const cin = Scheduling.clockInTime(now, r.start);
  await store.insertClockIn(empId, Times.format(cin), Times.format(now));
  return { ok: true, action: "in", name, time: Scheduling.fmtTime(cin) };
}

/** Close any open entry whose scheduled end + overtime grace has passed. */
export async function autoCloseOverdue(now: DateTime = Times.now()): Promise<number> {
  let closed = 0;
  for (const e of await store.openEntries()) {
    const cin = Times.parse(e.clockIn);
    const shift = Scheduling.shiftOf(await store.schedulesFor(e.employeeId, weekday(cin)), cin, GRACE);
    if (!shift) continue;
    const end = shift[1];
    if (now.toMillis() >= end.plus({ minutes: OVERTIME }).toMillis()) {
      const out = end.toMillis() > cin.toMillis() ? end : cin;
      await store.autoClose(e.id, Times.format(out));
      closed++;
    }
  }
  return closed;
}
