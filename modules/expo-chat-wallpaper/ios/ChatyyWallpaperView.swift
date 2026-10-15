import ExpoModulesCore
import UIKit
import QuartzCore
import CoreImage
import ImageIO

// [2026-10-15 native-wallpaper] Fundo NATIVO da conversa (nível Telegram).
//
// Camadas (dentro de `content`, que é maior que a view quando há paralaxe):
//   gradientView  — gradiente de 4 cores: bitmap 60×80 calculado na CPU
//                   (algoritmo do Telegram) e ampliado pelo Core Animation com
//                   filtro linear. Só é recalculado enquanto ANIMA (CADisplayLink
//                   ~0,5 s por passo) — parado, custo zero por quadro.
//   imageView     — foto do usuário (ImageIO downsample + CIGaussianBlur opcional).
//   patternView   — padrão vetorial (azulejo desenhado UMA vez, cor-padrão de
//                   UIKit = repetição pela GPU). Modo 'overlay': traço por cima.
//   maskView      — modo 'mask' (escuro): o gradiente só aparece ATRAVÉS do
//                   padrão sobre o preto (Telegram).
//   dimView       — escurecimento (foto no modo escuro).
// Paralaxe: UIInterpolatingMotionEffect (giroscópio do sistema; o próprio iOS
// desliga com "Reduzir Movimento"; também checamos e não instalamos).
final class ChatyyWallpaperView: ExpoView {
  private let content = UIView()
  // UIViews (não CALayer cru): cor-padrão de UIView desenha o azulejo na
  // orientação certa e UIView.mask cuida do modo máscara; UIView não anima
  // implicitamente fora de blocos de animação.
  private let gradientView = UIView()
  private let imageView = UIView()
  private let patternView = UIView()
  private let wpMaskView = UIView()
  private let dimView = UIView()
  private var gradientLayer: CALayer { return gradientView.layer }
  private var imageLayer: CALayer { return imageView.layer }

  // props
  private var rgb: [(CGFloat, CGFloat, CGFloat)] = []
  private var colorsKey = ""
  private var baseColor: UIColor = .clear
  private var pattern: WPPattern?
  private var patternKey = ""
  private var patternIntensity: CGFloat = 0.1
  private var patternMask = false
  private var patternColor: UIColor = .black
  private var patternColorKey = "#000000"
  private var patternScale: CGFloat = 1
  private var imageUri = ""
  private var blur: CGFloat = 0
  private var dim: CGFloat = 0
  private var motion = false
  private var animate = true
  private var autoplayMs: Double = 0

  private var dirtyGradient = true
  private var dirtyPattern = true
  private var dirtyImage = true
  private var dirtyMotion = true

  // animação do gradiente
  private var phase = 0
  private var curPositions: [CGPoint] = ChatyyWallpaperView.positions(phase: 0)
  private var fromPositions: [CGPoint] = []
  private var toPositions: [CGPoint] = []
  private var animStart: CFTimeInterval = 0
  private let animDuration: CFTimeInterval = 0.5
  private var link: CADisplayLink?
  private var autoTimer: Timer?
  private var scrollAcc: CGFloat = 0

