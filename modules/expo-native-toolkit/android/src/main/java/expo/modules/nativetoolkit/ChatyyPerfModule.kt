package expo.modules.nativetoolkit

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.SharedPreferences
import android.content.res.Configuration
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.view.Choreographer
import android.view.Display
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * [2026-10-18 perf-telemetry] Fluidez + saúde nativa (JS: services/nativeTelemetry.js §perf).
 *
 *   • quadros  — Choreographer.FrameCallback no main (só em 1º plano). Por rota atual
 *                (setRoute): n quadros, sl lentos (> 2× orçamento do quadro), fz
 *                congelados (≥ 700 ms), mx maior quadro (ms), j excesso total (ms).
 *   • memória  — RSS (/proc/self/statm, thread própria, 5 s): pico da janela/sessão +
 *                heap Java; PSS (Debug.MemoryInfo) 1× por janela fora do main;
 *                onTrimMemory por nível + onLowMemory.
 *   • janela   — fecha a cada 60 s ou ao ir p/ 2º plano → fila persistida
 *                (SharedPreferences, teto 30) + evento "onPerfWindow"; JS lê com
 *                peek() e confirma com ack(seq) após o POST.
 *   • sessão anterior — registro "vivo" (rota, fg, memória, trims) → prev().
 *   • saída    — ActivityManager.getHistoricalProcessExitReasons (API 30+): só as
 *                saídas novas desde a última leitura (motivo, importância, pss/rss,
 *                descrição curta). Sem trace.
 * Nada lança p/ o JS. Kill switch: JS não chama start().
 */
object ChatyyPerfCore {
  private const val PREFS = "chatyy_perf"
  private const val K_PENDING = "pending_v1"
  private const val K_LIVE = "live_v1"
  private const val K_SEQ = "seq_v1"
  private const val K_EXIT_TS = "exit_ts_v1"
  private const val K_EXITS = "exits_v1"
  private const val WINDOW_MS = 60_000L
  private const val MEM_TICK_MS = 5_000L
  private const val FROZEN_NS = 700_000_000L
  private const val MAX_PENDING = 30
  private const val MAX_EXITS = 12
  private const val MAX_ROUTES = 24

  private class Bucket {
    var n = 0; var sl = 0; var fz = 0; var mx = 0L; var j = 0L
    fun empty() = n == 0 && sl == 0 && fz == 0
  }

  private val lock = Any()
  private var pending = JSONArray()
  private var exits = JSONArray()
  private var seq = 0
  private var prevSession: JSONObject? = null
  private var initDone = false
  private var appCtx: Context? = null
  private var prefs: SharedPreferences? = null

  // ── só main ──
  private val main = Handler(Looper.getMainLooper())
  private var running = false
  private var fg = false
  private var frameCbOn = false
  private var lastFrameNs = 0L
  private var budgetNs = 16_666_667L
  private var refresh = 60
  private var route = ""
  private var cur = Bucket()
  private val buckets = HashMap<String, Bucket>()
  private var winStart = System.currentTimeMillis()
  private var sessionStart = SystemClock.elapsedRealtime()
  private var trimWin = HashMap<Int, Int>()
  private var trimSession = 0
  private var lowMemWin = 0
  private var lastFrozenAt = 0L
  private var lastFrozenMs = 0L

  // memória (thread "chatyy-perf")
  @Volatile private var rssCur = 0L
  @Volatile private var rssPkWin = 0L
  @Volatile private var rssPkSession = 0L
  @Volatile private var pssLast = 0L
  private var memThread: HandlerThread? = null
  private var memHandler: Handler? = null

  var emit: ((Map<String, Any?>) -> Unit)? = null

