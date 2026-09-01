import { DateTime } from "luxon";
import { Times, Scheduling } from "./core";
import * as store from "./store";
import { mailConfigured, sendMail } from "./mailer";

/**
 * Emails an alert when a scheduled worker hasn't clocked in — port of
 * MissedClockin.kt. For each active worker's shift today: once MISSED_MIN past
 * the start has passed, still within the shift, no tap landed in the shift's
 * window, and not already alerted — send one email and record it (deduped).
 */
const GRACE_MIN = 15;
const MISSED_MIN = 30;

export async function checkMissedClockins(now: DateTime = Times.now()): Promise<number> {
  if (!(await mailConfigured())) return 0;
  const today = now.startOf("day");
  const wd = now.weekday - 1;

  interface Missed { id: number; name: string; start: DateTime; key: string; }
  const missed: Missed[] = [];

  for (const w of await store.activeWorkers()) {
    const cins = await store.clockInsOn(w.id, today.toFormat("yyyy-MM-dd"));
    for (const sh of await store.schedulesFor(w.id, wd)) {
      const start = Scheduling.combine(today, sh.startTime);
      const end = Scheduling.shiftEnd(today, sh.startTime, sh.endTime);
      // only within the shift, once the grace past its start has passed
      if (now.toMillis() < start.plus({ minutes: MISSED_MIN }).toMillis() || now.toMillis() >= end.toMillis()) continue;
      // clocked in for THIS shift? (a tap in its window)
      const graceStart = start.minus({ minutes: GRACE_MIN });
      if (cins.some((c) => c.toMillis() >= graceStart.toMillis() && c.toMillis() < end.toMillis())) continue;
      const key = Times.format(start);
      if (await store.alertExists(w.id, key)) continue;
      missed.push({ id: w.id, name: w.name, start, key });
    }
  }

  if (!missed.length) return 0;

  const who = missed.map((m) => m.name).join(", ");
  const body =
    "TimeKeeper — missed clock-in\n\n" +
    missed
      .map((m) => `  ${m.name} was scheduled to start at ${Scheduling.fmtTime(m.start)} and has not clocked in (as of ${Scheduling.fmtTime(now)}).`)
      .join("\n") + "\n";
  await sendMail(`TimeKeeper: ${who} missed clock-in`, body);

  // Record only after a successful send, so a failed email retries next run.
  for (const m of missed) await store.recordAlert(m.id, m.key, Times.format(now));
  return missed.length;
}
