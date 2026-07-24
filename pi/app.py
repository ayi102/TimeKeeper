"""TimeKeeper - a touchscreen time clock for in-home care workers.

Two surfaces:
  /        kiosk: shown full-screen on the Pi. Workers tap a name and clock in/out.
  /admin   management: opened from a phone/laptop. PIN-gated. Manage employees,
           hourly rates, view accrued pay, and fix time entries.
"""
import math
import os
import socket
import subprocess
import threading
import time as _time
from datetime import datetime, timedelta
from functools import wraps

from flask import (
    Flask, render_template, request, redirect, url_for,
    session, jsonify, flash, abort,
)

import db

app = Flask(__name__)
app.secret_key = os.environ.get("TIMEKEEPER_SECRET", "change-me-please")

# PIN to reach the admin page. Override with the TIMEKEEPER_PIN env var.
ADMIN_PIN = os.environ.get("TIMEKEEPER_PIN", "1234")

# How many minutes before a shift's start a worker may clock in. Clocking in
# earlier than this is blocked; clocking in within the window records the
# scheduled start time (so no one is paid before their shift).
EARLY_GRACE_MIN = int(os.environ.get("TIMEKEEPER_EARLY_GRACE_MIN", "15"))

# How many minutes past the scheduled end to wait before the background job
# force-closes a forgotten open entry. Clock-out pay is always capped at the
# scheduled end, so this only affects *when* a forgotten entry gets auto-closed,
# not the hours. Genuine overtime is added on the Entries page.
OVERTIME_GRACE_MIN = int(os.environ.get("TIMEKEEPER_OVERTIME_MIN", "60"))

# Minutes after a scheduled start with no clock-in before the missed-clock-in
# checker (missed_clockin.py, run by a systemd timer) emails an alert.
MISSED_CLOCKIN_MIN = int(os.environ.get("TIMEKEEPER_MISSED_MIN", "30"))

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

WIFI_CTL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "deploy", "wifi_ctl.sh")
KIOSK_EXIT_FLAG = "/tmp/kiosk-exit"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def get_lan_ip():
    """Best-effort LAN IP of this machine (the address you'd type in a browser)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def parse(ts):
    return datetime.fromisoformat(ts) if ts else None


def entry_seconds(row, now=None):
    """Worked seconds for an entry; open entries count up to `now`."""
    start = parse(row["clock_in"])
    end = parse(row["clock_out"]) if row["clock_out"] else (now or datetime.now())
    return max(0.0, (end - start).total_seconds())


def fmt_dt(ts):
    d = parse(ts)
    return d.strftime("%a %b %-d, %-I:%M %p") if d else ""


def fmt_hours(seconds):
    return round(seconds / 3600.0, 2)


def fmt_time(ts):
    d = parse(ts)
    return d.strftime("%-I:%M %p") if d else ""


app.jinja_env.filters["fmt_dt"] = fmt_dt
app.jinja_env.filters["fmt_time"] = fmt_time


def summarize_employees():
    """Return active/inactive employees with status, total hours and accrued pay."""
    conn = db.get_db()
    employees = conn.execute(
        "SELECT * FROM employees ORDER BY active DESC, name COLLATE NOCASE"
    ).fetchall()
    entries = conn.execute("SELECT * FROM time_entries").fetchall()
    payments = conn.execute("SELECT employee_id, amount, tip FROM payments").fetchall()
    conn.close()

    now = datetime.now()
    by_emp = {}
    for e in entries:
        by_emp.setdefault(e["employee_id"], []).append(e)
    paid_by = {}
    tips_by = {}
    for p in payments:
        paid_by[p["employee_id"]] = paid_by.get(p["employee_id"], 0.0) + p["amount"]
        tips_by[p["employee_id"]] = tips_by.get(p["employee_id"], 0.0) + p["tip"]

    result = []
    for emp in employees:
        rows = by_emp.get(emp["id"], [])
        total_seconds = sum(entry_seconds(r, now) for r in rows)
        clocked_in = any(r["clock_out"] is None for r in rows)
        hours = fmt_hours(total_seconds)
        pay = round(hours * emp["hourly_rate"], 2)
        paid = round(paid_by.get(emp["id"], 0.0), 2)
        owed = round(pay - paid, 2)
        result.append(
            {
                "id": emp["id"],
                "name": emp["name"],
                "hourly_rate": emp["hourly_rate"],
                "active": bool(emp["active"]),
                "clocked_in": clocked_in,
                "hours": hours,
                "pay": pay,
                "paid": paid,
                "owed": owed,  # exact, used for the payout/tip math
                # Owed rounded UP to a whole dollar — what to actually pay out.
                # The cents between this and `owed` become a tip on payout.
                "owed_due": float(math.ceil(owed)) if owed > 0 else 0.0,
                "tips": round(tips_by.get(emp["id"], 0.0), 2),
            }
        )
    return result


def schedules_for(conn, emp_id, on_date):
    """All shifts (start_time, end_time) for an employee on a date, earliest first.
    A weekday can now hold more than one shift."""
    return conn.execute(
        "SELECT start_time, end_time FROM schedules WHERE employee_id=? AND weekday=? "
        "ORDER BY start_time",
        (emp_id, on_date.weekday()),
    ).fetchall()


def combine(on_date, hhmm):
    """Combine a date with an 'HH:MM' string into a datetime."""
    h, m = (int(x) for x in hhmm.split(":"))
    return datetime(on_date.year, on_date.month, on_date.day, h, m)


def shift_end(on_date, start_hhmm, end_hhmm):
    """End datetime of a shift that *starts* on `on_date`. When the end time is
    not after the start time the shift runs overnight, so it ends the next day
    (e.g. 19:00 -> 07:00 ends at 07:00 tomorrow)."""
    end = combine(on_date, end_hhmm)
    if end_hhmm <= start_hhmm:
        end += timedelta(days=1)
    return end


def _windows(conn, emp_id, on_date):
    """(start_dt, end_dt) for each of the day's shifts, earliest first."""
    return [
        (combine(on_date, r["start_time"]),
         shift_end(on_date, r["start_time"], r["end_time"]))
        for r in schedules_for(conn, emp_id, on_date)
    ]


