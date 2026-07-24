package com.ayi102.timekeeper

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

/** Runs once a day (WorkManager): emails the summary + DB backup. */
class BackupWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val ctx = applicationContext
        if (!Settings(ctx).configured()) return Result.success()  // nothing set up yet — skip
        return try {
            Backup.run(ctx, Db(ctx))
            Result.success()
        } catch (e: Exception) {
            Result.retry()  // network hiccup etc. — try again later
        }
    }
}
