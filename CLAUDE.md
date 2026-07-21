# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A touchscreen time clock for in-home care workers, running on a Raspberry Pi. Workers tap their name on a kiosk to clock in/out; an admin manages employees, schedules, rates, payouts, and reports from any device on the LAN. Python + Flask + SQLite, served by waitress. There is no build step, no test suite, and no linter configured.

## Commands

```bash
# Set up the venv (one-time)
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# Run locally (creates ./timekeeper.db on first start)
PORT=8080 TIMEKEEPER_PIN=1234 .venv/bin/python app.py

# Send the summary email by hand (needs MAIL_* env vars; --this-week reports the
# current week instead of the previous full week). Sends the hours summary with a
# full DB backup attached; runs daily on the Pi via a systemd timer.
.venv/bin/python weekly_email.py --this-week
```

Surfaces once running: `/` (kiosk), `/admin` (PIN-gated, default PIN `1234`), `/admin/summary`, `/settings` (WiFi — only functional on the Pi).

## Architecture

Three Python files plus Jinja templates and two static assets — read all three before changing behavior, since they share logic.

- **[app.py](app.py)** — the whole web app: routes, schedule-enforcement logic, and the background auto-clockout thread. Module-level functions like `summarize_employees`, `period_summary`, `week_bounds`, `entry_seconds`, and `schedule_for` are the shared business logic.
- **[db.py](db.py)** — SQLite access. `init_db()` creates the schema idempotently; every request opens and closes its own connection via `get_db()`. Tables: `employees`, `time_entries` (`clock_out` NULL means still clocked in), `payments`, `schedules` (one row per shift; a weekday can have several shifts, `weekday` is Python's `0=Mon..6=Sun`; a weekday with no rows means off), `clockin_alerts` (dedup for the missed-clock-in emailer).
- **[weekly_email.py](weekly_email.py)** — `import app as tk` to **reuse** `period_summary`/`week_bounds`/`summarize_employees`; importing `app` does not start the server. Run by a systemd timer on the Pi.

### Concepts that span multiple files

- **Time is stored as seconds-precision local-time ISO 8601 strings** (`datetime.now().isoformat(timespec="seconds")`), never UTC and never epoch. All hours are computed from these strings; `clock_out IS NULL` is the canonical "still clocked in" check, and open entries accrue up to `now`.
- **Schedule enforcement is the core domain rule** and lives in `POST /api/clock` plus `auto_clockout_once()`:
  - Clock-in is blocked before `start - EARLY_GRACE_MIN` and after the shift end; a within-grace early clock-in is recorded **at** the scheduled start (no pay before the shift). No schedule for today ⇒ can't clock in.
  - Self clock-out is allowed up to `end + OVERTIME_GRACE_MIN`, then capped at `end`.
  - A background daemon thread (`auto_clockout_loop`, started in `__main__`) closes forgotten open entries once the overtime window passes, capping them at the scheduled end. This thread only runs when the app is launched via `app.py` — not on bare `import app`.
- **Pay model**: `pay = hours * hourly_rate`. "Owed" = accrued pay minus recorded `payments`. The weekly email mixes *this-week* hours/earned with *running* paid/owed totals — keep that distinction if you touch `weekly_email.build`.
- **Money/hours rounding**: hours are `round(seconds/3600, 2)`; dollar amounts are rounded to 2 decimals at each aggregation step. Match this when adding totals.

### Config (environment variables)

`PORT`, `TIMEKEEPER_PIN`, `TIMEKEEPER_SECRET`, `TIMEKEEPER_EARLY_GRACE_MIN` (default 15), `TIMEKEEPER_OVERTIME_MIN` (default 60), `TIMEKEEPER_DB` (path to the SQLite file). Mail: `MAIL_HOST/PORT/USER/PASSWORD/TO/FROM` (loaded from `deploy/mail.env` on the Pi). The DB defaults to `timekeeper.db` next to the source.

## Deployment (Raspberry Pi)

The target is a Pi at `/home/ayi102/TimeKeeper` with a 3.5" touchscreen. See [deploy/](deploy/):

- **Provision / rebuild a fresh Pi**: [deploy/setup.sh](deploy/setup.sh) does it in one command — packages, venv, DB restore from a backup, systemd services/timers, WiFi sudoers, and kiosk autostart. [deploy/deploy.sh](deploy/deploy.sh) syncs code + restarts for ongoing changes. The 3.5" SPI screen needs a model-specific driver, done separately — see [deploy/lcd-setup.md](deploy/lcd-setup.md).

- **[deploy/timekeeper.service](deploy/timekeeper.service)** — systemd unit running the app on port 80 (`CAP_NET_BIND_SERVICE`), ordered `After=network.target` only (deliberately does *not* wait for connectivity, so the kiosk works offline on localhost).
- **[deploy/kiosk.sh](deploy/kiosk.sh)** — launched from [deploy/lxde-autostart](deploy/lxde-autostart); waits for the server, then runs Chromium full-screen in `--kiosk --incognito` with its cache in RAM (`/dev/shm`) to spare the SD card. It self-respawns Chromium on crash, but exits to the desktop when the app touches the `/tmp/kiosk-exit` flag (written by `POST /api/exit-kiosk`).
- **WiFi from the kiosk**: `POST /api/wifi/*` shells out to [deploy/wifi_ctl.sh](deploy/wifi_ctl.sh) via `sudo` (it edits `wpa_supplicant.conf` with `wpa_cli`). This path only works on the Pi.
- **[deploy/timekeeper-daily.{service,timer}](deploy/)** — timer fires daily at 06:00 (`Persistent=true` catches up after downtime) and runs `weekly_email.py --this-week`, which emails the week-to-date summary with a full DB backup (`.db.gz`) attached — so backups arrive daily.

`timekeeper.db`, `deploy/mail.env`, and `deploy/timekeeper.env` are git-ignored — never commit them. Use `deploy/mail.env.example` as the template.
