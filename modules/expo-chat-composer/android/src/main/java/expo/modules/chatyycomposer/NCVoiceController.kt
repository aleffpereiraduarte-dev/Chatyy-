package expo.modules.chatyycomposer

import android.Manifest
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import android.view.animation.OvershootInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import androidx.core.content.ContextCompat
import java.io.File
import java.nio.ByteBuffer
import java.util.UUID
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min

private const val VTAG = "ChatyyComposerVoice"
/** 1 quadro AAC = 1024 amostras @ 24 kHz ≈ 42,667 ms (emenda dos trechos). */
private const val AAC_FRAME_US = 42_667L

/**
 * [2026-10-14 native-composer] Gravação de voz dentro do composer (Android).
 * Segurar o microfone grava (MediaRecorder AAC-LC mono 24 kHz 32 kbps, mesmo
 * perfil do ExpoNativeAudio); arrastar p/ a ESQUERDA cancela; p/ CIMA trava
 * (lixeira + onda + enviar); soltar envia; < 1 s = curto demais. Entrega
 * {uri, durationMs, waveform} ao JS — upload/fila continuam no JS.
 */
internal class NCWaveformView(ctx: Context) : View(ctx) {
  private val levels = ArrayList<Float>()
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val rect = RectF()
  private val barW = ncDp(ctx, 2.5f).toFloat()
  private val barGap = ncDp(ctx, 2f).toFloat()
  // [2026-10-18 voz-pausa] Modo estático (pausado): onda inteira reamostrada na
  // largura, esquerda → direita; trecho já ouvido na prévia em `playedPaint`.
  private var staticSrc: List<Float>? = null
  private val playedPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  var progress = 0f
    set(v) {
      field = v
      invalidate()
    }

  fun setColor(c: Int) { paint.color = c; invalidate() }

  fun setPlayedColor(c: Int) { playedPaint.color = c; invalidate() }

  fun reset() {
    staticSrc = null
    progress = 0f
    levels.clear()
    invalidate()
  }

  fun setStatic(src: List<Float>) {
    staticSrc = ArrayList(src)
    progress = 0f
    refit()
  }

  private fun refit() {
    val src = staticSrc ?: return
    val cap = max(8, (width / (barW + barGap)).toInt())
    levels.clear()
    levels.addAll(NCVoiceController.resample(src, cap))
    invalidate()
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (staticSrc != null) refit()
  }

  fun push(level: Float) {
    if (staticSrc != null) return
    levels.add(level)
    val cap = max(8, (width / (barW + barGap)).toInt() + 1)
    while (levels.size > cap) levels.removeAt(0)
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (levels.isEmpty()) return
    val h = height.toFloat()
    val minH = ncDp(context, 3f).toFloat()
    if (staticSrc != null) {
      val n = levels.size
      var sx = 0f
      for (i in 0 until n) {
        if (sx + barW > width) break
        val played = (i + 0.5f) / n <= progress
        val bh = max(minH, levels[i] * h)
        rect.set(sx, (h - bh) / 2f, sx + barW, (h + bh) / 2f)
        canvas.drawRoundRect(rect, barW / 2f, barW / 2f, if (played) playedPaint else paint)
        sx += barW + barGap
      }
      return
    }
    var x = width - barW
    for (i in levels.indices.reversed()) {
      if (x < 0) break
      val bh = max(minH, levels[i] * h)
      rect.set(x, (h - bh) / 2f, x + barW, (h + bh) / 2f)
      canvas.drawRoundRect(rect, barW / 2f, barW / 2f, paint)
      x -= barW + barGap
    }
  }
}

/** Painel que ocupa o lugar do "+ / campo" enquanto grava. */
@SuppressLint("ViewConstructor")
internal class NCVoicePanel(ctx: Context) : ViewGroup(ctx) {
  val dot = View(ctx)
  val time = TextView(ctx)
  val slide = TextView(ctx)
  val wave = NCWaveformView(ctx)
  val trash = NCIconButton(ctx, R.drawable.nc_ic_trash, 22f)
  // [2026-10-18 voz-pausa] travado: pausar ⇄ continuar (mic) à direita; pausado:
  // play/pause da prévia ao lado da lixeira.
  val pauseBtn = NCIconButton(ctx, R.drawable.nc_ic_pause, 22f)
  val playBtn = NCIconButton(ctx, R.drawable.nc_ic_play, 22f)
  private val dotBg = GradientDrawable().apply { shape = GradientDrawable.OVAL }
  var locked = false
  var paused = false
  var dx = 0f
  /** [2026-10-16 motion-composer] cutucada da seta (px, ≤ 0) somada ao arrasto. */
  var nudge = 0f

  fun applySlide() {
    slide.translationX = min(0f, dx) * 0.6f + nudge
  }

  init {
    dot.background = dotBg
    addView(dot)
    time.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    time.typeface = Typeface.MONOSPACE
    time.gravity = Gravity.CENTER_VERTICAL
    time.text = "0:00"
    addView(time)
    slide.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    slide.gravity = Gravity.CENTER
    slide.maxLines = 1
    addView(slide)
    addView(wave)
    trash.visibility = View.GONE
    addView(trash)
    pauseBtn.visibility = View.GONE
    addView(pauseBtn)
    playBtn.visibility = View.GONE
    addView(playBtn)
  }

