// Remote crash reporter — captures JS errors + promise rejections + boot
// breadcrumbs and POSTs them to the backend's `push_diag` endpoint so we can
// see why the app is crashing on a user's device without needing adb logcat
// or a Play Console crash entry.
//
// Why standalone (no api.js import): if the crash happens during early boot
// or inside api.js itself, we still need to be able to report. So this file
// uses raw fetch + hardcoded prod URL.
//
// Trigger: call `installCrashReporter()` ONCE at the very top of _layout.js.
// Call `reportStep(name, info?)` to log breadcrumbs. Call
// `setReporterIdentity(email)` after login so user-bucketed logs land under
// /var/mail/vhosts/{domain}/{user}/push_tokens/push_diag.log
//
// [2026-10-06 crash-debuggability pass] What changed and WHY (7-day forensics
// of /data/push_diag + /data/crashes):
//  - Stack chunks were posted with raw "\n" → the server writes one line per
//    chunk and the frames spilled onto prefix-less lines; grep on `step=`
//    showed `info=)` only. Stacks are now flattened (" <- "), frames are
//    de-noised (the 90-char bundle path becomes `@<hash8>`), and capped at
//    10 frames, so a whole stack is 1-2 posts instead of 4-8.
//  - The fatal path awaited AsyncStorage (anon id) BEFORE fetch; on Android
//    the default handler kills the process right after ours returns, so the
//    POST often never left the device (device qcn77… boot-looped 11× today
//    with only a fraction of the crashes reported). Now: anon id is pre-warmed
//    at install, the fatal record is persisted FIRST (AsyncStorage, flushed on
//    the next boot as `crash_persisted`), and the previous (killing) handler
//    is deferred ~1.2s so the in-flight beacons can drain (same strategy
//    Sentry RN uses: flush, then rethrow to the default handler).
//  - Zero `promise_rejection_*` / `crash_nonfatal_*` ever landed → the
//    Hermes tracker is kept but web now also hooks window `error` /
//    `unhandledrejection`, and rejections are rate-limited per message.
//  - Every crash now carries context: app version, OTA updateId (short),
//    runtimeVersion, platform + OS version, device model, JS heap, uptime,
//    and the last 20 breadcrumbs. Same signature (message + top frame) is
//    sent at most twice per boot so a render loop can't flood the log.
//
// Top-level imports are wrapped in try-blocks defensively. If anything in
// here throws (e.g. native module mis-link, missing peer dep, Hermes
// bytecode mismatch from a partial OTA), the reporter must NEVER crash
// the boot — that would defeat its purpose. So `Platform` is the ONLY
// import we trust at module load; everything else is lazy-required inside
// guarded functions.
let _Platform = null;
try { _Platform = require('react-native').Platform; } catch {}

const ENDPOINT = 'https://chatyy.com.br/api/email.php?action=push_diag';
const ANON_KEY = '@chatyy/crash_anon_id_v1';
const PENDING_KEY = '@chatyy/crash_pending_v1';
const PENDING_MAX = 5;
const BREADCRUMB_MAX = 20;
const SIG_MAX_PER_BOOT = 2;
// How long we hold the default (process-killing) handler on a fatal so the
// beacons can leave the device. Sentry RN uses 2000ms; 1200ms is enough for
// 2-3 small POSTs on a warm connection and keeps the frozen window short.
const FATAL_FLUSH_MS = 1200;

let _anonId = null;
let _bearer = null;
let _platform = (() => {
  try {
    const p = _Platform && _Platform.OS;
    return p === 'ios' ? 'ios' : p === 'android' ? 'android' : 'web';
  } catch { return 'web'; }
})();
let _installed = false;
let _seqBoot = 0;
const _bootAt = Date.now();
const _crumbs = [];                        // ring buffer of {t, s, i}
const _sigCount = Object.create(null);     // signature → sends this boot
let _ctxCache = null;                      // static context, computed once

