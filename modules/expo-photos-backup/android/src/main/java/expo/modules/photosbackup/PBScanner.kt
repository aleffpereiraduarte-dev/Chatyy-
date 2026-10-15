package expo.modules.photosbackup

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

// [2026-10-15 photos-native] Varredura do MediaStore → fila (PBStore).
//  • API 30+: se MediaStore.getGeneration não mudou desde a última varredura,
//    nada a fazer (custo ~0). Senão diff por _ID (só colunas leves).
//  • Semente da conta (1ª vez): tudo vira pending e `drive_precheck_asset_ids`
//    (lotes de 5000) marca como done o que o servidor já tem.
internal object PBScanner {
  private const val TAG = "PBScanner"

  data class Media(
    val id: String,
    val uri: Uri,
    val mime: String,
    val name: String,
    val size: Long,
    val takenMs: Long,
    val isVideo: Boolean
  )

  fun hasPermission(context: Context): Boolean {
    fun g(p: String) = ContextCompat.checkSelfPermission(context, p) == PackageManager.PERMISSION_GRANTED
    return if (Build.VERSION.SDK_INT >= 33) {
      g(Manifest.permission.READ_MEDIA_IMAGES) || g(Manifest.permission.READ_MEDIA_VIDEO) ||
        (Build.VERSION.SDK_INT >= 34 && g("android.permission.READ_MEDIA_VISUAL_USER_SELECTED"))
    } else {
      g(Manifest.permission.READ_EXTERNAL_STORAGE)
    }
  }

  private fun generation(context: Context): Long {
    if (Build.VERSION.SDK_INT < 30) return -1
    return try { MediaStore.getGeneration(context, MediaStore.VOLUME_EXTERNAL_PRIMARY) } catch (_: Throwable) { -1 }
  }

  private fun genKey(): String = "gen:" + (if (Build.VERSION.SDK_INT >= 30) "v" else "x")

  // [2026-10-15 media-visibility] Mídia recebida que o Chatyy salva na galeria
  // vai p/ Pictures/Chatyy (foto) e Movies/Chatyy (vídeo) — "Salvar na galeria"
  // (services/mediaCache GALLERY_ALBUM). O backup de fotos ignora essas pastas
  // (senão a foto recebida voltaria ao Drive como "foto do aparelho").
  private const val CHATYY_ALBUM = "Chatyy"

  private fun excludeSelection(): Pair<String, Array<String>> {
    return if (Build.VERSION.SDK_INT >= 29) {
      val col = MediaStore.MediaColumns.RELATIVE_PATH
      Pair(
        "($col IS NULL OR ($col NOT LIKE ? AND $col NOT LIKE ?))",
        arrayOf("Pictures/$CHATYY_ALBUM/%", "Movies/$CHATYY_ALBUM/%")
      )
    } else {
      @Suppress("DEPRECATION")
      val col = MediaStore.MediaColumns.DATA
      Pair(
        "($col IS NULL OR ($col NOT LIKE ? AND $col NOT LIKE ?))",
        arrayOf("%/Pictures/$CHATYY_ALBUM/%", "%/Movies/$CHATYY_ALBUM/%")
      )
    }
  }

