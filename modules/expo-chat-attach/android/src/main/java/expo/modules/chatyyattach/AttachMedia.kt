package expo.modules.chatyyattach

import android.content.ContentUris
import android.content.Context
import android.graphics.BitmapFactory
import android.media.ExifInterface
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.MediaStore
import android.util.Log
import android.webkit.MimeTypeMap
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/** [2026-10-15 native-attach] Item da galeria (MediaStore). */
data class CAMedia(
  val id: Long,
  val uri: Uri,
  val isVideo: Boolean,
  val mime: String,
  val name: String,
  val size: Long,
  val width: Int,
  val height: Int,
  val durationMs: Long,
  val dataPath: String?,
  val orientation: Int,
) {
  val key: String get() = (if (isVideo) "v" else "i") + id
}

object CAMediaStore {
  private const val TAG = "ChatyyAttach"
  val io = Executors.newFixedThreadPool(3)

  /** Fotos + vídeos mais recentes primeiro (bloqueante — chamar fora da main). */
  fun queryRecent(ctx: Context, limit: Int): List<CAMedia> {
    val out = ArrayList<CAMedia>()
    val uri = MediaStore.Files.getContentUri("external")
    val sel = "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN (" +
      "${MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE},${MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO})" +
      " AND ${MediaStore.MediaColumns.SIZE} > 0"
    val base = arrayOf(
      MediaStore.Files.FileColumns._ID,
      MediaStore.Files.FileColumns.MEDIA_TYPE,
      MediaStore.MediaColumns.MIME_TYPE,
      MediaStore.MediaColumns.DISPLAY_NAME,
      MediaStore.MediaColumns.SIZE,
      MediaStore.MediaColumns.WIDTH,
      MediaStore.MediaColumns.HEIGHT,
      MediaStore.MediaColumns.DATA,
    )
    // "duration"/"orientation" existem na tabela files (union); se o aparelho
    // recusar a coluna, refaz a consulta só com as básicas.
    val full = base + arrayOf("duration", "orientation")
    val order = "${MediaStore.MediaColumns.DATE_ADDED} DESC"
    val cursor = try {
      ctx.contentResolver.query(uri, full, sel, null, order)
    } catch (_: Throwable) {
      try { ctx.contentResolver.query(uri, base, sel, null, order) } catch (t: Throwable) {
        Log.w(TAG, "query failed: ${t.message}"); null
      }
    } ?: return out
    cursor.use { c ->
      val iId = c.getColumnIndex(MediaStore.Files.FileColumns._ID)
      val iType = c.getColumnIndex(MediaStore.Files.FileColumns.MEDIA_TYPE)
      val iMime = c.getColumnIndex(MediaStore.MediaColumns.MIME_TYPE)
      val iName = c.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME)
      val iSize = c.getColumnIndex(MediaStore.MediaColumns.SIZE)
      val iW = c.getColumnIndex(MediaStore.MediaColumns.WIDTH)
      val iH = c.getColumnIndex(MediaStore.MediaColumns.HEIGHT)
      val iData = c.getColumnIndex(MediaStore.MediaColumns.DATA)
      val iDur = c.getColumnIndex("duration")
      val iOri = c.getColumnIndex("orientation")
      while (c.moveToNext() && out.size < limit) {
        val id = c.getLong(iId)
        val video = c.getInt(iType) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
        val contentUri = ContentUris.withAppendedId(
          if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
        val mime = (if (iMime >= 0) c.getString(iMime) else null) ?: (if (video) "video/mp4" else "image/jpeg")
        out.add(CAMedia(
          id = id,
          uri = contentUri,
          isVideo = video,
          mime = mime,
          name = (if (iName >= 0) c.getString(iName) else null) ?: "",
          size = if (iSize >= 0) c.getLong(iSize) else 0L,
          width = if (iW >= 0) c.getInt(iW) else 0,
          height = if (iH >= 0) c.getInt(iH) else 0,
          durationMs = if (iDur >= 0) c.getLong(iDur) else 0L,
          dataPath = if (iData >= 0) c.getString(iData) else null,
          orientation = if (iOri >= 0) c.getInt(iOri) else 0,
        ))
      }
    }
    return out
  }

  fun outDir(ctx: Context): File {
    val d = File(ctx.cacheDir, "chatyy-attach")
    if (!d.exists()) d.mkdirs()
    return d
  }

  private fun extFor(m: CAMedia): String {
    val fromName = m.name.substringAfterLast('.', "").lowercase()
    if (fromName.isNotEmpty() && fromName.length <= 5) return fromName
    val e = MimeTypeMap.getSingleton().getExtensionFromMimeType(m.mime)
    return e ?: if (m.isVideo) "mp4" else "jpg"
  }

