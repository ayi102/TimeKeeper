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
  const medAudio = useRef<HTMLAudioElement | null>(null);
  const beep = useRef<{ ctx: AudioContext; iv: ReturnType<typeof setInterval> } | null>(null);

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

  function playClip(src: string) {
    try { new Audio(src).play().catch(() => {}); } catch { /* ignore */ }
  }

  async function clock(id: number) {
    let res: ClockResult;
    try {
      const r = await fetch(`/api/clock?id=${id}`, { method: "POST" });
      res = await r.json();
    } catch {
      res = { ok: false, message: "Could not reach the server." };
    }
    if (res.ok && res.action === "in") playClip("/media/clocked_in.ogg");
    else if (res.ok && res.action === "out") playClip("/media/clocked_out.ogg");
    setResult(res);
    if (resultTimer.current) clearTimeout(resultTimer.current);
    resultTimer.current = setTimeout(() => { setResult(null); loadWorkers(); }, 2500);
  }

  // ----- medication reminders -----
  const stopMedSound = useCallback(() => {
    if (medAudio.current) { try { medAudio.current.pause(); medAudio.current.currentTime = 0; } catch { /* */ } }
    if (beep.current) { clearInterval(beep.current.iv); try { beep.current.ctx.close(); } catch { /* */ } beep.current = null; }
  }, []);

  const startMedSound = useCallback(() => {
    const el = medAudio.current;
    if (el) {
      el.loop = true;
      el.play().catch(() => startBeep());
    } else startBeep();
    function startBeep() {
      try {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        ctx.resume?.();
        const ping = () => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = "sine"; o.frequency.value = 880;
          g.gain.setValueAtTime(0.0001, ctx.currentTime);
          g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.05);
          g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
          o.connect(g); g.connect(ctx.destination);
          o.start(); o.stop(ctx.currentTime + 0.55);
        };
        ping();
        beep.current = { ctx, iv: setInterval(ping, 1500) };
      } catch { /* ignore */ }
    }
  }, []);

  const dismissMeds = useCallback(() => {
    setDueMeds([]);
    stopMedSound();
    if (medTimer.current) { clearTimeout(medTimer.current); medTimer.current = null; }
  }, [stopMedSound]);

  const checkMeds = useCallback(async () => {
    try {
      const r = await fetch("/api/meds/due", { cache: "no-store" });
      const meds: DueMed[] = await r.json();
      if (meds && meds.length) {
        setDueMeds((prev) => [...prev, ...meds]);
        startMedSound();
        if (medTimer.current) clearTimeout(medTimer.current);
        medTimer.current = setTimeout(() => dismissMeds(), 60000);
      }
    } catch { /* ignore */ }
  }, [startMedSound, dismissMeds]);

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
        <img className="avatar" src="/media/ali_photo.jpg" alt="Ali Ismail" onClick={() => playClip("/media/ali_ismail.ogg")} />
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

      {/* med reminder sound (loops while the overlay is up; falls back to a chime if absent) */}
      <audio ref={medAudio} preload="auto" src="/media/med_alert.m4a" />
    </div>
  );
}