  private val frameCb = object : Choreographer.FrameCallback {
    override fun doFrame(frameTimeNanos: Long) {
      if (!frameCbOn) return
      if (lastFrameNs > 0) {
        val dt = frameTimeNanos - lastFrameNs
        if (dt > 0) {
          cur.n++
          if (dt >= FROZEN_NS) {
            cur.fz++
            lastFrozenAt = System.currentTimeMillis()
            lastFrozenMs = dt / 1_000_000
          } else if (dt > 2 * budgetNs) {
            cur.sl++
          }
          if (dt * 2 > budgetNs * 3) cur.j += (dt - budgetNs) / 1_000_000
          val ms = dt / 1_000_000
          if (ms > cur.mx) cur.mx = ms
        }
      }
      lastFrameNs = frameTimeNanos
      try { Choreographer.getInstance().postFrameCallback(this) } catch (_: Throwable) {}
    }
  }

  private val windowTick = object : Runnable {
    override fun run() {
      if (!running) return
      closeWindow("t")
      main.postDelayed(this, WINDOW_MS)
    }
  }

  private val trimCb = object : ComponentCallbacks2 {
    override fun onTrimMemory(level: Int) {
      main.post {
        trimWin[level] = (trimWin[level] ?: 0) + 1
        trimSession++
        if (running) writeLive(false)
      }
    }
    override fun onConfigurationChanged(newConfig: Configuration) {}
    @Deprecated("Deprecated in Java")
    override fun onLowMemory() {
      main.post { lowMemWin++; trimSession++; if (running) writeLive(false) }
    }
  }

  /** Lê o estado do processo anterior ANTES de qualquer gravação deste. */
  @Synchronized
  fun init(ctx: Context) {
    if (initDone) return
    initDone = true
    appCtx = ctx.applicationContext
    val p = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    prefs = p
    try {
      p.getString(K_LIVE, null)?.let { prevSession = JSONObject(it) }
      p.getString(K_PENDING, null)?.let { pending = JSONArray(it) }
      p.getString(K_EXITS, null)?.let { exits = JSONArray(it) }
      seq = p.getInt(K_SEQ, 0)
      p.edit().remove(K_LIVE).apply()
    } catch (_: Throwable) {}
    readExitReasons()
  }

  // ─── saída do processo anterior (API 30+) ───
  private fun readExitReasons() {
    if (Build.VERSION.SDK_INT < 30) return
    val c = appCtx ?: return
    val p = prefs ?: return
    try {
      val am = c.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return
      val list: List<ApplicationExitInfo> = am.getHistoricalProcessExitReasons(c.packageName, 0, 8)
      val lastTs = p.getLong(K_EXIT_TS, 0L)
      var maxTs = lastTs
      val fresh = ArrayList<ApplicationExitInfo>()
      for (e in list) {
        if (e.timestamp > lastTs) fresh.add(e)
        if (e.timestamp > maxTs) maxTs = e.timestamp
      }
      if (fresh.isEmpty()) return
      synchronized(lock) {
        // mais antigo primeiro; só o processo principal + no máx. 5
        for (e in fresh.sortedBy { it.timestamp }.takeLast(5)) {
          val o = JSONObject()
          o.put("k", "aexit")
          o.put("ts", e.timestamp / 1000)
          o.put("reason", reasonName(e.reason))
          o.put("st", e.status)
          o.put("imp", e.importance)
          o.put("pss", e.pss / 1024)
          o.put("rss", e.rss / 1024)
          val proc = e.processName ?: ""
          if (proc != c.packageName) o.put("proc", proc.removePrefix(c.packageName).take(24))
          e.description?.let { o.put("desc", it.replace(Regex("\\s+"), " ").take(110)) }
          exits.put(o)
        }
        while (exits.length() > MAX_EXITS) exits.remove(0)
        p.edit().putString(K_EXITS, exits.toString()).putLong(K_EXIT_TS, maxTs).apply()
      }
    } catch (_: Throwable) {}
  }

