import UIKit
import AVFoundation

// [2026-10-15 native-status-studio] Palco 9:16: mídia (foto filtrada / vídeo em
// loop) + traços (pincéis) + camadas queimáveis (texto/emoji/local, desenhadas
// com Core Graphics — mesma rotina da exportação) + blocos interativos
// (UIViews no tamanho do viewer, escalados). Gestos multitoque à mão:
// arrastar / pinçar / girar, guia de centro com háptico, lixeira, deslizar
// horizontal para trocar o filtro (divisória acompanha o dedo).

protocol SSStageHost: AnyObject {
  var stageItem: SSItemState? { get }
  var brushColor: UIColor { get }
  var brushWidth: CGFloat { get }
  var brushKind: SSBrush { get }
  var options: SSOptions { get }
  func stageWillMutate()
  func stageChanged()
  func stageTappedEmpty()
  func stageLayerTapped(_ l: SSLayer)
  func stageDragging(_ active: Bool)
  func stageFilterImage(_ idx: Int) -> UIImage?
  func stageCommitFilter(_ idx: Int)
}

final class SSStrokesView: UIView {
  weak var stage: SSStageView?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    isUserInteractionEnabled = false
    contentMode = .redraw
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  override func draw(_ rect: CGRect) {
    guard let st = stage, let item = st.host?.stageItem, let ctx = UIGraphicsGetCurrentContext() else { return }
    let f = bounds
    for s in item.strokes { SSDraw.drawStroke(s, in: f, ctx: ctx) }
    if let live = st.liveStroke { SSDraw.drawStroke(live, in: f, ctx: ctx) }
  }
}

final class SSLayersView: UIView {
  weak var stage: SSStageView?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    isUserInteractionEnabled = false
    contentMode = .redraw
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  override func draw(_ rect: CGRect) {
    guard let st = stage, let item = st.host?.stageItem, let ctx = UIGraphicsGetCurrentContext() else { return }
    let W = bounds.width
    let H = bounds.height
    for l in item.layers where l.kind.burns {
      if l.id == st.hiddenLayerId { continue }
      let a: CGFloat = (l.id == st.activeId && st.overTrash) ? 0.45 : 1
      SSDraw.drawLayer(l, center: CGPoint(x: l.u * W, y: l.v * H), W: W, in: ctx, alpha: a)
    }
  }
}

final class SSStageView: UIView {
  enum Mode { case objects, draw, locked }

  weak var host: SSStageHost?
  var mode: Mode = .objects { didSet { if mode != .objects { endDrag() } } }

  let bgView = UIView()
  let imageView = UIImageView()
  private let swipeView = UIImageView()
  private let swipeMask = CALayer()
  let playerView = SSPlayerView()
  let strokesView = SSStrokesView()
  let layersView = SSLayersView()
  let widgetsHost = UIView()
  private let vGuide = UIView()
  private let hGuide = UIView()
  let trash = UIView()
  private let trashIcon = UIImageView()
  private var widgetViews: [String: SSWidgetView] = [:]

  var liveStroke: SSStroke?
  private(set) var activeId: String?
  private(set) var overTrash = false
  var hiddenLayerId: String?

  // gesto
  private var touchList: [UITouch] = []
  private var downPt: CGPoint = .zero
  private var downAt: CFTimeInterval = 0
  private var moved = false
  private var pinching = false
  private var p0dist: CGFloat = 1
  private var p0ang: CGFloat = 0
  private var p0c: CGPoint = .zero
  private var l0 = (u: CGFloat(0), v: CGFloat(0), size: CGFloat(0), rot: CGFloat(0))
  private var snapX = false
  private var snapY = false
  private var swiping = false
  private var swipeTarget = -1
  private var lastMoveAt: CFTimeInterval = 0
  private var lastMoveX: CGFloat = 0
  private var velocityX: CGFloat = 0

