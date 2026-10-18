import UIKit
import CoreImage
import ImageIO

// [2026-10-15 native-status-studio] Modelo + desenho do estúdio.
// Coordenadas das camadas NORMALIZADAS no palco 9:16 (u,v ∈ 0…1 = centro);
// tamanho de fonte relativo à LARGURA do palco → prévia e exportação
// 1080×1920 usam a mesma conta (ctx escalado).

enum SSKind: String {
  case text, emoji, location, mention, link, poll, question, countdown, music

  /// Queimada na foto (desenhada no JPEG) — o resto vai como JSON do viewer.
  var burns: Bool { return self == .text || self == .emoji || self == .location }
  /// Bloco do viewer (tamanho fixo): só arrasta.
  var isWidget: Bool { return !burns }
}

final class SSLayer {
  let id: String
  var kind: SSKind
  var text: String
  var color: UIColor = .white
  var font: String = "sans"
  var bg: Int = 0                 // 0 sem fundo · 1 sólido · 2 suave
  var align: NSTextAlignment = .center
  var u: CGFloat = 0.5
  var v: CGFloat = 0.4
  var size: CGFloat = 0.09        // fonte = size × largura do palco
  var rot: CGFloat = 0
  // extras dos blocos
  var email = ""
  var url = ""
  var optionA = ""
  var optionB = ""
  var target: Date?
  var artist = ""
  var cover = ""
  var preview = ""

  init(kind: SSKind, text: String) {
    self.kind = kind
    self.text = text
    id = SSLayer.newId()
    switch kind {
    case .emoji: size = 0.2
    case .location: size = 0.05
    default: size = 0.09
    }
  }

  func copy() -> SSLayer {
    let c = SSLayer(kind: kind, text: text)
    c.copyFrom(self)
    return c
  }

  private func copyFrom(_ o: SSLayer) {
    color = o.color; font = o.font; bg = o.bg; align = o.align
    u = o.u; v = o.v; size = o.size; rot = o.rot
    email = o.email; url = o.url; optionA = o.optionA; optionB = o.optionB
    target = o.target; artist = o.artist; cover = o.cover; preview = o.preview
  }

  static func newId() -> String {
    let ms = Int64(Date().timeIntervalSince1970 * 1000)
    let r = String(Int.random(in: 0..<46656), radix: 36)
    return "\(ms)\(r)"
  }
}

enum SSBrush: Int { case pen = 0, marker, neon, eraser }

struct SSStroke {
  var color: UIColor
  var width: CGFloat              // relativo à largura do palco
  var brush: SSBrush
  var pts: [CGPoint] = []         // normalizados no palco
}

/// Estado de UMA mídia.
final class SSItemState {
  let media: SSMediaIn
  var filterIdx = 0
  var layers: [SSLayer] = []
  var strokes: [SSStroke] = []
  var preview: CGImage?           // decodificada (≤1440) p/ a prévia — JÁ com giro/recorte
  // [2026-10-18 status-telegram] Ferramenta Cortar: giro (0/90/180/270, horário)
  // + proporção central (w/h; 0 = original). basePreview = prévia sem recorte.
  var basePreview: CGImage?
  var rotate = 0
  var aspect: CGFloat = 0
  var edited: Bool { return rotate % 360 != 0 || aspect > 0 }
  var avgColor: UIColor = UIColor(white: 0.04, alpha: 1)
  var pixelSize: CGSize = .zero

  init(_ m: SSMediaIn) { media = m }

  var hasBurn: Bool { return !strokes.isEmpty || layers.contains { $0.kind.burns } }
  var dirty: Bool { return filterIdx != 0 || !layers.isEmpty || !strokes.isEmpty || edited }
}

// MARK: - Fontes (iguais ao visualizador nativo)

enum SSFont {
  static func font(_ id: String, size: CGFloat) -> UIFont {
    let name: String?
    switch id {
    case "serif": name = "Georgia-Bold"
    case "mono": name = "Menlo-Bold"
    case "script": name = "Noteworthy-Bold"
    case "condensed": name = "AvenirNextCondensed-Bold"
    default: name = nil
    }
    if let n = name, let f = UIFont(name: n, size: size) { return f }
    return .systemFont(ofSize: size, weight: .bold)
  }

