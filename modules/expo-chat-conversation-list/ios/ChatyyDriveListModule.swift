import ExpoModulesCore
import UIKit

// [2026-10-15 native-drive] Lista/grade de ARQUIVOS em NATIVO (app/drive.js,
// app/files.js). Ver ChatyyDriveListView.swift e components/native/NativeDriveList.js.
//
// Props:  rowsPatch {seq, base, reset?, upsert?, remove?, order?}, mode
//         ("list" | "grid"), columns, selectionMode, selectedIds [id],
//         uploads [{id, name, progress, state}], labels {ação: título,
//         uploading}, highlight, colors (ARGB), refreshEnabled, refreshing,
//         topInset, bottomInset, scrollToTopSeq, authToken, autoInset
// Events: onRowPress {id}, onRowAction {id, action, source}, onLongPress {id},
//         onRefresh, onEndReached, onResync {seq}, onFirstPaint {count},
//         onNativeError {message}
public class ChatyyDriveListModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyDriveList")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(ChatyyDriveListView.self) {
      Events(
        "onRowPress",
        "onRowAction",
        "onLongPress",
        "onRefresh",
        "onEndReached",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { (view: ChatyyDriveListView, value: [String: Any]?) in
        view.setRowsPatch(value)
      }
      Prop("mode") { (view: ChatyyDriveListView, value: String?) in
        view.setMode(value ?? "list")
      }
      Prop("columns") { (view: ChatyyDriveListView, value: Double?) in
        view.setColumns(Int(value ?? 0))
      }
      Prop("selectionMode") { (view: ChatyyDriveListView, value: Bool?) in
        view.setSelectionMode(value ?? false)
      }
      Prop("selectedIds") { (view: ChatyyDriveListView, value: [String]?) in
        view.setSelectedIds(value ?? [])
      }
      Prop("uploads") { (view: ChatyyDriveListView, value: [[String: Any]]?) in
        view.setUploads(value)
      }
      Prop("labels") { (view: ChatyyDriveListView, value: [String: Any]?) in
        view.setLabels(value)
      }
      Prop("highlight") { (view: ChatyyDriveListView, value: String?) in
        view.setHighlight(value ?? "")
      }
      Prop("colors") { (view: ChatyyDriveListView, value: [String: Any]?) in
        view.setColors(value)
      }
      Prop("refreshEnabled") { (view: ChatyyDriveListView, value: Bool?) in
        view.setRefreshEnabled(value ?? true)
      }
      Prop("refreshing") { (view: ChatyyDriveListView, value: Bool?) in
        view.setRefreshing(value ?? false)
      }
      Prop("topInset") { (view: ChatyyDriveListView, value: Double?) in
        view.setTopInset(CGFloat(value ?? 0))
      }
      Prop("bottomInset") { (view: ChatyyDriveListView, value: Double?) in
        view.setBottomInset(CGFloat(value ?? 0))
      }
      Prop("scrollToTopSeq") { (view: ChatyyDriveListView, value: Double?) in
        view.setScrollToTopSeq(value ?? 0)
      }
      Prop("authToken") { (view: ChatyyDriveListView, value: String?) in
        view.setAuthToken(value ?? "")
      }
      Prop("autoInset") { (view: ChatyyDriveListView, value: Bool?) in
        view.setAutoInset(value ?? false)
      }

      OnViewDidUpdateProps { (view: ChatyyDriveListView) in
        view.commitProps()
      }
    }
  }
}
