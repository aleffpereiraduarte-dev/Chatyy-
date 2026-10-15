import UIKit

// [2026-10-15 native-contacts] Peças da lista de contatos nativa (iOS):
// cabeçalho de seção (também usado como cabeçalho FIXO sobreposto), célula de
// contato (CLAvatarView + nome/selo/NOVO + e-mail/@ + recado + chip/última
// interação + Convidar/estrela/lixeira/check) e o ÍNDICE A–Z lateral com
// arrasto, balão e haptic (como o app Contatos). Layout manual (sem Auto
// Layout) e altura calculada — rolagem leve em listas grandes.

enum CTFonts {
  static func font(_ size: CGFloat, _ weight: Int, traits: UITraitCollection?, italic: Bool = false) -> UIFont {
    var f = CLFonts.scaled(size, CTColor.weight(weight), cap: 1.35, traits: traits)
    if italic, let d = f.fontDescriptor.withSymbolicTraits(.traitItalic) {
      f = UIFont(descriptor: d, size: f.pointSize)
    }
    return f
  }
}

// MARK: - Cabeçalho de seção

final class CTSectionView: UIView {
  private let bar = UIView()
  private let label = UILabel()
  private let hairline = UIView()
  private(set) var row = CTRow()

  override init(frame: CGRect) {
    super.init(frame: frame)
    bar.layer.cornerRadius = 1.5
    addSubview(bar)
    label.numberOfLines = 1
    label.lineBreakMode = .byTruncatingTail
    addSubview(label)
    addSubview(hairline)
    isAccessibilityElement = true
    accessibilityTraits = .header
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  static func height(_ r: CTRow, traits: UITraitCollection?) -> CGFloat {
    let f = CTFonts.font(r.sSize, r.sWeight, traits: traits)
    return ceil(r.sPadTop + ceil(f.lineHeight) + r.sPadBottom)
  }

  func configure(_ r: CTRow, colors c: CTColors) {
    row = r
    backgroundColor = r.sBg ?? c.bg
    bar.isHidden = !r.sBar
    bar.backgroundColor = c.primary.withAlphaComponent(0.6)
    let f = CTFonts.font(r.sSize, r.sWeight, traits: traitCollection)
    let txt = r.sUpper ? r.title.uppercased() : r.title
    label.attributedText = NSAttributedString(string: txt, attributes: [
      .font: f,
      .foregroundColor: r.sFg ?? c.faint,
      .kern: r.sSpacing,
    ])
    hairline.isHidden = !r.sHair
    hairline.backgroundColor = c.hair
    accessibilityLabel = r.title
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = bounds
    var x = row.sPadH
    if !bar.isHidden {
      bar.frame = CGRect(x: x, y: (b.height - 12) / 2, width: 3, height: 12)
      x += 3 + 8
    }
    label.frame = CGRect(x: x, y: 0, width: max(0, b.width - x - row.sPadH), height: b.height)
    let px = 1 / max(1, window?.screen.scale ?? UIScreen.main.scale)
    hairline.frame = CGRect(x: 0, y: b.height - px, width: b.width, height: px)
  }
}

final class CTSectionCell: UICollectionViewListCell {
  let section = CTSectionView()
  private var row = CTRow()

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.addSubview(section)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ r: CTRow, colors: CTColors) {
    row = r
    section.configure(r, colors: colors)
    var bg = UIBackgroundConfiguration.listPlainCell()
    bg.backgroundColor = r.sBg ?? colors.bg
    backgroundConfiguration = bg
    setNeedsLayout()
  }

  override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
    let attrs = super.preferredLayoutAttributesFitting(layoutAttributes)
    attrs.frame.size.height = CTSectionView.height(row, traits: traitCollection)
    return attrs
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    section.frame = contentView.bounds
  }
}

// MARK: - Célula de contato

final class CTContactCell: UICollectionViewListCell {
  var onAction: ((String, String) -> Void)?   // (id, action)
  var onLongPress: ((String) -> Void)?

  private(set) var row = CTRow()
  private var prevId = ""
  private var prevCheck = 0
  private var colors = CTColors()
  private var metrics = CTMetrics()

