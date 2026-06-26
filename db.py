"""SQLite storage for TimeKeeper."""
import os
import sqlite3
from datetime import datetime

DB_PATH = os.environ.get(
    "TIMEKEEPER_DB",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "timekeeper.db"),
)


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS employees (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT    NOT NULL,
            hourly_rate REAL    NOT NULL DEFAULT 0,
            active      INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS time_entries (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id INTEGER NOT NULL,
            clock_in    TEXT    NOT NULL,   -- ISO 8601 local time
            clock_out   TEXT,               -- NULL while clocked in
            FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
        );
        -- A recorded payout to an employee. `amount` is wages (reduces what's
        -- owed); `tip` is extra money passed through on top of wages.
        CREATE TABLE IF NOT EXISTS payments (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id INTEGER NOT NULL,
            amount      REAL    NOT NULL,
            tip         REAL    NOT NULL DEFAULT 0,
            paid_at     TEXT    NOT NULL,   -- ISO 8601 local time
            note        TEXT,
            FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
        );
        -- One row per worked weekday. A missing weekday means "off that day".
        CREATE TABLE IF NOT EXISTS schedules (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id INTEGER NOT NULL,
            weekday     INTEGER NOT NULL,   -- 0=Mon ... 6=Sun (Python weekday())
            start_time  TEXT    NOT NULL,   -- "HH:MM" 24h
            end_time    TEXT    NOT NULL,   -- "HH:MM" 24h
            UNIQUE(employee_id, weekday),
            FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
        );
        """
    )
    _migrate(conn)
    conn.commit()
    conn.close()


def _migrate(conn):
    """Apply schema changes to databases created before a column was added.
    CREATE TABLE IF NOT EXISTS never alters an existing table, so add-column
    upgrades have to be done explicitly and idempotently here."""
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(payments)")}
    if "tip" not in cols:
        conn.execute("ALTER TABLE payments ADD COLUMN tip REAL NOT NULL DEFAULT 0")


def now_iso():
    """Current local time as a seconds-precision ISO string."""
    return datetime.now().isoformat(timespec="seconds")
