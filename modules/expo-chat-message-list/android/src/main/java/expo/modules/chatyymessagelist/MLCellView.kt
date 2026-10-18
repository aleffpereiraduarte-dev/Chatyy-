package expo.modules.chatyymessagelist

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.text.TextPaint
import android.graphics.drawable.Animatable
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.net.Uri
import android.os.SystemClock
import android.view.animation.DecelerateInterpolator
import android.graphics.Bitmap
import android.graphics.LinearGradient
import android.graphics.Shader
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import com.bumptech.glide.Glide
import com.bumptech.glide.load.engine.DiskCacheStrategy
import com.bumptech.glide.request.target.CustomTarget
import com.bumptech.glide.request.transition.Transition
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

// [2026-10-14 native-list] Uma View por linha que DESENHA tudo em onDraw
// (balão, textos StaticLayout, hora/✓✓, citação, mídia, áudio, arquivo,
// reações). Zero hierarquia de views → bind/rolagem baratos.

// [2026-10-17 voz-wa, apiVersion 8] rateLabel = "1×"/"1,5×"/"2×" (vazio = sem pílula)
data class MLAudioState(val id: String, val playing: Boolean, val loading: Boolean, val posMs: Double?, val durMs: Double?, val rateLabel: String = "")

/** Slot de imagem carregado via Glide (mesmas versões que o expo-image já traz). */
class MLImageSlot(private val owner: View) {
  var drawable: Drawable? = null
    private set
  private var model: String = ""
  private var thumbModel: String = ""
  private var target: CustomTarget<Drawable>? = null
  private var thumbTarget: CustomTarget<Drawable>? = null
  private var thumb: Drawable? = null
  private var shownAt = 0L
  // [native-media-dl] miniatura → foto nítida com cross-fade (só se a foto chegou depois)
  private var setAt = 0L
  private var fadeAt = 0L
  // [2026-10-18 vthumb] 1º frame de vídeo sem pôster (MLVideoFrames): URL em voo + fade de entrada
  private var vfUrl: String = ""
  private var frameFadeAt = 0L
  // [2026-10-18 lqip] pôster falhou (404/rede) → nova tentativa em 2 s, 6 s, 15 s
  private var failed = false
  private var retryN = 0
  private var retryRun: Runnable? = null

  fun set(uri: String, thumbUri: String, w: Int, h: Int, animated: Boolean, fit: Boolean = false, vf: String = "") {
    val vfUse = if (uri.isEmpty() && thumbUri.isEmpty()) vf else ""
    val key = if (vfUse.isNotEmpty()) "vf:$vfUse" else uri
    // [2026-10-18 lqip] mesma chave mas o pôster falhou → recarrega (não fica preso na LQIP)
    if (key == model && thumbUri == thumbModel && (drawable != null || (target != null && !failed) || vfUrl.isNotEmpty())) return
    val keepRetryN = if (key == model) retryN else 0
    // [native-media-dl] mesma miniatura, foto nova (baixou agora) → mantém a
    // miniatura na tela enquanto a foto decodifica (cross-fade em draw)
    val keepThumb = thumbUri.isNotEmpty() && thumbUri == thumbModel && thumb != null && drawable == null
    val keptThumb = if (keepThumb) thumb else null
    val keptThumbTarget = if (keepThumb) thumbTarget else null
    if (keepThumb) thumbTarget = null
    clear()
    retryN = keepRetryN
    model = key
    thumbModel = thumbUri
    setAt = android.os.SystemClock.uptimeMillis()
    fadeAt = 0L
    val ctx = owner.context.applicationContext
    if (keepThumb) { thumb = keptThumb; thumbTarget = keptThumbTarget }
    val blurHit = if (thumbUri.isNotEmpty() && !keepThumb) MLBlur.cached(thumbUri) else null
    if (blurHit != null) thumb = BitmapDrawable(owner.resources, blurHit)
    if (thumbUri.isNotEmpty() && !keepThumb && blurHit == null) {
      val t = object : CustomTarget<Drawable>(64, 64) {
        override fun onResourceReady(resource: Drawable, transition: Transition<in Drawable>?) {
          if (thumbModel != thumbUri) return
          // [2026-10-18 lqip] desfoque suave (fora da main) antes de mostrar
          val bmp = (resource as? BitmapDrawable)?.bitmap
          val copy = try { bmp?.copy(Bitmap.Config.ARGB_8888, false) } catch (_: Throwable) { null }
          if (copy == null) {
            thumb = resource
            if (drawable == null) owner.invalidate()
            return
          }
          MLBlur.blur(thumbUri, copy) { out ->
            if (thumbModel == thumbUri) {
              thumb = if (out != null) BitmapDrawable(owner.resources, out) else resource
              if (drawable == null) owner.invalidate()
            }
          }
        }
        override fun onLoadCleared(placeholder: Drawable?) { thumb = null }
      }
      thumbTarget = t
      try { Glide.with(ctx).load(modelOf(thumbUri)).disallowHardwareConfig().into(t) } catch (_: Throwable) {}
    }
    if (uri.isEmpty()) {
      if (vfUse.isNotEmpty()) loadFrame(vfUse, key, max(w, h))
      return
    }
    val tw = max(16, w)
    val th = max(16, h)
    val t = object : CustomTarget<Drawable>(tw, th) {
      override fun onResourceReady(resource: Drawable, transition: Transition<in Drawable>?) {
        if (model != uri) return
        drawable = resource
        shownAt = System.currentTimeMillis()
        val now = android.os.SystemClock.uptimeMillis()
        if (thumb != null && now - setAt > 60) fadeAt = now
        if (resource is Animatable) {
          resource.callback = owner
          (resource as Animatable).start()
        }
        owner.invalidate()
      }
      override fun onLoadCleared(placeholder: Drawable?) {
        val d = drawable
        if (d is Animatable) (d as Animatable).stop()
        drawable = null
      }
      override fun onLoadFailed(errorDrawable: Drawable?) {
        if (model != uri || target !== this) return
        failed = true
        scheduleRetry(uri, thumbUri, w, h, animated, fit)
      }
    }
    target = t
    try {
      var rb = Glide.with(ctx).load(modelOf(uri)).diskCacheStrategy(DiskCacheStrategy.AUTOMATIC)
      rb = if (fit) rb.fitCenter() else rb.centerCrop()
      if (!animated) rb = rb.dontAnimate()
      rb.into(t)
    } catch (_: Throwable) {}
  }

  private fun scheduleRetry(uri: String, thumbUri: String, w: Int, h: Int, animated: Boolean, fit: Boolean) {
    if (retryRun != null || retryN >= RETRY_MS.size) return
    val delay = RETRY_MS[retryN]
    retryN += 1
    val r = Runnable {
      retryRun = null
      if (model == uri && drawable == null && failed) set(uri, thumbUri, w, h, animated, fit)
    }
    retryRun = r
    owner.postDelayed(r, delay)
  }

  private fun loadFrame(url: String, key: String, px: Int) {
    val res = owner.resources
    val hit = MLVideoFrames.cached(url)
    if (hit != null) {
      drawable = BitmapDrawable(res, hit)
      frameFadeAt = 0L
      owner.invalidate()
      return
    }
    vfUrl = url
    MLVideoFrames.load(owner.context, url, px) { bmp ->
      if (vfUrl == url) vfUrl = ""
      if (model == key && bmp != null) {
        drawable = BitmapDrawable(res, bmp)
        frameFadeAt = android.os.SystemClock.uptimeMillis()
        owner.invalidate()
      }
    }
  }

  fun clear() {
    val ctx = owner.context.applicationContext
    if (vfUrl.isNotEmpty()) {
      MLVideoFrames.cancel(vfUrl)
      vfUrl = ""
    }
    frameFadeAt = 0L
    retryRun?.let { owner.removeCallbacks(it) }
    retryRun = null
    failed = false
    retryN = 0
    target?.let { try { Glide.with(ctx).clear(it) } catch (_: Throwable) {} }
    thumbTarget?.let { try { Glide.with(ctx).clear(it) } catch (_: Throwable) {} }
    val d = drawable
    if (d is Animatable) (d as Animatable).stop()
    target = null
    thumbTarget = null
    drawable = null
    thumb = null
    model = ""
    thumbModel = ""
  }

  /** Desenha com centerCrop (o Glide já recortou p/ o tamanho; ajuste fino aqui). */
  fun draw(c: Canvas, r: RectF, radius: Float, fit: Boolean): Boolean {
    val full = drawable
    val th = thumb
    if (full != null && th != null && fadeAt > 0L) {
      val t = (android.os.SystemClock.uptimeMillis() - fadeAt) / 240f
      if (t < 1f) {
        drawOne(c, th, r, radius, fit, 255)
        drawOne(c, full, r, radius, fit, (255 * t).toInt().coerceIn(0, 255))
        owner.postInvalidateOnAnimation()
        return true
      }
      fadeAt = 0L
    }
    if (full != null && th == null && frameFadeAt > 0L) {
      val ft = (android.os.SystemClock.uptimeMillis() - frameFadeAt) / 220f
      if (ft < 1f) {
        drawOne(c, full, r, radius, fit, (255 * ft).toInt().coerceIn(0, 255))
        owner.postInvalidateOnAnimation()
        return true
      }
      frameFadeAt = 0L
    }
    val d = full ?: th ?: return false
    drawOne(c, d, r, radius, fit, 255)
    return true
  }

  private fun drawOne(c: Canvas, d: Drawable, r: RectF, radius: Float, fit: Boolean, alpha: Int) {
    val iw = d.intrinsicWidth.toFloat()
    val ih = d.intrinsicHeight.toFloat()
    c.save()
    if (radius > 0) {
      val p = Path()
      p.addRoundRect(r, radius, radius, Path.Direction.CW)
      c.clipPath(p)
    } else {
      c.clipRect(r)
    }
    if (iw > 0 && ih > 0) {
      val scale = if (fit) min(r.width() / iw, r.height() / ih) else max(r.width() / iw, r.height() / ih)
      val dw = iw * scale
      val dh = ih * scale
      val l = r.left + (r.width() - dw) / 2
      val t = r.top + (r.height() - dh) / 2
      d.setBounds(l.toInt(), t.toInt(), (l + dw).toInt(), (t + dh).toInt())
    } else {
      d.setBounds(r.left.toInt(), r.top.toInt(), r.right.toInt(), r.bottom.toInt())
    }
    if (alpha < 255) d.alpha = alpha
    d.draw(c)
    if (alpha < 255) d.alpha = 255
    c.restore()
  }

  companion object {
    private val RETRY_MS = longArrayOf(2000L, 6000L, 15000L)

    fun modelOf(s: String): Any = when {
      s.startsWith("file://") || s.startsWith("content://") -> Uri.parse(s)
      s.startsWith("/") -> java.io.File(s)
      else -> s // http(s) e data: (o Glide decodifica data URI nativamente)
    }
  }
}

@SuppressLint("ViewConstructor")
class MLCellView(context: Context) : ViewGroup(context) {
  var key: String = ""
    private set
  var row: MLRow? = null
    private set
  var lay: MLRowLayout? = null
    private set
  private var style: MLStyle? = null
  private var audio: MLAudioState? = null

  val mediaSlot = MLImageSlot(this)
  val replySlot = MLImageSlot(this)
  val albumSlots = Array(4) { MLImageSlot(this) }

