import ExpoModulesCore
import UIKit

// [2026-10-15 native-emoji] Painel Emoji | Figurinhas | GIF do composer.
// Layout manual (frames) em layoutSubviews; dados de figurinhas/GIF vêm do JS,
// emoji/recentes/tons são locais (EPEmojiStore). Contrato: SPEC + index.ts.

private enum EPTab: Int { case emoji = 0, stickers = 1, gif = 2 }

private struct EPEmojiItem {
  let text: String
  let emoji: EPEmoji?
}

private struct EPEmojiSection {
  let title: String
  let category: Int // -1 = recentes, -2 = busca
  var items: [EPEmojiItem]
}

private struct EPStickerSection {
  let key: String
  let title: String
  let icon: String
  let cover: String
  let loading: Bool
  let items: [(key: String, uri: String)]
}

private struct EPGif {
  let key: String
  let uri: String
  let w: CGFloat
  let h: CGFloat
}

final class ChatyyEmojiPanelView: ExpoView, UICollectionViewDataSource, UICollectionViewDelegateFlowLayout, UITextFieldDelegate, UIGestureRecognizerDelegate {
  // MARK: Events
  let onEmoji = EventDispatcher()
  let onBackspace = EventDispatcher()
  let onSticker = EventDispatcher()
  let onGif = EventDispatcher()
  let onGifQuery = EventDispatcher()
  let onSection = EventDispatcher()
  let onTabChange = EventDispatcher()
  let onMore = EventDispatcher()
  let onSearchFocus = EventDispatcher()

  // MARK: Props (aplicadas em didUpdateProps)
  var pendingTheme: [String: Any]? = nil
  var labels: [String: String] = [:] { didSet { labelsDirty = true } }
  var tabProp: String = "emoji" { didSet { if tabProp != oldValue { tabDirty = true } } }
  var bottomInset: CGFloat = 0 { didSet { if bottomInset != oldValue { setNeedsLayout() } } }
  var compact = false { didSet { if compact != oldValue { compactDirty = true } } }
  var showStickers = true { didSet { if showStickers != oldValue { tabsDirty = true } } }
  var showGifs = true { didSet { if showGifs != oldValue { tabsDirty = true } } }
  var pendingStickers: [[String: Any]]? = nil
  var pendingGifs: [[String: Any]]? = nil
  var gifLoading = false { didSet { if gifLoading != oldValue { gifStateDirty = true } } }

  private var labelsDirty = true
  private var tabDirty = true
  private var compactDirty = false
  private var tabsDirty = true
  private var gifStateDirty = false

  // MARK: State
  private var theme = EPTheme()
  private var tab: EPTab = .emoji
  private var emojiSections: [EPEmojiSection] = []
  private var emojiQuery = ""
  private var stickerSections: [EPStickerSection] = []
  private var gifs: [EPGif] = []
  private var gifQuery = ""
  private var gifTimer: Timer?
  private var selectedCategory = 0 // 0 = recentes, 1...8 = categorias
  private var requestedSections = Set<String>()
  private var tonePopover: EPTonePopover?
  private var toneTarget: (item: EPEmojiItem, indexPath: IndexPath, collection: UICollectionView)?
  private var backspaceTimer: Timer?
  private var lastWidth: CGFloat = 0
  private var programmaticScroll = false

  // MARK: Subviews
  private let pagesHost = UIView()
  private let emojiPage = UIView()
  private let stickerPage = UIView()
  private let gifPage = UIView()

  private let emojiSearch = EPSearchField()
  private let categoryBar = UIView()
  private var categoryButtons: [UIButton] = []
  private let categoryPill = UIView()
  private let emojiCollection = UICollectionView(frame: .zero, collectionViewLayout: ChatyyEmojiPanelView.makeLayout(vertical: true))
  private let emojiEmpty = UILabel()

  private let stickerBar = UIScrollView()
  private var stickerTabButtons: [UIButton] = []
  private let stickerPill = UIView()
  private let stickerMore = UIButton(type: .system)
  private let stickerBarHairline = UIView()
  private let stickerCollection = UICollectionView(frame: .zero, collectionViewLayout: ChatyyEmojiPanelView.makeLayout(vertical: true))
  private var selectedStickerSection = 0

  private let gifSearch = EPSearchField()
  private let gifCollection = UICollectionView(frame: .zero, collectionViewLayout: ChatyyEmojiPanelView.makeLayout(vertical: true))
  private let gifEmpty = UILabel()
  private let gifSpinner = UIActivityIndicatorView(style: .medium)

  private let compactCollection = UICollectionView(frame: .zero, collectionViewLayout: ChatyyEmojiPanelView.makeLayout(vertical: false))

  private let bottomBar = UIView()
  private let bottomHairline = UIView()
  private var tabButtons: [UIButton] = []
  private let tabPill = UIView()
  private let backspaceButton = UIButton(type: .system)

  private let selectionHaptic = UISelectionFeedbackGenerator()
  private let impactHaptic = UIImpactFeedbackGenerator(style: .light)

