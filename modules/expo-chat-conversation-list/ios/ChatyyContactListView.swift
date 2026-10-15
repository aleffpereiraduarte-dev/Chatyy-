import ExpoModulesCore
import UIKit

// [2026-10-15 native-contacts] Lista de CONTATOS nativa (iOS) — telas Contatos
// (app/contacts.js, aba "Meus contatos") e Nova conversa (app/chat-new.js,
// lista padrão). UICollectionView (lista compositional + diffable data source),
// cabeçalho de seção FIXO sobreposto (empurrado pelo seguinte, como a
// SectionList com stickySectionHeadersEnabled), índice A–Z lateral com arrasto,
// balão e haptic (app Contatos), swipe "Apagar" (só linhas com `sw`),
// UIRefreshControl e teclado fechando ao arrastar. Mesmo contrato do Android
// (ChatyyContactListView.kt).
//
// Filhos RN: 0 = header (atalhos, favoritos…) que rola junto; 1 = rodapé.

public final class ChatyyContactListView: ExpoView, UICollectionViewDelegate {
  let onRowPress = EventDispatcher()
  let onRowLongPress = EventDispatcher()
  let onRowAction = EventDispatcher()
  let onRefresh = EventDispatcher()
  let onEndReached = EventDispatcher()
  let onResync = EventDispatcher()
  let onFirstPaint = EventDispatcher()
  let onNativeError = EventDispatcher()

  private var collectionView: CLCollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<Int, String>!

  // Dados
  private var rows: [String: CTRow] = [:]
  private var order: [String] = []
  private var seq: Double = 0
  private var pendingReset = false
  private var pendingDirty = Set<String>()
  private var needsApply = false
  private var appliedOnce = false
  private var firstPaintSent = false
  private var resyncAskedFor: Double = -1

  // Aparência / modos
  private var colors = CTColors()
  private var metrics = CTMetrics()
  private var styleDirty = true
  var swipeEnabled = true
  private var indexEnabled = true
  private var indexMin = 6
  private var refreshEnabled = false
  private var refreshing = false
  private var refreshDirty = false

  // Seções / índice
  private var sectionIds: [String] = []
  private var letterIds: [(String, String)] = []   // (letra, id da seção)