  private var loadedImageKey = ""
  private var motionGroup: UIMotionEffectGroup?
  private var motionActive = false
  private static let motionPad: CGFloat = 18

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    isUserInteractionEnabled = false
    backgroundColor = .clear
    content.isUserInteractionEnabled = false
    content.backgroundColor = .clear
    addSubview(content)
    for v in [gradientView, imageView, patternView, dimView, wpMaskView] {
      v.isUserInteractionEnabled = false
      v.backgroundColor = .clear
    }
    gradientLayer.contentsGravity = .resize
    gradientLayer.magnificationFilter = .linear
    gradientLayer.minificationFilter = .linear
    imageLayer.contentsGravity = .resizeAspectFill
    imageView.clipsToBounds = true
    dimView.backgroundColor = .black
    dimView.alpha = 0
    patternView.isHidden = true
    imageView.isHidden = true
    content.addSubview(gradientView)
    content.addSubview(imageView)
    content.addSubview(patternView)
    content.addSubview(dimView)
    NotificationCenter.default.addObserver(self, selector: #selector(reduceMotionChanged),
                                           name: UIAccessibility.reduceMotionStatusDidChangeNotification, object: nil)
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    link?.invalidate()
    autoTimer?.invalidate()
  }

  // MARK: props

  func setColors(_ v: [String]) {
    let list = Array(v.prefix(4))
    let key = list.joined(separator: ",")
    if key == colorsKey { return }
    colorsKey = key
    rgb = list.map { wpRGB($0) }
    dirtyGradient = true
  }
  func setBaseColor(_ v: String?) { baseColor = v.map { wpColor($0) } ?? .clear }
  func setPattern(_ v: [String: Any]?) {
    let key = (v?["key"] as? String) ?? (v == nil ? "" : "p\((v?["items"] as? [Any])?.count ?? 0)")
    if key == patternKey && (v == nil) == (pattern == nil) { return }
    patternKey = key
    pattern = v.flatMap { WPPattern(dict: $0) }
    dirtyPattern = true
  }
  func setPatternIntensity(_ v: Double) {
    let c = CGFloat(max(0, min(1, v)))
    if c != patternIntensity { patternIntensity = c; dirtyPattern = true }
  }
  func setPatternMode(_ v: String?) {
    let m = (v == "mask")
    if m != patternMask { patternMask = m; dirtyPattern = true }
  }
  func setPatternColor(_ v: String?) {
    let k = v ?? "#000000"
    if k != patternColorKey { patternColorKey = k; patternColor = wpColor(k); dirtyPattern = true }
  }
  func setPatternScale(_ v: Double) {
    let s = CGFloat(max(0.2, min(3, v)))
    if s != patternScale { patternScale = s; dirtyPattern = true }
  }
  func setImageUri(_ v: String?) {
    let u = v ?? ""
    if u != imageUri { imageUri = u; dirtyImage = true }
  }
  func setBlur(_ v: Double) {
    let b = CGFloat(max(0, min(60, v)))
    if b != blur { blur = b; dirtyImage = true }
  }
  func setDim(_ v: Double) { dim = CGFloat(max(0, min(0.9, v))) }
  func setMotion(_ v: Bool) { if v != motion { motion = v; dirtyMotion = true } }
  func setAnimate(_ v: Bool) { animate = v }
  func setAutoplay(_ v: Double) {
    let ms = max(0, v)
    if ms != autoplayMs { autoplayMs = ms; updateAutoplay() }
  }

  func commitProps() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    // cor-base no `content` (não no self): o Fabric controla o backgroundColor da view raiz
    content.backgroundColor = baseColor
    dimView.alpha = dim
    if dirtyGradient { dirtyGradient = false; renderGradient() }
    if dirtyPattern { dirtyPattern = false; applyPattern() }
    if dirtyImage { dirtyImage = false; loadImage() }
    if dirtyMotion { dirtyMotion = false; applyMotion() }
    CATransaction.commit()
  }

  // MARK: layout

  override func layoutSubviews() {
    super.layoutSubviews()
    let pad = motionActive ? ChatyyWallpaperView.motionPad : 0
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    content.bounds = CGRect(x: 0, y: 0, width: bounds.width + pad * 2, height: bounds.height + pad * 2)
    content.center = CGPoint(x: bounds.midX, y: bounds.midY)
    let r = content.bounds
    gradientView.frame = r
    imageView.frame = r
    patternView.frame = r
    dimView.frame = r
    wpMaskView.frame = gradientView.bounds
    CATransaction.commit()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      stopLink()
      autoTimer?.invalidate(); autoTimer = nil
    } else {
      updateAutoplay()
    }
  }

  // MARK: gradiente

  private static let basePositions: [CGPoint] = [
    CGPoint(x: 0.80, y: 0.10), CGPoint(x: 0.60, y: 0.20), CGPoint(x: 0.35, y: 0.25), CGPoint(x: 0.25, y: 0.60),
    CGPoint(x: 0.20, y: 0.90), CGPoint(x: 0.40, y: 0.80), CGPoint(x: 0.65, y: 0.75), CGPoint(x: 0.75, y: 0.40),
  ]

  static func positions(phase: Int) -> [CGPoint] {
    return (0..<4).map { i in basePositions[((phase + i * 2) % 8 + 8) % 8] }
  }

  private func renderGradient() {
    if rgb.isEmpty {
      gradientLayer.contents = nil
      gradientLayer.backgroundColor = nil
      gradientView.isHidden = true
      return
    }
    gradientView.isHidden = false
    if rgb.count == 1 {
      gradientLayer.contents = nil
      gradientLayer.backgroundColor = UIColor(red: rgb[0].0, green: rgb[0].1, blue: rgb[0].2, alpha: 1).cgColor
      return
    }
    gradientLayer.backgroundColor = nil
    gradientLayer.contents = ChatyyWallpaperView.gradientImage(rgb: rgb, positions: curPositions)
  }

  /// Algoritmo do gradiente do Telegram (redemoinho + soma por distância^4).
  static func gradientImage(rgb: [(CGFloat, CGFloat, CGFloat)], positions: [CGPoint]) -> CGImage? {
    let w = 60, h = 80
    let n = min(rgb.count, positions.count)
    if n == 0 { return nil }
    var buf = [UInt8](repeating: 255, count: w * h * 4)
    for y in 0..<h {
      let dpy = CGFloat(y) / CGFloat(h)
      let cdy = dpy - 0.5
      let cdy2 = cdy * cdy
      for x in 0..<w {
        let dpx = CGFloat(x) / CGFloat(w)
        let cdx = dpx - 0.5
        let cd = sqrt(cdx * cdx + cdy2)
        let swirl = 0.35 * cd
        let theta = swirl * swirl * 0.8 * 8.0
        let st = sin(theta), ct = cos(theta)
        let px = max(0, min(1, 0.5 + cdx * ct - cdy * st))
        let py = max(0, min(1, 0.5 + cdx * st + cdy * ct))
        var sum: CGFloat = 0, r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0
        for i in 0..<n {
          let dx = px - positions[i].x
          let dy = py - positions[i].y
          var d = max(0, 0.9 - sqrt(dx * dx + dy * dy))
          d = d * d * d * d
          sum += d
          r += d * rgb[i].0; g += d * rgb[i].1; b += d * rgb[i].2
        }
        if sum < 0.00001 { sum = 0.00001 }
        let o = (y * w + x) * 4
        buf[o] = UInt8(max(0, min(255, r / sum * 255)))
        buf[o + 1] = UInt8(max(0, min(255, g / sum * 255)))
        buf[o + 2] = UInt8(max(0, min(255, b / sum * 255)))
      }
    }
    let data = Data(buf) as CFData
    guard let provider = CGDataProvider(data: data) else { return nil }
    return CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4,
                   space: CGColorSpaceCreateDeviceRGB(),
                   bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                   provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
  }

  private var canAnimate: Bool {
    return animate && rgb.count >= 2 && window != nil && !UIAccessibility.isReduceMotionEnabled
  }

  func step() {
    guard canAnimate else { return }
    phase = (phase + 1) % 8
    fromPositions = curPositions
    toPositions = ChatyyWallpaperView.positions(phase: phase)
    animStart = CACurrentMediaTime()
    if link == nil {
      let l = CADisplayLink(target: WPWeakProxy(self), selector: #selector(WPWeakProxy.tick))
      if #available(iOS 15.0, *) {
        l.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
      }
      l.add(to: .main, forMode: .common)
      link = l
    }
  }

  func scrollBy(_ dy: CGFloat) {
    scrollAcc += abs(dy)
    if scrollAcc >= 420 {
      scrollAcc = 0
      step()
    }
  }

  fileprivate func tick() {
    let t = min(1, (CACurrentMediaTime() - animStart) / animDuration)
    let e = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
    let k = CGFloat(e)
    if fromPositions.count == toPositions.count {
      curPositions = zip(fromPositions, toPositions).map { a, b in
        CGPoint(x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k)
      }
    }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    if rgb.count >= 2 {
      gradientLayer.contents = ChatyyWallpaperView.gradientImage(rgb: rgb, positions: curPositions)
    }
    CATransaction.commit()
    if t >= 1 { stopLink() }
  }

  private func stopLink() {
    link?.invalidate()
    link = nil
    if !toPositions.isEmpty && curPositions != toPositions {
      curPositions = toPositions
      if rgb.count >= 2 {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        gradientLayer.contents = ChatyyWallpaperView.gradientImage(rgb: rgb, positions: curPositions)
        CATransaction.commit()
      }
    }
  }

  private func updateAutoplay() {
    autoTimer?.invalidate(); autoTimer = nil
    guard autoplayMs >= 400, window != nil else { return }
    let tm = Timer(timeInterval: autoplayMs / 1000, repeats: true) { [weak self] _ in self?.step() }
    RunLoop.main.add(tm, forMode: .common)
    autoTimer = tm
  }

  // MARK: padrão

  private static let tileCache = NSCache<NSString, UIImage>()

  private func applyPattern() {
    guard let p = pattern, patternIntensity > 0.001 else {
      patternView.backgroundColor = .clear
      patternView.isHidden = true
      gradientView.mask = nil
      gradientView.alpha = 1
      if rgb.isEmpty { gradientView.isHidden = true }
      return
    }
    let scale = window?.screen.scale ?? UIScreen.main.scale
    let color: UIColor = patternMask ? .white : patternColor.withAlphaComponent(patternIntensity)
    let ck = "\(patternKey)|\(patternMask ? 1 : 0)|\(patternColorKey)|\(patternMask ? 1 : patternIntensity)|\(patternScale)|\(scale)" as NSString
    var tile = ChatyyWallpaperView.tileCache.object(forKey: ck)
    if tile == nil {
      tile = p.tileImage(color: color, scale: patternScale, screenScale: scale)
      if let t = tile { ChatyyWallpaperView.tileCache.setObject(t, forKey: ck) }
    }
    guard let img = tile else { return }
    let pc = UIColor(patternImage: img)
    if patternMask {
      patternView.isHidden = true
      patternView.backgroundColor = .clear
      wpMaskView.backgroundColor = pc
      wpMaskView.frame = gradientView.bounds
      gradientView.mask = wpMaskView
      gradientView.alpha = patternIntensity
      gradientView.isHidden = rgb.isEmpty
    } else {
      gradientView.mask = nil
      gradientView.alpha = 1
      patternView.isHidden = false
      patternView.backgroundColor = pc
    }
  }

  // MARK: foto

  private static let imageCache: NSCache<NSString, UIImage> = {
    let c = NSCache<NSString, UIImage>()
    c.countLimit = 12
    return c
  }()
  private static let ciContext = CIContext(options: [.cacheIntermediates: false])

  private func loadImage() {
    let uri = imageUri
    let key = "\(uri)|\(Int(blur))"
    if uri.isEmpty {
      loadedImageKey = ""
      imageLayer.contents = nil
      imageView.isHidden = true
      return
    }
    if key == loadedImageKey { return }
    loadedImageKey = key
    imageView.isHidden = false
    if let img = ChatyyWallpaperView.imageCache.object(forKey: key as NSString) {
      imageLayer.contents = img.cgImage
      return
    }
    guard let url = URL(string: uri) else { return }
    let blurPx = blur
    let finish: (Data?) -> Void = { [weak self] data in
      guard let data = data, let cg = ChatyyWallpaperView.decode(data, maxPixel: 1400) else { return }
      var out = cg
      if blurPx > 0, let b = ChatyyWallpaperView.blurred(cg, sigma: blurPx * 1.4) { out = b }
      let ui = UIImage(cgImage: out)
      ChatyyWallpaperView.imageCache.setObject(ui, forKey: key as NSString)
      DispatchQueue.main.async {
        guard let self = self, self.loadedImageKey == key else { return }
        let fade = CATransition()
        fade.duration = 0.18
        self.imageLayer.add(fade, forKey: "fade")
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        self.imageLayer.contents = out
        CATransaction.commit()
      }
    }
    if url.isFileURL {
      DispatchQueue.global(qos: .userInitiated).async { finish(try? Data(contentsOf: url)) }
    } else {
      URLSession.shared.dataTask(with: url) { data, _, _ in
        DispatchQueue.global(qos: .userInitiated).async { finish(data) }
      }.resume()
    }
  }

  private static func decode(_ data: Data, maxPixel: Int) -> CGImage? {
    guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixel,
      kCGImageSourceShouldCacheImmediately: true,
    ]
    return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
  }

  private static func blurred(_ cg: CGImage, sigma: CGFloat) -> CGImage? {
    let input = CIImage(cgImage: cg)
    let out = input.clampedToExtent().applyingGaussianBlur(sigma: Double(sigma)).cropped(to: input.extent)
    return ciContext.createCGImage(out, from: input.extent)
  }

  // MARK: paralaxe

  @objc private func reduceMotionChanged() {
    applyMotion()
  }

  private func applyMotion() {
    if let g = motionGroup { content.removeMotionEffect(g); motionGroup = nil }
    let on = motion && !UIAccessibility.isReduceMotionEnabled
    motionActive = on
    if on {
      let pad = ChatyyWallpaperView.motionPad
      let h = UIInterpolatingMotionEffect(keyPath: "center.x", type: .tiltAlongHorizontalAxis)
      h.minimumRelativeValue = -pad
      h.maximumRelativeValue = pad
      let v = UIInterpolatingMotionEffect(keyPath: "center.y", type: .tiltAlongVerticalAxis)
      v.minimumRelativeValue = -pad
      v.maximumRelativeValue = pad
      let g = UIMotionEffectGroup()
      g.motionEffects = [h, v]
      content.addMotionEffect(g)
      motionGroup = g
    }
    setNeedsLayout()
  }
}

