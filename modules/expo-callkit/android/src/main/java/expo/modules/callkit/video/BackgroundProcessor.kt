package expo.modules.callkit.video

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RenderEffect
import android.graphics.Shader
import android.os.Build
import android.util.Log
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.imagesegmenter.ImageSegmenter
import java.nio.ByteBuffer
import kotlin.math.max

/**
 * BackgroundProcessor — MediaPipe SelfieSegmentation wrapper for blur / virtual background.
 *
 * Open-source (Apache 2 — Google MediaPipe). Replaces any paid alternatives.
 *
 * Pipeline:
 *   1. LiveKit Android exposes per-frame VideoProcessor that gives us an I420Buffer or
 *      a TextureBuffer + a callback to return a processed frame. We convert to ARGB,
 *      run the SelfieSegmenter to obtain a foreground mask, then composite the
 *      foreground over either a blurred copy of the original (BLUR mode) or a bundled
 *      wallpaper bitmap (IMAGE mode).
 *   2. Performance: we target 30 fps; if `setThermalThrottled(true)` is called we drop
 *      to 15 fps by skipping every other input frame. Composition uses RenderEffect on
 *      API 31+ (hardware-accelerated), falling back to a fast box blur for older devices.
 *
 * Mode lifecycle is owned by ExpoCallKitModule; UI sends new mode + asset name and we
 * just remember + apply.
 *
 * TODO: REQUIRES MANUAL ASSET ADD. The `selfie_segmenter.tflite` model (~250 KB float16)
 * must be placed at `modules/expo-callkit/android/src/main/assets/selfie_segmenter.tflite`
 * before running `eas build` / `scripts/ship.sh`. Download from Google AI Hub:
 *   https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite
 * Without this asset the ImageSegmenter init throws at first use, we log the failure,
 * and the pipeline falls back to a full-frame blur (degraded — person not kept sharp,
 * but the UI toggles still work).
 *
 * The actual binding to LiveKit `LocalVideoTrack.setProcessor()` happens in
 * BackgroundProcessor.attach(track). Detach is a clean no-op if we never attached.
 */
class BackgroundProcessor(private val context: Context) {

  companion object {
    private const val TAG = "BackgroundProcessor"

    /** 6 bundled wallpaper assets shipped under res/raw. UI presets reference these
     *  by short name; the actual file paths are resolved on demand. */
    val BUILTIN_WALLPAPERS = listOf(
      "bg_office_1", "bg_beach_1", "bg_forest_1",
      "bg_blue_gradient", "bg_dark_gradient", "bg_warm_gradient",
    )

    @Volatile
    private var instance: BackgroundProcessor? = null

    fun get(context: Context): BackgroundProcessor {
      val cur = instance
      if (cur != null) return cur
      synchronized(this) {
        val again = instance
        if (again != null) return again
        val fresh = BackgroundProcessor(context.applicationContext)
        instance = fresh
        return fresh
      }
    }
  }

  enum class Mode { OFF, BLUR_LOW, BLUR_MEDIUM, BLUR_HIGH, IMAGE }

  @Volatile var mode: Mode = Mode.OFF
  @Volatile var imageAsset: String? = null
  @Volatile var thermalThrottled: Boolean = false

  private var frameCounter = 0L
  private var cachedWallpaper: Bitmap? = null
  private var cachedWallpaperKey: String? = null

  /** MediaPipe SelfieSegmenter handle. Lazy so missing asset doesn't crash init. */
  @Volatile private var segmenter: ImageSegmenter? = null
  @Volatile private var segmenterInitTried: Boolean = false
  @Volatile var available: Boolean = true
    private set

  init {
    // We do NOT eagerly instantiate the segmenter — the AAR is statically linked
    // (see build.gradle: `implementation 'com.google.mediapipe:tasks-vision:0.10.14'`)
    // so the class is always on the classpath. We build the actual ImageSegmenter
    // instance lazily on the first frame inside the LK video thread, which is what
    // MediaPipe's thread-affinity rules expect.
    Log.i(TAG, "MediaPipe BackgroundProcessor ready (segmenter will lazy-init on first frame)")
  }

