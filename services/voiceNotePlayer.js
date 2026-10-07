// [2026-10-07 voice-native] Global voice-note player — WhatsApp parity.
//
// ONE player for the whole app (module singleton, outside React):
//   • survives leaving the chat → components/chat/VoiceMiniPlayer.js shows a
//     mini bar whenever the playing note has no bubble on screen;
//   • auto-advances to the next consecutive voice note from the same sender
//     (resolver registered by the chat screen; kept "detached" after the
//     screen unmounts so the chain keeps going from the mini bar);
//   • speed 1× / 1.5× / 2× is global + persisted (MMKV / localStorage);
//   • "played" receipt (blue mic) only after the listener actually heard
//     ≥ min(2 s, 40 % of the note) — or reached the end — never on tap;
//   • raise-to-ear (proximity → earpiece + screen off) on the native engine.
//
// Engines (picked per play):
//   native — ExpoNativeAudio.voice* (AVPlayer / MediaPlayer + proximity). Only
//            in binaries built with VoiceNotePlayer.{swift,kt}; feature-detected
//            lazily via requireOptionalNativeModule (never throws, no eager
//            TurboModule probing at import time).
//   expo   — expo-audio createAudioPlayer (older binaries, OTA-safe fallback).
//   web    — HTMLAudioElement.
//
// Progress: engines tick ~4 Hz; subscribers (bubble / mini bar) receive the
// raw position and interpolate on the UI thread (Reanimated withTiming) —
// no React state per tick. React only re-renders on coarse changes
// (active item, playing, loading, rate, earpiece) via useSyncExternalStore.
import { Platform } from 'react-native';
import { useMemo, useSyncExternalStore } from 'react';

export const VOICE_TICK_MS = 250;
const RATE_KEY = 'voice_playback_rate';
const RATE_ALLOWED = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
export const VOICE_RATE_STEPS = [1, 1.5, 2];
const PLAYED_KEY = 'chatyy_played_audio_v1';

// ── Tiny persistence helpers (MMKV on native, localStorage on web) ─────
function _getStr(key) {
  try {
    if (Platform.OS === 'web') {
      return (typeof localStorage !== 'undefined') ? localStorage.getItem(key) : null;
    }
    const { getString } = require('./mmkv');
    return getString?.(key) ?? null;
  } catch { return null; }
}
function _setStr(key, val) {
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, val);
      return;
    }
    const { setString } = require('./mmkv');
    setString?.(key, val);
  } catch {}
}

export function readVoiceRate() {
  const n = Number(_getStr(RATE_KEY));
  return RATE_ALLOWED.includes(n) ? n : 1;
}

// ── Locally-played set (the small dot on INCOMING notes) ───────────────
let _played = null;
function _playedSet() {
  if (_played) return _played;
  try {
    const raw = _getStr(PLAYED_KEY);
    _played = new Set(raw ? JSON.parse(raw) : []);
  } catch { _played = new Set(); }
  return _played;
}
export function isLocallyPlayed(id) {
  if (id == null) return false;
  return _playedSet().has(String(id));
}
export function markLocallyPlayed(id) {
  if (id == null) return;
  const s = _playedSet();
  const key = String(id);
  if (s.has(key)) return;
  s.add(key);
  if (s.size > 5000) {
    const it = s.values();
    for (let i = 0; i < 500; i++) s.delete(it.next().value);
  }
  try { _setStr(PLAYED_KEY, JSON.stringify(Array.from(s))); } catch {}
}

// ── State ──────────────────────────────────────────────────────────────
let _state = {
  item: null,        // { messageId, url, uri?, conversationId, durationMs, isOwn, senderEmail, title }
  playing: false,
  loading: false,
  rate: readVoiceRate(),
  earpiece: false,
  error: null,
};
let _positionMs = 0;
let _durationMs = 0;
const _listeners = new Set();
const _posListeners = new Map();      // messageId(str) → Set<fn>
const _surfaces = new Map();          // messageId(str) → mounted bubble count
const _convCtx = new Map();           // convId(str) → { title, resolveNext, detached }
const _pendingStart = new Map();      // messageId(str) → startMs (scrubbed while idle)
const _receiptDone = new Set();       // messageId(str) — threshold reached this session
let _listenedMs = 0;
let _lastTickPos = null;
let _token = 0;
let _engine = null;                   // { kind, pause, resume, seek, setRate, stop }
let _activeConvId = null;

