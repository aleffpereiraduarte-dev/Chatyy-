import ExpoModulesCore
import UIKit

// [2026-10-15 native-notes] Lista/grade de NOTAS em NATIVO (app/notes.js).
// Ver ChatyyNotesListView.swift e components/native/NativeNotesList.js.
//
// Props:  rowsPatch {seq, base, reset?, upsert?, remove?, order?}, colors
//         (CTColors + card, cardBorder; ARGB), highlight, layoutMode ("list" |
//         "grid"), labels {delete, pin, unpin}, menu [{a, t, t2?, g?, x?}],
//         swipeEnabled, menuEnabled, refreshEnabled, refreshing, topInset,
//         bottomInset, autoInset, scrollToTopSeq
// Events: onRowPress {id}, onRowAction {id, action, source}, onRefresh,
//         onResync {seq}, onFirstPaint {count}, onNativeError {message}
public class ChatyyNotesListModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyNotesList")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(ChatyyNotesListView.self) {
      Events(
        "onRowPress",
        "onRowAction",
        "onRefresh",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { (view: ChatyyNotesListView, value: [String: Any]?) in
        view.setRowsPatch(value)
      }
      Prop("colors") { (view: ChatyyNotesListView, value: [String: Any]?) in
        view.setColors(value)
      }
      Prop("highlight") { (view: ChatyyNotesListView, value: String?) in
        view.setHighlight(value ?? "")
      }
      Prop("layoutMode") { (view: ChatyyNotesListView, value: String?) in
        view.setLayoutMode(value ?? "list")
      }
      Prop("labels") { (view: ChatyyNotesListView, value: [String: Any]?) in
        view.setLabels(value)
      }
      Prop("menu") { (view: ChatyyNotesListView, value: [[String: Any]]?) in
        view.setMenu(value)
      }
      Prop("swipeEnabled") { (view: ChatyyNotesListView, value: Bool?) in
        view.swipeEnabled = value ?? true
      }
      Prop("menuEnabled") { (view: ChatyyNotesListView, value: Bool?) in
        view.menuEnabled = value ?? true
      }
      Prop("refreshEnabled") { (view: ChatyyNotesListView, value: Bool?) in
        view.setRefreshEnabled(value ?? false)
      }
      Prop("refreshing") { (view: ChatyyNotesListView, value: Bool?) in
        view.setRefreshing(value ?? false)
      }
      Prop("topInset") { (view: ChatyyNotesListView, value: Double?) in
        view.setTopInset(CGFloat(value ?? 0))
      }
      Prop("bottomInset") { (view: ChatyyNotesListView, value: Double?) in
        view.setBottomInset(CGFloat(value ?? 0))
      }
      Prop("autoInset") { (view: ChatyyNotesListView, value: Bool?) in
        view.setAutoInset(value ?? false)
      }
      Prop("scrollToTopSeq") { (view: ChatyyNotesListView, value: Double?) in
        view.setScrollToTopSeq(value ?? 0)
      }

      OnViewDidUpdateProps { (view: ChatyyNotesListView) in
        view.commitProps()
      }
    }
  }
}
