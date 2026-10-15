import ExpoModulesCore
import UIKit
import QuartzCore

// [2026-10-15 native-live] Palco NATIVO do visualizador de live.
//
// Filhos RN = os tiles de vídeo do LiveKit (VideoView nativo do WebRTC). Por
// cima/ao redor, tudo nativo:
//   • swipe vertical entre lives (Reels): arraste interativo com a prévia da
//     próxima/anterior (pôster borrado + avatar + nome) entrando pela borda;
//     passou do limiar → anima até o fim e emite onSwipe (o JS troca a rota);
//   • toque = coração no ponto; 2º toque < 280 ms = "love bomb" radial;
//     corações remotos (spawnHearts) e presentes (playGift) — Core Animation
//     com as imagens do motor de efeitos (CEImages);
//   • botão de mudo nativo (o JS aplica nas trilhas de áudio).
// O chat da live continua JS, como irmão por cima deste palco (box-none).
final class ChatyyLiveStageView: ExpoView, UIGestureRecognizerDelegate {
  let onSwipe = EventDispatcher()
  let onStageTap = EventDispatcher()
  let onMuteToggle = EventDispatcher()

  private let peekNextView = LSPeekView()
  private let peekPrevView = LSPeekView()
  private let contentHost = UIView()
  private let fxView = UIView()
  private let muteButton = UIButton(type: .system)

  private var hasNext = false
  private var hasPrev = false
  private var swipeEnabled = true
  private var tapHearts = true
  private var heartColors: [UIColor] = ChatyyLiveStageView.defaultColors
  private var muted = false
  private var showMute = false
  private var controlsTop: CGFloat = 100
  private var labels: [String: String] = [:]

  private var offset: CGFloat = 0
  private var committed = false
  private var lastTapAt: CFTimeInterval = 0
  private var liveHearts: [CALayer] = []

  private var giftQueue: [[String: Any]] = []
  private var giftPlaying = false

  static let defaultColors: [UIColor] = [0xFF4D6D, 0xFF7EB9, 0xFF006E, 0xC70039, 0xEF4444].map { ceColor(UInt32($0)) }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = UIColor(red: 0.06, green: 0.06, blue: 0.1, alpha: 1)

    peekNextView.isHidden = true
    peekPrevView.isHidden = true
    addSubview(peekNextView)
    addSubview(peekPrevView)

    contentHost.backgroundColor = .clear
    addSubview(contentHost)

    fxView.isUserInteractionEnabled = false
    fxView.backgroundColor = .clear
    fxView.accessibilityElementsHidden = true
    addSubview(fxView)

