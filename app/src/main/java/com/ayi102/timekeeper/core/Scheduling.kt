package com.ayi102.timekeeper.core

import java.math.BigDecimal
import java.math.RoundingMode
import java.time.Duration
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import kotlin.math.ceil

/**
 * Pure business logic ported from the Python app. No Android/DB dependencies.
 * Times are "HH:MM" (24h, zero-padded); weekday is 0=Mon..6=Sun. An end time
 * <= start time means the shift runs overnight (ends next day).
 */

data class Shift(val startTime: String, val endTime: String)

sealed class ClockIn {
    data class Ok(val start: LocalDateTime, val end: LocalDateTime) : ClockIn()
    data class Blocked(val message: String) : ClockIn()
}

/** Stored timestamps are Python-compatible local ISO strings ("...T..:..:.."). */
object Times {
    val STORE: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss")
    fun parse(s: String): LocalDateTime = LocalDateTime.parse(s, STORE)
    fun format(dt: LocalDateTime): String = dt.format(STORE)
    fun now(): LocalDateTime = LocalDateTime.now().withNano(0)
}

object Scheduling {
    private val TIME_LABEL: DateTimeFormatter = DateTimeFormatter.ofPattern("h:mm a")

    fun combine(date: LocalDate, hhmm: String): LocalDateTime =
        LocalDateTime.of(date, LocalTime.parse(hhmm))

    fun shiftEnd(date: LocalDate, start: String, end: String): LocalDateTime {
        val e = combine(date, end)
        return if (end <= start) e.plusDays(1) else e
    }

    fun shiftsOverlap(a: Shift, b: Shift): Boolean {
        val d = LocalDate.of(2000, 1, 1)
        val a1 = combine(d, a.startTime); val a2 = shiftEnd(d, a.startTime, a.endTime)
        val b1 = combine(d, b.startTime); val b2 = shiftEnd(d, b.startTime, b.endTime)
        return a1 < b2 && b1 < a2
    }

    fun resolveClockIn(
        name: String,
        todays: List<Shift>,
        tomorrows: List<Shift>,
        now: LocalDateTime,
        graceMin: Long,
    ): ClockIn {
        val grace = Duration.ofMinutes(graceMin)
        val today = now.toLocalDate()
        val todayWin = todays
            .map { combine(today, it.startTime) to shiftEnd(today, it.startTime, it.endTime) }
            .sortedBy { it.first }

        for ((s, e) in todayWin) {
            if (!now.isBefore(s.minus(grace)) && now.isBefore(e)) return ClockIn.Ok(s, e)
        }
        val tomorrow = today.plusDays(1)
        tomorrows
            .map { combine(tomorrow, it.startTime) to shiftEnd(tomorrow, it.startTime, it.endTime) }
            .minByOrNull { it.first }
            ?.let { (s, e) ->
                if (!now.isBefore(s.minus(grace)) && now.isBefore(s)) return ClockIn.Ok(s, e)
            }
        if (todays.isEmpty()) return ClockIn.Blocked("$name is not scheduled to work today.")
        val upcoming = todayWin.map { it.first }.filter { now.isBefore(it.minus(grace)) }
        if (upcoming.isNotEmpty())
            return ClockIn.Blocked("Too early — next shift starts at ${upcoming.min().format(TIME_LABEL)}.")
        val lastEnd = todayWin.maxOf { it.second }
        return ClockIn.Blocked("Shift already ended at ${lastEnd.format(TIME_LABEL)}.")
    }

    fun shiftOf(shifts: List<Shift>, cin: LocalDateTime, graceMin: Long): Pair<LocalDateTime, LocalDateTime>? {
        val grace = Duration.ofMinutes(graceMin)
        val date = cin.toLocalDate()
        val wins = shifts.map { combine(date, it.startTime) to shiftEnd(date, it.startTime, it.endTime) }
        for (w in wins) if (!cin.isBefore(w.first.minus(grace)) && cin.isBefore(w.second)) return w
        return wins.minByOrNull { kotlin.math.abs(Duration.between(it.first, cin).seconds) }
    }

    fun clockInTime(now: LocalDateTime, start: LocalDateTime): LocalDateTime =
        if (now.isAfter(start)) now else start

    fun clockOutTime(now: LocalDateTime, shiftEnd: LocalDateTime?, cin: LocalDateTime): LocalDateTime {
        var out = now
        if (shiftEnd != null && now.isAfter(shiftEnd)) out = shiftEnd
        if (out.isBefore(cin)) out = cin
        return out
    }

    fun fmtTime(dt: LocalDateTime): String = dt.format(TIME_LABEL)
}

object Money {
    // HALF_EVEN (banker's rounding) to match Python's round(), so cents agree with
    // the Pi's historical numbers.
    fun round2(x: Double): Double =
        BigDecimal.valueOf(x).setScale(2, RoundingMode.HALF_EVEN).toDouble()

    fun hours(seconds: Double): Double = round2(seconds / 3600.0)
    fun pay(hours: Double, rate: Double): Double = round2(hours * rate)
    fun owedDue(owed: Double): Double = if (owed > 0) ceil(owed) else 0.0

    fun splitPayout(amount: Double, tip: Double, owedExact: Double): Pair<Double, Double> {
        val owed = maxOf(0.0, round2(owedExact))
        val over = round2(amount - owed)
        return if (over > 0) round2(owed) to round2(tip + over) else round2(amount) to round2(tip)
    }
}
