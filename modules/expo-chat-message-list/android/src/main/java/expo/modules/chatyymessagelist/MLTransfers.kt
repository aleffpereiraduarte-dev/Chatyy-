package expo.modules.chatyymessagelist

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.lang.ref.WeakReference
import java.text.NumberFormat
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

// [2026-10-15 native-media-dl] Download NATIVO de mídia recebida (apiVersion 5).
//   • OkHttp com leitura em blocos → progresso REAL por chave;
//   • chave estável do JS (`dl.k` = mediaCache.mediaUrlKey, sem exp/sig) = nome
//     do arquivo no MESMO diretório de cache do mediaCache → o JS adota o arquivo
//     (finishExternalDownload: syncIndex + store da conversa + galeria);
//   • cancelar mantém o `.part` → retomada com Range;
//   • 3 simultâneos; toque do usuário fura a fila;
//   • auto-download respeita a matriz (fotos/áudio/vídeos/docs × Wi-Fi/dados/
//     roaming) + economia de dados (app e sistema);
//   • progresso EXTERNO (download do JS / upload) entra por setTransfers.
// Estado só na main; o trabalho de rede roda num executor próprio.

data class MLMediaDL(
  val url: String,
  val key: String,
  val bucket: String,
  val size: Long,
  val alt: List<String>,
  val js: Boolean,
) {
  companion object {
    fun parse(v: Any?): MLMediaDL? {
      val d = v as? Map<*, *> ?: return null
      val url = MLRow.str(d["u"])
      val key = MLTransfers.safeKey(MLRow.str(d["k"]))
      if (url.isEmpty() || key.isEmpty()) return null
      val b = MLRow.str(d["a"]).ifEmpty { "photos" }
      val alt = ((d["alt"] as? List<*>) ?: emptyList<Any>()).map { MLRow.str(it) }.filter { it.isNotEmpty() }
      return MLMediaDL(url, key, b, (MLRow.num(d["sz"]) ?: 0.0).toLong().coerceAtLeast(0L), alt, MLRow.bool(d["js"]))
    }
  }
}

enum class MLXferState { NONE, QUEUED, RUNNING, PAUSED, DONE, FAILED }

class MLXfer(val key: String) {
  var state = MLXferState.NONE
  var loaded = 0L
  var total = 0L
  var local: String? = null
  var external = false
  var user = false
  var autoTried = false
  var retries = 0
  var approx = false
  val fraction: Float get() = if (total > 0) (loaded.toFloat() / total).coerceIn(0f, 1f) else 0f
}

interface MLTransferObserver {
  fun transferChanged(key: String)
  fun transferEvent(body: Map<String, Any>)
}

object MLTransfers {
  private const val MAX_CONCURRENT = 3
  private val main = Handler(Looper.getMainLooper())
  private val items = HashMap<String, MLXfer>()
  private val specs = HashMap<String, MLMediaDL>()
  private val queue = ArrayList<String>()
  private val running = HashMap<String, Job>()
  private val altIndex = HashMap<String, Int>()
  private val lastNotify = HashMap<String, Long>()
  private val owners = HashMap<String, WeakReference<MLTransferObserver>>()
  private val observers = ArrayList<WeakReference<MLTransferObserver>>()
  private val exec = Executors.newFixedThreadPool(MAX_CONCURRENT) { r -> Thread(r, "chatyy-ml-xfer").apply { isDaemon = true; priority = Thread.NORM_PRIORITY - 1 } }
  private val client: OkHttpClient by lazy {
    OkHttpClient.Builder()
      .connectTimeout(20, TimeUnit.SECONDS)
      .readTimeout(45, TimeUnit.SECONDS)
      .retryOnConnectionFailure(true)
      .build()
  }

  @Volatile var dir: File? = null
    private set
  private val policy = hashMapOf(
    "photos" to hashMapOf("wifi" to 1, "mobile" to 1, "roaming" to 0),
    "audio" to hashMapOf("wifi" to 1, "mobile" to 1, "roaming" to 0),
    "videos" to hashMapOf("wifi" to 1, "mobile" to 1, "roaming" to 0),
    "documents" to hashMapOf("wifi" to 1, "mobile" to 0, "roaming" to 0),
  )
  private var saver = false
  var ofTemplate = "{a} / {b}"
    private set
  private var appCtx: Context? = null

  private class Job(val key: String) {
    @Volatile var cancelled = false
    @Volatile var call: Call? = null
  }

