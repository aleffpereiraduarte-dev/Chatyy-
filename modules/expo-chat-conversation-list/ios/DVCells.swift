import UIKit

// [2026-10-15 native-drive] Células da lista de ARQUIVOS nativa: cabeçalho de
// seção, linha (lista) e cartão (grade), mais a barra de envio com progresso.
// Ícone por tipo (SF Symbols P&B) ou miniatura (DVThumbLoader, cache em disco),
// selo curto (PDF/XLS…), play por cima de vídeo, check de seleção múltipla,
// favorito/compartilhado, destaque do termo buscado. Layout manual.

enum DVMetrics {
  static let padH: CGFloat = 16
  static let listTile: CGFloat = 44
  static let listH: CGFloat = 66
  static let check: CGFloat = 22
  static let gridPad: CGFloat = 12
  static let gridGap: CGFloat = 10
  static let gridText: CGFloat = 58
  static let thumbPx = 360
}

// MARK: - Ladrilho (miniatura | glifo + selo)

final class DVTileView: UIView {
  private let imageView = UIImageView()
  private let glyphView = UIImageView()
  private let badge = UILabel()
  private let play = UIImageView()
  private var uri = ""
  private var glyphSize: CGFloat = 22

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = true
    imageView.contentMode = .scaleAspectFill
    imageView.clipsToBounds = true
    addSubview(imageView)
    glyphView.contentMode = .center
    addSubview(glyphView)
    badge.textAlignment = .center
    badge.layer.cornerRadius = 3
    badge.clipsToBounds = true
    addSubview(badge)
    play.contentMode = .center
    play.backgroundColor = UIColor(white: 0, alpha: 0.45)
    play.clipsToBounds = true
    addSubview(play)
    isUserInteractionEnabled = false
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  var hasImage: Bool { imageView.image != nil }

  func configure(_ r: DVRow, style s: DVStyle, glyphSize gs: CGFloat, radius: CGFloat) {
    glyphSize = gs
    layer.cornerRadius = radius
    backgroundColor = s.colors.chipBg
    let tint = r.isFolder ? (s.colors.dark ? UIColor(clHex: 0xAEAEB2) : UIColor(clHex: 0x48484A)) : s.colors.sub
    glyphView.image = DVGlyphs.image(DVGlyphs.symbol(r.glyph), size: gs, weight: .regular, color: tint)
    let showBadge = !r.badge.isEmpty && r.thumb.isEmpty
    badge.isHidden = !showBadge
    if showBadge {
      badge.attributedText = NSAttributedString(string: r.badge, attributes: [
        .font: UIFont.systemFont(ofSize: gs >= 30 ? 9 : 7.5, weight: .bold),
        .foregroundColor: s.colors.dark ? UIColor.black : UIColor.white,
        .kern: 0.3,
      ])
      badge.backgroundColor = s.colors.dark ? UIColor(clHex: 0xD1D1D6) : UIColor(clHex: 0x111111)
    }
    play.isHidden = !r.video || r.thumb.isEmpty
    play.image = DVGlyphs.image("play.fill", size: gs >= 30 ? 14 : 9, weight: .semibold, color: .white)

    if r.thumb != uri {
      uri = r.thumb
      imageView.image = nil
    }
    if r.thumb.isEmpty {
      imageView.image = nil
      glyphView.isHidden = false
    } else if let img = DVThumbLoader.shared.cached(r.thumb, px: DVMetrics.thumbPx) {
      imageView.image = img
      glyphView.isHidden = true
    } else {
      glyphView.isHidden = false
      let want = r.thumb
      DVThumbLoader.shared.load(want, px: DVMetrics.thumbPx) { [weak self] img in
        guard let self = self, self.uri == want else { return }
        if let img = img {
          self.imageView.image = img
          self.glyphView.isHidden = true
          self.play.isHidden = !r.video
          self.badge.isHidden = true
          self.imageView.alpha = 0
          UIView.animate(withDuration: 0.18) { self.imageView.alpha = 1 }
        }
      }
    }
    setNeedsLayout()
  }