function _emit() {
  for (const fn of Array.from(_listeners)) { try { fn(); } catch {} }
}
function _set(patch) {
  let changed = false;
  for (const k of Object.keys(patch)) {
    if (_state[k] !== patch[k]) { changed = true; break; }
  }
  if (!changed) return;
  _state = { ..._state, ...patch };
  _emit();
}
function _emitPosition(extra) {
  const it = _state.item;
  if (!it) return;
  const set = _posListeners.get(String(it.messageId));
  if (!set || set.size === 0) return;
  const payload = {
    messageId: it.messageId,
    positionMs: _positionMs,
    durationMs: _durationMs || it.durationMs || 0,
    playing: _state.playing,
    rate: _state.rate,
    ...(extra || {}),
  };
  for (const fn of Array.from(set)) { try { fn(payload); } catch {} }
}
function _emitPositionFor(messageId, payload) {
  const set = _posListeners.get(String(messageId));
  if (!set) return;
  for (const fn of Array.from(set)) { try { fn(payload); } catch {} }
}

export function getVoiceState() { return _state; }
export function getVoicePosition() { return { positionMs: _positionMs, durationMs: _durationMs }; }
export function subscribeVoice(fn) {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}
export function subscribeVoicePosition(messageId, fn) {
  if (messageId == null) return () => {};
  const key = String(messageId);
  let set = _posListeners.get(key);
  if (!set) { set = new Set(); _posListeners.set(key, set); }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) _posListeners.delete(key);
  };
}

// Bubble presence — the mini bar only shows when the playing note has no
// bubble mounted (left the chat / scrolled far away in a virtualised list).
export function mountVoiceSurface(messageId) {
  if (messageId == null) return () => {};
  const key = String(messageId);
  _surfaces.set(key, (_surfaces.get(key) || 0) + 1);
  if (_state.item && String(_state.item.messageId) === key) _emit();
  return () => {
    const n = (_surfaces.get(key) || 1) - 1;
    if (n <= 0) _surfaces.delete(key); else _surfaces.set(key, n);
    if (_state.item && String(_state.item.messageId) === key) _emit();
  };
}
export function hasVoiceSurface(messageId) {
  return messageId != null && (_surfaces.get(String(messageId)) || 0) > 0;
}

// Chat screen registers { title, resolveNext(messageId) → nextItem|null }.
// Release marks it detached (kept while its chain is still playing).
export function registerVoiceConversation(conversationId, ctx) {
  if (conversationId == null) return () => {};
  const key = String(conversationId);
  _convCtx.set(key, { ...(ctx || {}), detached: false });
  _activeConvId = key;
  return () => {
    const cur = _convCtx.get(key);
    if (!cur) return;
    if (_state.item && String(_state.item.conversationId) === key) cur.detached = true;
    else _convCtx.delete(key);
    if (_activeConvId === key) _activeConvId = null;
  };
}
export function updateVoiceConversationTitle(conversationId, title) {
  const cur = _convCtx.get(String(conversationId));
  if (cur) cur.title = title;
}
function _gcDetached() {
  const activeConv = _state.item ? String(_state.item.conversationId) : null;
  for (const [k, v] of _convCtx.entries()) {
    if (v.detached && k !== activeConv) _convCtx.delete(k);
  }
}
export function getVoiceConversationTitle(conversationId) {
  return _convCtx.get(String(conversationId))?.title || '';
}

