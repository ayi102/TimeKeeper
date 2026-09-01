import { NextRequest } from "next/server";
import { json, ok, isAdminRequest, unauthorized, q, num } from "@/lib/http";
import * as store from "@/lib/store";

async function mail(key: string, envKey: string, fallback = ""): Promise<string> {
  return (await store.getSetting(key)) ?? process.env[envKey] ?? fallback;
}

// GET /api/settings — mail config (password presence only).
export async function GET() {
  if (!(await isAdminRequest())) return unauthorized();
  const host = await mail("mail_host", "MAIL_HOST", "smtp.gmail.com");
  const port = Number(await mail("mail_port", "MAIL_PORT", "587"));
  const user = await mail("mail_user", "MAIL_USER");
  const to = await mail("mail_to", "MAIL_TO");
  const pw = await mail("mail_password", "MAIL_PASSWORD");
  return json({ host, port, user, to, hasPassword: pw.length > 0 });
}

// POST /api/settings — save mail config (blank host/password = keep existing).
export async function POST(req: NextRequest) {
  if (!(await isAdminRequest())) return unauthorized();
  const host = q(req, "host");
  if (host) await store.setSetting("mail_host", host);
  const port = num(req, "port");
  if (port != null) await store.setSetting("mail_port", String(port));
  await store.setSetting("mail_user", q(req, "user") ?? "");
  await store.setSetting("mail_to", q(req, "to") ?? "");
  const pw = q(req, "password") ?? "";
  if (pw) await store.setSetting("mail_password", pw);
  return ok();
}
