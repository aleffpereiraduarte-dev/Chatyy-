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
  private let textStack = UIStackView()
  // [2026-10-18 settings-sub-native] lado direito = pilha de acessórios
  // (valor · spinner · check · seta · interruptor); escondidos não ocupam espaço.
  private let accStack = UIStackView()
  private let valueLabel = UILabel()
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let check = UIImageView()
  private let chevron = UIImageView()
  private let toggle = UISwitch()
  private let separator = UIView()

  private var textLeadingToChip: NSLayoutConstraint!
  private var textLeadingToEdge: NSLayoutConstraint!
  private var textCenterX: NSLayoutConstraint!
  private var textTrailingToAcc: NSLayoutConstraint!
  private var textTrailingMax: NSLayoutConstraint!
  private var textFillToAcc: NSLayoutConstraint!
  private var textFillToEdge: NSLayoutConstraint!
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
    // [2026-10-17 wa-cells] tile 30 pt, canto contínuo 7 (Ajustes/WhatsApp iOS).
    chip.layer.cornerRadius = 7
    if #available(iOS 13.0, *) { chip.layer.cornerCurve = .continuous }
    glyph.translatesAutoresizingMaskIntoConstraints = false
    glyph.contentMode = .center
    chip.addSubview(glyph)
    contentView.addSubview(chip)

    titleLabel.font = UIFont.systemFont(ofSize: 17, weight: .regular)
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
    textStack.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
    contentView.addSubview(textStack)

    valueLabel.font = UIFont.systemFont(ofSize: 17, weight: .regular)
    valueLabel.numberOfLines = 1
    valueLabel.textAlignment = .right
    valueLabel.lineBreakMode = .byTruncatingTail
    // O título vence: o valor encolhe/trunca primeiro.
    valueLabel.setContentCompressionResistancePriority(UILayoutPriority(249), for: .horizontal)
    valueLabel.setContentHuggingPriority(.required, for: .horizontal)
    spinner.hidesWhenStopped = false
    check.contentMode = .center
    check.setContentHuggingPriority(.required, for: .horizontal)
    chevron.contentMode = .center
    chevron.setContentHuggingPriority(.required, for: .horizontal)
    toggle.addTarget(self, action: #selector(toggled), for: .valueChanged)
    toggle.setContentHuggingPriority(.required, for: .horizontal)
    toggle.setContentCompressionResistancePriority(.required, for: .horizontal)
    accStack.axis = .horizontal
    accStack.alignment = .center
    accStack.spacing = 6
    accStack.translatesAutoresizingMaskIntoConstraints = false
    for v in [valueLabel, spinner, check, chevron, toggle] as [UIView] { accStack.addArrangedSubview(v) }
    contentView.addSubview(accStack)

    separator.translatesAutoresizingMaskIntoConstraints = false
    contentView.addSubview(separator)

    let px = 1 / max(1, UIScreen.main.scale)
    textLeadingToChip = textStack.leadingAnchor.constraint(equalTo: chip.trailingAnchor, constant: 14)
    textLeadingToEdge = textStack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16)
    textCenterX = textStack.centerXAnchor.constraint(equalTo: contentView.centerXAnchor)
    let textLeadingMin = textStack.leadingAnchor.constraint(greaterThanOrEqualTo: contentView.leadingAnchor, constant: 16)
    textTrailingToAcc = textStack.trailingAnchor.constraint(lessThanOrEqualTo: accStack.leadingAnchor, constant: -10)
    textTrailingMax = textStack.trailingAnchor.constraint(lessThanOrEqualTo: contentView.trailingAnchor, constant: -16)
    sepLeading = separator.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 60)
    let minH = contentView.heightAnchor.constraint(greaterThanOrEqualToConstant: 52)
    minH.priority = .required
    let topC = textStack.topAnchor.constraint(greaterThanOrEqualTo: contentView.topAnchor, constant: 11)
    let botC = textStack.bottomAnchor.constraint(lessThanOrEqualTo: contentView.bottomAnchor, constant: -11)
    let valueMax = valueLabel.widthAnchor.constraint(lessThanOrEqualTo: contentView.widthAnchor, multiplier: 0.5)
    // Check vazio (radio desmarcado) reserva a largura do check. 999: o
    // UIStackView zera a largura das vistas escondidas (sem conflito no log).
    let checkW = check.widthAnchor.constraint(equalToConstant: 20)
    checkW.priority = UILayoutPriority(999)
    let checkH = check.heightAnchor.constraint(equalToConstant: 20)
    checkH.priority = UILayoutPriority(999)
    // Texto ocupa a largura livre (quebra de linha estável no auto-dimensionamento);
    // prioridade baixa: o valor (249) e o título (750) vencem.
    textFillToAcc = textStack.trailingAnchor.constraint(equalTo: accStack.leadingAnchor, constant: -10)
    textFillToAcc.priority = UILayoutPriority(200)
    textFillToEdge = textStack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -16)
    textFillToEdge.priority = UILayoutPriority(200)

    NSLayoutConstraint.activate([
      chip.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16),
      chip.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
      chip.widthAnchor.constraint(equalToConstant: 30),
      chip.heightAnchor.constraint(equalToConstant: 30),
      glyph.centerXAnchor.constraint(equalTo: chip.centerXAnchor),
      glyph.centerYAnchor.constraint(equalTo: chip.centerYAnchor),
      textStack.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
      textLeadingMin,
      textTrailingMax,
      topC, botC, minH,
      accStack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -16),
      accStack.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
      accStack.leadingAnchor.constraint(greaterThanOrEqualTo: contentView.leadingAnchor, constant: 16),
      valueMax,
      checkW,
      checkH,
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
    let acc = row.accessory
    let isToggle = acc == "t"
    tappable = row.pressable
    var corners: CACornerMask = []
    if first { corners.formUnion([.layerMinXMinYCorner, .layerMaxXMinYCorner]) }
    if last { corners.formUnion([.layerMinXMaxYCorner, .layerMaxXMaxYCorner]) }
    layer.maskedCorners = corners
    layer.cornerRadius = corners.isEmpty ? 0 : 18

    // Ícone (chip suave) — linhas sem ícone/centradas (Sair) não têm chip.
    var hasIcon = false
    glyph.image = nil
    if !row.center, row.icon == "biaOrb" {
      // [2026-10-18 bia-orb-icon] Bia = orb ocupando o chip (sem fundo atrás).
      glyph.image = BiaOrbArt.image(diameter: 30, dark: p.dark)
      chip.backgroundColor = .clear
      hasIcon = true
    } else if !row.center, let sym = STText.symbol(row.icon) {
      let cfg = UIImage.SymbolConfiguration(pointSize: 15, weight: .regular)
      glyph.image = UIImage(systemName: sym, withConfiguration: cfg)?.withTintColor(p.chipFg, renderingMode: .alwaysOriginal)
      chip.backgroundColor = p.chipBg
      hasIcon = glyph.image != nil
    }
    chip.isHidden = !hasIcon

    let para = NSMutableParagraphStyle()
    para.alignment = row.center ? .center : .natural
    para.lineBreakMode = .byTruncatingTail
    titleLabel.numberOfLines = row.titleLines
    titleLabel.attributedText = NSAttributedString(string: row.title, attributes: [
      .font: UIFont.systemFont(ofSize: 17, weight: .regular),
      .foregroundColor: row.destructive ? p.destructive : p.text,
      .kern: -0.2,
      .paragraphStyle: para,
    ])
    subLabel.numberOfLines = row.subLines
    subLabel.text = row.sub
    subLabel.textColor = p.secondary
    subLabel.isHidden = row.sub.isEmpty
    textStack.alignment = row.center ? .center : .leading

    // Acessórios à direita.
    valueLabel.text = row.value
    valueLabel.textColor = p.secondary
    valueLabel.isHidden = row.value.isEmpty || row.center
    let showSpin = acc == "s"
    spinner.isHidden = !showSpin
    spinner.color = p.secondary
    if showSpin { spinner.startAnimating() } else { spinner.stopAnimating() }
    let showCheck = acc == "k" || acc == "u"
    check.isHidden = !showCheck
    if acc == "k" {
      let cfg = UIImage.SymbolConfiguration(pointSize: 16, weight: .semibold)
      check.image = UIImage(systemName: "checkmark", withConfiguration: cfg)?.withTintColor(p.text, renderingMode: .alwaysOriginal)
    } else {
      check.image = nil
    }
    let showChevron = acc == "c" && !row.center
    chevron.isHidden = !showChevron
    if showChevron {
      let cfg = UIImage.SymbolConfiguration(pointSize: 14, weight: .semibold)
      chevron.image = UIImage(systemName: "chevron.right", withConfiguration: cfg)?.withTintColor(p.tertiary, renderingMode: .alwaysOriginal)
    }
    toggle.isHidden = !isToggle
    toggle.isEnabled = !row.disabled
    if isToggle {
      toggle.onTintColor = p.switchOn
      toggle.backgroundColor = p.switchOff
      toggle.layer.cornerRadius = toggle.bounds.height > 0 ? toggle.bounds.height / 2 : 15.5
      toggle.thumbTintColor = row.on ? p.switchThumb : .white
      if toggle.isOn != row.on { toggle.setOn(row.on, animated: window != nil) }
    }
    let anyAcc = !valueLabel.isHidden || showSpin || showCheck || showChevron || isToggle
    accStack.isHidden = !anyAcc

    // Desliga tudo antes de religar (nunca 2 regras de borda ativas juntas).
    NSLayoutConstraint.deactivate([textLeadingToChip, textLeadingToEdge, textCenterX, textTrailingToAcc, textFillToAcc, textFillToEdge])
    var active: [NSLayoutConstraint] = []
    if hasIcon { active.append(textLeadingToChip) } else if !row.center { active.append(textLeadingToEdge) }
    if row.center { active.append(textCenterX) }
    if anyAcc { active.append(textTrailingToAcc) }
    if !row.center { active.append(anyAcc ? textFillToAcc : textFillToEdge) }
    NSLayoutConstraint.activate(active)
    separator.backgroundColor = p.separator
    separator.isHidden = !showSeparator
    // Categorias: recuo 60 (16 + tile 30 + 14 = alinha com o texto); resultados/ações: 16.
    sepLeading.constant = (hasIcon && row.kind != "q") ? 60 : 16

    let dim: CGFloat = row.disabled ? 0.45 : 1
    textStack.alpha = dim
    chip.alpha = dim
    valueLabel.alpha = dim

    // Toggle: o UISwitch é o elemento acessível (VoiceOver alterna direto).
    isAccessibilityElement = !isToggle
    var a11y = row.sub.isEmpty ? row.title : "\(row.title), \(row.sub)"
    if !row.value.isEmpty { a11y += ", \(row.value)" }
    accessibilityLabel = a11y
    var traits: UIAccessibilityTraits = row.pressable ? .button : .staticText
    if acc == "k" { traits.insert(.selected) }
    if row.disabled { traits.insert(.notEnabled) }
    accessibilityTraits = traits
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
      .font: UIFont.systemFont(ofSize: 13, weight: .regular),
      .foregroundColor: p.header,
      .kern: 0.3,
    ])
    accessibilityLabel = text
  }
}

// [2026-10-18 settings-sub-native] rodapé da seção (texto explicativo abaixo
// do cartão, como o footer do UITableView inset-grouped / SettingsGroup JS).
final class STFooterCell: UICollectionViewCell {
  private let label = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    label.translatesAutoresizingMaskIntoConstraints = false
    label.numberOfLines = 0
    contentView.addSubview(label)
    NSLayoutConstraint.activate([
      label.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 18),
      label.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -18),
      label.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 8),
      label.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
    ])
    isAccessibilityElement = true
    accessibilityTraits = .staticText
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ text: String, palette p: STPalette) {
    let para = NSMutableParagraphStyle()
    para.lineSpacing = 1
    label.attributedText = NSAttributedString(string: text, attributes: [
      .font: UIFont.systemFont(ofSize: 13, weight: .regular),
      .foregroundColor: p.header,
      .paragraphStyle: para,
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