function _lazyAsyncStorage() {
  try { return require('@react-native-async-storage/async-storage').default; } catch { return null; }
}
function _lazyConstants() {
  try { return require('expo-constants').default; } catch { return null; }
}
function _lazyUpdates() {
  try { return require('expo-updates'); } catch { return null; }
}
function _lazyDevice() {
  try { return require('expo-device'); } catch { return null; }
}

async function _ensureAnonId() {
  if (_anonId) return _anonId;
  try {
    const AS = _lazyAsyncStorage();
    if (AS) {
      const cached = await AS.getItem(ANON_KEY);
      if (cached && cached.length >= 8) { _anonId = cached; return _anonId; }
    }
  } catch {}
  // generate hex-ish 16-char anon id (no PII)
  const r = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  _anonId = r.slice(0, 16);
  try {
    const AS = _lazyAsyncStorage();
    if (AS) await AS.setItem(ANON_KEY, _anonId);
  } catch {}
  return _anonId;
}

function _appVersion() {
  try {
    const Constants = _lazyConstants();
    if (!Constants) return '?';
    const m = Constants.expoConfig || Constants.manifest || {};
    const v = m.version || '?';
    const a = m.android?.versionCode;
    const i = m.ios?.buildNumber;
    return `${v}+${a || i || '?'}`;
  } catch { return '?'; }
}

// ─── Context (static part cached; dynamic part — heap/uptime — per call) ──
function _staticCtx() {
  if (_ctxCache) return _ctxCache;
  const c = { ver: _appVersion(), plat: _platform };
  try {
    const U = _lazyUpdates();
    if (U) {
      // updateId is a UUID; the first 8 chars are enough to match an EAS
      // update in the dashboard and keep the beacon small.
      if (U.updateId) c.ota = String(U.updateId).slice(0, 8);
      if (U.runtimeVersion) c.rt = String(U.runtimeVersion).slice(0, 24);
      if (U.channel) c.ch = String(U.channel).slice(0, 16);
      if (U.isEmbeddedLaunch === true) c.ota = c.ota || 'embedded';
    }
  } catch {}
  try {
    if (_platform === 'web') {
      if (typeof navigator !== 'undefined' && navigator.userAgent) {
        // Keep only the browser token, e.g. "Chrome/152" / "Safari/605".
        const m = /(Chrome|Firefox|Safari|Edg|OPR)\/(\d+)/.exec(navigator.userAgent);
        c.os = m ? `${m[1]}/${m[2]}` : 'web';
      }
    } else {
      const v = _Platform && _Platform.Version;
      if (v !== undefined && v !== null) c.os = String(v).slice(0, 12);
    }
  } catch {}
  try {
    const D = _lazyDevice();
    const model = D && (D.modelName || D.modelId);
    if (model) c.dev = String(model).slice(0, 24);
  } catch {}
  _ctxCache = c;
  return c;
}

function _heapMB() {
  try {
    const HI = typeof global !== 'undefined' ? global.HermesInternal : null;
    const st = HI && typeof HI.getInstrumentedStats === 'function' ? HI.getInstrumentedStats() : null;
    const used = st && (st.js_allocatedBytes || st.js_heapSize);
    if (used) return Math.round(used / 1048576);
    if (typeof performance !== 'undefined' && performance.memory && performance.memory.usedJSHeapSize) {
      return Math.round(performance.memory.usedJSHeapSize / 1048576);
    }
  } catch {}
  return null;
}

// Compact context string for the `info` field (<= ~160 chars).
// [2026-10-06 ws rock-solid] Leitura SÍNCRONA do anon id (sem gerar/persistir):
// o WS manda no auth como device_id só pra forense por aparelho no log do hub.
// Dispara a hidratação em background pra próxima conexão já levar o id.
export function getAnonIdSync() {
  if (!_anonId) { try { _ensureAnonId().catch(() => {}); } catch {} }
  return _anonId || '';
}

export function getCrashContext() {
  const c = _staticCtx();
  const out = { ...c, up: Math.round((Date.now() - _bootAt) / 1000) };
  const heap = _heapMB();
  if (heap !== null) out.heap = heap;
  return out;
}

