"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Worker { id: number; name: string; in: boolean; }
interface ClockResult { ok: boolean; name?: string; action?: string; time?: string; message?: string; }
interface DueMed { name: string; dose: string; }

export default function Kiosk() {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [now, setNow] = useState<Date | null>(null);
  const [result, setResult] = useState<ClockResult | null>(null);
  const [dueMeds, setDueMeds] = useState<DueMed[]>([]);

  const resultTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const medTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chimeTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);

  // ----- clock display -----
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // ----- workers -----
  const loadWorkers = useCallback(async () => {
    try {
      const r = await fetch("/api/workers", { cache: "no-store" });
      setWorkers(await r.json());
    } catch {
      /* leave as-is */
    }
  }, []);
  useEffect(() => { loadWorkers(); }, [loadWorkers]);

  // ----- sound: soft synthesized tones, no audio files -----
  function getCtx(): AudioContext | null {
    try {
      if (!audioCtx.current) {
        const C = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!C) return null;
        audioCtx.current = new C();
      }
      if (audioCtx.current.state === "suspended") audioCtx.current.resume();
      return audioCtx.current;
    } catch {
      return null;
    }
  }
  function note(freq: number, startAt: number, dur: number, peak = 0.22) {
    const c = getCtx();
    if (!c) return;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    const t0 = c.currentTime + startAt;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(c.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  }
  // Short two-note confirmation: rising for clock-in, falling for clock-out.
  function clockTone(clockedIn: boolean) {
    note(659.25, 0, 0.14);
    note(clockedIn ? 987.77 : 493.88, 0.11, 0.18);
  }
  // Gentle three-note chime for reminders — noticeable but not harsh.
  function reminderChime() {
    note(523.25, 0, 0.28, 0.25);
    note(659.25, 0.16, 0.28, 0.25);
    note(783.99, 0.32, 0.5, 0.25);
  }

  async function clock(id: number) {
    let res: ClockResult;
    try {
      const r = await fetch(`/api/clock?id=${id}`, { method: "POST" });
      res = await r.json();
    } catch {
      res = { ok: false, message: "Could not reach the server." };
    }
    if (res.ok) clockTone(res.action === "in");
    setResult(res);
    if (resultTimer.current) clearTimeout(resultTimer.current);
    resultTimer.current = setTimeout(() => { setResult(null); loadWorkers(); }, 2500);
  }

  // ----- medication reminders -----
  const stopChime = useCallback(() => {
    if (chimeTimer.current) { clearInterval(chimeTimer.current); chimeTimer.current = null; }
  }, []);
  const dismissMeds = useCallback(() => {
    setDueMeds([]);
    stopChime();
    if (medTimer.current) { clearTimeout(medTimer.current); medTimer.current = null; }
  }, [stopChime]);

  const checkMeds = useCallback(async () => {
    try {
      const r = await fetch("/api/meds/due", { cache: "no-store" });
      const meds: DueMed[] = await r.json();
      if (meds && meds.length) {
        setDueMeds((prev) => [...prev, ...meds]);
        reminderChime();
        if (chimeTimer.current) clearInterval(chimeTimer.current);
        chimeTimer.current = setInterval(reminderChime, 3500); // repeat until acknowledged
        if (medTimer.current) clearTimeout(medTimer.current);
        medTimer.current = setTimeout(() => dismissMeds(), 60000);
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dismissMeds]);

  useEffect(() => {
    checkMeds();
    const t = setInterval(checkMeds, 15000);
    return () => clearInterval(t);
  }, [checkMeds]);

  // Maintenance heartbeat: the always-on kiosk drives auto-clockout + missed-
  // clock-in alerts, so those run without a paid cron. Every 5 minutes.
  useEffect(() => {
    const tick = () => { fetch("/api/tick", { method: "POST" }).catch(() => {}); };
    tick();
    const t = setInterval(tick, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  const clockText = now
    ? `${now.getHours() % 12 || 12}:${String(now.getMinutes()).padStart(2, "0")} ${now.getHours() >= 12 ? "PM" : "AM"}`
    : "--:--";
  const dateText = now ? now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : "";

  return (
    <div className="kiosk">
      <div className="topbar">
        <img className="avatar" src="/media/ali_photo.jpg" alt="" />
        <span className="kbrand">TimeKeeper <span className="byline">by Ali Ismail</span></span>
        <div className="topright" style={{ marginLeft: "auto" }}>
          <div className="clock">{clockText}</div>
          <div className="date">{dateText}</div>
        </div>
      </div>

      <div className="kmain">
        <p className="prompt">Tap your name to clock in or out</p>
        <div className="grid">
          {workers.map((w) => (
            <div key={w.id} className={`namecard ${w.in ? "is-in" : "is-out"}`} onClick={() => clock(w.id)}>
              <div className="namecard-name">{w.name}</div>
              <div className="namecard-status">{w.in ? "In" : "Out"}</div>
            </div>
          ))}
        </div>
        {workers.length === 0 && <p className="empty">No workers yet.</p>}
      </div>

      {result && (
        <div className="overlay">
          <div className={`sheet ${result.ok ? "ok" : "err"}`}>
            <div className="mark">{result.ok ? "✓" : "!"}</div>
            <div className="msg">
              {result.ok ? `${result.name} — clocked ${result.action} at ${result.time}` : result.message || "Not allowed."}
            </div>
          </div>
        </div>
      )}

      {dueMeds.length > 0 && (
        <div className="overlay med">
          <div className="sheet med">
            <div className="mark">💊</div>
            <div className="msg">Medication reminder</div>
            <ul className="medlist">
              {dueMeds.map((m, i) => (
                <li key={i}>{m.name}{m.dose ? <span className="dose">{m.dose}</span> : null}</li>
              ))}
            </ul>
            <button className="medok" onClick={dismissMeds}>OK</button>
          </div>
        </div>
      )}
    </div>
  );
}
