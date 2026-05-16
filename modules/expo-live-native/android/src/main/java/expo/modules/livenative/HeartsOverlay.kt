package expo.modules.livenative

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import kotlinx.coroutines.delay
import kotlin.math.sin
import kotlin.random.Random

/**
 * Tiny state holder for the floating-hearts overlay. Each call to [spawn]
 * appends a heart; the [HeartsOverlay] composable advances each heart's
 * vertical position and removes it after the lifetime expires (~2s).
 *
 * Animation is intentionally cheap — a single Canvas redraws at ~30fps. No
 * Animatable objects, no Animation specs. Polish + spring physics come later.
 */
class HeartsState {
    private val _hearts = mutableStateListOf<Heart>()
    internal val hearts: List<Heart> get() = _hearts

    fun spawn() {
        if (_hearts.size > 30) return // hard cap so we never leak
        _hearts.add(
            Heart(
                id = nextId++,
                bornAt = System.currentTimeMillis(),
                horizontalSeed = Random.nextFloat(),
                hue = HEART_HUES[Random.nextInt(HEART_HUES.size)]
            )
        )
    }

    internal fun cull(now: Long) {
        _hearts.removeAll { now - it.bornAt > LIFETIME_MS }
    }

    internal data class Heart(
        val id: Long,
        val bornAt: Long,
        val horizontalSeed: Float,
        val hue: Color
    )

    companion object {
        private var nextId: Long = 1L
        internal const val LIFETIME_MS = 2000L
        private val HEART_HUES = listOf(
            Color(0xFFE91E63),
            Color(0xFFFF4081),
            Color(0xFFF06292),
            Color(0xFFFF80AB)
        )
    }
}

@Composable
fun HeartsOverlay(state: HeartsState, modifier: Modifier = Modifier) {
    var frameNs by remember { mutableStateOf(0L) }

    LaunchedEffect(state) {
        while (true) {
            delay(33L) // ~30fps
            state.cull(System.currentTimeMillis())
            frameNs = System.nanoTime()
        }
    }

    Canvas(modifier = modifier) {
        drawHearts(state, this.size)
        // touch frameNs so the composer redraws every tick
        if (frameNs == Long.MIN_VALUE) return@Canvas
    }
}

private fun DrawScope.drawHearts(state: HeartsState, canvasSize: Size) {
    val now = System.currentTimeMillis()
    val w = canvasSize.width
    val h = canvasSize.height
    if (w <= 0f || h <= 0f) return

    state.hearts.forEach { heart ->
        val age = (now - heart.bornAt).coerceAtLeast(0L)
        val t = (age.toFloat() / HeartsState.LIFETIME_MS).coerceIn(0f, 1f)

        // Vertical: starts near bottom-right (-20% of width), rises 60% of height.
        val baseX = w * 0.85f
        val sway = sin((t * 6.28f) + (heart.horizontalSeed * 6.28f)) * (w * 0.04f)
        val cx = baseX + sway
        val cy = h * 0.95f - (h * 0.6f * t)

        val alpha = if (t > 0.7f) (1f - (t - 0.7f) / 0.3f).coerceIn(0f, 1f) else 1f
        val scale = 0.6f + 0.6f * t
        val r = 22f * scale

        drawHeartShape(cx, cy, r, heart.hue.copy(alpha = alpha * 0.95f))
    }
}

private fun DrawScope.drawHeartShape(cx: Float, cy: Float, radius: Float, color: Color) {
    // Two circles + triangle approximation. Cheap and correct enough for
    // a floating overlay at ~30fps.
    val path = Path().apply {
        moveTo(cx, cy + radius * 0.4f)
        cubicTo(
            cx - radius * 1.4f, cy - radius * 0.3f,
            cx - radius * 0.6f, cy - radius * 1.2f,
            cx, cy - radius * 0.3f
        )
        cubicTo(
            cx + radius * 0.6f, cy - radius * 1.2f,
            cx + radius * 1.4f, cy - radius * 0.3f,
            cx, cy + radius * 0.4f
        )
        close()
    }
    drawPath(path, color = color)
}
