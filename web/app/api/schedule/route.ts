import { NextRequest } from "next/server";
import { json, isAdminRequest, unauthorized, q, num } from "@/lib/http";
import * as store from "@/lib/store";
import { Scheduling } from "@/lib/core";

// GET /api/schedule?emp= — a worker's shifts for the editor.
export async function GET(req: NextRequest) {
  if (!(await isAdminRequest())) return unauthorized();
  const emp = num(req, "emp");
  if (emp == null) return json({ ok: false });
  const shifts = await store.schedulesOf(emp);
  const name = (await store.employeeName(emp)) ?? "";
  return json({ ok: true, name, shifts });
}

// POST /api/schedule?emp=&shifts=<json> — replace a worker's whole schedule.
export async function POST(req: NextRequest) {
  if (!(await isAdminRequest())) return unauthorized();
  const emp = num(req, "emp");
  if (emp == null) return json({ ok: false });
  try {
    const raw = JSON.parse(q(req, "shifts") ?? "[]") as { weekday: number; start: string; end: string }[];
    // Drop empty / zero-length shifts, then drop overlaps within each weekday.
    const byDay = new Map<number, { start: string; end: string }[]>();
    let skipped = 0;
    for (const o of raw) {
      const start = String(o.start ?? "");
      const end = String(o.end ?? "");
      if (!start || !end || start === end) { skipped++; continue; }
      if (!byDay.has(o.weekday)) byDay.set(o.weekday, []);
      byDay.get(o.weekday)!.push({ start, end });
    }
    const accepted: store.SchedRow[] = [];
    let overlaps = 0;
    for (const [wd, list] of byDay) {
      const okShifts: { startTime: string; endTime: string }[] = [];
      for (const { start, end } of list.sort((a, b) => a.start.localeCompare(b.start))) {
        const sh = { startTime: start, endTime: end };
        if (okShifts.some((o) => Scheduling.shiftsOverlap(sh, o))) { overlaps++; continue; }
        okShifts.push(sh);
        accepted.push({ weekday: wd, start, end });
      }
    }
    await store.replaceSchedules(emp, accepted);
    return json({ ok: true, skipped, overlaps });
  } catch {
    return json({ ok: false, message: "Bad schedule data." });
  }
}
