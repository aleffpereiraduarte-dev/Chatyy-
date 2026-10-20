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
  // [2026-10-17 kb-pop] true = tela saindo (pop/swipe) → nada devolve o teclado.
  var shouldBlockFocus: (() -> Bool)?
  // [2026-10-18 kb-resume] true = pedido de resign que NÃO deve fechar o teclado
  // (blur JS/KeyboardController chegando com o app indo/voltando do fundo).
  var shouldBlockResign: (() -> Bool)?
  /// Último toque do usuário DENTRO do campo (CACurrentMediaTime). Foco vindo
  /// de um toque real nunca é bloqueado pelos guardas.
  private(set) var lastTouchAt: CFTimeInterval = 0

  override func becomeFirstResponder() -> Bool {
    if shouldBlockFocus?() == true { return false }
    return super.becomeFirstResponder()
  }

  override func resignFirstResponder() -> Bool {
    if isFirstResponder, shouldBlockResign?() == true { return false }
    return super.resignFirstResponder()
  }

  /// [2026-10-20 attach-inputview] toque no campo com o painel de anexos no lugar do teclado.
  var onTouchDown: (() -> Void)?

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
    onTouchDown?()
    super.touchesBegan(touches, with: event)
  }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    let v = super.hitTest(point, with: event)
    if v != nil, event?.type == .touches { lastTouchAt = CACurrentMediaTime() }
    return v
  }

  // [2026-10-19 kb-restore] VoiceOver (toque duplo) = intenção do usuário.
  override func accessibilityActivate() -> Bool {
    lastTouchAt = CACurrentMediaTime()
    return super.accessibilityActivate()
  }

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
  let onKeyboardSync = EventDispatcher() // [2026-10-19 kb-native]
  let onAttachPanel = EventDispatcher() // [2026-10-20 attach-inputview] {key, keep?}

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
  // [2026-10-17 kb-pop] VC filho invisível da tela → recebe viewWillDisappear /
  // viewDidAppear (a UIView sozinha não sabe do pop). focusBlocked segura o
  // becomeFirstResponder do pop até a tela reaparecer.
  private var lifecycleProxy: NCLifecycleProxy?
  private var focusBlocked = false
  private var hostTransitionGen = 0
  // [2026-10-18 kb-resume] Teclado nível WhatsApp ao minimizar/voltar e ao
  // fechar a folha do "+": o iOS devolve sozinho o teclado que estava aberto;
  // qualquer focus/blur extra nesse meio = abre-fecha ("pisca").
  //  • app inativo/fundo + 0,6 s após voltar: estava FECHADO → nada abre
  //    (re-foco do envio, restauração do UIKit); estava ABERTO → nada fecha
  //    (blur JS / KeyboardController.dismiss processados no meio).
  //  • depois do "+": só foco explícito (JS focus, cartão de resposta, toque
  //    no campo) abre o teclado — a restauração automática do UIKit ao
  //    dispensar a folha não.
  // Kill switch: prop focusGuard=false (JS: globalThis.__chatyy_kb_resume_guard = false).
  var focusGuard = true
  private var appObservers: [NSObjectProtocol] = []
  private var appInactive = false
  private var resumeUntil: CFTimeInterval = 0
  private var resumeHadFocus = false
  private var attachGuard = false
  private var internalFocusOp = false
  // [2026-10-19 kb-native] Teclado 100% nativo nas trocas de tela.
  //  • nativeTransitions: a tela saindo (push/pop/swipe-back) solta o teclado
  //    ANIMADO dentro do viewWillDisappear — o UIKit amarra a descida do
  //    teclado à transição (swipe interativo = teclado segue o dedo; cancelou
  //    = volta). Antes: resign SEM animação = teclado sumia de uma vez e o
  //    composer despencava ("pisca" ao trocar de tela).
  //  • onKeyboardSync: o JS (ThreadKeyboardAvoider) deixa de confiar em estado
  //    velho. O nativo lê o quadro REAL do teclado (keyboardLayoutGuide da
  //    janela + último keyboardWillChangeFrame) e emite ao voltar do fundo,
  //    ao reaparecer a tela, ao entrar na janela e a cada did show/hide →
  //    composer "preso no meio da tela" com o teclado fechado se corrige.
  // Kill switch: prop nativeTransitions=false (JS: __chatyy_kb_native_transitions=false).
  var nativeTransitions = true
  // [2026-10-19 attach-instant] "+" nível WhatsApp/Telegram: a folha abre NA
  // HORA (o JS não espera mais o keyboardDidHide) e o teclado desce junto com
  // ela; ao CANCELAR a folha (toque fora, arrastar, X) com o teclado aberto
  // antes do "+", o próprio composer devolve o foco UMA vez, no nativo, quando
  // a folha começa a descer (Notification ChatyyAttachSheetWillClose do
  // expo-chat-attach) → teclado sobe enquanto a folha desce, sem ida-e-volta
  // pelo JS (promessa → render → focus 30 ms depois = composer "pisca").
  // Rede: no fim do dismiss (ChatyyAttachSheetDidClose) confere de novo.
  // attachRestore "did" = só no fim do dismiss (ajuste OTA).
  // Kill switch: prop attachInstant=false (JS: globalThis.__chatyy_attach_instant = false).
  var attachInstant = true { didSet { if !attachInstant { attachRestorePending = false } } }
  var attachRestore: String = "none" // [2026-10-19 attach-none] era "did"; antes "will" (sobe-desce-sobe)
  // [2026-10-19 kb-restore] "Teclado sobe e desce rapidão" ao trocar de tela /
  // fechar folha, menu ou modal. RAIZ: o UIKit guarda o first responder quando
  // algo cobre a tela (push, pageSheet, menu de contexto, folha) e o DEVOLVE
  // sozinho (becomeFirstResponder) quando a tela reaparece — o teclado sobe já
  // aberto e em seguida algum blur/dismiss (JS, focusGuard, KeyboardController)
  // o derruba = pisca. WhatsApp/Telegram: o teclado só volta por ação explícita.
  // Agora: depois que o teclado foi solto por qualquer caminho que NÃO seja o
  // nosso (UIKit, blur JS, KeyboardController.dismiss) ou a tela saiu, todo
  // becomeFirstResponder automático é recusado até haver toque no campo /
  // VoiceOver ou foco explícito (focus() do JS, cartão de resposta, swipe
  // cancelado, folha do "+" cancelada — todos via withInternalFocus). Também
  // recusa foco automático com a tela fora da janela, em transição ou coberta
  // por um modal. Volta do fundo (teclado estava aberto) segue liberada.
  // Kill switch: prop restoreGuard=false (JS: globalThis.__chatyy_kb_restore_guard = false).
  var restoreGuard = true { didSet { if !restoreGuard { restoreParked = false } } }
  private var restoreParked = false
  private var attachRestorePending = false
  private var attachRestoreAt: CFTimeInterval = 0
  // [2026-10-19 attach-hold] "+" com o teclado aberto: a conversa (JS,
  // utils/threadKeyboard threadKbAttachBegin) precisa travar a altura ANTES
  // de o teclado começar a descer — senão o KC zera o lift no willHide e a
  // lista + barra despencam até a folha cobrir. Com attachDeferResign o
  // resign espera o JS (releaseForAttach, logo depois de armar o hold); rede
  // nativa: solta sozinho em 350 ms. Kill switch: prop attachDeferResign=false
  // (JS: globalThis.__chatyy_attach_hold = false).
  var attachDeferResign = false { didSet { if !attachDeferResign { releaseForAttach() } } }
  private var attachDeferPending = false
  private var attachDeferGen = 0
  // [2026-10-19 attach-over-kb] api 9: "+" com o teclado aberto NÃO solta o
  // teclado: a folha (expo-chat-attach api 6) sobe numa janela ACIMA do
  // teclado e ele fica aberto por baixo — nenhum evento de teclado, conversa
  // parada (sem hold/clamp do JS). O teclado só desce quando a folha fecha
  // (ChatyyAttachSheetWillClose), junto com ela; cancelar com attachRestore
  // 'did'/'will' = nem desce. Rede: sem ChatyyAttachSheetWillPresent
  // {overKeyboard:true} em 0,6 s (ou folha apresentada do jeito antigo) →
  // solta como na api 8. Kill switch: prop attachKeepKeyboard=false
  // (JS: globalThis.__chatyy_attach_over_kb = false).
  var attachKeepKeyboard = false { didSet { if !attachKeepKeyboard && attachKeepWaiting { attachKeepWaiting = false; releaseForAttach() } } }
  private var attachKeepWaiting = false
  private var attachKeepActive = false
  // [2026-10-20 attach-inwindow] api 12: folha/câmera dentro da janela do
  // painel (expo-chat-attach api 8): nada de resign/present; sync de teclado
  // suprimido enquanto ela está na tela; legenda da folha devolve o painel.
  private var attachInWindow = false
  // [2026-10-20 native-dock] api 13: composer GRUDADO no teclado pelo UIKit.
  // Sonda na janela presa ao window.keyboardLayoutGuide.topAnchor; cada vez
  // que o UIKit a reposiciona (DENTRO do bloco de animação do teclado =
  // mesma curva/duração; no arraste interativo, quadro a quadro) aplicamos
  // translateY = −(teclado − bottomInset) nas views testID "chatyy-dock-bar"
  // (barra/composer/prévias/↓) e "chatyy-dock-list" (lista) da MESMA tela.
  // O JS não mexe em padding/transform nesse modo. Kill switch: prop
  // nativeDock=false (JS: globalThis.__chatyy_composer_native_dock = false).
  var nativeDock = false { didSet { if nativeDock != oldValue { if nativeDock { installDock() } else { removeDock() } } } }
  private var dockProbe: NCDockProbe?
  private let dockTargets = NSHashTable<UIView>.weakObjects()
  private var dockNeedsCollect = true
  private var dockLift: CGFloat = 0
  // [2026-10-20 attach-inputview] api 10: painel de anexos como inputView
  // (ver NCAttachPanel). Kill switch: prop attachPanel=false
  // (JS: globalThis.__chatyy_attach_inputview = false) → "+" = folha (api 9).
  var attachPanel = false { didSet { if !attachPanel && panelActive { deactivatePanel(reload: true) } } }
  var attachPanelItems: [(key: String, label: String)] = []
  private var panelActive = false
  private var panelView: NCAttachPanel?
  private var lastSystemKbHeight: CGFloat = 0
  // [2026-10-20 attach-panel-fotos] Fotos com o painel: o painel desce junto
  // com a folha subindo (folha modal cobre a área); cancelar → painel volta.
  private var panelReturnPending = false
  private static var panelHeightFix: CGFloat = 0
  private var kbNoteOverlap: CGFloat = 0
  private var kbSyncGen = 0

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
    // [2026-10-20 attach-inputview] toque no campo com o painel = volta ao teclado (WhatsApp).
    textView.onTouchDown = { [weak self] in
      guard let self = self, self.panelActive, self.textView.isFirstResponder else { return }
      self.deactivatePanel(reload: true)
    }
    textView.shouldBlockFocus = { [weak self] in self?.shouldBlockBecome() ?? false }
    textView.shouldBlockResign = { [weak self] in self?.shouldBlockResign() ?? false }
    installAppObservers()
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
    for o in appObservers { NotificationCenter.default.removeObserver(o) }
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
    textView.tintColor = panelActive ? .clear : c.accent // [2026-10-20 attach-inputview]
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
      plusButton.isEnabled = true
      setPlusIcon(keyboard: panelActive) // [2026-10-20 attach-inputview]
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
    // [2026-10-20 attach-inputview] painel no lugar do teclado (toggle).
    if attachPanel && attachInstant && !attachPanelItems.isEmpty && !voice.isActive && !disabled {
      if panelActive { switchPanelToKeyboard() } else { showAttachPanel() }
      return
    }
    if focusGuard { attachGuard = true } // [2026-10-18 kb-resume]
    let had = textView.isFirstResponder
    // [2026-10-19 attach-instant] resign ANIMADO neste mesmo runloop, ANTES da
    // folha existir: a apresentação não acha first responder p/ "guardar" e o
    // teclado desce junto com a folha subindo.
    attachRestorePending = attachInstant && had
    attachRestoreAt = CACurrentMediaTime()
    // [2026-10-19 attach-over-kb] folha por cima do teclado: não solta nada.
    if had && attachKeepKeyboard && attachInstant {
      attachDeferPending = true
      attachKeepWaiting = true
      attachKeepActive = false
      attachDeferGen &+= 1
      let gen = attachDeferGen
      onAttach(["hadKeyboard": true, "instant": true, "deferred": true, "keep": true])
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
        guard let self = self, self.attachDeferGen == gen, self.attachKeepWaiting else { return }
        self.attachKeepWaiting = false
        self.releaseForAttach()
      }
      return
    }
    // [2026-10-19 attach-hold] adia o resign até o JS armar o hold da conversa.
    if had && attachDeferResign && attachInstant {
      attachDeferPending = true
      attachDeferGen &+= 1
      let gen = attachDeferGen
      onAttach(["hadKeyboard": true, "instant": true, "deferred": true])
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
        guard let self = self, self.attachDeferGen == gen else { return }
        self.releaseForAttach()
      }
      return
    }
    if had { withInternalFocus { _ = textView.resignFirstResponder() } }
    // [2026-10-20 attach-armed] api 14: folha nativa "armada" pelo JS abre NO
    // MESMO TOQUE (logo depois do resign animado: o teclado desce com o
    // composer grudado e a folha sobe por cima, já cobrindo a área dele).
    let token = NSMutableDictionary()
    if attachInstant {
      NotificationCenter.default.post(name: Notification.Name("ChatyyComposerPlusTapped"), object: token)
    }
    var body: [String: Any] = ["hadKeyboard": had, "instant": attachInstant]
    if (token["handled"] as? Bool) == true { body["nativeOpened"] = true }
    onAttach(body)
  }

  // MARK: Painel de anexos (attach-inputview)

  private func panelTargetHeight() -> CGFloat {
    let safe = window?.safeAreaInsets.bottom ?? 0
    // inputView custom: o sistema soma a área do home indicator por fora.
    let kb = lastSystemKbHeight > safe + 100 ? lastSystemKbHeight - safe : 291
    return max(200, kb + ChatyyComposerView.panelHeightFix)
  }

  private func setPlusIcon(keyboard: Bool) {
    guard !uploading else { return }
    let name = keyboard ? "keyboard" : "plus"
    plusButton.setImage(UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: keyboard ? 19 : 22, weight: .regular)), for: .normal)
    plusButton.accessibilityLabel = keyboard ? (labels["keyboard"] ?? "Teclado") : labels["attach"]
  }

  private func showAttachPanel() {
    panelReturnPending = false
    let panel = panelView ?? NCAttachPanel(height: panelTargetHeight())
    if panelView == nil {
      panel.onPick = { [weak self] key in self?.attachPanelPicked(key) }
      panelView = panel
    }
    panel.apply(items: attachPanelItems, text: themeColors.text, dark: theme.dark)
    var f = panel.frame
    f.size.height = panelTargetHeight()
    f.size.width = window?.bounds.width ?? UIScreen.main.bounds.width
    panel.frame = f
    panelActive = true
    textView.inputView = panel
    textView.tintColor = .clear // sem cursor com o painel (WhatsApp)
    setPlusIcon(keyboard: true)
    if textView.isFirstResponder {
      textView.reloadInputViews() // troca no MESMO lugar, sem resign
    } else {
      withInternalFocus { _ = textView.becomeFirstResponder() }
      if !textView.isFirstResponder { deactivatePanel(reload: false) }
    }
  }

  private func deactivatePanel(reload: Bool) {
    guard panelActive else { return }
    panelActive = false
    textView.inputView = nil
    textView.tintColor = themeColors.accent
    setPlusIcon(keyboard: false)
    if reload && textView.isFirstResponder { textView.reloadInputViews() }
  }

  private func switchPanelToKeyboard() {
    if textView.isFirstResponder { deactivatePanel(reload: true) }
    else { deactivatePanel(reload: false); focusInput() }
  }

  private func attachPanelPicked(_ key: String) {
    guard panelActive else { return }
    // Fotos → folha "Recentes" ACIMA do painel (expo-chat-attach api 6): o
    // painel fica por baixo; cancelar volta ao painel sem mexer em nada.
    // [2026-10-20 attach-freeze] api 11: Câmera também (JS congela a conversa
    // e a câmera em tela cheia cobre; cancelar → JS chama showAttachPanel()).
    if (key == "gallery" || key == "photos" || key == "camera") && attachKeepKeyboard && textView.isFirstResponder {
      if focusGuard { attachGuard = true }
      attachRestorePending = false
      attachDeferPending = true
      attachKeepWaiting = true
      attachKeepActive = false
      attachDeferGen &+= 1
      let gen = attachDeferGen
      onAttachPanel(["key": key, "keep": true])
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
        guard let self = self, self.attachDeferGen == gen, self.attachKeepWaiting else { return }
        self.attachKeepWaiting = false
        self.releaseForAttach()
      }
      return
    }
    // [2026-10-20 attach-panel-fotos] Fotos sem a janela acima do teclado
    // (build 744: a janela ficava ABAIXO do painel/teclado): o painel sai com a
    // apresentação (WhatsApp) e volta se a folha for cancelada.
    if key == "gallery" || key == "photos" {
      panelReturnPending = true
      attachRestorePending = false
    }
    // Demais ações (tela/modal próprio): o painel desce como o teclado e a
    // ação abre em seguida (sem modal "guardando" o responder no meio).
    if focusGuard { attachGuard = true }
    if textView.isFirstResponder { withInternalFocus { _ = textView.resignFirstResponder() } }
    deactivatePanel(reload: false)
    onAttachPanel(["key": key])
  }

  /// Quadro do teclado com o painel ativo: aprende a diferença (1x) se o
  /// sistema não somou o home indicator como esperado.
  private func notePanelFrame(_ overlap: CGFloat) {
    guard panelActive, let panel = panelView, overlap > 100, lastSystemKbHeight > 100 else { return }
    let diff = lastSystemKbHeight - overlap
    guard abs(diff) > 1, abs(diff) < 80, abs(ChatyyComposerView.panelHeightFix) < 0.5 else { return }
    ChatyyComposerView.panelHeightFix = diff
    var f = panel.frame
    f.size.height = max(200, f.size.height + diff)
    panel.frame = f
    if textView.isFirstResponder { textView.reloadInputViews() }
  }

  /// [2026-10-19 attach-hold] JS armou o hold (ou rede de 350 ms): agora o
  /// teclado desce, ANIMADO, antes da folha ser apresentada (ela não acha
  /// first responder p/ guardar e devolver).
  func releaseForAttach() {
    attachKeepWaiting = false
    guard attachDeferPending else { return }
    attachDeferPending = false
    attachDeferGen &+= 1
    if textView.isFirstResponder { withInternalFocus { _ = textView.resignFirstResponder() } }
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
    // [2026-10-19 kb-restore] focus() do JS com a tela fora da janela ou coberta
    // por um modal (re-foco atrasado do envio/menu chegando no meio, folha ainda
    // descendo) = teclado subia por cima e descia quando o modal sumia. Fora da
    // janela → ignorado; coberta → espera o modal sair (até ~1,2 s) e foca UMA vez.
    if restoreGuard {
      if window == nil { return }
      if isHostCovered() { focusWhenUncovered(gen: focusWaitGen &+ 1, tries: 0); return }
    }
    if !textView.isFirstResponder { withInternalFocus { _ = textView.becomeFirstResponder() } }
  }

  private var focusWaitGen = 0
  private func focusWhenUncovered(gen: Int, tries: Int) {
    focusWaitGen = gen
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
      guard let self = self, self.focusWaitGen == gen, self.window != nil, !self.disabled else { return }
      if self.textView.isFirstResponder { return }
      if self.isHostCovered() {
        if tries < 24 { self.focusWhenUncovered(gen: gen, tries: tries + 1) }
        return
      }
      self.withInternalFocus { _ = self.textView.becomeFirstResponder() }
    }
  }

  func blurInput() {
    focusWaitGen &+= 1 // [2026-10-19 kb-restore] blur depois de um focus em espera = cancela
    // JS blur: NÃO marcado como interno → o guarda de volta do fundo pode recusar.
    if textView.isFirstResponder { textView.resignFirstResponder() }
  }

  // MARK: Focus guard (kb-resume)

  private func withInternalFocus(_ f: () -> Void) {
    let prev = internalFocusOp
    internalFocusOp = true
    f()
    internalFocusOp = prev
  }

  private func installAppObservers() {
    let nc = NotificationCenter.default
    appObservers.append(nc.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
      guard let self = self else { return }
      if !self.appInactive { self.resumeHadFocus = self.textView.isFirstResponder }
      self.appInactive = true
    })
    appObservers.append(nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      guard let self = self else { return }
      // [2026-10-19 kb-native] voltou: confere o teclado REAL logo e depois que
      // a restauração do UIKit (se houver) terminar.
      self.scheduleKeyboardSync("active", after: 0.05)
      self.scheduleKeyboardSync("active-settled", after: 0.8)
      guard self.appInactive else { return }
      self.appInactive = false
      self.resumeUntil = CACurrentMediaTime() + 0.6
    })
    // [2026-10-19 kb-native] quadro real do teclado (fonte de verdade p/ o sync).
    appObservers.append(nc.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { [weak self] n in
      self?.noteKeyboardFrame(n)
      self?.dockNeedsCollect = true // [2026-10-20 native-dock] barras/prévias novas entram na próxima
      self?.dockMoved() // [2026-10-20 dock-fix] teto novo (mesmo contexto de animação do teclado)
    })
    appObservers.append(nc.addObserver(forName: UIResponder.keyboardDidShowNotification, object: nil, queue: .main) { [weak self] n in
      self?.noteKeyboardFrame(n)
      self?.scheduleKeyboardSync("didShow", after: 0)
    })
    appObservers.append(nc.addObserver(forName: UIResponder.keyboardDidHideNotification, object: nil, queue: .main) { [weak self] _ in
      self?.kbNoteOverlap = 0
      self?.scheduleKeyboardSync("didHide", after: 0)
    })
    // [2026-10-19 attach-instant] folha do "+" (expo-chat-attach) fechando.
    appObservers.append(nc.addObserver(forName: Notification.Name("ChatyyAttachSheetWillClose"), object: nil, queue: .main) { [weak self] n in
      self?.attachSheetClosing(n, final: false)
    })
    appObservers.append(nc.addObserver(forName: Notification.Name("ChatyyAttachSheetDidClose"), object: nil, queue: .main) { [weak self] n in
      self?.attachSheetClosing(n, final: true)
    })
    // [2026-10-19 attach-over-kb] folha entrando: acima do teclado = mantém.
    appObservers.append(nc.addObserver(forName: Notification.Name("ChatyyAttachSheetWillPresent"), object: nil, queue: .main) { [weak self] n in
      self?.attachSheetPresenting(n)
    })
    // [2026-10-20 attach-inwindow] legenda da folha soltou o teclado → painel de volta por baixo.
    appObservers.append(nc.addObserver(forName: Notification.Name("ChatyyAttachCaptionDone"), object: nil, queue: .main) { [weak self] _ in
      guard let self = self, self.attachKeepActive, self.attachInWindow, self.attachPanel, !self.panelActive else { return }
      DispatchQueue.main.async { self.showAttachPanelInstant() }
    })
  }

  private func attachSheetPresenting(_ n: Notification) {
    guard attachDeferPending else { return }
    let over = (n.userInfo?["overKeyboard"] as? Bool) ?? false
    if over && attachKeepWaiting && window != nil {
      // Teclado fica aberto sob a folha; nada mais o solta até ela fechar.
      attachInWindow = (n.userInfo?["inWindow"] as? Bool) ?? false // [2026-10-20 attach-inwindow]
      attachKeepWaiting = false
      attachKeepActive = true
      attachDeferPending = false
      attachDeferGen &+= 1
      return
    }
    // [2026-10-20 attach-freeze] folha MODAL por cima do painel: retrato do
    // painel na janela do app (o stash do UIKit tira o painel num quadro; o
    // retrato fica no lugar por baixo da folha) e o painel volta ao cancelar.
    let kind = (n.userInfo?["kind"] as? String) ?? "sheet"
    if panelActive && attachKeepWaiting && kind != "camera" {
      placePanelSnapshot()
      panelReturnPending = true
    }
    releaseForAttach() // folha do jeito antigo (modal) → comportamento da api 8
  }

  // MARK: Retrato do painel (attach-freeze)

  private var panelSnapshot: UIView?

  private func placePanelSnapshot() {
    removePanelSnapshot(animated: false)
    guard let panel = panelView, let kw = panel.window, let appWin = window else { return }
    let r = panel.convert(panel.bounds, to: kw)
    guard r.height > 1 else { return }
    let full = CGRect(x: r.minX, y: r.minY, width: r.width, height: max(r.height, kw.bounds.maxY - r.minY))
    guard let snap = kw.resizableSnapshotView(from: full, afterScreenUpdates: false, withCapInsets: .zero) else { return }
    let inApp = appWin.convert(full, from: kw)
    snap.frame = inApp
    snap.isUserInteractionEnabled = false
    appWin.addSubview(snap)
    panelSnapshot = snap
    // rede: nunca fica preso (folha aberta por muito tempo some sozinho só quando a tela voltar)
  }

  private func removePanelSnapshot(animated: Bool) {
    guard let snap = panelSnapshot else { return }
    panelSnapshot = nil
    if !animated { snap.removeFromSuperview(); return }
    UIView.animate(withDuration: 0.15, animations: { snap.alpha = 0 }, completion: { _ in snap.removeFromSuperview() })
  }

  /// Painel de volta SEM animação (o retrato/painel falso estava no lugar).
  private func showAttachPanelInstant() {
    guard attachPanel, attachInstant, window != nil, !panelActive, !voice.isActive, !disabled else {
      removePanelSnapshot(animated: true)
      return
    }
    UIView.performWithoutAnimation {
      self.showAttachPanel()
      self.window?.layoutIfNeeded()
    }
    // o painel real já cobre o retrato no próximo quadro
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in self?.removePanelSnapshot(animated: false) }
  }

  /// [2026-10-20 attach-freeze] JS (api 11): câmera do painel cancelada → painel volta.
  func showAttachPanelFromJS() {
    showAttachPanelInstant()
  }

  // MARK: Attach sheet (attach-instant)

  private func attachSheetClosing(_ n: Notification, final: Bool) {
    // [2026-10-19 attach-hold] folha fechou: quadro REAL do teclado p/ o JS
    // (fechado ⇒ assenta o lift na hora; nada de barra "levantada" sem teclado).
    if final { scheduleKeyboardSync("attach-closed", after: 0.05) }
    releaseForAttach()
    let info: [AnyHashable: Any] = n.userInfo ?? [:]
    let action: String = (info["action"] as? String) ?? ""
    let byUser: Bool = (info["user"] as? Bool) ?? false
    // [2026-10-20 attach-panel-fotos] folha aberta pelo "Fotos" do painel:
    // cancelou → o painel volta (1 volta do runloop depois do dismiss, como o
    // 'did': antes disso o dismiss do UIKit derrubaria o foco devolvido).
    if panelReturnPending {
      if !final { return }
      panelReturnPending = false
      if action == "cancel" && byUser && attachPanel && attachInstant {
        // [2026-10-20 kb-glued] sem retrato (padrão): painel volta com a animação
        // do teclado e o composer sobe grudado; com retrato (freeze opt-in) = sem animação.
        DispatchQueue.main.async { [weak self] in
          guard let self = self else { return }
          if self.panelSnapshot == nil {
            guard self.window != nil, !self.panelActive, !self.voice.isActive, !self.disabled, self.attachPanel else { return }
            self.showAttachPanel()
          } else {
            self.showAttachPanelInstant()
          }
        }
      } else {
        removePanelSnapshot(animated: true)
      }
      return
    }
    // [2026-10-19 attach-over-kb] o teclado ficou aberto sob a folha: a folha
    // começou a descer → solta agora (ANIMADO, desce junto com ela; a barra
    // acompanha o teclado, sem buraco). Cancelar com 'did'/'will' = fica.
    // [2026-10-20 attach-inwindow] câmera na janela do painel fechou: painel
    // continua (a próxima tela, se houver, cuida do teclado).
    if ((info["kind"] as? String) ?? "") == "camera" {
      if attachKeepActive { attachKeepActive = false; attachInWindow = false }
      return
    }
    if attachKeepActive {
      // [2026-10-20 attach-inputview] veio do painel: cancelar volta ao painel.
      let keep = attachInstant && action == "cancel" && byUser && (attachRestore != "none" || panelActive)
      // [2026-10-20 attach-inwindow] folha dentro da janela do painel: só
      // solta o painel DEPOIS de a folha sair (senão some no meio da descida).
      if attachInWindow && !final && !keep { return }
      attachKeepActive = false
      attachInWindow = false
      if textView.isFirstResponder {
        attachRestorePending = false
        if !keep { withInternalFocus { _ = textView.resignFirstResponder() } }
        return
      }
      // legenda da folha levou o teclado: segue a regra de devolução abaixo.
    }
    guard attachRestorePending else { return }
    // Só "cancelar" pelo usuário devolve o teclado (WhatsApp). Ação (Galeria,
    // Câmera, Arquivo…), Enviar ou fechamento pelo JS (troca de tela) → fechado.
    // [2026-10-19 attach-none] "none" (padrão api 7) = teclado continua fechado
    // depois da folha, mesmo cancelando (pedido do founder: sem sobe-desce).
    let restore = action == "cancel" && byUser && attachRestore != "none"
    if !final {
      if !restore { attachRestorePending = false; return }
      if attachRestore != "did" { restoreFocusAfterAttach() }
      return
    }
    attachRestorePending = false
    guard restore else { return }
    // modo "did" ou rede: a dispensa do UIKit derrubou o foco devolvido cedo.
    // [2026-10-19 kb-restore] "did": 1 volta do runloop depois do dismiss — o
    // UIKit termina de restaurar os input views da folha (nenhum) antes; focar
    // dentro do completion podia ser derrubado em seguida (sobe-desce).
    if attachRestore == "did" {
      DispatchQueue.main.async { [weak self] in
        guard let self = self, !self.textView.isFirstResponder else { return }
        self.restoreFocusAfterAttach()
      }
      return
    }
    if !textView.isFirstResponder { restoreFocusAfterAttach() }
  }

  private func restoreFocusAfterAttach() {
    guard attachInstant, window != nil, !disabled, !appInactive, !voice.isActive else { return }
    guard CACurrentMediaTime() - attachRestoreAt < 600 else { return }
    guard !textView.isFirstResponder else { return }
    withInternalFocus { _ = textView.becomeFirstResponder() }
  }

  private var inResumeWindow: Bool { appInactive || CACurrentMediaTime() < resumeUntil }

  private func shouldBlockBecome() -> Bool {
    if isFocusBlockedNow() { return true }
    if shouldBlockAutoRestore() { return true } // [2026-10-19 kb-restore]
    guard focusGuard else { return false }
    if CACurrentMediaTime() - textView.lastTouchAt < 0.8 { attachGuard = false; return false }
    if inResumeWindow && !resumeHadFocus { return true }
    if attachGuard && !internalFocusOp { return true }
    return false
  }

  /// [2026-10-19 kb-restore] true = becomeFirstResponder automático (UIKit
  /// devolvendo o responder guardado) que faria o teclado subir-e-descer.
  private func shouldBlockAutoRestore() -> Bool {
    guard restoreGuard, !internalFocusOp else { return false }
    if CACurrentMediaTime() - textView.lastTouchAt < 0.8 { return false } // toque real
    // volta do fundo com o teclado aberto: o iOS devolve, não é ida-e-volta.
    if inResumeWindow && resumeHadFocus && !restoreParked { return false }
    if restoreParked { return true }
    if window == nil { return true }
    if let vc = nearestViewController() {
      if vc.transitionCoordinator != nil || vc.isMovingFromParent || vc.isBeingDismissed || vc.isMovingToParent { return true }
    }
    return isHostCovered()
  }

  /// Algum modal (pageSheet, folha, menu) apresentado por cima da tela do composer.
  private func isHostCovered() -> Bool {
    guard let win = window, let root = win.rootViewController, let vc = nearestViewController() else { return false }
    var top: UIViewController = root
    while let p = top.presentedViewController { top = p }
    if top === root { return false }
    return !vc.view.isDescendant(of: top.view)
  }

  private func shouldBlockResign() -> Bool {
    guard focusGuard, !internalFocusOp, window != nil, !disabled else { return false }
    return inResumeWindow && resumeHadFocus
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
    attachGuard = false // [2026-10-18 kb-resume] foco explícito chegou
    restoreParked = false // [2026-10-19 kb-restore]
    onFocusChange(["focused": true])
  }

  func textViewDidEndEditing(_ tv: UITextView) {
    // [2026-10-19 kb-restore] solto por fora (UIKit guardando o responder p/ um
    // modal/menu/push, blur JS, KeyboardController.dismiss) → a devolução
    // automática que vier depois é recusada. App indo p/ o fundo não conta.
    if restoreGuard && !internalFocusOp && !appInactive { restoreParked = true }
    deactivatePanel(reload: false) // [2026-10-20 attach-inputview] próximo foco = teclado
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
      restoreParked = true // [2026-10-19 kb-restore]
      // [2026-10-17 kb-pop] rede de segurança: saindo da janela sem o proxy ter
      // visto o pop → derruba o teclado já, sem animação.
      if textView.isFirstResponder {
        focusBlocked = true
        withInternalFocus { UIView.performWithoutAnimation { _ = self.textView.resignFirstResponder() } }
      }
      flushChange()
      voice.cancel(reason: "unmount")
      teardownKeyboardTracking()
      removeDock() // [2026-10-20 native-dock]
    }
  }

  // MARK: Dock nativo (native-dock)

  // [2026-10-20 dock-fix] build 746: conversa VAZIA (lista e composer fora da
  // tela). RAIZ: a sonda ficava na UIWindow e o translateY saía direto de
  // (altura da janela − base da sonda). Sonda sem layout ainda (frame .zero →
  // base 0) ou o keyboardLayoutGuide da UIWindow degenerado (o próprio
  // currentKeyboardOverlap já tratava layoutFrame vazio) = "teclado" do tamanho
  // da tela → barra e lista subiam ~a tela inteira. AGORA: sonda na view da
  // tela (guia de view comum), leitura só depois de layout real e o valor é
  // LIMITADO pelo quadro real do teclado das notificações (kbNoteOverlap:
  // fechado = 0 ⇒ translação 0, por construção); trava de sanidade desliga o
  // dock na sessão (+ telemetria via onKeyboardSync reason "dock_sanity").
  private static var dockDisabledSession = false

  private func installDock() {
    guard nativeDock, !ChatyyComposerView.dockDisabledSession, let win = window, dockProbe == nil else { return }
    let host: UIView = nearestViewController()?.viewIfLoaded ?? win
    guard host.window === win else { return }
    let p = NCDockProbe(frame: .zero)
    p.isUserInteractionEnabled = false
    p.isHidden = true
    p.translatesAutoresizingMaskIntoConstraints = false
    host.addSubview(p)
    NSLayoutConstraint.activate([
      p.leadingAnchor.constraint(equalTo: host.leadingAnchor),
      p.widthAnchor.constraint(equalToConstant: 1),
      p.heightAnchor.constraint(equalToConstant: 1),
      p.bottomAnchor.constraint(equalTo: host.keyboardLayoutGuide.topAnchor),
    ])
    p.onMove = { [weak self] in self?.dockMoved() }
    dockProbe = p
    dockNeedsCollect = true
    UIView.performWithoutAnimation {
      host.layoutIfNeeded()
      self.dockMoved()
    }
  }

  private func disableDock(_ why: String) {
    ChatyyComposerView.dockDisabledSession = true
    removeDock()
    onKeyboardSync(["height": Double(kbNoteOverlap), "visible": kbNoteOverlap > 0, "focused": textView.isFirstResponder, "reason": "dock_sanity:" + why])
  }

  private func removeDock() {
    if let p = dockProbe {
      p.onMove = nil
      p.removeFromSuperview()
      dockProbe = nil
    }
    // views do Fabric podem ser recicladas: nunca deixar transform para trás.
    UIView.performWithoutAnimation {
      for v in dockTargets.allObjects { v.transform = .identity }
    }
    dockTargets.removeAllObjects()
    dockLift = 0
  }

  private func dockMoved() {
    guard nativeDock, !ChatyyComposerView.dockDisabledSession, let win = window, let p = dockProbe, let host = p.superview else { return }
    // Tela coberta por outra (push na pilha): o teclado é da tela de cima.
    if !textView.isFirstResponder && dockScreenCovered() { return }
    var overlap: CGFloat = 0
    // Só lê a sonda com layout real (frame .zero = ainda não resolvida).
    if p.frame.width > 0.5, host.bounds.height > 1 {
      let pf = host.convert(p.frame, to: win)
      overlap = max(0, win.bounds.maxY - pf.maxY)
    }
    // Teto = quadro REAL do teclado (notificação): fechado ⇒ 0. Abrindo, a
    // notificação chega antes/junto do bloco de animação; no arraste
    // interativo a sonda só DIMINUI a partir dele.
    overlap = min(overlap, kbNoteOverlap)
    let lift = max(0, overlap - bottomInset)
    if lift > win.bounds.height * 0.7 { disableDock("lift"); return }
    dockLift = lift
    applyDock()
    // Sanidade: barra precisa continuar dentro da janela.
    for v in dockTargets.allObjects where v.accessibilityIdentifier == "chatyy-dock-bar" && v.bounds.height > 1 {
      let f = v.convert(v.bounds, to: win)
      if f.maxY < 0 || f.minY > win.bounds.maxY + 1 { disableDock("offscreen"); return }
    }
  }

  private func dockScreenCovered() -> Bool {
    guard var vc = nearestViewController() else { return false }
    while let parent = vc.parent, !(parent is UINavigationController) { vc = parent }
    if let nav = vc.parent as? UINavigationController, let top = nav.topViewController, top !== vc { return true }
    return false
  }

  private func applyDock() {
    var targets = dockTargets.allObjects
    if dockNeedsCollect || targets.isEmpty || targets.contains(where: { $0.window == nil }) {
      collectDockTargets()
      targets = dockTargets.allObjects
    }
    let t: CGAffineTransform = dockLift > 0.5 ? CGAffineTransform(translationX: 0, y: -dockLift) : .identity
    for v in targets where v.transform != t { v.transform = t }
  }

  private func collectDockTargets() {
    dockNeedsCollect = false
    dockTargets.removeAllObjects()
    var a: UIView? = superview
    var depth = 0
    var root: UIView?
    while let v = a, depth < 40 {
      if NCDockProbe.find(in: v, id: "chatyy-dock-list", depth: 0) != nil { root = v; break }
      a = v.superview
      depth += 1
    }
    guard let r = root else { return }
    NCDockProbe.collect(in: r, depth: 0, into: dockTargets)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil {
      relayout(animated: false)
      updateKeyboardTracking()
      attachLifecycleProxy()
      if nativeDock { installDock() } // [2026-10-20 native-dock]
      scheduleKeyboardSync("window", after: 0.05) // [2026-10-19 kb-native]
      if focusBlocked {
        // voltou à janela: libera o foco quando a transição em curso acabar.
        if let coord = nearestViewController()?.transitionCoordinator {
          _ = coord.animate(alongsideTransition: nil, completion: { [weak self] _ in
            guard let self = self, self.window != nil else { return }
            self.focusBlocked = false
          })
        } else {
          focusBlocked = false
        }
      }
    }
  }

  override func willMove(toSuperview newSuperview: UIView?) {
    super.willMove(toSuperview: newSuperview)
    if newSuperview == nil { detachLifecycleProxy() }
  }

  // MARK: Host screen lifecycle (kb-pop)

  private func nearestViewController() -> UIViewController? {
    var r: UIResponder? = self.next
    while let cur = r {
      if let vc = cur as? UIViewController { return vc }
      r = cur.next
    }
    return nil
  }

  private func attachLifecycleProxy() {
    guard let vc = nearestViewController() else { return }
    if let p = lifecycleProxy, p.parent === vc, p.view.superview === self { return }
    detachLifecycleProxy()
    let proxy = NCLifecycleProxy()
    proxy.host = self
    vc.addChild(proxy)
    proxy.view.frame = .zero
    addSubview(proxy.view)
    proxy.didMove(toParent: vc)
    lifecycleProxy = proxy
  }

  private func detachLifecycleProxy() {
    guard let p = lifecycleProxy else { return }
    lifecycleProxy = nil
    p.host = nil
    p.willMove(toParent: nil)
    p.view.removeFromSuperview()
    p.removeFromParent()
  }

  /// Tela começando a sair (botão voltar, swipe-back interativo, push por cima):
  /// derruba o teclado UMA vez, sem animação, ANTES da transição andar, e bloqueia
  /// re-foco. Swipe cancelado → devolve o teclado só se ele estava aberto.
  fileprivate func hostWillDisappear(_ coord: UIViewControllerTransitionCoordinator?) {
    let wasFirst = textView.isFirstResponder
    hostTransitionGen += 1
    let gen = hostTransitionGen
    focusBlocked = true
    restoreParked = true // [2026-10-19 kb-restore] restauração do UIKit no pop/volta = recusada
    if wasFirst {
      if nativeTransitions {
        // [2026-10-19 kb-native] ANIMADO: dentro do viewWillDisappear o UIKit
        // anima o teclado junto com a transição (interativa inclusive).
        withInternalFocus { _ = self.textView.resignFirstResponder() }
      } else {
        withInternalFocus { UIView.performWithoutAnimation { _ = self.textView.resignFirstResponder() } }
      }
    }
    guard let coord = coord else { return }
    _ = coord.animate(alongsideTransition: nil, completion: { [weak self] ctx in
      guard let self = self, self.hostTransitionGen == gen, ctx.isCancelled else { return }
      self.focusBlocked = false
      if wasFirst && self.window != nil && !self.disabled {
        self.withInternalFocus { _ = self.textView.becomeFirstResponder() }
      }
    })
  }

  fileprivate func hostDidAppear() {
    focusBlocked = false
    scheduleKeyboardSync("appear", after: 0) // [2026-10-19 kb-native]
  }

  // MARK: Keyboard truth (kb-native)

  private func noteKeyboardFrame(_ n: Notification) {
    guard let end = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
    guard let win = window else { return }
    let r = win.convert(end, from: win.screen.coordinateSpace)
    if r.isEmpty || r.minY >= win.bounds.maxY - 0.5 || r.maxY <= win.bounds.minY {
      kbNoteOverlap = 0
    } else {
      kbNoteOverlap = max(0, win.bounds.maxY - r.minY)
      // [2026-10-20 attach-inputview] altura do teclado do SISTEMA (painel usa).
      if textView.isFirstResponder && !panelActive && textView.inputView == nil && kbNoteOverlap > win.safeAreaInsets.bottom + 100 {
        lastSystemKbHeight = kbNoteOverlap
      } else if panelActive {
        notePanelFrame(kbNoteOverlap)
      }
    }
  }

  /// Altura REAL do teclado acima da base da janela (pt; 0 = fechado). Mesma
  /// medida do `height` do react-native-keyboard-controller (inclui a área do
  /// home indicator quando aberto).
  private func currentKeyboardOverlap() -> CGFloat {
    guard let win = window else { return 0 }
    let safe = win.safeAreaInsets.bottom
    let g = win.keyboardLayoutGuide.layoutFrame
    if g.width > 0 || g.height > 0 {
      let fromGuide = max(0, win.bounds.maxY - g.minY)
      // fechado: o guia encosta no safe area (home indicator), não é teclado.
      if fromGuide <= safe + 1 { return 0 }
      return fromGuide
    }
    return kbNoteOverlap > safe + 1 ? kbNoteOverlap : 0
  }

  private func scheduleKeyboardSync(_ reason: String, after delay: TimeInterval) {
    guard nativeTransitions else { return }
    if attachKeepActive && attachInWindow { return } // [2026-10-20 attach-inwindow] conversa parada sob a folha
    kbSyncGen += 1
    let gen = kbSyncGen
    let fire = { [weak self] in
      guard let self = self else { return }
      // didShow/didHide em sequência: só o último conta (os "active" usam gens
      // próprias via reason distinto, mas o último quadro é o que vale).
      if gen != self.kbSyncGen && !reason.hasPrefix("active") { return }
      self.emitKeyboardSync(reason)
    }
    if delay <= 0 {
      DispatchQueue.main.async(execute: fire)
    } else {
      DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: fire)
    }
  }

  private func emitKeyboardSync(_ reason: String) {
    guard nativeTransitions, window != nil else { return }
    // No meio de uma transição a medida é transitória — a sync do fim (appear/
    // didHide/didShow) traz o valor final.
    if let vc = nearestViewController(), vc.transitionCoordinator != nil, reason != "appear" { return }
    let h = currentKeyboardOverlap()
    onKeyboardSync([
      "height": Double(h),
      "visible": h > 0,
      "focused": textView.isFirstResponder,
      "reason": reason,
    ])
  }

  /// Bloqueio só vale enquanto a tela está saindo/fora da janela; sem transição
  /// em curso e de volta na janela ele vence sozinho (o campo nunca fica morto).
  private func isFocusBlockedNow() -> Bool {
    guard focusBlocked else { return false }
    guard window != nil, let vc = nearestViewController() else { return true }
    if vc.transitionCoordinator != nil || vc.isMovingFromParent || vc.isBeingDismissed { return true }
    focusBlocked = false
    return false
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

/// [2026-10-17 kb-pop] VC filho invisível (0×0, oculto) pendurado na tela que
/// hospeda o composer só para receber os callbacks de aparição dela.
final class NCLifecycleProxy: UIViewController {
  weak var host: ChatyyComposerView?

  override func loadView() {
    let v = UIView(frame: .zero)
    v.isHidden = true
    v.isUserInteractionEnabled = false
    view = v
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    host?.hostWillDisappear(parent?.transitionCoordinator ?? transitionCoordinator)
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    host?.hostDidAppear()
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

// MARK: - Painel de anexos no lugar do teclado (attach-inputview)

// [2026-10-20 attach-inputview] WhatsApp iOS: com o teclado aberto o "+" NÃO
// abre folha — o painel de anexos entra NO LUGAR do teclado (mesma altura,
// textView.inputView + reloadInputViews), o composer fica parado e focado e o
// "+" vira ícone de teclado (toque = volta ao teclado no mesmo lugar). Teclado
// fechado: o painel sobe como inputView (mesma animação do teclado), sem
// cursor visível. Grade 4 colunas de botões redondos P&B (SF Symbols).
final class NCAttachPanel: UIInputView {
  var onPick: ((String) -> Void)?
  private let scroll = UIScrollView()
  private var buttons: [UIControl] = []
  private var itemsSig = ""
  private var dark = false

  init(height: CGFloat) {
    super.init(frame: CGRect(x: 0, y: 0, width: UIScreen.main.bounds.width, height: height), inputViewStyle: .keyboard)
    allowsSelfSizing = false
    autoresizingMask = [.flexibleWidth]
    scroll.showsVerticalScrollIndicator = false
    scroll.alwaysBounceVertical = false
    addSubview(scroll)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  static func symbol(for key: String) -> String? {
    switch key {
    case "gallery", "photos": return "photo.on.rectangle"
    case "camera": return "camera.fill"
    case "file": return "doc.fill"
    case "scan_document": return "doc.viewfinder"
    case "location", "liveLocation": return "location.fill"
    case "contact": return "person.crop.circle"
    case "poll": return "chart.bar.fill"
    case "meetup": return "calendar"
    case "playlist", "audio", "music": return "music.note"
    case "gift": return "gift.fill"
    case "games": return "gamecontroller.fill"
    case "short_video": return "film"
    case "gif": return nil
    default: return "square.grid.2x2"
    }
  }

  func apply(items: [(key: String, label: String)], text: UIColor, dark: Bool) {
    let sig = items.map { "\($0.key)=\($0.label)" }.joined(separator: "|") + (dark ? "#d" : "#l")
    guard sig != itemsSig else { return }
    itemsSig = sig
    self.dark = dark
    buttons.forEach { $0.removeFromSuperview() }
    buttons = []
    let circleBg = dark ? UIColor(white: 0.20, alpha: 1) : UIColor.white
    for it in items {
      let b = UIControl()
      b.accessibilityLabel = it.label
      b.accessibilityTraits = .button
      b.isAccessibilityElement = true
      b.accessibilityIdentifier = it.key
      let circle = UIView()
      circle.backgroundColor = circleBg
      circle.layer.cornerRadius = 31
      circle.isUserInteractionEnabled = false
      circle.tag = 1
      b.addSubview(circle)
      if let sym = NCAttachPanel.symbol(for: it.key) {
        let iv = UIImageView(image: UIImage(systemName: sym, withConfiguration: UIImage.SymbolConfiguration(pointSize: 24, weight: .regular)))
        iv.tintColor = text
        iv.contentMode = .center
        iv.tag = 2
        circle.addSubview(iv)
      } else {
        let gl = UILabel()
        gl.text = "GIF"
        gl.font = .systemFont(ofSize: 16, weight: .heavy)
        gl.textColor = text
        gl.textAlignment = .center
        gl.tag = 2
        circle.addSubview(gl)
      }
      let lb = UILabel()
      lb.text = it.label
      lb.font = .systemFont(ofSize: 13)
      lb.textColor = text
      lb.textAlignment = .center
      lb.adjustsFontSizeToFitWidth = true
      lb.minimumScaleFactor = 0.8
      lb.tag = 3
      b.addSubview(lb)
      let key = it.key
      b.addAction(UIAction { [weak self] _ in
        UISelectionFeedbackGenerator().selectionChanged()
        self?.onPick?(key)
      }, for: .touchUpInside)
      b.addAction(UIAction { _ in UIView.animate(withDuration: 0.12) { circle.transform = CGAffineTransform(scaleX: 0.92, y: 0.92) } }, for: .touchDown)
      b.addAction(UIAction { _ in UIView.animate(withDuration: 0.18) { circle.transform = .identity } }, for: [.touchUpInside, .touchUpOutside, .touchCancel])
      scroll.addSubview(b)
      buttons.append(b)
    }
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let safeB = window?.safeAreaInsets.bottom ?? 0
    scroll.frame = CGRect(x: 0, y: 0, width: bounds.width, height: max(0, bounds.height - safeB))
    let cols: CGFloat = 4
    let cellW = floor(bounds.width / cols)
    let rowH: CGFloat = 104
    let top: CGFloat = 22
    for (i, b) in buttons.enumerated() {
      let r = CGFloat(i / 4), c = CGFloat(i % 4)
      b.frame = CGRect(x: c * cellW, y: top + r * rowH, width: cellW, height: rowH)
      if let circle = b.viewWithTag(1) {
        circle.frame = CGRect(x: (cellW - 62) / 2, y: 0, width: 62, height: 62)
        circle.viewWithTag(2)?.frame = circle.bounds
      }
      b.viewWithTag(3)?.frame = CGRect(x: 2, y: 70, width: cellW - 4, height: 18)
    }
    let rows = CGFloat((buttons.count + 3) / 4)
    scroll.contentSize = CGSize(width: bounds.width, height: top + rows * rowH)
  }
}


// MARK: - Sonda do dock (native-dock)

/// View invisível presa ao window.keyboardLayoutGuide: o UIKit a reposiciona
/// junto com o teclado (no bloco de animação dele / quadro a quadro no arraste).
final class NCDockProbe: UIView {
  var onMove: (() -> Void)?
  override var center: CGPoint { didSet { if center != oldValue { onMove?() } } }
  override var bounds: CGRect { didSet { if bounds != oldValue { onMove?() } } }
  override var frame: CGRect { didSet { if frame != oldValue { onMove?() } } }

  static func find(in v: UIView, id: String, depth: Int) -> UIView? {
    if v.accessibilityIdentifier == id { return v }
    if depth > 40 { return nil }
    for s in v.subviews { if let f = find(in: s, id: id, depth: depth + 1) { return f } }
    return nil
  }

  static func collect(in v: UIView, depth: Int, into out: NSHashTable<UIView>) {
    if let i = v.accessibilityIdentifier, i == "chatyy-dock-bar" || i == "chatyy-dock-list" { out.add(v) }
    if depth > 40 { return }
    for s in v.subviews { collect(in: s, depth: depth + 1, into: out) }
  }
}
