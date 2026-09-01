"use client";

import { useCallback, useEffect, useState } from "react";
import AdminGate, { SignOutButton } from "./AdminGate";

interface EmpRow { id: number; name: string; rate: number; active: boolean; }
interface SumRow { id: number; name: string; hours: number; pay: number; paid: number; owed: number; tips: number; }

const money = (n: number) => "$" + Number(n).toFixed(2);

function AdminHome() {
  const [emps, setEmps] = useState<EmpRow[]>([]);
  const [summary, setSummary] = useState<SumRow[]>([]);
  const [form, setForm] = useState<{ id: string; name: string; rate: string }>({ id: "", name: "", rate: "0" });

  const loadEmployees = useCallback(async () => {
    const r = await fetch("/api/employees", { cache: "no-store" });
    setEmps(await r.json());
  }, []);
  const loadSummary = useCallback(async () => {
    const r = await fetch("/api/summary", { cache: "no-store" });
    setSummary(await r.json());
  }, []);
  useEffect(() => { loadEmployees(); loadSummary(); }, [loadEmployees, loadSummary]);

  function editEmp(e: EmpRow) {
    setForm({ id: String(e.id), name: e.name, rate: String(e.rate) });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function clearForm() { setForm({ id: "", name: "", rate: "0" }); }

  async function saveEmp() {
    if (!form.name.trim()) { alert("Name is required."); return; }
    const q = `?name=${encodeURIComponent(form.name.trim())}&rate=${encodeURIComponent(form.rate || "0")}${form.id ? `&id=${form.id}` : ""}`;
    const res = await (await fetch("/api/employees" + q, { method: "POST" })).json();
    if (!res.ok) { alert(res.message || "Could not save."); return; }
    clearForm(); loadEmployees(); loadSummary();
  }
  async function toggleActive(e: EmpRow) {
    await fetch(`/api/employees/active?id=${e.id}&active=${e.active ? "0" : "1"}`, { method: "POST" });
    loadEmployees(); loadSummary();
  }
  async function deleteEmp(e: EmpRow) {
    if (!confirm(`Permanently delete ${e.name} and ALL their time entries and payments?\nThis cannot be undone. (To just remove them from the kiosk, use Deactivate instead.)`)) return;
    await fetch(`/api/employees/delete?id=${e.id}`, { method: "POST" });
    loadEmployees(); loadSummary();
  }

  const t = summary.reduce((a, e) => ({ hours: a.hours + e.hours, pay: a.pay + e.pay, paid: a.paid + e.paid, owed: a.owed + e.owed, tips: a.tips + e.tips }), { hours: 0, pay: 0, paid: 0, owed: 0, tips: 0 });

  return (
    <>
      <div className="bar">
        <span className="brand">TimeKeeper <span className="byline">by Ali Ismail</span></span>
        <a href="/admin/meds" className="btn ghost" style={{ marginLeft: "auto" }}>Medications</a>
        <a href="/admin/settings" className="btn ghost">Mail</a>
        <SignOutButton />
      </div>

      <main>
        <div className="card">
          <h2>{form.id ? "Edit Worker" : "Add Worker"}</h2>
          <div className="form">
            <label className="field">Name
              <input type="text" value={form.name} placeholder="Worker name" onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="field">Hourly rate ($)
              <input type="number" min="0" step="0.01" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} />
            </label>
            <button className="btn primary" onClick={saveEmp}>Save</button>
            <button className="btn ghost" onClick={clearForm}>Clear</button>
          </div>
          <table>
            <thead><tr><th>Name</th><th className="num">Rate</th><th></th></tr></thead>
            <tbody>
              {emps.map((e) => (
                <tr key={e.id} className={e.active ? "" : "inactive"}>
                  <td>{e.name}{!e.active && <span className="pill" style={{ marginLeft: ".4rem" }}>inactive</span>}</td>
                  <td className="num">${e.rate.toFixed(2)}/hr</td>
                  <td>
                    <div className="row-actions">
                      <a className="btn" href={`/admin/schedule?emp=${e.id}`}>Schedule</a>
                      <button className="btn" onClick={() => editEmp(e)}>Edit</button>
                      <button className="btn ghost" onClick={() => toggleActive(e)}>{e.active ? "Deactivate" : "Reactivate"}</button>
                      <button className="btn danger" onClick={() => deleteEmp(e)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2>Summary</h2>
          <table>
            <thead>
              <tr><th>Name</th><th className="num">Hours</th><th className="num">Earned</th><th className="num">Paid</th><th className="num">Owed</th><th className="num">Tips</th><th></th></tr>
            </thead>
            <tbody>
              {summary.map((e) => (
                <tr key={e.id}>
                  <td>{e.name}</td>
                  <td className="num">{e.hours.toFixed(2)}</td>
                  <td className="num">{money(e.pay)}</td>
                  <td className="num">{money(e.paid)}</td>
                  <td className="num owed">{money(e.owed)}</td>
                  <td className="num">{money(e.tips)}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <a className="btn" href={`/admin/entries?emp=${e.id}`}>Entries</a>{" "}
                    <a className="btn primary" href={`/admin/payments?emp=${e.id}`}>Pay Out</a>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td className="num">{t.hours.toFixed(2)}</td>
                <td className="num">{money(t.pay)}</td>
                <td className="num">{money(t.paid)}</td>
                <td className="num">{money(t.owed)}</td>
                <td className="num">{money(t.tips)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </main>
    </>
  );
}

export default function Page() {
  return <AdminGate><AdminHome /></AdminGate>;
}
