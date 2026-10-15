import UIKit

// [2026-10-15 native-editor] Palco da foto: UIImageView (GPU) recortado por um
// clipView + camada vetorial (traços, textos, figurinhas) + moldura de recorte.
// Gestos feitos à mão (multitoque) — igual ao PhotoCanvasView.kt.

protocol MECanvasHost: AnyObject {
  var editorState: MEState { get set }
  var brushColor: UIColor { get }
  var brushWidth: CGFloat { get }
  func beginMutation()
  func cancelMutation()
  func changed()
  func objTapped(_ index: Int)
  func objDragging(_ active: Bool, overTrash: Bool)
}

final class MEOverlayView: UIView {
  weak var canvas: MECanvasView?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    isUserInteractionEnabled = false
    contentMode = .redraw
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func draw(_ rect: CGRect) {
    guard let cv = canvas, let host = cv.host, let ctx = UIGraphicsGetCurrentContext() else { return }
    let st = host.editorState
    let f = cv.fullRect.offsetBy(dx: -cv.cropRect.minX, dy: -cv.cropRect.minY)
    let short = min(f.width, f.height)
    for s in st.strokes { MEDraw.drawStroke(s, full: f, short: short, in: ctx) }
    if let live = cv.liveStroke { MEDraw.drawStroke(live, full: f, short: short, in: ctx) }
    for (i, o) in st.objs.enumerated() {
      let c = CGPoint(x: f.minX + o.u * f.width, y: f.minY + o.v * f.height)
      MEDraw.drawObj(o, center: c, short: short, in: ctx, highlight: i == cv.activeObj && cv.moved)
    }
  }
}

final class MECropOverlay: UIView {
  weak var canvas: MECanvasView?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    isUserInteractionEnabled = false
    contentMode = .redraw
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func draw(_ rect: CGRect) {
    guard let cv = canvas, let ctx = UIGraphicsGetCurrentContext() else { return }
    let d = cv.cropRect
    let e = cv.editRectPx()
    ctx.setFillColor(UIColor(white: 0, alpha: 0.6).cgColor)
    if cv.circleMask {
      // [circle-crop] máscara even-odd: retângulo da imagem menos o círculo inscrito.
      let mask = CGMutablePath()
      mask.addRect(d)
      mask.addEllipse(in: e)
      ctx.addPath(mask)
      ctx.fillPath(using: .evenOdd)
      ctx.setStrokeColor(UIColor(white: 1, alpha: 0.3).cgColor)
      ctx.setLineWidth(1)
      ctx.stroke(e)
      ctx.setStrokeColor(UIColor.white.cgColor)
      ctx.setLineWidth(2)
      ctx.strokeEllipse(in: e)
    } else {
      ctx.fill(CGRect(x: d.minX, y: d.minY, width: d.width, height: max(0, e.minY - d.minY)))
      ctx.fill(CGRect(x: d.minX, y: e.maxY, width: d.width, height: max(0, d.maxY - e.maxY)))
      ctx.fill(CGRect(x: d.minX, y: e.minY, width: max(0, e.minX - d.minX), height: e.height))
      ctx.fill(CGRect(x: e.maxX, y: e.minY, width: max(0, d.maxX - e.maxX), height: e.height))
      ctx.setStrokeColor(UIColor(white: 1, alpha: 0.45).cgColor)
      ctx.setLineWidth(1)
      for i in 1...2 {
        let x = e.minX + e.width * CGFloat(i) / 3
        let y = e.minY + e.height * CGFloat(i) / 3
        ctx.move(to: CGPoint(x: x, y: e.minY)); ctx.addLine(to: CGPoint(x: x, y: e.maxY))
        ctx.move(to: CGPoint(x: e.minX, y: y)); ctx.addLine(to: CGPoint(x: e.maxX, y: y))
      }
      ctx.strokePath()
      ctx.setStrokeColor(UIColor.white.cgColor)
      ctx.setLineWidth(1.5)
      ctx.stroke(e)
    }
    let L: CGFloat = 18
    let t: CGFloat = 3
    let o = t / 2
    ctx.setLineWidth(t)
    ctx.setLineCap(.square)
    let corners: [(CGPoint, CGFloat, CGFloat)] = [
      (CGPoint(x: e.minX - o, y: e.minY - o), 1, 1),
      (CGPoint(x: e.maxX + o, y: e.minY - o), -1, 1),
      (CGPoint(x: e.maxX + o, y: e.maxY + o), -1, -1),
      (CGPoint(x: e.minX - o, y: e.maxY + o), 1, -1),
    ]
    for (p, sx, sy) in corners {
      ctx.move(to: CGPoint(x: p.x + sx * L, y: p.y)); ctx.addLine(to: p); ctx.addLine(to: CGPoint(x: p.x, y: p.y + sy * L))
    }
    ctx.strokePath()
  }
}

