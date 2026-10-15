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

// ── [2026-10-15 native-pins] Fileira nativa de FIXADAS ───────────────────────
// View `ChatyyPinnedStrip` (módulo próprio no mesmo pacote; binário antigo não
// tem → null e o ChatListTab mantém a fileira JS).
//   props  items [linhas do nativeAdapter.buildRow + smart], dark, labels,
//          folders, peek, avatarSize, reorderMode, selectionMode, menuEnabled,
//          authToken
//   events onPinPress {id}, onPinPressIn {id}, onPinAction {id, action, …},
//          onPinLongPress {id}, onPeekRequest {id}, onPeekOpen {id},
//          onReorder {ids}, onReorderDone, onNativeError {message}
export const PINNED_STRIP_VIEW_NAME = 'ChatyyPinnedStrip';

let _pinsChecked = false;
let _pinsView: any = null;

function _probePins() {
  if (_pinsChecked) return;
  _pinsChecked = true;
  if (Platform.OS === 'web') return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const core = require('expo-modules-core');
    const mod = typeof core.requireOptionalNativeModule === 'function'
      ? core.requireOptionalNativeModule(PINNED_STRIP_VIEW_NAME)
      : null;
    if (!mod) return;
    let api = 0;
    try { api = typeof mod.apiVersion === 'function' ? Number(mod.apiVersion()) || 0 : 0; } catch { api = 0; }
    if (api < 1) return;
    const req = core.requireNativeViewManager || core.requireNativeView;
    if (typeof req === 'function') _pinsView = req(PINNED_STRIP_VIEW_NAME);
  } catch {
    _pinsView = null;
  }
}

/** View nativa da fileira de fixados, ou null (binário sem o módulo / web). */
export function getNativePinnedStripView(): any {
  _probePins();
  return _pinsView;
}

export function isPinnedStripAvailable(): boolean {
  return !!getNativePinnedStripView();
}

// ── [2026-10-15 native-lists] Outras listas grandes em NATIVO ────────────────
// Mesmo pacote (reaproveita avatar/imagem/tema/glifos), um módulo por view.
// Binário sem a view → null e a tela mantém a FlashList/FlatList JS.
//   ChatyyEmailList    — caixa de entrada do e-mail (app/inbox.js)
//   ChatyyCallList     — aba Ligações (components/ChatCallsTab.js)
//   ChatyyStatusList   — aba Status (components/ChatStatusTab.js)
//   ChatyyContactList  — contatos / nova conversa (app/contacts.js, app/chat-new.js)
export const EMAIL_LIST_VIEW_NAME = 'ChatyyEmailList';
export const CALL_LIST_VIEW_NAME = 'ChatyyCallList';
export const STATUS_LIST_VIEW_NAME = 'ChatyyStatusList';
export const CONTACT_LIST_VIEW_NAME = 'ChatyyContactList';
// [2026-10-15 settings-native] Raiz das Configurações (app/settings.js via
// components/settings/NativeSettingsList.js).
export const SETTINGS_LIST_VIEW_NAME = 'ChatyySettingsList';

const _extraViews: Record<string, any> = {};

function _probeNamed(name: string): any {
  if (Object.prototype.hasOwnProperty.call(_extraViews, name)) return _extraViews[name];
  _extraViews[name] = null;
  if (Platform.OS === 'web') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const core = require('expo-modules-core');
    const mod = typeof core.requireOptionalNativeModule === 'function'
      ? core.requireOptionalNativeModule(name)
      : null;
    if (!mod) return null;
    let api = 0;
    try { api = typeof mod.apiVersion === 'function' ? Number(mod.apiVersion()) || 0 : 0; } catch { api = 0; }
    if (api < 1) return null;
    const req = core.requireNativeViewManager || core.requireNativeView;
    if (typeof req === 'function') _extraViews[name] = req(name);
  } catch {
    _extraViews[name] = null;
  }
  return _extraViews[name];
}

export function getNativeEmailListView(): any { return _probeNamed(EMAIL_LIST_VIEW_NAME); }
export function isEmailListAvailable(): boolean { return !!getNativeEmailListView(); }
export function getNativeCallListView(): any { return _probeNamed(CALL_LIST_VIEW_NAME); }
export function isCallListAvailable(): boolean { return !!getNativeCallListView(); }
export function getNativeStatusListView(): any { return _probeNamed(STATUS_LIST_VIEW_NAME); }
export function isStatusListAvailable(): boolean { return !!getNativeStatusListView(); }
export function getNativeContactListView(): any { return _probeNamed(CONTACT_LIST_VIEW_NAME); }
export function isContactListAvailable(): boolean { return !!getNativeContactListView(); }
export function getNativeSettingsListView(): any { return _probeNamed(SETTINGS_LIST_VIEW_NAME); }
export function isSettingsListAvailable(): boolean { return !!getNativeSettingsListView(); }
