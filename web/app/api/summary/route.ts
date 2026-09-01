import { json, isAdminRequest, unauthorized } from "@/lib/http";
import * as store from "@/lib/store";
import { Times } from "@/lib/core";

// GET /api/summary — per-worker rollup for the admin summary.
export async function GET() {
  if (!(await isAdminRequest())) return unauthorized();
  const rows = await store.summarize(Times.now());
  return json(
    rows.map((s) => ({ id: s.id, name: s.name, hours: s.hours, pay: s.pay, paid: s.paid, owed: s.owedDue, tips: s.tips }))
  );
}
