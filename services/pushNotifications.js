import { Platform, AppState } from 'react-native';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { getJSON, setJSON } from './mmkv';
import { isOnline, queueOfflineAction } from './offlineCache';

let Notifications = null;
let Device = null;

// Foreground notification callback — set by _layout to show in-app toast
let _onForegroundNotification = null;
// [2026-10-05 WhatsApp-parity] Toast dedupe. The same chat message can reach
// the foreground app twice within ~1s (FCM push handler + WS new_message →
// _triggerForegroundToast, or handleNotification + receivedSub on some
// platforms) and used to pop two identical toasts. Key by message_id (fallback:
// conversation_id+body) inside a 15s window; the first one wins.
const _toastSeen = new Map();
function _toastDedupeKey(notif) {
  try {
    const d = notif?.data || {};
    if (d.message_id) return 'm:' + String(d.message_id);
    if (d.conversation_id) return 'c:' + String(d.conversation_id) + ':' + String(notif?.body || '').slice(0, 80);
  } catch {}
  return null;
}
function _toastIsDuplicate(notif) {
  const key = _toastDedupeKey(notif);
  if (!key) return false;
  const now = Date.now();
  const prev = _toastSeen.get(key);
  if (prev && now - prev < 15000) return true;
  _toastSeen.set(key, now);
  if (_toastSeen.size > 200) {
    for (const [k, t] of _toastSeen) { if (now - t > 15000) _toastSeen.delete(k); }
  }
  return false;
}
export function setForegroundNotificationHandler(handler) {
  _onForegroundNotification = (typeof handler === 'function')
    ? (notif) => {
        try {
          // Never toast the conversation the user is looking at (the thread
          // itself renders the bubble) and never toast a duplicate.
          const cid = notif?.data?.conversation_id;
          if (cid != null && _activeConversationId != null && String(cid) === String(_activeConversationId)) return;
          if (_toastIsDuplicate(notif)) return;
        } catch {}
        handler(notif);
      }
    : handler;
}

// Master "push enabled" switch mirror (ProfileSettingsSheet → "Notificações
// push"). When the user turns push OFF we unregister the device token
// server-side (so the backend stops delivering), but a push already in
// flight — or one from another account/session on the same device — can
// still land. This in-memory flag lets the notification handler fully
// silence content-type notifications locally as a belt-and-suspenders gate.
// Default TRUE so a cold start before the toggle hydrates never silently
// drops notifications; ProfileSettingsSheet calls setPushMasterEnabled() on
// mount and on every toggle to keep it honest.
let _pushMasterEnabled = true;
export function setPushMasterEnabled(enabled) {
  _pushMasterEnabled = enabled !== false;
  try { globalThis.__chatyy_push_master_enabled = _pushMasterEnabled; } catch {}
}
export function isPushMasterEnabled() { return _pushMasterEnabled; }

// [2026-10-07 recv-native] Android native chat-notification bridge
// (modules/expo-callkit → ChatNotifStore / ChatMessagingStyleHandler). The
// native FCM handler renders chat pushes itself (MessagingStyle + avatar +
// conversation shortcut + inline Reply/Mark-read that POST in background) and
// needs: the bearer of each signed-in account, the conversation open on screen,
// and a "this chat was read" signal to drop its notification. Every call is
// feature-detected in index.ts → no-op on iOS, web and older binaries.
let _nativeChatMod = null;
function _nativeChat() {
  if (Platform.OS !== 'android') return null;
  if (_nativeChatMod) return _nativeChatMod;
  try { _nativeChatMod = require('../modules/expo-callkit'); } catch { _nativeChatMod = null; }
  return _nativeChatMod;
}
// [2026-10-09 notif-native] iOS counterpart: ChatyyNotifActions (expo-native-
// toolkit) answers "Responder"/"Marcar como lida" natively with the app killed,
// signing with per-account bearers kept in the Keychain. null on Android, web
// and binaries without it (requireOptionalNativeModule never throws).
let _iosNotifActionsMod;
function _iosNotifActions() {
  if (Platform.OS !== 'ios') return null;
  if (_iosNotifActionsMod !== undefined) return _iosNotifActionsMod;
  _iosNotifActionsMod = null;
  try {
    const { requireOptionalNativeModule } = require('expo');
    _iosNotifActionsMod = requireOptionalNativeModule('ChatyyNotifActions') || null;
  } catch { _iosNotifActionsMod = null; }
  return _iosNotifActionsMod;
}
// True when the iOS native handler already sent this banner's reply / read.
function _handledNatively(response) {
  try {
    const m = _iosNotifActions();
    const id = response?.notification?.request?.identifier;
    return !!(m && id && typeof m.wasHandledNatively === 'function' && m.wasHandledNatively(String(id)));
  } catch { return false; }
}
// Logout: forget every bearer the native notification paths hold.
export function clearNativeChatAuth() {
  _lastNativeAuthSig = '';
  try { const nc = _nativeChat(); nc?.clearChatNotificationAuth?.(); } catch {}
  try { const m = _iosNotifActions(); m?.clearAuth?.(); } catch {}
}

let _lastNativeAuthSig = '';
let _lastNativeAuthAt = 0;
export async function syncNativeChatAuth(force = false) {
  try {
    const nc = _nativeChat();
    const ios = _iosNotifActions();
    const hasAndroid = !!(nc && typeof nc.setChatNotificationAuth === 'function');
    if (!hasAndroid && !(ios && typeof ios.setAuth === 'function')) return;
    const api = require('./api');
    const tok = (typeof api.getAuthToken === 'function' ? api.getAuthToken() : '') || '';
    const email = (typeof api.getActiveAccountEmail === 'function' ? api.getActiveAccountEmail() : '') || '';
    const tokens = {};
    try {
      const accts = (typeof api.getStoredAccounts === 'function' ? api.getStoredAccounts() : []) || [];
      for (const a of (Array.isArray(accts) ? accts : [])) {
        if (!(a && a.email && typeof a.token === 'string' && a.token)) continue;
        // [incidente-sessao 2026-10-14] nativo (NSE/Android) só recebe bearer da conta ativa + secundárias recentes.
        const isActive = String(a.email).toLowerCase() === String(email || '').toLowerCase();
        if (!isActive && typeof api.isStoredAccountFresh === 'function' && !api.isStoredAccountFresh(a)) continue;
        tokens[String(a.email)] = a.token;
      }
    } catch {}
    // Never wipe native state from a not-yet-hydrated JS (cold start race).
    if (!tok && Object.keys(tokens).length === 0) return;
    const sig = email + '|' + tok.slice(-12) + '|' + Object.keys(tokens).sort().join(',');
    const now = Date.now();
    if (!force && sig === _lastNativeAuthSig && now - _lastNativeAuthAt < 10 * 60 * 1000) return;
    _lastNativeAuthSig = sig;
    _lastNativeAuthAt = now;
    if (hasAndroid) await nc.setChatNotificationAuth(email, tok, tokens);
    if (ios && typeof ios.setAuth === 'function') { try { ios.setAuth(email, tok, tokens); } catch {} }
  } catch {}
}

// Active conversation tracker — set by chat-conversation.js to suppress notifications for the open chat
let _activeConversationId = null;
export function setActiveConversation(conversationId) {
  _activeConversationId = conversationId;
  // [2026-10-07 recv-native] Mirror to native (Android): the FCM handler drops
  // the banner for the chat on screen, and opening the chat = read → remove
  // the native MessagingStyle notification of that conversation.
  try {
    const nc = _nativeChat();
    if (nc) {
      nc.setActiveChatConversation?.(conversationId);
      if (conversationId != null) nc.dismissChatNotification?.(conversationId);
    }
  } catch {}
  syncNativeChatAuth().catch(() => {});
  // [2026-10-04] WhatsApp parity: opening a conversation = reading it, so clear
  // that chat's ALREADY-DELIVERED push notifications from the tray. The
  // _activeConversationId check below only suppresses NEW pushes while you're in
  // the chat; it never removed the ones that arrived before you opened it (the
  // founder's report: "o push devia sumir ao ler, igual WhatsApp").
  if (conversationId != null && Platform.OS !== 'web') {
    dismissConversationNotifications(conversationId).catch(() => {});
  }
}

// [2026-10-15 notif-read-sync] Conversa de um banner apresentado: data.conversation_id
// (Expo iOS/Android), JSON em data.body (Android Expo-routed), thread_id /
// threadIdentifier iOS ou tag Android `chat_<cid>`.
function _notifConvInfo(n) {
  const req = n?.request || {};
  const c = req.content || {};
  let d = c.data || {};
  if (d && d.conversation_id == null && typeof d.body === 'string' && d.body.trim()[0] === '{') {
    try { const p = JSON.parse(d.body); if (p && typeof p === 'object') d = { ...d, ...p }; } catch {}
  }
  let cid = d && d.conversation_id != null ? String(d.conversation_id) : '';
  if (!cid) {
    for (const t of [d?.thread_id, c.threadIdentifier, req.identifier]) {
      const m = /^chat_(\d+)$/.exec(String(t || ''));
      if (m) { cid = m[1]; break; }
    }
  }
  return { cid, mid: Number(d?.message_id) || 0, type: String(d?.type || ''), id: req.identifier, data: d || {} };
}

