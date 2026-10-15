import UIKit
import CoreText

// [2026-10-15 native-list fase 2] Blocos (row.bl / pre / post) — mini layout
// tipo flexbox montado pelo JS (components/chat/nativeNodes.js). Contrato:
// cabeçalho de nativeThreadList.js / SPEC fase 2.
//   • parse tolerante (CMLNode, imutável depois do parse);
//   • measure + place na fila de layout (CoreText) → CMLBlocksLayout com ops
//     PLANAS em coordenadas do balão;
//   • CMLBlocksView desenha tudo num draw só (fundo/borda/texto/ícone/divisor/
//     avatar) + pool de subviews p/ imagem, barra animada, spinner e nota de vídeo.

struct CMLIconPath {
  let path: CGPath
  let fill: UIColor?
  let stroke: UIColor?
  let width: CGFloat
  let alpha: CGFloat
}

final class CMLNode {
  enum Kind { case v, h, z, tx, im, ic, pb, dv, sp, av, ld, vn, unknown }

  var kind: Kind = .unknown
  var children: [CMLNode] = []
  var margin: UIEdgeInsets = .zero
  var padding: UIEdgeInsets = .zero
  var w: CGFloat? = nil          // nil intrínseca; -1 preencher
  var h: CGFloat? = nil
  var bg: UIColor? = nil
  var radius: CGFloat? = nil     // -1 círculo/pílula
  var borderColor: UIColor? = nil
  var borderWidth: CGFloat = 0
  var action: String = ""
  var opacity: CGFloat = 1
  var flex: CGFloat = 0
  var align: String = ""
  var justify: String = ""
  var pos: String = ""
  var id: String = ""
  var gap: CGFloat = 0
  // tx
  var s: String = ""
  var spans: [CMLSpan] = []
  var fs: CGFloat = 14
  var fw: Int = 400
  var italic = false
  var color: UIColor? = nil
  var lh: CGFloat? = nil
  var maxLines = 0
  var textAlign = ""
  var mono = false
  var body = false
  var metaInline = false
  var underline = false
  var letterSpacing: CGFloat = 0
  // im / av / vn
  var uri: String = ""
  var thumb: String = ""
  var ar: CGFloat = 0
  var fit: String = "cover"
  // ic / av / ld / vn
  var size: CGFloat = 0
  var vb: CGFloat = 24
  var paths: [CMLIconPath] = []
  // pb
  var value: CGFloat = 0
  // av
  var initials: String = ""
  // vn
  var poster: String = ""
  var duration: Double = 0
  var ring: UIColor? = nil
  var bg2: UIColor? = nil   // av: fim do degradê diagonal

  var isFill: Bool { return (w ?? 0) < 0 }

  init() {}

  static func list(_ v: Any?, depth: Int = 0) -> [CMLNode] {
    guard let arr = v as? [Any], depth < 24 else { return [] }
    var out: [CMLNode] = []
    out.reserveCapacity(arr.count)
    for a in arr {
      if let d = a as? [String: Any], let n = CMLNode(dict: d, depth: depth) { out.append(n) }
    }
    return out
  }

  static func insets(_ v: Any?) -> UIEdgeInsets? {
    if let n = CMLRow.num(v), n.isFinite { let x = CGFloat(n); return UIEdgeInsets(top: x, left: x, bottom: x, right: x) }
    guard let a = v as? [Any], !a.isEmpty else { return nil }
    let vals = a.map { CGFloat(CMLRow.num($0) ?? 0) }
    switch vals.count {
    case 1: return UIEdgeInsets(top: vals[0], left: vals[0], bottom: vals[0], right: vals[0])
    case 2: return UIEdgeInsets(top: vals[0], left: vals[1], bottom: vals[0], right: vals[1])
    case 3: return UIEdgeInsets(top: vals[0], left: vals[1], bottom: vals[2], right: vals[1])
    default: return UIEdgeInsets(top: vals[0], left: vals[3], bottom: vals[2], right: vals[1])
    }
  }

  private static func color(_ v: Any?) -> UIColor? {
    guard let c = CMLRow.color(v) else { return nil }
    return CMLTheme.uiColor(c)
  }

  private static func cg(_ v: Any?) -> CGFloat? {
    guard let n = CMLRow.num(v), n.isFinite else { return nil }
    return CGFloat(n)
  }

