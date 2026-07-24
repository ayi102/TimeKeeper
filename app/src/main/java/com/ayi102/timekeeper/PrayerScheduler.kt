package com.ayi102.timekeeper

import android.content.Context
import java.time.Duration
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime

/**
 * Plays the "time to pray" clip at each daytime prayer time (see [PrayerTimes]).
 * The kiosk runs always-on in the foreground, so a single daemon thread that
 * sleeps until the next prayer is simpler and more precise than WorkManager
 * (whose minimum interval is 15 min). Started/stopped by [MainActivity].
 */
class PrayerScheduler(context: Context) {
    private val appContext = context.applicationContext
    private var thread: Thread? = null

    fun start() {
        if (thread != null) return
        thread = Thread({ loop() }, "prayer-scheduler").apply { isDaemon = true; start() }
    }

    fun stop() {
        thread?.interrupt()
        thread = null
    }

    private fun loop() {
        try {
            while (!Thread.currentThread().isInterrupted) {
                val today = LocalDate.now()
                val times = PrayerTimes.forDate(appContext, today)   // network on this bg thread
                val next = times.firstOrNull { it.isAfter(LocalTime.now()) }

                if (next == null) {
                    // Nothing left today, or nothing cached yet (offline). Retry sooner
                    // when we have no times at all; otherwise wait for the next day.
                    Thread.sleep(if (times.isEmpty()) RETRY_MS else millisUntilTomorrow())
                    continue
                }

                val waitMs = Duration.between(LocalTime.now(), next).toMillis()
                if (waitMs > 0) Thread.sleep(waitMs)

                // Guard against clock drift / crossing midnight while we slept.
                if (LocalDate.now() == today && !LocalTime.now().isBefore(next)) {
                    Sound.play(appContext, R.raw.time_to_pray)
                    Thread.sleep(SETTLE_MS)   // move past this minute so we don't re-fire it
                }
            }
        } catch (_: InterruptedException) {
            // stopped
        }
    }

    private fun millisUntilTomorrow(): Long {
        val now = LocalDateTime.now()
        val next = now.toLocalDate().plusDays(1).atStartOfDay().plusMinutes(1)
        return Duration.between(now, next).toMillis().coerceAtLeast(RETRY_MS)
    }

    private companion object {
        const val RETRY_MS = 30 * 60_000L   // 30 min — retry the fetch when offline
        const val SETTLE_MS = 60_000L       // 1 min — avoid re-triggering the same prayer
    }
}