    muteButton.tintColor = .white
    muteButton.backgroundColor = UIColor(white: 0, alpha: 0.35)
    muteButton.layer.cornerRadius = 20
    muteButton.isHidden = true
    muteButton.addTarget(self, action: #selector(onMute), for: .touchUpInside)
    addSubview(muteButton)
    refreshMute()

    let pan = UIPanGestureRecognizer(target: self, action: #selector(onPan(_:)))
    pan.delegate = self
    pan.maximumNumberOfTouches = 1
    addGestureRecognizer(pan)

    let tap = UITapGestureRecognizer(target: self, action: #selector(onTap(_:)))
    tap.cancelsTouchesInView = false
    tap.delegate = self
    addGestureRecognizer(tap)
  }

  // MARK: Fabric children

  override func mountChildComponentView(_ childComponentView: UIView, index: Int) {
    contentHost.insertSubview(childComponentView, at: min(index, contentHost.subviews.count))
  }

  override func unmountChildComponentView(_ childComponentView: UIView, index: Int) {
    childComponentView.removeFromSuperview()
  }

  // MARK: layout

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = bounds
    contentHost.bounds = CGRect(origin: .zero, size: b.size)
    contentHost.center = CGPoint(x: b.midX, y: b.midY)
    fxView.frame = b
    peekNextView.bounds = CGRect(origin: .zero, size: b.size)
    peekPrevView.bounds = CGRect(origin: .zero, size: b.size)
    applyOffset()
    muteButton.frame = CGRect(x: 12, y: controlsTop, width: 40, height: 40)
    bringSubviewToFront(muteButton)
  }

  private func applyOffset() {
    let b = bounds
    contentHost.transform = CGAffineTransform(translationX: 0, y: offset)
    peekNextView.center = CGPoint(x: b.midX, y: b.midY + b.height + offset)
    peekPrevView.center = CGPoint(x: b.midX, y: b.midY - b.height + offset)
    peekNextView.isHidden = !(hasNext && offset < 0)
    peekPrevView.isHidden = !(hasPrev && offset > 0)
  }

  // MARK: props

  func setPeekNext(_ v: [String: Any]?) {
    hasNext = v != nil
    peekNextView.configure(v)
    if !committed { applyOffset() }
  }

  func setPeekPrev(_ v: [String: Any]?) {
    hasPrev = v != nil
    peekPrevView.configure(v)
    if !committed { applyOffset() }
  }

  func setSwipeEnabled(_ v: Bool?) { swipeEnabled = v ?? true }
  func setTapHearts(_ v: Bool?) { tapHearts = v ?? true }

  func setHeartColors(_ v: [String]?) {
    let cs = (v ?? []).compactMap { LSColor.hex($0) }
    heartColors = cs.isEmpty ? ChatyyLiveStageView.defaultColors : cs
  }

  func setMuted(_ v: Bool?) { muted = v ?? false; refreshMute() }
  func setShowMute(_ v: Bool?) { showMute = v ?? false; muteButton.isHidden = !showMute }
  func setControlsTop(_ v: Double?) { controlsTop = CGFloat(v ?? 100); setNeedsLayout() }

  func setLabels(_ v: [String: Any]?) {
    var l: [String: String] = [:]
    for (k, x) in v ?? [:] { if let s = x as? String { l[k] = s } }
    labels = l
    peekNextView.hint = l["next"]
    peekPrevView.hint = l["prev"]
    refreshMute()
  }

  private func refreshMute() {
    let cfg = UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold)
    muteButton.setImage(UIImage(systemName: muted ? "speaker.slash.fill" : "speaker.wave.2.fill", withConfiguration: cfg), for: .normal)
    muteButton.accessibilityLabel = muted ? (labels["unmute"] ?? "Ativar som") : (labels["mute"] ?? "Silenciar")
  }

  @objc private func onMute() {
    muted.toggle()
    refreshMute()
    UISelectionFeedbackGenerator().selectionChanged()
    onMuteToggle(["muted": muted])
  }

  // MARK: gestos

