import UIKit

// [2026-10-18 native-apps-grid] Células do painel "Apps" NATIVO (ChatyyAppsGrid).
// Mesmo desenho do components/apps/AppsSheet.js (P&B premium): squircle 60 pt
// com gradiente monocromático + brilho de vidro no topo, glifo SF Symbol de
// traço, badge "99+" em pílula, marcador +/− no modo editar (tremor), rótulo
// 12 pt. Cartão da Bia (orb com gradiente radial "respirando" + atalho de voz).
// Contrato do Android: APViews.kt.

struct APItem {
  let id: String
  let title: String
  let norm: String
  let sf: String
  let featured: Bool

  init(_ d: [String: Any]) {
    id = CLVal.str(d["id"])
    title = CLVal.str(d["t"])
    let n = CLVal.str(d["n"])
    norm = n.isEmpty ? APText.norm(CLVal.str(d["t"])) : APText.norm(n)
    sf = CLVal.str(d["sf"])
    featured = CLVal.bool(d["feat"])
  }
}

struct APSection {
  let key: String
  let title: String
  let norm: String
  let items: [APItem]

  init(_ d: [String: Any]) {
    key = CLVal.str(d["key"])
    title = CLVal.str(d["title"])
    norm = APText.norm(CLVal.str(d["title"]))
    var out: [APItem] = []
    var seen = Set<String>()
    for raw in (d["items"] as? [Any]) ?? [] {
      guard let m = raw as? [String: Any] else { continue }
      let it = APItem(m)
      if it.id.isEmpty || seen.contains(it.id) { continue }
      seen.insert(it.id)
      out.append(it)
    }
    items = out
  }
}

enum APText {
  /// Sem acento/caixa ("Vídeo" ≈ "video") — igual ao _norm do JS.
  static func norm(_ s: String) -> String {
    return s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil).lowercased()
  }

  static func badge(_ n: Int) -> String {
    return n > 99 ? "99+" : String(n)
  }

  /// Glifo padrão por app (o JS pode mandar `sf` próprio).
  static func symbol(for id: String, override: String) -> String {
    if !override.isEmpty { return override }
    switch id {
    case "email": return "envelope"
    case "meet": return "video"
    case "channels": return "megaphone"
    case "communities": return "person.3"
    case "reels": return "play.rectangle"
    case "feed": return "square.grid.2x2"
    case "live": return "dot.radiowaves.left.and.right"
    case "snapmap": return "mappin.and.ellipse"
    case "one": return "circle.fill"
    case "calendar": return "calendar"
    case "contacts": return "person.2"
    case "files": return "folder"
    case "docs": return "doc.text"
    case "notes": return "note.text"
    case "tasks": return "checkmark.circle"
    case "photos": return "photo"
    case "profile": return "person.crop.circle"
    case "wallet": return "creditcard"
    case "notifications": return "bell"
    case "backup": return "lock.shield"
    case "settings": return "gearshape"
    default: return "square.grid.2x2"
    }
  }

  static func image(_ name: String, pointSize: CGFloat, weight: UIImage.SymbolWeight, color: UIColor) -> UIImage? {
    let cfg = UIImage.SymbolConfiguration(pointSize: pointSize, weight: weight)
    let img = UIImage(systemName: name, withConfiguration: cfg) ?? UIImage(systemName: "square.grid.2x2", withConfiguration: cfg)
    return img?.withTintColor(color, renderingMode: .alwaysOriginal)
  }
}

/// Paleta P&B — espelha as cores do AppsSheet.js (preto verdadeiro no escuro).
struct APTheme {
  let dark: Bool
  let bg: UIColor
  let text: UIColor
  let muted: UIColor
  let fieldBg: UIColor
  let tileTop: UIColor
  let tileMid: UIColor
  let tileBot: UIColor
  let tileBorder: UIColor
  let gloss: UIColor
  let glyph: UIColor
  let badgeBg: UIColor
  let badgeFg: UIColor
  let ring: UIColor
  let markOff: UIColor
  let markOffFg: UIColor
  let cardBg: UIColor

