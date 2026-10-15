import ExpoModulesCore
import UIKit

// [2026-10-15 screen-protect-all] Liga a proteção de captura do app inteiro
// no didFinishLaunching (antes do JS): estado persistido do último JS; nunca
// decidido = DESLIGADO no iOS (só liga com screen_protect_ios) + guarda de crash.
// Ver ChatyyScreenProtect.swift.
public class ChatPrivacyAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    DispatchQueue.main.async {
      ChatyyScreenProtect.shared.start()
    }
    return true
  }
}
