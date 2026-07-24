package com.ayi102.timekeeper

import android.content.Context
import com.ayi102.timekeeper.core.Money
import com.ayi102.timekeeper.core.Scheduling
import com.ayi102.timekeeper.core.Shift
import com.ayi102.timekeeper.core.Times
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
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

    private val token = UUID.randomUUID().toString()
    private fun adminPin(): String = Settings(context).pin()

    init {
        // Keep multipart uploads (restore) in the app cache; java.io.tmpdir may not be writable.
        setTempFileManagerFactory { CacheTempFileManager(context.cacheDir) }
    }

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
            get && uri == "/ali_photo.jpg" -> {
                val b = context.assets.open("ali_photo.jpg").use { it.readBytes() }
                newFixedLengthResponse(Response.Status.OK, "image/jpeg", b.inputStream(), b.size.toLong())
            }
            post && uri == "/api/play/ali" -> { Sound.play(context, R.raw.ali_ismail); ok() }
            post && uri == "/api/clock" -> {
                val id = param(session, "id")?.toLongOrNull()
                if (id == null) bad("missing id") else {
                    val r = Clock.toggle(db, id)
                    if (r.ok) when (r.action) {
                        "in" -> Sound.play(context, R.raw.clocked_in)
                        "out" -> Sound.play(context, R.raw.clocked_out)
                    }
                    json(resultJson(r))
                }
            }

            // ----- login -----
            post && uri == "/admin/login" -> {
                val ok = param(session, "pin") == adminPin()
                val resp = json(JSONObject().put("ok", ok).toString())
                if (ok) resp.addHeader("Set-Cookie", "tk_auth=$token; Path=/; Max-Age=2592000")
                resp
            }

            // ----- admin pages (PIN or login screen) -----
            get && uri == "/admin" -> html(asset(if (authed(session)) "admin.html" else "login.html"))
            get && uri == "/admin/schedule" -> html(asset(if (authed(session)) "schedule.html" else "login.html"))
            get && uri == "/admin/payments" -> html(asset(if (authed(session)) "payments.html" else "login.html"))
            get && uri == "/admin/entries" -> html(asset(if (authed(session)) "entries.html" else "login.html"))
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

            // ----- time entries (timesheet) -----
            get && uri == "/api/entries" -> guard(session) {
                val emp = param(session, "emp")?.toLongOrNull()
                if (emp == null) json(JSONObject().put("ok", false).toString())
                else {
                    val f = db.financeFor(emp, Times.now())   // name regardless of active
                    val arr = JSONArray()
                    for (r in db.entriesFor(emp, Times.now()))
                        arr.put(JSONObject().put("id", r.id).put("in", r.clockIn)
                            .put("out", r.clockOut ?: JSONObject.NULL).put("hours", r.hours).put("open", r.open))
                    json(JSONObject().put("ok", true).put("name", f?.name ?: "").put("entries", arr).toString())
                }
            }
            post && uri == "/admin/entry" -> guard(session) {
                val emp = param(session, "emp")?.toLongOrNull()
                val id = param(session, "id")?.toLongOrNull()
                try {
                    val cin = normTime(param(session, "in"))
                    val cout = normTime(param(session, "out"))
                    when {
                        cin == null -> json(err("Clock-in time is required."))
                        cout != null && !Times.parse(cout).isAfter(Times.parse(cin)) ->
                            json(err("Clock-out must be after clock-in."))
                        id != null -> { db.updateEntry(id, cin, cout); ok() }
                        emp != null -> { db.addEntry(emp, cin, cout); ok() }
                        else -> json(err("Missing worker."))
                    }
                } catch (e: Exception) {
                    json(err("Invalid date/time."))
                }
            }
            post && uri == "/admin/entry/delete" -> guard(session) {
                val id = param(session, "id")?.toLongOrNull()
                if (id != null) db.deleteEntry(id)
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
            post && uri == "/admin/pin" -> guard(session) {
                val current = param(session, "current")
                val next = param(session, "new").orEmpty()
                when {
                    current != adminPin() -> json(err("Current PIN is incorrect."))
                    next.length < 4 || !next.all { it.isDigit() } -> json(err("New PIN must be at least 4 digits."))
                    else -> { Settings(context).savePin(next); ok() }
                }
            }
            post && uri == "/admin/restore" -> guard(session) {
                try {
                    val files = HashMap<String, String>()
                    session.parseBody(files)
                    val tmp = files["file"]
                    if (tmp == null) {
                        json(JSONObject().put("ok", false).put("message", "No file received.").toString())
                    } else {
                        var bytes = File(tmp).readBytes()
                        if (bytes.size > 2 && bytes[0] == 0x1f.toByte() && bytes[1] == 0x8b.toByte())
                            bytes = java.util.zip.GZIPInputStream(bytes.inputStream()).use { it.readBytes() }
                        json(JSONObject().put("ok", true).put("message", db.restoreFrom(bytes)).toString())
                    }
                } catch (e: Exception) {
                    json(JSONObject().put("ok", false).put("message", (e.message ?: "Restore failed.")).toString())
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

    private fun err(msg: String): String = JSONObject().put("ok", false).put("message", msg).toString()

    /** Normalise a datetime-local value ("yyyy-MM-ddTHH:mm") to stored form; validates by parsing. */
    private fun normTime(raw: String?): String? {
        if (raw.isNullOrBlank()) return null
        val s = if (raw.length == 16) "$raw:00" else raw
        Times.parse(s)   // throws if malformed
        return s
    }

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

/** Keeps NanoHTTPD's multipart temp files in a directory we control (the app cache). */
private class CacheTempFileManager(private val dir: File) : NanoHTTPD.TempFileManager {
    private val files = ArrayList<NanoHTTPD.TempFile>()
    init { dir.mkdirs() }
    override fun createTempFile(filenameHint: String?): NanoHTTPD.TempFile =
        CacheTempFile(dir).also { files.add(it) }
    override fun clear() {
        for (f in files) try { f.delete() } catch (_: Exception) {}
        files.clear()
    }
}

private class CacheTempFile(dir: File) : NanoHTTPD.TempFile {
    private val file = File.createTempFile("nano-upload-", ".tmp", dir)
    private val out = java.io.FileOutputStream(file)
    override fun open(): java.io.OutputStream = out
    override fun delete() { try { out.close() } catch (_: Exception) {}; file.delete() }
    override fun getName(): String = file.absolutePath
}