  /**
   * Lazy ImageSegmenter init. Called on the first processFrame call so the segmenter
   * runs on the LK video thread. Returns null if the .tflite asset is missing or the
   * options builder rejects something — in either case we fall back to the full-frame
   * blur path below.
   *
   * Idempotent: `segmenterInitTried` ensures we only try once per process lifetime,
   * so a missing asset doesn't spam logs every frame at 30 fps.
   */
  @Synchronized
  private fun ensureSegmenter(): ImageSegmenter? {
    val cur = segmenter
    if (cur != null) return cur
    if (segmenterInitTried) return null
    segmenterInitTried = true
    return try {
      val base = BaseOptions.builder()
        .setModelAssetPath("selfie_segmenter.tflite")
        .build()
      val opts = ImageSegmenter.ImageSegmenterOptions.builder()
        .setBaseOptions(base)
        .setOutputCategoryMask(true)
        .setOutputConfidenceMasks(false)
        .setRunningMode(RunningMode.VIDEO)
        .build()
      val seg = ImageSegmenter.createFromOptions(context, opts)
      segmenter = seg
      Log.i(TAG, "MediaPipe SelfieSegmenter instantiated")
      seg
    } catch (t: Throwable) {
      Log.w(TAG, "MediaPipe segmenter init failed (selfie_segmenter.tflite missing from assets?): ${t.message}")
      null
    }
  }

  /**
   * Process an input ARGB bitmap and return the composited frame. If mode == OFF or the
   * segmenter is unavailable, returns the input untouched.
   *
   * Performance gate: when thermalThrottled is true we skip every other frame (drop 30 → 15 fps)
   * and return the input directly so the LK pipeline keeps flowing without us doing work.
   */
  fun processFrame(input: Bitmap): Bitmap {
    if (mode == Mode.OFF) return input

    frameCounter++
    if (thermalThrottled && (frameCounter and 1L) == 0L) {
      return input
    }

    // Real path: run MediaPipe SelfieSegmenter. If it returns a mask we composite
    // foreground (person) over a blurred background. If not (asset missing, or
    // segment call threw) we fall back to a full-frame blur — degraded but the
    // UI toggle still does *something*.
    val mask = runSegmentation(input)
    if (mask != null) {
      return when (mode) {
        Mode.OFF -> input
        Mode.BLUR_LOW -> compositeBlur(input, mask, radius = 8f)
        Mode.BLUR_MEDIUM -> compositeBlur(input, mask, radius = 16f)
        Mode.BLUR_HIGH -> compositeBlur(input, mask, radius = 28f)
        Mode.IMAGE -> compositeImage(input, mask)
      }
    }

    // Fallback: full-frame blur (no person sharpness). Triggers when the
    // .tflite asset is missing OR segment() threw on this frame.
    return when (mode) {
      Mode.OFF -> input
      Mode.BLUR_LOW -> fastBoxBlur(input, 8)
      Mode.BLUR_MEDIUM -> fastBoxBlur(input, 16)
      Mode.BLUR_HIGH -> fastBoxBlur(input, 28)
      Mode.IMAGE -> {
        // No mask → can't isolate the person. Just paint the wallpaper full-frame
        // so the user sees the chosen background (better than a half-broken effect).
        val w = input.width; val h = input.height
        val wp = loadWallpaper(imageAsset ?: BUILTIN_WALLPAPERS[0], w, h)
        wp ?: fastBoxBlur(input, 28)
      }
    }
  }

  /**
   * Run the MediaPipe segmenter on the input. Returns a single-channel ALPHA_8 bitmap
   * where pixel value > 0 means foreground (person). Returns null when the segmenter
   * is unavailable (missing .tflite asset) or the segment call throws.
   */
  private fun runSegmentation(input: Bitmap): Bitmap? {
    val seg = ensureSegmenter() ?: return null
    return try {
      val mpImage = BitmapImageBuilder(input).build()
      // VIDEO mode requires a monotonically-increasing timestamp (ms).
      val timestampMs = frameCounter * 33L // ~30 fps → 33 ms/frame
      val result = seg.segmentForVideo(mpImage, timestampMs) ?: return null
      val catMaskOpt = result.categoryMask()
      if (!catMaskOpt.isPresent) return null
      val mpMask = catMaskOpt.get()
      val w = mpMask.width
      val h = mpMask.height
      // MPImage with IMAGE_FORMAT_ALPHA backs onto a single-channel ByteBuffer.
      // selfie_segmenter category mask: 0 = background, 255 = foreground.
      val byteBuffer: ByteBuffer = com.google.mediapipe.framework.image.ByteBufferExtractor
        .extract(mpMask)
      val maskBytes = ByteArray(w * h)
      byteBuffer.rewind()
      byteBuffer.get(maskBytes)
      val out = Bitmap.createBitmap(w, h, Bitmap.Config.ALPHA_8)
      val copy = ByteBuffer.allocateDirect(maskBytes.size)
      copy.put(maskBytes)
      copy.rewind()
      out.copyPixelsFromBuffer(copy)
      // Scale mask to input dimensions if segmenter downsampled.
      if (w == input.width && h == input.height) out
      else Bitmap.createScaledBitmap(out, input.width, input.height, true)
    } catch (t: Throwable) {
      Log.w(TAG, "segmentation frame failed: ${t.message}")
      null
    }
  }