function _ctxString() {
  try {
    const c = getCrashContext();
    return Object.keys(c).map(k => `${k}=${c[k]}`).join(' ');
  } catch { return ''; }
}

// ─── Breadcrumbs ──────────────────────────────────────────────────────────
export function addBreadcrumb(step, info) {
  try {
    const s = String(step || '').slice(0, 40);
    if (!s) return;
    const i = info === undefined || info === null ? '' : String(info).slice(0, 60);
    _crumbs.push({ t: Date.now(), s, i });
    if (_crumbs.length > BREADCRUMB_MAX) _crumbs.shift();
  } catch {}
}

function _crumbString() {
  try {
    const now = Date.now();
    // "-12s step(info)" newest last; ~25 chars each → ≤ 500 chars for 20.
    return _crumbs.map(c => `-${Math.round((now - c.t) / 1000)}s ${c.s}${c.i ? `(${c.i})` : ''}`).join(' > ');
  } catch { return ''; }
}

// ─── Stack normalisation ──────────────────────────────────────────────────
// Hermes release frames look like:
//   at foo (address at /data/user/0/com.onemundo.mail/files/.expo-internal/2675290a…:1:93676)
// 90+ chars of path per frame carry zero information beyond the bundle hash.
// Collapse to `foo@2675290a:1:93676`, flatten newlines, cap frame count.
export function normalizeStack(stack, maxFrames = 10) {
  try {
    const s = String(stack || '');
    if (!s) return '';
    const lines = s.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const frames = [];
    for (const l of lines) {
      if (frames.length >= maxFrames) break;
      // skip the "Error: message" first line — the message is posted separately
      if (frames.length === 0 && !/^at\s/.test(l) && lines.length > 1) continue;
      let f = l.replace(/^at\s+/, '');
      f = f.replace(/\(?address at [^)]*?([0-9a-f]{8})[0-9a-f]*(?:\.bundle)?(:\d+:\d+)\)?/, '@$1$2');
      f = f.replace(/\(?https?:\/\/[^/]+\/[^)]*?\/([^/)]+?)-[0-9a-f]{8,}\.js(:\d+:\d+)\)?/, '@$1$2');
      f = f.replace(/\(?[^\s()]*\/main\.jsbundle(:\d+:\d+)\)?/, '@main$1');
      f = f.replace(/\(?[^\s()]*index\.android\.bundle(:\d+:\d+)\)?/, '@android$1');
      f = f.replace(/\s+/g, ' ').trim();
      frames.push(f.slice(0, 120));
    }
    return frames.join(' <- ');
  } catch { return String(stack || '').slice(0, 400); }
}

function _signature(msg, stack) {
  try {
    const first = normalizeStack(stack, 1);
    return `${String(msg || '').slice(0, 80)}|${first.slice(0, 60)}`;
  } catch { return String(msg || '').slice(0, 80); }
}

// [2026-06-12 STORM FIX] Global cap: the reporter must never be able to
// flood the API if an error fires in a tight loop (each error = up to 9
// posts with chunked stacks). 30 posts/min per session + identical-step
// dedup within 5s; excess is silently dropped (it's diagnostics).
let _postWindowStart = 0;
let _postWindowCount = 0;
const _postLastByStep = Object.create(null);

function _buildBody(step, info, anon) {
  return JSON.stringify({
    step: String(step || 'unknown').slice(0, 60).replace(/[^a-zA-Z0-9_]/g, '_'),
    platform: _platform,
    info: String(info || '').replace(/[\r\n]+/g, ' ').slice(0, 480),
    ts: new Date().toISOString(),
    anon_id: anon,
  });
}

