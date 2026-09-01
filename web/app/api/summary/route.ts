import { json, isAdminRequest, unauthorized } from "@/lib/http";
import * as store from "@/lib/store";
import { Times } from "@/lib/core";
import { autoCloseOverdue } from "@/lib/clock";

// GET /api/summary — per-worker rollup for the admin summary.
export async function GET() {
  if (!(await isAdminRequest())) return unauthorized();
  // Safety net: cap any forgotten open entries even if the cron didn't run
  // (e.g. on a hosting plan without frequent cron).
  await autoCloseOverdue();
  const rows = await store.summarize(Times.now());
  return json(
    rows.map((s) => ({ id: s.id, name: s.name, hours: s.hours, pay: s.pay, paid: s.paid, owed: s.owedDue, tips: s.tips }))
  );
}
