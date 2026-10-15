import AVFoundation
import CallKit
import ReplayKit
import UIKit

// [2026-10-15 screen-protect-all] Proteção de captura no APP INTEIRO (iOS).
//
// O iOS não tem API para bloquear print. Técnica da "camada segura": a view
// interna (canvas) de um UITextField com isSecureTextEntry tem a layer marcada
// como segura pelo sistema — tudo o que estiver DENTRO dela sai PRETO em
// print, gravação de tela, espelhamento/AirPlay e na foto do app switcher.
//
// Como aplicamos (sem mexer em layer de janela — o truque antigo de reparentar
// keyWindow.layer, rejeitado no expo-chat-privacy de 14/10, NÃO é usado aqui):
//   • Em cada UIWindow do app, um canvas seguro (o canvas extraído do
//     UITextField) entra como subview da própria janela, abaixo de tudo, com o
//     tamanho da janela; dentro dele uma view de conteúdo comum.
//   • As subviews diretas da janela vão para dentro do conteúdo, na mesma
//     ordem: a view raiz do RN (rootViewController.view) e os UITransitionView
//     de TODA apresentação (modais do RN, sheets, alertas, visualizador nativo,
//     story, editor, câmera, chamada, Live…). A janela dedicada da chamada
//     (CallWindowManager) é protegida igual.
//   • O UIKit adiciona novos UITransitionView direto na janela (e re-adiciona a
//     raiz depois de dispensar um modal fullScreen): uma varredura barata
//     (≈4×/s, só com o app ativo e a proteção ligada) + avisos
//     (janela visível/key, app ativo, "ChatyyScreenProtectRescan" postado pelos
//     módulos nativos depois de apresentar) recolhem essas views de volta.
//   • Views privadas do UIKit com prefixo "_" (menus de contexto, efeitos de
//     ponteiro, drag&drop) NÃO são movidas — menos risco de quebrar UIMenu.
//   • Teclado (UIRemoteKeyboardWindow/UITextEffectsWindow) é janela do sistema:
//     não é tocada (o texto digitado aparece no teclado de um print).
//   • Desfazer = devolver as views à janela na mesma ordem e tirar o canvas.
//
// Estado efetivo = enabled (decidido no JS, persistido p/ o cold start; nunca
// decidido = DESLIGADO; JS só liga com screen_protect_ios) && suportado && NÃO
// compartilhando a tela numa chamada && guarda de crash não disparou (2 quedas
// seguidas com a proteção ativa → desliga até o próximo bundle).
// Compartilhar tela: a extensão de broadcast posta "iOS_BroadcastStarted" /
// "iOS_BroadcastStopped" (Darwin); com uma chamada ativa (CXCallObserver ou
// sessão de áudio em voiceChat/videoChat) a proteção desliga — senão o outro
// lado veria preto — e religa ao parar (ou quando a captura do sistema acaba).
// A captura in-app do LiveKit (RPScreenRecorder, builds sem a extensão) idem.
//
// Extras: overlay com blur na troca de app (app switcher / Central de
// Controle); aviso discreto "Capturas de tela estão bloqueadas no Chatyy" no
// print (userDidTakeScreenshotNotification) e no início de gravação
// (UIScreen.capturedDidChange).
final class ChatyyScreenProtect: NSObject {
  static let shared = ChatyyScreenProtect()

  static let rescanNotification = Notification.Name("ChatyyScreenProtectRescan")
  private static let enabledKey = "chatyy.screen_protect.enabled.v1"
  // [2026-10-15 guard] Igual ao native_list_guard_v1: processo morreu 2× seguidas
  // com a proteção ATIVA (em primeiro plano) → desliga até o próximo bundle.
  private static let guardKey = "chatyy.screen_protect.guard.v1" // {armed, crashes, bundle, tripped}
  private static let toastKey = "chatyy.screen_protect.toast.v1"
  private static let broadcastStarted = "iOS_BroadcastStarted"
  private static let broadcastStopped = "iOS_BroadcastStopped"

