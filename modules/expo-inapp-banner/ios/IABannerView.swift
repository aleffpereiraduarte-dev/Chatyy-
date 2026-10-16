import UIKit

// [2026-10-16 native-toast] Banner nativo (iOS). Ver ChatyyInAppBannerModule.swift.

// MARK: - Opções vindas do JS

struct IABannerOptions {
  var id: String = ""
  var title: String = ""
  var body: String = ""
  var meta: String = ""
  var avatarUrl: String = ""
  var initials: String = ""
  var avatarColor: UIColor = UIColor(white: 0.36, alpha: 1)
  var accent: UIColor = UIColor(red: 0.06, green: 0.73, blue: 0.51, alpha: 1)
  var dark = false
  var urgent = false
  var durationMs: Double = 4000
  var canReply = false
  var replyPlaceholder = ""
  var actionLabel = ""
  var closeLabel = ""
  var announce = true

  init(_ o: [String: Any]) {
    id = IABannerOptions.str(o["id"])
    title = IABannerOptions.str(o["title"])
    body = IABannerOptions.str(o["body"])
    meta = IABannerOptions.str(o["meta"])
    avatarUrl = IABannerOptions.str(o["avatarUrl"])
    initials = IABannerOptions.str(o["initials"])
    if let c = IAColor.parse(o["avatarColor"]) { avatarColor = c }
    if let c = IAColor.parse(o["accent"]) { accent = c }
    dark = (o["dark"] as? Bool) ?? false
    urgent = (o["urgent"] as? Bool) ?? false
    if let d = o["durationMs"] as? Double, d >= 1000 { durationMs = min(d, 15000) }
    else if let d = o["durationMs"] as? Int, d >= 1000 { durationMs = min(Double(d), 15000) }
    canReply = (o["canReply"] as? Bool) ?? false
    replyPlaceholder = IABannerOptions.str(o["replyPlaceholder"])
    actionLabel = IABannerOptions.str(o["actionLabel"])
    closeLabel = IABannerOptions.str(o["closeLabel"])
    if let a = o["announce"] as? Bool { announce = a }
  }

  private static func str(_ v: Any?) -> String {
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return ""
  }
}

enum IAColor {
  /// "#RGB" | "#RRGGBB" | "#RRGGBBAA"
  static func parse(_ v: Any?) -> UIColor? {
    guard var s = v as? String else { return nil }
    s = s.trimmingCharacters(in: .whitespaces)
    if s.hasPrefix("#") { s.removeFirst() }
    if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
    guard s.count == 6 || s.count == 8, let n = UInt64(s, radix: 16) else { return nil }
    let r, g, b, a: CGFloat
    if s.count == 8 {
      r = CGFloat((n >> 24) & 0xff) / 255; g = CGFloat((n >> 16) & 0xff) / 255
      b = CGFloat((n >> 8) & 0xff) / 255; a = CGFloat(n & 0xff) / 255
    } else {
      r = CGFloat((n >> 16) & 0xff) / 255; g = CGFloat((n >> 8) & 0xff) / 255
      b = CGFloat(n & 0xff) / 255; a = 1
    }
    return UIColor(red: r, green: g, blue: b, alpha: a)
  }
}

// MARK: - Avatar (cache em memória)

final class IAAvatarLoader {
  static let shared = IAAvatarLoader()
  private let cache = NSCache<NSString, UIImage>()
  private var waiters: [String: [(UIImage?) -> Void]] = [:]
  private let session: URLSession

  private init() {
    cache.countLimit = 64
    let cfg = URLSessionConfiguration.default
    cfg.timeoutIntervalForRequest = 8
    cfg.requestCachePolicy = .returnCacheDataElseLoad
    session = URLSession(configuration: cfg)
  }

  func cached(_ url: String) -> UIImage? { cache.object(forKey: url as NSString) }

