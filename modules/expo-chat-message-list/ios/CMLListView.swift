import ExpoModulesCore
import UIKit
#if canImport(ExpoChatStore)
import ExpoChatStore
#endif

// [2026-10-14 native-list] ChatyyMessageList — UICollectionView INVERTIDA
// (scaleY -1: offset 0 = mensagem mais nova, embaixo). Ganho vs FlashList JS:
//   • nada de React por linha: layout CoreText calculado numa fila de fundo,
//     altura cacheada por chave (largura/estilo mudam → recalcula em lote);
//   • diff incremental vindo do JS (ordem só quando muda + linhas alteradas);
//   • rolagem/arrastar-p/-responder/toques 100% na main thread nativa — um JS
//     ocupado (sync, decrypt, rede) não engasga a lista;
//   • âncora: lendo acima, msg nova embaixo NÃO desloca o que está na tela;
//     no fim, entra animada (sobe do composer).

final class CMLFlowLayout: UICollectionViewFlowLayout {
  var animateInsert = false
  /// [motion-conv] estilo da animação do lote atual: 0 = antigo (fade+subida),
  /// 1 = inserção com mola (enviada/recebida), 2 = edição (apagar/colapsar).
  var motionStyle = 0
  /// [motion-conv] índice (ordem NOVA) → 1 enviada, 0 recebida, 2 pílula.
  var sideAt: ((Int) -> Int)?
  private var inserted = Set<IndexPath>()
  private var deleted = Set<IndexPath>()

  override init() {
    super.init()
    scrollDirection = .vertical
    minimumLineSpacing = 0
    minimumInteritemSpacing = 0
    sectionInset = .zero
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func prepare(forCollectionViewUpdates updateItems: [UICollectionViewUpdateItem]) {
    super.prepare(forCollectionViewUpdates: updateItems)
    inserted.removeAll()
    deleted.removeAll()
    guard animateInsert else { return }
    for u in updateItems {
      if u.updateAction == .insert, let ip = u.indexPathAfterUpdate, motionStyle == 2 || ip.item < 4 { inserted.insert(ip) }
      if motionStyle == 2, u.updateAction == .delete, let ip = u.indexPathBeforeUpdate { deleted.insert(ip) }
    }
  }

  override func finalizeCollectionViewUpdates() {
    super.finalizeCollectionViewUpdates()
    inserted.removeAll()
    deleted.removeAll()
  }

  override func initialLayoutAttributesForAppearingItem(at itemIndexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
    guard let base = super.initialLayoutAttributesForAppearingItem(at: itemIndexPath) else { return nil }
    guard inserted.contains(itemIndexPath), let a = base.copy() as? UICollectionViewLayoutAttributes else { return base }
    // Lista invertida: y menor = mais embaixo na tela → nasce "de dentro" do composer.
    a.alpha = 0
    switch motionStyle {
    case 1:
      // [motion-conv] mesma coreografia do RowEnterMotion JS. A escala do UIKit é
      // em torno do CENTRO da linha → desloca p/ ancorar no lado da bolha e na
      // base (y invertido: base visual = minY).
      let w = a.size.width, h = a.size.height
      let side = sideAt?(itemIndexPath.item) ?? 2
      if side == 1 {
        let s: CGFloat = 0.9
        a.transform = CGAffineTransform(translationX: (1 - s) * w / 2 - 14, y: -(1 - s) * h / 2 - 34).scaledBy(x: s, y: s)
      } else if side == 0 {
        let s: CGFloat = 0.96
        a.transform = CGAffineTransform(translationX: -(1 - s) * w / 2, y: -(1 - s) * h / 2 - 14).scaledBy(x: s, y: s)
      } else {
        a.transform = CGAffineTransform(translationX: 0, y: -10)
      }
    case 2:
      // "mensagem apagada" / linha nova no lugar: surge no mesmo ponto
      a.transform = CGAffineTransform(scaleX: 0.96, y: 0.96)
    default:
      a.transform = CGAffineTransform(translationX: 0, y: -min(a.size.height, 56))
    }
    return a
  }

  override func finalLayoutAttributesForDisappearingItem(at itemIndexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
    guard let base = super.finalLayoutAttributesForDisappearingItem(at: itemIndexPath) else { return nil }
    guard deleted.contains(itemIndexPath), let a = base.copy() as? UICollectionViewLayoutAttributes else { return base }
    // [motion-conv] bolha apagada encolhe e some; as vizinhas assentam com a mola
    a.alpha = 0
    a.transform = CGAffineTransform(scaleX: 0.86, y: 0.86)
    return a
  }
}

/// Delegate do arrastar-p/-responder separado da view (não sobrescreve o
/// gestureRecognizerShouldBegin do UIView, que o UIKit também consulta).
final class CMLSwipeDelegate: NSObject, UIGestureRecognizerDelegate {
  weak var owner: CMLListView?
  func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
    return owner?.swipeShouldBegin() ?? false
  }
  func gestureRecognizer(_ g: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
    return owner?.swipeRequiredToFail(by: other) ?? false
  }
}

/// [2026-10-18 tg-list] toque simples espera o duplo SÓ nas bolhas de texto/figurinha.
final class CMLTapDelegate: NSObject, UIGestureRecognizerDelegate {
  weak var owner: CMLListView?
  func gestureRecognizer(_ g: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    owner?.noteTapTouch(touch)
    return true
  }
  func gestureRecognizer(_ g: UIGestureRecognizer, shouldRequireFailureOf other: UIGestureRecognizer) -> Bool {
    return owner?.tapShouldWait(for: other) ?? false
  }
}

/// [2026-10-18 tg-list] toque duplo (reação rápida) e arrastar-p/-selecionar.
final class CMLTgGestureDelegate: NSObject, UIGestureRecognizerDelegate {
  weak var owner: CMLListView?
  func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
    return owner?.tgShouldBegin(g) ?? false
  }
  func gestureRecognizer(_ g: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    return owner?.tgShouldReceive(g, touch) ?? false
  }
}

public final class CMLListView: ExpoView, UICollectionViewDelegateFlowLayout, UICollectionViewDataSourcePrefetching, CMLTransferObserver {
  let onReady = EventDispatcher()
  let onNativeError = EventDispatcher()
  let onRowPress = EventDispatcher()
  let onRowLongPress = EventDispatcher()
  let onSwipeReply = EventDispatcher()
  let onLoadOlder = EventDispatcher()
  let onScrollState = EventDispatcher()
  let onDragState = EventDispatcher()
  let onVisible = EventDispatcher()
  // [native-ctxmenu] menu de contexto nativo (apiVersion 3)
  let onMenuAction = EventDispatcher()
  let onReact = EventDispatcher()
  let onMenuDismiss = EventDispatcher()
  // [native-store] foto da conversa lida do store nativo (apiVersion 4)
  let onStore = EventDispatcher()
  // [native-media-dl] download nativo de mídia (apiVersion 5)
  let onMediaTransfer = EventDispatcher()
  // [2026-10-18 tg-list] apiVersion 11
  let onSelectRange = EventDispatcher()
  let onOverlayPress = EventDispatcher()
  let onQuickReact = EventDispatcher()
  private let hapticSoft = UIImpactFeedbackGenerator(style: .light)

  private let flow = CMLFlowLayout()
  private var cv: UICollectionView!
  private var ds: UICollectionViewDiffableDataSource<Int, String>!

  // dados
  private var rows: [String: CMLRow] = [:]
  private var layouts: [String: CMLRowLayout] = [:]
  private var target: [String] = []      // ordem desejada (mais nova primeiro)
  private var applied: [String] = []     // ordem já no data source
  private var appliedHeights: [String: CGFloat] = [:]
  private var changedSinceApply = Set<String>()
  private var pendingAnim = false

  // estilo
  private var theme = CMLTheme()
  private var fontSize: CGFloat = 16
  private var lineHeight: CGFloat = 21
  private var radius: CGFloat = 18
  private var styleVersion = 0
  private var style: CMLStyle?
  private var styleDirty = true
  private var bottomInset: CGFloat = 8
  private var topInset: CGFloat = 0

  private let layoutQueue = DispatchQueue(label: "br.com.chatyy.messagelist.layout", qos: .userInitiated)
  private var generation = 0
  private var readySent = false
  private var audioState: CMLAudioState?
  private var pendingFlash: String?

  // [2026-10-15 native-store] Foto da conversa no store nativo (modules/
  // expo-chat-store). Prop `store` {a: conta, c: conversa, r: rev do formato
  // das linhas, n: chave mais nova que o JS tem}: na montagem a lista lê a
  // última janela que mostrou desta conversa e PINTA sem esperar o JS (o JS só
  // mandou o id). O 1º applyRows do JS substitui tudo — linha idêntica à da foto
  // mantém o layout (sem recálculo/piscada). Depois de cada applyRows do JS a
  // janela mais nova é regravada (debounce) direto no store, sem ponte.
  struct StoreCfg { let a: String; let c: String; let r: String; let n: String }
  private var storeCfg: StoreCfg?
  private var storeLoadStarted = false
  private var jsApplied = false
  /// [2026-10-19 store-rev, apiVersion 13] rótulos de dia de hoje p/ as linhas de data da foto
  private let dayLabels = CMLDayLabels()
  private var storeDicts: [String: NSDictionary] = [:]  // linhas pintadas da foto (até o 1º applyRows do JS)
  private var rawDicts: [String: [String: Any]] = [:]   // dicionário JS por chave (p/ regravar a foto)
  private var jsVersion = 0
  private var persistedVersion = 0
  private var persistWork: DispatchWorkItem?
  static let storeWindow = 60
  /// Enquanto só a foto está na tela (JS ainda não mandou linhas), toques não
  /// vão p/ o JS (que ainda não conhece os itens).
  private var storeInteractive: Bool { return jsApplied || storeDicts.isEmpty }

  // rolagem
  private var lastScrollEmit: CFTimeInterval = 0
  private var lastDistClass = -1
  private var lastOlderAt: CFTimeInterval = 0
  private var olderArmed = true
  private var visibleScheduled = false
  private var lastVisibleSig = ""
  private var dragging = false

  // gestos
  private var tap: UITapGestureRecognizer!
  private var longPress: UILongPressGestureRecognizer!
  private var swipe: UIPanGestureRecognizer!
  private weak var swipeCell: CMLCell?
  private var swipeDir: CGFloat = 1
  private var swipeArmed = false
  private let swipeThreshold: CGFloat = 64
  private let haptic = UIImpactFeedbackGenerator(style: .light)
  private let hapticMedium = UIImpactFeedbackGenerator(style: .medium)
  private let swipeDelegate = CMLSwipeDelegate()