// Remove every delivered chat notification that belongs to `conversationId`
// from the notification tray (and trim the app badge by how many we cleared).
// Fire-and-forget; all failures are non-fatal.
// opts.upTo (>0) = lida só até esse id → banner de msg mais nova fica.
export async function dismissConversationNotifications(conversationId, opts = null) {
  try {
    if (Platform.OS === 'web' || conversationId == null) return;
    // [2026-10-07 recv-native] native MessagingStyle notification (Android)
    // is not an expo-notifications record → drop it through the bridge too.
    try { _nativeChat()?.dismissChatNotification?.(conversationId); } catch {}
    if (!Notifications) {
      try { Notifications = await import('expo-notifications'); } catch { return; }
    }
    if (!Notifications?.getPresentedNotificationsAsync) return;
    const presented = await Notifications.getPresentedNotificationsAsync();
    const target = String(conversationId);
    const upTo = Number(opts && opts.upTo) || 0;
    let cleared = 0;
    for (const n of presented || []) {
      const info = _notifConvInfo(n);
      if (info.cid !== target) continue;
      if (upTo > 0 && info.mid > upTo && info.type !== 'chat_reaction') continue;
      if (info.id) {
        try { await Notifications.dismissNotificationAsync(info.id); cleared++; } catch {}
      }
    }
    // Keep the app-icon badge honest (don't leave a count for notifications the
    // user already read). Never go below 0.
    // [2026-10-15 unread-instant] keepBadge: o ícone já foi recalculado do
    // estado local (services/unreadBadge) — "-N banners" aqui o desalinharia.
    if (cleared > 0 && !(opts && opts.keepBadge) && Notifications.getBadgeCountAsync && Notifications.setBadgeCountAsync) {
      try {
        const cur = await Notifications.getBadgeCountAsync();
        const next = Math.max(0, (cur || 0) - cleared);
        await Notifications.setBadgeCountAsync(next);
        _mirrorBadge(next);
      } catch {}
    }
  } catch {}
}
// [2026-10-12 push-parity] Server silent push `chat_notif_clear` (no title):
//   kind=read    → this chat was read on ANOTHER device / the web (up_to = last
//                  read id) → drop its banners here too (WhatsApp multi-device);
//   kind=deleted → message_id was deleted for everyone → drop that banner;
//   kind=edited  → Android native updates the text; iOS can't edit a delivered
//                  banner → no-op.
// Android binaries with the native handler consume it before JS ever sees it;
// this path covers iOS (foreground handler + background task when the app is
// suspended) and older Android binaries. Payload shapes vary (Expo `body` dict
// or JSON string, APNs `body`) → shallow bounded search.
function _findClearPayload(node, depth = 0) {
  if (node == null || depth > 5) return null;
  if (typeof node === 'string') {
    const t = node.trim();
    if (t.length > 2 && t.length < 8192 && t[0] === '{' && t.includes('chat_notif_clear')) {
      try { return _findClearPayload(JSON.parse(t), depth + 1); } catch { return null; }
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  if (node.type === 'chat_notif_clear' && node.conversation_id != null) return node;
  for (const k of Object.keys(node)) {
    const r = _findClearPayload(node[k], depth + 1);
    if (r) return r;
  }
  return null;
}
export function isNotifClearPayload(raw) {
  try { return !!_findClearPayload(raw); } catch { return false; }
}
export async function applyNotifClear(raw) {
  try {
    if (Platform.OS === 'web') return false;
    const d = _findClearPayload(raw);
    if (!d) return false;
    const cid = String(d.conversation_id ?? '');
    if (!cid) return false;
    const kind = String(d.kind || 'read');
    if (kind !== 'read' && kind !== 'deleted') return true;
    const upTo = Number(d.up_to) || 0;
    const mid = String(d.message_id ?? '');
    if (kind === 'read') { try { _nativeChat()?.dismissChatNotification?.(cid); } catch {} }
    // [2026-10-15 unread-instant] Lida em OUTRO aparelho/web → a linha da lista,
    // a aba e o ícone daqui zeram já (app vivo em 2º plano / WS caído).
    if (kind === 'read') { _localReadFromNotification(cid, { dismiss: false }); }
    // [2026-10-13 delete-for-all] push de "apagada p/ todos" (app em 2º plano /
    // suspenso) → apaga já a mídia auto-baixada + lápide anti-download/galeria.
    if (kind === 'deleted' && mid) {
      try { require('./mediaCache').purgeDeletedMessageMedia?.(mid, { conversationId: cid }); } catch {}
    }
    if (!Notifications) {
      try { Notifications = await import('expo-notifications'); } catch { return false; }
    }
    if (!Notifications?.getPresentedNotificationsAsync) return false;
    const presented = (await Notifications.getPresentedNotificationsAsync()) || [];
    let cleared = 0;
    for (const n of presented) {
      const info = _notifConvInfo(n);
      const nd = info.data;
      if (info.cid !== cid) continue;
      if (info.type === 'chat_notif_clear') continue;
      const nMid = info.mid;
      const hit = kind === 'read'
        ? (!upTo || !nMid || nMid <= upTo)
        : (!!mid && String(nd.message_id ?? '') === mid && info.type !== 'chat_reaction');
      if (!hit) continue;
      const id = info.id;
      if (id) { try { await Notifications.dismissNotificationAsync(id); cleared++; } catch {} }
    }
    // The server sends the fresh badge with kind=read (iOS applies it itself);
    // older servers don't → trim locally like dismissConversationNotifications.
    if (cleared > 0 && kind === 'read' && d.badge == null && Notifications.getBadgeCountAsync && Notifications.setBadgeCountAsync) {
      try {
        const cur = await Notifications.getBadgeCountAsync();
        const next = Math.max(0, (cur || 0) - cleared);
        await Notifications.setBadgeCountAsync(next);
        _mirrorBadge(next);
      } catch {}
    } else if (kind === 'read' && d.badge != null && Number.isFinite(Number(d.badge))) {
      _mirrorBadge(Math.max(0, Number(d.badge)));
    }
    return true;
  } catch { return false; }
}

// [2026-10-15 notif-read-sync] Reconciliação: banners de conversas que a lista
// local mostra lidas (unread 0) e cuja msg a lista já viu (id <= lastId) saem da
// central. Chamada por services/unreadBadge (publicação da lista / 1º plano).
// Reações ficam (WhatsApp só tira ao abrir a conversa). Single-flight.
let _reconBusy = false;
export async function reconcileReadNotifications() {
  if (Platform.OS === 'web' || _reconBusy) return 0;
  try { if (globalThis.__chatyy_notif_reconcile_off) return 0; } catch {}
  _reconBusy = true;
  try {
    const ub = require('./unreadBadge');
    if (!ub.hasLocalList?.()) return 0;
    if (!Notifications) {
      try { Notifications = await import('expo-notifications'); } catch { return 0; }
    }
    if (!Notifications?.getPresentedNotificationsAsync) return 0;
    const presented = (await Notifications.getPresentedNotificationsAsync()) || [];
    let cleared = 0;
    const done = new Set();
    for (const n of presented) {
      const info = _notifConvInfo(n);
      if (!info.cid || !info.id || !info.mid) continue;
      if (info.type && info.type !== 'chat_message' && info.type !== 'chat_mention' && info.type !== 'chat_keyword') continue;
      const st = ub.getConvReadState?.(info.cid);
      if (!st || st.unread > 0 || !st.lastId || info.mid > st.lastId) continue;
      try { await Notifications.dismissNotificationAsync(info.id); cleared++; done.add(info.cid); } catch {}
    }
    for (const cid of done) { try { _nativeChat()?.dismissChatNotification?.(cid); } catch {} }
    if (cleared > 0) {
      const tot = ub.getLocalUnreadTotal?.();
      if (tot != null) { try { await setBadgeCount(tot); } catch {} }
      _diagPush('notif_reconcile', `cleared=${cleared} convs=${done.size}`);
    }
    return cleared;
  } catch { return 0; } finally { _reconBusy = false; }
}

// [2026-10-12 nav-dedup] `conversationId` (optional): only clear when it is
// still the active one. After a chat→chat replace the OLD screen unmounts
// AFTER the new one mounted; an unconditional clear wiped the new chat's id,
// so the next push tap for it pushed a 2nd copy instead of no-op.
export function clearActiveConversation(conversationId) {
  if (conversationId != null && _activeConversationId != null && String(_activeConversationId) !== String(conversationId)) return;
  _activeConversationId = null;
  try { _nativeChat()?.setActiveChatConversation?.(''); } catch {}
  // Leaving the chat (back) re-arms the open guard so an immediate re-open works.
  try { require('./openConversation').resetConversationOpenGuard(); } catch {}
}
// Exposed so ChatListTab can also skip bumping unread_count for messages
// arriving INTO the conversation the user is currently viewing — without
// this, every WS message inside the open chat re-incremented the list's
// unread badge to 1+ and a back-press surfaced "X unread" for a thread
// you literally just finished reading (reported 2026-05-12).
export function getActiveConversation() {
  return _activeConversationId;
}

// Incoming call callback — set by IncomingCallListener
let _onIncomingCall = null;
export function setIncomingCallHandler(handler) {
  _onIncomingCall = handler;
}

// Internal state for native device FCM/APNs token. Declared up here (not
// further down) so that registerForPushNotifications() can safely mutate
// it without any TDZ / declaration-order risk.
// [2026-10-17 fcm-race] último token FCM nativo obtido nesta instalação (sobrevive ao reset do registro concorrente).
let _lastGoodAndroidDeviceToken = null;
const pushNotificationsState = {
  deviceToken: null,
  apnsToken: null,     // [2026-10-09] iOS APNs hex token (token_type apns | apns_sandbox)
  apnsTokenType: null,
  expoToken: null,     // [2026-10-13] último ExponentPushToken (fallback)
};

// [2026-10-09 native-transport] device_id que pareia o token APNs com o token
// Expo do MESMO aparelho ("expo:" + id interno do ExponentPushToken[...]).
// O backend aplica a mesma sanitização ([A-Za-z0-9._:-], 100 chars).
function _apnsPairId(expoToken) {
  const m = /\[([^\]]+)\]/.exec(String(expoToken || ''));
  if (!m) return '';
  return ('expo:' + m[1].replace(/[^A-Za-z0-9._:-]/g, '')).slice(0, 100);
}

// [2026-10-13 push-token-always] Token nativo (FCM/APNs) é o transporte
// PRINCIPAL; o Expo vira fallback p/ binário antigo. Ajudantes:
function _isExpoToken(t) {
  return typeof t === 'string' && /^Expo(nent)?PushToken\[/.test(t);
}
// device_id ESTÁVEL do aparelho em TODAS as entradas (expo, fcm_device, apns,
// voip): o servidor deduplica por (device_id, tipo) e pareia nativo↔Expo do
// mesmo aparelho (sem banner duplo). "expo:<id>" quando há token Expo (mesmo
// formato que o pareamento APNs já usa); senão "inst:<id da instalação>".
function _pushDeviceId(expoToken) {
  const p = _apnsPairId(expoToken || pushNotificationsState.expoToken || _cachedPushToken);
  if (p) return p;
  const iid = _pushInstallId();
  return iid ? ('inst:' + iid).slice(0, 100) : '';
}
// Contas logadas NESTE aparelho (multi-conta): o servidor tira o token deste
// aparelho de qualquer OUTRA conta que não esteja aqui (push de uma conta não
// aparece em outra — ex.: iPhone reinstalado mantém o mesmo token APNs/VoIP).
function _pushDeviceAccounts(activeEmail) {
  const out = [];
  try {
    const add = (e) => {
      const v = String(e || '').trim().toLowerCase();
      if (v && v.includes('@') && !out.includes(v)) out.push(v);
    };
    add(activeEmail);
    const api = require('./api');
    const accts = (typeof api.getStoredAccounts === 'function' ? api.getStoredAccounts() : []) || [];
    for (const a of (Array.isArray(accts) ? accts : [])) add(a?.email);
  } catch {}
  return out.slice(0, 10);
}
// iOS: ambiente APNs (TestFlight/App Store = production; Debug = development)
// + bundle id — o servidor escolhe o host da Apple certo na 1ª tentativa.
let _iosPushMetaCache = null;
async function _iosPushMeta() {
  if (Platform.OS !== 'ios') return {};
  if (_iosPushMetaCache) return _iosPushMetaCache;
  const meta = {};
  try {
    const App = require('expo-application');
    if (App?.applicationId) meta.bundle_id = String(App.applicationId).slice(0, 100);
    if (typeof App?.getIosPushNotificationServiceEnvironmentAsync === 'function') {
      const env = await App.getIosPushNotificationServiceEnvironmentAsync();
      if (env === 'development' || env === 'production') meta.apns_env = env;
    }
  } catch {}
  _iosPushMetaCache = meta;
  return meta;
}
// Metadados comuns de registro (também usados pelo VoIP em callkeep.js).
export async function _pushRegistrationMeta() {
  const email = await _getActiveEmailSafe();
  return {
    device_id: _pushDeviceId(null),
    app_version: _pushAppVersion(),
    device_accounts: _pushDeviceAccounts(email),
    notif_perm: _lastRegisterPerm || _lastPermStatus || '',
    ...(await _iosPushMeta()),
  };
}
// Permissão de notificação no último registro ('granted' | 'denied' | …). O
// token é registrado MESMO negada (push silencioso, ✓✓ de entrega e VoIP
// continuam funcionando; o alerta o SO descarta) — e re-enviado quando muda.
let _lastRegisterPerm = '';
// [2026-10-18 push-coverage] Por que o último registro não trouxe token de mensagem
// (vai no push_permission_report → push_device_status.reg_error; '' = tudo ok).
let _lastRegError = '';
function _noteRegError(tag, msg) {
  try { _lastRegError = (_lastRegError ? _lastRegError + '|' : '') + String(tag) + (msg ? ':' + String(msg).replace(/[\r\n|]+/g, ' ').slice(0, 50) : ''); } catch {}
}

// Remote diagnostic: posts each step of registerForPushNotifications to the
// backend so we can see WHERE on Android the chain breaks (Android has zero
// tokens registered across the entire backend, so something silently fails
// before sendTokenToBackend is called).
//
// Uses raw fetch — bypasses apiCall/auth so it fires even pre-login. Tries
// to grab the bearer if available, otherwise sends as anon (backend accepts
// both for the push_diag endpoint). OTA-safe (no native deps).
// [2026-06-12 STORM FIX] Global throttle: diagnostics must NEVER be able to
// flood the API (incident: token-rotation recursion × unthrottled _diagPush
// = ~700 req/s from one phone, saturating its uplink + the API). Cap at 20
// posts/min per session + drop identical step repeats within 5s.
let _diagWindowStart = 0;
let _diagWindowCount = 0;
const _diagLastByStep = Object.create(null);
async function _diagPush(step, info) {
  // [perf 2026-10-17 boot-fanout] no boot os ~8 passos do registro de push saíam
  // como 8 POSTs nos primeiros segundos → vão no lote único do crashReporter
  // (diag_batch, após ~25 s; passo vira `push_<step>`). Fora da janela = como antes.
  try {
    if (require('./crashReporter').deferBootDiag?.('push_' + String(step || ''), info ? String(info).slice(0, 220) : '')) return;
  } catch {}
  try {
    const _now = Date.now();
    if (_now - _diagWindowStart > 60 * 1000) { _diagWindowStart = _now; _diagWindowCount = 0; }
    if (_diagWindowCount >= 20) return;
    if (_diagLastByStep[step] && _now - _diagLastByStep[step] < 5000) return;
    _diagLastByStep[step] = _now;
    _diagWindowCount++;
    // Try to attach bearer if available, otherwise send anon
    let bearer = '';
    try {
      const SecureStore = require('expo-secure-store');
      bearer = (await SecureStore.getItemAsync('mail_token')) || '';
    } catch {}
    const BASE_URL = 'https://chatyy.com.br/api/email.php';
    // Anon identifier — random per app install, so we can group entries even
    // without a logged-in user. Lazily generated; stored in AsyncStorage.
    let anonId = '';
    try {
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      anonId = (await AsyncStorage.getItem('push_diag_anon_id')) || '';
      if (!anonId) {
        anonId = 'anon-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
        await AsyncStorage.setItem('push_diag_anon_id', anonId);
      }
    } catch {}
    const body = JSON.stringify({
      action: 'push_diag',
      step,
      platform: Platform.OS,
      info: info ? String(info).slice(0, 500) : '',
      ts: new Date().toISOString(),
      anon_id: anonId,
    });
    const headers = { 'Content-Type': 'application/json' };
    if (bearer) headers['Authorization'] = 'Bearer ' + bearer;
    fetch(BASE_URL, { method: 'POST', headers, body }).catch(() => {});
  } catch {}
}

// [2026-10-19 push-fg] Decisão de apresentação do push com o app em 1º plano.
// Relato do founder 19/10 22:40Z: "só vibrou" — o iOS só chama willPresent com o
// app em 1º plano e aí o handler tirava banner E som do sistema e deixava o
// toast in-app (haptic leve, sem som; e invisível com o app 'inactive').
const _FG_CHAT_TYPES = new Set(['chat_message', 'chat_mention', 'chat_keyword']);
// [2026-10-20 newemail-call] pushes de controle de chamada: nunca visíveis no 1º plano.
const _CALL_CTL_PUSH_TYPES = new Set(['call_cancel', 'call_end', 'call_ended', 'answered_elsewhere', 'call_dismissed', 'call_declined']);
let _fgLagMs = -1;
// Handler respondeu depois dos 3 s do expo-notifications → o iOS já descartou a
// apresentação. Reapresenta 1x como notificação local (mesmo título/corpo/
// thread; data.__fgRepost faz o handler só mostrar). Kill: __chatyy_fg_repost=false.
const _fgReposted = new Set();
function _fgRepostIfLate(notification, data) {
  try {
    if (globalThis.__chatyy_fg_repost === false || !Notifications || Platform.OS !== 'ios') return false;
    if (!(_fgLagMs > 2800)) return false;
    const key = String(data?.message_id || notification?.request?.identifier || '');
    if (!key || _fgReposted.has(key)) return false;
    _fgReposted.add(key);
    if (_fgReposted.size > 100) _fgReposted.clear();
    const c = notification?.request?.content || {};
    Notifications.scheduleNotificationAsync({
      content: {
        title: c.title || '', body: c.body || '', sound: 'default',
        data: { ...(data || {}), __fgRepost: 1 },
        ...(data?.conversation_id ? { threadIdentifier: 'chat_' + data.conversation_id } : {}),
        ...(c.categoryIdentifier ? { categoryIdentifier: c.categoryIdentifier } : {}),
      },
      trigger: null,
    }).catch(() => {});
    return true;
  } catch { return false; }
}
function _fgCallActive() {
  try {
    const { isCallActive } = require('../components/IncomingCallListener');
    return typeof isCallActive === 'function' && !!isCallActive();
  } catch { return false; }
}
// Beacon fg_push (push_diag): como o push foi mostrado. 1 por mensagem; o
// _diagPush já limita 20/min e dedupe 5 s por passo → o passo leva o desfecho.
// Kill: globalThis.__chatyy_fg_push_beacon = false.
function _fgPushBeacon(data, how, why, appState, sound) {
  try {
    if (globalThis.__chatyy_fg_push_beacon === false) return;
    const t = String(data?.type || '-');
    if (!_FG_CHAT_TYPES.has(t) && t !== 'chat_reaction') return;
    let route = '-';
    try { route = String(globalThis.__chatyyCurrentRoute || '-').slice(0, 40); } catch {}
    const nb = (() => { try { return require('../modules/expo-inapp-banner').isAvailable() ? 1 : 0; } catch { return 0; } })();
    _diagPush('fg_push_' + how, `why=${why} as=${appState || '-'} t=${t} cid=${data?.conversation_id || '-'} mid=${String(data?.message_id || '-').slice(-8)} snd=${sound ? 1 : 0} lag=${_fgLagMs} nb=${nb} call=${_fgCallActive() ? 1 : 0} act=${_activeConversationId != null ? 1 : 0} r=${route}`);
  } catch {}
}
// NotificationToast → resultado do banner nativo (ok=false cai no toast JS).
export function reportForegroundBanner(ok, info) {
  try {
    if (globalThis.__chatyy_fg_push_beacon === false) return;
    _diagPush(ok ? 'fg_banner_ok' : 'fg_banner_fail', String(info || '').slice(0, 200));
  } catch {}
}

// Trigger the foreground toast directly (used on web where native notifications are unavailable)
export function _triggerForegroundToast(notif) {
  if (_onForegroundNotification && notif) {
    _onForegroundNotification(notif);
  }
}

// Load native modules (avoid crash on web)
// Called eagerly on native to ensure notification handler is set before any push arrives
async function loadModules() {
  if (Platform.OS === 'web') return false;
  if (!Notifications) {
    Notifications = await import('expo-notifications');
    Device = await import('expo-device');
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const data = notification.request?.content?.data;
        // [2026-10-19 push-fg] o expo-notifications iOS espera esta resposta só
        // 3 s (SingleNotificationHandlerTask) e depois NÃO apresenta nada. Lag =
        // chegada → JS rodar (JS ocupado na volta do 2º plano / render pesado).
        try {
          const _d = Number(notification?.date || 0);
          _fgLagMs = _d > 1e11 ? Math.max(0, Date.now() - _d) : (_d > 0 ? Math.max(0, Date.now() - _d * 1000) : -1);
        } catch { _fgLagMs = -1; }
        // Reapresentação local de um push perdido pelo timeout (abaixo) → mostra.
        if (data?.__fgRepost) {
          return { shouldShowAlert: true, shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false };
        }

        // [2026-10-20 newemail-call] Push de CONTROLE de chamada (cancelar/
        // atendida noutro aparelho/fim) chega no iOS como alerta de título e
        // corpo VAZIOS (APNs direto) e caía no "Other notifications" lá embaixo
        // → toast/banner "New email"/"Novo email" (fallback do título) ao
        // atender uma ligação. O CallKit/VoIP e o WS já fazem o desmonte; aqui
        // nunca mostra nada. Kill: globalThis.__chatyy_fg_callctl_drop = false.
        if (globalThis.__chatyy_fg_callctl_drop !== false && _CALL_CTL_PUSH_TYPES.has(String(data?.type || ''))) {
          return { shouldShowAlert: false, shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false };
        }

        // Silent sync push — background data refresh, no visible notification
        // [2026-10-12 push-parity] read elsewhere / deleted → clear banners,
        // never show anything (the server badge still applies on iOS).
        if (data?.type === 'chat_notif_clear') {
          applyNotifClear(data).catch(() => {});
          return {
            shouldShowAlert: false,
            shouldShowBanner: false,
            shouldShowList: false,
            shouldPlaySound: false,
            shouldSetBadge: true,
          };
        }

        if (data?.type === 'silent_sync') {
          triggerBackgroundSync(data);
          return {
            shouldShowAlert: false,
            shouldPlaySound: false,
            shouldSetBadge: false,
          };
        }

        // Find My Friends — silent WAKE-PING. Backend (chat_friend_location_ping)
        // fires a data-only push when a viewer's map sees this user's pin stale.
        // Re-run getCurrentPosition + POST chat_friend_location_share_update so
        // the sharer's location refreshes even when the app is backgrounded (the
        // WS path LiveLocationPingListener only works when WS is connected). No
        // visible notification. 60s self-throttle to protect APNs quota.
        if (data?.type === 'location_ping') {
          (async () => {
            try {
              const now = Date.now();
              if (now - (globalThis.__chatyyLastLocPing || 0) < 60000) return;
              // [2026-10-12 find-my] Binário com envio nativo ligado: o
              // AppDelegate (iOS) / FCM service (Android) já respondeu ao ping.
              try {
                const nfl = require('./nativeFriendLocation');
                if (nfl.isAvailable() && nfl.getNativeStatus()?.enabled) return;
              } catch {}
              // Ghost/invisible mode: never answer location wake-pings while
              // "invisível" is on (snap_map_ghost_mode='1'), else the user
              // stays trackable despite it. Bug-hunt P1 (2026-05-30).
              try {
                const AS = require('@react-native-async-storage/async-storage').default;
                const ghost = await AS.getItem('snap_map_ghost_mode').catch(() => null);
                if (ghost === '1' || ghost === 'true') return;
              } catch {}
              globalThis.__chatyyLastLocPing = now;
              const Location = await import('expo-location');
              const fg = await Location.getForegroundPermissionsAsync?.().catch(() => null);
              if (fg && fg.status !== 'granted') return;
              const loc = await Location.getCurrentPositionAsync({
                accuracy: Location.Accuracy?.Balanced ?? 3,
              }).catch(() => null);
              if (!loc?.coords) return;
              const api = require('./api');
              await api.apiCall('chat_friend_location_share_update', {
                latitude: loc.coords.latitude,
                longitude: loc.coords.longitude,
                accuracy: loc.coords.accuracy || null,
                heading: loc.coords.heading ?? null,
                speed: loc.coords.speed ?? null,
              }, 'POST').catch(() => {});
            } catch {}
          })();
          return {
            shouldShowAlert: false,
            shouldPlaySound: false,
            shouldSetBadge: false,
          };
        }

        // Login challenge: show verification prompt on existing device
        if (data?.type === 'login_challenge' && data?.challenge_id) {
          try {
            const { triggerLoginChallengePrompt } = require('../components/LoginChallengePrompt');
            triggerLoginChallengePrompt(data);
          } catch {}
          return {
            shouldShowAlert: true,
            shouldPlaySound: true,
            shouldSetBadge: false,
          };
        }

        // [2026-10-15 chamadas-dnd] Notificação LOCAL do nativo iOS quando o
        // Foco/Não Perturbe filtrou o CallKit: "Ligação de X — toque para
        // atender". Mostra mesmo com o app aberto (o toque não apareceu).
        if (data?.type === 'call_filtered') {
          return {
            shouldShowAlert: true,
            shouldShowBanner: true,
            shouldShowList: true,
            shouldPlaySound: true,
            shouldSetBadge: false,
          };
        }

        // Incoming call: trigger IncomingCallListener (in-app UI with ringtone)
        if (data?.type === 'incoming_call' && (data?.room_id || data?.call_id)) {
          const callId = data.call_id || data.room_id;
          const isVideo = data.video === '1' || data.video === true;

          // [#992 Stage 4 — retire JS modal on mobile]
          // On iOS the PKPushRegistry → AppDelegate VoIP push path already
          // reported the call to CXProvider before this expo-notifications
          // handler runs. On Android the priority=10 CallFirebaseMessagingService
          // already launched IncomingCallActivity / CallRingingService before
          // expo-notifications surfaces the foreground notification. The JS
          // Modal would now be a second, overlapping UI. Suppress it on
          // mobile (still need shouldShowAlert=false so the system banner
          // doesn't double up). Web keeps the JS Modal because Service
          // Workers can't show full-screen incoming UI.
          if (Platform.OS === 'web') {
            // ALWAYS try to trigger in-app call UI — don't check isCallActive here
            // (it might be stuck true from a previous call that didn't clean up)
            try {
              const { triggerIncomingCall } = require('../components/IncomingCallListener');
              triggerIncomingCall({
                caller_email: data.caller_email,
                caller_name: data.caller_name,
                conversation_id: data.conversation_id,
                room_id: data.room_id || callId,
                call_id: callId,
                video: isVideo,
              });
            } catch {}
          }

          // Suppress system notification — IncomingCallListener handles it with full-screen UI
          return {
            shouldShowAlert: false,
            shouldPlaySound: false,
            shouldSetBadge: false,
          };
        }

        // Master push switch (ProfileSettingsSheet "Notificações push"). When
        // the user turned push OFF we also unregistered the device token
        // server-side, but a push already in flight (or from another
        // account/session on this device) can still land. Fully silence
        // content-type notifications locally. Signaling pushes (incoming_call,
        // login_challenge, silent_sync, location_*) were short-circuited above
        // and are intentionally NOT gated here — a disabled "push" toggle must
        // never swallow an incoming call or a login-approval prompt. Badge is
        // left off too so a disabled user sees no count bump.
        //
        // [2026-10-06] LOCAL chat reminders (services/reminders.js, user
        // explicitly asked "me lembra amanhã...") must ALWAYS surface: not
        // gated by the push master switch, not suppressed when the same
        // conversation is open, not hidden by the foreground gate.
        if (data?.type === 'chat_reminder' || data?.type === 'task_reminder' || data?.type === 'note_reminder') { // [2026-10-13] lembrete local de tarefa idem · [notas-lembrete 2026-10-14] lembrete de nota idem
          return { shouldShowAlert: true, shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false };
        }
        if (_pushMasterEnabled === false) {
          return { shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: false };
        }

        // [2026-10-19 push-fg] Como apresentar com o app "em primeiro plano"
        // para o iOS (willPresent). Regra nível WhatsApp: NUNCA engolir em
        // silêncio. Só o app ATIVO (tela visível) usa banner in-app; 'inactive'
        // (Central de Notificações/Controle puxada, troca de app, bloqueando a
        // tela, alerta do sistema/CallKit por cima) = o usuário NÃO está vendo
        // o app → banner + som do sistema. Telemetria: passo fg_push.
        const _fgAs = AppState.currentState;
        const _fgActive = Platform.OS === 'web' || _fgAs === 'active' || _fgAs == null;
        const _fgChat = _FG_CHAT_TYPES.has(String(data?.type || ''));
        const _fgSys = (sound, why) => {
          const _rp = _fgRepostIfLate(notification, data);
          _fgPushBeacon(data, _rp ? 'repost' : 'sys', why, _fgAs, sound);
          return { shouldShowAlert: true, shouldShowBanner: true, shouldShowList: true, shouldPlaySound: !!sound, shouldSetBadge: true };
        };

        // Suppress notification if the user is already viewing this conversation
        if (_activeConversationId && data?.conversation_id &&
            String(data.conversation_id) === String(_activeConversationId)) {
          if (!_fgActive && _fgChat && globalThis.__chatyy_fg_inactive_sys !== false) {
            // Conversa aberta mas app fora de vista → igual app em 2º plano.
            return _fgSys(!_fgCallActive(), 'same_conv_inactive');
          }
          _fgPushBeacon(data, 'drop', 'same_conv', _fgAs, false);
          return {
            shouldShowAlert: false,
            shouldPlaySound: false,
            shouldSetBadge: false,
          };
        }

        if (!_fgActive && _fgChat && globalThis.__chatyy_fg_inactive_sys !== false) {
          // Silenciada/desligada na conversa continua valendo.
          const cs = data?.conversation_id ? await _readConvSettings(data.conversation_id) : null;
          if (cs && cs.notify_messages === false) {
            _fgPushBeacon(data, 'drop', 'conv_off_inactive', _fgAs, false);
            return { shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: true };
          }
          if (cs && _isMutedNow(cs.mute_until) && data?.type !== 'chat_mention') {
            _fgPushBeacon(data, 'drop', 'muted_inactive', _fgAs, false);
            return { shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: true };
          }
          return _fgSys(!_fgCallActive() && !(cs && cs.sound === 'silent'), 'inactive');
        }

        // [2026-05-19] WhatsApp-parity foreground gate.
        // When app is in foreground (AppState === 'active'), NEVER let the
        // OS render a tray/heads-up notification for content-type pushes
        // (chat_message, chat_mention, chat_keyword, new_email, social).
        // The in-app NotificationToast handles the visible UX; the OS
        // banner on top of it was duplicating ("banner duplo" — user
        // report 2026-05-19). On Android the FCM payload still includes
        // a root `notification` block (backend behavior unchanged so
        // background/killed flows still surface), but in foreground the
        // expo-notifications JS handler is the final authority and
        // `shouldShowAlert: false` suppresses NotificationManager from
        // re-presenting the heads-up. Signaling pushes (incoming_call,
        // login_challenge, silent_sync) were already short-circuited
        // earlier and don't reach this gate.
        const _foregroundContentTypes = new Set([
          'chat_message',
          'chat_mention',
          'chat_keyword',
          'new_email',
          'email',
          'like',
          'comment',
          'follow',
          'mention',
          'live',
          'reaction',
          'status_reply',
        ]);
        if (AppState.currentState === 'active' && _foregroundContentTypes.has(data?.type)) {
          // [2026-10-15 email-melhorias] Push de e-mail com o app aberto → a
          // caixa atualiza na hora (antes só mostrava o toast e a lista
          // esperava o WS/poll de 30 s). MailContext ouve `silent_sync`.
          if (data?.type === 'new_email' || data?.type === 'email') {
            try { require('./websocket').default?._emit?.('silent_sync', { type: 'email' }); } catch {}
          }
          // [2026-10-19 push-fg] Banner in-app + SOM. Antes o iOS ficava só com o
          // haptic leve do toast (playNotificationSound é no-op no nativo) =
          // "só vibrou". Agora o próprio iOS toca o som do push (respeita
          // silencioso/Foco como o WhatsApp) sem banner do sistema (o in-app
          // desenha). Sem som se: ligação ativa, conversa com som 'silent',
          // tom "Nenhum" ou a lista/conversa já tocou o som de chegada (WS
          // chegou antes do push) há < 3 s.
          let _fgSound = false;
          const _fgRxRecent = (Date.now() - (globalThis.__chatyyRxSoundAt || 0)) <= 3000;
          if (Platform.OS === 'ios' && _fgChat && globalThis.__chatyy_fg_push_sound !== false) {
            _fgSound = !_fgCallActive() && !_fgRxRecent;
            if (_fgSound && data?.conversation_id) {
              try {
                const cs = await _readConvSettings(data.conversation_id);
                if (cs && (cs.sound === 'silent' || cs.notify_messages === false || (_isMutedNow(cs.mute_until) && data?.type !== 'chat_mention'))) _fgSound = false;
              } catch {}
            }
          }
          let _fgToast = false;
          if (_onForegroundNotification && data) {
            try {
              _onForegroundNotification({
                title: notification.request?.content?.title,
                body: notification.request?.content?.body,
                data: (_fgSound || (_fgChat && _fgRxRecent)) ? { ...data, __sysSound: 1 } : data,
              });
              _fgToast = true;
            } catch {}
          }
          _fgPushBeacon(data, _fgToast ? 'toast' : 'none', 'active', _fgAs, _fgSound);
          if (_fgSound) { try { globalThis.__chatyyRxSoundAt = Date.now(); } catch {} }
          // WhatsApp parity: ack delivered the moment the push lands in
          // foreground too. addNotificationReceivedListener also fires this,
          // but the receivedSub path runs AFTER handleNotification on some
          // platforms — eager ack here removes the ~50-200ms window where
          // the sender's UI is at ✓ while we're already handling the body.
          if (['chat_message','chat_mention','chat_keyword'].includes(data?.type) && data.conversation_id && data.message_id) {
            try {
              const convId = Number(data.conversation_id) || data.conversation_id;
              const mid = Number(data.message_id);
              if (mid > 0) {
                const api = require('./api');
                if (typeof api.chatDeliveryAckBatched === 'function') {
                  api.chatDeliveryAckBatched(convId, [mid]);
                }
              }
            } catch {}
          }
          if (_fgSound) {
            // Só o SOM do sistema (sem banner/lista: o in-app desenha).
            return { shouldShowAlert: false, shouldShowBanner: false, shouldShowList: false, shouldPlaySound: true, shouldSetBadge: true };
          }
          return {
            shouldShowAlert: false,
            shouldPlaySound: false,
            shouldSetBadge: true,
          };
        }

        // WhatsApp parity: silencia toasts de chat enquanto call ativa.
        // While the user is on an active voice/video call, foreground chat
        // pushes shouldn't pop a toast over the call screen (the system call
        // UI plus the LK audio session make any chat alert disruptive). The
        // badge still increments via AsyncStorage downstream, so the chat
        // list reflects the unread on call end. Signaling-style pushes
        // (incoming_call, login_challenge, etc) handled earlier still fire.
        try {
          const { isCallActive } = require('../components/IncomingCallListener');
          if (typeof isCallActive === 'function' && isCallActive() && data?.type === 'chat_message') {
            return { shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: true };
          }
        } catch {}

        // Global preview privacy gate — when the backend says
        // preview_when='never', strip body even before we get to the
        // per-conversation cache lookup. The same flag pre-redacts on
        // backend so this is belt-and-suspenders. 'unlocked' is a hint
        // the OS-level handler enforces (Android VISIBILITY_PRIVATE +
        // iOS Notification Content Setting); we don't strip in JS for
        // 'unlocked' because the user expects to see the body once they
        // unlock.
        if (data?.preview_when === 'never' && notification?.request?.content) {
          try {
            // Mutate the body to a generic safe value. Backend already
            // does this — covered here only for clients that received a
            // push from an older backend that hadn't propagated yet.
            // [2026-10-12 srv-audit] sem emoji + idioma do app.
            notification.request.content.body = (await _notifActionLabels()).newMessage || 'Nova mensagem';
          } catch {}
        }

        // Channel routing hint for Android — backend stamps `data.is_group`
        // on every chat push. If the OS already routed by channel
        // (notification.request.trigger.channelId on Android), we trust it;
        // otherwise we mark the data payload so downstream readers (foreground
        // toast, in-app banner) can pick the right styling/sound. The actual
        // channel is honored at the OS level when the system displays the
        // notification — this just mirrors the routing into JS state for
        // foreground UI.
        if (Platform.OS === 'android' && data?.type === 'chat_message') {
          const isGroup = data.is_group === '1' || data.is_group === true || data.is_group === 'true';
          // Mutate data so the foreground toast helper sees the intended
          // channel without re-deriving from is_group everywhere.
          data.__channel = isGroup ? 'chat_group' : 'chat_dm';
        }

        // Per-conversation notification settings (set in
        // ChatNotificationSettingsSheet → cached locally as JSON in
        // AsyncStorage so we can read it sync-ish from this handler).
        // Honors:
        //  - mute_until: silence message-typed pushes when in window
        //  - mention_exception (groups only): bypass mute on @everyone /
        //    @currentEmail mentions so the user still hears important calls
        //  - notify_messages: master switch — overrides everything
        //  - preview: redact body when off (matches WhatsApp "Hide preview")
        if (data?.conversation_id && data?.type === 'chat_message') {
          const convSettings = await _readConvSettings(data.conversation_id);
          if (convSettings) {
            // Master switch off → silent no matter what
            if (convSettings.notify_messages === false) {
              return { shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: true };
            }
            const mutedNow = _isMutedNow(convSettings.mute_until);
            const mentioned = await _pushMentionsCurrentUser(data, notification.request?.content);
            const allowMention = mutedNow && convSettings.mention_exception !== false && mentioned;
            if (mutedNow && !allowMention) {
              // Silent — the badge still increments so the chat list shows it.
              return { shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: true };
            }
            // Sound/vibration overrides flow through Android channels — here
            // we just gate alert/sound globally. "silent" sound silences the
            // foreground tone; vibration off is honored at OS level.
            const wantSound = convSettings.sound !== 'silent';
            // Foreground toast: redact body when preview is disabled.
            if (_onForegroundNotification) {
              const body = convSettings.preview === false
                ? null
                : notification.request.content.body;
              _onForegroundNotification({
                title: notification.request.content.title,
                body,
                data,
              });
              return {
                shouldShowAlert: false,
                shouldPlaySound: wantSound,
                shouldSetBadge: true,
              };
            }
            return {
              shouldShowAlert: true,
              shouldPlaySound: wantSound,
              shouldSetBadge: true,
            };
          }
        }

        // Other notifications in foreground: show toast
        // [2026-10-20 newemail-call] sem título E sem corpo = push técnico → não
        // vira toast genérico ("New email" era o fallback do título).
        const _otherTitle = String(notification.request?.content?.title || '').trim();
        const _otherBody = String(notification.request?.content?.body || '').trim();
        if (!_otherTitle && !_otherBody && globalThis.__chatyy_fg_callctl_drop !== false) {
          return { shouldShowAlert: false, shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false };
        }
        if (_onForegroundNotification && data) {
          _onForegroundNotification({
            title: notification.request.content.title,
            body: notification.request.content.body,
            data,
          });
          return {
            shouldShowAlert: false,
            shouldPlaySound: false,
            shouldSetBadge: true,
          };
        }
        return {
          shouldShowAlert: true,
          shouldPlaySound: true,
          shouldSetBadge: true,
        };
      },
    });
  }
  return true;
}

