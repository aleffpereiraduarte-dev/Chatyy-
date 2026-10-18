import ExpoModulesCore
import UIKit

// [2026-10-18 native-apps-grid] Painel "Apps" nativo (iOS).
//   • busca fixa no topo (UITextField; filtra ao vivo sem acento/caixa — mesma
//     regra do JS: título da seção casa → seção inteira);
//   • seções do UICollectionViewCompositionalLayout:
//       "bia"   cartão da Bia (só sem busca)
//       "strip" Recentes: fixados + MRU, rolagem ortogonal (até 8)
//       "fav"   modo editar: fixados em grade, reordenáveis arrastando
//       "sec:*" grade 4 colunas por seção
//       "empty" sem resultados
//   • segurar um app = modo editar (tremor); tocar fixa/tira; segurar um fixado
//     e arrastar reordena (diffable reorderingHandlers);
//   • puxar p/ baixo no topo e soltar = onPullDismiss (o JS fecha a folha);
//   • altura do conteúdo → onContentHeight (a folha JS se ajusta).
// Ids de item: "bia", "empty", "s:<app>", "f:<app>", "g:<seção>:<app>".
// Mesmo contrato do Android (ChatyyAppsGridView.kt).

public final class ChatyyAppsGridView: ExpoView, UICollectionViewDelegate, UITextFieldDelegate {
  let onAppPress = EventDispatcher()
  let onEditingChange = EventDispatcher()
  let onPinnedChange = EventDispatcher()
  let onQueryChange = EventDispatcher()
  let onContentHeight = EventDispatcher()
  let onPullDismiss = EventDispatcher()
  let onNativeError = EventDispatcher()

  private static let stripMax = 8
  private static let side: CGFloat = 16
  private static let searchH: CGFloat = 44
  private static let searchGap: CGFloat = 14
  // [2026-10-18 apps-compact] ladrilho 48 pt + rótulo 12 pt (até 2 linhas) — estilo Outlook.
  private static let tileH: CGFloat = 90
  private static let stripH: CGFloat = 98

  private var collectionView: UICollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<String, String>!
  private let searchBox = UIView()
  private let searchIcon = UIImageView()
  private let field = UITextField()
  private let clearButton = UIButton(type: .custom)
  private var longPress: UILongPressGestureRecognizer!

  // Props
  private var sections: [APSection] = []
  private var itemById: [String: APItem] = [:]
  private var recent: [String] = []
  private var pinned: [String] = []
  private var badges: [String: Int] = [:]
  private var labels: [String: String] = [:]
  private var dark = false
  private var theme = APTheme(dark: false)
  private var editing = false
  private var rawQuery = ""
  private var query = ""
  private var bottomInset: CGFloat = 0
  private var resetSeq = Int.min
  private var searchEnabled = true

  // Estado
  private var dirty = true
  private var styleDirty = true
  private var labelsDirty = true
  private var appliedOnce = false
  private var pendingIntro = false
  private var introDeferred = false
  private var sectionIds: [String] = []
  private var sectionTitles: [String: String] = [:]
  private var itemMap: [String: String] = [:]
  private var stripSet = Set<String>()
  private var lastContentH: CGFloat = -1
  private var moving = false
  private weak var movingCell: APTileCell?

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true