  // [fase 2]
  private var revealedKeys = Set<String>()
  private var liftedKey: String?
  private var liftGuard: DispatchWorkItem?
  private var lastLiftFile: URL?
  // [native-ctxmenu]
  private var ctxMenuOn = false
  private var darkHint: Bool?
  private var ctxOverlay: CMLContextMenuOverlay?
  private var popKey: String?
  private var popSig = ""
  private var popUntil: CFTimeInterval = 0
  private var dateCount = 0
  private let sticky = CMLStickyView()
  private var stickyOn = false
  private var stickyTop: CGFloat = 8
  private var stickyHide: DispatchWorkItem?
  private var stickyLabel = ""
  // [2026-10-16 wave13-C a11y, apiVersion 6] nomes traduzidos das ações do
  // VoiceOver (prop a11y {reply, react, copy, forward, more, hint}); vazio =
  // binário novo com JS antigo → sem ações (só o rótulo, como antes).
  private var a11yNames: [String: String] = [:]
  // MARK: [2026-10-18 tg-list, apiVersion 11] estado
  // busca
  private var searchTokens: [String] = []
  private var searchIds = Set<String>()
  private var searchCur = ""
  private var searchCache: [String: (String, [NSRange])] = [:]
  // modo seleção (alguma linha com sel > 0) / arrastar-p/-selecionar
  private var selMode = false
  private var dragSelectOn = false
  private var selPan: UIPanGestureRecognizer!
  private let tgDelegate = CMLTgGestureDelegate()
  private var dragAnchorKey: String?
  private var dragOn = true
  private var dragRange: [String] = []
  private var dragPreview: [String: Int] = [:]
  private var dragLastPoint: CGPoint = .zero  // coordenadas da própria view
  private var dragLink: CADisplayLink?
  private let selHaptic = UISelectionFeedbackGenerator()
  // overlay inferior
  private let overlay = CMLOverlayView()
  // morph do envio
  private var sendRect: CGRect?
  private var sendRectAt: CFTimeInterval = 0
  private var morphKey: String?
  private var morphGhost: UIView?
  // toque duplo
  private var quickOn = false
  private var quickEmoji = "\u{2764}\u{FE0F}"
  private var dblTap: UITapGestureRecognizer!
  private let tapDelegate = CMLTapDelegate()
  private var tapWaits = false
  private static let a11yOrder: [(Int, String)] = [(1, "reply"), (2, "react"), (4, "copy"), (8, "forward"), (16, "more")]

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .clear
    cv = UICollectionView(frame: bounds, collectionViewLayout: flow)
    cv.transform = CGAffineTransform(scaleX: 1, y: -1)
    cv.backgroundColor = .clear
    cv.contentInsetAdjustmentBehavior = .never
    cv.alwaysBounceVertical = true
    cv.showsHorizontalScrollIndicator = false
    cv.scrollsToTop = false
    cv.allowsSelection = false
    cv.delaysContentTouches = false
    cv.keyboardDismissMode = .interactive
    cv.register(CMLCell.self, forCellWithReuseIdentifier: CMLCell.reuseId)
    cv.delegate = self
    cv.prefetchDataSource = self
    cv.isPrefetchingEnabled = true
    addSubview(cv)
    // [motion-conv] lado da bolha p/ a mola de entrada (ordem nova = `applied`)
    flow.sideAt = { [weak self] i in
      guard let self = self, i >= 0, i < self.applied.count, let r = self.rows[self.applied[i]] else { return 2 }
      if r.kind != .msg { return 2 }
      return r.own ? 1 : 0
    }

    ds = UICollectionViewDiffableDataSource<Int, String>(collectionView: cv) { [weak self] collectionView, indexPath, key in
      let cell = collectionView.dequeueReusableCell(withReuseIdentifier: CMLCell.reuseId, for: indexPath) as! CMLCell
      guard let self = self, let row = self.rows[key], let L = self.layouts[key], let s = self.style else {
        cell.isHidden = true
        return cell
      }
      cell.isHidden = false
      let extra = CMLCellExtra(revealed: self.revealedKeys.contains(key), lifted: self.liftedKey == key || self.morphKey == key)
      cell.configure(key: key, row: row, layout: L, style: s, audioState: self.audioState, extra: extra)
      self.applySearchTo(cell, key: key, row: row)
      if let pv = self.dragPreview[key] { cell.previewSel(pv) }
      cell.onVideoNote = { [weak self] k, st in
        guard let self = self else { return }
        self.onRowPress(["key": k, "part": "vnote", "url": st])
      }
      cell.isAccessibilityElement = true
      cell.accessibilityLabel = row.accessibilityText
      self.applyA11y(cell, row)
      cell.onA11yActivate = { [weak self] c in self?.a11yActivate(c) ?? false }
      if self.pendingFlash == key {
        self.pendingFlash = nil
        DispatchQueue.main.async { cell.flash() }
      }
      return cell
    }

