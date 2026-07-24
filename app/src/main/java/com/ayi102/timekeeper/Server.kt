package com.ayi102.timekeeper

import android.content.Context
import com.ayi102.timekeeper.core.Money
import com.ayi102.timekeeper.core.Scheduling
import com.ayi102.timekeeper.core.Shift
import com.ayi102.timekeeper.core.Times
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * The in-app web server. The tablet's WebView loads the kiosk (127.0.0.1:8080);
 * your phone reaches admin over WiFi at http://<tablet-ip>:8080/admin. Kiosk +
 * clock endpoints are open; everything under /admin (and admin APIs) needs the PIN.
 */
class Server(
    private val context: Context,
    private val db: Db,
    val port: Int = 8080,
) : NanoHTTPD(port) {

    private val adminPin = "1234"                  // TODO: make configurable
    private val token = UUID.randomUUID().toString()

    private fun authed(s: IHTTPSession): Boolean = s.cookies.read("tk_auth") == token

    override fun serve(session: IHTTPSession): Response = try {
        val uri = session.uri
        val get = session.method == Method.GET
        val post = session.method == Method.POST
        when {
            // ----- open (kiosk) -----
            get && (uri == "/" || uri == "/index.html") -> html(asset("kiosk.html"))
            get && uri == "/api/workers" -> json(workersJson())
            get && uri == "/api/info" ->
                json(JSONObject().put("ip", Net.lanIp()).put("port", port).toString())
            post && uri == "/api/clock" -> {
                val id = param(session, "id")?.toLongOrNull()
                if (id == null) bad("missing id") else json(resultJson(Clock.toggle(db, id)))
            }

            // ----- login -----
            post && uri == "/admin/login" -> {
                val ok = param(session, "pin") == adminPin
                val resp = json(JSONObject().put("ok", ok).toString())
                if (ok) resp.addHeader("Set-Cookie", "tk_auth=$token; Path=/; Max-Age=2592000")
                resp
            }

            // ----- admin pages (PIN or login screen) -----
            get && uri == "/admin" -> html(asset(if (authed(session)) "admin.html" else "login.html"))
            get && uri == "/admin/schedule" -> html(asset(if (authed(session)) "schedule.html" else "login.html"))
            get && uri == "/admin/payments" -> html(asset(if (authed(session)) "payments.html" else "login.html"))
            get && uri == "/admin/settings" -> html(asset(if (authed(session)) "settings.html" else "login.html"))

            // ----- admin APIs (PIN required) -----
            get && uri == "/api/summary" -> guard(session) { json(summaryJson()) }
            get && uri == "/api/employees" -> guard(session) { json(employeesJson()) }

            post && uri == "/admin/employee" -> guard(session) {
                val name = param(session, "name").orEmpty()
                val rate = param(session, "rate")?.toDoubleOrNull()?.coerceAtLeast(0.0) ?: 0.0
                val id = param(session, "id")?.toLongOrNull()
                if (name.isEmpty()) json(JSONObject().put("ok", false).put("message", "Name is required.").toString())
                else {
                    if (id != null) db.updateEmployee(id, name, rate) else db.addEmployee(name, rate)
                    ok()
                }
            }
            post && uri == "/admin/employee/active" -> guard(session) {
                val id = param(session, "id")?.toLongOrNull()
                if (id != null) db.setActive(id, param(session, "active") == "1")
                json(JSONObject().put("ok", id != null).toString())
            }
            post && uri == "/admin/employee/delete" -> guard(session) {
                val id = param(session, "id")?.toLongOrNull()
                if (id != null) db.deleteEmployee(id)
                json(JSONObject().put("ok", id != null).toString())
            }

            get && uri == "/api/schedule" -> guard(session) {
                val emp = param(session, "emp")?.toLongOrNull()
                if (emp == null) json(JSONObject().put("ok", false).toString())
                else {
                    val arr = JSONArray()
                    for ((wd, s, e) in db.schedulesOf(emp))
                        arr.put(JSONObject().put("weekday", wd).put("start", s).put("end", e))
                    json(JSONObject().put("ok", true).put("name", db.name(emp) ?: "").put("shifts", arr).toString())
                }
            }
            post && uri == "/admin/schedule" -> guard(session) {
                val emp = param(session, "emp")?.toLongOrNull()
                if (emp == null) json(JSONObject().put("ok", false).toString())
                else json(saveSchedule(emp, param(session, "shifts") ?: "[]"))
            }

            get && uri == "/api/payments" -> guard(session) {
                val emp = param(session, "emp")?.toLongOrNull()
                val f = if (emp != null) db.financeFor(emp, Times.now()) else null
                if (f == null) json(JSONObject().put("ok", false).toString())
                else {
                    val hist = JSONArray()
                    for (p in db.payments(emp!!))
                        hist.put(JSONObject().put("id", p.id).put("paidAt", p.paidAt)
                            .put("amount", p.amount).put("tip", p.tip).put("note", p.note))
                    json(JSONObject().put("ok", true).put("name", f.name).put("earned", f.earned)
                        .put("paid", f.paid).put("owed", f.owedDue).put("tips", f.tips).put("history", hist).toString())
                }
            }
            post && uri == "/admin/payout" -> guard(session) {
                val emp = param(session, "emp")?.toLongOrNull()
                val f = if (emp != null) db.financeFor(emp, Times.now()) else null
                val amount = money(session, "amount")
                val tip = money(session, "tip")
                val note = param(session, "note").orEmpty()
                when {
                    f == null -> json(JSONObject().put("ok", false).put("message", "Unknown worker.").toString())
                    amount + tip <= 0.0 -> json(JSONObject().put("ok", false).put("message", "Enter a pay or tip amount.").toString())
                    else -> {
                        val (pay, finalTip) = Money.splitPayout(amount, tip, f.owed)
                        db.addPayment(emp!!, pay, finalTip, note); ok()
                    }
                }
            }
            post && uri == "/admin/payment/delete" -> guard(session) {
                val id = param(session, "id")?.toLongOrNull()
                if (id != null) db.deletePayment(id)
                json(JSONObject().put("ok", id != null).toString())
            }

            // ----- mail settings + backup -----
            get && uri == "/api/settings" -> guard(session) {
                val s = Settings(context)
                json(JSONObject().put("host", s.host()).put("port", s.port())
                    .put("user", s.user()).put("to", s.to())
                    .put("hasPassword", s.password().isNotBlank()).toString())
            }
            post && uri == "/admin/settings" -> guard(session) {
                val s = Settings(context)
                val pw = param(session, "password").orEmpty()
                s.save(
                    param(session, "host").orEmpty().ifBlank { s.host() },
                    param(session, "port")?.toIntOrNull() ?: s.port(),
                    param(session, "user").orEmpty(),
                    if (pw.isBlank()) s.password() else pw,   // blank = keep existing
                    param(session, "to").orEmpty(),
                )
                ok()
            }
            post && uri == "/admin/backup/test" -> guard(session) {
                try {
                    json(JSONObject().put("ok", true).put("message", Backup.run(context, db)).toString())
                } catch (e: Exception) {
                    json(JSONObject().put("ok", false).put("message", (e.message ?: "Send failed.")).toString())
                }
            }

            else -> newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Not found")
        }
    } catch (e: Exception) {
        newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_PLAINTEXT, "Error: ${e.message}")
    }

    // ----- helpers -----
    private fun asset(name: String): String =
        context.assets.open(name).bufferedReader().use { it.readText() }

    private fun param(s: IHTTPSession, name: String): String? = s.parameters[name]?.firstOrNull()?.trim()

    private fun money(s: IHTTPSession, field: String): Double =
        param(s, field)?.toDoubleOrNull()?.coerceAtLeast(0.0) ?: 0.0

    private fun guard(s: IHTTPSession, block: () -> Response): Response =
        if (authed(s)) block() else unauthorized()

    private fun unauthorized(): Response =
        newFixedLengthResponse(Response.Status.UNAUTHORIZED, MIME_PLAINTEXT, "auth required")

    private fun bad(msg: String): Response =
        newFixedLengthResponse(Response.Status.BAD_REQUEST, MIME_PLAINTEXT, msg)

    private fun ok(): Response = json(JSONObject().put("ok", true).toString())

    private fun workersJson(): String {
        val arr = JSONArray()
        for (e in db.employees()) arr.put(JSONObject().put("id", e.id).put("name", e.name).put("in", e.clockedIn))
        return arr.toString()
    }

    private fun summaryJson(): String {
        val arr = JSONArray()
        for (s in db.summarize(Times.now())) {
            arr.put(JSONObject().put("id", s.id).put("name", s.name).put("hours", s.hours)
                .put("pay", s.pay).put("paid", s.paid).put("owed", s.owedDue).put("tips", s.tips))
        }
        return arr.toString()
    }

    private fun employeesJson(): String {
        val arr = JSONArray()
        for (e in db.employeesAdmin())
            arr.put(JSONObject().put("id", e.id).put("name", e.name).put("rate", e.rate).put("active", e.active))
        return arr.toString()
    }

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
            val okShifts = ArrayList<Shift>()
            for ((s, e) in list.sortedBy { it.first }) {
                val sh = Shift(s, e)
                if (okShifts.any { Scheduling.shiftsOverlap(sh, it) }) { overlaps++; continue }
                okShifts.add(sh); accepted.add(Triple(wd, s, e))
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

    private fun html(body: String): Response = newFixedLengthResponse(Response.Status.OK, "text/html", body)
    private fun json(body: String): Response = newFixedLengthResponse(Response.Status.OK, "application/json", body)
}
