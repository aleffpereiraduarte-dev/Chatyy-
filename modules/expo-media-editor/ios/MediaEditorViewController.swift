import AVFoundation
import UIKit

// [2026-10-15 native-editor] Editor de foto/vídeo antes de enviar (chat e
// status), tela cheia, estética P&B, ícones SF Symbols (nunca emoji na UI).
// Foto: recortar/girar (proporções), desenhar, texto, figurinhas, filtros
// (CIColorMatrix com as MESMAS matrizes do status). Vídeo: aparar com trilho
// de miniaturas (AVAssetImageGenerator), mudo, capa. Modo "compose": legenda +
// ver uma vez + HD + enviar; modo "edit": Concluir. Resultado entregue UMA vez.

struct MEOptions {
  var uri = ""
  var isVideo = false
  var compose = true
  var caption = ""
  var captionMax = 1024
  var viewOnce = false
  var allowViewOnce = true
  var hd = false
  var allowHd = true
  var filters: [MEFilter] = []
  var stickers: [String] = []
  var labels: [String: String] = [:]
  var maxDim = 3072
  var hdMaxDim = 4096
  var quality: CGFloat = 0.92
  var secure = false
  var tools: [String: Bool] = [:]
  /// [2026-10-15 circle-crop] cropShape 'circle' (só foto): 1:1 travado, máscara
  /// circular no recorte, abre já na ferramenta de recorte. Exporta JPEG quadrado.
  var circleCrop = false

  func tool(_ k: String) -> Bool { return tools[k] ?? true }

  static func num(_ v: Any?) -> Double? {
    if let n = v as? NSNumber { return n.doubleValue }
    if let s = v as? String { return Double(s) }
    return nil
  }

  init() {}

  init(dict o: [String: Any]) {
    uri = (o["uri"] as? String) ?? ""
    isVideo = ((o["type"] as? String) ?? "image") == "video"
    compose = ((o["mode"] as? String) ?? "compose") == "compose"
    caption = (o["caption"] as? String) ?? ""
    captionMax = Int(MEOptions.num(o["captionMax"]) ?? 1024)
    viewOnce = (o["viewOnce"] as? Bool) ?? false
    allowViewOnce = (o["allowViewOnce"] as? Bool) ?? true
    hd = (o["hd"] as? Bool) ?? false
    allowHd = (o["allowHd"] as? Bool) ?? true
    if let l = o["labels"] as? [String: Any] {
      for (k, v) in l { if let s = v as? String { labels[k] = s } }
    }
    var fs: [MEFilter] = []
    if let arr = o["filters"] as? [[String: Any]] {
      for f in arr {
        guard let id = f["id"] as? String else { continue }
        let label = (f["label"] as? String) ?? id
        var m: [CGFloat]? = nil
        if id != "original", let raw = f["m"] as? [Any] {
          let vals = raw.compactMap { MEOptions.num($0) }.map { CGFloat($0) }
          if vals.count == 20 { m = vals }
        }
        if id == "original" {
          fs.removeAll { $0.id == "original" }
          fs.insert(MEFilter(id: id, label: label, m: nil), at: 0)
        } else {
          fs.append(MEFilter(id: id, label: label, m: m))
        }
      }
    }
    if let first = fs.first, first.id != "original" {
      fs.insert(MEFilter(id: "original", label: labels["filterOriginal"] ?? "Original", m: nil), at: 0)
    }
    filters = fs
    if let s = o["stickers"] as? [Any] {
      stickers = Array(s.compactMap { $0 as? String }.filter { !$0.isEmpty }.prefix(64))
    }
    maxDim = min(8192, max(640, Int(MEOptions.num(o["maxDim"]) ?? 3072)))
    hdMaxDim = min(8192, max(640, Int(MEOptions.num(o["hdMaxDim"]) ?? 4096)))
    quality = CGFloat(min(1, max(0.4, MEOptions.num(o["quality"]) ?? 0.92)))
    secure = (o["secure"] as? Bool) ?? false
    if let t = o["tools"] as? [String: Any] {
      for (k, v) in t { if let b = v as? Bool { tools[k] = b } }
    }
    circleCrop = !isVideo && ((o["cropShape"] as? String) ?? "rect") == "circle"
    if circleCrop { tools["crop"] = true }
  }
}

final class MediaEditorViewController: UIViewController, MECanvasHost, MERailDelegate, UITextViewDelegate {

  enum Tool { case none, crop, draw, filter, sticker }

  static let palette: [UIColor] = [
    .white, .black,
    UIColor(red: 1, green: 0.23, blue: 0.19, alpha: 1), UIColor(red: 1, green: 0.58, blue: 0, alpha: 1),
    UIColor(red: 1, green: 0.8, blue: 0, alpha: 1), UIColor(red: 0.2, green: 0.78, blue: 0.35, alpha: 1),
    UIColor(red: 0.04, green: 0.52, blue: 1, alpha: 1), UIColor(red: 0.69, green: 0.32, blue: 0.87, alpha: 1),
  ]
  static let penSizes: [CGFloat] = [4, 8, 14]
  static let defaultStickers: [String] = [
    "\u{1F600}", "\u{1F602}", "\u{1F60D}", "\u{1F973}", "\u{1F525}", "\u{2728}", "\u{2764}\u{FE0F}", "\u{1F44D}",
    "\u{1F44F}", "\u{1F389}", "\u{1F4AF}", "\u{2B50}", "\u{1F60E}", "\u{1F929}", "\u{1F64C}", "\u{1F618}",
    "\u{1F62D}", "\u{1F631}", "\u{1F914}", "\u{1F644}", "\u{1F64F}", "\u{1F4AA}", "\u{1F339}", "\u{1F388}",
  ]
  static let ratios: [(String, CGFloat)] = [("free", 0), ("orig", -1), ("1:1", 1), ("4:3", 4.0 / 3.0), ("3:4", 3.0 / 4.0), ("16:9", 16.0 / 9.0), ("9:16", 9.0 / 16.0)]
  static let fontKeys: [(String, String)] = [("fontClassic", "Clássico"), ("fontModern", "Moderno"), ("fontSerif", "Serifa"), ("fontMono", "Máquina"), ("fontStrong", "Forte")]

  var onFinish: (([String: Any]) -> Void)?
  private let opts: MEOptions
  private var finished = false
  private var busy = false

  // ── foto ──
  var editorState = MEState()
  private var history: [MEState] = []
  private var baseImage: CGImage?
  private var rotatedCache: (Int, CGImage)?
  private var displayGen = 0
  private var tool: Tool = .none
  var brushColor: UIColor = .white
  private var brushIdx = 1
  var brushWidth: CGFloat { return MediaEditorViewController.penSizes[max(0, min(2, brushIdx))] }
  private var editingObj = -1
  private var txtColor: UIColor = .white
  private var txtFont = 0
  private var txtBg = 0
  private var ratioSel = "free"

  // ── vídeo ──
  private var asset: AVURLAsset?
  private var player: AVPlayer?
  private let playerLayer = AVPlayerLayer()
  private var timeObs: Any?
  private var durationMs: Double = 0
  private var trimStart: Double = 0
  private var trimEnd: Double = 0
  private var muted = false
  private var coverMs: Double = -1
  private var userPaused = false
  private var coverMode = false
  private var hasAudio = false
  private var videoSize: CGSize = .zero
  private var thumbGen: AVAssetImageGenerator?

  // ── compose ──
  private var viewOnce: Bool
  private var hd: Bool

  // ── views ──
  private let topBar = UIView()
  private let stage = UIView()
  private var canvas: MECanvasView?
  private let videoView = UIView()
  private let playBadge = UIImageView()
  private let panelHost = UIView()
  private var panels: [String: UIView] = [:]
  private let bottomBar = UIView()
  private let captionView = UITextView()
  private let captionPlaceholder = UILabel()
  private let viewOnceBtn = UIButton(type: .custom)
  private let viewOnceHint = UILabel()
  private let sendBtn = UIButton(type: .custom)
  private let doneBtn = UIButton(type: .custom)
  private let trashView = UIView()
  private let trashIcon = UIImageView()
  private let busyView = UIView()
  private let shield = UIView()
  private var undoBtn: UIButton?
  private var toolButtons: [String: UIButton] = [:]
  private var hdBtn: UIButton?
  private var soundBtn: UIButton?
  private var rail: MERailView?
  private let timeLabel = UILabel()
  private var coverBtn: UIButton?
  private let coverThumb = UIImageView()
  private var filterCells: [(UIView, UIImageView, UILabel)] = []
  private var ratioButtons: [(String, UIButton)] = []
  private var drawRow: UIStackView?
  private var kbHeight: CGFloat = 0

  // ── texto ──
  private let textOverlay = UIView()
  private let textView = UITextView()
  private let fontBtn = UIButton(type: .custom)
  private let bgBtn = UIButton(type: .custom)
  private let textDone = UIButton(type: .custom)
  private let textPalette = UIStackView()

