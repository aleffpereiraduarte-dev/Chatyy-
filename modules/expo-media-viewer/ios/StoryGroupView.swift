import UIKit
import AVFoundation

// [2026-10-15 native-story] Página de UMA pessoa no visualizador de status:
// barras de progresso, mídia (foto via MVImageLoader / vídeo AVPlayer /
// texto renderizado com auto-ajuste), cabeçalho e barra inferior. O relógio
// (CADisplayLink) e os gestos ficam no StoryViewerController, que chama
// tick(dt) só na página ativa.

final class SVProgressBars: UIView {
  private var tracks: [CALayer] = []
  private var fills: [CALayer] = []
  private var count = 0
  private var index = 0
  private var fraction: CGFloat = 0

  func setCount(_ n: Int) {
    if n == count && tracks.count == n { return }
    count = n
    tracks.forEach { $0.removeFromSuperlayer() }
    fills.forEach { $0.removeFromSuperlayer() }
    tracks = []
    fills = []
    for _ in 0..<max(0, n) {
      let t = CALayer()
      t.backgroundColor = UIColor(white: 1, alpha: 0.35).cgColor
      t.cornerRadius = 1.25
      t.masksToBounds = true
      let f = CALayer()
      f.backgroundColor = UIColor.white.cgColor
      f.anchorPoint = CGPoint(x: 0, y: 0.5)
      t.addSublayer(f)
      layer.addSublayer(t)
      tracks.append(t)
      fills.append(f)
    }
    setNeedsLayout()
  }

  func set(index: Int, fraction: CGFloat) {
    self.index = index
    self.fraction = max(0, min(1, fraction))
    applyFills()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard count > 0 else { return }
    let gap: CGFloat = count > 30 ? 2 : 4
    let w = (bounds.width - gap * CGFloat(count - 1)) / CGFloat(count)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for (i, t) in tracks.enumerated() {
      t.frame = CGRect(x: CGFloat(i) * (w + gap), y: 0, width: max(1, w), height: bounds.height)
    }
    CATransaction.commit()
    applyFills()
  }

  private func applyFills() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for (i, f) in fills.enumerated() {
      let tb = tracks[i].bounds
      let frac: CGFloat = i < index ? 1 : (i == index ? fraction : 0)
      f.bounds = CGRect(x: 0, y: 0, width: tb.width * frac, height: tb.height)
      f.position = CGPoint(x: 0, y: tb.height / 2)
    }
    CATransaction.commit()
  }
}

final class SVGradientView: UIView {
  override class var layerClass: AnyClass { return CAGradientLayer.self }
  var gradient: CAGradientLayer { return layer as! CAGradientLayer }
}

/// Pílula com fundo de vidro escuro (legenda/música/link/visto por).
final class SVPill: UIControl {
  let icon = UIImageView()
  let label = UILabel()
  private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))

  override init(frame: CGRect) {
    super.init(frame: frame)
    blur.isUserInteractionEnabled = false
    blur.layer.cornerRadius = 16
    blur.clipsToBounds = true
    addSubview(blur)
    icon.tintColor = .white
    icon.contentMode = .scaleAspectFit
    addSubview(icon)
    label.textColor = .white
    label.font = .systemFont(ofSize: 13, weight: .semibold)
    label.lineBreakMode = .byTruncatingTail
    addSubview(label)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  override var isHighlighted: Bool {
    didSet { alpha = isHighlighted ? 0.7 : 1 }
  }

  func preferredWidth(max maxW: CGFloat) -> CGFloat {
    let tw = ceil(label.sizeThatFits(CGSize(width: 1000, height: 32)).width)
    let iw: CGFloat = icon.image == nil ? 0 : 22
    return min(maxW, 12 + iw + tw + 14)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    blur.frame = bounds
    blur.layer.cornerRadius = bounds.height / 2
    var x: CGFloat = 12
    if icon.image != nil {
      icon.frame = CGRect(x: x, y: (bounds.height - 16) / 2, width: 16, height: 16)
      x += 22
    } else {
      icon.frame = .zero
    }
    label.frame = CGRect(x: x, y: 0, width: max(0, bounds.width - x - 12), height: bounds.height)
  }
}

protocol SVGroupViewDelegate: AnyObject {
  func groupViewItemReady(_ gv: SVGroupView, item: SVItem)
  func groupViewItemFinished(_ gv: SVGroupView, item: SVItem)
  func groupViewTapClose(_ gv: SVGroupView)
  func groupViewTapMenu(_ gv: SVGroupView, sender: UIView)
  func groupViewTapReply(_ gv: SVGroupView)
  func groupViewTapLike(_ gv: SVGroupView)
  func groupViewTapViewers(_ gv: SVGroupView)
  func groupViewTapLink(_ gv: SVGroupView, url: String)
  func groupViewTapMute(_ gv: SVGroupView)
  func groupViewIsMuted(_ gv: SVGroupView) -> Bool
  func groupViewTakePlayer(_ gv: SVGroupView, item: SVItem) -> AVPlayer?
  func groupViewNeighborPrefetch(_ gv: SVGroupView, item: SVItem)
  /// Bloco interativo (enquete/quiz/pergunta/slider/menção) tocado.
  func groupViewSticker(_ gv: SVGroupView, overlay: SVOverlay, info: [String: Any])
}