  /// (effective, sharing) → JS (onProtectChange).
  var onChange: ((Bool, Bool) -> Void)?
  /// Print tirado com a proteção ligada → JS (onScreenshotBlocked).
  var onScreenshot: (() -> Void)?

  private(set) var enabled: Bool
  private(set) var sharing = false
  private var broadcastActive = false
  private var inAppCapture = false
  private var toastText: String
  private var started = false
  private var hosts: [ObjectIdentifier: SecureHost] = [:]
  private var timer: Timer?
  private var overlayWindow: UIWindow?
  private var toastWindow: UIWindow?
  private var toastToken = 0
  private var lastToastAt: CFTimeInterval = 0
  private let callObserver = CXCallObserver()
  private var recorderObs: NSKeyValueObservation?
  private var lastState: String?
  private var guardCrashes = 0
  private var guardBundle = ""
  private(set) var guardTripped = false
  private var armed = false

  /// O canvas seguro existe nesta versão do iOS? (sondado no start(), main)
  private(set) var supported = true

  var effective: Bool { enabled && supported && !sharing && !guardTripped }

  private override init() {
    let d = UserDefaults.standard
    // [2026-10-15] iOS: padrão DESLIGADO enquanto o JS não decidir LIGADO
    // (flag remota screen_protect_ios + screen_protect_all). A técnica mexe na
    // hierarquia de views no cold start, antes do JS poder desligar.
    enabled = (d.object(forKey: ChatyyScreenProtect.enabledKey) as? Bool) ?? false
    toastText = d.string(forKey: ChatyyScreenProtect.toastKey) ?? "Capturas de tela estão bloqueadas no Chatyy"
    super.init()
  }

  // MARK: - Public (main thread)

