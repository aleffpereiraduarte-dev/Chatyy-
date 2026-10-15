package expo.modules.chatyyreelsfeed

import android.content.Context
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory

// [2026-10-15 native-reels] Pool FIXO de 3 ExoPlayer (anterior / atual /
// próximo), todos criados e usados SÓ na main thread (o expo-shorts morria
// justamente por criar o ExoPlayer na fila de módulos → PlayerView exigia o
// looper principal). Cada slot carrega um reel por id; `assign` reaproveita
// os que saíram da janela. Vizinhos: prepare() + pausados + volume 0 → buffer
// e 1º quadro prontos antes do dedo soltar. Loop = REPEAT_MODE_ONE (a volta
// chega como DISCONTINUITY_REASON_AUTO_TRANSITION → conta "completou").
class RFSlot(val player: ExoPlayer) {
  var itemId = ""
  var mediaKey = ""
  var failed = false
  var ready = false
  var firstFrame = false
  var loops = 0
  var videoW = 0
  var videoH = 0
  var audible = false
  var page: RFPageView? = null
}

@OptIn(UnstableApi::class)
class RFPlayerPool(context: Context, private val listener: Listener) {
  interface Listener {
    fun onSlotReady(s: RFSlot)
    fun onSlotLooped(s: RFSlot)
    fun onSlotFailed(s: RFSlot)
    fun onSlotFirstFrame(s: RFSlot)
    fun onSlotVideoSize(s: RFSlot)
  }

  private val ctx = context.applicationContext
  private val attrs = AudioAttributes.Builder()
    .setUsage(C.USAGE_MEDIA)
    .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
    .build()
  val slots: List<RFSlot> = List(3) { build() }
  private var released = false

  private fun build(): RFSlot {
    val lc = DefaultLoadControl.Builder()
      .setBufferDurationsMs(2_500, 15_000, 400, 1_000)
      .setTargetBufferBytes(12 * 1024 * 1024)
      .setPrioritizeTimeOverSizeThresholds(false)
      .build()
    val p = ExoPlayer.Builder(ctx)
      .setLooper(Looper.getMainLooper())
      .setMediaSourceFactory(DefaultMediaSourceFactory(RFCache.dataSourceFactory(ctx)))
      .setLoadControl(lc)
      .build()
    p.repeatMode = Player.REPEAT_MODE_ONE
    p.volume = 0f
    p.playWhenReady = false
    p.setAudioAttributes(attrs, false)
    val s = RFSlot(p)
    p.addListener(object : Player.Listener {
      override fun onPlaybackStateChanged(state: Int) {
        if (state == Player.STATE_READY && !s.ready) {
          s.ready = true
          listener.onSlotReady(s)
        }
      }

      override fun onPlayerError(error: PlaybackException) {
        s.failed = true
        listener.onSlotFailed(s)
      }

      override fun onRenderedFirstFrame() {
        s.firstFrame = true
        listener.onSlotFirstFrame(s)
      }

      override fun onVideoSizeChanged(videoSize: VideoSize) {
        if (videoSize.width <= 0 || videoSize.height <= 0) return
        s.videoW = (videoSize.width * (if (videoSize.pixelWidthHeightRatio > 0f) videoSize.pixelWidthHeightRatio else 1f)).toInt()
        s.videoH = videoSize.height
        listener.onSlotVideoSize(s)
      }

      override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
        if (reason == Player.DISCONTINUITY_REASON_AUTO_TRANSITION) {
          s.loops += 1
          listener.onSlotLooped(s)
        }
      }
    })
    return s
  }

  fun slotFor(id: String): RFSlot? {
    if (id.isEmpty()) return null
    return slots.firstOrNull { it.itemId == id }
  }

  /** `wanted` em ordem de prioridade (atual primeiro). */
  fun assign(wanted: List<RFItem>, currentId: String) {
    if (released) return
    val wantedIds = wanted.map { it.id }.toHashSet()
    val free = slots.filter { it.itemId.isEmpty() || it.itemId !in wantedIds }.toMutableList()
    for (item in wanted) {
      val existing = slotFor(item.id)
      if (existing != null) {
        if (existing.mediaKey != item.mediaKey) load(existing, item)
        continue
      }
      if (free.isEmpty()) break
      load(free.removeAt(0), item)
    }
    for (s in slots) {
      if (s.itemId.isEmpty() || s.itemId == currentId) continue
      setAudible(s, false)
      if (s.player.playWhenReady) s.player.playWhenReady = false
    }
  }

  fun reload(item: RFItem) {
    val s = slotFor(item.id) ?: return
    load(s, item)
  }

  fun load(s: RFSlot, item: RFItem) {
    if (released) return
    clear(s)
    s.itemId = item.id
    s.mediaKey = item.mediaKey
    val mi = mediaItem(item)
    if (mi == null) {
      s.failed = true
      return
    }
    s.player.setMediaItem(mi)
    s.player.prepare()
  }

  fun clear(s: RFSlot) {
    try {
      s.player.playWhenReady = false
      s.player.stop()
      s.player.clearMediaItems()
      s.player.seekTo(0)
    } catch (_: Throwable) {}
    s.itemId = ""
    s.mediaKey = ""
    s.failed = false
    s.ready = false
    s.firstFrame = false
    s.loops = 0
    s.videoW = 0
    s.videoH = 0
  }

  fun pauseAll() {
    for (s in slots) if (s.player.playWhenReady) s.player.playWhenReady = false
  }

  /** Só o atual com som pede foco de áudio (mudo não interrompe a música do usuário). */
  fun setAudible(s: RFSlot, audible: Boolean) {
    s.player.volume = if (audible) 1f else 0f
    if (s.audible == audible) return
    s.audible = audible
    try { s.player.setAudioAttributes(attrs, audible) } catch (_: Throwable) {}
  }

  fun release() {
    if (released) return
    released = true
    for (s in slots) {
      try { s.player.release() } catch (_: Throwable) {}
      s.page = null
    }
  }

  private fun mediaItem(it: RFItem): MediaItem? {
    if (it.hlsUrl.isNotEmpty()) {
      return MediaItem.Builder().setUri(it.hlsUrl).setMimeType(MimeTypes.APPLICATION_M3U8).build()
    }
    if (it.videoUrl.isNotEmpty()) return MediaItem.fromUri(it.videoUrl)
    return null
  }
}