function _send(body, urgent) {
  const headers = { 'Content-Type': 'application/json' };
  if (_bearer) headers['Authorization'] = `Bearer ${_bearer}`;
  try {
    // Web fatal path: sendBeacon survives page unload/reload (chunk-load
    // failures trigger a reload right after). No custom headers possible, so
    // the beacon lands anonymous — fine, anon_id is in the body.
    if (urgent && _platform === 'web' && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function' && !_bearer) {
      try {
        const blob = typeof Blob !== 'undefined' ? new Blob([body], { type: 'application/json' }) : body;
        if (navigator.sendBeacon(ENDPOINT, blob)) return Promise.resolve();
      } catch {}
    }
    const opts = { method: 'POST', headers, body };
    if (urgent && _platform === 'web') opts.keepalive = true;
    return fetch(ENDPOINT, opts).catch(() => {});
  } catch { return Promise.resolve(); }
}

// Returns a promise that resolves when the POST has been handed to the
// network layer (or dropped). `urgent` bypasses the per-step 5s dedup (a
// crash's ctx + stack share a step name with the previous crash).
async function _post(step, info, urgent = false) {
  try {
    const _now = Date.now();
    if (_now - _postWindowStart > 60 * 1000) { _postWindowStart = _now; _postWindowCount = 0; }
    if (_postWindowCount >= 30) return;
    const _stepKey = String(step || '');
    if (!urgent && _postLastByStep[_stepKey] && _now - _postLastByStep[_stepKey] < 5000) return;
    _postLastByStep[_stepKey] = _now;
    _postWindowCount++;
    // Fatal path must not block on AsyncStorage: use the in-memory id when
    // we have one (pre-warmed at install), fall back to "boot" otherwise so
    // the beacon still goes out and is grouped by the server.
    const anon = _anonId || (urgent ? 'boot-' + _bootAt.toString(36) : await _ensureAnonId());
    await _send(_buildBody(step, info, anon), urgent);
  } catch {}
}

export async function reportStep(step, info) {
  // Caller may also want sync-ish behavior — we still don't await for them.
  addBreadcrumb(step, info);
  _post(step, info);
}

// [#1206 2026-05-19] Defensive beacon for SQLite/persistence write+read
// failures that used to be swallowed by silent catch (e) {}. Surfaces the
// error class + a short context tag through the same `push_diag` channel
// so we can spot data-loss patterns without instrumenting per call site.
//
// Shape: { type, context, message } — type defaults to 'persistence_error'
// so a top-level grep on the diag log can isolate them. Stack is sliced
// to 480 chars by _post (matches its info budget).
//
// ALWAYS safe to call — never throws even if the reporter is mid-boot.
// [2026-10-09 wa-real #14] Build nativo + OTA no beacon de gravação local
// (sqlite_* / persistence_*): 69 dos 75 erros SQLite de 09/10 vinham de 1
// aparelho que provavelmente não tinha o OTA37 — sem build/OTA no evento não
// dava pra provar. Formato: "[b=657 ota=34cd2e6e rt=2.6.0]". O build vem do
// binário (ExpoApplication via requireOptionalNativeModule — não lança se o
// módulo faltar), não do app.json do OTA.
let _buildTagCache = null;
function _buildTag() {
  if (_buildTagCache !== null) return _buildTagCache;
  let b = '';
  try {
    const { requireOptionalNativeModule } = require('expo-modules-core');
    const A = requireOptionalNativeModule ? requireOptionalNativeModule('ExpoApplication') : null;
    if (A && A.nativeBuildVersion) b = String(A.nativeBuildVersion).slice(0, 12);
  } catch {}
  const c = _staticCtx();
  if (!b) {
    try { const v = String(c.ver || ''); const i = v.indexOf('+'); if (i >= 0) b = v.slice(i + 1); } catch {}
  }
  _buildTagCache = `[b=${b || '?'} ota=${c.ota || '?'} rt=${c.rt || '?'}]`;
  return _buildTagCache;
}

