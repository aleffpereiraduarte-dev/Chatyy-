import ExpoModulesCore
import UIKit
import AVFoundation
import Photos

// [2026-10-15 native-attach] Folha de anexos + câmera do chat em NATIVO
// (nível Telegram/WhatsApp), estética P&B do app (SF Symbols, sem emoji).
//
//   openSheet(options)  → Promise<result>  (AttachSheetController)
//   openCamera(options) → Promise<result>  (ChatCameraController)
//   prewarmCamera() / releaseCamera()      (AVCaptureSession pré-configurada)
//
// Resultados (sempre UM por chamada; nunca rejeita depois de apresentar):
//   { action: 'send',    items, caption, hd, asFile }   (folha: Enviar)
//   { action: 'preview', items }                         (folha: toque longo)
//   { action: 'action',  key }                           (folha: botão/tile câmera)
//   { action: 'capture', items }                         (câmera: foto/vídeo)
//   { action: 'pick',    items }                         (câmera: faixa recentes)
//   { action: 'gallery' }                                (câmera: botão galeria)
//   { action: 'cancel' }
// items[i] = { uri: file://, name, type (mime), size, width, height,
//              duration (s | null), mediaType: 'image' | 'video' }
// Apresentação falhou (sem view controller) → resolve null → JS usa o fallback.
public class ChatyyAttachModule: Module {
  private var sheet: AttachSheetController?
  private var camera: ChatCameraController?
  private var videoNote: VideoNoteController?
  // [2026-10-20 attach-armed] folha "armada" pelo JS: o "+" do composer
  // (Notification ChatyyComposerPlusTapped) apresenta NO MESMO TOQUE, sem ir
  // e voltar pelo JS (vídeo 747: ~130 ms de conversa vazia entre o teclado
  // descer e a folha aparecer). Resultado vai pelo evento onArmedResult.
  private var armed: [String: Any]?
  private var armedId: String = ""
  private var plusObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("ChatyyAttach")

    // 2 = openVideoNote (gravador de vídeo-recado redondo) [2026-10-15 native-vnote]
    // 3 = câmera com statusModes (Texto · Normal · Boomerang) [2026-10-15 native-status-studio]
    // 4 = [2026-10-19 attach-instant] folha posta ChatyyAttachSheetWillClose /
    //     ChatyyAttachSheetDidClose {action, user} → o composer nativo devolve
    //     o teclado sozinho ao cancelar (sem focus do JS).
    // 5 = [2026-10-19 attach-close] fechar a folha sem engasgo: descida segue a
    //     velocidade do dedo (mola crítica) / ease-out no toque fora; câmera
    //     solta só depois de a folha sair da tela.
    // 6 = [2026-10-19 attach-over-kb] openSheet({overKeyboard:true}): a folha
    //     sobe numa UIWindow ACIMA da janela do teclado (o teclado do composer
    //     fica aberto por baixo, nada na conversa se mexe); o composer (api 9)
    //     só solta o teclado quando a folha fecha. Posta
    //     ChatyyAttachSheetWillPresent {overKeyboard} antes de apresentar.
    // 7 = [2026-10-20 attach-freeze] openSheet({galleryMode}) = só galeria
    //     (X | Fotos/Álbuns | HD, altura grande, sem ações); WillPresent leva
    //     kind ("sheet" | "camera") e openCamera também o posta.
    // 8 = [2026-10-20 attach-inwindow] openSheet/openCamera({inKeyboardWindow}):
    //     a folha/câmera entra como subview da MESMA janela do painel de anexos
    //     (inputView do composer) — sem present, sem resign, nenhum evento de
    //     teclado: conversa, composer e lista parados.
    // 9 = [2026-10-20 attach-tg] openSheet({tgHeader}): cabeçalho no estilo
    //     Telegram (X à esquerda, "Recentes ▾" central abre os álbuns).
    // 10 = [2026-10-20 attach-armed] armSheet(id, options) + evento
    //     onArmedResult {id, result}: o "+" do composer (api 14) apresenta a
    //     folha no mesmo toque; folha nasce já cobrindo a área do teclado que
    //     desce e sobe com mola curta (~0,34 s).
    // 11 = [2026-10-20 attach-tgwin] armSheet({tgWindow}): sem present —
    //     a folha vira subview da janela do app (por cima de tudo), entra
    //     ~(duração do keyboardWillHide − 0,05 s) depois do "+" nascendo do
    //     botão; evento onArmedShown {id} quando entra (o chat passa a ignorar
    //     o teclado); fechar = mola + véu linear, sem refocar.
    // 12 = [2026-10-21 attach-instant-tg] tgWindow: a folha entra NO MESMO
    //     TOQUE (sem esperar a descida do teclado — ela sobe por trás do
    //     teclado descendo, como o Telegram); onArmedShown continua só depois
    //     da descida (+ immediate/showMs/waitMs); onArmedResult leva timing
    //     {show, anim, fetch, assets, n} (ms desde o toque); grade da galeria
    //     buscada fora do main (miniaturas entram depois). Opções:
    //     tgWaitKeyboard=true = espera antiga; syncFetch=true = fetch no main.
    // 13 = [2026-10-21 attach-recents-cache] armSheet pré-aquece "Recentes"
    //     (PHFetchResult fora do main, mantido por change observer): a folha
    //     abre com a grade cheia no 1º quadro (759: 1,1-1,6 s só c/ a câmera);
    //     câmera ao vivo espera o fetch frio (máx. 0,5 s). timing.cache=1|0.
    // 14 = [2026-10-21 attach-first-frame] miniaturas das ~18 primeiras de
    //     Recentes aquecidas em memória no armSheet (gerente de imagens
    //     compartilhado) + instantâneo em disco (ids + JPEG, gravado ao fechar):
    //     grade cheia no 1º quadro mesmo com PhotoKit frio. timing.snap=N.
    Function("apiVersion") { () -> Int in
      return 14
    }

