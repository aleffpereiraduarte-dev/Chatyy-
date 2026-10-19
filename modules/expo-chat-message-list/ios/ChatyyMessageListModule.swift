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
    // 5 = [native-media-dl] download nativo com anel de progresso (row.media/au/
    //     file/album[].dl {u,k,a,sz,alt,js}), configureTransfers (módulo),
    //     setTransfers (view), evento onMediaTransfer, onRowPress part 'xfer'.
    // 6 = [wave13-C a11y] linha ax (rótulo do leitor de tela) + aa (máscara de
    //     ações 1 responder/2 reagir/4 copiar/8 encaminhar/16 mais) + prop a11y
    //     (nomes das ações + hint). Ações: responder → onSwipeReply dir 'reply';
    //     reagir/mais → onRowLongPress (a11y: id); copiar/encaminhar → onRowPress
    //     part 'a11y' url id. Dynamic Type/"Escurecer cores" ao vivo.
    // 7 = [motion-conv] prop `motion` {i, e, t, r, s, a} (0/1; ausente = ligado):
    //     entrada com mola enviada/recebida, apagar/colapsar/altura com mola,
    //     ✓→✓✓→lida animado, pop+faíscas de reação alheia, pílula de data com
    //     mola, onda do áudio contínua.
    // 8 = [voz-wa] setAudioState {rl: "1,5×"} → pílula de velocidade à direita da
    //     onda (nota tocando/pausada); toque → onRowPress part 'action' url 'au:rate'.
    // 9 = [2026-10-18 vthumb] media.vf (vídeo sem pôster) → 1º frame extraído no
    //     nativo (CMLVideoFrameLoader: AVAssetImageGenerator + cache memória/disco).
    // 10 = [2026-10-18 tg-look] prop `look` {tg: 0/1} → rabicho Telegram na última
    //     bolha do grupo (embaixo), cantos do grupo justos, mídia rente à bolha.
    // 11 = [2026-10-18 tg-list] setSearch {term,ids,cur,scroll} (realce na bolha) ·
    //     prop dragSelect (arrastar na calha no modo seleção → onSelectRange) ·
    //     prop overlay (↓/@/♥ nativos → onOverlayPress) · prepareSend(rect) (morph do
    //     envio) · motion.c (relógio do pendente gira após 300 ms) · prop quickReact
    //     (toque duplo em texto/figurinha → pop + onQuickReact).
    // 12 = [2026-10-19 tg-style] prop `tgStyle` {on: 0/1} → 2/8 pt entre bolhas/grupos,
    //     pílulas de data/sistema/flutuante em cápsula com desfoque (12 pt), hora e
    //     duração sobre mídia com desfoque, nota de voz com botão cheio, "Encaminhada"
    //     13 regular, citação com cantos 6, reações sem sombra.
    Function("apiVersion") { () -> Int in
      #if canImport(ExpoChatStore)
      return 12
      #else
      return 3
      #endif
    }

    // [native-media-dl] pasta do cache do mediaCache (JS) + matriz de auto-download
    // + economia de dados + modelo "{a} de {b}" traduzido.
    AsyncFunction("configureTransfers") { (cfg: [String: Any]) in
      CMLTransfers.shared.configure(cfg)
    }.runOnQueue(.main)

    View(CMLListView.self) {
      Events("onReady", "onNativeError", "onRowPress", "onRowLongPress", "onSwipeReply", "onLoadOlder", "onScrollState", "onDragState", "onVisible", "onMenuAction", "onReact", "onMenuDismiss", "onStore", "onMediaTransfer", "onSelectRange", "onOverlayPress", "onQuickReact")

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
      Prop("a11y") { (view: CMLListView, value: [String: Any]?) in
        view.setA11yLabels(value)
      }
      // [motion-conv] kill switches de movimento (apiVersion 7)
      Prop("motion") { (view: CMLListView, value: [String: Any]?) in
        view.setMotion(value)
      }
      // [2026-10-18 tg-look] visual Telegram (apiVersion 10)
      Prop("look") { (view: CMLListView, value: [String: Any]?) in
        view.setLook(value)
      }
      // [2026-10-18 tg-list] apiVersion 11
      Prop("dragSelect") { (view: CMLListView, value: Bool?) in
        view.setDragSelect(value ?? false)
      }
      Prop("overlay") { (view: CMLListView, value: [String: Any]?) in
        view.setOverlay(value)
      }
      Prop("quickReact") { (view: CMLListView, value: [String: Any]?) in
        view.setQuickReact(value)
      }
      // [2026-10-19 tg-style] apiVersion 12
      Prop("tgStyle") { (view: CMLListView, value: [String: Any]?) in
        view.setTgStyle(value)
      }

      AsyncFunction("setSearch") { (view: CMLListView, payload: [String: Any]) in
        view.setSearch(payload)
      }.runOnQueue(.main)

      AsyncFunction("prepareSend") { (view: CMLListView, rect: [String: Any]) in
        view.prepareSend(rect)
      }.runOnQueue(.main)

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

      // [native-media-dl] progresso de transferências feitas pelo JS (download do
      // mediaCache / upload) → o mesmo anel. [{k, st: q|p|d|f|c, p, t, l}]
      AsyncFunction("setTransfers") { (view: CMLListView, list: [Any]) in
        view.setTransfers(list.compactMap { $0 as? [String: Any] })
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
