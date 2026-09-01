"use client";

import { useEffect, useRef, useState } from "react";
import AdminGate from "../AdminGate";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
interface Row { key: number; weekday: number; start: string; end: string; }

function ScheduleEditor() {
  const [emp, setEmp] = useState<string | null>(null);
  const [title, setTitle] = useState("Schedule");
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState("");
  const nextKey = useRef(1);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("emp");
    setEmp(id);
    if (!id) { setStatus("No worker selected."); return; }
    (async () => {
      try {
        const res = await (await fetch(`/api/schedule?emp=${id}`, { cache: "no-store" })).json();
        setTitle(`${res.name || "Worker"} · Schedule`);
        setRows((res.shifts || []).map((s: { weekday: number; start: string; end: string }) => ({ key: nextKey.current++, ...s })));
      } catch {
        setStatus("Could not load schedule.");
      }
    })();
  }, []);

  const addRow = (weekday: number) => setRows((r) => [...r, { key: nextKey.current++, weekday, start: "09:00", end: "17:00" }]);
  const removeRow = (key: number) => setRows((r) => r.filter((x) => x.key !== key));
  const update = (key: number, field: "start" | "end", val: string) =>
    setRows((r) => r.map((x) => (x.key === key ? { ...x, [field]: val } : x)));

  async function save() {
    const shifts = rows.map(({ weekday, start, end }) => ({ weekday, start, end }));
    try {
      const res = await (await fetch(`/api/schedule?emp=${emp}&shifts=${encodeURIComponent(JSON.stringify(shifts))}`, { method: "POST" })).json();
      if (!res.ok) { setStatus(res.message || "Could not save."); return; }
      const notes = [];
      if (res.skipped) notes.push(`${res.skipped} skipped (start = end)`);
      if (res.overlaps) notes.push(`${res.overlaps} overlapping dropped`);
      setStatus("Saved" + (notes.length ? " — " + notes.join(", ") : "") + ".");
    } catch {
      setStatus("Could not save.");
    }
  }

  return (
    <>
      <div className="bar">
        <a href="/admin" className="btn ghost">← Admin</a>
        <span className="brand">{title}</span>
      </div>
      <main style={{ maxWidth: 760 }}>
        <div className="card">
          <p className="intro">
            Add each shift this worker works. A day can have more than one shift. For an <strong>overnight</strong> shift,
            set the end earlier than the start (e.g. 7:00 PM → 7:00 AM). A day with no shifts is a day off.
          </p>
          {DAYS.map((name, wd) => (
            <div key={wd} style={{ borderBottom: "1px solid var(--panel-2)", padding: ".9rem 0" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
                <strong>{name}</strong>
                <button className="btn" onClick={() => addRow(wd)}>+ add shift</button>
              </div>
              <div style={{ marginTop: ".6rem", display: "flex", flexDirection: "column", gap: ".6rem" }}>
                {rows.filter((r) => r.weekday === wd).map((r) => (
                  <div key={r.key} style={{ display: "flex", alignItems: "center", gap: ".75rem", flexWrap: "wrap" }}>
                    <label className="field" style={{ fontSize: ".75rem" }}>Start
                      <input type="time" value={r.start} onChange={(e) => update(r.key, "start", e.target.value)} />
                    </label>
                    <label className="field" style={{ fontSize: ".75rem" }}>End
                      <input type="time" value={r.end} onChange={(e) => update(r.key, "end", e.target.value)} />
                    </label>
                    {r.start && r.end && r.end <= r.start && (
                      <span style={{ fontSize: ".7rem", color: "var(--blue)" }}>ends next day</span>
                    )}
                    <button className="btn ghost" style={{ marginLeft: "auto" }} onClick={() => removeRow(r.key)}>✕</button>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div style={{ marginTop: "1.25rem", display: "flex", alignItems: "center", gap: "1rem" }}>
            <button className="btn primary" onClick={save}>Save Schedule</button>
            <span className="status">{status}</span>
          </div>
        </div>
      </main>
    </>
  );
}

export default function Page() {
  return <AdminGate><ScheduleEditor /></AdminGate>;
}