    tap = UITapGestureRecognizer(target: self, action: #selector(onTap(_:)))
    tap.cancelsTouchesInView = false
    longPress = UILongPressGestureRecognizer(target: self, action: #selector(onLong(_:)))
    longPress.minimumPressDuration = 0.35
    longPress.cancelsTouchesInView = false
    tap.require(toFail: longPress)
    swipe = UIPanGestureRecognizer(target: self, action: #selector(onSwipe(_:)))
    swipeDelegate.owner = self
    swipe.delegate = swipeDelegate
    swipe.maximumNumberOfTouches = 1
    cv.addGestureRecognizer(tap)
    cv.addGestureRecognizer(longPress)
    cv.addGestureRecognizer(swipe)
    cv.panGestureRecognizer.require(toFail: swipe)
    // [2026-10-18 tg-list] toque duplo (reação rápida) — o simples só espera por ele
    // nas bolhas elegíveis (delegate shouldRequireFailureOf); foto/vídeo seguem na hora.
    tapDelegate.owner = self
    tap.delegate = tapDelegate
    tgDelegate.owner = self
    dblTap = UITapGestureRecognizer(target: self, action: #selector(onDoubleTap(_:)))
    dblTap.numberOfTapsRequired = 2
    dblTap.cancelsTouchesInView = false
    dblTap.delegate = tgDelegate
    cv.addGestureRecognizer(dblTap)
    // [2026-10-18 tg-list] arrastar na calha esquerda no modo seleção
    selPan = UIPanGestureRecognizer(target: self, action: #selector(onSelPan(_:)))
    selPan.maximumNumberOfTouches = 1
    selPan.delegate = tgDelegate
    cv.addGestureRecognizer(selPan)
    cv.panGestureRecognizer.require(toFail: selPan)
    applyInsets()
    sticky.isHidden = true
    sticky.alpha = 0
    addSubview(sticky)
    overlay.onPress = { [weak self] k in self?.onOverlayPress(["kind": k]) }
    addSubview(overlay)
    CMLListView.cleanupLiftFiles()
    CMLTransfers.shared.addObserver(self)
    // [wave13-C a11y] Dynamic Type / "Escurecer cores" mudados com a tela aberta → refaz o estilo
    NotificationCenter.default.addObserver(self, selector: #selector(a11yEnvChanged), name: UIContentSizeCategory.didChangeNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(a11yEnvChanged), name: UIAccessibility.darkerSystemColorsStatusDidChangeNotification, object: nil)
  }

  // MARK: [2026-10-16 wave13-C] acessibilidade (VoiceOver)

  @objc private func a11yEnvChanged() {
    markStyleDirty()
  }

  func setA11yLabels(_ d: [String: Any]?) {
    var m: [String: String] = [:]
    for (k, v) in d ?? [:] {
      let s = CMLRow.str(v)
      if !s.isEmpty { m[k] = s }
    }
    if m == a11yNames { return }
    a11yNames = m
    for c in cv.visibleCells {
      guard let cell = c as? CMLCell, let row = cell.row else { continue }
      applyA11y(cell, row)
    }
  }

  /// Traços + ações personalizadas (rotor "Ações") da bolha — disparam os MESMOS
  /// eventos do arrastar (responder) e do toque longo (menu de contexto).
  private func applyA11y(_ cell: CMLCell, _ row: CMLRow) {
    var traits = UIAccessibilityTraits.none
    if row.kind == .date || row.kind == .unread { traits.insert(.header) }
    if row.kind == .msg && row.sel == 2 { traits.insert(.selected) }
    cell.accessibilityTraits = traits
    guard !a11yNames.isEmpty, row.kind == .msg, row.sel == 0 else {
      cell.accessibilityCustomActions = nil
      cell.accessibilityHint = nil
      return
    }
    let key = cell.key
    var acts: [UIAccessibilityCustomAction] = []
    for (bit, id) in CMLListView.a11yOrder where (row.a11yMask & bit) != 0 {
      guard let name = a11yNames[id] else { continue }
      acts.append(UIAccessibilityCustomAction(name: name, actionHandler: { [weak self] _ in
        return self?.runA11yAction(id, key: key) ?? false
      }))
    }
    cell.accessibilityCustomActions = acts.isEmpty ? nil : acts
    cell.accessibilityHint = acts.isEmpty ? nil : a11yNames["hint"]
  }

  private func runA11yAction(_ id: String, key: String) -> Bool {
    guard storeInteractive, let row = rows[key], row.kind == .msg else { return false }
    switch id {
    case "reply":
      onSwipeReply(["key": key, "dir": "reply"])
    case "react", "more":
      a11yOpenMenu(key, row: row, reason: id)
    default:
      onRowPress(["key": key, "part": "a11y", "url": id])
    }
    return true
  }

  /// Toque duplo do VoiceOver = toque na parte principal (mídia/áudio/arquivo/reenviar/bolha).
  private func a11yActivate(_ cell: CMLCell) -> Bool {
    guard storeInteractive, let row = cell.row, row.kind == .msg, !cell.key.isEmpty else { return false }
    var body: [String: Any] = ["key": cell.key]
    if row.sel > 0 || row.deleted || (row.fail && row.own) {
      body["part"] = "bubble"   // seleção / lápide / falhou (o JS reenvia no toque da bolha)
    } else if row.media != nil || !row.album.isEmpty {
      body["part"] = "media"; body["index"] = 0
      if let fr = cell.mediaRectInWindow(0) { body["frame"] = CMLListView.frameDict(fr.0, fr.1) }
    } else if row.audio != nil {
      body["part"] = "audio"
    } else if row.file != nil {
      body["part"] = "file"
    } else {
      body["part"] = "bubble"
    }
    onRowPress(body)
    return true
  }

  /// Mesmo caminho do toque longo (menu nativo se ligado; senão o menu do JS).
  private func a11yOpenMenu(_ key: String, row: CMLRow, reason: String) {
    if row.sel == 0, ctxMenuOn, ctxOverlay == nil, let cell = visibleCell(key), let shot = cell.liftSnapshot(),
       openCtxOverlay(key: key, image: shot.0, rect: shot.1, own: row.own) {
      onRowLongPress(["key": key, "index": 0, "native": 1, "a11y": reason])
      return
    }
    onRowLongPress(["key": key, "index": 0, "a11y": reason])
  }

  // MARK: [2026-10-15 native-media-dl] transferências

  func transferChanged(_ key: String) {
    let x = CMLTransfers.shared.item(key)
    for cell in cv.visibleCells {
      guard let c = cell as? CMLCell, c.transferKeys.contains(key) else { continue }
      c.applyTransfers(animated: true)
    }
    // toque do usuário concluído → tique leve (como o WhatsApp)
    if let x = x, x.state == .done, x.user, !x.external {
      x.user = false
      if window != nil { hapticSoft.impactOccurred(intensity: 0.5) }
    }
  }

  func transferEvent(_ body: [String: Any]) {
    onMediaTransfer(body)
  }

  func setTransfers(_ list: [[String: Any]]) {
    CMLTransfers.shared.setExternal(list)
  }

  private static var cleanedLiftFiles = false
  private static func cleanupLiftFiles() {
    if cleanedLiftFiles { return }
    cleanedLiftFiles = true
    DispatchQueue.global(qos: .utility).async {
      let dir = URL(fileURLWithPath: NSTemporaryDirectory())
      guard let items = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return }
      for u in items where u.lastPathComponent.hasPrefix("cml-lift-") { try? FileManager.default.removeItem(at: u) }
    }
  }

  // MARK: [fase 2] pílula de data fixa / lift / spoiler

  /// [motion-conv] prop `motion` (apiVersion 7) — ver CMLMotion.
  func setMotion(_ d: [String: Any]?) {
    CMLMotion.apply(d)
  }

  /// [2026-10-18 tg-look, apiVersion 10] visual Telegram (rabicho embaixo, mídia rente)
  func setLook(_ d: [String: Any]?) {
    _ = CMLLook.apply(d)
    if let st = style, st.tg != CMLLook.tg { markStyleDirty() }
  }

  /// [2026-10-19 tg-style, apiVersion 12] polimento Telegram (espaçamento, pílulas com
  /// desfoque, nota de voz, hora sobre mídia) — ver CMLLook.style.
  func setTgStyle(_ d: [String: Any]?) {
    _ = CMLLook.applyStyle(d)
    sticky.tgStyle = CMLLook.style
    sticky.darkBlur = CMLLook.isDark(theme.wall)
    stickyLabel = ""
    if let st = style, st.ts != CMLLook.style { markStyleDirty() }
  }

  func setStickyDate(_ d: [String: Any]?) {
    let dd = d ?? [:]
    stickyOn = CMLRow.bool(dd["on"])
    stickyTop = CGFloat(CMLRow.num(dd["top"]) ?? 8)
    sticky.bg = CMLRow.color(dd["bg"]).map { CMLTheme.uiColor($0) } ?? UIColor(white: 1, alpha: 0.95)
    sticky.fg = CMLRow.color(dd["fg"]).map { CMLTheme.uiColor($0) } ?? UIColor(white: 0, alpha: 0.7)
    sticky.shadowOn = dd["shadow"] == nil ? true : CMLRow.bool(dd["shadow"])
    if !stickyOn { hideSticky(animated: false) }
    stickyLabel = ""
    setNeedsLayout()
  }

  private func visibleCell(_ key: String) -> CMLCell? {
    guard let ip = ds.indexPath(for: key) else { return nil }
    return cv.cellForItem(at: ip) as? CMLCell
  }

  func setLiftedKey(_ key: String) {
    let prev = liftedKey
    liftedKey = key.isEmpty ? nil : key
    if let p = prev, p != key, let c = visibleCell(p) { c.setLifted(false, animated: true) }
    if let k = liftedKey, let c = visibleCell(k) { c.setLifted(true, animated: false) }
    // trava de segurança: menu que fechou sem avisar não deixa a bolha sumida
    liftGuard?.cancel()
    liftGuard = nil
    if let k = liftedKey {
      let w = DispatchWorkItem { [weak self] in
        guard let self = self, self.liftedKey == k else { return }
        if let ov = self.ctxOverlay, ov.key == k, !ov.dismissing { return } // menu nativo ainda aberto
        self.setLiftedKey("")
      }
      liftGuard = w
      DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: w)
    }
  }

  private func stickyText() -> String {
    guard dateCount > 1 else { return "" }
    var top = -1
    for ip in cv.indexPathsForVisibleItems where ip.item > top { top = ip.item }
    guard top >= 0, top < applied.count else { return "" }
    var i = top
    var n = 0
    while i < applied.count && n < 5000 {
      if let r = rows[applied[i]], r.kind == .date { return r.text }
      i += 1
      n += 1
    }
    return ""
  }

  private func updateSticky() {
    guard stickyOn, let s = style else { return }
    let t = stickyText()
    if t.isEmpty { hideSticky(animated: true); return }
    let motion = CMLMotion.sticky && !CMLMotion.reduce
    if t != stickyLabel {
      // [motion-conv] troca de dia com a pílula na tela → texto em fade
      let fade = motion && !sticky.isHidden && sticky.alpha > 0.5 && !stickyLabel.isEmpty
      stickyLabel = t
      if fade {
        UIView.transition(with: sticky, duration: 0.18, options: [.transitionCrossDissolve, .allowUserInteraction], animations: {
          self.sticky.setText(t, scale: s.scale)
        })
      } else {
        sticky.setText(t, scale: s.scale)
      }
    }
    let sz = sticky.intrinsic
    let fr = CGRect(x: floor((bounds.width - sz.width) / 2), y: stickyTop, width: sz.width, height: sz.height)
    // bounds+center (não frame): seguro com o transform da entrada
    sticky.bounds = CGRect(origin: .zero, size: fr.size)
    sticky.center = CGPoint(x: fr.midX, y: fr.midY)
    stickyHide?.cancel()
    stickyHide = nil
    if sticky.isHidden || sticky.alpha < 1 {
      let wasHidden = sticky.isHidden || sticky.alpha < 0.05
      sticky.isHidden = false
      if motion {
        // [motion-conv] entra caindo de leve com mola (escala .9 + 6 pt acima)
        if wasHidden { sticky.transform = CGAffineTransform(translationX: 0, y: -6).scaledBy(x: 0.9, y: 0.9) }
        UIView.animate(withDuration: 0.38, delay: 0, usingSpringWithDamping: 0.78, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
          self.sticky.alpha = 1
          self.sticky.transform = .identity
        })
      } else {
        sticky.transform = .identity
        UIView.animate(withDuration: 0.18, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: { self.sticky.alpha = 1 })
      }
    }
  }

  private func scheduleStickyHide() {
    guard stickyOn, !sticky.isHidden else { return }
    stickyHide?.cancel()
    let w = DispatchWorkItem { [weak self] in self?.hideSticky(animated: true) }
    stickyHide = w
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: w)
  }

  private func hideSticky(animated: Bool) {
    stickyHide?.cancel()
    stickyHide = nil
    if sticky.isHidden { return }
    if !animated { sticky.alpha = 0; sticky.transform = .identity; sticky.isHidden = true; return }
    let motion = CMLMotion.sticky && !CMLMotion.reduce
    let curve: UIView.AnimationOptions = motion ? .curveEaseIn : .curveEaseInOut
    UIView.animate(withDuration: motion ? 0.32 : 0.4, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState, curve], animations: {
      self.sticky.alpha = 0
      // [motion-conv] sai encolhendo de leve
      if motion { self.sticky.transform = CGAffineTransform(scaleX: 0.94, y: 0.94) }
    }, completion: { done in
      if done && self.sticky.alpha < 0.01 {
        self.sticky.isHidden = true
        self.sticky.transform = .identity
      }
    })
  }

  // MARK: props

  func setTheme(_ d: [String: Any]) {
    theme = CMLTheme(dict: d)
    sticky.darkBlur = CMLLook.isDark(theme.wall) // [tg-style]
    overlay.wall = theme.wall
    overlay.refreshLook()
    markStyleDirty()
  }

  func setFontSize(_ v: Double?) { let n = CGFloat(v ?? 16); if n != fontSize { fontSize = n; markStyleDirty() } }
  func setLineHeight(_ v: Double?) { let n = CGFloat(v ?? 21); if n != lineHeight { lineHeight = n; markStyleDirty() } }
  func setRadius(_ v: Double?) { let n = CGFloat(v ?? 18); if n != radius { radius = n; markStyleDirty() } }

  func setKeyboardDismissMode(_ v: String?) {
    switch v ?? "interactive" {
    case "on-drag": cv.keyboardDismissMode = .onDrag
    case "none": cv.keyboardDismissMode = .none
    default: cv.keyboardDismissMode = .interactive
    }
  }

  func setInsets(bottom: Double?, top: Double?) {
    if let b = bottom { bottomInset = CGFloat(b) }
    if let t = top { topInset = CGFloat(t) }
    overlay.bottomInset = bottomInset
    applyInsets()
  }

  private func applyInsets() {
    // invertida: "top" do scroll = embaixo na tela
    let ins = UIEdgeInsets(top: bottomInset, left: 0, bottom: topInset + 6, right: 0)
    if cv.contentInset != ins {
      let wasAtBottom = distanceFromLatest < 2
      cv.contentInset = ins
      cv.verticalScrollIndicatorInsets = ins
      if wasAtBottom { cv.contentOffset = CGPoint(x: 0, y: -ins.top) }
    }
  }