final class SVGroupView: UIView {
  weak var delegate: SVGroupViewDelegate?
  private(set) var group: SVGroup
  /// Área segura da TELA (o controller repassa — dentro do UIScrollView o
  /// safeAreaInsets da página não é confiável fora da posição visível).
  var chromeInsets: UIEdgeInsets = .zero {
    didSet { if chromeInsets != oldValue { setNeedsLayout() } }
  }
  private let labels: SVLabels

  // Mídia
  let mediaHost = UIView()
  private let imageView = UIImageView()
  private let playerView = MVPlayerView()
  private let textBg = SVGradientView()
  private let textLabel = UILabel()
  private let spinner = UIActivityIndicatorView(style: .large)
  private let errorLabel = UILabel()
  /// Escurece a face do cubo durante a troca de pessoa.
  let shade = UIView()

  // [v2] Camada de blocos (figurinhas/texto/GIF/desenho) + status de voz.
  let overlayLayer = SVOverlayLayer()
  private let voiceView = SVVoiceView()
  private var musicEndObs: NSObjectProtocol?
  private var musicEnded = false
  private var textAnimPlayed = false
  private var typeRevealed = -1

  // Interface (some no segurar) — não captura toque no fundo (blocos por baixo).
  let chrome = SVPassThroughView()
  private let topScrim = SVGradientView()
  private let bottomScrim = SVGradientView()
  private let bars = SVProgressBars()
  private let avatarView = UIImageView()
  private let avatarInitial = UILabel()
  private let nameLabel = UILabel()
  private let timeLabel = UILabel()
  private let muteButton = UIButton(type: .system)
  private let menuButton = UIButton(type: .system)
  private let closeButton = UIButton(type: .system)
  private let pauseIcon = UIImageView()
  private let captionLabel = UILabel()
  private let musicPill = SVPill()
  private let linkPill = SVPill()
  // Próprio: "visto por"
  private let viewersPill = SVPill()
  // Outros: pílula de resposta + curtir
  let replyPill = UIControl()
  private let replyPillLabel = UILabel()
  private let likeButton = UIButton(type: .system)

  // Estado de reprodução
  private(set) var index: Int = 0
  private(set) var active = false
  private var paused = false
  private var ready = false
  private var failed = false
  private var elapsed: Double = 0
  private var token = 0
  private(set) var player: AVPlayer?
  private var readyObs: NSKeyValueObservation?
  private var statusObs: NSKeyValueObservation?
  private var endObs: NSObjectProtocol?
  private var videoEnded = false
  private var musicPlayer: AVPlayer?

  var currentItem: SVItem? {
    return index >= 0 && index < group.items.count ? group.items[index] : nil
  }