export function reportCrash(payload) {
  try {
    const p = payload || {};
    const type = String(p.type || 'persistence_error').slice(0, 40);
    const ctx = String(p.context || 'unknown').slice(0, 40);
    const msg = String(p.message || '').slice(0, 200);
    // Step is alphanumeric+_ only via _post sanitization, so encode the
    // type+ctx as the step and the message as info.
    const step = `${type}_${ctx}`;
    let info = msg;
    try { info = `${_buildTag()} ${info}`; } catch {}
    if (p.stack) info += ` | ${normalizeStack(p.stack, 4).slice(0, 250)}`;
    addBreadcrumb(step, msg.slice(0, 40));
    _post(step, info);
  } catch {}
}

export function setReporterIdentity({ email, bearer } = {}) {
  if (bearer) _bearer = String(bearer);
  if (email) _post('identity', `email=${email}`);
}

function _chunked(prefix, big, urgent = false) {
  const s = String(big || '');
  if (s.length <= 450) { return _post(prefix, s, urgent); }
  const parts = [];
  for (let i = 0; i < s.length && parts.length < 4; i += 450) parts.push(s.slice(i, i + 450));
  return Promise.all(parts.map((p, idx) => _post(`${prefix}_${idx + 1}of${parts.length}`, p, urgent)));
}

// ─── Persisted crash (survives the process being killed mid-POST) ─────────
function _persistCrash(rec) {
  try {
    const AS = _lazyAsyncStorage();
    if (!AS) {
      // web fallback
      if (typeof localStorage !== 'undefined') {
        try {
          const cur = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
          cur.push(rec);
          localStorage.setItem(PENDING_KEY, JSON.stringify(cur.slice(-PENDING_MAX)));
        } catch {}
      }
      return;
    }
    // Read-modify-write is async; a crash right now is still OK — worst case
    // we lose THIS record, never the previous ones.
    AS.getItem(PENDING_KEY).then((raw) => {
      let cur = [];
      try { cur = JSON.parse(raw || '[]'); if (!Array.isArray(cur)) cur = []; } catch { cur = []; }
      cur.push(rec);
      return AS.setItem(PENDING_KEY, JSON.stringify(cur.slice(-PENDING_MAX)));
    }).catch(() => {});
  } catch {}
}

async function _flushPersistedCrashes() {
  try {
    let raw = null;
    const AS = _lazyAsyncStorage();
    if (AS) {
      raw = await AS.getItem(PENDING_KEY);
      if (raw) await AS.setItem(PENDING_KEY, '[]');
    } else if (typeof localStorage !== 'undefined') {
      raw = localStorage.getItem(PENDING_KEY);
      if (raw) localStorage.setItem(PENDING_KEY, '[]');
    }
    if (!raw) return;
    let list = [];
    try { list = JSON.parse(raw); } catch { list = []; }
    if (!Array.isArray(list) || !list.length) return;
    // Dedupe by signature so a boot-loop (same crash 11×) is one line + count.
    const bySig = new Map();
    for (const r of list) {
      if (!r || !r.sig) continue;
      const cur = bySig.get(r.sig);
      if (cur) { cur.n++; cur.last = r.t || cur.last; } else bySig.set(r.sig, { ...r, n: 1, last: r.t });
    }
    for (const r of bySig.values()) {
      const age = r.last ? Math.round((Date.now() - r.last) / 1000) : -1;
      await _post('crash_persisted', `n=${r.n} age=${age}s ${r.ctx || ''} | ${String(r.msg || '').slice(0, 160)} | ${String(r.stack || '').slice(0, 200)}`, true);
    }
  } catch {}
}

