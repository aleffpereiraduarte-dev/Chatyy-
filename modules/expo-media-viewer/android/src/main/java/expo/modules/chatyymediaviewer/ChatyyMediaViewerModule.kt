package expo.modules.chatyymediaviewer

import android.util.Log
import com.bumptech.glide.Glide
import com.bumptech.glide.load.engine.DiskCacheStrategy
import com.bumptech.glide.load.resource.bitmap.DownsampleStrategy
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * [2026-10-14 native-viewer] Visualizador de mídia nativo (ver
 * MediaViewerDialog). JS: ChatyyMediaViewer.open({ items, index, labels,
 * allowShare, allowSave, allowForward, allowStar }) → session id (0 = falhou).
 * Eventos (todos com `session`): onIndexChange {index}, onAction {action,
 * index, messageId, starred?}, onClose {index, reason}.
 */
class ChatyyMediaViewerModule : Module() {

  companion object {
    private const val TAG = "ChatyyMediaViewer"
  }

  private var current: MediaViewerDialog? = null
  private var session = 0

  override fun definition() = ModuleDefinition {
    Name("ChatyyMediaViewer")

    Events("onIndexChange", "onAction", "onClose")

    // 2 = aceita `secure` (FLAG_SECURE no Dialog) [2026-10-14 adv-privacy]
    Function("apiVersion") { 2 }

    AsyncFunction("open") { options: Map<String, Any?> ->
      val activity = appContext.currentActivity ?: return@AsyncFunction 0
      if (activity.isFinishing) return@AsyncFunction 0
      val rawItems = options["items"] as? List<*> ?: emptyList<Any?>()
      val items = ArrayList<MVItem>()
      for (r in rawItems) {
        val m = r as? Map<*, *> ?: continue
        items.add(MVItem.from(m))
      }
      if (items.isEmpty()) return@AsyncFunction 0

      current?.let { old ->
        current = null
        try { old.closeSilently() } catch (_: Throwable) {}
      }

      session += 1
      val sid = session
      val labels = HashMap<String, String>()
      (options["labels"] as? Map<*, *>)?.forEach { (k, v) ->
        if (k is String && v is String) labels[k] = v
      }
      val flags = MVFlags(
        allowShare = (options["allowShare"] as? Boolean) ?: true,
        allowSave = (options["allowSave"] as? Boolean) ?: true,
        allowForward = (options["allowForward"] as? Boolean) ?: true,
        allowStar = (options["allowStar"] as? Boolean) ?: true,
        secure = (options["secure"] as? Boolean) ?: false,
      )
      val index = when (val v = options["index"]) {
        is Number -> v.toInt()
        else -> 0
      }.coerceIn(0, items.size - 1)
      val snapshot = items.toList()

      val dlg = MediaViewerDialog(activity, items, index, labels, flags, object : MediaViewerDialog.Listener {
        override fun onIndexChange(index: Int) {
          emit("onIndexChange", mapOf("session" to sid, "index" to index))
        }

        override fun onAction(action: String, index: Int, extra: Map<String, Any?>) {
          val body = HashMap<String, Any?>()
          body["session"] = sid
          body["action"] = action
          body["index"] = index
          if (index in snapshot.indices) body["messageId"] = snapshot[index].messageId
          body.putAll(extra)
          emit("onAction", body)
        }

        override fun onClose(index: Int, reason: String) {
          emit("onClose", mapOf("session" to sid, "index" to index, "reason" to reason))
        }
      })
      current = dlg
      try {
        dlg.show()
      } catch (t: Throwable) {
        Log.w(TAG, "show failed: ${t.message}")
        current = null
        return@AsyncFunction 0
      }
      sid
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("close") {
      val d = current ?: return@AsyncFunction false
      current = null
      d.closeFromJS()
      true
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("setActionState") { action: String, state: String ->
      val d = current ?: return@AsyncFunction false
      d.setActionState(action, state)
      true
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("prefetch") { uris: List<String> ->
      val ctx = appContext.reactContext?.applicationContext ?: return@AsyncFunction false
      val g = Glide.with(ctx)
      for (u in uris) {
        val model = MVItem.glideModel(u) ?: continue
        try {
          g.load(model).override(MVPageView.FULL_PX, MVPageView.FULL_PX)
            .downsample(DownsampleStrategy.CENTER_INSIDE)
            .diskCacheStrategy(DiskCacheStrategy.AUTOMATIC)
            .preload()
        } catch (_: Throwable) {}
      }
      true
    }.runOnQueue(Queues.MAIN)
  }

  private fun emit(name: String, body: Map<String, Any?>) {
    try {
      sendEvent(name, body)
    } catch (t: Throwable) {
      Log.w(TAG, "emit $name failed: ${t.message}")
    }
  }
}