  init(group: SVGroup, labels: SVLabels) {
    self.group = group
    self.labels = labels
    super.init(frame: .zero)
    setup()
    index = group.index
    configureHeader()
    showItem(index, autoplay: false)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  deinit {
    teardownPlayer()
    stopMusic()
  }

  // MARK: - Setup

  private func symbol(_ name: String, _ size: CGFloat = 20, _ weight: UIImage.SymbolWeight = .semibold) -> UIImage? {
    return UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: size, weight: weight))
  }

  private func setup() {
    backgroundColor = .black
    clipsToBounds = true

    mediaHost.backgroundColor = .black
    mediaHost.clipsToBounds = true
    addSubview(mediaHost)

    textBg.isHidden = true
    textBg.gradient.startPoint = CGPoint(x: 0, y: 0)
    textBg.gradient.endPoint = CGPoint(x: 1, y: 1)
    mediaHost.addSubview(textBg)
    textLabel.textColor = .white
    textLabel.numberOfLines = 0
    textLabel.textAlignment = .center
    textLabel.isHidden = true
    mediaHost.addSubview(textLabel)

    imageView.contentMode = .scaleAspectFit
    imageView.clipsToBounds = true
    mediaHost.addSubview(imageView)

    playerView.playerLayer.videoGravity = .resizeAspect
    playerView.isHidden = true
    mediaHost.addSubview(playerView)

    spinner.color = UIColor(white: 1, alpha: 0.85)
    spinner.hidesWhenStopped = true
    mediaHost.addSubview(spinner)

    errorLabel.textColor = UIColor(white: 1, alpha: 0.85)
    errorLabel.font = .systemFont(ofSize: 15, weight: .semibold)
    errorLabel.textAlignment = .center
    errorLabel.numberOfLines = 0
    errorLabel.isHidden = true
    mediaHost.addSubview(errorLabel)

    voiceView.isHidden = true
    mediaHost.insertSubview(voiceView, aboveSubview: textLabel)

    overlayLayer.onAction = { [weak self] ov, info in
      guard let self = self else { return }
      self.delegate?.groupViewSticker(self, overlay: ov, info: info)
    }
    addSubview(overlayLayer)

    // Chrome
    chrome.backgroundColor = .clear
    addSubview(chrome)

    topScrim.isUserInteractionEnabled = false
    topScrim.gradient.colors = [UIColor(white: 0, alpha: 0.5).cgColor, UIColor(white: 0, alpha: 0).cgColor]
    chrome.addSubview(topScrim)
    bottomScrim.isUserInteractionEnabled = false
    bottomScrim.gradient.colors = [UIColor(white: 0, alpha: 0).cgColor, UIColor(white: 0, alpha: 0.55).cgColor]
    chrome.addSubview(bottomScrim)

    chrome.addSubview(bars)

    avatarView.contentMode = .scaleAspectFill
    avatarView.clipsToBounds = true
    avatarView.backgroundColor = UIColor(white: 0.25, alpha: 1)
    avatarView.layer.borderColor = UIColor(white: 1, alpha: 0.9).cgColor
    avatarView.layer.borderWidth = 1
    chrome.addSubview(avatarView)
    avatarInitial.textColor = .white
    avatarInitial.font = .systemFont(ofSize: 15, weight: .bold)
    avatarInitial.textAlignment = .center
    avatarView.addSubview(avatarInitial)

    nameLabel.textColor = .white
    nameLabel.font = .systemFont(ofSize: 15, weight: .semibold)
    nameLabel.lineBreakMode = .byTruncatingTail
    nameLabel.shadowColor = UIColor(white: 0, alpha: 0.35)
    nameLabel.shadowOffset = CGSize(width: 0, height: 1)
    chrome.addSubview(nameLabel)
    timeLabel.textColor = UIColor(white: 1, alpha: 0.75)
    timeLabel.font = .systemFont(ofSize: 13, weight: .medium)
    chrome.addSubview(timeLabel)

    for (b, name, sel) in [
      (muteButton, "speaker.wave.2.fill", #selector(tapMute)),
      (menuButton, "ellipsis", #selector(tapMenu)),
      (closeButton, "xmark", #selector(tapClose)),
    ] as [(UIButton, String, Selector)] {
      b.setImage(symbol(name, name == "xmark" ? 21 : 20), for: .normal)
      b.tintColor = .white
      b.addTarget(self, action: sel, for: .touchUpInside)
      b.layer.shadowColor = UIColor.black.cgColor
      b.layer.shadowOpacity = 0.3
      b.layer.shadowRadius = 3
      b.layer.shadowOffset = .zero
      chrome.addSubview(b)
    }
    closeButton.accessibilityLabel = labels.get("close", "Fechar")
    menuButton.accessibilityLabel = labels.get("more", "Mais")

    pauseIcon.image = symbol("pause.fill", 13)
    pauseIcon.tintColor = .white
    pauseIcon.alpha = 0
    addSubview(pauseIcon)

    captionLabel.textColor = .white
    captionLabel.font = .systemFont(ofSize: 15, weight: .medium)
    captionLabel.numberOfLines = 5
    captionLabel.textAlignment = .center
    captionLabel.shadowColor = UIColor(white: 0, alpha: 0.5)
    captionLabel.shadowOffset = CGSize(width: 0, height: 1)
    chrome.addSubview(captionLabel)

    musicPill.icon.image = symbol("music.note", 13)
    musicPill.isUserInteractionEnabled = false
    chrome.addSubview(musicPill)

    linkPill.icon.image = symbol("link", 13)
    linkPill.addTarget(self, action: #selector(tapLinkPill), for: .touchUpInside)
    chrome.addSubview(linkPill)

    viewersPill.icon.image = symbol("eye", 14)
    viewersPill.addTarget(self, action: #selector(tapViewers), for: .touchUpInside)
    chrome.addSubview(viewersPill)

    replyPill.layer.cornerRadius = 23
    replyPill.layer.borderWidth = 1
    replyPill.layer.borderColor = UIColor(white: 1, alpha: 0.55).cgColor
    replyPill.addTarget(self, action: #selector(tapReply), for: .touchUpInside)
    chrome.addSubview(replyPill)
    replyPillLabel.textColor = UIColor(white: 1, alpha: 0.9)
    replyPillLabel.font = .systemFont(ofSize: 15)
    replyPillLabel.isUserInteractionEnabled = false
    replyPill.addSubview(replyPillLabel)

    likeButton.tintColor = .white
    likeButton.addTarget(self, action: #selector(tapLike), for: .touchUpInside)
    likeButton.accessibilityLabel = labels.get("like", "Curtir")
    chrome.addSubview(likeButton)

    shade.backgroundColor = .black
    shade.alpha = 0
    shade.isUserInteractionEnabled = false
    addSubview(shade)
  }

  private func configureHeader() {
    nameLabel.text = group.ownerName
    let initial = (group.ownerName.isEmpty ? group.ownerEmail : group.ownerName).trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() } ?? ""
    avatarInitial.text = initial
    avatarInitial.isHidden = false
    if !group.avatar.isEmpty {
      let uri = group.avatar
      if let img = MVImageLoader.shared.cachedImage(uri, maxPixel: 160) {
        avatarView.image = img
        avatarInitial.isHidden = true
      } else {
        MVImageLoader.shared.load(uri, maxPixel: 160) { [weak self] img in
          guard let self = self, self.group.avatar == uri, let img = img else { return }
          self.avatarView.image = img
          self.avatarInitial.isHidden = true
        }
      }
    }
    replyPillLabel.text = labels.get("replyTo", "Responder").replacingOccurrences(of: "{name}", with: group.ownerName)
    replyPill.isHidden = group.isSelf
    likeButton.isHidden = group.isSelf
    viewersPill.isHidden = !group.isSelf
    updateMenuButton()
    bars.setCount(group.items.count)
  }

  /// Menu com entradas por item (ex.: "Traduzir" só com legenda traduzível).
  private func updateMenuButton() {
    guard let item = currentItem else { menuButton.isHidden = group.menu.isEmpty; return }
    menuButton.isHidden = !group.menu.contains(where: { $0.visible(for: item) })
  }

  // MARK: - Layout

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = bounds
    let safe = chromeInsets
    let w = b.width
    let h = b.height
    mediaHost.frame = b
    textBg.frame = mediaHost.bounds
    playerView.frame = mediaHost.bounds
    imageView.frame = mediaHost.bounds
    layoutText()
    spinner.center = CGPoint(x: w / 2, y: h / 2)
    errorLabel.frame = CGRect(x: 32, y: h / 2 - 60, width: w - 64, height: 120)
    voiceView.frame = mediaHost.bounds
    overlayLayer.frame = b
    shade.frame = b
    chrome.frame = b

    let top = max(safe.top, 8)
    topScrim.frame = CGRect(x: 0, y: 0, width: w, height: top + 90)
    bars.frame = CGRect(x: 8, y: top + 6, width: w - 16, height: 2.5)
    let headerY = top + 16
    avatarView.frame = CGRect(x: 12, y: headerY, width: 36, height: 36)
    avatarView.layer.cornerRadius = 18
    avatarInitial.frame = avatarView.bounds
    closeButton.frame = CGRect(x: w - 48, y: headerY - 2, width: 40, height: 40)
    menuButton.frame = CGRect(x: closeButton.frame.minX - 40, y: headerY - 2, width: 40, height: 40)
    let hasAudio = currentItem?.type == .video || !(currentItem?.musicUrl.isEmpty ?? true)
    muteButton.isHidden = !hasAudio
    let rightEdge = (menuButton.isHidden ? closeButton.frame.minX : menuButton.frame.minX) - (hasAudio ? 40 : 0)
    muteButton.frame = CGRect(x: rightEdge, y: headerY - 2, width: 40, height: 40)
    let nameX = avatarView.frame.maxX + 10
    let nameMax = max(40, rightEdge - nameX - 8)
    let nw = min(nameMax, ceil(nameLabel.sizeThatFits(CGSize(width: 1000, height: 20)).width))
    nameLabel.frame = CGRect(x: nameX, y: headerY + 8, width: nw, height: 20)
    let tw = min(max(0, nameMax - nw - 8), ceil(timeLabel.sizeThatFits(CGSize(width: 400, height: 20)).width))
    timeLabel.frame = CGRect(x: nameLabel.frame.maxX + 8, y: headerY + 8, width: tw, height: 20)
    pauseIcon.frame = CGRect(x: w - 30, y: top + 14, width: 14, height: 14)

    // Barra inferior
    let bottom = max(safe.bottom, 12)
    var y = h - bottom - 8
    if group.isSelf {
      let pw = viewersPill.preferredWidth(max: w - 32)
      viewersPill.frame = CGRect(x: (w - pw) / 2, y: y - 36, width: pw, height: 36)
      y -= 36 + 12
    } else {
      likeButton.frame = CGRect(x: w - 12 - 46, y: y - 46, width: 46, height: 46)
      replyPill.frame = CGRect(x: 12, y: y - 46, width: likeButton.frame.minX - 8 - 12, height: 46)
      replyPillLabel.frame = replyPill.bounds.insetBy(dx: 18, dy: 0)
      y -= 46 + 12
    }
    if !linkPill.isHidden {
      let pw = linkPill.preferredWidth(max: w - 48)
      linkPill.frame = CGRect(x: (w - pw) / 2, y: y - 34, width: pw, height: 34)
      y -= 34 + 10
    }
    if !musicPill.isHidden {
      let pw = musicPill.preferredWidth(max: w - 48)
      musicPill.frame = CGRect(x: (w - pw) / 2, y: y - 30, width: pw, height: 30)
      y -= 30 + 10
    }
    if !captionLabel.isHidden {
      let ch = min(130, ceil(captionLabel.sizeThatFits(CGSize(width: w - 40, height: 400)).height))
      captionLabel.frame = CGRect(x: 20, y: y - ch, width: w - 40, height: ch)
      y -= ch + 8
    }
    bottomScrim.frame = CGRect(x: 0, y: max(0, y - 60), width: w, height: h - max(0, y - 60))
  }

  // MARK: - Texto (auto-ajuste)

  static func font(_ id: String, size: CGFloat) -> UIFont {
    let name: String?
    switch id {
    case "serif": name = "Georgia-Bold"
    case "mono": name = "Menlo-Bold"
    case "script": name = "Noteworthy-Bold"
    case "condensed": name = "AvenirNextCondensed-Bold"
    default: name = nil
    }
    if let n = name, let f = UIFont(name: n, size: size) { return f }
    return .systemFont(ofSize: size, weight: .bold)
  }

  private func layoutText() {
    guard let item = currentItem, item.type == .text else { return }
    let w = mediaHost.bounds.width
    let h = mediaHost.bounds.height
    guard w > 0, h > 0 else { return }
    let maxW = w - 48
    let maxH = h * 0.7
    let text = item.text
    let para = NSMutableParagraphStyle()
    para.alignment = item.textAlign == "left" ? .left : (item.textAlign == "right" ? .right : .center)
    para.lineBreakMode = .byWordWrapping
    // Maior fonte (44 → 14) cujo texto quebrado cabe na caixa — medida real.
    var lo: CGFloat = 14
    var hi: CGFloat = 44
    var best: CGFloat = 14
    func height(_ fs: CGFloat) -> CGFloat {
      para.lineSpacing = fs * 0.12
      let a = NSAttributedString(string: text, attributes: [.font: SVGroupView.font(item.font, size: fs), .paragraphStyle: para])
      return ceil(a.boundingRect(with: CGSize(width: maxW, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).height)
    }
    while hi - lo > 0.5 {
      let mid = (lo + hi) / 2
      if height(mid) <= maxH { best = mid; lo = mid } else { hi = mid }
    }
    if height(44) <= maxH { best = 44 }
    best = floor(best)
    para.lineSpacing = best * 0.12
    var attrs: [NSAttributedString.Key: Any] = [.font: SVGroupView.font(item.font, size: best), .paragraphStyle: para, .foregroundColor: UIColor.white]
    if item.font == "condensed" { attrs[.kern] = -0.5 }
    let shown = item.font == "condensed" ? text.uppercased() : text
    let full = NSMutableAttributedString(string: shown, attributes: attrs)
    if item.textAnim == "typewriter" && typeRevealed >= 0 && typeRevealed < (shown as NSString).length {
      // Revela por cor (o layout final fica fixo — sem "pulos" de linha).
      let n = (shown as NSString).length
      full.addAttribute(.foregroundColor, value: UIColor.clear, range: NSRange(location: typeRevealed, length: n - typeRevealed))
    }
    textLabel.attributedText = full
    let th = min(h * 0.86, height(best) + 4)
    textLabel.frame = CGRect(x: 24, y: (h - th) / 2, width: w - 48, height: th)
  }

  // MARK: - Itens

  func showItem(_ i: Int, autoplay: Bool) {
    guard !group.items.isEmpty else { return }
    let idx = max(0, min(group.items.count - 1, i))
    token += 1
    teardownPlayer()
    stopMusic()
    index = idx
    group.index = idx
    elapsed = 0
    musicEnded = false
    textAnimPlayed = false
    textLabel.layer.removeAllAnimations()
    textLabel.alpha = 1
    textLabel.transform = .identity
    ready = false
    failed = false
    videoEnded = false
    bars.setCount(group.items.count)
    bars.set(index: idx, fraction: 0)
    let item = group.items[idx]
    typeRevealed = item.textAnim == "typewriter" ? 0 : -1
    timeLabel.text = item.timeLabel
    updateMenuButton()
    overlayLayer.render(item)
    voiceView.isHidden = item.type != .voice
    errorLabel.isHidden = true
    spinner.stopAnimating()

    // Legenda / música / link / visto por
    captionLabel.text = item.caption
    captionLabel.isHidden = item.caption.isEmpty
    if !item.musicTitle.isEmpty {
      musicPill.label.text = item.musicArtist.isEmpty ? item.musicTitle : "\(item.musicTitle) — \(item.musicArtist)"
      musicPill.isHidden = false
    } else {
      musicPill.isHidden = true
    }
    if !item.linkUrl.isEmpty {
      linkPill.label.text = item.linkLabel.isEmpty ? item.linkUrl : item.linkLabel
      linkPill.isHidden = false
    } else {
      linkPill.isHidden = true
    }
    refreshCounters()

    switch item.type {
    case .voice:
      imageView.isHidden = true
      imageView.image = nil
      playerView.isHidden = true
      textLabel.isHidden = true
      textBg.isHidden = false
      textBg.gradient.colors = [item.bg.cgColor, item.bg.cgColor]
      textBg.backgroundColor = item.bg
      // Legenda vai dentro do visual de voz (não na barra inferior).
      captionLabel.isHidden = true
      voiceView.configure(title: labels.get("voice", "Mensagem de voz"), caption: item.caption)
      markReady()
    case .text:
      imageView.isHidden = true
      imageView.image = nil
      playerView.isHidden = true
      textBg.isHidden = false
      textLabel.isHidden = false
      let cols = item.bgColors.count >= 2 ? item.bgColors : [item.bg, item.bg]
      textBg.gradient.colors = cols.map { $0.cgColor }
      textBg.backgroundColor = item.bg
      layoutText()
      markReady()
    case .image:
      textBg.isHidden = true
      textLabel.isHidden = true
      playerView.isHidden = true
      imageView.isHidden = false
      loadImage(item)
    case .video:
      textBg.isHidden = true
      textLabel.isHidden = true
      imageView.isHidden = false
      imageView.image = nil
      playerView.isHidden = false
      loadPoster(item)
      if autoplay { startVideo(item) }
    }
    setNeedsLayout()
    if autoplay && active {
      startMusicIfNeeded()
      playTextAnimIfNeeded()
    }
  }

  /// Entrada do texto (fade / bounce; typewriter roda no tick).
  private func playTextAnimIfNeeded() {
    guard !textAnimPlayed, let item = currentItem, item.type == .text else { return }
    textAnimPlayed = true
    switch item.textAnim {
    case "fade":
      textLabel.alpha = 0
      UIView.animate(withDuration: 0.6, delay: 0, options: [.curveEaseOut, .allowUserInteraction], animations: { self.textLabel.alpha = 1 })
    case "bounce":
      textLabel.transform = CGAffineTransform(scaleX: 0.5, y: 0.5)
      UIView.animate(withDuration: 0.7, delay: 0, usingSpringWithDamping: 0.45, initialSpringVelocity: 0.8, options: [.allowUserInteraction], animations: {
        self.textLabel.transform = .identity
      })
    default:
      break
    }
  }

  /// Patch do JS: legenda traduzida / original.
  func refreshCaption() {
    guard let item = currentItem else { return }
    if item.type == .voice {
      voiceView.configure(title: labels.get("voice", "Mensagem de voz"), caption: item.caption)
    } else if item.type != .text {
      captionLabel.text = item.caption
      captionLabel.isHidden = item.caption.isEmpty
    }
    updateMenuButton()
    setNeedsLayout()
  }

  func refreshCounters() {
    guard let item = currentItem else { return }
    if group.isSelf {
      viewersPill.label.text = labels.views(item.viewsCount)
    } else {
      let liked = !item.myReaction.isEmpty
      likeButton.setImage(symbol(liked ? "heart.fill" : "heart", 24, .regular), for: .normal)
      likeButton.tintColor = liked ? SVIcons.reactionColor("heart") : .white
    }
    setNeedsLayout()
  }

  private func imageSources(_ item: SVItem) -> [String] {
    var out: [String] = []
    if !item.localUri.isEmpty, MVItem.existingFileURL(item.localUri) != nil { out.append(item.localUri) }
    if !item.uri.isEmpty { out.append(item.uri) }
    return out
  }

  private func applyContentMode(for size: CGSize) {
    // Foto vertical ~ tela → preenche (Instagram); senão cabe inteira.
    let vb = bounds.size
    guard size.width > 0, size.height > 0, vb.width > 0, vb.height > 0 else {
      imageView.contentMode = .scaleAspectFit
      return
    }
    let ar = size.width / size.height
    let vr = vb.width / vb.height
    imageView.contentMode = abs(ar - vr) / vr < 0.18 ? .scaleAspectFill : .scaleAspectFit
  }

  private func loadImage(_ item: SVItem) {
    let t = token
    let sources = imageSources(item)
    imageView.image = nil
    if let first = sources.first, let img = MVImageLoader.shared.cachedImage(first, maxPixel: MVImageLoader.fullMaxPixel) {
      applyContentMode(for: img.size)
      imageView.image = img
      markReady()
      return
    }
    if !item.thumb.isEmpty {
      if let th = MVImageLoader.shared.cachedImage(item.thumb, maxPixel: MVImageLoader.thumbMaxPixel) {
        applyContentMode(for: th.size)
        imageView.image = th
      } else {
        MVImageLoader.shared.load(item.thumb, maxPixel: MVImageLoader.thumbMaxPixel) { [weak self] img in
          guard let self = self, self.token == t, !self.ready, let img = img else { return }
          self.applyContentMode(for: img.size)
          self.imageView.image = img
        }
      }
    }
    delayedSpinner(t)
    loadFull(sources, 0, t)
  }

  private func loadFull(_ sources: [String], _ i: Int, _ t: Int) {
    guard i < sources.count else {
      guard token == t else { return }
      showError(labels.get("unavailable", "Mídia indisponível"))
      return
    }
    MVImageLoader.shared.load(sources[i], maxPixel: MVImageLoader.fullMaxPixel) { [weak self] img in
      guard let self = self, self.token == t else { return }
      if let img = img {
        self.applyContentMode(for: img.size)
        self.imageView.image = img
        self.spinner.stopAnimating()
        self.markReady()
      } else {
        self.loadFull(sources, i + 1, t)
      }
    }
  }

  private func loadPoster(_ item: SVItem) {
    guard !item.thumb.isEmpty else { return }
    let t = token
    MVImageLoader.shared.load(item.thumb, maxPixel: MVImageLoader.thumbMaxPixel) { [weak self] img in
      guard let self = self, self.token == t, let img = img, !self.ready else { return }
      self.applyContentMode(for: img.size)
      self.imageView.image = img
    }
  }

  private func delayedSpinner(_ t: Int) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
      guard let self = self, self.token == t, !self.ready, !self.failed else { return }
      self.spinner.startAnimating()
    }
  }

  private func showError(_ text: String) {
    failed = true
    spinner.stopAnimating()
    errorLabel.text = text
    errorLabel.isHidden = false
  }

  private func markReady() {
    if ready { return }
    ready = true
    spinner.stopAnimating()
    if active, let item = currentItem {
      delegate?.groupViewItemReady(self, item: item)
      if let next = nextItem() { delegate?.groupViewNeighborPrefetch(self, item: next) }
    }
  }

  func nextItem() -> SVItem? {
    let n = index + 1
    return n < group.items.count ? group.items[n] : nil
  }

  // MARK: - Vídeo

  private func startVideo(_ item: SVItem) {
    if player != nil { return }
    guard let p = delegate?.groupViewTakePlayer(self, item: item) else {
      showError(labels.get("videoUnavailable", "Vídeo indisponível"))
      return
    }
    let t = token
    p.isMuted = delegate?.groupViewIsMuted(self) ?? false
    p.actionAtItemEnd = .pause
    playerView.playerLayer.player = p
    readyObs = playerView.playerLayer.observe(\.isReadyForDisplay, options: [.initial, .new]) { [weak self] layer, _ in
      let ok = layer.isReadyForDisplay
      DispatchQueue.main.async {
        guard let self = self, self.token == t, ok else { return }
        if let it = self.player?.currentItem {
          let s = it.presentationSize
          if s.width > 0 && s.height > 0 {
            let vb = self.bounds.size
            let ar = s.width / s.height
            let vr = vb.height > 0 ? vb.width / vb.height : ar
            self.playerView.playerLayer.videoGravity = abs(ar - vr) / max(0.01, vr) < 0.18 ? .resizeAspectFill : .resizeAspect
          }
        }
        self.imageView.isHidden = true
        self.markReady()
      }
    }
    statusObs = p.currentItem?.observe(\.status, options: [.initial, .new]) { [weak self] it, _ in
      let bad = it.status == .failed
      DispatchQueue.main.async {
        guard let self = self, self.token == t, bad else { return }
        self.showError(self.labels.get("videoUnavailable", "Vídeo indisponível"))
      }
    }
    endObs = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: p.currentItem, queue: .main) { [weak self] _ in
      guard let self = self, self.token == t else { return }
      if self.currentItem?.loop == true {
        // Boomerang: repete até completar a duração (tick por tempo).
        self.player?.seek(to: .zero)
        if self.active && !self.paused { self.player?.play() }
        return
      }
      self.videoEnded = true
    }
    player = p
    delayedSpinner(t)
    MVAudio.prepareForPlayback()
    if active && !paused { p.play() }
  }

  private func teardownPlayer() {
    readyObs?.invalidate(); readyObs = nil
    statusObs?.invalidate(); statusObs = nil
    if let o = endObs { NotificationCenter.default.removeObserver(o) }
    endObs = nil
    player?.pause()
    playerView.playerLayer.player = nil
    player = nil
  }

  func setMuted(_ m: Bool) {
    player?.isMuted = m
    musicPlayer?.isMuted = m
    muteButton.setImage(symbol(m ? "speaker.slash.fill" : "speaker.wave.2.fill", 20), for: .normal)
    muteButton.accessibilityLabel = m ? labels.get("soundOn", "Ativar som") : labels.get("soundOff", "Desativar som")
  }

  // MARK: - Música

  private func startMusicIfNeeded() {
    guard let item = currentItem, item.type != .video, !item.musicUrl.isEmpty, musicPlayer == nil,
          let u = MVItem.remoteURL(item.musicUrl) ?? MVItem.existingFileURL(item.musicUrl) else { return }
    let p = AVPlayer(url: u)
    p.isMuted = delegate?.groupViewIsMuted(self) ?? false
    if item.musicStartMs > 0 {
      p.seek(to: CMTime(seconds: item.musicStartMs / 1000, preferredTimescale: 600))
    }
    musicPlayer = p
    musicEnded = false
    let t = token
    musicEndObs = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: p.currentItem, queue: .main) { [weak self] _ in
      guard let self = self, self.token == t else { return }
      self.musicEnded = true
    }
    MVAudio.prepareForPlayback()
    if !paused { p.play() }
  }

  private func stopMusic() {
    if let o = musicEndObs { NotificationCenter.default.removeObserver(o) }
    musicEndObs = nil
    musicPlayer?.pause()
    musicPlayer = nil
  }

  // MARK: - Ciclo

  func activate() {
    active = true
    paused = false
    guard let item = currentItem else { return }
    if item.type == .video {
      if player == nil { startVideo(item) } else { player?.play() }
    }
    startMusicIfNeeded()
    playTextAnimIfNeeded()
    if ready {
      delegate?.groupViewItemReady(self, item: item)
      if let next = nextItem() { delegate?.groupViewNeighborPrefetch(self, item: next) }
    }
  }

  /// Saiu da tela: para tudo e volta ao início do item atual.
  func deactivate() {
    active = false
    teardownPlayer()
    stopMusic()
    if currentItem?.type == .video {
      imageView.isHidden = false
      ready = false
      token += 1
      if let item = currentItem { loadPoster(item) }
    }
    elapsed = 0
    bars.set(index: index, fraction: 0)
  }

  func setPaused(_ p: Bool) {
    if paused == p { return }
    paused = p
    if p {
      player?.pause()
      musicPlayer?.pause()
    } else if active {
      if videoEnded { return }
      player?.play()
      musicPlayer?.play()
    }
    UIView.animate(withDuration: 0.18) { self.pauseIcon.alpha = p && self.chrome.alpha < 0.5 ? 0.9 : 0 }
  }

  func setChromeHidden(_ hidden: Bool, animated: Bool) {
    let apply = {
      self.chrome.alpha = hidden ? 0 : 1
      self.pauseIcon.alpha = hidden ? 0.9 : 0
    }
    if animated {
      UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction], animations: apply)
    } else {
      apply()
    }
  }

  /// Chamado pelo CADisplayLink do controller (só na página ativa).
  func tick(_ dt: Double) {
    guard active, let item = currentItem else { return }
    overlayLayer.tick()
    if item.type == .voice {
      if paused { return }
      elapsed += dt
      if let mp = musicPlayer, let it = mp.currentItem, it.status != .failed {
        let dur = it.duration.seconds
        let cur = mp.currentTime().seconds
        if dur.isFinite && dur > 0 && cur.isFinite {
          let f = CGFloat(cur / dur)
          bars.set(index: index, fraction: f)
          voiceView.setProgress(f)
        }
        if musicEnded {
          musicEnded = false
          delegate?.groupViewItemFinished(self, item: item)
          return
        }
        // Sem duração conhecida: teto = duration do item.
        if !(dur.isFinite && dur > 0) && elapsed >= item.durationMs / 1000 {
          delegate?.groupViewItemFinished(self, item: item)
        }
        return
      }
      let total = musicPlayer == nil && item.musicUrl.isEmpty ? 4.0 : (musicPlayer?.currentItem?.status == .failed ? 4.0 : item.durationMs / 1000)
      let f = elapsed / max(0.5, total)
      bars.set(index: index, fraction: CGFloat(f))
      if f >= 1 { delegate?.groupViewItemFinished(self, item: item) }
      return
    }
    if item.type == .video && item.loop && !failed {
      if paused || !ready { return }
      elapsed += dt
      let f = elapsed / max(0.5, item.durationMs / 1000)
      bars.set(index: index, fraction: CGFloat(f))
      if f >= 1 { delegate?.groupViewItemFinished(self, item: item) }
      return
    }
    if item.type == .video {
      if failed {
        if !paused { elapsed += dt }
        let f = elapsed / 4.0
        bars.set(index: index, fraction: CGFloat(f))
        if f >= 1 { delegate?.groupViewItemFinished(self, item: item) }
        return
      }
      guard let p = player, let it = p.currentItem else { return }
      let dur = it.duration.seconds
      let cur = p.currentTime().seconds
      if dur.isFinite && dur > 0 && cur.isFinite {
        bars.set(index: index, fraction: CGFloat(cur / dur))
      }
      if videoEnded {
        videoEnded = false
        delegate?.groupViewItemFinished(self, item: item)
      }
      return
    }
    if paused || (!ready && !failed) { return }
    elapsed += dt
    if item.type == .text && typeRevealed >= 0 {
      let n = ((item.font == "condensed" ? item.text.uppercased() : item.text) as NSString).length
      let want = min(n, Int(elapsed * 28))
      if want != typeRevealed {
        typeRevealed = want >= n ? -1 : want
        layoutText()
      }
    }
    let total = failed ? 4.0 : item.durationMs / 1000
    let f = elapsed / max(0.5, total)
    bars.set(index: index, fraction: CGFloat(f))
    if f >= 1 { delegate?.groupViewItemFinished(self, item: item) }
  }

  // MARK: - Atualizações vindas do JS

  func replaceGroupItems(_ items: [SVItem]) {
    group.items = items
    bars.setCount(items.count)
    bars.set(index: index, fraction: 0)
  }

  // MARK: - Ações

  @objc private func tapClose() { delegate?.groupViewTapClose(self) }
  @objc private func tapMenu() { delegate?.groupViewTapMenu(self, sender: menuButton) }
  @objc private func tapReply() { delegate?.groupViewTapReply(self) }
  @objc private func tapViewers() { delegate?.groupViewTapViewers(self) }
  @objc private func tapMute() { delegate?.groupViewTapMute(self) }
  @objc private func tapLike() {
    UIView.animate(withDuration: 0.12, animations: {
      self.likeButton.transform = CGAffineTransform(scaleX: 1.3, y: 1.3)
    }, completion: { _ in
      UIView.animate(withDuration: 0.18) { self.likeButton.transform = .identity }
    })
    delegate?.groupViewTapLike(self)
  }
  @objc private func tapLinkPill() {
    guard let item = currentItem, !item.linkUrl.isEmpty else { return }
    delegate?.groupViewTapLink(self, url: item.linkUrl)
  }

  /// true quando o toque caiu em um controle (botão/pílula) e não deve navegar.
  func isControl(_ v: UIView?) -> Bool {
    var cur = v
    while let c = cur, c !== self {
      if c is UIControl, !c.isHidden, c.alpha > 0.01 { return true }
      cur = c.superview
    }
    return false
  }
}
