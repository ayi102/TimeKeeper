"use client";

import { useEffect, useRef, useState } from "react";
import AdminGate from "../AdminGate";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAYS_SHORT = ["M", "Tu", "W", "Th", "F", "Sa", "Su"];

interface Slot { weekday: number; time: string; }
interface Med { id: number; name: string; dose: string; active: boolean; slots: Slot[]; }
interface TimeRow { key: number; time: string; days: number[]; }

function fmtTime(t: string) {
  const [h, m] = t.split(":");
  const hh = parseInt(h, 10);
  return `${hh % 12 || 12}:${m} ${hh >= 12 ? "PM" : "AM"}`;
}
function fmtDays(days: number[]) {
  if (days.length === 7) return "Every day";
  if (days.length === 5 && days.every((d) => d < 5)) return "Weekdays";
  return days.map((d) => DAYS[d]).join(", ");
}
function groupByTime(slots: Slot[]): { time: string; days: number[] }[] {
  const byTime = new Map<string, number[]>();
  for (const s of slots) {
    if (!byTime.has(s.time)) byTime.set(s.time, []);
    byTime.get(s.time)!.push(s.weekday);
  }
  return [...byTime.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([time, days]) => ({ time, days: days.sort((a, b) => a - b) }));
}

function Meds() {
  const [meds, setMeds] = useState<Med[]>([]);
  const [form, setForm] = useState<{ id: string; name: string; dose: string }>({ id: "", name: "", dose: "" });
  const [rows, setRows] = useState<TimeRow[]>([]);
  const [status, setStatus] = useState<{ msg: string; ok: boolean }>({ msg: "", ok: true });
  const nextKey = useRef(1);

  async function load() {
    try { setMeds(await (await fetch("/api/meds", { cache: "no-store" })).json()); } catch { /* */ }
  }
  useEffect(() => { clearForm(); load(); }, []);

  const addTime = (time = "", days: number[] = []) => setRows((r) => [...r, { key: nextKey.current++, time, days }]);
  const removeTime = (key: number) => setRows((r) => r.filter((x) => x.key !== key));
  const setTime = (key: number, time: string) => setRows((r) => r.map((x) => (x.key === key ? { ...x, time } : x)));
  const toggleDay = (key: number, wd: number) =>
    setRows((r) => r.map((x) => (x.key === key ? { ...x, days: x.days.includes(wd) ? x.days.filter((d) => d !== wd) : [...x.days, wd] } : x)));

  function clearForm() {
    setForm({ id: "", name: "", dose: "" });
    setRows([{ key: nextKey.current++, time: "", days: [] }]);
    setStatus({ msg: "", ok: true });
  }
  function editMed(m: Med) {
    setForm({ id: String(m.id), name: m.name, dose: m.dose || "" });
    const groups = groupByTime(m.slots);
    setRows(groups.length ? groups.map((g) => ({ key: nextKey.current++, time: g.time, days: g.days })) : [{ key: nextKey.current++, time: "", days: [] }]);
    setStatus({ msg: "", ok: true });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function save() {
    if (!form.name.trim()) { setStatus({ msg: "Name is required.", ok: false }); return; }
    const slots: Slot[] = [];
    for (const r of rows) if (r.time) for (const d of r.days) slots.push({ weekday: d, time: r.time });
    if (!slots.length) { setStatus({ msg: "Add at least one day and time.", ok: false }); return; }
    const q = `?name=${encodeURIComponent(form.name.trim())}&dose=${encodeURIComponent(form.dose.trim())}&slots=${encodeURIComponent(JSON.stringify(slots))}${form.id ? `&id=${form.id}` : ""}`;
    try {
      const res = await (await fetch("/api/meds" + q, { method: "POST" })).json();
      if (!res.ok) { setStatus({ msg: res.message || "Could not save.", ok: false }); return; }
      clearForm(); load();
    } catch { setStatus({ msg: "Could not reach the server.", ok: false }); }
  }
  async function toggleActive(m: Med) {
    await fetch(`/api/meds/active?id=${m.id}&active=${m.active ? "0" : "1"}`, { method: "POST" });
    load();
  }
  async function del(m: Med) {
    if (!confirm(`Delete ${m.name} and its schedule?`)) return;
    await fetch(`/api/meds/delete?id=${m.id}`, { method: "POST" });
    load();
  }

  return (
    <>
      <div className="bar">
        <a href="/admin" className="btn ghost">← Admin</a>
        <span className="brand">Medications</span>
      </div>
      <main style={{ maxWidth: 860 }}>
        <div className="card">
          <h2>{form.id ? "Edit Medication" : "Add Medication"}</h2>
          <p className="intro">Set the medication and, for each time of day, the days it&apos;s given. At each scheduled time the clock-in screen shows a full-screen reminder for one minute.</p>
          <label className="field">Name<input type="text" placeholder="e.g. Metformin" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field" style={{ marginTop: ".9rem" }}>Dose (optional)<input type="text" placeholder="e.g. 500 mg, 1 tablet" value={form.dose} onChange={(e) => setForm({ ...form, dose: e.target.value })} /></label>
          <div style={{ fontSize: ".8rem", color: "var(--muted)", margin: ".9rem 0 .5rem" }}>Times &amp; days</div>
          <div className="times">
            {rows.map((r) => (
              <div className="timerow" key={r.key}>
                <input type="time" value={r.time} onChange={(e) => setTime(r.key, e.target.value)} />
                <div className="daybtns">
                  {DAYS_SHORT.map((lbl, idx) => (
                    <button type="button" key={idx} className={`daybtn ${r.days.includes(idx) ? "on" : ""}`} onClick={() => toggleDay(r.key, idx)}>{lbl}</button>
                  ))}
                </div>
                <button type="button" className="btn ghost small" style={{ marginLeft: "auto" }} onClick={() => removeTime(r.key)}>Remove</button>
              </div>
            ))}
          </div>
          <button className="btn ghost small" onClick={() => addTime()}>+ Add time</button>
          <div style={{ marginTop: "1rem", display: "flex", gap: ".75rem" }}>
            <button className="btn primary" onClick={save}>Save</button>
            <button className="btn ghost" onClick={clearForm}>Clear</button>
          </div>
          <div className={`status ${status.ok ? "ok" : "err"}`}>{status.msg}</div>
        </div>

        <div className="card">
          <h2>Scheduled Medications</h2>
          <table>
            <thead><tr><th>Name</th><th>Dose</th><th>Schedule</th><th></th></tr></thead>
            <tbody>
              {meds.map((m) => (
                <tr key={m.id} className={m.active ? "" : "inactive"}>
                  <td>{m.name}</td>
                  <td>{m.dose || "—"}</td>
                  <td>
                    {groupByTime(m.slots).map((g, i) => (
                      <div className="slotline" key={i}><span className="pill">{fmtTime(g.time)}</span><span className="days">{fmtDays(g.days)}</span></div>
                    )) || "—"}
                  </td>
                  <td>
                    <div className="row-actions">
                      <button className="btn small" onClick={() => editMed(m)}>Edit</button>
                      <button className="btn small" onClick={() => toggleActive(m)}>{m.active ? "Disable" : "Enable"}</button>
                      <button className="btn danger" onClick={() => del(m)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {meds.length === 0 && <p className="muted">No medications yet.</p>}
        </div>
      </main>
    </>
  );
}

export default function Page() {
  return <AdminGate><Meds /></AdminGate>;
}
