import UIKit

// [2026-10-15 native-social] Células da aba CANAIS (iOS), layout manual:
//   CHChannelRowCell — canal seguido (avatar 50, nome + selo, prévia, hora,
//                      não lidos / seguidores, separador) — renderItem do
//                      FollowingList.
//   CHChannelCardCell — cartão 180 do Descobrir (fundo escuro + esmaecido,
//                      selo de membros, nome, descrição, meta, Inscrever).
//   CHPostCell       — post de canal em bolha (mídia, texto, hora/visualiz.,
//                      chips de reação, barra rápida).
// Altura: preferredLayoutAttributesFitting calcula pelo próprio layout.

protocol CHCellHost: AnyObject {
  func chAction(_ id: String, _ action: String, _ extra: [String: Any])
}

class CHBaseCell: UICollectionViewListCell {
  weak var host: CHCellHost?
  var rowId = ""

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundConfiguration = UIBackgroundConfiguration.clear()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func heightFor(width: CGFloat) -> CGFloat { return 44 }

  override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
    let attrs = layoutAttributes.copy() as! UICollectionViewLayoutAttributes
    let w = layoutAttributes.size.width > 0 ? layoutAttributes.size.width : (superview?.bounds.width ?? UIScreen.main.bounds.width)
    attrs.size = CGSize(width: w, height: ceil(heightFor(width: w)))
    return attrs
  }
}

// MARK: - Canal seguido

final class CHChannelRowCell: CHBaseCell {
  private let avatarBg = UIView()
  private let tileView = CLTileView()
  private let megaphone = UIImageView()
  private let nameLabel = UILabel()
  private let sealView = UIImageView()
  private let subLabel = UILabel()
  private let timeLabel = UILabel()
  private let metaLabel = UILabel()
  private let unreadPill = CLPaddedLabel()
  private let separator = UIView()
  private var row = CHRow()
  private var palette = CHPalette(dark: false)

  static let height: CGFloat = 78

