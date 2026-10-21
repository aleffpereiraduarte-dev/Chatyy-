import UIKit

// [2026-10-18 chat-info-native] Células da tela "Dados do contato/grupo"
// (ChatyyChatInfoView). Visual WhatsApp iOS em P&B: hero (foto grande,
// nome 22 semibold, subtítulo, ações em ladrilhos arredondados), cartões
// agrupados com cantos 14, linhas com ladrilho de ícone 30 pt, faixa
// horizontal de miniaturas, lista de membros com pílula "Admin".

/// Fundo arredondado de cada cartão (decoração do layout compositional).
final class CICardBackground: UICollectionReusableView {
  static let kind = "ci-card-background"
  /// Cor do cartão vigente (o layout não repassa dados à decoração).
  static var color: UIColor = .white

  override init(frame: CGRect) {
    super.init(frame: frame)
    layer.cornerRadius = 14
    layer.cornerCurve = .continuous
    backgroundColor = CICardBackground.color
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func apply(_ layoutAttributes: UICollectionViewLayoutAttributes) {
    super.apply(layoutAttributes)
    backgroundColor = CICardBackground.color
  }
}

/// Avatar redondo: gradiente + iniciais por baixo, foto por cima quando carrega.
final class CIAvatarView: UIView {
  private let gradient = CAGradientLayer()
  private let initialsLabel = UILabel()
  private let imageView = UIImageView()
  private var currentURL = ""
  var maxPixel: CGFloat = 192
  /// [2026-10-18 elegance] 1 = círculo, 0 = retângulo (foto expandida do cabeçalho).
  var roundness: CGFloat = 1 { didSet { if roundness != oldValue { setNeedsLayout() } } }
  var hasImage: Bool { return imageView.image != nil }

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = true
    isUserInteractionEnabled = false
    gradient.startPoint = CGPoint(x: 0, y: 0)
    gradient.endPoint = CGPoint(x: 1, y: 1)
    layer.addSublayer(gradient)
    initialsLabel.textAlignment = .center
    initialsLabel.textColor = .white
    initialsLabel.adjustsFontSizeToFitWidth = true
    initialsLabel.minimumScaleFactor = 0.6
    addSubview(initialsLabel)
    imageView.contentMode = .scaleAspectFill
    imageView.clipsToBounds = true
    addSubview(imageView)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  /// keep = true (carrossel da foto expandida): mantém a foto atual até a
  /// próxima carregar (sem piscar o degradê) e troca sem fade.
  func configure(_ pic: CIPic, keep: Bool = false) {
    let pair = CLTheme.gradient(pic.grad)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    gradient.colors = [pair.0.cgColor, pair.1.cgColor]
    CATransaction.commit()
    if !pic.initials.isEmpty || !keep { initialsLabel.text = pic.initials }
    if pic.url == currentURL && imageView.image != nil { return }
    currentURL = pic.url
    if pic.url.isEmpty {
      if !keep { imageView.image = nil }
      return
    }
    let px = maxPixel
    if let img = CLImageLoader.shared.cachedImage(pic.url, maxPixel: px) {
      imageView.image = img
      imageView.alpha = 1
      return
    }
    let hadImage = imageView.image != nil
    if !keep { imageView.image = nil }
    let url = pic.url
    CLImageLoader.shared.load(url, auth: pic.auth, maxPixel: px) { [weak self] img in
      guard let self = self, self.currentURL == url else { return }
      if keep && hadImage && img == nil { return }
      self.imageView.image = img
      if keep && hadImage {
        self.imageView.alpha = 1
      } else if img != nil && self.window != nil {
        self.imageView.alpha = 0
        UIView.animate(withDuration: 0.18) { self.imageView.alpha = 1 }
      } else {
        self.imageView.alpha = 1
      }
    }
  }

  func reset() {
    currentURL = ""
    imageView.image = nil
    initialsLabel.text = nil
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    gradient.frame = bounds
    CATransaction.commit()
    imageView.frame = bounds
    let side = min(bounds.width, bounds.height)
    layer.cornerRadius = side / 2 * max(0, min(1, roundness))
    initialsLabel.font = UIFont.systemFont(ofSize: max(9, side * 0.38), weight: .semibold)
    initialsLabel.frame = bounds.insetBy(dx: 2, dy: 0)
  }
}

/// Ladrilho de ação do hero (Áudio / Vídeo / Pesquisar / Adicionar).
final class CIActionTile: UIControl {
  private let icon = UIImageView()
  private let label = UILabel()
  private(set) var key = ""
  private var fill: UIColor = .white
  private var pressFill: UIColor = .lightGray

  override init(frame: CGRect) {
    super.init(frame: frame)
    layer.cornerRadius = 12
    layer.cornerCurve = .continuous
    icon.translatesAutoresizingMaskIntoConstraints = false
    icon.contentMode = .center
    icon.isUserInteractionEnabled = false
    label.translatesAutoresizingMaskIntoConstraints = false
    label.font = UIFont.systemFont(ofSize: 12, weight: .medium)
    label.textAlignment = .center
    label.numberOfLines = 1
    label.adjustsFontSizeToFitWidth = true
    label.minimumScaleFactor = 0.8
    label.isUserInteractionEnabled = false
    addSubview(icon)
    addSubview(label)
    NSLayoutConstraint.activate([
      icon.centerXAnchor.constraint(equalTo: centerXAnchor),
      icon.topAnchor.constraint(equalTo: topAnchor, constant: 11),
      icon.heightAnchor.constraint(equalToConstant: 24),
      label.topAnchor.constraint(equalTo: icon.bottomAnchor, constant: 5),
      label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 4),
      label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -4),
      label.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -9),
    ])
    isAccessibilityElement = true
    accessibilityTraits = .button
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ a: CIAction, palette p: STPalette) {
    key = a.key
    fill = p.cardBg
    pressFill = p.press
    backgroundColor = isHighlighted ? pressFill : fill
    icon.image = CIText.image(a.icon, size: 19, weight: a.active ? .semibold : .regular, color: p.text)
    label.text = a.label
    label.textColor = p.text
    label.font = UIFont.systemFont(ofSize: 12, weight: a.active ? .semibold : .medium)
    accessibilityLabel = a.label
  }

  override var isHighlighted: Bool {
    didSet { backgroundColor = isHighlighted ? pressFill : fill }
  }
}

final class CIHeroCell: UICollectionViewCell {
  private let avatarButton = UIControl()
  private let avatar = CIAvatarView()
  private let badge = UIView()
  private let badgeIcon = UIImageView()
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let titleLabel = UILabel()
  private let subLabel = UILabel()
  private let actionsStack = UIStackView()
  private var tiles: [CIActionTile] = []
  private var actionsTop: NSLayoutConstraint!
  private var actionsHeight: NSLayoutConstraint!

  var onAvatar: (() -> Void)?
  var onAction: ((String) -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    avatar.maxPixel = 480
    avatarButton.translatesAutoresizingMaskIntoConstraints = false
    avatar.translatesAutoresizingMaskIntoConstraints = false
    avatarButton.addSubview(avatar)
    avatarButton.addTarget(self, action: #selector(avatarTapped), for: .touchUpInside)
    avatarButton.isAccessibilityElement = true
    avatarButton.accessibilityTraits = [.button, .image]
    contentView.addSubview(avatarButton)

    badge.translatesAutoresizingMaskIntoConstraints = false
    badge.layer.cornerRadius = 17
    badge.layer.borderWidth = 3
    badge.isUserInteractionEnabled = false
    badgeIcon.translatesAutoresizingMaskIntoConstraints = false
    badgeIcon.contentMode = .center
    badge.addSubview(badgeIcon)
    spinner.translatesAutoresizingMaskIntoConstraints = false
    spinner.hidesWhenStopped = true
    badge.addSubview(spinner)
    contentView.addSubview(badge)

    titleLabel.translatesAutoresizingMaskIntoConstraints = false
    titleLabel.font = UIFont.systemFont(ofSize: 22, weight: .semibold)
    titleLabel.textAlignment = .center
    titleLabel.numberOfLines = 2
    titleLabel.lineBreakMode = .byTruncatingTail
    contentView.addSubview(titleLabel)

    subLabel.translatesAutoresizingMaskIntoConstraints = false
    subLabel.font = UIFont.systemFont(ofSize: 15, weight: .regular)
    subLabel.textAlignment = .center
    subLabel.numberOfLines = 2
    subLabel.lineBreakMode = .byTruncatingTail
    contentView.addSubview(subLabel)

    actionsStack.translatesAutoresizingMaskIntoConstraints = false
    actionsStack.axis = .horizontal
    actionsStack.distribution = .fillEqually
    actionsStack.alignment = .fill
    actionsStack.spacing = 8
    contentView.addSubview(actionsStack)

    actionsTop = actionsStack.topAnchor.constraint(equalTo: subLabel.bottomAnchor, constant: 20)
    actionsHeight = actionsStack.heightAnchor.constraint(equalToConstant: 64)
    let fullWidth = actionsStack.widthAnchor.constraint(equalTo: contentView.widthAnchor)
    fullWidth.priority = .defaultHigh
    NSLayoutConstraint.activate([
      avatarButton.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 4),
      avatarButton.centerXAnchor.constraint(equalTo: contentView.centerXAnchor),
      avatarButton.widthAnchor.constraint(equalToConstant: 112),
      avatarButton.heightAnchor.constraint(equalToConstant: 112),
      avatar.topAnchor.constraint(equalTo: avatarButton.topAnchor),
      avatar.bottomAnchor.constraint(equalTo: avatarButton.bottomAnchor),
      avatar.leadingAnchor.constraint(equalTo: avatarButton.leadingAnchor),
      avatar.trailingAnchor.constraint(equalTo: avatarButton.trailingAnchor),
      badge.widthAnchor.constraint(equalToConstant: 34),
      badge.heightAnchor.constraint(equalToConstant: 34),
      badge.centerXAnchor.constraint(equalTo: avatarButton.trailingAnchor, constant: -14),
      badge.centerYAnchor.constraint(equalTo: avatarButton.bottomAnchor, constant: -14),
      badgeIcon.centerXAnchor.constraint(equalTo: badge.centerXAnchor),
      badgeIcon.centerYAnchor.constraint(equalTo: badge.centerYAnchor),
      spinner.centerXAnchor.constraint(equalTo: badge.centerXAnchor),
      spinner.centerYAnchor.constraint(equalTo: badge.centerYAnchor),
      titleLabel.topAnchor.constraint(equalTo: avatarButton.bottomAnchor, constant: 14),
      titleLabel.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 8),
      titleLabel.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -8),
      subLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 4),
      subLabel.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 8),
      subLabel.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -8),
      actionsTop,
      actionsHeight,
      actionsStack.centerXAnchor.constraint(equalTo: contentView.centerXAnchor),
      actionsStack.widthAnchor.constraint(lessThanOrEqualToConstant: 460),
      fullWidth,
      actionsStack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -4),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ h: CIHero, palette p: STPalette, avatarLabel: String) {
    avatar.configure(h.pic)
    avatarButton.accessibilityLabel = avatarLabel
    titleLabel.text = h.title
    titleLabel.textColor = p.text
    subLabel.text = h.sub
    subLabel.textColor = p.secondary
    subLabel.isHidden = h.sub.isEmpty

    let showBadge = h.badge == "camera" || h.busy
    badge.isHidden = !showBadge
    badge.backgroundColor = p.text
    badge.layer.borderColor = p.pageBg.cgColor
    if h.busy {
      badgeIcon.image = nil
      spinner.color = p.pageBg
      spinner.startAnimating()
    } else {
      spinner.stopAnimating()
      badgeIcon.image = CIText.image("camera", size: 14, weight: .semibold, color: p.pageBg)
    }

    // Ladrilhos: reaproveita os existentes, cria/remove só a diferença.
    while tiles.count < h.actions.count {
      let tile = CIActionTile()
      tile.addTarget(self, action: #selector(tileTapped(_:)), for: .touchUpInside)
      tiles.append(tile)
      actionsStack.addArrangedSubview(tile)
    }
    while tiles.count > h.actions.count {
      let tile = tiles.removeLast()
      actionsStack.removeArrangedSubview(tile)
      tile.removeFromSuperview()
    }
    for (i, a) in h.actions.enumerated() { tiles[i].configure(a, palette: p) }
    let hasActions = !h.actions.isEmpty
    actionsStack.isHidden = !hasActions
    actionsHeight.constant = hasActions ? 64 : 0
    actionsTop.constant = hasActions ? 20 : 4
  }

  @objc private func avatarTapped() { onAvatar?() }

  @objc private func tileTapped(_ sender: CIActionTile) {
    UISelectionFeedbackGenerator().selectionChanged()
    onAction?(sender.key)
  }
}