  var swipeX = 0f
    set(v) { field = v; vnView?.translationX = v; invalidate() }
  // [reply-v2] "estalo" do ícone de responder ao cruzar o limiar (escala extra).
  private var swipePop = 0f
  private var swipePopAnim: ValueAnimator? = null
  fun popReplyIcon() {
    swipePopAnim?.cancel()
    val a = ValueAnimator.ofFloat(0f, 0.32f, -0.06f, 0f)
    a.duration = 260
    a.addUpdateListener { swipePop = it.animatedValue as Float; invalidate() }
    swipePopAnim = a
    a.start()
  }
  private var flashAlpha = 0f
  private var flashAnim: ValueAnimator? = null
  private var spinAngle = 0f
  private var spinner: ValueAnimator? = null

  // [fase 2]
  private val nodeSlots = ArrayList<MLImageSlot>()
  /** estado vindo da lista (sobrevive à reciclagem) */
  var lifted = false
    private set
  private var liftAlpha = 1f
  private var liftAnim: ValueAnimator? = null
  private var selAnim: ValueAnimator? = null
  private var selProgress = 1f
  private var selFrom = 0f      // deslocamento horizontal inicial do conteúdo (gutter)
  private var checkScale = 1f
  private val barShown = HashMap<String, Float>()
  private var barAnim: ValueAnimator? = null
  private var barFrom = HashMap<String, Float>()
  private var barT = 1f
  private var revealAnim: ValueAnimator? = null
  // [2026-10-15 native-effects] emoji grande: anima 1× ao entrar na tela
  private var jumboPending = false
  private var jumboAnim: ValueAnimator? = null
  private var jumboScale = 1f
  private var jumboRot = 0f
  var pressedAction = -1
    set(v) { if (field != v) { field = v; invalidate() } }
  var snapshotMode = false
  /** nota de vídeo tocando nesta célula (posta pelo MLVideoNotePlayer) */
  var vnView: View? = null
    private set
  var vnProgress = -1f
    set(v) { field = v; invalidate() }
  var vnPlaying = false
    set(v) { field = v; invalidate() }
  var onRecycled: ((MLCellView) -> Unit)? = null

