import ExpoModulesCore
import UIKit

// [2026-10-15 native-drive] Lista/grade de ARQUIVOS nativa (iOS) — app/drive.js
// e app/files.js. UICollectionView compositional (lista com swipe dos dois
// lados OU grade de cartões) + diffable data source por id, miniaturas com
// cache em disco (DVThumbLoader), seleção múltipla controlada pelo JS
// (selectionMode + selectedIds), toque longo com prévia + UIMenu
// (UIContextMenuConfiguration; tocar na prévia = abrir), barra de envio com
// progresso fixa no topo, UIRefreshControl e fim da lista. Mesmo contrato do
// Android (ChatyyDriveListView.kt). O nativo só desenha: toda ação volta por
// id e a tela roda os fluxos JS de sempre (confirmações, modais, toasts).

public final class ChatyyDriveListView: ExpoView, UICollectionViewDelegate {
  let onRowPress = EventDispatcher()
  let onRowAction = EventDispatcher()
  let onLongPress = EventDispatcher()
  let onRefresh = EventDispatcher()
  let onEndReached = EventDispatcher()
  let onResync = EventDispatcher()
  let onFirstPaint = EventDispatcher()
  let onNativeError = EventDispatcher()

  private var collectionView: UICollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<String, String>!
  private let uploadBar = DVUploadBar()

  // Dados
  private var rows: [String: DVRow] = [:]
  private var order: [String] = []
  private var seq: Double = 0
  private var pendingReset = false
  private var pendingDirty = Set<String>()
  private var needsApply = false
  private var appliedOnce = false
  private var firstPaintSent = false
  private var resyncAskedFor: Double = -1
  /// "h" = seção-cabeçalho (1 item, largura total) · "c" = conteúdo (lista/grade).
  private var sectionKinds: [String] = []

