import UIKit

// [2026-10-15 native-editor] Trilho de corte do vídeo: miniaturas, alças
// brancas, fora do corte escurecido, cursor. Modo capa: arrastar escolhe o quadro.

protocol MERailDelegate: AnyObject {
  func railRangeChanging(start: Double, end: Double, editingStart: Bool)
  func railRangeChanged(start: Double, end: Double)
  func railCoverChanging(_ ms: Double)
  func railCoverChanged(_ ms: Double)
  func railSeek(_ ms: Double)
}

final class MERailView: UIView {
  weak var delegate: MERailDelegate?
  var durationMs: Double = 0 { didSet { setNeedsDisplay() } }
  var startMs: Double = 0
  var endMs: Double = 0
  var minRangeMs: Double = 1000
  var playheadMs: Double = -1 { didSet { setNeedsDisplay() } }
  var coverMs: Double = -1
  var coverMode = false { didSet { setNeedsDisplay() } }
  var thumbs: [UIImage?] = [] { didSet { setNeedsDisplay() } }

  private let handleW: CGFloat = 14
  private var dragging = 0

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    contentMode = .redraw
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private var trackL: CGFloat { return handleW }
  private var trackR: CGFloat { return bounds.width - handleW }
  private var trackW: CGFloat { return max(1, trackR - trackL) }
  private func x(_ ms: Double) -> CGFloat { return trackL + trackW * CGFloat(durationMs > 0 ? ms / durationMs : 0) }
  private func ms(_ x: CGFloat) -> Double {
    guard durationMs > 0 else { return 0 }
    return Double(min(1, max(0, (x - trackL) / trackW))) * durationMs
  }

  override func draw(_ rect: CGRect) {
    guard let ctx = UIGraphicsGetCurrentContext() else { return }
    let top: CGFloat = 4
    let bottom = bounds.height - 4
    let th = bottom - top
    let n = max(1, thumbs.count)
    let cell = trackW / CGFloat(n)
    ctx.saveGState()
    ctx.clip(to: CGRect(x: trackL, y: top, width: trackW, height: th))
    for i in 0..<n {
      let dst = CGRect(x: trackL + CGFloat(i) * cell, y: top, width: cell + 1, height: th)
      if i < thumbs.count, let img = thumbs[i] {
        // center-crop
        let s = img.size
        let k = max(dst.width / max(1, s.width), dst.height / max(1, s.height))
        let w = s.width * k
        let h = s.height * k
        ctx.saveGState()
        ctx.clip(to: dst)
        img.draw(in: CGRect(x: dst.midX - w / 2, y: dst.midY - h / 2, width: w, height: h))
        ctx.restoreGState()
      } else {
        ctx.setFillColor(UIColor(white: 0.13, alpha: 1).cgColor)
        ctx.fill(dst)
      }
    }
    ctx.restoreGState()

    if coverMode {
      let cx = x(max(0, coverMs))
      let half = min(th * 0.42, 22)
      let p = UIBezierPath(roundedRect: CGRect(x: cx - half, y: top - 2, width: half * 2, height: th + 4), cornerRadius: 6)
      p.lineWidth = 2.5
      UIColor.white.setStroke()
      p.stroke()
      return
    }

    let sx = x(startMs)
    let ex = x(endMs)
    ctx.setFillColor(UIColor(white: 0, alpha: 0.65).cgColor)
    ctx.fill(CGRect(x: trackL, y: top, width: max(0, sx - trackL), height: th))
    ctx.fill(CGRect(x: ex, y: top, width: max(0, trackR - ex), height: th))
    let bar: CGFloat = 2.5
    UIColor.white.setFill()
    ctx.fill(CGRect(x: sx, y: top - bar / 2, width: max(0, ex - sx), height: bar))
    ctx.fill(CGRect(x: sx, y: bottom - bar / 2, width: max(0, ex - sx), height: bar))
    let lh = CGRect(x: sx - handleW, y: top - bar / 2, width: handleW, height: th + bar)
    let rh = CGRect(x: ex, y: top - bar / 2, width: handleW, height: th + bar)
    UIBezierPath(roundedRect: lh, byRoundingCorners: [.topLeft, .bottomLeft], cornerRadii: CGSize(width: 5, height: 5)).fill()
    UIBezierPath(roundedRect: rh, byRoundingCorners: [.topRight, .bottomRight], cornerRadii: CGSize(width: 5, height: 5)).fill()
    ctx.setStrokeColor(UIColor.black.cgColor)
    ctx.setLineWidth(2)
    ctx.setLineCap(.round)
    let gh = th * 0.18
    ctx.move(to: CGPoint(x: lh.midX, y: lh.midY - gh)); ctx.addLine(to: CGPoint(x: lh.midX, y: lh.midY + gh))
    ctx.move(to: CGPoint(x: rh.midX, y: rh.midY - gh)); ctx.addLine(to: CGPoint(x: rh.midX, y: rh.midY + gh))
    ctx.strokePath()
    if playheadMs >= startMs && playheadMs <= endMs {
      let px = x(playheadMs)
      UIColor.white.setFill()
      UIBezierPath(roundedRect: CGRect(x: px - 1.5, y: top, width: 3, height: th), cornerRadius: 1.5).fill()
    }
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard durationMs > 0, let t = touches.first else { return }
    let p = t.location(in: self)
    if coverMode {
      dragging = 3
      coverMs = ms(p.x)
      delegate?.railCoverChanging(coverMs)
      setNeedsDisplay()
      return
    }
    let sx = x(startMs)
    let ex = x(endMs)
    let ds = abs(p.x - (sx - handleW / 2))
    let de = abs(p.x - (ex + handleW / 2))
    if ds < 28 && ds <= de { dragging = 1 }
    else if de < 28 { dragging = 2 }
    else {
      dragging = 0
      let m = min(endMs, max(startMs, ms(p.x)))
      playheadMs = m
      delegate?.railSeek(m)
    }
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard let t = touches.first else { return }
    let p = t.location(in: self)
    switch dragging {
    case 1:
      startMs = min(max(0, ms(p.x + handleW / 2)), max(0, endMs - minRangeMs))
      delegate?.railRangeChanging(start: startMs, end: endMs, editingStart: true)
    case 2:
      endMs = max(min(durationMs, ms(p.x - handleW / 2)), min(durationMs, startMs + minRangeMs))
      delegate?.railRangeChanging(start: startMs, end: endMs, editingStart: false)
    case 3:
      coverMs = ms(p.x)
      delegate?.railCoverChanging(coverMs)
    default:
      return
    }
    setNeedsDisplay()
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
    switch dragging {
    case 1, 2: delegate?.railRangeChanged(start: startMs, end: endMs)
    case 3: delegate?.railCoverChanged(coverMs)
    default: break
    }
    dragging = 0
    setNeedsDisplay()
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
    touchesEnded(touches, with: event)
  }
}
