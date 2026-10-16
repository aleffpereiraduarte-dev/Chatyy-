import AVFoundation
import ExpoModulesCore
import UIKit

// [2026-10-15 native-reels] ChatyyReelsFeed — feed vertical nível TikTok.
//   • UICollectionView paginada (1 reel por tela, snap nativo do UIScrollView);
//   • pool FIXO de 3 AVPlayer (anterior/atual/próximo) com pré-buffer: ao
//     parar o scroll o atual já tem o 1º quadro decodificado e toca na hora;
//   • reels 2–3 posições à frente baixados inteiros p/ disco (RFVideoCache);
//   • loop, toque = mudo/som, segurar = pausa com tela limpa, duplo toque =
//     curtir com coração (Core Animation), barra fina com arrastar p/ buscar;
//   • trilho de ações nativo → eventos p/ o JS (comentários/presentes/
//     compartilhar/menu abrem as sheets JS existentes).
// Sinais de recomendação: onViewProgress {id, watchedMs, completed, loops,
// durationMs} quando a impressão termina (troca de reel, pausa externa,
// 2º plano, saiu da janela) — o JS repassa a trackReelView como antes.

private final class RFLinkProxy: NSObject {
  weak var target: RFFeedView?
  init(_ t: RFFeedView) { target = t }
  @objc func tick(_ link: CADisplayLink) { target?.tick(link) }
}

/// Delegate dos gestos fora da view (UIView já tem gestureRecognizerShouldBegin).
private final class RFGestureGate: NSObject, UIGestureRecognizerDelegate {
  weak var feed: RFFeedView?

  func gestureRecognizer(_ g: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    return feed?.gestureShouldReceive(g, touch) ?? false
  }

  func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
    return feed?.gestureShouldBegin(g) ?? false
  }
}

public final class RFFeedView: ExpoView, UICollectionViewDataSource, UICollectionViewDelegateFlowLayout {
  let onReady = EventDispatcher()
  let onNativeError = EventDispatcher()
  let onIndexChange = EventDispatcher()
  let onLike = EventDispatcher()
  let onComment = EventDispatcher()
  let onGift = EventDispatcher()
  let onShare = EventDispatcher()
  let onSave = EventDispatcher()
  let onFollow = EventDispatcher()
  let onAuthorPress = EventDispatcher()
  let onMore = EventDispatcher()
  let onMusicPress = EventDispatcher()
  let onCreditPress = EventDispatcher()
  let onLikersPress = EventDispatcher()
  let onNeedMore = EventDispatcher()
  let onViewProgress = EventDispatcher()
  let onMuteChange = EventDispatcher()
  let onRefresh = EventDispatcher()
  let onPlaybackError = EventDispatcher()

  private let flow = UICollectionViewFlowLayout()
  private var cv: UICollectionView!
  private let pool = RFPlayerPool()
  private let gate = RFGestureGate()
  private let refreshSpinner = UIActivityIndicatorView(style: .medium)

  private var items: [RFItem] = []
  private var index = 0
  private var currentId = ""
  private var pendingIndex: Int?
  private var lastSize = CGSize.zero
  private var readySent = false
  private var needMoreAt = -1

  // props
  private var labels = RFLabels()
  private var muted = false
  private var propPaused = false
  private var methodPaused = false
  private var holding = false
  private var scrubbing = false
  private var rate: Float = 1
  private var captionsEnabled = true
  private var bottomInset: CGFloat = 0
  private var topInset: CGFloat = 0
  private var refreshEnabled = false
  private var refreshing = false

