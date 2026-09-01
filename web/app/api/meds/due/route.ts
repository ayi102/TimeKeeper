import { json } from "@/lib/http";
import * as store from "@/lib/store";
import { Times } from "@/lib/core";

// GET /api/meds/due — meds whose scheduled time just arrived (kiosk reminder).
export async function GET() {
  const due = await store.medsDue(Times.now());
  return json(due.map((m) => ({ name: m.name, dose: m.dose })));
}
