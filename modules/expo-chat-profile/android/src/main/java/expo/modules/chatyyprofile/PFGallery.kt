package expo.modules.chatyyprofile

// [2026-10-15 native-profile] Galeria de fotos do perfil em tela cheia
// (Dialog): hero a partir do avatar, páginas horizontais (ViewPager2),
// barrinhas segmentadas no topo (Telegram), arrastar vertical fecha.

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.Rect
import android.graphics.drawable.ColorDrawable
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import androidx.recyclerview.widget.RecyclerView
import androidx.viewpager2.widget.ViewPager2
import com.bumptech.glide.Glide
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

internal class PFGallery(
  private val activity: Activity,
  private val photos: List<PFImage>,
  /** Retângulo do avatar na tela (px) — origem/destino do hero. */
  private val fromRect: Rect?,
  private val closeLabel: String,
  private val onClosed: () -> Unit,
) {
  private val ctx: Context = activity
  // [2026-10-17 android-wa] Android 14+ with enableOnBackInvokedCallback never
  // delivers KEYCODE_BACK to the key listener — the Dialog's own back callback
  // calls onBackPressed() → cancel() (no close animation, onClosed() never ran).
  // Route it to our animated dismiss().
  private val dialog = object : Dialog(activity, android.R.style.Theme_Translucent_NoTitleBar) {
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
      this@PFGallery.dismiss()
    }
  }
  private val root = DragRoot(ctx)
  private val bg = View(ctx)
  private val pager = ViewPager2(ctx)
  private val bars = LinearLayout(ctx)
  private val close = ImageView(ctx)
  private var closing = false
  private var current = 0

  fun show() {
    dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
    bg.setBackgroundColor(Color.BLACK)
    bg.alpha = 0f
    root.addView(bg, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

    pager.adapter = Adapter()
    pager.offscreenPageLimit = 1
    root.addView(pager, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

    bars.orientation = LinearLayout.HORIZONTAL
    val barsLp = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, pfDp(ctx, 2.5f))
    barsLp.topMargin = pfDp(ctx, 40f)
    barsLp.leftMargin = pfDp(ctx, 10f)
    barsLp.rightMargin = pfDp(ctx, 10f)
    if (photos.size > 1) {
      for (i in photos.indices) {
        val b = View(ctx)
        b.background = pfRounded(Color.WHITE, pfDpF(ctx, 1.5f))
        val lp = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f)
        if (i > 0) lp.leftMargin = pfDp(ctx, 4f)
        bars.addView(b, lp)
      }
    }
    bars.alpha = 0f
    root.addView(bars, barsLp)

    pfTintedIcon(close, "close", Color.WHITE)
    close.scaleType = ImageView.ScaleType.CENTER
    close.contentDescription = closeLabel
    close.background = pfRipple(0x33FFFFFF, pfDpF(ctx, 22f))
    close.setOnClickListener { dismiss() }
    val closeLp = FrameLayout.LayoutParams(pfDp(ctx, 44f), pfDp(ctx, 44f), Gravity.TOP or Gravity.START)
    closeLp.topMargin = pfDp(ctx, 50f)
    closeLp.leftMargin = pfDp(ctx, 6f)
    close.alpha = 0f
    root.addView(close, closeLp)

    pager.registerOnPageChangeCallback(object : ViewPager2.OnPageChangeCallback() {
      override fun onPageSelected(position: Int) {
        current = position
        updateBars()
      }
    })
    updateBars()

    dialog.setContentView(root)
    dialog.window?.let { w ->
      w.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      w.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
      w.addFlags(WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS)
      w.setWindowAnimations(0)
    }
    dialog.setOnKeyListener { _, keyCode, event ->
      if (keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) { dismiss(); true } else keyCode == KeyEvent.KEYCODE_BACK
    }
    // Any other cancel path (system) still tells JS the gallery closed.
    dialog.setOnCancelListener {
      if (!closing) {
        closing = true
        onClosed()
      }
    }
    try { dialog.show() } catch (_: Throwable) { onClosed(); return }
    root.post { heroIn() }
  }

  private fun updateBars() {
    for (i in 0 until bars.childCount) bars.getChildAt(i).alpha = if (i == current) 1f else 0.35f
  }

  /** Escala/deslocamento que faz a página (fit-center, ~quadrada) caber no avatar. */
  private fun heroTransform(): FloatArray {
    val r = fromRect ?: return floatArrayOf(0.6f, 0f, 0f)
    val w = max(1, root.width).toFloat()
    val h = max(1, root.height).toFloat()
    val s = (r.width().toFloat() / min(w, h)).coerceIn(0.05f, 1f)
    val loc = IntArray(2)
    root.getLocationOnScreen(loc)
    val tx = r.exactCenterX() - loc[0] - w / 2f
    val ty = r.exactCenterY() - loc[1] - h / 2f
    return floatArrayOf(s, tx, ty)
  }

  private fun heroIn() {
    val t = heroTransform()
    pager.scaleX = t[0]; pager.scaleY = t[0]
    pager.translationX = t[1]; pager.translationY = t[2]
    val a = ValueAnimator.ofFloat(0f, 1f)
    a.duration = 320
    a.interpolator = DecelerateInterpolator(2.2f)
    a.addUpdateListener {
      val f = it.animatedValue as Float
      val s = t[0] + (1f - t[0]) * f
      pager.scaleX = s; pager.scaleY = s
      pager.translationX = t[1] * (1f - f)
      pager.translationY = t[2] * (1f - f)
      bg.alpha = f
      bars.alpha = f
      close.alpha = f
    }
    a.start()
  }

  fun dismiss() {
    if (closing) return
    closing = true
    val t = if (current == 0) heroTransform() else floatArrayOf(0.85f, 0f, pager.translationY + pfDpF(ctx, 80f))
    val s0 = pager.scaleX
    val tx0 = pager.translationX
    val ty0 = pager.translationY
    val bg0 = bg.alpha
    val a = ValueAnimator.ofFloat(0f, 1f)
    a.duration = 260
    a.interpolator = DecelerateInterpolator(1.6f)
    a.addUpdateListener {
      val f = it.animatedValue as Float
      val s = s0 + (t[0] - s0) * f
      pager.scaleX = s; pager.scaleY = s
      pager.translationX = tx0 + (t[1] - tx0) * f
      pager.translationY = ty0 + (t[2] - ty0) * f
      bg.alpha = bg0 * (1f - f)
      bars.alpha = 1f - f
      close.alpha = 1f - f
      if (current != 0) pager.alpha = 1f - f
    }
    a.addListener(object : AnimatorListenerAdapter() {
      override fun onAnimationEnd(animation: Animator) {
        try { dialog.dismiss() } catch (_: Throwable) {}
        onClosed()
      }
    })
    a.start()
  }

  private inner class Holder(val iv: ImageView) : RecyclerView.ViewHolder(iv)

  private inner class Adapter : RecyclerView.Adapter<Holder>() {
    override fun getItemCount(): Int = photos.size
    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
      val iv = ImageView(parent.context)
      iv.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.MATCH_PARENT)
      iv.scaleType = ImageView.ScaleType.FIT_CENTER
      iv.setOnClickListener { toggleChrome() }
      return Holder(iv)
    }
    override fun onBindViewHolder(holder: Holder, position: Int) {
      try { Glide.with(holder.iv).load(photos[position].model()).fitCenter().into(holder.iv) } catch (_: Throwable) {}
    }
  }

  private fun toggleChrome() {
    val to = if (close.alpha > 0.5f) 0f else 1f
    close.animate().alpha(to).setDuration(180).start()
    bars.animate().alpha(to).setDuration(180).start()
  }

  /** Raiz que intercepta o arraste VERTICAL (fecha); horizontal fica com o pager. */
  @SuppressLint("ViewConstructor")
  private inner class DragRoot(c: Context) : FrameLayout(c) {
    private val slop = ViewConfiguration.get(c).scaledTouchSlop
    private var downX = 0f
    private var downY = 0f
    private var dragging = false
    private var lastY = 0f
    private var lastT = 0L
    private var vel = 0f

    override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
      if (closing) return true
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> { downX = ev.rawX; downY = ev.rawY; dragging = false; lastY = ev.rawY; lastT = ev.eventTime; vel = 0f }
        MotionEvent.ACTION_MOVE -> {
          val dx = ev.rawX - downX
          val dy = ev.rawY - downY
          if (!dragging && abs(dy) > slop && abs(dy) > abs(dx) * 1.3f) { dragging = true; return true }
        }
      }
      return dragging
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(ev: MotionEvent): Boolean {
      if (closing) return true
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> return true
        MotionEvent.ACTION_MOVE -> {
          if (!dragging) {
            val dy0 = ev.rawY - downY
            if (abs(dy0) > slop) dragging = true else return true
          }
          val dt = max(1L, ev.eventTime - lastT)
          vel = (ev.rawY - lastY) / dt * 1000f
          lastY = ev.rawY; lastT = ev.eventTime
          val dy = ev.rawY - downY
          val h = max(1, height).toFloat()
          pager.translationY = dy
          pager.translationX = (ev.rawX - downX) * 0.3f
          val s = 1f - min(0.25f, abs(dy) / h * 0.6f)
          pager.scaleX = s; pager.scaleY = s
          bg.alpha = (1f - abs(dy) / (h * 0.55f)).coerceIn(0f, 1f)
          close.alpha = bg.alpha
          bars.alpha = bg.alpha
          return true
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          if (!dragging) return true
          dragging = false
          val dy = ev.rawY - downY
          if (abs(dy) > pfDpF(ctx, 100f) || abs(vel) > pfDpF(ctx, 900f)) {
            dismiss()
          } else {
            val ty0 = pager.translationY; val tx0 = pager.translationX; val s0 = pager.scaleX; val b0 = bg.alpha
            val a = ValueAnimator.ofFloat(0f, 1f)
            a.duration = 280
            a.interpolator = android.view.animation.OvershootInterpolator(1.1f)
            a.addUpdateListener {
              val f = it.animatedValue as Float
              pager.translationY = ty0 * (1f - f)
              pager.translationX = tx0 * (1f - f)
              val s = s0 + (1f - s0) * f
              pager.scaleX = s; pager.scaleY = s
              bg.alpha = (b0 + (1f - b0) * f).coerceIn(0f, 1f)
              close.alpha = bg.alpha
              bars.alpha = bg.alpha
            }
            a.start()
          }
          return true
        }
      }
      return true
    }
  }
}
