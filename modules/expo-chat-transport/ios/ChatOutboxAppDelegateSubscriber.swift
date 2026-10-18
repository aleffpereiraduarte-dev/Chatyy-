import ExpoModulesCore
import UIKit
import BackgroundTasks

/// [2026-10-15 fase 4] Ganchos de AppDelegate da fila de envio nativa:
/// • registra o BGAppRefreshTask "com.onemundo.mail.outbox" ANTES do fim do
///   didFinishLaunching (iOS 18 mata o app se registrar depois) — só se o
///   identificador estiver no Info.plist (BGTaskSchedulerPermittedIdentifiers,
///   via app.json); sem ele, nada é registrado (registrar id fora da lista lança).
/// • reata a URLSession de 2º plano dos uploads de mídia quando o iOS relança o
///   app por eventos dela (handleEventsForBackgroundURLSession).
public class ChatOutboxAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    ChatOutboxBackground.registerOnce()
    ChatOutbox.shared.start()
    // [2026-10-18 native-share] jobs da ShareExtension que ficaram órfãos
    ChatyyShareOutbox.shared.drainSoon("launch", delay: 6)
    return true
  }

  public func applicationDidBecomeActive(_ application: UIApplication) {
    ChatyyShareOutbox.shared.drainSoon("active", delay: 2)
  }

  public func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    // Outras sessões (backup, ChatTransfer…) têm donos próprios. O Expo AGREGA o
    // handler de todos os assinantes → ack imediato do que não é nosso, senão o
    // iOS nunca recebe o "terminei" das sessões dos outros.
    // [2026-10-18 native-share] uploads da ShareExtension (sessão por envio)
    if ChatyyShareOutbox.isShareSession(identifier) {
      ChatyyShareOutbox.shared.handleBackgroundEvents(identifier: identifier, completion: completionHandler)
      return
    }
    guard identifier == ChatOutbox.bgSessionId else { completionHandler(); return }
    ChatOutbox.shared.handleBackgroundEvents(completionHandler)
  }
}

enum ChatOutboxBackground {
  private static var registered = false

  static var permitted: Bool {
    let ids = Bundle.main.object(forInfoDictionaryKey: "BGTaskSchedulerPermittedIdentifiers") as? [String] ?? []
    return ids.contains(ChatOutbox.bgTaskId)
  }

  static func registerOnce() {
    if registered || !permitted { return }
    registered = true
    BGTaskScheduler.shared.register(forTaskWithIdentifier: ChatOutbox.bgTaskId, using: nil) { task in
      // `finished` só é tocado na fila do transporte (drain responde nela) → sem corrida.
      var finished = false
      let q = ChatTransport.shared.q
      task.expirationHandler = {
        q.async {
          if finished { return }
          finished = true
          schedule()
          task.setTaskCompleted(success: false)
        }
      }
      ChatTransport.shared.initialize()
      ChatOutbox.shared.drain(maxMs: 25000) { pending in
        if finished { return }
        finished = true
        if pending { schedule() }
        task.setTaskCompleted(success: !pending)
      }
    }
  }

  /// Pede ao iOS uma janela em 2º plano p/ reenviar texto pendente (oportunista).
  static func schedule() {
    if !registered { return }
    let req = BGAppRefreshTaskRequest(identifier: ChatOutbox.bgTaskId)
    req.earliestBeginDate = Date(timeIntervalSinceNow: 60)
    try? BGTaskScheduler.shared.submit(req)
  }
}
