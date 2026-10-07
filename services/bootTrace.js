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

const _marks = {};
export function mark(name) {
  try { if (name && _marks[name] === undefined) _marks[name] = _now() - T0; } catch {}
}
export function getBootMarks() { return { ..._marks }; }

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
try {
  if (Platform.OS !== 'web') setTimeout(() => hideNativeSplash('absolute_cap'), ABSOLUTE_SPLASH_CAP_MS);
} catch {}

let _fallbackTimer = null;
// Armed by the boot gate once the React tree is allowed to render. If no owner
// hid the splash within `ms`, hide it anyway (same behaviour as before this
// change — never worse than today).
export function armSplashFallback(ms = 1500) {
  if (_splashHidden || _fallbackTimer) return;
  try { _fallbackTimer = setTimeout(() => { _fallbackTimer = null; hideNativeSplash('fallback'); }, ms); } catch {}
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
try {
  if (Platform.OS !== 'web') setTimeout(() => markFirstPaintOther('cap'), AFTER_PAINT_CAP_MS);
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
// of the staggering. Web: runs immediately-ish (no native splash / no queue).
export function afterFirstPaint(fn, delay = 0) {
  if (typeof fn !== 'function') return;
  if (Platform.OS === 'web') { try { setTimeout(fn, delay || 0); } catch {} return; }
  if (_firstPaint) {
    try { setTimeout(() => { try { fn(); } catch {} }, delay || 0); } catch {}
    return;
  }
  _afterPaintQueue.push({ fn, delay, gap: 24 });
}

// ─── Telemetry (sampled) ─────────────────────────────────────────────────────
// One beacon per launch for ~5% of launches, or always when the list took >1.5s
// to paint, so we can see real-device numbers in push_diag without load spikes.
let _reported = false;
export function reportBootMarksSampled() {
  if (_reported || Platform.OS === 'web') return;
  _reported = true;
  try {
    setTimeout(() => {
      try {
        const m = getBootMarks();
        const slow = (m.first_list_paint || 0) > 1500 || (m.splash_hide || 0) > 1500;
        if (!slow && Math.random() > 0.05) return;
        require('./crashReporter').reportStep?.('coldstart_marks', JSON.stringify(m).slice(0, 460));
      } catch {}
    }, 8000);
  } catch {}
}