// Read per-conversation notification settings from the local cache mirror
// that ChatNotificationSettingsSheet writes on save. Best-effort — returns
// null if no AsyncStorage entry exists, in which case the handler falls
// through to the default "show alert + play sound" path.
async function _readConvSettings(conversationId) {
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    const raw = await AsyncStorage.getItem(`chat_notif_settings_${conversationId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function _isMutedNow(muteUntil) {
  if (!muteUntil) return false;
  const t = Date.parse(muteUntil);
  if (!Number.isFinite(t)) return false;
  return t > Date.now();
}

// Returns true when the incoming chat-message push contains an @mention
// addressed to the currently-active user. Inspects:
//   - data.mentions  (array of emails sent by the backend, fast path)
//   - data.mention_everyone (server-set when message has @everyone/@all)
//   - notification body fallback for "@username" / "@email" — covers older
//     server payloads that don't ship a mentions[] hint.
async function _pushMentionsCurrentUser(data, content) {
  try {
    if (data?.mention_everyone === '1' || data?.mention_everyone === true) return true;
    let me = '';
    try {
      const { getActiveAccountEmail } = require('./api');
      me = (typeof getActiveAccountEmail === 'function' ? getActiveAccountEmail() : '') || '';
    } catch {}
    if (!me) return false;
    me = String(me).toLowerCase();
    if (Array.isArray(data?.mentions)) {
      const list = data.mentions.map(m => String(m || '').toLowerCase());
      if (list.includes(me) || list.includes('everyone') || list.includes('all')) return true;
    }
    const body = String(content?.body || '').toLowerCase();
    if (!body) return false;
    if (body.includes('@everyone') || body.includes('@all')) return true;
    const username = me.split('@')[0];
    // Word-boundary match — prevents a body like "@usernamefoo" matching
    // "username". Also matches the full email form ("@user@domain").
    const re = new RegExp(`@(${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'i');
    return re.test(body);
  } catch {
    return false;
  }
}

// [2026-10-07 native-polish] Set when the last registerForPushNotifications()
// deliberately skipped the OS dialog (pre-permission primer pending), so
// ensurePushTokenFresh doesn't count it as a failure (stale banner).
let _lastRegisterDeferred = false;
// [2026-10-09 wa-real #15] marcador "já pedimos a permissão de push uma vez".
const PUSH_PERM_ASKED_KEY = 'push_perm_asked_v1';

export async function registerForPushNotifications(opts = {}) {
  _lastRegisterDeferred = false;
  _lastRegError = '';
  _diagPush('register_start', Platform.OS);
  try {
    const loaded = await loadModules();
    _diagPush('load_modules', loaded ? 'ok' : 'failed');
    if (!loaded) return null;

    // 2026-05-12: Removed hard return on !Device.isDevice. Keeping the log via
    // diag so we can SEE when isDevice is false (potential root cause of zero
    // Android tokens system-wide). Letting registration proceed anyway —
    // worst case Expo Push fails further down and we record THAT in the diag.
    if (!Device.isDevice) {
      _diagPush('not_device_continuing', 'isDevice=' + String(Device.isDevice) + ' brand=' + String(Device.brand || '?') + ' modelName=' + String(Device.modelName || '?'));
    }

    const _existingPerm = await Notifications.getPermissionsAsync();
    let existingStatus = _existingPerm?.status;
    // [2026-10-18 push-coverage] Android 13+: o expo-notifications devolve
    // status 'denied' (canAskAgain=true) para POST_NOTIFICATIONS NUNCA pedida —
    // NotificationPermissionsModule.kt força DENIED quando
    // areNotificationsEnabled()=false, e antes do 1º pedido é sempre false.
    // A regra "pedir 1×" abaixo lia isso como "negado" e NUNCA mostrava o
    // diálogo (desde 09/10: 6 pedidos no Android inteiro; 25 aparelhos
    // 'denied:blocked'; cobertura Android 27%). Nunca pedimos neste aparelho +
    // o SO ainda deixa pedir → é 'undetermined' (primer → diálogo do SO).
    if (Platform.OS === 'android' && existingStatus === 'denied' && _existingPerm?.canAskAgain !== false) {
      let _askedBefore = false;
      try { _askedBefore = !!getJSON(PUSH_PERM_ASKED_KEY, false); } catch {}
      if (!_askedBefore) {
        existingStatus = 'undetermined';
        _diagPush('perm_android_never_asked', 'denied->undetermined');
      }
    }
    _diagPush('existing_perm', existingStatus);
    _lastPermStatus = String(existingStatus || '');
    let finalStatus = existingStatus;

    // [2026-10-07 native-polish] Pre-permission primer (gap P0-6: 56% of
    // iPhones denied the raw dialog shown right after login). On the
    // AUTOMATIC path (cold start / login / foreground) with the permission
    // still undetermined, don't pop the OS dialog — the in-app primer
    // (components/PushPermissionPrimer.js) asks first, in context.
    // iOS: request PROVISIONAL meanwhile (no dialog; quiet delivery to
    // Notification Center) so the token + NSE device-ack still work.
    // iOS provisional reports status 'undetermined' with ios.status === 3.
    const _iosProvisional = Platform.OS === 'ios' && _existingPerm?.ios?.status === 3;
    const _userInitiated = !!(opts.userInitiated || opts.fromPrimer);
    let _primerGate = false;
    let _androidPrimerExhausted = false;
    try {
      const primer = require('./pushPrimer');
      _primerGate = !!primer.PUSH_PRIMER_ENABLED
        && !_userInitiated
        && existingStatus === 'undetermined'
        && _existingPerm?.canAskAgain !== false;
      primer.markPushPrimerNeeded(_primerGate);
    } catch {}
    if (_primerGate) {
      if (Platform.OS === 'ios') {
        if (!_iosProvisional) {
          try {
            const prov = await Notifications.requestPermissionsAsync({
              ios: { allowAlert: true, allowBadge: true, allowSound: true, allowProvisional: true },
            });
            _diagPush('primer_provisional', String(prov?.ios?.status ?? prov?.status));
          } catch (e) {
            _diagPush('primer_provisional_err', e?.message || String(e));
          }
        }
        // Provisional (or still undetermined): fall through to token
        // registration below — APNs registration doesn't need authorization.
        finalStatus = 'granted';
      } else {
        // Android 13+: no quiet mode; wait for the primer (no OS dialog now).
        // [2026-10-13 push-token-always] …mas o TOKEN sai já: FCM não precisa
        // de POST_NOTIFICATIONS (push de dados / ✓✓ de entrega / ligação).
        _lastRegisterDeferred = true;
        _diagPush('primer_deferred', existingStatus);
        // [2026-10-18 push-coverage] Primer recusado no teto (4×): sem banner o
        // usuário nunca mais via como ligar. Liga o aviso da lista de conversas
        // (rate-limited no PushTokenStaleBanner; "Ativar" = diálogo do SO).
        try {
          const _ps = getJSON('push_primer_v1', null);
          if (_ps && !_ps.done && Number(_ps.offers) >= 4) _androidPrimerExhausted = true;
        } catch {}
      }
    } else if (existingStatus !== 'granted') {
      // [2026-10-09 wa-real #15] Pedir UMA vez. Um iPhone "pediu" 58× com
      // status denied (iOS nunca mais mostra o diálogo depois do 1º "Não"; a
      // chamada só devolvia denied a cada boot e o usuário ficava sem aviso).
      // Caminho automático: se o SO não deixa pedir de novo (canAskAgain
      // false / denied) ou já pedimos uma vez neste aparelho → não chama o
      // diálogo; liga o aviso "Ativar nos Ajustes" (PushTokenStaleBanner).
      let _askedOnce = false;
      try { _askedOnce = !!getJSON(PUSH_PERM_ASKED_KEY, false); } catch {}
      const _osBlocked = _existingPerm?.canAskAgain === false || existingStatus === 'denied';
      if (!_userInitiated && (_osBlocked || _askedOnce)) {
        finalStatus = existingStatus;
        _diagPush('perm_skip_settings', String(existingStatus) + (_osBlocked ? ':blocked' : ':asked'));
      } else {
        const { status } = await Notifications.requestPermissionsAsync({
          ios: {
            allowAlert: true,
            allowBadge: true,
            allowSound: true,
            allowProvisional: false,
          },
        });
        finalStatus = status;
        try { setJSON(PUSH_PERM_ASKED_KEY, true); } catch {}
        _diagPush('request_perm', finalStatus);
      }
    }
    // Aviso persistente que leva aos Ajustes enquanto a permissão estiver negada.
    // [entregue 2026-10-20] Android: depois do 1º "Agora não" (boas-vindas ou
    // primer) o cartão discreto "Notificações desativadas → Ativar" já aparece
    // na lista (antes só após 4 recusas = dias sem notificação e sem saber).
    let _androidDeclinedOnce = false;
    if (Platform.OS === 'android' && _primerGate && !_androidPrimerExhausted) {
      try {
        const _ps2 = getJSON('push_primer_v1', null);
        if (_ps2 && !_ps2.done && Number(_ps2.offers) >= 1) _androidDeclinedOnce = true;
      } catch {}
    }
    try { globalThis.__chatyy_push_denied = (finalStatus !== 'granted' && (!_primerGate || _androidPrimerExhausted || _androidDeclinedOnce)); } catch {}

    _lastPermStatus = (Platform.OS === 'ios' && _primerGate) ? 'provisional' : String(finalStatus || '');
    _lastRegisterPerm = _lastPermStatus || String(finalStatus || '');
    if (finalStatus !== 'granted') {
      // [2026-10-13 push-token-always] Antes: return null → aparelho com
      // permissão negada ficava SEM token no servidor (118 "perm_denied" em
      // 7 dias): sem push silencioso, sem ✓✓ de entrega, e ao reativar nos
      // Ajustes nada era re-registrado. Agora o token é registrado do mesmo
      // jeito (com notif_perm) — o SO só descarta o alerta.
      _diagPush('perm_denied', finalStatus + ':token_anyway');
    }

    // Android notification channels.
    // [2026-10-06 android-audit] Moved BEFORE getExpoPushTokenAsync: channel
    // creation needs no token, and a token failure (SERVICE_NOT_AVAILABLE,
    // missing FCM creds) used to skip it → native chat pushes to channel 'chat'
    // were dropped by Android (no channel). Order is now permission → channels → token.
    //
    // setNotificationChannelAsync is idempotent at the OS level (re-calling
    // with the same id updates the existing channel, it does NOT create a
    // duplicate), but it's a relatively expensive native round-trip and
    // re-running the whole block on every registerForPushNotifications() call
    // (which fires on every 6h foreground refresh) is wasted work. We guard
    // it behind a versioned AsyncStorage flag: the set only (re)registers
    // when the CHANNELS_VERSION below changes. Bump CHANNELS_VERSION whenever
    // a channel definition is added/changed so existing installs pick it up
    // on their next foreground.
    if (Platform.OS === 'android') {
      const CHANNELS_VERSION = 2;
      const CHANNELS_FLAG_KEY = `channels_v${CHANNELS_VERSION}_created`;
      // [2026-10-06 android-audit] ALWAYS (re)create. The AsyncStorage flag
      // survives a Google backup/restore but the OS channels don't, and the
      // native ChatMessagingStyleHandler posts straight to 'chat'/'chat_keyword'
      // with no fallback — a missing channel = push silently dropped by Android.
      // setNotificationChannelAsync is idempotent and cheap (≈10 native calls,
      // throttled to 1×/6h by ensurePushTokenFresh).
      const _channelsAlreadyCreated = false;

      if (!_channelsAlreadyCreated) {
      // Main email channel
      await Notifications.setNotificationChannelAsync('email', {
        name: 'New Emails',
        description: 'Notifications for new emails',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 200, 100, 200],
        lightColor: '#A582F7',
        sound: 'default',
        enableLights: true,
        enableVibrate: true,
        showBadge: true,
      });

      // Chat channel — legacy bucket kept for backward compat with pushes
      // sent before the chat_dm / chat_group split landed. New pushes from
      // backend use the more specific channels below so users can fine-tune
      // DMs and group chats separately in the system notification UI.
      await Notifications.setNotificationChannelAsync('chat', {
        name: 'Chat Messages',
        description: 'Notifications for new chat messages',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 150, 80, 150],
        lightColor: '#10b981',
        sound: 'default',
        enableLights: true,
        enableVibrate: true,
        showBadge: true,
      });

      // chat_dm — direct messages (1:1). HIGH importance + default sound +
      // vibration so DMs feel like WhatsApp/Signal 1:1s. Backend tags the
      // FCM payload with channelId 'chat_dm' when conversation has 2
      // members (is_group=false). i18n.notif.channel.dm provides the
      // localized title — Android caches the channel name across launches,
      // so the localized string is only rebuilt on next install/upgrade.
      await Notifications.setNotificationChannelAsync('chat_dm', {
        name: 'Mensagens diretas',
        description: 'Notificações de conversas individuais (1:1)',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 150, 80, 150],
        lightColor: '#10b981',
        sound: 'default',
        enableLights: true,
        enableVibrate: true,
        showBadge: true,
      });

      // chat_group — group chats. DEFAULT importance + silent sound to
      // avoid waking the user every time a 200-member group pings.
      // Mirrors WhatsApp: groups go to the quiet bucket by default and
      // users opt back into sound per-group via the conversation settings
      // sheet (which writes chat_user_conv_settings.sound override).
      await Notifications.setNotificationChannelAsync('chat_group', {
        name: 'Grupos',
        description: 'Notificações de conversas em grupo',
        importance: Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 100],
        lightColor: '#3b82f6',
        // null sound = system silent for this channel. Group pushes still
        // show in the tray + drop a badge; they just don't ping audibly
        // unless the user flips the channel sound from system settings.
        sound: null,
        enableLights: true,
        enableVibrate: false,
        showBadge: true,
      });

      // [notif-p0p1] Keyword-highlight channel — used when a chat msg
      // matches one of the user's per-keyword highlights (Slack-style
      // "notify when someone says X"). MAX importance + distinct sound so
      // it pierces silently-muted general chat noise.
      await Notifications.setNotificationChannelAsync('chat_keyword', {
        name: 'Chat — Palavras-chave',
        description: 'Mensagens que contêm uma palavra-chave que você configurou',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 200, 100, 200, 100, 200],
        lightColor: '#ef4444',
        sound: 'default',
        enableLights: true,
        enableVibrate: true,
        showBadge: true,
        bypassDnd: false,
      });

      // chat_mention — someone @-mentioned the user in a chat (DM or group).
      // HIGH importance + default sound + vibration so a direct mention
      // pierces the quiet group bucket. Mirrors the iOS 'chat_mention'
      // category. Backend (firebase_push.php) tags the FCM payload with
      // channelId 'chat_mention' when the message @-mentions the recipient.
      await Notifications.setNotificationChannelAsync('chat_mention', {
        name: 'Chat — Menções',
        description: 'Quando alguém menciona você (@) em uma conversa',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 200, 100, 200],
        lightColor: '#A582F7',
        sound: 'default',
        enableLights: true,
        enableVibrate: true,
        showBadge: true,
        bypassDnd: false,
      });

      // chat_reaction — someone reacted (emoji) to one of the user's
      // messages. LOW importance + silent so reactions don't ping audibly
      // (WhatsApp/Telegram both keep reactions quiet); they still show in the
      // tray. Mirrors the iOS 'chat_reaction' category. Backend tags the FCM
      // payload with channelId 'chat_reaction' for reaction pushes.
      await Notifications.setNotificationChannelAsync('chat_reaction', {
        name: 'Chat — Reações',
        description: 'Quando alguém reage a uma mensagem sua',
        importance: Notifications.AndroidImportance.LOW,
        vibrationPattern: [0, 100],
        lightColor: '#f59e0b',
        // null sound = system silent for this channel.
        sound: null,
        enableLights: true,
        enableVibrate: false,
        showBadge: true,
        bypassDnd: false,
      });

      // Call channel - highest priority with custom ringtone
      await Notifications.setNotificationChannelAsync('calls', {
        name: 'Incoming Calls',
        description: 'Notifications for incoming voice and video calls',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 800, 400, 800, 200, 800, 400, 800, 2000],
        lightColor: '#22c55e',
        sound: 'ringtone.wav',
        enableLights: true,
        enableVibrate: true,
        showBadge: true,
        lockscreenVisibility: 1,
        bypassDnd: true,
      });

      // Social channel (likes, comments, follows, mentions) — low priority to avoid noise
      await Notifications.setNotificationChannelAsync('social', {
        name: 'Social',
        description: 'Likes, comentários, seguidores e menções',
        importance: Notifications.AndroidImportance.LOW,
        vibrationPattern: [0, 100],
        lightColor: '#f59e0b',
        sound: 'default',
        enableLights: true,
        enableVibrate: false,
        showBadge: true,
      });

      // (Removed duplicate 'email' channel that re-registered at DEFAULT
      //  importance right after the HIGH one above — Android overrode the
      //  HIGH priority with DEFAULT, silently dropping email notifications
      //  into the low-priority bucket.)

      // Also keep default channel for backward compat
      await Notifications.setNotificationChannelAsync('default', {
        name: 'General',
        importance: Notifications.AndroidImportance.DEFAULT,
        sound: 'default',
      });

        // Mark this channel-set version as created so the block is skipped on
        // subsequent registrations until CHANNELS_VERSION is bumped.
        try {
          const AsyncStorage = require('@react-native-async-storage/async-storage').default;
          await AsyncStorage.setItem(CHANNELS_FLAG_KEY, '1');
        } catch {}
      }
    }

    // Em standalone production builds expoConfig pode estar undefined —
    // easConfig.projectId é o fallback documentado.
    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    _diagPush('project_id', projectId || 'undefined');
    // #836: Android cold-start race vs Google Play Services → SERVICE_NOT_AVAILABLE.
    // Retry 4× com backoff (250ms → 750ms → 1500ms → 3000ms) antes de desistir.
    let tokenData;
    let lastErr = null;
    const _retryDelays = [0, 250, 750, 1500, 3000];
    for (let attempt = 0; attempt < _retryDelays.length; attempt++) {
      if (_retryDelays[attempt] > 0) {
        await new Promise(r => setTimeout(r, _retryDelays[attempt]));
      }
      try {
        tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
        if (tokenData?.data) {
          _diagPush('expo_token', 'len=' + String(tokenData.data).length + (attempt > 0 ? ' attempt=' + (attempt + 1) : ''));
          lastErr = null;
          break;
        }
        _diagPush('expo_token_empty_attempt' + (attempt + 1), 'no data');
      } catch (e) {
        lastErr = e;
        const msg = e?.message || String(e);
        _diagPush('expo_token_err_attempt' + (attempt + 1), msg);
        // Não retry em erros não-transient
        if (!/SERVICE_NOT_AVAILABLE|TIMEOUT|TIMEDOUT|network/i.test(msg)) break;
      }
    }
    // [2026-10-13 push-token-always] Falha do Expo (exp.host fora, projeto sem
    // credencial, SERVICE_NOT_AVAILABLE) NÃO aborta mais o registro: o token
    // NATIVO (FCM/APNs, abaixo) é o transporte principal e sai mesmo assim.
    // Só desiste no fim se nem Expo nem nativo vierem.
    const _expoErr = (lastErr || !tokenData?.data) ? (lastErr || new Error('no expo token after retries')) : null;
    if (_expoErr) {
      _diagPush('expo_token_err_final', _expoErr.message || String(_expoErr));
      _noteRegError('expo', _expoErr.message || String(_expoErr));
      tokenData = null;
    } else {
      pushNotificationsState.expoToken = tokenData.data;
    }

    // Register notification categories with actions
    // [2026-10-18 push-coverage] Categorias FORA do caminho do token: eram ~12
    // chamadas nativas aguardadas ANTES do getDevicePushTokenAsync / envio ao
    // servidor (≈4 s). Conta nova que fechava o app nesse intervalo ficava sem
    // token nenhum (Android 10-17: expo_token e nada depois). Rodam em paralelo.
    (async () => {
      await Notifications.setNotificationCategoryAsync('EMAIL', [
        {
          identifier: 'REPLY',
          buttonTitle: 'Responder',
          options: { opensAppToForeground: true },
        },
        {
          identifier: 'ARCHIVE',
          buttonTitle: 'Arquivar',
          options: { isDestructive: false },
        },
        {
          identifier: 'DELETE',
          buttonTitle: 'Excluir',
          options: { isDestructive: true },
        },
      ]);

      // [2026-10-05] Action button titles follow the app language (pt/en/es).
      const L = await _notifActionLabels();

      await Notifications.setNotificationCategoryAsync('CHAT', [
        {
          identifier: 'REPLY',
          buttonTitle: L.reply,
          textInput: {
            submitButtonTitle: L.send,
            placeholder: L.placeholder,
          },
        },
        {
          identifier: 'MARK_READ',
          buttonTitle: L.markRead,
        },
      ]);

      // chat_message — canonical category sent by backend (firebase_push.php sets
      // categoryId: 'chat_message' in the FCM data payload when type === 'chat_message').
      // WhatsApp/iMessage-style quick reply: user types inline without opening app.
      // expo-notifications maps this to a RemoteInput action on Android FCM too.
      await Notifications.setNotificationCategoryAsync('chat_message', [
        {
          identifier: 'reply',
          buttonTitle: L.reply,
          textInput: {
            submitButtonTitle: L.send,
            placeholder: L.placeholder,
          },
          options: { isDestructive: false, isAuthenticationRequired: false, opensAppToForeground: false },
        },
        {
          identifier: 'mark_read',
          buttonTitle: L.markRead,
          options: { isDestructive: false, isAuthenticationRequired: false, opensAppToForeground: false },
        },
        // [2026-10-12 push-parity] WhatsApp mute options straight from the banner
        // (iOS shows all 4 on long-press; Android expo-rendered shows the first 3).
        // Handled natively with the app killed (ChatNotifActions / ChatActionReceiver).
        {
          identifier: 'mute_8h',
          buttonTitle: L.mute8h,
          options: { isDestructive: false, isAuthenticationRequired: false, opensAppToForeground: false },
        },
        {
          identifier: 'mute_1w',
          buttonTitle: L.mute1w,
          options: { isDestructive: false, isAuthenticationRequired: false, opensAppToForeground: false },
        },
      ]);

      await Notifications.setNotificationCategoryAsync('new_email', [
        {
          identifier: 'archive',
          buttonTitle: 'Arquivar',
          options: { isDestructive: false },
        },
        {
          identifier: 'mark_read',
          buttonTitle: 'Marcar como lido',
          options: { isDestructive: false },
        },
      ]);

      // email_new — canonical category ID sent by the backend (matches categoryId in FCM payload)
      await Notifications.setNotificationCategoryAsync('email_new', [
        {
          identifier: 'REPLY',
          buttonTitle: 'Responder',
          options: { opensAppToForeground: true },
        },
        {
          identifier: 'ARCHIVE',
          buttonTitle: 'Arquivar',
          options: { isDestructive: false },
        },
        {
          identifier: 'DELETE',
          buttonTitle: 'Excluir',
          options: { isDestructive: true },
        },
      ]);

      // chat_mention — @mention in a group; opens conversation directly
      await Notifications.setNotificationCategoryAsync('chat_mention', [
        {
          identifier: 'REPLY',
          buttonTitle: L.reply,
          textInput: {
            submitButtonTitle: L.send,
            placeholder: L.replyMention,
          },
          options: { isDestructive: false, isAuthenticationRequired: false, opensAppToForeground: false },
        },
        {
          identifier: 'MARK_READ',
          buttonTitle: L.markRead,
          options: { isDestructive: false, isAuthenticationRequired: false, opensAppToForeground: false },
        },
        // [2026-10-12 push-parity] WhatsApp mute options straight from the banner
        // (iOS shows all 4 on long-press; Android expo-rendered shows the first 3).
        // Handled natively with the app killed (ChatNotifActions / ChatActionReceiver).
        {
          identifier: 'mute_8h',
          buttonTitle: L.mute8h,
          options: { isDestructive: false, isAuthenticationRequired: false, opensAppToForeground: false },
        },
        {
          identifier: 'mute_1w',
          buttonTitle: L.mute1w,
          options: { isDestructive: false, isAuthenticationRequired: false, opensAppToForeground: false },
        },
      ]);

      // [notif-p0p1] chat_reaction — someone reacted to one of your msgs.
      // Single action to jump straight to the original message; no reply
      // (you'd reply via the normal chat_message category if you tap reply
      // on the threaded conversation).
      await Notifications.setNotificationCategoryAsync('chat_reaction', [
        {
          identifier: 'view',
          buttonTitle: 'Ver',
          options: { opensAppToForeground: true },
        },
        {
          identifier: 'reply',
          buttonTitle: 'Responder',
          textInput: { submitButtonTitle: 'Enviar', placeholder: 'Mensagem...' },
        },
      ]);

      // [notif-p0p1] Generic mute action on chat — also surfaced inside the
      // dynamic smart-reply category registered by the NSE per-notification.
      // This static category is the fallback for clients that haven't
      // upgraded to the NSE pathway yet (older iOS / web).
      await Notifications.setNotificationCategoryAsync('chat_with_mute', [
        {
          identifier: 'reply',
          buttonTitle: L.reply,
          textInput: { submitButtonTitle: L.send, placeholder: L.placeholder },
        },
        { identifier: 'mark_read', buttonTitle: L.markRead },
        { identifier: 'mute_8h', buttonTitle: L.mute8h },
        { identifier: 'snooze_1h', buttonTitle: L.snooze1h },
      ]);

      // feed_like / feed_comment / feed_follow — social actions (view only, no text reply)
      for (const cat of ['feed_like', 'feed_comment', 'feed_follow']) {
        await Notifications.setNotificationCategoryAsync(cat, [
          {
            identifier: 'VIEW',
            buttonTitle: 'Ver',
            options: { opensAppToForeground: true },
          },
        ]);
      }

      // live_start — someone started a Live broadcast
      await Notifications.setNotificationCategoryAsync('live_start', [
        {
          identifier: 'JOIN',
          buttonTitle: 'Entrar ao vivo',
          options: { opensAppToForeground: true },
        },
        {
          identifier: 'DISMISS',
          buttonTitle: 'Ignorar',
          options: { isDestructive: false },
        },
      ]);

      // missed_call — fired when caller hung up before we picked up (or we
      // declined). Single action "Ligar de volta" that dials the caller back
      // through /call.js as the initiator. Pairs with the Android side handled
      // by ChatActionReceiver.ACTION_CALL_BACK so both platforms surface the
      // same shortcut without opening the app first.
      await Notifications.setNotificationCategoryAsync('missed_call', [
        {
          identifier: 'CALL_BACK',
          // i18n.notif.missedCall.callBack mirrors this — kept here as a
          // hard-coded fallback because UNNotificationAction titles are
          // rendered by iOS, not by our JS, so they need the literal string
          // at registration time. The active language is read from the
          // running app, but iOS caches the category between launches so
          // the title only updates after the app foregrounds.
          buttonTitle: 'Ligar de volta',
          options: { isDestructive: false, isAuthenticationRequired: false, opensAppToForeground: true },
        },
      ]);

      await Notifications.setNotificationCategoryAsync('incoming_call', [
        {
          identifier: 'accept_call',
          buttonTitle: 'Accept',
          options: { isDestructive: false, isAuthenticationRequired: false, opensAppToForeground: true },
        },
        {
          identifier: 'decline_call',
          buttonTitle: 'Decline',
          options: { isDestructive: true, isAuthenticationRequired: false },
        },
      ]);
    })().catch((e) => { _diagPush('categories_err', e?.message || String(e)); });

    // On Android, also get the raw device FCM token.
    // This is needed for incoming call notifications: data-only FCM messages
    // must be sent directly to the FCM token (not via Expo Push) to ensure
    // they reach our CallFirebaseMessagingService when the app is killed.
    if (Platform.OS === 'android') {
      // Reset any stale value from a previous registration attempt so we
      // never register a token that belongs to a different install.
      pushNotificationsState.deviceToken = null;

      // Try up to FIVE times with backoff — Firebase's first install handshake
      // can be slow on cold start, slow networks, or after Google Play Services
      // updates. WITHOUT fcm_device token, the user gets ZERO Android pushes
      // because Expo Push for Android needs FCM Server Key uploaded to Expo
      // creds (not currently configured). 5 attempts × 1.5s delay = 7.5s max.
      // Incident 2026-05-12 round 2: only Expo token registered, no fcm_device,
      // so all chat pushes failed with InvalidCredentials and never delivered.
      let deviceToken = null;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          deviceToken = await Notifications.getDevicePushTokenAsync();
          _diagPush('fcm_device_attempt_' + attempt, deviceToken?.data ? ('type=' + (deviceToken.type || '?') + ' len=' + String(deviceToken.data).length) : ('type=' + (deviceToken?.type || '?') + ' empty'));
          if (deviceToken?.data) break;
        } catch (err) {
          _diagPush('fcm_device_err_' + attempt, err?.message || String(err));
          deviceToken = null;
        }
        if (attempt < 5) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }

      if (deviceToken?.data) {
        pushNotificationsState.deviceToken = deviceToken.data;
        _lastGoodAndroidDeviceToken = deviceToken.data; // [2026-10-17 fcm-race]
        _diagPush('fcm_device_ok', 'type=' + (deviceToken.type || '?'));
      } else {
        _diagPush('fcm_device_missing', 'no fcm token after retry');
        _noteRegError('fcm_missing');
      }
    }

    // [2026-10-09 native-transport] iOS: token APNs NATIVO (hex) além do Expo.
    // O backend (firebase_push.php) manda direto na Apple (HTTP/2 + chave .p8)
    // quando o aparelho tem os dois — sem o salto exp.host — e usa o Expo como
    // fallback se a Apple falhar. Pareamento com o token Expo do MESMO aparelho
    // via device_id "expo:<id>" (evita banner duplo). Ambiente: build de
    // desenvolvimento (aps-environment=development) → sandbox.
    if (Platform.OS === 'ios') {
      pushNotificationsState.apnsToken = null;
      pushNotificationsState.apnsTokenType = null;
      try {
        // [2026-10-13] 2 tentativas (o 1º registerForRemoteNotifications do
        // boot às vezes volta antes da Apple responder).
        let dt = null;
        for (let a = 1; a <= 2; a++) {
          try { dt = await Notifications.getDevicePushTokenAsync(); } catch (e) { if (a === 2) throw e; }
          if (dt?.data) break;
          await new Promise((r) => setTimeout(r, 1200));
        }
        if (dt?.data && typeof dt.data === 'string' && /^[0-9a-fA-F]{32,200}$/.test(dt.data)) {
          let env = null;
          try {
            const App = require('expo-application');
            if (App && typeof App.getIosPushNotificationServiceEnvironmentAsync === 'function') {
              env = await App.getIosPushNotificationServiceEnvironmentAsync();
            }
          } catch {}
          pushNotificationsState.apnsToken = dt.data.toLowerCase();
          pushNotificationsState.apnsTokenType = env === 'development' ? 'apns_sandbox' : 'apns';
          _diagPush('apns_device_ok', 'len=' + dt.data.length + ' env=' + (env || 'null'));
        } else {
          _diagPush('apns_device_missing', 'type=' + (dt?.type || '?'));
          _noteRegError('apns_missing');
        }
      } catch (err) {
        _diagPush('apns_device_err', err?.message || String(err));
        _noteRegError('apns_err', err?.message || String(err));
      }
    }

    // [2026-10-13 push-token-always] Retorna o token Expo (fallback) quando
    // existe; senão o NATIVO — sendTokenToBackend registra o nativo de
    // qualquer jeito (e o Expo só se for mesmo um ExponentPushToken).
    const _nativeTok = pushNotificationsState.deviceToken || pushNotificationsState.apnsToken || null;
    if (!tokenData?.data && !_nativeTok) {
      _diagPush('register_no_token', _expoErr ? (_expoErr.message || String(_expoErr)) : 'none');
      if (_expoErr && lastErr) throw lastErr;
      return null;
    }
    if (tokenData?.data) { try { _setCachedPushToken(tokenData.data); } catch {} }
    _diagPush('register_done', tokenData?.data ? 'ok' : 'native_only');
    return tokenData?.data || _nativeTok;
  } catch (err) {
    _diagPush('register_failed', err?.message || String(err));
    _noteRegError('failed', err?.message || String(err));
    console.warn('[Push] Registration failed:', err.message);
    return null;
  }
}

