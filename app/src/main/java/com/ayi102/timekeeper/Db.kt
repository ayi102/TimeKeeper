package com.ayi102.timekeeper

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.ayi102.timekeeper.core.Money
import com.ayi102.timekeeper.core.Shift
import com.ayi102.timekeeper.core.Times
import java.time.Duration
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime

/** A worker shown on the kiosk. */
data class Emp(val id: Long, val name: String, val clockedIn: Boolean)

/** An open (not-yet-clocked-out) time entry. */
data class OpenEntry(val id: Long, val clockIn: String)

/** Per-worker rollup for the admin summary. */
data class Summary(
    val id: Long, val name: String, val hours: Double, val pay: Double,
    val paid: Double, val owed: Double, val owedDue: Double, val tips: Double,
)

/** A worker as shown on the admin management list. */
data class EmpAdmin(val id: Long, val name: String, val rate: Double, val active: Boolean)

/** One recorded payout. */
data class Payment(val id: Long, val paidAt: String, val amount: Double, val tip: Double, val note: String)

/** One time-clock record for the timesheet view (hours computed to `now` if still open). */
data class EntryRow(val id: Long, val clockIn: String, val clockOut: String?, val hours: Double, val open: Boolean)

/** Money state for one worker (for the payouts screen). */
data class Finance(
    val name: String, val earned: Double, val paid: Double,
    val owed: Double, val owedDue: Double, val tips: Double,
)

/** One scheduled dose: a weekday (0=Mon..6=Sun) and a time ("HH:MM"). */
data class MedSlot(val weekday: Int, val time: String)

/** A medication and the weekday/time slots it should be given on. */
data class Med(val id: Long, val name: String, val dose: String, val active: Boolean, val slots: List<MedSlot>)

/** A medication whose scheduled time just arrived (for the kiosk reminder). */
data class DueMed(val name: String, val dose: String)

/**
 * Built-in SQLite storage (no Room / no annotation processors). Schema mirrors
 * the Python app: clock_out NULL means still clocked in; actual_in/out hold the
 * raw taps; a weekday may have several schedule rows; tips are separate.
 */
