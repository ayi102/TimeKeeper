package com.ayi102.timekeeper

import android.content.res.AssetManager
import com.ayi102.timekeeper.core.Scheduling
import com.ayi102.timekeeper.core.Shift
import com.ayi102.timekeeper.core.Times
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * The in-app web server. The tablet's WebView loads the kiosk from here
 * (http://127.0.0.1:8080/); your phone reaches admin over WiFi at
 * http://<tablet-ip>:8080/admin. Kiosk + clock endpoints are open (workers need
 * them); /admin and admin APIs require the PIN (cookie set on login).
 */
class Server(
    private val db: Db,
    private val assets: AssetManager,
    val port: Int = 8080,
) : NanoHTTPD(port) {

    // TODO: make the PIN configurable from an admin settings screen.
    private val adminPin = "1234"
    private val token = UUID.randomUUID().toString()  // fresh per app launch

    private fun authed(s: IHTTPSession): Boolean = s.cookies.read("tk_auth") == token

    override fun serve(session: IHTTPSession): Response = try {
        val uri = session.uri
        when {
            // ----- open (kiosk) -----
            session.method == Method.GET && (uri == "/" || uri == "/index.html") ->
                html(asset("kiosk.html"))
            session.method == Method.GET && uri == "/api/workers" ->
                json(workersJson())
            session.method == Method.GET && uri == "/api/info" ->
                json(JSONObject().put("ip", Net.lanIp()).put("port", port).toString())
            session.method == Method.POST && uri == "/api/clock" -> {
                val id = session.parameters["id"]?.firstOrNull()?.toLongOrNull()
                if (id == null) newFixedLengthResponse(Response.Status.BAD_REQUEST, MIME_PLAINTEXT, "missing id")
                else json(resultJson(Clock.toggle(db, id)))
            }

            // ----- login -----
            session.method == Method.POST && uri == "/admin/login" -> {
                val ok = session.parameters["pin"]?.firstOrNull() == adminPin
                val resp = json(JSONObject().put("ok", ok).toString())
                // Path=/ so the cookie is sent to every endpoint (not just /admin).
                if (ok) resp.addHeader("Set-Cookie", "tk_auth=$token; Path=/; Max-Age=2592000")
                resp
            }

            // ----- admin (PIN required) -----
            session.method == Method.GET && uri == "/admin" ->
                html(asset(if (authed(session)) "admin.html" else "login.html"))

            session.method == Method.GET && uri == "/admin/schedule" ->
                html(asset(if (authed(session)) "schedule.html" else "login.html"))

            session.method == Method.GET && uri == "/api/schedule" -> guard(session) {
                val emp = session.parameters["emp"]?.firstOrNull()?.toLongOrNull()
                if (emp == null) json(JSONObject().put("ok", false).toString())
                else {
                    val arr = JSONArray()
                    for ((wd, s, e) in db.schedulesOf(emp)) {
                        arr.put(JSONObject().put("weekday", wd).put("start", s).put("end", e))
                    }
                    json(JSONObject().put("ok", true).put("name", db.name(emp) ?: "").put("shifts", arr).toString())
                }
            }

            session.method == Method.POST && uri == "/admin/schedule" -> guard(session) {
                val emp = session.parameters["emp"]?.firstOrNull()?.toLongOrNull()
                if (emp == null) json(JSONObject().put("ok", false).toString())
                else json(saveSchedule(emp, session.parameters["shifts"]?.firstOrNull() ?: "[]"))
            }
            session.method == Method.GET && uri == "/api/summary" ->
                if (authed(session)) json(summaryJson()) else unauthorized()

            session.method == Method.GET && uri == "/api/employees" ->
                if (authed(session)) json(employeesJson()) else unauthorized()

            session.method == Method.POST && uri == "/admin/employee" -> guard(session) {
                val p = session.parameters
                val name = p["name"]?.firstOrNull()?.trim().orEmpty()
                val rate = p["rate"]?.firstOrNull()?.toDoubleOrNull()?.coerceAtLeast(0.0) ?: 0.0
                val id = p["id"]?.firstOrNull()?.toLongOrNull()
                if (name.isEmpty()) json(JSONObject().put("ok", false).put("message", "Name is required.").toString())
                else {
                    if (id != null) db.updateEmployee(id, name, rate) else db.addEmployee(name, rate)
                    json(JSONObject().put("ok", true).toString())
                }
            }

            session.method == Method.POST && uri == "/admin/employee/active" -> guard(session) {
                val id = session.parameters["id"]?.firstOrNull()?.toLongOrNull()
                val active = session.parameters["active"]?.firstOrNull() == "1"
                if (id != null) db.setActive(id, active)
                json(JSONObject().put("ok", id != null).toString())
            }

            session.method == Method.POST && uri == "/admin/employee/delete" -> guard(session) {
                val id = session.parameters["id"]?.firstOrNull()?.toLongOrNull()
                if (id != null) db.deleteEmployee(id)
                json(JSONObject().put("ok", id != null).toString())
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

    private fun guard(s: IHTTPSession, block: () -> Response): Response =
        if (authed(s)) block() else unauthorized()

    private fun unauthorized(): Response =
        newFixedLengthResponse(Response.Status.UNAUTHORIZED, MIME_PLAINTEXT, "auth required")

    private fun employeesJson(): String {
        val arr = JSONArray()
        for (e in db.employeesAdmin()) {
            arr.put(
                JSONObject().put("id", e.id).put("name", e.name)
                    .put("rate", e.rate).put("active", e.active)
            )
        }
        return arr.toString()
    }

    /** Validate + de-overlap submitted shifts, then replace the worker's schedule. */
    private fun saveSchedule(empId: Long, rawShifts: String): String = try {
        val arr = JSONArray(rawShifts)
        val byDay = HashMap<Int, MutableList<Pair<String, String>>>()
        var skipped = 0
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            val s = o.optString("start"); val e = o.optString("end")
            if (s.isEmpty() || e.isEmpty() || s == e) { skipped++; continue }
            byDay.getOrPut(o.getInt("weekday")) { arrayListOf() }.add(s to e)
        }
        val accepted = ArrayList<Triple<Int, String, String>>()
        var overlaps = 0
        for ((wd, list) in byDay) {
            val ok = ArrayList<Shift>()
            for ((s, e) in list.sortedBy { it.first }) {
                val sh = Shift(s, e)
                if (ok.any { Scheduling.shiftsOverlap(sh, it) }) { overlaps++; continue }
                ok.add(sh); accepted.add(Triple(wd, s, e))
            }
        }
        db.replaceSchedules(empId, accepted)
        JSONObject().put("ok", true).put("skipped", skipped).put("overlaps", overlaps).toString()
    } catch (e: Exception) {
        JSONObject().put("ok", false).put("message", "Bad schedule data.").toString()
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