  override func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
    if let pan = g as? UIPanGestureRecognizer, pan.view === self {
      guard swipeEnabled, !committed else { return false }
      let v = pan.velocity(in: self)
      guard abs(v.y) > abs(v.x) * 1.3 else { return false }
      return v.y < 0 ? hasNext : hasPrev
    }
    if g is UITapGestureRecognizer, g.view === self {
      if let b = muteButton.isHidden ? nil : muteButton, b.frame.contains(g.location(in: self)) { return false }
      return tapHearts && !committed
    }
    return true
  }

  func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
    // o toque de corações convive com o toque do RN (Pressable dos tiles)
    return g is UITapGestureRecognizer
  }

  /// Cancela o toque JS em andamento (o arraste agora é nosso).
  private func cancelReactTouches() {
    var v: UIView? = superview
    while let cur = v {
      for r in cur.gestureRecognizers ?? [] where String(describing: type(of: r)).contains("TouchHandler") {
        r.isEnabled = false
        r.isEnabled = true
      }
      v = cur.superview
    }
  }

  @objc private func onPan(_ g: UIPanGestureRecognizer) {
    let H = max(1, bounds.height)
    switch g.state {
    case .began:
      cancelReactTouches()
    case .changed:
      var dy = g.translation(in: self).y
      if (dy < 0 && !hasNext) || (dy > 0 && !hasPrev) { dy *= 0.2 }
      offset = max(-H, min(H, dy))
      applyOffset()
    case .ended, .cancelled, .failed:
      let v = g.velocity(in: self).y
      let dy = offset
      if g.state == .ended && hasNext && (dy < -H * 0.18 || (v < -800 && dy < 0)) {
        commit(next: true)
      } else if g.state == .ended && hasPrev && (dy > H * 0.18 || (v > 800 && dy > 0)) {
        commit(next: false)
      } else {
        settle()
      }
    default:
      break
    }
  }

  private func commit(next: Bool) {
    committed = true
    let H = bounds.height
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    UIView.animate(withDuration: 0.22, delay: 0, options: [.curveEaseOut, .beginFromCurrentState], animations: {
      self.offset = next ? -H : H
      self.applyOffset()
    }, completion: { _ in
      self.onSwipe(["direction": next ? "next" : "prev"])
    })
  }

  private func settle() {
    UIView.animate(withDuration: 0.35, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0.3, options: [.beginFromCurrentState, .allowUserInteraction], animations: {
      self.offset = 0
      self.applyOffset()
    }, completion: nil)
  }

  func resetSwipe() {
    committed = false
    settle()
  }

  @objc private func onTap(_ g: UITapGestureRecognizer) {
    guard g.state == .ended, tapHearts, !committed else { return }
    let p = g.location(in: self)
    let now = CACurrentMediaTime()
    let isDouble = now - lastTapAt < 0.28
    lastTapAt = isDouble ? 0 : now
    let color = heartColors.randomElement() ?? ChatyyLiveStageView.defaultColors[0]
    if isDouble {
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
      spawnBurst(at: p)
    }
    spawnHeart(x: p.x, y: p.y, color: color, emoji: nil)
    onStageTap(["x": Double(p.x), "y": Double(p.y), "color": LSColor.hexString(color), "double": isDouble])
  }

  // MARK: corações

  private var reduceMotion: Bool { return UIAccessibility.isReduceMotionEnabled }

  func spawnHearts(_ items: [[String: Any]]) {
    for (i, it) in items.prefix(30).enumerated() {
      let x = (it["x"] as? NSNumber).map { CGFloat($0.doubleValue) }
      let y = (it["y"] as? NSNumber).map { CGFloat($0.doubleValue) }
      let c = LSColor.hex(it["color"] as? String)
      let e = (it["emoji"] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(8)) }
      if i == 0 {
        spawnHeart(x: x, y: y, color: c, emoji: e)
      } else {
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(i) * 0.09) { [weak self] in
          self?.spawnHeart(x: x, y: y, color: c, emoji: e)
        }
      }
    }
  }

  func spawnHeart(x: CGFloat?, y: CGFloat?, color: UIColor?, emoji: String?) {
    guard !reduceMotion, bounds.width > 0 else { return }
    let W = bounds.width, H = bounds.height
    let x0 = x ?? (W - 56 + ceRand(-12, 12))
    let y0 = y ?? (H * 0.62 + ceRand(-15, 15))
    let size: CGFloat = emoji != nil ? 30 : ceRand(14, 22)
    let img: CGImage? = emoji.map { CEImages.emoji($0, 64) } ?? CEImages.heart(color ?? heartColors.randomElement() ?? .red, 64)
    let l = CALayer()
    l.contents = img
    l.contentsGravity = .resizeAspect
    l.contentsScale = window?.screen.scale ?? UIScreen.main.scale
    l.bounds = CGRect(x: 0, y: 0, width: size, height: size)
    l.position = CGPoint(x: x0, y: y0)
    l.opacity = 0
    let tilt = ceRand(-12, 12) * .pi / 180

    if liveHearts.count >= 40, let old = liveHearts.first {
      old.removeFromSuperlayer()
      liveHearts.removeFirst()
    }
    liveHearts.append(l)
    fxView.layer.addSublayer(l)

    let dur = ceRandD(1.6, 2.6)
    let rise = ceRand(220, 360)
    let drift = ceRand(-55, 55)
    let phase = ceRand(0, .pi)
    var pts: [NSValue] = []
    let steps = 12
    for i in 0...steps {
      let p = CGFloat(i) / CGFloat(steps)
      let px = x0 + drift * sin(phase + p * .pi * 1.5) - drift * sin(phase)
      pts.append(NSValue(cgPoint: CGPoint(x: px, y: y0 - rise * p)))
    }
    let pos = CAKeyframeAnimation(keyPath: "position")
    pos.values = pts
    pos.calculationMode = .cubic
    let op = CAKeyframeAnimation(keyPath: "opacity")
    op.values = [0, 1, 1, 0]
    op.keyTimes = [0, 0.08, 0.6, 1]
    let sc = CAKeyframeAnimation(keyPath: "transform.scale")
    let popT = min(1, 0.35 / dur)
    sc.values = [0.4, 1.1, 1, 1]
    sc.keyTimes = [0, NSNumber(value: popT * 0.6), NSNumber(value: popT), 1]
    let rot = CABasicAnimation(keyPath: "transform.rotation.z")
    rot.fromValue = 0
    rot.toValue = tilt
    let g = CAAnimationGroup()
    g.animations = [pos, op, sc, rot]
    g.duration = dur
    g.timingFunction = CAMediaTimingFunction(name: .easeOut)
    g.fillMode = .forwards
    g.isRemovedOnCompletion = false
    if #available(iOS 15.0, *) { g.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120) }
    CATransaction.begin()
    CATransaction.setCompletionBlock { [weak self, weak l] in
      guard let l = l else { return }
      l.removeFromSuperlayer()
      self?.liveHearts.removeAll { $0 === l }
    }
    l.add(g, forKey: "rise")
    CATransaction.commit()
  }

  func spawnBurst(at p: CGPoint?) {
    guard !reduceMotion, bounds.width > 0 else { return }
    let c = p ?? CGPoint(x: bounds.width / 2, y: bounds.height * 0.45)
    for i in 0..<8 {
      let ang = CGFloat.pi * 2 * CGFloat(i) / 8 + ceRand(0, 0.3)
      let dist = ceRand(90, 150)
      let color = heartColors[i % heartColors.count]
      let l = CALayer()
      l.contents = CEImages.heart(color, 64)
      l.contentsScale = window?.screen.scale ?? UIScreen.main.scale
      l.bounds = CGRect(x: 0, y: 0, width: 26, height: 26)
      l.position = c
      l.opacity = 0
      fxView.layer.addSublayer(l)
      let pos = CABasicAnimation(keyPath: "position")
      pos.fromValue = NSValue(cgPoint: c)
      pos.toValue = NSValue(cgPoint: CGPoint(x: c.x + cos(ang) * dist, y: c.y + sin(ang) * dist))
      let sc = CABasicAnimation(keyPath: "transform.scale")
      sc.fromValue = 0.5
      sc.toValue = 1.3
      let op = CAKeyframeAnimation(keyPath: "opacity")
      op.values = [1, 1, 0]
      op.keyTimes = [0, 0.5, 1]
      let g = CAAnimationGroup()
      g.animations = [pos, sc, op]
      g.duration = 0.9
      g.timingFunction = CEEase.outCubic
      g.fillMode = .forwards
      g.isRemovedOnCompletion = false
      CATransaction.begin()
      CATransaction.setCompletionBlock { [weak l] in l?.removeFromSuperlayer() }
      l.add(g, forKey: "burst")
      CATransaction.commit()
    }
  }

  // MARK: presentes

  func playGift(_ opts: [String: Any]) {
    if giftQueue.count >= 10 { giftQueue.removeFirst() }
    giftQueue.append(opts)
    if !giftPlaying { nextGift() }
  }

  private func nextGift() {
    guard !giftQueue.isEmpty else { giftPlaying = false; return }
    giftPlaying = true
    let g = giftQueue.removeFirst()
    if reduceMotion || bounds.width <= 0 {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.nextGift() }
      return
    }
    let kind = (g["kind"] as? String) ?? "heart"
    let color = LSColor.hex(g["color"] as? String) ?? LSGift.color(kind)
    let title = (g["title"] as? String) ?? ""
    let subtitle = (g["subtitle"] as? String) ?? ""
    let count = (g["count"] as? NSNumber)?.intValue ?? 1

    let W = bounds.width, H = bounds.height
    let center = CGPoint(x: W / 2, y: H * 0.42)
    let scale = window?.screen.scale ?? UIScreen.main.scale
    let host = CALayer()
    host.frame = bounds
    fxView.layer.addSublayer(host)

    // halo
    let halo = CALayer()
    halo.contents = CEImages.softDot(color.withAlphaComponent(0.35), 240)
    halo.contentsScale = scale
    halo.bounds = CGRect(x: 0, y: 0, width: 220, height: 220)
    halo.position = center
    host.addSublayer(halo)
    let hp = CABasicAnimation(keyPath: "transform.scale")
    hp.fromValue = 0.85
    hp.toValue = 1.12
    hp.duration = 0.6
    hp.autoreverses = true
    hp.repeatCount = 2
    halo.add(hp, forKey: "pulse")

    // glifo
    let glyph = CALayer()
    glyph.contents = LSGift.image(kind, color: color, size: 240)
    glyph.contentsScale = scale
    glyph.bounds = CGRect(x: 0, y: 0, width: 120, height: 120)
    glyph.position = center
    host.addSublayer(glyph)
    let pop = CAKeyframeAnimation(keyPath: "transform.scale")
    pop.values = [0.2, 1.2, 1]
    pop.keyTimes = [0, 0.6, 1]
    pop.duration = 0.45
    pop.timingFunction = CEEase.outCubic
    glyph.add(pop, forKey: "pop")
    let fl = CABasicAnimation(keyPath: "position.y")
    fl.fromValue = center.y
    fl.toValue = center.y - 8
    fl.beginTime = CACurrentMediaTime() + 0.45
    fl.duration = 0.8
    fl.autoreverses = true
    fl.repeatCount = 1
    fl.timingFunction = CEEase.inOut
    glyph.add(fl, forKey: "float")

    // faíscas
    for i in 0..<16 {
      let ang = CGFloat.pi * 2 * CGFloat(i) / 16 + ceRand(0, 0.2)
      let dist = ceRand(90, 150)
      let s = CALayer()
      s.contents = CEImages.glowDot(i % 2 == 0 ? color : UIColor.white, 24)
      s.contentsScale = scale
      s.bounds = CGRect(x: 0, y: 0, width: 12, height: 12)
      s.position = center
      s.opacity = 0
      host.addSublayer(s)
      let pos = CABasicAnimation(keyPath: "position")
      pos.fromValue = NSValue(cgPoint: center)
      pos.toValue = NSValue(cgPoint: CGPoint(x: center.x + cos(ang) * dist, y: center.y + sin(ang) * dist))
      let op = CAKeyframeAnimation(keyPath: "opacity")
      op.values = [1, 1, 0]
      op.keyTimes = [0, 0.4, 1]
      let gr = CAAnimationGroup()
      gr.animations = [pos, op]
      gr.beginTime = CACurrentMediaTime() + 0.2
      gr.duration = 0.8
      gr.timingFunction = CEEase.outCubic
      gr.fillMode = .both
      gr.isRemovedOnCompletion = false
      s.add(gr, forKey: "spark")
    }

    // chip
    var chip: UIView? = nil
    if !title.isEmpty || !subtitle.isEmpty || count > 1 {
      let v = UIView()
      v.backgroundColor = UIColor(white: 0, alpha: 0.6)
      v.layer.cornerRadius = 16
      v.isUserInteractionEnabled = false
      let t = UILabel()
      t.text = title + (count > 1 ? "  x\(count)" : "")
      t.font = .systemFont(ofSize: 15, weight: .bold)
      t.textColor = .white
      t.textAlignment = .center
      let st = UILabel()
      st.text = subtitle
      st.font = .systemFont(ofSize: 12, weight: .regular)
      st.textColor = UIColor(white: 1, alpha: 0.8)
      st.textAlignment = .center
      let maxW = W - 64
      let tw = min(maxW, max(t.intrinsicContentSize.width, st.intrinsicContentSize.width) + 32)
      let h: CGFloat = subtitle.isEmpty ? 34 : 50
      v.frame = CGRect(x: (W - tw) / 2, y: center.y + 76, width: tw, height: h)
      t.frame = CGRect(x: 12, y: subtitle.isEmpty ? 7 : 6, width: tw - 24, height: 20)
      st.frame = CGRect(x: 12, y: 27, width: tw - 24, height: 16)
      v.addSubview(t)
      if !subtitle.isEmpty { v.addSubview(st) }
      v.alpha = 0
      v.transform = CGAffineTransform(translationX: 0, y: 18)
      fxView.addSubview(v)
      UIView.animate(withDuration: 0.35, delay: 0.25, usingSpringWithDamping: 0.75, initialSpringVelocity: 0.4, options: []) {
        v.alpha = 1
        v.transform = .identity
      }
      chip = v
    }

    DispatchQueue.main.asyncAfter(deadline: .now() + 1.85) { [weak self] in
      CATransaction.begin()
      CATransaction.setAnimationDuration(0.35)
      host.opacity = 0
      CATransaction.commit()
      UIView.animate(withDuration: 0.35, animations: { chip?.alpha = 0 })
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
        host.removeFromSuperlayer()
        chip?.removeFromSuperview()
        self?.nextGift()
      }
    }
  }
}

