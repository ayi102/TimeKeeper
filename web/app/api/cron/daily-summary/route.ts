import { NextRequest } from "next/server";
import { json, cronAuthorized, unauthorized } from "@/lib/http";
import { sendDailySummary } from "@/lib/summary-email";

// Cron: email the daily summary. Run once each morning.
export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) return unauthorized();
  try {
    const message = await sendDailySummary();
    return json({ ok: true, message });
  } catch (e) {
    return json({ ok: false, message: e instanceof Error ? e.message : "Send failed." });
  }
}
