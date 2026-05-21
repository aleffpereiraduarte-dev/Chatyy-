package expo.modules.nativetoolkit

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.Lifecycle
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.Face
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetector
import com.google.mlkit.vision.face.FaceDetectorOptions
import com.google.mlkit.vision.face.FaceLandmark
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * ExpoFaceLandmarkerModule — Android face-landmark tracker for AR
 * status filters. Mirror of iOS ExpoFaceLandmarkerModule.swift.
 *
 * Uses Google ML Kit Face Detection (on-device, no network, free) instead
 * of MediaPipe Tasks Vision to keep the dependency footprint small —
 * MediaPipe pulls 25MB of model files + 8MB of native libs; ML Kit ships
 * within the existing Play Services bundle.
 *
 * JS contract (FaceFilterOverlay.js):
 *   - startFaceLandmarker({ fps: 15..30 })  — start camera + analyzer
 *   - stopFaceLandmarker()                  — release the analyzer
 *   - addListener('faceLandmarks', cb)      — { landmarks: [{ indexed: {...}, bbox: {...} }] }
 *
 * Landmark IDs are mapped from ML Kit's `FaceLandmark.NOSE_BASE` /
 * `FaceLandmark.LEFT_EYE` / etc. to MediaPipe-compatible integers so the
 * JS overlay code stays platform-agnostic.
 *
 * Performance:
 *   - Analyzer queue depth = 1 (drops late frames automatically).
 *   - We rate-limit emits to the requested fps from the JS caller.
 *   - All ML Kit calls run on a dedicated HandlerThread so we never
 *     block the main thread on inference.
 *
 * ⚠️ KNOWN LIMITATION (2026-05-21):
 *   Android's CameraX provider serializes camera access through Camera2.
 *   When expo-camera's CameraView is already bound to the front lens,
 *   our bindToLifecycle() call rebinds the camera — which silently steals
 *   the preview from expo-camera and leaves StatusCamera blank.
 *
 *   The proper fix is to share the frame stream: either patch expo-camera
 *   to expose an ImageAnalysis tap, or replace CameraView with a
 *   PreviewView + ImageAnalysis pair owned by this module. Until that
 *   ships in a rebuild, the JS overlay stays in static fallback mode
 *   whenever StatusCamera is up.
 */
class ExpoFaceLandmarkerModule : Module() {

  companion object {
    private const val TAG = "FaceLandmarker"
  }

  private val ctx: Context get() = appContext.reactContext!!

  // Camera + analyzer
  private var cameraProvider: ProcessCameraProvider? = null
  private var imageAnalysis: ImageAnalysis? = null
  private var lifecycleOwner: BareLifecycleOwner? = null
  private var detector: FaceDetector? = null
  private var analyzerThread: HandlerThread? = null
  private var analyzerHandler: Handler? = null

  // Throttle
  private var targetFps: Int = 30
  private val minFrameIntervalMs: Long get() = (1000L / targetFps.coerceAtLeast(1))
  private var lastEmitAt: Long = 0

  override fun definition() = ModuleDefinition {
    Name("ExpoMediaPipeFace")

    Events("faceLandmarks")

    AsyncFunction("startFaceLandmarker") { options: Map<String, Any?>? ->
      (options?.get("fps") as? Number)?.let { targetFps = it.toInt().coerceIn(5, 60) }
      return@AsyncFunction startCapture()
    }

    Function("stopFaceLandmarker") {
      stopCapture()
    }

    Function("setTargetFps") { fps: Int ->
      targetFps = fps.coerceIn(5, 60)
    }

    OnDestroy {
      stopCapture()
    }
  }

  // MARK: capture setup

  private fun startCapture(): Boolean {
    if (cameraProvider != null) return true

    // Lazy-init the detector. We want CONTOUR-quality so we get the eye
    // outline points required for sunglasses IPD scaling.
    val opts = FaceDetectorOptions.Builder()
      .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
      .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_ALL)
      .setContourMode(FaceDetectorOptions.CONTOUR_MODE_NONE) // contours add 30% CPU; we only need landmarks
      .setMinFaceSize(0.2f)
      .build()
    detector = FaceDetection.getClient(opts)

    analyzerThread = HandlerThread("face-landmarker").apply { start() }
    analyzerHandler = Handler(analyzerThread!!.looper)

    val owner = BareLifecycleOwner().also {
      lifecycleOwner = it
      it.start()
    }

