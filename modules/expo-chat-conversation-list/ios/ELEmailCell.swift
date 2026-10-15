import UIKit

// [2026-10-15 native-inbox] Célula do e-mail — layout manual (frames), mesma
// estética do components/EmailRow.js: ponto de não lida à esquerda, avatar
// (ou bolinha de seleção), remetente 16 (700 se não lido) + contador da
// conversa + mudo · clipe + hora 13; assunto 15 (600 se não lido) + até 2
// chips de rótulo; prévia 14; chips "responder?"/"adiado"; estrela à direita.

/// Fonte + texto dentro de uma cápsula (contador da conversa / chips).
final class ELChipView: UIView {
  let label = UILabel()
  var padX: CGFloat = 8

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    clipsToBounds = true
    label.numberOfLines = 1
    label.textAlignment = .center
    addSubview(label)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func fit(height: CGFloat, maxWidth: CGFloat = 140) -> CGSize {
    let w = ceil(label.intrinsicContentSize.width) + padX * 2
    return CGSize(width: min(maxWidth, max(height, w)), height: height)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    layer.cornerRadius = min(bounds.height / 2, 10)
    label.frame = bounds.insetBy(dx: padX, dy: 0)
  }
}

final class ELSectionCell: UICollectionViewListCell {
  private let titleLabel = UILabel()
  private var palette = ELPalette(dark: false)
  private var padX: CGFloat = 13

  override init(frame: CGRect) {
    super.init(frame: frame)
    titleLabel.numberOfLines = 1
    contentView.addSubview(titleLabel)
    isAccessibilityElement = true
    accessibilityTraits = .header
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  static func height(for traits: UITraitCollection) -> CGFloat {
    let f = ELFonts(traits)
    return ceil(f.section.lineHeight) + 20
  }

  func configure(_ row: ELRow, palette: ELPalette, padH: CGFloat) {
    self.palette = palette
    let attr = NSMutableAttributedString(string: row.title.uppercased(), attributes: [.kern: 0.5])
    titleLabel.attributedText = attr
    titleLabel.font = ELFonts(traitCollection).section
    titleLabel.textColor = palette.sub
    accessibilityLabel = row.title
    padX = padH
    setNeedsUpdateConfiguration()
    setNeedsLayout()
  }

  override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
    let attrs = super.preferredLayoutAttributesFitting(layoutAttributes)
    attrs.frame.size.height = ELSectionCell.height(for: traitCollection)
    return attrs
  }

  override func updateConfiguration(using state: UICellConfigurationState) {
    var bg = UIBackgroundConfiguration.listPlainCell()
    bg.backgroundColor = palette.sectionBg
    backgroundConfiguration = bg
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = contentView.bounds
    titleLabel.frame = CGRect(x: padX, y: 0, width: max(0, b.width - padX * 2), height: b.height)
  }
}

final class ELEmailCell: UICollectionViewListCell {
  let avatar = CLAvatarView()
  private let check = CLCheckView()
  private let leftTapArea = UIView()
  private let unreadDot = UIView()
  private let fromLabel = UILabel()
  private let threadBadge = ELChipView()
  private let muteIcon = UIImageView()
  private let clipIcon = UIImageView()
  private let dateLabel = UILabel()
  private let subjectLabel = UILabel()
  private var chipViews: [ELChipView] = []
  private let previewLabel = UILabel()
  private let nudgeChip = ELChipView()
  private let snoozeChip = ELChipView()
  private let snoozeIcon = UIImageView()
  private let starButton = UIButton(type: .custom)
  private let leftTap = UITapGestureRecognizer()

  private(set) var row = ELRow()
  private var palette = ELPalette(dark: false)
  private var density = ELDensity()
  private var labels = CLLabels()
  private var selectionMode = false
  private var fonts = ELFonts(nil)
  private var fontsCategory: UIContentSizeCategory?

