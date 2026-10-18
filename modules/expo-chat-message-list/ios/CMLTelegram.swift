import UIKit
import CoreText

// [2026-10-18 tg-list, apiVersion 11] Peças "nível Telegram" da lista nativa:
//   • CMLSearchHL   — termos da busca → intervalos UTF-16 no texto do balão
//                     (sem acento/caixa, como o NFD+strip do JS);
//   • CMLOverlayView — botões flutuantes (↓ com não-lidas, "@" menções,
//                     ♥ reações) mostrados pela distância nativa do fim;
// O realce em si fica no CMLTextView (marks), o relógio no CMLMetaView e o
// pop da reação rápida / prévia da seleção no CMLCell.

enum CMLSearchHL {
  static func fold(_ s: String) -> String {
    return s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
  }

  static func tokens(_ term: String) -> [String] {
    let f = fold(term)
    var out: [String] = []
    for p in f.split(whereSeparator: { $0.isWhitespace || $0.isNewline }) where !p.isEmpty {
      out.append(String(p))
      if out.count >= 8 { break }
    }
    return out
  }

  /// Ocorrências de cada token em `text` (offsets UTF-16 do ORIGINAL). Dobra
  /// por caractere (grapheme) p/ mapear de volta mesmo quando o tamanho muda.
  static func ranges(in text: String, tokens: [String]) -> [NSRange] {
    guard !tokens.isEmpty, !text.isEmpty else { return [] }
    var folded: [UInt16] = []
    var mapS: [Int] = []
    var mapE: [Int] = []
    folded.reserveCapacity(text.utf16.count)
    var off = 0
    for ch in text {
      let s = String(ch)
      let len = s.utf16.count
      let f = ch.isASCII ? s.lowercased() : fold(s)
      for u in f.utf16 {
        folded.append(u)
        mapS.append(off)
        mapE.append(off + len)
      }
      off += len
    }
    var out: [NSRange] = []
    let n = folded.count
    for t in tokens {
      let tu = Array(t.utf16)
      let m = tu.count
      guard m > 0, m <= n else { continue }
      var i = 0
      while i + m <= n {
        var ok = folded[i] == tu[0]
        if ok && m > 1 {
          var j = 1
          while j < m { if folded[i + j] != tu[j] { ok = false; break }; j += 1 }
        }
        if ok {
          let s0 = mapS[i], e0 = mapE[i + m - 1]
          if e0 > s0 { out.append(NSRange(location: s0, length: e0 - s0)) }
          if out.count >= 200 { return out }
          i += m
        } else {
          i += 1
        }
      }
    }
    return out
  }

  /// Retângulos (coordenadas do CMLTextView) que cobrem `ranges` no layout.
  static func rects(_ l: CMLTextLayout, _ ranges: [NSRange]) -> [CGRect] {
    guard !ranges.isEmpty else { return [] }
    var out: [CGRect] = []
    for (i, line) in l.lines.enumerated() {
      let lr = CTLineGetStringRange(line)
      let ls = lr.location, le = lr.location + lr.length
      for r in ranges {
        let s = max(ls, r.location), e = min(le, r.location + r.length)
        if s >= e { continue }
        let x0 = CTLineGetOffsetForStringIndex(line, s, nil)
        let x1 = CTLineGetOffsetForStringIndex(line, e, nil)
        let ox = l.lineOffset(i)
        let top = CGFloat(i) * l.lineHeight
        out.append(CGRect(x: ox + min(x0, x1) - 1.5, y: top + 1, width: abs(x1 - x0) + 3, height: max(4, l.lineHeight - 2)))
      }
    }
    return out
  }
}

// MARK: - overlay inferior

final class CMLOverlayButton: UIControl {
  enum Kind: String { case down, mention, reaction }
  let kind: Kind
  private let disc = UIView()
  private let icon = CAShapeLayer()
  private let at = UILabel()
  let badge = UILabel()
  private(set) var count = 0
  /// alvo de visibilidade (a animação de saída termina escondendo)
  var wantShown = false

