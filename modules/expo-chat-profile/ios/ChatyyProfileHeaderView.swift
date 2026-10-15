import ExpoModulesCore
import UIKit

// [2026-10-15 native-profile] Cabeçalho de perfil estilo Telegram por cima do
// ScrollView RN (filho único). O nativo NÃO mexe na geometria do filho: só
// observa o contentOffset (KVO) e desenha o cabeçalho; o measure do Fabric
// (Pressable/Touchable dentro da folha) continua batendo com a tela.

private final class PFActionButton: UIControl {
  let iconView = UIImageView()
  let label = UILabel()
  var key = ""

  override init(frame: CGRect) {
    super.init(frame: frame)
    layer.cornerRadius = 12
    layer.cornerCurve = .continuous
    iconView.contentMode = .center
    iconView.isUserInteractionEnabled = false
    addSubview(iconView)
    label.font = UIFont.systemFont(ofSize: 12, weight: .medium)
    label.textAlignment = .center
    label.adjustsFontSizeToFitWidth = true
    label.minimumScaleFactor = 0.75
    label.isUserInteractionEnabled = false
    addSubview(label)
    isAccessibilityElement = true
    accessibilityTraits = .button
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    iconView.frame = CGRect(x: 0, y: 9, width: bounds.width, height: 26)
    label.frame = CGRect(x: 4, y: 37, width: bounds.width - 8, height: 16)
  }

  override var isHighlighted: Bool {
    didSet {
      UIView.animate(withDuration: isHighlighted ? 0.1 : 0.3, delay: 0, usingSpringWithDamping: 0.6, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
        self.transform = self.isHighlighted ? CGAffineTransform(scaleX: 0.94, y: 0.94) : .identity
        self.alpha = self.isHighlighted ? 0.75 : 1
      }
    }
  }
}

final class ChatyyProfileHeaderView: ExpoView, UIGestureRecognizerDelegate {
  // MARK: Events
  let onClose = EventDispatcher()
  let onAction = EventDispatcher()
  let onAvatarPress = EventDispatcher()
  let onGallery = EventDispatcher()

  // MARK: Props
  var pendingTheme: [String: Any]? = nil
  var titleText = "" { didSet { if titleText != oldValue { textDirty = true } } }
  var subtitleText = "" { didSet { if subtitleText != oldValue { textDirty = true } } }
  var avatarRef: PFImageRef? = nil { didSet { if avatarRef != oldValue { avatarDirty = true } } }
  var initials = "" { didSet { if initials != oldValue { avatarDirty = true } } }
  var avatarColor: UIColor = UIColor(white: 0.55, alpha: 1) { didSet { avatarDirty = true } }
  var photos: [PFImageRef] = []
  var pendingActions: [[String: Any]]? = nil
  var expandedHeight: CGFloat = 264 { didSet { if expandedHeight != oldValue { setNeedsLayout() } } }
  var compactHeight: CGFloat = 56 { didSet { if compactHeight != oldValue { setNeedsLayout() } } }
  var topInset: CGFloat = 0 { didSet { if topInset != oldValue { setNeedsLayout() } } }
  var avatarBadge = "" { didSet { if avatarBadge != oldValue { avatarDirty = true } } }
  var avatarBusy = false { didSet { if avatarBusy != oldValue { avatarDirty = true } } }
  var labels: [String: String] = [:] { didSet { textDirty = true } }
  var closeStyle = "close" { didSet { if closeStyle != oldValue { textDirty = true } } }

  private var textDirty = true
  private var avatarDirty = true
  private var theme = PFTheme()

  // MARK: Views
  private let contentHost = UIView()
  private let overlay = PFPassthroughView()
  private let headerBg = UIView()
  private let hairline = UIView()
  private let closeButton = UIButton(type: .system)
  private let avatarButton = UIControl()
  private let avatarView = PFAvatarView()
  private let badgeView = UIView()
  private let badgeIcon = UIImageView()
  private let badgeSpinner = UIActivityIndicatorView(style: .medium)
  private let bigTitle = UILabel()
  private let bigSubtitle = UILabel()
  private let smallTitle = UILabel()
  private let smallSubtitle = UILabel()
  private let actionsRow = PFPassthroughView()
  private var actionButtons: [PFActionButton] = []