  init(options: MEOptions) {
    opts = options
    viewOnce = options.viewOnce
    hd = options.hd
    super.init(nibName: nil, bundle: nil)
    modalPresentationStyle = .fullScreen
    modalTransitionStyle = .crossDissolve
    isModalInPresentation = true
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var preferredStatusBarStyle: UIStatusBarStyle { return .lightContent }
  override var prefersStatusBarHidden: Bool { return false }

  private func L(_ k: String, _ fb: String) -> String {
    if let s = opts.labels[k], !s.isEmpty { return s }
    return fb
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    if let o = timeObs { player?.removeTimeObserver(o) }
  }

  // ─── ciclo de vida ──────────────────────────────────────────────────────

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    view.addSubview(stage)
    view.addSubview(panelHost)
    view.addSubview(bottomBar)
    view.addSubview(topBar)
    buildTopBar()
    if opts.isVideo { buildVideo() } else { buildPhoto() }
    buildBottom()
    buildTextOverlay()
    buildBusy()
    NotificationCenter.default.addObserver(self, selector: #selector(kbChange(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(kbHide(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(appBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
    if opts.secure {
      shield.backgroundColor = .black
      shield.isHidden = !UIScreen.main.isCaptured
      view.addSubview(shield)
      NotificationCenter.default.addObserver(self, selector: #selector(captureChanged), name: UIScreen.capturedDidChangeNotification, object: nil)
    }
    if opts.isVideo { loadVideo() } else { loadPhoto() }
  }

  @objc private func captureChanged() {
    shield.isHidden = !UIScreen.main.isCaptured
    if UIScreen.main.isCaptured { player?.pause() }
  }

  @objc private func appBackground() {
    player?.pause()
  }

  private func finish(_ result: [String: Any]) {
    guard !finished else { return }
    finished = true
    view.endEditing(true)
    player?.pause()
    if let o = timeObs { player?.removeTimeObserver(o); timeObs = nil }
    thumbGen?.cancelAllCGImageGeneration()
    let cb = onFinish
    onFinish = nil
    var delivered = false
    let deliverOnce: () -> Void = {
      if delivered { return }
      delivered = true
      cb?(result)
    }
    if presentingViewController == nil {
      // VC já fora da hierarquia → entrega direto.
      deliverOnce()
    } else {
      dismiss(animated: true) { deliverOnce() }
      // Rede de segurança: se o dismiss não completar (outro modal por cima).
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { deliverOnce() }
    }
  }

  func closeFromJS() {
    finish(["action": "cancel", "reason": "js"])
  }

  private func hasChanges() -> Bool {
    if opts.isVideo {
      return muted || coverMs >= 0 || trimStart > 0 || (durationMs > 0 && trimEnd < durationMs - 50)
    }
    return !editorState.isPristine
  }

  private func requestClose() {
    let captionDirty = !captionView.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && opts.caption.isEmpty
    if !hasChanges() && !captionDirty { finish(["action": "cancel"]); return }
    let a = UIAlertController(title: L("discardTitle", "Descartar alterações?"), message: nil, preferredStyle: .alert)
    a.addAction(UIAlertAction(title: L("cancel", "Cancelar"), style: .cancel, handler: nil))
    a.addAction(UIAlertAction(title: L("discard", "Descartar"), style: .destructive, handler: { [weak self] _ in
      self?.finish(["action": "cancel"])
    }))
    present(a, animated: true, completion: nil)
  }

  // ─── teclado / layout ───────────────────────────────────────────────────

  @objc private func kbChange(_ n: Notification) {
    guard let end = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
    let r = view.convert(end, from: nil)
    kbHeight = max(0, view.bounds.maxY - r.minY)
    animateLayout(n)
  }

  @objc private func kbHide(_ n: Notification) {
    kbHeight = 0
    animateLayout(n)
  }

  private func animateLayout(_ n: Notification) {
    let dur = (n.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
    view.setNeedsLayout()
    UIView.animate(withDuration: dur) { self.view.layoutIfNeeded() }
  }

  private func panelHeight() -> CGFloat {
    if opts.isVideo { return opts.tool("trim") || opts.tool("cover") ? 104 : 0 }
    switch tool {
    case .filter: return 104
    case .draw: return 52
    case .crop: return 92
    case .sticker:
      let n = (opts.stickers.isEmpty ? MediaEditorViewController.defaultStickers : opts.stickers).count
      return CGFloat(min(3, (n + 7) / 8)) * 48 + 14
    case .none: return 0
    }
  }

  private func captionHeight() -> CGFloat {
    let w = max(100, view.bounds.width - 20 - (opts.allowViewOnce ? 44 : 0) - 58)
    let h = captionView.sizeThatFits(CGSize(width: w, height: .greatestFiniteMagnitude)).height
    return min(120, max(44, h))
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    let W = view.bounds.width
    let H = view.bounds.height
    let safe = view.safeAreaInsets
    topBar.frame = CGRect(x: 0, y: safe.top, width: W, height: 52)
    layoutTopBar()
    let bottomInset = max(safe.bottom, kbHeight)
    let showBottom = tool == .none || tool == .filter
    var bh: CGFloat = 0
    if showBottom {
      if opts.compose {
        let ch = captionHeight()
        bh = ch + 18 + (viewOnce ? 22 : 0)
        let rowY: CGFloat = 8
        let sendX = W - 10 - 50
        sendBtn.frame = CGRect(x: sendX, y: rowY + ch - 47, width: 50, height: 50)
        var right = sendX - 8
        if opts.allowViewOnce {
          viewOnceBtn.frame = CGRect(x: right - 36, y: rowY + ch - 40, width: 36, height: 36)
          right = viewOnceBtn.frame.minX - 8
        }
        captionView.frame = CGRect(x: 10, y: rowY, width: max(60, right - 10), height: ch)
        captionPlaceholder.frame = CGRect(x: 26, y: rowY, width: max(40, right - 42), height: 44)
        viewOnceHint.frame = CGRect(x: 10, y: rowY + ch + 6, width: W - 20, height: 16)
        viewOnceHint.isHidden = !viewOnce
      } else {
        bh = 64
        let w = max(120, doneBtn.intrinsicContentSize.width + 44)
        doneBtn.frame = CGRect(x: W - 12 - w, y: 10, width: w, height: 44)
      }
    }
    bottomBar.isHidden = !showBottom
    bottomBar.frame = CGRect(x: 0, y: H - bottomInset - bh, width: W, height: bh)
    let ph = panelHeight()
    panelHost.frame = CGRect(x: 0, y: bottomBar.frame.minY - ph, width: W, height: ph)
    for (_, p) in panels { p.frame = panelHost.bounds }
    layoutPanels()
    stage.frame = CGRect(x: 0, y: topBar.frame.maxY, width: W, height: max(80, panelHost.frame.minY - topBar.frame.maxY))
    canvas?.frame = stage.bounds
    videoView.frame = stage.bounds
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    playerLayer.frame = videoView.bounds
    CATransaction.commit()
    playBadge.frame = CGRect(x: stage.bounds.midX - 32, y: stage.bounds.midY - 32, width: 64, height: 64)
    trashView.frame = CGRect(x: stage.bounds.midX - 30, y: stage.bounds.maxY - 64 - 30, width: 60, height: 60)
    textOverlay.frame = view.bounds
    layoutTextOverlay()
    busyView.frame = view.bounds
    shield.frame = view.bounds
  }

  // ─── helpers de UI ──────────────────────────────────────────────────────

  private func iconButton(_ name: String, _ label: String, size: CGFloat = 20, action: @escaping () -> Void) -> UIButton {
    let b = UIButton(type: .system)
    b.setImage(MEIcon.image(name, size: size), for: .normal)
    b.tintColor = .white
    b.accessibilityLabel = label
    b.layer.cornerRadius = 20
    b.addAction(UIAction { [weak self] _ in
      guard let self = self, !self.busy else { return }
      action()
    }, for: .touchUpInside)
    return b
  }

  private func pillLabelButton(_ title: String, dark: Bool) -> UIButton {
    let b = UIButton(type: .custom)
    b.setTitle(title, for: .normal)
    b.titleLabel?.font = UIFont.systemFont(ofSize: 14, weight: .bold)
    b.setTitleColor(dark ? .white : .black, for: .normal)
    b.backgroundColor = dark ? UIColor(white: 1, alpha: 0.14) : .white
    b.layer.cornerRadius = 15
    b.contentEdgeInsets = UIEdgeInsets(top: 0, left: 12, bottom: 0, right: 12)
    return b
  }

  // ─── barra superior ─────────────────────────────────────────────────────

  private var topLeft: [UIView] = []
  private var topRight: [UIView] = []

  private func buildTopBar() {
    let close = iconButton("close", L("close", "Fechar"), size: 20) { [weak self] in self?.requestClose() }
    topBar.addSubview(close)
    topLeft = [close]
    if !opts.isVideo {
      let u = iconButton("undo", L("undo", "Desfazer")) { [weak self] in self?.undo() }
      u.isHidden = true
      undoBtn = u
      topBar.addSubview(u)
      topLeft.append(u)
    }
    var right: [UIView] = []
    if opts.compose && opts.allowHd {
      let b = UIButton(type: .custom)
      b.setTitle("HD", for: .normal)
      b.titleLabel?.font = UIFont.systemFont(ofSize: 11, weight: .heavy)
      b.layer.cornerRadius = 5
      b.layer.borderWidth = 1.5
      b.addAction(UIAction { [weak self] _ in
        guard let self = self, !self.busy else { return }
        self.hd.toggle()
        self.paintHd()
      }, for: .touchUpInside)
      hdBtn = b
      topBar.addSubview(b)
      right.append(b)
      paintHd()
    }
    if opts.isVideo {
      if opts.tool("mute") {
        let s = iconButton("soundOn", L("soundOn", "Som ativado")) { [weak self] in self?.toggleMute() }
        soundBtn = s
        topBar.addSubview(s)
        right.append(s)
      }
    } else {
      func add(_ key: String, _ icon: String, _ label: String, _ enabled: Bool, _ action: @escaping () -> Void) {
        guard enabled else { return }
        let b = iconButton(icon, label, action: action)
        toolButtons[key] = b
        topBar.addSubview(b)
        right.append(b)
      }
      add("crop", "crop", L("crop", "Recortar"), opts.tool("crop")) { [weak self] in self?.toggleTool(.crop) }
      add("filter", "filter", L("filters", "Filtros"), opts.tool("filters") && opts.filters.count > 1) { [weak self] in self?.toggleTool(.filter) }
      add("sticker", "sticker", L("stickers", "Figurinhas"), opts.tool("stickers")) { [weak self] in self?.toggleTool(.sticker) }
      add("text", "text", L("text", "Texto"), opts.tool("text")) { [weak self] in
        self?.setTool(.none)
        self?.openTextEditor(-1)
      }
      add("draw", "draw", L("draw", "Desenhar"), opts.tool("draw")) { [weak self] in self?.toggleTool(.draw) }
    }
    topRight = right
  }

  private func layoutTopBar() {
    var x: CGFloat = 4
    for v in topLeft { v.frame = CGRect(x: x, y: 6, width: 40, height: 40); x += 42 }
    var rx = topBar.bounds.width - 4
    for v in topRight.reversed() {
      let w: CGFloat = v === hdBtn ? 34 : 40
      let h: CGFloat = v === hdBtn ? 20 : 40
      rx -= w
      v.frame = CGRect(x: rx, y: (52 - h) / 2, width: w, height: h)
      rx -= 2
    }
  }

  private func paintHd() {
    guard let b = hdBtn else { return }
    b.backgroundColor = hd ? .white : .clear
    b.layer.borderColor = (hd ? UIColor.white : UIColor(white: 1, alpha: 0.75)).cgColor
    b.setTitleColor(hd ? .black : UIColor(white: 1, alpha: 0.9), for: .normal)
    b.accessibilityLabel = hd ? L("hdOn", "Qualidade HD") : L("hdOff", "Qualidade padrão")
  }

  private func paintTools() {
    let cur: String
    switch tool {
    case .crop: cur = "crop"
    case .draw: cur = "draw"
    case .filter: cur = "filter"
    case .sticker: cur = "sticker"
    case .none: cur = ""
    }
    for (k, b) in toolButtons {
      let on = k == cur
      b.backgroundColor = on ? .white : .clear
      b.tintColor = on ? .black : .white
    }
  }

  // ─── barra inferior ─────────────────────────────────────────────────────

  private func buildBottom() {
    if !opts.compose {
      doneBtn.setTitle(L("done", "Concluir"), for: .normal)
      doneBtn.titleLabel?.font = UIFont.systemFont(ofSize: 15, weight: .bold)
      doneBtn.setTitleColor(.black, for: .normal)
      doneBtn.backgroundColor = .white
      doneBtn.layer.cornerRadius = 22
      doneBtn.addAction(UIAction { [weak self] _ in self?.export("done") }, for: .touchUpInside)
      bottomBar.addSubview(doneBtn)
      return
    }
    bottomBar.backgroundColor = UIColor(white: 0, alpha: 0.32)
    captionView.backgroundColor = UIColor(white: 1, alpha: 0.10)
    captionView.layer.cornerRadius = 22
    captionView.layer.borderWidth = 1
    captionView.layer.borderColor = UIColor(white: 1, alpha: 0.16).cgColor
    captionView.textColor = .white
    captionView.tintColor = .white
    captionView.font = UIFont.systemFont(ofSize: 16)
    captionView.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
    captionView.keyboardAppearance = .dark
    captionView.delegate = self
    captionView.text = opts.caption
    captionView.isScrollEnabled = true
    bottomBar.addSubview(captionView)
    captionPlaceholder.text = L("captionPlaceholder", "Adicionar legenda...")
    captionPlaceholder.textColor = UIColor(white: 1, alpha: 0.5)
    captionPlaceholder.font = UIFont.systemFont(ofSize: 16)
    captionPlaceholder.isUserInteractionEnabled = false
    captionPlaceholder.isHidden = !opts.caption.isEmpty
    bottomBar.addSubview(captionPlaceholder)
    if opts.allowViewOnce {
      viewOnceBtn.setTitle("1", for: .normal)
      viewOnceBtn.titleLabel?.font = UIFont.systemFont(ofSize: 16, weight: .heavy)
      viewOnceBtn.layer.cornerRadius = 18
      viewOnceBtn.layer.borderWidth = 2
      viewOnceBtn.accessibilityLabel = L("viewOnce", "Visualização única")
      viewOnceBtn.addAction(UIAction { [weak self] _ in
        guard let self = self, !self.busy else { return }
        self.viewOnce.toggle()
        self.paintViewOnce()
        self.view.setNeedsLayout()
      }, for: .touchUpInside)
      bottomBar.addSubview(viewOnceBtn)
    }
    viewOnceHint.text = L("viewOnceHint", "Foto/vídeo só pode ser visto uma vez")
    viewOnceHint.textColor = UIColor(white: 1, alpha: 0.8)
    viewOnceHint.font = UIFont.systemFont(ofSize: 12, weight: .medium)
    viewOnceHint.textAlignment = .center
    bottomBar.addSubview(viewOnceHint)
    sendBtn.setImage(MEIcon.image("send", size: 20), for: .normal)
    sendBtn.tintColor = .white
    sendBtn.backgroundColor = UIColor(white: 0.067, alpha: 1)
    sendBtn.layer.cornerRadius = 25
    sendBtn.layer.borderWidth = 1
    sendBtn.layer.borderColor = UIColor(white: 1, alpha: 0.24).cgColor
    sendBtn.accessibilityLabel = L("send", "Enviar")
    sendBtn.addAction(UIAction { [weak self] _ in self?.export("send") }, for: .touchUpInside)
    bottomBar.addSubview(sendBtn)
    paintViewOnce()
  }

  private func paintViewOnce() {
    viewOnceBtn.backgroundColor = viewOnce ? .white : .clear
    viewOnceBtn.layer.borderColor = (viewOnce ? UIColor.white : UIColor(white: 1, alpha: 0.5)).cgColor
    viewOnceBtn.setTitleColor(viewOnce ? .black : UIColor(white: 1, alpha: 0.5), for: .normal)
    viewOnceBtn.accessibilityTraits = viewOnce ? [.button, .selected] : [.button]
  }

  func textViewDidChange(_ tv: UITextView) {
    if tv === captionView {
      if tv.text.count > opts.captionMax { tv.text = String(tv.text.prefix(opts.captionMax)) }
      captionPlaceholder.isHidden = !tv.text.isEmpty
      view.setNeedsLayout()
    } else if tv === textView {
      layoutTextOverlay()
    }
  }

  // ─── foto ───────────────────────────────────────────────────────────────

  private func buildPhoto() {
    let cv = MECanvasView(frame: .zero)
    cv.host = self
    cv.circleMask = opts.circleCrop
    canvas = cv
    stage.addSubview(cv)
    trashView.backgroundColor = UIColor(white: 0, alpha: 0.6)
    trashView.layer.cornerRadius = 30
    trashView.layer.borderWidth = 1
    trashView.layer.borderColor = UIColor(white: 1, alpha: 0.35).cgColor
    trashIcon.image = MEIcon.image("trash", size: 22)
    trashIcon.tintColor = .white
    trashIcon.contentMode = .center
    trashIcon.frame = CGRect(x: 0, y: 0, width: 60, height: 60)
    trashView.addSubview(trashIcon)
    trashView.isHidden = true
    trashView.isUserInteractionEnabled = false
    stage.addSubview(trashView)
  }

  private func loadPhoto() {
    showBusy(true)
    let screen = UIScreen.main.nativeBounds
    let prevDim = min(2048, max(1280, Int(max(screen.width, screen.height) * 1.05)))
    let uri = opts.uri
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let img = MEImage.load(uri, maxPixel: prevDim)
      DispatchQueue.main.async {
        guard let self = self, !self.finished else { return }
        self.showBusy(false)
        guard let img = img else {
          self.finish(["action": "error", "error": "load_failed"])
          return
        }
        self.baseImage = img
        self.refreshDisplay()
        self.buildPhotoPanels()
        self.view.setNeedsLayout()
        if self.opts.circleCrop && self.panels["crop"] != nil { self.setTool(.crop) }
      }
    }
  }

  private func filterAt(_ i: Int) -> MEFilter? {
    return i >= 0 && i < opts.filters.count ? opts.filters[i] : nil
  }

  /// Giro síncrono (rápido, mantém imagem e moldura coerentes); filtro assíncrono.
  private func refreshDisplay() {
    guard let base = baseImage, let cv = canvas else { return }
    let q = editorState.rotQ
    let rot: CGImage
    if let c = rotatedCache, c.0 == q { rot = c.1 } else {
      rot = MEImage.rotated(base, q: q)
      rotatedCache = (q, rot)
    }
    let f = filterAt(editorState.filterIdx)
    displayGen += 1
    let gen = displayGen
    let size = CGSize(width: rot.width, height: rot.height)
    if cv.imagePixelSize != size || f?.m == nil {
      cv.imagePixelSize = size
      cv.displayImage = UIImage(cgImage: rot)
    }
    guard f?.m != nil else { paintFilterCells(); return }
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let out = MEImage.filtered(rot, f)
      DispatchQueue.main.async {
        guard let self = self, gen == self.displayGen, let cv = self.canvas else { return }
        cv.imagePixelSize = size
        cv.displayImage = UIImage(cgImage: out)
      }
    }
    paintFilterCells()
  }

  private func buildPhotoPanels() {
    if opts.tool("filters") && opts.filters.count > 1 { buildFilterPanel() }
    if opts.tool("draw") { buildDrawPanel() }
    if opts.tool("crop") { buildCropPanel() }
    if opts.tool("stickers") { buildStickerPanel() }
    for (_, p) in panels { p.isHidden = true; panelHost.addSubview(p) }
    paintTools()
  }

  private func buildFilterPanel() {
    let sc = UIScrollView()
    sc.showsHorizontalScrollIndicator = false
    var thumbSrc: CGImage? = nil
    if let b = baseImage {
      let k = 140 / CGFloat(max(b.width, b.height))
      let sz = CGSize(width: max(1, CGFloat(b.width) * k), height: max(1, CGFloat(b.height) * k))
      let fmt = UIGraphicsImageRendererFormat.default()
      fmt.scale = 1
      thumbSrc = UIGraphicsImageRenderer(size: sz, format: fmt).image { _ in
        UIImage(cgImage: b).draw(in: CGRect(origin: .zero, size: sz))
      }.cgImage
    }
    filterCells = []
    for (i, f) in opts.filters.enumerated() {
      let cell = UIView()
      let iv = UIImageView()
      iv.contentMode = .scaleAspectFill
      iv.clipsToBounds = true
      iv.layer.cornerRadius = 10
      iv.backgroundColor = UIColor(white: 0.2, alpha: 1)
      cell.addSubview(iv)
      let lb = UILabel()
      lb.text = f.label
      lb.font = UIFont.systemFont(ofSize: 11, weight: .medium)
      lb.textAlignment = .center
      lb.textColor = UIColor(white: 1, alpha: 0.7)
      cell.addSubview(lb)
      let tap = UIButton(type: .custom)
      tap.accessibilityLabel = f.label
      tap.addAction(UIAction { [weak self] _ in self?.selectFilter(i) }, for: .touchUpInside)
      cell.addSubview(tap)
      sc.addSubview(cell)
      filterCells.append((cell, iv, lb))
      if let src = thumbSrc {
        DispatchQueue.global(qos: .utility).async {
          let out = MEImage.filtered(src, f)
          DispatchQueue.main.async { iv.image = UIImage(cgImage: out) }
        }
      }
    }
    panels["filter"] = sc
    paintFilterCells()
  }

  private func selectFilter(_ i: Int) {
    guard !busy, editorState.filterIdx != i else { return }
    beginMutation()
    editorState.filterIdx = i
    refreshDisplay()
    changed()
  }

  private func paintFilterCells() {
    for (i, c) in filterCells.enumerated() {
      let on = i == editorState.filterIdx
      c.1.layer.borderWidth = on ? 2 : 0
      c.1.layer.borderColor = UIColor.white.cgColor
      c.2.textColor = on ? .white : UIColor(white: 1, alpha: 0.65)
    }
  }

  private func buildDrawPanel() {
    let row = UIStackView()
    row.axis = .horizontal
    row.alignment = .center
    row.spacing = 8
    drawRow = row
    let wrap = UIView()
    wrap.addSubview(row)
    panels["draw"] = wrap
    paintDrawRow()
  }

  private func paintDrawRow() {
    guard let row = drawRow else { return }
    row.arrangedSubviews.forEach { $0.removeFromSuperview() }
    for c in MediaEditorViewController.palette {
      let sel = c == brushColor
      let b = UIButton(type: .custom)
      b.backgroundColor = c
      let s: CGFloat = sel ? 30 : 26
      b.layer.cornerRadius = s / 2
      b.layer.borderWidth = sel ? 3 : 1.5
      b.layer.borderColor = (sel ? UIColor.white : UIColor(white: 1, alpha: 0.6)).cgColor
      b.widthAnchor.constraint(equalToConstant: s).isActive = true
      b.heightAnchor.constraint(equalToConstant: s).isActive = true
      b.addAction(UIAction { [weak self] _ in
        self?.brushColor = c
        self?.paintDrawRow()
      }, for: .touchUpInside)
      row.addArrangedSubview(b)
    }
    let spacer = UIView()
    spacer.widthAnchor.constraint(equalToConstant: 6).isActive = true
    row.addArrangedSubview(spacer)
    for (i, w) in MediaEditorViewController.penSizes.enumerated() {
      let b = UIButton(type: .custom)
      b.widthAnchor.constraint(equalToConstant: 30).isActive = true
      b.heightAnchor.constraint(equalToConstant: 30).isActive = true
      let dot = UIView(frame: CGRect(x: 15 - (w + 4) / 2, y: 15 - (w + 4) / 2, width: w + 4, height: w + 4))
      dot.layer.cornerRadius = (w + 4) / 2
      dot.backgroundColor = i == brushIdx ? .white : UIColor(white: 1, alpha: 0.45)
      dot.isUserInteractionEnabled = false
      b.addSubview(dot)
      b.accessibilityLabel = "\(L("brushSize", "Espessura")) \(i + 1)"
      b.addAction(UIAction { [weak self] _ in
        self?.brushIdx = i
        self?.paintDrawRow()
      }, for: .touchUpInside)
      row.addArrangedSubview(b)
    }
    view.setNeedsLayout()
  }

  private func buildCropPanel() {
    let wrap = UIView()
    let sc = UIScrollView()
    sc.showsHorizontalScrollIndicator = false
    sc.tag = 11
    wrap.addSubview(sc)
    ratioButtons = []
    sc.isHidden = opts.circleCrop
    let ratioList: [(String, CGFloat)] = opts.circleCrop ? [] : MediaEditorViewController.ratios
    for (key, r) in ratioList {
      let title = key == "free" ? L("ratioFree", "Livre") : (key == "orig" ? L("ratioOriginal", "Original") : key)
      let b = pillLabelButton(title, dark: true)
      b.addAction(UIAction { [weak self] _ in
        guard let self = self, !self.busy else { return }
        self.ratioSel = key
        self.canvas?.applyRatio(r)
        self.paintRatios()
      }, for: .touchUpInside)
      sc.addSubview(b)
      ratioButtons.append((key, b))
    }
    let rotate = iconButton("rotate", L("rotate", "Girar")) { [weak self] in self?.rotateCW() }
    rotate.tag = 12
    wrap.addSubview(rotate)
    let reset = UIButton(type: .custom)
    reset.setTitle(L("reset", "Redefinir"), for: .normal)
    reset.titleLabel?.font = UIFont.systemFont(ofSize: 14, weight: .bold)
    reset.setTitleColor(.white, for: .normal)
    reset.tag = 13
    reset.addAction(UIAction { [weak self] _ in self?.resetCrop() }, for: .touchUpInside)
    wrap.addSubview(reset)
    let ok = iconButton("check", L("done", "Concluir"), size: 22) { [weak self] in
      guard let self = self else { return }
      // circle-crop (avatar): o check do recorte já conclui (igual ao Android).
      if self.opts.circleCrop { self.export("done") } else { self.setTool(.none) }
    }
    ok.tag = 14
    wrap.addSubview(ok)
    panels["crop"] = wrap
    paintRatios()
  }

  private func paintRatios() {
    for (k, b) in ratioButtons {
      let on = k == ratioSel
      b.backgroundColor = on ? .white : UIColor(white: 1, alpha: 0.14)
      b.setTitleColor(on ? .black : .white, for: .normal)
    }
  }

  private func buildStickerPanel() {
    let list = opts.stickers.isEmpty ? MediaEditorViewController.defaultStickers : opts.stickers
    let sc = UIScrollView()
    sc.tag = 21
    for s in list {
      let b = UIButton(type: .custom)
      b.setTitle(s, for: .normal)
      b.titleLabel?.font = UIFont.systemFont(ofSize: 30)
      b.addAction(UIAction { [weak self] _ in self?.addSticker(s) }, for: .touchUpInside)
      sc.addSubview(b)
    }
    panels["sticker"] = sc
  }

  private func layoutPanels() {
    let W = panelHost.bounds.width
    if let sc = panels["filter"] as? UIScrollView {
      var x: CGFloat = 8
      for c in filterCells {
        c.0.frame = CGRect(x: x, y: 8, width: 66, height: 88)
        c.1.frame = CGRect(x: 2, y: 2, width: 62, height: 62)
        c.2.frame = CGRect(x: 0, y: 70, width: 66, height: 16)
        if let tap = c.0.subviews.last { tap.frame = c.0.bounds }
        x += 70
      }
      sc.contentSize = CGSize(width: x + 8, height: 96)
    }
    if let wrap = panels["draw"], let row = drawRow {
      let sz = row.systemLayoutSizeFitting(UIView.layoutFittingCompressedSize)
      row.frame = CGRect(x: max(8, (W - sz.width) / 2), y: (wrap.bounds.height - 34) / 2, width: min(W - 16, sz.width), height: 34)
    }
    if let wrap = panels["crop"] {
      if let sc = wrap.viewWithTag(11) as? UIScrollView {
        sc.frame = CGRect(x: 0, y: 6, width: W, height: 34)
        var x: CGFloat = 10
        for (_, b) in ratioButtons {
          let w = b.intrinsicContentSize.width + 4
          b.frame = CGRect(x: x, y: 2, width: w, height: 30)
          x += w + 8
        }
        sc.contentSize = CGSize(width: x + 2, height: 34)
      }
      wrap.viewWithTag(12)?.frame = CGRect(x: 6, y: 46, width: 40, height: 40)
      if let r = wrap.viewWithTag(13) as? UIButton {
        r.frame = CGRect(x: 52, y: 46, width: r.intrinsicContentSize.width + 16, height: 40)
      }
      wrap.viewWithTag(14)?.frame = CGRect(x: W - 46, y: 46, width: 40, height: 40)
    }
    if let sc = panels["sticker"] as? UIScrollView {
      let per = 8
      let cw = (W - 16) / CGFloat(per)
      for (i, v) in sc.subviews.compactMap({ $0 as? UIButton }).enumerated() {
        v.frame = CGRect(x: 8 + CGFloat(i % per) * cw, y: 6 + CGFloat(i / per) * 48, width: cw, height: 48)
      }
      let rows = (sc.subviews.compactMap { $0 as? UIButton }.count + per - 1) / per
      sc.contentSize = CGSize(width: W, height: CGFloat(rows) * 48 + 12)
    }
    if opts.isVideo { layoutVideoPanel() }
  }

  private func toggleTool(_ t: Tool) {
    setTool(tool == t ? .none : t)
  }

  private func setTool(_ t: Tool) {
    guard let cv = canvas else { return }
    if tool == .crop && t != .crop {
      let e = cv.editCrop
      let c = editorState.crop
      if abs(e.minX - c.minX) > 1e-4 || abs(e.minY - c.minY) > 1e-4 || abs(e.maxX - c.maxX) > 1e-4 || abs(e.maxY - c.maxY) > 1e-4 {
        beginMutation()
        editorState.crop = e
      }
    }
    tool = t
    let key: String
    switch t {
    case .crop: key = "crop"
    case .draw: key = "draw"
    case .filter: key = "filter"
    case .sticker: key = "sticker"
    case .none: key = ""
    }
    for (k, p) in panels { p.isHidden = k != key }
    switch t {
    case .crop:
      cv.mode = .crop
      cv.editCrop = editorState.crop
      cv.cropRatio = 0
      ratioSel = "free"
      if opts.circleCrop { lockSquare() }
      paintRatios()
    case .draw: cv.mode = .draw
    default: cv.mode = .objects
    }
    if t != .none { view.endEditing(true) }
    paintTools()
    changed()
    view.setNeedsLayout()
    UIView.animate(withDuration: 0.18) { self.view.layoutIfNeeded() }
  }

  private func rotateCW() {
    guard let cv = canvas else { return }
    beginMutation()
    editorState.crop = cv.editCrop
    editorState.rotateCW()
    cv.editCrop = editorState.crop
    if cv.cropRatio > 0 { cv.cropRatio = 1 / cv.cropRatio }
    refreshDisplay()
    cv.setNeedsLayout()
    changed()
  }

  private func resetCrop() {
    guard let cv = canvas else { return }
    let e = cv.editCrop
    if editorState.rotQ % 4 != 0 || editorState.crop.width < 0.999 || editorState.crop.height < 0.999 || e.width < 0.999 || e.height < 0.999 {
      beginMutation()
      while editorState.rotQ % 4 != 0 { editorState.rotateCW() }
      editorState.crop = CGRect(x: 0, y: 0, width: 1, height: 1)
    }
    cv.editCrop = CGRect(x: 0, y: 0, width: 1, height: 1)
    cv.cropRatio = 0
    ratioSel = "free"
    paintRatios()
    refreshDisplay()
    if opts.circleCrop { lockSquare() }
    cv.setNeedsLayout()
    changed()
  }

  /// [circle-crop] Maior quadrado (em PIXELS) dentro de `c`, centrado em `c`.
  static func squareInside(_ c: CGRect, bw: CGFloat, bh: CGFloat) -> CGRect {
    guard bw > 0, bh > 0 else { return c }
    let s = min(c.width * bw, c.height * bh)
    let w = min(1, s / bw)
    let h = min(1, s / bh)
    let x = min(max(0, c.midX - w / 2), 1 - w)
    let y = min(max(0, c.midY - h / 2), 1 - h)
    return CGRect(x: x, y: y, width: w, height: h)
  }

  static func isSquare(_ c: CGRect, bw: CGFloat, bh: CGFloat) -> Bool {
    let pw = c.width * bw
    let ph = c.height * bh
    return pw > 0 && ph > 0 && abs(pw / ph - 1) < 0.005
  }

  /// [circle-crop] Trava a moldura em 1:1 (na 1ª vez = maior quadrado centrado).
  private func lockSquare() {
    guard let cv = canvas else { return }
    let bw = cv.imagePixelSize.width
    let bh = cv.imagePixelSize.height
    guard bw > 0, bh > 0 else { return }
    let e = cv.editCrop
    if !MediaEditorViewController.isSquare(e, bw: bw, bh: bh) {
      cv.editCrop = MediaEditorViewController.squareInside(e, bw: bw, bh: bh)
    }
    cv.cropRatio = 1
    ratioSel = "1:1"
  }

  private func addSticker(_ s: String) {
    guard !busy else { return }
    beginMutation()
    let c = editorState.crop
    editorState.objs.append(MEObj(kind: "sticker", text: s, color: .white, font: 0, bg: 0, u: c.midX, v: c.midY, scale: 0.16, rot: 0))
    setTool(.none)
    canvas?.redraw()
    changed()
  }

  private func undo() {
    guard !busy, let prev = history.popLast() else { return }
    editorState = prev
    if tool == .crop { canvas?.editCrop = prev.crop }
    refreshDisplay()
    if tool == .crop && opts.circleCrop { lockSquare() }
    canvas?.setNeedsLayout()
    canvas?.redraw()
    changed()
  }

  // ── MECanvasHost ──
  func beginMutation() {
    history.append(editorState)
    if history.count > 60 { history.removeFirst() }
  }

  func cancelMutation() {
    _ = history.popLast()
    changed()
  }

  func changed() {
    undoBtn?.isHidden = history.isEmpty
  }

  func objTapped(_ index: Int) {
    guard index >= 0 && index < editorState.objs.count else { return }
    if editorState.objs[index].kind == "text" { openTextEditor(index) }
  }

  func objDragging(_ active: Bool, overTrash: Bool) {
    trashView.isHidden = !active
    trashView.transform = overTrash ? CGAffineTransform(scaleX: 1.25, y: 1.25) : .identity
    trashView.backgroundColor = overTrash ? .white : UIColor(white: 0, alpha: 0.6)
    trashIcon.tintColor = overTrash ? .black : .white
    topBar.alpha = active ? 0.2 : 1
    bottomBar.alpha = active ? 0.2 : 1
  }

  // ─── editor de texto ────────────────────────────────────────────────────

  private func buildTextOverlay() {
    textOverlay.backgroundColor = UIColor(white: 0, alpha: 0.6)
    textOverlay.isHidden = true
    let tap = UITapGestureRecognizer(target: self, action: #selector(textOverlayTap(_:)))
    textOverlay.addGestureRecognizer(tap)
    view.addSubview(textOverlay)
    fontBtn.titleLabel?.font = UIFont.systemFont(ofSize: 14, weight: .bold)
    fontBtn.setTitleColor(.white, for: .normal)
    fontBtn.backgroundColor = UIColor(white: 1, alpha: 0.18)
    fontBtn.layer.cornerRadius = 16
    fontBtn.contentEdgeInsets = UIEdgeInsets(top: 0, left: 14, bottom: 0, right: 14)
    fontBtn.accessibilityLabel = L("font", "Fonte")
    fontBtn.addAction(UIAction { [weak self] _ in
      guard let self = self else { return }
      self.txtFont = (self.txtFont + 1) % MediaEditorViewController.fontKeys.count
      self.paintTextStyle()
    }, for: .touchUpInside)
    textOverlay.addSubview(fontBtn)
    bgBtn.setImage(MEIcon.image("bg", size: 20), for: .normal)
    bgBtn.tintColor = .white
    bgBtn.layer.cornerRadius = 20
    bgBtn.accessibilityLabel = L("textBackground", "Fundo do texto")
    bgBtn.addAction(UIAction { [weak self] _ in
      guard let self = self else { return }
      self.txtBg = (self.txtBg + 1) % 3
      self.paintTextStyle()
    }, for: .touchUpInside)
    textOverlay.addSubview(bgBtn)
    textDone.setTitle(L("done", "Concluir"), for: .normal)
    textDone.titleLabel?.font = UIFont.systemFont(ofSize: 15, weight: .bold)
    textDone.setTitleColor(.black, for: .normal)
    textDone.backgroundColor = .white
    textDone.layer.cornerRadius = 16
    textDone.contentEdgeInsets = UIEdgeInsets(top: 0, left: 16, bottom: 0, right: 16)
    textDone.addAction(UIAction { [weak self] _ in self?.closeTextEditor(commit: true) }, for: .touchUpInside)
    textOverlay.addSubview(textDone)
    textView.backgroundColor = .clear
    textView.textAlignment = .center
    textView.isScrollEnabled = false
    textView.keyboardAppearance = .dark
    textView.tintColor = .white
    textView.delegate = self
    textView.textContainerInset = UIEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
    textView.layer.cornerRadius = 14
    textOverlay.addSubview(textView)
    textPalette.axis = .horizontal
    textPalette.alignment = .center
    textPalette.spacing = 10
    textOverlay.addSubview(textPalette)
  }

  @objc private func textOverlayTap(_ g: UITapGestureRecognizer) {
    let p = g.location(in: textOverlay)
    if textView.frame.contains(p) || textPalette.frame.contains(p) { return }
    if p.y < view.safeAreaInsets.top + 56 { return }
    closeTextEditor(commit: true)
  }

  private func layoutTextOverlay() {
    guard !textOverlay.isHidden else { return }
    let W = view.bounds.width
    let safe = view.safeAreaInsets
    let top = safe.top
    let fw = max(80, fontBtn.intrinsicContentSize.width)
    fontBtn.frame = CGRect(x: 12, y: top + 10, width: fw, height: 32)
    bgBtn.frame = CGRect(x: fontBtn.frame.maxX + 8, y: top + 6, width: 40, height: 40)
    let dw = max(90, textDone.intrinsicContentSize.width)
    textDone.frame = CGRect(x: W - 12 - dw, y: top + 10, width: dw, height: 32)
    let bottom = view.bounds.height - max(safe.bottom, kbHeight)
    let palH: CGFloat = 52
    let sz = textPalette.systemLayoutSizeFitting(UIView.layoutFittingCompressedSize)
    textPalette.frame = CGRect(x: max(8, (W - sz.width) / 2), y: bottom - palH + (palH - 34) / 2, width: min(W - 16, sz.width), height: 34)
    let areaTop = top + 56
    let areaBottom = bottom - palH
    let maxW = W * 0.88
    let fit = textView.sizeThatFits(CGSize(width: maxW, height: .greatestFiniteMagnitude))
    let w = min(maxW, max(60, fit.width))
    let h = min(max(50, areaBottom - areaTop - 10), max(50, fit.height))
    textView.isScrollEnabled = fit.height > h
    textView.frame = CGRect(x: (W - w) / 2, y: areaTop + (areaBottom - areaTop - h) / 2, width: w, height: h)
  }

  private func openTextEditor(_ index: Int) {
    editingObj = index
    let o: MEObj? = index >= 0 && index < editorState.objs.count ? editorState.objs[index] : nil
    txtColor = o?.color ?? .white
    txtFont = o?.font ?? 0
    txtBg = o?.bg ?? 0
    textView.text = o?.text ?? ""
    paintTextStyle()
    textOverlay.isHidden = false
    textOverlay.alpha = 0
    view.bringSubviewToFront(textOverlay)
    view.bringSubviewToFront(busyView)
    view.setNeedsLayout()
    UIView.animate(withDuration: 0.15) { self.textOverlay.alpha = 1 }
    textView.becomeFirstResponder()
  }

  private func paintTextStyle() {
    textView.font = MEDraw.font(txtFont, size: 30)
    let fk = MediaEditorViewController.fontKeys[max(0, min(MediaEditorViewController.fontKeys.count - 1, txtFont))]
    fontBtn.setTitle(L(fk.0, fk.1), for: .normal)
    switch txtBg {
    case 1:
      textView.backgroundColor = txtColor
      textView.textColor = MEDraw.contrastOn(txtColor)
    case 2:
      textView.backgroundColor = UIColor(white: 0, alpha: 0.55)
      textView.textColor = txtColor
    default:
      textView.backgroundColor = .clear
      textView.textColor = txtColor
    }
    bgBtn.backgroundColor = txtBg != 0 ? .white : .clear
    bgBtn.tintColor = txtBg != 0 ? .black : .white
    textPalette.arrangedSubviews.forEach { $0.removeFromSuperview() }
    for c in MediaEditorViewController.palette {
      let sel = c == txtColor
      let b = UIButton(type: .custom)
      let s: CGFloat = sel ? 32 : 28
      b.backgroundColor = c
      b.layer.cornerRadius = s / 2
      b.layer.borderWidth = sel ? 3 : 1.5
      b.layer.borderColor = (sel ? UIColor.white : UIColor(white: 1, alpha: 0.6)).cgColor
      b.widthAnchor.constraint(equalToConstant: s).isActive = true
      b.heightAnchor.constraint(equalToConstant: s).isActive = true
      b.addAction(UIAction { [weak self] _ in
        self?.txtColor = c
        self?.paintTextStyle()
      }, for: .touchUpInside)
      textPalette.addArrangedSubview(b)
    }
    view.setNeedsLayout()
  }

  private func closeTextEditor(commit: Bool) {
    guard !textOverlay.isHidden else { return }
    let txt = (textView.text ?? "").replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
    if commit {
      if editingObj >= 0 && editingObj < editorState.objs.count {
        beginMutation()
        if txt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          editorState.objs.remove(at: editingObj)
        } else {
          editorState.objs[editingObj].text = txt
          editorState.objs[editingObj].color = txtColor
          editorState.objs[editingObj].font = txtFont
          editorState.objs[editingObj].bg = txtBg
        }
      } else if !txt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        beginMutation()
        let c = editorState.crop
        editorState.objs.append(MEObj(kind: "text", text: txt, color: txtColor, font: txtFont, bg: txtBg, u: c.midX, v: c.midY, scale: 0.075, rot: 0))
      }
      changed()
    }
    editingObj = -1
    textView.resignFirstResponder()
    UIView.animate(withDuration: 0.12, animations: { self.textOverlay.alpha = 0 }, completion: { _ in
      self.textOverlay.isHidden = true
    })
    canvas?.redraw()
  }

