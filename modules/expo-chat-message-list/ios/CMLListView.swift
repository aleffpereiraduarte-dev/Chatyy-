import ExpoModulesCore
import UIKit
#if canImport(ExpoChatStore)
import ExpoChatStore
#endif

// [2026-10-14 native-list] ChatyyMessageList — UICollectionView INVERTIDA
// (scaleY -1: offset 0 = mensagem mais nova, embaixo). Ganho vs FlashList JS:
//   • nada de React por linha: layout CoreText calculado numa fila de fundo,
//     altura cacheada por chave (largura/estilo mudam → recalcula em lote);
//   • diff incremental vindo do JS (ordem só quando muda + linhas alteradas);
//   • rolagem/arrastar-p/-responder/toques 100% na main thread nativa — um JS
//     ocupado (sync, decrypt, rede) não engasga a lista;
//   • âncora: lendo acima, msg nova embaixo NÃO desloca o que está na tela;
//     no fim, entra animada (sobe do composer).

final class CMLFlowLayout: UICollectionViewFlowLayout {
  var animateInsert = false
  private var inserted = Set<IndexPath>()

  override init() {
    super.init()
    scrollDirection = .vertical
    minimumLineSpacing = 0
    minimumInteritemSpacing = 0
    sectionInset = .zero
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func prepare(forCollectionViewUpdates updateItems: [UICollectionViewUpdateItem]) {
    super.prepare(forCollectionViewUpdates: updateItems)
    inserted.removeAll()
    guard animateInsert else { return }
    for u in updateItems where u.updateAction == .insert {
      if let ip = u.indexPathAfterUpdate, ip.item < 4 { inserted.insert(ip) }
    }
  }

  override func finalizeCollectionViewUpdates() {
    super.finalizeCollectionViewUpdates()
    inserted.removeAll()
  }

  override func initialLayoutAttributesForAppearingItem(at itemIndexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
    guard let base = super.initialLayoutAttributesForAppearingItem(at: itemIndexPath) else { return nil }
    guard inserted.contains(itemIndexPath), let a = base.copy() as? UICollectionViewLayoutAttributes else { return base }
    // Lista invertida: y menor = mais embaixo na tela → nasce "de dentro" do composer.
    a.alpha = 0
    a.transform = CGAffineTransform(translationX: 0, y: -min(a.size.height, 56))
    return a
  }
}

/// Delegate do arrastar-p/-responder separado da view (não sobrescreve o
/// gestureRecognizerShouldBegin do UIView, que o UIKit também consulta).
final class CMLSwipeDelegate: NSObject, UIGestureRecognizerDelegate {
  weak var owner: CMLListView?
  func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
    return owner?.swipeShouldBegin() ?? false
  }
  func gestureRecognizer(_ g: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
    return owner?.swipeRequiredToFail(by: other) ?? false
  }
}

public final class CMLListView: ExpoView, UICollectionViewDelegateFlowLayout, UICollectionViewDataSourcePrefetching {
  let onReady = EventDispatcher()
  let onNativeError = EventDispatcher()
  let onRowPress = EventDispatcher()
  let onRowLongPress = EventDispatcher()
  let onSwipeReply = EventDispatcher()
  let onLoadOlder = EventDispatcher()
  let onScrollState = EventDispatcher()
  let onDragState = EventDispatcher()
  let onVisible = EventDispatcher()
  // [native-ctxmenu] menu de contexto nativo (apiVersion 3)
  let onMenuAction = EventDispatcher()
  let onReact = EventDispatcher()
  let onMenuDismiss = EventDispatcher()
  // [native-store] foto da conversa lida do store nativo (apiVersion 4)
  let onStore = EventDispatcher()

  private let flow = CMLFlowLayout()
  private var cv: UICollectionView!
  private var ds: UICollectionViewDiffableDataSource<Int, String>!

  // dados
  private var rows: [String: CMLRow] = [:]
  private var layouts: [String: CMLRowLayout] = [:]
  private var target: [String] = []      // ordem desejada (mais nova primeiro)
  private var applied: [String] = []     // ordem já no data source
  private var appliedHeights: [String: CGFloat] = [:]
  private var changedSinceApply = Set<String>()
  private var pendingAnim = false

  // estilo
  private var theme = CMLTheme()
  private var fontSize: CGFloat = 16
  private var lineHeight: CGFloat = 21
  private var radius: CGFloat = 18
  private var styleVersion = 0
  private var style: CMLStyle?
  private var styleDirty = true
  private var bottomInset: CGFloat = 8
  private var topInset: CGFloat = 0

  private let layoutQueue = DispatchQueue(label: "br.com.chatyy.messagelist.layout", qos: .userInitiated)
  private var generation = 0
  private var readySent = false
  private var audioState: CMLAudioState?
  private var pendingFlash: String?

  // [2026-10-15 native-store] Foto da conversa no store nativo (modules/
  // expo-chat-store). Prop `store` {a: conta, c: conversa, r: rev do formato
  // das linhas, n: chave mais nova que o JS tem}: na montagem a lista lê a
  // última janela que mostrou desta conversa e PINTA sem esperar o JS (o JS só
  // mandou o id). O 1º applyRows do JS substitui tudo — linha idêntica à da foto
  // mantém o layout (sem recálculo/piscada). Depois de cada applyRows do JS a
  // janela mais nova é regravada (debounce) direto no store, sem ponte.
  struct StoreCfg { let a: String; let c: String; let r: String; let n: String }
  private var storeCfg: StoreCfg?
  private var storeLoadStarted = false
  private var jsApplied = false
  private var storeDicts: [String: NSDictionary] = [:]  // linhas pintadas da foto (até o 1º applyRows do JS)
  private var rawDicts: [String: [String: Any]] = [:]   // dicionário JS por chave (p/ regravar a foto)
  private var jsVersion = 0
  private var persistedVersion = 0
  private var persistWork: DispatchWorkItem?
  static let storeWindow = 60
  /// Enquanto só a foto está na tela (JS ainda não mandou linhas), toques não
  /// vão p/ o JS (que ainda não conhece os itens).
  private var storeInteractive: Bool { return jsApplied || storeDicts.isEmpty }

