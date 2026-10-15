package expo.modules.chatyymediaviewer

import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// [2026-10-15 native-photos] Grade de Fotos nativa (Android).
// JS: requireNativeView('ChatyyPhotosGrid'). Contrato: scratchpad photos/SPEC.md (A).
// apiVersion 1 = grade + seleção + pinça + scroller + selos + setCloudItems/setStatuses.
class ChatyyPhotosGridModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyPhotosGrid")

    Function("apiVersion") { 1 }

    View(PGGridView::class) {
      Events("onReady", "onPress", "onZoomChange", "onScrollState", "onNativeError", "onSelectionChange", "onSelectionMode")

      Prop("theme") { view: PGGridView, v: Map<String, Any?>? -> view.setTheme(v) }
      Prop("dark") { view: PGGridView, v: Boolean? -> view.setDark(v) }
      Prop("locale") { view: PGGridView, v: String? -> view.setLocale(v) }
      Prop("labels") { view: PGGridView, v: Map<String, Any?>? -> view.setLabels(v) }
      Prop("contentInsetTop") { view: PGGridView, v: Double? -> view.setInsets(v ?: 0.0, null) }
      Prop("contentInsetBottom") { view: PGGridView, v: Double? -> view.setInsets(null, v ?: 0.0) }
      Prop("includeLocal") { view: PGGridView, v: Boolean? -> view.setIncludeLocal(v) }
      Prop("backupEnabled") { view: PGGridView, v: Boolean? -> view.setBackupEnabled(v) }
      Prop("showBadges") { view: PGGridView, v: Boolean? -> view.setShowBadges(v) }
      Prop("zoomLevels") { view: PGGridView, v: List<Map<String, Any?>>? -> view.setZoomLevels(v) }
      Prop("zoomLevel") { view: PGGridView, v: Int? -> view.setZoomLevelProp(v) }

      OnViewDestroys { view: PGGridView -> view.destroy() }

      // Listas grandes: converte/parseia fora da main; a view aplica na main.
      AsyncFunction("setCloudItems") { view: PGGridView, items: List<Map<String, Any?>>, replace: Boolean ->
        view.setCloudItemsAsync(items, replace)
        true
      }

      AsyncFunction("setStatuses") { view: PGGridView, payload: Map<String, Any?>, replace: Boolean ->
        view.setStatuses(payload, replace)
        true
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("getItems") { view: PGGridView, from: Int, count: Int ->
        view.getItems(from, count)
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("indexOfKey") { view: PGGridView, key: String ->
        view.indexOfKey(key)
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("frameForKey") { view: PGGridView, key: String ->
        view.frameForKey(key)
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("scrollToKey") { view: PGGridView, key: String, animated: Boolean ->
        view.scrollToKey(key, animated)
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("scrollToTop") { view: PGGridView, animated: Boolean ->
        view.scrollToTop(animated)
        true
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("reloadLocal") { view: PGGridView ->
        view.reloadLocal()
        true
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("setSelectionMode") { view: PGGridView, on: Boolean ->
        view.setSelectionMode(on)
        true
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("clearSelection") { view: PGGridView ->
        view.clearSelection()
        true
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("selectAll") { view: PGGridView ->
        view.selectAll()
        true
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("getSelection") { view: PGGridView ->
        view.getSelection()
      }.runOnQueue(Queues.MAIN)
    }
  }
}