// ============================================================
// PENDING TOKEN SENDS (offline retry)
// ============================================================
// If sendTokenToBackend() fails (network down, server 5xx, /etc/mail-api.env
// reload mid-deploy) we lose the token registration silently and the user
// never receives push notifications until the next 6h foreground refresh —
// which itself can fail forever in a row. The MMKV-backed queue below
// retries on every AppState foreground transition + WS auth ack, dedups by
// token, caps at 5 entries (LRU drop oldest) so we don't pile up forever
// across multi-account toggles.
const PENDING_TOKEN_SENDS_KEY = 'pending_token_sends';
const PENDING_TOKEN_SENDS_MAX = 5;
// Track tokens we've already successfully sent in this app session so two
// flushes (foreground + WS auth_ack firing back-to-back) don't re-POST the
// same {token, email} pair to the backend.
const _flushedTokensInSession = new Set();
// [perf] FIFO cap on the in-memory session dedup set. It's only ever added
// to (never pruned), so over a long-lived session with repeated token
// rotations / account switches it would grow without bound. 64 distinct
// {token|email|type} keys is far more than any real device produces; we
// drop the oldest insertion-order key once over the cap (Set preserves
// insertion order). Worst case of an evicted key is one redundant re-POST,
// which the backend dedups idempotently.
const _FLUSHED_TOKENS_MAX = 64;
// [2026-06-12 STORM FIX] token-rotation listener state (see listener below).
let _tokenRotationSub = null;
let _lastRotatedToken = null;
let _lastRotationHandledAt = 0;
// In-flight + interval guard for sendTokenToBackend: the rotation recursion
// fired it hundreds of times per second. One attempt at a time, and the same
// token is not re-POSTed more than once per 30s (success or fail — the
// pending queue covers retries on real failures).
// [2026-10-02] Keyed by token+account (was a global bool + token-only map).
// The device push token is CONSTANT across accounts, so keying the guards by
// token alone swallowed the (re)registration of the same token under a
// DIFFERENT account on a fast account switch — leaving the switched-to account
// push-deaf for 30s. A Set of in-flight keys also lets two accounts register
// the same device concurrently.
const _sendTokenInFlightKeys = new Set();
const _lastTokenSendAt = Object.create(null);
// Cold-start notification-tap replay guards (see setupNotificationListeners).
let _coldStartTapHandled = false;
let _lastHandledResponseId = null;
// [2026-10-12 nav-dedup] Every handled tap id (not just the last one): the
// cold-start replay (getLastNotificationResponseAsync) can arrive after the
// live listener already handled the same tap AND another tap in between.
const _handledResponseIds = new Set();
function _markFlushed(key) {
  if (!key) return;
  if (_flushedTokensInSession.has(key)) return;
  _flushedTokensInSession.add(key);
  if (_flushedTokensInSession.size > _FLUSHED_TOKENS_MAX) {
    const oldest = _flushedTokensInSession.values().next().value;
    _flushedTokensInSession.delete(oldest);
  }
}

function _readPendingTokenSends() {
  const v = getJSON(PENDING_TOKEN_SENDS_KEY);
  return Array.isArray(v) ? v : [];
}

function _writePendingTokenSends(arr) {
  setJSON(PENDING_TOKEN_SENDS_KEY, Array.isArray(arr) ? arr.slice(-PENDING_TOKEN_SENDS_MAX) : []);
}

function _enqueuePendingTokenSend(entry) {
  if (!entry?.token) return;
  const list = _readPendingTokenSends();
  // Dedup by (token, email, token_type). If an identical entry already
  // exists, refresh its ts (LRU bump) instead of duplicating — protects
  // against a user toggling foreground 20× while still offline.
  const sig = (e) => `${e.token}|${e.email || ''}|${e.token_type || ''}`;
  const incomingSig = sig(entry);
  const next = list.filter((e) => sig(e) !== incomingSig);
  next.push({ ...entry, ts: entry.ts || Date.now() });
  // LRU cap — drop OLDEST so the most recent token rotation always wins
  // (a rotated FCM token from the same install is more useful than a stale
  // entry from a previous session).
  while (next.length > PENDING_TOKEN_SENDS_MAX) next.shift();
  _writePendingTokenSends(next);
  _armPendingFlushTimer();
}

// Timed retry for the pending queue. flushPendingTokens() only fires on
// AppState foreground transition + WS auth_ack — a user who signs up and
// KEEPS the app in the foreground never retries in-session (real case
// 2026-07-04: fresh phone-first account hit the mailbox-heal window,
// register_push_token 500'd, and the user stayed dark on push/calls for
// hours because no foreground transition ever happened). One-shot timer,
// re-armed while entries remain, capped so a permanent failure can't
// poll forever.
let _pendingFlushTimer = null;
let _pendingFlushArms = 0;
const _PENDING_FLUSH_DELAY_MS = 150 * 1000;
const _PENDING_FLUSH_FIRST_DELAY_MS = 40 * 1000;
const _PENDING_FLUSH_MAX_ARMS = 8;
function _armPendingFlushTimer() {
  if (Platform.OS === 'web') return;
  if (_pendingFlushTimer) return;
  if (_pendingFlushArms >= _PENDING_FLUSH_MAX_ARMS) return;
  // [forense 2026-10-11] 1ª retentativa em 40s (antes 150s). Conta nova por
  // telefone: o homedir/push_tokens só nasce quando o drain-signups (timer de
  // 30s no host) roda; o register_push_token logo após o phone_signup volta
  // 500/503 e, com 150s, o usuário fechava o app antes da retentativa → ficou
  // SEM push/chamadas (11/10 00:50: 4× 500, tokens.json vazio 10h depois).
  const _delay = _pendingFlushArms === 0 ? _PENDING_FLUSH_FIRST_DELAY_MS : _PENDING_FLUSH_DELAY_MS;
  _pendingFlushArms++;
  _pendingFlushTimer = setTimeout(async () => {
    _pendingFlushTimer = null;
    try { await flushPendingTokens(); } catch {}
    try {
      if (_readPendingTokenSends().length) {
        _armPendingFlushTimer();
      } else {
        // Queue drained — reset the cap so a NEW failure later in a
        // long-lived session gets its own retry budget.
        _pendingFlushArms = 0;
      }
    } catch {}
  }, _delay);
}

async function _getActiveEmailSafe() {
  try {
    const { getActiveAccountEmail } = require('./api');
    return (typeof getActiveAccountEmail === 'function' ? getActiveAccountEmail() : '') || '';
  } catch { return ''; }
}

