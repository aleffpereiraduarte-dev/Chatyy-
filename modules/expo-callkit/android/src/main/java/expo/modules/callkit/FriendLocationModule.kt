package expo.modules.callkit

import android.content.Context
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * [2026-10-12 find-my] Ponte JS ↔ FriendLocationPinger ("ChatyyFriendLocation").
 * O JS detecta com requireOptionalNativeModule (binário antigo → null).
 * No Android, start() só persiste a flag (o push "Pedir atualização" é
 * respondido nativamente) + liga as atualizações passivas SE houver
 * ACCESS_BACKGROUND_LOCATION (hoje fora do manifest → dormente).
 */
class FriendLocationModule : Module() {

  private val context: Context?
    get() = appContext.reactContext?.applicationContext

  override fun definition() = ModuleDefinition {
    Name("ChatyyFriendLocation")

    Function("version") { 1 }

    Function("isSupported") { true }

    AsyncFunction("start") { acct: String ->
      val ctx = context
      if (ctx == null) {
        mapOf<String, Any?>("enabled" to false)
      } else {
        FriendLocationPinger.setEnabled(ctx, true, acct)
        FriendLocationPinger.syncPassive(ctx)
        FriendLocationPinger.status(ctx)
      }
    }

    AsyncFunction("stop") {
      val ctx = context
      if (ctx != null) {
        FriendLocationPinger.setEnabled(ctx, false, null)
        FriendLocationPinger.stopPassive(ctx)
      }
    }

    Function("getStatus") {
      val ctx = context
      if (ctx == null) mapOf<String, Any?>("enabled" to false) else FriendLocationPinger.status(ctx)
    }

    AsyncFunction("requestOnce") { promise: Promise ->
      val ctx = context
      if (ctx == null) {
        promise.resolve(false)
      } else {
        Thread({
          val ok = try { FriendLocationPinger.publishNowBlocking(ctx) } catch (_: Throwable) { false }
          promise.resolve(ok)
        }, "chatyy-friendloc-once").start()
      }
    }
  }
}