  init(dark: Bool) {
    self.dark = dark
    if dark {
      bg = .black
      text = UIColor(clHex: 0xF5F5F7)
      muted = UIColor(clHex: 0x8E8E93)
      fieldBg = UIColor(clHex: 0x1C1C1E)
      tileTop = UIColor(clHex: 0x2E2E32)
      tileMid = UIColor(clHex: 0x1E1E21)
      tileBot = UIColor(clHex: 0x141416)
      tileBorder = UIColor(white: 1, alpha: 0.09)
      gloss = UIColor(white: 1, alpha: 0.07)
      glyph = UIColor(clHex: 0xF5F5F7)
      badgeBg = .white
      badgeFg = .black
      ring = .black
      markOff = UIColor(clHex: 0x3A3A3E)
      markOffFg = .white
      cardBg = UIColor(clHex: 0x141416)
    } else {
      bg = .white
      text = UIColor(clHex: 0x111111)
      muted = UIColor(clHex: 0x86868B)
      fieldBg = UIColor(clHex: 0xF0F0F2)
      tileTop = .white
      tileMid = UIColor(clHex: 0xF7F7F9)
      tileBot = UIColor(clHex: 0xECEDF0)
      tileBorder = UIColor(white: 0, alpha: 0.06)
      gloss = UIColor(white: 1, alpha: 0.7)
      glyph = UIColor(clHex: 0x111111)
      badgeBg = UIColor(clHex: 0x0B0B0C)
      badgeFg = .white
      ring = .white
      markOff = UIColor(clHex: 0xD9DADF)
      markOffFg = UIColor(clHex: 0x111111)
      cardBg = UIColor(clHex: 0x0E0E10)
    }
  }
}

// MARK: - Ladrilho (app)

final class APTileCell: UICollectionViewCell {
  // [2026-10-18 apps-compact] 60 → 48 pt (estilo Outlook: grade enxuta).
  static let tile: CGFloat = 48
  static let radius: CGFloat = 14

  private let iconBox = UIView()
  private let fill = CAGradientLayer()
  private let glossLayer = CAGradientLayer()
  private let glyph = UIImageView()
  private let badge = UIView()
  private let badgeLabel = UILabel()
  private let mark = UIView()
  private let markGlyph = UIImageView()
  private let label = UILabel()
  private(set) var itemKey = ""
  private var singleLine = false
  private var jiggling = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = false
    contentView.clipsToBounds = false

    iconBox.isUserInteractionEnabled = false
    iconBox.layer.cornerRadius = APTileCell.radius
    iconBox.layer.cornerCurve = .continuous
    iconBox.layer.borderWidth = 1.0 / UIScreen.main.scale
    fill.cornerRadius = APTileCell.radius
    fill.cornerCurve = .continuous
    fill.locations = [0, 0.55, 1]
    fill.startPoint = CGPoint(x: 0.5, y: 0)
    fill.endPoint = CGPoint(x: 0.5, y: 1)
    iconBox.layer.addSublayer(fill)
    glossLayer.cornerRadius = APTileCell.radius - 1
    glossLayer.cornerCurve = .continuous
    glossLayer.startPoint = CGPoint(x: 0.5, y: 0)
    glossLayer.endPoint = CGPoint(x: 0.5, y: 1)
    iconBox.layer.addSublayer(glossLayer)
    glyph.contentMode = .center
    iconBox.addSubview(glyph)
    contentView.addSubview(iconBox)

    badge.isUserInteractionEnabled = false
    badge.layer.borderWidth = 1.5
    badge.layer.cornerRadius = 9
    badge.clipsToBounds = true
    badgeLabel.font = UIFont.monospacedDigitSystemFont(ofSize: 10, weight: .bold)
    badgeLabel.textAlignment = .center
    badge.addSubview(badgeLabel)
    contentView.addSubview(badge)

    mark.isUserInteractionEnabled = false
    mark.layer.borderWidth = 2
    mark.layer.cornerRadius = 12
    mark.clipsToBounds = true
    markGlyph.contentMode = .center
    mark.addSubview(markGlyph)
    contentView.addSubview(mark)

