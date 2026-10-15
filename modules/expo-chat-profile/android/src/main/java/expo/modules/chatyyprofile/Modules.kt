package expo.modules.chatyyprofile

// [2026-10-15 native-profile] Módulos Expo do perfil nativo (Android).
// Contrato: modules/expo-chat-profile/index.ts (+ SPEC da leva).

import android.view.View
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ChatyyProfileHeaderModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyProfileHeader")

    Function("apiVersion") { 1 }

    View(ChatyyProfileHeaderView::class) {
      Events("onClose", "onAction", "onAvatarPress", "onGallery")

      Prop("theme") { view: ChatyyProfileHeaderView, v: Map<String, Any?>? -> view.setTheme(v) }
      Prop("title") { view: ChatyyProfileHeaderView, v: String? -> view.setTitleProp(v ?: "") }
      Prop("subtitle") { view: ChatyyProfileHeaderView, v: String? -> view.setSubtitleProp(v ?: "") }
      Prop("avatar") { view: ChatyyProfileHeaderView, v: Map<String, Any?>? -> view.setAvatarProp(v) }
      Prop("initials") { view: ChatyyProfileHeaderView, v: String? -> view.setInitialsProp(v ?: "") }
      Prop("avatarColor") { view: ChatyyProfileHeaderView, v: Double? -> view.setAvatarColorProp(v) }
      Prop("photos") { view: ChatyyProfileHeaderView, v: List<Map<String, Any?>>? -> view.setPhotosProp(v) }
      Prop("actions") { view: ChatyyProfileHeaderView, v: List<Map<String, Any?>>? -> view.setActionsProp(v) }
      Prop("expandedHeight") { view: ChatyyProfileHeaderView, v: Double? -> view.setExpandedHeight(v) }
      Prop("compactHeight") { view: ChatyyProfileHeaderView, v: Double? -> view.setCompactHeight(v) }
      Prop("topInset") { view: ChatyyProfileHeaderView, v: Double? -> view.setTopInset(v) }
      Prop("avatarBadge") { view: ChatyyProfileHeaderView, v: String? -> view.setAvatarBadgeProp(v ?: "") }
      Prop("avatarBusy") { view: ChatyyProfileHeaderView, v: Boolean? -> view.setAvatarBusyProp(v ?: false) }
      Prop("labels") { view: ChatyyProfileHeaderView, v: Map<String, String>? -> view.setLabelsProp(v) }
      Prop("closeStyle") { view: ChatyyProfileHeaderView, v: String? -> view.setCloseStyleProp(v ?: "close") }

      OnViewDidUpdateProps { view: ChatyyProfileHeaderView -> view.didUpdateProps() }

      // Só os filhos RN aparecem p/ o Fabric — o overlay nativo fica fora dos índices.
      GroupView<ChatyyProfileHeaderView> {
        AddChildView { parent, child: View, index -> parent.addRnChild(child, index) }
        GetChildCount { parent -> parent.rnChildCount() }
        GetChildViewAt { parent, index -> parent.rnChildAt(index) }
        RemoveChildViewAt { parent, index -> parent.removeRnChildAt(index) }
        RemoveChildView { parent, child: View -> parent.removeRnChild(child) }
      }
    }
  }
}

class ChatyyProfileMediaModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyProfileMedia")

    Function("apiVersion") { 1 }

    View(ChatyyProfileMediaView::class) {
      Events("onHeightChange", "onItem", "onSeeAll", "onTabChange")

      Prop("theme") { view: ChatyyProfileMediaView, v: Map<String, Any?>? -> view.setTheme(v) }
      Prop("tabs") { view: ChatyyProfileMediaView, v: List<Map<String, Any?>>? -> view.setTabs(v) }
      Prop("selected") { view: ChatyyProfileMediaView, v: String? -> view.setSelected(v ?: "") }
      Prop("media") { view: ChatyyProfileMediaView, v: List<Map<String, Any?>>? -> view.setMedia(v) }
      Prop("links") { view: ChatyyProfileMediaView, v: List<Map<String, Any?>>? -> view.setLinks(v) }
      Prop("files") { view: ChatyyProfileMediaView, v: List<Map<String, Any?>>? -> view.setFiles(v) }
      Prop("labels") { view: ChatyyProfileMediaView, v: Map<String, String>? -> view.setLabels(v) }
      Prop("maxItems") { view: ChatyyProfileMediaView, v: Int? -> view.setMaxItems(v) }

      OnViewDidUpdateProps { view: ChatyyProfileMediaView -> view.didUpdateProps() }
    }
  }
}

class ChatyyProfileListModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyProfileList")

    Function("apiVersion") { 1 }

    View(ChatyyProfileListView::class) {
      Events("onHeightChange", "onRowAction")

      Prop("theme") { view: ChatyyProfileListView, v: Map<String, Any?>? -> view.setTheme(v) }
      Prop("rows") { view: ChatyyProfileListView, v: List<Map<String, Any?>>? -> view.setRows(v) }
      Prop("avatarSize") { view: ChatyyProfileListView, v: Double? -> view.setAvatarSize(v) }
      Prop("emptyText") { view: ChatyyProfileListView, v: String? -> view.setEmptyText(v ?: "") }

      OnViewDidUpdateProps { view: ChatyyProfileListView -> view.didUpdateProps() }
    }
  }
}