    OnCreate {
      AttachKeyboardTracker.shared.start()
      // [2026-10-20 attach-armed]
      self.plusObserver = NotificationCenter.default.addObserver(forName: Notification.Name("ChatyyComposerPlusTapped"), object: nil, queue: .main) { [weak self] n in
        self?.onComposerPlus(n)
      }
    }

    OnDestroy {
      if let o = self.plusObserver { NotificationCenter.default.removeObserver(o) }
    }

    Events("onArmedResult", "onArmedShown")

    // [2026-10-20 attach-armed] JS deixa as opções prontas (id = dono). null/{} = desarma.
    AsyncFunction("armSheet") { (id: String, options: [String: Any]?) in
      if let o = options, !o.isEmpty {
        self.armed = o
        self.armedId = id
        if (o["galleryPrewarm"] as? Bool) != false { AttachRecentsCache.shared.prewarm() } // [2026-10-21 attach-recents-cache]
      } else if self.armedId == id {
        self.armed = nil
        self.armedId = ""
      }
    }.runOnQueue(.main)

    Function("isVideoNoteSupported") { () -> Bool in
      return AVCaptureDevice.default(for: .video) != nil
    }

    Function("isCameraSupported") { () -> Bool in
      return AVCaptureDevice.default(for: .video) != nil
    }

    // Configura a sessão (entradas/saídas) sem rodar: abrir a câmera depois só
    // custa o startRunning. Nunca dispara o prompt de permissão.
    AsyncFunction("prewarmCamera") { () -> Bool in
      CAEngine.shared.prewarm()
      return CAEngine.authorized
    }

    AsyncFunction("releaseCamera") { () -> Bool in
      if self.sheet == nil && self.camera == nil {
        CAEngine.shared.teardownIfIdle()
      }
      return true
    }