// Proxy fraco p/ o CADisplayLink não reter a view.
private final class WPWeakProxy: NSObject {
  weak var target: ChatyyWallpaperView?
  init(_ t: ChatyyWallpaperView) { target = t }
  @objc func tick() { target?.tick() }
}

// MARK: - padrão vetorial

struct WPPattern {
  struct Item { let path: CGPath; let x: CGFloat; let y: CGFloat; let s: CGFloat; let r: CGFloat }
  let tile: CGFloat
  let stroke: CGFloat
  let items: [Item]

  init?(dict: [String: Any]) {
    let t = CGFloat((dict["tile"] as? NSNumber)?.doubleValue ?? 300)
    guard t >= 40, t <= 2000, let raw = dict["items"] as? [Any] else { return nil }
    tile = t
    stroke = CGFloat((dict["stroke"] as? NSNumber)?.doubleValue ?? 1.5)
    var out: [Item] = []
    for case let it as [String: Any] in raw.prefix(200) {
      guard let d = it["d"] as? String, !d.isEmpty else { continue }
      let num: (String, Double) -> CGFloat = { k, def in CGFloat((it[k] as? NSNumber)?.doubleValue ?? def) }
      out.append(Item(path: WPSVG.path(d), x: num("x", 0), y: num("y", 0), s: max(0.1, num("s", 1)), r: num("r", 0)))
    }
    if out.isEmpty { return nil }
    items = out
  }