  func reset() {
    uri = ""
    imageView.image = nil
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = bounds
    imageView.frame = b
    glyphView.frame = b
    if !badge.isHidden {
      let s = badge.sizeThatFits(CGSize(width: b.width, height: 20))
      let w = min(b.width - 4, ceil(s.width) + 6)
      let h = ceil(s.height) + 2
      badge.frame = CGRect(x: (b.width - w) / 2, y: b.height - h - max(3, b.height * 0.08), width: w, height: h)
    }
    let pd: CGFloat = glyphSize >= 30 ? 30 : 20
    play.frame = CGRect(x: (b.width - pd) / 2, y: (b.height - pd) / 2, width: pd, height: pd)
    play.layer.cornerRadius = pd / 2
  }
}

/// Check de seleção (círculo vazio / preenchido com ✓).
enum DVCheck {
  static func image(on: Bool, style s: DVStyle, size: CGFloat) -> UIImage? {
    if on {
      let cfg = UIImage.SymbolConfiguration(pointSize: size, weight: .regular)
      let base = UIImage(systemName: "checkmark.circle.fill", withConfiguration: cfg)
      // Paleta: ✓ na cor do fundo do primário, círculo no primário.
      if #available(iOS 15.0, *) {
        let pal = UIImage.SymbolConfiguration(paletteColors: [s.colors.onPrimary, s.colors.primary])
        return base?.applyingSymbolConfiguration(pal)
      }
      return base?.withTintColor(s.colors.primary, renderingMode: .alwaysOriginal)
    }
    return DVGlyphs.image("circle", size: size, weight: .light, color: s.colors.faint)
  }
}

// MARK: - Seção

final class DVSectionCell: UICollectionViewListCell {
  private let label = UILabel()
  private var bg: UIColor = .white

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.addSubview(label)
    label.accessibilityTraits = .header
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  static func height(traits: UITraitCollection?) -> CGFloat {
    return ceil(CTFonts.font(13, 600, traits: traits).lineHeight) + 22
  }

  func configure(_ r: DVRow, style s: DVStyle) {
    label.attributedText = NSAttributedString(string: r.title, attributes: [
      .font: CTFonts.font(13, 600, traits: traitCollection), .foregroundColor: s.colors.sub,
    ])
    bg = s.colors.bg
    setNeedsUpdateConfiguration()
    setNeedsLayout()
  }

  override func updateConfiguration(using state: UICellConfigurationState) {
    var b = UIBackgroundConfiguration.listPlainCell()
    b.backgroundColor = bg
    backgroundConfiguration = b
  }

  override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
    let attrs = super.preferredLayoutAttributesFitting(layoutAttributes)
    attrs.frame.size.height = DVSectionCell.height(traits: traitCollection)
    return attrs
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = contentView.bounds
    let lh = ceil(label.font?.lineHeight ?? 16)
    label.frame = CGRect(x: DVMetrics.padH, y: b.height - lh - 6, width: max(0, b.width - 2 * DVMetrics.padH), height: lh + 2)
  }
}

// MARK: - Linha (lista)

final class DVListCell: UICollectionViewListCell {
  private let checkView = UIImageView()
  private let tile = DVTileView()
  private let titleLabel = UILabel()
  private let subLabel = UILabel()
  private let warnLabel = UILabel()
  private let starView = UIImageView()
  private let sharedView = UIImageView()
  private let chevronView = UIImageView()
  private let hair = UIView()
  private(set) var row = DVRow()
  private var style = DVStyle()
  private var isSel = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    checkView.contentMode = .center
    contentView.addSubview(checkView)
    contentView.addSubview(tile)
    titleLabel.lineBreakMode = .byTruncatingMiddle
    contentView.addSubview(titleLabel)
    contentView.addSubview(subLabel)
    contentView.addSubview(warnLabel)
    starView.contentMode = .center
    contentView.addSubview(starView)
    sharedView.contentMode = .center
    contentView.addSubview(sharedView)
    chevronView.contentMode = .center
    contentView.addSubview(chevronView)
    contentView.addSubview(hair)
    isAccessibilityElement = true
    accessibilityTraits = .button
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  static func height(_ r: DVRow, traits: UITraitCollection?) -> CGFloat {
    let t = ceil(CTFonts.font(15, 500, traits: traits).lineHeight)
    let s = ceil(CTFonts.font(12.5, 400, traits: traits).lineHeight)
    var h = 12 + t + 2 + s + 12
    if !r.warn.isEmpty { h += ceil(CTFonts.font(11, 600, traits: traits).lineHeight) + 1 }
    return max(DVMetrics.listH, h)
  }