/// Linha de cartão: ladrilho de ícone 30 pt + título 17 + subtítulo 13 +
/// valor à direita + seta (ou UISwitch). Separador hairline entre linhas.
final class CIRowCell: UICollectionViewCell {
  private let chip = UIView()
  private let glyph = UIImageView()
  private let titleLabel = UILabel()
  private let subLabel = UILabel()
  private let valueLabel = UILabel()
  private let chevron = UIImageView()
  private let toggle = UISwitch()
  private let separator = UIView()
  private let textStack = UIStackView()
  private let accStack = UIStackView()

  private var textLeadingToChip: NSLayoutConstraint!
  private var textLeadingToEdge: NSLayoutConstraint!
  private var sepLeading: NSLayoutConstraint!

  private var palette = STPalette(dark: false)
  private var tappable = true
  private(set) var rowId = ""
  var onToggle: ((String, Bool) -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = true
    layer.cornerRadius = 14
    layer.cornerCurve = .continuous

    chip.translatesAutoresizingMaskIntoConstraints = false
    chip.layer.cornerRadius = 7
    chip.layer.cornerCurve = .continuous
    glyph.translatesAutoresizingMaskIntoConstraints = false
    glyph.contentMode = .center
    chip.addSubview(glyph)
    contentView.addSubview(chip)

    titleLabel.font = UIFont.systemFont(ofSize: 17, weight: .regular)
    titleLabel.numberOfLines = 1
    titleLabel.lineBreakMode = .byTruncatingTail
    titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    subLabel.font = UIFont.systemFont(ofSize: 13, weight: .regular)
    subLabel.numberOfLines = 2
    subLabel.lineBreakMode = .byTruncatingTail
    textStack.axis = .vertical
    textStack.spacing = 2
    textStack.alignment = .leading
    textStack.translatesAutoresizingMaskIntoConstraints = false
    textStack.addArrangedSubview(titleLabel)
    textStack.addArrangedSubview(subLabel)
    contentView.addSubview(textStack)

    valueLabel.font = UIFont.systemFont(ofSize: 15, weight: .regular)
    valueLabel.numberOfLines = 1
    valueLabel.lineBreakMode = .byTruncatingTail
    valueLabel.textAlignment = .right
    valueLabel.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
    valueLabel.setContentHuggingPriority(.required, for: .horizontal)
    chevron.contentMode = .center
    chevron.setContentHuggingPriority(.required, for: .horizontal)
    chevron.setContentCompressionResistancePriority(.required, for: .horizontal)
    toggle.addTarget(self, action: #selector(toggled), for: .valueChanged)
    toggle.setContentHuggingPriority(.required, for: .horizontal)
    toggle.setContentCompressionResistancePriority(.required, for: .horizontal)
    accStack.axis = .horizontal
    accStack.alignment = .center
    accStack.spacing = 6
    accStack.translatesAutoresizingMaskIntoConstraints = false
    accStack.addArrangedSubview(valueLabel)
    accStack.addArrangedSubview(chevron)
    accStack.addArrangedSubview(toggle)
    contentView.addSubview(accStack)

    separator.translatesAutoresizingMaskIntoConstraints = false
    contentView.addSubview(separator)

    let px = 1 / max(1, UIScreen.main.scale)
    textLeadingToChip = textStack.leadingAnchor.constraint(equalTo: chip.trailingAnchor, constant: 14)
    textLeadingToEdge = textStack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16)
    sepLeading = separator.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 60)
    let minH = contentView.heightAnchor.constraint(greaterThanOrEqualToConstant: 50)
    let topC = textStack.topAnchor.constraint(greaterThanOrEqualTo: contentView.topAnchor, constant: 11)
    let botC = textStack.bottomAnchor.constraint(lessThanOrEqualTo: contentView.bottomAnchor, constant: -11)
    NSLayoutConstraint.activate([
      chip.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16),
      chip.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
      chip.widthAnchor.constraint(equalToConstant: 30),
      chip.heightAnchor.constraint(equalToConstant: 30),
      glyph.centerXAnchor.constraint(equalTo: chip.centerXAnchor),
      glyph.centerYAnchor.constraint(equalTo: chip.centerYAnchor),
      textStack.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
      textStack.trailingAnchor.constraint(lessThanOrEqualTo: accStack.leadingAnchor, constant: -8),
      topC, botC, minH,
      accStack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -16),
      accStack.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
      valueLabel.widthAnchor.constraint(lessThanOrEqualTo: contentView.widthAnchor, multiplier: 0.45),
      separator.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
      separator.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
      separator.heightAnchor.constraint(equalToConstant: px),
      sepLeading,
      textLeadingToChip,
    ])
    isAccessibilityElement = true
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var isHighlighted: Bool {
    didSet { applyBackground() }
  }

  private func applyBackground() {
    contentView.backgroundColor = (isHighlighted && tappable) ? palette.press : .clear
  }

  func configure(_ row: CIRow, palette p: STPalette, first: Bool, last: Bool) {
    rowId = row.id
    palette = p
    let isToggle = row.kind == "t"
    tappable = !isToggle && !row.disabled
    var corners: CACornerMask = []
    if first { corners.formUnion([.layerMinXMinYCorner, .layerMaxXMinYCorner]) }
    if last { corners.formUnion([.layerMinXMaxYCorner, .layerMaxXMaxYCorner]) }
    layer.maskedCorners = corners
    layer.cornerRadius = corners.isEmpty ? 0 : 14

    let tint = row.destructive ? p.destructive : p.chipFg
    let img = CIText.image(row.icon, size: 15, weight: .regular, color: tint)
    let hasIcon = img != nil
    glyph.image = img
    chip.backgroundColor = row.destructive ? UIColor.clear : p.chipBg
    chip.isHidden = !hasIcon

    titleLabel.text = row.title
    titleLabel.textColor = row.destructive ? p.destructive : p.text
    subLabel.text = row.sub
    subLabel.textColor = p.secondary
    subLabel.isHidden = row.sub.isEmpty
    valueLabel.text = row.value
    valueLabel.textColor = p.secondary
    valueLabel.isHidden = row.value.isEmpty || isToggle

    let showChevron = row.kind == "c" && !row.destructive
    chevron.isHidden = !showChevron
    if showChevron {
      let cfg = UIImage.SymbolConfiguration(pointSize: 14, weight: .semibold)
      chevron.image = UIImage(systemName: "chevron.right", withConfiguration: cfg)?.withTintColor(p.tertiary, renderingMode: .alwaysOriginal)
    }
    toggle.isHidden = !isToggle
    if isToggle {
      toggle.onTintColor = p.switchOn
      toggle.backgroundColor = p.switchOff
      toggle.layer.cornerRadius = 15.5
      toggle.thumbTintColor = row.on ? p.switchThumb : .white
      toggle.isEnabled = !row.disabled
      if toggle.isOn != row.on { toggle.setOn(row.on, animated: window != nil) }
    }

    NSLayoutConstraint.deactivate([textLeadingToChip, textLeadingToEdge])
    NSLayoutConstraint.activate([hasIcon ? textLeadingToChip : textLeadingToEdge])
    separator.backgroundColor = p.separator
    separator.isHidden = last
    sepLeading.constant = hasIcon ? 60 : 16
    contentView.alpha = row.disabled ? 0.45 : 1

    isAccessibilityElement = !isToggle
    var parts = [row.title]
    if !row.value.isEmpty { parts.append(row.value) }
    if !row.sub.isEmpty { parts.append(row.sub) }
    accessibilityLabel = parts.joined(separator: ", ")
    accessibilityTraits = row.disabled ? [.button, .notEnabled] : .button
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

/// Recado / descrição do grupo (texto livre, várias linhas).
final class CIAboutCell: UICollectionViewCell {
  private let textLabel = UILabel()
  private let subLabel = UILabel()
  private var palette = STPalette(dark: false)
  private var tappable = true

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = true
    layer.cornerRadius = 14
    layer.cornerCurve = .continuous
    textLabel.translatesAutoresizingMaskIntoConstraints = false
    textLabel.font = UIFont.systemFont(ofSize: 16, weight: .regular)
    textLabel.numberOfLines = 0
    subLabel.translatesAutoresizingMaskIntoConstraints = false
    subLabel.font = UIFont.systemFont(ofSize: 13, weight: .regular)
    subLabel.numberOfLines = 2
    contentView.addSubview(textLabel)
    contentView.addSubview(subLabel)
    NSLayoutConstraint.activate([
      textLabel.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 12),
      textLabel.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16),
      textLabel.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -16),
      subLabel.topAnchor.constraint(equalTo: textLabel.bottomAnchor, constant: 4),
      subLabel.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16),
      subLabel.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -16),
      subLabel.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -12),
    ])
    isAccessibilityElement = true
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var isHighlighted: Bool {
    didSet { contentView.backgroundColor = (isHighlighted && tappable) ? palette.press : .clear }
  }

  func configure(_ row: CIRow, palette p: STPalette, first: Bool, last: Bool) {
    palette = p
    tappable = !row.disabled
    var corners: CACornerMask = []
    if first { corners.formUnion([.layerMinXMinYCorner, .layerMaxXMinYCorner]) }
    if last { corners.formUnion([.layerMinXMaxYCorner, .layerMaxXMaxYCorner]) }
    layer.maskedCorners = corners
    layer.cornerRadius = corners.isEmpty ? 0 : 14
    // Texto vazio + `val` = convite ("Adicionar descrição do grupo").
    let isPlaceholder = row.title.isEmpty
    textLabel.text = isPlaceholder ? row.value : row.title
    textLabel.textColor = isPlaceholder ? p.secondary : p.text
    subLabel.text = row.sub
    subLabel.textColor = p.secondary
    subLabel.isHidden = row.sub.isEmpty
    accessibilityLabel = [textLabel.text ?? "", row.sub].filter { !$0.isEmpty }.joined(separator: ", ")
    accessibilityTraits = row.disabled ? .staticText : .button
    contentView.backgroundColor = .clear
  }
}

