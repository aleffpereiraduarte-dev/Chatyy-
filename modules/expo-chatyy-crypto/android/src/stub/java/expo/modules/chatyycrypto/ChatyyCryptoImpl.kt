// [e2ee5 WP-03] Modo STUB (build sem o núcleo: sem .so/bindings). Mesma assinatura do
// ChatyyCryptoImpl do modo núcleo (src/core/java/.../ChatyyCrypto.kt). Toda chamada rejeita
// 'unsupported'; info().coreLinked = false e o JS trata o módulo como ausente.
package expo.modules.chatyycrypto

import android.content.Context
import org.json.JSONObject

internal object ChatyyCryptoImpl {
  const val CORE_LINKED = false

  @Suppress("UNUSED_PARAMETER")
  suspend fun invoke(ctx: Context, op: String, args: String): String =
    throw ChatyyCryptoHostException.of("unsupported", "what" to "core_not_linked")

  fun describe(e: Throwable): Pair<String, JSONObject> = when (e) {
    is ChatyyCryptoHostException -> e.code to e.details
    else -> "internal" to JSONObject().put("msg", e.javaClass.simpleName)
  }

  @Suppress("UNUSED_PARAMETER")
  fun addListener(cb: (String, Map<String, Any?>) -> Unit): Any = Any()

  @Suppress("UNUSED_PARAMETER")
  fun removeListener(token: Any) {}
}