  private func markStyleDirty() {
    styleDirty = true
    setNeedsLayout()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    if overlay.frame != bounds { overlay.frame = bounds }
    if !sticky.isHidden {
      let sz = sticky.intrinsic
      // bounds+center: [motion-conv] a pílula pode estar com transform (entrada/saída)
      sticky.bounds = CGRect(origin: .zero, size: sz)
      sticky.center = CGPoint(x: floor((bounds.width - sz.width) / 2) + sz.width / 2, y: stickyTop + sz.height / 2)
    }
    if cv.frame != bounds {
      let wasAtBottom = distanceFromLatest < 2
      cv.frame = bounds
      if wasAtBottom { cv.contentOffset = CGPoint(x: 0, y: -cv.adjustedContentInset.top) }
    }
    let w = bounds.width
    guard w > 10 else { return }
    if styleDirty || style == nil || abs((style?.width ?? 0) - w) > 0.5 {
      styleDirty = false
      styleVersion += 1
      style = CMLStyle(width: w, fontSize: fontSize, lineHeight: lineHeight, radius: radius, theme: theme, version: styleVersion)
      layouts.removeAll(keepingCapacity: true)
      // tudo precisa de layout novo e de reconfigure
      for k in target { changedSinceApply.insert(k) }
      scheduleLayout(animated: false)
    }
  }

  // MARK: dados (JS → nativo)

  func applyRows(_ payload: [String: Any]) {
    let firstJS = !jsApplied
    jsApplied = true
    applyRowsCore(payload, fromStore: false)
    if firstJS {
      storeDicts.removeAll()
      #if canImport(ExpoChatStore)
      unwatchStore()
      #endif
    }
    jsVersion += 1
    schedulePersist()
  }

  private func applyRowsCore(_ payload: [String: Any], fromStore: Bool) {
    if let arr = payload["rows"] as? [[String: Any]] {
      for d0 in arr {
        // [store-rev] foto: "Hoje/Ontem/dia da semana" recalculados p/ hoje
        let d = fromStore ? dayLabels.relabel(d0) : d0
        if let k = d["k"] as? String {
          if fromStore {
            storeDicts[k] = d as NSDictionary
          } else {
            if storeCfg != nil { rawDicts[k] = d }
            // mesma linha que a foto já pintou → mantém linha + layout
            if let sd = storeDicts[k], rows[k] != nil, sd == (d as NSDictionary) { continue }
          }
        }
        guard let r = CMLRow(dict: d) else { continue }
        rows[r.key] = r
        layouts[r.key] = nil
        changedSinceApply.insert(r.key)
      }
    }
    if let keys = payload["keys"] as? [String] {
      var seen = Set<String>()
      var disp: [String] = []
      disp.reserveCapacity(keys.count)
      for k in keys.reversed() where !seen.contains(k) && rows[k] != nil {
        seen.insert(k)
        disp.append(k)
      }
      target = disp
      if rows.count > disp.count + 300 {
        revealedKeys = revealedKeys.filter { seen.contains($0) }
        rows = rows.filter { seen.contains($0.key) }
        layouts = layouts.filter { seen.contains($0.key) }
        appliedHeights = appliedHeights.filter { seen.contains($0.key) }
        rawDicts = rawDicts.filter { seen.contains($0.key) }
      }
      olderArmed = true
    }
    if CMLRow.bool(payload["anim"]) { pendingAnim = true }
    scheduleLayout(animated: pendingAnim)
  }

  private func scheduleLayout(animated: Bool) {
    guard let s = style else { return } // sem largura ainda: layoutSubviews agenda
    generation += 1
    let gen = generation
    var todo: [(String, CMLRow)] = []
    for k in target where layouts[k] == nil {
      if let r = rows[k] { todo.append((k, r)) }
    }
    if todo.isEmpty {
      applySnapshot()
      return
    }
    layoutQueue.async { [weak self] in
      var out: [(String, CMLRow, CMLRowLayout)] = []
      out.reserveCapacity(todo.count)
      for (k, r) in todo {
        out.append((k, r, CMLLayoutBuilder.build(r, s)))
      }
      DispatchQueue.main.async {
        guard let self = self else { return }
        guard self.style === s else { return } // estilo mudou: outro lote já está a caminho
        for (k, r, L) in out where self.rows[k] === r {
          self.layouts[k] = L
        }
        if gen == self.generation { self.applySnapshot() }
      }
    }
  }

  var distanceFromLatest: CGFloat {
    guard let cv = cv else { return 0 }
    return cv.contentOffset.y + cv.adjustedContentInset.top
  }

  private func applySnapshot() {
    guard style != nil else { return }
    // só aplica quando TODAS as linhas da ordem alvo têm layout
    for k in target where layouts[k] == nil { return }
    let newKeys = target
    var dc = 0
    for k in newKeys where rows[k]?.kind == .date { dc += 1 }
    dateCount = dc
    let oldSet = Set(applied)
    let newSet = Set(newKeys)
    var heightChanged = false
    var reconf: [String] = []
    for k in changedSinceApply where oldSet.contains(k) && newSet.contains(k) {
      reconf.append(k)
      if let h = layouts[k]?.height, appliedHeights[k] != h { heightChanged = true }
    }
    let orderSame = newKeys == applied
    if orderSame && reconf.isEmpty {
      changedSinceApply.removeAll()
      pendingAnim = false
      sendReadyIfNeeded()
      return
    }
    // inserções só no fim (mais novas) e poucas → animar
    var insertedAtBottom = 0
    var insertedElsewhere = 0
    if !orderSame {
      for (i, k) in newKeys.enumerated() where !oldSet.contains(k) {
        if i < 4 { insertedAtBottom += 1 } else { insertedElsewhere += 1 }
      }
    }
    let dist = distanceFromLatest
    let atBottom = applied.isEmpty || dist < 3
    let reduce = UIAccessibility.isReduceMotionEnabled
    // [motion-conv] linha que SAIU (apagar / chave _d da "mensagem apagada"): não é
    // "mensagem nova" — com `e` ligado vai p/ o colapso abaixo, não sobe do composer.
    var removedAny = false
    if !orderSame && CMLMotion.edit {
      // pílula que sai (ex.: "não lidas" some ao enviar) não conta
      for k in applied where !newSet.contains(k) && (rows[k]?.kind ?? .msg) == .msg { removedAny = true; break }
    }
    let animate = pendingAnim && atBottom && !applied.isEmpty && insertedAtBottom > 0 && insertedAtBottom <= 3 && insertedElsewhere == 0 && !reduce && window != nil && !removedAny
    // [motion-conv] apagar (some encolhendo) / virar "apagada" (chave _d = sai+entra
    // no mesmo lugar) / altura mudou (editar, reação, tradução): com mola, desde
    // que tudo que muda esteja NA TELA (fora dela = troca seca + âncora, como antes).
    var editAnim = false
    if !animate && pendingAnim && CMLMotion.edit && !reduce && window != nil && !applied.isEmpty {
      var visKeys = Set<String>()
      for ip in cv.indexPathsForVisibleItems where ip.item < applied.count { visKeys.insert(applied[ip.item]) }
      var removed = 0
      var removedOff = false
      if !orderSame {
        for k in applied where !newSet.contains(k) {
          removed += 1
          if !visKeys.contains(k) { removedOff = true }
        }
      }
      let insertedAll = insertedAtBottom + insertedElsewhere
      if !orderSame {
        editAnim = removed >= 1 && removed <= 3 && !removedOff && insertedAll <= removed
      } else if heightChanged && reconf.count <= 3 {
        editAnim = true
        for k in reconf where !visKeys.contains(k) { editAnim = false; break }
      }
    }

    // âncora: lendo acima → a linha visível mais embaixo fica parada na tela
    var anchorKey: String? = nil
    var anchorRel: CGFloat = 0
    if !atBottom {
      let vis = cv.indexPathsForVisibleItems.sorted()
      for ip in vis {
        guard ip.item < applied.count else { continue }
        let k = applied[ip.item]
        if !newSet.contains(k) { continue }
        if let a = cv.layoutAttributesForItem(at: ip) {
          anchorKey = k
          anchorRel = a.frame.minY - cv.contentOffset.y
          break
        }
      }
    }

    var snap = NSDiffableDataSourceSnapshot<Int, String>()
    snap.appendSections([0])
    snap.appendItems(newKeys, toSection: 0)
    if !reconf.isEmpty { snap.reconfigureItems(reconf) }

    applied = newKeys
    updateSelMode()
    for k in changedSinceApply { if let h = layouts[k]?.height { appliedHeights[k] = h } }
    for k in newKeys where appliedHeights[k] == nil { appliedHeights[k] = layouts[k]?.height }
    changedSinceApply.removeAll()
    pendingAnim = false

    if heightChanged { flow.invalidateLayout() }
    // [2026-10-18 tg-list] morph do envio: a enviada nova "sai" do campo do compositor
    var morph: String? = nil
    if animate && CMLMotion.insert, let k = newKeys.first, !oldSet.contains(k), let r = rows[k], r.kind == .msg, r.own,
       sendRect != nil, CACurrentMediaTime() - sendRectAt < 1.5 {
      morph = k
      morphKey = k
    }
    if !orderSame, let k = newKeys.first, !oldSet.contains(k), rows[k]?.own == true, morph == nil { sendRect = nil }
    flow.animateInsert = animate || editAnim
    flow.motionStyle = editAnim ? 2 : (animate && CMLMotion.insert ? 1 : 0)
    if animate || editAnim {
      let applyIt = { [weak self] in
        guard let self = self else { return }
        self.ds.apply(snap, animatingDifferences: true) { [weak self] in
          guard let self = self else { return }
          self.flow.animateInsert = false
          self.flow.motionStyle = 0
          self.afterApply()
        }
      }
      if flow.motionStyle == 0 {
        applyIt()
      } else {
        // [motion-conv] o lote do UICollectionView herda a curva do bloco → mola
        let dur = editAnim ? CMLMotion.editDuration : CMLMotion.insertDuration
        let damp = editAnim ? CMLMotion.editDamping : CMLMotion.insertDamping
        UIView.animate(withDuration: dur, delay: 0, usingSpringWithDamping: damp, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: applyIt)
      }
      // fica grudado no fim enquanto anima
      if animate || atBottom { cv.setContentOffset(CGPoint(x: 0, y: -cv.adjustedContentInset.top), animated: false) }
      if let mk = morph { runSendMorph(mk) }
    } else {
      UIView.performWithoutAnimation {
        ds.apply(snap, animatingDifferences: false)
        cv.layoutIfNeeded()
      }
      if let k = anchorKey, let ip = ds.indexPath(for: k), let a = cv.layoutAttributesForItem(at: ip) {
        let minO = -cv.adjustedContentInset.top
        let maxO = max(minO, cv.contentSize.height + cv.adjustedContentInset.bottom - cv.bounds.height)
        let o = max(minO, min(maxO, a.frame.minY - anchorRel))
        if abs(o - cv.contentOffset.y) > 0.5 { cv.contentOffset = CGPoint(x: 0, y: o) }
      } else if atBottom {
        cv.contentOffset = CGPoint(x: 0, y: -cv.adjustedContentInset.top)
      }
      afterApply()
    }
  }

