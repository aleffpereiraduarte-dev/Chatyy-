import ExpoModulesCore
import UIKit

// [2026-10-15 native-editor] Editor de foto/vídeo NATIVO antes de enviar.
// JS: ChatyyMediaEditor.open(options) → Promise<result>, resolvida UMA vez com
// action 'send' | 'done' | 'cancel' | 'error'. Ver modules/expo-media-editor/index.ts.
public class ChatyyMediaEditorModule: Module {
  private weak var current: MediaEditorViewController?

  public func definition() -> ModuleDefinition {
    Name("ChatyyMediaEditor")

    Function("apiVersion") { () -> Int in
      return 1
    }

    AsyncFunction("open") { (options: [String: Any], promise: Promise) in
      let opts = MEOptions(dict: options)
      guard !opts.uri.isEmpty else {
        promise.resolve(["action": "error", "error": "no_uri"])
        return
      }
      if let old = self.current {
        self.current = nil
        old.closeFromJS()
      }
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.resolve(["action": "error", "error": "no_presenter"])
        return
      }
      let vc = MediaEditorViewController(options: opts)
      var settled = false
      vc.onFinish = { result in
        if settled { return }
        settled = true
        promise.resolve(result)
      }
      self.current = vc
      presenter.present(vc, animated: true, completion: nil)
      // Apresentação recusada (outro modal saindo, etc.) → JS cai no editor antigo.
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak vc] in
        guard !settled else { return }
        if vc == nil || vc?.presentingViewController == nil {
          settled = true
          promise.resolve(["action": "error", "error": "present_failed"])
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("close") { () -> Bool in
      guard let vc = self.current else { return false }
      self.current = nil
      vc.closeFromJS()
      return true
    }.runOnQueue(.main)
  }
}
