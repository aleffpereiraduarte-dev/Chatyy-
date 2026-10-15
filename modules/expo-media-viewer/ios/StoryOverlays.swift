import UIKit

// [2026-10-15 native-story v2] Camada de BLOCOS do visualizador de status
// nativo: figurinhas (enquete/quiz, pergunta, menção, contagem, slider, emoji),
// GIF animado, texto sobreposto e desenho livre — no MESMO espaço de pontos da
// tela do autor (o estúdio grava x/y já em tela cheia; o viewer JS pinta em
// left:x/top:y). Estética P&B do app: vidro escuro / branco, sem cor.
// Toques interativos → onAction(overlay, info) → controller → evento
// onSticker ao JS (que chama a API). Nada aqui navega.

/// UIView que não captura toques no próprio fundo (só nos filhos).
class SVPassThroughView: UIView {
  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    let v = super.hitTest(point, with: event)
    return v === self ? nil : v
  }
}

private func svFont(_ size: CGFloat, _ weight: UIFont.Weight) -> UIFont {
  return .systemFont(ofSize: size, weight: weight)
}

/// Botão-bloco com realce ao tocar (UIControl → o tap de navegação ignora).
class SVBlockControl: UIControl {
  override var isHighlighted: Bool {
    didSet { alpha = isHighlighted ? 0.75 : 1 }
  }
}

// MARK: - Enquete / quiz

final class SVPollBlock: UIView {
  let overlay: SVOverlay
  var onVote: ((Int) -> Void)?
  private let title = UILabel()
  private var rows: [SVBlockControl] = []
  private var fills: [UIView] = []
  private var labelsL: [UILabel] = []
  private var pcts: [UILabel] = []
  private var checks: [UIImageView] = []
  static let width: CGFloat = 250