  override init(frame: CGRect) {
    super.init(frame: frame)
    avatarBg.clipsToBounds = true
    avatarBg.layer.cornerRadius = 25
    contentView.addSubview(avatarBg)
    avatarBg.addSubview(tileView)
    megaphone.contentMode = .center
    avatarBg.addSubview(megaphone)
    nameLabel.font = UIFont.systemFont(ofSize: 16, weight: .semibold)
    nameLabel.lineBreakMode = .byTruncatingTail
    contentView.addSubview(nameLabel)
    sealView.contentMode = .scaleAspectFit
    contentView.addSubview(sealView)
    subLabel.font = UIFont.systemFont(ofSize: 13)
    subLabel.lineBreakMode = .byTruncatingTail
    contentView.addSubview(subLabel)
    timeLabel.font = UIFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
    timeLabel.textAlignment = .right
    contentView.addSubview(timeLabel)
    metaLabel.font = UIFont.systemFont(ofSize: 11)
    metaLabel.textAlignment = .right
    contentView.addSubview(metaLabel)
    unreadPill.font = UIFont.monospacedDigitSystemFont(ofSize: 11, weight: .bold)
    unreadPill.textAlignment = .center
    unreadPill.clipsToBounds = true
    unreadPill.layer.cornerRadius = 9
    contentView.addSubview(unreadPill)
    contentView.addSubview(separator)
    isAccessibilityElement = true
    accessibilityTraits = .button
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func heightFor(width: CGFloat) -> CGFloat { return CHChannelRowCell.height }

  func configure(_ r: CHRow, palette p: CHPalette) {
    row = r
    palette = p
    rowId = r.id
    avatarBg.backgroundColor = p.pill
    if r.tileURL.isEmpty {
      tileView.isHidden = true
      tileView.reset()
      megaphone.isHidden = false
      megaphone.image = CLSymbols.image("megaphone", pointSize: 20, color: p.text)
    } else {
      megaphone.isHidden = true
      tileView.isHidden = false
      tileView.configure(r.tile)
    }
    nameLabel.text = r.title
    nameLabel.textColor = p.text
    sealView.isHidden = !r.verified
    if r.verified {
      sealView.image = CLSymbols.image("checkmark.seal.fill", pointSize: 13, weight: .semibold, color: p.text)
    }
    subLabel.text = r.sub
    subLabel.textColor = p.sub
    timeLabel.text = r.time
    timeLabel.textColor = r.unread > 0 ? p.text : p.sub
    if r.unread > 0 {
      unreadPill.isHidden = false
      metaLabel.isHidden = true
      unreadPill.text = r.unread > 999 ? "999+" : "\(r.unread)"
      unreadPill.backgroundColor = p.ink
      unreadPill.textColor = p.inkText
    } else {
      unreadPill.isHidden = true
      metaLabel.isHidden = false
      metaLabel.text = r.meta
      metaLabel.textColor = p.sub
    }
    separator.backgroundColor = p.line
    accessibilityLabel = r.a11y.isEmpty ? r.title : r.a11y
    setNeedsLayout()
  }

  override func updateConfiguration(using state: UICellConfigurationState) {
    super.updateConfiguration(using: state)
    contentView.backgroundColor = (state.isHighlighted || state.isSelected) ? palette.press : .clear
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let w = contentView.bounds.width
    let h = CHChannelRowCell.height
    avatarBg.frame = CGRect(x: 16, y: (h - 50) / 2, width: 50, height: 50)
    tileView.frame = avatarBg.bounds
    megaphone.frame = avatarBg.bounds
    // coluna direita
    let rightW: CGFloat = 96
    timeLabel.frame = CGRect(x: w - 16 - rightW, y: 19, width: rightW, height: 14)
    if !unreadPill.isHidden {
      let tw = (unreadPill.text as NSString?)?.size(withAttributes: [.font: unreadPill.font as Any]).width ?? 10
      let pw = max(18, ceil(tw) + 10)
      unreadPill.frame = CGRect(x: w - 16 - pw, y: 40, width: pw, height: 18)
    }
    metaLabel.frame = CGRect(x: w - 16 - rightW, y: 41, width: rightW, height: 14)
    let timeW = min(rightW, ceil((timeLabel.text as NSString? ?? "").size(withAttributes: [.font: timeLabel.font as Any]).width))
    let metaW = metaLabel.isHidden ? 0 : min(rightW, ceil((metaLabel.text as NSString? ?? "").size(withAttributes: [.font: metaLabel.font as Any]).width))
    let pillW = unreadPill.isHidden ? 0 : unreadPill.frame.width
    let colW = max(timeW, metaW, pillW)
    let x0: CGFloat = 16 + 50 + 12
    let textRight = w - 16 - colW - 8
    let seal: CGFloat = sealView.isHidden ? 0 : 18
    let nameMax = max(0, textRight - x0 - seal)
    let nameW = min(nameMax, ceil((nameLabel.text as NSString? ?? "").size(withAttributes: [.font: nameLabel.font as Any]).width))
    nameLabel.frame = CGRect(x: x0, y: 17, width: nameW, height: 20)
    sealView.frame = CGRect(x: x0 + nameW + 4, y: 20, width: 14, height: 14)
    subLabel.frame = CGRect(x: x0, y: 40, width: max(0, textRight - x0), height: 18)
    let px = 1 / max(1, traitCollection.displayScale)
    separator.frame = CGRect(x: 16, y: h - px, width: w - 16, height: px)
  }
}

// MARK: - Cartão do Descobrir

final class CHChannelCardCell: CHBaseCell {
  let card = UIView()
  private let fade = CAGradientLayer()
  private let badge = UIView()
  private let badgeIcon = UIImageView()
  private let badgeLabel = UILabel()
  private let titleLabel = UILabel()
  private let descLabel = UILabel()
  private let metaLabel = UILabel()
  private let joinBtn = UIButton(type: .custom)
  private var row = CHRow()
  var labels = CLLabels()

  static let cardHeight: CGFloat = 180

