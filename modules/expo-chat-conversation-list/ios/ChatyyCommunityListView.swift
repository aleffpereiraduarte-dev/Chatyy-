import ExpoModulesCore
import UIKit

// [2026-10-15 native-social] Casca da view (contrato em
// ChatyyCommunityListModule.swift). Os EventDispatcher PRECISAM morar aqui
// (o Expo procura por reflexão só na classe concreta); o resto é CMListCore.
public final class ChatyyCommunityListView: ExpoView {
  let onRowPress = EventDispatcher()
  let onRowAction = EventDispatcher()
  let onLongPress = EventDispatcher()
  let onRefresh = EventDispatcher()
  let onResync = EventDispatcher()
  let onFirstPaint = EventDispatcher()
  let onNativeError = EventDispatcher()

  let core = CMListCore(frame: .zero)

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    core.frame = bounds
    core.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(core)
    core.emit = { [weak self] name, payload in
      guard let self = self else { return }
      switch name {
      case "onRowPress": self.onRowPress(payload)
      case "onRowAction": self.onRowAction(payload)
      case "onLongPress": self.onLongPress(payload)
      case "onRefresh": self.onRefresh(payload)
      case "onResync": self.onResync(payload)
      case "onFirstPaint": self.onFirstPaint(payload)
      default: self.onNativeError(payload)
      }
    }
  }

  public override func mountChildComponentView(_ childComponentView: UIView, index: Int) {
    core.mountChild(childComponentView, index: index)
  }

  public override func unmountChildComponentView(_ childComponentView: UIView, index: Int) {
    core.unmountChild(childComponentView)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    if core.frame != bounds { core.frame = bounds }
  }
}