  /// Idempotente. Chamado no didFinishLaunching (AppDelegate subscriber) e
  /// na criação do módulo.
  func start() {
    if !Thread.isMainThread { DispatchQueue.main.async { self.start() }; return }
    if started { return }
    started = true
    checkCrashGuard()
    supported = ChatyyScreenProtect.makeSecureCanvas() != nil
    let nc = NotificationCenter.default
    nc.addObserver(self, selector: #selector(rescanSoon), name: UIWindow.didBecomeVisibleNotification, object: nil)
    nc.addObserver(self, selector: #selector(rescanSoon), name: UIWindow.didBecomeKeyNotification, object: nil)
    nc.addObserver(self, selector: #selector(rescanSoon), name: ChatyyScreenProtect.rescanNotification, object: nil)
    nc.addObserver(self, selector: #selector(appDidBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
    nc.addObserver(self, selector: #selector(appWillResignActive), name: UIApplication.willResignActiveNotification, object: nil)
    nc.addObserver(self, selector: #selector(appDidEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
    nc.addObserver(self, selector: #selector(didTakeScreenshot), name: UIApplication.userDidTakeScreenshotNotification, object: nil)
    nc.addObserver(self, selector: #selector(capturedDidChange), name: UIScreen.capturedDidChangeNotification, object: nil)
    nc.addObserver(self, selector: #selector(appWillTerminate), name: UIApplication.willTerminateNotification, object: nil)
    installDarwinObservers()
    recorderObs = RPScreenRecorder.shared().observe(\.isRecording, options: [.new]) { _, _ in
      DispatchQueue.main.async { ChatyyScreenProtect.shared.recorderChanged() }
    }
    apply()
  }

  func setEnabled(_ on: Bool, toast: String?, bundle: String? = nil) {
    if let b = bundle, !b.isEmpty, b != guardBundle {
      // Bundle novo (OTA/binário): zera o guarda (pode ter vindo a correção).
      guardBundle = b
      guardCrashes = 0
      if guardTripped { NSLog("[ChatyyScreenProtect] guard reset (novo bundle)") }
      guardTripped = false
      saveGuard()
    }
    if let t = toast, !t.isEmpty, t != toastText {
      toastText = t
      UserDefaults.standard.set(t, forKey: ChatyyScreenProtect.toastKey)
    }
    if on != enabled {
      enabled = on
      UserDefaults.standard.set(on, forKey: ChatyyScreenProtect.enabledKey)
    }
    if !started { start() } else { apply() }
  }

  func state() -> [String: Any] {
    return ["supported": supported, "enabled": enabled, "effective": effective, "sharing": sharing,
            "guardTripped": guardTripped, "guardCrashes": guardCrashes]
  }

  // MARK: - Guarda de crash

  private func checkCrashGuard() {
    let g = UserDefaults.standard.dictionary(forKey: ChatyyScreenProtect.guardKey) ?? [:]
    guardBundle = g["bundle"] as? String ?? ""
    guardCrashes = g["crashes"] as? Int ?? 0
    guardTripped = g["tripped"] as? Bool ?? false
    if (g["armed"] as? Bool) == true {
      // A sessão anterior acabou com a proteção ativa em primeiro plano (sem
      // passar pelo background/terminate) = crash/kill.
      guardCrashes += 1
      if guardCrashes >= 2 { guardTripped = true }
      NSLog("[ChatyyScreenProtect] guard: sessão anterior caiu protegida (crashes=\(guardCrashes) tripped=\(guardTripped))")
    }
    armed = false
    saveGuard()
  }

  private func setArmed(_ on: Bool) {
    if armed == on { return }
    armed = on
    saveGuard()
  }

  private func saveGuard() {
    UserDefaults.standard.set(["armed": armed, "crashes": guardCrashes, "bundle": guardBundle, "tripped": guardTripped],
                              forKey: ChatyyScreenProtect.guardKey)
  }

  // MARK: - Apply / scan

  private func apply() {
    let eff = effective
    if eff {
      if UIApplication.shared.applicationState != .background { setArmed(true) }
      scan()
      if UIApplication.shared.applicationState == .active { startTimer() }
    } else {
      setArmed(false)
      stopTimer()
      removeAll()
      hideOverlay(animated: false)
    }
    let st = "\(eff)|\(sharing)"
    if lastState != st {
      lastState = st
      NSLog("[ChatyyScreenProtect] effective=\(eff) enabled=\(enabled) supported=\(supported) sharing=\(sharing)")
      onChange?(eff, sharing)
    }
  }

  @objc private func rescanSoon() {
    DispatchQueue.main.async { [weak self] in
      guard let self = self, self.effective else { return }
      self.scan()
    }
  }

  private func startTimer() {
    if timer != nil { return }
    let t = Timer(timeInterval: 0.25, repeats: true) { _ in
      let me = ChatyyScreenProtect.shared
      if me.effective { me.scan() }
    }
    t.tolerance = 0.1
    RunLoop.main.add(t, forMode: .common)
    timer = t
  }

  private func stopTimer() {
    timer?.invalidate()
    timer = nil
  }

  private func appWindows() -> [UIWindow] {
    var out: [UIWindow] = []
    for scene in UIApplication.shared.connectedScenes {
      guard let ws = scene as? UIWindowScene else { continue }
      for w in ws.windows where ChatyyScreenProtect.isAppWindow(w) {
        out.append(w)
      }
    }
    return out
  }

  /// UIWindow do app (RN, chamada, overlays de módulos). Fora: janelas do
  /// sistema (teclado/efeitos de texto, prefixo UI/_) e as nossas
  /// (escudo de gravação, blur do switcher, aviso).
  private static func isAppWindow(_ w: UIWindow) -> Bool {
    if w is ChatyyProtectOverlayWindow || w is ChatPrivacyShieldWindow { return false }
    let name = NSStringFromClass(type(of: w))
    if name == "UIWindow" { return true }
    if name.hasPrefix("UI") || name.hasPrefix("_") { return false }
    return true
  }

  private func scan() {
    var alive = Set<ObjectIdentifier>()
    for w in appWindows() {
      let id = ObjectIdentifier(w)
      alive.insert(id)
      if let h = hosts[id], h.window === w {
        h.absorb()
      } else if let h = SecureHost(window: w) {
        hosts[id] = h
        h.absorb()
      }
    }
    // Janelas que sumiram (ex.: a da chamada): só esquece.
    for (id, h) in hosts where !alive.contains(id) || h.window == nil {
      hosts.removeValue(forKey: id)
    }
  }

  private func removeAll() {
    for (_, h) in hosts { h.restore() }
    hosts.removeAll()
  }

  // MARK: - Compartilhar tela (chamada)

  private func installDarwinObservers() {
    let center = CFNotificationCenterGetDarwinNotifyCenter()
    let me = Unmanaged.passUnretained(self).toOpaque()
    CFNotificationCenterAddObserver(center, me, { _, _, _, _, _ in
      DispatchQueue.main.async { ChatyyScreenProtect.shared.broadcastChanged(true) }
    }, ChatyyScreenProtect.broadcastStarted as CFString, nil, .deliverImmediately)
    CFNotificationCenterAddObserver(center, me, { _, _, _, _, _ in
      DispatchQueue.main.async { ChatyyScreenProtect.shared.broadcastChanged(false) }
    }, ChatyyScreenProtect.broadcastStopped as CFString, nil, .deliverImmediately)
  }

  /// Só conta como "compartilhando numa chamada" com uma ligação ativa —
  /// iniciar a transmissão do Chatyy pela Central de Controle SEM chamada não
  /// desliga a proteção.
  private func callActive() -> Bool {
    if callObserver.calls.contains(where: { !$0.hasEnded }) { return true }
    let mode = AVAudioSession.sharedInstance().mode
    return mode == .voiceChat || mode == .videoChat
  }

  private func broadcastChanged(_ on: Bool) {
    broadcastActive = on && callActive()
    updateSharing()
  }

  private func recorderChanged() {
    inAppCapture = RPScreenRecorder.shared().isRecording && callActive()
    updateSharing()
  }

  private func updateSharing() {
    let now = broadcastActive || inAppCapture
    if now == sharing { return }
    sharing = now
    apply()
  }

  // MARK: - App switcher

  @objc private func appWillResignActive() {
    if effective { showOverlay() }
  }

  @objc private func appDidEnterBackground() {
    stopTimer()
    // Chegou ao background vivo = sessão limpa: desarma e zera a sequência.
    if guardCrashes != 0 && !guardTripped { guardCrashes = 0 }
    setArmed(false)
    saveGuard()
    if effective { showOverlay() }
  }

  @objc private func appWillTerminate() {
    setArmed(false)
  }

  @objc private func appDidBecomeActive() {
    hideOverlay(animated: true)
    apply()
  }

  private func activeScene() -> UIWindowScene? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    return scenes.first(where: { $0.activationState == .foregroundActive })
      ?? scenes.first(where: { $0.activationState == .foregroundInactive })
      ?? scenes.first
  }

  private func showOverlay() {
    if let w = overlayWindow {
      w.alpha = 1
      w.isHidden = false
      return
    }
    guard let scene = activeScene() else { return }
    let w = ChatyyProtectOverlayWindow(windowScene: scene)
    w.frame = scene.coordinateSpace.bounds
    w.windowLevel = UIWindow.Level.alert + 40
    w.backgroundColor = .clear
    w.isUserInteractionEnabled = false
    w.rootViewController = ChatyyProtectBlurController()
    w.isHidden = false // nunca vira key: teclado/responder continuam no app
    overlayWindow = w
  }

  private func hideOverlay(animated: Bool) {
    guard let w = overlayWindow else { return }
    overlayWindow = nil
    let done = {
      w.isHidden = true
      w.rootViewController = nil
    }
    if animated {
      UIView.animate(withDuration: 0.18, animations: { w.alpha = 0 }, completion: { _ in done() })
    } else {
      done()
    }
  }

  // MARK: - Aviso de captura

  @objc private func didTakeScreenshot() {
    guard effective else { return }
    showToast()
    onScreenshot?()
  }

  @objc private func capturedDidChange() {
    let captured = UIScreen.main.isCaptured
    if !captured && broadcastActive {
      // A transmissão acabou sem o "stopped" da extensão (crash/kill).
      broadcastActive = false
      updateSharing()
      return
    }
    if captured && effective {
      // Espera o "iOS_BroadcastStarted" da nossa extensão (compartilhar tela
      // na chamada) chegar antes de avisar — senão o aviso pisca no início.
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
        guard let self = self, UIScreen.main.isCaptured, self.effective else { return }
        self.showToast()
      }
    }
  }

  private func showToast() {
    let now = CACurrentMediaTime()
    if now - lastToastAt < 3 { return }
    lastToastAt = now
    guard let scene = activeScene() else { return }
    let w: UIWindow
    if let existing = toastWindow {
      w = existing
    } else {
      w = ChatyyProtectOverlayWindow(windowScene: scene)
      w.frame = scene.coordinateSpace.bounds
      w.windowLevel = UIWindow.Level.alert + 45
      w.backgroundColor = .clear
      w.isUserInteractionEnabled = false
      w.rootViewController = ChatyyProtectToastController()
      toastWindow = w
    }
    (w.rootViewController as? ChatyyProtectToastController)?.setText(toastText)
    w.alpha = 0
    w.isHidden = false
    toastToken &+= 1
    let token = toastToken
    UIView.animate(withDuration: 0.2) { w.alpha = 1 }
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.6) { [weak self] in
      guard let self = self, self.toastToken == token, let tw = self.toastWindow else { return }
      UIView.animate(withDuration: 0.25, animations: { tw.alpha = 0 }, completion: { _ in
        guard self.toastToken == token else { return }
        tw.isHidden = true
        tw.rootViewController = nil
        self.toastWindow = nil
      })
    }
  }

  // MARK: - Canvas seguro

  /// Extrai o canvas (camada segura) de um UITextField com isSecureTextEntry.
  /// iOS 15+: "_UITextLayoutCanvasView" (iOS 14: "_UITextFieldCanvasView").
  static func makeSecureCanvas() -> UIView? {
    let field = UITextField()
    field.isSecureTextEntry = true
    field.layoutIfNeeded()
    let subs = field.subviews
    guard let canvas = subs.first(where: { NSStringFromClass(type(of: $0)).contains("CanvasView") }) ?? subs.first else {
      return nil
    }
    canvas.removeFromSuperview()
    for v in canvas.subviews { v.removeFromSuperview() }
    canvas.isUserInteractionEnabled = true
    canvas.translatesAutoresizingMaskIntoConstraints = true
    canvas.backgroundColor = .clear
    return canvas
  }
}

/// Canvas seguro + conteúdo de UMA janela.
private final class SecureHost {
  weak var window: UIWindow?
  let canvas: UIView
  let content: ChatyyProtectContentView

  init?(window: UIWindow) {
    guard let c = ChatyyScreenProtect.makeSecureCanvas() else { return nil }
    self.window = window
    canvas = c
    content = ChatyyProtectContentView(frame: window.bounds)
    canvas.frame = window.bounds
    canvas.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    content.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    content.backgroundColor = .clear
    content.isUserInteractionEnabled = true
    canvas.addSubview(content)
  }

  private static func movable(_ v: UIView) -> Bool {
    if v is ChatyyProtectContentView { return false }
    let name = NSStringFromClass(type(of: v))
    // Privadas do UIKit (menus de contexto, ponteiro, drag&drop): ficam.
    if name.hasPrefix("_") { return false }
    return true
  }

  /// Garante o canvas na janela e recolhe as subviews diretas novas.
  func absorb() {
    guard let w = window else { return }
    if canvas.superview !== w {
      // Abaixo da 1ª view que vamos mover (preserva a ordem com as que ficam).
      if let firstMovable = w.subviews.first(where: { $0 !== canvas && SecureHost.movable($0) }) {
        w.insertSubview(canvas, belowSubview: firstMovable)
      } else {
        w.insertSubview(canvas, at: 0)
      }
      canvas.frame = w.bounds
    }
    if canvas.frame != w.bounds { canvas.frame = w.bounds }
    let pending = w.subviews.filter { $0 !== canvas && SecureHost.movable($0) }
    if pending.isEmpty { return }
    for v in pending {
      // Mesmo sistema de coordenadas (canvas/conteúdo em 0,0 com o tamanho da
      // janela) → frame inalterado; mesma janela → sem willMove(toWindow:nil).
      content.addSubview(v)
    }
  }

  /// Devolve as views à janela, na mesma ordem, e tira o canvas.
  func restore() {
    guard let w = window else {
      canvas.removeFromSuperview()
      return
    }
    if canvas.superview === w {
      for v in content.subviews {
        w.insertSubview(v, belowSubview: canvas)
      }
    } else {
      // Canvas fora da janela (não deveria): nunca perder a raiz do app.
      for v in content.subviews { w.addSubview(v) }
    }
    canvas.removeFromSuperview()
  }
}

/// Conteúdo dentro do canvas seguro. Toque em área vazia não para aqui (igual
/// a antes, quando caía na própria janela).
final class ChatyyProtectContentView: UIView {
  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    let v = super.hitTest(point, with: event)
    return v === self ? nil : v
  }
}

/// Janelas próprias (blur do switcher, aviso): nunca recebem toque nem viram key.
final class ChatyyProtectOverlayWindow: UIWindow {
  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    return nil
  }
}

final class ChatyyProtectBlurController: UIViewController {
  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear
    view.isUserInteractionEnabled = false
    let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterial))
    blur.frame = view.bounds
    blur.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(blur)
    let cfg = UIImage.SymbolConfiguration(pointSize: 34, weight: .regular)
    let icon = UIImageView(image: UIImage(systemName: "lock.fill", withConfiguration: cfg))
    icon.tintColor = .secondaryLabel
    icon.translatesAutoresizingMaskIntoConstraints = false
    blur.contentView.addSubview(icon)
    NSLayoutConstraint.activate([
      icon.centerXAnchor.constraint(equalTo: blur.contentView.centerXAnchor),
      icon.centerYAnchor.constraint(equalTo: blur.contentView.centerYAnchor),
    ])
  }
}

final class ChatyyProtectToastController: UIViewController {
  private let pill = UIVisualEffectView(effect: UIBlurEffect(style: .systemChromeMaterialDark))
  private let label = UILabel()
  private var pending = ""

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear
    view.isUserInteractionEnabled = false
    pill.layer.cornerRadius = 18
    pill.clipsToBounds = true
    pill.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(pill)