  // impressão / relógio
  private var link: CADisplayLink?
  private var lastTick: CFTimeInterval = 0
  private var stallSince: CFTimeInterval = 0
  /// [2026-10-16 reels-rail-v2] relógio do vídeo no tick anterior: se o tempo andou,
  /// o vídeo ESTÁ tocando — nunca mostra "carregando" (spinner preso com vídeo rodando).
  private var lastPlayhead: Double = -1
  private var lastPlayheadId = ""
  private var bufferTick = 0
  private var impId = ""
  private var impMs: Double = 0
  private var impCompleted = false
  private var impLoops = 0
  private var wasPlaying = false
  private var observers: [NSObjectProtocol] = []
  private let haptic = UIImpactFeedbackGenerator(style: .light)

  private var singleTap: UITapGestureRecognizer!
  private var doubleTap: UITapGestureRecognizer!
  private var longPress: UILongPressGestureRecognizer!
  private var scrub: UIPanGestureRecognizer!

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .black
    clipsToBounds = true

    flow.scrollDirection = .vertical
    flow.minimumLineSpacing = 0
    flow.minimumInteritemSpacing = 0
    flow.sectionInset = .zero
    cv = UICollectionView(frame: bounds, collectionViewLayout: flow)
    cv.backgroundColor = .black
    cv.isPagingEnabled = true
    cv.decelerationRate = .fast
    cv.showsVerticalScrollIndicator = false
    cv.showsHorizontalScrollIndicator = false
    cv.contentInsetAdjustmentBehavior = .never
    cv.scrollsToTop = false
    cv.alwaysBounceVertical = true
    cv.isPrefetchingEnabled = false
    cv.delaysContentTouches = false
    cv.dataSource = self
    cv.delegate = self
    cv.register(RFCell.self, forCellWithReuseIdentifier: RFCell.reuseId)
    addSubview(cv)

    refreshSpinner.color = .white
    refreshSpinner.hidesWhenStopped = false
    refreshSpinner.alpha = 0
    addSubview(refreshSpinner)

    gate.feed = self
    doubleTap = UITapGestureRecognizer(target: self, action: #selector(handleDoubleTap(_:)))
    doubleTap.numberOfTapsRequired = 2
    doubleTap.delegate = gate
    singleTap = UITapGestureRecognizer(target: self, action: #selector(handleSingleTap(_:)))
    singleTap.require(toFail: doubleTap)
    singleTap.delegate = gate
    longPress = UILongPressGestureRecognizer(target: self, action: #selector(handleLongPress(_:)))
    longPress.minimumPressDuration = 0.28
    longPress.delegate = gate
    scrub = UIPanGestureRecognizer(target: self, action: #selector(handleScrub(_:)))
    scrub.delegate = gate
    scrub.maximumNumberOfTouches = 1
    for g in [doubleTap!, singleTap!, longPress!, scrub!] as [UIGestureRecognizer] { cv.addGestureRecognizer(g) }
    cv.panGestureRecognizer.require(toFail: scrub)

    pool.onReady = { [weak self] s in self?.slotReady(s) }
    pool.onEnd = { [weak self] s in self?.slotEnded(s) }
    pool.onFail = { [weak self] s in self?.slotFailed(s) }

    let nc = NotificationCenter.default
    observers.append(nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      self?.enterBackground()
    })
    observers.append(nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      self?.updatePlayback()
    })
    observers.append(nc.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main) { [weak self] _ in
      self?.trimForMemory()
    })
  }

  deinit {
    link?.invalidate()
    for o in observers { NotificationCenter.default.removeObserver(o) }
    pool.releaseAll()
  }

  // MARK: - Props

  func setLabels(_ d: [String: Any]) {
    labels = RFLabels(d)
    reconfigureVisible()
  }

  func setMuted(_ v: Bool) {
    if v == muted { return }
    muted = v
    updatePlayback()
  }

  func setPaused(_ v: Bool) {
    if v == propPaused { return }
    propPaused = v
    updatePlayback()
  }

  func setRate(_ v: Double?) {
    let r = Float(max(0.25, min(3, v ?? 1)))
    if r == rate { return }
    rate = r
    updatePlayback()
  }

