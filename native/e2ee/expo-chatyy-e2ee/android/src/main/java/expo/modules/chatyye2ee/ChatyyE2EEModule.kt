package expo.modules.chatyye2ee

// E2EE v4 nativo (Android). Fina camada Expo por cima do vodozemac (Rust,
// via UniFFI → expo.modules.chatyye2ee.core). NENHUMA criptografia aqui: só
// um mapa de handles (Int) para o JS (services/e2eeV4Native.js) montar as
// MESMAS classes do wasm do web. Funções síncronas de propósito (o núcleo JS
// usa a API síncrona do wasm). Bytes como base64.

import android.util.Base64
import expo.modules.chatyye2ee.core.E2eeException
import expo.modules.chatyye2ee.core.InboundResult
import expo.modules.chatyye2ee.core.MegolmInbound
import expo.modules.chatyye2ee.core.MegolmOutbound
import expo.modules.chatyye2ee.core.OlmAccount
import expo.modules.chatyye2ee.core.OlmSession
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.MessageDigest
import java.security.SecureRandom
import expo.modules.chatyye2ee.core.coreVersion as rustCoreVersion
import expo.modules.chatyye2ee.core.ed25519Verify as rustEd25519Verify
import expo.modules.chatyye2ee.core.preKeySessionId as rustPreKeySessionId

private class E2EEException(message: String, cause: Throwable? = null) :
  CodedException("ERR_E2EE", message, cause)

private class Handles {
  private var next = 1
  private val objects = HashMap<Int, AutoCloseable>()

  @Synchronized fun put(o: AutoCloseable): Int {
    val h = next++
    objects[h] = o
    return h
  }

  @Synchronized fun <T> get(h: Int, cls: Class<T>): T {
    val o = objects[h] ?: throw E2EEException("e2ee: invalid handle $h")
    if (!cls.isInstance(o)) throw E2EEException("e2ee: handle $h is not ${cls.simpleName}")
    return cls.cast(o)!!
  }

  @Synchronized fun free(h: Int) {
    objects.remove(h)?.let { runCatching { it.close() } }
  }

  @Synchronized fun count(): Int = objects.size
}

private fun key(b64: String): ByteArray {
  val k = try { Base64.decode(b64, Base64.DEFAULT) } catch (e: IllegalArgumentException) { null }
  if (k == null || k.size != 32) throw E2EEException("e2ee: pickle key must be 32 bytes (base64)")
  return k
}

private fun msgType(t: Int): UInt {
  if (t < 0) throw E2EEException("e2ee: bad message type")
  return t.toUInt()
}

/** E2eeException (Rust) → CodedException (JS Error with code ERR_E2EE). */
private inline fun <T> core(f: () -> T): T =
  try { f() } catch (e: E2eeException) { throw E2EEException("e2ee: ${e.message}", e) }

class ChatyyE2EEModule : Module() {
  private val h = Handles()
  private val rng = SecureRandom()

