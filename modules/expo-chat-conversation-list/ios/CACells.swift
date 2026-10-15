import UIKit

// [2026-10-15 native-apps] Células da agenda do calendário nativo (iOS):
// cabeçalho do dia, cartão de evento (faixa de cor, hora, local, repetição,
// reunião + "Entrar", selos) e vazio com "Novo evento". Mesmo visual do
// SwipeableEventCard/CalendarEmptyState do app/calendar.js (P&B).

private func caIcon(_ name: String, _ size: CGFloat, _ color: UIColor, weight: UIImage.SymbolWeight = .medium) -> UIImage? {
  return CLSymbols.image(name, pointSize: size, weight: weight, color: color)
}

final class CAHeaderCell: UICollectionViewListCell {
  private let titleLabel = UILabel()
  private let countLabel = UILabel()
  private let hair = UIView()
  private var topConstraint: NSLayoutConstraint!

  override init(frame: CGRect) {
    super.init(frame: frame)
    titleLabel.font = .systemFont(ofSize: 14, weight: .semibold)
    titleLabel.numberOfLines = 1
    titleLabel.adjustsFontForContentSizeCategory = false
    countLabel.font = .systemFont(ofSize: 13)
    countLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
    countLabel.setContentHuggingPriority(.required, for: .horizontal)
    titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    for v in [hair, titleLabel, countLabel] {
      v.translatesAutoresizingMaskIntoConstraints = false
      contentView.addSubview(v)
    }
    topConstraint = hair.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 3)
    NSLayoutConstraint.activate([
      topConstraint,
      hair.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
      hair.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
      hair.heightAnchor.constraint(equalToConstant: 1),
      titleLabel.topAnchor.constraint(equalTo: hair.bottomAnchor, constant: 6),
      titleLabel.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 8),
      titleLabel.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -6),
      countLabel.leadingAnchor.constraint(greaterThanOrEqualTo: titleLabel.trailingAnchor, constant: 8),
      countLabel.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -8),
      countLabel.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ row: CARow, style: CAStyle) {
    var bg = UIBackgroundConfiguration.clear()
    bg.backgroundColor = style.colors.bg
    backgroundConfiguration = bg
    titleLabel.text = row.title
    titleLabel.textColor = style.colors.text
    countLabel.text = row.sub
    countLabel.textColor = style.colors.sub
    hair.backgroundColor = style.colors.border
    topConstraint.constant = row.top ? 8 : 3
    isAccessibilityElement = true
    accessibilityLabel = row.sub.isEmpty ? row.title : "\(row.title), \(row.sub)"
    accessibilityTraits = .header
  }
}

final class CAEventCell: UICollectionViewListCell {
  var onAction: ((String, String) -> Void)?

  private let card = UIView()
  private let accentBar = UIView()
  private let body = UIStackView()
  private let titleRow = UIStackView()
  private let titleLabel = UILabel()
  private let relLabel = CAPaddedLabel()
  private let timeLine = CAMetaLine()
  private let locLine = CAMetaLine()
  private let recLine = CAMetaLine()
  private let meetLine = CAMetaLine()
  private let right = UIStackView()
  private let badges = UIStackView()
  private let syncIcon = UIImageView()
  private let bellIcon = UIImageView()
  private let calLabel = CAPaddedLabel()
  private let joinBtn = UIButton(type: .system)
  private var rowId = ""
  private var style = CAStyle()

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.clipsToBounds = false
    clipsToBounds = false

    card.layer.cornerRadius = 16
    card.layer.cornerCurve = .continuous
    card.translatesAutoresizingMaskIntoConstraints = false
    contentView.addSubview(card)

    accentBar.translatesAutoresizingMaskIntoConstraints = false
    accentBar.layer.cornerRadius = 2.5
    card.addSubview(accentBar)

