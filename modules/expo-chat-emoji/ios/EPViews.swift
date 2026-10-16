import UIKit

// [2026-10-15 native-emoji] Peças visuais do painel: tema, glifos, células,
// campo de busca e balão de tons de pele.

func epNum(_ v: Any?) -> Double? {
  if let n = v as? NSNumber { return n.doubleValue }
  if let d = v as? Double { return d }
  if let i = v as? Int { return Double(i) }
  if let s = v as? String { return Double(s) }
  return nil
}

func epStr(_ v: Any?) -> String {
  if let s = v as? String { return s }
  if let n = v as? NSNumber { return n.stringValue }
  return ""
}

func epBool(_ v: Any?, _ fb: Bool = false) -> Bool {
  if let b = v as? Bool { return b }
  if let n = v as? NSNumber { return n.boolValue }
  return fb
}

/// processColor() do RN = 0xAARRGGBB.
func epColor(_ v: Any?, _ fallback: UIColor) -> UIColor {
  guard let d = epNum(v), d.isFinite else { return fallback }
  let u = UInt32(truncatingIfNeeded: Int64(d))
  return UIColor(
    red: CGFloat((u >> 16) & 0xFF) / 255,
    green: CGFloat((u >> 8) & 0xFF) / 255,
    blue: CGFloat(u & 0xFF) / 255,
    alpha: CGFloat((u >> 24) & 0xFF) / 255
  )
}

struct EPTheme {
  var dark = false
  var background = UIColor.white
  var surface = UIColor(white: 0.94, alpha: 1)
  var text = UIColor(white: 0.07, alpha: 1)
  var secondary = UIColor(white: 0.43, alpha: 1)
  var icon = UIColor(white: 0.43, alpha: 1)
  var iconActive = UIColor(white: 0.07, alpha: 1)
  var accent = UIColor(white: 0.07, alpha: 1)
  var hairline = UIColor(white: 0, alpha: 0.10)
  var selection = UIColor(white: 0, alpha: 0.07)

  static func from(_ d: [String: Any]) -> EPTheme {
    var t = EPTheme()
    t.dark = epBool(d["dark"])
    let darkBase = t.dark
    t.background = epColor(d["background"], darkBase ? UIColor(white: 0.04, alpha: 1) : .white)
    t.surface = epColor(d["surface"], darkBase ? UIColor(white: 0.11, alpha: 1) : UIColor(white: 0.94, alpha: 1))
    t.text = epColor(d["text"], darkBase ? .white : UIColor(white: 0.07, alpha: 1))
    t.secondary = epColor(d["secondaryText"], darkBase ? UIColor(white: 0.63, alpha: 1) : UIColor(white: 0.43, alpha: 1))
    t.icon = epColor(d["icon"], t.secondary)
    t.iconActive = epColor(d["iconActive"], t.text)
    t.accent = epColor(d["accent"], t.text)
    t.hairline = epColor(d["hairline"], darkBase ? UIColor(white: 1, alpha: 0.10) : UIColor(white: 0, alpha: 0.10))
    t.selection = epColor(d["selection"], darkBase ? UIColor(white: 1, alpha: 0.12) : UIColor(white: 0, alpha: 0.07))
    return t
  }
}

enum EPGlyph {
  static func symbol(_ names: [String], size: CGFloat, weight: UIImage.SymbolWeight = .regular) -> UIImage? {
    let cfg = UIImage.SymbolConfiguration(pointSize: size, weight: weight)
    for n in names {
      if let img = UIImage(systemName: n, withConfiguration: cfg) { return img }
    }
    return nil
  }