  convenience init?(dict d: [String: Any], depth: Int) {
    self.init()
    switch CMLRow.str(d["t"]) {
    case "v": kind = .v
    case "h": kind = .h
    case "z": kind = .z
    case "tx": kind = .tx
    case "im": kind = .im
    case "ic": kind = .ic
    case "pb": kind = .pb
    case "dv": kind = .dv
    case "sp": kind = .sp
    case "av": kind = .av
    case "ld": kind = .ld
    case "vn": kind = .vn
    default: return nil
    }
    if kind == .v || kind == .h || kind == .z { children = CMLNode.list(d["c"], depth: depth + 1) }
    margin = CMLNode.insets(d["m"]) ?? .zero
    padding = CMLNode.insets(d["p"]) ?? .zero
    if let x = CMLNode.cg(d["w"]) { w = x < 0 ? -1 : x }
    if let x = CMLNode.cg(d["h"]), x >= 0 { h = x }
    bg = CMLNode.color(d["bg"])
    radius = CMLNode.cg(d["r"])
    borderColor = CMLNode.color(d["bc"])
    borderWidth = max(0, CMLNode.cg(d["bw"]) ?? (borderColor != nil ? 1 : 0))
    action = CMLRow.str(d["a"])
    if let o = CMLNode.cg(d["op"]) { opacity = max(0, min(1, o)) }
    flex = max(0, CMLNode.cg(d["fl"]) ?? 0)
    align = CMLRow.str(d["al"])
    justify = CMLRow.str(d["jc"])
    pos = CMLRow.str(d["pos"])
    id = CMLRow.str(d["id"])
    gap = max(0, CMLNode.cg(d["g"]) ?? 0)
    switch kind {
    case .tx:
      s = CMLRow.str(d["s"])
      spans = CMLSpan.parseList(d["sp"])
      fs = max(6, CMLNode.cg(d["fs"]) ?? 14)
      fw = Int(max(100, min(900, CMLNode.cg(d["fw"]) ?? 400)))
      italic = CMLRow.bool(d["it"])
      color = CMLNode.color(d["c"])
      lh = CMLNode.cg(d["lh"])
      maxLines = Int(max(0, min(500, CMLNode.cg(d["ml"]) ?? 0)))
      textAlign = CMLRow.str(d["ta"])
      mono = CMLRow.str(d["ff"]) == "mono"
      body = CMLRow.bool(d["body"])
      metaInline = CMLRow.bool(d["mi"])
      underline = CMLRow.bool(d["u"])
      letterSpacing = CMLNode.cg(d["ls"]) ?? 0
    case .im:
      uri = CMLRow.str(d["u"])
      thumb = CMLRow.str(d["th"])
      ar = max(0, CMLNode.cg(d["ar"]) ?? 0)
      let f = CMLRow.str(d["fit"])
      fit = f.isEmpty ? "cover" : f
    case .ic:
      size = max(1, CMLNode.cg(d["s"]) ?? 18)
      vb = max(1, CMLNode.cg(d["vb"]) ?? 24)
      color = CMLNode.color(d["c"])
      var ps: [CMLIconPath] = []
      if let arr = d["ps"] as? [[String: Any]] {
        for e in arr {
          let dd = CMLRow.str(e["d"])
          if dd.isEmpty { continue }
          let f = CMLNode.color(e["f"])
          let k = CMLNode.color(e["k"])
          if f == nil && k == nil { continue }
          ps.append(CMLIconPath(path: CMLSVGPath.path(dd), fill: f, stroke: k, width: CMLNode.cg(e["w"]) ?? 1.9, alpha: max(0, min(1, CMLNode.cg(e["o"]) ?? 1))))
        }
      }
      paths = ps
    case .pb:
      value = max(0, min(1, CMLNode.cg(d["v"]) ?? 0))
      color = CMLNode.color(d["c"])
    case .dv:
      color = CMLNode.color(d["c"])
    case .av:
      size = max(1, CMLNode.cg(d["s"]) ?? 40)
      uri = CMLRow.str(d["u"])
      initials = CMLRow.str(d["tx"])
      color = CMLNode.color(d["c"])
      fs = max(6, CMLNode.cg(d["fs"]) ?? (size * 0.4))
      bg2 = CMLNode.color(d["bg2"])
    case .ld:
      size = max(1, CMLNode.cg(d["s"]) ?? 20)
      color = CMLNode.color(d["c"])
    case .vn:
      size = max(40, CMLNode.cg(d["s"]) ?? 200)
      uri = CMLRow.str(d["u"])
      poster = CMLRow.str(d["po"])
      duration = max(0, CMLRow.num(d["d"]) ?? 0)
      ring = CMLNode.color(d["ring"])
    default:
      break
    }
  }

