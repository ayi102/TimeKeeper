# TimeKeeper

A touchscreen time clock for in-home care workers, running on a Raspberry Pi.
Workers tap their name to clock in/out; an admin manages employees, weekly
schedules, hourly rates, payouts, and reports from any device on the network.

## Features
- **Kiosk** (`/`) — full-screen, touch-friendly clock in/out, sized for a 3.5" display.
- **Schedules** — per-employee weekly shifts. Workers can't clock in too early or
  on days off, and are automatically clocked out at their shift end.
- **Admin** (`/admin`, PIN-protected) — manage employees, rates, schedules, time
  entries, and record payouts (tracks Earned → Paid → Owed).
- **Summary** (`/admin/summary`) — this-week and all-time hours/pay/owed, printable.
- **Daily email** — a summary emailed automatically every morning, with a full database backup attached.

## Stack
Python + Flask + SQLite, served by waitress. No build step.

## Run locally
```
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
PORT=8080 TIMEKEEPER_PIN=1234 .venv/bin/python app.py
```

## Configuration (environment variables)
| Var | Purpose | Default |
|-----|---------|---------|
| `PORT` | HTTP port | 8080 |
| `TIMEKEEPER_PIN` | Admin PIN | 1234 |
| `TIMEKEEPER_SECRET` | Flask session secret | change-me |
| `TIMEKEEPER_EARLY_GRACE_MIN` | Minutes before shift start a worker may clock in | 15 |
| `TIMEKEEPER_OVERTIME_MIN` | Minutes past shift end a worker may self clock-out | 60 |

## Deployment (Raspberry Pi)
See [deploy/](deploy/): a systemd service runs the app on boot, Chromium
auto-launches in kiosk mode, and a systemd timer sends the daily summary email.
Mail settings live in `deploy/mail.env` (git-ignored).
