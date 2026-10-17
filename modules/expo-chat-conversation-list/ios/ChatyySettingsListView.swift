import ExpoModulesCore
import UIKit

// [2026-10-15 settings-native] Raiz das Configurações em NATIVO: lista
// agrupada em cartões (layout compositional, diffable data source) com o
// mesmo visual 2026 da lista JS — chip de ícone suave, subtítulo de estado,
// disclosure (ou UISwitch com haptic), cabeçalhos em caixa alta. O hero e os
// cartões especiais seguem JS: 1º filho RN, rola junto acima da 1ª seção.
// Busca: a prop `query` filtra as linhas de resultado ("q") AQUI, sem
// atravessar a ponte por tecla.
//
// JS: components/settings/NativeSettingsList.js (+ app/settings.js).
public final class ChatyySettingsListView: ExpoView, UICollectionViewDelegate {
  let onRowPress = EventDispatcher()
  let onToggle = EventDispatcher()
  let onRefresh = EventDispatcher()
  let onResync = EventDispatcher()
  let onFirstPaint = EventDispatcher()
  let onNativeError = EventDispatcher()

  private var collectionView: CLCollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<String, String>!

  private var rows: [String: STRow] = [:]
  private var order: [String] = []
  private var seq: Double = 0
  private var pendingDirty = Set<String>()
  private var needsApply = false
  private var appliedOnce = false
  private var firstPaintSent = false
  private var resyncAskedFor: Double = -1

  private var query = ""
  private var queryDirty = false
  private var palette = STPalette(dark: false)
  private var paletteDirty = true
  private var dark = false
  private var colorsRaw: [String: Any]? = nil
  private var labels = CLLabels()
  private var maxContentWidth: CGFloat = 0
  private var autoInset = false

  // Montagem do snapshot atual: textos de cabeçalho e posição no cartão.
  private var headerTexts: [String: String] = [:]
  private var positions: [String: (first: Bool, last: Bool)] = [:]
  private var emptyText = ""

  private let headerHost = CLChildHost()
  private var rnChildren: [UIView] = []
  private var boundsObservers: [NSKeyValueObservation] = []
  private var headerHint: CGFloat = 0
  private var headerH: CGFloat = 0
  private var bottomInset: CGFloat = 0
  private var didInitialOffset = false
  private let refresher = UIRefreshControl()
  private weak var hostVC: UIViewController?

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
    cv.showsVerticalScrollIndicator = true
    cv.keyboardDismissMode = .onDrag
    cv.delegate = self
    cv.backgroundColor = palette.pageBg
    cv.addSubview(headerHost)
    cv.onLayout = { [weak self] in self?.layoutHosts() }
    refresher.addTarget(self, action: #selector(pulled), for: .valueChanged)
    cv.refreshControl = refresher
    addSubview(cv)
    collectionView = cv

    let rowReg = UICollectionView.CellRegistration<STRowCell, String> { [weak self] cell, _, id in
      self?.bindRow(cell, id: id)
    }
    let headReg = UICollectionView.CellRegistration<STHeaderCell, String> { [weak self] cell, _, id in
      guard let self = self else { return }
      cell.configure(self.headerTexts[id] ?? "", palette: self.palette)
    }
    let emptyReg = UICollectionView.CellRegistration<STEmptyCell, String> { [weak self] cell, _, _ in
      guard let self = self else { return }
      cell.configure(self.emptyText, palette: self.palette)
    }
    dataSource = UICollectionViewDiffableDataSource<String, String>(collectionView: cv) { collectionView, indexPath, id in
      if id.hasPrefix("h|") {
        return collectionView.dequeueConfiguredReusableCell(using: headReg, for: indexPath, item: id)
      }
      if id.hasPrefix("e|") {
        return collectionView.dequeueConfiguredReusableCell(using: emptyReg, for: indexPath, item: id)
      }
      return collectionView.dequeueConfiguredReusableCell(using: rowReg, for: indexPath, item: id)
    }
  }

  private func bindRow(_ cell: STRowCell, id: String) {
    guard let row = rows[id] else { return }
    let pos = positions[id] ?? (first: true, last: true)
    cell.configure(row, palette: palette, first: pos.first, last: pos.last, showSeparator: !pos.last)
    cell.onToggle = { [weak self] rid, value in
      guard let self = self else { return }
      if var r = self.rows[rid] { r.on = value; self.rows[rid] = r }
      self.onToggle(["id": rid, "value": value])
    }
  }

  private func makeLayout() -> UICollectionViewLayout {
    let layout = UICollectionViewCompositionalLayout { [weak self] sectionIndex, env in
      return self?.sectionLayout(sectionIndex, env)
    }
    layout.register(STCardBackground.self, forDecorationViewOfKind: STCardBackground.kind)
    return layout
  }

