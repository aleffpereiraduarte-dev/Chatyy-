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

    // [2026-10-24 mapa-v2] bateria p/ o envio em 1º plano (JS friendMapShare.postShareUpdate)
    Function("getBattery") {
      val ctx = context
      val b = if (ctx == null) null else FriendLocationPinger.battery(ctx)
      if (b == null) mapOf<String, Any?>("level" to -1, "charging" to false)
      else mapOf<String, Any?>("level" to b.first, "charging" to b.second)
    }

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
