import UIKit

// [2026-10-19 tabbar-api7] Visibilidade REAL da barra nativa — o que está NA TELA,
// não o que a hierarquia diz.
//
// Builds 728/729/731 (api 3/4/5): o founder não via a barra e o diagnóstico do
// UIKit dizia "tudo certo" (frame na janela, sem ancestral escondido, alpha 1,
// 5 itens, conteúdo com tamanho). Hierarquia não prova pixel. Aqui:
//   1) hitTest da JANELA no centro de cada ícone e da barra: quem está no topo?
//      Uma view de FORA da barra mas da MESMA tela (mesmo UIViewController) =
//      algo pintando/pegando toque por cima → "covered". De outra tela (push,
//      folha, modal) = navegação normal → inconclusivo ("skip_other").
//   2) Captura do que está na tela (drawHierarchy afterScreenUpdates:false, só a
//      faixa dos ícones, escala ≤ 2) e contraste DENTRO × FORA do glifo de cada
//      SF Symbol (máscara alfa da própria imagem do ícone). Ícone visível dá
//      diferença de luminância alta; barra transparente/sem desenho mostra o
//      conteúdo de trás, que não tem o formato do glifo → contraste baixo.
//      Poucos ícones visíveis → "invisible".
// Custo: 1 captura de ~440×40 pt — só ao entrar na janela, voltar ao 1º plano e
// (no máx. 1×/15 s) quando os itens mudam.

enum NTBVisibility {
  struct Icon {
    let rect: CGRect // coordenadas da janela
    let image: UIImage
  }

  struct Result {
    /// ok | covered | invisible | skip_other | skip_noicons | skip_snapshot
    let verdict: String
    /// Quem está no topo no centro da barra (classe#accessibilityIdentifier).
    let hit: String
    /// "visíveis/amostrados:contrastes" (ex.: "5/5:92,88,101,95,90") ou "-".
    let sample: String

    var failed: Bool {
      return verdict == "covered" || verdict == "invisible"
    }
  }

  /// Contraste mínimo (0–255) dentro × fora do glifo para contar o ícone como visível.
  static let minContrast: Int = 22

  static func describe(_ v: UIView?) -> String {
    guard let v = v else { return "nil" }
    let cls = String(describing: type(of: v))
    let ident = v.accessibilityIdentifier ?? ""
    let s = ident.isEmpty ? cls : (cls + "#" + ident)
    return String(s.prefix(48))
  }

  /// UIViewController dono da view (cadeia de responders).
  static func owningController(_ v: UIView) -> UIViewController? {
    var cur: UIResponder? = v
    var n = 0
    while let r = cur, n < 300 {
      if let vc = r as? UIViewController { return vc }
      cur = r.next
      n += 1
    }
    return nil
  }

  /// Menor alpha efetivo (produto) de self até a janela + o 1º ancestral escondido.
  static func ancestorAlpha(_ v: UIView) -> (alpha: CGFloat, hidden: String) {
    var a: CGFloat = 1
    var hidden = "-"
    var cur: UIView? = v
    var depth = 0
    while let c = cur, depth < 60 {
      a *= c.alpha
      if hidden == "-" && (c.isHidden || c.layer.isHidden) {
        hidden = "\(depth):" + String(String(describing: type(of: c)).prefix(24))
      }
      cur = c.superview
      depth += 1
    }
    return (a, hidden)
  }

  /// Ícones de SF Symbol desenhados pelo UITabBar (1 por coluna, o maior).
  static func symbolIcons(in root: UIView, window: UIWindow) -> [Icon] {
    var found: [Icon] = []
    func walk(_ v: UIView, _ depth: Int) {
      if depth > 9 { return }
      for sub in v.subviews where !sub.isHidden && sub.alpha > 0.01 {
        if let iv = sub as? UIImageView, let img = iv.image, img.isSymbolImage,
           iv.bounds.width >= 10, iv.bounds.width <= 60, iv.bounds.height >= 10, iv.bounds.height <= 60 {
          found.append(Icon(rect: iv.convert(iv.bounds, to: window), image: img))
        }
        walk(sub, depth + 1)
      }
    }
    walk(root, 0)
    found.sort { $0.rect.midX < $1.rect.midX }
    var cols: [Icon] = []
    for f in found {
      if let last = cols.last, abs(last.rect.midX - f.rect.midX) < 8 {
        if f.rect.width * f.rect.height > last.rect.width * last.rect.height {
          cols[cols.count - 1] = f
        }
      } else {
        cols.append(f)
      }
    }
    return cols
  }

