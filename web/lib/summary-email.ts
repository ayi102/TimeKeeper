import { DateTime } from "luxon";
import { Times, Money } from "./core";
import * as store from "./store";
import { sendMail } from "./mailer";

/**
 * Daily summary email — port of Backup.kt: THIS-WEEK hours/earned (Mon–Sun)
 * merged with each worker's RUNNING paid/owed/tips. (No .db.gz attachment — the
 * cloud DB is backed up by Supabase.)
 */
export async function buildSummary(now: DateTime = Times.now()): Promise<{ subject: string; body: string }> {
  const monday = now.startOf("day").minus({ days: now.weekday - 1 });
  const sunday = monday.plus({ days: 6 });

  const weekSecs = await store.periodSeconds(monday.toFormat("yyyy-MM-dd"), sunday.toFormat("yyyy-MM-dd"), now);
  const running = new Map((await store.summarize(now)).map((r) => [r.id, r]));
  const emps = await store.employeesAdmin(); // active first; has rate + active

  interface Row { name: string; hours: number; earned: number; paid: number; owed: number; tips: number; }
  const rows: Row[] = [];
  for (const e of emps) {
    const hours = Money.hours(weekSecs.get(e.id) ?? 0);
    if (!(e.active || hours > 0)) continue; // drop inactive with no hours this week
    const r = running.get(e.id);
    rows.push({ name: e.name, hours, earned: Money.pay(hours, e.rate), paid: r?.paid ?? 0, owed: r?.owedDue ?? 0, tips: r?.tips ?? 0 });
  }

  const money = (x: number) => "$" + x.toFixed(2);
  const line = (name: string, h: number, e: number, p: number, o: number, t: number) =>
    name.padEnd(16) + h.toFixed(2).padStart(7) + money(e).padStart(10) + money(p).padStart(10) + money(o).padStart(10) + money(t).padStart(10);

  const period = `${monday.toFormat("LLL d")} – ${sunday.toFormat("LLL d, yyyy")}`;
  const t = {
    hours: Money.round2(rows.reduce((a, r) => a + r.hours, 0)),
    earned: Money.round2(rows.reduce((a, r) => a + r.earned, 0)),
    paid: Money.round2(rows.reduce((a, r) => a + r.paid, 0)),
    owed: Money.round2(rows.reduce((a, r) => a + r.owed, 0)),
    tips: Money.round2(rows.reduce((a, r) => a + r.tips, 0)),
  };

  const body =
    "TimeKeeper — Daily Summary\n" +
    `Week of ${period}\n` +
    "(Hours and Earned are for this week; Paid, Owed and Tips are running totals.)\n\n" +
    ("Employee".padEnd(16) + "Hours".padStart(7) + "Earned".padStart(10) + "Paid".padStart(10) + "Owed".padStart(10) + "Tips".padStart(10)) + "\n" +
    "-".repeat(63) + "\n" +
    rows.map((r) => line(r.name, r.hours, r.earned, r.paid, r.owed, r.tips)).join("\n") + "\n" +
    "-".repeat(63) + "\n" +
    line("TOTAL", t.hours, t.earned, t.paid, t.owed, t.tips) + "\n";

  return { subject: `TimeKeeper hours: ${period}`, body };
}

export async function sendDailySummary(now: DateTime = Times.now()): Promise<string> {
  const { subject, body } = await buildSummary(now);
  return sendMail(subject, body);
}