  /// Nó sintético (pilha vertical das raízes).
  static func stack(_ kids: [CMLNode]) -> CMLNode {
    let n = CMLNode()
    n.kind = .v
    n.children = kids
    return n
  }

  func collectText(into parts: inout [String]) {
    if kind == .tx && !s.isEmpty { parts.append(s.replacingOccurrences(of: "\u{FFFC}", with: "")) }
    for c in children { c.collectText(into: &parts) }
  }
}

// MARK: - layout

/// Nó medido (árvore temporária, só na fila de layout).
final class CMLMeasured {
  let node: CMLNode
  var size: CGSize = .zero
  var text: CMLTextLayout? = nil
  var avText: CMLTextLayout? = nil
  var kids: [CMLMeasured] = []
  init(_ n: CMLNode) { node = n }
}

struct CMLBlockOp {
  enum K { case box, text, icon, bar, divider, image, avatar, spinner, vnote, clipPush, clipPop }
  let k: K
  let frame: CGRect
  let node: CMLNode
  var text: CMLTextLayout? = nil
  let alpha: CGFloat
  /// raio efetivo (box/imagem/barra/clip)
  var radius: CGFloat = 0
  /// recorte do container arredondado mais interno (imagem: máscara)
  var clip: CGRect = .null
  var clipRadius: CGFloat = 0
}

final class CMLBlocksLayout {
  var ops: [CMLBlockOp] = []
  var actions: [(CGRect, String, CGFloat)] = []   // (frame, ação, raio) — pai antes do filho
  /// Último nó de texto raiz com `mi:1` (host da hora inline): índice em ops.
  var metaHost: Int? = nil
  var bottom: CGFloat = 0
  var lastRootFrame: CGRect = .zero
  var lastRootIsMedia = false

  var isEmpty: Bool { return ops.isEmpty }

  func merge(_ o: CMLBlocksLayout) {
    let base = ops.count
    ops.append(contentsOf: o.ops)
    actions.append(contentsOf: o.actions)
    if let h = o.metaHost { metaHost = base + h }
    bottom = max(bottom, o.bottom)
  }

  func offset(dx: CGFloat, dy: CGFloat) {
    if dx == 0 && dy == 0 { return }
    ops = ops.map { (op: CMLBlockOp) -> CMLBlockOp in
      var n = CMLBlockOp(k: op.k, frame: op.frame.offsetBy(dx: dx, dy: dy), node: op.node, text: op.text, alpha: op.alpha)
      n.radius = op.radius
      n.clip = op.clip.isNull ? .null : op.clip.offsetBy(dx: dx, dy: dy)
      n.clipRadius = op.clipRadius
      return n
    }
    actions = actions.map { ($0.0.offsetBy(dx: dx, dy: dy), $0.1, $0.2) }
    bottom += dy
    lastRootFrame = lastRootFrame.offsetBy(dx: dx, dy: dy)
  }
}

struct CMLNodeCtx {
  let style: CMLStyle
  let textColor: UIColor
  let linkColor: UIColor
}

enum CMLNodeLayout {
  private static let fontCache = NSCache<NSString, UIFont>()

  static func font(_ n: CMLNode, _ s: CMLStyle) -> UIFont {
    if n.body {
      if n.mono { return s.mono }
      if n.fw >= 600 && n.italic { return s.bodyBoldItalic }
      if n.fw >= 600 { return s.bodyBold }
      if n.italic { return s.bodyItalic }
      return s.body
    }
    let size = max(6, n.fs * s.scale)
    let key = "\(size)|\(n.fw)|\(n.italic ? 1 : 0)|\(n.mono ? 1 : 0)" as NSString
    if let f = fontCache.object(forKey: key) { return f }
    let weight: UIFont.Weight
    switch n.fw {
    case ..<250: weight = .thin
    case 250..<350: weight = .light
    case 350..<450: weight = .regular
    case 450..<550: weight = .medium
    case 550..<650: weight = .semibold
    case 650..<750: weight = .bold
    case 750..<850: weight = .heavy
    default: weight = .black
    }
    var f: UIFont = n.mono ? UIFont.monospacedSystemFont(ofSize: size, weight: weight) : UIFont.systemFont(ofSize: size, weight: weight)
    if n.italic, let d = f.fontDescriptor.withSymbolicTraits(f.fontDescriptor.symbolicTraits.union(.traitItalic)) {
      f = UIFont(descriptor: d, size: size)
    }
    fontCache.setObject(f, forKey: key)
    return f
  }