/// Miniatura da faixa de mídia.
final class CIThumb: UIControl {
  private let imageView = UIImageView()
  private let play = UIImageView()
  private let durLabel = UILabel()
  private(set) var key = ""
  private var currentURL = ""
  /// [2026-10-19 profile-grid-native] grade 3 colunas pede mais pixels que a faixa (80 pt).
  var maxPixel: CGFloat = 260

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = true
    layer.cornerRadius = 8
    layer.cornerCurve = .continuous
    imageView.translatesAutoresizingMaskIntoConstraints = false
    imageView.contentMode = .scaleAspectFill
    imageView.clipsToBounds = true
    imageView.isUserInteractionEnabled = false
    addSubview(imageView)
    play.translatesAutoresizingMaskIntoConstraints = false
    play.contentMode = .center
    play.isUserInteractionEnabled = false
    let cfg = UIImage.SymbolConfiguration(pointSize: 11, weight: .bold)
    play.image = UIImage(systemName: "play.fill", withConfiguration: cfg)?.withTintColor(.white, renderingMode: .alwaysOriginal)
    play.layer.shadowColor = UIColor.black.cgColor
    play.layer.shadowOpacity = 0.5
    play.layer.shadowRadius = 2
    play.layer.shadowOffset = .zero
    addSubview(play)
    durLabel.translatesAutoresizingMaskIntoConstraints = false
    durLabel.font = UIFont.monospacedDigitSystemFont(ofSize: 11, weight: .semibold)
    durLabel.textColor = .white
    durLabel.layer.shadowColor = UIColor.black.cgColor
    durLabel.layer.shadowOpacity = 0.5
    durLabel.layer.shadowRadius = 2
    durLabel.layer.shadowOffset = .zero
    durLabel.isUserInteractionEnabled = false
    addSubview(durLabel)
    NSLayoutConstraint.activate([
      imageView.topAnchor.constraint(equalTo: topAnchor),
      imageView.bottomAnchor.constraint(equalTo: bottomAnchor),
      imageView.leadingAnchor.constraint(equalTo: leadingAnchor),
      imageView.trailingAnchor.constraint(equalTo: trailingAnchor),
      play.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
      play.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -5),
      durLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
      durLabel.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
    ])
    isAccessibilityElement = true
    accessibilityTraits = [.button, .image]
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var isHighlighted: Bool {
    didSet { alpha = isHighlighted ? 0.7 : 1 }
  }

  func configure(_ m: CIMedia, placeholder: UIColor) {
    key = m.key
    backgroundColor = placeholder
    play.isHidden = !m.video
    durLabel.text = m.dur
    durLabel.isHidden = !m.video || m.dur.isEmpty
    if m.url == currentURL && imageView.image != nil { return }
    currentURL = m.url
    if m.url.isEmpty {
      imageView.image = nil
      return
    }
    let px = maxPixel
    if let img = CLImageLoader.shared.cachedImage(m.url, maxPixel: px) {
      imageView.image = img
      return
    }
    imageView.image = nil
    let url = m.url
    CLImageLoader.shared.load(url, auth: m.auth, maxPixel: px) { [weak self] img in
      guard let self = self, self.currentURL == url else { return }
      self.imageView.image = img
    }
  }
}

/// "Mídia, links e docs" + contagem + seta, e a faixa horizontal de miniaturas.
final class CIMediaCell: UICollectionViewCell {
  private let header = UIControl()
  private let titleLabel = UILabel()
  private let countLabel = UILabel()
  private let chevron = UIImageView()
  private let strip = UIScrollView()
  private let stripStack = UIStackView()
  private let separator = UIView()
  private var thumbs: [CIThumb] = []
  private var stripHeight: NSLayoutConstraint!
  private var palette = STPalette(dark: false)

  var onSeeAll: (() -> Void)?
  var onItem: ((String) -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = true
    layer.cornerRadius = 14
    layer.cornerCurve = .continuous

    header.translatesAutoresizingMaskIntoConstraints = false
    header.addTarget(self, action: #selector(headerTapped), for: .touchUpInside)
    header.addTarget(self, action: #selector(headerDown), for: [.touchDown, .touchDragEnter])
    header.addTarget(self, action: #selector(headerUp), for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
    header.isAccessibilityElement = true
    header.accessibilityTraits = .button
    contentView.addSubview(header)
    titleLabel.translatesAutoresizingMaskIntoConstraints = false
    titleLabel.font = UIFont.systemFont(ofSize: 17, weight: .regular)
    titleLabel.isUserInteractionEnabled = false
    titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    header.addSubview(titleLabel)
    countLabel.translatesAutoresizingMaskIntoConstraints = false
    countLabel.font = UIFont.systemFont(ofSize: 15, weight: .regular)
    countLabel.isUserInteractionEnabled = false
    countLabel.setContentHuggingPriority(.required, for: .horizontal)
    header.addSubview(countLabel)
    chevron.translatesAutoresizingMaskIntoConstraints = false
    chevron.contentMode = .center
    chevron.isUserInteractionEnabled = false
    header.addSubview(chevron)

    strip.translatesAutoresizingMaskIntoConstraints = false
    strip.showsHorizontalScrollIndicator = false
    strip.alwaysBounceHorizontal = true
    contentView.addSubview(strip)
    stripStack.translatesAutoresizingMaskIntoConstraints = false
    stripStack.axis = .horizontal
    stripStack.spacing = 6
    stripStack.alignment = .fill
    stripStack.isLayoutMarginsRelativeArrangement = true
    stripStack.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16)
    strip.addSubview(stripStack)

    separator.translatesAutoresizingMaskIntoConstraints = false
    contentView.addSubview(separator)

    let px = 1 / max(1, UIScreen.main.scale)
    stripHeight = strip.heightAnchor.constraint(equalToConstant: 80)
    NSLayoutConstraint.activate([
      header.topAnchor.constraint(equalTo: contentView.topAnchor),
      header.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
      header.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
      header.heightAnchor.constraint(equalToConstant: 50),
      titleLabel.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 16),
      titleLabel.centerYAnchor.constraint(equalTo: header.centerYAnchor),
      titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: countLabel.leadingAnchor, constant: -8),
      countLabel.trailingAnchor.constraint(equalTo: chevron.leadingAnchor, constant: -6),
      countLabel.centerYAnchor.constraint(equalTo: header.centerYAnchor),
      chevron.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -16),
      chevron.centerYAnchor.constraint(equalTo: header.centerYAnchor),
      strip.topAnchor.constraint(equalTo: header.bottomAnchor),
      strip.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
      strip.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
      stripHeight,
      strip.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -12),
      stripStack.topAnchor.constraint(equalTo: strip.contentLayoutGuide.topAnchor),
      stripStack.bottomAnchor.constraint(equalTo: strip.contentLayoutGuide.bottomAnchor),
      stripStack.leadingAnchor.constraint(equalTo: strip.contentLayoutGuide.leadingAnchor),
      stripStack.trailingAnchor.constraint(equalTo: strip.contentLayoutGuide.trailingAnchor),
      stripStack.heightAnchor.constraint(equalTo: strip.frameLayoutGuide.heightAnchor),
      separator.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
      separator.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
      separator.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16),
      separator.heightAnchor.constraint(equalToConstant: px),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ row: CIRow, items: [CIMedia], palette p: STPalette, first: Bool, last: Bool) {
    palette = p
    var corners: CACornerMask = []
    if first { corners.formUnion([.layerMinXMinYCorner, .layerMaxXMinYCorner]) }
    if last { corners.formUnion([.layerMinXMaxYCorner, .layerMaxXMaxYCorner]) }
    layer.maskedCorners = corners
    layer.cornerRadius = corners.isEmpty ? 0 : 14
    titleLabel.text = row.title
    titleLabel.textColor = p.text
    countLabel.text = row.value
    countLabel.textColor = p.secondary
    let cfg = UIImage.SymbolConfiguration(pointSize: 14, weight: .semibold)
    chevron.image = UIImage(systemName: "chevron.right", withConfiguration: cfg)?.withTintColor(p.tertiary, renderingMode: .alwaysOriginal)
    header.accessibilityLabel = row.value.isEmpty ? row.title : "\(row.title), \(row.value)"
    separator.backgroundColor = p.separator
    separator.isHidden = last

    while thumbs.count < items.count {
      let t = CIThumb()
      t.translatesAutoresizingMaskIntoConstraints = false
      t.widthAnchor.constraint(equalToConstant: 80).isActive = true
      t.addTarget(self, action: #selector(thumbTapped(_:)), for: .touchUpInside)
      thumbs.append(t)
      stripStack.addArrangedSubview(t)
    }
    while thumbs.count > items.count {
      let t = thumbs.removeLast()
      stripStack.removeArrangedSubview(t)
      t.removeFromSuperview()
    }
    for (i, m) in items.enumerated() {
      thumbs[i].configure(m, placeholder: p.chipBg)
      thumbs[i].accessibilityLabel = row.title
    }
    let has = !items.isEmpty
    strip.isHidden = !has
    stripHeight.constant = has ? 80 : 0
  }

  @objc private func headerTapped() { onSeeAll?() }

  @objc private func headerDown() { header.backgroundColor = palette.press }

  @objc private func headerUp() { header.backgroundColor = .clear }

  @objc private func thumbTapped(_ sender: CIThumb) { onItem?(sender.key) }
}

