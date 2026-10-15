import ExpoModulesCore
import UIKit

// [2026-10-15 native-wallpaper] Papel de parede NATIVO da conversa.
// JS: modules/expo-chat-wallpaper/index.js → <ChatyyWallpaper/> (components/wallpaper/ChatWallpaper.js).
// Contrato (igual no Android):
//   props  colors[] (1–4 hex), baseColor, pattern {key, tile, stroke, items[{d,x,y,s,r}]},
//          patternIntensity (0–1), patternMode 'overlay'|'mask', patternColor, patternScale,
//          imageUri, blur (pt), dim (0–1), motion (paralaxe), animate, autoplay (ms; 0 = off)
//   view fns step() — avança o gradiente uma fase (mensagem chegou/saiu)
//            scrollBy(dy) — acumula rolagem; a cada ~420 pt avança uma fase
public class ChatyyWallpaperModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyWallpaper")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(ChatyyWallpaperView.self) {
      Prop("colors") { (view: ChatyyWallpaperView, v: [String]?) in view.setColors(v ?? []) }
      Prop("baseColor") { (view: ChatyyWallpaperView, v: String?) in view.setBaseColor(v) }
      Prop("pattern") { (view: ChatyyWallpaperView, v: [String: Any]?) in view.setPattern(v) }
      Prop("patternIntensity") { (view: ChatyyWallpaperView, v: Double?) in view.setPatternIntensity(v ?? 0.1) }
      Prop("patternMode") { (view: ChatyyWallpaperView, v: String?) in view.setPatternMode(v) }
      Prop("patternColor") { (view: ChatyyWallpaperView, v: String?) in view.setPatternColor(v) }
      Prop("patternScale") { (view: ChatyyWallpaperView, v: Double?) in view.setPatternScale(v ?? 1) }
      Prop("imageUri") { (view: ChatyyWallpaperView, v: String?) in view.setImageUri(v) }
      Prop("blur") { (view: ChatyyWallpaperView, v: Double?) in view.setBlur(v ?? 0) }
      Prop("dim") { (view: ChatyyWallpaperView, v: Double?) in view.setDim(v ?? 0) }
      Prop("motion") { (view: ChatyyWallpaperView, v: Bool?) in view.setMotion(v ?? false) }
      Prop("animate") { (view: ChatyyWallpaperView, v: Bool?) in view.setAnimate(v ?? true) }
      Prop("autoplay") { (view: ChatyyWallpaperView, v: Double?) in view.setAutoplay(v ?? 0) }

      OnViewDidUpdateProps { (view: ChatyyWallpaperView) in
        view.commitProps()
      }

      AsyncFunction("step") { (view: ChatyyWallpaperView) in
        view.step()
      }.runOnQueue(.main)

      AsyncFunction("scrollBy") { (view: ChatyyWallpaperView, dy: Double) in
        view.scrollBy(CGFloat(dy))
      }.runOnQueue(.main)
    }
  }
}
