import { NextRequest } from "next/server";
import { json, isAdminRequest, unauthorized, num } from "@/lib/http";
import * as store from "@/lib/store";
import { Times } from "@/lib/core";

// GET /api/payments?emp= — a worker's money state + payout history.
export async function GET(req: NextRequest) {
  if (!(await isAdminRequest())) return unauthorized();
  const emp = num(req, "emp");
  const f = emp != null ? await store.financeFor(emp, Times.now()) : null;
  if (emp == null || !f) return json({ ok: false });
  const history = await store.payments(emp);
  return json({
    ok: true,
    name: f.name,
    earned: f.earned,
    paid: f.paid,
    owed: f.owedDue,
    tips: f.tips,
    history: history.map((p) => ({ id: p.id, paidAt: p.paidAt, amount: p.amount, tip: p.tip, note: p.note })),
  });
}