    AsyncFunction("openSheet") { (options: [String: Any], promise: Promise) in
      if let old = self.sheet {
        self.sheet = nil
        old.finishSilently()
      }
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.resolve(nil)
        return
      }
      let cfg = AttachConfig(options)
      let vc = AttachSheetController(config: cfg)
      var done = false
      vc.onFinish = { [weak self] result in
        if done { return }
        done = true
        if self?.sheet === vc { self?.sheet = nil }
        promise.resolve(result)
      }
      self.sheet = vc
      // [2026-10-20 attach-inwindow] painel de anexos aberto: folha dentro da
      // janela do painel (acima dele por construção).
      if (options["inKeyboardWindow"] as? Bool) == true, let kw = AttachInKeyboardWindowHost.panelWindow() {
        let host = AttachInKeyboardWindowHost()
        NotificationCenter.default.post(name: AttachSheetController.willPresentNote, object: nil, userInfo: ["overKeyboard": true, "kind": "sheet", "inWindow": true])
        vc.customRemove = { done in host.tearDown(slide: false, done) }
        vc.onCaptionEditing = { editing in host.setBelowKeyboard(editing) }
        host.show(vc, in: kw, slide: false)
        return
      }
      // [2026-10-19 attach-over-kb] teclado aberto: folha numa janela acima da
      // do teclado (sem present → o UIKit não "guarda" o first responder e o
      // teclado não some num quadro só). Falhou → apresentação normal.
      if (options["overKeyboard"] as? Bool) == true, AttachOverKeyboardHost.present(vc, over: presenter) {
        NotificationCenter.default.post(name: AttachSheetController.willPresentNote, object: nil, userInfo: ["overKeyboard": true, "kind": "sheet"])
        vc.overKeyboardHost?.show()
        NotificationCenter.default.post(name: Notification.Name("ChatyyScreenProtectRescan"), object: nil)
        DispatchQueue.main.async {
          NotificationCenter.default.post(name: Notification.Name("ChatyyScreenProtectRescan"), object: nil)
        }
        return
      }
      NotificationCenter.default.post(name: AttachSheetController.willPresentNote, object: nil, userInfo: ["overKeyboard": false, "kind": "sheet"])
      vc.modalPresentationStyle = .overFullScreen
      vc.modalPresentationCapturesStatusBarAppearance = false
      // [2026-10-15 screen-protect-all] protege a tela nova já (camada segura; expo-chat-privacy)
      presenter.present(vc, animated: false, completion: {
        NotificationCenter.default.post(name: Notification.Name("ChatyyScreenProtectRescan"), object: nil)
      })
      NotificationCenter.default.post(name: Notification.Name("ChatyyScreenProtectRescan"), object: nil)
    }.runOnQueue(.main)

    AsyncFunction("openCamera") { (options: [String: Any], promise: Promise) in
      if let old = self.camera {
        self.camera = nil
        old.finishSilently()
      }
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.resolve(nil)
        return
      }
      let cfg = AttachConfig(options)
      let vc = ChatCameraController(config: cfg)
      var done = false
      vc.onFinish = { [weak self] result in
        if done { return }
        done = true
        if self?.camera === vc { self?.camera = nil }
        promise.resolve(result)
      }
      self.camera = vc
      // [2026-10-20 attach-inwindow] câmera do painel: mesma janela do painel,
      // sobe por cima (sem present/stash do teclado).
      if (options["inKeyboardWindow"] as? Bool) == true, let kw = AttachInKeyboardWindowHost.panelWindow() {
        let host = AttachInKeyboardWindowHost()
        NotificationCenter.default.post(name: AttachSheetController.willPresentNote, object: nil, userInfo: ["overKeyboard": true, "kind": "camera", "inWindow": true])
        vc.customRemove = { animated, done in
          host.tearDown(slide: animated) {
            NotificationCenter.default.post(name: AttachSheetController.didCloseNote, object: nil, userInfo: ["action": "camera", "kind": "camera", "user": true])
            done()
          }
        }
        host.show(vc, in: kw, slide: true)
        return
      }
      vc.modalPresentationStyle = .fullScreen
      vc.modalTransitionStyle = .coverVertical
      // [2026-10-20 attach-freeze] composer solta o painel/teclado segurado agora.
      NotificationCenter.default.post(name: AttachSheetController.willPresentNote, object: nil, userInfo: ["overKeyboard": false, "kind": "camera"])
      // [2026-10-15 screen-protect-all] protege a tela nova já (camada segura; expo-chat-privacy)
      presenter.present(vc, animated: true, completion: {
        NotificationCenter.default.post(name: Notification.Name("ChatyyScreenProtectRescan"), object: nil)
      })
      NotificationCenter.default.post(name: Notification.Name("ChatyyScreenProtectRescan"), object: nil)
    }.runOnQueue(.main)

    // [2026-10-15 native-vnote] Vídeo-recado redondo (VideoNoteController).
    // Resolve { action: 'send', item } | { action: 'cancel' } | { action: 'error', message };
    // null = não conseguiu apresentar → JS usa o gravador JS.
    AsyncFunction("openVideoNote") { (options: [String: Any], promise: Promise) in
      if let old = self.videoNote {
        self.videoNote = nil
        old.finishSilently()
      }
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.resolve(nil)
        return
      }
      let vc = VideoNoteController(config: VideoNoteController.Config(options))
      var done = false
      vc.onFinish = { [weak self] result in
        if done { return }
        done = true
        if self?.videoNote === vc { self?.videoNote = nil }
        promise.resolve(result)
      }
      self.videoNote = vc
      vc.modalPresentationStyle = .overFullScreen
      vc.modalTransitionStyle = .crossDissolve
      presenter.present(vc, animated: true, completion: {
        NotificationCenter.default.post(name: Notification.Name("ChatyyScreenProtectRescan"), object: nil)
      })
    }.runOnQueue(.main)

    // Fecha o que estiver aberto (resolve 'cancel').
    AsyncFunction("dismiss") { () -> Bool in
      var any = false
      if let s = self.sheet { s.closeFromJS(); any = true }
      if let c = self.camera { c.closeFromJS(); any = true }
      if let v = self.videoNote { v.closeFromJS(); any = true }
      return any
    }.runOnQueue(.main)
  }
}

// MARK: - Folha armada (attach-armed)

