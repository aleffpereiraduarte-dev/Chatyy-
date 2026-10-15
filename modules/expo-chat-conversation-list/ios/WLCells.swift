import UIKit

// [2026-10-15 native-wallet] Células da carteira nativa (iOS) — mesmo visual
// do JS (app/wallet.js TxRow / dayLabel / EmptyActivity):
//   transação: min 64 pt, padding 16/12, ícone 40 pt (círculo `fill`) + título
//   16 semibold + sub 13 (1 linha) + valor 16 bold tabular (crédito = success)
//   com diamante 12 pt, valor secundário 12; separador recuado 68 pt;
//   dia: 13 semibold `secondary`, 16 pt acima / 8 abaixo, recuo 4;
//   cartão: decoração arredondada 18 pt por grupo (WLCardBackground).

final class WLCardBackground: UICollectionReusableView {
  static let kind = "wl-card-background"
  static var color: UIColor = .white

  override init(frame: CGRect) {
    super.init(frame: frame)
    layer.cornerRadius = 18
    if #available(iOS 13.0, *) { layer.cornerCurve = .continuous }
    backgroundColor = WLCardBackground.color
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func apply(_ layoutAttributes: UICollectionViewLayoutAttributes) {
    super.apply(layoutAttributes)
    backgroundColor = WLCardBackground.color
  }
}

/// Altura própria (layout manual) para a lista compositional estimada.
class WLSizedCell: UICollectionViewCell {
  func measure(width: CGFloat) -> CGFloat { return 44 }

  override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
    let attrs = super.preferredLayoutAttributesFitting(layoutAttributes)
    let w = layoutAttributes.size.width
    if w > 0 {
      var f = attrs.frame
      f.size.height = ceil(measure(width: w))
      attrs.frame = f
    }
    return attrs
  }
}

final class WLTxCell: WLSizedCell {
  private let iconBg = UIView()
  private let icon = UIImageView()
  private let avatar = CLAvatarView()
  private let titleLabel = UILabel()
  private let subLabel = UILabel()
  private let amountLabel = UILabel()
  private let amountDiamond = WLDiamondView()
  private let amountGlyph = UIImageView()
  private let amount2Label = UILabel()
  private let separator = UIView()

