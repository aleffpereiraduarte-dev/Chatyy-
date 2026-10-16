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
    if v2 { applyV2Look(false) }
    let cfg = UIImage.SymbolConfiguration(pointSize: 29, weight: .semibold)
    icon.image = UIImage(systemName: symbol, withConfiguration: cfg)?.withRenderingMode(.alwaysTemplate)
    icon.tintColor = tint
    count.text = text
    count.isHidden = text.isEmpty
  }

  // [2026-10-16 reels-rail-v2] ícone de linha do app (~30 pt) + sombra suave + contador.
  private(set) var v2 = false
  private var iconKey = ""

  private func applyV2Look(_ on: Bool) {
    if v2 == on { return }
    v2 = on
    iconKey = ""
    icon.contentMode = on ? .center : .scaleAspectFit
    icon.layer.shadowOpacity = on ? 0.5 : 0.35
    icon.layer.shadowRadius = on ? 4 : 3
    count.layer.shadowOpacity = on ? 0.65 : 0.5
    count.layer.shadowRadius = on ? 3 : 2
    setNeedsLayout()
  }

  func setLine(_ path: String, filled: Bool, tint: UIColor, text: String) {
    applyV2Look(true)
    let key = "\(path.count)|\(path.prefix(16))|\(filled)"
    if key != iconKey {
      iconKey = key
      icon.image = RFIcon.image(path, side: 30, line: 2.0, fill: filled)
    }
    icon.tintColor = tint
    count.text = text
    count.isHidden = text.isEmpty
  }

  /// Partículas + anel ao curtir (estilo Instagram/TikTok).
  func burst(color: UIColor) {
    let c = CGPoint(x: icon.frame.midX, y: icon.frame.midY)
    let ring = CAShapeLayer()
    ring.frame = CGRect(x: c.x - 18, y: c.y - 18, width: 36, height: 36)
    ring.path = UIBezierPath(ovalIn: ring.bounds).cgPath
    ring.fillColor = UIColor.clear.cgColor
    ring.strokeColor = color.cgColor
    ring.lineWidth = 2
    ring.opacity = 0
    layer.addSublayer(ring)
    let rs = CABasicAnimation(keyPath: "transform.scale")
    rs.fromValue = 0.45
    rs.toValue = 1.45
    let ro = CAKeyframeAnimation(keyPath: "opacity")
    ro.values = [0.9, 0.6, 0]
    ro.keyTimes = [0, 0.5, 1]
    let rg = CAAnimationGroup()
    rg.animations = [rs, ro]
    rg.duration = 0.45
    rg.timingFunction = CAMediaTimingFunction(name: .easeOut)
    CATransaction.begin()
    CATransaction.setCompletionBlock { [weak ring] in ring?.removeFromSuperlayer() }
    ring.add(rg, forKey: "rf-ring")
    CATransaction.commit()

    let n = 8
    for i in 0..<n {
      let r: CGFloat = i % 2 == 0 ? 2.8 : 2.0
      let dot = CALayer()
      dot.bounds = CGRect(x: 0, y: 0, width: r * 2, height: r * 2)
      dot.cornerRadius = r
      dot.backgroundColor = (i % 2 == 0 ? color : UIColor.white).cgColor
      dot.position = c
      dot.opacity = 0
      layer.addSublayer(dot)
      let ang = CGFloat(i) / CGFloat(n) * 2 * .pi + CGFloat.random(in: -0.18...0.18) - .pi / 2
      let dist: CGFloat = 24 + CGFloat.random(in: 0...8)
      let end = CGPoint(x: c.x + cos(ang) * dist, y: c.y + sin(ang) * dist)
      let mv = CABasicAnimation(keyPath: "position")
      mv.fromValue = NSValue(cgPoint: c)
      mv.toValue = NSValue(cgPoint: end)
      let op = CAKeyframeAnimation(keyPath: "opacity")
      op.values = [1, 1, 0]
      op.keyTimes = [0, 0.55, 1]
      let sc = CABasicAnimation(keyPath: "transform.scale")
      sc.fromValue = 1.0
      sc.toValue = 0.3
      let g = CAAnimationGroup()
      g.animations = [mv, op, sc]
      g.duration = 0.5
      g.beginTime = CACurrentMediaTime() + 0.05
      g.fillMode = .backwards
      g.timingFunction = CAMediaTimingFunction(name: .easeOut)
      CATransaction.begin()
      CATransaction.setCompletionBlock { [weak dot] in dot?.removeFromSuperlayer() }
      dot.add(g, forKey: "rf-dot")
      CATransaction.commit()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let w = bounds.width
    if v2 {
      icon.frame = CGRect(x: (w - 34) / 2, y: 0, width: 34, height: 34)
      count.frame = CGRect(x: -8, y: 35, width: w + 16, height: 16)
      return
    }
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
  // [2026-10-16 reels-rail-v2]
  static let likeRed = UIColor(red: 1, green: 0.17, blue: 0.33, alpha: 1)
  private let avatarInitials = UILabel()
  private let discNote = UIImageView()
  private let discGrooves = CAShapeLayer()
  private let bufferedFill = UIView()
  private let shimmer = CAGradientLayer()
  private let scrubKnob = UIView()
  private let scrubTime = UILabel()
  private var appliedStyle = 0
  private var followAnimating = false
  private var captionKey = ""
  private var discReq = ""
  private var buffered: CGFloat = 0
  private var isBuffering = false
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

    // [2026-10-16 reels-rail-v2] peças do trilho novo (escondidas no v1)
    avatarInitials.textAlignment = .center
    avatarInitials.textColor = .white
    avatarInitials.font = .systemFont(ofSize: 18, weight: .semibold)
    avatarInitials.backgroundColor = UIColor(white: 0.23, alpha: 1)
    avatarInitials.clipsToBounds = true
    avatarInitials.isUserInteractionEnabled = false
    avatarInitials.isHidden = true
    avatarBtn.insertSubview(avatarInitials, belowSubview: avatarImg)
    discGrooves.fillColor = UIColor.clear.cgColor
    discGrooves.strokeColor = UIColor.white.withAlphaComponent(0.07).cgColor
    discGrooves.lineWidth = 1
    discGrooves.isHidden = true
    discBtn.layer.insertSublayer(discGrooves, at: 0)
    discNote.image = RFIcon.image(RFIcon.music, side: 13, line: 2.0, fill: false)
    discNote.tintColor = .white
    discNote.contentMode = .center
    discNote.isUserInteractionEnabled = false
    discNote.isHidden = true
    discInner.addSubview(discNote)
    bufferedFill.backgroundColor = UIColor.white.withAlphaComponent(0.28)
    bufferedFill.isUserInteractionEnabled = false
    bufferedFill.isHidden = true
    progressTrack.insertSubview(bufferedFill, belowSubview: progressFill)
    progressTrack.clipsToBounds = true
    shimmer.startPoint = CGPoint(x: 0, y: 0.5)
    shimmer.endPoint = CGPoint(x: 1, y: 0.5)
    shimmer.colors = [UIColor.white.withAlphaComponent(0).cgColor, UIColor.white.withAlphaComponent(0.95).cgColor, UIColor.white.withAlphaComponent(0).cgColor]
    shimmer.isHidden = true
    progressTrack.layer.addSublayer(shimmer)
    scrubKnob.backgroundColor = .white
    scrubKnob.layer.cornerRadius = 7
    scrubKnob.layer.shadowColor = UIColor.black.cgColor
    scrubKnob.layer.shadowOpacity = 0.35
    scrubKnob.layer.shadowRadius = 3
    scrubKnob.layer.shadowOffset = CGSize(width: 0, height: 1)
    scrubKnob.isUserInteractionEnabled = false
    scrubKnob.alpha = 0
    contentView.addSubview(scrubKnob)
    scrubTime.textAlignment = .center
    scrubTime.isUserInteractionEnabled = false
    scrubTime.layer.shadowColor = UIColor.black.cgColor
    scrubTime.layer.shadowOpacity = 0.6
    scrubTime.layer.shadowRadius = 4
    scrubTime.layer.shadowOffset = CGSize(width: 0, height: 1)
    scrubTime.alpha = 0
    contentView.addSubview(scrubTime)

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
      captionKey = ""
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
    followAnimating = false
    followBtn.layer.removeAllAnimations()
    followBtn.transform = .identity
    followBtn.alpha = 1
    followIcon.image = followPlusImage()
    captionKey = ""
    buffered = 0
    setBuffering(false)
    scrubKnob.alpha = 0
    scrubTime.alpha = 0
    avatarImg.image = nil
    syncPlaceholders()
  }

  // MARK: - Configuração

  func configure(_ it: RFItem, labels: RFLabels, bottomInset: CGFloat) {
    let changed = item?.id != it.id
    item = it
    self.labels = labels
    self.bottomInset = bottomInset
    applyStyle()
    if changed {
      captionKey = ""
      buffered = 0
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
    let pink = RFCell.likeRed
    let v2 = labels.v2
    if v2 {
      likeBtn.setLine(RFIcon.heart, filled: it.liked, tint: it.liked ? pink : .white, text: RFFormat.count(it.likes, labels))
    } else {
      likeBtn.set(symbol: "heart.fill", tint: it.liked ? pink : .white, text: RFFormat.compact(it.likes))
    }
    likeBtn.accessibilityLabel = labels.like
    likeBtn.accessibilityValue = RFFormat.compact(it.likes)
    likersBtn.isHidden = it.likes <= 0
    likersBtn.accessibilityLabel = labels.likers
    likersBtn.accessibilityValue = RFFormat.compact(it.likes)
    if v2 {
      commentBtn.setLine(RFIcon.comment, filled: false, tint: .white, text: it.commentsDisabled ? "" : RFFormat.count(it.comments, labels))
      giftBtn.setLine(RFIcon.gift, filled: false, tint: .white, text: "")
      shareBtn.setLine(RFIcon.send, filled: false, tint: .white, text: RFFormat.count(it.shares, labels))
      saveBtn.setLine(RFIcon.bookmark, filled: it.saved, tint: .white, text: RFFormat.count(it.saves, labels))
      moreBtn.setLine(RFIcon.more, filled: true, tint: .white, text: "")
    } else {
      commentBtn.set(symbol: "ellipsis.bubble.fill", tint: .white, text: RFFormat.compact(it.comments))
    }
    commentBtn.alpha = it.commentsDisabled ? 0.4 : 1
    commentBtn.accessibilityLabel = labels.comment
    if !v2 { giftBtn.set(symbol: "gift.fill", tint: .white, text: "") }
    giftBtn.isHidden = !it.canGift
    giftBtn.accessibilityLabel = labels.gift
    if !v2 { shareBtn.set(symbol: "arrowshape.turn.up.right.fill", tint: .white, text: "") }
    shareBtn.accessibilityLabel = labels.share
    // P&B igual ao JS: salvo = marcador cheio branco; não salvo = vazado branco (antes: amarelo).
    if !v2 { saveBtn.set(symbol: it.saved ? "bookmark.fill" : "bookmark", tint: .white, text: "") }
    saveBtn.accessibilityLabel = it.saved ? labels.saved : labels.save
    if !v2 { moreBtn.set(symbol: "ellipsis", tint: .white, text: "") }
    moreBtn.accessibilityLabel = labels.more
    followBtn.isHidden = !it.canFollow && !(v2 && followAnimating)
    followBtn.accessibilityLabel = labels.follow
    avatarBtn.accessibilityLabel = it.author
    if v2 {
      let a = NSMutableAttributedString(string: it.author, attributes: [.font: UIFont.systemFont(ofSize: 15.5, weight: .bold), .foregroundColor: UIColor.white])
      if it.verified {
        let att = NSTextAttachment()
        att.image = RFIcon.verifiedBadge
        att.bounds = CGRect(x: 0, y: -2, width: 15, height: 15)
        a.append(NSAttributedString(string: " "))
        a.append(NSAttributedString(attachment: att))
      }
      authorLabel.attributedText = a
      avatarInitials.text = RFCell.initials(it.author)
    } else {
      authorLabel.text = it.author
    }
    creditLabel.text = it.credit
    creditBtn.isHidden = it.credit.isEmpty
    if !v2 { captionLabel.text = it.caption }
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
    // v2: disco usa a capa do áudio quando existe; senão o avatar (como antes).
    let cover = labels.v2 ? it.musicCover : ""
    let discFromAvatar = cover.isEmpty
    defer { loadDiscCover(cover) }
    if uri.isEmpty {
      avatarImg.image = nil
      if discFromAvatar { discImg.image = nil }
      syncPlaceholders()
      return
    }
    if let img = RFImageLoader.shared.cached(uri, maxPixel: 144) {
      avatarImg.image = img
      if discFromAvatar { discImg.image = img }
      syncPlaceholders()
      return
    }
    avatarImg.image = nil
    if discFromAvatar { discImg.image = nil }
    syncPlaceholders()
    RFImageLoader.shared.load(uri, maxPixel: 144) { [weak self] img in
      guard let self = self, self.avatarReq == uri else { return }
      self.avatarImg.image = img
      if discFromAvatar { self.discImg.image = img }
      self.syncPlaceholders()
    }
  }

  private func loadDiscCover(_ uri: String) {
    discReq = uri
    if uri.isEmpty { return }
    if let img = RFImageLoader.shared.cached(uri, maxPixel: 96) {
      discImg.image = img
      syncPlaceholders()
      return
    }
    discImg.image = nil
    syncPlaceholders()
    RFImageLoader.shared.load(uri, maxPixel: 96) { [weak self] img in
      guard let self = self, self.discReq == uri else { return }
      self.discImg.image = img
      self.syncPlaceholders()
    }
  }

  // MARK: - Trilho v2 (estilo)

  /// Liga/desliga o visual v2 nas peças compartilhadas (célula reaproveitada).
  private func applyStyle() {
    let style = labels.v2 ? 2 : 1
    if style == appliedStyle { return }
    appliedStyle = style
    let v2 = style == 2
    avatarImg.layer.borderWidth = v2 ? 2 : 1.5
    avatarImg.backgroundColor = v2 ? .clear : UIColor(white: 0.25, alpha: 1)
    avatarInitials.layer.borderColor = UIColor.white.cgColor
    avatarInitials.layer.borderWidth = v2 ? 2 : 0
    followBtn.layer.cornerRadius = v2 ? 10 : 11
    followBtn.layer.borderWidth = v2 ? 0 : 1.5
    followBtn.layer.shadowColor = UIColor.black.cgColor
    followBtn.layer.shadowOpacity = v2 ? 0.3 : 0
    followBtn.layer.shadowRadius = 2
    followBtn.layer.shadowOffset = CGSize(width: 0, height: 1)
    followIcon.image = followPlusImage()
    discBtn.backgroundColor = v2 ? UIColor(white: 0.07, alpha: 1) : UIColor(white: 0.1, alpha: 1)
    discBtn.layer.borderColor = v2 ? UIColor.white.withAlphaComponent(0.22).cgColor : UIColor(white: 0.2, alpha: 1).cgColor
    discBtn.layer.borderWidth = v2 ? 1 : 8
    discBtn.layer.cornerRadius = v2 ? 22 : 20
    discInner.backgroundColor = v2 ? UIColor(white: 0.2, alpha: 1) : UIColor(white: 0.133, alpha: 1)
    discInner.layer.cornerRadius = v2 ? 13 : 12
    discImg.layer.cornerRadius = v2 ? 13 : 9
    discImg.backgroundColor = v2 ? .clear : UIColor(white: 0.25, alpha: 1)
    discGrooves.isHidden = !v2
    musicIcon.image = v2
      ? RFIcon.image(RFIcon.music, side: 14, line: 2.0, fill: false)
      : UIImage(systemName: "music.note", withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold))
    authorLabel.font = .systemFont(ofSize: v2 ? 15.5 : 16, weight: .bold)
    captionLabel.font = .systemFont(ofSize: v2 ? 14.5 : 14.5, weight: .regular)
    for l in [authorLabel, creditLabel, captionLabel, musicLabel, musicLabel2] {
      l.layer.shadowOpacity = v2 ? 0.7 : 0.55
      l.layer.shadowRadius = v2 ? 4 : 3
    }
    // degradê de baixo mais fundo e suave p/ ler legenda em vídeo claro
    if v2 {
      bottomShade.colors = [UIColor.black.withAlphaComponent(0).cgColor, UIColor.black.withAlphaComponent(0.28).cgColor, UIColor.black.withAlphaComponent(0.72).cgColor]
      bottomShade.locations = [0, 0.45, 1]
    } else {
      bottomShade.colors = [UIColor.black.withAlphaComponent(0).cgColor, UIColor.black.withAlphaComponent(0.62).cgColor]
      bottomShade.locations = nil
    }
    bufferedFill.isHidden = !v2
    if !v2 {
      shimmer.isHidden = true
      shimmer.removeAnimation(forKey: "rf-shimmer")
      scrubKnob.alpha = 0
      scrubTime.alpha = 0
    }
    captionKey = ""
    marqueeKey = ""
    syncPlaceholders()
    setNeedsLayout()
  }

  private func syncPlaceholders() {
    let v2 = labels.v2
    avatarInitials.isHidden = !v2 || avatarImg.image != nil
    discNote.isHidden = !v2 || discImg.image != nil
  }

  private func followPlusImage() -> UIImage? {
    if labels.v2 { return RFIcon.image(RFIcon.plus, side: 14, line: 2.4, fill: false) }
    return UIImage(systemName: "plus", withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .bold))
  }

  static func initials(_ name: String) -> String {
    var n = name.trimmingCharacters(in: .whitespacesAndNewlines)
    while n.hasPrefix("@") { n.removeFirst() }
    let parts = n.split(whereSeparator: { $0 == " " || $0 == "." || $0 == "_" || $0 == "-" }).filter { !$0.isEmpty }
    var out = ""
    for p in parts.prefix(2) { if let c = p.first { out.append(c) } }
    if out.isEmpty, let c = n.first { out = String(c) }
    return out.uppercased()
  }

  /// "+" vira visto, pulsa e some (seguir).
  func animateFollowed() {
    guard labels.v2 else { return }
    let id = item?.id
    followAnimating = true
    followBtn.isHidden = false
    followIcon.image = RFIcon.image(RFIcon.check, side: 13, line: 2.6, fill: false)
    followBtn.layer.removeAllAnimations()
    followBtn.transform = .identity
    UIView.animate(withDuration: 0.16, delay: 0, options: [.curveEaseOut], animations: {
      self.followBtn.transform = CGAffineTransform(scaleX: 1.25, y: 1.25)
    }) { _ in
      UIView.animate(withDuration: 0.12, animations: { self.followBtn.transform = .identity }) { _ in
        UIView.animate(withDuration: 0.24, delay: 0.5, options: [.curveEaseIn], animations: {
          self.followBtn.transform = CGAffineTransform(scaleX: 0.05, y: 0.05)
          self.followBtn.alpha = 0
        }) { _ in
          guard self.item?.id == id, self.followAnimating else { return }
          self.followAnimating = false
          self.followBtn.isHidden = !(self.item?.canFollow ?? false)
          self.followBtn.transform = .identity
          self.followBtn.alpha = 1
          self.followIcon.image = self.followPlusImage()
        }
      }
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
      if labels.v2 {
        // TikTok: ao arrastar a tela limpa e aparece o tempo grande + bolinha.
        let a: CGFloat = on ? 0 : 1
        UIView.animate(withDuration: 0.15) {
          for v in self.overlayViews { v.alpha = a }
          self.followBtn.alpha = a
          if let it = self.item, it.commentsDisabled, !on { self.commentBtn.alpha = 0.4 }
          self.scrubKnob.alpha = on ? 1 : 0
          self.scrubTime.alpha = on ? 1 : 0
          self.layoutProgress()
        }
      } else {
        UIView.animate(withDuration: 0.15) { self.layoutProgress() }
      }
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
    if labels.v2 {
      // v2: nada de spinner no meio do vídeo — brilho correndo na barra fina da base.
      if spinner.isAnimating { spinner.stopAnimating() }
      if on == isBuffering { return }
      isBuffering = on
      shimmer.isHidden = !on
      if on { startShimmer() } else { shimmer.removeAnimation(forKey: "rf-shimmer") }
      return
    }
    if isBuffering {
      isBuffering = false
      shimmer.isHidden = true
      shimmer.removeAnimation(forKey: "rf-shimmer")
    }
    if on { if !spinner.isAnimating { spinner.startAnimating() } } else if spinner.isAnimating { spinner.stopAnimating() }
  }

  private func startShimmer() {
    let tw = progressTrack.bounds.width
    if tw <= 0 { return }
    let seg = max(60, tw * 0.32)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    shimmer.frame = CGRect(x: 0, y: 0, width: seg, height: progressTrack.bounds.height)
    CATransaction.commit()
    shimmer.removeAnimation(forKey: "rf-shimmer")
    let a = CABasicAnimation(keyPath: "transform.translation.x")
    a.fromValue = -seg
    a.toValue = tw
    a.duration = 0.95
    a.repeatCount = .infinity
    a.isRemovedOnCompletion = false
    a.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    shimmer.add(a, forKey: "rf-shimmer")
  }

  /// Fração já baixada (faixa mais clara atrás do progresso) — v2.
  func setBuffered(_ f: CGFloat) {
    let v = max(0, min(1, f))
    if abs(v - buffered) < 0.005 { return }
    buffered = v
    if labels.v2 { layoutProgress() }
  }

  /// Rótulo "0:12 / 0:30" enquanto arrasta — v2.
  func setScrubTime(_ cur: Double, _ dur: Double) {
    guard labels.v2, dur > 0 else { return }
    let a = NSMutableAttributedString(string: RFFormat.clock(cur), attributes: [
      .font: UIFont.monospacedDigitSystemFont(ofSize: 22, weight: .bold), .foregroundColor: UIColor.white,
    ])
    a.append(NSAttributedString(string: "  /  " + RFFormat.clock(dur), attributes: [
      .font: UIFont.monospacedDigitSystemFont(ofSize: 22, weight: .semibold), .foregroundColor: UIColor.white.withAlphaComponent(0.6),
    ]))
    scrubTime.attributedText = a
  }

  func setError(_ on: Bool) {
    errorBox.isHidden = !on
    if on {
      spinner.stopAnimating()
      if isBuffering { setBuffering(false) }
    }
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
    let by: CGFloat = labels.v2 ? layoutV2(w: w, h: h, base: base) : layoutV1(w: w, h: h, base: base)

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

  /// Layout original (trilho v1) — inalterado; devolve o topo do bloco de informações.
  private func layoutV1(w: CGFloat, h: CGFloat, base: CGFloat) -> CGFloat {
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
      followBtn.bounds = CGRect(x: 0, y: 0, width: 22, height: 22)
      followBtn.center = CGPoint(x: avatarBtn.frame.maxX - 5, y: avatarBtn.frame.maxY - 11)
    } else {
      followBtn.bounds = CGRect(x: 0, y: 0, width: 22, height: 22)
      followBtn.center = CGPoint(x: avatarBtn.frame.midX, y: avatarBtn.frame.maxY)
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
    return by
  }

  /// [2026-10-16 reels-rail-v2] Trilho novo: avatar 48 com anel branco e "+", ícones de
  /// linha 30 pt com contador, disco 44 com capa; legenda com selo/hashtags/"mais".
  private func layoutV2(w: CGFloat, h: CGFloat, base: CGFloat) -> CGFloat {
    let railW: CGFloat = 64
    let railX = w - railW - 4
    var y = base - 20
    let disc: CGFloat = 44
    y -= disc
    discBtn.bounds = CGRect(x: 0, y: 0, width: disc, height: disc)
    discBtn.center = CGPoint(x: railX + railW / 2, y: y + disc / 2)
    discInner.frame = CGRect(x: 9, y: 9, width: 26, height: 26)
    discImg.frame = discInner.bounds
    discImg.layer.cornerRadius = 13
    discNote.frame = discInner.bounds
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    discGrooves.frame = discBtn.bounds
    let gp = UIBezierPath()
    for r in [19.0, 16.0] as [CGFloat] {
      gp.append(UIBezierPath(ovalIn: CGRect(x: disc / 2 - r, y: disc / 2 - r, width: r * 2, height: r * 2)))
    }
    discGrooves.path = gp.cgPath
    CATransaction.commit()
    y -= 16
    for b in [moreBtn, saveBtn, shareBtn, giftBtn, commentBtn, likeBtn] where !b.isHidden {
      let bh: CGFloat = b.count.isHidden ? 34 : 51
      y -= bh
      b.frame = CGRect(x: railX, y: y, width: railW, height: bh)
      y -= 14
    }
    likersBtn.frame = CGRect(x: likeBtn.frame.minX, y: likeBtn.frame.minY + 34, width: railW, height: max(0, likeBtn.frame.height - 34 + 4))
    let av: CGFloat = 48
    y -= av + 8
    avatarBtn.frame = CGRect(x: railX + (railW - av) / 2, y: y, width: av, height: av)
    avatarImg.frame = avatarBtn.bounds
    avatarImg.layer.cornerRadius = av / 2
    avatarInitials.frame = avatarBtn.bounds
    avatarInitials.layer.cornerRadius = av / 2
    let ring = av + 7
    liveWrap.frame = CGRect(x: avatarBtn.frame.midX - ring / 2, y: avatarBtn.frame.midY - ring / 2, width: ring, height: ring)
    liveRing.bounds = CGRect(x: 0, y: 0, width: ring, height: ring)
    liveRing.center = CGPoint(x: ring / 2, y: ring / 2)
    liveRing.layer.cornerRadius = ring / 2
    followBtn.bounds = CGRect(x: 0, y: 0, width: 20, height: 20)
    if !livePill.isHidden {
      let ps = livePill.sizeThatFits(CGSize(width: 120, height: 14))
      let pw = ceil(ps.width) + 4
      livePill.frame = CGRect(x: avatarBtn.frame.midX - pw / 2, y: avatarBtn.frame.maxY - 6, width: pw, height: 14)
      followBtn.center = CGPoint(x: avatarBtn.frame.maxX - 4, y: avatarBtn.frame.maxY - 12)
    } else {
      followBtn.center = CGPoint(x: avatarBtn.frame.midX, y: avatarBtn.frame.maxY)
    }
    followIcon.frame = followBtn.bounds

    // informações (de baixo p/ cima)
    let left: CGFloat = 14
    let infoW = max(80, railX - left - 10)
    var by = base - 16
    if !musicBtn.isHidden {
      by -= 20
      musicBtn.frame = CGRect(x: left, y: by, width: infoW, height: 20)
      musicIcon.frame = CGRect(x: 0, y: 2, width: 15, height: 16)
      layoutMarquee(boxW: infoW - 22, h: 20)
      by -= 8
    }
    if !captionBtn.isHidden {
      applyCaptionV2(width: infoW)
      let maxH = captionExpanded ? h * 0.38 : ceil(captionLabel.font.lineHeight * 2) + 4
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
    let aw = min(infoW, ceil(authorLabel.sizeThatFits(CGSize(width: infoW, height: 22)).width) + 2)
    authorBtn.frame = CGRect(x: left, y: by, width: max(40, aw), height: 22)
    authorLabel.frame = authorBtn.bounds
    return by
  }

  /// Legenda recolhida: corta no ponto exato e termina com "… mais" (2 linhas).
  private func applyCaptionV2(width: CGFloat) {
    let text = item?.caption ?? ""
    let key = "\(text.count)|\(text.hashValue)|\(Int(width))|\(captionExpanded)|\(labels.seeMore)"
    if key == captionKey { return }
    captionKey = key
    let font = captionLabel.font ?? .systemFont(ofSize: 14.5)
    let full = RFCell.styledCaption(text, font: font)
    if captionExpanded || width <= 0 {
      captionLabel.numberOfLines = 12
      captionLabel.attributedText = full
      return
    }
    captionLabel.numberOfLines = 2
    let maxH = ceil(font.lineHeight * 2) + 2
    func height(_ a: NSAttributedString) -> CGFloat {
      return ceil(a.boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).height)
    }
    if height(full) <= maxH {
      captionLabel.attributedText = full
      return
    }
    let more = NSMutableAttributedString(string: "… ", attributes: [.font: font, .foregroundColor: UIColor.white])
    more.append(NSAttributedString(string: labels.seeMore, attributes: [
      .font: UIFont.systemFont(ofSize: font.pointSize, weight: .semibold),
      .foregroundColor: UIColor.white.withAlphaComponent(0.72),
    ]))
    let ns = text as NSString
    var lo = 0
    var hi = ns.length
    func cut(_ n: Int) -> NSAttributedString {
      var end = min(n, ns.length)
      if end > 0 && end < ns.length {
        let r = ns.rangeOfComposedCharacterSequence(at: end)
        if r.location < end { end = r.location }
      }
      let pre = ns.substring(to: end).trimmingCharacters(in: .whitespacesAndNewlines)
      let a = NSMutableAttributedString(attributedString: RFCell.styledCaption(pre, font: font))
      a.append(more)
      return a
    }
    while lo < hi {
      let mid = (lo + hi + 1) / 2
      if height(cut(mid)) <= maxH { lo = mid } else { hi = mid - 1 }
    }
    captionLabel.attributedText = cut(lo)
  }

  private static let tagRegex = try? NSRegularExpression(pattern: "[#@][\\p{L}\\p{N}_.]+", options: [])

  /// Texto branco; #hashtags e @menções em seminegrito.
  static func styledCaption(_ text: String, font: UIFont) -> NSAttributedString {
    let a = NSMutableAttributedString(string: text, attributes: [.font: font, .foregroundColor: UIColor.white])
    if let re = tagRegex {
      let bold = UIFont.systemFont(ofSize: font.pointSize, weight: .semibold)
      for m in re.matches(in: text, options: [], range: NSRange(location: 0, length: (text as NSString).length)) {
        a.addAttribute(.font, value: bold, range: m.range)
      }
    }
    return a
  }

  private func layoutProgress() {
    let w = bounds.width
    let v2 = labels.v2
    let th: CGFloat = scrubbing ? (v2 ? 6 : 4) : 2
    let y = bounds.height - bottomInset - th - 1
    let oldW = progressTrack.bounds.width
    progressTrack.frame = CGRect(x: 0, y: y, width: w, height: th)
    progressFill.frame = CGRect(x: 0, y: 0, width: w * progress, height: th)
    progressTrack.layer.cornerRadius = th / 2
    progressFill.layer.cornerRadius = th / 2
    guard v2 else { return }
    bufferedFill.frame = CGRect(x: 0, y: 0, width: w * max(buffered, progress), height: th)
    if isBuffering && (shimmer.animation(forKey: "rf-shimmer") == nil || abs(oldW - w) > 0.5) {
      startShimmer()
    } else if isBuffering {
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      shimmer.frame.size.height = th
      CATransaction.commit()
    }
    let k: CGFloat = 14
    scrubKnob.frame = CGRect(x: min(max(0, w * progress - k / 2), w - k), y: y + th / 2 - k / 2, width: k, height: k)
    scrubTime.frame = CGRect(x: 16, y: y - 76, width: w - 32, height: 30)
  }
}