    let cfg = UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold)
    let icon = UIImageView(image: UIImage(systemName: "lock.fill", withConfiguration: cfg))
    icon.tintColor = .white
    icon.setContentHuggingPriority(.required, for: .horizontal)

    label.textColor = .white
    label.font = UIFont.systemFont(ofSize: 14, weight: .medium)
    label.numberOfLines = 2
    label.textAlignment = .center
    label.adjustsFontForContentSizeCategory = true

    let row = UIStackView(arrangedSubviews: [icon, label])
    row.axis = .horizontal
    row.alignment = .center
    row.spacing = 8
    row.translatesAutoresizingMaskIntoConstraints = false
    pill.contentView.addSubview(row)

    NSLayoutConstraint.activate([
      pill.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      pill.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -72),
      pill.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
      pill.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24),
      row.topAnchor.constraint(equalTo: pill.contentView.topAnchor, constant: 10),
      row.bottomAnchor.constraint(equalTo: pill.contentView.bottomAnchor, constant: -10),
      row.leadingAnchor.constraint(equalTo: pill.contentView.leadingAnchor, constant: 16),
      row.trailingAnchor.constraint(equalTo: pill.contentView.trailingAnchor, constant: -16),
    ])
    label.text = pending
  }

  func setText(_ t: String) {
    pending = t
    if isViewLoaded { label.text = t }
  }
}
