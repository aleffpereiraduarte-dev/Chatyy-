// [2026-10-09 native-group-call] Routes mobile GROUP calls to the fully
// native screen (iOS GroupCallViewController / Android GroupCallActivity,
// LiveKit native SDK) when:
//   1. not web (web keeps the LiveKit web room via /call?groupCall=1),
//   2. NATIVE_GROUP_CALL_UI is on for this account (constants/featureFlags),
//   3. the installed binary reports supportsNativeGroupCallUI() >= 1
//      (builds after 2026-10-09 — older binaries silently keep /call.js).
//
// Signaling is unchanged: the caller still fans out the invite exactly like
// before (chat-conversation → api.callNotify / chat_call_invite_v2 path),
// the native screen only owns media + UI. Leaving the group call never sends
// call_end (the call continues for the others) — we only close our own
// history row / heartbeat when the native screen reports onCallEnded.
//
// Every entry point is best-effort: any failure returns false and the caller
// falls back to router.push('/call?…&groupCall=1').
import { Platform } from 'react-native';
import { isNativeGroupCallUiEnabled } from '../constants/featureFlags';

let _ck;
function _callkit() {
  if (Platform.OS === 'web') return null;
  if (_ck !== undefined) return _ck;
  try { _ck = require('../modules/expo-callkit'); } catch { _ck = null; }
  return _ck;
}

function _myEmail(email) {
  if (email) return String(email).toLowerCase();
  try {
    const g = String(globalThis.__chatyyMyEmail || '').toLowerCase();
    if (g) return g;
  } catch {}
  try {
    const { getSavedEmail } = require('./api');
    if (typeof getSavedEmail === 'function') return String(getSavedEmail() || '').toLowerCase();
  } catch {}
  return '';
}

/** Native contract version available in this binary (0 = none). */
export function nativeGroupCallVersion() {
  const m = _callkit();
  try {
    return m && typeof m.nativeGroupCallUiVersion === 'function' ? Number(m.nativeGroupCallUiVersion()) || 0 : 0;
  } catch {
    return 0;
  }
}

/** True when this device + account should use the native group screen. */
export function canUseNativeGroupCall(email) {
  if (Platform.OS === 'web') return false;
  try { if (!isNativeGroupCallUiEnabled(_myEmail(email))) return false; } catch { return false; }
  return nativeGroupCallVersion() >= 1;
}

/**
 * Mirror the flag into native storage (iOS App Group / Android prefs) so the
 * CallKit answer path — which runs without JS — routes GROUP calls to the
 * native group screen. Call after login / cold-start auth hydrate.
 */
export function syncNativeGroupCallFlag(email) {
  if (Platform.OS === 'web') return false;
  try { globalThis.__chatyyMyEmail = String(email || '').toLowerCase() || globalThis.__chatyyMyEmail; } catch {}
  const m = _callkit();
  if (!m || typeof m.setNativeGroupCallUiEnabled !== 'function') return false;
  try {
    return m.setNativeGroupCallUiEnabled(canUseNativeGroupCall(email));
  } catch {
    return false;
  }
}

// callId → { startedAt, hb, unsub, conversationId, isVideo, isOutgoing, title }
const _sessions = new Map();

function _devId() {
  try {
    return globalThis.__chatyyCallDevId || (globalThis.__chatyyCallDevId = 'dev-' + Math.random().toString(36).slice(2, 10));
  } catch {
    return '';
  }
}

function _setCallActive(active, callId) {
  try {
    const { setCallActive } = require('../components/IncomingCallListener');
    if (typeof setCallActive === 'function') setCallActive(active, callId);
  } catch {}
}

