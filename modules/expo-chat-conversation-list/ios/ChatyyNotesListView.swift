import ExpoModulesCore
import UIKit

// [2026-10-15 native-notes] Lista/grade de NOTAS nativa (iOS) — app/notes.js
// via components/native/NativeNotesList.js. UICollectionView compositional:
// seções de lista (UICollectionLayoutListConfiguration → swipe Apagar/Fixar)
// ou grade de 2 colunas (3 em telas largas) com cards de altura fixa; menu de
// contexto com prévia do card no toque longo; UIRefreshControl. Patches por
// id (createPatcher do nativeAdapter). Mesmo contrato do Android
// (ChatyyNotesListView.kt). O nativo só desenha: ações voltam por id e a tela
// usa os handlers JS que já existem (desfazer, confirmação, API).
//
// Seções do snapshot: cada linha `s` vira uma seção de 1 item (largura toda) e
// as notas consecutivas formam uma seção (lista ou grade). Id da seção par =
// cabeçalho, ímpar = notas (o layout decide pelo id, sem estado paralelo).

public final class ChatyyNotesListView: ExpoView, UICollectionViewDelegate {
  let onRowPress = EventDispatcher()
  let onRowAction = EventDispatcher()
  let onRefresh = EventDispatcher()
  let onResync = EventDispatcher()
  let onFirstPaint = EventDispatcher()
  let onNativeError = EventDispatcher()

  private var collectionView: UICollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<Int, String>!

  // Dados
  private var rows: [String: NTRow] = [:]
  private var order: [String] = []
  private var seq: Double = 0
  private var pendingReset = false
  private var pendingDirty = Set<String>()
  private var needsApply = false
  private var appliedOnce = false
  private var firstPaintSent = false
  private var resyncAskedFor: Double = -1

  // Aparência / modos
  private var style = NTStyle()
  private var styleDirty = true
  private var layoutDirty = false
  private var highlightRaw = ""
  private var highlightDirty = false
  var swipeEnabled = true
  var menuEnabled = true
  private var menuItems: [NTMenuItem] = []
  private var labels: [String: String] = [:]
  private var refreshEnabled = false
  private var refreshing = false
  private var refreshDirty = false
  private var refreshControl: UIRefreshControl?
  private var topInset: CGFloat = 0
  private var bottomInset: CGFloat = 0
  private var insetsDirty = true
  private var scrollTopSeq: Double = 0
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

