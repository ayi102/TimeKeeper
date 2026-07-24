package com.ayi102.timekeeper

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

/** Periodic (WorkManager): closes forgotten open entries, capped at the scheduled end. */
class AutoClockoutWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result = try {
        val db = Db(applicationContext)
        try { Clock.autoCloseOverdue(db) } finally { db.close() }
        Result.success()
    } catch (e: Exception) {
        Result.retry()
    }
}
