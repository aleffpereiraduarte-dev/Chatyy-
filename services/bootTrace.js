// [2026-10-07 coldstart] Boot trace + native-splash ownership + "after first
// paint" scheduler.
//
// WhatsApp/Telegram model: the native splash stays up until the chat list has
// painted its first rows FROM LOCAL DATA, then everything non-critical (sync
// engines, outbox, backup, LiveKit globals, disk scans…) runs after that frame,
// staggered so no single JS task blocks the first interactions.
//
// Owners of the splash hide (first one wins, idempotent):
//   1. ChatListTab — FlashList onLoad (rows drawn) or skeleton layout (no cache)
//   2. app/index.js — any route that is NOT the chat list (login, inbox, verify)
//      and the branded AnimatedSplash (logged-out / slow-auth path)
//   3. Safety nets — armSplashFallback() from the boot gate + an absolute cap
//      from module load, so the splash can NEVER hang (crash, other tab, etc.)
//
// Pure JS, no new native deps → ships via OTA. Every call is try/catch'd: this
// module must never be the reason the app fails to boot.
import { Platform, InteractionManager } from 'react-native';

const _now = () => Date.now();
// T0 = earliest JS timestamp we have (set by app/_layout.js at module top).
const T0 = (() => {
  try {
    const g = typeof globalThis !== 'undefined' ? globalThis : {};
    if (typeof g.__chatyyBootT0 === 'number') return g.__chatyyBootT0;
    g.__chatyyBootT0 = _now();
    return g.__chatyyBootT0;
  } catch { return _now(); }
})();

// [2026-10-16 wave10-C boot] performance.now() no MESMO instante do T0: as
// marcas nativas do RN (performance.rnStartupTiming: início do host, runtime,
// execução do bundle) vêm nessa base de tempo, então "T0 - início do RN" sai
// sem depender de relógio de parede. undefined quando a API não existe.
const T0_PERF = (() => {
  try {
    const p = typeof performance !== 'undefined' ? performance : null;
    return p && typeof p.now === 'function' ? p.now() : undefined;
  } catch { return undefined; }
})();
export function getBootT0() { return T0; }

const _marks = {};
export function mark(name) {
  try { if (name && _marks[name] === undefined) _marks[name] = _now() - T0; } catch {}
}
export function getBootMarks() { return { ..._marks }; }
// [2026-10-09 boot-native] Exposed for QA (Playwright reads it on web) and for
// on-device debugging; read-only snapshot semantics are the caller's job.
try { if (typeof globalThis !== 'undefined') globalThis.__chatyyBootMarks = _marks; } catch {}

// [2026-10-09 boot-native] Non-timing facts that make the beacon readable:
// `bg` = the JS started with the app NOT in the foreground (cold start by a
// push / background fetch) → the splash can't hide until the user opens it,
// which produced the 26 s / 48 s "fallback" outliers; `hyd` = AsyncStorage
// hydration stats (ms, keys) so the cache cost is measured, not inferred.
const _meta = {};
export function setBootMeta(key, value) {
  try { if (key && _meta[key] === undefined) _meta[key] = value; } catch {}
}
// [2026-10-16 wave10-C boot] 1º vs 2º plano HONESTO. Só 'background' é 2º
// plano: num cold start em 1º plano o iOS ainda está 'inactive' (vira 'unknown'
// em binários antigos) até o didBecomeActive — isso é 1º plano e antes caía no
// mesmo balde `bg` dos boots acordados por push/VoIP/BG fetch.
//   _m.fg  = 1 (1º plano) | 0 (2º plano)
//   _m.as  = estado inicial cru abreviado (a/b/i/u)
//   _m.bg  = mantido p/ compat das consultas antigas (estado ≠ active)
let _initialAppState = 'active';
try {
  if (Platform.OS !== 'web') {
    const { AppState } = require('react-native');
    const st = AppState && AppState.currentState;
    _initialAppState = st ? String(st) : 'unknown';
    if (st && st !== 'active') setBootMeta('bg', String(st));
  }
} catch {}
const _startedInBackground = Platform.OS !== 'web' && _initialAppState === 'background';
setBootMeta('fg', _startedInBackground ? 0 : 1);
setBootMeta('as', _initialAppState.charAt(0) || 'u');
export function getInitialAppState() { return _initialAppState; }
export function startedInBackground() { return _startedInBackground; }