    label.textAlignment = .center
    label.lineBreakMode = .byTruncatingTail
    label.font = UIFont.systemFont(ofSize: 12, weight: .medium)
    label.adjustsFontForContentSizeCategory = false
    contentView.addSubview(label)

    isAccessibilityElement = true
    accessibilityTraits = .button
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(item: APItem, theme: APTheme, badgeCount: Int, editing: Bool, pinned: Bool,
                 singleLine: Bool, seed: Int, labels: [String: String]) {
    itemKey = item.id
    self.singleLine = singleLine
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    fill.colors = [theme.tileTop.cgColor, theme.tileMid.cgColor, theme.tileBot.cgColor]
    glossLayer.colors = [theme.gloss.cgColor, theme.gloss.withAlphaComponent(0).cgColor]
    CATransaction.commit()
    iconBox.layer.borderColor = theme.tileBorder.cgColor
    if theme.dark {
      iconBox.layer.shadowOpacity = 0
    } else {
      iconBox.layer.shadowColor = UIColor.black.cgColor
      iconBox.layer.shadowOpacity = 0.07
      iconBox.layer.shadowRadius = 6
      iconBox.layer.shadowOffset = CGSize(width: 0, height: 2)
    }
    // [2026-10-18 bia-orb-icon] Bia ("one") = orb, não o SF "sparkles".
    glyph.image = item.id == "one"
      ? BiaOrbArt.image(diameter: 26, dark: theme.dark)
      : APText.image(APText.symbol(for: item.id, override: item.sf), pointSize: 20, weight: .regular, color: theme.glyph)

    let showBadge = badgeCount > 0 && !editing
    badge.isHidden = !showBadge
    if showBadge {
      badge.backgroundColor = theme.badgeBg
      badge.layer.borderColor = theme.ring.cgColor
      badgeLabel.textColor = theme.badgeFg
      badgeLabel.text = APText.badge(badgeCount)
    }

    mark.isHidden = !editing
    if editing {
      mark.backgroundColor = pinned ? theme.badgeBg : theme.markOff
      mark.layer.borderColor = theme.ring.cgColor
      markGlyph.image = APText.image(pinned ? "minus" : "plus", pointSize: 11, weight: .bold,
                                     color: pinned ? theme.badgeFg : theme.markOffFg)
    }

    label.textColor = theme.text
    label.numberOfLines = singleLine ? 1 : 2
    label.text = item.title

    var a11y = item.title
    if showBadge {
      let tpl = labels["badgeNew"] ?? ""
      a11y += ", " + (tpl.isEmpty ? APText.badge(badgeCount) : tpl.replacingOccurrences(of: "{count}", with: APText.badge(badgeCount)))
    }
    if editing {
      let l = pinned ? (labels["unpin"] ?? "") : (labels["pin"] ?? "")
      if !l.isEmpty { a11y += ", " + l }
    }
    accessibilityLabel = a11y
    setJiggle(editing && !UIAccessibility.isReduceMotionEnabled, seed: seed)
    setNeedsLayout()
  }

