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
final class ChatyyTabBarView: ExpoView, UITabBarDelegate, UIGestureRecognizerDelegate {
  let onTabPress = EventDispatcher()
  let onTabLongPress = EventDispatcher()
  let onPreferredHeight = EventDispatcher()
  /// [2026-10-18 tabbar-invisivel] api 4: barra não consegue se desenhar → JS usa a barra JS.
  let onBarFail = EventDispatcher()
  private var barFailSent = false
  private var healthWork: DispatchWorkItem?
  /// Foto chegou com a view fora da janela / app inativo → pinta ao voltar.
  private var avatarPaintPending = false
  private var reportedHeight: CGFloat = 0

  private let tabBar = UITabBar()
  private var records: [NTBItemRecord] = []
  private var structureSignature = ""
  private var itemsDirty = false

  private var selectedKey: String? = nil
  private var selectedDirty = false
  private var displayedKey: String? = nil

  private var theme = NTBThemeRecord()
  private var themeDirty = true
  private var translucent = true

  /// Item i → assinatura do que está pintado nele ("url|cor|escuro"); nil = SF Symbol.
  private var avatarSig: [Int: String] = [:]

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
    addSubview(tabBar)
    tabBar.addGestureRecognizer(longPress)
    NotificationCenter.default.addObserver(
      self, selector: #selector(appDidBecomeActive),
      name: UIApplication.didBecomeActiveNotification, object: nil)
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    healthWork?.cancel()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil else { return }
    // Nova janela (ou a mesma de volta): a altura preferida pode ter mudado e o
    // JS pode ter remontado — reenvia.
    reportedHeight = 0
    setNeedsLayout()
    flushPendingAvatars()
    scheduleHealthCheck(delay: 0.35, attempt: 0)
  }

  @objc private func appDidBecomeActive() {
    guard window != nil else { return }
    flushPendingAvatars()
    scheduleHealthCheck(delay: 0.35, attempt: 0)
  }

  private var canPaintNow: Bool {
    return window != nil && UIApplication.shared.applicationState == .active
  }

  private func flushPendingAvatars() {
    guard avatarPaintPending, canPaintNow else { return }
    avatarPaintPending = false
    applyAvatars()
  }

  // MARK: - Saúde (api 4)

  /// nil = ok; senão o motivo do problema (já tentando reparar o que dá).
  private func healthProblem(repair: Bool) -> String? {
    if bounds.width < 1 || bounds.height < 40 { return "zero_frame" }
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
      guard let problem = self.healthProblem(repair: attempt == 0) else { return }
      if attempt == 0 {
        self.scheduleHealthCheck(delay: 0.3, attempt: 1)
      } else if !self.barFailSent {
        self.barFailSent = true
        self.onBarFail(["reason": problem])
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
    reportPreferredHeight()
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

  func setItems(_ list: [NTBItemRecord]) {
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
    let sig = records.map { "\($0.key)|\($0.label)|\($0.sfSymbol)|\($0.sfSymbolActive ?? "")|\($0.hideLabel)" }.joined(separator: "\n")
    if sig != structureSignature || (tabBar.items?.count ?? -1) != records.count {
      structureSignature = sig
      var built: [UITabBarItem] = []
      for (i, r) in records.enumerated() {
        let (img, selImg) = ChatyyTabBarView.symbolImages(r)
        built.append(makeItem(r, at: i, image: img, selectedImage: selImg))
      }
      tabBar.setItems(built, animated: false)
      avatarSig.removeAll()
      // As abas novas perderam a seleção — reaplica sem animar.
      let keep = displayedKey
      displayedKey = nil
      setDisplayed(keep ?? selectedKey, bounce: false)
    }
    applyBadges()
    applyAvatars()
  }

  private func makeItem(_ r: NTBItemRecord, at i: Int, image: UIImage?, selectedImage: UIImage?) -> UITabBarItem {
    let item = UITabBarItem(title: r.hideLabel ? nil : r.label, image: image, selectedImage: selectedImage)
    item.tag = i
    item.accessibilityLabel = r.label
    if r.hideLabel { applyNoLabelInsets(item) }
    return item
  }

  /// [2026-10-18 tabbar-invisivel] Troca a imagem do item i RECRIANDO o
  /// UITabBarItem + setItems (nunca muta image/selectedImage de um item já
  /// exibido — suspeita nº 1 da barra invisível do build 728).
  private func replaceItemImages(at i: Int, image: UIImage?, selectedImage: UIImage?) {
    guard var items = tabBar.items, i < items.count, i < records.count else { return }
    let old = items[i]
    let fresh = makeItem(records[i], at: i, image: image, selectedImage: selectedImage)
    fresh.badgeValue = old.badgeValue
    fresh.badgeColor = old.badgeColor
    items[i] = fresh
    tabBar.setItems(items, animated: false)
    applyBadges()
    let keep = displayedKey
    displayedKey = nil
    setDisplayed(keep ?? selectedKey, bounce: false)
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
    var dy: CGFloat = 6
    if #available(iOS 26.0, *) { dy = 5 } // Liquid Glass: faixa do rótulo menor
    item.imageInsets = UIEdgeInsets(top: dy, left: 0, bottom: -dy, right: 0)
  }

  // MARK: - Avatar (api 3)

  private static func avatarURL(_ r: NTBItemRecord) -> String {
    return (r.avatarUrl ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func applyAvatars() {
    guard let items = tabBar.items else { return }
    for i in items.indices where i < records.count {
      let r = records[i]
      let url = ChatyyTabBarView.avatarURL(r)
      if url.isEmpty {
        if avatarSig[i] != nil {
          if canPaintNow { restoreSymbol(at: i) } else { avatarPaintPending = true }
        }
        continue
      }
      if let photo = NTBAvatarLoader.shared.cached(url) {
        if canPaintNow { paintAvatar(at: i, photo: photo, url: url) } else { avatarPaintPending = true }
        continue
      }
      // Enquanto baixa: mantém o que já está (SF Symbol ou a foto anterior,
      // quando só mudou a versão `v=` da URL) — sem piscar.
      NTBAvatarLoader.shared.load(url, headers: r.avatarHeaders) { [weak self] photo in
        guard let self = self, i < self.records.count,
              ChatyyTabBarView.avatarURL(self.records[i]) == url,
              i < (self.tabBar.items?.count ?? 0) else { return }
        if !self.canPaintNow {
          // Fora da janela / 2º plano: pinta quando voltar (flushPendingAvatars).
          self.avatarPaintPending = true
          return
        }
        if let photo = photo {
          self.paintAvatar(at: i, photo: photo, url: url)
        } else if self.avatarSig[i] != nil {
          self.restoreSymbol(at: i)
        }
      }
    }
  }

  private func paintAvatar(at i: Int, photo: UIImage, url: String) {
    let dark = theme.dark
    let ring = ntbColor(theme.active, dark ? .white : .black)
    let side = (i < records.count && records[i].hideLabel) ? ntbAvatarSideNoLabel : ntbAvatarSide
    let sig = "\(url)|\(theme.active.map { String($0) } ?? "-")|\(dark)|\(side)"
    if avatarSig[i] == sig { return }
    avatarSig[i] = sig
    replaceItemImages(at: i,
                      image: ntbAvatarImage(photo, ring: nil, dark: dark, side: side),
                      selectedImage: ntbAvatarImage(photo, ring: ring, dark: dark, side: side))
  }

  private func restoreSymbol(at i: Int) {
    avatarSig[i] = nil
    guard i < (tabBar.items?.count ?? 0), i < records.count else { return }
    let (img, selImg) = ChatyyTabBarView.symbolImages(records[i])
    replaceItemImages(at: i, image: img, selectedImage: selImg)
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
