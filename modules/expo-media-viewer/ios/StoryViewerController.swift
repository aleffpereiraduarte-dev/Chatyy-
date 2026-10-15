import UIKit
import AVFoundation

// [2026-10-15 native-story] Visualizador de STATUS nativo (nível Instagram/
// WhatsApp/Telegram). Estrutura:
//   view ─ backdrop (preto; some no arrasto p/ baixo)
//        └ stage (transform do arrasto de fechar)
//            └ pager UIScrollView paginado — uma SVGroupView por PESSOA,
//              criadas sob demanda (atual ± 1), transição em CUBO 3D
//              (CATransform3D por página a cada scrollViewDidScroll) ou slide.
//        ├ composer (responder/reagir — UITextField + reações vetoriais)
//        ├ sheet "Visualizações" (próprio)
//        └ toast
// Relógio único: CADisplayLink → tick(dt) só na página ativa e só quando não
// há nenhum motivo de pausa (segurar, arrasto, teclado, folha, menu, app em
// segundo plano, JS, carregando mais pessoas…).

private final class SVWeakProxy: NSObject {
  weak var target: StoryViewerController?
  init(_ t: StoryViewerController) { target = t }
  @objc func step(_ link: CADisplayLink) { target?.step(link) }
}

final class SVViewerCell: UITableViewCell {
  static let reuseId = "SVViewerCell"
  let avatar = UIImageView()
  let initial = UILabel()
  let name = UILabel()
  let time = UILabel()
  let reaction = UIImageView()
  var avatarUri = ""

  override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
    super.init(style: style, reuseIdentifier: reuseIdentifier)
    backgroundColor = .clear
    selectionStyle = .none
    avatar.contentMode = .scaleAspectFill
    avatar.clipsToBounds = true
    avatar.backgroundColor = UIColor(white: 0.3, alpha: 1)
    contentView.addSubview(avatar)
    initial.textColor = .white
    initial.font = .systemFont(ofSize: 16, weight: .bold)
    initial.textAlignment = .center
    avatar.addSubview(initial)
    name.textColor = .white
    name.font = .systemFont(ofSize: 15, weight: .semibold)
    contentView.addSubview(name)
    time.textColor = UIColor(white: 1, alpha: 0.55)
    time.font = .systemFont(ofSize: 12)
    contentView.addSubview(time)
    reaction.contentMode = .center
    contentView.addSubview(reaction)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  override func layoutSubviews() {
    super.layoutSubviews()
    let h = contentView.bounds.height
    let w = contentView.bounds.width
    avatar.frame = CGRect(x: 16, y: (h - 42) / 2, width: 42, height: 42)
    avatar.layer.cornerRadius = 21
    initial.frame = avatar.bounds
    reaction.frame = CGRect(x: w - 16 - 30, y: (h - 30) / 2, width: 30, height: 30)
    let x = avatar.frame.maxX + 12
    let tw = reaction.image == nil ? w - x - 16 : reaction.frame.minX - x - 8
    name.frame = CGRect(x: x, y: h / 2 - 19, width: tw, height: 20)
    time.frame = CGRect(x: x, y: h / 2 + 2, width: tw, height: 17)
  }
}

final class StoryViewerController: UIViewController, UIScrollViewDelegate, UIGestureRecognizerDelegate, SVGroupViewDelegate, UITextFieldDelegate, UITableViewDataSource, UITableViewDelegate {

  // Saída p/ o módulo (nome do evento, corpo). O módulo acrescenta `session`.
  var emit: ((String, [String: Any?]) -> Void)?
  var onFinished: (() -> Void)?

  private var groups: [SVGroup]
  private let labels: SVLabels
  private let reactions: [SVReaction]
  private let cube: Bool
  private(set) var hasMoreNext: Bool
  private(set) var hasMorePrev: Bool

  private let backdrop = UIView()
  private let stage = UIView()
  private let pager = UIScrollView()
  private var pages: [Int: SVGroupView] = [:]
  private var currentGroup: Int
  private var lastWidth: CGFloat = 0
  private var programmaticScroll = false

  private var link: CADisplayLink?
  private var lastTs: CFTimeInterval = 0
  private var pauseReasons = Set<String>()
  private var closed = false
  private var muted = false
  private var shownIds = Set<String>()

  // Pré-buffer de vídeo (próximo item / próxima pessoa).
  private var preloaded: [String: AVPlayer] = [:]
  private var preloadOrder: [String] = []

  // Pedido de mais pessoas ao JS (onNeedMore).
  private var pendingMore: String?
  private var pendingMoreCloses = false
  private var pendingMoreWork: DispatchWorkItem?

  // Gestos
  private let tap = UITapGestureRecognizer()
  private let hold = UILongPressGestureRecognizer()
  private let vpan = UIPanGestureRecognizer()
  private var vpanUp = false

  // Composer (responder / reagir)
  private let composer = UIView()
  private let composerDim = UIView()
  private let reactionsRow = UIStackView()
  private let inputBar = UIView()
  private let fieldBox = UIView()
  private let field = UITextField()
  private let sendButton = UIButton(type: .system)
  private var keyboardTop: CGFloat = 0
  private var composerOpen = false
  /// [v2] Composer respondendo a uma figurinha de PERGUNTA (nil = resposta DM).
  private var composerQuestion: SVOverlay?

  // [v2] Duplo toque = curtir (zona central; a borda direita continua imediata).
  private var pendingTap: DispatchWorkItem?
  private var lastTapAt: CFTimeInterval = 0

  // Folha "Visualizações"
  private let sheet = UIView()
  private let sheetDim = UIView()
  private let sheetPanel = UIView()
  private let sheetHandle = UIView()
  private let sheetTitle = UILabel()
  private let sheetClose = UIButton(type: .system)
  private let sheetTable = UITableView(frame: .zero, style: .plain)
  private let sheetSpinner = UIActivityIndicatorView(style: .medium)
  private let sheetEmpty = UILabel()
  private var sheetOpen = false
  private var sheetItemId = ""
  private var sheetRows: [[String: Any]] = []
  private var viewersCache: [String: [[String: Any]]] = [:]
  private let sheetPan = UIPanGestureRecognizer()

  private let toast = UILabel()
  private var toastWork: DispatchWorkItem?

  private let haptic = UIImpactFeedbackGenerator(style: .light)
  private let selection = UISelectionFeedbackGenerator()

  private var observers: [NSObjectProtocol] = []

