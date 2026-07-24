package com.ayi102.timekeeper

import android.content.Context
import com.ayi102.timekeeper.core.Scheduling
import com.ayi102.timekeeper.core.Times
import java.time.Duration
import java.time.LocalDateTime

/**
 * Emails an alert when a scheduled worker hasn't clocked in, mirroring the Pi's
 * missed_clockin.py. For each active worker's shift today: once MISSED_MIN past
 * the start has passed, they're still within the shift, no tap landed in the
 * shift's window, and we haven't already alerted for it — send one email and
 * record it (deduped via clockin_alerts) so it never repeats.
 */
object MissedClockin {
    private const val GRACE_MIN = 15L
    private const val MISSED_MIN = 30L

    fun run(context: Context, db: Db, now: LocalDateTime = Times.now()) {
        val s = Settings(context)
        if (!s.configured()) return

        val today = now.toLocalDate()
        val grace = Duration.ofMinutes(GRACE_MIN)

        data class Missed(val empId: Long, val name: String, val start: LocalDateTime, val key: String)
        val missed = ArrayList<Missed>()
        for ((empId, name) in db.activeWorkers()) {
            val cins = db.clockInsOn(empId, today)
            for (sh in db.schedulesFor(empId, today.dayOfWeek.value - 1)) {
                val start = Scheduling.combine(today, sh.startTime)
                val end = Scheduling.shiftEnd(today, sh.startTime, sh.endTime)
                // only within the shift, once the grace past its start has passed
                if (now.isBefore(start.plusMinutes(MISSED_MIN)) || !now.isBefore(end)) continue
                // clocked in for THIS shift? (a tap in its window)
                if (cins.any { !it.isBefore(start.minus(grace)) && it.isBefore(end) }) continue
                val key = Times.format(start)   // per-shift dedup key
                if (db.alertExists(empId, key)) continue
                missed.add(Missed(empId, name, start, key))
            }
        }
        if (missed.isEmpty()) return

        val who = missed.joinToString(", ") { it.name }
        val body = StringBuilder("TimeKeeper — missed clock-in\n\n")
        for (m in missed)
            body.append("  ${m.name} was scheduled to start at ${Scheduling.fmtTime(m.start)} " +
                "and has not clocked in (as of ${Scheduling.fmtTime(now)}).\n")
        Mailer.sendText(s, "TimeKeeper: $who missed clock-in", body.toString())

        // Record only after a successful send, so a failed email retries next run.
        for (m in missed) db.recordAlert(m.empId, m.key, Times.format(now))
    }
}
