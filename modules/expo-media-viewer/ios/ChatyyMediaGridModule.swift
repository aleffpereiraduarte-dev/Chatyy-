import ExpoModulesCore
import UIKit

// [2026-10-16 native-media-grid] Grade nativa genérica (view `ChatyyMediaGrid`).
// Ver MGGridView.swift. JS: components/media/NativeMediaGrid.js.
public class ChatyyMediaGridModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyMediaGrid")

    // 1 = [2026-10-16] itens por URL, seções por mês, selos, 1º quadro de vídeo,
    //     seleção nativa, filhos RN cabeçalho/rodapé.
    // 2 = [2026-10-18 tg-viewer] frameOfKey (viewer volta voando p/ a célula).
    Function("apiVersion") { () -> Int in
      return 2
    }

    View(MGGridView.self) {
      Events("onItemPress", "onItemLongPress", "onSelectionChange", "onEndReached", "onScrollBegin", "onReady")

      Prop("items") { (view: MGGridView, v: [[String: Any]]?) in view.setItems(v) }
      Prop("columns") { (view: MGGridView, v: Int?) in view.setColumns(v) }
      Prop("spacing") { (view: MGGridView, v: Double?) in view.setSpacing(v) }
      Prop("radius") { (view: MGGridView, v: Double?) in view.setRadius(v) }
      Prop("sections") { (view: MGGridView, v: Bool?) in view.setSections(v) }
      Prop("locale") { (view: MGGridView, v: String?) in view.setLocale(v) }
      Prop("maxContentWidth") { (view: MGGridView, v: Double?) in view.setMaxContentWidth(v) }
      Prop("contentInsetBottom") { (view: MGGridView, v: Double?) in view.setContentInsetBottom(v) }
      Prop("theme") { (view: MGGridView, v: [String: Any]?) in view.setTheme(v) }

      // Lista via função (não prop): o Fabric reaplica TODAS as props a cada
      // render do pai (perfil re-renderiza muito) → serializar 300 itens toda vez.
      AsyncFunction("setItems") { (view: MGGridView, items: [[String: Any]]) in
        view.setItems(items)
      }.runOnQueue(.main)

      AsyncFunction("setSelectionMode") { (view: MGGridView, on: Bool) in
        view.setSelectionMode(on)
      }.runOnQueue(.main)

      AsyncFunction("beginSelection") { (view: MGGridView, key: String?) in
        view.beginSelection(with: key)
      }.runOnQueue(.main)

      AsyncFunction("clearSelection") { (view: MGGridView) in
        view.clearSelection()
      }.runOnQueue(.main)

      AsyncFunction("getSelection") { (view: MGGridView) -> [String] in
        return view.getSelection()
      }.runOnQueue(.main)

      // {} = não achou / fora da janela.
      AsyncFunction("frameOfKey") { (view: MGGridView, key: String, reveal: Bool) -> [String: Double] in
        return view.frameOfKey(key, reveal: reveal) ?? [:]
      }.runOnQueue(.main)

      AsyncFunction("scrollToTop") { (view: MGGridView, animated: Bool) in
        view.scrollToTop(animated)
      }.runOnQueue(.main)
    }
  }
}
