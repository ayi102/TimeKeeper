package com.ayi102.timekeeper

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import fi.iki.elonen.NanoHTTPD

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
    }

    override fun onDestroy() {
        if (::server.isInitialized) server.stop()
        super.onDestroy()
    }
}
