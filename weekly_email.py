#!/usr/bin/env python3
"""Email an hours/pay summary with a full database backup attached.

Run daily by a systemd timer (see deploy/timekeeper-daily.timer), which passes
`--this-week` so each morning's email reports this week's hours so far (a fresh
DB backup rides along, so backups are daily). With no flag it reports the
previous full week (Mon-Sun).

SMTP settings are read from environment variables (see deploy/mail.env):
  MAIL_HOST, MAIL_PORT, MAIL_USER, MAIL_PASSWORD, MAIL_TO, MAIL_FROM
"""
import os
import sys
import gzip
import smtplib
import sqlite3
import ssl
import tempfile
from datetime import timedelta
from email.message import EmailMessage

import app as tk  # reuse period_summary / week_bounds (no server starts on import)
import db


def db_snapshot_gz():
    """A gzipped, consistent snapshot of the whole database via SQLite's online
    backup (safe even mid-write). Written to RAM (/dev/shm when available) to
    avoid SD-card wear, then removed. Attached to the weekly email so every send
    doubles as an off-site backup that can restore the entire history."""
    ramdir = "/dev/shm" if os.path.isdir("/dev/shm") else tempfile.gettempdir()
    tmp = os.path.join(ramdir, "tk-backup.db")
    src = sqlite3.connect(db.DB_PATH)
    dst = sqlite3.connect(tmp)
    try:
        with dst:
            src.backup(dst)
    finally:
        src.close()
        dst.close()
    try:
        with open(tmp, "rb") as f:
            return gzip.compress(f.read())
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def report_range(this_week):
    this_mon, _ = tk.week_bounds()
    if this_week:
        return tk.week_bounds()
    start = this_mon - timedelta(days=7)
    return start, start + timedelta(days=6)


def build(week_rows, alltime_by_id):
    """Merge the week's hours/pay with each employee's running paid/owed totals."""
    rows = []
    for w in week_rows:
        if not (w["active"] or w["hours"] > 0):
            continue
        a = alltime_by_id.get(w["id"], {})
        rows.append({**w, "paid": a.get("paid", 0.0), "owed": a.get("owed", 0.0),
                     "tips": a.get("tips", 0.0)})
    totals = {
        "hours": round(sum(r["hours"] for r in rows), 2),
        "pay": round(sum(r["pay"] for r in rows), 2),
        "paid": round(sum(r["paid"] for r in rows), 2),
        "owed": round(sum(r["owed"] for r in rows), 2),
        "tips": round(sum(r["tips"] for r in rows), 2),
    }
    return rows, totals


def render_text(start, end, rows, t):
    lines = [
        "TimeKeeper — Daily Summary",
        f"Week of {start:%b %d} – {end:%b %d, %Y}",
        "(Hours and Earned are for this week; Paid, Owed and Tips are running totals.)",
        "",
        f"{'Employee':<16}{'Hours':>7}{'Earned':>10}{'Paid':>10}{'Owed':>10}{'Tips':>10}",
        "-" * 63,
    ]
    for r in rows:
        lines.append(
            f"{r['name']:<16}{r['hours']:>7.2f}{('$%.2f' % r['pay']):>10}"
            f"{('$%.2f' % r['paid']):>10}{('$%.2f' % r['owed']):>10}{('$%.2f' % r['tips']):>10}"
        )
    lines += [
        "-" * 63,
        f"{'TOTAL':<16}{t['hours']:>7.2f}{('$%.2f' % t['pay']):>10}"
        f"{('$%.2f' % t['paid']):>10}{('$%.2f' % t['owed']):>10}{('$%.2f' % t['tips']):>10}",
    ]
    return "\n".join(lines)