// ─── Boot em 2º plano "leve" (bg-lite) ──────────────────────────────────────
// [2026-10-16 wave10-C boot] Processo acordado em 2º plano (push, VoIP/PushKit,
// BG fetch, task headless do Android) NÃO monta a árvore React (app/_layout.js
// segura a UI até o 1º 'active' — services/bgLiteBoot.js liga só push/VoIP/
// tarefas). Enquanto segura: os tetos do splash e a fila afterFirstPaint ficam
// suspensos (esconder o splash em 2º plano = tela vazia ao abrir; rodar a fila
// = engines/sync/LiveKit sem tela). releaseBootHold() rearma tudo a partir do
// 'active'. Kill switch (OTA): globalThis.__chatyy_bg_lite_boot = false.
const BG_LITE_DEFAULT_ON = false; // [2026-10-16] opt-in até testar em aparelho (CallKit/push em 2º plano)
function _bgLiteEnabled() {
  try {
    const o = globalThis.__chatyy_bg_lite_boot;
    if (o === false) return false;
    if (o === true) return true;
  } catch {}
  return BG_LITE_DEFAULT_ON;
}
let _bootHold = _startedInBackground && _bgLiteEnabled();
const _bgLiteBoot = _bootHold;
if (_bgLiteBoot) { setBootMeta('lite', 1); }
export function isBgLiteBoot() { return _bgLiteBoot; }
export function isBootHeld() { return _bootHold; }
const _releaseCbs = [];
let _activeAt = 0;
// Chamado por services/bgLiteBoot quando o app fica 'active' pela 1ª vez.
export function releaseBootHold(reason) {
  if (!_bootHold) return;
  _bootHold = false;
  _activeAt = _now();
  mark('fg_active');
  if (reason) mark('fg_active:' + String(reason));
  const cbs = _releaseCbs.splice(0, _releaseCbs.length);
  for (const fn of cbs) { try { fn(); } catch {} }
}
function _onRelease(fn) { if (_bootHold) _releaseCbs.push(fn); else { try { fn(); } catch {} } }

// ─── Native splash ──────────────────────────────────────────────────────────
let _splashHidden = false;
export function isSplashHidden() { return _splashHidden; }
export function hideNativeSplash(reason) {
  if (_splashHidden) return;
  _splashHidden = true;
  mark('splash_hide');
  mark('splash_hide:' + String(reason || 'unknown'));
  if (Platform.OS === 'web') return;
  try {
    const SplashScreen = require('expo-splash-screen');
    SplashScreen.hideAsync?.().catch?.(() => {});
  } catch {}
}

// Absolute cap from JS start — covers a crash before any owner mounts.
const ABSOLUTE_SPLASH_CAP_MS = 4000;
// [2026-10-16 wave10-C boot] Em bg-lite o teto conta a partir do 'active'.
function _armAbsoluteCap() {
  try { setTimeout(() => hideNativeSplash('absolute_cap'), ABSOLUTE_SPLASH_CAP_MS); } catch {}
}
try {
  if (Platform.OS !== 'web') _onRelease(_armAbsoluteCap);
} catch {}

let _fallbackTimer = null;
// Armed by the boot gate once the React tree is allowed to render. If no owner
// hid the splash within `ms`, hide it anyway (same behaviour as before this
// change — never worse than today).
export function armSplashFallback(ms = 1500) {
  if (_splashHidden || _fallbackTimer) return;
  // [2026-10-16 wave10-C boot] segurado (2º plano): arma no 'active'.
  if (_bootHold) { _onRelease(() => armSplashFallback(ms)); return; }
  try { _fallbackTimer = setTimeout(() => { _fallbackTimer = null; hideNativeSplash('fallback'); }, ms); } catch {}
}

// [2026-10-09 boot-native] The chat list has local rows and is rendering them:
// give it up to `ms` more to draw (its onLayout/onLoad hide the splash) instead
// of letting the generic fallback cut to a half-mounted screen. Only ever
// pushes the fallback once; ABSOLUTE_SPLASH_CAP_MS still bounds everything.
let _fallbackDeferred = false;
export function deferSplashFallback(ms = 1200) {
  if (_splashHidden || _fallbackDeferred || Platform.OS === 'web') return;
  _fallbackDeferred = true;
  mark('splash_fallback_deferred');
  try { if (_fallbackTimer) clearTimeout(_fallbackTimer); } catch {}
  _fallbackTimer = null;
  try { _fallbackTimer = setTimeout(() => { _fallbackTimer = null; hideNativeSplash('fallback_list'); }, ms); } catch {}
}

