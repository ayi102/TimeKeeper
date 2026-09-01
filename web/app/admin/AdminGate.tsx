"use client";

import type { ReactNode } from "react";
import { supabaseBrowser } from "@/lib/supabase-browser";

/** Sign out of the app and return to the login screen. */
export function SignOutButton() {
  async function signOut() {
    try {
      await supabaseBrowser().auth.signOut();
    } catch {
      /* ignore */
    }
    window.location.href = "/login";
  }
  return <button className="btn ghost" onClick={signOut}>Sign out</button>;
}

/**
 * Admin pages are gated by the Supabase login (enforced in middleware) — no
 * separate PIN. This wrapper just renders the page.
 */
export default function AdminGate({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
