import { NextRequest } from "next/server";
import { json, isAdminRequest, unauthorized, num } from "@/lib/http";
import * as store from "@/lib/store";

// POST /api/meds/delete?id=
export async function POST(req: NextRequest) {
  if (!(await isAdminRequest())) return unauthorized();
  const id = num(req, "id");
  if (id != null) await store.deleteMed(id);
  return json({ ok: id != null });
}
