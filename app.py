"""TimeKeeper - a touchscreen time clock for in-home care workers.

Two surfaces:
  /        kiosk: shown full-screen on the Pi. Workers tap a name and clock in/out.
  /admin   management: opened from a phone/laptop. PIN-gated. Manage employees,
           hourly rates, view accrued pay, and fix time entries.
"""
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

# How many minutes past the scheduled end a worker may still clock OUT themselves
# (capturing a little overtime). If they never clock out, the auto clock-out caps
# them at the scheduled end. Larger amounts are adjusted on the Entries page.
OVERTIME_GRACE_MIN = int(os.environ.get("TIMEKEEPER_OVERTIME_MIN", "60"))

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


app.jinja_env.filters["fmt_dt"] = fmt_dt


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
                "owed": round(pay - paid, 2),
                "tips": round(tips_by.get(emp["id"], 0.0), 2),
            }
        )
    return result


def schedule_for(conn, emp_id, on_date):
    """Return (start_time, end_time) row for an employee on a given date, or None."""
    return conn.execute(
        "SELECT start_time, end_time FROM schedules WHERE employee_id=? AND weekday=?",
        (emp_id, on_date.weekday()),
    ).fetchone()


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
        # ----- CLOCK OUT (allow up to OVERTIME_GRACE past the scheduled end) -----
        cin = datetime.fromisoformat(open_entry["clock_in"])
        sched = schedule_for(conn, emp_id, cin.date())
        out_dt = now
        if sched:
            limit = shift_end(cin.date(), sched["start_time"], sched["end_time"]) + timedelta(
                minutes=OVERTIME_GRACE_MIN
            )
            if now > limit:
                out_dt = limit
        if out_dt < cin:
            out_dt = cin
        conn.execute(
            "UPDATE time_entries SET clock_out=? WHERE id=?",
            (out_dt.isoformat(timespec="seconds"), open_entry["id"]),
        )
        conn.commit()
        conn.close()
        return jsonify(ok=True, action="out", name=emp["name"],
                       time=out_dt.strftime("%-I:%M %p"))

    # ----- CLOCK IN (must be within the scheduled window) -----
    sched = schedule_for(conn, emp_id, now.date())
    if not sched:
        conn.close()
        return jsonify(ok=False,
                       message=f"{emp['name']} is not scheduled to work today.")

    start_dt = combine(now.date(), sched["start_time"])
    end_dt = shift_end(now.date(), sched["start_time"], sched["end_time"])

    if now < start_dt - timedelta(minutes=EARLY_GRACE_MIN):
        conn.close()
        return jsonify(ok=False,
                       message=f"Too early — shift starts at {start_dt.strftime('%-I:%M %p')}.")
    if now >= end_dt:
        conn.close()
        return jsonify(ok=False,
                       message=f"Shift already ended at {end_dt.strftime('%-I:%M %p')}.")

    clock_in = max(now, start_dt)  # never start the clock before the shift
    conn.execute(
        "INSERT INTO time_entries (employee_id, clock_in) VALUES (?, ?)",
        (emp_id, clock_in.isoformat(timespec="seconds")),
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
        sched = schedule_for(conn, e["employee_id"], cin.date())
        if not sched:
            continue
        end_dt = shift_end(cin.date(), sched["start_time"], sched["end_time"])
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
    total_owed = round(sum(e["owed"] for e in employees), 2)
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
        all_owed=round(sum(e["owed"] for e in alltime), 2),
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
    entries = [
        {
            "id": r["id"],
            "clock_in": r["clock_in"],
            "clock_out": r["clock_out"],
            "hours": fmt_hours(entry_seconds(r, now)),
            "open": r["clock_out"] is None,
        }
        for r in rows
    ]
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
        "SELECT weekday, start_time, end_time FROM schedules WHERE employee_id=?",
        (emp_id,),
    ).fetchall()
    conn.close()
    by_day = {r["weekday"]: (r["start_time"], r["end_time"]) for r in rows}
    days = [
        {
            "idx": i,
            "name": DAYS[i],
            "working": i in by_day,
            "start": by_day.get(i, ("09:00", "17:00"))[0],
            "end": by_day.get(i, ("09:00", "17:00"))[1],
        }
        for i in range(7)
    ]
    return render_template(
        "schedule.html", emp=emp, days=days,
        grace=EARLY_GRACE_MIN, overtime=OVERTIME_GRACE_MIN,
    )


