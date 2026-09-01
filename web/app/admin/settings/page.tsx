"use client";

import { useEffect, useState } from "react";
import AdminGate from "../AdminGate";

function Settings() {
  const [mail, setMail] = useState({ host: "smtp.gmail.com", port: "587", user: "", to: "", password: "" });
  const [hasPassword, setHasPassword] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{ msg: string; ok: boolean }>({ msg: "", ok: true });
  const [pin, setPin] = useState({ current: "", next: "", confirm: "" });
  const [pinStatus, setPinStatus] = useState<{ msg: string; ok: boolean }>({ msg: "", ok: true });
  const [testStatus, setTestStatus] = useState<{ msg: string; ok: boolean }>({ msg: "", ok: true });

  useEffect(() => {
    (async () => {
      try {
        const s = await (await fetch("/api/settings", { cache: "no-store" })).json();
        setMail((m) => ({ ...m, host: s.host || "smtp.gmail.com", port: String(s.port || 587), user: s.user || "", to: s.to || "" }));
        setHasPassword(!!s.hasPassword);
      } catch { /* ignore */ }
    })();
  }, []);

  async function saveMail() {
    const q = `?host=${encodeURIComponent(mail.host)}&port=${encodeURIComponent(mail.port)}&user=${encodeURIComponent(mail.user)}&password=${encodeURIComponent(mail.password)}&to=${encodeURIComponent(mail.to)}`;
    try {
      const res = await (await fetch("/api/settings" + q, { method: "POST" })).json();
      setSaveStatus({ msg: res.ok ? "Saved." : "Could not save.", ok: res.ok });
      setMail((m) => ({ ...m, password: "" }));
      if (res.ok) setHasPassword(true);
    } catch {
      setSaveStatus({ msg: "Could not save.", ok: false });
    }
  }

  async function savePin() {
    if (pin.next.length < 4) { setPinStatus({ msg: "New PIN must be at least 4 digits.", ok: false }); return; }
    if (pin.next !== pin.confirm) { setPinStatus({ msg: "New PINs don't match.", ok: false }); return; }
    try {
      const res = await (await fetch(`/api/admin/pin?current=${encodeURIComponent(pin.current)}&new=${encodeURIComponent(pin.next)}`, { method: "POST" })).json();
      setPinStatus({ msg: res.ok ? "PIN updated." : (res.message || "Could not update."), ok: res.ok });
      if (res.ok) setPin({ current: "", next: "", confirm: "" });
    } catch {
      setPinStatus({ msg: "Could not update.", ok: false });
    }
  }

  async function sendTest() {
    setTestStatus({ msg: "Sending…", ok: true });
    try {
      const res = await (await fetch("/api/admin/backup-test", { method: "POST" })).json();
      setTestStatus({ msg: res.message || (res.ok ? "Sent." : "Failed."), ok: res.ok });
    } catch {
      setTestStatus({ msg: "Failed to send.", ok: false });
    }
  }

  return (
    <>
      <div className="bar">
        <a href="/admin" className="btn ghost">← Admin</a>
        <span className="brand">Mail &amp; Backup</span>
      </div>
      <main style={{ maxWidth: 600 }}>
        <div className="card">
          <h2>Email settings</h2>
          <div style={{ display: "flex", gap: ".75rem" }}>
            <label className="field" style={{ flex: 1 }}>SMTP host<input type="text" value={mail.host} onChange={(e) => setMail({ ...mail, host: e.target.value })} /></label>
            <label className="field" style={{ width: 110 }}>Port<input type="number" value={mail.port} onChange={(e) => setMail({ ...mail, port: e.target.value })} /></label>
          </div>
          <label className="field" style={{ marginTop: ".9rem" }}>Sending Gmail address<input type="text" placeholder="you@gmail.com" value={mail.user} onChange={(e) => setMail({ ...mail, user: e.target.value })} /></label>
          <label className="field" style={{ marginTop: ".9rem" }}>Gmail App Password<input type="password" placeholder={hasPassword ? "•••••• (saved — leave blank to keep)" : "16-char app password"} value={mail.password} onChange={(e) => setMail({ ...mail, password: e.target.value })} /></label>
          <label className="field" style={{ marginTop: ".9rem" }}>Send summary to<input type="text" placeholder="where the daily email goes" value={mail.to} onChange={(e) => setMail({ ...mail, to: e.target.value })} /></label>
          <div style={{ marginTop: ".9rem" }}><button className="btn primary" onClick={saveMail}>Save</button></div>
          <p className="hint">Use a Google <strong>App Password</strong> (Google Account → Security → 2-Step Verification → App passwords), not your normal password. Leave the password blank to keep the saved one.</p>
          <div className={`status ${saveStatus.ok ? "ok" : "err"}`}>{saveStatus.msg}</div>
        </div>

        <div className="card">
          <h2>Admin PIN</h2>
          <p className="hint" style={{ marginTop: 0 }}>The PIN for the admin screens. Default is <strong>1234</strong> — change it.</p>
          <label className="field" style={{ marginTop: ".5rem" }}>Current PIN<input type="password" inputMode="numeric" value={pin.current} onChange={(e) => setPin({ ...pin, current: e.target.value })} /></label>
          <label className="field" style={{ marginTop: ".9rem" }}>New PIN<input type="password" inputMode="numeric" placeholder="at least 4 digits" value={pin.next} onChange={(e) => setPin({ ...pin, next: e.target.value })} /></label>
          <label className="field" style={{ marginTop: ".9rem" }}>Confirm new PIN<input type="password" inputMode="numeric" value={pin.confirm} onChange={(e) => setPin({ ...pin, confirm: e.target.value })} /></label>
          <div style={{ marginTop: ".9rem" }}><button className="btn primary" onClick={savePin}>Update PIN</button></div>
          <div className={`status ${pinStatus.ok ? "ok" : "err"}`}>{pinStatus.msg}</div>
        </div>

        <div className="card">
          <h2>Daily summary email</h2>
          <p className="hint" style={{ marginTop: 0 }}>A summary emails automatically each morning once deployed. Use this to send one now and confirm your mail settings work.</p>
          <div style={{ marginTop: ".5rem" }}><button className="btn" onClick={sendTest}>Send summary email now</button></div>
          <div className={`status ${testStatus.ok ? "ok" : "err"}`}>{testStatus.msg}</div>
        </div>
      </main>
    </>
  );
}

export default function Page() {
  return <AdminGate><Settings /></AdminGate>;
}
