import { NextRequest } from "next/server";
import { json, ok, errJson, isAdminRequest, unauthorized, q, num } from "@/lib/http";
import * as store from "@/lib/store";

// Parse the schedule slots JSON ([{weekday,time}]) sent by the meds page.
function parseSlots(raw: string): store.MedSlotRow[] {
  const out: store.MedSlotRow[] = [];
  try {
    const arr = JSON.parse(raw) as { weekday: number; time: string }[];
    for (const o of arr) {
      const wd = Number(o.weekday);
      const t = String(o.time ?? "");
      if (t && wd >= 0 && wd <= 6) out.push({ weekday: wd, time: t });
    }
  } catch {
    /* malformed → no slots */
  }
  return out;
}

// GET /api/meds — all reminders with their schedule slots.
export async function GET() {
  if (!(await isAdminRequest())) return unauthorized();
  const list = await store.meds();
  return json(list.map((m) => ({ id: m.id, name: m.name, notes: m.notes, active: m.active, slots: m.slots })));
}

// POST /api/meds?name=&notes=&slots=<json>&id= — create or update a reminder.
export async function POST(req: NextRequest) {
  if (!(await isAdminRequest())) return unauthorized();
  const id = num(req, "id");
  const name = q(req, "name") ?? "";
  const notes = q(req, "notes") ?? "";
  const slots = parseSlots(q(req, "slots") ?? "[]");
  if (!name) return errJson("A reminder name is required.");
  if (slots.length === 0) return errJson("Add at least one day and time.");
  await store.saveMed(id, name, notes, slots);
  return ok();
}
