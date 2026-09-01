// Loads the tablet's SQLite dump into Supabase Postgres, preserving IDs.
// Usage: node --experimental-sqlite scripts/migrate-from-tablet.mjs <path-to-timekeeper.db>
import { DatabaseSync } from "node:sqlite";
import postgres from "postgres";
import { readFileSync } from "node:fs";

try {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch { /* rely on process.env */ }

const sqlitePath = process.argv[2];
if (!sqlitePath) { console.error("Pass the path to timekeeper.db"); process.exit(1); }

const lite = new DatabaseSync(sqlitePath);
const all = (q) => lite.prepare(q).all();
const sql = postgres(process.env.DATABASE_URL, { prepare: false });

try {
  await sql.begin(async (tx) => {
    await tx`truncate med_fired, med_times, medications, clockin_alerts, payments, schedules, time_entries, employees restart identity cascade`;

    for (const e of all("select id,name,hourly_rate,active from employees"))
      await tx`insert into employees (id,name,hourly_rate,active) overriding system value values (${e.id},${e.name},${e.hourly_rate},${!!e.active})`;

    for (const m of all("select id,name,dose,active from medications"))
      await tx`insert into medications (id,name,dose,active) overriding system value values (${m.id},${m.name},${m.dose ?? ""},${!!m.active})`;

    for (const t of all("select id,employee_id,clock_in,clock_out,actual_in,actual_out from time_entries"))
      await tx`insert into time_entries (id,employee_id,clock_in,clock_out,actual_in,actual_out) overriding system value values (${t.id},${t.employee_id},${t.clock_in},${t.clock_out},${t.actual_in},${t.actual_out})`;

    for (const s of all("select id,employee_id,weekday,start_time,end_time from schedules"))
      await tx`insert into schedules (id,employee_id,weekday,start_time,end_time) overriding system value values (${s.id},${s.employee_id},${s.weekday},${s.start_time},${s.end_time})`;

    for (const p of all("select id,employee_id,amount,tip,paid_at,note from payments"))
      await tx`insert into payments (id,employee_id,amount,tip,paid_at,note) overriding system value values (${p.id},${p.employee_id},${p.amount},${p.tip},${p.paid_at},${p.note})`;

    for (const a of all("select employee_id,shift_date,sent_at from clockin_alerts"))
      await tx`insert into clockin_alerts (employee_id,shift_date,sent_at) values (${a.employee_id},${a.shift_date},${a.sent_at})`;

    for (const mt of all("select id,medication_id,weekday,time_of_day from med_times"))
      await tx`insert into med_times (id,medication_id,weekday,time_of_day) overriding system value values (${mt.id},${mt.medication_id},${mt.weekday},${mt.time_of_day})`;

    for (const mf of all("select med_time_id,fired_date from med_fired"))
      await tx`insert into med_fired (med_time_id,fired_date) values (${mf.med_time_id},${mf.fired_date})`;

    // Advance identity sequences past the imported ids.
    for (const t of ["employees", "time_entries", "schedules", "payments", "medications", "med_times"])
      await tx.unsafe(`select setval(pg_get_serial_sequence('${t}','id'), coalesce((select max(id) from ${t}),1))`);
  });

  for (const t of ["employees", "time_entries", "schedules", "payments", "clockin_alerts", "medications", "med_times", "med_fired"]) {
    const [row] = await sql.unsafe(`select count(*)::int as c from ${t}`);
    console.log(`${t}: ${row.c}`);
  }
  console.log("Migration complete.");
} catch (e) {
  console.error("Migration failed:", e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
