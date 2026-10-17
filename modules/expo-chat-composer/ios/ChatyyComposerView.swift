import ExpoModulesCore
import UIKit

// [2026-10-14 native-composer] Ver ChatyyComposerModule.swift (contrato).
//
// Layout (frames manuais, ancorados no RODAPÉ): o conteúdo é posicionado a
// partir do bounds.maxY com a altura DESEJADA. Quando o texto cresce, a altura
// nova vai na hora para o Yoga (setStyleSize, síncrono no RN ≥ 0.82) e também
// via onHeightChange; até o frame chegar, o conteúdo "transborda" para cima
// (clipsToBounds = false + point(inside:)) — nenhum salto visual.
//
//  ┌ replyCard (opcional, animado) ───────────────────────────────┐
//  └──────────────────────────────────────────────────────────────┘
//  ─ hairline ────────────────────────────────────────────────────
//  [+] ( 🙂  texto auto-crescente até maxLines        📷 ) [🎥][●]
//  └ bottomInset (safe-area / home indicator) ───────────────────

final class NCTextView: UITextView {
  let placeholderLabel = UILabel()
  var onPasteImage: ((UIImage, Data?, String) -> Void)?

  override init(frame: CGRect, textContainer: NSTextContainer?) {
    super.init(frame: frame, textContainer: textContainer)
    placeholderLabel.numberOfLines = 1
    placeholderLabel.isUserInteractionEnabled = false
    placeholderLabel.isAccessibilityElement = false
    addSubview(placeholderLabel)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    let inset = textContainerInset
    let pad = textContainer.lineFragmentPadding
    let w = bounds.width - inset.left - inset.right - pad * 2
    let h = ceil(font?.lineHeight ?? 20)
    placeholderLabel.frame = CGRect(x: inset.left + pad, y: inset.top, width: max(0, w), height: h)
  }

  private var pasteboardImageOnly: Bool {
    let pb = UIPasteboard.general
    guard pb.hasImages else { return false }
    // Texto + imagem (ex.: cópia de página web) → cola o texto, como o iMessage.
    if pb.hasStrings, let s = pb.string, !s.isEmpty { return false }
    return true
  }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(paste(_:)) && onPasteImage != nil && UIPasteboard.general.hasImages {
      return true
    }
    return super.canPerformAction(action, withSender: sender)
  }

  override func paste(_ sender: Any?) {
    if onPasteImage != nil && pasteboardImageOnly {
      let pb = UIPasteboard.general
      if let gif = pb.data(forPasteboardType: "com.compuserve.gif"), let img = UIImage(data: gif) {
        onPasteImage?(img, gif, "image/gif")
        return
      }
      if let png = pb.data(forPasteboardType: "public.png"), let img = UIImage(data: png) {
        onPasteImage?(img, png, "image/png")
        return
      }
      if let img = pb.image {
        onPasteImage?(img, nil, "image/jpeg")
        return
      }
    }
    super.paste(sender)
  }
}

/// Botão redondo enviar ⇄ microfone com morph (escala + giro ±60° + fade).
final class NCActionButton: UIButton {
  enum Mode { case mic, send }
  let circle = UIView()
  let micIcon = UIImageView()
  let sendIcon = UIImageView()
  let spinner = UIActivityIndicatorView(style: .medium)
  private(set) var mode: Mode = .mic

  override init(frame: CGRect) {
    super.init(frame: frame)
    circle.isUserInteractionEnabled = false
    addSubview(circle)
    for iv in [micIcon, sendIcon] {
      iv.contentMode = .center
      iv.isUserInteractionEnabled = false
      circle.addSubview(iv)
    }
    let cfg = UIImage.SymbolConfiguration(pointSize: 19, weight: .semibold)
    micIcon.image = UIImage(systemName: "mic.fill", withConfiguration: cfg)
    sendIcon.image = UIImage(systemName: "arrow.up", withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .bold))
    sendIcon.alpha = 0
    sendIcon.transform = CGAffineTransform(rotationAngle: -.pi / 3).scaledBy(x: 0.4, y: 0.4)
    spinner.hidesWhenStopped = true
    spinner.isUserInteractionEnabled = false
    circle.addSubview(spinner)
    addTarget(self, action: #selector(pressDown), for: [.touchDown, .touchDragEnter])
    addTarget(self, action: #selector(pressUp), for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    let d = min(bounds.width, bounds.height)
    circle.bounds = CGRect(x: 0, y: 0, width: d, height: d)
    circle.center = CGPoint(x: bounds.midX, y: bounds.midY)
    circle.layer.cornerRadius = d / 2
    for v in [micIcon, sendIcon, spinner] as [UIView] {
      v.bounds = CGRect(x: 0, y: 0, width: d, height: d)
      v.center = CGPoint(x: d / 2, y: d / 2)
    }
  }

  func apply(background: UIColor, icon: UIColor) {
    circle.backgroundColor = background
    micIcon.tintColor = icon
    sendIcon.tintColor = icon
    spinner.color = icon
  }

  func setSending(_ on: Bool) {
    if on {
      spinner.startAnimating()
      sendIcon.isHidden = true
      micIcon.isHidden = true
    } else {
      spinner.stopAnimating()
      sendIcon.isHidden = false
      micIcon.isHidden = false
    }
  }

  func setMode(_ m: Mode, animated: Bool) {
    guard m != mode else { return }
    mode = m
    let incoming = m == .send ? sendIcon : micIcon
    let outgoing = m == .send ? micIcon : sendIcon
    let dirIn: CGFloat = m == .send ? -1 : 1
    let outT = CGAffineTransform(rotationAngle: -dirIn * .pi / 3).scaledBy(x: 0.4, y: 0.4)
    if !animated || UIAccessibility.isReduceMotionEnabled {
      incoming.layer.removeAllAnimations()
      outgoing.layer.removeAllAnimations()
      incoming.alpha = 1
      incoming.transform = .identity
      outgoing.alpha = 0
      outgoing.transform = outT
      return
    }
    incoming.transform = CGAffineTransform(rotationAngle: dirIn * .pi / 3).scaledBy(x: 0.4, y: 0.4)
    incoming.alpha = 0
    UIView.animate(withDuration: 0.34, delay: 0, usingSpringWithDamping: 0.66, initialSpringVelocity: 0.3,
                   options: [.allowUserInteraction, .beginFromCurrentState], animations: {
      incoming.alpha = 1
      incoming.transform = .identity
      outgoing.alpha = 0
      outgoing.transform = outT
    }, completion: nil)
  }

  @objc private func pressDown() {
    UIView.animate(withDuration: 0.22, delay: 0, usingSpringWithDamping: 0.7, initialSpringVelocity: 0,
                   options: [.allowUserInteraction, .beginFromCurrentState], animations: {
      self.circle.transform = CGAffineTransform(scaleX: 0.88, y: 0.88)
    }, completion: nil)
  }

  @objc private func pressUp() {
    UIView.animate(withDuration: 0.3, delay: 0, usingSpringWithDamping: 0.55, initialSpringVelocity: 0,
                   options: [.allowUserInteraction, .beginFromCurrentState], animations: {
      self.circle.transform = .identity
    }, completion: nil)
  }
}

/// Barra de resposta/edição acima do campo (cartão arredondado, WhatsApp/Telegram).
final class NCReplyCard: UIView {
  let line = UIView()
  let titleLabel = UILabel()
  let bodyLabel = UILabel()
  let thumb = UIImageView()
  let closeButton = UIButton(type: .system)
  let closeBg = UIView()
  /// [reply-v2] ícone do tipo (SF Symbol) antes do trecho + cor do remetente.
  let kindIcon = UIImageView()
  var hasThumb = false
  private var hasIcon = false
  var baseInk: UIColor = .label { didSet { applyInk() } }
  private var accentInk: UIColor? = nil
  private var thumbToken: String = ""