class Db(private val ctx: Context) : SQLiteOpenHelper(ctx, "timekeeper.db", null, 3) {

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
        createMedTables(db)
        seed(db)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // v2 added the medication-reminder tables; v3 added per-weekday scheduling.
        if (oldVersion < 2) createMedTables(db)
        if (oldVersion < 3) ensureWeekdayColumn(db)
    }

    /** Medication schedule + per-day "already reminded" dedup. Idempotent (IF NOT EXISTS). */
    private fun createMedTables(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE IF NOT EXISTS medications (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 name TEXT NOT NULL,
                 dose TEXT NOT NULL DEFAULT '',
                 active INTEGER NOT NULL DEFAULT 1)"""
        )
        db.execSQL(
            """CREATE TABLE IF NOT EXISTS med_times (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 medication_id INTEGER NOT NULL,
                 weekday INTEGER NOT NULL DEFAULT 0,
                 time_of_day TEXT NOT NULL)"""
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_medtime_med ON med_times(medication_id)")
        db.execSQL(
            """CREATE TABLE IF NOT EXISTS med_fired (
                 med_time_id INTEGER NOT NULL,
                 fired_date TEXT NOT NULL,
                 UNIQUE(med_time_id, fired_date))"""
        )
    }

    /** Add the weekday column to a med_times table created before v3 (a no-op otherwise). */
    private fun ensureWeekdayColumn(db: SQLiteDatabase) {
        val hasWeekday = db.rawQuery("PRAGMA table_info(med_times)", null).use { c ->
            var found = false
            while (c.moveToNext()) if (c.getString(1) == "weekday") { found = true; break }
            found
        }
        if (!hasWeekday)
            db.execSQL("ALTER TABLE med_times ADD COLUMN weekday INTEGER NOT NULL DEFAULT 0")
    }

    /** A gzipped, consistent snapshot of the whole database (for the backup email). */
    fun snapshotGzip(): ByteArray {
        // Flush any WAL into the main file so a plain copy is complete.
        writableDatabase.rawQuery("PRAGMA wal_checkpoint(FULL)", null).use { it.moveToFirst() }
        val raw = ctx.getDatabasePath("timekeeper.db").readBytes()
        val bos = java.io.ByteArrayOutputStream()
        java.util.zip.GZIPOutputStream(bos).use { it.write(raw) }
        return bos.toByteArray()
    }

    /**
     * Replace the entire database with [dbBytes] (a raw SQLite file, e.g. from a
     * backup). Returns a short summary. Stamps user_version to match this helper
     * so it reopens as an existing DB (no onCreate/onUpgrade, no re-seed).
     */
    fun restoreFrom(dbBytes: ByteArray): String {
        require(dbBytes.size >= 16 && String(dbBytes, 0, 15, Charsets.US_ASCII) == "SQLite format 3") {
            "That file is not a SQLite database."
        }
        close()  // drop the open connection before swapping the file
        val dbFile = ctx.getDatabasePath("timekeeper.db")
        dbFile.parentFile?.mkdirs()
        dbFile.writeBytes(dbBytes)
        java.io.File(dbFile.path + "-wal").delete()
        java.io.File(dbFile.path + "-shm").delete()
        java.io.File(dbFile.path + "-journal").delete()
        SQLiteDatabase.openDatabase(dbFile.path, null, SQLiteDatabase.OPEN_READWRITE).use { raw ->
            // A backup may predate v2 (no med tables) — add them, then stamp the
            // current version so it reopens without onCreate/onUpgrade or a re-seed.
            createMedTables(raw)
            ensureWeekdayColumn(raw)
            raw.execSQL("PRAGMA user_version = 3")
        }
        val db = readableDatabase
        fun count(t: String) = db.rawQuery("SELECT count(*) FROM $t", null).use { it.moveToFirst(); it.getInt(0) }
        return "Restored ${count("employees")} workers, ${count("time_entries")} time entries, ${count("payments")} payments."
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

    /** All workers (active first) for the admin management list. */
    fun employeesAdmin(): List<EmpAdmin> {
        val out = ArrayList<EmpAdmin>()
        readableDatabase.rawQuery(
            "SELECT id, name, hourly_rate, active FROM employees ORDER BY active DESC, name COLLATE NOCASE", null
        ).use { c ->
            while (c.moveToNext())
                out.add(EmpAdmin(c.getLong(0), c.getString(1), c.getDouble(2), c.getInt(3) == 1))
        }
        return out
    }

    fun addEmployee(name: String, rate: Double): Long =
        writableDatabase.insert("employees", null, ContentValues().apply {
            put("name", name); put("hourly_rate", rate)
        })

    fun updateEmployee(id: Long, name: String, rate: Double) {
        writableDatabase.update("employees", ContentValues().apply {
            put("name", name); put("hourly_rate", rate)
        }, "id = ?", arrayOf(id.toString()))
    }

    fun setActive(id: Long, active: Boolean) {
        writableDatabase.update("employees", ContentValues().apply {
            put("active", if (active) 1 else 0)
        }, "id = ?", arrayOf(id.toString()))
    }

    /** Permanently remove a worker AND all their entries/payments/schedules. */
    fun deleteEmployee(id: Long) {
        val db = writableDatabase
        val a = arrayOf(id.toString())
        db.beginTransaction()
        try {
            db.delete("time_entries", "employee_id = ?", a)
            db.delete("payments", "employee_id = ?", a)
            db.delete("schedules", "employee_id = ?", a)
            db.delete("clockin_alerts", "employee_id = ?", a)
            db.delete("employees", "id = ?", a)
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    /** Everything the admin summary needs: hours, pay, paid, owed, owed-due, tips. */
    fun summarize(now: LocalDateTime): List<Summary> {
        data class E(val id: Long, val name: String, val rate: Double)
        val emps = ArrayList<E>()
        // All workers (active first) — like the Pi. A deactivated worker who is
        // still owed money must stay visible on the summary and backup email.
        readableDatabase.rawQuery(
            "SELECT id, name, hourly_rate FROM employees ORDER BY active DESC, name COLLATE NOCASE", null
        ).use { c -> while (c.moveToNext()) emps.add(E(c.getLong(0), c.getString(1), c.getDouble(2))) }

        val secs = HashMap<Long, Double>()
        readableDatabase.rawQuery("SELECT employee_id, clock_in, clock_out FROM time_entries", null).use { c ->
            while (c.moveToNext()) {
                val id = c.getLong(0)
                val start = Times.parse(c.getString(1))
                val end = if (c.isNull(2)) now else Times.parse(c.getString(2))
                val s = Duration.between(start, end).seconds.toDouble().coerceAtLeast(0.0)
                secs[id] = (secs[id] ?: 0.0) + s
            }
        }
        val paidM = HashMap<Long, Double>(); val tipM = HashMap<Long, Double>()
        readableDatabase.rawQuery("SELECT employee_id, amount, tip FROM payments", null).use { c ->
            while (c.moveToNext()) {
                val id = c.getLong(0)
                paidM[id] = (paidM[id] ?: 0.0) + c.getDouble(1)
                tipM[id] = (tipM[id] ?: 0.0) + c.getDouble(2)
            }
        }
        return emps.map { e ->
            val hours = Money.hours(secs[e.id] ?: 0.0)
            val pay = Money.pay(hours, e.rate)
            val paid = Money.round2(paidM[e.id] ?: 0.0)
            val owed = Money.round2(pay - paid)
            Summary(e.id, e.name, hours, pay, paid, owed, Money.owedDue(owed), Money.round2(tipM[e.id] ?: 0.0))
        }
    }

    /** Money state for a single worker. */
    fun financeFor(empId: Long, now: LocalDateTime): Finance? {
        var name: String? = null; var rate = 0.0
        readableDatabase.rawQuery("SELECT name, hourly_rate FROM employees WHERE id = ?", arrayOf(empId.toString())).use { c ->
            if (c.moveToFirst()) { name = c.getString(0); rate = c.getDouble(1) }
        }
        if (name == null) return null
        var secs = 0.0
        readableDatabase.rawQuery("SELECT clock_in, clock_out FROM time_entries WHERE employee_id = ?", arrayOf(empId.toString())).use { c ->
            while (c.moveToNext()) {
                val start = Times.parse(c.getString(0))
                val end = if (c.isNull(1)) now else Times.parse(c.getString(1))
                secs += Duration.between(start, end).seconds.toDouble().coerceAtLeast(0.0)
            }
        }
        var paid = 0.0; var tips = 0.0
        readableDatabase.rawQuery("SELECT amount, tip FROM payments WHERE employee_id = ?", arrayOf(empId.toString())).use { c ->
            while (c.moveToNext()) { paid += c.getDouble(0); tips += c.getDouble(1) }
        }
        val hours = Money.hours(secs)
        val pay = Money.pay(hours, rate)
        val owed = Money.round2(pay - Money.round2(paid))
        return Finance(name!!, pay, Money.round2(paid), owed, Money.owedDue(owed), Money.round2(tips))
    }

    fun payments(empId: Long): List<Payment> {
        val out = ArrayList<Payment>()
        readableDatabase.rawQuery(
            "SELECT id, paid_at, amount, tip, COALESCE(note,'') FROM payments WHERE employee_id = ? ORDER BY paid_at DESC",
            arrayOf(empId.toString())
        ).use { c ->
            while (c.moveToNext())
                out.add(Payment(c.getLong(0), c.getString(1), c.getDouble(2), c.getDouble(3), c.getString(4)))
        }
        return out
    }

    fun addPayment(empId: Long, amount: Double, tip: Double, note: String) {
        writableDatabase.insert("payments", null, ContentValues().apply {
            put("employee_id", empId); put("amount", amount); put("tip", tip)
            put("paid_at", Times.format(Times.now())); put("note", note)
        })
    }

    fun deletePayment(id: Long) {
        writableDatabase.delete("payments", "id = ?", arrayOf(id.toString()))
    }

    /** All time entries for a worker, newest first, with hours computed (to `now` if open). */
    fun entriesFor(empId: Long, now: LocalDateTime): List<EntryRow> {
        val out = ArrayList<EntryRow>()
        readableDatabase.rawQuery(
            "SELECT id, clock_in, clock_out FROM time_entries WHERE employee_id = ? ORDER BY clock_in DESC",
            arrayOf(empId.toString())
        ).use { c ->
            while (c.moveToNext()) {
                val cin = c.getString(1)
                val cout = if (c.isNull(2)) null else c.getString(2)
                val end = if (cout != null) Times.parse(cout) else now
                val s = Duration.between(Times.parse(cin), end).seconds.toDouble().coerceAtLeast(0.0)
                out.add(EntryRow(c.getLong(0), cin, cout, Money.hours(s), cout == null))
            }
        }
        return out
    }

    /** Add a manual time entry. clockOut null = still clocked in. */
    fun addEntry(empId: Long, clockIn: String, clockOut: String?): Long =
        writableDatabase.insert("time_entries", null, ContentValues().apply {
            put("employee_id", empId)
            put("clock_in", clockIn); put("actual_in", clockIn)
            if (clockOut != null) { put("clock_out", clockOut); put("actual_out", clockOut) }
        })

    /** Edit an entry's paid clock-in/out. clockOut null re-opens it. Raw actual_* taps are left as-is. */
    fun updateEntry(id: Long, clockIn: String, clockOut: String?) {
        writableDatabase.update("time_entries", ContentValues().apply {
            put("clock_in", clockIn)
            if (clockOut != null) put("clock_out", clockOut) else putNull("clock_out")
        }, "id = ?", arrayOf(id.toString()))
    }

    fun deleteEntry(id: Long) {
        writableDatabase.delete("time_entries", "id = ?", arrayOf(id.toString()))
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

    /** Every open entry across all workers, as (id, employeeId, clockIn) — for auto-clockout. */
    fun openEntries(): List<Triple<Long, Long, String>> {
        val out = ArrayList<Triple<Long, Long, String>>()
        readableDatabase.rawQuery(
            "SELECT id, employee_id, clock_in FROM time_entries WHERE clock_out IS NULL", null
        ).use { c -> while (c.moveToNext()) out.add(Triple(c.getLong(0), c.getLong(1), c.getString(2))) }
        return out
    }

    /** Auto-close a forgotten entry at the scheduled end. Leaves actual_out NULL (never tapped out). */
    fun autoClose(id: Long, clockOut: String) {
        writableDatabase.update("time_entries", ContentValues().apply { put("clock_out", clockOut) },
            "id = ?", arrayOf(id.toString()))
    }

    /** Per-worker worked seconds for entries whose clock-in DATE is in [start, end] (open → to now). */
    fun periodSeconds(start: LocalDate, end: LocalDate, now: LocalDateTime): Map<Long, Double> {
        val out = HashMap<Long, Double>()
        readableDatabase.rawQuery("SELECT employee_id, clock_in, clock_out FROM time_entries", null).use { c ->
            while (c.moveToNext()) {
                val cin = Times.parse(c.getString(1))
                val d = cin.toLocalDate()
                if (d < start || d > end) continue
                val endDt = if (c.isNull(2)) now else Times.parse(c.getString(2))
                val s = Duration.between(cin, endDt).seconds.toDouble().coerceAtLeast(0.0)
                out[c.getLong(0)] = (out[c.getLong(0)] ?: 0.0) + s
            }
        }
        return out
    }

    /** Active workers as (id, name) — for the missed-clock-in check. */
    fun activeWorkers(): List<Pair<Long, String>> {
        val out = ArrayList<Pair<Long, String>>()
        readableDatabase.rawQuery("SELECT id, name FROM employees WHERE active = 1", null)
            .use { c -> while (c.moveToNext()) out.add(c.getLong(0) to c.getString(1)) }
        return out
    }

    /** Clock-in datetimes recorded for a worker on a given calendar date. */
    fun clockInsOn(empId: Long, date: LocalDate): List<LocalDateTime> {
        val out = ArrayList<LocalDateTime>()
        readableDatabase.rawQuery(
            "SELECT clock_in FROM time_entries WHERE employee_id = ? AND substr(clock_in,1,10) = ?",
            arrayOf(empId.toString(), date.toString())
        ).use { c -> while (c.moveToNext()) out.add(Times.parse(c.getString(0))) }
        return out
    }

    fun alertExists(empId: Long, shiftKey: String): Boolean =
        readableDatabase.rawQuery(
            "SELECT 1 FROM clockin_alerts WHERE employee_id = ? AND shift_date = ?",
            arrayOf(empId.toString(), shiftKey)
        ).use { it.moveToFirst() }

    fun recordAlert(empId: Long, shiftKey: String, sentAt: String) {
        writableDatabase.insertWithOnConflict("clockin_alerts", null, ContentValues().apply {
            put("employee_id", empId); put("shift_date", shiftKey); put("sent_at", sentAt)
        }, SQLiteDatabase.CONFLICT_IGNORE)
    }

    /** All shifts for a worker as (weekday, start, end) rows, for the editor. */
    fun schedulesOf(empId: Long): List<Triple<Int, String, String>> {
        val out = ArrayList<Triple<Int, String, String>>()
        readableDatabase.rawQuery(
            "SELECT weekday, start_time, end_time FROM schedules WHERE employee_id = ? ORDER BY weekday, start_time",
            arrayOf(empId.toString())
        ).use { c ->
            while (c.moveToNext()) out.add(Triple(c.getInt(0), c.getString(1), c.getString(2)))
        }
        return out
    }

    /** Replace a worker's entire schedule with the given (weekday, start, end) rows. */
    fun replaceSchedules(empId: Long, shifts: List<Triple<Int, String, String>>) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.delete("schedules", "employee_id = ?", arrayOf(empId.toString()))
            for ((wd, s, e) in shifts) {
                db.insert("schedules", null, ContentValues().apply {
                    put("employee_id", empId); put("weekday", wd)
                    put("start_time", s); put("end_time", e)
                })
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

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

    // ----- medication reminders -----

    /** All medications (active first) with their weekday/time slots. */
    fun meds(): List<Med> {
        val db = readableDatabase
        val slotsByMed = HashMap<Long, MutableList<MedSlot>>()
        db.rawQuery("SELECT medication_id, weekday, time_of_day FROM med_times ORDER BY weekday, time_of_day", null).use { c ->
            while (c.moveToNext())
                slotsByMed.getOrPut(c.getLong(0)) { arrayListOf() }.add(MedSlot(c.getInt(1), c.getString(2)))
        }
        val out = ArrayList<Med>()
        db.rawQuery(
            "SELECT id, name, dose, active FROM medications ORDER BY active DESC, name COLLATE NOCASE", null
        ).use { c ->
            while (c.moveToNext()) {
                val id = c.getLong(0)
                out.add(Med(id, c.getString(1), c.getString(2), c.getInt(3) == 1, slotsByMed[id] ?: emptyList()))
            }
        }
        return out
    }

    /** Add or update a medication and replace its schedule slots. Returns the med id. */
    fun saveMed(id: Long?, name: String, dose: String, slots: List<MedSlot>): Long {
        val db = writableDatabase
        db.beginTransaction()
        try {
            val medId = if (id != null) {
                db.update("medications", ContentValues().apply { put("name", name); put("dose", dose) },
                    "id = ?", arrayOf(id.toString()))
                id
            } else {
                db.insert("medications", null, ContentValues().apply {
                    put("name", name); put("dose", dose)
                })
            }
            // Slots get new ids, so clear stale "fired" rows keyed on the old ones.
            db.delete("med_fired", "med_time_id IN (SELECT id FROM med_times WHERE medication_id = ?)", arrayOf(medId.toString()))
            db.delete("med_times", "medication_id = ?", arrayOf(medId.toString()))
            for (s in slots) db.insert("med_times", null, ContentValues().apply {
                put("medication_id", medId); put("weekday", s.weekday); put("time_of_day", s.time)
            })
            db.setTransactionSuccessful()
            return medId
        } finally {
            db.endTransaction()
        }
    }

    fun setMedActive(id: Long, active: Boolean) {
        writableDatabase.update("medications", ContentValues().apply {
            put("active", if (active) 1 else 0)
        }, "id = ?", arrayOf(id.toString()))
    }

    fun deleteMed(id: Long) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.delete("med_fired", "med_time_id IN (SELECT id FROM med_times WHERE medication_id = ?)", arrayOf(id.toString()))
            db.delete("med_times", "medication_id = ?", arrayOf(id.toString()))
            db.delete("medications", "id = ?", arrayOf(id.toString()))
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    /**
     * Medications whose scheduled time just arrived and haven't been reminded yet
     * today. A time is "due" for a 90-second window after it passes (tolerating the
     * kiosk's poll gap); the first call in that window records it in med_fired so it
     * fires exactly once per day.
     */
    fun medsDue(now: LocalDateTime): List<DueMed> {
        val db = writableDatabase
        val today = now.toLocalDate().toString()
        val weekday = now.dayOfWeek.value - 1   // 0=Mon..6=Sun
        data class Cand(val timeId: Long, val name: String, val dose: String, val time: String)
        val cands = ArrayList<Cand>()
        db.rawQuery(
            """SELECT mt.id, m.name, m.dose, mt.time_of_day
                 FROM med_times mt JOIN medications m ON m.id = mt.medication_id
                 WHERE m.active = 1 AND mt.weekday = ?""", arrayOf(weekday.toString())
        ).use { c ->
            while (c.moveToNext()) cands.add(Cand(c.getLong(0), c.getString(1), c.getString(2), c.getString(3)))
        }
        val due = ArrayList<DueMed>()
        for (cand in cands) {
            val sched = try {
                LocalDateTime.of(now.toLocalDate(), LocalTime.parse(cand.time))
            } catch (_: Exception) { continue }
            val diff = Duration.between(sched, now).seconds
            if (diff in 0..90) {
                val row = db.insertWithOnConflict("med_fired", null,
                    ContentValues().apply { put("med_time_id", cand.timeId); put("fired_date", today) },
                    SQLiteDatabase.CONFLICT_IGNORE)
                if (row != -1L) due.add(DueMed(cand.name, cand.dose))
            }
        }
        return due
    }
}
