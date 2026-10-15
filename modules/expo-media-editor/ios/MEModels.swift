import UIKit
import CoreImage

// [2026-10-15 native-editor] Modelo do editor (espelho do EditorModels.kt).
// Coordenadas NORMALIZADAS na imagem inteira já girada (u,v ∈ 0…1); tamanhos
// relativos ao LADO MENOR dessa imagem (invariante a giros de 90°) → prévia e
// exportação em resolução cheia usam a mesma conta.

struct MEStroke {
  var color: UIColor
  var widthRel: CGFloat
  var pts: [CGPoint] = []
}

struct MEObj {
  var kind: String      // "text" | "sticker"
  var text: String
  var color: UIColor
  var font: Int
  var bg: Int           // 0 sem fundo · 1 sólido · 2 suave
  var u: CGFloat
  var v: CGFloat
  var scale: CGFloat    // fonte = scale × lado menor
  var rot: CGFloat      // radianos
}

struct MEState {
  var rotQ: Int = 0
  var crop = CGRect(x: 0, y: 0, width: 1, height: 1)
  var filterIdx: Int = 0
  var strokes: [MEStroke] = []
  var objs: [MEObj] = []

  var isPristine: Bool {
    return rotQ % 4 == 0 && filterIdx == 0 && strokes.isEmpty && objs.isEmpty
      && crop.minX <= 0.0005 && crop.minY <= 0.0005 && crop.maxX >= 0.9995 && crop.maxY >= 0.9995
  }

  /// Gira 90° horário: (u,v) → (1−v, u).
  mutating func rotateCW() {
    rotQ = (rotQ + 1) % 4
    crop = CGRect(x: 1 - crop.maxY, y: crop.minX, width: crop.height, height: crop.width)
    for i in strokes.indices {
      strokes[i].pts = strokes[i].pts.map { CGPoint(x: 1 - $0.y, y: $0.x) }
    }
    for i in objs.indices {
      let u = objs[i].u
      objs[i].u = 1 - objs[i].v
      objs[i].v = u
      objs[i].rot += .pi / 2
    }
  }
}

struct MEFilter {
  let id: String
  let label: String
  let m: [CGFloat]?   // 4x5 linha a linha, translação 0…1 (formato Skia/JS)

  func apply(_ input: CIImage) -> CIImage {
    guard let m = m, m.count == 20, let f = CIFilter(name: "CIColorMatrix") else { return input }
    f.setValue(input, forKey: kCIInputImageKey)
    f.setValue(CIVector(x: m[0], y: m[1], z: m[2], w: m[3]), forKey: "inputRVector")
    f.setValue(CIVector(x: m[5], y: m[6], z: m[7], w: m[8]), forKey: "inputGVector")
    f.setValue(CIVector(x: m[10], y: m[11], z: m[12], w: m[13]), forKey: "inputBVector")
    f.setValue(CIVector(x: m[15], y: m[16], z: m[17], w: m[18]), forKey: "inputAVector")
    f.setValue(CIVector(x: m[4], y: m[9], z: m[14], w: m[19]), forKey: "inputBiasVector")
    return f.outputImage ?? input
  }
}