  private var textColor = 0xFF111111.toInt()
  private var secondaryColor = 0xFF6E6E73.toInt()

  fun colors(bg: Int, text: Int, secondary: Int, rec: Int, accent: Int) {
    setBackgroundColor(bg)
    textColor = text
    secondaryColor = secondary
    time.setTextColor(text)
    slide.setTextColor(secondary)
    wave.setColor(if (paused) secondary else text)
    wave.setPlayedColor(accent)
    dotBg.setColor(rec)
    trash.tint(rec)
    pauseBtn.tint(rec)
    playBtn.tint(text)
  }

  /** Cor da onda: viva = texto; pausada = secundária (o ouvido vai em accent). */
  fun refreshWaveColor() {
    wave.setColor(if (paused) secondaryColor else textColor)
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    val h = MeasureSpec.getSize(heightMeasureSpec)
    setMeasuredDimension(w, h)
    val ex = { s: Int -> MeasureSpec.makeMeasureSpec(max(0, s), MeasureSpec.EXACTLY) }
    dot.measure(ex(ncDp(context, 10f)), ex(ncDp(context, 10f)))
    time.measure(ex(ncDp(context, 60f)), ex(h))
    slide.measure(ex(max(0, w - ncDp(context, 96f))), ex(h))
    val waveX = ncDp(context, if (paused) 138f else 128f)
    wave.measure(ex(max(0, w - waveX - ncDp(context, 48f))), ex(max(0, h - ncDp(context, 16f))))
    trash.measure(ex(ncDp(context, 44f)), ex(h))
    pauseBtn.measure(ex(ncDp(context, 44f)), ex(h))
    playBtn.measure(ex(ncDp(context, 40f)), ex(h))
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val h = b - t
    val d10 = ncDp(context, 10f)
    if (locked) {
      val w = r - l
      trash.visibility = View.VISIBLE
      trash.layout(0, 0, ncDp(context, 44f), h)
      pauseBtn.visibility = View.VISIBLE
      pauseBtn.layout(max(0, w - ncDp(context, 44f)), 0, w, h)
      if (paused) {
        dot.visibility = View.GONE
        playBtn.visibility = View.VISIBLE
        val pX = ncDp(context, 44f)
        playBtn.layout(pX, 0, pX + playBtn.measuredWidth, h)
        val tX = ncDp(context, 86f)
        time.layout(tX, 0, tX + time.measuredWidth, h)
      } else {
        dot.visibility = View.VISIBLE
        playBtn.visibility = View.GONE
        val dX = ncDp(context, 48f)
        dot.layout(dX, (h - d10) / 2, dX + d10, (h + d10) / 2)
        val tX = ncDp(context, 64f)
        time.layout(tX, 0, tX + time.measuredWidth, h)
      }
      wave.visibility = View.VISIBLE
      val wX = ncDp(context, if (paused) 138f else 128f)
      wave.layout(wX, ncDp(context, 8f), wX + wave.measuredWidth, ncDp(context, 8f) + wave.measuredHeight)
      slide.visibility = View.GONE
    } else {
      trash.visibility = View.GONE
      pauseBtn.visibility = View.GONE
      playBtn.visibility = View.GONE
      dot.visibility = View.VISIBLE
      val dX = ncDp(context, 14f)
      dot.layout(dX, (h - d10) / 2, dX + d10, (h + d10) / 2)
      val tX = ncDp(context, 32f)
      time.layout(tX, 0, tX + time.measuredWidth, h)
      wave.visibility = View.GONE
      slide.visibility = View.VISIBLE
      val sX = ncDp(context, 96f)
      slide.layout(sX, 0, sX + slide.measuredWidth, h)
      applySlide()
    }
  }
}

/** Camada sobre a janela durante o "segurar": círculo grande + pílula do cadeado. */
@SuppressLint("ViewConstructor")
internal class NCHoldOverlay(ctx: Context) : FrameLayout(ctx) {
  val halo2 = View(ctx) // [2026-10-16 motion-composer] anel externo, mais lento (Telegram)
  val halo = View(ctx)
  val circle = FrameLayout(ctx)
  val mic = ImageView(ctx)
  val lockPill = FrameLayout(ctx)
  val lockIcon = ImageView(ctx)
  val chevron = ImageView(ctx)
  private val haloBg = GradientDrawable().apply { shape = GradientDrawable.OVAL }
  private val halo2Bg = GradientDrawable().apply { shape = GradientDrawable.OVAL }
  private val circleBg = GradientDrawable().apply { shape = GradientDrawable.OVAL }
  private val pillBg = GradientDrawable()
  private val d = ncDp(ctx, 92f)
  private val pillW = ncDp(ctx, 40f)
  private val pillH = ncDp(ctx, 78f)
  var originX = 0f
  var originY = 0f