// MARK: - prévia da live vizinha

final class LSPeekView: UIView {
  private let image = UIImageView()
  private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .dark))
  private let avatar = UILabel()
  private let title = UILabel()
  private let subtitle = UILabel()
  private var url: String?
  var hint: String? { didSet { refreshSubtitle() } }
  private var sub: String?

  private static let cache = NSCache<NSString, UIImage>()

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    backgroundColor = UIColor(red: 0.06, green: 0.06, blue: 0.1, alpha: 1)
    clipsToBounds = true
    image.contentMode = .scaleAspectFill
    image.alpha = 0.45
    addSubview(image)
    addSubview(blur)
    avatar.backgroundColor = UIColor(red: 0.165, green: 0.165, blue: 0.227, alpha: 1)
    avatar.textColor = .white
    avatar.font = .systemFont(ofSize: 30, weight: .semibold)
    avatar.textAlignment = .center
    avatar.layer.cornerRadius = 42
    avatar.clipsToBounds = true
    addSubview(avatar)
    title.textColor = .white
    title.font = .systemFont(ofSize: 17, weight: .bold)
    title.textAlignment = .center
    addSubview(title)
    subtitle.textColor = UIColor(white: 1, alpha: 0.7)
    subtitle.font = .systemFont(ofSize: 13)
    subtitle.textAlignment = .center
    addSubview(subtitle)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = bounds
    image.frame = b
    blur.frame = b
    avatar.frame = CGRect(x: b.midX - 42, y: b.midY - 70, width: 84, height: 84)
    title.frame = CGRect(x: 24, y: avatar.frame.maxY + 14, width: b.width - 48, height: 22)
    subtitle.frame = CGRect(x: 24, y: title.frame.maxY + 4, width: b.width - 48, height: 18)
  }

  private func refreshSubtitle() {
    subtitle.text = (sub?.isEmpty == false) ? sub : hint
  }

  func configure(_ v: [String: Any]?) {
    guard let v = v else { url = nil; image.image = nil; return }
    let t = (v["title"] as? String) ?? ""
    title.text = t
    sub = v["subtitle"] as? String
    refreshSubtitle()
    var initials = (v["initials"] as? String) ?? ""
    if initials.isEmpty, let f = t.first { initials = String(f).uppercased() }
    avatar.text = String(initials.prefix(2))
    let u = (v["imageUrl"] as? String) ?? ""
    if u == url { return }
    url = u
    image.image = nil
    guard !u.isEmpty, let URLv = URL(string: u) else { return }
    if let c = LSPeekView.cache.object(forKey: u as NSString) { image.image = c; return }
    URLSession.shared.dataTask(with: URLv) { [weak self] data, _, _ in
      guard let d = data, let img = UIImage(data: d) else { return }
      LSPeekView.cache.setObject(img, forKey: u as NSString)
      DispatchQueue.main.async {
        guard let self = self, self.url == u else { return }
        self.image.image = img
      }
    }.resume()
  }
}