  init(kind: Kind) {
    self.kind = kind
    super.init(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
    clipsToBounds = false
    disc.isUserInteractionEnabled = false
    disc.layer.cornerRadius = 22
    disc.layer.borderWidth = 1 / max(1, UIScreen.main.scale)
    disc.layer.shadowColor = UIColor.black.cgColor
    disc.layer.shadowOpacity = 0.12
    disc.layer.shadowRadius = 6
    disc.layer.shadowOffset = CGSize(width: 0, height: 2)
    addSubview(disc)
    icon.fillColor = UIColor.clear.cgColor
    icon.lineCap = .round
    icon.lineJoin = .round
    disc.layer.addSublayer(icon)
    at.text = "@"
    at.font = UIFont.systemFont(ofSize: 20, weight: .bold)
    at.textAlignment = .center
    at.isHidden = kind != .mention
    disc.addSubview(at)
    badge.font = UIFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
    badge.textAlignment = .center
    badge.layer.cornerRadius = 10
    badge.layer.borderWidth = 1.5
    badge.clipsToBounds = true
    badge.isHidden = true
    badge.isUserInteractionEnabled = false
    addSubview(badge)
    isHidden = true
    alpha = 0
    isAccessibilityElement = true
    accessibilityTraits = .button
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func applyLook(dark: Bool, wall: UIColor) {
    disc.backgroundColor = dark ? UIColor(red: 0.11, green: 0.11, blue: 0.118, alpha: 1) : .white
    disc.layer.borderColor = (dark ? UIColor(white: 1, alpha: 0.10) : UIColor(white: 0, alpha: 0.10)).cgColor
    let ink = dark ? UIColor(red: 0.96, green: 0.96, blue: 0.97, alpha: 1) : UIColor(white: 0.067, alpha: 1)
    at.textColor = ink
    switch kind {
    case .down:
      icon.strokeColor = ink.cgColor
      icon.fillColor = UIColor.clear.cgColor
      icon.lineWidth = 2.2
    case .reaction:
      icon.strokeColor = UIColor.clear.cgColor
      icon.fillColor = ink.cgColor
      icon.lineWidth = 0
    case .mention:
      icon.strokeColor = UIColor.clear.cgColor
      icon.fillColor = UIColor.clear.cgColor
    }
    badge.backgroundColor = dark ? .white : UIColor(white: 0.067, alpha: 1)
    badge.textColor = dark ? .black : .white
    badge.layer.borderColor = wall.cgColor
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    disc.frame = bounds
    disc.layer.shadowPath = UIBezierPath(ovalIn: bounds).cgPath
    icon.frame = bounds
    at.frame = bounds.offsetBy(dx: 0, dy: -1)
    let p = UIBezierPath()
    let c = CGPoint(x: bounds.midX, y: bounds.midY)
    switch kind {
    case .down:
      p.move(to: CGPoint(x: c.x - 7, y: c.y - 3))
      p.addLine(to: CGPoint(x: c.x, y: c.y + 4))
      p.addLine(to: CGPoint(x: c.x + 7, y: c.y - 3))
    case .reaction:
      // coração 18 pt
      let w: CGFloat = 18, h: CGFloat = 16
      let ox = c.x - w / 2, oy = c.y - h / 2 + 1
      p.move(to: CGPoint(x: ox + w / 2, y: oy + h))
      p.addCurve(to: CGPoint(x: ox, y: oy + h * 0.32), controlPoint1: CGPoint(x: ox + w * 0.2, y: oy + h * 0.78), controlPoint2: CGPoint(x: ox, y: oy + h * 0.56))
      p.addArc(withCenter: CGPoint(x: ox + w * 0.25, y: oy + h * 0.3), radius: w * 0.25, startAngle: .pi, endAngle: 0, clockwise: true)
      p.addArc(withCenter: CGPoint(x: ox + w * 0.75, y: oy + h * 0.3), radius: w * 0.25, startAngle: .pi, endAngle: 0, clockwise: true)
      p.addCurve(to: CGPoint(x: ox + w / 2, y: oy + h), controlPoint1: CGPoint(x: ox + w, y: oy + h * 0.56), controlPoint2: CGPoint(x: ox + w * 0.8, y: oy + h * 0.78))
      p.close()
    case .mention:
      break
    }
    icon.path = p.cgPath
    layoutBadge()
  }

  private func layoutBadge() {
    guard !badge.isHidden else { return }
    let sz = badge.intrinsicContentSize
    let w = max(20, ceil(sz.width) + 10)
    badge.bounds = CGRect(x: 0, y: 0, width: w, height: 20)
    badge.center = CGPoint(x: bounds.midX, y: -4)
  }

  func setCount(_ n: Int, animated: Bool) {
    let prev = count
    count = max(0, n)
    if count <= 0 {
      badge.isHidden = true
    } else {
      badge.text = count > 99 ? "99+" : "\(count)"
      badge.isHidden = false
      layoutBadge()
      if animated && count > prev && prev >= 0 && !UIAccessibility.isReduceMotionEnabled {
        badge.layer.removeAllAnimations()
        badge.transform = CGAffineTransform(scaleX: 1.3, y: 1.3)
        UIView.animate(withDuration: 0.42, delay: 0, usingSpringWithDamping: 0.5, initialSpringVelocity: 0.6, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
          self.badge.transform = .identity
        })
      }
    }
  }

  override var isHighlighted: Bool {
    didSet { disc.alpha = isHighlighted ? 0.72 : 1 }
  }

  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    return bounds.insetBy(dx: -4, dy: -4).contains(point)
  }
}