  init {
    isClickable = false
    isFocusable = false
    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    halo2.background = halo2Bg
    addView(halo2, LayoutParams(d, d))
    halo.background = haloBg
    addView(halo, LayoutParams(d, d))
    circle.background = circleBg
    mic.setImageResource(R.drawable.nc_ic_mic)
    val mi = ncDp(ctx, 34f)
    circle.addView(mic, LayoutParams(mi, mi, Gravity.CENTER))
    addView(circle, LayoutParams(d, d))
    pillBg.cornerRadius = ncDp(ctx, 20f).toFloat()
    lockPill.background = pillBg
    lockPill.elevation = ncDp(ctx, 3f).toFloat()
    lockIcon.setImageResource(R.drawable.nc_ic_lock_open)
    val li = ncDp(ctx, 20f)
    lockPill.addView(lockIcon, LayoutParams(li, li, Gravity.CENTER_HORIZONTAL or Gravity.TOP).apply { topMargin = ncDp(ctx, 12f) })
    chevron.setImageResource(R.drawable.nc_ic_chevron_up)
    lockPill.addView(chevron, LayoutParams(li, li, Gravity.CENTER_HORIZONTAL or Gravity.BOTTOM).apply { bottomMargin = ncDp(ctx, 12f) })
    addView(lockPill, LayoutParams(pillW, pillH))
  }

  fun setup(ox: Float, oy: Float, t: NCResolved) {
    originX = ox
    originY = oy
    haloBg.setColor((t.action and 0x00FFFFFF) or 0x2E000000)
    halo2Bg.setColor((t.action and 0x00FFFFFF) or 0x14000000)
    circleBg.setColor(t.action)
    mic.imageTintList = android.content.res.ColorStateList.valueOf(t.actionIcon)
    pillBg.setColor(t.pill)
    pillBg.setStroke(ncDp(context, 1f), t.pillBorder)
    lockIcon.imageTintList = android.content.res.ColorStateList.valueOf(t.text)
    chevron.imageTintList = android.content.res.ColorStateList.valueOf(t.icon)
    place(ox, oy, 0f)
  }

  private fun place(cx: Float, cy: Float, pillDy: Float) {
    circle.x = cx - d / 2f
    circle.y = cy - d / 2f
    halo.x = cx - d / 2f
    halo.y = cy - d / 2f
    halo2.x = cx - d / 2f
    halo2.y = cy - d / 2f
    lockPill.x = originX - pillW / 2f
    lockPill.y = originY - ncDp(context, 64f) - pillH + pillDy
  }

  /** true = o halo é animado pelo tick (applyLevel), não pelo arrasto. */
  var smooth = false

  /** [2026-10-16 motion-composer] halo segue o volume suavizado; interpola entre ticks. */
  fun applyLevel(inner: Float, outer: Float) {
    val s = 1f + inner * 0.55f
    val s2 = 1f + outer * 0.95f
    halo.animate().scaleX(s).scaleY(s).setDuration(40).setInterpolator(null).start()
    halo2.animate().scaleX(s2).scaleY(s2).setDuration(40).setInterpolator(null).start()
  }

  fun update(dx: Float, dy: Float, lockProgress: Float, level: Float) {
    var cx = originX
    var cy = originY
    if (abs(dx) > abs(dy)) cx += min(0f, dx) else cy += min(0f, dy)
    place(cx, cy, min(0f, dy) * 0.35f)
    if (!smooth) {
      val s = 1f + level * 0.55f
      halo.scaleX = s
      halo.scaleY = s
    }
    chevron.alpha = 1f - lockProgress
    lockIcon.translationY = lockProgress * ncDp(context, 8f)
  }
}

internal class NCVoiceController(private val host: ChatyyComposerView) {
  private val ctx: Context = host.context
  private val handler = Handler(Looper.getMainLooper())
  val panel = NCVoicePanel(ctx)

  var isActive = false
    private set
  var isLocked = false
    private set
  // [2026-10-18 voz-pausa] WhatsApp: travado → pausar (prévia ouvível) →
  // continuar → enviar. Cada trecho = um m4a próprio (só fica tocável depois do
  // stop()); no envio com >1 trecho, MediaMuxer junta num m4a só.
  var isPaused = false
    private set
  private val segments = ArrayList<File>()
  private val segDurations = ArrayList<Long>()
  private var accumulatedMs = 0L
  private var lostMs = 0L
  private var previewPlayer: MediaPlayer? = null
  private var previewIndex = 0

  private var recorder: MediaRecorder? = null
  private var file: File? = null
  private var startedAt = 0L
  private val samples = ArrayList<Float>()
  private var lastLevel = 0f
  // [2026-10-16 motion-composer] nível suavizado só p/ o halo (samples crus).
  private var smoothLevel = 0f
  private var smoothOuter = 0f
  private var nudgeAnim: ValueAnimator? = null
  private val motionOn: Boolean
    get() = host.motionEnabled && (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || ValueAnimator.areAnimatorsEnabled())
  private var overlay: NCHoldOverlay? = null
  private var blink: ObjectAnimator? = null
  private var downX = 0f
  private var downY = 0f
  private var pendingStart = false
  private var lockArmed = false
  private var focusRequest: AudioFocusRequest? = null
  private var focusListener: AudioManager.OnAudioFocusChangeListener? = null
  private var labels: Map<String, String> = emptyMap()