  private func sectionLayout(_ index: Int, _ env: NSCollectionLayoutEnvironment) -> NSCollectionLayoutSection? {
    let secs = dataSource?.snapshot().sectionIdentifiers ?? []
    let sid = index >= 0 && index < secs.count ? secs[index] : ""
    let w = env.container.effectiveContentSize.width
    var h: CGFloat = 16
    if maxContentWidth > 0 && w > maxContentWidth { h = max(16, (w - maxContentWidth) / 2 + 16) }
    let est: CGFloat = sid.hasPrefix("h|") ? 22 : 52
    let item = NSCollectionLayoutItem(layoutSize: NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .estimated(est)))
    let group = NSCollectionLayoutGroup.vertical(layoutSize: NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .estimated(est)), subitems: [item])
    let section = NSCollectionLayoutSection(group: group)
    if sid.hasPrefix("c|") {
      // Cartão: decoração arredondada atrás das linhas; 24 pt até o próximo grupo.
      let insets = NSDirectionalEdgeInsets(top: 0, leading: h, bottom: 24, trailing: h)
      section.contentInsets = insets
      let bg = NSCollectionLayoutDecorationItem.background(elementKind: STCardBackground.kind)
      bg.contentInsets = insets
      section.decorationItems = [bg]
    } else {
      section.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: h, bottom: 0, trailing: h)
    }
    return section
  }

  // MARK: - Props

  func setRowsPatch(_ patch: [String: Any]?) {
    guard let p = patch else { return }
    let pseq = CLVal.double(p["seq"])
    if let reset = p["reset"] as? [Any] {
      if pseq == seq && appliedOnce { return }
      var next: [String: STRow] = [:]
      var ids: [String] = []
      for item in reset {
        guard let d = item as? [String: Any] else { continue }
        let r = STRow(d)
        if r.id.isEmpty { continue }
        if next[r.id] == nil { ids.append(r.id) }
        next[r.id] = r
      }
      rows = next
      order = ids
      if let ord = p["order"] as? [Any] { order = ord.map { CLVal.str($0) } }
      seq = pseq
      pendingDirty = Set(ids)
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
        let r = STRow(d)
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

  func setQuery(_ q: String) {
    let n = STText.normalize(q)
    if n == query { return }
    query = n
    queryDirty = true
  }

  func setDark(_ d: Bool) {
    if d == dark { return }
    dark = d
    paletteDirty = true
  }

  func setColors(_ d: [String: Any]?) {
    colorsRaw = d
    paletteDirty = true
  }

  func setLabels(_ d: [String: Any]?) {
    labels = CLLabels(d)
    needsApply = true
  }

  func setHeaderHeightHint(_ h: CGFloat) { headerHint = max(0, h) }

  func setBottomInset(_ b: CGFloat) { bottomInset = max(0, b) }

  func setMaxContentWidth(_ w: CGFloat) {
    let v = max(0, w)
    if v == maxContentWidth { return }
    maxContentWidth = v
    collectionView.collectionViewLayout.invalidateLayout()
  }

  func setAutoInset(_ on: Bool) {
    if on == autoInset { return }
    autoInset = on
    collectionView.contentInsetAdjustmentBehavior = on ? .automatic : .never
    didInitialOffset = false
    syncContentScrollView()
  }

  func setRefreshing(_ on: Bool) {
    if !on && refresher.isRefreshing { refresher.endRefreshing() }
  }

  func commitProps() {
    var reconfigureAll = false
    if paletteDirty {
      paletteDirty = false
      palette = STPalette(dark: dark, colors: colorsRaw)
      STCardBackground.color = palette.cardBg
      backgroundColor = palette.pageBg
      collectionView.backgroundColor = palette.pageBg
      collectionView.indicatorStyle = palette.dark ? .white : .black
      refresher.tintColor = palette.secondary
      collectionView.collectionViewLayout.invalidateLayout()
      reconfigureAll = appliedOnce
    }
    applySnapshot(reconfigureAll: reconfigureAll)
    refreshInsets()
  }

  // MARK: - Snapshot

  private func applySnapshot(reconfigureAll: Bool) {
    guard needsApply || queryDirty || reconfigureAll || !appliedOnce else { return }
    let structural = needsApply || queryDirty || !appliedOnce
    needsApply = false
    queryDirty = false

    var seen = Set<String>()
    var ids: [String] = []
    for id in order where rows[id] != nil && !seen.contains(id) { seen.insert(id); ids.append(id) }
    if ids.count < rows.count {
      for id in rows.keys.sorted() where !seen.contains(id) { seen.insert(id); ids.append(id) }
    }
    order = ids

    var snap = NSDiffableDataSourceSnapshot<String, String>()
    var heads: [String: String] = [:]
    var pos: [String: (first: Bool, last: Bool)] = [:]
    func addCard(_ key: String, _ header: String, _ items: [String]) {
      if items.isEmpty { return }
      if !header.isEmpty {
        let hid = "h|" + key
        snap.appendSections([hid])
        snap.appendItems([hid], toSection: hid)
        heads[hid] = header
      }
      let cid = "c|" + key
      snap.appendSections([cid])
      snap.appendItems(items, toSection: cid)
      for (i, id) in items.enumerated() { pos[id] = (first: i == 0, last: i == items.count - 1) }
    }

    if query.isEmpty {
      // Grupos = trechos contíguos com o mesmo `sid` (resultados de busca ficam de fora).
      var curSid: String? = nil
      var curHeader = ""
      var bucket: [String] = []
      var n = 0
      for id in ids {
        guard let r = rows[id], r.kind != "q" else { continue }
        if curSid == nil || curSid! != r.sid {
          addCard("\(n)|\(curSid ?? "")", curHeader, bucket)
          n += 1
          bucket = []
          curSid = r.sid
          curHeader = r.header
        }
        bucket.append(id)
      }
      addCard("\(n)|\(curSid ?? "")", curHeader, bucket)
    } else {
      let hits = ids.filter { id in
        guard let r = rows[id], r.kind == "q" else { return false }
        return r.hay.contains(query)
      }
      if hits.isEmpty {
        emptyText = labels.get("noResults", "Nenhum resultado")
        snap.appendSections(["e|empty"])
        snap.appendItems(["e|empty"], toSection: "e|empty")
      } else {
        addCard("results", "\(labels.get("results", "Resultados")) (\(hits.count))", hits)
      }
    }

    let old = dataSource.snapshot()
    let oldIds = Set(old.itemIdentifiers)
    headerTexts = heads
    positions = pos
    // Reconfigura o que continua na tela (dados, cantos/separador, tema).
    let keep = snap.itemIdentifiers.filter { oldIds.contains($0) }
    let reconf: [String] = (reconfigureAll || structural) ? keep : keep.filter { pendingDirty.contains($0) }
    if !reconf.isEmpty { snap.reconfigureItems(reconf) }
    pendingDirty.removeAll()
    let animate = false
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

  // MARK: - Filho RN (hero + cartões)

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
      if v.superview !== headerHost { headerHost.addSubview(v) }
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
    for v in rnChildren { hh = max(hh, v.frame.maxY) }
    let newHeader = hh > 0.5 ? hh : headerHint
    let insets = UIEdgeInsets(top: newHeader, left: 0, bottom: bottomInset, right: 0)
    if cv.contentInset != insets {
      let oldTop = cv.adjustedContentInset.top
      let atTop = cv.contentOffset.y <= -oldTop + 0.5
      cv.contentInset = insets
      if !didInitialOffset || (atTop && !cv.isTracking && !cv.isDecelerating) {
        cv.contentOffset = CGPoint(x: 0, y: -cv.adjustedContentInset.top)
        didInitialOffset = newHeader > 0 || appliedOnce
      }
    }
    headerH = newHeader
    layoutHosts()
  }

  private func layoutHosts() {
    guard let cv = collectionView else { return }
    let hf = CGRect(x: 0, y: -headerH, width: cv.bounds.width, height: headerH)
    if headerHost.frame != hf { headerHost.frame = hf }
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    if collectionView.frame != bounds { collectionView.frame = bounds }
    layoutHosts()
  }

  // Título grande + barra de busca do header nativo acompanham ESTA lista.
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

  @objc private func pulled() {
    onRefresh([:])
    // Segurança: o JS desliga `refreshing`; se não vier, recolhe sozinho.
    DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
      if self?.refresher.isRefreshing == true { self?.refresher.endRefreshing() }
    }
  }

  // MARK: - Toques RN no header
  // [2026-10-17 settings-scroll-tap] O header (hero/cartões) é RN montado
  // DENTRO desta UICollectionView. O RCTSurfaceTouchHandler (Fabric) NÃO é
  // cancelado por pans de scroll views descendentes (canBePreventedBy… = NO
  // p/ descendentes) → o Pressable sob o dedo continuava "pressionado" e
  // disparava onPress ao soltar (rolar abria "Aparelhos conectados"). Igual ao
  // _cancelTouches do próprio handler: desliga/religa → JS recebe touchCancel.
  // (JS também tem guarda: components/native/nativeHeaderTouchGuard.js.)
  public func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
    var v: UIView? = self.superview
    while let cur = v {
      for gr in cur.gestureRecognizers ?? [] where NSStringFromClass(type(of: gr)).contains("TouchHandler") {
        gr.isEnabled = false
        gr.isEnabled = true
      }
      v = cur.superview
    }
  }

  // MARK: - UICollectionViewDelegate

  private func isPressable(_ id: String) -> Bool {
    guard let r = rows[id] else { return false }
    return r.kind != "t"
  }

  public func collectionView(_ collectionView: UICollectionView, shouldHighlightItemAt indexPath: IndexPath) -> Bool {
    guard let id = dataSource.itemIdentifier(for: indexPath) else { return false }
    return isPressable(id)
  }

  public func collectionView(_ collectionView: UICollectionView, shouldSelectItemAt indexPath: IndexPath) -> Bool {
    guard let id = dataSource.itemIdentifier(for: indexPath) else { return false }
    return isPressable(id)
  }

  public func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: true)
    guard let id = dataSource.itemIdentifier(for: indexPath), isPressable(id) else { return }
    onRowPress(["id": id])
  }
}
