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
final class ChatyyTabBarView: ExpoView, UITabBarDelegate, UIGestureRecognizerDelegate {
  let onTabPress = EventDispatcher()
  let onTabLongPress = EventDispatcher()
  let onPreferredHeight = EventDispatcher()
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
    let sig = records.map { "\($0.key)|\($0.label)|\($0.sfSymbol)|\($0.sfSymbolActive ?? "")" }.joined(separator: "\n")
    if sig != structureSignature || (tabBar.items?.count ?? -1) != records.count {
      structureSignature = sig
      var built: [UITabBarItem] = []
      for (i, r) in records.enumerated() {
        let img = UIImage(systemName: r.sfSymbol) ?? UIImage(systemName: "circle")
        let selImg = r.sfSymbolActive.flatMap { UIImage(systemName: $0) } ?? img
        let item = UITabBarItem(title: r.label, image: img, selectedImage: selImg)
        item.tag = i
        built.append(item)
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

  // MARK: - Avatar (api 3)

  private static func avatarURL(_ r: NTBItemRecord) -> String {
    return (r.avatarUrl ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func applyAvatars() {
    guard let items = tabBar.items else { return }
    for (i, item) in items.enumerated() where i < records.count {
      let r = records[i]
      let url = ChatyyTabBarView.avatarURL(r)
      if url.isEmpty {
        if avatarSig[i] != nil { restoreSymbol(at: i) }
        continue
      }
      if let photo = NTBAvatarLoader.shared.cached(url) {
        paintAvatar(item, at: i, photo: photo, url: url)
        continue
      }
      // Enquanto baixa: mantém o que já está (SF Symbol ou a foto anterior,
      // quando só mudou a versão `v=` da URL) — sem piscar.
      NTBAvatarLoader.shared.load(url, headers: r.avatarHeaders) { [weak self] photo in
        guard let self = self, i < self.records.count,
              ChatyyTabBarView.avatarURL(self.records[i]) == url,
              let items = self.tabBar.items, i < items.count else { return }
        if let photo = photo {
          self.paintAvatar(items[i], at: i, photo: photo, url: url)
        } else if self.avatarSig[i] != nil {
          self.restoreSymbol(at: i)
        }
      }
    }
  }

  private func paintAvatar(_ item: UITabBarItem, at i: Int, photo: UIImage, url: String) {
    let dark = theme.dark
    let ring = ntbColor(theme.active, dark ? .white : .black)
    let sig = "\(url)|\(theme.active.map { String($0) } ?? "-")|\(dark)"
    if avatarSig[i] == sig { return }
    avatarSig[i] = sig
    item.image = ntbAvatarImage(photo, ring: nil, dark: dark)
    item.selectedImage = ntbAvatarImage(photo, ring: ring, dark: dark)
  }

  private func restoreSymbol(at i: Int) {
    avatarSig[i] = nil
    guard let items = tabBar.items, i < items.count, i < records.count else { return }
    let r = records[i]
    let img = UIImage(systemName: r.sfSymbol) ?? UIImage(systemName: "circle")
    items[i].image = img
    items[i].selectedImage = r.sfSymbolActive.flatMap { UIImage(systemName: $0) } ?? img
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
