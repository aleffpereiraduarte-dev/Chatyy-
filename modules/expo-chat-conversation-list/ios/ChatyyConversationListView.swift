import ExpoModulesCore
import UIKit
#if canImport(ExpoChatStore)
import ExpoChatStore
#endif

/// UICollectionView que avisa quando faz layout (reposiciona header/rodapé RN).
final class CLCollectionView: UICollectionView {
  var onLayout: (() -> Void)?
  // [2026-10-21 lista-viva] cores do cartão das fixadas (lidas pela decoração).
  var pinnedCardColor: UIColor = .white
  var pinnedCardShadow = true
  override func layoutSubviews() {
    super.layoutSubviews()
    onLayout?()
  }
}

/// Contêiner do filho RN (header/rodapé) dentro da collection view. O Fabric
/// continua dono do frame do filho (0,0,w,h); aqui só o posicionamos no
/// espaço de conteúdo (header em y = -altura, rodapé após a última linha).
final class CLChildHost: UIView {
  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    clipsToBounds = false
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

/// [2026-10-16 wave8-list] Barra de VIDRO no topo da lista (Telegram /
/// UINavigationBar): quando o header do app fica por cima da lista (prop
/// `topInset` > 0), as linhas rolam por baixo desta faixa, que vai do
/// transparente (título grande visível) ao material borrado + hairline (título
/// compacto) acompanhando o scroll 1:1 — sem passar pela ponte.
final class CLTopBarView: UIView {
  private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemChromeMaterial))
  private let tint = UIView()
  private let hairline = UIView()

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    backgroundColor = .clear
    addSubview(blur)
    addSubview(tint)
    addSubview(hairline)
    setProgress(0)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func apply(theme: CLTheme) {
    // O tema do app manda (pode diferir do tema do sistema).
    overrideUserInterfaceStyle = theme.dark ? .dark : .light
    tint.backgroundColor = theme.bg.withAlphaComponent(theme.dark ? 0.55 : 0.6)
    hairline.backgroundColor = theme.dark ? UIColor(white: 1, alpha: 0.12) : UIColor(white: 0, alpha: 0.12)
  }

  /// 0 = transparente, 1 = vidro completo.
  func setProgress(_ p: CGFloat) {
    let v = max(0, min(1, p))
    blur.alpha = v
    tint.alpha = v
    hairline.alpha = v
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    blur.frame = bounds
    tint.frame = bounds
    let h = 1 / max(1, window?.screen.scale ?? UIScreen.main.scale)
    hairline.frame = CGRect(x: 0, y: bounds.height - h, width: bounds.width, height: h)
  }
}

public final class ChatyyConversationListView: ExpoView, UICollectionViewDelegate {
  let onRowPress = EventDispatcher()
  let onRowPressIn = EventDispatcher()
  let onAvatarPress = EventDispatcher()
  let onRowAction = EventDispatcher()
  let onLongPress = EventDispatcher()
  let onPeekRequest = EventDispatcher()
  let onPeekOpen = EventDispatcher()
  let onCollapsedChange = EventDispatcher()
  let onEndReached = EventDispatcher()
  let onResync = EventDispatcher()
  let onFirstPaint = EventDispatcher()
  let onNativeError = EventDispatcher()
  // [2026-10-18 tg-list] puxar a lista p/ baixo além do limiar (Telegram:
  // "puxe para ver as Arquivadas"). Um evento por arrasto; o JS decide o que revelar.
  let onPullReveal = EventDispatcher()
  private var pullFired = false
  static let pullThreshold: CGFloat = 64

  private var collectionView: CLCollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<Int, String>!

  // Estado dos dados (espelho do que o JS mandou).
  private var rows: [String: CLRow] = [:]
  private var order: [String] = []
  private var seq: Double = 0
  private var pendingReset = false
  private var pendingDirty = Set<String>()
  private var needsApply = false
  private var appliedOnce = false
  private var firstPaintSent = false
  private var resyncAskedFor: Double = -1

