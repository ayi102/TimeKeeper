import { json, isAdminRequest, unauthorized } from "@/lib/http";
import { sendBackup } from "@/lib/backup";

// POST /api/admin/backup-test — email a database backup now (admin "test send").
export async function POST() {
  if (!(await isAdminRequest())) return unauthorized();
  try {
    return json({ ok: true, message: await sendBackup() });
  } catch (e) {
    return json({ ok: false, message: e instanceof Error ? e.message : "Backup failed." });
  }
}