  private func setJiggle(_ on: Bool, seed: Int) {
    if on {
      if jiggling && iconBox.layer.animation(forKey: "ap.jiggle") != nil { return }
      jiggling = true
      let a = CAKeyframeAnimation(keyPath: "transform.rotation.z")
      let r = CGFloat.pi / 180 * 1.6
      a.values = [-r, r, -r]
      a.keyTimes = [0, 0.5, 1]
      a.duration = 0.26 + Double(seed % 3) * 0.02
      a.repeatCount = .infinity
      a.timeOffset = Double(seed % 5) * 0.05
      a.isRemovedOnCompletion = false
      iconBox.layer.add(a, forKey: "ap.jiggle")
      mark.layer.add(a, forKey: "ap.jiggle")
      badge.layer.add(a, forKey: "ap.jiggle")
    } else {
      if !jiggling { return }
      jiggling = false
      iconBox.layer.removeAnimation(forKey: "ap.jiggle")
      mark.layer.removeAnimation(forKey: "ap.jiggle")
      badge.layer.removeAnimation(forKey: "ap.jiggle")
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = contentView.bounds
    let s = APTileCell.tile
    let x = floor((b.width - s) / 2)
    let y: CGFloat = 6
    iconBox.frame = CGRect(x: x, y: y, width: s, height: s)
    iconBox.layer.shadowPath = UIBezierPath(roundedRect: iconBox.bounds, cornerRadius: APTileCell.radius).cgPath
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    fill.frame = iconBox.bounds
    glossLayer.frame = CGRect(x: 1, y: 1, width: s - 2, height: s * 0.55)
    CATransaction.commit()
    glyph.frame = iconBox.bounds

    badgeLabel.sizeToFit()
    let bw = max(18, ceil(badgeLabel.bounds.width) + 10)
    badge.frame = CGRect(x: x + s - bw + 8, y: y - 5, width: bw, height: 18)
    badgeLabel.frame = badge.bounds
    mark.frame = CGRect(x: x - 7, y: y - 7, width: 24, height: 24)
    markGlyph.frame = mark.bounds

    let lh: CGFloat = singleLine ? 16 : 30
    label.frame = CGRect(x: 2, y: y + s + 6, width: b.width - 4, height: lh)
    if !singleLine {
      // Rótulo de 1 linha encosta no topo (sem centralizar verticalmente as 2 linhas).
      let fit = label.sizeThatFits(CGSize(width: b.width - 4, height: lh))
      label.frame.size.height = min(lh, ceil(fit.height))
    }
  }

  override var isHighlighted: Bool {
    didSet {
      let down = isHighlighted
      UIView.animate(withDuration: down ? 0.14 : 0.42, delay: 0,
                     usingSpringWithDamping: down ? 1 : 0.55, initialSpringVelocity: down ? 0 : 0.6,
                     options: [.allowUserInteraction, .beginFromCurrentState], animations: {
        self.contentView.transform = down ? CGAffineTransform(scaleX: 0.92, y: 0.92) : .identity
      }, completion: nil)
    }
  }

  /// Levantar (arrastar p/ reordenar).
  func setLifted(_ on: Bool) {
    UIView.animate(withDuration: 0.2, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
      self.contentView.transform = on ? CGAffineTransform(scaleX: 1.12, y: 1.12) : .identity
      self.contentView.alpha = on ? 0.92 : 1
    }, completion: nil)
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    contentView.layer.removeAllAnimations()
    contentView.transform = .identity
    contentView.alpha = 1
    jiggling = false
    iconBox.layer.removeAnimation(forKey: "ap.jiggle")
    mark.layer.removeAnimation(forKey: "ap.jiggle")
    badge.layer.removeAnimation(forKey: "ap.jiggle")
  }
}

// MARK: - Cabeçalho de seção

final class APHeaderView: UICollectionReusableView {
  let label = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    label.font = UIFont.systemFont(ofSize: 12, weight: .semibold)
    addSubview(label)
    accessibilityTraits = .header
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ title: String, theme: APTheme) {
    let up = title.uppercased()
    label.attributedText = NSAttributedString(string: up, attributes: [
      .kern: 0.9,
      .foregroundColor: theme.muted,
      .font: UIFont.systemFont(ofSize: 12, weight: .semibold),
    ])
    isAccessibilityElement = true
    accessibilityLabel = title
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    label.frame = CGRect(x: 6, y: 0, width: bounds.width - 12, height: bounds.height - 6)
  }
}

// MARK: - Orb da Bia (gradiente radial que "respira")