  // Aparência / modos.
  private var theme = CLTheme(dark: false)
  private var themeDirty = true
  private var labels = CLLabels()
  private var labelsDirty = false
  private var selectionMode = false
  private var selectionDirty = false
  private var compact = false // [2026-10-18 compact-list] prop `density`
  private var tg = false      // [2026-10-19 tg-list] density "telegram"
  private var accent: UIColor? // [2026-10-19 tg-list] prop `accent` ("#RRGGBB")
  // [2026-10-21 lista-viva, apiVersion 11] prop `vivo`: seções (cabeçalho
  // "FIXADAS" / cartão das fixadas / resto), sem separadores, entrada leve.
  // false = uma seção só, exatamente como antes.
  private var vivo = false
  private var sectionIds: [Int] = [0]
  private var entranceUntil: CFTimeInterval = 0
  private var entranceArmed = false
  static let secFlat = 0, secPinHeader = 1, secPinned = 2, secRest = 3
  var swipeEnabled = true
  var menuEnabled = true
  var collapseOffset: CGFloat = 34
  private var collapsed = false

  // Header / rodapé RN.
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
  // [2026-10-16 wave8-list] header do app por cima da lista (vidro) + snap do
  // título grande (fica todo aberto ou todo fechado ao soltar o dedo).
  private let topBar = CLTopBarView()
  private var topInset: CGFloat = 0
  var snapOffset: CGFloat = 0

  // Listas do usuário (submenu "Adicionar à lista")
  private var folders: [CLFolder] = []

  // Peek
  private weak var peekController: CLPeekController?
  private var lastPeek: [String: Any]?
  /// [2026-10-17 peek-fixed] fração da tela p/ o cartão da prévia (0 = padrão).
  var peekHeight: CGFloat = 0

  // [2026-10-15 native-store fase 1.5] Foto da HOME no store nativo. Prop
  // `store` {a: conta, r: rev do formato, n: assinatura da 1ª linha do JS, s:
  // escopo}: no cold start, se o JS ainda não mandou linhas (adiou o buildRow
  // p/ depois do 1º frame), a lista pinta a foto direto do store. O 1º reset do
  // JS substitui tudo. Depois de cada patch do JS as 60 primeiras linhas são
  // regravadas (debounce) sem cruzar a ponte.
  private var storeA = "", storeR = "", storeN = "", storeS = "main"
  private var storeLoadStarted = false
  private var storeLoading = false
  private var photoActive = false
  private var jsHasRows = false
  private var rawRows: [String: [String: Any]] = [:]
  private var persistWork: DispatchWorkItem?
  private var jsVersion = 0
  private var persistedVersion = 0
  static let homeWindow = 60

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
    cv.keyboardDismissMode = .none
    cv.delegate = self
    cv.backgroundColor = theme.bg
    cv.addSubview(headerHost)
    cv.addSubview(footerHost)
    cv.onLayout = { [weak self] in self?.layoutHosts() }
    addSubview(cv)
    collectionView = cv
    topBar.isHidden = true
    addSubview(topBar)

