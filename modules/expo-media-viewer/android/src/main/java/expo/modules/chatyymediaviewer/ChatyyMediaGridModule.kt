package expo.modules.chatyymediaviewer

import android.view.View
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// [2026-10-16 native-media-grid] Grade nativa genérica (view `ChatyyMediaGrid`).
// Mesmo contrato do iOS (ios/ChatyyMediaGridModule.swift). Ver MGGridView.kt.
class ChatyyMediaGridModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyMediaGrid")

    // 1 = [2026-10-16] itens por URL, seções por mês, selos, 1º quadro de vídeo,
    //     seleção nativa, filhos RN cabeçalho/rodapé.
    Function("apiVersion") { 1 }

    View(MGGridView::class) {
      Events("onItemPress", "onItemLongPress", "onSelectionChange", "onEndReached", "onScrollBegin", "onReady")

      Prop("items") { view: MGGridView, v: List<Map<String, Any?>>? -> view.setItems(v) }
      Prop("columns") { view: MGGridView, v: Int? -> view.setColumns(v) }
      Prop("spacing") { view: MGGridView, v: Double? -> view.setSpacing(v) }
      Prop("radius") { view: MGGridView, v: Double? -> view.setRadius(v) }
      Prop("sections") { view: MGGridView, v: Boolean? -> view.setSections(v) }
      Prop("locale") { view: MGGridView, v: String? -> view.setLocale(v) }
      Prop("maxContentWidth") { view: MGGridView, v: Double? -> view.setMaxContentWidth(v) }
      Prop("contentInsetBottom") { view: MGGridView, v: Double? -> view.setContentInsetBottom(v) }
      Prop("theme") { view: MGGridView, v: Map<String, Any?>? -> view.setTheme(v) }

      OnViewDestroys { view: MGGridView -> view.destroy() }

      // Lista via função (não prop): o Fabric reaplica TODAS as props a cada
      // render do pai (perfil re-renderiza muito) → serializar 300 itens toda vez.
      AsyncFunction("setItems") { view: MGGridView, items: List<Map<String, Any?>> ->
        view.setItems(items)
        true
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("setSelectionMode") { view: MGGridView, on: Boolean ->
        view.setSelectionMode(on)
        true
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("beginSelection") { view: MGGridView, key: String? ->
        view.beginSelection(key)
        true
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("clearSelection") { view: MGGridView ->
        view.clearSelection()
        true
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("getSelection") { view: MGGridView ->
        view.getSelection()
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("scrollToTop") { view: MGGridView, animated: Boolean ->
        view.scrollToTop(animated)
        true
      }.runOnQueue(Queues.MAIN)

      GroupView<MGGridView> {
        AddChildView { parent, child: View, index -> parent.addRnChild(child, index) }
        GetChildCount { parent -> parent.rnChildCount() }
        GetChildViewAt { parent, index -> parent.rnChildAt(index) }
        RemoveChildView { parent, child: View -> parent.removeRnChild(child) }
        RemoveChildViewAt { parent, index -> parent.removeRnChildAt(index) }
      }
    }
  }
}
