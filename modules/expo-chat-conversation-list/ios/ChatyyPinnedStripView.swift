import ExpoModulesCore
import UIKit

// [2026-10-15 native-pins] Fileira de conversas FIXADAS em nativo (topo da
// home). UICollectionView horizontal com avatares grandes (mesmo CLAvatarView
// da lista: foto/colagem, anel de status, bolinha online), contador de não
// lidas, balão "digitando", entrada com spring escalonado.
//
//  - Toque longo = MESMO menu da lista (CLMenuBuilder) + prévia da conversa
//    (CLPeekController); arrastar a partir do toque longo reordena (drag &
//    drop do UICollectionView: os outros abrem espaço sozinhos).
//  - "Reorganizar fixados" (menu) → modo reorganizar: tremem, sem menu,
//    arrastar começa rápido (movimento interativo); toque sai do modo.
//  - Tamanho é automático (o JS manda `avatarSize`): ≤ 4 fixados = colunas
//    largas e avatares grandes; mais que isso = menores e rolagem.
//
// Props:  items [CLRow…], dark, labels, folders, peek, avatarSize,
//         reorderMode, selectionMode, menuEnabled, authToken
// Events: onPinPress, onPinPressIn, onPinAction, onPinLongPress,
//         onPeekRequest, onPeekOpen, onReorder {ids}, onReorderDone,
//         onNativeError

final class CLPinCell: UICollectionViewCell {
  /// Recebe o tremor do modo reorganizar (animação aditiva na layer).
  let lift = UIView()
  /// Recebe o "afundar" do toque e o "levantar" do arrasto.
  let avatarWrap = UIView()
  let avatar = CLAvatarView()
  private let badge = CLPillView()
  private let typingBubble = UIView()
  private let typingDots = CLTypingDots()
  private let smartBadge = UIImageView()
  private let selRing = CAShapeLayer()
  private let nameLabel = UILabel()
  private let unpinButton = UIButton(type: .custom)
  private(set) var rowId = ""
  private var lastUnread = 0
  private var size: CGFloat = 72
  private var theme = CLTheme(dark: false)
  private var wasTyping = false
  private var lifted = false
  var onUnpin: ((String) -> Void)?

