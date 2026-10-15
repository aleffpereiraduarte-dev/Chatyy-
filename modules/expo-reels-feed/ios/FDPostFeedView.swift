import AVFoundation
import ExpoModulesCore
import UIKit

// [2026-10-15 native-feed] Aba FEED (posts) em NATIVO — contrato em
// ChatyyPostFeedModule.swift. Esqueleto igual às listas nativas do
// expo-chat-conversation-list (patches por id seq/base + onResync, diffable,
// filhos RN = header/rodapé no espaço de conteúdo) + o pool de 3 AVPlayer dos
// Reels: só o vídeo do post mais visível (≥ 60 % da mídia) toca, mudo por
// padrão (toque alterna o som), pausa fora da tela; os 2 próximos vídeos ficam
// pré-carregados (pool + RFVideoCache).

final class FDCollectionView: UICollectionView {
  var onLayout: (() -> Void)?
  override func layoutSubviews() {
    super.layoutSubviews()
    onLayout?()
  }
}

final class FDChildHost: UIView {
  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    clipsToBounds = false
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

public final class FDPostFeedView: ExpoView, UICollectionViewDelegate, FDPostCellDelegate {
  let onPostAction = EventDispatcher()
  let onEndReached = EventDispatcher()
  let onRefresh = EventDispatcher()
  let onScrollState = EventDispatcher()
  let onResync = EventDispatcher()
  let onFirstPaint = EventDispatcher()
  let onNativeError = EventDispatcher()

  private var collectionView: FDCollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<Int, String>!
  private let refresh = UIRefreshControl()

  // Dados
  private var rows: [String: FDRow] = [:]
  private var order: [String] = []
  private var seq: Double = 0
  private var pendingReset = false
  private var pendingDirty = Set<String>()
  private var needsApply = false
  private var appliedOnce = false
  private var firstPaintSent = false
  private var resyncAskedFor: Double = -1
  private var expanded = Set<String>()
  private var pageById: [String: Int] = [:]

  // Aparência
  private var dark = false
  private var paletteDict: [String: Any]?
  private var palette = FDPalette(dark: false)
  private var paletteDirty = true
  private var labels = FDLabels()

  // Vídeo
  private let pool = RFPlayerPool()
  private var currentKey = ""
  private var currentRowId = ""
  private var muted = true
  private var paused = false
  private var appActive = true
  private var observers: [NSObjectProtocol] = []

  // Rolagem
  private var lastY: CGFloat = 0
  private var stateTop = false
  private var stateHidden = false
  private var endSentForCount = -1