  // MARK: Metrics
  private let searchH: CGFloat = 36
  private let categoryH: CGFloat = 40
  private let barH: CGFloat = 44
  private let stickerBarH: CGFloat = 46

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    EPEmojiStore.shared.loadIfNeeded()
    buildViews()
    rebuildEmojiSections()
  }

  private static func makeLayout(vertical: Bool) -> UICollectionViewFlowLayout {
    let l = UICollectionViewFlowLayout()
    l.scrollDirection = vertical ? .vertical : .horizontal
    l.minimumInteritemSpacing = 0
    l.minimumLineSpacing = 0
    l.sectionHeadersPinToVisibleBounds = false
    return l
  }

  private func setupCollection(_ c: UICollectionView) {
    c.backgroundColor = .clear
    c.dataSource = self
    c.delegate = self
    c.alwaysBounceVertical = c !== compactCollection
    c.alwaysBounceHorizontal = c === compactCollection
    c.showsVerticalScrollIndicator = false
    c.showsHorizontalScrollIndicator = false
    c.keyboardDismissMode = .none
    c.delaysContentTouches = false
    c.register(EPEmojiCell.self, forCellWithReuseIdentifier: EPEmojiCell.reuse)
    c.register(EPImageCell.self, forCellWithReuseIdentifier: EPImageCell.reuse)
    c.register(EPHeaderView.self, forSupplementaryViewOfKind: UICollectionView.elementKindSectionHeader, withReuseIdentifier: EPHeaderView.reuse)
    if #available(iOS 15.0, *) { c.isPrefetchingEnabled = true }
  }

  private func buildViews() {
    addSubview(pagesHost)
    for p in [emojiPage, stickerPage, gifPage] { pagesHost.addSubview(p) }

    // Emoji
    emojiPage.addSubview(emojiSearch)
    emojiSearch.field.delegate = self
    emojiSearch.field.addTarget(self, action: #selector(emojiQueryChanged), for: .editingChanged)
    emojiSearch.clear.addTarget(self, action: #selector(clearEmojiSearch), for: .touchUpInside)
    emojiPage.addSubview(categoryBar)
    categoryPill.layer.cornerRadius = 9
    categoryPill.layer.cornerCurve = .continuous
    categoryBar.addSubview(categoryPill)
    let catSymbols: [[String]] = [
      ["clock"], ["face.smiling"], ["pawprint", "leaf"], ["fork.knife", "takeoutbag.and.cup.and.straw", "cup.and.saucer"],
      ["soccerball", "sportscourt", "gamecontroller"], ["car", "airplane"], ["lightbulb"], ["heart"], ["flag"],
    ]
    for (i, names) in catSymbols.enumerated() {
      let b = UIButton(type: .system)
      b.setImage(EPGlyph.symbol(names, size: 17, weight: .regular), for: .normal)
      b.tag = i
      b.addTarget(self, action: #selector(categoryTapped(_:)), for: .touchUpInside)
      categoryBar.addSubview(b)
      categoryButtons.append(b)
    }
    setupCollection(emojiCollection)
    emojiPage.addSubview(emojiCollection)
    emojiEmpty.textAlignment = .center
    emojiEmpty.font = UIFont.systemFont(ofSize: 14)
    emojiEmpty.isHidden = true
    emojiPage.addSubview(emojiEmpty)

    // Figurinhas
    stickerBar.showsHorizontalScrollIndicator = false
    stickerBar.alwaysBounceHorizontal = true
    stickerPill.layer.cornerRadius = 10
    stickerPill.layer.cornerCurve = .continuous
    stickerBar.addSubview(stickerPill)
    stickerPage.addSubview(stickerBar)
    stickerMore.setImage(EPGlyph.symbol(["ellipsis"], size: 17, weight: .semibold), for: .normal)
    stickerMore.addTarget(self, action: #selector(moreTapped), for: .touchUpInside)
    stickerPage.addSubview(stickerMore)
    stickerPage.addSubview(stickerBarHairline)
    setupCollection(stickerCollection)
    stickerPage.addSubview(stickerCollection)

    // GIF
    gifPage.addSubview(gifSearch)
    gifSearch.field.delegate = self
    gifSearch.field.addTarget(self, action: #selector(gifQueryChanged), for: .editingChanged)
    gifSearch.clear.addTarget(self, action: #selector(clearGifSearch), for: .touchUpInside)
    setupCollection(gifCollection)
    gifPage.addSubview(gifCollection)
    gifEmpty.textAlignment = .center
    gifEmpty.font = UIFont.systemFont(ofSize: 14)
    gifEmpty.isHidden = true
    gifPage.addSubview(gifEmpty)
    gifSpinner.hidesWhenStopped = true
    gifPage.addSubview(gifSpinner)

    // Compacto (busca com teclado aberto)
    setupCollection(compactCollection)
    compactCollection.isHidden = true
    addSubview(compactCollection)

    // Barra inferior
    addSubview(bottomBar)
    bottomBar.addSubview(bottomHairline)
    tabPill.layer.cornerRadius = 10
    tabPill.layer.cornerCurve = .continuous
    bottomBar.addSubview(tabPill)
    let tabImages: [UIImage?] = [EPGlyph.symbol(["face.smiling"], size: 19), EPGlyph.sticker(size: 20), EPGlyph.gif(size: 20)]
    for (i, img) in tabImages.enumerated() {
      let b = UIButton(type: .system)
      b.setImage(img, for: .normal)
      b.tag = i
      b.addTarget(self, action: #selector(tabTapped(_:)), for: .touchUpInside)
      bottomBar.addSubview(b)
      tabButtons.append(b)
    }
    backspaceButton.setImage(EPGlyph.symbol(["delete.left"], size: 19), for: .normal)
    backspaceButton.addTarget(self, action: #selector(backspaceTapped), for: .touchUpInside)
    let lp = UILongPressGestureRecognizer(target: self, action: #selector(backspaceLongPress(_:)))
    lp.minimumPressDuration = 0.4
    backspaceButton.addGestureRecognizer(lp)
    bottomBar.addSubview(backspaceButton)

    // Tons de pele (segurar)
    for c in [emojiCollection, compactCollection] {
      let g = UILongPressGestureRecognizer(target: self, action: #selector(toneLongPress(_:)))
      g.minimumPressDuration = 0.3
      g.delegate = self
      c.addGestureRecognizer(g)
    }
    applyTheme()
  }

  // MARK: Props → estado

  func didUpdateProps() {
    if let t = pendingTheme {
      pendingTheme = nil
      theme = EPTheme.from(t)
      applyTheme()
    }
    if labelsDirty {
      labelsDirty = false
      applyLabels()
    }
    if let s = pendingStickers {
      pendingStickers = nil
      stickerSections = s.map { (d: [String: Any]) -> EPStickerSection in
        let items = ((d["items"] as? [[String: Any]]) ?? []).compactMap { it -> (key: String, uri: String)? in
          let u = epStr(it["uri"])
          if u.isEmpty { return nil }
          let k = epStr(it["key"])
          return (key: k.isEmpty ? u : k, uri: u)
        }
        return EPStickerSection(
          key: epStr(d["key"]), title: epStr(d["title"]), icon: epStr(d["icon"]),
          cover: epStr(d["coverUri"]), loading: epBool(d["loading"]), items: items
        )
      }
      if selectedStickerSection >= stickerSections.count { selectedStickerSection = 0 }
      rebuildStickerBar()
      stickerCollection.reloadData()
    }
    if let g = pendingGifs {
      pendingGifs = nil
      gifs = g.compactMap { (d: [String: Any]) -> EPGif? in
        let u = epStr(d["uri"])
        if u.isEmpty { return nil }
        let k = epStr(d["key"])
        return EPGif(key: k.isEmpty ? u : k, uri: u, w: CGFloat(epNum(d["width"]) ?? 1), h: CGFloat(epNum(d["height"]) ?? 1))
      }
      gifCollection.reloadData()
      if compact && tab == .gif { compactCollection.reloadData() }
      gifStateDirty = true
    }
    if gifStateDirty {
      gifStateDirty = false
      updateGifState()
    }
    if tabsDirty {
      tabsDirty = false
      if (!showStickers && tab == .stickers) || (!showGifs && tab == .gif) { setTab(.emoji, emit: true, animated: false) }
      setNeedsLayout()
    }
    if tabDirty {
      tabDirty = false
      let t: EPTab = tabProp == "stickers" ? .stickers : (tabProp == "gif" ? .gif : .emoji)
      if t != tab || window == nil { setTab(t, emit: false, animated: window != nil) }
    }
    if compactDirty {
      compactDirty = false
      applyCompact(animated: true)
    }
  }

  private func applyTheme() {
    backgroundColor = theme.background
    emojiSearch.apply(theme, placeholder: labels["search"] ?? "Buscar emoji")
    gifSearch.apply(theme, placeholder: labels["gifSearch"] ?? "Buscar GIF")
    categoryPill.backgroundColor = theme.selection
    stickerPill.backgroundColor = theme.selection
    tabPill.backgroundColor = theme.selection
    bottomBar.backgroundColor = theme.background
    bottomHairline.backgroundColor = theme.hairline
    stickerBarHairline.backgroundColor = theme.hairline
    emojiEmpty.textColor = theme.secondary
    gifEmpty.textColor = theme.secondary
    gifSpinner.color = theme.secondary
    stickerMore.tintColor = theme.icon
    backspaceButton.tintColor = theme.icon
    emojiCollection.indicatorStyle = theme.dark ? .white : .black
    tintCategoryButtons()
    tintTabButtons()
    tintStickerButtons()
    emojiCollection.reloadData()
    stickerCollection.reloadData()
    gifCollection.reloadData()
  }

  private func applyLabels() {
    emojiSearch.apply(theme, placeholder: labels["search"] ?? "Buscar emoji")
    gifSearch.apply(theme, placeholder: labels["gifSearch"] ?? "Buscar GIF")
    emojiEmpty.text = labels["noResults"] ?? ""
    gifEmpty.text = labels["noResults"] ?? ""
    let tabNames = [labels["emoji"] ?? "Emoji", labels["stickers"] ?? "Figurinhas", labels["gif"] ?? "GIF"]
    for (i, b) in tabButtons.enumerated() { b.accessibilityLabel = tabNames[i] }
    backspaceButton.accessibilityLabel = labels["backspace"] ?? "Apagar"
    stickerMore.accessibilityLabel = labels["more"] ?? ""
    for (i, b) in categoryButtons.enumerated() {
      b.accessibilityLabel = i == 0 ? (labels["recent"] ?? "") : (labels["cat\(i - 1)"] ?? "")
    }
    rebuildEmojiSections()
    emojiCollection.reloadData()
  }

  private func tintCategoryButtons() {
    for b in categoryButtons {
      b.tintColor = b.tag == selectedCategory ? theme.iconActive : theme.icon
    }
  }

  private func tintTabButtons() {
    for b in tabButtons { b.tintColor = b.tag == tab.rawValue ? theme.iconActive : theme.icon }
  }

  private func tintStickerButtons() {
    for b in stickerTabButtons {
      b.tintColor = b.tag == selectedStickerSection ? theme.iconActive : theme.icon
    }
  }

  // MARK: Emoji data

  private func rebuildEmojiSections() {
    let store = EPEmojiStore.shared
    if !emojiQuery.isEmpty {
      let res = store.search(emojiQuery).map { EPEmojiItem(text: store.display($0), emoji: $0) }
      emojiSections = [EPEmojiSection(title: "", category: -2, items: res)]
      emojiEmpty.isHidden = !res.isEmpty
      return
    }
    emojiEmpty.isHidden = true
    var out: [EPEmojiSection] = []
    let rec = store.recents.map { s -> EPEmojiItem in
      EPEmojiItem(text: s, emoji: store.emoji(forBase: store.baseOf(s)))
    }
    if !rec.isEmpty { out.append(EPEmojiSection(title: labels["recent"] ?? "", category: -1, items: rec)) }
    for (i, cat) in store.categories.enumerated() where !cat.isEmpty {
      out.append(EPEmojiSection(title: labels["cat\(i)"] ?? "", category: i, items: cat.map { EPEmojiItem(text: store.display($0), emoji: $0) }))
    }
    emojiSections = out
  }

  private func compactEmojiItems() -> [EPEmojiItem] {
    if !emojiQuery.isEmpty { return emojiSections.first?.items ?? [] }
    let store = EPEmojiStore.shared
    return store.recents.map { EPEmojiItem(text: $0, emoji: store.emoji(forBase: store.baseOf($0))) }
  }

  // MARK: Layout

  override func layoutSubviews() {
    super.layoutSubviews()
    let W = bounds.width, H = bounds.height
    if W <= 0 || H <= 0 { return }
    let widthChanged = abs(W - lastWidth) > 0.5
    lastWidth = W

    if compact {
      bottomBar.frame = CGRect(x: 0, y: H, width: W, height: barH + bottomInset)
      pagesHost.frame = CGRect(x: 0, y: 0, width: W, height: H)
      layoutPagesCompact(W: W, H: H)
    } else {
      let barTotal = barH + bottomInset
      bottomBar.frame = CGRect(x: 0, y: H - barTotal, width: W, height: barTotal)
      pagesHost.frame = CGRect(x: 0, y: 0, width: W, height: max(0, H - barTotal))
      layoutPages(W: W, H: pagesHost.bounds.height)
    }
    layoutBottomBar(W: W)
    if widthChanged {
      for c in [emojiCollection, stickerCollection, gifCollection, compactCollection] { c.collectionViewLayout.invalidateLayout() }
    }
  }

  private func layoutPages(W: CGFloat, H: CGFloat) {
    for p in [emojiPage, stickerPage, gifPage] { setPageFrame(p, W: W, H: H) }
    // Emoji
    emojiSearch.frame = CGRect(x: 10, y: 8, width: W - 20, height: searchH)
    categoryBar.isHidden = false
    categoryBar.alpha = emojiQuery.isEmpty ? 1 : 0.35
    categoryBar.frame = CGRect(x: 4, y: 8 + searchH + 2, width: W - 8, height: categoryH)
    let n = CGFloat(categoryButtons.count)
    let bw = categoryBar.bounds.width / n
    for (i, b) in categoryButtons.enumerated() {
      b.frame = CGRect(x: CGFloat(i) * bw, y: 0, width: bw, height: categoryH)
    }
    layoutCategoryPill(animated: false)
    let gridTop = categoryBar.frame.maxY
    emojiCollection.isHidden = false
    emojiCollection.frame = CGRect(x: 0, y: gridTop, width: W, height: max(0, H - gridTop))
    emojiEmpty.frame = CGRect(x: 20, y: gridTop + 24, width: W - 40, height: 22)
    // Figurinhas
    stickerMore.frame = CGRect(x: W - 48, y: 0, width: 48, height: stickerBarH)
    stickerBar.frame = CGRect(x: 0, y: 0, width: W - 48, height: stickerBarH)
    stickerBarHairline.frame = CGRect(x: 0, y: stickerBarH - (1 / UIScreen.main.scale), width: W, height: 1 / UIScreen.main.scale)
    layoutStickerBar()
    stickerCollection.frame = CGRect(x: 0, y: stickerBarH, width: W, height: max(0, H - stickerBarH))
    // GIF
    gifSearch.frame = CGRect(x: 10, y: 8, width: W - 20, height: searchH)
    gifCollection.isHidden = false
    gifCollection.frame = CGRect(x: 0, y: 8 + searchH + 6, width: W, height: max(0, H - (8 + searchH + 6)))
    gifEmpty.frame = CGRect(x: 20, y: gifCollection.frame.minY + 30, width: W - 40, height: 22)
    gifSpinner.center = CGPoint(x: W / 2, y: gifCollection.frame.minY + 44)
    compactCollection.isHidden = true
    positionPages(animated: false)
  }

  /// Páginas têm transform (troca de aba) → bounds/center, nunca frame.
  private func setPageFrame(_ p: UIView, W: CGFloat, H: CGFloat) {
    p.bounds = CGRect(x: 0, y: 0, width: W, height: H)
    p.center = CGPoint(x: W / 2, y: H / 2)
  }

  private func layoutPagesCompact(W: CGFloat, H: CGFloat) {
    for p in [emojiPage, stickerPage, gifPage] { setPageFrame(p, W: W, H: H) }
    emojiSearch.frame = CGRect(x: 10, y: 6, width: W - 20, height: searchH)
    gifSearch.frame = CGRect(x: 10, y: 6, width: W - 20, height: searchH)
    categoryBar.isHidden = true
    emojiCollection.isHidden = true
    emojiEmpty.isHidden = true
    gifCollection.isHidden = true
    gifEmpty.isHidden = true
    gifSpinner.center = CGPoint(x: W / 2, y: 6 + searchH + max(20, H - 6 - searchH - bottomInset) / 2)
    let top = 6 + searchH + 4
    compactCollection.isHidden = false
    // bottomInset no modo compacto = faixa que fica atrás do teclado (JS).
    compactCollection.frame = CGRect(x: 0, y: top, width: W, height: max(0, H - top - 2 - bottomInset))
    bringSubviewToFront(compactCollection)
    positionPages(animated: false)
  }

  private func layoutBottomBar(W: CGFloat) {
    bottomHairline.frame = CGRect(x: 0, y: 0, width: W, height: 1 / UIScreen.main.scale)
    let visible = visibleTabs()
    let segW: CGFloat = 54
    let total = segW * CGFloat(visible.count)
    var x = (W - total) / 2
    for b in tabButtons {
      let isVisible = visible.contains(b.tag)
      b.isHidden = !isVisible || visible.count < 2
      if isVisible {
        b.frame = CGRect(x: x, y: 4, width: segW, height: barH - 8)
        x += segW
      }
    }
    tabPill.isHidden = visible.count < 2
    layoutTabPill(animated: false)
    backspaceButton.frame = CGRect(x: W - 56, y: 0, width: 52, height: barH)
    backspaceButton.alpha = tab == .emoji ? 1 : 0
    backspaceButton.isUserInteractionEnabled = tab == .emoji
  }

  private func visibleTabs() -> [Int] {
    var v = [0]
    if showStickers { v.append(1) }
    if showGifs { v.append(2) }
    return v
  }

  private func layoutTabPill(animated: Bool) {
    guard let b = tabButtons.first(where: { $0.tag == tab.rawValue && !$0.isHidden }) else { return }
    let f = b.frame.insetBy(dx: 5, dy: 1)
    if animated {
      UIView.animate(withDuration: 0.38, delay: 0, usingSpringWithDamping: 0.78, initialSpringVelocity: 0.2, options: [.beginFromCurrentState, .allowUserInteraction]) {
        self.tabPill.frame = f
      }
    } else {
      tabPill.frame = f
    }
  }

  private func layoutCategoryPill(animated: Bool) {
    guard selectedCategory >= 0, selectedCategory < categoryButtons.count else { return }
    let b = categoryButtons[selectedCategory]
    let side = min(b.bounds.width - 6, 34)
    let f = CGRect(x: b.frame.midX - side / 2, y: (categoryH - 32) / 2, width: side, height: 32)
    if animated {
      UIView.animate(withDuration: 0.36, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0.2, options: [.beginFromCurrentState, .allowUserInteraction]) {
        self.categoryPill.frame = f
      }
    } else {
      categoryPill.frame = f
    }
  }

  private func positionPages(animated: Bool) {
    let W = pagesHost.bounds.width
    let pages: [(EPTab, UIView)] = [(.emoji, emojiPage), (.stickers, stickerPage), (.gif, gifPage)]
    let apply = {
      for (t, p) in pages {
        let d = CGFloat(t.rawValue - self.tab.rawValue)
        p.transform = CGAffineTransform(translationX: d * min(W * 0.18, 60), y: 0)
        p.alpha = t == self.tab ? 1 : 0
        p.isUserInteractionEnabled = t == self.tab
      }
    }
    if animated {
      UIView.animate(withDuration: 0.34, delay: 0, usingSpringWithDamping: 0.86, initialSpringVelocity: 0.1, options: [.beginFromCurrentState, .allowUserInteraction], animations: apply)
    } else {
      apply()
    }
  }

  // MARK: Abas / modo compacto

  private func setTab(_ t: EPTab, emit: Bool, animated: Bool) {
    if !visibleTabs().contains(t.rawValue) { return }
    let changed = t != tab
    if changed {
      emojiSearch.field.resignFirstResponder()
      gifSearch.field.resignFirstResponder()
    }
    tab = t
    tintTabButtons()
    layoutTabPill(animated: animated)
    UIView.animate(withDuration: animated ? 0.2 : 0) {
      self.backspaceButton.alpha = t == .emoji ? 1 : 0
    }
    backspaceButton.isUserInteractionEnabled = t == .emoji
    positionPages(animated: animated)
    if t == .stickers { requestVisibleStickerSection() }
    if changed && emit { onTabChange(["tab": tabName(t)]) }
  }

  private func tabName(_ t: EPTab) -> String {
    switch t {
    case .emoji: return "emoji"
    case .stickers: return "stickers"
    case .gif: return "gif"
    }
  }

  private func applyCompact(animated: Bool) {
    compactCollection.reloadData()
    if animated {
      UIView.transition(with: self, duration: 0.22, options: [.transitionCrossDissolve, .allowAnimatedContent, .beginFromCurrentState]) {
        self.setNeedsLayout()
        self.layoutIfNeeded()
      }
    } else {
      setNeedsLayout()
    }
    if !compact {
      rebuildEmojiSections()
      emojiCollection.reloadData()
      gifCollection.reloadData()
      updateGifState()
    }
  }

  @objc private func tabTapped(_ b: UIButton) {
    guard let t = EPTab(rawValue: b.tag) else { return }
    if t == tab { return }
    selectionHaptic.selectionChanged()
    setTab(t, emit: true, animated: true)
  }

  @objc private func moreTapped() {
    onMore(["tab": tabName(tab)])
  }

  // MARK: Categorias

  @objc private func categoryTapped(_ b: UIButton) {
    if !emojiQuery.isEmpty { clearEmojiSearch() }
    let idx = b.tag
    let category = idx - 1 // -1 = recentes
    guard let section = emojiSections.firstIndex(where: { $0.category == category }) else {
      if idx == 0 {
        emojiCollection.setContentOffset(.zero, animated: true)
      }
      return
    }
    selectionHaptic.selectionChanged()
    selectedCategory = idx
    tintCategoryButtons()
    layoutCategoryPill(animated: true)
    emojiCollection.layoutIfNeeded()
    var y: CGFloat = 0
    if section > 0, let attr = emojiCollection.layoutAttributesForSupplementaryElement(ofKind: UICollectionView.elementKindSectionHeader, at: IndexPath(item: 0, section: section)) {
      y = attr.frame.minY
    }
    let maxY = max(0, emojiCollection.contentSize.height - emojiCollection.bounds.height + emojiCollection.adjustedContentInset.bottom)
    programmaticScroll = true
    emojiCollection.setContentOffset(CGPoint(x: 0, y: min(y, maxY)), animated: true)
  }

  private func syncCategoryFromScroll() {
    guard emojiQuery.isEmpty, !programmaticScroll else { return }
    let visible = emojiCollection.indexPathsForVisibleItems
    guard !visible.isEmpty else { return }
    let probeY = emojiCollection.contentOffset.y + 24
    var best: Int? = nil
    for ip in visible {
      guard let a = emojiCollection.layoutAttributesForItem(at: ip) else { continue }
      if a.frame.maxY >= probeY {
        if best == nil || ip.section < best! { best = ip.section }
      }
    }
    guard let s = best, s < emojiSections.count else { return }
    let idx = emojiSections[s].category + 1
    if idx != selectedCategory {
      selectedCategory = idx
      tintCategoryButtons()
      layoutCategoryPill(animated: true)
    }
  }

  // MARK: Figurinhas: barra de seções

  private func rebuildStickerBar() {
    for b in stickerTabButtons { b.removeFromSuperview() }
    stickerTabButtons = []
    for (i, s) in stickerSections.enumerated() {
      let b = UIButton(type: .custom)
      b.tag = i
      b.accessibilityLabel = s.title
      b.imageView?.contentMode = .scaleAspectFit
      b.adjustsImageWhenHighlighted = false
      switch s.icon {
      case "recent": b.setImage(EPGlyph.symbol(["clock"], size: 18)?.withRenderingMode(.alwaysTemplate), for: .normal)
      case "favorites": b.setImage(EPGlyph.symbol(["star"], size: 18)?.withRenderingMode(.alwaysTemplate), for: .normal)
      case "mine": b.setImage(EPGlyph.symbol(["paintpalette", "person.crop.square"], size: 18)?.withRenderingMode(.alwaysTemplate), for: .normal)
      default:
        if !s.cover.isEmpty {
          let uri = s.cover
          if let img = EPImageLoader.shared.cached(uri, maxPixel: 96) {
            b.setImage(img.withRenderingMode(.alwaysOriginal), for: .normal)
          } else {
            b.setImage(EPGlyph.sticker(size: 18), for: .normal)
            EPImageLoader.shared.load(uri, maxPixel: 96) { [weak b] img in
              guard let b = b, let img = img else { return }
              b.setImage((img.images?.first ?? img).withRenderingMode(.alwaysOriginal), for: .normal)
            }
          }
        } else {
          b.setImage(EPGlyph.sticker(size: 18), for: .normal)
        }
      }
      b.addTarget(self, action: #selector(stickerTabTapped(_:)), for: .touchUpInside)
      stickerBar.addSubview(b)
      stickerTabButtons.append(b)
    }
    tintStickerButtons()
    layoutStickerBar()
  }

  private func layoutStickerBar() {
    let side: CGFloat = 40
    var x: CGFloat = 6
    for b in stickerTabButtons {
      b.frame = CGRect(x: x, y: (stickerBarH - side) / 2, width: side, height: side)
      b.imageEdgeInsets = UIEdgeInsets(top: 7, left: 7, bottom: 7, right: 7)
      x += side + 4
    }
    stickerBar.contentSize = CGSize(width: x + 2, height: stickerBarH)
    layoutStickerPill(animated: false)
  }

  private func layoutStickerPill(animated: Bool) {
    guard selectedStickerSection < stickerTabButtons.count else { stickerPill.isHidden = true; return }
    stickerPill.isHidden = false
    let f = stickerTabButtons[selectedStickerSection].frame
    if animated {
      UIView.animate(withDuration: 0.34, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0.2, options: [.beginFromCurrentState, .allowUserInteraction]) {
        self.stickerPill.frame = f
      }
    } else {
      stickerPill.frame = f
    }
  }

  @objc private func stickerTabTapped(_ b: UIButton) {
    let i = b.tag
    guard i < stickerSections.count else { return }
    selectionHaptic.selectionChanged()
    selectStickerSection(i, animated: true)
    stickerCollection.layoutIfNeeded()
    var y: CGFloat = 0
    if i > 0, let attr = stickerCollection.layoutAttributesForSupplementaryElement(ofKind: UICollectionView.elementKindSectionHeader, at: IndexPath(item: 0, section: i)) {
      y = attr.frame.minY
    }
    let maxY = max(0, stickerCollection.contentSize.height - stickerCollection.bounds.height)
    programmaticScroll = true
    stickerCollection.setContentOffset(CGPoint(x: 0, y: min(y, maxY)), animated: true)
    let key = stickerSections[i].key
    if stickerSections[i].items.isEmpty || !requestedSections.contains(key) {
      requestedSections.insert(key)
      onSection(["key": key])
    }
  }

  private func selectStickerSection(_ i: Int, animated: Bool) {
    guard i != selectedStickerSection || stickerPill.frame.isEmpty else { return }
    selectedStickerSection = i
    tintStickerButtons()
    layoutStickerPill(animated: animated)
    if i < stickerTabButtons.count {
      let f = stickerTabButtons[i].frame.insetBy(dx: -24, dy: 0)
      stickerBar.scrollRectToVisible(f, animated: animated)
    }
  }

  private func requestVisibleStickerSection() {
    guard selectedStickerSection < stickerSections.count else { return }
    let s = stickerSections[selectedStickerSection]
    if s.items.isEmpty && !requestedSections.contains(s.key) {
      requestedSections.insert(s.key)
      onSection(["key": s.key])
    }
  }

  private func syncStickerSectionFromScroll() {
    guard !programmaticScroll else { return }
    let visible = stickerCollection.indexPathsForVisibleItems
    guard !visible.isEmpty else { return }
    let probeY = stickerCollection.contentOffset.y + 24
    var best: Int? = nil
    for ip in visible {
      guard let a = stickerCollection.layoutAttributesForItem(at: ip) else { continue }
      if a.frame.maxY >= probeY, best == nil || ip.section < best! { best = ip.section }
    }
    if let s = best, s != selectedStickerSection {
      selectStickerSection(s, animated: true)
      requestVisibleStickerSection()
    }
  }

  // MARK: GIF

  private func updateGifState() {
    let empty = gifs.isEmpty
    if gifLoading && empty { gifSpinner.startAnimating() } else { gifSpinner.stopAnimating() }
    gifEmpty.isHidden = compact || !(empty && !gifLoading && !gifQuery.isEmpty)
  }

  @objc private func gifQueryChanged() {
    let q = gifSearch.field.text ?? ""
    gifSearch.setClearVisible(!q.isEmpty)
    gifTimer?.invalidate()
    gifTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: false) { [weak self] _ in
      guard let self = self else { return }
      let trimmed = q.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed == self.gifQuery { return }
      self.gifQuery = trimmed
      self.onGifQuery(["query": trimmed])
      self.updateGifState()
    }
  }

  @objc private func clearGifSearch() {
    gifSearch.field.text = ""
    gifQueryChanged()
  }

  // MARK: Busca de emoji

  @objc private func emojiQueryChanged() {
    let q = (emojiSearch.field.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    emojiSearch.setClearVisible(!(emojiSearch.field.text ?? "").isEmpty)
    if q == emojiQuery { return }
    emojiQuery = q
    rebuildEmojiSections()
    categoryBar.alpha = q.isEmpty ? 1 : 0.35
    if compact {
      compactCollection.reloadData()
      compactCollection.setContentOffset(.zero, animated: false)
    } else {
      emojiCollection.reloadData()
      emojiCollection.setContentOffset(.zero, animated: false)
    }
  }

  @objc private func clearEmojiSearch() {
    emojiSearch.field.text = ""
    emojiQueryChanged()
  }

  func blurSearch() {
    emojiSearch.field.resignFirstResponder()
    gifSearch.field.resignFirstResponder()
  }

  func resetSearch() {
    blurSearch()
    if !(emojiSearch.field.text ?? "").isEmpty { clearEmojiSearch() }
    if !(gifSearch.field.text ?? "").isEmpty { clearGifSearch() }
  }

  // MARK: UITextFieldDelegate

  func textFieldDidBeginEditing(_ textField: UITextField) {
    onSearchFocus(["focused": true, "tab": tabName(tab)])
  }

  func textFieldDidEndEditing(_ textField: UITextField) {
    onSearchFocus(["focused": false, "tab": tabName(tab)])
  }

  func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    textField.resignFirstResponder()
    return true
  }

  // MARK: Backspace

  @objc private func backspaceTapped() {
    impactHaptic.impactOccurred(intensity: 0.5)
    onBackspace([:])
  }

  @objc private func backspaceLongPress(_ g: UILongPressGestureRecognizer) {
    switch g.state {
    case .began:
      onBackspace([:])
      backspaceTimer?.invalidate()
      backspaceTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
        self?.onBackspace([:])
      }
    case .ended, .cancelled, .failed:
      backspaceTimer?.invalidate()
      backspaceTimer = nil
    default:
      break
    }
  }

  // MARK: Tons de pele

  func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
    return false
  }

  @objc private func toneLongPress(_ g: UILongPressGestureRecognizer) {
    guard let c = g.view as? UICollectionView else { return }
    switch g.state {
    case .began:
      let p = g.location(in: c)
      guard let ip = c.indexPathForItem(at: p), let item = emojiItem(c, ip) else { return }
      guard let e = item.emoji, e.tone, let cell = c.cellForItem(at: ip), let win = window else {
        // sem tons: segurar = inserir (igual ao toque)
        if let cell = c.cellForItem(at: ip) as? EPEmojiCell { cell.pop() }
        insertEmoji(item.text)
        return
      }
      impactHaptic.impactOccurred()
      let opts = EPEmojiStore.shared.variants(e)
      let current = opts.firstIndex(of: EPEmojiStore.shared.display(e)) ?? 0
      let pop = EPTonePopover(options: opts, theme: theme, current: current)
      let cf = cell.convert(cell.bounds, to: win)
      var x = cf.midX - pop.bounds.width / 2
      x = max(8, min(win.bounds.width - pop.bounds.width - 8, x))
      let y = max(win.safeAreaInsets.top + 4, cf.minY - pop.bounds.height - 6)
      pop.frame.origin = CGPoint(x: x, y: y)
      pop.alpha = 0
      pop.transform = CGAffineTransform(scaleX: 0.6, y: 0.6).translatedBy(x: 0, y: 30)
      win.addSubview(pop)
      UIView.animate(withDuration: 0.32, delay: 0, usingSpringWithDamping: 0.72, initialSpringVelocity: 0.4, options: [.beginFromCurrentState]) {
        pop.alpha = 1
        pop.transform = .identity
      }
      tonePopover = pop
      toneTarget = (item, ip, c)
    case .changed:
      guard let pop = tonePopover else { return }
      let p = g.location(in: pop)
      let i = pop.index(at: p)
      if i != pop.selected {
        selectionHaptic.selectionChanged()
        pop.setSelected(i, animated: true)
      }
    case .ended:
      guard let pop = tonePopover, let target = toneTarget, let e = target.item.emoji else { dismissTone(); return }
      let i = pop.selected
      if i >= 0 && i < pop.options.count {
        let v = pop.options[i]
        EPEmojiStore.shared.setPreferred(v, for: e.base)
        insertEmoji(v)
        refreshEmojiItem(base: e.base)
      }
      dismissTone()
    case .cancelled, .failed:
      dismissTone()
    default:
      break
    }
  }

  private func dismissTone() {
    guard let pop = tonePopover else { return }
    tonePopover = nil
    toneTarget = nil
    UIView.animate(withDuration: 0.16, animations: {
      pop.alpha = 0
      pop.transform = CGAffineTransform(scaleX: 0.85, y: 0.85)
    }, completion: { _ in pop.removeFromSuperview() })
  }

  private func refreshEmojiItem(base: String) {
    let store = EPEmojiStore.shared
    var changed: [IndexPath] = []
    for (s, sec) in emojiSections.enumerated() where sec.category >= 0 || sec.category == -2 {
      for (i, it) in sec.items.enumerated() where it.emoji?.base == base {
        if let e = it.emoji {
          emojiSections[s].items[i] = EPEmojiItem(text: store.display(e), emoji: e)
          changed.append(IndexPath(item: i, section: s))
        }
      }
    }
    if !changed.isEmpty && !compact {
      UIView.performWithoutAnimation { emojiCollection.reloadItems(at: changed) }
    }
    if compact { compactCollection.reloadData() }
  }

  private func insertEmoji(_ s: String) {
    EPEmojiStore.shared.pushRecent(s)
    onEmoji(["emoji": s])
  }

  // MARK: Data source helpers

  private func emojiItem(_ c: UICollectionView, _ ip: IndexPath) -> EPEmojiItem? {
    if c === emojiCollection {
      guard ip.section < emojiSections.count, ip.item < emojiSections[ip.section].items.count else { return nil }
      return emojiSections[ip.section].items[ip.item]
    }
    if c === compactCollection && tab == .emoji {
      let items = compactEmojiItems()
      return ip.item < items.count ? items[ip.item] : nil
    }
    return nil
  }

  private func stickerItems(_ s: Int) -> [(key: String, uri: String)] {
    guard s < stickerSections.count else { return [] }
    return stickerSections[s].items
  }

  // MARK: UICollectionViewDataSource

  func numberOfSections(in c: UICollectionView) -> Int {
    if c === emojiCollection { return emojiSections.count }
    if c === stickerCollection { return stickerSections.count }
    return 1
  }

  func collectionView(_ c: UICollectionView, numberOfItemsInSection section: Int) -> Int {
    if c === emojiCollection { return section < emojiSections.count ? emojiSections[section].items.count : 0 }
    if c === stickerCollection {
      guard section < stickerSections.count else { return 0 }
      let s = stickerSections[section]
      return s.items.isEmpty && s.loading ? 1 : s.items.count
    }
    if c === gifCollection { return gifs.count }
    // compacto
    if tab == .gif { return gifs.count }
    if tab == .emoji { return compactEmojiItems().count }
    return 0
  }

  func collectionView(_ c: UICollectionView, cellForItemAt ip: IndexPath) -> UICollectionViewCell {
    if c === stickerCollection {
      let cell = c.dequeueReusableCell(withReuseIdentifier: EPImageCell.reuse, for: ip) as! EPImageCell
      let items = stickerItems(ip.section)
      let uri = ip.item < items.count ? items[ip.item].uri : ""
      cell.configure(uri: uri, fill: false, placeholder: .clear, corner: 0, maxPixel: 256)
      cell.accessibilityLabel = labels["stickers"]
      return cell
    }
    if c === gifCollection || (c === compactCollection && tab == .gif) {
      let cell = c.dequeueReusableCell(withReuseIdentifier: EPImageCell.reuse, for: ip) as! EPImageCell
      let uri = ip.item < gifs.count ? gifs[ip.item].uri : ""
      cell.configure(uri: uri, fill: true, placeholder: theme.surface, corner: 6, maxPixel: 300)
      cell.accessibilityLabel = "GIF"
      return cell
    }
    let cell = c.dequeueReusableCell(withReuseIdentifier: EPEmojiCell.reuse, for: ip) as! EPEmojiCell
    let item = emojiItem(c, ip)
    cell.label.text = item?.text ?? ""
    cell.accessibilityLabel = item?.emoji?.name ?? item?.text
    return cell
  }

  func collectionView(_ c: UICollectionView, viewForSupplementaryElementOfKind kind: String, at ip: IndexPath) -> UICollectionReusableView {
    let v = c.dequeueReusableSupplementaryView(ofKind: kind, withReuseIdentifier: EPHeaderView.reuse, for: ip) as! EPHeaderView
    v.label.textColor = theme.secondary
    if c === emojiCollection, ip.section < emojiSections.count {
      v.label.text = emojiSections[ip.section].title
    } else if c === stickerCollection, ip.section < stickerSections.count {
      v.label.text = stickerSections[ip.section].title
    } else {
      v.label.text = ""
    }
    return v
  }

  // MARK: UICollectionViewDelegateFlowLayout

  private func emojiCellSide(_ c: UICollectionView) -> CGFloat {
    let w = c.bounds.width - 12
    let cols = max(6, floor(w / 44))
    return floor(w / cols)
  }

  func collectionView(_ c: UICollectionView, layout: UICollectionViewLayout, sizeForItemAt ip: IndexPath) -> CGSize {
    if c === emojiCollection {
      let s = emojiCellSide(c)
      return CGSize(width: s, height: s)
    }
    if c === stickerCollection {
      let w = c.bounds.width - 12
      let cols: CGFloat = w > 500 ? 5 : 4
      let s = floor(w / cols)
      return CGSize(width: s, height: s)
    }
    if c === gifCollection {
      let w = c.bounds.width - 12
      let s = floor((w - 6) / 3)
      return CGSize(width: s, height: s)
    }
    // compacto
    let h = max(10, c.bounds.height)
    if tab == .gif {
      guard ip.item < gifs.count else { return CGSize(width: h, height: h) }
      let g = gifs[ip.item]
      let ar = g.h > 0 ? g.w / g.h : 1
      return CGSize(width: max(64, min(180, h * ar)), height: h)
    }
    return CGSize(width: 44, height: min(h, 48))
  }

  func collectionView(_ c: UICollectionView, layout: UICollectionViewLayout, insetForSectionAt section: Int) -> UIEdgeInsets {
    if c === compactCollection { return UIEdgeInsets(top: 0, left: 8, bottom: 0, right: 8) }
    if c === gifCollection { return UIEdgeInsets(top: 0, left: 6, bottom: 12, right: 6) }
    let last = section == numberOfSections(in: c) - 1
    return UIEdgeInsets(top: 0, left: 6, bottom: last ? 16 : 6, right: 6)
  }

  func collectionView(_ c: UICollectionView, layout: UICollectionViewLayout, minimumLineSpacingForSectionAt section: Int) -> CGFloat {
    if c === gifCollection { return 3 }
    if c === compactCollection { return tab == .gif ? 4 : 0 }
    return 0
  }

  func collectionView(_ c: UICollectionView, layout: UICollectionViewLayout, minimumInteritemSpacingForSectionAt section: Int) -> CGFloat {
    if c === gifCollection { return 3 }
    return 0
  }

  func collectionView(_ c: UICollectionView, layout: UICollectionViewLayout, referenceSizeForHeaderInSection section: Int) -> CGSize {
    if c === emojiCollection {
      guard section < emojiSections.count, !emojiSections[section].title.isEmpty else { return .zero }
      return CGSize(width: c.bounds.width, height: 28)
    }
    if c === stickerCollection {
      guard section < stickerSections.count, !stickerSections[section].title.isEmpty else { return CGSize(width: c.bounds.width, height: 6) }
      return CGSize(width: c.bounds.width, height: 30)
    }
    return .zero
  }

  func collectionView(_ c: UICollectionView, didSelectItemAt ip: IndexPath) {
    if c === emojiCollection || (c === compactCollection && tab == .emoji) {
      guard let item = emojiItem(c, ip) else { return }
      (c.cellForItem(at: ip) as? EPEmojiCell)?.pop()
      insertEmoji(item.text)
      return
    }
    if c === stickerCollection {
      let items = stickerItems(ip.section)
      guard ip.item < items.count, ip.section < stickerSections.count else { return }
      impactHaptic.impactOccurred(intensity: 0.6)
      onSticker(["key": items[ip.item].key, "uri": items[ip.item].uri, "section": stickerSections[ip.section].key])
      return
    }
    if c === gifCollection || (c === compactCollection && tab == .gif) {
      guard ip.item < gifs.count else { return }
      impactHaptic.impactOccurred(intensity: 0.6)
      onGif(["key": gifs[ip.item].key])
    }
  }

  // MARK: UIScrollViewDelegate

  func scrollViewDidScroll(_ s: UIScrollView) {
    if s === emojiCollection { syncCategoryFromScroll() }
    else if s === stickerCollection { syncStickerSectionFromScroll() }
  }

  func scrollViewWillBeginDragging(_ s: UIScrollView) {
    programmaticScroll = false
  }

  func scrollViewDidEndScrollingAnimation(_ s: UIScrollView) {
    programmaticScroll = false
  }
}