    let reg = UICollectionView.CellRegistration<CLConversationCell, String> { [weak self] cell, _, id in
      guard let self = self else { return }
      self.bind(cell, id: id)
    }
    let headerReg = UICollectionView.CellRegistration<CLPinnedHeaderCell, String> { [weak self] cell, _, _ in
      guard let self = self else { return }
      cell.configure(title: self.labels.get("pinnedHeader", "Fixadas"), theme: self.theme)
    }
    dataSource = UICollectionViewDiffableDataSource<Int, String>(collectionView: cv) { collectionView, indexPath, id in
      if id == CLPinnedHeaderCell.itemId {
        return collectionView.dequeueConfiguredReusableCell(using: headerReg, for: indexPath, item: id)
      }
      return collectionView.dequeueConfiguredReusableCell(using: reg, for: indexPath, item: id)
    }
  }

  private func bind(_ cell: CLConversationCell, id: String) {
    guard let row = rows[id] else { return }
    cell.configure(row, theme: theme, labels: labels, selectionMode: selectionMode, compact: compact, tg: tg, accent: tg ? accent : nil,
                   vivo: vivo, cardColor: (vivo && row.pinned) ? theme.pinnedCard : nil)
    cell.onAvatarTap = { [weak self] rid in
      self?.onAvatarPress(["id": rid])
    }
    cell.onA11yAction = { [weak self] rid, action in
      self?.emitAction(rid, action, source: "a11y")
    }
  }

  private func makeLayout() -> UICollectionViewLayout {
    if vivo { return makeVivoLayout() }
    var cfg = UICollectionLayoutListConfiguration(appearance: .plain)
    cfg.backgroundColor = theme.bg
    cfg.showsSeparators = true
    var sep = UIListSeparatorConfiguration(listAppearance: .plain)
    sep.color = theme.hair
    sep.topSeparatorVisibility = .hidden
    // Linha fina a partir do nome (16 + 54 + 14), como no JS.
    // [2026-10-19 tg-list] recuo = x do texto (Telegram: 80 = 12 + 58 + 10).
    let lead: CGFloat = (selectionMode ? 36 : 0) + CLConversationCell.textInset(compact: compact, tg: tg)
    sep.bottomSeparatorInsets = NSDirectionalEdgeInsets(top: 0, leading: lead, bottom: 0, trailing: 0)
    cfg.separatorConfiguration = sep
    cfg.leadingSwipeActionsConfigurationProvider = { [weak self] indexPath in
      return self?.swipeConfiguration(indexPath, leading: true)
    }
    cfg.trailingSwipeActionsConfigurationProvider = { [weak self] indexPath in
      return self?.swipeConfiguration(indexPath, leading: false)
    }
    return UICollectionViewCompositionalLayout.list(using: cfg)
  }

  /// [lista-viva] Uma seção por papel: cabeçalho "FIXADAS" (1 item), cartão
  /// das fixadas (raio 22, margem 0 12 10, respiro 4 em cima/embaixo) e o
  /// resto. Sem separadores.
  private func makeVivoLayout() -> UICollectionViewLayout {
    let layout = UICollectionViewCompositionalLayout(sectionProvider: { [weak self] idx, env in
      let ids = self?.sectionIds ?? []
      let sid = (idx >= 0 && idx < ids.count) ? ids[idx] : ChatyyConversationListView.secRest
      var cfg = UICollectionLayoutListConfiguration(appearance: .plain)
      cfg.backgroundColor = .clear
      cfg.showsSeparators = false
      if sid != ChatyyConversationListView.secPinHeader {
        // `self` aqui já é a referência fraca do closure externo.
        cfg.leadingSwipeActionsConfigurationProvider = { indexPath in
          return self?.swipeConfiguration(indexPath, leading: true)
        }
        cfg.trailingSwipeActionsConfigurationProvider = { indexPath in
          return self?.swipeConfiguration(indexPath, leading: false)
        }
      }
      let sec = NSCollectionLayoutSection.list(using: cfg, layoutEnvironment: env)
      if sid == ChatyyConversationListView.secPinned {
        sec.contentInsets = NSDirectionalEdgeInsets(top: 4, leading: 12, bottom: 14, trailing: 12)
        let deco = NSCollectionLayoutDecorationItem.background(elementKind: CLPinnedCardView.kind)
        deco.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 12, bottom: 10, trailing: 12)
        deco.zIndex = -1
        sec.decorationItems = [deco]
      }
      return sec
    })
    layout.register(CLPinnedCardView.self, forDecorationViewOfKind: CLPinnedCardView.kind)
    return layout
  }

  // MARK: - Props

  func setRowsPatch(_ patch: [String: Any]?) {
    guard let p = patch else { return }
    let pseq = CLVal.double(p["seq"])
    if let reset = p["reset"] as? [Any] {
      // Reset é aceito sempre que for NOVO (montagem, troca de conta, resync);
      // o mesmo reset reenviado junto de outra prop é ignorado.
      if pseq == seq && appliedOnce { return }
      var next: [String: CLRow] = [:]
      var ids: [String] = []
      let track = true // [native-store] a prop store pode chegar depois do 1º reset
      if track { rawRows.removeAll(keepingCapacity: true) }
      for item in reset {
        guard let d = item as? [String: Any] else { continue }
        let r = CLRow(d)
        if r.id.isEmpty { continue }
        if next[r.id] == nil { ids.append(r.id) }
        next[r.id] = r
        if track { rawRows[r.id] = d }
      }
      noteJSPatch()
      rows = next
      order = ids
      if let ord = p["order"] as? [Any] {
        order = ord.map { CLVal.str($0) }
      }
      seq = pseq
      pendingReset = true
      needsApply = true
      return
    }
    if pseq <= seq { return } // repetido (o mesmo patch reenviado)
    let base = CLVal.double(p["base"])
    if base != seq {
      // Perdemos um patch: pede o estado inteiro (uma vez por seq).
      if resyncAskedFor != seq {
        resyncAskedFor = seq
        onResync(["seq": seq])
      }
      return
    }
    if let rm = p["remove"] as? [Any] {
      for x in rm { rows.removeValue(forKey: CLVal.str(x)); rawRows.removeValue(forKey: CLVal.str(x)) }
    }
    noteJSPatch()
    if let ups = p["upsert"] as? [Any] {
      for item in ups {
        guard let d = item as? [String: Any] else { continue }
        let r = CLRow(d)
        if r.id.isEmpty { continue }
        rawRows[r.id] = d
        if rows[r.id] == nil && p["order"] == nil { order.append(r.id) }
        rows[r.id] = r
        pendingDirty.insert(r.id)
      }
    }
    if let ord = p["order"] as? [Any] {
      order = ord.map { CLVal.str($0) }
    }
    seq = pseq
    needsApply = true
  }

  func setDark(_ dark: Bool) {
    if dark == theme.dark && !themeDirty { return }
    theme = CLTheme(dark: dark, palette: palette)
    themeDirty = true
  }

  // [2026-10-20 grafite, apiVersion 10] prop `palette` (ver CLTheme.init(dark:palette:)).
  private var palette: [String: Any]?
  func setPalette(_ p: [String: Any]?) {
    let next: [String: Any]? = (p?.isEmpty ?? true) ? nil : p
    if next == nil && palette == nil { return }
    if let a = next, let b = palette, NSDictionary(dictionary: a).isEqual(to: b) { return }
    palette = next
    theme = CLTheme(dark: theme.dark, palette: palette)
    themeDirty = true
  }

  // [2026-10-21 lista-viva, apiVersion 11]
  func setVivo(_ on: Bool) {
    if on == vivo { return }
    vivo = on
    selectionDirty = true   // layout novo + reconfigura as visíveis
    needsApply = true
    pendingReset = true     // re-seciona sem animar
    if !on { entranceUntil = 0 }
  }

  func setSelectionMode(_ on: Bool) {
    if on == selectionMode { return }
    selectionMode = on
    selectionDirty = true
  }

  // [2026-10-18 compact-list] "compact" = linha 72 / avatar 52 (WhatsApp);
  // qualquer outro valor = regular 76 / 54. Reaproveita o caminho do modo
  // seleção (layout novo + reconfigura as células visíveis).
  func setDensity(_ v: String?) {
    // [2026-10-19 tg-list] "telegram" = linha 78 / avatar 58 / prévia 2 linhas.
    let t = (v == "telegram")
    let c = (v == "compact")
    if c == compact && t == tg { return }
    compact = c
    tg = t
    selectionDirty = true
  }

  // [2026-10-19 tg-list] cor de destaque ("#RRGGBB"; vazio = cor do texto) —
  // "digitando…" no modo Telegram.
  func setAccent(_ v: String?) {
    var c: UIColor? = nil
    var hex = (v ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if hex.hasPrefix("#") { hex.removeFirst() }
    if hex.count == 6, let n = UInt32(hex, radix: 16) { c = UIColor(clHex: n) }
    if c == nil && accent == nil { return }
    if let a = c, let b = accent, a == b { return }
    accent = c
    selectionDirty = true
  }

  func setLabels(_ d: [String: Any]?) {
    labels = CLLabels(d)
    labelsDirty = true
  }

  func setHeaderHeightHint(_ h: CGFloat) {
    headerHint = max(0, h)
  }

  func setFooterHeightHint(_ h: CGFloat) {
    footerHint = max(0, h)
  }

  func setBottomInset(_ b: CGFloat) {
    bottomInset = max(0, b)
  }

  func setTopInset(_ v: CGFloat) {
    let next = max(0, v)
    if abs(next - topInset) < 0.5 { return }
    topInset = next
    topBar.isHidden = topInset < 0.5
    setNeedsLayout()
    refreshInsets()
  }

  func setFolders(_ list: [[String: Any]]?) {
    folders = (list ?? []).map { CLFolder($0) }.filter { !$0.id.isEmpty && !$0.name.isEmpty }
  }

  func setPeek(_ d: [String: Any]?) {
    lastPeek = d
    if let d = d { peekController?.update(d) }
  }

  func setScrollToTopSeq(_ s: Double) {
    if s <= scrollTopSeq { scrollTopSeq = max(scrollTopSeq, s); return }
    let first = scrollTopSeq == 0
    scrollTopSeq = s
    if first && !appliedOnce { return }
    collectionView.setContentOffset(CGPoint(x: 0, y: -collectionView.contentInset.top), animated: true)
  }

  func commitProps() {
    // [native-store] foto da home ainda lendo e o JS sem linhas: não aplica
    // um snapshot vazio (evita onFirstPaint com 0 e um frame em branco).
    if storeLoading && rows.isEmpty { return }
    var reconfigureAll = false
    if themeDirty || selectionDirty {
      backgroundColor = theme.bg
      collectionView.backgroundColor = theme.bg
      collectionView.indicatorStyle = theme.dark ? .white : .black
      collectionView.pinnedCardColor = theme.pinnedCard
      collectionView.pinnedCardShadow = !theme.dark
      collectionView.setCollectionViewLayout(makeLayout(), animated: false)
      topBar.apply(theme: theme)
      reconfigureAll = appliedOnce
      themeDirty = false
      selectionDirty = false
    }
    if labelsDirty {
      labelsDirty = false
      reconfigureAll = reconfigureAll || appliedOnce
    }
    applySnapshot(reconfigureAll: reconfigureAll)
    refreshInsets()
  }

  // MARK: - [native-store fase 1.5] foto da home

  func setStore(_ v: [String: Any]?) {
    #if canImport(ExpoChatStore)
    guard let v = v else { storeA = ""; persistWork?.cancel(); persistWork = nil; return }
    let a = CLVal.str(v["a"]), r = CLVal.str(v["r"])
    if a.isEmpty || r.isEmpty { storeA = ""; return }
    if !storeA.isEmpty && storeA != a { persistWork?.cancel(); persistWork = nil; persistedVersion = jsVersion }
    storeA = a; storeR = r; storeN = CLVal.str(v["n"])
    let sc = CLVal.str(v["s"]); storeS = sc.isEmpty ? "main" : sc
    if jsHasRows || storeLoadStarted { return }
    storeLoadStarted = true
    storeLoading = true
    let scope = storeS
    ChatyyStoreDB.shared.loadHome(account: a, scope: scope, rev: r) { [weak self] snap, _ in
      guard let self = self else { return }
      self.storeLoading = false
      if let snap = snap, !self.jsHasRows, self.storeA == a {
        var next: [String: CLRow] = [:]
        var ids: [String] = []
        for d in snap.rows {
          let row = CLRow(d)
          if row.id.isEmpty || next[row.id] != nil { continue }
          next[row.id] = row; ids.append(row.id)
        }
        if !ids.isEmpty {
          self.rows = next
          self.order = ids
          self.photoActive = true
          self.pendingReset = true
          self.needsApply = true
        }
      }
      self.commitProps()
    }
    #endif
  }

  private func noteJSPatch() {
    jsHasRows = true
    photoActive = false
    storeLoading = false
    jsVersion += 1
    schedulePersist()
  }

  private func schedulePersist() {
    if storeA.isEmpty { return }
    persistWork?.cancel()
    let w = DispatchWorkItem { [weak self] in self?.persistNow() }
    persistWork = w
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: w)
  }

  /// Regrava as primeiras linhas como o JS mandou, sem estado transitório
  /// (digitando, seleção, online).
  private func persistNow() {
    persistWork?.cancel(); persistWork = nil
    #if canImport(ExpoChatStore)
    if storeA.isEmpty || !jsHasRows || selectionMode || persistedVersion == jsVersion { return }
    persistedVersion = jsVersion
    var ids: [String] = []
    var out: [[String: Any]] = []
    for id in order {
      if ids.count >= Self.homeWindow { break }
      guard var d = rawRows[id] else { continue }
      d["typing"] = ""
      d["typingKind"] = ""
      d["selected"] = false
      d["online"] = false
      d["activity"] = ""
      ids.append(id); out.append(d)
    }
    ChatyyStoreDB.shared.saveHome(account: storeA, scope: storeS, rev: storeR, top: storeN, ids: ids, rows: out)
    #endif
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { persistNow() }
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
    // Linhas que vieram em upsert mas ficaram fora do `order` (defensivo).
    if ids.count < rows.count {
      for id in rows.keys.sorted() where !seen.contains(id) {
        seen.insert(id)
        ids.append(id)
      }
    }
    order = ids
    let oldList = dataSource.snapshot().itemIdentifiers
    let oldIds = Set(oldList)
    var snap = NSDiffableDataSourceSnapshot<Int, String>()
    let firstRows = !entranceArmed && !ids.isEmpty
    if firstRows { entranceArmed = true }
    if vivo {
      // [lista-viva] fixadas no cartão (com cabeçalho), o resto embaixo.
      let pins = ids.filter { rows[$0]?.pinned == true }
      if pins.isEmpty {
        snap.appendSections([Self.secRest])
        snap.appendItems(ids, toSection: Self.secRest)
      } else {
        // O rótulo "FIXADAS" + alfinete é do header JS (logo acima da 1ª
        // linha); aqui só o cartão. (CLPinnedHeaderCell fica de reserva.)
        snap.appendSections([Self.secPinned, Self.secRest])
        snap.appendItems(pins, toSection: Self.secPinned)
        snap.appendItems(ids.filter { rows[$0]?.pinned != true }, toSection: Self.secRest)
      }
      // Entrada leve só na 1ª pintura COM linhas (foto do store ou 1º reset).
      if firstRows && !CLMotion.reduced { entranceUntil = CACurrentMediaTime() + 0.9 }
    } else {
      snap.appendSections([Self.secFlat])
      snap.appendItems(ids, toSection: Self.secFlat)
    }
    sectionIds = snap.sectionIdentifiers
    let newList = snap.itemIdentifiers
    var reconf: [String]
    if reconfigureAll || pendingReset {
      reconf = ids.filter { oldIds.contains($0) }
      if vivo && oldIds.contains(CLPinnedHeaderCell.itemId) && newList.contains(CLPinnedHeaderCell.itemId) {
        reconf.append(CLPinnedHeaderCell.itemId)
      }
    } else {
      reconf = pendingDirty.filter { seen.contains($0) && oldIds.contains($0) }
    }
    pendingDirty.removeAll()
    if !reconf.isEmpty { snap.reconfigureItems(reconf) }
    let animate = appliedOnce && !pendingReset && !reconfigureAll && window != nil
    pendingReset = false
    appliedOnce = true
    if animate && CLMotion.reduced {
      // Reduzir movimento: reordena sem deslizar.
      dataSource.apply(snap, animatingDifferences: false) { [weak self] in self?.afterApply() }
      return
    }
    if animate && oldList != newList {
      // [2026-10-16 wave8-list] Conversa que recebeu mensagem SOBE com mola
      // suave e as outras deslizam para baixo (Telegram) — o batch update da
      // diffable herda a curva do bloco de animação.
      UIView.animate(withDuration: 0.42, delay: 0, usingSpringWithDamping: 0.9, initialSpringVelocity: 0,
                     options: [.allowUserInteraction, .beginFromCurrentState], animations: {
        self.dataSource.apply(snap, animatingDifferences: true) { [weak self] in self?.afterApply() }
      }, completion: nil)
      return
    }
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
    // O RN exige que o filho saia sem superview.
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
    let insets = UIEdgeInsets(top: newHeader + topInset, left: 0, bottom: newFooter + bottomInset, right: 0)
    if cv.contentInset != insets {
      let oldTop = cv.contentInset.top
      let atTop = cv.contentOffset.y <= -oldTop + 0.5
      cv.contentInset = insets
      cv.verticalScrollIndicatorInsets = UIEdgeInsets(top: topInset, left: 0, bottom: bottomInset, right: 0)
      if !didInitialOffset || (atTop && !cv.isTracking && !cv.isDecelerating) {
        cv.contentOffset = CGPoint(x: 0, y: -insets.top)
        didInitialOffset = newHeader > 0 || appliedOnce
      } else if abs(insets.top - oldTop) > 0.5 && !cv.isTracking {
        // topInset ligou/desligou longe do topo: o conteúdo fica parado na tela.
        cv.contentOffset.y -= insets.top - oldTop
      }
    }
    updateTopBar()
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
    let tf = CGRect(x: 0, y: 0, width: bounds.width, height: topInset)
    if topBar.frame != tf { topBar.frame = tf }
    bringSubviewToFront(topBar)
    layoutHosts()
  }

  /// Vidro do topo acompanha o scroll: some com o título grande na tela e
  /// fica inteiro quando ele termina de passar por baixo (collapseOffset).
  private func updateTopBar() {
    guard topInset > 0.5, let cv = collectionView else { return }
    let rel = cv.contentOffset.y + cv.contentInset.top
    let start = collapseOffset * 0.45
    let span = max(8, collapseOffset - start)
    topBar.setProgress((rel - start) / span)
  }

  // MARK: - Ações

  private func emitAction(_ id: String, _ action: String, source: String) {
    onRowAction(["id": id, "action": action, "source": source])
  }

  private func contextual(_ id: String, _ action: String, title: String, symbol: String, color: UInt32) -> UIContextualAction {
    let a = UIContextualAction(style: .normal, title: title) { [weak self] _, _, done in
      // [2026-10-16 wave8-list] "estalo" ao executar (o próprio UIKit já dá o
      // toque ao cruzar o limiar do swipe completo).
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
      self?.emitAction(id, action, source: "swipe")
      done(true)
    }
    // [2026-10-19 tg-list] Telegram: glifo cheio, um pouco maior.
    let cfg = UIImage.SymbolConfiguration(pointSize: tg ? 20 : 18, weight: .medium)
    let img = (tg ? UIImage(systemName: symbol + ".fill", withConfiguration: cfg) : nil)
      ?? UIImage(systemName: symbol, withConfiguration: cfg)
    a.image = img?.withTintColor(.white, renderingMode: .alwaysOriginal)
    a.backgroundColor = UIColor(clHex: color)
    return a
  }

  private func swipeConfiguration(_ indexPath: IndexPath, leading: Bool) -> UISwipeActionsConfiguration? {
    guard swipeEnabled, !selectionMode, !photoActive,
          let id = dataSource.itemIdentifier(for: indexPath),
          let row = rows[id] else { return nil }
    var actions: [UIContextualAction] = []
    let L = labels
    if leading {
      // Escala de cinzas (SWIPE_C do JS). 1ª ação = swipe completo.
      actions.append(contextual(id, "toggleRead",
                                title: row.unreadVisible ? L.get("markRead", "Lida") : L.get("markUnread", "Não lida"),
                                symbol: row.unreadVisible ? "checkmark.circle" : "message", color: 0x1C1C1E))
      actions.append(contextual(id, "mute",
                                title: row.muted ? L.get("unmute", "Reativar") : L.get("mute", "Silenciar"),
                                symbol: row.muted ? "bell" : "bell.slash", color: 0x3A3A3C))
      actions.append(contextual(id, "pin",
                                title: row.pinned ? L.get("unpin", "Desafixar") : L.get("pin", "Fixar"),
                                symbol: row.pinned ? "pin.slash" : "pin", color: 0x636366))
      if L.dict["email"] != nil {
        actions.append(contextual(id, "email", title: L.get("email", "E-mail"), symbol: "envelope", color: 0x8E8E93))
      }
    } else {
      actions.append(contextual(id, "archive",
                                title: row.archived ? L.get("unarchive", "Desarquivar") : L.get("archive", "Arquivar"),
                                symbol: row.archived ? "tray.and.arrow.up" : "archivebox", color: 0x3A3A3C))
      actions.append(contextual(id, "delete", title: L.get("delete", "Excluir"), symbol: "trash", color: 0xFF3B30))
    }
    let cfg = UISwipeActionsConfiguration(actions: actions)
    cfg.performsFirstActionWithFullSwipe = true
    return cfg
  }

  private func buildMenu(id: String, row: CLRow) -> UIMenu {
    // Menu nativo estilo WhatsApp (toque longo) — montado em CLMenuBuilder
    // (o mesmo da fileira de fixados).
    return CLMenuBuilder.rowMenu(id: id, row: row, labels: labels, folders: folders) { [weak self] body in
      self?.onRowAction(body)
    }
  }

  // MARK: - UICollectionViewDelegate

  public func collectionView(_ collectionView: UICollectionView, shouldHighlightItemAt indexPath: IndexPath) -> Bool {
    return dataSource.itemIdentifier(for: indexPath) != CLPinnedHeaderCell.itemId
  }

  public func collectionView(_ collectionView: UICollectionView, shouldSelectItemAt indexPath: IndexPath) -> Bool {
    return dataSource.itemIdentifier(for: indexPath) != CLPinnedHeaderCell.itemId
  }

  // [lista-viva] entrada leve das linhas na 1ª pintura (defasada pela posição).
  public func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
    guard vivo, entranceUntil > 0, let c = cell as? CLConversationCell else { return }
    if CACurrentMediaTime() > entranceUntil { entranceUntil = 0; return }
    let rel = max(0, cell.frame.minY - (collectionView.contentOffset.y + collectionView.contentInset.top))
    if rel > collectionView.bounds.height { return }
    let step = max(60, cell.frame.height)
    c.playEntrance(delay: min(0.5, Double(rel / step) * 0.04))
  }

  public func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: true)
    guard let id = dataSource.itemIdentifier(for: indexPath), id != CLPinnedHeaderCell.itemId else { return }
    // [wave8 row-zoom] navigationHint: frame da linha em coords da janela (pt)
    // p/ a transição "a conversa cresce a partir da linha" (modules/expo-chat-row-zoom).
    var ev: [String: Any] = ["id": id]
    if let cell = collectionView.cellForItem(at: indexPath), let win = cell.window {
      let f = cell.convert(cell.bounds, to: win)
      let fr: [String: Any] = ["x": Double(f.origin.x), "y": Double(f.origin.y),
                               "w": Double(f.size.width), "h": Double(f.size.height), "unit": "pt"]
      ev["frame"] = fr
    }
    onRowPress(ev)
  }

  public func collectionView(_ collectionView: UICollectionView, didHighlightItemAt indexPath: IndexPath) {
    // Pré-carrega a conversa no toque (o JS usa onPressIn para isso).
    if selectionMode { return }
    guard let id = dataSource.itemIdentifier(for: indexPath), id != CLPinnedHeaderCell.itemId else { return }
    onRowPressIn(["id": id])
  }

  public func collectionView(_ collectionView: UICollectionView, contextMenuConfigurationForItemAt indexPath: IndexPath, point: CGPoint) -> UIContextMenuConfiguration? {
    guard menuEnabled, !selectionMode, !photoActive,
          let id = dataSource.itemIdentifier(for: indexPath),
          let row = rows[id] else { return nil }
    onPeekRequest(["id": id])
    let theme = self.theme
    return UIContextMenuConfiguration(identifier: id as NSString, previewProvider: { [weak self] in
      let vc = CLPeekController(row: row, theme: theme, menuHeight: CLMenuBuilder.maxEstimatedHeight(), window: self?.window, heightFraction: self?.peekHeight ?? 0)
      if let p = self?.lastPeek, CLVal.str(p["id"]) == id { vc.update(p) }
      self?.peekController = vc
      return vc as UIViewController
    }, actionProvider: { [weak self] _ in
      return self?.buildMenu(id: id, row: row)
    })
  }

  public func collectionView(_ collectionView: UICollectionView, willPerformPreviewActionForMenuWith configuration: UIContextMenuConfiguration, animator: UIContextMenuInteractionCommitAnimating) {
    guard let id = configuration.identifier as? NSString else { return }
    let sid = id as String
    animator.preferredCommitStyle = .dismiss
    animator.addCompletion { [weak self] in
      self?.onPeekOpen(["id": sid])
    }
  }

  // MARK: - UIScrollViewDelegate

  public func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint, targetContentOffset: UnsafeMutablePointer<CGPoint>) {
    // [2026-10-16 wave8-list] Snap do título grande: soltar no meio do caminho
    // termina aberto ou fechado (UINavigationBar / Telegram).
    let zone = snapOffset
    if zone < 1 { return }
    let top = scrollView.contentInset.top
    let rel = targetContentOffset.pointee.y + top
    if rel <= 0.5 || rel >= zone - 0.5 { return }
    let open = velocity.y < -0.2 || (abs(velocity.y) <= 0.2 && rel < zone / 2)
    targetContentOffset.pointee.y = (open ? 0 : zone) - top
  }

  public func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
    pullFired = false
  }

  public func scrollViewDidScroll(_ scrollView: UIScrollView) {
    updateTopBar()
    let rel = scrollView.contentOffset.y + scrollView.contentInset.top
    // [2026-10-18 tg-list] puxão no topo (só com o dedo na tela, nunca no
    // quique da desaceleração) → avisa o JS uma vez por arrasto.
    if !pullFired && scrollView.isTracking && rel < -ChatyyConversationListView.pullThreshold {
      pullFired = true
      onPullReveal(["distance": Double(-rel)])
    }
    let c = rel > collapseOffset
    if c != collapsed {
      collapsed = c
      onCollapsedChange(["collapsed": c])
    }
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