  // ─── observadores ─────────────────────────────────────────────────────────
  fun addObserver(o: MLTransferObserver, ctx: Context?) {
    if (appCtx == null && ctx != null) appCtx = ctx.applicationContext
    observers.removeAll { it.get() == null || it.get() === o }
    observers.add(WeakReference(o))
  }

  fun removeObserver(o: MLTransferObserver) {
    observers.removeAll { it.get() == null || it.get() === o }
  }

  private fun notify(key: String, force: Boolean) {
    val now = SystemClock.uptimeMillis()
    if (!force) { val t = lastNotify[key]; if (t != null && now - t < 50) return }
    lastNotify[key] = now
    for (w in ArrayList(observers)) w.get()?.transferChanged(key)
  }

  private fun emit(key: String, st: String) {
    val body = HashMap<String, Any>()
    body["k"] = key; body["st"] = st
    specs[key]?.let { body["url"] = it.url; body["b"] = it.bucket }
    items[key]?.let { x -> x.local?.let { body["local"] = "file://$it" }; body["user"] = if (x.user) 1 else 0 }
    val target = owners[key]?.get() ?: observers.firstOrNull { it.get() != null }?.get()
    target?.transferEvent(body)
  }

  // ─── configuração / política ──────────────────────────────────────────────
  fun configure(d: Map<String, Any?>) {
    val s = MLRow.str(d["dir"])
    if (s.isNotEmpty()) {
      val path = if (s.startsWith("file://")) android.net.Uri.parse(s).path ?: "" else s
      if (path.startsWith("/")) {
        val f = File(path)
        try { f.mkdirs() } catch (_: Throwable) {}
        dir = f
      }
    }
    (d["policy"] as? Map<*, *>)?.forEach { (b, v) ->
      val cell = v as? Map<*, *> ?: return@forEach
      val m = HashMap<String, Int>()
      cell.forEach { (col, x) -> m[col.toString()] = if (MLRow.bool(x)) 1 else 0 }
      policy[b.toString()] = m
    }
    if (d.containsKey("saver")) saver = MLRow.bool(d["saver"])
    val t = MLRow.str(d["of"])
    if (t.contains("{a}") && t.contains("{b}")) ofTemplate = t
  }

