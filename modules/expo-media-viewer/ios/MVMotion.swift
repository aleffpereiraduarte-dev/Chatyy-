import UIKit

// [2026-10-16 motion] Chaves de movimento do pacote de mídia (viewer, stories,
// grades). O JS manda os kill switches globalThis.__chatyy_motion_* via
// ChatyyMediaViewer.setMotion({...}); sem chamada = tudo ligado.
// Reduzir Movimento do sistema desliga parallax/hero/cubo/origem (crossfade).
enum MVMotion {
  /// Paginação do viewer com parallax (conteúdo anda ~mais devagar que a página).
  static var parallax = true
  /// Barras do viewer somem com fade + deslize (não só alpha).
  static var chromeSlide = true
  /// Mola com a velocidade do dedo ao soltar o arrasto de fechar.
  static var flingSpring = true
  /// Story abre crescendo do anel do avatar e volta para ele.
  static var storyOrigin = true
  /// Segurar no story = pausa + leve escala.
  static var holdScale = true
  /// Check da seleção nas grades com mola.
  static var gridSpring = true

  static var reduceMotion: Bool { UIAccessibility.isReduceMotionEnabled }

  static func apply(_ flags: [String: Any]) {
    func b(_ k: String, _ cur: Bool) -> Bool { (flags[k] as? Bool) ?? cur }
    parallax = b("parallax", parallax)
    chromeSlide = b("chromeSlide", chromeSlide)
    flingSpring = b("flingSpring", flingSpring)
    storyOrigin = b("storyOrigin", storyOrigin)
    holdScale = b("holdScale", holdScale)
    gridSpring = b("gridSpring", gridSpring)
  }

  /// Velocidade inicial normalizada p/ UIView spring (pt/s ÷ distância restante).
  static func springVelocity(_ v: CGFloat, remaining: CGFloat) -> CGFloat {
    guard flingSpring, abs(remaining) > 1 else { return 0 }
    return max(-12, min(12, v / remaining))
  }
}
