package expo.modules.nativetoolkit

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.AudioFormat
import android.media.ExifInterface
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.speech.RecognitionListener
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import androidx.core.content.ContextCompat
import com.google.android.gms.common.api.OptionalModuleApi
import com.google.android.gms.common.moduleinstall.ModuleInstall
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.nl.languageid.LanguageIdentification
import com.google.mlkit.nl.languageid.LanguageIdentifier
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteOrder
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * On-device translator, implemented by ChatyyMlTranslatorImpl
 * (android/src/mlkitTranslate/java — compiled ONLY when the build runs with
 * CHATYY_MLKIT_TRANSLATE=1; see android/build.gradle). Loaded by reflection so
 * the main sources compile without the ML Kit Translate dependency.
 */
interface ChatyyOnDeviceTranslator {
  /** BCP-47 base tag supported by the on-device engine ("pt", "en", ...). */
  fun isSupported(tag: String): Boolean

  /**
   * Translate [text] from [source] to [target] (BCP-47 base tags). Models are
   * downloaded on demand (Wi-Fi only unless [allowCellular]). Calls [cb] once,
   * on any thread, with (translated, null) or (null, errorCode).
   */
  fun translate(text: String, source: String, target: String, allowCellular: Boolean, cb: (String?, String?) -> Unit)

  fun close()
}

/**
 * [2026-10-09 android-ml-parity] Android half of `ExpoNativeChatSecurity` —
 * same module name and same JS contract as the iOS module
 * (modules/expo-native-toolkit/ios/ExpoNativeChatSecurity.swift) for the
 * on-device intelligence functions. The iOS module also carries CryptoKit
 * E2E + Spotlight + biometrics; those are NOT here (JS must keep checking
 * `typeof mod.encryptMessage === 'function'` before using them).
 *
 *   ocrImage(uri, locales?)            → { text, blocks[], error? }   (ML Kit Text Recognition v2, Latin)
 *   detectLanguageSync(text)           → "pt" | "und"                 (ML Kit Language ID, ≤350 ms)
 *   detectLanguage(text)               → Promise<string>
 *   translateText(text, target)        → Promise<string>  (text unchanged when unavailable — same as iOS stub)
 *   translateTextOnDevice(text, target, source?, allowCellular?) → { text?, sourceLang?, error? }
 *   requestSpeechPermission()          → Promise<boolean>  (RECORD_AUDIO)
 *   transcribeAudioFile(uri, locale?)  → Promise<string>   ("" when unavailable — same as iOS)
 *   getOnDeviceCapabilities()          → { ocr, languageId, translate, transcribe, sdk }
 *   prepareOnDeviceModels(opts?)       → asks Play services / the speech service to fetch models now
 *
 * APK cost: OCR and Language ID are the UNBUNDLED Play services variants
 * (model downloaded by Play services on first use / ModuleInstall; ~0.5 MB of
 * classes in the APK). Speech uses the platform on-device recognizer
 * (Android 13+, language packs downloaded on demand by the system). The
 * translation engine has no unbundled variant (+16 MB native lib per ABI), so
 * it is behind the CHATYY_MLKIT_TRANSLATE build gate (OFF by default).
 */
class ExpoNativeChatSecurityModule : Module() {

  companion object {
    private const val TAG = "ExpoNativeChatSecurity"
    private const val TRANSLATOR_IMPL = "expo.modules.nativetoolkit.ChatyyMlTranslatorImpl"
    private const val OCR_MAX_SIDE = 2560
    private const val SPEECH_RATE = 16000
    private const val SPEECH_MAX_SECONDS = 15 * 60
  }

  private val worker = Executors.newSingleThreadExecutor()
  private val mainHandler = Handler(Looper.getMainLooper())

  @Volatile private var textRecognizer: TextRecognizer? = null
  @Volatile private var languageIdentifier: LanguageIdentifier? = null
  @Volatile private var ocrInstallRequested = false
  @Volatile private var langIdInstallRequested = false
  @Volatile private var activeSpeech: SpeechRecognizer? = null

