// Applies db/schema.sql to the database in .env.local's DATABASE_URL.
// Usage: node scripts/migrate.mjs
import postgres from "postgres";
import { readFileSync } from "node:fs";

// Load .env.local (simple KEY=VALUE parser).
try {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  /* no .env.local — rely on process.env */
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(url, { prepare: false });
const schema = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");

// Strip "-- ..." comments (no "--" appears inside any string literal here), then
// split into statements.
const statements = schema
  .replace(/--[^\n]*/g, "")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

try {
  for (const stmt of statements) await sql.unsafe(stmt);
  const rows = await sql`
    select table_name from information_schema.tables
    where table_schema = 'public' order by table_name`;
  console.log("OK. Tables:", rows.map((r) => r.table_name).join(", "));
} catch (e) {
  console.error("Migration error:", e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
