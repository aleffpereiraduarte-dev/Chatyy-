import ExpoModulesCore
import UIKit

// [2026-10-15 native-search-notifs] Lista de RESULTADOS nativa (iOS) — busca
// global (components/GlobalSearch.js, app/search.js) e central de notificações
// (app/notifications.js, components/NotificationsHub.js, app/notifications-feed.js).
// UICollectionView (lista compositional + diffable data source) com células de
// layout manual, destaque do termo em NSAttributedString (sem caixa/acento),
// swipe "Apagar" (só linhas com `sw`), UIRefreshControl, fim da lista e
// teclado fechando ao arrastar. Mesmo contrato do Android
// (ChatyyResultListView.kt). Patches por id (createPatcher do nativeAdapter).

public final class ChatyyResultListView: ExpoView, UICollectionViewDelegate {
  let onRowPress = EventDispatcher()
  let onRowAction = EventDispatcher()
  let onRefresh = EventDispatcher()
  let onEndReached = EventDispatcher()
  let onResync = EventDispatcher()
  let onFirstPaint = EventDispatcher()
  let onNativeError = EventDispatcher()

  private var collectionView: UICollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<Int, String>!

  // Dados
  private var rows: [String: RLRow] = [:]
  private var order: [String] = []
  private var seq: Double = 0
  private var pendingReset = false
  private var pendingDirty = Set<String>()
  private var needsApply = false
  private var appliedOnce = false
  private var firstPaintSent = false
  private var resyncAskedFor: Double = -1
  private var separatorIds = Set<String>()

