package com.ayi102.timekeeper

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : AppCompatActivity() {
    private lateinit var db: Db

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

        db = Db(this)
        val web = findViewById<WebView>(R.id.webview)
        web.settings.javaScriptEnabled = true
        // Once the page loads, hand it the workers from the database. (Interim:
        // next slice serves everything from the in-app server instead.)
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                web.evaluateJavascript("renderWorkers(${workersJson()})", null)
            }
        }
        web.loadUrl("file:///android_asset/kiosk.html")
    }

    private fun workersJson(): String {
        val arr = JSONArray()
        for (e in db.employees()) {
            arr.put(JSONObject().put("name", e.name).put("in", e.clockedIn))
        }
        return arr.toString()
    }
}