  init(_ o: SVOverlay) {
    overlay = o
    super.init(frame: .zero)
    backgroundColor = UIColor(white: 0, alpha: 0.72)
    layer.cornerRadius = 16
    layer.borderWidth = 1
    layer.borderColor = UIColor(white: 1, alpha: 0.16).cgColor
    title.textColor = .white
    title.font = svFont(15, .bold)
    title.textAlignment = .center
    title.numberOfLines = 3
    title.text = o.question
    addSubview(title)
    for (i, opt) in o.options.enumerated() {
      let r = SVBlockControl()
      r.layer.cornerRadius = 19
      r.clipsToBounds = true
      r.tag = i
      r.addTarget(self, action: #selector(tapOption(_:)), for: .touchUpInside)
      r.accessibilityLabel = opt
      let f = UIView()
      f.isUserInteractionEnabled = false
      r.addSubview(f)
      let l = UILabel()
      l.text = opt
      l.font = svFont(14, .semibold)
      l.textColor = .white
      l.lineBreakMode = .byTruncatingTail
      r.addSubview(l)
      let p = UILabel()
      p.font = UIFont.monospacedDigitSystemFont(ofSize: 13, weight: .bold)
      p.textColor = .white
      p.textAlignment = .right
      r.addSubview(p)
      let c = UIImageView(image: UIImage(systemName: "checkmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .bold)))
      c.contentMode = .center
      r.addSubview(c)
      addSubview(r)
      rows.append(r)
      fills.append(f)
      labelsL.append(l)
      pcts.append(p)
      checks.append(c)
    }
    refresh()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  var blockSize: CGSize {
    let w = SVPollBlock.width
    let th = title.text?.isEmpty ?? true ? 0 : ceil(title.sizeThatFits(CGSize(width: w - 28, height: 200)).height) + 10
    return CGSize(width: w, height: 14 + th + CGFloat(rows.count) * 46 - 8 + 14)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let w = bounds.width
    var y: CGFloat = 14
    if !(title.text?.isEmpty ?? true) {
      let th = ceil(title.sizeThatFits(CGSize(width: w - 28, height: 200)).height)
      title.frame = CGRect(x: 14, y: y, width: w - 28, height: th)
      y += th + 10
    } else {
      title.frame = .zero
    }
    let total = overlay.counts.reduce(0, +)
    for (i, r) in rows.enumerated() {
      r.frame = CGRect(x: 12, y: y, width: w - 24, height: 38)
      let showPct = showsResults && total > 0 && i < overlay.counts.count
      let frac = showPct ? CGFloat(overlay.counts[i]) / CGFloat(total) : 0
      fills[i].frame = CGRect(x: 0, y: 0, width: r.bounds.width * frac, height: r.bounds.height)
      let checkW: CGFloat = checks[i].isHidden ? 0 : 18
      let pw: CGFloat = pcts[i].isHidden ? 0 : 44
      checks[i].frame = CGRect(x: 12, y: 0, width: checkW, height: 38)
      labelsL[i].frame = CGRect(x: 14 + checkW, y: 0, width: r.bounds.width - 28 - checkW - pw, height: 38)
      pcts[i].frame = CGRect(x: r.bounds.width - 12 - pw, y: 0, width: pw, height: 38)
      y += 46
    }
  }

  private var isQuiz: Bool { return overlay.correct >= 0 }
  private var showsResults: Bool { return overlay.myVote >= 0 || overlay.myVote == -2 }

  func refresh() {
    let total = overlay.counts.reduce(0, +)
    let voted = showsResults
    for i in 0..<rows.count {
      let r = rows[i]
      let mine = overlay.myVote == i
      var bg = UIColor(white: 1, alpha: 0.16)
      var fg = UIColor.white
      var fill = UIColor(white: 1, alpha: 0.28)
      var strike = false
      if isQuiz && voted {
        if i == overlay.correct {
          bg = .white
          fg = .black
          fill = .clear
        } else if mine {
          strike = true
          fg = UIColor(white: 1, alpha: 0.6)
        }
      }
      r.backgroundColor = bg
      r.layer.borderWidth = mine ? 1.5 : 0
      r.layer.borderColor = UIColor.white.cgColor
      fills[i].backgroundColor = fill
      labelsL[i].textColor = fg
      pcts[i].textColor = fg
      if strike {
        labelsL[i].attributedText = NSAttributedString(string: overlay.options[i], attributes: [.strikethroughStyle: NSUnderlineStyle.single.rawValue, .foregroundColor: fg, .font: svFont(14, .semibold)])
      } else {
        labelsL[i].attributedText = nil
        labelsL[i].text = overlay.options[i]
      }
      checks[i].tintColor = fg
      checks[i].isHidden = !(mine || (isQuiz && voted && i == overlay.correct))
      if voted && !isQuiz && total > 0 && i < overlay.counts.count {
        pcts[i].isHidden = false
        pcts[i].text = "\(Int((Double(overlay.counts[i]) * 100 / Double(total)).rounded()))%"
      } else {
        pcts[i].isHidden = true
      }
      r.isEnabled = overlay.votable && !voted
    }
    setNeedsLayout()
  }

  @objc private func tapOption(_ sender: SVBlockControl) {
    guard overlay.votable, overlay.myVote == -1, sender.tag >= 0, sender.tag < overlay.options.count else { return }
    let i = sender.tag
    overlay.myVote = i
    if overlay.counts.count == overlay.options.count {
      overlay.counts[i] += 1
    }
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    UIView.animate(withDuration: 0.25) {
      self.refresh()
      self.layoutIfNeeded()
    }
    onVote?(i)
  }
}

// MARK: - Pergunta

final class SVQuestionBlock: SVBlockControl {
  let overlay: SVOverlay
  private let prompt = UILabel()
  private let field = UILabel()
  private let fieldBox = UIView()
  static let width: CGFloat = 250

  init(_ o: SVOverlay) {
    overlay = o
    super.init(frame: .zero)
    backgroundColor = .white
    layer.cornerRadius = 16
    prompt.text = o.text
    prompt.textColor = .black
    prompt.font = svFont(15, .bold)
    prompt.textAlignment = .center
    prompt.numberOfLines = 3
    prompt.isUserInteractionEnabled = false
    addSubview(prompt)
    fieldBox.backgroundColor = UIColor(white: 0, alpha: 0.07)
    fieldBox.layer.cornerRadius = 18
    fieldBox.isUserInteractionEnabled = false
    addSubview(fieldBox)
    field.text = o.hint
    field.textColor = UIColor(white: 0, alpha: 0.45)
    field.font = svFont(13, .medium)
    field.textAlignment = .center
    field.isUserInteractionEnabled = false
    addSubview(field)
    accessibilityLabel = o.text
    isEnabled = o.votable
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  // Dono: não interativo, mas mantém a aparência (sem esmaecer).
  override var isEnabled: Bool {
    didSet { alpha = 1 }
  }

  var blockSize: CGSize {
    let w = SVQuestionBlock.width
    let ph = ceil(prompt.sizeThatFits(CGSize(width: w - 28, height: 200)).height)
    return CGSize(width: w, height: 14 + ph + 10 + 36 + 14)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let w = bounds.width
    let ph = ceil(prompt.sizeThatFits(CGSize(width: w - 28, height: 200)).height)
    prompt.frame = CGRect(x: 14, y: 14, width: w - 28, height: ph)
    fieldBox.frame = CGRect(x: 14, y: prompt.frame.maxY + 10, width: w - 28, height: 36)
    field.frame = fieldBox.frame.insetBy(dx: 10, dy: 0)
  }
}

// MARK: - Contagem regressiva

final class SVCountdownBlock: UIView {
  let overlay: SVOverlay
  private let title = UILabel()
  private let time = UILabel()
  private let date = UILabel()
  private var lastSecond = Int.min
  static let width: CGFloat = 220

  init(_ o: SVOverlay) {
    overlay = o
    super.init(frame: .zero)
    backgroundColor = UIColor(white: 0, alpha: 0.72)
    layer.cornerRadius = 16
    layer.borderWidth = 1
    layer.borderColor = UIColor(white: 1, alpha: 0.16).cgColor
    isUserInteractionEnabled = false
    title.text = o.text
    title.textColor = UIColor(white: 1, alpha: 0.85)
    title.font = svFont(12, .semibold)
    title.textAlignment = .center
    addSubview(title)
    time.textColor = .white
    time.font = UIFont.monospacedDigitSystemFont(ofSize: 26, weight: .bold)
    time.textAlignment = .center
    time.adjustsFontSizeToFitWidth = true
    time.minimumScaleFactor = 0.6
    addSubview(time)
    date.textColor = UIColor(white: 1, alpha: 0.65)
    date.font = svFont(11, .medium)
    date.textAlignment = .center
    if o.targetMs > 0 {
      let f = DateFormatter()
      f.dateStyle = .medium
      f.timeStyle = .short
      date.text = f.string(from: Date(timeIntervalSince1970: o.targetMs / 1000))
    }
    addSubview(date)
    tick()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  var blockSize: CGSize { return CGSize(width: SVCountdownBlock.width, height: 96) }

  override func layoutSubviews() {
    super.layoutSubviews()
    let w = bounds.width
    title.frame = CGRect(x: 12, y: 12, width: w - 24, height: 16)
    time.frame = CGRect(x: 12, y: 30, width: w - 24, height: 34)
    date.frame = CGRect(x: 12, y: 68, width: w - 24, height: 16)
  }

  func tick() {
    let now = Date().timeIntervalSince1970 * 1000
    let left = overlay.targetMs > 0 ? Int(floor((overlay.targetMs - now) / 1000)) : -1
    if left == lastSecond { return }
    lastSecond = left
    if left <= 0 {
      time.text = overlay.ended.isEmpty ? "00:00:00" : overlay.ended
      return
    }
    let d = left / 86400
    let h = (left % 86400) / 3600
    let m = (left % 3600) / 60
    let s = left % 60
    let hms = String(format: "%02ld:%02ld:%02ld", h, m, s)
    time.text = d > 0 ? "\(d)d \(hms)" : hms
  }
}

// MARK: - Slider

final class SVSliderBlock: SVBlockControl {
  let overlay: SVOverlay
  var onRelease: ((Double) -> Void)?
  private let title = UILabel()
  private let track = UIView()
  private let fill = UIView()
  private let avgMark = UIView()
  private let thumb = UILabel()
  private var dragValue: Double = 50
  static let width: CGFloat = 250

  init(_ o: SVOverlay) {
    overlay = o
    super.init(frame: .zero)
    backgroundColor = UIColor(white: 0, alpha: 0.72)
    layer.cornerRadius = 18
    layer.borderWidth = 1
    layer.borderColor = UIColor(white: 1, alpha: 0.16).cgColor
    title.text = o.text
    title.textColor = .white
    title.font = svFont(14, .bold)
    title.textAlignment = .center
    title.numberOfLines = 2
    title.isUserInteractionEnabled = false
    addSubview(title)
    track.backgroundColor = UIColor(white: 1, alpha: 0.18)
    track.layer.cornerRadius = 4
    track.isUserInteractionEnabled = false
    addSubview(track)
    fill.backgroundColor = .white
    fill.layer.cornerRadius = 4
    fill.isUserInteractionEnabled = false
    track.addSubview(fill)
    avgMark.backgroundColor = .white
    avgMark.layer.cornerRadius = 6
    avgMark.layer.borderWidth = 2
    avgMark.layer.borderColor = UIColor.black.cgColor
    avgMark.isUserInteractionEnabled = false
    addSubview(avgMark)
    thumb.text = o.emoji
    thumb.font = .systemFont(ofSize: 30)
    thumb.textAlignment = .center
    thumb.isUserInteractionEnabled = false
    addSubview(thumb)
    dragValue = o.value >= 0 ? o.value : 50
    isEnabled = o.votable && o.value < 0
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  override var isEnabled: Bool {
    didSet { alpha = 1 }
  }

  override var isHighlighted: Bool {
    didSet { alpha = 1 }
  }

  var blockSize: CGSize {
    let th = ceil(title.sizeThatFits(CGSize(width: SVSliderBlock.width - 28, height: 100)).height)
    return CGSize(width: SVSliderBlock.width, height: 14 + th + 22 + 8 + 22)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let w = bounds.width
    let th = ceil(title.sizeThatFits(CGSize(width: w - 28, height: 100)).height)
    title.frame = CGRect(x: 14, y: 14, width: w - 28, height: th)
    track.frame = CGRect(x: 20, y: title.frame.maxY + 22, width: w - 40, height: 8)
    applyValue()
  }

  private func applyValue() {
    let v = CGFloat(max(0, min(100, overlay.value >= 0 ? overlay.value : dragValue))) / 100
    fill.frame = CGRect(x: 0, y: 0, width: track.bounds.width * v, height: track.bounds.height)
    thumb.frame = CGRect(x: track.frame.minX + track.bounds.width * v - 20, y: track.frame.midY - 22, width: 40, height: 40)
    if overlay.avg >= 0 && overlay.value >= 0 {
      avgMark.isHidden = false
      let a = CGFloat(max(0, min(100, overlay.avg))) / 100
      avgMark.frame = CGRect(x: track.frame.minX + track.bounds.width * a - 6, y: track.frame.midY - 6, width: 12, height: 12)
    } else {
      avgMark.isHidden = true
    }
  }

  private func valueAt(_ t: UITouch) -> Double {
    let x = t.location(in: self).x - track.frame.minX
    return Double(max(0, min(1, x / max(1, track.bounds.width)))) * 100
  }

  override func beginTracking(_ touch: UITouch, with event: UIEvent?) -> Bool {
    guard isEnabled else { return false }
    dragValue = valueAt(touch)
    applyValue()
    return true
  }

  override func continueTracking(_ touch: UITouch, with event: UIEvent?) -> Bool {
    dragValue = valueAt(touch)
    applyValue()
    return true
  }

  override func endTracking(_ touch: UITouch?, with event: UIEvent?) {
    if let t = touch { dragValue = valueAt(t) }
    overlay.value = dragValue
    isEnabled = false
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    applyValue()
    onRelease?(dragValue)
  }

  override func cancelTracking(with event: UIEvent?) {
    dragValue = overlay.value >= 0 ? overlay.value : 50
    applyValue()
  }

  func refresh() {
    isEnabled = overlay.votable && overlay.value < 0
    setNeedsLayout()
  }
}

// MARK: - Camada

final class SVOverlayLayer: SVPassThroughView {
  /// (overlay, info) → controller emite onSticker.
  var onAction: ((SVOverlay, [String: Any]) -> Void)?
  private var blocks: [(SVOverlay, UIView)] = []
  private var shapes: [CAShapeLayer] = []
  private var itemId = ""
  private var paths: [SVPath] = []
  private var token = 0

  func render(_ item: SVItem?) {
    token += 1
    for (_, v) in blocks { v.removeFromSuperview() }
    blocks.removeAll()
    for s in shapes { s.removeFromSuperlayer() }
    shapes.removeAll()
    itemId = item?.id ?? ""
    paths = item?.paths ?? []
    guard let item = item else { return }
    for p in paths {
      let s = CAShapeLayer()
      s.strokeColor = p.color.cgColor
      s.fillColor = UIColor.clear.cgColor
      s.lineWidth = p.width
      s.lineCap = .round
      s.lineJoin = .round
      layer.insertSublayer(s, at: UInt32(shapes.count))
      shapes.append(s)
    }
    for o in item.overlays {
      guard let v = makeBlock(o) else { continue }
      addSubview(v)
      blocks.append((o, v))
    }
    setNeedsLayout()
  }

  private func makeBlock(_ o: SVOverlay) -> UIView? {
    switch o.kind {
    case "text":
      let l = SVPaddedLabel()
      l.text = o.text
      l.textColor = o.color
      l.font = svFont(24, .bold)
      l.textAlignment = .center
      l.numberOfLines = 0
      l.backgroundColor = UIColor(white: 0, alpha: 0.5)
      l.layer.cornerRadius = 8
      l.clipsToBounds = true
      l.isUserInteractionEnabled = false
      return l
    case "emoji":
      let l = UILabel()
      l.text = o.text
      l.font = .systemFont(ofSize: 48)
      l.isUserInteractionEnabled = false
      return l
    case "gif":
      guard !o.url.isEmpty else { return nil }
      let iv = UIImageView()
      iv.contentMode = .scaleAspectFill
      iv.clipsToBounds = true
      iv.layer.cornerRadius = 8
      iv.isUserInteractionEnabled = false
      let t = token
      let u = o.url
      // fullMaxPixel → o loader decodifica TODOS os quadros (GIF/WebP animado).
      MVImageLoader.shared.load(u, maxPixel: MVImageLoader.fullMaxPixel) { [weak self, weak iv] img in
        guard let self = self, let iv = iv, self.token == t, let img = img else { return }
        iv.image = img
        if img.images != nil { iv.startAnimating() }
      }
      return iv
    case "mention":
      let c = SVBlockControl()
      c.backgroundColor = .white
      c.layer.cornerRadius = 20
      c.layer.shadowColor = UIColor.black.cgColor
      c.layer.shadowOpacity = 0.25
      c.layer.shadowRadius = 6
      c.layer.shadowOffset = CGSize(width: 0, height: 2)
      let l = UILabel()
      l.text = o.text
      l.textColor = .black
      l.font = svFont(16, .bold)
      l.tag = 77
      l.isUserInteractionEnabled = false
      c.addSubview(l)
      c.accessibilityLabel = o.text
      c.accessibilityTraits = .link
      c.isEnabled = !o.email.isEmpty || o.text.dropFirst().contains("@")
      c.addAction(UIAction { [weak self] _ in
        self?.onAction?(o, ["kind": "mention", "email": o.email, "text": o.text])
      }, for: .touchUpInside)
      return c
    case "poll":
      let b = SVPollBlock(o)
      b.onVote = { [weak self] i in
        self?.onAction?(o, ["kind": o.correct >= 0 ? "quiz" : "poll", "index": i])
      }
      return b
    case "question":
      let b = SVQuestionBlock(o)
      b.addAction(UIAction { [weak self] _ in
        guard o.votable else { return }
        self?.onAction?(o, ["kind": "question"])
      }, for: .touchUpInside)
      return b
    case "countdown":
      return SVCountdownBlock(o)
    case "slider":
      let b = SVSliderBlock(o)
      b.onRelease = { [weak self] v in
        self?.onAction?(o, ["kind": "slider", "value": Int(v.rounded())])
      }
      return b
    default:
      return nil
    }
  }

  private func size(of v: UIView, _ o: SVOverlay) -> CGSize {
    switch v {
    case let b as SVPollBlock: return b.blockSize
    case let b as SVQuestionBlock: return b.blockSize
    case let b as SVCountdownBlock: return b.blockSize
    case let b as SVSliderBlock: return b.blockSize
    default: break
    }
    if o.kind == "gif" {
      return CGSize(width: max(20, o.w), height: max(20, o.h))
    }
    if o.kind == "mention", let l = v.viewWithTag(77) as? UILabel {
      let s = l.sizeThatFits(CGSize(width: bounds.width - 60, height: 40))
      return CGSize(width: min(bounds.width - 24, ceil(s.width) + 32), height: 38)
    }
    let maxW = max(60, bounds.width - 24)
    let s = v.sizeThatFits(CGSize(width: maxW, height: 400))
    return CGSize(width: min(maxW, ceil(s.width)), height: ceil(s.height))
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = bounds
    guard b.width > 0 else { return }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for (i, p) in paths.enumerated() where i < shapes.count {
      let bp = UIBezierPath()
      bp.move(to: p.points[0])
      for pt in p.points.dropFirst() { bp.addLine(to: pt) }
      shapes[i].frame = b
      shapes[i].path = bp.cgPath
    }
    CATransaction.commit()
    for (o, v) in blocks {
      let s = size(of: v, o)
      var x = o.x < 0 ? (b.width - s.width) / 2 : o.x
      var y = o.y < 0 ? (b.height - s.height) / 2 : o.y
      x = max(4, min(b.width - s.width - 4, x))
      y = max(4, min(b.height - s.height - 4, y))
      v.frame = CGRect(x: x, y: y, width: s.width, height: s.height)
      if o.kind == "mention", let l = v.viewWithTag(77) {
        l.frame = v.bounds.insetBy(dx: 16, dy: 0)
      }
    }
  }

  /// Relógio do controller (só página ativa): contagem regressiva.
  func tick() {
    for (_, v) in blocks {
      if let c = v as? SVCountdownBlock { c.tick() }
    }
  }

  /// Patch vindo do JS (contagem de votos / média do slider).
  func apply(overlayId: String, patch: [String: Any]) {
    for (o, v) in blocks where o.id == overlayId {
      if let c = patch["counts"] as? [Any] { o.counts = c.map { MVItem.intValue($0) ?? 0 } }
      if let mv = MVItem.intValue(patch["myVote"]) { o.myVote = mv }
      if let val = MVItem.doubleValue(patch["value"]) { o.value = val }
      if let a = MVItem.doubleValue(patch["avg"]) { o.avg = a }
      if let p = v as? SVPollBlock {
        UIView.animate(withDuration: 0.25) { p.refresh(); p.layoutIfNeeded() }
      } else if let s = v as? SVSliderBlock {
        s.refresh()
      }
    }
    setNeedsLayout()
  }

  var currentItemId: String { return itemId }
}

/// Rótulo com respiro (texto sobreposto: 16×8 como no viewer JS).
final class SVPaddedLabel: UILabel {
  var insets = UIEdgeInsets(top: 8, left: 16, bottom: 8, right: 16)

  override func drawText(in rect: CGRect) {
    super.drawText(in: rect.inset(by: insets))
  }

  override func sizeThatFits(_ size: CGSize) -> CGSize {
    let inner = CGSize(width: max(0, size.width - insets.left - insets.right), height: max(0, size.height - insets.top - insets.bottom))
    let s = super.sizeThatFits(inner)
    return CGSize(width: s.width + insets.left + insets.right, height: s.height + insets.top + insets.bottom)
  }
}

// MARK: - Status de voz

final class SVVoiceView: UIView {
  private let outer = UIView()
  private let inner = UIView()
  private let mic = UIImageView()
  private var bars: [UIView] = []
  private let title = UILabel()
  let caption = UILabel()
  private static let heights: [CGFloat] = [10, 18, 26, 16, 30, 22, 34, 20, 28, 14, 24, 32, 18, 26, 12, 22, 30, 16, 24, 20]

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    outer.backgroundColor = UIColor(white: 1, alpha: 0.16)
    addSubview(outer)
    inner.backgroundColor = UIColor(white: 1, alpha: 0.22)
    addSubview(inner)
    mic.image = UIImage(systemName: "mic.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 36, weight: .semibold))
    mic.tintColor = .white
    mic.contentMode = .center
    addSubview(mic)
    for _ in SVVoiceView.heights {
      let b = UIView()
      b.backgroundColor = .white
      b.layer.cornerRadius = 2
      b.alpha = 0.45
      addSubview(b)
      bars.append(b)
    }
    title.textColor = .white
    title.font = svFont(16, .semibold)
    title.textAlignment = .center
    addSubview(title)
    caption.textColor = UIColor(white: 1, alpha: 0.85)
    caption.font = svFont(15, .regular)
    caption.textAlignment = .center
    caption.numberOfLines = 4
    addSubview(caption)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  func configure(title t: String, caption c: String) {
    title.text = t
    caption.text = c
    setProgress(0)
    setNeedsLayout()
  }

  func setProgress(_ f: CGFloat) {
    let lit = Int((max(0, min(1, f)) * CGFloat(bars.count)).rounded(.down))
    for (i, b) in bars.enumerated() {
      let a: CGFloat = i < lit ? 1 : 0.45
      if b.alpha != a { b.alpha = a }
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let w = bounds.width
    let h = bounds.height
    let cy = h * 0.42
    outer.frame = CGRect(x: (w - 108) / 2, y: cy - 54, width: 108, height: 108)
    outer.layer.cornerRadius = 54
    inner.frame = CGRect(x: (w - 84) / 2, y: cy - 42, width: 84, height: 84)
    inner.layer.cornerRadius = 42
    mic.frame = inner.frame
    let bw: CGFloat = 4
    let gap: CGFloat = 4
    let total = CGFloat(bars.count) * bw + CGFloat(bars.count - 1) * gap
    var x = (w - total) / 2
    let by = outer.frame.maxY + 26 + 20
    for (i, b) in bars.enumerated() {
      let bh = SVVoiceView.heights[i]
      b.frame = CGRect(x: x, y: by - bh / 2, width: bw, height: bh)
      x += bw + gap
    }
    title.frame = CGRect(x: 24, y: by + 30, width: w - 48, height: 22)
    let ch = ceil(caption.sizeThatFits(CGSize(width: w - 64, height: 200)).height)
    caption.frame = CGRect(x: 32, y: title.frame.maxY + 10, width: w - 64, height: ch)
  }
}
