import { NextRequest } from "next/server";
import { json, isAdminRequest, unauthorized, q, num } from "@/lib/http";
import * as store from "@/lib/store";

// POST /api/employees/active?id=&active=1|0
export async function POST(req: NextRequest) {
  if (!(await isAdminRequest())) return unauthorized();
  const id = num(req, "id");
  if (id != null) await store.setEmployeeActive(id, q(req, "active") === "1");
  return json({ ok: id != null });
}