  /// Pixels RGBA8 (pré-multiplicado, linha 0 = topo) de uma CGImage em w×h.
  static func rgba(_ cg: CGImage, width: Int, height: Int) -> [UInt8]? {
    guard width > 0, height > 0, width <= 4096, height <= 4096 else { return nil }
    var buf = [UInt8](repeating: 0, count: width * height * 4)
    let space = CGColorSpaceCreateDeviceRGB()
    let info: UInt32 = CGImageAlphaInfo.premultipliedLast.rawValue
    let ok: Bool = buf.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) -> Bool in
      guard let base = raw.baseAddress,
            let ctx = CGContext(data: base, width: width, height: height, bitsPerComponent: 8,
                                bytesPerRow: width * 4, space: space, bitmapInfo: info) else { return false }
      ctx.draw(cg, in: CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
      return true
    }
    return ok ? buf : nil
  }

  /// O que está NA TELA dentro de `rect` (coords da janela), na escala `scale`.
  static func snapshot(window: UIWindow, rect: CGRect, scale: CGFloat) -> CGImage? {
    guard rect.width >= 1, rect.height >= 1 else { return nil }
    let fmt = UIGraphicsImageRendererFormat.preferred()
    fmt.scale = scale
    fmt.opaque = true
    let wb = window.bounds
    let renderer = UIGraphicsImageRenderer(size: rect.size, format: fmt)
    let img: UIImage = renderer.image { (_: UIGraphicsImageRendererContext) in
      _ = window.drawHierarchy(in: CGRect(x: -rect.minX, y: -rect.minY, width: wb.width, height: wb.height),
                               afterScreenUpdates: false)
    }
    return img.cgImage
  }

  /// Máscara alfa do glifo (w×h px), na mesma grade da captura.
  static func mask(_ icon: UIImage, width: Int, height: Int) -> [UInt8]? {
    guard width > 0, height > 0 else { return nil }
    let fmt = UIGraphicsImageRendererFormat.preferred()
    fmt.scale = 1
    fmt.opaque = false
    let size = CGSize(width: CGFloat(width), height: CGFloat(height))
    let renderer = UIGraphicsImageRenderer(size: size, format: fmt)
    let img: UIImage = renderer.image { (_: UIGraphicsImageRendererContext) in
      icon.draw(in: CGRect(origin: .zero, size: size))
    }
    guard let cg = img.cgImage else { return nil }
    return rgba(cg, width: width, height: height)
  }

  /// |luminância média dentro do glifo − fora| (0–255); -1 = poucos pixels p/ julgar.
  static func contrast(snap: [UInt8], snapW: Int, snapH: Int,
                       originX: Int, originY: Int, mask m: [UInt8], maskW: Int, maskH: Int) -> Int {
    var inSum = 0, inN = 0, outSum = 0, outN = 0
    for y in 0..<maskH {
      let sy = originY + y
      if sy < 0 || sy >= snapH { continue }
      for x in 0..<maskW {
        let sx = originX + x
        if sx < 0 || sx >= snapW { continue }
        let a = Int(m[(y * maskW + x) * 4 + 3])
        if a > 24 && a < 150 { continue } // borda anti-aliasing: ambígua
        let p = (sy * snapW + sx) * 4
        let lum = (Int(snap[p]) * 299 + Int(snap[p + 1]) * 587 + Int(snap[p + 2]) * 114) / 1000
        if a >= 150 {
          inSum += lum
          inN += 1
        } else {
          outSum += lum
          outN += 1
        }
      }
    }
    guard inN >= 6, outN >= 6 else { return -1 }
    return abs(inSum / inN - outSum / outN)
  }

  /// Checagem completa. `bar` = a view da barra (dona dos toques), `tabBar` = onde estão os ícones.
  static func check(bar: UIView, tabBar: UIView, window: UIWindow) -> Result {
    let icons = symbolIcons(in: tabBar, window: window)
    let center = bar.convert(CGPoint(x: bar.bounds.midX, y: bar.bounds.midY), to: window)
    var points: [CGPoint] = icons.map { (ic: Icon) -> CGPoint in CGPoint(x: ic.rect.midX, y: ic.rect.midY) }
    points.append(center)
    let barVC = owningController(bar)
    var own = 0, covered = 0, other = 0
    var coverDesc = "-"
    for p in points {
      guard let hit = window.hitTest(p, with: nil) else { other += 1; continue }
      if hit === bar || hit.isDescendant(of: bar) {
        own += 1
      } else if barVC != nil && owningController(hit) === barVC {
        covered += 1
        if coverDesc == "-" { coverDesc = describe(hit) }
      } else {
        other += 1
        if coverDesc == "-" { coverDesc = "o:" + describe(hit) }
      }
    }
    let centerHit = window.hitTest(center, with: nil)
    let hitDesc = (centerHit === bar || (centerHit?.isDescendant(of: bar) ?? false))
      ? "own" : (coverDesc != "-" ? coverDesc : describe(centerHit))
    if covered * 2 > points.count {
      return Result(verdict: "covered", hit: hitDesc, sample: "\(own)/\(covered)/\(other)")
    }
    if own * 2 < points.count {
      return Result(verdict: "skip_other", hit: hitDesc, sample: "\(own)/\(covered)/\(other)")
    }
    guard !icons.isEmpty else {
      return Result(verdict: "skip_noicons", hit: hitDesc, sample: "-")
    }

    // Faixa dos ícones, dentro da janela.
    var union = icons[0].rect
    for ic in icons.dropFirst() { union = union.union(ic.rect) }
    union = union.insetBy(dx: -2, dy: -2).intersection(window.bounds).integral
    guard !union.isNull, union.width >= 4, union.height >= 4 else {
      return Result(verdict: "skip_snapshot", hit: hitDesc, sample: "rect")
    }
    let scale: CGFloat = min(2, max(1, window.traitCollection.displayScale))
    guard let cg = snapshot(window: window, rect: union, scale: scale) else {
      return Result(verdict: "skip_snapshot", hit: hitDesc, sample: "cap")
    }
    let sw = cg.width
    let sh = cg.height
    guard let snap = rgba(cg, width: sw, height: sh) else {
      return Result(verdict: "skip_snapshot", hit: hitDesc, sample: "px")
    }
    var visible = 0
    var judged = 0
    var parts: [String] = []
    for ic in icons {
      let mw = Int((ic.rect.width * scale).rounded())
      let mh = Int((ic.rect.height * scale).rounded())
      guard let m = mask(ic.image, width: mw, height: mh) else { parts.append("m"); continue }
      let ox = Int(((ic.rect.minX - union.minX) * scale).rounded())
      let oy = Int(((ic.rect.minY - union.minY) * scale).rounded())
      let c = contrast(snap: snap, snapW: sw, snapH: sh, originX: ox, originY: oy, mask: m, maskW: mw, maskH: mh)
      parts.append(String(c))
      if c < 0 { continue }
      judged += 1
      if c >= minContrast { visible += 1 }
    }
    let sample = "\(visible)/\(judged):" + parts.joined(separator: ",")
    guard judged >= 2 else {
      return Result(verdict: "skip_snapshot", hit: hitDesc, sample: sample)
    }
    // Falha só com MAIORIA clara de ícones apagados (1 ícone pode cair num fundo
    // parecido por acaso): nenhum visível, ou ≤ 1/3 deles.
    if visible == 0 || visible * 3 < judged {
      return Result(verdict: "invisible", hit: hitDesc, sample: sample)
    }
    return Result(verdict: "ok", hit: hitDesc, sample: sample)
  }
}