extension ChatyyAttachModule {
  fileprivate func onComposerPlus(_ n: Notification) {
    guard let token = n.object as? NSMutableDictionary else { return }
    guard let opts = armed, sheet == nil, camera == nil, videoNote == nil else { return }
    guard let presenter = appContext?.utilities?.currentViewController() else { return }
    let id = armedId
    let cfg = AttachConfig(opts)
    let tapAt = CACurrentMediaTime() // [2026-10-21 attach-instant-tg] medição toque → folha
    let vc = AttachSheetController(config: cfg)
    vc.tapAt = tapAt
    var done = false
    vc.onFinish = { [weak self, weak vc] result in
      if done { return }
      done = true
      if let v = vc, self?.sheet === v { self?.sheet = nil }
      var body: [String: Any] = ["id": id, "result": result]
      if let t = vc?.openTiming, !t.isEmpty { body["timing"] = t }
      self?.sendEvent("onArmedResult", body)
    }
    sheet = vc
    token["handled"] = true
    // [2026-10-20 attach-tgwin] Telegram: teclado desce pelo sistema (resign
    // normal no composer, composer+lista juntos); a folha entra no fim da
    // descida, na MESMA janela do app (sem present = sem troca de input views
    // sem animação), nascendo do "+".
    if cfg.tgWindow, let win = presenter.viewIfLoaded?.window, AttachInKeyboardWindowHost.hostViewController(in: win) != nil {
      if let r = (token["plusFrame"] as? NSValue)?.cgRectValue { vc.sourceRect = r }
      let had = (token["hadKeyboard"] as? Bool) ?? false
      let kd = AttachKeyboardTracker.shared.lastHideDuration
      let delay: TimeInterval = had ? max(0.15, (kd > 0 ? kd : 0.25) - 0.05) : 0
      // [2026-10-21 attach-instant-tg] Founder: "clica no + e tem um delay".
      // RAIZ: com o teclado aberto a folha só ENTRAVA depois da descida dele
      // (max(0,15 s, duração − 0,05) ≈ 0,2-0,3 s de conversa parada) + 0,05 s
      // de conteúdo invisível. Sem present não há troca de input views: a folha
      // entra JÁ (subview do app, sobe por trás do teclado que desce — Telegram
      // AttachmentController). Só o aviso onArmedShown (chat passa a ignorar o
      // teclado) segue esperando a descida, p/ o lift não pular.
      let waitKb = cfg.tgWaitKeyboard
      let host = AttachInKeyboardWindowHost()
      vc.customRemove = { done in host.tearDown(slide: false, done) }
      let show = { [weak self, weak vc, weak win] in
        guard let self = self, let vc = vc, self.sheet === vc else { return }
        // pai recalculado NA HORA (a tela pode ter mudado no atraso da descida)
        if let win = win, !win.isHidden, let parent = AttachInKeyboardWindowHost.hostViewController(in: win),
           host.showAsChild(vc, of: parent) {
          NotificationCenter.default.post(name: Notification.Name("ChatyyScreenProtectRescan"), object: nil)
          let showMs = Int((CACurrentMediaTime() - tapAt) * 1000)
          vc.openTiming["show"] = showMs
          let notify = { [weak self, weak vc] in
            // folha já fechou antes do fim da descida → nada de ignorar o teclado
            guard let self = self, let vc = vc, self.sheet === vc else { return }
            self.sendEvent("onArmedShown", ["id": id, "immediate": !waitKb, "showMs": showMs, "waitMs": Int(delay * 1000)])
          }
          if !waitKb && delay > 0 { DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: notify) } else { notify() }
          return
        }
        // fallback: present da api 10 (nunca fica preso sem folha)
        vc.customRemove = nil
        guard let pres = self.appContext?.utilities?.currentViewController(), pres.presentedViewController == nil || pres.presentedViewController?.isBeingDismissed == true else {
          vc.onFinish?(["action": "cancel"]); return
        }
        vc.modalPresentationStyle = .overFullScreen
        vc.modalPresentationCapturesStatusBarAppearance = false
        pres.present(vc, animated: false, completion: nil)
        self.sendEvent("onArmedShown", ["id": id])
      }
      if waitKb && delay > 0 { DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: show) } else { show() }
      return
    }
    NotificationCenter.default.post(name: AttachSheetController.willPresentNote, object: nil, userInfo: ["overKeyboard": false, "kind": "sheet"])
    vc.modalPresentationStyle = .overFullScreen
    vc.modalPresentationCapturesStatusBarAppearance = false
    presenter.present(vc, animated: false, completion: {
      NotificationCenter.default.post(name: Notification.Name("ChatyyScreenProtectRescan"), object: nil)
    })
    NotificationCenter.default.post(name: Notification.Name("ChatyyScreenProtectRescan"), object: nil)
  }
}

// MARK: - Folha acima do teclado (attach-over-kb)

