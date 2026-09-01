"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * Admin PIN gate — the second factor on top of the Supabase session. Shows a PIN
 * prompt until the admin cookie is set, then renders the admin page. Mirrors the
 * tablet's admin PIN separating the owner from a walk-up worker.
 */
export default function AdminGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "need" | "ok">("checking");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");

  async function check() {
    try {
      const r = await fetch("/api/admin/session", { cache: "no-store" });
      const d = await r.json();
      setState(d.admin ? "ok" : "need");
    } catch {
      setState("need");
    }
  }
  useEffect(() => { check(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    try {
      const r = await fetch(`/api/admin/login?pin=${encodeURIComponent(pin)}`, { method: "POST" });
      const d = await r.json();
      if (d.ok) setState("ok");
      else setErr("Incorrect PIN.");
    } catch {
      setErr("Something went wrong.");
    }
  }

  if (state === "checking") return null;
  if (state === "need") {
    return (
      <div className="login-wrap">
        <form className="login-card" onSubmit={submit}>
          <h1>Admin</h1>
          <input
            type="password"
            inputMode="numeric"
            placeholder="PIN"
            value={pin}
            autoFocus
            onChange={(e) => setPin(e.target.value)}
          />
          <button type="submit">Enter</button>
          <div className="status err" style={{ marginTop: ".75rem" }}>{err}</div>
          <a href="/" style={{ display: "inline-block", marginTop: "1rem", color: "var(--muted)", fontSize: ".85rem" }}>
            ← Back to kiosk
          </a>
        </form>
      </div>
    );
  }
  return <>{children}</>;
}