@app.post("/admin/employee/<int:emp_id>/schedule")
@admin_required
def save_schedule(emp_id):
    conn = db.get_db()
    conn.execute("DELETE FROM schedules WHERE employee_id=?", (emp_id,))
    skipped = 0
    for i in range(7):
        if not request.form.get(f"work_{i}"):
            continue
        start = request.form.get(f"start_{i}")
        end = request.form.get(f"end_{i}")
        # end <= start means an overnight shift (ends next day); only equal or
        # missing times are invalid. Previously overnight shifts were silently
        # dropped here.
        if start and end and start != end:
            conn.execute(
                "INSERT INTO schedules (employee_id, weekday, start_time, end_time) "
                "VALUES (?,?,?,?)",
                (emp_id, i, start, end),
            )
        else:
            skipped += 1
    conn.commit()
    conn.close()
    if skipped:
        flash(f"Schedule saved, but {skipped} day(s) were skipped — start and end "
              "times can't be the same.", "error")
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

    conn = db.get_db()
    conn.execute(
        "INSERT INTO payments (employee_id, amount, tip, paid_at, note) VALUES (?,?,?,?,?)",
        (emp_id, amount, tip, db.now_iso(), note),
    )
    conn.commit()
    conn.close()
    paid_msg = f"${amount:.2f}" + (f" + ${tip:.2f} tip" if tip else "")
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


@app.get("/admin/employee/<int:emp_id>/week")
@admin_required
def employee_week(emp_id):
    """Fill or edit a whole week of time entries at once.

    Each day is pre-filled in priority order: an existing single entry, else
    the employee's weekly schedule, else blank. Days with more than one entry
    are locked here (edited individually on the Entries page) so a bulk save
    can never clobber a split shift.
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
    days = []
    for i in range(7):
        d = monday + timedelta(days=i)
        rows = by_day.get(d, [])
        sched = schedule_for(conn, emp_id, d)
        info = {"idx": i, "date": d.isoformat(), "label": d.strftime("%a %b %-d"),
                "count": len(rows), "locked": False}
        if len(rows) == 1:
            cin = datetime.fromisoformat(rows[0]["clock_in"])
            cout = datetime.fromisoformat(rows[0]["clock_out"]) if rows[0]["clock_out"] else None
            info.update(working=True, start=cin.strftime("%H:%M"),
                        end=cout.strftime("%H:%M") if cout else "")
        elif len(rows) > 1:
            info.update(working=True, locked=True, start="", end="")
        elif sched:
            info.update(working=True, start=sched["start_time"], end=sched["end_time"])
        else:
            info.update(working=False, start="09:00", end="17:00")
        days.append(info)
    conn.close()

    return render_template(
        "week.html", emp=emp, days=days, wk_start=monday, wk_end=sunday,
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
    try:
        monday = datetime.fromisoformat(week_start).date()
    except ValueError:
        monday = week_bounds()[0]

    by_day = _entries_by_day(conn, emp_id)
    created = updated = deleted = skipped = 0
    for i in range(7):
        d = monday + timedelta(days=i)
        rows = by_day.get(d, [])
        if not request.form.get(f"work_{i}"):
            # Unchecking a day removes its single entry (multi-entry days are
            # locked in the form and never reach here unchecked).
            if len(rows) == 1:
                conn.execute("DELETE FROM time_entries WHERE id=?", (rows[0]["id"],))
                deleted += 1
            continue
        start = request.form.get(f"start_{i}")
        end = request.form.get(f"end_{i}")
        # Never touch days with multiple entries, or rows with equal/missing
        # times. end < start is fine — it's an overnight shift (ends next day).
        if len(rows) > 1 or not (start and end) or start == end:
            skipped += 1
            continue
        cin = combine(d, start).isoformat(timespec="seconds")
        cout = shift_end(d, start, end).isoformat(timespec="seconds")
        if len(rows) == 1:
            conn.execute("UPDATE time_entries SET clock_in=?, clock_out=? WHERE id=?",
                         (cin, cout, rows[0]["id"]))
            updated += 1
        else:
            conn.execute(
                "INSERT INTO time_entries (employee_id, clock_in, clock_out) VALUES (?,?,?)",
                (emp_id, cin, cout))
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
        parts.append(f"{skipped} skipped (bad times or multiple entries)")
    flash("Week saved — " + (", ".join(parts) if parts else "no changes") + ".", "ok")
    return redirect(url_for("employee_week", emp_id=emp_id, start=week_start))


if __name__ == "__main__":
    db.init_db()
    threading.Thread(target=auto_clockout_loop, daemon=True).start()
    port = int(os.environ.get("PORT", "8080"))
    from waitress import serve

    print(f"TimeKeeper running on http://{get_lan_ip()}:{port}")
    serve(app, host="0.0.0.0", port=port)