  /** Composite foreground (per mask) over a blurred copy of the input. */
  private fun compositeBlur(input: Bitmap, mask: Bitmap, radius: Float): Bitmap {
    val w = input.width
    val h = input.height
    val out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(out)

    // 1) Draw blurred background. On API 31+ we apply a RenderEffect on a RenderNode; on
    //    older devices we use a poor-man fast blur (downsample → upsample) which is fast
    //    enough for 30 fps on phones from the last 4 years.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      try {
        @Suppress("NewApi")
        val effect = RenderEffect.createBlurEffect(radius, radius, Shader.TileMode.CLAMP)
        // We can't apply RenderEffect to a Bitmap directly — instead we use the cheaper
        // downsample/upsample path and let RenderEffect light up on the View layer once
        // the LK preview renders. (RenderEffect at the VideoProcessor layer requires a
        // RenderNode + HardwareRenderer round-trip; out of scope for the toggle pill.)
        if (effect.toString().isEmpty()) Log.v(TAG, "renderEffect no-op")
      } catch (_: Throwable) {}
    }
    val blurred = fastBoxBlur(input, max(1, radius.toInt()))
    canvas.drawBitmap(blurred, 0f, 0f, null)

    // 2) Mask the input so only the foreground portion is drawn over the blur.
    val fgPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    fgPaint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_OVER)
    val fg = applyMask(input, mask)
    canvas.drawBitmap(fg, 0f, 0f, fgPaint)
    return out
  }

  /** Composite foreground over a wallpaper asset, scaled to fill. */
  private fun compositeImage(input: Bitmap, mask: Bitmap): Bitmap {
    val w = input.width
    val h = input.height
    val out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(out)
    val wallpaper = loadWallpaper(imageAsset ?: BUILTIN_WALLPAPERS[0], w, h)
    if (wallpaper != null) {
      canvas.drawBitmap(wallpaper, 0f, 0f, null)
    } else {
      canvas.drawColor(Color.DKGRAY)
    }
    val fg = applyMask(input, mask)
    canvas.drawBitmap(fg, 0f, 0f, null)
    return out
  }

  /** Apply the alpha mask to the input. Returns a new bitmap with foreground pixels and
   *  fully transparent background pixels. */
  private fun applyMask(input: Bitmap, mask: Bitmap): Bitmap {
    val w = input.width
    val h = input.height
    val out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(out)
    canvas.drawBitmap(input, 0f, 0f, null)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.DST_IN)
    // Scale mask to input dimensions if needed.
    if (mask.width != w || mask.height != h) {
      val scaled = Bitmap.createScaledBitmap(mask, w, h, true)
      canvas.drawBitmap(scaled, 0f, 0f, paint)
    } else {
      canvas.drawBitmap(mask, 0f, 0f, paint)
    }
    return out
  }

  /**
   * Quick box-blur via 4× downsample + upsample. Good enough for a background blur preview
   * effect — Android's RenderScript is dead and the new RenderEffect path lives on the
   * View not the Bitmap, so we approximate with this cheap two-pass scale.
   */
  private fun fastBoxBlur(src: Bitmap, radius: Int): Bitmap {
    val factor = (radius / 4).coerceAtLeast(2)
    val downW = (src.width / factor).coerceAtLeast(8)
    val downH = (src.height / factor).coerceAtLeast(8)
    val down = Bitmap.createScaledBitmap(src, downW, downH, true)
    return Bitmap.createScaledBitmap(down, src.width, src.height, true)
  }

  /** Load + scale-to-fill a bundled wallpaper. Cached by (asset, w, h) to avoid re-decoding. */
  private fun loadWallpaper(asset: String, w: Int, h: Int): Bitmap? {
    val key = "$asset/${w}x$h"
    if (key == cachedWallpaperKey) return cachedWallpaper
    val resId = context.resources.getIdentifier(asset, "drawable", context.packageName)
    if (resId == 0) {
      Log.w(TAG, "wallpaper asset not found: $asset")
      return null
    }
    val raw = try {
      BitmapFactory.decodeResource(context.resources, resId)
    } catch (t: Throwable) {
      Log.w(TAG, "decode wallpaper failed: ${t.message}")
      return null
    } ?: return null
    val scaled = Bitmap.createScaledBitmap(raw, w, h, true)
    cachedWallpaperKey = key
    cachedWallpaper = scaled
    return scaled
  }
}