final class MECanvasView: UIView {
  enum Mode { case objects, draw, crop }

  weak var host: MECanvasHost?
  private let clipView = UIView()
  private let imageView = UIImageView()
  private let overlay = MEOverlayView()
  private let cropOverlay = MECropOverlay()

  /// Imagem exibida (já girada; filtro aplicado à parte em `filteredImage`).
  var imagePixelSize: CGSize = .zero
  var displayImage: UIImage? {
    didSet { imageView.image = displayImage; setNeedsLayout() }
  }
  var mode: Mode = .objects {
    didSet {
      activeObj = -1
      cropOverlay.isHidden = mode != .crop
      setNeedsLayout()
      overlay.setNeedsDisplay()
    }
  }
  var editCrop = CGRect(x: 0, y: 0, width: 1, height: 1) {
    didSet { cropOverlay.setNeedsDisplay() }
  }
  var cropRatio: CGFloat = 0
  /// [circle-crop] Escurece tudo fora do círculo inscrito na moldura.
  var circleMask = false {
    didSet { cropOverlay.setNeedsDisplay() }
  }

  private(set) var fullRect: CGRect = .zero
  private(set) var cropRect: CGRect = .zero
  var liveStroke: MEStroke?
  private(set) var activeObj = -1
  private(set) var moved = false

  private var touchList: [UITouch] = []
  private var downPt: CGPoint = .zero
  private var downAt: CFTimeInterval = 0
  private var o0 = MEObj(kind: "text", text: "", color: .white, font: 0, bg: 0, u: 0, v: 0, scale: 0, rot: 0)
  private var pinching = false
  private var p0dist: CGFloat = 1
  private var p0ang: CGFloat = 0
  private var p0c: CGPoint = .zero
  private var cropHandle = 0
  private var crop0: CGRect = .zero

