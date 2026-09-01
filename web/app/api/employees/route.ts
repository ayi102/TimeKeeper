import { NextRequest } from "next/server";
import { json, ok, errJson, isAdminRequest, unauthorized, q, num } from "@/lib/http";
import * as store from "@/lib/store";

// GET /api/employees — the admin management list.
export async function GET() {
  if (!(await isAdminRequest())) return unauthorized();
  const list = await store.employeesAdmin();
  return json(list.map((e) => ({ id: e.id, name: e.name, rate: e.rate, active: e.active })));
}

// POST /api/employees?name=&rate=&id= — create or update a worker.
export async function POST(req: NextRequest) {
  if (!(await isAdminRequest())) return unauthorized();
  const name = q(req, "name") ?? "";
  const rate = Math.max(0, num(req, "rate") ?? 0);
  const id = num(req, "id");
  if (!name) return errJson("Name is required.");
  if (id != null) await store.updateEmployee(id, name, rate);
  else await store.addEmployee(name, rate);
  return ok();
}