  init(groups: [SVGroup], startGroup: Int, labels: SVLabels, reactions: [SVReaction], cube: Bool, hasMoreNext: Bool, hasMorePrev: Bool) {
    self.groups = groups
    self.currentGroup = max(0, min(groups.count - 1, startGroup))
    self.labels = labels
    self.reactions = reactions
    self.cube = cube
    self.hasMoreNext = hasMoreNext
    self.hasMorePrev = hasMorePrev
    super.init(nibName: nil, bundle: nil)
    modalPresentationStyle = .overFullScreen
    modalTransitionStyle = .crossDissolve
    modalPresentationCapturesStatusBarAppearance = true
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  override var prefersStatusBarHidden: Bool { return true }
  override var preferredStatusBarStyle: UIStatusBarStyle { return .lightContent }
  override var prefersHomeIndicatorAutoHidden: Bool { return true }
  override var supportedInterfaceOrientations: UIInterfaceOrientationMask { return .portrait }

  deinit {
    for o in observers { NotificationCenter.default.removeObserver(o) }
    link?.invalidate()
  }

  // MARK: - Lifecycle

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear

    backdrop.backgroundColor = .black
    backdrop.frame = view.bounds
    backdrop.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(backdrop)

    stage.frame = view.bounds
    stage.backgroundColor = .black
    stage.clipsToBounds = true
    view.addSubview(stage)

    pager.isPagingEnabled = true
    pager.showsHorizontalScrollIndicator = false
    pager.showsVerticalScrollIndicator = false
    pager.alwaysBounceVertical = false
    pager.alwaysBounceHorizontal = true
    pager.bounces = true
    pager.delaysContentTouches = false
    pager.contentInsetAdjustmentBehavior = .never
    pager.scrollsToTop = false
    pager.backgroundColor = .black
    pager.delegate = self
    stage.addSubview(pager)

    hold.minimumPressDuration = 0.2
    hold.allowableMovement = 12
    hold.addTarget(self, action: #selector(handleHold(_:)))
    hold.delegate = self
    pager.addGestureRecognizer(hold)

    tap.addTarget(self, action: #selector(handleTap(_:)))
    tap.delegate = self
    tap.require(toFail: hold)
    pager.addGestureRecognizer(tap)

    vpan.maximumNumberOfTouches = 1
    vpan.addTarget(self, action: #selector(handleVerticalPan(_:)))
    vpan.delegate = self
    pager.addGestureRecognizer(vpan)
    pager.panGestureRecognizer.require(toFail: vpan)

    buildComposer()
    buildSheet()

    toast.textColor = .white
    toast.font = .systemFont(ofSize: 14, weight: .semibold)
    toast.textAlignment = .center
    toast.backgroundColor = UIColor(white: 0.12, alpha: 0.92)
    toast.layer.cornerRadius = 18
    toast.clipsToBounds = true
    toast.alpha = 0
    view.addSubview(toast)

    let nc = NotificationCenter.default
    observers.append(nc.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
      self?.addPause("background")
    })
    observers.append(nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      self?.removePause("background")
    })
    observers.append(nc.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { [weak self] n in
      self?.keyboardChanged(n)
    })
    observers.append(nc.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] n in
      self?.keyboardChanged(n, hiding: true)
    })

    haptic.prepare()
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    if link == nil {
      stage.transform = CGAffineTransform(scaleX: 0.94, y: 0.94)
      UIView.animate(withDuration: 0.32, delay: 0, usingSpringWithDamping: 0.86, initialSpringVelocity: 0.4, options: [.allowUserInteraction], animations: {
        self.stage.transform = .identity
      })
    }
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    if link == nil && !closed {
      let l = CADisplayLink(target: SVWeakProxy(self), selector: #selector(SVWeakProxy.step(_:)))
      l.add(to: .main, forMode: .common)
      link = l
    }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    if stage.transform.isIdentity { stage.frame = view.bounds }
    let w = view.bounds.width
    let h = view.bounds.height
    if pager.frame.size != CGSize(width: w, height: h) || lastWidth != w {
      programmaticScroll = true
      pager.frame = CGRect(x: 0, y: 0, width: w, height: h)
      pager.contentSize = CGSize(width: w * CGFloat(groups.count), height: h)
      pager.contentOffset = CGPoint(x: CGFloat(currentGroup) * w, y: 0)
      programmaticScroll = false
      let first = lastWidth == 0
      lastWidth = w
      ensurePages()
      for (i, p) in pages { place(p, i) }
      applyCube()
      if first { currentPage?.activate() }
    }
    for p in pages.values { p.chromeInsets = view.safeAreaInsets }
    layoutComposer()
    layoutSheet(animated: false)
    let tw = min(w - 48, ceil(toast.sizeThatFits(CGSize(width: w - 80, height: 40)).width) + 36)
    toast.frame = CGRect(x: (w - tw) / 2, y: h * 0.42, width: tw, height: 36)
  }

  // MARK: - Pager

  private var currentPage: SVGroupView? { return pages[currentGroup] }

  private func place(_ p: SVGroupView, _ i: Int) {
    let w = pager.bounds.width
    let h = pager.bounds.height
    p.bounds = CGRect(x: 0, y: 0, width: w, height: h)
    p.center = CGPoint(x: CGFloat(i) * w + w / 2, y: h / 2)
    p.chromeInsets = view.safeAreaInsets
  }

  private func makePage(_ i: Int) -> SVGroupView {
    let p = SVGroupView(group: groups[i], labels: labels)
    p.delegate = self
    p.setMuted(muted)
    pager.addSubview(p)
    place(p, i)
    return p
  }

  private func ensurePages() {
    let w = pager.bounds.width
    guard w > 0, !groups.isEmpty else { return }
    let pos = pager.contentOffset.x / w
    var want = Set<Int>()
    for i in [Int(floor(pos)), Int(ceil(pos)), currentGroup - 1, currentGroup, currentGroup + 1] where i >= 0 && i < groups.count {
      want.insert(i)
    }
    for (i, p) in pages where !want.contains(i) {
      p.deactivate()
      p.removeFromSuperview()
      pages.removeValue(forKey: i)
    }
    for i in want where pages[i] == nil {
      pages[i] = makePage(i)
    }
  }

  private func applyCube() {
    let w = pager.bounds.width
    guard w > 0 else { return }
    let off = pager.contentOffset.x / w
    for (i, p) in pages {
      let x = max(-1, min(1, CGFloat(i) - off))
      if cube && x != 0 {
        let edge: CGFloat = x < 0 ? w / 2 : -w / 2
        var m = CATransform3DMakeTranslation(-edge, 0, 0)
        m = CATransform3DConcat(m, CATransform3DMakeRotation(x * .pi / 2, 0, 1, 0))
        m = CATransform3DConcat(m, CATransform3DMakeTranslation(edge, 0, 0))
        var persp = CATransform3DIdentity
        persp.m34 = -1 / (w * 2.2)
        m = CATransform3DConcat(m, persp)
        p.layer.transform = m
      } else {
        p.layer.transform = CATransform3DIdentity
      }
      p.shade.alpha = abs(x) * 0.45
    }
  }

