package expo.modules.nativetoolkit

import android.util.Log
import com.google.mlkit.common.model.DownloadConditions
import com.google.mlkit.nl.translate.TranslateLanguage
import com.google.mlkit.nl.translate.Translation
import com.google.mlkit.nl.translate.Translator
import com.google.mlkit.nl.translate.TranslatorOptions

/**
 * [2026-10-09 android-ml-parity] ML Kit on-device translation.
 *
 * ONLY compiled when the build runs with CHATYY_MLKIT_TRANSLATE=1
 * (modules/expo-native-toolkit/android/build.gradle adds this source dir and
 * the com.google.mlkit:translate dependency). ExpoNativeChatSecurityModule
 * loads it by reflection; without the gate the class doesn't exist and
 * `getOnDeviceCapabilities().translate` is false.
 *
 * Cost: the engine is a bundled native lib (~16 MB arm64 / ~11.6 MB armv7
 * uncompressed, ~6.8 MB compressed download per ABI split). Language models
 * (~30 MB each) are NOT in the APK: downloaded on demand, Wi-Fi only unless
 * the caller allows cellular.
 */
class ChatyyMlTranslatorImpl : ChatyyOnDeviceTranslator {

  companion object {
    private const val TAG = "ChatyyMlTranslator"
    private const val MAX_CLIENTS = 3
  }

  // Small LRU of open translators (each holds a loaded model in memory).
  private val clients = LinkedHashMap<String, Translator>(MAX_CLIENTS + 1, 0.75f, true)

  override fun isSupported(tag: String): Boolean = try {
    TranslateLanguage.fromLanguageTag(tag) != null
  } catch (_: Throwable) {
    false
  }

  private fun client(source: String, target: String): Translator? {
    val src = TranslateLanguage.fromLanguageTag(source) ?: return null
    val dst = TranslateLanguage.fromLanguageTag(target) ?: return null
    val key = "$src>$dst"
    synchronized(clients) {
      clients[key]?.let { return it }
      val t = Translation.getClient(
        TranslatorOptions.Builder().setSourceLanguage(src).setTargetLanguage(dst).build()
      )
      clients[key] = t
      while (clients.size > MAX_CLIENTS) {
        val eldest = clients.entries.iterator().next()
        try { eldest.value.close() } catch (_: Throwable) {}
        clients.remove(eldest.key)
      }
      return t
    }
  }

  override fun translate(
    text: String,
    source: String,
    target: String,
    allowCellular: Boolean,
    cb: (String?, String?) -> Unit,
  ) {
    val t = try { client(source, target) } catch (e: Throwable) { null }
    if (t == null) { cb(null, "unsupported_language"); return }
    val conditions = if (allowCellular) DownloadConditions.Builder().build()
      else DownloadConditions.Builder().requireWifi().build()
    try {
      t.downloadModelIfNeeded(conditions)
        .addOnSuccessListener {
          t.translate(text)
            .addOnSuccessListener { out -> cb(out, null) }
            .addOnFailureListener { e -> cb(null, e.message ?: "translate_failed") }
        }
        .addOnFailureListener { e ->
          // Typically "no Wi-Fi" while the model isn't downloaded yet; the
          // download is retried on the next call.
          Log.w(TAG, "model download pending: ${e.message}")
          cb(null, "model_not_downloaded")
        }
    } catch (e: Throwable) {
      cb(null, e.message ?: "translate_failed")
    }
  }

  override fun close() {
    synchronized(clients) {
      for (t in clients.values) { try { t.close() } catch (_: Throwable) {} }
      clients.clear()
    }
  }
}