  // Aparência / modos
  private var style = DVStyle()
  private var labels = DVLabels()
  private var styleDirty = true
  private var highlightRaw = ""
  private var highlightDirty = false
  private var mode = "list"
  private var columns = 0
  private var layoutDirty = false
  private var modeChanged = false
  private var selectionDirty = false
  private var pendingSelected = Set<String>()
  private var pendingSelectionMode = false
  var swipeEnabled = true
  private var refreshEnabled = true
  private var refreshing = false
  private var refreshDirty = true
  private var refreshControl: UIRefreshControl?
  private var topInset: CGFloat = 0
  private var bottomInset: CGFloat = 0
  private var insetsDirty = true
  private var uploadsDirty = false
  private var pendingUploads: [DVUploadBar.Item] = []
  private var barHeight: CGFloat = 0
  private var scrollTopSeq: Double = 0
  private var endReachedFor: CGFloat = -1
  private var autoInset = false
  private weak var hostVC: UIViewController?
  private var memObserver: NSObjectProtocol?

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    setupCollection()
    uploadBar.isHidden = true
    addSubview(uploadBar)
    memObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main
    ) { _ in DVThumbLoader.shared.clearMemory() }
  }

  deinit {
    if let o = memObserver { NotificationCenter.default.removeObserver(o) }
  }

  // MARK: - Setup

  private func setupCollection() {
    let cv = UICollectionView(frame: bounds, collectionViewLayout: makeLayout())
    cv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    cv.contentInsetAdjustmentBehavior = .never
    cv.alwaysBounceVertical = true
    cv.keyboardDismissMode = .onDrag
    cv.delegate = self
    cv.backgroundColor = style.colors.bg
    addSubview(cv)
    collectionView = cv

    let listReg = UICollectionView.CellRegistration<DVListCell, String> { [weak self] cell, _, id in
      guard let self = self, let row = self.rows[id] else { return }
      cell.configure(row, style: self.style)
    }
    let gridReg = UICollectionView.CellRegistration<DVGridCell, String> { [weak self] cell, _, id in
      guard let self = self, let row = self.rows[id] else { return }
      cell.configure(row, style: self.style)
    }
    let secReg = UICollectionView.CellRegistration<DVSectionCell, String> { [weak self] cell, _, id in
      guard let self = self, let row = self.rows[id] else { return }
      cell.configure(row, style: self.style)
    }
    dataSource = UICollectionViewDiffableDataSource<String, String>(collectionView: cv) { [weak self] collectionView, indexPath, id in
      let r = self?.rows[id]
      if r?.kind == "s" {
        return collectionView.dequeueConfiguredReusableCell(using: secReg, for: indexPath, item: id)
      }
      if self?.mode == "grid" {
        return collectionView.dequeueConfiguredReusableCell(using: gridReg, for: indexPath, item: id)
      }
      return collectionView.dequeueConfiguredReusableCell(using: listReg, for: indexPath, item: id)
    }
  }

  private func makeLayout() -> UICollectionViewLayout {
    return UICollectionViewCompositionalLayout { [weak self] sectionIndex, env in
      guard let self = self else { return nil }
      let kind = sectionIndex < self.sectionKinds.count ? self.sectionKinds[sectionIndex] : "c"
      if self.mode == "grid" {
        if kind == "h" {
          let h = DVSectionCell.height(traits: self.traitCollection)
          let item = NSCollectionLayoutItem(layoutSize: .init(widthDimension: .fractionalWidth(1), heightDimension: .absolute(h)))
          let group = NSCollectionLayoutGroup.vertical(layoutSize: .init(widthDimension: .fractionalWidth(1), heightDimension: .absolute(h)), subitems: [item])
          return NSCollectionLayoutSection(group: group)
        }
        let w = env.container.effectiveContentSize.width
        let cols = max(1, self.columns > 0 ? self.columns : (w >= 700 ? 4 : (w >= 500 ? 3 : 2)))
        let pad = DVMetrics.gridPad
        let gap = DVMetrics.gridGap
        let tileW = max(40, floor((w - 2 * pad - CGFloat(cols - 1) * gap) / CGFloat(cols)))
        let h = round(tileW * 0.78) + DVMetrics.gridText
        let item = NSCollectionLayoutItem(layoutSize: .init(widthDimension: .absolute(tileW), heightDimension: .absolute(h)))
        let group = NSCollectionLayoutGroup.horizontal(
          layoutSize: .init(widthDimension: .fractionalWidth(1), heightDimension: .absolute(h)),
          subitem: item, count: cols)
        group.interItemSpacing = .fixed(gap)
        let sec = NSCollectionLayoutSection(group: group)
        sec.interGroupSpacing = gap
        sec.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: pad, bottom: 10, trailing: pad)
        return sec
      }
      var cfg = UICollectionLayoutListConfiguration(appearance: .plain)
      cfg.backgroundColor = self.style.colors.bg
      cfg.showsSeparators = false
      cfg.trailingSwipeActionsConfigurationProvider = { [weak self] ip in self?.swipeConfiguration(ip, leading: false) }
      cfg.leadingSwipeActionsConfigurationProvider = { [weak self] ip in self?.swipeConfiguration(ip, leading: true) }
      return NSCollectionLayoutSection.list(using: cfg, layoutEnvironment: env)
    }
  }

  // MARK: - Props

  func setRowsPatch(_ patch: [String: Any]?) {
    guard let p = patch else { return }
    let pseq = CLVal.double(p["seq"])
    if let reset = p["reset"] as? [Any] {
      if pseq == seq && appliedOnce { return }
      var next: [String: DVRow] = [:]
      var ids: [String] = []
      for item in reset {
        guard let d = item as? [String: Any] else { continue }
        let r = DVRow(d)
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
        let r = DVRow(d)
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
    style.colors = CTColors(d)
    style.card = CTColor.of(d?["card"]) ?? (style.colors.dark ? UIColor(clHex: 0x111113) : .white)
    style.selBg = CTColor.of(d?["selBg"]) ?? (style.colors.dark ? UIColor(white: 1, alpha: 0.10) : UIColor(white: 0, alpha: 0.06))
    styleDirty = true
  }

  func setLabels(_ d: [String: Any]?) {
    labels = DVLabels(d)
    uploadsDirty = true
  }

  func setHighlight(_ q: String) {
    if q == highlightRaw { return }
    highlightRaw = q
    highlightDirty = true
  }

  func setMode(_ m: String) {
    let n = m == "grid" ? "grid" : "list"
    if n == mode { return }
    mode = n
    modeChanged = true
    layoutDirty = true
  }

  func setColumns(_ c: Int) {
    let n = max(0, min(8, c))
    if n == columns { return }
    columns = n
    if mode == "grid" { layoutDirty = true }
  }

  func setSelectionMode(_ on: Bool) {
    pendingSelectionMode = on
    selectionDirty = true
  }

  func setSelectedIds(_ ids: [String]) {
    pendingSelected = Set(ids)
    selectionDirty = true
  }

  func setUploads(_ v: [[String: Any]]?) {
    pendingUploads = DVUploadBar.parse(v)
    uploadsDirty = true
  }

  func setRefreshEnabled(_ on: Bool) {
    if on == refreshEnabled { return }
    refreshEnabled = on
    refreshDirty = true
  }

  func setRefreshing(_ on: Bool) {
    refreshing = on
    refreshDirty = true
  }

  func setTopInset(_ v: CGFloat) {
    let n = max(0, v)
    if n == topInset { return }
    topInset = n
    insetsDirty = true
  }

  func setBottomInset(_ v: CGFloat) {
    let n = max(0, v)
    if n == bottomInset { return }
    bottomInset = n
    insetsDirty = true
  }

  func setAuthToken(_ t: String) {
    // As URLs de miniatura já levam o grant; guardado p/ fontes que exijam o
    // cabeçalho (mesmo carregador dos avatares).
    if !t.isEmpty { CLImageLoader.shared.authToken = t }
  }

  /// Header nativo translúcido (título grande): inset automático do UIKit.
  func setAutoInset(_ on: Bool) {
    if on == autoInset { return }
    autoInset = on
    collectionView.contentInsetAdjustmentBehavior = on ? .automatic : .never
    syncContentScrollView()
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

  func setScrollToTopSeq(_ s: Double) {
    if s <= scrollTopSeq { scrollTopSeq = max(scrollTopSeq, s); return }
    let first = scrollTopSeq == 0
    scrollTopSeq = s
    if first && !appliedOnce { return }
    collectionView.setContentOffset(CGPoint(x: 0, y: -collectionView.adjustedContentInset.top), animated: false)
  }

  func commitProps() {
    var reconfigureAll = false
    var reloadAll = false
    if styleDirty {
      styleDirty = false
      backgroundColor = style.colors.bg
      collectionView.backgroundColor = style.colors.bg
      collectionView.indicatorStyle = style.colors.dark ? .white : .black
      refreshControl?.tintColor = style.colors.sub
      uploadsDirty = true
      layoutDirty = true
      reconfigureAll = appliedOnce
    }
    if highlightDirty {
      highlightDirty = false
      style.tokens = RLHighlight.tokens(highlightRaw)
      reconfigureAll = reconfigureAll || appliedOnce
    }
    if selectionDirty {
      selectionDirty = false
      let selModeChanged = pendingSelectionMode != style.selectionMode
      let changed = style.selected.symmetricDifference(pendingSelected)
      style.selectionMode = pendingSelectionMode
      style.selected = pendingSelected
      if selModeChanged {
        reconfigureAll = reconfigureAll || appliedOnce
      } else {
        for id in changed where rows[id] != nil { pendingDirty.insert(id) }
        if !changed.isEmpty { needsApply = true }
      }
    }
    if layoutDirty {
      layoutDirty = false
      collectionView.setCollectionViewLayout(makeLayout(), animated: false)
      // Lista ↔ grade troca o tipo da célula: recarrega tudo (nada de
      // reconfigure numa célula do tipo antigo).
      if modeChanged && appliedOnce { reloadAll = true }
      modeChanged = false
    }
    if refreshDirty {
      refreshDirty = false
      applyRefresh()
    }
    if uploadsDirty {
      uploadsDirty = false
      applyUploads()
    }
    if insetsDirty {
      insetsDirty = false
      applyInsets()
    }
    applySnapshot(reconfigureAll: reconfigureAll, reloadAll: reloadAll)
  }

  private func applyRefresh() {
    if refreshEnabled {
      if refreshControl == nil {
        let rc = UIRefreshControl()
        rc.tintColor = style.colors.sub
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
    DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
      guard let self = self, self.refreshControl?.isRefreshing == true else { return }
      self.refreshing = false
      self.refreshControl?.endRefreshing()
    }
  }

  private func applyUploads() {
    uploadBar.configure(pendingUploads, style: style, labels: labels)
    let h = uploadBar.desiredHeight(traits: traitCollection)
    if h != barHeight {
      let wasHidden = barHeight == 0
      barHeight = h
      insetsDirty = true
      if h > 0 {
        uploadBar.isHidden = false
        layoutUploadBar()
        if wasHidden && window != nil {
          uploadBar.alpha = 0
          uploadBar.transform = CGAffineTransform(translationX: 0, y: -8)
          UIView.animate(withDuration: 0.22) {
            self.uploadBar.alpha = 1
            self.uploadBar.transform = .identity
          }
        }
      } else {
        UIView.animate(withDuration: 0.2, animations: { self.uploadBar.alpha = 0 }) { _ in
          if self.barHeight == 0 { self.uploadBar.isHidden = true; self.uploadBar.alpha = 1 }
        }
      }
    } else {
      uploadBar.setNeedsLayout()
    }
  }

  private func layoutUploadBar() {
    if barHeight <= 0 { return }
    let top = autoInset ? collectionView.adjustedContentInset.top - collectionView.contentInset.top : 0
    uploadBar.bounds = CGRect(x: 0, y: 0, width: max(0, bounds.width - 24), height: barHeight)
    uploadBar.center = CGPoint(x: bounds.width / 2, y: topInset + top + 8 + barHeight / 2)
  }

  private func applyInsets() {
    let cv = collectionView!
    let extra = barHeight > 0 ? barHeight + 16 : 0
    let atTop = cv.contentOffset.y <= -cv.adjustedContentInset.top + 0.5
    cv.contentInset = UIEdgeInsets(top: topInset + extra, left: 0, bottom: bottomInset, right: 0)
    if !autoInset {
      cv.verticalScrollIndicatorInsets = UIEdgeInsets(top: topInset + extra, left: 0, bottom: bottomInset, right: 0)
    }
    if atTop && !cv.isTracking && !cv.isDecelerating && refreshControl?.isRefreshing != true {
      cv.contentOffset = CGPoint(x: 0, y: -cv.adjustedContentInset.top)
    }
    layoutUploadBar()
  }

  // MARK: - Snapshot

  private func applySnapshot(reconfigureAll: Bool, reloadAll: Bool) {
    guard needsApply || reconfigureAll || reloadAll || !appliedOnce else { return }
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

    // Seções do diffable: cada cabeçalho vira uma seção própria ("h") e os
    // itens seguintes uma seção de conteúdo ("c") — a grade ocupa a largura
    // inteira só nos cabeçalhos.
    var snap = NSDiffableDataSourceSnapshot<String, String>()
    var kinds: [String] = []
    var curContent: String? = nil
    var lastHeader = "top"
    for id in ids {
      if rows[id]?.kind == "s" {
        let sid = "h:\(id)"
        snap.appendSections([sid])
        snap.appendItems([id], toSection: sid)
        kinds.append("h")
        curContent = nil
        lastHeader = id
      } else {
        if curContent == nil {
          let sid = "c:\(lastHeader)"
          snap.appendSections([sid])
          kinds.append("c")
          curContent = sid
        }
        snap.appendItems([id], toSection: curContent!)
      }
    }

    let oldIds = Set(dataSource.snapshot().itemIdentifiers)
    var reconf = Set<String>()
    if reconfigureAll || pendingReset {
      for id in ids where oldIds.contains(id) { reconf.insert(id) }
    } else {
      for id in pendingDirty where seen.contains(id) && oldIds.contains(id) { reconf.insert(id) }
    }
    pendingDirty.removeAll()
    if !reloadAll {
      // Linha que mudou de tipo (seção ↔ item) troca de célula: reload.
      var reload: [String] = []
      var reconfOnly: [String] = []
      for id in reconf {
        if let ip = dataSource.indexPath(for: id), let cell = collectionView.cellForItem(at: ip) {
          let isSec = rows[id]?.kind == "s"
          let ok = isSec ? (cell is DVSectionCell) : (mode == "grid" ? cell is DVGridCell : cell is DVListCell)
          if !ok { reload.append(id); continue }
        }
        reconfOnly.append(id)
      }
      if !reconfOnly.isEmpty { snap.reconfigureItems(reconfOnly) }
      if !reload.isEmpty { snap.reloadItems(reload) }
    }
    sectionKinds = kinds
    let animate = appliedOnce && !pendingReset && !reconfigureAll && !reloadAll && window != nil && ids.count < 400
    pendingReset = false
    appliedOnce = true
    if reloadAll {
      dataSource.applySnapshotUsingReloadData(snap) { [weak self] in self?.afterApply() }
    } else {
      dataSource.apply(snap, animatingDifferences: animate) { [weak self] in
        self?.afterApply()
      }
    }
  }

  private func afterApply() {
    endReachedFor = -1
    if !firstPaintSent {
      firstPaintSent = true
      DispatchQueue.main.async { [weak self] in
        self?.onFirstPaint(["count": self?.order.count ?? 0])
      }
    }
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    if collectionView.frame != bounds {
      let widthChanged = collectionView.frame.width != bounds.width
      collectionView.frame = bounds
      if widthChanged && mode == "grid" && appliedOnce {
        collectionView.collectionViewLayout.invalidateLayout()
      }
    }
    layoutUploadBar()
  }

  // MARK: - Swipe

  private func swipeColor(_ a: String, index: Int) -> UIColor {
    if DVGlyphs.isDestructive(a) { return style.colors.error }
    // P&B: cinzas alternados (sem azul/verde/laranja).
    let grays: [UInt32] = style.colors.dark ? [0x48484A, 0x636366, 0x3A3A3C] : [0x48484A, 0x8E8E93, 0x2C2C2E]
    return UIColor(clHex: grays[index % grays.count])
  }

  private func swipeConfiguration(_ indexPath: IndexPath, leading: Bool) -> UISwipeActionsConfiguration? {
    guard swipeEnabled, mode == "list", !style.selectionMode,
          let id = dataSource.itemIdentifier(for: indexPath),
          let row = rows[id], row.kind == "r" else { return nil }
    let list = Array((leading ? row.swipeLeft : row.swipe).prefix(3))
    if list.isEmpty { return nil }
    var actions: [UIContextualAction] = []
    for (i, a) in list.enumerated() {
      let act = UIContextualAction(style: .normal, title: labels.action(a, starred: row.starred)) { [weak self] _, _, done in
        UISelectionFeedbackGenerator().selectionChanged()
        self?.onRowAction(["id": id, "action": a, "source": "swipe"])
        done(true)
      }
      act.image = DVGlyphs.image(DVGlyphs.actionSymbol(a, starred: row.starred), size: 17, weight: .medium, color: .white)
      act.backgroundColor = swipeColor(a, index: i)
      actions.append(act)
    }
    let cfg = UISwipeActionsConfiguration(actions: actions)
    cfg.performsFirstActionWithFullSwipe = true
    return cfg
  }

  // MARK: - UICollectionViewDelegate

  private func tappable(_ indexPath: IndexPath) -> Bool {
    guard let id = dataSource.itemIdentifier(for: indexPath), let r = rows[id] else { return false }
    return r.kind == "r"
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
    if style.selectionMode { UISelectionFeedbackGenerator().selectionChanged() }
    onRowPress(["id": id])
  }

  // MARK: - Toque longo: prévia + menu

  public func collectionView(_ collectionView: UICollectionView, contextMenuConfigurationForItemAt indexPath: IndexPath, point: CGPoint) -> UIContextMenuConfiguration? {
    guard !style.selectionMode,
          let id = dataSource.itemIdentifier(for: indexPath),
          let row = rows[id], row.kind == "r" else { return nil }
    if row.menu.isEmpty {
      onLongPress(["id": id])
      return nil
    }
    let st = style
    let lb = labels
    return UIContextMenuConfiguration(identifier: id as NSString, previewProvider: {
      return DVPreviewController(row: row, style: st)
    }, actionProvider: { [weak self] _ in
      var items: [UIMenuElement] = []
      for a in row.menu {
        let act = UIAction(
          title: lb.action(a, starred: row.starred),
          image: UIImage(systemName: DVGlyphs.actionSymbol(a, starred: row.starred)),
          attributes: DVGlyphs.isDestructive(a) ? .destructive : []
        ) { _ in
          self?.onRowAction(["id": id, "action": a, "source": "menu"])
        }
        items.append(act)
      }
      return UIMenu(title: "", children: items)
    })
  }

  public func collectionView(_ collectionView: UICollectionView, willPerformPreviewActionForMenuWith configuration: UIContextMenuConfiguration, animator: UIContextMenuInteractionCommitAnimating) {
    guard let id = configuration.identifier as? String else { return }
    animator.preferredCommitStyle = .dismiss
    animator.addCompletion { [weak self] in
      self?.onRowPress(["id": id])
    }
  }

  // MARK: - UIScrollViewDelegate

  public func scrollViewDidScroll(_ scrollView: UIScrollView) {
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

// MARK: - Prévia do toque longo

/// Miniatura grande (foto/vídeo, recarregada em resolução maior) ou cartão com
/// o glifo do tipo + nome + detalhes (pastas e documentos).
final class DVPreviewController: UIViewController {
  private let row: DVRow
  private let style: DVStyle
  private let imageView = UIImageView()
  private let glyph = UIImageView()
  private let titleLabel = UILabel()
  private let subLabel = UILabel()
  private let play = UIImageView()

  init(row: DVRow, style: DVStyle) {
    self.row = row
    self.style = style
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = style.card
    imageView.contentMode = .scaleAspectFill
    imageView.clipsToBounds = true
    view.addSubview(imageView)
    glyph.contentMode = .center
    view.addSubview(glyph)
    titleLabel.numberOfLines = 2
    titleLabel.textAlignment = .center
    titleLabel.lineBreakMode = .byTruncatingMiddle
    view.addSubview(titleLabel)
    subLabel.textAlignment = .center
    view.addSubview(subLabel)
    play.contentMode = .center
    play.backgroundColor = UIColor(white: 0, alpha: 0.45)
    play.layer.cornerRadius = 24
    play.clipsToBounds = true
    play.isHidden = true
    view.addSubview(play)

    let small = row.thumb.isEmpty ? nil : DVThumbLoader.shared.cached(row.thumb, px: DVMetrics.thumbPx)
    if let img = small {
      showImage(img)
    } else {
      showCard()
    }
    if !row.thumb.isEmpty {
      // Resolução maior (só memória/disco desta chave); troca quando chegar.
      DVThumbLoader.shared.load(row.thumb, px: 1080) { [weak self] img in
        guard let self = self, let img = img else { return }
        self.showImage(img)
      }
    }
  }

  private func showCard() {
    imageView.isHidden = true
    play.isHidden = true
    glyph.isHidden = false
    titleLabel.isHidden = false
    subLabel.isHidden = row.sub.isEmpty
    glyph.image = DVGlyphs.image(DVGlyphs.symbol(row.glyph), size: 56, weight: .light, color: style.colors.sub)
    titleLabel.attributedText = NSAttributedString(string: row.title, attributes: [
      .font: UIFont.systemFont(ofSize: 16, weight: .semibold), .foregroundColor: style.colors.text,
    ])
    subLabel.attributedText = NSAttributedString(string: row.sub, attributes: [
      .font: UIFont.systemFont(ofSize: 13), .foregroundColor: style.colors.sub,
    ])
    preferredContentSize = CGSize(width: 280, height: 230)
    view.setNeedsLayout()
  }

  private func showImage(_ img: UIImage) {
    imageView.image = img
    imageView.isHidden = false
    glyph.isHidden = true
    titleLabel.isHidden = true
    subLabel.isHidden = true
    play.isHidden = !row.video
    play.image = DVGlyphs.image("play.fill", size: 20, weight: .semibold, color: .white)
    let maxW = min(UIScreen.main.bounds.width - 40, 380)
    let maxH = min(UIScreen.main.bounds.height * 0.55, 520)
    let s = img.size
    if s.width > 0 && s.height > 0 {
      let k = min(maxW / s.width, maxH / s.height)
      preferredContentSize = CGSize(width: floor(s.width * k), height: floor(s.height * k))
    } else {
      preferredContentSize = CGSize(width: maxW, height: maxW)
    }
    view.setNeedsLayout()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    let b = view.bounds
    imageView.frame = b
    play.frame = CGRect(x: (b.width - 48) / 2, y: (b.height - 48) / 2, width: 48, height: 48)
    glyph.frame = CGRect(x: 0, y: 26, width: b.width, height: 90)
    let ts = titleLabel.sizeThatFits(CGSize(width: b.width - 32, height: 60))
    titleLabel.frame = CGRect(x: 16, y: 126, width: b.width - 32, height: min(44, ceil(ts.height)))
    subLabel.frame = CGRect(x: 16, y: titleLabel.frame.maxY + 6, width: b.width - 32, height: 18)
  }
}