  /// Azulejo T×T pt (T = tile × scale). Cada glifo é desenhado também nas
  /// posições "embrulhadas" (±T) → a repetição não tem emendas.
  func tileImage(color: UIColor, scale: CGFloat, screenScale: CGFloat) -> UIImage? {
    let T = tile * scale
    if T < 4 { return nil }
    let fmt = UIGraphicsImageRendererFormat()
    fmt.opaque = false
    fmt.scale = screenScale
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: T, height: T), format: fmt)
    return renderer.image { ctx in
      let cg = ctx.cgContext
      cg.setStrokeColor(color.cgColor)
      cg.setLineCap(.round)
      cg.setLineJoin(.round)
      for it in items {
        for ox in -1...1 {
          for oy in -1...1 {
            let cx = it.x + CGFloat(ox) * tile
            let cy = it.y + CGFloat(oy) * tile
            let reach = 18 * it.s
            if cx < -reach || cy < -reach || cx > tile + reach || cy > tile + reach { continue }
            cg.saveGState()
            cg.translateBy(x: cx * scale, y: cy * scale)
            cg.rotate(by: it.r * .pi / 180)
            cg.scaleBy(x: it.s * scale, y: it.s * scale)
            cg.translateBy(x: -12, y: -12)
            cg.setLineWidth(stroke / it.s)
            cg.addPath(it.path)
            cg.strokePath()
            cg.restoreGState()
          }
        }
      }
    }
  }
}