// ─── Fatal/non-fatal error path (shared by global handler + boundaries) ──
// Returns a promise that settles when the beacons were handed to fetch.
export function reportError(error, { fatal = false, source = 'global', extra = '' } = {}) {
  try {
    const msg = (error && error.message) ? error.message : String(error || 'unknown');
    const rawStack = (error && error.stack) ? error.stack : '';
    const stack = normalizeStack(rawStack, 10);
    const sig = _signature(msg, rawStack);
    _sigCount[sig] = (_sigCount[sig] || 0) + 1;
    if (_sigCount[sig] > SIG_MAX_PER_BOOT) return Promise.resolve();
    const ctx = _ctxString();
    const seq = ++_seqBoot;
    if (fatal) {
      _persistCrash({ t: Date.now(), sig, msg: msg.slice(0, 200), stack: stack.slice(0, 300), ctx: ctx.slice(0, 200) });
    }
    const kind = fatal ? 'crash_fatal' : 'crash_nonfatal';
    const posts = [
      _post(`${kind}_msg`, `seq=${seq} src=${source} ${msg}`, fatal),
      _post(`${kind}_ctx`, `${ctx}${extra ? ` ${String(extra).slice(0, 120)}` : ''} | crumbs: ${_crumbString()}`, fatal),
      _chunked(`${kind}_stack`, stack, fatal),
    ];
    return Promise.all(posts).catch(() => {});
  } catch { return Promise.resolve(); }
}

export function installCrashReporter() {
  if (_installed) return;
  _installed = true;
  // Pre-warm the anon id so the fatal path never has to await AsyncStorage,
  // then flush anything a previous (killed) process left behind.
  _ensureAnonId().then(() => _flushPersistedCrashes()).catch(() => {});
  addBreadcrumb('boot_start');
  _post('boot_start', `ver=${_appVersion()} plat=${_platform}`);

  // Global JS error handler (RN/Hermes)
  try {
    if (global && global.ErrorUtils && typeof global.ErrorUtils.setGlobalHandler === 'function') {
      const prev = global.ErrorUtils.getGlobalHandler ? global.ErrorUtils.getGlobalHandler() : null;
      global.ErrorUtils.setGlobalHandler((error, isFatal) => {
        let sent = null;
        try { sent = reportError(error, { fatal: !!isFatal, source: 'global' }); } catch {}
        if (typeof prev !== 'function') return;
        if (!isFatal) {
          try { prev(error, isFatal); } catch {}
          return;
        }
        // Fatal: the default RN handler reports to native, which on Android
        // throws a JavascriptException and kills the process — before our
        // POST leaves the device. Hold it briefly so the beacons drain, but
        // never longer than FATAL_FLUSH_MS (watchdog) and never skip it.
        let done = false;
        const fire = () => {
          if (done) return;
          done = true;
          try { prev(error, isFatal); } catch {}
        };
        try {
          const timer = setTimeout(fire, FATAL_FLUSH_MS);
          if (sent && typeof sent.then === 'function') {
            sent.then(() => { clearTimeout(timer); setTimeout(fire, 50); }, () => { clearTimeout(timer); fire(); });
          }
        } catch { fire(); }
      });
    }
  } catch {}

  // Unhandled promise rejection (best effort — RN already wires this in some paths)
  try {
    const HermesInternal = global.HermesInternal;
    if (HermesInternal && typeof HermesInternal.enablePromiseRejectionTracker === 'function') {
      HermesInternal.enablePromiseRejectionTracker({
        allRejections: true,
        onUnhandled: (id, rejection) => {
          try { reportError(rejection, { fatal: false, source: 'promise', extra: `id=${id}` }); } catch {}
        },
        onHandled: () => {},
      });
    }
  } catch {}

  // Web: window-level hooks (ErrorUtils does not exist in the browser).
  try {
    if (_platform === 'web' && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('error', (ev) => {
        try {
          const err = ev && (ev.error || ev.message);
          if (!err) return;
          // Resource load errors (img/script 404) also fire `error` on window
          // with no `.error` — those are noise; only JS errors have a stack.
          if (typeof err === 'string' && !ev.error) return;
          reportError(err, { fatal: false, source: 'window' });
        } catch {}
      });
      window.addEventListener('unhandledrejection', (ev) => {
        try { reportError(ev && ev.reason, { fatal: false, source: 'promise' }); } catch {}
      });
    }
  } catch {}

  // Heartbeat: prove the app actually got past boot
  setTimeout(() => _post('boot_alive_1s'), 1000);
  setTimeout(() => _post('boot_alive_5s'), 5000);
  setTimeout(() => _post('boot_alive_30s'), 30000);
}