final class APOrbView: UIView {
  private let core = CAGradientLayer()
  private let halo = CAGradientLayer()

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    halo.type = .radial
    halo.colors = [UIColor(white: 1, alpha: 0.22).cgColor, UIColor(white: 1, alpha: 0).cgColor]
    halo.startPoint = CGPoint(x: 0.5, y: 0.5)
    halo.endPoint = CGPoint(x: 1, y: 1)
    layer.addSublayer(halo)
    core.type = .radial
    core.colors = [UIColor.white.cgColor, UIColor(clHex: 0xB8B8BE).cgColor, UIColor(clHex: 0x4A4A50).cgColor, UIColor(clHex: 0x1C1C1F).cgColor]
    core.locations = [0, 0.32, 0.72, 1]
    core.startPoint = CGPoint(x: 0.36, y: 0.3)
    core.endPoint = CGPoint(x: 1.05, y: 1.05)
    core.masksToBounds = true
    layer.addSublayer(core)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    halo.frame = bounds.insetBy(dx: -6, dy: -6)
    let inner = bounds.insetBy(dx: 3, dy: 3)
    core.frame = inner
    core.cornerRadius = inner.width / 2
    CATransaction.commit()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    core.removeAnimation(forKey: "ap.breathe")
    halo.removeAnimation(forKey: "ap.halo")
    if window == nil || UIAccessibility.isReduceMotionEnabled { return }
    let b = CABasicAnimation(keyPath: "transform.scale")
    b.fromValue = 0.94
    b.toValue = 1.04
    b.duration = 2.2
    b.autoreverses = true
    b.repeatCount = .infinity
    b.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    core.add(b, forKey: "ap.breathe")
    let h = CABasicAnimation(keyPath: "opacity")
    h.fromValue = 0.45
    h.toValue = 1
    h.duration = 2.2
    h.autoreverses = true
    h.repeatCount = .infinity
    h.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    halo.add(h, forKey: "ap.halo")
  }
}

// MARK: - Cartão da Bia

