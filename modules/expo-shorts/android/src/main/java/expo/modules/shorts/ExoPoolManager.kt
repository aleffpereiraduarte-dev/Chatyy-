package expo.modules.shorts

import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import java.io.File
import java.util.Locale

// -----------------------------------------------------------------------------
// ExoPoolManager — Stage 2 (2026-05-16)
//
// Singleton ExoPlayer pool sized to 3 (current, prev, next) for the Reels
// pager. Reusing 3 ExoPlayer instances across the entire vertical feed keeps
// memory + decoder pressure flat — Instagram/TikTok use the same trick.
//
// LRU strategy:
//   - Each slot tracks `lastTouchedMs` updated on every getPlayerForUrl /
//     prefetch / play touch. If the requested URL is already bound to a
//     slot, we return it and just bump its timestamp.
//   - If not bound: we pick the slot with the OLDEST `lastTouchedMs`
//     (i.e. the player that has been idle the longest — almost always the
//     reel the user scrolled away from 2 swipes ago) and rebind it.
//
// HLS detection (cheap, no network):
//   - URL path lowercase ends with ".m3u8"   → HLS
//   - URL query contains "type=hls"          → HLS
//   - otherwise progressive (MP4 / WebM / etc.)
//
// Lazy init: players are created on first getPlayerForUrl call so the pool
// doesn't pay the ~10ms ExoPlayer.Builder cost on app cold start (Reels
// might never be opened that session).
// -----------------------------------------------------------------------------

@UnstableApi
object ExoPoolManager {

  private const val TAG = "ExoPoolManager"
  private const val POOL_SIZE = 3

  // WhatsApp/IG-style snappy reels buffer profile.
  //   minBufferMs       = 500   — start playing as soon as 500ms is buffered
  //   maxBufferMs       = 20000 — cap memory: never hold >20s of video
  //   bufferForPlaybackMs = 500 — required buffer to begin playback
  //   bufferForPlaybackAfterRebufferMs = 1000 — after stall, need 1s
  private val LOAD_CONTROL = DefaultLoadControl.Builder()
    .setBufferDurationsMs(500, 20000, 500, 1000)
    .setPrioritizeTimeOverSizeThresholds(true)
    .build()

  private data class Slot(
    var player: ExoPlayer? = null,
    var boundUrl: String? = null,
    var lastTouchedMs: Long = 0L
  )

  private val slots = Array(POOL_SIZE) { Slot() }

  // ---------------------------------------------------------------------------
  // [2026-10-10 native-audit] Disk cache for progressive (MP4) reels / chat
  // short videos. Before: every bind streamed from the network again — swipe
  // back to a reel, reopen a chat short video, loop after pool eviction = full
  // re-download. Now ExoPlayer reads through a media3 SimpleCache (LRU,
  // CACHE_BYTES) and only fetches the missing byte ranges.
  //   - Own folder (cacheDir/chatyy_shorts_media): SimpleCache locks its
  //     folder per process; expo-video's cache lives in ExpoVideoCache/*.
  //   - HLS keeps the old uncached path (segments + live playlists).
  //   - Any failure creating the cache → permanent fallback to the old
  //     uncached path for this process (never breaks playback).
  //   - FLAG_IGNORE_CACHE_ON_ERROR: a corrupt/locked cache read goes to network.
  // ---------------------------------------------------------------------------
  private const val CACHE_BYTES = 300L * 1024L * 1024L
  private const val CACHE_DIR = "chatyy_shorts_media"
  private var mediaCache: SimpleCache? = null
  private var mediaCacheFailed = false

  @Synchronized
  private fun obtainCache(context: Context): SimpleCache? {
    mediaCache?.let { return it }
    if (mediaCacheFailed) return null
    return try {
      val app = context.applicationContext
      val dir = File(app.cacheDir, CACHE_DIR)
      val created = SimpleCache(dir, LeastRecentlyUsedCacheEvictor(CACHE_BYTES), StandaloneDatabaseProvider(app))
      mediaCache = created
      created
    } catch (t: Throwable) {
      mediaCacheFailed = true
      Log.w(TAG, "obtainCache: disabled (${t.message})")
      null
    }
  }

  /**
   * Drops every cached reel/short-video byte (logout / account switch).
   * Players keep working: CacheDataSource just misses and refetches.
   * Must NOT run on the main thread (SimpleCache I/O).
   */
  fun clearDiskCache(context: Context) {
    val c = obtainCache(context) ?: return
    try {
      val keys = HashSet(c.keys)
      for (k in keys) {
        try { c.removeResource(k) } catch (_: Throwable) {}
      }
      Log.d(TAG, "clearDiskCache: removed ${keys.size} resources")
    } catch (t: Throwable) {
      Log.w(TAG, "clearDiskCache failed: ${t.message}")
    }
  }

  @Synchronized
  private fun ensureSlot(context: Context, index: Int): Slot {
    val slot = slots[index]
    if (slot.player == null) {
      slot.player = ExoPlayer.Builder(context.applicationContext)
        .setLoadControl(LOAD_CONTROL)
        .build()
        .apply {
          // Reels behaviour: loop the current item until the pager scrolls.
          repeatMode = androidx.media3.common.Player.REPEAT_MODE_ONE
          // We start paused; the view flips playWhenReady when in focus.
          playWhenReady = false
        }
      Log.d(TAG, "ensureSlot: created ExoPlayer for slot=$index")
    }
    return slot
  }