  func setCaptionsEnabled(_ v: Bool) {
    captionsEnabled = v
    if !v { for c in visibleFeedCells() { c.setSubtitle("") } }
  }

  func setInsets(_ d: [String: Any]) {
    let b = CGFloat(RFItem.num(d["bottom"]))
    let t = CGFloat(RFItem.num(d["top"]))
    if b == bottomInset && t == topInset { return }
    bottomInset = max(0, b)
    topInset = max(0, t)
    reconfigureVisible()
    setNeedsLayout()
  }

  func setImageHeaders(_ d: [String: Any]) {
    var h: [String: String] = [:]
    for (k, v) in d { if let s = v as? String, !s.isEmpty { h[k] = s } }
    RFImageLoader.shared.authHeaders = h
  }

  func setRefreshEnabled(_ v: Bool) {
    refreshEnabled = v
  }

  func setRefreshing(_ v: Bool) {
    refreshing = v
    if v {
      refreshSpinner.startAnimating()
      refreshSpinner.alpha = 1
    } else {
      UIView.animate(withDuration: 0.2, animations: { self.refreshSpinner.alpha = 0 }) { _ in
        if !self.refreshing { self.refreshSpinner.stopAnimating() }
      }
    }
  }

  // MARK: - Métodos (JS)

  func play() {
    methodPaused = false
    updatePlayback()
  }

  func pause() {
    methodPaused = true
    updatePlayback()
  }

  func scrollTo(_ i: Int, animated: Bool) {
    guard !items.isEmpty else { return }
    let t = max(0, min(items.count - 1, i))
    let h = cv.bounds.height
    guard h > 1 else { pendingIndex = t; return }
    cv.setContentOffset(CGPoint(x: 0, y: CGFloat(t) * h), animated: animated)
    if !animated { settle(force: false) }
  }

  func applyItems(_ payload: [String: Any]) {
    let op = (payload["op"] as? String) ?? "reset"
    let raw = (payload["items"] as? [Any]) ?? []
    switch op {
    case "append":
      var seen = Set(items.map { $0.id })
      var add: [RFItem] = []
      for r in raw {
        guard let d = r as? [String: Any], let it = RFItem(d), !seen.contains(it.id) else { continue }
        seen.insert(it.id)
        add.append(it)
      }
      guard !add.isEmpty else { return }
      let start = items.count
      items.append(contentsOf: add)
      if start > 0 && cv.numberOfItems(inSection: 0) == start {
        let ips = (start..<items.count).map { IndexPath(item: $0, section: 0) }
        UIView.performWithoutAnimation { cv.insertItems(at: ips) }
      } else {
        cv.reloadData()
      }
      if start == 0 { applyOffset(index) }
      settle(force: start == 0)

    case "update":
      for r in raw {
        guard let d = r as? [String: Any], let id = RFItem.str(d["id"]),
              let it = items.first(where: { $0.id == id }) else { continue }
        let oldKey = it.mediaKey
        it.apply(d)
        if let c = cell(for: id) { c.configure(it, labels: labels, bottomInset: bottomInset) }
        if it.mediaKey != oldKey, pool.slot(for: id) != nil {
          pool.reload(it)
          rebindVisible()
          if id == currentId { updatePlayback() }
        }
      }

    case "remove":
      let ids = Set(((payload["ids"] as? [Any]) ?? []).compactMap { RFItem.str($0) })
      guard !ids.isEmpty else { return }
      if ids.contains(currentId) {
        endImpression()
        currentId = ""
      }
      var newIndex = index
      if let keep = items.indices.first(where: { $0 == index }), !ids.contains(items[keep].id) {
        let keptId = items[keep].id
        items.removeAll { ids.contains($0.id) }
        newIndex = items.firstIndex { $0.id == keptId } ?? 0
      } else {
        let before = items.prefix(index).filter { ids.contains($0.id) }.count
        items.removeAll { ids.contains($0.id) }
        newIndex = index - before
      }
      for s in pool.slots where ids.contains(s.itemId) { pool.clear(s) }
      index = max(0, min(items.count - 1, newIndex))
      cv.reloadData()
      applyOffset(index)
      settle(force: true)

    default: // reset
      endImpression()
      var seen = Set<String>()
      var list: [RFItem] = []
      for r in raw {
        guard let d = r as? [String: Any], let it = RFItem(d), !seen.contains(it.id) else { continue }
        seen.insert(it.id)
        list.append(it)
      }
      items = list
      pool.pauseAll()
      for s in pool.slots where !s.itemId.isEmpty && !seen.contains(s.itemId) { pool.clear(s) }
      currentId = ""
      needMoreAt = -1
      let start = Int(RFItem.num(payload["startIndex"]))
      index = items.isEmpty ? 0 : max(0, min(items.count - 1, start))
      cv.reloadData()
      applyOffset(index)
      settle(force: true)
    }
  }