  private var palette = WLPalette(dark: false)
  private var row = WLRow()
  private var showSep = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = true
    if #available(iOS 13.0, *) { layer.cornerCurve = .continuous }
    iconBg.layer.cornerRadius = 20
    iconBg.isUserInteractionEnabled = false
    icon.contentMode = .center
    iconBg.addSubview(icon)
    contentView.addSubview(iconBg)
    avatar.isUserInteractionEnabled = false
    avatar.boxSize = 40
    contentView.addSubview(avatar)
    titleLabel.font = UIFont.systemFont(ofSize: 16, weight: .semibold)
    titleLabel.lineBreakMode = .byTruncatingTail
    subLabel.font = UIFont.systemFont(ofSize: 13)
    subLabel.lineBreakMode = .byTruncatingTail
    amountLabel.font = UIFont.monospacedDigitSystemFont(ofSize: 16, weight: .bold)
    amountLabel.textAlignment = .right
    amountDiamond.halo = false
    amountDiamond.glyphSize = 12
    amountGlyph.contentMode = .center
    amount2Label.font = UIFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular)
    amount2Label.textAlignment = .right
    for v in [titleLabel, subLabel, amountLabel, amountDiamond, amountGlyph, amount2Label, separator] as [UIView] {
      contentView.addSubview(v)
    }
    isAccessibilityElement = true
    accessibilityTraits = .button
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var isHighlighted: Bool {
    didSet { contentView.backgroundColor = (isHighlighted && row.tap) ? palette.press : .clear }
  }

  func configure(_ r: WLRow, palette p: WLPalette, first: Bool, last: Bool) {
    row = r
    palette = p
    showSep = !last
    var corners: CACornerMask = []
    if first { corners.formUnion([.layerMinXMinYCorner, .layerMaxXMinYCorner]) }
    if last { corners.formUnion([.layerMinXMaxYCorner, .layerMaxXMaxYCorner]) }
    layer.maskedCorners = corners
    layer.cornerRadius = corners.isEmpty ? 0 : 18

    if r.hasTiles {
      avatar.isHidden = false
      iconBg.isHidden = true
      avatar.configure(r.avatarRow(), theme: CLTheme(dark: p.dark), rowBackground: p.cardBg)
    } else {
      avatar.isHidden = true
      iconBg.isHidden = false
      iconBg.backgroundColor = p.fill
      icon.image = WLGlyphs.image(r.glyph, size: 17, color: p.text)
    }
    titleLabel.text = r.title
    titleLabel.textColor = p.text
    subLabel.text = r.sub
    subLabel.textColor = p.secondary
    subLabel.isHidden = r.sub.isEmpty
    amountLabel.text = r.amount
    amountLabel.textColor = r.credit ? p.success : p.text
    amountDiamond.isHidden = !r.diamond
    amountGlyph.isHidden = r.amountGlyph.isEmpty
    if !r.amountGlyph.isEmpty { amountGlyph.image = WLGlyphs.image(r.amountGlyph, size: 12, color: p.secondary) }
    amount2Label.text = r.amount2
    amount2Label.textColor = p.secondary
    amount2Label.isHidden = r.amount2.isEmpty
    separator.backgroundColor = p.separator
    separator.isHidden = last
    accessibilityLabel = r.a11y.isEmpty ? [r.title, r.amount, r.sub].filter { !$0.isEmpty }.joined(separator: ". ") : r.a11y
    accessibilityTraits = r.tap ? .button : .staticText
    contentView.backgroundColor = .clear
    setNeedsLayout()
  }

  override func measure(width: CGFloat) -> CGFloat { return 64 }

  override func layoutSubviews() {
    super.layoutSubviews()
    let w = contentView.bounds.width
    let h = contentView.bounds.height
    let lead = CGRect(x: 16, y: (h - 40) / 2, width: 40, height: 40)
    iconBg.frame = lead
    icon.frame = iconBg.bounds
    avatar.frame = lead

    // Coluna do valor (direita).
    let amtSize = amountLabel.sizeThatFits(CGSize(width: w / 2, height: 22))
    let a2Size = row.amount2.isEmpty ? .zero : amount2Label.sizeThatFits(CGSize(width: w / 2, height: 16))
    let diaW: CGFloat = row.diamond ? 16 : 0
    let glyphW: CGFloat = row.amountGlyph.isEmpty ? 0 : 16
    let rightW = min(w * 0.45, max(ceil(amtSize.width) + diaW + glyphW, ceil(a2Size.width)))
    let colH: CGFloat = 20 + (row.amount2.isEmpty ? 0 : 16)
    var ry = (h - colH) / 2
    let rightX = w - 16 - rightW
    let amtW = min(ceil(amtSize.width), rightW - diaW - glyphW)
    let amtX = w - 16 - diaW - amtW
    amountLabel.frame = CGRect(x: amtX, y: ry, width: amtW, height: 20)
    amountDiamond.frame = CGRect(x: w - 16 - 12, y: ry + 4, width: 12, height: 12)
    amountGlyph.frame = CGRect(x: amtX - glyphW, y: ry + 2, width: 14, height: 16)
    ry += 20
    if !row.amount2.isEmpty { amount2Label.frame = CGRect(x: rightX, y: ry + 1, width: rightW, height: 15) }

    let tx = lead.maxX + 12
    let tw = max(0, rightX - 8 - tx)
    let textH: CGFloat = row.sub.isEmpty ? 20 : 37
    let ty = (h - textH) / 2
    titleLabel.frame = CGRect(x: tx, y: ty, width: tw, height: 20)
    subLabel.frame = CGRect(x: tx, y: ty + 21, width: tw, height: 16)
    let px = 1 / max(1, UIScreen.main.scale)
    separator.frame = CGRect(x: 68, y: h - px, width: max(0, w - 68), height: px)
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    contentView.backgroundColor = .clear
  }
}

final class WLDayCell: WLSizedCell {
  private let label = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    label.font = UIFont.systemFont(ofSize: 13, weight: .semibold)
    label.lineBreakMode = .byTruncatingTail
    contentView.addSubview(label)
    isAccessibilityElement = true
    accessibilityTraits = .header
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ r: WLRow, palette p: WLPalette) {
    label.text = r.title
    label.textColor = p.secondary
    accessibilityLabel = r.title
  }

  override func measure(width: CGFloat) -> CGFloat { return 40 }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = contentView.bounds
    label.frame = CGRect(x: 4, y: 16, width: max(0, b.width - 8), height: 16)
  }
}