/// Pílula "Admin" ao lado do nome.
final class CIPillLabel: UILabel {
  var inset = UIEdgeInsets(top: 2, left: 7, bottom: 2, right: 7)

  override func drawText(in rect: CGRect) {
    super.drawText(in: rect.inset(by: inset))
  }

  override var intrinsicContentSize: CGSize {
    let s = super.intrinsicContentSize
    if (text ?? "").isEmpty { return .zero }
    return CGSize(width: s.width + inset.left + inset.right, height: s.height + inset.top + inset.bottom)
  }
}

final class CIMemberCell: UICollectionViewCell {
  private let avatar = CIAvatarView()
  private let titleLabel = UILabel()
  private let pill = CIPillLabel()
  private let subLabel = UILabel()
  private let separator = UIView()
  private var palette = STPalette(dark: false)
  private var titleCenter: NSLayoutConstraint!

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = true
    layer.cornerRadius = 14
    layer.cornerCurve = .continuous
    avatar.maxPixel = 144
    avatar.translatesAutoresizingMaskIntoConstraints = false
    contentView.addSubview(avatar)
    titleLabel.translatesAutoresizingMaskIntoConstraints = false
    titleLabel.font = UIFont.systemFont(ofSize: 17, weight: .regular)
    titleLabel.numberOfLines = 1
    titleLabel.lineBreakMode = .byTruncatingTail
    titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    contentView.addSubview(titleLabel)
    pill.translatesAutoresizingMaskIntoConstraints = false
    pill.font = UIFont.systemFont(ofSize: 12, weight: .medium)
    pill.textAlignment = .center
    pill.layer.cornerRadius = 9
    pill.layer.masksToBounds = true
    pill.setContentHuggingPriority(.required, for: .horizontal)
    pill.setContentCompressionResistancePriority(.required, for: .horizontal)
    contentView.addSubview(pill)
    subLabel.translatesAutoresizingMaskIntoConstraints = false
    subLabel.font = UIFont.systemFont(ofSize: 14, weight: .regular)
    subLabel.numberOfLines = 1
    subLabel.lineBreakMode = .byTruncatingTail
    contentView.addSubview(subLabel)
    separator.translatesAutoresizingMaskIntoConstraints = false
    contentView.addSubview(separator)

    let px = 1 / max(1, UIScreen.main.scale)
    let minH = contentView.heightAnchor.constraint(greaterThanOrEqualToConstant: 60)
    titleCenter = titleLabel.centerYAnchor.constraint(equalTo: contentView.centerYAnchor, constant: -9)
    titleCenter.priority = .defaultHigh
    NSLayoutConstraint.activate([
      avatar.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16),
      avatar.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
      avatar.widthAnchor.constraint(equalToConstant: 40),
      avatar.heightAnchor.constraint(equalToConstant: 40),
      avatar.topAnchor.constraint(greaterThanOrEqualTo: contentView.topAnchor, constant: 10),
      avatar.bottomAnchor.constraint(lessThanOrEqualTo: contentView.bottomAnchor, constant: -10),
      titleLabel.leadingAnchor.constraint(equalTo: avatar.trailingAnchor, constant: 12),
      titleLabel.topAnchor.constraint(greaterThanOrEqualTo: contentView.topAnchor, constant: 10),
      titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: pill.leadingAnchor, constant: -8),
      pill.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -16),
      pill.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),
      pill.heightAnchor.constraint(equalToConstant: 18),
      subLabel.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
      subLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 2),
      subLabel.trailingAnchor.constraint(lessThanOrEqualTo: contentView.trailingAnchor, constant: -16),
      subLabel.bottomAnchor.constraint(lessThanOrEqualTo: contentView.bottomAnchor, constant: -10),
      titleCenter,
      minH,
      separator.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
      separator.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
      separator.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 68),
      separator.heightAnchor.constraint(equalToConstant: px),
    ])
    isAccessibilityElement = true
    accessibilityTraits = .button
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var isHighlighted: Bool {
    didSet { contentView.backgroundColor = isHighlighted ? palette.press : .clear }
  }

  func configure(_ m: CIMember, palette p: STPalette, first: Bool, last: Bool) {
    palette = p
    var corners: CACornerMask = []
    if first { corners.formUnion([.layerMinXMinYCorner, .layerMaxXMinYCorner]) }
    if last { corners.formUnion([.layerMinXMaxYCorner, .layerMaxXMaxYCorner]) }
    layer.maskedCorners = corners
    layer.cornerRadius = corners.isEmpty ? 0 : 14
    avatar.configure(m.pic)
    titleLabel.text = m.title
    titleLabel.textColor = p.text
    titleLabel.font = UIFont.systemFont(ofSize: 17, weight: m.me ? .medium : .regular)
    pill.text = m.pill
    pill.isHidden = m.pill.isEmpty
    pill.textColor = p.secondary
    pill.backgroundColor = p.chipBg
    pill.invalidateIntrinsicContentSize()
    subLabel.text = m.sub
    subLabel.textColor = p.secondary
    subLabel.isHidden = m.sub.isEmpty
    titleCenter.constant = m.sub.isEmpty ? 0 : -9
    separator.backgroundColor = p.separator
    separator.isHidden = last
    accessibilityLabel = [m.title, m.pill, m.sub].filter { !$0.isEmpty }.joined(separator: ", ")
    contentView.backgroundColor = .clear
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    contentView.backgroundColor = .clear
  }
}

/// Campo "Pesquisar membros" no topo da lista de membros.
final class CISearchCell: UICollectionViewCell, UITextFieldDelegate {
  private let field = UISearchTextField()
  private let separator = UIView()
  var onChange: ((String) -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = true
    layer.cornerRadius = 14
    layer.cornerCurve = .continuous
    field.translatesAutoresizingMaskIntoConstraints = false
    field.returnKeyType = .search
    field.autocorrectionType = .no
    field.autocapitalizationType = .none
    field.clearButtonMode = .whileEditing
    field.delegate = self
    field.addTarget(self, action: #selector(changed), for: .editingChanged)
    contentView.addSubview(field)
    separator.translatesAutoresizingMaskIntoConstraints = false
    contentView.addSubview(separator)
    let px = 1 / max(1, UIScreen.main.scale)
    NSLayoutConstraint.activate([
      field.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 10),
      field.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -10),
      field.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 12),
      field.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -12),
      field.heightAnchor.constraint(equalToConstant: 36),
      separator.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
      separator.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
      separator.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16),
      separator.heightAnchor.constraint(equalToConstant: px),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(placeholder: String, text: String, palette p: STPalette, first: Bool, last: Bool) {
    var corners: CACornerMask = []
    if first { corners.formUnion([.layerMinXMinYCorner, .layerMaxXMinYCorner]) }
    if last { corners.formUnion([.layerMinXMaxYCorner, .layerMaxXMaxYCorner]) }
    layer.maskedCorners = corners
    layer.cornerRadius = corners.isEmpty ? 0 : 14
    field.backgroundColor = p.chipBg
    field.textColor = p.text
    field.tintColor = p.text
    field.leftView?.tintColor = p.secondary
    field.attributedPlaceholder = NSAttributedString(string: placeholder, attributes: [.foregroundColor: p.secondary])
    field.keyboardAppearance = p.dark ? .dark : .light
    // Nunca sobrescreve o que o usuário está digitando.
    if !field.isFirstResponder && (field.text ?? "") != text { field.text = text }
    separator.backgroundColor = p.separator
    separator.isHidden = last
  }

  @objc private func changed() { onChange?(field.text ?? "") }

  func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    textField.resignFirstResponder()
    return true
  }
}

