import { NextRequest } from "next/server";
import { json, ok, errJson, isAdminRequest, unauthorized, q, num, money } from "@/lib/http";
import * as store from "@/lib/store";
import { Times, Money } from "@/lib/core";

// POST /api/payments/payout?emp=&amount=&tip=&note= — record a payout.
export async function POST(req: NextRequest) {
  if (!(await isAdminRequest())) return unauthorized();
  const emp = num(req, "emp");
  const f = emp != null ? await store.financeFor(emp, Times.now()) : null;
  const amount = money(req, "amount");
  const tip = money(req, "tip");
  const note = q(req, "note") ?? "";
  if (emp == null || !f) return errJson("Unknown worker.");
  if (amount + tip <= 0) return errJson("Enter a pay or tip amount.");
  const [pay, finalTip] = Money.splitPayout(amount, tip, f.owed);
  await store.addPayment(emp, pay, finalTip, note, Times.now());
  return ok();
}