  override init(frame: CGRect) {
    super.init(frame: frame)
    layer.cornerRadius = 16
    layer.borderWidth = 1
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = 0.06
    layer.shadowRadius = 8
    layer.shadowOffset = CGSize(width: 0, height: 2)
    line.layer.cornerRadius = 1.5
    addSubview(line)
    titleLabel.font = UIFontMetrics(forTextStyle: .footnote).scaledFont(for: .systemFont(ofSize: 13, weight: .semibold), maximumPointSize: 20)
    titleLabel.numberOfLines = 1
    addSubview(titleLabel)
    bodyLabel.font = UIFontMetrics(forTextStyle: .footnote).scaledFont(for: .systemFont(ofSize: 13.5), maximumPointSize: 20)
    bodyLabel.numberOfLines = 3
    bodyLabel.lineBreakMode = .byTruncatingTail
    addSubview(bodyLabel)
    thumb.contentMode = .scaleAspectFill
    thumb.clipsToBounds = true
    thumb.layer.cornerRadius = 6
    thumb.isHidden = true
    addSubview(thumb)
    kindIcon.contentMode = .scaleAspectFit
    kindIcon.isHidden = true
    addSubview(kindIcon)
    closeBg.isUserInteractionEnabled = false
    closeBg.layer.cornerRadius = 12
    addSubview(closeBg)
    closeButton.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .bold)), for: .normal)
    addSubview(closeButton)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  static func symbol(_ kind: String) -> String? {
    switch kind {
    case "photo": return "camera.fill"
    case "video": return "video.fill"
    case "vnote": return "video.circle"
    case "voice": return "mic.fill"
    case "audio": return "music.note"
    case "file": return "doc.fill"
    case "gif": return "play.rectangle.fill"
    case "sticker": return "face.smiling"
    case "location": return "mappin.and.ellipse"
    case "contact": return "person.crop.circle"
    case "poll": return "chart.bar.fill"
    case "deleted": return "trash"
    case "lock": return "lock.fill"
    case "eye": return "eye"
    case "quote": return "text.quote"
    default: return nil
    }
  }

  func applyInk() {
    let ink = accentInk ?? baseInk
    line.backgroundColor = ink
    titleLabel.textColor = ink
  }

  func configure(_ r: NCReply) {
    titleLabel.text = r.title
    bodyLabel.text = r.text
    bodyLabel.numberOfLines = r.lines > 0 ? r.lines : (r.italic ? 1 : 3)
    accentInk = r.color.map { ncColor($0, baseInk) }
    applyInk()
    if let sym = NCReplyCard.symbol(r.icon), let img = UIImage(systemName: sym, withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold)) {
      kindIcon.image = img.withRenderingMode(.alwaysTemplate)
      hasIcon = true
    } else {
      kindIcon.image = nil
      hasIcon = false
    }
    kindIcon.isHidden = !hasIcon
    if r.italic {
      let base = bodyLabel.font ?? .systemFont(ofSize: 13.5)
      if let d = base.fontDescriptor.withSymbolicTraits(.traitItalic) {
        bodyLabel.font = UIFont(descriptor: d, size: base.pointSize)
      }
    } else {
      bodyLabel.font = UIFontMetrics(forTextStyle: .footnote).scaledFont(for: .systemFont(ofSize: 13.5), maximumPointSize: 20)
    }
    let uri = r.thumbUri ?? ""
    hasThumb = !uri.isEmpty
    thumb.isHidden = !hasThumb
    thumb.layer.cornerRadius = r.thumbRound ? 21 : 6
    if uri != thumbToken {
      thumbToken = uri
      thumb.image = nil
      if hasThumb {
        NCImageLoader.shared.load(uri) { [weak self] img in
          guard let self = self, self.thumbToken == uri else { return }
          self.thumb.image = img
          if img == nil { self.thumb.backgroundColor = UIColor.gray.withAlphaComponent(0.22) }
        }
      }
    }
    setNeedsLayout()
  }

  func preferredHeight(width: CGFloat) -> CGFloat {
    let textW = textWidth(width)
    let th = ceil(titleLabel.sizeThatFits(CGSize(width: textW, height: .greatestFiniteMagnitude)).height)
    let bh = ceil(bodyLabel.sizeThatFits(CGSize(width: hasIcon ? textW - 18 : textW, height: .greatestFiniteMagnitude)).height)
    return max(54, 10 + th + 2 + bh + 10)
  }

  private func textWidth(_ width: CGFloat) -> CGFloat {
    // 12 (pad) + 3 (linha) + 10 + texto + [8 + 42 thumb] + 44 fechar + 4
    var w = width - 12 - 3 - 10 - 44 - 4
    if hasThumb { w -= 50 }
    return max(40, w)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let h = bounds.height
    line.frame = CGRect(x: 12, y: 10, width: 3, height: max(34, h - 20))
    let tw = textWidth(bounds.width)
    let th = ceil(titleLabel.sizeThatFits(CGSize(width: tw, height: .greatestFiniteMagnitude)).height)
    let bh = ceil(bodyLabel.sizeThatFits(CGSize(width: hasIcon ? tw - 18 : tw, height: .greatestFiniteMagnitude)).height)
    let blockH = th + 2 + bh
    let y0 = max(10, (h - blockH) / 2)
    titleLabel.frame = CGRect(x: 25, y: y0, width: tw, height: th)
    if hasIcon {
      let isz: CGFloat = 14
      let lineH = min(bh, bodyLabel.font.lineHeight)
      kindIcon.frame = CGRect(x: 25, y: y0 + th + 2 + max(0, (lineH - isz) / 2), width: isz, height: isz)
      bodyLabel.frame = CGRect(x: 25 + isz + 4, y: y0 + th + 2, width: tw - isz - 4, height: bh)
    } else {
      bodyLabel.frame = CGRect(x: 25, y: y0 + th + 2, width: tw, height: bh)
    }
    let closeX = bounds.width - 4 - 44
    closeButton.frame = CGRect(x: closeX, y: (h - 44) / 2, width: 44, height: 44)
    closeBg.frame = CGRect(x: closeX + 10, y: (h - 24) / 2, width: 24, height: 24)
    if hasThumb {
      thumb.frame = CGRect(x: closeX - 42, y: (h - 42) / 2, width: 42, height: 42)
    }
    layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: 16).cgPath
  }
}

