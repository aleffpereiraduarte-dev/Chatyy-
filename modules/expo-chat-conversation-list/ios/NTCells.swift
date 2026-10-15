import UIKit

// [2026-10-15 native-notes] Células da lista de NOTAS nativa (ChatyyNotesList).
// Card P&B igual ao NoteCardItem de app/notes.js: fundo surface, borda fina,
// faixa da cor da nota à esquerda, alfinete quando fixada, título (2 linhas),
// prévia (3 linhas na lista / o que couber na grade), etiquetas, rodapé com
// lembrete, caderno e data. Layout manual (frames) — a MESMA função mede a
// altura (lista auto-dimensionada) e posiciona as views.

// MARK: - Seção ("Fixadas", "Com lembrete", "Outras"…)

final class NTSectionCell: UICollectionViewListCell {
  private let label = UILabel()
  private var bg: UIColor = .clear
  private var hasTitle = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    label.lineBreakMode = .byTruncatingTail
    contentView.addSubview(label)
    isAccessibilityElement = true
    accessibilityTraits = .header
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ r: NTRow, style s: NTStyle) {
    hasTitle = !r.title.isEmpty
    let tc = traitCollection
    label.attributedText = NSAttributedString(string: r.title.uppercased(), attributes: [
      .font: CLFonts.scaled(12, .semibold, cap: 1.3, traits: tc),
      .foregroundColor: s.colors.faint,
      .kern: 0.5,
    ])
    label.isHidden = !hasTitle
    accessibilityLabel = r.title
    isAccessibilityElement = hasTitle
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

  override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
    let attrs = super.preferredLayoutAttributesFitting(layoutAttributes)
    attrs.frame.size.height = hasTitle ? NTMetrics.sectionH : NTMetrics.spacerH
    return attrs
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = contentView.bounds
    let lh = ceil(label.font?.lineHeight ?? 15)
    let x = NTMetrics.cellPadH
    label.frame = CGRect(x: x, y: b.height - 8 - lh, width: max(0, b.width - 2 * x), height: lh + 1)
  }
}

// MARK: - Card da nota

struct NTCardLayout {
  var height: CGFloat = 0
  var card: CGRect = .zero
  var pin: CGRect = .zero
  var title: CGRect = .zero
  var preview: CGRect = .zero
  var previewLines: Int = 0
  var tags: [CGRect] = []
  var reminder: CGRect = .zero
  var notebook: CGRect = .zero
  var date: CGRect = .zero
}

final class NTNoteCell: UICollectionViewListCell {
  private(set) var row = NTRow()
  private var style = NTStyle()

  private let card = UIView()
  /// Card visível (prévia do menu de contexto recorta nele).
  var cardView: UIView { card }
  private let strip = UIView()
  private let pinView = UIImageView()
  private let titleLabel = UILabel()
  private let previewLabel = UILabel()
  private var tagLabels: [UILabel] = []
  private let reminderLabel = UILabel()
  private let notebookLabel = UILabel()
  private let dateLabel = UILabel()
  private var pressed = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    let cv = contentView
    card.layer.cornerRadius = NTMetrics.radius
    card.layer.cornerCurve = .continuous
    card.layer.borderWidth = 1
    card.clipsToBounds = true
    card.isUserInteractionEnabled = false
    cv.addSubview(card)
    card.addSubview(strip)
    pinView.contentMode = .center
    pinView.transform = CGAffineTransform(rotationAngle: .pi / 9)
    card.addSubview(pinView)
    titleLabel.lineBreakMode = .byTruncatingTail
    titleLabel.numberOfLines = 2
    card.addSubview(titleLabel)
    previewLabel.lineBreakMode = .byTruncatingTail
    card.addSubview(previewLabel)
    for _ in 0..<4 {
      let l = NTNoteCell.chipLabel()
      card.addSubview(l)
      tagLabels.append(l)
    }
    reminderLabel.layer.cornerRadius = 10
    reminderLabel.layer.borderWidth = 1
    reminderLabel.clipsToBounds = true
    reminderLabel.textAlignment = .center
    card.addSubview(reminderLabel)
    notebookLabel.layer.cornerRadius = 8
    notebookLabel.clipsToBounds = true
    notebookLabel.textAlignment = .center
    card.addSubview(notebookLabel)
    dateLabel.textAlignment = .right
    card.addSubview(dateLabel)
    isAccessibilityElement = true
    accessibilityTraits = .button
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private static func chipLabel() -> UILabel {
    let l = UILabel()
    l.layer.cornerRadius = 10
    l.clipsToBounds = true
    l.textAlignment = .center
    l.lineBreakMode = .byTruncatingTail
    return l
  }

