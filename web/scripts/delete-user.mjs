import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const l of env.split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]; }
const email = process.argv[2];
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const { data, error } = await supabase.auth.admin.listUsers({ perPage: 1000 });
if (error) { console.error("List failed:", error.message); process.exit(1); }
const u = data.users.find((x) => x.email === email);
if (!u) { console.log("No user found:", email); process.exit(0); }
const del = await supabase.auth.admin.deleteUser(u.id);
console.log(del.error ? "Delete failed: " + del.error.message : "Deleted " + email);
console.log("Remaining users:", data.users.filter((x) => x.email !== email).map((x) => x.email).join(", ") || "(none)");
