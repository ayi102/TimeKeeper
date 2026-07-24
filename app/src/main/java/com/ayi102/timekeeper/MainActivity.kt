package com.ayi102.timekeeper

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
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
        enableEdgeToEdge()
        setContentView(R.layout.activity_main)
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.main)) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        // Start the in-app server, then point the WebView at it.
        db = Db(this)
        server = Server(this, db)
        server.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)

        val web = findViewById<WebView>(R.id.webview)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.loadUrl("http://127.0.0.1:8080/")

        scheduleDailyBackup()
    }

    /** Schedule the backup email to run every day at ~6 AM. */
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
