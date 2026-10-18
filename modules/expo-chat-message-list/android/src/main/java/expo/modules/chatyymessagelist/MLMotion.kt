package expo.modules.chatyymessagelist

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.os.Build
import android.view.View
import android.view.animation.DecelerateInterpolator
import androidx.dynamicanimation.animation.DynamicAnimation
import androidx.dynamicanimation.animation.SpringAnimation
import androidx.dynamicanimation.animation.SpringForce
import androidx.recyclerview.widget.DefaultItemAnimator
import androidx.recyclerview.widget.RecyclerView

// [2026-10-16 motion-conv, apiVersion 7] Movimento "nível Telegram" da lista
// nativa. Prop `motion` {i, e, t, r, s, a} (0/1; ausente = ligado), vinda do JS
// (globalThis.__chatyy_motion_* — components/chat/nativeThreadList.js):
//   i  inserção com mola (enviada sai do composer; recebida sobe curta) e
//      vizinhas andando JUNTO (o DefaultItemAnimator esperava as vizinhas
//      andarem p/ só então fazer o fade da nova). Desligado = antigo.
//   e  apagar (encolhe e some) / virar "apagada" / altura mudou (editar,
//      reação, tradução…) com mola, se tudo estiver na tela. Desligado = seco.
//   t  ⏱ → ✓ → ✓✓ → lida animado (coreografia do AnimatedCheckStatus JS).
//   r  reação nova de outra pessoa → pop do chip.
//   s  pílula de data flutuante com escala na entrada/saída.
//   a  áudio: progresso da onda contínuo (extrapolado entre pulsos do player,
//      barra parcial) em vez de pular barra a barra.
// "Remover animações" do sistema (escala de animação 0) → tudo desligado.
object MLMotion {
  var insert = true
  var edit = true
  var ticks = true
  var react = true
  var sticky = true
  var audio = true
  /** [2026-10-18 tg-list, apiVersion 11] c: ponteiros do relógio do pendente giram após ~300 ms */
  var clock = true

  fun apply(m: Map<String, Any?>?) {
    fun on(k: String): Boolean {
      val v = m?.get(k) ?: return true
      return MLRow.bool(v)
    }
    insert = on("i")
    edit = on("e")
    ticks = on("t")
    react = on("r")
    sticky = on("s")
    audio = on("a")
    clock = on("c")
  }

  /** Animações do sistema ligadas (Acessibilidade → remover animações = false). */
  fun systemOn(): Boolean = if (Build.VERSION.SDK_INT >= 26) ValueAnimator.areAnimatorsEnabled() else true

  // ≈ SPRING_SEND do JS (stiffness 340 / damping 28 → ζ≈0.76)
  const val STIFF_SEND = 340f
  const val DAMP_SEND = 0.76f
  const val STIFF_EDIT = 420f
  const val DAMP_EDIT = 0.86f
}

/**
 * [motion-conv] ItemAnimator: `style` 0 = DefaultItemAnimator puro (antigo);
 * 1 = inserção com mola; 2 = edição (apagar/colapsar). Em 1/2 as inserções,
 * remoções e movimentos rodam aqui, TODOS ao mesmo tempo (sem o atraso em
 * fila do DefaultItemAnimator), com SpringAnimation (interrompível).
 * `sideOf`: 1 enviada, 0 recebida, 2 pílula.
 */
class MLItemAnimator(private val sideOf: (RecyclerView.ViewHolder) -> Int) : DefaultItemAnimator() {
  var style = 0
  /**
   * [2026-10-18 tg-list, apiVersion 11] morph do envio (prepareSend): devolve o
   * início {dx, dy, scaleX, pivotX, pivotY} da célula enviada mais nova (o balão
   * sai do retângulo do compositor) ou null = entrada padrão.
   */
  var morphFrom: ((RecyclerView.ViewHolder) -> FloatArray?)? = null
  private val morphing = HashSet<RecyclerView.ViewHolder>()

  private class Run(val holder: RecyclerView.ViewHolder, val kind: Int) {
    // kind: 0 add, 1 remove, 2 move
    val springs = ArrayList<SpringAnimation>(4)
    var fade: ValueAnimator? = null
    var left = 0
  }

  private val pendingAdds = ArrayList<RecyclerView.ViewHolder>()
  private val pendingRemoves = ArrayList<RecyclerView.ViewHolder>()
  private val pendingMoves = ArrayList<RecyclerView.ViewHolder>()
  private val running = HashMap<RecyclerView.ViewHolder, Run>()

  init {
    supportsChangeAnimations = false
    addDuration = 180
    moveDuration = 200
    removeDuration = 120
  }

  private fun dp(v: View, x: Float) = x * v.resources.displayMetrics.density
  /** opacidade "de repouso" da célula (row.op; o bind já aplicou) */
  private fun restAlpha(v: View): Float = (v as? MLCellView)?.row?.opacity ?: 1f

