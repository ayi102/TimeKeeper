package com.ayi102.timekeeper

import com.ayi102.timekeeper.core.ClockIn
import com.ayi102.timekeeper.core.Scheduling
import com.ayi102.timekeeper.core.Times
import java.time.LocalDateTime

/** Outcome of a clock tap, sent back to the kiosk page. */
data class ClockResult(
    val ok: Boolean,
    val action: String? = null,   // "in" | "out"
    val name: String = "",
    val time: String? = null,     // e.g. "7:00 AM"
    val message: String? = null,  // why it was blocked
)

/**
 * Clock in/out with the same rules as the Python app: schedule-enforced,
 * multi-shift, overnight-aware; clock-in recorded at the scheduled start and
 * clock-out capped at the scheduled end, with the exact taps kept in
 * actual_in/out. Times are stored as "yyyy-MM-ddTHH:mm:ss" local (matches the
 * Python isoformat, so imported data is compatible).
 */
object Clock {
    private const val GRACE_MIN = 15L
    private const val OVERTIME_MIN = 60L

    fun toggle(db: Db, empId: Long, now: LocalDateTime = Times.now()): ClockResult {
        val name = db.name(empId) ?: return ClockResult(false, message = "Unknown worker.")

        val open = db.openEntry(empId)
        if (open != null) {
            // ----- CLOCK OUT: cap at the matched shift's scheduled end -----
            val cin = Times.parse(open.clockIn)
            val shift = Scheduling.shiftOf(db.schedulesFor(empId, wd(cin)), cin, GRACE_MIN)
            val out = Scheduling.clockOutTime(now, shift?.second, cin)
            db.closeEntry(open.id, Times.format(out), Times.format(now))
            return ClockResult(true, "out", name, Scheduling.fmtTime(out))
        }

        // ----- CLOCK IN: pick the shift; record at the scheduled start -----
        val todays = db.schedulesFor(empId, wd(now))
        val tomorrows = db.schedulesFor(empId, wd(now.plusDays(1)))
        return when (val r = Scheduling.resolveClockIn(name, todays, tomorrows, now, GRACE_MIN)) {
            is ClockIn.Blocked -> ClockResult(false, name = name, message = r.message)
            is ClockIn.Ok -> {
                val cin = Scheduling.clockInTime(now, r.start)
                db.insertClockIn(empId, Times.format(cin), Times.format(now))
                ClockResult(true, "in", name, Scheduling.fmtTime(cin))
            }
        }
    }

    /**
     * Close any open entry whose scheduled end (plus the overtime grace) has passed,
     * capping the recorded clock-out at the scheduled end so a forgotten tap-out never
     * earns unbounded pay. Mirrors the Pi's auto_clockout daemon. Safe to run any time:
     * the clock-out is the schedule-derived end, independent of when this runs.
     */
    fun autoCloseOverdue(db: Db, now: LocalDateTime = Times.now()) {
        for ((id, empId, clockIn) in db.openEntries()) {
            val cin = Times.parse(clockIn)
            val shift = Scheduling.shiftOf(db.schedulesFor(empId, wd(cin)), cin, GRACE_MIN) ?: continue
            val end = shift.second
            if (!now.isBefore(end.plusMinutes(OVERTIME_MIN))) {          // now >= end + grace
                val out = if (end.isAfter(cin)) end else cin
                db.autoClose(id, Times.format(out))
            }
        }
    }

    /** Python-style weekday: Monday=0 .. Sunday=6. */
    private fun wd(dt: LocalDateTime): Int = dt.dayOfWeek.value - 1
}