  static func textLayout(_ n: CMLNode, maxWidth: CGFloat, _ c: CMLNodeCtx) -> CMLTextLayout {
    let s = c.style
    let f = font(n, s)
    let color = n.color ?? c.textColor
    let attr = NSMutableAttributedString(attributedString: CMLLayoutBuilder.attributed(n.s, spans: n.spans, font: f, color: color, linkColor: c.linkColor, s: s))
    let len = attr.length
    if len > 0 {
      let all = NSRange(location: 0, length: len)
      if n.underline {
        attr.addAttribute(NSAttributedString.Key(kCTUnderlineStyleAttributeName as String), value: NSNumber(value: CTUnderlineStyle.single.rawValue), range: all)
      }
      if n.letterSpacing != 0 {
        attr.addAttribute(NSAttributedString.Key(kCTKernAttributeName as String), value: NSNumber(value: Double(n.letterSpacing)), range: all)
      }
    }
    let lh: CGFloat
    if n.body { lh = s.lineHeight } else if let l = n.lh, l > 0 { lh = l * s.scale } else { lh = ceil(f.pointSize * 1.3) }
    let t = CMLTextLayout.make(attr, maxWidth: max(10, maxWidth), lineHeight: lh, font: f, maxLines: n.maxLines)
    switch n.textAlign {
    case "c": t.align = 1
    case "r": t.align = 2
    default: t.align = 0
    }
    return t
  }

  // MARK: measure

