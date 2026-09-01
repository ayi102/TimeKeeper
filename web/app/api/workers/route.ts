import { json } from "@/lib/http";
import * as store from "@/lib/store";

// GET /api/workers — active workers with whether they're clocked in (kiosk).
export async function GET() {
  const list = await store.employees();
  return json(list.map((e) => ({ id: e.id, name: e.name, in: e.clockedIn })));
}
