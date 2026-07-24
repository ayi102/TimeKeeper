package com.ayi102.timekeeper

import android.content.Context

/** Mail settings for the backup/summary email, stored on the device (like the Pi's mail.env). */
class Settings(context: Context) {
    private val p = context.getSharedPreferences("mail", Context.MODE_PRIVATE)

    fun host(): String = p.getString("host", "smtp.gmail.com") ?: "smtp.gmail.com"
    fun port(): Int = p.getInt("port", 587)
    fun user(): String = p.getString("user", "") ?: ""
    fun password(): String = p.getString("password", "") ?: ""
    fun to(): String = p.getString("to", "") ?: ""

    fun configured(): Boolean = user().isNotBlank() && password().isNotBlank() && to().isNotBlank()

    /** Admin PIN (default 1234 until changed). */
    fun pin(): String = p.getString("pin", "1234") ?: "1234"
    fun savePin(newPin: String) { p.edit().putString("pin", newPin).apply() }

    fun save(host: String, port: Int, user: String, password: String, to: String) {
        p.edit()
            .putString("host", host)
            .putInt("port", port)
            .putString("user", user)
            .putString("password", password)
            .putString("to", to)
            .apply()
    }
}