  // MARK: Fontes / textos (compartilhados com a medida)

  private static func fonts(_ tc: UITraitCollection?) -> (title: UIFont, titleHit: UIFont, preview: UIFont, previewHit: UIFont, chip: UIFont, date: UIFont) {
    return (
      CLFonts.scaled(16, .bold, cap: 1.35, traits: tc),
      CLFonts.scaled(16, .heavy, cap: 1.35, traits: tc),
      CLFonts.scaled(13, .regular, cap: 1.35, traits: tc),
      CLFonts.scaled(13, .bold, cap: 1.35, traits: tc),
      CLFonts.scaled(11, .semibold, cap: 1.2, traits: tc),
      CLFonts.scaled(11, .regular, cap: 1.3, traits: tc)
    )
  }

  private static func previewLineH(_ f: UIFont) -> CGFloat {
    return ceil(max(f.lineHeight, f.pointSize * 19 / 13))
  }

  private static func titleText(_ r: NTRow, _ s: NTStyle, _ tc: UITraitCollection?) -> NSAttributedString? {
    let f = fonts(tc)
    if r.title.isEmpty {
      if !r.preview.isEmpty || r.placeholder.isEmpty { return nil }
      // "Sem título" em itálico (JS: noteContent fontStyle italic).
      let it = UIFont(descriptor: f.preview.fontDescriptor.withSymbolicTraits(.traitItalic) ?? f.preview.fontDescriptor, size: f.preview.pointSize)
      return NSAttributedString(string: r.placeholder, attributes: [.font: it, .foregroundColor: s.colors.sub])
    }
    let a = NSMutableAttributedString(string: r.title, attributes: [
      .font: f.title, .foregroundColor: s.colors.text, .kern: -0.2,
    ])
    highlight(a, s, font: f.titleHit)
    return a
  }

  private static func previewText(_ r: NTRow, _ s: NTStyle, _ tc: UITraitCollection?) -> NSAttributedString? {
    if r.preview.isEmpty { return nil }
    let f = fonts(tc)
    let lh = previewLineH(f.preview)
    let p = NSMutableParagraphStyle()
    p.minimumLineHeight = lh
    p.maximumLineHeight = lh
    p.lineBreakMode = .byTruncatingTail
    let a = NSMutableAttributedString(string: r.preview, attributes: [
      .font: f.preview, .foregroundColor: s.colors.sub, .paragraphStyle: p,
    ])
    highlight(a, s, font: f.previewHit)
    return a
  }

  /// Destaque do termo (sem caixa/acento) — negrito + fundo leve (P&B; o JS usa amarelo).
  private static func highlight(_ a: NSMutableAttributedString, _ s: NTStyle, font: UIFont) {
    if s.tokens.isEmpty { return }
    let bg = s.colors.dark ? UIColor(white: 1, alpha: 0.18) : UIColor(white: 0, alpha: 0.10)
    for r in RLHighlight.ranges(in: a.string, tokens: s.tokens) {
      a.addAttributes([.font: font, .foregroundColor: s.colors.text, .backgroundColor: bg], range: r)
    }
  }

  private static func reminderText(_ r: NTRow, _ s: NTStyle, _ tc: UITraitCollection?) -> NSAttributedString? {
    if r.reminder.isEmpty { return nil }
    let f = fonts(tc)
    let a = NSMutableAttributedString()
    if let img = CLSymbols.image("bell", pointSize: f.chip.pointSize - 1, weight: .medium, color: s.colors.sub) {
      let att = NSTextAttachment()
      att.image = img
      att.bounds = CGRect(x: 0, y: -1.5, width: img.size.width, height: img.size.height)
      a.append(NSAttributedString(attachment: att))
      a.append(NSAttributedString(string: " "))
    }
    var attrs: [NSAttributedString.Key: Any] = [.font: f.chip, .foregroundColor: s.colors.sub]
    if r.reminderOverdue { attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
    a.append(NSAttributedString(string: r.reminder, attributes: attrs))
    if r.reminderRepeat, let img = CLSymbols.image("repeat", pointSize: f.chip.pointSize - 2, weight: .medium, color: s.colors.sub) {
      let att = NSTextAttachment()
      att.image = img
      att.bounds = CGRect(x: 0, y: -1, width: img.size.width, height: img.size.height)
      a.append(NSAttributedString(string: " "))
      a.append(NSAttributedString(attachment: att))
    }
    return a
  }

  private static func textHeight(_ s: NSAttributedString, width: CGFloat, maxLines: Int, lineH: CGFloat) -> CGFloat {
    if maxLines <= 0 || width <= 0 { return 0 }
    let r = s.boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude),
                           options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
    return min(ceil(r.height), CGFloat(maxLines) * lineH)
  }

