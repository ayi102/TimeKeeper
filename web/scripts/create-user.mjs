// Creates a confirmed Supabase Auth user for logging in.
// Usage: node scripts/create-user.mjs [email] [password]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";

try {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch { /* rely on process.env */ }

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing Supabase URL / service role key"); process.exit(1); }

const email = process.argv[2] || "owner@timekeeper.app";
const password = process.argv[3] || crypto.randomBytes(9).toString("base64url");

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const { error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
if (error) {
  console.error("Could not create user:", error.message);
  process.exit(1);
}
console.log("Created login user:");
console.log("  email:   ", email);
console.log("  password:", password);
