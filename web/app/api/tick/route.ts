import { json } from "@/lib/http";
import { autoCloseOverdue } from "@/lib/clock";
import { checkMissedClockins } from "@/lib/missed-clockin";

/**
 * Maintenance heartbeat, called periodically by the always-on kiosk (which is
 * logged in, so this is gated by the Supabase session via middleware — no cron
 * secret needed). Does what the tablet's WorkManager jobs used to do locally:
 * auto-close forgotten entries and send missed-clock-in alerts. This keeps the
 * every-15-min work free (no paid cron), since the wall tablet is always on.
 */
export async function POST() {
  const closed = await autoCloseOverdue();
  let alerted = 0;
  try {
    alerted = await checkMissedClockins();
  } catch {
    // mail not configured / send failed — ignore; retries next tick
  }
  return json({ ok: true, closed, alerted });
}
