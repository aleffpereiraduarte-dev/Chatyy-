import UIKit

// [2026-10-18 bia-orb-icon] Ícone da Bia = ORB (esfera preta brilhante),
// mesmo desenho do components/bia/BiaIcon.js — substitui o SF "sparkles"
// (estrelinha) na lista de Configurações (chave "biaOrb") e na grade de Apps
// (id "one"). Desenhado uma vez por (diâmetro, tema) e mantido em cache.
enum BiaOrbArt {
  private static var cache: [String: UIImage] = [:]

  static func image(diameter: CGFloat, dark: Bool) -> UIImage {
    let d = max(8, diameter)
    let key = "\(Int(d * 10))|\(dark ? 1 : 0)"
    if let hit = cache[key] { return hit }
    let r = d / 2
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: d, height: d))
    let img = renderer.image { ctx in
      let cg = ctx.cgContext
      let rect = CGRect(x: 0.5, y: 0.5, width: d - 1, height: d - 1)
      cg.saveGState()
      cg.addEllipse(in: rect)
      cg.clip()
      let space = CGColorSpaceCreateDeviceRGB()
      // Corpo: gradiente radial deslocado p/ cima-esquerda (luz).
      let body = [UIColor(clHex: 0x55555C).cgColor, UIColor(clHex: 0x1A1A1E).cgColor, UIColor(clHex: 0x030304).cgColor] as CFArray
      if let g = CGGradient(colorsSpace: space, colors: body, locations: [0, 0.55, 1]) {
        let c = CGPoint(x: d * 0.38, y: d * 0.32)
        cg.drawRadialGradient(g, startCenter: c, startRadius: 0, endCenter: c, endRadius: d * 0.72, options: [.drawsAfterEndLocation])
      }
      // Luz refletida embaixo (volume).
      let bounce = [UIColor(white: 1, alpha: 0.22).cgColor, UIColor(white: 1, alpha: 0).cgColor] as CFArray
      if let g = CGGradient(colorsSpace: space, colors: bounce, locations: [0, 1]) {
        cg.saveGState()
        cg.translateBy(x: r * 1.12, y: r * 1.52)
        cg.scaleBy(x: 1, y: 0.46)
        cg.drawRadialGradient(g, startCenter: .zero, startRadius: 0, endCenter: .zero, endRadius: r * 0.52, options: [])
        cg.restoreGState()
      }
      // Reflexo especular em cima à esquerda.
      let spec = [UIColor(white: 1, alpha: 0.85).cgColor, UIColor(white: 1, alpha: 0).cgColor] as CFArray
      if let g = CGGradient(colorsSpace: space, colors: spec, locations: [0, 1]) {
        cg.saveGState()
        cg.translateBy(x: r * 0.72, y: r * 0.6)
        cg.scaleBy(x: 1, y: 0.72)
        cg.drawRadialGradient(g, startCenter: .zero, startRadius: 0, endCenter: .zero, endRadius: r * 0.42, options: [])
        cg.restoreGState()
      }
      cg.restoreGState()
      // Aro de luz sutil (não some no fundo escuro).
      cg.setStrokeColor(UIColor(white: 1, alpha: dark ? 0.2 : 0.14).cgColor)
      cg.setLineWidth(max(0.75, d / 48))
      cg.strokeEllipse(in: rect.insetBy(dx: 0.25, dy: 0.25))
    }
    let out = img.withRenderingMode(.alwaysOriginal)
    if cache.count > 16 { cache.removeAll() }
    cache[key] = out
    return out
  }
}
