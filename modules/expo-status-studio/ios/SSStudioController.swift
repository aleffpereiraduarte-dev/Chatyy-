import UIKit
import AVFoundation

// [2026-10-15 native-status-studio] Estúdio de status (nível Instagram/WhatsApp).
//   • modo texto → SSTextComposer (prévia idêntica ao visualizador nativo);
//   • modo mídia → palco 9:16 (SSStageView) com filtros, camadas, figurinhas
//     interativas, desenho, legenda, público e várias mídias;
//   • Publicar → exporta (foto queimada 1080×1920 / filtrada; vídeo original +
//     JSON) e devolve ao JS, que entrega à fila durável de upload.

final class SSStudioController: UIViewController, SSStageHost, UITextViewDelegate, UITextFieldDelegate,
  UICollectionViewDataSource, UICollectionViewDelegate {

  var onFinish: (([String: Any]) -> Void)?
  var request: ((String, [String: Any], @escaping ([String: Any]) -> Void) -> Void)?

  let options: SSOptions
  private var mode: String
  private var finished = false
  private var items: [SSItemState] = []
  private var idx = 0
  private var audience: String
  private var kbHeight: CGFloat = 0

  // texto
  private var composer: SSTextComposer?

  // mídia
  private var mediaBuilt = false
  private let stage = SSStageView()
  private let closeBtn = UIButton(type: .system)
  private var toolBtns: [String: UIButton] = [:]
  private let toolRow = UIView()
  private let flashLabel = UILabel()
  private var flashTimer: Timer?
  private let filterLay = UICollectionViewFlowLayout()
  private lazy var filterStrip = UICollectionView(frame: .zero, collectionViewLayout: filterLay)
  private let thumbsRow = UIScrollView()
  private var thumbViews: [UIButton] = []
  private let captionField = UITextField()
  private let audPill = UIButton(type: .custom)
  private let shareBtn = UIButton(type: .custom)
  private var showFilters = false
  private var filterCache: [Int: UIImage] = [:]
  private var filterThumbs: [Int: UIImage] = [:]
  private var thumbBase: CGImage?
  private var loadToken = 0

  // vídeo
  private var player: AVQueuePlayer?
  private var looper: AVPlayerLooper?

  // desenho
  private var drawing = false
  private let drawTop = UIView()
  private let drawUndo = UIButton(type: .system)
  private let drawDone = UIButton(type: .custom)
  private var brushBtns: [UIButton] = []
  private let sizeSlider = UISlider()
  private let drawColors = UIScrollView()
  private var drawColorDots: [UIButton] = []
  var brushColor: UIColor = .white
  var brushWidth: CGFloat = 8
  var brushKind: SSBrush = .pen

  // editor de texto (camada)
  private let textEditor = UIView()
  private let textEditorDim = UIControl()
  private let textEdit = UITextView()
  private let teFontRow = UIScrollView()
  private var teFontChips: [UIButton] = []
  private let teAlign = UIButton(type: .system)
  private let teBg = UIButton(type: .system)
  private let teDone = UIButton(type: .custom)
  private let teColors = UIScrollView()
  private var teColorDots: [UIButton] = []
  private var teLayer: SSLayer?
  private var teIsNew = false

  // folhas / formulários
  private weak var sheet: SSSheet?
  private weak var form: SSFormOverlay?
  private var countdownTimer: Timer?

  // ocupado
  private let busyView = UIView()
  private let busySpinner = UIActivityIndicatorView(style: .large)
  private let busyLabel = UILabel()
  private var busy = false

  init(options: SSOptions) {
    self.options = options
    mode = options.mode == "text" || options.items.isEmpty ? "text" : "media"
    audience = options.audience
    closeFriendsCount = options.closeFriendsCount
    super.init(nibName: nil, bundle: nil)
    items = options.items.map { SSItemState($0) }
    for it in items {
      if !it.media.filter.isEmpty, let i = options.filters.firstIndex(where: { $0.id == it.media.filter }) { it.filterIdx = i }
    }
    if let m = options.music, let first = items.first {
      let l = SSLayer(kind: .music, text: (m["title"] as? String) ?? "")
      l.artist = (m["artist"] as? String) ?? ""
      l.cover = (m["coverUrl"] as? String) ?? ""
      l.preview = (m["previewUrl"] as? String) ?? ""
      l.u = 0.5
      l.v = 0.78
      startMs = Int(SSOptions.num(m["startMs"]) ?? 0)
      first.layers.append(l)
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  private var closeFriendsCount: Int
  private var startMs = 0

  override var preferredStatusBarStyle: UIStatusBarStyle { return .lightContent }
  override var supportedInterfaceOrientations: UIInterfaceOrientationMask { return .portrait }

  private func L(_ k: String, _ fb: String) -> String { return options.t(k, fb) }

  deinit {
    NotificationCenter.default.removeObserver(self)
    countdownTimer?.invalidate()
    flashTimer?.invalidate()
  }

  // MARK: ciclo de vida

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    if mode == "text" { buildComposer() } else { buildMedia() }
    buildTextEditor()
    buildBusy()
    NotificationCenter.default.addObserver(self, selector: #selector(kbChange(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(kbHide(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(appBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(appForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
    countdownTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.stage.tickWidgets() }
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    if mode == "text", let c = composer, c.text.isEmpty { c.beginEdit() }
  }

  @objc private func appBackground() { player?.pause() }
  @objc private func appForeground() { if mode == "media" && !busy { player?.play() } }

  private func finish(_ result: [String: Any]) {
    guard !finished else { return }
    finished = true
    view.endEditing(true)
    player?.pause()
    looper?.disableLooping()
    countdownTimer?.invalidate()
    let cb = onFinish
    onFinish = nil
    var delivered = false
    let deliver: () -> Void = {
      if delivered { return }
      delivered = true
      cb?(result)
    }
    if presentingViewController == nil {
      deliver()
    } else {
      dismiss(animated: true) { deliver() }
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { deliver() }
    }
  }

  func closeFromJS() { finish(["action": "cancel", "reason": "js"]) }

  private var isDirty: Bool {
    if mode == "text" { return !(composer?.trimmed.isEmpty ?? true) }
    if !(captionField.text ?? "").trimmingCharacters(in: .whitespaces).isEmpty { return true }
    return items.contains { $0.dirty && !($0.layers.count == 1 && $0.layers[0].kind == .music && options.music != nil && $0.strokes.isEmpty && $0.filterIdx == 0) }
  }

  private func requestClose() {
    guard !busy else { return }
    if !isDirty { finish(["action": "cancel"]); return }
    let a = UIAlertController(title: L("discardTitle", "Descartar alterações?"), message: nil, preferredStyle: .alert)
    a.addAction(UIAlertAction(title: L("keep", "Continuar editando"), style: .cancel, handler: nil))
    a.addAction(UIAlertAction(title: L("discard", "Descartar"), style: .destructive, handler: { [weak self] _ in
      self?.finish(["action": "cancel"])
    }))
    present(a, animated: true, completion: nil)
  }

  // MARK: teclado

  @objc private func kbChange(_ n: Notification) {
    guard let end = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
    let r = view.convert(end, from: nil)
    kbHeight = max(0, view.bounds.maxY - r.minY)
    applyKeyboard(n)
  }

  @objc private func kbHide(_ n: Notification) {
    kbHeight = 0
    applyKeyboard(n)
  }

  private func applyKeyboard(_ n: Notification) {
    let dur = (n.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
    composer?.keyboardInset = kbHeight
    sheet?.keyboardInset = kbHeight
    form?.keyboardInset = kbHeight
    view.setNeedsLayout()
    UIView.animate(withDuration: dur) {
      self.view.layoutIfNeeded()
      self.composer?.layoutIfNeeded()
    }
  }

  // MARK: público

  private func audienceMeta() -> (String, String) {
    switch audience {
    case "contacts": return (L("audContacts", "Meus contatos"), "person.2.fill")
    case "close_friends": return (L("audClose", "Melhores amigos"), "star.fill")
    case "except": return (L("audExcept", "Ocultar de…"), "eye.slash.fill")
    default: return (L("audAll", "Todos"), "globe")
    }
  }

  private func paintAudience() {
    let (t, s) = audienceMeta()
    composer?.setAudience(title: t, symbol: s)
    audPill.setTitle(t, for: .normal)
    audPill.setImage(ssSymbol(s, 13, .semibold), for: .normal)
    view.setNeedsLayout()
  }

  private func openAudience() {
    view.endEditing(true)
    let sh = SSSheet()
    sh.fixedHeight = 38 + 62 * 4 + 52
    let c = SSAudienceContent(opts: options, selected: audience, closeFriendsCount: closeFriendsCount, exceptCount: options.exceptCount)
    c.onPick = { [weak self, weak sh] k in
      guard let self = self else { return }
      ssHaptic("select")
      self.audience = k
      self.paintAudience()
      if k == "close_friends" && self.closeFriendsCount == 0 {
        // mantém aberta mostrando o aviso + Editar
        sh?.dismiss { self.openAudience() }
        return
      }
      sh?.dismiss()
    }
    c.onEdit = { [weak self, weak sh] k in
      sh?.dismiss { self?.finish(["action": "editAudience", "which": k]) }
    }
    sh.content.addSubview(c)
    c.frame = sh.content.bounds
    c.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    sh.show(in: view)
    sheet = sh
  }

  // MARK: - TEXTO

  private func buildComposer() {
    let c = SSTextComposer(opts: options)
    c.onClose = { [weak self] in self?.requestClose() }
    c.onSend = { [weak self] in self?.publish() }
    c.onAudience = { [weak self] in self?.openAudience() }
    c.onCamera = { [weak self] in
      guard let self = self else { return }
      if !(self.composer?.trimmed.isEmpty ?? true) {
        let a = UIAlertController(title: self.L("discardTitle", "Descartar alterações?"), message: nil, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: self.L("keep", "Continuar editando"), style: .cancel, handler: nil))
        a.addAction(UIAlertAction(title: self.L("discard", "Descartar"), style: .destructive, handler: { [weak self] _ in self?.finish(["action": "camera"]) }))
        self.present(a, animated: true)
        return
      }
      self.finish(["action": "camera"])
    }
    c.onGallery = { [weak self] in self?.pickFromGallery() }
    view.insertSubview(c, at: 0)
    composer = c
    paintAudience()
  }

  // MARK: - MÍDIA

  private func buildMedia() {
    guard !mediaBuilt else { return }
    mediaBuilt = true
    stage.host = self
    view.addSubview(stage)

    flashLabel.textColor = .white
    flashLabel.font = .systemFont(ofSize: 26, weight: .heavy)
    flashLabel.textAlignment = .center
    flashLabel.layer.shadowColor = UIColor.black.cgColor
    flashLabel.layer.shadowOpacity = 0.5
    flashLabel.layer.shadowRadius = 6
    flashLabel.layer.shadowOffset = .zero
    flashLabel.alpha = 0
    flashLabel.isUserInteractionEnabled = false
    view.addSubview(flashLabel)

    // topo (sobre o palco)
    styleGlass(closeBtn, "xmark", L("close", "Fechar"))
    closeBtn.addAction(UIAction { [weak self] _ in self?.requestClose() }, for: .touchUpInside)
    view.addSubview(closeBtn)
    let defs: [(String, String?, String)] = [
      ("text", nil, L("text", "Texto")),
      ("stickers", "face.smiling", L("stickers", "Figurinhas")),
      ("music", "music.note", L("music", "Música")),
      ("draw", "scribble.variable", L("draw", "Desenhar")),
      ("filters", "camera.filters", L("filters", "Filtros")),
    ]
    for (k, sym, label) in defs {
      let b = UIButton(type: .system)
      if let s = sym { styleGlass(b, s, label) } else {
        styleGlass(b, nil, label)
        b.setTitle("Aa", for: .normal)
        b.titleLabel?.font = .systemFont(ofSize: 16, weight: .bold)
        b.setTitleColor(.white, for: .normal)
      }
      b.addAction(UIAction { [weak self] _ in self?.tapTool(k) }, for: .touchUpInside)
      toolRow.addSubview(b)
      toolBtns[k] = b
    }
    view.addSubview(toolRow)

    // filtros
    filterLay.scrollDirection = .horizontal
    filterLay.itemSize = CGSize(width: 66, height: 84)
    filterLay.minimumLineSpacing = 8
    filterLay.sectionInset = UIEdgeInsets(top: 0, left: 12, bottom: 0, right: 12)
    filterStrip.backgroundColor = .clear
    filterStrip.showsHorizontalScrollIndicator = false
    filterStrip.dataSource = self
    filterStrip.delegate = self
    filterStrip.register(SSFilterCell.self, forCellWithReuseIdentifier: "f")
    filterStrip.isHidden = true
    view.addSubview(filterStrip)

    // miniaturas (várias mídias)
    thumbsRow.showsHorizontalScrollIndicator = false
    view.addSubview(thumbsRow)

    // legenda
    captionField.backgroundColor = UIColor(white: 1, alpha: 0.12)
    captionField.layer.cornerRadius = 22
    captionField.textColor = .white
    captionField.tintColor = .white
    captionField.font = .systemFont(ofSize: 16)
    captionField.attributedPlaceholder = NSAttributedString(string: L("captionPlaceholder", "Adicionar legenda…"), attributes: [.foregroundColor: UIColor(white: 1, alpha: 0.55)])
    captionField.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 16, height: 10))
    captionField.leftViewMode = .always
    captionField.rightView = UIView(frame: CGRect(x: 0, y: 0, width: 12, height: 10))
    captionField.rightViewMode = .always
    captionField.keyboardAppearance = .dark
    captionField.returnKeyType = .done
    captionField.delegate = self
    view.addSubview(captionField)

    // rodapé
    audPill.backgroundColor = UIColor(white: 1, alpha: 0.12)
    audPill.layer.cornerRadius = 22
    audPill.setTitleColor(.white, for: .normal)
    audPill.titleLabel?.font = .systemFont(ofSize: 14, weight: .semibold)
    audPill.tintColor = .white
    audPill.contentEdgeInsets = UIEdgeInsets(top: 0, left: 14, bottom: 0, right: 18)
    audPill.titleEdgeInsets = UIEdgeInsets(top: 0, left: 6, bottom: 0, right: -6)
    audPill.accessibilityLabel = L("audienceTitle", "Quem pode ver")
    audPill.addAction(UIAction { [weak self] _ in self?.openAudience() }, for: .touchUpInside)
    view.addSubview(audPill)
    shareBtn.backgroundColor = .white
    shareBtn.layer.cornerRadius = 22
    shareBtn.setTitle(L("share", "Seu status") + "  ", for: .normal)
    shareBtn.setTitleColor(.black, for: .normal)
    shareBtn.titleLabel?.font = .systemFont(ofSize: 15, weight: .bold)
    shareBtn.setImage(ssSymbol("paperplane.fill", 14, .bold)?.withTintColor(.black, renderingMode: .alwaysOriginal), for: .normal)
    shareBtn.semanticContentAttribute = .forceRightToLeft
    shareBtn.contentEdgeInsets = UIEdgeInsets(top: 0, left: 18, bottom: 0, right: 16)
    shareBtn.addAction(UIAction { [weak self] _ in self?.publish() }, for: .touchUpInside)
    view.addSubview(shareBtn)

    buildDrawUI()
    paintAudience()
    rebuildThumbs()
    showItem(0)
  }

  private func styleGlass(_ b: UIButton, _ sym: String?, _ label: String) {
    if let s = sym { b.setImage(ssSymbol(s, 18, .semibold), for: .normal) }
    b.tintColor = .white
    b.backgroundColor = UIColor(white: 0, alpha: 0.32)
    b.layer.cornerRadius = 20
    b.accessibilityLabel = label
  }

  private func switchToMedia() {
    guard mode != "media" else { return }
    mode = "media"
    composer?.textView.resignFirstResponder()
    composer?.removeFromSuperview()
    composer = nil
    buildMedia()
    view.bringSubviewToFront(textEditor)
    view.bringSubviewToFront(busyView)
    view.setNeedsLayout()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    let W = view.bounds.width
    let H = view.bounds.height
    let safe = view.safeAreaInsets
    composer?.frame = view.bounds
    textEditor.frame = view.bounds
    layoutTextEditor()
    busyView.frame = view.bounds
    busySpinner.center = CGPoint(x: W / 2, y: H / 2 - 14)
    busyLabel.frame = CGRect(x: 20, y: H / 2 + 18, width: W - 40, height: 22)
    guard mediaBuilt else { return }

    let thumbsOn = items.count > 1 || options.canGallery
    let bottomArea: CGFloat = (thumbsOn ? 58 : 0) + 52 + 56
    let availH = H - safe.top - 6 - bottomArea - max(safe.bottom, 8)
    let sw = min(W, max(200, availH) * 9 / 16)
    let sh = sw * 16 / 9
    let stageFrame = CGRect(x: (W - sw) / 2, y: safe.top + 6, width: sw, height: sh)
    if stage.frame != stageFrame { stage.frame = stageFrame }
    closeBtn.frame = CGRect(x: stageFrame.minX + 10, y: stageFrame.minY + 10, width: 40, height: 40)
    let keys = ["text", "stickers", "music", "draw", "filters"].filter { k in
      if k == "filters" { return !(currentItem?.media.isVideo ?? true) }
      return true
    }
    for (k, b) in toolBtns { b.isHidden = !keys.contains(k) }
    let rowW = CGFloat(keys.count) * 40 + CGFloat(max(0, keys.count - 1)) * 6
    for (i, k) in keys.enumerated() {
      toolBtns[k]?.frame = CGRect(x: CGFloat(i) * 46, y: 0, width: 40, height: 40)
    }
    toolRow.frame = CGRect(x: stageFrame.maxX - 10 - rowW, y: stageFrame.minY + 10, width: rowW, height: 40)
    flashLabel.frame = CGRect(x: stageFrame.minX, y: stageFrame.midY - 50, width: stageFrame.width, height: 40)
    filterStrip.frame = CGRect(x: 0, y: stageFrame.maxY - 96, width: W, height: 88)

    var y = stageFrame.maxY + 8
    thumbsRow.isHidden = !thumbsOn || drawing
    if thumbsOn {
      thumbsRow.frame = CGRect(x: 0, y: y, width: W, height: 50)
      y += 58
    }
    let kb = kbHeight > 0 && captionField.isFirstResponder ? kbHeight : 0
    var capY = y
    if kb > 0 { capY = H - kb - 52 - 6 }
    captionField.frame = CGRect(x: 12, y: capY, width: W - 24, height: 44)
    let rowY = max(y + 52, H - max(safe.bottom, 8) - 48)
    let shareW = max(132, shareBtn.intrinsicContentSize.width + 8)
    shareBtn.frame = CGRect(x: W - 12 - shareW, y: rowY, width: shareW, height: 44)
    let aw = min(W - shareW - 36, audPill.intrinsicContentSize.width + 12)
    audPill.frame = CGRect(x: 12, y: rowY, width: aw, height: 44)
    for v in [captionField, audPill, shareBtn] as [UIView] { v.isHidden = drawing }
    layoutDrawUI(stageFrame)
  }

  private var currentItem: SSItemState? { return items.indices.contains(idx) ? items[idx] : nil }
  var stageItem: SSItemState? { return currentItem }

  // MARK: item

  private func showItem(_ i: Int) {
    guard items.indices.contains(i) else { return }
    idx = i
    loadToken += 1
    let token = loadToken
    filterCache.removeAll()
    filterThumbs.removeAll()
    thumbBase = nil
    player?.pause()
    looper?.disableLooping()
    looper = nil
    player = nil
    stage.playerView.playerLayer.player = nil
    stage.playerView.isHidden = true
    stage.imageView.image = nil
    let it = items[i]
    stage.syncWidgets()
    stage.redraw()
    paintThumbs()
    if it.media.isVideo {
      if showFilters { tapTool("filters") }
      stage.bgView.backgroundColor = .black
      guard let u = SSImage.url(it.media.uri) else { return }
      let asset = AVURLAsset(url: u)
      let p = AVQueuePlayer()
      let item = AVPlayerItem(asset: asset)
      looper = AVPlayerLooper(player: p, templateItem: item)
      player = p
      stage.playerView.playerLayer.videoGravity = .resizeAspect
      stage.playerView.playerLayer.player = p
      stage.playerView.isHidden = false
      p.play()
      DispatchQueue.global(qos: .userInitiated).async {
        var size = CGSize(width: it.media.width, height: it.media.height)
        if let tr = asset.tracks(withMediaType: .video).first {
          let r = CGRect(origin: .zero, size: tr.naturalSize).applying(tr.preferredTransform)
          size = CGSize(width: abs(r.width), height: abs(r.height))
        }
        DispatchQueue.main.async { it.pixelSize = size }
      }
    } else {
      stage.bgView.backgroundColor = it.avgColor
      if let cg = it.preview {
        applyPreview(it, cg)
      } else {
        let uri = it.media.uri
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
          let cg = SSImage.load(uri, maxPixel: 1440)
          let avg = cg.map { SSImage.stageColor($0) }
          DispatchQueue.main.async {
            guard let self = self, let cg = cg else { return }
            it.preview = cg
            it.pixelSize = CGSize(width: cg.width, height: cg.height)
            if let a = avg { it.avgColor = a }
            self.rebuildThumbs()
            guard token == self.loadToken else { return }
            self.applyPreview(it, cg)
          }
        }
      }
    }
    view.setNeedsLayout()
  }

  private func applyPreview(_ it: SSItemState, _ cg: CGImage) {
    stage.bgView.backgroundColor = it.avgColor
    stage.imageView.image = filteredImage(it.filterIdx)
    // base pequena p/ as miniaturas dos filtros
    let token = loadToken
    let uri = it.media.uri
    DispatchQueue.global(qos: .utility).async { [weak self] in
      let small = SSImage.load(uri, maxPixel: 200)
      DispatchQueue.main.async {
        guard let self = self, token == self.loadToken else { return }
        self.thumbBase = small
        self.filterThumbs.removeAll()
        self.filterStrip.reloadData()
      }
    }
    if showFilters { filterStrip.reloadData() }
  }

  private func filteredImage(_ fi: Int) -> UIImage? {
    if let c = filterCache[fi] { return c }
    guard let it = currentItem, let cg = it.preview else { return nil }
    let f = options.filters.indices.contains(fi) ? options.filters[fi] : nil
    let img = UIImage(cgImage: SSImage.filtered(cg, f))
    filterCache[fi] = img
    return img
  }

  func stageFilterImage(_ i: Int) -> UIImage? { return filteredImage(i) }

  func stageCommitFilter(_ i: Int) { selectFilter(i) }

  private func selectFilter(_ i: Int) {
    guard let it = currentItem, !it.media.isVideo, options.filters.indices.contains(i) else { return }
    if it.filterIdx != i { ssHaptic("select") }
    it.filterIdx = i
    stage.imageView.image = filteredImage(i)
    flash(options.filters[i].label)
    if showFilters {
      filterStrip.reloadData()
      filterStrip.scrollToItem(at: IndexPath(item: i, section: 0), at: .centeredHorizontally, animated: true)
    }
  }

  private func flash(_ s: String) {
    flashLabel.text = s
    flashTimer?.invalidate()
    UIView.animate(withDuration: 0.12) { self.flashLabel.alpha = 1 }
    flashTimer = Timer.scheduledTimer(withTimeInterval: 0.8, repeats: false) { [weak self] _ in
      UIView.animate(withDuration: 0.3) { self?.flashLabel.alpha = 0 }
    }
  }

  // MARK: miniaturas (várias mídias)

  private func rebuildThumbs() {
    guard mediaBuilt else { return }
    for v in thumbViews { v.removeFromSuperview() }
    thumbViews.removeAll()
    var x: CGFloat = 12
    for (i, it) in items.enumerated() {
      let b = UIButton(type: .custom)
      b.frame = CGRect(x: x, y: 2, width: 40, height: 46)
      b.layer.cornerRadius = 8
      b.clipsToBounds = true
      b.layer.borderWidth = 2
      b.imageView?.contentMode = .scaleAspectFill
      b.contentHorizontalAlignment = .fill
      b.contentVerticalAlignment = .fill
      b.backgroundColor = UIColor(white: 1, alpha: 0.1)
      if let cg = it.preview { b.setImage(UIImage(cgImage: cg), for: .normal) } else if it.media.isVideo {
        loadVideoThumb(it, into: b)
      }
      b.accessibilityLabel = "\(i + 1)"
      b.addAction(UIAction { [weak self] _ in
        guard let self = self, i != self.idx else { return }
        ssHaptic("select")
        self.showItem(i)
      }, for: .touchUpInside)
      thumbsRow.addSubview(b)
      thumbViews.append(b)
      x += 48
    }
    if options.canGallery && items.count < 10 {
      let add = UIButton(type: .system)
      add.frame = CGRect(x: x, y: 2, width: 40, height: 46)
      add.layer.cornerRadius = 8
      add.backgroundColor = UIColor(white: 1, alpha: 0.14)
      add.setImage(ssSymbol("plus", 16, .bold), for: .normal)
      add.tintColor = .white
      add.accessibilityLabel = L("gallery", "Galeria")
      add.addAction(UIAction { [weak self] _ in self?.pickFromGallery() }, for: .touchUpInside)
      thumbsRow.addSubview(add)
      thumbViews.append(add)
      x += 48
    }
    thumbsRow.contentSize = CGSize(width: x + 4, height: 50)
    paintThumbs()
    view.setNeedsLayout()
  }

  private func paintThumbs() {
    for (i, b) in thumbViews.enumerated() where i < items.count {
      b.layer.borderColor = i == idx ? UIColor.white.cgColor : UIColor.clear.cgColor
    }
  }

  private func loadVideoThumb(_ it: SSItemState, into b: UIButton) {
    guard let u = SSImage.url(it.media.uri) else { return }
    DispatchQueue.global(qos: .utility).async {
      let gen = AVAssetImageGenerator(asset: AVURLAsset(url: u))
      gen.appliesPreferredTrackTransform = true
      gen.maximumSize = CGSize(width: 160, height: 160)
      let cg = try? gen.copyCGImage(at: CMTime(seconds: 0.1, preferredTimescale: 600), actualTime: nil)
      DispatchQueue.main.async { if let cg = cg { b.setImage(UIImage(cgImage: cg), for: .normal) } }
    }
  }

  private func pickFromGallery() {
    guard items.count < 10 else { return }
    view.endEditing(true)
    request?("gallery", [:]) { [weak self] data in
      guard let self = self, !self.finished else { return }
      let raw = (data["items"] as? [Any]) ?? []
      let add = raw.compactMap { ($0 as? [String: Any]).flatMap { SSMediaIn($0) } }
      guard !add.isEmpty else { return }
      let room = max(0, 10 - self.items.count)
      let start = self.items.count
      self.items.append(contentsOf: add.prefix(room).map { SSItemState($0) })
      if self.mode == "text" { self.switchToMedia() }
      self.rebuildThumbs()
      self.showItem(min(start, self.items.count - 1))
    }
  }

  // MARK: ferramentas

  private func tapTool(_ k: String) {
    guard !busy else { return }
    switch k {
    case "text": openTextEditor(nil)
    case "stickers": openStickerTray()
    case "music": openMusic()
    case "draw": setDrawing(true)
    case "filters":
      showFilters.toggle()
      filterStrip.isHidden = !showFilters
      toolBtns["filters"]?.backgroundColor = showFilters ? .white : UIColor(white: 0, alpha: 0.32)
      toolBtns["filters"]?.tintColor = showFilters ? .black : .white
      if showFilters {
        filterStrip.reloadData()
        if let it = currentItem { filterStrip.scrollToItem(at: IndexPath(item: it.filterIdx, section: 0), at: .centeredHorizontally, animated: false) }
      }
    default: break
    }
  }

  // MARK: SSStageHost

  func stageWillMutate() {}
  func stageChanged() { stage.redraw() }
  func stageTappedEmpty() {
    if showFilters { tapTool("filters"); return }
    openTextEditor(nil)
  }
  func stageLayerTapped(_ l: SSLayer) {
    switch l.kind {
    case .text: openTextEditor(l)
    case .poll, .question, .countdown, .link, .location: openForm(l.kind, editing: l)
    case .music: openMusic()
    default: break
    }
  }
  func stageDragging(_ active: Bool) {
    UIView.animate(withDuration: 0.15) {
      self.toolRow.alpha = active ? 0 : 1
      self.closeBtn.alpha = active ? 0 : 1
      self.filterStrip.alpha = active ? 0 : 1
    }
  }

  private func nextCenter() -> (CGFloat, CGFloat) {
    let n = currentItem?.layers.count ?? 0
    let k = CGFloat(n % 5)
    return (0.5, 0.36 + 0.07 * k)
  }

  private func addLayer(_ l: SSLayer) {
    guard let it = currentItem else { return }
    let (u, v) = nextCenter()
    l.u = u
    l.v = v
    it.layers.append(l)
    stage.syncWidgets()
    stage.redraw()
    ssHaptic("light")
  }

  // MARK: desenho

  private func buildDrawUI() {
    drawTop.isHidden = true
    view.addSubview(drawTop)
    drawUndo.setImage(ssSymbol("arrow.uturn.backward", 18, .semibold), for: .normal)
    drawUndo.tintColor = .white
    drawUndo.backgroundColor = UIColor(white: 0, alpha: 0.32)
    drawUndo.layer.cornerRadius = 20
    drawUndo.accessibilityLabel = L("undo", "Desfazer")
    drawUndo.addAction(UIAction { [weak self] _ in
      guard let self = self, let it = self.currentItem, !it.strokes.isEmpty else { return }
      it.strokes.removeLast()
      ssHaptic("light")
      self.stage.redraw()
    }, for: .touchUpInside)
    drawTop.addSubview(drawUndo)
    drawDone.setTitle(L("done", "Concluir"), for: .normal)
    drawDone.setTitleColor(.black, for: .normal)
    drawDone.backgroundColor = .white
    drawDone.titleLabel?.font = .systemFont(ofSize: 15, weight: .bold)
    drawDone.layer.cornerRadius = 18
    drawDone.contentEdgeInsets = UIEdgeInsets(top: 0, left: 16, bottom: 0, right: 16)
    drawDone.addAction(UIAction { [weak self] _ in self?.setDrawing(false) }, for: .touchUpInside)
    drawTop.addSubview(drawDone)
    let brushes: [(SSBrush, String, String)] = [
      (.pen, "pencil.tip", L("brushPen", "Caneta")),
      (.marker, "highlighter", L("brushMarker", "Marca-texto")),
      (.neon, "sparkles", L("brushNeon", "Neon")),
      (.eraser, "eraser", L("brushEraser", "Borracha")),
    ]
    for (k, sym, label) in brushes {
      let b = UIButton(type: .system)
      b.setImage(ssSymbol(sym, 17, .semibold), for: .normal)
      b.layer.cornerRadius = 20
      b.accessibilityLabel = label
      b.tag = k.rawValue
      b.addAction(UIAction { [weak self] _ in
        self?.brushKind = k
        ssHaptic("select")
        self?.paintBrushes()
      }, for: .touchUpInside)
      drawTop.addSubview(b)
      brushBtns.append(b)
    }
    sizeSlider.minimumValue = 3
    sizeSlider.maximumValue = 30
    sizeSlider.value = Float(brushWidth)
    sizeSlider.minimumTrackTintColor = .white
    sizeSlider.maximumTrackTintColor = UIColor(white: 1, alpha: 0.3)
    sizeSlider.thumbTintColor = .white
    sizeSlider.transform = CGAffineTransform(rotationAngle: -.pi / 2)
    sizeSlider.isHidden = true
    sizeSlider.accessibilityLabel = L("brushSize", "Espessura")
    sizeSlider.addAction(UIAction { [weak self] _ in
      guard let self = self else { return }
      self.brushWidth = CGFloat(self.sizeSlider.value)
    }, for: .valueChanged)
    view.addSubview(sizeSlider)
    drawColors.showsHorizontalScrollIndicator = false
    drawColors.isHidden = true
    view.addSubview(drawColors)
    drawColorDots = makeColorDots(in: drawColors) { [weak self] c in
      self?.brushColor = c
      self?.paintDrawColors()
    }
    paintBrushes()
    paintDrawColors()
  }

  private func makeColorDots(in sv: UIScrollView, _ pick: @escaping (UIColor) -> Void) -> [UIButton] {
    var out: [UIButton] = []
    var x: CGFloat = 12
    for c in options.palette {
      let b = UIButton(type: .custom)
      b.frame = CGRect(x: x, y: 4, width: 30, height: 30)
      b.backgroundColor = c
      b.layer.cornerRadius = 15
      b.layer.borderWidth = 2
      b.layer.borderColor = UIColor.white.cgColor
      b.accessibilityLabel = c.ss_hexString
      b.addAction(UIAction { _ in ssHaptic("select"); pick(c) }, for: .touchUpInside)
      sv.addSubview(b)
      out.append(b)
      x += 40
    }
    sv.contentSize = CGSize(width: x + 4, height: 38)
    return out
  }

  private func paintBrushes() {
    let video = currentItem?.media.isVideo ?? false
    if video { brushKind = .pen }
    for b in brushBtns {
      let on = b.tag == brushKind.rawValue
      b.backgroundColor = on ? .white : UIColor(white: 0, alpha: 0.32)
      b.tintColor = on ? .black : .white
      b.isHidden = video && b.tag != SSBrush.pen.rawValue
    }
  }

  private func paintDrawColors() {
    for b in drawColorDots {
      let on = b.backgroundColor?.ss_hexString == brushColor.ss_hexString
      b.transform = on ? CGAffineTransform(scaleX: 1.2, y: 1.2) : .identity
      b.layer.borderWidth = on ? 3 : 2
    }
  }

  private func setDrawing(_ on: Bool) {
    drawing = on
    stage.mode = on ? .draw : .objects
    drawTop.isHidden = !on
    sizeSlider.isHidden = !on
    drawColors.isHidden = !on
    toolRow.isHidden = on
    closeBtn.isHidden = on
    if on && showFilters { tapTool("filters") }
    paintBrushes()
    view.setNeedsLayout()
  }

  private func layoutDrawUI(_ sf: CGRect) {
    drawTop.frame = CGRect(x: sf.minX, y: sf.minY + 10, width: sf.width, height: 40)
    drawUndo.frame = CGRect(x: 10, y: 0, width: 40, height: 40)
    let dw = max(96, drawDone.intrinsicContentSize.width)
    drawDone.frame = CGRect(x: sf.width - 10 - dw, y: 2, width: dw, height: 36)
    let visible = brushBtns.filter { !$0.isHidden }
    let total = CGFloat(visible.count) * 40 + CGFloat(max(0, visible.count - 1)) * 6
    var x = (sf.width - total) / 2
    for b in visible {
      b.frame = CGRect(x: x, y: 0, width: 40, height: 40)
      x += 46
    }
    // slider vertical (girado): bounds = comprimento × 30
    let len = min(220, sf.height * 0.4)
    sizeSlider.bounds = CGRect(x: 0, y: 0, width: len, height: 30)
    sizeSlider.center = CGPoint(x: sf.minX + 26, y: sf.midY)
    drawColors.frame = CGRect(x: 0, y: sf.maxY + 10, width: view.bounds.width, height: 40)
  }

  // MARK: editor de texto (camada)

  private func buildTextEditor() {
    textEditor.isHidden = true
    view.addSubview(textEditor)
    textEditorDim.backgroundColor = UIColor(white: 0, alpha: 0.55)
    textEditorDim.addTarget(self, action: #selector(commitTextEditor), for: .touchUpInside)
    textEditor.addSubview(textEditorDim)
    teFontRow.showsHorizontalScrollIndicator = false
    var x: CGFloat = 12
    for f in options.fonts {
      let b = UIButton(type: .custom)
      b.setTitle(f.label, for: .normal)
      b.titleLabel?.font = SSFont.font(f.id, size: 14)
      b.layer.cornerRadius = 15
      b.layer.borderWidth = 1
      b.contentEdgeInsets = UIEdgeInsets(top: 0, left: 12, bottom: 0, right: 12)
      let w = max(60, b.intrinsicContentSize.width)
      b.frame = CGRect(x: x, y: 3, width: w, height: 30)
      x += w + 8
      let id = f.id
      b.addAction(UIAction { [weak self] _ in self?.teLayer?.font = id; ssHaptic("select"); self?.paintTextEditor() }, for: .touchUpInside)
      teFontRow.addSubview(b)
      teFontChips.append(b)
    }
    teFontRow.contentSize = CGSize(width: x + 4, height: 36)
    textEditor.addSubview(teFontRow)
    for b in [teAlign, teBg] {
      b.tintColor = .white
      b.backgroundColor = UIColor(white: 1, alpha: 0.14)
      b.layer.cornerRadius = 18
      textEditor.addSubview(b)
    }
    teAlign.accessibilityLabel = L("align", "Alinhamento")
    teAlign.addAction(UIAction { [weak self] _ in
      guard let l = self?.teLayer else { return }
      l.align = l.align == .center ? .left : (l.align == .left ? .right : .center)
      ssHaptic("select")
      self?.paintTextEditor()
    }, for: .touchUpInside)
    teBg.accessibilityLabel = L("textBg", "Fundo do texto")
    teBg.setImage(ssSymbol("character.textbox", 17, .semibold), for: .normal)
    teBg.addAction(UIAction { [weak self] _ in
      guard let l = self?.teLayer else { return }
      l.bg = (l.bg + 1) % 3
      ssHaptic("select")
      self?.paintTextEditor()
    }, for: .touchUpInside)
    teDone.setTitle(L("done", "Concluir"), for: .normal)
    teDone.setTitleColor(.black, for: .normal)
    teDone.backgroundColor = .white
    teDone.titleLabel?.font = .systemFont(ofSize: 15, weight: .bold)
    teDone.layer.cornerRadius = 18
    teDone.contentEdgeInsets = UIEdgeInsets(top: 0, left: 16, bottom: 0, right: 16)
    teDone.addTarget(self, action: #selector(commitTextEditor), for: .touchUpInside)
    textEditor.addSubview(teDone)
    textEdit.backgroundColor = .clear
    textEdit.tintColor = .white
    textEdit.keyboardAppearance = .dark
    textEdit.isScrollEnabled = true
    textEdit.textContainerInset = UIEdgeInsets(top: 8, left: 10, bottom: 8, right: 10)
    textEdit.layer.cornerRadius = 10
    textEdit.delegate = self
    textEdit.accessibilityLabel = L("textPlaceholder", "Digite algo…")
    textEditor.addSubview(textEdit)
    teColors.showsHorizontalScrollIndicator = false
    textEditor.addSubview(teColors)
    teColorDots = makeColorDots(in: teColors) { [weak self] c in
      self?.teLayer?.color = c
      self?.paintTextEditor()
    }
  }

  private func openTextEditor(_ existing: SSLayer?) {
    guard mode == "media", !busy else { return }
    if let e = existing {
      teLayer = e
      teIsNew = false
      stage.hiddenLayerId = e.id
      stage.redraw()
    } else {
      let l = SSLayer(kind: .text, text: "")
      l.font = options.fonts.first?.id ?? "sans"
      teLayer = l
      teIsNew = true
    }
    textEdit.text = teLayer?.text
    paintTextEditor()
    textEditor.isHidden = false
    textEditor.alpha = 0
    view.bringSubviewToFront(textEditor)
    UIView.animate(withDuration: 0.18) { self.textEditor.alpha = 1 }
    textEdit.becomeFirstResponder()
  }

  private func paintTextEditor() {
    guard let l = teLayer else { return }
    for (i, b) in teFontChips.enumerated() {
      let on = options.fonts[i].id == l.font
      b.backgroundColor = on ? .white : UIColor(white: 0, alpha: 0.3)
      b.setTitleColor(on ? .black : .white, for: .normal)
      b.layer.borderColor = on ? UIColor.white.cgColor : UIColor(white: 1, alpha: 0.35).cgColor
    }
    let sym = l.align == .left ? "text.alignleft" : (l.align == .right ? "text.alignright" : "text.aligncenter")
    teAlign.setImage(ssSymbol(sym, 17, .semibold), for: .normal)
    teBg.backgroundColor = l.bg == 0 ? UIColor(white: 1, alpha: 0.14) : (l.bg == 1 ? .white : UIColor(white: 1, alpha: 0.4))
    teBg.tintColor = l.bg == 1 ? .black : .white
    for b in teColorDots {
      let on = b.backgroundColor?.ss_hexString == l.color.ss_hexString
      b.transform = on ? CGAffineTransform(scaleX: 1.2, y: 1.2) : .identity
      b.layer.borderWidth = on ? 3 : 2
    }
    let sw = max(200, stage.bounds.width)
    let fs = min(40, max(18, l.size * sw))
    let para = NSMutableParagraphStyle()
    para.alignment = l.align
    var attrs: [NSAttributedString.Key: Any] = [
      .font: SSFont.font(l.font, size: fs),
      .foregroundColor: l.bg == 1 ? SSDraw.contrastOn(l.color) : l.color,
      .paragraphStyle: para,
    ]
    if l.font == "condensed" { attrs[.kern] = -0.5 }
    if textEdit.markedTextRange == nil {
      let sel = textEdit.selectedRange
      textEdit.attributedText = NSAttributedString(string: textEdit.text ?? "", attributes: attrs)
      textEdit.selectedRange = sel
    }
    textEdit.typingAttributes = attrs
    textEdit.autocapitalizationType = l.font == "condensed" ? .allCharacters : .sentences
    textEdit.backgroundColor = l.bg == 1 ? l.color : (l.bg == 2 ? UIColor(white: 0, alpha: 0.55) : .clear)
    layoutTextEditor()
  }

  private func layoutTextEditor() {
    guard !textEditor.isHidden else { return }
    let W = view.bounds.width
    let H = view.bounds.height
    let safe = view.safeAreaInsets
    textEditorDim.frame = textEditor.bounds
    let dw = max(96, teDone.intrinsicContentSize.width)
    teDone.frame = CGRect(x: W - 14 - dw, y: safe.top + 8, width: dw, height: 36)
    teAlign.frame = CGRect(x: 14, y: safe.top + 8, width: 36, height: 36)
    teBg.frame = CGRect(x: 58, y: safe.top + 8, width: 36, height: 36)
    teFontRow.frame = CGRect(x: 0, y: safe.top + 54, width: W, height: 36)
    let bottom = H - max(kbHeight, safe.bottom) - 6
    teColors.frame = CGRect(x: 0, y: bottom - 40, width: W, height: 40)
    let top = teFontRow.frame.maxY + 10
    let avail = max(60, teColors.frame.minY - 10 - top)
    let fit = textEdit.sizeThatFits(CGSize(width: W - 48, height: .greatestFiniteMagnitude))
    let h = min(avail, max(56, fit.height))
    let w = min(W - 32, max(80, (textEdit.attributedText.length == 0 ? 120 : fit.width) + 4))
    textEdit.frame = CGRect(x: (W - w) / 2, y: top + (avail - h) / 2, width: w, height: h)
  }

  func textViewDidChange(_ tv: UITextView) {
    if tv === textEdit {
      teLayer?.text = tv.text ?? ""
      layoutTextEditor()
    }
  }

  @objc private func commitTextEditor() {
    guard let l = teLayer else { return }
    let t = (textEdit.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    textEdit.resignFirstResponder()
    l.text = t
    if let it = currentItem {
      if teIsNew {
        if !t.isEmpty { addLayer(l) }
      } else if t.isEmpty {
        it.layers.removeAll { $0 === l }
      }
    }
    teLayer = nil
    stage.hiddenLayerId = nil
    stage.syncWidgets()
    stage.redraw()
    UIView.animate(withDuration: 0.15, animations: { self.textEditor.alpha = 0 }, completion: { _ in self.textEditor.isHidden = true })
  }

  // MARK: legenda

  func textFieldShouldReturn(_ tf: UITextField) -> Bool {
    tf.resignFirstResponder()
    return true
  }

  func textField(_ tf: UITextField, shouldChangeCharactersIn range: NSRange, replacementString s: String) -> Bool {
    guard tf === captionField else { return true }
    let cur = (tf.text ?? "") as NSString
    return cur.replacingCharacters(in: range, with: s).count <= 500
  }

  // MARK: figurinhas

  private func openStickerTray() {
    view.endEditing(true)
    let sh = SSSheet()
    sh.heightFraction = 0.62
    let tray = SSStickerTray(opts: options, isVideo: currentItem?.media.isVideo ?? false)
    tray.onTool = { [weak self, weak sh] k in
      sh?.dismiss {
        guard let self = self else { return }
        switch k {
        case "mention": self.openMention()
        case "music": self.openMusic()
        case "location": self.openForm(.location, editing: nil)
        case "link": self.openForm(.link, editing: nil)
        case "poll": self.openForm(.poll, editing: nil)
        case "question": self.openForm(.question, editing: nil)
        case "countdown": self.openForm(.countdown, editing: nil)
        default: break
        }
      }
    }
    tray.onEmoji = { [weak self, weak sh] e in
      sh?.dismiss()
      self?.addLayer(SSLayer(kind: .emoji, text: e))
    }
    sh.content.addSubview(tray)
    tray.frame = sh.content.bounds
    tray.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    sh.show(in: view)
    sheet = sh
  }

  private func openMention() {
    let sh = SSSheet()
    sh.heightFraction = 0.66
    let c = SSListSheetContent(title: L("mention", "Menção"), placeholder: L("searchContacts", "Buscar contato"), emptyText: L("noContacts", "Nenhum contato"))
    let all = options.contacts
    var shown = all
    func fill(_ q: String) {
      let s = q.trimmingCharacters(in: .whitespaces).lowercased()
      shown = s.isEmpty ? all : all.filter { $0.name.lowercased().contains(s) || $0.email.lowercased().contains(s) }
      c.rows = shown.prefix(120).enumerated().map { (i, p) in
        SSRow(title: p.name, subtitle: p.email, image: "", symbol: "at", payload: i)
      }
    }
    c.onQuery = { q in fill(q) }
    sh.onGone = { [weak c] in c?.onQuery = nil; c?.onPick = nil }
    c.onPick = { [weak self, weak sh] r in
      guard r.payload < shown.count else { return }
      let p = shown[r.payload]
      let base = (p.name.isEmpty ? String(p.email.split(separator: "@").first ?? "") : p.name)
      let uname = "@" + base.replacingOccurrences(of: " ", with: "").lowercased()
      let l = SSLayer(kind: .mention, text: uname)
      l.email = p.email
      sh?.dismiss { self?.addLayer(l) }
    }
    fill("")
    sh.content.addSubview(c)
    c.frame = sh.content.bounds
    c.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    sh.show(in: view)
    sheet = sh
  }

  private func openMusic() {
    view.endEditing(true)
    let sh = SSSheet()
    sh.heightFraction = 0.7
    let c = SSListSheetContent(title: L("music", "Música"), placeholder: L("searchMusic", "Buscar música…"), emptyText: L("noTracks", "Nenhuma faixa encontrada"))
    c.debounceSec = 0.45
    var tracks = options.musicCatalog
    func show(_ ts: [SSTrack]) {
      tracks = ts
      c.rows = ts.enumerated().map { (i, t) in SSRow(title: t.title, subtitle: t.artist, image: t.coverUrl, symbol: "music.note", payload: i) }
    }
    var seq = 0
    c.onQuery = { [weak self] q in
      let s = q.trimmingCharacters(in: .whitespaces)
      if s.isEmpty { show(self?.options.musicCatalog ?? []); return }
      seq += 1
      let my = seq
      c.spinner.startAnimating()
      self?.request?("musicSearch", ["q": s]) { data in
        guard my == seq else { return }
        c.spinner.stopAnimating()
        let ts = ((data["tracks"] as? [Any]) ?? []).compactMap { ($0 as? [String: Any]).map { SSTrack($0) } }.filter { !$0.title.isEmpty }
        show(ts)
      }
    }
    c.onPick = { [weak self, weak sh] r in
      guard let self = self, r.payload < tracks.count, let it = self.currentItem else { return }
      let t = tracks[r.payload]
      // uma música por status: substitui a anterior (em qualquer mídia)
      for x in self.items { x.layers.removeAll { $0.kind == .music } }
      let l = SSLayer(kind: .music, text: t.title)
      l.artist = t.artist
      l.cover = t.coverUrl
      l.preview = t.previewUrl
      self.startMs = 0
      sh?.dismiss {
        l.u = 0.5
        l.v = 0.78
        it.layers.append(l)
        self.stage.syncWidgets()
        ssHaptic("light")
      }
    }
    show(tracks)
    sh.onGone = { [weak c] in c?.onQuery = nil; c?.onPick = nil }
    sh.content.addSubview(c)
    c.frame = sh.content.bounds
    c.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    sh.show(in: view)
    sheet = sh
  }

  /// Formulário com prévia ao vivo (enquete, pergunta, contagem, link, local).
  private func openForm(_ kind: SSKind, editing: SSLayer?) {
    view.endEditing(true)
    let draft = editing?.copy() ?? SSLayer(kind: kind, text: "")
    var placeholders: [String] = []
    var values: [String] = []
    var date: Date?
    var extra: String?
    switch kind {
    case .poll:
      placeholders = [L("pollQuestion", "Faça uma pergunta…"), L("optionA", "Opção 1"), L("optionB", "Opção 2")]
      if editing == nil {
        draft.text = L("pollDefault", "Sim ou não?")
        draft.optionA = L("yes", "Sim")
        draft.optionB = L("no", "Não")
      }
      values = [draft.text, draft.optionA, draft.optionB]
    case .question:
      placeholders = [L("questionDefault", "Me pergunte algo…")]
      if editing == nil { draft.text = L("questionDefault", "Me pergunte algo…") }
      values = [draft.text]
    case .countdown:
      placeholders = [L("countdownLabel", "Nome do evento")]
      if editing == nil {
        draft.text = L("countdownDefault", "Evento")
        draft.target = Calendar.current.date(byAdding: .day, value: 1, to: Date())
      }
      values = [draft.text]
      date = draft.target ?? Date().addingTimeInterval(86400)
    case .link:
      placeholders = ["https://", L("linkLabel", "Texto do botão (opcional)")]
      values = [draft.url, draft.text == draft.url ? "" : draft.text]
    case .location:
      placeholders = [L("locationPlaceholder", "Onde você está?")]
      values = [draft.text]
      extra = L("useMyLocation", "Usar minha localização")
    default:
      return
    }
    let f = SSFormOverlay(opts: options, placeholders: placeholders, values: values, date: date, extra: extra)
    f.frame = view.bounds
    f.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    let previewOf: () -> (UIView, CGSize) = { [weak self] in
      guard let self = self else { return (UIView(), .zero) }
      if kind.burns {
        // local: desenha a pílula num bitmap
        let W = max(200, self.stage.bounds.width)
        let lay = SSDraw.layout(draft, W: W)
        let size = CGSize(width: lay.box.width * 2 + 8, height: lay.box.height * 2 + 8)
        let img = UIGraphicsImageRenderer(size: size).image { r in
          SSDraw.drawLayer(draft, center: CGPoint(x: size.width / 2, y: size.height / 2), W: W, in: r.cgContext)
        }
        let iv = UIImageView(image: img)
        return (iv as UIView, size)
      }
      let w = SSWidgetView.make(draft, self.options) ?? SSWidgetView()
      return (w as UIView, w.blockSize)
    }
    let sync: () -> Void = { [weak f] in
      guard let f = f else { return }
      let v = f.fields.map { $0.text ?? "" }
      switch kind {
      case .poll:
        draft.text = v[0]
        draft.optionA = v[1]
        draft.optionB = v[2]
      case .question, .location:
        draft.text = v[0]
      case .countdown:
        draft.text = v[0]
        draft.target = f.datePicker.date
      case .link:
        var u = v[0].trimmingCharacters(in: .whitespaces)
        if !u.isEmpty && !u.lowercased().hasPrefix("http") { u = "https://" + u }
        draft.url = u
        let lbl = v[1].trimmingCharacters(in: .whitespaces)
        draft.text = lbl.isEmpty ? String(u.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: "").prefix(32)) : String(lbl.prefix(40))
      default: break
      }
      let (pv, ps) = previewOf()
      f.setPreview(pv, size: ps)
    }
    f.onChange = sync
    f.validate = {
      sync()
      switch kind {
      case .poll:
        return !draft.optionA.trimmingCharacters(in: .whitespaces).isEmpty && !draft.optionB.trimmingCharacters(in: .whitespaces).isEmpty
      case .question, .location, .countdown:
        return !draft.text.trimmingCharacters(in: .whitespaces).isEmpty
      case .link:
        let u = draft.url
        return u.count > 10 && u.contains(".") && URL(string: u) != nil
      default: return true
      }
    }
    f.onCancel = { [weak self, weak f] in
      f?.removeFromSuperview()
      self?.form = nil
    }
    f.onDone = { [weak self, weak f] in
      guard let self = self else { return }
      f?.removeFromSuperview()
      self.form = nil
      draft.text = String(draft.text.prefix(kind == .poll ? 200 : 120)).trimmingCharacters(in: .whitespaces)
      draft.optionA = String(draft.optionA.prefix(80)).trimmingCharacters(in: .whitespaces)
      draft.optionB = String(draft.optionB.prefix(80)).trimmingCharacters(in: .whitespaces)
      if let e = editing {
        e.text = draft.text; e.optionA = draft.optionA; e.optionB = draft.optionB
        e.target = draft.target; e.url = draft.url
        self.stage.syncWidgets()
        self.stage.redraw()
      } else {
        let l = SSLayer(kind: kind, text: draft.text)
        l.optionA = draft.optionA; l.optionB = draft.optionB; l.target = draft.target; l.url = draft.url
        self.addLayer(l)
      }
    }
    f.onExtra = { [weak self, weak f] in
      guard let self = self else { return }
      self.request?("location", [:]) { data in
        let label = (data["label"] as? String) ?? ""
        guard let f = f, !label.isEmpty, let fld = f.fields.first else { return }
        fld.text = label
        sync()
      }
    }
    view.addSubview(f)
    form = f
    sync()
    f.fields.first?.becomeFirstResponder()
  }

  // MARK: filtros (faixa)

  func collectionView(_ cv: UICollectionView, numberOfItemsInSection s: Int) -> Int { return options.filters.count }

  func collectionView(_ cv: UICollectionView, cellForItemAt ip: IndexPath) -> UICollectionViewCell {
    let c = cv.dequeueReusableCell(withReuseIdentifier: "f", for: ip) as! SSFilterCell
    let i = ip.item
    c.label.text = options.filters[i].label
    c.setOn(currentItem?.filterIdx == i)
    if let t = filterThumbs[i] { c.image.image = t } else if let base = thumbBase {
      let f = options.filters[i]
      let t = UIImage(cgImage: SSImage.filtered(base, f))
      filterThumbs[i] = t
      c.image.image = t
    } else {
      c.image.image = nil
    }
    return c
  }

  func collectionView(_ cv: UICollectionView, didSelectItemAt ip: IndexPath) {
    selectFilter(ip.item)
  }

  // MARK: ocupado

  private func buildBusy() {
    busyView.backgroundColor = UIColor(white: 0, alpha: 0.6)
    busyView.isHidden = true
    busySpinner.color = .white
    busyView.addSubview(busySpinner)
    busyLabel.text = L("processing", "Preparando…")
    busyLabel.textColor = .white
    busyLabel.font = .systemFont(ofSize: 15, weight: .semibold)
    busyLabel.textAlignment = .center
    busyView.addSubview(busyLabel)
    view.addSubview(busyView)
  }

  private func setBusy(_ on: Bool) {
    busy = on
    stage.mode = on ? .locked : (drawing ? .draw : .objects)
    busyView.isHidden = !on
    view.bringSubviewToFront(busyView)
    if on { busySpinner.startAnimating(); player?.pause() } else { busySpinner.stopAnimating(); player?.play() }
  }

  // MARK: - PUBLICAR

  private func publish() {
    guard !busy, !finished else { return }
    if audience == "close_friends" && closeFriendsCount == 0 {
      ssHaptic("warn")
      openAudience()
      return
    }
    view.endEditing(true)
    if mode == "text" {
      guard let c = composer, !c.trimmed.isEmpty else { return }
      let text = String(c.trimmed.prefix(options.textMax))
      if c.needsImage {
        setBusy(true)
        let img = c.renderImage()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
          let u = SSImage.writeJPEG(img, quality: 0.92)
          DispatchQueue.main.async {
            guard let self = self else { return }
            guard let u = u, let cg = img.cgImage else { self.setBusy(false); self.toast(self.L("publishFailed", "Não foi possível publicar o status.")); return }
            ssHaptic("success")
            let one: [String: Any] = [
              "kind": "image", "uri": u.absoluteString, "width": cg.width, "height": cg.height, "mime": "image/jpeg",
              "stickers": [Any](), "textOverlays": [Any](), "drawPaths": [Any](), "mentions": [Any](),
            ]
            self.finish(["action": "publish", "audience": self.audience, "caption": "", "music": NSNull(), "items": [one]])
          }
        }
        return
      }
      ssHaptic("success")
      finish(["action": "publish", "audience": audience, "caption": "", "music": NSNull(),
              "text": ["text": text, "bg": c.bgValue, "font": c.font, "align": c.alignValue]])
      return
    }
    guard !items.isEmpty else { return }
    setBusy(true)
    let stageSize = stage.bounds.size
    let screen = UIScreen.main.bounds.size
    let caption = String((captionField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(500))
    // JSON no main (blocos medem UIViews); exportação pesada no background.
    var jobs: [(SSItemState, [SSLayer], [SSStroke], [String: Any])] = []
    var music: Any = NSNull()
    for it in items {
      let layers = it.layers.map { $0.copy() }
      var meta = buildJSON(it, layers: layers, stage: stageSize, screen: screen)
      if let m = layers.first(where: { $0.kind == .music }) {
        music = ["title": m.text, "artist": m.artist, "previewUrl": m.preview, "coverUrl": m.cover, "startMs": startMs] as [String: Any]
      }
      if it.media.boomerang { meta["boomerang"] = true }
      jobs.append((it, layers, it.strokes, meta))
    }
    let filters = options.filters
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      var out: [[String: Any]] = []
      var failed = false
      for (it, layers, strokes, meta) in jobs {
        var d = meta
        if it.media.isVideo {
          d["kind"] = "video"
          d["uri"] = it.media.uri
          d["width"] = Int(it.pixelSize.width > 0 ? it.pixelSize.width : it.media.width)
          d["height"] = Int(it.pixelSize.height > 0 ? it.pixelSize.height : it.media.height)
          d["mime"] = it.media.uri.lowercased().hasSuffix(".mov") ? "video/quicktime" : "video/mp4"
        } else {
          let f = filters.indices.contains(it.filterIdx) ? filters[it.filterIdx] : nil
          guard let r = SSStudioController.exportPhoto(it, filter: f, layers: layers, strokes: strokes, stage: stageSize) else { failed = true; break }
          d["kind"] = "image"
          d["uri"] = r.0
          d["width"] = r.1
          d["height"] = r.2
          d["mime"] = "image/jpeg"
          if let f = f, !f.isIdentity { d["filter"] = f.id }
        }
        out.append(d)
      }
      DispatchQueue.main.async {
        guard let self = self else { return }
        if failed || out.isEmpty {
          self.setBusy(false)
          self.toast(self.L("publishFailed", "Não foi possível publicar o status."))
          return
        }
        ssHaptic("success")
        self.finish(["action": "publish", "audience": self.audience, "caption": caption, "music": music, "items": out])
      }
    }
  }

  /// JSON do viewer (espaço da tela cheia) para UMA mídia.
  private func buildJSON(_ it: SSItemState, layers: [SSLayer], stage s: CGSize, screen: CGSize) -> [String: Any] {
    let W = max(1, s.width)
    let H = max(1, s.height)
    let sx = screen.width / W
    let sy = screen.height / H
    let k = W / max(1, screen.width)
    var stickers: [[String: Any]] = []
    var texts: [[String: Any]] = []
    var mentions: [String] = []
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    for l in layers {
      if l.kind.isWidget {
        if l.kind == .music { continue }
        let bs = (SSWidgetView.make(l, options)?.blockSize) ?? CGSize(width: 200, height: 40)
        let left = l.u * W - bs.width * k / 2
        let top = l.v * H - bs.height * k / 2
        var d: [String: Any] = ["id": l.id, "x": Int((left * sx).rounded()), "y": Int((top * sy).rounded())]
        switch l.kind {
        case .mention:
          d["type"] = "mention"
          d["username"] = l.text.hasPrefix("@") ? l.text : "@" + l.text
          if !l.email.isEmpty { d["email"] = l.email; mentions.append(l.email.lowercased()) }
        case .link:
          d["type"] = "link"
          d["url"] = l.url
          if !l.text.isEmpty { d["label"] = l.text }
        case .poll:
          d["type"] = "poll"
          d["question"] = l.text
          d["optionA"] = l.optionA
          d["optionB"] = l.optionB
        case .question:
          d["type"] = "question"
          d["prompt"] = l.text
        case .countdown:
          d["type"] = "countdown"
          d["label"] = l.text
          d["targetDate"] = iso.string(from: l.target ?? Date().addingTimeInterval(86400))
        default: continue
        }
        stickers.append(d)
      } else if it.media.isVideo {
        // vídeo não é reencodado: camadas viram blocos do viewer
        let lay = SSDraw.layout(l, W: W)
        let left = l.u * W - lay.box.width
        let top = l.v * H - lay.box.height
        let x = Int((left * sx).rounded())
        let y = Int((top * sy).rounded())
        switch l.kind {
        case .text:
          texts.append(["text": l.text, "x": x, "y": y, "color": (l.bg == 1 ? SSDraw.contrastOn(l.color) : l.color).ss_hexString])
        case .location:
          texts.append(["text": l.text.uppercased(), "x": x, "y": y, "color": "#FFFFFF"])
        case .emoji:
          stickers.append(["type": "emoji", "id": l.id, "emoji": l.text, "x": x, "y": y])
        default: break
        }
      }
    }
    var d: [String: Any] = ["stickers": stickers, "mentions": Array(Set(mentions))]
    if it.media.isVideo {
      var paths: [[String: Any]] = []
      for st in it.strokes where st.brush != .eraser && st.pts.count >= 2 {
        let pts = st.pts.map { ["x": Int(($0.x * screen.width).rounded()), "y": Int(($0.y * screen.height).rounded())] }
        paths.append(["color": st.color.ss_hexString, "points": pts])
      }
      d["textOverlays"] = texts
      d["drawPaths"] = paths
    } else {
      d["textOverlays"] = [Any]()
      d["drawPaths"] = [Any]()
    }
    return d
  }

  /// Foto final: com camada queimada → 1080×1920 (palco); senão filtrada no tamanho original.
  nonisolated static func exportPhoto(_ it: SSItemState, filter: SSFilter?, layers: [SSLayer], strokes: [SSStroke], stage s: CGSize) -> (String, Int, Int)? {
    guard let full = SSImage.load(it.media.uri, maxPixel: 2560) else { return nil }
    let filtered = SSImage.filtered(full, filter)
    let burn = layers.filter { $0.kind.burns }
    if burn.isEmpty && strokes.isEmpty {
      let img = UIImage(cgImage: filtered)
      guard let u = SSImage.writeJPEG(img, quality: 0.9) else { return nil }
      return (u.absoluteString, filtered.width, filtered.height)
    }
    let W = max(1, s.width)
    let H = max(1, s.height)
    let scale = 1080 / W
    let fmt = UIGraphicsImageRendererFormat.default()
    fmt.scale = scale
    fmt.opaque = true
    let photo = UIImage(cgImage: filtered)
    let strokesImg = SSDraw.strokesImage(strokes, size: CGSize(width: W, height: H), scale: scale)
    let out = UIGraphicsImageRenderer(size: CGSize(width: W, height: H), format: fmt).image { r in
      let ctx = r.cgContext
      it.avgColor.setFill()
      ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
      photo.draw(in: SSImage.fitRect(CGSize(width: filtered.width, height: filtered.height), in: CGRect(x: 0, y: 0, width: W, height: H)))
      strokesImg?.draw(in: CGRect(x: 0, y: 0, width: W, height: H))
      for l in burn {
        SSDraw.drawLayer(l, center: CGPoint(x: l.u * W, y: l.v * H), W: W, in: ctx)
      }
    }
    guard let u = SSImage.writeJPEG(out, quality: 0.9) else { return nil }
    return (u.absoluteString, Int((W * scale).rounded()), Int((H * scale).rounded()))
  }

  private func toast(_ s: String) {
    let l = UILabel()
    l.text = "  \(s)  "
    l.textColor = .white
    l.font = .systemFont(ofSize: 14, weight: .semibold)
    l.backgroundColor = UIColor(white: 0.15, alpha: 0.95)
    l.layer.cornerRadius = 16
    l.clipsToBounds = true
    l.textAlignment = .center
    l.numberOfLines = 2
    let w = min(view.bounds.width - 40, l.intrinsicContentSize.width + 8)
    l.frame = CGRect(x: (view.bounds.width - w) / 2, y: view.safeAreaInsets.top + 60, width: w, height: 40)
    view.addSubview(l)
    UIView.animate(withDuration: 0.3, delay: 2.2, options: [], animations: { l.alpha = 0 }, completion: { _ in l.removeFromSuperview() })
  }
}

final class SSFilterCell: UICollectionViewCell {
  let image = UIImageView()
  let label = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    image.contentMode = .scaleAspectFill
    image.clipsToBounds = true
    image.layer.cornerRadius = 10
    image.layer.borderWidth = 2
    image.backgroundColor = UIColor(white: 1, alpha: 0.1)
    contentView.addSubview(image)
    label.font = .systemFont(ofSize: 11, weight: .semibold)
    label.textColor = UIColor(white: 1, alpha: 0.8)
    label.textAlignment = .center
    label.layer.shadowColor = UIColor.black.cgColor
    label.layer.shadowOpacity = 0.6
    label.layer.shadowRadius = 3
    label.layer.shadowOffset = .zero
    contentView.addSubview(label)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  func setOn(_ on: Bool) {
    image.layer.borderColor = on ? UIColor.white.cgColor : UIColor.clear.cgColor
    label.textColor = on ? .white : UIColor(white: 1, alpha: 0.8)
    label.font = .systemFont(ofSize: 11, weight: on ? .heavy : .semibold)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    image.frame = CGRect(x: 3, y: 0, width: 60, height: 64)
    label.frame = CGRect(x: 0, y: 66, width: bounds.width, height: 16)
  }
}