  private func afterApply() {
    checkPendingPop()
    sendReadyIfNeeded()
    emitScroll(force: true)
    scheduleVisible()
  }

  private func sendReadyIfNeeded() {
    if readySent { return }
    readySent = true
    onReady(["count": applied.count, "src": jsApplied ? "js" : "store"])
  }

  // MARK: [native-store] foto da conversa

  func setStore(_ v: [String: Any]?) {
    #if canImport(ExpoChatStore)
    guard let v = v else { storeCfg = nil; return }
    let a = CMLRow.str(v["a"]), c = CMLRow.str(v["c"]), r = CMLRow.str(v["r"]), n = CMLRow.str(v["n"])
    if a.isEmpty || c.isEmpty || r.isEmpty { storeCfg = nil; return }
    if let p = storeCfg, p.a != a || p.c != c {
      // mesma view, outra conversa/conta: não regrava a janela antiga na nova chave
      persistWork?.cancel(); persistWork = nil
      rawDicts.removeAll()
      persistedVersion = jsVersion
    }
    storeCfg = StoreCfg(a: a, c: c, r: r, n: n)
    dayLabels.update(v["dl"])
    if jsApplied || storeLoadStarted { return }
    storeLoadStarted = true
    // [fase 1.5] pré-carga do pressIn da home: pinta SÍNCRONO, já no set da prop
    // (antes do 1º layout da view) — sem hop de fila.
    if let snap = ChatyyStoreDB.shared.cachedThread(account: a, conv: c, rev: r) {
      if n.isEmpty || snap.newest == n {
        applyRowsCore(["rows": snap.rows, "keys": snap.keys, "anim": 0], fromStore: true)
        onStore(["hit": 1, "why": "mem", "ms": 0, "readMs": Int(snap.readMs), "rows": snap.keys.count])
        watchStore(a, c)
        return
      }
    }
    loadStoreSnapshot(a, c, r, reason: "hit")
    watchStore(a, c)
    #endif
  }

  #if canImport(ExpoChatStore)
  private var storeObsToken: Int?

  deinit {
    if let t = storeObsToken { ChatyyStoreDB.shared.removeObserver(t) }
  }

  private func loadStoreSnapshot(_ a: String, _ c: String, _ r: String, reason: String) {
    let t0 = CACurrentMediaTime()
    ChatyyStoreDB.shared.loadThread(account: a, conv: c, rev: r) { [weak self] snap, why in
      guard let self = self else { return }
      let ms = Int((CACurrentMediaTime() - t0) * 1000)
      guard let snap = snap else { self.onStore(["hit": 0, "why": why, "ms": ms]); return }
      if self.jsApplied { self.onStore(["hit": 0, "why": "late", "ms": ms, "rows": snap.keys.count]); return }
      guard let cur = self.storeCfg, cur.a == a, cur.c == c else { self.onStore(["hit": 0, "why": "moved", "ms": ms]); return }
      // o JS tem mensagem mais nova que a foto → não pinta algo velho. Com a
      // fase 2 o sync já anexa as novas na foto (services/nativeStoreRows).
      if !cur.n.isEmpty && snap.newest != cur.n { self.onStore(["hit": 0, "why": "stale", "ms": ms, "rows": snap.keys.count]); return }
      self.applyRowsCore(["rows": snap.rows, "keys": snap.keys, "anim": reason == "hit" ? 0 : 1], fromStore: true)
      self.onStore(["hit": 1, "why": reason, "ms": ms, "readMs": Int(snap.readMs), "rows": snap.keys.count])
    }
  }

  /// [fase 2] enquanto SÓ a foto está na tela (JS ainda montando — casca leve),
  /// um lote do sync que mexe nesta conversa relê a foto (mensagem nova aparece).
  private func watchStore(_ a: String, _ c: String) {
    unwatchStore()
    storeObsToken = ChatyyStoreDB.shared.addObserver(account: a, conv: c) { [weak self] in
      guard let self = self, !self.jsApplied, let cfg = self.storeCfg, cfg.a == a, cfg.c == c else { return }
      // n (chave mais nova do JS) ficou para trás: a foto agora pode estar mais nova.
      self.storeCfg = StoreCfg(a: cfg.a, c: cfg.c, r: cfg.r, n: "")
      self.loadStoreSnapshot(a, c, cfg.r, reason: "live")
    }
  }

  private func unwatchStore() {
    if let t = storeObsToken { ChatyyStoreDB.shared.removeObserver(t); storeObsToken = nil }
  }
  #endif

