import ExpoModulesCore
import UIKit

// [2026-10-15 photos-native] Grade de Fotos nativa (view `ChatyyPhotosGrid`).
// Mora no pod do expo-media-viewer p/ reaproveitar o MVImageLoader (cache em
// disco) e abrir no mesmo viewer nativo (hero). JS: components/photos/nativePhotosGrid.js.
public class ChatyyPhotosGridModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyPhotosGrid")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(PGGridView.self) {
      Events("onReady", "onPress", "onZoomChange", "onScrollState", "onNativeError", "onSelectionChange", "onSelectionMode")

      Prop("theme") { (view: PGGridView, v: [String: Any]?) in view.setTheme(v ?? [:]) }
      Prop("dark") { (view: PGGridView, v: Bool?) in view.setDark(v) }
      Prop("locale") { (view: PGGridView, v: String?) in view.setLocale(v) }
      Prop("labels") { (view: PGGridView, v: [String: Any]?) in view.setLabels(v) }
      Prop("contentInsetTop") { (view: PGGridView, v: Double?) in view.setInsets(top: v ?? 0, bottom: nil) }
      Prop("contentInsetBottom") { (view: PGGridView, v: Double?) in view.setInsets(top: nil, bottom: v ?? 0) }
      Prop("includeLocal") { (view: PGGridView, v: Bool?) in view.setIncludeLocal(v) }
      Prop("backupEnabled") { (view: PGGridView, v: Bool?) in view.setBackupEnabled(v) }
      Prop("showBadges") { (view: PGGridView, v: Bool?) in view.setShowBadges(v) }
      Prop("zoomLevels") { (view: PGGridView, v: [[String: Any]]?) in view.setZoomLevels(v) }
      Prop("zoomLevel") { (view: PGGridView, v: Int?) in view.setZoomLevel(v) }

      AsyncFunction("setCloudItems") { (view: PGGridView, items: [[String: Any]], replace: Bool) in
        view.setCloudItems(items, replace: replace)
      }.runOnQueue(.main)

      AsyncFunction("setStatuses") { (view: PGGridView, payload: [String: Any], replace: Bool) in
        view.setStatuses(payload, replace: replace)
      }.runOnQueue(.main)

      AsyncFunction("getItems") { (view: PGGridView, from: Int, count: Int) -> [[String: Any]] in
        return view.getItems(from: from, count: count)
      }.runOnQueue(.main)

      AsyncFunction("indexOfKey") { (view: PGGridView, key: String) -> Int in
        return view.indexOfKey(key)
      }.runOnQueue(.main)

      AsyncFunction("frameForKey") { (view: PGGridView, key: String) -> [String: Any]? in
        return view.frameForKey(key)
      }.runOnQueue(.main)

      AsyncFunction("scrollToKey") { (view: PGGridView, key: String, animated: Bool) -> Bool in
        return view.scrollToKey(key, animated: animated)
      }.runOnQueue(.main)

      AsyncFunction("scrollToTop") { (view: PGGridView, animated: Bool) in
        view.scrollToTop(animated)
      }.runOnQueue(.main)

      AsyncFunction("reloadLocal") { (view: PGGridView) in
        view.reloadLocal()
      }.runOnQueue(.main)

      AsyncFunction("setSelectionMode") { (view: PGGridView, on: Bool) in
        view.setSelectionMode(on)
      }.runOnQueue(.main)

      AsyncFunction("clearSelection") { (view: PGGridView) in
        view.clearSelection()
      }.runOnQueue(.main)

      AsyncFunction("selectAll") { (view: PGGridView) in
        view.selectAll()
      }.runOnQueue(.main)

      AsyncFunction("getSelection") { (view: PGGridView) -> [String] in
        return view.getSelection()
      }.runOnQueue(.main)
    }
  }
}
