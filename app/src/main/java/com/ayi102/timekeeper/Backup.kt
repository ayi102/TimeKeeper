package com.ayi102.timekeeper

import android.content.Context
import com.ayi102.timekeeper.core.Money
import com.ayi102.timekeeper.core.Times
import java.time.format.DateTimeFormatter

/**
 * Builds the summary email + DB snapshot and sends it, mirroring the Pi's
 * summary_email.py: THIS-WEEK hours/earned (Mon–Sun) merged with each worker's
 * RUNNING paid/owed/tips, plus a full .db.gz backup attached. Throws on failure.
 */
object Backup {
    private val DAY = DateTimeFormatter.ofPattern("MMM d")
    private val DAY_YEAR = DateTimeFormatter.ofPattern("MMM d, yyyy")

    fun run(context: Context, db: Db): String {
        val s = Settings(context)
        require(s.configured()) { "Mail isn't set up yet — enter your email settings first." }

        val now = Times.now()
        val monday = now.toLocalDate().let { it.minusDays((it.dayOfWeek.value - 1).toLong()) }
        val sunday = monday.plusDays(6)

        val weekSecs = db.periodSeconds(monday, sunday, now)     // this-week worked seconds
        val running = db.summarize(now).associateBy { it.id }    // running paid/owed/tips

        data class Row(
            val name: String, val hours: Double, val earned: Double,
            val paid: Double, val owed: Double, val tips: Double,
        )
        val rows = ArrayList<Row>()
        for (e in db.employeesAdmin()) {                         // active first; has rate + active
            val hours = Money.hours(weekSecs[e.id] ?: 0.0)
            if (!(e.active || hours > 0)) continue               // drop inactive with no hours this week
            val r = running[e.id]
            rows.add(Row(e.name, hours, Money.pay(hours, e.rate),
                r?.paid ?: 0.0, r?.owedDue ?: 0.0, r?.tips ?: 0.0))
        }

        val tHours = Money.round2(rows.sumOf { it.hours })
        val tEarned = Money.round2(rows.sumOf { it.earned })
        val tPaid = Money.round2(rows.sumOf { it.paid })
        val tOwed = Money.round2(rows.sumOf { it.owed })
        val tTips = Money.round2(rows.sumOf { it.tips })

        fun money(x: Double) = "$" + "%.2f".format(x)
        fun line(name: String, h: Double, e: Double, p: Double, o: Double, t: Double) =
            String.format("%-16s%7.2f%10s%10s%10s%10s\n", name, h, money(e), money(p), money(o), money(t))

        val period = "${monday.format(DAY)} – ${sunday.format(DAY_YEAR)}"
        val body = StringBuilder()
        body.append("TimeKeeper — Daily Summary\n")
        body.append("Week of $period\n")
        body.append("(Hours and Earned are for this week; Paid, Owed and Tips are running totals.)\n\n")
        body.append(String.format("%-16s%7s%10s%10s%10s%10s\n", "Employee", "Hours", "Earned", "Paid", "Owed", "Tips"))
        body.append("-".repeat(63)).append('\n')
        for (r in rows) body.append(line(r.name, r.hours, r.earned, r.paid, r.owed, r.tips))
        body.append("-".repeat(63)).append('\n')
        body.append(line("TOTAL", tHours, tEarned, tPaid, tOwed, tTips))
        body.append("\nThe attached .db.gz restores the entire database.\n")

        val fileDate = now.toLocalDate().toString()
        val gz = db.snapshotGzip()
        Mailer.send(s, "TimeKeeper hours: $period", body.toString(), "timekeeper-$fileDate.db.gz", gz)
        return "Sent backup to ${s.to()}."
    }
}