// ── Engines ────────────────────────────────────────────────────────────
let _native;            // undefined = not probed yet
let _nativeSubs = null;
function _getNative() {
  if (_native !== undefined) return _native;
  _native = null;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    // requireOptionalNativeModule returns null instead of throwing on binaries
    // without the module — never requireNativeModule here (Metro fatal).
    const expo = require('expo');
    const m = typeof expo.requireOptionalNativeModule === 'function'
      ? expo.requireOptionalNativeModule('ExpoNativeAudio')
      : null;
    if (m && typeof m.voicePlay === 'function' && typeof m.voiceStop === 'function' && typeof m.addListener === 'function') {
      _native = m;
    }
  } catch { _native = null; }
  return _native;
}
export function isNativeVoiceEngine() { return !!_getNative(); }

function _ensureNativeSubs(m) {
  if (_nativeSubs) return;
  try {
    _nativeSubs = [
      m.addListener('onVoiceStatus', (e) => {
        if (!e || e.token !== _engine?.token || _engine?.kind !== 'native') return;
        _onEngineStatus({
          positionMs: Number(e.positionMs) || 0,
          durationMs: Number(e.durationMs) || 0,
          playing: !!e.playing,
          ended: !!e.ended,
          error: e.error || null,
          seeked: !!e.seeked,
          earpiece: !!e.earpiece,
          reason: e.reason || null,
        });
      }),
      m.addListener('onVoiceProximity', (e) => {
        if (!e || e.token !== _engine?.token) return;
        _set({ earpiece: !!e.earpiece });
      }),
    ];
  } catch { _nativeSubs = null; }
}

function _nativeEngine(m, uri, startMs, rate, token) {
  _ensureNativeSubs(m);
  const eng = {
    kind: 'native', token,
    pause: () => m.voicePause().catch(() => {}),
    resume: () => m.voiceResume().catch(() => {}),
    seek: (ms) => m.voiceSeek(ms).catch(() => {}),
    setRate: (r) => m.voiceSetRate(r).catch(() => {}),
    stop: () => {
      try { m.voiceSetProximityEnabled(false).catch(() => {}); } catch {}
      return m.voiceStop().catch(() => {});
    },
    detach: () => {}, // next voicePlay replaces the player natively
  };
  try { m.voiceSetProximityEnabled(true).catch(() => {}); } catch {}
  m.voicePlay(String(uri), Math.max(0, startMs || 0), rate, token).catch((err) => {
    if (_engine === eng) _onEngineStatus({ error: err?.message || 'play_failed', playing: false });
  });
  return eng;
}

async function _expoEngine(uri, startMs, rate, token) {
  let mod;
  try { mod = require('expo-audio'); } catch { return null; }
  try {
    await mod.setAudioModeAsync({
      playsInSilentMode: true,
      allowsRecording: false,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
      interruptionModeAndroid: 'doNotMix',
      shouldDuckAndroid: false,
    });
  } catch {}
  if (token !== _token) return null;
  let player;
  try {
    player = mod.createAudioPlayer(typeof uri === 'string' ? uri : { uri: String(uri) }, { updateInterval: VOICE_TICK_MS, downloadFirst: false });
  } catch { return null; }
  let endedOnce = false;
  let seekedApplied = !(startMs > 0);
  const sub = player.addListener('playbackStatusUpdate', (s) => {
    if (!s || _engine?.player !== player) return;
    if (s.error) { _onEngineStatus({ error: String(s.error), playing: false }); return; }
    const dur = Number(s.duration) > 0 ? Number(s.duration) * 1000 : 0;
    const cur = Number(s.currentTime) > 0 ? Number(s.currentTime) * 1000 : 0;
    if (!seekedApplied && s.isLoaded && dur > 0) {
      seekedApplied = true;
      try { player.seekTo(startMs / 1000); } catch {}
    }
    const ended = !!s.didJustFinish || (!s.playing && dur > 0 && cur >= dur - 60);
    if (ended) {
      if (endedOnce) return;
      endedOnce = true;
    } else if (s.playing) {
      endedOnce = false;
    }
    _onEngineStatus({ positionMs: cur, durationMs: dur, playing: !!s.playing, ended });
  });
  const restoreMix = () => {
    try {
      mod.setAudioModeAsync?.({ interruptionMode: 'mixWithOthers', interruptionModeAndroid: 'mixWithOthers' }).catch(() => {});
    } catch {}
  };
  const eng = {
    kind: 'expo', token, player,
    pause: () => { try { player.pause(); } catch {} },
    resume: () => {
      try {
        const d = Number(player.duration) || 0;
        if (d > 0 && Number(player.currentTime) >= d - 0.06) player.seekTo(0);
      } catch {}
      endedOnce = false;
      try { player.play(); } catch {}
    },
    seek: (ms) => { try { player.seekTo(ms / 1000); } catch {} },
    setRate: (r) => {
      try {
        if (typeof player.setPlaybackRate === 'function') player.setPlaybackRate(r, 'high');
        else player.playbackRate = r;
      } catch {}
    },
    detach: () => {
      try { sub?.remove?.(); } catch {}
      try { player.pause(); } catch {}
      try { player.remove?.(); } catch {}
    },
    stop: () => { eng.detach(); restoreMix(); },
  };
  eng.setRate(rate);
  try { player.play(); } catch { eng.detach(); return null; }
  return eng;
}

