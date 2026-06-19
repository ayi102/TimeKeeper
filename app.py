"""TimeKeeper - a touchscreen time clock for in-home care workers.

Two surfaces:
  /        kiosk: shown full-screen on the Pi. Workers tap a name and clock in/out.
  /admin   management: opened from a phone/laptop. PIN-gated. Manage employees,
           hourly rates, view accrued pay, and fix time entries.
"""
import os
import socket
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

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


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
    payments = conn.execute("SELECT employee_id, amount FROM payments").fetchall()
    conn.close()

    now = datetime.now()
    by_emp = {}
    for e in entries:
        by_emp.setdefault(e["employee_id"], []).append(e)
    paid_by = {}
    for p in payments:
        paid_by[p["employee_id"]] = paid_by.get(p["employee_id"], 0.0) + p["amount"]

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
        # ----- CLOCK OUT (cap at scheduled end so they can't run late) -----
        cin = datetime.fromisoformat(open_entry["clock_in"])
        sched = schedule_for(conn, emp_id, cin.date())
        out_dt = now
        if sched:
            end_dt = combine(cin.date(), sched["end_time"])
            if now > end_dt:
                out_dt = end_dt
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
    end_dt = combine(now.date(), sched["end_time"])

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
        end_dt = combine(cin.date(), sched["end_time"])
        if now >= end_dt:
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
    return render_template(
        "admin.html", employees=employees, grand_total=grand_total,
        total_owed=total_owed, ip=get_lan_ip()
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
    return render_template("schedule.html", emp=emp, days=days, grace=EARLY_GRACE_MIN)


@app.post("/admin/employee/<int:emp_id>/schedule")
@admin_required
def save_schedule(emp_id):
    conn = db.get_db()
    conn.execute("DELETE FROM schedules WHERE employee_id=?", (emp_id,))
    for i in range(7):
        if request.form.get(f"work_{i}"):
            start = request.form.get(f"start_{i}")
            end = request.form.get(f"end_{i}")
            if start and end and end > start:
                conn.execute(
                    "INSERT INTO schedules (employee_id, weekday, start_time, end_time) "
                    "VALUES (?,?,?,?)",
                    (emp_id, i, start, end),
                )
    conn.commit()
    conn.close()
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
    amount = request.form.get("amount") or "0"
    note = (request.form.get("note") or "").strip()
    try:
        amount = round(float(amount), 2)
    except ValueError:
        amount = 0.0
    if amount <= 0:
        flash("Enter a payout amount greater than zero.", "error")
        return redirect(url_for("employee_payments", emp_id=emp_id))

    conn = db.get_db()
    conn.execute(
        "INSERT INTO payments (employee_id, amount, paid_at, note) VALUES (?,?,?,?)",
        (emp_id, amount, db.now_iso(), note),
    )
    conn.commit()
    conn.close()
    flash(f"Recorded payout of ${amount:.2f}.", "ok")
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


if __name__ == "__main__":
    db.init_db()
    threading.Thread(target=auto_clockout_loop, daemon=True).start()
    port = int(os.environ.get("PORT", "8080"))
    from waitress import serve

    print(f"TimeKeeper running on http://{get_lan_ip()}:{port}")
    serve(app, host="0.0.0.0", port=port)
