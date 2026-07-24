package com.ayi102.timekeeper

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalDate
import java.time.LocalTime

/**
 * Tampa prayer times from the AlAdhan API (method 2 = ISNA, the standard for
 * North America). We only care about the daytime prayers — Fajr is skipped so
 * the kiosk stays quiet overnight.
 *
 * Today's times are cached in SharedPreferences keyed by date, so a brief
 * offline spell (or an app restart) doesn't lose them. The device clock is
 * assumed to be Eastern time (Tampa) — the API returns local times for the city.
 */
object PrayerTimes {
    /** Daytime prayers we announce, in order. */
    private val PRAYERS = listOf("Dhuhr", "Asr", "Maghrib", "Isha")
    private const val URL =
        "https://api.aladhan.com/v1/timingsByCity?city=Tampa&country=USA&state=Florida&method=2"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("prayer", Context.MODE_PRIVATE)

    /**
     * The daytime prayer times for [date], as sorted LocalTimes. Returns the
     * cached set if it's for [date]; otherwise fetches over the network, caches,
     * and returns it. Returns an empty list if there's nothing cached and the
     * fetch fails (e.g. offline) — callers should treat that as "try again later".
     */
    fun forDate(ctx: Context, date: LocalDate): List<LocalTime> {
        val p = prefs(ctx)
        val key = date.toString()
        p.getString("date", null)?.let { cachedDate ->
            if (cachedDate == key) return parse(p.getString("times", "") ?: "")
        }
        val fetched = fetch() ?: return parse(p.getString("times", "").takeIf { p.getString("date", null) == key } ?: "")
        p.edit().putString("date", key).putString("times", fetched.joinToString(",")).apply()
        return parse(fetched.joinToString(","))
    }

    /** Fetch today's daytime times as "HH:mm" strings, or null on any failure. */
    private fun fetch(): List<String>? = try {
        val conn = (URL(URL).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 10_000
            readTimeout = 10_000
        }
        try {
            if (conn.responseCode != 200) null
            else {
                val body = conn.inputStream.bufferedReader().use { it.readText() }
                val timings = JSONObject(body).getJSONObject("data").getJSONObject("timings")
                PRAYERS.map { normalize(timings.getString(it)) }
            }
        } finally {
            conn.disconnect()
        }
    } catch (_: Exception) {
        null
    }

    /** AlAdhan returns e.g. "13:07" or sometimes "13:07 (EDT)" — keep the HH:mm. */
    private fun normalize(raw: String): String = raw.trim().take(5)

    private fun parse(csv: String): List<LocalTime> =
        csv.split(",").mapNotNull { s ->
            runCatching { LocalTime.parse(s.trim()) }.getOrNull()
        }.sorted()
}
