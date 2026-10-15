import UIKit

// [2026-10-15 native-social] Célula única das COMUNIDADES (lista da aba e tela
// da comunidade). Layout por frames (alturas calculadas em CMMetrics.height),
// o que deixa o fluxo determinístico: a collection view usa flow layout com
// `sizeForItemAt` e nunca adivinha altura.
//
// Cartão segmentado: um cartão pode ocupar várias células (seg top/mid/bot).
// Cada célula desenha a MESMA forma arredondada estendida 40 pt para além das
// bordas que continuam (o contentView recorta) → borda contínua, cantos só
// nas pontas, sem decoração de seção.

final class CMCell: UICollectionViewCell {
  private let shape = CAShapeLayer()
  private let divider = UIView()

  // card / row
  private let avatarBox = UIView()
  private let avatarImage = UIImageView()
  private let initialLabel = UILabel()
  private let titleLabel = UILabel()
  private let subLabel = UILabel()
  private let chevron = UIImageView()
  private let tagLabel = CMTagLabel()
  private let rtagLabel = CMTagLabel()
  // group
  private let insetBox = UIView()
  private let dot = UIView()
  private let removeButton = UIButton(type: .system)
  // text
  private let bodyLabel = UILabel()
  // loading
  private let spinner = UIActivityIndicatorView(style: .medium)
  // actions
  private let pill1 = UIButton(type: .custom)
  private let pill2 = UIButton(type: .custom)

  private(set) var row = CMRow()
  private var palette = CMPalette(dark: false)
  private var loadedURL = ""
  var onAction: ((String, String) -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    contentView.backgroundColor = .clear
    contentView.clipsToBounds = true
    contentView.layer.addSublayer(shape)
    shape.lineWidth = 1 / max(1, UIScreen.main.scale)

    contentView.addSubview(divider)

    avatarBox.clipsToBounds = true
    avatarBox.layer.cornerRadius = 14
    if #available(iOS 13.0, *) { avatarBox.layer.cornerCurve = .continuous }
    avatarImage.contentMode = .scaleAspectFill
    avatarImage.clipsToBounds = true
    initialLabel.font = CMMetrics.initial
    initialLabel.textAlignment = .center
    avatarBox.addSubview(initialLabel)
    avatarBox.addSubview(avatarImage)
    contentView.addSubview(avatarBox)

    insetBox.layer.cornerRadius = 10
    if #available(iOS 13.0, *) { insetBox.layer.cornerCurve = .continuous }
    contentView.addSubview(insetBox)
    dot.layer.cornerRadius = 4
    contentView.addSubview(dot)

    titleLabel.numberOfLines = 1
    subLabel.numberOfLines = 2
    contentView.addSubview(titleLabel)
    contentView.addSubview(subLabel)

    chevron.contentMode = .center
    chevron.image = UIImage(systemName: "chevron.down",
                            withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold))?
      .withRenderingMode(.alwaysTemplate)
    contentView.addSubview(chevron)

    contentView.addSubview(tagLabel)
    contentView.addSubview(rtagLabel)

