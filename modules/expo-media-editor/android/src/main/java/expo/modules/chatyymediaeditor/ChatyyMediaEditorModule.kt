package expo.modules.chatyymediaeditor

import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * [2026-10-15 native-editor] Editor de foto/vídeo nativo antes de enviar.
 * JS: ChatyyMediaEditor.open(options) → Promise<result> (resolve UMA vez:
 * action 'send' | 'done' | 'cancel' | 'error'). Ver modules/expo-media-editor/index.ts.
 */
class ChatyyMediaEditorModule : Module() {

  companion object {
    private const val TAG = "ChatyyMediaEditor"
  }

  private var current: MediaEditorDialog? = null

  override fun definition() = ModuleDefinition {
    Name("ChatyyMediaEditor")

    // 2 = cropShape 'circle' (recorte circular p/ avatar/perfil)
    Function("apiVersion") { 2 }

    AsyncFunction("open") { options: Map<String, Any?>, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null || activity.isFinishing) {
        promise.resolve(mapOf("action" to "error", "error" to "no_activity"))
        return@AsyncFunction
      }
      val uri = options["uri"] as? String
      if (uri.isNullOrEmpty()) {
        promise.resolve(mapOf("action" to "error", "error" to "no_uri"))
        return@AsyncFunction
      }
      current?.let { old ->
        current = null
        try { old.closeFromJS() } catch (_: Throwable) {}
      }
      val opts = try { parse(options, uri) } catch (t: Throwable) {
        promise.resolve(mapOf("action" to "error", "error" to "bad_options"))
        return@AsyncFunction
      }
      var settled = false
      var dlg: MediaEditorDialog? = null
      dlg = MediaEditorDialog(activity, opts) { result ->
        if (settled) return@MediaEditorDialog
        settled = true
        if (current === dlg) current = null
        try { promise.resolve(result) } catch (t: Throwable) { Log.w(TAG, "resolve: ${t.message}") }
      }
      current = dlg
      try {
        dlg.show()
      } catch (t: Throwable) {
        Log.w(TAG, "show failed: ${t.message}")
        current = null
        if (!settled) { settled = true; promise.resolve(mapOf("action" to "error", "error" to "show_failed")) }
      }
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

  private fun bool(v: Any?, def: Boolean): Boolean = (v as? Boolean) ?: def

  private fun parse(o: Map<String, Any?>, uri: String): MEOptions {
    val labels = HashMap<String, String>()
    (o["labels"] as? Map<*, *>)?.forEach { (k, v) -> if (k is String && v is String) labels[k] = v }
    val filters = ArrayList<MEFilter>()
    (o["filters"] as? List<*>)?.forEach { f ->
      val m = f as? Map<*, *> ?: return@forEach
      val id = m["id"] as? String ?: return@forEach
      val label = (m["label"] as? String) ?: id
      val arr = (m["m"] as? List<*>)?.mapNotNull { num(it)?.toFloat() }
      val mat = if (id != "original" && arr != null && arr.size == 20) arr.toFloatArray() else null
      if (id == "original") filters.removeAll { it.id == "original" }
      if (id == "original") filters.add(0, MEFilter(id, label, null)) else filters.add(MEFilter(id, label, mat))
    }
    if (filters.isNotEmpty() && filters[0].id != "original") {
      // índice 0 = sem filtro (o estado começa em 0)
      filters.add(0, MEFilter("original", labels["filterOriginal"] ?: "Original", null))
    }
    val stickers = (o["stickers"] as? List<*>)?.mapNotNull { it as? String }?.filter { it.isNotEmpty() }?.take(64) ?: emptyList()
    val type = (o["type"] as? String) ?: "image"
    val tools = o["tools"] as? Map<*, *>
    fun tool(k: String) = (tools?.get(k) as? Boolean) ?: true
    return MEOptions(
      uri = uri,
      isVideo = type == "video",
      compose = ((o["mode"] as? String) ?: "compose") == "compose",
      caption = (o["caption"] as? String) ?: "",
      captionMax = num(o["captionMax"])?.toInt() ?: 1024,
      viewOnce = bool(o["viewOnce"], false),
      allowViewOnce = bool(o["allowViewOnce"], true),
      hd = bool(o["hd"], false),
      allowHd = bool(o["allowHd"], true),
      filters = filters,
      stickers = stickers,
      labels = labels,
      maxDim = (num(o["maxDim"])?.toInt() ?: 3072).coerceIn(640, 8192),
      hdMaxDim = (num(o["hdMaxDim"])?.toInt() ?: 4096).coerceIn(640, 8192),
      quality = ((num(o["quality"]) ?: 0.92) * 100).toInt().coerceIn(40, 100),
      secure = bool(o["secure"], false),
      allowCrop = tool("crop"),
      allowDraw = tool("draw"),
      allowText = tool("text"),
      allowStickers = tool("stickers"),
      allowFilters = tool("filters"),
      allowTrim = tool("trim"),
      allowMute = tool("mute"),
      allowCover = tool("cover"),
      circleCrop = (o["cropShape"] as? String) == "circle" && type != "video",
    )
  }
}
