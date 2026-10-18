import ExpoModulesCore
import UIKit

// [2026-10-18 chat-info-native] "Dados do contato" / "Dados do grupo" em
// NATIVO (WhatsApp iOS): UICollectionView compositional + diffable data
// source. Hero (foto grande, nome, subtítulo, ações), cartões agrupados
// (linhas, recado/descrição, faixa de mídia) e a lista de MEMBROS
// virtualizada na mesma lista (células reaproveitadas → 256+ membros lisos,
// paginação por onMembersEnd, busca por onMemberQuery com debounce).
// Contrato em CIModels.swift. JS: components/chat/NativeChatInfo.js.
public final class ChatyyChatInfoView: ExpoView, UICollectionViewDelegate {
  let onRowPress = EventDispatcher()
  let onToggle = EventDispatcher()
  let onAction = EventDispatcher()
  let onAvatarPress = EventDispatcher()
  let onMediaPress = EventDispatcher()
  let onMemberPress = EventDispatcher()
  let onMembersEnd = EventDispatcher()
  let onMemberQuery = EventDispatcher()
  let onFirstPaint = EventDispatcher()
  let onNativeError = EventDispatcher()
  let onClose = EventDispatcher()

  private var collectionView: CLCollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<String, String>!

  private var hero = CIHero()
  private var rows: [String: CIRow] = [:]
  private var rowOrder: [String] = []
  private var media: [CIMedia] = []
  private var members = CIMembers()
  private var memberMap: [String: CIMember] = [:]
  private var memberActionMap: [String: CIMemberAction] = [:]
  private var memberIndex: [String: Int] = [:]

  private var dirty = Set<String>()
  private var needsApply = true
  private var appliedOnce = false
  private var firstPaintSent = false

  private var palette = STPalette(dark: false)
  private var paletteDirty = true
  private var dark = false
  private var colorsRaw: [String: Any]? = nil
  private var labels = CLLabels()
  private var maxContentWidth: CGFloat = 0
  private var bottomInset: CGFloat = 0
  private var keyboardInset: CGFloat = 0

  private var captionTexts: [String: String] = [:]
  private var positions: [String: (first: Bool, last: Bool)] = [:]
  private var sectionIds: [String] = []
  private var memberQuery = ""
  private var queryWork: DispatchWorkItem?
  private var endAskedAt = -1

  // [2026-10-18 elegance] Cabeçalho que encolhe (headerMode = "collapse").
  private var collapsing = false
  private var header: CIHeaderOverlay?
  private var headerDirty = true
  private var heroHeightApplied: CGFloat = 0
  private var expandTarget: CGFloat = 0
  private var expandValue: CGFloat = 0
  private var expandVel: CGFloat = 0
  private var photoInset: CGFloat = 0
  private var adjustingInset = false
  private var displayLink: CADisplayLink?
  private let expandHaptic = UIImpactFeedbackGenerator(style: .medium)
  private var photoTap: UITapGestureRecognizer?
  private let photoTapDelegate = CIGestureGate()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    setupCollection()
    NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    queryWork?.cancel()
    displayLink?.invalidate()
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
    addSubview(cv)
    collectionView = cv

