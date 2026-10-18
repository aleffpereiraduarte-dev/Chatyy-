import UIKit

// [2026-10-14 native-home] Célula da conversa — layout manual (frames), sem
// Auto Layout: a altura é fixa por categoria de fonte, então a lista não mede
// nada durante o scroll. Visual = ConversationRow do ChatListTab.js
// (avatar 54, gutter 16, gap 14, nome 17/600, prévia 15, hora 14 tabular,
// contador 13 em círculo 20, ícones 15 em cinza) — WhatsApp iOS.
final class CLConversationCell: UICollectionViewListCell {
  let avatar = CLAvatarView()
  private let check = CLCheckView()
  private let nameLabel = UILabel()
  private let activityLabel = UILabel()
  private let timeLabel = UILabel()
  private let lockIcon = UIImageView()
  private let clockIcon = UIImageView()
  private let failIcon = UIImageView()   // [2026-10-18] "!" vermelho (última enviada falhou)
  private let receipt = CLReceiptView()
  private let typingDots = CLTypingDots()
  private let previewLabel = UILabel()
  private let muteIcon = UIImageView()
  private let pinIcon = UIImageView()
  private let mentionPill = CLPillView()
  private let unreadPill = CLPillView()
  private let avatarTap = UITapGestureRecognizer()

  private(set) var row = CLRow()
  private var theme = CLTheme(dark: false)
  private var labels = CLLabels()
  private var selectionMode = false
  // [2026-10-18 compact-list] densidade WhatsApp: linha 72 / avatar 52 / vão 12
  // (prop `density: 'compact'` da lista; regular = 76 / 54 / 14).
  private var compact = false
  private var fontsCategory: UIContentSizeCategory?

  static func avatarBox(compact: Bool) -> CGFloat { compact ? 52 : CLAvatarView.box }
  static func avatarGap(compact: Bool) -> CGFloat { compact ? 12 : 14 }

  // [2026-10-17 wa-cells] Tamanhos do WhatsApp iOS: nome 17 semibold (sem
  // engrossar quando não lida), prévia 15, hora 14, contador 13 em círculo 20.
  private var nameFont = UIFont.systemFont(ofSize: 17, weight: .semibold)
  private var nameBoldFont = UIFont.systemFont(ofSize: 17, weight: .semibold)
  private var activityFont = UIFont.systemFont(ofSize: 13, weight: .medium)
  private var timeFont = UIFont.monospacedDigitSystemFont(ofSize: 14, weight: .regular)
  private var timeBoldFont = UIFont.monospacedDigitSystemFont(ofSize: 14, weight: .semibold)
  private var previewFont = UIFont.systemFont(ofSize: 15, weight: .regular)
  private var previewSemibold = UIFont.systemFont(ofSize: 15, weight: .semibold)
  private var previewMedium = UIFont.systemFont(ofSize: 15, weight: .medium)
  private var pillFont = UIFont.monospacedDigitSystemFont(ofSize: 13, weight: .semibold)

  var onAvatarTap: ((String) -> Void)?
  var onA11yAction: ((String, String) -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    let cv = contentView
    cv.addSubview(check)
    cv.addSubview(avatar)
    for l in [nameLabel, activityLabel, timeLabel, previewLabel] {
      l.numberOfLines = 1
      l.lineBreakMode = .byTruncatingTail
      l.adjustsFontForContentSizeCategory = false
      cv.addSubview(l)
    }
    timeLabel.textAlignment = .right
    for iv in [lockIcon, clockIcon, failIcon, muteIcon, pinIcon] {
      iv.contentMode = .center
      cv.addSubview(iv)
    }
    cv.addSubview(receipt)
    cv.addSubview(typingDots)
    cv.addSubview(mentionPill)
    cv.addSubview(unreadPill)
    avatarTap.addTarget(self, action: #selector(avatarTapped))
    avatar.addGestureRecognizer(avatarTap)
    avatar.isUserInteractionEnabled = true
    isAccessibilityElement = true
    reloadFonts(force: true)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  // MARK: - Altura

  static func height(for traits: UITraitCollection, compact: Bool = false) -> CGFloat {
    let name = CLFonts.scaled(17, .semibold, cap: 1.35, traits: traits)
    let prev = CLFonts.scaled(15, .regular, cap: 1.3, traits: traits)
    let content = ceil(name.lineHeight) + 3 + ceil(prev.lineHeight) + 2
    return compact ? max(72, ceil(content + 18)) : max(76, ceil(content + 22))
  }

  override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
    let attrs = super.preferredLayoutAttributesFitting(layoutAttributes)
    attrs.frame.size.height = CLConversationCell.height(for: traitCollection, compact: compact)
    return attrs
  }

  private func reloadFonts(force: Bool = false) {
    let cat = traitCollection.preferredContentSizeCategory
    if !force, cat == fontsCategory { return }
    fontsCategory = cat
    let tc = traitCollection
    nameFont = CLFonts.scaled(17, .semibold, cap: 1.35, traits: tc)
    nameBoldFont = CLFonts.scaled(17, .semibold, cap: 1.35, traits: tc)
    activityFont = CLFonts.scaled(13, .medium, cap: 1.3, traits: tc)
    timeFont = CLFonts.scaled(14, .regular, cap: 1.3, traits: tc, mono: true)
    timeBoldFont = CLFonts.scaled(14, .semibold, cap: 1.3, traits: tc, mono: true)
    previewFont = CLFonts.scaled(15, .regular, cap: 1.3, traits: tc)
    previewSemibold = CLFonts.scaled(15, .semibold, cap: 1.3, traits: tc)
    previewMedium = CLFonts.scaled(15, .medium, cap: 1.3, traits: tc)
    pillFont = CLFonts.scaled(13, .semibold, cap: 1.15, traits: tc, mono: true)
  }

  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    if previousTraitCollection?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory {
      reloadFonts()
      apply(animated: false, previous: nil)
    }
  }