  override init(frame: CGRect) {
    super.init(frame: frame)
    isMultipleTouchEnabled = true
    clipsToBounds = true
    layer.cornerRadius = 16
    backgroundColor = .black
    bgView.isUserInteractionEnabled = false
    addSubview(bgView)
    imageView.contentMode = .scaleAspectFit
    imageView.isUserInteractionEnabled = false
    addSubview(imageView)
    swipeView.contentMode = .scaleAspectFit
    swipeView.isUserInteractionEnabled = false
    swipeView.isHidden = true
    swipeMask.backgroundColor = UIColor.black.cgColor
    swipeView.layer.mask = swipeMask
    addSubview(swipeView)
    playerView.isHidden = true
    playerView.isUserInteractionEnabled = false
    addSubview(playerView)
    strokesView.stage = self
    addSubview(strokesView)
    layersView.stage = self
    addSubview(layersView)
    widgetsHost.isUserInteractionEnabled = false
    addSubview(widgetsHost)
    for g in [vGuide, hGuide] {
      g.backgroundColor = UIColor(red: 0.2, green: 0.75, blue: 1, alpha: 0.95)
      g.isHidden = true
      g.isUserInteractionEnabled = false
      addSubview(g)
    }
    trash.backgroundColor = UIColor(white: 0, alpha: 0.45)
    trash.layer.cornerRadius = 26
    trash.layer.borderWidth = 1.5
    trash.layer.borderColor = UIColor(white: 1, alpha: 0.8).cgColor
    trash.isHidden = true
    trash.isUserInteractionEnabled = false
    trashIcon.image = ssSymbol("trash", 20, .semibold)
    trashIcon.tintColor = .white
    trashIcon.contentMode = .center
    trash.addSubview(trashIcon)
    addSubview(trash)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = bounds
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    bgView.frame = b
    imageView.frame = b
    swipeView.frame = b
    playerView.frame = b
    strokesView.frame = b
    layersView.frame = b
    widgetsHost.frame = b
    vGuide.frame = CGRect(x: b.midX - 0.75, y: 0, width: 1.5, height: b.height)
    hGuide.frame = CGRect(x: 0, y: b.midY - 0.75, width: b.width, height: 1.5)
    trash.frame = CGRect(x: b.midX - 26, y: b.maxY - 26 - 70, width: 52, height: 52)
    trashIcon.frame = trash.bounds
    CATransaction.commit()
    layoutWidgets()
    redraw()
  }

  func redraw() {
    strokesView.setNeedsDisplay()
    layersView.setNeedsDisplay()
  }

  /// Escala dos blocos: viewer (tela cheia) → palco.
  var widgetScale: CGFloat {
    let sw = max(1, UIScreen.main.bounds.width)
    return bounds.width / sw
  }

  /// Recria/atualiza as UIViews dos blocos interativos.
  func syncWidgets() {
    guard let item = host?.stageItem, let opts = host?.options else {
      for (_, v) in widgetViews { v.removeFromSuperview() }
      widgetViews.removeAll()
      return
    }
    var keep = Set<String>()
    for l in item.layers where l.kind.isWidget {
      keep.insert(l.id)
      if let v = widgetViews[l.id] {
        v.apply(l, opts)
        widgetsHost.bringSubviewToFront(v)
      } else if let v = SSWidgetView.make(l, opts) {
        widgetViews[l.id] = v
        widgetsHost.addSubview(v)
      }
    }
    for (id, v) in widgetViews where !keep.contains(id) {
      v.removeFromSuperview()
      widgetViews.removeValue(forKey: id)
    }
    layoutWidgets()
  }

