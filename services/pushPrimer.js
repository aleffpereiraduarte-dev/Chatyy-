// [2026-10-07 native-polish] Push pre-permission ("primer") state.
//
// Gap analysis P0-6: 56% of iPhones denied push because the raw OS dialog
// popped right after login with zero context (app/_layout.js + AuthContext
// both call ensurePushTokenFresh as soon as authUser exists). WhatsApp asks in
// context with an explanation first. Now:
//   • registerForPushNotifications() NO LONGER fires the OS dialog on the
//     automatic (cold start / foreground / login) path while the permission is
//     still undetermined — it marks the primer as "needed" here instead
//     (iOS additionally gets PROVISIONAL authorization, which shows no dialog
//     and delivers quietly to Notification Center → token + NSE device-ack ✓✓
//     keep working while the user hasn't decided).
//   • components/PushPermissionPrimer.js shows our own sheet (SVG + "Ativar")
//     the first time a chat is opened (requestPushPrimer('chat_open')).
//     "Ativar" → the OS dialog. "Agora não" → re-offered with backoff
//     (1d, 3d, 7d; max 4 offers).
//   • Explicit user actions (Settings toggle, stale-banner retry) still go
//     straight to the OS dialog.
//
// Pure JS / OTA-safe: depends only on the sync mmkv cache (settings keys are
// hydrated eagerly before the cache-ready gate).
import { Platform } from 'react-native';
import { getJSON, setJSON } from './mmkv';

// Kill switch: false → old behaviour (OS dialog on the automatic path).
export const PUSH_PRIMER_ENABLED = true;

const STATE_KEY = 'push_primer_v1';
const BACKOFF_MS = [0, 24 * 3600e3, 3 * 24 * 3600e3, 7 * 24 * 3600e3];
const MAX_OFFERS = 4;

let _needed = false;
let _showing = false;
const _listeners = new Set();

function _readState() {
  try {
    const s = getJSON(STATE_KEY, null);
    if (s && typeof s === 'object') return s;
  } catch {}
  return { offers: 0, lastOfferAt: 0, done: false };
}

function _writeState(s) {
  try { setJSON(STATE_KEY, s); } catch {}
}

function _emit(evt) {
  _listeners.forEach((fn) => { try { fn(evt); } catch {} });
}

/** Subscribe to { type: 'show', reason } events. Returns unsubscribe. */
export function subscribePushPrimer(fn) {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

/** Called by pushNotifications when the automatic path skipped the OS dialog. */
export function markPushPrimerNeeded(needed) {
  _needed = !!needed;
}

export function isPushPrimerNeeded() {
  return _needed;
}

/**
 * Ask the UI to show the primer, if it is needed and not in backoff.
 * Safe to call often (e.g. on every chat open) — it is a cheap no-op after
 * the user decided or while the backoff window is open.
 */
export function requestPushPrimer(reason = 'chat_open') {
  if (!PUSH_PRIMER_ENABLED || Platform.OS === 'web') return false;
  if (!_needed || _showing) return false;
  const s = _readState();
  if (s.done) return false;
  const offers = Number(s.offers) || 0;
  if (offers >= MAX_OFFERS) return false;
  const wait = BACKOFF_MS[Math.min(offers, BACKOFF_MS.length - 1)] || 0;
  if (offers > 0 && Date.now() - (Number(s.lastOfferAt) || 0) < wait) return false;
  if (_listeners.size === 0) return false; // primer host not mounted yet
  _showing = true;
  _writeState({ ...s, offers: offers + 1, lastOfferAt: Date.now() });
  _emit({ type: 'show', reason });
  return true;
}

/** Primer closed. accepted=true → user tapped "Ativar" (OS dialog follows). */
export function pushPrimerClosed(accepted) {
  _showing = false;
  if (accepted) {
    const s = _readState();
    _writeState({ ...s, done: true });
    _needed = false;
  }
}

/**
 * [2026-10-07 welcome] The first-run flow showed its own notifications step
 * and the user tapped "Agora não": count it as an offer so the chat_open
 * primer respects the same backoff (no second sheet on the very first chat).
 */
export function recordPushPrimerOffer() {
  const s = _readState();
  if (s.done) return;
  _writeState({ ...s, offers: (Number(s.offers) || 0) + 1, lastOfferAt: Date.now() });
}
