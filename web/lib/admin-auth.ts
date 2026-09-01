import crypto from "crypto";

/**
 * Admin second factor. Everything is already behind a Supabase session (see
 * middleware); this PIN gate additionally separates the owner from a worker
 * standing at the kiosk — mirroring the tablet's admin PIN.
 *
 * The cookie value is a deterministic HMAC so any serverless instance can verify
 * it without shared server state.
 */

const SECRET =
  process.env.ADMIN_COOKIE_SECRET || process.env.CRON_SECRET || "dev-insecure-admin-secret";

export const ADMIN_COOKIE = "tk_admin";

export function adminToken(): string {
  return crypto.createHmac("sha256", SECRET).update("tk-admin-v1").digest("base64url");
}

export function isAdmin(cookieVal: string | undefined | null): boolean {
  if (!cookieVal) return false;
  const expected = adminToken();
  const a = Buffer.from(cookieVal);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
