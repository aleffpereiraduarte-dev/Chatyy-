// [e2ee5 WP-03 → WP-10] API estável para o serviço FCM (CallFirebaseMessagingService /
// ChatMessagingStyleHandler) decifrar a prévia do push SEM JS. Mesma assinatura no source set
// stub (lá devolve sempre null). BLOQUEANTE: chamar fora da main thread (onMessageReceived já
// roda numa worker thread); na main thread devolve null de cara.
//
// Falha fechado (→ null, o chamador mostra "Nova mensagem"): núcleo ausente, uid inválido,
// e2ee5_native ou e2ee5_push_decrypt ≠ true (gravados pelo último status()), store/aparelho
// inexistente (o push NUNCA cria), sem `e2e_c` (e2e_fetch fica com o chamador), UTD depois de
// 1 sync, timeout, qualquer erro. Devolve o payload v1 decifrado (JSON, CONTRATO §2.3) — o render
// do texto é do WP-10. Nunca loga conteúdo.
package expo.modules.chatyycrypto

import android.content.Context
import android.os.Looper
import com.chatyy.crypto.core.CoreException
import com.chatyy.crypto.core.DecryptInput
import com.chatyy.crypto.core.ProcessRole
import com.chatyy.crypto.core.UtdReason
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

object ChatyyCryptoPush {
  const val CORE_LINKED = true

  /** Chaves do §7: e2e="5", e2e_c, e2e_conv, e2e_mid, e2e_cmid, e2e_sender_uid. */
  @JvmStatic
  fun decryptPreview(context: Context, uid: String, pushData: Map<String, String>, timeoutMs: Long): String? {
    if (pushData["e2e"] != "5") return null
    val env = pushData["e2e_c"].orEmpty()
    if (env.isEmpty()) return null
    return decryptPreview(
      context, uid, pushData["e2e_conv"].orEmpty(), pushData["e2e_mid"].orEmpty(), pushData["e2e_cmid"].orEmpty(),
      pushData["e2e_sender_uid"].orEmpty(), env, timeoutMs,
    )
  }

  @JvmStatic
  fun decryptPreview(
    context: Context, uid: String, convId: String, mid: String, cmid: String, senderUid: String,
    envelopeJson: String, timeoutMs: Long,
  ): String? {
    if (Looper.myLooper() == Looper.getMainLooper()) return null
    if (envelopeJson.isEmpty() || convId.isEmpty() || senderUid.isEmpty()) return null
    val app = context.applicationContext ?: return null
    if (!eligible(app, uid)) return null
    return try {
      runBlocking {
        withTimeoutOrNull(timeoutMs.coerceIn(500L, 9000L)) {
          val core = ChatyyCrypto.core(app, uid, ProcessRole.PUSH)
          val input = DecryptInput(
            convId = convId, envelopeJson = envelopeJson, senderUid = senderUid, serverMid = mid, cmid = cmid,
            tsMs = System.currentTimeMillis().toULong(),
          )
          try {
            core.decrypt(input).payloadJson
          } catch (e: CoreException.Utd) {
            if (!retryable(e.reason)) return@withTimeoutOrNull null
            ChatyyCrypto.sync(app, uid, "native")
            core.decrypt(input).payloadJson
          }
        }
      }
    } catch (_: Throwable) {
      null
    }
  }

  /** Sem rede e sem abrir nada: flags gravadas + store/segredos já existentes. */
  @JvmStatic
  fun eligible(context: Context, uid: String): Boolean {
    val app = context.applicationContext ?: return false
    return ChatyyCryptoFiles.isValidUid(uid) &&
      ChatyyCryptoFlags.native(app, uid) &&
      ChatyyCryptoFlags.pushDecrypt(app, uid) &&
      ChatyyCryptoSecrets.exists(app, uid)
  }

  /** uid ligado à conta (e-mail) do push pelo último status(); null = sem mapeamento. */
  @JvmStatic
  fun uidForAccount(context: Context, account: String): String? =
    context.applicationContext?.let { ChatyyCryptoFlags.uidForAccount(it, account) }

  private fun retryable(r: UtdReason) = when (r) {
    UtdReason.MISSING_SESSION, UtdReason.UNKNOWN_INDEX, UtdReason.UNTRUSTED_DEVICE, UtdReason.STORE -> true
    else -> false
  }
}
