import { NextRequest } from "next/server";
import { json, num, badRequest } from "@/lib/http";
import { toggle } from "@/lib/clock";

// POST /api/clock?id= — clock the worker in or out (kiosk).
export async function POST(req: NextRequest) {
  const id = num(req, "id");
  if (id == null) return badRequest("missing id");
  return json(await toggle(id));
}