final class APBiaCell: UICollectionViewCell {
  private let card = UIView()
  private let orb = APOrbView()
  private let title = UILabel()
  private let aiPill = UIView()
  private let aiLabel = UILabel()
  private let sub = UILabel()
  private let voice = UIButton(type: .custom)
  var onVoice: (() -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    card.layer.cornerRadius = 24
    card.layer.cornerCurve = .continuous
    card.isUserInteractionEnabled = true
    contentView.addSubview(card)
    card.addSubview(orb)
    title.text = "Bia"
    title.font = UIFont.systemFont(ofSize: 17, weight: .bold)
    title.textColor = .white
    card.addSubview(title)
    aiPill.backgroundColor = UIColor(white: 1, alpha: 0.14)
    aiPill.layer.cornerRadius = 6
    aiPill.isUserInteractionEnabled = false
    aiLabel.font = UIFont.systemFont(ofSize: 9.5, weight: .heavy)
    aiLabel.textColor = UIColor(white: 1, alpha: 0.85)
    aiLabel.textAlignment = .center
    aiPill.addSubview(aiLabel)
    card.addSubview(aiPill)
    sub.font = UIFont.systemFont(ofSize: 13.5, weight: .regular)
    sub.lineBreakMode = .byTruncatingTail
    sub.numberOfLines = 1
    card.addSubview(sub)
    voice.backgroundColor = .white
    voice.layer.cornerRadius = 19
    voice.setImage(APText.image("waveform", pointSize: 16, weight: .semibold, color: .black), for: .normal)
    voice.addTarget(self, action: #selector(voiceTap), for: .touchUpInside)
    voice.addTarget(self, action: #selector(voiceDown), for: [.touchDown, .touchDragEnter])
    voice.addTarget(self, action: #selector(voiceUp), for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
    card.addSubview(voice)
    isAccessibilityElement = false
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(theme: APTheme, labels: [String: String]) {
    card.backgroundColor = theme.cardBg
    card.layer.borderWidth = theme.dark ? 1.0 / UIScreen.main.scale : 0
    card.layer.borderColor = UIColor(white: 1, alpha: 0.10).cgColor
    if theme.dark {
      card.layer.shadowOpacity = 0
    } else {
      card.layer.shadowColor = UIColor.black.cgColor
      card.layer.shadowOpacity = 0.14
      card.layer.shadowRadius = 12
      card.layer.shadowOffset = CGSize(width: 0, height: 6)
    }
    aiLabel.attributedText = NSAttributedString(string: labels["aiBadge"] ?? "IA", attributes: [
      .kern: 0.6,
      .foregroundColor: UIColor(white: 1, alpha: 0.85),
      .font: UIFont.systemFont(ofSize: 9.5, weight: .heavy),
    ])
    let hello = labels["biaHello"] ?? ""
    let tip = labels["biaTip"] ?? ""
    let s = NSMutableAttributedString(string: hello, attributes: [
      .foregroundColor: UIColor(white: 1, alpha: 0.92),
      .font: UIFont.systemFont(ofSize: 13.5, weight: .semibold),
    ])
    if !tip.isEmpty {
      s.append(NSAttributedString(string: (hello.isEmpty ? "" : " · ") + tip, attributes: [
        .foregroundColor: UIColor(white: 1, alpha: 0.62),
        .font: UIFont.systemFont(ofSize: 13.5, weight: .regular),
      ]))
    }
    sub.attributedText = s
    card.isAccessibilityElement = true
    card.accessibilityTraits = .button
    card.accessibilityLabel = "Bia, \(hello), \(tip)"
    voice.accessibilityLabel = labels["voice"] ?? ""
    setNeedsLayout()
  }

  @objc private func voiceTap() {
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    onVoice?()
  }

  @objc private func voiceDown() {
    UIView.animate(withDuration: 0.12) { self.voice.transform = CGAffineTransform(scaleX: 0.88, y: 0.88) }
  }

  @objc private func voiceUp() {
    UIView.animate(withDuration: 0.35, delay: 0, usingSpringWithDamping: 0.55, initialSpringVelocity: 0.5,
                   options: [.allowUserInteraction, .beginFromCurrentState], animations: {
      self.voice.transform = .identity
    }, completion: nil)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = contentView.bounds
    card.frame = CGRect(x: 0, y: 0, width: b.width, height: b.height)
    card.layer.shadowPath = UIBezierPath(roundedRect: card.bounds, cornerRadius: 24).cgPath
    let h = card.bounds.height
    orb.frame = CGRect(x: 14, y: (h - 50) / 2, width: 50, height: 50)
    voice.frame = CGRect(x: card.bounds.width - 14 - 38, y: (h - 38) / 2, width: 38, height: 38)
    let tx: CGFloat = 14 + 50 + 14
    let tw = max(0, voice.frame.minX - 14 - tx)
    title.sizeToFit()
    let ty = h / 2 - 21
    title.frame = CGRect(x: tx, y: ty, width: min(title.bounds.width, tw), height: 21)
    aiLabel.sizeToFit()
    let pw = ceil(aiLabel.bounds.width) + 12
    aiPill.frame = CGRect(x: title.frame.maxX + 7, y: ty + 3, width: pw, height: 16)
    aiLabel.frame = aiPill.bounds
    sub.frame = CGRect(x: tx, y: ty + 24, width: tw, height: 18)
  }

  override var isHighlighted: Bool {
    didSet {
      let down = isHighlighted
      UIView.animate(withDuration: down ? 0.14 : 0.4, delay: 0,
                     usingSpringWithDamping: down ? 1 : 0.6, initialSpringVelocity: 0.4,
                     options: [.allowUserInteraction, .beginFromCurrentState], animations: {
        self.contentView.transform = down ? CGAffineTransform(scaleX: 0.975, y: 0.975) : .identity
      }, completion: nil)
    }
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    contentView.transform = .identity
    contentView.alpha = 1
  }
}

// MARK: - Sem resultados

final class APEmptyCell: UICollectionViewCell {
  private let circle = UIView()
  private let icon = UIImageView()
  private let label = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    circle.layer.cornerRadius = 30
    circle.isUserInteractionEnabled = false
    icon.contentMode = .center
    circle.addSubview(icon)
    contentView.addSubview(circle)
    label.font = UIFont.systemFont(ofSize: 15)
    label.textAlignment = .center
    label.numberOfLines = 2
    contentView.addSubview(label)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(theme: APTheme, text: String) {
    circle.backgroundColor = theme.fieldBg
    icon.image = APText.image("magnifyingglass", pointSize: 24, weight: .regular, color: theme.muted)
    label.textColor = theme.muted
    label.text = text
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = contentView.bounds
    circle.frame = CGRect(x: (b.width - 60) / 2, y: 36, width: 60, height: 60)
    icon.frame = circle.bounds
    label.frame = CGRect(x: 16, y: 108, width: b.width - 32, height: 40)
  }
}
