import AVFoundation
import UIKit

// [2026-10-15 native-feed] Cartão de um post do FEED (iOS). Layout por frames
// (sem Auto Layout): FDPostCell.metrics() calcula tudo uma vez e serve tanto
// para a altura (self-sizing da collection) quanto para o layoutSubviews.
//   cabeçalho (avatar, nome, Patrocinado, local, hora, menu "...")
//   rótulo dueto/stitch · barra de som
//   mídia quadrada: foto (cache RFImageLoader) / carrossel paginado com
//     contador + pontos / vídeo (AVPlayer emprestado do pool dos Reels)
//   cartão do repost · ações (curtir, comentar, compartilhar, presente, salvar)
//   curtidas · legenda com #tag/@menção tocáveis e "mais"/"menos" · tradução
//   marcados · "Ver todos os N comentários" · data

protocol FDPostCellDelegate: AnyObject {
  func fdCell(_ cell: FDPostCell, action: String, value: String)
  func fdCellDoubleTap(_ cell: FDPostCell, at point: CGPoint)
  func fdCellSingleTapMedia(_ cell: FDPostCell)
  func fdCellPageChanged(_ cell: FDPostCell, page: Int)
  func fdCellToggleExpand(_ cell: FDPostCell)
}

struct FDMetrics {
  var height: CGFloat = 0
  var header = CGRect.zero
  var derivative = CGRect.zero
  var sound = CGRect.zero
  var media = CGRect.zero
  var repost = CGRect.zero
  var actions = CGRect.zero
  var likes = CGRect.zero
  var caption = CGRect.zero
  var captionMore = CGRect.zero
  var translation = CGRect.zero
  var translationToggle = CGRect.zero
  var tags = CGRect.zero
  var comments = CGRect.zero
  var date = CGRect.zero
  var truncated = false
}

final class FDLinkLabel: UILabel {
  static let linkKey = NSAttributedString.Key("chatyyFeedLink")

  /// Valor do atributo de link sob o ponto (coordenadas do rótulo), se houver.
  func link(at p: CGPoint) -> String? {
    guard let attr = attributedText, attr.length > 0, bounds.contains(p) else { return nil }
    let storage = NSTextStorage(attributedString: attr)
    let lm = NSLayoutManager()
    let tc = NSTextContainer(size: bounds.size)
    tc.lineFragmentPadding = 0
    tc.maximumNumberOfLines = numberOfLines
    tc.lineBreakMode = lineBreakMode
    lm.addTextContainer(tc)
    storage.addLayoutManager(lm)
    lm.ensureLayout(for: tc)
    let used = lm.usedRect(for: tc)
    if !used.insetBy(dx: -4, dy: -4).contains(p) { return nil }
    var frac: CGFloat = 0
    let idx = lm.characterIndex(for: p, in: tc, fractionOfDistanceBetweenInsertionPoints: &frac)
    guard idx < attr.length else { return nil }
    return attr.attribute(FDLinkLabel.linkKey, at: idx, effectiveRange: nil) as? String
  }
}

/// Página do carrossel: foto ou vídeo (capa + camada do player).
final class FDMediaPage: UIView {
  let imageView = UIImageView()
  let playerView = RFPlayerView()
  let playGlyph = UIImageView()
  var url = ""
  var isVideo = false
  private(set) var attached = false
  private var readyObs: NSKeyValueObservation?

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = true
    backgroundColor = UIColor(white: 0.07, alpha: 1)
    imageView.contentMode = .scaleAspectFill
    imageView.clipsToBounds = true
    addSubview(imageView)
    playerView.playerLayer.videoGravity = .resizeAspectFill
    playerView.isUserInteractionEnabled = false
    playerView.alpha = 0
    addSubview(playerView)
    playGlyph.image = UIImage(systemName: "play.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 30, weight: .bold))
    playGlyph.tintColor = .white
    playGlyph.contentMode = .center
    playGlyph.layer.shadowColor = UIColor.black.cgColor
    playGlyph.layer.shadowOpacity = 0.35
    playGlyph.layer.shadowRadius = 6
    playGlyph.layer.shadowOffset = .zero
    playGlyph.isHidden = true
    addSubview(playGlyph)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    imageView.frame = bounds
    playerView.frame = bounds
    playGlyph.frame = CGRect(x: (bounds.width - 64) / 2, y: (bounds.height - 64) / 2, width: 64, height: 64)
  }

  func attach(_ player: AVPlayer?) {
    readyObs?.invalidate()
    readyObs = nil
    if playerView.playerLayer.player !== player { playerView.playerLayer.player = player }
    attached = player != nil
    guard player != nil else {
      playerView.alpha = 0
      return
    }
    if playerView.playerLayer.isReadyForDisplay {
      showVideo()
    } else {
      playerView.alpha = 0
      readyObs = playerView.playerLayer.observe(\.isReadyForDisplay, options: [.new]) { [weak self] layer, _ in
        DispatchQueue.main.async {
          guard let self = self, layer.isReadyForDisplay, self.playerView.playerLayer === layer, self.attached else { return }
          self.showVideo()
        }
      }
    }
  }

  private func showVideo() {
    playGlyph.isHidden = true
    UIView.animate(withDuration: 0.18) { self.playerView.alpha = 1 }
  }

  func setFailed(_ failed: Bool) {
    playGlyph.isHidden = !(isVideo && (failed || !attached))
  }
}

