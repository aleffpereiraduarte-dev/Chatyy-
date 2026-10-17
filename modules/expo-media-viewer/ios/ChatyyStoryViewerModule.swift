import ExpoModulesCore
import UIKit

// [2026-10-15 native-story] Visualizador de STATUS nativo. Mesmo pod do
// ChatyyMediaViewer (reaproveita MVImageLoader/MVAudio/MVPlayerView).
// JS: modules/expo-media-viewer/story.ts → ChatyyStoryViewer.open({...}).
// Eventos (todos com `session`): onItemShown, onItemCompleted, onGroupChange,
// onReply, onReact, onOpenViewers, onCloseViewers, onViewerPress, onMenu,
// onLink, onSticker (apiVersion 2), onNeedMore, onClose.
public class ChatyyStoryViewerModule: Module {
  private weak var current: StoryViewerController?
  private var session: Int = 0

  public func definition() -> ModuleDefinition {
    Name("ChatyyStoryViewer")

    Events(
      "onItemShown", "onItemCompleted", "onGroupChange", "onReply", "onReact",
      "onOpenViewers", "onCloseViewers", "onViewerPress", "onMenu", "onLink",
      "onSticker", "onNeedMore", "onClose"
    )

    // 2 = blocos (figurinhas/texto/GIF/enquete/pergunta…), voz, boomerang,
    // animação de texto, duplo toque, menu por item, updateItem caption/overlay.
    // 3 = `originRect` (abre do anel do avatar e volta para ele) [2026-10-16 motion]
    // 4 = reações livres [2026-10-17 status-reacoes]: `reactionHold` (segurar o
    //     coração abre a bolha), `reactionPicker` ("+" com a grade de emojis),
    //     setViewers rows[].emoji (emoji real na lista).
    Function("apiVersion") { () -> Int in
      return 4
    }

    AsyncFunction("open") { (options: [String: Any]) -> Int in
      let rawGroups = options["groups"] as? [Any] ?? []
      let groups = rawGroups.compactMap { ($0 as? [String: Any]).map { SVGroup(dict: $0) } }.filter { !$0.items.isEmpty }
      guard !groups.isEmpty else { return 0 }
      if let old = self.current {
        old.closeSilently()
        self.current = nil
      }
      guard let presenter = self.appContext?.utilities?.currentViewController() else { return 0 }

      self.session += 1
      let sid = self.session
      let labels = SVLabels(options["labels"] as? [String: Any] ?? [:])
      var reactions: [SVReaction] = ((options["reactions"] as? [Any]) ?? []).compactMap { raw in
        guard let m = raw as? [String: Any], let e = m["emoji"] as? String, !e.isEmpty else { return nil }
        return SVReaction(emoji: e, kind: (m["kind"] as? String) ?? "heart")
      }
      if reactions.isEmpty {
        reactions = [SVReaction(emoji: "\u{2764}\u{FE0F}", kind: "heart")]
      }
      let startGroup = max(0, min(groups.count - 1, MVItem.intValue(options["startGroup"]) ?? 0))
      if let si = MVItem.intValue(options["startItem"]), si >= 0 {
        let g = groups[startGroup]
        g.index = max(0, min(g.items.count - 1, si))
      }
      let vc = StoryViewerController(
        groups: groups,
        startGroup: startGroup,
        labels: labels,
        reactions: reactions,
        cube: ((options["transition"] as? String) ?? "cube") != "slide",
        hasMoreNext: (options["hasMoreNext"] as? Bool) ?? false,
        hasMorePrev: (options["hasMorePrev"] as? Bool) ?? false
      )
      // [2026-10-16 motion] Frame do anel tocado (coordenadas de janela, pt).
      if MVMotion.storyOrigin && !MVMotion.reduceMotion, let r = MVItem.rectValue(options["originRect"]) {
        vc.setOrigin(r)
      }
      // [2026-10-17 status-reacoes] JS controla (kill switch __chatyy_story_reactions)
      if let pk = options["reactionPicker"] { SVEmojiStore.update(pk) }
      vc.reactionHold = (options["reactionHold"] as? Bool) ?? false
      vc.emit = { [weak self] name, body in
        var b = body
        b["session"] = sid
        self?.sendEvent(name, b as [String: Any?])
      }
      vc.onFinished = { [weak self, weak vc] in
        guard let self = self else { return }
        if self.current == nil || self.current === vc { self.current = nil }
      }
      self.current = vc
      // [2026-10-15 screen-protect-all] protege a tela nova já (camada segura; expo-chat-privacy)
      presenter.present(vc, animated: !vc.hasOrigin, completion: {
        NotificationCenter.default.post(name: Notification.Name("ChatyyScreenProtectRescan"), object: nil)
      })
      NotificationCenter.default.post(name: Notification.Name("ChatyyScreenProtectRescan"), object: nil)
      return sid
    }.runOnQueue(.main)

    AsyncFunction("close") { () -> Bool in
      guard let vc = self.current else { return false }
      self.current = nil
      vc.closeFromJS()
      return true
    }.runOnQueue(.main)

    AsyncFunction("pause") { () -> Bool in
      guard let vc = self.current else { return false }
      vc.setPausedFromJS(true)
      return true
    }.runOnQueue(.main)

    AsyncFunction("resume") { () -> Bool in
      guard let vc = self.current else { return false }
      vc.setPausedFromJS(false)
      return true
    }.runOnQueue(.main)

    // patch: { viewed?, viewsCount?, myReaction?, caption?, translated?, overlay?:{id,counts,myVote,value,avg} }
    AsyncFunction("updateItem") { (id: String, patch: [String: Any]) -> Bool in
      guard let vc = self.current else { return false }
      vc.updateItem(id: id, patch: patch)
      return true
    }.runOnQueue(.main)

    AsyncFunction("removeItem") { (id: String) -> Bool in
      guard let vc = self.current else { return false }
      vc.removeItem(id: id)
      return true
    }.runOnQueue(.main)

    // direction: 'next' | 'prev'
    AsyncFunction("appendGroup") { (group: [String: Any], direction: String) -> Bool in
      guard let vc = self.current else { return false }
      vc.appendGroup(SVGroup(dict: group), direction: direction == "prev" ? "prev" : "next")
      return true
    }.runOnQueue(.main)

    AsyncFunction("setHasMore") { (next: Bool, prev: Bool) -> Bool in
      guard let vc = self.current else { return false }
      vc.setHasMore(next: next, prev: prev)
      return true
    }.runOnQueue(.main)

    // rows: [{ email, name, avatar, time, reaction(kind), emoji (v4) }]
    AsyncFunction("setViewers") { (id: String, rows: [[String: Any]], loading: Bool) -> Bool in
      guard let vc = self.current else { return false }
      vc.setViewers(id: id, rows: rows, loading: loading)
      return true
    }.runOnQueue(.main)

    AsyncFunction("showToast") { (text: String) -> Bool in
      guard let vc = self.current else { return false }
      vc.showToast(text)
      return true
    }.runOnQueue(.main)
  }
}
