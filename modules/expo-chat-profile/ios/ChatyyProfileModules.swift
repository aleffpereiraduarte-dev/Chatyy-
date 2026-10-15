import ExpoModulesCore
import UIKit

// [2026-10-15 native-profile] "Dados do contato / grupo" — 3 views nativas.
// JS: components/chat/NativeProfileBridge.js. Contrato: modules/expo-chat-profile/index.ts.

private func pfDicts(_ v: [Any]?) -> [[String: Any]] {
  return (v ?? []).compactMap { $0 as? [String: Any] }
}

public class ChatyyProfileHeaderModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyProfileHeader")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(ChatyyProfileHeaderView.self) {
      Events("onClose", "onAction", "onAvatarPress", "onGallery")

      Prop("theme") { (view: ChatyyProfileHeaderView, v: [String: Any]?) in view.pendingTheme = v ?? [:] }
      Prop("title") { (view: ChatyyProfileHeaderView, v: String?) in view.titleText = v ?? "" }
      Prop("subtitle") { (view: ChatyyProfileHeaderView, v: String?) in view.subtitleText = v ?? "" }
      Prop("avatar") { (view: ChatyyProfileHeaderView, v: [String: Any]?) in view.avatarRef = PFImageRef.from(v) }
      Prop("initials") { (view: ChatyyProfileHeaderView, v: String?) in view.initials = v ?? "" }
      Prop("avatarColor") { (view: ChatyyProfileHeaderView, v: Double?) in
        view.avatarColor = pfColor(v, UIColor(white: 0.55, alpha: 1))
      }
      Prop("photos") { (view: ChatyyProfileHeaderView, v: [Any]?) in
        view.photos = (v ?? []).compactMap { PFImageRef.from($0) }
      }
      Prop("actions") { (view: ChatyyProfileHeaderView, v: [Any]?) in view.pendingActions = pfDicts(v) }
      Prop("expandedHeight") { (view: ChatyyProfileHeaderView, v: Double?) in view.expandedHeight = CGFloat(max(60, v ?? 264)) }
      Prop("compactHeight") { (view: ChatyyProfileHeaderView, v: Double?) in view.compactHeight = CGFloat(max(44, v ?? 56)) }
      Prop("topInset") { (view: ChatyyProfileHeaderView, v: Double?) in view.topInset = CGFloat(max(0, v ?? 0)) }
      Prop("avatarBadge") { (view: ChatyyProfileHeaderView, v: String?) in view.avatarBadge = v ?? "" }
      Prop("avatarBusy") { (view: ChatyyProfileHeaderView, v: Bool?) in view.avatarBusy = v ?? false }
      Prop("labels") { (view: ChatyyProfileHeaderView, v: [String: String]?) in view.labels = v ?? [:] }
      Prop("closeStyle") { (view: ChatyyProfileHeaderView, v: String?) in view.closeStyle = v ?? "close" }

      OnViewDidUpdateProps { (view: ChatyyProfileHeaderView) in
        view.didUpdateProps()
      }
    }
  }
}

public class ChatyyProfileMediaModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyProfileMedia")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(ChatyyProfileMediaView.self) {
      Events("onHeightChange", "onItem", "onSeeAll", "onTabChange")

      Prop("theme") { (view: ChatyyProfileMediaView, v: [String: Any]?) in view.pendingTheme = v ?? [:] }
      Prop("tabs") { (view: ChatyyProfileMediaView, v: [Any]?) in view.pendingTabs = pfDicts(v) }
      Prop("selected") { (view: ChatyyProfileMediaView, v: String?) in view.selectedProp = v ?? "" }
      Prop("media") { (view: ChatyyProfileMediaView, v: [Any]?) in view.pendingMedia = pfDicts(v) }
      Prop("links") { (view: ChatyyProfileMediaView, v: [Any]?) in view.pendingLinks = pfDicts(v) }
      Prop("files") { (view: ChatyyProfileMediaView, v: [Any]?) in view.pendingFiles = pfDicts(v) }
      Prop("labels") { (view: ChatyyProfileMediaView, v: [String: String]?) in view.labels = v ?? [:] }
      Prop("maxItems") { (view: ChatyyProfileMediaView, v: Int?) in view.maxItems = max(3, min(30, v ?? 9)) }

      OnViewDidUpdateProps { (view: ChatyyProfileMediaView) in
        view.didUpdateProps()
      }
    }
  }
}

public class ChatyyProfileListModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyProfileList")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(ChatyyProfileListView.self) {
      Events("onHeightChange", "onRowAction")

      Prop("theme") { (view: ChatyyProfileListView, v: [String: Any]?) in view.pendingTheme = v ?? [:] }
      Prop("rows") { (view: ChatyyProfileListView, v: [Any]?) in view.pendingRows = pfDicts(v) }
      Prop("avatarSize") { (view: ChatyyProfileListView, v: Double?) in view.avatarSize = CGFloat(max(24, min(64, v ?? 42))) }
      Prop("emptyText") { (view: ChatyyProfileListView, v: String?) in view.emptyText = v ?? "" }

      OnViewDidUpdateProps { (view: ChatyyProfileListView) in
        view.didUpdateProps()
      }
    }
  }
}
