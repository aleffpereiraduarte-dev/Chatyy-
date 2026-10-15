import UIKit

// [2026-10-15 native-search-notifs] Células da lista de RESULTADOS nativa:
// cabeçalho de seção (caixa alta + ação "Ver todos"/"Limpar"), linha de
// resultado/notificação (avatar | miniatura | glifo + selo de ação, título com
// destaque do termo em NSAttributedString, trecho, hora, miniatura à direita,
// botões inline "Seguir de volta"/"Mensagem", ponto de não lida), linha
// "carregando" e aviso centralizado. Layout manual + altura calculada.

enum RLMetrics {
  static let padH: CGFloat = 16
  static let padV: CGFloat = 11
  static let lead: CGFloat = 44
  static let gap: CGFloat = 12
  static let rthumb: CGFloat = 44
  static let chevron: CGFloat = 14
  static let btnH: CGFloat = 30
}

/// Estilo compartilhado por todas as células (cores + termo + flags da lista).
struct RLStyle {
  var colors = CTColors()
  var unreadBg: UIColor = UIColor(white: 0, alpha: 0.04)
  var tokens: [String] = []
  var separators = false
}

// MARK: - Seção

final class RLSectionCell: UICollectionViewListCell {
  var onAction: ((String) -> Void)?
  private let label = UILabel()
  private let actionBtn = UIButton(type: .system)
  private var row = RLRow()
  private var bg: UIColor = .white

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.addSubview(label)
    actionBtn.addTarget(self, action: #selector(tapped), for: .touchUpInside)
    contentView.addSubview(actionBtn)
    label.accessibilityTraits = .header
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  static func height(traits: UITraitCollection?) -> CGFloat {
    return ceil(CTFonts.font(12, 600, traits: traits).lineHeight) + 22 + 8
  }

  func configure(_ r: RLRow, style s: RLStyle) {
    row = r
    let tc = traitCollection
    label.attributedText = NSAttributedString(string: r.title.uppercased(), attributes: [
      .font: CTFonts.font(12, 600, traits: tc), .foregroundColor: s.colors.sub, .kern: 0.6,
    ])
    actionBtn.isHidden = r.action.isEmpty
    if !r.action.isEmpty {
      actionBtn.setAttributedTitle(NSAttributedString(string: r.action, attributes: [
        .font: CTFonts.font(13, 600, traits: tc), .foregroundColor: s.colors.text,
      ]), for: .normal)
      actionBtn.accessibilityLabel = r.action
    }
    bg = s.colors.bg
    var b = UIBackgroundConfiguration.listPlainCell()
    b.backgroundColor = bg
    backgroundConfiguration = b
    setNeedsLayout()
  }

  @objc private func tapped() {
    UISelectionFeedbackGenerator().selectionChanged()
    onAction?(row.id)
  }

  override func updateConfiguration(using state: UICellConfigurationState) {
    var b = UIBackgroundConfiguration.listPlainCell()
    b.backgroundColor = bg
    backgroundConfiguration = b
  }

  override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
    let attrs = super.preferredLayoutAttributesFitting(layoutAttributes)
    attrs.frame.size.height = RLSectionCell.height(traits: traitCollection)
    return attrs
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = contentView.bounds
    var right = b.width - RLMetrics.padH
    if !actionBtn.isHidden {
      let s = actionBtn.sizeThatFits(CGSize(width: 200, height: 30))
      let w = min(160, ceil(s.width))
      actionBtn.frame = CGRect(x: right - w, y: b.height - 8 - 30 + 2, width: w, height: 30)
      right -= w + 8
    }
    let lh = ceil(label.font?.lineHeight ?? 15)
    label.frame = CGRect(x: RLMetrics.padH, y: b.height - 8 - lh - 4, width: max(0, right - RLMetrics.padH), height: lh + 2)
  }
}

// MARK: - Carregando

final class RLLoadingCell: UICollectionViewListCell {
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let label = UILabel()
  private var bg: UIColor = .white

  override init(frame: CGRect) {
    super.init(frame: frame)
    spinner.hidesWhenStopped = false
    contentView.addSubview(spinner)
    label.textAlignment = .center
    contentView.addSubview(label)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ r: RLRow, style s: RLStyle) {
    spinner.color = s.colors.sub
    spinner.startAnimating()
    label.isHidden = r.title.isEmpty
    label.attributedText = NSAttributedString(string: r.title, attributes: [
      .font: CTFonts.font(13, 400, traits: traitCollection), .foregroundColor: s.colors.sub,
    ])
    bg = s.colors.bg
    var b = UIBackgroundConfiguration.listPlainCell()
    b.backgroundColor = bg
    backgroundConfiguration = b
    setNeedsLayout()
  }

