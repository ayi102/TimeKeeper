package com.ayi102.timekeeper

import android.content.res.AssetManager
import com.ayi102.timekeeper.core.Times
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject

/**
 * The in-app web server. The tablet's WebView loads the kiosk from here
 * (http://127.0.0.1:8080/); your phone reaches the admin pages over WiFi at
 * http://<tablet-ip>:8080/admin. Bound on all interfaces.
 */
class Server(
    private val db: Db,
    private val assets: AssetManager,
    val port: Int = 8080,
) : NanoHTTPD(port) {

    override fun serve(session: IHTTPSession): Response = try {
        val uri = session.uri
        when {
            session.method == Method.GET && (uri == "/" || uri == "/index.html") ->
                html(asset("kiosk.html"))

            session.method == Method.GET && uri == "/admin" ->
                html(asset("admin.html"))

            session.method == Method.GET && uri == "/api/workers" ->
                json(workersJson())

            session.method == Method.GET && uri == "/api/summary" ->
                json(summaryJson())

            session.method == Method.GET && uri == "/api/info" ->
                json(JSONObject().put("ip", Net.lanIp()).put("port", port).toString())

            session.method == Method.POST && uri == "/api/clock" -> {
                val id = session.parameters["id"]?.firstOrNull()?.toLongOrNull()
                if (id == null) newFixedLengthResponse(Response.Status.BAD_REQUEST, MIME_PLAINTEXT, "missing id")
                else json(resultJson(Clock.toggle(db, id)))
            }

            else -> newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Not found")
        }
    } catch (e: Exception) {
        newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_PLAINTEXT, "Error: ${e.message}")
    }

    private fun asset(name: String): String =
        assets.open(name).bufferedReader().use { it.readText() }

    private fun workersJson(): String {
        val arr = JSONArray()
        for (e in db.employees()) {
            arr.put(JSONObject().put("id", e.id).put("name", e.name).put("in", e.clockedIn))
        }
        return arr.toString()
    }

    private fun summaryJson(): String {
        val arr = JSONArray()
        for (s in db.summarize(Times.now())) {
            arr.put(
                JSONObject()
                    .put("name", s.name).put("hours", s.hours).put("pay", s.pay)
                    .put("paid", s.paid).put("owed", s.owedDue).put("tips", s.tips)
            )
        }
        return arr.toString()
    }

    private fun resultJson(r: ClockResult): String {
        val o = JSONObject().put("ok", r.ok).put("name", r.name)
        r.action?.let { o.put("action", it) }
        r.time?.let { o.put("time", it) }
        r.message?.let { o.put("message", it) }
        return o.toString()
    }

    private fun html(body: String): Response =
        newFixedLengthResponse(Response.Status.OK, "text/html", body)

    private fun json(body: String): Response =
        newFixedLengthResponse(Response.Status.OK, "application/json", body)
}