  override fun definition() = ModuleDefinition {
    Name("ChatyyE2EE")

    // ---- diagnostics / availability (a .so pode faltar → false, nunca crash)
    Function("available") {
      try { rustCoreVersion().isNotEmpty() } catch (t: Throwable) { false }
    }
    Function("coreVersion") { rustCoreVersion() }
    Function("liveHandles") { h.count() }

    // ---- utilities
    Function("ed25519Verify") { pk: String, msg: String, sig: String -> rustEd25519Verify(pk, msg, sig) }
    Function("preKeySessionId") { t: Int, b: String -> if (t < 0) "" else rustPreKeySessionId(t.toUInt(), b) }
    Function("randomBytes") { n: Int ->
      if (n <= 0 || n > 4096) throw E2EEException("e2ee: bad length")
      val out = ByteArray(n)
      rng.nextBytes(out)
      Base64.encodeToString(out, Base64.NO_WRAP)
    }
    Function("sha512") { b64: String ->
      val d = Base64.decode(b64, Base64.DEFAULT)
      Base64.encodeToString(MessageDigest.getInstance("SHA-512").digest(d), Base64.NO_WRAP)
    }
    Function("free") { handle: Int -> h.free(handle) }

    // ---- Olm account
    Function("accountNew") { h.put(OlmAccount()) }
    Function("accountFromPickle") { pickle: String, k: String -> h.put(core { OlmAccount.fromPickle(pickle, key(k)) }) }
    Function("accountPickle") { a: Int, k: String -> core { h.get(a, OlmAccount::class.java).pickle(key(k)) } }
    Function("accountCurve25519") { a: Int -> h.get(a, OlmAccount::class.java).curve25519() }
    Function("accountEd25519") { a: Int -> h.get(a, OlmAccount::class.java).ed25519() }
    Function("accountSign") { a: Int, msg: String -> h.get(a, OlmAccount::class.java).sign(msg) }
    Function("accountGenerateOneTimeKeys") { a: Int, n: Int ->
      if (n < 0 || n > 1000) throw E2EEException("e2ee: bad count")
      h.get(a, OlmAccount::class.java).generateOneTimeKeys(n.toUInt())
    }
    Function("accountOneTimeKeys") { a: Int -> h.get(a, OlmAccount::class.java).oneTimeKeys() }
    Function("accountGenerateFallbackKey") { a: Int -> h.get(a, OlmAccount::class.java).generateFallbackKey() }
    Function("accountFallbackKey") { a: Int -> h.get(a, OlmAccount::class.java).fallbackKey() }
    Function("accountMarkKeysAsPublished") { a: Int -> h.get(a, OlmAccount::class.java).markKeysAsPublished() }
    Function("accountMaxOneTimeKeys") { a: Int -> h.get(a, OlmAccount::class.java).maxOneTimeKeys().toInt() }
    Function("accountCreateOutboundSession") { a: Int, ik: String, otk: String ->
      h.put(core { h.get(a, OlmAccount::class.java).createOutboundSession(ik, otk) })
    }
    Function("accountCreateInboundSession") { a: Int, ik: String, t: Int, b: String ->
      val r: InboundResult = core { h.get(a, OlmAccount::class.java).createInboundSession(ik, msgType(t), b) }
      mapOf("session" to h.put(r.session), "plaintext" to r.plaintext)
    }

    // ---- Olm session
    Function("sessionFromPickle") { pickle: String, k: String -> h.put(core { OlmSession.fromPickle(pickle, key(k)) }) }
    Function("sessionPickle") { s: Int, k: String -> core { h.get(s, OlmSession::class.java).pickle(key(k)) } }
    Function("sessionId") { s: Int -> h.get(s, OlmSession::class.java).sessionId() }
    Function("sessionEncrypt") { s: Int, pt: String -> core { h.get(s, OlmSession::class.java).encrypt(pt) } }
    Function("sessionDecrypt") { s: Int, t: Int, b: String -> core { h.get(s, OlmSession::class.java).decrypt(msgType(t), b) } }

    // ---- Megolm (grupos — fase 2)
    Function("megolmOutboundNew") { h.put(MegolmOutbound()) }
    Function("megolmOutboundFromPickle") { pickle: String, k: String -> h.put(core { MegolmOutbound.fromPickle(pickle, key(k)) }) }
    Function("megolmOutboundPickle") { g: Int, k: String -> core { h.get(g, MegolmOutbound::class.java).pickle(key(k)) } }
    Function("megolmOutboundSessionId") { g: Int -> h.get(g, MegolmOutbound::class.java).sessionId() }
    Function("megolmOutboundSessionKey") { g: Int -> h.get(g, MegolmOutbound::class.java).sessionKey() }
    Function("megolmOutboundEncrypt") { g: Int, pt: String -> h.get(g, MegolmOutbound::class.java).encrypt(pt) }
    Function("megolmInboundNew") { sk: String -> h.put(core { MegolmInbound(sk) }) }
    Function("megolmInboundFromPickle") { pickle: String, k: String -> h.put(core { MegolmInbound.fromPickle(pickle, key(k)) }) }
    Function("megolmInboundPickle") { g: Int, k: String -> core { h.get(g, MegolmInbound::class.java).pickle(key(k)) } }
    Function("megolmInboundSessionId") { g: Int -> h.get(g, MegolmInbound::class.java).sessionId() }
    Function("megolmInboundDecrypt") { g: Int, m: String -> core { h.get(g, MegolmInbound::class.java).decrypt(m) } }
  }
}