  func configure(_ r: DVRow, style s: DVStyle) {
    row = r
    style = s
    let tc = traitCollection
    isSel = s.selectionMode && s.selected.contains(r.id)
    checkView.isHidden = !(s.selectionMode && r.selectable)
    if !checkView.isHidden { checkView.image = DVCheck.image(on: isSel, style: s, size: DVMetrics.check) }
    tile.configure(r, style: s, glyphSize: 20, radius: 10)

    let tf = CTFonts.font(15, 500, traits: tc)
    let title = NSMutableAttributedString(string: r.title, attributes: [.font: tf, .foregroundColor: s.colors.text])
    if !s.tokens.isEmpty {
      RLHighlight.apply(title, tokens: s.tokens, font: CTFonts.font(15, 700, traits: tc), color: s.colors.text)
    }
    titleLabel.attributedText = title
    subLabel.attributedText = NSAttributedString(string: r.sub, attributes: [
      .font: CTFonts.font(12.5, 400, traits: tc), .foregroundColor: s.colors.faint,
    ])
    subLabel.isHidden = r.sub.isEmpty
    warnLabel.isHidden = r.warn.isEmpty
    if !r.warn.isEmpty {
      warnLabel.attributedText = NSAttributedString(string: r.warn, attributes: [
        .font: CTFonts.font(11, r.warnUrgent ? 700 : 500, traits: tc),
        .foregroundColor: r.warnUrgent ? s.colors.error : s.colors.faint,
      ])
    }
    starView.isHidden = !r.starred
    if r.starred { starView.image = DVGlyphs.image("star.fill", size: 12, weight: .regular, color: s.colors.text) }
    sharedView.isHidden = !r.shared
    if r.shared { sharedView.image = DVGlyphs.image("person.2", size: 12, weight: .regular, color: s.colors.sub) }
    chevronView.isHidden = !(r.chevron && !s.selectionMode)
    if !chevronView.isHidden { chevronView.image = DVGlyphs.image("chevron.right", size: 13, weight: .semibold, color: s.colors.faint) }
    hair.backgroundColor = s.colors.hair

    accessibilityLabel = r.a11y.isEmpty ? [r.title, r.sub].filter { !$0.isEmpty }.joined(separator: ", ") : r.a11y
    accessibilityTraits = isSel ? [.button, .selected] : .button
    setNeedsUpdateConfiguration()
    setNeedsLayout()
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    tile.reset()
  }

  override func updateConfiguration(using state: UICellConfigurationState) {
    var bg = UIBackgroundConfiguration.listPlainCell()
    let base = isSel ? CTColor.blend(style.selBg, over: style.colors.bg) : style.colors.bg
    if state.isHighlighted || state.isSwiped {
      bg.backgroundColor = CTColor.blend(style.colors.press, over: base)
    } else {
      bg.backgroundColor = base
    }
    backgroundConfiguration = bg
  }

