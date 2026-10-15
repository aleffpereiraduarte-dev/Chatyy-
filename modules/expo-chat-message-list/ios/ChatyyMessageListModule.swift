import ExpoModulesCore
import UIKit

// [2026-10-14 native-list] Lista de mensagens nativa da conversa.
// JS: components/chat/nativeThreadList.js (requireNativeView('ChatyyMessageList')).
// apiVersion 1 = applyRows/scrollToLatest/scrollToKey/flashKey/setAudioState.
public class ChatyyMessageListModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyMessageList")

    // 2 = [fase 2] blocos (bl/pre/post), spoiler/emoji/code inline, fail/pin/timer,
    //     lift (anchor no long-press + setLiftedKey), flash pulsando, stickyDate,
    //     seleção animada, nota de vídeo.
    // 3 = [native-ctxmenu] menu de contexto nativo (prop ctxMenu,
    //     showContextMenu/dismissContextMenu, onMenuAction/onReact/onMenuDismiss)
    //     + [hero] onRowPress part 'media' traz frame {x,y,w,h,radius}; mediaFrame(id).
    // 4 = [native-store] prop `store` {a,c,r,n} (foto da conversa lida/gravada
    //     direto no store nativo modules/expo-chat-store) + evento onStore;
    //     onReady traz src 'store'|'js'.
    Function("apiVersion") { () -> Int in
      #if canImport(ExpoChatStore)
      return 4
      #else
      return 3
      #endif
    }

    View(CMLListView.self) {
      Events("onReady", "onNativeError", "onRowPress", "onRowLongPress", "onSwipeReply", "onLoadOlder", "onScrollState", "onDragState", "onVisible", "onMenuAction", "onReact", "onMenuDismiss", "onStore")

      Prop("theme") { (view: CMLListView, value: [String: Any]?) in
        view.setTheme(value ?? [:])
      }
      Prop("fontSize") { (view: CMLListView, value: Double?) in
        view.setFontSize(value)
      }
      Prop("lineHeight") { (view: CMLListView, value: Double?) in
        view.setLineHeight(value)
      }
      Prop("bubbleRadius") { (view: CMLListView, value: Double?) in
        view.setRadius(value)
      }
      Prop("dark") { (view: CMLListView, value: Bool?) in
        // cores vêm prontas em `theme`; aqui só o tema do menu de contexto nativo
        view.setDarkHint(value)
      }
      Prop("keyboardDismissMode") { (view: CMLListView, value: String?) in
        view.setKeyboardDismissMode(value)
      }
      Prop("bottomInset") { (view: CMLListView, value: Double?) in
        view.setInsets(bottom: value, top: nil)
      }
      Prop("topInset") { (view: CMLListView, value: Double?) in
        view.setInsets(bottom: nil, top: value)
      }
      Prop("stickyDate") { (view: CMLListView, value: [String: Any]?) in
        view.setStickyDate(value)
      }
      Prop("ctxMenu") { (view: CMLListView, value: Bool?) in
        view.setCtxMenu(value ?? false)
      }
      Prop("store") { (view: CMLListView, value: [String: Any]?) in
        view.setStore(value)
      }

      AsyncFunction("applyRows") { (view: CMLListView, payload: [String: Any]) in
        view.applyRows(payload)
      }.runOnQueue(.main)

      AsyncFunction("scrollToLatest") { (view: CMLListView, animated: Bool) in
        view.scrollToLatest(animated: animated)
      }.runOnQueue(.main)

      AsyncFunction("scrollToKey") { (view: CMLListView, key: String, viewPosition: Double, animated: Bool) -> Bool in
        return view.scrollToKey(key, viewPosition: viewPosition, animated: animated)
      }.runOnQueue(.main)

      AsyncFunction("flashKey") { (view: CMLListView, key: String) in
        view.flashKey(key)
      }.runOnQueue(.main)

      AsyncFunction("setAudioState") { (view: CMLListView, state: [String: Any]) in
        view.setAudioState(state)
      }.runOnQueue(.main)

      AsyncFunction("setLiftedKey") { (view: CMLListView, key: String) in
        view.setLiftedKey(key)
      }.runOnQueue(.main)

      AsyncFunction("showContextMenu") { (view: CMLListView, payload: [String: Any]) -> Bool in
        return view.showContextMenu(payload)
      }.runOnQueue(.main)

      AsyncFunction("dismissContextMenu") { (view: CMLListView) in
        view.dismissContextMenu()
      }.runOnQueue(.main)

      // [reply-v2] "Citar trecho" nativo → resolve com o trecho ("" = cancelou)
      AsyncFunction("showQuotePicker") { (view: CMLListView, payload: [String: Any], promise: Promise) in
        guard let win = view.window else { promise.resolve(""); return }
        CMLQuotePicker.present(in: win, payload: payload) { text in promise.resolve(text) }
      }.runOnQueue(.main)

      // [hero] frame atual da miniatura de uma mensagem (null = fora da tela)
      AsyncFunction("mediaFrame") { (view: CMLListView, messageId: String) -> [String: Any]? in
        return view.mediaFrame(messageId)
      }.runOnQueue(.main)
    }
  }
}