  // MARK: Scroll tracking
  private weak var scroll: UIScrollView?
  private var offsetObs: NSKeyValueObservation?
  private var snapWork: DispatchWorkItem?
  private var lastOffset: CGFloat = 0
  private var gallery: PFGalleryView?
  private var findAttempts = 0
  private let haptic = UIImpactFeedbackGenerator(style: .medium)
  private var armedForGallery = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    addSubview(contentHost)
    addSubview(overlay)
    overlay.clipsToBounds = true
    headerBg.isUserInteractionEnabled = false
    overlay.addSubview(headerBg)
    hairline.isUserInteractionEnabled = false
    hairline.alpha = 0
    overlay.addSubview(hairline)

    for l in [bigTitle, bigSubtitle, smallTitle, smallSubtitle] {
      l.isUserInteractionEnabled = false
      overlay.addSubview(l)
    }
    bigTitle.font = UIFont.systemFont(ofSize: 22, weight: .semibold)
    bigTitle.textAlignment = .center
    bigTitle.lineBreakMode = .byTruncatingTail
    bigSubtitle.font = UIFont.systemFont(ofSize: 15)
    bigSubtitle.textAlignment = .center
    bigSubtitle.lineBreakMode = .byTruncatingTail
    smallTitle.font = UIFont.systemFont(ofSize: 17, weight: .semibold)
    smallTitle.lineBreakMode = .byTruncatingTail
    smallSubtitle.font = UIFont.systemFont(ofSize: 13)
    smallSubtitle.lineBreakMode = .byTruncatingTail

    overlay.addSubview(actionsRow)

    avatarView.isUserInteractionEnabled = false
    avatarButton.addSubview(avatarView)
    badgeView.isUserInteractionEnabled = false
    badgeView.isHidden = true
    badgeView.layer.cornerRadius = 17
    badgeView.layer.borderWidth = 3
    badgeIcon.contentMode = .center
    badgeView.addSubview(badgeIcon)
    badgeSpinner.hidesWhenStopped = true
    badgeView.addSubview(badgeSpinner)
    avatarButton.addSubview(badgeView)
    avatarButton.addTarget(self, action: #selector(avatarTapped), for: .touchUpInside)
    avatarButton.isAccessibilityElement = true
    avatarButton.accessibilityTraits = .image
    overlay.addSubview(avatarButton)

    closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
    overlay.addSubview(closeButton)

    avatarView.onImage = { [weak self] _ in self?.setNeedsLayout() }
    applyTheme()
  }

  // MARK: Fabric children

  override func mountChildComponentView(_ childComponentView: UIView, index: Int) {
    contentHost.insertSubview(childComponentView, at: index)
    findAttempts = 0
    DispatchQueue.main.async { [weak self] in self?.attachScrollIfNeeded() }
  }

  override func unmountChildComponentView(_ childComponentView: UIView, index: Int) {
    if let s = scroll, s.isDescendant(of: childComponentView) { detachScroll() }
    childComponentView.removeFromSuperview()
  }

  private func findScroll(in v: UIView, depth: Int) -> UIScrollView? {
    if let s = v as? UIScrollView, !(s is UITextView) { return s }
    if depth > 6 { return nil }
    for sub in v.subviews {
      if let s = findScroll(in: sub, depth: depth + 1) { return s }
    }
    return nil
  }