// MARK: - cores / presentes

enum LSColor {
  static func hex(_ s: String?) -> UIColor? {
    guard var h = s?.trimmingCharacters(in: .whitespacesAndNewlines), !h.isEmpty else { return nil }
    if h.hasPrefix("#") { h.removeFirst() }
    if h.count == 3 { h = h.map { "\($0)\($0)" }.joined() }
    guard h.count == 6, let v = UInt32(h, radix: 16) else { return nil }
    return ceColor(v)
  }

  static func hexString(_ c: UIColor) -> String {
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    c.getRed(&r, green: &g, blue: &b, alpha: &a)
    return String(format: "#%02x%02x%02x", Int(max(0, min(1, r)) * 255), Int(max(0, min(1, g)) * 255), Int(max(0, min(1, b)) * 255))
  }
}

/// Glifos VETORIAIS dos presentes (sem emoji — mesmo catálogo do LiveGiftPicker).
enum LSGift {
  static func color(_ kind: String) -> UIColor {
    switch kind {
    case "rose": return ceColor(0xEF4444)
    case "star": return ceColor(0xFACC15)
    case "crown": return ceColor(0xFBBF24)
    case "fire": return ceColor(0xF97316)
    case "rocket": return ceColor(0xE5E7EB)
    default: return ceColor(0xFF4D6D)
    }
  }

