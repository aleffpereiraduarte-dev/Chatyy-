import ExpoModulesCore
import UIKit

// [2026-10-15 native-group-create] Fileira de SELECIONADOS (chips) do Novo
// grupo, estilo WhatsApp: avatar + "x" + primeiro nome, rolando na horizontal;
// entra com mola, sai encolhendo; toque remove (o JS decide).
// Ver ChatyyChipStripView.swift e components/groupCreate/NativeChipStrip.js.
//
// Props:  items [{id, t, tiles}], colors {bg, text, badgeBg, badgeFg} (ARGB),
//         dark, authToken
// Events: onChipPress {id}, onNativeError {message}
public class ChatyyChipStripModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyChipStrip")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(ChatyyChipStripView.self) {
      Events("onChipPress", "onNativeError")

      Prop("items") { (view: ChatyyChipStripView, value: [[String: Any]]?) in
        view.setItems(value ?? [])
      }
      Prop("colors") { (view: ChatyyChipStripView, value: [String: Any]?) in
        view.setColors(value)
      }
      Prop("dark") { (view: ChatyyChipStripView, value: Bool?) in
        view.setDark(value ?? false)
      }
      Prop("authToken") { (_: ChatyyChipStripView, value: String?) in
        if let v = value, !v.isEmpty { CLImageLoader.shared.authToken = v }
      }

      OnViewDidUpdateProps { (view: ChatyyChipStripView) in
        view.commitProps()
      }
    }
  }
}