  func layoutWidgets() {
    guard let item = host?.stageItem else { return }
    let k = widgetScale
    let W = bounds.width
    let H = bounds.height
    for l in item.layers where l.kind.isWidget {
      guard let v = widgetViews[l.id] else { continue }
      let s = v.blockSize
      v.transform = .identity
      v.bounds = CGRect(origin: .zero, size: s)
      v.center = CGPoint(x: l.u * W, y: l.v * H)
      let fade: CGFloat = (l.id == activeId && overTrash) ? 0.45 : 1
      v.transform = CGAffineTransform(scaleX: k * (fade < 1 ? 0.7 : 1), y: k * (fade < 1 ? 0.7 : 1))
      v.alpha = fade
      v.isHidden = l.id == hiddenLayerId
    }
  }

  func widgetBlockSize(_ l: SSLayer) -> CGSize? {
    return widgetViews[l.id]?.blockSize
  }

  func tickWidgets() {
    for (_, v) in widgetViews { (v as? SSCountdownWidget)?.tick() }
  }

  // MARK: hit-test

  private func halfSize(_ l: SSLayer) -> CGSize {
    if l.kind.isWidget {
      let s = widgetViews[l.id]?.blockSize ?? CGSize(width: 200, height: 60)
      let k = widgetScale
      return CGSize(width: s.width * k / 2, height: s.height * k / 2)
    }
    return SSDraw.layout(l, W: bounds.width).box
  }

  private func hit(_ p: CGPoint) -> SSLayer? {
    guard let item = host?.stageItem else { return nil }
    let W = bounds.width
    let H = bounds.height
    // blocos ficam por cima das camadas queimadas
    let ordered = item.layers.filter { $0.kind.burns } + item.layers.filter { $0.kind.isWidget }
    for l in ordered.reversed() {
      let hb = halfSize(l)
      let c = CGPoint(x: l.u * W, y: l.v * H)
      let dx = p.x - c.x
      let dy = p.y - c.y
      let cs = cos(-l.rot)
      let sn = sin(-l.rot)
      let lx = dx * cs - dy * sn
      let ly = dx * sn + dy * cs
      if abs(lx) <= hb.width + 12 && abs(ly) <= hb.height + 12 { return l }
    }
    return nil
  }

  private func activeLayer() -> SSLayer? {
    guard let id = activeId else { return nil }
    return host?.stageItem?.layers.first { $0.id == id }
  }

