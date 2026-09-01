import { json, isAdminRequest, unauthorized } from "@/lib/http";
import * as store from "@/lib/store";

// GET /api/schedule/all — every worker with their shifts, for the visual scheduler.
export async function GET() {
  if (!(await isAdminRequest())) return unauthorized();
  const emps = await store.employeesAdmin();
  const scheds = await store.allSchedules();
  const byEmp = new Map<number, { weekday: number; start: string; end: string }[]>();
  for (const s of scheds) {
    if (!byEmp.has(s.employeeId)) byEmp.set(s.employeeId, []);
    byEmp.get(s.employeeId)!.push({ weekday: s.weekday, start: s.start, end: s.end });
  }
  return json(emps.map((e) => ({ id: e.id, name: e.name, active: e.active, shifts: byEmp.get(e.id) ?? [] })));
}
