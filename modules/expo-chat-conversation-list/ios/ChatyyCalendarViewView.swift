import ExpoModulesCore
import UIKit

// [2026-10-15 native-apps] CALENDÁRIO nativo (iOS): grade do mês + agenda.
// UICollectionView (lista compositional + diffable data source) com a grade
// (CAMonthGridView) e o filho RN (resumo do dia/avisos) num cabeçalho em
// y = -altura (mesmo esquema do header da home, CLChildHost); agenda do dia
// em células próprias, swipe Editar (esquerda) / Apagar (direita) só em linhas
// com `sw`, UIRefreshControl. Patches por id (createPatcher do nativeAdapter).
// Mesmo contrato do Android (ChatyyCalendarViewView.kt).

/// Cabeçalho: grade nativa em cima, filho RN logo abaixo.
final class CAHeaderContainer: UIView {
  let grid = CAMonthGridView()
  let host = CLChildHost()
  var showGrid = true

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    clipsToBounds = false
    addSubview(grid)
    addSubview(host)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  var gridHeight: CGFloat { showGrid ? grid.preferredHeight : 0 }
}

public final class ChatyyCalendarViewView: ExpoView, UICollectionViewDelegate {
  let onSelectDate = EventDispatcher()
  let onLongPressDate = EventDispatcher()
  let onMonthChange = EventDispatcher()
  let onRowPress = EventDispatcher()
  let onRowAction = EventDispatcher()
  let onRefresh = EventDispatcher()
  let onResync = EventDispatcher()
  let onFirstPaint = EventDispatcher()
  let onNativeError = EventDispatcher()

  private var collectionView: CLCollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<Int, String>!
  private let header = CAHeaderContainer()

  // Dados da agenda
  private var rows: [String: CARow] = [:]
  private var order: [String] = []
  private var seq: Double = 0
  private var pendingReset = false
  private var pendingDirty = Set<String>()
  private var needsApply = false
  private var appliedOnce = false
  private var firstPaintSent = false
  private var resyncAskedFor: Double = -1

  // Grade
  private var year = 2026
  private var month = 0
  private var firstWeekday = 0
  private var selected = ""
  private var today = ""
  private var marks: [String: CAMark] = [:]
  private var gridDirty = true

  // Aparência
  private var style = CAStyle()
  private var styleDirty = true
  private var labels = CALabels()
  private var refreshing = false
  private var refreshControl: UIRefreshControl?
  private var bottomInset: CGFloat = 0

  // Filho RN
  private var rnChildren: [UIView] = []
  private var boundsObservers: [NSKeyValueObservation] = []
  private var headerH: CGFloat = 0
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
    cv.keyboardDismissMode = .onDrag
    cv.delegate = self
    cv.backgroundColor = style.colors.bg
    cv.addSubview(header)
    cv.onLayout = { [weak self] in self?.layoutHeader() }
    addSubview(cv)
    collectionView = cv
    // Arrasto lateral na grade = troca de mês: o pan da lista (só vertical)
    // falha sozinho p/ movimento horizontal e o da grade falha p/ vertical.

    header.grid.onSelect = { [weak self] key in self?.onSelectDate(["date": key]) }
    header.grid.onLongPress = { [weak self] key in self?.onLongPressDate(["date": key]) }
    header.grid.onMonthSwipe = { [weak self] dir in self?.onMonthChange(["dir": dir]) }

    let rc = UIRefreshControl()
    rc.addTarget(self, action: #selector(refreshPulled), for: .valueChanged)
    cv.refreshControl = rc
    refreshControl = rc

    let eventReg = UICollectionView.CellRegistration<CAEventCell, String> { [weak self] cell, _, id in
      guard let self = self, let row = self.rows[id] else { return }
      cell.configure(row, style: self.style)
      cell.onAction = { [weak self] rid, action in
        self?.onRowAction(["id": rid, "action": action, "source": "tap"])
      }
    }
    let headReg = UICollectionView.CellRegistration<CAHeaderCell, String> { [weak self] cell, _, id in
      guard let self = self, let row = self.rows[id] else { return }
      cell.configure(row, style: self.style)
    }
    let emptyReg = UICollectionView.CellRegistration<CAEmptyCell, String> { [weak self] cell, _, id in
      guard let self = self, let row = self.rows[id] else { return }
      cell.configure(row, style: self.style)
      cell.onAction = { [weak self] rid, action in
        self?.onRowAction(["id": rid, "action": action, "source": "tap"])
      }
    }
    dataSource = UICollectionViewDiffableDataSource<Int, String>(collectionView: cv) { [weak self] collectionView, indexPath, id in
      switch self?.rows[id]?.kind ?? "e" {
      case "h": return collectionView.dequeueConfiguredReusableCell(using: headReg, for: indexPath, item: id)
      case "n": return collectionView.dequeueConfiguredReusableCell(using: emptyReg, for: indexPath, item: id)
      default: return collectionView.dequeueConfiguredReusableCell(using: eventReg, for: indexPath, item: id)
      }
    }
  }

