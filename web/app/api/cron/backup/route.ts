import { NextRequest } from "next/server";
import { json, cronAuthorized, unauthorized } from "@/lib/http";
import { sendBackup } from "@/lib/backup";

// Cron: email a full database backup. Runs once daily.
export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) return unauthorized();
  try {
    return json({ ok: true, message: await sendBackup() });
  } catch (e) {
    return json({ ok: false, message: e instanceof Error ? e.message : "Backup failed." });
  }
}
