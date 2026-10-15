import ExpoModulesCore
import UIKit

// [2026-10-15 native-effects] Efeitos de tela cheia das mensagens.
// JS: modules/expo-chat-effects/index.ts → play(name, {dark, emoji, intensity, x,y,w,h}).
// Tudo roda na main (Core Animation); o overlay não recebe toques.
public class ChatyyEffectsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyEffects")

    Function("apiVersion") { () -> Int in
      return 1
    }

    AsyncFunction("play") { (name: String, opts: [String: Any]?) -> Bool in
      return CEOverlay.shared.play(name, opts ?? [:])
    }.runOnQueue(.main)

    AsyncFunction("stopAll") { () -> Void in
      CEOverlay.shared.stopAll()
    }.runOnQueue(.main)
  }
}
