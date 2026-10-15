// modules/expo-chat-conversation-list — [2026-10-14 native-home]
//
// Lista de conversas da home em NATIVO (Telegram/WhatsApp):
//   iOS: UICollectionView (lista compositional + diffable data source),
//        UISwipeActionsConfiguration, UIContextMenuConfiguration com prévia,
//        anel de status em CoreGraphics, avatar com cache em disco.
//   Android: RecyclerView + DiffUtil (payload), ItemTouchHelper, PopupMenu,
//        Glide (já no binário).
//
// Binário sem o módulo (build antigo, Expo Go, web) → isAvailable() === false
// e o ChatListTab mantém o FlashList JS. Nada é sondado no import.
//
// View `ChatyyConversationList`:
//   props  rowsPatch {seq, base, reset?, upsert?, remove?, order?} (ver
//          components/chatlist/nativeAdapter.js), dark, selectionMode, labels,
//          authToken, headerHeight, footerHeight, bottomInset, collapseOffset,
//          peek {id, items:[{m, t, h, s}]}, swipeEnabled, menuEnabled,
//          scrollToTopSeq
//   events onRowPress {id}, onRowPressIn {id}, onAvatarPress {id},
//          onRowAction {id, action, source}, onLongPress {id},
//          onPeekRequest {id}, onPeekOpen {id}, onCollapsedChange {collapsed},
//          onEndReached, onResync {seq}, onFirstPaint {count},
//          onNativeError {message}
//   children: [0] header (rola junto, acima da 1ª linha), [1] rodapé.

import { Platform } from 'react-native';

export const NATIVE_VIEW_NAME = 'ChatyyConversationList';

let _checked = false;
let _view: any = null;
let _api = 0;

function _probe() {
  if (_checked) return;
  _checked = true;
  if (Platform.OS === 'web') return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const core = require('expo-modules-core');
    const mod = typeof core.requireOptionalNativeModule === 'function'
      ? core.requireOptionalNativeModule(NATIVE_VIEW_NAME)
      : null;
    if (!mod) return;
    try { _api = typeof mod.apiVersion === 'function' ? Number(mod.apiVersion()) || 0 : 0; } catch { _api = 0; }
    if (_api < 1) return;
    const req = core.requireNativeViewManager || core.requireNativeView;
    if (typeof req === 'function') {
      _view = req(NATIVE_VIEW_NAME);
    }
  } catch {
    _view = null;
  }
}

/** Componente nativo (host) ou null quando o binário não tem o módulo. */
export function getNativeConversationListView(): any {
  _probe();
  return _view;
}

export function isAvailable(): boolean {
  return !!getNativeConversationListView();
}

export function apiVersion(): number {
  _probe();
  return _api;
}
