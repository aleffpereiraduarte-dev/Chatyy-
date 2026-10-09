// =============================================================================
// [2026-10-09 system-integration] OS integration (WhatsApp parity)
//
//   1. Conversation snapshot → native ExpoChatyySystem.setConversations:
//        iOS: App Group for Siri/Atalhos App Intents (plugins/with-system-intents.js),
//             home/lock-screen widgets (plugins/with-chatyy-widgets.js) and the
//             NSE Focus-filter tag (pinned ids).
//        Android: home-screen widget (expo-native-toolkit widget/ChatyyConversationsWidget).
//      Locked / hidden / archived chats NEVER leave the app. With the app lock
//      (Face ID / biometria) on, the widget shows only "Chatyy bloqueado".
//   2. System data saver: iOS Low Data Mode (NWPath.isConstrained) and Android
//      Data Saver (restrictBackgroundStatus) → isSystemDataSaverOn(), consumed
//      by services/mediaCache.isDataSaverOn() (no media auto-download, no video
//      pre-cache — same rules as the in-app "Economia de dados" switch).
//   3. Assistant / Siri / Recents deep links: resolveAssistantAction() maps
//      { kind, name|email|id, text } to a chat-conversation href
//      (app/assistant-action/[kind].js).
//
// Native module resolved lazily with requireOptionalNativeModule — binaries
// without ExpoChatyySystem turn every call into a no-op (OTA-safe).
// =============================================================================

import { Platform, AppState } from 'react-native';

const DEBOUNCE_MS = 2000;
const MAX_ITEMS = 30;

let _mod; // undefined = unresolved; null = unavailable
let _timer = null;
let _pending = null;
let _lastSig = null;

function getModule() {
  if (Platform.OS === 'web') return null;
  if (_mod !== undefined) return _mod;
  _mod = null;
  try {
    const { requireOptionalNativeModule } = require('expo');
    _mod = requireOptionalNativeModule('ExpoChatyySystem') || null;
  } catch {
    _mod = null;
  }
  return _mod;
}

export function isSystemIntegrationAvailable() {
  return !!getModule();
}

function _ts(c) {
  const v = c?.last_message_at || c?.updated_at || c?.last_message_time || 0;
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}

function _appLockOn() {
  try {
    const SecureStore = require('expo-secure-store');
    if (typeof SecureStore.getItem !== 'function') return false;
    return SecureStore.getItem('biometric_enabled') === 'true';
  } catch { return false; }
}

/** Pure: shape the snapshot (exported for tests). */
export function buildSystemSnapshot(conversations, { me = '', lockedIds = null } = {}) {
  const meLc = String(me || '').toLowerCase();
  const list = Array.isArray(conversations) ? conversations : [];
  const out = [];
  const sorted = list
    .filter((c) => c && c.id != null && !c.archived && !c.locked && !c.hidden
      && !(lockedIds && typeof lockedIds.has === 'function' && (lockedIds.has(c.id) || lockedIds.has(String(c.id))))
      && c.type !== 'saved' && c.type !== 'channel' && c.type !== 'broadcast')
    .sort((a, b) => _ts(b) - _ts(a));
  for (const c of sorted) {
    if (out.length >= MAX_ITEMS) break;
    const isGroup = c.type === 'group' || !!c.is_group;
    let email = isGroup ? '' : String(c.other_email || c.contact_email || '').trim();
    if (email && email.toLowerCase() === meLc) continue; // self-chat
    let name = String(c.display_name || c.name || email || '').trim();
    if (!isGroup && name.includes('@')) {
      try { name = require('./api').emailToDisplayName(name) || name; } catch {}
    }
    if (!name) continue;
    out.push({
      id: String(c.id),
      name,
      email: email.toLowerCase(),
      type: isGroup ? 'group' : 'direct',
      pinned: !!c.pinned,
      unread: Math.max(0, Number(c.unread_count) || 0),
      muted: !!c.muted,
      lastMessageAt: String(c.last_message_at || c.updated_at || ''),
      avatarUrl: String(c.avatar_url || c.group_avatar || ''),
      acct: String(me || ''),
    });
  }
  return out;
}

function _flush() {
  _timer = null;
  const job = _pending;
  _pending = null;
  if (!job) return;
  const m = getModule();
  if (!m?.setConversations) return;
  const sig = JSON.stringify([job.locked, job.items.map((i) => [i.id, i.name, i.pinned, i.unread, i.type])]);
  if (sig === _lastSig) return;
  _lastSig = sig;
  try {
    Promise.resolve(m.setConversations(job.items, { locked: job.locked })).catch(() => { _lastSig = null; });
  } catch { _lastSig = null; }
}

/** Debounced; call whenever the chat list changes (cheap before debounce). */
export function scheduleSystemSnapshot(conversations, opts) {
  if (Platform.OS === 'web') return;
  if (!getModule()) return;
  try {
    _pending = { items: buildSystemSnapshot(conversations, opts), locked: _appLockOn() };
  } catch { return; }
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(_flush, DEBOUNCE_MS);
}

