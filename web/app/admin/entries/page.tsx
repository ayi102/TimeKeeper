"use client";

import { useEffect, useState } from "react";
import AdminGate from "../AdminGate";

interface Entry { id: number; in: string; out: string | null; hours: number; open: boolean; }

function Entries() {
  const [emp, setEmp] = useState<string | null>(null);
  const [who, setWho] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [form, setForm] = useState<{ id: string; in: string; out: string }>({ id: "", in: "", out: "" });
  const [status, setStatus] = useState<{ msg: string; ok: boolean }>({ msg: "", ok: true });

  async function load(id: string) {
    try {
      const res = await (await fetch(`/api/entries?emp=${id}`, { cache: "no-store" })).json();
      if (!res.ok) { setStatus({ msg: "Could not load entries.", ok: false }); return; }
      setWho(res.name || "");
      setEntries(res.entries || []);
    } catch {
      setStatus({ msg: "Could not reach the server.", ok: false });
    }
  }
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("emp");
    setEmp(id);
    if (id) load(id);
  }, []);

  const forInput = (iso: string | null) => (iso ? iso.slice(0, 16) : "");
  const fmt = (iso: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };

  function edit(e: Entry) {
    setForm({ id: String(e.id), in: forInput(e.in), out: forInput(e.out) });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function clearForm() { setForm({ id: "", in: "", out: "" }); setStatus({ msg: "", ok: true }); }

  async function save() {
    if (!form.in) { setStatus({ msg: "Clock-in time is required.", ok: false }); return; }
    const q = `?emp=${emp}${form.id ? `&id=${form.id}` : ""}&in=${encodeURIComponent(form.in)}&out=${encodeURIComponent(form.out)}`;
    try {
      const res = await (await fetch("/api/entries" + q, { method: "POST" })).json();
      if (!res.ok) { setStatus({ msg: res.message || "Could not save.", ok: false }); return; }
      clearForm(); if (emp) load(emp);
    } catch {
      setStatus({ msg: "Could not save.", ok: false });
    }
  }
  async function del(e: Entry) {
    if (!confirm(`Delete this entry (${fmt(e.in)})? This cannot be undone.`)) return;
    await fetch(`/api/entries/delete?id=${e.id}`, { method: "POST" });
    if (emp) load(emp);
  }

  const total = entries.reduce((a, e) => a + e.hours, 0);

  return (
    <>
      <div className="bar">
        <a href="/admin" className="btn ghost">← Admin</a>
        <span className="brand">Timesheet — {who}</span>
      </div>
      <main style={{ maxWidth: 820 }}>
        <div className="card">
          <h2>{form.id ? "Edit entry" : "Add entry"}</h2>
          <div className="form">
            <label className="field">Clock in<input type="datetime-local" value={form.in} onChange={(e) => setForm({ ...form, in: e.target.value })} /></label>
            <label className="field">Clock out <span className="hint">(blank = still in)</span>
              <input type="datetime-local" value={form.out} onChange={(e) => setForm({ ...form, out: e.target.value })} />
            </label>
            <button className="btn primary" onClick={save}>Save</button>
            <button className="btn ghost" onClick={clearForm}>Clear</button>
          </div>
          <div className={`status ${status.ok ? "ok" : "err"}`}>{status.msg}</div>
        </div>

        <div className="card">
          <h2>Entries</h2>
          <table>
            <thead><tr><th>Clock in</th><th>Clock out</th><th className="num">Hours</th><th></th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{fmt(e.in)}</td>
                  <td>{e.open ? <span style={{ color: "var(--green)" }}>In progress</span> : fmt(e.out)}</td>
                  <td className="num">{e.hours.toFixed(2)}</td>
                  <td>
                    <div className="row-actions">
                      <button className="btn" onClick={() => edit(e)}>Edit</button>
                      <button className="btn danger" onClick={() => del(e)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td>Total</td><td></td><td className="num">{total.toFixed(2)}</td><td></td></tr></tfoot>
          </table>
        </div>
      </main>
    </>
  );
}

export default function Page() {
  return <AdminGate><Entries /></AdminGate>;
}
