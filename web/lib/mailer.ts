import nodemailer from "nodemailer";
import * as store from "./store";

/** Mail config from the settings table, falling back to env. */
async function mailConfig() {
  const get = async (key: string, env: string, fallback = "") =>
    (await store.getSetting(key)) ?? process.env[env] ?? fallback;
  const host = await get("mail_host", "MAIL_HOST", "smtp.gmail.com");
  const port = Number(await get("mail_port", "MAIL_PORT", "587"));
  const user = await get("mail_user", "MAIL_USER");
  const pass = await get("mail_password", "MAIL_PASSWORD");
  const to = await get("mail_to", "MAIL_TO");
  const from = process.env.MAIL_FROM || user;
  return { host, port, user, pass, to, from };
}

export async function mailConfigured(): Promise<boolean> {
  const c = await mailConfig();
  return Boolean(c.user && c.pass && c.to);
}

export async function sendMail(subject: string, text: string): Promise<string> {
  const c = await mailConfig();
  if (!c.user || !c.pass || !c.to) throw new Error("Mail isn't set up yet — enter your email settings first.");
  const transport = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.port === 465,
    auth: { user: c.user, pass: c.pass },
  });
  await transport.sendMail({ from: c.from, to: c.to, subject, text });
  return `Sent to ${c.to}.`;
}