// ─── First paint ────────────────────────────────────────────────────────────
let _firstPaint = false;
const _afterPaintQueue = [];
export function hasFirstPaint() { return _firstPaint; }

// Called by the chat list when its first rows (or the no-cache skeleton) are on
// screen. Hides the splash and releases the after-first-paint queue.
export function markFirstListPaint(source) {
  if (_firstPaint) return;
  _firstPaint = true;
  mark('first_list_paint');
  if (source) mark('first_list_paint:' + source);
  hideNativeSplash('list:' + (source || 'rows'));
  _drainAfterPaint();
}

// Releases the queue without a list paint (e.g. route went to /login, /inbox).
export function markFirstPaintOther(reason) {
  if (_firstPaint) return;
  _firstPaint = true;
  mark('first_paint_other:' + String(reason || ''));
  _drainAfterPaint();
}

// Hard cap so deferred work can't be starved if no first-paint signal ever
// arrives (crash in the list, a non-chat deep link, etc.).
const AFTER_PAINT_CAP_MS = 2500;
// [2026-10-11 boot-web] Web now queues too (see afterFirstPaint). The cap is a
// bit longer there because module eval of the web bundle already ate the
// download/parse time and the chat list mounts only after the route chunk.
const AFTER_PAINT_CAP_WEB_MS = 3000;
// [2026-10-16 wave10-C boot] Em bg-lite o teto conta a partir do 'active'.
try {
  _onRelease(() => {
    try { setTimeout(() => markFirstPaintOther('cap'), Platform.OS === 'web' ? AFTER_PAINT_CAP_WEB_MS : AFTER_PAINT_CAP_MS); } catch {}
  });
} catch {}

function _drainAfterPaint() {
  const items = _afterPaintQueue.splice(0, _afterPaintQueue.length);
  // Let the paint frame commit first, then wait for interactions (the list's
  // own mount effects) to settle; stagger each task into its own macrotask so
  // a burst of service inits never becomes one long JS block.
  const run = () => {
    let delay = 0;
    for (const it of items) {
      delay += it.gap;
      const d = Math.max(0, delay + (it.delay || 0));
      try { setTimeout(() => { try { it.fn(); } catch {} }, d); } catch {}
    }
  };
  // runAfterInteractions can be starved indefinitely by a looping Animated
  // (isInteraction defaults to true — e.g. the skeleton shimmer), so race it
  // with a short timeout: the deferred work is delayed, never lost.
  let ran = false;
  const go = () => { if (ran) return; ran = true; run(); };
  try {
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
    raf(() => {
      try { InteractionManager.runAfterInteractions(go); } catch { setTimeout(go, 0); }
      try { setTimeout(go, 400); } catch {}
    });
  } catch { try { setTimeout(go, 0); } catch {} }
  // rAF may not tick while the app is backgrounded (cold start by a push) —
  // never let the queue depend on it alone.
  try { setTimeout(go, 700); } catch {}
}

// Schedule `fn` after the first paint. `delay` adds an extra wait (ms) on top
// of the staggering.
// [2026-10-11 boot-web] Web used to run these immediately (setTimeout(fn,
// delay)), so ~15 service inits + their lazy chunks (outboxDrainer, sendWorker,
// relayResponder, onlineRecovery, shareOutbox…) and their API calls competed
// with the chat list's first render on a 4x-throttled phone. Web now uses the
// same queue as native: released by the list's first paint (ChatListTab),
// app/index.js (other destinations) or the 3 s cap above — delayed, never lost.
export function afterFirstPaint(fn, delay = 0) {
  if (typeof fn !== 'function') return;
  if (_firstPaint) {
    try { setTimeout(() => { try { fn(); } catch {} }, delay || 0); } catch {}
    return;
  }
  _afterPaintQueue.push({ fn, delay, gap: 24 });
}

// ─── Telemetry (sampled) ─────────────────────────────────────────────────────
// [2026-10-16 wave10-C boot] Amostragem SEM viés: 10% uniforme, decidida no
// load do módulo (antes: sempre que >1,5 s + 5% do resto → p50/p90 inflados).
// `_m.sr` = taxa (%) p/ o servidor ponderar. QA: globalThis.__chatyy_boot_trace_all = true.
// Época do processo: `_m.ps` = ms do início do PROCESSO (nativo processStartTime:
// iOS sysctl p_starttime / Android Process.getStart*UptimeMillis) até o T0 do JS
// → splash real = ps + marks.splash_hide. `_m.rn` = [início do host RN,
// início do runtime, início da execução do bundle] → T0 (performance.rnStartupTiming),
// fallback quando o binário ainda não tem o nativo. Lido só na hora do envio (8 s).
const BOOT_SAMPLE_PCT = 10;
const _sampled = (() => {
  try { if (globalThis.__chatyy_boot_trace_all === true) return true; } catch {}
  try { return Math.random() * 100 < BOOT_SAMPLE_PCT; } catch { return false; }
})();
export function isBootSampled() { return _sampled; }

