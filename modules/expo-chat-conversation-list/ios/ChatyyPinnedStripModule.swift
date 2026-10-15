import ExpoModulesCore
import UIKit

// [2026-10-15 native-pins] Fileira nativa de conversas fixadas da home.
// Ver ChatyyPinnedStripView.swift e components/chatlist/NativePinnedStrip.js.
public class ChatyyPinnedStripModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyPinnedStrip")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(ChatyyPinnedStripView.self) {
      Events(
        "onPinPress",
        "onPinPressIn",
        "onPinAction",
        "onPinLongPress",
        "onPeekRequest",
        "onPeekOpen",
        "onReorder",
        "onReorderDone",
        "onNativeError"
      )

      Prop("items") { (view: ChatyyPinnedStripView, value: [[String: Any]]?) in
        view.setItems(value)
      }
      Prop("dark") { (view: ChatyyPinnedStripView, value: Bool?) in
        view.setDark(value ?? false)
      }
      Prop("labels") { (view: ChatyyPinnedStripView, value: [String: Any]?) in
        view.setLabels(value)
      }
      Prop("folders") { (view: ChatyyPinnedStripView, value: [[String: Any]]?) in
        view.setFolders(value)
      }
      Prop("peek") { (view: ChatyyPinnedStripView, value: [String: Any]?) in
        view.setPeek(value)
      }
      Prop("avatarSize") { (view: ChatyyPinnedStripView, value: Double?) in
        view.setAvatarSize(CGFloat(value ?? 72))
      }
      Prop("reorderMode") { (view: ChatyyPinnedStripView, value: Bool?) in
        view.setReorderMode(value ?? false)
      }
      Prop("selectionMode") { (view: ChatyyPinnedStripView, value: Bool?) in
        view.setSelectionMode(value ?? false)
      }
      Prop("menuEnabled") { (view: ChatyyPinnedStripView, value: Bool?) in
        view.menuEnabled = value ?? true
      }
      Prop("authToken") { (view: ChatyyPinnedStripView, value: String?) in
        if let v = value, !v.isEmpty { CLImageLoader.shared.authToken = v }
      }

      OnViewDidUpdateProps { (view: ChatyyPinnedStripView) in
        view.commitProps()
      }
    }
  }
}