  static func shown(_ text: String, font: String) -> String {
    return font == "condensed" ? text.uppercased() : text
  }
}

// MARK: - Status de texto (layout = StoryGroupView.layoutText)

enum SSTextStatus {
  /// Maior fonte (44 → 14) cujo texto cabe em (w−48) × (h·0.7) — medida real.
  static func fit(_ text: String, font: String, width w: CGFloat, height h: CGFloat, align: NSTextAlignment = .center) -> (NSAttributedString, CGFloat, CGFloat) {
    let maxW = max(40, w - 48)
    let maxH = h * 0.7
    let para = NSMutableParagraphStyle()
    para.alignment = align
    para.lineBreakMode = .byWordWrapping
    let shownText = SSFont.shown(text.isEmpty ? " " : text, font: font)
    func attrs(_ fs: CGFloat) -> [NSAttributedString.Key: Any] {
      para.lineSpacing = fs * 0.12
      var a: [NSAttributedString.Key: Any] = [.font: SSFont.font(font, size: fs), .paragraphStyle: para.copy(), .foregroundColor: UIColor.white]
      if font == "condensed" { a[.kern] = -0.5 }
      return a
    }
    func height(_ fs: CGFloat) -> CGFloat {
      let s = NSAttributedString(string: shownText, attributes: attrs(fs))
      return ceil(s.boundingRect(with: CGSize(width: maxW, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).height)
    }
    var lo: CGFloat = 14
    var hi: CGFloat = 44
    var best: CGFloat = 14
    while hi - lo > 0.5 {
      let mid = (lo + hi) / 2
      if height(mid) <= maxH { best = mid; lo = mid } else { hi = mid }
    }
    if height(44) <= maxH { best = 44 }
    best = floor(best)
    let s = NSAttributedString(string: shownText, attributes: attrs(best))
    return (s, best, min(h * 0.86, height(best) + 4))
  }
}

// MARK: - Imagem / filtro

enum SSImage {
  static let ciContext: CIContext = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull()])

  static func url(_ s: String) -> URL? {
    if s.hasPrefix("file://") { return URL(string: s) }
    if s.hasPrefix("/") { return URL(fileURLWithPath: s) }
    return URL(string: s)
  }

  /// Decodifica com EXIF aplicado e lado maior ≤ maxPixel.
  static func load(_ uri: String, maxPixel: Int) -> CGImage? {
    guard let u = url(uri), let src = CGImageSourceCreateWithURL(u as CFURL, nil) else { return nil }
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixel,
    ]
    return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
  }

  /// [2026-10-18 status-telegram] Giro horário (múltiplo de 90) + recorte central na proporção w/h (0 = mantém).
  static func edited(_ cg: CGImage, rotate: Int, aspect: CGFloat) -> CGImage {
    let r = ((rotate % 360) + 360) % 360
    guard r != 0 || aspect > 0 else { return cg }
    var ci = CIImage(cgImage: cg)
    if r != 0 { ci = ci.oriented(r == 90 ? .right : (r == 180 ? .down : .left)) }
    let full = ci.extent
    var ext = full
    if aspect > 0, full.width > 0, full.height > 0 {
      if full.width / full.height > aspect {
        let w = (full.height * aspect).rounded()
        ext = CGRect(x: (full.midX - w / 2).rounded(), y: full.minY, width: w, height: full.height)
      } else {
        let h = (full.width / aspect).rounded()
        ext = CGRect(x: full.minX, y: (full.midY - h / 2).rounded(), width: full.width, height: h)
      }
      ext = ext.intersection(full)
    }
    guard ext.width >= 1, ext.height >= 1 else { return cg }
    return ciContext.createCGImage(ci.cropped(to: ext), from: ext) ?? cg
  }

  static func filtered(_ cg: CGImage, _ f: SSFilter?) -> CGImage {
    guard let f = f, let m = f.m, m.count == 20, !f.isIdentity, let cf = CIFilter(name: "CIColorMatrix") else { return cg }
    let ci = CIImage(cgImage: cg)
    cf.setValue(ci, forKey: kCIInputImageKey)
    cf.setValue(CIVector(x: m[0], y: m[1], z: m[2], w: m[3]), forKey: "inputRVector")
    cf.setValue(CIVector(x: m[5], y: m[6], z: m[7], w: m[8]), forKey: "inputGVector")
    cf.setValue(CIVector(x: m[10], y: m[11], z: m[12], w: m[13]), forKey: "inputBVector")
    cf.setValue(CIVector(x: m[15], y: m[16], z: m[17], w: m[18]), forKey: "inputAVector")
    cf.setValue(CIVector(x: m[4], y: m[9], z: m[14], w: m[19]), forKey: "inputBiasVector")
    guard let out = cf.outputImage?.cropped(to: ci.extent) else { return cg }
    return ciContext.createCGImage(out, from: ci.extent) ?? cg
  }

  /// Média da foto escurecida (×0.42) — fundo do palco (stageBackground do JS).
  static func stageColor(_ cg: CGImage) -> UIColor {
    let w = 8, h = 8
    // Bitmap alocado pelo próprio contexto (ponteiro válido durante todo o uso).
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
      return UIColor(white: 0.04, alpha: 1)
    }
    ctx.interpolationQuality = .medium
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    guard let data = ctx.data else { return UIColor(white: 0.04, alpha: 1) }
    let px = data.bindMemory(to: UInt8.self, capacity: ctx.bytesPerRow * h)
    var r = 0.0, g = 0.0, b = 0.0
    for y in 0..<h {
      for x in 0..<w {
        let o = y * ctx.bytesPerRow + x * 4
        r += Double(px[o]); g += Double(px[o + 1]); b += Double(px[o + 2])
      }
    }
    let n = Double(w * h) * 255
    let k = 0.42
    return UIColor(red: CGFloat(min(1, r / n * k)), green: CGFloat(min(1, g / n * k)), blue: CGFloat(min(1, b / n * k)), alpha: 1)
  }

  static func fitRect(_ size: CGSize, in r: CGRect) -> CGRect {
    guard size.width > 0, size.height > 0 else { return r }
    let k = min(r.width / size.width, r.height / size.height)
    let w = size.width * k
    let h = size.height * k
    return CGRect(x: r.minX + (r.width - w) / 2, y: r.minY + (r.height - h) / 2, width: w, height: h)
  }

  static func tempURL(_ ext: String) -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("status-studio", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("ss_\(Int64(Date().timeIntervalSince1970 * 1000))_\(Int.random(in: 1000...9999)).\(ext)")
  }

  static func writeJPEG(_ img: UIImage, quality: CGFloat = 0.9) -> URL? {
    guard let d = img.jpegData(compressionQuality: quality) else { return nil }
    let u = tempURL("jpg")
    do { try d.write(to: u, options: .atomic) } catch { return nil }
    return u
  }
}

