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

function _lazyAsyncStorage() {
  try { return require('@react-native-async-storage/async-storage').default; } catch { return null; }
}
function _lazyConstants() {
  try { return require('expo-constants').default; } catch { return null; }
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

async function _post(step, info) {
  try {
    const anon = await _ensureAnonId();
    const body = JSON.stringify({
      step: String(step || 'unknown').slice(0, 60).replace(/[^a-zA-Z0-9_]/g, '_'),
      platform: _platform,
      info: String(info || '').slice(0, 480),
      ts: new Date().toISOString(),
      anon_id: anon,
    });
    const headers = { 'Content-Type': 'application/json' };
    if (_bearer) headers['Authorization'] = `Bearer ${_bearer}`;
    // best-effort, never throw
    await fetch(ENDPOINT, { method: 'POST', headers, body }).catch(() => {});
  } catch {}
}

export async function reportStep(step, info) {
  // Caller may also want sync-ish behavior — we still don't await for them.
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
    if (p.stack) info += ` | ${String(p.stack).slice(0, 250)}`;
    _post(step, info);
  } catch {}
}

export function setReporterIdentity({ email, bearer } = {}) {
  if (bearer) _bearer = String(bearer);
  if (email) _post('identity', `email=${email}`);
}

function _chunked(prefix, big) {
  const s = String(big || '');
  if (s.length <= 450) { _post(prefix, s); return; }
  const parts = [];
  for (let i = 0; i < s.length && parts.length < 8; i += 450) parts.push(s.slice(i, i + 450));
  parts.forEach((p, idx) => _post(`${prefix}_${idx + 1}of${parts.length}`, p));
}

export function installCrashReporter() {
  if (_installed) return;
  _installed = true;
  _post('boot_start', `ver=${_appVersion()} plat=${_platform}`);

  // Global JS error handler (RN/Hermes)
  try {
    if (global && global.ErrorUtils && typeof global.ErrorUtils.setGlobalHandler === 'function') {
      const prev = global.ErrorUtils.getGlobalHandler ? global.ErrorUtils.getGlobalHandler() : null;
      global.ErrorUtils.setGlobalHandler((error, isFatal) => {
        try {
          const msg = (error && error.message) ? error.message : String(error || 'unknown');
          const stack = (error && error.stack) ? error.stack : '';
          _post(isFatal ? 'crash_fatal_msg' : 'crash_nonfatal_msg', `seq=${++_seqBoot} ${msg}`);
          _chunked(isFatal ? 'crash_fatal_stack' : 'crash_nonfatal_stack', stack);
        } catch {}
        if (typeof prev === 'function') {
          try { prev(error, isFatal); } catch {}
        }
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
          try {
            const msg = (rejection && rejection.message) ? rejection.message : String(rejection || '');
            const stack = (rejection && rejection.stack) ? rejection.stack : '';
            _post('promise_rejection_msg', `id=${id} ${msg}`);
            _chunked('promise_rejection_stack', stack);
          } catch {}
        },
        onHandled: () => {},
      });
    }
  } catch {}

  // Heartbeat: prove the app actually got past boot
  setTimeout(() => _post('boot_alive_1s'), 1000);
  setTimeout(() => _post('boot_alive_5s'), 5000);
  setTimeout(() => _post('boot_alive_30s'), 30000);
}
