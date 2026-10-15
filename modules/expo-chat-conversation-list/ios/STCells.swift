import UIKit

// [2026-10-15 settings-native] Células da raiz das Configurações — mesmo
// visual da lista JS (components/settings/SettingsKit.js):
//   linha: min 52 pt, padding 16/11, chip de ícone 32 pt (squircle, fundo
//   suave) + título 16 regular + subtítulo 13 (1 linha) + disclosure (ou
//   UISwitch), separador hairline recuado 62 pt (só entre linhas);
//   cabeçalho: 12 pt semibold, caixa alta, tracking 0.7, 18 pt de recuo;
//   cartão: decoração arredondada 18 pt por seção (STCardBackground).

final class STCardBackground: UICollectionReusableView {
  static let kind = "st-card-background"
  /// Cor do cartão vigente (o layout não repassa dados à decoração).
  static var color: UIColor = .white

  override init(frame: CGRect) {
    super.init(frame: frame)
    layer.cornerRadius = 18
    if #available(iOS 13.0, *) { layer.cornerCurve = .continuous }
    backgroundColor = STCardBackground.color
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func apply(_ layoutAttributes: UICollectionViewLayoutAttributes) {
    super.apply(layoutAttributes)
    backgroundColor = STCardBackground.color
  }
}

final class STRowCell: UICollectionViewCell {
  private let chip = UIView()
  private let glyph = UIImageView()
  private let titleLabel = UILabel()
  private let subLabel = UILabel()
  private let chevron = UIImageView()
  private let toggle = UISwitch()
  private let separator = UIView()
  private let textStack = UIStackView()

  private var chipW: NSLayoutConstraint!
  private var textLeadingToChip: NSLayoutConstraint!
  private var textLeadingToEdge: NSLayoutConstraint!
  private var textCenterX: NSLayoutConstraint!
  private var textTrailingToChevron: NSLayoutConstraint!
  private var textTrailingToSwitch: NSLayoutConstraint!
  private var textTrailingToEdge: NSLayoutConstraint!
  private var sepLeading: NSLayoutConstraint!

  private var palette = STPalette(dark: false)
  private(set) var rowId = ""
  var onToggle: ((String, Bool) -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.clipsToBounds = false
    clipsToBounds = true
    layer.cornerRadius = 18
    if #available(iOS 13.0, *) { layer.cornerCurve = .continuous }

    chip.translatesAutoresizingMaskIntoConstraints = false
    chip.layer.cornerRadius = 10
    if #available(iOS 13.0, *) { chip.layer.cornerCurve = .continuous }
    glyph.translatesAutoresizingMaskIntoConstraints = false
    glyph.contentMode = .center
    chip.addSubview(glyph)
    contentView.addSubview(chip)

    titleLabel.font = UIFont.systemFont(ofSize: 16, weight: .regular)
    titleLabel.numberOfLines = 1
    titleLabel.adjustsFontForContentSizeCategory = false
    subLabel.font = UIFont.systemFont(ofSize: 13, weight: .regular)
    subLabel.numberOfLines = 1
    textStack.axis = .vertical
    textStack.spacing = 2
    textStack.alignment = .leading
    textStack.translatesAutoresizingMaskIntoConstraints = false
    textStack.addArrangedSubview(titleLabel)
    textStack.addArrangedSubview(subLabel)
    contentView.addSubview(textStack)

    chevron.translatesAutoresizingMaskIntoConstraints = false
    chevron.contentMode = .center
    chevron.setContentHuggingPriority(.required, for: .horizontal)
    contentView.addSubview(chevron)

    toggle.translatesAutoresizingMaskIntoConstraints = false
    toggle.addTarget(self, action: #selector(toggled), for: .valueChanged)
    contentView.addSubview(toggle)

    separator.translatesAutoresizingMaskIntoConstraints = false
    contentView.addSubview(separator)

    let px = 1 / max(1, UIScreen.main.scale)
    chipW = chip.widthAnchor.constraint(equalToConstant: 32)
    textLeadingToChip = textStack.leadingAnchor.constraint(equalTo: chip.trailingAnchor, constant: 14)
    textLeadingToEdge = textStack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16)
    textCenterX = textStack.centerXAnchor.constraint(equalTo: contentView.centerXAnchor)
    let textLeadingMin = textStack.leadingAnchor.constraint(greaterThanOrEqualTo: contentView.leadingAnchor, constant: 16)
    textTrailingToChevron = textStack.trailingAnchor.constraint(lessThanOrEqualTo: chevron.leadingAnchor, constant: -6)
    textTrailingToSwitch = textStack.trailingAnchor.constraint(lessThanOrEqualTo: toggle.leadingAnchor, constant: -10)
    textTrailingToEdge = textStack.trailingAnchor.constraint(lessThanOrEqualTo: contentView.trailingAnchor, constant: -16)
    sepLeading = separator.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 62)
    let minH = contentView.heightAnchor.constraint(greaterThanOrEqualToConstant: 52)
    minH.priority = .required
    let topC = textStack.topAnchor.constraint(greaterThanOrEqualTo: contentView.topAnchor, constant: 11)
    let botC = textStack.bottomAnchor.constraint(lessThanOrEqualTo: contentView.bottomAnchor, constant: -11)