  // (a tabela da folha "Visualizações" também chama estes métodos — só o pager conta)
  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    guard scrollView === pager, !programmaticScroll else { return }
    ensurePages()
    applyCube()
  }

  func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
    guard scrollView === pager else { return }
    addPause("drag")
  }

  func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint, targetContentOffset: UnsafeMutablePointer<CGPoint>) {
    guard scrollView === pager else { return }
    let w = scrollView.bounds.width
    guard w > 0 else { return }
    let tx = scrollView.panGestureRecognizer.translation(in: scrollView).x
    let last = groups.count - 1
    if currentGroup == last && hasMoreNext && (tx < -w * 0.18 || velocity.x > 1.2) {
      requestMore("next", closeOnFail: false)
    } else if currentGroup == 0 && hasMorePrev && (tx > w * 0.18 || velocity.x < -1.2) {
      requestMore("prev", closeOnFail: false)
    }
  }

  func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    guard scrollView === pager else { return }
    if !decelerate { settle() }
  }

  func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
    guard scrollView === pager else { return }
    settle()
  }

  func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
    guard scrollView === pager else { return }
    removePause("anim")
    settle()
  }

  private func settle() {
    // "anim" também: um arrasto no meio do setContentOffset animado não chama
    // scrollViewDidEndScrollingAnimation.
    pauseReasons.remove("anim")
    removePause("drag")
    let w = pager.bounds.width
    guard w > 0, !closed else { return }
    let i = max(0, min(groups.count - 1, Int(round(pager.contentOffset.x / w))))
    if i != currentGroup {
      currentPage?.deactivate()
      currentGroup = i
      ensurePages()
      applyCube()
      selection.selectionChanged()
      currentPage?.setChromeHidden(false, animated: false)
      currentPage?.activate()
      applyPauseState()
      let g = groups[i]
      emit?("onGroupChange", ["groupIndex": i, "ownerEmail": g.ownerEmail, "key": g.key])
      prefetchGroup(i + 1)
      prefetchGroup(i - 1)
    } else {
      applyPauseState()
    }
  }

  private func goToGroup(_ i: Int) {
    guard i >= 0, i < groups.count, i != currentGroup else { return }
    let w = pager.bounds.width
    guard w > 0 else { return }
    addPause("anim")
    // Garante a página de destino antes da animação (cubo com conteúdo).
    if pages[i] == nil { pages[i] = makePage(i) }
    pager.setContentOffset(CGPoint(x: CGFloat(i) * w, y: 0), animated: true)
  }

  private func prefetchGroup(_ i: Int) {
    guard i >= 0, i < groups.count else { return }
    let g = groups[i]
    guard g.index >= 0, g.index < g.items.count else { return }
    prefetch(g.items[g.index])
    if !g.avatar.isEmpty { MVImageLoader.shared.prefetch(g.avatar, maxPixel: 160) }
  }

  // MARK: - Navegação

  private func goNext() {
    guard !closed, let gv = currentPage else { return }
    if gv.index < gv.group.items.count - 1 {
      gv.showItem(gv.index + 1, autoplay: true)
      applyPauseState()
      return
    }
    if currentGroup < groups.count - 1 {
      goToGroup(currentGroup + 1)
      return
    }
    if hasMoreNext {
      requestMore("next", closeOnFail: true)
      return
    }
    finish(reason: "end", animated: true)
  }

  private func goPrev() {
    guard !closed, let gv = currentPage else { return }
    if gv.index > 0 {
      gv.showItem(gv.index - 1, autoplay: true)
      applyPauseState()
      return
    }
    if currentGroup > 0 {
      goToGroup(currentGroup - 1)
      return
    }
    if hasMorePrev {
      requestMore("prev", closeOnFail: false)
      return
    }
    gv.showItem(0, autoplay: true)
    applyPauseState()
  }

  private func requestMore(_ dir: String, closeOnFail: Bool) {
    if pendingMore != nil { return }
    pendingMore = dir
    pendingMoreCloses = closeOnFail
    addPause("more")
    emit?("onNeedMore", ["direction": dir, "groupIndex": currentGroup, "ownerEmail": groups[currentGroup].ownerEmail])
    let work = DispatchWorkItem { [weak self] in self?.resolveMore(appended: false) }
    pendingMoreWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5, execute: work)
  }

  private func resolveMore(appended: Bool) {
    guard pendingMore != nil else { return }
    let closes = pendingMoreCloses
    pendingMore = nil
    pendingMoreWork?.cancel()
    pendingMoreWork = nil
    removePause("more")
    if !appended && closes { finish(reason: "end", animated: true) }
  }

  // MARK: - Pausa

  private func addPause(_ r: String) {
    pauseReasons.insert(r)
    applyPauseState()
  }

  private func removePause(_ r: String) {
    pauseReasons.remove(r)
    applyPauseState()
  }

  private func applyPauseState() {
    currentPage?.setPaused(!pauseReasons.isEmpty)
  }

  func step(_ l: CADisplayLink) {
    let now = l.timestamp
    let dt = lastTs == 0 ? 0 : min(0.1, now - lastTs)
    lastTs = now
    guard !closed, pauseReasons.isEmpty else { return }
    currentPage?.tick(dt)
  }

  // MARK: - Gestos

  func gestureRecognizer(_ g: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    if g === sheetPan { return sheetOpen }
    if composerOpen || sheetOpen { return false }
    if let page = currentPage, page.isControl(touch.view) { return false }
    return true
  }

  func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
    if g === sheetPan {
      let v = sheetPan.velocity(in: view)
      let inHeader = sheetPan.location(in: sheetPanel).y < 58
      return v.y > 0 && abs(v.y) > abs(v.x) && (inHeader || sheetTable.contentOffset.y <= 0)
    }
    if g === vpan {
      if pager.isDragging || pager.isDecelerating { return false }
      let v = vpan.velocity(in: view)
      return abs(v.y) > abs(v.x) * 1.15
    }
    return true
  }

  func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
    // Segurar + arrastar p/ o lado ainda gira o cubo (Instagram).
    if g === hold && other === pager.panGestureRecognizer { return true }
    if other === hold && g === pager.panGestureRecognizer { return true }
    // Segurar e arrastar p/ baixo ainda fecha.
    if (g === hold && other === vpan) || (g === vpan && other === hold) { return true }
    return false
  }

  @objc private func handleTap(_ g: UITapGestureRecognizer) {
    guard !closed, pendingMore == nil else { return }
    let loc = g.location(in: view)
    let w = view.bounds.width
    if loc.x < w * 0.3 {
      pendingTap?.cancel(); pendingTap = nil
      goPrev()
      return
    }
    // Duplo toque no centro = curtir (status dos outros), como no viewer JS.
    let canLike = currentGroup < groups.count && !groups[currentGroup].isSelf
    if !canLike || loc.x > w * 0.72 {
      pendingTap?.cancel(); pendingTap = nil
      goNext()
      return
    }
    let now = CACurrentMediaTime()
    if let p = pendingTap, now - lastTapAt < 0.28 {
      p.cancel()
      pendingTap = nil
      lastTapAt = 0
      doubleTapLike(at: loc)
      return
    }
    lastTapAt = now
    let work = DispatchWorkItem { [weak self] in
      guard let self = self else { return }
      self.pendingTap = nil
      if !self.closed && self.pendingMore == nil { self.goNext() }
    }
    pendingTap = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.26, execute: work)
  }

  private func doubleTapLike(at point: CGPoint) {
    guard let gv = currentPage, let item = gv.currentItem, !gv.group.isSelf else { return }
    let heart = reactions.first(where: { $0.kind == "heart" })?.emoji ?? "\u{2764}\u{FE0F}"
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    burst("heart", at: point)
    // Já curtido: só a animação (duplo toque nunca descurte).
    guard item.myReaction != heart else { return }
    item.myReaction = heart
    gv.refreshCounters()
    emit?("onReact", ["id": item.id, "ownerEmail": gv.group.ownerEmail, "emoji": heart, "active": true])
  }

  @objc private func handleHold(_ g: UILongPressGestureRecognizer) {
    switch g.state {
    case .began:
      haptic.impactOccurred()
      addPause("hold")
      currentPage?.setChromeHidden(true, animated: true)
    case .ended, .cancelled, .failed:
      if pauseReasons.contains("hold") {
        removePause("hold")
        currentPage?.setChromeHidden(false, animated: true)
      }
    default:
      break
    }
  }

  @objc private func handleVerticalPan(_ g: UIPanGestureRecognizer) {
    let t = g.translation(in: view)
    let h = max(1, view.bounds.height)
    switch g.state {
    case .began:
      addPause("dismiss")
      vpanUp = false
    case .changed:
      if t.y >= 0 {
        let p = min(1, t.y / h)
        let s = 1 - p * 0.18
        stage.transform = CGAffineTransform(translationX: t.x * 0.35, y: t.y).scaledBy(x: s, y: s)
        stage.layer.cornerRadius = min(24, t.y / 6)
        backdrop.alpha = 1 - p * 1.3
        vpanUp = false
      } else {
        stage.transform = CGAffineTransform(translationX: 0, y: t.y * 0.25)
        vpanUp = true
      }
    case .ended, .cancelled:
      let v = g.velocity(in: view)
      if g.state == .ended && t.y > 0 && (t.y > 130 || v.y > 900) {
        dismissBySwipe(velocity: v.y)
        return
      }
      let openUp = g.state == .ended && vpanUp && (t.y < -60 || v.y < -650)
      UIView.animate(withDuration: 0.32, delay: 0, usingSpringWithDamping: 0.85, initialSpringVelocity: 0.3, options: [.allowUserInteraction], animations: {
        self.stage.transform = .identity
        self.stage.layer.cornerRadius = 0
        self.backdrop.alpha = 1
      })
      removePause("dismiss")
      if openUp {
        if groups[currentGroup].isSelf { openViewers() } else { openComposer() }
      }
    default:
      break
    }
  }

  private func dismissBySwipe(velocity: CGFloat) {
    let h = view.bounds.height
    let dur = max(0.16, min(0.3, TimeInterval((h - stage.frame.minY) / max(900, velocity))))
    UIView.animate(withDuration: dur, delay: 0, options: [.curveEaseOut], animations: {
      self.stage.transform = self.stage.transform.translatedBy(x: 0, y: h * 0.6)
      self.stage.alpha = 0
      self.backdrop.alpha = 0
    }, completion: { _ in
      self.finish(reason: "swipe", animated: false)
    })
  }

  // MARK: - SVGroupViewDelegate

  func groupViewItemReady(_ gv: SVGroupView, item: SVItem) {
    guard gv === currentPage, !closed else { return }
    item.viewed = true
    if shownIds.insert(item.id).inserted {
      emit?("onItemShown", [
        "id": item.id,
        "ownerEmail": gv.group.ownerEmail,
        "groupIndex": currentGroup,
        "itemIndex": gv.index,
        "isSelf": gv.group.isSelf,
      ])
    }
  }

  func groupViewItemFinished(_ gv: SVGroupView, item: SVItem) {
    guard gv === currentPage, !closed, pauseReasons.isEmpty else { return }
    emit?("onItemCompleted", ["id": item.id, "ownerEmail": gv.group.ownerEmail])
    goNext()
  }

  func groupViewTapClose(_ gv: SVGroupView) {
    finish(reason: "close", animated: true)
  }

  func groupViewTapMenu(_ gv: SVGroupView, sender: UIView) {
    guard let item = gv.currentItem else { return }
    let entries = gv.group.menu.filter { $0.visible(for: item) }
    guard !entries.isEmpty else { return }
    addPause("menu")
    let ac = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
    let owner = gv.group.ownerEmail
    for entry in entries {
      ac.addAction(UIAlertAction(title: entry.title(for: item), style: entry.destructive ? .destructive : .default) { [weak self] _ in
        guard let self = self else { return }
        if !entry.confirm.isEmpty {
          let c = UIAlertController(title: entry.confirm, message: nil, preferredStyle: .alert)
          c.addAction(UIAlertAction(title: self.labels.get("cancel", "Cancelar"), style: .cancel) { [weak self] _ in
            self?.removePause("menu")
          })
          c.addAction(UIAlertAction(title: entry.label, style: entry.destructive ? .destructive : .default) { [weak self] _ in
            self?.removePause("menu")
            self?.emit?("onMenu", ["id": item.id, "action": entry.id, "ownerEmail": owner])
          })
          self.present(c, animated: true)
        } else {
          self.removePause("menu")
          self.emit?("onMenu", ["id": item.id, "action": entry.id, "ownerEmail": owner])
        }
      })
    }
    ac.addAction(UIAlertAction(title: labels.get("cancel", "Cancelar"), style: .cancel) { [weak self] _ in
      self?.removePause("menu")
    })
    if let pop = ac.popoverPresentationController {
      pop.sourceView = sender
      pop.sourceRect = sender.bounds
    }
    present(ac, animated: true)
  }

  func groupViewTapReply(_ gv: SVGroupView) {
    openComposer()
  }

  func groupViewSticker(_ gv: SVGroupView, overlay: SVOverlay, info: [String: Any]) {
    guard gv === currentPage, !closed, let item = gv.currentItem else { return }
    let kind = (info["kind"] as? String) ?? overlay.kind
    if kind == "question" {
      openComposer(question: overlay)
      return
    }
    var body: [String: Any?] = ["id": item.id, "ownerEmail": gv.group.ownerEmail, "kind": kind, "stickerId": overlay.id]
    for (k, v) in info where k != "kind" { body[k] = v }
    emit?("onSticker", body)
  }

  func groupViewTapLike(_ gv: SVGroupView) {
    guard let item = gv.currentItem else { return }
    let heart = reactions.first(where: { $0.kind == "heart" })?.emoji ?? "\u{2764}\u{FE0F}"
    haptic.impactOccurred()
    if item.myReaction == heart {
      item.myReaction = ""
    } else {
      item.myReaction = heart
      burst("heart")
    }
    gv.refreshCounters()
    emit?("onReact", ["id": item.id, "ownerEmail": gv.group.ownerEmail, "emoji": heart, "active": !item.myReaction.isEmpty])
  }

  func groupViewTapViewers(_ gv: SVGroupView) {
    openViewers()
  }

  func groupViewTapLink(_ gv: SVGroupView, url: String) {
    emit?("onLink", ["url": url, "id": gv.currentItem?.id ?? ""])
    guard let u = URL(string: url), let scheme = u.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return }
    UIApplication.shared.open(u, options: [:], completionHandler: nil)
  }

  func groupViewTapMute(_ gv: SVGroupView) {
    muted.toggle()
    for p in pages.values { p.setMuted(muted) }
    haptic.impactOccurred()
  }

  func groupViewIsMuted(_ gv: SVGroupView) -> Bool { return muted }

  private static func videoURL(_ item: SVItem) -> URL? {
    return MVItem.existingFileURL(item.localUri) ?? MVItem.existingFileURL(item.uri) ?? MVItem.remoteURL(item.uri)
  }

  func groupViewTakePlayer(_ gv: SVGroupView, item: SVItem) -> AVPlayer? {
    if let p = preloaded.removeValue(forKey: item.id) {
      preloadOrder.removeAll { $0 == item.id }
      return p
    }
    guard let u = StoryViewerController.videoURL(item) else { return nil }
    let it = AVPlayerItem(url: u)
    it.preferredForwardBufferDuration = 4
    return AVPlayer(playerItem: it)
  }

  func groupViewNeighborPrefetch(_ gv: SVGroupView, item: SVItem) {
    prefetch(item)
  }

  private func prefetch(_ item: SVItem) {
    switch item.type {
    case .image:
      if !item.thumb.isEmpty { MVImageLoader.shared.prefetch(item.thumb, maxPixel: MVImageLoader.thumbMaxPixel) }
      let src = (!item.localUri.isEmpty && MVItem.existingFileURL(item.localUri) != nil) ? item.localUri : item.uri
      if !src.isEmpty { MVImageLoader.shared.prefetch(src, maxPixel: MVImageLoader.fullMaxPixel) }
    case .video:
      if !item.thumb.isEmpty { MVImageLoader.shared.prefetch(item.thumb, maxPixel: MVImageLoader.thumbMaxPixel) }
      guard preloaded[item.id] == nil, let u = StoryViewerController.videoURL(item) else { return }
      let it = AVPlayerItem(url: u)
      it.preferredForwardBufferDuration = 4
      let p = AVPlayer(playerItem: it)
      p.isMuted = true
      p.automaticallyWaitsToMinimizeStalling = true
      preloaded[item.id] = p
      preloadOrder.append(item.id)
      while preloadOrder.count > 2 {
        let old = preloadOrder.removeFirst()
        preloaded.removeValue(forKey: old)?.pause()
      }
    case .text, .voice:
      break
    }
  }

  // MARK: - Composer

  private func buildComposer() {
    composer.isHidden = true
    composer.alpha = 0
    view.addSubview(composer)
    composerDim.backgroundColor = UIColor(white: 0, alpha: 0.55)
    composerDim.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(closeComposerTap)))
    composer.addSubview(composerDim)

    reactionsRow.axis = .horizontal
    reactionsRow.distribution = .equalSpacing
    reactionsRow.alignment = .center
    for (i, r) in reactions.enumerated() {
      let b = UIButton(type: .custom)
      b.setImage(SVIcons.reaction(r.kind, size: 34), for: .normal)
      b.tag = i
      b.accessibilityLabel = r.emoji
      b.addTarget(self, action: #selector(tapReaction(_:)), for: .touchUpInside)
      b.frame = CGRect(x: 0, y: 0, width: 48, height: 48)
      b.widthAnchor.constraint(equalToConstant: 48).isActive = true
      b.heightAnchor.constraint(equalToConstant: 48).isActive = true
      reactionsRow.addArrangedSubview(b)
    }
    composer.addSubview(reactionsRow)

    composer.addSubview(inputBar)
    fieldBox.layer.cornerRadius = 23
    fieldBox.layer.borderWidth = 1
    fieldBox.layer.borderColor = UIColor(white: 1, alpha: 0.6).cgColor
    fieldBox.backgroundColor = UIColor(white: 0, alpha: 0.35)
    inputBar.addSubview(fieldBox)
    field.textColor = .white
    field.tintColor = .white
    field.font = .systemFont(ofSize: 16)
    field.returnKeyType = .send
    field.keyboardAppearance = .dark
    field.delegate = self
    fieldBox.addSubview(field)
    sendButton.setImage(UIImage(systemName: "paperplane.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold)), for: .normal)
    sendButton.tintColor = .white
    sendButton.accessibilityLabel = labels.get("send", "Enviar")
    sendButton.addTarget(self, action: #selector(sendReply), for: .touchUpInside)
    inputBar.addSubview(sendButton)
  }

  private func layoutComposer() {
    let b = view.bounds
    composer.frame = b
    composerDim.frame = b
    let safeBottom = view.safeAreaInsets.bottom
    let barH: CGFloat = 46
    let bottomY = keyboardTop > 0 ? keyboardTop - 8 : b.height - max(12, safeBottom) - 8
    inputBar.frame = CGRect(x: 12, y: bottomY - barH, width: b.width - 24, height: barH)
    sendButton.frame = CGRect(x: inputBar.bounds.width - 46, y: 0, width: 46, height: barH)
    fieldBox.frame = CGRect(x: 0, y: 0, width: inputBar.bounds.width - 52, height: barH)
    field.frame = fieldBox.bounds.insetBy(dx: 18, dy: 0)
    let rw = min(b.width - 32, CGFloat(max(1, reactions.count)) * 58)
    reactionsRow.frame = CGRect(x: (b.width - rw) / 2, y: inputBar.frame.minY - 76, width: rw, height: 56)
  }

  private func keyboardChanged(_ n: Notification, hiding: Bool = false) {
    guard let info = n.userInfo, let end = (info[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
    let local = view.convert(end, from: nil)
    let top = (hiding || local.minY >= view.bounds.height) ? 0 : local.minY
    keyboardTop = top
    let dur = (info[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
    let curve = (info[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?.uintValue ?? 7
    UIView.animate(withDuration: dur, delay: 0, options: [UIView.AnimationOptions(rawValue: curve << 16), .beginFromCurrentState], animations: {
      self.layoutComposer()
    })
  }

  private func openComposer(question: SVOverlay? = nil) {
    guard !closed, !composerOpen, currentGroup < groups.count, !groups[currentGroup].isSelf, currentPage?.currentItem != nil else { return }
    composerOpen = true
    composerQuestion = question
    reactionsRow.isHidden = question != nil
    addPause("composer")
    let g = groups[currentGroup]
    let ph = question.map { $0.text.isEmpty ? $0.hint : $0.text } ?? labels.get("replyTo", "Responder").replacingOccurrences(of: "{name}", with: g.ownerName)
    field.attributedPlaceholder = NSAttributedString(string: ph, attributes: [.foregroundColor: UIColor(white: 1, alpha: 0.6)])
    field.text = ""
    composer.isHidden = false
    layoutComposer()
    UIView.animate(withDuration: 0.2) { self.composer.alpha = 1 }
    field.becomeFirstResponder()
  }

  @objc private func closeComposerTap() { closeComposer() }

  private func closeComposer() {
    guard composerOpen else { return }
    composerOpen = false
    DispatchQueue.main.async { [weak self] in
      guard let self = self, !self.composerOpen else { return }
      self.composerQuestion = nil
      self.reactionsRow.isHidden = false
    }
    field.resignFirstResponder()
    UIView.animate(withDuration: 0.18, animations: { self.composer.alpha = 0 }, completion: { _ in
      if !self.composerOpen { self.composer.isHidden = true }
    })
    removePause("composer")
  }

  func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    sendReply()
    return false
  }

  @objc private func sendReply() {
    let text = (field.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, let gv = currentPage, let item = gv.currentItem else {
      if (field.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { closeComposer() }
      return
    }
    if let q = composerQuestion {
      emit?("onSticker", ["id": item.id, "ownerEmail": gv.group.ownerEmail, "kind": "question", "stickerId": q.id, "text": text])
    } else {
      emit?("onReply", ["id": item.id, "ownerEmail": gv.group.ownerEmail, "text": text])
    }
    UINotificationFeedbackGenerator().notificationOccurred(.success)
    field.text = ""
    closeComposer()
    showToast(composerQuestion != nil ? labels.get("answerSent", "Resposta enviada") : labels.get("replySent", "Resposta enviada"))
  }

  @objc private func tapReaction(_ sender: UIButton) {
    guard sender.tag >= 0, sender.tag < reactions.count, let gv = currentPage, let item = gv.currentItem else { return }
    let r = reactions[sender.tag]
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    item.myReaction = item.myReaction == r.emoji ? "" : r.emoji
    gv.refreshCounters()
    emit?("onReact", ["id": item.id, "ownerEmail": gv.group.ownerEmail, "emoji": r.emoji, "active": !item.myReaction.isEmpty])
    closeComposer()
    if !item.myReaction.isEmpty { burst(r.kind) }
  }

  private func burst(_ kind: String, at point: CGPoint? = nil) {
    guard let img = SVIcons.reaction(kind, size: 110) else { return }
    let iv = UIImageView(image: img)
    iv.frame = CGRect(x: 0, y: 0, width: 110, height: 110)
    iv.center = point ?? CGPoint(x: view.bounds.midX, y: view.bounds.midY)
    iv.transform = CGAffineTransform(scaleX: 0.3, y: 0.3)
    iv.isUserInteractionEnabled = false
    view.addSubview(iv)
    UIView.animate(withDuration: 0.28, delay: 0, usingSpringWithDamping: 0.55, initialSpringVelocity: 0.8, options: [], animations: {
      iv.transform = CGAffineTransform(scaleX: 1.1, y: 1.1)
    }, completion: { _ in
      UIView.animate(withDuration: 0.45, delay: 0.25, options: [.curveEaseIn], animations: {
        iv.alpha = 0
        iv.transform = CGAffineTransform(translationX: 0, y: -120).scaledBy(x: 0.8, y: 0.8)
      }, completion: { _ in iv.removeFromSuperview() })
    })
  }

  // MARK: - Folha "Visualizações"

  private func buildSheet() {
    sheet.isHidden = true
    view.addSubview(sheet)
    sheetDim.backgroundColor = UIColor(white: 0, alpha: 0.5)
    sheetDim.alpha = 0
    sheetDim.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(closeSheetTap)))
    sheet.addSubview(sheetDim)
    sheetPanel.backgroundColor = UIColor(red: 0.11, green: 0.11, blue: 0.12, alpha: 1)
    sheetPanel.layer.cornerRadius = 20
    sheetPanel.layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
    sheetPanel.clipsToBounds = true
    sheet.addSubview(sheetPanel)
    sheetHandle.backgroundColor = UIColor(white: 1, alpha: 0.25)
    sheetHandle.layer.cornerRadius = 2.5
    sheetPanel.addSubview(sheetHandle)
    sheetTitle.textColor = .white
    sheetTitle.font = .systemFont(ofSize: 17, weight: .bold)
    sheetPanel.addSubview(sheetTitle)
    sheetClose.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 16, weight: .semibold)), for: .normal)
    sheetClose.tintColor = UIColor(white: 1, alpha: 0.7)
    sheetClose.accessibilityLabel = labels.get("close", "Fechar")
    sheetClose.addTarget(self, action: #selector(closeSheetTap), for: .touchUpInside)
    sheetPanel.addSubview(sheetClose)
    sheetTable.backgroundColor = .clear
    sheetTable.separatorStyle = .none
    sheetTable.rowHeight = 62
    sheetTable.dataSource = self
    sheetTable.delegate = self
    sheetTable.register(SVViewerCell.self, forCellReuseIdentifier: SVViewerCell.reuseId)
    sheetPanel.addSubview(sheetTable)
    sheetSpinner.color = .white
    sheetSpinner.hidesWhenStopped = true
    sheetPanel.addSubview(sheetSpinner)
    sheetEmpty.textColor = UIColor(white: 1, alpha: 0.55)
    sheetEmpty.font = .systemFont(ofSize: 14)
    sheetEmpty.textAlignment = .center
    sheetEmpty.text = labels.get("noViews", "Ninguém viu ainda")
    sheetEmpty.isHidden = true
    sheetPanel.addSubview(sheetEmpty)
    sheetPan.addTarget(self, action: #selector(handleSheetPan(_:)))
    sheetPan.delegate = self
    sheetPanel.addGestureRecognizer(sheetPan)
  }

  private var sheetHeight: CGFloat { return min(view.bounds.height * 0.62, 560) }

  private func layoutSheet(animated: Bool) {
    let b = view.bounds
    sheet.frame = b
    sheetDim.frame = b
    let h = sheetHeight
    let y = sheetOpen ? b.height - h : b.height
    sheetPanel.frame = CGRect(x: 0, y: y, width: b.width, height: h)
    sheetHandle.frame = CGRect(x: (b.width - 40) / 2, y: 8, width: 40, height: 5)
    sheetTitle.frame = CGRect(x: 20, y: 22, width: b.width - 80, height: 24)
    sheetClose.frame = CGRect(x: b.width - 52, y: 14, width: 40, height: 40)
    let tableY: CGFloat = 58
    sheetTable.frame = CGRect(x: 0, y: tableY, width: b.width, height: h - tableY)
    sheetTable.contentInset = UIEdgeInsets(top: 0, left: 0, bottom: view.safeAreaInsets.bottom + 8, right: 0)
    sheetSpinner.center = CGPoint(x: b.width / 2, y: tableY + 50)
    sheetEmpty.frame = CGRect(x: 20, y: tableY + 30, width: b.width - 40, height: 40)
  }

  private func updateSheetTitle() {
    guard sheetOpen else { return }
    var count = sheetRows.count
    for g in groups {
      if let it = g.items.first(where: { $0.id == sheetItemId }) { count = max(count, it.viewsCount) }
    }
    sheetTitle.text = "\(labels.get("seenBy", "Visualizações")) · \(count)"
  }

  private func openViewers() {
    guard !closed, !sheetOpen, currentGroup < groups.count, groups[currentGroup].isSelf, let item = currentPage?.currentItem else { return }
    sheetOpen = true
    sheetItemId = item.id
    sheetRows = viewersCache[item.id] ?? []
    addPause("sheet")
    sheetTable.reloadData()
    sheetEmpty.isHidden = true
    if sheetRows.isEmpty { sheetSpinner.startAnimating() }
    updateSheetTitle()
    sheet.isHidden = false
    sheetOpen = false
    layoutSheet(animated: false)
    sheetOpen = true
    UIView.animate(withDuration: 0.34, delay: 0, usingSpringWithDamping: 0.9, initialSpringVelocity: 0.3, options: [.allowUserInteraction], animations: {
      self.sheetDim.alpha = 1
      self.layoutSheet(animated: true)
    })
    emit?("onOpenViewers", ["id": item.id])
  }

  @objc private func closeSheetTap() { closeSheet() }

  private func closeSheet() {
    guard sheetOpen else { return }
    sheetOpen = false
    UIView.animate(withDuration: 0.22, delay: 0, options: [.curveEaseIn], animations: {
      self.sheetDim.alpha = 0
      self.layoutSheet(animated: true)
    }, completion: { _ in
      if !self.sheetOpen { self.sheet.isHidden = true }
    })
    removePause("sheet")
    emit?("onCloseViewers", ["id": sheetItemId])
  }

  @objc private func handleSheetPan(_ g: UIPanGestureRecognizer) {
    let t = g.translation(in: view)
    let base = view.bounds.height - sheetHeight
    // gestureRecognizerShouldBegin: só começa puxando p/ baixo no cabeçalho
    // ou com a lista no topo.
    switch g.state {
    case .changed:
      sheetPanel.frame.origin.y = base + max(0, t.y)
    case .ended, .cancelled:
      if t.y > 110 || g.velocity(in: view).y > 900 {
        closeSheet()
      } else {
        UIView.animate(withDuration: 0.25) { self.sheetPanel.frame.origin.y = base }
      }
    default:
      break
    }
  }

  func setViewers(id: String, rows: [[String: Any]], loading: Bool) {
    viewersCache[id] = rows
    guard sheetOpen, sheetItemId == id else { return }
    sheetRows = rows
    sheetTable.reloadData()
    if loading && rows.isEmpty { sheetSpinner.startAnimating() } else { sheetSpinner.stopAnimating() }
    sheetEmpty.isHidden = loading || !rows.isEmpty
    updateSheetTitle()
  }

  func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
    return sheetRows.count
  }

  func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let cell = tableView.dequeueReusableCell(withIdentifier: SVViewerCell.reuseId, for: indexPath) as! SVViewerCell
    let row = sheetRows[indexPath.row]
    let email = (row["email"] as? String) ?? ""
    let name = (row["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? email
    cell.name.text = name
    cell.time.text = (row["time"] as? String) ?? ""
    cell.initial.text = name.first.map { String($0).uppercased() } ?? ""
    let kind = (row["reaction"] as? String) ?? ""
    cell.reaction.image = kind.isEmpty ? nil : SVIcons.reaction(kind, size: 22)
    let av = (row["avatar"] as? String) ?? ""
    cell.avatarUri = av
    cell.avatar.image = nil
    cell.initial.isHidden = false
    if !av.isEmpty {
      if let img = MVImageLoader.shared.cachedImage(av, maxPixel: 160) {
        cell.avatar.image = img
        cell.initial.isHidden = true
      } else {
        MVImageLoader.shared.load(av, maxPixel: 160) { [weak cell] img in
          guard let cell = cell, cell.avatarUri == av, let img = img else { return }
          cell.avatar.image = img
          cell.initial.isHidden = true
        }
      }
    }
    cell.setNeedsLayout()
    return cell
  }

  func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
    guard indexPath.row < sheetRows.count else { return }
    let email = (sheetRows[indexPath.row]["email"] as? String) ?? ""
    emit?("onViewerPress", ["id": sheetItemId, "email": email])
  }

  // MARK: - Toast

  func showToast(_ text: String) {
    guard !text.isEmpty else { return }
    toastWork?.cancel()
    toast.text = text
    view.setNeedsLayout()
    view.layoutIfNeeded()
    view.bringSubviewToFront(toast)
    UIView.animate(withDuration: 0.18) { self.toast.alpha = 1 }
    let w = DispatchWorkItem { [weak self] in
      UIView.animate(withDuration: 0.25) { self?.toast.alpha = 0 }
    }
    toastWork = w
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6, execute: w)
  }

  // MARK: - API do JS

  func setPausedFromJS(_ p: Bool) {
    if p { addPause("js") } else { removePause("js") }
  }

  func setHasMore(next: Bool, prev: Bool) {
    hasMoreNext = next
    hasMorePrev = prev
    if let d = pendingMore, (d == "next" && !next) || (d == "prev" && !prev) {
      resolveMore(appended: false)
    }
  }

  /// Nova pessoa vinda do JS (resposta ao onNeedMore ou pré-carga).
  func appendGroup(_ g: SVGroup, direction: String) {
    guard !closed, !g.items.isEmpty else {
      if pendingMore == direction { resolveMore(appended: false) }
      return
    }
    if groups.contains(where: { $0.key == g.key }) {
      if pendingMore == direction { resolveMore(appended: false) }
      return
    }
    let w = pager.bounds.width
    let h = pager.bounds.height
    let wasPending = pendingMore == direction
    if direction == "prev" {
      groups.insert(g, at: 0)
      var shifted: [Int: SVGroupView] = [:]
      for (i, p) in pages { shifted[i + 1] = p }
      pages = shifted
      currentGroup += 1
      programmaticScroll = true
      pager.contentSize = CGSize(width: w * CGFloat(groups.count), height: h)
      pager.contentOffset = CGPoint(x: CGFloat(currentGroup) * w, y: 0)
      programmaticScroll = false
      for (i, p) in pages { place(p, i) }
    } else {
      groups.append(g)
      pager.contentSize = CGSize(width: w * CGFloat(groups.count), height: h)
    }
    ensurePages()
    applyCube()
    if wasPending {
      resolveMore(appended: true)
      goToGroup(direction == "prev" ? currentGroup - 1 : currentGroup + 1)
    }
  }

  func updateItem(id: String, patch: [String: Any]) {
    for (gi, g) in groups.enumerated() {
      guard let it = g.items.first(where: { $0.id == id }) else { continue }
      if let v = patch["viewed"] as? Bool { it.viewed = v }
      if let n = MVItem.intValue(patch["viewsCount"]) { it.viewsCount = n }
      if patch.keys.contains("myReaction") { it.myReaction = (patch["myReaction"] as? String) ?? "" }
      var captionChanged = false
      if let c = patch["caption"] as? String { it.caption = c; captionChanged = true }
      if let tr = patch["translated"] as? Bool { it.translated = tr; captionChanged = true }
      if let op = patch["overlay"] as? [String: Any], let oid = op["id"] as? String {
        // Modelo (persiste ao voltar ao item) + bloco na tela, se visível.
        if let ov = it.overlays.first(where: { $0.id == oid }) {
          if let c = op["counts"] as? [Any] { ov.counts = c.map { MVItem.intValue($0) ?? 0 } }
          if let mv = MVItem.intValue(op["myVote"]) { ov.myVote = mv }
          if let v = MVItem.doubleValue(op["value"]) { ov.value = v }
          if let a = MVItem.doubleValue(op["avg"]) { ov.avg = a }
        }
        if let p = pages[gi], p.currentItem?.id == id { p.overlayLayer.apply(overlayId: oid, patch: [:]) }
      }
      if captionChanged, let p = pages[gi], p.currentItem?.id == id { p.refreshCaption() }
      if let p = pages[gi], p.currentItem?.id == id { p.refreshCounters() }
      if sheetOpen && sheetItemId == id { updateSheetTitle() }
    }
  }

  func removeItem(id: String) {
    guard let gi = groups.firstIndex(where: { g in g.items.contains(where: { $0.id == id }) }) else { return }
    let g = groups[gi]
    guard let ii = g.items.firstIndex(where: { $0.id == id }) else { return }
    if sheetOpen && sheetItemId == id { closeSheet() }
    var items = g.items
    items.remove(at: ii)
    if items.isEmpty {
      if groups.count == 1 {
        finish(reason: "empty", animated: true)
        return
      }
      // Remove a pessoa inteira e reconstrói as páginas.
      for p in pages.values { p.deactivate(); p.removeFromSuperview() }
      pages.removeAll()
      groups.remove(at: gi)
      if currentGroup >= groups.count || gi < currentGroup { currentGroup = max(0, currentGroup - 1) }
      let w = pager.bounds.width
      let h = pager.bounds.height
      programmaticScroll = true
      pager.contentSize = CGSize(width: w * CGFloat(groups.count), height: h)
      pager.contentOffset = CGPoint(x: CGFloat(currentGroup) * w, y: 0)
      programmaticScroll = false
      ensurePages()
      applyCube()
      currentPage?.activate()
      applyPauseState()
      return
    }
    let page = pages[gi]
    let wasCurrent = gi == currentGroup
    if g.index >= ii && g.index > 0 && !(g.index == ii && ii < items.count) { g.index -= 1 }
    g.index = max(0, min(items.count - 1, g.index))
    if let p = page {
      p.replaceGroupItems(items)
      p.showItem(g.index, autoplay: wasCurrent)
      if wasCurrent { p.activate(); applyPauseState() }
    } else {
      g.items = items
    }
  }

  func closeFromJS() {
    finish(reason: "js", animated: true)
  }

  func closeSilently() {
    finish(reason: "replaced", animated: false)
  }

  private func finish(reason: String, animated: Bool) {
    if closed { return }
    closed = true
    link?.invalidate()
    link = nil
    pendingMoreWork?.cancel()
    pendingTap?.cancel()
    toastWork?.cancel()
    field.resignFirstResponder()
    for p in pages.values { p.deactivate() }
    for p in preloaded.values { p.pause() }
    preloaded.removeAll()
    preloadOrder.removeAll()
    MVAudio.restore()
    let g = currentGroup < groups.count ? groups[currentGroup] : nil
    let item = g.flatMap { $0.index < $0.items.count ? $0.items[$0.index] : nil }
    let body: [String: Any?] = [
      "reason": reason,
      "groupIndex": currentGroup,
      "itemIndex": g?.index ?? 0,
      "id": item?.id ?? "",
      "ownerEmail": g?.ownerEmail ?? "",
    ]
    // Captura forte: o controller pode já ter sido liberado quando o
    // completion do dismiss roda.
    let em = emit
    let fin = onFinished
    let done = {
      em?("onClose", body)
      fin?()
    }
    // Pelo apresentador: fecha também um alerta/menu aberto por cima.
    if let pvc = presentingViewController {
      pvc.dismiss(animated: animated) { done() }
    } else {
      done()
    }
  }
}