/// Parser mínimo de path SVG: M L H V C Q Z (absolutos e relativos).
enum WPSVG {
  static func path(_ d: String) -> CGPath {
    let p = CGMutablePath()
    let c = Array(d.utf8)
    let n = c.count
    var i = 0
    var cmd: UInt8 = 0
    var cur = CGPoint.zero
    var start = CGPoint.zero
    var hasCurrent = false

    func isSep(_ b: UInt8) -> Bool { return b == 32 || b == 44 || b == 9 || b == 10 || b == 13 }
    func isLetter(_ b: UInt8) -> Bool { return (b >= 65 && b <= 90) || (b >= 97 && b <= 122) }
    func skip() { while i < n && isSep(c[i]) { i += 1 } }
    func num() -> CGFloat? {
      skip()
      let s = i
      if i < n && (c[i] == 45 || c[i] == 43) { i += 1 }
      var dot = false
      while i < n {
        let b = c[i]
        if b >= 48 && b <= 57 { i += 1; continue }
        if b == 46 && !dot { dot = true; i += 1; continue }
        if (b == 101 || b == 69) && i + 1 < n {
          i += 1
          if c[i] == 45 || c[i] == 43 { i += 1 }
          continue
        }
        break
      }
      if i == s { return nil }
      guard let str = String(bytes: c[s..<i], encoding: .ascii), let v = Double(str) else { return nil }
      return CGFloat(v)
    }

    while true {
      skip()
      if i >= n { break }
      if isLetter(c[i]) { cmd = c[i]; i += 1 }
      else if cmd == 0 { break }
      let rel = cmd >= 97
      let base = rel ? cur : .zero
      switch cmd {
      case 77, 109: // M m
        guard let x = num(), let y = num() else { return p }
        cur = CGPoint(x: base.x + x, y: base.y + y)
        p.move(to: cur); start = cur; hasCurrent = true
        cmd = rel ? 108 : 76 // pares seguintes = L/l
      case 76, 108: // L l
        guard let x = num(), let y = num() else { return p }
        cur = CGPoint(x: base.x + x, y: base.y + y)
        if !hasCurrent { p.move(to: cur); start = cur; hasCurrent = true } else { p.addLine(to: cur) }
      case 72, 104: // H h
        guard let x = num() else { return p }
        cur = CGPoint(x: (rel ? cur.x : 0) + x, y: cur.y)
        if hasCurrent { p.addLine(to: cur) }
      case 86, 118: // V v
        guard let y = num() else { return p }
        cur = CGPoint(x: cur.x, y: (rel ? cur.y : 0) + y)
        if hasCurrent { p.addLine(to: cur) }
      case 67, 99: // C c
        guard let x1 = num(), let y1 = num(), let x2 = num(), let y2 = num(), let x = num(), let y = num() else { return p }
        let c1 = CGPoint(x: base.x + x1, y: base.y + y1)
        let c2 = CGPoint(x: base.x + x2, y: base.y + y2)
        cur = CGPoint(x: base.x + x, y: base.y + y)
        if hasCurrent { p.addCurve(to: cur, control1: c1, control2: c2) }
      case 81, 113: // Q q
        guard let x1 = num(), let y1 = num(), let x = num(), let y = num() else { return p }
        let c1 = CGPoint(x: base.x + x1, y: base.y + y1)
        cur = CGPoint(x: base.x + x, y: base.y + y)
        if hasCurrent { p.addQuadCurve(to: cur, control: c1) }
      case 90, 122: // Z z
        if hasCurrent { p.closeSubpath() }
        cur = start
        cmd = 0
        // depois de Z só pode vir outro comando (letra)
        skip()
        if i < n && !isLetter(c[i]) { return p }
      default:
        return p
      }
    }
    return p
  }
}

// MARK: - cores

func wpRGB(_ s: String) -> (CGFloat, CGFloat, CGFloat) {
  var h = s.trimmingCharacters(in: .whitespaces)
  if h.hasPrefix("#") { h.removeFirst() }
  if h.count == 3 { h = h.map { "\($0)\($0)" }.joined() }
  let v = UInt32(h.prefix(6), radix: 16) ?? 0
  return (CGFloat((v >> 16) & 255) / 255, CGFloat((v >> 8) & 255) / 255, CGFloat(v & 255) / 255)
}

func wpColor(_ s: String) -> UIColor {
  let (r, g, b) = wpRGB(s)
  return UIColor(red: r, green: g, blue: b, alpha: 1)
}