    NSLayoutConstraint.activate([
      chip.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16),
      chip.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
      chipW,
      chip.heightAnchor.constraint(equalToConstant: 32),
      glyph.centerXAnchor.constraint(equalTo: chip.centerXAnchor),
      glyph.centerYAnchor.constraint(equalTo: chip.centerYAnchor),
      textStack.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
      textLeadingMin,
      topC, botC, minH,
      chevron.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -16),
      chevron.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
      toggle.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -16),
      toggle.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
      separator.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
      separator.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
      separator.heightAnchor.constraint(equalToConstant: px),
      sepLeading,
    ])
    isAccessibilityElement = true
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var isHighlighted: Bool {
    didSet { applyBackground() }
  }

  private var tappable = true

  private func applyBackground() {
    contentView.backgroundColor = (isHighlighted && tappable) ? palette.press : .clear
  }

  /// first/last: cantos do realce de toque acompanham o cartão.
  func configure(_ row: STRow, palette p: STPalette, first: Bool, last: Bool, showSeparator: Bool) {
    rowId = row.id
    palette = p
    let isToggle = row.kind == "t"
    tappable = !isToggle
    var corners: CACornerMask = []
    if first { corners.formUnion([.layerMinXMinYCorner, .layerMaxXMinYCorner]) }
    if last { corners.formUnion([.layerMinXMaxYCorner, .layerMaxXMaxYCorner]) }
    layer.maskedCorners = corners
    layer.cornerRadius = corners.isEmpty ? 0 : 18

    // Ícone (chip suave) — linhas sem ícone/centradas (Sair) não têm chip.
    var hasIcon = false
    if !row.center, let sym = STText.symbol(row.icon) {
      let cfg = UIImage.SymbolConfiguration(pointSize: 16, weight: .regular)
      glyph.image = UIImage(systemName: sym, withConfiguration: cfg)?.withTintColor(p.chipFg, renderingMode: .alwaysOriginal)
      chip.backgroundColor = p.chipBg
      hasIcon = glyph.image != nil
    }
    chip.isHidden = !hasIcon

    let para = NSMutableParagraphStyle()
    para.alignment = row.center ? .center : .natural
    para.lineBreakMode = .byTruncatingTail
    titleLabel.attributedText = NSAttributedString(string: row.title, attributes: [
      .font: UIFont.systemFont(ofSize: 16, weight: .regular),
      .foregroundColor: row.destructive ? p.destructive : p.text,
      .kern: -0.25,
      .paragraphStyle: para,
    ])
    subLabel.text = row.sub
    subLabel.textColor = p.secondary
    subLabel.isHidden = row.sub.isEmpty
    textStack.alignment = row.center ? .center : .leading

    // Acessório: disclosure (padrão), interruptor (toggle) ou nada (ação).
    let showChevron = !row.center && !row.destructive && !isToggle
    chevron.isHidden = !showChevron
    if showChevron {
      let cfg = UIImage.SymbolConfiguration(pointSize: 14, weight: .semibold)
      chevron.image = UIImage(systemName: "chevron.right", withConfiguration: cfg)?.withTintColor(p.tertiary, renderingMode: .alwaysOriginal)
    }
    toggle.isHidden = !isToggle
    if isToggle {
      toggle.onTintColor = p.switchOn
      toggle.backgroundColor = p.switchOff
      toggle.layer.cornerRadius = toggle.bounds.height > 0 ? toggle.bounds.height / 2 : 15.5
      toggle.thumbTintColor = row.on ? p.switchThumb : .white
      if toggle.isOn != row.on { toggle.setOn(row.on, animated: window != nil) }
    }
    // Desliga tudo antes de religar (nunca 2 regras de borda ativas juntas).
    NSLayoutConstraint.deactivate([textLeadingToChip, textLeadingToEdge, textCenterX, textTrailingToChevron, textTrailingToSwitch, textTrailingToEdge])
    var active: [NSLayoutConstraint] = []
    if hasIcon { active.append(textLeadingToChip) } else if !row.center { active.append(textLeadingToEdge) }
    if row.center { active.append(textCenterX) }
    if showChevron { active.append(textTrailingToChevron) } else if isToggle { active.append(textTrailingToSwitch) } else { active.append(textTrailingToEdge) }
    NSLayoutConstraint.activate(active)
    separator.backgroundColor = p.separator
    separator.isHidden = !showSeparator
    // Categorias: recuo 62 (alinha com o texto); resultados/ações: 16 (como o JS).
    sepLeading.constant = (hasIcon && row.kind == "c") ? 62 : 16

    // Toggle: o UISwitch é o elemento acessível (VoiceOver alterna direto).
    isAccessibilityElement = !isToggle
    accessibilityLabel = row.sub.isEmpty ? row.title : "\(row.title), \(row.sub)"
    accessibilityTraits = .button
    toggle.accessibilityLabel = row.title
    applyBackground()
  }

  @objc private func toggled() {
    UISelectionFeedbackGenerator().selectionChanged()
    toggle.thumbTintColor = toggle.isOn ? palette.switchThumb : .white
    onToggle?(rowId, toggle.isOn)
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    onToggle = nil
  }
}