  // [2026-10-15 native-media-dl] anel de transferência por slot
  // (0 mídia, 1..4 álbum, 5 áudio, 6 arquivo)
  private val ringShown = FloatArray(7)
  private val ringVisible = BooleanArray(7)
  private val ringFinishAt = LongArray(7)
  private var ringAnimated = false
  var transferKeys: Set<String> = emptySet()
    private set
  private val ringText = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD) }

  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val tmpRect = RectF()
  private val tmpPath = Path()

  init { setWillNotDraw(false); clipChildren = false }

  // ─── [2026-10-16 wave13-C] acessibilidade (TalkBack) ─────────────────────
  /** Ações personalizadas (id, nome traduzido) — a lista monta e executa. */
  var a11yActs: List<Pair<String, String>> = emptyList()
  /** (célula, "activate" | "more" | id da ação) → true = tratado. */
  var onA11yAction: ((MLCellView, String) -> Boolean)? = null

  override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
    super.onInitializeAccessibilityNodeInfo(info)
    val r = row ?: return
    if ((r.kind == MLKind.DATE || r.kind == MLKind.UNREAD) && Build.VERSION.SDK_INT >= 28) info.isHeading = true
    if (r.kind != MLKind.MSG || onA11yAction == null) return
    info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_CLICK)
    if (r.sel == 0) info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_LONG_CLICK)
    for ((i, a) in a11yActs.withIndex()) info.addAction(AccessibilityNodeInfo.AccessibilityAction(A11Y_ACTION_BASE + i, a.second))
  }

  override fun performAccessibilityAction(action: Int, arguments: Bundle?): Boolean {
    val cb = onA11yAction
    if (cb != null && row?.kind == MLKind.MSG) {
      val id = when (action) {
        AccessibilityNodeInfo.ACTION_CLICK -> "activate"
        AccessibilityNodeInfo.ACTION_LONG_CLICK -> "more"
        else -> a11yActs.getOrNull(action - A11Y_ACTION_BASE)?.first
      }
      if (id != null && cb(this, id)) return true
    }
    return super.performAccessibilityAction(action, arguments)
  }

  fun bind(key: String, row: MLRow, lay: MLRowLayout, style: MLStyle, audio: MLAudioState?, liftedKey: String = "", revealed: Boolean = false) {
    val changedRow = this.key != key
    val prevRow = this.row
    val prevLay = this.lay
    this.key = key
    this.row = row
    this.lay = lay
    this.style = style
    if (this.audio !== audio) audioAt = SystemClock.uptimeMillis() // [motion-conv]
    this.audio = audio
    if (changedRow) {
      for (i in 0 until 7) { ringShown[i] = 0f; ringVisible[i] = false; ringFinishAt[i] = 0L }
      jumboAnim?.cancel(); jumboAnim = null; jumboScale = 1f; jumboRot = 0f
      jumboPending = row.kind == MLKind.MSG && row.jumbo > 0f && !row.deleted
      swipeX = 0f
      flashAnim?.cancel(); flashAlpha = 0f
      selAnim?.cancel(); selProgress = 1f; selFrom = 0f; checkScale = 1f
      barAnim?.cancel(); barShown.clear(); barT = 1f
      cancelTickAnim()
      sparkAnim?.cancel(); sparkAnim = null; sparkT = 1f
      if (vnView != null) onRecycled?.invoke(this)
    } else if (prevRow != null && prevLay != null) {
      // [motion-conv] ✓ → ✓✓ → lida na MESMA linha → transição animada
      val ps = prevRow.status
      val ns = row.status
      if (ps != null && ns != null && ns > ps && ps >= 0.0 && ns >= 1.0 && MLMotion.ticks && MLMotion.systemOn() && isAttachedToWindow) startTickAnim(ps)
      // [motion-conv] reação NOVA de outra pessoa → pop (a minha pula pelo menu nativo)
      val gi = if (MLMotion.react && isAttachedToWindow) othersReacted(prevRow.reacts, row.reacts) else -1
      if (gi >= 0) {
        val k0 = key
        post { if (this.key == k0) { popReactions(); startSparks(gi) } }
      }
      // [fase 2] entrada/saída do modo seleção animada
      if ((prevRow.sel == 0) != (row.sel == 0)) {
        val dx = prevLay.bubble.left - lay.bubble.left
        startSelAnim(dx, entering = row.sel > 0)
      } else if (prevRow.sel != row.sel && row.sel > 0) {
        animateCheck()
      }
      // barras (enquete): anima do valor mostrado ao novo
      animateBars(lay)
    }
    alpha = row.opacity
    lifted = liftedKey.isNotEmpty() && liftedKey == key
    liftAnim?.cancel()
    liftAlpha = if (lifted) 0f else 1f
    if (revealed) for (sp in lay.spoilers) sp.reveal = 1f
    // imagens dos blocos
    while (nodeSlots.size < lay.imageOps) nodeSlots.add(MLImageSlot(this))
    for (o in lay.ops) {
      if (o.slot < 0) continue
      val sl = nodeSlots[o.slot]
      val u = if (o.kind == MLOp.VNOTE) o.thumb else o.uri
      if (u.isEmpty() && o.thumb.isEmpty()) sl.clear()
      else sl.set(u, if (o.kind == MLOp.IMAGE) o.thumb else "", o.rect.width().toInt(), o.rect.height().toInt(), false, o.fit)
    }
    for (i in lay.imageOps until nodeSlots.size) nodeSlots[i].clear()
    contentDescription = row.a11yLabel.ifEmpty { listOf(row.name, row.text, row.time).filter { it.isNotEmpty() }.joinToString(", ") }
    isSelected = row.kind == MLKind.MSG && row.sel == 2
    // imagens
    val md = row.media
    if (md != null && !lay.mediaFrame.isEmpty) {
      mediaSlot.set(effectiveUri(md), md.thumb, lay.mediaFrame.width().toInt(), lay.mediaFrame.height().toInt(), md.kind == "gif" || md.kind == "sticker", md.kind == "sticker", if (md.kind == "video") md.vf else "")
    } else mediaSlot.clear()
    for (i in 0 until 4) {
      if (i < row.album.size && i < lay.albumFrames.size) {
        val f = lay.albumFrames[i]
        albumSlots[i].set(effectiveUri(row.album[i]), row.album[i].thumb, f.width().toInt(), f.height().toInt(), false, false, if (row.album[i].kind == "video") row.album[i].vf else "")
      } else albumSlots[i].clear()
    }
    val rp = row.reply
    if (rp != null && lay.replyThumb) replySlot.set(rp.thumb, "", (40 * style.density).toInt(), (40 * style.density).toInt(), false) else replySlot.clear()
    ringAnimated = !changedRow
    refreshTransferKeys()
    if (anySpin() || lay.hasLoader) startSpinner() else stopSpinner()
    requestLayout()
    invalidate()
    if (jumboPending && isAttachedToWindow) post { startJumbo() }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (jumboPending) post { startJumbo() }
  }

  private fun startJumbo() {
    if (!jumboPending || !isAttachedToWindow) return
    jumboPending = false
    val r = row ?: return
    if (!MLJumboFX.claim(key)) return
    val heart = MLJumboFX.isHeart(r.text)
    jumboAnim?.cancel()
    val a = ValueAnimator.ofFloat(0f, 1f)
    a.duration = MLJumboFX.duration(heart)
    a.interpolator = DecelerateInterpolator(1.2f)
    a.addUpdateListener { v ->
      val p = v.animatedValue as Float
      jumboScale = MLJumboFX.scale(heart, p)
      jumboRot = MLJumboFX.rotation(heart, p)
      invalidate()
    }
    jumboAnim = a
    a.start()
  }

  fun setAudio(a: MLAudioState?) { audio = a; audioAt = SystemClock.uptimeMillis(); invalidate() }
  // [motion-conv] progresso suave do áudio: instante do último pulso + último mostrado
  private var audioAt = 0L
  private var audioShown = 0f
  private var audioShownId = ""

  // ─── [motion-conv] ⏱ → ✓ → ✓✓ → lida (coreografia do AnimatedCheckStatus JS):
  // ⏱→✓ relógio some e o ✓ dá um pop (.5 → 1 com overshoot); ✓→✓✓ 2º ✓ desliza
  // da esquerda; →lida cinza→azul + pulso 1 → 1.15 → 1.
  private var tickFrom = -1.0
  private var tickT = 1f
  private var tickAnim: ValueAnimator? = null

  private fun startTickAnim(from: Double) {
    tickAnim?.cancel()
    tickFrom = from
    tickT = 0f
    val a = ValueAnimator.ofFloat(0f, 1f)
    a.duration = 420
    a.interpolator = android.view.animation.LinearInterpolator()
    a.addUpdateListener { tickT = it.animatedValue as Float; invalidate() }
    a.addListener(object : android.animation.AnimatorListenerAdapter() {
      override fun onAnimationEnd(animation: android.animation.Animator) { if (tickAnim === animation) { tickAnim = null; tickT = 1f; tickFrom = -1.0; invalidate() } }
    })
    tickAnim = a
    a.start()
  }

  private fun cancelTickAnim() {
    val a = tickAnim
    tickAnim = null
    a?.cancel()
    tickT = 1f
    tickFrom = -1.0
  }

  private fun backOut(t: Float): Float {
    val c1 = 1.70158f
    val c3 = c1 + 1f
    val u = t - 1f
    return 1f + c3 * u * u * u + c1 * u * u
  }

  private fun cubicOut(t: Float): Float { val u = 1f - t; return 1f - u * u * u }

  private fun mixColor(a: Int, b: Int, t: Float): Int {
    fun ch(sh: Int): Int { val x = (a ushr sh) and 0xFF; val y = (b ushr sh) and 0xFF; return (x + ((y - x) * t)).toInt().coerceIn(0, 255) }
    return (ch(24) shl 24) or (ch(16) shl 16) or (ch(8) shl 8) or ch(0)
  }

  /** [motion-conv] alguém (não eu) reagiu: emoji novo/contagem maior e as MINHAS
   *  iguais → índice do chip que cresceu (-1 = não). */
  private fun othersReacted(a: List<MLReact>, b: List<MLReact>): Int {
    if (b.isEmpty()) return -1
    val oldCount = HashMap<String, Int>()
    val oldMine = HashSet<String>()
    for (r in a) { oldCount[r.emoji] = r.count; if (r.mine) oldMine.add(r.emoji) }
    val newMine = HashSet<String>()
    var grew = -1
    for ((i, r) in b.withIndex()) { if (r.mine) newMine.add(r.emoji); if (grew < 0 && r.count > (oldCount[r.emoji] ?: 0)) grew = i }
    return if (oldMine == newMine) grew else -1
  }

  private var sparkChip = -1
  private var sparkT = 1f
  private var sparkAnim: ValueAnimator? = null
  private fun startSparks(i: Int) {
    if (!MLMotion.systemOn()) return
    sparkAnim?.cancel()
    sparkChip = i
    sparkT = 0f
    val a = ValueAnimator.ofFloat(0f, 1f)
    a.duration = 380
    a.interpolator = android.view.animation.LinearInterpolator()
    a.addUpdateListener { sparkT = it.animatedValue as Float; invalidate() }
    a.addListener(object : android.animation.AnimatorListenerAdapter() {
      override fun onAnimationEnd(animation: android.animation.Animator) { if (sparkAnim === animation) { sparkAnim = null; sparkT = 1f; invalidate() } }
    })
    sparkAnim = a
    a.start()
  }

  fun recycle() {
    if (vnView != null) onRecycled?.invoke(this)
    mediaSlot.clear(); replySlot.clear(); albumSlots.forEach { it.clear() }
    nodeSlots.forEach { it.clear() }
    selAnim?.cancel(); barAnim?.cancel(); revealAnim?.cancel(); liftAnim?.cancel()
    reactPop.cancel(); reactPopScale = 1f
    pressedAction = -1
    stopSpinner()
    transferKeys = emptySet()
    for (i in 0 until 7) { ringShown[i] = 0f; ringVisible[i] = false; ringFinishAt[i] = 0L }
    flashAnim?.cancel(); flashAlpha = 0f
    jumboAnim?.cancel(); jumboAnim = null; jumboScale = 1f; jumboRot = 0f; jumboPending = false
    cancelTickAnim()
    sparkAnim?.cancel(); sparkAnim = null; sparkT = 1f
    swipeX = 0f
  }

  fun flash() {
    flashAnim?.cancel()
    // [fase 2] pulsa 2× (pular para mensagem)
    val a = ValueAnimator.ofFloat(0f, 1f, 1f, 0.15f, 1f, 1f, 0f)
    a.duration = 1700
    a.addUpdateListener { flashAlpha = it.animatedValue as Float; invalidate() }
    flashAnim = a
    a.start()
  }

  private fun startSpinner() {
    if (spinner != null) return
    val a = ValueAnimator.ofFloat(0f, 360f)
    a.duration = 900
    a.repeatCount = ValueAnimator.INFINITE
    a.addUpdateListener { spinAngle = it.animatedValue as Float; invalidate() }
    spinner = a
    a.start()
  }

  private fun stopSpinner() { spinner?.cancel(); spinner = null }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    val h = (lay?.height ?: 1f).toInt().coerceAtLeast(1)
    setMeasuredDimension(w, h)
    vnView?.let { v ->
      val r = vnRect()
      v.measure(MeasureSpec.makeMeasureSpec(r.width().toInt().coerceAtLeast(1), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(r.height().toInt().coerceAtLeast(1), MeasureSpec.EXACTLY))
    }
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    vnView?.let { v ->
      val rr = vnRect()
      v.layout(rr.left.toInt(), rr.top.toInt(), rr.left.toInt() + v.measuredWidth, rr.top.toInt() + v.measuredHeight)
      v.translationX = swipeX
    }
  }

  /** retângulo (coordenadas da célula) da nota de vídeo. */
  fun vnRect(): RectF {
    val L = lay ?: return RectF()
    val o = L.vnote ?: return RectF()
    return RectF(o.rect).apply { offset(L.bubble.left, L.bubble.top) }
  }

  fun attachVideo(v: View) {
    detachVideo()
    vnView = v
    addView(v)
    requestLayout()
  }

  fun detachVideo() {
    val v = vnView ?: return
    vnView = null
    try { removeView(v) } catch (_: Throwable) {}
    vnPlaying = false
    vnProgress = -1f
  }

  override fun verifyDrawable(who: Drawable): Boolean {
    return super.verifyDrawable(who) || who === mediaSlot.drawable || nodeSlots.any { it.drawable === who }
  }

  // ─── [fase 2] animações ─────────────────────────────────────────────────
  private fun startSelAnim(dx: Float, entering: Boolean) {
    selAnim?.cancel()
    selFrom = dx
    selProgress = 0f
    val a = ValueAnimator.ofFloat(0f, 1f)
    a.duration = 220
    a.interpolator = DecelerateInterpolator(1.4f)
    a.addUpdateListener { selProgress = it.animatedValue as Float; invalidate() }
    selAnim = a
    a.start()
  }

  private fun animateCheck() {
    val a = ValueAnimator.ofFloat(0.8f, 1f)
    a.duration = 180
    a.addUpdateListener { checkScale = it.animatedValue as Float; invalidate() }
    a.start()
  }

  private fun animateBars(L: MLRowLayout) {
    var any = false
    val from = HashMap<String, Float>()
    for (o in L.ops) if (o.kind == MLOp.BAR && o.id.isNotEmpty()) {
      val prev = barShown[o.id]
      if (prev != null && kotlin.math.abs(prev - o.value) > 0.001f) { from[o.id] = prev; any = true }
    }
    if (!any) return
    barAnim?.cancel()
    barFrom = from
    barT = 0f
    val a = ValueAnimator.ofFloat(0f, 1f)
    a.duration = 250
    a.addUpdateListener { barT = it.animatedValue as Float; invalidate() }
    barAnim = a
    a.start()
  }

  fun setLifted(on: Boolean) {
    if (lifted == on) return
    lifted = on
    liftAnim?.cancel()
    if (on) { liftAlpha = 0f; invalidate(); return }
    val a = ValueAnimator.ofFloat(liftAlpha, 1f)
    a.duration = 150
    a.addUpdateListener { liftAlpha = it.animatedValue as Float; invalidate() }
    liftAnim = a
    a.start()
  }

  /** Revela os spoilers da linha (fade 0.2s). */
  fun revealSpoilers() {
    val L = lay ?: return
    if (L.spoilers.isEmpty()) return
    revealAnim?.cancel()
    val a = ValueAnimator.ofFloat(0f, 1f)
    a.duration = 200
    a.addUpdateListener { v -> val f = v.animatedValue as Float; for (sp in L.spoilers) sp.reveal = max(sp.reveal, f); invalidate() }
    revealAnim = a
    a.start()
  }

  // [native-ctxmenu] pop do chip de reação novo
  private var reactPopScale = 1f
  private val reactPop = MLReactPop { v -> reactPopScale = v; invalidate() }
  fun popReactions() { if (lay?.chips?.isNotEmpty() == true) reactPop.start() }

  /** [hero] Miniatura `i` (foto/vídeo/tile do álbum) nas coords da célula + raio (px). */
  fun mediaRectInCell(i: Int): Pair<RectF, Float>? {
    val L = lay ?: return null
    val r = row ?: return null
    if (r.kind != MLKind.MSG) return null
    val s = style ?: return null
    val f: RectF
    val rad: Float
    if (L.albumFrames.isNotEmpty()) {
      f = RectF(L.albumFrames[i.coerceIn(0, L.albumFrames.size - 1)]); rad = s.dp(4f)
    } else if (!L.mediaFrame.isEmpty) {
      f = RectF(L.mediaFrame); rad = L.mediaRadius
    } else return null
    f.offset(L.bubble.left + swipeX, L.bubble.top)
    if (f.width() <= 1f || f.height() <= 1f) return null
    return Pair(f, rad)
  }

  /** [native-ctxmenu] Retângulo do balão (mesmo do snapshot) nas coords da célula. */
  fun bubbleRectInCell(): RectF? {
    val L = lay ?: return null
    val r = row ?: return null
    if (r.kind != MLKind.MSG) return null
    val s = style ?: return null
    val rect = RectF(L.bubble)
    if (L.showBubble && r.first) { if (r.own) rect.right += s.dp(6f) else rect.left -= s.dp(6f) }
    rect.offset(swipeX, 0f)
    rect.intersect(0f, 0f, width.toFloat(), height.toFloat())
    return rect
  }

  /** Snapshot PNG-ready do balão (sem seleção/reações/realce). */
  fun snapshotBubble(): Pair<Bitmap, RectF>? {
    val L = lay ?: return null
    val r = row ?: return null
    if (r.kind != MLKind.MSG) return null
    val s = style ?: return null
    val rect = RectF(L.bubble)
    if (L.showBubble && r.first) { if (r.own) rect.right += s.dp(6f) else rect.left -= s.dp(6f) }
    rect.offset(swipeX, 0f)
    rect.intersect(0f, 0f, width.toFloat(), height.toFloat())
    val w = rect.width().toInt(); val h = rect.height().toInt()
    if (w <= 0 || h <= 0) return null
    return try {
      val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
      val c = Canvas(bmp)
      c.translate(-rect.left, -rect.top)
      val oldLift = liftAlpha
      liftAlpha = 1f
      snapshotMode = true
      try { onDraw(c) } finally { snapshotMode = false; liftAlpha = oldLift }
      Pair(bmp, rect)
    } catch (_: Throwable) { null }
  }

  // ─── hit test ────────────────────────────────────────────────────────────
  sealed class Part {
    object Bubble : Part()
    data class Media(val index: Int) : Part()
    object Reply : Part()
    data class Link(val url: String) : Part()
    object Audio : Part()
    object File : Part()
    data class Reaction(val index: Int) : Part()
    data class Action(val action: String, val index: Int) : Part()
    object Retry : Part()
    object VNote : Part()
    /** [native-media-dl] anel/botão de baixar: -1 mídia, 0..3 álbum, 100 áudio, 101 arquivo */
    data class Xfer(val slot: Int) : Part()
    object Spoiler : Part()
    object None : Part()
  }

  /** índice da ação (bloco com `a`) sob o ponto, -1 se nenhuma. */
  fun actionIndexAt(px: Float, py: Float): Int {
    val L = lay ?: return -1
    val bx = px - swipeX - L.bubble.left
    val by = py - L.bubble.top
    for (i in L.actions.indices.reversed()) if (L.actions[i].rect.contains(bx, by)) return i
    return -1
  }

  fun partAt(px: Float, py: Float): Part {
    val L = lay ?: return Part.None
    val r = row ?: return Part.None
    if (r.kind != MLKind.MSG) return Part.Bubble
    val x = px - swipeX
    val s = style ?: return Part.None
    val slop = s.dp(4f)
    if (L.chips.isNotEmpty() && x >= L.reactsFrame.left - slop && x <= L.reactsFrame.right + slop && py >= L.reactsFrame.top - slop && py <= L.reactsFrame.bottom + slop) {
      val lx = x - L.reactsFrame.left
      for ((i, c) in L.chips.withIndex()) if (lx >= c.first.left - 2 && lx <= c.first.right + 2) return Part.Reaction(i)
      return Part.Reaction(0)
    }
    if (!L.failFrame.isEmpty) {
      tmpRect.set(L.failFrame); tmpRect.inset(-slop * 2, -slop * 2)
      if (tmpRect.contains(x, py)) return Part.Retry
    }
    val bx = x - L.bubble.left
    val by = py - L.bubble.top
    // spoiler escondido (texto principal ou de bloco) → revela localmente
    L.text?.let { t -> if (!L.textFrame.isEmpty && t.spoilerAt(bx - L.textFrame.left, by - L.textFrame.top)) return Part.Spoiler }
    for (o in L.ops) {
      if (o.kind != MLOp.TEXT) continue
      val t = o.text ?: continue
      if (o.rect.contains(bx, by) && t.spoilerAt(bx - o.rect.left, by - o.rect.top)) return Part.Spoiler
    }
    L.vnote?.let { if (it.rect.contains(bx, by)) return Part.VNote }
    // links dentro de textos de blocos
    for (o in L.ops) {
      if (o.kind != MLOp.TEXT) continue
      val t = o.text ?: continue
      if (!o.rect.contains(bx, by)) continue
      val u = t.linkAt(bx - o.rect.left, by - o.rect.top)
      if (u != null) return Part.Link(u)
    }
    for (i in L.actions.indices.reversed()) if (L.actions[i].rect.contains(bx, by)) return Part.Action(L.actions[i].action, i)
    xferHit(bx, by, L, r, s)?.let { return Part.Xfer(it) }
    for ((i, f) in L.albumFrames.withIndex()) if (f.contains(bx, by)) return Part.Media(i)
    if (!L.mediaFrame.isEmpty && L.mediaFrame.contains(bx, by)) return Part.Media(0)
    if (!L.replyFrame.isEmpty && L.replyFrame.contains(bx, by)) return Part.Reply
    ratePillRect(L, r, s)?.let { pr ->
      if (bx >= pr.left - slop * 2 && bx <= pr.right + slop * 2 && by >= pr.top - slop * 2 && by <= pr.bottom + slop * 2) return Part.Action("au:rate", -1)
    }
    if (!L.audioFrame.isEmpty && bx >= L.audioFrame.left - slop && bx <= L.audioFrame.right + slop && by >= L.audioFrame.top - slop && by <= L.audioFrame.bottom + slop) return Part.Audio
    if (!L.fileFrame.isEmpty && L.fileFrame.contains(bx, by)) return Part.File
    val t = L.text
    if (t != null && !L.textFrame.isEmpty) {
      val u = t.linkAt(bx - L.textFrame.left, by - L.textFrame.top)
      if (u != null) return Part.Link(u)
    }
    if (x >= L.bubble.left - slop && x <= L.bubble.right + slop && py >= L.bubble.top - slop && py <= L.bubble.bottom + slop) return Part.Bubble
    return Part.None
  }

  // ─── desenho ─────────────────────────────────────────────────────────────
  override fun onDraw(c: Canvas) {
    super.onDraw(c)
    val L = lay ?: return
    val r = row ?: return
    val s = style ?: return
    val th = s.theme
    MLEmojiCache.drawingView = this
    try { drawAll(c, L, r, s, th) } finally { MLEmojiCache.drawingView = null }
  }

  private fun drawAll(c: Canvas, L: MLRowLayout, r: MLRow, s: MLStyle, th: MLTheme) {
    val snap = snapshotMode
    // seleção / destaque
    if (!snap && r.sel == 2) { fill.color = th.selection; c.drawRect(0f, 0f, width.toFloat(), height.toFloat(), fill) }
    if (!snap && flashAlpha > 0f) {
      fill.color = th.highlight
      fill.alpha = (((th.highlight ushr 24) and 0xFF) * flashAlpha).toInt()
      c.drawRect(0f, 0f, width.toFloat(), height.toFloat(), fill)
      fill.alpha = 255
    }
    if (r.kind != MLKind.MSG) {
      if (r.kind == MLKind.UNREAD) {
        fill.color = th.unreadBg
        c.drawRect(L.pillFrame, fill)
      } else if (r.text.isNotEmpty()) {
        fill.color = th.pillBg
        val rad = min(s.dp(8f), L.pillFrame.height() / 2) // [2026-10-17 wa-pills]
        c.drawRoundRect(L.pillFrame, rad, rad, fill)
      }
      drawText(c, L.pillText, L.pillTextFrame.left, L.pillTextFrame.top)
      return
    }
    if (!snap && r.sel > 0) {
      val p = if (selAnim != null && selAnim!!.isRunning) selProgress else 1f
      c.save()
      val sc = (0.6f + 0.4f * p) * (if (r.sel == 2) checkScale else 1f)
      c.scale(sc, sc, L.selCircle.centerX(), L.selCircle.centerY())
      if (p < 1f) c.saveLayerAlpha(L.selCircle.left - 2, L.selCircle.top - 2, L.selCircle.right + 2, L.selCircle.bottom + 2, (255 * p).toInt())
      drawSelect(c, L.selCircle, r.sel == 2, th)
      if (p < 1f) c.restore()
      c.restore()
    }
    // ícone de responder (arrastar)
    if (!snap && abs(swipeX) > 1f) {
      val a = min(1f, abs(swipeX) / s.dp(64f))
      val cx = if (swipeX > 0) L.bubble.left + min(swipeX, s.dp(64f)) / 2 - s.dp(4f) else L.bubble.right + max(swipeX, -s.dp(64f)) / 2 + s.dp(4f)
      val cy = L.bubble.centerY()
      val rad = s.dp(15f) * (0.6f + 0.4f * a + swipePop)
      fill.color = th.pillBg; fill.alpha = (((th.pillBg ushr 24) and 0xFF) * a).toInt().coerceAtLeast(0)
      c.drawCircle(cx, cy, rad, fill)
      fill.alpha = 255
      drawReplyArrow(c, cx, cy, rad * 0.9f, th.pillText, a)
    }
    if (liftAlpha <= 0.01f) return
    val selDx = if (selAnim != null && selAnim!!.isRunning) selFrom * (1f - selProgress) else 0f
    c.save()
    c.translate(swipeX + selDx, 0f)
    if (liftAlpha < 1f) c.saveLayerAlpha(0f, 0f, width.toFloat(), height.toFloat(), (255 * liftAlpha).toInt())
    // falhou: ícone vermelho ao lado + balão a 50%
    if (!snap && !L.failFrame.isEmpty) drawFail(c, L.failFrame, s)
    if (r.failed) c.saveLayerAlpha(0f, 0f, width.toFloat(), height.toFloat(), 128)
    if (L.showBubble) {
      L.bubblePath?.let { fill.color = if (r.own) th.ownBubble else (r.bubbleBg ?: th.otherBubble); c.drawPath(it, fill) }
    }
    c.save()
    c.translate(L.bubble.left, L.bubble.top)
    L.name?.let { drawText(c, it, L.nameFrame.left, L.nameFrame.top) }
    L.fwd?.let {
      drawText(c, it, L.fwdFrame.left, L.fwdFrame.top)
      drawFwdArrows(c, L.fwdFrame.left - MLLayoutBuilder.fwdIconW(r, s), L.fwdFrame.centerY(), s.dp(12f), if (r.own) th.ownMeta else th.otherMeta, r.forwardedMany) // [2026-10-17 fwd-label]
    }
    if (L.replyName != null) drawReply(c, L, r, s)
    // mídia
    val md = r.media
    if (md != null && !L.mediaFrame.isEmpty) {
      val sticker = md.kind == "sticker"
      val ok = mediaSlot.draw(c, L.mediaFrame, L.mediaRadius, sticker)
      if (!ok && !sticker) {
        fill.color = if (r.own) th.ownQuote else th.otherQuote
        c.drawRoundRect(L.mediaFrame, L.mediaRadius, L.mediaRadius, fill)
      }
      val (mode, done) = if (sticker) Pair(RingMode.Hidden, true) else xferMode(md.dl, md.up, true)
      if (!done && md.dl != null && !sticker) {
        // ainda não baixada: miniatura levemente escurecida (P&B premium)
        fill.color = 0x2E000000
        c.drawRoundRect(L.mediaFrame, L.mediaRadius, L.mediaRadius, fill)
      }
      if (md.kind == "video" && md.up == null && done && !snap) {
        val cx = L.mediaFrame.centerX(); val cy = L.mediaFrame.centerY(); val rad = s.dp(23f)
        fill.color = 0x73000000; c.drawCircle(cx, cy, rad, fill)
        drawPlay(c, RectF(cx - rad * 0.6f, cy - rad * 0.6f, cx + rad * 0.6f, cy + rad * 0.6f), 0xFFFFFFFF.toInt())
      }
      L.durText?.let { drawText(c, it, L.mediaFrame.left + s.dp(8f), L.mediaFrame.bottom - it.height - s.dp(7f)) }
      if (!snap) drawRing(c, 0, mode, done, L.mediaFrame.centerX(), L.mediaFrame.centerY(), true, 0xFFFFFFFF.toInt(), s)
    }
    if (L.albumFrames.isNotEmpty()) {
      for ((i, f) in L.albumFrames.withIndex()) {
        if (i >= 4) break
        if (!albumSlots[i].draw(c, f, s.dp(4f), false)) {
          fill.color = if (r.own) th.ownQuote else th.otherQuote
          c.drawRoundRect(f, s.dp(4f), s.dp(4f), fill)
        }
        if (!snap && i < r.album.size) {
          val am = r.album[i]
          val (mode, done) = xferMode(am.dl, am.up, false)
          drawRing(c, 1 + i, mode, done, f.centerX(), f.centerY(), true, 0xFFFFFFFF.toInt(), s)
        }
      }
      val last = L.albumFrames.last()
      L.moreText?.let {
        fill.color = 0x73000000
        c.drawRoundRect(last, s.dp(4f), s.dp(4f), fill)
        drawText(c, it, last.centerX() - it.width / 2, last.centerY() - it.height / 2)
      }
    }
    // texto
    L.text?.let { t ->
      val jfx = !snap && (jumboScale != 1f || jumboRot != 0f)
      if (jfx) {
        // pivô a 30% da altura: cresce mais p/ baixo (sobre a hora) do que p/ cima (célula recorta)
        val px = L.textFrame.centerX(); val py = L.textFrame.top + L.textFrame.height() * 0.3f
        c.save(); c.scale(jumboScale, jumboScale, px, py); if (jumboRot != 0f) c.rotate(jumboRot, px, py)
      }
      if (L.deletedIcon) drawDeleted(c, L.textFrame.left - s.dp(19f), L.textFrame.top + (s.lineHeightPx - s.dp(15f)) / 2, s.dp(15f), if (r.own) th.ownMeta else th.otherMeta)
      drawText(c, t, L.textFrame.left, L.textFrame.top)
      if (t.spoilers.isNotEmpty()) { c.save(); c.translate(L.textFrame.left, L.textFrame.top); MLSpoilerDraw.draw(c, t, t.particleColor, s.density); c.restore() }
      if (jfx) c.restore()
    }
    if (r.audio != null && !L.audioFrame.isEmpty) drawAudio(c, L, r, s)
    if (r.file != null && !L.fileFrame.isEmpty) drawFile(c, L, r, s)
    if (L.ops.isNotEmpty()) drawOps(c, L, s)
    if (!L.noMeta) L.meta?.let { if (!L.metaFrame.isEmpty) drawMeta(c, it, L.metaFrame, s) }
    c.restore()
    if (r.failed) c.restore()
    // reações (coordenadas da linha)
    if (!snap && L.chips.isNotEmpty()) {
      val popOn = reactPopScale != 1f
      if (popOn) { c.save(); c.scale(reactPopScale, reactPopScale, L.reactsFrame.centerX(), L.reactsFrame.centerY()) }
      for ((i, ch) in L.chips.withIndex()) {
        tmpRect.set(L.reactsFrame.left + ch.first.left, L.reactsFrame.top, L.reactsFrame.left + ch.first.right, L.reactsFrame.bottom)
        val rad = tmpRect.height() / 2
        fill.color = if (i < r.reacts.size && r.reacts[i].mine) th.selection or (0xE6 shl 24) else th.reactBg
        c.drawRoundRect(tmpRect, rad, rad, fill)
        stroke.color = th.reactBorder; stroke.strokeWidth = s.dp(1.5f)
        c.drawRoundRect(tmpRect, rad, rad, stroke)
        drawText(c, ch.second, tmpRect.centerX() - ch.second.width / 2, tmpRect.centerY() - ch.second.height / 2)
      }
      if (popOn) c.restore()
      // [motion-conv] faíscas da reação nova (= ReactionSparks JS)
      val si = sparkChip
      if (sparkT < 1f && si >= 0 && si < L.chips.size) {
        val ch = L.chips[si].first
        val cx = L.reactsFrame.left + ch.centerX()
        val cy = L.reactsFrame.centerY()
        val p = sparkT
        val e = 1f - (1f - p) * (1f - p) // quad out
        val op = if (p < 0.15f) p / 0.15f * 0.9f else 0.9f * (1f - (p - 0.15f) / 0.85f)
        val sc = if (p < 0.3f) 0.6f + 0.4f * (p / 0.3f) else 1f - 0.8f * ((p - 0.3f) / 0.7f)
        fill.color = withAlpha(0xBF808080.toInt(), max(0f, op))
        val rr = s.dp(2f) * sc
        for (k in 0 until 6) {
          val ang = (Math.PI * 2 * k / 6 - Math.PI / 2 + 0.3).toFloat()
          c.drawCircle(cx + cos(ang) * s.dp(18f) * e, cy + sin(ang) * s.dp(18f) * e, rr, fill)
        }
      }
    }
    if (liftAlpha < 1f) c.restore()
    c.restore()
  }

  override fun dispatchDraw(c: Canvas) {
    super.dispatchDraw(c)
    // anel de progresso da nota de vídeo por cima do TextureView
    val L = lay ?: return
    val s = style ?: return
    val o = L.vnote ?: return
    if (vnProgress < 0f || snapshotMode) return
    val rr = vnRect(); rr.offset(swipeX, 0f)
    val sw = s.dp(3f)
    rr.inset(sw / 2, sw / 2)
    stroke.strokeWidth = sw
    stroke.color = (o.color and 0x00FFFFFF) or (0x40 shl 24)
    c.drawOval(rr, stroke)
    stroke.color = o.color
    c.drawArc(rr, -90f, 360f * vnProgress.coerceIn(0f, 1f), false, stroke)
  }

  private fun withAlpha(color: Int, a: Float): Int {
    if (a >= 1f) return color
    val ca = (color ushr 24) and 0xFF
    return (color and 0x00FFFFFF) or (((ca * a).toInt().coerceIn(0, 255)) shl 24)
  }

  private fun opRadius(o: MLOp): Float = if (o.radius < 0f) min(o.rect.width(), o.rect.height()) / 2 else o.radius

  private fun drawOps(c: Canvas, L: MLRowLayout, s: MLStyle) {
    var depth = 0
    for (o in L.ops) {
      when (o.kind) {
        MLOp.CLIP_PUSH -> {
          c.save(); depth++
          tmpPath.reset()
          val rr = opRadius(o)
          tmpPath.addRoundRect(o.rect, rr, rr, Path.Direction.CW)
          c.clipPath(tmpPath)
        }
        MLOp.CLIP_POP -> if (depth > 0) { c.restore(); depth-- }
        MLOp.RECT -> {
          val rr = opRadius(o)
          if (o.color != 0) {
            fill.color = withAlpha(o.color, o.alpha)
            if (rr > 0f) c.drawRoundRect(o.rect, rr, rr, fill) else c.drawRect(o.rect, fill)
          }
          if (o.strokeW > 0f && o.color2 != 0) {
            stroke.color = withAlpha(o.color2, o.alpha); stroke.strokeWidth = o.strokeW
            tmpRect.set(o.rect); tmpRect.inset(o.strokeW / 2, o.strokeW / 2)
            if (rr > 0f) c.drawRoundRect(tmpRect, max(0f, rr - o.strokeW / 2), max(0f, rr - o.strokeW / 2), stroke) else c.drawRect(tmpRect, stroke)
          }
        }
        MLOp.TEXT -> o.text?.let { t ->
          if (o.alpha < 1f) c.saveLayerAlpha(o.rect.left, o.rect.top, o.rect.right + t.layout.width, o.rect.bottom, (255 * o.alpha).toInt())
          drawText(c, t, o.rect.left, o.rect.top)
          if (t.spoilers.isNotEmpty()) { c.save(); c.translate(o.rect.left, o.rect.top); MLSpoilerDraw.draw(c, t, t.particleColor, s.density); c.restore() }
          if (o.alpha < 1f) c.restore()
        }
        MLOp.ICON -> o.icon?.let { n -> drawIcon(c, n, o.rect, o.alpha) }
        MLOp.BAR -> {
          val rr = min(o.radius, o.rect.height() / 2)
          fill.color = withAlpha(o.color2, o.alpha)
          c.drawRoundRect(o.rect, rr, rr, fill)
          var v = o.value
          if (o.id.isNotEmpty()) {
            val from = barFrom[o.id]
            if (from != null && barT < 1f) v = from + (o.value - from) * barT
            barShown[o.id] = if (barT >= 1f) o.value else v
          }
          if (v > 0f) {
            tmpRect.set(o.rect.left, o.rect.top, o.rect.left + max(o.rect.height(), o.rect.width() * v.coerceIn(0f, 1f)), o.rect.bottom)
            if (tmpRect.right > o.rect.right) tmpRect.right = o.rect.right
            fill.color = withAlpha(o.color, o.alpha)
            c.drawRoundRect(tmpRect, rr, rr, fill)
          }
        }
        MLOp.IMAGE -> {
          val rr = opRadius(o)
          val sl = nodeSlots.getOrNull(o.slot)
          val ok = sl?.draw(c, o.rect, rr, o.fit) ?: false
          if (!ok) {
            fill.color = if (o.color != 0) withAlpha(o.color, o.alpha) else (if (row?.own == true) s.theme.ownQuote else s.theme.otherQuote)
            if (rr > 0f) c.drawRoundRect(o.rect, rr, rr, fill) else c.drawRect(o.rect, fill)
          }
        }
        MLOp.AVATAR -> {
          val rr = o.rect.width() / 2
          val sl = nodeSlots.getOrNull(o.slot)
          val ok = o.uri.isNotEmpty() && (sl?.draw(c, o.rect, rr, false) ?: false)
          if (!ok) {
            if (o.color2 != 0) {
              fill.shader = LinearGradient(o.rect.left, o.rect.top, o.rect.right, o.rect.bottom, o.color, o.color2, Shader.TileMode.CLAMP)
              c.drawOval(o.rect, fill)
              fill.shader = null
            } else {
              fill.color = withAlpha(o.color, o.alpha)
              c.drawOval(o.rect, fill)
            }
            o.text?.let { t -> drawText(c, t, o.rect.centerX() - t.width / 2, o.rect.centerY() - t.height / 2) }
          }
        }
        MLOp.LOADER -> {
          stroke.color = withAlpha(o.color, o.alpha); stroke.strokeWidth = max(s.dp(2f), o.rect.width() * 0.1f)
          tmpRect.set(o.rect); tmpRect.inset(stroke.strokeWidth, stroke.strokeWidth)
          c.drawArc(tmpRect, spinAngle, 270f, false, stroke)
        }
        MLOp.VNOTE -> {
          val sl = nodeSlots.getOrNull(o.slot)
          val ok = sl?.draw(c, o.rect, o.rect.width() / 2, false) ?: false
          if (!ok) { fill.color = o.color2; c.drawOval(o.rect, fill) }
          if (!vnPlaying) {
            val cx = o.rect.centerX(); val cy = o.rect.centerY(); val rad = s.dp(23f)
            fill.color = 0x73000000; c.drawCircle(cx, cy, rad, fill)
            drawPlay(c, RectF(cx - rad * 0.6f, cy - rad * 0.6f, cx + rad * 0.6f, cy + rad * 0.6f), 0xFFFFFFFF.toInt())
          }
        }
      }
    }
    while (depth > 0) { c.restore(); depth-- }
    // realce do toque numa ação
    val pa = pressedAction
    if (pa >= 0 && pa < L.actions.size && !snapshotMode) {
      val ac = L.actions[pa]
      fill.color = 0x14000000
      val rr = if (ac.radius < 0f) min(ac.rect.width(), ac.rect.height()) / 2 else ac.radius
      if (rr > 0f) c.drawRoundRect(ac.rect, rr, rr, fill) else c.drawRect(ac.rect, fill)
    }
  }

  private val iconFill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val iconStroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND; strokeMiter = 10f
  }

  private fun drawIcon(c: Canvas, n: MLNode, r: RectF, alpha: Float) {
    if (n.paths.isEmpty()) return
    c.save()
    c.translate(r.left, r.top)
    val sc = r.width() / n.vb
    c.scale(sc, sc)
    for (p in n.paths) {
      val a = alpha * p.opacity
      if (p.fill != 0) { iconFill.color = withAlpha(p.fill, a); c.drawPath(p.path, iconFill) }
      if (p.stroke != 0 && p.width > 0f) { iconStroke.color = withAlpha(p.stroke, a); iconStroke.strokeWidth = p.width; c.drawPath(p.path, iconStroke) }
    }
    c.restore()
  }

  private fun drawFail(c: Canvas, f: RectF, s: MLStyle) {
    fill.color = s.theme.failed
    c.drawOval(f, fill)
    fill.color = 0xFFFFFFFF.toInt()
    val cx = f.centerX(); val cy = f.centerY(); val u = f.width() / 22f
    c.drawRoundRect(cx - 1.2f * u, cy - 6.5f * u, cx + 1.2f * u, cy + 2f * u, 1.2f * u, 1.2f * u, fill)
    c.drawCircle(cx, cy + 5f * u, 1.4f * u, fill)
  }

  private fun drawText(c: Canvas, t: MLText?, x: Float, y: Float) {
    if (t == null) return
    c.save()
    c.translate(x, y)
    t.layout.draw(c)
    c.restore()
  }

  private fun drawReply(c: Canvas, L: MLRowLayout, r: MLRow, s: MLStyle) {
    val f = L.replyFrame
    val rad = s.dp(8f)
    c.save()
    tmpPath.reset()
    tmpPath.addRoundRect(f, rad, rad, Path.Direction.CW)
    c.clipPath(tmpPath)
    fill.color = if (r.own) s.theme.ownQuote else s.theme.otherQuote
    c.drawRect(f, fill)
    fill.color = r.reply?.color ?: 0xFF888888.toInt()
    c.drawRect(f.left, f.top, f.left + s.dp(3f), f.bottom, fill)
    val tx = f.left + s.dp(11f)
    L.replyName?.let { drawText(c, it, tx, f.top + s.dp(6f)) }
    L.replyText?.let { drawText(c, it, tx, f.top + s.dp(6f) + (L.replyName?.height ?: s.dp(17f)) + s.dp(1f)) }
    if (L.replyThumb) {
      tmpRect.set(f.right - s.dp(44f), f.top + s.dp(4f), f.right - s.dp(4f), f.bottom - s.dp(4f))
      replySlot.draw(c, tmpRect, s.dp(4f), false)
    }
    c.restore()
  }

  private fun drawMeta(c: Canvas, m: MLMeta, f: RectF, s: MLStyle) {
    var x = f.left
    val h = f.height()
    if (m.onMedia) {
      fill.color = 0x6B000000
      c.drawRoundRect(f, h / 2, h / 2, fill)
      x += s.dp(6f)
    }
    val cy = f.top + h / 2
    if (m.pinned) { drawSmallIcon(c, PIN_PATHS, x, cy, s.dp(11f), m.color); x += s.dp(13f) }
    if (m.timer) { drawSmallIcon(c, TIMER_PATHS, x, cy, s.dp(11f), m.color); x += s.dp(13f) }
    m.text?.let { drawText(c, it, x, f.top + (h - it.height) / 2); x += it.width }
    if (m.star) { x += s.dp(3f); drawStar(c, x + s.dp(5f), cy, s.dp(4.6f), m.color); x += s.dp(10f) }
    val st = m.status ?: return
    x += s.dp(3f)
    val tickColor = if (st >= 2) s.theme.read else m.color
    // [motion-conv] transição em curso (só ✓ em diante)
    if (tickFrom >= 0.0 && tickT < 1f && st >= 1.0) { drawTicksAnimated(c, x, cy, st, tickFrom, tickT, m, s); return }
    when {
      st < 0 -> {
        fill.color = s.theme.failed; c.drawCircle(x + s.dp(6f), cy, s.dp(6f), fill)
        fill.color = 0xFFFFFFFF.toInt()
        c.drawRect(x + s.dp(5.2f), cy - s.dp(3.6f), x + s.dp(6.8f), cy + s.dp(0.8f), fill)
        c.drawCircle(x + s.dp(6f), cy + s.dp(2.7f), s.dp(0.9f), fill)
      }
      st == 0.0 -> {
        stroke.color = m.color; stroke.strokeWidth = s.dp(1.2f)
        c.drawCircle(x + s.dp(6f), cy, s.dp(5f), stroke)
        c.drawLine(x + s.dp(6f), cy, x + s.dp(6f), cy - s.dp(3.2f), stroke)
        c.drawLine(x + s.dp(6f), cy, x + s.dp(8.4f), cy + s.dp(1f), stroke)
      }
      st >= 1.5 -> { drawCheck(c, x, cy - s.dp(5f), tickColor, s); drawCheck(c, x + s.dp(4.5f), cy - s.dp(5f), tickColor, s) }
      else -> drawCheck(c, x + s.dp(1f), cy - s.dp(5f), tickColor, s)
    }
  }

  private fun drawTicksAnimated(c: Canvas, x: Float, cy: Float, st: Double, from: Double, t: Float, m: MLMeta, s: MLStyle) {
    val toRead = st >= 2 && from < 2
    val color = if (toRead) mixColor(m.color, s.theme.read, cubicOut(min(1f, t * 1.6f))) else if (st >= 2) s.theme.read else m.color
    val gx = x + s.dp(if (st >= 1.5) 8.5f else 6.5f)
    c.save()
    if (toRead) {
      val p = 1f + 0.15f * kotlin.math.sin(Math.PI.toFloat() * min(1f, t * 1.3f))
      c.scale(p, p, gx, cy)
    }
    var groupAlpha = 1f
    if (from == 0.0) {
      // ⏱ some rápido; os ✓ estalam
      val ca = max(0f, 1f - t * 3f)
      if (ca > 0f) {
        stroke.color = withAlpha(m.color, ca); stroke.strokeWidth = s.dp(1.2f)
        c.drawCircle(x + s.dp(6f), cy, s.dp(5f), stroke)
        c.drawLine(x + s.dp(6f), cy, x + s.dp(6f), cy - s.dp(3.2f), stroke)
        c.drawLine(x + s.dp(6f), cy, x + s.dp(8.4f), cy + s.dp(1f), stroke)
      }
      val ps = 0.5f + 0.5f * backOut(t)
      c.scale(ps, ps, gx, cy)
      groupAlpha = min(1f, t * 4f)
    }
    if (st >= 1.5) {
      var x1 = x
      var dx2 = 0f
      var a2 = 1f
      if (from >= 1.0 && from < 1.5) {
        val e = cubicOut(t)
        x1 = x + s.dp(1f) * (1f - e)
        dx2 = -s.dp(4.5f) * (1f - e)
        a2 = e
      }
      drawCheck(c, x1, cy - s.dp(5f), withAlpha(color, groupAlpha), s)
      drawCheck(c, x + s.dp(4.5f) + dx2, cy - s.dp(5f), withAlpha(color, groupAlpha * a2), s)
    } else {
      drawCheck(c, x + s.dp(1f), cy - s.dp(5f), withAlpha(color, groupAlpha), s)
    }
    c.restore()
  }

  private fun drawSmallIcon(c: Canvas, paths: List<Path?>, x: Float, cy: Float, sz: Float, color: Int) {
    c.save()
    c.translate(x, cy - sz / 2)
    val sc = sz / 24f
    c.scale(sc, sc)
    iconStroke.color = color
    iconStroke.strokeWidth = 2.2f
    for (p in paths) if (p != null) c.drawPath(p, iconStroke)
    c.restore()
  }

  private fun drawCheck(c: Canvas, ox: Float, oy: Float, color: Int, s: MLStyle) {
    stroke.color = color; stroke.strokeWidth = s.dp(1.5f)
    tmpPath.reset()
    tmpPath.moveTo(ox + s.dp(0.5f), oy + s.dp(5.5f))
    tmpPath.lineTo(ox + s.dp(3.8f), oy + s.dp(8.6f))
    tmpPath.lineTo(ox + s.dp(10.5f), oy + s.dp(1.4f))
    c.drawPath(tmpPath, stroke)
  }

  private fun drawStar(c: Canvas, cx: Float, cy: Float, r: Float, color: Int) {
    tmpPath.reset()
    for (i in 0 until 10) {
      val rr = if (i % 2 == 0) r else r * 0.45f
      val a = -Math.PI / 2 + i * Math.PI / 5
      val x = cx + (cos(a) * rr).toFloat()
      val y = cy + (sin(a) * rr).toFloat()
      if (i == 0) tmpPath.moveTo(x, y) else tmpPath.lineTo(x, y)
    }
    tmpPath.close()
    fill.color = color
    c.drawPath(tmpPath, fill)
  }

  private fun drawPlay(c: Canvas, r: RectF, color: Int) {
    tmpPath.reset()
    tmpPath.moveTo(r.left + r.width() * 0.30f, r.top + r.height() * 0.22f)
    tmpPath.lineTo(r.left + r.width() * 0.80f, r.centerY())
    tmpPath.lineTo(r.left + r.width() * 0.30f, r.top + r.height() * 0.78f)
    tmpPath.close()
    fill.color = color
    c.drawPath(tmpPath, fill)
  }

  private fun drawReplyArrow(c: Canvas, cx: Float, cy: Float, r: Float, color: Int, alpha: Float) {
    val sz = r * 1.1f
    val ox = cx - sz / 2; val oy = cy - sz / 2
    stroke.color = color; stroke.alpha = (255 * alpha).toInt(); stroke.strokeWidth = r * 0.14f
    tmpPath.reset()
    tmpPath.moveTo(ox + sz * 0.42f, oy + sz * 0.22f)
    tmpPath.lineTo(ox + sz * 0.14f, oy + sz * 0.48f)
    tmpPath.lineTo(ox + sz * 0.42f, oy + sz * 0.74f)
    tmpPath.moveTo(ox + sz * 0.16f, oy + sz * 0.48f)
    tmpPath.quadTo(ox + sz * 0.80f, oy + sz * 0.44f, ox + sz * 0.86f, oy + sz * 0.82f)
    c.drawPath(tmpPath, stroke)
    stroke.alpha = 255
  }

  /** [2026-10-17 fwd-label] seta "encaminhar" = a de responder espelhada (dupla p/ "com frequência"). */
  private fun drawFwdArrows(c: Canvas, left: Float, cy: Float, h: Float, color: Int, many: Boolean) {
    val n = if (many) 2 else 1
    for (i in 0 until n) {
      val cx = left + (if (many) s5(h) else 0f) + h / 2 - i * s5(h)
      c.save()
      c.scale(-1f, 1f, cx, cy)
      drawReplyArrow(c, cx, cy, h / 1.1f, color, 1f)
      c.restore()
    }
  }
  private fun s5(h: Float): Float = h * 0.38f

  private fun drawDeleted(c: Canvas, x: Float, y: Float, sz: Float, color: Int) {
    stroke.color = color; stroke.strokeWidth = sz * 0.09f
    val r = sz / 2 - 1
    c.drawCircle(x + sz / 2, y + sz / 2, r, stroke)
    c.drawLine(x + sz * 0.22f, y + sz * 0.78f, x + sz * 0.78f, y + sz * 0.22f, stroke)
  }

  private fun drawSelect(c: Canvas, r: RectF, on: Boolean, th: MLTheme) {
    if (on) {
      fill.color = th.accent
      c.drawOval(r, fill)
      stroke.color = 0xFFFFFFFF.toInt(); stroke.strokeWidth = r.width() * 0.09f
      tmpPath.reset()
      tmpPath.moveTo(r.left + r.width() * 0.28f, r.centerY())
      tmpPath.lineTo(r.left + r.width() * 0.44f, r.top + r.height() * 0.66f)
      tmpPath.lineTo(r.left + r.width() * 0.74f, r.top + r.height() * 0.34f)
      c.drawPath(tmpPath, stroke)
    } else {
      stroke.color = th.otherMeta; stroke.strokeWidth = r.width() * 0.07f
      c.drawOval(RectF(r.left + 1, r.top + 1, r.right - 1, r.bottom - 1), stroke)
    }
  }

  private fun drawProgress(c: Canvas, cx: Float, cy: Float, rad: Float, pct: Int, s: MLStyle) {
    fill.color = 0x73000000
    c.drawCircle(cx, cy, rad, fill)
    val ir = rad - s.dp(7f)
    tmpRect.set(cx - ir, cy - ir, cx + ir, cy + ir)
    stroke.strokeWidth = s.dp(2.5f)
    stroke.color = 0x4DFFFFFF
    c.drawOval(tmpRect, stroke)
    stroke.color = 0xFFFFFFFF.toInt()
    if (pct < 0) c.drawArc(tmpRect, spinAngle - 90f, 90f, false, stroke)
    else c.drawArc(tmpRect, -90f, 360f * pct.coerceIn(2, 100) / 100f, false, stroke)
  }

  // [voz-wa] pílula de velocidade à direita da onda (nota tocando/pausada)
  private val ratePaint = TextPaint(TextPaint.ANTI_ALIAS_FLAG).apply { typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD) }
  private fun rateLabelFor(r: MLRow): String {
    val st = audio ?: return ""
    return if (st.id == r.id) st.rateLabel else ""
  }
  /** retângulo da pílula (coordenadas do balão); null = sem pílula */
  private fun ratePillRect(L: MLRowLayout, r: MLRow, s: MLStyle): RectF? {
    if (r.audio == null || L.audioFrame.isEmpty) return null
    val lbl = rateLabelFor(r)
    if (lbl.isEmpty()) return null
    ratePaint.textSize = s.sp(12f)
    val w = max(s.dp(34f), ratePaint.measureText(lbl) + s.dp(16f))
    val h = s.dp(22f)
    val f = L.audioFrame
    val cy = f.top + s.dp(15f)
    return RectF(f.right - s.dp(2f) - w, cy - h / 2, f.right - s.dp(2f), cy + h / 2)
  }

  private fun drawAudio(c: Canvas, L: MLRowLayout, r: MLRow, s: MLStyle) {
    val au = r.audio ?: return
    val f = L.audioFrame
    val tint = if (r.own) s.theme.ownText else s.theme.otherText
    val dim = (tint and 0x00FFFFFF) or (0x52 shl 24)
    val b = s.dp(38f)
    val cx = f.left + b / 2
    val cy = f.top + s.dp(1f) + b / 2
    val st = audio
    val active = st != null && st.id == r.id
    val playing = active && st!!.playing
    val loading = active && st!!.loading
    // [native-media-dl] o botão play vira o anel enquanto baixa
    val (amode, adone) = xferMode(au.dl, null, false)
    val aBusy = amode != RingMode.Hidden
    if (!aBusy) {
    fill.color = (tint and 0x00FFFFFF) or (0x24 shl 24)
    c.drawCircle(cx, cy, b / 2, fill)
    if (loading) {
      stroke.color = tint; stroke.strokeWidth = s.dp(2f)
      tmpRect.set(cx - s.dp(9f), cy - s.dp(9f), cx + s.dp(9f), cy + s.dp(9f))
      c.drawArc(tmpRect, (System.currentTimeMillis() % 1000) * 0.36f, 270f, false, stroke)
      postInvalidateOnAnimation()
    } else if (playing) {
      fill.color = tint
      val w = b * 0.16f; val h = b * 0.5f
      c.drawRect(cx - w - s.dp(2f), cy - h / 2, cx - s.dp(2f), cy + h / 2, fill)
      c.drawRect(cx + s.dp(2f), cy - h / 2, cx + s.dp(2f) + w, cy + h / 2, fill)
    } else {
      drawPlay(c, RectF(cx - b * 0.38f, cy - b * 0.38f, cx + b * 0.38f, cy + b * 0.38f), tint)
    }
    }
    if (aBusy || ringVisible[5] || ringFinishAt[5] > 0L) drawRing(c, 5, amode, adone, cx, cy, false, tint, s)
    var dur = au.duration.toDouble()
    if (active) st!!.durMs?.let { if (it > 0) dur = it / 1000.0 }
    var progress = 0f
    var shown = dur
    if (active) st!!.posMs?.let { p ->
      if (p > 0) { shown = p / 1000.0; progress = if (dur > 0) min(1.0, shown / dur).toFloat() else 0f }
    }
    // [motion-conv] entre os pulsos do player extrapola até 0,5 s (redesenho por
    // quadro) e não volta p/ trás por jitter (< 4%); barra da cabeça parcial.
    val smooth = MLMotion.audio
    if (smooth && playing && progress > 0f && dur > 0) {
      val dt = SystemClock.uptimeMillis() - audioAt
      val p0 = st!!.posMs ?: 0.0
      progress = min(1.0, (p0 + min(500L, max(0L, dt))) / 1000.0 / dur).toFloat()
      if (audioShownId == r.id && progress < audioShown && audioShown - progress < 0.04f) progress = audioShown
      if (dt < 500L) postInvalidateOnAnimation()
    }
    audioShown = progress
    audioShownId = r.id
    val bars = if (au.wave.isNotEmpty()) au.wave else FALLBACK_WAVE
    val x0 = f.left + b + s.dp(10f)
    val pill = ratePillRect(L, r, s)
    val avail = (pill?.let { it.left - s.dp(8f) } ?: (f.right - s.dp(4f))) - x0
    if (pill != null) {
      fill.color = (tint and 0x00FFFFFF) or (0x29 shl 24)
      c.drawRoundRect(pill, pill.height() / 2, pill.height() / 2, fill)
      ratePaint.color = tint
      val lbl = rateLabelFor(r)
      val fm = ratePaint.fontMetrics
      c.drawText(lbl, pill.centerX() - ratePaint.measureText(lbl) / 2, pill.centerY() - (fm.ascent + fm.descent) / 2, ratePaint)
    }
    if (avail > s.dp(20f)) {
      val n = bars.size
      val step = avail / n
      val bw = max(s.dp(1.5f), step * 0.58f)
      val midY = f.top + s.dp(15f)
      val playedUpTo = n * progress
      for (i in 0 until n) {
        val v = bars[i].coerceIn(0.08f, 1f)
        val h = max(s.dp(3f), v * s.dp(22f))
        val x = x0 + i * step
        tmpRect.set(x, midY - h / 2, x + bw, midY + h / 2)
        val frac = playedUpTo - i
        if (smooth && frac > 0f && frac < 1f) {
          // [motion-conv] barra da cabeça preenchida em parte
          fill.color = dim
          c.drawRoundRect(tmpRect, bw / 2, bw / 2, fill)
          c.save()
          c.clipRect(x, tmpRect.top, x + bw * frac, tmpRect.bottom)
          fill.color = tint
          c.drawRoundRect(tmpRect, bw / 2, bw / 2, fill)
          c.restore()
        } else {
          fill.color = if (i < playedUpTo) tint else dim
          c.drawRoundRect(tmpRect, bw / 2, bw / 2, fill)
        }
      }
    }
    val sec = max(0, Math.round(shown).toInt())
    val txt = String.format(java.util.Locale.US, "%d:%02d", sec / 60, sec % 60)
    val tl = MLLayoutBuilder.line(txt, s.meta, if (r.own) s.theme.ownMeta else s.theme.otherMeta, s.dp(80f))
    drawText(c, tl, x0, f.bottom - tl.height - s.dp(1f))
    if (!r.own && au.voice && !au.played) {
      fill.color = s.theme.read
      c.drawCircle(f.left + b - s.dp(5f), f.top + b - s.dp(4f), s.dp(4f), fill)
    }
  }

  private fun drawFile(c: Canvas, L: MLRowLayout, r: MLRow, s: MLStyle) {
    val f = L.fileFrame
    val icon = RectF(f.left, f.top + max(0f, (f.height() - s.dp(44f)) / 2), f.left + s.dp(38f), f.top + max(0f, (f.height() - s.dp(44f)) / 2) + s.dp(44f))
    fill.color = if (r.own) ((s.theme.ownText and 0x00FFFFFF) or (0x38 shl 24)) else ((s.theme.accent and 0x00FFFFFF) or (0xD9 shl 24))
    c.drawRoundRect(icon, s.dp(7f), s.dp(7f), fill)
    // [native-media-dl] anel no ícone + "1,2 MB de 4,5 MB"
    val fd = r.file?.dl
    val (fmode, fdone) = xferMode(fd, null, false)
    val fBusy = fmode != RingMode.Hidden
    if (!fBusy) L.fileExt?.let { drawText(c, it, icon.centerX() - it.width / 2, icon.centerY() - it.height / 2) }
    if (fBusy || ringVisible[6] || ringFinishAt[6] > 0L) drawRing(c, 6, fmode, fdone, icon.centerX(), icon.centerY(), false, 0xFFFFFFFF.toInt(), s)
    val nh = L.fileName?.height ?: 0f
    val sh = L.fileSize?.height ?: 0f
    var y = f.top + max(0f, (f.height() - nh - sh - s.dp(2f)) / 2)
    L.fileName?.let { drawText(c, it, f.left + s.dp(48f), y); y += it.height + s.dp(2f) }
    val fx = if (fd != null) MLTransfers.item(fd.key) else null
    val ptxt = if (fx != null && fx.state == MLXferState.RUNNING) MLTransfers.progressText(fx) else ""
    if (ptxt.isNotEmpty() && L.fileSize != null) {
      ringText.textSize = s.dp(12f)
      ringText.typeface = android.graphics.Typeface.DEFAULT
      ringText.color = if (r.own) s.theme.ownMeta else s.theme.otherMeta
      val fm = ringText.fontMetrics
      c.drawText(ptxt, f.left + s.dp(48f), y - fm.ascent, ringText)
    } else L.fileSize?.let { drawText(c, it, f.left + s.dp(48f), y) }
  }

  // ─── [2026-10-15 native-media-dl] anel de transferência (baixar/enviar) ────
  sealed class RingMode {
    object Hidden : RingMode()
    data class Download(val text: String) : RingMode()
    data class Progress(val f: Float) : RingMode()
    object Spin : RingMode()
  }

  /** (modo do anel, já local?) de um slot. */
  private fun xferMode(dl: MLMediaDL?, up: Int?, sizeText: Boolean): Pair<RingMode, Boolean> {
    if (up != null) return Pair(if (up < 0) RingMode.Spin else RingMode.Progress(up.coerceIn(0, 100) / 100f), true)
    if (dl == null) return Pair(RingMode.Hidden, true)
    val x = MLTransfers.probe(dl)
    return when (x.state) {
      MLXferState.DONE -> Pair(RingMode.Hidden, true)
      MLXferState.QUEUED -> Pair(RingMode.Spin, false)
      MLXferState.RUNNING -> Pair(if (x.total > 0) RingMode.Progress(x.fraction) else RingMode.Spin, false)
      else -> {
        if (dl.js && x.state == MLXferState.NONE) Pair(RingMode.Spin, false)
        else Pair(RingMode.Download(if (sizeText) MLTransfers.formatBytes(if (dl.size > 0) dl.size else x.total) else ""), false)
      }
    }
  }

  /** Foto/GIF com `dl` só aparece nítida depois de baixada (antes: miniatura + anel). */
  private fun effectiveUri(md: MLMedia): String {
    val d = md.dl ?: return md.uri
    if (md.up != null || (md.kind != "image" && md.kind != "gif")) return md.uri
    val x = MLTransfers.probe(d)
    val l = x.local
    return if (x.state == MLXferState.DONE && l != null) l else ""
  }

  private fun anySpin(): Boolean {
    val r = row ?: return false
    fun sp(dl: MLMediaDL?, up: Int?): Boolean = xferMode(dl, up, false).first == RingMode.Spin
    r.media?.let { if (it.kind != "sticker" && sp(it.dl, it.up)) return true }
    for (m in r.album) if (sp(m.dl, m.up)) return true
    r.audio?.let { if (sp(it.dl, null)) return true }
    r.file?.let { if (sp(it.dl, null)) return true }
    return false
  }

  private fun refreshTransferKeys() {
    val r = row ?: run { transferKeys = emptySet(); return }
    val k = HashSet<String>()
    r.media?.dl?.let { k.add(it.key) }
    for (m in r.album) m.dl?.let { k.add(it.key) }
    r.audio?.dl?.let { k.add(it.key) }
    r.file?.dl?.let { k.add(it.key) }
    transferKeys = k
  }

  /** Transferência mudou (progresso/fim): troca a foto e redesenha o anel. */
  fun applyTransfers() {
    val r = row ?: return
    val L = lay ?: return
    ringAnimated = true
    val md = r.media
    if (md != null && !L.mediaFrame.isEmpty) {
      mediaSlot.set(effectiveUri(md), md.thumb, L.mediaFrame.width().toInt(), L.mediaFrame.height().toInt(), md.kind == "gif" || md.kind == "sticker", md.kind == "sticker", if (md.kind == "video") md.vf else "")
    }
    for (i in 0 until 4) {
      if (i < r.album.size && i < L.albumFrames.size) {
        val f = L.albumFrames[i]
        albumSlots[i].set(effectiveUri(r.album[i]), r.album[i].thumb, f.width().toInt(), f.height().toInt(), false, false, if (r.album[i].kind == "video") r.album[i].vf else "")
      }
    }
    if (anySpin() || L.hasLoader) startSpinner() else stopSpinner()
    invalidate()
  }

  /** Auto-download (política do usuário) das mídias desta linha. */
  fun autoStartTransfers(owner: MLTransferObserver) {
    val r = row ?: return
    if (r.kind != MLKind.MSG || r.deleted) return
    val dls = ArrayList<MLMediaDL>()
    r.media?.let { if (it.up == null && it.kind != "sticker") it.dl?.let { d -> dls.add(d) } }
    for (m in r.album) if (m.up == null) m.dl?.let { dls.add(it) }
    r.audio?.dl?.let { dls.add(it) }
    r.file?.dl?.let { dls.add(it) }
    for (d in dls) {
      if (d.js) continue
      val x = MLTransfers.probe(d)
      if (x.state == MLXferState.NONE && !x.autoTried && MLTransfers.allowsAuto(d.bucket)) MLTransfers.start(d, false, owner)
    }
  }

  /** dl / up do slot (p/ a lista decidir baixar, cancelar ou mandar ao JS). */
  fun xferInfo(slot: Int): Pair<MLMediaDL?, Int?> {
    val r = row ?: return Pair(null, null)
    return when (slot) {
      -1 -> Pair(r.media?.dl, r.media?.up)
      XFER_AUDIO -> Pair(r.audio?.dl, null)
      XFER_FILE -> Pair(r.file?.dl, null)
      else -> if (slot in 0 until r.album.size) Pair(r.album[slot].dl, r.album[slot].up) else Pair(null, null)
    }
  }

  private fun xferHit(bx: Float, by: Float, L: MLRowLayout, r: MLRow, s: MLStyle): Int? {
    val ringR = s.dp(24f) + s.dp(12f)
    fun inRing(cx: Float, cy: Float): Boolean = (bx - cx) * (bx - cx) + (by - cy) * (by - cy) <= ringR * ringR
    val md = r.media
    if (md != null && md.kind != "sticker" && !L.mediaFrame.isEmpty) {
      if (md.up != null) { if (inRing(L.mediaFrame.centerX(), L.mediaFrame.centerY())) return -1 }
      else if (md.dl != null && L.mediaFrame.contains(bx, by)) {
        // botão "baixar": a mídia inteira; baixando: só o anel (X) — fora dele abre
        val m = xferMode(md.dl, null, false)
        if (!m.second && (m.first is RingMode.Download || inRing(L.mediaFrame.centerX(), L.mediaFrame.centerY()))) return -1
      }
    }
    for ((i, f) in L.albumFrames.withIndex()) {
      if (i >= r.album.size) break
      val am = r.album[i]
      if (am.up != null) { if (f.contains(bx, by) && inRing(f.centerX(), f.centerY())) return i; continue }
      if (am.dl != null && f.contains(bx, by)) {
        val m = xferMode(am.dl, null, false)
        if (!m.second && (m.first is RingMode.Download || inRing(f.centerX(), f.centerY()))) return i
      }
    }
    val au = r.audio
    if (au?.dl != null && !L.audioFrame.isEmpty && !xferMode(au.dl, null, false).second) {
      val b = s.dp(38f)
      if (bx >= L.audioFrame.left - s.dp(8f) && bx <= L.audioFrame.left + b + s.dp(12f) && by >= L.audioFrame.top - s.dp(6f) && by <= L.audioFrame.bottom + s.dp(6f)) return XFER_AUDIO
    }
    val fl = r.file
    if (fl?.dl != null && !L.fileFrame.isEmpty && L.fileFrame.contains(bx, by) && !xferMode(fl.dl, null, false).second) return XFER_FILE
    return null
  }

  /**
   * Desenha o anel do slot. overlay = branco sobre disco escurecido (foto/vídeo);
   * senão anel na cor `tint` sobre disco translúcido (áudio/arquivo).
   */
  private fun drawRing(c: Canvas, slot: Int, mode: RingMode, done: Boolean, cx: Float, cy: Float, overlay: Boolean, tint: Int, s: MLStyle) {
    val now = SystemClock.uptimeMillis()
    if (mode == RingMode.Hidden) {
      if (ringVisible[slot] && done && ringAnimated && ringFinishAt[slot] == 0L) ringFinishAt[slot] = now
      ringVisible[slot] = false
      val fa = ringFinishAt[slot]
      if (fa == 0L) return
      val t = (now - fa) / 380f
      if (t >= 1f) { ringFinishAt[slot] = 0L; return }
      // arco fecha (0..0.4) e o anel encolhe/some (0.4..1)
      val k = ((t - 0.4f) / 0.6f).coerceIn(0f, 1f)
      ringShown[slot] = ringShown[slot] + (1f - ringShown[slot]) * 0.35f
      c.save()
      c.scale(1f - 0.45f * k, 1f - 0.45f * k, cx, cy)
      drawRingBody(c, cx, cy, overlay, tint, s, ringShown[slot], false, ((1f - k) * 255).toInt(), false)
      c.restore()
      postInvalidateOnAnimation()
      return
    }
    ringFinishAt[slot] = 0L
    val first = !ringVisible[slot]
    ringVisible[slot] = true
    when (mode) {
      is RingMode.Download -> {
        val a = 255
        if (overlay && mode.text.isNotEmpty()) {
          // pílula "↓ 12,4 MB"
          ringText.textSize = s.dp(13f)
          ringText.typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD)
          val tw = ringText.measureText(mode.text)
          val h = s.dp(34f)
          val w = s.dp(14f + 16f + 6f + 14f) + tw
          tmpRect.set(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
          fill.color = 0x80000000.toInt()
          c.drawRoundRect(tmpRect, h / 2, h / 2, fill)
          val ix = tmpRect.left + s.dp(14f)
          drawArrowDown(c, RectF(ix, cy - s.dp(8f), ix + s.dp(16f), cy + s.dp(8f)), 0xFFFFFFFF.toInt(), s.dp(2.2f), a)
          ringText.color = 0xFFFFFFFF.toInt()
          val fm = ringText.fontMetrics
          c.drawText(mode.text, ix + s.dp(22f), cy - (fm.ascent + fm.descent) / 2, ringText)
        } else {
          val rad = if (overlay) s.dp(24f) else s.dp(19f)
          fill.color = if (overlay) 0x80000000.toInt() else ((tint and 0x00FFFFFF) or (0x24 shl 24))
          c.drawCircle(cx, cy, rad, fill)
          val ir = rad * 0.4f
          drawArrowDown(c, RectF(cx - ir, cy - ir, cx + ir, cy + ir), if (overlay) 0xFFFFFFFF.toInt() else tint, if (overlay) s.dp(2.2f) else s.dp(2f), a)
        }
      }
      is RingMode.Progress -> {
        val target = mode.f.coerceIn(0.02f, 1f)
        if (first) ringShown[slot] = target
        val cur = ringShown[slot]
        if (abs(target - cur) > 0.003f) {
          ringShown[slot] = cur + (target - cur) * 0.25f + (if (target > cur) 0.002f else -0.002f)
          if ((target - cur) * (target - ringShown[slot]) < 0f) ringShown[slot] = target
          postInvalidateOnAnimation()
        } else ringShown[slot] = target
        drawRingBody(c, cx, cy, overlay, tint, s, ringShown[slot], false, 255, true)
      }
      is RingMode.Spin -> drawRingBody(c, cx, cy, overlay, tint, s, 0.25f, true, 255, true)
      else -> {}
    }
  }

  private fun drawRingBody(c: Canvas, cx: Float, cy: Float, overlay: Boolean, tint: Int, s: MLStyle, f: Float, spin: Boolean, alpha: Int, cross: Boolean) {
    val rad = if (overlay) s.dp(24f) else s.dp(19f)
    fill.color = if (overlay) 0x80000000.toInt() else ((tint and 0x00FFFFFF) or (0x24 shl 24))
    fill.alpha = (((fill.color ushr 24) and 0xFF) * alpha / 255)
    c.drawCircle(cx, cy, rad, fill)
    fill.alpha = 255
    val ir = rad - (if (overlay) s.dp(7f) else s.dp(3f))
    tmpRect.set(cx - ir, cy - ir, cx + ir, cy + ir)
    stroke.strokeWidth = if (overlay) s.dp(2.5f) else s.dp(2f)
    val fg = if (overlay) 0xFFFFFFFF.toInt() else tint
    stroke.color = (fg and 0x00FFFFFF) or ((((fg ushr 24) and 0xFF) * 0.28f * alpha / 255).toInt() shl 24)
    c.drawOval(tmpRect, stroke)
    stroke.color = (fg and 0x00FFFFFF) or ((((fg ushr 24) and 0xFF) * alpha / 255) shl 24)
    if (spin) c.drawArc(tmpRect, spinAngle - 90f, 90f, false, stroke)
    else c.drawArc(tmpRect, -90f, 360f * f.coerceIn(0f, 1f), false, stroke)
    if (cross) {
      val h = rad * (if (overlay) 0.27f else 0.3f)
      stroke.strokeWidth = if (overlay) s.dp(2.2f) else s.dp(2f)
      c.drawLine(cx - h, cy - h, cx + h, cy + h, stroke)
      c.drawLine(cx + h, cy - h, cx - h, cy + h, stroke)
    }
  }

  private fun drawArrowDown(c: Canvas, r: RectF, color: Int, w: Float, alpha: Int) {
    stroke.color = (color and 0x00FFFFFF) or ((((color ushr 24) and 0xFF) * alpha / 255) shl 24)
    stroke.strokeWidth = w
    tmpPath.reset()
    tmpPath.moveTo(r.centerX(), r.top + r.height() * 0.1f)
    tmpPath.lineTo(r.centerX(), r.bottom - r.height() * 0.12f)
    tmpPath.moveTo(r.left + r.width() * 0.2f, r.centerY() + r.height() * 0.06f)
    tmpPath.lineTo(r.centerX(), r.bottom - r.height() * 0.1f)
    tmpPath.lineTo(r.right - r.width() * 0.2f, r.centerY() + r.height() * 0.06f)
    c.drawPath(tmpPath, stroke)
  }

  companion object {
    /** ids das ações personalizadas do TalkBack (fora das ações padrão / android.R.id). */
    const val A11Y_ACTION_BASE = 0x7E0A1100
    const val XFER_AUDIO = 100
    const val XFER_FILE = 101
    // lucide "pin" e "timer" (viewBox 24) — mesmos ícones do JS
    val PIN_PATHS: List<Path?> by lazy { listOf(
      MLNode.parsePath("M12 17v5"),
      MLNode.parsePath("M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"),
    ) }
    val TIMER_PATHS: List<Path?> by lazy { listOf(
      MLNode.parsePath("M10 2h4"),
      MLNode.parsePath("M12 14l3-3"),
      MLNode.parsePath("M4 14a8 8 0 1 0 16 0a8 8 0 1 0-16 0"),
    ) }
    val FALLBACK_WAVE = FloatArray(40) { i ->
      val v = abs(sin(i * 0.9) * 0.6 + sin(i * 0.37) * 0.4)
      (0.15 + v * 0.75).toFloat()
    }
  }
}
