import UIKit
import CoreText

// [2026-10-15 native-list fase 2] Desenho dos blocos (CMLBlocksLayout) dentro
// do balão. Um draw só p/ fundo/borda/texto/ícone/divisor/avatar; subviews em
// pool p/ imagem (async), barra (anima `v`), spinner e nota de vídeo.

enum CMLBlockHit {
  case link(String)
  case spoiler
  case vnote(Int)
  case action(String, CGRect, CGFloat)
}

extension CMLBlocksLayout {
  /// Toque em coordenadas do balão. Texto (link/spoiler) > nota de vídeo > ação mais profunda.
  func hit(_ p: CGPoint, spoilerRevealed: Bool) -> CMLBlockHit? {
    for op in ops.reversed() where op.k == .text {
      guard let t = op.text, op.frame.insetBy(dx: -4, dy: -4).contains(p) else { continue }
      let tp = CGPoint(x: p.x - op.frame.minX, y: p.y - op.frame.minY)
      if !spoilerRevealed && t.spoiler(at: tp) { return .spoiler }
      if let l = t.link(at: tp) { return .link(l.0) }
    }
    var vi = 0
    var vnHit: Int? = nil
    for op in ops where op.k == .vnote {
      if op.frame.contains(p) { vnHit = vi }
      vi += 1
    }
    if let v = vnHit { return .vnote(v) }
    for a in actions.reversed() where a.0.contains(p) {
      return .action(a.1, a.0, a.2)
    }
    return nil
  }
}

final class CMLBarView: UIView {
  private let fill = UIView()
  private(set) var value: CGFloat = 0

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    clipsToBounds = true
    addSubview(fill)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func apply(frame f: CGRect, radius: CGFloat, track: UIColor?, color: UIColor?, value v: CGFloat, alpha: CGFloat, animated: Bool) {
    frame = f
    layer.cornerRadius = radius
    fill.layer.cornerRadius = radius
    backgroundColor = track ?? UIColor(white: 0.5, alpha: 0.2)
    fill.backgroundColor = color ?? UIColor(white: 0.1, alpha: 1)
    self.alpha = alpha
    let target = CGRect(x: 0, y: 0, width: f.width * max(0, min(1, v)), height: f.height)
    if animated && abs(v - value) > 0.001 && !UIAccessibility.isReduceMotionEnabled {
      // parte da largura anterior
      fill.frame = CGRect(x: 0, y: 0, width: f.width * max(0, min(1, value)), height: f.height)
      value = v
      UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseOut, .allowUserInteraction, .beginFromCurrentState], animations: {
        self.fill.frame = target
      })
    } else {
      value = v
      fill.layer.removeAllAnimations()
      fill.frame = target
    }
  }
}

final class CMLBlocksView: UIView {
  private(set) var info: CMLBlocksLayout?
  var spoiler: CMLSpoilerStyle? { didSet { if spoiler != oldValue { setNeedsDisplay() } } }
  /// "play"/"pause"/"end" de uma nota de vídeo (índice entre as `vn`).
  var onVideoNoteEvent: ((Int, String) -> Void)?

  private var images: [UIImageView] = []
  private var imageTokens: [String] = []
  private var bars: [CMLBarView] = []
  private var spinners: [UIActivityIndicatorView] = []
  private(set) var vnotes: [CMLVideoNoteView] = []
  private var key = ""
  private var barValues: [String: CGFloat] = [:]
  private var pendingEmoji = Set<String>()

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    contentMode = .redraw
    isUserInteractionEnabled = false
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func clear() {
    info = nil
    key = ""
    barValues.removeAll()
    for (i, iv) in images.enumerated() { iv.isHidden = true; iv.image = nil; imageTokens[i] = "" }
    for b in bars { b.isHidden = true }
    for sp in spinners { sp.stopAnimating(); sp.isHidden = true }
    for v in vnotes { v.stop(); v.isHidden = true }
    setNeedsDisplay()
  }

  func stopMedia() {
    for v in vnotes { v.stop() }
  }

