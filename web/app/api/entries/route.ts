import { NextRequest } from "next/server";
import { json, ok, errJson, isAdminRequest, unauthorized, q, num } from "@/lib/http";
import * as store from "@/lib/store";
import { Times } from "@/lib/core";

// Normalise a datetime-local value ("yyyy-MM-ddTHH:mm") to stored form; validates.
function normTime(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.length === 16 ? `${raw}:00` : raw;
  if (!Times.parse(s).isValid) throw new Error("bad datetime");
  return s;
}

// GET /api/entries?emp= — a worker's timesheet.
export async function GET(req: NextRequest) {
  if (!(await isAdminRequest())) return unauthorized();
  const emp = num(req, "emp");
  if (emp == null) return json({ ok: false });
  const f = await store.financeFor(emp, Times.now()); // name regardless of active
  const rows = await store.entriesFor(emp, Times.now());
  return json({
    ok: true,
    name: f?.name ?? "",
    entries: rows.map((r) => ({ id: r.id, in: r.clockIn, out: r.clockOut, hours: r.hours, open: r.open })),
  });
}

// POST /api/entries?emp=&id=&in=&out= — add or edit a manual entry.
export async function POST(req: NextRequest) {
  if (!(await isAdminRequest())) return unauthorized();
  const emp = num(req, "emp");
  const id = num(req, "id");
  try {
    const cin = normTime(q(req, "in"));
    const cout = normTime(q(req, "out"));
    if (cin == null) return errJson("Clock-in time is required.");
    if (cout != null && Times.parse(cout).toMillis() <= Times.parse(cin).toMillis())
      return errJson("Clock-out must be after clock-in.");
    if (id != null) { await store.updateEntry(id, cin, cout); return ok(); }
    if (emp != null) { await store.addEntry(emp, cin, cout); return ok(); }
    return errJson("Missing worker.");
  } catch {
    return errJson("Invalid date/time.");
  }
}
