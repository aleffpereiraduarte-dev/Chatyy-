package expo.modules.inappbanner

import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * [2026-10-16 native-toast] Banner de notificação dentro do app (Android).
 * Mesmo contrato do iOS (ios/ChatyyInAppBannerModule.swift):
 *   show(opts) → Boolean · dismiss(id?) · apiVersion() = 1
 *   eventos onBannerPress/onBannerDismiss/onBannerReply/onBannerExpand ({ id, reason?, text? })
 * A view mora no decorView da Activity; animações = ViewPropertyAnimator
 * (Choreographer da UI thread, taxa do display) — independente do JS.
 */
class ChatyyInAppBannerModule : Module() {

  companion object {
    private const val TAG = "ChatyyInAppBanner"
  }

  private var current: IABannerView? = null
  private val main = Handler(Looper.getMainLooper())

  private val listener = object : IABannerView.Listener {
    override fun onPress(v: IABannerView) {
      if (current !== v) return
      emit("onBannerPress", mapOf("id" to v.options.id))
      finish(v, "press")
    }

    override fun onSwipeAway(v: IABannerView) { finish(v, "swipe") }

    override fun onClose(v: IABannerView) { finish(v, "close") }

    override fun onTimeout(v: IABannerView) { finish(v, "timeout") }

    override fun onExpand(v: IABannerView) {
      if (current !== v) return
      emit("onBannerExpand", mapOf("id" to v.options.id))
    }

    override fun onReply(v: IABannerView, text: String) {
      if (current !== v) return
      emit("onBannerReply", mapOf("id" to v.options.id, "text" to text))
      finish(v, "reply")
    }
  }

  private fun finish(v: IABannerView, reason: String) {
    if (current === v) current = null
    val id = v.options.id
    v.slideAway(fast = false) {
      emit("onBannerDismiss", mapOf("id" to id, "reason" to reason))
    }
  }

  override fun definition() = ModuleDefinition {
    Name("ChatyyInAppBanner")

    Events("onBannerPress", "onBannerDismiss", "onBannerReply", "onBannerExpand")

    // 1 = [2026-10-16] show/dismiss + press/dismiss/reply/expand.
    Function("apiVersion") { 1 }

    AsyncFunction("show") { opts: Map<String, Any?> ->
      val activity = appContext.currentActivity ?: return@AsyncFunction false
      if (activity.isFinishing) return@AsyncFunction false
      val o = IABannerOptions.from(opts)
      if (o.title.isEmpty() && o.body.isEmpty()) return@AsyncFunction false
      val decor = activity.window?.decorView as? ViewGroup ?: return@AsyncFunction false
      current?.let { old ->
        current = null
        val oid = old.options.id
        old.slideAway(fast = true) {
          emit("onBannerDismiss", mapOf("id" to oid, "reason" to "replaced"))
        }
      }
      try {
        val v = IABannerView(activity, o, listener)
        decor.addView(v, v.makeLayoutParams(decor))
        current = v
        v.present()
        true
      } catch (t: Throwable) {
        Log.w(TAG, "show failed: ${t.message}")
        false
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("dismiss") { id: String? ->
      val v = current
      if (v != null && (id.isNullOrEmpty() || id == v.options.id)) finish(v, "js")
    }.runOnQueue(Queues.MAIN)

    OnActivityDestroys {
      main.post {
        current?.removeNow()
        current = null
      }
    }

    OnDestroy {
      main.post {
        current?.removeNow()
        current = null
      }
    }
  }

  private fun emit(name: String, body: Map<String, Any?>) {
    try {
      sendEvent(name, body)
    } catch (t: Throwable) {
      Log.w(TAG, "emit $name failed: ${t.message}")
    }
  }
}