  override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
    let attrs = super.preferredLayoutAttributesFitting(layoutAttributes)
    attrs.frame.size.height = DVListCell.height(row, traits: traitCollection)
    return attrs
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = contentView.bounds
    var x = DVMetrics.padH
    if !checkView.isHidden {
      checkView.frame = CGRect(x: x - 2, y: (b.height - 28) / 2, width: 28, height: 28)
      x += 26 + 10
    }
    let ts = DVMetrics.listTile
    tile.frame = CGRect(x: x, y: (b.height - ts) / 2, width: ts, height: ts)
    x += ts + 12
    var right = b.width - DVMetrics.padH
    if !chevronView.isHidden {
      chevronView.frame = CGRect(x: right - 12, y: (b.height - 20) / 2, width: 12, height: 20)
      right -= 12 + 8
    }
    let tlh = ceil(titleLabel.font?.lineHeight ?? CTFonts.font(15, 500, traits: traitCollection).lineHeight)
    let slh = ceil(CTFonts.font(12.5, 400, traits: traitCollection).lineHeight)
    let wlh = warnLabel.isHidden ? 0 : ceil(CTFonts.font(11, 600, traits: traitCollection).lineHeight) + 1
    let block = tlh + (subLabel.isHidden ? 0 : 2 + slh) + wlh
    var y = (b.height - block) / 2
    titleLabel.frame = CGRect(x: x, y: y, width: max(0, right - x), height: tlh)
    y += tlh + 2
    // Linha do meio: tamanho • data + ícones (favorito / compartilhado).
    var iconsW: CGFloat = 0
    if !starView.isHidden { iconsW += 16 }
    if !sharedView.isHidden { iconsW += 18 }
    if !subLabel.isHidden {
      let sw = min(ceil(subLabel.sizeThatFits(CGSize(width: 1000, height: slh)).width), max(0, right - x - iconsW))
      subLabel.frame = CGRect(x: x, y: y, width: sw, height: slh)
      var ix = x + sw + 4
      if !sharedView.isHidden { sharedView.frame = CGRect(x: ix, y: y, width: 16, height: slh); ix += 18 }
      if !starView.isHidden { starView.frame = CGRect(x: ix, y: y, width: 14, height: slh) }
      y += slh
    } else {
      var ix = x
      if !sharedView.isHidden { sharedView.frame = CGRect(x: ix, y: y, width: 16, height: slh); ix += 18 }
      if !starView.isHidden { starView.frame = CGRect(x: ix, y: y, width: 14, height: slh) }
    }
    if !warnLabel.isHidden {
      warnLabel.frame = CGRect(x: x, y: y + 1, width: max(0, right - x), height: wlh)
    }
    let px = 1 / max(1, traitCollection.displayScale)
    hair.frame = CGRect(x: x, y: b.height - px, width: b.width - x, height: px)
  }
}

// MARK: - Cartão (grade)

final class DVGridCell: UICollectionViewCell {
  private let card = UIView()
  private let tile = DVTileView()
  private let titleLabel = UILabel()
  private let subLabel = UILabel()
  private let checkView = UIImageView()
  private let starView = UIImageView()
  private(set) var row = DVRow()
  private var style = DVStyle()
  private var isSel = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    card.layer.cornerRadius = 14
    card.layer.borderWidth = 1
    card.clipsToBounds = true
    contentView.addSubview(card)
    card.addSubview(tile)
    titleLabel.numberOfLines = 2
    titleLabel.lineBreakMode = .byTruncatingMiddle
    card.addSubview(titleLabel)
    card.addSubview(subLabel)
    checkView.contentMode = .center
    card.addSubview(checkView)
    starView.contentMode = .center
    card.addSubview(starView)
    isAccessibilityElement = true
    accessibilityTraits = .button
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ r: DVRow, style s: DVStyle) {
    row = r
    style = s
    let tc = traitCollection
    isSel = s.selectionMode && s.selected.contains(r.id)
    tile.configure(r, style: s, glyphSize: 34, radius: 0)
    let tf = CTFonts.font(13, 500, traits: tc)
    let title = NSMutableAttributedString(string: r.title, attributes: [.font: tf, .foregroundColor: s.colors.text])
    if !s.tokens.isEmpty {
      RLHighlight.apply(title, tokens: s.tokens, font: CTFonts.font(13, 700, traits: tc), color: s.colors.text)
    }
    titleLabel.attributedText = title
    let meta = r.warn.isEmpty ? r.sub : r.warn
    subLabel.attributedText = NSAttributedString(string: meta, attributes: [
      .font: CTFonts.font(11, r.warnUrgent ? 700 : 400, traits: tc),
      .foregroundColor: (r.warnUrgent && !r.warn.isEmpty) ? s.colors.error : s.colors.faint,
    ])
    checkView.isHidden = !(s.selectionMode && r.selectable)
    if !checkView.isHidden {
      checkView.image = DVCheck.image(on: isSel, style: s, size: 22)
      checkView.backgroundColor = isSel ? .clear : UIColor(white: s.colors.dark ? 0 : 1, alpha: 0.75)
    }
    starView.isHidden = !r.starred
    if r.starred { starView.image = DVGlyphs.image("star.fill", size: 11, weight: .regular, color: s.colors.text) }
    card.backgroundColor = s.card
    card.layer.borderColor = (isSel ? s.colors.primary : s.colors.border).cgColor
    card.layer.borderWidth = isSel ? 2 : 1
    accessibilityLabel = r.a11y.isEmpty ? [r.title, r.sub].filter { !$0.isEmpty }.joined(separator: ", ") : r.a11y
    accessibilityTraits = isSel ? [.button, .selected] : .button
    setNeedsLayout()
  }

  override var isHighlighted: Bool {
    didSet {
      let down = isHighlighted
      UIView.animate(withDuration: down ? 0.08 : 0.18, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
        self.card.transform = down ? CGAffineTransform(scaleX: 0.97, y: 0.97) : .identity
        self.card.alpha = down ? 0.85 : 1
      }
    }
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    tile.reset()
    card.transform = .identity
    card.alpha = 1
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    card.frame = contentView.bounds
    let b = card.bounds
    let tileH = max(0, b.height - DVMetrics.gridText)
    tile.frame = CGRect(x: 0, y: 0, width: b.width, height: tileH)
    let pad: CGFloat = 10
    let tlh = ceil(CTFonts.font(13, 500, traits: traitCollection).lineHeight)
    let ts = titleLabel.sizeThatFits(CGSize(width: b.width - 2 * pad, height: tlh * 2 + 2))
    let th = min(tlh * 2 + 1, ceil(ts.height))
    titleLabel.frame = CGRect(x: pad, y: tileH + 7, width: b.width - 2 * pad - (starView.isHidden ? 0 : 14), height: th)
    let slh = ceil(CTFonts.font(11, 400, traits: traitCollection).lineHeight)
    subLabel.frame = CGRect(x: pad, y: min(b.height - slh - 6, tileH + 7 + th + 2), width: b.width - 2 * pad, height: slh)
    if !starView.isHidden { starView.frame = CGRect(x: b.width - pad - 12, y: tileH + 7, width: 12, height: tlh) }
    checkView.frame = CGRect(x: 8, y: 8, width: 26, height: 26)
    checkView.layer.cornerRadius = 13
  }
}