  private fun reasonName(r: Int): String = when (r) {
    ApplicationExitInfo.REASON_EXIT_SELF -> "exit_self"
    ApplicationExitInfo.REASON_SIGNALED -> "signaled"
    ApplicationExitInfo.REASON_LOW_MEMORY -> "low_memory"
    ApplicationExitInfo.REASON_CRASH -> "crash"
    ApplicationExitInfo.REASON_CRASH_NATIVE -> "crash_native"
    ApplicationExitInfo.REASON_ANR -> "anr"
    ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "init_failure"
    ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "permission_change"
    ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "excessive_resource"
    ApplicationExitInfo.REASON_USER_REQUESTED -> "user_requested"
    ApplicationExitInfo.REASON_USER_STOPPED -> "user_stopped"
    ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "dependency_died"
    ApplicationExitInfo.REASON_OTHER -> "other"
    11 -> "freezer" // REASON_FREEZER (API 33)
    12 -> "package_state_change" // API 34
    13 -> "package_updated" // API 34
    else -> "r$r"
  }

  // ─── ciclo (main) ───
  fun start() {
    if (running) return
    val c = appCtx ?: return
    running = true
    sessionStart = SystemClock.elapsedRealtime()
    winStart = System.currentTimeMillis()
    try {
      val dm = c.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
      val rr = dm?.getDisplay(Display.DEFAULT_DISPLAY)?.refreshRate ?: 60f
      if (rr in 20f..240f) { refresh = Math.round(rr); budgetNs = (1_000_000_000.0 / rr).toLong() }
    } catch (_: Throwable) {}
    try { c.registerComponentCallbacks(trimCb) } catch (_: Throwable) {}
    val t = HandlerThread("chatyy-perf", android.os.Process.THREAD_PRIORITY_BACKGROUND)
    t.start()
    memThread = t
    val h = Handler(t.looper)
    memHandler = h
    h.post(memTick)
    main.postDelayed(windowTick, WINDOW_MS)
    setForeground(true)
    writeLive(false)
  }

  fun stop() {
    if (!running) return
    closeWindow("stop")
    running = false
    setFrames(false)
    main.removeCallbacks(windowTick)
    try { appCtx?.unregisterComponentCallbacks(trimCb) } catch (_: Throwable) {}
    memHandler?.removeCallbacksAndMessages(null)
    memThread?.quitSafely()
    memThread = null; memHandler = null
  }

  fun setForeground(on: Boolean) {
    if (!running) return
    if (on == fg && frameCbOn == on) return
    fg = on
    setFrames(on)
    if (on) writeLive(false) else closeWindow("bg")
  }

  private fun setFrames(on: Boolean) {
    if (on == frameCbOn) return
    frameCbOn = on
    lastFrameNs = 0 // o intervalo em 2º plano não é quadro congelado
    try {
      val ch = Choreographer.getInstance()
      ch.removeFrameCallback(frameCb)
      if (on) ch.postFrameCallback(frameCb)
    } catch (_: Throwable) {}
  }

  fun setRoute(r: String) {
    if (r == route) return
    foldCurrent()
    route = r
  }

  private fun foldCurrent() {
    if (cur.empty()) return
    var key = if (route.isEmpty()) "-" else route
    if (!buckets.containsKey(key) && buckets.size >= MAX_ROUTES) key = "other"
    val b = buckets.getOrPut(key) { Bucket() }
    b.n += cur.n; b.sl += cur.sl; b.fz += cur.fz; b.j += cur.j
    if (cur.mx > b.mx) b.mx = cur.mx
    cur = Bucket()
  }

  private val memTick = object : Runnable {
    override fun run() {
      sampleMemory()
      memHandler?.postDelayed(this, MEM_TICK_MS)
    }
  }

  private fun sampleMemory() {
    try {
      // statm: size resident shared … (páginas)
      val parts = File("/proc/self/statm").readText().trim().split(' ')
      if (parts.size >= 2) {
        val mb = parts[1].toLong() * 4096L / 1_048_576L
        if (mb > 0) {
          rssCur = mb
          if (mb > rssPkWin) rssPkWin = mb
          if (mb > rssPkSession) rssPkSession = mb
        }
      }
    } catch (_: Throwable) {}
  }