function _webEngine(uri, startMs, rate, token, item) {
  if (typeof window === 'undefined' || !window.Audio) return null;
  let retried = false;
  let timer = null;
  const audio = new window.Audio(uri);
  audio.preload = 'auto';
  const tick = () => {
    if (_engine?.audio !== audio) return;
    _onEngineStatus({
      positionMs: (audio.currentTime || 0) * 1000,
      durationMs: isFinite(audio.duration) ? audio.duration * 1000 : 0,
      playing: !audio.paused && !audio.ended,
    });
  };
  const startTimer = () => { if (!timer) timer = setInterval(tick, VOICE_TICK_MS); };
  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };
  audio.onplay = () => { startTimer(); tick(); };
  audio.onpause = () => { stopTimer(); tick(); };
  audio.onended = () => {
    stopTimer();
    if (_engine?.audio !== audio) return;
    _onEngineStatus({
      positionMs: isFinite(audio.duration) ? audio.duration * 1000 : _positionMs,
      durationMs: isFinite(audio.duration) ? audio.duration * 1000 : 0,
      playing: false, ended: true,
    });
  };
  audio.onerror = () => {
    stopTimer();
    if (_engine?.audio !== audio) return;
    // Self-heal: a revoked blob: (concurrent re-cache) → retry once with the
    // direct remote URL, which the browser streams natively.
    const wasBlob = typeof audio.src === 'string' && audio.src.startsWith('blob:');
    if (wasBlob && !retried && item?.url && /^https?:/.test(item.url)) {
      retried = true;
      try { require('./audioCache').invalidateWebAudio?.(item.url); } catch {}
      audio.src = item.url;
      audio.playbackRate = _state.rate;
      audio.play().catch(() => {});
      return;
    }
    _onEngineStatus({ error: 'web_audio_error', playing: false });
  };
  const eng = {
    kind: 'web', token, audio,
    pause: () => { try { audio.pause(); } catch {} },
    resume: () => {
      try { if (audio.ended) audio.currentTime = 0; } catch {}
      audio.play().catch(() => {});
    },
    seek: (ms) => { try { audio.currentTime = ms / 1000; } catch {} tick(); },
    setRate: (r) => { try { audio.playbackRate = r; } catch {} },
    detach: () => { stopTimer(); try { audio.pause(); } catch {} try { audio.removeAttribute('src'); audio.load?.(); } catch {} },
    stop: () => eng.detach(),
  };
  try { if (startMs > 0) audio.currentTime = startMs / 1000; } catch {}
  audio.playbackRate = rate;
  audio.play().catch((err) => {
    if (_engine === eng) _onEngineStatus({ error: err?.name === 'NotAllowedError' ? 'autoplay_blocked' : 'web_play_failed', playing: false });
  });
  return eng;
}

