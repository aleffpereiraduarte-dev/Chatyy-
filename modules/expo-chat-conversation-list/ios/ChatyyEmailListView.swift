import ExpoModulesCore
import UIKit

// [2026-10-15 native-inbox] Caixa de entrada do e-mail em NATIVO: mesma base
// da home (UICollectionView com lista compositional + diffable data source),
// swipe nativo (arquivar/adiar ← → excluir), seleção múltipla, UIContextMenu
// com prévia do e-mail, UIRefreshControl e paginação (onEndReached + spinner
// no rodapé). Cabeçalho/barra de seleção/estado vazio continuam em JS, FORA
// desta view (components/EmailList.js).
//
// Props:  rowsPatch, dark, palette, density, labels, selectionMode, authToken,
//         peek {id, body}, swipeEnabled, menuEnabled, refreshing, loadingMore,
//         bottomInset, scrollToTopSeq
// Events: onRowPress, onLeftPress, onStarPress, onRowAction {id, action, source},
//         onLongPress, onPeekRequest, onPeekOpen, onRefresh, onEndReached,
//         onVisibleIds {ids}, onResync, onFirstPaint, onNativeError
public final class ChatyyEmailListView: ExpoView, UICollectionViewDelegate {
  let onRowPress = EventDispatcher()
  let onLeftPress = EventDispatcher()
  let onStarPress = EventDispatcher()
  let onRowAction = EventDispatcher()
  let onLongPress = EventDispatcher()
  let onPeekRequest = EventDispatcher()
  let onPeekOpen = EventDispatcher()
  let onRefresh = EventDispatcher()
  let onEndReached = EventDispatcher()
  let onVisibleIds = EventDispatcher()
  let onResync = EventDispatcher()
  let onFirstPaint = EventDispatcher()
  let onNativeError = EventDispatcher()

  private var collectionView: UICollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<Int, String>!
  private let refreshControl = UIRefreshControl()
  private let footerSpinner = UIActivityIndicatorView(style: .medium)

  private var rows: [String: ELRow] = [:]
  private var order: [String] = []
  private var seq: Double = 0
  private var pendingReset = false
  private var pendingDirty = Set<String>()
  private var needsApply = false
  private var appliedOnce = false
  private var firstPaintSent = false
  private var resyncAskedFor: Double = -1

  private var dark = false
  private var paletteDict: [String: Any]?
  private var palette = ELPalette(dark: false)
  private var paletteDirty = true
  private var density = ELDensity()
  private var densityDirty = false
  private var labels = CLLabels()
  private var labelsDirty = false
  private var selectionMode = false
  private var selectionDirty = false
  var swipeEnabled = true
  var menuEnabled = true
  private var refreshing = false
  private var loadingMore = false
  private var bottomInset: CGFloat = 0
  private var scrollTopSeq: Double = 0
  private var endReachedFor: CGFloat = -1

  private weak var peekController: ELPeekController?
  private var lastPeek: [String: Any]?

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
    cv.delegate = self
    cv.backgroundColor = palette.bg
    refreshControl.addTarget(self, action: #selector(didPullRefresh), for: .valueChanged)
    cv.refreshControl = refreshControl
    footerSpinner.hidesWhenStopped = true
    cv.addSubview(footerSpinner)
    addSubview(cv)
    collectionView = cv

    let emailReg = UICollectionView.CellRegistration<ELEmailCell, String> { [weak self] cell, _, id in
      self?.bindEmail(cell, id: id)
    }
    let sectionReg = UICollectionView.CellRegistration<ELSectionCell, String> { [weak self] cell, _, id in
      guard let self = self, let row = self.rows[id] else { return }
      cell.configure(row, palette: self.palette, padH: self.density.padH)
    }
    dataSource = UICollectionViewDiffableDataSource<Int, String>(collectionView: cv) { [weak self] collectionView, indexPath, id in
      if let r = self?.rows[id], r.isSection {
        return collectionView.dequeueConfiguredReusableCell(using: sectionReg, for: indexPath, item: id)
      }
      return collectionView.dequeueConfiguredReusableCell(using: emailReg, for: indexPath, item: id)
    }
  }