  // rolagem
  private var lastScrollEmit: CFTimeInterval = 0
  private var lastDistClass = -1
  private var lastOlderAt: CFTimeInterval = 0
  private var olderArmed = true
  private var visibleScheduled = false
  private var lastVisibleSig = ""
  private var dragging = false

  // gestos
  private var tap: UITapGestureRecognizer!
  private var longPress: UILongPressGestureRecognizer!
  private var swipe: UIPanGestureRecognizer!
  private weak var swipeCell: CMLCell?
  private var swipeDir: CGFloat = 1
  private var swipeArmed = false
  private let swipeThreshold: CGFloat = 64
  private let haptic = UIImpactFeedbackGenerator(style: .light)
  private let hapticMedium = UIImpactFeedbackGenerator(style: .medium)
  private let swipeDelegate = CMLSwipeDelegate()

  // [fase 2]
  private var revealedKeys = Set<String>()
  private var liftedKey: String?
  private var liftGuard: DispatchWorkItem?
  private var lastLiftFile: URL?
  // [native-ctxmenu]
  private var ctxMenuOn = false
  private var darkHint: Bool?
  private var ctxOverlay: CMLContextMenuOverlay?
  private var popKey: String?
  private var popSig = ""
  private var popUntil: CFTimeInterval = 0
  private var dateCount = 0
  private let sticky = CMLStickyView()
  private var stickyOn = false
  private var stickyTop: CGFloat = 8
  private var stickyHide: DispatchWorkItem?
  private var stickyLabel = ""

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .clear
    cv = UICollectionView(frame: bounds, collectionViewLayout: flow)
    cv.transform = CGAffineTransform(scaleX: 1, y: -1)
    cv.backgroundColor = .clear
    cv.contentInsetAdjustmentBehavior = .never
    cv.alwaysBounceVertical = true
    cv.showsHorizontalScrollIndicator = false
    cv.scrollsToTop = false
    cv.allowsSelection = false
    cv.delaysContentTouches = false
    cv.keyboardDismissMode = .interactive
    cv.register(CMLCell.self, forCellWithReuseIdentifier: CMLCell.reuseId)
    cv.delegate = self
    cv.prefetchDataSource = self
    cv.isPrefetchingEnabled = true
    addSubview(cv)

    ds = UICollectionViewDiffableDataSource<Int, String>(collectionView: cv) { [weak self] collectionView, indexPath, key in
      let cell = collectionView.dequeueReusableCell(withReuseIdentifier: CMLCell.reuseId, for: indexPath) as! CMLCell
      guard let self = self, let row = self.rows[key], let L = self.layouts[key], let s = self.style else {
        cell.isHidden = true
        return cell
      }
      cell.isHidden = false
      let extra = CMLCellExtra(revealed: self.revealedKeys.contains(key), lifted: self.liftedKey == key)
      cell.configure(key: key, row: row, layout: L, style: s, audioState: self.audioState, extra: extra)
      cell.onVideoNote = { [weak self] k, st in
        guard let self = self else { return }
        self.onRowPress(["key": k, "part": "vnote", "url": st])
      }
      cell.isAccessibilityElement = true
      cell.accessibilityLabel = row.accessibilityText
      if self.pendingFlash == key {
        self.pendingFlash = nil
        DispatchQueue.main.async { cell.flash() }
      }
      return cell
    }

    tap = UITapGestureRecognizer(target: self, action: #selector(onTap(_:)))
    tap.cancelsTouchesInView = false
    longPress = UILongPressGestureRecognizer(target: self, action: #selector(onLong(_:)))
    longPress.minimumPressDuration = 0.35
    longPress.cancelsTouchesInView = false
    tap.require(toFail: longPress)
    swipe = UIPanGestureRecognizer(target: self, action: #selector(onSwipe(_:)))
    swipeDelegate.owner = self
    swipe.delegate = swipeDelegate
    swipe.maximumNumberOfTouches = 1
    cv.addGestureRecognizer(tap)
    cv.addGestureRecognizer(longPress)
    cv.addGestureRecognizer(swipe)
    cv.panGestureRecognizer.require(toFail: swipe)
    applyInsets()
    sticky.isHidden = true
    sticky.alpha = 0
    addSubview(sticky)
    CMLListView.cleanupLiftFiles()
  }

  private static var cleanedLiftFiles = false
  private static func cleanupLiftFiles() {
    if cleanedLiftFiles { return }
    cleanedLiftFiles = true
    DispatchQueue.global(qos: .utility).async {
      let dir = URL(fileURLWithPath: NSTemporaryDirectory())
      guard let items = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return }
      for u in items where u.lastPathComponent.hasPrefix("cml-lift-") { try? FileManager.default.removeItem(at: u) }
    }
  }

  // MARK: [fase 2] pílula de data fixa / lift / spoiler

  func setStickyDate(_ d: [String: Any]?) {
    let dd = d ?? [:]
    stickyOn = CMLRow.bool(dd["on"])
    stickyTop = CGFloat(CMLRow.num(dd["top"]) ?? 8)
    sticky.bg = CMLRow.color(dd["bg"]).map { CMLTheme.uiColor($0) } ?? UIColor(white: 1, alpha: 0.95)
    sticky.fg = CMLRow.color(dd["fg"]).map { CMLTheme.uiColor($0) } ?? UIColor(white: 0, alpha: 0.7)
    sticky.shadowOn = dd["shadow"] == nil ? true : CMLRow.bool(dd["shadow"])
    if !stickyOn { hideSticky(animated: false) }
    stickyLabel = ""
    setNeedsLayout()
  }

  private func visibleCell(_ key: String) -> CMLCell? {
    guard let ip = ds.indexPath(for: key) else { return nil }
    return cv.cellForItem(at: ip) as? CMLCell
  }

  func setLiftedKey(_ key: String) {
    let prev = liftedKey
    liftedKey = key.isEmpty ? nil : key
    if let p = prev, p != key, let c = visibleCell(p) { c.setLifted(false, animated: true) }
    if let k = liftedKey, let c = visibleCell(k) { c.setLifted(true, animated: false) }
    // trava de segurança: menu que fechou sem avisar não deixa a bolha sumida
    liftGuard?.cancel()
    liftGuard = nil
    if let k = liftedKey {
      let w = DispatchWorkItem { [weak self] in
        guard let self = self, self.liftedKey == k else { return }
        if let ov = self.ctxOverlay, ov.key == k, !ov.dismissing { return } // menu nativo ainda aberto
        self.setLiftedKey("")
      }
      liftGuard = w
      DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: w)
    }
  }

