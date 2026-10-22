import UIKit

// [2026-10-15 native-ctxmenu] Menu de contexto da MENSAGEM 100% nativo
// (nível Telegram iOS). Dono: CMLListView (prop ctxMenu, apiVersion 3).
//   • long-press → snapshot REAL do balão sai da lista (spring 1→1.04→1),
//     fundo com blur + escurecimento animados, balão se reposiciona/encolhe
//     para caber;
//   • barra de reações (6 rápidas + "+") com entrada escalonada; "+" expande
//     para a grade de emojis (busca + recentes) — dados do JS
//     (components/chat/nativeEmojiData.js), cache estático;
//   • menu de ações (blur, SF Symbols / paths do Icons.js, destrutivas em
//     vermelho) — LISTA vinda do JS (components/chat/nativeContextMenu.js);
//   • tocar fora → animação reversa (balão volta ao lugar da célula);
//   • reação escolhida "voa" até a bolha; o chip aparece com pop
//     (CMLListView.checkPendingPop → CMLCell.popReactions).
// Só APIs ≤ iOS 15 (deployment 15.1).

// MARK: - dados

struct CMLCtxAction {
  let id: String
  let title: String
  let sub: String
  let sf: String
  let paths: [CMLIconPath]
  let vb: CGFloat
  let destructive: Bool
  let disabled: Bool
}

final class CMLCtxTheme {
  var dark = false
  var accent = UIColor.systemBlue
  var text = UIColor.label
  var sub = UIColor.secondaryLabel
  var destructive = UIColor.systemRed
  var menuBg = UIColor(white: 1, alpha: 0.82)
  var menuSolid = UIColor.white
  var sep = UIColor(white: 0.5, alpha: 0.25)
  var press = UIColor(white: 0, alpha: 0.07)
  var reactBg = UIColor.white
  var mineBg = UIColor(white: 0, alpha: 0.08)
  var dim = UIColor(white: 0, alpha: 0.22)
  var field = UIColor(white: 0.46, alpha: 0.12)

  init(_ d: [String: Any]?, dark: Bool) {
    self.dark = dark
    if dark {
      text = .white
      sub = UIColor(white: 0.92, alpha: 0.6)
      menuBg = UIColor(white: 0.12, alpha: 0.8)
      menuSolid = UIColor(white: 0.145, alpha: 1)
      sep = UIColor(white: 0.33, alpha: 0.55)
      press = UIColor(white: 1, alpha: 0.1)
      reactBg = UIColor(white: 0.145, alpha: 1)
      mineBg = UIColor(white: 1, alpha: 0.16)
      dim = UIColor(white: 0, alpha: 0.45)
      field = UIColor(white: 0.46, alpha: 0.24)
    }
    guard let d = d else { return }
    func c(_ k: String) -> UIColor? { CMLRow.color(d[k]).map { CMLTheme.uiColor($0) } }
    if let v = c("accent") { accent = v }
    if let v = c("text") { text = v }
    if let v = c("sub") { sub = v }
    if let v = c("destructive") { destructive = v }
    if let v = c("menuBg") { menuBg = v }
    if let v = c("menuSolid") { menuSolid = v }
    if let v = c("sep") { sep = v }
    if let v = c("press") { press = v }
    if let v = c("reactBg") { reactBg = v }
    if let v = c("mineBg") { mineBg = v }
    if let v = c("dim") { dim = v }
    if let v = c("field") { field = v }
  }
}

struct CMLCtxMenuData {
  let key: String
  let messageId: String
  let own: Bool
  let showReactions: Bool
  let reactions: [String]
  let mine: String
  let actions: [CMLCtxAction]
  let theme: CMLCtxTheme
  let labels: [String: String]
  let recents: [String]

  init(_ d: [String: Any]) {
    key = CMLRow.str(d["key"])
    messageId = CMLRow.str(d["messageId"])
    own = CMLRow.bool(d["own"])
    showReactions = d["showReactions"] == nil ? true : CMLRow.bool(d["showReactions"])
    reactions = ((d["reactions"] as? [Any]) ?? []).map { CMLRow.str($0) }.filter { !$0.isEmpty }
    mine = CMLRow.str(d["mine"])
    let dark = CMLRow.bool(d["dark"])
    theme = CMLCtxTheme(d["theme"] as? [String: Any], dark: dark)
    var acts: [CMLCtxAction] = []
    for a in (d["actions"] as? [Any]) ?? [] {
      guard let m = a as? [String: Any] else { continue }
      let id = CMLRow.str(m["id"])
      if id.isEmpty { continue }
      var paths: [CMLIconPath] = []
      var vb: CGFloat = 24
      if let ic = m["ic"] as? [String: Any] {
        var nd: [String: Any] = ["t": "ic", "s": 22]
        nd["vb"] = ic["vb"] ?? 24
        nd["ps"] = ic["ps"] ?? []
        if let n = CMLNode(dict: nd, depth: 0) { paths = n.paths; vb = n.vb }
      }
      acts.append(CMLCtxAction(id: id, title: CMLRow.str(m["title"]), sub: CMLRow.str(m["sub"]), sf: CMLRow.str(m["sf"]),
                               paths: paths, vb: vb, destructive: CMLRow.bool(m["destructive"]), disabled: CMLRow.bool(m["disabled"])))
    }
    actions = acts
    var lb: [String: String] = [:]
    if let l = d["labels"] as? [String: Any] { for (k, v) in l { lb[k] = CMLRow.str(v) } }
    labels = lb
    recents = ((d["recents"] as? [Any]) ?? []).map { CMLRow.str($0) }.filter { !$0.isEmpty }
    if let e = d["emoji"] { CMLEmojiStore.update(e) }
  }
}

/// Catálogo de emojis (mandado pelo JS uma vez por sessão).
enum CMLEmojiStore {
  struct Cat { let title: String; let emojis: [String]; let keys: [String] }
  static var cats: [Cat] = []

