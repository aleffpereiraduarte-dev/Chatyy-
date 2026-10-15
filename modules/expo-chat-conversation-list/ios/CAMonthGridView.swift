import UIKit

// [2026-10-15 native-apps] Grade do MÊS do calendário nativo (iOS).
// Desenho próprio em CoreGraphics (P&B do app): número tabular, hoje = círculo
// cheio na tinta do tema, selecionado = círculo neutro, até 3 pontos coloridos
// (+N), ponto vermelho "ao vivo", faixas finas de eventos de vários dias.
// Toque = seleciona; toque longo = criar no dia; arrastar p/ os lados = troca
// o mês (segue o dedo; solta >50pt ou rápido → próximo/anterior, igual ao JS).
// Mesmo desenho do Android (CAMonthGridView.kt).

final class CAMonthGridView: UIView, UIGestureRecognizerDelegate {
  static let rowH: CGFloat = 56
  static let padH: CGFloat = 6
  static let padTop: CGFloat = 6
  static let padBottom: CGFloat = 4

  var onSelect: ((String) -> Void)?
  var onLongPress: ((String) -> Void)?
  var onMonthSwipe: ((Int) -> Void)?

  private(set) var year = 2026
  private(set) var month = 0
  private var firstWeekday = 0
  private var cells: [CACell] = []
  private var selected = ""
  private var today = ""
  private var marks: [String: CAMark] = [:]
  private var style = CAStyle()
  private var labels = CALabels()
  private var lastMonthIndex = -1
  private let pan = UIPanGestureRecognizer()

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    contentMode = .redraw
    let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
    addGestureRecognizer(tap)
    let lp = UILongPressGestureRecognizer(target: self, action: #selector(longPressed(_:)))
    lp.minimumPressDuration = 0.45
    addGestureRecognizer(lp)
    pan.addTarget(self, action: #selector(panned(_:)))
    pan.delegate = self
    addGestureRecognizer(pan)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  static func height(weeks: Int) -> CGFloat {
    return padTop + CGFloat(weeks) * rowH + padBottom
  }

  var weeks: Int { max(1, cells.count / 7) }
  var preferredHeight: CGFloat { CAMonthGridView.height(weeks: weeks) }

  // MARK: - Dados

  /// Retorna true quando o número de semanas mudou (altura nova).
  @discardableResult
  func update(year y: Int, month m: Int, firstWeekday fw: Int, selected sel: String, today td: String,
              marks mk: [String: CAMark], style st: CAStyle, labels lb: CALabels) -> Bool {
    let oldWeeks = cells.isEmpty ? 0 : weeks
    let monthIdx = y * 12 + m
    let monthChanged = monthIdx != lastMonthIndex || fw != firstWeekday || cells.isEmpty
    year = y; month = m; firstWeekday = fw
    selected = sel; today = td; marks = mk; style = st; labels = lb
    if monthChanged {
      cells = CAGrid.cells(year: y, month: m, firstWeekday: fw)
      if lastMonthIndex >= 0 && window != nil {
        animateIn(dir: monthIdx > lastMonthIndex ? 1 : -1)
      }
      lastMonthIndex = monthIdx
    }
    rebuildAccessibility()
    setNeedsDisplay()
    return oldWeeks != weeks
  }

  private func animateIn(dir: Int) {
    layer.removeAllAnimations()
    alpha = 0.2
    transform = CGAffineTransform(translationX: CGFloat(dir) * 36, y: 0)
    UIView.animate(withDuration: 0.32, delay: 0, usingSpringWithDamping: 0.82, initialSpringVelocity: 0,
                   options: [.allowUserInteraction, .beginFromCurrentState]) {
      self.alpha = 1
      self.transform = .identity
    }
  }

  // MARK: - Geometria

  private func cellRect(_ i: Int) -> CGRect {
    let w = (bounds.width - CAMonthGridView.padH * 2) / 7
    let col = i % 7
    let row = i / 7
    return CGRect(x: CAMonthGridView.padH + CGFloat(col) * w,
                  y: CAMonthGridView.padTop + CGFloat(row) * CAMonthGridView.rowH,
                  width: w, height: CAMonthGridView.rowH)
  }

  private func index(at p: CGPoint) -> Int? {
    let w = (bounds.width - CAMonthGridView.padH * 2) / 7
    guard w > 0 else { return nil }
    let col = Int(floor((p.x - CAMonthGridView.padH) / w))
    let row = Int(floor((p.y - CAMonthGridView.padTop) / CAMonthGridView.rowH))
    guard col >= 0, col < 7, row >= 0 else { return nil }
    let i = row * 7 + col
    return i < cells.count ? i : nil
  }

  // MARK: - Desenho

  override func draw(_ rect: CGRect) {
    guard let ctx = UIGraphicsGetCurrentContext() else { return }
    let c = style.colors
    let numFont = UIFont.monospacedDigitSystemFont(ofSize: 16, weight: .medium)
    let numBold = UIFont.monospacedDigitSystemFont(ofSize: 16, weight: .bold)
    let moreFont = UIFont.monospacedDigitSystemFont(ofSize: 9, weight: .bold)
    let liveRed = UIColor(clHex: 0xDC2626)
    for (i, cell) in cells.enumerated() {
      let r = cellRect(i)
      if !r.intersects(rect) { continue }
      let isToday = cell.key == today
      let isSel = cell.key == selected
      let other = !cell.current
      // Círculo (32) a 4pt do topo.
      let circle = CGRect(x: r.midX - 16, y: r.minY + 4, width: 32, height: 32)
      if isToday {
        ctx.setFillColor(c.text.cgColor)
        ctx.fillEllipse(in: circle)
      } else if isSel {
        ctx.setFillColor(style.selBg.cgColor)
        ctx.fillEllipse(in: circle)
      }
      var ink = other ? c.faint.withAlphaComponent(0.55) : c.text
      if isToday { ink = c.bg }
      let font = (isToday || isSel) ? numBold : numFont
      let s = String(cell.day) as NSString
      let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: ink, .kern: -0.2]
      let sz = s.size(withAttributes: attrs)
      s.draw(at: CGPoint(x: circle.midX - sz.width / 2, y: circle.midY - sz.height / 2), withAttributes: attrs)

      guard let mk = marks[cell.key] else { continue }
      // Pontos: linha de 10pt, 3pt abaixo do círculo.
      let dotsY = circle.maxY + 3 + 5
      if mk.live {
        ctx.setFillColor(liveRed.withAlphaComponent(other ? 0.4 : 1).cgColor)
        ctx.fillEllipse(in: CGRect(x: r.midX - 3, y: dotsY - 3, width: 6, height: 6))
      } else if !mk.dots.isEmpty || mk.count > 0 {
        let dots = mk.dots.isEmpty ? [c.text] : mk.dots
        let extra: NSString? = mk.count > 3 ? ("+\(mk.count - 3)" as NSString) : nil
        let moreAttrs: [NSAttributedString.Key: Any] = [.font: moreFont, .foregroundColor: c.faint]
        let moreW = extra?.size(withAttributes: moreAttrs).width ?? 0
        let total = CGFloat(dots.count) * 5 + CGFloat(max(0, dots.count - 1)) * 3 + (extra != nil ? 1 + 3 + moreW : 0)
        var x = r.midX - total / 2
        for d in dots {
          ctx.setFillColor(d.withAlphaComponent(other ? 0.4 : 1).cgColor)
          ctx.fillEllipse(in: CGRect(x: x, y: dotsY - 2.5, width: 5, height: 5))
          x += 8
        }
        if let e = extra {
          let h = e.size(withAttributes: moreAttrs).height
          e.draw(at: CGPoint(x: x - 3 + 1, y: dotsY - h / 2), withAttributes: moreAttrs)
        }
      }
      // Faixas de vários dias (de baixo p/ cima, 3pt, 2pt entre elas).
      var sy = r.maxY - 2 - 3
      for st in mk.stripes {
        let x0 = st.first ? r.minX + 4 : r.minX
        let x1 = st.last ? r.maxX - 4 : r.maxX
        let sr = CGRect(x: x0, y: sy, width: max(0, x1 - x0), height: 3)
        var corners: UIRectCorner = []
        if st.first { corners.formUnion([.topLeft, .bottomLeft]) }
        if st.last { corners.formUnion([.topRight, .bottomRight]) }
        let path = UIBezierPath(roundedRect: sr, byRoundingCorners: corners, cornerRadii: CGSize(width: 1.5, height: 1.5))
        ctx.setFillColor(st.color.withAlphaComponent(other ? 0.3 : 0.75).cgColor)
        ctx.addPath(path.cgPath)
        ctx.fillPath()
        sy -= 5
      }
    }
  }

  // MARK: - Gestos

  @objc private func tapped(_ g: UITapGestureRecognizer) {
    guard let i = index(at: g.location(in: self)) else { return }
    UISelectionFeedbackGenerator().selectionChanged()
    onSelect?(cells[i].key)
  }

  @objc private func longPressed(_ g: UILongPressGestureRecognizer) {
    guard g.state == .began, let i = index(at: g.location(in: self)), cells[i].current else { return }
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    onLongPress?(cells[i].key)
  }

  @objc private func panned(_ g: UIPanGestureRecognizer) {
    let dx = g.translation(in: self).x
    switch g.state {
    case .changed:
      transform = CGAffineTransform(translationX: dx * 0.4, y: 0)
    case .ended:
      let vx = g.velocity(in: self).x
      if dx < -50 || vx < -600 {
        UISelectionFeedbackGenerator().selectionChanged()
        onMonthSwipe?(1)
        settleIfUnchanged()
      } else if dx > 50 || vx > 600 {
        UISelectionFeedbackGenerator().selectionChanged()
        onMonthSwipe?(-1)
        settleIfUnchanged()
      } else {
        springBack()
      }
    case .cancelled, .failed:
      springBack()
    default:
      break
    }
  }

  /// Se o JS não trocar o mês em seguida, a grade volta ao lugar.
  private func settleIfUnchanged() {
    let idx = lastMonthIndex
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
      guard let self = self, self.lastMonthIndex == idx, self.transform != .identity else { return }
      self.springBack()
    }
  }