  private func makeLayout() -> UICollectionViewLayout {
    var cfg = UICollectionLayoutListConfiguration(appearance: .plain)
    cfg.backgroundColor = style.colors.bg
    cfg.showsSeparators = false
    cfg.leadingSwipeActionsConfigurationProvider = { [weak self] ip in self?.swipeConfiguration(ip, leading: true) }
    cfg.trailingSwipeActionsConfigurationProvider = { [weak self] ip in self?.swipeConfiguration(ip, leading: false) }
    return UICollectionViewCompositionalLayout.list(using: cfg)
  }

  // MARK: - Props

  func setMonth(_ d: [String: Any]?) {
    guard let d = d else { return }
    let y = CLVal.int(d["y"])
    let m = max(0, min(11, CLVal.int(d["m"])))
    if y <= 0 { return }
    if y == year && m == month { return }
    year = y; month = m
    gridDirty = true
  }

  func setSelected(_ s: String) {
    if s == selected { return }
    selected = s
    gridDirty = true
  }

  func setToday(_ s: String) {
    if s == today { return }
    today = s
    gridDirty = true
  }

  func setFirstWeekday(_ v: Int) {
    let n = ((v % 7) + 7) % 7
    if n == firstWeekday { return }
    firstWeekday = n
    gridDirty = true
  }

  func setMarks(_ d: [String: Any]?) {
    var out: [String: CAMark] = [:]
    for (k, v) in d ?? [:] { out[k] = CAMark(v) }
    marks = out
    gridDirty = true
  }

  func setShowGrid(_ on: Bool) {
    if on == header.showGrid { return }
    header.showGrid = on
    header.grid.isHidden = !on
    gridDirty = true
  }

  func setColors(_ d: [String: Any]?) {
    style = CAStyle(d)
    styleDirty = true
    gridDirty = true
  }

  func setLabels(_ d: [String: Any]?) {
    labels = CALabels(d)
    gridDirty = true
  }

  func setRefreshing(_ on: Bool) {
    refreshing = on
    if !on, refreshControl?.isRefreshing == true { refreshControl?.endRefreshing() }
  }

  func setBottomInset(_ v: CGFloat) {
    let n = max(0, v)
    if n == bottomInset { return }
    bottomInset = n
    refreshInsets()
  }