  private val translator: ChatyyOnDeviceTranslator? by lazy {
    try {
      Class.forName(TRANSLATOR_IMPL).getDeclaredConstructor().newInstance() as? ChatyyOnDeviceTranslator
    } catch (_: Throwable) {
      null
    }
  }

  private fun ctx(): Context? = appContext.reactContext?.applicationContext

  // ─── ML Kit clients (lazy; unbundled → Play services owns the model) ────

  private fun ocrClient(): TextRecognizer {
    textRecognizer?.let { return it }
    synchronized(this) {
      textRecognizer?.let { return it }
      val c = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
      textRecognizer = c
      return c
    }
  }

  private fun langIdClient(): LanguageIdentifier {
    languageIdentifier?.let { return it }
    synchronized(this) {
      languageIdentifier?.let { return it }
      val c = LanguageIdentification.getClient()
      languageIdentifier = c
      return c
    }
  }

  /** Ask Play services to download an unbundled model now (idempotent per api). */
  private fun requestInstall(api: OptionalModuleApi, which: String) {
    val c = ctx() ?: return
    if (which == "ocr") { if (ocrInstallRequested) return; ocrInstallRequested = true }
    if (which == "langid") { if (langIdInstallRequested) return; langIdInstallRequested = true }
    try {
      val req = ModuleInstallRequest.newBuilder().addApi(api).build()
      ModuleInstall.getClient(c).installModules(req)
        .addOnSuccessListener { Log.i(TAG, "$which model install ok (already=${it.areModulesAlreadyInstalled()})") }
        .addOnFailureListener { e ->
          Log.w(TAG, "$which model install failed: ${e.message}")
          if (which == "ocr") ocrInstallRequested = false else langIdInstallRequested = false
        }
    } catch (t: Throwable) {
      Log.w(TAG, "$which model install threw: ${t.message}")
      if (which == "ocr") ocrInstallRequested = false else langIdInstallRequested = false
    }
  }

  private fun hasPlayServices(c: Context): Boolean = try {
    com.google.android.gms.common.GoogleApiAvailability.getInstance()
      .isGooglePlayServicesAvailable(c) == com.google.android.gms.common.ConnectionResult.SUCCESS
  } catch (_: Throwable) {
    false
  }

  private fun speechAvailable(c: Context): Boolean {
    if (Build.VERSION.SDK_INT < 33) return false
    return try { SpeechRecognizer.isOnDeviceRecognitionAvailable(c) } catch (_: Throwable) { false }
  }

  private fun baseTag(tag: String?): String {
    val t = (tag ?: "").trim().replace('_', '-')
    if (t.isEmpty()) return ""
    return t.split('-')[0].lowercase(Locale.ROOT)
  }