  private func springBack() {
    UIView.animate(withDuration: 0.3, delay: 0, usingSpringWithDamping: 0.75, initialSpringVelocity: 0,
                   options: [.allowUserInteraction, .beginFromCurrentState]) {
      self.transform = .identity
    }
  }

  override func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
    if g === pan {
      let v = pan.velocity(in: self)
      return abs(v.x) > abs(v.y) * 1.8
    }
    return true
  }

  // MARK: - Acessibilidade (uma célula por dia)

  private final class DayElement: UIAccessibilityElement {
    var activate: (() -> Void)?
    override func accessibilityActivate() -> Bool {
      activate?()
      return true
    }
  }

  private var a11yItems: [DayElement] = []

  private func rebuildAccessibility() {
    var items: [DayElement] = []
    items.reserveCapacity(cells.count)
    for (i, cell) in cells.enumerated() {
      let e = DayElement(accessibilityContainer: self)
      var label = "\(cell.day) \(labels.month(cell.month)) \(cell.year)"
      if let mk = marks[cell.key], mk.count > 0 { label += ", \(mk.count)" }
      e.accessibilityLabel = label
      e.accessibilityHint = labels.hint.isEmpty ? nil : labels.hint
      var traits: UIAccessibilityTraits = .button
      if cell.key == selected { traits.insert(.selected) }
      e.accessibilityTraits = traits
      e.accessibilityFrameInContainerSpace = cellRect(i)
      let key = cell.key
      e.activate = { [weak self] in self?.onSelect?(key) }
      items.append(e)
    }
    a11yItems = items
    accessibilityElements = items
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    for (i, e) in a11yItems.enumerated() { e.accessibilityFrameInContainerSpace = cellRect(i) }
  }
}
