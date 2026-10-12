// services/callQualityPrompt.js — [2026-10-12 call-review] "Como foi a ligação?"
//
// WhatsApp-parity call quality feedback. The 72 h data review (voip_diag +
// LiveKit + hub) could only INFER quality (track published, bitrate, drops);
// nothing said whether the people on the call actually heard each other.
// After some answered calls we ask for 1–5 stars (+ what went wrong when ≤ 3)
// and log it as `js_call_rating` in voip_diag, next to the native CallDiag
// events of the same call_id.
//
// Rules (never nag): mobile only, call ≥ 20 s, app in foreground, at most one
// prompt every 3 days, sampled (~1 in 3), once per call_id.
//   Caller: nativeOutgoingCall._finish → noteCallEnded({ role: 'caller' }).
//   Callee: native onCallAnswered → onCallEnded (installCalleeHooks).
import { Platform, AppState, DeviceEventEmitter } from 'react-native';

export const CALL_RATING_EVENT = 'chatyy_call_rating_prompt';

const KEY_LAST = 'chatyy_call_rating_last_v1';
const MIN_DURATION_S = 20;
const COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
const SAMPLE_RATE = 0.34;
const SHOW_DELAY_MS = 900; // let the native call screen finish dismissing

const _prompted = new Set();
const _answeredAt = new Map(); // callId → { at, video }
let _calleeHooksInstalled = false;
let _lastPromptMemo = 0;

function _storage() {
  try { return require('@react-native-async-storage/async-storage').default; } catch { return null; }
}

async function _lastPromptAt() {
  if (_lastPromptMemo) return _lastPromptMemo;
  try {
    const v = await _storage()?.getItem(KEY_LAST);
    _lastPromptMemo = Number(v) || 0;
  } catch {}
  return _lastPromptMemo;
}

function _markPrompted() {
  _lastPromptMemo = Date.now();
  try { _storage()?.setItem(KEY_LAST, String(_lastPromptMemo)); } catch {}
}

function _diag(evt, callId, detail) {
  try {
    const { voipDiag } = require('./voipDiag');
    if (typeof voipDiag === 'function') voipDiag(evt, callId, detail);
  } catch {}
}

/** A 1:1 call ended on this device. Decides (async) whether to ask. */
export async function noteCallEnded({ callId, durationSec, video, role } = {}) {
  try {
    if (Platform.OS === 'web') return;
    const id = String(callId || '');
    if (!id || _prompted.has(id)) return;
    if (!(Number(durationSec) >= MIN_DURATION_S)) return;
    _prompted.add(id);
    if (Date.now() - (await _lastPromptAt()) < COOLDOWN_MS) return;
    if (Math.random() > SAMPLE_RATE) return;
    setTimeout(() => {
      try {
        if (AppState.currentState !== 'active') return;
        // Another call already up (answered in the meantime). NOT
        // __chatyyCallActive: it stays true for a 30 s auth-storm grace.
        if (globalThis.__chatyyNativeCallActive === true) return;
        _markPrompted();
        _diag('js_call_rating_shown', id, `role=${role || ''} dur=${Math.round(durationSec)}`);
        DeviceEventEmitter.emit(CALL_RATING_EVENT, {
          callId: id,
          durationSec: Math.round(durationSec),
          video: !!video,
          role: role || '',
        });
      } catch {}
    }, SHOW_DELAY_MS);
  } catch {}
}

/** User answered the prompt. stars 1–5; issues = array of issue keys. */
export function submitCallRating(p, stars, issues) {
  try {
    const list = Array.isArray(issues) ? issues.filter(Boolean).join(',') : '';
    _diag('js_call_rating', String(p?.callId || ''),
      `stars=${Number(stars) || 0} issues=${list || '-'} dur=${p?.durationSec || 0} video=${p?.video ? 1 : 0} role=${p?.role || ''} plat=${Platform.OS}`);
  } catch {}
}

export function dismissCallRating(p) {
  _diag('js_call_rating_dismissed', String(p?.callId || ''), `role=${p?.role || ''}`);
}

/** Callee side: native answer → native end gives the talk time. Idempotent. */
export function installCalleeHooks() {
  if (_calleeHooksInstalled || Platform.OS === 'web') return () => {};
  let ck = null;
  try { ck = require('../modules/expo-callkit'); } catch { ck = null; }
  if (!ck || typeof ck.onCallAnswered !== 'function' || typeof ck.onCallEnded !== 'function') return () => {};
  _calleeHooksInstalled = true;
  const subs = [];
  try {
    subs.push(ck.onCallAnswered((d) => {
      if (!d || d.resumed || !d.callId) return; // resume of a held call ≠ answer
      if (String(d.callId).startsWith('group_')) return;
      if (!_answeredAt.has(d.callId)) _answeredAt.set(String(d.callId), { at: Date.now(), video: !!(d.hasVideo || d.video) });
    }));
    subs.push(ck.onCallEnded((d) => {
      if (!d || d.held || !d.callId) return; // hold ≠ end
      const a = _answeredAt.get(String(d.callId));
      if (!a) return;
      _answeredAt.delete(String(d.callId));
      noteCallEnded({ callId: d.callId, durationSec: (Date.now() - a.at) / 1000, video: a.video, role: 'callee' });
    }));
  } catch {}
  return () => {
    _calleeHooksInstalled = false;
    for (const u of subs) { try { typeof u === 'function' ? u() : u?.remove?.(); } catch {} }
  };
}