function _finishSession(callId) {
  const s = _sessions.get(callId);
  if (!s) return;
  _sessions.delete(callId);
  try { clearInterval(s.hb); } catch {}
  try { s.unsub && s.unsub(); } catch {}
  _setCallActive(false, callId);
  const dur = Math.max(0, Math.round((Date.now() - s.startedAt) / 1000));
  // Our own history row (the call itself goes on for the others).
  try {
    const { addCallToHistory } = require('../components/ChatCallsTab');
    if (typeof addCallToHistory === 'function') {
      addCallToHistory({
        contactEmail: '',
        contactName: s.title || '',
        callId,
        type: s.isOutgoing ? 'outgoing' : 'incoming',
        video: !!s.isVideo,
        timestamp: s.startedAt,
        duration: dur,
        isGroup: true,
      }).catch?.(() => {});
    }
  } catch {}
}

/**
 * Open a group call on the native screen.
 * @returns {Promise<boolean>} true = native screen is up (do NOT push /call).
 */
export async function openNativeGroupCall({
  callId,
  conversationId,
  isVideo = false,
  isCaller = false,
  title = '',
  members = [],
  email = '',
  // Pre-minted token (call links mint via chat_call_link_join).
  token: preToken = '',
  url: preUrl = '',
  iceServers: preIce = null,
} = {}) {
  if (!callId || !canUseNativeGroupCall(email)) return false;
  const m = _callkit();
  if (!m || typeof m.openNativeGroupCall !== 'function') return false;
  if (_sessions.has(String(callId))) {
    // Already running (minimized) → the native side just brings it back.
    try { return await m.openNativeGroupCall({ roomName: String(callId), hasVideo: !!isVideo, isOutgoing: !!isCaller }); } catch { return false; }
  }
  const api = require('./api');
  let token = String(preToken || '');
  let url = String(preUrl || '');
  let room = String(callId);
  let ice = Array.isArray(preIce) ? preIce : [];
  if (!token || !url) try {
    const r = await api.chatLivekitToken(Number(conversationId) || 0, String(callId));
    if (!(r?.success && r.data?.token)) {
      // Room full / no permission / disbanded group → let /call.js show the
      // proper error UI.
      return false;
    }
    token = r.data.token;
    url = r.data.url || 'wss://livekit.chatyy.com.br';
    room = String(r.data.room || callId);
    const _ice = r.data.iceServers || r.data.ice_servers;
    if (Array.isArray(_ice)) ice = _ice;
  } catch {
    return false;
  }
  const me = _myEmail(email);
  const participants = (Array.isArray(members) ? members : [])
    .map((x) => ({
      email: String(x?.email || x?.user_email || '').toLowerCase(),
      name: String(x?.name || x?.display_name || x?.user_name || '').trim(),
    }))
    .filter((x) => x.email && x.email !== me)
    .slice(0, 31);
  let ok = false;
  try {
    ok = await m.openNativeGroupCall({
      roomName: room,
      lkUrl: url,
      lkToken: token,
      iceServers: ice,
      conversationId: String(conversationId || ''),
      title: String(title || ''),
      hasVideo: !!isVideo,
      isOutgoing: !!isCaller,
      participants,
    });
  } catch {
    ok = false;
  }
  if (!ok) return false;

  // Session bookkeeping: incoming-call gating, multi-device heartbeat,
  // history row on end.
  _setCallActive(true, room);
  const devId = _devId();
  const beat = () => { try { api.chatCallHeartbeat?.(room, devId)?.catch?.(() => {}); } catch {} };
  beat();
  const hb = setInterval(beat, 5000);
  let unsub = null;
  try {
    unsub = m.onCallEnded?.((data) => {
      const cid = String(data?.callId || '');
      if (cid && cid === room) _finishSession(room);
    });
  } catch {}
  _sessions.set(room, {
    startedAt: Date.now(),
    hb,
    unsub,
    conversationId: String(conversationId || ''),
    isVideo: !!isVideo,
    isOutgoing: !!isCaller,
    title: String(title || ''),
  });
  return true;
}

export function isNativeGroupCallActive(callId) {
  return _sessions.has(String(callId || ''));
}

export default {
  canUseNativeGroupCall,
  nativeGroupCallVersion,
  syncNativeGroupCallFlag,
  openNativeGroupCall,
  isNativeGroupCallActive,
};