  /**
   * Item → arquivo local legível + descritor no formato do handleGallery do JS.
   * Caminho DATA legível (FUSE, permissão de mídia) = usado direto (zero cópia);
   * senão copia o content:// para o cache. Bloqueante.
   */
  fun materialize(ctx: Context, m: CAMedia): Map<String, Any?>? {
    var file: File? = null
    val dp = m.dataPath
    if (!dp.isNullOrEmpty()) {
      val f = File(dp)
      if (f.canRead() && f.length() > 0) file = f
    }
    if (file == null) {
      val dst = File(outDir(ctx), UUID.randomUUID().toString() + "." + extFor(m))
      try {
        ctx.contentResolver.openInputStream(m.uri)?.use { input ->
          dst.outputStream().use { output -> input.copyTo(output, 256 * 1024) }
        } ?: return null
        file = dst
      } catch (t: Throwable) {
        Log.w(TAG, "copy failed: ${t.message}")
        try { dst.delete() } catch (_: Throwable) {}
        return null
      }
    }
    val f = file ?: return null
    var w = m.width
    var h = m.height
    var durSec: Double? = if (m.isVideo) m.durationMs / 1000.0 else null
    if (m.isVideo) {
      if (w <= 0 || h <= 0 || (durSec ?: 0.0) <= 0.0) {
        val meta = videoMeta(f)
        if (meta != null) { w = meta.first; h = meta.second; durSec = meta.third }
      } else {
        // MediaStore guarda as dimensões do quadro sem rotação.
        val rot = videoRotation(f)
        if (rot == 90 || rot == 270) { val t = w; w = h; h = t }
      }
    } else {
      if (w <= 0 || h <= 0) {
        val dims = imageDims(f)
        if (dims != null) { w = dims.first; h = dims.second }
      } else if (m.orientation == 90 || m.orientation == 270) {
        val t = w; w = h; h = t
      }
    }
    val name = m.name.ifEmpty { (if (m.isVideo) "VID_" else "IMG_") + System.currentTimeMillis() + "." + extFor(m) }
    return hashMapOf(
      "uri" to Uri.fromFile(f).toString(),
      "name" to name,
      "type" to m.mime,
      "size" to f.length(),
      "width" to w,
      "height" to h,
      "duration" to durSec,
      "mediaType" to if (m.isVideo) "video" else "image",
    )
  }

  /** Materializa em paralelo (3), preservando a ordem; cb na main thread. */
  fun materializeAll(ctx: Context, list: List<CAMedia>, cb: (List<Map<String, Any?>>) -> Unit) {
    if (list.isEmpty()) { CAUtil.main.post { cb(emptyList()) }; return }
    val results = arrayOfNulls<Map<String, Any?>>(list.size)
    val left = AtomicInteger(list.size)
    list.forEachIndexed { i, m ->
      io.execute {
        results[i] = try { materialize(ctx, m) } catch (_: Throwable) { null }
        if (left.decrementAndGet() == 0) {
          val done = results.filterNotNull()
          CAUtil.main.post { cb(done) }
        }
      }
    }
  }

  fun imageDims(f: File): Pair<Int, Int>? {
    return try {
      val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(f.absolutePath, o)
      if (o.outWidth <= 0 || o.outHeight <= 0) return null
      val ori = try {
        ExifInterface(f.absolutePath).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
      } catch (_: Throwable) { ExifInterface.ORIENTATION_NORMAL }
      val swap = ori == ExifInterface.ORIENTATION_ROTATE_90 || ori == ExifInterface.ORIENTATION_ROTATE_270 ||
        ori == ExifInterface.ORIENTATION_TRANSPOSE || ori == ExifInterface.ORIENTATION_TRANSVERSE
      if (swap) Pair(o.outHeight, o.outWidth) else Pair(o.outWidth, o.outHeight)
    } catch (_: Throwable) {
      null
    }
  }

  private fun videoRotation(f: File): Int {
    val r = MediaMetadataRetriever()
    return try {
      r.setDataSource(f.absolutePath)
      r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
    } catch (_: Throwable) {
      0
    } finally {
      try { r.release() } catch (_: Throwable) {}
    }
  }

  /** (largura, altura) já com rotação + duração em segundos. */
  fun videoMeta(f: File): Triple<Int, Int, Double>? {
    val r = MediaMetadataRetriever()
    return try {
      r.setDataSource(f.absolutePath)
      var w = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
      var h = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
      val rot = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
      if (rot == 90 || rot == 270) { val t = w; w = h; h = t }
      val ms = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
      Triple(w, h, ms / 1000.0)
    } catch (_: Throwable) {
      null
    } finally {
      try { r.release() } catch (_: Throwable) {}
    }
  }

  fun cameraPhotoItem(f: File): Map<String, Any?> {
    val d = imageDims(f) ?: Pair(0, 0)
    return hashMapOf(
      "uri" to Uri.fromFile(f).toString(),
      "name" to "camera_${System.currentTimeMillis()}.jpg",
      "type" to "image/jpeg",
      "size" to f.length(),
      "width" to d.first,
      "height" to d.second,
      "duration" to null,
      "mediaType" to "image",
    )
  }

  fun cameraVideoItem(f: File): Map<String, Any?> {
    val m = videoMeta(f)
    return hashMapOf(
      "uri" to Uri.fromFile(f).toString(),
      "name" to "camera_${System.currentTimeMillis()}.mp4",
      "type" to "video/mp4",
      "size" to f.length(),
      "width" to (m?.first ?: 0),
      "height" to (m?.second ?: 0),
      "duration" to m?.third,
      "mediaType" to "video",
    )
  }
}