  /**
   * Returns an ExoPlayer that has [videoUrl] as its current media item.
   * If a slot already has it bound, that slot is reused (no rebuffer).
   * Otherwise we rebind the LRU slot and call `prepare()`.
   *
   * Always called on the main thread (Expo prop setters run on main).
   */
  @Synchronized
  fun getPlayerForUrl(context: Context, videoUrl: String): ExoPlayer {
    val now = System.currentTimeMillis()

    // 1) Hit path — already bound? Just bump LRU & return.
    val bound = slots.firstOrNull { it.boundUrl == videoUrl && it.player != null }
    if (bound != null) {
      bound.lastTouchedMs = now
      Log.d(TAG, "getPlayerForUrl: HIT url=$videoUrl")
      return bound.player!!
    }

    // 2) Miss path — pick the LRU slot (oldest lastTouchedMs).
    // Initialise any uninitialised slots first (they sort to the bottom with
    // lastTouchedMs = 0 so they get picked first, which is what we want).
    for (i in 0 until POOL_SIZE) ensureSlot(context, i)

    val victim = slots.minByOrNull { it.lastTouchedMs }!!
    val player = victim.player!!

    // If the victim was playing something else, stop & clear to free decoder.
    if (victim.boundUrl != null && victim.boundUrl != videoUrl) {
      try {
        player.stop()
        player.clearMediaItems()
      } catch (t: Throwable) {
        Log.w(TAG, "getPlayerForUrl: stop/clear failed: ${t.message}")
      }
    }

    bindUrl(context, player, videoUrl)
    victim.boundUrl = videoUrl
    victim.lastTouchedMs = now

    Log.d(TAG, "getPlayerForUrl: MISS rebound url=$videoUrl slot=${slots.indexOf(victim)}")
    return player
  }

  /**
   * Fire-and-forget warm-up. Binds the URL to a free / LRU slot and calls
   * `prepare()` so ExoPlayer fetches the manifest + first segment, but
   * does NOT call `play()` — caller still sees a paused player when they
   * later request it. If the URL is already bound, this is a no-op.
   */
  @Synchronized
  fun prefetch(context: Context, videoUrl: String) {
    val now = System.currentTimeMillis()
    val already = slots.firstOrNull { it.boundUrl == videoUrl && it.player != null }
    if (already != null) {
      already.lastTouchedMs = now
      Log.d(TAG, "prefetch: already bound url=$videoUrl")
      return
    }
    // Reuse getPlayerForUrl, then ensure paused.
    val player = getPlayerForUrl(context, videoUrl)
    player.playWhenReady = false
    Log.d(TAG, "prefetch: warmed url=$videoUrl")
  }

  /** Releases all 3 ExoPlayer instances. Call from module destroy / app exit. */
  @Synchronized
  fun release() {
    for (i in 0 until POOL_SIZE) {
      val slot = slots[i]
      try {
        slot.player?.release()
      } catch (t: Throwable) {
        Log.w(TAG, "release: slot=$i error=${t.message}")
      }
      slot.player = null
      slot.boundUrl = null
      slot.lastTouchedMs = 0L
    }
    Log.d(TAG, "release: pool drained")
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  private fun bindUrl(context: Context, player: ExoPlayer, videoUrl: String) {
    val source = buildMediaSource(videoUrl) ?: buildCachedProgressiveSource(context, videoUrl)
    if (source != null) {
      player.setMediaSource(source)
    } else {
      // MP4 fallback path — ExoPlayer's default ProgressiveMediaSource via
      // setMediaItem handles MP4/WebM/etc. extractors out of the box.
      player.setMediaItem(MediaItem.fromUri(Uri.parse(videoUrl)))
    }
    player.prepare()
  }

  private fun buildMediaSource(videoUrl: String): MediaSource? {
    val isHls = looksLikeHls(videoUrl)
    if (!isHls) return null
    val mediaItem = MediaItem.Builder()
      .setUri(Uri.parse(videoUrl))
      .setMimeType(MimeTypes.APPLICATION_M3U8)
      .build()
    val httpFactory = DefaultHttpDataSource.Factory()
      .setAllowCrossProtocolRedirects(true)
    return HlsMediaSource.Factory(httpFactory).createMediaSource(mediaItem)
  }

  // Progressive http(s) → ProgressiveMediaSource reading through the disk
  // cache. null (no cache / not http) → caller keeps the plain setMediaItem.
  private fun buildCachedProgressiveSource(context: Context, videoUrl: String): MediaSource? {
    val lower = videoUrl.lowercase(Locale.ROOT)
    if (!(lower.startsWith("https://") || lower.startsWith("http://"))) return null
    val cache = obtainCache(context) ?: return null
    return try {
      val httpFactory = DefaultHttpDataSource.Factory()
        .setAllowCrossProtocolRedirects(true)
      val cacheFactory = CacheDataSource.Factory()
        .setCache(cache)
        .setUpstreamDataSourceFactory(httpFactory)
        .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
      ProgressiveMediaSource.Factory(cacheFactory)
        .createMediaSource(MediaItem.fromUri(Uri.parse(videoUrl)))
    } catch (t: Throwable) {
      Log.w(TAG, "buildCachedProgressiveSource: fallback uncached (${t.message})")
      null
    }
  }

  internal fun looksLikeHls(url: String): Boolean {
    val lower = url.lowercase(Locale.ROOT)
    // Strip fragment to be safe.
    val noHash = lower.substringBefore('#')
    val path = noHash.substringBefore('?')
    if (path.endsWith(".m3u8")) return true
    val query = noHash.substringAfter('?', missingDelimiterValue = "")
    if (query.contains("type=hls")) return true
    return false
  }
}