// [2026-10-19 attach-over-kb] "+" com o teclado aberto (founder, vídeo 20/10):
// o teclado sumia num quadro (present(animated:false) de um VC na janela do
// app = o UIKit guarda e tira o first responder na hora), ficava um buraco
// com o wallpaper e a conversa pulava enquanto o JS (hold/clamp/KC) brigava.
// A janela do teclado (UIRemoteKeyboardWindow/UITextEffectsWindow) fica ACIMA
// de qualquer VC da janela do app, então a folha nunca podia cobri-lo.
// AGORA (WhatsApp/Telegram): a folha vive numa UIWindow com nível acima do
// teclado, sem virar key window → o teclado do composer continua aberto POR
// BAIXO (nenhum evento de teclado = conversa parada). Legenda da folha
// precisa de teclado → a janela desce p/ baixo do teclado e vira key.
// Fechar: a janela some (sem dismiss do UIKit); o composer solta o teclado
// com a folha descendo (ChatyyAttachSheetWillClose).
// Kill switch JS: globalThis.__chatyy_attach_over_kb = false.
final class AttachOverKeyboardHost {
  private var window: UIWindow?
  private weak var previousKey: UIWindow?
  private weak var sheet: AttachSheetController?

  /// Monta a janela acima do teclado com a folha como raiz (ainda escondida).
  static func present(_ vc: AttachSheetController, over presenter: UIViewController) -> Bool {
    guard let base = presenter.view.window ?? presenter.viewIfLoaded?.window, let scene = base.windowScene else { return false }
    let host = AttachOverKeyboardHost()
    let w = UIWindow(windowScene: scene)
    w.frame = base.frame
    w.backgroundColor = .clear
    w.windowLevel = AttachOverKeyboardHost.levelAboveKeyboard(scene)
    w.rootViewController = vc
    host.window = w
    host.previousKey = scene.windows.first(where: { $0.isKeyWindow }) ?? base
    host.sheet = vc
    vc.overKeyboardHost = host
    return true
  }

  // [2026-10-20 attach-panel-fotos] build 744: a janela ficou ABAIXO do
  // painel (inputView) — agora o maior level de TODAS as janelas de todas as
  // cenas (inclui as de teclado) + 1, nunca abaixo de 10_000_001.
  static func levelAboveKeyboard(_ scene: UIWindowScene) -> UIWindow.Level {
    var top: CGFloat = 10_000_000
    var all: [UIWindow] = scene.windows
    for sc in UIApplication.shared.connectedScenes {
      if let ws = sc as? UIWindowScene { all.append(contentsOf: ws.windows) }
    }
    for w in all where w.windowLevel.rawValue < 1_000_000_000 {
      top = max(top, w.windowLevel.rawValue)
    }
    return UIWindow.Level(rawValue: top + 1)
  }

  /// Mostra SEM virar key (o teclado do composer continua aberto por baixo).
  func show() {
    guard let w = window else { return }
    w.isHidden = false
  }

  /// Legenda da folha vai editar: janela abaixo do teclado (ele aparece por
  /// cima da folha) e key (o campo pode virar first responder).
  func prepareForTextInput() {
    guard let w = window else { return }
    w.windowLevel = UIWindow.Level(rawValue: UIWindow.Level.alert.rawValue + 1)
    if !w.isKeyWindow { w.makeKey() }
  }

  /// Some com a janela (a folha já animou para fora da tela).
  func tearDown(_ completion: @escaping () -> Void) {
    guard let w = window else { completion(); return }
    window = nil
    let wasKey = w.isKeyWindow
    w.isHidden = true
    w.rootViewController = nil
    if wasKey, let prev = previousKey, prev.windowScene != nil, !prev.isHidden { prev.makeKey() }
    completion()
  }
}

// [2026-10-20 attach-inwindow] Founder (745, vídeo quadro a quadro): mesmo
// congelada, a apresentação MODAL tirava o painel (stash do UIKit = resign +
// notificações de teclado) → "+" voltava, lista deslocava, painel reaparecia
// animado (dois painéis) ao fechar. AGORA: a folha/câmera vira subview da
// MESMA janela onde o UIKit hospeda o painel (inputView) — fica acima dele por
// construção; first responder não muda, nada é apresentado, nenhum evento de
// teclado = zero movimento atrás. Legenda da folha precisa do teclado → a
// folha desce p/ trás do host do teclado enquanto edita.
// Kill switch JS: globalThis.__chatyy_attach_inwindow = false.
final class AttachInKeyboardWindowHost {
  private var container: UIView?
  private weak var window: UIWindow?
  private weak var vc: UIViewController?

  /// Janela (do teclado) que contém o NCAttachPanel do composer, se visível.
  static func panelWindow() -> UIWindow? {
    for sc in UIApplication.shared.connectedScenes {
      guard let ws = sc as? UIWindowScene else { continue }
      for w in ws.windows.reversed() where !w.isHidden && w.alpha > 0.01 {
        if containsPanel(w, depth: 0) { return w }
      }
    }
    return nil
  }

