import UIKit

// [2026-10-15 native-social] Motor das listas de COMUNIDADES (iOS), usado
// por composição pelas views ChatyyCommunityList e ChatyyCommunityDetail
// (o ExpoModulesCore só acha EventDispatcher declarado na própria classe da
// view, então cada view é uma casca fina que repassa `emit`).
//
// Mesmo esqueleto das outras listas do pacote: patches por id com seq/base +
// onResync, diffable data source, filhos RN como header (y = -altura) e
// rodapé (após a última linha) no espaço de conteúdo, pull-to-refresh.
// Flow layout com alturas calculadas (CMMetrics.height) — sem self-sizing.
final class CMListCore: UIView, UICollectionViewDelegateFlowLayout {
  /// (nome do evento, payload)
  var emit: ((String, [String: Any]) -> Void)?

  private var collectionView: CLCollectionView!
  private var flow = UICollectionViewFlowLayout()
  private var dataSource: UICollectionViewDiffableDataSource<Int, String>!
  private let refresh = UIRefreshControl()

  private var rows: [String: CMRow] = [:]
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
  private(set) var palette = CMPalette(dark: false)
  private var paletteDirty = true
  private var refreshEnabled = true

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
  private var lastWidth: CGFloat = 0

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = true
    setup()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private func setup() {
    flow.scrollDirection = .vertical
    flow.minimumLineSpacing = 0
    flow.minimumInteritemSpacing = 0
    flow.sectionInset = .zero
    let cv = CLCollectionView(frame: bounds, collectionViewLayout: flow)
    cv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    cv.contentInsetAdjustmentBehavior = .never
    cv.alwaysBounceVertical = true
    cv.showsVerticalScrollIndicator = false
    cv.delaysContentTouches = false
    cv.delegate = self
    cv.backgroundColor = palette.bg
    cv.addSubview(headerHost)
    cv.addSubview(footerHost)
    cv.onLayout = { [weak self] in self?.layoutHosts() }
    refresh.addTarget(self, action: #selector(didPullRefresh), for: .valueChanged)
    cv.refreshControl = refresh
    addSubview(cv)
    collectionView = cv

    let lp = UILongPressGestureRecognizer(target: self, action: #selector(didLongPress(_:)))
    lp.minimumPressDuration = 0.45
    cv.addGestureRecognizer(lp)

    let reg = UICollectionView.CellRegistration<CMCell, String> { [weak self] cell, _, id in
      guard let self = self, let row = self.rows[id] else { return }
      cell.onAction = { [weak self] rid, action in
        self?.emit?("onRowAction", ["id": rid, "action": action])
      }
      cell.configure(row, palette: self.palette)
    }
    dataSource = UICollectionViewDiffableDataSource<Int, String>(collectionView: cv) { collectionView, indexPath, id in
      return collectionView.dequeueConfiguredReusableCell(using: reg, for: indexPath, item: id)
    }
  }

  // MARK: - Props

  func setRowsPatch(_ patch: [String: Any]?) {
    guard let p = patch else { return }
    let pseq = CLVal.double(p["seq"])
    if let reset = p["reset"] as? [Any] {
      if pseq == seq && appliedOnce { return }
      var next: [String: CMRow] = [:]
      var ids: [String] = []
      for item in reset {
        guard let d = item as? [String: Any] else { continue }
        let r = CMRow(d)
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
        emit?("onResync", ["seq": seq])
      }
      return
    }
    if let rm = p["remove"] as? [Any] {
      for x in rm { rows.removeValue(forKey: CLVal.str(x)) }
    }
    if let ups = p["upsert"] as? [Any] {
      for item in ups {
        guard let d = item as? [String: Any] else { continue }
        let r = CMRow(d)
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

  func setHeaderHeightHint(_ h: CGFloat) { headerHint = max(0, h) }
  func setFooterHeightHint(_ h: CGFloat) { footerHint = max(0, h) }
  func setBottomInset(_ b: CGFloat) { bottomInset = max(0, b) }

  func setRefreshing(_ on: Bool) {
    if !on && refresh.isRefreshing { refresh.endRefreshing() }
  }

  func setRefreshTint(_ hex: String) {
    if let c = SLColor.parse(hex) { refresh.tintColor = c }
  }

  func setRefreshEnabled(_ on: Bool) {
    if on == refreshEnabled { return }
    refreshEnabled = on
    collectionView.refreshControl = on ? refresh : nil
  }

  func commitProps() {
    var reconfigureAll = false
    if paletteDirty {
      palette = CMPalette(dark: dark, dict: paletteDict)
      backgroundColor = palette.bg
      collectionView.backgroundColor = palette.bg
      collectionView.indicatorStyle = dark ? .white : .black
      reconfigureAll = appliedOnce
      paletteDirty = false
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
    let reconf: [String]
    if reconfigureAll || pendingReset {
      reconf = ids.filter { oldIds.contains($0) }
    } else {
      reconf = pendingDirty.filter { seen.contains($0) && oldIds.contains($0) }
    }
    pendingDirty.removeAll()
    // Mesma célula p/ todos os tipos → reconfigure é sempre seguro.
    if !reconf.isEmpty { snap.reconfigureItems(reconf) }
    let animate = appliedOnce && !pendingReset && !reconfigureAll && window != nil
    pendingReset = false
    appliedOnce = true
    // Alturas podem ter mudado em linhas reconfiguradas.
    flow.invalidateLayout()
    dataSource.apply(snap, animatingDifferences: animate) { [weak self] in
      self?.afterApply()
    }
  }

  private func afterApply() {
    layoutHosts()
    if !firstPaintSent {
      firstPaintSent = true
      DispatchQueue.main.async { [weak self] in
        self?.emit?("onFirstPaint", ["count": self?.order.count ?? 0])
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

  override func layoutSubviews() {
    super.layoutSubviews()
    if collectionView.frame != bounds { collectionView.frame = bounds }
    if abs(bounds.width - lastWidth) > 0.5 {
      lastWidth = bounds.width
      flow.invalidateLayout()
    }
    layoutHosts()
  }

  // MARK: - Ações

  @objc private func didPullRefresh() {
    UISelectionFeedbackGenerator().selectionChanged()
    emit?("onRefresh", [:])
    DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
      guard let self = self, self.refresh.isRefreshing else { return }
      self.refresh.endRefreshing()
    }
  }

  @objc private func didLongPress(_ g: UILongPressGestureRecognizer) {
    guard g.state == .began else { return }
    let pt = g.location(in: collectionView)
    guard let ip = collectionView.indexPathForItem(at: pt),
          let id = dataSource.itemIdentifier(for: ip),
          let row = rows[id], row.longPress else { return }
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    emit?("onLongPress", ["id": id])
  }

  // MARK: - Delegate

  func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout, sizeForItemAt indexPath: IndexPath) -> CGSize {
    let w = collectionView.bounds.width
    guard let id = dataSource.itemIdentifier(for: indexPath), let row = rows[id] else {
      return CGSize(width: w, height: 1)
    }
    return CGSize(width: w, height: max(1, CMMetrics.height(row, width: w)))
  }

  func collectionView(_ collectionView: UICollectionView, shouldHighlightItemAt indexPath: IndexPath) -> Bool {
    guard let id = dataSource.itemIdentifier(for: indexPath), let row = rows[id] else { return false }
    return row.tap
  }

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: true)
    guard let id = dataSource.itemIdentifier(for: indexPath), let row = rows[id], row.tap else { return }
    if row.kind == "card" { UISelectionFeedbackGenerator().selectionChanged() }
    emit?("onRowPress", ["id": id])
  }
}
