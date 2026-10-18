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
  // [2026-10-16 android-wave8] módulos das levas 7/8 — valor = apiVersion (0 = ausente)
  'ChatyyConversationList', 'ChatyyPinnedStrip', 'ChatyyRowZoom', 'ChatyyEmojiPanel',
  'ChatyyInAppBanner', 'ChatyyMediaGrid', 'ChatyyComposer',
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
    // [perf 2026-10-17 boot-fanout] no boot espera a 1ª pintura + ~25 s + ocioso
    // (bootIdle) — beacon de telemetria não disputa rede com a lista/conversa.
    const fire = () => { try { api.apiCall?.('callkit_diag', body, 'POST')?.catch?.(() => {}); } catch {} };
    try { require('./bootIdle').runWhenBootIdle(fire); } catch { setTimeout(fire, 0); }
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
// ─── auth_funnel: login/cadastro por telefone → 1ª lista de conversas ──────
// [otp-wa 2026-10-18] markAuthDone() no fim do OTP (login) ou do cadastro; o 1º
// 'native_list store_ready' depois disso manda `auth_funnel first_list ms=… n=…`
// (n = conversas na lista). Uma vez por login, só se ocorrer em até 15 min.
let _authT0 = 0;
let _authKind = '';
export function markAuthDone(kind) {
  try { _authT0 = Date.now(); _authKind = String(kind || '').slice(0, 12); } catch {}
}

export function nativeBeacon(prefix, step, info) {
  if (_off()) return;
  const p = String(prefix || 'native').slice(0, 24);
  const s = String(step || '');
  if (_authT0 && p === 'native_list' && s === 'store_ready') {
    const ms = Date.now() - _authT0;
    const k = _authKind;
    _authT0 = 0;
    if (ms >= 0 && ms < 15 * 60 * 1000) {
      const n = (String(info || '').match(/\bn=(\d+)/) || [])[1];
      try { _ensureLifecycle(); _send('auth_funnel', `auth_funnel first_list ms=${ms} kind=${k}${n != null ? ` n=${n}` : ''}`); } catch {}
    }
  }
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

// ─── send_ack: caminho real do envio de texto ──────────────────────────────
// [2026-10-16 wave10-D] Explica ack p50 433–731 ms no cliente vs ~29 ms no hub:
// cada amostra diz POR ONDE o envio saiu (ws nativo/fila nativa/ws JS/http/
// envelope; leaf/regional) + espera na fila da tela + estado do socket NO
// MOMENTO do envio. Em lote (10/POST, teto 80/sessão) p/ caber no rate-limit.
// Kill switch (OTA): globalThis.__chatyy_send_ack_telemetry = false.
const SEND_ACK_BATCH = 10;
const SEND_ACK_MAX = 80;
let _ackBuf = [];
let _ackTotal = 0;

/** Foto barata do transporte (síncrona, sem I/O). */
export function sendSocketSnapshot(net) {
  const o = {};
  if (net) o.net = String(net).slice(0, 12);
  try {
    const ws = require('./websocket').default;
    if (ws) {
      o.js = ws.ws ? ws.ws.readyState : -1; // 0 conectando · 1 aberto · 2/3 fechando/fechado · -1 sem socket
      o.auth = ws.authenticated ? 1 : 0;
      o.hl = ws.isHealthy ? 1 : 0;
      o.pong = ws.lastPongTime ? Math.min(999999, Date.now() - ws.lastPongTime) : -1;
      o.cap = Array.isArray(ws.serverCaps) && ws.serverCaps.includes('native_send') ? 1 : 0;
    }
  } catch {}
  try { const nc = require('./nativeCore'); o.nc = nc.canSendNative?.() ? 1 : 0; } catch {}
  try { const no = require('./nativeOutbox'); o.no = no.nativeOutboxEnabled?.() ? 1 : 0; } catch {}
  try { if (globalThis.__chatyy_native_send_off === true) o.off = 1; } catch {}
  return o;
}

/** Caminho real a partir do resultado de api.chatSend. */
export function sendPathOf(r) {
  if (!r || typeof r !== 'object') return 'none';
  let p = 'http'; // Rust ou PHP (apiCall) — ambos HTTP do JS
  if (r.envelope_mode) p = 'envelope';
  else if (r._native_outbox) p = 'nout_' + (r._via || '?'); // fila nativa: via ws|http nativo
  else if (r._native_core) p = 'ncore_ws';
  else if (r._native_send) p = 'ws_js';
  const tags = [];
  try { if (typeof r._hub === 'string' && /^leaf-/.test(r._hub)) tags.push('leaf'); } catch {}
  try { if (r.data && require('./leafSeq').isPreApplyRow(r.data, r._hub)) tags.push('preapply'); } catch {}
  try { if (require('./regionalAccept').isRegionalProvisional(r)) tags.push('regional'); } catch {}
  if (r._dedup) tags.push('dedup');
  return tags.length ? `${p}+${tags.join('+')}` : p;
}

/**
 * Uma amostra de ack de envio. info: { ms (toque→✓), pre (toque→enfileirar), q (espera na fila da tela),
 * net (api.chatSend inteiro), r (resultado), s0 (foto ao enfileirar), s1 (foto
 * ao sair p/ a rede), e2e }.
 */
export function noteSendAck(info) {
  try {
    if (_off() || globalThis.__chatyy_send_ack_telemetry === false) return;
  } catch {}
  if (!info || _ackTotal >= SEND_ACK_MAX) return;
  _ackTotal++;
  const r = info.r;
  _ackBuf.push({
    ms: Math.round(Number(info.ms) || 0),
    pre: Math.round(Number(info.pre) || 0),
    q: Math.round(Number(info.q ?? -1)),
    net: Math.round(Number(info.net ?? -1)),
    path: sendPathOf(r),
    hub: (r && typeof r._hub === 'string') ? r._hub.slice(0, 24) : '',
    s0: info.s0 || null,
    s1: info.s1 || null,
    e2e: info.e2e ? 1 : 0,
    at: Date.now(),
  });
  _ensureLifecycle();
  if (_ackBuf.length >= SEND_ACK_BATCH) _flushAcks();
}

function _flushAcks() {
  if (!_ackBuf.length) return;
  const rows = _ackBuf; _ackBuf = [];
  const paths = {};
  for (const x of rows) paths[x.path] = (paths[x.path] || 0) + 1;
  _send('send_ack', `send_ack n=${rows.length} ` + Object.keys(paths).map((k) => `${k}:${paths[k]}`).join(' '), { rows });
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
      let v = 0;
      try {
        const mod = requireOptionalNativeModule(m);
        if (mod) {
          v = 1;
          // apiVersion quando o módulo expõe (lista de conversas 3, figurinhas 2…)
          try { if (typeof mod.apiVersion === 'function') v = Math.max(1, Number(mod.apiVersion()) || 1); } catch {}
        }
      } catch {}
      out[m] = v;
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
  try { _flushAcks(); } catch {}
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