    // Busca
    searchBox.layer.cornerRadius = 14
    searchBox.layer.cornerCurve = .continuous
    searchIcon.contentMode = .center
    searchBox.addSubview(searchIcon)
    field.font = UIFont.systemFont(ofSize: 16)
    field.borderStyle = .none
    field.autocorrectionType = .no
    field.autocapitalizationType = .none
    field.spellCheckingType = .no
    field.returnKeyType = .search
    field.clearButtonMode = .never
    field.delegate = self
    field.addTarget(self, action: #selector(queryChanged), for: .editingChanged)
    searchBox.addSubview(field)
    clearButton.isHidden = true
    clearButton.addTarget(self, action: #selector(clearQuery), for: .touchUpInside)
    searchBox.addSubview(clearButton)
    addSubview(searchBox)

    // Lista
    let layout = UICollectionViewCompositionalLayout(sectionProvider: { [weak self] index, env in
      return self?.layoutSection(at: index, env: env) ?? ChatyyAppsGridView.fallbackSection()
    })
    let cv = UICollectionView(frame: bounds, collectionViewLayout: layout)
    cv.backgroundColor = .clear
    cv.alwaysBounceVertical = true
    cv.showsVerticalScrollIndicator = false
    cv.contentInsetAdjustmentBehavior = .never
    cv.keyboardDismissMode = .onDrag
    cv.delaysContentTouches = false
    cv.clipsToBounds = true
    cv.delegate = self
    addSubview(cv)
    collectionView = cv

    let tileReg = UICollectionView.CellRegistration<APTileCell, String> { [weak self] cell, _, iid in
      self?.configureTile(cell, iid: iid)
    }
    let biaReg = UICollectionView.CellRegistration<APBiaCell, String> { [weak self] cell, _, _ in
      guard let self = self else { return }
      cell.configure(theme: self.theme, labels: self.labels)
      cell.onVoice = { [weak self] in
        guard let self = self, !self.editing else { return }
        self.field.resignFirstResponder()
        self.onAppPress(["id": "one", "voice": true])
      }
    }
    let emptyReg = UICollectionView.CellRegistration<APEmptyCell, String> { [weak self] cell, _, _ in
      guard let self = self else { return }
      cell.configure(theme: self.theme, text: self.labels["noResults"] ?? "")
    }
    let headerReg = UICollectionView.SupplementaryRegistration<APHeaderView>(elementKind: UICollectionView.elementKindSectionHeader) { [weak self] view, _, ip in
      guard let self = self else { return }
      let sid = ip.section < self.sectionIds.count ? self.sectionIds[ip.section] : ""
      view.configure(self.sectionTitles[sid] ?? "", theme: self.theme)
    }
    dataSource = UICollectionViewDiffableDataSource<String, String>(collectionView: cv) { collectionView, indexPath, iid in
      if iid == "bia" {
        return collectionView.dequeueConfiguredReusableCell(using: biaReg, for: indexPath, item: iid)
      }
      if iid == "empty" {
        return collectionView.dequeueConfiguredReusableCell(using: emptyReg, for: indexPath, item: iid)
      }
      return collectionView.dequeueConfiguredReusableCell(using: tileReg, for: indexPath, item: iid)
    }
    dataSource.supplementaryViewProvider = { collectionView, _, indexPath in
      return collectionView.dequeueConfiguredReusableSupplementary(using: headerReg, for: indexPath)
    }
    dataSource.reorderingHandlers.canReorderItem = { iid in
      return iid.hasPrefix("f:")
    }
    dataSource.reorderingHandlers.didReorder = { [weak self] tx in
      self?.didReorder(tx.finalSnapshot)
    }

    let lp = UILongPressGestureRecognizer(target: self, action: #selector(onLongPress(_:)))
    lp.minimumPressDuration = 0.38
    // [2026-10-18 apps-compact] sem modo editar/fixar (founder quer simples).
    lp.isEnabled = false
    cv.addGestureRecognizer(lp)
    longPress = lp
  }

  // MARK: Props

  func setSections(_ list: [[String: Any]]) {
    var out: [APSection] = []
    var map: [String: APItem] = [:]
    var seen = Set<String>()
    for d in list {
      let s = APSection(d)
      if s.key.isEmpty || seen.contains(s.key) { continue }
      seen.insert(s.key)
      out.append(s)
      for it in s.items where map[it.id] == nil { map[it.id] = it }
    }
    sections = out
    itemById = map
    dirty = true
  }

  func setRecent(_ v: [String]) {
    if v == recent { return }
    recent = v
    dirty = true
  }

  func setPinned(_ v: [String]) {
    if moving || v == pinned { return }
    pinned = v
    dirty = true
  }

  func setBadges(_ d: [String: Any]) {
    var out: [String: Int] = [:]
    for (k, v) in d {
      let n = CLVal.int(v)
      if n > 0 { out[k] = n }
    }
    if out == badges { return }
    badges = out
    dirty = true
  }

  func setLabels(_ d: [String: Any]) {
    var out: [String: String] = [:]
    for (k, v) in d { out[k] = CLVal.str(v) }
    if out == labels { return }
    labels = out
    labelsDirty = true
    dirty = true
  }

  func setDark(_ v: Bool) {
    if v == dark && appliedOnce { return }
    dark = v
    styleDirty = true
  }

  func setEditing(_ v: Bool) {
    if v == editing { return }
    editing = v
    longPress?.minimumPressDuration = v ? 0.22 : 0.38
    dirty = true
  }

  func setBottomInset(_ v: Double) {
    let c = CGFloat(max(0, v))
    if abs(c - bottomInset) < 0.5 { return }
    bottomInset = c
    collectionView.contentInset.bottom = c + 8
    setNeedsLayout()
  }

  func setResetSeq(_ v: Int) {
    if v == resetSeq { return }
    resetSeq = v
    field.text = ""
    rawQuery = ""
    query = ""
    clearButton.isHidden = true
    if field.isFirstResponder { field.resignFirstResponder() }
    collectionView.setContentOffset(.zero, animated: false)
    pendingIntro = true
    dirty = true
  }

  func setSearchEnabled(_ v: Bool) {
    if v == searchEnabled { return }
    searchEnabled = v
    if !v && field.isFirstResponder { field.resignFirstResponder() }
    setNeedsLayout()
  }

  func commitProps() {
    if styleDirty {
      styleDirty = false
      theme = APTheme(dark: dark)
      backgroundColor = theme.bg
      searchBox.backgroundColor = theme.fieldBg
      searchIcon.image = APText.image("magnifyingglass", pointSize: 16, weight: .medium, color: theme.muted)
      clearButton.setImage(APText.image("xmark.circle.fill", pointSize: 17, weight: .regular, color: theme.muted), for: .normal)
      field.textColor = theme.text
      field.tintColor = theme.text
      field.keyboardAppearance = dark ? .dark : .light
      labelsDirty = true
      dirty = true
    }
    if labelsDirty {
      labelsDirty = false
      let ph = labels["search"] ?? ""
      field.attributedPlaceholder = NSAttributedString(string: ph, attributes: [.foregroundColor: theme.muted])
      field.accessibilityLabel = ph
      clearButton.accessibilityLabel = labels["clear"] ?? ""
    }
    if collectionView.contentInset.bottom < bottomInset + 8 {
      collectionView.contentInset.bottom = bottomInset + 8
    }
    apply()
  }

  // MARK: Snapshot

  private func apply() {
    if !dirty { return }
    dirty = false
    let q = query
    var snap = NSDiffableDataSourceSnapshot<String, String>()
    var ids: [String] = []
    var titles: [String: String] = [:]
    var map: [String: String] = [:]
    // [2026-10-18 apps-compact] sem cartão da Bia (vira ladrilho com o orb) e sem
    // faixa Recentes / fixados: uma grade só, altura do conteúdo.
    let strip = Set<String>()

    var anyGrid = false
    for s in sections {
      let secHit = !q.isEmpty && s.norm.contains(q)
      // [2026-10-18 apps-compact] "featured" (Bia) fica na grade como ladrilho normal.
      let items = s.items.filter { it in
        q.isEmpty || secHit || it.norm.contains(q)
      }
      if items.isEmpty { continue }
      let sid = "sec:" + s.key
      snap.appendSections([sid])
      let iids = items.map { "g:" + s.key + ":" + $0.id }
      snap.appendItems(iids, toSection: sid)
      for (i, it) in items.enumerated() { map[iids[i]] = it.id }
      ids.append(sid)
      titles[sid] = s.title
      anyGrid = true
    }
    if !q.isEmpty && !anyGrid {
      snap.appendSections(["empty"])
      snap.appendItems(["empty"], toSection: "empty")
      ids.append("empty")
    }

    let old = Set(dataSource.snapshot().itemIdentifiers)
    let keep = snap.itemIdentifiers.filter { old.contains($0) }
    if !keep.isEmpty { snap.reconfigureItems(keep) }

    sectionIds = ids
    sectionTitles = titles
    itemMap = map
    stripSet = strip
    let intro = pendingIntro
    let animate = appliedOnce && window != nil && !intro && !UIAccessibility.isReduceMotionEnabled
    appliedOnce = true
    dataSource.apply(snap, animatingDifferences: animate) { [weak self] in
      guard let self = self else { return }
      // Cabeçalhos visíveis (títulos/tema podem ter mudado sem mudar a seção).
      for case let h as APHeaderView in self.collectionView.visibleSupplementaryViews(ofKind: UICollectionView.elementKindSectionHeader) {
        if let ip = self.indexPathOf(header: h), ip.section < self.sectionIds.count {
          h.configure(self.sectionTitles[self.sectionIds[ip.section]] ?? "", theme: self.theme)
        }
      }
      self.reportContentHeight()
      if self.pendingIntro {
        self.pendingIntro = false
        if self.window != nil { self.playIntro() } else { self.introDeferred = true }
      }
    }
  }

  private func indexPathOf(header: APHeaderView) -> IndexPath? {
    let kind = UICollectionView.elementKindSectionHeader
    for ip in collectionView.indexPathsForVisibleSupplementaryElements(ofKind: kind) {
      if collectionView.supplementaryView(forElementKind: kind, at: ip) === header { return ip }
    }
    return nil
  }

  private func configureTile(_ cell: APTileCell, iid: String) {
    guard let appId = itemMap[iid], let item = itemById[appId] else { return }
    let isStrip = iid.hasPrefix("s:")
    let isGrid = iid.hasPrefix("g:")
    var badge = badges[appId] ?? 0
    // Badge só UMA vez: na faixa Recentes se o app estiver lá; senão na grade.
    if isGrid && stripSet.contains(appId) { badge = 0 }
    let seed = abs(appId.hashValue % 97)
    cell.configure(item: item, theme: theme, badgeCount: badge, editing: editing,
                   pinned: pinned.contains(appId), singleLine: isStrip, seed: seed, labels: labels)
  }

  // MARK: Layout

  private static func fallbackSection() -> NSCollectionLayoutSection {
    let size = NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .absolute(1))
    let item = NSCollectionLayoutItem(layoutSize: size)
    let group = NSCollectionLayoutGroup.horizontal(layoutSize: size, subitems: [item])
    return NSCollectionLayoutSection(group: group)
  }

  private func layoutSection(at index: Int, env: NSCollectionLayoutEnvironment) -> NSCollectionLayoutSection {
    let side = ChatyyAppsGridView.side
    let sid = index < sectionIds.count ? sectionIds[index] : ""
    if sid == "bia" || sid == "empty" {
      let h: CGFloat = sid == "bia" ? 78 : 170
      let size = NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .absolute(h))
      let item = NSCollectionLayoutItem(layoutSize: size)
      let group = NSCollectionLayoutGroup.horizontal(layoutSize: size, subitems: [item])
      let sec = NSCollectionLayoutSection(group: group)
      sec.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: side, bottom: sid == "bia" ? 20 : 0, trailing: side)
      return sec
    }
    let hasTitle = !(sectionTitles[sid] ?? "").isEmpty
    let headerSize = NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .absolute(22))
    let header = NSCollectionLayoutBoundarySupplementaryItem(layoutSize: headerSize,
                                                             elementKind: UICollectionView.elementKindSectionHeader,
                                                             alignment: .top)
    if sid == "strip" {
      let width = env.container.effectiveContentSize.width
      let colW = max(64, floor((width - side * 2) / 4))
      let size = NSCollectionLayoutSize(widthDimension: .absolute(colW), heightDimension: .absolute(ChatyyAppsGridView.stripH))
      let item = NSCollectionLayoutItem(layoutSize: size)
      let group = NSCollectionLayoutGroup.horizontal(layoutSize: size, subitems: [item])
      let sec = NSCollectionLayoutSection(group: group)
      sec.orthogonalScrollingBehavior = .continuous
      sec.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: side, bottom: 12, trailing: side)
      sec.boundarySupplementaryItems = [header]
      return sec
    }
    let itemSize = NSCollectionLayoutSize(widthDimension: .fractionalWidth(0.25), heightDimension: .absolute(ChatyyAppsGridView.tileH))
    let item = NSCollectionLayoutItem(layoutSize: itemSize)
    let groupSize = NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .absolute(ChatyyAppsGridView.tileH))
    let group = NSCollectionLayoutGroup.horizontal(layoutSize: groupSize, subitems: [item])
    let sec = NSCollectionLayoutSection(group: group)
    sec.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: side, bottom: 6, trailing: side)
    if hasTitle { sec.boundarySupplementaryItems = [header] }
    return sec
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    let w = bounds.width
    let side = ChatyyAppsGridView.side
    let sh = ChatyyAppsGridView.searchH
    var y: CGFloat = 0
    if searchEnabled {
      searchBox.isHidden = false
      searchBox.frame = CGRect(x: side, y: 0, width: max(0, w - side * 2), height: sh)
      let bw = searchBox.bounds.width
      searchIcon.frame = CGRect(x: 10, y: 0, width: 22, height: sh)
      clearButton.frame = CGRect(x: bw - 36, y: (sh - 32) / 2, width: 32, height: 32)
      field.frame = CGRect(x: 38, y: 0, width: max(0, bw - 38 - 38), height: sh)
      y = sh + ChatyyAppsGridView.searchGap
    } else {
      searchBox.isHidden = true
    }
    let f = CGRect(x: 0, y: y, width: w, height: max(0, bounds.height - y))
    if collectionView.frame != f { collectionView.frame = f }
    reportContentHeight()
  }

  private func reportContentHeight() {
    guard bounds.width > 0 else { return }
    collectionView.layoutIfNeeded()
    let content = collectionView.collectionViewLayout.collectionViewContentSize.height
    let top = searchEnabled ? ChatyyAppsGridView.searchH + ChatyyAppsGridView.searchGap : 0
    let h = ceil(top + content + collectionView.contentInset.bottom)
    if abs(h - lastContentH) > 0.5 {
      lastContentH = h
      onContentHeight(["height": Double(h)])
    }
  }

  // MARK: Intro (cascata ao abrir)

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil && introDeferred {
      introDeferred = false
      DispatchQueue.main.async { [weak self] in self?.playIntro() }
    }
  }

  private func playIntro() {
    guard window != nil, !UIAccessibility.isReduceMotionEnabled else { return }
    collectionView.layoutIfNeeded()
    var views: [(UIView, CGRect)] = []
    for c in collectionView.visibleCells {
      views.append((c.contentView, c.convert(c.bounds, to: collectionView)))
    }
    for h in collectionView.visibleSupplementaryViews(ofKind: UICollectionView.elementKindSectionHeader) {
      views.append((h, h.convert(h.bounds, to: collectionView)))
    }
    let colW = max(1, collectionView.bounds.width / 4)
    let top = collectionView.contentOffset.y
    for (v, r) in views {
      let row = max(0, Int((r.minY - top) / 90))
      let col = max(0, min(3, Int(r.minX / colW)))
      let delay = min(0.52, 0.03 + Double(row) * 0.055 + Double(col) * 0.022)
      v.alpha = 0
      v.transform = CGAffineTransform(translationX: 0, y: 8).scaledBy(x: 0.92, y: 0.92)
      UIView.animate(withDuration: 0.5, delay: delay, usingSpringWithDamping: 0.82, initialSpringVelocity: 0.3,
                     options: [.allowUserInteraction, .beginFromCurrentState], animations: {
        v.alpha = 1
        v.transform = .identity
      }, completion: nil)
    }
  }

  // MARK: Ações

  private func setEditingInternal(_ v: Bool) {
    if v == editing { return }
    editing = v
    longPress.minimumPressDuration = v ? 0.22 : 0.38
    if v {
      UIImpactFeedbackGenerator(style: .medium).impactOccurred()
      if field.isFirstResponder { field.resignFirstResponder() }
    }
    dirty = true
    apply()
    onEditingChange(["editing": v])
  }

  private func togglePin(_ id: String) {
    UISelectionFeedbackGenerator().selectionChanged()
    if let i = pinned.firstIndex(of: id) {
      pinned.remove(at: i)
    } else {
      pinned.append(id)
      if pinned.count > ChatyyAppsGridView.stripMax {
        pinned.removeFirst(pinned.count - ChatyyAppsGridView.stripMax)
      }
    }
    dirty = true
    apply()
    onPinnedChange(["ids": pinned])
  }

  private func didReorder(_ fin: NSDiffableDataSourceSnapshot<String, String>) {
    guard fin.indexOfSection("fav") != nil else { return }
    var next: [String] = []
    for iid in fin.itemIdentifiers(inSection: "fav") where iid.hasPrefix("f:") {
      next.append(String(iid.dropFirst(2)))
    }
    for k in pinned where !next.contains(k) { next.append(k) }
    if next == pinned { return }
    pinned = next
    UISelectionFeedbackGenerator().selectionChanged()
    onPinnedChange(["ids": pinned])
  }

  @objc private func onLongPress(_ g: UILongPressGestureRecognizer) {
    let p = g.location(in: collectionView)
    switch g.state {
    case .began:
      guard let ip = collectionView.indexPathForItem(at: p),
            let iid = dataSource.itemIdentifier(for: ip),
            let appId = itemMap[iid] else { return }
      if !editing {
        setEditingInternal(true)
        return
      }
      if iid.hasPrefix("f:") {
        if collectionView.beginInteractiveMovementForItem(at: ip) {
          moving = true
          UIImpactFeedbackGenerator(style: .medium).impactOccurred()
          if let c = collectionView.cellForItem(at: ip) as? APTileCell {
            movingCell = c
            c.setLifted(true)
          }
        }
      } else {
        togglePin(appId)
      }
    case .changed:
      if moving { collectionView.updateInteractiveMovementTargetPosition(p) }
    case .ended:
      if moving {
        moving = false
        collectionView.endInteractiveMovement()
        movingCell?.setLifted(false)
        movingCell = nil
      }
    default:
      if moving {
        moving = false
        collectionView.cancelInteractiveMovement()
        movingCell?.setLifted(false)
        movingCell = nil
      }
    }
  }

  @objc private func queryChanged() {
    rawQuery = field.text ?? ""
    let n = APText.norm(rawQuery.trimmingCharacters(in: .whitespacesAndNewlines))
    clearButton.isHidden = rawQuery.isEmpty
    if n == query { return }
    query = n
    if editing && !n.isEmpty {
      editing = false
      longPress.minimumPressDuration = 0.38
      onEditingChange(["editing": false])
    }
    dirty = true
    apply()
    onQueryChange(["q": rawQuery])
  }

  @objc private func clearQuery() {
    UISelectionFeedbackGenerator().selectionChanged()
    field.text = ""
    queryChanged()
  }

  public func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    textField.resignFirstResponder()
    return true
  }

  // MARK: UICollectionViewDelegate

  public func collectionView(_ collectionView: UICollectionView, shouldHighlightItemAt indexPath: IndexPath) -> Bool {
    return dataSource.itemIdentifier(for: indexPath) != "empty"
  }

  public func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: false)
    guard let iid = dataSource.itemIdentifier(for: indexPath) else { return }
    if iid == "empty" { return }
    if iid == "bia" {
      if editing { setEditingInternal(false); return }
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
      field.resignFirstResponder()
      onAppPress(["id": "one"])
      return
    }
    guard let appId = itemMap[iid] else { return }
    if editing {
      togglePin(appId)
      return
    }
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    field.resignFirstResponder()
    onAppPress(["id": appId])
  }

  public func collectionView(_ collectionView: UICollectionView,
                             targetIndexPathForMoveFromItemAt originalIndexPath: IndexPath,
                             toProposedIndexPath proposedIndexPath: IndexPath) -> IndexPath {
    return proposedIndexPath.section == originalIndexPath.section ? proposedIndexPath : originalIndexPath
  }

  // Puxar p/ baixo no topo e soltar → fechar (o JS anima a folha).
  public func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint,
                                        targetContentOffset: UnsafeMutablePointer<CGPoint>) {
    let y = scrollView.contentOffset.y
    if y < -72 || (y < -24 && velocity.y < -1.4) {
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
      field.resignFirstResponder()
      onPullDismiss()
    }
  }
}