def resolve_clockin(conn, emp_id, name, now):
    """Pick which shift a worker is clocking into at `now`, supporting multiple
    shifts a day. Returns (start_dt, end_dt, None) on success, or
    (None, None, message) explaining why they can't clock in."""
    grace = timedelta(minutes=EARLY_GRACE_MIN)
    todays = _windows(conn, emp_id, now.date())
    # 1. inside a shift's clock-in window (from grace-before-start to its end)
    for s, e in todays:
        if s - grace <= now < e:
            return s, e, None
    # 2. a shift starting just after midnight tomorrow (early cross-midnight tap)
    for s, e in _windows(conn, emp_id, now.date() + timedelta(days=1)):
        if s - grace <= now < s:
            return s, e, None
        break  # sorted by start; only the earliest can reach back before midnight
    # 3. nothing matched — the most helpful message
    if not todays:
        return None, None, f"{name} is not scheduled to work today."
    upcoming = [s for s, e in todays if now < s - grace]
    if upcoming:
        return None, None, f"Too early — next shift starts at {min(upcoming).strftime('%-I:%M %p')}."
    return None, None, f"Shift already ended at {max(e for s, e in todays).strftime('%-I:%M %p')}."


def shift_of(conn, emp_id, cin):
    """The (start_dt, end_dt) of the scheduled shift a clock-in belongs to (the
    window containing it, else the nearest by start), or None if unscheduled."""
    grace = timedelta(minutes=EARLY_GRACE_MIN)
    wins = _windows(conn, emp_id, cin.date())
    for s, e in wins:
        if s - grace <= cin < e:
            return s, e
    if wins:
        return min(wins, key=lambda se: abs((se[0] - cin).total_seconds()))
    return None


def fmt_time_label(hhmm):
    return combine(datetime.now().date(), hhmm).strftime("%-I:%M %p")


app.jinja_env.filters["fmt_time_label"] = fmt_time_label


def week_bounds(ref=None):
    """Monday..Sunday date range containing `ref` (default today)."""
    ref = ref or datetime.now().date()
    start = ref - timedelta(days=ref.weekday())
    return start, start + timedelta(days=6)