  /// Figurinha (quadrado arredondado com canto dobrado) — não existe SF Symbol P&B adequado.
  static func sticker(size: CGFloat) -> UIImage {
    let s = CGSize(width: size, height: size)
    let img = UIGraphicsImageRenderer(size: s).image { _ in
      let lw: CGFloat = max(1.4, size / 12)
      let r = CGRect(x: lw, y: lw, width: size - 2 * lw, height: size - 2 * lw)
      let fold = r.width * 0.36
      let p = UIBezierPath()
      let rad = r.width * 0.22
      p.move(to: CGPoint(x: r.minX + rad, y: r.minY))
      p.addLine(to: CGPoint(x: r.maxX - rad, y: r.minY))
      p.addQuadCurve(to: CGPoint(x: r.maxX, y: r.minY + rad), controlPoint: CGPoint(x: r.maxX, y: r.minY))
      p.addLine(to: CGPoint(x: r.maxX, y: r.maxY - fold))
      p.addLine(to: CGPoint(x: r.maxX - fold, y: r.maxY))
      p.addLine(to: CGPoint(x: r.minX + rad, y: r.maxY))
      p.addQuadCurve(to: CGPoint(x: r.minX, y: r.maxY - rad), controlPoint: CGPoint(x: r.minX, y: r.maxY))
      p.addLine(to: CGPoint(x: r.minX, y: r.minY + rad))
      p.addQuadCurve(to: CGPoint(x: r.minX + rad, y: r.minY), controlPoint: CGPoint(x: r.minX, y: r.minY))
      p.close()
      // dobra
      p.move(to: CGPoint(x: r.maxX, y: r.maxY - fold))
      p.addQuadCurve(to: CGPoint(x: r.maxX - fold, y: r.maxY), controlPoint: CGPoint(x: r.maxX - fold, y: r.maxY - fold))
      p.lineWidth = lw
      p.lineJoinStyle = .round
      p.lineCapStyle = .round
      UIColor.black.setStroke()
      p.stroke()
      // sorriso
      let smile = UIBezierPath()
      smile.move(to: CGPoint(x: r.minX + r.width * 0.28, y: r.minY + r.height * 0.56))
      smile.addQuadCurve(to: CGPoint(x: r.minX + r.width * 0.60, y: r.minY + r.height * 0.56), controlPoint: CGPoint(x: r.minX + r.width * 0.44, y: r.minY + r.height * 0.74))
      smile.lineWidth = lw
      smile.lineCapStyle = .round
      smile.stroke()
      UIColor.black.setFill()
      let er = lw * 0.9
      UIBezierPath(ovalIn: CGRect(x: r.minX + r.width * 0.32 - er, y: r.minY + r.height * 0.36 - er, width: er * 2, height: er * 2)).fill()
      UIBezierPath(ovalIn: CGRect(x: r.minX + r.width * 0.58 - er, y: r.minY + r.height * 0.36 - er, width: er * 2, height: er * 2)).fill()
    }
    return img.withRenderingMode(.alwaysTemplate)
  }

  /// "GIF" dentro de um retângulo arredondado.
  static func gif(size: CGFloat) -> UIImage {
    let s = CGSize(width: size * 1.25, height: size)
    let img = UIGraphicsImageRenderer(size: s).image { _ in
      let lw: CGFloat = max(1.4, size / 12)
      let r = CGRect(x: lw / 2 + 0.5, y: size * 0.16, width: s.width - lw - 1, height: size * 0.68)
      let p = UIBezierPath(roundedRect: r, cornerRadius: size * 0.16)
      p.lineWidth = lw
      UIColor.black.setStroke()
      p.stroke()
      let font = UIFont.systemFont(ofSize: size * 0.40, weight: .heavy)
      let str = NSAttributedString(string: "GIF", attributes: [.font: font, .foregroundColor: UIColor.black, .kern: 0.3])
      let ts = str.size()
      str.draw(at: CGPoint(x: r.midX - ts.width / 2, y: r.midY - ts.height / 2))
    }
    return img.withRenderingMode(.alwaysTemplate)
  }
}

final class EPEmojiCell: UICollectionViewCell {
  static let reuse = "EPEmojiCell"
  let label = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    label.textAlignment = .center
    label.adjustsFontSizeToFitWidth = false
    contentView.addSubview(label)
    isAccessibilityElement = true
    accessibilityTraits = .button
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    label.bounds = CGRect(origin: .zero, size: contentView.bounds.size)
    label.center = CGPoint(x: contentView.bounds.midX, y: contentView.bounds.midY)
    let fs = floor(min(bounds.width, bounds.height) * 0.70)
    if label.font.pointSize != fs { label.font = UIFont.systemFont(ofSize: fs) }
  }

  override var isHighlighted: Bool {
    didSet {
      UIView.animate(withDuration: isHighlighted ? 0.08 : 0.22, delay: 0, usingSpringWithDamping: 0.6, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
        self.label.transform = self.isHighlighted ? CGAffineTransform(scaleX: 0.86, y: 0.86) : .identity
      }
    }
  }

  func pop() {
    label.transform = CGAffineTransform(scaleX: 1.28, y: 1.28)
    UIView.animate(withDuration: 0.42, delay: 0, usingSpringWithDamping: 0.45, initialSpringVelocity: 0.6, options: [.allowUserInteraction, .beginFromCurrentState]) {
      self.label.transform = .identity
    }
  }
}