  private fun samplePss() {
    try {
      val mi = android.os.Debug.MemoryInfo()
      android.os.Debug.getMemoryInfo(mi)
      pssLast = mi.totalPss / 1024L
    } catch (_: Throwable) {}
  }

  private fun closeWindow(why: String) {
    foldCurrent()
    val now = System.currentTimeMillis()
    val hasData = buckets.isNotEmpty() || trimWin.isNotEmpty() || lowMemWin > 0
    if (hasData) {
      val w = JSONObject()
      try {
        w.put("t0", winStart / 1000); w.put("t1", now / 1000); w.put("rr", refresh)
        val rts = JSONArray()
        for ((k, b) in buckets) {
          rts.put(JSONObject().put("r", k).put("n", b.n).put("sl", b.sl).put("fz", b.fz).put("mx", b.mx).put("j", b.j))
        }
        w.put("rt", rts)
        w.put("pk", rssPkWin); w.put("cur", rssCur)
        if (pssLast > 0) w.put("pss", pssLast)
        val rt = Runtime.getRuntime()
        w.put("jh", (rt.totalMemory() - rt.freeMemory()) / 1_048_576L)
        w.put("jmax", rt.maxMemory() / 1_048_576L)
        if (trimWin.isNotEmpty()) {
          val tm = JSONObject()
          for ((lv, n) in trimWin) tm.put(lv.toString(), n)
          w.put("trim", tm)
        }
        // "aviso de memória" ≈ iOS: níveis RUNNING_* (app em 1º plano) + onLowMemory
        w.put("mw", lowMemWin + trimWin.filterKeys { it in 5..15 }.values.sum())
        w.put("why", why)
      } catch (_: Throwable) {}
      synchronized(lock) {
        seq++
        try { w.put("s", seq) } catch (_: Throwable) {}
        pending.put(w)
        while (pending.length() > MAX_PENDING) pending.remove(0)
        prefs?.edit()?.putString(K_PENDING, pending.toString())?.putInt(K_SEQ, seq)?.apply()
      }
    }
    buckets.clear()
    trimWin = HashMap()
    lowMemWin = 0
    winStart = now
    rssPkWin = rssCur
    // PSS é caro (dezenas de ms) → 1× por janela, fora do main
    memHandler?.post { samplePss() }
    writeLive(false)
    if (hasData) try { emit?.invoke(mapOf("why" to why)) } catch (_: Throwable) {}
  }

  private fun writeLive(term: Boolean) {
    try {
      val o = JSONObject()
      o.put("t", System.currentTimeMillis() / 1000); o.put("r", route); o.put("fg", if (fg) 1 else 0)
      o.put("pk", rssPkSession); o.put("cur", rssCur); o.put("mw", trimSession)
      o.put("up", (SystemClock.elapsedRealtime() - sessionStart) / 1000)
      if (pssLast > 0) o.put("pss", pssLast)
      if (term) o.put("term", 1)
      if (lastFrozenAt > 0) { o.put("lzt", lastFrozenAt / 1000); o.put("lzm", lastFrozenMs) }
      prefs?.edit()?.putString(K_LIVE, o.toString())?.apply()
    } catch (_: Throwable) {}
  }

  // ─── leitura (thread do JS) ───
  fun peek(): Map<String, Any?> = synchronized(lock) {
    val m = HashMap<String, Any?>()
    m["windows"] = toList(pending)
    m["exits"] = toList(exits)
    m["seq"] = seq
    prevSession?.let { m["prev"] = toMap(it) }
    m
  }

