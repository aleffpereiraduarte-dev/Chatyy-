import ExpoModulesCore
import UIKit

// [2026-10-15 native-wallet] CARTEIRA em NATIVO (iOS): app/wallet.js e
// app/creator-earnings.js via components/native/NativeWalletList.js.
//   • Herói grafite nativo (WLHeroView) com o saldo em contagem rolando e os
//     botões (comprar / sacar / enviar presente) → onHeroAction {id}; a tela
//     chama os fluxos JS existentes.
//   • Filho RN 0 (ganhos, mais vendidos, filtros…) rola junto, logo abaixo do
//     herói.
//   • Histórico: UICollectionView (layout compositional + diffable data
//     source), transações agrupadas por dia em cartões arredondados, puxar p/
//     atualizar, onEndReached (paginação), estado vazio com botão.
// Patches por id (createPatcher do nativeAdapter). Mesmo contrato do Android
// (ChatyyWalletListView.kt).
public final class ChatyyWalletListView: ExpoView, UICollectionViewDelegate {
  let onRowPress = EventDispatcher()
  let onRowAction = EventDispatcher()
  let onHeroAction = EventDispatcher()
  let onRefresh = EventDispatcher()
  let onEndReached = EventDispatcher()
  let onResync = EventDispatcher()
  let onFirstPaint = EventDispatcher()
  let onNativeError = EventDispatcher()

  private var collectionView: CLCollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<String, String>!

  private var rows: [String: WLRow] = [:]
  private var order: [String] = []
  private var seq: Double = 0
  private var pendingDirty = Set<String>()
  private var needsApply = false
  private var appliedOnce = false
  private var firstPaintSent = false
  private var resyncAskedFor: Double = -1
  private var positions: [String: (first: Bool, last: Bool)] = [:]

  private var palette = WLPalette(dark: false)
  private var paletteDirty = true
  private var dark = false
  private var colorsRaw: [String: Any]? = nil
  private var maxContentWidth: CGFloat = 0
  private var autoInset = false

  // Herói nativo + filho RN
  private let heroView = WLHeroView()
  private var heroOn = false
  private var heroDirty = false
  private var heroModel = WLHero()
  private var heroH: CGFloat = 0
  private var heroTop: CGFloat = 16
  private var heroGap: CGFloat = 16
  private let headerHost = CLChildHost()
  private var rnChildren: [UIView] = []
  private var boundsObservers: [NSKeyValueObservation] = []
  private var headerHint: CGFloat = 0
  private var rnH: CGFloat = 0
  private var bottomInset: CGFloat = 0
  private var didInitialOffset = false
  private let refresher = UIRefreshControl()
  private var refreshEnabled = true
  private var endReachedFor: CGFloat = -1
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
    cv.showsVerticalScrollIndicator = false
    cv.delegate = self
    cv.backgroundColor = palette.pageBg
    heroView.isHidden = true
    heroView.onAction = { [weak self] id in self?.onHeroAction(["id": id]) }
    cv.addSubview(heroView)
    cv.addSubview(headerHost)
    cv.onLayout = { [weak self] in self?.layoutHosts() }
    refresher.addTarget(self, action: #selector(pulled), for: .valueChanged)
    cv.refreshControl = refresher
    addSubview(cv)
    collectionView = cv

    let txReg = UICollectionView.CellRegistration<WLTxCell, String> { [weak self] cell, _, id in
      guard let self = self, let r = self.rows[id] else { return }
      let pos = self.positions[id] ?? (first: true, last: true)
      cell.configure(r, palette: self.palette, first: pos.first, last: pos.last)
    }
    let dayReg = UICollectionView.CellRegistration<WLDayCell, String> { [weak self] cell, _, id in
      guard let self = self, let r = self.rows[id] else { return }
      cell.configure(r, palette: self.palette)
    }
    let emptyReg = UICollectionView.CellRegistration<WLEmptyCell, String> { [weak self] cell, _, id in
      guard let self = self, let r = self.rows[id] else { return }
      cell.configure(r, palette: self.palette)
      cell.onAction = { [weak self] rid, action in
        self?.onRowAction(["id": rid, "action": action])
      }
    }
    let loadReg = UICollectionView.CellRegistration<WLLoadingCell, String> { [weak self] cell, _, _ in
      guard let self = self else { return }
      cell.configure(palette: self.palette)
    }
    let noteReg = UICollectionView.CellRegistration<WLNoteCell, String> { [weak self] cell, _, id in
      guard let self = self, let r = self.rows[id] else { return }
      cell.configure(r, palette: self.palette)
    }
    dataSource = UICollectionViewDiffableDataSource<String, String>(collectionView: cv) { [weak self] collectionView, indexPath, id in
      switch self?.rows[id]?.kind ?? "x" {
      case "d": return collectionView.dequeueConfiguredReusableCell(using: dayReg, for: indexPath, item: id)
      case "e": return collectionView.dequeueConfiguredReusableCell(using: emptyReg, for: indexPath, item: id)
      case "l": return collectionView.dequeueConfiguredReusableCell(using: loadReg, for: indexPath, item: id)
      case "n": return collectionView.dequeueConfiguredReusableCell(using: noteReg, for: indexPath, item: id)
      default: return collectionView.dequeueConfiguredReusableCell(using: txReg, for: indexPath, item: id)
      }
    }
  }

