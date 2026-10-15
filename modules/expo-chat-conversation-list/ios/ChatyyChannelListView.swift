import ExpoModulesCore
import UIKit

// [2026-10-15 native-social] Aba CANAIS: lista de canais (Seguindo / Descobrir) — components/channels/NativeChannelList.js.
// Toda a lógica mora em CHListCore; aqui só os EventDispatcher (descobertos
// por reflexão nesta classe) e os filhos RN.
public final class ChatyyChannelListView: ExpoView {
  let onRowPress = EventDispatcher()
  let onRowAction = EventDispatcher()
  let onRefresh = EventDispatcher()
  let onEndReached = EventDispatcher()
  let onResync = EventDispatcher()
  let onFirstPaint = EventDispatcher()
  let onNativeError = EventDispatcher()

  private(set) var core: CHListCore!
  var authToken = ""

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    core = CHListCore { [weak self] name, payload in
      self?.dispatch(name, payload)
    }
    core.collectionView.frame = bounds
    addSubview(core.collectionView)
  }

  private func dispatch(_ name: String, _ payload: [String: Any]) {
    switch name {
    case "onRowPress": onRowPress(payload)
    case "onRowAction": onRowAction(payload)
    case "onRefresh": onRefresh(payload)
    case "onEndReached": onEndReached(payload)
    case "onResync": onResync(payload)
    case "onFirstPaint": onFirstPaint(payload)
    default: onNativeError(payload)
    }
  }

  func commitProps() { core.commitProps(owner: self) }

  public override func mountChildComponentView(_ childComponentView: UIView, index: Int) {
    core.mountChild(childComponentView, index: index)
  }

  public override func unmountChildComponentView(_ childComponentView: UIView, index: Int) {
    core.unmountChild(childComponentView)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    if core.collectionView.frame != bounds { core.collectionView.frame = bounds }
    core.layoutHosts()
  }
}