/// Linha de estado dentro do cartão (carregando / nenhum resultado).
final class CITextCell: UICollectionViewCell {
  private let label = UILabel()
  private let spinner = UIActivityIndicatorView(style: .medium)

  override init(frame: CGRect) {
    super.init(frame: frame)
    label.translatesAutoresizingMaskIntoConstraints = false
    label.font = UIFont.systemFont(ofSize: 15)
    label.textAlignment = .center
    label.numberOfLines = 2
    spinner.translatesAutoresizingMaskIntoConstraints = false
    spinner.hidesWhenStopped = true
    contentView.addSubview(label)
    contentView.addSubview(spinner)
    NSLayoutConstraint.activate([
      label.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 16),
      label.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -16),
      label.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16),
      label.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -16),
      label.heightAnchor.constraint(greaterThanOrEqualToConstant: 20),
      spinner.centerXAnchor.constraint(equalTo: contentView.centerXAnchor),
      spinner.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(text: String, loading: Bool, palette p: STPalette) {
    label.text = loading ? " " : text
    label.textColor = p.secondary
    spinner.color = p.secondary
    if loading { spinner.startAnimating() } else { spinner.stopAnimating() }
  }
}

/// Cabeçalho (acima do cartão) ou rodapé explicativo (abaixo do cartão).
final class CICaptionCell: UICollectionViewCell {
  private let label = UILabel()
  private var topC: NSLayoutConstraint!
  private var bottomC: NSLayoutConstraint!

  override init(frame: CGRect) {
    super.init(frame: frame)
    label.translatesAutoresizingMaskIntoConstraints = false
    label.numberOfLines = 0
    contentView.addSubview(label)
    topC = label.topAnchor.constraint(equalTo: contentView.topAnchor)
    bottomC = label.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -8)
    NSLayoutConstraint.activate([
      label.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16),
      label.trailingAnchor.constraint(lessThanOrEqualTo: contentView.trailingAnchor, constant: -16),
      topC,
      bottomC,
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ text: String, footer: Bool, palette p: STPalette) {
    label.font = UIFont.systemFont(ofSize: 13, weight: .regular)
    label.textColor = footer ? p.secondary : p.header
    label.text = text
    topC.constant = footer ? 8 : 0
    bottomC.constant = footer ? 0 : -8
    isAccessibilityElement = true
    accessibilityLabel = text
    accessibilityTraits = footer ? .staticText : .header
  }
}

// MARK: - [2026-10-18 elegance] Cabeçalho que encolhe (Telegram)
//
// Modo `headerMode = "collapse"` (apiVersion ≥ 2): a 1ª célula da lista vira um
// ESPAÇADOR (CIHeroSpacerCell) com a altura do cabeçalho, e o desenho fica no
// CIHeaderOverlay, por cima da lista, recalculado a cada scrollViewDidScroll
// (só frames/alpha/transform → 60/120 fps, sem ponte):
//   rolar p/ cima → avatar encolhe e some sob a barra; nome/subtítulo sobem e
//   assentam no título da barra; ladrilhos de ação esmaecem; a barra (fundo +
//   hairline) aparece quando o nome encaixa.
//   puxar p/ baixo → avatar cresce (rubber band); além de 72 pt com foto →
//   a foto vira retângulo de largura total (expansão do perfil do Telegram),
//   nome/subtítulo em branco no canto inferior esquerdo sobre um degradê.
// O overlay só recebe toque no X (e na barra quando opaca); avatar/ladrilhos
// são resolvidos pelo espaçador (toques passam pela lista → rolar de qualquer
// ponto continua funcionando, como no Telegram).

@inline(__always) func ciLerp(_ a: CGFloat, _ b: CGFloat, _ t: CGFloat) -> CGFloat { return a + (b - a) * t }

@inline(__always) func ciClamp01(_ v: CGFloat) -> CGFloat { return max(0, min(1, v)) }