final class FDPostCell: UICollectionViewCell, UIScrollViewDelegate {
  weak var delegate: FDPostCellDelegate?
  private(set) var row: FDRow?
  private(set) var page = 0
  private(set) var expanded = false
  private var labels = FDLabels()
  private var palette = FDPalette(dark: false)
  private var metrics = FDMetrics()
  private var avatarURL = ""
  private var repostURL = ""

  // Cabeçalho
  private let avatar = UIImageView()
  private let initials = UILabel()
  private let nameLabel = UILabel()
  private let sponsoredLabel = UILabel()
  private let locationButton = UIButton(type: .system)
  private let timeLabel = UILabel()
  private let moreButton = UIButton(type: .system)
  private let headerTap = UIControl()
  // Extras
  private let derivativeLabel = UILabel()
  private let soundLabel = UILabel()
  // Mídia
  private let mediaBox = UIView()
  let pager = UIScrollView()
  private(set) var pages: [FDMediaPage] = []
  private let counterLabel = UILabel()
  private let dotsView = UIStackView()
  private let muteBadge = UIImageView()
  // Repost
  private let repostCard = UIControl()
  private let repostThumb = UIImageView()
  private let repostAuthor = UILabel()
  private let repostCaption = UILabel()
  // Ações
  private let likeButton = UIButton(type: .custom)
  private let commentButton = UIButton(type: .custom)
  private let shareButton = UIButton(type: .custom)
  private let giftButton = UIButton(type: .custom)
  private let saveButton = UIButton(type: .custom)
  private let likesButton = UIButton(type: .custom)
  // Texto
  private let captionLabel = FDLinkLabel()
  private let captionMoreButton = UIButton(type: .custom)
  private let translationLabel = UILabel()
  private let translationToggle = UIButton(type: .custom)
  private let tagsStack = UIStackView()
  private let commentsButton = UIButton(type: .custom)
  private let dateLabel = UILabel()
  private let separator = UIView()

  static let pad: CGFloat = 14
  static let captionFont = UIFont.systemFont(ofSize: 14)
  static let captionBold = UIFont.systemFont(ofSize: 14, weight: .semibold)
  private static let tokenRegex = try? NSRegularExpression(pattern: "(^|\\s)([#@][A-Za-z0-9_.\\u00C0-\\u017F]{1,30})\\b", options: [])