  static func measure(_ n: CMLNode, _ maxWIn: CGFloat, _ c: CMLNodeCtx, depth: Int = 0) -> CMLMeasured {
    let M = CMLMeasured(n)
    let avail = max(0, maxWIn)
    var boxMax = avail
    if let w = n.w, w > 0 { boxMax = min(w, avail) }
    let innerMax = max(0, boxMax - n.padding.left - n.padding.right)
    let padW = n.padding.left + n.padding.right
    let padH = n.padding.top + n.padding.bottom
    var content = CGSize.zero
    if depth > 24 { M.size = .zero; return M }

    switch n.kind {
    case .tx:
      let t = textLayout(n, maxWidth: innerMax, c)
      M.text = t
      content = CGSize(width: min(innerMax, t.size.width + 1), height: t.size.height)
    case .im:
      var w: CGFloat = 0, h: CGFloat = 0
      if let fw = n.w, fw > 0 { w = min(fw, avail) } else if n.isFill { w = avail }
      if let fh = n.h, fh > 0 { h = fh }
      if w == 0 && h == 0 {
        w = min(100, avail)
        h = n.ar > 0 ? w / n.ar : w
      } else if w == 0 {
        w = min(avail, n.ar > 0 ? h * n.ar : h)
      } else if h == 0 {
        h = n.ar > 0 ? w / n.ar : w
      }
      M.size = CGSize(width: floor(w), height: floor(h))
      return M
    case .ic, .ld:
      let sz = n.kind == .ld ? max(1, n.size) : n.size
      M.size = CGSize(width: sz, height: sz)
      return M
    case .av:
      let sz = n.size
      if !n.initials.isEmpty {
        let f = UIFont.systemFont(ofSize: n.fs * c.style.scale, weight: .semibold)
        M.avText = CMLLayoutBuilder.line(n.initials, font: f, color: n.color ?? .white, maxWidth: sz)
      }
      M.size = CGSize(width: sz, height: sz)
      return M
    case .vn:
      let sz = min(n.size, max(40, avail))
      M.size = CGSize(width: sz, height: sz)
      return M
    case .pb:
      let w: CGFloat = (n.w ?? 0) > 0 ? min(n.w!, avail) : 24
      M.size = CGSize(width: w, height: n.h ?? 6)
      return M
    case .dv:
      let w: CGFloat = (n.w ?? 0) > 0 ? min(n.w!, avail) : 0
      M.size = CGSize(width: w, height: n.h ?? 0.5)
      return M
    case .sp:
      let w: CGFloat = (n.w ?? 0) > 0 ? min(n.w!, avail) : 0
      M.size = CGSize(width: w, height: n.h ?? 0)
      return M
    case .v:
      var w: CGFloat = 0, y: CGFloat = 0
      for (i, ch) in n.children.enumerated() {
        let cm = ch.margin
        let k = measure(ch, innerMax - cm.left - cm.right, c, depth: depth + 1)
        M.kids.append(k)
        w = max(w, k.size.width + cm.left + cm.right)
        y += k.size.height + cm.top + cm.bottom + (i > 0 ? n.gap : 0)
      }
      content = CGSize(width: min(innerMax, w), height: y)
    case .h:
      let count = n.children.count
      var kids = [CMLMeasured?](repeating: nil, count: count)
      let gaps = n.gap * CGFloat(max(0, count - 1))
      var used: CGFloat = 0
      var flexTotal: CGFloat = 0
      for (i, ch) in n.children.enumerated() {
        if ch.flex > 0 { flexTotal += ch.flex; continue }
        let cm = ch.margin
        let k = measure(ch, max(0, innerMax - used - gaps - cm.left - cm.right), c, depth: depth + 1)
        kids[i] = k
        used += k.size.width + cm.left + cm.right
      }
      let rest = max(0, innerMax - used - gaps)
      for (i, ch) in n.children.enumerated() where ch.flex > 0 {
        let cm = ch.margin
        let share = flexTotal > 0 ? rest * ch.flex / flexTotal : 0
        let k = measure(ch, max(0, share - cm.left - cm.right), c, depth: depth + 1)
        k.size.width = max(k.size.width, max(0, share - cm.left - cm.right))
        kids[i] = k
        used += share
      }
      var hmax: CGFloat = 0
      for (i, k) in kids.enumerated() {
        guard let k = k else { continue }
        let cm = n.children[i].margin
        hmax = max(hmax, k.size.height + cm.top + cm.bottom)
        M.kids.append(k)
      }
      content = CGSize(width: min(innerMax, used + gaps), height: hmax)
    case .z:
      var base = CGSize.zero
      for (i, ch) in n.children.enumerated() {
        let cm = ch.margin
        let lim = i == 0 ? innerMax - cm.left - cm.right : max(0, base.width - cm.left - cm.right)
        let k = measure(ch, lim, c, depth: depth + 1)
        if i == 0 { base = CGSize(width: k.size.width + cm.left + cm.right, height: k.size.height + cm.top + cm.bottom) }
        M.kids.append(k)
      }
      content = base
    case .unknown:
      content = .zero
    }
    var sz = CGSize(width: content.width + padW, height: content.height + padH)
    if let fw = n.w, fw > 0 { sz.width = min(fw, avail) }
    if let fh = n.h, fh > 0 { sz.height = fh }
    M.size = CGSize(width: ceil(sz.width), height: ceil(sz.height))
    return M
  }

  // MARK: place

  static func radius(_ n: CMLNode, _ f: CGRect) -> CGFloat {
    guard let r = n.radius else { return 0 }
    if r < 0 { return min(f.width, f.height) / 2 }
    return min(r, min(f.width, f.height) / 2)
  }