  private func schedulePersist() {
    guard storeCfg != nil, jsApplied else { return }
    persistWork?.cancel()
    let w = DispatchWorkItem { [weak self] in self?.persistNow() }
    persistWork = w
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2, execute: w)
  }

  /// Regrava no store a janela mais nova (até storeWindow linhas) exatamente
  /// como o JS mandou — menos estado transitório (seleção, upload, não-lidas).
  private func persistNow() {
    persistWork?.cancel(); persistWork = nil
    #if canImport(ExpoChatStore)
    guard let cfg = storeCfg, jsApplied, persistedVersion != jsVersion else { return }
    persistedVersion = jsVersion
    var keys: [String] = []
    var out: [[String: Any]] = []
    for k in target { // mais nova primeiro
      if keys.count >= CMLListView.storeWindow { break }
      guard var d = rawDicts[k] else { continue }
      if (d["kind"] as? String) == "unread" { continue }
      if let id = d["id"] as? String, id.hasPrefix("tmp") { continue }
      d.removeValue(forKey: "sel")
      if var m = d["media"] as? [String: Any], m["up"] != nil { m.removeValue(forKey: "up"); d["media"] = m }
      keys.append(k)
      out.append(d)
    }
    keys.reverse(); out.reverse()
    ChatyyStoreDB.shared.saveThread(account: cfg.a, conv: cfg.c, rev: cfg.r, keys: keys, rows: out)
    #endif
  }

  // MARK: comandos (JS)

  func scrollToLatest(animated: Bool) {
    cv.setContentOffset(CGPoint(x: 0, y: -cv.adjustedContentInset.top), animated: animated)
    if !animated { emitScroll(force: true); scheduleVisible() }
  }

  func scrollToKey(_ key: String, viewPosition: Double, animated: Bool) -> Bool {
    guard let ip = ds.indexPath(for: key) else { return false }
    cv.layoutIfNeeded()
    guard let a = cv.layoutAttributesForItem(at: ip) else { return false }
    let H = cv.bounds.height
    let p = CGFloat(max(0, min(1, viewPosition)))
    let h = min(a.frame.height, H)
    let minO = -cv.adjustedContentInset.top
    let maxO = max(minO, cv.contentSize.height + cv.adjustedContentInset.bottom - H)
    let o = max(minO, min(maxO, a.frame.maxY - H + p * (H - h)))
    cv.setContentOffset(CGPoint(x: 0, y: o), animated: animated)
    if !animated { emitScroll(force: true); scheduleVisible() }
    return true
  }

  func flashKey(_ key: String) {
    if let ip = ds.indexPath(for: key), let cell = cv.cellForItem(at: ip) as? CMLCell {
      cell.flash()
    } else {
      pendingFlash = key
    }
  }

  func setAudioState(_ d: [String: Any]) {
    let id = CMLRow.str(d["id"])
    let prev = audioState?.id
    if id.isEmpty {
      audioState = nil
    } else {
      audioState = CMLAudioState(
        id: id,
        playing: CMLRow.bool(d["playing"]),
        loading: CMLRow.bool(d["loading"]),
        posMs: CMLRow.num(d["pos"]),
        durMs: CMLRow.num(d["dur"]),
        rateLabel: CMLRow.str(d["rl"])
      )
    }
    guard let s = style else { return }
    for cell in cv.visibleCells {
      guard let c = cell as? CMLCell, let r = c.row, r.audio != nil else { continue }
      if r.id == id || r.id == prev { c.applyAudio(audioState, style: s) }
    }
  }

  // MARK: layout delegate

  public func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout, sizeForItemAt indexPath: IndexPath) -> CGSize {
    let w = max(1, collectionView.bounds.width)
    guard let k = ds.itemIdentifier(for: indexPath), let L = layouts[k] else { return CGSize(width: w, height: 1) }
    return CGSize(width: w, height: max(1, L.height))
  }

  public func collectionView(_ collectionView: UICollectionView, prefetchItemsAt indexPaths: [IndexPath]) {
    let scale = UIScreen.main.scale
    for ip in indexPaths {
      guard let k = ds.itemIdentifier(for: ip), let r = rows[k], let L = layouts[k] else { continue }
      if let m = r.media, !m.uri.isEmpty, !L.mediaFrame.isEmpty {
        CMLImageLoader.shared.prefetch(m.uri, maxPixel: max(L.mediaFrame.width, L.mediaFrame.height) * scale, animated: m.kind == "gif" || m.kind == "sticker")
      }
      for (i, m) in r.album.enumerated() where i < L.albumFrames.count && !m.uri.isEmpty {
        let f = L.albumFrames[i]
        CMLImageLoader.shared.prefetch(m.uri, maxPixel: max(f.width, f.height) * scale)
      }
    }
  }

  // MARK: rolagem

  public func scrollViewDidScroll(_ scrollView: UIScrollView) {
    emitScroll(force: false)
    scheduleVisible()
    if stickyOn && (dragging || scrollView.isDecelerating) { updateSticky() }
    // carregar antigas: perto do TOPO visual (= fim do conteúdo na invertida)
    let H = scrollView.bounds.height
    let remaining = scrollView.contentSize.height - (scrollView.contentOffset.y + H)
    if remaining < H * 1.5 && !applied.isEmpty && olderArmed {
      let now = CACurrentMediaTime()
      if now - lastOlderAt > 0.8 {
        lastOlderAt = now
        olderArmed = false
        onLoadOlder([:])
      }
    }
  }

  public func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
    dragging = true
    onDragState(["dragging": true])
  }

  public func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    dragging = false
    onDragState(["dragging": false])
    if !decelerate { emitScroll(force: true); scheduleVisible(); scheduleStickyHide() }
  }

  public func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
    emitScroll(force: true)
    scheduleVisible()
    scheduleStickyHide()
  }

  public func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
    emitScroll(force: true)
    scheduleVisible()
    scheduleStickyHide()
  }

  // [2026-10-15 native-effects] emoji grande anima 1× ao entrar na tela
  public func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
    (cell as? CMLCell)?.willAppear()
    (cell as? CMLCell)?.autoStartTransfers(owner: self)
  }

  public func collectionView(_ collectionView: UICollectionView, didEndDisplaying cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
    (cell as? CMLCell)?.blocks.stopMedia()
  }

  private func emitScroll(force: Bool) {
    let d = max(0, distanceFromLatest)
    if overlay.isOn { overlay.setFar(d > 300) }
    let cls = d <= 6 ? 0 : (d <= 120 ? 1 : (d <= 300 ? 2 : 3))
    let now = CACurrentMediaTime()
    if !force && cls == lastDistClass && now - lastScrollEmit < 0.066 { return }
    lastDistClass = cls
    lastScrollEmit = now
    let ch = cv.contentSize.height + cv.adjustedContentInset.top + cv.adjustedContentInset.bottom
    onScrollState(["dist": Double(d), "ch": Double(max(ch, cv.bounds.height)), "vh": Double(cv.bounds.height)])
  }

  private func scheduleVisible() {
    if visibleScheduled { return }
    visibleScheduled = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
      guard let self = self else { return }
      self.visibleScheduled = false
      self.emitVisible()
    }
  }

  private func emitVisible() {
    guard window != nil else { return }
    let vis = CGRect(x: 0, y: cv.contentOffset.y, width: cv.bounds.width, height: cv.bounds.height)
    var keys: [String] = []
    for ip in cv.indexPathsForVisibleItems.sorted() {
      guard let k = ds.itemIdentifier(for: ip), let a = cv.layoutAttributesForItem(at: ip) else { continue }
      let inter = a.frame.intersection(vis)
      if inter.isNull { continue }
      if inter.height >= min(a.frame.height, vis.height) * 0.3 { keys.append(k) }
    }
    let sig = keys.joined(separator: "|")
    if sig == lastVisibleSig { return }
    lastVisibleSig = sig
    if !keys.isEmpty { onVisible(["keys": keys]) }
  }

  // MARK: gestos

  private func cellAt(_ g: UIGestureRecognizer) -> (CMLCell, CGPoint)? {
    let p = g.location(in: cv)
    guard let ip = cv.indexPathForItem(at: p), let cell = cv.cellForItem(at: ip) as? CMLCell else { return nil }
    return (cell, cell.contentView.convert(p, from: cv))
  }

  @objc private func onTap(_ g: UITapGestureRecognizer) {
    guard storeInteractive, g.state == .ended, let hit = cellAt(g), let row = hit.0.row else { return }
    let cell = hit.0, pc = hit.1
    var body: [String: Any] = ["key": cell.key]
    if row.sel > 0 && row.kind == .msg {
      body["part"] = "bubble"
      onRowPress(body)
      return
    }
    switch cell.part(at: pc) {
    case .action(let a, let r, let rad):
      body["part"] = "action"; body["url"] = a
      cell.blocks.flashAction(r, radius: rad)
    case .retry: body["part"] = "retry"
    case .vnote(let i):
      let st = cell.blocks.toggleVideoNote(i)
      body["part"] = "vnote"; body["url"] = st.isEmpty ? "play" : st; body["index"] = i
    case .spoiler:
      revealedKeys.insert(cell.key)
      cell.revealSpoilers()
      return
    case .media(let i):
      body["part"] = "media"; body["index"] = i
      // [hero] miniatura tocada na janela → viewer anima a foto saindo dela
      if let fr = cell.mediaRectInWindow(i) { body["frame"] = CMLListView.frameDict(fr.0, fr.1) }
    case .xfer(let i):
      // [native-media-dl] baixar / cancelar no próprio nativo; envio → JS
      let (dl, up) = cell.xferInfo(i)
      if up != nil {
        body["part"] = "xfer"; body["url"] = "cancel-up"; body["index"] = max(0, i)
        onRowPress(body)
        return
      }
      guard let d = dl else { return }
      let T = CMLTransfers.shared
      let x = T.probe(d)
      switch x.state {
      case .done:
        if i == CMLCell.xferAudio { body["part"] = "audio" }
        else if i == CMLCell.xferFile { body["part"] = "file" }
        else {
          body["part"] = "media"; body["index"] = max(0, i)
          if let fr = cell.mediaRectInWindow(max(0, i)) { body["frame"] = CMLListView.frameDict(fr.0, fr.1) }
        }
      case .running, .queued:
        haptic.impactOccurred()
        if x.external {
          body["part"] = "xfer"; body["url"] = "cancel-js"; body["k"] = d.key
          onRowPress(body)
        } else {
          T.cancel(d.key)
        }
        return
      default:
        haptic.impactOccurred()
        if d.js && x.state == .none {
          body["part"] = "xfer"; body["url"] = "cancel-js"; body["k"] = d.key
          onRowPress(body)
          return
        }
        T.start(d, user: true, owner: self)
        return
      }
    case .reply: body["part"] = "reply"
    case .link(let u, _): body["part"] = "link"; body["url"] = u
    case .audio: body["part"] = "audio"
    case .audioRate: body["part"] = "action"; body["url"] = "au:rate" // [voz-wa] 1× → 1,5× → 2×
    case .file: body["part"] = "file"
    case .reaction(let i):
      body["part"] = "reaction"; body["index"] = i
      if i < row.reacts.count { body["url"] = row.reacts[i].emoji }
    case .bubble: body["part"] = "bubble"
    case .none:
      if row.sel > 0 { body["part"] = "bubble" } else { return }
    }
    if row.sel > 0 && row.kind == .msg { body["part"] = "bubble" }
    onRowPress(body)
  }

  @objc private func onLong(_ g: UILongPressGestureRecognizer) {
    guard storeInteractive, g.state == .began, let hit = cellAt(g), let row = hit.0.row, row.kind == .msg || row.kind == .system else { return }
    let cell = hit.0, pc = hit.1
    var idx = 0
    switch cell.part(at: pc) {
    case .none: return
    case .media(let i): idx = i
    default: break
    }
    // [fase 2] haptic + "lift" + snapshot do balão → o overlay JS (MessageLiftOverlay)
    // anima o snapshot a partir do retângulo real (mesmo menu/estética de hoje).
    hapticMedium.impactOccurred()
    let key = cell.key
    let snap = (row.kind == .msg && row.sel == 0) ? cell.liftSnapshot() : nil
    // [native-ctxmenu] menu 100% nativo: o balão sai da lista JÁ (antes do JS
    // responder); o JS manda a lista de ações via showContextMenu(payload).
    if ctxMenuOn, let shot = snap, ctxOverlay == nil, openCtxOverlay(key: key, image: shot.0, rect: shot.1, own: row.own) {
      onRowLongPress(["key": key, "index": idx, "native": 1])
      return
    }
    cell.liftPulse()
    guard let shot = snap else {
      onRowLongPress(["key": key, "index": idx])
      return
    }
    let img = shot.0
    let rect = shot.1
    if let old = lastLiftFile {
      DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 30) { try? FileManager.default.removeItem(at: old) }
    }
    let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("cml-lift-\(UUID().uuidString).png")
    lastLiftFile = url
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      var ok = false
      if let data = img.pngData() { ok = (try? data.write(to: url, options: .atomic)) != nil }
      DispatchQueue.main.async {
        guard let self = self else { return }
        var body: [String: Any] = ["key": key, "index": idx]
        if ok {
          body["anchor"] = ["uri": url.absoluteString, "x": Double(rect.minX), "y": Double(rect.minY), "w": Double(rect.width), "h": Double(rect.height)] as [String: Any]
        }
        self.onRowLongPress(body)
      }
    }
  }

  // MARK: [hero] frame da miniatura por messageId (viewer: ida e volta)

  static func frameDict(_ r: CGRect, _ radius: CGFloat) -> [String: Any] {
    return ["x": Double(r.minX), "y": Double(r.minY), "w": Double(r.width), "h": Double(r.height), "radius": Double(radius)]
  }

  /// Miniatura da mensagem `mid` (foto/vídeo solto ou item de álbum) visível
  /// agora → frame na janela + raio; nil se fora da tela.
  func mediaFrame(_ mid: String) -> [String: Any]? {
    guard !mid.isEmpty, let win = window else { return nil }
    for c in cv.visibleCells {
      guard let cell = c as? CMLCell, let row = cell.row, row.kind == .msg else { continue }
      var idx = -1
      if !row.album.isEmpty {
        if let i = row.album.firstIndex(where: { $0.id == mid }) { idx = i }
        else if let i = row.albumIds.firstIndex(of: mid) { idx = min(i, row.album.count - 1) }
        else if row.id == mid { idx = 0 }
      } else if row.id == mid && row.media != nil {
        idx = 0
      }
      if idx < 0 { continue }
      guard let fr = cell.mediaRectInWindow(idx) else { return nil }
      let r = fr.0, rad = fr.1
      // fora da área visível da lista → sem hero (fecha com fade)
      let listRect = convert(bounds, to: nil)
      if !r.intersects(listRect) || !r.intersects(win.bounds) { return nil }
      return CMLListView.frameDict(r, rad)
    }
    return nil
  }

  // MARK: [native-ctxmenu] menu de contexto nativo

  func setDarkHint(_ v: Bool?) { darkHint = v }

  func setCtxMenu(_ on: Bool) {
    ctxMenuOn = on
    if !on { ctxOverlay?.dismiss(reason: "off", animated: false) }
  }

  private func currentBubbleRect(_ key: String) -> CGRect? {
    guard let c = visibleCell(key), c.window != nil else { return nil }
    return c.liftRectInWindow()
  }

  @discardableResult
  private func openCtxOverlay(key: String, image: UIImage, rect: CGRect, own: Bool) -> Bool {
    guard let win = window else { return false }
    let dark = darkHint ?? (traitCollection.userInterfaceStyle == .dark)
    let ov = CMLContextMenuOverlay(key: key, image: image, rect: rect, own: own, dark: dark)
    ov.sourceRectProvider = { [weak self] in self?.currentBubbleRect(key) }
    ov.onAction = { [weak self] d, action in
      self?.onMenuAction(["key": d.key, "messageId": d.messageId, "action": action])
    }
    ov.onReact = { [weak self] d, emoji in
      guard let self = self else { return }
      self.popKey = d.key
      self.popSig = self.reactSig(d.key)
      self.popUntil = CACurrentMediaTime() + 4
      self.onReact(["key": d.key, "messageId": d.messageId, "emoji": emoji])
    }
    ov.onDismissed = { [weak self, weak ov] reason in
      guard let self = self else { return }
      if let o = ov, self.ctxOverlay === o { self.ctxOverlay = nil }
      self.overlay.setBlocked(self.selMode || self.ctxOverlay != nil)
      // [2026-10-22 ctx-blink] o snapshot já está pousado em cima da bolha: a
      // célula volta a 100% NA HORA (antes era fade 0→1 de 0,15 s DEPOIS de o
      // overlay sumir → a foto/GIF "piscava" ao fechar o menu). O overlay some
      // por cima com fade curto (finish), sem buraco entre os dois.
      if self.liftedKey == key, let c = self.visibleCell(key) { c.setLifted(false, animated: false) }
      if self.liftedKey == key { self.setLiftedKey("") }
      self.onMenuDismiss(["key": key, "reason": reason])
      self.checkPendingPop()
    }
    ctxOverlay = ov
    overlay.setBlocked(true)
    setLiftedKey(key)
    ov.present(in: win)
    return true
  }

  /// JS → nativo: lista de ações/reações do menu. Abre o overlay se o
  /// long-press não abriu (ex.: chamado pelo JS direto). false = não deu.
  func showContextMenu(_ payload: [String: Any]) -> Bool {
    let d = CMLCtxMenuData(payload)
    guard !d.key.isEmpty else { return false }
    if let ov = ctxOverlay, !ov.dismissing {
      if ov.key == d.key {
        if ov.data == nil { ov.setMenu(d) }
        return true
      }
      ov.dismiss(reason: "replaced", animated: false)
    }
    guard let c = visibleCell(d.key), let row = c.row, row.kind == .msg, let shot = c.liftSnapshot() else { return false }
    guard openCtxOverlay(key: d.key, image: shot.0, rect: shot.1, own: row.own), let ov = ctxOverlay else { return false }
    ov.setMenu(d)
    return true
  }

  func dismissContextMenu() {
    ctxOverlay?.dismiss(reason: "js")
  }

  private func reactSig(_ k: String) -> String {
    guard let r = rows[k] else { return "" }
    return r.reacts.map { "\($0.emoji):\($0.count):\($0.mine ? 1 : 0)" }.joined(separator: ",")
  }

  /// Chip da reação aparece com "pop" quando a linha chega com as reações novas.
  private func checkPendingPop() {
    guard let k = popKey else { return }
    if CACurrentMediaTime() > popUntil { popKey = nil; return }
    if let ov = ctxOverlay, ov.key == k { return } // ainda voando / balão voltando
    let sig = reactSig(k)
    if sig == popSig { return }
    popKey = nil
    guard let r = rows[k], !r.reacts.isEmpty, let c = visibleCell(k) else { return }
    c.popReactions()
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil, let ov = ctxOverlay {
      ov.dismiss(reason: "detach", animated: false)
    }
    if window == nil { persistNow() } // [native-store] saiu da conversa → grava já
    if window == nil { stopDragLink(); morphGhost?.removeFromSuperview(); morphGhost = nil; finishMorph() }
  }

  func swipeShouldBegin() -> Bool {
    if !storeInteractive { return false }
    let v = swipe.velocity(in: cv)
    // [2026-10-21 swipe-intent] decide pelo ponto onde o dedo COMEÇOU (location − translation):
    // começou na borda (44 pt), fora da bolha, ou peteleco rápido p/ a direita perto da esquerda
    // = voltar de tela cheia (ele espera este gesto falhar). Responder só arrastando a bolha.
    let tr = swipe.translation(in: cv)
    let pNow = swipe.location(in: cv)
    let pStart = CGPoint(x: pNow.x - tr.x, y: pNow.y - tr.y)
    let startSelf = convert(pStart, from: cv)
    if startSelf.x < 44 { return false } // borda = voltar (navegação)
    guard abs(v.x) > abs(v.y) * 1.5 else { return false }
    if v.x > 0 && startSelf.x < bounds.width * 0.3 && v.x > 1100 { return false }
    guard let ip = cv.indexPathForItem(at: pStart), let cell = cv.cellForItem(at: ip) as? CMLCell,
          let row = cell.row, row.kind == .msg, row.sel == 0 else { return false }
    if case .none = cell.part(at: cell.contentView.convert(pStart, from: cv)) { return false }
    if v.x > 0 {
      swipeDir = 1
    } else {
      if !row.own || row.deleted { return false }
      swipeDir = -1
    }
    swipeCell = cell
    swipeArmed = false
    return true
  }

  func swipeRequiredToFail(by other: UIGestureRecognizer) -> Bool {
    // O "voltar" de tela cheia da navegação espera o arrastar-p/-responder falhar.
    guard other is UIPanGestureRecognizer, let ov = other.view else { return false }
    if ov === cv || ov is UIScrollView { return false }
    return self.isDescendant(of: ov)
  }

  @objc private func onSwipe(_ g: UIPanGestureRecognizer) {
    guard let cell = swipeCell else { return }
    let t = g.translation(in: cv).x * swipeDir
    switch g.state {
    case .began:
      haptic.prepare()
    case .changed:
      let raw = max(0, t)
      var x = raw <= swipeThreshold ? raw : swipeThreshold + (raw - swipeThreshold) * 0.35
      x = min(x, 110)
      cell.setSwipe(x * swipeDir, threshold: swipeThreshold)
      let armedNow = raw >= swipeThreshold
      if armedNow && !swipeArmed {
        haptic.impactOccurred()
        cell.popReplyIcon() // [reply-v2] "estala" no limiar (Telegram)
        haptic.prepare()
      }
      swipeArmed = armedNow
    case .ended, .cancelled, .failed:
      // [2026-10-18 swipe-wa] "peteleco" rápido também responde (WhatsApp): soltou
      // antes do limiar mas com velocidade alta no sentido certo → dispara (+ haptic).
      let flingV = g.velocity(in: cv).x * swipeDir
      let flung = g.state == .ended && !swipeArmed && flingV > 900 && max(0, t) >= swipeThreshold * 0.55
      if flung { haptic.impactOccurred() }
      let fire = (g.state == .ended && swipeArmed) || flung
      let key = cell.key
      let dir = swipeDir
      // [reply-v2] volta com mola (leve overshoot), velocidade do dedo.
      let cur = abs(cell.slide.transform.tx)
      let vx = abs(g.velocity(in: cv).x)
      let iv = cur > 1 ? min(8, vx / cur) : 0
      UIView.animate(withDuration: 0.42, delay: 0, usingSpringWithDamping: 0.72, initialSpringVelocity: iv, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
        cell.setSwipe(0, threshold: self.swipeThreshold)
      })
      swipeCell = nil
      swipeArmed = false
      if fire { onSwipeReply(["key": key, "dir": dir > 0 ? "reply" : "info"]) }
    default:
      break
    }
  }
}