  override init(frame: CGRect) {
    super.init(frame: frame)
    card.backgroundColor = UIColor(clHex: 0x111111)
    card.layer.cornerRadius = 18
    card.layer.cornerCurve = .continuous
    card.clipsToBounds = true
    contentView.addSubview(card)
    fade.colors = [UIColor(white: 0, alpha: 0.05).cgColor, UIColor(white: 0, alpha: 0.35).cgColor, UIColor(white: 0, alpha: 0.78).cgColor]
    fade.locations = [0, 0.55, 1]
    card.layer.addSublayer(fade)
    badge.backgroundColor = UIColor(white: 0, alpha: 0.45)
    badge.layer.cornerRadius = 12
    card.addSubview(badge)
    badgeIcon.image = CLSymbols.image("person.2", pointSize: 10, weight: .semibold, color: .white)
    badgeIcon.contentMode = .center
    badge.addSubview(badgeIcon)
    badgeLabel.font = UIFont.systemFont(ofSize: 11, weight: .bold)
    badgeLabel.textColor = .white
    badge.addSubview(badgeLabel)
    titleLabel.font = UIFont.systemFont(ofSize: 18, weight: .bold)
    titleLabel.textColor = .white
    titleLabel.layer.shadowColor = UIColor.black.cgColor
    titleLabel.layer.shadowOpacity = 0.5
    titleLabel.layer.shadowRadius = 3
    titleLabel.layer.shadowOffset = CGSize(width: 0, height: 1)
    card.addSubview(titleLabel)
    descLabel.font = UIFont.systemFont(ofSize: 13)
    descLabel.textColor = UIColor(white: 1, alpha: 0.85)
    descLabel.numberOfLines = 2
    card.addSubview(descLabel)
    metaLabel.font = UIFont.systemFont(ofSize: 11, weight: .semibold)
    metaLabel.textColor = UIColor(white: 1, alpha: 0.78)
    card.addSubview(metaLabel)
    joinBtn.titleLabel?.font = UIFont.systemFont(ofSize: 12, weight: .bold)
    joinBtn.setTitleColor(.white, for: .normal)
    joinBtn.layer.cornerRadius = 15
    joinBtn.layer.borderWidth = 1.5
    joinBtn.addTarget(self, action: #selector(tapJoin), for: .touchUpInside)
    card.addSubview(joinBtn)
    isAccessibilityElement = false
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func heightFor(width: CGFloat) -> CGFloat { return CHChannelCardCell.cardHeight + 12 }

  func configure(_ r: CHRow, palette p: CHPalette, labels l: CLLabels) {
    row = r
    rowId = r.id
    labels = l
    badgeLabel.text = r.badge
    titleLabel.text = r.title
    descLabel.text = r.desc
    descLabel.isHidden = r.desc.isEmpty
    metaLabel.text = r.meta
    let title = r.member ? l.get("joined", "Inscrito") : l.get("join", "Inscrever")
    joinBtn.setTitle(title, for: .normal)
    if r.member {
      joinBtn.backgroundColor = .clear
      joinBtn.layer.borderColor = UIColor(white: 1, alpha: 0.7).cgColor
    } else {
      joinBtn.backgroundColor = UIColor(clHex: 0x111111)
      joinBtn.layer.borderColor = UIColor(clHex: 0x111111).cgColor
    }
    joinBtn.accessibilityLabel = title
    card.isAccessibilityElement = true
    card.accessibilityLabel = r.a11y.isEmpty ? r.title : r.a11y
    card.accessibilityTraits = .button
    accessibilityElements = [card, joinBtn]
    setNeedsLayout()
  }

  @objc private func tapJoin() {
    UISelectionFeedbackGenerator().selectionChanged()
    host?.chAction(rowId, "follow", [:])
  }

  override func updateConfiguration(using state: UICellConfigurationState) {
    super.updateConfiguration(using: state)
    let down = state.isHighlighted
    UIView.animate(withDuration: down ? 0.08 : 0.2) {
      self.card.transform = down ? CGAffineTransform(scaleX: 0.98, y: 0.98) : .identity
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let w = contentView.bounds.width
    let cw = w - 24
    card.bounds = CGRect(x: 0, y: 0, width: cw, height: CHChannelCardCell.cardHeight)
    card.center = CGPoint(x: 12 + cw / 2, y: CHChannelCardCell.cardHeight / 2)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    fade.frame = card.bounds
    CATransaction.commit()
    let bw = ceil((badgeLabel.text as NSString? ?? "").size(withAttributes: [.font: badgeLabel.font as Any]).width)
    let badgeW = 9 + 11 + 4 + bw + 9
    badge.frame = CGRect(x: cw - 12 - badgeW, y: 12, width: badgeW, height: 24)
    badgeIcon.frame = CGRect(x: 9, y: 0, width: 11, height: 24)
    badgeLabel.frame = CGRect(x: 24, y: 0, width: bw, height: 24)
    // conteúdo (de baixo p/ cima)
    let jw = ceil((joinBtn.title(for: .normal) as NSString? ?? "").size(withAttributes: [.font: joinBtn.titleLabel?.font as Any]).width) + 28
    let bottomY = CHChannelCardCell.cardHeight - 12
    joinBtn.frame = CGRect(x: cw - 14 - jw, y: bottomY - 30, width: jw, height: 30)
    metaLabel.frame = CGRect(x: 14, y: bottomY - 30, width: max(0, cw - 28 - jw - 8), height: 30)
    var y = bottomY - 30 - 6
    if !descLabel.isHidden {
      let dh = min(34, ceil(descLabel.sizeThatFits(CGSize(width: cw - 28, height: 40)).height))
      descLabel.frame = CGRect(x: 14, y: y - dh, width: cw - 28, height: dh)
      y -= dh + 4
    }
    titleLabel.frame = CGRect(x: 14, y: y - 22, width: cw - 28, height: 22)
  }
}

// MARK: - Post de canal

struct CHPostLayout {
  var bubble = CGRect.zero
  var media = CGRect.zero
  var text = CGRect.zero
  var footer = CGRect.zero
  var chips: [CGRect] = []
  var quick: [CGRect] = []
  var height: CGFloat = 0
}

final class CHPostCell: CHBaseCell {
  let bubble = UIView()
  private let mediaView = UIImageView()
  private let playBadge = UIImageView()
  private let textLabel2 = UILabel()
  private let footerLabel = UILabel()
  private var chipButtons: [UIButton] = []
  private var quickButtons: [UIButton] = []
  private var row = CHRow()
  private var palette = CHPalette(dark: false)
  private var quickSet: [String] = []
  private var mediaURL = ""
  private var lastLayout = CHPostLayout()
  private var lastLayoutWidth: CGFloat = -1

  static let textFont = UIFont.systemFont(ofSize: 15)
  static let footerFont = UIFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
  static let chipEmojiFont = UIFont.systemFont(ofSize: 14)
  static let chipCountFont = UIFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
  static let quickFont = UIFont.systemFont(ofSize: 18)

  override init(frame: CGRect) {
    super.init(frame: frame)
    bubble.layer.cornerRadius = 16
    bubble.layer.cornerCurve = .continuous
    contentView.addSubview(bubble)
    mediaView.contentMode = .scaleAspectFill
    mediaView.clipsToBounds = true
    mediaView.layer.cornerRadius = 12
    mediaView.layer.cornerCurve = .continuous
    mediaView.isUserInteractionEnabled = true
    mediaView.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapMedia)))
    bubble.addSubview(mediaView)
    playBadge.image = CLSymbols.image("play.fill", pointSize: 20, weight: .semibold, color: .white)
    playBadge.contentMode = .center
    playBadge.backgroundColor = UIColor(white: 0, alpha: 0.55)
    playBadge.layer.cornerRadius = 26
    playBadge.clipsToBounds = true
    mediaView.addSubview(playBadge)
    textLabel2.numberOfLines = 0
    bubble.addSubview(textLabel2)
    footerLabel.font = CHPostCell.footerFont
    footerLabel.textAlignment = .right
    bubble.addSubview(footerLabel)
    let lp = UILongPressGestureRecognizer(target: self, action: #selector(longPress(_:)))
    lp.minimumPressDuration = 0.4
    bubble.addGestureRecognizer(lp)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func prepareForReuse() {
    super.prepareForReuse()
    lastLayoutWidth = -1
  }

  // MARK: layout puro (também usado p/ altura)

  static func attributedText(_ s: String, color: UIColor) -> NSAttributedString {
    let ps = NSMutableParagraphStyle()
    ps.minimumLineHeight = 22
    ps.maximumLineHeight = 22
    ps.lineBreakMode = .byWordWrapping
    return NSAttributedString(string: s, attributes: [
      .font: textFont, .paragraphStyle: ps, .foregroundColor: color,
    ])
  }

  static func chipSize(_ r: CHReaction) -> CGSize {
    let ew = ceil((r.emoji as NSString).size(withAttributes: [.font: chipEmojiFont]).width)
    let cw = ceil(("\(r.count)" as NSString).size(withAttributes: [.font: chipCountFont]).width)
    return CGSize(width: 8 + ew + 4 + cw + 8, height: 28)
  }

  static func layout(_ r: CHRow, quick: [String], width: CGFloat) -> CHPostLayout {
    var L = CHPostLayout()
    let bx: CGFloat = 12
    let bw = max(60, width - 24)
    let pad: CGFloat = 12
    let inner = bw - pad * 2
    var y: CGFloat = 0
    if !r.mediaURL.isEmpty && (r.mediaKind == "image" || r.mediaKind == "video") {
      let mw = bw - 8
      L.media = CGRect(x: 4, y: 4, width: mw, height: floor(mw * 3 / 4))
      y = L.media.maxY + 8
    } else {
      y = pad - 2
    }
    if !r.text.isEmpty {
      let s = attributedText(r.text, color: .black)
      let h = ceil(s.boundingRect(with: CGSize(width: inner, height: .greatestFiniteMagnitude),
                                  options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).height)
      L.text = CGRect(x: pad, y: y, width: inner, height: max(22, h))
      y = L.text.maxY + 4
    }
    L.footer = CGRect(x: pad, y: y, width: inner, height: 14)
    y = L.footer.maxY
    if !r.reactions.isEmpty {
      y += 8
      var x = pad
      var rowY = y
      for rx in r.reactions {
        let s = chipSize(rx)
        if x > pad && x + s.width > pad + inner {
          x = pad
          rowY += s.height + 6
        }
        L.chips.append(CGRect(x: x, y: rowY, width: s.width, height: s.height))
        x += s.width + 6
      }
      y = rowY + 28
    }
    if r.quick && !quick.isEmpty {
      y += 6
      var x = pad - 4
      for _ in quick {
        L.quick.append(CGRect(x: x, y: y, width: 34, height: 34))
        x += 34 + 4
        if x + 34 > pad + inner + 4 { break }
      }
      y += 34
    }
    y += 10
    L.bubble = CGRect(x: bx, y: 6, width: bw, height: y)
    L.height = y + 12
    return L
  }

  override func heightFor(width: CGFloat) -> CGFloat {
    return CHPostCell.layout(row, quick: quickSet, width: width).height
  }

  // MARK: configure

  func configure(_ r: CHRow, palette p: CHPalette, quick: [String]) {
    row = r
    rowId = r.id
    palette = p
    quickSet = quick
    lastLayoutWidth = -1
    bubble.backgroundColor = p.card
    if !p.dark {
      bubble.layer.borderWidth = 1 / max(1, UIScreen.main.scale)
      bubble.layer.borderColor = UIColor(white: 0, alpha: 0.08).cgColor
    } else {
      bubble.layer.borderWidth = 0
    }
    let hasMedia = !r.mediaURL.isEmpty && (r.mediaKind == "image" || r.mediaKind == "video")
    mediaView.isHidden = !hasMedia
    playBadge.isHidden = r.mediaKind != "video"
    if hasMedia {
      mediaView.backgroundColor = r.mediaKind == "video" ? .black : p.pill
      if r.mediaKind == "image" {
        loadImage(r.mediaURL)
      } else {
        mediaURL = ""
        mediaView.image = nil
      }
    } else {
      mediaURL = ""
      mediaView.image = nil
    }
    textLabel2.isHidden = r.text.isEmpty
    textLabel2.attributedText = r.text.isEmpty ? nil : CHPostCell.attributedText(r.text, color: p.text)
    let foot = r.time
    if !r.views.isEmpty {
      let att = NSMutableAttributedString()
      if let eye = CLSymbols.image("eye", pointSize: 10, color: p.sub) {
        let a = NSTextAttachment()
        a.image = eye
        a.bounds = CGRect(x: 0, y: -1, width: eye.size.width, height: eye.size.height)
        att.append(NSAttributedString(attachment: a))
      }
      att.append(NSAttributedString(string: " \(r.views)   \(foot)", attributes: [.font: CHPostCell.footerFont, .foregroundColor: p.sub]))
      footerLabel.attributedText = att
    } else {
      footerLabel.attributedText = nil
      footerLabel.text = foot
      footerLabel.textColor = p.sub
    }
    // chips
    while chipButtons.count < r.reactions.count {
      let b = UIButton(type: .custom)
      b.layer.cornerRadius = 12
      b.layer.borderWidth = 1
      b.addTarget(self, action: #selector(tapChip(_:)), for: .touchUpInside)
      bubble.addSubview(b)
      chipButtons.append(b)
    }
    for (i, b) in chipButtons.enumerated() {
      guard i < r.reactions.count else { b.isHidden = true; continue }
      let rx = r.reactions[i]
      b.isHidden = false
      let mine = rx.emoji == r.mine
      let t = NSMutableAttributedString(string: rx.emoji, attributes: [.font: CHPostCell.chipEmojiFont])
      t.append(NSAttributedString(string: " \(rx.count)", attributes: [.font: CHPostCell.chipCountFont, .foregroundColor: p.sub]))
      b.setAttributedTitle(t, for: .normal)
      b.backgroundColor = mine ? (p.dark ? UIColor(white: 1, alpha: 0.14) : UIColor(white: 0.067, alpha: 0.08)) : p.pill
      b.layer.borderColor = (mine ? p.text : UIColor.clear).cgColor
      b.accessibilityLabel = "\(rx.emoji) \(rx.count)"
      b.accessibilityTraits = mine ? [.button, .selected] : .button
      b.tag = i
    }
    // barra rápida
    let showQuick = r.quick && !quick.isEmpty
    while quickButtons.count < quick.count {
      let b = UIButton(type: .custom)
      b.titleLabel?.font = CHPostCell.quickFont
      b.addTarget(self, action: #selector(tapQuick(_:)), for: .touchUpInside)
      bubble.addSubview(b)
      quickButtons.append(b)
    }
    for (i, b) in quickButtons.enumerated() {
      guard showQuick, i < quick.count else { b.isHidden = true; continue }
      b.isHidden = false
      b.setTitle(quick[i], for: .normal)
      b.alpha = quick[i] == r.mine ? 1 : 0.5
      b.tag = i
      b.accessibilityLabel = quick[i]
    }
    setNeedsLayout()
  }

  private func loadImage(_ url: String) {
    let px = max(320, UIScreen.main.bounds.width * UIScreen.main.scale)
    if url == mediaURL, mediaView.image != nil { return }
    mediaURL = url
    if let img = CLImageLoader.shared.cachedImage(url, maxPixel: px) {
      mediaView.image = img
      return
    }
    mediaView.image = nil
    CLImageLoader.shared.load(url, auth: false, maxPixel: px) { [weak self] img in
      guard let self = self, self.mediaURL == url else { return }
      self.mediaView.image = img
      if img != nil && self.window != nil {
        self.mediaView.alpha = 0
        UIView.animate(withDuration: 0.18) { self.mediaView.alpha = 1 }
      }
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let w = contentView.bounds.width
    if w != lastLayoutWidth {
      lastLayout = CHPostCell.layout(row, quick: quickSet, width: w)
      lastLayoutWidth = w
    }
    let L = lastLayout
    bubble.frame = L.bubble
    mediaView.frame = L.media
    playBadge.frame = CGRect(x: (L.media.width - 52) / 2, y: (L.media.height - 52) / 2, width: 52, height: 52)
    textLabel2.frame = L.text
    footerLabel.frame = L.footer
    for (i, b) in chipButtons.enumerated() where i < L.chips.count { b.frame = L.chips[i] }
    for (i, b) in quickButtons.enumerated() where i < L.quick.count { b.frame = L.quick[i] }
  }

  // MARK: ações

  @objc private func tapChip(_ b: UIButton) {
    guard b.tag < row.reactions.count else { return }
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    pop(b)
    host?.chAction(rowId, "react", ["emoji": row.reactions[b.tag].emoji])
  }

  @objc private func tapQuick(_ b: UIButton) {
    guard b.tag < quickSet.count else { return }
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    pop(b)
    host?.chAction(rowId, "react", ["emoji": quickSet[b.tag]])
  }

  @objc private func tapMedia() {
    host?.chAction(rowId, "media", [:])
  }

  @objc private func longPress(_ g: UILongPressGestureRecognizer) {
    guard g.state == .began else { return }
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    host?.chAction(rowId, "longpress", [:])
  }

  private func pop(_ v: UIView) {
    v.transform = CGAffineTransform(scaleX: 0.85, y: 0.85)
    UIView.animate(withDuration: 0.35, delay: 0, usingSpringWithDamping: 0.45, initialSpringVelocity: 0.8, options: [.allowUserInteraction]) {
      v.transform = .identity
    }
  }
}