  /// completion na main.
  func load(_ url: String, _ done: @escaping (UIImage?) -> Void) {
    if url.isEmpty { done(nil); return }
    if let img = cache.object(forKey: url as NSString) { done(img); return }
    if waiters[url] != nil { waiters[url]?.append(done); return }
    waiters[url] = [done]
    let finish: (UIImage?) -> Void = { [weak self] img in
      DispatchQueue.main.async {
        guard let self = self else { return }
        if let img = img { self.cache.setObject(img, forKey: url as NSString) }
        let list = self.waiters.removeValue(forKey: url) ?? []
        for cb in list { cb(img) }
      }
    }
    if url.hasPrefix("file://") || url.hasPrefix("/") {
      DispatchQueue.global(qos: .userInitiated).async {
        let path = url.hasPrefix("file://") ? (URL(string: url)?.path ?? "") : url
        finish(IAAvatarLoader.decode(FileManager.default.contents(atPath: path)))
      }
      return
    }
    guard let u = URL(string: url) else { finish(nil); return }
    session.dataTask(with: u) { data, resp, _ in
      if let http = resp as? HTTPURLResponse, http.statusCode >= 400 { finish(nil); return }
      finish(IAAvatarLoader.decode(data))
    }.resume()
  }

  private static func decode(_ data: Data?) -> UIImage? {
    guard let data = data, !data.isEmpty, let img = UIImage(data: data) else { return nil }
    // Pré-decodifica fora da main (sem soluço no 1º frame).
    let side: CGFloat = 120
    let fmt = UIGraphicsImageRendererFormat.default()
    fmt.scale = 1
    let r = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: fmt)
    return r.image { _ in
      let s = img.size
      guard s.width > 0, s.height > 0 else { return }
      let k = max(side / s.width, side / s.height)
      let w = s.width * k, h = s.height * k
      img.draw(in: CGRect(x: (side - w) / 2, y: (side - h) / 2, width: w, height: h))
    }
  }
}

// MARK: - Janela que deixa passar toques fora do banner

final class IAPassthroughWindow: UIWindow {
  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    let v = super.hitTest(point, with: event)
    if v === self || v === rootViewController?.view { return nil }
    return v
  }
}

final class IARootViewController: UIViewController {
  weak var mirror: UIViewController?
  override func loadView() {
    let v = UIView()
    v.backgroundColor = .clear
    view = v
  }
  override var preferredStatusBarStyle: UIStatusBarStyle { mirror?.preferredStatusBarStyle ?? .default }
  override var prefersStatusBarHidden: Bool { mirror?.prefersStatusBarHidden ?? false }
}

// MARK: - Apresentador (um banner por vez)

final class IABannerPresenter: IABannerViewDelegate {
  static let shared = IABannerPresenter()

  var emitter: ((String, [String: Any?]) -> Void)?
  private var window: IAPassthroughWindow?
  private var current: IABannerView?
  private weak var previousKey: UIWindow?
  private var timer: DispatchWorkItem?

