// =============================================================================
// [2026-10-08 android-otp-shortcuts] App-icon quick actions (long-press icon)
//
// Static items (Nova conversa / Câmera / Escrever e-mail) come from
// plugins/with-app-shortcuts.js. This service manages:
//   1. DYNAMIC items = top 4 recent conversations (debounced, deduped by a
//      signature so the launcher's rate limiter is never hit on every WS tick).
//      Android: ShortcutManagerCompat (same "chat_<id>" ids/deep links as the
//      MessagingStyle notification shortcuts in modules/expo-callkit → update
//      in place, no duplicates). iOS: UIApplication.shortcutItems.
//   2. iOS launch routing: quick-action URL is parked natively (cold start)
//      or emitted as "onShortcut" (warm) → routed through expo-router.
//      Android needs nothing: shortcuts are ACTION_VIEW deep links that
//      Linking/expo-router already handle.
//
// Native module resolved lazily (requireOptionalNativeModule at call time) —
// older binaries without ExpoAppShortcuts make every call a no-op.
// =============================================================================

import { Platform } from 'react-native';

const DEBOUNCE_MS = 2500;
const MAX_RECENTS = 4;
const SCHEME_PREFIX = 'onemundomail://';

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
    _mod = requireOptionalNativeModule('ExpoAppShortcuts') || null;
  } catch {
    _mod = null;
  }
  return _mod;
}

function _ts(c) {
  const v = c?.last_message_at || c?.updated_at || c?.last_message_time || 0;
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}

function _peerEmail(c, meLc) {
  const e = String(c?.other_email || c?.contact_email || '').trim();
  if (e && e.toLowerCase() !== meLc) return e;
  return '';
}

/** Pure: pick + shape the top recents (exported for tests). */
export function pickRecentConversations(conversations, { me = '', lockedIds = null } = {}) {
  const meLc = String(me || '').toLowerCase();
  const list = Array.isArray(conversations) ? conversations : [];
  const out = [];
  const sorted = list
    .filter((c) => c && c.id != null && !c.archived && !c.locked && !c.hidden
      && !(lockedIds && typeof lockedIds.has === 'function' && lockedIds.has(c.id))
      && c.type !== 'saved' && c.type !== 'channel' && c.type !== 'broadcast')
    .sort((a, b) => _ts(b) - _ts(a));
  for (const c of sorted) {
    if (out.length >= MAX_RECENTS) break;
    const isGroup = c.type === 'group' || !!c.is_group;
    const email = isGroup ? '' : _peerEmail(c, meLc);
    // Self-chat (Saved Messages) has its own screen — skip.
    if (!isGroup && meLc && String(c.other_email || '').toLowerCase() === meLc) continue;
    let name = String(c.display_name || c.name || email || '').trim();
    if (!isGroup && name.includes('@')) {
      try { name = require('./api').emailToDisplayName(name) || name; } catch {}
    }
    if (!name) continue;
    out.push({
      id: String(c.id),
      name,
      type: isGroup ? 'group' : 'direct',
      email,
      avatarUrl: String(c.avatar_url || c.group_avatar || ''),
      acct: String(me || ''),
    });
  }
  return out;
}

function _flush() {
  _timer = null;
  const items = _pending;
  _pending = null;
  if (!items) return;
  const m = getModule();
  if (!m?.setRecentConversations) return;
  const sig = JSON.stringify(items.map((i) => [i.id, i.name, i.type, i.email, i.acct]));
  if (sig === _lastSig) return;
  _lastSig = sig;
  try {
    Promise.resolve(m.setRecentConversations(items)).catch(() => { _lastSig = null; });
  } catch { _lastSig = null; }
}

/**
 * Debounced update of the dynamic "recent conversations" shortcuts. Call
 * whenever the chat list changes; cheap (only a sort + slice before debounce).
 */
export function scheduleRecentConversations(conversations, opts) {
  if (Platform.OS === 'web') return;
  try {
    _pending = pickRecentConversations(conversations, opts);
  } catch { return; }
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(_flush, DEBOUNCE_MS);
}

/** Removes the dynamic conversation shortcuts (logout / account wipe). */
export function clearAppShortcuts() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _pending = null;
  _lastSig = null;
  const m = getModule();
  if (!m?.clear) return;
  try { Promise.resolve(m.clear()).catch(() => {}); } catch {}
}

/** onemundomail://chat-new?x=1 → /chat-new?x=1 (null when not ours). */
export function shortcutUrlToHref(url) {
  if (typeof url !== 'string' || !url.startsWith(SCHEME_PREFIX)) return null;
  const rest = url.slice(SCHEME_PREFIX.length).replace(/^\/+/, '');
  if (!rest || rest.startsWith('?')) return null;
  return '/' + rest;
}

/** iOS: takes (and clears) the quick-action URL parked by native. */
export function consumePendingShortcut() {
  if (Platform.OS !== 'ios') return null;
  const m = getModule();
  if (!m?.getPendingShortcut) return null;
  try { return m.getPendingShortcut() || null; } catch { return null; }
}

/**
 * iOS: routes quick-action launches (cold: parked URL; warm: "onShortcut").
 * `navigate(href)` receives an expo-router href. Returns an unsubscribe fn.
 */
export function initShortcutLaunchHandling(navigate) {
  if (Platform.OS !== 'ios' || typeof navigate !== 'function') return () => {};
  const m = getModule();
  if (!m) return () => {};
  const route = () => {
    const url = consumePendingShortcut();
    const href = shortcutUrlToHref(url);
    if (href) { try { navigate(href); } catch {} }
  };
  let sub = null;
  try { sub = m.addListener?.('onShortcut', () => route()) || null; } catch { sub = null; }
  // Cold start: give the root navigator a beat to mount (same grace the
  // notification/share deep-link paths use).
  const t = setTimeout(route, 400);
  return () => {
    clearTimeout(t);
    try { sub?.remove?.(); } catch {}
  };
}