  /** "wifi" | "mobile" | "roaming" | "none" */
  private fun network(): String {
    val ctx = appCtx ?: return "mobile"
    return try {
      val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return "mobile"
      val n = cm.activeNetwork ?: return "none"
      val caps = cm.getNetworkCapabilities(n) ?: return "none"
      if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) ||
        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)) return "wifi"
      if (Build.VERSION.SDK_INT >= 28 && !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_ROAMING)) return "roaming"
      "mobile"
    } catch (_: Throwable) { "mobile" }
  }

  private fun systemSaver(): Boolean {
    val ctx = appCtx ?: return false
    return try {
      val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
      cm.isActiveNetworkMetered && cm.restrictBackgroundStatus == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED
    } catch (_: Throwable) { false }
  }

  fun allowsAuto(bucket: String): Boolean {
    if (dir == null) return false
    val col = network()
    if (col == "none") return false
    if (col != "wifi" && (saver || systemSaver())) return false
    return (policy[bucket]?.get(col) ?: 0) == 1
  }

  // ─── estado ──────────────────────────────────────────────────────────────
  fun item(key: String): MLXfer? = if (key.isEmpty()) null else items[key]

  private fun ensure(key: String): MLXfer = items.getOrPut(key) { MLXfer(key) }

  /** Já no disco (baixado antes pelo JS ou por esta lista)? Marca done. */
  fun probe(dl: MLMediaDL): MLXfer {
    val x = ensure(dl.key)
    if (!specs.containsKey(dl.key)) specs[dl.key] = dl
    if (x.state == MLXferState.DONE) {
      val l = x.local
      if (l != null && File(l).exists()) return x
      x.state = MLXferState.NONE; x.local = null
    }
    val d = dir
    if (x.state == MLXferState.NONE && d != null) {
      val f = File(d, dl.key)
      if (f.length() > 0) {
        x.state = MLXferState.DONE; x.local = f.absolutePath; x.loaded = f.length(); x.total = x.loaded
        main.post { emit(dl.key, "done") }
      }
    }
    if (x.total <= 0 && dl.size > 0) x.total = dl.size
    return x
  }

  fun start(dl: MLMediaDL, user: Boolean, owner: MLTransferObserver?) {
    if (dir == null || dl.key.isEmpty()) return
    val x = probe(dl)
    specs[dl.key] = dl
    if (owner != null) owners[dl.key] = WeakReference(owner)
    if (x.state == MLXferState.DONE) { emit(dl.key, "done"); notify(dl.key, true); return }
    if (x.external && x.state == MLXferState.RUNNING) return
    if (x.state == MLXferState.RUNNING || x.state == MLXferState.QUEUED) {
      if (user) { val i = queue.indexOf(dl.key); if (i > 0) { queue.removeAt(i); queue.add(0, dl.key) } }
      return
    }
    x.user = x.user || user
    if (user) x.retries = 0 else x.autoTried = true
    x.state = MLXferState.QUEUED
    x.external = false
    if (user) queue.add(0, dl.key) else queue.add(dl.key)
    emit(dl.key, "start")
    notify(dl.key, true)
    pump()
  }

  fun cancel(key: String) {
    val x = items[key] ?: return
    queue.remove(key)
    running.remove(key)?.let { j -> j.cancelled = true; try { j.call?.cancel() } catch (_: Throwable) {} }
    if (x.state == MLXferState.QUEUED || x.state == MLXferState.RUNNING) {
      x.state = MLXferState.PAUSED
      x.user = true
      emit(key, "cancelled")
      notify(key, true)
      pump()
    }
  }

  /** Progresso vindo do JS. st: q | p (p 0..100) | d (l = caminho) | f | c */
  fun setExternal(list: List<Map<String, Any?>>) {
    for (e in list) {
      val key = safeKey(MLRow.str(e["k"]))
      if (key.isEmpty()) continue
      val x = ensure(key)
      val st = MLRow.str(e["st"])
      if (running.containsKey(key) && st != "d") continue
      when (st) {
        "q", "p" -> {
          if (x.state == MLXferState.DONE) continue
          x.external = true
          x.state = MLXferState.RUNNING
          val t = MLRow.num(e["t"])
          if (t != null && t > 0) { x.total = t.toLong(); x.approx = false }
          else if (x.total <= 0) {
            val sz = specs[key]?.size ?: 0L
            if (sz > 0) { x.total = sz; x.approx = false } else { x.total = 1000; x.approx = true }
          }
          val l = MLRow.num(e["l"])
          val p = MLRow.num(e["p"])
          if (l != null && l > 0) x.loaded = l.toLong()
          else if (p != null) x.loaded = (x.total * p.coerceIn(0.0, 100.0) / 100.0).toLong()
        }
        "d" -> {
          val l = MLRow.str(e["l"])
          val path = if (l.startsWith("file://")) android.net.Uri.parse(l).path ?: "" else l
          x.external = false
          x.state = MLXferState.DONE
          if (path.isNotEmpty()) x.local = path
          x.loaded = maxOf(x.loaded, x.total)
        }
        "f", "c" -> {
          if (x.state == MLXferState.DONE) continue
          x.external = false
          x.state = if (st == "c") MLXferState.PAUSED else MLXferState.FAILED
        }
        else -> continue
      }
      notify(key, st != "p")
    }
  }

  // ─── fila ────────────────────────────────────────────────────────────────
  private fun pump() {
    while (running.size < MAX_CONCURRENT && queue.isNotEmpty()) {
      val key = queue.removeAt(0)
      val x = items[key] ?: continue
      if (x.state != MLXferState.QUEUED) continue
      val dl = specs[key] ?: continue
      begin(key, dl, x)
    }
  }

  private fun begin(key: String, dl: MLMediaDL, x: MLXfer) {
    val d = dir ?: run { fail(key, x); return }
    val cands = listOf(dl.url) + dl.alt
    val src = cands[minOf(altIndex[key] ?: 0, cands.size - 1)]
    val job = Job(key)
    running[key] = job
    x.state = MLXferState.RUNNING
    notify(key, true)
    exec.execute { runJob(job, src, File(d, key), dl.size) }
  }

  /** Fila de rede. Resultado volta p/ a main. */
  private fun runJob(job: Job, src: String, dest: File, hint: Long) {
    val part = File(dest.parentFile, dest.name + ".part")
    var result = "fail" // ok | fail | notfound | net | cancel
    try {
      var have = if (part.exists()) part.length() else 0L
      val rb = Request.Builder().url(src)
      if (have > 0) rb.header("Range", "bytes=$have-")
      val call = client.newCall(rb.build())
      job.call = call
      if (job.cancelled) { call.cancel(); result = "cancel"; return }
      call.execute().use { resp ->
        val code = resp.code
        val ctype = (resp.header("Content-Type") ?: "").lowercase(Locale.US)
        if (code == 404 || code == 410 || code == 403 || ctype.startsWith("text/html")) { result = "notfound"; return@use }
        if (code !in 200..299) { result = if (code >= 500) "net" else "fail"; return@use }
        val body = resp.body ?: run { result = "fail"; return@use }
        val append = code == 206 && have > 0
        if (!append) have = 0
        val len = body.contentLength()
        val total = if (len > 0) len + have else hint
        main.post { items[job.key]?.let { if (total > 0) { it.total = total; it.approx = false }; it.loaded = have; notify(job.key, true) } }
        FileOutputStream(part, append).use { out ->
          val input = body.byteStream()
          val buf = ByteArray(64 * 1024)
          var done = have
          var lastPost = 0L
          while (true) {
            if (job.cancelled) { result = "cancel"; return@use }
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
            done += n
            val now = SystemClock.uptimeMillis()
            if (now - lastPost > 60) {
              lastPost = now
              val dd = done
              main.post { items[job.key]?.let { it.loaded = dd; notify(job.key, false) } }
            }
          }
          out.flush()
        }
        if (job.cancelled) { result = "cancel"; return@use }
        if (part.length() <= 0 || (len > 0 && part.length() != len + have)) { result = "net"; return@use }
        if (dest.exists()) dest.delete()
        result = if (part.renameTo(dest)) "ok" else "fail"
      }
    } catch (_: Throwable) {
      result = if (job.cancelled) "cancel" else "net"
    } finally {
      val r = result
      main.post { finishJob(job, r, dest) }
    }
  }

  private fun finishJob(job: Job, r: String, dest: File) {
    val key = job.key
    val current = running[key] === job
    if (current) running.remove(key)
    val x = items[key] ?: return
    if (r == "ok") {
      x.state = MLXferState.DONE
      x.local = dest.absolutePath
      x.loaded = maxOf(x.loaded, dest.length()); x.total = maxOf(x.total, x.loaded)
      altIndex.remove(key)
      emit(key, "done")
      notify(key, true)
      pump()
      return
    }
    if (!current || r == "cancel") { pump(); return }
    val spec = specs[key]
    when {
      r == "notfound" && spec != null && (altIndex[key] ?: 0) < spec.alt.size -> {
        altIndex[key] = (altIndex[key] ?: 0) + 1
        File(dest.parentFile, dest.name + ".part").delete()
        x.state = MLXferState.QUEUED
        queue.add(0, key)
        pump()
      }
      r == "net" && x.retries < 1 -> {
        x.retries++
        x.state = MLXferState.QUEUED
        notify(key, true)
        main.postDelayed({ if (x.state == MLXferState.QUEUED) { queue.add(key); pump() } }, 1500)
        pump()
      }
      else -> {
        if (r == "notfound") File(dest.parentFile, dest.name + ".part").delete()
        fail(key, x)
      }
    }
  }

  private fun fail(key: String, x: MLXfer) {
    x.state = MLXferState.FAILED
    emit(key, "failed")
    notify(key, true)
    pump()
  }

  // ─── util ────────────────────────────────────────────────────────────────
  fun safeKey(k: String): String {
    if (k.isEmpty() || k.length > 160 || k.startsWith(".")) return ""
    for (c in k) if (!(c in '0'..'9' || c in 'a'..'z' || c in 'A'..'Z' || c == '.' || c == '_' || c == '-')) return ""
    return k
  }

  fun formatBytes(b: Long): String {
    if (b <= 0) return ""
    val d = b.toDouble()
    if (d < 1024) return "$b B"
    if (d < 1024 * 1024) return "${Math.round(d / 1024)} KB"
    val nf = NumberFormat.getNumberInstance(Locale.getDefault()).apply { minimumFractionDigits = 1; maximumFractionDigits = 1 }
    val mb = d / (1024 * 1024)
    return if (mb < 1000) nf.format(mb) + " MB" else nf.format(mb / 1024) + " GB"
  }

  fun progressText(x: MLXfer): String {
    if (x.total <= 0 || x.approx) return ""
    return ofTemplate.replace("{a}", formatBytes(maxOf(x.loaded, 1L))).replace("{b}", formatBytes(x.total))
  }
}
