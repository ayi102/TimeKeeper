#!/usr/bin/env python3
"""Email an alert when a scheduled worker hasn't clocked in.

Run every few minutes by a systemd timer (see deploy/missed-clockin.timer). For
each active employee scheduled today, if the scheduled start passed more than
MISSED_CLOCKIN_MIN minutes ago, they still haven't clocked in, and we haven't
already alerted for that shift, send one email and record it so it never repeats.

SMTP settings come from the same env as the weekly email (deploy/mail.env):
  MAIL_HOST, MAIL_PORT, MAIL_USER, MAIL_PASSWORD, MAIL_TO, MAIL_FROM
"""
import os
import sys
import ssl
import smtplib
from datetime import datetime, timedelta
from email.message import EmailMessage

import app as tk
import db


def find_missed(conn, now):
    """Employees who should be clocked in by now for today's shift but aren't."""
    missed = []
    today = now.date().isoformat()
    for e in conn.execute("SELECT id, name FROM employees WHERE active=1").fetchall():
        sched = tk.schedule_for(conn, e["id"], now.date())
        if not sched:
            continue
        start = tk.combine(now.date(), sched["start_time"])
        end = tk.shift_end(now.date(), sched["start_time"], sched["end_time"])
        # Only within the shift, once the grace period past the start has passed.
        if not (start + timedelta(minutes=tk.MISSED_CLOCKIN_MIN) <= now < end):
            continue
        clocked_in = conn.execute(
            "SELECT 1 FROM time_entries WHERE employee_id=? AND substr(clock_in,1,10)=? LIMIT 1",
            (e["id"], today),
        ).fetchone()
        if clocked_in:
            continue
        already = conn.execute(
            "SELECT 1 FROM clockin_alerts WHERE employee_id=? AND shift_date=?",
            (e["id"], today),
        ).fetchone()
        if already:
            continue
        missed.append({"id": e["id"], "name": e["name"],
                       "start": tk.combine(now.date(), sched["start_time"])})
    return missed


def send_alert(rows, now):
    host = os.environ["MAIL_HOST"]
    user = os.environ["MAIL_USER"]
    password = os.environ["MAIL_PASSWORD"]
    port = int(os.environ.get("MAIL_PORT", "587"))
    to = os.environ.get("MAIL_TO", user)
    sender = os.environ.get("MAIL_FROM", user)

    who = ", ".join(r["name"] for r in rows)
    lines = ["TimeKeeper — missed clock-in", ""]
    for r in rows:
        lines.append(f"  {r['name']} was scheduled to start at "
                     f"{r['start'].strftime('%-I:%M %p')} and has not clocked in "
                     f"(as of {now.strftime('%-I:%M %p')}).")
    msg = EmailMessage()
    msg["Subject"] = f"TimeKeeper: {who} missed clock-in"
    msg["From"] = sender
    msg["To"] = to
    msg.set_content("\n".join(lines))

    context = ssl.create_default_context()
    with smtplib.SMTP(host, port, timeout=30) as s:
        s.starttls(context=context)
        s.login(user, password)
        s.send_message(msg)


def main():
    now = datetime.now()
    conn = db.get_db()
    missed = find_missed(conn, now)
    if not missed:
        conn.close()
        return
    try:
        send_alert(missed, now)
    except Exception as exc:  # don't record the alert if the email didn't send
        conn.close()
        sys.exit(f"missed-clock-in email failed: {exc}")
    for r in missed:
        conn.execute(
            "INSERT OR IGNORE INTO clockin_alerts (employee_id, shift_date, sent_at) "
            "VALUES (?,?,?)",
            (r["id"], now.date().isoformat(), db.now_iso()),
        )
    conn.commit()
    conn.close()
    print(f"Alerted missed clock-in: {', '.join(r['name'] for r in missed)}")


if __name__ == "__main__":
    main()