def period_summary(start_date, end_date):
    """Per-employee hours and pay for entries whose clock-in falls in the range."""
    conn = db.get_db()
    employees = conn.execute(
        "SELECT * FROM employees ORDER BY active DESC, name COLLATE NOCASE"
    ).fetchall()
    entries = conn.execute("SELECT * FROM time_entries").fetchall()
    conn.close()

    now = datetime.now()
    out = []
    for emp in employees:
        seconds = 0.0
        for r in entries:
            if r["employee_id"] != emp["id"]:
                continue
            cin = datetime.fromisoformat(r["clock_in"])
            if start_date <= cin.date() <= end_date:
                seconds += entry_seconds(r, now)
        hours = fmt_hours(seconds)
        out.append(
            {
                "id": emp["id"],
                "name": emp["name"],
                "active": bool(emp["active"]),
                "hourly_rate": emp["hourly_rate"],
                "hours": hours,
                "pay": round(hours * emp["hourly_rate"], 2),
            }
        )
    return out


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("admin"):
            return redirect(url_for("admin_login"))
        return view(*args, **kwargs)

    return wrapped


# --------------------------------------------------------------------------- #
# Kiosk (the touchscreen)
# --------------------------------------------------------------------------- #
@app.get("/")
def kiosk():
    workers = [e for e in summarize_employees() if e["active"]]
    return render_template("kiosk.html", workers=workers, ip=get_lan_ip())


@app.post("/api/clock")
def clock():
    """Toggle clock state for an employee, enforcing their weekly schedule.

    Clocking in is blocked before (shift start - grace) and after shift end;
    a within-grace early clock-in is recorded at the scheduled start time.
    Clocking out is capped at the scheduled end time so hours can't run over.
    Returns {ok: false, message} when an action is not allowed.
    """
    emp_id = (request.json or {}).get("employee_id")
    if not emp_id:
        abort(400)

    conn = db.get_db()
    emp = conn.execute(
        "SELECT * FROM employees WHERE id=? AND active=1", (emp_id,)
    ).fetchone()
    if not emp:
        conn.close()
        abort(404)

    open_entry = conn.execute(
        "SELECT id, clock_in FROM time_entries WHERE employee_id=? AND clock_out IS NULL",
        (emp_id,),
    ).fetchone()
    now = datetime.now()

    if open_entry:
        # ----- CLOCK OUT -----
        # The recorded time is capped at the scheduled end, so tapping out late
        # never pays past the shift (mirrors how early clock-in is capped at the
        # start). Leaving early still records the actual, earlier time.
        cin = datetime.fromisoformat(open_entry["clock_in"])
        shift = shift_of(conn, emp_id, cin)
        out_dt = now
        if shift and now > shift[1]:
            out_dt = shift[1]  # cap at this shift's scheduled end
        if out_dt < cin:
            out_dt = cin
        conn.execute(
            "UPDATE time_entries SET clock_out=?, actual_out=? WHERE id=?",
            (out_dt.isoformat(timespec="seconds"),
             now.isoformat(timespec="seconds"), open_entry["id"]),
        )
        conn.commit()
        conn.close()
        return jsonify(ok=True, action="out", name=emp["name"],
                       time=out_dt.strftime("%-I:%M %p"))

    # ----- CLOCK IN -----
    # Pick which shift they're clocking into (supports multiple shifts a day, and
    # an early tap just before a midnight start). Pay starts at the scheduled
    # start (clock_in is capped there); the raw tap is kept in actual_in.
    start_dt, _end_dt, err = resolve_clockin(conn, emp_id, emp["name"], now)
    if err:
        conn.close()
        return jsonify(ok=False, message=err)

    clock_in = max(now, start_dt)  # never start the clock before the shift
    conn.execute(
        "INSERT INTO time_entries (employee_id, clock_in, actual_in) VALUES (?, ?, ?)",
        (emp_id, clock_in.isoformat(timespec="seconds"),
         now.isoformat(timespec="seconds")),
    )
    conn.commit()
    conn.close()
    return jsonify(ok=True, action="in", name=emp["name"],
                   time=clock_in.strftime("%-I:%M %p"))