  static func image(_ kind: String, color: UIColor, size: CGFloat) -> CGImage? {
    let k0 = ["rose", "heart", "star", "crown", "fire", "rocket"].contains(kind) ? kind : "heart"
    return CEImages.render("gift-\(k0)-\(CEImages.hexKey(color))-\(Int(size))", CGSize(width: size, height: size)) { ctx, sz in
      let k = sz.width / 24
      func P(_ x: CGFloat, _ y: CGFloat) -> CGPoint { return CGPoint(x: x * k, y: y * k) }
      switch k0 {
      case "star":
        ctx.addPath(CEImages.starPath(sz.width, inset: sz.width * 0.04))
        ctx.setFillColor(color.cgColor)
        ctx.setStrokeColor(ceColor(0xA16207).cgColor)
        ctx.setLineWidth(k * 0.6)
        ctx.drawPath(using: .fillStroke)
      case "crown":
        let p = UIBezierPath()
        p.move(to: P(2.5, 7.5)); p.addLine(to: P(7, 12)); p.addLine(to: P(12, 4))
        p.addLine(to: P(17, 12)); p.addLine(to: P(21.5, 7.5)); p.addLine(to: P(19.5, 18))
        p.addLine(to: P(4.5, 18)); p.close()
        ctx.addPath(p.cgPath)
        ctx.setFillColor(color.cgColor)
        ctx.fillPath()
        ctx.setFillColor(ceColor(0x92400E).cgColor)
        ctx.fill(CGRect(x: 4.5 * k, y: 18.8 * k, width: 15 * k, height: 2 * k))
        ctx.setFillColor(UIColor.white.withAlphaComponent(0.85).cgColor)
        for (x, y) in [(12.0, 4.0), (2.5, 7.5), (21.5, 7.5)] as [(CGFloat, CGFloat)] {
          ctx.fillEllipse(in: CGRect(x: (x - 1.1) * k, y: (y - 1.1) * k, width: 2.2 * k, height: 2.2 * k))
        }
      case "fire":
        let p = UIBezierPath()
        p.move(to: P(12, 2))
        p.addCurve(to: P(19, 13), controlPoint1: P(14, 6), controlPoint2: P(19, 8))
        p.addCurve(to: P(12, 22), controlPoint1: P(19, 18), controlPoint2: P(16, 22))
        p.addCurve(to: P(5, 13), controlPoint1: P(8, 22), controlPoint2: P(5, 18))
        p.addCurve(to: P(9, 7), controlPoint1: P(5, 10), controlPoint2: P(7, 8.5))
        p.addCurve(to: P(10.5, 11), controlPoint1: P(9, 9), controlPoint2: P(9.5, 10.5))
        p.addCurve(to: P(12, 2), controlPoint1: P(11.5, 7), controlPoint2: P(10, 4))
        p.close()
        ctx.addPath(p.cgPath)
        ctx.setFillColor(color.cgColor)
        ctx.fillPath()
        let q = UIBezierPath()
        q.move(to: P(12, 12))
        q.addCurve(to: P(15.5, 17.5), controlPoint1: P(13.5, 14), controlPoint2: P(15.5, 15))
        q.addCurve(to: P(12, 21), controlPoint1: P(15.5, 19.5), controlPoint2: P(14, 21))
        q.addCurve(to: P(8.5, 17.5), controlPoint1: P(10, 21), controlPoint2: P(8.5, 19.5))
        q.addCurve(to: P(12, 12), controlPoint1: P(8.5, 15), controlPoint2: P(10.5, 14))
        q.close()
        ctx.addPath(q.cgPath)
        ctx.setFillColor(ceColor(0xFDE047).cgColor)
        ctx.fillPath()
      case "rose":
        ctx.setStrokeColor(ceColor(0x16A34A).cgColor)
        ctx.setLineWidth(1.8 * k)
        ctx.setLineCap(.round)
        ctx.move(to: P(12, 14)); ctx.addLine(to: P(12, 22.5)); ctx.strokePath()
        ctx.setFillColor(ceColor(0x16A34A).cgColor)
        ctx.fillEllipse(in: CGRect(x: 7 * k, y: 17 * k, width: 5 * k, height: 2.6 * k))
        ctx.setFillColor(color.cgColor)
        ctx.fillEllipse(in: CGRect(x: 5.5 * k, y: 2.5 * k, width: 13 * k, height: 12.5 * k))
        ctx.setFillColor(ceColor(0x7F1D1D).withAlphaComponent(0.85).cgColor)
        ctx.fillEllipse(in: CGRect(x: 9.3 * k, y: 6 * k, width: 5.4 * k, height: 5.2 * k))
        ctx.setStrokeColor(UIColor.white.withAlphaComponent(0.35).cgColor)
        ctx.setLineWidth(0.7 * k)
        ctx.addArc(center: P(12, 8.7), radius: 4.4 * k, startAngle: .pi * 0.9, endAngle: .pi * 1.9, clockwise: false)
        ctx.strokePath()
      case "rocket":
        let body = UIBezierPath()
        body.move(to: P(12, 2))
        body.addQuadCurve(to: P(16.5, 10), controlPoint: P(16.2, 4.5))
        body.addLine(to: P(16.5, 16)); body.addLine(to: P(7.5, 16)); body.addLine(to: P(7.5, 10))
        body.addQuadCurve(to: P(12, 2), controlPoint: P(7.8, 4.5))
        body.close()
        // chama
        let fl = UIBezierPath()
        fl.move(to: P(9.5, 16)); fl.addLine(to: P(12, 22)); fl.addLine(to: P(14.5, 16)); fl.close()
        ctx.addPath(fl.cgPath); ctx.setFillColor(ceColor(0xF97316).cgColor); ctx.fillPath()
        // aletas
        let f1 = UIBezierPath()
        f1.move(to: P(7.5, 11.5)); f1.addLine(to: P(4, 17.5)); f1.addLine(to: P(7.5, 16)); f1.close()
        let f2 = UIBezierPath()
        f2.move(to: P(16.5, 11.5)); f2.addLine(to: P(20, 17.5)); f2.addLine(to: P(16.5, 16)); f2.close()
        ctx.setFillColor(ceColor(0xEF4444).cgColor)
        ctx.addPath(f1.cgPath); ctx.addPath(f2.cgPath); ctx.fillPath()
        ctx.addPath(body.cgPath); ctx.setFillColor(color.cgColor); ctx.fillPath()
        ctx.setFillColor(ceColor(0x1E3A8A).cgColor)
        ctx.fillEllipse(in: CGRect(x: 10 * k, y: 7 * k, width: 4 * k, height: 4 * k))
      default:
        ctx.addPath(CEImages.heartPath(sz.width, inset: sz.width * 0.02))
        ctx.setFillColor(color.cgColor)
        ctx.fillPath()
        ctx.saveGState()
        ctx.addPath(CEImages.heartPath(sz.width, inset: sz.width * 0.02))
        ctx.clip()
        ctx.setFillColor(UIColor(white: 1, alpha: 0.22).cgColor)
        ctx.fillEllipse(in: CGRect(x: sz.width * 0.22, y: sz.height * 0.2, width: sz.width * 0.26, height: sz.height * 0.16))
        ctx.restoreGState()
      }
    }
  }
}
