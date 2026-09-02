// Restore a timekeeper-*.json.gz backup into the DB (replaces all data).
// Usage: node scripts/restore-backup.mjs <path-to-backup.json.gz>
import postgres from "postgres";
import zlib from "node:zlib";
import { readFileSync } from "node:fs";

try {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const l of env.split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]; }
} catch { /* rely on process.env */ }

const file = process.argv[2];
if (!file) { console.error("Pass the backup .json.gz path"); process.exit(1); }
const payload = JSON.parse(zlib.gunzipSync(readFileSync(file)).toString("utf8"));
const t = payload.tables;
const sql = postgres(process.env.DATABASE_URL, { prepare: false });

// FK-safe insert order.
const ORDER = ["employees", "medications", "time_entries", "schedules", "payments", "clockin_alerts", "med_times", "med_fired"];
const ID_TABLES = ["employees", "medications", "time_entries", "schedules", "payments", "med_times"];

try {
  await sql.begin(async (tx) => {
    await tx`truncate med_fired, med_times, medications, clockin_alerts, payments, schedules, time_entries, employees restart identity cascade`;
    for (const table of ORDER) {
      const rows = t[table] || [];
      for (const row of rows) {
        const cols = Object.keys(row);
        const ph = cols.map((_, i) => `$${i + 1}`).join(",");
        await tx.unsafe(`insert into ${table} (${cols.join(",")}) overriding system value values (${ph})`, cols.map((c) => row[c]));
      }
    }
    for (const table of ID_TABLES) {
      await tx.unsafe(`select setval(pg_get_serial_sequence('${table}','id'), coalesce((select max(id) from ${table}),1))`);
    }
  });
  for (const table of ORDER) {
    const [r] = await sql.unsafe(`select count(*)::int c from ${table}`);
    console.log(`${table}: ${r.c}`);
  }
  console.log("Restore complete.");
} catch (e) {
  console.error("Restore failed:", e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