export function getProcessStartEpochMs() {
  if (Platform.OS === 'web') return 0;
  try {
    const core = require('expo-modules-core');
    const get = core.requireOptionalNativeModule || ((n) => { try { return core.requireNativeModule(n); } catch { return null; } });
    for (const name of ['ExpoChatyySystem', 'ExpoNativeToolkit']) {
      let m = null;
      try { m = get(name); } catch {}
      if (m && typeof m.processStartTime === 'function') {
        const v = Number(m.processStartTime());
        if (Number.isFinite(v) && v > 0) return v;
      }
    }
  } catch {}
  return 0;
}

function _collectProcessMeta() {
  try {
    const ps = getProcessStartEpochMs();
    const d = ps ? Math.round(T0 - ps) : -1;
    // Processo vivo há horas (iOS reaproveitado / pré-aquecido) não é "boot":
    // registra mesmo assim, mas o servidor separa por faixa.
    if (d >= 0 && d < 24 * 3600 * 1000) setBootMeta('ps', d);
  } catch {}
  try {
    const p = typeof performance !== 'undefined' ? performance : null;
    const rt = p && p.rnStartupTiming;
    if (rt && typeof T0_PERF === 'number') {
      const f = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(T0_PERF - v) : -1);
      setBootMeta('rn', [f(rt.startTime), f(rt.initializeRuntimeStart), f(rt.executeJavaScriptBundleEntryPointStart)].join('/'));
    }
  } catch {}
  try { if (_activeAt) setBootMeta('act', _activeAt - T0); } catch {}
}

function _sendBeacon(tag) {
  try {
    const m = getBootMarks();
    setBootMeta('sr', BOOT_SAMPLE_PCT);
    _collectProcessMeta();
    try {
      const st = require('./mmkv').getHydrateStats?.();
      if (st) setBootMeta('hyd', [st.bootMs | 0, st.bootKeys | 0, st.lazyKeys | 0].join('/'));
      // [2026-10-10 storage-boot] backend (a=AsyncStorage, s=SQLite KV,
      // m=migrating) + smartChatCache hydrate maxMs/parsed blobs/KB parsed.
      try {
        const sh = require('./smartChatCache').getSmartHydrateStats?.();
        const b = String(st?.backend || 'a');
        setBootMeta('hyd2', [b === 'sqlite' ? 's' : (b.indexOf('migr') >= 0 ? 'm' : 'a'), sh ? sh.maxMs | 0 : -1, sh ? sh.parsed | 0 : -1, sh ? (sh.parsedBytes / 1024) | 0 : -1, st ? st.lazySyncHits | 0 : 0].join('/'));
      } catch {}
    } catch {}
    // Meta first (short) so the 460-char cut only ever trims late marks.
    const meta = { ..._meta };
    if (tag) meta.ph = tag;
    const payload = { _m: meta, ...m };
    require('./crashReporter').reportStep?.('coldstart_marks', JSON.stringify(payload).slice(0, 460));
  } catch {}
}

// Um beacon por boot amostrado, 8 s depois do T0. Boot em 2º plano (bg-lite):
// beacon 'bg' aos 8 s se ainda estiver em 2º plano e, quando o usuário abrir,
// um 2º beacon 'fg' 8 s depois do 'active' (marks da UI; `_m.act` = T0→active).
let _reported = false;
let _reportedBg = false;
export function reportBootMarksSampled() {
  if (_reported || Platform.OS === 'web') return;
  _reported = true;
  if (!_sampled) return;
  const REPORT_AFTER_MS = 8000;
  try {
    if (!_bgLiteBoot) {
      setTimeout(() => _sendBeacon(_startedInBackground ? 'bgfull' : ''), REPORT_AFTER_MS);
      return;
    }
    setTimeout(() => {
      if (_bootHold && !_reportedBg) { _reportedBg = true; _sendBeacon('bg'); }
    }, REPORT_AFTER_MS);
    _onRelease(() => { try { setTimeout(() => _sendBeacon('fg'), REPORT_AFTER_MS); } catch {} });
  } catch {}
}