  fun ack(upTo: Int, exitsCount: Int, prev: Boolean) {
    synchronized(lock) {
      val keep = JSONArray()
      for (i in 0 until pending.length()) {
        val w = pending.optJSONObject(i) ?: continue
        if (w.optInt("s", 0) > upTo) keep.put(w)
      }
      pending = keep
      var n = minOf(exitsCount, exits.length())
      while (n-- > 0) exits.remove(0)
      if (prev) prevSession = null
      prefs?.edit()?.putString(K_PENDING, pending.toString())?.putString(K_EXITS, exits.toString())?.apply()
    }
  }

  fun stats(): Map<String, Any?> = synchronized(lock) {
    mapOf(
      "running" to running, "fg" to fg, "route" to route, "rss" to rssCur, "rssPk" to rssPkSession,
      "pss" to pssLast, "pending" to pending.length(), "exits" to exits.length(), "rr" to refresh,
    )
  }

  private fun toList(a: JSONArray): List<Any?> {
    val out = ArrayList<Any?>(a.length())
    for (i in 0 until a.length()) out.add(toPlain(a.opt(i)))
    return out
  }

  private fun toMap(o: JSONObject): Map<String, Any?> {
    val m = HashMap<String, Any?>()
    val it = o.keys()
    while (it.hasNext()) { val k = it.next(); m[k] = toPlain(o.opt(k)) }
    return m
  }

  private fun toPlain(v: Any?): Any? = when (v) {
    is JSONObject -> toMap(v)
    is JSONArray -> toList(v)
    JSONObject.NULL -> null
    is Int -> v.toDouble()
    is Long -> v.toDouble()
    else -> v
  }
}

class ChatyyPerfModule : Module() {
  private val ctx: Context? get() = appContext.reactContext?.applicationContext
  private val main = Handler(Looper.getMainLooper())

  override fun definition() = ModuleDefinition {
    Name("ChatyyPerf")
    Events("onPerfWindow", "onMemoryTrim")

    OnCreate {
      ctx?.let { c -> try { ChatyyPerfCore.init(c) } catch (_: Throwable) {} }
      ChatyyPerfCore.emit = { body -> try { sendEvent("onPerfWindow", body) } catch (_: Throwable) {} }
      // [2026-10-19 perf-android] onTrimMemory → Glide + JS (independe do start/telemetria)
      ctx?.let { c -> try { ChatyyMemTrim.bind(c) } catch (_: Throwable) {} }
      ChatyyMemTrim.emit = { level -> try { sendEvent("onMemoryTrim", mapOf("level" to level)) } catch (_: Throwable) {} }
    }

    OnDestroy {
      ChatyyPerfCore.emit = null
      ChatyyMemTrim.emit = null
    }

    OnActivityEntersForeground {
      main.post { ChatyyPerfCore.setForeground(true) }
    }

    OnActivityEntersBackground {
      main.post { ChatyyPerfCore.setForeground(false) }
    }

    // 1 = quadros/memória/prev/saídas (2026-10-18)
    // 2 = evento onMemoryTrim {level} + Glide clearMemory/MemoryCategory.LOW (2026-10-19)
    Function("apiVersion") { 2 }

    Function("start") { opts: Map<String, Any?> ->
      val c = ctx
      if (c != null) {
        try { ChatyyPerfCore.init(c) } catch (_: Throwable) {}
        main.post { try { ChatyyPerfCore.start() } catch (_: Throwable) {} }
      }
      opts.size >= 0
    }

    Function("stop") {
      main.post { try { ChatyyPerfCore.stop() } catch (_: Throwable) {} }
      true
    }

    Function("setRoute") { r: String ->
      val route = r.take(48)
      main.post { ChatyyPerfCore.setRoute(route) }
      true
    }

    Function("peek") { ChatyyPerfCore.peek() }

    Function("ack") { seq: Int, exitsCount: Int, prev: Boolean ->
      ChatyyPerfCore.ack(seq, exitsCount, prev)
      true
    }

    Function("stats") { ChatyyPerfCore.stats() }
  }
}
