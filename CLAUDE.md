# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**TimeKeeper** is a touchscreen time clock for in-home care workers. Workers tap
their name on a kiosk to clock in/out; an admin manages employees, schedules,
rates, payouts, and reports from any device on the LAN.

This repo holds **two independent implementations of the same product**, which
must stay behaviorally compatible:

- **[app/](app/)** — the current Android app (Kotlin). Runs on a wall-mounted
  tablet, serves its own UI over an in-process web server, and reaches admin
  screens from a phone on the same WiFi.
- **[pi/](pi/)** — the original Raspberry Pi version (Python + Flask + SQLite +
  waitress). Has its own detailed [pi/CLAUDE.md](pi/CLAUDE.md) — **read it before
  touching anything under `pi/`.**

The Android app is a deliberate port of the Pi app: same SQLite schema, same
stored time format, same business rules. When you change domain behavior in one,
check whether the other needs the same change to keep exported/backup data and
computed totals identical.

## Build & test (Android — `app/`)

```bash
./gradlew assembleDebug            # build the debug APK
./gradlew installDebug             # build + install on a connected device/emulator
./gradlew test                     # JVM unit tests (src/test)
./gradlew connectedAndroidTest     # instrumented tests (needs a device/emulator)
./gradlew lint                     # Android lint

# Run a single test class (or append .methodName for one test)
./gradlew test --tests "com.ayi102.timekeeper.ExampleUnitTest"
```

Note: the Gradle `rootProject.name` is still "My Application"; the real app
namespace/applicationId is `com.ayi102.timekeeper`. There is no automated test
coverage of the business logic yet — the `core` package is written to be pure
and JVM-testable (no Android/DB deps), which is where new tests belong.

For Pi commands (venv, running locally, the summary email), see
[pi/CLAUDE.md](pi/CLAUDE.md) — there is no build step or linter on that side.

## Android architecture

The Activity hosts a full-screen `WebView` pointed at a **local** web server that
runs inside the same process. The UI is plain HTML/JS assets talking to JSON
`/api` endpoints — there is no native UI beyond the WebView shell.

- **[MainActivity.kt](app/src/main/java/com/ayi102/timekeeper/MainActivity.kt)** —
  starts the `Server`, loads `http://127.0.0.1:8080/` in a `WebView`, hides system
  bars, enters lock-task (kiosk) mode best-effort, and schedules the three
  WorkManager jobs (`daily-backup` ~6 AM, `auto-clockout` /15 min,
  `missed-clockin` /15 min).
- **[Server.kt](app/src/main/java/com/ayi102/timekeeper/Server.kt)** — a NanoHTTPD
  server (port 8080) and the single request router. It serves `assets/*.html` and
  all `/api` + `/admin` endpoints. Kiosk + clock endpoints are open; everything
  under `/admin` (and admin APIs) is gated by a PIN via the `tk_auth` cookie
  (`guard { }`). The tablet WebView reaches the kiosk on localhost; a phone
  reaches admin at `http://<tablet-ip>:8080/admin`.
- **[Db.kt](app/src/main/java/com/ayi102/timekeeper/Db.kt)** — raw
  `SQLiteOpenHelper` (no Room). Schema mirrors the Pi. `snapshotGzip()` /
  `restoreFrom()` back up and restore the whole DB file as `.db.gz`.
- **[core/Scheduling.kt](app/src/main/java/com/ayi102/timekeeper/core/Scheduling.kt)** —
  pure business logic (`Times`, `Scheduling`, `Money`), no Android/DB dependencies.
  This is the port of the Pi's shared functions and the place logic should live.
- **[Clock.kt](app/src/main/java/com/ayi102/timekeeper/Clock.kt)** — the clock
  in/out state machine (`Clock.toggle`) and `autoCloseOverdue`, using `Scheduling`.
- **[assets/](app/src/main/assets/)** — the HTML pages (kiosk, login, admin,
  schedule, payments, entries, settings). Plain HTML that fetches JSON from the
  server — **not** the Jinja templates from `pi/templates/` (those use server-side
  rendering; keep the two UIs in mind as separate codebases).
- Background workers **[AutoClockoutWorker](app/src/main/java/com/ayi102/timekeeper/AutoClockoutWorker.kt)**,
  **[MissedClockinWorker](app/src/main/java/com/ayi102/timekeeper/MissedClockinWorker.kt)**,
  **[BackupWorker](app/src/main/java/com/ayi102/timekeeper/BackupWorker.kt)** just
  delegate to `Clock`, `MissedClockin`, and `Backup`.
- **[Backup.kt](app/src/main/java/com/ayi102/timekeeper/Backup.kt)** / **[Mailer.kt](app/src/main/java/com/ayi102/timekeeper/Mailer.kt)** —
  build and send the daily summary email + DB backup via Jakarta Mail (SMTP).
  **[Settings.kt](app/src/main/java/com/ayi102/timekeeper/Settings.kt)** stores mail
  config + admin PIN in `SharedPreferences` (the Android equivalent of the Pi's
  `mail.env`).
- **[BootReceiver.kt](app/src/main/java/com/ayi102/timekeeper/BootReceiver.kt)** —
  relaunches the kiosk on device boot (needs "Display over other apps").

## Domain rules that must match across both implementations

These are the invariants shared by `app/` and `pi/`; a change to one usually
means the same change to the other.

- **Stored time format**: seconds-precision local-time ISO 8601 strings
  (`yyyy-MM-ddTHH:mm:ss`), never UTC, never epoch. `clock_out IS NULL` means
  "still clocked in"; open entries accrue up to `now`. The Kotlin `Times`
  formatter is chosen specifically to match Python's `datetime.isoformat`, so
  DB files are interchangeable between the two apps.
- **Weekday convention**: `0 = Monday .. 6 = Sunday` (Python's `weekday()`),
  including in the `schedules` table. Kotlin converts via `dayOfWeek.value - 1`.
- **Schedule enforcement** (in `Clock.toggle` / `Scheduling.resolveClockIn`):
  can't clock in before `start - EARLY_GRACE` (default 15 min) or after shift
  end, and no schedule today ⇒ no clock-in. A within-grace early clock-in is
  recorded **at** the scheduled start (no pay before the shift). Self clock-out
  is allowed up to `end + OVERTIME_GRACE` (default 60 min), then capped at `end`.
  A background job auto-closes forgotten open entries once the overtime window
  passes, capping at the scheduled end. Raw taps are kept in `actual_in`/`actual_out`.
- **Overnight shifts**: an end time `<= ` start time means the shift ends the next day.
- **Pay model**: `pay = round2(hours) * hourly_rate`. "Owed" = accrued pay minus
  recorded `payments`. Tips are tracked separately from pay. The daily summary
  email mixes **this-week** hours/earned with **running** paid/owed/tips totals —
  preserve that distinction.
- **Rounding**: hours are `round(seconds/3600, 2)`; money is rounded to 2 decimals
  at each aggregation step, using **banker's rounding** (`HALF_EVEN`) on the Kotlin
  side to match Python's `round()` so historical cents agree.

## Don't commit

`timekeeper.db` and any DB backups are git-ignored (see [.gitignore](.gitignore)),
as are the Pi's `deploy/mail.env` / `deploy/timekeeper.env`. Never commit
credentials or live database files.