// ─── [2026-10-09 push-token-forever] "Só envia se mudou ou se faz >24h" ────
// Registro barato a cada abertura/volta ao primeiro plano: um token já
// confirmado pelo servidor para {conta, tipo, versão do app} nas últimas 24h
// não é re-enviado. Login/troca de conta (outra conta = outra chave),
// atualização do app (versão entra na chave), token rotacionado (outro token)
// e pedido de re-registro do servidor (bypass) sempre enviam.
const PUSH_SENT_CACHE_KEY = 'push_token_sent_v1';
const PUSH_RESEND_MS = 24 * 60 * 60 * 1000;
let _pushForceUntil = 0;
let _pushAppVersionCache = null;
function _pushAppVersion() {
  if (_pushAppVersionCache !== null) return _pushAppVersionCache;
  let out = '';
  try {
    let A = null;
    try { A = require('expo-application'); } catch {}
    const v = Constants?.expoConfig?.version || A?.nativeApplicationVersion || '';
    const b = A?.nativeBuildVersion || '';
    let ota = '';
    try {
      const U = require('expo-updates');
      if (U?.updateId) ota = String(U.updateId).slice(0, 8);
      else if (U?.isEmbeddedLaunch) ota = 'embedded';
    } catch {}
    out = `${v}${b ? '+' + b : ''}${ota ? ' ota:' + ota : ''}`.slice(0, 40);
  } catch {}
  _pushAppVersionCache = out;
  return out;
}
function _pushSentKey(token, email, type) {
  return `${String(email || '').toLowerCase()}|${type || 'expo'}|${token}`;
}
function _readPushSentCache() {
  try {
    const v = getJSON(PUSH_SENT_CACHE_KEY);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
// [2026-10-13] `perm` (opcional) entra na comparação: permissão de notificação
// mudou (negada → permitida nos Ajustes, ou o contrário) → re-envia na hora.
function _pushSentRecently(token, email, type, perm) {
  if (!token || Date.now() < _pushForceUntil) return false;
  const e = _readPushSentCache()[_pushSentKey(token, email, type)];
  if (e && perm !== undefined && String(e.p || '') !== String(perm || '')) return false;
  return !!(e && e.v === _pushAppVersion() && Date.now() - Number(e.at || 0) < PUSH_RESEND_MS);
}
function _markPushSent(token, email, type, perm) {
  if (!token) return;
  try {
    const c = _readPushSentCache();
    c[_pushSentKey(token, email, type)] = { at: Date.now(), v: _pushAppVersion(), p: String(perm || '') };
    const keys = Object.keys(c);
    if (keys.length > 40) {
      keys.sort((a, b) => Number(c[a]?.at || 0) - Number(c[b]?.at || 0));
      for (const k of keys.slice(0, keys.length - 40)) delete c[k];
    }
    setJSON(PUSH_SENT_CACHE_KEY, c);
  } catch {}
}
/** Esquece o "já enviado" de uma conta (logout / push desligado) — ou de todas. */
export function forgetSentPushTokens(email) {
  try {
    if (!email) { setJSON(PUSH_SENT_CACHE_KEY, {}); return; }
    const pre = String(email).toLowerCase() + '|';
    const c = _readPushSentCache();
    for (const k of Object.keys(c)) if (k.startsWith(pre)) delete c[k];
    setJSON(PUSH_SENT_CACHE_KEY, c);
  } catch {}
}
/**
 * Pedido de re-registro vindo do servidor (evento WS `push_reregister` ou
 * `push_rereg` na resposta do chat_sync): o servidor não tem token válido desta
 * conta → re-registra ignorando o cache de 24h. No máximo 1×/30 min.
 */
let _lastServerReregAt = 0;
export function requestPushReregister(reason) {
  if (Platform.OS === 'web') return;
  const now = Date.now();
  if (now - _lastServerReregAt < 30 * 60 * 1000) return;
  _lastServerReregAt = now;
  _pushForceUntil = now + 2 * 60 * 1000;
  _diagPush('server_rereg', String(reason || ''));
  ensurePushTokenFresh({ force: true }).catch(() => {});
}

// ─── [2026-10-17 push-durable] "Saúde do push" ───────────────────────────────
// O app pergunta ao servidor (push_token_health) se ELE tem um token válido
// deste aparelho no arquivo que o envio lê. Não tem (sumiu / revogado / visto há
// muito / pedido do servidor) → esquece o cache de "já enviado" desta conta e
// re-registra na hora — sem esperar o cache de 24h. No máximo 1×/3h por conta
// (cold start, volta ao app, login); falha de rede = tenta na próxima.
const PUSH_HEALTH_KEY = 'push_health_v1';
const PUSH_HEALTH_EVERY_MS = 3 * 60 * 60 * 1000;
let _pushHealthInFlight = false;
export async function checkPushHealth(opts = {}) {
  if (Platform.OS === 'web' || _pushHealthInFlight) return { skipped: true };
  const email = String((await _getActiveEmailSafe()) || '').toLowerCase();
  if (!email) return { skipped: true };
  const now = Date.now();
  let st = {};
  try { st = getJSON(PUSH_HEALTH_KEY) || {}; } catch {}
  if (!opts.force && st && st[email] && now - Number(st[email]) < PUSH_HEALTH_EVERY_MS) return { throttled: true };
  const tokens = [];
  const add = (t) => { if (typeof t === 'string' && t && !tokens.includes(t)) tokens.push(t); };
  add(pushNotificationsState.expoToken || _cachedPushToken);
  if (Platform.OS === 'android') add(pushNotificationsState.deviceToken);
  if (Platform.OS === 'ios') add(pushNotificationsState.apnsToken);
  if (!tokens.length) return { skipped: true };
  _pushHealthInFlight = true;
  try {
    const { apiCall } = require('./api');
    const r = await apiCall('push_token_health', {
      device_id: _pushDeviceId(_isExpoToken(tokens[0]) ? tokens[0] : null),
      tokens,
    }, 'POST');
    if (!r?.success) return { ok: false };
    try {
      const next = { ...(st && typeof st === 'object' ? st : {}), [email]: now };
      const ks = Object.keys(next);
      if (ks.length > 12) { ks.sort((a, b) => Number(next[a]) - Number(next[b])); for (const k of ks.slice(0, ks.length - 12)) delete next[k]; }
      setJSON(PUSH_HEALTH_KEY, next);
    } catch {}
    const d = r.data || {};
    if (d.reregister) {
      _diagPush('health_rereg', `missing=${Number(d.missing) || 0} live=${(d.entries || []).filter((e) => e && e.live).length}`);
      forgetSentPushTokens(email);
      _pushForceUntil = Date.now() + 2 * 60 * 1000;
      ensurePushTokenFresh({ force: true, _fromHealth: true }).catch(() => {});
      return { ok: true, reregistered: true };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false };
  } finally {
    _pushHealthInFlight = false;
  }
}

// Relata ao servidor o estado da permissão deste aparelho (granted/denied/…),
// p/ o painel separar "usuário negou" de "token sumiu". Só quando muda ou 1×/24h.
let _lastPermStatus = '';
const PUSH_PERM_REPORT_KEY = 'push_perm_report_v1';
function _pushInstallId() {
  try {
    let id = getJSON('push_install_id');
    if (typeof id === 'string' && id.length >= 8) return id;
    id = 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    setJSON('push_install_id', id);
    return id;
  } catch { return ''; }
}
async function _reportPushPermission(hasToken) {
  try {
    if (Platform.OS === 'web' || !_lastPermStatus) return;
    const email = await _getActiveEmailSafe();
    if (!email) return;
    const _regErr = String(_lastRegError || '').slice(0, 120);
    const sig = `${email.toLowerCase()}|${_lastPermStatus}|${hasToken ? 1 : 0}|${_pushAppVersion()}|${_regErr}`;
    const prev = getJSON(PUSH_PERM_REPORT_KEY) || {};
    if (prev.sig === sig && Date.now() - Number(prev.at || 0) < PUSH_RESEND_MS) return;
    const { apiCall } = require('./api');
    const r = await apiCall('push_permission_report', {
      install_id: _pushInstallId(),
      permission: _lastPermStatus,
      platform: Platform.OS,
      app_version: _pushAppVersion(),
      has_token: hasToken ? 1 : 0,
      reg_error: _regErr,
    }, 'POST');
    if (r?.success) setJSON(PUSH_PERM_REPORT_KEY, { sig, at: Date.now() });
  } catch {}
}

// Multi-conta no mesmo aparelho: o token do aparelho também é registrado nas
// OUTRAS contas logadas (cada uma com o próprio bearer), p/ o push de qualquer
// conta chegar — o toque já troca de conta (ensureNotificationAccount).
// Respeita o "push desligado" por conta. Best-effort, sem fila.
async function _registerForOtherAccounts(entries, activeEmail) {
  try {
    if (!Array.isArray(entries) || !entries.length) return;
    const api = require('./api');
    const accts = (typeof api.getStoredAccounts === 'function' ? api.getStoredAccounts() : []) || [];
    const url = typeof api.getApiUrl === 'function' ? api.getApiUrl() : '';
    if (!url || !Array.isArray(accts)) return;
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    const active = String(activeEmail || '').toLowerCase();
    try { if (active && typeof api.touchStoredAccount === 'function') api.touchStoredAccount(active); } catch {}
    let n = 0;
    for (const a of accts) {
      const em = String(a?.email || '').toLowerCase();
      if (!em || em === active || typeof a?.token !== 'string' || !a.token) continue;
      // [incidente-sessao 2026-10-14] conta parada há >30d neste aparelho
      // (ex.: outra pessoa que logou aqui uma vez) NÃO recebe push daqui.
      if (typeof api.isStoredAccountFresh === 'function' && !api.isStoredAccountFresh(a)) continue;
      if (++n > 4) break;
      try { if ((await AsyncStorage.getItem(`push_enabled:${em}`)) === 'false') continue; } catch {}
      for (const p of entries) {
        if (!p?.token || _pushSentRecently(p.token, em, p.token_type || 'expo', p.notif_perm)) continue;
        try {
          const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
          const to = setTimeout(() => { try { ctl?.abort(); } catch {} }, 8000);
          const resp = await fetch(`${url}?action=register_push_token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.token}` },
            // [incidente-sessao 2026-10-14] sem cookie: com bearer morto a sessão
            // PHP da conta ATIVA respondia (e registrava o token nela).
            credentials: 'omit',
            body: JSON.stringify(p),
            signal: ctl?.signal,
          });
          clearTimeout(to);
          const j = await resp.json().catch(() => null);
          if (j?.success) _markPushSent(p.token, em, p.token_type || 'expo', p.notif_perm);
          else {
            // [incidente-sessao 2026-10-14] bearer revogado → conta sai do aparelho.
            let gone = false;
            try { gone = require('./storedAccountRevocation').noteStoredAccountAuthResult({ email: em, token: a.token, status: resp.status, json: j, source: 'register_push_token' }); } catch {}
            if (gone) break;
          }
        } catch {}
      }
    }
  } catch {}
}

export async function sendTokenToBackend(pushToken) {
  if (!pushToken) return;
  // [2026-06-12 STORM FIX] hard re-entry + frequency guard.
  const _nowSend = Date.now();
  // Resolve the active account up-front so the re-entry + 30s frequency guards
  // are scoped to {token, account} — a different account must never be blocked
  // by a recent send of the same device token under the previous account.
  let _acctEmail = '';
  try { _acctEmail = (await _getActiveEmailSafe()) || ''; } catch {}
  const _key = pushToken + '|' + _acctEmail;
  if (_sendTokenInFlightKeys.has(_key)) return;
  if (_lastTokenSendAt[_key] && _nowSend - _lastTokenSendAt[_key] < 30 * 1000) return;
  _sendTokenInFlightKeys.add(_key);
  _lastTokenSendAt[_key] = _nowSend;
  try {
    return await _sendTokenToBackendInner(pushToken);
  } finally {
    _sendTokenInFlightKeys.delete(_key);
    // [2026-10-07 recv-native] login / account switch / token refresh all pass
    // here → keep the Android native reply/mark-read bearers in sync.
    syncNativeChatAuth(true).catch(() => {});
  }
}

// Two-letter language code of the UI: the user's manual choice (Settings →
// Idioma, mirrored to AsyncStorage by LanguageContext) wins, else the device
// locale (expo-localization), else 'pt'. Only pt/en/es are rendered server-side.
async function _deviceLangCode() {
  let code = '';
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    code = (await AsyncStorage.getItem('app_language_manual')) || '';
  } catch {}
  if (!code) {
    try {
      const Localization = require('expo-localization');
      const locs = Localization.getLocales?.() || [];
      code = locs[0]?.languageCode || Localization.locale || '';
    } catch {}
  }
  code = String(code || '').toLowerCase().slice(0, 2);
  // [2026-10-12 push-parity] 11 app languages; also sent as `lang` with the
  // push token so the server localizes previews (pt-BR/pt-PT → pt).
  return ['pt', 'en', 'es', 'fr', 'de', 'it', 'ja', 'ar', 'id', 'hi'].includes(code) ? code : 'pt';
}

// Localized titles for the notification ACTION buttons. iOS/Android render
// these natively from the registered category, so they must be literal strings
// at registration time (re-registered on every registerForPushNotifications).
// [2026-10-12 push-parity] 11 app languages (pt-BR/pt-PT → pt).
const _NOTIF_ACTION_LABELS = {
  pt: { newMessage: 'Nova mensagem', reply: 'Responder', send: 'Enviar', placeholder: 'Mensagem...', markRead: 'Marcar como lida', view: 'Ver', mute8h: 'Silenciar 8h', mute1w: 'Silenciar 1 semana', snooze1h: 'Soneca 1h', replyMention: 'Responder menção...' },
  en: { newMessage: 'New message', reply: 'Reply', send: 'Send', placeholder: 'Message...', markRead: 'Mark as read', view: 'View', mute8h: 'Mute 8h', mute1w: 'Mute 1 week', snooze1h: 'Snooze 1h', replyMention: 'Reply to mention...' },
  es: { newMessage: 'Nuevo mensaje', reply: 'Responder', send: 'Enviar', placeholder: 'Mensaje...', markRead: 'Marcar como leído', view: 'Ver', mute8h: 'Silenciar 8 h', mute1w: 'Silenciar 1 semana', snooze1h: 'Posponer 1h', replyMention: 'Responder mención...' },
  fr: { newMessage: 'Nouveau message', reply: 'Répondre', send: 'Envoyer', placeholder: 'Message...', markRead: 'Marquer comme lu', view: 'Voir', mute8h: 'Silence 8 h', mute1w: 'Silence 1 semaine', snooze1h: 'Reporter 1 h', replyMention: 'Répondre à la mention...' },
  de: { newMessage: 'Neue Nachricht', reply: 'Antworten', send: 'Senden', placeholder: 'Nachricht...', markRead: 'Als gelesen markieren', view: 'Ansehen', mute8h: '8 Std. stumm', mute1w: '1 Woche stumm', snooze1h: '1 Std. pausieren', replyMention: 'Auf Erwähnung antworten...' },
  it: { newMessage: 'Nuovo messaggio', reply: 'Rispondi', send: 'Invia', placeholder: 'Messaggio...', markRead: 'Segna come letto', view: 'Vedi', mute8h: 'Silenzia 8 h', mute1w: 'Silenzia 1 settimana', snooze1h: 'Posticipa 1 h', replyMention: 'Rispondi alla menzione...' },
  ja: { newMessage: '新しいメッセージ', reply: '返信', send: '送信', placeholder: 'メッセージ...', markRead: '既読にする', view: '表示', mute8h: '8時間ミュート', mute1w: '1週間ミュート', snooze1h: '1時間スヌーズ', replyMention: 'メンションに返信...' },
  ar: { newMessage: 'رسالة جديدة', reply: 'رد', send: 'إرسال', placeholder: 'رسالة...', markRead: 'وضع علامة كمقروءة', view: 'عرض', mute8h: 'كتم 8 ساعات', mute1w: 'كتم أسبوع', snooze1h: 'غفوة ساعة', replyMention: 'الرد على الإشارة...' },
  id: { newMessage: 'Pesan baru', reply: 'Balas', send: 'Kirim', placeholder: 'Pesan...', markRead: 'Tandai dibaca', view: 'Lihat', mute8h: 'Bisukan 8 jam', mute1w: 'Bisukan 1 minggu', snooze1h: 'Tunda 1 jam', replyMention: 'Balas sebutan...' },
  hi: { newMessage: 'नया मैसेज', reply: 'जवाब दें', send: 'भेजें', placeholder: 'मैसेज...', markRead: 'पढ़ा हुआ मार्क करें', view: 'देखें', mute8h: '8 घंटे म्यूट', mute1w: '1 हफ़्ते म्यूट', snooze1h: '1 घंटा स्नूज़', replyMention: 'मेंशन का जवाब दें...' },
};
async function _notifActionLabels() {
  const code = await _deviceLangCode();
  return _NOTIF_ACTION_LABELS[code] || _NOTIF_ACTION_LABELS.pt;
}

async function _sendTokenToBackendInner(pushToken) {
  _diagPush('send_start', pushToken ? ('len=' + String(pushToken).length) : 'no token');
  const email = await _getActiveEmailSafe();
  try {
    const { apiCall } = require('./api');
    // [2026-10-05] Device language rides with the token so the backend can
    // render chat push previews ("📷 Foto" / "📷 Photo") in the recipient's
    // language (chat.php _chatPushLang reads tokens.json[].lang → data.json
    // language → pt). Ignored by backends that don't store it yet.
    const _lang = await _deviceLangCode();
    // [2026-10-09 push-token-forever] Cada token só sobe se mudou / >24h /
    // versão nova do app / pedido do servidor (_pushSentRecently). Vai junto a
    // versão do app (o servidor guarda por token: app antigo vs novo).
    const _ver = _pushAppVersion();
    const _sent = [];
    // [2026-10-13 push-token-always] Metadados em TODA entrada: device_id
    // estável, permissão de notificação, contas deste aparelho (anti-vazamento
    // entre contas), ambiente APNs + bundle (iOS) e capacidades do binário.
    const _isExpo = _isExpoToken(pushToken);
    const _devId = _pushDeviceId(_isExpo ? pushToken : null);
    const _perm = _lastRegisterPerm || _lastPermStatus || '';
    const _meta = {
      device_id: _devId,
      notif_perm: _perm,
      device_accounts: _pushDeviceAccounts(email),
      ...(await _iosPushMeta()),
    };
    if (Platform.OS === 'android') {
      // Binário com o FirebaseMessagingService nativo que desenha o chat
      // (MessagingStyle) a partir do payload FCM direto/Expo + re-registra o
      // token em onNewToken (PushTokenRegistrar) → o servidor pode mandar
      // FCM DIRETO em vez do Expo.
      try {
        const ck = _nativeChat();
        if (ck && typeof ck.supportsNativePushRegistrar === 'function' && ck.supportsNativePushRegistrar()) {
          _meta.caps = (typeof ck.supportsExpoCallUnpack === 'function' && ck.supportsExpoCallUnpack()) ? 'fcm_native_v1,fcm_native_call' : 'fcm_native_v1';
          ck.setPushRegistrationInfo(_devId, _ver);
        }
      } catch {}
    }
    const _one = async (payload, diagStep) => {
      const type = payload.token_type || 'expo';
      payload = { ..._meta, ...payload };
      _sent.push(payload);
      if (_pushSentRecently(payload.token, email, type, _perm)) {
        _diagPush(diagStep, 'fresh_skip');
        return;
      }
      const r = await apiCall('register_push_token', { ...payload, lang: _lang, app_version: _ver }, 'POST');
      _diagPush(diagStep, r?.success ? 'ok' : ('fail:' + (r?.error || 'unknown')));
      if (r?.success) {
        _markFlushed(payload.token + '|' + email + '|' + (payload.token_type || ''));
        _markPushSent(payload.token, email, type, _perm);
      } else {
        // API returned a non-throwing failure (e.g. 5xx wrapped in success:false).
        // Queue for retry just like a network throw.
        _enqueuePendingTokenSend({ ...payload, email });
      }
    };
    // [2026-10-13 push-token-always] NATIVO primeiro (transporte principal);
    // Expo depois, só como fallback (e só se for mesmo um ExponentPushToken —
    // quando o Expo falhou, pushToken é o próprio token nativo).
    if (Platform.OS === 'android') {
      // [2026-10-17 fcm-race] Corrida real (conta nova Android 678): o token_rotated
      // do 1º getDevicePushTokenAsync dispara um 2º registerForPushNotifications que
      // ZERA pushNotificationsState.deviceToken (linha "Reset any stale value")
      // enquanto este envio ainda está rodando → send_fcm_skip, e o 2º envio morre
      // no guard de 30 s do sendTokenToBackend → conta SEM fcm_device → push só
      // pelo Expo (notification message: sem ✓✓ de entrega com app fechado).
      // Usa o último token bom desta instalação; senão pede de novo ao SO.
      let _fcmTok = pushNotificationsState.deviceToken || _lastGoodAndroidDeviceToken;
      if (!_fcmTok) {
        try {
          const dt = await Notifications?.getDevicePushTokenAsync?.();
          if (dt?.data && typeof dt.data === 'string') {
            _fcmTok = dt.data;
            _lastGoodAndroidDeviceToken = dt.data;
            if (!pushNotificationsState.deviceToken) pushNotificationsState.deviceToken = dt.data;
          }
        } catch {}
      }
      if (_fcmTok) {
        await _one({ token: _fcmTok, platform: 'android', token_type: 'fcm_device' }, 'send_fcm');
      } else {
        _diagPush('send_fcm_skip', 'no deviceToken in state');
      }
    }

    // [2026-10-09 native-transport] iOS: token APNs nativo (envio direto na Apple).
    if (Platform.OS === 'ios' && pushNotificationsState.apnsToken) {
      await _one({
        token: pushNotificationsState.apnsToken,
        platform: 'ios',
        token_type: pushNotificationsState.apnsTokenType || 'apns',
      }, 'send_apns');
    }

    if (_isExpo) {
      await _one({ token: pushToken, platform: Platform.OS }, 'send_expo');
    }
    // Multi-conta: as outras contas logadas neste aparelho também recebem o token.
    _registerForOtherAccounts(_sent.map((p) => ({ ...p, lang: _lang, app_version: _ver })), email).catch(() => {});
  } catch (err) {
    _diagPush('send_err', err?.message || String(err));
    // Offline / network throw — persist the intent so we retry on next
    // foreground or WS auth_ack. Without this the backend never learns the
    // token until the 6h ensurePushTokenFresh throttle expires AND the
    // device happens to be online at that moment (incident 2026-05-12:
    // Android had zero tokens registered because every cold start retry
    // hit the same offline window).
    const _qDev = _pushDeviceId(_isExpoToken(pushToken) ? pushToken : null);
    if (_isExpoToken(pushToken)) {
      _enqueuePendingTokenSend({ token: pushToken, email, platform: Platform.OS, device_id: _qDev });
    }
    if (Platform.OS === 'android' && pushNotificationsState.deviceToken) {
      _enqueuePendingTokenSend({
        token: pushNotificationsState.deviceToken,
        email,
        platform: 'android',
        token_type: 'fcm_device',
        device_id: _qDev,
      });
    }
    if (Platform.OS === 'ios' && pushNotificationsState.apnsToken) {
      _enqueuePendingTokenSend({
        token: pushNotificationsState.apnsToken,
        email,
        platform: 'ios',
        token_type: pushNotificationsState.apnsTokenType || 'apns',
        device_id: _qDev,
      });
    }
  }
}

/**
 * Drain the pending_token_sends queue. Iterates each entry, POSTs to the
 * backend, removes on success (or hard 4xx) and keeps on transient failure.
 * Called on AppState foreground transition + on WS auth_ack via the
 * connection event listener registered in setupNotificationListeners().
 *
 * Dedup: a token+email pair successfully flushed in the current session
 * is skipped on subsequent flushes — prevents a foreground bounce + WS
 * reconnect double-firing the same register_push_token call.
 */
export async function flushPendingTokens() {
  if (Platform.OS === 'web') return { flushed: 0, kept: 0 };
  // Bail when we're certain the network is down — saves the round-trip
  // and keeps the entries queued for the next attempt. isOnline() is a
  // best-effort signal (NetInfo cached value) so we still try when it
  // says "online but actually unreachable" — apiCall will catch + requeue.
  try { if (typeof isOnline === 'function' && isOnline() === false) return { flushed: 0, kept: -1 }; } catch {}
  const list = _readPendingTokenSends();
  if (!list.length) return { flushed: 0, kept: 0 };
  const { apiCall } = require('./api');
  const kept = [];
  let flushed = 0;
  // [2026-10-06] Per-entry backoff. nginx (7d) showed single devices hitting
  // register_push_token 500 ("Storage unavailable") 54-72×/day: every
  // foreground + every WS auth_ack re-sent the same doomed entry. Each
  // failure now stamps the entry; it is skipped until its backoff elapses
  // (1m → 2m → … capped at 6h) and dropped after FLUSH_MAX_ATTEMPTS. A
  // fresh token rotation re-enqueues with attempts=0 (see _enqueuePendingTokenSend).
  const FLUSH_MAX_ATTEMPTS = 40;
  const FLUSH_BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;
  const now = Date.now();
  // [2026-10-09 push-token-forever] A fila guarda a conta de cada pedido; o POST
  // vai com o bearer da conta ATIVA → entrada de outra conta espera aquela conta
  // voltar a ser a ativa (antes registrava o token na conta errada).
  const _activeEmail = String((await _getActiveEmailSafe()) || '').toLowerCase();
  for (const entry of list) {
    const dedupKey = entry.token + '|' + (entry.email || '') + '|' + (entry.token_type || '');
    if (_flushedTokensInSession.has(dedupKey)) {
      flushed++;
      continue;
    }
    if (entry.email && _activeEmail && String(entry.email).toLowerCase() !== _activeEmail) {
      kept.push(entry);
      continue;
    }
    const attempts = Number(entry.attempts) || 0;
    if (attempts >= FLUSH_MAX_ATTEMPTS) {
      _diagPush('flush_pending_drop', `attempts=${attempts} type=${entry.token_type || 'expo'}`);
      continue;
    }
    if (attempts > 0 && entry.lastTry) {
      const wait = Math.min(FLUSH_BACKOFF_CAP_MS, 60 * 1000 * Math.pow(2, attempts - 1));
      if (now - Number(entry.lastTry) < wait) { kept.push(entry); continue; }
    }
    try {
      const payload = { token: entry.token, platform: entry.platform || Platform.OS };
      if (entry.token_type) payload.token_type = entry.token_type;
      if (entry.device_id) payload.device_id = entry.device_id;
      try { payload.lang = await _deviceLangCode(); } catch {}
      payload.app_version = _pushAppVersion();
      // [2026-10-13 push-token-always] mesmos metadados do envio direto.
      payload.notif_perm = _lastRegisterPerm || _lastPermStatus || '';
      payload.device_accounts = _pushDeviceAccounts(entry.email || _activeEmail);
      try { Object.assign(payload, await _iosPushMeta()); } catch {}
      if (!payload.device_id) payload.device_id = _pushDeviceId(null);
      // [entregue 2026-10-20] A fila reenviava SEM caps → o servidor regravava a
      // entrada (tokens.json + PG) sem "fcm_native*" e o Android voltava ao push
      // Expo de NOTIFICAÇÃO: app em 2º plano/fechado = onMessageReceived nunca
      // roda → sem ✓✓ cinza (ChatDeliveryReporter) e, sem POST_NOTIFICATIONS,
      // sem banner (conta nova Paula 20/10: ✓ até abrir o app).
      if (Platform.OS === 'android') {
        let _caps = (typeof entry.caps === 'string') ? entry.caps : '';
        if (!_caps) {
          try {
            const ck = _nativeChat();
            if (ck && typeof ck.supportsNativePushRegistrar === 'function' && ck.supportsNativePushRegistrar()) {
              _caps = (typeof ck.supportsExpoCallUnpack === 'function' && ck.supportsExpoCallUnpack()) ? 'fcm_native_v1,fcm_native_call' : 'fcm_native_v1';
            }
          } catch {}
        }
        if (_caps) payload.caps = _caps;
      }
      const r = await apiCall('register_push_token', payload, 'POST');
      if (r?.success) {
        flushed++;
        _markFlushed(dedupKey);
        _markPushSent(entry.token, entry.email || _activeEmail, entry.token_type || 'expo', payload.notif_perm);
      } else {
        // Server returned a structured failure. If the response shape
        // suggests a permanent error (invalid token format, account
        // deleted) we drop it; otherwise keep for retry. Without a
        // discriminator we keep — better to retry a few extra times
        // than to silently lose registration forever.
        const msg = String(r?.error || r?.message || '').toLowerCase();
        const isHard = /invalid.?token|malformed|account.?(deleted|not.?found)|forbidden/.test(msg);
        if (!isHard) kept.push({ ...entry, attempts: attempts + 1, lastTry: now });
      }
    } catch (err) {
      _diagPush('flush_pending_err', err?.message || String(err));
      kept.push({ ...entry, attempts: attempts + 1, lastTry: now });
    }
  }
  _writePendingTokenSends(kept);
  _diagPush('flush_pending_done', `flushed=${flushed} kept=${kept.length}`);
  return { flushed, kept: kept.length };
}