    let noteReg = UICollectionView.CellRegistration<NTNoteCell, String> { [weak self] cell, _, id in
      guard let self = self, let row = self.rows[id] else { return }
      cell.configure(row, style: self.style)
    }
    let secReg = UICollectionView.CellRegistration<NTSectionCell, String> { [weak self] cell, _, id in
      guard let self = self, let row = self.rows[id] else { return }
      cell.configure(row, style: self.style)
    }
    dataSource = UICollectionViewDiffableDataSource<Int, String>(collectionView: cv) { [weak self] collectionView, indexPath, id in
      if self?.rows[id]?.kind == "s" {
        return collectionView.dequeueConfiguredReusableCell(using: secReg, for: indexPath, item: id)
      }
      return collectionView.dequeueConfiguredReusableCell(using: noteReg, for: indexPath, item: id)
    }
  }

  private func makeLayout() -> UICollectionViewLayout {
    return UICollectionViewCompositionalLayout { [weak self] sectionIndex, env in
      guard let self = self else { return nil }
      var isHeader = false
      if let ds = self.dataSource, let sid = ds.sectionIdentifier(for: sectionIndex) {
        isHeader = sid % 2 == 0
      }
      let insets = NSDirectionalEdgeInsets(top: 0, leading: NTMetrics.outerH, bottom: 0, trailing: NTMetrics.outerH)
      if isHeader || !self.style.grid {
        var cfg = UICollectionLayoutListConfiguration(appearance: .plain)
        cfg.backgroundColor = .clear
        cfg.showsSeparators = false
        if !isHeader {
          cfg.trailingSwipeActionsConfigurationProvider = { [weak self] ip in self?.trailingSwipe(ip) }
          cfg.leadingSwipeActionsConfigurationProvider = { [weak self] ip in self?.leadingSwipe(ip) }
        }
        let sec = NSCollectionLayoutSection.list(using: cfg, layoutEnvironment: env)
        sec.contentInsets = insets
        return sec
      }
      let width = env.container.effectiveContentSize.width
      let cols = width >= 700 ? 3 : 2
      let item = NSCollectionLayoutItem(layoutSize: NSCollectionLayoutSize(
        widthDimension: .fractionalWidth(1.0 / CGFloat(cols)),
        heightDimension: .absolute(NTMetrics.gridHeight)))
      let group = NSCollectionLayoutGroup.horizontal(
        layoutSize: NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .absolute(NTMetrics.gridHeight)),
        subitems: [item])
      let sec = NSCollectionLayoutSection(group: group)
      sec.contentInsets = insets
      return sec
    }
  }

  // MARK: - Props

  func setRowsPatch(_ patch: [String: Any]?) {
    guard let p = patch else { return }
    let pseq = CLVal.double(p["seq"])
    if let reset = p["reset"] as? [Any] {
      if pseq == seq && appliedOnce { return }
      var next: [String: NTRow] = [:]
      var ids: [String] = []
      for item in reset {
        guard let d = item as? [String: Any] else { continue }
        let r = NTRow(d)
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
        let r = NTRow(d)
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
    style.card = CTColor.of(d?["card"]) ?? (style.colors.dark ? UIColor(clHex: 0x1C1C1E) : .white)
    style.cardBorder = CTColor.of(d?["cardBorder"])
      ?? (style.colors.dark ? UIColor(white: 1, alpha: 0.06) : UIColor(white: 0, alpha: 0.04))
    styleDirty = true
  }

  func setHighlight(_ q: String) {
    if q == highlightRaw { return }
    highlightRaw = q
    highlightDirty = true
  }

  func setLayoutMode(_ mode: String) {
    let grid = mode == "grid"
    if grid == style.grid { return }
    style.grid = grid
    layoutDirty = true
  }

  func setLabels(_ d: [String: Any]?) {
    var out: [String: String] = [:]
    for (k, v) in d ?? [:] { out[k] = CLVal.str(v) }
    labels = out
  }

  func setMenu(_ items: [[String: Any]]?) {
    menuItems = (items ?? []).map { NTMenuItem($0) }.filter { !$0.action.isEmpty && !$0.title.isEmpty }
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
    if styleDirty || layoutDirty {
      if styleDirty {
        backgroundColor = style.colors.bg
        collectionView.backgroundColor = style.colors.bg
        collectionView.indicatorStyle = style.colors.dark ? .white : .black
        refreshControl?.tintColor = style.colors.sub
      }
      styleDirty = false
      layoutDirty = false
      collectionView.setCollectionViewLayout(makeLayout(), animated: false)
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

    let oldIds = Set(dataSource.snapshot().itemIdentifiers)
    var snap = NSDiffableDataSourceSnapshot<Int, String>()
    var k = 0
    var openNotes = false
    for id in ids {
      if rows[id]?.kind == "s" {
        let sid = 2 * k
        k += 1
        snap.appendSections([sid])
        snap.appendItems([id], toSection: sid)
        openNotes = false
      } else {
        if !openNotes {
          let sid = 2 * k + 1
          k += 1
          snap.appendSections([sid])
          openNotes = true
        }
        snap.appendItems([id], toSection: snap.sectionIdentifiers.last ?? 1)
      }
    }
    var reconf: [String] = []
    if reconfigureAll || pendingReset {
      for id in ids where oldIds.contains(id) { reconf.append(id) }
    } else {
      for id in pendingDirty where seen.contains(id) && oldIds.contains(id) { reconf.append(id) }
    }
    pendingDirty.removeAll()
    // Nota ↔ seção nunca trocam de id (prefixos diferentes no adaptador); reconfigurar basta.
    if !reconf.isEmpty { snap.reconfigureItems(reconf) }
    let animate = appliedOnce && !pendingReset && !reconfigureAll && window != nil && ids.count < 200
    pendingReset = false
    appliedOnce = true
    dataSource.apply(snap, animatingDifferences: animate) { [weak self] in
      self?.afterApply()
    }
  }

  private func afterApply() {
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

  // MARK: - Swipe (Apagar / Fixar)

  private func noteRow(_ indexPath: IndexPath) -> (String, NTRow)? {
    guard let id = dataSource.itemIdentifier(for: indexPath), let row = rows[id], row.kind == "n" else { return nil }
    return (id, row)
  }

  private func trailingSwipe(_ indexPath: IndexPath) -> UISwipeActionsConfiguration? {
    guard swipeEnabled, let hit = noteRow(indexPath) else { return nil }
    let id = hit.0
    let a = UIContextualAction(style: .normal, title: labels["delete"] ?? "Apagar") { [weak self] _, _, done in
      UINotificationFeedbackGenerator().notificationOccurred(.warning)
      self?.onRowAction(["id": id, "action": "delete", "source": "swipe"])
      done(true)
    }
    a.image = CLSymbols.image("trash", pointSize: 17, weight: .medium, color: .white)
    a.backgroundColor = style.colors.error
    let cfg = UISwipeActionsConfiguration(actions: [a])
    cfg.performsFirstActionWithFullSwipe = true
    return cfg
  }

  private func leadingSwipe(_ indexPath: IndexPath) -> UISwipeActionsConfiguration? {
    guard swipeEnabled, let hit = noteRow(indexPath) else { return nil }
    let id = hit.0
    let row = hit.1
    let title = row.pinned ? (labels["unpin"] ?? "Desafixar") : (labels["pin"] ?? "Fixar")
    let a = UIContextualAction(style: .normal, title: title) { [weak self] _, _, done in
      UISelectionFeedbackGenerator().selectionChanged()
      self?.onRowAction(["id": id, "action": "pin", "source": "swipe"])
      done(true)
    }
    a.image = CLSymbols.image(row.pinned ? "pin.slash" : "pin", pointSize: 17, weight: .medium, color: style.colors.onPrimary)
    a.backgroundColor = style.colors.primary
    let cfg = UISwipeActionsConfiguration(actions: [a])
    cfg.performsFirstActionWithFullSwipe = true
    return cfg
  }

  // MARK: - Menu de contexto (toque longo)

  public func collectionView(_ collectionView: UICollectionView, contextMenuConfigurationForItemAt indexPath: IndexPath, point: CGPoint) -> UIContextMenuConfiguration? {
    guard menuEnabled, !menuItems.isEmpty, let hit = noteRow(indexPath) else { return nil }
    let id = hit.0
    let row = hit.1
    return UIContextMenuConfiguration(identifier: id as NSString, previewProvider: nil) { [weak self] _ in
      return self?.buildMenu(id, row)
    }
  }

  private func buildMenu(_ id: String, _ row: NTRow) -> UIMenu {
    var normal: [UIMenuElement] = []
    var destructive: [UIMenuElement] = []
    for item in menuItems {
      let sym = item.symbol
      let img = sym.isEmpty ? nil : UIImage(systemName: sym)
      let act = UIAction(title: item.titleFor(row), image: img, attributes: item.destructive ? .destructive : []) { [weak self] _ in
        self?.onRowAction(["id": id, "action": item.action, "source": "menu"])
      }
      if item.destructive { destructive.append(act) } else { normal.append(act) }
    }
    if !destructive.isEmpty {
      normal.append(UIMenu(title: "", options: .displayInline, children: destructive))
    }
    return UIMenu(title: "", children: normal)
  }

  private func targetedPreview(_ configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
    guard let id = configuration.identifier as? String,
          let ip = dataSource.indexPath(for: id),
          let cell = collectionView.cellForItem(at: ip) as? NTNoteCell else { return nil }
    let params = UIPreviewParameters()
    params.backgroundColor = .clear
    params.visiblePath = UIBezierPath(roundedRect: cell.cardView.bounds, cornerRadius: NTMetrics.radius)
    return UITargetedPreview(view: cell.cardView, parameters: params)
  }

  public func collectionView(_ collectionView: UICollectionView, previewForHighlightingContextMenuWithConfiguration configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
    return targetedPreview(configuration)
  }

  public func collectionView(_ collectionView: UICollectionView, previewForDismissingContextMenuWithConfiguration configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
    return targetedPreview(configuration)
  }

  // MARK: - UICollectionViewDelegate

  private func tappable(_ indexPath: IndexPath) -> Bool {
    guard let id = dataSource.itemIdentifier(for: indexPath), let r = rows[id] else { return false }
    return r.kind == "n"
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
}