    titleLabel.font = .systemFont(ofSize: 16, weight: .heavy)
    titleLabel.numberOfLines = 1
    titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    relLabel.font = .systemFont(ofSize: 12, weight: .bold)
    relLabel.layer.cornerRadius = 6
    relLabel.layer.masksToBounds = true
    relLabel.insets = UIEdgeInsets(top: 3, left: 8, bottom: 3, right: 8)
    relLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
    relLabel.setContentHuggingPriority(.required, for: .horizontal)
    titleRow.axis = .horizontal
    titleRow.spacing = 8
    titleRow.alignment = .center
    titleRow.addArrangedSubview(titleLabel)
    titleRow.addArrangedSubview(relLabel)

    body.axis = .vertical
    body.spacing = 7
    body.alignment = .fill
    body.translatesAutoresizingMaskIntoConstraints = false
    for v in [titleRow, timeLine, locLine, recLine, meetLine] { body.addArrangedSubview(v) }
    card.addSubview(body)

    for iv in [syncIcon, bellIcon] {
      iv.contentMode = .center
      iv.translatesAutoresizingMaskIntoConstraints = false
      iv.layer.cornerRadius = 9
      iv.layer.masksToBounds = true
      NSLayoutConstraint.activate([iv.widthAnchor.constraint(equalToConstant: 18), iv.heightAnchor.constraint(equalToConstant: 18)])
    }
    calLabel.font = .systemFont(ofSize: 12, weight: .semibold)
    calLabel.insets = UIEdgeInsets(top: 3, left: 8, bottom: 3, right: 8)
    calLabel.layer.cornerRadius = 10
    calLabel.layer.masksToBounds = true
    badges.axis = .vertical
    badges.spacing = 5
    badges.alignment = .trailing
    badges.addArrangedSubview(syncIcon)
    badges.addArrangedSubview(bellIcon)
    badges.addArrangedSubview(calLabel)

    joinBtn.titleLabel?.font = .systemFont(ofSize: 13, weight: .semibold)
    joinBtn.layer.cornerRadius = 10
    joinBtn.contentEdgeInsets = UIEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
    joinBtn.imageEdgeInsets = UIEdgeInsets(top: 0, left: -4, bottom: 0, right: 0)
    joinBtn.addTarget(self, action: #selector(joinTapped), for: .touchUpInside)

    right.axis = .vertical
    right.spacing = 8
    right.alignment = .trailing
    right.translatesAutoresizingMaskIntoConstraints = false
    right.addArrangedSubview(badges)
    right.addArrangedSubview(joinBtn)
    right.setContentCompressionResistancePriority(.required, for: .horizontal)
    right.setContentHuggingPriority(.required, for: .horizontal)
    card.addSubview(right)

    NSLayoutConstraint.activate([
      card.topAnchor.constraint(equalTo: contentView.topAnchor),
      card.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 8),
      card.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -8),
      card.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -6),

      accentBar.leadingAnchor.constraint(equalTo: card.leadingAnchor),
      accentBar.topAnchor.constraint(equalTo: card.topAnchor),
      accentBar.bottomAnchor.constraint(equalTo: card.bottomAnchor),
      accentBar.widthAnchor.constraint(equalToConstant: 5),

