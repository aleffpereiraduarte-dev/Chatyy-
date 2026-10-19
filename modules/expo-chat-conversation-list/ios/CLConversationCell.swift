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
  // [2026-10-19 tg-list] Telegram: nome de quem mandou (grupo) em linha própria.
  private let senderLabel = UILabel()
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
  // [2026-10-19 tg-list] densidade "telegram" (prop `density: "telegram"`, api 9):
  // linha 78 / avatar 58 / margem 12 / vão 10 (texto e separador em 80),
  // prévia em 2 linhas (grupo: remetente numa linha + texto na outra),
  // ✓✓ ao lado da hora, silenciado ao lado do nome, alfinete no lugar do
  // contador, "digitando…" na cor de destaque e "Rascunho:" em vermelho.
  private var tg = false
  private var accent: UIColor?
  private var fontsCategory: UIContentSizeCategory?

  static func avatarBox(compact: Bool, tg: Bool = false) -> CGFloat { tg ? 58 : (compact ? 52 : CLAvatarView.box) }
  static func avatarGap(compact: Bool, tg: Bool = false) -> CGFloat { tg ? 10 : (compact ? 12 : 14) }
  static func leftInset(tg: Bool) -> CGFloat { tg ? 12 : 16 }
  /// x do texto (e do separador) sem o modo seleção.
  static func textInset(compact: Bool, tg: Bool) -> CGFloat {
    return leftInset(tg: tg) + avatarBox(compact: compact, tg: tg) + avatarGap(compact: compact, tg: tg)
  }

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
    for l in [nameLabel, activityLabel, timeLabel, previewLabel, senderLabel] {
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

  static func height(for traits: UITraitCollection, compact: Bool = false, tg: Bool = false) -> CGFloat {
    let name = CLFonts.scaled(17, .semibold, cap: 1.35, traits: traits)
    let prev = CLFonts.scaled(15, .regular, cap: 1.3, traits: traits)
    if tg {
      let block = ceil(name.lineHeight) + 3 + ceil(prev.lineHeight) * 2
      return max(78, ceil(block + 18))
    }
    let content = ceil(name.lineHeight) + 3 + ceil(prev.lineHeight) + 2
    return compact ? max(72, ceil(content + 18)) : max(76, ceil(content + 22))
  }

  override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
    let attrs = super.preferredLayoutAttributesFitting(layoutAttributes)
    attrs.frame.size.height = CLConversationCell.height(for: traitCollection, compact: compact, tg: tg)
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
    pillFont = CLFonts.scaled(13, tg ? .bold : .semibold, cap: 1.15, traits: tc, mono: true)
  }

  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    if previousTraitCollection?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory {
      reloadFonts()
      apply(animated: false, previous: nil)
    }
  }

  // MARK: - Configuração

  func configure(_ newRow: CLRow, theme: CLTheme, labels: CLLabels, selectionMode: Bool, compact: Bool = false, tg: Bool = false, accent: UIColor? = nil) {
    let previous: CLRow? = (row.id == newRow.id && !row.id.isEmpty) ? row : nil
    let themeChanged = theme.dark != self.theme.dark
    self.row = newRow
    self.theme = theme
    self.labels = labels
    self.selectionMode = selectionMode
    self.accent = accent
    if compact != self.compact || tg != self.tg {
      let tgChanged = tg != self.tg
      self.compact = compact
      self.tg = tg
      avatar.boxSize = CLConversationCell.avatarBox(compact: compact, tg: tg)
      setNeedsLayout()
      if tgChanged { reloadFonts(force: true) }
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
    // Telegram: hora sempre cinza/regular (o contador já marca a não lida).
    let timeStrong = r.timeBold && !tg
    timeLabel.font = timeStrong ? timeBoldFont : timeFont
    timeLabel.textColor = timeStrong ? theme.text : theme.sub

    lockIcon.isHidden = !r.locked
    lockIcon.image = r.locked ? CLSymbols.image("lock", pointSize: 11, weight: .semibold, color: theme.icon) : nil

    // Linha de baixo
    let typing = !r.typing.isEmpty && !r.locked
    let drafting = !typing && !r.draft.isEmpty && !r.locked
    typingDots.isHidden = !typing
    typingDots.color = tg ? typingTint : theme.text
    if typing { typingDots.start() } else { typingDots.stop() }

    let showReceipt = !typing && !drafting && !r.locked && r.receipt > 0
    // tg: enviado/entregue no MESMO cinza da hora (✓✓ e hora lidos como um bloco).
    receipt.sentColor = tg ? theme.sub : theme.receiptSent
    receipt.grayColor = tg ? theme.sub : theme.receiptGray
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

    // tg: remetente do grupo numa linha própria (cor do texto), mensagem embaixo.
    let senderLine = tg && !typing && !drafting && !r.locked && r.isGroupish && !r.sender.isEmpty
    senderLabel.isHidden = !senderLine
    if senderLine {
      senderLabel.attributedText = NSAttributedString(string: r.sender, attributes: [.font: previewFont, .foregroundColor: theme.text])
    } else {
      senderLabel.attributedText = nil
    }
    let ownMark = showReceipt || showFailed || !clockIcon.isHidden
    previewLabel.numberOfLines = (tg && !senderLine && !typing) ? 2 : 1
    previewLabel.attributedText = buildPreview(typing: typing, drafting: drafting, unread: unread, senderLine: senderLine, ownMark: ownMark)
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
      muteIcon.image = tg
        ? CLSymbols.image("speaker.slash.fill", pointSize: 11, weight: .regular, color: theme.faint)
        : CLSymbols.image("bell.slash", pointSize: 13, weight: .regular, color: theme.icon)
    }
    if animated, let p = previous, p.muted != r.muted {
      muteIcon.alpha = r.muted ? 0 : 1
      muteIcon.isHidden = false
      UIView.animate(withDuration: 0.2, animations: { self.muteIcon.alpha = r.muted ? 1 : 0 }, completion: { _ in
        self.muteIcon.alpha = 1
        self.muteIcon.isHidden = !self.row.muted
      })
    }
    // tg: alfinete só quando não há contador/menção (mesmo lugar, como no Telegram).
    pinIcon.isHidden = !r.pinned || (tg && (unread || r.mention))
    if !pinIcon.isHidden {
      pinIcon.image = tg
        ? CLSymbols.image("pin.fill", pointSize: 12, weight: .regular, color: theme.faint)
        : CLSymbols.image("pin", pointSize: 13, weight: .regular, color: theme.icon)
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

  /// Cor do "digitando…" no modo Telegram: destaque escolhido (o JS já troca
  /// o preto-tinta por claro no escuro); sem destaque = cor do texto.
  private var typingTint: UIColor { return accent ?? theme.text }

  private func buildPreview(typing: Bool, drafting: Bool, unread: Bool, senderLine: Bool = false, ownMark: Bool = false) -> NSAttributedString {
    let r = row
    let out = NSMutableAttributedString()
    if r.locked {
      if let a = attachment("lock", color: theme.sub, font: previewFont) { out.append(a) }
      out.append(NSAttributedString(string: r.text, attributes: [.font: previewFont, .foregroundColor: theme.sub]))
      return out
    }
    if typing {
      out.append(NSAttributedString(string: r.typing, attributes: [.font: tg ? previewFont : previewMedium, .foregroundColor: tg ? typingTint : theme.text]))
      return out
    }
    if drafting {
      // tg: "Rascunho:" sempre em vermelho (Telegram), corpo em cinza.
      let tint = tg ? theme.danger : (r.draftFresh ? theme.text : theme.sub)
      var head = r.draftLabel.isEmpty ? labels.get("draft", "Rascunho") : r.draftLabel
      if !r.draftAge.isEmpty { head += " · " + r.draftAge }
      out.append(NSAttributedString(string: head + ": ", attributes: [.font: tg ? previewFont : previewSemibold, .foregroundColor: tint]))
      out.append(NSAttributedString(string: r.draft, attributes: [.font: previewFont, .foregroundColor: theme.sub]))
      return out
    }
    let bodyColor = (unread && !tg) ? theme.subStrong : theme.sub
    // tg: no grupo o remetente vai na linha de cima; numa conversa direta o
    // "Você:" sai quando ✓/relógio/"!" já dizem que a mensagem é minha.
    let inlineSender = !r.sender.isEmpty && !senderLine && !(tg && !r.isGroupish && ownMark)
    if inlineSender {
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
    if tg {
      layoutTelegram()
      return
    }
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
  // [2026-10-19 tg-list] Layout Telegram iOS:
  //   [avatar 58]  Nome 🔇 · online …………… 🔒 ✓✓ 14:02
  //                prévia em até 2 linhas (ou remetente / texto)   (3) | 📌
  private func layoutTelegram() {
    let b = contentView.bounds
    let W = b.width
    let H = b.height
    var x: CGFloat = CLConversationCell.leftInset(tg: true)
    if selectionMode {
      check.frame = CGRect(x: x, y: (H - 26) / 2, width: 26, height: 26)
      x += 36
    }
    let box = CLConversationCell.avatarBox(compact: compact, tg: true)
    avatar.frame = CGRect(x: x, y: (H - box) / 2, width: box, height: box)
    let textX = x + box + CLConversationCell.avatarGap(compact: compact, tg: true)
    let right = W - 16

    let nf = nameLabel.font ?? nameFont
    let nameH = ceil(nf.lineHeight)
    let lineH = ceil(previewFont.lineHeight)
    let blockH = lineH * 2
    let total = nameH + 3 + blockH
    let top = floor((H - total) / 2)

    // ── linha de cima: nome 🔇 online ………… 🔒 ✓✓ hora
    let tf = timeLabel.font ?? timeFont
    let tw = ceil(timeLabel.intrinsicContentSize.width)
    let timeH = ceil(tf.lineHeight)
    let baseDelta = nf.ascender - tf.ascender
    timeLabel.frame = CGRect(x: right - tw, y: top + baseDelta, width: tw, height: timeH)
    let nameMid = top + nameH / 2
    var rx = right - tw
    if !receipt.isHidden {
      let w = receipt.intrinsicWidth
      if w > 0 {
        receipt.frame = CGRect(x: rx - 4 - w, y: nameMid - 7.5, width: CLReceiptView.doubleWidth, height: 15)
        rx -= 4 + w
      } else {
        receipt.frame = .zero
      }
    }
    if !failIcon.isHidden {
      failIcon.frame = CGRect(x: rx - 4 - 14, y: nameMid - 7, width: 14, height: 14)
      rx -= 4 + 14
    }
    if !clockIcon.isHidden {
      clockIcon.frame = CGRect(x: rx - 4 - 14, y: nameMid - 7, width: 14, height: 14)
      rx -= 4 + 14
    }
    if !lockIcon.isHidden {
      let s: CGFloat = 13
      lockIcon.frame = CGRect(x: rx - 5 - s, y: nameMid - s / 2, width: s, height: s)
      rx -= 5 + s
    }
    let nameMax = max(0, rx - 8 - textX)
    let muteW: CGFloat = muteIcon.isHidden ? 0 : 14
    var aw: CGFloat = 0
    if !activityLabel.isHidden {
      aw = min(ceil(activityLabel.intrinsicContentSize.width), 90)
    }
    let extras = (muteW > 0 ? muteW + 4 : 0) + (aw > 0 ? aw + 6 : 0)
    let nameNatural = ceil(nameLabel.intrinsicContentSize.width)
    let nameW = min(nameNatural, max(0, nameMax - extras))
    nameLabel.frame = CGRect(x: textX, y: top, width: nameW, height: nameH)
    var nx = textX + nameW
    if muteW > 0 {
      muteIcon.frame = CGRect(x: nx + 4, y: nameMid - 7, width: muteW, height: 14)
      nx += 4 + muteW
    }
    if aw > 0 {
      let af = activityLabel.font ?? activityFont
      activityLabel.frame = CGRect(x: nx + 6, y: top + (nf.ascender - af.ascender), width: aw, height: ceil(af.lineHeight))
    }

    // ── bloco de baixo (2 linhas): prévia ……… contador / @ / alfinete
    let by = top + nameH + 3
    let cy = by + lineH * 1.5   // centro da 2ª linha (Telegram)
    var bx = right
    let pillH: CGFloat = 20
    if !unreadPill.isHidden {
      let sz = unreadPill.size(height: pillH, padding: 13)
      unreadPill.frame = CGRect(x: bx - sz.width, y: cy - pillH / 2, width: sz.width, height: pillH)
      bx -= sz.width + 6
    }
    if !mentionPill.isHidden {
      mentionPill.frame = CGRect(x: bx - pillH, y: cy - pillH / 2, width: pillH, height: pillH)
      bx -= pillH + 6
    }
    if !pinIcon.isHidden {
      let icon: CGFloat = 16
      pinIcon.frame = CGRect(x: bx - icon, y: cy - icon / 2, width: icon, height: icon)
      bx -= icon + 6
    }
    let previewRight = (bx < right) ? bx + 6 - 12 : right
    var px = textX
    if !typingDots.isHidden {
      typingDots.frame = CGRect(x: px, y: by + lineH / 2 - 4, width: CLTypingDots.width, height: 8)
      px += CLTypingDots.width + 6
    }
    let pw = max(0, previewRight - px)
    if !senderLabel.isHidden {
      senderLabel.frame = CGRect(x: textX, y: by, width: max(0, previewRight - textX), height: lineH)
      previewLabel.frame = CGRect(x: px, y: by + lineH, width: pw, height: lineH + 2)
    } else {
      // UILabel centraliza na vertical: altura = o que o texto ocupa (1 ou 2 linhas).
      let fit = previewLabel.sizeThatFits(CGSize(width: pw, height: blockH + 4)).height
      let ph = min(blockH + 2, max(lineH + 2, ceil(fit)))
      previewLabel.frame = CGRect(x: px, y: by, width: pw, height: ph)
    }
  }
}