  private func stickyText() -> String {
    guard dateCount > 1 else { return "" }
    var top = -1
    for ip in cv.indexPathsForVisibleItems where ip.item > top { top = ip.item }
    guard top >= 0, top < applied.count else { return "" }
    var i = top
    var n = 0
    while i < applied.count && n < 5000 {
      if let r = rows[applied[i]], r.kind == .date { return r.text }
      i += 1
      n += 1
    }
    return ""
  }

  private func updateSticky() {
    guard stickyOn, let s = style else { return }
    let t = stickyText()
    if t.isEmpty { hideSticky(animated: true); return }
    if t != stickyLabel {
      stickyLabel = t
      sticky.setText(t, scale: s.scale)
    }
    let sz = sticky.intrinsic
    sticky.frame = CGRect(x: floor((bounds.width - sz.width) / 2), y: stickyTop, width: sz.width, height: sz.height)
    stickyHide?.cancel()
    stickyHide = nil
    if sticky.isHidden || sticky.alpha < 1 {
      sticky.isHidden = false
      UIView.animate(withDuration: 0.18, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: { self.sticky.alpha = 1 })
    }
  }

  private func scheduleStickyHide() {
    guard stickyOn, !sticky.isHidden else { return }
    stickyHide?.cancel()
    let w = DispatchWorkItem { [weak self] in self?.hideSticky(animated: true) }
    stickyHide = w
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: w)
  }

  private func hideSticky(animated: Bool) {
    stickyHide?.cancel()
    stickyHide = nil
    if sticky.isHidden { return }
    if !animated { sticky.alpha = 0; sticky.isHidden = true; return }
    UIView.animate(withDuration: 0.4, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: { self.sticky.alpha = 0 }, completion: { done in
      if done && self.sticky.alpha < 0.01 { self.sticky.isHidden = true }
    })
  }

  // MARK: props

  func setTheme(_ d: [String: Any]) {
    theme = CMLTheme(dict: d)
    markStyleDirty()
  }

  func setFontSize(_ v: Double?) { let n = CGFloat(v ?? 16); if n != fontSize { fontSize = n; markStyleDirty() } }
  func setLineHeight(_ v: Double?) { let n = CGFloat(v ?? 21); if n != lineHeight { lineHeight = n; markStyleDirty() } }
  func setRadius(_ v: Double?) { let n = CGFloat(v ?? 18); if n != radius { radius = n; markStyleDirty() } }

  func setKeyboardDismissMode(_ v: String?) {
    switch v ?? "interactive" {
    case "on-drag": cv.keyboardDismissMode = .onDrag
    case "none": cv.keyboardDismissMode = .none
    default: cv.keyboardDismissMode = .interactive
    }
  }

  func setInsets(bottom: Double?, top: Double?) {
    if let b = bottom { bottomInset = CGFloat(b) }
    if let t = top { topInset = CGFloat(t) }
    applyInsets()
  }

  private func applyInsets() {
    // invertida: "top" do scroll = embaixo na tela
    let ins = UIEdgeInsets(top: bottomInset, left: 0, bottom: topInset + 6, right: 0)
    if cv.contentInset != ins {
      let wasAtBottom = distanceFromLatest < 2
      cv.contentInset = ins
      cv.verticalScrollIndicatorInsets = ins
      if wasAtBottom { cv.contentOffset = CGPoint(x: 0, y: -ins.top) }
    }
  }

  private func markStyleDirty() {
    styleDirty = true
    setNeedsLayout()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    if !sticky.isHidden {
      let sz = sticky.intrinsic
      sticky.frame = CGRect(x: floor((bounds.width - sz.width) / 2), y: stickyTop, width: sz.width, height: sz.height)
    }
    if cv.frame != bounds {
      let wasAtBottom = distanceFromLatest < 2
      cv.frame = bounds
      if wasAtBottom { cv.contentOffset = CGPoint(x: 0, y: -cv.adjustedContentInset.top) }
    }
    let w = bounds.width
    guard w > 10 else { return }
    if styleDirty || style == nil || abs((style?.width ?? 0) - w) > 0.5 {
      styleDirty = false
      styleVersion += 1
      style = CMLStyle(width: w, fontSize: fontSize, lineHeight: lineHeight, radius: radius, theme: theme, version: styleVersion)
      layouts.removeAll(keepingCapacity: true)
      // tudo precisa de layout novo e de reconfigure
      for k in target { changedSinceApply.insert(k) }
      scheduleLayout(animated: false)
    }
  }

  // MARK: dados (JS → nativo)

  func applyRows(_ payload: [String: Any]) {
    let firstJS = !jsApplied
    jsApplied = true
    applyRowsCore(payload, fromStore: false)
    if firstJS {
      storeDicts.removeAll()
      #if canImport(ExpoChatStore)
      unwatchStore()
      #endif
    }
    jsVersion += 1
    schedulePersist()
  }

  private func applyRowsCore(_ payload: [String: Any], fromStore: Bool) {
    if let arr = payload["rows"] as? [[String: Any]] {
      for d in arr {
        if let k = d["k"] as? String {
          if fromStore {
            storeDicts[k] = d as NSDictionary
          } else {
            if storeCfg != nil { rawDicts[k] = d }
            // mesma linha que a foto já pintou → mantém linha + layout
            if let sd = storeDicts[k], rows[k] != nil, sd == (d as NSDictionary) { continue }
          }
        }
        guard let r = CMLRow(dict: d) else { continue }
        rows[r.key] = r
        layouts[r.key] = nil
        changedSinceApply.insert(r.key)
      }
    }
    if let keys = payload["keys"] as? [String] {
      var seen = Set<String>()
      var disp: [String] = []
      disp.reserveCapacity(keys.count)
      for k in keys.reversed() where !seen.contains(k) && rows[k] != nil {
        seen.insert(k)
        disp.append(k)
      }
      target = disp
      if rows.count > disp.count + 300 {
        revealedKeys = revealedKeys.filter { seen.contains($0) }
        rows = rows.filter { seen.contains($0.key) }
        layouts = layouts.filter { seen.contains($0.key) }
        appliedHeights = appliedHeights.filter { seen.contains($0.key) }
        rawDicts = rawDicts.filter { seen.contains($0.key) }
      }
      olderArmed = true
    }
    if CMLRow.bool(payload["anim"]) { pendingAnim = true }
    scheduleLayout(animated: pendingAnim)
  }

  private func scheduleLayout(animated: Bool) {
    guard let s = style else { return } // sem largura ainda: layoutSubviews agenda
    generation += 1
    let gen = generation
    var todo: [(String, CMLRow)] = []
    for k in target where layouts[k] == nil {
      if let r = rows[k] { todo.append((k, r)) }
    }
    if todo.isEmpty {
      applySnapshot()
      return
    }
    layoutQueue.async { [weak self] in
      var out: [(String, CMLRow, CMLRowLayout)] = []
      out.reserveCapacity(todo.count)
      for (k, r) in todo {
        out.append((k, r, CMLLayoutBuilder.build(r, s)))
      }
      DispatchQueue.main.async {
        guard let self = self else { return }
        guard self.style === s else { return } // estilo mudou: outro lote já está a caminho
        for (k, r, L) in out where self.rows[k] === r {
          self.layouts[k] = L
        }
        if gen == self.generation { self.applySnapshot() }
      }
    }
  }

  var distanceFromLatest: CGFloat {
    guard let cv = cv else { return 0 }
    return cv.contentOffset.y + cv.adjustedContentInset.top
  }

  private func applySnapshot() {
    guard style != nil else { return }
    // só aplica quando TODAS as linhas da ordem alvo têm layout
    for k in target where layouts[k] == nil { return }
    let newKeys = target
    var dc = 0
    for k in newKeys where rows[k]?.kind == .date { dc += 1 }
    dateCount = dc
    let oldSet = Set(applied)
    let newSet = Set(newKeys)
    var heightChanged = false
    var reconf: [String] = []
    for k in changedSinceApply where oldSet.contains(k) && newSet.contains(k) {
      reconf.append(k)
      if let h = layouts[k]?.height, appliedHeights[k] != h { heightChanged = true }
    }
    let orderSame = newKeys == applied
    if orderSame && reconf.isEmpty {
      changedSinceApply.removeAll()
      pendingAnim = false
      sendReadyIfNeeded()
      return
    }
    // inserções só no fim (mais novas) e poucas → animar
    var insertedAtBottom = 0
    var insertedElsewhere = 0
    if !orderSame {
      for (i, k) in newKeys.enumerated() where !oldSet.contains(k) {
        if i < 4 { insertedAtBottom += 1 } else { insertedElsewhere += 1 }
      }
    }
    let dist = distanceFromLatest
    let atBottom = applied.isEmpty || dist < 3
    let reduce = UIAccessibility.isReduceMotionEnabled
    let animate = pendingAnim && atBottom && !applied.isEmpty && insertedAtBottom > 0 && insertedAtBottom <= 3 && insertedElsewhere == 0 && !reduce && window != nil

    // âncora: lendo acima → a linha visível mais embaixo fica parada na tela
    var anchorKey: String? = nil
    var anchorRel: CGFloat = 0
    if !atBottom {
      let vis = cv.indexPathsForVisibleItems.sorted()
      for ip in vis {
        guard ip.item < applied.count else { continue }
        let k = applied[ip.item]
        if !newSet.contains(k) { continue }
        if let a = cv.layoutAttributesForItem(at: ip) {
          anchorKey = k
          anchorRel = a.frame.minY - cv.contentOffset.y
          break
        }
      }
    }

    var snap = NSDiffableDataSourceSnapshot<Int, String>()
    snap.appendSections([0])
    snap.appendItems(newKeys, toSection: 0)
    if !reconf.isEmpty { snap.reconfigureItems(reconf) }

    applied = newKeys
    for k in changedSinceApply { if let h = layouts[k]?.height { appliedHeights[k] = h } }
    for k in newKeys where appliedHeights[k] == nil { appliedHeights[k] = layouts[k]?.height }
    changedSinceApply.removeAll()
    pendingAnim = false

    if heightChanged { flow.invalidateLayout() }
    flow.animateInsert = animate
    if animate {
      ds.apply(snap, animatingDifferences: true) { [weak self] in
        guard let self = self else { return }
        self.flow.animateInsert = false
        self.afterApply()
      }
      // fica grudado no fim enquanto anima
      cv.setContentOffset(CGPoint(x: 0, y: -cv.adjustedContentInset.top), animated: false)
    } else {
      UIView.performWithoutAnimation {
        ds.apply(snap, animatingDifferences: false)
        cv.layoutIfNeeded()
      }
      if let k = anchorKey, let ip = ds.indexPath(for: k), let a = cv.layoutAttributesForItem(at: ip) {
        let minO = -cv.adjustedContentInset.top
        let maxO = max(minO, cv.contentSize.height + cv.adjustedContentInset.bottom - cv.bounds.height)
        let o = max(minO, min(maxO, a.frame.minY - anchorRel))
        if abs(o - cv.contentOffset.y) > 0.5 { cv.contentOffset = CGPoint(x: 0, y: o) }
      } else if atBottom {
        cv.contentOffset = CGPoint(x: 0, y: -cv.adjustedContentInset.top)
      }
      afterApply()
    }
  }

  private func afterApply() {
    checkPendingPop()
    sendReadyIfNeeded()
    emitScroll(force: true)
    scheduleVisible()
  }

  private func sendReadyIfNeeded() {
    if readySent { return }
    readySent = true
    onReady(["count": applied.count, "src": jsApplied ? "js" : "store"])
  }

  // MARK: [native-store] foto da conversa

  func setStore(_ v: [String: Any]?) {
    #if canImport(ExpoChatStore)
    guard let v = v else { storeCfg = nil; return }
    let a = CMLRow.str(v["a"]), c = CMLRow.str(v["c"]), r = CMLRow.str(v["r"]), n = CMLRow.str(v["n"])
    if a.isEmpty || c.isEmpty || r.isEmpty { storeCfg = nil; return }
    if let p = storeCfg, p.a != a || p.c != c {
      // mesma view, outra conversa/conta: não regrava a janela antiga na nova chave
      persistWork?.cancel(); persistWork = nil
      rawDicts.removeAll()
      persistedVersion = jsVersion
    }
    storeCfg = StoreCfg(a: a, c: c, r: r, n: n)
    if jsApplied || storeLoadStarted { return }
    storeLoadStarted = true
    // [fase 1.5] pré-carga do pressIn da home: pinta SÍNCRONO, já no set da prop
    // (antes do 1º layout da view) — sem hop de fila.
    if let snap = ChatyyStoreDB.shared.cachedThread(account: a, conv: c, rev: r) {
      if n.isEmpty || snap.newest == n {
        applyRowsCore(["rows": snap.rows, "keys": snap.keys, "anim": 0], fromStore: true)
        onStore(["hit": 1, "why": "mem", "ms": 0, "readMs": Int(snap.readMs), "rows": snap.keys.count])
        watchStore(a, c)
        return
      }
    }
    loadStoreSnapshot(a, c, r, reason: "hit")
    watchStore(a, c)
    #endif
  }

  #if canImport(ExpoChatStore)
  private var storeObsToken: Int?

  deinit {
    if let t = storeObsToken { ChatyyStoreDB.shared.removeObserver(t) }
  }

  private func loadStoreSnapshot(_ a: String, _ c: String, _ r: String, reason: String) {
    let t0 = CACurrentMediaTime()
    ChatyyStoreDB.shared.loadThread(account: a, conv: c, rev: r) { [weak self] snap, why in
      guard let self = self else { return }
      let ms = Int((CACurrentMediaTime() - t0) * 1000)
      guard let snap = snap else { self.onStore(["hit": 0, "why": why, "ms": ms]); return }
      if self.jsApplied { self.onStore(["hit": 0, "why": "late", "ms": ms, "rows": snap.keys.count]); return }
      guard let cur = self.storeCfg, cur.a == a, cur.c == c else { self.onStore(["hit": 0, "why": "moved", "ms": ms]); return }
      // o JS tem mensagem mais nova que a foto → não pinta algo velho. Com a
      // fase 2 o sync já anexa as novas na foto (services/nativeStoreRows).
      if !cur.n.isEmpty && snap.newest != cur.n { self.onStore(["hit": 0, "why": "stale", "ms": ms, "rows": snap.keys.count]); return }
      self.applyRowsCore(["rows": snap.rows, "keys": snap.keys, "anim": reason == "hit" ? 0 : 1], fromStore: true)
      self.onStore(["hit": 1, "why": reason, "ms": ms, "readMs": Int(snap.readMs), "rows": snap.keys.count])
    }
  }

  /// [fase 2] enquanto SÓ a foto está na tela (JS ainda montando — casca leve),
  /// um lote do sync que mexe nesta conversa relê a foto (mensagem nova aparece).
  private func watchStore(_ a: String, _ c: String) {
    unwatchStore()
    storeObsToken = ChatyyStoreDB.shared.addObserver(account: a, conv: c) { [weak self] in
      guard let self = self, !self.jsApplied, let cfg = self.storeCfg, cfg.a == a, cfg.c == c else { return }
      // n (chave mais nova do JS) ficou para trás: a foto agora pode estar mais nova.
      self.storeCfg = StoreCfg(a: cfg.a, c: cfg.c, r: cfg.r, n: "")
      self.loadStoreSnapshot(a, c, cfg.r, reason: "live")
    }
  }

  private func unwatchStore() {
    if let t = storeObsToken { ChatyyStoreDB.shared.removeObserver(t); storeObsToken = nil }
  }
  #endif

  private func schedulePersist() {
    guard storeCfg != nil, jsApplied else { return }
    persistWork?.cancel()
    let w = DispatchWorkItem { [weak self] in self?.persistNow() }
    persistWork = w
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2, execute: w)
  }

  /// Regrava no store a janela mais nova (até storeWindow linhas) exatamente
  /// como o JS mandou — menos estado transitório (seleção, upload, não-lidas).
  private func persistNow() {
    persistWork?.cancel(); persistWork = nil
    #if canImport(ExpoChatStore)
    guard let cfg = storeCfg, jsApplied, persistedVersion != jsVersion else { return }
    persistedVersion = jsVersion
    var keys: [String] = []
    var out: [[String: Any]] = []
    for k in target { // mais nova primeiro
      if keys.count >= CMLListView.storeWindow { break }
      guard var d = rawDicts[k] else { continue }
      if (d["kind"] as? String) == "unread" { continue }
      if let id = d["id"] as? String, id.hasPrefix("tmp") { continue }
      d.removeValue(forKey: "sel")
      if var m = d["media"] as? [String: Any], m["up"] != nil { m.removeValue(forKey: "up"); d["media"] = m }
      keys.append(k)
      out.append(d)
    }
    keys.reverse(); out.reverse()
    ChatyyStoreDB.shared.saveThread(account: cfg.a, conv: cfg.c, rev: cfg.r, keys: keys, rows: out)
    #endif
  }

  // MARK: comandos (JS)

  func scrollToLatest(animated: Bool) {
    cv.setContentOffset(CGPoint(x: 0, y: -cv.adjustedContentInset.top), animated: animated)
    if !animated { emitScroll(force: true); scheduleVisible() }
  }

  func scrollToKey(_ key: String, viewPosition: Double, animated: Bool) -> Bool {
    guard let ip = ds.indexPath(for: key) else { return false }
    cv.layoutIfNeeded()
    guard let a = cv.layoutAttributesForItem(at: ip) else { return false }
    let H = cv.bounds.height
    let p = CGFloat(max(0, min(1, viewPosition)))
    let h = min(a.frame.height, H)
    let minO = -cv.adjustedContentInset.top
    let maxO = max(minO, cv.contentSize.height + cv.adjustedContentInset.bottom - H)
    let o = max(minO, min(maxO, a.frame.maxY - H + p * (H - h)))
    cv.setContentOffset(CGPoint(x: 0, y: o), animated: animated)
    if !animated { emitScroll(force: true); scheduleVisible() }
    return true
  }

  func flashKey(_ key: String) {
    if let ip = ds.indexPath(for: key), let cell = cv.cellForItem(at: ip) as? CMLCell {
      cell.flash()
    } else {
      pendingFlash = key
    }
  }

  func setAudioState(_ d: [String: Any]) {
    let id = CMLRow.str(d["id"])
    let prev = audioState?.id
    if id.isEmpty {
      audioState = nil
    } else {
      audioState = CMLAudioState(
        id: id,
        playing: CMLRow.bool(d["playing"]),
        loading: CMLRow.bool(d["loading"]),
        posMs: CMLRow.num(d["pos"]),
        durMs: CMLRow.num(d["dur"])
      )
    }
    guard let s = style else { return }
    for cell in cv.visibleCells {
      guard let c = cell as? CMLCell, let r = c.row, r.audio != nil else { continue }
      if r.id == id || r.id == prev { c.applyAudio(audioState, style: s) }
    }
  }

  // MARK: layout delegate

  public func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout, sizeForItemAt indexPath: IndexPath) -> CGSize {
    let w = max(1, collectionView.bounds.width)
    guard let k = ds.itemIdentifier(for: indexPath), let L = layouts[k] else { return CGSize(width: w, height: 1) }
    return CGSize(width: w, height: max(1, L.height))
  }

  public func collectionView(_ collectionView: UICollectionView, prefetchItemsAt indexPaths: [IndexPath]) {
    let scale = UIScreen.main.scale
    for ip in indexPaths {
      guard let k = ds.itemIdentifier(for: ip), let r = rows[k], let L = layouts[k] else { continue }
      if let m = r.media, !m.uri.isEmpty, !L.mediaFrame.isEmpty {
        CMLImageLoader.shared.prefetch(m.uri, maxPixel: max(L.mediaFrame.width, L.mediaFrame.height) * scale)
      }
      for (i, m) in r.album.enumerated() where i < L.albumFrames.count && !m.uri.isEmpty {
        let f = L.albumFrames[i]
        CMLImageLoader.shared.prefetch(m.uri, maxPixel: max(f.width, f.height) * scale)
      }
    }
  }

  // MARK: rolagem

  public func scrollViewDidScroll(_ scrollView: UIScrollView) {
    emitScroll(force: false)
    scheduleVisible()
    if stickyOn && (dragging || scrollView.isDecelerating) { updateSticky() }
    // carregar antigas: perto do TOPO visual (= fim do conteúdo na invertida)
    let H = scrollView.bounds.height
    let remaining = scrollView.contentSize.height - (scrollView.contentOffset.y + H)
    if remaining < H * 1.5 && !applied.isEmpty && olderArmed {
      let now = CACurrentMediaTime()
      if now - lastOlderAt > 0.8 {
        lastOlderAt = now
        olderArmed = false
        onLoadOlder([:])
      }
    }
  }

  public func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
    dragging = true
    onDragState(["dragging": true])
  }

  public func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    dragging = false
    onDragState(["dragging": false])
    if !decelerate { emitScroll(force: true); scheduleVisible(); scheduleStickyHide() }
  }

  public func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
    emitScroll(force: true)
    scheduleVisible()
    scheduleStickyHide()
  }

  public func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
    emitScroll(force: true)
    scheduleVisible()
    scheduleStickyHide()
  }

  // [2026-10-15 native-effects] emoji grande anima 1× ao entrar na tela
  public func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
    (cell as? CMLCell)?.willAppear()
  }

  public func collectionView(_ collectionView: UICollectionView, didEndDisplaying cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
    (cell as? CMLCell)?.blocks.stopMedia()
  }

  private func emitScroll(force: Bool) {
    let d = max(0, distanceFromLatest)
    let cls = d <= 6 ? 0 : (d <= 120 ? 1 : (d <= 300 ? 2 : 3))
    let now = CACurrentMediaTime()
    if !force && cls == lastDistClass && now - lastScrollEmit < 0.066 { return }
    lastDistClass = cls
    lastScrollEmit = now
    let ch = cv.contentSize.height + cv.adjustedContentInset.top + cv.adjustedContentInset.bottom
    onScrollState(["dist": Double(d), "ch": Double(max(ch, cv.bounds.height)), "vh": Double(cv.bounds.height)])
  }

  private func scheduleVisible() {
    if visibleScheduled { return }
    visibleScheduled = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
      guard let self = self else { return }
      self.visibleScheduled = false
      self.emitVisible()
    }
  }

  private func emitVisible() {
    guard window != nil else { return }
    let vis = CGRect(x: 0, y: cv.contentOffset.y, width: cv.bounds.width, height: cv.bounds.height)
    var keys: [String] = []
    for ip in cv.indexPathsForVisibleItems.sorted() {
      guard let k = ds.itemIdentifier(for: ip), let a = cv.layoutAttributesForItem(at: ip) else { continue }
      let inter = a.frame.intersection(vis)
      if inter.isNull { continue }
      if inter.height >= min(a.frame.height, vis.height) * 0.3 { keys.append(k) }
    }
    let sig = keys.joined(separator: "|")
    if sig == lastVisibleSig { return }
    lastVisibleSig = sig
    if !keys.isEmpty { onVisible(["keys": keys]) }
  }

  // MARK: gestos

  private func cellAt(_ g: UIGestureRecognizer) -> (CMLCell, CGPoint)? {
    let p = g.location(in: cv)
    guard let ip = cv.indexPathForItem(at: p), let cell = cv.cellForItem(at: ip) as? CMLCell else { return nil }
    return (cell, cell.contentView.convert(p, from: cv))
  }

  @objc private func onTap(_ g: UITapGestureRecognizer) {
    guard storeInteractive, g.state == .ended, let hit = cellAt(g), let row = hit.0.row else { return }
    let cell = hit.0, pc = hit.1
    var body: [String: Any] = ["key": cell.key]
    if row.sel > 0 && row.kind == .msg {
      body["part"] = "bubble"
      onRowPress(body)
      return
    }
    switch cell.part(at: pc) {
    case .action(let a, let r, let rad):
      body["part"] = "action"; body["url"] = a
      cell.blocks.flashAction(r, radius: rad)
    case .retry: body["part"] = "retry"
    case .vnote(let i):
      let st = cell.blocks.toggleVideoNote(i)
      body["part"] = "vnote"; body["url"] = st.isEmpty ? "play" : st; body["index"] = i
    case .spoiler:
      revealedKeys.insert(cell.key)
      cell.revealSpoilers()
      return
    case .media(let i):
      body["part"] = "media"; body["index"] = i
      // [hero] miniatura tocada na janela → viewer anima a foto saindo dela
      if let fr = cell.mediaRectInWindow(i) { body["frame"] = CMLListView.frameDict(fr.0, fr.1) }
    case .reply: body["part"] = "reply"
    case .link(let u, _): body["part"] = "link"; body["url"] = u
    case .audio: body["part"] = "audio"
    case .file: body["part"] = "file"
    case .reaction(let i):
      body["part"] = "reaction"; body["index"] = i
      if i < row.reacts.count { body["url"] = row.reacts[i].emoji }
    case .bubble: body["part"] = "bubble"
    case .none:
      if row.sel > 0 { body["part"] = "bubble" } else { return }
    }
    if row.sel > 0 && row.kind == .msg { body["part"] = "bubble" }
    onRowPress(body)
  }

  @objc private func onLong(_ g: UILongPressGestureRecognizer) {
    guard storeInteractive, g.state == .began, let hit = cellAt(g), let row = hit.0.row, row.kind == .msg || row.kind == .system else { return }
    let cell = hit.0, pc = hit.1
    var idx = 0
    switch cell.part(at: pc) {
    case .none: return
    case .media(let i): idx = i
    default: break
    }
    // [fase 2] haptic + "lift" + snapshot do balão → o overlay JS (MessageLiftOverlay)
    // anima o snapshot a partir do retângulo real (mesmo menu/estética de hoje).
    hapticMedium.impactOccurred()
    let key = cell.key
    let snap = (row.kind == .msg && row.sel == 0) ? cell.liftSnapshot() : nil
    // [native-ctxmenu] menu 100% nativo: o balão sai da lista JÁ (antes do JS
    // responder); o JS manda a lista de ações via showContextMenu(payload).
    if ctxMenuOn, let shot = snap, ctxOverlay == nil, openCtxOverlay(key: key, image: shot.0, rect: shot.1, own: row.own) {
      onRowLongPress(["key": key, "index": idx, "native": 1])
      return
    }
    cell.liftPulse()
    guard let shot = snap else {
      onRowLongPress(["key": key, "index": idx])
      return
    }
    let img = shot.0
    let rect = shot.1
    if let old = lastLiftFile {
      DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 30) { try? FileManager.default.removeItem(at: old) }
    }
    let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("cml-lift-\(UUID().uuidString).png")
    lastLiftFile = url
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      var ok = false
      if let data = img.pngData() { ok = (try? data.write(to: url, options: .atomic)) != nil }
      DispatchQueue.main.async {
        guard let self = self else { return }
        var body: [String: Any] = ["key": key, "index": idx]
        if ok {
          body["anchor"] = ["uri": url.absoluteString, "x": Double(rect.minX), "y": Double(rect.minY), "w": Double(rect.width), "h": Double(rect.height)] as [String: Any]
        }
        self.onRowLongPress(body)
      }
    }
  }

  // MARK: [hero] frame da miniatura por messageId (viewer: ida e volta)

  static func frameDict(_ r: CGRect, _ radius: CGFloat) -> [String: Any] {
    return ["x": Double(r.minX), "y": Double(r.minY), "w": Double(r.width), "h": Double(r.height), "radius": Double(radius)]
  }

  /// Miniatura da mensagem `mid` (foto/vídeo solto ou item de álbum) visível
  /// agora → frame na janela + raio; nil se fora da tela.
  func mediaFrame(_ mid: String) -> [String: Any]? {
    guard !mid.isEmpty, let win = window else { return nil }
    for c in cv.visibleCells {
      guard let cell = c as? CMLCell, let row = cell.row, row.kind == .msg else { continue }
      var idx = -1
      if !row.album.isEmpty {
        if let i = row.album.firstIndex(where: { $0.id == mid }) { idx = i }
        else if let i = row.albumIds.firstIndex(of: mid) { idx = min(i, row.album.count - 1) }
        else if row.id == mid { idx = 0 }
      } else if row.id == mid && row.media != nil {
        idx = 0
      }
      if idx < 0 { continue }
      guard let fr = cell.mediaRectInWindow(idx) else { return nil }
      let r = fr.0, rad = fr.1
      // fora da área visível da lista → sem hero (fecha com fade)
      let listRect = convert(bounds, to: nil)
      if !r.intersects(listRect) || !r.intersects(win.bounds) { return nil }
      return CMLListView.frameDict(r, rad)
    }
    return nil
  }

  // MARK: [native-ctxmenu] menu de contexto nativo

  func setDarkHint(_ v: Bool?) { darkHint = v }

  func setCtxMenu(_ on: Bool) {
    ctxMenuOn = on
    if !on { ctxOverlay?.dismiss(reason: "off", animated: false) }
  }

  private func currentBubbleRect(_ key: String) -> CGRect? {
    guard let c = visibleCell(key), c.window != nil else { return nil }
    return c.liftRectInWindow()
  }

  @discardableResult
  private func openCtxOverlay(key: String, image: UIImage, rect: CGRect, own: Bool) -> Bool {
    guard let win = window else { return false }
    let dark = darkHint ?? (traitCollection.userInterfaceStyle == .dark)
    let ov = CMLContextMenuOverlay(key: key, image: image, rect: rect, own: own, dark: dark)
    ov.sourceRectProvider = { [weak self] in self?.currentBubbleRect(key) }
    ov.onAction = { [weak self] d, action in
      self?.onMenuAction(["key": d.key, "messageId": d.messageId, "action": action])
    }
    ov.onReact = { [weak self] d, emoji in
      guard let self = self else { return }
      self.popKey = d.key
      self.popSig = self.reactSig(d.key)
      self.popUntil = CACurrentMediaTime() + 4
      self.onReact(["key": d.key, "messageId": d.messageId, "emoji": emoji])
    }
    ov.onDismissed = { [weak self, weak ov] reason in
      guard let self = self else { return }
      if let o = ov, self.ctxOverlay === o { self.ctxOverlay = nil }
      if self.liftedKey == key { self.setLiftedKey("") }
      self.onMenuDismiss(["key": key, "reason": reason])
      self.checkPendingPop()
    }
    ctxOverlay = ov
    setLiftedKey(key)
    ov.present(in: win)
    return true
  }

  /// JS → nativo: lista de ações/reações do menu. Abre o overlay se o
  /// long-press não abriu (ex.: chamado pelo JS direto). false = não deu.
  func showContextMenu(_ payload: [String: Any]) -> Bool {
    let d = CMLCtxMenuData(payload)
    guard !d.key.isEmpty else { return false }
    if let ov = ctxOverlay, !ov.dismissing {
      if ov.key == d.key {
        if ov.data == nil { ov.setMenu(d) }
        return true
      }
      ov.dismiss(reason: "replaced", animated: false)
    }
    guard let c = visibleCell(d.key), let row = c.row, row.kind == .msg, let shot = c.liftSnapshot() else { return false }
    guard openCtxOverlay(key: d.key, image: shot.0, rect: shot.1, own: row.own), let ov = ctxOverlay else { return false }
    ov.setMenu(d)
    return true
  }

  func dismissContextMenu() {
    ctxOverlay?.dismiss(reason: "js")
  }

  private func reactSig(_ k: String) -> String {
    guard let r = rows[k] else { return "" }
    return r.reacts.map { "\($0.emoji):\($0.count):\($0.mine ? 1 : 0)" }.joined(separator: ",")
  }

  /// Chip da reação aparece com "pop" quando a linha chega com as reações novas.
  private func checkPendingPop() {
    guard let k = popKey else { return }
    if CACurrentMediaTime() > popUntil { popKey = nil; return }
    if let ov = ctxOverlay, ov.key == k { return } // ainda voando / balão voltando
    let sig = reactSig(k)
    if sig == popSig { return }
    popKey = nil
    guard let r = rows[k], !r.reacts.isEmpty, let c = visibleCell(k) else { return }
    c.popReactions()
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil, let ov = ctxOverlay {
      ov.dismiss(reason: "detach", animated: false)
    }
    if window == nil { persistNow() } // [native-store] saiu da conversa → grava já
  }

  func swipeShouldBegin() -> Bool {
    if !storeInteractive { return false }
    let v = swipe.velocity(in: cv)
    let pSelf = swipe.location(in: self)
    if pSelf.x < 28 { return false } // borda = voltar (navegação)
    guard abs(v.x) > abs(v.y) * 1.3 else { return false }
    guard let hit = cellAt(swipe), let row = hit.0.row, row.kind == .msg, row.sel == 0 else { return false }
    let cell = hit.0
    if v.x > 0 {
      swipeDir = 1
    } else {
      if !row.own || row.deleted { return false }
      swipeDir = -1
    }
    swipeCell = cell
    swipeArmed = false
    return true
  }

  func swipeRequiredToFail(by other: UIGestureRecognizer) -> Bool {
    // O "voltar" de tela cheia da navegação espera o arrastar-p/-responder falhar.
    guard other is UIPanGestureRecognizer, let ov = other.view else { return false }
    if ov === cv || ov is UIScrollView { return false }
    return self.isDescendant(of: ov)
  }

  @objc private func onSwipe(_ g: UIPanGestureRecognizer) {
    guard let cell = swipeCell else { return }
    let t = g.translation(in: cv).x * swipeDir
    switch g.state {
    case .began:
      haptic.prepare()
    case .changed:
      let raw = max(0, t)
      var x = raw <= swipeThreshold ? raw : swipeThreshold + (raw - swipeThreshold) * 0.35
      x = min(x, 110)
      cell.setSwipe(x * swipeDir, threshold: swipeThreshold)
      let armedNow = raw >= swipeThreshold
      if armedNow && !swipeArmed {
        haptic.impactOccurred()
        cell.popReplyIcon() // [reply-v2] "estala" no limiar (Telegram)
        haptic.prepare()
      }
      swipeArmed = armedNow
    case .ended, .cancelled, .failed:
      let fire = g.state == .ended && swipeArmed
      let key = cell.key
      let dir = swipeDir
      // [reply-v2] volta com mola (leve overshoot), velocidade do dedo.
      let cur = abs(cell.slide.transform.tx)
      let vx = abs(g.velocity(in: cv).x)
      let iv = cur > 1 ? min(8, vx / cur) : 0
      UIView.animate(withDuration: 0.42, delay: 0, usingSpringWithDamping: 0.72, initialSpringVelocity: iv, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
        cell.setSwipe(0, threshold: self.swipeThreshold)
      })
      swipeCell = nil
      swipeArmed = false
      if fire { onSwipeReply(["key": key, "dir": dir > 0 ? "reply" : "info"]) }
    default:
      break
    }
  }
}