  private func activeScene() -> UIWindowScene? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    return scenes.first(where: { $0.activationState == .foregroundActive })
      ?? scenes.first(where: { $0.activationState == .foregroundInactive })
  }

  private func appKeyWindow(_ scene: UIWindowScene) -> UIWindow? {
    return scene.windows.first(where: { $0.isKeyWindow && !($0 is IAPassthroughWindow) })
      ?? scene.windows.first(where: { !($0 is IAPassthroughWindow) })
  }

  func show(_ o: [String: Any]) -> Bool {
    guard let scene = activeScene() else { return false }
    let opts = IABannerOptions(o)
    if opts.title.isEmpty && opts.body.isEmpty { return false }

    let win: IAPassthroughWindow
    if let w = window, w.windowScene === scene {
      win = w
    } else {
      window?.isHidden = true
      let w = IAPassthroughWindow(windowScene: scene)
      w.windowLevel = UIWindow.Level(rawValue: UIWindow.Level.normal.rawValue + 40)
      w.backgroundColor = .clear
      let root = IARootViewController()
      w.rootViewController = root
      window = w
      win = w
    }
    (win.rootViewController as? IARootViewController)?.mirror = appKeyWindow(scene)?.rootViewController
    win.frame = scene.coordinateSpace.bounds
    win.isHidden = false
    guard let host = win.rootViewController?.view else { return false }
    host.frame = win.bounds

    // Banner anterior sai rápido (sem esperar o tempo dele).
    if let old = current {
      current = nil
      cancelTimer()
      old.slideAway(velocity: 0, fast: true) { [weak self] in
        self?.emit("onBannerDismiss", ["id": old.options.id, "reason": "replaced"])
      }
    }

    let v = IABannerView(options: opts)
    v.delegate = self
    host.addSubview(v)
    v.layoutIn(host)
    current = v
    v.present()
    scheduleTimer(opts.durationMs)
    if opts.announce && UIAccessibility.isVoiceOverRunning {
      UIAccessibility.post(notification: .announcement, argument: [opts.title, opts.body].filter { !$0.isEmpty }.joined(separator: ", "))
    }
    return true
  }

  func dismiss(id: String?, reason: String) {
    guard let v = current else { return }
    if let id = id, !id.isEmpty, id != v.options.id { return }
    finish(v, reason: reason, velocity: 0)
  }

  // MARK: timer

  private func scheduleTimer(_ ms: Double) {
    cancelTimer()
    let item = DispatchWorkItem { [weak self] in
      guard let self = self, let v = self.current else { return }
      if v.isExpandedState || v.isDragging { return }
      self.finish(v, reason: "timeout", velocity: 0)
    }
    timer = item
    DispatchQueue.main.asyncAfter(deadline: .now() + ms / 1000, execute: item)
  }

  private func cancelTimer() {
    timer?.cancel()
    timer = nil
  }

  private func finish(_ v: IABannerView, reason: String, velocity: CGFloat) {
    if current === v { current = nil }
    cancelTimer()
    v.endEditingIfNeeded()
    restoreKeyWindow()
    let id = v.options.id
    v.slideAway(velocity: velocity, fast: false) { [weak self] in
      guard let self = self else { return }
      if self.current == nil { self.window?.isHidden = true }
      self.emit("onBannerDismiss", ["id": id, "reason": reason])
    }
  }

  private func restoreKeyWindow() {
    guard let w = window, w.isKeyWindow else { return }
    if let prev = previousKey, !prev.isHidden { prev.makeKey() }
    else if let scene = w.windowScene, let other = appKeyWindow(scene) { other.makeKey() }
    previousKey = nil
  }

  private func emit(_ name: String, _ body: [String: Any?]) {
    emitter?(name, body)
  }

  // MARK: IABannerViewDelegate

  func bannerDidBeginDrag(_ v: IABannerView) {
    if current === v { cancelTimer() }
  }

  func bannerDidCancelDrag(_ v: IABannerView) {
    guard current === v, !v.isExpandedState else { return }
    scheduleTimer(max(1500, v.options.durationMs / 2))
  }

  func bannerDidSwipeAway(_ v: IABannerView, velocity: CGFloat) {
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    finish(v, reason: "swipe", velocity: velocity)
  }

  func bannerDidTap(_ v: IABannerView) {
    guard current === v else { return }
    emit("onBannerPress", ["id": v.options.id])
    finish(v, reason: "press", velocity: 0)
  }

  func bannerDidTapClose(_ v: IABannerView) {
    finish(v, reason: "close", velocity: 0)
  }

  func bannerWillExpand(_ v: IABannerView) {
    guard current === v, let w = window else { return }
    cancelTimer()
    if !w.isKeyWindow {
      if let scene = w.windowScene { previousKey = appKeyWindow(scene) }
      w.makeKey()
    }
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    emit("onBannerExpand", ["id": v.options.id])
  }

  func bannerDidSendReply(_ v: IABannerView, text: String) {
    guard current === v else { return }
    emit("onBannerReply", ["id": v.options.id, "text": text])
    finish(v, reason: "reply", velocity: 0)
  }
}

// MARK: - View do banner

protocol IABannerViewDelegate: AnyObject {
  func bannerDidBeginDrag(_ v: IABannerView)
  func bannerDidCancelDrag(_ v: IABannerView)
  func bannerDidSwipeAway(_ v: IABannerView, velocity: CGFloat)
  func bannerDidTap(_ v: IABannerView)
  func bannerDidTapClose(_ v: IABannerView)
  func bannerWillExpand(_ v: IABannerView)
  func bannerDidSendReply(_ v: IABannerView, text: String)
}