/** Logout / account wipe: empties widgets + Siri contact list. */
export function clearSystemIntegration() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _pending = null;
  _lastSig = null;
  const m = getModule();
  if (!m?.clear) return;
  try { Promise.resolve(m.clear()).catch(() => {}); } catch {}
}

// ─── System data saver ────────────────────────────────────────────────────
let _constraints = { dataSaver: false, constrained: false, expensive: false };
let _dsInit = false;
const _dsListeners = new Set();

function _applyConstraints(c) {
  if (!c || typeof c !== 'object') return;
  const next = {
    dataSaver: !!(c.dataSaver || c.constrained),
    constrained: !!c.constrained,
    expensive: !!c.expensive,
  };
  const changed = next.dataSaver !== _constraints.dataSaver;
  _constraints = next;
  if (changed) {
    for (const fn of _dsListeners) { try { fn(next.dataSaver); } catch {} }
  }
}

function _refreshConstraints() {
  const m = getModule();
  if (!m?.getNetworkConstraints) return;
  try { _applyConstraints(m.getNetworkConstraints()); } catch {}
}

/** Starts listening (idempotent). Safe to call from anywhere. */
export function initSystemDataSaver() {
  if (_dsInit || Platform.OS === 'web') return;
  _dsInit = true;
  const m = getModule();
  if (!m) return;
  _refreshConstraints();
  try { m.addListener?.('onNetworkConstraints', (c) => _applyConstraints(c)); } catch {}
  try {
    AppState.addEventListener('change', (s) => { if (s === 'active') _refreshConstraints(); });
  } catch {}
}

/** iOS Low Data Mode / Android Data Saver currently restricting this app. */
export function isSystemDataSaverOn() {
  if (!_dsInit) initSystemDataSaver();
  return !!_constraints.dataSaver;
}

export function onSystemDataSaverChange(fn) {
  if (typeof fn !== 'function') return () => {};
  _dsListeners.add(fn);
  return () => _dsListeners.delete(fn);
}

/** iOS Focus filter values (null when unset / Android). */
export function getFocusFilterState() {
  const m = getModule();
  if (!m?.getFocusFilter) return null;
  try { return m.getFocusFilter() || null; } catch { return null; }
}

// ─── Assistant / Siri / Recents ───────────────────────────────────────────
function _norm(s) {
  try {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  } catch {
    return String(s || '').toLowerCase().trim();
  }
}

function _cachedConversations() {
  try {
    const sc = require('./smartChatCache');
    const list = sc?.getCachedConversationsSync?.();
    if (Array.isArray(list) && list.length) return list;
  } catch {}
  try {
    const cs = require('./chatStore');
    const list = cs?.getConversationsSync?.();
    if (Array.isArray(list)) return list;
  } catch {}
  return [];
}

/**
 * Finds the conversation for an assistant request. Exact id → exact email →
 * exact name → name prefix → name contains (locked/archived excluded).
 */
export function findConversationForAssistant({ id = '', email = '', name = '' } = {}, opts = {}) {
  const list = buildSystemSnapshot(_cachedConversations(), opts);
  if (id) {
    const hit = list.find((c) => c.id === String(id));
    if (hit) return hit;
  }
  const em = _norm(email);
  if (em) {
    const hit = list.find((c) => c.email && _norm(c.email) === em);
    if (hit) return hit;
  }
  const q = _norm(name);
  if (!q) return null;
  return list.find((c) => _norm(c.name) === q)
    || list.find((c) => _norm(c.name).startsWith(q))
    || list.find((c) => _norm(c.name).split(/\s+/).some((w) => w === q))
    || list.find((c) => _norm(c.name).includes(q))
    || null;
}

/**
 * kind: 'message' | 'call' | 'video'. Returns { href, conv } or { href: null }.
 * Message text goes to ?prefill= (the user confirms with Send — Assistant
 * never sends on its own); calls go through ?autocall= so the in-chat call
 * pipeline (CallKit/ConnectionService, LiveKit, native UI) runs unchanged.
 */
export function resolveAssistantAction({ kind = 'message', id = '', email = '', name = '', text = '' } = {}, opts = {}) {
  const conv = findConversationForAssistant({ id, email, name }, opts);
  if (!conv) return { href: null, conv: null };
  const q = [
    `id=${encodeURIComponent(conv.id)}`,
    `type=${conv.type}`,
    `name=${encodeURIComponent(conv.name)}`,
  ];
  if (conv.email) q.push(`email=${encodeURIComponent(conv.email)}`);
  q.push('src=assistant');
  const k = String(kind || '').toLowerCase();
  if (k === 'call' || k === 'audio') q.push('autocall=audio');
  else if (k === 'video') q.push('autocall=video');
  // chat-conversation decodeURIComponent()s ?prefill= AFTER expo-router already
  // decoded it → encode twice so "%" / "+" in the text survive.
  else if (text) q.push(`prefill=${encodeURIComponent(encodeURIComponent(String(text).slice(0, 2000)))}`);
  return { href: `/chat-conversation?${q.join('&')}`, conv };
}