  static func place(_ M: CMLMeasured, frame f: CGRect, alpha parentAlpha: CGFloat, into out: CMLBlocksLayout, depth: Int = 0, clip clipIn: CGRect = .null, clipRadius clipRIn: CGFloat = 0) {
    let n = M.node
    let alpha = parentAlpha * n.opacity
    if depth > 24 { return }
    let rad = radius(n, f)
    let isContainer = n.kind == .v || n.kind == .h || n.kind == .z
    // container arredondado recorta os filhos (overflow: hidden do RN)
    let clips = isContainer && rad > 0 && !M.kids.isEmpty
    let clip = clips ? f : clipIn
    let clipR = clips ? rad : clipRIn
    let opsBefore = out.ops.count
    defer {
      if clips {
        var push = CMLBlockOp(k: .clipPush, frame: f, node: n, alpha: alpha)
        push.radius = rad
        // o push entra logo depois do fundo do próprio container
        var at = opsBefore
        if at < out.ops.count, out.ops[at].k == .box, out.ops[at].node === n { at += 1 }
        out.ops.insert(push, at: min(at, out.ops.count))
        out.ops.append(CMLBlockOp(k: .clipPop, frame: f, node: n, alpha: alpha))
      }
      if !clip.isNull {
        for j in opsBefore..<out.ops.count where out.ops[j].k == .image && out.ops[j].clip.isNull {
          out.ops[j].clip = clip
          out.ops[j].clipRadius = clipR
        }
      }
    }
    if n.bg != nil || (n.borderColor != nil && n.borderWidth > 0) {
      if n.kind != .im && n.kind != .av && n.kind != .pb && n.kind != .vn {
        var op = CMLBlockOp(k: .box, frame: f, node: n, alpha: alpha)
        op.radius = rad
        out.ops.append(op)
      }
    }
    if !n.action.isEmpty { out.actions.append((f, n.action, rad)) }
    let inner = f.inset(by: n.padding)
    switch n.kind {
    case .tx:
      if let t = M.text {
        t.alignWidth = inner.width
        out.ops.append(CMLBlockOp(k: .text, frame: CGRect(x: inner.minX, y: inner.minY, width: max(inner.width, t.size.width + 1), height: t.size.height), node: n, text: t, alpha: alpha))
      }
    case .im:
      var op = CMLBlockOp(k: .image, frame: f, node: n, alpha: alpha)
      op.radius = rad
      out.ops.append(op)
    case .ic:
      out.ops.append(CMLBlockOp(k: .icon, frame: f, node: n, alpha: alpha))
    case .pb:
      var op = CMLBlockOp(k: .bar, frame: f, node: n, alpha: alpha)
      op.radius = n.radius == nil ? f.height / 2 : rad
      out.ops.append(op)
    case .dv:
      out.ops.append(CMLBlockOp(k: .divider, frame: f, node: n, alpha: alpha))
    case .av:
      var op = CMLBlockOp(k: .avatar, frame: f, node: n, text: M.avText, alpha: alpha)
      op.radius = f.width / 2
      out.ops.append(op)
    case .ld:
      out.ops.append(CMLBlockOp(k: .spinner, frame: f, node: n, alpha: alpha))
    case .vn:
      var op = CMLBlockOp(k: .vnote, frame: f, node: n, alpha: alpha)
      op.radius = f.width / 2
      out.ops.append(op)
    case .sp, .unknown:
      break
    case .v:
      var total: CGFloat = 0
      for (i, k) in M.kids.enumerated() {
        let cm = k.node.margin
        total += k.size.height + cm.top + cm.bottom + (i > 0 ? n.gap : 0)
      }
      var y = inner.minY
      var gap = n.gap
      let free = max(0, inner.height - total)
      switch n.justify {
      case "c": y += floor(free / 2)
      case "e": y += free
      case "sb": if M.kids.count > 1 { gap += free / CGFloat(M.kids.count - 1) }
      default: break
      }
      for (i, k) in M.kids.enumerated() {
        let cm = k.node.margin
        if i > 0 { y += gap }
        let availW = max(0, inner.width - cm.left - cm.right)
        let cw = k.node.isFill ? availW : min(k.size.width, availW)
        var x = inner.minX + cm.left
        switch n.align {
        case "c": x = inner.minX + cm.left + floor((availW - cw) / 2)
        case "e": x = inner.maxX - cm.right - cw
        default: break
        }
        place(k, frame: CGRect(x: x, y: y + cm.top, width: cw, height: k.size.height), alpha: alpha, into: out, depth: depth + 1, clip: clip, clipRadius: clipR)
        y += k.size.height + cm.top + cm.bottom
      }
    case .h:
      var used: CGFloat = 0
      var flexTotal: CGFloat = 0
      for k in M.kids {
        let cm = k.node.margin
        used += k.size.width + cm.left + cm.right
        flexTotal += k.node.flex
      }
      let count = M.kids.count
      used += n.gap * CGFloat(max(0, count - 1))
      let extra = max(0, inner.width - used)
      var x = inner.minX
      var gap = n.gap
      if flexTotal <= 0 {
        switch n.justify {
        case "c": x += floor(extra / 2)
        case "e": x += extra
        case "sb": if count > 1 { gap += extra / CGFloat(count - 1) }
        default: break
        }
      }
      for (i, k) in M.kids.enumerated() {
        let cm = k.node.margin
        if i > 0 { x += gap }
        var cw = k.size.width
        if flexTotal > 0 && k.node.flex > 0 { cw += floor(extra * k.node.flex / flexTotal) }
        // espaço com largura e sem altura = divisor vertical: estica na altura da linha
        let stretch = k.node.kind == .sp && k.node.h == nil && (k.node.w ?? 0) > 0
        let ch = stretch ? max(0, inner.height - cm.top - cm.bottom) : k.size.height
        var y = inner.minY + cm.top + floor((inner.height - ch - cm.top - cm.bottom) / 2)
        switch n.align {
        case "s": y = inner.minY + cm.top
        case "e": y = inner.maxY - cm.bottom - ch
        default: break
        }
        if stretch { y = inner.minY + cm.top }
        place(k, frame: CGRect(x: x + cm.left, y: y, width: cw, height: ch), alpha: alpha, into: out, depth: depth + 1, clip: clip, clipRadius: clipR)
        x += cw + cm.left + cm.right
      }
    case .z:
      var base = inner
      for (i, k) in M.kids.enumerated() {
        let cm = k.node.margin
        if i == 0 {
          let w = k.node.isFill ? inner.width - cm.left - cm.right : k.size.width
          base = CGRect(x: inner.minX + cm.left, y: inner.minY + cm.top, width: w, height: k.size.height)
          place(k, frame: base, alpha: alpha, into: out, depth: depth + 1, clip: clip, clipRadius: clipR)
          continue
        }
        let w = k.node.isFill ? base.width - cm.left - cm.right : k.size.width
        let h = k.size.height
        let p = k.node.pos.isEmpty ? "c" : k.node.pos
        var x = base.midX - w / 2 + cm.left - cm.right
        var y = base.midY - h / 2 + cm.top - cm.bottom
        if p.contains("l") { x = base.minX + cm.left }
        if p.contains("r") { x = base.maxX - cm.right - w }
        if p.contains("t") { y = base.minY + cm.top }
        if p.contains("b") { y = base.maxY - cm.bottom - h }
        place(k, frame: CGRect(x: floor(x), y: floor(y), width: w, height: h), alpha: alpha, into: out, depth: depth + 1, clip: clip, clipRadius: clipR)
      }
    }
  }