enum MEImage {
  // Sem gerência de cor: a matriz age nos valores sRGB codificados (igual ao
  // ColorMatrix do Android / Skia do status) → mesmo visual nas 2 plataformas.
  static let ciContext: CIContext = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull()])

  static func filtered(_ cg: CGImage, _ f: MEFilter?) -> CGImage {
    guard let f = f, f.m != nil else { return cg }
    let ci = CIImage(cgImage: cg)
    let out = f.apply(ci).cropped(to: ci.extent)
    return ciContext.createCGImage(out, from: ci.extent) ?? cg
  }

  static func url(_ s: String) -> URL? {
    if s.hasPrefix("file://") { return URL(string: s) }
    if s.hasPrefix("/") { return URL(fileURLWithPath: s) }
    return URL(string: s)
  }

  /// Decodifica com orientação EXIF aplicada e lado maior ≤ maxPixel.
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

  /// Tamanho já orientado (sem decodificar).
  static func size(_ uri: String) -> CGSize? {
    guard let u = url(uri), let src = CGImageSourceCreateWithURL(u as CFURL, nil),
          let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] else { return nil }
    let w = (p[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue ?? 0
    let h = (p[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue ?? 0
    let o = (p[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
    if o >= 5 && o <= 8 { return CGSize(width: h, height: w) }
    return CGSize(width: w, height: h)
  }

  /// Desenha `cg` girado q×90° (horário) no contexto atual, já transladado.
  static func drawRotated(_ cg: CGImage, q: Int, in ctx: CGContext) {
    let w = CGFloat(cg.width)
    let h = CGFloat(cg.height)
    ctx.saveGState()
    switch ((q % 4) + 4) % 4 {
    case 1: ctx.translateBy(x: h, y: 0); ctx.rotate(by: .pi / 2)
    case 2: ctx.translateBy(x: w, y: h); ctx.rotate(by: .pi)
    case 3: ctx.translateBy(x: 0, y: w); ctx.rotate(by: 3 * .pi / 2)
    default: break
    }
    UIImage(cgImage: cg).draw(in: CGRect(x: 0, y: 0, width: w, height: h))
    ctx.restoreGState()
  }

  static func rotated(_ cg: CGImage, q: Int) -> CGImage {
    let qq = ((q % 4) + 4) % 4
    if qq == 0 { return cg }
    let w = CGFloat(cg.width)
    let h = CGFloat(cg.height)
    let size = qq % 2 == 1 ? CGSize(width: h, height: w) : CGSize(width: w, height: h)
    let fmt = UIGraphicsImageRendererFormat.default()
    fmt.scale = 1
    fmt.opaque = true
    let img = UIGraphicsImageRenderer(size: size, format: fmt).image { r in
      drawRotated(cg, q: qq, in: r.cgContext)
    }
    return img.cgImage ?? cg
  }
}

enum MEDraw {
  static let wrapEm: CGFloat = 11
  static let padEm: CGFloat = 0.32

  static func font(_ i: Int, size: CGFloat) -> UIFont {
    switch i {
    case 1: return UIFont.systemFont(ofSize: size, weight: .light)
    case 2:
      let base = UIFont.systemFont(ofSize: size, weight: .bold)
      if let d = base.fontDescriptor.withDesign(.serif) { return UIFont(descriptor: d, size: size) }
      return UIFont(name: "Georgia-Bold", size: size) ?? base
    case 3: return UIFont.monospacedSystemFont(ofSize: size, weight: .bold)
    case 4: return UIFont.systemFont(ofSize: size, weight: .black)
    default: return UIFont.systemFont(ofSize: size, weight: .bold)
    }
  }

  static func contrastOn(_ c: UIColor) -> UIColor {
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    c.getRed(&r, green: &g, blue: &b, alpha: &a)
    let l = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return l > 0.59 ? .black : .white
  }

  struct Laid {
    let str: NSAttributedString
    let size: CGSize
    let fontPx: CGFloat
  }

  static func layout(_ o: MEObj, short: CGFloat) -> Laid {
    let fontPx = max(4, o.scale * short)
    let para = NSMutableParagraphStyle()
    para.alignment = .center
    para.lineBreakMode = .byWordWrapping
    var attrs: [NSAttributedString.Key: Any] = [.paragraphStyle: para]
    if o.kind == "text" {
      attrs[.font] = font(o.font, size: fontPx)
      attrs[.foregroundColor] = o.bg == 1 ? contrastOn(o.color) : o.color
      if o.bg == 0 {
        let sh = NSShadow()
        sh.shadowColor = UIColor(white: 0, alpha: 0.43)
        sh.shadowBlurRadius = fontPx * 0.08
        sh.shadowOffset = CGSize(width: 0, height: fontPx * 0.03)
        attrs[.shadow] = sh
      }
    } else {
      attrs[.font] = UIFont.systemFont(ofSize: fontPx)
    }
    let text = o.text.isEmpty ? " " : o.text
    let str = NSAttributedString(string: text, attributes: attrs)
    let r = str.boundingRect(with: CGSize(width: fontPx * wrapEm, height: .greatestFiniteMagnitude),
                             options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
    return Laid(str: str, size: CGSize(width: ceil(r.width), height: ceil(r.height)), fontPx: fontPx)
  }

  static func halfBox(_ l: Laid) -> CGSize {
    let pad = l.fontPx * padEm
    return CGSize(width: l.size.width / 2 + pad, height: l.size.height / 2 + pad * 0.7)
  }

  /// Desenha no contexto UIKit atual com centro em `c` (pontos/px do destino).
  static func drawObj(_ o: MEObj, center c: CGPoint, short: CGFloat, in ctx: CGContext, highlight: Bool = false) {
    let l = layout(o, short: short)
    let hb = halfBox(l)
    ctx.saveGState()
    ctx.translateBy(x: c.x, y: c.y)
    ctx.rotate(by: o.rot)
    let box = CGRect(x: -hb.width, y: -hb.height, width: hb.width * 2, height: hb.height * 2)
    if o.kind == "text" && o.bg != 0 {
      let p = UIBezierPath(roundedRect: box, cornerRadius: l.fontPx * 0.36)
      (o.bg == 1 ? o.color : UIColor(white: 0, alpha: 0.55)).setFill()
      p.fill()
    }
    if highlight {
      let p = UIBezierPath(roundedRect: box.insetBy(dx: -4, dy: -4), cornerRadius: 8)
      UIColor(white: 1, alpha: 0.8).setStroke()
      p.lineWidth = max(1.5, short * 0.003)
      p.stroke()
    }
    let tr = CGRect(x: -l.size.width / 2, y: -l.size.height / 2, width: l.size.width, height: l.size.height)
    l.str.draw(with: tr, options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
    ctx.restoreGState()
  }

  /// Traço: pontos normalizados → retângulo da imagem inteira `f`.
  static func drawStroke(_ s: MEStroke, full f: CGRect, short: CGFloat, in ctx: CGContext) {
    guard !s.pts.isEmpty else { return }
    let w = max(1, s.widthRel * short)
    func P(_ p: CGPoint) -> CGPoint { return CGPoint(x: f.minX + p.x * f.width, y: f.minY + p.y * f.height) }
    ctx.saveGState()
    if s.pts.count == 1 {
      let c = P(s.pts[0])
      s.color.setFill()
      ctx.fillEllipse(in: CGRect(x: c.x - w / 2, y: c.y - w / 2, width: w, height: w))
      ctx.restoreGState()
      return
    }
    let path = UIBezierPath()
    path.lineWidth = w
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    path.move(to: P(s.pts[0]))
    var prev = s.pts[0]
    for i in 1..<s.pts.count {
      let p = s.pts[i]
      let mid = CGPoint(x: (prev.x + p.x) / 2, y: (prev.y + p.y) / 2)
      path.addQuadCurve(to: P(mid), controlPoint: P(prev))
      prev = p
    }
    path.addLine(to: P(prev))
    s.color.setStroke()
    path.stroke()
    ctx.restoreGState()
  }
}

enum MEIcon {
  static func image(_ name: String, size: CGFloat = 20, weight: UIImage.SymbolWeight = .semibold) -> UIImage? {
    let sym: String
    switch name {
    case "close": sym = "xmark"
    case "undo": sym = "arrow.uturn.backward"
    case "crop": sym = "crop"
    case "draw": sym = "scribble"
    case "text": sym = "textformat"
    case "sticker": sym = "face.smiling"
    case "filter": sym = "camera.filters"
    case "rotate": sym = "rotate.right"
    case "send": sym = "paperplane.fill"
    case "check": sym = "checkmark"
    case "soundOn": sym = "speaker.wave.2.fill"
    case "soundOff": sym = "speaker.slash.fill"
    case "trash": sym = "trash"
    case "cover": sym = "photo"
    case "bg": sym = "character.textbox"
    case "play": sym = "play.fill"
    default: sym = name
    }
    let cfg = UIImage.SymbolConfiguration(pointSize: size, weight: weight)
    return UIImage(systemName: sym, withConfiguration: cfg) ?? UIImage(systemName: "circle", withConfiguration: cfg)
  }
}

extension UIColor {
  convenience init(argb: Int) {
    let a = CGFloat((argb >> 24) & 0xFF) / 255
    let r = CGFloat((argb >> 16) & 0xFF) / 255
    let g = CGFloat((argb >> 8) & 0xFF) / 255
    let b = CGFloat(argb & 0xFF) / 255
    self.init(red: r, green: g, blue: b, alpha: a)
  }
}