      body.topAnchor.constraint(equalTo: card.topAnchor, constant: 13),
      body.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -13),
      body.leadingAnchor.constraint(equalTo: accentBar.trailingAnchor, constant: 14),
      body.trailingAnchor.constraint(lessThanOrEqualTo: right.leadingAnchor, constant: -8),

      right.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -10),
      right.centerYAnchor.constraint(equalTo: card.centerYAnchor),
      right.topAnchor.constraint(greaterThanOrEqualTo: card.topAnchor, constant: 6),
      right.bottomAnchor.constraint(lessThanOrEqualTo: card.bottomAnchor, constant: -6),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ row: CARow, style st: CAStyle) {
    rowId = row.id
    style = st
    let c = st.colors
    var bg = UIBackgroundConfiguration.clear()
    bg.backgroundColor = c.bg
    backgroundConfiguration = bg

    card.backgroundColor = st.card
    if c.dark {
      card.layer.shadowOpacity = 0
      card.layer.borderWidth = 1 / UIScreen.main.scale
      card.layer.borderColor = c.border.cgColor
    } else {
      card.layer.borderWidth = 0
      card.layer.shadowColor = UIColor.black.cgColor
      card.layer.shadowOffset = CGSize(width: 0, height: 4)
      card.layer.shadowOpacity = 0.08
      card.layer.shadowRadius = 12
    }
    let accent = row.accent ?? c.text
    accentBar.backgroundColor = accent

    titleLabel.text = row.title
    titleLabel.textColor = c.text
    relLabel.isHidden = row.rel.isEmpty
    relLabel.text = row.rel
    relLabel.textColor = accent
    relLabel.backgroundColor = accent.withAlphaComponent(0.1)

    timeLine.set(symbol: "clock", text: row.time, color: c.sub)
    locLine.set(symbol: "mappin.and.ellipse", text: row.location, color: c.sub)
    recLine.set(symbol: "repeat", text: row.recurrence, color: c.sub)
    meetLine.set(symbol: "video", text: row.meeting, color: c.primary, bold: true)

    syncIcon.isHidden = !row.synced
    syncIcon.image = caIcon("iphone", 10, c.primary)
    syncIcon.backgroundColor = c.primary.withAlphaComponent(0.13)
    bellIcon.isHidden = !row.reminder
    bellIcon.image = caIcon("bell", 10, accent)
    bellIcon.backgroundColor = accent.withAlphaComponent(0.1)
    let calColor = row.calColor ?? c.primary
    calLabel.isHidden = row.calendar.isEmpty
    calLabel.text = row.calendar
    calLabel.textColor = calColor
    calLabel.backgroundColor = calColor.withAlphaComponent(0.1)
    badges.isHidden = syncIcon.isHidden && bellIcon.isHidden && calLabel.isHidden

    joinBtn.isHidden = row.join.isEmpty
    if !row.join.isEmpty {
      joinBtn.setTitle(row.join, for: .normal)
      joinBtn.setTitleColor(c.onPrimary, for: .normal)
      joinBtn.tintColor = c.onPrimary
      joinBtn.setImage(caIcon("video", 12, c.onPrimary), for: .normal)
      joinBtn.backgroundColor = c.primary
    }
    right.isHidden = badges.isHidden && joinBtn.isHidden

    isAccessibilityElement = true
    accessibilityLabel = [row.title, row.time, row.location, row.recurrence, row.meeting, row.rel]
      .filter { !$0.isEmpty }.joined(separator: ", ")
    accessibilityTraits = .button
    var acts: [UIAccessibilityCustomAction] = []
    if !row.join.isEmpty {
      acts.append(UIAccessibilityCustomAction(name: row.join) { [weak self] _ in
        guard let self = self else { return false }
        self.onAction?(self.rowId, "join"); return true
      })
    }
    accessibilityCustomActions = acts
  }

  @objc private func joinTapped() {
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    onAction?(rowId, "join")
  }

  override func updateConfiguration(using state: UICellConfigurationState) {
    super.updateConfiguration(using: state)
    let pressed = state.isHighlighted || state.isSelected
    UIView.animate(withDuration: pressed ? 0.08 : 0.2) {
      self.card.transform = pressed ? CGAffineTransform(scaleX: 0.985, y: 0.985) : .identity
      self.card.alpha = pressed ? 0.85 : 1
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if !style.colors.dark {
      card.layer.shadowPath = UIBezierPath(roundedRect: card.bounds, cornerRadius: 16).cgPath
    }
  }
}

final class CAEmptyCell: UICollectionViewListCell {
  var onAction: ((String, String) -> Void)?
  private let iconWrap = UIView()
  private let icon = UIImageView()
  private let titleLabel = UILabel()
  private let subLabel = UILabel()
  private let button = UIButton(type: .system)
  private var rowId = ""

