import ExpoModulesCore
import UIKit

// [2026-10-15 native-social] Núcleo comum das views da aba CANAIS
// (ChatyyChannelListView / ChatyyChannelFeedView): UICollectionView lista
// compositional + diffable, patches por id com seq/base + onResync (mesmo
// contrato da home/Status), filhos RN como header (0) e rodapé (1) no espaço
// de conteúdo, pull-to-refresh nativo e onEndReached. As views só guardam os
// EventDispatcher (o Expo os descobre por reflexão na própria classe) e
// encaminham via `emit`.
final class CHListCore: NSObject, UICollectionViewDelegate, CHCellHost {
  let emit: (String, [String: Any]) -> Void

  private(set) var collectionView: CLCollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<Int, String>!
  private let refresh = UIRefreshControl()

  private var rows: [String: CHRow] = [:]
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
  private(set) var palette = CHPalette(dark: false)
  private var paletteDirty = true
  private var labels = CLLabels()
  private var labelsDirty = false
  var quick: [String] = [] { didSet { if quick != oldValue { quickDirty = true } } }
  private var quickDirty = false

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
  private var endReachedSentFor = -1

  init(emit: @escaping (String, [String: Any]) -> Void) {
    self.emit = emit
    super.init()
    setup()
  }

  private func setup() {
    var cfg = UICollectionLayoutListConfiguration(appearance: .plain)
    cfg.backgroundColor = .clear
    cfg.showsSeparators = false
    let layout = UICollectionViewCompositionalLayout.list(using: cfg)
    let cv = CLCollectionView(frame: .zero, collectionViewLayout: layout)
    cv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    cv.contentInsetAdjustmentBehavior = .never
    cv.alwaysBounceVertical = true
    cv.showsVerticalScrollIndicator = false
    cv.keyboardDismissMode = .onDrag
    cv.delegate = self
    cv.backgroundColor = palette.bg
    cv.addSubview(headerHost)
    cv.addSubview(footerHost)
    cv.onLayout = { [weak self] in self?.layoutHosts() }
    refresh.addTarget(self, action: #selector(didPullRefresh), for: .valueChanged)
    cv.refreshControl = refresh
    collectionView = cv

    let rowReg = UICollectionView.CellRegistration<CHChannelRowCell, String> { [weak self] cell, _, id in
      guard let self = self, let row = self.rows[id] else { return }
      cell.host = self
      cell.configure(row, palette: self.palette)
    }
    let cardReg = UICollectionView.CellRegistration<CHChannelCardCell, String> { [weak self] cell, _, id in
      guard let self = self, let row = self.rows[id] else { return }
      cell.host = self
      cell.configure(row, palette: self.palette, labels: self.labels)
    }
    let postReg = UICollectionView.CellRegistration<CHPostCell, String> { [weak self] cell, _, id in
      guard let self = self, let row = self.rows[id] else { return }
      cell.host = self
      cell.configure(row, palette: self.palette, quick: self.quick)
    }
    dataSource = UICollectionViewDiffableDataSource<Int, String>(collectionView: cv) { [weak self] collectionView, indexPath, id in
      switch self?.rows[id]?.kind ?? "row" {
      case "card":
        return collectionView.dequeueConfiguredReusableCell(using: cardReg, for: indexPath, item: id)
      case "post":
        return collectionView.dequeueConfiguredReusableCell(using: postReg, for: indexPath, item: id)
      default:
        return collectionView.dequeueConfiguredReusableCell(using: rowReg, for: indexPath, item: id)
      }
    }
  }

  // MARK: - Props

  func setRowsPatch(_ patch: [String: Any]?) {
    guard let p = patch else { return }
    let pseq = CLVal.double(p["seq"])
    if let reset = p["reset"] as? [Any] {
      if pseq == seq && appliedOnce { return }
      var next: [String: CHRow] = [:]
      var ids: [String] = []
      for item in reset {
        guard let d = item as? [String: Any] else { continue }
        let r = CHRow(d)
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
      endReachedSentFor = -1
      return
    }
    if pseq <= seq { return }
    let base = CLVal.double(p["base"])
    if base != seq {
      if resyncAskedFor != seq {
        resyncAskedFor = seq
        emit("onResync", ["seq": seq])
      }
      return
    }
    if let rm = p["remove"] as? [Any] {
      for x in rm { rows.removeValue(forKey: CLVal.str(x)) }
    }
    if let ups = p["upsert"] as? [Any] {
      for item in ups {
        guard let d = item as? [String: Any] else { continue }
        let r = CHRow(d)
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
    if !on && refresh.isRefreshing { refresh.endRefreshing() }
  }

  func setRefreshTint(_ hex: String) {
    if let c = SLColor.parse(hex) { refresh.tintColor = c }
  }

  func commitProps(owner: UIView) {
    var reconfigureAll = false
    if paletteDirty {
      palette = CHPalette(dark: dark, dict: paletteDict)
      owner.backgroundColor = palette.bg
      collectionView.backgroundColor = palette.bg
      collectionView.indicatorStyle = dark ? .white : .black
      reconfigureAll = appliedOnce
      paletteDirty = false
    }
    if labelsDirty || quickDirty {
      reconfigureAll = reconfigureAll || appliedOnce
      labelsDirty = false
      quickDirty = false
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
    if rows.count > ids.count {
      for k in Array(rows.keys) where !seen.contains(k) { rows.removeValue(forKey: k) }
    }
    let oldIds = Set(dataSource.snapshot().itemIdentifiers)
    var snap = NSDiffableDataSourceSnapshot<Int, String>()
    snap.appendSections([0])
    snap.appendItems(ids, toSection: 0)
    // ids têm prefixo por tipo (ch:/dc:/p:) → reconfigure (mesma célula) é
    // seguro; a lista compositional remede a altura da célula reconfigurada.
    let reconf: [String]
    if reconfigureAll || pendingReset {
      reconf = ids.filter { oldIds.contains($0) }
    } else {
      reconf = pendingDirty.filter { seen.contains($0) && oldIds.contains($0) }
    }
    pendingDirty.removeAll()
    if !reconf.isEmpty { snap.reconfigureItems(reconf) }
    let animate = appliedOnce && !pendingReset && !reconfigureAll && collectionView.window != nil
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
        self?.emit("onFirstPaint", ["count": self?.order.count ?? 0])
      }
    }
  }

  // MARK: - Filhos RN

  func mountChild(_ child: UIView, index: Int) {
    let i = max(0, min(index, rnChildren.count))
    rnChildren.insert(child, at: i)
    reattachChildren()
  }

  func unmountChild(_ child: UIView) {
    child.removeFromSuperview()
    rnChildren.removeAll { $0 === child }
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

  func refreshInsets() {
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

  func layoutHosts() {
    guard let cv = collectionView else { return }
    let w = cv.bounds.width
    let hf = CGRect(x: 0, y: -headerH, width: w, height: headerH)
    if headerHost.frame != hf { headerHost.frame = hf }
    let ff = CGRect(x: 0, y: cv.contentSize.height, width: w, height: footerH)
    if footerHost.frame != ff { footerHost.frame = ff }
  }

  // MARK: - Ações

  @objc private func didPullRefresh() {
    UISelectionFeedbackGenerator().selectionChanged()
    emit("onRefresh", [:])
    DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
      guard let self = self, self.refresh.isRefreshing else { return }
      self.refresh.endRefreshing()
    }
  }

  func chAction(_ id: String, _ action: String, _ extra: [String: Any]) {
    var payload = extra
    payload["id"] = id
    payload["action"] = action
    emit("onRowAction", payload)
  }

  // MARK: - UICollectionViewDelegate

  func collectionView(_ collectionView: UICollectionView, shouldHighlightItemAt indexPath: IndexPath) -> Bool {
    guard let id = dataSource.itemIdentifier(for: indexPath), let row = rows[id] else { return false }
    return row.kind != "post"
  }

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: true)
    guard let id = dataSource.itemIdentifier(for: indexPath), rows[id] != nil else { return }
    UISelectionFeedbackGenerator().selectionChanged()
    emit("onRowPress", ["id": id])
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    let remaining = scrollView.contentSize.height - (scrollView.contentOffset.y + scrollView.bounds.height)
    if order.count > 0 && remaining < scrollView.bounds.height * 0.6 && endReachedSentFor != order.count {
      endReachedSentFor = order.count
      emit("onEndReached", ["count": order.count])
    }
  }
}