  private func bindEmail(_ cell: ELEmailCell, id: String) {
    guard let row = rows[id] else { return }
    cell.configure(row, palette: palette, density: density, labels: labels, selectionMode: selectionMode)
    cell.onLeftTap = { [weak self] rid in
      UISelectionFeedbackGenerator().selectionChanged()
      self?.onLeftPress(["id": rid])
    }
    cell.onStarTap = { [weak self] rid in
      self?.onStarPress(["id": rid])
    }
    cell.onA11yAction = { [weak self] rid, action in
      self?.onRowAction(["id": rid, "action": action, "source": "a11y"])
    }
  }

  private func makeLayout() -> UICollectionViewLayout {
    var cfg = UICollectionLayoutListConfiguration(appearance: .plain)
    cfg.backgroundColor = palette.bg
    cfg.showsSeparators = true
    var sep = UIListSeparatorConfiguration(listAppearance: .plain)
    sep.color = palette.hair
    sep.topSeparatorVisibility = .hidden
    sep.bottomSeparatorInsets = .zero
    cfg.separatorConfiguration = sep
    cfg.itemSeparatorHandler = { [weak self] indexPath, base in
      var c = base
      if let self = self, let id = self.dataSource?.itemIdentifier(for: indexPath), self.rows[id]?.isSection == true {
        c.bottomSeparatorVisibility = .hidden
      }
      return c
    }
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
      if pseq == seq && appliedOnce { return }
      var next: [String: ELRow] = [:]
      var ids: [String] = []
      for item in reset {
        guard let d = item as? [String: Any] else { continue }
        let r = ELRow(d)
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
        let r = ELRow(d)
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

  func setDark(_ v: Bool) {
    if v == dark && !paletteDirty { return }
    dark = v
    paletteDirty = true
  }

  func setPalette(_ d: [String: Any]?) {
    paletteDict = d
    paletteDirty = true
  }

  func setDensity(_ d: [String: Any]?) {
    density = ELDensity(d)
    densityDirty = true
  }

  func setLabels(_ d: [String: Any]?) {
    labels = CLLabels(d)
    labelsDirty = true
  }

  func setSelectionMode(_ on: Bool) {
    if on == selectionMode { return }
    selectionMode = on
    selectionDirty = true
  }

  func setPeek(_ d: [String: Any]?) {
    lastPeek = d
    if let d = d { peekController?.update(d) }
  }

  func setRefreshing(_ on: Bool) {
    refreshing = on
    if !on && refreshControl.isRefreshing { refreshControl.endRefreshing() }
  }

  func setLoadingMore(_ on: Bool) {
    if on == loadingMore { return }
    loadingMore = on
    if on { footerSpinner.startAnimating() } else { footerSpinner.stopAnimating() }
    refreshInsets()
  }

  func setBottomInset(_ b: CGFloat) {
    bottomInset = max(0, b)
  }

  func setScrollToTopSeq(_ s: Double) {
    if s <= scrollTopSeq { scrollTopSeq = max(scrollTopSeq, s); return }
    let first = scrollTopSeq == 0
    scrollTopSeq = s
    if first && !appliedOnce { return }
    collectionView.setContentOffset(CGPoint(x: 0, y: -collectionView.adjustedContentInset.top), animated: true)
  }

  func commitProps() {
    var reconfigureAll = false
    if paletteDirty || selectionDirty {
      palette = ELPalette(dark: dark, paletteDict)
      backgroundColor = palette.bg
      collectionView.backgroundColor = palette.bg
      collectionView.indicatorStyle = palette.dark ? .white : .black
      refreshControl.tintColor = palette.sub
      footerSpinner.color = palette.sub
      collectionView.setCollectionViewLayout(makeLayout(), animated: false)
      reconfigureAll = appliedOnce
      paletteDirty = false
      selectionDirty = false
    }
    if labelsDirty || densityDirty {
      labelsDirty = false
      densityDirty = false
      reconfigureAll = reconfigureAll || appliedOnce
    }
    applySnapshot(reconfigureAll: reconfigureAll)
    refreshInsets()
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
    snap.appendSections([0])
    snap.appendItems(ids, toSection: 0)
    let reconf: [String]
    if reconfigureAll || pendingReset {
      reconf = ids.filter { oldIds.contains($0) }
    } else {
      reconf = pendingDirty.filter { seen.contains($0) && oldIds.contains($0) }
    }
    pendingDirty.removeAll()
    // Linha mudou de altura (rótulo/prévia/chip) → reconfigure + relayout.
    if !reconf.isEmpty { snap.reconfigureItems(reconf) }
    let animate = appliedOnce && !pendingReset && !reconfigureAll && window != nil
    pendingReset = false
    appliedOnce = true
    dataSource.apply(snap, animatingDifferences: animate) { [weak self] in
      self?.afterApply()
    }
  }

  private func afterApply() {
    layoutFooter()
    if !firstPaintSent {
      firstPaintSent = true
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        self.onFirstPaint(["count": self.order.count])
        self.emitVisible()
      }
    }
  }

  private func refreshInsets() {
    guard let cv = collectionView else { return }
    let foot: CGFloat = loadingMore ? 56 : 0
    let insets = UIEdgeInsets(top: 0, left: 0, bottom: bottomInset + foot, right: 0)
    if cv.contentInset != insets {
      cv.contentInset = insets
      cv.verticalScrollIndicatorInsets = UIEdgeInsets(top: 0, left: 0, bottom: bottomInset, right: 0)
    }
    layoutFooter()
  }

  private func layoutFooter() {
    guard let cv = collectionView else { return }
    footerSpinner.center = CGPoint(x: cv.bounds.width / 2, y: cv.contentSize.height + 28)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    if collectionView.frame != bounds { collectionView.frame = bounds }
    layoutFooter()
  }

  // MARK: - Ações

  @objc private func didPullRefresh() {
    UISelectionFeedbackGenerator().selectionChanged()
    onRefresh([:])
    // Rede lenta: se o JS não responder com refreshing=false, solta sozinho.
    DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self] in
      guard let self = self, self.refreshControl.isRefreshing, !self.refreshing else { return }
      self.refreshControl.endRefreshing()
    }
  }

  private func contextual(_ id: String, _ action: String, title: String, symbol: String, color: UInt32) -> UIContextualAction {
    let a = UIContextualAction(style: .normal, title: title) { [weak self] _, _, done in
      UIImpactFeedbackGenerator(style: .medium).impactOccurred()
      self?.onRowAction(["id": id, "action": action, "source": "swipe"])
      done(true)
    }
    a.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .medium))?
      .withTintColor(.white, renderingMode: .alwaysOriginal)
    a.backgroundColor = UIColor(clHex: color)
    return a
  }

  private func swipeConfiguration(_ indexPath: IndexPath, leading: Bool) -> UISwipeActionsConfiguration? {
    guard swipeEnabled, !selectionMode,
          let id = dataSource.itemIdentifier(for: indexPath),
          let row = rows[id], !row.isSection else { return nil }
    let L = labels
    var actions: [UIContextualAction] = []
    if leading {
      // [2026-10-16 polish] Mesmas cores da lista de chat (SWIPE_C): cinzas + vermelho só no destrutivo.
      actions.append(contextual(id, "archive", title: L.get("archive", "Arquivar"), symbol: "archivebox", color: 0x3A3A3C))
      actions.append(contextual(id, "snooze", title: L.get("snooze", "Adiar"), symbol: "clock", color: 0x636366))
    } else {
      actions.append(contextual(id, "delete", title: L.get("delete", "Excluir"), symbol: "trash", color: 0xFF3B30))
    }
    let cfg = UISwipeActionsConfiguration(actions: actions)
    cfg.performsFirstActionWithFullSwipe = true
    return cfg
  }

  private func menuAction(_ id: String, _ action: String, _ title: String, _ symbol: String, destructive: Bool = false) -> UIAction {
    let a = UIAction(title: title, image: UIImage(systemName: symbol)) { [weak self] _ in
      self?.onRowAction(["id": id, "action": action, "source": "menu"])
    }
    if destructive { a.attributes = .destructive }
    return a
  }

  /// Mesmas ações/ordem do components/emailMenuItems.js (buildEmailNativeMenuActions).
  private func buildMenu(id: String, row: ELRow) -> UIMenu {
    let L = labels
    let read = !row.unread
    let quick = UIMenu(title: "", options: .displayInline, children: [
      menuAction(id, "reply", L.get("reply", "Responder"), "arrowshape.turn.up.left"),
      menuAction(id, "replyAll", L.get("replyAll", "Responder a todos"), "arrowshape.turn.up.left.2"),
      menuAction(id, "forward", L.get("forward", "Encaminhar"), "arrowshape.turn.up.right"),
    ])
    let state = UIMenu(title: "", options: .displayInline, children: [
      menuAction(id, read ? "markUnread" : "markRead",
                 read ? L.get("markUnread", "Marcar como não lido") : L.get("markRead", "Marcar como lido"),
                 read ? "envelope.badge" : "envelope.open"),
      menuAction(id, "star", row.starred ? L.get("unstar", "Remover estrela") : L.get("star", "Adicionar estrela"),
                 row.starred ? "star.slash" : "star"),
      menuAction(id, "snooze", L.get("snooze", "Adiar"), "clock"),
      menuAction(id, "mute", row.muted ? L.get("unmute", "Reativar") : L.get("mute", "Silenciar"),
                 row.muted ? "bell" : "bell.slash"),
    ])
    let move = UIMenu(title: "", options: .displayInline, children: [
      menuAction(id, "moveTo", L.get("moveTo", "Mover para"), "folder"),
      menuAction(id, "archive", L.get("archive", "Arquivar"), "archivebox"),
      menuAction(id, "select", L.get("select", "Selecionar"), "checkmark.circle"),
    ])
    let danger = UIMenu(title: "", options: .displayInline, children: [
      menuAction(id, "spam", L.get("spam", "Spam"), "exclamationmark.octagon", destructive: true),
      menuAction(id, "delete", L.get("delete", "Excluir"), "trash", destructive: true),
    ])
    return UIMenu(title: "", children: [quick, state, move, danger])
  }

  private func emitVisible() {
    guard let cv = collectionView else { return }
    var ids: [String] = []
    for ip in cv.indexPathsForVisibleItems.sorted() {
      guard let id = dataSource.itemIdentifier(for: ip), let r = rows[id], !r.isSection else { continue }
      ids.append(id)
    }
    if !ids.isEmpty { onVisibleIds(["ids": ids]) }
  }

  // MARK: - UICollectionViewDelegate

  public func collectionView(_ collectionView: UICollectionView, shouldHighlightItemAt indexPath: IndexPath) -> Bool {
    guard let id = dataSource.itemIdentifier(for: indexPath) else { return false }
    return rows[id]?.isSection != true
  }

  public func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: true)
    guard let id = dataSource.itemIdentifier(for: indexPath), let r = rows[id], !r.isSection else { return }
    if !selectionMode { UISelectionFeedbackGenerator().selectionChanged() }
    onRowPress(["id": id])
  }

  public func collectionView(_ collectionView: UICollectionView, contextMenuConfigurationForItemAt indexPath: IndexPath, point: CGPoint) -> UIContextMenuConfiguration? {
    guard let id = dataSource.itemIdentifier(for: indexPath), let row = rows[id], !row.isSection else { return nil }
    if selectionMode || !menuEnabled {
      onLongPress(["id": id])
      return nil
    }
    onPeekRequest(["id": id])
    let palette = self.palette
    return UIContextMenuConfiguration(identifier: id as NSString, previewProvider: { [weak self] in
      let vc = ELPeekController(row: row, palette: palette)
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
    let h = scrollView.contentSize.height
    if h > 0 && (scrollView.isDragging || scrollView.isDecelerating) {
      let visibleBottom = scrollView.contentOffset.y + scrollView.bounds.height
      // ~0.4 tela antes do fim (onEndReachedThreshold do FlatList).
      if visibleBottom > h - scrollView.bounds.height * 0.4 && endReachedFor != h {
        endReachedFor = h
        onEndReached(["contentHeight": Double(h)])
      }
    }
  }

  public func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
    emitVisible()
  }

  public func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    if !decelerate { emitVisible() }
  }
}
