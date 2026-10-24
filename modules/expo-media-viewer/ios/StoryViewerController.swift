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

  // [status-zoom 2026-10-23] Pinça até 4x / duplo toque (apiVersion 5). JS liga
  // por `zoom` no open() (kill switch globalThis.__chatyy_status_zoom=false).
  var zoomEnabled = false
  private let pinch = UIPinchGestureRecognizer()
  private let zoomPan = UIPanGestureRecognizer()
  private let zoomMax: CGFloat = 4
  private var zoomScale: CGFloat = 1
  private var zoomT: CGPoint = .zero
  private var zoomSticky = false   // duplo toque: fica ampliado até novo duplo toque
  private var zoomActive = false   // pinça em curso
  private var zoomBaseS: CGFloat = 1
  private var zoomBaseT: CGPoint = .zero
  private var zoomBaseF: CGPoint = .zero
  private var zoomBasePinch: CGFloat = 1
  private var zoomBaseN = 0
  private var lastZoomTapAt: CFTimeInterval = 0
  private var isZoomed: Bool { return zoomActive || zoomSticky || zoomScale > 1.01 }

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

  // [2026-10-17 status-reacoes] apiVersion 4 — bolha ao segurar o coração +
  // "+" com a grade completa (SVEmojiStore). O módulo liga antes do present.
  var reactionHold = false
  private var reactBubble: SVReactBubble?
  private var bubbleStartedOnHeart = true
  private var bubbleTapMode = false
  private var bubbleCatcher: UIControl?
  private var emojiSheet: SVEmojiSheet?
  private var pickerEnabled: Bool { reactionHold && !SVEmojiStore.cats.isEmpty }

  private let haptic = UIImpactFeedbackGenerator(style: .light)
  private let selection = UISelectionFeedbackGenerator()

  private var observers: [NSObjectProtocol] = []

  // [2026-10-16 motion] Abre crescendo do anel do avatar (Telegram) e, se a
  // pessoa ainda for a mesma, fecha voltando para ele. Kill switch:
  // __chatyy_motion_story_origin. Reduzir Movimento → crossfade.
  private var originRect: CGRect?
  private var originOwner = ""
  private var originOpenPending = false
  private var originClosing = false
  private let originMask = UIView()

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

  /// Chamado ANTES do present (present sem animação — a origem é a animação).
  func setOrigin(_ rect: CGRect) {
    guard rect.width > 2, rect.height > 2, currentGroup < groups.count else { return }
    originRect = rect
    originOwner = groups[currentGroup].ownerEmail
    originOpenPending = true
  }

  var hasOrigin: Bool { originRect != nil }

  /// Transform que leva o círculo central do stage (lado = largura) até `r`.
  private func originTransform(_ r: CGRect) -> CGAffineTransform {
    let b = view.bounds
    let s = max(0.02, min(r.width, r.height) / max(1, b.width))
    return CGAffineTransform(translationX: r.midX - b.midX, y: r.midY - b.midY).scaledBy(x: s, y: s)
  }

  private func originCircle() -> CGRect {
    let b = view.bounds
    return CGRect(x: 0, y: (b.height - b.width) / 2, width: b.width, height: b.width)
  }

  private func runOriginOpen() -> Bool {
    guard originOpenPending, let r = originRect else { return false }
    originOpenPending = false
    view.layoutIfNeeded()
    let b = view.bounds
    guard b.width > 0, b.height > 0 else { return false }
    stage.transform = .identity
    stage.frame = b
    originMask.backgroundColor = .black
    originMask.frame = originCircle()
    originMask.layer.cornerRadius = b.width / 2
    stage.mask = originMask
    stage.transform = originTransform(r)
    stage.alpha = 0
    backdrop.alpha = 0
    addPause("origin")
    UIView.animate(withDuration: 0.12, delay: 0, options: [.curveEaseOut], animations: { self.stage.alpha = 1 })
    UIView.animate(withDuration: 0.42, delay: 0, usingSpringWithDamping: 0.88, initialSpringVelocity: 0, options: [.allowUserInteraction], animations: {
      self.stage.transform = .identity
      self.originMask.frame = CGRect(origin: .zero, size: b.size)
      self.originMask.layer.cornerRadius = 0
      self.backdrop.alpha = 1
    }, completion: { _ in
      if self.stage.mask === self.originMask && !self.originClosing { self.stage.mask = nil }
      self.removePause("origin")
    })
    return true
  }

  /// Fecha encolhendo até o anel. false = outra pessoa / sem origem → normal.
  private func tryOriginClose(reason: String, velocity: CGFloat = 0) -> Bool {
    guard let r = originRect, !originClosing, !closed, MVMotion.storyOrigin, !MVMotion.reduceMotion,
          isViewLoaded, view.window != nil, presentedViewController == nil,
          currentGroup < groups.count, groups[currentGroup].ownerEmail == originOwner else { return false }
    originClosing = true
    view.isUserInteractionEnabled = false
    addPause("origin")
    field.resignFirstResponder()
    let b = view.bounds
    let curY = b.midY + stage.transform.ty
    stage.layer.removeAllAnimations()
    originMask.layer.removeAllAnimations()
    originMask.backgroundColor = .black
    originMask.frame = CGRect(origin: .zero, size: b.size)
    originMask.layer.cornerRadius = stage.layer.cornerRadius
    stage.layer.cornerRadius = 0
    stage.mask = originMask
    let target = originTransform(r)
    let v0 = (velocity > 0 && r.midY > curY) ? MVMotion.springVelocity(velocity, remaining: r.midY - curY) : 0
    UIView.animate(withDuration: 0.38, delay: 0, usingSpringWithDamping: 0.95, initialSpringVelocity: v0, options: [.beginFromCurrentState, .curveEaseOut], animations: {
      self.stage.transform = target
      self.originMask.frame = self.originCircle()
      self.originMask.layer.cornerRadius = b.width / 2
      self.backdrop.alpha = 0
      self.composer.alpha = 0
    })
    UIView.animate(withDuration: 0.12, delay: 0.24, options: [.curveEaseIn, .beginFromCurrentState], animations: {
      self.stage.alpha = 0
    }, completion: { _ in
      self.finish(reason: reason, animated: false)
    })
    return true
  }

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

    // [status-zoom 2026-10-23]
    pinch.addTarget(self, action: #selector(handlePinch(_:)))
    pinch.delegate = self
    pager.addGestureRecognizer(pinch)
    zoomPan.minimumNumberOfTouches = 1
    zoomPan.maximumNumberOfTouches = 1
    zoomPan.addTarget(self, action: #selector(handleZoomPan(_:)))
    zoomPan.delegate = self
    zoomPan.isEnabled = false
    pager.addGestureRecognizer(zoomPan)

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
    if link == nil && originOpenPending && runOriginOpen() {
      // [2026-10-16 motion] cresce do anel do avatar
    } else if link == nil {
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
    p.likeHoldEnabled = reactionHold
    p.viewerRows = { [weak self] id in self?.viewersCache[id] }
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
      if cube && x != 0 && !MVMotion.reduceMotion {
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
      if isZoomed { resetZoom(animated: false) } // [status-zoom]
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
    if isZoomed { resetZoom(animated: false) } // [status-zoom]
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
    if isZoomed { resetZoom(animated: false) } // [status-zoom]
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
    if g === pinch {
      // [status-zoom] só foto/vídeo, sem cubo girando
      guard zoomEnabled, let page = currentPage, page.isZoomable, !closed, pendingMore == nil else { return false }
      return !pager.isDragging && !pager.isDecelerating
    }
    if g === zoomPan { return zoomSticky && !closed }
    if g === vpan {
      if isZoomed { return false } // [status-zoom] ampliado: arrastar não fecha
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
    // [status-zoom] pinça junto com segurar e com o arrasto ampliado
    if (g === pinch && (other === hold || other === zoomPan)) || (other === pinch && (g === hold || g === zoomPan)) { return true }
    return false
  }

  @objc private func handleTap(_ g: UITapGestureRecognizer) {
    guard !closed, pendingMore == nil else { return }
    let loc = g.location(in: view)
    let w = view.bounds.width
    // [status-zoom 2026-10-23] ampliado: toque nunca troca de status; duplo toque volta a 1x.
    if isZoomed {
      pendingTap?.cancel(); pendingTap = nil
      let now = CACurrentMediaTime()
      if now - lastZoomTapAt < 0.28 { lastZoomTapAt = 0; resetZoom(animated: true) } else { lastZoomTapAt = now }
      return
    }
    let canZoom = zoomEnabled && (currentPage?.isZoomable ?? false)
    if loc.x < w * 0.3 {
      pendingTap?.cancel(); pendingTap = nil
      goPrev()
      return
    }
    // Duplo toque no centro = curtir (status dos outros), como no viewer JS.
    let canLike = currentGroup < groups.count && !groups[currentGroup].isSelf
    if (!canLike && !canZoom) || loc.x > w * 0.72 {
      pendingTap?.cancel(); pendingTap = nil
      goNext()
      return
    }
    let now = CACurrentMediaTime()
    if let p = pendingTap, now - lastTapAt < 0.28 {
      p.cancel()
      pendingTap = nil
      lastTapAt = 0
      // [status-zoom] foto/vídeo: duplo toque amplia (curtir segue no coração)
      if canZoom, let page = currentPage { zoomDoubleTap(at: g.location(in: page)) } else { doubleTapLike(at: loc) }
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
      // [2026-10-16 motion] Segurar = leve recuo com mola (kill switch __chatyy_motion_story_hold).
      if MVMotion.holdScale && !MVMotion.reduceMotion && !isZoomed && stage.transform.isIdentity && !originClosing && stage.mask == nil {
        UIView.animate(withDuration: 0.34, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
          self.stage.transform = CGAffineTransform(scaleX: 0.965, y: 0.965)
          self.stage.layer.cornerRadius = 14
        })
      }
    case .ended, .cancelled, .failed:
      if pauseReasons.contains("hold") {
        removePause("hold")
        if !isZoomed { currentPage?.setChromeHidden(false, animated: true) } // [status-zoom]
      }
      if !pauseReasons.contains("dismiss") && !originClosing && !closed
          && vpan.state != .began && vpan.state != .changed && !stage.transform.isIdentity {
        UIView.animate(withDuration: 0.36, delay: 0, usingSpringWithDamping: 0.72, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
          self.stage.transform = .identity
          self.stage.layer.cornerRadius = 0
        })
      }
    default:
      break
    }
  }

  // MARK: - Zoom [status-zoom 2026-10-23]

  private func beginZoomSession() {
    pendingTap?.cancel(); pendingTap = nil
    addPause("zoom")
    currentPage?.setChromeHidden(true, animated: true)
    pager.isScrollEnabled = false
    // arrasto de fechar em curso (1º dedo) → cancela e volta o palco
    if vpan.state == .began || vpan.state == .changed { vpan.isEnabled = false; vpan.isEnabled = true }
    if !stage.transform.isIdentity && !originClosing && stage.mask == nil {
      UIView.animate(withDuration: 0.25, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
        self.stage.transform = .identity
        self.stage.layer.cornerRadius = 0
        self.backdrop.alpha = 1
      })
    }
  }

  private func applyZoom() {
    guard let page = currentPage else { return }
    page.setZoom(CGAffineTransform(translationX: zoomT.x, y: zoomT.y).scaledBy(x: zoomScale, y: zoomScale))
    if zoomScale > 1.5 { page.loadHiresIfNeeded() }
  }

  private func clampZoomT(_ t: CGPoint, _ s: CGFloat, _ page: UIView) -> CGPoint {
    let mx = max(0, (s - 1) * page.bounds.width / 2)
    let my = max(0, (s - 1) * page.bounds.height / 2)
    return CGPoint(x: min(mx, max(-mx, t.x)), y: min(my, max(-my, t.y)))
  }

  private func animateZoom(completion: (() -> Void)? = nil) {
    UIView.animate(withDuration: 0.34, delay: 0, usingSpringWithDamping: 0.86, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
      self.applyZoom()
    }, completion: { _ in completion?() })
  }

  private func resetZoom(animated: Bool) {
    zoomSticky = false
    zoomActive = false
    zoomPan.isEnabled = false
    zoomScale = 1
    zoomT = .zero
    let page = currentPage
    let done = { [weak self] in
      guard let self = self, !self.zoomActive, !self.zoomSticky else { return }
      self.pager.isScrollEnabled = true
      if self.pauseReasons.contains("zoom") {
        self.removePause("zoom")
        if !self.pauseReasons.contains("hold") && !self.closed { self.currentPage?.setChromeHidden(false, animated: true) }
      }
    }
    if animated {
      UIView.animate(withDuration: 0.32, delay: 0, usingSpringWithDamping: 0.86, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
        page?.setZoom(.identity)
      }, completion: { _ in done() })
    } else {
      page?.setZoom(.identity)
      done()
    }
  }

  private func zoomRebase(_ g: UIPinchGestureRecognizer, _ page: UIView) {
    zoomBaseS = zoomScale
    zoomBaseT = zoomT
    zoomBaseF = g.location(in: page)
    zoomBasePinch = g.scale
    zoomBaseN = g.numberOfTouches
  }

  @objc private func handlePinch(_ g: UIPinchGestureRecognizer) {
    guard let page = currentPage else { return }
    switch g.state {
    case .began:
      zoomActive = true
      beginZoomSession()
      zoomRebase(g, page)
    case .changed:
      // dedo entrou/saiu → nova base (sem salto); 1 dedo = só arrasta
      if g.numberOfTouches != zoomBaseN { zoomRebase(g, page); return }
      let f = g.location(in: page)
      var s = zoomBaseS
      if g.numberOfTouches >= 2 { s = zoomBaseS * (g.scale / max(0.01, zoomBasePinch)) }
      if s < 1 { s = max(0.7, 1 - (1 - s) * 0.4) }
      if s > zoomMax { s = min(zoomMax * 1.15, zoomMax + (s - zoomMax) * 0.25) }
      let c = CGPoint(x: page.bounds.midX, y: page.bounds.midY)
      let qx = (zoomBaseF.x - c.x - zoomBaseT.x) / max(0.01, zoomBaseS)
      let qy = (zoomBaseF.y - c.y - zoomBaseT.y) / max(0.01, zoomBaseS)
      zoomScale = s
      zoomT = CGPoint(x: f.x - c.x - s * qx, y: f.y - c.y - s * qy)
      applyZoom()
    case .ended, .cancelled, .failed:
      zoomActive = false
      if zoomSticky && zoomScale >= 1.05 {
        // duplo toque antes: continua ampliado, dentro dos limites
        zoomScale = min(zoomMax, zoomScale)
        zoomT = clampZoomT(zoomT, zoomScale, page)
        zoomPan.isEnabled = true
        animateZoom()
      } else {
        // pinça (Instagram): soltar volta ao tamanho e retoma
        resetZoom(animated: true)
      }
    default:
      break
    }
  }

  @objc private func handleZoomPan(_ g: UIPanGestureRecognizer) {
    guard let page = currentPage else { return }
    switch g.state {
    case .began, .changed:
      let d = g.translation(in: page)
      g.setTranslation(.zero, in: page)
      if zoomActive || !zoomSticky { return } // a pinça manda
      zoomT = clampZoomT(CGPoint(x: zoomT.x + d.x, y: zoomT.y + d.y), zoomScale, page)
      applyZoom()
    default:
      break
    }
  }

  private func zoomDoubleTap(at p: CGPoint) {
    guard let page = currentPage else { return }
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    beginZoomSession()
    zoomSticky = true
    zoomPan.isEnabled = true
    let s: CGFloat = 2.5
    let c = CGPoint(x: page.bounds.midX, y: page.bounds.midY)
    zoomScale = s
    zoomT = clampZoomT(CGPoint(x: (1 - s) * (p.x - c.x), y: (1 - s) * (p.y - c.y)), s, page)
    animateZoom()
  }

  @objc private func handleVerticalPan(_ g: UIPanGestureRecognizer) {
    let t = g.translation(in: view)
    let h = max(1, view.bounds.height)
    switch g.state {
    case .began:
      addPause("dismiss")
      vpanUp = false
      // Mola do "segurar"/abertura em voo não briga com o dedo.
      if !originClosing {
        stage.layer.removeAllAnimations()
        if stage.mask === originMask { stage.mask = nil; removePause("origin") }
      }
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
    if tryOriginClose(reason: "swipe", velocity: velocity) { return }
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
    // [2026-10-17 status-reacoes] 7 emojis + "+" cabem em 375pt: botão 42
    let bs: CGFloat = reactions.count + (pickerEnabled ? 1 : 0) > 7 ? 42 : 48
    for (i, r) in reactions.enumerated() {
      let b = UIButton(type: .custom)
      b.setImage(SVIcons.emoji(r.emoji, size: bs - 8) ?? SVIcons.reaction(r.kind, size: 34), for: .normal)
      b.tag = i
      b.accessibilityLabel = r.emoji
      b.addTarget(self, action: #selector(tapReaction(_:)), for: .touchUpInside)
      b.frame = CGRect(x: 0, y: 0, width: bs, height: bs)
      b.widthAnchor.constraint(equalToConstant: bs).isActive = true
      b.heightAnchor.constraint(equalToConstant: bs).isActive = true
      reactionsRow.addArrangedSubview(b)
    }
    if pickerEnabled {
      // [2026-10-17 status-reacoes] "+" → grade completa de emojis
      let b = UIButton(type: .custom)
      b.setImage(SVPlusIcon.image(size: 26), for: .normal)
      b.backgroundColor = UIColor(white: 1, alpha: 0.16)
      b.layer.cornerRadius = 20
      b.accessibilityLabel = labels.get("moreReactions", "Mais reações")
      b.addTarget(self, action: #selector(tapMoreReactions), for: .touchUpInside)
      b.widthAnchor.constraint(equalToConstant: 40).isActive = true
      b.heightAnchor.constraint(equalToConstant: 40).isActive = true
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
    let n = CGFloat(max(1, reactionsRow.arrangedSubviews.count))
    let rw = min(b.width - 20, n * 50)
    reactionsRow.frame = CGRect(x: (b.width - rw) / 2, y: inputBar.frame.minY - 70, width: rw, height: 56)
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
    if reactionHold {
      let from = sender.convert(CGPoint(x: sender.bounds.midX, y: sender.bounds.midY), to: view)
      closeComposer()
      applyReaction(r.emoji, gv: gv, item: item, from: from)
      return
    }
    item.myReaction = item.myReaction == r.emoji ? "" : r.emoji
    gv.refreshCounters()
    emit?("onReact", ["id": item.id, "ownerEmail": gv.group.ownerEmail, "emoji": r.emoji, "active": !item.myReaction.isEmpty])
    closeComposer()
    if !item.myReaction.isEmpty { burst(r.kind, glyph: r.emoji) }
  }

  // MARK: - [2026-10-17 status-reacoes] Reações livres (apiVersion 4)

  /// Mesmo caminho do coração (onReact → status_react). Mesmo emoji de novo
  /// desfaz (o servidor alterna); outro emoji troca.
  private func applyReaction(_ emoji: String, gv: SVGroupView, item: SVItem, from: CGPoint?) {
    guard !emoji.isEmpty, !gv.group.isSelf else { return }
    item.myReaction = item.myReaction == emoji ? "" : emoji
    gv.refreshCounters()
    emit?("onReact", ["id": item.id, "ownerEmail": gv.group.ownerEmail, "emoji": emoji, "active": !item.myReaction.isEmpty])
    if !item.myReaction.isEmpty {
      UIImpactFeedbackGenerator(style: .medium).impactOccurred()
      SVReactionBurst.play(in: view, image: SVIcons.emoji(emoji, size: 180), from: from, reduce: MVMotion.reduceMotion)
    }
  }

  @objc private func tapMoreReactions() {
    // pausa contínua: "picker" entra antes do composer sair
    addPause("picker")
    closeComposer()
    openEmojiSheet()
  }

  private func openEmojiSheet() {
    guard emojiSheet == nil, !closed, let gv = currentPage, let item = gv.currentItem, !gv.group.isSelf else {
      removePause("picker")
      return
    }
    addPause("picker")
    let sh = SVEmojiSheet(quick: reactions.map { $0.emoji }, mine: item.myReaction, labels: labels)
    sh.frame = view.bounds
    sh.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    sh.onPick = { [weak self, weak sh] emoji, p in
      guard let self = self else { return }
      let from = sh.map { $0.convert(p, to: self.view) }
      self.closeEmojiSheet()
      if let gv = self.currentPage, let it = gv.currentItem { self.applyReaction(emoji, gv: gv, item: it, from: from) }
    }
    sh.onClose = { [weak self] in self?.closeEmojiSheet() }
    view.addSubview(sh)
    emojiSheet = sh
    sh.present(reduce: MVMotion.reduceMotion)
  }

  private func closeEmojiSheet() {
    guard let sh = emojiSheet else { return }
    emojiSheet = nil
    sh.dismiss(reduce: MVMotion.reduceMotion)
    removePause("picker")
  }

  /// Itens da bolha: coração + fileira rápida (+ "+").
  private func bubbleItems() -> [String] {
    let heart = reactions.first(where: { $0.kind == "heart" })?.emoji ?? "\u{2764}\u{FE0F}"
    var out = [heart]
    for r in reactions where !out.contains(r.emoji) { out.append(r.emoji) }
    if pickerEnabled { out.append(SVReactBubble.more) }
    return out
  }

  func groupViewHoldLike(_ gv: SVGroupView, gesture g: UILongPressGestureRecognizer) {
    guard reactionHold, gv === currentPage, !closed else { return }
    let p = g.location(in: view)
    switch g.state {
    case .began:
      guard let item = gv.currentItem, !gv.group.isSelf, reactBubble == nil else { return }
      UIImpactFeedbackGenerator(style: .medium).impactOccurred()
      addPause("react")
      pager.isScrollEnabled = false
      let bb = SVReactBubble(items: bubbleItems(), mine: item.myReaction)
      let sz = bb.preferredSize
      let w = view.bounds.width
      let anchor = gv.likeFrame(in: view)
      let bw = min(sz.width, w - 16)
      var x = anchor.maxX - bw
      x = max(8, min(w - bw - 8, x))
      let y = max(view.safeAreaInsets.top + 8, anchor.minY - sz.height - 14)
      bb.frame = CGRect(x: x, y: y, width: bw, height: sz.height)
      // toque fora fecha (modo "tocar" quando o dedo saiu sem escolher)
      let catcher = UIControl(frame: view.bounds)
      catcher.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      catcher.addTarget(self, action: #selector(bubbleCatcherTap(_:event:)), for: .touchUpInside)
      view.addSubview(catcher)
      bubbleCatcher = catcher
      bb.isUserInteractionEnabled = false // toques vão p/ o catcher (modo tocar)
      view.addSubview(bb)
      reactBubble = bb
      bubbleStartedOnHeart = true
      bubbleTapMode = false
      bb.present(reduce: MVMotion.reduceMotion)
    case .changed:
      guard let bb = reactBubble, !bubbleTapMode else { return }
      let lp = view.convert(p, to: bb)
      let idx = bb.index(at: lp)
      if idx != nil { bubbleStartedOnHeart = false }
      bb.setHighlighted(idx, reduce: MVMotion.reduceMotion)
    case .ended:
      guard let bb = reactBubble, !bubbleTapMode else { return }
      if let i = bb.highlighted {
        pickFromBubble(i)
      } else if bubbleStartedOnHeart {
        // soltou sem deslizar: a bolha fica aberta p/ escolher com toque
        bubbleTapMode = true
      } else {
        closeBubble()
      }
    case .cancelled, .failed:
      if !bubbleTapMode { closeBubble() }
    default:
      break
    }
  }

  @objc private func bubbleCatcherTap(_ sender: UIControl, event: UIEvent) {
    guard let bb = reactBubble else { closeBubble(); return }
    if let t = event.allTouches?.first {
      let lp = t.location(in: bb)
      if bb.bounds.insetBy(dx: 0, dy: -12).contains(lp), let i = bb.index(at: lp) {
        bb.setHighlighted(i, reduce: true)
        pickFromBubble(i)
        return
      }
    }
    closeBubble()
  }

  private func pickFromBubble(_ i: Int) {
    guard let bb = reactBubble, i >= 0, i < bb.items.count else { closeBubble(); return }
    let emoji = bb.items[i]
    let from = bb.centerOf(i, in: view)
    if emoji == SVReactBubble.more {
      addPause("picker")
      closeBubble()
      openEmojiSheet()
      return
    }
    closeBubble()
    if let gv = currentPage, let item = gv.currentItem { applyReaction(emoji, gv: gv, item: item, from: from) }
  }

  private func closeBubble() {
    bubbleCatcher?.removeFromSuperview()
    bubbleCatcher = nil
    bubbleTapMode = false
    pager.isScrollEnabled = true
    if let bb = reactBubble {
      reactBubble = nil
      bb.dismiss(reduce: MVMotion.reduceMotion)
    }
    removePause("react")
  }

  private func burst(_ kind: String, at point: CGPoint? = nil, glyph: String? = nil) {
    guard let img = (glyph.flatMap { SVIcons.emoji($0, size: 110) }) ?? SVIcons.reaction(kind, size: 110) else { return }
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
    // [2026-10-18 status-telegram] Rostos de quem viu na pílula do próprio status.
    if !loading { for (_, p) in pages where p.group.isSelf && p.currentItem?.id == id { p.refreshCounters() } }
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
    // [2026-10-17 status-reacoes] emoji real (qualquer um); kind = reserva vetorial
    let rem = (row["emoji"] as? String) ?? ""
    if !rem.isEmpty, let em = SVIcons.emoji(rem, size: 26) {
      cell.reaction.image = em
    } else {
      cell.reaction.image = kind.isEmpty ? nil : SVIcons.reaction(kind, size: 22)
    }
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
    if isZoomed { resetZoom(animated: false) } // [status-zoom]
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
    if animated && reason != "replaced" && tryOriginClose(reason: reason) { return }
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