  var onLeftTap: ((String) -> Void)?
  var onStarTap: ((String) -> Void)?
  var onA11yAction: ((String, String) -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    let cv = contentView
    unreadDot.isUserInteractionEnabled = false
    unreadDot.layer.cornerRadius = 4
    cv.addSubview(unreadDot)
    cv.addSubview(leftTapArea)
    leftTapArea.backgroundColor = .clear
    leftTapArea.addSubview(avatar)
    leftTapArea.addSubview(check)
    avatar.isUserInteractionEnabled = false
    leftTap.addTarget(self, action: #selector(leftTapped))
    leftTapArea.addGestureRecognizer(leftTap)
    for l in [fromLabel, dateLabel, subjectLabel, previewLabel] {
      l.numberOfLines = 1
      l.lineBreakMode = .byTruncatingTail
      l.adjustsFontForContentSizeCategory = false
      cv.addSubview(l)
    }
    dateLabel.textAlignment = .right
    for iv in [muteIcon, clipIcon, snoozeIcon] {
      iv.contentMode = .center
      iv.isUserInteractionEnabled = false
    }
    cv.addSubview(threadBadge)
    threadBadge.padX = 7
    cv.addSubview(muteIcon)
    cv.addSubview(clipIcon)
    nudgeChip.padX = 8
    cv.addSubview(nudgeChip)
    snoozeChip.padX = 8
    snoozeChip.addSubview(snoozeIcon)
    cv.addSubview(snoozeChip)
    starButton.addTarget(self, action: #selector(starTapped), for: .touchUpInside)
    cv.addSubview(starButton)
    isAccessibilityElement = true
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  // MARK: - Altura

  static func height(_ row: ELRow, density: ELDensity, traits: UITraitCollection) -> CGFloat {
    let f = ELFonts(traits)
    var content = ceil(f.from.lineHeight) + 2 + 1 + max(ceil(f.subject.lineHeight), row.chips.isEmpty ? 0 : ceil(f.chip.lineHeight) + 8)
    if density.preview && !row.preview.isEmpty { content += 1 + ceil(f.preview.lineHeight) }
    let chipH = ceil(f.small.lineHeight) + 6
    if !row.nudge.isEmpty { content += 4 + chipH }
    if !row.snoozed.isEmpty { content += 4 + chipH }
    let padV = density.padV
    return max(density.minH, ceil(content + padV * 2))
  }

  override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
    let attrs = super.preferredLayoutAttributesFitting(layoutAttributes)
    attrs.frame.size.height = ELEmailCell.height(row, density: density, traits: traitCollection)
    return attrs
  }

  private func reloadFonts() {
    let cat = traitCollection.preferredContentSizeCategory
    if cat == fontsCategory { return }
    fontsCategory = cat
    fonts = ELFonts(traitCollection)
  }

  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    if previousTraitCollection?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory {
      apply()
    }
  }

  // MARK: - Configuração

  func configure(_ newRow: ELRow, palette: ELPalette, density: ELDensity, labels: CLLabels, selectionMode: Bool) {
    self.row = newRow
    self.palette = palette
    self.density = density
    self.labels = labels
    self.selectionMode = selectionMode
    apply()
    setNeedsUpdateConfiguration()
  }

  private var rowBackground: UIColor {
    return (row.checked || row.active) ? palette.selectedBg : palette.bg
  }

  private func apply() {
    reloadFonts()
    let r = row
    let f = fonts
    let unread = r.unread

    unreadDot.isHidden = !unread || selectionMode
    unreadDot.backgroundColor = palette.primary

    avatar.boxSize = density.avatar
    avatar.isHidden = selectionMode
    if !selectionMode {
      avatar.configure(r.avatar, theme: CLTheme(dark: palette.dark), rowBackground: rowBackground)
    }
    check.isHidden = !selectionMode
    check.onColor = palette.checkOn
    check.tickColor = palette.bg
    check.borderTint = palette.checkOff
    check.checked = r.checked

    fromLabel.text = r.from
    fromLabel.font = unread ? f.fromBold : f.from
    fromLabel.textColor = palette.text

    threadBadge.isHidden = r.thread <= 1
    if r.thread > 1 {
      threadBadge.label.text = String(r.thread)
      threadBadge.label.font = f.badge
      threadBadge.label.textColor = palette.sub
      threadBadge.backgroundColor = palette.variant
    }
    muteIcon.isHidden = !r.muted
    if r.muted {
      muteIcon.image = CLSymbols.image("speaker.slash", pointSize: 11, weight: .regular, color: palette.faint)
      muteIcon.alpha = 0.6
    }
    clipIcon.isHidden = !r.attach
    if r.attach {
      clipIcon.image = CLSymbols.image("paperclip", pointSize: 12, weight: .regular, color: palette.faint)
    }
    dateLabel.text = r.time
    dateLabel.font = unread ? f.dateBold : f.date
    dateLabel.textColor = unread ? palette.text : palette.faint

    subjectLabel.text = r.subject
    subjectLabel.font = unread ? f.subjectBold : f.subject
    subjectLabel.textColor = unread ? palette.text : palette.sub

    let chips = Array(r.chips.prefix(2))
    while chipViews.count < chips.count {
      let cv = ELChipView()
      cv.layer.borderWidth = 1.0 / max(1, UIScreen.main.scale)
      contentView.addSubview(cv)
      chipViews.append(cv)
    }
    for (i, cv) in chipViews.enumerated() {
      if i < chips.count {
        let c = chips[i]
        cv.isHidden = false
        cv.label.attributedText = NSAttributedString(string: c.name, attributes: [.kern: 0.2, .font: f.chip, .foregroundColor: c.fg])
        cv.backgroundColor = c.bg
        cv.layer.borderColor = c.bd.withAlphaComponent(0.5).cgColor
      } else {
        cv.isHidden = true
      }
    }

    let showPreview = density.preview && !r.preview.isEmpty
    previewLabel.isHidden = !showPreview
    previewLabel.text = r.preview
    previewLabel.font = f.preview
    previewLabel.textColor = palette.sub

    nudgeChip.isHidden = r.nudge.isEmpty
    nudgeChip.label.text = r.nudge
    nudgeChip.label.font = f.small
    nudgeChip.label.textColor = palette.sub
    nudgeChip.backgroundColor = palette.variant

    snoozeChip.isHidden = r.snoozed.isEmpty
    snoozeChip.label.text = r.snoozed
    snoozeChip.label.font = f.small
    snoozeChip.label.textColor = palette.primary
    snoozeChip.label.textAlignment = .right
    snoozeChip.backgroundColor = palette.variant
    snoozeIcon.image = CLSymbols.image("clock", pointSize: 10, weight: .medium, color: palette.primary)

    let starImg = r.starred
      ? CLSymbols.image("star.fill", pointSize: 17, weight: .regular, color: palette.star)
      : CLSymbols.image("star", pointSize: 17, weight: .regular, color: palette.starEmpty)
    starButton.setImage(starImg, for: .normal)
    starButton.isHidden = selectionMode
    starButton.accessibilityLabel = r.starred ? labels.get("unstar", "Remover estrela") : labels.get("star", "Adicionar estrela")

    accessibilityLabel = r.a11y.isEmpty ? "\(r.from), \(r.subject)" : r.a11y
    accessibilityTraits = selectionMode && r.checked ? [.button, .selected] : .button
    accessibilityCustomActions = selectionMode ? [] : buildA11yActions()
    setNeedsLayout()
  }

  private func buildA11yActions() -> [UIAccessibilityCustomAction] {
    let r = row
    let list: [(String, String)] = [
      ("star", r.starred ? labels.get("unstar", "Remover estrela") : labels.get("star", "Adicionar estrela")),
      ("archive", labels.get("archive", "Arquivar")),
      ("snooze", labels.get("snooze", "Adiar")),
      ("delete", labels.get("delete", "Excluir")),
      ("select", labels.get("select", "Selecionar")),
    ]
    let id = r.id
    return list.map { (action, title) in
      UIAccessibilityCustomAction(name: title) { [weak self] _ in
        self?.onA11yAction?(id, action)
        return true
      }
    }
  }

  @objc private func leftTapped() {
    onLeftTap?(row.id)
  }

  @objc private func starTapped() {
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    UIView.animate(withDuration: 0.12, animations: {
      self.starButton.transform = CGAffineTransform(scaleX: 1.25, y: 1.25)
    }, completion: { _ in
      UIView.animate(withDuration: 0.16) { self.starButton.transform = .identity }
    })
    onStarTap?(row.id)
  }

  // MARK: - Fundo

  override func updateConfiguration(using state: UICellConfigurationState) {
    var bg = UIBackgroundConfiguration.listPlainCell()
    if state.isHighlighted || state.isSelected || state.isSwiped {
      bg.backgroundColor = palette.pressBg
    } else {
      bg.backgroundColor = rowBackground
    }
    backgroundConfiguration = bg
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    starButton.layer.removeAllAnimations()
    starButton.transform = .identity
  }

  // MARK: - Layout

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = contentView.bounds
    let W = b.width
    let H = b.height
    let f = fonts
    let padH = density.padH
    let left: CGFloat = padH

    unreadDot.frame = CGRect(x: 5, y: (H - 8) / 2, width: 8, height: 8)

    let box = selectionMode ? 22 : density.avatar
    leftTapArea.frame = CGRect(x: left - 8, y: 0, width: box + 16, height: H)
    avatar.frame = CGRect(x: 8, y: (H - box) / 2, width: box, height: box)
    check.frame = CGRect(x: 8, y: (H - 22) / 2, width: 22, height: 22)
    let textX = left + box + density.gap

    // Estrela (36×36, margem direita −6 como no JS)
    var right = W - padH
    if !starButton.isHidden {
      starButton.frame = CGRect(x: right - 36 + 6, y: (H - 36) / 2, width: 36, height: 36)
      right = right - 36 + 6 - 4
    }

    // Altura do bloco de texto (centralizado na linha)
    let fromH = ceil(f.from.lineHeight)
    let subjH = max(ceil(f.subject.lineHeight), chipViews.contains(where: { !$0.isHidden }) ? ceil(f.chip.lineHeight) + 8 : 0)
    let prevH = previewLabel.isHidden ? 0 : ceil(f.preview.lineHeight)
    let chipH = ceil(f.small.lineHeight) + 6
    var total = fromH + 2 + 1 + subjH
    if prevH > 0 { total += 1 + prevH }
    if !nudgeChip.isHidden { total += 4 + chipH }
    if !snoozeChip.isHidden { total += 4 + chipH }
    var y = floor((H - total) / 2)

    // ── linha 1: remetente [N] [mudo] ……… [clipe] hora
    let dw = ceil(dateLabel.intrinsicContentSize.width)
    let dateH = ceil(f.date.lineHeight)
    let baseDelta = (fromLabel.font ?? f.from).ascender - f.date.ascender
    dateLabel.frame = CGRect(x: right - dw, y: y + baseDelta, width: dw, height: dateH)
    var rx = right - dw
    if !clipIcon.isHidden {
      clipIcon.frame = CGRect(x: rx - 6 - 14, y: y + (fromH - 14) / 2, width: 14, height: 14)
      rx -= 6 + 14
    }
    var maxFrom = max(0, rx - 8 - textX)
    var tail: CGFloat = 0
    let badgeSize = threadBadge.isHidden ? .zero : threadBadge.fit(height: ceil(f.badge.lineHeight) + 2)
    if !threadBadge.isHidden { tail += 6 + badgeSize.width + 2 }
    if !muteIcon.isHidden { tail += 4 + 12 }
    maxFrom = max(0, maxFrom - tail)
    let fromW = min(ceil(fromLabel.intrinsicContentSize.width), maxFrom)
    fromLabel.frame = CGRect(x: textX, y: y, width: fromW, height: fromH)
    var tx = textX + fromW
    if !threadBadge.isHidden {
      threadBadge.frame = CGRect(x: tx + 6, y: y + (fromH - badgeSize.height) / 2, width: badgeSize.width, height: badgeSize.height)
      tx += 6 + badgeSize.width + 2
    }
    if !muteIcon.isHidden {
      muteIcon.frame = CGRect(x: tx + 4, y: y + (fromH - 12) / 2, width: 12, height: 12)
    }
    y += fromH + 2 + 1

    // ── linha 2: assunto ……… [chip][chip]
    var cx = right
    let chipLabelH = ceil(f.chip.lineHeight) + 8
    for cv in chipViews.reversed() where !cv.isHidden {
      let s = cv.fit(height: chipLabelH, maxWidth: 110)
      cv.frame = CGRect(x: cx - s.width, y: y + (subjH - chipLabelH) / 2, width: s.width, height: s.height)
      cx -= s.width + 6
    }
    let subjRight = cx < right ? cx : right
    subjectLabel.frame = CGRect(x: textX, y: y + (subjH - ceil(f.subject.lineHeight)) / 2, width: max(0, subjRight - textX), height: ceil(f.subject.lineHeight))
    y += subjH

    // ── linha 3: prévia
    if prevH > 0 {
      y += 1
      previewLabel.frame = CGRect(x: textX, y: y, width: max(0, right - textX), height: prevH)
      y += prevH
    }
    if !nudgeChip.isHidden {
      y += 4
      let s = nudgeChip.fit(height: chipH, maxWidth: max(40, right - textX))
      nudgeChip.frame = CGRect(x: textX, y: y, width: s.width, height: chipH)
      y += chipH
    }
    if !snoozeChip.isHidden {
      y += 4
      let s = snoozeChip.fit(height: chipH, maxWidth: max(40, right - textX - 16))
      let w = s.width + 16
      snoozeChip.frame = CGRect(x: textX, y: y, width: w, height: chipH)
      snoozeIcon.frame = CGRect(x: 8, y: (chipH - 12) / 2, width: 12, height: 12)
      y += chipH
    }
  }
}