  private let avatarRing = UIView()
  private let avatar = CLAvatarView()
  private let glyph = UIImageView()
  private let titleLabel = UILabel()
  private let badge = UIImageView()
  private let newBadge = CLPaddedLabel()
  private let line2 = UILabel()
  private let line3 = UILabel()
  private let chip = CLPaddedLabel()
  private let meta = UILabel()
  private let pill = UIButton(type: .custom)
  private let pillSpinner = UIActivityIndicatorView(style: .medium)
  private let star = UIButton(type: .custom)
  private let trash = UIButton(type: .custom)
  private let check = CLCheckView()
  private let hairline = UIView()
  private lazy var longPress = UILongPressGestureRecognizer(target: self, action: #selector(longPressed(_:)))
  private lazy var pillLong = UILongPressGestureRecognizer(target: self, action: #selector(pillLongPressed(_:)))

  override init(frame: CGRect) {
    super.init(frame: frame)
    let cv = contentView
    avatarRing.isUserInteractionEnabled = false
    avatarRing.layer.borderWidth = 1
    cv.addSubview(avatarRing)
    avatar.isUserInteractionEnabled = false
    cv.addSubview(avatar)
    glyph.contentMode = .center
    glyph.clipsToBounds = true
    cv.addSubview(glyph)
    titleLabel.lineBreakMode = .byTruncatingTail
    cv.addSubview(titleLabel)
    badge.contentMode = .scaleAspectFit
    cv.addSubview(badge)
    newBadge.textAlignment = .center
    newBadge.layer.cornerRadius = 8
    newBadge.clipsToBounds = true
    cv.addSubview(newBadge)
    line2.lineBreakMode = .byTruncatingTail
    cv.addSubview(line2)
    line3.lineBreakMode = .byTruncatingTail
    cv.addSubview(line3)
    chip.layer.cornerRadius = 4
    chip.clipsToBounds = true
    chip.textAlignment = .center
    cv.addSubview(chip)
    cv.addSubview(meta)
    pill.layer.cornerRadius = 14
    pill.addTarget(self, action: #selector(pillTapped), for: .touchUpInside)
    pill.addGestureRecognizer(pillLong)
    pillSpinner.hidesWhenStopped = true
    pill.addSubview(pillSpinner)
    cv.addSubview(pill)
    star.addTarget(self, action: #selector(starTapped), for: .touchUpInside)
    cv.addSubview(star)
    trash.addTarget(self, action: #selector(trashTapped), for: .touchUpInside)
    cv.addSubview(trash)
    cv.addSubview(check)
    hairline.isUserInteractionEnabled = false
    cv.addSubview(hairline)
    longPress.minimumPressDuration = 0.35
    addGestureRecognizer(longPress)
    isAccessibilityElement = true
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  // MARK: Altura

  /// Nome lógico do glifo (JS) → SF Symbol. Vazio/desconhecido = convidar.
  static func glyphSymbol(_ name: String) -> String {
    switch name {
    case "users", "group": return "person.2.fill"
    case "community": return "person.3.fill"
    case "megaphone", "channel": return "megaphone.fill"
    case "link": return "link"
    case "qr": return "qrcode"
    case "share": return "square.and.arrow.up"
    case "mail": return "envelope.fill"
    case "bookmark": return "bookmark.fill"
    default: return "person.badge.plus"
    }
  }

  private static func avatarSide(_ r: CTRow) -> CGFloat {
    if !r.glyph.isEmpty { return 44 }
    return r.avatar + (r.avatarRing ? 6 : 0)
  }

  static func height(_ r: CTRow, metrics m: CTMetrics, traits: UITraitCollection?) -> CGFloat {
    var h = ceil(CTFonts.font(m.nameSize, r.titleWeight, traits: traits).lineHeight)
    if !r.sub.isEmpty || !r.username.isEmpty {
      h += 2 + ceil(CTFonts.font(m.subSize, 400, traits: traits).lineHeight)
    }
    if !r.sub2.isEmpty {
      h += (r.sub2Italic ? 3 : 1) + ceil(CTFonts.font(m.sub2Size, 400, traits: traits).lineHeight)
    }
    if !r.chip.isEmpty || !r.meta.isEmpty {
      h += 3 + ceil(max(CTFonts.font(10, 600, traits: traits).lineHeight + 2, CTFonts.font(m.metaSize, 400, traits: traits).lineHeight))
    }
    let content = max(h, avatarSide(r), r.pill.isEmpty ? 0 : 32)
    return max(m.minH, ceil(content + m.padV * 2))
  }

  override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
    let attrs = super.preferredLayoutAttributesFitting(layoutAttributes)
    attrs.frame.size.height = CTContactCell.height(row, metrics: metrics, traits: traitCollection)
    return attrs
  }

  // MARK: Configuração

  func configure(_ r: CTRow, colors c: CTColors, metrics m: CTMetrics) {
    row = r
    colors = c
    metrics = m
    let tc = traitCollection

    // Avatar / glifo
    if !r.glyph.isEmpty {
      avatar.isHidden = true
      avatarRing.isHidden = true
      glyph.isHidden = false
      glyph.backgroundColor = r.glyphBg ?? UIColor(clHex: 0x111111)
      // [2026-10-15 native-group-create] glifo por nome (atalhos da Nova conversa).
      glyph.image = CLSymbols.image(CTContactCell.glyphSymbol(r.glyph), pointSize: 16, weight: .medium, color: .white)
    } else {
      glyph.isHidden = true
      avatar.isHidden = false
      avatar.boxSize = r.avatar
      avatar.configure(r.avatarRow(), theme: c.theme, rowBackground: c.bg)
      avatarRing.isHidden = !r.avatarRing
      avatarRing.layer.borderColor = c.hair.cgColor
    }

    // Linha 1: nome (+ "(Você)") · selo Chatyy · NOVO
    let nameFont = CTFonts.font(m.nameSize, r.titleWeight, traits: tc)
    let t = NSMutableAttributedString(string: r.title, attributes: [.font: nameFont, .foregroundColor: c.text])
    if !r.suffix.isEmpty {
      t.append(NSAttributedString(string: " " + r.suffix, attributes: [
        .font: CTFonts.font(m.nameSize, 500, traits: tc), .foregroundColor: c.faint,
      ]))
    }
    titleLabel.attributedText = t
    badge.isHidden = !r.verified
    if r.verified {
      badge.image = CLSymbols.image("checkmark.circle.fill", pointSize: 12, weight: .semibold, color: c.primary)
    }
    newBadge.isHidden = r.newBadge.isEmpty
    if !r.newBadge.isEmpty {
      newBadge.attributedText = NSAttributedString(string: r.newBadge, attributes: [
        .font: UIFont.systemFont(ofSize: 9, weight: .heavy), .foregroundColor: c.onPrimary, .kern: 0.5,
      ])
      newBadge.backgroundColor = c.primary
    }

    // Linha 2: e-mail/telefone (+ @usuário)
    let subFont = CTFonts.font(m.subSize, 400, traits: tc)
    line2.isHidden = r.sub.isEmpty && r.username.isEmpty
    if !line2.isHidden {
      let s = NSMutableAttributedString(string: r.sub, attributes: [
        .font: subFont, .foregroundColor: r.subTone == 1 ? c.faint : c.sub,
      ])
      if !r.username.isEmpty {
        s.append(NSAttributedString(string: (r.sub.isEmpty ? "" : "  ") + "@" + r.username, attributes: [
          .font: CTFonts.font(max(1, m.subSize - 1), 600, traits: tc), .foregroundColor: c.text,
        ]))
      }
      line2.attributedText = s
    }

    // Linha 3: recado / visto por último / telefone
    line3.isHidden = r.sub2.isEmpty
    if !r.sub2.isEmpty {
      let col: UIColor = r.sub2Tone == 1 ? c.faint : (r.sub2Tone == 2 ? c.faint.withAlphaComponent(0.6) : c.sub)
      line3.attributedText = NSAttributedString(string: r.sub2, attributes: [
        .font: CTFonts.font(m.sub2Size, 400, traits: tc, italic: r.sub2Italic), .foregroundColor: col,
      ])
    }

    // Linha 4: grupo + última interação
    chip.isHidden = r.chip.isEmpty
    if !r.chip.isEmpty {
      chip.attributedText = NSAttributedString(string: r.chip, attributes: [
        .font: CTFonts.font(10, 600, traits: tc), .foregroundColor: c.chipText,
      ])
      chip.backgroundColor = c.chipBg
    }
    meta.isHidden = r.meta.isEmpty
    if !r.meta.isEmpty {
      meta.attributedText = NSAttributedString(string: r.meta, attributes: [
        .font: CTFonts.font(m.metaSize, 400, traits: tc), .foregroundColor: c.faint,
      ])
    }

    // Convidar
    pill.isHidden = r.pill.isEmpty
    if !r.pill.isEmpty {
      let fg: UIColor = r.pillFilled ? c.onPrimary : c.text
      let font = r.pillFilled ? CTFonts.font(12, 700, traits: tc) : CTFonts.font(13, 600, traits: tc)
      if r.pillBusy {
        pill.setAttributedTitle(nil, for: .normal)
        pill.setImage(nil, for: .normal)
        pillSpinner.color = fg
        pillSpinner.startAnimating()
      } else {
        pillSpinner.stopAnimating()
        pill.setAttributedTitle(NSAttributedString(string: r.pill, attributes: [
          .font: font, .foregroundColor: fg, .kern: r.pillFilled ? 0.2 : 0.1,
        ]), for: .normal)
        pill.setImage(r.pillIcon ? CLSymbols.image("person.badge.plus", pointSize: 11, weight: .semibold, color: fg) : nil, for: .normal)
      }
      pill.isEnabled = !r.pillBusy
      if r.pillFilled {
        pill.backgroundColor = c.primary
        pill.layer.borderWidth = 0
        pill.layer.shadowColor = UIColor.black.cgColor
        pill.layer.shadowOpacity = 0.14
        pill.layer.shadowRadius = 4
        pill.layer.shadowOffset = CGSize(width: 0, height: 1)
      } else {
        pill.backgroundColor = .clear
        pill.layer.borderWidth = 1
        pill.layer.borderColor = c.text.cgColor
        pill.layer.shadowOpacity = 0
      }
      pill.accessibilityLabel = r.pill
    }

    // Estrela / lixeira / check
    star.isHidden = r.star == 0
    if r.star > 0 {
      let on = r.star == 2
      star.setImage(CLSymbols.image(on ? "star.fill" : "star", pointSize: 15, weight: .regular, color: on ? c.warning : c.faint), for: .normal)
      star.alpha = on ? 1 : 0.4
    }
    trash.isHidden = !r.trash
    if r.trash {
      trash.setImage(CLSymbols.image("trash", pointSize: 13, weight: .regular, color: c.faint), for: .normal)
    }
    check.isHidden = r.check == 0
    if r.check > 0 {
      check.onColor = c.primary
      check.tickColor = c.onPrimary
      check.borderTint = c.border
      // [2026-10-15 native-group-create] mesma linha marcada/desmarcada →
      // check anima (mola + traço); célula reciclada para outra linha → seco.
      let animate = prevId == r.id && prevCheck > 0 && prevCheck != r.check && window != nil
      check.setChecked(r.check == 2, animated: animate)
    }
    prevId = r.id
    prevCheck = r.check

    hairline.backgroundColor = c.hair
    longPress.isEnabled = r.longPress
    pillLong.isEnabled = !r.pill.isEmpty
    accessibilityLabel = r.a11y.isEmpty ? [r.title, r.sub].filter { !$0.isEmpty }.joined(separator: ", ") : r.a11y
    accessibilityTraits = r.tap ? .button : .staticText
    var acts: [UIAccessibilityCustomAction] = []
    if !r.pill.isEmpty { acts.append(UIAccessibilityCustomAction(name: r.pill) { [weak self] _ in self?.emit("pill"); return true }) }
    if r.star > 0 { acts.append(UIAccessibilityCustomAction(name: r.a11y.isEmpty ? "★" : r.a11y) { [weak self] _ in self?.emit("star"); return true }) }
    if r.trash, !r.swipe.isEmpty { acts.append(UIAccessibilityCustomAction(name: r.swipe) { [weak self] _ in self?.emit("delete"); return true }) }
    accessibilityCustomActions = acts
    setNeedsUpdateConfiguration()
    setNeedsLayout()
  }

  private func emit(_ action: String) { onAction?(row.id, action) }

  @objc private func pillTapped() {
    UISelectionFeedbackGenerator().selectionChanged()
    emit("pill")
  }

  @objc private func pillLongPressed(_ g: UILongPressGestureRecognizer) {
    guard g.state == .began else { return }
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    emit("pillLong")
  }

  @objc private func starTapped() {
    UISelectionFeedbackGenerator().selectionChanged()
    emit("star")
  }

  @objc private func trashTapped() { emit("delete") }

  @objc private func longPressed(_ g: UILongPressGestureRecognizer) {
    guard g.state == .began, row.longPress else { return }
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    onLongPress?(row.id)
  }

  override func updateConfiguration(using state: UICellConfigurationState) {
    var bg = UIBackgroundConfiguration.listPlainCell()
    if (state.isHighlighted || state.isSwiped) && row.tap {
      bg.backgroundColor = CTColor.blend(colors.press, over: colors.bg)
    } else {
      bg.backgroundColor = colors.bg
    }
    backgroundConfiguration = bg
  }

  // MARK: Layout

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = contentView.bounds
    let m = metrics
    let r = row
    var x = m.padH
    let side = CTContactCell.avatarSide(r)
    let ay = (b.height - side) / 2
    if !glyph.isHidden {
      glyph.frame = CGRect(x: x, y: ay, width: 44, height: 44)
      glyph.layer.cornerRadius = 22
    } else {
      if r.avatarRing {
        avatarRing.frame = CGRect(x: x, y: ay, width: side, height: side)
        avatarRing.layer.cornerRadius = side / 2
        avatar.frame = CGRect(x: x + 3, y: ay + 3, width: r.avatar, height: r.avatar)
      } else {
        avatar.frame = CGRect(x: x, y: ay, width: r.avatar, height: r.avatar)
      }
    }
    x += side + m.gap

    // Lado direito (da borda para dentro)
    var right = b.width - m.padH
    if !check.isHidden {
      // bounds+center (não frame): o check pode estar com transform da animação.
      check.bounds = CGRect(x: 0, y: 0, width: 24, height: 24)
      check.center = CGPoint(x: right - 12, y: b.height / 2)
      right -= 24 + 8
    }
    if !trash.isHidden {
      trash.frame = CGRect(x: right - 26, y: (b.height - 26) / 2, width: 26, height: 26)
      right -= 26
    }
    if !star.isHidden {
      star.frame = CGRect(x: right - 28, y: (b.height - 28) / 2, width: 28, height: 28)
      right -= 28
    }
    if !pill.isHidden {
      var pw: CGFloat
      var ph: CGFloat
      if r.pillBusy {
        pw = r.pillFilled ? 64 : 56
      } else {
        let tw = ceil(pill.attributedTitle(for: .normal)?.size().width ?? 0)
        pw = tw + (r.pillIcon ? 13 + 6 : 0)
        pw += r.pillFilled ? 32 : 24
      }
      ph = r.pillFilled ? 32 : 28
      pw = ceil(pw)
      pill.frame = CGRect(x: right - pw, y: (b.height - ph) / 2, width: pw, height: ph)
      pill.layer.cornerRadius = 14
      pill.imageEdgeInsets = r.pillIcon ? UIEdgeInsets(top: 0, left: -3, bottom: 0, right: 3) : .zero
      pill.titleEdgeInsets = r.pillIcon ? UIEdgeInsets(top: 0, left: 3, bottom: 0, right: -3) : .zero
      pillSpinner.center = CGPoint(x: pw / 2, y: ph / 2)
      right -= pw + 5
    }
    let w = max(0, right - x - 4)

    // Bloco de texto centrado na altura
    let tc = traitCollection
    let nameH = ceil(CTFonts.font(m.nameSize, r.titleWeight, traits: tc).lineHeight)
    let subH = ceil(CTFonts.font(m.subSize, 400, traits: tc).lineHeight)
    let sub2H = ceil(CTFonts.font(m.sub2Size, 400, traits: tc).lineHeight)
    let chipH = ceil(CTFonts.font(10, 600, traits: tc).lineHeight) + 2
    var total = nameH
    if !line2.isHidden { total += 2 + subH }
    if !line3.isHidden { total += (r.sub2Italic ? 3 : 1) + sub2H }
    let hasL4 = !chip.isHidden || !meta.isHidden
    if hasL4 { total += 3 + chipH }
    var y = floor((b.height - total) / 2)

    // Linha 1
    var extras: CGFloat = 0
    var nbW: CGFloat = 0
    if !badge.isHidden { extras += 13 + 6 }
    if !newBadge.isHidden {
      nbW = ceil(newBadge.intrinsicContentSize.width) + 12
      extras += nbW + 6
    }
    let tw = min(ceil(titleLabel.intrinsicContentSize.width), max(0, w - extras))
    titleLabel.frame = CGRect(x: x, y: y, width: tw, height: nameH)
    var bx = x + tw + 6
    if !badge.isHidden {
      badge.frame = CGRect(x: bx, y: y + (nameH - 13) / 2, width: 13, height: 13)
      bx += 13 + 6
    }
    if !newBadge.isHidden {
      newBadge.frame = CGRect(x: bx, y: y + (nameH - 16) / 2, width: nbW, height: 16)
    }
    y += nameH
    if !line2.isHidden {
      y += 2
      line2.frame = CGRect(x: x, y: y, width: w, height: subH)
      y += subH
    }
    if !line3.isHidden {
      y += r.sub2Italic ? 3 : 1
      line3.frame = CGRect(x: x, y: y, width: w, height: sub2H)
      y += sub2H
    }
    if hasL4 {
      y += 3
      var cx = x
      if !chip.isHidden {
        let cw = min(w, ceil(chip.intrinsicContentSize.width) + 12)
        chip.frame = CGRect(x: cx, y: y, width: cw, height: chipH)
        cx += cw + 6
      }
      if !meta.isHidden {
        meta.frame = CGRect(x: cx, y: y, width: max(0, x + w - cx), height: chipH)
      }
    }

    let px = 1 / max(1, window?.screen.scale ?? UIScreen.main.scale)
    hairline.frame = CGRect(x: 0, y: b.height - px, width: b.width, height: px)
  }

  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    if previousTraitCollection?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory {
      configure(row, colors: colors, metrics: metrics)
    }
  }
}

// MARK: - Índice A–Z

final class CTIndexBar: UIView {
  var letters: [String] = [] { didSet { if letters != oldValue { rebuild() } } }
  var color: UIColor = .label { didSet { for l in labels { l.textColor = color } } }
  /// Faixa útil (no próprio sistema de coordenadas) onde as letras ficam centradas.
  var range: (CGFloat, CGFloat) = (0, 0) { didSet { setNeedsLayout() } }
  var onLetter: ((String, CGFloat) -> Void)?
  var onRelease: (() -> Void)?

  private var labels: [UILabel] = []
  private var current = -1
  private let haptic = UISelectionFeedbackGenerator()

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    isAccessibilityElement = true
    accessibilityTraits = .adjustable
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private func rebuild() {
    for l in labels { l.removeFromSuperview() }
    labels = letters.map { s in
      let l = UILabel()
      l.text = s
      l.font = UIFont.systemFont(ofSize: 11, weight: .semibold)
      l.textAlignment = .center
      l.textColor = color
      l.isUserInteractionEnabled = false
      addSubview(l)
      return l
    }
    setNeedsLayout()
  }

  private var slot: CGFloat {
    let avail = range.1 - range.0 - 8
    return min(16, avail / CGFloat(max(1, letters.count)))
  }

  private var startY: CGFloat {
    return range.0 + ((range.1 - range.0) - slot * CGFloat(letters.count)) / 2
  }

  func fits() -> Bool {
    return !letters.isEmpty && (range.1 - range.0) >= CGFloat(letters.count) * 14 + 24
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let s = slot
    let y0 = startY
    for (i, l) in labels.enumerated() {
      l.frame = CGRect(x: 0, y: y0 + s * CGFloat(i), width: bounds.width, height: s)
    }
  }

  private func track(_ y: CGFloat) {
    guard !letters.isEmpty, slot > 0 else { return }
    let i = max(0, min(letters.count - 1, Int((y - startY) / slot)))
    if i != current {
      current = i
      haptic.selectionChanged()
      haptic.prepare()
      onLetter?(letters[i], startY + slot * CGFloat(i) + slot / 2)
    }
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
    haptic.prepare()
    if let t = touches.first { track(t.location(in: self).y) }
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
    if let t = touches.first { track(t.location(in: self).y) }
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
    current = -1
    onRelease?()
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
    current = -1
    onRelease?()
  }

  // VoiceOver: deslizar p/ cima/baixo troca de letra.
  override func accessibilityIncrement() {
    let i = min(letters.count - 1, max(0, current) + 1)
    if i >= 0, i < letters.count { current = i; onLetter?(letters[i], startY + slot * CGFloat(i)) ; onRelease?() }
  }

  override func accessibilityDecrement() {
    let i = max(0, current - 1)
    if i < letters.count { current = i; onLetter?(letters[i], startY + slot * CGFloat(i)); onRelease?() }
  }
}
