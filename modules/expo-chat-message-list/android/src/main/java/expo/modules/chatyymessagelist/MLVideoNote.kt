package expo.modules.chatyymessagelist

import android.content.Context
import android.graphics.Matrix
import android.graphics.Outline
import android.graphics.SurfaceTexture
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.view.ViewOutlineProvider
import kotlin.math.max

// [2026-10-15 native-list fase 2] Nota de vídeo redonda: toca INLINE no
// círculo da célula (TextureView + MediaPlayer do framework, sem libs novas).
// Só uma tocando por vez; para ao reciclar a célula / sair da tela.

class MLVideoNotePlayer(private val context: Context, private val emit: (key: String, what: String) -> Unit) {
  private val main = Handler(Looper.getMainLooper())
  private var key = ""
  private var cell: MLCellView? = null
  private var mp: MediaPlayer? = null
  private var tv: TextureView? = null
  private var surface: Surface? = null
  private var prepared = false
  private val tick = object : Runnable {
    override fun run() {
      val p = mp ?: return
      val c = cell ?: return
      try {
        val d = p.duration
        if (d > 0) c.vnProgress = p.currentPosition.toFloat() / d
      } catch (_: Throwable) {}
      main.postDelayed(this, 33)
    }
  }

  val playingKey: String get() = key

  /** Toque no círculo: toca / pausa / retoma. */
  fun toggle(c: MLCellView, k: String, uri: String) {
    if (uri.isEmpty()) return
    val p = mp
    if (k == key && p != null && cell === c) {
      if (!prepared) return
      try {
        if (p.isPlaying) { p.pause(); c.vnPlaying = false; main.removeCallbacks(tick); emit(k, "pause") }
        else { p.start(); c.vnPlaying = true; main.post(tick); emit(k, "play") }
      } catch (_: Throwable) { stop() }
      return
    }
    stop()
    start(c, k, uri)
  }

  private fun start(c: MLCellView, k: String, uri: String) {
    key = k
    cell = c
    prepared = false
    val v = TextureView(c.context)
    v.outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) { outline.setOval(0, 0, view.width, view.height) }
    }
    v.clipToOutline = true
    v.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
      override fun onSurfaceTextureAvailable(st: SurfaceTexture, w: Int, h: Int) {
        if (tv !== v) return
        val sf = Surface(st)
        surface = sf
        val player = MediaPlayer()
        mp = player
        try {
          player.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build())
          player.setSurface(sf)
          when {
            uri.startsWith("file://") || uri.startsWith("content://") -> player.setDataSource(context, Uri.parse(uri))
            uri.startsWith("/") -> player.setDataSource(uri)
            else -> player.setDataSource(context, Uri.parse(uri))
          }
          player.setOnVideoSizeChangedListener { _, vw, vh -> crop(v, vw, vh) }
          player.setOnPreparedListener { pp ->
            if (mp !== pp) return@setOnPreparedListener
            prepared = true
            crop(v, pp.videoWidth, pp.videoHeight)
            pp.start()
            cell?.vnPlaying = true
            cell?.vnProgress = 0f
            main.post(tick)
            emit(k, "play")
          }
          player.setOnCompletionListener { pp ->
            if (mp !== pp) return@setOnCompletionListener
            emit(k, "end")
            stop()
          }
          player.setOnErrorListener { pp, _, _ -> if (mp === pp) stop(); true }
          player.prepareAsync()
        } catch (_: Throwable) {
          stop()
        }
      }
      override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) { mp?.let { crop(v, it.videoWidth, it.videoHeight) } }
      override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean { if (tv === v) stop(); return true }
      override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
    }
    tv = v
    c.vnProgress = 0f
    c.attachVideo(v)
  }

  /** center-crop do vídeo no quadrado da view. */
  private fun crop(v: TextureView, vw: Int, vh: Int) {
    if (vw <= 0 || vh <= 0 || v.width <= 0 || v.height <= 0) return
    val a = vw.toFloat() / vh
    val sx = max(1f, a)
    val sy = max(1f, 1f / a)
    val m = Matrix()
    m.setScale(sx, sy, v.width / 2f, v.height / 2f)
    v.setTransform(m)
  }

  /** Para se a célula for esta (reciclagem / desmontagem). */
  fun stopIf(c: MLCellView) { if (cell === c) stop() }

  fun stop() {
    main.removeCallbacks(tick)
    val p = mp
    mp = null
    prepared = false
    try { p?.setOnCompletionListener(null); p?.stop() } catch (_: Throwable) {}
    try { p?.release() } catch (_: Throwable) {}
    try { surface?.release() } catch (_: Throwable) {}
    surface = null
    val c = cell
    cell = null
    tv = null
    key = ""
    c?.detachVideo()
  }
}
