// services/nativeTelemetry.js — [2026-10-16 wave nativa 7] telemetria das views nativas.
//
// Canal: POST callkit_diag (email.php grava em /var/mail/_native_diag/AAAA-MM-DD.jsonl
// sem PII, rate-limit 30/min por aparelho; leitura: /root/nativo-telemetria.sh).
// Antes o servidor DESCARTAVA tudo o que chegava em callkit_diag.
//
//   nativeBeacon(prefix, step, info)  beacons de diagnóstico das telas nativas
//                                     (native_list, conv_shell, native_reels…) com
//                                     build/aparelho; teto por sessão.
//   noteConvOpen / useConvOpenMetric  conv_open = toque na linha da home → 1º frame
//                                     da conversa (caminho shell|native|js, linhas,
//                                     motivo do fallback p/ FlatList). Amostrado
//                                     (20 % das sessões) e enviado em lote.
//   noteNativeMount / noteNativeFallback
//                                     native_coverage: 1 resumo por sessão (módulos
//                                     presentes no binário, quais montaram, quais
//                                     caíram p/ JS, apiVersion da lista, b=/ota=).
//
// Kill switch (OTA): globalThis.__chatyy_native_telemetry = false.
// Taxa de amostragem: globalThis.__chatyy_conv_open_sample (0..1, padrão 0.2).
import { useEffect, useRef } from 'react';
import { Platform, AppState } from 'react-native';

const IS_NATIVE = Platform.OS === 'ios' || Platform.OS === 'android';
const CONV_OPEN_SAMPLE = 0.2;
const BEACON_CAP_PER_PREFIX = 12;
const CONV_BATCH = 8;
const CONV_MAX_MS = 30000;
const COVERAGE_FIRST_MS = 3 * 60 * 1000;
const COVERAGE_MAX_SENDS = 3;

// módulos/views nativos cuja PRESENÇA no binário entra na cobertura
const PROBE_MODULES = [
  'ChatyyMessageList', 'ChatyyChatStore', 'ChatyyChatCore', 'ChatyyTransport', 'ChatyyReelsFeed',
  'ChatyyPhotosGrid', 'ChatyyMapView', 'ChatyyContextMenuView', 'ChatyyNotifActions', 'ChatyyTransfer',
  'ExpoNativeChatView', 'ExpoNativeToolkit', 'ExpoNativeAudio', 'ExpoLiveNative', 'ExpoShorts',
];
// flags globais de fallback já usadas pelas telas (ErrorBoundary → JS)
const FAILED_FLAGS = [
  'home', 'pins', 'inbox', 'status_list', 'calls', 'contacts', 'feed', 'channels', 'communities',
  'settings', 'notes', 'drive', 'calendar', 'wallet', 'group_create',
];

const _beaconCount = Object.create(null);
const _mounted = Object.create(null);
const _fallback = Object.create(null);
const _paths = Object.create(null);
let _convBuf = [];
let _sampled = null;
let _lastTapT0 = 0;
let _coverageSends = 0;
let _coverageDirty = true;
let _coverageTimer = null;
let _appStateSub = null;

function _off() {
  if (!IS_NATIVE) return true;
  try { return globalThis.__chatyy_native_telemetry === false; } catch { return false; }
}

function _isSampled() {
  if (_sampled === null) {
    let r = CONV_OPEN_SAMPLE;
    try { const o = globalThis.__chatyy_conv_open_sample; if (typeof o === 'number' && o >= 0 && o <= 1) r = o; } catch {}
    _sampled = Math.random() < r;
  }
  return _sampled;
}

let _buildCache = null;
function _build() {
  if (_buildCache) return _buildCache;
  let tag = '';
  try { const cr = require('./crashReporter'); tag = typeof cr.getBuildTag === 'function' ? cr.getBuildTag() : ''; } catch {}
  tag = String(tag || '').replace(/[[\]]/g, '').trim(); // "b=686 ota=01a13ede rt=2.6.0"
  if (tag) _buildCache = tag;
  return tag;
}