  private val cancelDistance = ncDp(ctx, 120f).toFloat()
  private val lockDistance = ncDp(ctx, 84f).toFloat()
  private val maxDurationMs = 15 * 60 * 1000L

  init {
    panel.visibility = View.GONE
    panel.alpha = 0f
    panel.trash.setOnClickListener { cancel("trash") }
    panel.pauseBtn.setOnClickListener { if (isPaused) resume() else pause() }
    panel.playBtn.setOnClickListener { playTapped() }
    applyLabels()
  }

  fun setLabels(m: Map<String, String>) {
    labels = m
    applyLabels()
  }

  private fun applyLabels() {
    panel.slide.text = "‹  " + (labels["slideToCancel"] ?: "Slide to cancel")
    panel.trash.contentDescription = labels["deleteRecording"] ?: labels["cancelRecording"]
    panel.contentDescription = labels["recording"]
    panel.pauseBtn.contentDescription = if (isPaused) {
      labels["resumeRecording"] ?: "Continuar gravação"
    } else {
      labels["pauseRecording"] ?: "Pausar gravação"
    }
    panel.playBtn.contentDescription = if (previewPlaying()) {
      labels["pausePreview"] ?: "Pausar"
    } else {
      labels["playPreview"] ?: "Ouvir gravação"
    }
  }

  private fun previewPlaying(): Boolean {
    val p = previewPlayer ?: return false
    return try { p.isPlaying } catch (_: Throwable) { false }
  }

  /** [voz-pausa] Ícones do painel travado conforme o estado. */
  private fun refreshPauseIcons() {
    panel.pauseBtn.setImageResource(if (isPaused) R.drawable.nc_ic_mic else R.drawable.nc_ic_pause)
    panel.playBtn.setImageResource(if (previewPlaying()) R.drawable.nc_ic_pause else R.drawable.nc_ic_play)
    applyLabels()
  }

  fun applyTheme(t: NCResolved) {
    panel.colors(t.surface, t.text, t.secondaryText, t.recording, t.accent)
  }

  private val startRunnable = Runnable { beginHold() }

  private val tickRunnable = object : Runnable {
    override fun run() {
      if (!isActive) return
      tick()
      handler.postDelayed(this, 33)
    }
  }

