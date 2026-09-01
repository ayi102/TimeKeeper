import { NextRequest, NextResponse } from "next/server";

/** Small helpers so route handlers read like the tablet's Server.kt. */

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status });
export const ok = () => json({ ok: true });
export const errJson = (message: string) => json({ ok: false, message });
export const unauthorized = () => json({ ok: false, message: "admin auth required" }, 401);
export const badRequest = (message = "bad request") => json({ ok: false, message }, 400);

/** Read a trimmed input value. Inputs come via the query string, as on the tablet. */
export function q(req: NextRequest, name: string): string | null {
  const v = req.nextUrl.searchParams.get(name);
  return v == null ? null : v.trim();
}

export function num(req: NextRequest, name: string): number | null {
  const v = q(req, name);
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function money(req: NextRequest, name: string): number {
  const n = num(req, name);
  return n != null && n > 0 ? n : 0;
}

/**
 * Admin routes are gated solely by the Supabase login (enforced in middleware for
 * all /api). There's no separate admin PIN anymore — the phone logs in, the
 * tablet is a locked kiosk that can't reach /admin. So any request that gets here
 * is already an authenticated admin.
 */
export async function isAdminRequest(): Promise<boolean> {
  return true;
}

/** Cron endpoints are authorized by a shared secret (Vercel Cron sends it as a Bearer token). */
export function cronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && req.headers.get("authorization") === `Bearer ${secret}`;
}
