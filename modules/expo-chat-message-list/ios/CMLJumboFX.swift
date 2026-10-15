import UIKit

// [2026-10-15 native-effects] Emoji grande (1–3 emojis sem balão): anima UMA
// vez por mensagem ao aparecer na tela, estilo Telegram — coração "bate"
// (duas batidas), os demais dão um pulo com leve giro. Só transform no
// textView (render server, 120 Hz). Reduzir Movimento → nada.
enum CMLJumboFX {
  private static var played = Set<String>()
  static let animKey = "cml.jumbo"

  /// true na primeira vez que a mensagem `key` aparece (sessão do app).
  static func claim(_ key: String) -> Bool {
    if key.isEmpty || UIAccessibility.isReduceMotionEnabled { return false }
    if played.contains(key) { return false }
    if played.count > 5000 { played.removeAll() }
    played.insert(key)
    return true
  }

  static func isHeart(_ s: String) -> Bool {
    for u in s.unicodeScalars {
      switch u.value {
      case 0x2764, 0x2763, 0x1F493...0x1F49F, 0x1F5A4, 0x1F90D, 0x1F90E, 0x1F9E1, 0x1FA75...0x1FA77: return true
      default: continue
      }
    }
    return false
  }

  static func play(_ v: UIView, text: String) {
    let l = v.layer
    l.removeAnimation(forKey: animKey)
    let heart = isHeart(text)
    let s = CAKeyframeAnimation(keyPath: "transform.scale")
    let r = CAKeyframeAnimation(keyPath: "transform.rotation.z")
    let g = CAAnimationGroup()
    if heart {
      s.values = [0.6, 1.24, 0.95, 1.16, 0.98, 1.0]
      s.keyTimes = [0, 0.2, 0.38, 0.56, 0.78, 1]
      r.values = [0, 0, 0, 0, 0, 0]
      r.keyTimes = s.keyTimes
      g.duration = 1.0
    } else {
      s.values = [0.55, 1.2, 0.93, 1.05, 1.0]
      s.keyTimes = [0, 0.35, 0.6, 0.8, 1]
      r.values = [0, -0.14, 0.1, -0.04, 0]
      r.keyTimes = s.keyTimes
      g.duration = 0.75
    }
    s.duration = g.duration
    r.duration = g.duration
    s.timingFunctions = nil
    g.animations = [s, r]
    g.timingFunction = CAMediaTimingFunction(name: .easeOut)
    g.isRemovedOnCompletion = true
    if #available(iOS 15.0, *) {
      g.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
    }
    l.add(g, forKey: animKey)
  }
}