final class CMLOverlayView: UIView {
  var onPress: ((String) -> Void)?
  private let down = CMLOverlayButton(kind: .down)
  private let mention = CMLOverlayButton(kind: .mention)
  private let reaction = CMLOverlayButton(kind: .reaction)
  private var on = false
  private var b: CGFloat = 12
  private var dark = false
  private var ax: [String: String] = [:]
  private var far = false
  private var blocked = false
  private var unread = 0
  private var nMention = 0
  private var nReaction = 0
  /// bottomInset da lista (o overlay fica acima dele)
  var bottomInset: CGFloat = 0 { didSet { if bottomInset != oldValue { relayout(animated: false) } } }
  var wall: UIColor = .white

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    for btn in [down, mention, reaction] {
      btn.addTarget(self, action: #selector(tapped(_:)), for: .touchUpInside)
      addSubview(btn)
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  @objc private func tapped(_ b: CMLOverlayButton) {
    onPress?(b.kind.rawValue)
  }

  /// prop `overlay` {on, unread, mention, reaction, b, dark, ax}
  func apply(_ d: [String: Any]?) {
    let dd = d ?? [:]
    on = d != nil && CMLRow.bool(dd["on"])
    b = CGFloat(CMLRow.num(dd["b"]) ?? 12)
    dark = CMLRow.bool(dd["dark"])
    var m: [String: String] = [:]
    if let a = dd["ax"] as? [String: Any] { for (k, v) in a { m[k] = CMLRow.str(v) } }
    ax = m
    unread = max(0, Int(CMLRow.num(dd["unread"]) ?? 0))
    nMention = max(0, Int(CMLRow.num(dd["mention"]) ?? 0))
    nReaction = max(0, Int(CMLRow.num(dd["reaction"]) ?? 0))
    for btn in [down, mention, reaction] { btn.applyLook(dark: dark, wall: wall) }
    let animated = window != nil
    down.setCount(unread, animated: animated)
    mention.setCount(nMention, animated: animated)
    reaction.setCount(nReaction, animated: animated)
    down.accessibilityLabel = label("down", unread)
    mention.accessibilityLabel = label("mention", nMention)
    reaction.accessibilityLabel = label("reaction", nReaction)
    relayout(animated: animated)
  }

  private func label(_ k: String, _ n: Int) -> String {
    let base = ax[k] ?? ""
    return n > 0 ? "\(base) (\(n))" : base
  }

  var isOn: Bool { return on }

  func setFar(_ v: Bool) {
    if v == far { return }
    far = v
    relayout(animated: window != nil)
  }

  func setBlocked(_ v: Bool) {
    if v == blocked { return }
    blocked = v
    relayout(animated: window != nil)
  }

  func refreshLook() {
    for btn in [down, mention, reaction] { btn.applyLook(dark: dark, wall: wall) }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    relayout(animated: false)
  }

  func relayout(animated: Bool) {
    let vis: [(CMLOverlayButton, Bool)] = [
      (down, on && far && !blocked),
      (mention, on && nMention > 0 && !blocked),
      (reaction, on && nReaction > 0 && !blocked),
    ]
    let reduce = UIAccessibility.isReduceMotionEnabled
    let size: CGFloat = 44, gap: CGFloat = 14
    var y = bounds.height - bottomInset - b - size
    let x = bounds.width - 12 - size
    for (btn, show) in vis {
      let fr = CGRect(x: x, y: y, width: size, height: size)
      if show { y -= size + gap }
      let wasTarget = btn.wantShown
      btn.wantShown = show
      if show {
        if !wasTarget || btn.isHidden {
          btn.layer.removeAllAnimations()
          btn.bounds = CGRect(origin: .zero, size: fr.size)
          btn.center = CGPoint(x: fr.midX, y: fr.midY)
          btn.isHidden = false
          if animated {
            btn.alpha = 0
            btn.transform = reduce ? .identity : CGAffineTransform(scaleX: 0.85, y: 0.85).translatedBy(x: 0, y: 8)
            UIView.animate(withDuration: 0.35, delay: 0, usingSpringWithDamping: 0.78, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
              btn.alpha = 1
              btn.transform = .identity
            })
          } else {
            btn.alpha = 1
            btn.transform = .identity
          }
        } else if animated && (abs(btn.center.y - fr.midY) > 0.5 || abs(btn.center.x - fr.midX) > 0.5) {
          UIView.animate(withDuration: 0.35, delay: 0, usingSpringWithDamping: 0.82, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
            btn.center = CGPoint(x: fr.midX, y: fr.midY)
          })
        } else {
          btn.bounds = CGRect(origin: .zero, size: fr.size)
          btn.center = CGPoint(x: fr.midX, y: fr.midY)
        }
      } else if wasTarget || !btn.isHidden {
        if animated && !btn.isHidden {
          UIView.animate(withDuration: 0.22, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState, .curveEaseIn], animations: {
            btn.alpha = 0
            if !reduce { btn.transform = CGAffineTransform(scaleX: 0.85, y: 0.85) }
          }, completion: { _ in
            if !btn.wantShown { btn.isHidden = true; btn.transform = .identity }
          })
        } else {
          btn.alpha = 0
          btn.isHidden = true
          btn.transform = .identity
        }
      }
    }
  }

  // só os botões recebem toque; o resto passa p/ a lista
  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    guard on, !isHidden else { return nil }
    for btn in [down, mention, reaction] where btn.wantShown && !btn.isHidden && btn.alpha > 0.05 {
      let p = btn.convert(point, from: self)
      if btn.point(inside: p, with: event) { return btn }
    }
    return nil
  }
}