    removeButton.setImage(UIImage(systemName: "xmark",
                                  withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .bold)),
                          for: .normal)
    removeButton.addTarget(self, action: #selector(tapRemove), for: .touchUpInside)
    contentView.addSubview(removeButton)

    bodyLabel.numberOfLines = 0
    contentView.addSubview(bodyLabel)

    spinner.hidesWhenStopped = true
    contentView.addSubview(spinner)

    for (i, p) in [pill1, pill2].enumerated() {
      p.tag = i
      p.layer.cornerRadius = CMMetrics.pillH / 2
      p.titleLabel?.font = CMMetrics.pill
      p.adjustsImageWhenHighlighted = false
      p.contentEdgeInsets = UIEdgeInsets(top: 0, left: 14, bottom: 0, right: 14)
      p.titleEdgeInsets = UIEdgeInsets(top: 0, left: 6, bottom: 0, right: -6)
      p.addTarget(self, action: #selector(tapPill(_:)), for: .touchUpInside)
      p.addTarget(self, action: #selector(pillDown(_:)), for: [.touchDown, .touchDragEnter])
      p.addTarget(self, action: #selector(pillUp(_:)), for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
      contentView.addSubview(p)
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func prepareForReuse() {
    super.prepareForReuse()
    spinner.stopAnimating()
    for v in contentView.subviews { v.alpha = 1 }
  }

  override var isHighlighted: Bool {
    didSet {
      let on = isHighlighted && row.tap
      // Só o conteúdo esmaece (a forma do cartão é camada, não subview —
      // segmentos vizinhos continuam com a mesma cor).
      let views = contentView.subviews.filter { $0 !== divider }
      UIView.animate(withDuration: on ? 0.06 : 0.18) {
        for v in views { v.alpha = on ? 0.55 : 1 }
      }
    }
  }

  // MARK: - Configure

  func configure(_ r: CMRow, palette p: CMPalette) {
    let flipChevron = row.id == r.id && row.expanded != r.expanded && window != nil
    row = r
    palette = p
    let k = r.kind
    accessibilityLabel = r.a11y.isEmpty ? [r.title, r.sub].filter { !$0.isEmpty }.joined(separator: ", ") : r.a11y
    isAccessibilityElement = k != "actions"
    accessibilityTraits = r.tap ? .button : .staticText

    // Cartão
    if r.hasCard {
      let fill: UIColor
      switch r.cs {
      case "b": fill = p.box
      case "d": fill = .clear
      default: fill = p.card
      }
      shape.fillColor = fill.cgColor
      shape.strokeColor = (r.cs == "c" ? p.border : (r.cs == "d" ? p.ink : UIColor.clear)).cgColor
      shape.lineWidth = r.cs == "d" ? 1 : 1 / max(1, UIScreen.main.scale)
      shape.lineDashPattern = r.cs == "d" ? [5, 4] : nil
      shape.isHidden = false
    } else {
      shape.isHidden = true
    }
    divider.isHidden = !r.div
    divider.backgroundColor = p.divider

    let isCard = k == "card"
    let isGroup = k == "group"
    let isRow = k == "row"
    let isText = k == "text"
    avatarBox.isHidden = !isCard
    chevron.isHidden = !(isCard && r.chevron)
    insetBox.isHidden = !isGroup
    dot.isHidden = !isGroup
    removeButton.isHidden = !(isGroup && r.remove)
    titleLabel.isHidden = !(isCard || isGroup || isRow)
    subLabel.isHidden = !(isCard || isGroup || isRow) || r.sub.isEmpty
    tagLabel.isHidden = !(isRow && !r.tag.isEmpty)
    rtagLabel.isHidden = !(isRow && !r.rtag.isEmpty)
    bodyLabel.isHidden = !isText
    pill1.isHidden = !(k == "actions" && !r.b1.isEmpty)
    pill2.isHidden = !(k == "actions" && !r.b2.isEmpty)
    if k == "loading" {
      spinner.color = p.ink
      spinner.startAnimating()
    } else {
      spinner.stopAnimating()
    }

    if isCard {
      avatarBox.backgroundColor = p.iconBg
      initialLabel.text = r.initial
      initialLabel.textColor = p.text
      titleLabel.font = CMMetrics.cardTitle
      titleLabel.textColor = p.text
      titleLabel.textAlignment = .natural
      subLabel.font = CMMetrics.cardSub
      subLabel.textColor = p.sub
      subLabel.numberOfLines = 1
      chevron.tintColor = p.chevron
      let t: CGAffineTransform = r.expanded ? CGAffineTransform(rotationAngle: .pi) : .identity
      if flipChevron {
        UIView.animate(withDuration: 0.22, delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) {
          self.chevron.transform = t
        }
      } else {
        chevron.transform = t
      }
      loadImage(r.url, auth: r.auth)
    } else if isGroup {
      insetBox.backgroundColor = p.inset
      dot.backgroundColor = p.text
      titleLabel.font = CMMetrics.groupTitle
      titleLabel.textColor = p.text
      titleLabel.textAlignment = .natural
      subLabel.font = CMMetrics.groupSub
      subLabel.textColor = p.ter
      subLabel.numberOfLines = 1
      removeButton.tintColor = p.danger
      removeButton.accessibilityLabel = r.a11y
    } else if isRow {
      titleLabel.font = CMMetrics.rowTitle
      titleLabel.textColor = r.ink ? p.ink : p.text
      titleLabel.textAlignment = r.center ? .center : .natural
      subLabel.font = CMMetrics.rowSub
      subLabel.textColor = p.sub
      subLabel.numberOfLines = 2
      tagLabel.configure(r.tag, bg: SLColor.parse(r.tagBg) ?? p.ink, fg: SLColor.parse(r.tagFg) ?? p.bg)
      rtagLabel.configure(r.rtag, bg: SLColor.parse(r.rtagBg) ?? p.sub, fg: SLColor.parse(r.rtagFg) ?? .white)
    } else if isText {
      let color: UIColor
      switch r.ts {
      case "label", "desc", "title", "hint": color = p.sub
      case "empty": color = p.ter
      default: color = p.text
      }
      bodyLabel.attributedText = CMMetrics.attributed(r.body.isEmpty ? r.title : r.body, ts: r.ts, color: color)
    }
    if isCard || isGroup || isRow {
      titleLabel.text = r.title
      subLabel.text = r.sub
    }
    if k == "actions" {
      stylePill(pill1, title: r.b1, icon: r.b1i)
      stylePill(pill2, title: r.b2, icon: r.b2i)
    }
    setNeedsLayout()
  }

  private func stylePill(_ b: UIButton, title: String, icon: String) {
    b.backgroundColor = palette.pill
    b.setTitle(title, for: .normal)
    b.setTitleColor(palette.text, for: .normal)
    b.tintColor = palette.text
    b.accessibilityLabel = title
    let sym: String
    switch icon {
    case "plus": sym = "plus"
    case "bell", "megaphone": sym = "bell"
    default: sym = ""
    }
    b.setImage(sym.isEmpty ? nil : UIImage(systemName: sym, withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold)), for: .normal)
  }

  private func loadImage(_ url: String, auth: Bool) {
    if url == loadedURL, avatarImage.image != nil { avatarImage.isHidden = false; return }
    loadedURL = url
    avatarImage.image = nil
    avatarImage.isHidden = true
    initialLabel.isHidden = false
    if url.isEmpty { return }
    if let img = CLImageLoader.shared.cachedImage(url) {
      avatarImage.image = img
      avatarImage.isHidden = false
      initialLabel.isHidden = true
      return
    }
    CLImageLoader.shared.load(url, auth: auth) { [weak self] img in
      guard let self = self, self.loadedURL == url, let img = img else { return }
      self.avatarImage.image = img
      self.avatarImage.isHidden = false
      self.initialLabel.isHidden = true
    }
  }

  // MARK: - Layout

  override func layoutSubviews() {
    super.layoutSubviews()
    let r = row
    let W = contentView.bounds.width
    let H = contentView.bounds.height
    let cardX = r.hx
    let cardW = max(0, W - r.hx * 2)
    let top = r.topGap
    let bottom = H - r.bottomGap
    let contentBottom = bottom - r.pb

    CATransaction.begin()
    CATransaction.setDisableActions(true)
    shape.frame = contentView.bounds
    if r.hasCard {
      let ext: CGFloat = 40
      let y0 = (r.seg == "one" || r.seg == "top") ? top : -ext
      let y1 = (r.seg == "one" || r.seg == "bot") ? bottom : H + ext
      let radius: CGFloat = r.cs == "c" ? 14 : 8
      let inset = shape.lineWidth / 2
      let rect = CGRect(x: cardX + inset, y: y0 + inset, width: max(0, cardW - inset * 2), height: max(0, y1 - y0 - inset * 2))
      shape.path = UIBezierPath(roundedRect: rect, cornerRadius: radius).cgPath
    }
    CATransaction.commit()

    let px = 1 / max(1, UIScreen.main.scale)
    divider.frame = CGRect(x: cardX, y: top, width: cardW, height: px)

    switch r.kind {
    case "card":
      let a = CMMetrics.avatar
      avatarBox.frame = CGRect(x: cardX + 14, y: top + 14, width: a, height: a)
      avatarImage.frame = avatarBox.bounds
      initialLabel.frame = avatarBox.bounds
      let chevW: CGFloat = r.chevron ? 24 : 0
      // transform (girado quando aberto) → bounds/center, nunca frame.
      let chevRect = CGRect(x: cardX + cardW - 14 - chevW, y: top + (CMMetrics.cardContent - 24) / 2, width: chevW, height: 24)
      chevron.bounds = CGRect(x: 0, y: 0, width: chevW, height: 24)
      chevron.center = CGPoint(x: chevRect.midX, y: chevRect.midY)
      let tx = avatarBox.frame.maxX + 12
      let tw = max(0, chevRect.minX - 6 - tx)
      let th = CMMetrics.lineHeight(CMMetrics.cardTitle)
      let sh = CMMetrics.lineHeight(CMMetrics.cardSub)
      let total = th + 2 + sh
      let ty = top + (CMMetrics.cardContent - total) / 2
      titleLabel.frame = CGRect(x: tx, y: ty, width: tw, height: th)
      subLabel.frame = CGRect(x: tx, y: ty + th + 2, width: tw, height: sh)
    case "group":
      let bx = cardX + r.px
      let bw = max(0, cardW - r.px * 2)
      insetBox.frame = CGRect(x: bx, y: top, width: bw, height: CMMetrics.groupBox)
      dot.frame = CGRect(x: bx + 10, y: top + (CMMetrics.groupBox - 8) / 2, width: 8, height: 8)
      let rmW: CGFloat = r.remove ? 32 : 0
      removeButton.frame = CGRect(x: bx + bw - 4 - rmW, y: top + (CMMetrics.groupBox - 32) / 2, width: rmW, height: 32)
      let tx = dot.frame.maxX + 10
      let tw = max(0, (r.remove ? removeButton.frame.minX : bx + bw - 10) - tx)
      let th = CMMetrics.lineHeight(CMMetrics.groupTitle)
      let sh = CMMetrics.lineHeight(CMMetrics.groupSub)
      titleLabel.frame = CGRect(x: tx, y: top + 10, width: tw, height: th)
      subLabel.frame = CGRect(x: tx, y: top + 10 + th + 1, width: tw, height: sh)
    case "row":
      let pad = CMMetrics.rowPad
      var x = cardX + pad
      var right = cardX + cardW - pad
      let th = CMMetrics.lineHeight(CMMetrics.rowTitle)
      if !r.rtag.isEmpty {
        let w = CMMetrics.tagWidth(r.rtag)
        rtagLabel.frame = CGRect(x: right - w, y: top + (contentBottom - top - 20) / 2, width: w, height: 20)
        right = rtagLabel.frame.minX - 8
      }
      if !r.tag.isEmpty {
        let w = CMMetrics.tagWidth(r.tag)
        tagLabel.frame = CGRect(x: x, y: top + pad + (th - 20) / 2, width: w, height: 20)
        x = tagLabel.frame.maxX + 8
      }
      titleLabel.frame = CGRect(x: x, y: top + pad, width: max(0, right - x), height: th)
      if !r.sub.isEmpty {
        let sw = max(0, right - (cardX + pad))
        let sh = CMMetrics.boundedHeight(r.sub, font: CMMetrics.rowSub, width: CMMetrics.rowTextWidth(r, cardW: cardW), lines: 2)
        subLabel.frame = CGRect(x: cardX + pad, y: titleLabel.frame.maxY + 2, width: sw, height: sh)
      }
    case "text":
      let (_, _, t, _, _, _) = CMMetrics.textStyle(r.ts)
      let tw = max(0, cardW - r.px * 2)
      let h = CMMetrics.textHeight(r.body.isEmpty ? r.title : r.body, ts: r.ts, width: tw)
      bodyLabel.frame = CGRect(x: cardX + r.px, y: top + t, width: tw, height: h)
    case "loading":
      spinner.frame = CGRect(x: 0, y: top, width: W, height: CMMetrics.loadingH)
    case "actions":
      var x = cardX + r.px
      let y = top + CMMetrics.actionsTop
      for p in [pill1, pill2] where !p.isHidden {
        let s = p.sizeThatFits(CGSize(width: cardW, height: CMMetrics.pillH))
        let w = min(ceil(s.width) + 6, cardX + cardW - r.px - x)
        let f = CGRect(x: x, y: y, width: max(0, w), height: CMMetrics.pillH)
        p.bounds = CGRect(x: 0, y: 0, width: f.width, height: f.height)
        p.center = CGPoint(x: f.midX, y: f.midY)
        x = f.maxX + 8
      }
    default:
      break
    }
  }

  // MARK: - Ações

  @objc private func tapRemove() {
    UISelectionFeedbackGenerator().selectionChanged()
    onAction?(row.id, "remove")
  }

  @objc private func tapPill(_ b: UIButton) {
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    let key = b.tag == 0 ? row.b1k : row.b2k
    if !key.isEmpty { onAction?(row.id, key) }
  }

  @objc private func pillDown(_ b: UIButton) {
    UIView.animate(withDuration: 0.08) { b.transform = CGAffineTransform(scaleX: 0.96, y: 0.96) }
  }

  @objc private func pillUp(_ b: UIButton) {
    UIView.animate(withDuration: 0.18) { b.transform = .identity }
  }
}

/// Pílula de texto (tag "Avisos" / cargo).
final class CMTagLabel: UIView {
  private let label = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = true
    layer.cornerRadius = 10
    label.font = CMMetrics.tag
    label.textAlignment = .center
    addSubview(label)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ text: String, bg: UIColor, fg: UIColor) {
    label.text = text
    label.textColor = fg
    backgroundColor = bg
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    label.frame = bounds
    layer.cornerRadius = bounds.height / 2
  }
}