  /// Layout completo do card para uma largura de CÉLULA. Na grade a altura é
  /// fixa (NTMetrics.gridHeight) e a prévia ocupa o que sobrar.
  static func layout(_ r: NTRow, width: CGFloat, style s: NTStyle, traits tc: UITraitCollection?) -> NTCardLayout {
    var L = NTCardLayout()
    let f = fonts(tc)
    let cardW = max(0, width - 2 * NTMetrics.cellPadH)
    let x0 = NTMetrics.strip + NTMetrics.padLeft
    let innerW = max(0, cardW - x0 - NTMetrics.padRight)
    var y = NTMetrics.padTop

    L.pin = CGRect(x: cardW - 10 - 18, y: 8, width: 18, height: 18)

    if let t = titleText(r, s, tc) {
      let lh = ceil((r.title.isEmpty ? f.preview : f.title).lineHeight)
      let w = max(0, innerW - 24) // noteTitle paddingRight 24 (alfinete)
      let h = textHeight(t, width: w, maxLines: r.title.isEmpty ? 1 : 2, lineH: lh)
      L.title = CGRect(x: x0, y: y, width: w, height: h)
      y += h + (r.preview.isEmpty ? 0 : NTMetrics.titleGap)
    }

    // Etiquetas + rodapé (medidos antes: na grade a prévia usa o que sobra).
    var tagW: [CGFloat] = []
    for tag in r.tags {
      let tw = ceil(("#" + tag as NSString).size(withAttributes: [.font: f.chip]).width) + 16
      tagW.append(min(tw, innerW))
    }
    let hasTags = !tagW.isEmpty
    let chipH = max(NTMetrics.chipH, ceil(f.chip.lineHeight) + 6)
    let footerH = max(chipH, ceil(f.date.lineHeight))

    let plh = previewLineH(f.preview)
    if let p = previewText(r, s, tc) {
      var maxLines = 3
      if s.grid {
        let cardH = NTMetrics.gridHeight - 2 * NTMetrics.cellPadV
        let reserved = (hasTags ? NTMetrics.rowGap + chipH : 0) + NTMetrics.rowGap + footerH + NTMetrics.padBottom
        maxLines = max(0, Int(floor((cardH - y - reserved) / plh)))
      }
      let h = textHeight(p, width: innerW, maxLines: maxLines, lineH: plh)
      L.preview = CGRect(x: x0, y: y, width: innerW, height: h)
      L.previewLines = maxLines
      y += h
    }

    if hasTags {
      y += NTMetrics.rowGap
      var tx = x0
      for w in tagW {
        if tx + w > x0 + innerW + 0.5 { break } // uma linha só (o resto fica de fora)
        L.tags.append(CGRect(x: tx, y: y, width: w, height: chipH))
        tx += w + 4
      }
      y += chipH
    }

    // Rodapé: lembrete · caderno · (espaço) · data
    y += NTMetrics.rowGap
    var cardH = y + footerH + NTMetrics.padBottom
    if s.grid { cardH = NTMetrics.gridHeight - 2 * NTMetrics.cellPadV }
    let fy = s.grid ? cardH - NTMetrics.padBottom - footerH : y
    var lx = x0
    var right = x0 + innerW
    if !r.date.isEmpty {
      let dw = min(ceil((r.date as NSString).size(withAttributes: [.font: f.date]).width) + 1, innerW * 0.5)
      L.date = CGRect(x: right - dw, y: fy + (footerH - ceil(f.date.lineHeight)) / 2, width: dw, height: ceil(f.date.lineHeight))
      right -= dw + 6
    }
    if let rt = reminderText(r, s, tc) {
      let rw = min(ceil(rt.size().width) + 16, max(0, right - lx))
      if rw > 24 {
        L.reminder = CGRect(x: lx, y: fy + (footerH - chipH) / 2, width: rw, height: chipH)
        lx += rw + 6
      }
    }
    if !r.notebook.isEmpty {
      let nw = min(ceil((r.notebook as NSString).size(withAttributes: [.font: f.chip]).width) + 16, max(0, right - lx))
      if nw > 24 {
        L.notebook = CGRect(x: lx, y: fy + (footerH - chipH) / 2, width: nw, height: chipH)
      }
    }
    L.card = CGRect(x: NTMetrics.cellPadH, y: NTMetrics.cellPadV, width: cardW, height: cardH)
    L.height = cardH + 2 * NTMetrics.cellPadV
    return L
  }

  // MARK: Configure