function _dev() {
  try { const cr = require('./crashReporter'); return String(cr.getAnonIdSync?.() || ''); } catch { return ''; }
}

function _send(kind, info, data) {
  if (_off()) return;
  try {
    const m = require('./api');
    const api = m.default || m;
    const tok = (api.getAuthToken && api.getAuthToken()) || (api.getToken && api.getToken());
    if (!tok) return; // callkit_diag exige login; antes do login = 401 inútil
    const body = { kind, info: String(info || '').slice(0, 400), platform: Platform.OS, dev: _dev(), b: _build() };
    if (data && typeof data === 'object') body.data = data;
    setTimeout(() => {
      try { api.apiCall?.('callkit_diag', body, 'POST')?.catch?.(() => {}); } catch {}
    }, 0);
  } catch {}
}

function _ensureLifecycle() {
  if (_off()) return;
  if (!_coverageTimer) {
    _coverageTimer = setTimeout(() => { flushNativeTelemetry('timer'); }, COVERAGE_FIRST_MS);
  }
  if (!_appStateSub) {
    try {
      _appStateSub = AppState.addEventListener('change', (s) => {
        if (s === 'background' || s === 'inactive') flushNativeTelemetry('bg');
      });
    } catch { _appStateSub = { remove() {} }; }
  }
}

// ─── beacons de diagnóstico ────────────────────────────────────────────────
/** Beacon de diagnóstico de uma tela nativa (substitui o POST cru a callkit_diag). */
export function nativeBeacon(prefix, step, info) {
  if (_off()) return;
  const p = String(prefix || 'native').slice(0, 24);
  const s = String(step || '');
  // cobertura: lê os passos conhecidos
  if (p === 'native_list') {
    if (s === 'store_ready') noteNativeMount('native_list');
    else if (s === 'disabled' || s === 'crash_guard') noteNativeFallback('native_list', `${s} ${info || ''}`);
  } else if (p === 'conv_shell') {
    if (/^shell_paint/.test(s)) noteNativeMount('conv_shell');
  } else if (p === 'native_reels') {
    if (/fail|error|disabled|fallback|crash_guard/i.test(s)) noteNativeFallback('native_reels', `${s} ${info || ''}`);
  } else if (p === 'native_onboarding') {
    noteNativeFallback('native_onboarding', `${s} ${info || ''}`);
  }
  const n = (_beaconCount[p] || 0) + 1;
  _beaconCount[p] = n;
  if (n > BEACON_CAP_PER_PREFIX) return;
  _ensureLifecycle();
  _send(p, `${p} ${s} ${info || ''}`.trim());
}

// ─── conv_open ─────────────────────────────────────────────────────────────
/**
 * 1º frame da conversa. path: 'shell' (casca leve) | 'native' | 'js'.
 * Depois da casca, a tela completa reporta 'full_native'/'full_js' (mesmo toque).
 * Só mede aberturas vindas de um toque na home (convShell.markOpenTap).
 */
export function noteConvOpen(conv, path, extra) {
  if (_off()) return;
  let t0 = 0; let tconv = '';
  try {
    const cs = require('./convShell');
    const ti = typeof cs.openTapInfo === 'function' ? cs.openTapInfo() : null;
    if (ti) { t0 = ti.t0; tconv = ti.conv; }
  } catch {}
  if (!t0 || tconv !== String(conv)) return;
  const ms = Date.now() - t0;
  if (ms < 0 || ms > CONV_MAX_MS) return;
  let p = String(path || 'js');
  if (_lastTapT0 === t0) {
    if (p === 'shell' || /^full_/.test(p)) return; // já contado
    p = 'full_' + p; // a tela completa depois da casca
  } else {
    if (/^full_/.test(p)) return;
    _lastTapT0 = t0;
  }
  _paths[p] = (_paths[p] || 0) + 1;
  _coverageDirty = true;
  _ensureLifecycle();
  if (!_isSampled()) return;
  const ev = { p, ms, n: Math.max(-1, Math.round(Number(extra && extra.rows) || 0)) };
  const r = extra && extra.reason ? String(extra.reason).replace(/\s+/g, ' ').slice(0, 60) : '';
  if (r) ev.r = r;
  if (extra && extra.api) ev.a = Number(extra.api) || 0;
  _convBuf.push(ev);
  if (_convBuf.length >= CONV_BATCH) _flushConv();
}

