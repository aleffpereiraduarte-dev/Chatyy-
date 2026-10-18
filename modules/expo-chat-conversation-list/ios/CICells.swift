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

  func configure(_ pic: CIPic) {
    let pair = CLTheme.gradient(pic.grad)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    gradient.colors = [pair.0.cgColor, pair.1.cgColor]
    CATransaction.commit()
    initialsLabel.text = pic.initials
    if pic.url == currentURL && imageView.image != nil { return }
    currentURL = pic.url
    if pic.url.isEmpty {
      imageView.image = nil
      return
    }
    let px = maxPixel
    if let img = CLImageLoader.shared.cachedImage(pic.url, maxPixel: px) {
      imageView.image = img
      imageView.alpha = 1
      return
    }
    imageView.image = nil
    let url = pic.url
    CLImageLoader.shared.load(url, auth: pic.auth, maxPixel: px) { [weak self] img in
      guard let self = self, self.currentURL == url else { return }
      self.imageView.image = img
      if img != nil && self.window != nil {
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
    layer.cornerRadius = side / 2
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
    if let img = CLImageLoader.shared.cachedImage(m.url, maxPixel: 260) {
      imageView.image = img
      return
    }
    imageView.image = nil
    let url = m.url
    CLImageLoader.shared.load(url, auth: m.auth, maxPixel: 260) { [weak self] img in
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