    let heroReg = UICollectionView.CellRegistration<CIHeroCell, String> { [weak self] cell, _, _ in
      guard let self = self else { return }
      cell.configure(self.hero, palette: self.palette, avatarLabel: self.labels.get("photo", "Ver foto"))
      cell.onAvatar = { [weak self] in self?.onAvatarPress([:]) }
      cell.onAction = { [weak self] key in self?.onAction(["key": key]) }
    }
    let captionReg = UICollectionView.CellRegistration<CICaptionCell, String> { [weak self] cell, _, id in
      guard let self = self else { return }
      cell.configure(self.captionTexts[id] ?? "", footer: id.hasPrefix("f|"), palette: self.palette)
    }
    let rowReg = UICollectionView.CellRegistration<CIRowCell, String> { [weak self] cell, _, id in
      self?.bindRow(cell, id: id)
    }
    let aboutReg = UICollectionView.CellRegistration<CIAboutCell, String> { [weak self] cell, _, id in
      guard let self = self, let r = self.rows[String(id.dropFirst(2))] else { return }
      let pos = self.positions[id] ?? (first: true, last: true)
      cell.configure(r, palette: self.palette, first: pos.first, last: pos.last)
    }
    let mediaReg = UICollectionView.CellRegistration<CIMediaCell, String> { [weak self] cell, _, id in
      guard let self = self, let r = self.rows[String(id.dropFirst(2))] else { return }
      let pos = self.positions[id] ?? (first: true, last: true)
      cell.configure(r, items: self.media, palette: self.palette, first: pos.first, last: pos.last)
      cell.onSeeAll = { [weak self] in self?.onMediaPress(["key": ""]) }
      cell.onItem = { [weak self] key in self?.onMediaPress(["key": key]) }
    }
    let memberReg = UICollectionView.CellRegistration<CIMemberCell, String> { [weak self] cell, _, id in
      guard let self = self, let m = self.memberMap[String(id.dropFirst(2))] else { return }
      let pos = self.positions[id] ?? (first: false, last: false)
      cell.configure(m, palette: self.palette, first: pos.first, last: pos.last)
    }
    let searchReg = UICollectionView.CellRegistration<CISearchCell, String> { [weak self] cell, _, id in
      guard let self = self else { return }
      let pos = self.positions[id] ?? (first: true, last: false)
      cell.configure(placeholder: self.members.search, text: self.memberQuery, palette: self.palette, first: pos.first, last: pos.last)
      cell.onChange = { [weak self] text in self?.queryChanged(text) }
    }
    let textReg = UICollectionView.CellRegistration<CITextCell, String> { [weak self] cell, _, _ in
      guard let self = self else { return }
      cell.configure(text: self.members.empty, loading: self.members.loading, palette: self.palette)
    }
    let spacerReg = UICollectionView.CellRegistration<CIHeroSpacerCell, String> { [weak self] cell, _, _ in
      cell.onTouch = { [weak self] phase, touch in self?.heroTouch(phase, touch) }
    }
    dataSource = UICollectionViewDiffableDataSource<String, String>(collectionView: cv) { [weak self] collectionView, indexPath, id in
      if id == "hero2" {
        return collectionView.dequeueConfiguredReusableCell(using: spacerReg, for: indexPath, item: id)
      }
      if id == "hero" {
        return collectionView.dequeueConfiguredReusableCell(using: heroReg, for: indexPath, item: id)
      }
      if id.hasPrefix("h|") || id.hasPrefix("f|") {
        return collectionView.dequeueConfiguredReusableCell(using: captionReg, for: indexPath, item: id)
      }
      if id == "ms" {
        return collectionView.dequeueConfiguredReusableCell(using: searchReg, for: indexPath, item: id)
      }
      if id == "mx" {
        return collectionView.dequeueConfiguredReusableCell(using: textReg, for: indexPath, item: id)
      }
      if id.hasPrefix("m|") {
        return collectionView.dequeueConfiguredReusableCell(using: memberReg, for: indexPath, item: id)
      }
      if id.hasPrefix("r|"), let r = self?.rows[String(id.dropFirst(2))] {
        if r.kind == "about" {
          return collectionView.dequeueConfiguredReusableCell(using: aboutReg, for: indexPath, item: id)
        }
        if r.kind == "media" {
          return collectionView.dequeueConfiguredReusableCell(using: mediaReg, for: indexPath, item: id)
        }
      }
      return collectionView.dequeueConfiguredReusableCell(using: rowReg, for: indexPath, item: id)
    }
  }

  private func bindRow(_ cell: CIRowCell, id: String) {
    let pos = positions[id] ?? (first: true, last: true)
    var row = CIRow()
    if id.hasPrefix("ma|") {
      // Linha de ação da lista de membros (Adicionar membros / Convidar via link).
      guard let a = memberActionMap[String(id.dropFirst(3))] else { return }
      row.id = a.id
      row.kind = "a"
      row.title = a.title
      row.icon = a.icon
    } else {
      guard let r = rows[String(id.dropFirst(2))] else { return }
      row = r
    }
    cell.configure(row, palette: palette, first: pos.first, last: pos.last)
    cell.onToggle = { [weak self] rid, value in
      guard let self = self else { return }
      if var r = self.rows[rid] {
        r.on = value
        self.rows[rid] = r
      }
      self.onToggle(["id": rid, "value": value])
    }
  }

  private func makeLayout() -> UICollectionViewLayout {
    let layout = UICollectionViewCompositionalLayout { [weak self] sectionIndex, env in
      return self?.sectionLayout(sectionIndex, env)
    }
    layout.register(CICardBackground.self, forDecorationViewOfKind: CICardBackground.kind)
    return layout
  }

  private func sectionLayout(_ index: Int, _ env: NSCollectionLayoutEnvironment) -> NSCollectionLayoutSection? {
    let secs = sectionIds
    let sid = index >= 0 && index < secs.count ? secs[index] : ""
    let next = index + 1 < secs.count ? secs[index + 1] : ""
    let w = env.container.effectiveContentSize.width
    var h: CGFloat = 16
    if maxContentWidth > 0 && w > maxContentWidth { h = max(16, (w - maxContentWidth) / 2 + 16) }
    var est: CGFloat = 52
    if sid == "hero" { est = 300 } else if sid.hasPrefix("h|") || sid.hasPrefix("f|") { est = 24 }
    var dim = NSCollectionLayoutDimension.estimated(est)
    if sid == "hero" && collapsing {
      // Espaçador do cabeçalho que encolhe: altura exata (o desenho é do overlay).
      dim = .absolute(max(1, heroHeightApplied))
    }
    let item = NSCollectionLayoutItem(layoutSize: NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: dim))
    let group = NSCollectionLayoutGroup.vertical(layoutSize: NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: dim), subitems: [item])
    let section = NSCollectionLayoutSection(group: group)
    if sid.hasPrefix("c|") {
      // Cartão: decoração arredondada atrás das linhas; 28 pt até o próximo
      // grupo (o rodapé explicativo encosta no cartão e leva o respiro).
      let bottom: CGFloat = next.hasPrefix("f|") ? 0 : 28
      let insets = NSDirectionalEdgeInsets(top: 0, leading: h, bottom: bottom, trailing: h)
      section.contentInsets = insets
      let bg = NSCollectionLayoutDecorationItem.background(elementKind: CICardBackground.kind)
      bg.contentInsets = insets
      section.decorationItems = [bg]
    } else if sid.hasPrefix("f|") {
      section.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: h, bottom: 28, trailing: h)
    } else if sid == "hero" && collapsing {
      section.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0)
    } else if sid == "hero" {
      section.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: h, bottom: 24, trailing: h)
    } else {
      section.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: h, bottom: 0, trailing: h)
    }
    return section
  }

  // MARK: - Props

  func setHero(_ d: [String: Any]?) {
    let h = CIHero(d)
    if h == hero && appliedOnce { return }
    hero = h
    dirty.insert("hero")
    headerDirty = true
    needsApply = true
  }

  func setRows(_ arr: [[String: Any]]?) {
    var next: [String: CIRow] = [:]
    var ids: [String] = []
    for d in arr ?? [] {
      let r = CIRow(d)
      if r.id.isEmpty || next[r.id] != nil { continue }
      next[r.id] = r
      ids.append(r.id)
    }
    if ids == rowOrder && next == rows && appliedOnce { return }
    for (id, r) in next where rows[id] != r { dirty.insert("r|" + id) }
    rows = next
    rowOrder = ids
    needsApply = true
  }

  func setMedia(_ arr: [[String: Any]]?) {
    var next: [CIMedia] = []
    var seen = Set<String>()
    for d in arr ?? [] {
      let m = CIMedia(d)
      if m.key.isEmpty || seen.contains(m.key) { continue }
      seen.insert(m.key)
      next.append(m)
    }
    if next == media && appliedOnce { return }
    media = next
    for (id, r) in rows where r.kind == "media" { dirty.insert("r|" + id) }
    needsApply = true
  }

  func setMembers(_ d: [String: Any]?) {
    let m = CIMembers(d)
    if m == members && appliedOnce { return }
    var map: [String: CIMember] = [:]
    for it in m.items {
      map[it.id] = it
      if memberMap[it.id] != it { dirty.insert("m|" + it.id) }
    }
    var amap: [String: CIMemberAction] = [:]
    for a in m.actions {
      amap[a.id] = a
      if memberActionMap[a.id] != a { dirty.insert("ma|" + a.id) }
    }
    if m.search != members.search { dirty.insert("ms") }
    if m.loading != members.loading || m.empty != members.empty { dirty.insert("mx") }
    if m.items.count != members.items.count || m.hasMore != members.hasMore { endAskedAt = -1 }
    members = m
    memberMap = map
    memberActionMap = amap
    needsApply = true
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
    dirty.insert("hero")
    headerDirty = true
    needsApply = true
  }

  func setBottomInset(_ b: CGFloat) {
    let v = max(0, b)
    if v == bottomInset { return }
    bottomInset = v
    refreshInsets()
  }

  func setMaxContentWidth(_ w: CGFloat) {
    let v = max(0, w)
    if v == maxContentWidth { return }
    maxContentWidth = v
    collectionView.collectionViewLayout.invalidateLayout()
  }

  /// [2026-10-18 elegance] "collapse" = cabeçalho Telegram (avatar encolhe p/ a
  /// barra, puxar expande a foto); qualquer outro valor = hero estático.
  func setHeaderMode(_ m: String) {
    let on = m == "collapse"
    if on == collapsing { return }
    collapsing = on
    if on {
      let h = CIHeaderOverlay(frame: bounds)
      h.onClose = { [weak self] in self?.onClose([:]) }
      h.onNav = { [weak self] key in
        UISelectionFeedbackGenerator().selectionChanged()
        self?.onAction(["key": key])
      }
      addSubview(h)
      header = h
      let tap = UITapGestureRecognizer(target: self, action: #selector(photoAreaTapped(_:)))
      tap.cancelsTouchesInView = false
      photoTapDelegate.shouldBegin = { [weak self] g in self?.photoTapShouldBegin(g) ?? false }
      tap.delegate = photoTapDelegate
      collectionView.addGestureRecognizer(tap)
      photoTap = tap
    } else {
      stopExpandLink()
      expandTarget = 0
      expandValue = 0
      expandVel = 0
      photoInset = 0
      header?.removeFromSuperview()
      header = nil
      if let tap = photoTap { collectionView.removeGestureRecognizer(tap) }
      photoTap = nil
    }
    headerDirty = true
    needsApply = true
    refreshInsets()
    collectionView.collectionViewLayout.invalidateLayout()
  }

  func commitProps() {
    var reconfigureAll = false
    if paletteDirty {
      paletteDirty = false
      palette = STPalette(dark: dark, colors: colorsRaw)
      CICardBackground.color = palette.cardBg
      backgroundColor = palette.pageBg
      collectionView.backgroundColor = palette.pageBg
      collectionView.indicatorStyle = palette.dark ? .white : .black
      collectionView.collectionViewLayout.invalidateLayout()
      reconfigureAll = appliedOnce
      headerDirty = true
    }
    if let h = header, headerDirty {
      headerDirty = false
      h.configure(hero, palette: palette, labels: labels)
      let hh = h.heroHeight
      if hh != heroHeightApplied {
        heroHeightApplied = hh
        collectionView.collectionViewLayout.invalidateLayout()
      }
      if expandTarget > 0 && !h.hasPhoto { setExpand(0) }
    }
    applySnapshot(reconfigureAll: reconfigureAll)
    refreshInsets()
    updateHeader()
  }

  // MARK: - Snapshot

  private func applySnapshot(reconfigureAll: Bool) {
    guard needsApply || reconfigureAll || !appliedOnce else { return }
    needsApply = false

    var snap = NSDiffableDataSourceSnapshot<String, String>()
    var captions: [String: String] = [:]
    var pos: [String: (first: Bool, last: Bool)] = [:]
    var mIndex: [String: Int] = [:]
    var seenItems = Set<String>()

    let heroId = collapsing ? "hero2" : "hero"
    snap.appendSections(["hero"])
    snap.appendItems([heroId], toSection: "hero")
    seenItems.insert(heroId)

    func addCard(_ key: String, _ header: String, _ footer: String, _ items: [String]) {
      let uniq = items.filter { seenItems.insert($0).inserted }
      if uniq.isEmpty { return }
      if !header.isEmpty {
        let hid = "h|" + key
        snap.appendSections([hid])
        snap.appendItems([hid], toSection: hid)
        captions[hid] = header
      }
      let cid = "c|" + key
      snap.appendSections([cid])
      snap.appendItems(uniq, toSection: cid)
      for (i, it) in uniq.enumerated() { pos[it] = (first: i == 0, last: i == uniq.count - 1) }
      if !footer.isEmpty {
        let fid = "f|" + key
        snap.appendSections([fid])
        snap.appendItems([fid], toSection: fid)
        captions[fid] = footer
      }
    }

    var n = 0
    var curSid: String? = nil
    var curHeader = ""
    var curFooter = ""
    var bucket: [String] = []
    func flush() {
      addCard("\(n)|\(curSid ?? "")", curHeader, curFooter, bucket)
      n += 1
      bucket = []
      curSid = nil
      curHeader = ""
      curFooter = ""
    }

    for id in rowOrder {
      guard let r = rows[id] else { continue }
      if r.kind == "members" {
        flush()
        var items: [String] = []
        if !members.search.isEmpty { items.append("ms") }
        for a in members.actions { items.append("ma|" + a.id) }
        for (i, m) in members.items.enumerated() {
          items.append("m|" + m.id)
          mIndex[m.id] = i
        }
        if members.loading || (members.items.isEmpty && !members.empty.isEmpty) { items.append("mx") }
        let header = members.header.isEmpty ? r.header : members.header
        addCard("\(n)|members", header, r.footer, items)
        n += 1
        continue
      }
      if curSid == nil || curSid! != r.sid {
        flush()
        curSid = r.sid
        curHeader = r.header
        curFooter = r.footer
      } else if curFooter.isEmpty && !r.footer.isEmpty {
        curFooter = r.footer
      }
      bucket.append("r|" + id)
    }
    flush()

    let old = dataSource.snapshot()
    let oldIds = Set(old.itemIdentifiers)
    let oldPos = positions
    captionTexts = captions
    positions = pos
    memberIndex = mIndex
    sectionIds = snap.sectionIdentifiers

    // Reconfigura o que continua na tela e mudou (dados, cantos/separador, tema).
    var reconf: [String] = []
    for id in snap.itemIdentifiers where oldIds.contains(id) {
      if reconfigureAll || dirty.contains(id) || id.hasPrefix("h|") || id.hasPrefix("f|") {
        reconf.append(id)
        continue
      }
      let a = oldPos[id]
      let b = pos[id]
      if a?.first != b?.first || a?.last != b?.last { reconf.append(id) }
    }
    if !reconf.isEmpty { snap.reconfigureItems(reconf) }
    dirty.removeAll()
    appliedOnce = true
    collectionView.collectionViewLayout.invalidateLayout()
    dataSource.apply(snap, animatingDifferences: false) { [weak self] in
      self?.afterApply()
    }
  }

  private func afterApply() {
    if !firstPaintSent {
      firstPaintSent = true
      DispatchQueue.main.async { [weak self] in
        self?.onFirstPaint(["count": self?.rows.count ?? 0])
      }
    }
  }

  // MARK: - Busca de membros

  private func queryChanged(_ text: String) {
    memberQuery = text
    queryWork?.cancel()
    let w = DispatchWorkItem { [weak self] in
      guard let self = self else { return }
      self.endAskedAt = -1
      self.onMemberQuery(["q": self.memberQuery])
    }
    queryWork = w
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: w)
  }

  // MARK: - Insets / teclado

  @objc private func keyboardChanged(_ n: Notification) {
    guard let win = window else { return }
    if n.name == UIResponder.keyboardWillHideNotification {
      keyboardInset = 0
    } else if let end = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue {
      let mine = convert(bounds, to: win)
      keyboardInset = max(0, mine.maxY - end.minY)
    }
    refreshInsets()
  }

  private func refreshInsets() {
    guard let cv = collectionView else { return }
    let b = max(bottomInset, keyboardInset)
    let insets = UIEdgeInsets(top: collapsing ? photoInset : 0, left: 0, bottom: b, right: 0)
    if cv.contentInset != insets {
      cv.contentInset = insets
      var ind = insets
      ind.top = collapsing ? CIHeaderOverlay.navH : 0
      cv.verticalScrollIndicatorInsets = ind
    }
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    if collectionView.frame != bounds { collectionView.frame = bounds }
    if let h = header {
      if h.frame != bounds { h.frame = bounds }
      updateHeader()
    }
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil && displayLink != nil {
      // Fora da tela: assenta a expansão no alvo, sem animação.
      expandValue = expandTarget
      expandVel = 0
      stopExpandLink()
      applyExpand()
    }
  }

  // MARK: - Cabeçalho que encolhe

  private var currentRel: CGFloat {
    guard let cv = collectionView else { return 0 }
    return cv.contentOffset.y + cv.contentInset.top
  }

  private func updateHeader() {
    guard let h = header else { return }
    h.apply(rel: currentRel, expand: expandValue)
  }

  private func setExpand(_ t: CGFloat) {
    if expandTarget == t { return }
    expandTarget = t
    if t == 0 { header?.resetPhoto() }
    if displayLink == nil {
      let link = CADisplayLink(target: CIWeakLinkTarget(self), selector: #selector(CIWeakLinkTarget.tick(_:)))
      link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
      link.add(to: .main, forMode: .common)
      displayLink = link
    }
  }

  private func stopExpandLink() {
    displayLink?.invalidate()
    displayLink = nil
  }

  /// Mola criticamente amortecida (sem ponte) p/ a expansão da foto.
  func expandTick(_ link: CADisplayLink) {
    var dt = CGFloat(link.targetTimestamp - link.timestamp)
    if dt <= 0 || dt > 0.05 { dt = 1.0 / 60.0 }
    let stiffness: CGFloat = 320
    let damping: CGFloat = 2 * 0.86 * sqrt(stiffness)
    let h = dt / 2
    for _ in 0..<2 {
      let a = stiffness * (expandTarget - expandValue) - damping * expandVel
      expandVel += a * h
      expandValue += expandVel * h
    }
    if abs(expandTarget - expandValue) < 0.002 && abs(expandVel) < 0.02 {
      expandValue = expandTarget
      expandVel = 0
      stopExpandLink()
    }
    applyExpand()
  }

  /// Aplica a expansão: o conteúdo desce/sobe via contentInset.top e o offset
  /// é compensado na mesma medida (o dedo não "pula" durante o puxão).
  private func applyExpand() {
    guard let cv = collectionView, let h = header else { return }
    let e = ciClamp01(expandValue)
    let target = (h.photoExtra * e).rounded(.toNearestOrAwayFromZero)
    let delta = target - photoInset
    if abs(delta) > 0.001 {
      adjustingInset = true
      photoInset = target
      var ins = cv.contentInset
      ins.top = target
      cv.contentInset = ins
      var off = cv.contentOffset
      off.y -= delta
      cv.contentOffset = off
      adjustingInset = false
    }
    h.apply(rel: currentRel, expand: e)
  }

  private func heroTouch(_ phase: Int, _ touch: UITouch) {
    guard let h = header else { return }
    let p = touch.location(in: h)
    switch phase {
    case 0:
      h.setPressed(h.hit(p))
    case 1:
      let target = h.hit(p)
      h.setPressed(.empty)
      fireHeaderHit(target)
    default:
      h.setPressed(.empty)
    }
  }

  private func fireHeaderHit(_ target: CIHeaderHit) {
    switch target {
    case .avatar:
      onAvatarPress(["index": header?.photoIndex ?? 0])
    case .action(let key):
      UISelectionFeedbackGenerator().selectionChanged()
      onAction(["key": key])
    case .photo(let dir):
      // [2026-10-18 profile-native] carrossel da foto expandida.
      if header?.cycle(dir) == true {
        UISelectionFeedbackGenerator().selectionChanged()
      } else {
        UIImpactFeedbackGenerator(style: .light).impactOccurred(intensity: 0.5)
      }
    case .empty:
      break
    }
  }

  /// Modo foto: a parte de cima da foto fica sobre o contentInset (sem célula).
  @objc private func photoAreaTapped(_ g: UITapGestureRecognizer) {
    guard let h = header, g.state == .ended else { return }
    fireHeaderHit(h.hit(g.location(in: h)))
  }

  private func photoTapShouldBegin(_ g: UIGestureRecognizer) -> Bool {
    guard let h = header, expandTarget > 0 else { return false }
    let loc = g.location(in: collectionView)
    if collectionView.indexPathForItem(at: loc) != nil { return false }
    return h.hit(g.location(in: h)) != .empty
  }

  public func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
    if collapsing { expandHaptic.prepare() }
  }

  public func scrollViewDidScroll(_ scrollView: UIScrollView) {
    guard collapsing, let h = header else { return }
    if adjustingInset { return }
    let rel = currentRel
    if expandTarget == 0 {
      if scrollView.isTracking && rel < -72 && h.hasPhoto {
        setExpand(1)
        expandHaptic.impactOccurred()
      }
    } else if rel > 28 {
      setExpand(0)
    }
    h.apply(rel: rel, expand: expandValue)
  }

  /// Parou no meio do encolhimento → assenta aberto ou encaixado (Telegram).
  public func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint, targetContentOffset: UnsafeMutablePointer<CGPoint>) {
    guard collapsing, let h = header, expandTarget == 0 else { return }
    let top = scrollView.contentInset.top
    let dock = h.dockRel
    let maxOff = scrollView.contentSize.height + scrollView.contentInset.bottom - scrollView.bounds.height
    if maxOff + top < dock { return }
    let tRel = targetContentOffset.pointee.y + top
    if tRel <= 0 || tRel >= dock { return }
    var snapTo: CGFloat = tRel < dock / 2 ? 0 : dock
    if velocity.y > 0.2 { snapTo = dock } else if velocity.y < -0.2 { snapTo = 0 }
    targetContentOffset.pointee.y = snapTo - top
  }

  // MARK: - UICollectionViewDelegate

  private func isPressable(_ id: String) -> Bool {
    if id.hasPrefix("m|") || id.hasPrefix("ma|") { return true }
    guard id.hasPrefix("r|"), let r = rows[String(id.dropFirst(2))] else { return false }
    return r.kind != "t" && r.kind != "media" && !r.disabled
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
    if id.hasPrefix("m|") {
      onMemberPress(["id": String(id.dropFirst(2))])
    } else if id.hasPrefix("ma|") {
      onRowPress(["id": String(id.dropFirst(3))])
    } else {
      onRowPress(["id": String(id.dropFirst(2))])
    }
  }

  public func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
    guard let id = dataSource.itemIdentifier(for: indexPath), id.hasPrefix("m|") else { return }
    guard let i = memberIndex[String(id.dropFirst(2))] else { return }
    let count = members.items.count
    if i >= count - 12 && members.hasMore && !members.loading && endAskedAt != count {
      endAskedAt = count
      onMembersEnd(["count": count])
    }
  }
}

/// Alvo fraco do CADisplayLink (o link retém o alvo; a view não fica presa).
final class CIWeakLinkTarget: NSObject {
  weak var owner: ChatyyChatInfoView?

  init(_ owner: ChatyyChatInfoView) {
    self.owner = owner
    super.init()
  }

  @objc func tick(_ link: CADisplayLink) {
    guard let o = owner else {
      link.invalidate()
      return
    }
    o.expandTick(link)
  }
}

/// Delegate mínimo do toque na foto expandida (decide por closure).
final class CIGestureGate: NSObject, UIGestureRecognizerDelegate {
  var shouldBegin: ((UIGestureRecognizer) -> Bool)?

  func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    return shouldBegin?(gestureRecognizer) ?? false
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
    return true
  }
}