  /** Lista leve: id → (created ms, media 1/2). */
  private fun listAll(context: Context): HashMap<String, Pair<Double, Int>> {
    val out = HashMap<String, Pair<Double, Int>>(4096)
    for ((base, media) in listOf(
      MediaStore.Images.Media.EXTERNAL_CONTENT_URI to 1,
      MediaStore.Video.Media.EXTERNAL_CONTENT_URI to 2
    )) {
      val proj = arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DATE_TAKEN, MediaStore.MediaColumns.DATE_ADDED)
      val (sel, selArgs) = excludeSelection()
      // Com o filtro do álbum Chatyy; se o aparelho recusar a seleção, cai na
      // lista sem filtro (nunca devolve vazio por causa da exclusão).
      for (filtered in listOf(true, false)) {
        try {
          context.contentResolver.query(base, proj, if (filtered) sel else null, if (filtered) selArgs else null, null)?.use { c ->
            val iId = c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
            val iTk = c.getColumnIndex(MediaStore.MediaColumns.DATE_TAKEN)
            val iAd = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_ADDED)
            while (c.moveToNext()) {
              val taken = if (iTk >= 0 && !c.isNull(iTk)) c.getLong(iTk) else 0L
              val ms = if (taken > 0) taken else c.getLong(iAd) * 1000L
              out[c.getLong(iId).toString()] = Pair(ms / 1000.0, media)
            }
          }
          break
        } catch (e: Throwable) {
          Log.w(TAG, "query $base (filtered=$filtered) failed: ${e.message}")
        }
      }
    }
    return out
  }

  /**
   * Sincroniza a fila com o aparelho. Devolve true se mudou algo.
   * Não faz rede exceto na semente (precheck).
   */
  suspend fun scan(context: Context, store: PBStore, prefs: PBPrefs, force: Boolean = false): Boolean {
    val gen = generation(context)
    val includeVideosKey = if (prefs.includeVideos) "1" else "0"
    if (store.meta("includeVideos") != includeVideosKey) {
      store.applyVideoPolicy(prefs.includeVideos)
      store.setMeta("includeVideos", includeVideosKey)
    }
    val lastGen = store.meta(genKey())?.toLongOrNull() ?: -2L
    val seeded = store.meta("seeded") == "1"
    // 1ª varredura com a exclusão do álbum Chatyy: força o diff (tira da fila o
    // que já estava pendente nessas pastas).
    val exclDone = store.meta("excl_chatyy_v1") == "1"
    if (!force && exclDone && seeded && gen >= 0 && gen == lastGen) return false

    val device = listAll(context)
    val known = store.allIds()
    val added = ArrayList<Triple<String, Double, Int>>()
    for ((id, v) in device) if (!known.containsKey(id)) added.add(Triple(id, v.first, v.second))
    val removed = ArrayList<String>()
    for ((id, _) in known) if (!device.containsKey(id)) removed.add(id)
    store.insertNew(added, prefs.includeVideos)
    for (p in store.deleteIds(removed)) try { File(p).delete() } catch (_: Throwable) {}

    if (!seeded) {
      if (seed(store, prefs)) store.setMeta("seeded", "1")
    }
    if (gen >= 0) store.setMeta(genKey(), gen.toString())
    if (!exclDone && device.isNotEmpty()) store.setMeta("excl_chatyy_v1", "1")
    return added.isNotEmpty() || removed.isNotEmpty()
  }

  /** Semente via drive_precheck_asset_ids. false = falhou (tenta de novo depois). */
  private suspend fun seed(store: PBStore, prefs: PBPrefs): Boolean {
    var offset = 0
    while (true) {
      val ids = store.pendingIds(5000, offset)
      if (ids.isEmpty()) return true
      val body = JSONObject().put("asset_ids", JSONArray(ids))
      val r = PBNet.postWithFallback(prefs, "drive_precheck_asset_ids", body)
      if (r.code !in 200..299 || r.json?.optBoolean("success", false) != true) {
        Log.w(TAG, "precheck failed code=${r.code}")
        return false
      }
      val arr = r.json.optJSONObject("data")?.optJSONArray("backed_up") ?: JSONArray()
      val done = ArrayList<String>(arr.length())
      for (i in 0 until arr.length()) done.add(arr.optString(i))
      store.markDone(done)
      // os marcados saem do conjunto 'pending' → o offset só avança pelos que ficaram
      offset += ids.size - done.size
      if (ids.size < 5000) return true
    }
  }

  /** Metadados completos de um item p/ envio; null = sumiu do aparelho. */
  fun lookup(context: Context, localId: String, media: Int): Media? {
    val base = if (media == 2) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
    val idL = localId.toLongOrNull() ?: return null
    val uri = ContentUris.withAppendedId(base, idL)
    val proj = arrayOf(
      MediaStore.MediaColumns.MIME_TYPE, MediaStore.MediaColumns.DISPLAY_NAME,
      MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_TAKEN, MediaStore.MediaColumns.DATE_ADDED
    )
    return try {
      context.contentResolver.query(uri, proj, null, null, null)?.use { c ->
        if (!c.moveToFirst()) return null
        val mime = c.getString(0) ?: (if (media == 2) "video/mp4" else "image/jpeg")
        val name = c.getString(1) ?: "media_$localId"
        var size = if (c.isNull(2)) 0L else c.getLong(2)
        if (size <= 0) {
          size = try { context.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize } ?: 0L } catch (_: Throwable) { 0L }
        }
        val taken = if (c.isNull(3)) 0L else c.getLong(3)
        val ms = if (taken > 0) taken else c.getLong(4) * 1000L
        Media(localId, uri, mime, name, size, ms, media == 2)
      }
    } catch (e: Throwable) {
      Log.w(TAG, "lookup $localId failed: ${e.message}")
      null
    }
  }
}