  static let topPad: CGFloat = 8

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.clipsToBounds = false
    clipsToBounds = false
    contentView.addSubview(lift)
    lift.clipsToBounds = false
    lift.addSubview(avatarWrap)
    avatarWrap.clipsToBounds = false
    avatarWrap.addSubview(avatar)
    avatarWrap.layer.addSublayer(selRing)
    selRing.fillColor = UIColor.clear.cgColor
    selRing.lineWidth = 2.5
    selRing.isHidden = true
    smartBadge.contentMode = .center
    smartBadge.layer.borderWidth = 2
    smartBadge.clipsToBounds = true
    smartBadge.isHidden = true
    avatarWrap.addSubview(smartBadge)
    typingBubble.layer.borderWidth = 2
    typingBubble.isHidden = true
    typingBubble.addSubview(typingDots)
    avatarWrap.addSubview(typingBubble)
    badge.layer.borderWidth = 2
    badge.isHidden = true
    avatarWrap.addSubview(badge)
    unpinButton.isHidden = true
    unpinButton.layer.borderWidth = 1.5
    unpinButton.addTarget(self, action: #selector(unpinTapped), for: .touchUpInside)
    avatarWrap.addSubview(unpinButton)
    nameLabel.textAlignment = .center
    nameLabel.lineBreakMode = .byTruncatingTail
    nameLabel.numberOfLines = 1
    nameLabel.adjustsFontForContentSizeCategory = false
    lift.addSubview(nameLabel)
    isAccessibilityElement = true
    accessibilityTraits = .button
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  @objc private func unpinTapped() {
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    onUnpin?(rowId)
  }

  func configure(_ r: CLRow, theme: CLTheme, labels: CLLabels, size: CGFloat, reorderMode: Bool) {
    let sameRow = r.id == rowId
    rowId = r.id
    self.theme = theme
    if self.size != size { self.size = size; setNeedsLayout() }
    var ar = r
    ar.note = "" // a nota (balão Instagram) fica só na linha
    avatar.boxSize = size
    avatar.configure(ar, theme: theme, rowBackground: theme.bg)

    // Contador de não lidas (P&B; silenciada = cinza) ou "@".
    let count = r.unread
    if count > 0 || r.mention {
      badge.isHidden = false
      badge.backgroundColor = r.muted ? theme.mutedPillBg : theme.pillBg
      badge.label.textColor = r.muted ? theme.mutedPillTxt : theme.pillTxt
      badge.label.font = UIFont.monospacedDigitSystemFont(ofSize: 12, weight: .bold)
      badge.label.text = count > 0 ? (count > 99 ? "99+" : String(count)) : "@"
      badge.layer.borderColor = theme.bg.cgColor
      if sameRow && count > lastUnread && window != nil { badge.pop() }
    } else {
      badge.isHidden = true
    }
    lastUnread = count

    // Balão "digitando" (só quando ninguém trancou a conversa).
    let typing = r.isTyping && !r.locked
    typingBubble.backgroundColor = theme.card
    typingBubble.layer.borderColor = theme.bg.cgColor
    typingDots.color = theme.text
    if typing {
      typingBubble.isHidden = false
      typingDots.start()
      if !(sameRow && wasTyping) && window != nil {
        typingBubble.transform = CGAffineTransform(scaleX: 0.3, y: 0.3)
        typingBubble.alpha = 0
        UIView.animate(withDuration: 0.45, delay: 0, usingSpringWithDamping: 0.6, initialSpringVelocity: 0.6,
                       options: [.allowUserInteraction, .beginFromCurrentState], animations: {
          self.typingBubble.transform = .identity
          self.typingBubble.alpha = 1
        })
      }
    } else {
      typingDots.stop()
      typingBubble.isHidden = true
      typingBubble.transform = .identity
      typingBubble.alpha = 1
    }
    wasTyping = typing

    // Fixada "inteligente" (ativa por uso): brilho discreto no canto.
    smartBadge.isHidden = !r.smart
    if r.smart {
      smartBadge.backgroundColor = theme.pillBg
      smartBadge.layer.borderColor = theme.bg.cgColor
      smartBadge.image = CLSymbols.image("sparkles", pointSize: 9, weight: .semibold, color: theme.pillTxt)
    }

    selRing.strokeColor = theme.text.cgColor
    selRing.isHidden = !r.selected

    unpinButton.isHidden = !reorderMode
    unpinButton.backgroundColor = theme.dark ? UIColor(clHex: 0x1C1C1E) : .white
    unpinButton.layer.borderColor = (theme.dark ? UIColor(white: 1, alpha: 0.2) : UIColor(white: 0, alpha: 0.12)).cgColor
    unpinButton.setImage(CLSymbols.image("xmark", pointSize: 9, weight: .bold, color: theme.text), for: .normal)
    unpinButton.accessibilityLabel = labels.get("unpin", "Desafixar")

    nameLabel.text = r.title
    nameLabel.textColor = theme.text
    let weight: UIFont.Weight = (count > 0 && !r.muted) ? .semibold : .medium
    nameLabel.font = CLFonts.scaled(12, weight, cap: 1.2, traits: traitCollection)

    accessibilityLabel = r.a11y.isEmpty ? r.title : r.a11y
    var custom: [UIAccessibilityCustomAction] = []
    if reorderMode {
      custom.append(UIAccessibilityCustomAction(name: labels.get("unpin", "Desafixar"), target: self, selector: #selector(a11yUnpin)))
    }
    accessibilityCustomActions = custom
    setNeedsLayout()
  }

  @objc private func a11yUnpin() -> Bool {
    onUnpin?(rowId)
    return true
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = contentView.bounds
    if lift.bounds.size != b.size {
      lift.bounds = CGRect(origin: .zero, size: b.size)
    }
    lift.center = CGPoint(x: b.midX, y: b.midY)
    let s = size
    let top = CLPinCell.topPad
    // avatarWrap: frame só via bounds/center (o transform do toque fica intacto).
    avatarWrap.bounds = CGRect(x: 0, y: 0, width: s, height: s)
    avatarWrap.center = CGPoint(x: b.width / 2, y: top + s / 2)
    avatar.frame = CGRect(x: 0, y: 0, width: s, height: s)
    let rp = UIBezierPath(ovalIn: CGRect(x: -4, y: -4, width: s + 8, height: s + 8))
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    selRing.frame = avatarWrap.bounds
    selRing.path = rp.cgPath
    CATransaction.commit()
    if !badge.isHidden {
      let bs = badge.size(height: 22)
      badge.frame = CGRect(x: s - bs.width + 6, y: -4, width: bs.width, height: bs.height)
    }
    let tw: CGFloat = 34
    let th: CGFloat = 20
    typingBubble.bounds = CGRect(x: 0, y: 0, width: tw, height: th)
    typingBubble.center = CGPoint(x: tw / 2 - 6, y: th / 2 - 4)
    typingBubble.layer.cornerRadius = th / 2
    typingDots.frame = CGRect(x: (tw - CLTypingDots.width) / 2, y: (th - 8) / 2, width: CLTypingDots.width, height: 8)
    let sb: CGFloat = 22
    smartBadge.frame = CGRect(x: -2, y: s - sb + 2, width: sb, height: sb)
    smartBadge.layer.cornerRadius = sb / 2
    let ub: CGFloat = 24
    unpinButton.frame = CGRect(x: -6, y: -6, width: ub, height: ub)
    unpinButton.layer.cornerRadius = ub / 2
    let nameY = top + s + 6
    nameLabel.frame = CGRect(x: 3, y: nameY, width: max(0, b.width - 6), height: max(0, min(18, b.height - nameY)))
  }

  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    // O × do modo reorganizar sai um pouco da caixa do avatar.
    if !unpinButton.isHidden {
      let p = convert(point, to: unpinButton)
      if unpinButton.bounds.insetBy(dx: -8, dy: -8).contains(p) { return true }
    }
    return super.point(inside: point, with: event)
  }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    if !unpinButton.isHidden {
      let p = convert(point, to: unpinButton)
      if unpinButton.bounds.insetBy(dx: -8, dy: -8).contains(p) { return unpinButton }
    }
    return super.hitTest(point, with: event)
  }

  override var isHighlighted: Bool {
    didSet {
      if lifted || oldValue == isHighlighted { return }
      let t: CGAffineTransform = isHighlighted ? CGAffineTransform(scaleX: 0.92, y: 0.92) : .identity
      UIView.animate(withDuration: isHighlighted ? 0.18 : 0.42, delay: 0,
                     usingSpringWithDamping: isHighlighted ? 1 : 0.55, initialSpringVelocity: 0.5,
                     options: [.allowUserInteraction, .beginFromCurrentState], animations: {
        self.avatarWrap.transform = t
      })
    }
  }

  /// Arrasto do modo reorganizar: levanta (escala + sombra) ou assenta.
  func setLifted(_ on: Bool) {
    if lifted == on { return }
    lifted = on
    UIView.animate(withDuration: 0.4, delay: 0, usingSpringWithDamping: 0.6, initialSpringVelocity: 0.4,
                   options: [.allowUserInteraction, .beginFromCurrentState], animations: {
      self.avatarWrap.transform = on ? CGAffineTransform(scaleX: 1.12, y: 1.12) : .identity
    })
    avatarWrap.layer.shadowColor = UIColor.black.cgColor
    avatarWrap.layer.shadowOffset = CGSize(width: 0, height: 6)
    avatarWrap.layer.shadowRadius = 10
    avatarWrap.layer.shadowPath = UIBezierPath(ovalIn: CGRect(x: 0, y: 0, width: size, height: size)).cgPath
    let a = CABasicAnimation(keyPath: "shadowOpacity")
    a.fromValue = avatarWrap.layer.presentation()?.shadowOpacity ?? avatarWrap.layer.shadowOpacity
    a.toValue = on ? 0.28 : 0
    a.duration = 0.25
    avatarWrap.layer.shadowOpacity = on ? 0.28 : 0
    avatarWrap.layer.add(a, forKey: "shadowOpacity")
  }

  func setWiggle(_ on: Bool) {
    if on {
      if lift.layer.animation(forKey: "wiggle") != nil { return }
      let a = CAKeyframeAnimation(keyPath: "transform.rotation.z")
      let amp = 0.032 + Double.random(in: 0...0.008)
      a.values = [-amp, amp, -amp]
      a.keyTimes = [0, 0.5, 1]
      a.duration = 0.26 + Double.random(in: 0...0.05)
      a.repeatCount = .infinity
      a.isAdditive = true
      a.beginTime = CACurrentMediaTime() + Double.random(in: 0...0.12)
      a.isRemovedOnCompletion = false
      lift.layer.add(a, forKey: "wiggle")
    } else {
      lift.layer.removeAnimation(forKey: "wiggle")
    }
  }

  /// Entrada: cresce com spring a partir de 60% (escalonada pelo índice).
  func playEntrance(delay: TimeInterval) {
    lift.alpha = 0
    lift.transform = CGAffineTransform(translationX: 0, y: 10).scaledBy(x: 0.6, y: 0.6)
    UIView.animate(withDuration: 0.62, delay: delay, usingSpringWithDamping: 0.68, initialSpringVelocity: 0.5,
                   options: [.allowUserInteraction, .beginFromCurrentState], animations: {
      self.lift.alpha = 1
      self.lift.transform = .identity
    })
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    typingDots.stop()
    lift.layer.removeAllAnimations()
    lift.alpha = 1
    lift.transform = .identity
    avatarWrap.transform = .identity
    avatarWrap.layer.shadowOpacity = 0
    lifted = false
    wasTyping = false
    rowId = ""
    lastUnread = 0
    onUnpin = nil
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil && !typingBubble.isHidden { typingDots.start() }
  }
}

public final class ChatyyPinnedStripView: ExpoView, UICollectionViewDataSource, UICollectionViewDelegateFlowLayout,
  UICollectionViewDragDelegate, UICollectionViewDropDelegate {
  let onPinPress = EventDispatcher()
  let onPinPressIn = EventDispatcher()
  let onPinAction = EventDispatcher()
  let onPinLongPress = EventDispatcher()
  let onPeekRequest = EventDispatcher()
  let onPeekOpen = EventDispatcher()
  let onReorder = EventDispatcher()
  let onReorderDone = EventDispatcher()
  let onNativeError = EventDispatcher()

  private var collectionView: UICollectionView!
  private let flow = UICollectionViewFlowLayout()
  private var reorderPress: UILongPressGestureRecognizer!

  private var ids: [String] = []
  private var rows: [String: CLRow] = [:]
  private var pendingItems: [[String: Any]]?
  private var theme = CLTheme(dark: false)
  private var themeDirty = true
  private var labels = CLLabels()
  private var folders: [CLFolder] = []
  private var avatarSize: CGFloat = 72
  private var sizeDirty = false
  private var reorderMode = false
  private var reorderDirty = false
  private var selectionMode = false
  var menuEnabled = true
  private var moving = false      // movimento interativo (modo reorganizar)
  private var dragActive = false  // drag & drop a partir do toque longo
  private var entered = Set<String>()
  private var lastMoveTarget: IndexPath?
  private var lastDropTarget: IndexPath?
  private var lastWidth: CGFloat = 0

  private weak var peekController: CLPeekController?
  private var lastPeek: [String: Any]?
  /// [2026-10-17 peek-fixed] fração da tela p/ o cartão da prévia (0 = padrão).
  var peekHeight: CGFloat = 0

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = false
    backgroundColor = .clear
    flow.scrollDirection = .horizontal
    flow.minimumLineSpacing = 0
    flow.minimumInteritemSpacing = 0
    let cv = UICollectionView(frame: bounds, collectionViewLayout: flow)
    cv.backgroundColor = .clear
    cv.showsHorizontalScrollIndicator = false
    cv.showsVerticalScrollIndicator = false
    cv.alwaysBounceHorizontal = true
    cv.alwaysBounceVertical = false
    cv.contentInsetAdjustmentBehavior = .never
    cv.clipsToBounds = true
    cv.dataSource = self
    cv.delegate = self
    cv.dragDelegate = self
    cv.dropDelegate = self
    cv.dragInteractionEnabled = true
    cv.reorderingCadence = .immediate
    cv.register(CLPinCell.self, forCellWithReuseIdentifier: "CLPinCell")
    addSubview(cv)
    collectionView = cv

    let lp = UILongPressGestureRecognizer(target: self, action: #selector(handleReorderPress(_:)))
    lp.minimumPressDuration = 0.16
    lp.isEnabled = false
    cv.addGestureRecognizer(lp)
    reorderPress = lp
  }

  // MARK: - Props

  func setItems(_ list: [[String: Any]]?) {
    pendingItems = list ?? []
  }

  func setDark(_ dark: Bool) {
    if dark == theme.dark && !themeDirty { return }
    theme = CLTheme(dark: dark)
    themeDirty = true
  }

  func setLabels(_ d: [String: Any]?) {
    labels = CLLabels(d)
  }

  func setFolders(_ list: [[String: Any]]?) {
    folders = (list ?? []).map { CLFolder($0) }.filter { !$0.id.isEmpty && !$0.name.isEmpty }
  }

  func setPeek(_ d: [String: Any]?) {
    lastPeek = d
    if let d = d { peekController?.update(d) }
  }

  func setAvatarSize(_ s: CGFloat) {
    let v = max(40, min(96, s))
    if abs(v - avatarSize) < 0.5 { return }
    avatarSize = v
    sizeDirty = true
  }

  func setReorderMode(_ on: Bool) {
    if on == reorderMode { return }
    reorderMode = on
    reorderDirty = true
  }

  func setSelectionMode(_ on: Bool) {
    if on == selectionMode { return }
    selectionMode = on
    reorderDirty = true
  }

  func commitProps() {
    applyItems()
    if sizeDirty {
      sizeDirty = false
      if window != nil && !ids.isEmpty {
        reconfigureVisible()
        UIView.animate(withDuration: 0.5, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0.3,
                       options: [.allowUserInteraction, .beginFromCurrentState], animations: {
          self.flow.invalidateLayout()
          self.collectionView.layoutIfNeeded()
          for c in self.collectionView.visibleCells { c.layoutIfNeeded() }
        })
      } else {
        flow.invalidateLayout()
        reconfigureVisible()
      }
    }
    if themeDirty {
      themeDirty = false
      reconfigureVisible()
    }
    if reorderDirty {
      reorderDirty = false
      if !reorderMode && moving {
        collectionView.cancelInteractiveMovement()
        moving = false
      }
      updateInteractionModes()
      reconfigureVisible()
      if reorderMode {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
      }
    }
  }

  private func updateInteractionModes() {
    reorderPress.isEnabled = reorderMode && !selectionMode
    collectionView.dragInteractionEnabled = !reorderMode && !selectionMode && ids.count > 1
    for c in collectionView.visibleCells {
      (c as? CLPinCell)?.setWiggle(reorderMode && !selectionMode)
    }
  }

  // MARK: - Dados

  private func applyItems() {
    guard let list = pendingItems else { return }
    // Durante um arrasto a ordem é nossa; o estado novo entra ao soltar.
    if moving || dragActive || collectionView.hasActiveDrag || collectionView.hasActiveDrop { return }
    pendingItems = nil
    var nextRows: [String: CLRow] = [:]
    var nextIds: [String] = []
    for d in list {
      let r = CLRow(d)
      if r.id.isEmpty || nextRows[r.id] != nil { continue }
      nextRows[r.id] = r
      nextIds.append(r.id)
    }
    let oldIds = ids
    rows = nextRows
    entered = entered.intersection(Set(nextIds))
    if oldIds == nextIds {
      reconfigureVisible()
      return
    }
    let columnsChanged = (oldIds.count <= 4) != (nextIds.count <= 4)
    if window == nil || oldIds.isEmpty || nextIds.isEmpty || columnsChanged {
      ids = nextIds
      collectionView.reloadData()
      updateInteractionModes()
      return
    }
    let oldSet = Set(oldIds)
    let newSet = Set(nextIds)
    let keptOld = oldIds.filter { newSet.contains($0) }
    let keptNew = nextIds.filter { oldSet.contains($0) }
    // Só batch nos casos simples (seguros): remoções puras, inserções puras ou
    // só reordenação. O resto vira reloadData (≤ 9 itens: custo zero).
    let onlyDeletes = nextIds.count < oldIds.count && keptOld == nextIds
    let onlyInserts = nextIds.count > oldIds.count && keptNew == oldIds
    let onlyMoves = oldSet == newSet
    if onlyDeletes {
      let del = oldIds.enumerated().filter { !newSet.contains($0.element) }.map { IndexPath(item: $0.offset, section: 0) }
      collectionView.performBatchUpdates({
        self.ids = nextIds
        self.collectionView.deleteItems(at: del)
      }, completion: { [weak self] _ in self?.reconfigureVisible() })
    } else if onlyInserts {
      let ins = nextIds.enumerated().filter { !oldSet.contains($0.element) }.map { IndexPath(item: $0.offset, section: 0) }
      collectionView.performBatchUpdates({
        self.ids = nextIds
        self.collectionView.insertItems(at: ins)
      }, completion: { [weak self] _ in self?.reconfigureVisible() })
    } else if onlyMoves {
      var moves: [(IndexPath, IndexPath)] = []
      for (ni, id) in nextIds.enumerated() {
        if let oi = oldIds.firstIndex(of: id), oi != ni {
          moves.append((IndexPath(item: oi, section: 0), IndexPath(item: ni, section: 0)))
        }
      }
      collectionView.performBatchUpdates({
        self.ids = nextIds
        for (a, b) in moves { self.collectionView.moveItem(at: a, to: b) }
      }, completion: { [weak self] _ in self?.reconfigureVisible() })
    } else {
      ids = nextIds
      collectionView.reloadData()
    }
    updateInteractionModes()
  }

  private func reconfigureVisible() {
    for ip in collectionView.indexPathsForVisibleItems {
      guard ip.item < ids.count, let cell = collectionView.cellForItem(at: ip) as? CLPinCell else { continue }
      bind(cell, id: ids[ip.item])
    }
  }

  private func bind(_ cell: CLPinCell, id: String) {
    guard let row = rows[id] else { return }
    let wiggle = reorderMode && !selectionMode
    cell.configure(row, theme: theme, labels: labels, size: avatarSize, reorderMode: wiggle)
    cell.onUnpin = { [weak self] rid in
      self?.onPinAction(["id": rid, "action": "pin", "source": "reorder"])
    }
    cell.setWiggle(wiggle)
  }

  // MARK: - Layout

  public override func layoutSubviews() {
    super.layoutSubviews()
    if collectionView.frame != bounds {
      collectionView.frame = bounds
    }
    if abs(bounds.width - lastWidth) > 0.5 {
      lastWidth = bounds.width
      flow.invalidateLayout()
    }
  }

  private var sideInset: CGFloat { ids.count <= 4 ? 8 : 10 }

  public func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout, sizeForItemAt indexPath: IndexPath) -> CGSize {
    let h = max(1, collectionView.bounds.height)
    let w: CGFloat
    if ids.count <= 4 {
      // Até 4: colunas iguais ocupando a largura (grade estilo iMessage).
      w = floor((collectionView.bounds.width - sideInset * 2) / 4)
    } else {
      w = avatarSize + 22
    }
    return CGSize(width: max(avatarSize + 8, w), height: h)
  }