  func setRowsPatch(_ patch: [String: Any]?) {
    guard let p = patch else { return }
    let pseq = CLVal.double(p["seq"])
    if let reset = p["reset"] as? [Any] {
      if pseq == seq && appliedOnce { return }
      var next: [String: CARow] = [:]
      var ids: [String] = []
      for item in reset {
        guard let d = item as? [String: Any] else { continue }
        let r = CARow(d)
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
        let r = CARow(d)
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
    if gridDirty {
      gridDirty = false
      header.grid.update(year: year, month: month, firstWeekday: firstWeekday, selected: selected,
                         today: today, marks: marks, style: style, labels: labels)
      refreshInsets()
    }
    applySnapshot(reconfigureAll: reconfigureAll)
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
    snap.appendSections([0])
    snap.appendItems(ids, toSection: 0)
    var reconf = Set<String>()
    if reconfigureAll || pendingReset {
      for id in ids where oldIds.contains(id) { reconf.insert(id) }
    } else {
      for id in pendingDirty where seen.contains(id) && oldIds.contains(id) { reconf.insert(id) }
    }
    pendingDirty.removeAll()
    // Linha que mudou de tipo troca de célula: reload.
    var reload: [String] = []
    var reconfOnly: [String] = []
    for id in reconf {
      if let ip = dataSource.indexPath(for: id), let cell = collectionView.cellForItem(at: ip) {
        let ok: Bool
        switch rows[id]?.kind ?? "e" {
        case "h": ok = cell is CAHeaderCell
        case "n": ok = cell is CAEmptyCell
        default: ok = cell is CAEventCell
        }
        if !ok { reload.append(id); continue }
      }
      reconfOnly.append(id)
    }
    if !reconfOnly.isEmpty { snap.reconfigureItems(reconfOnly) }
    if !reload.isEmpty { snap.reloadItems(reload) }
    let animate = appliedOnce && !pendingReset && !reconfigureAll && window != nil && ids.count < 120
    pendingReset = false
    appliedOnce = true
    dataSource.apply(snap, animatingDifferences: animate) { [weak self] in
      self?.afterApply()
    }
  }

  private func afterApply() {
    layoutHeader()
    if !firstPaintSent {
      firstPaintSent = true
      DispatchQueue.main.async { [weak self] in
        self?.onFirstPaint(["count": self?.order.count ?? 0])
      }
    }
  }

  // MARK: - Filho RN (entre a grade e a agenda)

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
    for v in rnChildren {
      if v.superview !== header.host { header.host.addSubview(v) }
      let obs = v.observe(\.bounds, options: [.new]) { [weak self] _, _ in
        DispatchQueue.main.async { self?.refreshInsets() }
      }
      boundsObservers.append(obs)
    }
    refreshInsets()
  }

  private func childHeight() -> CGFloat {
    var h: CGFloat = 0
    for v in rnChildren { h = max(h, v.frame.maxY) }
    return h
  }

  private func refreshInsets() {
    guard let cv = collectionView else { return }
    let newHeader = header.gridHeight + childHeight()
    let insets = UIEdgeInsets(top: newHeader, left: 0, bottom: bottomInset + 16, right: 0)
    if cv.contentInset != insets {
      let oldTop = cv.contentInset.top
      let atTop = cv.contentOffset.y <= -oldTop + 0.5
      cv.contentInset = insets
      cv.verticalScrollIndicatorInsets = UIEdgeInsets(top: 0, left: 0, bottom: bottomInset, right: 0)
      let pulling = refreshControl?.isRefreshing == true
      if !pulling && (!didInitialOffset || (atTop && !cv.isTracking && !cv.isDecelerating)) {
        cv.contentOffset = CGPoint(x: 0, y: -newHeader)
        didInitialOffset = newHeader > 0
      }
    }
    headerH = newHeader
    layoutHeader()
  }

  private func layoutHeader() {
    guard let cv = collectionView else { return }
    let w = cv.bounds.width
    let gh = header.gridHeight
    let hf = CGRect(x: 0, y: -headerH, width: w, height: headerH)
    if header.frame != hf { header.frame = hf }
    // A grade pode estar com transform (arrasto/animação): bounds + center.
    let gb = CGRect(x: 0, y: 0, width: w, height: gh)
    if header.grid.bounds != gb {
      header.grid.bounds = gb
      header.grid.setNeedsDisplay()
    }
    let gc = CGPoint(x: w / 2, y: gh / 2)
    if header.grid.center != gc { header.grid.center = gc }
    let hostF = CGRect(x: 0, y: gh, width: w, height: max(0, headerH - gh))
    if header.host.frame != hostF { header.host.frame = hostF }
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    if collectionView.frame != bounds { collectionView.frame = bounds }
    layoutHeader()
  }

  // MARK: - Swipe (Editar / Apagar)

  private func swipeConfiguration(_ indexPath: IndexPath, leading: Bool) -> UISwipeActionsConfiguration? {
    guard let id = dataSource.itemIdentifier(for: indexPath),
          let row = rows[id], row.kind == "e", row.swipe else { return nil }
    let c = style.colors
    let action = leading ? "edit" : "delete"
    let a = UIContextualAction(style: .normal, title: leading ? labels.edit : labels.delete) { [weak self] _, _, done in
      UISelectionFeedbackGenerator().selectionChanged()
      self?.onRowAction(["id": id, "action": action, "source": "swipe"])
      done(true)
    }
    let ink: UIColor = leading ? c.onPrimary : .white
    a.image = UIImage(systemName: leading ? "pencil" : "trash",
                      withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .medium))?
      .withTintColor(ink, renderingMode: .alwaysOriginal)
    a.backgroundColor = leading ? c.primary : c.error
    let cfg = UISwipeActionsConfiguration(actions: [a])
    // Apagar pede confirmação na tela (alerta); swipe completo só no Editar.
    cfg.performsFirstActionWithFullSwipe = leading
    return cfg
  }

  // MARK: - UICollectionViewDelegate

  private func tappable(_ indexPath: IndexPath) -> Bool {
    guard let id = dataSource.itemIdentifier(for: indexPath), let r = rows[id] else { return false }
    return r.kind == "e"
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