  override func updateConfiguration(using state: UICellConfigurationState) {
    var b = UIBackgroundConfiguration.listPlainCell()
    b.backgroundColor = bg
    backgroundConfiguration = b
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    spinner.startAnimating()
  }

  override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
    let attrs = super.preferredLayoutAttributesFitting(layoutAttributes)
    attrs.frame.size.height = 52
    return attrs
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = contentView.bounds
    if label.isHidden {
      spinner.center = CGPoint(x: b.midX, y: b.midY)
    } else {
      let s = label.sizeThatFits(CGSize(width: b.width - 80, height: 30))
      let total = 20 + 8 + min(s.width, b.width - 80)
      let x0 = (b.width - total) / 2
      spinner.center = CGPoint(x: x0 + 10, y: b.midY)
      label.frame = CGRect(x: x0 + 28, y: (b.height - s.height) / 2, width: min(s.width, b.width - 80), height: s.height)
    }
  }
}

// MARK: - Aviso (vazio / erro / dica)

final class RLNoteCell: UICollectionViewListCell {
  private let circle = UIView()
  private let icon = UIImageView()
  private let label = UILabel()
  private var row = RLRow()
  private var bg: UIColor = .white

  override init(frame: CGRect) {
    super.init(frame: frame)
    circle.isUserInteractionEnabled = false
    contentView.addSubview(circle)
    icon.contentMode = .center
    circle.addSubview(icon)
    label.numberOfLines = 0
    label.textAlignment = .center
    contentView.addSubview(label)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private static func attributed(_ r: RLRow, colors c: CTColors, traits: UITraitCollection?) -> NSAttributedString {
    let p = NSMutableParagraphStyle()
    p.alignment = .center
    p.lineSpacing = 3
    return NSAttributedString(string: r.title, attributes: [
      .font: CTFonts.font(14, 400, traits: traits), .foregroundColor: c.sub, .paragraphStyle: p,
    ])
  }

  static func height(_ r: RLRow, width: CGFloat, colors c: CTColors, traits: UITraitCollection?) -> CGFloat {
    let w = max(40, width - 64)
    let t = attributed(r, colors: c, traits: traits)
    let h = ceil(t.boundingRect(with: CGSize(width: w, height: 400), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).height)
    return (r.glyph.isEmpty ? 40 : 48 + 64 + 14) + h + 32
  }

  func configure(_ r: RLRow, style s: RLStyle) {
    row = r
    circle.isHidden = r.glyph.isEmpty
    if !r.glyph.isEmpty {
      circle.backgroundColor = s.colors.chipBg
      icon.image = RLGlyphs.image(r.glyph, size: 24, weight: .regular, color: s.colors.sub)
    }
    label.attributedText = RLNoteCell.attributed(r, colors: s.colors, traits: traitCollection)
    bg = s.colors.bg
    var b = UIBackgroundConfiguration.listPlainCell()
    b.backgroundColor = bg
    backgroundConfiguration = b
    isAccessibilityElement = true
    accessibilityLabel = r.title
    accessibilityTraits = r.tap ? .button : .staticText
    setNeedsLayout()
  }

  override func updateConfiguration(using state: UICellConfigurationState) {
    var b = UIBackgroundConfiguration.listPlainCell()
    b.backgroundColor = bg
    backgroundConfiguration = b
  }

  override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
    let attrs = super.preferredLayoutAttributesFitting(layoutAttributes)
    let w = layoutAttributes.size.width > 0 ? layoutAttributes.size.width : bounds.width
    attrs.frame.size.height = RLNoteCell.height(row, width: w, colors: CTColors(), traits: traitCollection)
    return attrs
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = contentView.bounds
    var y: CGFloat = r0()
    if !circle.isHidden {
      circle.frame = CGRect(x: (b.width - 64) / 2, y: y, width: 64, height: 64)
      circle.layer.cornerRadius = 32
      icon.frame = circle.bounds
      y += 64 + 14
    }
    let w = max(40, b.width - 64)
    let s = label.sizeThatFits(CGSize(width: w, height: 400))
    label.frame = CGRect(x: (b.width - w) / 2, y: y, width: w, height: ceil(s.height))
  }

  private func r0() -> CGFloat { return circle.isHidden ? 40 : 48 }
}