  static func update(_ v: Any?) {
    guard let d = v as? [String: Any], let arr = d["cats"] as? [Any] else { return }
    var out: [Cat] = []
    for x in arr {
      guard let m = x as? [String: Any] else { continue }
      let e = ((m["e"] as? [Any]) ?? []).map { CMLRow.str($0) }
      var k = ((m["k"] as? [Any]) ?? []).map { fold(CMLRow.str($0)) }
      while k.count < e.count { k.append("") }
      if e.isEmpty { continue }
      out.append(Cat(title: CMLRow.str(m["t"]), emojis: e, keys: k))
    }
    if !out.isEmpty { cats = out }
  }

  static func fold(_ s: String) -> String {
    return s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil).lowercased()
  }

  static func search(_ q: String) -> [String] {
    let f = fold(q.trimmingCharacters(in: .whitespacesAndNewlines))
    if f.isEmpty { return [] }
    var out: [String] = []
    var seen = Set<String>()
    for c in cats {
      for (i, e) in c.emojis.enumerated() where !seen.contains(e) {
        let k = i < c.keys.count ? c.keys[i] : ""
        if e == q || k.contains(f) {
          out.append(e)
          seen.insert(e)
        }
      }
    }
    return out
  }
}

// MARK: - ícone (paths do Icons.js pintados com a cor da linha)

final class CMLCtxIconView: UIView {
  var paths: [CMLIconPath] = [] { didSet { setNeedsDisplay() } }
  var vb: CGFloat = 24
  var tint: UIColor = .label { didSet { setNeedsDisplay() } }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    isUserInteractionEnabled = false
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func draw(_ rect: CGRect) {
    guard let ctx = UIGraphicsGetCurrentContext(), !paths.isEmpty, vb > 0 else { return }
    let s = min(bounds.width, bounds.height) / vb
    ctx.saveGState()
    ctx.translateBy(x: (bounds.width - vb * s) / 2, y: (bounds.height - vb * s) / 2)
    ctx.scaleBy(x: s, y: s)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    for p in paths {
      ctx.setAlpha(p.alpha)
      if p.fill != nil {
        ctx.addPath(p.path)
        ctx.setFillColor(tint.cgColor)
        ctx.fillPath()
      }
      if p.stroke != nil {
        ctx.addPath(p.path)
        ctx.setStrokeColor(tint.cgColor)
        ctx.setLineWidth(p.width)
        ctx.strokePath()
      }
    }
    ctx.restoreGState()
  }
}

// MARK: - barra de reações

final class CMLReactBar: UIView {
  static let height: CGFloat = 52
  private static let itemW: CGFloat = 44
  private static let pad: CGFloat = 6

  var onPick: ((String, CGRect) -> Void)?
  var onMore: (() -> Void)?
  private(set) var items: [UIView] = []
  private let bg = UIView()
  private let emojis: [String]
  private let mine: String
  private let theme: CMLCtxTheme

