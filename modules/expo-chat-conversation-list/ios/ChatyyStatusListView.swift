import ExpoModulesCore
import UIKit

// [2026-10-15 native-lists] View da aba STATUS (contrato em
// ChatyyStatusListModule.swift). Mesmo esqueleto da lista da home
// (ChatyyConversationListView): patches por id com seq/base + onResync,
// diffable data source, filhos RN como header/rodapé no espaço de conteúdo.
public final class ChatyyStatusListView: ExpoView, UICollectionViewDelegate {
  let onRowPress = EventDispatcher()
  let onRowPressIn = EventDispatcher()
  let onRowAction = EventDispatcher()
  let onLongPress = EventDispatcher()
  let onPeekOpen = EventDispatcher()
  let onRefresh = EventDispatcher()
  let onCollapsedChange = EventDispatcher()
  let onResync = EventDispatcher()
  let onFirstPaint = EventDispatcher()
  let onNativeError = EventDispatcher()

  private var collectionView: CLCollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<Int, String>!
  private let refresh = UIRefreshControl()

  // Dados
  private var rows: [String: SLRow] = [:]
  private var order: [String] = []
  private var seq: Double = 0
  private var pendingReset = false
  private var pendingDirty = Set<String>()
  private var needsApply = false
  private var appliedOnce = false
  private var firstPaintSent = false
  private var resyncAskedFor: Double = -1

  // Aparência
  private var dark = false
  private var paletteDict: [String: Any]?
  private var palette = SLPalette(dark: false)
  private var paletteDirty = true
  private var labels = CLLabels()
  private var labelsDirty = false
  var authToken = ""
  var collapseOffset: CGFloat = 34
  private var collapsed = false
  private var refreshing = false

  // Header / rodapé RN
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
    cv.showsVerticalScrollIndicator = false
    cv.delegate = self
    cv.backgroundColor = palette.bg
    cv.addSubview(headerHost)
    cv.addSubview(footerHost)
    cv.onLayout = { [weak self] in self?.layoutHosts() }
    refresh.addTarget(self, action: #selector(didPullRefresh), for: .valueChanged)
    cv.refreshControl = refresh
    addSubview(cv)
    collectionView = cv

    let rowReg = UICollectionView.CellRegistration<SLStatusCell, String> { [weak self] cell, _, id in
      guard let self = self, let row = self.rows[id] else { return }
      cell.configure(row, palette: self.palette)
    }
    let secReg = UICollectionView.CellRegistration<SLSectionCell, String> { [weak self] cell, _, id in
      guard let self = self, let row = self.rows[id] else { return }
      cell.configure(row, palette: self.palette)
    }
    dataSource = UICollectionViewDiffableDataSource<Int, String>(collectionView: cv) { [weak self] collectionView, indexPath, id in
      if self?.rows[id]?.isSection == true {
        return collectionView.dequeueConfiguredReusableCell(using: secReg, for: indexPath, item: id)
      }
      return collectionView.dequeueConfiguredReusableCell(using: rowReg, for: indexPath, item: id)
    }
  }