// MARK: - [2026-10-18 tg-list, apiVersion 11] busca · arrastar-p/-selecionar ·
// overlay inferior · morph do envio · toque duplo p/ reagir

extension CMLListView {
  // MARK: busca

  /// {term, ids, cur, scroll}: realça os termos nas bolhas que bateram; cur = resultado atual.
  func setSearch(_ d: [String: Any]) {
    let term = CMLRow.str(d["term"]).trimmingCharacters(in: .whitespacesAndNewlines)
    searchTokens = term.isEmpty ? [] : CMLSearchHL.tokens(term)
    var ids = Set<String>()
    if let arr = d["ids"] as? [Any] {
      for v in arr {
        let s = CMLRow.str(v)
        if !s.isEmpty { ids.insert(s) }
      }
    }
    searchIds = searchTokens.isEmpty ? [] : ids
    searchCur = searchTokens.isEmpty ? "" : CMLRow.str(d["cur"])
    searchCache.removeAll()
    for c in cv.visibleCells {
      guard let cell = c as? CMLCell, let row = cell.row else { continue }
      applySearchTo(cell, key: cell.key, row: row)
    }
    if CMLRow.bool(d["scroll"]), !searchCur.isEmpty, let k = keyForMessage(searchCur) {
      _ = scrollToKey(k, viewPosition: 0.5, animated: true)
    }
  }

  fileprivate func keyForMessage(_ mid: String) -> String? {
    for k in applied {
      guard let r = rows[k], r.kind == .msg else { continue }
      if r.id == mid { return k }
      if !r.album.isEmpty && r.album.contains(where: { $0.id == mid }) { return k }
    }
    return nil
  }

  func applySearchTo(_ cell: CMLCell, key: String, row: CMLRow) {
    guard !searchTokens.isEmpty, row.kind == .msg, !row.deleted, searchIds.contains(row.id),
          let text = cell.displayedText, !text.isEmpty else {
      if !cell.textView.marks.isEmpty { cell.applySearch([], cur: false) }
      return
    }
    let r: [NSRange]
    if let c = searchCache[key], c.0 == text {
      r = c.1
    } else {
      r = CMLSearchHL.ranges(in: text, tokens: searchTokens)
      if searchCache.count > 500 { searchCache.removeAll() }
      searchCache[key] = (text, r)
    }
    cell.applySearch(r, cur: row.id == searchCur)
  }

  // MARK: modo seleção

  func updateSelMode() {
    var sm = false
    for k in applied {
      if let r = rows[k], r.kind == .msg { sm = r.sel > 0; break }
    }
    if sm != selMode {
      selMode = sm
      if !sm { endDrag(cancelled: true) }
    }
    overlay.setBlocked(selMode || ctxOverlay != nil)
  }

  func setDragSelect(_ on: Bool) {
    dragSelectOn = on
    if !on { endDrag(cancelled: true) }
  }

  // MARK: gestos novos (delegate)

  func tgShouldReceive(_ g: UIGestureRecognizer, _ touch: UITouch) -> Bool {
    // calha decidida no shouldBegin (como o arrastar-p/-responder): recebe sempre,
    // falha na hora fora da calha/do modo seleção → o scroll não espera nada.
    if g === selPan { return true }
    guard storeInteractive else { return false }
    if g === dblTap {
      guard quickOn, !selMode else { return false }
      return quickEligible(at: touch.location(in: cv))
    }
    return false
  }