// Cache the Expo push token from the most recent getExpoPushTokenAsync()
// call so logout can pass it to removeTokenFromBackend() without a fresh
// Notifications call (which would fail if permission just got revoked).
let _cachedPushToken = null;
export function _setCachedPushToken(tok) { _cachedPushToken = tok || null; }
export function getCachedPushToken() { return _cachedPushToken; }

// ============================================================
// AUTO RE-REGISTER ON FOREGROUND (incident 2026-05-18)
// ============================================================
// Some users were losing their push token mid-life — the server-side
// tokens.json went empty until the user logged out and back in. Root cause
// is a mix of (a) silent backend write failures (now surfaced via the
// defensive write in email.php case 'register_push_token' / 'register_voip_token')
// and (b) FCM/APNs token rotation that the app didn't push back to the
// server until the next cold-start.
//
// Fix: every time the app foregrounds, re-run registerForPushNotifications
// + sendTokenToBackend, throttled to 1× per 6h so we don't flood the
// backend for users who toggle in and out of the app. Persisted via
// AsyncStorage so a cold restart still respects the throttle.
const PUSH_REFRESH_THROTTLE_MS = 6 * 60 * 60 * 1000; // 6h
const PUSH_REFRESH_LAST_KEY = 'push_refresh_last_at';
const PUSH_REFRESH_FAIL_KEY = 'push_refresh_fail_count';

async function _readJsonKey(key, fallback) {
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  } catch { return fallback; }
}
async function _writeJsonKey(key, val) {
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    await AsyncStorage.setItem(key, JSON.stringify(val));
  } catch {}
}

/**
 * Ensure the push token on the backend is fresh. Throttled to once every
 * PUSH_REFRESH_THROTTLE_MS (6h). Safe to call on every AppState 'active'.
 *
 * @param {object} opts
 * @param {boolean} [opts.force]  Bypass the 6h throttle (used by manual
 *                                 retry from the stale-token banner tap).
 * @returns {Promise<{ok:boolean, throttled?:boolean, token?:string}>}
 */
// Read the user's master "push enabled" switch (per-account, with legacy
// global fallback). Default TRUE when unset. Mirrors the namespacing
// ProfileSettingsSheet uses so the two never disagree.
async function _readPushMasterPref() {
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    const email = await _getActiveEmailSafe();
    const nk = email ? `push_enabled:${email}` : 'push_enabled';
    let v = await AsyncStorage.getItem(nk);
    if (v == null && nk !== 'push_enabled') v = await AsyncStorage.getItem('push_enabled');
    return v !== 'false';
  } catch { return true; }
}

export async function ensurePushTokenFresh(opts = {}) {
  if (Platform.OS === 'web') return { ok: false };
  // Respect the master "push enabled" switch (ProfileSettingsSheet). When the
  // user turned push OFF, the automatic cold-start / foreground re-register
  // must NOT silently re-register the device token — otherwise the backend
  // would resume delivery and the toggle would look broken (the unregister it
  // did would be undone on the next app open). Also keep the in-memory
  // handler flag in sync and make sure no stale token lingers server-side.
  // `opts.ignoreMaster` lets an explicit user-initiated re-enable bypass this.
  if (!opts.ignoreMaster) {
    const masterEnabled = await _readPushMasterPref();
    setPushMasterEnabled(masterEnabled);
    if (!masterEnabled) {
      try { await removeTokenFromBackend(); } catch {}
      return { ok: false, disabled: true };
    }
  }
  const now = Date.now();
  if (!opts.force) {
    const lastAt = await _readJsonKey(PUSH_REFRESH_LAST_KEY, 0);
    if (typeof lastAt === 'number' && now - lastAt < PUSH_REFRESH_THROTTLE_MS) {
      return { ok: true, throttled: true };
    }
  }
  // Stamp BEFORE the call so a slow registration doesn't allow a second
  // overlapping call from another AppState bounce. If it ultimately fails
  // the failure-counter path still surfaces the banner.
  await _writeJsonKey(PUSH_REFRESH_LAST_KEY, now);
  let token = null;
  try {
    // [2026-10-07 native-polish] ignoreMaster = explicit re-enable in Settings
    // → user-initiated (goes straight to the OS dialog, no primer).
    token = await registerForPushNotifications({
      userInitiated: !!(opts.userInitiated || opts.ignoreMaster),
      fromPrimer: !!opts.fromPrimer,
    });
  } catch (e) {
    _diagPush('ensure_fresh_register_threw', e?.message || String(e));
    token = null;
  }
  if (!token && _lastRegisterDeferred) {
    // Primer pending (Android 13+, permission undetermined): not a failure —
    // don't count toward the stale banner, and allow the next foreground to
    // re-check (the user may have granted via the primer meanwhile).
    try { await _writeJsonKey(PUSH_REFRESH_LAST_KEY, 0); } catch {}
    _reportPushPermission(false).catch(() => {});
    return { ok: false, needsPrimer: true };
  }
  // [2026-10-09 push-token-forever] permissão deste aparelho → painel de saúde do push.
  _reportPushPermission(!!token).catch(() => {});
  if (!token) {
    const failCount = (await _readJsonKey(PUSH_REFRESH_FAIL_KEY, 0)) || 0;
    const next = failCount + 1;
    await _writeJsonKey(PUSH_REFRESH_FAIL_KEY, next);
    // 2+ consecutive failures → surface a global banner flag so the UI can
    // ask the user to tap-to-retry. Single failures stay silent (most users
    // recover on the next foreground without ever noticing).
    if (next >= 2) {
      try { globalThis.__chatyy_push_token_stale = true; } catch {}
    }
    return { ok: false };
  }
  try {
    await sendTokenToBackend(token);
  } catch (e) {
    _diagPush('ensure_fresh_send_threw', e?.message || String(e));
  }
  // [2026-10-13 push-token-always] Primer pendente (Android 13+): o token já
  // subiu, mas a próxima volta ao app re-checa a permissão (sem throttle).
  if (_lastRegisterDeferred) { try { await _writeJsonKey(PUSH_REFRESH_LAST_KEY, 0); } catch {} }
  // Reset failure counter on any successful round-trip.
  await _writeJsonKey(PUSH_REFRESH_FAIL_KEY, 0);
  try { globalThis.__chatyy_push_token_stale = false; } catch {}
  // [2026-10-17 push-durable] confere com o servidor se o token deste aparelho
  // está mesmo lá (1×/3h); se não, re-registra ignorando o cache de 24h.
  if (!opts._fromHealth) checkPushHealth().catch(() => {});
  return { ok: true, token };
}

/**
 * Manual retry from the PushTokenStaleBanner tap. Bypasses the 6h throttle.
 */
export async function retryPushTokenRegistration() {
  return ensurePushTokenFresh({ force: true, userInitiated: true });
}

/**
 * [2026-10-07 native-polish] "Ativar" tapped on the pre-permission primer:
 * show the OS dialog now, then register the token. Returns the final
 * permission status string ('granted' | 'denied' | 'undetermined').
 */
export async function enablePushFromPrimer() {
  _diagPush('primer_accept', Platform.OS);
  let r = null;
  try {
    r = await ensurePushTokenFresh({ force: true, fromPrimer: true });
  } catch {}
  let status = 'undetermined';
  try {
    const loaded = await loadModules();
    if (loaded && Notifications) {
      const p = await Notifications.getPermissionsAsync();
      status = p?.status || status;
    }
  } catch {}
  _diagPush('primer_result', status + (r?.ok ? ':token' : ':no_token'));
  return status;
}

export function diagPushPrimer(step, info) {
  _diagPush(step, info);
}

export async function removeTokenFromBackend(pushToken) {
  const tok = pushToken || _cachedPushToken;
  const { apiCall } = require('./api');
  // 1. Token-specific revoke (preserves other devices on the same account).
  if (tok) {
    try { await apiCall('unregister_push_token', { token: tok }, 'POST'); } catch {}
  }
  // 2. [2026-10-09 push-token-forever] Remove SÓ os tokens DESTE aparelho
  // (Expo + FCM nativo + APNs nativo + VoIP) e os registrados por esta sessão.
  // Antes isto zerava o tokens.json da conta inteira → o iPhone/Android de
  // outro lugar ficava sem push até reabrir o app. O servidor (email.php)
  // também casa pela sessão (bearer) quando o cache do token se perdeu.
  // Web não tem token nativo (o Web Push sai pelo passo 3) → não chama.
  if (Platform.OS !== 'web') try {
    const mine = [tok, pushNotificationsState.deviceToken, pushNotificationsState.apnsToken].filter((x) => typeof x === 'string' && x);
    const body = { tokens: mine, platform: Platform.OS };
    // [2026-10-13] device_id: o servidor (script push-tokens) também remove por
    // aparelho — cobre token que rotacionou e o app não tem mais em memória.
    try { const d = _pushDeviceId(null); if (d) body.device_id = d; } catch {}
    if (Platform.OS === 'ios') {
      try {
        const ck = require('../modules/expo-callkit');
        const v = typeof ck?.getVoipToken === 'function' ? ck.getVoipToken() : null;
        if (typeof v === 'string' && v) body.voip_token = v;
      } catch {}
    }
    await apiCall('unregister_all_my_push_tokens', body, 'POST');
  } catch {}
  // Próximo login/reativação desta conta re-envia na hora (sem o cache de 24h).
  try { forgetSentPushTokens(await _getActiveEmailSafe()); } catch {}
  if (Platform.OS === 'ios') { try { await require('./callkeep').forgetVoipSent?.(); } catch {} }
  // 3. Web platform path — FCM Web SDK lives in services/webPush.js and
  // talks to a different backend table (web_tokens.json). Without this
  // call, logging out on a browser leaves the SW receiving pushes until
  // the FCM token rotates (potentially weeks). Mirrors the native paths.
  if (Platform.OS === 'web') {
    try {
      const { unregisterWebPushToken } = require('./webPush');
      if (typeof unregisterWebPushToken === 'function') await unregisterWebPushToken();
    } catch {}
  }
  _cachedPushToken = null;
}

export async function setupNotificationListeners() {
  const loaded = await loadModules();
  if (!loaded) return () => {};

  // [FIX push-prompt 2026-10-05] The early permission REQUEST that used to
  // live here was removed. Wiring the listeners below needs no permission,
  // but calling requestPermissionsAsync() here fired the iOS/Android push
  // dialog on the very first screen — before the user had even logged in.
  // The permission request now happens only via ensurePushTokenFresh →
  // registerForPushNotifications, which _layout/AuthContext invoke AFTER
  // authentication (gated on auth?.user). See registerForPushNotifications()
  // which still requests permission when a token is actually needed.

  // [2026-06-09 sweep] FCM/APNs token ROTATION listener. The OS can rotate the
  // push token at any time (app restore, GMS update, APNs re-issue); before
  // this, a rotation was only picked up by the next ensurePushTokenFresh —
  // throttled to 6h — leaving the user push-deaf for up to 6 hours. The
  // listener fires on rotation; if the new token differs from the last one we
  // registered, re-register immediately (bypasses the throttle entirely).
  // 🚨 [2026-06-12 STORM FIX] The original listener had a dedup guard ONLY
  // for Android. On iOS, ensurePushTokenFresh → registerForPushNotifications
  // re-emits this same listener event → infinite recursion at CPU speed
  // (~700 req/s of register_push_token + push_diag flooding the API and the
  // phone's own uplink — degraded calls app-wide). Guards now:
  //   1. dedup by token value on BOTH platforms (_lastRotatedToken)
  //   2. 60s cooldown between handled rotations regardless of value
  //   3. subscription captured so cleanup can remove it (was leaked before —
  //      stacked listeners on re-setup multiplied the storm)
  try {
    if (Platform.OS !== 'web' && typeof Notifications.addPushTokenListener === 'function') {
      _tokenRotationSub = Notifications.addPushTokenListener((devToken) => {
        try {
          const raw = devToken?.data || devToken;
          if (!raw || typeof raw !== 'string') return;
          if (_lastRotatedToken === raw) return;
          if (Platform.OS === 'android' && pushNotificationsState.deviceToken === raw) return;
          // [2026-10-13] iOS: o próprio getDevicePushTokenAsync do registro
          // re-emite este evento com o MESMO token → era 1 re-registro forçado
          // extra por boot (355 "token_rotated" em 7 dias). Só token NOVO conta.
          if (Platform.OS === 'ios' && pushNotificationsState.apnsToken
              && pushNotificationsState.apnsToken === String(raw).toLowerCase()) return;
          const now = Date.now();
          if (now - _lastRotationHandledAt < 60 * 1000) return;
          _lastRotationHandledAt = now;
          _lastRotatedToken = raw;
          _diagPush('token_rotated', 'len=' + raw.length);
          ensurePushTokenFresh({ force: true }).catch(() => {});
        } catch {}
      });
    }
  } catch (e) { _diagPush('token_rotation_listener_fail', e?.message || String(e)); }

  const receivedSub = Notifications.addNotificationReceivedListener((notification) => {
    // When a push arrives in foreground, emit event so chat can refresh instantly
    const data = notification.request?.content?.data;
    // [recovery 2026-10-18] prompt de recuperação com o app aberto → RecoveryPromptHost abre a tela
    if (data?.type === 'account_recovery_prompt') {
      try { require('react-native').DeviceEventEmitter.emit('chatyy:recovery_prompt', { challenge_id: data.challenge_id }); } catch {}
    }
    // [2026-10-09 open-instant] The push carries the message: put it in the
    // local store NOW (SQLite + list preview) — no-op when the WS already
    // delivered it (dedup by server id). services/bgJournal.ingestPushPayload.
    try { require('./bgJournal').ingestPushPayload(notification.request?.content, 'push_fg'); } catch {}
    // [2026-10-13 dack-retry] ✓✓ pelo token assinado do push (d_ack) também com
    // o app aberto: não depende de bearer/WS saudável (o chatDeliveryAckBatched
    // abaixo depende). Idempotente no servidor e deduplicado por token.
    try { require('./pushDeliveryTask').ackPushDelivered?.(notification.request?.content?.data ?? data); } catch {}
    if (data?.conversation_id) {
      // Trigger immediate message fetch for this conversation
      try {
        const ws = require('./websocket').default;
        if (ws) {
          ws._emit('push_chat_refresh', { conversation_id: data.conversation_id });
        }
      } catch {}
    }
    // WhatsApp parity (2026-05-21): the moment a chat_message push lands on
    // this device — regardless of whether the WS is connected, the app is
    // foreground/background, or the user opens the conversation — fire a
    // delivery ack so the sender's ticks flip from ✓ (sent) to ✓✓ (delivered)
    // immediately. Previously delivery only acked when the message arrived
    // via WS (active app) OR the user opened the thread; users with the app
    // killed would leave the sender stuck at single check until they next
    // tapped the notification. The backend `chat_delivery_ack` action is
    // idempotent (ON CONFLICT preserves first-write timestamp) so an extra
    // ack from a later WS handler is a no-op.
    if (['chat_message','chat_mention','chat_keyword'].includes(data?.type) && data.conversation_id && data.message_id) {
      try {
        const convId = Number(data.conversation_id) || data.conversation_id;
        const mid = Number(data.message_id);
        if (mid > 0) {
          const api = require('./api');
          if (typeof api.chatDeliveryAckBatched === 'function') {
            api.chatDeliveryAckBatched(convId, [mid]);
          } else if (typeof api.chatDeliveryAck === 'function') {
            api.chatDeliveryAck(convId, [mid]).catch(() => {});
          }
        }
      } catch {}
    }
    // Find My Friends — backend pushes data.type='location_request' when peer
    // asks to see this user's location. Open the global accept/decline sheet
    // instead of relying on the snap-map screen being open.
    if (data?.type === 'location_request' && data.requester_email) {
      try {
        const { triggerLocationRequestModal } = require('../components/LocationRequestModal');
        triggerLocationRequestModal({
          requester_email: data.requester_email,
          requester_name: data.requester_name,
          message: data.message,
        });
        // Suppress the system banner — modal is already on screen.
        try { Notifications.dismissNotificationAsync(notification.request.identifier); } catch {}
      } catch {}
    }
    // SuperBora (and future sibling apps): cross-app sign-in approval. The
    // backend already shipped all fields in the data payload, so just hand
    // the whole blob to the modal. Background-tap path mirrors this below.
    if (data?.type === 'push_login' && data.challenge_id) {
      try {
        const { triggerPushLoginModal } = require('../components/PushLoginRequestModal');
        triggerPushLoginModal(data);
        try { Notifications.dismissNotificationAsync(notification.request.identifier); } catch {}
      } catch {}
    }
  });

  // [2026-10-05] After an inline chat action (Responder / Marcar como lida), the
  // tapped banner — and every other banner of that conversation (iOS stacks
  // them per thread) — is dismissed, like WhatsApp. Fire-and-forget.
  const _dismissAfterChatAction = (response, conversationId) => {
    try {
      const id = response?.notification?.request?.identifier;
      if (id) Notifications.dismissNotificationAsync(id).catch?.(() => {});
    } catch {}
    try { dismissConversationNotifications(conversationId).catch(() => {}); } catch {}
  };

  const _dispatchNotificationResponse = (response) => {
    if (!response) return;
    // Dedup by notification id so the cold-start replay below can't re-handle a
    // tap the live listener already processed (and a stale launch response
    // can't fire twice across setup re-runs).
    const _rid = response?.notification?.request?.identifier;
    if (_rid) {
      const _ridKey = String(_rid) + '|' + String(response?.actionIdentifier || '');
      if (_rid === _lastHandledResponseId || _handledResponseIds.has(_ridKey)) return;
      _lastHandledResponseId = _rid;
      _handledResponseIds.add(_ridKey);
      if (_handledResponseIds.size > 100) { try { _handledResponseIds.delete(_handledResponseIds.values().next().value); } catch {} }
    }
    const data = response.notification.request.content.data;
    const actionId = response.actionIdentifier;
    // [2026-10-09 open-instant] TAP (live or cold-start replay): store the
    // pushed message BEFORE routing, so the conversation mounts with it on
    // frame 1 instead of waiting for chat_sync/WS after the app wakes. When the
    // push can't carry the text (locked / E2E / oversized) start the delta
    // fetch right now, in parallel with the navigation.
    try {
      const _ing = require('./bgJournal').ingestPushPayload(response.notification.request.content, 'push_tap');
      const _e = _ing && _ing.entry;
      if (_e && _e.full !== '1' && _e.locked !== '1') {
        require('./chatOpenPrefetch').prefetchConversationDelta(_e.cid, 'push_tap');
      }
    } catch {}

    // [notas-lembrete 2026-10-14] Lembrete de nota: Adiar 10 min / Adiar 1 h / Concluir
    // (categoria 'note_reminder', services/noteReminders.js). Toque no corpo cai
    // na navegação abaixo e abre a nota.
    if (data?.type === 'note_reminder' && typeof actionId === 'string' && actionId.indexOf('NOTE_') === 0) {
      try { require('./noteReminders').handleNoteReminderAction(actionId, data, response).catch(() => {}); } catch {}
      return;
    }

    // Handle notification action buttons (new + legacy identifiers)

    // EMAIL: Reply (opens app to compose)
    if (actionId === 'REPLY' && data?.uid) {
      const folder = data.folder || 'INBOX';
      router.push(`/compose?replyUid=${data.uid}&folder=${encodeURIComponent(folder)}`);
      return;
    }
    // EMAIL: Archive
    if ((actionId === 'ARCHIVE' || actionId === 'archive') && data?.uid) {
      handleArchiveFromNotification(data);
      return;
    }
    // EMAIL: Delete
    if (actionId === 'DELETE' && data?.uid) {
      handleDeleteFromNotification(data);
      return;
    }
    // EMAIL: Mark read (legacy)
    if (actionId === 'mark_read' && data?.uid) {
      handleMarkReadFromNotification(data);
      return;
    }
    // CHAT: Reply with text input (WhatsApp/iMessage-style quick reply).
    // Accepts canonical `reply` (chat_message category) plus legacy `REPLY`/`reply_chat`.
    if ((actionId === 'reply' || actionId === 'REPLY' || actionId === 'reply_chat') && data?.conversation_id) {
      const userText = response.userText;
      if (userText?.trim()) {
        // [2026-10-09] iOS native handler already sent it → never twice.
        if (!_handledNatively(response)) handleChatReplyFromNotification(data.conversation_id, userText.trim(), _notifReplyToId(data), _notifMsgId(data));
        // WhatsApp parity: replying from the banner = you read the chat → clear
        // this conversation's notifications from the tray (and trim the badge).
        _dismissAfterChatAction(response, data.conversation_id);
      }
      return;
    }
    // CHAT: Mark as read. `mark_read` is shared with the email legacy handler above,
    // but that branch guards on `data?.uid` so chat pushes (with `conversation_id`) fall through here.
    if ((actionId === 'mark_read' || actionId === 'MARK_READ' || actionId === 'mark_read_chat') && data?.conversation_id) {
      if (!_handledNatively(response)) handleMarkReadChatFromNotification(data.conversation_id, _notifMsgId(data));
      _dismissAfterChatAction(response, data.conversation_id);
      return;
    }
    // [notif-p0p1] Smart-reply chip tap: NSE registers UNTextInputNotificationActions
    // with identifiers `smart_reply_0` / `_1` / `_2`. iOS still surfaces the
    // text input so the user can edit before sending — the chip text is the
    // pre-filled value via response.userText.
    if (/^smart_reply_\d+$/.test(actionId || '') && data?.conversation_id) {
      const userText = response.userText;
      if (userText?.trim() && !_handledNatively(response)) {
        handleChatReplyFromNotification(data.conversation_id, userText.trim(), null, _notifMsgId(data));
      }
      return;
    }
    // [notif-p0p1] Mute-from-notification (8h). Identifier `mute_8h` is
    // registered statically (chat_with_mute) and dynamically (NSE smart
    // category). Sends chat_user_conv_settings_set with mute_until = now+8h.
    // [2026-10-12 push-parity] + `mute_1w` (WhatsApp: 8 horas / 1 semana).
    if ((actionId === 'mute_8h' || actionId === 'mute_1w') && data?.conversation_id) {
      if (!_handledNatively(response)) {
        try {
          const { apiCall } = require('./api');
          const hours = actionId === 'mute_1w' ? 7 * 24 : 8;
          const muteUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
          apiCall('chat_user_conv_settings_set', {
            conversation_id: data.conversation_id,
            mute_until: muteUntil,
          }, 'POST').catch(() => {});
        } catch {}
      }
      _dismissAfterChatAction(response, data.conversation_id);
      return;
    }
    // [notif-p0p1] Snooze user-level for 1h. Pushes for the next hour fold
    // into silent data pushes (push fanout reads chat_user_snooze).
    if (actionId === 'snooze_1h') {
      try {
        const { apiCall } = require('./api');
        apiCall('chat_user_snooze_set', { minutes: 60 }, 'POST').catch(() => {});
      } catch {}
      try { Notifications.dismissNotificationAsync(response.notification.request.identifier); } catch {}
      return;
    }
    // [notif-p0p1] Reaction "view" action — jump to the reacted message.
    if (actionId === 'view' && data?.conversation_id) {
      handleNotificationNavigation({ ...data, type: 'chat_message' });
      return;
    }
    // FEED/SOCIAL: View post or profile
    if (actionId === 'VIEW') {
      handleViewFromNotification(data);
      return;
    }
    // LIVE: Join broadcast
    if (actionId === 'JOIN' && data?.session_id) {
      handleJoinLiveFromNotification(data);
      return;
    }
    // Missed call → "Ligar de volta". Same identifier used by the iOS
    // notification action and the Android ChatActionReceiver broadcast that
    // tunnels back into JS via expo-notifications' presentation hook.
    if (actionId === 'CALL_BACK' && (data?.caller_email || data?.peer_email || data?.target_email)) {
      const peer = data.caller_email || data.peer_email || data.target_email;
      const peerName = data.caller_name || data.peer_name || '';
      const isVideo = (data.video === '1' || data.video === true) ? '1' : '0';
      try { Notifications.dismissAllNotificationsAsync(); } catch {}
      router.push(`/call?email=${encodeURIComponent(peer)}&name=${encodeURIComponent(peerName)}&initiator=1&isVideo=${isVideo}`);
      return;
    }
    if (actionId === 'accept_call' && (data?.room_id || data?.call_id)) {
      const callId = data.call_id || data.room_id;
      const isVideo = (data.video === '1' || data.video === true) ? '1' : '0';
      // CRITICAL: Set callActive BEFORE anything else — prevents IncomingCallListener
      // from showing the Modal when WS reconnects and delivers the pending call_invite
      try {
        const { setCallActive, dismissIncomingCall } = require('../components/IncomingCallListener');
        setCallActive(true);
        dismissIncomingCall();
      } catch {}
      // Dismiss all system notifications
      try { Notifications.dismissAllNotificationsAsync(); } catch {}
      // Send call_accepted via WS — retry if not connected yet (app may be waking up)
      const sendAccepted = () => {
        try {
          const mailWs = require('./websocket').default;
          if (mailWs.isConnected) {
            mailWs._send({
              type: 'call_accepted',
              call_id: callId,
              conversation_id: data.conversation_id || '',
              target_email: data.caller_email,
            });
            return true;
          }
        } catch {}
        return false;
      };
      if (!sendAccepted()) {
        // WS not connected yet — retry after 1s and 3s (app waking from background)
        setTimeout(sendAccepted, 1000);
        setTimeout(sendAccepted, 3000);
      }
      // [#992 Stage 3] On mobile the native incoming-direct path
      // (CallActivity / CallViewController) opens automatically once the
      // user taps Accept in the system notification — JS shouldn't push
      // /call.js here. Web still uses /call.js.
      try {
        const { Platform } = require('react-native');
        if (Platform.OS === 'web') {
          router.push(`/call?callId=${callId}&contactName=${encodeURIComponent(data.caller_name || '')}&contactEmail=${encodeURIComponent(data.caller_email || '')}&isVideo=${isVideo}&conversationId=${data.conversation_id || ''}&isCaller=0`);
        }
      } catch {
        router.push(`/call?callId=${callId}&contactName=${encodeURIComponent(data.caller_name || '')}&contactEmail=${encodeURIComponent(data.caller_email || '')}&isVideo=${isVideo}&conversationId=${data.conversation_id || ''}&isCaller=0`);
      }
      return;
    }
    if (actionId === 'decline_call' && (data?.room_id || data?.call_id)) {
      // Dismiss in-app call UI
      try {
        const { dismissIncomingCall } = require('../components/IncomingCallListener');
        dismissIncomingCall();
      } catch {}
      // Dismiss all system notifications
      try { Notifications.dismissAllNotificationsAsync(); } catch {}
      // Send decline via WS — retry if not connected yet
      const sendDecline = () => {
        try {
          const mailWs = require('./websocket').default;
          if (mailWs.isConnected) {
            mailWs._send({
              type: 'call_end',
              call_id: data.call_id || data.room_id,
              target_email: data.caller_email,
              reason: 'declined',
            });
            return true;
          }
        } catch {}
        return false;
      };
      if (!sendDecline()) {
        setTimeout(sendDecline, 1000);
        setTimeout(sendDecline, 3000);
      }
      return;
    }

    handleNotificationNavigation(data);
  };
  const responseSub = Notifications.addNotificationResponseReceivedListener(_dispatchNotificationResponse);

  // [2026-10-02] Cold-start tap deep-link. When the app is launched from a
  // KILLED state by tapping a push, expo-notifications emits the response
  // BEFORE this (late, async) listener registers, so the tap was dropped and
  // the app opened on its default route instead of the chat/call/email target.
  // Replay the launch response ONCE per process; the id-dedup in the dispatcher
  // prevents a double-handle if the live listener did catch it, and a short
  // delay lets the root navigator mount before we route.
  try {
    if (!_coldStartTapHandled) {
      _coldStartTapHandled = true;
      const _launch = await Notifications.getLastNotificationResponseAsync();
      if (_launch) {
        setTimeout(() => { try { _dispatchNotificationResponse(_launch); } catch {} }, 700);
      }
    }
  } catch {}

  // ─── Offline retry wiring for pending_token_sends ────────────────────
  // 1. Drain on every foreground transition (matches the existing 6h
  //    ensurePushTokenFresh hook in AuthContext but cheaper: no permission
  //    prompt, no re-derive token, just retry the persisted POST).
  // 2. Drain on WS auth_ack — the same network event that flushes the
  //    chat outbox is the strongest "we're back online" signal we have,
  //    much faster than the AppState bounce in carrier-flap scenarios.
  let _flushAppStateSub = null;
  let _flushWsConnUnsub = null;
  let _reregWsUnsub = null;
  try {
    _flushAppStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        flushPendingTokens().catch(() => {});
      } else if (state === 'background') {
        // [2026-10-07 recv-native] Leaving the app is exactly when the native
        // notification path takes over → hand it a fresh bearer set.
        syncNativeChatAuth(true).catch(() => {});
      }
    });
  } catch {}
  try {
    const mailWs = require('./websocket').default;
    if (mailWs && typeof mailWs.on === 'function') {
      _flushWsConnUnsub = mailWs.on('connection', (evt) => {
        if (evt?.status === 'authenticated') {
          flushPendingTokens().catch(() => {});
        }
      });
      // [2026-10-09 push-token-forever] servidor sem token válido desta conta → re-registra.
      _reregWsUnsub = mailWs.on('push_reregister', (d) => { requestPushReregister('ws:' + String(d?.reason || '')); });
    }
  } catch {}
  // Best-effort initial drain in case there were pending entries from the
  // last session (cold start with stale queue).
  flushPendingTokens().catch(() => {});

  // [2026-10-07 recv-native] Android native notification tap = deep link
  // onemundomail://chat-conversation?id=…&acct=<recipient>. expo-router opens
  // the conversation by itself; when the push belongs to ANOTHER signed-in
  // account we switch first and re-open the chat under the right session
  // (same rule as handleNotificationNavigation → ensureNotificationAccount).
  let _linkSub = null;
  try {
    if (Platform.OS === 'android') {
      const { Linking } = require('react-native');
      const _onChatLink = async (url) => {
        try {
          if (!url || url.indexOf('chat-conversation') === -1 || url.indexOf('acct=') === -1) return;
          const q = url.split('?')[1] || '';
          const p = {};
          for (const kv of q.split('&')) {
            const i = kv.indexOf('=');
            if (i > 0) p[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
          }
          if (!p.id || !p.acct) return;
          const before = _normAcctEmail(await _getActiveEmailSafe());
          if (!before || before === _normAcctEmail(p.acct)) return; // right account already
          const ok = await ensureNotificationAccount({ recipient_email: p.acct });
          if (!ok) return;
          setTimeout(() => {
            try {
              handleNotificationNavigation({
                type: 'chat_message',
                conversation_id: p.id,
                is_group: p.type === 'group' ? '1' : '0',
                sender_name: p.name || '',
                sender_email: p.email || '',
              });
            } catch {}
          }, 800);
        } catch {}
      };
      _linkSub = Linking.addEventListener('url', (ev) => { _onChatLink(ev?.url); });
      Linking.getInitialURL().then((u) => { if (u) _onChatLink(u); }).catch(() => {});
    }
  } catch {}
  syncNativeChatAuth(true).catch(() => {});

  return () => {
    receivedSub?.remove?.();
    responseSub?.remove?.();
    try { _linkSub?.remove?.(); } catch {}
    try { _flushAppStateSub?.remove?.(); } catch {}
    try { _flushWsConnUnsub?.(); } catch {}
    try { _reregWsUnsub?.(); } catch {}
    try { _tokenRotationSub?.remove?.(); _tokenRotationSub = null; } catch {}
  };
}