  // Overlays
  private let sticky = CTSectionView()
  private var stickyId = ""
  private let indexBar = CTIndexBar()
  private let bubble = UILabel()
  private var refreshControl: UIRefreshControl?

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
  private var scrollTopSeq: Double = 0
  private var endReachedFor: CGFloat = -1

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    setupCollection()
    setupOverlays()
  }

  // MARK: - Setup

  private func setupCollection() {
    let cv = CLCollectionView(frame: bounds, collectionViewLayout: makeLayout())
    cv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    cv.contentInsetAdjustmentBehavior = .never
    cv.alwaysBounceVertical = true
    cv.keyboardDismissMode = .onDrag
    cv.delegate = self
    cv.backgroundColor = colors.bg
    cv.addSubview(headerHost)
    cv.addSubview(footerHost)
    cv.onLayout = { [weak self] in
      self?.layoutHosts()
      self?.updateOverlays()
    }
    addSubview(cv)
    collectionView = cv

    let rowReg = UICollectionView.CellRegistration<CTContactCell, String> { [weak self] cell, _, id in
      guard let self = self, let row = self.rows[id] else { return }
      cell.configure(row, colors: self.colors, metrics: self.metrics)
      cell.onAction = { [weak self] rid, action in
        self?.onRowAction(["id": rid, "action": action, "source": "tap"])
      }
      cell.onLongPress = { [weak self] rid in
        self?.onRowLongPress(["id": rid])
      }
    }
    let secReg = UICollectionView.CellRegistration<CTSectionCell, String> { [weak self] cell, _, id in
      guard let self = self, let row = self.rows[id] else { return }
      cell.configure(row, colors: self.colors)
    }
    dataSource = UICollectionViewDiffableDataSource<Int, String>(collectionView: cv) { [weak self] collectionView, indexPath, id in
      if self?.rows[id]?.isSection == true {
        return collectionView.dequeueConfiguredReusableCell(using: secReg, for: indexPath, item: id)
      }
      return collectionView.dequeueConfiguredReusableCell(using: rowReg, for: indexPath, item: id)
    }
  }

  private func setupOverlays() {
    sticky.isHidden = true
    addSubview(sticky)
    indexBar.isHidden = true
    indexBar.onLetter = { [weak self] letter, y in self?.jump(to: letter, y: y) }
    indexBar.onRelease = { [weak self] in self?.releaseIndex() }
    addSubview(indexBar)
    bubble.isHidden = true
    bubble.textAlignment = .center
    bubble.font = UIFont.systemFont(ofSize: 24, weight: .bold)
    bubble.layer.cornerRadius = 28
    bubble.clipsToBounds = true
    bubble.isUserInteractionEnabled = false
    addSubview(bubble)
  }

  private func makeLayout() -> UICollectionViewLayout {
    var cfg = UICollectionLayoutListConfiguration(appearance: .plain)
    cfg.backgroundColor = colors.bg
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
      var next: [String: CTRow] = [:]
      var ids: [String] = []
      for item in reset {
        guard let d = item as? [String: Any] else { continue }
        let r = CTRow(d)
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
        let r = CTRow(d)
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
    colors = CTColors(d)
    styleDirty = true
  }

  func setMetrics(_ d: [String: Any]?) {
    metrics = CTMetrics(d)
    styleDirty = true
  }

  func setIndexEnabled(_ on: Bool) {
    indexEnabled = on
    setNeedsLayout()
  }

  func setIndexMin(_ v: Double) { indexMin = max(1, Int(v)) }

  func setRefreshEnabled(_ on: Bool) {
    if on == refreshEnabled { return }
    refreshEnabled = on
    refreshDirty = true
  }

  func setRefreshing(_ on: Bool) {
    refreshing = on
    refreshDirty = true
  }

  func setHeaderHeightHint(_ h: CGFloat) { headerHint = max(0, h) }
  func setFooterHeightHint(_ h: CGFloat) { footerHint = max(0, h) }
  func setBottomInset(_ b: CGFloat) { bottomInset = max(0, b) }

  func setScrollToTopSeq(_ s: Double) {
    if s <= scrollTopSeq { scrollTopSeq = max(scrollTopSeq, s); return }
    let first = scrollTopSeq == 0
    scrollTopSeq = s
    if first && !appliedOnce { return }
    collectionView.setContentOffset(CGPoint(x: 0, y: -collectionView.contentInset.top), animated: true)
  }

  func commitProps() {
    var reconfigureAll = false
    if styleDirty {
      styleDirty = false
      backgroundColor = colors.bg
      collectionView.backgroundColor = colors.bg
      collectionView.indicatorStyle = colors.dark ? .white : .black
      collectionView.setCollectionViewLayout(makeLayout(), animated: false)
      indexBar.color = colors.indexText
      bubble.backgroundColor = colors.primary
      bubble.textColor = colors.onPrimary
      refreshControl?.tintColor = colors.sub
      if !stickyId.isEmpty, let r = rows[stickyId] { sticky.configure(r, colors: colors) }
      reconfigureAll = appliedOnce
    }
    if refreshDirty {
      refreshDirty = false
      applyRefresh()
    }
    applySnapshot(reconfigureAll: reconfigureAll)
    refreshInsets()
  }

  private func applyRefresh() {
    if refreshEnabled {
      if refreshControl == nil {
        let rc = UIRefreshControl()
        rc.tintColor = colors.sub
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
    // Rede: se o JS nunca baixar `refreshing` (estado agrupado), não fica girando.
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
    // Seções + letras do índice
    var secs: [String] = []
    var letters: [(String, String)] = []
    var seenLetters = Set<String>()
    for id in ids {
      guard let r = rows[id], r.isSection else { continue }
      secs.append(id)
      if !r.ix.isEmpty && !seenLetters.contains(r.ix) {
        seenLetters.insert(r.ix)
        letters.append((r.ix, id))
      }
    }
    sectionIds = secs
    letterIds = letters
    indexBar.letters = letters.map { $0.0 }

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
    // Linha que virou seção (ou o contrário) troca de tipo de célula: reload.
    var reload: [String] = []
    var reconfOnly: [String] = []
    for id in reconf {
      let visible = collectionView.indexPathsForVisibleItems.contains { dataSource.itemIdentifier(for: $0) == id }
      if visible, let ip = dataSource.indexPath(for: id), let cell = collectionView.cellForItem(at: ip) {
        let isSec = rows[id]?.isSection == true
        if (cell is CTSectionCell) != isSec { reload.append(id); continue }
      }
      reconfOnly.append(id)
    }
    if !reconfOnly.isEmpty { snap.reconfigureItems(reconfOnly) }
    if !reload.isEmpty { snap.reloadItems(reload) }
    let animate = appliedOnce && !pendingReset && !reconfigureAll && window != nil
    pendingReset = false
    appliedOnce = true
    if !stickyId.isEmpty, let r = rows[stickyId] { sticky.configure(r, colors: colors) }
    dataSource.apply(snap, animatingDifferences: animate) { [weak self] in
      self?.afterApply()
    }
  }

  private func afterApply() {
    layoutHosts()
    updateOverlays()
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
    let newFooter = fh > 0.5 ? fh : footerHint
    let insets = UIEdgeInsets(top: newHeader, left: 0, bottom: newFooter + bottomInset, right: 0)
    if cv.contentInset != insets {
      let oldTop = cv.contentInset.top
      let atTop = cv.contentOffset.y <= -oldTop + 0.5
      cv.contentInset = insets
      cv.verticalScrollIndicatorInsets = UIEdgeInsets(top: 0, left: 0, bottom: bottomInset, right: 0)
      let pullingToRefresh = refreshControl?.isRefreshing == true
      if !pullingToRefresh && (!didInitialOffset || (atTop && !cv.isTracking && !cv.isDecelerating)) {
        cv.contentOffset = CGPoint(x: 0, y: -newHeader)
        didInitialOffset = newHeader > 0 || appliedOnce
      }
    }
    headerH = newHeader
    footerH = newFooter
    layoutHosts()
    updateOverlays()
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
    indexBar.frame = CGRect(x: bounds.width - 22, y: 0, width: 22, height: bounds.height)
    layoutHosts()
    updateOverlays()
  }

  // MARK: - Cabeçalho fixo + índice

  private func minY(of id: String) -> CGFloat? {
    guard let ip = dataSource.indexPath(for: id),
          let a = collectionView.collectionViewLayout.layoutAttributesForItem(at: ip) else { return nil }
    return a.frame.minY
  }

  private func updateOverlays() {
    guard let cv = collectionView else { return }
    updateSticky(cv)
    updateIndex(cv)
  }

  private func updateSticky(_ cv: UICollectionView) {
    let top = cv.contentOffset.y
    if top <= 0 || sectionIds.isEmpty { sticky.isHidden = true; return }
    var cur: String?
    var nextY: CGFloat?
    for id in sectionIds {
      guard let y = minY(of: id) else { continue }
      if y <= top { cur = id } else { nextY = y; break }
    }
    guard let cid = cur, let r = rows[cid] else { sticky.isHidden = true; return }
    if cid != stickyId || sticky.isHidden {
      stickyId = cid
      sticky.configure(r, colors: colors)
    }
    sticky.isHidden = false
    let h = CTSectionView.height(r, traits: traitCollection)
    var y: CGFloat = 0
    if let ny = nextY, ny - top < h { y = ny - top - h }
    sticky.frame = CGRect(x: 0, y: min(0, y), width: bounds.width, height: h)
    bringSubviewToFront(sticky)
    bringSubviewToFront(indexBar)
    bringSubviewToFront(bubble)
  }

  private func updateIndex(_ cv: UICollectionView) {
    let want = indexEnabled && letterIds.count >= indexMin
    if !want { indexBar.isHidden = true; return }
    // Topo do índice = fim da parte visível do header RN (como o JS fazia).
    let headerBottom = max(0, -cv.contentOffset.y)
    indexBar.range = (headerBottom, max(0, bounds.height - bottomInset))
    indexBar.isHidden = !indexBar.fits()
  }

  private func jump(to letter: String, y: CGFloat) {
    guard let pair = letterIds.first(where: { $0.0 == letter }),
          let sy = minY(of: pair.1) else { return }
    let cv = collectionView!
    let maxOff = max(-cv.contentInset.top, cv.contentSize.height + cv.contentInset.bottom - cv.bounds.height)
    cv.setContentOffset(CGPoint(x: 0, y: min(sy, maxOff)), animated: false)
    bubble.text = letter
    let s: CGFloat = 56
    let by = max(0, min(bounds.height - s, y - s / 2))
    bubble.frame = CGRect(x: bounds.width - 22 - 22 - s, y: by, width: s, height: s)
    if bubble.isHidden {
      bubble.alpha = 0
      bubble.isHidden = false
      UIView.animate(withDuration: 0.09) { self.bubble.alpha = 1 }
    }
    updateOverlays()
  }

  private func releaseIndex() {
    UIView.animate(withDuration: 0.16, animations: { self.bubble.alpha = 0 }, completion: { _ in
      self.bubble.isHidden = true
    })
  }

  // MARK: - Swipe (Apagar)

  private func swipeConfiguration(_ indexPath: IndexPath) -> UISwipeActionsConfiguration? {
    guard swipeEnabled,
          let id = dataSource.itemIdentifier(for: indexPath),
          let row = rows[id], !row.isSection, !row.swipe.isEmpty else { return nil }
    let a = UIContextualAction(style: .normal, title: row.swipe) { [weak self] _, _, done in
      UISelectionFeedbackGenerator().selectionChanged()
      self?.onRowAction(["id": id, "action": "delete", "source": "swipe"])
      done(true)
    }
    a.image = UIImage(systemName: "trash", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .medium))?
      .withTintColor(.white, renderingMode: .alwaysOriginal)
    a.backgroundColor = colors.error
    let cfg = UISwipeActionsConfiguration(actions: [a])
    cfg.performsFirstActionWithFullSwipe = true
    return cfg
  }

  // MARK: - UICollectionViewDelegate

  public func collectionView(_ collectionView: UICollectionView, shouldHighlightItemAt indexPath: IndexPath) -> Bool {
    guard let id = dataSource.itemIdentifier(for: indexPath), let r = rows[id] else { return false }
    return !r.isSection && r.tap
  }

  public func collectionView(_ collectionView: UICollectionView, shouldSelectItemAt indexPath: IndexPath) -> Bool {
    guard let id = dataSource.itemIdentifier(for: indexPath), let r = rows[id] else { return false }
    return !r.isSection && r.tap
  }

  public func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: true)
    guard let id = dataSource.itemIdentifier(for: indexPath) else { return }
    onRowPress(["id": id])
  }

  // MARK: - UIScrollViewDelegate

  public func scrollViewDidScroll(_ scrollView: UIScrollView) {
    updateOverlays()
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
