import ExpoModulesCore
import UIKit

// [2026-10-15 native-calls] Histórico da aba Ligações em NATIVO: lista
// compositional "inset grouped" (cartões arredondados por seção — Hoje, Ontem,
// Esta semana, Anteriores — como o JS), diffable data source, swipe para
// apagar, menu nativo no toque longo. Os cartões de cima (título grande,
// chips, silenciar desconhecidas, criar link) continuam em JS: 1º filho RN,
// rola junto acima da 1ª seção.
//
// JS: components/calls/NativeCallList.js (+ ChatCallsTab.js).
public final class ChatyyCallListView: ExpoView, UICollectionViewDelegate {
  let onRowPress = EventDispatcher()
  let onRowAction = EventDispatcher()
  let onCollapsedChange = EventDispatcher()
  let onResync = EventDispatcher()
  let onFirstPaint = EventDispatcher()
  let onNativeError = EventDispatcher()

  private var collectionView: CLCollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<String, String>!

  private var rows: [String: KLRow] = [:]
  private var order: [String] = []
  private var seq: Double = 0
  private var pendingReset = false
  private var pendingDirty = Set<String>()
  private var needsApply = false
  private var appliedOnce = false
  private var firstPaintSent = false
  private var resyncAskedFor: Double = -1
  private var sectionTitles: [String: String] = [:]

  private var theme = KLTheme(dark: false)
  private var themeDirty = true
  private var labels = CLLabels()
  private var labelsDirty = false
  var swipeEnabled = true
  var menuEnabled = true
  var collapseOffset: CGFloat = 34
  private var collapsed = false

  private let headerHost = CLChildHost()
  private let footerHost = CLChildHost()
  private var rnChildren: [UIView] = []
  private var boundsObservers: [NSKeyValueObservation] = []
  private var headerHint: CGFloat = 0
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
    cv.backgroundColor = theme.bg
    cv.addSubview(headerHost)
    cv.addSubview(footerHost)
    cv.onLayout = { [weak self] in self?.layoutHosts() }
    addSubview(cv)
    collectionView = cv