final class EPImageCell: UICollectionViewCell {
  static let reuse = "EPImageCell"
  let imageView = UIImageView()
  let spinner = UIActivityIndicatorView(style: .medium)
  // [2026-10-16 sticker-panel v2] figurinha Lottie (só toca se setPlaying(true))
  let lottieView = EPLottieView()
  private(set) var uri: String = ""
  private(set) var isLottie = false
  private var playing = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    imageView.clipsToBounds = true
    contentView.addSubview(imageView)
    lottieView.isHidden = true
    contentView.addSubview(lottieView)
    spinner.hidesWhenStopped = true
    contentView.addSubview(spinner)
    isAccessibilityElement = true
    accessibilityTraits = .button
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    imageView.bounds = CGRect(origin: .zero, size: contentView.bounds.size)
    imageView.center = CGPoint(x: contentView.bounds.midX, y: contentView.bounds.midY)
    let inset: CGFloat = 4
    lottieView.bounds = CGRect(x: 0, y: 0, width: max(0, contentView.bounds.width - inset * 2), height: max(0, contentView.bounds.height - inset * 2))
    lottieView.center = imageView.center
    spinner.center = CGPoint(x: bounds.midX, y: bounds.midY)
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    uri = ""
    isLottie = false
    playing = false
    imageView.image = nil
    imageView.alpha = 1
    imageView.isHidden = false
    imageView.stopAnimating()
    lottieView.reset()
    lottieView.isHidden = true
    contentView.alpha = 1
    spinner.stopAnimating()
  }

  /// Célula visível + aba ativa → anima; fora da tela → pausa (Lottie e GIF/WebP).
  func setPlaying(_ on: Bool) {
    playing = on
    if isLottie {
      if on { lottieView.play() } else { lottieView.pause() }
      return
    }
    guard imageView.image?.images != nil else { return }
    if on {
      if !imageView.isAnimating { imageView.startAnimating() }
    } else if imageView.isAnimating {
      imageView.stopAnimating()
    }
  }

  /// [2026-10-16 sticker-panel v2] Figurinha Lottie (.json).
  func configureLottie(uri: String) {
    imageView.stopAnimating()
    imageView.image = nil
    imageView.isHidden = true
    imageView.backgroundColor = .clear
    spinner.stopAnimating()
    isLottie = true
    lottieView.isHidden = false
    self.uri = uri
    lottieView.setURI(uri)
    if playing { lottieView.play() }
  }

  override var isHighlighted: Bool {
    didSet {
      UIView.animate(withDuration: isHighlighted ? 0.08 : 0.25, delay: 0, usingSpringWithDamping: 0.6, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
        self.imageView.transform = self.isHighlighted ? CGAffineTransform(scaleX: 0.9, y: 0.9) : .identity
        self.lottieView.transform = self.imageView.transform
      }
    }
  }

  func configure(uri: String, fill: Bool, placeholder: UIColor, corner: CGFloat, maxPixel: CGFloat) {
    if isLottie {
      isLottie = false
      lottieView.reset()
      lottieView.isHidden = true
      self.uri = ""
    }
    imageView.isHidden = false
    imageView.contentMode = fill ? .scaleAspectFill : .scaleAspectFit
    imageView.layer.cornerRadius = corner
    imageView.backgroundColor = fill ? placeholder : .clear
    if uri.isEmpty {
      self.uri = ""
      imageView.image = nil
      spinner.startAnimating()
      return
    }
    spinner.stopAnimating()
    if uri == self.uri && imageView.image != nil { return }
    self.uri = uri
    if let img = EPImageLoader.shared.cached(uri, maxPixel: maxPixel) {
      imageView.alpha = 1
      imageView.image = img
      if img.images != nil { imageView.startAnimating() }
      return
    }
    imageView.image = nil
    imageView.alpha = 0
    EPImageLoader.shared.load(uri, maxPixel: maxPixel) { [weak self] img in
      guard let self = self, self.uri == uri else { return }
      self.imageView.image = img
      if img?.images != nil { self.imageView.startAnimating() }
      UIView.animate(withDuration: 0.18) { self.imageView.alpha = 1 }
    }
  }
}

final class EPHeaderView: UICollectionReusableView {
  static let reuse = "EPHeaderView"
  let label = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    label.font = UIFont.systemFont(ofSize: 12.5, weight: .semibold)
    addSubview(label)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    label.frame = CGRect(x: 12, y: 0, width: bounds.width - 24, height: bounds.height)
  }
}