  override init(frame: CGRect) {
    super.init(frame: frame)
    isMultipleTouchEnabled = true
    backgroundColor = .black
    clipView.clipsToBounds = true
    clipView.isUserInteractionEnabled = false
    imageView.contentMode = .scaleToFill
    imageView.isUserInteractionEnabled = false
    addSubview(clipView)
    clipView.addSubview(imageView)
    clipView.addSubview(overlay)
    overlay.canvas = self
    cropOverlay.canvas = self
    cropOverlay.isHidden = true
    addSubview(cropOverlay)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func redraw() {
    overlay.setNeedsDisplay()
    cropOverlay.setNeedsDisplay()
  }

  func computeRects() {
    guard imagePixelSize.width > 0, imagePixelSize.height > 0, let host = host else { return }
    let bw = imagePixelSize.width
    let bh = imagePixelSize.height
    let inset: CGFloat = mode == .crop ? 26 : 0
    let aw = max(1, bounds.width - inset * 2)
    let ah = max(1, bounds.height - inset * 2)
    let shown = mode == .crop ? CGRect(x: 0, y: 0, width: 1, height: 1) : host.editorState.crop
    let cw = max(1, shown.width * bw)
    let ch = max(1, shown.height * bh)
    let k = min(aw / cw, ah / ch)
    let dw = cw * k
    let dh = ch * k
    let dl = (bounds.width - dw) / 2
    let dt = (bounds.height - dh) / 2
    cropRect = CGRect(x: dl, y: dt, width: dw, height: dh)
    fullRect = CGRect(x: dl - shown.minX * bw * k, y: dt - shown.minY * bh * k, width: bw * k, height: bh * k)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    computeRects()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    clipView.frame = cropRect
    imageView.frame = fullRect.offsetBy(dx: -cropRect.minX, dy: -cropRect.minY)
    overlay.frame = clipView.bounds
    cropOverlay.frame = bounds
    CATransaction.commit()
    redraw()
  }

  func editRectPx() -> CGRect {
    let f = fullRect
    return CGRect(x: f.minX + editCrop.minX * f.width, y: f.minY + editCrop.minY * f.height,
                  width: editCrop.width * f.width, height: editCrop.height * f.height)
  }

  var shortSide: CGFloat { return min(fullRect.width, fullRect.height) }

  /// r: 0 livre · −1 original · > 0 largura/altura (px).
  func applyRatio(_ r: CGFloat) {
    let bw = imagePixelSize.width
    let bh = imagePixelSize.height
    guard bw > 0, bh > 0 else { return }
    if r == 0 { cropRatio = 0; cropOverlay.setNeedsDisplay(); return }
    let ratio = r < 0 ? bw / bh : r
    cropRatio = ratio
    var w: CGFloat
    var h: CGFloat
    if ratio >= bw / bh { w = 1; h = bw / (ratio * bh) } else { h = 1; w = ratio * bh / bw }
    w = min(1, w); h = min(1, h)
    editCrop = CGRect(x: 0.5 - w / 2, y: 0.5 - h / 2, width: w, height: h)
  }

  // ─── toque ──────────────────────────────────────────────────────────────

  private func hitObj(_ p: CGPoint) -> Int {
    guard let st = host?.editorState else { return -1 }
    let f = fullRect
    let short = shortSide
    for i in stride(from: st.objs.count - 1, through: 0, by: -1) {
      let o = st.objs[i]
      let hb = MEDraw.halfBox(MEDraw.layout(o, short: short))
      let c = CGPoint(x: f.minX + o.u * f.width, y: f.minY + o.v * f.height)
      let dx = p.x - c.x
      let dy = p.y - c.y
      let cs = cos(-o.rot)
      let sn = sin(-o.rot)
      let lx = dx * cs - dy * sn
      let ly = dx * sn + dy * cs
      if abs(lx) <= hb.width + 10 && abs(ly) <= hb.height + 10 { return i }
    }
    return -1
  }

  var trashCenter: CGPoint { return CGPoint(x: bounds.midX, y: bounds.maxY - 64) }
  private func overTrash(_ p: CGPoint) -> Bool { return hypot(p.x - trashCenter.x, p.y - trashCenter.y) < 52 }

  private func norm(_ p: CGPoint) -> CGPoint {
    let f = fullRect
    return CGPoint(x: (p.x - f.minX) / max(1, f.width), y: (p.y - f.minY) / max(1, f.height))
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard displayImage != nil else { return }
    computeRects()
    let wasEmpty = touchList.isEmpty
    for t in touches where !touchList.contains(t) { touchList.append(t) }
    guard let first = touchList.first else { return }
    switch mode {
    case .draw:
      if wasEmpty {
        let short = max(1, shortSide)
        var s = MEStroke(color: host?.brushColor ?? .white, widthRel: (host?.brushWidth ?? 8) / short)
        s.pts.append(norm(first.location(in: self)))
        liveStroke = s
        overlay.setNeedsDisplay()
      }
    case .crop:
      if wasEmpty { cropBegan(first.location(in: self)) }
    case .objects:
      if wasEmpty {
        moved = false
        pinching = false
        downAt = CACurrentMediaTime()
        let p = first.location(in: self)
        let hit = hitObj(p)
        guard hit >= 0, let host = host else { activeObj = -1; return }
        host.beginMutation()
        var st = host.editorState
        let o = st.objs.remove(at: hit)
        st.objs.append(o)
        host.editorState = st
        activeObj = st.objs.count - 1
        rebaseSingle(p)
        overlay.setNeedsDisplay()
      } else if activeObj >= 0 && touchList.count >= 2 {
        pinching = true
        moved = true
        rebasePinch()
      }
    }
  }

  private func rebaseSingle(_ p: CGPoint) {
    guard let st = host?.editorState, st.objs.indices.contains(activeObj) else { return }
    downPt = p
    o0 = st.objs[activeObj]
  }

  private func rebasePinch() {
    guard touchList.count >= 2, let st = host?.editorState, st.objs.indices.contains(activeObj) else { return }
    let a = touchList[0].location(in: self)
    let b = touchList[1].location(in: self)
    p0dist = max(1, hypot(b.x - a.x, b.y - a.y))
    p0ang = atan2(b.y - a.y, b.x - a.x)
    p0c = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
    o0 = st.objs[activeObj]
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard let first = touchList.first else { return }
    switch mode {
    case .draw:
      guard var s = liveStroke, touches.contains(first) else { return }
      let coalesced = event?.coalescedTouches(for: first) ?? [first]
      for t in coalesced { s.pts.append(norm(t.location(in: self))) }
      liveStroke = s
      overlay.setNeedsDisplay()
    case .crop:
      cropMoved(first.location(in: self))
    case .objects:
      guard let host = host else { return }
      var st = host.editorState
      guard st.objs.indices.contains(activeObj) else { return }
      let f = fullRect
      var o = st.objs[activeObj]
      var trash = false
      if pinching && touchList.count >= 2 {
        let a = touchList[0].location(in: self)
        let b = touchList[1].location(in: self)
        let d = max(1, hypot(b.x - a.x, b.y - a.y))
        let ang = atan2(b.y - a.y, b.x - a.x)
        let c = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
        o.scale = min(1.6, max(0.015, o0.scale * d / p0dist))
        o.rot = o0.rot + (ang - p0ang)
        o.u = o0.u + (c.x - p0c.x) / max(1, f.width)
        o.v = o0.v + (c.y - p0c.y) / max(1, f.height)
      } else {
        let p = first.location(in: self)
        let dx = p.x - downPt.x
        let dy = p.y - downPt.y
        if !moved && hypot(dx, dy) > 6 { moved = true }
        guard moved else { return }
        o.u = o0.u + dx / max(1, f.width)
        o.v = o0.v + dy / max(1, f.height)
        trash = overTrash(p)
      }
      st.objs[activeObj] = o
      host.editorState = st
      host.objDragging(true, overTrash: trash)
      overlay.setNeedsDisplay()
    }
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
    finishTouches(touches, cancelled: false)
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
    finishTouches(touches, cancelled: true)
  }

  private func finishTouches(_ touches: Set<UITouch>, cancelled: Bool) {
    let first = touchList.first
    let lastPoint = first?.location(in: self) ?? .zero
    touchList.removeAll { touches.contains($0) }
    switch mode {
    case .draw:
      if let f = first, touches.contains(f) {
        if let s = liveStroke, !cancelled, let host = host {
          host.beginMutation()
          var st = host.editorState
          st.strokes.append(s)
          host.editorState = st
          host.changed()
        }
        liveStroke = nil
        overlay.setNeedsDisplay()
        touchList.removeAll()
      }
    case .crop:
      if touchList.isEmpty { cropHandle = 0; host?.changed() }
    case .objects:
      if !touchList.isEmpty {
        if pinching && touchList.count == 1 {
          pinching = false
          rebaseSingle(touchList[0].location(in: self))
        }
        return
      }
      guard let host = host else { return }
      let idx = activeObj
      let wasMoved = moved
      let trash = !cancelled && wasMoved && !pinching && overTrash(lastPoint)
      activeObj = -1
      moved = false
      pinching = false
      host.objDragging(false, overTrash: false)
      var st = host.editorState
      if st.objs.indices.contains(idx) {
        if trash {
          st.objs.remove(at: idx)
          host.editorState = st
          host.changed()
        } else if !wasMoved {
          host.cancelMutation()
          if !cancelled && CACurrentMediaTime() - downAt < 0.35 { host.objTapped(idx) }
        } else {
          host.changed()
        }
      }
      overlay.setNeedsDisplay()
    }
  }

  // ─── recorte ────────────────────────────────────────────────────────────

  private func cropBegan(_ p: CGPoint) {
    let r = editRectPx()
    let hit: CGFloat = 30
    func d(_ a: CGPoint) -> CGFloat { return hypot(p.x - a.x, p.y - a.y) }
    if d(CGPoint(x: r.minX, y: r.minY)) < hit { cropHandle = 1 }
    else if d(CGPoint(x: r.maxX, y: r.minY)) < hit { cropHandle = 2 }
    else if d(CGPoint(x: r.maxX, y: r.maxY)) < hit { cropHandle = 3 }
    else if d(CGPoint(x: r.minX, y: r.maxY)) < hit { cropHandle = 4 }
    else if abs(p.x - r.minX) < hit * 0.8 && p.y >= r.minY && p.y <= r.maxY { cropHandle = 5 }
    else if abs(p.y - r.minY) < hit * 0.8 && p.x >= r.minX && p.x <= r.maxX { cropHandle = 6 }
    else if abs(p.x - r.maxX) < hit * 0.8 && p.y >= r.minY && p.y <= r.maxY { cropHandle = 7 }
    else if abs(p.y - r.maxY) < hit * 0.8 && p.x >= r.minX && p.x <= r.maxX { cropHandle = 8 }
    else if r.contains(p) { cropHandle = 9 }
    else { cropHandle = 0 }
    if cropRatio > 0 && (5...8).contains(cropHandle) { cropHandle = 9 }
    crop0 = editCrop
    downPt = p
  }

  private func cropMoved(_ p: CGPoint) {
    guard cropHandle != 0 else { return }
    let f = fullRect
    let du = (p.x - downPt.x) / max(1, f.width)
    let dv = (p.y - downPt.y) / max(1, f.height)
    let minU = 64 / max(1, f.width)
    let minV = 64 / max(1, f.height)
    var l = crop0.minX, t = crop0.minY, r = crop0.maxX, b = crop0.maxY
    if cropHandle == 9 {
      let w = crop0.width, h = crop0.height
      l = min(max(0, crop0.minX + du), 1 - w)
      t = min(max(0, crop0.minY + dv), 1 - h)
      r = l + w; b = t + h
    } else if cropRatio > 0 {
      let pxRatio = f.width / max(1, f.height)
      let leftSide = cropHandle == 1 || cropHandle == 4
      let topSide = cropHandle == 1 || cropHandle == 2
      let sign: CGFloat = leftSide ? -1 : 1
      var w = max(minU, crop0.width + sign * du)
      var h = w * pxRatio / cropRatio
      let ax = leftSide ? crop0.maxX : crop0.minX
      let ay = topSide ? crop0.maxY : crop0.minY
      let maxW = leftSide ? ax : 1 - ax
      let maxH = topSide ? ay : 1 - ay
      if w > maxW { w = maxW; h = w * pxRatio / cropRatio }
      if h > maxH { h = maxH; w = h * cropRatio / pxRatio }
      l = leftSide ? ax - w : ax
      t = topSide ? ay - h : ay
      r = l + w; b = t + h
    } else {
      if [1, 4, 5].contains(cropHandle) { l = min(max(0, crop0.minX + du), crop0.maxX - minU) }
      if [2, 3, 7].contains(cropHandle) { r = max(min(1, crop0.maxX + du), crop0.minX + minU) }
      if [1, 2, 6].contains(cropHandle) { t = min(max(0, crop0.minY + dv), crop0.maxY - minV) }
      if [3, 4, 8].contains(cropHandle) { b = max(min(1, crop0.maxY + dv), crop0.minY + minV) }
    }
    editCrop = CGRect(x: l, y: t, width: r - l, height: b - t)
  }
}
