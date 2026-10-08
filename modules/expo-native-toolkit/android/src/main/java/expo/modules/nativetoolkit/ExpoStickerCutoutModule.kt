package expo.modules.nativetoolkit

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.util.Log
import com.google.android.gms.common.moduleinstall.ModuleInstall
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.segmentation.subject.SubjectSegmentation
import com.google.mlkit.vision.segmentation.subject.SubjectSegmenter
import com.google.mlkit.vision.segmentation.subject.SubjectSegmenterOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.Executors

/**
 * [2026-10-08 sticker-maker] Recorte automático do objeto (remoção de fundo)
 * para o criador de figurinhas — paridade com o "Criar figurinha" do WhatsApp.
 *
 * ML Kit Subject Segmentation (Google Play services, modelo baixado sob
 * demanda pelo próprio Play services — o APK não cresce). Se o modelo ainda
 * não baixou, a 1ª chamada pede o download (ModuleInstall) e rejeita; o JS
 * cai no recorte do servidor (chat_sticker_cutout) e as próximas já rodam
 * no aparelho.
 *
 * JS: requireOptionalNativeModule('ExpoStickerCutout') NA HORA da chamada.
 *   isSupported(): Boolean
 *   prepare(): Promise<Boolean>   — dispara o download do modelo (idempotente)
 *   liftSubject(uri, maxSide): { uri, width, height } | null
 */
class ExpoStickerCutoutModule : Module() {

  companion object {
    private const val TAG = "ExpoStickerCutout"
    private const val IN_MAX = 2048
  }

  private val worker = Executors.newSingleThreadExecutor()
  @Volatile private var segmenter: SubjectSegmenter? = null
  @Volatile private var installRequested = false

  private fun ctx(): Context? = appContext.reactContext?.applicationContext

  private fun client(): SubjectSegmenter {
    segmenter?.let { return it }
    synchronized(this) {
      segmenter?.let { return it }
      val opts = SubjectSegmenterOptions.Builder()
        .enableForegroundBitmap()
        .build()
      val s = SubjectSegmentation.getClient(opts)
      segmenter = s
      return s
    }
  }

  private fun requestModelInstall() {
    val c = ctx() ?: return
    if (installRequested) return
    installRequested = true
    try {
      val req = ModuleInstallRequest.newBuilder().addApi(client()).build()
      ModuleInstall.getClient(c).installModules(req)
        .addOnSuccessListener { Log.i(TAG, "model install ok (alreadyInstalled=${it.areModulesAlreadyInstalled()})") }
        .addOnFailureListener { e -> Log.w(TAG, "model install failed: ${e.message}"); installRequested = false }
    } catch (t: Throwable) {
      Log.w(TAG, "model install request threw: ${t.message}")
      installRequested = false
    }
  }

  override fun definition() = ModuleDefinition {
    Name("ExpoStickerCutout")

    Function("isSupported") {
      true
    }

    AsyncFunction("prepare") { promise: Promise ->
      try {
        requestModelInstall()
        promise.resolve(true)
      } catch (t: Throwable) {
        promise.resolve(false)
      }
    }

    AsyncFunction("liftSubject") { uri: String, maxSide: Int, promise: Promise ->
      val c = ctx()
      if (c == null) {
        promise.reject("E_CUTOUT", "no context", null)
        return@AsyncFunction
      }
      worker.execute {
        try {
          val src = loadBitmap(c, uri)
          if (src == null) {
            promise.reject("E_CUTOUT", "could not read image", null)
            return@execute
          }
          client().process(InputImage.fromBitmap(src, 0))
            .addOnSuccessListener(worker) { result ->
              try {
                val fg = result.foregroundBitmap
                if (fg == null) {
                  promise.resolve(null)
                  return@addOnSuccessListener
                }
                val out = cropAndScale(fg, maxSide.coerceIn(128, 2048))
                if (out == null) {
                  promise.resolve(null)
                  return@addOnSuccessListener
                }
                val f = File(c.cacheDir, "sticker-cutout-${UUID.randomUUID()}.png")
                FileOutputStream(f).use { os -> out.compress(Bitmap.CompressFormat.PNG, 100, os) }
                promise.resolve(mapOf(
                  "uri" to Uri.fromFile(f).toString(),
                  "width" to out.width,
                  "height" to out.height,
                ))
              } catch (t: Throwable) {
                promise.reject("E_CUTOUT", t.message ?: "encode failed", t)
              }
            }
            .addOnFailureListener(worker) { e ->
              // Modelo ainda não baixado (MlKitException UNAVAILABLE) → pede o
              // download pro Play services; o JS usa o servidor desta vez.
              requestModelInstall()
              promise.reject("E_CUTOUT", e.message ?: "segmentation failed", e)
            }
        } catch (t: Throwable) {
          promise.reject("E_CUTOUT", t.message ?: "cutout failed", t)
        }
      }
    }

    OnDestroy {
      try { segmenter?.close() } catch (_: Throwable) {}
      segmenter = null
    }
  }

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
    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > IN_MAX) sample *= 2
    val opts = BitmapFactory.Options().apply {
      inSampleSize = sample
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    val bmp = (if (path != null) BitmapFactory.decodeFile(path, opts)
      else c.contentResolver.openInputStream(Uri.parse(uri))?.use { BitmapFactory.decodeStream(it, null, opts) })
      ?: return null
    // EXIF (foto da câmera em pé)
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

  /** Recorta no bounding-box do alfa (+margem) e limita o lado a maxSide. */
  private fun cropAndScale(fg: Bitmap, maxSide: Int): Bitmap? {
    val w = fg.width
    val h = fg.height
    val px = IntArray(w * h)
    fg.getPixels(px, 0, w, 0, 0, w, h)
    var minX = w; var minY = h; var maxX = -1; var maxY = -1
    for (y in 0 until h) {
      val row = y * w
      for (x in 0 until w) {
        if ((px[row + x] ushr 24) > 24) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    if (maxX < 0 || maxY < 0) return null
    val bw = maxX - minX + 1
    val bh = maxY - minY + 1
    if (bw.toLong() * bh < (w.toLong() * h) / 250) return null // máscara minúscula
    val pad = (maxOf(bw, bh) * 0.04f).toInt() + 2
    val x0 = maxOf(0, minX - pad)
    val y0 = maxOf(0, minY - pad)
    val x1 = minOf(w, maxX + 1 + pad)
    val y1 = minOf(h, maxY + 1 + pad)
    var out = Bitmap.createBitmap(fg, x0, y0, x1 - x0, y1 - y0)
    val longest = maxOf(out.width, out.height)
    if (longest > maxSide) {
      val s = maxSide.toFloat() / longest
      out = Bitmap.createScaledBitmap(out, maxOf(1, (out.width * s).toInt()), maxOf(1, (out.height * s).toInt()), true)
    }
    return out
  }
}
