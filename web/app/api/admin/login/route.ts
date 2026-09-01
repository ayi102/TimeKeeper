import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/http";
import * as store from "@/lib/store";
import { ADMIN_COOKIE, adminToken } from "@/lib/admin-auth";

// POST /api/admin/login?pin= — verify the admin PIN and set the admin cookie.
// (The Supabase session is already required by middleware to reach this at all.)
export async function POST(req: NextRequest) {
  const pin = q(req, "pin");
  const okPin = pin != null && pin === (await store.getAdminPin());
  const res = NextResponse.json({ ok: okPin });
  if (okPin) {
    res.cookies.set(ADMIN_COOKIE, adminToken(), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  }
  return res;
}
