import ExpoModulesCore
import UIKit

// [2026-10-15 native-tabs] UITabBar de verdade hospedado numa ExpoView.
//
// - Seleção CONTROLADA pelo JS (`selectedKey`). Toque numa aba "selectable"
//   pinta na hora (otimista) e o JS confirma; se em ~0,7 s o JS não confirmar,
//   volta para `selectedKey`. Abas não selecionáveis (Email → abre /inbox)
//   nunca ficam marcadas.
// - Ícone dá um "bounce" com mola (CASpringAnimation em transform.scale da
//   CAMADA — não mexe no frame/transform da view que o UITabBar gerencia).
//   iOS 26+ (Liquid Glass) já anima a seleção sozinho → sem bounce nosso.
// - Haptic de seleção ao trocar; impacto médio no long-press.
// - Long-press só nas abas com `longPress: true` (o reconhecedor nem começa
//   nas outras, então o toque normal delas não é cancelado).
// - [2026-10-18 you-tab-avatar] api 3: `avatarUrl` no item → foto redonda
//   (NTBAvatar.swift) no lugar do SF Symbol; anel quando selecionado. Até a
//   foto chegar (ou se falhar) fica o SF Symbol.
// - [2026-10-18 you-tab-nolabel] api 4: `hideLabel` → item sem título (só a
//   foto/ícone, como a aba de perfil do Instagram), imagem empurrada para o
//   centro vertical (imageInsets, o espaço do rótulo some) e um pouco maior
//   (foto 33 pt). accessibilityLabel continua = label ("Você").
// - [2026-10-18 tabbar-invisivel] api 4: build 728 (api 3) montava a barra
//   mas às vezes ela sumia ao reabrir o app. Única mudança nativa do 728 =
//   foto da aba Você trocando `item.image/selectedImage` IN PLACE num
//   UITabBarItem já exibido, chamada do callback do loader (que pode cair com
//   o app em 2º plano / a view fora da janela). Agora: (1) a foto nunca muta o
//   item exibido — o item é RECRIADO e reaplicado com setItems (o mesmo
//   caminho do 1º mount, que sempre funcionou); (2) com a view fora da janela
//   ou o app inativo a pintura fica pendente até voltar; (3) checagem de saúde
//   ao entrar na janela / voltar ao 1º plano (frame, hidden/alpha, superview,
//   itens) com reparo; se continuar quebrada → evento onBarFail{reason} e o
//   JS troca p/ a barra JS.
// - [2026-10-19 tabbar-api5] api 5 (build 729 ainda sumia e a foto nunca
//   aparecia). Unificação: TODA troca de imagem de um UITabBarItem já exibido
//   (in-place no 728, recriando+setItems no 729) é o gatilho suspeito da barra
//   do iOS 26 (UITabBar fora de UITabBarController) perder o desenho. Agora a
//   foto é um UIImageView NOSSO por cima do ícone (os itens nunca mudam de
//   imagem), ancorado no ícone real a cada layout do UITabBar; sem âncora →
//   fica o SF Symbol. UITabBar com autoresizing + frame = bounds sempre;
//   aparência/itens reaplicados em didMoveToWindow / traitCollectionDidChange /
//   layoutSubviews (bounds > 0). Autochecagem de VISIBILIDADE REAL (frame na
//   janela, sem ancestral escondido, conteúdo com tamanho) + eventos
//   onBarProbe (diagnóstico) e onAvatarState{state,reason}.
// - [2026-10-19 tabbar-api7] Autochecagem de PIXEL (NTBVisibility.swift): o
//   diagnóstico do 731 (api 5) dizia "fr/janela/alpha/itens ok" com a barra
//   invisível p/ o founder — hierarquia não prova o que está na tela. Agora,
//   ~3 s depois de entrar na janela / voltar ao 1º plano (e no máx. 1×/15 s
//   quando os itens mudam): hitTest da janela nos ícones (algo da MESMA tela
//   por cima → "covered") + captura da faixa dos ícones com contraste dentro ×
//   fora de cada glifo ("invisible"). Falhou → 1 reparo (itens/aparência de
//   novo) → falhou de novo → onBarFail{reason:"vis_…"} e o JS usa a barra JS.
//   Também: sem itens (01a152a3 no 731: it=0/0 com hl=ok — a checagem antiga
//   pulava tudo com records vazio) agora é falha ("no_items"); items chegam como
//   dicionários e são lidos sem exceção (um campo de tipo errado não derruba a
//   lista inteira); diagnóstico ganha hit/vis/ancA/lay/pf/ps.
final class ChatyyTabBarView: ExpoView, UITabBarDelegate, UIGestureRecognizerDelegate {
  let onTabPress = EventDispatcher()
  let onTabLongPress = EventDispatcher()
  let onPreferredHeight = EventDispatcher()
  /// [2026-10-18 tabbar-invisivel] api 4: barra não consegue se desenhar → JS usa a barra JS.
  let onBarFail = EventDispatcher()
  /// [2026-10-19 tabbar-api5] diagnóstico (frame/janela/itens) e estado da foto.
  let onBarProbe = EventDispatcher()
  let onAvatarState = EventDispatcher()
  private var barFailSent = false
  private var probeWork: DispatchWorkItem?
  private var lastHealth = "-"
  private var healthWork: DispatchWorkItem?
  /// Foto chegou com a view fora da janela / app inativo → pinta ao voltar.
  private var avatarPaintPending = false
  private var reportedHeight: CGFloat = 0
  /// [2026-10-19 tabbar-api7] Autochecagem de pixel (prop visibilityCheck, padrão true).
  var visibilityCheckEnabled = true
  private var visWork: DispatchWorkItem?
  private var lastVisAt: Date = .distantPast
  private var lastVis = "-"
  private var lastHit = "-"
  /// Quantas vezes o JS entregou `items` / quantos chegaram / quantos foram descartados.
  private var itemsPropSets = 0
  private var itemsPropLast = -1
  private var itemsPropDropped = 0