/// Carregador mínimo de miniaturas (https, file://, data:) com cache em memória.
final class NCImageLoader {
  static let shared = NCImageLoader()
  private let cache = NSCache<NSString, UIImage>()
  private var waiters: [String: [(UIImage?) -> Void]] = [:]

  init() { cache.countLimit = 60 }

  func load(_ uri: String, _ cb: @escaping (UIImage?) -> Void) {
    if let img = cache.object(forKey: uri as NSString) { cb(img); return }
    if waiters[uri] != nil { waiters[uri]?.append(cb); return }
    waiters[uri] = [cb]
    if uri.hasPrefix("data:") {
      var img: UIImage? = nil
      if let comma = uri.firstIndex(of: ",") {
        let b64 = String(uri[uri.index(after: comma)...])
        if let d = Data(base64Encoded: b64, options: .ignoreUnknownCharacters) { img = UIImage(data: d) }
      }
      finish(uri, img)
      return
    }
    guard let url = URL(string: uri) else { finish(uri, nil); return }
    if url.isFileURL {
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        let img = (try? Data(contentsOf: url)).flatMap { UIImage(data: $0) }
        DispatchQueue.main.async { self?.finish(uri, img) }
      }
      return
    }
    var req = URLRequest(url: url)
    req.timeoutInterval = 12
    URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
      var img: UIImage? = nil
      if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode), let data = data {
        img = UIImage(data: data)
      }
      DispatchQueue.main.async { self?.finish(uri, img) }
    }.resume()
  }

  private func finish(_ key: String, _ img: UIImage?) {
    if let img = img { cache.setObject(img, forKey: key as NSString) }
    let cbs = waiters.removeValue(forKey: key) ?? []
    for cb in cbs { cb(img) }
  }
}

final class ChatyyComposerView: ExpoView, UITextViewDelegate {
  // MARK: Events
  let onChangeText = EventDispatcher()
  let onSend = EventDispatcher()
  let onAttach = EventDispatcher()
  let onCamera = EventDispatcher()
  let onEmoji = EventDispatcher()
  let onVideoNote = EventDispatcher()
  let onVoiceRecorded = EventDispatcher()
  let onVoiceState = EventDispatcher()
  let onHeightChange = EventDispatcher()
  let onSelectionChange = EventDispatcher()
  let onPasteImage = EventDispatcher()
  let onFocusChange = EventDispatcher()
  let onReplyCancel = EventDispatcher()
  let onSendMenu = EventDispatcher()
  let onKeyboardFrame = EventDispatcher()

  // MARK: Props
  var placeholderText: String = "" { didSet { textView.placeholderLabel.text = placeholderText } }
  var labels: [String: String] = [:] { didSet { applyLabels() } }
  var pendingTheme: NCThemeRecord? = nil
  var pendingReply: NCReply?? = nil
  var sendMenuItems: [NCMenuItemRecord] = [] { didSet { rebuildSendMenu() } }
  var bottomInset: CGFloat = 0 { didSet { if bottomInset != oldValue { needsRelayout = true } } }
  var sending = false { didSet { if sending != oldValue { actionButton.setSending(sending && actionButton.mode == .send) } } }
  var uploading = false { didSet { if uploading != oldValue { updateUploading() } } }
  var enterSends = false { didSet { textView.returnKeyType = enterSends ? .send : .default; if textView.isFirstResponder { textView.reloadInputViews() } } }
  var autocorrect = true {
    didSet {
      guard autocorrect != oldValue else { return }
      textView.autocorrectionType = autocorrect ? .default : .no
      textView.autocapitalizationType = autocorrect ? .sentences : .none
      textView.spellCheckingType = autocorrect ? .default : .no
      if textView.isFirstResponder { textView.reloadInputViews() }
    }
  }
  var maxLength = 5000
  var maxLines = 6 { didSet { if maxLines != oldValue { needsRelayout = true } } }
  var showEmoji = true { didSet { if showEmoji != oldValue { needsRelayout = true } } }
  var emojiActive = false { didSet { if emojiActive != oldValue { tintIcons() } } }
  var showCamera = true { didSet { if showCamera != oldValue { needsRelayout = true } } }
  var showVideoNote = false { didSet { if showVideoNote != oldValue { needsRelayout = true } } }
  var voiceEnabled = true
  var voiceBlocked = false
  var disabled = false { didSet { if disabled != oldValue { alpha = disabled ? 0.4 : 1; isUserInteractionEnabled = !disabled } } }
  var changeDebounceMs: Double = 60
  var keyboardTracking: String = "none" { didSet { if keyboardTracking != oldValue { updateKeyboardTracking() } } }
  // [2026-10-16 motion-composer] false = movimento antigo (kill switch JS
  // globalThis.__chatyy_motion_composer = false → prop motion=false).
  var motion = true

  // MARK: Subviews
  let barView = UIView()
  let hairline = UIView()
  let plusButton = UIButton(type: .system)
  let plusSpinner = UIActivityIndicatorView(style: .medium)
  let pillView = UIView()
  let emojiButton = UIButton(type: .system)
  let textView = NCTextView(frame: .zero, textContainer: nil)
  let cameraButton = UIButton(type: .system)
  let videoNoteButton = UIButton(type: .system)
  let actionButton = NCActionButton(frame: .zero)
  let replyCard = NCReplyCard(frame: .zero)
  lazy var voice = NCVoiceController(host: self)

  // MARK: State
  private var theme = NCThemeRecord()
  private var themeColors = NCResolvedTheme()
  private var replyRecord: NCReply? = nil
  private var replyVisible = false
  private var replyClosing = false // [reply-card-ios] saída em andamento (X local + prop null)
  private var replyGen = 0         // [reply-card-ios] coalesce props de resposta adiadas
  private var heightReassertScheduled = false
  private var mentionMap: [String: String] = [:] // token(lower) → email
  private var lastEmittedText: String = ""
  private var changeTimer: Timer?
  private var lastHeight: CGFloat = 0
  private var needsRelayout = true
  private var defaultTextApplied = false
  private var cameraVisible = true
  private var isApplyingStyle = false
  private(set) var contentTop: CGFloat = 0 // y do topo do conteúdo (pode ser < 0)
  private var kbProbe: UIView?
  private var kbLink: CADisplayLink?
  private var kbLastLift: CGFloat = -1