  public func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout, insetForSectionAt section: Int) -> UIEdgeInsets {
    return UIEdgeInsets(top: 0, left: sideInset, bottom: 0, right: sideInset)
  }

  // MARK: - Data source

  public func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
    return ids.count
  }

  public func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
    let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "CLPinCell", for: indexPath)
    if let c = cell as? CLPinCell, indexPath.item < ids.count {
      bind(c, id: ids[indexPath.item])
    }
    return cell
  }

  public func collectionView(_ collectionView: UICollectionView, canMoveItemAt indexPath: IndexPath) -> Bool {
    return reorderMode && ids.count > 1
  }

  public func collectionView(_ collectionView: UICollectionView, moveItemAt sourceIndexPath: IndexPath, to destinationIndexPath: IndexPath) {
    let s = sourceIndexPath.item
    let d = destinationIndexPath.item
    guard s < ids.count, d < ids.count, s != d else { return }
    let id = ids.remove(at: s)
    ids.insert(id, at: d)
    onReorder(["ids": ids])
  }

  // MARK: - Delegate

  public func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
    guard let c = cell as? CLPinCell, indexPath.item < ids.count else { return }
    let id = ids[indexPath.item]
    c.setWiggle(reorderMode && !selectionMode)
    if !entered.contains(id) {
      entered.insert(id)
      c.playEntrance(delay: min(0.32, 0.05 * Double(indexPath.item)))
    }
  }

  public func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: false)
    guard indexPath.item < ids.count else { return }
    if reorderMode {
      UISelectionFeedbackGenerator().selectionChanged()
      onReorderDone([:])
      return
    }
    onPinPress(["id": ids[indexPath.item]])
  }

  public func collectionView(_ collectionView: UICollectionView, didHighlightItemAt indexPath: IndexPath) {
    if selectionMode || reorderMode || indexPath.item >= ids.count { return }
    onPinPressIn(["id": ids[indexPath.item]])
  }

  public func collectionView(_ collectionView: UICollectionView, targetIndexPathForMoveFromItemAt originalIndexPath: IndexPath, toProposedIndexPath proposedIndexPath: IndexPath) -> IndexPath {
    if proposedIndexPath != lastMoveTarget {
      lastMoveTarget = proposedIndexPath
      UISelectionFeedbackGenerator().selectionChanged()
    }
    return proposedIndexPath
  }

  // MARK: - Menu + prévia (toque longo)

  public func collectionView(_ collectionView: UICollectionView, contextMenuConfigurationForItemAt indexPath: IndexPath, point: CGPoint) -> UIContextMenuConfiguration? {
    guard indexPath.item < ids.count else { return nil }
    let id = ids[indexPath.item]
    // Seleção múltipla: o toque já alterna; sem menu (evita alternar 2×).
    guard menuEnabled, !selectionMode, !reorderMode, let row = rows[id] else { return nil }
    onPeekRequest(["id": id])
    let theme = self.theme
    return UIContextMenuConfiguration(identifier: id as NSString, previewProvider: { [weak self] in
      let vc = CLPeekController(row: row, theme: theme, menuHeight: CLMenuBuilder.maxEstimatedHeight(), window: self?.window, heightFraction: self?.peekHeight ?? 0)
      if let p = self?.lastPeek, CLVal.str(p["id"]) == id { vc.update(p) }
      self?.peekController = vc
      return vc as UIViewController
    }, actionProvider: { [weak self] _ in
      guard let self = self else { return nil }
      let emit: ([String: Any]) -> Void = { [weak self] body in self?.onPinAction(body) }
      var extra: [UIMenuElement] = []
      if row.pinned && self.ids.count > 1 {
        extra.append(CLMenuBuilder.action(id: id, action: "reorder",
                                          title: self.labels.get("reorderPinned", "Reorganizar fixados"),
                                          symbol: "arrow.left.arrow.right", emit: emit))
      }
      return CLMenuBuilder.rowMenu(id: id, row: row, labels: self.labels, folders: self.folders,
                                   afterPin: extra, emit: emit)
    })
  }

  private func targetedPreview(_ configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
    guard let ns = configuration.identifier as? NSString else { return nil }
    let id = ns as String
    guard let idx = ids.firstIndex(of: id),
          let cell = collectionView.cellForItem(at: IndexPath(item: idx, section: 0)) as? CLPinCell,
          cell.window != nil else { return nil }
    let p = UIPreviewParameters()
    p.backgroundColor = .clear
    p.visiblePath = UIBezierPath(ovalIn: cell.avatarWrap.bounds)
    return UITargetedPreview(view: cell.avatarWrap, parameters: p)
  }

  public func collectionView(_ collectionView: UICollectionView, previewForHighlightingContextMenuWithConfiguration configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
    return targetedPreview(configuration)
  }

  public func collectionView(_ collectionView: UICollectionView, previewForDismissingContextMenuWithConfiguration configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
    return targetedPreview(configuration)
  }

  public func collectionView(_ collectionView: UICollectionView, willPerformPreviewActionForMenuWith configuration: UIContextMenuConfiguration, animator: UIContextMenuInteractionCommitAnimating) {
    guard let ns = configuration.identifier as? NSString else { return }
    let sid = ns as String
    animator.preferredCommitStyle = .dismiss
    animator.addCompletion { [weak self] in
      self?.onPeekOpen(["id": sid])
    }
  }

  // MARK: - Arrastar a partir do toque longo (drag & drop local)

  public func collectionView(_ collectionView: UICollectionView, itemsForBeginning session: UIDragSession, at indexPath: IndexPath) -> [UIDragItem] {
    guard !selectionMode, !reorderMode, ids.count > 1, indexPath.item < ids.count else { return [] }
    let item = UIDragItem(itemProvider: NSItemProvider())
    item.localObject = ids[indexPath.item] as NSString
    return [item]
  }

  public func collectionView(_ collectionView: UICollectionView, dragPreviewParametersForItemAt indexPath: IndexPath) -> UIDragPreviewParameters? {
    guard let cell = collectionView.cellForItem(at: indexPath) as? CLPinCell else { return nil }
    let p = UIDragPreviewParameters()
    p.backgroundColor = .clear
    let f = cell.avatarWrap.convert(cell.avatarWrap.bounds, to: cell.contentView)
    p.visiblePath = UIBezierPath(ovalIn: f)
    return p
  }

  public func collectionView(_ collectionView: UICollectionView, dragSessionWillBegin session: UIDragSession) {
    dragActive = true
    lastDropTarget = nil
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
  }

  public func collectionView(_ collectionView: UICollectionView, dragSessionDidEnd session: UIDragSession) {
    dragActive = false
    lastDropTarget = nil
    DispatchQueue.main.async { [weak self] in self?.applyItems() }
  }

  public func collectionView(_ collectionView: UICollectionView, dragSessionIsRestrictedToDraggingApplication session: UIDragSession) -> Bool {
    return true
  }

  public func collectionView(_ collectionView: UICollectionView, dragSessionAllowsMoveOperation session: UIDragSession) -> Bool {
    return true
  }

  public func collectionView(_ collectionView: UICollectionView, canHandle session: UIDropSession) -> Bool {
    return session.localDragSession != nil
  }

  public func collectionView(_ collectionView: UICollectionView, dropSessionDidUpdate session: UIDropSession, withDestinationIndexPath destinationIndexPath: IndexPath?) -> UICollectionViewDropProposal {
    guard session.localDragSession != nil, collectionView.hasActiveDrag else {
      return UICollectionViewDropProposal(operation: .forbidden)
    }
    if let d = destinationIndexPath, d != lastDropTarget {
      if lastDropTarget != nil { UISelectionFeedbackGenerator().selectionChanged() }
      lastDropTarget = d
    }
    return UICollectionViewDropProposal(operation: .move, intent: .insertAtDestinationIndexPath)
  }

  public func collectionView(_ collectionView: UICollectionView, performDropWith coordinator: UICollectionViewDropCoordinator) {
    guard let item = coordinator.items.first, let src = item.sourceIndexPath, !ids.isEmpty else { return }
    var dest = coordinator.destinationIndexPath ?? IndexPath(item: ids.count - 1, section: 0)
    dest = IndexPath(item: max(0, min(dest.item, ids.count - 1)), section: 0)
    guard src.item < ids.count else { return }
    if src.item != dest.item {
      collectionView.performBatchUpdates({
        let id = self.ids.remove(at: src.item)
        self.ids.insert(id, at: dest.item)
        collectionView.moveItem(at: src, to: dest)
      }, completion: nil)
      onReorder(["ids": ids])
    }
    coordinator.drop(item.dragItem, toItemAt: dest)
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
  }

  // MARK: - Modo reorganizar (movimento interativo, sem esperar o menu)

  @objc private func handleReorderPress(_ g: UILongPressGestureRecognizer) {
    let p = g.location(in: collectionView)
    switch g.state {
    case .began:
      guard reorderMode, ids.count > 1, let ip = collectionView.indexPathForItem(at: p) else { return }
      if collectionView.beginInteractiveMovementForItem(at: ip) {
        moving = true
        lastMoveTarget = ip
        (collectionView.cellForItem(at: ip) as? CLPinCell)?.setLifted(true)
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
      }
    case .changed:
      if moving {
        // Trava no eixo da fileira: só desliza para os lados.
        collectionView.updateInteractiveMovementTargetPosition(CGPoint(x: p.x, y: collectionView.bounds.midY))
      }
    case .ended:
      if moving {
        collectionView.endInteractiveMovement()
        finishMove()
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
      }
    default:
      if moving {
        collectionView.cancelInteractiveMovement()
        finishMove()
      }
    }
  }

  private func finishMove() {
    moving = false
    lastMoveTarget = nil
    for c in collectionView.visibleCells { (c as? CLPinCell)?.setLifted(false) }
    DispatchQueue.main.async { [weak self] in self?.applyItems() }
  }
}