  override fun definition() = ModuleDefinition {
    Name("ExpoNativeChatSecurity")

    // ─── Capabilities ────────────────────────────────────────────────
    Function("getOnDeviceCapabilities") {
      val c = ctx()
      val gms = c != null && hasPlayServices(c)
      mapOf(
        "platform" to "android",
        "sdk" to Build.VERSION.SDK_INT,
        "ocr" to gms,
        "languageId" to gms,
        "translate" to (translator != null),
        "transcribe" to (c != null && speechAvailable(c)),
        "transcribeFromFile" to (c != null && speechAvailable(c)),
      )
    }

    AsyncFunction("prepareOnDeviceModels") { opts: Map<String, Any?>?, promise: Promise ->
      try {
        val c = ctx()
        val want = (opts?.get("features") as? List<*>)?.map { it.toString() }
        fun wants(f: String) = want == null || want.contains(f)
        if (c != null && hasPlayServices(c)) {
          if (wants("ocr")) requestInstall(ocrClient(), "ocr")
          if (wants("languageId")) requestInstall(langIdClient(), "langid")
        }
        val locale = opts?.get("locale")?.toString()
        if (c != null && wants("transcribe") && Build.VERSION.SDK_INT >= 33 && speechAvailable(c)) {
          mainHandler.post { triggerSpeechModelDownload(c, locale ?: Locale.getDefault().toLanguageTag()) }
        }
        promise.resolve(true)
      } catch (t: Throwable) {
        promise.resolve(false)
      }
    }

    // ─── OCR (same shape as iOS Vision: lines, normalized, origin bottom-left) ─
    AsyncFunction("ocrImage") { imageUri: String, locales: List<String>?, promise: Promise ->
      val c = ctx()
      if (c == null) {
        promise.resolve(mapOf("text" to "", "blocks" to emptyList<Any>(), "error" to "no_context"))
        return@AsyncFunction
      }
      worker.execute {
        try {
          val bmp = loadBitmap(c, imageUri)
          if (bmp == null) {
            promise.resolve(mapOf("text" to "", "blocks" to emptyList<Any>(), "error" to "load_failed"))
            return@execute
          }
          val w = bmp.width.toDouble()
          val h = bmp.height.toDouble()
          ocrClient().process(InputImage.fromBitmap(bmp, 0))
            .addOnSuccessListener(worker) { result ->
              val lines = ArrayList<String>()
              val blocks = ArrayList<Map<String, Any>>()
              for (block in result.textBlocks) {
                for (line in block.lines) {
                  val txt = line.text ?: continue
                  if (txt.isBlank()) continue
                  lines.add(txt)
                  val r = line.boundingBox
                  val conf = try { line.confidence.toDouble() } catch (_: Throwable) { 1.0 }
                  if (r != null && w > 0 && h > 0) {
                    blocks.add(mapOf(
                      "text" to txt,
                      "confidence" to conf,
                      "x" to (r.left / w),
                      "y" to (1.0 - r.bottom / h),
                      "width" to (r.width() / w),
                      "height" to (r.height() / h),
                    ))
                  } else {
                    blocks.add(mapOf("text" to txt, "confidence" to conf, "x" to 0.0, "y" to 0.0, "width" to 0.0, "height" to 0.0))
                  }
                }
              }
              promise.resolve(mapOf("text" to lines.joinToString("\n"), "blocks" to blocks))
            }
            .addOnFailureListener(worker) { e ->
              // Model not downloaded yet (MlKitException UNAVAILABLE) → ask Play
              // services for it; the next call runs on-device.
              requestInstall(ocrClient(), "ocr")
              promise.resolve(mapOf("text" to "", "blocks" to emptyList<Any>(), "error" to (e.message ?: "ocr_failed")))
            }
        } catch (t: Throwable) {
          promise.resolve(mapOf("text" to "", "blocks" to emptyList<Any>(), "error" to (t.message ?: "ocr_failed")))
        }
      }
    }

    // ─── Language ID ─────────────────────────────────────────────────
    Function("detectLanguageSync") { text: String ->
      if (text.isBlank()) return@Function "und"
      try {
        val tag = Tasks.await(langIdClient().identifyLanguage(text), 350, TimeUnit.MILLISECONDS)
        if (tag.isNullOrEmpty()) "und" else tag
      } catch (t: Throwable) {
        requestInstall(langIdClient(), "langid")
        "und"
      }
    }

    AsyncFunction("detectLanguage") { text: String, promise: Promise ->
      if (text.isBlank()) { promise.resolve("und"); return@AsyncFunction }
      try {
        langIdClient().identifyLanguage(text)
          .addOnSuccessListener { tag -> promise.resolve(if (tag.isNullOrEmpty()) "und" else tag) }
          .addOnFailureListener {
            requestInstall(langIdClient(), "langid")
            promise.resolve("und")
          }
      } catch (t: Throwable) {
        promise.resolve("und")
      }
    }

    // ─── Translation ─────────────────────────────────────────────────
    // Same contract as iOS: resolves the ORIGINAL text when it can't translate
    // (JS falls through to the server). Use translateTextOnDevice for errors.
    AsyncFunction("translateText") { text: String, targetLang: String, promise: Promise ->
      translateInternal(text, targetLang, null, false) { out, _, _ -> promise.resolve(out ?: text) }
    }

    AsyncFunction("translateTextOnDevice") { text: String, targetLang: String, sourceLang: String?, allowCellular: Boolean?, promise: Promise ->
      translateInternal(text, targetLang, sourceLang, allowCellular == true) { out, src, err ->
        if (out != null) promise.resolve(mapOf("text" to out, "sourceLang" to (src ?: "und"), "targetLang" to baseTag(targetLang)))
        else promise.resolve(mapOf("error" to (err ?: "failed"), "sourceLang" to (src ?: "und")))
      }
    }

    // ─── Speech (platform on-device recognizer, Android 13+) ─────────
    AsyncFunction("requestSpeechPermission") { promise: Promise ->
      val c = ctx()
      if (c == null) { promise.resolve(false); return@AsyncFunction }
      if (ContextCompat.checkSelfPermission(c, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
        promise.resolve(true)
        return@AsyncFunction
      }
      val perms = appContext.permissions
      if (perms == null) { promise.resolve(false); return@AsyncFunction }
      try {
        perms.askForPermissions({ result ->
          promise.resolve(result[Manifest.permission.RECORD_AUDIO]?.status == PermissionsStatus.GRANTED)
        }, Manifest.permission.RECORD_AUDIO)
      } catch (t: Throwable) {
        promise.resolve(false)
      }
    }

    AsyncFunction("transcribeAudioFile") { fileUrl: String, locale: String?, promise: Promise ->
      val c = ctx()
      if (c == null || Build.VERSION.SDK_INT < 33 || !speechAvailable(c)) {
        promise.resolve("")
        return@AsyncFunction
      }
      if (ContextCompat.checkSelfPermission(c, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        promise.resolve("")
        return@AsyncFunction
      }
      worker.execute {
        var pcm: File? = null
        try {
          pcm = decodeToPcm16kMono(c, fileUrl)
          if (pcm == null || pcm.length() < SPEECH_RATE / 5) { // < 100 ms of audio
            pcm?.delete()
            promise.resolve("")
            return@execute
          }
          val seconds = pcm.length() / (SPEECH_RATE * 2L)
          val file = pcm
          mainHandler.post {
            runSpeech(c, file, locale ?: Locale.getDefault().toLanguageTag(), seconds) { text ->
              try { file.delete() } catch (_: Throwable) {}
              promise.resolve(text)
            }
          }
        } catch (t: Throwable) {
          Log.w(TAG, "transcribe failed: ${t.message}")
          try { pcm?.delete() } catch (_: Throwable) {}
          promise.resolve("")
        }
      }
    }

    OnDestroy {
      try { textRecognizer?.close() } catch (_: Throwable) {}
      try { languageIdentifier?.close() } catch (_: Throwable) {}
      try { translator?.close() } catch (_: Throwable) {}
      val sr = activeSpeech
      activeSpeech = null
      if (sr != null) mainHandler.post { try { sr.destroy() } catch (_: Throwable) {} }
      textRecognizer = null
      languageIdentifier = null
    }
  }

  // ─── Translation helper ────────────────────────────────────────────

  private fun translateInternal(
    text: String,
    targetLang: String,
    sourceLang: String?,
    allowCellular: Boolean,
    cb: (String?, String?, String?) -> Unit,
  ) {
    val tr = translator
    if (tr == null) { cb(null, null, "unavailable"); return }
    if (text.isBlank()) { cb(text, null, null); return }
    val target = baseTag(targetLang)
    if (!tr.isSupported(target)) { cb(null, null, "unsupported_target"); return }
    val go: (String) -> Unit = { src ->
      when {
        src == "und" || src.isEmpty() -> cb(null, src, "unknown_source")
        src == target -> cb(text, src, null)
        !tr.isSupported(src) -> cb(null, src, "unsupported_source")
        else -> tr.translate(text, src, target, allowCellular) { out, err -> cb(out, src, err) }
      }
    }
    val explicit = baseTag(sourceLang)
    if (explicit.isNotEmpty() && explicit != "und") { go(explicit); return }
    try {
      langIdClient().identifyLanguage(text)
        .addOnSuccessListener { tag -> go(baseTag(tag ?: "und")) }
        .addOnFailureListener {
          requestInstall(langIdClient(), "langid")
          cb(null, null, "language_id_unavailable")
        }
    } catch (t: Throwable) {
      cb(null, null, "language_id_unavailable")
    }
  }

  // ─── Speech helpers (main thread) ──────────────────────────────────

  private fun speechIntent(locale: String): Intent =
    Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
      putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale)
      putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
      putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
      putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
    }

