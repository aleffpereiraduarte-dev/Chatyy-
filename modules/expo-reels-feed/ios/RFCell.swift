import AVFoundation
import UIKit

// [2026-10-15 native-reels] Página do feed: vídeo (AVPlayerLayer emprestado do
// pool) + capa + degradês + trilho de ações + legenda/autor/música + barra de
// progresso. Layout por frames (sem Auto Layout) — barato no scroll.

final class RFPlayerView: UIView {
  override class var layerClass: AnyClass { return AVPlayerLayer.self }
  var playerLayer: AVPlayerLayer { return layer as! AVPlayerLayer }
}

/// Botão do trilho: ícone SF Symbol + contador. Pressionar encolhe (0,88).
final class RFRailButton: UIControl {
  let icon = UIImageView()
  let count = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    icon.contentMode = .scaleAspectFit
    icon.tintColor = .white
    icon.isUserInteractionEnabled = false
    icon.layer.shadowColor = UIColor.black.cgColor
    icon.layer.shadowOpacity = 0.35
    icon.layer.shadowRadius = 3
    icon.layer.shadowOffset = CGSize(width: 0, height: 1)
    count.font = .systemFont(ofSize: 12.5, weight: .semibold)
    count.textColor = .white
    count.textAlignment = .center
    count.isUserInteractionEnabled = false
    count.layer.shadowColor = UIColor.black.cgColor
    count.layer.shadowOpacity = 0.5
    count.layer.shadowRadius = 2
    count.layer.shadowOffset = CGSize(width: 0, height: 1)
    addSubview(icon)
    addSubview(count)
    isAccessibilityElement = true
    accessibilityTraits = .button
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func set(symbol: String, tint: UIColor, text: String) {
    let cfg = UIImage.SymbolConfiguration(pointSize: 29, weight: .semibold)
    icon.image = UIImage(systemName: symbol, withConfiguration: cfg)?.withRenderingMode(.alwaysTemplate)
    icon.tintColor = tint
    count.text = text
    count.isHidden = text.isEmpty
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let w = bounds.width
    icon.frame = CGRect(x: (w - 36) / 2, y: 0, width: 36, height: 36)
    count.frame = CGRect(x: -8, y: 38, width: w + 16, height: 16)
  }

  override var isHighlighted: Bool {
    didSet {
      UIView.animate(withDuration: isHighlighted ? 0.08 : 0.18, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
        self.icon.transform = self.isHighlighted ? CGAffineTransform(scaleX: 0.88, y: 0.88) : .identity
      }
    }
  }

  func pop() {
    let a = CAKeyframeAnimation(keyPath: "transform.scale")
    a.values = [1.0, 1.32, 0.94, 1.0]
    a.keyTimes = [0, 0.35, 0.7, 1]
    a.duration = 0.36
    a.timingFunction = CAMediaTimingFunction(name: .easeOut)
    icon.layer.add(a, forKey: "pop")
  }
}

final class RFCell: UICollectionViewCell {
  static let reuseId = "RFCell"

  let playerView = RFPlayerView()
  let poster = UIImageView()
  private let topShade = CAGradientLayer()
  private let bottomShade = CAGradientLayer()

  // trilho
  let avatarBtn = UIControl()
  private let avatarImg = UIImageView()
  let followBtn = UIControl()
  private let followIcon = UIImageView()
  let likeBtn = RFRailButton()
  let commentBtn = RFRailButton()
  let giftBtn = RFRailButton()
  let shareBtn = RFRailButton()
  let saveBtn = RFRailButton()
  let moreBtn = RFRailButton()
  /// [2026-10-15 reels-gaps] toque no NÚMERO de curtidas → lista de quem curtiu (JS).
  let likersBtn = UIControl()
  /// Disco girando (capa = avatar do autor) → "Usar este som".
  let discBtn = UIControl()
  private let discInner = UIView()
  private let discImg = UIImageView()
  /// Anel pulsante + selo "AO VIVO" quando o autor está transmitindo.
  private let liveRing = UIView()
  /// O pulso anima a opacidade do anel → o "tela limpa" (segurar) esconde pelo contêiner.
  private let liveWrap = UIView()
  private let livePill = UILabel()

  // informações
  let authorBtn = UIControl()
  private let authorLabel = UILabel()
  let creditBtn = UIControl()
  private let creditLabel = UILabel()
  let captionBtn = UIControl()
  private let captionLabel = UILabel()
  let musicBtn = UIControl()
  private let musicIcon = UIImageView()
  private let musicLabel = UILabel()
  /// Letreiro: rola só quando o texto não cabe (2 cópias + pausa entre voltas, como o JS).
  private let musicClip = UIView()
  private let musicTrack = UIView()
  private let musicLabel2 = UILabel()
  private var marqueeKey = ""
  private let subtitleLabel = UILabel()