  override fun animateAdd(holder: RecyclerView.ViewHolder): Boolean {
    if (style == 0) return super.animateAdd(holder)
    endAnimation(holder)
    val v = holder.itemView
    val w = v.width.toFloat()
    val h = v.height.toFloat()
    val b = (v as? MLCellView)?.bubbleRectInCell()
    v.alpha = 0f
    if (style == 2) {
      // "mensagem apagada" no lugar da original: surge no mesmo ponto
      v.pivotX = w / 2; v.pivotY = h / 2
      v.scaleX = 0.96f; v.scaleY = 0.96f
    } else {
      when (sideOf(holder)) {
        1 -> {
          val m = try { morphFrom?.invoke(holder) } catch (_: Throwable) { null }
          if (m != null && m.size >= 5) {
            // [tg-list] balão nasce no retângulo do compositor e vai ao lugar (mola sem overshoot)
            v.pivotX = m[3]; v.pivotY = m[4]
            v.scaleX = m[2]; v.scaleY = 1f
            v.translationX = m[0]; v.translationY = m[1]
            v.alpha = 0.6f
            morphing.add(holder)
          } else {
            // enviada: sai do composer (34 dp abaixo, .9 ancorada direita-baixo)
            v.pivotX = b?.right ?: w; v.pivotY = b?.bottom ?: h
            v.scaleX = 0.9f; v.scaleY = 0.9f
            v.translationX = -dp(v, 14f); v.translationY = dp(v, 34f)
          }
        }
        0 -> {
          v.pivotX = b?.left ?: 0f; v.pivotY = b?.bottom ?: h
          v.scaleX = 0.96f; v.scaleY = 0.96f
          v.translationY = dp(v, 14f)
        }
        else -> v.translationY = dp(v, 10f)
      }
    }
    pendingAdds.add(holder)
    return true
  }

  override fun animateRemove(holder: RecyclerView.ViewHolder): Boolean {
    if (style != 2) return super.animateRemove(holder)
    endAnimation(holder)
    pendingRemoves.add(holder)
    return true
  }

  override fun animateMove(holder: RecyclerView.ViewHolder, fromX: Int, fromY: Int, toX: Int, toY: Int): Boolean {
    if (style == 0) return super.animateMove(holder, fromX, fromY, toX, toY)
    val v = holder.itemView
    val fx = fromX + v.translationX.toInt()
    val fy = fromY + v.translationY.toInt()
    endAnimation(holder)
    val dx = toX - fx
    val dy = toY - fy
    if (dx == 0 && dy == 0) { dispatchMoveFinished(holder); return false }
    v.translationX = -dx.toFloat()
    v.translationY = -dy.toFloat()
    pendingMoves.add(holder)
    return true
  }

  override fun animateChange(
    oldHolder: RecyclerView.ViewHolder, newHolder: RecyclerView.ViewHolder,
    preInfo: RecyclerView.ItemAnimator.ItemHolderInfo, postInfo: RecyclerView.ItemAnimator.ItemHolderInfo,
  ): Boolean {
    if (style != 0 && oldHolder === newHolder) {
      // mesma célula mudou de altura: lista invertida ancora a BASE → anima só
      // o quanto a base andou (o topo crescer não é deslocamento)
      return animateMove(newHolder, postInfo.left, preInfo.bottom - (postInfo.bottom - postInfo.top), postInfo.left, postInfo.top)
    }
    return super.animateChange(oldHolder, newHolder, preInfo, postInfo)
  }

  private fun spring(v: View, p: DynamicAnimation.ViewProperty, to: Float, stiff: Float, damp: Float, minVis: Float, run: Run) {
    val s = SpringAnimation(v, p, to)
    s.spring.setStiffness(stiff).setDampingRatio(damp)
    s.setMinimumVisibleChange(minVis)
    run.left++
    s.addEndListener { _, _, _, _ -> partDone(run) }
    run.springs.add(s)
  }