  private func makeLayout() -> UICollectionViewLayout {
    let layout = UICollectionViewCompositionalLayout { [weak self] sectionIndex, env in
      return self?.sectionLayout(sectionIndex, env)
    }
    layout.register(WLCardBackground.self, forDecorationViewOfKind: WLCardBackground.kind)
    return layout
  }

  private func sideInset(_ w: CGFloat) -> CGFloat {
    var h: CGFloat = 16
    if maxContentWidth > 0 && w > maxContentWidth { h = max(16, (w - maxContentWidth) / 2 + 16) }
    return h
  }

  private func sectionLayout(_ index: Int, _ env: NSCollectionLayoutEnvironment) -> NSCollectionLayoutSection? {
    let secs = dataSource?.snapshot().sectionIdentifiers ?? []
    let sid = index >= 0 && index < secs.count ? secs[index] : ""
    let h = sideInset(env.container.effectiveContentSize.width)
    let est: CGFloat = sid.hasPrefix("c|") ? 64 : 44
    let item = NSCollectionLayoutItem(layoutSize: NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .estimated(est)))
    let group = NSCollectionLayoutGroup.vertical(layoutSize: NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .estimated(est)), subitems: [item])
    let section = NSCollectionLayoutSection(group: group)
    // Estado vazio: 12 pt de respiro acima (como o ListEmptyComponent do JS).
    let isEmpty = sid.hasPrefix("p|") && rows[String(sid.dropFirst(2))]?.kind == "e"
    let insets = NSDirectionalEdgeInsets(top: isEmpty ? 12 : 0, leading: h, bottom: 0, trailing: h)
    section.contentInsets = insets
    if sid.hasPrefix("c|") {
      let bg = NSCollectionLayoutDecorationItem.background(elementKind: WLCardBackground.kind)
      bg.contentInsets = insets
      section.decorationItems = [bg]
    }
    return section
  }

  // MARK: - Props

  func setRowsPatch(_ patch: [String: Any]?) {
    guard let p = patch else { return }
    let pseq = CLVal.double(p["seq"])
    if let reset = p["reset"] as? [Any] {
      if pseq == seq && appliedOnce { return }
      var next: [String: WLRow] = [:]
      var ids: [String] = []
      for item in reset {
        guard let d = item as? [String: Any] else { continue }
        let r = WLRow(d)
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
        let r = WLRow(d)
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

  func setHero(_ d: [String: Any]?) {
    if let d = d, !d.isEmpty {
      heroModel = WLHero(d)
      heroOn = true
    } else {
      heroOn = false
    }
    heroDirty = true
  }

  func setDark(_ d: Bool) {
    if d == dark { return }
    dark = d
    paletteDirty = true
    heroDirty = true
  }

  func setColors(_ d: [String: Any]?) {
    colorsRaw = d
    paletteDirty = true
  }

  func setHeaderHeightHint(_ h: CGFloat) { headerHint = max(0, h) }

  func setBottomInset(_ b: CGFloat) { bottomInset = max(0, b) }

  func setHeroInsets(top: CGFloat, gap: CGFloat) {
    if top == heroTop && gap == heroGap { return }
    heroTop = max(0, top)
    heroGap = max(0, gap)
    heroDirty = true
  }

  func setMaxContentWidth(_ w: CGFloat) {
    let v = max(0, w)
    if v == maxContentWidth { return }
    maxContentWidth = v
    collectionView.collectionViewLayout.invalidateLayout()
    heroDirty = true
  }

  func setAutoInset(_ on: Bool) {
    if on == autoInset { return }
    autoInset = on
    collectionView.contentInsetAdjustmentBehavior = on ? .automatic : .never
    didInitialOffset = false
    syncContentScrollView()
  }

  func setRefreshEnabled(_ on: Bool) {
    if on == refreshEnabled { return }
    refreshEnabled = on
    collectionView.refreshControl = on ? refresher : nil
  }

  func setRefreshing(_ on: Bool) {
    if !on && refresher.isRefreshing { refresher.endRefreshing() }
  }

  func commitProps() {
    var reconfigureAll = false
    if paletteDirty {
      paletteDirty = false
      palette = WLPalette(dark: dark, colors: colorsRaw)
      WLCardBackground.color = palette.cardBg
      backgroundColor = palette.pageBg
      collectionView.backgroundColor = palette.pageBg
      refresher.tintColor = palette.secondary
      collectionView.collectionViewLayout.invalidateLayout()
      reconfigureAll = appliedOnce
    }
    if heroDirty {
      heroDirty = false
      heroView.isHidden = !heroOn
      if heroOn { heroView.configure(heroModel, dark: dark) }
      refreshInsets()
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
    for id in order where rows[id] != nil && !seen.contains(id) { seen.insert(id); ids.append(id) }
    order = ids

    var snap = NSDiffableDataSourceSnapshot<String, String>()
    var pos: [String: (first: Bool, last: Bool)] = [:]
    var bucket: [String] = []
    var bucketSid: String? = nil
    var n = 0
    func flush() {
      if bucket.isEmpty { return }
      let sec = "c|\(n)|\(bucketSid ?? "")"
      n += 1
      snap.appendSections([sec])
      snap.appendItems(bucket, toSection: sec)
      for (i, id) in bucket.enumerated() { pos[id] = (first: i == 0, last: i == bucket.count - 1) }
      bucket = []
      bucketSid = nil
    }
    for id in ids {
      guard let r = rows[id] else { continue }
      if r.kind == "x" {
        if bucketSid != nil && bucketSid! != r.sid { flush() }
        bucketSid = r.sid
        bucket.append(id)
      } else {
        flush()
        let sec = "p|" + id
        snap.appendSections([sec])
        snap.appendItems([id], toSection: sec)
      }
    }
    flush()

    let old = dataSource.snapshot()
    let oldIds = Set(old.itemIdentifiers)
    positions = pos
    // Cantos/separador mudam quando o grupo muda: reconfigura o que ficou.
    let keep = snap.itemIdentifiers.filter { oldIds.contains($0) }
    if !keep.isEmpty { snap.reconfigureItems(keep) }
    pendingDirty.removeAll()
    let animate = appliedOnce && window != nil && !UIAccessibility.isReduceMotionEnabled && abs(snap.numberOfItems - old.numberOfItems) <= 30
    appliedOnce = true
    dataSource.apply(snap, animatingDifferences: animate) { [weak self] in
      self?.afterApply()
    }
  }

  private func afterApply() {
    layoutHosts()
    endReachedFor = -1
    if !firstPaintSent {
      firstPaintSent = true
      DispatchQueue.main.async { [weak self] in
        self?.onFirstPaint(["count": self?.order.count ?? 0])
      }
    }
  }

  // MARK: - Filho RN

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

  private func heroBlockHeight(width: CGFloat) -> CGFloat {
    guard heroOn, width > 0 else { return 0 }
    let side = sideInset(width)
    let hh = heroView.layout(width: max(0, width - side * 2))
    heroH = hh
    return heroTop + hh + heroGap
  }

  private func refreshInsets() {
    guard let cv = collectionView else { return }
    var hh: CGFloat = 0
    for v in rnChildren { hh = max(hh, v.frame.maxY) }
    rnH = hh > 0.5 ? hh : headerHint
    let top = heroBlockHeight(width: cv.bounds.width) + rnH
    let insets = UIEdgeInsets(top: top, left: 0, bottom: bottomInset, right: 0)
    if cv.contentInset != insets {
      let oldTop = cv.adjustedContentInset.top
      let atTop = cv.contentOffset.y <= -oldTop + 0.5
      cv.contentInset = insets
      if !didInitialOffset || (atTop && !cv.isTracking && !cv.isDecelerating) {
        cv.contentOffset = CGPoint(x: 0, y: -cv.adjustedContentInset.top)
        didInitialOffset = top > 0 || appliedOnce
      }
    }
    layoutHosts()
  }

  private func layoutHosts() {
    guard let cv = collectionView else { return }
    let w = cv.bounds.width
    let hf = CGRect(x: 0, y: -rnH, width: w, height: rnH)
    if headerHost.frame != hf { headerHost.frame = hf }
    if heroOn {
      let side = sideInset(w)
      let f = CGRect(x: side, y: -rnH - heroGap - heroH, width: max(0, w - side * 2), height: heroH)
      if heroView.frame != f { heroView.frame = f }
    }
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    let widthChanged = collectionView.frame.width != bounds.width
    if collectionView.frame != bounds { collectionView.frame = bounds }
    if widthChanged { refreshInsets() } else { layoutHosts() }
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

  @objc private func pulled() {
    onRefresh([:])
    DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
      if self?.refresher.isRefreshing == true { self?.refresher.endRefreshing() }
    }
  }

  // MARK: - UIScrollViewDelegate / UICollectionViewDelegate

  public func scrollViewDidScroll(_ scrollView: UIScrollView) {
    let h = scrollView.bounds.height
    let contentH = scrollView.contentSize.height
    if contentH <= 0 || h <= 0 { return }
    let remaining = contentH + scrollView.adjustedContentInset.bottom - (scrollView.contentOffset.y + h)
    if remaining < h * 0.6 && endReachedFor != contentH {
      endReachedFor = contentH
      onEndReached([:])
    }
  }

  private func isPressable(_ id: String) -> Bool {
    guard let r = rows[id] else { return false }
    return r.kind == "x" && r.tap
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
    UISelectionFeedbackGenerator().selectionChanged()
    onRowPress(["id": id])
  }
}