    let reg = UICollectionView.CellRegistration<KLCallCell, String> { [weak self] cell, _, id in
      self?.bind(cell, id: id)
    }
    dataSource = UICollectionViewDiffableDataSource<String, String>(collectionView: cv) { collectionView, indexPath, id in
      return collectionView.dequeueConfiguredReusableCell(using: reg, for: indexPath, item: id)
    }
    let headerReg = UICollectionView.SupplementaryRegistration<UICollectionViewListCell>(elementKind: UICollectionView.elementKindSectionHeader) { [weak self] view, _, indexPath in
      guard let self = self else { return }
      let sid = self.dataSource.sectionIdentifier(for: indexPath.section) ?? ""
      var c = UIListContentConfiguration.groupedHeader()
      c.text = (self.sectionTitles[sid] ?? "").uppercased()
      c.textProperties.font = UIFont.systemFont(ofSize: 12, weight: .semibold)
      c.textProperties.color = self.theme.sub
      c.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 24, leading: 16, bottom: 8, trailing: 16)
      view.contentConfiguration = c
      var bg = UIBackgroundConfiguration.clear()
      bg.backgroundColor = .clear
      view.backgroundConfiguration = bg
    }
    dataSource.supplementaryViewProvider = { collectionView, kind, indexPath in
      return collectionView.dequeueConfiguredReusableSupplementary(using: headerReg, for: indexPath)
    }
  }

  private func bind(_ cell: KLCallCell, id: String) {
    guard let row = rows[id] else { return }
    cell.configure(row, theme: theme, labels: labels)
    cell.onAction = { [weak self] rid, action in
      self?.emitAction(rid, action, source: "button")
    }
  }

  private func makeLayout() -> UICollectionViewLayout {
    var cfg = UICollectionLayoutListConfiguration(appearance: .insetGrouped)
    cfg.backgroundColor = theme.bg
    cfg.headerMode = .supplementary
    cfg.showsSeparators = true
    var sep = UIListSeparatorConfiguration(listAppearance: .insetGrouped)
    sep.color = theme.hair
    // Divisória a partir do nome (16 + 51 + 13), como no JS.
    sep.bottomSeparatorInsets = NSDirectionalEdgeInsets(top: 0, leading: 80, bottom: 0, trailing: 0)
    cfg.separatorConfiguration = sep
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
      var next: [String: KLRow] = [:]
      var ids: [String] = []
      for item in reset {
        guard let d = item as? [String: Any] else { continue }
        let r = KLRow(d)
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
        let r = KLRow(d)
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

  func setDark(_ dark: Bool) {
    if dark == theme.dark && !themeDirty { return }
    theme = KLTheme(dark: dark)
    themeDirty = true
  }

  func setLabels(_ d: [String: Any]?) {
    labels = CLLabels(d)
    labelsDirty = true
  }

  func setHeaderHeightHint(_ h: CGFloat) { headerHint = max(0, h) }

  func setBottomInset(_ b: CGFloat) { bottomInset = max(0, b) }

  func commitProps() {
    var reconfigureAll = false
    if themeDirty {
      backgroundColor = theme.bg
      collectionView.backgroundColor = theme.bg
      collectionView.indicatorStyle = theme.dark ? .white : .black
      collectionView.setCollectionViewLayout(makeLayout(), animated: false)
      reconfigureAll = appliedOnce
      themeDirty = false
    }
    if labelsDirty {
      labelsDirty = false
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
    // Seções = trechos contíguos com o mesmo rótulo (a lista já vem ordenada).
    var snap = NSDiffableDataSourceSnapshot<String, String>()
    var titles: [String: String] = [:]
    var curTitle: String? = nil
    var curId = ""
    var bucket: [String] = []
    var n = 0
    func flush() {
      if !bucket.isEmpty {
        snap.appendSections([curId])
        snap.appendItems(bucket, toSection: curId)
        bucket = []
      }
    }
    for id in ids {
      let t = rows[id]?.sec ?? ""
      if curTitle == nil || curTitle! != t {
        flush()
        curTitle = t
        curId = "\(n)|\(t)"
        n += 1
        titles[curId] = t
      }
      bucket.append(id)
    }
    flush()
    let old = dataSource.snapshot()
    let oldIds = Set(old.itemIdentifiers)
    sectionTitles = titles
    if reconfigureAll {
      // Tema/rótulos: recarrega seções (cabeçalhos) que continuam na tela.
      let keep = Set(old.sectionIdentifiers)
      let same = snap.sectionIdentifiers.filter { keep.contains($0) }
      if !same.isEmpty { snap.reloadSections(same) }
    } else {
      let reconf: [String] = pendingReset
        ? ids.filter { oldIds.contains($0) }
        : Array(pendingDirty.filter { seen.contains($0) && oldIds.contains($0) })
      if !reconf.isEmpty { snap.reconfigureItems(reconf) }
    }
    pendingDirty.removeAll()
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
    let insets = UIEdgeInsets(top: newHeader, left: 0, bottom: fh + bottomInset, right: 0)
    if cv.contentInset != insets {
      let oldTop = cv.contentInset.top
      let atTop = cv.contentOffset.y <= -oldTop + 0.5
      cv.contentInset = insets
      if !didInitialOffset || (atTop && !cv.isTracking && !cv.isDecelerating) {
        cv.contentOffset = CGPoint(x: 0, y: -newHeader)
        didInitialOffset = newHeader > 0 || appliedOnce
      }
    }
    headerH = newHeader
    footerH = fh
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

  private func swipeConfiguration(_ indexPath: IndexPath) -> UISwipeActionsConfiguration? {
    guard swipeEnabled, let id = dataSource.itemIdentifier(for: indexPath), rows[id] != nil else { return nil }
    let a = UIContextualAction(style: .destructive, title: labels.get("delete", "Apagar")) { [weak self] _, _, done in
      UINotificationFeedbackGenerator().notificationOccurred(.warning)
      self?.emitAction(id, "delete", source: "swipe")
      done(true)
    }
    a.image = UIImage(systemName: "trash", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .medium))?
      .withTintColor(.white, renderingMode: .alwaysOriginal)
    a.backgroundColor = UIColor(clHex: 0xEF4444)
    let cfg = UISwipeActionsConfiguration(actions: [a])
    cfg.performsFirstActionWithFullSwipe = true
    return cfg
  }

  private func buildMenu(id: String, row: KLRow) -> UIMenu {
    let L = labels
    func act(_ action: String, _ title: String, _ symbol: String, destructive: Bool = false) -> UIAction {
      let a = UIAction(title: title, image: UIImage(systemName: symbol)) { [weak self] _ in
        self?.emitAction(id, action, source: "menu")
      }
      if destructive { a.attributes = .destructive }
      return a
    }
    let quick = UIMenu(title: "", options: .displayInline, children: [
      act("callBack", L.get("callBack", "Ligar de volta"), row.video ? "video" : "phone"),
      act("info", L.get("info", "Info"), "info.circle"),
    ])
    let more = UIMenu(title: "", options: .displayInline, children: [
      act("addContact", L.get("addContact", "Adicionar aos contatos"), "person.crop.circle.badge.plus"),
      act("copyNumber", L.get("copyNumber", "Copiar número"), "doc.on.doc"),
    ])
    let danger = UIMenu(title: "", options: .displayInline, children: [
      act("block", L.get("block", "Bloquear contato"), "hand.raised", destructive: true),
      act("report", L.get("report", "Denunciar spam"), "exclamationmark.bubble", destructive: true),
      act("delete", L.get("delete", "Apagar"), "trash", destructive: true),
    ])
    return UIMenu(title: row.title, children: [quick, more, danger])
  }

  // MARK: - UICollectionViewDelegate

  public func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: true)
    guard let id = dataSource.itemIdentifier(for: indexPath) else { return }
    onRowPress(["id": id])
  }

  public func collectionView(_ collectionView: UICollectionView, contextMenuConfigurationForItemAt indexPath: IndexPath, point: CGPoint) -> UIContextMenuConfiguration? {
    guard menuEnabled, let id = dataSource.itemIdentifier(for: indexPath), let row = rows[id] else { return nil }
    return UIContextMenuConfiguration(identifier: id as NSString, previewProvider: nil, actionProvider: { [weak self] _ in
      return self?.buildMenu(id: id, row: row)
    })
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
