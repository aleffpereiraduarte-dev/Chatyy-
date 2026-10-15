package expo.modules.chatyywallpaper

import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * [2026-10-15 native-wallpaper] Papel de parede NATIVO da conversa (Android).
 * Mesmo contrato do iOS (ios/ChatyyWallpaper*.swift):
 *   props  colors[] (1–4 hex), baseColor, pattern {key, tile, stroke, items[{d,x,y,s,r}]},
 *          patternIntensity, patternMode 'overlay'|'mask', patternColor, patternScale,
 *          imageUri, blur (dp), dim (0–1), motion, animate, autoplay (ms)
 *   view fns step(), scrollBy(dy)
 */
class ChatyyWallpaperModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyWallpaper")

    Function("apiVersion") { 1 }

    View(ChatyyWallpaperView::class) {
      Prop("colors") { view: ChatyyWallpaperView, v: List<String>? -> view.setColors(v ?: emptyList()) }
      Prop("baseColor") { view: ChatyyWallpaperView, v: String? -> view.setBaseColor(v) }
      Prop("pattern") { view: ChatyyWallpaperView, v: Map<String, Any?>? -> view.setPattern(v) }
      Prop("patternIntensity") { view: ChatyyWallpaperView, v: Double? -> view.setPatternIntensity(v ?: 0.1) }
      Prop("patternMode") { view: ChatyyWallpaperView, v: String? -> view.setPatternMode(v) }
      Prop("patternColor") { view: ChatyyWallpaperView, v: String? -> view.setPatternColor(v) }
      Prop("patternScale") { view: ChatyyWallpaperView, v: Double? -> view.setPatternScale(v ?: 1.0) }
      Prop("imageUri") { view: ChatyyWallpaperView, v: String? -> view.setImageUri(v) }
      Prop("blur") { view: ChatyyWallpaperView, v: Double? -> view.setBlur(v ?: 0.0) }
      Prop("dim") { view: ChatyyWallpaperView, v: Double? -> view.setDim(v ?: 0.0) }
      Prop("motion") { view: ChatyyWallpaperView, v: Boolean? -> view.setMotion(v ?: false) }
      Prop("animate") { view: ChatyyWallpaperView, v: Boolean? -> view.setAnimate(v ?: true) }
      Prop("autoplay") { view: ChatyyWallpaperView, v: Double? -> view.setAutoplay(v ?: 0.0) }

      OnViewDidUpdateProps { view: ChatyyWallpaperView -> view.commitProps() }

      AsyncFunction("step") { view: ChatyyWallpaperView ->
        view.step()
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("scrollBy") { view: ChatyyWallpaperView, dy: Double ->
        view.scrollBy(dy.toFloat())
      }.runOnQueue(Queues.MAIN)
    }
  }
}