  // estado
  private let progressTrack = UIView()
  private let progressFill = UIView()
  private let spinner = UIActivityIndicatorView(style: .large)
  private let errorBox = UIView()
  private let errorLabel = UILabel()
  let retryBtn = UIButton(type: .system)
  private let flashIcon = UIImageView()
  private var overlayViews: [UIView] {
    return [avatarBtn, likeBtn, likersBtn, commentBtn, giftBtn, shareBtn, saveBtn, moreBtn, discBtn, liveWrap, livePill, authorBtn, creditBtn, captionBtn, musicBtn]
  }

  private(set) var item: RFItem?
  private(set) var boundPlayer: AVPlayer?
  private var readyObs: NSKeyValueObservation?
  private var captionExpanded = false
  private var labels = RFLabels()
  private var bottomInset: CGFloat = 0
  private var progress: CGFloat = 0
  private var scrubbing = false
  private var thumbReq = ""
  private var avatarReq = ""
  var onAction: ((String, RFCell) -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.backgroundColor = .black
    contentView.clipsToBounds = true

    poster.contentMode = .scaleAspectFill
    poster.clipsToBounds = true
    playerView.playerLayer.videoGravity = .resizeAspectFill
    playerView.backgroundColor = .black
    contentView.addSubview(playerView)
    contentView.addSubview(poster)

    topShade.colors = [UIColor.black.withAlphaComponent(0.5).cgColor, UIColor.black.withAlphaComponent(0).cgColor]
    bottomShade.colors = [UIColor.black.withAlphaComponent(0).cgColor, UIColor.black.withAlphaComponent(0.62).cgColor]
    contentView.layer.addSublayer(topShade)
    contentView.layer.addSublayer(bottomShade)

    // avatar + seguir
    avatarImg.contentMode = .scaleAspectFill
    avatarImg.clipsToBounds = true
    avatarImg.backgroundColor = UIColor(white: 0.25, alpha: 1)
    avatarImg.layer.borderColor = UIColor.white.cgColor
    avatarImg.layer.borderWidth = 1.5
    avatarImg.isUserInteractionEnabled = false
    avatarBtn.addSubview(avatarImg)
    // P&B como o JS (profileFollowBadge): selo branco, "+" preto, borda preta.
    followBtn.backgroundColor = .white
    followBtn.layer.cornerRadius = 11
    followBtn.layer.borderColor = UIColor.black.cgColor
    followBtn.layer.borderWidth = 1.5
    followIcon.image = UIImage(systemName: "plus", withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .bold))
    followIcon.tintColor = .black
    followIcon.contentMode = .center
    followIcon.isUserInteractionEnabled = false
    followBtn.addSubview(followIcon)
    liveRing.isUserInteractionEnabled = false
    liveRing.backgroundColor = .clear
    liveRing.layer.borderColor = UIColor(red: 1, green: 0.23, blue: 0.19, alpha: 1).cgColor
    liveRing.layer.borderWidth = 2.5
    liveRing.isHidden = true
    livePill.isUserInteractionEnabled = false
    livePill.font = .systemFont(ofSize: 8, weight: .heavy)
    livePill.textColor = .white
    livePill.textAlignment = .center
    livePill.backgroundColor = UIColor(red: 1, green: 0.23, blue: 0.19, alpha: 1)
    livePill.layer.cornerRadius = 4
    livePill.layer.borderColor = UIColor.black.cgColor
    livePill.layer.borderWidth = 1.5
    livePill.clipsToBounds = true
    livePill.isHidden = true
    liveWrap.isUserInteractionEnabled = false
    liveWrap.addSubview(liveRing)
    contentView.addSubview(liveWrap)
    contentView.addSubview(avatarBtn)
    contentView.addSubview(livePill)
    contentView.addSubview(followBtn)

    for b in [likeBtn, commentBtn, giftBtn, shareBtn, saveBtn, moreBtn] { contentView.addSubview(b) }
    likersBtn.isAccessibilityElement = true
    likersBtn.accessibilityTraits = .button
    contentView.addSubview(likersBtn)