  // MARK: - Layout

  public override func layoutSubviews() {
    super.layoutSubviews()
    let size = bounds.size
    guard size.width > 1, size.height > 1 else { return }
    refreshSpinner.center = CGPoint(x: size.width / 2, y: topInset + 22)
    if size != lastSize {
      let keep = pendingIndex ?? index
      lastSize = size
      cv.frame = bounds
      flow.itemSize = size
      flow.invalidateLayout()
      cv.layoutIfNeeded()
      pendingIndex = nil
      applyOffset(keep)
      if !readySent {
        readySent = true
        onReady(["width": Double(size.width), "height": Double(size.height)])
      }
      settle(force: true)
    } else if let p = pendingIndex {
      pendingIndex = nil
      applyOffset(p)
      settle(force: false)
    }
  }

  private func applyOffset(_ i: Int) {
    let h = cv.bounds.height
    guard h > 1 else { pendingIndex = i; return }
    cv.layoutIfNeeded()
    let y = CGFloat(max(0, i)) * h
    if abs(cv.contentOffset.y - y) > 0.5 { cv.setContentOffset(CGPoint(x: 0, y: y), animated: false) }
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      stopLink()
      endImpression()
      pool.pauseAll()
      wasPlaying = false
    } else {
      if !readySent {
        readySent = true
        onReady(["width": Double(bounds.width), "height": Double(bounds.height)])
      }
      startLink()
      updatePlayback()
    }
  }

  // MARK: - Data source / delegate

  public func numberOfSections(in collectionView: UICollectionView) -> Int { return 1 }

  public func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
    return items.count
  }

  public func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
    let cell = collectionView.dequeueReusableCell(withReuseIdentifier: RFCell.reuseId, for: indexPath)
    guard let c = cell as? RFCell, indexPath.item < items.count else { return cell }
    let it = items[indexPath.item]
    c.onAction = { [weak self] name, cc in self?.handleAction(name, cc) }
    c.configure(it, labels: labels, bottomInset: bottomInset)
    c.attach(pool.slot(for: it.id)?.player)
    return c
  }

  public func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout, sizeForItemAt indexPath: IndexPath) -> CGSize {
    let s = collectionView.bounds.size
    return CGSize(width: max(1, s.width), height: max(1, s.height))
  }

  public func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
    guard let c = cell as? RFCell, let it = c.item else { return }
    c.attach(pool.slot(for: it.id)?.player)
  }

  public func scrollViewDidScroll(_ scrollView: UIScrollView) {
    if !refreshing {
      let pull = -scrollView.contentOffset.y
      refreshSpinner.alpha = refreshEnabled && index == 0 && pull > 8 ? min(1, pull / 72) : 0
    }
  }

  public func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    if refreshEnabled && !refreshing && scrollView.contentOffset.y < -72 {
      setRefreshing(true)
      onRefresh([:])
    }
    if !decelerate { settle(force: false) }
  }

  public func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
    settle(force: false)
  }

  public func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
    settle(force: false)
  }

  // MARK: - Página atual

  private func pageIndex() -> Int {
    let h = cv.bounds.height
    guard h > 1, !items.isEmpty else { return 0 }
    let i = Int((cv.contentOffset.y / h).rounded())
    return max(0, min(items.count - 1, i))
  }

  private func settle(force: Bool) {
    guard !items.isEmpty else {
      endImpression()
      pool.pauseAll()
      currentId = ""
      return
    }
    guard cv.bounds.height > 1 else { return }
    let i = pageIndex()
    let id = items[i].id
    if !force && id == currentId { index = i; updatePlayback(); return }
    let changed = id != currentId
    if changed {
      endImpression()
      leaveCurrent()
    }
    index = i
    currentId = id
    let window = [i, i + 1, i - 1].filter { $0 >= 0 && $0 < items.count }.map { items[$0] }
    pool.assign(window, currentId: id)
    rebindVisible()
    if let c = currentCell(), let s = pool.slot(for: id) { c.setError(s.failed) }
    if changed {
      wasPlaying = false
      onIndexChange(["index": i, "id": id])
    }
    updatePlayback()
    prefetchAhead()
    checkNeedMore()
  }

  private func leaveCurrent() {
    guard let s = pool.slot(for: currentId) else { return }
    s.player.pause()
    s.player.isMuted = true
    s.player.seek(to: .zero)
    if let c = cell(for: currentId) {
      c.setProgress(0)
      c.setBuffering(false)
      c.setSubtitle("")
    }
  }

  private var externallyPaused: Bool {
    return propPaused || methodPaused || window == nil || UIApplication.shared.applicationState == .background
  }

  private func updatePlayback() {
    guard let s = pool.slot(for: currentId) else { return }
    let play = !externallyPaused && !holding && !scrubbing && !s.failed
    s.player.isMuted = muted
    if play {
      if !wasPlaying && !muted { RFFeedView.ensureAudioSession() }
      if s.player.rate != rate { s.player.rate = rate }
      wasPlaying = true
      startLink()
    } else {
      if s.player.rate != 0 { s.player.pause() }
      wasPlaying = false
      if externallyPaused { endImpression() }
    }
  }

  private func prefetchAhead() {
    var keep = Set<String>()
    for k in [2, 3] {
      let j = index + k
      // HLS fica com o buffer do AVPlayer; só MP4 progressivo vai p/ disco.
      if j < items.count, items[j].hlsUrl.isEmpty, RFVideoCache.isCacheable(items[j].videoUrl) { keep.insert(items[j].videoUrl) }
    }
    RFVideoCache.shared.cancel(except: keep)
    for u in keep { RFVideoCache.shared.prefetch(u) }
    let px = max(UIScreen.main.bounds.width, 1) * UIScreen.main.scale
    for k in 1...3 {
      let j = index + k
      guard j < items.count else { break }
      RFImageLoader.shared.prefetch(items[j].thumb, maxPixel: px)
      RFImageLoader.shared.prefetch(items[j].avatar, maxPixel: 144)
    }
  }

  private func checkNeedMore() {
    guard !items.isEmpty else { return }
    if index >= items.count - 4 && needMoreAt != items.count {
      needMoreAt = items.count
      onNeedMore(["index": index, "count": items.count])
    }
  }

  // MARK: - Pool callbacks

  private func slotReady(_ s: RFPlayerSlot) {
    if let it = items.first(where: { $0.id == s.itemId }), it.width <= 0,
       let size = s.player.currentItem?.presentationSize, size.width > 0, size.height > 0 {
      it.width = Double(size.width)
      it.height = Double(size.height)
      cell(for: it.id)?.applyAspect(width: it.width, height: it.height)
    }
    if s.itemId == currentId { updatePlayback() }
  }

  private func slotEnded(_ s: RFPlayerSlot) {
    s.loops += 1
    if s.itemId == currentId {
      if impId == s.itemId {
        impCompleted = true
        impLoops += 1
      }
      s.player.seek(to: .zero, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
        DispatchQueue.main.async { self?.updatePlayback() }
      }
    } else {
      s.player.pause()
      s.player.seek(to: .zero)
    }
  }

  private func slotFailed(_ s: RFPlayerSlot) {
    let id = s.itemId
    // Arquivo do cache corrompido → apaga e tenta a rede uma vez.
    if let u = (s.player.currentItem?.asset as? AVURLAsset)?.url, u.isFileURL,
       u.path.contains("chatyy-reels-video"), let it = items.first(where: { $0.id == id }) {
      try? FileManager.default.removeItem(at: u)
      pool.load(s, it)
      rebindVisible()
      if id == currentId { updatePlayback() }
      return
    }
    cell(for: id)?.setError(true)
    if id == currentId {
      endImpression()
      onPlaybackError(["id": id])
    }
  }

  // MARK: - Relógio (progresso, legenda, impressão, spinner)

  private func startLink() {
    if link != nil || window == nil { return }
    let l = CADisplayLink(target: RFLinkProxy(self), selector: #selector(RFLinkProxy.tick(_:)))
    l.preferredFramesPerSecond = 30
    l.add(to: .main, forMode: .common)
    link = l
    lastTick = 0
  }

  private func stopLink() {
    link?.invalidate()
    link = nil
    lastTick = 0
  }

  fileprivate func tick(_ l: CADisplayLink) {
    let now = l.timestamp
    let dt = lastTick > 0 ? now - lastTick : 0
    lastTick = now
    guard let s = pool.slot(for: currentId), let c = currentCell(), let it = c.item, it.id == currentId else { return }
    let p = s.player
    let dur = s.durationSeconds
    let cur = s.currentSeconds
    if dur > 0 { c.setProgress(CGFloat(cur / dur)) }
    let shown = c.boundPlayer ?? p
    let head = CMTimeGetSeconds(shown.currentTime())
    let advancing = head.isFinite && lastPlayheadId == currentId && lastPlayhead >= 0 && abs(head - lastPlayhead) > 0.004
    lastPlayhead = head.isFinite ? head : -1
    lastPlayheadId = currentId
    if labels.v2 && dur > 0 {
      bufferTick += 1
      if bufferTick % 8 == 1, let ranges = p.currentItem?.loadedTimeRanges {
        var end = 0.0
        for v in ranges {
          let r = v.timeRangeValue
          let st = CMTimeGetSeconds(r.start)
          let en = CMTimeGetSeconds(CMTimeRangeGetEnd(r))
          if st.isFinite, en.isFinite, st <= cur + 0.5, en > end { end = en }
        }
        c.setBuffered(CGFloat(end / dur))
      }
    }
    if p.timeControlStatus == .playing {
      if impId != currentId {
        impId = currentId
        impMs = 0
        impCompleted = false
        impLoops = 0
      }
      if dt > 0 && dt < 0.5 { impMs += dt * 1000 }
      stallSince = 0
      c.setBuffering(false)
    } else if p.timeControlStatus == .waitingToPlayAtSpecifiedRate && !s.failed && !advancing {
      if stallSince == 0 { stallSince = now }
      c.setBuffering(now - stallSince > 0.45)
    } else {
      stallSince = 0
      c.setBuffering(false)
    }
    c.setSubtitle(captionsEnabled ? it.subtitle(at: cur) : "")
  }

  private func endImpression() {
    guard !impId.isEmpty else { return }
    let id = impId
    let ms = impMs
    let done = impCompleted
    let loops = impLoops
    impId = ""
    impMs = 0
    impCompleted = false
    impLoops = 0
    if ms < 1 && !done { return }
    var dur = items.first(where: { $0.id == id })?.durationMs ?? 0
    if dur <= 0, let s = pool.slot(for: id) { dur = s.durationSeconds * 1000 }
    onViewProgress(["id": id, "watchedMs": Int(ms.rounded()), "completed": done, "loops": loops, "durationMs": Int(dur.rounded())])
  }

  private func enterBackground() {
    endImpression()
    pool.pauseAll()
    wasPlaying = false
  }

  private func trimForMemory() {
    // Mantém só o atual; vizinhos recarregam no próximo settle.
    for s in pool.slots where !s.itemId.isEmpty && s.itemId != currentId { pool.clear(s) }
    rebindVisible()
  }

  // MARK: - Gestos

  fileprivate func gestureShouldReceive(_ g: UIGestureRecognizer, _ touch: UITouch) -> Bool {
    guard !items.isEmpty else { return false }
    let p = touch.location(in: cv)
    guard let ip = cv.indexPathForItem(at: p), let c = cv.cellForItem(at: ip) as? RFCell else { return false }
    return !c.isInteractive(touch.view)
  }

  fileprivate func gestureShouldBegin(_ g: UIGestureRecognizer) -> Bool {
    if g === scrub {
      guard !cv.isDragging, !cv.isDecelerating, let c = currentCell() else { return false }
      let p = scrub.location(in: c)
      guard c.progressRect.contains(p) else { return false }
      let v = scrub.velocity(in: c)
      return abs(v.x) > abs(v.y)
    }
    if g === longPress { return !cv.isDragging && !cv.isDecelerating }
    return true
  }

  private func feedCell(at g: UIGestureRecognizer) -> RFCell? {
    let p = g.location(in: cv)
    guard let ip = cv.indexPathForItem(at: p) else { return nil }
    return cv.cellForItem(at: ip) as? RFCell
  }

  @objc private func handleSingleTap(_ g: UITapGestureRecognizer) {
    muted.toggle()
    updatePlayback()
    feedCell(at: g)?.flash(symbol: muted ? "speaker.slash.fill" : "speaker.wave.2.fill")
    onMuteChange(["muted": muted])
  }

  @objc private func handleDoubleTap(_ g: UITapGestureRecognizer) {
    guard let c = feedCell(at: g), let it = c.item else { return }
    c.burstHeart(at: g.location(in: c))
    haptic.impactOccurred()
    if !it.liked {
      it.liked = true
      it.likes += 1
      c.refresh()
      c.likeBtn.pop()
      if labels.v2 { c.likeBtn.burst(color: RFCell.likeRed) }
      onLike(["id": it.id, "liked": true, "likes": it.likes, "source": "double_tap"])
    }
  }

  @objc private func handleLongPress(_ g: UILongPressGestureRecognizer) {
    switch g.state {
    case .began:
      holding = true
      updatePlayback()
      currentCell()?.setOverlayHidden(true, animated: true)
    case .ended, .cancelled, .failed:
      if holding {
        holding = false
        currentCell()?.setOverlayHidden(false, animated: true)
        updatePlayback()
      }
    default:
      break
    }
  }

  @objc private func handleScrub(_ g: UIPanGestureRecognizer) {
    guard let c = currentCell(), let s = pool.slot(for: currentId) else { return }
    let f = max(0, min(1, g.location(in: c).x / max(c.bounds.width, 1)))
    switch g.state {
    case .began:
      scrubbing = true
      c.setScrubbing(true, fraction: f)
      c.setScrubTime(Double(f) * s.durationSeconds, s.durationSeconds)
      updatePlayback()
    case .changed:
      c.setScrubbing(true, fraction: f)
      c.setScrubTime(Double(f) * s.durationSeconds, s.durationSeconds)
      seek(s, CGFloat(f), precise: false)
    case .ended, .cancelled, .failed:
      seek(s, CGFloat(f), precise: true)
      scrubbing = false
      c.setScrubbing(false, fraction: nil)
      updatePlayback()
    default:
      break
    }
  }

  private func seek(_ s: RFPlayerSlot, _ f: CGFloat, precise: Bool) {
    let dur = s.durationSeconds
    guard dur > 0 else { return }
    let t = CMTime(seconds: Double(f) * dur, preferredTimescale: 600)
    let tol = precise ? CMTime.zero : CMTime(seconds: 0.3, preferredTimescale: 600)
    s.player.seek(to: t, toleranceBefore: tol, toleranceAfter: tol)
  }

  // MARK: - Ações do trilho

  private func handleAction(_ name: String, _ c: RFCell) {
    guard let it = c.item else { return }
    let idx = items.firstIndex { $0 === it } ?? -1
    var body: [String: Any] = ["id": it.id, "index": idx]
    switch name {
    case "like":
      it.liked.toggle()
      it.likes = max(0, it.likes + (it.liked ? 1 : -1))
      c.refresh()
      c.likeBtn.pop()
      if it.liked {
        haptic.impactOccurred()
        if labels.v2 { c.likeBtn.burst(color: RFCell.likeRed) }
      }
      body["liked"] = it.liked
      body["likes"] = it.likes
      body["source"] = "button"
      onLike(body)
    case "save":
      it.saved.toggle()
      it.saves = max(0, it.saves + (it.saved ? 1 : -1))
      c.refresh()
      c.saveBtn.pop()
      body["saved"] = it.saved
      onSave(body)
    case "comment":
      if it.commentsDisabled { return }
      onComment(body)
    case "gift":
      onGift(body)
    case "share":
      onShare(body)
    case "more":
      onMore(body)
    case "author":
      onAuthorPress(body)
    case "follow":
      it.canFollow = false
      if labels.v2 { c.animateFollowed() }
      c.refresh()
      haptic.impactOccurred()
      onFollow(body)
    case "music":
      onMusicPress(body)
    case "credit":
      onCreditPress(body)
    case "likers":
      if it.likes > 0 { onLikersPress(body) }
    case "retry":
      c.setError(false)
      if let s = pool.slot(for: it.id) {
        pool.load(s, it)
        rebindVisible()
      } else {
        settle(force: true)
      }
      if it.id == currentId { updatePlayback() }
    default:
      break
    }
  }

  // MARK: - Helpers

  private func visibleFeedCells() -> [RFCell] {
    return cv.visibleCells.compactMap { $0 as? RFCell }
  }

  private func currentCell() -> RFCell? {
    guard index < items.count else { return nil }
    return cv.cellForItem(at: IndexPath(item: index, section: 0)) as? RFCell
  }

  private func cell(for id: String) -> RFCell? {
    return visibleFeedCells().first { $0.item?.id == id }
  }

  private func rebindVisible() {
    for c in visibleFeedCells() {
      guard let id = c.item?.id else { continue }
      c.attach(pool.slot(for: id)?.player)
    }
  }

  private func reconfigureVisible() {
    for c in visibleFeedCells() {
      guard let it = c.item else { continue }
      c.configure(it, labels: labels, bottomInset: bottomInset)
    }
  }

  /// Som do reel respeita a chave de silencioso como TikTok (categoria
  /// .playback). Nunca mexe numa sessão de chamada/gravação ativa.
  static func ensureAudioSession() {
    let s = AVAudioSession.sharedInstance()
    let cat = s.category
    if cat == .playAndRecord || cat == .record || cat == .multiRoute { return }
    if cat != .playback {
      try? s.setCategory(.playback, mode: .moviePlayback, options: [])
    }
    try? s.setActive(true, options: [])
  }
}

extension RFFeedView {
  /// Sem isso o UICollectionView exige UICollectionViewDelegate explícito.
  public func collectionView(_ collectionView: UICollectionView, shouldSelectItemAt indexPath: IndexPath) -> Bool { return false }
}
