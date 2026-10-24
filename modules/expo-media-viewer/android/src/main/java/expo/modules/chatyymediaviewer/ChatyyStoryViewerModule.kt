package expo.modules.chatyymediaviewer

import android.util.Log
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * [2026-10-15 native-story] Visualizador de STATUS nativo (ver
 * StoryViewerDialog). JS: modules/expo-media-viewer/story.ts.
 * Eventos (todos com `session`): onItemShown, onItemCompleted, onGroupChange,
 * onReply, onReact, onOpenViewers, onCloseViewers, onViewerPress, onMenu,
 * onLink, onSticker (apiVersion 2), onNeedMore, onClose.
 */
class ChatyyStoryViewerModule : Module() {

  companion object {
    private const val TAG = "ChatyyStoryViewer"
  }

  private var current: StoryViewerDialog? = null
  private var session = 0

  override fun definition() = ModuleDefinition {
    Name("ChatyyStoryViewer")

    Events(
      "onItemShown", "onItemCompleted", "onGroupChange", "onReply", "onReact",
      "onOpenViewers", "onCloseViewers", "onViewerPress", "onMenu", "onLink",
      "onSticker", "onNeedMore", "onClose"
    )

    // 2 = blocos/voz/boomerang/animação de texto/duplo toque/menu por item.
    // 3 = `originRect` (abre do anel do avatar e volta para ele) [2026-10-16 motion]
    // 4 = reações livres [2026-10-17 status-reacoes]: `reactionHold` (segurar o
    //     coração abre a bolha), `reactionPicker` ("+" com a grade de emojis),
    //     setViewers rows[].emoji (emoji real na lista).
    // 5 = zoom [status-zoom 2026-10-23]: `zoom` no open() + item.hires (original > 1.5x)
    Function("apiVersion") { 5 }

    AsyncFunction("open") { options: Map<String, Any?> ->
      val activity = appContext.currentActivity ?: return@AsyncFunction 0
      if (activity.isFinishing) return@AsyncFunction 0
      val groups = ArrayList<SVGroup>()
      (options["groups"] as? List<*>)?.forEach { r ->
        val m = r as? Map<*, *> ?: return@forEach
        val g = SVGroup.from(m)
        if (g.items.isNotEmpty()) groups.add(g)
      }
      if (groups.isEmpty()) return@AsyncFunction 0

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
      val reactions = ArrayList<SVReaction>()
      (options["reactions"] as? List<*>)?.forEach { r ->
        val m = r as? Map<*, *> ?: return@forEach
        val e = m["emoji"] as? String ?: return@forEach
        if (e.isNotEmpty()) reactions.add(SVReaction(e, (m["kind"] as? String) ?: "heart"))
      }
      if (reactions.isEmpty()) reactions.add(SVReaction("❤️", "heart"))
      val startGroup = (SVItem.num(options["startGroup"])?.toInt() ?: 0).coerceIn(0, groups.size - 1)
      SVItem.num(options["startItem"])?.toInt()?.let { si ->
        if (si >= 0) {
          val g = groups[startGroup]
          g.index = si.coerceIn(0, g.items.size - 1)
        }
      }
      var dlgRef: StoryViewerDialog? = null
      val dlg = StoryViewerDialog(
        activity,
        groups,
        startGroup,
        SVLabels(labels),
        reactions,
        ((options["transition"] as? String) ?: "cube") != "slide",
        (options["hasMoreNext"] as? Boolean) ?: false,
        (options["hasMorePrev"] as? Boolean) ?: false,
        object : StoryViewerDialog.Listener {
          override fun emit(name: String, body: Map<String, Any?>) {
            val b = HashMap<String, Any?>(body)
            b["session"] = sid
            try {
              sendEvent(name, b)
            } catch (t: Throwable) {
              Log.w(TAG, "emit $name failed: ${t.message}")
            }
          }

          override fun onFinished() {
            if (current === dlgRef) current = null
          }
        },
      )
      dlgRef = dlg
      // [2026-10-17 status-reacoes] JS controla (kill switch __chatyy_story_reactions)
      options["reactionPicker"]?.let { SVEmojiStore.update(it) }
      dlg.reactionHold = (options["reactionHold"] as? Boolean) ?: false
      dlg.zoomEnabled = (options["zoom"] as? Boolean) ?: false // [status-zoom 2026-10-23]
      // [2026-10-16 motion] frame do anel tocado (dp do RN, coordenadas de janela)
      if (MVMotion.storyOrigin && !MVMotion.reduceMotion) {
        (options["originRect"] as? Map<*, *>)?.let { m ->
          fun f(k: String): Float? = (m[k] as? Number)?.toFloat()?.takeIf { x -> !x.isNaN() && !x.isInfinite() }
          val x = f("x"); val y = f("y"); val w = f("width"); val h = f("height")
          if (x != null && y != null && w != null && h != null && w >= 2f && h >= 2f) {
            dlg.setOrigin(android.graphics.RectF(x, y, x + w, y + h))
          }
        }
      }
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

    AsyncFunction("pause") {
      val d = current ?: return@AsyncFunction false
      d.setPausedFromJS(true)
      true
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("resume") {
      val d = current ?: return@AsyncFunction false
      d.setPausedFromJS(false)
      true
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("updateItem") { id: String, patch: Map<String, Any?> ->
      val d = current ?: return@AsyncFunction false
      d.updateItem(id, patch)
      true
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("removeItem") { id: String ->
      val d = current ?: return@AsyncFunction false
      d.removeItem(id)
      true
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("appendGroup") { group: Map<String, Any?>, direction: String ->
      val d = current ?: return@AsyncFunction false
      d.appendGroup(SVGroup.from(group), if (direction == "prev") "prev" else "next")
      true
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("setHasMore") { next: Boolean, prev: Boolean ->
      val d = current ?: return@AsyncFunction false
      d.setHasMore(next, prev)
      true
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("setViewers") { id: String, rows: List<Map<String, Any?>>, loading: Boolean ->
      val d = current ?: return@AsyncFunction false
      d.setViewers(id, rows, loading)
      true
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("showToast") { text: String ->
      val d = current ?: return@AsyncFunction false
      d.showToast(text)
      true
    }.runOnQueue(Queues.MAIN)
  }
}