  private static func containsPanel(_ v: UIView, depth: Int) -> Bool {
    if NSStringFromClass(type(of: v)).hasSuffix("NCAttachPanel") { return v.window != nil && !v.isHidden }
    if depth > 14 { return false }
    for s in v.subviews where containsPanel(s, depth: depth + 1) { return true }
    return false
  }

  private weak var parentVC: UIViewController?

  // [2026-10-20 attach-tgwin-fix] CRASH 751: addChild no VC raiz + view na
  // UIWindow = UIViewControllerHierarchyInconsistency no addSubview (a view do
  // filho tem que ficar DENTRO da view do pai). Agora: pai = topo dos
  // presentedViewController a partir da raiz (sem os em dismiss), cobrindo a
  // janela inteira; addChild → container na view DELE → didMove. Aparência:
  // o UIKit encaminha sozinho (pai com forwarding automático); senão manual.
  static func hostViewController(in win: UIWindow) -> UIViewController? {
    guard var top = win.rootViewController else { return nil }
    while let p = top.presentedViewController, !p.isBeingDismissed { top = p }
    guard top.isViewLoaded, top.view.window === win, !top.isBeingDismissed, !top.isMovingFromParent else { return nil }
    let f = top.view.convert(top.view.bounds, to: win)
    guard abs(f.minY - win.bounds.minY) < 1, abs(f.height - win.bounds.height) < 1, abs(f.width - win.bounds.width) < 1 else { return nil }
    return top
  }

  @discardableResult
  func showAsChild(_ vc: UIViewController, of parent: UIViewController) -> Bool {
    guard parent.isViewLoaded, let pw = parent.view.window, container == nil else { return false }
    // limpeza completa se o VC/view já tinha dono (abrir duas vezes etc.)
    if vc.parent != nil { vc.willMove(toParent: nil); vc.view.removeFromSuperview(); vc.removeFromParent() }
    else if vc.isViewLoaded, vc.view.superview != nil { vc.view.removeFromSuperview() }
    parent.addChild(vc)
    let c = UIView(frame: parent.view.bounds)
    c.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    c.backgroundColor = .clear
    container = c
    window = pw
    self.vc = vc
    parentVC = parent
    vc.view.frame = c.bounds
    vc.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    c.addSubview(vc.view)
    let manual = !parent.shouldAutomaticallyForwardAppearanceMethods
    if manual { vc.beginAppearanceTransition(true, animated: false) }
    parent.view.addSubview(c)
    if manual { vc.endAppearanceTransition() }
    vc.didMove(toParent: parent)
    return true
  }

  func show(_ vc: UIViewController, in win: UIWindow, slide: Bool) {
    let c = UIView(frame: win.bounds)
    c.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    c.backgroundColor = .clear
    win.addSubview(c)
    container = c
    window = win
    self.vc = vc
    vc.view.frame = c.bounds
    vc.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    vc.beginAppearanceTransition(true, animated: slide)
    c.addSubview(vc.view)
    if slide {
      c.transform = CGAffineTransform(translationX: 0, y: win.bounds.height)
      UIView.animate(withDuration: 0.42, delay: 0, usingSpringWithDamping: 1.0, initialSpringVelocity: 0, options: [.allowUserInteraction]) {
        c.transform = .identity
      } completion: { _ in vc.endAppearanceTransition() }
    } else {
      vc.endAppearanceTransition()
    }
  }

  /// Legenda editando: folha atrás do host do teclado (teclado visível por cima).
  func setBelowKeyboard(_ below: Bool) {
    guard let c = container, let w = window else { return }
    if below { w.sendSubviewToBack(c) } else { w.bringSubviewToFront(c) }
    if !below { NotificationCenter.default.post(name: Notification.Name("ChatyyAttachCaptionDone"), object: nil) }
  }

  func tearDown(slide: Bool, _ completion: @escaping () -> Void) {
    guard let c = container else { completion(); return }
    container = nil
    let vc = self.vc
    let parent = parentVC
    let isChild = parent != nil
    parentVC = nil
    let finish = {
      if isChild {
        // [2026-10-20 attach-tgwin-fix] ordem de containment; aparência pelo UIKit.
        let manual = !(parent?.shouldAutomaticallyForwardAppearanceMethods ?? true)
        vc?.willMove(toParent: nil)
        if manual { vc?.beginAppearanceTransition(false, animated: false) }
        c.removeFromSuperview()
        if manual { vc?.endAppearanceTransition() }
        vc?.removeFromParent()
      } else {
        vc?.beginAppearanceTransition(false, animated: false)
        c.removeFromSuperview()
        vc?.endAppearanceTransition()
      }
      completion()
    }
    if slide {
      UIView.animate(withDuration: 0.28, delay: 0, options: [.curveEaseIn], animations: {
        c.transform = CGAffineTransform(translationX: 0, y: c.bounds.height)
      }, completion: { _ in finish() })
    } else {
      finish()
    }
  }
}

