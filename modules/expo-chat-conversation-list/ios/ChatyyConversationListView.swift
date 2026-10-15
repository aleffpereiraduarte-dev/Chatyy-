import ExpoModulesCore
import UIKit
#if canImport(ExpoChatStore)
import ExpoChatStore
#endif

/// UICollectionView que avisa quando faz layout (reposiciona header/rodapé RN).
final class CLCollectionView: UICollectionView {
  var onLayout: (() -> Void)?
  override func layoutSubviews() {
    super.layoutSubviews()
    onLayout?()
  }
}

/// Contêiner do filho RN (header/rodapé) dentro da collection view. O Fabric
/// continua dono do frame do filho (0,0,w,h); aqui só o posicionamos no
/// espaço de conteúdo (header em y = -altura, rodapé após a última linha).
final class CLChildHost: UIView {
  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    clipsToBounds = false
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

public final class ChatyyConversationListView: ExpoView, UICollectionViewDelegate {
  let onRowPress = EventDispatcher()
  let onRowPressIn = EventDispatcher()
  let onAvatarPress = EventDispatcher()
  let onRowAction = EventDispatcher()
  let onLongPress = EventDispatcher()
  let onPeekRequest = EventDispatcher()
  let onPeekOpen = EventDispatcher()
  let onCollapsedChange = EventDispatcher()
  let onEndReached = EventDispatcher()
  let onResync = EventDispatcher()
  let onFirstPaint = EventDispatcher()
  let onNativeError = EventDispatcher()

  private var collectionView: CLCollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<Int, String>!

  // Estado dos dados (espelho do que o JS mandou).
  private var rows: [String: CLRow] = [:]
  private var order: [String] = []
  private var seq: Double = 0
  private var pendingReset = false
  private var pendingDirty = Set<String>()
  private var needsApply = false
  private var appliedOnce = false
  private var firstPaintSent = false
  private var resyncAskedFor: Double = -1

  // Aparência / modos.
  private var theme = CLTheme(dark: false)
  private var themeDirty = true
  private var labels = CLLabels()
  private var labelsDirty = false
  private var selectionMode = false
  private var selectionDirty = false
  var swipeEnabled = true
  var menuEnabled = true
  var collapseOffset: CGFloat = 34
  private var collapsed = false

  // Header / rodapé RN.
  private let headerHost = CLChildHost()
  private let footerHost = CLChildHost()
  private var rnChildren: [UIView] = []
  private var boundsObservers: [NSKeyValueObservation] = []
  private var headerHint: CGFloat = 0
  private var footerHint: CGFloat = 0
  private var headerH: CGFloat = 0
  private var footerH: CGFloat = 0
  private var bottomInset: CGFloat = 0
  private var didInitialOffset = false
  private var scrollTopSeq: Double = 0
  private var endReachedFor: CGFloat = -1

  // Listas do usuário (submenu "Adicionar à lista")
  private var folders: [CLFolder] = []

  // Peek
  private weak var peekController: CLPeekController?
  private var lastPeek: [String: Any]?

  // [2026-10-15 native-store fase 1.5] Foto da HOME no store nativo. Prop
  // `store` {a: conta, r: rev do formato, n: assinatura da 1ª linha do JS, s:
  // escopo}: no cold start, se o JS ainda não mandou linhas (adiou o buildRow
  // p/ depois do 1º frame), a lista pinta a foto direto do store. O 1º reset do
  // JS substitui tudo. Depois de cada patch do JS as 60 primeiras linhas são
  // regravadas (debounce) sem cruzar a ponte.
  private var storeA = "", storeR = "", storeN = "", storeS = "main"
  private var storeLoadStarted = false
  private var storeLoading = false
  private var photoActive = false
  private var jsHasRows = false
  private var rawRows: [String: [String: Any]] = [:]
  private var persistWork: DispatchWorkItem?
  private var jsVersion = 0
  private var persistedVersion = 0
  static let homeWindow = 60

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    setupCollection()
  }

