-- TimeKeeper — Postgres schema for Supabase.
-- Port of the tablet's SQLite schema (Db.kt). Times are stored as seconds-precision
-- local wall-clock ISO strings ("yyyy-MM-ddTHH:mm:ss") in TEXT columns, exactly like
-- the tablet, so migrated rows copy over unchanged and computed totals still match.
--
-- Run this in the Supabase SQL editor (or via `psql $DATABASE_URL -f db/schema.sql`).
-- Access is enforced in the Next.js API routes (Supabase Auth); the server connects
-- with the service role. RLS can be layered on later if direct client access is added.

create table if not exists employees (
  id          bigint generated always as identity primary key,
  name        text    not null,
  hourly_rate numeric not null default 0,
  active      boolean not null default true
);

create table if not exists time_entries (
  id          bigint generated always as identity primary key,
  employee_id bigint  not null references employees(id) on delete cascade,
  clock_in    text    not null,        -- "yyyy-MM-ddTHH:mm:ss" local
  clock_out   text,                    -- null = still clocked in
  actual_in   text,                    -- raw tap (may differ from paid clock_in)
  actual_out  text
);
create index if not exists idx_entries_emp on time_entries(employee_id);

create table if not exists schedules (
  id          bigint generated always as identity primary key,
  employee_id bigint  not null references employees(id) on delete cascade,
  weekday     integer not null,        -- 0 = Mon .. 6 = Sun
  start_time  text    not null,        -- "HH:MM"
  end_time    text    not null
);
create index if not exists idx_sched_emp_wd on schedules(employee_id, weekday);

create table if not exists payments (
  id          bigint generated always as identity primary key,
  employee_id bigint  not null references employees(id) on delete cascade,
  amount      numeric not null,
  tip         numeric not null default 0,
  paid_at     text    not null,        -- "yyyy-MM-ddTHH:mm:ss" local
  note        text
);
create index if not exists idx_payments_emp on payments(employee_id);

create table if not exists clockin_alerts (
  employee_id bigint not null references employees(id) on delete cascade,
  shift_date  text   not null,         -- per-shift dedup key (scheduled start)
  sent_at     text   not null,
  unique (employee_id, shift_date)
);

create table if not exists medications (
  id     bigint generated always as identity primary key,
  name   text    not null,
  dose   text    not null default '',
  active boolean not null default true
);

create table if not exists med_times (
  id            bigint generated always as identity primary key,
  medication_id bigint  not null references medications(id) on delete cascade,
  weekday       integer not null default 0,   -- 0 = Mon .. 6 = Sun
  time_of_day   text    not null              -- "HH:MM"
);
create index if not exists idx_medtime_med on med_times(medication_id);

create table if not exists med_fired (
  med_time_id bigint not null references med_times(id) on delete cascade,
  fired_date  text   not null,
  unique (med_time_id, fired_date)
);

-- Key/value app settings (admin PIN, mail config) — the cloud equivalent of the
-- tablet's SharedPreferences (Settings.kt), so the settings page keeps working.
create table if not exists settings (
  key   text primary key,
  value text not null
);