/// Último quadro do teclado (a folha acima do teclado nasce com ele já aberto
/// e precisa dele quando a legenda assume o teclado sem notificação nova).
final class AttachKeyboardTracker {
  static let shared = AttachKeyboardTracker()
  private(set) var endFrame: CGRect = .zero
  private(set) var visible = false
  private var started = false
  // [2026-10-20 attach-armed] última altura ABERTA e quando começou a descer.
  private(set) var lastShownHeight: CGFloat = 0
  private var hideAt: CFTimeInterval = 0
  /// [2026-10-20 attach-tgwin] duração da última descida (userInfo do keyboardWillHide).
  private(set) var lastHideDuration: TimeInterval = 0

  /// Altura do teclado aberto agora, ou que acabou de começar a descer (< 0,6 s).
  func recentHeight() -> CGFloat {
    if visible { return lastShownHeight }
    if CACurrentMediaTime() - hideAt < 0.6 { return lastShownHeight }
    return 0
  }

  func start() {
    if started { return }
    started = true
    let nc = NotificationCenter.default
    nc.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { [weak self] n in
      guard let self = self, let end = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
      self.endFrame = end
      let screenH = UIScreen.main.bounds.height
      let vis = end.height > 1 && end.minY < screenH - 1
      if vis { self.lastShownHeight = max(0, screenH - end.minY) }
      else if self.visible { self.hideAt = CACurrentMediaTime() }
      self.visible = vis
    }
    nc.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] n in
      guard let self = self else { return }
      if let d = (n.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue { self.lastHideDuration = d }
      if self.visible { self.hideAt = CACurrentMediaTime() }
      self.visible = false
    }
  }
}

// MARK: - Config / tema

struct AttachAction {
  let key: String
  let label: String
}

struct AttachConfig {
  let labels: [String: String]
  let actions: [AttachAction]
  let dark: Bool
  let bg: UIColor
  let surface: UIColor
  let text: UIColor
  let textSecondary: UIColor
  let border: UIColor
  let chip: UIColor
  let maxSelect: Int
  let hdDefault: Bool
  let allowCamera: Bool
  let maxVideoSec: Double
  let withAudio: Bool
  // [2026-10-15 native-status-studio] câmera do status: seletor Texto · Normal · Boomerang.
  let statusModes: Bool
  let boomerangSec: Double
  // [2026-10-16 motion-attach] botões de ação entram em cascata (false = estático)
  let motion: Bool
  // [2026-10-20 attach-freeze] api 7: folha SÓ galeria (WhatsApp): cabeçalho
  // X | Fotos/Álbuns | HD, altura grande, sem barra de ações embaixo.
  let galleryMode: Bool
  // [2026-10-20 attach-tg] api 9: cabeçalho Telegram (X à esquerda, "Recentes ▾" com álbuns).
  let tgHeader: Bool
  // [2026-10-20 attach-tgwin] api 11: folha na janela do app (sem present),
  // nasce do "+" depois de o teclado descer (modelo exato do Telegram).
  let tgWindow: Bool
  // [2026-10-21 attach-instant-tg] api 12: true = espera antiga (folha só no fim da descida do teclado).
  let tgWaitKeyboard: Bool
  // [2026-10-21 attach-instant-tg] api 12: true = PHAsset.fetchAssets no main (antigo).
  let syncFetch: Bool