final class WLEmptyCell: WLSizedCell {
  private let circle = UIView()
  private let icon = UIImageView()
  private let titleLabel = UILabel()
  private let subLabel = UILabel()
  private let button = UIButton(type: .custom)
  private var row = WLRow()
  var onAction: ((String, String) -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.layer.cornerRadius = 18
    if #available(iOS 13.0, *) { contentView.layer.cornerCurve = .continuous }
    circle.layer.cornerRadius = 30
    circle.layer.borderWidth = 1
    icon.contentMode = .center
    circle.addSubview(icon)
    titleLabel.font = UIFont.systemFont(ofSize: 17, weight: .semibold)
    titleLabel.textAlignment = .center
    titleLabel.numberOfLines = 0
    subLabel.font = UIFont.systemFont(ofSize: 13)
    subLabel.textAlignment = .center
    subLabel.numberOfLines = 0
    button.titleLabel?.font = UIFont.systemFont(ofSize: 15, weight: .bold)
    button.layer.cornerRadius = 20
    button.layer.borderWidth = 1
    button.contentEdgeInsets = UIEdgeInsets(top: 0, left: 20, bottom: 0, right: 20)
    button.addTarget(self, action: #selector(tapped), for: .touchUpInside)
    for v in [circle, titleLabel, subLabel, button] as [UIView] { contentView.addSubview(v) }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ r: WLRow, palette p: WLPalette) {
    row = r
    contentView.backgroundColor = p.cardBg
    circle.layer.borderColor = p.separator.cgColor
    icon.image = WLGlyphs.image(r.glyph.isEmpty ? "receipt" : r.glyph, size: 22, color: p.secondary, weight: .light)
    titleLabel.text = r.title
    titleLabel.textColor = p.text
    subLabel.text = r.sub
    subLabel.textColor = p.secondary
    subLabel.isHidden = r.sub.isEmpty
    button.isHidden = r.button.isEmpty
    button.setTitle(r.button, for: .normal)
    button.setTitleColor(p.text, for: .normal)
    button.setTitleColor(p.secondary, for: .highlighted)
    button.layer.borderColor = p.ink.cgColor
    setNeedsLayout()
  }

  @objc private func tapped() {
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    onAction?(row.id, row.buttonAction.isEmpty ? "button" : row.buttonAction)
  }

  @discardableResult
  private func doLayout(width w: CGFloat, apply: Bool) -> CGFloat {
    let inner = max(0, w - 40)
    var y: CGFloat = 32
    if apply {
      circle.frame = CGRect(x: (w - 60) / 2, y: y, width: 60, height: 60)
      icon.frame = circle.bounds
    }
    y += 60 + 12
    let th = ceil(titleLabel.sizeThatFits(CGSize(width: inner, height: .greatestFiniteMagnitude)).height)
    if apply { titleLabel.frame = CGRect(x: 20, y: y, width: inner, height: th) }
    y += th
    if !row.sub.isEmpty {
      y += 4
      let sh = ceil(subLabel.sizeThatFits(CGSize(width: inner, height: .greatestFiniteMagnitude)).height)
      if apply { subLabel.frame = CGRect(x: 20, y: y, width: inner, height: sh) }
      y += sh
    }
    if !row.button.isEmpty {
      y += 16
      let bw = min(inner, ceil(button.sizeThatFits(CGSize(width: inner, height: 40)).width))
      if apply { button.frame = CGRect(x: (w - bw) / 2, y: y, width: bw, height: 40) }
      y += 40
    }
    return y + 32
  }

  override func measure(width: CGFloat) -> CGFloat { return doLayout(width: width, apply: false) }

  override func layoutSubviews() {
    super.layoutSubviews()
    doLayout(width: contentView.bounds.width, apply: true)
  }
}

final class WLLoadingCell: WLSizedCell {
  private let spinner = UIActivityIndicatorView(style: .medium)

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.addSubview(spinner)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(palette p: WLPalette) {
    spinner.color = p.secondary
    spinner.startAnimating()
  }

  override func measure(width: CGFloat) -> CGFloat { return 56 }

  override func layoutSubviews() {
    super.layoutSubviews()
    spinner.center = CGPoint(x: contentView.bounds.midX, y: contentView.bounds.midY)
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    spinner.startAnimating()
  }
}

final class WLNoteCell: WLSizedCell {
  private let label = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    label.font = UIFont.systemFont(ofSize: 12)
    label.textAlignment = .center
    label.numberOfLines = 0
    contentView.addSubview(label)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ r: WLRow, palette p: WLPalette) {
    label.text = r.title
    label.textColor = r.credit ? p.secondary : p.tertiary
    label.font = r.credit ? UIFont.systemFont(ofSize: 13) : UIFont.systemFont(ofSize: 12)
    setNeedsLayout()
  }

  override func measure(width: CGFloat) -> CGFloat {
    let h = label.sizeThatFits(CGSize(width: max(0, width - 32), height: .greatestFiniteMagnitude)).height
    return ceil(h) + 16
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = contentView.bounds
    label.frame = CGRect(x: 16, y: 12, width: max(0, b.width - 32), height: max(0, b.height - 16))
  }
}