func ciSmooth(_ e0: CGFloat, _ e1: CGFloat, _ x: CGFloat) -> CGFloat {
  if e1 <= e0 { return x >= e1 ? 1 : 0 }
  let t = ciClamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

func ciMix(_ a: UIColor, _ b: UIColor, _ t: CGFloat) -> UIColor {
  if t <= 0 { return a }
  if t >= 1 { return b }
  var r1: CGFloat = 0, g1: CGFloat = 0, b1: CGFloat = 0, a1: CGFloat = 0
  var r2: CGFloat = 0, g2: CGFloat = 0, b2: CGFloat = 0, a2: CGFloat = 0
  if !a.getRed(&r1, green: &g1, blue: &b1, alpha: &a1) { return t < 0.5 ? a : b }
  if !b.getRed(&r2, green: &g2, blue: &b2, alpha: &a2) { return t < 0.5 ? a : b }
  return UIColor(red: ciLerp(r1, r2, t), green: ciLerp(g1, g2, t), blue: ciLerp(b1, b2, t), alpha: ciLerp(a1, a2, t))
}

/// Célula vazia do topo no modo "collapse": reserva a altura do cabeçalho e
/// repassa os toques (fase 0 = começou, 1 = terminou, 2 = cancelou).
final class CIHeroSpacerCell: UICollectionViewCell {
  var onTouch: ((Int, UITouch) -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    contentView.backgroundColor = .clear
    isAccessibilityElement = false
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
    super.touchesBegan(touches, with: event)
    if let t = touches.first { onTouch?(0, t) }
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
    super.touchesEnded(touches, with: event)
    if let t = touches.first { onTouch?(1, t) }
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
    super.touchesCancelled(touches, with: event)
    if let t = touches.first { onTouch?(2, t) }
  }
}

enum CIHeaderHit: Equatable {
  case empty
  case avatar
  case action(String)
  /// [2026-10-18 profile-native] foto expandida: -1 = anterior, 1 = próxima.
  case photo(Int)
}

final class CIHeaderOverlay: UIView {
  static let navH: CGFloat = 56
  static let avatarSide: CGFloat = 104
  static let avatarTop: CGFloat = 8
  static let actionsH: CGFloat = 64
  /// [2026-10-19 profile-cover-hero] com capa, o avatar desce isso (a capa ocupa o topo).
  static let coverShift: CGFloat = 64

  // [2026-10-19 profile-cover-hero] apiVersion 5: capa atrás do avatar (degradê
  // até o fundo da página + véu escuro no topo p/ a seta/Editar) e anel de status.
  private let coverView = UIImageView()
  private let coverFade = UIView()
  private let coverFadeLayer = CAGradientLayer()
  private let coverTopLayer = CAGradientLayer()
  private var coverURL = ""
  private var hasCover = false
  /// [2026-10-21 foto-capa-studio] apiVersion 7: toque na capa (dono) → onAction "__cover".
  static let coverActionKey = "__cover"
  private var coverTap = false
  private let avatarDisc = UIView()
  private let ringView = UIView()
  private let ringGradient = CAGradientLayer()
  private let ringMask = CAShapeLayer()
  private var ringMode = ""
  private var lastButtonMix: CGFloat = -1

  private let avatar = CIAvatarView()
  private let scrim = UIView()
  private let scrimLayer = CAGradientLayer()
  private let badge = UIView()
  private let badgeIcon = UIImageView()
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let actionsRow = UIView()
  private var tiles: [CIActionTile] = []
  private let navBg = UIView()
  private let hairline = UIView()
  private let titleLabel = UILabel()
  private let subLabel = UILabel()
  let closeButton = UIButton(type: .system)
  // [2026-10-18 profile-native] botão de texto da barra ("Editar") + carrossel.
  let navButton = UIButton(type: .system)
  private let segRow = UIView()
  private var segBars: [UIView] = []
  private var photoList: [CIPic] = []
  private(set) var photoIndex = 0
  private var isBack = false
  private var navKey = ""
  private var navW: CGFloat = 0

  private var palette = STPalette(dark: false)
  private var hasSub = false
  private var hasActions = false
  private var showBadge = false
  private var picURL = ""
  private var titleFit: CGFloat = 0
  private var subFit: CGFloat = 0
  private var pressed: CIHeaderHit = .empty
  private var lastColorE: CGFloat = -1
  /// Opacidade atual da barra (a barra opaca bloqueia toques nas linhas por baixo).
  private(set) var navAlpha: CGFloat = 0

  var onClose: (() -> Void)?
  var onNav: ((String) -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    clipsToBounds = true

    coverView.contentMode = .scaleAspectFill
    coverView.clipsToBounds = true
    coverView.isUserInteractionEnabled = false
    coverView.isHidden = true
    addSubview(coverView)
    coverFade.isUserInteractionEnabled = false
    coverFade.isHidden = true
    coverTopLayer.colors = [UIColor(white: 0, alpha: 0.28).cgColor, UIColor(white: 0, alpha: 0).cgColor]
    coverTopLayer.locations = [0, 1]
    coverFade.layer.addSublayer(coverTopLayer)
    coverFadeLayer.locations = [0.38, 1]
    coverFade.layer.addSublayer(coverFadeLayer)
    addSubview(coverFade)

    ringGradient.startPoint = CGPoint(x: 0, y: 0)
    ringGradient.endPoint = CGPoint(x: 1, y: 1)
    ringMask.fillColor = UIColor.clear.cgColor
    ringMask.strokeColor = UIColor.black.cgColor
    ringGradient.mask = ringMask
    ringView.layer.addSublayer(ringGradient)
    ringView.isUserInteractionEnabled = false
    ringView.isHidden = true
    addSubview(ringView)
    avatarDisc.isUserInteractionEnabled = false
    avatarDisc.isHidden = true
    addSubview(avatarDisc)

    avatar.maxPixel = 1080
    avatar.isAccessibilityElement = true
    avatar.accessibilityTraits = [.button, .image]
    addSubview(avatar)

    scrim.isUserInteractionEnabled = false
    scrimLayer.colors = [UIColor(white: 0, alpha: 0).cgColor, UIColor(white: 0, alpha: 0.55).cgColor]
    scrimLayer.locations = [0.5, 1]
    scrim.layer.addSublayer(scrimLayer)
    scrim.alpha = 0
    addSubview(scrim)

    badge.isUserInteractionEnabled = false
    badge.layer.borderWidth = 3
    badgeIcon.contentMode = .center
    badge.addSubview(badgeIcon)
    spinner.hidesWhenStopped = true
    badge.addSubview(spinner)
    addSubview(badge)

    actionsRow.isUserInteractionEnabled = false
    addSubview(actionsRow)

    navBg.isUserInteractionEnabled = false
    navBg.alpha = 0
    addSubview(navBg)
    hairline.isUserInteractionEnabled = false
    hairline.alpha = 0
    addSubview(hairline)

    titleLabel.font = UIFont.systemFont(ofSize: 22, weight: .semibold)
    titleLabel.textAlignment = .center
    titleLabel.lineBreakMode = .byTruncatingTail
    titleLabel.numberOfLines = 1
    titleLabel.isUserInteractionEnabled = false
    titleLabel.accessibilityTraits = .header
    addSubview(titleLabel)

    subLabel.font = UIFont.systemFont(ofSize: 15, weight: .regular)
    subLabel.textAlignment = .center
    subLabel.lineBreakMode = .byTruncatingTail
    subLabel.numberOfLines = 1
    subLabel.isUserInteractionEnabled = false
    addSubview(subLabel)

    closeButton.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold)), for: .normal)
    closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
    closeButton.layer.shadowColor = UIColor.black.cgColor
    closeButton.layer.shadowOffset = CGSize(width: 0, height: 1)
    closeButton.layer.shadowRadius = 3
    closeButton.layer.shadowOpacity = 0
    addSubview(closeButton)

    navButton.titleLabel?.font = UIFont.systemFont(ofSize: 17, weight: .regular)
    navButton.addTarget(self, action: #selector(navTapped), for: .touchUpInside)
    navButton.layer.shadowColor = UIColor.black.cgColor
    navButton.layer.shadowOffset = CGSize(width: 0, height: 1)
    navButton.layer.shadowRadius = 3
    navButton.layer.shadowOpacity = 0
    navButton.isHidden = true
    addSubview(navButton)

    segRow.isUserInteractionEnabled = false
    segRow.alpha = 0
    segRow.isHidden = true
    addSubview(segRow)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  // MARK: Geometria (pontos, conteúdo em repouso)

  /// Topo do avatar em repouso (desce com capa).
  private var aTop: CGFloat { return CIHeaderOverlay.avatarTop + (hasCover ? CIHeaderOverlay.coverShift : 0) }
  /// Altura da capa em repouso (até um pouco abaixo do meio do avatar).
  private var coverH: CGFloat { return aTop + CIHeaderOverlay.avatarSide * 0.5 + 22 }
  private var titleY0: CGFloat { return aTop + CIHeaderOverlay.avatarSide + 28 }
  private var subY0: CGFloat { return titleY0 + 28 }
  private var textBottom0: CGFloat { return hasSub ? subY0 + 10 : titleY0 + 14 }
  private var actionsTop0: CGFloat { return textBottom0 + 20 }
  private var navTitleY: CGFloat { return hasSub ? 19 : CIHeaderOverlay.navH / 2 }

  /// Altura do espaçador (a mesma do hero estático: foto + nome + subtítulo + ações).
  var heroHeight: CGFloat {
    return (hasActions ? actionsTop0 + CIHeaderOverlay.actionsH : textBottom0) + 24
  }

  /// Rolagem em que o nome encaixa no título da barra.
  var dockRel: CGFloat { return max(1, titleY0 - navTitleY) }

  var hasPhoto: Bool { return !picURL.isEmpty && avatar.hasImage }

  private var photoH: CGFloat {
    let W = bounds.width
    let H = bounds.height
    return max(200, min(W, max(260, H * 0.52)))
  }

  /// Quanto o conteúdo desce no modo foto (vira contentInset.top, animado).
  var photoExtra: CGFloat {
    let zone = photoH + (hasActions ? 12 + CIHeaderOverlay.actionsH + 24 : 24)
    return max(0, zone - heroHeight)
  }

  // MARK: Dados

  func configure(_ h: CIHero, palette p: STPalette, labels: CLLabels) {
    palette = p
    lastColorE = -1
    var list: [CIPic] = []
    if !h.pic.url.isEmpty { list.append(h.pic) }
    for x in h.photos {
      var q = x
      q.initials = h.pic.initials
      q.grad = h.pic.grad
      list.append(q)
    }
    let curURL = photoIndex < photoList.count ? photoList[photoIndex].url : ""
    photoList = list
    if let i = list.firstIndex(where: { $0.url == curURL }), !curURL.isEmpty { photoIndex = i } else { photoIndex = 0 }
    avatar.configure(photoIndex < list.count ? list[photoIndex] : h.pic)
    picURL = h.pic.url
    rebuildSegments()
    avatar.accessibilityLabel = labels.get("photo", "Ver foto")
    titleLabel.text = h.title
    subLabel.text = h.sub
    hasSub = !h.sub.isEmpty
    subLabel.isHidden = !hasSub
    titleFit = ceil(titleLabel.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: 30)).width)
    subFit = ceil(subLabel.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: 22)).width)

    configureCover(h.cover, palette: p)
    coverTap = h.coverTap
    ringMode = h.ring == "seen" || h.ring == "unseen" ? h.ring : ""
    ringView.isHidden = ringMode.isEmpty
    if ringMode == "seen" {
      ringGradient.colors = [p.tertiary.cgColor, p.tertiary.cgColor]
      ringMask.lineWidth = 2
    } else {
      ringGradient.colors = [p.text.cgColor, UIColor(red: 0.976, green: 0.451, blue: 0.086, alpha: 1).cgColor]
      ringMask.lineWidth = 3
    }
    avatarDisc.backgroundColor = p.pageBg
    avatarDisc.isHidden = !(hasCover || !ringMode.isEmpty)
    lastButtonMix = -1

    showBadge = h.badge == "camera" || h.busy
    badge.isHidden = !showBadge
    badge.backgroundColor = p.text
    badge.layer.borderColor = p.pageBg.cgColor
    if h.busy {
      badgeIcon.image = nil
      spinner.color = p.pageBg
      spinner.startAnimating()
    } else {
      spinner.stopAnimating()
      badgeIcon.image = CIText.image("camera", size: 14, weight: .semibold, color: p.pageBg)
    }

    while tiles.count < h.actions.count {
      let tile = CIActionTile()
      tile.isUserInteractionEnabled = false
      tiles.append(tile)
      actionsRow.addSubview(tile)
    }
    while tiles.count > h.actions.count {
      let tile = tiles.removeLast()
      tile.removeFromSuperview()
    }
    for (i, a) in h.actions.enumerated() { tiles[i].configure(a, palette: p) }
    hasActions = !h.actions.isEmpty

    navBg.backgroundColor = p.pageBg
    hairline.backgroundColor = p.separator
    closeButton.accessibilityLabel = labels.get("close", "Fechar")
    if h.back != isBack {
      isBack = h.back
      let sym = isBack ? "chevron.left" : "xmark"
      let size: CGFloat = isBack ? 20 : 17
      closeButton.setImage(UIImage(systemName: sym, withConfiguration: UIImage.SymbolConfiguration(pointSize: size, weight: .semibold)), for: .normal)
    }
    navKey = h.navKey
    navButton.isHidden = h.navKey.isEmpty || h.navLabel.isEmpty
    navButton.setTitle(h.navLabel, for: .normal)
    navButton.accessibilityLabel = h.navLabel
    navW = navButton.isHidden ? 0 : min(140, ceil(navButton.sizeThatFits(CGSize(width: 200, height: 44)).width) + 16)
    pressed = .empty
    setNeedsLayout()
  }

  // MARK: Capa (apiVersion 5)

  private func configureCover(_ c: CIPic, palette p: STPalette) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    coverFadeLayer.colors = [p.pageBg.withAlphaComponent(0).cgColor, p.pageBg.cgColor]
    CATransaction.commit()
    coverView.backgroundColor = p.chipBg
    let had = hasCover
    hasCover = !c.url.isEmpty
    coverView.isHidden = !hasCover
    coverFade.isHidden = !hasCover
    if had != hasCover { setNeedsLayout() }
    if !hasCover {
      coverURL = ""
      coverView.image = nil
      return
    }
    if c.url == coverURL && coverView.image != nil { return }
    coverURL = c.url
    let px: CGFloat = 1080
    if let img = CLImageLoader.shared.cachedImage(c.url, maxPixel: px) {
      coverView.image = img
      return
    }
    coverView.image = nil
    let url = c.url
    CLImageLoader.shared.load(url, auth: c.auth, maxPixel: px) { [weak self] img in
      guard let self = self, self.coverURL == url else { return }
      if img != nil && self.window != nil {
        UIView.transition(with: self.coverView, duration: 0.2, options: [.transitionCrossDissolve, .allowUserInteraction], animations: {
          self.coverView.image = img
        }, completion: nil)
      } else {
        self.coverView.image = img
      }
    }
  }

  private func layoutRing(side: CGFloat) {
    let bounds = CGRect(x: 0, y: 0, width: side, height: side)
    if ringView.bounds.size == bounds.size { return }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    ringView.bounds = bounds
    ringGradient.frame = bounds
    ringMask.frame = bounds
    let inset: CGFloat = 1.5
    ringMask.path = UIBezierPath(ovalIn: bounds.insetBy(dx: inset, dy: inset)).cgPath
    CATransaction.commit()
  }

  // MARK: Carrossel (foto expandida)

  private func rebuildSegments() {
    let n = photoList.count > 1 ? photoList.count : 0
    while segBars.count < n {
      let b = UIView()
      b.layer.cornerRadius = 1.5
      b.isUserInteractionEnabled = false
      segBars.append(b)
      segRow.addSubview(b)
    }
    while segBars.count > n {
      let b = segBars.removeLast()
      b.removeFromSuperview()
    }
    segRow.isHidden = n == 0
    paintSegments()
  }

  private func paintSegments() {
    for (i, b) in segBars.enumerated() {
      b.backgroundColor = UIColor(white: 1, alpha: i == photoIndex ? 0.95 : 0.4)
    }
  }

  /// Avança/volta uma foto; false = não há para onde ir.
  @discardableResult
  func cycle(_ dir: Int) -> Bool {
    let n = photoList.count
    if n < 2 { return false }
    let next = photoIndex + (dir < 0 ? -1 : 1)
    if next < 0 || next >= n { return false }
    photoIndex = next
    avatar.configure(photoList[next], keep: true)
    paintSegments()
    return true
  }

  /// Volta para a foto principal (ao recolher a foto expandida).
  func resetPhoto() {
    if photoIndex == 0 || photoList.isEmpty { return }
    photoIndex = 0
    avatar.configure(photoList[0], keep: true)
    paintSegments()
  }

  // MARK: Quadro a quadro

  /// rel = rolagem relativa ao repouso (0 = topo; < 0 = puxando p/ baixo).
  /// e = 0…1 expansão da foto.
  func apply(rel: CGFloat, expand eIn: CGFloat) {
    let W = bounds.width
    if W <= 0 { return }
    let e = ciClamp01(eIn)
    let navH = CIHeaderOverlay.navH
    let A = CIHeaderOverlay.avatarSide
    let st = max(0, -rel)
    let up = max(0, rel)
    let dock = dockRel
    let k = min(1, up / dock)
    let hl = 1 / max(1, UIScreen.main.scale)

    // ── Avatar (normal: círculo que encolhe/cresce; foto: largura total) ──
    var nSide = A
    var nCY = aTop + A / 2
    var nAlpha: CGFloat = 1
    if st > 0 {
      nSide = A * (1 + min(0.3, st / 260))
      nCY += st * 0.5
    } else {
      nSide = A * ciLerp(1, 0.35, k)
      nCY -= up * 0.6
      nAlpha = 1 - ciSmooth(0.35, 0.85, k)
    }
    let pH = photoH
    let pTop = -up
    let nRect = CGRect(x: W / 2 - nSide / 2, y: nCY - nSide / 2, width: nSide, height: nSide)
    let pRect = CGRect(x: 0, y: pTop, width: W, height: pH + st)
    let aRect = CGRect(
      x: ciLerp(nRect.minX, pRect.minX, e),
      y: ciLerp(nRect.minY, pRect.minY, e),
      width: ciLerp(nRect.width, pRect.width, e),
      height: ciLerp(nRect.height, pRect.height, e)
    )
    avatar.frame = aRect
    avatar.roundness = 1 - e
    avatar.alpha = ciLerp(nAlpha, 1, e)
    scrim.frame = aRect
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    scrimLayer.frame = scrim.bounds
    CATransaction.commit()
    scrim.alpha = e

    // [2026-10-19 profile-cover-hero] Capa: anda com o conteúdo, estica ao
    // puxar (presa no topo) e some na foto expandida. Disco da cor da página
    // + anel de status atrás do avatar (só transform → sem refazer o traço).
    if hasCover {
      let cRect = CGRect(x: 0, y: -up, width: W, height: coverH + st)
      coverView.frame = cRect
      coverFade.frame = cRect
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      coverFadeLayer.frame = coverFade.bounds
      coverTopLayer.frame = CGRect(x: 0, y: 0, width: cRect.width, height: min(cRect.height, CIHeaderOverlay.navH + 36))
      CATransaction.commit()
      coverView.alpha = 1 - e
      coverFade.alpha = 1 - e
    }
    let discOn = !avatarDisc.isHidden
    if discOn || !ringMode.isEmpty {
      let sc = nSide / A
      let cx = W / 2
      let fade = nAlpha * (1 - e)
      if discOn {
        let ds = A + 8
        avatarDisc.transform = .identity
        avatarDisc.bounds = CGRect(x: 0, y: 0, width: ds, height: ds)
        avatarDisc.layer.cornerRadius = ds / 2
        avatarDisc.center = CGPoint(x: cx, y: nCY)
        avatarDisc.transform = CGAffineTransform(scaleX: sc, y: sc)
        avatarDisc.alpha = fade
      }
      if !ringMode.isEmpty {
        let rs = A + 16
        ringView.transform = .identity
        layoutRing(side: rs)
        ringView.center = CGPoint(x: cx, y: nCY)
        ringView.transform = CGAffineTransform(scaleX: sc, y: sc)
        ringView.alpha = fade
      }
    }

    // Selo da câmera (admin) acompanha a borda do círculo.
    if showBadge {
      let bs: CGFloat = 34 * max(0.5, min(1.2, nSide / A))
      badge.bounds = CGRect(x: 0, y: 0, width: bs, height: bs)
      badge.center = CGPoint(x: aRect.maxX - 14 * bs / 34, y: aRect.maxY - 14 * bs / 34)
      badge.layer.cornerRadius = bs / 2
      badgeIcon.frame = badge.bounds
      spinner.center = CGPoint(x: bs / 2, y: bs / 2)
      badge.alpha = nAlpha * (1 - e) * (1 - ciSmooth(0.1, 0.4, k))
    }

    // ── Nome / subtítulo ──
    let tDock = ciClamp01((up - (dock - 40)) / 40)
    let nTitleY = max(navTitleY, titleY0 - rel)
    let nTitleS = ciLerp(1, 17.0 / 22.0, tDock)
    let nSubY = nTitleY + ciLerp(subY0 - titleY0, 20, tDock)
    let nSubS = ciLerp(1, 13.0 / 15.0, tDock)
    let pBottom = pTop + pH + st
    let subGap: CGFloat = hasSub ? 22 : 0
    let pTitleY = pBottom - 16 - subGap - 14
    let pSubY = pBottom - 16 - 10

    let tw = min(titleFit, max(40, W - 48))
    let sw = min(subFit, max(40, W - 48))
    titleLabel.bounds = CGRect(x: 0, y: 0, width: tw, height: 28)
    subLabel.bounds = CGRect(x: 0, y: 0, width: sw, height: 20)
    titleLabel.center = CGPoint(x: ciLerp(W / 2, 16 + tw / 2, e), y: ciLerp(nTitleY, pTitleY, e))
    subLabel.center = CGPoint(x: ciLerp(W / 2, 16 + sw / 2, e), y: ciLerp(nSubY, pSubY, e))
    let ts = ciLerp(nTitleS, 1, e)
    let ss = ciLerp(nSubS, 1, e)
    titleLabel.transform = CGAffineTransform(scaleX: ts, y: ts)
    subLabel.transform = CGAffineTransform(scaleX: ss, y: ss)
    if abs(e - lastColorE) > 0.004 {
      lastColorE = e
      titleLabel.textColor = ciMix(palette.text, .white, e)
      subLabel.textColor = ciMix(palette.secondary, UIColor(white: 1, alpha: 0.86), e)
    }
    // Seta/X e "Editar": brancos sobre a foto expandida E sobre a capa (até a barra aparecer).
    let coverMix: CGFloat = hasCover ? 1 - ciSmooth(dock - 30, dock, up) : 0
    let bm = max(e, coverMix)
    if abs(bm - lastButtonMix) > 0.004 {
      lastButtonMix = bm
      closeButton.tintColor = ciMix(palette.text, .white, bm)
      closeButton.layer.shadowOpacity = Float(0.35 * bm)
      navButton.tintColor = ciMix(palette.text, .white, bm)
      navButton.layer.shadowOpacity = Float(0.35 * bm)
    }

    // ── Ladrilhos de ação: andam com o conteúdo e somem antes da barra ──
    actionsRow.isHidden = !hasActions
    if hasActions {
      let nTop = actionsTop0 - rel
      let pActTop = pH + 12 - rel
      let top = ciLerp(nTop, pActTop, e)
      let rowW = min(W - 32, 460)
      let a = ciClamp01((top - navH) / 40)
      actionsRow.transform = .identity
      actionsRow.bounds = CGRect(x: 0, y: 0, width: rowW, height: CIHeaderOverlay.actionsH)
      actionsRow.center = CGPoint(x: W / 2, y: top + CIHeaderOverlay.actionsH / 2)
      let sc = ciLerp(0.92, 1, a)
      actionsRow.transform = CGAffineTransform(scaleX: sc, y: sc)
      actionsRow.alpha = a
      let n = CGFloat(tiles.count)
      let gap: CGFloat = 8
      let tWidth = floor((rowW - gap * max(0, n - 1)) / max(1, n))
      for (i, t) in tiles.enumerated() {
        let f = CGRect(x: CGFloat(i) * (tWidth + gap), y: 0, width: tWidth, height: CIHeaderOverlay.actionsH)
        if t.bounds.size != f.size || t.center != CGPoint(x: f.midX, y: f.midY) {
          t.bounds = CGRect(origin: .zero, size: f.size)
          t.center = CGPoint(x: f.midX, y: f.midY)
        }
      }
    }

    // ── Barra: aparece quando o nome encaixa (some no modo foto) ──
    let barA = ciSmooth(dock - 30, dock, up) * (1 - e)
    navAlpha = barA
    navBg.frame = CGRect(x: 0, y: 0, width: W, height: navH)
    navBg.alpha = barA
    hairline.frame = CGRect(x: 0, y: navH - hl, width: W, height: hl)
    hairline.alpha = barA
    if isBack {
      closeButton.frame = CGRect(x: 4, y: (navH - 44) / 2, width: 44, height: 44)
      navButton.frame = CGRect(x: W - 8 - navW, y: (navH - 44) / 2, width: navW, height: 44)
    } else {
      closeButton.frame = CGRect(x: W - 52, y: (navH - 44) / 2, width: 44, height: 44)
      navButton.frame = CGRect(x: 8, y: (navH - 44) / 2, width: navW, height: 44)
    }

    // ── Carrossel: tracinhos no topo da foto expandida ──
    if !segBars.isEmpty {
      let n = CGFloat(segBars.count)
      let gap: CGFloat = 4
      let rowW = max(10, W - 16)
      let bw = max(2, (rowW - gap * (n - 1)) / n)
      segRow.frame = CGRect(x: 8, y: aRect.minY + 6, width: rowW, height: 3)
      for (i, b) in segBars.enumerated() {
        b.frame = CGRect(x: CGFloat(i) * (bw + gap), y: 0, width: bw, height: 3)
      }
      segRow.alpha = ciSmooth(0.6, 1, e)
    }
  }

  // MARK: Toques

  func hit(_ p: CGPoint) -> CIHeaderHit {
    if hasActions && !actionsRow.isHidden && actionsRow.alpha > 0.5 {
      let lp = actionsRow.convert(p, from: self)
      for t in tiles where t.frame.contains(lp) { return .action(t.key) }
    }
    if avatar.alpha > 0.4 && avatar.frame.insetBy(dx: -6, dy: -6).contains(p) && p.y > CIHeaderOverlay.navH * navAlpha {
      // Foto expandida com várias fotos: terços laterais trocam a foto (Telegram).
      if photoList.count > 1 && avatar.roundness < 0.5 {
        let w = max(1, avatar.frame.width)
        let x = p.x - avatar.frame.minX
        if x < w * 0.3 { return .photo(-1) }
        if x > w * 0.7 { return .photo(1) }
      }
      return .avatar
    }
    if coverTap && hasCover && !coverView.isHidden && coverView.alpha > 0.5 && p.y > CIHeaderOverlay.navH && coverView.frame.contains(p) {
      return .action(CIHeaderOverlay.coverActionKey)
    }
    return .empty
  }

  func setPressed(_ h: CIHeaderHit) {
    if h == pressed { return }
    pressed = h
    for t in tiles {
      let on = h == .action(t.key)
      if t.isHighlighted == on { continue }
      t.isHighlighted = on
      UIView.animate(withDuration: on ? 0.12 : 0.34, delay: 0, usingSpringWithDamping: 0.7, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
        t.transform = on ? CGAffineTransform(scaleX: 0.94, y: 0.94) : .identity
      }
    }
  }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    if isHidden || alpha < 0.01 { return nil }
    if !closeButton.isHidden && closeButton.frame.insetBy(dx: -4, dy: -4).contains(point) { return closeButton }
    if !navButton.isHidden && navButton.frame.insetBy(dx: -4, dy: -4).contains(point) { return navButton }
    if navAlpha > 0.5 && point.y < CIHeaderOverlay.navH { return self }
    return nil
  }

  @objc private func closeTapped() { onClose?() }

  @objc private func navTapped() {
    if navKey.isEmpty { return }
    onNav?(navKey)
  }
}