// MARK: - Barra de envio

/// Cartão fixo no topo da lista: "Enviando…" + até 3 arquivos com barra de
/// progresso (0 = indeterminado, listra correndo). Concluído = barra cheia;
/// erro = vermelho.
final class DVUploadBar: UIView {
  struct Item {
    var id: String
    var name: String
    var progress: CGFloat
    var state: String
  }

  private let titleLabel = UILabel()
  private let countLabel = UILabel()
  private var rows: [(UILabel, UIView, UIView)] = []
  private(set) var items: [Item] = []
  private var style = DVStyle()
  private var labels = DVLabels()
  static let maxRows = 3

  override init(frame: CGRect) {
    super.init(frame: frame)
    layer.cornerRadius = 14
    layer.borderWidth = 1
    clipsToBounds = true
    addSubview(titleLabel)
    countLabel.textAlignment = .right
    addSubview(countLabel)
    for _ in 0..<DVUploadBar.maxRows {
      let name = UILabel()
      name.lineBreakMode = .byTruncatingMiddle
      let track = UIView()
      track.layer.cornerRadius = 1.5
      track.clipsToBounds = true
      let fill = UIView()
      fill.layer.cornerRadius = 1.5
      track.addSubview(fill)
      addSubview(name)
      addSubview(track)
      rows.append((name, track, fill))
    }
    isAccessibilityElement = true
    accessibilityTraits = .updatesFrequently
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  static func parse(_ v: [[String: Any]]?) -> [Item] {
    var out: [Item] = []
    for d in v ?? [] {
      let p = CGFloat(max(0, min(100, CLVal.double(d["progress"]))))
      var st = CLVal.str(d["state"])
      if st.isEmpty { st = "up" }
      out.append(Item(id: CLVal.str(d["id"]), name: CLVal.str(d["name"]), progress: p, state: st))
    }
    return out
  }

  /// Altura desejada (0 = escondida).
  func desiredHeight(traits: UITraitCollection?) -> CGFloat {
    if items.isEmpty { return 0 }
    let n = min(items.count, DVUploadBar.maxRows)
    let th = ceil(CTFonts.font(14, 600, traits: traits).lineHeight)
    let nh = ceil(CTFonts.font(12, 400, traits: traits).lineHeight)
    return 12 + th + CGFloat(n) * (8 + nh + 4 + 3) + 12
  }

  func configure(_ list: [Item], style s: DVStyle, labels l: DVLabels) {
    items = list
    style = s
    labels = l
    let tc = traitCollection
    backgroundColor = s.card
    layer.borderColor = s.colors.border.cgColor
    let done = list.filter { $0.state == "done" }.count
    titleLabel.attributedText = NSAttributedString(string: l.get("uploading", "Enviando..."), attributes: [
      .font: CTFonts.font(14, 600, traits: tc), .foregroundColor: s.colors.text,
    ])
    countLabel.attributedText = NSAttributedString(string: list.count > 1 ? "\(done)/\(list.count)" : "", attributes: [
      .font: UIFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium), .foregroundColor: s.colors.sub,
    ])
    // Mostra primeiro os que ainda estão subindo.
    let visible = Array((list.filter { $0.state == "up" } + list.filter { $0.state != "up" }).prefix(DVUploadBar.maxRows))
    for (i, r) in rows.enumerated() {
      let (name, track, fill) = r
      let has = i < visible.count
      name.isHidden = !has
      track.isHidden = !has
      guard has else { fill.layer.removeAllAnimations(); continue }
      let it = visible[i]
      let color: UIColor = it.state == "error" ? s.colors.error : s.colors.primary
      name.attributedText = NSAttributedString(string: it.name, attributes: [
        .font: CTFonts.font(12, 400, traits: tc), .foregroundColor: it.state == "error" ? s.colors.error : s.colors.sub,
      ])
      track.backgroundColor = s.colors.dark ? UIColor(white: 1, alpha: 0.08) : UIColor(white: 0, alpha: 0.07)
      fill.backgroundColor = color
    }
    accessibilityLabel = "\(l.get("uploading", "Enviando...")) \(done)/\(list.count)"
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = bounds
    let tc = traitCollection
    let th = ceil(CTFonts.font(14, 600, traits: tc).lineHeight)
    let nh = ceil(CTFonts.font(12, 400, traits: tc).lineHeight)
    titleLabel.frame = CGRect(x: 14, y: 12, width: b.width - 28 - 60, height: th)
    countLabel.frame = CGRect(x: b.width - 14 - 60, y: 12, width: 60, height: th)
    var y = 12 + th
    let visible = Array((items.filter { $0.state == "up" } + items.filter { $0.state != "up" }).prefix(DVUploadBar.maxRows))
    for (i, r) in rows.enumerated() where i < visible.count {
      let (name, track, fill) = r
      y += 8
      name.frame = CGRect(x: 14, y: y, width: b.width - 28, height: nh)
      y += nh + 4
      track.frame = CGRect(x: 14, y: y, width: b.width - 28, height: 3)
      y += 3
      let it = visible[i]
      let w = track.bounds.width
      if it.state == "up" && it.progress <= 0 {
        // Indeterminado: listra de 35% correndo da esquerda p/ direita.
        let sw = w * 0.35
        if fill.layer.animation(forKey: "dv.indet") == nil || abs(fill.bounds.width - sw) > 0.5 {
          fill.layer.removeAllAnimations()
          fill.frame = CGRect(x: -sw, y: 0, width: sw, height: 3)
          let a = CABasicAnimation(keyPath: "position.x")
          a.fromValue = -sw / 2
          a.toValue = w + sw / 2
          a.duration = 1.1
          a.repeatCount = .infinity
          a.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
          fill.layer.add(a, forKey: "dv.indet")
        }
      } else {
        fill.layer.removeAnimation(forKey: "dv.indet")
        let p = it.state == "up" ? it.progress / 100 : 1
        let nw = max(3, w * p)
        if abs(fill.frame.width - nw) > 0.5 && fill.frame.width > 0 && window != nil {
          UIView.animate(withDuration: 0.25) { fill.frame = CGRect(x: 0, y: 0, width: nw, height: 3) }
        } else {
          fill.frame = CGRect(x: 0, y: 0, width: nw, height: 3)
        }
      }
    }
  }
}