// [2026-10-03] Push tokens are shared across the accounts on a device, so a
// tap can arrive for an account that is NOT the active one. _layout registers
// AuthContext.switchAccount here; handleNotificationNavigation switches first
// (or drops the tap when the target account isn't signed in on this device)
// instead of opening account B's conversation id under account A's session.
let _switchAccountHandler = null;
export function setSwitchAccountHandler(fn) { _switchAccountHandler = fn; }
function _normAcctEmail(e) {
  return String(e || '').toLowerCase().replace('@onemundo.com.br', '@chatyy.com.br');
}
export async function ensureNotificationAccount(data) {
  try {
    const rcpt = _normAcctEmail(data?.recipient_email);
    if (!rcpt) return true;
    const active = _normAcctEmail(await _getActiveEmailSafe());
    if (!active || active === rcpt) return true;
    const stored = require('./api').getStoredAccounts?.() || [];
    const acc = stored.find((a) => _normAcctEmail(a.email) === rcpt);
    if (!acc || !_switchAccountHandler) return false;
    // [incidente-sessao 2026-10-14] nunca troca sozinho p/ conta parada (>30d).
    try { const api = require('./api'); if (typeof api.isStoredAccountFresh === 'function' && !api.isStoredAccountFresh(acc)) return false; } catch {}
    const r = await _switchAccountHandler(acc.email);
    return !!r?.success;
  } catch { return true; }
}

// Shared "open this conversation" navigation. With a chat already open, a
// push stacked a 2nd /chat-conversation (back needed 2x): REPLACE instead,
// no-op when it is the same chat, push only from list/other screens.
// [2026-10-12 nav-dedup] Delegates to services/openConversation.js (window
// dedup + same-top no-op + pop-to-existing-instance, chat→chat = replace).
export function openConversation(target, convId) {
  try {
    return require('./openConversation').openConversation(target, { source: 'push' });
  } catch {}
  if (_activeConversationId != null) {
    if (convId != null && String(_activeConversationId) === String(convId)) return;
    router.replace(target);
  } else {
    router.push(target);
  }
}

export function handleNotificationNavigation(data) {
  if (!data) return;
  ensureNotificationAccount(data).then((ok) => { if (ok) _navigateForNotification(data); }).catch(() => {});
}

function _navigateForNotification(data) {
  if (!data) return;
  try {
    if ((data.type === 'new_email' || data.type === 'email') && data.uid) {
      // Navigate to the specific email. Accept both 'new_email' and 'email'
      // type strings — the backend uses either, and 'email' used to fall
      // through to the generic Inbox route, losing the specific message.
      const folder = data.folder || 'INBOX';
      // [2026-10-18 email-reader-rea] vizinhos da lista em cache → o swipe
      // entre e-mails funciona também quando o leitor abre pelo push.
      let nb = '';
      try {
        if (globalThis.__chatyy_mail_reader_rea !== false) {
          const list = require('./offlineCache').getEmailsFromCacheSync(folder) || [];
          const idx = list.findIndex(e => e && String(e.uid) === String(data.uid));
          if (idx >= 0) {
            const p = idx > 0 ? String(list[idx - 1].uid || '') : '';
            const n = idx < list.length - 1 ? String(list[idx + 1].uid || '') : '';
            if (p || n) nb = `&prevUid=${encodeURIComponent(p)}&nextUid=${encodeURIComponent(n)}`;
          }
        }
      } catch {}
      _pushOverHome(`/read?uid=${data.uid}&folder=${encodeURIComponent(folder)}${nb}`);
      return;
    }
    // [2026-10-13 calendario] lembrete local de tarefa → Tarefas; lembrete de
    // evento (cron cal-reminders manda kind=calendar_reminder) → o evento.
    if (data.type === 'task_reminder') {
      _pushOverHome(data.task_id ? `/tasks?focus=${encodeURIComponent(String(data.task_id))}` : '/tasks');
      return;
    }
    if ((data.type === 'calendar_reminder' || data.kind === 'calendar_reminder') && data.event_id) {
      _pushOverHome(`/event-detail?id=${encodeURIComponent(String(data.event_id))}`);
      return;
    }
    if (data.type === 'meeting_reminder' && data.room_id) {
      _pushOverHome(`/meeting-detail?room_id=${data.room_id}`);
      return;
    }
    // [paridade-wa 2026-10-14] lembrete de chamada agendada (cron-scheduled-calls) → Agendadas
    if (data.type === 'call_schedule_reminder' || data.kind === 'call_schedule_reminder') {
      _pushOverHome('/call-schedule');
      return;
    }
    // [notas-lembrete 2026-10-14] lembrete de nota (push do servidor ou local offline) → abre a nota
    if (data.type === 'note_reminder' && data.note_id) {
      _pushOverHome(`/notes?open=${encodeURIComponent(String(data.note_id))}`);
      return;
    }
    // 'chat_reminder' = local reminder scheduled from the chat smart action
    // (services/reminders.js) — tapping it deep-links back to the conversation.
    if ((data.type === 'chat_message' || data.type === 'chat_mention' || data.type === 'chat_keyword' || data.type === 'group' || data.type === 'group_message' || data.type === 'chat_reminder') && data.conversation_id) {
      // [2026-07-03] chat_mention / chat_keyword pushes carry conversation_id
      // just like chat_message; tapping them used to fall through to the email
      // Inbox route below. Route them to the conversation too.
      const _ctPush = String(data.conversation_type || '');
      const emailParam = data.sender_email ? `&email=${encodeURIComponent(data.sender_email)}` : '';
      // Derive conv type from is_group so a group push doesn't open in direct
      // mode (wrong header/membership affordances on first paint).
      // [2026-10-14 tipo-conv] is_group ausente (push antigo/local/lembrete) NÃO é "direct": usa o
      // tipo do push (group/group_message) ou da conversa em cache; desconhecido → sem `type`
      // (a tela resolve pelo cache/servidor em vez de abrir grupo como contato).
      const _ig = data.is_group;
      let convType = (_ctPush === 'group' || _ctPush === 'channel' || _ctPush === 'direct') ? _ctPush
        : (_ig === true || _ig === 'true' || _ig === 1 || _ig === '1') ? 'group'
        : (_ig === false || _ig === 'false' || _ig === 0 || _ig === '0') ? 'direct'
        : (data.type === 'group' || data.type === 'group_message') ? 'group' : '';
      if (!convType) {
        try { const _c = require('../utils/chatOpenHandoff').peekOpenConversation(data.conversation_id); if (_c && _c.type) convType = String(_c.type); } catch {}
      }
      // Grupo: título = nome da conversa (sender_name virava título do grupo no 1º frame).
      const _isGrpT = convType === 'group' || convType === 'channel';
      const senderName = _isGrpT ? (data.conversation_name || data.group_name || '') : (data.sender_name || data.title || '');
      const nameParam = senderName ? `&name=${encodeURIComponent(senderName)}` : '';
      const _convTarget = `/chat-conversation?id=${data.conversation_id}${nameParam}${convType === 'direct' || !convType ? emailParam : ''}${convType ? `&type=${convType}` : ''}`;
      // [2026-10-02] Tocar na notificação com um chat JÁ aberto empurrava uma
      // 2ª tela /chat-conversation por cima → ao voltar precisava voltar 2×
      // (founder). Se já há um chat aberto, REPLACE (troca a tela, back vai
      // direto pra lista); se já é o MESMO chat, não faz nada; só faz push
      // quando não há chat aberto (lista/outra tela → back volta pra origem).
      openConversation(_convTarget, data.conversation_id);
      return;
    }
    // Voicemail deep-link — tapping a "X left you a voicemail" push lands on
    // the conversation with the voicemail bubble scrolled into view and the
    // player auto-starts. Backend sends `data.type === 'voicemail'` plus
    // `data.conversation_id` and `data.voicemail_id`.
    //
    // TODO(chat-conversation.js): currently only `id` is consumed from the
    // route params (see chat-conversation.js useLocalSearchParams ~L5685).
    // Need to read `voicemail_id` + `autoplay` to scroll-to-message + auto
    // tap play on the matching VoicemailMessage component. Until then the
    // user still lands on the right conversation — just no scroll/autoplay.
    if (data.type === 'voicemail' && data.conversation_id) {
      const vmId = data.voicemail_id || data.vm_id || '';
      const vmParam = vmId ? `&voicemail_id=${encodeURIComponent(vmId)}` : '';
      openConversation(`/chat-conversation?id=${data.conversation_id}${vmParam}&autoplay=1&type=direct`, data.conversation_id);
      return;
    }
    if (data.type === 'login_challenge' && data.challenge_id) {
      // When user taps the login challenge notification, show the prompt
      try {
        const { triggerLoginChallengePrompt } = require('../components/LoginChallengePrompt');
        triggerLoginChallengePrompt(data);
      } catch {}
      return;
    }
    if (data.type === 'status_update') {
      // [2026-10-17 notif-audit] ?tab=status is retired (falls back to chats):
      // open the author's stories when known, else the home with the strip.
      const _sw = data.author_email || data.from || data.sender_email;
      _pushOverHome(_sw ? `/u/${encodeURIComponent(_sw)}?openStatus=1` : '/chat');
      return;
    }
    // Find My Friends — peer requested to see this user's location. Route
    // to snap-map with the requester pre-loaded so the accept/decline sheet
    // auto-opens on mount (see app/snap-map.js incoming_request param).
    if (data.type === 'location_request' && data.requester_email) {
      const nameParam = data.requester_name ? `&requester_name=${encodeURIComponent(data.requester_name)}` : '';
      const msgParam = data.message ? `&message=${encodeURIComponent(data.message)}` : '';
      _pushOverHome(`/snap-map?incoming_request=${encodeURIComponent(data.requester_email)}${nameParam}${msgParam}`);
      return;
    }
    // SuperBora cross-app sign-in (background tap). The notification payload
    // is self-contained, so we render the same modal instead of routing to a
    // dedicated screen that would just re-fetch the same data.
    if (data.type === 'push_login' && data.challenge_id) {
      try {
        const { triggerPushLoginModal } = require('../components/PushLoginRequestModal');
        triggerPushLoginModal(data);
      } catch {}
      return;
    }
    // Feed/social notifications → open the relevant post.
    // [2026-10-17 notif-audit] Was /chat?tab=feed&post_id=X — chat.js never
    // reads post_id, so the tap landed on the top of the feed. /feed/:id is the
    // canonical post screen (same as the in-app notification list); comment
    // pushes open the comment sheet. Covers feed_tagged / feed_post_new /
    // post_gift_received (ref_id = post id), which used to fall to /inbox.
    {
      const _fp = _feedPostTarget(data);
      if (_fp) { _pushOverHome(_fp); return; }
    }
    if ((data.type === 'follow' || data.type === 'feed_follow') && (data.follower_email || data.actor_email || data.author_email)) {
      _pushOverHome(`/u/${encodeURIComponent(data.follower_email || data.actor_email || data.author_email)}`);
      return;
    }
    // "X entrou no Chatyy" — someone whose number you had saved just joined.
    // Tap navigates to their public profile so the user can start a chat
    // right away. Same deep_link that lands in the notification payload.
    // [2026-10-08 contact-joined-push] Tap → abre direto a conversa nova com a
    // pessoa (chat-conversation cria o direct via params.email), não o perfil.
    if (data.type === 'contact_joined' && data.email) {
      // [notmember-ryw 2026-10-17] get-or-create da conversa direta ANTES de navegar
      // (abria só com ?email= → 1ª leitura caía na réplica sem a membership → "Not a member").
      try {
        require('./openConversation').openDirectConversation(data.email, data.name ? { name: String(data.name) } : {})
          .catch(() => {
            const nm = data.name ? `&name=${encodeURIComponent(data.name)}` : '';
            openConversation(`/chat-conversation?email=${encodeURIComponent(data.email)}&type=direct${nm}`);
          });
      } catch {
        const nm = data.name ? `&name=${encodeURIComponent(data.name)}` : '';
        openConversation(`/chat-conversation?email=${encodeURIComponent(data.email)}&type=direct${nm}`);
      }
      return;
    }
    if ((data.type === 'live' || data.type === 'live_start') && data.session_id) {
      _pushOverHome(`/live-viewer?session_id=${data.session_id}`);
      return;
    }
    // Ongoing broadcast pill (host's own session) — tap returns to studio.
    if (data.type === 'live_broadcast_self' && data.session_id) {
      _pushOverHome(`/live-broadcast?session_id=${data.session_id}`);
      return;
    }
    // Upload progress notification: tap surfaces the photos backup screen
    // so the user can pause / inspect status without digging through Settings.
    if (data.type === 'upload_progress' || data.type === 'upload_complete' || data.type === 'upload_error') {
      _pushOverHome('/photos');
      return;
    }
    // [2026-10-15 chamadas-dnd] Toque em "Ligação de X — toque para atender":
    // o nativo (IncomingCallFilter, didBecomeActive) re-reporta a ligação ao
    // CallKit. Nada a navegar aqui (não cair no /inbox).
    if (data.type === 'call_filtered') {
      return;
    }
    if (data.type === 'incoming_call' && (data.room_id || data.call_id)) {
      // Dismiss system notifications
      try { Notifications.dismissAllNotificationsAsync(); } catch {}
      // [#992 Stage 4 — retire JS modal on mobile]
      // Native CallKit (iOS) / IncomingCallActivity (Android) already
      // owns the incoming-call UI by the time this tap-response handler
      // runs, so re-triggering the JS Modal here would just overlap.
      // Web still needs the JS Modal trigger (no native call UI).
      if (Platform.OS === 'web') {
        try {
          const { triggerIncomingCall } = require('../components/IncomingCallListener');
          triggerIncomingCall({
            caller_email: data.caller_email,
            caller_name: data.caller_name,
            conversation_id: data.conversation_id,
            room_id: data.room_id || data.call_id,
            call_id: data.call_id || data.room_id,
            video: data.video === '1' || data.video === true,
          });
        } catch {}
      }
      return;
    }
    // [2026-10-18 group-call-tap] Toque em "Chamada em grupo de X": entra na
    // chamada se ainda estiver ativa; senão abre a conversa do grupo (antes: nada).
    if (data.type === 'incoming_group_call') {
      _openGroupCallFromPush(data).catch(() => {});
      return;
    }
    // [2026-10-17 notif-audit] Types that used to fall through to the e-mail
    // Inbox (reaction, missed call, status, wallet, security, group requests…).
    const _extra = _extraNotificationTarget(data);
    if (_extra === false) return;
    if (_extra) {
      if (_extra.conv) openConversation(_extra.conv, _extra.cid);
      else _pushOverHome(_extra.href);
      return;
    }
    // Unknown type: the server's own route/url (internal paths only), else the
    // app home — never the e-mail Inbox for a non-e-mail notification.
    const _r = _safeInternalRoute(data.route || data.url);
    if (_r) { _pushOverHome(_r); return; }
    _pushOverHome(_isEmailNotif(data) ? '/inbox' : '/chat');
  } catch (err) {
    console.warn('[Push] Nav error:', err.message);
  }
}

