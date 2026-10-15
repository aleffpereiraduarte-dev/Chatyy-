package expo.modules.chatyyreelsfeed

import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.CacheWriter
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

// [2026-10-15 native-reels] Cache de vídeo em disco (Media3 SimpleCache, LRU
// ~400 MB, pasta própria — SimpleCache não aceita 2 instâncias na mesma pasta).
// Os 3 ExoPlayer do pool leem por CacheDataSource (rever um reel = disco), e o
// feed pré-grava os primeiros ~2,5 MB dos reels 2–3 posições à frente
// (CacheWriter numa thread de fundo) → quando entram no pool, o 1º quadro sai
// do disco. HLS: os segmentos também passam pelo cache (rever = disco).
@OptIn(UnstableApi::class)
object RFCache {
  private const val TAG = "ChatyyReelsFeed"
  private const val MAX_BYTES = 400L * 1024 * 1024
  private const val PREFETCH_BYTES = 2_500_000L

  @Volatile private var cache: SimpleCache? = null
  @Volatile private var cacheFailed = false
  private val exec = Executors.newFixedThreadPool(2) { r ->
    Thread(r, "chatyy-reels-prefetch").apply {
      priority = Thread.MIN_PRIORITY
      isDaemon = true
    }
  }
  private val running = ConcurrentHashMap<String, CacheWriter>()
  private val queued = ConcurrentHashMap.newKeySet<String>()

  private fun cache(ctx: Context): SimpleCache? {
    cache?.let { return it }
    if (cacheFailed) return null
    synchronized(this) {
      cache?.let { return it }
      return try {
        val dir = File(ctx.applicationContext.cacheDir, "chatyy-reels-media")
        SimpleCache(dir, LeastRecentlyUsedCacheEvictor(MAX_BYTES), StandaloneDatabaseProvider(ctx.applicationContext)).also { cache = it }
      } catch (t: Throwable) {
        Log.w(TAG, "SimpleCache indisponível: ${t.message}")
        cacheFailed = true
        null
      }
    }
  }

  private fun upstream(ctx: Context): DataSource.Factory {
    val http = DefaultHttpDataSource.Factory()
      .setAllowCrossProtocolRedirects(true)
      .setConnectTimeoutMs(15_000)
      .setReadTimeoutMs(20_000)
      .setUserAgent("Chatyy-Reels/1 (Android)")
    return DefaultDataSource.Factory(ctx.applicationContext, http)
  }

  fun dataSourceFactory(ctx: Context): DataSource.Factory {
    val up = upstream(ctx)
    val c = cache(ctx) ?: return up
    return CacheDataSource.Factory()
      .setCache(c)
      .setUpstreamDataSourceFactory(up)
      .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
  }

  fun isCacheable(url: String): Boolean {
    if (!url.startsWith("http://") && !url.startsWith("https://")) return false
    val path = try { Uri.parse(url).path?.lowercase() ?: "" } catch (_: Throwable) { "" }
    return !path.endsWith(".m3u8") && !path.endsWith(".mpd")
  }

  fun prefetch(ctx: Context, url: String) {
    if (!isCacheable(url)) return
    if (queued.size >= 6) return
    if (running.containsKey(url) || !queued.add(url)) return
    val app = ctx.applicationContext
    try {
      exec.execute {
        try {
          val c = cache(app) ?: return@execute
          val ds = CacheDataSource.Factory()
            .setCache(c)
            .setUpstreamDataSourceFactory(upstream(app))
            .createDataSourceForDownloading()
          val spec = DataSpec.Builder().setUri(Uri.parse(url)).setPosition(0).setLength(PREFETCH_BYTES).build()
          val w = CacheWriter(ds, spec, null, null)
          running[url] = w
          w.cache()
        } catch (_: Throwable) {
          // cancelado / rede: o player busca sob demanda
        } finally {
          running.remove(url)
          queued.remove(url)
        }
      }
    } catch (_: Throwable) {
      queued.remove(url)
    }
  }

  fun cancel(except: Set<String>) {
    for ((k, w) in running) if (k !in except) {
      try { w.cancel() } catch (_: Throwable) {}
    }
  }
}