  override init(frame: CGRect) {
    super.init(frame: frame)
    let stack = UIStackView(arrangedSubviews: [iconWrap, titleLabel, subLabel, button])
    stack.axis = .vertical
    stack.alignment = .center
    stack.spacing = 8
    stack.setCustomSpacing(14, after: iconWrap)
    stack.setCustomSpacing(16, after: subLabel)
    stack.translatesAutoresizingMaskIntoConstraints = false
    contentView.addSubview(stack)
    iconWrap.layer.cornerRadius = 28
    iconWrap.translatesAutoresizingMaskIntoConstraints = false
    icon.translatesAutoresizingMaskIntoConstraints = false
    icon.contentMode = .center
    iconWrap.addSubview(icon)
    titleLabel.font = .systemFont(ofSize: 17, weight: .bold)
    titleLabel.textAlignment = .center
    titleLabel.numberOfLines = 2
    subLabel.font = .systemFont(ofSize: 14)
    subLabel.textAlignment = .center
    subLabel.numberOfLines = 3
    button.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
    button.layer.cornerRadius = 12
    button.contentEdgeInsets = UIEdgeInsets(top: 11, left: 22, bottom: 11, right: 22)
    button.addTarget(self, action: #selector(tapped), for: .touchUpInside)
    NSLayoutConstraint.activate([
      iconWrap.widthAnchor.constraint(equalToConstant: 56),
      iconWrap.heightAnchor.constraint(equalToConstant: 56),
      icon.centerXAnchor.constraint(equalTo: iconWrap.centerXAnchor),
      icon.centerYAnchor.constraint(equalTo: iconWrap.centerYAnchor),
      stack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 28),
      stack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -28),
      stack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 32),
      stack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -32),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ row: CARow, style: CAStyle) {
    rowId = row.id
    let c = style.colors
    var bg = UIBackgroundConfiguration.clear()
    bg.backgroundColor = c.bg
    backgroundConfiguration = bg
    iconWrap.backgroundColor = style.selBg
    icon.image = caIcon("calendar", 22, c.text)
    titleLabel.text = row.title
    titleLabel.textColor = c.text
    subLabel.text = row.sub
    subLabel.textColor = c.sub
    subLabel.isHidden = row.sub.isEmpty
    button.isHidden = row.button.isEmpty
    button.setTitle(row.button, for: .normal)
    button.setTitleColor(c.onPrimary, for: .normal)
    button.backgroundColor = c.primary
  }

  @objc private func tapped() {
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    onAction?(rowId, "add")
  }
}

/// Linha "ícone + texto" do cartão (some quando o texto é vazio).
final class CAMetaLine: UIStackView {
  private let icon = UIImageView()
  private let label = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    axis = .horizontal
    spacing = 5
    alignment = .center
    icon.contentMode = .center
    icon.setContentHuggingPriority(.required, for: .horizontal)
    icon.setContentCompressionResistancePriority(.required, for: .horizontal)
    label.numberOfLines = 1
    label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    addArrangedSubview(icon)
    addArrangedSubview(label)
  }

  required init(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func set(symbol: String, text: String, color: UIColor, bold: Bool = false) {
    isHidden = text.isEmpty
    if text.isEmpty { return }
    icon.image = caIcon(symbol, 11, color)
    label.text = text
    label.textColor = color
    label.font = .systemFont(ofSize: 13, weight: bold ? .semibold : .regular)
  }
}

/// UILabel com respiro interno (selos/pílulas).
final class CAPaddedLabel: UILabel {
  var insets = UIEdgeInsets.zero

  override func drawText(in rect: CGRect) {
    super.drawText(in: rect.inset(by: insets))
  }

  override var intrinsicContentSize: CGSize {
    let s = super.intrinsicContentSize
    return CGSize(width: s.width + insets.left + insets.right, height: s.height + insets.top + insets.bottom)
  }

  override func sizeThatFits(_ size: CGSize) -> CGSize {
    let s = super.sizeThatFits(size)
    return CGSize(width: s.width + insets.left + insets.right, height: s.height + insets.top + insets.bottom)
  }
}
