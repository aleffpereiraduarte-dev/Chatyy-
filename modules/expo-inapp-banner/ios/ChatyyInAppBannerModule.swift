import ExpoModulesCore
import UIKit

// [2026-10-16 native-toast] Banner de notificação DENTRO do app, nativo.
// Antes: components/NotificationToast.js (Animated JS + PanResponder) — travava
// junto com o JS. Aqui tudo roda na main/render server: UIWindow própria que
// deixa passar toques fora do banner, molas UIKit (120 Hz no ProMotion com
// CADisableMinimumFrameDurationOnPhone), arrastar para cima dispensa, para baixo
// expande com resposta rápida (se `canReply`), toque abre (evento → JS navega).
// JS: modules/expo-inapp-banner/index.ts · components/NotificationToast.js.
public class ChatyyInAppBannerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyInAppBanner")

    Events("onBannerPress", "onBannerDismiss", "onBannerReply", "onBannerExpand")

    // 1 = [2026-10-16] show/dismiss + press/dismiss/reply/expand.
    Function("apiVersion") { () -> Int in
      return 1
    }

    AsyncFunction("show") { (opts: [String: Any]) -> Bool in
      IABannerPresenter.shared.emitter = { [weak self] name, body in
        self?.sendEvent(name, body)
      }
      return IABannerPresenter.shared.show(opts)
    }.runOnQueue(.main)

    AsyncFunction("dismiss") { (id: String?) in
      IABannerPresenter.shared.dismiss(id: id, reason: "js")
    }.runOnQueue(.main)

    OnDestroy {
      DispatchQueue.main.async {
        IABannerPresenter.shared.dismiss(id: nil, reason: "destroy")
        IABannerPresenter.shared.emitter = nil
      }
    }
  }
}