  init(emojis: [String], mine: String, theme: CMLCtxTheme, moreLabel: String) {
    self.emojis = emojis
    self.mine = mine
    self.theme = theme
    super.init(frame: .zero)
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = theme.dark ? 0.35 : 0.14
    layer.shadowRadius = 14
    layer.shadowOffset = CGSize(width: 0, height: 4)
    bg.backgroundColor = theme.reactBg
    bg.layer.cornerRadius = CMLReactBar.height / 2
    bg.layer.cornerCurve = .continuous
    addSubview(bg)
    for (i, e) in emojis.enumerated() {
      let b = UIButton(type: .custom)
      b.tag = i
      b.setTitle(e, for: .normal)
      b.titleLabel?.font = UIFont.systemFont(ofSize: 29)
      b.accessibilityLabel = e
      if e == mine {
        b.backgroundColor = theme.mineBg
        b.layer.cornerRadius = 19
        b.accessibilityTraits.insert(.selected)
      }
      b.addTarget(self, action: #selector(down(_:)), for: [.touchDown, .touchDragEnter])
      b.addTarget(self, action: #selector(up(_:)), for: [.touchUpOutside, .touchCancel, .touchDragExit])
      b.addTarget(self, action: #selector(pick(_:)), for: .touchUpInside)
      addSubview(b)
      items.append(b)
    }
    let more = UIButton(type: .custom)
    more.tag = -1
    let cfg = UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
    more.setImage(UIImage(systemName: "plus", withConfiguration: cfg), for: .normal)
    more.tintColor = theme.sub
    more.backgroundColor = theme.field
    more.layer.cornerRadius = 16
    more.accessibilityLabel = moreLabel
    more.addTarget(self, action: #selector(down(_:)), for: [.touchDown, .touchDragEnter])
    more.addTarget(self, action: #selector(up(_:)), for: [.touchUpOutside, .touchCancel, .touchDragExit])
    more.addTarget(self, action: #selector(moreTap), for: .touchUpInside)
    addSubview(more)
    items.append(more)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  var preferredWidth: CGFloat {
    return CMLReactBar.pad * 2 + CGFloat(emojis.count) * CMLReactBar.itemW + 42
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    bg.frame = bounds
    layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: bounds.height / 2).cgPath
    // estreito: encolhe os slots p/ caber
    let avail = bounds.width - CMLReactBar.pad * 2 - 42
    let w = emojis.isEmpty ? 0 : min(CMLReactBar.itemW, avail / CGFloat(emojis.count))
    var x = CMLReactBar.pad
    for (i, v) in items.enumerated() {
      let t = v.transform
      v.transform = .identity
      if i < emojis.count {
        let s: CGFloat = min(38, w)
        v.frame = CGRect(x: x + (w - s) / 2, y: (bounds.height - s) / 2, width: s, height: s)
        x += w
      } else {
        v.frame = CGRect(x: x + 5, y: (bounds.height - 32) / 2, width: 32, height: 32)
      }
      v.transform = t
    }
  }

  /// Entrada escalonada (cada emoji com spring, 25 ms de intervalo).
  func animateIn(reduce: Bool) {
    if reduce { return }
    for (i, v) in items.enumerated() {
      v.alpha = 0
      v.transform = CGAffineTransform(scaleX: 0.25, y: 0.25)
      UIView.animate(withDuration: 0.55, delay: 0.04 + Double(i) * 0.025, usingSpringWithDamping: 0.55, initialSpringVelocity: 0.4,
                     options: [.allowUserInteraction, .beginFromCurrentState], animations: {
        v.alpha = 1
        v.transform = .identity
      })
    }
  }

  @objc private func down(_ b: UIButton) {
    UIView.animate(withDuration: 0.16, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState, .curveEaseOut], animations: {
      b.transform = CGAffineTransform(scaleX: 1.28, y: 1.28).translatedBy(x: 0, y: b.tag >= 0 ? -3 : 0)
    })
  }

  @objc private func up(_ b: UIButton) {
    UIView.animate(withDuration: 0.3, delay: 0, usingSpringWithDamping: 0.6, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
      b.transform = .identity
    })
  }

  @objc private func pick(_ b: UIButton) {
    guard b.tag >= 0, b.tag < emojis.count else { return }
    onPick?(emojis[b.tag], b.convert(b.bounds, to: nil))
  }

  @objc private func moreTap(_ b: UIButton) {
    up(b)
    onMore?()
  }
}

// MARK: - menu de ações

final class CMLActionRow: UIControl {
  static let rowH: CGFloat = 44
  static let rowHSub: CGFloat = 56
  let action: CMLCtxAction
  private let title = UILabel()
  private let subLabel = UILabel()
  private let sfIcon = UIImageView()
  private let pathIcon = CMLCtxIconView()
  private let pressBg = UIView()
  private let theme: CMLCtxTheme
  private var twoLine = false

  /// Largura útil do título (menu 250 − margens − ícone).
  static let titleWidth: CGFloat = CMLActionMenu.width - 16 - 26 - 16 - 10

  static func needsTwoLines(_ t: String, hasSub: Bool) -> Bool {
    if hasSub || t.isEmpty { return false }
    let w = (t as NSString).size(withAttributes: [.font: UIFont.systemFont(ofSize: 17)]).width
    return w * 0.8 > titleWidth
  }

  init(_ a: CMLCtxAction, theme: CMLCtxTheme) {
    action = a
    self.theme = theme
    super.init(frame: .zero)
    let color = a.disabled ? theme.sub : (a.destructive ? theme.destructive : theme.text)
    pressBg.backgroundColor = theme.press
    pressBg.alpha = 0
    pressBg.isUserInteractionEnabled = false
    addSubview(pressBg)
    title.text = a.title
    title.font = UIFont.systemFont(ofSize: 17)
    title.textColor = color
    // [2026-10-17 ctx-fit] Sem "…": encolhe até 80% numa linha; se ainda não
    // couber, quebra em 2 linhas (a linha cresce — ver rowHeight).
    twoLine = CMLActionRow.needsTwoLines(a.title, hasSub: !a.sub.isEmpty)
    title.numberOfLines = twoLine ? 2 : 1
    title.lineBreakMode = twoLine ? .byWordWrapping : .byTruncatingTail
    title.adjustsFontSizeToFitWidth = true
    title.minimumScaleFactor = twoLine ? 0.85 : 0.8
    if twoLine { title.font = UIFont.systemFont(ofSize: 16) }
    addSubview(title)
    if !a.sub.isEmpty {
      subLabel.text = a.sub
      subLabel.font = UIFont.systemFont(ofSize: 12)
      subLabel.textColor = theme.sub
      subLabel.numberOfLines = 1
      addSubview(subLabel)
    }
    var img: UIImage? = nil
    if !a.sf.isEmpty {
      img = UIImage(systemName: a.sf, withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .regular))
    }
    if let img = img {
      sfIcon.image = img
      sfIcon.tintColor = color
      sfIcon.contentMode = .center
      addSubview(sfIcon)
    } else if !a.paths.isEmpty {
      pathIcon.paths = a.paths
      pathIcon.vb = a.vb
      pathIcon.tint = color
      addSubview(pathIcon)
    }
    isEnabled = !a.disabled
    isAccessibilityElement = true
    accessibilityLabel = a.sub.isEmpty ? a.title : "\(a.title), \(a.sub)"
    accessibilityTraits = a.disabled ? UIAccessibilityTraits([.button, .notEnabled]) : UIAccessibilityTraits.button
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  var rowHeight: CGFloat { return twoLine ? 60 : (action.sub.isEmpty ? CMLActionRow.rowH : CMLActionRow.rowHSub) }

  override func layoutSubviews() {
    super.layoutSubviews()
    pressBg.frame = bounds
    let iconW: CGFloat = 26
    let right = bounds.width - 16 - iconW
    sfIcon.frame = CGRect(x: right, y: (bounds.height - iconW) / 2, width: iconW, height: iconW)
    pathIcon.frame = CGRect(x: right + 2, y: (bounds.height - 22) / 2, width: 22, height: 22)
    let tw = max(0, right - 16 - 10)
    if action.sub.isEmpty {
      title.frame = CGRect(x: 16, y: 0, width: tw, height: bounds.height)
    } else {
      title.frame = CGRect(x: 16, y: 9, width: tw, height: 22)
      subLabel.frame = CGRect(x: 16, y: 31, width: tw, height: 16)
    }
  }

  override var isHighlighted: Bool {
    didSet {
      guard oldValue != isHighlighted else { return }
      UIView.animate(withDuration: isHighlighted ? 0.06 : 0.22, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
        self.pressBg.alpha = self.isHighlighted ? 1 : 0
      })
    }
  }
}

final class CMLActionMenu: UIView {
  static let width: CGFloat = 250
  var onAction: ((CMLCtxAction) -> Void)?
  private let clip = UIView()
  private let blur: UIVisualEffectView
  private let tintLayer = UIView()
  private let scroll = UIScrollView()
  private(set) var rows: [CMLActionRow] = []
  private var seps: [UIView] = []
  private let theme: CMLCtxTheme

  init(actions: [CMLCtxAction], theme: CMLCtxTheme) {
    self.theme = theme
    blur = UIVisualEffectView(effect: UIBlurEffect(style: theme.dark ? .systemThickMaterialDark : .systemThickMaterialLight))
    super.init(frame: .zero)
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = theme.dark ? 0.4 : 0.16
    layer.shadowRadius = 18
    layer.shadowOffset = CGSize(width: 0, height: 6)
    clip.layer.cornerRadius = 14
    clip.layer.cornerCurve = .continuous
    clip.clipsToBounds = true
    addSubview(clip)
    clip.addSubview(blur)
    tintLayer.backgroundColor = theme.menuBg.withAlphaComponent(min(0.55, theme.menuBg.cgColor.alpha))
    tintLayer.isUserInteractionEnabled = false
    clip.addSubview(tintLayer)
    scroll.showsVerticalScrollIndicator = false
    scroll.alwaysBounceVertical = false
    scroll.delaysContentTouches = false
    clip.addSubview(scroll)
    for (i, a) in actions.enumerated() {
      if i > 0 {
        let s = UIView()
        // Telegram: divisor mais grosso antes do 1º destrutivo (grupo)
        s.backgroundColor = theme.sep
        seps.append(s)
        scroll.addSubview(s)
      }
      let r = CMLActionRow(a, theme: theme)
      r.addTarget(self, action: #selector(tap(_:)), for: .touchUpInside)
      rows.append(r)
      scroll.addSubview(r)
    }
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private func sepH(_ i: Int) -> CGFloat {
    // separador i fica ANTES de rows[i+1]
    let next = rows[i + 1].action
    let prev = rows[i].action
    if (next.destructive || next.disabled) && !(prev.destructive || prev.disabled) { return 8 }
    return 1 / UIScreen.main.scale
  }

  var contentHeight: CGFloat {
    var h: CGFloat = 0
    for (i, r) in rows.enumerated() {
      h += r.rowHeight
      if i < rows.count - 1 { h += sepH(i) }
    }
    return h
  }

  func preferredHeight(max m: CGFloat) -> CGFloat { return min(contentHeight, max(CMLActionRow.rowH * 2, m)) }

  override func layoutSubviews() {
    super.layoutSubviews()
    clip.frame = bounds
    blur.frame = bounds
    tintLayer.frame = bounds
    scroll.frame = bounds
    layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: 14).cgPath
    var y: CGFloat = 0
    for (i, r) in rows.enumerated() {
      let t = r.transform
      r.transform = .identity
      r.frame = CGRect(x: 0, y: y, width: bounds.width, height: r.rowHeight)
      r.transform = t
      y += r.rowHeight
      if i < rows.count - 1 {
        let h = sepH(i)
        seps[i].frame = CGRect(x: 0, y: y, width: bounds.width, height: h)
        seps[i].backgroundColor = h > 1 ? theme.sep.withAlphaComponent(min(1, theme.sep.cgColor.alpha * 0.6)) : theme.sep
        y += h
      }
    }
    scroll.contentSize = CGSize(width: bounds.width, height: y)
    scroll.isScrollEnabled = y > bounds.height + 0.5
  }

  /// Linhas descendo em cascata (18 ms).
  func animateRowsIn(reduce: Bool) {
    if reduce { return }
    for (i, r) in rows.enumerated() {
      r.alpha = 0
      r.transform = CGAffineTransform(translationX: 0, y: -8)
      UIView.animate(withDuration: 0.32, delay: 0.03 + Double(i) * 0.018, options: [.curveEaseOut, .allowUserInteraction], animations: {
        r.alpha = 1
        r.transform = .identity
      })
    }
  }

  @objc private func tap(_ r: CMLActionRow) {
    guard !r.action.disabled else { return }
    onAction?(r.action)
  }
}

// MARK: - grade de emojis ("+")

final class CMLEmojiCell: UICollectionViewCell {
  static let reuseId = "cmlEmoji"
  let label = UILabel()
  override init(frame: CGRect) {
    super.init(frame: frame)
    label.font = UIFont.systemFont(ofSize: 30)
    label.textAlignment = .center
    contentView.addSubview(label)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func layoutSubviews() {
    super.layoutSubviews()
    label.frame = contentView.bounds
  }
  override var isHighlighted: Bool {
    didSet {
      UIView.animate(withDuration: 0.12, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
        self.label.transform = self.isHighlighted ? CGAffineTransform(scaleX: 1.25, y: 1.25) : .identity
      })
    }
  }
}

final class CMLEmojiHeader: UICollectionReusableView {
  static let reuseId = "cmlEmojiHeader"
  let label = UILabel()
  override init(frame: CGRect) {
    super.init(frame: frame)
    label.font = UIFont.systemFont(ofSize: 13, weight: .semibold)
    addSubview(label)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func layoutSubviews() {
    super.layoutSubviews()
    label.frame = bounds.insetBy(dx: 6, dy: 0)
  }
}

final class CMLEmojiPanel: UIView, UICollectionViewDataSource, UICollectionViewDelegateFlowLayout, UITextFieldDelegate {
  var onPick: ((String, CGRect) -> Void)?
  private let clip = UIView()
  private let blur: UIVisualEffectView
  private let search = UISearchTextField()
  private let flow: UICollectionViewFlowLayout
  private let cv: UICollectionView
  private let empty = UILabel()
  private let theme: CMLCtxTheme
  private var sections: [(String, [String])] = []
  private var base: [(String, [String])] = []
  private let mine: String
  let content = UIView()

  init(theme: CMLCtxTheme, recents: [String], quick: [String], mine: String, labels: [String: String]) {
    self.theme = theme
    self.mine = mine
    blur = UIVisualEffectView(effect: UIBlurEffect(style: theme.dark ? .systemThickMaterialDark : .systemThickMaterialLight))
    let fl = UICollectionViewFlowLayout()
    flow = fl
    cv = UICollectionView(frame: .zero, collectionViewLayout: fl)
    super.init(frame: .zero)
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = theme.dark ? 0.4 : 0.16
    layer.shadowRadius = 18
    layer.shadowOffset = CGSize(width: 0, height: 6)
    clip.clipsToBounds = true
    clip.layer.cornerCurve = .continuous
    clip.layer.cornerRadius = CMLReactBar.height / 2
    clip.backgroundColor = theme.reactBg.withAlphaComponent(0.55)
    addSubview(clip)
    clip.addSubview(blur)
    clip.addSubview(content)
    content.alpha = 0
    search.placeholder = labels["search"] ?? "Buscar emoji"
    search.font = UIFont.systemFont(ofSize: 16)
    search.textColor = theme.text
    search.backgroundColor = theme.field
    search.returnKeyType = .search
    search.autocorrectionType = .no
    search.delegate = self
    search.addTarget(self, action: #selector(changed), for: .editingChanged)
    content.addSubview(search)
    flow.itemSize = CGSize(width: 42, height: 42)
    flow.minimumInteritemSpacing = 2
    flow.minimumLineSpacing = 2
    flow.headerReferenceSize = CGSize(width: 10, height: 30)
    flow.sectionInset = UIEdgeInsets(top: 0, left: 8, bottom: 8, right: 8)
    cv.backgroundColor = .clear
    cv.keyboardDismissMode = .onDrag
    cv.alwaysBounceVertical = true
    cv.dataSource = self
    cv.delegate = self
    cv.register(CMLEmojiCell.self, forCellWithReuseIdentifier: CMLEmojiCell.reuseId)
    cv.register(CMLEmojiHeader.self, forSupplementaryViewOfKind: UICollectionView.elementKindSectionHeader, withReuseIdentifier: CMLEmojiHeader.reuseId)
    content.addSubview(cv)
    empty.text = labels["noResults"] ?? "Nenhum emoji encontrado"
    empty.font = UIFont.systemFont(ofSize: 15)
    empty.textColor = theme.sub
    empty.textAlignment = .center
    empty.isHidden = true
    content.addSubview(empty)
    var rec: [String] = []
    var seen = Set<String>()
    for e in recents + quick where !e.isEmpty && !seen.contains(e) && !e.hasPrefix("sticker:") {
      rec.append(e)
      seen.insert(e)
    }
    if !rec.isEmpty { base.append((labels["recents"] ?? "Recentes", Array(rec.prefix(24)))) }
    for c in CMLEmojiStore.cats { base.append((c.title, c.emojis)) }
    sections = base
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func setCorner(_ r: CGFloat) { clip.layer.cornerRadius = r }

  override func layoutSubviews() {
    super.layoutSubviews()
    clip.frame = bounds
    blur.frame = bounds
    content.frame = bounds
    layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: clip.layer.cornerRadius).cgPath
    search.frame = CGRect(x: 10, y: 10, width: max(0, bounds.width - 20), height: 36)
    cv.frame = CGRect(x: 0, y: 52, width: bounds.width, height: max(0, bounds.height - 52))
    empty.frame = CGRect(x: 16, y: 70, width: max(0, bounds.width - 32), height: 40)
    // colunas exatas: distribui a sobra no espaçamento
    let w = cv.bounds.width - 16
    if w > 0 {
      let cols = max(1, floor((w + 2) / 44))
      let item = floor((w - (cols - 1) * 2) / cols)
      if abs(flow.itemSize.width - item) > 0.5 { flow.itemSize = CGSize(width: item, height: 42); flow.invalidateLayout() }
    }
  }

  func showContent(reduce: Bool) {
    UIView.animate(withDuration: reduce ? 0.1 : 0.22, delay: reduce ? 0 : 0.08, options: [.curveEaseOut], animations: { self.content.alpha = 1 })
  }

  @objc private func changed() {
    let q = search.text ?? ""
    if q.trimmingCharacters(in: .whitespaces).isEmpty {
      sections = base
    } else {
      let r = CMLEmojiStore.search(q)
      sections = r.isEmpty ? [] : [("", r)]
    }
    empty.isHidden = !sections.isEmpty
    cv.reloadData()
    cv.setContentOffset(.zero, animated: false)
  }

  func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    textField.resignFirstResponder()
    return true
  }

  func numberOfSections(in collectionView: UICollectionView) -> Int { return sections.count }
  func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { return sections[section].1.count }

  func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
    let c = collectionView.dequeueReusableCell(withReuseIdentifier: CMLEmojiCell.reuseId, for: indexPath) as! CMLEmojiCell
    let e = sections[indexPath.section].1[indexPath.item]
    c.label.text = e
    c.contentView.backgroundColor = e == mine ? theme.mineBg : .clear
    c.contentView.layer.cornerRadius = 10
    c.accessibilityLabel = e
    c.isAccessibilityElement = true
    return c
  }

  func collectionView(_ collectionView: UICollectionView, viewForSupplementaryElementOfKind kind: String, at indexPath: IndexPath) -> UICollectionReusableView {
    let h = collectionView.dequeueReusableSupplementaryView(ofKind: kind, withReuseIdentifier: CMLEmojiHeader.reuseId, for: indexPath) as! CMLEmojiHeader
    h.label.text = sections[indexPath.section].0.uppercased()
    h.label.textColor = theme.sub
    return h
  }

  func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout, referenceSizeForHeaderInSection section: Int) -> CGSize {
    return sections[section].0.isEmpty ? CGSize(width: 10, height: 8) : CGSize(width: collectionView.bounds.width, height: 30)
  }

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    guard indexPath.section < sections.count, indexPath.item < sections[indexPath.section].1.count else { return }
    let e = sections[indexPath.section].1[indexPath.item]
    var r = CGRect(x: bounds.midX, y: bounds.midY, width: 1, height: 1)
    if let a = collectionView.layoutAttributesForItem(at: indexPath) { r = collectionView.convert(a.frame, to: nil) }
    search.resignFirstResponder()
    onPick?(e, r)
  }
}

// MARK: - overlay

final class CMLContextMenuOverlay: UIView {
  let key: String
  var onAction: ((CMLCtxMenuData, String) -> Void)?
  var onReact: ((CMLCtxMenuData, String) -> Void)?
  /// O balão já voltou ao lugar (ou foi cancelado): reexibir a célula.
  var onDismissed: ((String) -> Void)?
  /// Retângulo ATUAL do balão na janela (a lista pode ter rolado/mudado).
  var sourceRectProvider: (() -> CGRect?)?

  private(set) var data: CMLCtxMenuData?
  private(set) var dismissing = false
  private var sourceRect: CGRect
  private var own: Bool
  private var dark: Bool
  private let blur = UIVisualEffectView(effect: nil)
  private let dim = UIView()
  private let bubbleBox = UIView()
  private let bubble = UIImageView()
  private var reactBar: CMLReactBar?
  private var menu: CMLActionMenu?
  private var panel: CMLEmojiPanel?
  private var bubbleTarget: CGRect = .zero
  private var bubbleScale: CGFloat = 1
  private var timeout: DispatchWorkItem?
  private var pendingDone = 0
  private var finished = false
  private var kbObs: NSObjectProtocol?
  private let reduce = UIAccessibility.isReduceMotionEnabled
  private let selection = UISelectionFeedbackGenerator()
  private let impact = UIImpactFeedbackGenerator(style: .light)

  init(key: String, image: UIImage, rect: CGRect, own: Bool, dark: Bool) {
    self.key = key
    self.sourceRect = rect
    self.own = own
    self.dark = dark
    super.init(frame: .zero)
    backgroundColor = .clear
    overrideUserInterfaceStyle = dark ? .dark : .light
    accessibilityViewIsModal = true
    blur.isUserInteractionEnabled = true
    addSubview(blur)
    dim.isUserInteractionEnabled = false
    dim.alpha = 0
    addSubview(dim)
    bubble.image = image
    bubble.contentMode = .scaleToFill
    bubbleBox.bounds = CGRect(origin: .zero, size: rect.size)
    bubbleBox.center = CGPoint(x: rect.midX, y: rect.midY)
    bubble.frame = bubbleBox.bounds
    bubble.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    bubbleBox.addSubview(bubble)
    bubbleBox.layer.shadowColor = UIColor.black.cgColor
    bubbleBox.layer.shadowOpacity = 0
    bubbleBox.layer.shadowRadius = 12
    bubbleBox.layer.shadowOffset = CGSize(width: 0, height: 4)
    addSubview(bubbleBox)
    let tap = UITapGestureRecognizer(target: self, action: #selector(outsideTap))
    blur.addGestureRecognizer(tap)
    let tap2 = UITapGestureRecognizer(target: self, action: #selector(outsideTap))
    bubbleBox.addGestureRecognizer(tap2)
    selection.prepare()
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  deinit {
    if let o = kbObs { NotificationCenter.default.removeObserver(o) }
  }

  override func accessibilityPerformEscape() -> Bool {
    dismiss(reason: "escape")
    return true
  }

  // MARK: apresentar (no long-press, antes do JS responder)

  func present(in win: UIWindow) {
    frame = win.bounds
    autoresizingMask = [.flexibleWidth, .flexibleHeight]
    win.addSubview(self)
    blur.frame = bounds
    blur.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    dim.frame = bounds
    dim.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    dim.backgroundColor = dark ? UIColor(white: 0, alpha: 0.45) : UIColor(white: 0, alpha: 0.22)
    let style: UIBlurEffect.Style = dark ? .systemUltraThinMaterialDark : .systemUltraThinMaterialLight
    let anim = UIViewPropertyAnimator(duration: reduce ? 0.15 : 0.32, curve: .easeOut) {
      self.blur.effect = UIBlurEffect(style: style)
      self.dim.alpha = 1
    }
    anim.startAnimation()
    let shadowA = CABasicAnimation(keyPath: "shadowOpacity")
    shadowA.fromValue = 0
    shadowA.toValue = dark ? 0.35 : 0.18
    shadowA.duration = 0.25
    bubbleBox.layer.add(shadowA, forKey: "sh")
    bubbleBox.layer.shadowOpacity = dark ? 0.35 : 0.18
    if !reduce {
      // "sai" da lista: 1.0 → 1.04 → 1.0 (spring)
      UIView.animate(withDuration: 0.13, delay: 0, options: [.curveEaseOut, .allowUserInteraction], animations: {
        self.bubbleBox.transform = CGAffineTransform(scaleX: 1.04, y: 1.04)
      }, completion: { _ in
        guard !self.dismissing else { return }
        UIView.animate(withDuration: 0.5, delay: 0, usingSpringWithDamping: 0.62, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
          self.bubbleBox.transform = CGAffineTransform(scaleX: self.bubbleScale, y: self.bubbleScale)
        })
      })
    }
    // JS não respondeu (ocupado / decidiu não abrir) → devolve o balão
    let w = DispatchWorkItem { [weak self] in
      guard let self = self, self.data == nil else { return }
      self.dismiss(reason: "timeout")
    }
    timeout = w
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5, execute: w)
  }

  // MARK: conteúdo (lista de ações vinda do JS)

  func setMenu(_ d: CMLCtxMenuData) {
    guard !dismissing, data == nil else { return }
    data = d
    timeout?.cancel()
    timeout = nil
    own = d.own
    if d.showReactions && !d.reactions.isEmpty {
      let bar = CMLReactBar(emojis: d.reactions, mine: d.mine, theme: d.theme, moreLabel: d.labels["more"] ?? "+")
      bar.onPick = { [weak self] e, r in self?.pickReaction(e, fromWindowRect: r) }
      bar.onMore = { [weak self] in self?.expandEmoji() }
      addSubview(bar)
      reactBar = bar
    }
    if !d.actions.isEmpty {
      let m = CMLActionMenu(actions: d.actions, theme: d.theme)
      m.onAction = { [weak self] a in self?.tapAction(a) }
      addSubview(m)
      menu = m
    }
    bringSubviewToFront(bubbleBox)
    if let b = reactBar { bringSubviewToFront(b) }
    if let m = menu { bringSubviewToFront(m) }
    layoutMenu()
    animateMenuIn()
  }

  private var safeTop: CGFloat { return max(safeAreaInsets.top, 20) + 6 }
  private var safeBottom: CGFloat { return bounds.height - max(safeAreaInsets.bottom, 12) - 6 }

  private func layoutMenu() {
    let margin: CGFloat = 8
    let top = safeTop, bottom = safeBottom
    let reactH: CGFloat = reactBar == nil ? 0 : CMLReactBar.height
    let gapR: CGFloat = reactBar == nil ? 0 : 10
    let gapM: CGFloat = menu == nil ? 0 : 10
    let menuW = min(CMLActionMenu.width, bounds.width - margin * 2)
    let src = sourceRect
    // [2026-10-17 ctx-fit] O MENU tem prioridade (nunca cortado): ele pega
    // tudo o que precisa, deixando só um mínimo p/ o balão; a prévia (balão)
    // encolhe para caber no resto. Só se nem assim couber o menu rola.
    let minBubble: CGFloat = min(max(src.height, 1), 64)
    let menuRoom = (bottom - top) - reactH - gapR - gapM - minBubble
    let menuH = menu?.preferredHeight(max: menuRoom) ?? 0
    let availB = max(minBubble, (bottom - top) - reactH - gapR - menuH - gapM)
    var scale: CGFloat = 1
    if src.height > availB && src.height > 0 { scale = max(0.12, availB / src.height) }
    let bw = src.width * scale, bh = src.height * scale
    var by = src.minY
    if by - gapR - reactH < top { by = top + reactH + gapR }
    if by + bh + gapM + menuH > bottom { by = bottom - menuH - gapM - bh }
    if by - gapR - reactH < top { by = top + reactH + gapR }
    let bx = own ? (src.maxX - bw) : src.minX
    bubbleTarget = CGRect(x: bx, y: by, width: bw, height: bh)
    bubbleScale = scale
    if let bar = reactBar {
      let w = min(bar.preferredWidth, bounds.width - margin * 2)
      var x = own ? (bubbleTarget.maxX - w) : bubbleTarget.minX
      x = max(margin, min(bounds.width - margin - w, x))
      bar.transform = .identity
      bar.frame = CGRect(x: x, y: by - gapR - reactH, width: w, height: reactH)
    }
    if let m = menu {
      var x = own ? (bubbleTarget.maxX - menuW) : bubbleTarget.minX
      x = max(margin, min(bounds.width - margin - menuW, x))
      m.transform = .identity
      m.frame = CGRect(x: x, y: bubbleTarget.maxY + gapM, width: menuW, height: menuH)
      m.layoutIfNeeded()
    }
  }

  private func animateMenuIn() {
    let tgtCenter = CGPoint(x: bubbleTarget.midX, y: bubbleTarget.midY)
    if reduce {
      bubbleBox.center = tgtCenter
      bubbleBox.transform = CGAffineTransform(scaleX: bubbleScale, y: bubbleScale)
      reactBar?.alpha = 0
      menu?.alpha = 0
      UIView.animate(withDuration: 0.18) {
        self.reactBar?.alpha = 1
        self.menu?.alpha = 1
      }
      return
    }
    UIView.animate(withDuration: 0.48, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
      self.bubbleBox.center = tgtCenter
      self.bubbleBox.transform = CGAffineTransform(scaleX: self.bubbleScale, y: self.bubbleScale)
    })
    if let bar = reactBar {
      let dx: CGFloat = own ? bar.bounds.width * 0.3 : -bar.bounds.width * 0.3
      bar.alpha = 0
      bar.transform = CGAffineTransform(translationX: dx, y: 14).scaledBy(x: 0.45, y: 0.45)
      UIView.animate(withDuration: 0.5, delay: 0, usingSpringWithDamping: 0.72, initialSpringVelocity: 0.2, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
        bar.alpha = 1
        bar.transform = .identity
      })
      bar.animateIn(reduce: false)
    }
    if let m = menu {
      let dx: CGFloat = own ? m.bounds.width * 0.25 : -m.bounds.width * 0.25
      m.alpha = 0
      m.transform = CGAffineTransform(translationX: dx, y: -m.bounds.height * 0.25).scaledBy(x: 0.5, y: 0.5)
      UIView.animate(withDuration: 0.5, delay: 0.02, usingSpringWithDamping: 0.78, initialSpringVelocity: 0.2, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
        m.alpha = 1
        m.transform = .identity
      })
      m.animateRowsIn(reduce: false)
    }
  }