  @SuppressLint("ClickableViewAccessibility")
  val touchListener = View.OnTouchListener { v, ev ->
    val action = host.actionButton
    // Modo enviar (ou travado → toque = enviar): deixa o clique normal agir.
    if (!isActive && action.mode == NCActionButton.Mode.SEND) return@OnTouchListener false
    if (isLocked) return@OnTouchListener false
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        if (!host.voiceEnabled || host.disabledProp) return@OnTouchListener false
        downX = ev.rawX
        downY = ev.rawY
        pendingStart = true
        v.parent?.requestDisallowInterceptTouchEvent(true)
        action.press(true)
        handler.postDelayed(startRunnable, 160)
        true
      }
      MotionEvent.ACTION_MOVE -> {
        if (isActive && !isLocked) onDrag(ev.rawX - downX, ev.rawY - downY)
        true
      }
      MotionEvent.ACTION_UP -> {
        handler.removeCallbacks(startRunnable)
        action.press(false)
        v.parent?.requestDisallowInterceptTouchEvent(false)
        if (pendingStart && !isActive) {
          pendingStart = false
          tapWithoutHold()
        } else if (isActive && !isLocked) {
          finish(true)
        }
        pendingStart = false
        true
      }
      MotionEvent.ACTION_CANCEL -> {
        handler.removeCallbacks(startRunnable)
        action.press(false)
        v.parent?.requestDisallowInterceptTouchEvent(false)
        pendingStart = false
        if (isActive && !isLocked) cancel("gesture")
        true
      }
      else -> true
    }
  }

  fun tapWithoutHold() {
    if (host.voiceBlocked) {
      host.emitVoiceState("blocked")
      return
    }
    host.actionButton.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    host.emitVoiceState("tapHint")
  }

  private fun beginHold() {
    pendingStart = false
    if (host.voiceBlocked) {
      host.emitVoiceState("blocked")
      reject()
      return
    }
    if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      host.emitVoiceState("error", "permission")
      return
    }
    try {
      startRecorder()
    } catch (t: Throwable) {
      Log.w(VTAG, "start: ${t.message}")
      releaseRecorderQuietly(deleteFile = true)
      abandonFocus()
      host.emitVoiceState("error", "start")
      reject()
      return
    }
    isActive = true
    isLocked = false
    lockArmed = false
    panel.locked = false
    panel.dx = 0f
    panel.wave.reset()
    showOverlay()
    showPanel()
    host.voiceDidChangeActive()
    host.actionButton.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    host.emitVoiceState("recording")
    handler.post(tickRunnable)
  }

  private fun reject() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      host.actionButton.performHapticFeedback(HapticFeedbackConstants.REJECT)
    } else {
      host.actionButton.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    }
  }

  private fun onDrag(dx: Float, dy: Float) {
    val lockProgress = (-dy / lockDistance).coerceIn(0f, 1f)
    overlay?.update(dx, dy, lockProgress, lastLevel)
    val cancelProgress = (-dx / cancelDistance).coerceIn(0f, 1f)
    panel.slide.alpha = 1f - cancelProgress * 0.85f
    panel.dx = dx
    panel.applySlide()
    if (lockProgress > 0.6f && !lockArmed) {
      lockArmed = true
      host.actionButton.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    } else if (lockProgress < 0.4f) {
      lockArmed = false
    }
    if (dx <= -cancelDistance) {
      cancel("slide")
    } else if (dy <= -lockDistance) {
      lock()
    }
  }

  // ── Gravação ──

  private fun startRecorder() {
    segments.clear()
    segDurations.clear()
    accumulatedMs = 0L
    lostMs = 0L
    isPaused = false
    samples.clear()
    lastLevel = 0f
    smoothLevel = 0f
    smoothOuter = 0f
    startSegment()
  }

  /** [2026-10-18 voz-pausa] Trecho novo: início ou "continuar" depois de pausar. */
  @Suppress("DEPRECATION")
  private fun startSegment() {
    val out = File(ctx.cacheDir, "voice_${UUID.randomUUID()}.m4a")
    val rec = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(ctx) else MediaRecorder()
    rec.setAudioSource(MediaRecorder.AudioSource.MIC)
    rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
    rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
    rec.setAudioSamplingRate(24000)
    rec.setAudioChannels(1)
    rec.setAudioEncodingBitRate(32_000)
    rec.setOutputFile(out.absolutePath)
    rec.setOnErrorListener { _, what, extra ->
      Log.w(VTAG, "MediaRecorder error what=$what extra=$extra")
      handler.post {
        if (isActive) {
          host.emitVoiceState("error", "encoder")
          cancel("encoder", silent = true)
        }
      }
    }
    recorder = rec
    file = out
    abandonFocus()
    requestFocus()
    rec.prepare()
    rec.start()
    startedAt = SystemClock.elapsedRealtime()
    try { rec.maxAmplitude } catch (_: Throwable) {} // 1ª leitura sempre 0
  }

  /** Ligação/outro app pegou o áudio: segurando = cancela; travado = PAUSA (WhatsApp). */
  private fun onInterrupted() {
    if (!isActive) return
    if (isLocked) {
      if (isPaused) stopPreview() else pause()
    } else {
      cancel("interrupted")
    }
  }

  private fun tick() {
    val r = recorder ?: return
    val amp = try { r.maxAmplitude } catch (_: Throwable) { 0 }
    val level = if (amp <= 0) 0f else ((20.0 * log10(amp / 32767.0) + 50.0) / 50.0).toFloat().coerceIn(0f, 1f)
    lastLevel = level
    samples.add(level)
    if (isLocked) panel.wave.push(level)
    val elapsed = accumulatedMs + (SystemClock.elapsedRealtime() - startedAt)
    setTime(elapsed)
    overlay?.let {
      if (it.smooth) {
        smoothLevel += (level - smoothLevel) * (if (level > smoothLevel) 0.55f else 0.18f)
        smoothOuter += (level - smoothOuter) * (if (level > smoothOuter) 0.30f else 0.08f)
        it.applyLevel(smoothLevel, smoothOuter)
      } else {
        val s = 1f + level * 0.55f
        it.halo.scaleX = s
        it.halo.scaleY = s
      }
    }
    if (elapsed >= maxDurationMs) finish(true)
  }

  private fun setTime(ms: Long) {
    val secs = (max(0L, ms) / 1000).toInt()
    panel.time.text = String.format("%d:%02d", secs / 60, secs % 60)
  }

  private fun releaseRecorderQuietly(deleteFile: Boolean): Pair<File?, String?> {
    val rec = recorder
    recorder = null
    var err: String? = null
    try { rec?.setOnErrorListener(null) } catch (_: Throwable) {}
    try { rec?.stop() } catch (t: Throwable) { err = t.message ?: "stop_failed" }
    try { rec?.release() } catch (_: Throwable) {}
    val f = file
    file = null
    if (deleteFile || err != null) {
      try { f?.delete() } catch (_: Throwable) {}
      return Pair(null, err)
    }
    return Pair(f, null)
  }

  /** Fecha o trecho atual (arquivo tocável) e soma a duração dele. */
  private fun stopSegment() {
    handler.removeCallbacks(tickRunnable)
    if (recorder == null) return
    val d = SystemClock.elapsedRealtime() - startedAt
    val (f, err) = releaseRecorderQuietly(deleteFile = false)
    if (f != null && err == null) {
      segments.add(f)
      segDurations.add(d)
      accumulatedMs += d
    } else {
      lostMs += d
    }
  }

  private fun deleteFiles(list: List<File>) {
    for (f in list) {
      try { f.delete() } catch (_: Throwable) {}
    }
  }

  fun finish(send: Boolean) {
    if (!isActive) return
    stopPreview()
    stopSegment()
    abandonFocus()
    val segs = ArrayList(segments)
    segments.clear()
    segDurations.clear()
    val durationMs = accumulatedMs
    val wallMs = accumulatedMs + lostMs
    accumulatedMs = 0L
    lostMs = 0L
    val snapshot = ArrayList(samples)
    teardownUI()
    if (!send) {
      deleteFiles(segs)
      return
    }
    if (segs.isEmpty()) {
      host.emitVoiceState("error", if (wallMs < 1000) "tooShort" else "empty")
      return
    }
    if (durationMs < 1000) {
      deleteFiles(segs)
      reject()
      host.emitVoiceState("tooShort")
      return
    }
    if (segs.size == 1) {
      deliver(segs[0], durationMs, snapshot)
      return
    }
    // [voz-pausa] >1 trecho → um m4a só (thread própria; entrega na main).
    Thread {
      val merged = mergeSegments(segs)
      handler.post {
        deleteFiles(segs)
        if (merged == null) {
          host.emitVoiceState("error", "merge")
        } else {
          deliver(merged, durationMs, snapshot)
        }
      }
    }.start()
  }

  private fun deliver(f: File, durationMs: Long, snapshot: List<Float>) {
    val size = f.length()
    if (size < 1500) {
      try { f.delete() } catch (_: Throwable) {}
      host.emitVoiceState("error", "empty")
      return
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      host.actionButton.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
    } else {
      host.actionButton.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    }
    host.emitVoiceRecorded(
      mapOf(
        "uri" to Uri.fromFile(f).toString(),
        "durationMs" to durationMs,
        "sizeBytes" to size,
        "waveform" to resample(snapshot, 40).map { it.toDouble() },
        "mimeType" to "audio/mp4",
        "name" to "audio_${System.currentTimeMillis()}.m4a"
      )
    )
    host.emitVoiceState("sent")
  }

  /** Concatena os trechos AAC (mesmo perfil) num MP4 só, sem reencodar. */
  private fun mergeSegments(segs: List<File>): File? {
    val out = File(ctx.cacheDir, "voice_${UUID.randomUUID()}.m4a")
    var muxer: MediaMuxer? = null
    try {
      val mx = MediaMuxer(out.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      muxer = mx
      var track = -1
      var offsetUs = 0L
      val buf = ByteBuffer.allocate(256 * 1024)
      val info = MediaCodec.BufferInfo()
      for (f in segs) {
        val ex = MediaExtractor()
        try {
          ex.setDataSource(f.absolutePath)
          var ti = -1
          for (i in 0 until ex.trackCount) {
            val mime = ex.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: ""
            if (mime.startsWith("audio/")) {
              ti = i
              break
            }
          }
          if (ti < 0) continue
          ex.selectTrack(ti)
          if (track < 0) {
            track = mx.addTrack(ex.getTrackFormat(ti))
            mx.start()
          }
          var lastUs = -1L
          while (true) {
            buf.clear()
            val n = ex.readSampleData(buf, 0)
            if (n < 0) break
            val t = ex.sampleTime
            lastUs = t
            info.offset = 0
            info.size = n
            info.presentationTimeUs = offsetUs + max(0L, t)
            info.flags = if ((ex.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC) != 0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
            mx.writeSampleData(track, buf, info)
            ex.advance()
          }
          // próximo trecho começa 1 quadro AAC depois do último (1024 amostras @ 24 kHz)
          if (lastUs >= 0) offsetUs += lastUs + AAC_FRAME_US
        } finally {
          try { ex.release() } catch (_: Throwable) {}
        }
      }
      if (track < 0) {
        try { mx.release() } catch (_: Throwable) {}
        muxer = null
        try { out.delete() } catch (_: Throwable) {}
        return null
      }
      mx.stop()
      mx.release()
      muxer = null
      return out
    } catch (t: Throwable) {
      Log.w(VTAG, "merge: ${t.message}")
      try { muxer?.release() } catch (_: Throwable) {}
      try { out.delete() } catch (_: Throwable) {}
      return null
    }
  }

  fun finishLocked() {
    if (isActive && isLocked) finish(true)
  }

  fun cancel(reason: String, silent: Boolean = false) {
    if (!isActive) {
      handler.removeCallbacks(startRunnable)
      pendingStart = false
      return
    }
    stopPreview()
    handler.removeCallbacks(tickRunnable)
    releaseRecorderQuietly(deleteFile = true)
    deleteFiles(ArrayList(segments))
    segments.clear()
    segDurations.clear()
    accumulatedMs = 0L
    lostMs = 0L
    abandonFocus()
    teardownUI()
    if (!silent && reason != "unmount" && reason != "js") reject()
    if (reason != "unmount") host.emitVoiceState("cancelled", reason)
  }

  // ── Pausa / prévia (travado) — [2026-10-18 voz-pausa] ──

  private fun pause() {
    if (!isActive || !isLocked || isPaused) return
    stopSegment()
    isPaused = true
    panel.paused = true
    blink?.cancel()
    blink = null
    panel.dot.alpha = 1f
    panel.refreshWaveColor()
    panel.wave.setStatic(samples)
    setTime(accumulatedMs)
    refreshPauseIcons()
    panel.requestLayout()
    host.actionButton.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    host.emitVoiceState("paused")
  }

  private fun resume() {
    if (!isActive || !isLocked || !isPaused) return
    stopPreview()
    try {
      startSegment()
    } catch (t: Throwable) {
      // Continua pausado: o que já foi gravado segue enviável.
      Log.w(VTAG, "resume: ${t.message}")
      releaseRecorderQuietly(deleteFile = true)
      host.emitVoiceState("error", "start")
      return
    }
    isPaused = false
    panel.paused = false
    panel.wave.reset()
    panel.refreshWaveColor()
    val from = max(0, samples.size - 120)
    for (i in from until samples.size) panel.wave.push(samples[i])
    startBlink()
    refreshPauseIcons()
    panel.requestLayout()
    handler.removeCallbacks(tickRunnable)
    handler.post(tickRunnable)
    host.actionButton.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    host.emitVoiceState("resumed")
  }

  private val previewTick = object : Runnable {
    override fun run() {
      val p = previewPlayer ?: return
      var played = 0L
      val upto = min(previewIndex, segDurations.size)
      for (j in 0 until upto) played += segDurations[j]
      played += try { p.currentPosition.toLong() } catch (_: Throwable) { 0L }
      val total = max(1L, accumulatedMs)
      panel.wave.progress = (played.toFloat() / total.toFloat()).coerceIn(0f, 1f)
      setTime(played)
      handler.postDelayed(this, 33)
    }
  }

  private fun playTapped() {
    if (!isActive || !isPaused) return
    val p = previewPlayer
    if (p != null) {
      try {
        if (p.isPlaying) {
          p.pause()
          handler.removeCallbacks(previewTick)
        } else {
          p.start()
          handler.removeCallbacks(previewTick)
          handler.post(previewTick)
        }
      } catch (t: Throwable) {
        stopPreview()
      }
      refreshPauseIcons()
      return
    }
    playSegment(0)
  }

  private fun playSegment(i: Int) {
    if (i >= segments.size) {
      stopPreview()
      return
    }
    releasePreviewPlayer()
    try {
      val mp = MediaPlayer()
      mp.setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
      )
      mp.setDataSource(segments[i].absolutePath)
      mp.setOnCompletionListener { done ->
        if (done === previewPlayer) {
          val next = previewIndex + 1
          if (next < segments.size) playSegment(next) else stopPreview()
        }
      }
      mp.prepare()
      previewPlayer = mp
      previewIndex = i
      mp.start()
      handler.removeCallbacks(previewTick)
      handler.post(previewTick)
      refreshPauseIcons()
    } catch (t: Throwable) {
      Log.w(VTAG, "preview: ${t.message}")
      stopPreview()
    }
  }

  private fun releasePreviewPlayer() {
    val p = previewPlayer ?: return
    previewPlayer = null
    try { p.setOnCompletionListener(null) } catch (_: Throwable) {}
    try { p.stop() } catch (_: Throwable) {}
    try { p.release() } catch (_: Throwable) {}
  }

  private fun stopPreview() {
    handler.removeCallbacks(previewTick)
    releasePreviewPlayer()
    previewIndex = 0
    if (isPaused) {
      panel.wave.progress = 0f
      setTime(accumulatedMs)
    }
    refreshPauseIcons()
  }

  private fun lock() {
    if (!isActive || isLocked) return
    isLocked = true
    host.actionButton.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    removeOverlay(animated = true)
    panel.locked = true
    panel.wave.reset()
    val from = max(0, samples.size - 120)
    for (i in from until samples.size) panel.wave.push(samples[i])
    refreshPauseIcons()
    panel.requestLayout()
    host.voiceDidLock()
    host.emitVoiceState("locked")
  }

  // ── Foco de áudio ──

  private fun requestFocus() {
    try {
      val am = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
      val l = AudioManager.OnAudioFocusChangeListener { change ->
        if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
          handler.post { onInterrupted() }
        }
      }
      focusListener = l
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
          .setAudioAttributes(
            AudioAttributes.Builder()
              .setUsage(AudioAttributes.USAGE_MEDIA)
              .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
              .build()
          )
          .setOnAudioFocusChangeListener(l, handler)
          .build()
        focusRequest = req
        am.requestAudioFocus(req)
      } else {
        @Suppress("DEPRECATION")
        am.requestAudioFocus(l, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
      }
    } catch (t: Throwable) {
      Log.w(VTAG, "requestFocus: ${t.message}")
    }
  }

  private fun abandonFocus() {
    try {
      val am = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
      val req = focusRequest
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && req != null) {
        am.abandonAudioFocusRequest(req)
      } else {
        focusListener?.let {
          @Suppress("DEPRECATION")
          am.abandonAudioFocus(it)
        }
      }
    } catch (_: Throwable) {}
    focusRequest = null
    focusListener = null
  }

  // ── UI ──

  private fun showOverlay() {
    val activity = (host.appContext.currentActivity ?: (ctx as? Activity)) ?: return
    val decor = activity.window?.decorView as? ViewGroup ?: return
    val o = NCHoldOverlay(ctx)
    val loc = IntArray(2)
    host.actionButton.getLocationInWindow(loc)
    val decorLoc = IntArray(2)
    decor.getLocationInWindow(decorLoc)
    val cx = (loc[0] - decorLoc[0]) + host.actionButton.width / 2f
    val cy = (loc[1] - decorLoc[1]) + host.actionButton.height / 2f
    o.setup(cx, cy, host.theme)
    o.smooth = motionOn
    o.halo2.visibility = if (o.smooth) View.VISIBLE else View.GONE
    o.halo2.alpha = 0f
    decor.addView(o, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    overlay = o
    o.circle.scaleX = 0.45f
    o.circle.scaleY = 0.45f
    o.halo.alpha = 0f
    o.lockPill.alpha = 0f
    o.lockPill.translationY = ncDp(ctx, 24f).toFloat()
    o.circle.animate().scaleX(1f).scaleY(1f).setDuration(320).setInterpolator(OvershootInterpolator(1.8f)).start()
    o.halo.animate().alpha(1f).setDuration(200).start()
    if (o.smooth) o.halo2.animate().alpha(1f).setDuration(260).start()
    o.lockPill.animate().alpha(1f).translationY(0f).setDuration(300).setInterpolator(DecelerateInterpolator()).start()
  }

  private fun removeOverlay(animated: Boolean) {
    val o = overlay ?: return
    overlay = null
    if (!animated) {
      (o.parent as? ViewGroup)?.removeView(o)
      return
    }
    o.animate().alpha(0f).setDuration(180).withEndAction {
      (o.parent as? ViewGroup)?.removeView(o)
    }.start()
    o.circle.animate().scaleX(0.4f).scaleY(0.4f).setDuration(180).start()
  }

  private fun showPanel() {
    panel.animate().cancel()
    panel.visibility = View.VISIBLE
    panel.slide.alpha = 1f
    panel.slide.translationX = 0f
    panel.time.text = "0:00"
    panel.translationX = ncDp(ctx, 24f).toFloat()
    panel.animate().alpha(1f).translationX(0f).setDuration(200).setInterpolator(DecelerateInterpolator()).start()
    startBlink()
    // [2026-10-16 motion-composer] seta "deslize p/ cancelar" cutuca p/ a esquerda.
    nudgeAnim?.cancel()
    nudgeAnim = null
    panel.nudge = 0f
    if (motionOn) {
      val amp = ncDp(ctx, 7f).toFloat()
      nudgeAnim = ValueAnimator.ofFloat(0f, 1f).apply {
        duration = 750
        repeatMode = ValueAnimator.REVERSE
        repeatCount = ValueAnimator.INFINITE
        interpolator = android.view.animation.AccelerateDecelerateInterpolator()
        addUpdateListener { va ->
          if (nudgeAnim !== va) return@addUpdateListener
          panel.nudge = -(va.animatedValue as Float) * amp
          if (!panel.locked) panel.applySlide()
        }
        start()
      }
    }
    panel.requestLayout()
  }

  /** Ponto vermelho piscando (gravando). */
  private fun startBlink() {
    blink?.cancel()
    blink = ObjectAnimator.ofFloat(panel.dot, View.ALPHA, 1f, 0.15f).apply {
      duration = 550
      repeatMode = ValueAnimator.REVERSE
      repeatCount = ValueAnimator.INFINITE
      start()
    }
  }

  private fun teardownUI() {
    val was = isActive
    isActive = false
    isLocked = false
    isPaused = false
    panel.locked = false
    panel.paused = false
    panel.refreshWaveColor()
    refreshPauseIcons()
    panel.dx = 0f
    removeOverlay(animated = true)
    blink?.cancel()
    blink = null
    nudgeAnim?.let { nudgeAnim = null; it.cancel() }
    panel.nudge = 0f
    panel.dot.alpha = 1f
    panel.animate().cancel()
    panel.animate().alpha(0f).setDuration(160).withEndAction {
      if (!isActive) panel.visibility = View.GONE
    }.start()
    if (was) {
      host.voiceDidEnd()
      host.voiceDidChangeActive()
    }
  }

  companion object {
    fun resample(src: List<Float>, bars: Int): List<Float> {
      if (src.isEmpty() || bars <= 0) return emptyList()
      if (src.size <= bars) return src.map { it.coerceIn(0.04f, 1f) }
      val out = ArrayList<Float>(bars)
      val step = src.size.toDouble() / bars
      for (i in 0 until bars) {
        val a = (i * step).toInt()
        val b = max(a + 1, min(src.size, ((i + 1) * step).toInt()))
        var peak = 0f
        for (j in a until b) peak = max(peak, src[j])
        out.add(peak.coerceIn(0.04f, 1f))
      }
      return out
    }
  }
}