final class IABannerView: UIView, UIGestureRecognizerDelegate, UITextFieldDelegate {
  let options: IABannerOptions
  weak var delegate: IABannerViewDelegate?

  private(set) var isExpandedState = false
  private(set) var isDragging = false
  private var leaving = false

  private let blurView: UIVisualEffectView
  private let avatarView = UIImageView()
  private let initialsLabel = UILabel()
  private let nameLabel = UILabel()
  private let metaLabel = UILabel()
  private let previewLabel = UILabel()
  private let grabberView = UIView()
  private let actionButton = UIButton(type: .system)
  private let replyContainer = UIView()
  private let replyField = UITextField()
  private let sendButton = UIButton(type: .system)

  private let pad: CGFloat = 12
  private let avatarSide: CGFloat = 40
  private let replyHeight: CGFloat = 40
  private var bannerWidth: CGFloat = 0

  init(options: IABannerOptions) {
    self.options = options
    let style: UIBlurEffect.Style = options.dark ? .systemThickMaterialDark : .systemThickMaterialLight
    blurView = UIVisualEffectView(effect: UIBlurEffect(style: style))
    super.init(frame: .zero)
    buildViews()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private var textColor: UIColor { options.dark ? UIColor(white: 0.97, alpha: 1) : UIColor(white: 0.07, alpha: 1) }
  private var secondaryColor: UIColor { options.dark ? UIColor(white: 0.75, alpha: 1) : UIColor(white: 0.32, alpha: 1) }

  private func buildViews() {
    backgroundColor = .clear
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = options.dark ? 0.38 : 0.16
    layer.shadowRadius = 18
    layer.shadowOffset = CGSize(width: 0, height: 8)

    blurView.layer.cornerRadius = 24
    if #available(iOS 13.0, *) { blurView.layer.cornerCurve = .continuous }
    blurView.clipsToBounds = true
    if options.urgent {
      blurView.layer.borderWidth = 1.5
      blurView.layer.borderColor = UIColor(red: 0.86, green: 0.15, blue: 0.15, alpha: 1).cgColor
    } else {
      blurView.layer.borderWidth = 0.5
      blurView.layer.borderColor = (options.dark ? UIColor(white: 1, alpha: 0.08) : UIColor(white: 0, alpha: 0.06)).cgColor
    }
    addSubview(blurView)
    let content = blurView.contentView

    avatarView.backgroundColor = options.avatarColor
    avatarView.contentMode = .scaleAspectFill
    avatarView.clipsToBounds = true
    avatarView.layer.cornerRadius = avatarSide / 2
    content.addSubview(avatarView)

    initialsLabel.text = options.initials.isEmpty ? "?" : options.initials
    initialsLabel.textColor = .white
    initialsLabel.font = .systemFont(ofSize: 15, weight: .bold)
    initialsLabel.textAlignment = .center
    avatarView.addSubview(initialsLabel)

    if !options.avatarUrl.isEmpty {
      if let img = IAAvatarLoader.shared.cached(options.avatarUrl) {
        setAvatar(img, animated: false)
      } else {
        let url = options.avatarUrl
        IAAvatarLoader.shared.load(url) { [weak self] img in
          guard let self = self, let img = img, self.options.avatarUrl == url else { return }
          self.setAvatar(img, animated: true)
        }
      }
    }

    nameLabel.text = options.title
    nameLabel.font = .systemFont(ofSize: 15, weight: .semibold)
    nameLabel.textColor = textColor
    nameLabel.numberOfLines = 1
    content.addSubview(nameLabel)

    metaLabel.text = options.meta
    metaLabel.font = .systemFont(ofSize: 12, weight: .regular)
    metaLabel.textColor = secondaryColor
    metaLabel.numberOfLines = 1
    content.addSubview(metaLabel)

    previewLabel.text = options.body
    previewLabel.font = .systemFont(ofSize: 14.5, weight: .regular)
    previewLabel.textColor = secondaryColor
    previewLabel.numberOfLines = 2
    content.addSubview(previewLabel)

    grabberView.backgroundColor = options.dark ? UIColor(white: 1, alpha: 0.22) : UIColor(white: 0, alpha: 0.14)
    grabberView.layer.cornerRadius = 2.5
    grabberView.isHidden = !options.canReply
    content.addSubview(grabberView)

    if !options.actionLabel.isEmpty {
      actionButton.setTitle(options.actionLabel.uppercased(), for: .normal)
      actionButton.titleLabel?.font = .systemFont(ofSize: 12, weight: .heavy)
      actionButton.setTitleColor(.white, for: .normal)
      actionButton.backgroundColor = options.accent
      actionButton.layer.cornerRadius = 13
      actionButton.contentEdgeInsets = UIEdgeInsets(top: 6, left: 12, bottom: 6, right: 12)
      actionButton.addTarget(self, action: #selector(onActionTap), for: .touchUpInside)
      content.addSubview(actionButton)
    }

    replyContainer.isHidden = true
    replyContainer.alpha = 0
    content.addSubview(replyContainer)

    replyField.placeholder = options.replyPlaceholder
    replyField.font = .systemFont(ofSize: 15)
    replyField.textColor = textColor
    replyField.tintColor = options.accent
    replyField.backgroundColor = options.dark ? UIColor(white: 1, alpha: 0.10) : UIColor(white: 0, alpha: 0.05)
    replyField.layer.cornerRadius = replyHeight / 2
    replyField.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 14, height: 10))
    replyField.leftViewMode = .always
    replyField.returnKeyType = .send
    replyField.enablesReturnKeyAutomatically = true
    replyField.delegate = self
    replyField.keyboardAppearance = options.dark ? .dark : .light
    replyField.addTarget(self, action: #selector(onReplyChanged), for: .editingChanged)
    if !options.replyPlaceholder.isEmpty {
      replyField.attributedPlaceholder = NSAttributedString(string: options.replyPlaceholder,
        attributes: [.foregroundColor: secondaryColor.withAlphaComponent(0.8)])
    }
    replyContainer.addSubview(replyField)

    let cfg = UIImage.SymbolConfiguration(pointSize: 30, weight: .semibold)
    sendButton.setImage(UIImage(systemName: "arrow.up.circle.fill", withConfiguration: cfg), for: .normal)
    sendButton.tintColor = options.accent
    sendButton.isEnabled = false
    sendButton.accessibilityLabel = options.replyPlaceholder
    sendButton.addTarget(self, action: #selector(onSendTap), for: .touchUpInside)
    replyContainer.addSubview(sendButton)

    let pan = UIPanGestureRecognizer(target: self, action: #selector(onPan(_:)))
    pan.delegate = self
    addGestureRecognizer(pan)
    let tap = UITapGestureRecognizer(target: self, action: #selector(onTap))
    tap.delegate = self
    addGestureRecognizer(tap)

    isAccessibilityElement = false
    blurView.accessibilityViewIsModal = false
    nameLabel.accessibilityTraits = [.button, .header]
    let close = UIAccessibilityCustomAction(name: options.closeLabel.isEmpty ? "Close" : options.closeLabel,
                                            target: self, selector: #selector(onA11yClose))
    nameLabel.accessibilityCustomActions = [close]
    previewLabel.accessibilityCustomActions = [close]
  }

  private func setAvatar(_ img: UIImage, animated: Bool) {
    let apply = {
      self.avatarView.image = img
      self.initialsLabel.isHidden = true
    }
    if animated {
      UIView.transition(with: avatarView, duration: 0.18, options: [.transitionCrossDissolve, .allowUserInteraction], animations: apply)
    } else {
      apply()
    }
  }

  // MARK: layout

  func layoutIn(_ host: UIView) {
    let hw = host.bounds.width
    bannerWidth = min(hw - 16, 520)
    let h = measuredHeight()
    // Janela recém-mostrada: a área segura da VIEW ainda pode estar zerada; a da
    // janela já vale (Dynamic Island / notch).
    let safeTop = max(host.window?.safeAreaInsets.top ?? 0, host.safeAreaInsets.top)
    let top = max(safeTop, 20) + 4
    frame = CGRect(x: (hw - bannerWidth) / 2, y: top, width: bannerWidth, height: h)
    setNeedsLayout()
    layoutIfNeeded()
  }

  private func textWidth() -> CGFloat {
    var w = bannerWidth - pad - avatarSide - 10 - pad
    if !options.actionLabel.isEmpty {
      let s = actionButton.sizeThatFits(CGSize(width: 200, height: 40))
      w -= s.width + 8
    }
    return max(60, w)
  }

  private func previewHeight() -> CGFloat {
    let lines: CGFloat = isExpandedState ? 6 : 2
    let maxH = ceil(previewLabel.font.lineHeight * lines)
    if (options.body).isEmpty { return 0 }
    let s = previewLabel.sizeThatFits(CGSize(width: textWidth(), height: .greatestFiniteMagnitude))
    return min(ceil(s.height), maxH)
  }

  private func measuredHeight() -> CGFloat {
    let nameH = ceil(nameLabel.font.lineHeight)
    let pv = previewHeight()
    let textH = nameH + (pv > 0 ? 2 + pv : 0)
    var h = pad + max(avatarSide, textH) + pad
    if options.canReply { h += 6 } // grabber
    if isExpandedState { h += replyHeight + 8 }
    return h
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = bounds
    blurView.frame = b
    layer.shadowPath = UIBezierPath(roundedRect: b, cornerRadius: 24).cgPath

    avatarView.frame = CGRect(x: pad, y: pad, width: avatarSide, height: avatarSide)
    initialsLabel.frame = avatarView.bounds

    let tx = pad + avatarSide + 10
    let tw = textWidth()
    let nameH = ceil(nameLabel.font.lineHeight)
    let metaW = min(ceil(metaLabel.sizeThatFits(CGSize(width: 120, height: nameH)).width), 120)
    let pv = previewHeight()
    let textH = nameH + (pv > 0 ? 2 + pv : 0)
    let ty = pad + max(0, (avatarSide - textH) / 2)
    nameLabel.frame = CGRect(x: tx, y: ty, width: max(20, tw - metaW - 6), height: nameH)
    metaLabel.frame = CGRect(x: tx + tw - metaW, y: ty + 1, width: metaW, height: nameH)
    previewLabel.numberOfLines = isExpandedState ? 6 : 2
    previewLabel.frame = CGRect(x: tx, y: ty + nameH + 2, width: tw, height: pv)

    if !options.actionLabel.isEmpty {
      let s = actionButton.sizeThatFits(CGSize(width: 200, height: 40))
      actionButton.frame = CGRect(x: b.width - pad - s.width, y: pad + (avatarSide - 28) / 2, width: s.width, height: 28)
      actionButton.layer.cornerRadius = 14
    }

    let contentBottom = pad + max(avatarSide, textH)
    if isExpandedState {
      replyContainer.frame = CGRect(x: pad, y: contentBottom + 8, width: b.width - pad * 2, height: replyHeight)
      sendButton.frame = CGRect(x: replyContainer.bounds.width - 36, y: (replyHeight - 36) / 2, width: 36, height: 36)
      replyField.frame = CGRect(x: 0, y: 0, width: replyContainer.bounds.width - 42, height: replyHeight)
    } else {
      replyContainer.frame = CGRect(x: pad, y: contentBottom, width: b.width - pad * 2, height: replyHeight)
    }
    grabberView.frame = CGRect(x: (b.width - 36) / 2, y: b.height - 9, width: 36, height: 5)
  }

  // MARK: animations (molas UIKit — rodam no render server)

  // `frame` inclui o transform (arrasto) → usa center/bounds (geometria sem transform).
  private func offscreenY() -> CGFloat { -(center.y + bounds.height / 2 + 40) }

  func present() {
    transform = CGAffineTransform(translationX: 0, y: offscreenY())
    UIView.animate(withDuration: 0.55, delay: 0, usingSpringWithDamping: 0.82, initialSpringVelocity: 0.2,
                   options: [.allowUserInteraction, .beginFromCurrentState, .curveEaseOut]) {
      self.transform = .identity
    }
  }

  func slideAway(velocity: CGFloat, fast: Bool, completion: @escaping () -> Void) {
    if leaving { return }
    leaving = true
    isUserInteractionEnabled = false
    let dist = abs(offscreenY() - transform.ty)
    let v = dist > 0 ? min(8, abs(velocity) / dist) : 0
    UIView.animate(withDuration: fast ? 0.22 : 0.36, delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: v,
                   options: [.beginFromCurrentState, .curveEaseIn]) {
      self.transform = CGAffineTransform(translationX: 0, y: self.offscreenY())
      if fast { self.alpha = 0 }
    } completion: { _ in
      self.removeFromSuperview()
      completion()
    }
  }

  private func snapBack(velocity: CGFloat) {
    let dist = abs(transform.ty)
    let v = dist > 0 ? min(8, abs(velocity) / dist) : 0
    UIView.animate(withDuration: 0.42, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: v,
                   options: [.allowUserInteraction, .beginFromCurrentState]) {
      self.transform = .identity
    }
  }

  private func expand() {
    guard options.canReply, !isExpandedState, let host = superview else { return }
    delegate?.bannerWillExpand(self)
    isExpandedState = true
    replyContainer.isHidden = false
    let newH = measuredHeight()
    UIView.animate(withDuration: 0.45, delay: 0, usingSpringWithDamping: 0.86, initialSpringVelocity: 0,
                   options: [.allowUserInteraction, .beginFromCurrentState]) {
      self.transform = .identity
      var f = self.frame
      f.size.height = newH
      f.origin.x = (host.bounds.width - self.bannerWidth) / 2
      self.bounds = CGRect(origin: .zero, size: f.size)
      self.center = CGPoint(x: f.midX, y: f.origin.y + newH / 2)
      self.replyContainer.alpha = 1
      self.grabberView.alpha = 0
      self.layoutIfNeeded()
    }
    replyField.becomeFirstResponder()
  }

  func endEditingIfNeeded() {
    if replyField.isFirstResponder { replyField.resignFirstResponder() }
  }

  // MARK: gestures

  private func rubber(_ d: CGFloat) -> CGFloat {
    let limit: CGFloat = 70
    return limit * (1 - 1 / (d / limit * 0.6 + 1))
  }

  @objc private func onPan(_ g: UIPanGestureRecognizer) {
    guard !leaving else { return }
    let t = g.translation(in: superview).y
    switch g.state {
    case .began:
      isDragging = true
      delegate?.bannerDidBeginDrag(self)
    case .changed:
      let y = t < 0 ? t : rubber(t)
      transform = CGAffineTransform(translationX: 0, y: y)
    case .ended, .cancelled, .failed:
      isDragging = false
      let v = g.velocity(in: superview).y
      if g.state == .ended && (t < -32 || v < -450) {
        delegate?.bannerDidSwipeAway(self, velocity: v)
      } else if g.state == .ended && options.canReply && !isExpandedState && (t > 40 || v > 650) {
        expand()
      } else {
        snapBack(velocity: v)
        delegate?.bannerDidCancelDrag(self)
      }
    default:
      break
    }
  }

  @objc private func onTap() {
    guard !leaving else { return }
    delegate?.bannerDidTap(self)
  }

  @objc private func onActionTap() {
    guard !leaving else { return }
    delegate?.bannerDidTap(self)
  }

  @objc private func onA11yClose() -> Bool {
    delegate?.bannerDidTapClose(self)
    return true
  }

  @objc private func onReplyChanged() {
    let has = !(replyField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    sendButton.isEnabled = has
  }

  @objc private func onSendTap() { sendReply() }

  private func sendReply() {
    let text = (replyField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !leaving else { return }
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    delegate?.bannerDidSendReply(self, text: text)
  }

  func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    sendReply()
    return false
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    var v: UIView? = touch.view
    while let cur = v, cur !== self {
      if cur is UIControl { return gestureRecognizer is UIPanGestureRecognizer && !(cur is UITextField) }
      v = cur.superview
    }
    return true
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
    return false
  }
}
