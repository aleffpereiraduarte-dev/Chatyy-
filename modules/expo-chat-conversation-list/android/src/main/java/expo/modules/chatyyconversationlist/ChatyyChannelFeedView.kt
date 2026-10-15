package expo.modules.chatyyconversationlist

// [2026-10-15 native-social] Aba CANAIS (Android) — view ChatyyChannelFeed.
// Lógica em CHListCore; aqui só os EventDispatcher e os filhos RN.

import android.annotation.SuppressLint
import android.content.Context
import android.view.View
import android.widget.LinearLayout
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

@SuppressLint("ViewConstructor")
class ChatyyChannelFeedView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  val onRowPress by EventDispatcher()
  val onRowAction by EventDispatcher()
  val onRefresh by EventDispatcher()
  val onEndReached by EventDispatcher()
  val onResync by EventDispatcher()
  val onFirstPaint by EventDispatcher()
  val onNativeError by EventDispatcher()

  internal val core = CHListCore(context) { name, payload -> dispatch(name, payload) }

  private fun dispatch(name: String, raw: Map<String, Any?>) {
    val payload = HashMap<String, Any>()
    for ((k, v) in raw) if (v != null) payload[k] = v
    when (name) {
      "onRowPress" -> onRowPress(payload)
      "onRowAction" -> onRowAction(payload)
      "onRefresh" -> onRefresh(payload)
      "onEndReached" -> onEndReached(payload)
      "onResync" -> onResync(payload)
      "onFirstPaint" -> onFirstPaint(payload)
      else -> onNativeError(payload)
    }
  }

  fun commitProps() = core.commitProps(this)
  fun addRnChild(child: View, index: Int) = core.addRnChild(child, index)
  fun rnChildCount(): Int = core.rnChildCount()
  fun rnChildAt(index: Int): View? = core.rnChildAt(index)
  fun removeRnChild(child: View) = core.removeRnChild(child)
  fun removeRnChildAt(index: Int) = core.removeRnChildAt(index)

  init {
    addView(core.refresh, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT))
  }

  override fun onDetachedFromWindow() {
    core.dispose()
    super.onDetachedFromWindow()
  }
}
