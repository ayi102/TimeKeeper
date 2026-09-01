"use client";

import { useEffect, useState } from "react";
import AdminGate from "../AdminGate";

interface Pay { id: number; paidAt: string; amount: number; tip: number; note: string; }
interface Data { ok: boolean; name?: string; earned?: number; paid?: number; owed?: number; tips?: number; history?: Pay[]; }

const money = (n: number) => "$" + Number(n).toFixed(2);

function Payments() {
  const [emp, setEmp] = useState<string | null>(null);
  const [data, setData] = useState<Data>({ ok: false });
  const [amount, setAmount] = useState("0.00");
  const [tip, setTip] = useState("0.00");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState("");

  async function load(id: string) {
    try {
      const d: Data = await (await fetch(`/api/payments?emp=${id}`, { cache: "no-store" })).json();
      if (!d.ok) { setStatus("Could not load."); return; }
      setData(d);
      setAmount(Number(d.owed).toFixed(2));
    } catch {
      setStatus("Could not load.");
    }
  }
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("emp");
    setEmp(id);
    if (id) load(id);
  }, []);

  async function pay() {
    try {
      const q = `?emp=${emp}&amount=${amount || "0"}&tip=${tip || "0"}&note=${encodeURIComponent(note.trim())}`;
      const res = await (await fetch("/api/payments/payout" + q, { method: "POST" })).json();
      if (!res.ok) { setStatus(res.message || "Could not record."); return; }
      setTip("0.00"); setNote(""); setStatus("Payout recorded.");
      if (emp) load(emp);
    } catch {
      setStatus("Could not record.");
    }
  }
  async function del(id: number) {
    if (!confirm("Delete this payment?")) return;
    await fetch(`/api/payments/delete?id=${id}`, { method: "POST" });
    if (emp) load(emp);
  }

  const fmtWhen = (iso: string) => {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };

  return (
    <>
      <div className="bar">
        <a href="/admin" className="btn ghost">← Admin</a>
        <span className="brand">{data.name ? `${data.name} · Payments` : "Payments"}</span>
      </div>
      <main style={{ maxWidth: 760 }}>
        <div className="card">
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
            {[["Earned", data.earned], ["Paid", data.paid], ["Owed", data.owed], ["Tips", data.tips]].map(([label, v]) => (
              <div key={label as string} style={{ flex: 1, minWidth: 110, background: "var(--bg)", borderRadius: 12, padding: "1rem", textAlign: "center" }}>
                <span style={{ display: "block", color: "var(--muted)", fontSize: ".75rem", textTransform: "uppercase", letterSpacing: ".5px" }}>{label as string}</span>
                <span style={{ display: "block", fontSize: "1.5rem", fontWeight: 700, marginTop: ".25rem", color: label === "Owed" ? "#fbbf24" : undefined }}>{money(Number(v ?? 0))}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h2>Record a payout</h2>
          <div className="form">
            <label className="field">Pay ($)<input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
            <label className="field">Tip ($)<input type="number" min="0" step="0.01" value={tip} onChange={(e) => setTip(e.target.value)} /></label>
            <label className="field">Note<input type="text" placeholder="e.g. cash, check #123" value={note} onChange={(e) => setNote(e.target.value)} /></label>
            <button className="btn primary" onClick={pay}>Mark Paid</button>
          </div>
          <p className="hint">Owed is rounded up to the whole dollar and Pay defaults to it. Tip is extra and doesn&apos;t affect what&apos;s owed. Paying more than the exact balance is recorded as a tip, so the balance never goes negative.</p>
          <div className="status">{status}</div>
        </div>

        <div className="card">
          <h2>History</h2>
          <table>
            <thead><tr><th>Date</th><th className="num">Pay</th><th className="num">Tip</th><th>Note</th><th></th></tr></thead>
            <tbody>
              {(data.history || []).map((p) => (
                <tr key={p.id}>
                  <td>{fmtWhen(p.paidAt)}</td>
                  <td className="num">{money(p.amount)}</td>
                  <td className="num">{p.tip ? money(p.tip) : "—"}</td>
                  <td>{p.note}</td>
                  <td style={{ textAlign: "right" }}><button className="btn danger small" onClick={() => del(p.id)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}

export default function Page() {
  return <AdminGate><Payments /></AdminGate>;
}