  /// Mede as raízes (pilha vertical implícita) contra `maxW`.
  static func measureRoots(_ roots: [CMLNode], maxW: CGFloat, _ c: CMLNodeCtx) -> (kids: [CMLMeasured], width: CGFloat, height: CGFloat) {
    var kids: [CMLMeasured] = []
    var w: CGFloat = 0, h: CGFloat = 0
    for r in roots {
      let cm = r.margin
      let k = measure(r, maxW - cm.left - cm.right, c)
      kids.append(k)
      w = max(w, k.size.width + cm.left + cm.right)
      h += k.size.height + cm.top + cm.bottom
    }
    return (kids, ceil(w), ceil(h))
  }

  /// Posiciona raízes já medidas a partir de (x, y) com largura `width`.
  static func placeRoots(_ kids: [CMLMeasured], x: CGFloat, y y0: CGFloat, width: CGFloat, align: String = "") -> CMLBlocksLayout {
    let out = CMLBlocksLayout()
    var y = y0
    for (i, k) in kids.enumerated() {
      let cm = k.node.margin
      let availW = max(0, width - cm.left - cm.right)
      let cw = k.node.isFill ? availW : min(k.size.width, availW)
      var xx = x + cm.left
      if align == "e" { xx = x + width - cm.right - cw }
      let f = CGRect(x: xx, y: y + cm.top, width: cw, height: k.size.height)
      let before = out.ops.count
      place(k, frame: f, alpha: 1, into: out)
      if i == kids.count - 1 {
        out.lastRootFrame = f
        out.lastRootIsMedia = k.node.kind == .im || k.node.kind == .vn || k.node.kind == .z
        if k.node.kind == .tx && k.node.metaInline {
          // host = op de texto criado por este nó
          for j in before..<out.ops.count where out.ops[j].k == .text && out.ops[j].node === k.node { out.metaHost = j }
        }
      }
      y += k.size.height + cm.top + cm.bottom
    }
    out.bottom = y
    return out
  }
}