  func apply(_ L: CMLBlocksLayout?, key k: String, placeholder: UIColor?) {
    let sameRow = k == key
    if !sameRow { barValues.removeAll(); stopMedia() }
    key = k
    info = L
    guard let L = L else { clear(); return }
    var ii = 0, bi = 0, si = 0, vi = 0
    let scale = UIScreen.main.scale
    var newBars: [String: CGFloat] = [:]
    for op in L.ops {
      switch op.k {
      case .image, .avatar:
        let n = op.node
        if op.k == .avatar && n.uri.isEmpty { continue }
        let iv = imageView(ii)
        iv.isHidden = false
        iv.frame = op.frame
        iv.alpha = op.alpha
        iv.layer.cornerRadius = op.radius
        iv.contentMode = (n.fit == "contain") ? .scaleAspectFit : .scaleAspectFill
        iv.backgroundColor = op.k == .avatar ? .clear : (n.bg ?? placeholder)
        if !op.clip.isNull {
          let m = (iv.layer.mask as? CAShapeLayer) ?? CAShapeLayer()
          let r = op.clip.offsetBy(dx: -op.frame.minX, dy: -op.frame.minY)
          m.path = UIBezierPath(roundedRect: r, cornerRadius: op.clipRadius).cgPath
          iv.layer.mask = m
        } else {
          iv.layer.mask = nil
        }
        setImage(iv, slot: ii, uri: n.uri, thumb: n.thumb, maxPixel: max(op.frame.width, op.frame.height) * scale)
        ii += 1
      case .bar:
        let b = bar(bi)
        b.isHidden = false
        let n = op.node
        let prev: CGFloat? = (!n.id.isEmpty && sameRow) ? barValues[n.id] : nil
        if !n.id.isEmpty { newBars[n.id] = n.value }
        if let pv = prev, abs(pv - b.value) > 0.001 {
          // reaproveitou a view de outra barra: posiciona sem animar no valor anterior
          b.apply(frame: op.frame, radius: op.radius, track: n.bg, color: n.color, value: pv, alpha: op.alpha, animated: false)
        }
        b.apply(frame: op.frame, radius: op.radius, track: n.bg, color: n.color, value: n.value, alpha: op.alpha, animated: prev != nil && window != nil)
        bi += 1
      case .spinner:
        let sp = spinner(si)
        sp.isHidden = false
        sp.color = op.node.color ?? .gray
        let sz = op.frame.width
        sp.transform = CGAffineTransform(scaleX: max(0.3, sz / 20), y: max(0.3, sz / 20))
        sp.center = CGPoint(x: op.frame.midX, y: op.frame.midY)
        sp.alpha = op.alpha
        if !sp.isAnimating { sp.startAnimating() }
        si += 1
      case .vnote:
        let v = vnote(vi)
        v.isHidden = false
        v.frame = op.frame
        v.alpha = op.alpha
        v.configure(op.node, bg: placeholder)
        let idx = vi
        v.onEvent = { [weak self] st in self?.onVideoNoteEvent?(idx, st) }
        vi += 1
      default:
        break
      }
    }
    barValues = newBars
    for i in ii..<images.count { images[i].isHidden = true; images[i].image = nil; imageTokens[i] = "" }
    for i in bi..<bars.count { bars[i].isHidden = true }
    for i in si..<spinners.count { spinners[i].stopAnimating(); spinners[i].isHidden = true }
    for i in vi..<vnotes.count { vnotes[i].stop(); vnotes[i].isHidden = true }
    setNeedsDisplay()
  }

  /// Toca/pausa a nota de vídeo `i`; devolve "play"/"pause"/"".
  func toggleVideoNote(_ i: Int) -> String {
    guard i >= 0, i < vnotes.count, !vnotes[i].isHidden else { return "" }
    return vnotes[i].toggle()
  }

  func flashAction(_ r: CGRect, radius: CGFloat) {
    let v = UIView(frame: r)
    v.isUserInteractionEnabled = false
    v.backgroundColor = UIColor(white: 0, alpha: 0.08)
    v.layer.cornerRadius = radius
    addSubview(v)
    UIView.animate(withDuration: 0.25, delay: 0.08, options: [.allowUserInteraction], animations: { v.alpha = 0 }, completion: { _ in v.removeFromSuperview() })
  }

  // MARK: pools

  private func imageView(_ i: Int) -> UIImageView {
    while images.count <= i {
      let iv = UIImageView()
      iv.clipsToBounds = true
      iv.isUserInteractionEnabled = false
      addSubview(iv)
      images.append(iv)
      imageTokens.append("")
    }
    return images[i]
  }

  private func bar(_ i: Int) -> CMLBarView {
    while bars.count <= i { let b = CMLBarView(); addSubview(b); bars.append(b) }
    return bars[i]
  }

  private func spinner(_ i: Int) -> UIActivityIndicatorView {
    while spinners.count <= i {
      let s = UIActivityIndicatorView(style: .medium)
      s.hidesWhenStopped = false
      s.isUserInteractionEnabled = false
      addSubview(s)
      spinners.append(s)
    }
    return spinners[i]
  }

  private func vnote(_ i: Int) -> CMLVideoNoteView {
    while vnotes.count <= i { let v = CMLVideoNoteView(); addSubview(v); vnotes.append(v) }
    return vnotes[i]
  }