  func configure(_ r: NTRow, style s: NTStyle) {
    row = r
    style = s
    let tc = traitCollection
    let f = NTNoteCell.fonts(tc)
    card.backgroundColor = s.card
    card.layer.borderColor = s.cardBorder.cgColor
    strip.backgroundColor = r.color ?? UIColor(clHex: 0xFFF9C4)
    pinView.isHidden = !r.pinned
    if r.pinned {
      pinView.image = CLSymbols.image("pin.fill", pointSize: 13, weight: .semibold, color: s.colors.text)
    }
    let t = NTNoteCell.titleText(r, s, tc)
    titleLabel.attributedText = t
    titleLabel.isHidden = t == nil
    titleLabel.numberOfLines = r.title.isEmpty ? 1 : 2
    let p = NTNoteCell.previewText(r, s, tc)
    previewLabel.attributedText = p
    previewLabel.isHidden = p == nil
    for (i, l) in tagLabels.enumerated() {
      if i < r.tags.count {
        l.attributedText = NSAttributedString(string: "#" + r.tags[i], attributes: [.font: f.chip, .foregroundColor: s.colors.chipText])
        l.backgroundColor = s.colors.chipBg
      } else {
        l.attributedText = nil
      }
    }
    let rt = NTNoteCell.reminderText(r, s, tc)
    reminderLabel.attributedText = rt
    reminderLabel.layer.borderColor = (r.reminderOverdue ? s.colors.hair : s.colors.border).cgColor
    if r.notebook.isEmpty {
      notebookLabel.attributedText = nil
    } else {
      notebookLabel.attributedText = NSAttributedString(string: r.notebook, attributes: [.font: f.chip, .foregroundColor: s.colors.text])
      notebookLabel.backgroundColor = s.colors.chipBg
    }
    dateLabel.attributedText = r.date.isEmpty ? nil : NSAttributedString(string: r.date, attributes: [.font: f.date, .foregroundColor: s.colors.sub])

    var a11y = r.a11y
    if a11y.isEmpty {
      a11y = [r.title.isEmpty ? r.placeholder : r.title, r.preview, r.date].filter { !$0.isEmpty }.joined(separator: ", ")
    }
    accessibilityLabel = a11y
    applyBackground()
    setNeedsLayout()
  }

  private func applyBackground() {
    var b = UIBackgroundConfiguration.listPlainCell()
    b.backgroundColor = style.colors.bg
    backgroundConfiguration = b
    card.backgroundColor = pressed ? CTColor.blend(style.colors.press, over: style.card) : style.card
  }

  override func updateConfiguration(using state: UICellConfigurationState) {
    pressed = state.isHighlighted || state.isSelected
    applyBackground()
  }

  override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
    let attrs = super.preferredLayoutAttributesFitting(layoutAttributes)
    if style.grid {
      attrs.frame.size.height = NTMetrics.gridHeight
    } else {
      let w = layoutAttributes.size.width > 0 ? layoutAttributes.size.width : bounds.width
      attrs.frame.size.height = NTNoteCell.layout(row, width: w, style: style, traits: traitCollection).height
    }
    return attrs
  }

  override func traitCollectionDidChange(_ previous: UITraitCollection?) {
    super.traitCollectionDidChange(previous)
    if previous?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory {
      configure(row, style: style)
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let L = NTNoteCell.layout(row, width: contentView.bounds.width, style: style, traits: traitCollection)
    var cardFrame = L.card
    if style.grid { cardFrame.size.height = max(0, contentView.bounds.height - 2 * NTMetrics.cellPadV) }
    card.frame = cardFrame
    strip.frame = CGRect(x: 0, y: 0, width: NTMetrics.strip, height: cardFrame.height)
    pinView.bounds = CGRect(x: 0, y: 0, width: L.pin.width, height: L.pin.height)
    pinView.center = CGPoint(x: L.pin.midX, y: L.pin.midY)
    titleLabel.frame = L.title
    previewLabel.numberOfLines = max(1, L.previewLines)
    previewLabel.frame = L.preview
    previewLabel.isHidden = previewLabel.attributedText == nil || L.preview.height < 1
    for (i, l) in tagLabels.enumerated() {
      if i < L.tags.count && i < row.tags.count {
        l.isHidden = false
        l.frame = L.tags[i]
        l.layer.cornerRadius = L.tags[i].height / 2
      } else {
        l.isHidden = true
      }
    }
    reminderLabel.isHidden = L.reminder == .zero || reminderLabel.attributedText == nil
    reminderLabel.frame = L.reminder
    reminderLabel.layer.cornerRadius = L.reminder.height / 2
    notebookLabel.isHidden = L.notebook == .zero || notebookLabel.attributedText == nil
    notebookLabel.frame = L.notebook
    dateLabel.isHidden = L.date == .zero || dateLabel.attributedText == nil
    dateLabel.frame = L.date
  }
}
