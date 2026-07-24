package com.ayi102.timekeeper

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.os.Bundle
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import fi.iki.elonen.NanoHTTPD
import java.time.Duration
import java.time.LocalDateTime
import java.util.concurrent.TimeUnit

class MainActivity : AppCompatActivity() {
    private lateinit var db: Db
    private lateinit var server: Server

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        db = Db(this)
        server = Server(this, db)
        server.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)

        val web = findViewById<WebView>(R.id.webview)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.addJavascriptInterface(KioskBridge(), "Android")
        web.loadUrl("http://127.0.0.1:8080/")

        scheduleDailyBackup()
    }

    override fun onResume() {
        super.onResume()
        hideSystemBars()
        enterKioskIfNeeded()
    }

    private fun hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    /** Pin the app (lock task) so Home/Recents are blocked. Best-effort. */
    private fun enterKioskIfNeeded() {
        val am = getSystemService(ACTIVITY_SERVICE) as ActivityManager
        if (am.lockTaskModeState == ActivityManager.LOCK_TASK_MODE_NONE) {
            try { startLockTask() } catch (_: Exception) { /* pinning unavailable */ }
        }
    }

    /** Called from the admin settings page (JS) to leave the kiosk. */
    inner class KioskBridge {
        @JavascriptInterface
        fun exitKiosk() {
            runOnUiThread {
                try { stopLockTask() } catch (_: Exception) {}
                moveTaskToBack(true)
            }
        }
    }

    /** Email the summary + DB backup every day at ~6 AM. */
    private fun scheduleDailyBackup() {
        val now = LocalDateTime.now()
        var next = now.toLocalDate().atTime(6, 0)
        if (!next.isAfter(now)) next = next.plusDays(1)
        val delayMinutes = Duration.between(now, next).toMinutes()

        val request = PeriodicWorkRequestBuilder<BackupWorker>(24, TimeUnit.HOURS)
            .setInitialDelay(delayMinutes, TimeUnit.MINUTES)
            .setConstraints(
                Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
            )
            .build()

        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "daily-backup", ExistingPeriodicWorkPolicy.UPDATE, request
        )
    }

    override fun onDestroy() {
        if (::server.isInitialized) server.stop()
        super.onDestroy()
    }
}