  private let tabBar = NTBTabBar()
  /// [2026-10-19 tabbar-api5] Foto da aba (por cima do ícone; nunca dentro do item).
  private let avatarOverlay = UIImageView()
  private var overlayIndex: Int? = nil
  private var overlayURL = ""
  private var overlayPhoto: UIImage? = nil
  private var overlaySig = ""
  /// [2026-10-19 tabbar-offline] api 6: conta dona da foto mostrada (chave estável).
  private var overlayKey = ""
  /// Item da foto montado com imagem TRANSPARENTE (nada do SF Symbol por trás).
  private var placeholderIndex: Int? = nil
  private var placeholderSize = CGSize(width: 28, height: 28)
  /// Sem como ancorar a foto (UITabBar mudou de estrutura) → volta ao ícone.
  private var placeholderBlocked = false
  private var anchorCheckWork: DispatchWorkItem?
  /// Último estado enviado ("loading|url" etc.) — evita repetir o mesmo evento.
  private var avatarStateSent = ""
  private var avatarState = "none"
  private var avatarReason = ""
  private var records: [NTBItemRecord] = []
  private var structureSignature = ""
  private var itemsDirty = false

  private var selectedKey: String? = nil
  private var selectedDirty = false
  private var displayedKey: String? = nil

  private var theme = NTBThemeRecord()
  private var themeDirty = true
  private var translucent = true

  var bounceEnabled = true

  private let selectionFeedback = UISelectionFeedbackGenerator()
  private var resyncWork: DispatchWorkItem?
  private lazy var longPress: UILongPressGestureRecognizer = {
    let g = UILongPressGestureRecognizer(target: self, action: #selector(handleLongPress(_:)))
    g.minimumPressDuration = 0.38
    g.delegate = self
    return g
  }()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    clipsToBounds = false
    tabBar.delegate = self
    tabBar.isTranslucent = true
    tabBar.frame = bounds
    tabBar.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(tabBar)
    tabBar.addGestureRecognizer(longPress)
    tabBar.onLayout = { [weak self] in self?.positionAvatarOverlay() }
    avatarOverlay.isUserInteractionEnabled = false
    avatarOverlay.contentMode = .scaleAspectFit
    avatarOverlay.isHidden = true
    avatarOverlay.isAccessibilityElement = false
    addSubview(avatarOverlay)
    NotificationCenter.default.addObserver(
      self, selector: #selector(appDidBecomeActive),
      name: UIApplication.didBecomeActiveNotification, object: nil)
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    healthWork?.cancel()
    probeWork?.cancel()
    anchorCheckWork?.cancel()
    visWork?.cancel()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil else { return }
    // Nova janela (ou a mesma de volta): a altura preferida pode ter mudado e o
    // JS pode ter remontado — reenvia.
    reportedHeight = 0
    // [2026-10-19 tabbar-api5] Reaplica aparência (UITabBar fora de um
    // UITabBarController pode perder a aparência ao trocar de janela/traits).
    if bounds.width > 0 && bounds.height > 0 {
      tabBar.frame = bounds
      applyTheme()
    }
    setNeedsLayout()
    retryAvatarIfNeeded()
    flushPendingAvatars()
    scheduleHealthCheck(delay: 0.35, attempt: 0)
    scheduleHealthCheck2(delay: 2.5)
    scheduleVisibilityCheck(delay: 3.0, attempt: 0)
    scheduleProbe("window", delay: 3.6)
  }