// MARK: - Desenho (prévia e exportação)

enum SSDraw {
  static func contrastOn(_ c: UIColor) -> UIColor {
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    c.getRed(&r, green: &g, blue: &b, alpha: &a)
    return (0.299 * r + 0.587 * g + 0.114 * b) > 0.627 ? .black : .white
  }

  struct Laid {
    let str: NSAttributedString
    let size: CGSize
    let fontPx: CGFloat
    let box: CGSize               // meia-caixa (com respiro)
  }

  /// Layout de uma camada queimável no espaço do palco de largura `W`.
  static func layout(_ o: SSLayer, W: CGFloat) -> Laid {
    let fontPx = max(6, o.size * W)
    let para = NSMutableParagraphStyle()
    para.alignment = o.kind == .text ? o.align : .center
    para.lineBreakMode = .byWordWrapping
    var attrs: [NSAttributedString.Key: Any] = [.paragraphStyle: para]
    var text = o.text.isEmpty ? " " : o.text
    var wrap = W * 0.86
    switch o.kind {
    case .text:
      attrs[.font] = SSFont.font(o.font, size: fontPx)
      attrs[.foregroundColor] = o.bg == 1 ? contrastOn(o.color) : o.color
      if o.font == "condensed" { attrs[.kern] = -0.5 }
      text = SSFont.shown(text, font: o.font)
      if o.bg == 0 {
        let sh = NSShadow()
        sh.shadowColor = UIColor(white: 0, alpha: 0.5)
        sh.shadowBlurRadius = fontPx * 0.12
        sh.shadowOffset = CGSize(width: 0, height: fontPx * 0.04)
        attrs[.shadow] = sh
      }
      para.lineSpacing = fontPx * 0.08
    case .location:
      attrs[.font] = UIFont.systemFont(ofSize: fontPx, weight: .heavy)
      attrs[.foregroundColor] = UIColor.black
      text = text.uppercased()
      para.lineBreakMode = .byTruncatingTail
      wrap = W * 0.7
    default:
      attrs[.font] = UIFont.systemFont(ofSize: fontPx)
      wrap = fontPx * 3
    }
    let str = NSAttributedString(string: text, attributes: attrs)
    var r = str.boundingRect(with: CGSize(width: wrap, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
    if o.kind == .location { r.size.height = min(r.size.height, fontPx * 1.3) }
    let size = CGSize(width: ceil(r.width), height: ceil(r.height))
    var half: CGSize
    switch o.kind {
    case .text:
      let pad = o.bg == 0 ? fontPx * 0.12 : fontPx * 0.36
      half = CGSize(width: size.width / 2 + pad, height: size.height / 2 + pad * 0.6)
    case .location:
      let icon = fontPx * 1.15
      half = CGSize(width: (size.width + icon + fontPx * 1.3) / 2, height: (size.height + fontPx * 0.9) / 2)
    default:
      half = CGSize(width: size.width / 2, height: size.height / 2)
    }
    return Laid(str: str, size: size, fontPx: fontPx, box: half)
  }

  /// Desenha a camada com centro em `c` (palco de largura W) no ctx atual.
  static func drawLayer(_ o: SSLayer, center c: CGPoint, W: CGFloat, in ctx: CGContext, alpha: CGFloat = 1) {
    let l = layout(o, W: W)
    let hb = l.box
    ctx.saveGState()
    ctx.setAlpha(alpha)
    ctx.translateBy(x: c.x, y: c.y)
    ctx.rotate(by: o.rot)
    let box = CGRect(x: -hb.width, y: -hb.height, width: hb.width * 2, height: hb.height * 2)
    switch o.kind {
    case .text:
      if o.bg != 0 {
        let p = UIBezierPath(roundedRect: box, cornerRadius: l.fontPx * 0.32)
        (o.bg == 1 ? o.color : UIColor(white: 0, alpha: 0.55)).setFill()
        p.fill()
      }
      // O alinhamento (esq/centro/dir) vale entre as linhas, dentro da largura da maior.
      let tr = CGRect(x: -l.size.width / 2, y: -l.size.height / 2, width: l.size.width, height: l.size.height)
      l.str.draw(with: tr, options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
    case .location:
      let p = UIBezierPath(roundedRect: box, cornerRadius: l.fontPx * 0.45)
      UIColor.white.setFill()
      ctx.setShadow(offset: CGSize(width: 0, height: l.fontPx * 0.08), blur: l.fontPx * 0.4, color: UIColor(white: 0, alpha: 0.25).cgColor)
      p.fill()
      ctx.setShadow(offset: .zero, blur: 0, color: nil)
      let icon = l.fontPx * 1.15
      let x0 = -hb.width + l.fontPx * 0.55
      let cfg = UIImage.SymbolConfiguration(pointSize: icon * 0.82, weight: .bold)
      if let img = UIImage(systemName: "mappin.and.ellipse", withConfiguration: cfg)?.withTintColor(.black, renderingMode: .alwaysOriginal) {
        let isz = img.size
        let k = min(icon / max(1, isz.width), icon / max(1, isz.height))
        img.draw(in: CGRect(x: x0, y: -isz.height * k / 2, width: isz.width * k, height: isz.height * k))
      }
      let tr = CGRect(x: x0 + icon + l.fontPx * 0.25, y: -l.size.height / 2, width: l.size.width, height: l.size.height)
      l.str.draw(with: tr, options: [.usesLineFragmentOrigin, .usesFontLeading, .truncatesLastVisibleLine], context: nil)
    default:
      let tr = CGRect(x: -l.size.width / 2, y: -l.size.height / 2, width: l.size.width, height: l.size.height)
      l.str.draw(with: tr, options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
    }
    ctx.restoreGState()
  }

  /// Traço no retângulo do palco `f` (pontos normalizados).
  static func drawStroke(_ s: SSStroke, in f: CGRect, ctx: CGContext) {
    guard !s.pts.isEmpty else { return }
    let base = max(1, s.width * f.width)
    func P(_ p: CGPoint) -> CGPoint { return CGPoint(x: f.minX + p.x * f.width, y: f.minY + p.y * f.height) }
    let path = UIBezierPath()
    if s.pts.count == 1 {
      let c = P(s.pts[0])
      path.move(to: c)
      path.addLine(to: CGPoint(x: c.x + 0.01, y: c.y + 0.01))
    } else {
      path.move(to: P(s.pts[0]))
      var prev = s.pts[0]
      for i in 1..<s.pts.count {
        let p = s.pts[i]
        let mid = CGPoint(x: (prev.x + p.x) / 2, y: (prev.y + p.y) / 2)
        path.addQuadCurve(to: P(mid), controlPoint: P(prev))
        prev = p
      }
      path.addLine(to: P(prev))
    }
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    ctx.saveGState()
    switch s.brush {
    case .pen:
      path.lineWidth = base
      s.color.setStroke()
      path.stroke()
    case .marker:
      path.lineWidth = base * 2.4
      path.lineCapStyle = .square
      s.color.withAlphaComponent(0.45).setStroke()
      ctx.setBlendMode(.normal)
      path.stroke()
    case .neon:
      ctx.setShadow(offset: .zero, blur: base * 2.2, color: s.color.cgColor)
      path.lineWidth = base * 1.2
      s.color.setStroke()
      path.stroke()
      ctx.setShadow(offset: .zero, blur: 0, color: nil)
      path.lineWidth = base * 0.45
      UIColor.white.setStroke()
      path.stroke()
    case .eraser:
      ctx.setBlendMode(.clear)
      path.lineWidth = base * 2.6
      UIColor.black.setStroke()
      path.stroke()
    }
    ctx.restoreGState()
  }

  /// Traços isolados num bitmap transparente (a borracha só apaga traços).
  static func strokesImage(_ strokes: [SSStroke], size: CGSize, scale: CGFloat) -> UIImage? {
    guard !strokes.isEmpty, size.width > 0, size.height > 0 else { return nil }
    let fmt = UIGraphicsImageRendererFormat.default()
    fmt.scale = scale
    fmt.opaque = false
    return UIGraphicsImageRenderer(size: size, format: fmt).image { r in
      for s in strokes { drawStroke(s, in: CGRect(origin: .zero, size: size), ctx: r.cgContext) }
    }
  }
}

func ssHaptic(_ kind: String) {
  switch kind {
  case "select":
    UISelectionFeedbackGenerator().selectionChanged()
  case "success":
    UINotificationFeedbackGenerator().notificationOccurred(.success)
  case "warn":
    UINotificationFeedbackGenerator().notificationOccurred(.warning)
  case "medium":
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
  default:
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
  }
}

func ssSymbol(_ name: String, _ size: CGFloat, _ weight: UIImage.SymbolWeight = .semibold) -> UIImage? {
  let cfg = UIImage.SymbolConfiguration(pointSize: size, weight: weight)
  return UIImage(systemName: name, withConfiguration: cfg) ?? UIImage(systemName: "circle", withConfiguration: cfg)
}