  private static let mentionRegex = try? NSRegularExpression(pattern: "@[\\w.\\-]+", options: [])

  // MARK: Metrics
  private let padL: CGFloat = 4
  private let padR: CGFloat = 8
  private let padTop: CGFloat = 6
  private let gap: CGFloat = 4
  private let rowMin: CGFloat = 44
  // [2026-10-17 wa-composer] pílula 36pt (1 linha), raio 18, centrada na linha de 44 dos botões
  private let pillInsetV: CGFloat = 4
  private let pillMinH: CGFloat = 36

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = false
    backgroundColor = .clear

    replyCard.alpha = 0
    replyCard.isHidden = true
    replyCard.closeButton.addTarget(self, action: #selector(replyCloseTapped), for: .touchUpInside)
    addSubview(replyCard)

    addSubview(barView)
    barView.addSubview(hairline)

    plusButton.setImage(UIImage(systemName: "plus", withConfiguration: UIImage.SymbolConfiguration(pointSize: 22, weight: .regular)), for: .normal)
    plusButton.addTarget(self, action: #selector(plusTapped), for: .touchUpInside)
    barView.addSubview(plusButton)
    plusSpinner.hidesWhenStopped = true
    plusSpinner.isUserInteractionEnabled = false
    plusButton.addSubview(plusSpinner)

    pillView.layer.cornerRadius = 18
    if #available(iOS 13.0, *) { pillView.layer.cornerCurve = .continuous }
    pillView.layer.borderWidth = 1
    barView.addSubview(pillView)

    emojiButton.setImage(UIImage(systemName: "face.smiling", withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .regular)), for: .normal)
    emojiButton.addTarget(self, action: #selector(emojiTapped), for: .touchUpInside)
    pillView.addSubview(emojiButton)

    let font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: 16), maximumPointSize: 32)
    textView.font = font
    textView.adjustsFontForContentSizeCategory = true
    textView.backgroundColor = .clear
    textView.textContainerInset = UIEdgeInsets(top: 7, left: 4, bottom: 7, right: 4)
    textView.textContainer.lineFragmentPadding = 0
    textView.isScrollEnabled = false
    textView.scrollsToTop = false
    textView.showsVerticalScrollIndicator = true
    textView.delegate = self
    textView.returnKeyType = .default
    textView.enablesReturnKeyAutomatically = false
    textView.dataDetectorTypes = []
    textView.smartInsertDeleteType = .default
    textView.placeholderLabel.font = font
    textView.onPasteImage = { [weak self] img, data, mime in self?.handlePastedImage(img, data: data, mime: mime) }
    pillView.addSubview(textView)