  @objc private func appDidBecomeActive() {
    guard window != nil else { return }
    retryAvatarIfNeeded()
    flushPendingAvatars()
    scheduleHealthCheck(delay: 0.35, attempt: 0)
    scheduleHealthCheck2(delay: 2.5)
    scheduleVisibilityCheck(delay: 3.0, attempt: 0)
    scheduleProbe("active", delay: 3.6)
  }

  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    // Modo escuro/tamanho mudou → aparência + foto (anel/contorno) de novo.
    guard bounds.width > 0, bounds.height > 0 else { themeDirty = true; return }
    applyTheme()
  }

  /// 2ª checagem, mais tarde (layout do RN/safe area já assentados): pega a
  /// barra que nasceu certa e sumiu depois (fora da tela / sem conteúdo).
  private var health2Work: DispatchWorkItem?
  private func scheduleHealthCheck2(delay: TimeInterval) {
    health2Work?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self = self else { return }
      self.health2Work = nil
      self.scheduleHealthCheck(delay: 0, attempt: 0)
    }
    health2Work = work
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
  }

  private var canPaintNow: Bool {
    return window != nil && UIApplication.shared.applicationState == .active
  }

  private func flushPendingAvatars() {
    guard avatarPaintPending, canPaintNow else { return }
    avatarPaintPending = false
    applyAvatars()
    positionAvatarOverlay()
  }

  // MARK: - Saúde (api 4)

  /// nil = ok; senão o motivo do problema (já tentando reparar o que dá).
  private func healthProblem(repair: Bool) -> String? {
    if bounds.width < 1 || bounds.height < 40 { return "zero_frame" }
    // [2026-10-19 tabbar-api5] Visibilidade REAL na janela (só o eixo Y: em
    // transição de navegação a home desliza na horizontal, isso não é defeito).
    if let w = window {
      let r = convert(bounds, to: nil)
      let band = CGRect(x: -100000, y: w.bounds.minY, width: 200000, height: w.bounds.height)
      let vis = r.intersection(band)
      if vis.isNull || vis.height < min(40, bounds.height - 1) { return "offscreen" }
    }
    var problem: String? = nil
    if isHidden || alpha < 0.01 {
      problem = problem ?? "self_hidden"
      if repair { isHidden = false; alpha = 1 }
    }
    if tabBar.superview !== self {
      problem = problem ?? "detached"
      if repair { addSubview(tabBar) }
    }
    if tabBar.isHidden || tabBar.alpha < 0.01 {
      problem = problem ?? "bar_hidden"
      if repair { tabBar.isHidden = false; tabBar.alpha = 1 }
    }
    if tabBar.frame != bounds {
      problem = problem ?? "bar_frame"
      if repair { tabBar.frame = bounds }
    }
    let itemCount = tabBar.items?.count ?? 0
    if !records.isEmpty && (itemCount != records.count || tabBar.subviews.isEmpty) {
      problem = problem ?? (itemCount != records.count ? "items_lost" : "no_subviews")
      if repair {
        structureSignature = "" // força recriar os itens
        applyItems()
        themeDirty = false
        applyTheme()
      }
    }
    // Conteúdo desenhado: algum descendente visível com tamanho (o UITabBar
    // do iOS 26 pode "existir" com frame certo e não ter nada dentro).
    if problem == nil && !records.isEmpty && !ChatyyTabBarView.hasVisibleContent(tabBar, depth: 0) {
      problem = "no_content"
      if repair {
        structureSignature = ""
        applyItems()
        applyTheme()
      }
    }
    if repair && problem != nil {
      tabBar.setNeedsLayout()
      setNeedsLayout()
      layoutIfNeeded()
    }
    return problem
  }

  private func scheduleHealthCheck(delay: TimeInterval, attempt: Int) {
    healthWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self = self else { return }
      self.healthWork = nil
      // Sem janela / app inativo: não dá p/ julgar — volta a checar quando entrar.
      guard self.window != nil, UIApplication.shared.applicationState == .active else { return }
      guard let problem = self.healthProblem(repair: attempt == 0) else { self.lastHealth = "ok"; return }
      self.lastHealth = problem
      if attempt == 0 {
        self.scheduleHealthCheck(delay: 0.3, attempt: 1)
      } else {
        self.failBar(problem)
      }
    }
    healthWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if tabBar.frame != bounds {
      tabBar.frame = bounds
    }
    if tabBar.superview !== self { insertSubview(tabBar, belowSubview: avatarOverlay) }
    if bounds.width > 0 && bounds.height > 0 && !records.isEmpty && (tabBar.items?.count ?? 0) != records.count {
      structureSignature = ""
      applyItems()
      applyTheme()
    }
    bringSubviewToFront(avatarOverlay)
    reportPreferredHeight()
    positionAvatarOverlay()
  }

  // MARK: - Visibilidade real (api 7)

  private func failBar(_ reason: String) {
    guard !barFailSent else { return }
    barFailSent = true
    onBarFail(["reason": reason])
    scheduleProbe("fail_" + reason, delay: 0)
  }

  private func scheduleVisibilityCheck(delay: TimeInterval, attempt: Int) {
    visWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self = self else { return }
      self.visWork = nil
      self.runVisibilityCheck(attempt: attempt)
    }
    visWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
  }

  /// Itens mudaram (badge/foto): rechecagem barata, no máx. 1×/15 s.
  private func maybeRecheckVisibility() {
    guard visibilityCheckEnabled, !barFailSent, visWork == nil, window != nil else { return }
    guard Date().timeIntervalSince(lastVisAt) > 15 else { return }
    scheduleVisibilityCheck(delay: 1.0, attempt: 0)
  }

  private func runVisibilityCheck(attempt: Int) {
    guard visibilityCheckEnabled, !barFailSent, let w = window,
          UIApplication.shared.applicationState == .active else { return }
    lastVisAt = Date()
    // Sem itens = barra vazia (vidro sem nada) — antes passava como "ok".
    if records.isEmpty {
      lastVis = "no_items"
      if attempt == 0 {
        scheduleVisibilityCheck(delay: 1.5, attempt: 1)
      } else {
        failBar("no_items")
      }
      return
    }
    if bounds.width < 1 || bounds.height < 40 { return } // healthProblem cuida (zero_frame)
    let res = NTBVisibility.check(bar: self, tabBar: tabBar, window: w)
    lastVis = res.verdict + ":" + res.sample
    lastHit = res.hit
    guard res.failed else { return }
    if attempt == 0 {
      // 1 reparo: itens + aparência de novo, layout já.
      structureSignature = ""
      applyItems()
      applyTheme()
      tabBar.setNeedsLayout()
      setNeedsLayout()
      layoutIfNeeded()
      scheduleVisibilityCheck(delay: 0.8, attempt: 1)
    } else {
      failBar("vis_" + res.verdict)
    }
  }

  // MARK: - Diagnóstico (api 5)

  private static func hasVisibleContent(_ v: UIView, depth: Int) -> Bool {
    if depth > 7 { return false }
    for sub in v.subviews where !sub.isHidden && sub.alpha > 0.01 {
      if sub.bounds.width > 4 && sub.bounds.height > 4 && (sub is UIImageView || sub is UILabel || sub is UIControl) { return true }
      if hasVisibleContent(sub, depth: depth + 1) { return true }
    }
    return false
  }

  private static func r(_ rect: CGRect) -> String {
    return "\(Int(rect.minX.rounded())),\(Int(rect.minY.rounded())),\(Int(rect.width.rounded())),\(Int(rect.height.rounded()))"
  }

  private func scheduleProbe(_ reason: String, delay: TimeInterval) {
    probeWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self = self else { return }
      self.probeWork = nil
      self.onBarProbe(self.probeInfo(reason))
    }
    probeWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
  }

  private func probeInfo(_ reason: String) -> [String: Any] {
    var hiddenAncestor = "-"
    var v: UIView? = self
    var depth = 0
    while let cur = v, depth < 40 {
      if cur.isHidden || cur.alpha < 0.01 { hiddenAncestor = "\(depth):\(String(describing: type(of: cur)).prefix(24))"; break }
      v = cur.superview
      depth += 1
    }
    let winFrame = window.map { ChatyyTabBarView.r(convert(bounds, to: $0)) } ?? "-"
    let anc = NTBVisibility.ancestorAlpha(self)
    let winBounds = window.map { ChatyyTabBarView.r($0.bounds) } ?? "-"
    let ih = tabBar.sizeThatFits(CGSize(width: max(bounds.width, 1), height: CGFloat.greatestFiniteMagnitude)).height
    let st: String
    switch UIApplication.shared.applicationState {
    case .active: st = "a"
    case .inactive: st = "i"
    default: st = "b"
    }
    return [
      "reason": reason,
      "frame": ChatyyTabBarView.r(frame),
      "win": window != nil,
      "winFrame": winFrame,
      "winBounds": winBounds,
      "hidden": isHidden || tabBar.isHidden,
      "alpha": Double(min(alpha, tabBar.alpha)),
      "hiddenAncestor": hiddenAncestor,
      "sup": superview.map { ChatyyTabBarView.r($0.bounds) } ?? "-",
      "bar": ChatyyTabBarView.r(tabBar.frame),
      "items": tabBar.items?.count ?? 0,
      "records": records.count,
      "icons": iconAnchors().count,
      "content": ChatyyTabBarView.hasVisibleContent(tabBar, depth: 0),
      "ih": Double(ih.isFinite ? ih : -1),
      "app": st,
      "health": lastHealth,
      "avatar": avatarState + (avatarReason.isEmpty ? "" : ":" + avatarReason),
      // [2026-10-19 tabbar-api7]
      "vis": lastVis,
      "hit": lastHit,
      "topHit": topHitNow(),
      "ancA": Double(anc.alpha),
      "ancH": anc.hidden,
      "lay": "\(layer.isHidden ? 1 : 0)/\(String(format: "%.2f", layer.opacity))/\(tabBar.layer.isHidden ? 1 : 0)/\(String(format: "%.2f", tabBar.layer.opacity))",
      "pf": layer.presentation().map { ChatyyTabBarView.r($0.frame) } ?? "-",
      "ps": "\(itemsPropSets)/\(itemsPropLast)/\(itemsPropDropped)",
    ]
  }

  /// Quem está no topo AGORA no centro da barra (hitTest da janela).
  private func topHitNow() -> String {
    guard let w = window else { return "-" }
    let c = convert(CGPoint(x: bounds.midX, y: bounds.midY), to: w)
    let hit = w.hitTest(c, with: nil)
    if let h = hit, h === self || h.isDescendant(of: self) { return "own" }
    return NTBVisibility.describe(hit)
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    reportPreferredHeight()
  }

  /// Altura que o UITabBar quer (49 pt + home indicator; maior no iOS 26).
  /// O JS usa para dimensionar a view — evita cortar a barra se o sistema
  /// mudar a métrica.
  private func reportPreferredHeight() {
    guard bounds.width > 0, window != nil else { return }
    let h = tabBar.sizeThatFits(CGSize(width: bounds.width, height: CGFloat.greatestFiniteMagnitude)).height
    guard h.isFinite, h >= 40, h <= 160, abs(h - reportedHeight) > 0.5 else { return }
    reportedHeight = h
    onPreferredHeight(["height": Double(h)])
  }

  // MARK: - Props

  func setItems(_ list: [NTBItemRecord], dropped: Int = 0) {
    itemsPropSets += 1
    itemsPropLast = list.count
    itemsPropDropped = dropped
    records = list
    itemsDirty = true
  }

  func setSelectedKeyProp(_ key: String?) {
    let k = (key?.isEmpty ?? true) ? nil : key
    if k != selectedKey { selectedKey = k }
    selectedDirty = true
  }

  func setThemeProp(_ t: NTBThemeRecord) {
    theme = t
    themeDirty = true
  }

  func setTranslucentProp(_ v: Bool) {
    if v != translucent {
      translucent = v
      themeDirty = true
    }
  }

  func didUpdateProps() {
    if itemsDirty {
      itemsDirty = false
      applyItems()
      maybeRecheckVisibility()
    }
    if themeDirty {
      themeDirty = false
      applyTheme()
    }
    if selectedDirty {
      selectedDirty = false
      resyncWork?.cancel()
      resyncWork = nil
      setDisplayed(selectedKey, bounce: displayedKey != nil && selectedKey != displayedKey)
    }
  }

  // MARK: - Items

  private func applyItems() {
    // [2026-10-19 tabbar-offline] Foto da última sessão (disco, síncrono) ANTES de
    // montar os itens → a aba "Você" já nasce com a foto, sem ícone por trás.
    primeAvatarFromDisk()
    buildItemsIfNeeded()
    applyBadges()
    applyAvatars()
  }

  /// Item que deve nascer com imagem transparente (foto por cima): só quando há foto.
  private func wantedPlaceholderIndex() -> Int? {
    guard !placeholderBlocked, overlayPhoto != nil, let i = overlayIndex, i < records.count else { return nil }
    return i
  }

  /// (Re)cria os UITabBarItem quando a estrutura muda — inclusive quando a aba da
  /// foto passa de ícone ↔ transparente (nunca muta a imagem de um item exibido).
  private func buildItemsIfNeeded() {
    let ph = wantedPlaceholderIndex()
    let sig = records.map { "\($0.key)|\($0.label)|\($0.sfSymbol)|\($0.sfSymbolActive ?? "")|\($0.hideLabel)" }.joined(separator: "\n")
      + "|ph=\(ph.map { String($0) } ?? "-")"
    guard sig != structureSignature || (tabBar.items?.count ?? -1) != records.count else { return }
    structureSignature = sig
    var built: [UITabBarItem] = []
    for (i, r) in records.enumerated() {
      let (img, selImg) = ChatyyTabBarView.symbolImages(r)
      if i == ph {
        let size = img?.size ?? CGSize(width: 28, height: 28)
        placeholderSize = size
        let clear = ChatyyTabBarView.clearImage(size)
        built.append(makeItem(r, at: i, image: clear, selectedImage: clear))
      } else {
        built.append(makeItem(r, at: i, image: img, selectedImage: selImg))
      }
    }
    placeholderIndex = ph
    tabBar.setItems(built, animated: false)
    overlaySig = "" // ícones novos → reancora a foto
    // As abas novas perderam a seleção — reaplica sem animar.
    let keep = displayedKey
    displayedKey = nil
    setDisplayed(keep ?? selectedKey, bounce: false)
  }

  /// Imagem 100% transparente do tamanho do SF Symbol (mesmo layout do ícone).
  private static func clearImage(_ size: CGSize) -> UIImage {
    let fmt = UIGraphicsImageRendererFormat.preferred()
    fmt.opaque = false
    let s = CGSize(width: max(1, size.width), height: max(1, size.height))
    let img = UIGraphicsImageRenderer(size: s, format: fmt).image { _ in }
    return img.withRenderingMode(.alwaysOriginal)
  }

  private func makeItem(_ r: NTBItemRecord, at i: Int, image: UIImage?, selectedImage: UIImage?) -> UITabBarItem {
    let item = UITabBarItem(title: r.hideLabel ? nil : r.label, image: image, selectedImage: selectedImage)
    item.tag = i
    item.accessibilityLabel = r.label
    if r.hideLabel { applyNoLabelInsets(item) }
    return item
  }

  // MARK: - Sem rótulo (api 4)

  /// SF Symbol do item; sem rótulo um pouco maior (28 pt ≈ foto de 33 pt).
  private static func symbolImages(_ r: NTBItemRecord) -> (UIImage?, UIImage?) {
    let cfg: UIImage.SymbolConfiguration? = r.hideLabel
      ? UIImage.SymbolConfiguration(pointSize: 28, weight: .regular, scale: .medium) : nil
    func sym(_ name: String) -> UIImage? {
      if let cfg = cfg { return UIImage(systemName: name, withConfiguration: cfg) }
      return UIImage(systemName: name)
    }
    let img = sym(r.sfSymbol) ?? sym("circle")
    let selImg = r.sfSymbolActive.flatMap { sym($0) } ?? img
    return (img, selImg)
  }

  /// Sem título o UITabBar continua reservando a faixa do rótulo embaixo e o
  /// ícone fica "colado" em cima → desce metade dessa faixa (top +, bottom −
  /// mantém o tamanho). iPad (layout inline, ícone já centrado) = sem ajuste.
  private func applyNoLabelInsets(_ item: UITabBarItem) {
    guard traitCollection.userInterfaceIdiom == .phone else {
      item.imageInsets = .zero
      return
    }
    let dy = noLabelDy()
    item.imageInsets = UIEdgeInsets(top: dy, left: 0, bottom: -dy, right: 0)
  }

  /// Descida do ícone sem rótulo (metade da faixa do rótulo).
  private func noLabelDy() -> CGFloat {
    guard traitCollection.userInterfaceIdiom == .phone else { return 0 }
    if #available(iOS 26.0, *) { return 5 } // Liquid Glass: faixa do rótulo menor
    return 6
  }

  // MARK: - Avatar (api 3 → api 6 offline-first)
  //
  // [2026-10-19 tabbar-offline] Ordem (WhatsApp/Instagram): 1) última foto boa da
  // CONTA, do disco, síncrona na montagem; 2) cópia local do avatarCache do JS
  // (avatarLocalPath); 3) URL remota + cabeçalhos revalida em 2º plano. Falha de
  // rede NUNCA troca a foto mostrada pelo ícone. Com foto, o item da aba nasce com
  // imagem TRANSPARENTE (nada do SF Symbol por trás/em volta da foto); o ícone só
  // aparece quando não há foto nenhuma (conta nova sem foto e nada em disco).

  /// Fonte da foto: índice do item + URL remota + cópia local (api 6) + conta (api 6).
  private struct NTBAvatarSource {
    let index: Int
    let url: String
    let local: String
    let key: String
  }

  private static func trimmed(_ s: String?) -> String {
    return (s ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// Item com foto (só a aba "Você" usa). Vem dos records → vale antes dos itens existirem.
  private func avatarSource() -> NTBAvatarSource? {
    for (i, r) in records.enumerated() {
      let url = ChatyyTabBarView.trimmed(r.avatarUrl)
      let local = ChatyyTabBarView.trimmed(r.avatarLocalPath)
      let key = ChatyyTabBarView.trimmed(r.avatarKey).lowercased()
      if !url.isEmpty || !local.isEmpty || !key.isEmpty {
        return NTBAvatarSource(index: i, url: url, local: local, key: key)
      }
    }
    return nil
  }

  private func sendAvatarState(_ state: String, _ reason: String, url: String) {
    avatarState = state
    avatarReason = reason
    let key = "\(state)|\(reason)|\(url)"
    if key == avatarStateSent { return }
    avatarStateSent = key
    let scheme: String
    if url.hasPrefix("http") { scheme = "http" }
    else if url.hasPrefix("last:") { scheme = "last" }
    else if url.isEmpty { scheme = "-" }
    else { scheme = "file" }
    onAvatarState(["state": state, "reason": reason, "scheme": scheme])
  }

  /// Volta ao 1º plano / nova janela sem a foto atual → tenta de novo (sem back-off).
  private func retryAvatarIfNeeded() {
    guard let src = avatarSource() else { return }
    let current = !src.url.isEmpty ? src.url : src.local
    guard !current.isEmpty, overlayURL != current else { return }
    if !src.url.isEmpty { NTBAvatarLoader.shared.clearFailure(src.url) }
    if !src.local.isEmpty { NTBAvatarLoader.shared.clearFailure(src.local) }
    applyAvatars()
  }

  /// Sem foto na barra: esconde a camada e devolve o ícone ao item.
  private func clearAvatar() {
    guard overlayIndex != nil || !overlayURL.isEmpty || overlayPhoto != nil || !overlayKey.isEmpty else { return }
    overlayIndex = nil
    overlayURL = ""
    overlayPhoto = nil
    overlaySig = ""
    overlayKey = ""
    avatarOverlay.isHidden = true
    avatarOverlay.image = nil
    sendAvatarState("none", "", url: "")
  }

  /// SÍNCRONO: troca de conta zera a foto; sem foto → última boa da conta (disco).
  private func primeAvatarFromDisk() {
    guard let src = avatarSource() else {
      clearAvatar()
      return
    }
    overlayIndex = src.index
    if overlayKey != src.key {
      overlayKey = src.key
      overlayPhoto = nil
      overlayURL = ""
      overlaySig = ""
    }
    if overlayPhoto == nil, !src.key.isEmpty, let img = NTBAvatarLoader.shared.lastGoodImage(src.key) {
      overlayPhoto = img
      overlayURL = "last:" + src.key
      overlaySig = ""
    }
  }

  private func paintOverlay() {
    if canPaintNow {
      positionAvatarOverlay()
    } else {
      avatarPaintPending = true
    }
  }

  /// Itens só são recriados com a barra visível e ativa, ou antes de entrar na janela.
  private func rebuildItemsIfAllowed() {
    if canPaintNow || window == nil {
      buildItemsIfNeeded()
    } else {
      avatarPaintPending = true
    }
  }

  private func applyAvatars() {
    primeAvatarFromDisk()
    rebuildItemsIfAllowed()
    paintOverlay()
    guard let src = avatarSource() else { return }
    let i = src.index
    let loader = NTBAvatarLoader.shared

    // 1) remota já decodificada em memória.
    if !src.url.isEmpty {
      if overlayURL == src.url && overlayPhoto != nil { return }
      if let img = loader.cached(src.url) {
        setOverlayPhoto(img, source: src.url, key: src.key)
        return
      }
    }

    // 2) cópia local do JS (avatarCache) — instantânea, sem rede.
    if !src.local.isEmpty && overlayURL != src.local {
      if let img = loader.cached(src.local) {
        setOverlayPhoto(img, source: src.local, key: src.key)
      } else {
        let wantLocal = src.local
        let wantKey = src.key
        loader.load(wantLocal, headers: nil) { [weak self] (photo: UIImage?, _: String?) in
          guard let self = self, let photo = photo, let cur = self.avatarSource(),
                cur.key == wantKey, cur.local == wantLocal else { return }
          // A remota (mais nova) já chegou → não volta p/ a cópia local.
          if !cur.url.isEmpty && self.overlayURL == cur.url { return }
          self.setOverlayPhoto(photo, source: wantLocal, key: wantKey)
        }
      }
    }

    // 3) remota revalida em 2º plano; falhou → mantém a foto que está na tela.
    guard !src.url.isEmpty else { return }
    if overlayPhoto == nil { sendAvatarState("loading", "", url: src.url) }
    let wantURL = src.url
    loader.load(wantURL, headers: records[i].avatarHeaders) { [weak self] (photo: UIImage?, reason: String?) in
      guard let self = self, let cur = self.avatarSource(), cur.url == wantURL else { return }
      if let photo = photo {
        self.setOverlayPhoto(photo, source: wantURL, key: cur.key)
      } else {
        let kept = self.overlayPhoto != nil
        self.sendAvatarState("failed", (kept ? "kept_" : "") + (reason ?? "unknown"), url: wantURL)
      }
    }
  }

  private func setOverlayPhoto(_ photo: UIImage, source: String, key: String) {
    overlayPhoto = photo
    overlayURL = source
    overlaySig = ""
    if !key.isEmpty {
      NTBAvatarLoader.shared.rememberLastGood(photo, account: key, source: source)
    }
    rebuildItemsIfAllowed() // 1ª foto: ícone → item transparente
    paintOverlay()
  }

  /// Ícones reais do UITabBar (UIImageView com SF Symbol ou a imagem transparente
  /// da aba da foto), agrupados por coluna — no iOS 26 pode haver cópias (lente
  /// da seleção) no mesmo X.
  private func iconAnchors() -> [CGRect] {
    var found: [CGRect] = []
    let phSize = placeholderSize
    let hasPlaceholder = placeholderIndex != nil
    func isAnchorImage(_ img: UIImage) -> Bool {
      if img.isSymbolImage { return true }
      guard hasPlaceholder else { return false }
      return abs(img.size.width - phSize.width) < 1 && abs(img.size.height - phSize.height) < 1
    }
    func walk(_ v: UIView, _ depth: Int) {
      if depth > 8 { return }
      for sub in v.subviews where !sub.isHidden && sub.alpha > 0.01 {
        if let iv = sub as? UIImageView, let img = iv.image, isAnchorImage(img),
           iv.bounds.width >= 10, iv.bounds.width <= 60, iv.bounds.height >= 10, iv.bounds.height <= 60 {
          found.append(iv.convert(iv.bounds, to: self))
        }
        walk(sub, depth + 1)
      }
    }
    walk(tabBar, 0)
    found.sort { $0.midX < $1.midX }
    var cols: [CGRect] = []
    for f in found {
      if let last = cols.last, abs(last.midX - f.midX) < 8 {
        if f.width * f.height > last.width * last.height { cols[cols.count - 1] = f }
      } else {
        cols.append(f)
      }
    }
    return cols
  }

  /// Onde desenhar a foto do item `i`. Se a imagem transparente não for achada
  /// (o UITabBar pode copiá-la), deduz a coluna que falta pelas vizinhas.
  private func avatarAnchor(_ i: Int) -> CGRect? {
    let anchors = iconAnchors()
    let n = records.count
    guard i >= 0, i < n else { return nil }
    if anchors.count == n { return anchors[i] }
    guard placeholderIndex == i, anchors.count == n - 1, anchors.count >= 2 else { return nil }
    let last = anchors.count - 1
    let step = (anchors[last].midX - anchors[0].midX) / CGFloat(last)
    let midX: CGFloat
    if i == 0 {
      midX = anchors[0].midX - step
    } else if i > last {
      midX = anchors[last].midX + step
    } else {
      midX = (anchors[i - 1].midX + anchors[i].midX) / 2
    }
    var midY: CGFloat = 0
    for a in anchors { midY += a.midY }
    midY /= CGFloat(anchors.count)
    if records[i].hideLabel { midY += noLabelDy() }
    let s = placeholderSize
    return CGRect(x: midX - s.width / 2, y: midY - s.height / 2, width: s.width, height: s.height)
  }

  /// Sem âncora por > 1,2 s com o item transparente → volta ao ícone (melhor do
  /// que a aba vazia); a foto segue por cima do ícone quando der para ancorar.
  private func scheduleAnchorCheck() {
    guard placeholderIndex != nil, !placeholderBlocked, anchorCheckWork == nil else { return }
    let work = DispatchWorkItem { [weak self] in
      guard let self = self else { return }
      self.anchorCheckWork = nil
      guard self.canPaintNow, let i = self.overlayIndex, self.overlayPhoto != nil, self.placeholderIndex != nil else { return }
      if self.avatarAnchor(i) != nil {
        self.positionAvatarOverlay()
        return
      }
      self.placeholderBlocked = true
      self.buildItemsIfNeeded()
      self.sendAvatarState("failed", "anchor_blocked", url: self.overlayURL)
    }
    anchorCheckWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2, execute: work)
  }

  /// Desenha/posiciona a foto sobre o item (chamado em todo layout do UITabBar —
  /// ícones se movem com a seleção/rotação/iOS 26).
  private func positionAvatarOverlay() {
    guard let i = overlayIndex, let photo = overlayPhoto, i < records.count else {
      avatarOverlay.isHidden = true
      return
    }
    guard canPaintNow else { avatarPaintPending = true; return }
    guard let a = avatarAnchor(i) else {
      avatarOverlay.isHidden = true
      sendAvatarState("failed", "no_anchor_\(iconAnchors().count)", url: overlayURL)
      scheduleAnchorCheck()
      return
    }
    let side = records[i].hideLabel ? ntbAvatarSideNoLabel : ntbAvatarSide
    let selected = displayedKey != nil && displayedKey == records[i].key
    let dark = theme.dark
    let sig = "\(overlayURL)|\(selected)|\(theme.active.map { String($0) } ?? "-")|\(dark)|\(side)"
    if sig != overlaySig {
      overlaySig = sig
      let ring: UIColor? = selected ? ntbColor(theme.active, dark ? .white : .black) : nil
      avatarOverlay.image = ntbAvatarImage(photo, ring: ring, dark: dark, side: side)
    }
    let f = CGRect(x: (a.midX - side / 2).rounded(), y: (a.midY - side / 2).rounded(), width: side, height: side)
    if avatarOverlay.frame != f { avatarOverlay.frame = f }
    if avatarOverlay.isHidden { avatarOverlay.isHidden = false }
    bringSubviewToFront(avatarOverlay)
    sendAvatarState("loaded", "", url: overlayURL)
  }

  private func applyBadges() {
    guard let items = tabBar.items else { return }
    let bg = ntbColor(theme.badgeBackground, theme.dark ? .white : .black)
    let fg = ntbColor(theme.badgeText, theme.dark ? .black : .white)
    for (i, item) in items.enumerated() where i < records.count {
      let r = records[i]
      let value: String?
      if r.badge > 0 {
        value = r.badge > 99 ? "99+" : String(r.badge)
      } else if r.dot {
        value = ""
      } else {
        value = nil
      }
      if item.badgeValue != value { item.badgeValue = value }
      item.badgeColor = bg
      item.setBadgeTextAttributes([.foregroundColor: fg], for: .normal)
      item.setBadgeTextAttributes([.foregroundColor: fg], for: .selected)
    }
  }

  // MARK: - Theme

  private func applyTheme() {
    let dark = theme.dark
    let style: UIUserInterfaceStyle = dark ? .dark : .light
    overrideUserInterfaceStyle = style
    tabBar.overrideUserInterfaceStyle = style

    let active = ntbColor(theme.active, dark ? .white : .black)
    let inactive = ntbColor(theme.inactive, .systemGray)
    tabBar.tintColor = active
    tabBar.unselectedItemTintColor = inactive

    let ap = UITabBarAppearance()
    var glass = false
    if #available(iOS 26.0, *) { glass = true }
    if translucent || glass {
      ap.configureWithDefaultBackground()
      if !glass {
        ap.backgroundEffect = UIBlurEffect(style: dark ? .systemChromeMaterialDark : .systemChromeMaterialLight)
      }
    } else {
      ap.configureWithOpaqueBackground()
      ap.backgroundColor = ntbColor(theme.background, dark ? UIColor(white: 0.043, alpha: 1) : .white)
    }
    ap.shadowColor = ntbColor(theme.hairline, dark ? UIColor(white: 1, alpha: 0.10) : UIColor(white: 0, alpha: 0.12))

    let bg = ntbColor(theme.badgeBackground, dark ? .white : .black)
    let fg = ntbColor(theme.badgeText, dark ? .black : .white)
    for layout in [ap.stackedLayoutAppearance, ap.inlineLayoutAppearance, ap.compactInlineLayoutAppearance] {
      layout.normal.iconColor = inactive
      layout.normal.titleTextAttributes = [.foregroundColor: inactive]
      layout.selected.iconColor = active
      layout.selected.titleTextAttributes = [.foregroundColor: active]
      layout.normal.badgeBackgroundColor = bg
      layout.normal.badgeTextAttributes = [.foregroundColor: fg]
      layout.selected.badgeBackgroundColor = bg
      layout.selected.badgeTextAttributes = [.foregroundColor: fg]
    }
    tabBar.standardAppearance = ap
    if #available(iOS 15.0, *) {
      tabBar.scrollEdgeAppearance = ap
    }
    applyBadges()
    overlaySig = ""
    applyAvatars() // anel/contorno seguem a cor ativa e o modo escuro
  }

  // MARK: - Selection

  private func index(of key: String?) -> Int? {
    guard let key = key else { return nil }
    return records.firstIndex { $0.key == key }
  }

  private func setDisplayed(_ key: String?, bounce: Bool) {
    guard let items = tabBar.items else { displayedKey = key; return }
    if let i = index(of: key), i < items.count {
      if tabBar.selectedItem !== items[i] { tabBar.selectedItem = items[i] }
      let changed = displayedKey != key
      displayedKey = key
      if bounce && changed { bounceIcon(at: i) }
    } else {
      if tabBar.selectedItem != nil { tabBar.selectedItem = nil }
      displayedKey = nil
    }
    if overlayPhoto != nil { positionAvatarOverlay() }
  }

  private func scheduleResync() {
    resyncWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self = self else { return }
      self.resyncWork = nil
      if self.displayedKey != self.selectedKey {
        self.setDisplayed(self.selectedKey, bounce: false)
      }
    }
    resyncWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.7, execute: work)
  }

  func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
    let i = item.tag
    guard i >= 0, i < records.count else { return }
    let r = records[i]
    if r.key != displayedKey {
      selectionFeedback.selectionChanged()
    }
    if r.selectable {
      if r.key != displayedKey {
        displayedKey = r.key
        bounceIcon(at: i)
      }
    } else {
      // Ex.: Email abre outra tela — a seleção volta para a aba atual no
      // mesmo ciclo (sem frame pintado com a aba errada).
      let keep = displayedKey
      displayedKey = nil
      setDisplayed(keep, bounce: false)
      bounceIcon(at: i)
    }
    scheduleResync()
    onTabPress(["key": r.key])
  }

  // MARK: - Long press

  private func tabButtons() -> [UIView] {
    return tabBar.subviews
      .filter { $0 is UIControl }
      .sorted { $0.frame.minX < $1.frame.minX }
  }

  private func indexAt(_ p: CGPoint) -> Int? {
    guard !records.isEmpty else { return nil }
    let buttons = tabButtons()
    if buttons.count == records.count {
      for (i, b) in buttons.enumerated() where p.x >= b.frame.minX && p.x <= b.frame.maxX {
        return i
      }
    }
    let w = tabBar.bounds.width
    guard w > 0 else { return nil }
    let i = Int(p.x / (w / CGFloat(records.count)))
    return max(0, min(records.count - 1, i))
  }

  override func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
    guard g === longPress else { return super.gestureRecognizerShouldBegin(g) }
    guard let i = indexAt(g.location(in: tabBar)) else { return false }
    return records[i].longPress
  }

  @objc private func handleLongPress(_ g: UILongPressGestureRecognizer) {
    guard g.state == .began, let i = indexAt(g.location(in: tabBar)), records[i].longPress else { return }
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    bounceIcon(at: i)
    onTabLongPress(["key": records[i].key])
  }

  // MARK: - Motion

  private func bounceIcon(at index: Int) {
    guard bounceEnabled, !UIAccessibility.isReduceMotionEnabled else { return }
    if #available(iOS 26.0, *) { return }
    let buttons = tabButtons()
    guard buttons.count == records.count, index >= 0, index < buttons.count else { return }
    guard let icon = buttons[index].subviews.first(where: { $0 is UIImageView }) else { return }
    let a = CASpringAnimation(keyPath: "transform.scale")
    a.fromValue = 0.74
    a.toValue = 1.0
    a.mass = 0.7
    a.stiffness = 320
    a.damping = 11
    a.initialVelocity = 2
    a.duration = a.settlingDuration
    a.isRemovedOnCompletion = true
    icon.layer.add(a, forKey: "ntb.bounce")
  }
}

/// [2026-10-19 tabbar-api5] UITabBar que avisa a cada layout (a foto da aba
/// "Você" segue o ícone real — seleção/rotação/Liquid Glass movem os ícones).
final class NTBTabBar: UITabBar {
  var onLayout: (() -> Void)?
  override func layoutSubviews() {
    super.layoutSubviews()
    onLayout?()
  }
}
