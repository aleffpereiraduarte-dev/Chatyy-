import UIKit

// [2026-10-17 status-reacoes] Reações de status estilo Instagram/WhatsApp
// (apiVersion 4):
//   • SVReactBubble — segurar o coração abre a fileira numa bolha; o dedo
//     desliza sobre os emojis (haptic de seleção por item) e solta p/ escolher.
//   • SVEmojiSheet  — "+" abre a grade completa de emojis do app (catálogo do
//     JS: components/chat/nativeEmojiData.js) com busca por palavras.
//   • SVReactionBurst — o emoji escolhido sobe grande e estoura (molas; com
//     Reduzir Movimento vira só um fade no centro).
// Emojis aqui são CONTEÚDO (a reação). Ícones de UI ("+") seguem vetoriais.
// Molas espelham constants/motion.js: bouncy ζ≈0.46 (pop), snappy ζ≈0.88.

/// Catálogo de emojis do "+" (mandado pelo JS no open; guardado por processo).
enum SVEmojiStore {
  struct Cat { let title: String; let emojis: [String]; let keys: [String] }
  static var cats: [Cat] = []

  static func update(_ v: Any?) {
    guard let d = v as? [String: Any], let arr = d["cats"] as? [Any] else { return }
    var out: [Cat] = []
    for x in arr {
      guard let m = x as? [String: Any] else { continue }
      let e = ((m["e"] as? [Any]) ?? []).compactMap { $0 as? String }.filter { !$0.isEmpty }
      var k = ((m["k"] as? [Any]) ?? []).map { fold(($0 as? String) ?? "") }
      while k.count < e.count { k.append("") }
      if e.isEmpty { continue }
      out.append(Cat(title: (m["t"] as? String) ?? "", emojis: e, keys: k))
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

/// Ícone "+" vetorial (UI nunca usa emoji).
enum SVPlusIcon {
  static func image(size: CGFloat, color: UIColor = .white) -> UIImage {
    let fmt = UIGraphicsImageRendererFormat.default()
    fmt.opaque = false
    return UIGraphicsImageRenderer(size: CGSize(width: size, height: size), format: fmt).image { ctx in
      let cg = ctx.cgContext
      cg.setStrokeColor(color.cgColor)
      cg.setLineWidth(max(2, size / 12))
      cg.setLineCap(.round)
      let m = size * 0.26
      cg.move(to: CGPoint(x: size / 2, y: m)); cg.addLine(to: CGPoint(x: size / 2, y: size - m))
      cg.move(to: CGPoint(x: m, y: size / 2)); cg.addLine(to: CGPoint(x: size - m, y: size / 2))
      cg.strokePath()
    }
  }
}

// MARK: - Bolha (segurar o coração)

final class SVReactBubble: UIView {
  static let more = "__more__"
  let items: [String]
  private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
  private var cells: [UIView] = []
  private(set) var highlighted: Int?
  private let selection = UISelectionFeedbackGenerator()
  private let itemSize: CGFloat = 44
  private let pad: CGFloat = 8

  init(items: [String], mine: String) {
    self.items = items
    super.init(frame: .zero)
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = 0.35
    layer.shadowRadius = 16
    layer.shadowOffset = CGSize(width: 0, height: 6)
    blur.clipsToBounds = true
    blur.layer.cornerCurve = .continuous
    blur.backgroundColor = UIColor(white: 0.08, alpha: 0.55)
    addSubview(blur)
    for e in items {
      let c = UIView()
      c.isUserInteractionEnabled = false
      if e == SVReactBubble.more {
        let iv = UIImageView(image: SVPlusIcon.image(size: 26))
        iv.contentMode = .center
        iv.frame = CGRect(x: 0, y: 0, width: itemSize, height: itemSize)
        c.addSubview(iv)
        c.layer.cornerRadius = itemSize / 2
        c.backgroundColor = UIColor(white: 1, alpha: 0.16)
      } else {
        let iv = UIImageView(image: SVIcons.emoji(e, size: 40))
        iv.contentMode = .center
        iv.frame = CGRect(x: 0, y: 0, width: itemSize, height: itemSize)
        c.addSubview(iv)
        if e == mine {
          c.layer.cornerRadius = itemSize / 2
          c.backgroundColor = UIColor(white: 1, alpha: 0.18)
        }
      }
      c.isAccessibilityElement = true
      c.accessibilityLabel = e
      addSubview(c)
      cells.append(c)
    }
    selection.prepare()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  var preferredSize: CGSize {
    return CGSize(width: CGFloat(items.count) * itemSize + pad * 2, height: itemSize + pad * 2)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    blur.frame = bounds
    blur.layer.cornerRadius = bounds.height / 2
    layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: bounds.height / 2).cgPath
    for (i, c) in cells.enumerated() {
      let t = c.transform
      c.transform = .identity
      c.frame = CGRect(x: pad + CGFloat(i) * itemSize, y: pad, width: itemSize, height: itemSize)
      c.transform = t
    }
  }

  /// Índice sob o ponto (coordenadas da bolha). Tolerância vertical generosa:
  /// o dedo costuma ficar abaixo da bolha.
  func index(at p: CGPoint) -> Int? {
    guard p.y > -70, p.y < bounds.height + 80, p.x >= 0, p.x <= bounds.width else { return nil }
    let i = Int((p.x - pad) / itemSize)
    return max(0, min(items.count - 1, i))
  }

  func setHighlighted(_ i: Int?, reduce: Bool) {
    guard i != highlighted else { return }
    highlighted = i
    if i != nil { selection.selectionChanged(); selection.prepare() }
    let apply = {
      for (k, c) in self.cells.enumerated() {
        if let i = i {
          c.transform = k == i ? CGAffineTransform(translationX: 0, y: -14).scaledBy(x: 1.45, y: 1.45) : CGAffineTransform(scaleX: 0.9, y: 0.9)
        } else {
          c.transform = .identity
        }
      }
    }
    if reduce { apply(); return }
    // snappy (ζ≈0.88)
    UIView.animate(withDuration: 0.3, delay: 0, usingSpringWithDamping: 0.88, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: apply)
  }

  /// Centro global do item (p/ a animação de estouro sair dele).
  func centerOf(_ i: Int, in v: UIView) -> CGPoint {
    guard i >= 0, i < cells.count else { return convert(CGPoint(x: bounds.midX, y: bounds.midY), to: v) }
    let c = cells[i]
    return convert(CGPoint(x: c.center.x, y: c.center.y), to: v)
  }

  func present(reduce: Bool) {
    if reduce {
      alpha = 0
      UIView.animate(withDuration: 0.15) { self.alpha = 1 }
      return
    }
    alpha = 0
    transform = CGAffineTransform(translationX: 0, y: 16).scaledBy(x: 0.6, y: 0.6)
    for (k, c) in cells.enumerated() {
      c.transform = CGAffineTransform(translationX: 0, y: 12).scaledBy(x: 0.4, y: 0.4)
      c.alpha = 0
      UIView.animate(withDuration: 0.42, delay: 0.02 * Double(k), usingSpringWithDamping: 0.62, initialSpringVelocity: 0, options: [.allowUserInteraction], animations: {
        c.transform = .identity
        c.alpha = 1
      })
    }
    UIView.animate(withDuration: 0.4, delay: 0, usingSpringWithDamping: 0.72, initialSpringVelocity: 0, options: [.allowUserInteraction], animations: {
      self.alpha = 1
      self.transform = .identity
    })
  }

  func dismiss(reduce: Bool, completion: (() -> Void)? = nil) {
    UIView.animate(withDuration: reduce ? 0.12 : 0.18, delay: 0, options: [.curveEaseIn, .beginFromCurrentState], animations: {
      self.alpha = 0
      if !reduce { self.transform = CGAffineTransform(translationX: 0, y: 10).scaledBy(x: 0.85, y: 0.85) }
    }, completion: { _ in
      self.removeFromSuperview()
      completion?()
    })
  }
}

// MARK: - Grade completa ("+")

final class SVEmojiCell: UICollectionViewCell {
  static let reuseId = "svEmoji"
  let label = UILabel()
  override init(frame: CGRect) {
    super.init(frame: frame)
    label.font = UIFont.systemFont(ofSize: 30)
    label.textAlignment = .center
    contentView.addSubview(label)
    contentView.layer.cornerRadius = 10
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

final class SVEmojiHeader: UICollectionReusableView {
  static let reuseId = "svEmojiHeader"
  let label = UILabel()
  override init(frame: CGRect) {
    super.init(frame: frame)
    label.font = UIFont.systemFont(ofSize: 13, weight: .semibold)
    label.textColor = UIColor(white: 1, alpha: 0.55)
    addSubview(label)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func layoutSubviews() {
    super.layoutSubviews()
    label.frame = bounds.insetBy(dx: 6, dy: 0)
  }
}

final class SVEmojiSheet: UIView, UICollectionViewDataSource, UICollectionViewDelegateFlowLayout, UITextFieldDelegate {
  var onPick: ((String, CGPoint) -> Void)?
  var onClose: (() -> Void)?
  private let dim = UIView()
  private let panel = UIView()
  private let handle = UIView()
  private let titleLabel = UILabel()
  private let search = UISearchTextField()
  private let flow: UICollectionViewFlowLayout
  private let cv: UICollectionView
  private let empty = UILabel()
  private var sections: [(String, [String])] = []
  private var base: [(String, [String])] = []
  private let mine: String
  private var keyboardTop: CGFloat = 0
  private var observers: [NSObjectProtocol] = []
  private var closing = false

  init(quick: [String], mine: String, labels: SVLabels) {
    self.mine = mine
    let fl = UICollectionViewFlowLayout()
    flow = fl
    cv = UICollectionView(frame: .zero, collectionViewLayout: fl)
    super.init(frame: .zero)
    dim.backgroundColor = UIColor(white: 0, alpha: 0.45)
    dim.alpha = 0
    dim.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapDim)))
    addSubview(dim)
    panel.backgroundColor = UIColor(red: 0.11, green: 0.11, blue: 0.12, alpha: 1)
    panel.layer.cornerRadius = 20
    panel.layer.cornerCurve = .continuous
    panel.layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
    panel.clipsToBounds = true
    addSubview(panel)
    handle.backgroundColor = UIColor(white: 1, alpha: 0.25)
    handle.layer.cornerRadius = 2.5
    panel.addSubview(handle)
    titleLabel.text = labels.get("moreReactions", "Mais reações")
    titleLabel.textColor = .white
    titleLabel.font = .systemFont(ofSize: 17, weight: .bold)
    panel.addSubview(titleLabel)
    search.placeholder = labels.get("emojiSearch", "Buscar emoji")
    search.font = .systemFont(ofSize: 16)
    search.textColor = .white
    search.tintColor = .white
    search.backgroundColor = UIColor(white: 1, alpha: 0.1)
    search.keyboardAppearance = .dark
    search.returnKeyType = .search
    search.autocorrectionType = .no
    search.delegate = self
    search.addTarget(self, action: #selector(changed), for: .editingChanged)
    panel.addSubview(search)
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
    cv.register(SVEmojiCell.self, forCellWithReuseIdentifier: SVEmojiCell.reuseId)
    cv.register(SVEmojiHeader.self, forSupplementaryViewOfKind: UICollectionView.elementKindSectionHeader, withReuseIdentifier: SVEmojiHeader.reuseId)
    panel.addSubview(cv)
    empty.text = labels.get("emojiNoResults", "Nenhum emoji encontrado")
    empty.font = .systemFont(ofSize: 15)
    empty.textColor = UIColor(white: 1, alpha: 0.55)
    empty.textAlignment = .center
    empty.isHidden = true
    panel.addSubview(empty)
    let q = quick.filter { !$0.isEmpty && $0 != SVReactBubble.more }
    if !q.isEmpty { base.append(("", q)) }
    for c in SVEmojiStore.cats { base.append((c.title, c.emojis)) }
    sections = base
    let nc = NotificationCenter.default
    observers.append(nc.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { [weak self] n in
      self?.keyboard(n, hiding: false)
    })
    observers.append(nc.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] n in
      self?.keyboard(n, hiding: true)
    })
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  deinit { for o in observers { NotificationCenter.default.removeObserver(o) } }

  private var panelHeight: CGFloat {
    let h = bounds.height
    return keyboardTop > 0 ? min(h * 0.86, h - 60) : min(h * 0.62, 520 + safeAreaInsets.bottom)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    dim.frame = bounds
    let ph = panelHeight
    if !closing {
      // bounds+center (o transform da entrada/saída fica intacto)
      panel.bounds = CGRect(x: 0, y: 0, width: bounds.width, height: ph)
      panel.center = CGPoint(x: bounds.midX, y: bounds.height - ph / 2)
    }
    handle.frame = CGRect(x: (bounds.width - 40) / 2, y: 8, width: 40, height: 5)
    titleLabel.frame = CGRect(x: 18, y: 20, width: bounds.width - 36, height: 24)
    search.frame = CGRect(x: 12, y: 52, width: max(0, bounds.width - 24), height: 36)
    let bottom = keyboardTop > 0 ? max(0, ph - (bounds.height - keyboardTop)) : ph - safeAreaInsets.bottom
    cv.frame = CGRect(x: 0, y: 96, width: bounds.width, height: max(0, bottom - 96))
    empty.frame = CGRect(x: 16, y: 116, width: max(0, bounds.width - 32), height: 40)
    let w = cv.bounds.width - 16
    if w > 0 {
      let cols = max(1, floor((w + 2) / 46))
      let item = floor((w - (cols - 1) * 2) / cols)
      if abs(flow.itemSize.width - item) > 0.5 { flow.itemSize = CGSize(width: item, height: 44); flow.invalidateLayout() }
    }
  }

  private func keyboard(_ n: Notification, hiding: Bool) {
    guard let info = n.userInfo, let end = (info[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
    let local = convert(end, from: nil)
    keyboardTop = (hiding || local.minY >= bounds.height) ? 0 : local.minY
    let dur = (info[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
    UIView.animate(withDuration: dur, delay: 0, options: [.beginFromCurrentState], animations: {
      self.setNeedsLayout()
      self.layoutIfNeeded()
    })
  }

  func present(reduce: Bool) {
    layoutIfNeeded()
    let ph = panelHeight
    if reduce {
      panel.alpha = 0
      UIView.animate(withDuration: 0.18) { self.dim.alpha = 1; self.panel.alpha = 1 }
      return
    }
    panel.transform = CGAffineTransform(translationX: 0, y: ph)
    // sheet (ζ≈0.89)
    UIView.animate(withDuration: 0.42, delay: 0, usingSpringWithDamping: 0.9, initialSpringVelocity: 0, options: [.allowUserInteraction], animations: {
      self.dim.alpha = 1
      self.panel.transform = .identity
    })
  }

  func dismiss(reduce: Bool) {
    guard !closing else { return }
    closing = true
    search.resignFirstResponder()
    UIView.animate(withDuration: reduce ? 0.14 : 0.22, delay: 0, options: [.curveEaseIn, .beginFromCurrentState], animations: {
      self.dim.alpha = 0
      if reduce { self.panel.alpha = 0 } else { self.panel.transform = CGAffineTransform(translationX: 0, y: self.panel.bounds.height + 20) }
    }, completion: { _ in self.removeFromSuperview() })
  }

  @objc private func tapDim() {
    if search.isFirstResponder { search.resignFirstResponder(); return }
    onClose?()
  }

  @objc private func changed() {
    let q = search.text ?? ""
    if q.trimmingCharacters(in: .whitespaces).isEmpty {
      sections = base
    } else {
      let r = SVEmojiStore.search(q)
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
    let c = collectionView.dequeueReusableCell(withReuseIdentifier: SVEmojiCell.reuseId, for: indexPath) as! SVEmojiCell
    let e = sections[indexPath.section].1[indexPath.item]
    c.label.text = e
    c.contentView.backgroundColor = e == mine ? UIColor(white: 1, alpha: 0.16) : .clear
    c.accessibilityLabel = e
    c.isAccessibilityElement = true
    return c
  }

  func collectionView(_ collectionView: UICollectionView, viewForSupplementaryElementOfKind kind: String, at indexPath: IndexPath) -> UICollectionReusableView {
    let h = collectionView.dequeueReusableSupplementaryView(ofKind: kind, withReuseIdentifier: SVEmojiHeader.reuseId, for: indexPath) as! SVEmojiHeader
    h.label.text = sections[indexPath.section].0.uppercased()
    return h
  }

  func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout, referenceSizeForHeaderInSection section: Int) -> CGSize {
    return sections[section].0.isEmpty ? CGSize(width: 10, height: 8) : CGSize(width: collectionView.bounds.width, height: 30)
  }

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    guard indexPath.section < sections.count, indexPath.item < sections[indexPath.section].1.count else { return }
    let e = sections[indexPath.section].1[indexPath.item]
    var p = CGPoint(x: bounds.midX, y: bounds.midY)
    if let a = collectionView.layoutAttributesForItem(at: indexPath) {
      let r = collectionView.convert(a.frame, to: self)
      p = CGPoint(x: r.midX, y: r.midY)
    }
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    onPick?(e, p)
  }
}

// MARK: - Estouro do emoji

enum SVReactionBurst {
  /// O emoji nasce em `from`, cresce com mola até o centro-alto da tela e
  /// estoura (escala + fade) soltando mini cópias. reduce = só fade no centro.
  static func play(in host: UIView, image: UIImage?, from: CGPoint?, reduce: Bool) {
    guard let img = image else { return }
    let b = host.bounds
    let side = min(180, max(120, b.width * 0.42))
    let iv = UIImageView(image: img)
    iv.contentMode = .scaleAspectFit
    iv.isUserInteractionEnabled = false
    iv.frame = CGRect(x: 0, y: 0, width: side, height: side)
    let target = CGPoint(x: b.midX, y: b.height * 0.42)
    host.addSubview(iv)
    if reduce {
      iv.center = target
      iv.alpha = 0
      UIView.animate(withDuration: 0.18, animations: { iv.alpha = 1 }, completion: { _ in
        UIView.animate(withDuration: 0.3, delay: 0.55, options: [], animations: { iv.alpha = 0 }, completion: { _ in iv.removeFromSuperview() })
      })
      return
    }
    let start = from ?? CGPoint(x: b.midX, y: b.height * 0.8)
    iv.center = start
    iv.transform = CGAffineTransform(scaleX: 0.22, y: 0.22)
    // bouncy (ζ≈0.46): sobe e passa um pouco do tamanho
    UIView.animate(withDuration: 0.55, delay: 0, usingSpringWithDamping: 0.5, initialSpringVelocity: 0.6, options: [], animations: {
      iv.center = target
      iv.transform = .identity
    }, completion: { _ in
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
      SVReactionBurst.sparks(in: host, image: img, at: target, side: side)
      UIView.animate(withDuration: 0.26, delay: 0.32, options: [.curveEaseIn], animations: {
        iv.transform = CGAffineTransform(scaleX: 1.45, y: 1.45)
        iv.alpha = 0
      }, completion: { _ in iv.removeFromSuperview() })
    })
  }

  fileprivate static func sparks(in host: UIView, image: UIImage, at c: CGPoint, side: CGFloat) {
    let n = 7
    for i in 0..<n {
      let s = CGFloat.random(in: 26...42)
      let v = UIImageView(image: image)
      v.contentMode = .scaleAspectFit
      v.isUserInteractionEnabled = false
      v.frame = CGRect(x: 0, y: 0, width: s, height: s)
      v.center = c
      v.alpha = 0
      host.addSubview(v)
      let ang = (CGFloat(i) / CGFloat(n)) * .pi * 2 + CGFloat.random(in: -0.3...0.3)
      let dist = side * CGFloat.random(in: 0.75...1.1)
      let d = CGPoint(x: cos(ang) * dist, y: sin(ang) * dist - 30)
      UIView.animate(withDuration: 0.12, delay: 0.3, options: [], animations: { v.alpha = 1 })
      UIView.animate(withDuration: 0.7, delay: 0.3, options: [.curveEaseOut], animations: {
        v.center = CGPoint(x: c.x + d.x, y: c.y + d.y)
        v.transform = CGAffineTransform(rotationAngle: CGFloat.random(in: -0.6...0.6)).scaledBy(x: 0.7, y: 0.7)
      })
      UIView.animate(withDuration: 0.3, delay: 0.72, options: [.curveEaseIn], animations: { v.alpha = 0 }, completion: { _ in v.removeFromSuperview() })
    }
  }
}