  override fun runPendingAnimations() {
    super.runPendingAnimations()
    if (pendingAdds.isEmpty() && pendingRemoves.isEmpty() && pendingMoves.isEmpty()) return
    val edit = style == 2
    val stiff = if (edit) MLMotion.STIFF_EDIT else MLMotion.STIFF_SEND
    val damp = if (edit) MLMotion.DAMP_EDIT else MLMotion.DAMP_SEND
    val removes = ArrayList(pendingRemoves); pendingRemoves.clear()
    val moves = ArrayList(pendingMoves); pendingMoves.clear()
    val adds = ArrayList(pendingAdds); pendingAdds.clear()
    for (h in removes) {
      val v = h.itemView
      val run = Run(h, 1)
      running[h] = run
      v.pivotX = v.width / 2f; v.pivotY = v.height / 2f
      val a = ValueAnimator.ofFloat(0f, 1f)
      a.duration = 170
      a.interpolator = DecelerateInterpolator(1.4f)
      a.addUpdateListener {
        val f = it.animatedValue as Float
        v.alpha = 1f - f
        val sc = 1f - 0.14f * f
        v.scaleX = sc; v.scaleY = sc
      }
      run.left++
      a.addListener(object : AnimatorListenerAdapter() {
        override fun onAnimationEnd(animation: Animator) { partDone(run) }
      })
      run.fade = a
      dispatchRemoveStarting(h)
      a.start()
    }
    for (h in moves) {
      val v = h.itemView
      val run = Run(h, 2)
      running[h] = run
      if (v.translationX != 0f) spring(v, DynamicAnimation.TRANSLATION_X, 0f, stiff, damp, 1f, run)
      if (v.translationY != 0f) spring(v, DynamicAnimation.TRANSLATION_Y, 0f, stiff, damp, 1f, run)
      dispatchMoveStarting(h)
      if (run.springs.isEmpty()) { run.left = 1; partDone(run) } else for (s in run.springs) s.start()
    }
    for (h in adds) {
      val v = h.itemView
      val run = Run(h, 0)
      running[h] = run
      val morph = morphing.remove(h)
      val st = if (morph) 380f else stiff
      val dm = if (morph) 0.95f else damp
      if (v.translationX != 0f) spring(v, DynamicAnimation.TRANSLATION_X, 0f, st, dm, 1f, run)
      if (v.translationY != 0f) spring(v, DynamicAnimation.TRANSLATION_Y, 0f, st, dm, 1f, run)
      if (v.scaleX != 1f) spring(v, DynamicAnimation.SCALE_X, 1f, st, dm, DynamicAnimation.MIN_VISIBLE_CHANGE_SCALE, run)
      if (v.scaleY != 1f) spring(v, DynamicAnimation.SCALE_Y, 1f, st, dm, DynamicAnimation.MIN_VISIBLE_CHANGE_SCALE, run)
      // opacidade chega a 1 cedo (≈ 35% da mola, como o JS)
      val a = ValueAnimator.ofFloat(v.alpha, restAlpha(v))
      a.duration = if (edit) 200 else if (morph) 160 else 110
      a.addUpdateListener { v.alpha = it.animatedValue as Float }
      run.left++
      a.addListener(object : AnimatorListenerAdapter() {
        override fun onAnimationEnd(animation: Animator) { partDone(run) }
      })
      run.fade = a
      dispatchAddStarting(h)
      a.start()
      for (s in run.springs) s.start()
    }
  }

  private fun partDone(run: Run) {
    if (running[run.holder] !== run) return
    run.left--
    if (run.left > 0) return
    finishRun(run)
  }

  private fun finishRun(run: Run) {
    if (running.remove(run.holder) == null) return
    val v = run.holder.itemView
    when (run.kind) {
      0 -> {
        v.alpha = restAlpha(v); v.translationX = 0f; v.translationY = 0f; v.scaleX = 1f; v.scaleY = 1f
        dispatchAddFinished(run.holder)
      }
      1 -> {
        v.alpha = restAlpha(v); v.scaleX = 1f; v.scaleY = 1f
        dispatchRemoveFinished(run.holder)
      }
      else -> {
        v.translationX = 0f; v.translationY = 0f
        dispatchMoveFinished(run.holder)
      }
    }
    if (!isRunning) dispatchAnimationsFinished()
  }

  /** Encerra (vai ao estado final) o que estiver rodando/pendente nesta célula. */
  private fun endMine(holder: RecyclerView.ViewHolder) {
    val v = holder.itemView
    morphing.remove(holder)
    if (pendingAdds.remove(holder)) {
      v.alpha = restAlpha(v); v.translationX = 0f; v.translationY = 0f; v.scaleX = 1f; v.scaleY = 1f
      dispatchAddFinished(holder)
    }
    if (pendingRemoves.remove(holder)) dispatchRemoveFinished(holder)
    if (pendingMoves.remove(holder)) {
      v.translationX = 0f; v.translationY = 0f
      dispatchMoveFinished(holder)
    }
    val run = running[holder] ?: return
    // tira do mapa ANTES de cancelar (os listeners de fim viram no-op)
    running.remove(holder)
    for (s in run.springs) s.cancel()
    run.fade?.cancel()
    running[holder] = run
    finishRun(run)
  }

  override fun endAnimation(item: RecyclerView.ViewHolder) {
    endMine(item)
    super.endAnimation(item)
  }

  override fun endAnimations() {
    for (h in ArrayList(pendingAdds)) endMine(h)
    for (h in ArrayList(pendingRemoves)) endMine(h)
    for (h in ArrayList(pendingMoves)) endMine(h)
    for (h in ArrayList(running.keys)) endMine(h)
    super.endAnimations()
  }

  override fun isRunning(): Boolean =
    super.isRunning() || running.isNotEmpty() || pendingAdds.isNotEmpty() || pendingRemoves.isNotEmpty() || pendingMoves.isNotEmpty()
}