// MARK: - Linha de resultado / notificação

final class RLRowCell: UICollectionViewListCell {
  var onAction: ((String, String) -> Void)?   // (id, action)

  private(set) var row = RLRow()
  private var style = RLStyle()

  private let avatar = CLAvatarView()
  private let thumb = UIImageView()
  private let glyphBox = UIView()
  private let glyph = UIImageView()
  private let playBadge = UIImageView()
  private let badge = UIView()
  private let badgeIcon = UIImageView()
  private let dot = UIView()
  private let titleLabel = UILabel()
  private let timeLabel = UILabel()
  private let subLabel = UILabel()
  private let rthumb = UIImageView()
  private let chevronView = UIImageView()
  private let b1 = UIButton(type: .custom)
  private let b1Spinner = UIActivityIndicatorView(style: .medium)
  private let b2 = UIButton(type: .custom)
  private let hairline = UIView()
  private var thumbURL = ""
  private var rthumbURL = ""

  override init(frame: CGRect) {
    super.init(frame: frame)
    let cv = contentView
    avatar.isUserInteractionEnabled = false
    avatar.boxSize = RLMetrics.lead
    cv.addSubview(avatar)
    thumb.contentMode = .scaleAspectFill
    thumb.clipsToBounds = true
    thumb.layer.cornerRadius = 8
    cv.addSubview(thumb)
    playBadge.contentMode = .center
    playBadge.backgroundColor = UIColor(white: 0, alpha: 0.55)
    playBadge.layer.cornerRadius = 10
    playBadge.clipsToBounds = true
    cv.addSubview(playBadge)
    glyphBox.isUserInteractionEnabled = false
    cv.addSubview(glyphBox)
    glyph.contentMode = .center
    glyphBox.addSubview(glyph)
    badge.isUserInteractionEnabled = false
    badge.layer.cornerRadius = 10
    badge.layer.borderWidth = 2
    cv.addSubview(badge)
    badgeIcon.contentMode = .center
    badge.addSubview(badgeIcon)
    dot.layer.cornerRadius = 3
    cv.addSubview(dot)
    titleLabel.lineBreakMode = .byTruncatingTail
    cv.addSubview(titleLabel)
    timeLabel.textAlignment = .right
    cv.addSubview(timeLabel)
    subLabel.lineBreakMode = .byTruncatingTail
    cv.addSubview(subLabel)
    rthumb.contentMode = .scaleAspectFill
    rthumb.clipsToBounds = true
    rthumb.layer.cornerRadius = 8
    cv.addSubview(rthumb)
    chevronView.contentMode = .center
    cv.addSubview(chevronView)
    b1.layer.cornerRadius = 8
    b1.addTarget(self, action: #selector(b1Tapped), for: .touchUpInside)
    b1Spinner.hidesWhenStopped = true
    b1.addSubview(b1Spinner)
    cv.addSubview(b1)
    b2.layer.cornerRadius = 8
    b2.layer.borderWidth = 1
    b2.addTarget(self, action: #selector(b2Tapped), for: .touchUpInside)
    cv.addSubview(b2)
    hairline.isUserInteractionEnabled = false
    cv.addSubview(hairline)
    isAccessibilityElement = true
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  // MARK: Texto

  private static func titleText(_ r: RLRow, style s: RLStyle, traits: UITraitCollection?) -> NSAttributedString {
    let c = s.colors
    let font = CTFonts.font(15, r.unread ? 600 : 500, traits: traits)
    let t = NSMutableAttributedString(string: r.title, attributes: [.font: font, .foregroundColor: c.text])
    if r.highlight && !s.tokens.isEmpty {
      RLHighlight.apply(t, tokens: s.tokens, font: CTFonts.font(15, 700, traits: traits), color: c.text)
    }
    // Hora junto do título quando o título quebra linha (estilo Instagram).
    if r.titleLines > 1 && !r.time.isEmpty {
      t.append(NSAttributedString(string: "  · " + r.time, attributes: [
        .font: CTFonts.font(12, 400, traits: traits), .foregroundColor: c.sub,
      ]))
    }
    return t
  }

  private static func subText(_ r: RLRow, style s: RLStyle, traits: UITraitCollection?) -> NSAttributedString {
    let c = s.colors
    let t = NSMutableAttributedString(string: r.sub, attributes: [
      .font: CTFonts.font(13.5, 400, traits: traits), .foregroundColor: c.sub,
    ])
    if r.highlight && !s.tokens.isEmpty {
      RLHighlight.apply(t, tokens: s.tokens, font: CTFonts.font(13.5, 700, traits: traits), color: c.text)
    }
    return t
  }

  private static func textHeight(_ a: NSAttributedString, width: CGFloat, lines: Int) -> CGFloat {
    guard a.length > 0, width > 1 else { return 0 }
    let font = (a.attribute(.font, at: 0, effectiveRange: nil) as? UIFont) ?? UIFont.systemFont(ofSize: 15)
    let full = ceil(a.boundingRect(with: CGSize(width: width, height: 2000), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).height)
    let cap = ceil(font.lineHeight * CGFloat(lines))
    return min(full, cap)
  }

  private static func textWidth(_ r: RLRow, total: CGFloat) -> CGFloat {
    var right = total - RLMetrics.padH
    if !r.rightThumb.isEmpty { right -= RLMetrics.rthumb + 10 }
    if r.chevron { right -= RLMetrics.chevron + 8 }
    let left = RLMetrics.padH + RLMetrics.lead + RLMetrics.gap
    return max(40, right - left)
  }

  private static func timeWidth(_ r: RLRow, traits: UITraitCollection?) -> CGFloat {
    if r.time.isEmpty || r.titleLines > 1 { return 0 }
    let f = CTFonts.font(12, 400, traits: traits)
    return ceil((r.time as NSString).size(withAttributes: [.font: f]).width) + 8
  }

  static func height(_ r: RLRow, width: CGFloat, style s: RLStyle, traits: UITraitCollection?) -> CGFloat {
    let w = textWidth(r, total: width)
    var h = textHeight(titleText(r, style: s, traits: traits), width: w - timeWidth(r, traits: traits), lines: r.titleLines)
    if !r.sub.isEmpty { h += 2 + textHeight(subText(r, style: s, traits: traits), width: w, lines: r.subLines) }
    if r.hasButtons { h += 8 + RLMetrics.btnH }
    let content = max(h, RLMetrics.lead)
    return ceil(content + RLMetrics.padV * 2)
  }

  override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
    let attrs = super.preferredLayoutAttributesFitting(layoutAttributes)
    let w = layoutAttributes.size.width > 0 ? layoutAttributes.size.width : bounds.width
    attrs.frame.size.height = RLRowCell.height(row, width: w, style: style, traits: traitCollection)
    return attrs
  }

  // MARK: Configuração

  func configure(_ r: RLRow, style s: RLStyle, separator: Bool) {
    let prev = row
    row = r
    style = s
    let c = s.colors
    let tc = traitCollection

    // Líder: avatar | miniatura | glifo
    avatar.isHidden = !r.hasTiles
    thumb.isHidden = r.hasTiles || r.thumb.isEmpty
    glyphBox.isHidden = r.hasTiles || !r.thumb.isEmpty
    if r.hasTiles {
      avatar.configure(r.avatarRow(), theme: c.theme, rowBackground: c.bg)
    }
    if !thumb.isHidden {
      thumb.backgroundColor = c.chipBg
      if r.thumb != thumbURL || prev.id != r.id {
        thumbURL = r.thumb
        thumb.image = CLImageLoader.shared.cachedImage(r.thumb)
        if thumb.image == nil {
          let want = r.thumb
          CLImageLoader.shared.load(want, auth: r.thumbAuth) { [weak self] img in
            guard let self = self, self.thumbURL == want else { return }
            self.thumb.image = img
          }
        }
      }
    } else {
      thumbURL = ""
      thumb.image = nil
    }
    playBadge.isHidden = thumb.isHidden || !r.play
    if !playBadge.isHidden {
      playBadge.image = RLGlyphs.image("play", size: 9, weight: .bold, color: .white)
    }
    if !glyphBox.isHidden {
      glyphBox.backgroundColor = c.chipBg
      glyph.image = RLGlyphs.image(r.glyph.isEmpty ? "search" : r.glyph, size: 18, weight: .regular, color: c.text)
    }

    // Selo da ação (curtiu / comentou / seguiu / mencionou) no canto do avatar
    badge.isHidden = r.badge.isEmpty
    if !r.badge.isEmpty {
      badge.backgroundColor = c.text
      badge.layer.borderColor = (r.unread ? CTColor.blend(s.unreadBg, over: c.bg) : c.bg).cgColor
      badgeIcon.image = RLGlyphs.image(r.badge, size: 9, weight: .bold, color: c.bg)
    }

    // Ponto de não lida
    dot.isHidden = !r.unread
    dot.backgroundColor = c.text

    titleLabel.numberOfLines = r.titleLines
    titleLabel.attributedText = RLRowCell.titleText(r, style: s, traits: tc)
    timeLabel.isHidden = r.time.isEmpty || r.titleLines > 1
    if !timeLabel.isHidden {
      timeLabel.attributedText = NSAttributedString(string: r.time, attributes: [
        .font: CLFonts.scaled(12, .regular, cap: 1.3, traits: tc, mono: true), .foregroundColor: c.faint,
      ])
    }
    subLabel.isHidden = r.sub.isEmpty
    subLabel.numberOfLines = r.subLines
    if !r.sub.isEmpty { subLabel.attributedText = RLRowCell.subText(r, style: s, traits: tc) }

    // Miniatura à direita (post curtido/comentado)
    rthumb.isHidden = r.rightThumb.isEmpty
    if !rthumb.isHidden {
      rthumb.backgroundColor = c.chipBg
      if r.rightThumb != rthumbURL {
        rthumbURL = r.rightThumb
        rthumb.image = CLImageLoader.shared.cachedImage(r.rightThumb)
        if rthumb.image == nil {
          let want = r.rightThumb
          CLImageLoader.shared.load(want, auth: false) { [weak self] img in
            guard let self = self, self.rthumbURL == want else { return }
            self.rthumb.image = img
          }
        }
      }
    } else {
      rthumbURL = ""
      rthumb.image = nil
    }

    chevronView.isHidden = !r.chevron
    if r.chevron {
      chevronView.image = CLSymbols.image("chevron.right", pointSize: 12, weight: .semibold, color: c.faint)
    }

    // Botões inline
    b1.isHidden = r.b1.isEmpty
    if !r.b1.isEmpty {
      let fg: UIColor = r.b1Filled ? c.onPrimary : c.text
      if r.b1Busy {
        b1.setAttributedTitle(nil, for: .normal)
        b1Spinner.color = fg
        b1Spinner.startAnimating()
      } else {
        b1Spinner.stopAnimating()
        b1.setAttributedTitle(NSAttributedString(string: r.b1, attributes: [
          .font: CTFonts.font(13, 700, traits: tc), .foregroundColor: fg,
        ]), for: .normal)
      }
      b1.isEnabled = !r.b1Busy
      b1.backgroundColor = r.b1Filled ? c.primary : .clear
      b1.layer.borderWidth = r.b1Filled ? 0 : 1
      b1.layer.borderColor = c.border.cgColor
      b1.accessibilityLabel = r.b1
    }
    b2.isHidden = r.b2.isEmpty
    if !r.b2.isEmpty {
      b2.setAttributedTitle(NSAttributedString(string: r.b2, attributes: [
        .font: CTFonts.font(13, 600, traits: tc), .foregroundColor: c.text,
      ]), for: .normal)
      b2.backgroundColor = .clear
      b2.layer.borderColor = c.border.cgColor
      b2.accessibilityLabel = r.b2
    }

    hairline.isHidden = !separator
    hairline.backgroundColor = c.hair

    // Acessibilidade: a linha inteira é 1 elemento; botões viram ações.
    var label = r.a11y
    if label.isEmpty { label = [r.title, r.sub, r.time].filter { !$0.isEmpty }.joined(separator: ", ") }
    accessibilityLabel = label
    accessibilityTraits = r.tap ? .button : .staticText
    var acts: [UIAccessibilityCustomAction] = []
    if !r.b1.isEmpty { acts.append(UIAccessibilityCustomAction(name: r.b1) { [weak self] _ in self?.emit("b1"); return true }) }
    if !r.b2.isEmpty { acts.append(UIAccessibilityCustomAction(name: r.b2) { [weak self] _ in self?.emit("b2"); return true }) }
    if !r.swipe.isEmpty { acts.append(UIAccessibilityCustomAction(name: r.swipe) { [weak self] _ in self?.emit("delete"); return true }) }
    accessibilityCustomActions = acts
    setNeedsUpdateConfiguration()
    setNeedsLayout()
  }

  private func emit(_ action: String) { onAction?(row.id, action) }

  @objc private func b1Tapped() {
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    emit("b1")
  }

  @objc private func b2Tapped() {
    UISelectionFeedbackGenerator().selectionChanged()
    emit("b2")
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    b1Spinner.stopAnimating()
  }

  override func updateConfiguration(using state: UICellConfigurationState) {
    var bg = UIBackgroundConfiguration.listPlainCell()
    let base = row.unread ? CTColor.blend(style.unreadBg, over: style.colors.bg) : style.colors.bg
    if (state.isHighlighted || state.isSwiped) && row.tap {
      bg.backgroundColor = CTColor.blend(style.colors.press, over: base)
    } else {
      bg.backgroundColor = base
    }
    backgroundConfiguration = bg
  }

  // MARK: Layout

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = contentView.bounds
    let r = row
    let tc = traitCollection
    let L = RLMetrics.lead
    let x0 = RLMetrics.padH
    let textX = x0 + L + RLMetrics.gap
    let w = RLRowCell.textWidth(r, total: b.width)

    // Altura do bloco de texto (+ botões) para centralizar com o avatar.
    let tw = RLRowCell.timeWidth(r, traits: tc)
    let th = RLRowCell.textHeight(titleLabel.attributedText ?? NSAttributedString(), width: w - tw, lines: r.titleLines)
    let sh = r.sub.isEmpty ? 0 : RLRowCell.textHeight(subLabel.attributedText ?? NSAttributedString(), width: w, lines: r.subLines)
    var blockH = th + (sh > 0 ? 2 + sh : 0)
    if r.hasButtons { blockH += 8 + RLMetrics.btnH }
    let textOnlyH = th + (sh > 0 ? 2 + sh : 0)
    let blockY = max(RLMetrics.padV, (b.height - blockH) / 2)
    // Avatar alinhado ao TEXTO quando há botões (Instagram); senão ao centro.
    let leadY = r.hasButtons ? max(RLMetrics.padV, blockY + (textOnlyH - L) / 2) : (b.height - L) / 2
    let leadFrame = CGRect(x: x0, y: leadY, width: L, height: L)
    avatar.frame = leadFrame
    thumb.frame = leadFrame
    glyphBox.frame = leadFrame
    glyphBox.layer.cornerRadius = r.glyphRound ? 10 : L / 2
    glyph.frame = glyphBox.bounds
    playBadge.frame = CGRect(x: leadFrame.maxX - 22, y: leadFrame.maxY - 22, width: 20, height: 20)
    badge.frame = CGRect(x: leadFrame.maxX - 17, y: leadFrame.maxY - 17, width: 20, height: 20)
    badgeIcon.frame = badge.bounds
    dot.frame = CGRect(x: 5, y: leadFrame.midY - 3, width: 6, height: 6)

    titleLabel.frame = CGRect(x: textX, y: blockY, width: max(0, w - tw), height: th)
    if !timeLabel.isHidden {
      var lh: CGFloat = 18
      if let at = titleLabel.attributedText, at.length > 0, let f = at.attribute(.font, at: 0, effectiveRange: nil) as? UIFont {
        lh = ceil(f.lineHeight)
      }
      timeLabel.frame = CGRect(x: textX + w - tw, y: blockY, width: tw, height: lh)
    }
    var y = blockY + th
    if sh > 0 {
      subLabel.frame = CGRect(x: textX, y: y + 2, width: w, height: sh)
      y += 2 + sh
    }
    if r.hasButtons {
      y += 8
      var bx = textX
      if !b1.isHidden {
        let s = b1.sizeThatFits(CGSize(width: 240, height: RLMetrics.btnH))
        let bw = max(72, min(w, ceil(s.width) + 28))
        b1.frame = CGRect(x: bx, y: y, width: bw, height: RLMetrics.btnH)
        b1Spinner.center = CGPoint(x: bw / 2, y: RLMetrics.btnH / 2)
        bx += bw + 8
      }
      if !b2.isHidden {
        let s = b2.sizeThatFits(CGSize(width: 240, height: RLMetrics.btnH))
        let bw = max(72, min(textX + w - bx, ceil(s.width) + 28))
        b2.frame = CGRect(x: bx, y: y, width: bw, height: RLMetrics.btnH)
      }
    }

    var right = b.width - RLMetrics.padH
    if r.chevron {
      chevronView.frame = CGRect(x: right - RLMetrics.chevron, y: (b.height - 20) / 2, width: RLMetrics.chevron, height: 20)
      right -= RLMetrics.chevron + 8
    }
    if !rthumb.isHidden {
      rthumb.frame = CGRect(x: right - RLMetrics.rthumb, y: leadY, width: RLMetrics.rthumb, height: RLMetrics.rthumb)
    }
    let px = 1 / max(1, (window?.screen.scale ?? UIScreen.main.scale))
    hairline.frame = CGRect(x: textX, y: b.height - px, width: b.width - textX, height: px)
  }
}
