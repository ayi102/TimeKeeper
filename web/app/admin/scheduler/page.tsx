"use client";

import { useEffect, useState, useRef } from "react";
import AdminGate from "../AdminGate";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const COLORS = ["#6366f1", "#22c55e", "#f59e0b", "#ec4899", "#06b6d4", "#a855f7", "#ef4444", "#84cc16"];

interface Shift { key: string; weekday: number; start: string; end: string; }
interface Worker { id: number; name: string; active: boolean; color: string; shifts: Shift[]; }
interface Editor { mode: "add" | "edit"; workerId: number; key?: string; weekday: number; start: string; end: string; }

const toH = (t: string) => { const [h, m] = t.split(":").map(Number); return h + m / 60; };
const pad = (n: number) => String(n).padStart(2, "0");
const fmt = (t: string) => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}:${pad(m)}${h >= 12 ? "p" : "a"}`; };

function Scheduler() {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [viewId, setViewId] = useState<number | null>(null); // null = show everyone
  const [editor, setEditor] = useState<Editor | null>(null);
  const [status, setStatus] = useState("");
  const seq = useRef(0);

  async function load() {
    try {
      const raw = await (await fetch("/api/schedule/all", { cache: "no-store" })).json();
      const ws: Worker[] = raw.map((w: { id: number; name: string; active: boolean; shifts: { weekday: number; start: string; end: string }[] }, i: number) => ({
        id: w.id, name: w.name, active: w.active, color: COLORS[i % COLORS.length],
        shifts: w.shifts.map((s) => ({ key: `k${seq.current++}`, weekday: s.weekday, start: s.start, end: s.end })),
      }));
      setWorkers(ws);
      const emp = new URLSearchParams(window.location.search).get("emp");
      if (emp) setViewId((cur) => cur ?? Number(emp)); // arriving from a worker's row focuses them
    } catch { setStatus("Could not load schedules."); }
  }
  useEffect(() => { load(); }, []);

  async function saveWorker(workerId: number, shifts: Shift[]) {
    const payload = shifts.map(({ weekday, start, end }) => ({ weekday, start, end }));
    const res = await (await fetch(`/api/schedule?emp=${workerId}&shifts=${encodeURIComponent(JSON.stringify(payload))}`, { method: "POST" })).json();
    if (!res.ok) { setStatus(res.message || "Could not save."); return false; }
    setStatus("Saved.");
    await load();
    return true;
  }

  function openAdd(weekday: number, hour: number) {
    if (viewId == null) { setStatus("Pick a person above to add a shift for them."); return; }
    const s = Math.max(0, Math.min(23, hour));
    setEditor({ mode: "add", workerId: viewId, weekday, start: `${pad(s)}:00`, end: `${pad(Math.min(s + 8, 23))}:00` });
  }
  function openEdit(w: Worker, sh: Shift) {
    setEditor({ mode: "edit", workerId: w.id, key: sh.key, weekday: sh.weekday, start: sh.start, end: sh.end });
  }

  async function saveEditor() {
    if (!editor) return;
    const w = workers.find((x) => x.id === editor.workerId);
    if (!w) return;
    let shifts: Shift[];
    if (editor.mode === "edit") {
      shifts = w.shifts.map((s) => (s.key === editor.key ? { ...s, weekday: editor.weekday, start: editor.start, end: editor.end } : s));
    } else {
      shifts = [...w.shifts, { key: `k${seq.current++}`, weekday: editor.weekday, start: editor.start, end: editor.end }];
    }
    if (await saveWorker(editor.workerId, shifts)) setEditor(null);
  }
  async function deleteEditor() {
    if (!editor || editor.mode !== "edit") return;
    const w = workers.find((x) => x.id === editor.workerId);
    if (!w) return;
    if (await saveWorker(editor.workerId, w.shifts.filter((s) => s.key !== editor.key))) setEditor(null);
  }

  // Segments to draw in a given day column (handles overnight spillover).
  function daySegments(day: number) {
    const segs: { w: Worker; sh: Shift; left: number; width: number }[] = [];
    const src = viewId == null ? workers : workers.filter((w) => w.id === viewId);
    for (const w of src) {
      for (const sh of w.shifts) {
        const s = toH(sh.start), e = toH(sh.end);
        if (sh.start === sh.end) continue;
        const overnight = e <= s;
        if (!overnight) {
          if (sh.weekday === day) segs.push({ w, sh, left: s / 24, width: (e - s) / 24 });
        } else {
          if (sh.weekday === day) segs.push({ w, sh, left: s / 24, width: (24 - s) / 24 });
          if ((sh.weekday + 1) % 7 === day) segs.push({ w, sh, left: 0, width: e / 24 });
        }
      }
    }
    return segs;
  }

  return (
    <>
      <div className="bar">
        <a href="/admin" className="btn ghost">← Admin</a>
        <span className="brand">Schedule</span>
      </div>
      <main style={{ maxWidth: 900 }}>
        <div className="card">
          <p className="intro">
            Each row is a day; the bar is midnight → midnight. Pick a person to see just their schedule, or
            <strong> All</strong> to see everyone. Tap a shift to edit or delete it; tap an empty spot to add a shift
            (for the selected person). Overnight shifts wrap into the next day.
          </p>

          <div className="chiprow">
            <button className={`chip ${viewId == null ? "sel" : ""}`} onClick={() => setViewId(null)}>All</button>
            {workers.map((w) => (
              <button key={w.id} className={`chip ${w.id === viewId ? "sel" : ""} ${w.active ? "" : "off"}`} onClick={() => setViewId(w.id)}>
                <span className="dot" style={{ background: w.color }} />{w.name}
              </button>
            ))}
          </div>

          <div className="sched-axis"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span></div>
          {DAYS.map((name, day) => (
            <div className="sched-day" key={day}>
              <span className="dname">{name}</span>
              <div
                className="sched-track"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  openAdd(day, Math.round(((e.clientX - r.left) / r.width) * 24));
                }}
              >
                {[6, 12, 18].map((h) => <span key={h} className="sched-tick" style={{ left: `${(h / 24) * 100}%` }} />)}
                {daySegments(day).map((seg, i) => (
                  <div
                    key={i}
                    className="sched-block"
                    style={{ left: `${seg.left * 100}%`, width: `${Math.max(seg.width * 100, 6)}%`, background: seg.w.color }}
                    onClick={(ev) => { ev.stopPropagation(); openEdit(seg.w, seg.sh); }}
                    title={`${seg.w.name} ${fmt(seg.sh.start)}–${fmt(seg.sh.end)}`}
                  >
                    {seg.w.name} {fmt(seg.sh.start)}
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="status ok" style={{ marginTop: ".5rem" }}>{status}</div>
        </div>
      </main>

      {editor && (
        <div className="modal-wrap" onClick={() => setEditor(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>{editor.mode === "add" ? "Add shift" : "Edit shift"}</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              {workers.find((w) => w.id === editor.workerId)?.name} · {DAYS[editor.weekday]}
            </p>
            <div style={{ display: "flex", gap: ".75rem" }}>
              <label className="field" style={{ flex: 1 }}>Start<input type="time" value={editor.start} onChange={(e) => setEditor({ ...editor, start: e.target.value })} /></label>
              <label className="field" style={{ flex: 1 }}>End<input type="time" value={editor.end} onChange={(e) => setEditor({ ...editor, end: e.target.value })} /></label>
            </div>
            {toH(editor.end) <= toH(editor.start) && editor.start !== editor.end && (
              <p style={{ fontSize: ".75rem", color: "var(--blue)", marginTop: ".5rem" }}>Overnight — ends the next day.</p>
            )}
            <div style={{ display: "flex", gap: ".6rem", marginTop: "1.2rem", flexWrap: "wrap" }}>
              <button className="btn primary" onClick={saveEditor}>Save</button>
              {editor.mode === "edit" && <button className="btn danger" onClick={deleteEditor}>Delete</button>}
              <button className="btn ghost" style={{ marginLeft: "auto" }} onClick={() => setEditor(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default function Page() {
  return <AdminGate><Scheduler /></AdminGate>;
}