  func tgShouldBegin(_ g: UIGestureRecognizer) -> Bool {
    guard storeInteractive else { return false }
    if g === selPan {
      guard dragSelectOn, selMode, selPan.location(in: self).x < 80 else { return false }
      // ponto do toque inicial (location - translation)
      let loc = selPan.location(in: self)
      let tr = selPan.translation(in: self)
      let start = CGPoint(x: loc.x - tr.x, y: loc.y - tr.y)
      if start.x >= 56 { return false }
      guard let k = keyAtListPoint(start), let r = rows[k], r.kind == .msg, r.sel > 0 else { return false }
      dragAnchorKey = k
      return true
    }
    if g === dblTap {
      guard quickOn, !selMode else { return false }
      return quickEligible(at: g.location(in: cv))
    }
    return true
  }

  /// Linha sob um ponto (coordenadas da própria view); x é ignorado (largura toda).
  fileprivate func keyAtListPoint(_ p: CGPoint) -> String? {
    let pcv = cv.convert(CGPoint(x: bounds.midX, y: p.y), from: self)
    guard let ip = cv.indexPathForItem(at: pcv) else { return nil }
    return ds.itemIdentifier(for: ip)
  }

  // MARK: arrastar-p/-selecionar

  @objc func onSelPan(_ g: UIPanGestureRecognizer) {
    switch g.state {
    case .began:
      guard let ak = dragAnchorKey, let r = rows[ak] else { g.isEnabled = false; g.isEnabled = true; return }
      dragOn = r.sel != 2
      dragRange = []
      clearDragPreview()
      selHaptic.prepare()
      dragLastPoint = g.location(in: self)
      updateDragRange()
      startDragLink()
    case .changed:
      dragLastPoint = g.location(in: self)
      updateDragRange()
    case .ended, .cancelled, .failed:
      endDrag(cancelled: false)
    default:
      break
    }
  }

  fileprivate func updateDragRange() {
    guard let ak = dragAnchorKey, let aip = ds.indexPath(for: ak) else { return }
    guard let ck = keyAtListPoint(dragLastPoint), let cip = ds.indexPath(for: ck) else { return }
    let lo = min(aip.item, cip.item), hi = max(aip.item, cip.item)
    guard lo >= 0, hi < applied.count else { return }
    var keys: [String] = []
    var i = hi
    // ordem da tela: de cima (mais antiga) p/ baixo
    while i >= lo {
      let k = applied[i]
      if let r = rows[k], r.kind == .msg, r.sel > 0 { keys.append(k) }
      i -= 1
    }
    if keys == dragRange { return }
    let oldSet = Set(dragRange)
    let newSet = Set(keys)
    dragRange = keys
    selHaptic.selectionChanged()
    selHaptic.prepare()
    let v = dragOn ? 2 : 1
    for k in oldSet.subtracting(newSet) {
      dragPreview[k] = nil
      visibleCell(k)?.previewSel(nil)
    }
    for k in newSet where dragPreview[k] != v {
      dragPreview[k] = v
      visibleCell(k)?.previewSel(v)
    }
    onSelectRange(["keys": keys, "on": dragOn ? 1 : 0, "end": 0])
  }

  fileprivate func endDrag(cancelled: Bool) {
    stopDragLink()
    guard dragAnchorKey != nil else { return }
    dragAnchorKey = nil
    if !dragRange.isEmpty || !cancelled {
      onSelectRange(["keys": dragRange, "on": dragOn ? 1 : 0, "end": 1])
    }
    dragRange = []
    // a prévia some quando o JS confirmar (ou em 0,8 s, se não vier nada)
    let snap = dragPreview
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
      guard let self = self, self.dragAnchorKey == nil else { return }
      for (k, v) in snap where self.dragPreview[k] == v {
        self.dragPreview[k] = nil
        self.visibleCell(k)?.previewSel(nil)
      }
    }
  }

  fileprivate func clearDragPreview() {
    let ks = Array(dragPreview.keys)
    dragPreview.removeAll()
    for k in ks { visibleCell(k)?.previewSel(nil) }
  }

  fileprivate func startDragLink() {
    if dragLink != nil { return }
    let l = CADisplayLink(target: CMLWeakLink(self) { obj in
      (obj as? CMLListView)?.dragTick()
    }, selector: #selector(CMLWeakLink.tick(_:)))
    l.add(to: .main, forMode: .common)
    dragLink = l
  }

  func stopDragLink() {
    dragLink?.invalidate()
    dragLink = nil
  }

  /// Auto-rolagem perto das bordas (lista invertida: offset maior = mais antigas = topo).
  fileprivate func dragTick() {
    guard dragAnchorKey != nil, window != nil else { stopDragLink(); return }
    let edge: CGFloat = 60
    let y = dragLastPoint.y
    var dy: CGFloat = 0
    if y < edge { dy = (edge - max(0, y)) / edge * 14 }
    else if y > bounds.height - edge { dy = -(y - (bounds.height - edge)) / edge * 14 }
    if abs(dy) < 0.5 { return }
    let minO = -cv.adjustedContentInset.top
    let maxO = max(minO, cv.contentSize.height + cv.adjustedContentInset.bottom - cv.bounds.height)
    let o = max(minO, min(maxO, cv.contentOffset.y + dy))
    if abs(o - cv.contentOffset.y) < 0.1 { return }
    cv.contentOffset = CGPoint(x: 0, y: o)
    updateDragRange()
  }

  // MARK: overlay inferior

  func setOverlay(_ d: [String: Any]?) {
    overlay.wall = theme.wall
    overlay.apply(d)
    overlay.setFar(distanceFromLatest > 300)
    overlay.setBlocked(selMode || ctxOverlay != nil)
    bringSubviewToFront(overlay)
  }

  // MARK: morph do envio

  func prepareSend(_ d: [String: Any]) {
    let x = CMLRow.num(d["x"]), y = CMLRow.num(d["y"]), w = CMLRow.num(d["w"]), h = CMLRow.num(d["h"])
    if let x = x, let y = y, let w = w, let h = h, w > 1, h > 1 {
      sendRect = CGRect(x: x, y: y, width: w, height: h)
    } else {
      sendRect = nil
    }
    sendRectAt = CACurrentMediaTime()
  }

  /// A bolha nova (escondida via morphKey) é desenhada num "fantasma" na janela que
  /// sai do retângulo do compositor e assenta no lugar final; depois a real aparece.
  func runSendMorph(_ key: String) {
    guard let rect = sendRect, window != nil else { finishMorph(); return }
    sendRect = nil
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { [weak self] in
      guard let self = self, self.morphKey == key else { return }
      self.morphGhost?.removeFromSuperview(); self.morphGhost = nil
      self.finishMorph()
    }
    DispatchQueue.main.async { [weak self] in
      guard let self = self, self.morphKey == key, let win = self.window else { return }
      guard let ip = self.ds.indexPath(for: key), let cell = self.cv.cellForItem(at: ip) as? CMLCell,
            let L = cell.layoutInfo, let a = self.cv.layoutAttributesForItem(at: ip), let shot = cell.liftSnapshot() else {
        self.finishMorph(); return
      }
      let cellWin = self.cv.convert(a.frame, to: nil)
      let dest = CGRect(x: cellWin.minX + L.bubbleFrame.minX, y: cellWin.minY + L.bubbleFrame.minY,
                        width: L.bubbleFrame.width, height: L.bubbleFrame.height)
      guard dest.width > 1, dest.height > 1 else { self.finishMorph(); return }
      let sx = max(0.6, min(1, rect.width / dest.width))
      let w0 = dest.width * sx
      let start = CGRect(x: rect.maxX - w0, y: rect.maxY - dest.height, width: w0, height: dest.height)
      let ghost = UIImageView(image: shot.0)
      ghost.contentMode = .scaleToFill
      ghost.isUserInteractionEnabled = false
      ghost.frame = start
      ghost.alpha = 0.6
      win.addSubview(ghost)
      self.morphGhost?.removeFromSuperview()
      self.morphGhost = ghost
      UIView.animate(withDuration: 0.42, delay: 0, usingSpringWithDamping: 0.9, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
        ghost.frame = dest
        ghost.alpha = 1
      }, completion: { [weak self, weak ghost] _ in
        guard let self = self else { ghost?.removeFromSuperview(); return }
        if self.morphKey == key { self.finishMorph() }
        ghost?.removeFromSuperview()
        if self.morphGhost === ghost { self.morphGhost = nil }
      })
    }
  }

  func finishMorph() {
    guard let k = morphKey else { return }
    morphKey = nil
    if liftedKey != k, let c = visibleCell(k) { c.setLifted(false, animated: false) }
  }

  // MARK: toque duplo p/ reagir

  func setQuickReact(_ d: [String: Any]?) {
    quickOn = d != nil && CMLRow.bool(d?["on"])
    let e = CMLRow.str(d?["e"])
    quickEmoji = e.isEmpty ? "\u{2764}\u{FE0F}" : e
  }

  fileprivate func quickEligible(at p: CGPoint) -> Bool {
    guard let ip = cv.indexPathForItem(at: p), let cell = cv.cellForItem(at: ip) as? CMLCell, let row = cell.row else { return false }
    guard CMLCell.quickReactEligible(row) else { return false }
    let pc = cell.contentView.convert(p, from: cv)
    switch cell.part(at: pc) {
    case .none, .retry, .reaction: return false
    default: return true
    }
  }

  func noteTapTouch(_ touch: UITouch) {
    tapWaits = quickOn && !selMode && storeInteractive && quickEligible(at: touch.location(in: cv))
  }

  func tapShouldWait(for other: UIGestureRecognizer) -> Bool {
    return other === dblTap && tapWaits
  }

  @objc func onDoubleTap(_ g: UITapGestureRecognizer) {
    guard g.state == .ended, quickOn, !selMode, storeInteractive else { return }
    let p = g.location(in: cv)
    guard quickEligible(at: p), let ip = cv.indexPathForItem(at: p), let cell = cv.cellForItem(at: ip) as? CMLCell, let row = cell.row else { return }
    hapticSoft.impactOccurred()
    cell.popQuickReact(quickEmoji)
    onQuickReact(["key": cell.key, "messageId": row.id, "emoji": quickEmoji])
  }
}