  // MARK: - Setup

  private func setupCollection() {
    let cv = CLCollectionView(frame: bounds, collectionViewLayout: makeLayout())
    cv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    cv.contentInsetAdjustmentBehavior = .never
    cv.alwaysBounceVertical = true
    cv.keyboardDismissMode = .none
    cv.delegate = self
    cv.backgroundColor = theme.bg
    cv.addSubview(headerHost)
    cv.addSubview(footerHost)
    cv.onLayout = { [weak self] in self?.layoutHosts() }
    addSubview(cv)
    collectionView = cv

    let reg = UICollectionView.CellRegistration<CLConversationCell, String> { [weak self] cell, _, id in
      guard let self = self else { return }
      self.bind(cell, id: id)
    }
    dataSource = UICollectionViewDiffableDataSource<Int, String>(collectionView: cv) { collectionView, indexPath, id in
      return collectionView.dequeueConfiguredReusableCell(using: reg, for: indexPath, item: id)
    }
  }

  private func bind(_ cell: CLConversationCell, id: String) {
    guard let row = rows[id] else { return }
    cell.configure(row, theme: theme, labels: labels, selectionMode: selectionMode)
    cell.onAvatarTap = { [weak self] rid in
      self?.onAvatarPress(["id": rid])
    }
    cell.onA11yAction = { [weak self] rid, action in
      self?.emitAction(rid, action, source: "a11y")
    }
  }

  private func makeLayout() -> UICollectionViewLayout {
    var cfg = UICollectionLayoutListConfiguration(appearance: .plain)
    cfg.backgroundColor = theme.bg
    cfg.showsSeparators = true
    var sep = UIListSeparatorConfiguration(listAppearance: .plain)
    sep.color = theme.hair
    sep.topSeparatorVisibility = .hidden
    // Linha fina a partir do nome (16 + 54 + 14), como no JS.
    let lead: CGFloat = (selectionMode ? 36 : 0) + 16 + CLAvatarView.box + 14
    sep.bottomSeparatorInsets = NSDirectionalEdgeInsets(top: 0, leading: lead, bottom: 0, trailing: 0)
    cfg.separatorConfiguration = sep
    cfg.leadingSwipeActionsConfigurationProvider = { [weak self] indexPath in
      return self?.swipeConfiguration(indexPath, leading: true)
    }
    cfg.trailingSwipeActionsConfigurationProvider = { [weak self] indexPath in
      return self?.swipeConfiguration(indexPath, leading: false)
    }
    return UICollectionViewCompositionalLayout.list(using: cfg)
  }

  // MARK: - Props

  func setRowsPatch(_ patch: [String: Any]?) {
    guard let p = patch else { return }
    let pseq = CLVal.double(p["seq"])
    if let reset = p["reset"] as? [Any] {
      // Reset é aceito sempre que for NOVO (montagem, troca de conta, resync);
      // o mesmo reset reenviado junto de outra prop é ignorado.
      if pseq == seq && appliedOnce { return }
      var next: [String: CLRow] = [:]
      var ids: [String] = []
      let track = true // [native-store] a prop store pode chegar depois do 1º reset
      if track { rawRows.removeAll(keepingCapacity: true) }
      for item in reset {
        guard let d = item as? [String: Any] else { continue }
        let r = CLRow(d)
        if r.id.isEmpty { continue }
        if next[r.id] == nil { ids.append(r.id) }
        next[r.id] = r
        if track { rawRows[r.id] = d }
      }
      noteJSPatch()
      rows = next
      order = ids
      if let ord = p["order"] as? [Any] {
        order = ord.map { CLVal.str($0) }
      }
      seq = pseq
      pendingReset = true
      needsApply = true
      return
    }
    if pseq <= seq { return } // repetido (o mesmo patch reenviado)
    let base = CLVal.double(p["base"])
    if base != seq {
      // Perdemos um patch: pede o estado inteiro (uma vez por seq).
      if resyncAskedFor != seq {
        resyncAskedFor = seq
        onResync(["seq": seq])
      }
      return
    }
    if let rm = p["remove"] as? [Any] {
      for x in rm { rows.removeValue(forKey: CLVal.str(x)); rawRows.removeValue(forKey: CLVal.str(x)) }
    }
    noteJSPatch()
    if let ups = p["upsert"] as? [Any] {
      for item in ups {
        guard let d = item as? [String: Any] else { continue }
        let r = CLRow(d)
        if r.id.isEmpty { continue }
        rawRows[r.id] = d
        if rows[r.id] == nil && p["order"] == nil { order.append(r.id) }
        rows[r.id] = r
        pendingDirty.insert(r.id)
      }
    }
    if let ord = p["order"] as? [Any] {
      order = ord.map { CLVal.str($0) }
    }
    seq = pseq
    needsApply = true
  }