  // MARK: - Configuração

  func configure(_ newRow: CLRow, theme: CLTheme, labels: CLLabels, selectionMode: Bool, compact: Bool = false) {
    let previous: CLRow? = (row.id == newRow.id && !row.id.isEmpty) ? row : nil
    let themeChanged = theme.dark != self.theme.dark
    self.row = newRow
    self.theme = theme
    self.labels = labels
    self.selectionMode = selectionMode
    if compact != self.compact {
      self.compact = compact
      avatar.boxSize = CLConversationCell.avatarBox(compact: compact)
      setNeedsLayout()
    }
    reloadFonts()
    apply(animated: previous != nil && !themeChanged && window != nil, previous: previous)
    setNeedsUpdateConfiguration()
  }

  private var rowBackground: UIColor {
    // [2026-10-17 wa-cells] Fixada = fundo liso (como o WhatsApp); só o alfinete marca.
    return theme.bg
  }

  private func apply(animated: Bool, previous: CLRow?) {
    let r = row
    let unread = r.unreadVisible
    avatar.configure(r, theme: theme, rowBackground: rowBackground)
    // Em modo seleção (ou grupo/canal) o toque no avatar vira toque na linha.
    avatarTap.isEnabled = !selectionMode && !r.isGroupish

    check.isHidden = !selectionMode
    check.onColor = theme.pillBg
    check.tickColor = theme.pillTxt
    check.borderTint = theme.checkBorder
    check.checked = r.selected

    nameLabel.text = r.title
    nameLabel.font = unread ? nameBoldFont : nameFont
    nameLabel.textColor = theme.text
    activityLabel.isHidden = r.activity.isEmpty || r.isGroupish
    activityLabel.text = r.activity
    activityLabel.font = activityFont
    activityLabel.textColor = theme.sub

    timeLabel.text = r.time
    let timeStrong = r.timeBold
    timeLabel.font = timeStrong ? timeBoldFont : timeFont
    timeLabel.textColor = timeStrong ? theme.text : theme.sub

    lockIcon.isHidden = !r.locked
    lockIcon.image = r.locked ? CLSymbols.image("lock", pointSize: 11, weight: .semibold, color: theme.icon) : nil

    // Linha de baixo
    let typing = !r.typing.isEmpty && !r.locked
    let drafting = !typing && !r.draft.isEmpty && !r.locked
    typingDots.isHidden = !typing
    typingDots.color = theme.text
    if typing { typingDots.start() } else { typingDots.stop() }

    let showReceipt = !typing && !drafting && !r.locked && r.receipt > 0
    receipt.sentColor = theme.receiptSent
    receipt.grayColor = theme.receiptGray
    receipt.readColor = theme.receiptRead
    receipt.setState(showReceipt ? r.receipt : 0, animated: animated && (previous?.receipt ?? 0) != r.receipt)

    // [2026-10-18] falha definitiva: "!" vermelho no lugar do relógio/✓ (o JS manda
    // receipt 0 + failed:true). Falha vence o relógio de "na fila".
    let showFailed = r.failed && r.receipt <= 0 && !typing && !drafting && !r.locked
    failIcon.isHidden = !showFailed
    if showFailed {
      failIcon.image = CLSymbols.image("exclamationmark.circle.fill", pointSize: 12, weight: .semibold, color: theme.danger)
      failIcon.accessibilityLabel = labels.get("notSent", "Não enviada")
    }
    clockIcon.isHidden = showFailed || !((r.scheduled || (r.pending && r.receipt <= 0)) && !typing && !drafting && !r.locked)
    if !clockIcon.isHidden {
      clockIcon.image = CLSymbols.image("clock", pointSize: 11, weight: .medium, color: theme.sub)
    }

    previewLabel.attributedText = buildPreview(typing: typing, drafting: drafting, unread: unread)
    // [2026-10-16 wave8-list] "digitando…" entra/sai em crossfade curto (sem
    // trocar o texto num corte seco).
    if animated, let p = previous, p.typing.isEmpty != r.typing.isEmpty, !CLMotion.reduced {
      let fade = CATransition()
      fade.type = .fade
      fade.duration = 0.18
      previewLabel.layer.add(fade, forKey: "typingFade")
    }

    muteIcon.isHidden = !r.muted
    if r.muted {
      muteIcon.image = CLSymbols.image("bell.slash", pointSize: 13, weight: .regular, color: theme.icon)
    }
    if animated, let p = previous, p.muted != r.muted {
      muteIcon.alpha = r.muted ? 0 : 1
      muteIcon.isHidden = false
      UIView.animate(withDuration: 0.2, animations: { self.muteIcon.alpha = r.muted ? 1 : 0 }, completion: { _ in
        self.muteIcon.alpha = 1
        self.muteIcon.isHidden = !self.row.muted
      })
    }
    pinIcon.isHidden = !r.pinned
    if r.pinned {
      pinIcon.image = CLSymbols.image("pin", pointSize: 13, weight: .regular, color: theme.icon)
    }

    mentionPill.isHidden = !r.mention
    mentionPill.backgroundColor = theme.pillBg
    mentionPill.label.text = "@"
    mentionPill.label.font = CLFonts.scaled(13, .bold, cap: 1.15, traits: traitCollection)
    mentionPill.label.textColor = theme.pillTxt

    unreadPill.isHidden = !unread
    let mutedPill = r.muted && !r.mention
    unreadPill.backgroundColor = mutedPill ? theme.mutedPillBg : theme.pillBg
    unreadPill.label.textColor = mutedPill ? theme.mutedPillTxt : theme.pillTxt
    unreadPill.label.font = pillFont
    // [2026-10-16 wave8-list] Dígitos rolando quando o número muda com a pílula
    // já na tela (2→3 sobe, 3→2 desce); pílula que acabou de aparecer só "pula".
    let pillText = r.unread > 99 ? "99+" : String(r.unread)
    let rollPill = animated && (previous?.unreadVisible ?? false) && unread && (previous?.unread ?? r.unread) != r.unread
    unreadPill.setRollingText(pillText, animated: rollPill)

    // Pulo da pílula só quando o número SOBE (mesma regra do JS).
    if animated, let p = previous {
      if r.unread > p.unread && unread { unreadPill.pop() }
      if r.mention && !p.mention { mentionPill.pop() }
    }

    // Acessibilidade: a linha é UM elemento com rótulo completo + ações.
    accessibilityLabel = r.a11y.isEmpty ? r.title : r.a11y
    accessibilityTraits = selectionMode && r.selected ? [.button, .selected] : .button
    accessibilityHint = selectionMode ? nil : labels.get("a11yOpenHint", "Toque duas vezes para abrir. Há mais ações disponíveis.")
    accessibilityCustomActions = selectionMode ? [] : buildA11yActions()

    setNeedsLayout()
    // [2026-10-16 wave8-list] ✓ → ✓✓ alarga o recibo 7 pt: a prévia desliza
    // junto (mola curta) em vez de pular.
    if animated, let p = previous, p.receipt == 1, r.receipt >= 2, showReceipt, p.text == r.text, !CLMotion.reduced {
      UIView.animate(withDuration: 0.26, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState, .curveEaseOut, .overrideInheritedDuration, .overrideInheritedCurve], animations: {
        self.layoutIfNeeded()
      }, completion: nil)
    }
  }

  private func attachment(_ symbol: String, color: UIColor, font: UIFont) -> NSAttributedString? {
    guard let img = CLSymbols.image(symbol, pointSize: font.pointSize * 0.86, weight: .regular, color: color) else { return nil }
    let att = NSTextAttachment()
    att.image = img
    let h = img.size.height
    att.bounds = CGRect(x: 0, y: (font.capHeight - h) / 2, width: img.size.width, height: h)
    let s = NSMutableAttributedString(attachment: att)
    s.append(NSAttributedString(string: " ", attributes: [.font: font]))
    return s
  }

  private func buildPreview(typing: Bool, drafting: Bool, unread: Bool) -> NSAttributedString {
    let r = row
    let out = NSMutableAttributedString()
    if r.locked {
      if let a = attachment("lock", color: theme.sub, font: previewFont) { out.append(a) }
      out.append(NSAttributedString(string: r.text, attributes: [.font: previewFont, .foregroundColor: theme.sub]))
      return out
    }
    if typing {
      out.append(NSAttributedString(string: r.typing, attributes: [.font: previewMedium, .foregroundColor: theme.text]))
      return out
    }
    if drafting {
      let tint = r.draftFresh ? theme.text : theme.sub
      var head = r.draftLabel.isEmpty ? labels.get("draft", "Rascunho") : r.draftLabel
      if !r.draftAge.isEmpty { head += " · " + r.draftAge }
      out.append(NSAttributedString(string: head + ": ", attributes: [.font: previewSemibold, .foregroundColor: tint]))
      out.append(NSAttributedString(string: r.draft, attributes: [.font: previewFont, .foregroundColor: theme.sub]))
      return out
    }
    let bodyColor = unread ? theme.subStrong : theme.sub
    if !r.sender.isEmpty {
      out.append(NSAttributedString(string: r.sender + ": ", attributes: [.font: previewMedium, .foregroundColor: unread ? theme.text : theme.sub]))
    }
    if let sym = CLSymbols.name(forPreviewIcon: r.icon), let a = attachment(sym, color: bodyColor, font: previewFont) {
      out.append(a)
    }
    let body = (r.text.isEmpty && r.sender.isEmpty && r.icon.isEmpty) ? r.empty : r.text
    // [wave13-C] mensagem apagada: ⊘ + itálico (como o WhatsApp)
    var bodyFont = previewFont
    if r.icon == "ban", let d = previewFont.fontDescriptor.withSymbolicTraits(.traitItalic) {
      bodyFont = UIFont(descriptor: d, size: previewFont.pointSize)
    }
    out.append(NSAttributedString(string: body, attributes: [.font: bodyFont, .foregroundColor: bodyColor]))
    return out
  }

  private func buildA11yActions() -> [UIAccessibilityCustomAction] {
    let r = row
    var list: [(String, String)] = [
      ("toggleRead", r.unreadVisible ? labels.get("markRead", "Marcar como lida") : labels.get("markUnread", "Marcar como não lida")),
      ("pin", r.pinned ? labels.get("unpin", "Desafixar") : labels.get("pin", "Fixar")),
      ("mute", r.muted ? labels.get("unmute", "Reativar som") : labels.get("mute", "Silenciar")),
      ("archive", r.archived ? labels.get("unarchive", "Desarquivar") : labels.get("archive", "Arquivar")),
      ("delete", labels.get("delete", "Apagar")),
    ]
    if !r.isGroupish && r.kind != "saved" {
      list.append(("photo", r.ring.isEmpty ? labels.get("viewPhoto", "Ver foto do perfil") : labels.get("viewStatus", "Ver status")))
    }
    list.append(("more", labels.get("more", "Mais opções")))
    let id = r.id
    return list.map { (action, title) in
      UIAccessibilityCustomAction(name: title) { [weak self] _ in
        self?.onA11yAction?(id, action)
        return true
      }
    }
  }

  @objc private func avatarTapped() {
    if selectionMode { return }
    onAvatarTap?(row.id)
  }


  // MARK: - Fundo (fixada / selecionada / pressionada)

  override func updateConfiguration(using state: UICellConfigurationState) {
    var bg = UIBackgroundConfiguration.listPlainCell()
    let base: UIColor = row.selected && selectionMode ? theme.selectedBg : theme.bg
    if state.isHighlighted || state.isSelected || state.isSwiped {
      bg.backgroundColor = theme.dark ? UIColor(clHex: 0x1A1A1A) : UIColor(clHex: 0xF0F0F0)
    } else if row.selected && selectionMode {
      // selectedBg é translúcido → compõe sobre o fundo da lista.
      bg.backgroundColor = theme.bg
      bg.customView = {
        let v = UIView()
        v.backgroundColor = base
        return v
      }()
    } else {
      bg.backgroundColor = base
    }
    backgroundConfiguration = bg
    avatar.updateRowBackground(theme.bg)
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    typingDots.stop()
    unreadPill.layer.removeAllAnimations()
    unreadPill.cancelRoll()
    mentionPill.layer.removeAllAnimations()
    receipt.layer.removeAllAnimations()
  }

  // MARK: - Layout

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = contentView.bounds
    let W = b.width
    let H = b.height
    var x: CGFloat = 16
    if selectionMode {
      check.frame = CGRect(x: x, y: (H - 26) / 2, width: 26, height: 26)
      x += 36
    }
    let box = CLConversationCell.avatarBox(compact: compact)
    avatar.frame = CGRect(x: x, y: (H - box) / 2, width: box, height: box)
    let textX = x + box + CLConversationCell.avatarGap(compact: compact)
    let right = W - 16

    let nf = nameLabel.font ?? nameFont
    let nameH = ceil(nf.lineHeight)
    let prevH = ceil(previewFont.lineHeight) + 2
    let total = nameH + 3 + prevH
    let top = floor((H - total) / 2)

    // ── linha de cima: nome · online ………… cadeado · hora
    let tf = timeLabel.font ?? timeFont
    let tw = ceil(timeLabel.intrinsicContentSize.width)
    let timeH = ceil(tf.lineHeight)
    let baseDelta = nf.ascender - tf.ascender
    timeLabel.frame = CGRect(x: right - tw, y: top + baseDelta, width: tw, height: timeH)
    var rx = right - tw
    if !lockIcon.isHidden {
      let s: CGFloat = 13
      lockIcon.frame = CGRect(x: rx - 5 - s, y: top + (nameH - s) / 2, width: s, height: s)
      rx -= 5 + s
    }
    let nameMax = max(0, rx - 10 - textX)
    var aw: CGFloat = 0
    if !activityLabel.isHidden {
      aw = min(ceil(activityLabel.intrinsicContentSize.width), 90)
    }
    let nameNatural = ceil(nameLabel.intrinsicContentSize.width)
    let nameW = min(nameNatural, max(0, nameMax - (aw > 0 ? aw + 6 : 0)))
    nameLabel.frame = CGRect(x: textX, y: top, width: nameW, height: nameH)
    if aw > 0 {
      let af = activityLabel.font ?? activityFont
      activityLabel.frame = CGRect(x: textX + nameW + 6, y: top + (nf.ascender - af.ascender), width: aw, height: ceil(af.lineHeight))
    }

    // ── linha de baixo: [⏰][✓✓] prévia ………… 🔕 📌 @ (3)
    let by = top + nameH + 3
    let cy = by + prevH / 2
    var bx = right
    let pillH: CGFloat = 20
    if !unreadPill.isHidden {
      let sz = unreadPill.size(height: pillH, padding: 12)
      unreadPill.frame = CGRect(x: bx - sz.width, y: cy - pillH / 2, width: sz.width, height: pillH)
      bx -= sz.width + 6
    }
    if !mentionPill.isHidden {
      mentionPill.frame = CGRect(x: bx - pillH, y: cy - pillH / 2, width: pillH, height: pillH)
      bx -= pillH + 6
    }
    let icon: CGFloat = 16
    if !pinIcon.isHidden {
      pinIcon.frame = CGRect(x: bx - icon, y: cy - icon / 2, width: icon, height: icon)
      bx -= icon + 6
    }
    if !muteIcon.isHidden {
      muteIcon.frame = CGRect(x: bx - icon, y: cy - icon / 2, width: icon, height: icon)
      bx -= icon + 6
    }
    let previewRight = (bx < right) ? bx + 6 - 10 : right
    var px = textX
    if !typingDots.isHidden {
      typingDots.frame = CGRect(x: px, y: cy - 4, width: CLTypingDots.width, height: 8)
      px += CLTypingDots.width + 6
    }
    if !failIcon.isHidden {
      failIcon.frame = CGRect(x: px, y: cy - 7, width: 14, height: 14)
      px += 14 + 4
    }
    if !clockIcon.isHidden {
      clockIcon.frame = CGRect(x: px, y: cy - 7, width: 14, height: 14)
      px += 14 + 4
    }
    if !receipt.isHidden {
      let w = receipt.intrinsicWidth
      receipt.frame = CGRect(x: px, y: cy - 7.5, width: CLReceiptView.doubleWidth, height: 15)
      px += w + 3
    }
    previewLabel.frame = CGRect(x: px, y: by, width: max(0, previewRight - px), height: prevH)
  }
}
