import UIKit

// [2026-10-16 reels-rail-v2] Ícones de LINHA do trilho, mesmo set do app
// (components/Icons.js = Feather, grade 24). Os paths foram convertidos para
// comandos absolutos só com M/L/C/Z (arcos → cúbicas) — o mesmo texto serve ao
// Android (PathParser). Rasteriza uma vez por (ícone, lado, traço) e devolve
// imagem TEMPLATE (a cor vem do tintColor).

enum RFIcon {
  static let heart = "M20.84 4.61C19.81 3.58 18.41 3 16.95 3C15.49 3 14.09 3.58 13.06 4.61L12 5.67L10.94 4.61C8.79 2.46 5.31 2.46 3.16 4.61C1.01 6.76 1.01 10.24 3.16 12.39L4.22 13.45L12 21.23L19.78 13.45L20.84 12.39C21.87 11.36 22.45 9.96 22.45 8.5C22.45 7.04 21.87 5.64 20.84 4.61Z"
  static let comment = "M21 11.5C21 12.82 20.7 14.12 20.1 15.3C18.66 18.18 15.72 20 12.5 20C11.18 20 9.88 19.7 8.7 19.1L3 21L4.9 15.3C4.3 14.12 4 12.82 4 11.5C4 8.28 5.82 5.34 8.7 3.9C9.88 3.3 11.18 3 12.5 3L13 3C17.32 3.24 20.76 6.68 21 11L21 11.5Z"
  static let send = "M22 2L11 13M22 2L15 22L11 13L2 9L22 2Z"
  static let bookmark = "M19 21L12 16L5 21L5 5C5 3.9 5.9 3 7 3L17 3C18.1 3 19 3.9 19 5Z"
  static let gift = "M5 8L19 8C20.1 8 21 8.9 21 10L21 19C21 20.1 20.1 21 19 21L5 21C3.9 21 3 20.1 3 19L3 10C3 8.9 3.9 8 5 8ZM3 12L21 12M12 8L12 21M8 8C6.5 8 5 7 5 5.5C5 4 6.5 3 8 3C9.5 3 12 5 12 8M16 8C17.5 8 19 7 19 5.5C19 4 17.5 3 16 3C14.5 3 12 5 12 8"
  static let more = "M13.6 12C13.6 12.57 13.3 13.1 12.8 13.39C12.3 13.67 11.7 13.67 11.2 13.39C10.7 13.1 10.4 12.57 10.4 12C10.4 11.43 10.7 10.9 11.2 10.61C11.7 10.33 12.3 10.33 12.8 10.61C13.3 10.9 13.6 11.43 13.6 12ZM20.6 12C20.6 12.88 19.88 13.6 19 13.6C18.12 13.6 17.4 12.88 17.4 12C17.4 11.12 18.12 10.4 19 10.4C19.88 10.4 20.6 11.12 20.6 12ZM6.6 12C6.6 12.57 6.3 13.1 5.8 13.39C5.3 13.67 4.7 13.67 4.2 13.39C3.7 13.1 3.4 12.57 3.4 12C3.4 11.43 3.7 10.9 4.2 10.61C4.7 10.33 5.3 10.33 5.8 10.61C6.3 10.9 6.6 11.43 6.6 12Z"
  static let music = "M9 18L9 5L21 3L21 16M9 18C9 19.66 7.66 21 6 21C4.34 21 3 19.66 3 18C3 16.34 4.34 15 6 15C7.66 15 9 16.34 9 18ZM21 16C21 17.66 19.66 19 18 19C16.34 19 15 17.66 15 16C15 14.34 16.34 13 18 13C19.66 13 21 14.34 21 16Z"
  static let plus = "M12 6L12 18M6 12L18 12"
  static let check = "M20 6L9 17L4 12"

  private static var cache: [String: UIImage] = [:]

  /// Path na escala `k` (pontos por unidade da grade 24). Só M/L/C/Z absolutos,
  /// um conjunto de coordenadas por comando (é o que o conversor gera).
  static func path(_ data: String, scale k: CGFloat) -> UIBezierPath {
    let p = UIBezierPath()
    var cmd: Character = "M"
    var buf: [CGFloat] = []
    var num = ""
    func pushNum() {
      if !num.isEmpty, num != "-", let v = Double(num) { buf.append(CGFloat(v) * k) }
      num = ""
    }
    func emit() {
      switch cmd {
      case "M":
        if buf.count >= 2 { p.move(to: CGPoint(x: buf[0], y: buf[1])) }
      case "L":
        if buf.count >= 2, !p.isEmpty { p.addLine(to: CGPoint(x: buf[0], y: buf[1])) }
      case "C":
        if buf.count >= 6, !p.isEmpty {
          p.addCurve(to: CGPoint(x: buf[4], y: buf[5]),
                     controlPoint1: CGPoint(x: buf[0], y: buf[1]),
                     controlPoint2: CGPoint(x: buf[2], y: buf[3]))
        }
      default:
        break
      }
      buf.removeAll(keepingCapacity: true)
    }
    for ch in data {
      switch ch {
      case "M", "L", "C", "Z":
        pushNum()
        emit()
        if ch == "Z" {
          if !p.isEmpty { p.close() }
          cmd = "Z"
        } else {
          cmd = ch
        }
      case " ", ",":
        pushNum()
      case "-":
        pushNum()
        num = "-"
      default:
        num.append(ch)
      }
    }
    pushNum()
    emit()
    return p
  }

  /// Imagem template `side`×`side` pt. `line` = espessura do traço em pontos;
  /// `fill` = preenchido (curtido/salvo) em vez de linha.
  static func image(_ data: String, side: CGFloat, line: CGFloat, fill: Bool) -> UIImage? {
    let key = "\(data.count)|\(data.prefix(24))|\(data.suffix(12))|\(side)|\(line)|\(fill)"
    if let hit = cache[key] { return hit }
    let fmt = UIGraphicsImageRendererFormat.default()
    fmt.opaque = false
    let img = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: fmt).image { _ in
      let p = path(data, scale: side / 24)
      p.lineWidth = line
      p.lineJoinStyle = .round
      p.lineCapStyle = .round
      UIColor.black.setStroke()
      UIColor.black.setFill()
      if fill {
        p.fill()
        p.stroke() // arredonda as quinas do preenchido igual ao traço
      } else {
        p.stroke()
      }
    }.withRenderingMode(.alwaysTemplate)
    if cache.count > 64 { cache.removeAll() }
    cache[key] = img
    return img
  }

  /// Selo de verificado P&B (círculo branco + visto preto), para anexar ao @usuário.
  static let verifiedBadge: UIImage = {
    let side: CGFloat = 15
    let fmt = UIGraphicsImageRendererFormat.default()
    fmt.opaque = false
    return UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: fmt).image { _ in
      UIColor.white.setFill()
      UIBezierPath(ovalIn: CGRect(x: 0, y: 0, width: side, height: side)).fill()
      let c = path(check, scale: side / 24 * 0.62)
      c.apply(CGAffineTransform(translationX: side * 0.19, y: side * 0.2))
      c.lineWidth = 1.9
      c.lineJoinStyle = .round
      c.lineCapStyle = .round
      UIColor.black.setStroke()
      c.stroke()
    }
  }()
}