def render_html(start, end, rows, t):
    body = "".join(
        f"<tr><td style='padding:6px 12px'>{r['name']}</td>"
        f"<td style='padding:6px 12px;text-align:right'>{r['hours']:.2f}</td>"
        f"<td style='padding:6px 12px;text-align:right'>${r['pay']:.2f}</td>"
        f"<td style='padding:6px 12px;text-align:right'>${r['paid']:.2f}</td>"
        f"<td style='padding:6px 12px;text-align:right;font-weight:bold'>${r['owed']:.2f}</td>"
        f"<td style='padding:6px 12px;text-align:right'>${r['tips']:.2f}</td></tr>"
        for r in rows
    )
    return f"""\
<div style="font-family:Arial,sans-serif;color:#0f172a">
  <h2 style="margin:0 0 4px">TimeKeeper — Daily Summary</h2>
  <p style="margin:0 0 4px;color:#475569">Week of {start:%b %d} – {end:%b %d, %Y}</p>
  <p style="margin:0 0 16px;color:#94a3b8;font-size:13px">Hours and Earned are for this week; Paid and Owed are running totals.</p>
  <table style="border-collapse:collapse;min-width:600px">
    <thead><tr style="background:#1e293b;color:#fff">
      <th style="padding:8px 12px;text-align:left">Employee</th>
      <th style="padding:8px 12px;text-align:right">Hours</th>
      <th style="padding:8px 12px;text-align:right">Earned</th>
      <th style="padding:8px 12px;text-align:right">Paid</th>
      <th style="padding:8px 12px;text-align:right">Owed</th>
      <th style="padding:8px 12px;text-align:right">Tips</th>
    </tr></thead>
    <tbody>{body}</tbody>
    <tfoot><tr style="font-weight:bold;border-top:2px solid #cbd5e1">
      <td style="padding:8px 12px">TOTAL</td>
      <td style="padding:8px 12px;text-align:right">{t['hours']:.2f}</td>
      <td style="padding:8px 12px;text-align:right">${t['pay']:.2f}</td>
      <td style="padding:8px 12px;text-align:right">${t['paid']:.2f}</td>
      <td style="padding:8px 12px;text-align:right">${t['owed']:.2f}</td>
      <td style="padding:8px 12px;text-align:right">${t['tips']:.2f}</td>
    </tr></tfoot>
  </table>
</div>"""


def main():
    this_week = "--this-week" in sys.argv
    start, end = report_range(this_week)
    alltime_by_id = {e["id"]: e for e in tk.summarize_employees()}
    rows, totals = build(tk.period_summary(start, end), alltime_by_id)

    try:
        host = os.environ["MAIL_HOST"]
        user = os.environ["MAIL_USER"]
        password = os.environ["MAIL_PASSWORD"]
    except KeyError as e:
        sys.exit(f"Missing mail setting: {e}. Fill in deploy/mail.env.")
    port = int(os.environ.get("MAIL_PORT", "587"))
    to = os.environ.get("MAIL_TO", user)
    sender = os.environ.get("MAIL_FROM", user)

    msg = EmailMessage()
    msg["Subject"] = f"TimeKeeper hours: {start:%b %d}–{end:%b %d, %Y}"
    msg["From"] = sender
    msg["To"] = to
    msg.set_content(render_text(start, end, rows, totals))
    msg.add_alternative(render_html(start, end, rows, totals), subtype="html")

    # Attach a full DB snapshot so the weekly email doubles as an off-site
    # backup. Best-effort: a backup failure must never block the summary.
    try:
        msg.add_attachment(db_snapshot_gz(), maintype="application", subtype="gzip",
                           filename=f"timekeeper-{end:%Y-%m-%d}.db.gz")
    except Exception as exc:
        print(f"warning: could not attach DB backup: {exc}")

    context = ssl.create_default_context()
    with smtplib.SMTP(host, port, timeout=30) as s:
        s.starttls(context=context)
        s.login(user, password)
        s.send_message(msg)
    print(f"Sent summary for {start}–{end} to {to}")


if __name__ == "__main__":
    main()