function _flushConv() {
  if (!_convBuf.length) return;
  const ev = _convBuf; _convBuf = [];
  _send('conv_open', `conv_open n=${ev.length}`, { ev });
}

/**
 * Hook da tela completa da conversa: mede quando a lista fica pronta (ready) —
 * próximo frame após o commit. nl = retorno de useNativeThreadList ({on, reason}).
 */
export function useConvOpenMetric(conv, nl, rows, ready) {
  const doneRef = useRef('');
  const on = !!(nl && nl.on);
  const reason = (nl && nl.reason) || '';
  useEffect(() => {
    if (!IS_NATIVE || !ready || !conv) return undefined;
    const key = String(conv);
    if (doneRef.current === key) return undefined;
    doneRef.current = key;
    let api = 0;
    try { api = require('../components/chat/nativeThreadList').nativeListApi() || 0; } catch {}
    const why = on ? '' : (reason || (api ? 'off' : 'no_module'));
    const raf = requestAnimationFrame(() => { noteConvOpen(conv, on ? 'native' : 'js', { rows, reason: why, api }); });
    return () => { try { cancelAnimationFrame(raf); } catch {} };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv, ready]);
}

// ─── native_coverage ───────────────────────────────────────────────────────
export function noteNativeMount(name) {
  if (_off()) return;
  const n = String(name || '').slice(0, 32);
  if (!n) return;
  if (!_mounted[n]) _coverageDirty = true;
  _mounted[n] = (_mounted[n] || 0) + 1;
  _ensureLifecycle();
}

export function noteNativeFallback(name, msg) {
  if (_off()) return;
  const n = String(name || '').slice(0, 32);
  if (!n) return;
  if (!_fallback[n]) {
    _fallback[n] = String((msg && (msg.message || msg)) || '').replace(/\s+/g, ' ').slice(0, 80) || '1';
    _coverageDirty = true;
  }
  _ensureLifecycle();
}

function _probeModules() {
  const out = {};
  try {
    const { requireOptionalNativeModule } = require('expo-modules-core');
    if (typeof requireOptionalNativeModule !== 'function') return out;
    for (const m of PROBE_MODULES) {
      let ok = false;
      try { ok = !!requireOptionalNativeModule(m); } catch {}
      out[m] = ok ? 1 : 0;
    }
  } catch {}
  return out;
}

function _coverage() {
  const failed = [];
  for (const f of FAILED_FLAGS) {
    try { if (globalThis['__chatyy_native_' + f + '_failed']) failed.push(f); } catch {}
  }
  const kills = [];
  try {
    for (const k of Object.keys(globalThis)) {
      if (/^__chatyy_native_[a-z_]+$/.test(k) && !/_failed$/.test(k) && globalThis[k] === false) kills.push(k.slice(16));
    }
  } catch {}
  let api = 0;
  try { api = require('../components/chat/nativeThreadList').nativeListApi() || 0; } catch {}
  return {
    api, mods: _probeModules(), mounted: { ..._mounted }, fb: { ..._fallback },
    failed, kills: kills.slice(0, 20), paths: { ..._paths },
  };
}

/** Envia o lote de conv_open e (se mudou) o resumo de cobertura. Seguro chamar sempre. */
export function flushNativeTelemetry(why) {
  if (_off()) return;
  try { _flushConv(); } catch {}
  try {
    if (_coverageDirty && _coverageSends < COVERAGE_MAX_SENDS) {
      _coverageDirty = false;
      _coverageSends++;
      _send('native_coverage', `native_coverage ${why || ''} #${_coverageSends}`, _coverage());
    }
  } catch {}
}

// timer/AppState da cobertura começam no 1º import (tela de conversa / home)
try { _ensureLifecycle(); } catch {}
