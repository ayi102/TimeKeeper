import { NextRequest } from "next/server";
import { ok, errJson, isAdminRequest, unauthorized, q } from "@/lib/http";
import * as store from "@/lib/store";

// POST /api/admin/pin?current=&new= — change the admin PIN.
export async function POST(req: NextRequest) {
  if (!(await isAdminRequest())) return unauthorized();
  const current = q(req, "current");
  const next = q(req, "new") ?? "";
  if (current !== (await store.getAdminPin())) return errJson("Current PIN is incorrect.");
  if (next.length < 4 || !/^\d+$/.test(next)) return errJson("New PIN must be at least 4 digits.");
  await store.setSetting("admin_pin", next);
  return ok();
}