    cameraButton.setImage(UIImage(systemName: "camera", withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .regular)), for: .normal)
    cameraButton.addTarget(self, action: #selector(cameraTapped), for: .touchUpInside)
    pillView.addSubview(cameraButton)

    videoNoteButton.setImage(UIImage(systemName: "video", withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .regular)), for: .normal)
    videoNoteButton.addTarget(self, action: #selector(videoNoteTapped), for: .touchUpInside)
    barView.addSubview(videoNoteButton)

    actionButton.addTarget(self, action: #selector(actionTapped), for: .touchUpInside)
    barView.addSubview(actionButton)
    voice.attach(to: actionButton)

    applyResolvedTheme()
    applyLabels()
    rebuildSendMenu()
  }

  deinit {
    changeTimer?.invalidate()
    kbLink?.invalidate()
    kbProbe?.removeFromSuperview()
  }

  // MARK: Props commit

  func didUpdateProps() {
    if let t = pendingTheme {
      pendingTheme = nil
      theme = t
      themeColors = NCResolvedTheme(t)
      applyResolvedTheme()
    }
    if let r = pendingReply {
      pendingReply = nil
      // [2026-10-16 reply-card-ios] FORA da transação de montagem do Fabric:
      // OnViewDidUpdateProps roda dentro do finalizeUpdates; aplicar o cartão,
      // pedir altura nova (setStyleSize síncrono) e abrir o teclado ali dentro
      // perdia a altura/animação (build 692: cartão invisível). Só a última
      // prop pendente vale (replyGen).
      replyGen &+= 1
      let gen = replyGen
      DispatchQueue.main.async { [weak self] in
        guard let self = self, self.replyGen == gen else { return }
        self.setReply(r)
      }
    }
    if needsRelayout {
      relayout(animated: false)
      // Altura pedida durante a montagem pode não pegar → reafirma depois.
      reassertHeightSoon()
    }
  }

  func applyDefaultText(_ s: String) {
    guard !defaultTextApplied else { return }
    defaultTextApplied = true
    guard !s.isEmpty else { return }
    setTextFromJS(s)
  }

  func setMentionCandidates(_ list: [NCMentionRecord]) {
    var m: [String: String] = [:]
    for c in list {
      let tok = c.token.trimmingCharacters(in: .whitespaces).lowercased()
      if !tok.isEmpty { m[tok.hasPrefix("@") ? String(tok.dropFirst()) : tok] = c.email }
    }
    if m != mentionMap {
      mentionMap = m
      applyMentionStyling()
    }
  }

  private func applyLabels() {
    plusButton.accessibilityLabel = labels["attach"]
    emojiButton.accessibilityLabel = labels["emoji"]
    cameraButton.accessibilityLabel = labels["camera"]
    videoNoteButton.accessibilityLabel = labels["videoNote"]
    replyCard.closeButton.accessibilityLabel = labels["cancel"]
    updateActionA11y()
    voice.labels = labels
  }

  private func updateActionA11y() {
    actionButton.accessibilityLabel = actionButton.mode == .send ? labels["send"] : labels["record"]
    actionButton.accessibilityHint = actionButton.mode == .send ? nil : labels["holdToRecord"]
  }

  private func applyResolvedTheme() {
    let c = themeColors
    barView.backgroundColor = c.surface
    hairline.backgroundColor = c.hairline
    pillView.backgroundColor = c.pill
    pillView.layer.borderColor = c.pillBorder.cgColor
    textView.textColor = c.text
    textView.tintColor = c.accent
    textView.keyboardAppearance = theme.dark ? .dark : .light
    textView.placeholderLabel.textColor = c.placeholder
    plusButton.tintColor = c.text
    plusSpinner.color = c.text
    cameraButton.tintColor = c.icon
    videoNoteButton.tintColor = c.text
    actionButton.apply(background: c.action, icon: c.actionIcon)
    replyCard.backgroundColor = c.replyCard
    replyCard.layer.borderColor = c.replyCardBorder.cgColor
    replyCard.baseInk = c.text
    replyCard.bodyLabel.textColor = c.secondaryText
    replyCard.kindIcon.tintColor = c.secondaryText
    replyCard.closeButton.tintColor = c.secondaryText
    replyCard.closeBg.backgroundColor = theme.dark ? UIColor.white.withAlphaComponent(0.10) : UIColor.black.withAlphaComponent(0.06)
    voice.applyTheme(c, dark: theme.dark)
    tintIcons()
    applyMentionStyling()
  }

  private func tintIcons() {
    emojiButton.tintColor = emojiActive ? themeColors.iconActive : themeColors.icon
  }

  private func updateUploading() {
    if uploading {
      plusButton.setImage(nil, for: .normal)
      plusSpinner.startAnimating()
      plusButton.isEnabled = false
    } else {
      plusSpinner.stopAnimating()
      plusButton.setImage(UIImage(systemName: "plus", withConfiguration: UIImage.SymbolConfiguration(pointSize: 22, weight: .regular)), for: .normal)
      plusButton.isEnabled = true
    }
  }

  private func rebuildSendMenu() {
    guard actionButton.mode == .send, !sendMenuItems.isEmpty else {
      actionButton.menu = nil
      return
    }
    let actions: [UIMenuElement] = sendMenuItems.map { item in
      UIAction(title: item.label) { [weak self] _ in
        self?.onSendMenu(["key": item.key])
      }
    }
    actionButton.menu = UIMenu(title: labels["sendMenuTitle"] ?? "", children: actions)
    actionButton.showsMenuAsPrimaryAction = false
  }

  // MARK: Reply bar

  private func setReply(_ r: NCReply?) {
    if let r = r {
      let wasVisible = replyVisible
      let wasClosing = replyClosing
      let keyChanged = replyRecord?.key != r.key
      replyRecord = r
      replyClosing = false
      replyCard.configure(r)
      replyVisible = true
      replyCard.isHidden = false
      if !wasVisible {
        // Estado inicial ANTES do layout (sem piscar na posição final).
        replyCard.layer.removeAllAnimations()
        replyCard.alpha = 0
        replyCard.transform = .identity
      }
      relayout(animated: false)
      let reduce = UIAccessibility.isReduceMotionEnabled
      if !wasVisible {
        // [reply-v2] entra com mola de baixo (Telegram)
        replyCard.transform = reduce ? .identity : ((r.pop) ? CGAffineTransform(translationX: 0, y: 26).scaledBy(x: 0.97, y: 0.97) : CGAffineTransform(translationX: 0, y: 12))
        UIView.animate(withDuration: r.pop ? 0.46 : 0.32, delay: 0, usingSpringWithDamping: r.pop ? 0.74 : 0.82, initialSpringVelocity: r.pop ? 0.6 : 0.2,
                       options: [.allowUserInteraction, .beginFromCurrentState], animations: {
          self.replyCard.alpha = 1
          self.replyCard.transform = .identity
        }, completion: nil)
      } else if wasClosing || (replyCard.layer.presentation()?.opacity ?? 1) < 0.99 || replyCard.alpha < 1 {
        // estava saindo (X/limpo) e voltou → reverte a saída a partir do ponto atual
        UIView.animate(withDuration: 0.26, delay: 0, usingSpringWithDamping: 0.82, initialSpringVelocity: 0,
                       options: [.allowUserInteraction, .beginFromCurrentState], animations: {
          self.replyCard.alpha = 1
          self.replyCard.transform = .identity
        }, completion: nil)
      } else if keyChanged && r.pop && !reduce {
        // outro alvo com o cartão já aberto → "pulinho" sutil
        replyCard.transform = CGAffineTransform(scaleX: 0.97, y: 0.97)
        UIView.animate(withDuration: 0.36, delay: 0, usingSpringWithDamping: 0.6, initialSpringVelocity: 0.4,
                       options: [.allowUserInteraction, .beginFromCurrentState], animations: {
          self.replyCard.transform = .identity
        }, completion: nil)
      }
      reassertHeightSoon()
      // [reply-v2] responder abre o teclado sozinho (menos ida-e-volta pelo JS).
      // Já estamos fora da montagem (didUpdateProps adia); mais um tick para o
      // frame novo assentar antes do teclado subir.
      if r.focus && r.kind == "reply" && keyChanged && !voice.isActive && !emojiActive && window != nil {
        DispatchQueue.main.async { [weak self] in
          guard let self = self, self.replyRecord?.key == r.key, self.window != nil else { return }
          self.focusInput()
        }
      }
    } else if replyVisible && !replyClosing {
      replyRecord = nil
      replyClosing = true
      UIView.animate(withDuration: 0.16, delay: 0, options: [.beginFromCurrentState, .curveEaseIn, .allowUserInteraction], animations: {
        self.replyCard.alpha = 0
        self.replyCard.transform = CGAffineTransform(translationX: 0, y: 8)
      }, completion: { _ in
        // Reaberto durante a saída → a entrada nova é dona do cartão.
        guard self.replyRecord == nil, self.replyClosing else { return }
        self.replyClosing = false
        self.replyVisible = false
        self.replyCard.isHidden = true
        self.replyCard.transform = .identity
        self.relayout(animated: false)
        self.reassertHeightSoon()
      })
    } else if !replyVisible {
      replyRecord = nil
    }
  }

  /// [2026-10-16 reply-card-ios] Reenvia a altura desejada no próximo tick se o
  /// frame do Yoga não bateu (setStyleSize pedido dentro da montagem do Fabric
  /// pode se perder; o onHeightChange garante o caminho JS também).
  private func reassertHeightSoon() {
    guard !heightReassertScheduled else { return }
    heightReassertScheduled = true
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      self.heightReassertScheduled = false
      guard self.bounds.width > 0 else { return }
      let h = ceil(self.computeFrames(width: self.bounds.width).total)
      guard abs(self.bounds.height - h) >= 0.5 else { return }
      self.lastHeight = h
      self.setStyleSize(nil, height: NSNumber(value: Float(h)))
      self.onHeightChange(["height": Double(h)])
      self.setNeedsLayout()
    }
  }

  @objc private func replyCloseTapped() {
    UISelectionFeedbackGenerator().selectionChanged()
    // [reply-v2] fecha já (animação local), sem esperar o JS limpar a prop.
    if replyRecord?.pop == true { setReply(nil) }
    onReplyCancel()
  }

  // MARK: Buttons

  @objc private func plusTapped() {
    if textView.isFirstResponder { textView.resignFirstResponder() }
    onAttach()
  }

  @objc private func emojiTapped() {
    onEmoji()
  }

  @objc private func cameraTapped() {
    onCamera()
  }

  @objc private func videoNoteTapped() {
    onVideoNote()
  }

  @objc private func actionTapped() {
    if voice.isLocked {
      voice.finishLocked()
      return
    }
    if actionButton.mode == .send {
      guard !sending else { return }
      flushChange()
      let text = textView.text ?? ""
      onSend(["text": text, "mentions": mentionsIn(text)])
    } else {
      voice.tapWithoutHold()
    }
  }

  private func mentionsIn(_ text: String) -> [String] {
    guard !mentionMap.isEmpty, let re = Self.mentionRegex else { return [] }
    var out: [String] = []
    let ns = text as NSString
    re.enumerateMatches(in: text, options: [], range: NSRange(location: 0, length: ns.length)) { m, _, _ in
      guard let m = m, m.range.length > 1 else { return }
      var tok = ns.substring(with: NSRange(location: m.range.location + 1, length: m.range.length - 1)).lowercased()
      while tok.hasSuffix(".") || tok.hasSuffix("-") { tok.removeLast() }
      if let email = mentionMap[tok], !out.contains(email) { out.append(email) }
    }
    return out
  }

  // MARK: Text

  private var hasText: Bool {
    let t = textView.text ?? ""
    return !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  func setTextFromJS(_ s: String) {
    let current = textView.text ?? ""
    lastEmittedText = s
    guard current != s else { return }
    changeTimer?.invalidate()
    changeTimer = nil
    textView.text = s
    let end = (s as NSString).length
    textView.selectedRange = NSRange(location: end, length: 0)
    applyMentionStyling()
    textChanged(emit: false)
  }

  func setSelectionFromJS(start: Int, end: Int) {
    let len = (textView.text as NSString? ?? "").length
    let s = max(0, min(len, start))
    let e = max(s, min(len, end))
    textView.selectedRange = NSRange(location: s, length: e - s)
  }

  func focusInput() {
    if !textView.isFirstResponder { textView.becomeFirstResponder() }
  }

  func blurInput() {
    if textView.isFirstResponder { textView.resignFirstResponder() }
  }

  func cancelVoiceFromJS() {
    voice.cancel(reason: "js")
  }

  func textView(_ tv: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
    if enterSends && text == "\n" && tv.markedTextRange == nil {
      if hasText && !sending { actionTapped() }
      return false
    }
    let current = (tv.text ?? "") as NSString
    let newLen = current.length - range.length + (text as NSString).length
    if newLen > maxLength && (text as NSString).length > 0 {
      // Cola só o que cabe (UITextView não corta sozinho).
      let room = maxLength - (current.length - range.length)
      if room > 0 {
        let clipped = (text as NSString).substring(to: min(room, (text as NSString).length))
        tv.textStorage.replaceCharacters(in: range, with: NSAttributedString(string: clipped, attributes: baseAttributes))
        tv.selectedRange = NSRange(location: range.location + (clipped as NSString).length, length: 0)
        textViewDidChange(tv)
      }
      return false
    }
    return true
  }

  func textViewDidChange(_ tv: UITextView) {
    if !isApplyingStyle { applyMentionStyling() }
    textChanged(emit: true)
  }

  func textViewDidChangeSelection(_ tv: UITextView) {
    let r = tv.selectedRange
    onSelectionChange(["start": r.location, "end": r.location + r.length])
  }

  func textViewDidBeginEditing(_ tv: UITextView) {
    onFocusChange(["focused": true])
  }

  func textViewDidEndEditing(_ tv: UITextView) {
    flushChange()
    onFocusChange(["focused": false])
  }

  private func textChanged(emit: Bool) {
    textView.placeholderLabel.isHidden = !(textView.text ?? "").isEmpty
    let filled = hasText
    actionButton.setMode(filled ? .send : .mic, animated: window != nil)
    actionButton.setSending(sending && filled)
    updateActionA11y()
    rebuildSendMenu()
    relayout(animated: true)
    guard emit else { return }
    let text = textView.text ?? ""
    let wasEmpty = lastEmittedText.isEmpty
    // Vazio ⇄ não vazio e debounce 0 saem na hora (botão/mention/typing no JS);
    // o resto agrupa em `changeDebounceMs` (menos eventos por tecla).
    if changeDebounceMs <= 0 || text.isEmpty || wasEmpty {
      flushChange()
    } else {
      changeTimer?.invalidate()
      let t = Timer(timeInterval: changeDebounceMs / 1000, repeats: false) { [weak self] _ in self?.flushChange() }
      RunLoop.main.add(t, forMode: .common)
      changeTimer = t
    }
  }

  private func flushChange() {
    changeTimer?.invalidate()
    changeTimer = nil
    let text = textView.text ?? ""
    guard text != lastEmittedText else { return }
    lastEmittedText = text
    onChangeText(["text": text])
  }

  private var baseAttributes: [NSAttributedString.Key: Any] {
    return [
      .font: textView.font ?? UIFont.systemFont(ofSize: 16),
      .foregroundColor: themeColors.text,
    ]
  }

  private func applyMentionStyling() {
    guard textView.markedTextRange == nil else { return }
    let storage = textView.textStorage
    let len = storage.length
    isApplyingStyle = true
    defer { isApplyingStyle = false }
    let base = baseAttributes
    textView.typingAttributes = base
    guard len > 0 else { return }
    let full = NSRange(location: 0, length: len)
    storage.beginEditing()
    storage.setAttributes(base, range: full)
    if !mentionMap.isEmpty, let re = Self.mentionRegex {
      let ns = storage.string as NSString
      let boldFont = UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: 16, weight: .semibold), maximumPointSize: 32)
      re.enumerateMatches(in: storage.string, options: [], range: full) { m, _, _ in
        guard let m = m, m.range.length > 1 else { return }
        var tok = ns.substring(with: NSRange(location: m.range.location + 1, length: m.range.length - 1)).lowercased()
        var r = m.range
        while tok.hasSuffix(".") || tok.hasSuffix("-") { tok.removeLast(); r.length -= 1 }
        if self.mentionMap[tok] != nil {
          storage.addAttributes([.foregroundColor: self.themeColors.mention, .font: boldFont], range: r)
        }
      }
    }
    storage.endEditing()
  }

  private func handlePastedImage(_ img: UIImage, data: Data?, mime: String) {
    let ext = mime == "image/gif" ? "gif" : (mime == "image/png" ? "png" : "jpg")
    let bytes: Data? = data ?? img.jpegData(compressionQuality: 0.92)
    guard let payload = bytes else { return }
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("chatyy-paste", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let name = "paste_\(Int(Date().timeIntervalSince1970 * 1000)).\(ext)"
    let url = dir.appendingPathComponent(name)
    do { try payload.write(to: url, options: .atomic) } catch { return }
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    onPasteImage([
      "uri": url.absoluteString,
      "mimeType": mime,
      "name": name,
      "width": Double(img.size.width * img.scale),
      "height": Double(img.size.height * img.scale),
      "size": payload.count,
    ])
  }

  // MARK: Layout

  private struct Frames {
    var total: CGFloat = 0
    var replyH: CGFloat = 0
    var cardH: CGFloat = 0
    var barH: CGFloat = 0
    var rowH: CGFloat = 0
    var textH: CGFloat = 0
    var pillX: CGFloat = 0
    var pillW: CGFloat = 0
    var textX: CGFloat = 0
    var textW: CGFloat = 0
    var scroll = false
    var camera = false
    var videoNote = false
  }

  private func computeFrames(width W: CGFloat) -> Frames {
    var f = Frames()
    let empty = !hasText
    let recording = voice.isActive
    f.camera = showCamera && empty
    f.videoNote = showVideoNote && empty
    let actionX = W - padR - 44
    var rightEdge = actionX - gap
    if f.videoNote { rightEdge -= 40 + 2 }
    let left = padL + 40 + gap
    f.pillX = left
    f.pillW = max(80, rightEdge - left)
    let emojiW: CGFloat = showEmoji ? 36 : 8
    f.textX = 4 + emojiW
    let rightPad: CGFloat = f.camera ? 40 + 4 : 4
    f.textW = max(40, f.pillW - f.textX - rightPad)
    let lineH = textView.font?.lineHeight ?? 19
    let maxH = ceil(lineH * CGFloat(maxLines)) + 14
    let fit = ceil(textView.sizeThatFits(CGSize(width: f.textW, height: .greatestFiniteMagnitude)).height)
    f.scroll = fit > maxH
    f.textH = max(pillMinH - 2, min(fit, maxH))
    f.rowH = recording ? rowMin : max(rowMin, f.textH + 2 + pillInsetV * 2)
    f.barH = padTop + f.rowH + max(8, bottomInset)
    if replyVisible {
      f.cardH = replyCard.preferredHeight(width: W - 16)
      f.replyH = f.cardH + 6
    }
    f.total = f.replyH + f.barH
    return f
  }

  func relayout(animated: Bool) {
    needsRelayout = false
    setNeedsLayout()
    if bounds.width > 0 {
      let f = computeFrames(width: bounds.width)
      reportHeight(f.total)
      if animated && window != nil && !UIAccessibility.isReduceMotionEnabled && motion && !voice.isActive {
        // [2026-10-16 motion-composer] campo cresce/encolhe por linha com mola
        // (Telegram): leve, sem overshoot visível, interrompível (beginFromCurrentState).
        UIView.animate(withDuration: 0.34, delay: 0, usingSpringWithDamping: 0.86, initialSpringVelocity: 0,
                       options: [.allowUserInteraction, .beginFromCurrentState], animations: {
          self.layoutIfNeeded()
        }, completion: nil)
      } else if animated && window != nil && !UIAccessibility.isReduceMotionEnabled {
        UIView.animate(withDuration: 0.18, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState, .curveEaseOut], animations: {
          self.layoutIfNeeded()
        }, completion: nil)
      } else {
        layoutIfNeeded()
      }
    }
  }

  private func reportHeight(_ h: CGFloat) {
    let rounded = ceil(h)
    guard abs(rounded - lastHeight) >= 0.5 else { return }
    lastHeight = rounded
    // Síncrono no Yoga (RN ≥ 0.82) — a lista encolhe no mesmo frame.
    setStyleSize(nil, height: NSNumber(value: Float(rounded)))
    onHeightChange(["height": Double(rounded)])
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let W = bounds.width
    guard W > 0 else { return }
    let f = computeFrames(width: W)
    if abs(ceil(f.total) - lastHeight) >= 0.5 { reportHeight(f.total) }
    // Ancorado no rodapé: topo = maxY - altura desejada (pode ser < 0 por 1 frame).
    let top = bounds.height - f.total
    contentTop = top
    if replyVisible {
      // bounds+center (não .frame): o cartão pode estar com transform da
      // animação de entrada/saída e .frame com transform ≠ identity é indefinido.
      let cf = CGRect(x: 8, y: top, width: W - 16, height: f.cardH)
      replyCard.bounds = CGRect(origin: .zero, size: cf.size)
      replyCard.center = CGPoint(x: cf.midX, y: cf.midY)
    }
    barView.frame = CGRect(x: 0, y: top + f.replyH, width: W, height: max(f.barH, bounds.height - f.replyH - top))
    hairline.frame = CGRect(x: 0, y: 0, width: W, height: 1 / max(1, UIScreen.main.scale))
    let rowBottom = padTop + f.rowH
    plusButton.frame = CGRect(x: padL, y: rowBottom - 44, width: 40, height: 44)
    plusSpinner.center = CGPoint(x: 20, y: 22)
    let actionX = W - padR - 44
    actionButton.frame = CGRect(x: actionX, y: rowBottom - 44, width: 44, height: 44)
    videoNoteButton.isHidden = !f.videoNote
    videoNoteButton.alpha = f.videoNote ? 1 : 0
    videoNoteButton.frame = CGRect(x: actionX - 2 - 40, y: rowBottom - 44, width: 40, height: 44)
    let pillH = max(pillMinH, f.rowH - pillInsetV * 2)
    pillView.frame = CGRect(x: f.pillX, y: padTop + pillInsetV, width: f.pillW, height: pillH)
    emojiButton.isHidden = !showEmoji
    emojiButton.frame = CGRect(x: 4, y: pillH - pillMinH, width: 36, height: pillMinH)
    if cameraVisible != f.camera {
      cameraVisible = f.camera
      cameraButton.isHidden = false
      UIView.performWithoutAnimation { cameraButton.alpha = f.camera ? 0 : 1 }
      UIView.animate(withDuration: 0.16) { self.cameraButton.alpha = f.camera ? 1 : 0 } completion: { _ in
        if !self.cameraVisible { self.cameraButton.isHidden = true }
      }
    } else {
      cameraButton.isHidden = !f.camera
    }
    cameraButton.frame = CGRect(x: f.pillW - 4 - 40, y: pillH - pillMinH, width: 40, height: pillMinH)
    let wasScroll = textView.isScrollEnabled
    if wasScroll != f.scroll {
      textView.isScrollEnabled = f.scroll
    }
    textView.frame = CGRect(x: f.textX, y: pillH - 1 - f.textH, width: f.textW, height: f.textH)
    if f.scroll && !wasScroll {
      let sel = textView.selectedRange
      DispatchQueue.main.async { [weak self] in self?.textView.scrollRangeToVisible(sel) }
    }
    voice.layoutPanel(in: barView, frame: CGRect(x: padL, y: padTop, width: max(0, actionX - gap - padL), height: rowMin))
  }

  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    // Conteúdo acima do bounds durante a transição de altura continua tocável.
    let r = CGRect(x: 0, y: min(0, contentTop), width: bounds.width, height: bounds.height - min(0, contentTop))
    return r.contains(point)
  }

  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    if previousTraitCollection?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory {
      textView.placeholderLabel.font = textView.font
      applyMentionStyling()
      relayout(animated: false)
    }
  }

  override func willMove(toWindow newWindow: UIWindow?) {
    super.willMove(toWindow: newWindow)
    if newWindow == nil {
      flushChange()
      voice.cancel(reason: "unmount")
      teardownKeyboardTracking()
    }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil {
      relayout(animated: false)
      updateKeyboardTracking()
    }
  }

  // MARK: Voice hooks (NCVoiceController)

  func voiceDidChangeActive() {
    let active = voice.isActive
    UIView.animate(withDuration: 0.18, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction], animations: {
      let a: CGFloat = active ? 0 : 1
      self.plusButton.alpha = a
      self.pillView.alpha = a
      self.videoNoteButton.alpha = active ? 0 : (self.showVideoNote && !self.hasText ? 1 : 0)
    }, completion: nil)
    plusButton.isUserInteractionEnabled = !active
    pillView.isUserInteractionEnabled = !active
    relayout(animated: true)
  }

  func voiceDidLock() {
    actionButton.setMode(.send, animated: true)
    actionButton.menu = nil
    actionButton.accessibilityLabel = labels["sendVoice"] ?? labels["send"]
  }

  func voiceDidEnd() {
    actionButton.setMode(hasText ? .send : .mic, animated: true)
    updateActionA11y()
    rebuildSendMenu()
  }

  func emitVoiceState(_ state: String, reason: String? = nil) {
    var body: [String: Any] = ["state": state]
    if let r = reason { body["reason"] = r }
    onVoiceState(body)
  }

  func emitVoiceRecorded(_ payload: [String: Any]) {
    onVoiceRecorded(payload)
  }

  // MARK: Keyboard tracking (opt-in: keyboardTracking = 'translate')
  // Padrão 'none': quem levanta o composer é o ThreadKeyboardAvoider
  // (react-native-keyboard-controller, também frame a frame). 'translate' é
  // para quando a lista nativa assumir o teclado: o composer segue o
  // keyboardLayoutGuide (inclusive no dismiss interativo) e emite
  // onKeyboardFrame {height, lift}.

  private func updateKeyboardTracking() {
    if keyboardTracking == "translate", window != nil {
      setupKeyboardTracking()
    } else {
      teardownKeyboardTracking()
    }
  }

  private func setupKeyboardTracking() {
    guard kbProbe == nil, let win = window else { return }
    let probe = UIView(frame: .zero)
    probe.isHidden = true
    probe.isUserInteractionEnabled = false
    probe.translatesAutoresizingMaskIntoConstraints = false
    win.addSubview(probe)
    NSLayoutConstraint.activate([
      probe.leadingAnchor.constraint(equalTo: win.leadingAnchor),
      probe.widthAnchor.constraint(equalToConstant: 1),
      probe.heightAnchor.constraint(equalToConstant: 1),
      probe.bottomAnchor.constraint(equalTo: win.keyboardLayoutGuide.topAnchor),
    ])
    kbProbe = probe
    let link = CADisplayLink(target: NCWeakTarget(self), selector: #selector(NCWeakTarget.tick))
    link.add(to: .main, forMode: .common)
    kbLink = link
  }

  private func teardownKeyboardTracking() {
    kbLink?.invalidate()
    kbLink = nil
    kbProbe?.removeFromSuperview()
    kbProbe = nil
    if kbLastLift > 0 { transform = .identity }
    kbLastLift = -1
  }

  fileprivate func keyboardTick() {
    guard let win = window, let probe = kbProbe else { return }
    let layer = probe.layer.presentation() ?? probe.layer
    let kbTop = layer.frame.maxY
    let fromBottom = max(0, win.bounds.height - kbTop)
    let lift = max(0, fromBottom - bottomInset)
    guard abs(lift - kbLastLift) >= 0.5 else { return }
    kbLastLift = lift
    transform = CGAffineTransform(translationX: 0, y: -lift)
    onKeyboardFrame(["height": Double(fromBottom), "lift": Double(lift)])
  }
}

