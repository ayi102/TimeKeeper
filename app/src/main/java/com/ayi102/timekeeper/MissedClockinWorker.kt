package com.ayi102.timekeeper

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

/** Periodic (WorkManager): emails an alert for any missed clock-in. Needs network. */
class MissedClockinWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result = try {
        val db = Db(applicationContext)
        try { MissedClockin.run(applicationContext, db) } finally { db.close() }
        Result.success()
    } catch (e: Exception) {
        Result.retry()
    }
}
