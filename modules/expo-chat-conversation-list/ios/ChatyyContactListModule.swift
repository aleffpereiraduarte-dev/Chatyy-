import ExpoModulesCore
import UIKit

// [2026-10-15 native-contacts] Lista de CONTATOS nativa (Contatos + Nova
// conversa): seções fixas, índice A–Z lateral com haptic, swipe Apagar,
// puxar p/ atualizar. JS: modules/expo-chat-conversation-list/index.ts +
// components/contacts/{contactListAdapter.js,NativeContactList.js}.
//
// Props:  rowsPatch {seq, base, reset?, upsert?, remove?, order?}, colors,
//         metrics, indexEnabled, indexMin, refreshEnabled, refreshing,
//         swipeEnabled, headerHeight, footerHeight, bottomInset, scrollToTopSeq
// Events: onRowPress {id}, onRowLongPress {id}, onRowAction {id, action, source},
//         onRefresh, onEndReached, onResync, onFirstPaint, onNativeError
public class ChatyyContactListModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyContactList")

    // 2 = [2026-10-15 native-group-create] check animado + haptic, glifos por
    //     nome (`gl`), view irmã ChatyyChipStrip.
    Function("apiVersion") { () -> Int in
      return 2
    }

    View(ChatyyContactListView.self) {
      Events(
        "onRowPress",
        "onRowLongPress",
        "onRowAction",
        "onRefresh",
        "onEndReached",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { (view: ChatyyContactListView, value: [String: Any]?) in
        view.setRowsPatch(value)
      }
      Prop("colors") { (view: ChatyyContactListView, value: [String: Any]?) in
        view.setColors(value)
      }
      Prop("metrics") { (view: ChatyyContactListView, value: [String: Any]?) in
        view.setMetrics(value)
      }
      Prop("indexEnabled") { (view: ChatyyContactListView, value: Bool?) in
        view.setIndexEnabled(value ?? true)
      }
      Prop("indexMin") { (view: ChatyyContactListView, value: Double?) in
        view.setIndexMin(value ?? 6)
      }
      Prop("refreshEnabled") { (view: ChatyyContactListView, value: Bool?) in
        view.setRefreshEnabled(value ?? false)
      }
      Prop("refreshing") { (view: ChatyyContactListView, value: Bool?) in
        view.setRefreshing(value ?? false)
      }
      Prop("swipeEnabled") { (view: ChatyyContactListView, value: Bool?) in
        view.swipeEnabled = value ?? true
      }
      Prop("headerHeight") { (view: ChatyyContactListView, value: Double?) in
        view.setHeaderHeightHint(CGFloat(value ?? 0))
      }
      Prop("footerHeight") { (view: ChatyyContactListView, value: Double?) in
        view.setFooterHeightHint(CGFloat(value ?? 0))
      }
      Prop("bottomInset") { (view: ChatyyContactListView, value: Double?) in
        view.setBottomInset(CGFloat(value ?? 0))
      }
      Prop("scrollToTopSeq") { (view: ChatyyContactListView, value: Double?) in
        view.setScrollToTopSeq(value ?? 0)
      }

      OnViewDidUpdateProps { (view: ChatyyContactListView) in
        view.commitProps()
      }
    }
  }
}
