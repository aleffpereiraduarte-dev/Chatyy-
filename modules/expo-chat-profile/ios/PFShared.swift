import UIKit

// [2026-10-15 native-profile] Helpers compartilhados: conversão de props, tema,
// ícones (SF Symbols), avatar circular com iniciais.

func pfNum(_ v: Any?) -> Double? {
  if let n = v as? NSNumber { return n.doubleValue }
  if let d = v as? Double { return d }
  if let i = v as? Int { return Double(i) }
  if let s = v as? String { return Double(s) }
  return nil
}

func pfStr(_ v: Any?) -> String {
  if let s = v as? String { return s }
  if let n = v as? NSNumber { return n.stringValue }
  return ""
}

func pfBool(_ v: Any?, _ fb: Bool = false) -> Bool {
  if let b = v as? Bool { return b }
  if let n = v as? NSNumber { return n.boolValue }
  return fb
}

func pfColor(_ v: Any?, _ fallback: UIColor) -> UIColor {
  guard let d = pfNum(v), d.isFinite else { return fallback }
  let u = UInt32(truncatingIfNeeded: Int64(d))
  return UIColor(
    red: CGFloat((u >> 16) & 0xFF) / 255,
    green: CGFloat((u >> 8) & 0xFF) / 255,
    blue: CGFloat(u & 0xFF) / 255,
    alpha: CGFloat((u >> 24) & 0xFF) / 255
  )
}

struct PFImageRef: Equatable {
  let uri: String
  let headers: [String: String]

  static func from(_ v: Any?) -> PFImageRef? {
    guard let d = v as? [String: Any] else { return nil }
    let uri = pfStr(d["uri"])
    if uri.isEmpty { return nil }
    var h: [String: String] = [:]
    if let hd = d["headers"] as? [String: Any] {
      for (k, v) in hd { h[k] = pfStr(v) }
    }
    return PFImageRef(uri: uri, headers: h)
  }
}

struct PFTheme {
  var dark = false
  var background = UIColor(white: 0.94, alpha: 1)
  var surface = UIColor.white
  var card = UIColor(white: 0.96, alpha: 1)
  var cardBorder = UIColor(white: 0, alpha: 0.08)
  var text = UIColor(white: 0.07, alpha: 1)
  var secondary = UIColor(white: 0.43, alpha: 1)
  var tertiary = UIColor(white: 0.6, alpha: 1)
  var accent = UIColor(white: 0.07, alpha: 1)
  var hairline = UIColor(white: 0, alpha: 0.10)
  var destructive = UIColor(red: 0.86, green: 0.15, blue: 0.15, alpha: 1)

  static func from(_ d: [String: Any]) -> PFTheme {
    var t = PFTheme()
    t.dark = pfBool(d["dark"])
    let k = t.dark
    t.background = pfColor(d["background"], k ? .black : UIColor(white: 0.94, alpha: 1))
    t.surface = pfColor(d["surface"], k ? UIColor(white: 0.07, alpha: 1) : .white)
    t.card = pfColor(d["card"], k ? UIColor(white: 0.11, alpha: 1) : UIColor(white: 0.96, alpha: 1))
    t.cardBorder = pfColor(d["cardBorder"], k ? UIColor(white: 1, alpha: 0.08) : UIColor(white: 0, alpha: 0.08))
    t.text = pfColor(d["text"], k ? .white : UIColor(white: 0.07, alpha: 1))
    t.secondary = pfColor(d["secondaryText"], k ? UIColor(white: 0.63, alpha: 1) : UIColor(white: 0.43, alpha: 1))
    t.tertiary = pfColor(d["tertiaryText"], k ? UIColor(white: 0.45, alpha: 1) : UIColor(white: 0.6, alpha: 1))
    t.accent = pfColor(d["accent"], t.text)
    t.hairline = pfColor(d["hairline"], k ? UIColor(white: 1, alpha: 0.10) : UIColor(white: 0, alpha: 0.10))
    t.destructive = pfColor(d["destructive"], UIColor(red: 0.86, green: 0.15, blue: 0.15, alpha: 1))
    return t
  }
}

