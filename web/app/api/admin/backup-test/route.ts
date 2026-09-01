import { json, isAdminRequest, unauthorized } from "@/lib/http";
import { sendDailySummary } from "@/lib/summary-email";

// POST /api/admin/backup-test — send the summary email now (admin "test send").
export async function POST() {
  if (!(await isAdminRequest())) return unauthorized();
  try {
    return json({ ok: true, message: await sendDailySummary() });
  } catch (e) {
    return json({ ok: false, message: e instanceof Error ? e.message : "Send failed." });
  }
}