  private func makeLayout() -> UICollectionViewLayout {
    var cfg = UICollectionLayoutListConfiguration(appearance: .plain)
    cfg.backgroundColor = .clear
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
      var next: [String: SLRow] = [:]
      var ids: [String] = []
      for item in reset {
        guard let d = item as? [String: Any] else { continue }
        let r = SLRow(d)
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
        let r = SLRow(d)
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

  func setDark(_ d: Bool) {
    if d == dark && !paletteDirty { return }
    dark = d
    paletteDirty = true
  }

  func setPalette(_ d: [String: Any]?) {
    paletteDict = d
    paletteDirty = true
  }

  func setLabels(_ d: [String: Any]?) {
    labels = CLLabels(d)
    labelsDirty = true
  }

  func setHeaderHeightHint(_ h: CGFloat) { headerHint = max(0, h) }
  func setFooterHeightHint(_ h: CGFloat) { footerHint = max(0, h) }
  func setBottomInset(_ b: CGFloat) { bottomInset = max(0, b) }

  func setRefreshing(_ on: Bool) {
    refreshing = on
    if !on && refresh.isRefreshing { refresh.endRefreshing() }
  }

  func setRefreshTint(_ hex: String) {
    if let c = SLColor.parse(hex) { refresh.tintColor = c }
  }

  func commitProps() {
    var reconfigureAll = false
    if paletteDirty {
      palette = SLPalette(dark: dark, dict: paletteDict)
      backgroundColor = palette.bg
      collectionView.backgroundColor = palette.bg
      collectionView.indicatorStyle = dark ? .white : .black
      reconfigureAll = appliedOnce
      paletteDirty = false
    }
    if labelsDirty {
      labelsDirty = false
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
    order = ids
    // Linhas fora do `order` não têm posição conhecida: descarta.
    if rows.count > ids.count {
      for k in Array(rows.keys) where !seen.contains(k) { rows.removeValue(forKey: k) }
    }
    let oldIds = Set(dataSource.snapshot().itemIdentifiers)
    var snap = NSDiffableDataSourceSnapshot<Int, String>()
    snap.appendSections([0])
    snap.appendItems(ids, toSection: 0)
    // Seção ↔ linha nunca trocam de id (prefixos sec:/st:/me:), então
    // reconfigure (mesmo tipo de célula) é seguro.
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

  // MARK: - Filhos RN

  public override func mountChildComponentView(_ childComponentView: UIView, index: Int) {
    let i = max(0, min(index, rnChildren.count))
    rnChildren.insert(childComponentView, at: i)
    reattachChildren()
  }

  public override func unmountChildComponentView(_ childComponentView: UIView, index: Int) {
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
      if !didInitialOffset || (atTop && !cv.isTracking && !cv.isDecelerating && !refresh.isRefreshing) {
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

  @objc private func didPullRefresh() {
    UISelectionFeedbackGenerator().selectionChanged()
    onRefresh([:])
    // Se o JS não ligar `refreshing`, não fica girando para sempre.
    DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
      guard let self = self, self.refresh.isRefreshing else { return }
      self.refresh.endRefreshing()
    }
  }

  private func emitAction(_ id: String, _ action: String, source: String) {
    onRowAction(["id": id, "action": action, "source": source])
  }

  private func swipeConfiguration(_ indexPath: IndexPath) -> UISwipeActionsConfiguration? {
    guard let id = dataSource.itemIdentifier(for: indexPath),
          let row = rows[id], !row.isSection, !row.mine else { return nil }
    let action = row.muted ? "unmute" : "mute"
    let title = row.muted ? labels.get("unmute", "Reativar") : labels.get("mute", "Silenciar")
    let a = UIContextualAction(style: .normal, title: title) { [weak self] _, _, done in
      UISelectionFeedbackGenerator().selectionChanged()
      self?.emitAction(id, action, source: "swipe")
      done(true)
    }
    a.image = UIImage(systemName: row.muted ? "bell" : "bell.slash",
                      withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .medium))?
      .withTintColor(.white, renderingMode: .alwaysOriginal)
    a.backgroundColor = UIColor(clHex: 0x3A3A3C)
    let cfg = UISwipeActionsConfiguration(actions: [a])
    cfg.performsFirstActionWithFullSwipe = true
    return cfg
  }

  private func buildMenu(id: String, row: SLRow) -> UIMenu {
    let L = labels
    func act(_ action: String, _ title: String, _ symbol: String, destructive: Bool = false, on: Bool = false) -> UIAction {
      let a = UIAction(title: title, image: UIImage(systemName: symbol),
                       attributes: destructive ? [.destructive] : []) { [weak self] _ in
        self?.emitAction(id, action, source: "menu")
      }
      if on { a.state = .on }
      return a
    }
    var top: [UIMenuElement] = [
      act("open", L.get("open", "Ver status"), "play.circle"),
      act("preview", L.get("preview", "Visualizar"), "eye"),
    ]
    if row.mine {
      return UIMenu(title: "", children: top)
    }
    top.append(row.muted
      ? act("unmute", L.get("unmute", "Reativar"), "bell")
      : act("mute", L.get("mute", "Silenciar"), "bell.slash"))
    top.append(act("notify", row.notify ? L.get("notifying", "Notificando") : L.get("notify", "Notificar"),
                   row.notify ? "bell.badge.fill" : "bell.badge", on: row.notify))
    top.append(act("share", L.get("share", "Compartilhar"), "square.and.arrow.up"))
    let danger = UIMenu(title: "", options: .displayInline, children: [
      act("report", L.get("report", "Reportar"), "flag", destructive: true),
    ])
    return UIMenu(title: "", children: top + [danger])
  }

  // MARK: - UICollectionViewDelegate

  public func collectionView(_ collectionView: UICollectionView, shouldHighlightItemAt indexPath: IndexPath) -> Bool {
    guard let id = dataSource.itemIdentifier(for: indexPath), let row = rows[id] else { return false }
    return !row.isSection || row.collapsible
  }

  public func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: true)
    guard let id = dataSource.itemIdentifier(for: indexPath), let row = rows[id] else { return }
    if row.isSection {
      if row.collapsible {
        UISelectionFeedbackGenerator().selectionChanged()
        onRowPress(["id": id])
      }
      return
    }
    onRowPress(["id": id])
  }

  public func collectionView(_ collectionView: UICollectionView, didHighlightItemAt indexPath: IndexPath) {
    guard let id = dataSource.itemIdentifier(for: indexPath), rows[id]?.isSection == false else { return }
    onRowPressIn(["id": id])
  }

  public func collectionView(_ collectionView: UICollectionView, contextMenuConfigurationForItemAt indexPath: IndexPath, point: CGPoint) -> UIContextMenuConfiguration? {
    guard let id = dataSource.itemIdentifier(for: indexPath),
          let row = rows[id], !row.isSection else { return nil }
    let palette = self.palette
    let token = authToken
    return UIContextMenuConfiguration(identifier: id as NSString, previewProvider: {
      return SLPeekController(row: row, palette: palette, authToken: token)
    }, actionProvider: { [weak self] _ in
      return self?.buildMenu(id: id, row: row)
    })
  }

  public func collectionView(_ collectionView: UICollectionView, previewForHighlightingContextMenuWithConfiguration configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
    return targetedCardPreview(configuration)
  }

  public func collectionView(_ collectionView: UICollectionView, previewForDismissingContextMenuWithConfiguration configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
    return targetedCardPreview(configuration)
  }

  /// Recorte do menu = o cartão (não a célula inteira com as margens).
  private func targetedCardPreview(_ configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
    guard let ns = configuration.identifier as? NSString,
          let ip = dataSource.indexPath(for: ns as String),
          let cell = collectionView.cellForItem(at: ip) as? SLStatusCell,
          cell.window != nil else { return nil }
    let params = UIPreviewParameters()
    params.visiblePath = UIBezierPath(roundedRect: cell.card.bounds, cornerRadius: 14)
    params.backgroundColor = .clear
    return UITargetedPreview(view: cell.card, parameters: params)
  }

  public func collectionView(_ collectionView: UICollectionView, willPerformPreviewActionForMenuWith configuration: UIContextMenuConfiguration, animator: UIContextMenuInteractionCommitAnimating) {
    guard let ns = configuration.identifier as? NSString else { return }
    let sid = ns as String
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
  }
}