// ─── [2026-10-17 notif-audit] tap → destination helpers ─────────────────────
function _str(v) { return v == null ? '' : String(v); }
function _isEmailNotif(data) {
  const t = _str(data?.type);
  return t === 'new_email' || t === 'email' || t === 'one_alert' || !!data?.uid;
}
// Only app-internal paths ("/x…"), never "//host" or a scheme.
function _safeInternalRoute(r) {
  const s = _str(r).trim();
  if (!s || s[0] !== '/' || s[1] === '/' || s.length > 600) return '';
  if (/^\/(api|data|p|i18n|\.well-known)\//.test(s)) return '';
  // notifications_feed used `highlight=`; chat-conversation reads highlightMessageId.
  return s.replace(/([?&])highlight=/, '$1highlightMessageId=');
}
const _FEED_POST_TYPES = ['like', 'feed_like', 'comment', 'feed_comment', 'feed_tagged', 'feed_post_new', 'feed_mention', 'post_gift_received', 'comment_reply', 'comment_like'];
function _feedPostTarget(data) {
  const t = _str(data?.type);
  if (!_FEED_POST_TYPES.includes(t)) return '';
  const pid = _str(data.post_id || data.reel_id || (t === 'post_gift_received' ? data.ref_id : '')).trim();
  if (!/^\d+$/.test(pid)) return '';
  const isComment = t === 'comment' || t === 'feed_comment' || t === 'comment_reply' || t === 'comment_like';
  return `/feed/${pid}${isComment ? '?comments=1' : ''}`;
}
function _convHref(cid, extra) {
  return `/chat-conversation?id=${encodeURIComponent(_str(cid))}${extra || ''}`;
}
// [2026-10-18 group-call-tap] incoming_group_call → entrar (nativo ou /call joiner)
// ou abrir a conversa do grupo quando a chamada já acabou / foi trancada.
let _gcTapInflight = false;
async function _openGroupCallFromPush(data) {
  if (_gcTapInflight) return;
  _gcTapInflight = true;
  try {
    const cid = _str(data.conversation_id).trim();
    const gname = _str(data.group_name || data.conversation_name).trim();
    const isVideo = data.video === '1' || data.video === true || data.is_video === '1' || data.is_video === true;
    const convTarget = cid ? _convHref(cid, `&type=group${gname ? `&name=${encodeURIComponent(gname)}` : ''}`) : '';
    let st = null;
    if (cid) {
      try {
        const api = require('./api');
        const r = await api.chatCallStateActive(cid);
        const d = r?.data || r;
        if (d && typeof d === 'object' && typeof d.active !== 'undefined') st = d;
      } catch {}
    }
    const room = _str((st && (st.room || st.call_id)) || data.room_id || data.call_id).trim();
    // Servidor respondeu "sem chamada" / trancada, ou não há sala → só abre o grupo.
    if (!room || (st && (!st.active || st.locked))) {
      if (convTarget) openConversation(convTarget, cid);
      else _pushOverHome('/chat?tab=calls');
      return;
    }
    let me = '';
    try { me = String(globalThis.__chatyyMyEmail || '').toLowerCase(); } catch {}
    try {
      const ngc = require('./nativeGroupCall');
      if (ngc.canUseNativeGroupCall(me)) {
        const opened = await ngc.openNativeGroupCall({ callId: room, conversationId: cid, isVideo, isCaller: false, email: me });
        if (opened) return;
      }
    } catch {}
    const title = gname || _str(data.caller_name);
    _pushOverHome(`/call?callId=${encodeURIComponent(room)}&conversationId=${encodeURIComponent(cid)}&isVideo=${isVideo ? '1' : '0'}&isCaller=0&groupCall=1&joining=1${title ? `&contactName=${encodeURIComponent(title)}` : ''}${gname ? `&groupName=${encodeURIComponent(gname)}` : ''}`);
  } finally {
    setTimeout(() => { _gcTapInflight = false; }, 1500);
  }
}

// Returns {conv, cid} | {href} | false (handled, no navigation) | null (unknown).
function _extraNotificationTarget(data) {
  const t = _str(data?.type);
  const cid = _str(data.conversation_id).trim();
  const mid = _str(data.message_id).trim();
  const hl = /^\d+$/.test(mid) ? `&highlightMessageId=${mid}` : '';
  switch (t) {
    case 'chat_reaction': {
      if (!cid) return null;
      const ct = _str(data.conversation_type) || ((data.is_group === '1' || data.is_group === true) ? 'group' : '');
      const nm = ct === 'group' || ct === 'channel' ? _str(data.conversation_name) : _str(data.sender_name);
      return { conv: _convHref(cid, `${hl}${ct ? `&type=${ct}` : ''}${nm ? `&name=${encodeURIComponent(nm)}` : ''}`), cid };
    }
    case 'status_reply':
    case 'status_reaction':
      if (cid) return { conv: _convHref(cid, `${hl}&type=direct`), cid };
      if (data.sender_email || data.reactor_email) return { href: `/u/${encodeURIComponent(data.sender_email || data.reactor_email)}` };
      return { href: '/chat' };
    case 'status_mention':
    case 'status_posted':
    case 'status_new': {
      const who = _str(data.from || data.author_email || data.sender_email);
      return { href: who ? `/u/${encodeURIComponent(who)}?openStatus=1` : '/chat' };
    }
    case 'missed_call':
    case 'call_missed':
      if (cid) {
        const nm = _str(data.caller_name);
        return { conv: _convHref(cid, `&type=direct${nm ? `&name=${encodeURIComponent(nm)}` : ''}${data.caller_email ? `&email=${encodeURIComponent(data.caller_email)}` : ''}`), cid };
      }
      return { href: '/chat?tab=calls' };
    case 'call_cancel':
    case 'call_end':
    case 'answered_elsewhere':
      return false;
    // [jogos 2026-10-18] "Ana jogou, sua vez" / convite / resultado → abre a tela do jogo
    case 'game_turn':
    case 'game_invite':
    case 'game_start':
    case 'game_result': {
      const gidP = _str(data.game_id);
      if (gidP) return { href: `/game/${encodeURIComponent(gidP)}?cid=${encodeURIComponent(_str(cid) || '')}` };
      return cid ? { conv: _convHref(cid, ''), cid } : { href: '/chat' };
    }
    case 'group_join_request':
    case 'group_join_approved':
      return cid ? { conv: _convHref(cid, '&type=group'), cid } : { href: '/chat' };
    case 'group_join_denied':
      return { href: '/chat' };
    case 'live_scheduled':
      return { href: data.host_email ? `/u/${encodeURIComponent(data.host_email)}` : '/live-discover' };
    case 'live_replay_ready':
      return data.session_id ? { href: `/live-replay?id=${encodeURIComponent(_str(data.session_id))}` } : { href: '/lives-saved' };
    case 'live_gift_received':
      return { href: '/creator-earnings' };
    case 'diamond_received':
    case 'cashout_status':
      return { href: '/wallet' };
    case 'login_alert':
    case 'new_login':
    case 'security_alert':
      return { href: '/linked-devices' };
    case 'account_recovery_prompt': // [recovery 2026-10-18] "Você está tentando recuperar sua conta?"
      return { href: '/recovery-approve' };
    case 'plan_expiry':
      return { href: '/plans' };
    case 'moderation':
      return { href: '/my-reports' };
    case 'one_proactive':
      return { href: '/one' };
    case 'reels_render_done':
    case 'reels_render_failed':
      return data.post_id && /^\d+$/.test(_str(data.post_id)) ? { href: `/feed/${data.post_id}` } : { href: '/reels-drafts' };
    case 'parental_unlock_request':
    case 'parental_sos':
    case 'parental_unlock_response':
      return { href: '/parental' };
    default:
      break;
  }
  if (data.action === 'payment_failed') return { href: '/plans' };
  if (data.kind === 'kids_ask') return { href: '/parental' };
  if (data.kind === 'meet_schedule_reminder' && data.room_id) return { href: `/meeting-detail?room_id=${encodeURIComponent(_str(data.room_id))}` };
  return null;
}

// Push a notification target so that "back" lands on the app home. On a cold
// start the stack is just "/" (index) until it router.replace()s to /chat; a
// push before that is replaced away (or leaves index — a blank screen — as the
// only thing under the target). Wait for the home route first.
function _topRouteName() {
  try {
    const { store } = require('expo-router/build/global-state/router-store');
    const nav = store?.navigationRef?.current;
    if (!nav || (typeof nav.isReady === 'function' && !nav.isReady())) return null;
    const st = nav.getRootState?.();
    const r = st && Array.isArray(st.routes) ? st.routes[typeof st.index === 'number' ? st.index : st.routes.length - 1] : null;
    return r ? String(r.name || '') : null;
  } catch { return ''; }
}
function _pushOverHome(href) {
  // /chat (home) is navigate()d — reuses the mounted home instead of stacking a 2nd one.
  const isHome = /^\/chat(\?|$)/.test(href);
  const go = () => { try { if (isHome) router.navigate(href); else router.push(href); } catch (e) { console.warn('[Push] nav failed:', e?.message || e); } };
  const top = _topRouteName();
  if (href === '/chat' && top === 'chat') return; // already home
  if (top && top !== 'index') { go(); return; }
  const t0 = Date.now();
  const tick = () => {
    const tp = _topRouteName();
    if (tp && tp !== 'index') { setTimeout(go, 250); return; }
    if (tp === '' || Date.now() - t0 > 4000) { go(); return; }
    setTimeout(tick, 100);
  };
  tick();
}

// Notification action handlers — these run when the user taps Archive /
// Mark-read / Delete / Reply directly from the lockscreen / notification
// shade. Before Wave 5 these used `.catch(() => {})` which silently dropped
// the action on offline / 5xx: the user saw the swipe animation succeed
// (system UI dismisses the notification regardless) but the email/chat
// stayed unread on the server forever. Now we queue via offlineCache's
// replay engine so the next foreground / WS reconnect retries with the
// same backoff cadence as in-app actions.
async function _queueNotificationAction(actionType, params) {
  try {
    await queueOfflineAction({
      type: 'notification_action',
      action_type: actionType,
      params,
    });
  } catch (e) {
    _diagPush('notif_action_queue_err', e?.message || String(e));
  }
}

async function handleArchiveFromNotification(data) {
  const params = { uid: data.uid, folder: data.folder || 'INBOX', destination: 'Archive' };
  try {
    const { apiCall } = require('./api');
    await apiCall('move', params, 'POST');
  } catch (err) {
    _diagPush('notif_archive_offline', err?.message || String(err));
    await _queueNotificationAction('archive', params);
  }
}

async function handleMarkReadFromNotification(data) {
  const params = { uid: data.uid, folder: data.folder || 'INBOX' };
  try {
    const { apiCall } = require('./api');
    await apiCall('mark_read', params, 'POST');
  } catch (err) {
    _diagPush('notif_markread_offline', err?.message || String(err));
    await _queueNotificationAction('mark_read', params);
  }
}

async function handleDeleteFromNotification(data) {
  const params = { uid: data.uid, folder: data.folder || 'INBOX' };
  try {
    const { apiCall } = require('./api');
    await apiCall('delete', params, 'POST');
  } catch (err) {
    _diagPush('notif_delete_offline', err?.message || String(err));
    await _queueNotificationAction('delete', params);
  }
}

// [reply-v2] Em GRUPO, responder pela notificação cita a mensagem notificada
// (WhatsApp/Telegram); em privado não. Kill switch: __chatyy_native_reply_v2.
// [2026-10-18 read-id] id da msg que a notificação MOSTRAVA → chat_mark_read
// com message_id real (0 = "MAX(id) no servidor" marcava como lidas msgs que
// chegaram depois e o usuário nunca viu). Sem id no payload → 0 (legado).
function _notifMsgId(data) {
  try { const n = Number(data && data.message_id); return Number.isFinite(n) && n > 0 ? n : 0; } catch { return 0; }
}

function _notifReplyToId(data) {
  try {
    if (globalThis.__chatyy_native_reply_v2 === false) return null;
    const g = data && (data.is_group === '1' || data.is_group === true || data.is_group === 'true' || data.is_group === 1);
    const mid = Number(data && data.message_id);
    return g && Number.isFinite(mid) && mid > 0 ? mid : null;
  } catch { return null; }
}

// [2026-10-16 native-toast] Resposta rápida digitada no banner in-app nativo
// (components/NotificationToast.js → modules/expo-inapp-banner). Mesmo caminho
// da ação "Responder" do push: cmid único, fila offline, marca como lida.
export function sendQuickReplyFromBanner(data, text) {
  const t = String(text || '').trim();
  if (!data || !data.conversation_id || !t) return Promise.resolve(false);
  return handleChatReplyFromNotification(data.conversation_id, t, _notifReplyToId(data), _notifMsgId(data)).then(() => true, () => false);
}

async function handleChatReplyFromNotification(conversationId, text, replyToId = null, readUpToId = 0) {
  // [2026-10-15 mensagens-whatsapp] UM client_message_id para a 1ª tentativa E para
  // a fila: antes o chatSend gerava `cli_…` por dentro e, se a resposta se perdesse
  // (POST gravado no servidor), a fila reenviava com um `qr-…` NOVO → mensagem
  // DUPLICADA no destinatário. Mesmo formato msg_<ts>_ do app (ordem no hub).
  const cmid = 'msg_' + Date.now() + '_qr' + Math.random().toString(36).slice(2, 8);
  _localReadFromNotification(conversationId); // [2026-10-15 unread-instant] lista/aba/ícone/banners na hora
  try {
    const { chatSend, chatRead } = require('./api');
    const r = await chatSend(conversationId, text, 'text', replyToId || null, null, null, null, cmid);
    if (!r || r.success === false) throw new Error(r?.error || r?.message || 'chat_send_failed');
    // Mark as read too — best effort; failure here doesn't roll back the
    // send, just queues a chat_read retry.
    try {
      await chatRead(conversationId, readUpToId || 0);
    } catch (readErr) {
      await _queueNotificationAction('chat_read', { conversation_id: conversationId, ...(readUpToId ? { message_id: readUpToId } : null) });
    }
    try { await refreshBadgeCount?.(); } catch {}
  } catch (err) {
    // HTTP fallback dropped — queue as the canonical chat_send action that
    // replayOfflineQueue already knows how to retry (same backoff, same
    // server idempotency via client_message_id). Without the cmid, server
    // dedup can't protect us from a duplicate if the original POST actually
    // landed but the response was lost — so we mint one here.
    console.warn('[Push] Chat reply failed:', err?.message || err);
    _diagPush('notif_chat_reply_offline', err?.message || String(err));
    try {
      await queueOfflineAction({
        type: 'chat_send',
        conversation_id: conversationId,
        content: text,
        msgType: 'text',
        client_message_id: cmid,
        ...(replyToId ? { reply_to_id: replyToId } : null),
      });
      // Also queue a chat_read so when the reply finally lands, the
      // conversation is marked read just like the inline tap would.
      await _queueNotificationAction('chat_read', { conversation_id: conversationId, ...(readUpToId ? { message_id: readUpToId } : null) });
    } catch (qErr) {
      _diagPush('notif_chat_reply_queue_err', qErr?.message || String(qErr));
    }
  }
}

// [2026-10-15 unread-instant] Responder/Marcar lida pela notificação = o usuário
// leu (ação explícita dele) → zera local ANTES da rede: linha da lista, aba,
// ícone e banners. Antes: só após chat_send + chat_mark_read + chat_list (3 RTT
// em série) e, se o WS não voltasse, a linha ficava em negrito até o próximo sync.
function _localReadFromNotification(conversationId, extra = null) {
  try {
    let me = '';
    try { const a = require('./api'); const v = (a.getActiveAccountEmail?.() || a.getSavedEmail?.() || ''); me = typeof v === 'string' ? v.toLowerCase() : ''; } catch {}
    require('./unreadBadge').markConversationReadLocal(conversationId, { email: me, ...(extra || {}) });
  } catch {}
}

async function handleMarkReadChatFromNotification(conversationId, readUpToId = 0) {
  _localReadFromNotification(conversationId);
  try {
    const { chatRead } = require('./api');
    await chatRead(conversationId, readUpToId || 0);
    try { await refreshBadgeCount?.(); } catch {}
  } catch (err) {
    _diagPush('notif_chat_markread_offline', err?.message || String(err));
    await _queueNotificationAction('chat_read', { conversation_id: conversationId, ...(readUpToId ? { message_id: readUpToId } : null) });
  }
}

// ============================================================
// BADGE MANAGEMENT
// ============================================================

/**
 * Clear the app icon badge (set to 0).
 * Called when the user opens the app or reads all messages.
 */
// [2026-10-11 badge] iOS: mirror every icon-badge write into the App Group so
// the Notification Service Extension (plugins/notification-service) counts
// from the real number while the app is killed. No-op on binaries without
// ExpoChatyySystem.setBadgeMirror (OTA-safe) and on Android/web.
let _badgeMirrorMod;
function _mirrorBadge(count) {
  try {
    if (Platform.OS !== 'ios') return;
    if (_badgeMirrorMod === undefined) {
      _badgeMirrorMod = null;
      try {
        const { requireOptionalNativeModule } = require('expo');
        _badgeMirrorMod = requireOptionalNativeModule('ExpoChatyySystem') || null;
      } catch { _badgeMirrorMod = null; }
    }
    if (_badgeMirrorMod && typeof _badgeMirrorMod.setBadgeMirror === 'function') {
      _badgeMirrorMod.setBadgeMirror(Math.max(0, Math.floor(Number(count) || 0)));
    }
  } catch {}
}

export async function clearBadge() {
  try {
    const loaded = await loadModules();
    if (!loaded) return;
    await Notifications.setBadgeCountAsync(0);
    _mirrorBadge(0);
  } catch {}
}

/**
 * Set the app icon badge to an explicit count.
 * @param {number} count
 */
export async function setBadgeCount(count) {
  try {
    const loaded = await loadModules();
    if (!loaded) return;
    await Notifications.setBadgeCountAsync(Math.max(0, count));
    _mirrorBadge(count);
    try { require('./unreadBadge').noteIconBadge(count); } catch {}
  } catch {}
}

/**
 * Compute the total unread count (chat + email) from the backend
 * and update the app icon badge accordingly.
 *
 * Should be called:
 *   - After marking messages/emails as read
 *   - After receiving a silent_sync push
 *   - On app foreground (AppState change to 'active')
 */
export async function refreshBadgeCount(opts = null) {
  if (Platform.OS === 'web') return;
  try {
    const { chatUnreadCount, apiCall } = require('./api');

    // Chat unread
    let chatUnread = 0;
    try {
      const chatResp = await chatUnreadCount(opts); // [2026-10-13 P2-8] exclui a conversa aberta
      chatUnread = chatResp?.data?.unread_count ?? 0;
    } catch {}

    // [2026-10-14] Ícone conta SÓ chat (founder: e-mail não entra no número, igual WhatsApp).
    const total = chatUnread;
    await setBadgeCount(total);
    return total;
  } catch (err) {
    console.warn('[Push] refreshBadgeCount failed:', err.message);
    return 0;
  }
}

// ============================================================
// SILENT PUSH / BACKGROUND SYNC
// ============================================================

/**
 * Handle a silent data-only push that the server sends to keep the app fresh.
 *
 * The backend sends these via fcmSendSilentSync() after:
 *   - A new chat message is delivered to a conversation the user is in
 *   - A new email lands in the inbox
 *
 * This function runs in the background (called from the notification handler
 * before the notification is displayed — or from the BGAppRefreshTask on iOS).
 *
 * @param {object} data  FCM data payload: { type: 'silent_sync', since: '...', sync_type: 'chat'|'email'|'all' }
 */
export function triggerBackgroundSync(data = {}) {
  const syncType = data.sync_type || 'all';
  try {
    // Emit a WebSocket-like internal event so the chat list / inbox can refresh
    const ws = require('./websocket').default;
    if (ws && syncType !== 'email') {
      ws._emit('silent_sync', { type: 'chat', since: data.since });
    }
    if (ws && syncType !== 'chat') {
      ws._emit('silent_sync', { type: 'email', since: data.since });
    }
  } catch {}

  // [Round 1188 Agent F PATCH-5 2026-05-19] Force an envelope flush so the
  // recipient pulls the new ciphertext that triggered this wake. Without
  // this, the silent push arrives but envelopePuller's only trigger paths
  // (WS envelope_available / AppState=active / 30s safety) may all be
  // unavailable in the background — leaving the user waiting until the
  // next foreground transition. WhatsApp/Telegram parity: silent push =>
  // pull => decrypt => save => visible badge.
  try {
    if (syncType !== 'email') {
      const { flushEnvelopesNow } = require('./envelopePuller');
      if (typeof flushEnvelopesNow === 'function') {
        flushEnvelopesNow().catch(() => {});
      }
    }
  } catch {}

  // Refresh badge count in the background after sync
  refreshBadgeCount().catch(() => {});
}

// ============================================================
// RESPONSE HANDLER HELPERS (for new action identifiers)
// ============================================================

/**
 * Handle the VIEW action on feed/social notifications.
 * Navigates to the relevant feed post or profile.
 */
function handleViewFromNotification(data) {
  try {
    // [2026-10-17 notif-audit] /feed/:id (chat.js ignores post_id); follow → profile.
    const _fp = _feedPostTarget(data) || (data?.post_id && /^\d+$/.test(String(data.post_id)) ? `/feed/${data.post_id}` : '');
    if (_fp) {
      _pushOverHome(_fp);
    } else if (data?.follower_email) {
      _pushOverHome(`/u/${encodeURIComponent(data.follower_email)}`);
    } else {
      router.push('/chat?tab=feed');
    }
  } catch {}
}

/**
 * Handle the JOIN action on live broadcast notifications.
 */
function handleJoinLiveFromNotification(data) {
  try {
    if (data?.session_id) {
      router.push(`/live-viewer?session_id=${data.session_id}`);
    } else {
      router.push('/chat?tab=feed');
    }
  } catch {}
}

// Eagerly initialize notification handler on native so it's ready
// before the first push arrives (otherwise push might show as banner)
if (Platform.OS !== 'web') {
  loadModules().catch(() => {});
}