// ── Status pipeline ────────────────────────────────────────────────────
function _onEngineStatus(st) {
  const it = _state.item;
  if (!it) return;
  if (st.error) {
    _set({ playing: false, loading: false, error: st.error });
    _emitPosition({ error: st.error });
    return;
  }
  const prevPos = _positionMs;
  if (typeof st.positionMs === 'number' && isFinite(st.positionMs)) _positionMs = st.positionMs;
  if (st.durationMs > 0) _durationMs = st.durationMs;
  // Listened-time accounting (seeks don't count as listening).
  if (st.playing && !st.seeked && _lastTickPos != null) {
    const d = _positionMs - prevPos;
    if (d > 0 && d < 1500) _listenedMs += d;
  }
  _lastTickPos = _positionMs;
  _maybeReceipt(false);

  const patch = { loading: false };
  if (typeof st.playing === 'boolean') patch.playing = st.ended ? false : st.playing;
  if (typeof st.earpiece === 'boolean') patch.earpiece = st.earpiece;
  _set(patch);
  _emitPosition({ seeked: !!st.seeked, reason: st.reason || null, ended: !!st.ended });
  if (st.ended) _onEnded();
}

function _receiptThreshold() {
  const dur = _durationMs || _state.item?.durationMs || 0;
  return dur > 0 ? Math.min(2000, dur * 0.4) : 2000;
}

function _maybeReceipt(ended) {
  const it = _state.item;
  if (!it || it.messageId == null) return;
  const key = String(it.messageId);
  if (_receiptDone.has(key)) return;
  if (!ended && _listenedMs < _receiptThreshold()) return;
  _receiptDone.add(key);
  markLocallyPlayed(it.messageId);
  _emitPosition({ playedThreshold: true });
  // Server "played" (blue mic for the sender) — received notes only, and only
  // real server ids (voicemail bubbles use "vm_*" ids → separate API).
  if (it.isOwn) return;
  if (!/^\d+$/.test(key)) return;
  try {
    const api = require('./api');
    api.chatVoicePlayed?.(Number(key), it.conversationId || undefined)?.catch?.(() => {});
  } catch {}
}

function _onEnded() {
  const it = _state.item;
  if (!it) return;
  _maybeReceipt(true);
  try { require('./voicePlaybackBus').emitAudioFinished(it.messageId); } catch {}
  let next = null;
  try {
    const ctx = _convCtx.get(String(it.conversationId));
    if (ctx && typeof ctx.resolveNext === 'function') next = ctx.resolveNext(it.messageId) || null;
  } catch { next = null; }
  // Rewind the finished bubble.
  _emitPositionFor(it.messageId, {
    messageId: it.messageId, positionMs: 0, durationMs: _durationMs || it.durationMs || 0,
    playing: false, rate: _state.rate, seeked: true, ended: true,
  });
  if (next && next.messageId != null && (next.url || next.uri)) {
    const conv = next.conversationId != null ? next.conversationId : it.conversationId;
    playVoiceNote({ ...next, conversationId: conv }, { autoAdvanced: true }).catch(() => {});
    return;
  }
  stopVoiceNote();
}

// ── URI resolution (used for auto-advance + mini bar resume) ───────────
function _isLocal(u) {
  return typeof u === 'string' && (u.startsWith('file://') || u.startsWith('content://') || u.startsWith('blob:') || u.startsWith('data:') || u.startsWith('/'));
}
async function _resolveUri(item) {
  if (item.uri) return item.uri;
  const url = item.url;
  if (!url) return null;
  if (_isLocal(url)) return url;
  try {
    const { getCachedAudioUri } = require('./audioCache');
    const local = await getCachedAudioUri(url, item.messageId);
    if (local) return local;
  } catch {}
  return url;
}

// ── Single-audio integration with services/audioManager ────────────────
let _amRegistered = false;
const _externalStop = () => { pauseVoiceNote(); };
function _registerWithAudioManager() {
  if (_amRegistered) return;
  _amRegistered = true;
  try { require('./audioManager').registerAudioPlayer(_externalStop); } catch {}
}

