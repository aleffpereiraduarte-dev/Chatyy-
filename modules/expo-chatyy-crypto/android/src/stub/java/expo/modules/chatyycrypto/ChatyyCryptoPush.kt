// [e2ee5 WP-03 → WP-10] Modo STUB: mesma API do ChatyyCryptoPush do núcleo; sempre null/false.
package expo.modules.chatyycrypto

import android.content.Context

@Suppress("UNUSED_PARAMETER")
object ChatyyCryptoPush {
  const val CORE_LINKED = false

  @JvmStatic
  fun decryptPreview(context: Context, uid: String, pushData: Map<String, String>, timeoutMs: Long): String? = null

  @JvmStatic
  fun decryptPreview(
    context: Context, uid: String, convId: String, mid: String, cmid: String, senderUid: String,
    envelopeJson: String, timeoutMs: Long,
  ): String? = null

  @JvmStatic
  fun eligible(context: Context, uid: String): Boolean = false

  @JvmStatic
  fun uidForAccount(context: Context, account: String): String? = null
}