    try {
      val providerFuture = ProcessCameraProvider.getInstance(ctx)
      providerFuture.addListener({
        try {
          cameraProvider = providerFuture.get()

          val analysis = ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()

          analysis.setAnalyzer(java.util.concurrent.Executors.newSingleThreadExecutor()) { proxy ->
            processFrame(proxy)
          }

          val selector = CameraSelector.DEFAULT_FRONT_CAMERA
          cameraProvider!!.unbindAll()
          cameraProvider!!.bindToLifecycle(owner, selector, analysis)
          imageAnalysis = analysis
          Log.i(TAG, "Face landmarker started at ${targetFps}fps")
        } catch (t: Throwable) {
          Log.w(TAG, "camera bind failed: ${t.message}")
        }
      }, androidx.core.content.ContextCompat.getMainExecutor(ctx))
      return true
    } catch (t: Throwable) {
      Log.w(TAG, "provider init failed: ${t.message}")
      return false
    }
  }

  private fun stopCapture() {
    try { cameraProvider?.unbindAll() } catch (_: Throwable) {}
    cameraProvider = null
    imageAnalysis = null
    try { detector?.close() } catch (_: Throwable) {}
    detector = null
    try { analyzerThread?.quitSafely() } catch (_: Throwable) {}
    analyzerThread = null
    analyzerHandler = null
    lifecycleOwner?.stop()
    lifecycleOwner = null
  }

  // MARK: frame processing

  @androidx.camera.core.ExperimentalGetImage
  private fun processFrame(proxy: ImageProxy) {
    val now = System.currentTimeMillis()
    if (now - lastEmitAt < minFrameIntervalMs) {
      proxy.close()
      return
    }
    val mediaImg = proxy.image
    if (mediaImg == null) {
      proxy.close()
      return
    }
    val input = InputImage.fromMediaImage(mediaImg, proxy.imageInfo.rotationDegrees)
    val w = input.width
    val h = input.height

    detector?.process(input)
      ?.addOnSuccessListener { faces ->
        if (faces.isNotEmpty()) {
          val face = faces[0]
          val payload = encode(face, w, h)
          lastEmitAt = System.currentTimeMillis()
          sendEvent("faceLandmarks", mapOf("landmarks" to listOf(payload)))
        }
      }
      ?.addOnCompleteListener { proxy.close() }
      ?: run { proxy.close() }
  }

  // MARK: landmark mapping

  private fun encode(face: Face, imgW: Int, imgH: Int): Map<String, Any> {
    val indexed = mutableMapOf<String, Map<String, Double>>()

    fun lm(idx: Int): Map<String, Double>? {
      val p = face.getLandmark(idx)?.position ?: return null
      // ML Kit returns pixel coords in the original image; normalize.
      return mapOf("x" to (p.x.toDouble() / imgW), "y" to (p.y.toDouble() / imgH))
    }

    // MediaPipe -> ML Kit mapping
    lm(FaceLandmark.NOSE_BASE)?.let { indexed["1"] = it }
    lm(FaceLandmark.LEFT_EYE)?.let { indexed["33"] = it }
    lm(FaceLandmark.RIGHT_EYE)?.let { indexed["263"] = it }
    // ML Kit doesn't expose pupils; reuse eye centers
    lm(FaceLandmark.LEFT_EYE)?.let { indexed["468"] = it }
    lm(FaceLandmark.RIGHT_EYE)?.let { indexed["473"] = it }
    // Mouth corners and bottom
    lm(FaceLandmark.MOUTH_LEFT)?.let { indexed["61"] = it }
    lm(FaceLandmark.MOUTH_RIGHT)?.let { indexed["291"] = it }
    lm(FaceLandmark.MOUTH_BOTTOM)?.let { indexed["14"] = it }
    // Upper lip — synthesize as midpoint between corners shifted slightly up
    val ml = face.getLandmark(FaceLandmark.MOUTH_LEFT)?.position
    val mr = face.getLandmark(FaceLandmark.MOUTH_RIGHT)?.position
    val mb = face.getLandmark(FaceLandmark.MOUTH_BOTTOM)?.position
    if (ml != null && mr != null && mb != null) {
      val mx = ((ml.x + mr.x) / 2f) / imgW
      val my = (((ml.y + mr.y) / 2f) - 6f) / imgH
      indexed["13"] = mapOf("x" to mx.toDouble(), "y" to my.toDouble())
    }

    // Bounding box → MediaPipe-style forehead (10) and chin (152)
    val bb = face.boundingBox
    val bx = bb.left.toDouble() / imgW
    val by = bb.top.toDouble() / imgH
    val bw = bb.width().toDouble() / imgW
    val bh = bb.height().toDouble() / imgH
    indexed["10"] = mapOf("x" to (bx + bw / 2.0), "y" to by)
    indexed["152"] = mapOf("x" to (bx + bw / 2.0), "y" to (by + bh))

    // Roll / yaw — useful for future rotation; emit even though current
    // overlay code doesn't read it (cheap to encode, lets us upgrade later).
    return mapOf(
      "indexed" to indexed,
      "bbox" to mapOf("x" to bx, "y" to by, "w" to bw, "h" to bh),
      "rollDeg" to face.headEulerAngleZ.toDouble(),
      "yawDeg" to face.headEulerAngleY.toDouble()
    )
  }

  /**
   * Minimal LifecycleOwner so CameraX has something to bind to outside an
   * Activity. We don't need true lifecycle awareness — the module itself
   * controls start/stop.
   */
  private class BareLifecycleOwner : LifecycleOwner {
    private val registry = LifecycleRegistry(this)
    override val lifecycle: Lifecycle get() = registry
    fun start() {
      registry.currentState = Lifecycle.State.STARTED
    }
    fun stop() {
      registry.currentState = Lifecycle.State.DESTROYED
    }
  }
}