enum PFIcon {
  static func image(_ key: String, size: CGFloat, weight: UIImage.SymbolWeight = .regular) -> UIImage? {
    let names: [String]
    switch key {
    case "close": names = ["xmark"]
    case "back": names = ["chevron.left"]
    case "message": names = ["message", "bubble.left"]
    case "call": names = ["phone"]
    case "video": names = ["video"]
    case "search": names = ["magnifyingglass"]
    case "mute": names = ["bell"]
    case "unmute": names = ["bell.slash"]
    case "more": names = ["ellipsis"]
    case "camera": names = ["camera.fill", "camera"]
    case "link": names = ["link"]
    case "leave": names = ["rectangle.portrait.and.arrow.right", "arrow.right.square"]
    case "play": names = ["play.fill"]
    case "chevron": names = ["chevron.right"]
    case "file": names = ["doc"]
    case "x": names = ["xmark"]
    default: names = [key]
    }
    let cfg = UIImage.SymbolConfiguration(pointSize: size, weight: weight)
    for n in names {
      if let img = UIImage(systemName: n, withConfiguration: cfg) { return img }
    }
    return nil
  }
}

/// Avatar circular: foto (com headers) ou iniciais sobre cor.
final class PFAvatarView: UIView {
  let imageView = UIImageView()
  let initialsLabel = UILabel()
  private(set) var ref: PFImageRef?
  var onImage: ((UIImage?) -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = true
    initialsLabel.textAlignment = .center
    initialsLabel.textColor = .white
    initialsLabel.adjustsFontSizeToFitWidth = true
    initialsLabel.minimumScaleFactor = 0.5
    addSubview(initialsLabel)
    imageView.contentMode = .scaleAspectFill
    imageView.clipsToBounds = true
    addSubview(imageView)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    layer.cornerRadius = bounds.width / 2
    imageView.frame = bounds
    initialsLabel.frame = bounds.insetBy(dx: bounds.width * 0.12, dy: 0)
    let fs = max(9, bounds.width * 0.38)
    if abs(initialsLabel.font.pointSize - fs) > 0.5 {
      initialsLabel.font = UIFont.systemFont(ofSize: fs, weight: .semibold)
    }
  }

  func configure(ref: PFImageRef?, initials: String, color: UIColor, maxPixel: CGFloat) {
    initialsLabel.text = initials
    backgroundColor = color
    if ref == self.ref && (ref == nil || imageView.image != nil) { return }
    self.ref = ref
    guard let r = ref else {
      imageView.image = nil
      onImage?(nil)
      return
    }
    if let img = PFImageLoader.shared.cached(r.uri, maxPixel: maxPixel) {
      imageView.image = img
      onImage?(img)
      return
    }
    PFImageLoader.shared.load(r.uri, headers: r.headers, maxPixel: maxPixel) { [weak self] img in
      guard let self = self, self.ref == r else { return }
      if let img = img {
        UIView.transition(with: self.imageView, duration: 0.2, options: .transitionCrossDissolve) {
          self.imageView.image = img
        }
      }
      self.onImage?(img)
    }
  }
}

/// Container que só aceita toques nos controles (o resto vai p/ o ScrollView RN embaixo).
final class PFPassthroughView: UIView {
  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    let v = super.hitTest(point, with: event)
    return v === self ? nil : v
  }
}

@inline(__always) func pfLerp(_ a: CGFloat, _ b: CGFloat, _ t: CGFloat) -> CGFloat { a + (b - a) * t }

func pfSmooth(_ e0: CGFloat, _ e1: CGFloat, _ x: CGFloat) -> CGFloat {
  let t = max(0, min(1, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}
