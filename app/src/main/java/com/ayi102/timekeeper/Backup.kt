package com.ayi102.timekeeper

import android.content.Context
import com.ayi102.timekeeper.core.Times

/** Builds the DB snapshot + summary and emails it. Throws on send failure. */
object Backup {
    /** Returns a human-readable success message; throws if the email fails. */
    fun run(context: Context, db: Db): String {
        val s = Settings(context)
        require(s.configured()) { "Mail isn't set up yet — enter your email settings first." }

        val now = Times.now()
        val date = now.toLocalDate().toString()
        val gz = db.snapshotGzip()

        val body = StringBuilder("TimeKeeper backup + summary — $date\n\n")
        body.append(String.format("%-14s%8s%10s%10s\n", "Worker", "Hours", "Owed", "Tips"))
        for (x in db.summarize(now)) {
            body.append(String.format("%-14s%8.2f%10s%10s\n", x.name, x.hours, "$" + x.owedDue, "$" + x.tips))
        }
        body.append("\nThe attached timekeeper-$date.db.gz restores the whole database.")

        Mailer.send(s, "TimeKeeper backup $date", body.toString(), "timekeeper-$date.db.gz", gz)
        return "Sent backup to ${s.to()}."
    }
}