  // MARK: ações

  private func tapAction(_ a: CMLCtxAction) {
    guard !dismissing, let d = data else { return }
    selection.selectionChanged()
    onAction?(d, a.id)
    dismiss(reason: "action")
  }

  private func pickReaction(_ e: String, fromWindowRect r: CGRect) {
    guard !dismissing, let d = data else { return }
    impact.impactOccurred()
    let removing = e == d.mine
    onReact?(d, e)
    if removing || reduce {
      dismiss(reason: "react")
      return
    }
    let from = convert(r, from: nil)
    fly(e, from: from)
    dismiss(reason: "react")
  }

  @objc private func outsideTap() {
    if let p = panel, p.isFirstResponderInside {
      endEditing(true)
      return
    }
    dismiss(reason: "outside")
  }

  // MARK: "+" → grade de emojis

  private func expandEmoji() {
    guard !dismissing, panel == nil, let d = data, let bar = reactBar else { return }
    selection.selectionChanged()
    let p = CMLEmojiPanel(theme: d.theme, recents: d.recents, quick: d.reactions, mine: d.mine, labels: d.labels)
    p.onPick = { [weak self] e, r in self?.pickReaction(e, fromWindowRect: r) }
    let start = bar.frame
    p.frame = start
    addSubview(p)
    panel = p
    let margin: CGFloat = 8
    let w = min(bounds.width - margin * 2, 380)
    let h = min(340, (safeBottom - safeTop) * 0.62)
    var x = own ? (start.maxX - w) : start.minX
    x = max(margin, min(bounds.width - margin - w, x))
    var y = start.minY
    if y + h > safeBottom { y = safeBottom - h }
    if y < safeTop { y = safeTop }
    let target = CGRect(x: x, y: y, width: w, height: h)
    p.layoutIfNeeded()
    let go = {
      p.frame = target
      p.setCorner(20)
      p.layoutIfNeeded()
      bar.alpha = 0
      bar.transform = CGAffineTransform(scaleX: 0.9, y: 0.9)
      self.menu?.alpha = 0
      self.menu?.transform = CGAffineTransform(scaleX: 0.85, y: 0.85)
    }
    if reduce {
      go()
    } else {
      UIView.animate(withDuration: 0.5, delay: 0, usingSpringWithDamping: 0.84, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: go)
    }
    menu?.isUserInteractionEnabled = false
    bar.isUserInteractionEnabled = false
    p.showContent(reduce: reduce)
    kbObs = NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { [weak self] n in
      self?.keyboardChanged(n, base: target)
    }
  }