  func setDark(_ dark: Bool) {
    if dark == theme.dark && !themeDirty { return }
    theme = CLTheme(dark: dark)
    themeDirty = true
  }

  func setSelectionMode(_ on: Bool) {
    if on == selectionMode { return }
    selectionMode = on
    selectionDirty = true
  }

  func setLabels(_ d: [String: Any]?) {
    labels = CLLabels(d)
    labelsDirty = true
  }

  func setHeaderHeightHint(_ h: CGFloat) {
    headerHint = max(0, h)
  }

  func setFooterHeightHint(_ h: CGFloat) {
    footerHint = max(0, h)
  }

  func setBottomInset(_ b: CGFloat) {
    bottomInset = max(0, b)
  }

  func setFolders(_ list: [[String: Any]]?) {
    folders = (list ?? []).map { CLFolder($0) }.filter { !$0.id.isEmpty && !$0.name.isEmpty }
  }

  func setPeek(_ d: [String: Any]?) {
    lastPeek = d
    if let d = d { peekController?.update(d) }
  }

  func setScrollToTopSeq(_ s: Double) {
    if s <= scrollTopSeq { scrollTopSeq = max(scrollTopSeq, s); return }
    let first = scrollTopSeq == 0
    scrollTopSeq = s
    if first && !appliedOnce { return }
    collectionView.setContentOffset(CGPoint(x: 0, y: -collectionView.contentInset.top), animated: true)
  }

  func commitProps() {
    // [native-store] foto da home ainda lendo e o JS sem linhas: não aplica
    // um snapshot vazio (evita onFirstPaint com 0 e um frame em branco).
    if storeLoading && rows.isEmpty { return }
    var reconfigureAll = false
    if themeDirty || selectionDirty {
      backgroundColor = theme.bg
      collectionView.backgroundColor = theme.bg
      collectionView.indicatorStyle = theme.dark ? .white : .black
      collectionView.setCollectionViewLayout(makeLayout(), animated: false)
      reconfigureAll = appliedOnce
      themeDirty = false
      selectionDirty = false
    }
    if labelsDirty {
      labelsDirty = false
      reconfigureAll = reconfigureAll || appliedOnce
    }
    applySnapshot(reconfigureAll: reconfigureAll)
    refreshInsets()
  }

  // MARK: - [native-store fase 1.5] foto da home

  func setStore(_ v: [String: Any]?) {
    #if canImport(ExpoChatStore)
    guard let v = v else { storeA = ""; persistWork?.cancel(); persistWork = nil; return }
    let a = CLVal.str(v["a"]), r = CLVal.str(v["r"])
    if a.isEmpty || r.isEmpty { storeA = ""; return }
    if !storeA.isEmpty && storeA != a { persistWork?.cancel(); persistWork = nil; persistedVersion = jsVersion }
    storeA = a; storeR = r; storeN = CLVal.str(v["n"])
    let sc = CLVal.str(v["s"]); storeS = sc.isEmpty ? "main" : sc
    if jsHasRows || storeLoadStarted { return }
    storeLoadStarted = true
    storeLoading = true
    let scope = storeS
    ChatyyStoreDB.shared.loadHome(account: a, scope: scope, rev: r) { [weak self] snap, _ in
      guard let self = self else { return }
      self.storeLoading = false
      if let snap = snap, !self.jsHasRows, self.storeA == a {
        var next: [String: CLRow] = [:]
        var ids: [String] = []
        for d in snap.rows {
          let row = CLRow(d)
          if row.id.isEmpty || next[row.id] != nil { continue }
          next[row.id] = row; ids.append(row.id)
        }
        if !ids.isEmpty {
          self.rows = next
          self.order = ids
          self.photoActive = true
          self.pendingReset = true
          self.needsApply = true
        }
      }
      self.commitProps()
    }
    #endif
  }