// ── Public controls ────────────────────────────────────────────────────
export async function playVoiceNote(item, opts = {}) {
  if (!item || item.messageId == null) return;
  _registerWithAudioManager();
  try { require('./audioManager').stopOtherAudio(_externalStop); } catch {}
  const token = ++_token;
  const prev = _engine;
  // Replace the previous engine (native voicePlay replaces in place; expo/web
  // players must be released). Keep the native session so a chained note at
  // the ear stays on the earpiece.
  if (prev) {
    if (prev.kind !== 'native') { try { prev.stop(); } catch {} }
    // Native: silence it now (URI resolution may take a while) — but not on
    // auto-advance, where it already ended and pausing would drop the
    // earpiece route the next note should inherit.
    else if (_state.playing && !opts.autoAdvanced) { try { prev.pause(); } catch {} }
  }
  _engine = null;
  const key = String(item.messageId);
  // Switching notes: remember where the previous one was paused so tapping it
  // again resumes there (its bubble keeps showing that position).
  const prevItem = _state.item;
  if (prevItem && String(prevItem.messageId) !== key && _positionMs > 0) {
    const pd = _durationMs || prevItem.durationMs || 0;
    if (!(pd > 0 && _positionMs >= pd - 300)) _pendingStart.set(String(prevItem.messageId), _positionMs);
  }
  const startMs = opts.startMs != null ? opts.startMs : (_pendingStart.get(key) || 0);
  _pendingStart.delete(key);
  _positionMs = startMs;
  _durationMs = item.durationMs || 0;
  _listenedMs = 0;
  _lastTickPos = startMs;
  _set({ item: { ...item }, playing: true, loading: true, error: null });
  if (!opts.autoAdvanced) _gcDetached();
  _emitPosition({ seeked: true });

  const uri = await _resolveUri(item);
  if (token !== _token) return;
  if (!uri) {
    _set({ playing: false, loading: false, error: 'no_uri' });
    _emitPosition({ error: 'no_uri' });
    return;
  }
  const rate = _state.rate;
  let eng = null;
  try {
    if (Platform.OS === 'web') {
      eng = _webEngine(uri, startMs, rate, token, item);
    } else {
      const m = _getNative();
      if (m) eng = _nativeEngine(m, uri, startMs, rate, token);
      else {
        if (prev && prev.kind === 'native') { try { prev.stop(); } catch {} }
        eng = await _expoEngine(uri, startMs, rate, token);
      }
    }
  } catch { eng = null; }
  if (token !== _token) { try { eng?.stop?.(); } catch {} return; }
  if (!eng) {
    _set({ playing: false, loading: false, error: 'engine_unavailable' });
    _emitPosition({ error: 'engine_unavailable' });
    return;
  }
  _engine = eng;
}

export function pauseVoiceNote() {
  if (!_engine || !_state.playing) {
    if (_state.loading) { _token++; _set({ playing: false, loading: false }); }
    return;
  }
  try { _engine.pause(); } catch {}
  _set({ playing: false });
  _emitPosition({});
}

export function resumeVoiceNote() {
  const it = _state.item;
  if (!it) return;
  if (!_engine) { playVoiceNote(it, { startMs: _positionMs }).catch(() => {}); return; }
  _registerWithAudioManager();
  try { require('./audioManager').stopOtherAudio(_externalStop); } catch {}
  try { _engine.resume(); } catch {}
  _lastTickPos = _positionMs;
  _set({ playing: true });
  _emitPosition({});
}

