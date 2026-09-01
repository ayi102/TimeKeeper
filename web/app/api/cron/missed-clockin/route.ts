import { NextRequest } from "next/server";
import { json, cronAuthorized, unauthorized } from "@/lib/http";
import { checkMissedClockins } from "@/lib/missed-clockin";

// Cron: alert on scheduled workers who haven't clocked in. Run ~every 15 min.
export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) return unauthorized();
  const alerted = await checkMissedClockins();
  return json({ ok: true, alerted });
}