  private func noteJSPatch() {
    jsHasRows = true
    photoActive = false
    storeLoading = false
    jsVersion += 1
    schedulePersist()
  }

  private func schedulePersist() {
    if storeA.isEmpty { return }
    persistWork?.cancel()
    let w = DispatchWorkItem { [weak self] in self?.persistNow() }
    persistWork = w
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: w)
  }

  /// Regrava as primeiras linhas como o JS mandou, sem estado transitório
  /// (digitando, seleção, online).
  private func persistNow() {
    persistWork?.cancel(); persistWork = nil
    #if canImport(ExpoChatStore)
    if storeA.isEmpty || !jsHasRows || selectionMode || persistedVersion == jsVersion { return }
    persistedVersion = jsVersion
    var ids: [String] = []
    var out: [[String: Any]] = []
    for id in order {
      if ids.count >= Self.homeWindow { break }
      guard var d = rawRows[id] else { continue }
      d["typing"] = ""
      d["selected"] = false
      d["online"] = false
      d["activity"] = ""
      ids.append(id); out.append(d)
    }
    ChatyyStoreDB.shared.saveHome(account: storeA, scope: storeS, rev: storeR, top: storeN, ids: ids, rows: out)
    #endif
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { persistNow() }
  }

  // MARK: - Snapshot

  private func applySnapshot(reconfigureAll: Bool) {
    guard needsApply || reconfigureAll || !appliedOnce else { return }
    needsApply = false
    var seen = Set<String>()
    var ids: [String] = []
    ids.reserveCapacity(order.count)
    for id in order where rows[id] != nil && !seen.contains(id) {
      seen.insert(id)
      ids.append(id)
    }
    // Linhas que vieram em upsert mas ficaram fora do `order` (defensivo).
    if ids.count < rows.count {
      for id in rows.keys.sorted() where !seen.contains(id) {
        seen.insert(id)
        ids.append(id)
      }
    }
    order = ids
    let oldIds = Set(dataSource.snapshot().itemIdentifiers)
    var snap = NSDiffableDataSourceSnapshot<Int, String>()
    snap.appendSections([0])
    snap.appendItems(ids, toSection: 0)
    let reconf: [String]
    if reconfigureAll || pendingReset {
      reconf = ids.filter { oldIds.contains($0) }
    } else {
      reconf = pendingDirty.filter { seen.contains($0) && oldIds.contains($0) }
    }
    pendingDirty.removeAll()
    if !reconf.isEmpty { snap.reconfigureItems(reconf) }
    let animate = appliedOnce && !pendingReset && !reconfigureAll && window != nil
    pendingReset = false
    appliedOnce = true
    dataSource.apply(snap, animatingDifferences: animate) { [weak self] in
      self?.afterApply()
    }
  }

  private func afterApply() {
    layoutHosts()
    if !firstPaintSent {
      firstPaintSent = true
      DispatchQueue.main.async { [weak self] in
        self?.onFirstPaint(["count": self?.order.count ?? 0])
      }
    }
  }

  // MARK: - Filhos RN (header / rodapé)

  public override func mountChildComponentView(_ childComponentView: UIView, index: Int) {
    let i = max(0, min(index, rnChildren.count))
    rnChildren.insert(childComponentView, at: i)
    reattachChildren()
  }

  public override func unmountChildComponentView(_ childComponentView: UIView, index: Int) {
    // O RN exige que o filho saia sem superview.
    childComponentView.removeFromSuperview()
    rnChildren.removeAll { $0 === childComponentView }
    reattachChildren()
  }

  private func reattachChildren() {
    boundsObservers.removeAll()
    for (i, v) in rnChildren.enumerated() {
      let host = i == 0 ? headerHost : footerHost
      if v.superview !== host { host.addSubview(v) }
      let obs = v.observe(\.bounds, options: [.new]) { [weak self] _, _ in
        DispatchQueue.main.async { self?.refreshInsets() }
      }
      boundsObservers.append(obs)
    }
    refreshInsets()
  }

  private func refreshInsets() {
    guard let cv = collectionView else { return }
    var hh: CGFloat = 0
    if let h = rnChildren.first { hh = h.frame.maxY }
    let newHeader = hh > 0.5 ? hh : headerHint
    var fh: CGFloat = 0
    if rnChildren.count > 1 {
      for v in rnChildren[1...] { fh = max(fh, v.frame.maxY) }
    }
    let newFooter = fh > 0.5 ? fh : footerHint
    let insets = UIEdgeInsets(top: newHeader, left: 0, bottom: newFooter + bottomInset, right: 0)
    if cv.contentInset != insets {
      let oldTop = cv.contentInset.top
      let atTop = cv.contentOffset.y <= -oldTop + 0.5
      cv.contentInset = insets
      cv.verticalScrollIndicatorInsets = UIEdgeInsets(top: 0, left: 0, bottom: bottomInset, right: 0)
      if !didInitialOffset || (atTop && !cv.isTracking && !cv.isDecelerating) {
        cv.contentOffset = CGPoint(x: 0, y: -newHeader)
        didInitialOffset = newHeader > 0 || appliedOnce
      }
    }
    headerH = newHeader
    footerH = newFooter
    layoutHosts()
  }

  private func layoutHosts() {
    guard let cv = collectionView else { return }
    let w = cv.bounds.width
    let hf = CGRect(x: 0, y: -headerH, width: w, height: headerH)
    if headerHost.frame != hf { headerHost.frame = hf }
    let ff = CGRect(x: 0, y: cv.contentSize.height, width: w, height: footerH)
    if footerHost.frame != ff { footerHost.frame = ff }
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    if collectionView.frame != bounds { collectionView.frame = bounds }
    layoutHosts()
  }

  // MARK: - Ações

  private func emitAction(_ id: String, _ action: String, source: String) {
    onRowAction(["id": id, "action": action, "source": source])
  }

  private func contextual(_ id: String, _ action: String, title: String, symbol: String, color: UInt32) -> UIContextualAction {
    let a = UIContextualAction(style: .normal, title: title) { [weak self] _, _, done in
      UISelectionFeedbackGenerator().selectionChanged()
      self?.emitAction(id, action, source: "swipe")
      done(true)
    }
    a.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .medium))?
      .withTintColor(.white, renderingMode: .alwaysOriginal)
    a.backgroundColor = UIColor(clHex: color)
    return a
  }

  private func swipeConfiguration(_ indexPath: IndexPath, leading: Bool) -> UISwipeActionsConfiguration? {
    guard swipeEnabled, !selectionMode, !photoActive,
          let id = dataSource.itemIdentifier(for: indexPath),
          let row = rows[id] else { return nil }
    var actions: [UIContextualAction] = []
    let L = labels
    if leading {
      // Escala de cinzas (SWIPE_C do JS). 1ª ação = swipe completo.
      actions.append(contextual(id, "toggleRead",
                                title: row.unreadVisible ? L.get("markRead", "Lida") : L.get("markUnread", "Não lida"),
                                symbol: row.unreadVisible ? "checkmark.circle" : "message", color: 0x1C1C1E))
      actions.append(contextual(id, "mute",
                                title: row.muted ? L.get("unmute", "Reativar") : L.get("mute", "Silenciar"),
                                symbol: row.muted ? "bell" : "bell.slash", color: 0x3A3A3C))
      actions.append(contextual(id, "pin",
                                title: row.pinned ? L.get("unpin", "Desafixar") : L.get("pin", "Fixar"),
                                symbol: row.pinned ? "pin.slash" : "pin", color: 0x636366))
      if L.dict["email"] != nil {
        actions.append(contextual(id, "email", title: L.get("email", "E-mail"), symbol: "envelope", color: 0x8E8E93))
      }
    } else {
      actions.append(contextual(id, "archive",
                                title: row.archived ? L.get("unarchive", "Desarquivar") : L.get("archive", "Arquivar"),
                                symbol: row.archived ? "tray.and.arrow.up" : "archivebox", color: 0x3A3A3C))
      actions.append(contextual(id, "delete", title: L.get("delete", "Excluir"), symbol: "trash", color: 0xFF3B30))
    }
    let cfg = UISwipeActionsConfiguration(actions: actions)
    cfg.performsFirstActionWithFullSwipe = true
    return cfg
  }

  private func buildMenu(id: String, row: CLRow) -> UIMenu {
    // Menu nativo estilo WhatsApp (toque longo) — montado em CLMenuBuilder
    // (o mesmo da fileira de fixados).
    return CLMenuBuilder.rowMenu(id: id, row: row, labels: labels, folders: folders) { [weak self] body in
      self?.onRowAction(body)
    }
  }

  // MARK: - UICollectionViewDelegate

  public func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: true)
    guard let id = dataSource.itemIdentifier(for: indexPath) else { return }
    onRowPress(["id": id])
  }

  public func collectionView(_ collectionView: UICollectionView, didHighlightItemAt indexPath: IndexPath) {
    // Pré-carrega a conversa no toque (o JS usa onPressIn para isso).
    if selectionMode { return }
    guard let id = dataSource.itemIdentifier(for: indexPath) else { return }
    onRowPressIn(["id": id])
  }

  public func collectionView(_ collectionView: UICollectionView, contextMenuConfigurationForItemAt indexPath: IndexPath, point: CGPoint) -> UIContextMenuConfiguration? {
    guard menuEnabled, !selectionMode, !photoActive,
          let id = dataSource.itemIdentifier(for: indexPath),
          let row = rows[id] else { return nil }
    onPeekRequest(["id": id])
    let theme = self.theme
    return UIContextMenuConfiguration(identifier: id as NSString, previewProvider: { [weak self] in
      let vc = CLPeekController(row: row, theme: theme)
      if let p = self?.lastPeek, CLVal.str(p["id"]) == id { vc.update(p) }
      self?.peekController = vc
      return vc as UIViewController
    }, actionProvider: { [weak self] _ in
      return self?.buildMenu(id: id, row: row)
    })
  }

  public func collectionView(_ collectionView: UICollectionView, willPerformPreviewActionForMenuWith configuration: UIContextMenuConfiguration, animator: UIContextMenuInteractionCommitAnimating) {
    guard let id = configuration.identifier as? NSString else { return }
    let sid = id as String
    animator.preferredCommitStyle = .dismiss
    animator.addCompletion { [weak self] in
      self?.onPeekOpen(["id": sid])
    }
  }

  // MARK: - UIScrollViewDelegate

  public func scrollViewDidScroll(_ scrollView: UIScrollView) {
    let rel = scrollView.contentOffset.y + scrollView.contentInset.top
    let c = rel > collapseOffset
    if c != collapsed {
      collapsed = c
      onCollapsedChange(["collapsed": c])
    }
    let h = scrollView.contentSize.height
    if h > 0 && (scrollView.isDragging || scrollView.isDecelerating) {
      let visibleBottom = scrollView.contentOffset.y + scrollView.bounds.height
      if visibleBottom > h - scrollView.bounds.height && endReachedFor != h {
        endReachedFor = h
        onEndReached(["contentHeight": Double(h)])
      }
    }
  }
}