  private fun triggerSpeechModelDownload(c: Context, locale: String) {
    if (Build.VERSION.SDK_INT < 33) return
    var sr: SpeechRecognizer? = null
    try {
      val recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(c)
      sr = recognizer
      val intent = speechIntent(locale)
      recognizer.checkRecognitionSupport(intent, ContextCompat.getMainExecutor(c), object : RecognitionSupportCallback {
        override fun onSupportResult(support: RecognitionSupport) {
          try {
            val installed = support.installedOnDeviceLanguages.any { baseTag(it) == baseTag(locale) }
            val pending = support.pendingOnDeviceLanguages.any { baseTag(it) == baseTag(locale) }
            if (!installed && !pending) recognizer.triggerModelDownload(intent)
          } catch (t: Throwable) {
            Log.w(TAG, "speech model download failed: ${t.message}")
          }
          try { recognizer.destroy() } catch (_: Throwable) {}
        }

        override fun onError(error: Int) {
          try { recognizer.destroy() } catch (_: Throwable) {}
        }
      })
    } catch (t: Throwable) {
      Log.w(TAG, "speech support check failed: ${t.message}")
      try { sr?.destroy() } catch (_: Throwable) {}
    }
  }

  /** Must run on the main thread (SpeechRecognizer contract). */
  private fun runSpeech(c: Context, pcm: File, locale: String, seconds: Long, done: (String) -> Unit) {
    if (Build.VERSION.SDK_INT < 33) { done(""); return }
    // One recognition at a time: a second tap cancels the previous one.
    activeSpeech?.let { try { it.cancel(); it.destroy() } catch (_: Throwable) {} }
    activeSpeech = null

    val finished = AtomicBoolean(false)
    val segments = ArrayList<String>()
    var pfd: ParcelFileDescriptor? = null
    var sr: SpeechRecognizer? = null
    var timeout: Runnable? = null

    fun finish(text: String) {
      if (!finished.compareAndSet(false, true)) return
      timeout?.let { mainHandler.removeCallbacks(it) }
      try { pfd?.close() } catch (_: Throwable) {}
      val r = sr
      if (activeSpeech === r) activeSpeech = null
      try { r?.destroy() } catch (_: Throwable) {}
      done(text.trim())
    }

    try {
      val fd = ParcelFileDescriptor.open(pcm, ParcelFileDescriptor.MODE_READ_ONLY)
      pfd = fd
      val recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(c)
      sr = recognizer
      activeSpeech = recognizer
      val intent = speechIntent(locale).apply {
        putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, fd)
        putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
        putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
        putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, SPEECH_RATE)
        // Keep going across pauses until the file ends (voice notes have pauses).
        putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE)
      }
      recognizer.setRecognitionListener(object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onPartialResults(partialResults: Bundle?) {}
        override fun onEvent(eventType: Int, params: Bundle?) {}

        override fun onError(error: Int) {
          if (error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE ||
              error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED) {
            triggerSpeechModelDownload(c, locale)
          }
          Log.w(TAG, "speech error $error (segments=${segments.size})")
          finish(segments.joinToString(" "))
        }

        override fun onResults(results: Bundle?) {
          val best = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
          if (!best.isNullOrBlank()) segments.add(best)
          finish(segments.joinToString(" "))
        }

        override fun onSegmentResults(segmentResults: Bundle) {
          val best = segmentResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
          if (!best.isNullOrBlank()) segments.add(best)
        }

        override fun onEndOfSegmentedSession() {
          finish(segments.joinToString(" "))
        }
      })
      // Generous ceiling: recognition runs faster than real time, but never hang JS.
      val limitMs = 20_000L + seconds * 1500L
      val guard = Runnable {
        try { recognizer.cancel() } catch (_: Throwable) {}
        finish(segments.joinToString(" "))
      }
      timeout = guard
      mainHandler.postDelayed(guard, limitMs)
      recognizer.startListening(intent)
    } catch (t: Throwable) {
      Log.w(TAG, "speech start failed: ${t.message}")
      finish("")
    }
  }

  // ─── Audio decode: any container MediaExtractor reads → 16 kHz mono PCM16 ─

  private fun decodeToPcm16kMono(c: Context, uri: String): File? {
    val extractor = MediaExtractor()
    var codec: MediaCodec? = null
    val out = File(c.cacheDir, "chatyy-stt-${UUID.randomUUID()}.pcm")
    try {
      when {
        uri.startsWith("file://") -> extractor.setDataSource(Uri.parse(uri).path ?: return null)
        uri.startsWith("/") -> extractor.setDataSource(uri)
        uri.startsWith("content://") -> extractor.setDataSource(c, Uri.parse(uri), null)
        else -> return null // remote URLs: JS downloads first (ensureLocalFile)
      }
      var track = -1
      var format: MediaFormat? = null
      for (i in 0 until extractor.trackCount) {
        val f = extractor.getTrackFormat(i)
        if ((f.getString(MediaFormat.KEY_MIME) ?: "").startsWith("audio/")) { track = i; format = f; break }
      }
      if (track < 0 || format == null) return null
      extractor.selectTrack(track)
      val mime = format.getString(MediaFormat.KEY_MIME) ?: return null
      val dec = MediaCodec.createDecoderByType(mime)
      codec = dec
      dec.configure(format, null, null, 0)
      dec.start()

      var srcRate = if (format.containsKey(MediaFormat.KEY_SAMPLE_RATE)) format.getInteger(MediaFormat.KEY_SAMPLE_RATE) else 48000
      var channels = if (format.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) format.getInteger(MediaFormat.KEY_CHANNEL_COUNT) else 1
      var isFloat = false
      val maxOutSamples = SPEECH_RATE.toLong() * SPEECH_MAX_SECONDS
      var written = 0L
      // Linear resampler state (carries across buffers).
      var srcPos = 0.0
      var prev = 0f
      var havePrev = false

      val info = MediaCodec.BufferInfo()
      var inputDone = false
      var outputDone = false
      BufferedOutputStream(FileOutputStream(out), 64 * 1024).use { os ->
        val outBytes = ByteArray(2)
        fun emit(sample: Float) {
          val s = (sample.coerceIn(-1f, 1f) * 32767f).toInt()
          outBytes[0] = (s and 0xff).toByte()
          outBytes[1] = ((s shr 8) and 0xff).toByte()
          os.write(outBytes)
          written++
        }
        while (!outputDone && written < maxOutSamples) {
          if (!inputDone) {
            val inIdx = dec.dequeueInputBuffer(10_000)
            if (inIdx >= 0) {
              val buf = dec.getInputBuffer(inIdx)
              val size = if (buf != null) extractor.readSampleData(buf, 0) else -1
              if (size < 0) {
                dec.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                inputDone = true
              } else {
                dec.queueInputBuffer(inIdx, 0, size, extractor.sampleTime, 0)
                extractor.advance()
              }
            }
          }
          val outIdx = dec.dequeueOutputBuffer(info, 10_000)
          when {
            outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
              val of = dec.outputFormat
              if (of.containsKey(MediaFormat.KEY_SAMPLE_RATE)) srcRate = of.getInteger(MediaFormat.KEY_SAMPLE_RATE)
              if (of.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) channels = of.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
              isFloat = of.containsKey(MediaFormat.KEY_PCM_ENCODING) &&
                of.getInteger(MediaFormat.KEY_PCM_ENCODING) == AudioFormat.ENCODING_PCM_FLOAT
            }
            outIdx >= 0 -> {
              val ob = dec.getOutputBuffer(outIdx)
              if (ob != null && info.size > 0) {
                ob.position(info.offset)
                ob.limit(info.offset + info.size)
                ob.order(ByteOrder.LITTLE_ENDIAN)
                val ch = maxOf(1, channels)
                val step = srcRate.toDouble() / SPEECH_RATE
                if (isFloat) {
                  val fb = ob.asFloatBuffer()
                  val frames = fb.remaining() / ch
                  for (f in 0 until frames) {
                    var acc = 0f
                    for (k in 0 until ch) acc += fb.get(f * ch + k)
                    val cur = acc / ch
                    if (!havePrev) { prev = cur; havePrev = true }
                    while (srcPos <= 1.0) {
                      emit(prev + (cur - prev) * srcPos.toFloat())
                      srcPos += step
                    }
                    srcPos -= 1.0
                    prev = cur
                  }
                } else {
                  val sb = ob.asShortBuffer()
                  val frames = sb.remaining() / ch
                  for (f in 0 until frames) {
                    var acc = 0f
                    for (k in 0 until ch) acc += sb.get(f * ch + k) / 32768f
                    val cur = acc / ch
                    if (!havePrev) { prev = cur; havePrev = true }
                    while (srcPos <= 1.0) {
                      emit(prev + (cur - prev) * srcPos.toFloat())
                      srcPos += step
                    }
                    srcPos -= 1.0
                    prev = cur
                  }
                }
              }
              dec.releaseOutputBuffer(outIdx, false)
              if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputDone = true
            }
          }
        }
      }
      return out
    } catch (t: Throwable) {
      Log.w(TAG, "decode failed: ${t.message}")
      try { out.delete() } catch (_: Throwable) {}
      return null
    } finally {
      try { codec?.stop() } catch (_: Throwable) {}
      try { codec?.release() } catch (_: Throwable) {}
      try { extractor.release() } catch (_: Throwable) {}
    }
  }

  // ─── Image load (downsampled + EXIF-rotated) ───────────────────────

  private fun loadBitmap(c: Context, uri: String): Bitmap? {
    val path: String? = when {
      uri.startsWith("file://") -> Uri.parse(uri).path
      uri.startsWith("/") -> uri
      else -> null
    }
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    if (path != null) {
      BitmapFactory.decodeFile(path, bounds)
    } else {
      c.contentResolver.openInputStream(Uri.parse(uri))?.use { BitmapFactory.decodeStream(it, null, bounds) }
    }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > OCR_MAX_SIDE) sample *= 2
    val opts = BitmapFactory.Options().apply {
      inSampleSize = sample
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    val bmp = (if (path != null) BitmapFactory.decodeFile(path, opts)
      else c.contentResolver.openInputStream(Uri.parse(uri))?.use { BitmapFactory.decodeStream(it, null, opts) })
      ?: return null
    val rotation = try {
      val exif = if (path != null) ExifInterface(path)
        else c.contentResolver.openInputStream(Uri.parse(uri))?.use { ExifInterface(it) }
      when (exif?.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
        ExifInterface.ORIENTATION_ROTATE_90 -> 90f
        ExifInterface.ORIENTATION_ROTATE_180 -> 180f
        ExifInterface.ORIENTATION_ROTATE_270 -> 270f
        else -> 0f
      }
    } catch (_: Throwable) { 0f }
    if (rotation == 0f) return bmp
    val m = Matrix().apply { postRotate(rotation) }
    return Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
  }
}