export function stopVoiceNote() {
  _token++;
  const eng = _engine;
  _engine = null;
  const it = _state.item;
  if (eng) { try { eng.stop(); } catch {} }
  else if (Platform.OS !== 'web') {
    // Belt: a native player may still hold proximity/session.
    const m = _native;
    if (m) { try { m.voiceSetProximityEnabled(false).catch(() => {}); m.voiceStop().catch(() => {}); } catch {} }
  }
  _positionMs = 0;
  _durationMs = 0;
  _listenedMs = 0;
  _lastTickPos = null;
  _set({ item: null, playing: false, loading: false, earpiece: false, error: null });
  if (it) {
    _emitPositionFor(it.messageId, {
      messageId: it.messageId, positionMs: 0, durationMs: it.durationMs || 0,
      playing: false, rate: _state.rate, seeked: true, stopped: true,
    });
  }
  _gcDetached();
}

// Tap on a bubble: play / pause / resume.
export function toggleVoiceNote(item) {
  const cur = _state.item;
  if (cur && item && String(cur.messageId) === String(item.messageId)) {
    if (_state.playing) pauseVoiceNote();
    else resumeVoiceNote();
    return;
  }
  playVoiceNote(item).catch(() => {});
}

// Scrub. Active note → real seek; idle note → remembered start position.
export function seekVoiceNote(messageId, ms) {
  const target = Math.max(0, Math.round(ms || 0));
  const it = _state.item;
  if (it && String(it.messageId) === String(messageId)) {
    _positionMs = target;
    _lastTickPos = target;
    if (_engine) { try { _engine.seek(target); } catch {} }
    _emitPosition({ seeked: true });
    return;
  }
  _pendingStart.set(String(messageId), target);
}
export function getPendingStartMs(messageId) {
  return _pendingStart.get(String(messageId)) || 0;
}

export function setVoiceRate(rate) {
  const r = RATE_ALLOWED.includes(rate) ? rate : 1;
  _setStr(RATE_KEY, String(r));
  if (_engine) { try { _engine.setRate(r); } catch {} }
  _set({ rate: r });
  _emitPosition({});
}
export function cycleVoiceRate() {
  const idx = VOICE_RATE_STEPS.indexOf(_state.rate);
  const next = VOICE_RATE_STEPS[(idx + 1) % VOICE_RATE_STEPS.length] ?? 1;
  setVoiceRate(next);
  return next;
}

// ── React hooks ────────────────────────────────────────────────────────
// Per-bubble coarse snapshot as a primitive string → bubbles that are not
// the active one never re-render when another note plays/ticks.
export function useVoiceBubbleState(messageId) {
  const key = messageId == null ? '' : String(messageId);
  const snap = useSyncExternalStore(
    subscribeVoice,
    () => {
      const s = _state;
      const active = !!(s.item && String(s.item.messageId) === key);
      return `${active ? 1 : 0}${active && s.playing ? 1 : 0}${active && s.loading ? 1 : 0}${active && s.earpiece ? 1 : 0}|${s.rate}`;
    },
    () => `0000|1`,
  );
  return useMemo(() => ({
    active: snap[0] === '1',
    playing: snap[1] === '1',
    loading: snap[2] === '1',
    earpiece: snap[3] === '1',
    rate: Number(snap.slice(5)) || 1,
  }), [snap]);
}

// Mini bar: full coarse state + whether the active note has a visible bubble.
export function useVoiceMiniState() {
  const snapKey = useSyncExternalStore(
    subscribeVoice,
    () => {
      const s = _state;
      if (!s.item) return '';
      const surfaced = hasVoiceSurface(s.item.messageId) ? 1 : 0;
      return `${s.item.messageId}|${s.playing ? 1 : 0}|${s.loading ? 1 : 0}|${s.rate}|${s.earpiece ? 1 : 0}|${surfaced}`;
    },
    () => '',
  );
  return useMemo(() => {
    if (!snapKey) return null;
    const parts = snapKey.split('|');
    return {
      item: _state.item,
      playing: parts[1] === '1',
      loading: parts[2] === '1',
      rate: Number(parts[3]) || 1,
      earpiece: parts[4] === '1',
      surfaced: parts[5] === '1',
    };
  }, [snapKey]);
}

export function getActiveVoiceConversationId() { return _activeConvId; }