    // disco (JS albumArt: 40pt, aro #333 de 8pt, miolo #222 de 24pt, avatar 18pt)
    discBtn.backgroundColor = UIColor(white: 0.1, alpha: 1)
    discBtn.layer.borderColor = UIColor(white: 0.2, alpha: 1).cgColor
    discBtn.layer.borderWidth = 8
    discBtn.layer.cornerRadius = 20
    discBtn.clipsToBounds = true
    discBtn.isAccessibilityElement = true
    discBtn.accessibilityTraits = .button
    discInner.backgroundColor = UIColor(white: 0.133, alpha: 1)
    discInner.layer.cornerRadius = 12
    discInner.clipsToBounds = true
    discInner.isUserInteractionEnabled = false
    discImg.contentMode = .scaleAspectFill
    discImg.clipsToBounds = true
    discImg.layer.cornerRadius = 9
    discImg.backgroundColor = UIColor(white: 0.25, alpha: 1)
    discImg.isUserInteractionEnabled = false
    discBtn.addSubview(discInner)
    discInner.addSubview(discImg)
    contentView.addSubview(discBtn)

    authorLabel.font = .systemFont(ofSize: 16, weight: .bold)
    authorLabel.textColor = .white
    creditLabel.font = .systemFont(ofSize: 12, weight: .medium)
    creditLabel.textColor = UIColor.white.withAlphaComponent(0.75)
    captionLabel.font = .systemFont(ofSize: 14.5, weight: .regular)
    captionLabel.textColor = .white
    captionLabel.numberOfLines = 2
    musicIcon.image = UIImage(systemName: "music.note", withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold))
    musicIcon.tintColor = .white
    musicIcon.contentMode = .center
    musicLabel.font = .systemFont(ofSize: 13, weight: .medium)
    musicLabel.textColor = .white
    musicLabel2.font = musicLabel.font
    musicLabel2.textColor = .white
    musicLabel2.isHidden = true
    for l in [authorLabel, creditLabel, captionLabel, musicLabel, musicLabel2] {
      l.isUserInteractionEnabled = false
      l.layer.shadowColor = UIColor.black.cgColor
      l.layer.shadowOpacity = 0.55
      l.layer.shadowRadius = 3
      l.layer.shadowOffset = CGSize(width: 0, height: 1)
    }
    musicIcon.isUserInteractionEnabled = false
    authorBtn.addSubview(authorLabel)
    creditBtn.addSubview(creditLabel)
    captionBtn.addSubview(captionLabel)
    musicBtn.addSubview(musicIcon)
    musicClip.clipsToBounds = true
    musicClip.isUserInteractionEnabled = false
    musicTrack.isUserInteractionEnabled = false
    musicTrack.addSubview(musicLabel)
    musicTrack.addSubview(musicLabel2)
    musicClip.addSubview(musicTrack)
    musicBtn.addSubview(musicClip)
    for v in [authorBtn, creditBtn, captionBtn, musicBtn] { contentView.addSubview(v) }

    subtitleLabel.font = .systemFont(ofSize: 15, weight: .semibold)
    subtitleLabel.textColor = .white
    subtitleLabel.textAlignment = .center
    subtitleLabel.numberOfLines = 3
    subtitleLabel.backgroundColor = UIColor.black.withAlphaComponent(0.45)
    subtitleLabel.layer.cornerRadius = 6
    subtitleLabel.clipsToBounds = true
    subtitleLabel.isHidden = true
    subtitleLabel.isUserInteractionEnabled = false
    contentView.addSubview(subtitleLabel)

    progressTrack.backgroundColor = UIColor.white.withAlphaComponent(0.22)
    progressFill.backgroundColor = UIColor.white.withAlphaComponent(0.92)
    progressTrack.isUserInteractionEnabled = false
    progressTrack.addSubview(progressFill)
    contentView.addSubview(progressTrack)

    spinner.color = .white
    spinner.hidesWhenStopped = true
    contentView.addSubview(spinner)

    errorBox.isHidden = true
    errorBox.backgroundColor = UIColor.black.withAlphaComponent(0.35)
    errorLabel.textColor = .white
    errorLabel.font = .systemFont(ofSize: 15, weight: .semibold)
    errorLabel.textAlignment = .center
    errorLabel.numberOfLines = 0
    retryBtn.setTitleColor(.white, for: .normal)
    retryBtn.titleLabel?.font = .systemFont(ofSize: 15, weight: .bold)
    retryBtn.backgroundColor = UIColor.white.withAlphaComponent(0.18)
    retryBtn.layer.cornerRadius = 20
    retryBtn.layer.borderWidth = 1
    retryBtn.layer.borderColor = UIColor.white.withAlphaComponent(0.6).cgColor
    errorBox.addSubview(errorLabel)
    errorBox.addSubview(retryBtn)
    contentView.addSubview(errorBox)

    flashIcon.tintColor = .white
    flashIcon.contentMode = .center
    flashIcon.backgroundColor = UIColor.black.withAlphaComponent(0.4)
    flashIcon.layer.cornerRadius = 36
    flashIcon.clipsToBounds = true
    flashIcon.alpha = 0
    flashIcon.isUserInteractionEnabled = false
    contentView.addSubview(flashIcon)

    let wire: [(UIControl, String)] = [
      (avatarBtn, "author"), (followBtn, "follow"), (likeBtn as UIControl, "like"), (likersBtn, "likers"), (commentBtn as UIControl, "comment"),
      (giftBtn as UIControl, "gift"), (shareBtn as UIControl, "share"), (saveBtn as UIControl, "save"), (moreBtn as UIControl, "more"),
      (authorBtn, "author"), (creditBtn, "credit"), (captionBtn, "caption"), (musicBtn, "music"), (discBtn, "music"),
      (retryBtn as UIControl, "retry"),
    ]
    for (c, name) in wire {
      c.accessibilityIdentifier = name
      c.addTarget(self, action: #selector(tapControl(_:)), for: .touchUpInside)
    }
    isAccessibilityElement = false
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  @objc private func tapControl(_ c: UIControl) {
    guard let name = c.accessibilityIdentifier else { return }
    if name == "caption" {
      captionExpanded.toggle()
      captionLabel.numberOfLines = captionExpanded ? 12 : 2
      setNeedsLayout()
      UIView.animate(withDuration: 0.2) { self.layoutIfNeeded() }
      return
    }
    onAction?(name, self)
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    attach(nil)
    item = nil
    poster.image = nil
    poster.alpha = 1
    captionExpanded = false
    captionLabel.numberOfLines = 2
    progress = 0
    subtitleLabel.isHidden = true
    spinner.stopAnimating()
    errorBox.isHidden = true
    setOverlayHidden(false, animated: false)
    discImg.image = nil
    setLive(false)
    stopMarquee()
    contentView.layer.sublayers?.filter { $0.name == "rf-heart" }.forEach { $0.removeFromSuperlayer() }
  }

  // MARK: - Configuração

  func configure(_ it: RFItem, labels: RFLabels, bottomInset: CGFloat) {
    let changed = item?.id != it.id
    item = it
    self.labels = labels
    self.bottomInset = bottomInset
    if changed {
      captionExpanded = false
      captionLabel.numberOfLines = 2
      progress = 0
      poster.alpha = 1
      poster.image = nil
      errorBox.isHidden = true
    }
    applyAspect(width: it.width, height: it.height)
    loadThumb(it)
    loadAvatar(it)
    refresh()
    setNeedsLayout()
  }

  /// Contadores/estado (patch do JS ou toque otimista).
  func refresh() {
    guard let it = item else { return }
    let pink = UIColor(red: 1, green: 0.17, blue: 0.33, alpha: 1)
    likeBtn.set(symbol: "heart.fill", tint: it.liked ? pink : .white, text: RFFormat.compact(it.likes))
    likeBtn.accessibilityLabel = labels.like
    likeBtn.accessibilityValue = RFFormat.compact(it.likes)
    likersBtn.isHidden = it.likes <= 0
    likersBtn.accessibilityLabel = labels.likers
    likersBtn.accessibilityValue = RFFormat.compact(it.likes)
    commentBtn.set(symbol: "ellipsis.bubble.fill", tint: .white, text: RFFormat.compact(it.comments))
    commentBtn.alpha = it.commentsDisabled ? 0.4 : 1
    commentBtn.accessibilityLabel = labels.comment
    giftBtn.set(symbol: "gift.fill", tint: .white, text: "")
    giftBtn.isHidden = !it.canGift
    giftBtn.accessibilityLabel = labels.gift
    shareBtn.set(symbol: "arrowshape.turn.up.right.fill", tint: .white, text: "")
    shareBtn.accessibilityLabel = labels.share
    // P&B igual ao JS: salvo = marcador cheio branco; não salvo = vazado branco (antes: amarelo).
    saveBtn.set(symbol: it.saved ? "bookmark.fill" : "bookmark", tint: .white, text: "")
    saveBtn.accessibilityLabel = it.saved ? labels.saved : labels.save
    moreBtn.set(symbol: "ellipsis", tint: .white, text: "")
    moreBtn.accessibilityLabel = labels.more
    followBtn.isHidden = !it.canFollow
    followBtn.accessibilityLabel = labels.follow
    avatarBtn.accessibilityLabel = it.author
    authorLabel.text = it.author
    creditLabel.text = it.credit
    creditBtn.isHidden = it.credit.isEmpty
    captionLabel.text = it.caption
    captionBtn.isHidden = it.caption.isEmpty
    if musicLabel.text != it.music {
      musicLabel.text = it.music
      musicLabel2.text = it.music
      marqueeKey = ""
    }
    musicBtn.isHidden = it.music.isEmpty
    discBtn.accessibilityLabel = labels.sound
    livePill.text = " " + labels.live + " "
    setLive(it.live)
    ensureDiscSpin()
    errorLabel.text = labels.error
    retryBtn.setTitle("  " + labels.retry + "  ", for: .normal)
    setNeedsLayout()
  }

  private func loadThumb(_ it: RFItem) {
    let uri = it.thumb
    thumbReq = uri
    if uri.isEmpty { return }
    let px = max(UIScreen.main.bounds.width, 1) * UIScreen.main.scale
    if let img = RFImageLoader.shared.cached(uri, maxPixel: px) {
      poster.image = img
      return
    }
    RFImageLoader.shared.load(uri, maxPixel: px) { [weak self] img in
      guard let self = self, self.thumbReq == uri else { return }
      if self.poster.image == nil { self.poster.image = img }
    }
  }

  private func loadAvatar(_ it: RFItem) {
    let uri = it.avatar
    avatarReq = uri
    if uri.isEmpty { avatarImg.image = nil; discImg.image = nil; return }
    if let img = RFImageLoader.shared.cached(uri, maxPixel: 144) {
      avatarImg.image = img
      discImg.image = img
      return
    }
    avatarImg.image = nil
    discImg.image = nil
    RFImageLoader.shared.load(uri, maxPixel: 144) { [weak self] img in
      guard let self = self, self.avatarReq == uri else { return }
      self.avatarImg.image = img
      self.discImg.image = img
    }
  }

  /// Vídeo "deitado" (largura ≥ ~0,8 × altura) cabe inteiro; retrato preenche a tela.
  func applyAspect(width: Double, height: Double) {
    guard width > 0, height > 0 else { return }
    let fill = height / width >= 1.2
    playerView.playerLayer.videoGravity = fill ? .resizeAspectFill : .resizeAspect
    poster.contentMode = fill ? .scaleAspectFill : .scaleAspectFit
  }

  // MARK: - Disco / ao vivo / letreiro

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil {
      ensureDiscSpin()
      if item?.live == true { ensureLivePulse() }
      marqueeKey = ""
      setNeedsLayout()
    }
  }

  /// Gira 360° a cada 3 s (igual ao SpinningDisc do JS). Re-adiciona se o
  /// sistema tirou a animação (volta do 2º plano / célula fora da janela).
  private func ensureDiscSpin() {
    if discBtn.layer.animation(forKey: "rf-spin") != nil { return }
    let a = CABasicAnimation(keyPath: "transform.rotation.z")
    a.fromValue = 0
    a.toValue = Double.pi * 2
    a.duration = 3
    a.repeatCount = .infinity
    a.isRemovedOnCompletion = false
    discBtn.layer.add(a, forKey: "rf-spin")
  }

  private func setLive(_ on: Bool) {
    liveRing.isHidden = !on
    livePill.isHidden = !on
    if on {
      ensureLivePulse()
    } else {
      liveRing.layer.removeAnimation(forKey: "rf-live")
    }
    setNeedsLayout()
  }

  /// Pulso do LiveBadgeRing do JS: escala 1→1,07 e opacidade 0,55→1 em 0,9 s, vai-e-volta.
  private func ensureLivePulse() {
    if liveRing.layer.animation(forKey: "rf-live") != nil { return }
    let sc = CABasicAnimation(keyPath: "transform.scale")
    sc.fromValue = 1.0
    sc.toValue = 1.07
    let op = CABasicAnimation(keyPath: "opacity")
    op.fromValue = 0.55
    op.toValue = 1.0
    let g = CAAnimationGroup()
    g.animations = [sc, op]
    g.duration = 0.9
    g.autoreverses = true
    g.repeatCount = .infinity
    g.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    g.isRemovedOnCompletion = false
    liveRing.layer.add(g, forKey: "rf-live")
  }

  private func stopMarquee() {
    musicTrack.layer.removeAnimation(forKey: "rf-marquee")
    musicLabel2.isHidden = true
    marqueeKey = ""
  }

  /// Cabe → uma linha parada. Não cabe → 2 cópias rolando (pausa 1,2 s entre voltas,
  /// ~28 ms por ponto, mín. 4 s — mesmos números do MusicMarquee do JS).
  private func layoutMarquee(boxW: CGFloat, h: CGFloat) {
    let text = musicLabel.text ?? ""
    let textW = ceil(musicLabel.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: h)).width)
    let key = "\(text)|\(Int(boxW))|\(Int(h))"
    let overflow = boxW > 0 && textW > boxW + 1
    if key == marqueeKey && (!overflow || musicTrack.layer.animation(forKey: "rf-marquee") != nil) { return }
    marqueeKey = key
    musicTrack.layer.removeAnimation(forKey: "rf-marquee")
    musicClip.frame = CGRect(x: 20, y: 0, width: boxW, height: h)
    if !overflow || text.isEmpty {
      musicLabel2.isHidden = true
      musicTrack.frame = musicClip.bounds
      musicLabel.frame = musicTrack.bounds
      return
    }
    let gap: CGFloat = 36
    musicLabel2.isHidden = false
    musicTrack.frame = CGRect(x: 0, y: 0, width: textW * 2 + gap + 8, height: h)
    musicLabel.frame = CGRect(x: 0, y: 0, width: textW, height: h)
    musicLabel2.frame = CGRect(x: textW + gap, y: 0, width: textW, height: h)
    let dist = Double(textW + gap)
    let run = max(4.0, dist * 0.028)
    let total = 1.2 + run
    let a = CAKeyframeAnimation(keyPath: "transform.translation.x")
    a.values = [0, 0, -dist]
    a.keyTimes = [0, NSNumber(value: 1.2 / total), 1]
    a.duration = total
    a.repeatCount = .infinity
    a.isRemovedOnCompletion = false
    musicTrack.layer.add(a, forKey: "rf-marquee")
  }

  // MARK: - Player

  func attach(_ player: AVPlayer?) {
    if boundPlayer === player { return }
    readyObs?.invalidate()
    readyObs = nil
    boundPlayer = player
    playerView.playerLayer.player = player
    guard player != nil else {
      poster.alpha = 1
      return
    }
    if playerView.playerLayer.isReadyForDisplay {
      showVideo()
    } else {
      poster.alpha = 1
      readyObs = playerView.playerLayer.observe(\.isReadyForDisplay, options: [.new]) { [weak self] layer, _ in
        DispatchQueue.main.async {
          guard let self = self, layer.isReadyForDisplay, self.playerView.playerLayer === layer else { return }
          self.showVideo()
        }
      }
    }
  }

  private func showVideo() {
    if poster.alpha == 0 { return }
    UIView.animate(withDuration: 0.12) { self.poster.alpha = 0 }
  }

  func setProgress(_ p: CGFloat) {
    if scrubbing { return }
    let v = max(0, min(1, p))
    if abs(v - progress) < 0.001 { return }
    progress = v
    layoutProgress()
  }

  func setScrubbing(_ on: Bool, fraction: CGFloat?) {
    let stateChanged = on != scrubbing
    scrubbing = on
    if let f = fraction { progress = max(0, min(1, f)) }
    if stateChanged {
      UIView.animate(withDuration: 0.15) { self.layoutProgress() }
    } else {
      layoutProgress()
    }
  }

  func setSubtitle(_ text: String) {
    if text.isEmpty {
      if !subtitleLabel.isHidden { subtitleLabel.isHidden = true }
      return
    }
    if subtitleLabel.text != text {
      subtitleLabel.text = text
      setNeedsLayout()
    }
    subtitleLabel.isHidden = false
  }

  func setBuffering(_ on: Bool) {
    if on { if !spinner.isAnimating { spinner.startAnimating() } } else if spinner.isAnimating { spinner.stopAnimating() }
  }

  func setError(_ on: Bool) {
    errorBox.isHidden = !on
    if on { spinner.stopAnimating() }
  }

  /// Segurar (long-press) = tela limpa, como TikTok/Instagram.
  func setOverlayHidden(_ hidden: Bool, animated: Bool) {
    let a: CGFloat = hidden ? 0 : 1
    let apply = {
      for v in self.overlayViews { v.alpha = a }
      self.followBtn.alpha = a
      self.bottomShade.opacity = Float(a)
      self.topShade.opacity = Float(a)
      if let it = self.item, it.commentsDisabled, !hidden { self.commentBtn.alpha = 0.4 }
    }
    if animated { UIView.animate(withDuration: 0.18, animations: apply) } else { apply() }
  }

  func flash(symbol: String) {
    flashIcon.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 30, weight: .semibold))
    flashIcon.layer.removeAllAnimations()
    flashIcon.alpha = 1
    flashIcon.transform = CGAffineTransform(scaleX: 0.8, y: 0.8)
    UIView.animate(withDuration: 0.16, animations: { self.flashIcon.transform = .identity }) { _ in
      UIView.animate(withDuration: 0.3, delay: 0.5, options: [.beginFromCurrentState], animations: { self.flashIcon.alpha = 0 })
    }
  }

  /// Coração do duplo toque (Core Animation): nasce no dedo, cresce com mola,
  /// inclina aleatório, sobe e some.
  private static let heartImage: CGImage? = {
    let side: CGFloat = 104
    guard let sym = UIImage(systemName: "heart.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 90, weight: .bold))?
      .withTintColor(UIColor(red: 1, green: 0.17, blue: 0.33, alpha: 1), renderingMode: .alwaysOriginal) else { return nil }
    // Símbolo SF é vetorial (cgImage pode vir nil) → rasteriza uma vez, aspect-fit.
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

  func burstHeart(at p: CGPoint) {
    let size: CGFloat = 104
    guard let img = RFCell.heartImage else { return }
    let layer = CALayer()
    layer.name = "rf-heart"
    layer.contents = img
    layer.contentsGravity = .resizeAspect
    layer.contentsScale = UIScreen.main.scale
    layer.bounds = CGRect(x: 0, y: 0, width: size, height: size)
    layer.position = p
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = 0.25
    layer.shadowRadius = 8
    layer.opacity = 0
    contentView.layer.addSublayer(layer)

    let angle = CGFloat.random(in: -0.32...0.32)
    let scale = CAKeyframeAnimation(keyPath: "transform.scale")
    scale.values = [0.2, 1.25, 0.95, 1.0, 1.0, 1.3]
    scale.keyTimes = [0, 0.18, 0.3, 0.4, 0.75, 1]
    let rot = CABasicAnimation(keyPath: "transform.rotation.z")
    rot.fromValue = angle
    rot.toValue = angle
    let rise = CAKeyframeAnimation(keyPath: "position.y")
    rise.values = [p.y, p.y, p.y - 90]
    rise.keyTimes = [0, 0.7, 1]
    let fade = CAKeyframeAnimation(keyPath: "opacity")
    fade.values = [0, 1, 1, 0]
    fade.keyTimes = [0, 0.12, 0.72, 1]
    let g = CAAnimationGroup()
    g.animations = [scale, rot, rise, fade]
    g.duration = 0.95
    g.timingFunction = CAMediaTimingFunction(name: .easeOut)
    g.isRemovedOnCompletion = true
    CATransaction.begin()
    CATransaction.setCompletionBlock { [weak layer] in layer?.removeFromSuperlayer() }
    layer.add(g, forKey: "burst")
    CATransaction.commit()
  }

  // MARK: - Hit-test helpers (feed)

  /// Toque em controle (trilho/legenda/erro) → gestos do feed ignoram.
  func isInteractive(_ v: UIView?) -> Bool {
    var cur = v
    while let c = cur, c !== contentView {
      if c is UIControl { return true }
      cur = c.superview
    }
    return false
  }

  var progressRect: CGRect {
    let y = bounds.height - bottomInset
    return CGRect(x: 0, y: y - 26, width: bounds.width, height: 30)
  }

  // MARK: - Layout

  override func layoutSubviews() {
    super.layoutSubviews()
    let w = bounds.width
    let h = bounds.height
    playerView.frame = bounds
    poster.frame = bounds
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    topShade.frame = CGRect(x: 0, y: 0, width: w, height: 150)
    bottomShade.frame = CGRect(x: 0, y: h * 0.55, width: w, height: h * 0.45)
    CATransaction.commit()

    let base = h - bottomInset
    // trilho (de baixo p/ cima)
    let railW: CGFloat = 64
    let railX = w - railW - 6
    var y = base - 26
    // disco por último (embaixo do "…"), como o trilho JS
    let disc: CGFloat = 40
    y -= disc
    // frame com transform de rotação ativo é indefinido → bounds + center
    discBtn.bounds = CGRect(x: 0, y: 0, width: disc, height: disc)
    discBtn.center = CGPoint(x: railX + railW / 2, y: y + disc / 2)
    discInner.frame = CGRect(x: (disc - 24) / 2, y: (disc - 24) / 2, width: 24, height: 24)
    discImg.frame = CGRect(x: 3, y: 3, width: 18, height: 18)
    y -= 12
    for b in [moreBtn, saveBtn, shareBtn, giftBtn, commentBtn, likeBtn] where !b.isHidden {
      let bh: CGFloat = b.count.isHidden ? 44 : 58
      y -= bh
      b.frame = CGRect(x: railX, y: y, width: railW, height: bh)
      y -= 10
    }
    // número de curtidas: alvo próprio sobre o contador (o ícone continua = curtir)
    likersBtn.frame = CGRect(x: likeBtn.frame.minX, y: likeBtn.frame.minY + 37, width: railW, height: max(0, likeBtn.frame.height - 37 + 4))
    let av: CGFloat = 50
    y -= av + 6
    avatarBtn.frame = CGRect(x: railX + (railW - av) / 2, y: y, width: av, height: av)
    avatarImg.frame = avatarBtn.bounds
    avatarImg.layer.cornerRadius = av / 2
    let ring = av + 6
    liveWrap.frame = CGRect(x: avatarBtn.frame.midX - ring / 2, y: avatarBtn.frame.midY - ring / 2, width: ring, height: ring)
    liveRing.bounds = CGRect(x: 0, y: 0, width: ring, height: ring)
    liveRing.center = CGPoint(x: ring / 2, y: ring / 2)
    liveRing.layer.cornerRadius = ring / 2
    if !livePill.isHidden {
      let ps = livePill.sizeThatFits(CGSize(width: 120, height: 14))
      let pw = ceil(ps.width) + 4
      livePill.frame = CGRect(x: avatarBtn.frame.midX - pw / 2, y: avatarBtn.frame.maxY - 6, width: pw, height: 14)
      // selo AO VIVO embaixo → "+" de seguir vai p/ o canto inferior direito
      followBtn.frame = CGRect(x: avatarBtn.frame.maxX - 16, y: avatarBtn.frame.maxY - 22, width: 22, height: 22)
    } else {
      followBtn.frame = CGRect(x: avatarBtn.frame.midX - 11, y: avatarBtn.frame.maxY - 11, width: 22, height: 22)
    }
    followIcon.frame = followBtn.bounds

    // informações (de baixo p/ cima)
    let left: CGFloat = 14
    let infoW = max(80, railX - left - 8)
    var by = base - 18
    if !musicBtn.isHidden {
      by -= 20
      musicBtn.frame = CGRect(x: left, y: by, width: infoW, height: 20)
      musicIcon.frame = CGRect(x: 0, y: 0, width: 16, height: 20)
      layoutMarquee(boxW: infoW - 20, h: 20)
      by -= 8
    }
    if !captionBtn.isHidden {
      let maxH = captionExpanded ? h * 0.38 : 44
      let s = captionLabel.sizeThatFits(CGSize(width: infoW, height: .greatestFiniteMagnitude))
      let ch = min(ceil(s.height), maxH)
      by -= ch
      captionBtn.frame = CGRect(x: left, y: by, width: infoW, height: ch)
      captionLabel.frame = captionBtn.bounds
      by -= 6
    }
    if !creditBtn.isHidden {
      by -= 16
      creditBtn.frame = CGRect(x: left, y: by, width: infoW, height: 16)
      creditLabel.frame = creditBtn.bounds
      by -= 4
    }
    by -= 22
    authorBtn.frame = CGRect(x: left, y: by, width: infoW, height: 22)
    authorLabel.frame = authorBtn.bounds

    // legenda automática (CC) acima do bloco de informações
    if !subtitleLabel.isHidden || subtitleLabel.text != nil {
      let maxW = w - 120
      let s = subtitleLabel.sizeThatFits(CGSize(width: maxW - 16, height: 80))
      let sw = min(maxW, ceil(s.width) + 16)
      let sh = ceil(s.height) + 8
      subtitleLabel.frame = CGRect(x: (w - sw) / 2, y: by - 14 - sh, width: sw, height: sh)
    }

    layoutProgress()
    spinner.center = CGPoint(x: w / 2, y: h / 2)
    flashIcon.frame = CGRect(x: w / 2 - 36, y: h / 2 - 36, width: 72, height: 72)
    errorBox.frame = bounds
    let ls = errorLabel.sizeThatFits(CGSize(width: w - 64, height: 200))
    errorLabel.frame = CGRect(x: 32, y: h / 2 - ls.height - 12, width: w - 64, height: ls.height)
    let rs = retryBtn.sizeThatFits(CGSize(width: w, height: 40))
    retryBtn.frame = CGRect(x: (w - rs.width - 24) / 2, y: h / 2 + 4, width: rs.width + 24, height: 40)
  }

  private func layoutProgress() {
    let w = bounds.width
    let th: CGFloat = scrubbing ? 4 : 2
    let y = bounds.height - bottomInset - th - 1
    progressTrack.frame = CGRect(x: 0, y: y, width: w, height: th)
    progressFill.frame = CGRect(x: 0, y: 0, width: w * progress, height: th)
    progressTrack.layer.cornerRadius = th / 2
    progressFill.layer.cornerRadius = th / 2
  }
}