def auto_clockout_once():
    """Close any open entry whose scheduled end time has passed."""
    conn = db.get_db()
    now = datetime.now()
    for e in conn.execute(
        "SELECT id, employee_id, clock_in FROM time_entries WHERE clock_out IS NULL"
    ).fetchall():
        cin = datetime.fromisoformat(e["clock_in"])
        shift = shift_of(conn, e["employee_id"], cin)
        if not shift:
            continue
        end_dt = shift[1]
        # Only close it once the overtime window has fully passed, and cap a
        # forgotten clock-out at the scheduled end (no unearned overtime).
        if now >= end_dt + timedelta(minutes=OVERTIME_GRACE_MIN):
            out = end_dt if end_dt > cin else cin
            conn.execute(
                "UPDATE time_entries SET clock_out=? WHERE id=?",
                (out.isoformat(timespec="seconds"), e["id"]),
            )
    conn.commit()
    conn.close()


def auto_clockout_loop():
    while True:
        try:
            auto_clockout_once()
        except Exception:
            pass
        _time.sleep(60)


# --------------------------------------------------------------------------- #
# Admin
# --------------------------------------------------------------------------- #
def _wifi(*args, timeout=40):
    try:
        return subprocess.run(
            ["sudo", "bash", WIFI_CTL, *args],
            capture_output=True, text=True, timeout=timeout,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None


@app.get("/settings")
def settings():
    st = _wifi("status", timeout=10)
    ssid = ""
    ip = ""
    if st and st.returncode == 0:
        for line in st.stdout.splitlines():
            if line.startswith("ssid="):
                ssid = line[5:].strip()
            elif line.startswith("ip="):
                ip = line[3:].strip()
    return render_template("settings.html", current_ssid=ssid, ip=ip or get_lan_ip())


@app.post("/api/wifi/scan")
def wifi_scan():
    r = _wifi("scan")
    if not r or r.returncode != 0:
        return jsonify(ok=False, networks=[])
    nets = [s for s in r.stdout.splitlines() if s.strip()]
    return jsonify(ok=True, networks=nets)


@app.post("/api/wifi/connect")
def wifi_connect():
    data = request.json or {}
    ssid = (data.get("ssid") or "").strip()
    password = data.get("password") or ""
    if not ssid:
        return jsonify(ok=False, message="Pick or enter a network name.")
    if password and not (8 <= len(password) <= 63):
        return jsonify(ok=False, message="WiFi password must be 8–63 characters.")
    r = _wifi("connect", ssid, password)
    if not r:
        return jsonify(ok=False, message="WiFi command timed out.")
    out = (r.stdout or "").strip()
    if r.returncode == 0 and out.startswith("OK"):
        return jsonify(
            ok=True,
            message=f"Connecting to “{ssid}”… if it succeeds, this device's IP "
            "may change (it's shown in the banner).",
        )
    reason = {"ERR:password": "wrong password format", "ERR:ssid": "invalid name"}.get(
        out, out or "unknown error"
    )
    return jsonify(ok=False, message=f"Could not connect: {reason}")


@app.post("/api/exit-kiosk")
def exit_kiosk():
    try:
        open(KIOSK_EXIT_FLAG, "w").close()
        subprocess.run(["pkill", "chromium"], timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        pass
    return jsonify(ok=True)


@app.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    if request.method == "POST":
        if request.form.get("pin") == ADMIN_PIN:
            session["admin"] = True
            return redirect(url_for("admin"))
        flash("Incorrect PIN.", "error")
    return render_template("login.html")


@app.get("/admin/logout")
def admin_logout():
    session.pop("admin", None)
    return redirect(url_for("admin_login"))


@app.get("/admin")
@admin_required
def admin():
    employees = summarize_employees()
    grand_total = round(sum(e["pay"] for e in employees), 2)
    total_owed = round(sum(e["owed_due"] for e in employees), 2)
    total_tips = round(sum(e["tips"] for e in employees), 2)
    return render_template(
        "admin.html", employees=employees, grand_total=grand_total,
        total_owed=total_owed, total_tips=total_tips, ip=get_lan_ip()
    )


@app.get("/admin/summary")
@admin_required
def admin_summary():
    wk_start, wk_end = week_bounds()
    week = period_summary(wk_start, wk_end)
    alltime = summarize_employees()
    return render_template(
        "summary.html",
        week=week,
        alltime=alltime,
        wk_start=wk_start,
        wk_end=wk_end,
        week_hours=round(sum(e["hours"] for e in week), 2),
        week_total=round(sum(e["pay"] for e in week), 2),
        all_hours=round(sum(e["hours"] for e in alltime), 2),
        all_total=round(sum(e["pay"] for e in alltime), 2),
        all_paid=round(sum(e["paid"] for e in alltime), 2),
        all_owed=round(sum(e["owed_due"] for e in alltime), 2),
        all_tips=round(sum(e["tips"] for e in alltime), 2),
    )


@app.post("/admin/employee")
@admin_required
def save_employee():
    emp_id = request.form.get("id")
    name = (request.form.get("name") or "").strip()
    rate = request.form.get("hourly_rate") or "0"
    try:
        rate = max(0.0, float(rate))
    except ValueError:
        rate = 0.0
    if not name:
        flash("Name is required.", "error")
        return redirect(url_for("admin"))

    conn = db.get_db()
    if emp_id:
        conn.execute(
            "UPDATE employees SET name=?, hourly_rate=? WHERE id=?",
            (name, rate, emp_id),
        )
    else:
        conn.execute(
            "INSERT INTO employees (name, hourly_rate) VALUES (?, ?)", (name, rate)
        )
    conn.commit()
    conn.close()
    flash(f"Saved {name}.", "ok")
    return redirect(url_for("admin"))


@app.post("/admin/employee/<int:emp_id>/toggle")
@admin_required
def toggle_employee(emp_id):
    conn = db.get_db()
    conn.execute("UPDATE employees SET active = 1 - active WHERE id=?", (emp_id,))
    conn.commit()
    conn.close()
    return redirect(url_for("admin"))


@app.get("/admin/employee/<int:emp_id>/entries")
@admin_required
def employee_entries(emp_id):
    conn = db.get_db()
    emp = conn.execute("SELECT * FROM employees WHERE id=?", (emp_id,)).fetchone()
    if not emp:
        conn.close()
        abort(404)
    rows = conn.execute(
        "SELECT * FROM time_entries WHERE employee_id=? ORDER BY clock_in DESC",
        (emp_id,),
    ).fetchall()
    conn.close()

    now = datetime.now()
    entries = []
    for r in rows:
        ai, ao = r["actual_in"], r["actual_out"]
        entries.append(
            {
                "id": r["id"],
                "clock_in": r["clock_in"],
                "clock_out": r["clock_out"],
                "hours": fmt_hours(entry_seconds(r, now)),
                "open": r["clock_out"] is None,
                # Show the exact tap only when it differs from the payable time.
                "actual_in": ai if ai and ai != r["clock_in"] else None,
                "actual_out": ao if ao and ao != r["clock_out"] else None,
                # Clocked in but auto-closed without ever tapping out.
                "needs_review": r["clock_out"] is not None and ai is not None and ao is None,
            }
        )
    return render_template("entries.html", emp=emp, entries=entries)


def _form_dt(value):
    """Parse an <input type=datetime-local> value into a stored ISO string."""
    if not value:
        return None
    return datetime.fromisoformat(value).isoformat(timespec="seconds")


@app.get("/admin/employee/<int:emp_id>/schedule")
@admin_required
def employee_schedule(emp_id):
    conn = db.get_db()
    emp = conn.execute("SELECT * FROM employees WHERE id=?", (emp_id,)).fetchone()
    if not emp:
        conn.close()
        abort(404)
    rows = conn.execute(
        "SELECT weekday, start_time, end_time FROM schedules WHERE employee_id=? "
        "ORDER BY weekday, start_time", (emp_id,),
    ).fetchall()
    conn.close()
    by_day = {}
    for r in rows:
        by_day.setdefault(r["weekday"], []).append(
            {"start": r["start_time"], "end": r["end_time"]})
    days = [{"idx": i, "name": DAYS[i], "shifts": by_day.get(i, [])} for i in range(7)]
    return render_template("schedule.html", emp=emp, days=days, grace=EARLY_GRACE_MIN)


def _shifts_overlap(a, b):
    """a, b are (start_hhmm, end_hhmm). True if the two shifts overlap in time on
    the same day (an overnight shift ends the next day)."""
    d0 = datetime(2000, 1, 1)
    a1, a2 = combine(d0, a[0]), shift_end(d0, a[0], a[1])
    b1, b2 = combine(d0, b[0]), shift_end(d0, b[0], b[1])
    return a1 < b2 and b1 < a2


@app.post("/admin/employee/<int:emp_id>/schedule")
@admin_required
def save_schedule(emp_id):
    # Shift rows arrive as parallel lists: one (sday, sstart, send) per shift.
    by_day = {}
    skipped = 0
    for wd, s, e in zip(request.form.getlist("sday"),
                        request.form.getlist("sstart"),
                        request.form.getlist("send")):
        try:
            wd = int(wd)
        except (TypeError, ValueError):
            continue
        if not (s and e) or s == e:
            skipped += 1
            continue
        by_day.setdefault(wd, []).append((s, e))

    conn = db.get_db()
    conn.execute("DELETE FROM schedules WHERE employee_id=?", (emp_id,))
    overlaps = 0
    for wd, shifts in by_day.items():
        accepted = []
        for sh in sorted(shifts):
            if any(_shifts_overlap(sh, a) for a in accepted):
                overlaps += 1
                continue
            accepted.append(sh)
            conn.execute(
                "INSERT INTO schedules (employee_id, weekday, start_time, end_time) "
                "VALUES (?,?,?,?)", (emp_id, wd, sh[0], sh[1]))
    conn.commit()
    conn.close()

    notes = []
    if skipped:
        notes.append(f"{skipped} row(s) skipped (start and end can't match)")
    if overlaps:
        notes.append(f"{overlaps} overlapping shift(s) dropped")
    if notes:
        flash("Schedule saved — " + "; ".join(notes) + ".", "error")
    else:
        flash("Schedule saved.", "ok")
    return redirect(url_for("employee_schedule", emp_id=emp_id))


@app.get("/admin/employee/<int:emp_id>/payments")
@admin_required
def employee_payments(emp_id):
    summary = next((e for e in summarize_employees() if e["id"] == emp_id), None)
    if not summary:
        abort(404)
    conn = db.get_db()
    rows = conn.execute(
        "SELECT * FROM payments WHERE employee_id=? ORDER BY paid_at DESC", (emp_id,)
    ).fetchall()
    conn.close()
    return render_template("payments.html", emp=summary, payments=rows)


@app.post("/admin/employee/<int:emp_id>/payout")
@admin_required
def record_payout(emp_id):
    note = (request.form.get("note") or "").strip()

    def money(field):
        try:
            return max(0.0, round(float(request.form.get(field) or "0"), 2))
        except ValueError:
            return 0.0

    amount = money("amount")  # wages — reduces what's owed
    tip = money("tip")        # extra, tracked separately
    if amount + tip <= 0:
        flash("Enter a pay or tip amount greater than zero.", "error")
        return redirect(url_for("employee_payments", emp_id=emp_id))

    # Paying more than is owed (e.g. rounding $320.33 up to $321) shouldn't push
    # the balance negative — the overpayment is booked as a tip instead.
    summary = next((e for e in summarize_employees() if e["id"] == emp_id), None)
    owed = max(0.0, summary["owed"]) if summary else 0.0
    over = round(amount - owed, 2)
    if over > 0:
        amount = round(owed, 2)
        tip = round(tip + over, 2)

    conn = db.get_db()
    conn.execute(
        "INSERT INTO payments (employee_id, amount, tip, paid_at, note) VALUES (?,?,?,?,?)",
        (emp_id, amount, tip, db.now_iso(), note),
    )
    conn.commit()
    conn.close()
    paid_msg = f"${amount:.2f}" + (f" + ${tip:.2f} tip" if tip else "")
    if over > 0:
        paid_msg += f" (${over:.2f} over the balance recorded as tip)"
    flash(f"Recorded payout of {paid_msg}.", "ok")
    return redirect(url_for("employee_payments", emp_id=emp_id))


@app.post("/admin/payment/<int:pid>/delete")
@admin_required
def delete_payment(pid):
    conn = db.get_db()
    row = conn.execute(
        "SELECT employee_id FROM payments WHERE id=?", (pid,)
    ).fetchone()
    conn.execute("DELETE FROM payments WHERE id=?", (pid,))
    conn.commit()
    emp_id = row["employee_id"] if row else None
    conn.close()
    flash("Payment deleted.", "ok")
    return redirect(url_for("employee_payments", emp_id=emp_id))


@app.post("/admin/entry")
@admin_required
def save_entry():
    entry_id = request.form.get("id")
    emp_id = request.form.get("employee_id")
    clock_in = _form_dt(request.form.get("clock_in"))
    clock_out = _form_dt(request.form.get("clock_out"))

    if not clock_in:
        flash("Clock-in time is required.", "error")
        return redirect(url_for("employee_entries", emp_id=emp_id))
    if clock_out and parse(clock_out) < parse(clock_in):
        flash("Clock-out cannot be before clock-in.", "error")
        return redirect(url_for("employee_entries", emp_id=emp_id))

    conn = db.get_db()
    if entry_id:
        conn.execute(
            "UPDATE time_entries SET clock_in=?, clock_out=? WHERE id=?",
            (clock_in, clock_out, entry_id),
        )
    else:
        conn.execute(
            "INSERT INTO time_entries (employee_id, clock_in, clock_out) VALUES (?,?,?)",
            (emp_id, clock_in, clock_out),
        )
    conn.commit()
    conn.close()
    flash("Entry saved.", "ok")
    return redirect(url_for("employee_entries", emp_id=emp_id))


@app.post("/admin/entry/<int:entry_id>/delete")
@admin_required
def delete_entry(entry_id):
    conn = db.get_db()
    row = conn.execute(
        "SELECT employee_id FROM time_entries WHERE id=?", (entry_id,)
    ).fetchone()
    conn.execute("DELETE FROM time_entries WHERE id=?", (entry_id,))
    conn.commit()
    emp_id = row["employee_id"] if row else None
    conn.close()
    flash("Entry deleted.", "ok")
    return redirect(url_for("employee_entries", emp_id=emp_id))


def _entries_by_day(conn, emp_id):
    """Map each calendar date -> list of entry ids for this employee."""
    by_day = {}
    for r in conn.execute(
        "SELECT id, clock_in, clock_out FROM time_entries WHERE employee_id=?", (emp_id,)
    ).fetchall():
        d = datetime.fromisoformat(r["clock_in"]).date()
        by_day.setdefault(d, []).append(r)
    return by_day


def _grid_row(d, entry):
    """A week-grid row prefilled from an existing time entry."""
    cin = datetime.fromisoformat(entry["clock_in"])
    cout = datetime.fromisoformat(entry["clock_out"]) if entry["clock_out"] else None
    return {"date": d.isoformat(), "label": d.strftime("%a %b %-d"),
            "entry_id": entry["id"], "working": True,
            "start": cin.strftime("%H:%M"), "end": cout.strftime("%H:%M") if cout else ""}


@app.get("/admin/employee/<int:emp_id>/week")
@admin_required
def employee_week(emp_id):
    """Fill or edit a whole week of time entries at once — one row per shift.

    Each scheduled shift becomes a row, pre-filled from the matching logged
    entry if there is one, otherwise from the schedule. Any extra logged entries
    show as their own rows, and an empty day gets one blank row for ad-hoc use.
    """
    conn = db.get_db()
    emp = conn.execute("SELECT * FROM employees WHERE id=?", (emp_id,)).fetchone()
    if not emp:
        conn.close()
        abort(404)

    start_arg = request.args.get("start")
    try:
        ref = datetime.fromisoformat(start_arg).date() if start_arg else datetime.now().date()
    except ValueError:
        ref = datetime.now().date()
    monday, sunday = week_bounds(ref)

    by_day = _entries_by_day(conn, emp_id)
    grace = timedelta(minutes=EARLY_GRACE_MIN)
    grid = []
    for i in range(7):
        d = monday + timedelta(days=i)
        entries = list(by_day.get(d, []))
        used = set()
        for sh in schedules_for(conn, emp_id, d):
            s = combine(d, sh["start_time"])
            e = shift_end(d, sh["start_time"], sh["end_time"])
            match = next((en for en in entries if en["id"] not in used
                          and s - grace <= datetime.fromisoformat(en["clock_in"]) < e), None)
            if match:
                used.add(match["id"])
                grid.append(_grid_row(d, match))
            else:  # scheduled shift with nothing logged yet — prefill from it
                grid.append({"date": d.isoformat(), "label": d.strftime("%a %b %-d"),
                             "entry_id": "", "working": True,
                             "start": sh["start_time"], "end": sh["end_time"]})
        for en in entries:  # logged entries that don't line up with a shift
            if en["id"] not in used:
                grid.append(_grid_row(d, en))
        if not schedules_for(conn, emp_id, d) and not entries:  # off day, nothing logged
            grid.append({"date": d.isoformat(), "label": d.strftime("%a %b %-d"),
                         "entry_id": "", "working": False, "start": "09:00", "end": "17:00"})
    for idx, row in enumerate(grid):
        row["idx"] = idx
    conn.close()

    return render_template(
        "week.html", emp=emp, grid=grid, row_count=len(grid),
        wk_start=monday, wk_end=sunday,
        prev_week=(monday - timedelta(days=7)).isoformat(),
        next_week=(monday + timedelta(days=7)).isoformat(),
        this_week=week_bounds()[0].isoformat(),
    )


@app.post("/admin/employee/<int:emp_id>/week")
@admin_required
def save_week(emp_id):
    conn = db.get_db()
    emp = conn.execute("SELECT id FROM employees WHERE id=?", (emp_id,)).fetchone()
    if not emp:
        conn.close()
        abort(404)

    week_start = request.form.get("week_start") or ""
    created = updated = deleted = skipped = 0
    for r in range(int(request.form.get("row_count") or 0)):
        try:
            d = datetime.fromisoformat(request.form.get(f"date_{r}")).date()
        except (TypeError, ValueError):
            continue
        entry_id = request.form.get(f"entry_{r}") or ""
        if not request.form.get(f"work_{r}"):
            # Unchecking a row that maps to an entry deletes that entry.
            if entry_id:
                conn.execute("DELETE FROM time_entries WHERE id=? AND employee_id=?",
                             (entry_id, emp_id))
                deleted += 1
            continue
        start = request.form.get(f"start_{r}")
        end = request.form.get(f"end_{r}")
        # end < start is fine (overnight); only equal/missing times are invalid.
        if not (start and end) or start == end:
            skipped += 1
            continue
        cin = combine(d, start).isoformat(timespec="seconds")
        cout = shift_end(d, start, end).isoformat(timespec="seconds")
        if entry_id:
            conn.execute("UPDATE time_entries SET clock_in=?, clock_out=? "
                         "WHERE id=? AND employee_id=?", (cin, cout, entry_id, emp_id))
            updated += 1
        else:
            conn.execute("INSERT INTO time_entries (employee_id, clock_in, clock_out) "
                         "VALUES (?,?,?)", (emp_id, cin, cout))
            created += 1
    conn.commit()
    conn.close()

    parts = []
    if created:
        parts.append(f"{created} added")
    if updated:
        parts.append(f"{updated} updated")
    if deleted:
        parts.append(f"{deleted} removed")
    if skipped:
        parts.append(f"{skipped} skipped (equal or missing times)")
    flash("Week saved — " + (", ".join(parts) if parts else "no changes") + ".", "ok")
    return redirect(url_for("employee_week", emp_id=emp_id, start=week_start))


if __name__ == "__main__":
    db.init_db()
    threading.Thread(target=auto_clockout_loop, daemon=True).start()
    port = int(os.environ.get("PORT", "8080"))
    from waitress import serve

    print(f"TimeKeeper running on http://{get_lan_ip()}:{port}")
    serve(app, host="0.0.0.0", port=port)
