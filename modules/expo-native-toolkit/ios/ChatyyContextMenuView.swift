// [2026-10-09 more-native] Menu de contexto NATIVO (UIContextMenuInteraction).
//
// Long-press num item → o sistema "levanta" a própria view (preview com cantos
// arredondados e fundo desfocado) e mostra um UIMenu com SF Symbols — o mesmo
// menu do Fotos/Mensagens/WhatsApp iOS. Os filhos React são renderizados
// normalmente dentro desta view (ExpoView hospeda subviews do RN).
//
// JS: components/NativeContextMenu.js (detecta a view via
// globalThis.expo.getViewConfig → binário sem esta view = fallback JS, mesmo
// bundle OTA). Props:
//   actions: [{ id, title, systemImage?, destructive?, disabled?, checked? }]
//            destrutivas vão para um grupo inline no fim (padrão iOS).
//   menuTitle: título opcional no topo do menu.
//   menuEnabled: liga/desliga a interação (ex.: modo seleção).
//   previewCornerRadius: raio do recorte do preview (default 12).
// Eventos: onMenuAction({ id }), onMenuWillShow(), onPreviewTap().
import ExpoModulesCore
import UIKit

struct ChatyyMenuActionRecord: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  @Field var systemImage: String? = nil
  @Field var destructive: Bool = false
  @Field var disabled: Bool = false
  @Field var checked: Bool = false
}

public class ChatyyContextMenuViewModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyContextMenuView")

    View(ChatyyContextMenuView.self) {
      Events("onMenuAction", "onMenuWillShow", "onPreviewTap")

      Prop("actions") { (view: ChatyyContextMenuView, value: [ChatyyMenuActionRecord]?) in
        view.actions = value ?? []
      }
      Prop("menuTitle") { (view: ChatyyContextMenuView, value: String?) in
        view.menuTitle = value ?? ""
      }
      Prop("menuEnabled") { (view: ChatyyContextMenuView, value: Bool?) in
        view.setMenuEnabled(value ?? true)
      }
      Prop("previewCornerRadius") { (view: ChatyyContextMenuView, value: Double?) in
        view.previewCornerRadius = CGFloat(value ?? 12)
      }
    }
  }
}

public final class ChatyyContextMenuView: ExpoView, UIContextMenuInteractionDelegate {
  let onMenuAction = EventDispatcher()
  let onMenuWillShow = EventDispatcher()
  let onPreviewTap = EventDispatcher()

  var actions: [ChatyyMenuActionRecord] = []
  var menuTitle: String = ""
  var previewCornerRadius: CGFloat = 12
  private var menuInteraction: UIContextMenuInteraction?

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = false
    attachInteraction()
  }

  private func attachInteraction() {
    guard menuInteraction == nil else { return }
    let interaction = UIContextMenuInteraction(delegate: self)
    addInteraction(interaction)
    menuInteraction = interaction
  }

  func setMenuEnabled(_ enabled: Bool) {
    if enabled {
      attachInteraction()
    } else if let interaction = menuInteraction {
      removeInteraction(interaction)
      menuInteraction = nil
    }
  }

  private func buildMenu() -> UIMenu {
    var regular: [UIMenuElement] = []
    var destructive: [UIMenuElement] = []
    for item in actions {
      let id = item.id
      let title = item.title
      if id.isEmpty || title.isEmpty { continue }
      var image: UIImage? = nil
      if let symbol = item.systemImage, !symbol.isEmpty {
        image = UIImage(systemName: symbol)
      }
      let action = UIAction(title: title, image: image) { [weak self] _ in
        self?.onMenuAction(["id": id])
      }
      let isDestructive = item.destructive
      if isDestructive { action.attributes.insert(.destructive) }
      if item.disabled { action.attributes.insert(.disabled) }
      if item.checked { action.state = .on }
      if isDestructive { destructive.append(action) } else { regular.append(action) }
    }
    var children: [UIMenuElement] = regular
    if !destructive.isEmpty {
      children.append(UIMenu(title: "", options: .displayInline, children: destructive))
    }
    return UIMenu(title: menuTitle, children: children)
  }

  // MARK: UIContextMenuInteractionDelegate

  public func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    configurationForMenuAtLocation location: CGPoint
  ) -> UIContextMenuConfiguration? {
    if actions.isEmpty { return nil }
    onMenuWillShow([:])
    return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      return self?.buildMenu()
    }
  }

  public func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    previewForHighlightingMenuWithConfiguration configuration: UIContextMenuConfiguration
  ) -> UITargetedPreview? {
    guard window != nil, bounds.width > 0, bounds.height > 0 else { return nil }
    let params = UIPreviewParameters()
    params.visiblePath = UIBezierPath(roundedRect: bounds, cornerRadius: previewCornerRadius)
    return UITargetedPreview(view: self, parameters: params)
  }

  public func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    previewForDismissingMenuWithConfiguration configuration: UIContextMenuConfiguration
  ) -> UITargetedPreview? {
    guard window != nil, bounds.width > 0, bounds.height > 0 else { return nil }
    let params = UIPreviewParameters()
    params.visiblePath = UIBezierPath(roundedRect: bounds, cornerRadius: previewCornerRadius)
    return UITargetedPreview(view: self, parameters: params)
  }

  public func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    willPerformPreviewActionForMenuWith configuration: UIContextMenuConfiguration,
    animator: UIContextMenuInteractionCommitAnimating
  ) {
    animator.addCompletion { [weak self] in
      self?.onPreviewTap([:])
    }
  }
}
