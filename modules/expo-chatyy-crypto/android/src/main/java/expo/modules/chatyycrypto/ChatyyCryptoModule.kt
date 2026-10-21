// [e2ee5 WP-03] Módulo Expo "ChatyyCrypto" (Android): casca fina sobre ChatyyCryptoImpl
// (núcleo: src/core/java → ChatyyCrypto público; stub: src/stub/java).
//
// JS (modules/expo-chatyy-crypto/index.ts → services/crypto/index.native.js):
//   info()                → {apiVersion, coreLinked, platform, process}   (síncrono)
//   nativeEnabled(uid)    → Boolean (último e2ee5_native gravado; síncrono)
//   invoke(op, argsJson)  → Promise<String JSON {"v": resultado}>
//   eventos: onSyncResult, onNewKeys, onIdentityChanged, onIdentityViolation, onNativeFlag
// Erro: reject(code, "e2ee5:<code> <detalhes JSON>") — o JS remonta `.code/.details/.reason`.
package expo.modules.chatyycrypto

import android.content.Context
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class ChatyyCryptoModule : Module() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  @Volatile private var listenerToken: Any? = null

  private val ctx: Context?
    get() = appContext.reactContext?.applicationContext

  override fun definition() = ModuleDefinition {
    Name("ChatyyCrypto")

    Events("onSyncResult", "onNewKeys", "onIdentityChanged", "onIdentityViolation", "onNativeFlag")

    Function("info") {
      mapOf(
        "apiVersion" to ChatyyCryptoConst.API_VERSION,
        "coreLinked" to ChatyyCryptoImpl.CORE_LINKED,
        "platform" to "android",
        "process" to "app",
      )
    }

    Function("nativeEnabled") { uid: String ->
      val c = ctx ?: return@Function false
      if (uid.isEmpty()) ChatyyCryptoFlags.nativeForLast(c) else ChatyyCryptoFlags.native(c, uid)
    }

    AsyncFunction("invoke") { op: String, args: String, promise: Promise ->
      val c = ctx
      if (c == null) {
        promise.reject("not_ready", "e2ee5:not_ready {}", null)
      } else {
        scope.launch {
          try {
            promise.resolve(ChatyyCryptoImpl.invoke(c, op, args))
          } catch (t: Throwable) {
            val (code, details) = ChatyyCryptoImpl.describe(t)
            promise.reject(code, "e2ee5:$code $details", null)
          }
        }
      }
    }

    OnStartObserving {
      if (listenerToken == null) {
        listenerToken = ChatyyCryptoImpl.addListener { name, body -> try { sendEvent(name, body) } catch (_: Throwable) {} }
      }
    }

    OnStopObserving {
      listenerToken?.let { ChatyyCryptoImpl.removeListener(it) }
      listenerToken = null
    }

    OnDestroy {
      listenerToken?.let { ChatyyCryptoImpl.removeListener(it) }
      listenerToken = null
      scope.cancel()
    }
  }
}