  override init(frame: CGRect) {
    super.init(frame: frame)
    build()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  // MARK: - Construção

  private func build() {
    let cv = contentView
    cv.clipsToBounds = true

    avatar.contentMode = .scaleAspectFill
    avatar.clipsToBounds = true
    avatar.layer.cornerRadius = 17
    initials.textAlignment = .center
    initials.font = .systemFont(ofSize: 13, weight: .semibold)
    avatar.addSubview(initials)
    nameLabel.font = .systemFont(ofSize: 14, weight: .semibold)
    sponsoredLabel.font = .systemFont(ofSize: 10, weight: .bold)
    sponsoredLabel.textAlignment = .center
    sponsoredLabel.layer.cornerRadius = 4
    sponsoredLabel.clipsToBounds = true
    locationButton.titleLabel?.font = .systemFont(ofSize: 11)
    locationButton.contentHorizontalAlignment = .left
    locationButton.addTarget(self, action: #selector(tapLocation), for: .touchUpInside)
    timeLabel.font = .systemFont(ofSize: 12)
    timeLabel.textAlignment = .right
    moreButton.setImage(UIImage(systemName: "ellipsis", withConfiguration: UIImage.SymbolConfiguration(pointSize: 16, weight: .semibold)), for: .normal)
    moreButton.showsMenuAsPrimaryAction = true
    headerTap.addTarget(self, action: #selector(tapAuthor), for: .touchUpInside)
    for v in [headerTap, avatar, nameLabel, sponsoredLabel, locationButton, timeLabel, moreButton] as [UIView] { cv.addSubview(v) }
    avatar.isUserInteractionEnabled = false
    nameLabel.isUserInteractionEnabled = false

    derivativeLabel.font = .systemFont(ofSize: 12, weight: .semibold)
    derivativeLabel.layer.cornerRadius = 6
    derivativeLabel.clipsToBounds = true
    soundLabel.font = .systemFont(ofSize: 12)
    soundLabel.layer.cornerRadius = 6
    soundLabel.clipsToBounds = true
    cv.addSubview(derivativeLabel)
    cv.addSubview(soundLabel)

    mediaBox.backgroundColor = .black
    mediaBox.clipsToBounds = true
    pager.isPagingEnabled = true
    pager.showsHorizontalScrollIndicator = false
    pager.alwaysBounceHorizontal = false
    pager.scrollsToTop = false
    pager.delegate = self
    pager.decelerationRate = .fast
    mediaBox.addSubview(pager)
    counterLabel.font = .systemFont(ofSize: 12, weight: .semibold)
    counterLabel.textColor = .white
    counterLabel.textAlignment = .center
    counterLabel.backgroundColor = UIColor(white: 0, alpha: 0.55)
    counterLabel.layer.cornerRadius = 12
    counterLabel.clipsToBounds = true
    mediaBox.addSubview(counterLabel)
    dotsView.axis = .horizontal
    dotsView.spacing = 5
    dotsView.alignment = .center
    dotsView.isUserInteractionEnabled = false
    mediaBox.addSubview(dotsView)
    muteBadge.contentMode = .center
    muteBadge.tintColor = .white
    muteBadge.backgroundColor = UIColor(white: 0, alpha: 0.55)
    muteBadge.layer.cornerRadius = 14
    muteBadge.isHidden = true
    mediaBox.addSubview(muteBadge)
    let dbl = UITapGestureRecognizer(target: self, action: #selector(mediaDoubleTap(_:)))
    dbl.numberOfTapsRequired = 2
    let single = UITapGestureRecognizer(target: self, action: #selector(mediaSingleTap(_:)))
    single.require(toFail: dbl)
    mediaBox.addGestureRecognizer(dbl)
    mediaBox.addGestureRecognizer(single)
    cv.addSubview(mediaBox)

    repostCard.layer.cornerRadius = 12
    repostCard.layer.borderWidth = 1
    repostCard.addTarget(self, action: #selector(tapRepost), for: .touchUpInside)
    repostThumb.contentMode = .scaleAspectFill
    repostThumb.clipsToBounds = true
    repostThumb.layer.cornerRadius = 8
    repostThumb.isUserInteractionEnabled = false
    repostAuthor.font = .systemFont(ofSize: 13, weight: .semibold)
    repostAuthor.isUserInteractionEnabled = false
    repostCaption.font = .systemFont(ofSize: 12)
    repostCaption.numberOfLines = 2
    repostCaption.isUserInteractionEnabled = false
    repostCard.addSubview(repostThumb)
    repostCard.addSubview(repostAuthor)
    repostCard.addSubview(repostCaption)
    cv.addSubview(repostCard)

    for b in [likeButton, commentButton, shareButton, giftButton, saveButton] {
      b.adjustsImageWhenHighlighted = false
      cv.addSubview(b)
    }
    likeButton.addTarget(self, action: #selector(tapLike), for: .touchUpInside)
    commentButton.addTarget(self, action: #selector(tapComment), for: .touchUpInside)
    shareButton.addTarget(self, action: #selector(tapShare), for: .touchUpInside)
    giftButton.addTarget(self, action: #selector(tapGift), for: .touchUpInside)
    saveButton.addTarget(self, action: #selector(tapSave), for: .touchUpInside)
    let saveLong = UILongPressGestureRecognizer(target: self, action: #selector(longSave(_:)))
    saveLong.minimumPressDuration = 0.35
    saveButton.addGestureRecognizer(saveLong)
    likesButton.titleLabel?.font = .systemFont(ofSize: 14, weight: .semibold)
    likesButton.contentHorizontalAlignment = .left
    likesButton.addTarget(self, action: #selector(tapLikers), for: .touchUpInside)
    cv.addSubview(likesButton)

    captionLabel.numberOfLines = 2
    captionLabel.lineBreakMode = .byTruncatingTail
    captionLabel.isUserInteractionEnabled = true
    captionLabel.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapCaption(_:))))
    let capLong = UILongPressGestureRecognizer(target: self, action: #selector(longCaption(_:)))
    capLong.minimumPressDuration = 0.35
    captionLabel.addGestureRecognizer(capLong)
    cv.addSubview(captionLabel)
    captionMoreButton.titleLabel?.font = .systemFont(ofSize: 13, weight: .medium)
    captionMoreButton.contentHorizontalAlignment = .left
    captionMoreButton.addTarget(self, action: #selector(tapExpand), for: .touchUpInside)
    cv.addSubview(captionMoreButton)
    translationLabel.font = FDPostCell.captionFont
    translationLabel.numberOfLines = 0
    cv.addSubview(translationLabel)
    translationToggle.titleLabel?.font = .systemFont(ofSize: 13, weight: .medium)
    translationToggle.contentHorizontalAlignment = .left
    translationToggle.addTarget(self, action: #selector(tapTranslateToggle), for: .touchUpInside)
    cv.addSubview(translationToggle)

    tagsStack.axis = .horizontal
    tagsStack.spacing = 6
    tagsStack.alignment = .center
    cv.addSubview(tagsStack)
    commentsButton.titleLabel?.font = .systemFont(ofSize: 13)
    commentsButton.contentHorizontalAlignment = .left
    commentsButton.addTarget(self, action: #selector(tapComment), for: .touchUpInside)
    cv.addSubview(commentsButton)
    dateLabel.font = .systemFont(ofSize: 11)
    cv.addSubview(dateLabel)
    cv.addSubview(separator)
  }

  // MARK: - Medidas

  static func captionText(_ row: FDRow, palette: FDPalette) -> NSAttributedString {
    let s = NSMutableAttributedString()
    let author = row.authorName.isEmpty ? (row.authorEmail.components(separatedBy: "@").first ?? "?") : row.authorName
    s.append(NSAttributedString(string: author, attributes: [
      .font: captionBold, .foregroundColor: palette.text, FDLinkLabel.linkKey: "author:",
    ]))
    s.append(NSAttributedString(string: "  ", attributes: [.font: captionFont, .foregroundColor: palette.text]))
    let body = NSMutableAttributedString(string: row.caption, attributes: [.font: captionFont, .foregroundColor: palette.text])
    if let re = tokenRegex {
      let ns = row.caption as NSString
      for m in re.matches(in: row.caption, options: [], range: NSRange(location: 0, length: ns.length)) {
        let r = m.range(at: 2)
        if r.location == NSNotFound || r.length < 2 { continue }
        let tok = ns.substring(with: r)
        let kind = tok.hasPrefix("#") ? "tag:" : "mention:"
        body.addAttributes([.font: captionBold, FDLinkLabel.linkKey: kind + String(tok.dropFirst())], range: r)
      }
    }
    s.append(body)
    return s
  }

  private static func textHeight(_ a: NSAttributedString, width: CGFloat) -> CGFloat {
    let r = a.boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude),
                           options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
    return ceil(r.height)
  }

  private static func textHeight(_ s: String, font: UIFont, width: CGFloat) -> CGFloat {
    return textHeight(NSAttributedString(string: s, attributes: [.font: font]), width: width)
  }

  static func metrics(_ row: FDRow, width: CGFloat, expanded: Bool, labels: FDLabels, palette: FDPalette) -> FDMetrics {
    var m = FDMetrics()
    let p = pad
    let inner = max(40, width - p * 2)
    var y: CGFloat = 0
    m.header = CGRect(x: 0, y: y, width: width, height: 56)
    y += 56
    if !row.derivative.isEmpty {
      m.derivative = CGRect(x: p, y: y, width: inner, height: 24)
      y += 30
    }
    if !row.sound.isEmpty {
      m.sound = CGRect(x: p, y: y, width: inner, height: 26)
      y += 32
    }
    if !row.media.isEmpty {
      m.media = CGRect(x: 0, y: y, width: width, height: width)
      y += width
    }
    if row.hasRepost {
      y += 8
      m.repost = CGRect(x: p, y: y, width: inner, height: 64)
      y += 64
    }
    m.actions = CGRect(x: 0, y: y, width: width, height: 46)
    y += 46
    if row.likes > 0 {
      m.likes = CGRect(x: p, y: y, width: inner, height: 20)
      y += 22
    }
    if !row.caption.isEmpty {
      let full = textHeight(captionText(row, palette: palette), width: inner)
      let two = ceil(captionFont.lineHeight * 2) + 1
      m.truncated = full > two + 1
      let h = (expanded || !m.truncated) ? full : two
      m.caption = CGRect(x: p, y: y, width: inner, height: h)
      y += h
      if m.truncated {
        m.captionMore = CGRect(x: p, y: y, width: inner, height: 20)
        y += 20
      }
      if row.translateState == 1 || row.translateState == 2 || !row.translation.isEmpty {
        y += 6
        if !row.translation.isEmpty {
          let th = textHeight(row.translation, font: captionFont, width: inner)
          m.translation = CGRect(x: p, y: y, width: inner, height: th)
          y += th
          m.translationToggle = CGRect(x: p, y: y, width: inner, height: 20)
          y += 20
        } else {
          m.translation = CGRect(x: p, y: y, width: inner, height: 16)
          y += 16
        }
      }
      y += 2
    }
    if !row.tags.isEmpty {
      y += 4
      m.tags = CGRect(x: p, y: y, width: inner, height: 26)
      y += 28
    }
    if row.comments > 0 {
      y += 4
      m.comments = CGRect(x: p, y: y, width: inner, height: 20)
      y += 20
    }
    if !row.date.isEmpty {
      y += 4
      m.date = CGRect(x: p, y: y, width: inner, height: 16)
      y += 16
    }
    y += 14
    m.height = ceil(y)
    return m
  }

  override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
    guard let row = row else { return layoutAttributes }
    let attrs = layoutAttributes
    let w = attrs.size.width > 0 ? attrs.size.width : bounds.width
    let m = FDPostCell.metrics(row, width: w, expanded: expanded, labels: labels, palette: palette)
    attrs.size = CGSize(width: w, height: m.height)
    return attrs
  }

  // MARK: - Configuração

  func configure(_ row: FDRow, page: Int, expanded: Bool, muted: Bool, labels: FDLabels, palette: FDPalette) {
    self.row = row
    self.expanded = expanded
    self.labels = labels
    self.palette = palette
    contentView.backgroundColor = palette.card
    backgroundColor = palette.card
    separator.backgroundColor = palette.sep

    // Cabeçalho
    initials.text = row.initials
    initials.textColor = palette.text2
    avatar.backgroundColor = palette.placeholder
    if row.avatar != avatarURL || avatar.image == nil {
      avatarURL = row.avatar
      avatar.image = nil
      initials.isHidden = false
      if !row.avatar.isEmpty {
        let want = row.avatar
        if let img = RFImageLoader.shared.cached(want, maxPixel: 120) {
          avatar.image = img
          initials.isHidden = true
        } else {
          RFImageLoader.shared.load(want, maxPixel: 120) { [weak self] img in
            guard let self = self, self.avatarURL == want, let img = img else { return }
            self.avatar.image = img
            self.initials.isHidden = true
          }
        }
      }
    }
    nameLabel.text = row.authorName.isEmpty ? (row.authorEmail.components(separatedBy: "@").first ?? "?") : row.authorName
    nameLabel.textColor = palette.text
    sponsoredLabel.isHidden = !row.sponsored
    sponsoredLabel.text = labels.get("sponsored", "Patrocinado")
    sponsoredLabel.textColor = palette.text
    sponsoredLabel.backgroundColor = palette.chip
    locationButton.isHidden = row.location.isEmpty
    locationButton.setTitle(row.location, for: .normal)
    locationButton.setTitleColor(palette.text2, for: .normal)
    locationButton.tintColor = palette.text2
    timeLabel.text = row.time
    timeLabel.textColor = palette.text3
    moreButton.tintColor = palette.text2
    moreButton.menu = buildMenu(row)
    moreButton.accessibilityLabel = labels.get("more", "Mais opções")

    derivativeLabel.isHidden = row.derivative.isEmpty
    derivativeLabel.text = "  " + row.derivative + "  "
    derivativeLabel.textColor = palette.text
    derivativeLabel.backgroundColor = palette.chip
    soundLabel.isHidden = row.sound.isEmpty
    soundLabel.text = "  " + row.sound
    soundLabel.textColor = palette.text
    soundLabel.backgroundColor = palette.placeholder

    // Mídia
    mediaBox.isHidden = row.media.isEmpty
    configurePages(row, page: page)
    updateMuteBadge(muted)

    // Repost
    repostCard.isHidden = !row.hasRepost
    if row.hasRepost {
      repostCard.layer.borderColor = (palette.text.withAlphaComponent(0.12)).cgColor
      repostCard.backgroundColor = palette.text.withAlphaComponent(0.03)
      repostAuthor.text = row.repostAuthor
      repostAuthor.textColor = palette.text
      repostCaption.text = row.repostCaption
      repostCaption.textColor = palette.text2
      repostThumb.isHidden = row.repostThumb.isEmpty
      if row.repostThumb != repostURL {
        repostURL = row.repostThumb
        repostThumb.image = nil
        let want = row.repostThumb
        if !want.isEmpty {
          RFImageLoader.shared.load(want, maxPixel: 160) { [weak self] img in
            guard let self = self, self.repostURL == want else { return }
            self.repostThumb.image = img
          }
        }
      }
    }

    // Ações
    applyLike(row.liked, animated: false)
    setIcon(commentButton, "message", palette.text, 23)
    commentButton.accessibilityLabel = labels.get("comment", "Comentar")
    setIcon(shareButton, "paperplane", palette.text, 22)
    shareButton.accessibilityLabel = labels.get("share", "Compartilhar")
    giftButton.isHidden = !row.gift
    setIcon(giftButton, "gift", palette.text, 22)
    giftButton.accessibilityLabel = labels.get("gift", "Enviar presente")
    applySave(row.saved, animated: false)
    likesButton.isHidden = row.likes <= 0
    likesButton.setTitle(labels.likes(row.likes), for: .normal)
    likesButton.setTitleColor(palette.text, for: .normal)

    // Texto
    captionLabel.isHidden = row.caption.isEmpty
    if !row.caption.isEmpty {
      captionLabel.attributedText = FDPostCell.captionText(row, palette: palette)
      captionLabel.numberOfLines = expanded ? 0 : 2
    }
    captionMoreButton.setTitle(expanded ? labels.get("less", "menos") : labels.get("moreCaption", "mais"), for: .normal)
    captionMoreButton.setTitleColor(palette.text2, for: .normal)
    translationLabel.textColor = row.translation.isEmpty ? palette.text2 : palette.text
    translationLabel.font = row.translation.isEmpty ? .systemFont(ofSize: 12) : FDPostCell.captionFont
    if !row.translation.isEmpty {
      translationLabel.text = row.translation
    } else if row.translateState == 1 {
      translationLabel.text = labels.get("translating", "Traduzindo…")
    } else if row.translateState == 2 {
      translationLabel.text = labels.get("translateError", "Não foi possível traduzir.")
    } else {
      translationLabel.text = nil
    }
    translationToggle.setTitle(labels.get("showOriginal", "Ver original"), for: .normal)
    translationToggle.setTitleColor(palette.text2, for: .normal)
    configureTags(row)
    commentsButton.isHidden = row.comments <= 0
    commentsButton.setTitle(labels.comments(row.comments), for: .normal)
    commentsButton.setTitleColor(palette.text2, for: .normal)
    dateLabel.text = row.date
    dateLabel.textColor = palette.text3

    metrics = FDPostCell.metrics(row, width: bounds.width > 0 ? bounds.width : UIScreen.main.bounds.width,
                                 expanded: expanded, labels: labels, palette: palette)
    setNeedsLayout()
  }

  private func setIcon(_ b: UIButton, _ symbol: String, _ color: UIColor, _ size: CGFloat) {
    let img = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: size, weight: .regular))
    b.setImage(img, for: .normal)
    b.tintColor = color
  }

  func applyLike(_ liked: Bool, animated: Bool) {
    setIcon(likeButton, liked ? "heart.fill" : "heart", liked ? palette.likeRed : palette.text, 23)
    likeButton.accessibilityLabel = liked ? labels.get("unlike", "Descurtir") : labels.get("like", "Curtir")
    if animated {
      likeButton.transform = CGAffineTransform(scaleX: 0.6, y: 0.6)
      UIView.animate(withDuration: 0.42, delay: 0, usingSpringWithDamping: 0.45, initialSpringVelocity: 8, options: [.allowUserInteraction], animations: {
        self.likeButton.transform = .identity
      })
    }
  }

  func applySave(_ saved: Bool, animated: Bool) {
    setIcon(saveButton, saved ? "bookmark.fill" : "bookmark", palette.text, 22)
    saveButton.accessibilityLabel = saved ? labels.get("unsave", "Remover dos salvos") : labels.get("save", "Salvar")
    if animated {
      saveButton.transform = CGAffineTransform(scaleX: 0.7, y: 0.7)
      UIView.animate(withDuration: 0.35, delay: 0, usingSpringWithDamping: 0.5, initialSpringVelocity: 6, options: [.allowUserInteraction], animations: {
        self.saveButton.transform = .identity
      })
    }
  }

  private func configureTags(_ row: FDRow) {
    for v in tagsStack.arrangedSubviews { tagsStack.removeArrangedSubview(v); v.removeFromSuperview() }
    tagsStack.isHidden = row.tags.isEmpty
    if row.tags.isEmpty { return }
    let with = UILabel()
    with.font = .systemFont(ofSize: 12)
    with.textColor = palette.text2
    with.text = labels.get("with", "com")
    tagsStack.addArrangedSubview(with)
    for (i, em) in row.tags.prefix(4).enumerated() {
      let handle = em.components(separatedBy: "@").first ?? em
      let b = UIButton(type: .custom)
      b.setTitle("@" + handle, for: .normal)
      b.titleLabel?.font = .systemFont(ofSize: 12, weight: .semibold)
      b.setTitleColor(palette.text, for: .normal)
      b.backgroundColor = palette.chip
      b.layer.cornerRadius = 11
      b.contentEdgeInsets = UIEdgeInsets(top: 3, left: 9, bottom: 3, right: 9)
      b.tag = i
      b.addTarget(self, action: #selector(tapTag(_:)), for: .touchUpInside)
      tagsStack.addArrangedSubview(b)
    }
    if row.tags.count > 4 {
      let more = UILabel()
      more.font = .systemFont(ofSize: 12)
      more.textColor = palette.text2
      more.text = "+\(row.tags.count - 4)"
      tagsStack.addArrangedSubview(more)
    }
  }

  private func buildMenu(_ row: FDRow) -> UIMenu {
    let L = labels
    func act(_ action: String, _ title: String, _ symbol: String, destructive: Bool = false) -> UIAction {
      return UIAction(title: title, image: UIImage(systemName: symbol), attributes: destructive ? [.destructive] : []) { [weak self] _ in
        guard let self = self else { return }
        self.delegate?.fdCell(self, action: action, value: "")
      }
    }
    if row.own {
      var items: [UIMenuElement] = [
        row.pinned ? act("pin", L.get("unpin", "Desafixar do perfil"), "pin.slash") : act("pin", L.get("pin", "Fixar no perfil"), "pin"),
        act("analytics", L.get("analytics", "Análises"), "chart.bar"),
      ]
      if row.promote { items.append(act("promote", L.get("promote", "Impulsionar"), "arrow.up.right")) }
      items.append(UIMenu(title: "", options: .displayInline, children: [act("delete", L.get("delete", "Excluir"), "trash", destructive: true)]))
      return UIMenu(title: "", children: items)
    }
    return UIMenu(title: "", children: [
      act("not_interested", L.get("notInterested", "Não tenho interesse"), "eye.slash"),
      act("see_less", L.get("seeLess", "Ver menos posts assim"), "minus.circle"),
    ])
  }

  // MARK: - Carrossel

  private func configurePages(_ row: FDRow, page: Int) {
    let n = row.media.count
    while pages.count < n {
      let pv = FDMediaPage()
      pager.addSubview(pv)
      pages.append(pv)
    }
    for (i, pv) in pages.enumerated() {
      if i >= n {
        pv.isHidden = true
        pv.attach(nil)
        pv.url = ""
        pv.imageView.image = nil
        continue
      }
      pv.isHidden = false
      let md = row.media[i]
      pv.isVideo = md.video
      let img = md.video ? (md.poster.isEmpty ? "" : md.poster) : md.url
      if pv.url != img {
        pv.url = img
        pv.imageView.image = nil
        pv.attach(nil)
        if !img.isEmpty {
          let px = UIScreen.main.bounds.width * UIScreen.main.scale
          if let c = RFImageLoader.shared.cached(img, maxPixel: px) {
            pv.imageView.image = c
          } else {
            RFImageLoader.shared.load(img, maxPixel: px) { [weak pv] im in
              guard let pv = pv, pv.url == img else { return }
              pv.imageView.image = im
              pv.imageView.alpha = 0
              UIView.animate(withDuration: 0.14) { pv.imageView.alpha = 1 }
            }
          }
        }
      }
      pv.setFailed(false)
    }
    pager.isScrollEnabled = n > 1
    counterLabel.isHidden = n <= 1
    dotsView.isHidden = n <= 1 || n > 10
    if dotsView.arrangedSubviews.count != (n > 1 && n <= 10 ? n : 0) {
      for v in dotsView.arrangedSubviews { dotsView.removeArrangedSubview(v); v.removeFromSuperview() }
      if n > 1 && n <= 10 {
        for _ in 0..<n {
          let d = UIView()
          d.layer.cornerRadius = 3
          d.translatesAutoresizingMaskIntoConstraints = false
          d.widthAnchor.constraint(equalToConstant: 6).isActive = true
          d.heightAnchor.constraint(equalToConstant: 6).isActive = true
          dotsView.addArrangedSubview(d)
        }
      }
    }
    self.page = max(0, min(page, max(0, n - 1)))
    updatePageIndicators()
    setNeedsLayout()
  }

  private func updatePageIndicators() {
    guard let row = row else { return }
    counterLabel.text = "\(page + 1)/\(row.media.count)"
    for (i, d) in dotsView.arrangedSubviews.enumerated() {
      d.backgroundColor = i == page ? .white : UIColor(white: 1, alpha: 0.5)
      d.transform = i == page ? CGAffineTransform(scaleX: 1.3, y: 1.3) : .identity
    }
  }

  var currentPageIsVideo: Bool {
    guard let row = row, page < row.media.count else { return false }
    return row.media[page].video
  }

  var hasVideo: Bool { return row?.media.contains { $0.video } ?? false }

  /// Liga o player do pool à página atual (nil = solta tudo).
  func attachPlayer(_ player: AVPlayer?) {
    for (i, pv) in pages.enumerated() {
      pv.attach(i == page ? player : nil)
      pv.setFailed(false)
    }
    muteBadge.isHidden = !(currentPageIsVideo && player != nil)
  }

  func markFailed() {
    if page < pages.count { pages[page].setFailed(true) }
  }

  func updateMuteBadge(_ muted: Bool) {
    muteBadge.image = UIImage(systemName: muted ? "speaker.slash.fill" : "speaker.wave.2.fill",
                              withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold))
    muteBadge.accessibilityLabel = muted ? labels.get("unmute", "Ativar som") : labels.get("mute", "Silenciar")
  }

  /// Retângulo da mídia nas coordenadas de `view`.
  func mediaRect(in view: UIView) -> CGRect? {
    guard !mediaBox.isHidden, mediaBox.bounds.height > 0 else { return nil }
    return mediaBox.convert(mediaBox.bounds, to: view)
  }

  func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
    guard scrollView === pager, pager.bounds.width > 0 else { return }
    let p = Int(round(pager.contentOffset.x / pager.bounds.width))
    if p != page {
      page = p
      updatePageIndicators()
      delegate?.fdCellPageChanged(self, page: p)
    }
  }

  // MARK: - Layout

  override func layoutSubviews() {
    super.layoutSubviews()
    guard let row = row else { return }
    let w = bounds.width
    if metrics.header.width != w {
      metrics = FDPostCell.metrics(row, width: w, expanded: expanded, labels: labels, palette: palette)
    }
    let m = metrics
    let p = FDPostCell.pad
    // Cabeçalho
    headerTap.frame = CGRect(x: 0, y: 0, width: max(0, w - 120), height: 56)
    avatar.frame = CGRect(x: p, y: 11, width: 34, height: 34)
    initials.frame = avatar.bounds
    let rightW: CGFloat = 32
    moreButton.frame = CGRect(x: w - p - rightW + 8, y: 12, width: rightW, height: 32)
    let timeW = min(80, ceil((timeLabel.text ?? "").size(withAttributes: [.font: timeLabel.font!]).width))
    timeLabel.frame = CGRect(x: moreButton.frame.minX - 4 - timeW, y: 12, width: timeW, height: 32)
    let nameX = avatar.frame.maxX + 10
    let maxName = max(40, timeLabel.frame.minX - 8 - nameX - (row.sponsored ? 84 : 0))
    let nameW = min(maxName, ceil((nameLabel.text ?? "").size(withAttributes: [.font: nameLabel.font!]).width))
    let hasLoc = !row.location.isEmpty
    nameLabel.frame = CGRect(x: nameX, y: hasLoc ? 10 : 18, width: nameW, height: 20)
    if row.sponsored {
      let sw = ceil((sponsoredLabel.text ?? "").size(withAttributes: [.font: sponsoredLabel.font!]).width) + 12
      sponsoredLabel.frame = CGRect(x: nameLabel.frame.maxX + 6, y: nameLabel.frame.midY - 8, width: sw, height: 16)
    }
    locationButton.frame = CGRect(x: nameX, y: 30, width: max(40, timeLabel.frame.minX - 8 - nameX), height: 16)
    // Extras
    derivativeLabel.frame = CGRect(origin: m.derivative.origin, size: CGSize(width: min(m.derivative.width, ceil(derivativeLabel.intrinsicContentSize.width)), height: m.derivative.height))
    soundLabel.frame = m.sound
    // Mídia
    mediaBox.frame = m.media
    pager.frame = mediaBox.bounds
    let pw = mediaBox.bounds.width
    let n = row.media.count
    for (i, pv) in pages.enumerated() where i < n {
      pv.frame = CGRect(x: CGFloat(i) * pw, y: 0, width: pw, height: mediaBox.bounds.height)
    }
    let cs = CGSize(width: pw * CGFloat(max(1, n)), height: mediaBox.bounds.height)
    if pager.contentSize != cs { pager.contentSize = cs }
    let wantX = CGFloat(page) * pw
    if !pager.isDragging && !pager.isDecelerating && abs(pager.contentOffset.x - wantX) > 0.5 {
      pager.contentOffset = CGPoint(x: wantX, y: 0)
    }
    counterLabel.frame = CGRect(x: pw - 12 - 44, y: 12, width: 44, height: 24)
    let dotsW = CGFloat(n) * 6 + CGFloat(max(0, n - 1)) * 5
    dotsView.frame = CGRect(x: (pw - dotsW) / 2, y: mediaBox.bounds.height - 18, width: dotsW, height: 8)
    muteBadge.frame = CGRect(x: pw - 12 - 28, y: mediaBox.bounds.height - 12 - 28, width: 28, height: 28)
    // Repost
    repostCard.frame = m.repost
    let hasThumb = !row.repostThumb.isEmpty
    repostThumb.frame = CGRect(x: 8, y: 8, width: 48, height: 48)
    let rx: CGFloat = hasThumb ? 66 : 12
    repostAuthor.frame = CGRect(x: rx, y: 10, width: m.repost.width - rx - 10, height: 18)
    repostCaption.frame = CGRect(x: rx, y: 28, width: m.repost.width - rx - 10, height: 30)
    // Ações
    let ay = m.actions.minY + 3
    likeButton.frame = CGRect(x: 6, y: ay, width: 40, height: 40)
    commentButton.frame = CGRect(x: 46, y: ay, width: 40, height: 40)
    shareButton.frame = CGRect(x: 86, y: ay, width: 40, height: 40)
    giftButton.frame = CGRect(x: 126, y: ay, width: 40, height: 40)
    saveButton.frame = CGRect(x: w - 46, y: ay, width: 40, height: 40)
    likesButton.frame = m.likes
    // Texto
    captionLabel.frame = m.caption
    captionMoreButton.isHidden = !m.truncated
    captionMoreButton.frame = m.captionMore
    let hasTr = !(row.translation.isEmpty && row.translateState == 0)
    translationLabel.isHidden = !hasTr
    translationLabel.frame = m.translation
    translationToggle.isHidden = row.translation.isEmpty
    translationToggle.frame = m.translationToggle
    if !m.tags.isEmpty {
      let fit = tagsStack.systemLayoutSizeFitting(UIView.layoutFittingCompressedSize)
      tagsStack.frame = CGRect(x: m.tags.minX, y: m.tags.minY, width: min(m.tags.width, ceil(fit.width)), height: m.tags.height)
    }
    commentsButton.frame = m.comments
    dateLabel.frame = m.date
    separator.frame = CGRect(x: 0, y: bounds.height - 0.5, width: w, height: 0.5)
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    attachPlayer(nil)
    likeButton.transform = .identity
    saveButton.transform = .identity
    contentView.layer.sublayers?.filter { $0.name == "fd-heart" }.forEach { $0.removeFromSuperlayer() }
  }

  // MARK: - Coração do duplo toque

  private static let heartImage: CGImage? = {
    let side: CGFloat = 100
    guard let sym = UIImage(systemName: "heart.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 86, weight: .bold))?
      .withTintColor(.white, renderingMode: .alwaysOriginal) else { return nil }
    let sz = sym.size
    let k = min(side / max(sz.width, 1), side / max(sz.height, 1))
    let w = sz.width * k
    let h = sz.height * k
    let fmt = UIGraphicsImageRendererFormat.default()
    fmt.opaque = false
    let img = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: fmt).image { _ in
      sym.draw(in: CGRect(x: (side - w) / 2, y: (side - h) / 2, width: w, height: h))
    }
    return img.cgImage
  }()

  func burstHeart(at pIn: CGPoint) {
    guard let img = FDPostCell.heartImage else { return }
    let size: CGFloat = 100
    let p = CGPoint(x: mediaBox.frame.midX, y: mediaBox.frame.midY)
    _ = pIn
    let layer = CALayer()
    layer.name = "fd-heart"
    layer.contents = img
    layer.contentsGravity = .resizeAspect
    layer.contentsScale = UIScreen.main.scale
    layer.bounds = CGRect(x: 0, y: 0, width: size, height: size)
    layer.position = p
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = 0.3
    layer.shadowRadius = 10
    layer.shadowOffset = .zero
    layer.opacity = 0
    contentView.layer.addSublayer(layer)
    let scale = CAKeyframeAnimation(keyPath: "transform.scale")
    scale.values = [0.2, 1.15, 0.95, 1.0, 1.0, 1.08]
    scale.keyTimes = [0, 0.2, 0.32, 0.42, 0.78, 1]
    let fade = CAKeyframeAnimation(keyPath: "opacity")
    fade.values = [0, 1, 1, 0]
    fade.keyTimes = [0, 0.12, 0.7, 1]
    let g = CAAnimationGroup()
    g.animations = [scale, fade]
    g.duration = 0.9
    g.timingFunction = CAMediaTimingFunction(name: .easeOut)
    g.isRemovedOnCompletion = true
    CATransaction.begin()
    CATransaction.setCompletionBlock { [weak layer] in layer?.removeFromSuperlayer() }
    layer.add(g, forKey: "burst")
    CATransaction.commit()
  }

  // MARK: - Toques

  private func emit(_ action: String, _ value: String = "") { delegate?.fdCell(self, action: action, value: value) }

  @objc private func tapAuthor() { emit("author") }
  @objc private func tapLocation() { emit("location") }
  @objc private func tapRepost() { emit("repost") }
  @objc private func tapLike() { emit("like") }
  @objc private func tapComment() { emit("comments") }
  @objc private func tapShare() { emit("share") }
  @objc private func tapGift() { emit("gift") }
  @objc private func tapSave() { emit("save") }
  @objc private func tapLikers() { emit("likers") }
  @objc private func tapExpand() { delegate?.fdCellToggleExpand(self) }
  @objc private func tapTranslateToggle() { emit("translate") }

  @objc private func longSave(_ g: UILongPressGestureRecognizer) {
    if g.state == .began {
      UIImpactFeedbackGenerator(style: .medium).impactOccurred()
      emit("collections")
    }
  }

  @objc private func tapTag(_ b: UIButton) {
    guard let row = row, b.tag < row.tags.count else { return }
    emit("tagged", row.tags[b.tag])
  }

  @objc private func tapCaption(_ g: UITapGestureRecognizer) {
    let p = g.location(in: captionLabel)
    if let link = captionLabel.link(at: p) {
      if link == "author:" { emit("author"); return }
      if link.hasPrefix("tag:") { emit("hashtag", String(link.dropFirst(4))); return }
      if link.hasPrefix("mention:") { emit("mention", String(link.dropFirst(8))); return }
    }
    if metrics.truncated && !expanded { delegate?.fdCellToggleExpand(self) }
  }

  @objc private func longCaption(_ g: UILongPressGestureRecognizer) {
    if g.state == .began {
      UISelectionFeedbackGenerator().selectionChanged()
      emit("translate")
    }
  }

  @objc private func mediaDoubleTap(_ g: UITapGestureRecognizer) {
    delegate?.fdCellDoubleTap(self, at: g.location(in: contentView))
  }

  @objc private func mediaSingleTap(_ g: UITapGestureRecognizer) {
    delegate?.fdCellSingleTapMedia(self)
  }
}
