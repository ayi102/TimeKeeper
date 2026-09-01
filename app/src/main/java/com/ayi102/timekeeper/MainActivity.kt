package com.ayi102.timekeeper

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.os.Bundle
import android.view.WindowManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.work.WorkManager

/**
 * Locked, full-screen kiosk shell around the cloud app. All logic and data now
 * live in the web app (Vercel + Supabase); the tablet only displays the kiosk
 * page. Lock-task + boot-launch keep it pinned as a wall kiosk.
 */
class MainActivity : AppCompatActivity() {

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // The old on-device server/background jobs are retired; cancel any work
        // still scheduled by a previous version so it can't run against stale
        // local data (e.g. send wrong emails).
        WorkManager.getInstance(this).cancelAllWork()

        val web = findViewById<WebView>(R.id.webview)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        // Let the medication-reminder chime auto-play without a user tap.
        web.settings.mediaPlaybackRequiresUserGesture = false
        web.webViewClient = WebViewClient() // keep navigation inside the kiosk
        web.loadUrl(KIOSK_URL)
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

    private companion object {
        const val KIOSK_URL = "https://timekeeper-aismail102.vercel.app/"
    }
}