// MARK: - [2026-10-19 profile-grid-native] Grade de publicações + faixa de destaques (apiVersion 5)

/// Uma miniatura da grade 3 colunas (linha k "grid"). Cada publicação é uma
/// célula própria do UICollectionView (virtualizada, reaproveitada); o toque
/// vem pelo didSelect da lista → onMediaPress {key}.
final class CIGridCell: UICollectionViewCell {
  private let thumb = CIThumb()
  private(set) var key = ""

  override init(frame: CGRect) {
    super.init(frame: frame)
    thumb.isUserInteractionEnabled = false
    thumb.layer.cornerRadius = 0
    thumb.maxPixel = 420
    thumb.translatesAutoresizingMaskIntoConstraints = false
    contentView.addSubview(thumb)
    NSLayoutConstraint.activate([
      thumb.topAnchor.constraint(equalTo: contentView.topAnchor),
      thumb.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
      thumb.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
      thumb.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
    ])
    isAccessibilityElement = true
    accessibilityTraits = [.button, .image]
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var isHighlighted: Bool {
    didSet { contentView.alpha = isHighlighted ? 0.7 : 1 }
  }

  func configure(_ m: CIMedia, palette p: STPalette, label: String) {
    key = m.key
    thumb.configure(m, placeholder: p.chipBg)
    accessibilityLabel = label
  }
}

/// Um destaque: capa redonda dentro de um anel em degradê (CAGradientLayer
/// mascarado por um CAShapeLayer — o mesmo #111 → laranja do perfil JS) + título.
final class CIHighlightTile: UIControl {
  static let ring: CGFloat = 68
  static let width: CGFloat = 76
  private let ringGradient = CAGradientLayer()
  private let ringMask = CAShapeLayer()
  private let imageView = UIImageView()
  private let titleLabel = UILabel()
  private(set) var key = ""
  private var currentURL = ""
  var onLongPress: ((String) -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    ringGradient.startPoint = CGPoint(x: 0, y: 0)
    ringGradient.endPoint = CGPoint(x: 1, y: 1)
    ringMask.fillColor = UIColor.clear.cgColor
    ringMask.strokeColor = UIColor.black.cgColor
    ringMask.lineWidth = 2
    ringGradient.mask = ringMask
    layer.addSublayer(ringGradient)
    imageView.contentMode = .scaleAspectFill
    imageView.clipsToBounds = true
    imageView.isUserInteractionEnabled = false
    addSubview(imageView)
    titleLabel.font = UIFont.systemFont(ofSize: 12, weight: .semibold)
    titleLabel.textAlignment = .center
    titleLabel.lineBreakMode = .byTruncatingTail
    titleLabel.isUserInteractionEnabled = false
    addSubview(titleLabel)
    let lp = UILongPressGestureRecognizer(target: self, action: #selector(longPressed(_:)))
    lp.minimumPressDuration = 0.35
    addGestureRecognizer(lp)
    isAccessibilityElement = true
    accessibilityTraits = .button
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var isHighlighted: Bool {
    didSet { alpha = isHighlighted ? 0.7 : 1 }
  }

  func configure(_ h: CIHighlight, palette p: STPalette) {
    key = h.key
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    ringGradient.colors = [p.text.cgColor, p.text.cgColor, UIColor(red: 0.976, green: 0.451, blue: 0.086, alpha: 1).cgColor]
    ringGradient.locations = [0, 0.5, 1]
    CATransaction.commit()
    imageView.backgroundColor = p.chipBg
    titleLabel.text = h.title
    titleLabel.textColor = p.text
    accessibilityLabel = h.title
    if h.url == currentURL && imageView.image != nil { return }
    currentURL = h.url
    if h.url.isEmpty {
      imageView.image = nil
      return
    }
    let px: CGFloat = 200
    if let img = CLImageLoader.shared.cachedImage(h.url, maxPixel: px) {
      imageView.image = img
      return
    }
    imageView.image = nil
    let url = h.url
    CLImageLoader.shared.load(url, auth: h.auth, maxPixel: px) { [weak self] img in
      guard let self = self, self.currentURL == url else { return }
      self.imageView.image = img
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let R = CIHighlightTile.ring
    let x = (bounds.width - R) / 2
    let ringRect = CGRect(x: x, y: 0, width: R, height: R)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    ringGradient.frame = ringRect
    ringMask.frame = CGRect(x: 0, y: 0, width: R, height: R)
    ringMask.path = UIBezierPath(ovalIn: CGRect(x: 1, y: 1, width: R - 2, height: R - 2)).cgPath
    CATransaction.commit()
    let inner = ringRect.insetBy(dx: 5, dy: 5)
    imageView.frame = inner
    imageView.layer.cornerRadius = inner.width / 2
    titleLabel.frame = CGRect(x: 0, y: R + 6, width: bounds.width, height: 16)
  }

  @objc private func longPressed(_ g: UILongPressGestureRecognizer) {
    guard g.state == .began, !key.isEmpty else { return }
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    onLongPress?(key)
  }
}

/// Faixa horizontal de destaques (linha k "hl"), sem cartão por trás.
final class CIHighlightsCell: UICollectionViewCell {
  static let height: CGFloat = 96
  private let strip = UIScrollView()
  private var tiles: [CIHighlightTile] = []
  var onItem: ((String) -> Void)?
  var onLong: ((String) -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    strip.showsHorizontalScrollIndicator = false
    strip.alwaysBounceHorizontal = true
    strip.clipsToBounds = false
    contentView.addSubview(strip)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ items: [CIHighlight], palette p: STPalette) {
    while tiles.count < items.count {
      let t = CIHighlightTile()
      t.addTarget(self, action: #selector(tileTapped(_:)), for: .touchUpInside)
      t.onLongPress = { [weak self] key in self?.onLong?(key) }
      tiles.append(t)
      strip.addSubview(t)
    }
    while tiles.count > items.count {
      let t = tiles.removeLast()
      t.removeFromSuperview()
    }
    for (i, h) in items.enumerated() { tiles[i].configure(h, palette: p) }
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    strip.frame = contentView.bounds
    let w = CIHighlightTile.width
    let gap: CGFloat = 8
    let h = CIHighlightTile.ring + 6 + 16
    let y = max(0, (contentView.bounds.height - h) / 2)
    for (i, t) in tiles.enumerated() {
      t.frame = CGRect(x: CGFloat(i) * (w + gap), y: y, width: w, height: h)
    }
    let total = CGFloat(tiles.count) * w + CGFloat(max(0, tiles.count - 1)) * gap
    strip.contentSize = CGSize(width: total, height: contentView.bounds.height)
  }

  @objc private func tileTapped(_ sender: CIHighlightTile) {
    UISelectionFeedbackGenerator().selectionChanged()
    onItem?(sender.key)
  }
}