/// Campo de busca arredondado: lupa + UITextField + limpar.
final class EPSearchField: UIView {
  let field = UITextField()
  let icon = UIImageView()
  let clear = UIButton(type: .system)

  override init(frame: CGRect) {
    super.init(frame: frame)
    layer.cornerRadius = 10
    layer.cornerCurve = .continuous
    icon.image = EPGlyph.symbol(["magnifyingglass"], size: 14, weight: .medium)
    icon.contentMode = .center
    addSubview(icon)
    field.font = UIFont.systemFont(ofSize: 16)
    field.autocorrectionType = .no
    field.autocapitalizationType = .none
    field.spellCheckingType = .no
    field.returnKeyType = .search
    field.clearButtonMode = .never
    addSubview(field)
    clear.setImage(EPGlyph.symbol(["xmark.circle.fill"], size: 15), for: .normal)
    clear.alpha = 0
    addSubview(clear)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    let h = bounds.height
    icon.frame = CGRect(x: 6, y: 0, width: 26, height: h)
    clear.frame = CGRect(x: bounds.width - 34, y: 0, width: 34, height: h)
    field.frame = CGRect(x: 32, y: 0, width: max(0, bounds.width - 32 - 34), height: h)
  }

  func apply(_ t: EPTheme, placeholder: String) {
    backgroundColor = t.surface
    icon.tintColor = t.secondary
    clear.tintColor = t.secondary
    field.textColor = t.text
    field.tintColor = t.accent
    field.keyboardAppearance = t.dark ? .dark : .light
    field.attributedPlaceholder = NSAttributedString(string: placeholder, attributes: [.foregroundColor: t.secondary])
  }

  func setClearVisible(_ v: Bool) {
    UIView.animate(withDuration: 0.15) { self.clear.alpha = v ? 1 : 0 }
  }
}

/// Balão de tons de pele (6 opções) — vive na window p/ não ser cortado.
final class EPTonePopover: UIView {
  private var labels: [UILabel] = []
  private let highlight = UIView()
  private(set) var options: [String] = []
  private(set) var selected: Int = -1
  private let cellW: CGFloat = 44
  private let pad: CGFloat = 6

  init(options: [String], theme: EPTheme, current: Int) {
    self.options = options
    super.init(frame: .zero)
    backgroundColor = theme.dark ? UIColor(white: 0.16, alpha: 1) : .white
    layer.cornerRadius = 14
    layer.cornerCurve = .continuous
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = theme.dark ? 0.5 : 0.18
    layer.shadowRadius = 14
    layer.shadowOffset = CGSize(width: 0, height: 6)
    highlight.backgroundColor = theme.selection
    highlight.layer.cornerRadius = 10
    highlight.layer.cornerCurve = .continuous
    highlight.alpha = 0
    addSubview(highlight)
    for (i, o) in options.enumerated() {
      let l = UILabel()
      l.text = o
      l.textAlignment = .center
      l.font = UIFont.systemFont(ofSize: 30)
      l.frame = CGRect(x: pad + CGFloat(i) * cellW, y: pad, width: cellW, height: cellW)
      addSubview(l)
      labels.append(l)
    }
    frame.size = CGSize(width: pad * 2 + CGFloat(options.count) * cellW, height: pad * 2 + cellW)
    setSelected(current, animated: false)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func index(at p: CGPoint) -> Int {
    let x = p.x - pad
    if x < -12 || x > CGFloat(options.count) * cellW + 12 { return selected }
    return max(0, min(options.count - 1, Int(x / cellW)))
  }

  func setSelected(_ i: Int, animated: Bool) {
    guard i != selected else { return }
    selected = i
    let f = CGRect(x: pad + CGFloat(max(0, i)) * cellW, y: pad, width: cellW, height: cellW)
    let apply = {
      self.highlight.frame = f
      self.highlight.alpha = i >= 0 ? 1 : 0
      for (j, l) in self.labels.enumerated() {
        l.transform = j == i ? CGAffineTransform(scaleX: 1.18, y: 1.18).translatedBy(x: 0, y: -3) : .identity
      }
    }
    if animated {
      UIView.animate(withDuration: 0.28, delay: 0, usingSpringWithDamping: 0.7, initialSpringVelocity: 0, options: [.beginFromCurrentState], animations: apply)
    } else {
      apply()
    }
  }
}