  // ─── vídeo ──────────────────────────────────────────────────────────────

  private func buildVideo() {
    videoView.backgroundColor = .black
    playerLayer.videoGravity = .resizeAspect
    videoView.layer.addSublayer(playerLayer)
    stage.addSubview(videoView)
    playBadge.image = MEIcon.image("play", size: 26)
    playBadge.tintColor = .white
    playBadge.contentMode = .center
    playBadge.backgroundColor = UIColor(white: 0, alpha: 0.45)
    playBadge.layer.cornerRadius = 32
    playBadge.clipsToBounds = true
    playBadge.isHidden = true
    stage.addSubview(playBadge)
    let tap = UITapGestureRecognizer(target: self, action: #selector(videoTap))
    stage.addGestureRecognizer(tap)

    let wrap = UIView()
    if opts.tool("cover") {
      let cb = UIButton(type: .custom)
      cb.setImage(MEIcon.image("cover", size: 14), for: .normal)
      cb.setTitle("  " + L("cover", "Capa"), for: .normal)
      cb.titleLabel?.font = UIFont.systemFont(ofSize: 13, weight: .bold)
      cb.layer.cornerRadius = 14
      cb.contentEdgeInsets = UIEdgeInsets(top: 0, left: 10, bottom: 0, right: 12)
      cb.accessibilityLabel = L("cover", "Capa")
      cb.addAction(UIAction { [weak self] _ in
        guard let self = self, !self.busy else { return }
        self.setCoverMode(!self.coverMode)
      }, for: .touchUpInside)
      coverBtn = cb
      wrap.addSubview(cb)
      coverThumb.contentMode = .scaleAspectFill
      coverThumb.clipsToBounds = true
      coverThumb.layer.cornerRadius = 4
      coverThumb.isHidden = true
      wrap.addSubview(coverThumb)
      paintCoverBtn()
    }
    timeLabel.font = UIFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
    timeLabel.textColor = UIColor(white: 1, alpha: 0.86)
    timeLabel.textAlignment = .right
    wrap.addSubview(timeLabel)
    let r = MERailView(frame: .zero)
    r.delegate = self
    r.isHidden = !opts.tool("trim")
    rail = r
    wrap.addSubview(r)
    panels["video"] = wrap
    panelHost.addSubview(wrap)
  }

  private func layoutVideoPanel() {
    guard let wrap = panels["video"] else { return }
    let W = wrap.bounds.width
    var x: CGFloat = 12
    if !coverThumb.isHidden {
      coverThumb.frame = CGRect(x: x, y: 9, width: 24, height: 24)
      x += 30
    }
    if let cb = coverBtn {
      let w = cb.intrinsicContentSize.width + 6
      cb.frame = CGRect(x: x, y: 7, width: w, height: 28)
    }
    timeLabel.frame = CGRect(x: W * 0.35, y: 7, width: W * 0.65 - 12, height: 28)
    rail?.frame = CGRect(x: 12, y: 42, width: W - 24, height: 56)
  }

  private func paintCoverBtn() {
    guard let cb = coverBtn else { return }
    cb.backgroundColor = coverMode ? .white : UIColor(white: 1, alpha: 0.16)
    cb.tintColor = coverMode ? .black : .white
    cb.setTitleColor(coverMode ? .black : .white, for: .normal)
  }

  private func fmt(_ ms: Double) -> String {
    let s = Int(max(0, ms) / 1000)
    return String(format: "%d:%02d", s / 60, s % 60)
  }

  private func paintTime() {
    if coverMode {
      timeLabel.font = UIFont.systemFont(ofSize: 12, weight: .medium)
      timeLabel.text = L("coverHint", "Escolha o quadro da capa")
    } else {
      timeLabel.font = UIFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
      timeLabel.text = "\(fmt(trimStart)) – \(fmt(trimEnd))  ·  \(fmt(trimEnd - trimStart))"
    }
  }

  private func loadVideo() {
    guard let url = MEImage.url(opts.uri) else { finish(["action": "error", "error": "bad_uri"]); return }
    let a = AVURLAsset(url: url)
    asset = a
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let dur = CMTimeGetSeconds(a.duration)
      let vt = a.tracks(withMediaType: .video).first
      let audio = !a.tracks(withMediaType: .audio).isEmpty
      var size = CGSize.zero
      if let t = vt {
        let s = t.naturalSize.applying(t.preferredTransform)
        size = CGSize(width: abs(s.width), height: abs(s.height))
      }
      DispatchQueue.main.async {
        guard let self = self, !self.finished else { return }
        guard dur.isFinite, dur > 0, vt != nil else {
          self.finish(["action": "error", "error": "load_failed"])
          return
        }
        self.durationMs = dur * 1000
        self.trimStart = 0
        self.trimEnd = self.durationMs
        self.hasAudio = audio
        self.videoSize = size
        if !audio { self.soundBtn?.isHidden = true }
        if let r = self.rail {
          r.durationMs = self.durationMs
          r.startMs = 0
          r.endMs = self.durationMs
          r.minRangeMs = min(1000, self.durationMs)
        }
        self.paintTime()
        self.loadThumbs()
        let item = AVPlayerItem(asset: a)
        let p = AVPlayer(playerItem: item)
        p.actionAtItemEnd = .pause
        p.isMuted = self.muted
        self.player = p
        self.playerLayer.player = p
        self.timeObs = p.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 30), queue: .main) { [weak self] t in
          self?.tick(t)
        }
        NotificationCenter.default.addObserver(self, selector: #selector(self.itemEnded), name: .AVPlayerItemDidPlayToEndTime, object: item)
        p.play()
        self.view.setNeedsLayout()
      }
    }
  }

  private func loadThumbs() {
    guard let a = asset, durationMs > 0 else { return }
    let n = 10
    rail?.thumbs = Array(repeating: nil, count: n)
    let gen = AVAssetImageGenerator(asset: a)
    gen.appliesPreferredTrackTransform = true
    gen.maximumSize = CGSize(width: 180, height: 180)
    gen.requestedTimeToleranceBefore = CMTime(seconds: 0.5, preferredTimescale: 600)
    gen.requestedTimeToleranceAfter = CMTime(seconds: 0.5, preferredTimescale: 600)
    thumbGen = gen
    var times: [NSValue] = []
    for i in 0..<n {
      let s = durationMs / 1000 * (Double(i) + 0.5) / Double(n)
      times.append(NSValue(time: CMTime(seconds: s, preferredTimescale: 600)))
    }
    let keys = times.map { $0.timeValue }
    gen.generateCGImagesAsynchronously(forTimes: times) { [weak self] requested, cg, _, result, _ in
      guard result == .succeeded, let cg = cg else { return }
      let img = UIImage(cgImage: cg)
      DispatchQueue.main.async {
        guard let self = self, let r = self.rail else { return }
        if let idx = keys.firstIndex(where: { CMTimeCompare($0, requested) == 0 }), idx < r.thumbs.count {
          r.thumbs[idx] = img
        }
      }
    }
  }

  private func seek(_ ms: Double, exact: Bool = true) {
    let t = CMTime(seconds: ms / 1000, preferredTimescale: 600)
    if exact {
      player?.seek(to: t, toleranceBefore: .zero, toleranceAfter: .zero)
    } else {
      player?.seek(to: t)
    }
  }

  private func tick(_ t: CMTime) {
    let ms = CMTimeGetSeconds(t) * 1000
    guard ms.isFinite else { return }
    if !coverMode, let p = player, p.rate > 0, ms >= trimEnd {
      seek(trimStart)
    }
    if !coverMode { rail?.playheadMs = ms }
  }

  @objc private func itemEnded() {
    guard !userPaused, !coverMode else { return }
    seek(trimStart)
    player?.play()
  }

  @objc private func videoTap() {
    guard !coverMode, !busy, let p = player else { return }
    if p.rate > 0 {
      p.pause()
      userPaused = true
      playBadge.isHidden = false
    } else {
      userPaused = false
      playBadge.isHidden = true
      startPlayback()
    }
  }

  private func startPlayback() {
    guard let p = player else { return }
    let ms = CMTimeGetSeconds(p.currentTime()) * 1000
    if !ms.isFinite || ms < trimStart || ms >= trimEnd - 80 { seek(trimStart) }
    p.play()
    playBadge.isHidden = true
  }

  private func toggleMute() {
    muted.toggle()
    player?.isMuted = muted
    soundBtn?.setImage(MEIcon.image(muted ? "soundOff" : "soundOn", size: 20), for: .normal)
    soundBtn?.accessibilityLabel = muted ? L("soundOff", "Sem som") : L("soundOn", "Som ativado")
    UIAccessibility.post(notification: .announcement, argument: soundBtn?.accessibilityLabel)
  }

  private func setCoverMode(_ on: Bool) {
    coverMode = on
    rail?.coverMode = on
    if on {
      if coverMs < 0 { coverMs = trimStart }
      rail?.coverMs = coverMs
      player?.pause()
      seek(coverMs)
    } else if !userPaused {
      startPlayback()
    }
    paintCoverBtn()
    paintTime()
    rail?.setNeedsDisplay()
  }

  private func refreshCoverThumb() {
    guard let a = asset, coverMs >= 0 else { return }
    let ms = coverMs
    DispatchQueue.global(qos: .utility).async { [weak self] in
      let g = AVAssetImageGenerator(asset: a)
      g.appliesPreferredTrackTransform = true
      g.maximumSize = CGSize(width: 96, height: 96)
      let cg = try? g.copyCGImage(at: CMTime(seconds: ms / 1000, preferredTimescale: 600), actualTime: nil)
      DispatchQueue.main.async {
        guard let self = self, let cg = cg else { return }
        self.coverThumb.image = UIImage(cgImage: cg)
        self.coverThumb.isHidden = false
        self.view.setNeedsLayout()
      }
    }
  }

  // ── MERailDelegate ──
  func railRangeChanging(start: Double, end: Double, editingStart: Bool) {
    trimStart = start
    trimEnd = end
    player?.pause()
    seek(editingStart ? start : end)
    paintTime()
  }

  func railRangeChanged(start: Double, end: Double) {
    trimStart = start
    trimEnd = end
    if coverMs >= 0 && (coverMs < start || coverMs > end) { coverMs = start }
    paintTime()
    if !userPaused { startPlayback() }
  }

  func railCoverChanging(_ ms: Double) {
    coverMs = ms
    seek(ms)
  }

  func railCoverChanged(_ ms: Double) {
    coverMs = ms
    seek(ms)
    refreshCoverThumb()
  }

  func railSeek(_ ms: Double) {
    seek(ms)
  }

  // ─── exportação ─────────────────────────────────────────────────────────

  private func buildBusy() {
    busyView.backgroundColor = UIColor(white: 0, alpha: 0.6)
    busyView.isHidden = true
    let sp = UIActivityIndicatorView(style: .large)
    sp.color = .white
    sp.startAnimating()
    sp.tag = 31
    busyView.addSubview(sp)
    let lb = UILabel()
    lb.text = L("processing", "Preparando…")
    lb.textColor = .white
    lb.font = UIFont.systemFont(ofSize: 14, weight: .medium)
    lb.textAlignment = .center
    lb.tag = 32
    busyView.addSubview(lb)
    view.addSubview(busyView)
  }

  private func showBusy(_ on: Bool) {
    busy = on
    busyView.isHidden = !on
    if on {
      view.bringSubviewToFront(busyView)
      let c = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
      busyView.viewWithTag(31)?.center = CGPoint(x: c.x, y: c.y - 14)
      busyView.viewWithTag(32)?.frame = CGRect(x: 20, y: c.y + 16, width: view.bounds.width - 40, height: 20)
    }
  }

  private func baseResult(_ action: String) -> [String: Any] {
    return [
      "action": action,
      "caption": opts.compose ? (captionView.text ?? "") : opts.caption,
      "viewOnce": viewOnce,
      "hd": hd,
    ]
  }

  private func toast(_ s: String) {
    let a = UIAlertController(title: s, message: nil, preferredStyle: .alert)
    a.addAction(UIAlertAction(title: "OK", style: .default, handler: nil))
    present(a, animated: true, completion: nil)
  }

  private func export(_ action: String) {
    guard !busy, !finished else { return }
    if tool == .crop { setTool(.none) }
    if opts.circleCrop && !opts.isVideo, let cv = canvas {
      // Garante recorte quadrado mesmo se um desfazer trouxe moldura não-1:1.
      let bw = cv.imagePixelSize.width
      let bh = cv.imagePixelSize.height
      if bw > 0, bh > 0, !MediaEditorViewController.isSquare(editorState.crop, bw: bw, bh: bh) {
        editorState.crop = MediaEditorViewController.squareInside(editorState.crop, bw: bw, bh: bh)
      }
    }
    if !textOverlay.isHidden { closeTextEditor(commit: true) }
    view.endEditing(true)
    if opts.isVideo { exportVideo(action) } else { exportPhoto(action) }
  }

  private func exportPhoto(_ action: String) {
    var res = baseResult(action)
    let st = editorState
    var edits: [String: Any] = [
      "rotate": (st.rotQ % 4) * 90,
      "crop": ["x": Double(st.crop.minX), "y": Double(st.crop.minY), "w": Double(st.crop.width), "h": Double(st.crop.height)],
      "filter": filterAt(st.filterIdx)?.id ?? "original",
      "strokes": st.strokes.count,
      "objects": st.objs.count,
      "texts": st.objs.filter { $0.kind == "text" }.count,
      "stickers": st.objs.filter { $0.kind == "sticker" }.count,
    ]
    res["type"] = "image"
    if st.isPristine {
      edits["changed"] = false
      res["edits"] = edits
      res["uri"] = opts.uri
      if let s = MEImage.size(opts.uri) {
        res["width"] = Int(s.width)
        res["height"] = Int(s.height)
      }
      finish(res)
      return
    }
    edits["changed"] = true
    showBusy(true)
    let f = filterAt(st.filterIdx)
    let maxDim = hd ? opts.hdMaxDim : opts.maxDim
    let quality = opts.quality
    let uri = opts.uri
    let square = opts.circleCrop
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let out = MediaEditorViewController.renderPhoto(uri: uri, state: st, filter: f, maxDim: maxDim, quality: quality, square: square)
        ?? (maxDim > 2048 ? MediaEditorViewController.renderPhoto(uri: uri, state: st, filter: f, maxDim: 2048, quality: quality, square: square) : nil)
      DispatchQueue.main.async {
        guard let self = self, !self.finished else { return }
        self.showBusy(false)
        guard let out = out else {
          self.toast(self.L("saveFailed", "Não foi possível salvar"))
          return
        }
        res["uri"] = out.0
        res["width"] = out.1
        res["height"] = out.2
        res["size"] = out.3
        res["mimeType"] = "image/jpeg"
        res["edits"] = edits
        self.finish(res)
      }
    }
  }

  /// (uri, largura, altura, bytes)
  static func renderPhoto(uri: String, state st: MEState, filter: MEFilter?, maxDim: Int, quality: CGFloat, square: Bool = false) -> (String, Int, Int, Int)? {
    return autoreleasepool { () -> (String, Int, Int, Int)? in
      guard let full = MEImage.load(uri, maxPixel: maxDim) else { return nil }
      let img = MEImage.filtered(full, filter)
      let q = ((st.rotQ % 4) + 4) % 4
      let rw = CGFloat(q % 2 == 1 ? img.height : img.width)
      let rh = CGFloat(q % 2 == 1 ? img.width : img.height)
      let c = st.crop
      let cl = (min(1, max(0, c.minX)) * rw).rounded()
      let ct = (min(1, max(0, c.minY)) * rh).rounded()
      let cr = (min(1, max(0, c.maxX)) * rw).rounded()
      let cb = (min(1, max(0, c.maxY)) * rh).rounded()
      var ow = max(1, cr - cl)
      var oh = max(1, cb - ct)
      if square {
        // circle-crop: arredondamento pode deixar 1 px de diferença → força quadrado.
        let side = min(ow, oh)
        ow = side
        oh = side
      }
      let size = CGSize(width: ow, height: oh)
      let fmt = UIGraphicsImageRendererFormat.default()
      fmt.scale = 1
      fmt.opaque = true
      let out = UIGraphicsImageRenderer(size: size, format: fmt).image { r in
        let ctx = r.cgContext
        UIColor.black.setFill()
        ctx.fill(CGRect(origin: .zero, size: size))
        ctx.saveGState()
        ctx.translateBy(x: -cl, y: -ct)
        MEImage.drawRotated(img, q: q, in: ctx)
        ctx.restoreGState()
        let f = CGRect(x: -cl, y: -ct, width: rw, height: rh)
        let short = min(rw, rh)
        for s in st.strokes { MEDraw.drawStroke(s, full: f, short: short, in: ctx) }
        for o in st.objs {
          MEDraw.drawObj(o, center: CGPoint(x: f.minX + o.u * rw, y: f.minY + o.v * rh), short: short, in: ctx)
        }
      }
      guard let data = out.jpegData(compressionQuality: quality) else { return nil }
      let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("edit_\(Int(Date().timeIntervalSince1970 * 1000)).jpg")
      do { try data.write(to: url, options: .atomic) } catch { return nil }
      return ("file://\(url.path)", Int(ow), Int(oh), data.count)
    }
  }

  private func exportVideo(_ action: String) {
    var res = baseResult(action)
    res["type"] = "video"
    guard let a = asset, durationMs > 0 else {
      res["uri"] = opts.uri
      finish(res)
      return
    }
    player?.pause()
    let trimmed = trimStart > 0 || trimEnd < durationMs - 50
    let needExport = trimmed || (muted && hasAudio)
    var edits: [String: Any] = [
      "trimStartMs": Int(trimStart),
      "trimEndMs": Int(trimEnd),
      "muted": muted,
      "changed": needExport || coverMs >= 0,
    ]
    let start = trimmed ? trimStart : 0
    let end = trimmed ? trimEnd : durationMs
    let cover = coverMs
    let mutedNow = muted
    let vsize = videoSize
    let srcUri = opts.uri
    showBusy(true)

    func deliver(_ outUri: String, _ outDur: Double, _ size: Int?, _ mime: String, _ failed: Bool) {
      var coverUri: String? = nil
      if cover >= 0 {
        let g = AVAssetImageGenerator(asset: a)
        g.appliesPreferredTrackTransform = true
        g.maximumSize = CGSize(width: 1280, height: 1280)
        g.requestedTimeToleranceBefore = .zero
        g.requestedTimeToleranceAfter = .zero
        if let cg = try? g.copyCGImage(at: CMTime(seconds: cover / 1000, preferredTimescale: 600), actualTime: nil),
           let data = UIImage(cgImage: cg).jpegData(compressionQuality: 0.88) {
          let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("cover_\(Int(Date().timeIntervalSince1970 * 1000)).jpg")
          if (try? data.write(to: url, options: .atomic)) != nil { coverUri = "file://\(url.path)" }
        }
      }
      DispatchQueue.main.async { [weak self] in
        guard let self = self, !self.finished else { return }
        self.showBusy(false)
        if failed {
          edits["exportFailed"] = true
        }
        res["uri"] = outUri
        res["durationMs"] = Int(outDur)
        res["width"] = Int(vsize.width)
        res["height"] = Int(vsize.height)
        if let s = size { res["size"] = s }
        res["mimeType"] = mime
        if let cu = coverUri {
          res["coverUri"] = cu
          res["coverMs"] = Int(max(0, cover - (failed ? 0 : start)))
        }
        res["edits"] = edits
        self.finish(res)
      }
    }

    guard needExport else {
      DispatchQueue.global(qos: .userInitiated).async { deliver(srcUri, self.durationMs, nil, "video/mp4", false) }
      return
    }
    DispatchQueue.global(qos: .userInitiated).async {
      let comp = AVMutableComposition()
      let range = CMTimeRange(start: CMTime(seconds: start / 1000, preferredTimescale: 600),
                              end: CMTime(seconds: end / 1000, preferredTimescale: 600))
      guard let vt = a.tracks(withMediaType: .video).first,
            let cvt = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
            (try? cvt.insertTimeRange(range, of: vt, at: .zero)) != nil else {
        deliver(srcUri, end - start, nil, "video/mp4", true)
        return
      }
      cvt.preferredTransform = vt.preferredTransform
      if !mutedNow, let at = a.tracks(withMediaType: .audio).first,
         let cat = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
        try? cat.insertTimeRange(range, of: at, at: .zero)
      }
      let compatible = AVAssetExportSession.exportPresets(compatibleWith: comp)
      var presets: [String] = []
      if compatible.contains(AVAssetExportPresetPassthrough) { presets.append(AVAssetExportPresetPassthrough) }
      if compatible.contains(AVAssetExportPresetHighestQuality) { presets.append(AVAssetExportPresetHighestQuality) }
      let stamp = Int(Date().timeIntervalSince1970 * 1000)

      func attempt(_ i: Int) {
        if i >= presets.count {
          deliver(srcUri, end - start, nil, "video/mp4", true)
          return
        }
        guard let session = AVAssetExportSession(asset: comp, presetName: presets[i]) else { attempt(i + 1); return }
        let type: AVFileType = session.supportedFileTypes.contains(.mp4) ? .mp4 : .mov
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("edit_\(stamp)_\(i).\(type == .mp4 ? "mp4" : "mov")")
        try? FileManager.default.removeItem(at: url)
        session.outputURL = url
        session.outputFileType = type
        session.shouldOptimizeForNetworkUse = true
        session.exportAsynchronously {
          if session.status == .completed {
            let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
            let size = (attrs?[.size] as? NSNumber)?.intValue
            deliver("file://\(url.path)", end - start, size, type == .mp4 ? "video/mp4" : "video/quicktime", false)
          } else {
            try? FileManager.default.removeItem(at: url)
            attempt(i + 1)
          }
        }
      }
      attempt(0)
    }
  }
}