  // Aparência / modos
  private var style = RLStyle()
  private var styleDirty = true
  private var highlightRaw = ""
  private var highlightDirty = false
  var swipeEnabled = true
  private var refreshEnabled = false
  private var refreshing = false
  private var refreshDirty = false
  private var refreshControl: UIRefreshControl?
  private var topInset: CGFloat = 0
  private var bottomInset: CGFloat = 0
  private var insetsDirty = true
  private var scrollTopSeq: Double = 0
  private var endReachedFor: CGFloat = -1
  private var autoInset = false
  private weak var hostVC: UIViewController?

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    setupCollection()
  }

  // MARK: - Setup

  private func setupCollection() {
    let cv = UICollectionView(frame: bounds, collectionViewLayout: makeLayout())
    cv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    cv.contentInsetAdjustmentBehavior = .never
    cv.alwaysBounceVertical = true
    cv.keyboardDismissMode = .onDrag
    cv.delegate = self
    cv.backgroundColor = style.colors.bg
    addSubview(cv)
    collectionView = cv

    let rowReg = UICollectionView.CellRegistration<RLRowCell, String> { [weak self] cell, _, id in
      guard let self = self, let row = self.rows[id] else { return }
      cell.configure(row, style: self.style, separator: self.separatorIds.contains(id))
      cell.onAction = { [weak self] rid, action in
        self?.onRowAction(["id": rid, "action": action, "source": "tap"])
      }
    }
    let secReg = UICollectionView.CellRegistration<RLSectionCell, String> { [weak self] cell, _, id in
      guard let self = self, let row = self.rows[id] else { return }
      cell.configure(row, style: self.style)
      cell.onAction = { [weak self] rid in
        self?.onRowAction(["id": rid, "action": "section", "source": "tap"])
      }
    }
    let loadReg = UICollectionView.CellRegistration<RLLoadingCell, String> { [weak self] cell, _, id in
      guard let self = self, let row = self.rows[id] else { return }
      cell.configure(row, style: self.style)
    }
    let noteReg = UICollectionView.CellRegistration<RLNoteCell, String> { [weak self] cell, _, id in
      guard let self = self, let row = self.rows[id] else { return }
      cell.configure(row, style: self.style)
    }
    dataSource = UICollectionViewDiffableDataSource<Int, String>(collectionView: cv) { [weak self] collectionView, indexPath, id in
      switch self?.rows[id]?.kind ?? "r" {
      case "s": return collectionView.dequeueConfiguredReusableCell(using: secReg, for: indexPath, item: id)
      case "l": return collectionView.dequeueConfiguredReusableCell(using: loadReg, for: indexPath, item: id)
      case "n": return collectionView.dequeueConfiguredReusableCell(using: noteReg, for: indexPath, item: id)
      default: return collectionView.dequeueConfiguredReusableCell(using: rowReg, for: indexPath, item: id)
      }
    }
  }

  private func makeLayout() -> UICollectionViewLayout {
    var cfg = UICollectionLayoutListConfiguration(appearance: .plain)
    cfg.backgroundColor = style.colors.bg
    cfg.showsSeparators = false
    cfg.trailingSwipeActionsConfigurationProvider = { [weak self] indexPath in
      return self?.swipeConfiguration(indexPath)
    }
    return UICollectionViewCompositionalLayout.list(using: cfg)
  }

  // MARK: - Props

  func setRowsPatch(_ patch: [String: Any]?) {
    guard let p = patch else { return }
    let pseq = CLVal.double(p["seq"])
    if let reset = p["reset"] as? [Any] {
      if pseq == seq && appliedOnce { return }
      var next: [String: RLRow] = [:]
      var ids: [String] = []
      for item in reset {
        guard let d = item as? [String: Any] else { continue }
        let r = RLRow(d)
        if r.id.isEmpty { continue }
        if next[r.id] == nil { ids.append(r.id) }
        next[r.id] = r
      }
      rows = next
      order = ids
      if let ord = p["order"] as? [Any] { order = ord.map { CLVal.str($0) } }
      seq = pseq
      pendingReset = true
      needsApply = true
      return
    }
    if pseq <= seq { return }
    let base = CLVal.double(p["base"])
    if base != seq {
      if resyncAskedFor != seq {
        resyncAskedFor = seq
        onResync(["seq": seq])
      }
      return
    }
    if let rm = p["remove"] as? [Any] {
      for x in rm { rows.removeValue(forKey: CLVal.str(x)) }
    }
    if let ups = p["upsert"] as? [Any] {
      for item in ups {
        guard let d = item as? [String: Any] else { continue }
        let r = RLRow(d)
        if r.id.isEmpty { continue }
        if rows[r.id] == nil && p["order"] == nil { order.append(r.id) }
        rows[r.id] = r
        pendingDirty.insert(r.id)
      }
    }
    if let ord = p["order"] as? [Any] { order = ord.map { CLVal.str($0) } }
    seq = pseq
    needsApply = true
  }

  func setColors(_ d: [String: Any]?) {
    style.colors = CTColors(d)
    if let u = CTColor.of(d?["unreadBg"]) {
      style.unreadBg = u
    } else {
      style.unreadBg = style.colors.dark ? UIColor(white: 1, alpha: 0.06) : UIColor(white: 0, alpha: 0.04)
    }
    styleDirty = true
  }

  func setHighlight(_ q: String) {
    if q == highlightRaw { return }
    highlightRaw = q
    highlightDirty = true
  }

  func setSeparators(_ on: Bool) {
    if on == style.separators { return }
    style.separators = on
    needsApply = true
  }

  func setRefreshEnabled(_ on: Bool) {
    if on == refreshEnabled { return }
    refreshEnabled = on
    refreshDirty = true
  }

  func setRefreshing(_ on: Bool) {
    refreshing = on
    refreshDirty = true
  }

  func setTopInset(_ v: CGFloat) {
    let n = max(0, v)
    if n == topInset { return }
    topInset = n
    insetsDirty = true
  }

  func setBottomInset(_ v: CGFloat) {
    let n = max(0, v)
    if n == bottomInset { return }
    bottomInset = n
    insetsDirty = true
  }

  /// Header nativo translúcido (título grande): o UIKit calcula o inset e o
  /// título colapsa acompanhando ESTA lista (igual à FlatList com
  /// contentInsetAdjustmentBehavior="automatic").
  func setAutoInset(_ on: Bool) {
    if on == autoInset { return }
    autoInset = on
    collectionView.contentInsetAdjustmentBehavior = on ? .automatic : .never
    syncContentScrollView()
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    syncContentScrollView()
  }

  private func syncContentScrollView() {
    if #available(iOS 15.0, *) {
      if window != nil && autoInset {
        if hostVC == nil, let vc = owningViewController() {
          hostVC = vc
          vc.setContentScrollView(collectionView, for: .top)
        }
      } else if let vc = hostVC {
        vc.setContentScrollView(nil, for: .top)
        hostVC = nil
      }
    }
  }

  private func owningViewController() -> UIViewController? {
    var r: UIResponder? = self
    while let cur = r {
      if let vc = cur as? UIViewController { return vc }
      r = cur.next
    }
    return nil
  }

  func setScrollToTopSeq(_ s: Double) {
    if s <= scrollTopSeq { scrollTopSeq = max(scrollTopSeq, s); return }
    let first = scrollTopSeq == 0
    scrollTopSeq = s
    if first && !appliedOnce { return }
    collectionView.setContentOffset(CGPoint(x: 0, y: -collectionView.adjustedContentInset.top), animated: false)
  }

  func commitProps() {
    var reconfigureAll = false
    if styleDirty {
      styleDirty = false
      backgroundColor = style.colors.bg
      collectionView.backgroundColor = style.colors.bg
      collectionView.indicatorStyle = style.colors.dark ? .white : .black
      collectionView.setCollectionViewLayout(makeLayout(), animated: false)
      refreshControl?.tintColor = style.colors.sub
      reconfigureAll = appliedOnce
    }
    if highlightDirty {
      highlightDirty = false
      style.tokens = RLHighlight.tokens(highlightRaw)
      reconfigureAll = reconfigureAll || appliedOnce
    }
    if refreshDirty {
      refreshDirty = false
      applyRefresh()
    }
    if insetsDirty {
      insetsDirty = false
      let cv = collectionView!
      let atTop = cv.contentOffset.y <= -cv.adjustedContentInset.top + 0.5
      cv.contentInset = UIEdgeInsets(top: topInset, left: 0, bottom: bottomInset, right: 0)
      if !autoInset {
        cv.verticalScrollIndicatorInsets = UIEdgeInsets(top: topInset, left: 0, bottom: bottomInset, right: 0)
      }
      if atTop && !cv.isTracking && !cv.isDecelerating && refreshControl?.isRefreshing != true {
        cv.contentOffset = CGPoint(x: 0, y: -cv.adjustedContentInset.top)
      }
    }
    applySnapshot(reconfigureAll: reconfigureAll)
  }

  private func applyRefresh() {
    if refreshEnabled {
      if refreshControl == nil {
        let rc = UIRefreshControl()
        rc.tintColor = style.colors.sub
        rc.addTarget(self, action: #selector(refreshPulled), for: .valueChanged)
        collectionView.refreshControl = rc
        refreshControl = rc
      }
      if !refreshing, refreshControl?.isRefreshing == true { refreshControl?.endRefreshing() }
    } else if refreshControl != nil {
      refreshControl?.endRefreshing()
      collectionView.refreshControl = nil
      refreshControl = nil
    }
  }

  @objc private func refreshPulled() {
    refreshing = true
    onRefresh([:])
    DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
      guard let self = self, self.refreshControl?.isRefreshing == true else { return }
      self.refreshing = false
      self.refreshControl?.endRefreshing()
    }
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
    if ids.count < rows.count {
      for id in rows.keys.sorted() where !seen.contains(id) {
        seen.insert(id)
        ids.append(id)
      }
    }
    order = ids

    // Separador: linha seguida de outra linha (não antes de seção/fim).
    var seps = Set<String>()
    if style.separators {
      for (i, id) in ids.enumerated() where i + 1 < ids.count {
        if rows[id]?.kind == "r" && rows[ids[i + 1]]?.kind == "r" { seps.insert(id) }
      }
    }
    let sepChanged = seps != separatorIds
    let oldSeps = separatorIds
    separatorIds = seps

    let oldIds = Set(dataSource.snapshot().itemIdentifiers)
    var snap = NSDiffableDataSourceSnapshot<Int, String>()
    snap.appendSections([0])
    snap.appendItems(ids, toSection: 0)
    var reconf = Set<String>()
    if reconfigureAll || pendingReset {
      for id in ids where oldIds.contains(id) { reconf.insert(id) }
    } else {
      for id in pendingDirty where seen.contains(id) && oldIds.contains(id) { reconf.insert(id) }
      if sepChanged {
        for id in seps.symmetricDifference(oldSeps) where seen.contains(id) && oldIds.contains(id) { reconf.insert(id) }
      }
    }
    pendingDirty.removeAll()
    // Linha que mudou de tipo (ex.: "carregando" → resultado) troca de célula: reload.
    var reload: [String] = []
    var reconfOnly: [String] = []
    for id in reconf {
      if let ip = dataSource.indexPath(for: id), let cell = collectionView.cellForItem(at: ip) {
        let k = rows[id]?.kind ?? "r"
        let ok: Bool
        switch k {
        case "s": ok = cell is RLSectionCell
        case "l": ok = cell is RLLoadingCell
        case "n": ok = cell is RLNoteCell
        default: ok = cell is RLRowCell
        }
        if !ok { reload.append(id); continue }
      }
      reconfOnly.append(id)
    }
    if !reconfOnly.isEmpty { snap.reconfigureItems(reconfOnly) }
    if !reload.isEmpty { snap.reloadItems(reload) }
    // Busca enquanto digita: sem animação (troca instantânea, sem "dança").
    let animate = appliedOnce && !pendingReset && !reconfigureAll && window != nil && ids.count < 120
    pendingReset = false
    appliedOnce = true
    dataSource.apply(snap, animatingDifferences: animate) { [weak self] in
      self?.afterApply()
    }
  }

  private func afterApply() {
    endReachedFor = -1
    if !firstPaintSent {
      firstPaintSent = true
      DispatchQueue.main.async { [weak self] in
        self?.onFirstPaint(["count": self?.order.count ?? 0])
      }
    }
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    if collectionView.frame != bounds { collectionView.frame = bounds }
  }

  // MARK: - Swipe (Apagar)

  private func swipeConfiguration(_ indexPath: IndexPath) -> UISwipeActionsConfiguration? {
    guard swipeEnabled,
          let id = dataSource.itemIdentifier(for: indexPath),
          let row = rows[id], row.kind == "r", !row.swipe.isEmpty else { return nil }
    let a = UIContextualAction(style: .normal, title: row.swipe) { [weak self] _, _, done in
      UISelectionFeedbackGenerator().selectionChanged()
      self?.onRowAction(["id": id, "action": "delete", "source": "swipe"])
      done(true)
    }
    a.image = UIImage(systemName: "trash", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .medium))?
      .withTintColor(.white, renderingMode: .alwaysOriginal)
    a.backgroundColor = style.colors.error
    let cfg = UISwipeActionsConfiguration(actions: [a])
    cfg.performsFirstActionWithFullSwipe = true
    return cfg
  }

  // MARK: - UICollectionViewDelegate

  private func tappable(_ indexPath: IndexPath) -> Bool {
    guard let id = dataSource.itemIdentifier(for: indexPath), let r = rows[id] else { return false }
    return (r.kind == "r" || r.kind == "n") && r.tap
  }

  public func collectionView(_ collectionView: UICollectionView, shouldHighlightItemAt indexPath: IndexPath) -> Bool {
    return tappable(indexPath)
  }

  public func collectionView(_ collectionView: UICollectionView, shouldSelectItemAt indexPath: IndexPath) -> Bool {
    return tappable(indexPath)
  }

  public func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: true)
    guard let id = dataSource.itemIdentifier(for: indexPath) else { return }
    onRowPress(["id": id])
  }

  // MARK: - UIScrollViewDelegate

  public func scrollViewDidScroll(_ scrollView: UIScrollView) {
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