  init(_ o: [String: Any]) {
    var l: [String: String] = [:]
    if let raw = o["labels"] as? [String: Any] {
      for (k, v) in raw { if let s = v as? String { l[k] = s } }
    }
    labels = l
    var acts: [AttachAction] = []
    if let raw = o["actions"] as? [[String: Any]] {
      for a in raw {
        guard let k = a["key"] as? String, !k.isEmpty else { continue }
        acts.append(AttachAction(key: k, label: (a["label"] as? String) ?? k))
      }
    }
    actions = acts
    let d = (o["dark"] as? Bool) ?? (UITraitCollection.current.userInterfaceStyle == .dark)
    dark = d
    let c = o["colors"] as? [String: Any] ?? [:]
    bg = UIColor.ca_hex(c["bg"] as? String) ?? (d ? UIColor(white: 0.07, alpha: 1) : .white)
    surface = UIColor.ca_hex(c["surface"] as? String) ?? (d ? UIColor(white: 0.11, alpha: 1) : UIColor(white: 0.96, alpha: 1))
    text = UIColor.ca_hex(c["text"] as? String) ?? (d ? .white : UIColor(white: 0.07, alpha: 1))
    textSecondary = UIColor.ca_hex(c["textSecondary"] as? String) ?? (d ? UIColor(white: 0.62, alpha: 1) : UIColor(white: 0.42, alpha: 1))
    border = UIColor.ca_hex(c["border"] as? String) ?? (d ? UIColor(white: 1, alpha: 0.10) : UIColor(white: 0, alpha: 0.08))
    chip = UIColor.ca_hex(c["chip"] as? String) ?? (d ? UIColor(red: 0.17, green: 0.17, blue: 0.18, alpha: 1) : UIColor(red: 0.95, green: 0.95, blue: 0.96, alpha: 1))
    maxSelect = max(1, AttachConfig.int(o["maxSelect"]) ?? 30)
    hdDefault = (o["hdDefault"] as? Bool) ?? false
    allowCamera = (o["allowCamera"] as? Bool) ?? true
    maxVideoSec = max(3, AttachConfig.double(o["maxVideoSec"]) ?? 60)
    withAudio = (o["withAudio"] as? Bool) ?? true
    statusModes = (o["statusModes"] as? Bool) ?? false
    boomerangSec = min(4, max(0.8, AttachConfig.double(o["boomerangSec"]) ?? 1.5))
    motion = (o["motion"] as? Bool) ?? true
    galleryMode = (o["galleryMode"] as? Bool) ?? false
    tgHeader = ((o["tgHeader"] as? Bool) ?? false) && !galleryMode
    tgWindow = (o["tgWindow"] as? Bool) ?? false
    tgWaitKeyboard = (o["tgWaitKeyboard"] as? Bool) ?? false
    syncFetch = (o["syncFetch"] as? Bool) ?? false
  }

  func t(_ key: String, _ fallback: String) -> String {
    if let v = labels[key], !v.isEmpty { return v }
    return fallback
  }

  static func int(_ v: Any?) -> Int? {
    if let n = v as? NSNumber { return n.intValue }
    if let s = v as? String { return Int(s) }
    return nil
  }

  static func double(_ v: Any?) -> Double? {
    if let n = v as? NSNumber { return n.doubleValue }
    if let s = v as? String { return Double(s) }
    return nil
  }
}

extension UIColor {
  static func ca_hex(_ s: String?) -> UIColor? {
    guard var h = s?.trimmingCharacters(in: .whitespacesAndNewlines), !h.isEmpty else { return nil }
    if h.hasPrefix("#") { h.removeFirst() }
    guard h.count == 6 || h.count == 8, let v = UInt64(h, radix: 16) else { return nil }
    if h.count == 6 {
      return UIColor(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255,
                     blue: CGFloat(v & 0xff) / 255, alpha: 1)
    }
    return UIColor(red: CGFloat((v >> 24) & 0xff) / 255, green: CGFloat((v >> 16) & 0xff) / 255,
                   blue: CGFloat((v >> 8) & 0xff) / 255, alpha: CGFloat(v & 0xff) / 255)
  }
}

enum CAFormat {
  static func duration(_ sec: Double) -> String {
    let s = max(0, Int(sec.rounded()))
    return String(format: "%d:%02d", s / 60, s % 60)
  }

  static func symbol(_ name: String, _ size: CGFloat, _ weight: UIImage.SymbolWeight = .regular) -> UIImage? {
    let cfg = UIImage.SymbolConfiguration(pointSize: size, weight: weight)
    return UIImage(systemName: name, withConfiguration: cfg)
  }

  /// SF Symbol por chave de ação (mesmas chaves do buildAttachItems do JS).
  static func symbolName(forAction key: String) -> String? {
    switch key {
    case "camera": return "camera"
    case "gallery": return "photo.on.rectangle"
    case "file": return "doc"
    case "scan_document": return "doc.viewfinder"
    case "location", "liveLocation": return "location"
    case "contact": return "person.crop.circle"
    case "poll": return "chart.bar"
    case "meetup": return "calendar"
    case "playlist", "audio", "music": return "music.note"
    case "gift": return "gift"
    case "short_video": return "film"
    case "games": return "gamecontroller" // [assistir-junto 2026-10-20] ícones da barra (antes grade 2x2)
    case "watch_together": return "play.rectangle.on.rectangle"
    case "listen_together": return "headphones"
    case "gif": return nil // desenhado como texto "GIF"
    default: return "square.grid.2x2"
    }
  }
}

func caHaptic(_ kind: String) {
  switch kind {
  case "select":
    let g = UISelectionFeedbackGenerator(); g.selectionChanged()
  case "warn":
    let g = UINotificationFeedbackGenerator(); g.notificationOccurred(.warning)
  case "heavy":
    let g = UIImpactFeedbackGenerator(style: .medium); g.impactOccurred()
  default:
    let g = UIImpactFeedbackGenerator(style: .light); g.impactOccurred()
  }
}
