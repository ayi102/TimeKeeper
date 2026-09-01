"use client";

import { useEffect, useState } from "react";
import AdminGate from "../AdminGate";

interface MonthPay { month: string; hours: number; pay: number; }
interface Worker {
  id: number; name: string; rate: number; active: boolean;
  thisMonth: { hours: number; pay: number };
  lastMonth: { hours: number; pay: number };
  allTime: { hours: number; pay: number; paid: number; owed: number };
  months: MonthPay[];
  behavior: { shifts: number; late: number; tooEarly: number; overtime: number; forgotOut: number; missed: number };
}
interface Data {
  thisMonth: string; lastMonth: string; months: string[]; behaviorDays: number;
  workers: Worker[];
  totals: { thisMonthPay: number; thisMonthHours: number; lastMonthPay: number; allTimePay: number; owed: number };
}

const money = (n: number) => "$" + Number(n).toFixed(2);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthShort = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[m - 1]} ${String(y).slice(2)}`;
};
const scroll: React.CSSProperties = { overflowX: "auto" };

function Insights() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      try { setD(await (await fetch("/api/insights", { cache: "no-store" })).json()); }
      catch { setErr("Could not load insights."); }
    })();
  }, []);

  return (
    <>
      <div className="bar">
        <a href="/admin" className="btn ghost">← Admin</a>
        <span className="brand">Insights</span>
      </div>
      <main style={{ maxWidth: 900 }}>
        {err && <div className="card"><p className="status err">{err}</p></div>}
        {!d && !err && <div className="card"><p className="muted">Loading…</p></div>}

        {d && (
          <>
            {/* ---- Pay: this month ---- */}
            <div className="card">
              <h2>This month ({monthShort(d.thisMonth)})</h2>
              <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "1rem" }}>
                {[["Payroll this month", money(d.totals.thisMonthPay)], ["Hours this month", d.totals.thisMonthHours.toFixed(2)], ["Currently owed", money(d.totals.owed)]].map(([label, val]) => (
                  <div key={label} style={{ flex: 1, minWidth: 130, background: "var(--bg)", borderRadius: 12, padding: "1rem", textAlign: "center" }}>
                    <span style={{ display: "block", color: "var(--muted)", fontSize: ".72rem", textTransform: "uppercase", letterSpacing: ".5px" }}>{label}</span>
                    <span style={{ display: "block", fontSize: "1.5rem", fontWeight: 700, marginTop: ".25rem" }}>{val}</span>
                  </div>
                ))}
              </div>
              <div style={scroll}>
                <table>
                  <thead><tr><th>Worker</th><th className="num">Hours</th><th className="num">Pay</th><th className="num">Last mo.</th><th className="num">Owed</th></tr></thead>
                  <tbody>
                    {d.workers.map((w) => (
                      <tr key={w.id} className={w.active ? "" : "inactive"}>
                        <td>{w.name} <span className="muted" style={{ fontSize: ".8rem" }}>${w.rate}/hr</span></td>
                        <td className="num">{w.thisMonth.hours.toFixed(2)}</td>
                        <td className="num">{money(w.thisMonth.pay)}</td>
                        <td className="num muted">{money(w.lastMonth.pay)}</td>
                        <td className="num owed">{money(w.allTime.owed)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ---- Pay: monthly trend ---- */}
            <div className="card">
              <h2>Monthly pay</h2>
              <div style={scroll}>
                <table>
                  <thead>
                    <tr><th>Worker</th>{d.months.map((m) => <th key={m} className="num">{monthShort(m)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {d.workers.map((w) => (
                      <tr key={w.id} className={w.active ? "" : "inactive"}>
                        <td>{w.name}</td>
                        {w.months.map((m) => <td key={m.month} className="num">{m.pay ? money(m.pay) : "—"}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ---- Pay: all-time ---- */}
            <div className="card">
              <h2>All-time</h2>
              <div style={scroll}>
                <table>
                  <thead><tr><th>Worker</th><th className="num">Total hours</th><th className="num">Earned</th><th className="num">Paid</th><th className="num">Owed</th></tr></thead>
                  <tbody>
                    {d.workers.map((w) => (
                      <tr key={w.id} className={w.active ? "" : "inactive"}>
                        <td>{w.name}</td>
                        <td className="num">{w.allTime.hours.toFixed(2)}</td>
                        <td className="num">{money(w.allTime.pay)}</td>
                        <td className="num">{money(w.allTime.paid)}</td>
                        <td className="num owed">{money(w.allTime.owed)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ---- Behavior ---- */}
            <div className="card">
              <h2>Attendance <span className="muted" style={{ fontSize: ".8rem", fontWeight: 400 }}>· last {d.behaviorDays} days</span></h2>
              <div style={scroll}>
                <table>
                  <thead>
                    <tr>
                      <th>Worker</th><th className="num">Shifts</th><th className="num">Late</th>
                      <th className="num">Early in</th><th className="num">Overtime</th>
                      <th className="num">Missed</th><th className="num">Forgot out</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.workers.map((w) => {
                      const b = w.behavior;
                      const flag = (n: number) => (n > 0 ? { color: "#fbbf24", fontWeight: 700 } : undefined);
                      return (
                        <tr key={w.id} className={w.active ? "" : "inactive"}>
                          <td>{w.name}</td>
                          <td className="num">{b.shifts}</td>
                          <td className="num" style={flag(b.late)}>{b.late}</td>
                          <td className="num">{b.tooEarly}</td>
                          <td className="num">{b.overtime}</td>
                          <td className="num" style={flag(b.missed)}>{b.missed}</td>
                          <td className="num" style={flag(b.forgotOut)}>{b.forgotOut}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="hint" style={{ marginTop: ".75rem" }}>
                <strong>Late</strong>: clocked in more than 5 min after the shift start.
                <strong> Early in</strong>: tapped in before the start.
                <strong> Overtime</strong>: tapped out after the shift end.
                <strong> Missed</strong>: scheduled but never clocked in.
                <strong> Forgot out</strong>: never tapped out (auto-closed).
              </p>
            </div>
          </>
        )}
      </main>
    </>
  );
}

export default function Page() {
  return <AdminGate><Insights /></AdminGate>;
}