  private func keyboardChanged(_ n: Notification, base: CGRect) {
    guard let p = panel, !dismissing, let end = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
    let kb = convert(end, from: nil)
    let kbTop = kb.minY < bounds.height - 1 ? kb.minY : bounds.height
    var f = base
    if kbTop < bounds.height - 1 {
      let limit = kbTop - 8
      if f.maxY > limit {
        f.origin.y = max(safeTop, limit - f.height)
        if f.maxY > limit { f.size.height = max(160, limit - f.minY) }
      }
    }
    let dur = (n.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
    UIView.animate(withDuration: max(0.2, dur), delay: 0, options: [.beginFromCurrentState, .allowUserInteraction], animations: {
      p.frame = f
      p.layoutIfNeeded()
    })
  }

  // MARK: reação voando até a bolha

  private func fly(_ e: String, from: CGRect) {
    let dest = sourceRectProvider?() ?? sourceRect
    let lbl = UILabel()
    lbl.text = e
    lbl.font = UIFont.systemFont(ofSize: 30)
    lbl.sizeToFit()
    let start = CGPoint(x: from.midX, y: from.midY)
    let end = CGPoint(x: own ? dest.maxX - 20 : dest.minX + 20, y: dest.maxY + 7)
    lbl.center = start
    addSubview(lbl)
    pendingDone += 1
    let ctrl = CGPoint(x: (start.x + end.x) / 2 + (own ? -50 : 50), y: min(start.y, end.y) - 70)
    let path = UIBezierPath()
    path.move(to: start)
    path.addQuadCurve(to: end, controlPoint: ctrl)
    let dur: CFTimeInterval = 0.52
    let pos = CAKeyframeAnimation(keyPath: "position")
    pos.path = path.cgPath
    pos.duration = dur
    pos.timingFunction = CAMediaTimingFunction(controlPoints: 0.32, 0, 0.18, 1)
    let sc = CAKeyframeAnimation(keyPath: "transform.scale")
    sc.values = [1.0, 1.55, 0.5]
    sc.keyTimes = [0, 0.38, 1]
    sc.duration = dur
    CATransaction.begin()
    CATransaction.setCompletionBlock { [weak self] in
      UIView.animate(withDuration: 0.12, animations: { lbl.alpha = 0 }, completion: { _ in
        lbl.removeFromSuperview()
        self?.oneDone()
      })
    }
    lbl.layer.position = end
    lbl.layer.transform = CATransform3DMakeScale(0.5, 0.5, 1)
    lbl.layer.add(pos, forKey: "cml.fly.p")
    lbl.layer.add(sc, forKey: "cml.fly.s")
    CATransaction.commit()
  }

  // MARK: fechar (animação reversa)

  func dismiss(reason: String, animated: Bool = true) {
    if dismissing {
      if !animated { finish(reason) }
      return
    }
    dismissing = true
    timeout?.cancel()
    timeout = nil
    if let o = kbObs { NotificationCenter.default.removeObserver(o); kbObs = nil }
    endEditing(true)
    isUserInteractionEnabled = false
    if !animated || window == nil {
      finish(reason)
      return
    }
    let dest = sourceRectProvider?() ?? sourceRect
    let fade = {
      self.reactBar?.alpha = 0
      self.reactBar?.transform = CGAffineTransform(scaleX: 0.8, y: 0.8)
      self.menu?.alpha = 0
      self.menu?.transform = CGAffineTransform(scaleX: 0.85, y: 0.85)
      self.panel?.alpha = 0
      self.panel?.transform = CGAffineTransform(scaleX: 0.92, y: 0.92)
    }
    UIView.animate(withDuration: 0.18, delay: 0, options: [.curveEaseIn, .beginFromCurrentState], animations: fade)
    let anim = UIViewPropertyAnimator(duration: 0.3, curve: .easeInOut) {
      self.blur.effect = nil
      self.dim.alpha = 0
    }
    anim.startAnimation()
    bubbleBox.layer.shadowOpacity = 0
    pendingDone += 1
    let back = {
      self.bubbleBox.center = CGPoint(x: dest.midX, y: dest.midY)
      self.bubbleBox.transform = .identity
    }
    if reduce {
      UIView.animate(withDuration: 0.2, animations: back, completion: { _ in self.oneDone(reason) })
    } else {
      UIView.animate(withDuration: 0.4, delay: 0, usingSpringWithDamping: 0.86, initialSpringVelocity: 0, options: [.beginFromCurrentState], animations: back, completion: { _ in self.oneDone(reason) })
    }
  }

  private var lastReason = "outside"
  private func oneDone(_ reason: String? = nil) {
    if let r = reason { lastReason = r }
    pendingDone -= 1
    if pendingDone <= 0 && dismissing { finish(lastReason) }
  }

  private func finish(_ reason: String) {
    if finished { return }
    finished = true
    if let o = kbObs { NotificationCenter.default.removeObserver(o); kbObs = nil }
    onDismissed?(reason)
    // [2026-10-22 ctx-blink] célula já visível embaixo (onDismissed) → o balão
    // pousado sai com fade curto em vez de sumir seco (GIF: quadro do snapshot
    // ≠ quadro ao vivo). Sem toques (isUserInteractionEnabled = false).
    if window != nil && dismissing && !reduce && reason != "off" && reason != "replaced" {
      isUserInteractionEnabled = false
      UIView.animate(withDuration: 0.12, delay: 0, options: [.curveEaseOut, .beginFromCurrentState], animations: {
        self.alpha = 0
      }, completion: { _ in self.removeFromSuperview() })
    } else {
      removeFromSuperview()
    }
  }
}

private extension CMLEmojiPanel {
  var isFirstResponderInside: Bool { return findFirstResponder(self) != nil }
  func findFirstResponder(_ v: UIView) -> UIView? {
    if v.isFirstResponder { return v }
    for s in v.subviews { if let r = findFirstResponder(s) { return r } }
    return nil
  }
}
