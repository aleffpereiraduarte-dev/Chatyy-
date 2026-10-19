import ExpoModulesCore
import UIKit

// [2026-10-18 chat-info-native] "Dados do contato" / "Dados do grupo" em
// NATIVO. Ver ChatyyChatInfoView.swift, CIModels.swift e
// components/chat/NativeChatInfo.js.
//
// Props:  hero, rows, media, members (contrato em CIModels.swift),
//         colors {pageBg, cardBg, separator, header, text, secondary,
//         tertiary, chipBg, chipFg, destructive, press} (ARGB), dark,
//         labels {photo}, bottomInset, maxContentWidth, authToken
// Events: onRowPress {id}, onToggle {id, value}, onAction {key},
//         onAvatarPress, onMediaPress {key} ("" = ver tudo),
//         onMemberPress {id}, onMembersEnd {count}, onMemberQuery {q},
//         onFirstPaint {count}, onNativeError {message}
// [2026-10-18 elegance] apiVersion 2: prop headerMode ("collapse" = cabeçalho
//         Telegram que encolhe p/ a barra + puxar expande a foto; a view
//         desenha a própria barra com X) + evento onClose. Binário 1 ignora.
// [2026-10-18 profile-native] apiVersion 3: perfil próprio / público em cima
//         da mesma view — hero.photos (carrossel na foto expandida; toque nos
//         terços laterais troca), hero.nav {key,label} (botão de texto na
//         barra → onAction {key}), hero.back (seta à esquerda no lugar do X),
//         onAvatarPress {index} (foto visível do carrossel).
// [2026-10-18 profile-edit-native] apiVersion 4: prop `edit` + evento onEdit
//         ("Editar perfil" nativo estilo Telegram por cima da mesma view;
//         contrato em CIEditPanel.swift).
// [2026-10-19 profile-grid-native] apiVersion 5: hero.cover {u,a} (capa atrás
//         do avatar com degradê), hero.ring ("unseen"|"seen"), linhas k "grid"
//         (grade 3 colunas de `media` + evento onMediaEnd {count}) e k "hl"
//         (faixa de destaques da prop `highlights` [{key,u,a,title}] →
//         onMediaPress {key "hl|<key>" / "hl!|<key>" no toque longo}).
public class ChatyyChatInfoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyChatInfo")

    Function("apiVersion") { () -> Int in
      return 5
    }

    View(ChatyyChatInfoView.self) {
      Events(
        "onRowPress",
        "onToggle",
        "onAction",
        "onAvatarPress",
        "onMediaPress",
        "onMemberPress",
        "onMembersEnd",
        "onMemberQuery",
        "onFirstPaint",
        "onNativeError",
        "onClose",
        "onEdit",
        "onMediaEnd"
      )

      Prop("hero") { (view: ChatyyChatInfoView, value: [String: Any]?) in
        view.setHero(value)
      }
      Prop("rows") { (view: ChatyyChatInfoView, value: [[String: Any]]?) in
        view.setRows(value)
      }
      Prop("media") { (view: ChatyyChatInfoView, value: [[String: Any]]?) in
        view.setMedia(value)
      }
      Prop("members") { (view: ChatyyChatInfoView, value: [String: Any]?) in
        view.setMembers(value)
      }
      Prop("highlights") { (view: ChatyyChatInfoView, value: [[String: Any]]?) in
        view.setHighlights(value)
      }
      Prop("colors") { (view: ChatyyChatInfoView, value: [String: Any]?) in
        view.setColors(value)
      }
      Prop("dark") { (view: ChatyyChatInfoView, value: Bool?) in
        view.setDark(value ?? false)
      }
      Prop("labels") { (view: ChatyyChatInfoView, value: [String: Any]?) in
        view.setLabels(value)
      }
      Prop("bottomInset") { (view: ChatyyChatInfoView, value: Double?) in
        view.setBottomInset(CGFloat(value ?? 0))
      }
      Prop("maxContentWidth") { (view: ChatyyChatInfoView, value: Double?) in
        view.setMaxContentWidth(CGFloat(value ?? 0))
      }
      Prop("headerMode") { (view: ChatyyChatInfoView, value: String?) in
        view.setHeaderMode(value ?? "")
      }
      Prop("edit") { (view: ChatyyChatInfoView, value: [String: Any]?) in
        view.setEdit(value)
      }
      Prop("authToken") { (_: ChatyyChatInfoView, value: String?) in
        if let v = value, !v.isEmpty { CLImageLoader.shared.authToken = v }
      }

      OnViewDidUpdateProps { (view: ChatyyChatInfoView) in
        view.commitProps()
      }
    }
  }
}
