package expo.modules.chatyystatusstudio

import android.graphics.Color
import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * [2026-10-15 native-status-studio] Estúdio de status nativo (câmera fica no
 * expo-chat-attach). JS: modules/expo-status-studio/index.ts →
 * ChatyyStatusStudio.open(options) → Promise<result> (resolve UMA vez).
 * onRequest {reqId, kind:'musicSearch'|'gallery'|'location', q?} → JS chama respond(reqId, data).
 */
class ChatyyStatusStudioModule : Module() {

  companion object {
    private const val TAG = "ChatyyStatusStudio"
  }

  private var current: StatusStudioDialog? = null
  private var seq = 0
  private val pending = HashMap<Int, (Map<String, Any?>?) -> Unit>()

  override fun definition() = ModuleDefinition {
    Name("ChatyyStatusStudio")

    Events("onRequest")

    Function("apiVersion") { 1 }

    AsyncFunction("open") { options: Map<String, Any?>, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null || activity.isFinishing) {
        promise.resolve(null)
        return@AsyncFunction
      }
      current?.let { old -> current = null; try { old.closeFromJS() } catch (_: Throwable) {} }
      val opts = try { parse(options) } catch (t: Throwable) {
        Log.w(TAG, "bad options: ${t.message}")
        promise.resolve(mapOf("action" to "error", "error" to "bad_options"))
        return@AsyncFunction
      }
      var settled = false
      var dlg: StatusStudioDialog? = null
      dlg = StatusStudioDialog(activity, opts, { kind, q, cb ->
        seq += 1
        val id = seq
        pending[id] = cb
        try {
          sendEvent("onRequest", mapOf("reqId" to id, "kind" to kind, "q" to (q ?: "")))
        } catch (t: Throwable) {
          pending.remove(id)
          cb(null)
        }
      }) { result ->
        if (settled) return@StatusStudioDialog
        settled = true
        if (current === dlg) current = null
        pending.clear()
        try { promise.resolve(result) } catch (t: Throwable) { Log.w(TAG, "resolve: ${t.message}") }
      }
      current = dlg
      try {
        dlg.show()
      } catch (t: Throwable) {
        Log.w(TAG, "show failed: ${t.message}")
        current = null
        if (!settled) { settled = true; promise.resolve(null) }
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("respond") { reqId: Int, data: Map<String, Any?>? ->
      val cb = pending.remove(reqId) ?: return@AsyncFunction false
      try { cb(data) } catch (t: Throwable) { Log.w(TAG, "respond: ${t.message}") }
      true
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("close") {
      val d = current ?: return@AsyncFunction false
      current = null
      d.closeFromJS()
      true
    }.runOnQueue(Queues.MAIN)
  }

  private fun num(v: Any?): Double? = when (v) {
    is Number -> v.toDouble()
    is String -> v.toDoubleOrNull()
    else -> null
  }

  private fun str(v: Any?): String = (v as? String) ?: ""

  private fun parse(o: Map<String, Any?>): SSOptions {
    val labels = HashMap<String, String>()
    (o["labels"] as? Map<*, *>)?.forEach { (k, v) -> if (k is String && v is String) labels[k] = v }

    val items = ArrayList<SSMediaIn>()
    (o["items"] as? List<*>)?.forEach { raw ->
      val m = raw as? Map<*, *> ?: return@forEach
      val uri = m["uri"] as? String ?: return@forEach
      if (uri.isEmpty() || items.size >= 10) return@forEach
      items.add(SSMediaIn(uri, (m["type"] as? String) == "video", num(m["width"])?.toInt() ?: 0, num(m["height"])?.toInt() ?: 0,
        (m["filter"] as? String)?.takeIf { it.isNotEmpty() }, (m["boomerang"] as? Boolean) ?: false))
    }

    val filters = ArrayList<SSFilter>()
    (o["filters"] as? List<*>)?.forEach { f ->
      val m = f as? Map<*, *> ?: return@forEach
      val id = m["id"] as? String ?: return@forEach
      val label = (m["label"] as? String) ?: id
      val arr = (m["m"] as? List<*>)?.mapNotNull { num(it)?.toFloat() }
      if (id == "original") filters.add(0, SSFilter(id, label, null))
      else filters.add(SSFilter(id, label, if (arr != null && arr.size == 20) arr.toFloatArray() else null))
    }
    if (filters.isEmpty() || filters[0].id != "original") filters.add(0, SSFilter("original", labels["filterOriginal"] ?: "Original", null))

    val bgs = ArrayList<SSBackground>()
    (o["textBackgrounds"] as? List<*>)?.forEach { b ->
      val m = b as? Map<*, *> ?: return@forEach
      val value = m["value"] as? String ?: return@forEach
      val cols = (m["colors"] as? List<*>)?.mapNotNull { it as? String }?.map { SSUtil.parseColor(it, Color.rgb(17, 17, 17)) } ?: emptyList()
      bgs.add(SSBackground(value, if (cols.isEmpty()) intArrayOf(SSUtil.parseColor(value, Color.rgb(17, 17, 17))) else cols.toIntArray()))
    }
    if (bgs.isEmpty()) {
      for (h in listOf("#111111", "#54656F", "#0F766E", "#15803D", "#0E7490", "#2563EB", "#4F46E5", "#7C3AED", "#C026D3", "#DB2777", "#DC2626", "#EA580C")) {
        bgs.add(SSBackground(h, intArrayOf(SSUtil.parseColor(h, Color.BLACK))))
      }
    }

    val fonts = ArrayList<SSFont>()
    (o["fonts"] as? List<*>)?.forEach { f ->
      val m = f as? Map<*, *> ?: return@forEach
      val id = m["id"] as? String ?: return@forEach
      fonts.add(SSFont(id, (m["label"] as? String) ?: id))
    }
    if (fonts.isEmpty()) {
      fonts.addAll(listOf(SSFont("sans", "Padrão"), SSFont("serif", "Serifa"), SSFont("mono", "Máquina"), SSFont("script", "Manuscrita"), SSFont("condensed", "Condensada")))
    }

    var palHex = (o["palette"] as? List<*>)?.mapNotNull { it as? String }?.filter { it.isNotEmpty() } ?: emptyList()
    if (palHex.isEmpty()) palHex = listOf("#FFFFFF", "#000000", "#9CA3AF", "#EF4444", "#F97316", "#FACC15", "#22C55E", "#14B8A6", "#3B82F6", "#8B5CF6", "#EC4899")
    val palette = palHex.map { SSUtil.parseColor(it, Color.WHITE) }.toIntArray()

    var emojis = (o["emojis"] as? List<*>)?.mapNotNull { it as? String }?.filter { it.isNotEmpty() }?.take(96) ?: emptyList()
    if (emojis.isEmpty()) emojis = listOf(
      "😀", "😂", "😍", "🥳", "🔥", "✨", "❤️", "👍", "👏", "🎉", "💯", "⭐", "😎", "🤩", "🙌", "😘",
      "😭", "😱", "🤔", "🙄", "🙏", "💪", "🌹", "🎈", "☀️", "🌙", "🌈", "⚡", "🍕", "☕", "🎶", "📍",
    )

    val contacts = (o["contacts"] as? List<*>)?.mapNotNull { c ->
      val m = c as? Map<*, *> ?: return@mapNotNull null
      val e = m["email"] as? String ?: return@mapNotNull null
      if (e.isEmpty()) null else SSContact(e, (m["name"] as? String)?.takeIf { it.isNotEmpty() } ?: e.substringBefore("@"))
    } ?: emptyList()

    fun track(m: Map<*, *>?): SSTrack? {
      if (m == null) return null
      val title = str(m["title"])
      val url = str(m["previewUrl"]).ifEmpty { str(m["preview_url"]) }
      if (title.isEmpty() && url.isEmpty()) return null
      return SSTrack(
        id = (m["id"] ?: "").toString(), title = title, artist = str(m["artist"]), previewUrl = url,
        coverUrl = str(m["coverUrl"]).ifEmpty { str(m["image_url"]) }, durationSec = num(m["durationSec"]) ?: num(m["duration_sec"]) ?: 0.0,
        startMs = num(m["startMs"])?.toLong() ?: 0L,
      )
    }
    val catalog = (o["musicCatalog"] as? List<*>)?.mapNotNull { track(it as? Map<*, *>) } ?: emptyList()

    val textMode = (o["mode"] as? String) == "text" || items.isEmpty()
    return SSOptions(
      textMode = textMode,
      items = items,
      labels = labels,
      filters = filters,
      backgrounds = bgs,
      bgIndex = (num(o["textBgIndex"])?.toInt() ?: 0).coerceIn(0, bgs.size - 1),
      fonts = fonts,
      textMax = (num(o["textMax"])?.toInt() ?: 700).coerceIn(1, 5000),
      palette = palette,
      paletteHex = palHex,
      emojis = emojis,
      contacts = contacts,
      catalog = catalog,
      music = track(o["music"] as? Map<*, *>),
      audience = (o["audience"] as? String)?.takeIf { it in listOf("all", "contacts", "close_friends", "except") } ?: "all",
      closeFriendsCount = num(o["closeFriendsCount"])?.toInt() ?: -1,
      exceptCount = num(o["exceptCount"])?.toInt() ?: 0,
      canCamera = (o["canCamera"] as? Boolean) ?: false,
      canGallery = (o["canGallery"] as? Boolean) ?: true,
    )
  }
}