final class STHeaderCell: UICollectionViewCell {
  private let label = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    label.translatesAutoresizingMaskIntoConstraints = false
    label.numberOfLines = 1
    contentView.addSubview(label)
    NSLayoutConstraint.activate([
      label.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 18),
      label.trailingAnchor.constraint(lessThanOrEqualTo: contentView.trailingAnchor, constant: -18),
      label.topAnchor.constraint(equalTo: contentView.topAnchor),
      label.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -8),
    ])
    isAccessibilityElement = true
    accessibilityTraits = .header
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ text: String, palette p: STPalette) {
    let up = text.uppercased()
    label.attributedText = NSAttributedString(string: up, attributes: [
      .font: UIFont.systemFont(ofSize: 12, weight: .semibold),
      .foregroundColor: p.header,
      .kern: 0.7,
    ])
    accessibilityLabel = text
  }
}

final class STEmptyCell: UICollectionViewCell {
  private let icon = UIImageView()
  private let label = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    icon.translatesAutoresizingMaskIntoConstraints = false
    label.translatesAutoresizingMaskIntoConstraints = false
    label.font = UIFont.systemFont(ofSize: 15)
    label.textAlignment = .center
    label.numberOfLines = 2
    contentView.addSubview(icon)
    contentView.addSubview(label)
    NSLayoutConstraint.activate([
      icon.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 32),
      icon.centerXAnchor.constraint(equalTo: contentView.centerXAnchor),
      label.topAnchor.constraint(equalTo: icon.bottomAnchor, constant: 10),
      label.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16),
      label.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -16),
      label.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -32),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ text: String, palette p: STPalette) {
    let cfg = UIImage.SymbolConfiguration(pointSize: 26, weight: .regular)
    icon.image = UIImage(systemName: "magnifyingglass", withConfiguration: cfg)?.withTintColor(p.tertiary, renderingMode: .alwaysOriginal)
    label.text = text
    label.textColor = p.secondary
  }
}