  private func setImage(_ iv: UIImageView, slot: Int, uri: String, thumb: String, maxPixel: CGFloat) {
    let tok = uri + "#" + thumb
    if slot < imageTokens.count && imageTokens[slot] == tok && iv.image != nil { return }
    if slot < imageTokens.count { imageTokens[slot] = tok }
    let loader = CMLImageLoader.shared
    if let img = loader.cached(uri, maxPixel: maxPixel) { iv.image = img; return }
    if !thumb.isEmpty, let t = loader.cached(thumb, maxPixel: 96) { iv.image = t } else { iv.image = nil }
    if !thumb.isEmpty && iv.image == nil {
      loader.load(thumb, maxPixel: 96) { [weak self, weak iv] img in
        guard let self = self, let iv = iv, iv.image == nil, let img = img else { return }
        if slot < self.imageTokens.count && self.imageTokens[slot] == tok { iv.image = img }
      }
    }
    if uri.isEmpty { return }
    loader.load(uri, maxPixel: maxPixel) { [weak self, weak iv] img in
      guard let self = self, let iv = iv, let img = img else { return }
      guard slot < self.imageTokens.count, self.imageTokens[slot] == tok else { return }
      if iv.image != nil {
        UIView.transition(with: iv, duration: 0.18, options: [.transitionCrossDissolve, .allowUserInteraction], animations: { iv.image = img })
      } else {
        iv.image = img
      }
    }
  }

  private func requestEmoji(_ url: String, _ px: CGFloat) {
    let k = url + "#\(Int(px))"
    if pendingEmoji.contains(k) { return }
    pendingEmoji.insert(k)
    CMLImageLoader.shared.load(url, maxPixel: px) { [weak self] img in
      guard let self = self else { return }
      self.pendingEmoji.remove(k)
      if img != nil { self.setNeedsDisplay() }
    }
  }

  // MARK: desenho

  override func draw(_ rect: CGRect) {
    guard let L = info, let ctx = UIGraphicsGetCurrentContext() else { return }
    let hairline = 1 / UIScreen.main.scale
    let h = bounds.height
    for op in L.ops {
      switch op.k {
      case .clipPush:
        ctx.saveGState()
        ctx.addPath(UIBezierPath(roundedRect: op.frame, cornerRadius: op.radius).cgPath)
        ctx.clip()
      case .clipPop:
        ctx.restoreGState()
      case .box:
        let n = op.node
        ctx.saveGState()
        if op.alpha < 1 { ctx.setAlpha(op.alpha) }
        if let bg = n.bg {
          ctx.setFillColor(bg.cgColor)
          ctx.addPath(UIBezierPath(roundedRect: op.frame, cornerRadius: op.radius).cgPath)
          ctx.fillPath()
        }
        if let bc = n.borderColor, n.borderWidth > 0 {
          let bw = max(hairline, n.borderWidth)
          ctx.setStrokeColor(bc.cgColor)
          ctx.setLineWidth(bw)
          ctx.addPath(UIBezierPath(roundedRect: op.frame.insetBy(dx: bw / 2, dy: bw / 2), cornerRadius: max(0, op.radius - bw / 2)).cgPath)
          ctx.strokePath()
        }
        ctx.restoreGState()
      case .text:
        guard let t = op.text else { continue }
        ctx.saveGState()
        if op.alpha < 1 { ctx.setAlpha(op.alpha) }
        CMLTextView.drawText(t, in: ctx, origin: op.frame.origin, height: h, spoiler: spoiler, onMissingEmoji: { [weak self] u, px in
          self?.requestEmoji(u, px)
        })
        ctx.restoreGState()
      case .icon:
        ctx.saveGState()
        if op.alpha < 1 { ctx.setAlpha(op.alpha) }
        CMLIcons.node(ctx, op.node, rect: op.frame)
        ctx.restoreGState()
      case .divider:
        ctx.saveGState()
        if op.alpha < 1 { ctx.setAlpha(op.alpha) }
        ctx.setFillColor((op.node.color ?? UIColor(white: 0.5, alpha: 0.3)).cgColor)
        ctx.fill(CGRect(x: op.frame.minX, y: op.frame.minY, width: op.frame.width, height: max(hairline, op.frame.height)))
        ctx.restoreGState()
      case .avatar:
        let n = op.node
        ctx.saveGState()
        if op.alpha < 1 { ctx.setAlpha(op.alpha) }
        let circle = UIBezierPath(ovalIn: op.frame).cgPath
        if let b1 = n.bg, let b2 = n.bg2,
           let g = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [b1.cgColor, b2.cgColor] as CFArray, locations: [0, 1]) {
          ctx.addPath(circle)
          ctx.clip()
          ctx.drawLinearGradient(g, start: CGPoint(x: op.frame.minX, y: op.frame.minY), end: CGPoint(x: op.frame.maxX, y: op.frame.maxY), options: [])
        } else {
          ctx.setFillColor((n.bg ?? UIColor(white: 0.5, alpha: 0.35)).cgColor)
          ctx.addPath(circle)
          ctx.fillPath()
        }
        ctx.restoreGState()
        if let t = op.text {
          ctx.saveGState()
          if op.alpha < 1 { ctx.setAlpha(op.alpha) }
          CMLTextView.drawText(t, in: ctx, origin: CGPoint(x: op.frame.midX - t.size.width / 2, y: op.frame.midY - t.size.height / 2), height: h)
          ctx.restoreGState()
        }
      case .image, .bar, .spinner, .vnote:
        break
      }
    }
  }
}
