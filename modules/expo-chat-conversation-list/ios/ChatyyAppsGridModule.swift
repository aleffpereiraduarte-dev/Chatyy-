import ExpoModulesCore
import UIKit

// [2026-10-18 native-apps-grid] Painel "Apps" (aba Apps do /chat) em NATIVO:
// UICollectionView compositional (cartão da Bia, faixa "Recentes" com rolagem
// ortogonal, grade 4 colunas por seção) + diffable data source, busca ao vivo
// (sem acento/caixa), badges, modo editar (segurar) com tremor, fixar/tirar e
// reordenar fixados arrastando. O JS continua dono das rotas e do MMKV.
// Ver ChatyyAppsGridView.swift e components/apps/NativeAppsGrid.js.
//
// Props:  sections [{key, title, items:[{id, t, n, sf?, feat?}]}], recent [id],
//         pinned [id], badges {id: n}, labels {search, recent, pinned, noResults,
//         pin, unpin, clear, badgeNew, biaHello, biaTip, aiBadge, voice},
//         dark, editing, bottomInset, resetSeq, searchEnabled
// Events: onAppPress {id, voice?}, onEditingChange {editing}, onPinnedChange {ids},
//         onQueryChange {q}, onContentHeight {height}, onPullDismiss,
//         onNativeError {message}
public class ChatyyAppsGridModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyAppsGrid")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(ChatyyAppsGridView.self) {
      Events("onAppPress", "onEditingChange", "onPinnedChange", "onQueryChange",
             "onContentHeight", "onPullDismiss", "onNativeError")

      Prop("sections") { (view: ChatyyAppsGridView, value: [[String: Any]]?) in
        view.setSections(value ?? [])
      }
      Prop("recent") { (view: ChatyyAppsGridView, value: [String]?) in
        view.setRecent(value ?? [])
      }
      Prop("pinned") { (view: ChatyyAppsGridView, value: [String]?) in
        view.setPinned(value ?? [])
      }
      Prop("badges") { (view: ChatyyAppsGridView, value: [String: Any]?) in
        view.setBadges(value ?? [:])
      }
      Prop("labels") { (view: ChatyyAppsGridView, value: [String: Any]?) in
        view.setLabels(value ?? [:])
      }
      Prop("dark") { (view: ChatyyAppsGridView, value: Bool?) in
        view.setDark(value ?? false)
      }
      Prop("editing") { (view: ChatyyAppsGridView, value: Bool?) in
        view.setEditing(value ?? false)
      }
      Prop("bottomInset") { (view: ChatyyAppsGridView, value: Double?) in
        view.setBottomInset(value ?? 0)
      }
      Prop("resetSeq") { (view: ChatyyAppsGridView, value: Double?) in
        let d = value ?? 0
        view.setResetSeq(d.isFinite ? Int(max(-1e9, min(1e9, d))) : 0)
      }
      Prop("searchEnabled") { (view: ChatyyAppsGridView, value: Bool?) in
        view.setSearchEnabled(value ?? true)
      }

      OnViewDidUpdateProps { (view: ChatyyAppsGridView) in
        view.commitProps()
      }
    }
  }
}