/// CADisplayLink retém o target — proxy fraco evita ciclo.
final class NCWeakTarget: NSObject {
  weak var view: ChatyyComposerView?
  init(_ v: ChatyyComposerView) { view = v }
  @objc func tick() { view?.keyboardTick() }
}

struct NCResolvedTheme {
  var surface: UIColor = .systemBackground
  var pill: UIColor = .secondarySystemBackground
  var pillBorder: UIColor = UIColor.black.withAlphaComponent(0.14)
  var text: UIColor = .label
  var secondaryText: UIColor = .secondaryLabel
  var placeholder: UIColor = .tertiaryLabel
  var icon: UIColor = .secondaryLabel
  var iconActive: UIColor = .label
  var action: UIColor = .label
  var actionIcon: UIColor = .systemBackground
  var hairline: UIColor = UIColor.black.withAlphaComponent(0.10)
  var accent: UIColor = .systemBlue
  var mention: UIColor = .systemBlue
  var replyCard: UIColor = .systemBackground
  var replyCardBorder: UIColor = UIColor.black.withAlphaComponent(0.10)
  var recording: UIColor = .systemRed

  init() {}

  init(_ t: NCThemeRecord) {
    let d = NCResolvedTheme()
    surface = ncColor(t.surface, d.surface)
    pill = ncColor(t.pill, d.pill)
    pillBorder = ncColor(t.pillBorder, d.pillBorder)
    text = ncColor(t.text, d.text)
    secondaryText = ncColor(t.secondaryText, d.secondaryText)
    placeholder = ncColor(t.placeholder, d.placeholder)
    icon = ncColor(t.icon, d.icon)
    iconActive = ncColor(t.iconActive, text)
    action = ncColor(t.action, d.action)
    actionIcon = ncColor(t.actionIcon, d.actionIcon)
    hairline = ncColor(t.hairline, d.hairline)
    accent = ncColor(t.accent, d.accent)
    mention = ncColor(t.mention, accent)
    replyCard = ncColor(t.replyCard, surface)
    replyCardBorder = ncColor(t.replyCardBorder, d.replyCardBorder)
    recording = ncColor(t.recording, d.recording)
  }
}
