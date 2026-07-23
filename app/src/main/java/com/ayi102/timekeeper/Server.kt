package com.ayi102.timekeeper

import android.content.res.AssetManager
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject

/**
 * The in-app web server. The tablet's WebView loads the kiosk from here
 * (http://127.0.0.1:8080/); your phone will later reach the admin pages over
 * WiFi at the same server. Bound on all interfaces so the LAN can see it.
 */
class Server(
    private val db: Db,
    private val assets: AssetManager,
    port: Int = 8080,
) : NanoHTTPD(port) {

    override fun serve(session: IHTTPSession): Response = try {
        val uri = session.uri
        when {
            session.method == Method.GET && (uri == "/" || uri == "/index.html") ->
                html(asset("kiosk.html"))

            session.method == Method.GET && uri == "/api/workers" ->
                json(workersJson())

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
