package com.ayi102.timekeeper

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.ayi102.timekeeper.core.Shift

/** A worker shown on the kiosk. */
data class Emp(val id: Long, val name: String, val clockedIn: Boolean)

/** An open (not-yet-clocked-out) time entry. */
data class OpenEntry(val id: Long, val clockIn: String)

/**
 * Built-in SQLite storage (no Room / no annotation processors). Schema mirrors
 * the Python app: clock_out NULL means still clocked in; actual_in/out hold the
 * raw taps; a weekday may have several schedule rows; tips are separate.
 */
class Db(context: Context) : SQLiteOpenHelper(context, "timekeeper.db", null, 1) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE employees (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 name TEXT NOT NULL,
                 hourly_rate REAL NOT NULL DEFAULT 0,
                 active INTEGER NOT NULL DEFAULT 1)"""
        )
        db.execSQL(
            """CREATE TABLE time_entries (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 employee_id INTEGER NOT NULL,
                 clock_in TEXT NOT NULL,
                 clock_out TEXT,
                 actual_in TEXT,
                 actual_out TEXT)"""
        )
        db.execSQL(
            """CREATE TABLE schedules (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 employee_id INTEGER NOT NULL,
                 weekday INTEGER NOT NULL,
                 start_time TEXT NOT NULL,
                 end_time TEXT NOT NULL)"""
        )
        db.execSQL("CREATE INDEX idx_sched_emp_wd ON schedules(employee_id, weekday)")
        db.execSQL(
            """CREATE TABLE payments (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 employee_id INTEGER NOT NULL,
                 amount REAL NOT NULL,
                 tip REAL NOT NULL DEFAULT 0,
                 paid_at TEXT NOT NULL,
                 note TEXT)"""
        )
        db.execSQL(
            """CREATE TABLE clockin_alerts (
                 employee_id INTEGER NOT NULL,
                 shift_date TEXT NOT NULL,
                 sent_at TEXT NOT NULL,
                 UNIQUE(employee_id, shift_date))"""
        )
        seed(db)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // Fresh app for now; real migrations arrive with later phases.
    }

    private fun seed(db: SQLiteDatabase) {
        fun emp(name: String, rate: Double): Long =
            db.insert("employees", null, ContentValues().apply {
                put("name", name); put("hourly_rate", rate)
            })
        fun shift(empId: Long, wd: Int, s: String, e: String) =
            db.insert("schedules", null, ContentValues().apply {
                put("employee_id", empId); put("weekday", wd)
                put("start_time", s); put("end_time", e)
            })

        val kay = emp("Kay", 18.0)
        val louncia = emp("Louncia", 18.0)
        val stacy = emp("Stacy", 20.0)
        for (wd in 0..4) {
            shift(stacy, wd, "07:00", "18:00")
            shift(kay, wd, "18:00", "00:00")
            shift(louncia, wd, "00:00", "07:00")
        }
    }

    /** Active workers with whether they're currently clocked in. */
    fun employees(): List<Emp> {
        val out = ArrayList<Emp>()
        readableDatabase.rawQuery(
            """SELECT e.id, e.name,
                      EXISTS(SELECT 1 FROM time_entries t
                             WHERE t.employee_id = e.id AND t.clock_out IS NULL) AS in_now
                 FROM employees e WHERE e.active = 1
                 ORDER BY e.name COLLATE NOCASE""", null
        ).use { c ->
            while (c.moveToNext()) out.add(Emp(c.getLong(0), c.getString(1), c.getInt(2) == 1))
        }
        return out
    }

    fun name(empId: Long): String? =
        readableDatabase.rawQuery(
            "SELECT name FROM employees WHERE id = ? AND active = 1", arrayOf(empId.toString())
        ).use { if (it.moveToFirst()) it.getString(0) else null }

    fun openEntry(empId: Long): OpenEntry? =
        readableDatabase.rawQuery(
            "SELECT id, clock_in FROM time_entries WHERE employee_id = ? AND clock_out IS NULL LIMIT 1",
            arrayOf(empId.toString())
        ).use { if (it.moveToFirst()) OpenEntry(it.getLong(0), it.getString(1)) else null }

    /** Shifts for a worker on a given weekday (0=Mon..6=Sun), earliest first. */
    fun schedulesFor(empId: Long, weekday: Int): List<Shift> {
        val out = ArrayList<Shift>()
        readableDatabase.rawQuery(
            """SELECT start_time, end_time FROM schedules
                 WHERE employee_id = ? AND weekday = ? ORDER BY start_time""",
            arrayOf(empId.toString(), weekday.toString())
        ).use { c -> while (c.moveToNext()) out.add(Shift(c.getString(0), c.getString(1))) }
        return out
    }

    fun insertClockIn(empId: Long, clockIn: String, actualIn: String): Long =
        writableDatabase.insert("time_entries", null, ContentValues().apply {
            put("employee_id", empId); put("clock_in", clockIn); put("actual_in", actualIn)
        })

    fun closeEntry(id: Long, clockOut: String, actualOut: String) {
        writableDatabase.update("time_entries", ContentValues().apply {
            put("clock_out", clockOut); put("actual_out", actualOut)
        }, "id = ?", arrayOf(id.toString()))
    }
}
