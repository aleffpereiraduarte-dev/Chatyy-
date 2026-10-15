import ExpoModulesCore
import UIKit

// [2026-10-14 adv-privacy] "Privacidade avançada da conversa" (iOS).
//
// O iOS não deixa bloquear print. O que dá para fazer, sem truque frágil:
//   • enquanto a tela está sendo GRAVADA ou ESPELHADA (UIScreen.isCaptured),
//     uma UIWindow opaca fica por cima de TUDO (inclusive modais, o
//     visualizador nativo e o teclado) com "Conteúdo protegido" — a gravação
//     sai preta; o print continua possível e o JS avisa a conversa
//     (expo-screen-capture addScreenshotListener).
//   • NÃO usamos o truque do UITextField.isSecureTextEntry (reparentar a
//     layer da janela): ele troca a layer da keyWindow e, se a keyWindow mudar
//     no meio (ligação/CallKit, alerta), o "desfazer" mexe na janela errada e
//     o app fica preto. Ver relatório 2026-10-14.
//
// JS (services/chatPrivacy.js):
//   apiVersion() → 1
//   isCaptured() → Bool (cache atualizado na main thread)
//   setShield(tag, enabled, title, subtitle) → Bool   (contagem por tag)
//   evento onCaptureChange { captured }
public class ExpoChatPrivacyModule: Module {
  private var tags = Set<String>()
  private var title = "Conteúdo protegido"
  private var subtitle = ""
  private var captured = false
  private var observer: NSObjectProtocol?
  private var shieldWindow: UIWindow?

  public func definition() -> ModuleDefinition {
    Name("ExpoChatPrivacy")

    Events("onCaptureChange")

    OnCreate {
      DispatchQueue.main.async { [weak self] in
        self?.startObserving()
      }
    }

    OnDestroy {
      DispatchQueue.main.async { [weak self] in
        self?.stopObserving()
      }
    }

    Function("apiVersion") { () -> Int in
      return 1
    }

    Function("isCaptured") { () -> Bool in
      return self.captured
    }

    AsyncFunction("setShield") { (tag: String, enabled: Bool, title: String, subtitle: String) -> Bool in
      if self.observer == nil { self.startObserving() }
      if !title.isEmpty { self.title = title }
      self.subtitle = subtitle
      if enabled {
        self.tags.insert(tag)
      } else {
        self.tags.remove(tag)
      }
      self.refresh()
      return self.shieldWindow != nil
    }.runOnQueue(.main)

    AsyncFunction("clearShields") { () -> Bool in
      self.tags.removeAll()
      self.refresh()
      return true
    }.runOnQueue(.main)
  }

  // MARK: - Capture state (main thread)

  private func startObserving() {
    if observer != nil { return }
    captured = UIScreen.main.isCaptured
    observer = NotificationCenter.default.addObserver(
      forName: UIScreen.capturedDidChangeNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      guard let self = self else { return }
      let now = UIScreen.main.isCaptured
      let changed = now != self.captured
      self.captured = now
      self.refresh()
      if changed {
        self.sendEvent("onCaptureChange", ["captured": now])
      }
    }
  }

  private func stopObserving() {
    if let o = observer {
      NotificationCenter.default.removeObserver(o)
      observer = nil
    }
    tags.removeAll()
    hideShield()
  }

  private func refresh() {
    captured = UIScreen.main.isCaptured
    if captured && !tags.isEmpty {
      showShield()
    } else {
      hideShield()
    }
  }

  // MARK: - Shield window

  private func activeScene() -> UIWindowScene? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    return scenes.first(where: { $0.activationState == .foregroundActive })
      ?? scenes.first(where: { $0.activationState == .foregroundInactive })
      ?? scenes.first
  }

  private func showShield() {
    if let w = shieldWindow {
      (w.rootViewController as? ChatPrivacyShieldController)?.setTexts(title: title, subtitle: subtitle)
      w.isHidden = false
      return
    }
    guard let scene = activeScene() else { return }
    let w = ChatPrivacyShieldWindow(windowScene: scene)
    w.frame = scene.coordinateSpace.bounds
    w.windowLevel = UIWindow.Level.alert + 50
    w.backgroundColor = .black
    let vc = ChatPrivacyShieldController()
    vc.setTexts(title: title, subtitle: subtitle)
    w.rootViewController = vc
    // Nunca vira keyWindow (isHidden = false, não makeKeyAndVisible): o
    // teclado/primeiro respondedor continuam na janela do app.
    w.isHidden = false
    shieldWindow = w
  }

  private func hideShield() {
    guard let w = shieldWindow else { return }
    w.isHidden = true
    w.rootViewController = nil
    shieldWindow = nil
  }
}

/// Janela que não captura toques (o usuário ainda consegue voltar/fechar às
/// cegas enquanto grava); só cobre o conteúdo.
final class ChatPrivacyShieldWindow: UIWindow {
  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    return nil
  }
}

final class ChatPrivacyShieldController: UIViewController {
  private let iconView = UIImageView()
  private let titleLabel = UILabel()
  private let subtitleLabel = UILabel()
  private var pendingTitle = ""
  private var pendingSubtitle = ""

  override var preferredStatusBarStyle: UIStatusBarStyle { return .lightContent }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    view.isUserInteractionEnabled = false

    let cfg = UIImage.SymbolConfiguration(pointSize: 40, weight: .regular)
    iconView.image = UIImage(systemName: "lock.shield", withConfiguration: cfg)
    iconView.tintColor = .white
    iconView.contentMode = .scaleAspectFit

    titleLabel.textColor = .white
    titleLabel.font = UIFont.systemFont(ofSize: 17, weight: .semibold)
    titleLabel.textAlignment = .center
    titleLabel.numberOfLines = 2

    subtitleLabel.textColor = UIColor(white: 1, alpha: 0.6)
    subtitleLabel.font = UIFont.systemFont(ofSize: 14)
    subtitleLabel.textAlignment = .center
    subtitleLabel.numberOfLines = 3

    let stack = UIStackView(arrangedSubviews: [iconView, titleLabel, subtitleLabel])
    stack.axis = .vertical
    stack.alignment = .center
    stack.spacing = 10
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
      stack.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 32),
      stack.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -32),
      iconView.heightAnchor.constraint(equalToConstant: 48),
      iconView.widthAnchor.constraint(equalToConstant: 48),
    ])
    applyTexts()
  }

  func setTexts(title: String, subtitle: String) {
    pendingTitle = title
    pendingSubtitle = subtitle
    if isViewLoaded { applyTexts() }
  }

  private func applyTexts() {
    titleLabel.text = pendingTitle
    subtitleLabel.text = pendingSubtitle
    subtitleLabel.isHidden = pendingSubtitle.isEmpty
  }
}