  // MARK: toques

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard mode != .locked else { return }
    let wasEmpty = touchList.isEmpty
    for t in touches where !touchList.contains(t) { touchList.append(t) }
    guard let first = touchList.first else { return }
    let p = first.location(in: self)
    switch mode {
    case .draw:
      if wasEmpty, let h = host {
        var s = SSStroke(color: h.brushColor, width: h.brushWidth / max(1, bounds.width), brush: h.brushKind)
        s.pts.append(norm(p))
        liveStroke = s
        strokesView.setNeedsDisplay()
      }
    case .objects:
      if wasEmpty {
        moved = false
        pinching = false
        swiping = false
        swipeTarget = -1
        downAt = CACurrentMediaTime()
        downPt = p
        lastMoveX = p.x
        lastMoveAt = downAt
        velocityX = 0
        if let l = hit(p), let item = host?.stageItem {
          // traz p/ frente
          if let i = item.layers.firstIndex(where: { $0 === l }) {
            item.layers.remove(at: i)
            item.layers.append(l)
          }
          activeId = l.id
          l0 = (l.u, l.v, l.size, l.rot)
          syncWidgets()
          redraw()
        } else {
          activeId = nil
        }
      } else if activeId != nil && touchList.count >= 2 {
        if let l = activeLayer(), l.kind.burns {
          pinching = true
          if !moved { moved = true; host?.stageWillMutate() }
          rebasePinch(l)
        }
      }
    case .locked:
      break
    }
  }

  private func norm(_ p: CGPoint) -> CGPoint {
    return CGPoint(x: p.x / max(1, bounds.width), y: p.y / max(1, bounds.height))
  }

  private func rebasePinch(_ l: SSLayer) {
    guard touchList.count >= 2 else { return }
    let a = touchList[0].location(in: self)
    let b = touchList[1].location(in: self)
    p0dist = max(1, hypot(b.x - a.x, b.y - a.y))
    p0ang = atan2(b.y - a.y, b.x - a.x)
    p0c = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
    l0 = (l.u, l.v, l.size, l.rot)
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard mode != .locked, let first = touchList.first else { return }
    let W = max(1, bounds.width)
    let H = max(1, bounds.height)
    switch mode {
    case .draw:
      guard var s = liveStroke, touches.contains(first) else { return }
      let co = event?.coalescedTouches(for: first) ?? [first]
      for t in co { s.pts.append(norm(t.location(in: self))) }
      liveStroke = s
      strokesView.setNeedsDisplay()
    case .objects:
      let p = first.location(in: self)
      let now = CACurrentMediaTime()
      if now - lastMoveAt > 0.001 {
        velocityX = (p.x - lastMoveX) / CGFloat(now - lastMoveAt)
        lastMoveX = p.x
        lastMoveAt = now
      }
      guard let l = activeLayer() else {
        // sem camada: deslizar horizontal troca filtro
        let dx = p.x - downPt.x
        let dy = p.y - downPt.y
        if !swiping && !moved && abs(dx) > 14 && abs(dx) > abs(dy) * 1.4 { swiping = true; moved = true }
        if !moved && hypot(dx, dy) > 8 { moved = true }
        if swiping { updateSwipe(dx) }
        return
      }
      if pinching && touchList.count >= 2 {
        let a = touchList[0].location(in: self)
        let b = touchList[1].location(in: self)
        let d = max(1, hypot(b.x - a.x, b.y - a.y))
        let ang = atan2(b.y - a.y, b.x - a.x)
        let c = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
        l.size = min(0.6, max(0.02, l0.size * d / p0dist))
        var rot = l0.rot + (ang - p0ang)
        // ímã nos ângulos retos (±4°)
        let q = (rot / (.pi / 2)).rounded() * (.pi / 2)
        if abs(rot - q) < 0.07 { rot = q }
        l.rot = rot
        l.u = l0.u + (c.x - p0c.x) / W
        l.v = l0.v + (c.y - p0c.y) / H
        setOverTrash(false)
      } else {
        let dx = p.x - downPt.x
        let dy = p.y - downPt.y
        if !moved && hypot(dx, dy) > 6 {
          moved = true
          host?.stageWillMutate()
          host?.stageDragging(true)
          trash.isHidden = false
        }
        guard moved else { return }
        var cx = l0.u * W + dx
        var cy = l0.v * H + dy
        let sx = abs(cx - W / 2) < 6
        let sy = abs(cy - H / 2) < 6
        if sx { cx = W / 2 }
        if sy { cy = H / 2 }
        if sx != snapX { snapX = sx; vGuide.isHidden = !sx; if sx { ssHaptic("select") } }
        if sy != snapY { snapY = sy; hGuide.isHidden = !sy; if sy { ssHaptic("select") } }
        l.u = cx / W
        l.v = cy / H
        setOverTrash(hypot(p.x - trash.center.x, p.y - trash.center.y) < 56)
      }
      if l.kind.isWidget { layoutWidgets() } else { layersView.setNeedsDisplay() }
    case .locked:
      break
    }
  }

  private func setOverTrash(_ on: Bool) {
    guard on != overTrash else { return }
    overTrash = on
    if on { ssHaptic("medium") }
    UIView.animate(withDuration: 0.15) {
      self.trash.backgroundColor = on ? UIColor(red: 0.94, green: 0.27, blue: 0.27, alpha: 1) : UIColor(white: 0, alpha: 0.45)
      self.trash.transform = on ? CGAffineTransform(scaleX: 1.22, y: 1.22) : .identity
    }
    layoutWidgets()
    layersView.setNeedsDisplay()
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
    finish(touches, cancelled: false)
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
    finish(touches, cancelled: true)
  }

  private func finish(_ touches: Set<UITouch>, cancelled: Bool) {
    let first = touchList.first
    touchList.removeAll { touches.contains($0) }
    switch mode {
    case .draw:
      if let f = first, touches.contains(f) {
        if let s = liveStroke, !cancelled, let item = host?.stageItem {
          host?.stageWillMutate()
          item.strokes.append(s)
          host?.stageChanged()
        }
        liveStroke = nil
        strokesView.setNeedsDisplay()
        touchList.removeAll()
      }
    case .objects:
      if !touchList.isEmpty {
        if pinching && touchList.count == 1, let l = activeLayer() {
          pinching = false
          downPt = touchList[0].location(in: self)
          l0 = (l.u, l.v, l.size, l.rot)
        }
        return
      }
      if swiping {
        endSwipe(cancelled: cancelled)
        swiping = false
        moved = false
        return
      }
      guard let l = activeLayer() else {
        if !moved && !cancelled && CACurrentMediaTime() - downAt < 0.35 { host?.stageTappedEmpty() }
        moved = false
        return
      }
      let wasMoved = moved
      let del = !cancelled && wasMoved && overTrash
      if del, let item = host?.stageItem {
        item.layers.removeAll { $0 === l }
        ssHaptic("light")
      }
      endDrag()
      if del {
        syncWidgets()
        host?.stageChanged()
      } else if !wasMoved {
        if !cancelled && CACurrentMediaTime() - downAt < 0.35 { host?.stageLayerTapped(l) }
      } else {
        host?.stageChanged()
      }
      redraw()
    case .locked:
      break
    }
  }

  private func endDrag() {
    let was = moved && activeId != nil
    activeId = nil
    moved = false
    pinching = false
    snapX = false
    snapY = false
    vGuide.isHidden = true
    hGuide.isHidden = true
    trash.isHidden = true
    overTrash = false
    trash.transform = .identity
    trash.backgroundColor = UIColor(white: 0, alpha: 0.45)
    if was { host?.stageDragging(false) }
    layoutWidgets()
  }

  // MARK: deslizar filtro

  private func updateSwipe(_ dx: CGFloat) {
    guard let item = host?.stageItem, !item.media.isVideo else { return }
    let n = host?.options.filters.count ?? 0
    let target = dx < 0 ? item.filterIdx + 1 : item.filterIdx - 1
    guard target >= 0, target < n else { swipeView.isHidden = true; return }
    if target != swipeTarget {
      swipeTarget = target
      swipeView.image = host?.stageFilterImage(target)
    }
    swipeView.isHidden = false
    let W = bounds.width
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    if dx < 0 {
      let split = W + dx
      swipeMask.frame = CGRect(x: split, y: 0, width: W - split, height: bounds.height)
    } else {
      swipeMask.frame = CGRect(x: 0, y: 0, width: dx, height: bounds.height)
    }
    CATransaction.commit()
  }

  private func endSwipe(cancelled: Bool) {
    let dx = (touchList.first?.location(in: self).x ?? lastMoveX) - downPt.x
    let commit = !cancelled && swipeTarget >= 0 && (abs(dx) > bounds.width * 0.22 || abs(velocityX) > 600)
    let target = swipeTarget
    if commit {
      let W = bounds.width
      CATransaction.begin()
      CATransaction.setAnimationDuration(0.18)
      CATransaction.setCompletionBlock { [weak self] in
        self?.host?.stageCommitFilter(target)
        self?.swipeView.isHidden = true
      }
      swipeMask.frame = CGRect(x: 0, y: 0, width: W, height: bounds.height)
      CATransaction.commit()
    } else {
      swipeView.isHidden = true
    }
    swipeTarget = -1
  }
}

/// AVPlayerLayer como layer da view (vídeo em loop no palco).
final class SSPlayerView: UIView {
  override class var layerClass: AnyClass { return AVPlayerLayer.self }
  var playerLayer: AVPlayerLayer { return layer as! AVPlayerLayer }
}