  // Header / rodapé RN
  private let headerHost = FDChildHost()
  private let footerHost = FDChildHost()
  private var rnChildren: [UIView] = []
  private var boundsObservers: [NSKeyValueObservation] = []
  private var headerHint: CGFloat = 0
  private var footerHint: CGFloat = 0
  private var headerH: CGFloat = 0
  private var footerH: CGFloat = 0
  private var bottomInset: CGFloat = 0
  private var didInitialOffset = false
  private var scrollTopSeq: Double = 0

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    setupCollection()
    setupPool()
    let nc = NotificationCenter.default
    observers.append(nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      self?.appActive = false
      self?.pool.pauseAll()
    })
    observers.append(nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      self?.appActive = true
      self?.updateActive()
    })
  }

  deinit {
    for o in observers { NotificationCenter.default.removeObserver(o) }
    pool.releaseAll()
  }

  // MARK: - Setup

  private func setupCollection() {
    let cv = FDCollectionView(frame: bounds, collectionViewLayout: makeLayout())
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

    let reg = UICollectionView.CellRegistration<FDPostCell, String> { [weak self] cell, _, id in
      guard let self = self, let row = self.rows[id] else { return }
      cell.delegate = self
      cell.configure(row, page: self.pageById[id] ?? 0, expanded: self.expanded.contains(id),
                     muted: self.muted, labels: self.labels, palette: self.palette)
    }
    dataSource = UICollectionViewDiffableDataSource<Int, String>(collectionView: cv) { collectionView, indexPath, id in
      return collectionView.dequeueConfiguredReusableCell(using: reg, for: indexPath, item: id)
    }
  }

  private func makeLayout() -> UICollectionViewLayout {
    let est = max(320, UIScreen.main.bounds.width + 190)
    let size = NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .estimated(est))
    let item = NSCollectionLayoutItem(layoutSize: size)
    let group = NSCollectionLayoutGroup.vertical(layoutSize: size, subitems: [item])
    let section = NSCollectionLayoutSection(group: group)
    return UICollectionViewCompositionalLayout(section: section)
  }

  private func setupPool() {
    pool.onReady = { [weak self] s in
      guard let self = self, s.itemId == self.currentKey else { return }
      self.playCurrent()
    }
    pool.onEnd = { [weak self] s in
      guard let self = self else { return }
      s.loops += 1
      s.player.seek(to: .zero)
      if s.itemId == self.currentKey && self.canPlay { s.player.play() }
    }
    pool.onFail = { [weak self] s in
      guard let self = self, s.itemId == self.currentKey else { return }
      self.cell(forRowId: self.currentRowId)?.markFailed()
    }
  }

  // MARK: - Props

  func setRowsPatch(_ patch: [String: Any]?) {
    guard let p = patch else { return }
    let pseq = FDVal.num(p["seq"])
    if let reset = p["reset"] as? [Any] {
      if pseq == seq && appliedOnce { return }
      var next: [String: FDRow] = [:]
      var ids: [String] = []
      for item in reset {
        guard let d = item as? [String: Any], let r = FDRow(d) else { continue }
        if next[r.id] == nil { ids.append(r.id) }
        next[r.id] = r
      }
      rows = next
      order = ids
      if let ord = p["order"] as? [Any] { order = ord.compactMap { FDVal.str($0) } }
      seq = pseq
      pendingReset = true
      needsApply = true
      return
    }
    if pseq <= seq { return }
    let base = FDVal.num(p["base"])
    if base != seq {
      if resyncAskedFor != seq {
        resyncAskedFor = seq
        onResync(["seq": seq])
      }
      return
    }
    if let rm = p["remove"] as? [Any] {
      for x in rm { if let k = FDVal.str(x) { rows.removeValue(forKey: k) } }
    }
    if let ups = p["upsert"] as? [Any] {
      for item in ups {
        guard let d = item as? [String: Any], let r = FDRow(d) else { continue }
        if rows[r.id] == nil && p["order"] == nil { order.append(r.id) }
        rows[r.id] = r
        pendingDirty.insert(r.id)
      }
    }
    if let ord = p["order"] as? [Any] { order = ord.compactMap { FDVal.str($0) } }
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
    labels = FDLabels(d)
    paletteDirty = true // reconfigura as células com os textos novos
  }

  func setImageHeaders(_ d: [String: Any]?) {
    var h: [String: String] = [:]
    for (k, v) in d ?? [:] { if let s = v as? String, !s.isEmpty { h[k] = s } }
    if !h.isEmpty { RFImageLoader.shared.authHeaders = h }
  }

  func setHeaderHeightHint(_ h: CGFloat) { headerHint = max(0, h) }
  func setFooterHeightHint(_ h: CGFloat) { footerHint = max(0, h) }
  func setBottomInset(_ b: CGFloat) { bottomInset = max(0, b) }

  func setRefreshing(_ on: Bool) {
    if !on && refresh.isRefreshing { refresh.endRefreshing() }
  }

  func setRefreshTint(_ hex: String) {
    if let c = FDPalette.parse(hex) { refresh.tintColor = c }
  }

  func setPaused(_ p: Bool) {
    if p == paused { return }
    paused = p
    if p { pool.pauseAll() } else { DispatchQueue.main.async { [weak self] in self?.updateActive() } }
  }

  func setScrollToTopSeq(_ s: Double) {
    if s == scrollTopSeq { return }
    let first = scrollTopSeq == 0
    scrollTopSeq = s
    if first && s == 0 { return }
    guard let cv = collectionView else { return }
    cv.setContentOffset(CGPoint(x: 0, y: -cv.contentInset.top), animated: true)
  }

  func commitProps() {
    var reconfigureAll = false
    if paletteDirty {
      palette = FDPalette(dark: dark, dict: paletteDict)
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
    expanded = expanded.intersection(seen)
    pageById = pageById.filter { seen.contains($0.key) }
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
    if !reconf.isEmpty { snap.reconfigureItems(reconf) }
    let animate = appliedOnce && !pendingReset && !reconfigureAll && window != nil
    pendingReset = false
    appliedOnce = true
    if ids.count != endSentForCount { endSentForCount = min(endSentForCount, ids.count - 1) }
    dataSource.apply(snap, animatingDifferences: animate) { [weak self] in
      guard let self = self else { return }
      if !reconf.isEmpty { self.invalidateHeights(reconf) }
      self.afterApply()
    }
  }

  /// Altura mudou (curtidas 0→1, tradução, "mais") → self-sizing de novo.
  private func invalidateHeights(_ ids: [String]) {
    let ips = ids.compactMap { dataSource.indexPath(for: $0) }
    if ips.isEmpty { return }
    let ctx = UICollectionViewLayoutInvalidationContext()
    ctx.invalidateItems(at: ips)
    collectionView.collectionViewLayout.invalidateLayout(with: ctx)
  }

  private func afterApply() {
    layoutHosts()
    if !firstPaintSent {
      firstPaintSent = true
      DispatchQueue.main.async { [weak self] in
        self?.onFirstPaint(["count": self?.order.count ?? 0])
      }
    }
    DispatchQueue.main.async { [weak self] in self?.updateActive(force: true) }
  }

  /// Aplica uma mudança local (curtir/salvar otimista) e redesenha só a célula.
  private func reconfigureLocal(_ id: String) {
    guard dataSource.indexPath(for: id) != nil else { return }
    var snap = dataSource.snapshot()
    snap.reconfigureItems([id])
    dataSource.apply(snap, animatingDifferences: false) { [weak self] in
      self?.invalidateHeights([id])
      self?.updateActive(force: true)
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

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { pool.pauseAll() } else { updateActive(force: true) }
  }

  // MARK: - Vídeo (post ativo)

  private var canPlay: Bool { return !paused && appActive && window != nil && !isHidden }

  private func cell(forRowId id: String) -> FDPostCell? {
    guard !id.isEmpty, let ip = dataSource.indexPath(for: id) else { return nil }
    return collectionView.cellForItem(at: ip) as? FDPostCell
  }

  private func visibleCellsSorted() -> [FDPostCell] {
    return collectionView.visibleCells.compactMap { $0 as? FDPostCell }.sorted { $0.frame.minY < $1.frame.minY }
  }

  private func videoItem(_ row: FDRow, page: Int) -> RFItem? {
    guard page < row.media.count, row.media[page].video else { return nil }
    let md = row.media[page]
    return RFItem(["id": row.videoKey(page), "videoUrl": md.url, "thumb": md.poster])
  }

  /// Escolhe o post ativo (1º com ≥ 60 % da mídia visível), distribui o pool
  /// (atual + 2 próximos vídeos) e liga/solta os players nas células.
  private func updateActive(force: Bool = false) {
    guard let cv = collectionView, appliedOnce else { return }
    let visible = cv.bounds
    var activeCell: FDPostCell?
    for c in visibleCellsSorted() {
      guard let r = c.mediaRect(in: cv) else { continue }
      let inter = r.intersection(visible)
      if inter.isNull || r.height <= 0 { continue }
      if inter.height / r.height >= 0.6 { activeCell = c; break }
    }
    let rowId = activeCell?.row?.id ?? ""
    var key = ""
    var wanted: [RFItem] = []
    if let c = activeCell, let row = c.row, let it = videoItem(row, page: c.page) {
      key = it.id
      wanted.append(it)
    }
    // Pré-carrega os próximos vídeos (1ª página de vídeo dos posts seguintes).
    var startIdx = 0
    if !rowId.isEmpty, let i = order.firstIndex(of: rowId) { startIdx = i + 1 }
    else if let first = visibleCellsSorted().first?.row?.id, let i = order.firstIndex(of: first) { startIdx = i }
    var ahead = 0
    var idx = startIdx
    while idx < order.count && ahead < 4 && wanted.count < 3 {
      if let r = rows[order[idx]] {
        if let vp = r.media.firstIndex(where: { $0.video }), let it = videoItem(r, page: vp), it.id != key {
          wanted.append(it)
          RFVideoCache.shared.prefetch(it.videoUrl)
        } else if let md = r.media.first {
          RFImageLoader.shared.prefetch(md.video ? md.poster : md.url, maxPixel: UIScreen.main.bounds.width * UIScreen.main.scale)
        }
      }
      idx += 1
      ahead += 1
    }
    if !force && key == currentKey && rowId == currentRowId { return }
    currentKey = key
    currentRowId = rowId
    pool.assign(wanted, currentId: key)
    for c in visibleCellsSorted() {
      if let row = c.row, row.id == rowId, !key.isEmpty {
        c.attachPlayer(pool.slot(for: key)?.player)
        c.updateMuteBadge(muted)
      } else {
        c.attachPlayer(nil)
      }
    }
    playCurrent()
  }

  private func playCurrent() {
    guard let s = pool.slot(for: currentKey) else { return }
    if !canPlay {
      if s.player.rate != 0 { s.player.pause() }
      return
    }
    if !muted { RFFeedView.ensureAudioSession() }
    s.player.isMuted = muted
    if s.player.rate == 0 { s.player.play() }
  }

  // MARK: - FDPostCellDelegate

  func fdCell(_ cell: FDPostCell, action: String, value: String) {
    guard let row = cell.row else { return }
    var payload: [String: Any] = ["id": row.id, "action": action, "value": value]
    switch action {
    case "like":
      row.liked.toggle()
      row.likes = max(0, row.likes + (row.liked ? 1 : -1))
      if row.liked { UINotificationFeedbackGenerator().notificationOccurred(.success) } else { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
      cell.applyLike(row.liked, animated: true)
      payload["liked"] = row.liked
      payload["likes"] = row.likes
      reconfigureLocal(row.id)
    case "save":
      row.saved.toggle()
      if row.saved { UINotificationFeedbackGenerator().notificationOccurred(.success) } else { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
      cell.applySave(row.saved, animated: true)
      payload["saved"] = row.saved
    default:
      break
    }
    onPostAction(payload)
  }

  func fdCellDoubleTap(_ cell: FDPostCell, at point: CGPoint) {
    guard let row = cell.row else { return }
    cell.burstHeart(at: point)
    if !row.liked {
      fdCell(cell, action: "like", value: "double_tap")
    } else {
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
  }

  func fdCellSingleTapMedia(_ cell: FDPostCell) {
    guard cell.currentPageIsVideo else { return }
    muted.toggle()
    UISelectionFeedbackGenerator().selectionChanged()
    for c in visibleCellsSorted() { c.updateMuteBadge(muted) }
    if let row = cell.row, row.id != currentRowId {
      updateActive(force: true)
    } else {
      playCurrent()
    }
  }

  func fdCellPageChanged(_ cell: FDPostCell, page: Int) {
    guard let row = cell.row else { return }
    pageById[row.id] = page
    updateActive(force: true)
  }

  func fdCellToggleExpand(_ cell: FDPostCell) {
    guard let row = cell.row else { return }
    if expanded.contains(row.id) { expanded.remove(row.id) } else { expanded.insert(row.id) }
    reconfigureLocal(row.id)
  }

  /// JS pode mandar a tradução/curtida reconciliada via patch; nada extra aqui.

  // MARK: - Ações

  @objc private func didPullRefresh() {
    UISelectionFeedbackGenerator().selectionChanged()
    onRefresh([:])
    DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
      guard let self = self, self.refresh.isRefreshing else { return }
      self.refresh.endRefreshing()
    }
  }

  // MARK: - UIScrollViewDelegate

  public func scrollViewDidScroll(_ scrollView: UIScrollView) {
    guard scrollView === collectionView else { return }
    let y = scrollView.contentOffset.y + scrollView.contentInset.top
    let dy = y - lastY
    lastY = y
    let viewH = scrollView.bounds.height
    let contentH = scrollView.contentSize.height + scrollView.contentInset.top + scrollView.contentInset.bottom
    let nearEnd = contentH > 0 && viewH > 0 && y + viewH >= contentH - 24
    let top = y > 800
    var hidden = stateHidden
    if y < 80 || nearEnd { hidden = false } else if dy > 6 { hidden = true } else if dy < -6 { hidden = false }
    if top != stateTop || hidden != stateHidden {
      stateTop = top
      stateHidden = hidden
      onScrollState(["top": top, "hidden": hidden])
    }
    // Paginação: faltando ~2,5 telas.
    if order.count > 0 && endSentForCount != order.count
        && scrollView.contentOffset.y + viewH > scrollView.contentSize.height - viewH * 2.5 {
      endSentForCount = order.count
      onEndReached([:])
    }
    updateActive()
  }

  public func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
    if scrollView === collectionView { updateActive(force: true) }
  }

  public func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    if scrollView === collectionView && !decelerate { updateActive(force: true) }
  }

  public func collectionView(_ collectionView: UICollectionView, shouldHighlightItemAt indexPath: IndexPath) -> Bool { return false }

  public func collectionView(_ collectionView: UICollectionView, didEndDisplaying cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
    (cell as? FDPostCell)?.attachPlayer(nil)
  }
}
