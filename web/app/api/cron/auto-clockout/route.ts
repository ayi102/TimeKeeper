import { NextRequest } from "next/server";
import { json, cronAuthorized, unauthorized } from "@/lib/http";
import { autoCloseOverdue } from "@/lib/clock";

// Cron: close forgotten open entries past their overtime window. Run ~every 15 min.
export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) return unauthorized();
  const closed = await autoCloseOverdue();
  return json({ ok: true, closed });
}