  private func attachScrollIfNeeded() {
    if scroll != nil { return }
    guard let s = findScroll(in: contentHost, depth: 0) else {
      findAttempts += 1
      if findAttempts < 10 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.attachScrollIfNeeded() }
      }
      return
    }
    scroll = s
    s.alwaysBounceVertical = true
    offsetObs = s.observe(\.contentOffset, options: [.new]) { [weak self] sv, _ in
      self?.scrollChanged(sv)
    }
    s.panGestureRecognizer.addTarget(self, action: #selector(scrollPan(_:)))
    scrollChanged(s)
  }

  private func detachScroll() {
    offsetObs?.invalidate()
    offsetObs = nil
    scroll?.panGestureRecognizer.removeTarget(self, action: #selector(scrollPan(_:)))
    scroll = nil
  }

  // MARK: Props

  func didUpdateProps() {
    if let t = pendingTheme {
      pendingTheme = nil
      theme = PFTheme.from(t)
      applyTheme()
    }
    if let a = pendingActions {
      pendingActions = nil
      rebuildActions(a)
    }
    if textDirty {
      textDirty = false
      bigTitle.text = titleText
      smallTitle.text = titleText
      bigSubtitle.text = subtitleText
      smallSubtitle.text = subtitleText
      let icon = closeStyle == "back" ? "back" : "close"
      closeButton.setImage(PFIcon.image(icon, size: 18, weight: .semibold), for: .normal)
      closeButton.accessibilityLabel = labels["close"] ?? "Fechar"
      avatarButton.accessibilityLabel = labels["photo"] ?? titleText
    }
    if avatarDirty {
      avatarDirty = false
      avatarView.configure(ref: avatarRef, initials: initials, color: avatarColor, maxPixel: 320)
      badgeView.isHidden = avatarBadge.isEmpty
      badgeIcon.image = PFIcon.image(avatarBadge.isEmpty ? "camera" : avatarBadge, size: 14, weight: .semibold)
      if avatarBusy { badgeSpinner.startAnimating(); badgeIcon.isHidden = true } else { badgeSpinner.stopAnimating(); badgeIcon.isHidden = false }
    }
    setNeedsLayout()
  }

  private func applyTheme() {
    backgroundColor = .clear
    headerBg.backgroundColor = theme.surface
    hairline.backgroundColor = theme.hairline
    closeButton.tintColor = theme.text
    bigTitle.textColor = theme.text
    smallTitle.textColor = theme.text
    bigSubtitle.textColor = theme.secondary
    smallSubtitle.textColor = theme.secondary
    badgeView.backgroundColor = theme.dark ? .white : UIColor(white: 0.07, alpha: 1)
    badgeView.layer.borderColor = theme.surface.cgColor
    badgeIcon.tintColor = theme.dark ? UIColor(white: 0.07, alpha: 1) : .white
    badgeSpinner.color = badgeIcon.tintColor
    for b in actionButtons { styleAction(b) }
  }

  private func styleAction(_ b: PFActionButton) {
    b.backgroundColor = theme.card
    b.layer.borderWidth = 1 / UIScreen.main.scale
    b.layer.borderColor = theme.cardBorder.cgColor
    b.iconView.tintColor = theme.text
    b.label.textColor = theme.text
  }

  private func rebuildActions(_ list: [[String: Any]]) {
    for b in actionButtons { b.removeFromSuperview() }
    actionButtons = []
    for d in list.prefix(5) {
      let b = PFActionButton()
      b.key = pfStr(d["key"])
      b.iconView.image = PFIcon.image(pfStr(d["icon"]), size: 20)
      b.label.text = pfStr(d["label"])
      b.label.font = UIFont.systemFont(ofSize: 12, weight: pfBool(d["active"]) ? .bold : .medium)
      b.accessibilityLabel = pfStr(d["label"])
      b.addTarget(self, action: #selector(actionTapped(_:)), for: .touchUpInside)
      styleAction(b)
      actionsRow.addSubview(b)
      actionButtons.append(b)
    }
  }

  // MARK: Layout

  override func layoutSubviews() {
    super.layoutSubviews()
    contentHost.frame = bounds
    overlay.frame = bounds
    if scroll == nil { attachScrollIfNeeded() }
    applyProgress()
  }

  private var currentOffset: CGFloat {
    guard let s = scroll else { return 0 }
    return s.contentOffset.y + s.adjustedContentInset.top
  }

  private var collapseRange: CGFloat { max(1, expandedHeight - compactHeight) }

  private func applyProgress() {
    let W = bounds.width
    if W <= 0 { return }
    let off = currentOffset
    lastOffset = off
    let range = collapseRange
    let p = max(0, min(1, off / range))
    let stretch = max(0, -off)
    let y0 = topInset
    let barH = max(44, compactHeight - topInset)
    let visibleH = max(compactHeight, expandedHeight - off)

    headerBg.frame = CGRect(x: 0, y: 0, width: W, height: visibleH)
    let hl = 1 / UIScreen.main.scale
    hairline.frame = CGRect(x: 0, y: visibleH - hl, width: W, height: hl)
    hairline.alpha = pfSmooth(0.85, 1, p)
    // O overlay só cobre a área do cabeçalho (o resto é do ScrollView RN).
    overlay.frame = CGRect(x: 0, y: 0, width: W, height: min(bounds.height, visibleH))

    closeButton.frame = CGRect(x: 6, y: y0 + (barH - 44) / 2, width: 44, height: 44)

    // Avatar: 96 → 34, centro → ao lado do X.
    let aExp: CGFloat = 96, aCol: CGFloat = 34
    let expCenter = CGPoint(x: W / 2, y: y0 + 12 + aExp / 2)
    let colCenter = CGPoint(x: 6 + 44 + 8 + aCol / 2, y: y0 + barH / 2)
    var side = pfLerp(aExp, aCol, p)
    var center = CGPoint(x: pfLerp(expCenter.x, colCenter.x, p), y: pfLerp(expCenter.y, colCenter.y, p))
    if stretch > 0 {
      let s = min(1.6, 1 + stretch / 160)
      side = aExp * s
      center.y = expCenter.y + stretch * 0.5
    }
    avatarButton.bounds = CGRect(x: 0, y: 0, width: side, height: side)
    avatarButton.center = center
    avatarView.frame = avatarButton.bounds
    let bs: CGFloat = 34 * max(0.6, side / aExp)
    badgeView.frame = CGRect(x: side - bs + 2, y: side - bs + 2, width: bs, height: bs)
    badgeView.layer.cornerRadius = bs / 2
    badgeIcon.frame = badgeView.bounds
    badgeSpinner.center = CGPoint(x: bs / 2, y: bs / 2)
    badgeView.alpha = 1 - pfSmooth(0.2, 0.6, p)

    // Títulos: o grande vai encolhendo até a posição do pequeno (crossfade no fim).
    let smallX = colCenter.x + aCol / 2 + 10
    let smallW = max(40, W - smallX - 16)
    let hasSub = !subtitleText.isEmpty
    let smallTitleY = hasSub ? y0 + barH / 2 - 19 : y0 + (barH - 22) / 2
    smallTitle.frame = CGRect(x: smallX, y: smallTitleY, width: smallW, height: 22)
    smallSubtitle.frame = CGRect(x: smallX, y: smallTitleY + 21, width: smallW, height: 17)
    smallSubtitle.isHidden = !hasSub

    let bigW = max(40, W - 48)
    let titleFit = min(bigW, ceil(bigTitle.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: 28)).width))
    let subFit = min(bigW, ceil(bigSubtitle.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: 20)).width))
    bigTitle.bounds = CGRect(x: 0, y: 0, width: titleFit, height: 28)
    bigSubtitle.bounds = CGRect(x: 0, y: 0, width: subFit, height: 20)
    let tScale = pfLerp(1, 17.0 / 22.0, p)
    let sScale = pfLerp(1, 13.0 / 15.0, p)
    let titleExp = CGPoint(x: W / 2, y: y0 + 120 + 14 + stretch * 0.8)
    let subExp = CGPoint(x: W / 2, y: y0 + 150 + 10 + stretch * 0.8)
    let titleCol = CGPoint(x: smallX + titleFit * (17.0 / 22.0) / 2, y: smallTitle.frame.midY)
    let subCol = CGPoint(x: smallX + subFit * (13.0 / 15.0) / 2, y: smallSubtitle.frame.midY)
    bigTitle.center = CGPoint(x: pfLerp(titleExp.x, titleCol.x, p), y: pfLerp(titleExp.y, titleCol.y, p))
    bigSubtitle.center = CGPoint(x: pfLerp(subExp.x, subCol.x, p), y: pfLerp(subExp.y, subCol.y, p))
    bigTitle.transform = CGAffineTransform(scaleX: tScale, y: tScale)
    bigSubtitle.transform = CGAffineTransform(scaleX: sScale, y: sScale)
    let cross = pfSmooth(0.72, 0.98, p)
    bigTitle.alpha = 1 - cross
    bigSubtitle.alpha = (1 - cross) * (hasSub ? 1 : 0)
    smallTitle.alpha = cross
    smallSubtitle.alpha = cross

    // Ações: sobem com o conteúdo e somem cedo.
    let n = CGFloat(actionButtons.count)
    actionsRow.isHidden = actionButtons.isEmpty
    if !actionButtons.isEmpty {
      let rowY = y0 + 186 - max(0, off) + stretch * 0.8
      actionsRow.frame = CGRect(x: 0, y: rowY, width: W, height: 62)
      let gap: CGFloat = 8
      let bw = floor((W - 32 - gap * (n - 1)) / n)
      for (i, b) in actionButtons.enumerated() {
        b.bounds = CGRect(x: 0, y: 0, width: bw, height: 62)
        b.center = CGPoint(x: 16 + CGFloat(i) * (bw + gap) + bw / 2, y: 31)
      }
      let a = 1 - min(1, p * 2.2)
      actionsRow.alpha = a
      actionsRow.isUserInteractionEnabled = a > 0.4
      let sc = pfLerp(1, 0.88, min(1, p * 2.2))
      actionsRow.transform = CGAffineTransform(scaleX: sc, y: sc)
    }
    overlay.bringSubviewToFront(closeButton)
  }

  // MARK: Scroll

  private func scrollChanged(_ s: UIScrollView) {
    applyProgress()
    let off = currentOffset
    if s.isTracking {
      let armed = off < -80 && !photos.isEmpty
      if armed != armedForGallery {
        armedForGallery = armed
        if armed { haptic.impactOccurred(intensity: 0.7) }
      }
    }
    if !s.isTracking && !s.isDragging {
      scheduleSnap()
    }
  }

  @objc private func scrollPan(_ g: UIPanGestureRecognizer) {
    switch g.state {
    case .began:
      snapWork?.cancel()
      haptic.prepare()
    case .ended, .cancelled:
      if armedForGallery && currentOffset < -80 && !photos.isEmpty {
        armedForGallery = false
        openGallery(index: 0)
        return
      }
      armedForGallery = false
      scheduleSnap()
    default:
      break
    }
  }

  private func scheduleSnap() {
    snapWork?.cancel()
    let w = DispatchWorkItem { [weak self] in self?.snapIfNeeded() }
    snapWork = w
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: w)
  }

  private func snapIfNeeded() {
    guard let s = scroll, !s.isTracking, !s.isDragging, !s.isDecelerating else { return }
    let off = currentOffset
    let range = collapseRange
    guard off > 0.5 && off < range - 0.5 else { return }
    let maxOff = max(0, s.contentSize.height + s.adjustedContentInset.bottom + s.adjustedContentInset.top - s.bounds.height)
    let target: CGFloat = off / range < 0.5 ? 0 : min(range, maxOff)
    if abs(target - off) < 0.5 { return }
    s.setContentOffset(CGPoint(x: s.contentOffset.x, y: target - s.adjustedContentInset.top), animated: true)
  }

  // MARK: Actions

  @objc private func closeTapped() {
    onClose([:])
  }

  @objc private func actionTapped(_ b: PFActionButton) {
    UISelectionFeedbackGenerator().selectionChanged()
    onAction(["key": b.key])
  }

  @objc private func avatarTapped() {
    if !avatarBadge.isEmpty || photos.isEmpty {
      onAvatarPress([:])
      return
    }
    openGallery(index: 0)
  }

  // MARK: Galeria

  private func openGallery(index: Int) {
    guard gallery == nil, let win = window, !photos.isEmpty else { return }
    let from = avatarButton.convert(avatarButton.bounds, to: win)
    let g = PFGalleryView(photos: photos, placeholder: avatarView.imageView.image, labels: labels)
    g.frame = win.bounds
    g.onDismiss = { [weak self] in
      guard let self = self else { return }
      self.gallery = nil
      self.avatarButton.alpha = 1
      self.onGallery(["open": false])
    }
    g.sourceFrame = { [weak self] in
      guard let self = self, let w = self.window else { return .zero }
      return self.avatarButton.convert(self.avatarButton.bounds, to: w)
    }
    win.addSubview(g)
    gallery = g
    avatarButton.alpha = 0
    g.present(from: from, index: index)
    onGallery(["open": true])
  }
}
