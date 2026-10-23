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
//   startPerfTelemetry / notePerfRoute / notePerfStall
//                                     perf (quadros lentos/congelados por rota, memória,
//                                     avisos) + perf_exit (motivo da saída anterior) —
//                                     ver §perf no fim. Kill: __chatyy_perf_telemetry = false.
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
  // [2026-10-18 perf-telemetry] quadros/memória/saída
  'ChatyyPerf',
];
// [2026-10-18] módulos que só existem num SO — sondá-los no outro gera falso "ausente"
// (ChatyyNotifActions é Apple-only: 109/109 relatórios Android vinham com 0).
const PROBE_ONLY_ON = { ChatyyNotifActions: 'ios' };
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

function _send(kind, info, data, onOk) {
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
    // onOk: só confirma (ack nativo) quando o servidor respondeu sem erro.
    const fire = () => {
      try {
        const pr = api.apiCall?.('callkit_diag', body, 'POST');
        if (pr && typeof pr.then === 'function') {
          pr.then((r) => { if (onOk && !(r && r.success === false)) { try { onOk(); } catch {} } }, () => {});
        }
      } catch {}
    };
    try { require('./bootIdle').runWhenBootIdle(fire); } catch { setTimeout(fire, 0); }
  } catch {}
}

/** [F-Q0 2026-10-23] mesmo canal (callkit_diag, login obrigatório, kill __chatyy_native_telemetry) p/ outros coletores. */
export function telemetrySend(kind, info, data) {
  _send(String(kind || 'misc').slice(0, 24), info, data);
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
      // [2026-10-23 envio-scl] onde o socket está + RTT do último ping (trace por mensagem sem depender do relógio)
      try { const er = ws.effRegion; if (typeof er === 'string' && er) o.wr = er.slice(0, 8); } catch {}
      try { if (Number(ws._latency) > 0) o.rtt = Math.min(99999, Math.round(Number(ws._latency))); } catch {}
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
  // [F-Q0 2026-10-23] envio tocado durante janela sem socket? (services/netQuality, kill próprio)
  try { const ms = Number(info && info.ms); if (ms >= 0) { const t = Date.now(); require('./netQuality').nqSend(t - ms, t, 'text'); } } catch {}
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
    // [2026-10-23 envio-scl] id do servidor (Snowflake: ms + região que aceitou) e cmi → junta com o banco
    // sem depender do relógio do celular (visto 22/10: iPhone até ~1 s atrasado no roaming).
    mid: _sendAckMid(r),
    cmi: _sendAckCmi(r, info),
  });
  _ensureLifecycle();
  if (_ackBuf.length >= SEND_ACK_BATCH) _flushAcks();
}

function _sendAckMid(r) {
  try { const id = r && r.data && r.data.id; if (id != null && /^[0-9]{1,20}$/.test(String(id))) return String(id); } catch {}
  return '';
}
function _sendAckCmi(r, info) {
  try {
    const c = (info && info.cmi) || (r && r.data && r.data.client_message_id) || '';
    return typeof c === 'string' ? c.slice(0, 40) : '';
  } catch { return ''; }
}

function _flushAcks() {
  if (!_ackBuf.length) return;
  const rows = _ackBuf; _ackBuf = [];
  const paths = {};
  for (const x of rows) paths[x.path] = (paths[x.path] || 0) + 1;
  _send('send_ack', `send_ack n=${rows.length} ` + Object.keys(paths).map((k) => `${k}:${paths[k]}`).join(' '), { rows });
}

// ─── media_send: envio de foto/vídeo/áudio/arquivo ─────────────────────────
/**
 * [2026-10-23 midia-wa] Uma amostra por mensagem de mídia (mesmo canal/lote do
 * send_ack: 10/POST, teto 60/sessão, sem conteúdo). row: { type, bytes_in,
 * bytes_out, level, t_bubble, t_prep_ms, t_up_ms, t_commit_ms, via
 * ('native'|'rust_edge'|'rust_us'|'r2'|'php'|'pre'), base (host), attempts, e2e
 * (toque→✓ ms), e2ee, mid, cmi }. -1 = não medido. Lote parcial sai em 20 s ou
 * quando o app vai p/ o fundo. Kill: globalThis.__chatyy_media_send_telemetry === false.
 */
export function reportMediaSend(row) {
  const st = reportMediaSend._st || (reportMediaSend._st = { buf: [], total: 0, timer: null, sub: null });
  const flush = () => {
    if (st.timer) { try { clearTimeout(st.timer); } catch {} st.timer = null; }
    if (!st.buf.length) return;
    const rows = st.buf; st.buf = [];
    const vias = {};
    for (const x of rows) vias[x.via || '?'] = (vias[x.via || '?'] || 0) + 1;
    _send('media_send', `media_send n=${rows.length} ` + Object.keys(vias).map((k) => `${k}:${vias[k]}`).join(' '), { rows });
  };
  if (row === '__flush') { try { flush(); } catch {} return; }
  // [F-Q0 2026-10-23] idem p/ mídia (e2e = toque→✓)
  try { const ms = Number(row && row.e2e); if (ms >= 0) { const t = Date.now(); require('./netQuality').nqSend(t - ms, t, 'media'); } } catch {}
  try {
    if (_off() || globalThis.__chatyy_media_send_telemetry === false) return;
  } catch {}
  if (!row || typeof row !== 'object' || st.total >= 60) return;
  st.total++;
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? Math.round(x) : -1; };
  const t = (v, m) => (typeof v === 'string' ? v.slice(0, m) : '');
  st.buf.push({
    type: t(row.type, 12), bytes_in: n(row.bytes_in), bytes_out: n(row.bytes_out), level: t(row.level, 10),
    t_bubble: n(row.t_bubble), t_prep_ms: n(row.t_prep_ms), t_up_ms: n(row.t_up_ms), t_commit_ms: n(row.t_commit_ms),
    via: t(row.via, 12), base: t(row.base, 40), attempts: n(row.attempts), e2e: n(row.e2e),
    e2ee: row.e2ee ? 1 : 0, mid: t(row.mid, 24), cmi: t(row.cmi, 40),
    net: (() => { try { return String(require('./networkInfo').getNetworkType?.() || '').slice(0, 10); } catch { return ''; } })(),
    at: Date.now(),
  });
  if (!st.sub) {
    try {
      st.sub = AppState.addEventListener('change', (s) => { if (s === 'background' || s === 'inactive') { try { flush(); } catch {} } });
    } catch { st.sub = { remove() {} }; }
  }
  if (st.buf.length >= 10) { flush(); return; }
  if (!st.timer) st.timer = setTimeout(() => { st.timer = null; try { flush(); } catch {} }, 20000);
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

// [2026-10-19 perf-scroll] fb guardava só o 1º motivo (ex.: row_zoom=no_hint mascarava
// o resto) e o painel só via a chave. Agora fbw = {nome: {motivo: n}} (até 8 motivos
// por nome) e o texto do beacon lista "nome:motivo×n" — o MOTIVO aparece no resumo.
const _fbWhy = Object.create(null);
export function noteNativeFallback(name, msg) {
  if (_off()) return;
  const n = String(name || '').slice(0, 32);
  if (!n) return;
  const why = String((msg && (msg.message || msg)) || '').replace(/\s+/g, ' ').slice(0, 80) || '1';
  if (!_fallback[n]) {
    _fallback[n] = why;
    _coverageDirty = true;
  }
  const w = _fbWhy[n] || (_fbWhy[n] = Object.create(null));
  if (w[why] == null) {
    if (Object.keys(w).length < 8) { w[why] = 1; _coverageDirty = true; }
  } else {
    w[why] += 1;
  }
  _ensureLifecycle();
}
function _fbSummary() {
  const parts = [];
  for (const n of Object.keys(_fbWhy)) {
    const w = _fbWhy[n];
    for (const r of Object.keys(w)) parts.push(`${n}:${r}x${w[r]}`);
  }
  return parts.join(',').slice(0, 220);
}

function _probeModules() {
  const out = {};
  try {
    const { requireOptionalNativeModule } = require('expo-modules-core');
    if (typeof requireOptionalNativeModule !== 'function') return out;
    for (const m of PROBE_MODULES) {
      if (PROBE_ONLY_ON[m] && PROBE_ONLY_ON[m] !== Platform.OS) continue;
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
    fbw: JSON.parse(JSON.stringify(_fbWhy)),
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
      const fbs = _fbSummary();
      _send('native_coverage', `native_coverage ${why || ''} #${_coverageSends}${fbs ? ` fb=${fbs}` : ''}`, _coverage());
    }
  } catch {}
}

// ─── perf: fluidez, memória e motivo de saída ──────────────────────────────
// [2026-10-18 perf-telemetry] Módulo nativo ChatyyPerf (expo-native-toolkit,
// apiVersion ≥ 1): CADisplayLink/Choreographer agregam no nativo, por rota, quadros
// lentos (> 2× orçamento) e congelados (≥ 700 ms) + pico de memória + avisos de
// memória, em janelas de 60 s (fecha também ao ir p/ 2º plano) numa fila persistida.
// Na próxima abertura o nativo entrega a sessão anterior (rota/fg/memória) e as
// saídas (Android ApplicationExitInfo; iOS MetricKit resumido).
// Aqui: lê (peek), soma as janelas num beacon e confirma (ack) só depois do POST.
//   kind 'perf'      — data { w, t0, t1, rr, rt:[{r,n,sl,fz,mx,j,js,jb,jmx}], mem:{…} }
//   kind 'perf_exit' — data { prev:{…}, js:{…}, ex:[…] } (só se morreu em 1º plano / houve saída)
// Também recebe os stalls do JS ≥ 400 ms (freezeWatch → notePerfStall), agregados
// por rota (faixas 400–700/700–1500/1500–2500/≥2500) — sem 1 beacon por stall.
// Binário antigo (sem o módulo / apiVersion < 1): só os stalls do JS.
// Kill switch (OTA): globalThis.__chatyy_perf_telemetry = false.
const PERF_BATCH_WINDOWS = 5;          // ~5 min de uso em 1º plano por beacon
const PERF_MIN_GAP_MS = 2 * 60 * 1000; // entre beacons 'perf' (fora o de 2º plano)
const PERF_BG_GAP_MS = 60 * 1000;
const PERF_MAX_SENDS = 40;             // por sessão
const PERF_MAX_ROUTES = 16;
const PREV_MAX_AGE_S = 6 * 3600;

let _perfMod; // undefined = não sondado · null = ausente
let _perfStarted = false;
let _perfRoute = '';
// [perf-scroll] fase (ver notePerfPhase)
const PHASE_RANK = { open: 3, kb: 2, scroll: 1 };
let _perfPhase = '';
let _perfPhaseUntil = 0;
let _perfPhaseTm = null;
let _perfLastSend = 0;
let _perfSending = false;
let _perfSends = 0;
let _perfExitSends = 0;
let _jsStall = Object.create(null); // rota → { c, b:[4], mx, sum }
let _jsStallN = 0;

function _perfOff() {
  if (_off()) return true;
  try { return globalThis.__chatyy_perf_telemetry === false; } catch { return false; }
}

/** Módulo nativo só se o binário tem a API certa (typeof + apiVersion). */
function _perfNative() {
  if (_perfMod !== undefined) return _perfMod;
  _perfMod = null;
  try {
    const { requireOptionalNativeModule } = require('expo-modules-core');
    const m = typeof requireOptionalNativeModule === 'function' ? requireOptionalNativeModule('ChatyyPerf') : null;
    if (m && typeof m.apiVersion === 'function' && typeof m.start === 'function'
      && typeof m.peek === 'function' && typeof m.ack === 'function' && typeof m.setRoute === 'function') {
      if ((Number(m.apiVersion()) || 0) >= 1) _perfMod = m;
    }
  } catch { _perfMod = null; }
  return _perfMod;
}

/** "/meet/8f3a…" → "/meet/:id" — sem ids/e-mails/telefones na rota. */
export function normalizePerfRoute(r) {
  try {
    let p = String(r || '').split(/[?#]/)[0];
    if (!p) return '';
    p = p.split('/').map((seg) => {
      if (!seg) return seg;
      if (/@/.test(seg) || /^\+?\d{3,}$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg) || (seg.length >= 20 && /\d/.test(seg))) return ':id';
      return seg;
    }).join('/');
    return p.slice(0, 48);
  } catch { return ''; }
}

export function notePerfRoute(r) {
  const n = normalizePerfRoute(r);
  if (!n || n === _perfRoute) return;
  _perfRoute = n;
  _perfPhase = ''; // fase é da rota anterior
  if (!_perfStarted) return;
  const m = _perfNative();
  if (m) { try { m.setRoute(n); } catch {} }
}

// ─── [2026-10-19 perf-scroll] fase da tela no contador nativo de quadros ──────
// A conversa tinha um número só (slow ‰ de /chat-conversation) misturando
// abertura, rolagem e teclado. A tela marca a fase e o contador nativo recebe
// "<rota>~<fase>" (setRoute dobra a janela atual — custo ~0): aparecem no beacon
// 'perf' como rotas "/chat-conversation~open", "~scroll", "~kb"; sem sufixo = parado.
// A fase expira sozinha (ttl, renovada a cada nota); mais forte não é trocada
// por mais fraca enquanto vale (open > kb > scroll). Stalls do JS seguem na rota base.
// Kill switch (OTA): globalThis.__chatyy_perf_phase = false.

function _perfApplyRoute() {
  if (!_perfStarted || !_perfRoute) return;
  const m = _perfNative();
  if (!m) return;
  const r = _perfPhase ? `${_perfRoute.slice(0, 40)}~${_perfPhase}` : _perfRoute;
  try { m.setRoute(r); } catch {}
}

function _perfPhaseArm() {
  if (_perfPhaseTm) return;
  const wait = Math.max(30, _perfPhaseUntil - Date.now());
  _perfPhaseTm = setTimeout(() => {
    _perfPhaseTm = null;
    if (!_perfPhase) return;
    if (Date.now() < _perfPhaseUntil) { _perfPhaseArm(); return; }
    _perfPhase = '';
    _perfApplyRoute();
  }, wait);
}

/** Marca a fase atual da tela ('open' | 'scroll' | 'kb') por ttlMs. Barato (chamar em todo onScroll). */
export function notePerfPhase(phase, ttlMs = 600) {
  if (_perfOff()) return;
  try { if (globalThis.__chatyy_perf_phase === false) return; } catch {}
  const p = String(phase || '');
  if (!PHASE_RANK[p]) return;
  const now = Date.now();
  if (_perfPhase && _perfPhase !== p && now < _perfPhaseUntil && PHASE_RANK[_perfPhase] > PHASE_RANK[p]) return;
  const until = now + Math.max(50, Math.min(5000, Number(ttlMs) || 600));
  if (_perfPhase === p) { if (until > _perfPhaseUntil) _perfPhaseUntil = until; _perfPhaseArm(); return; }
  _perfPhase = p;
  _perfPhaseUntil = until;
  _perfApplyRoute();
  _perfPhaseArm();
}

/** Stall do JS (atraso do timer com o app ativo), ms ≥ 400. Só agrega. */
export function notePerfStall(ms, route, la) {
  if (_perfOff()) return;
  const v = Math.round(Number(ms) || 0);
  if (!(v >= 400)) return;
  const r = normalizePerfRoute(route || _perfRoute) || '-';
  let k = r;
  if (!_jsStall[k] && Object.keys(_jsStall).length >= PERF_MAX_ROUTES) k = 'other';
  const e = _jsStall[k] || (_jsStall[k] = { c: 0, b: [0, 0, 0, 0], mx: 0, sum: 0 });
  e.c += 1; e.sum += v;
  e.b[v < 700 ? 0 : v < 1500 ? 1 : v < 2500 ? 2 : 3] += 1;
  if (v > e.mx) { e.mx = v; if (la) e.la = String(la).slice(0, 96); }
  _jsStallN += 1;
}

function _num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }

function _perfAggregate(windows) {
  const rt = Object.create(null);
  const mem = { pk: 0, cur: 0, mw: 0 };
  let t0 = 0; let t1 = 0; let rr = 0; let maxSeq = 0; let n = 0;
  for (const w of windows) {
    if (!w || typeof w !== 'object') continue;
    n += 1;
    maxSeq = Math.max(maxSeq, _num(w.s));
    const a = _num(w.t0); const b = _num(w.t1);
    if (a && (!t0 || a < t0)) t0 = a;
    if (b > t1) t1 = b;
    if (_num(w.rr)) rr = _num(w.rr);
    mem.pk = Math.max(mem.pk, _num(w.pk));
    if (_num(w.cur)) mem.cur = _num(w.cur);
    mem.mw += _num(w.mw);
    if (_num(w.av) > 0) mem.av = mem.av ? Math.min(mem.av, _num(w.av)) : _num(w.av);
    if (_num(w.pss)) mem.pss = Math.max(mem.pss || 0, _num(w.pss));
    if (_num(w.jh)) mem.jh = Math.max(mem.jh || 0, _num(w.jh));
    if (_num(w.jmax)) mem.jmax = _num(w.jmax);
    if (w.trim && typeof w.trim === 'object') {
      mem.trim = mem.trim || {};
      for (const lv of Object.keys(w.trim)) mem.trim['l' + lv] = (mem.trim['l' + lv] || 0) + _num(w.trim[lv]);
    }
    for (const x of (Array.isArray(w.rt) ? w.rt : [])) {
      if (!x) continue;
      const r = String(x.r || '-').slice(0, 48);
      const e = rt[r] || (rt[r] = { r, n: 0, sl: 0, fz: 0, mx: 0, j: 0 });
      e.n += _num(x.n); e.sl += _num(x.sl); e.fz += _num(x.fz); e.j += _num(x.j);
      e.mx = Math.max(e.mx, _num(x.mx));
    }
  }
  return { rt, mem, t0, t1, rr, maxSeq, n };
}

function _perfStatus() {
  try { return require('react-native').AppState.currentState || ''; } catch { return ''; }
}

function _perfMaybeSend(why) {
  if (_perfSending || _perfOff()) return;
  if (_perfSends >= PERF_MAX_SENDS) return;
  const now = Date.now();
  const m = _perfNative();
  let pk = null;
  if (m) { try { pk = m.peek(); } catch { pk = null; } }
  const windows = (pk && Array.isArray(pk.windows)) ? pk.windows : [];

  // 1) perf_exit — no boot (sessão anterior + saídas) e quando o MetricKit
  //    entrega um payload depois (evento 'exit'); no máx. 3 por sessão.
  if (m && pk && _perfExitSends < 3 && (_perfExitSends === 0 || why === 'exit')) {
    _perfExitSends += 1;
    _perfSendExit(m, pk);
  }

  // 2) perf
  const bg = why === 'bg' || _perfStatus() === 'background';
  const gap = now - _perfLastSend;
  const due = (bg && gap >= PERF_BG_GAP_MS && (windows.length || _jsStallN))
    || (windows.length >= PERF_BATCH_WINDOWS && gap >= PERF_MIN_GAP_MS)
    || (!m && _jsStallN > 0 && gap >= 5 * PERF_MIN_GAP_MS);
  if (!due) return;
  const ag = _perfAggregate(windows);
  const stalls = _jsStall; const stallN = _jsStallN;
  if (!ag.n && !stallN) return;
  _jsStall = Object.create(null); _jsStallN = 0;
  for (const r of Object.keys(stalls)) {
    const e = ag.rt[r] || (ag.rt[r] = { r, n: 0, sl: 0, fz: 0, mx: 0, j: 0 });
    e.js = stalls[r].c; e.jb = stalls[r].b; e.jmx = stalls[r].mx; e.jsum = stalls[r].sum;
    if (stalls[r].la) e.jla = stalls[r].la; // [perf-js] última ação antes da maior trava
  }
  const routes = Object.values(ag.rt)
    .sort((a, b) => ((b.fz * 50 + b.sl + (b.js || 0) * 5) - (a.fz * 50 + a.sl + (a.js || 0) * 5)) || (b.n - a.n))
    .slice(0, PERF_MAX_ROUTES);
  let fr = 0; let sl = 0; let fz = 0;
  for (const e of routes) { fr += e.n; sl += e.sl; fz += e.fz; }
  const data = { w: ag.n, t0: ag.t0, t1: ag.t1, rr: ag.rr, rt: routes, mem: ag.mem, why: String(why || '').slice(0, 8), api: m ? 1 : 0 };
  // [perf-js] trechos JS mais lentos da janela (ws:evento, conv:… — n/máx ms)
  try { const tr = require('./perfTrace'); const sp = tr.topSpans(6); if (sp && sp !== '-') data.sp = sp; tr.resetSpans(); } catch {}
  _perfLastSend = now;
  _perfSends += 1;
  _perfSending = true;
  const seq = ag.maxSeq;
  _ensureLifecycle();
  _send('perf', `perf w=${ag.n} n=${fr} sl=${sl} fz=${fz} js=${stallN} pk=${ag.mem.pk} mw=${ag.mem.mw}`, data, () => {
    if (m && seq > 0) { try { m.ack(seq, 0, false); } catch {} }
  });
  // sem retorno de erro: libera o próximo envio de qualquer jeito (o ack só vem no sucesso)
  setTimeout(() => { _perfSending = false; }, 15000);
}

function _perfSendExit(m, pk) {
  try {
    const exits = Array.isArray(pk.exits) ? pk.exits.slice(0, 6) : [];
    const prev = pk.prev && typeof pk.prev === 'object' ? pk.prev : null;
    const nowS = Math.floor(Date.now() / 1000);
    // sessão anterior só interessa se morreu em 1º plano (sem passar pelo 2º plano)
    let prevOut = null;
    if (prev && _num(prev.fg) === 1 && nowS - _num(prev.t) >= 0 && nowS - _num(prev.t) < PREV_MAX_AGE_S) {
      prevOut = { ...prev, gap: nowS - _num(prev.t) };
      if (_num(prev.lzt)) prevOut.lzago = _num(prev.t) - _num(prev.lzt); // congelou x s antes do último registro
    }
    let js = null;
    try {
      const fw = require('./freezeWatch'); // eslint-disable-line global-require
      js = typeof fw.getPrevEnd === 'function' ? fw.getPrevEnd() : null;
    } catch {}
    if (!exits.length && !prevOut) { try { m.ack(0, 0, !!prev); } catch {} return; }
    const summary = exits.map((e) => {
      if (!e) return '?';
      if (e.k === 'aexit') return `${e.reason || '?'}@${e.imp || 0}`;
      if (e.k === 'mx_diag') return `diag${e.crash ? ':crash' + e.crash.length : ''}${e.hang ? ':hang' + e.hang.length : ''}`;
      return String(e.k || '?');
    }).join(',');
    const info = `perf_exit prev=${prevOut ? `fg r=${prevOut.r || '-'} pk=${_num(prevOut.pk)} mw=${_num(prevOut.mw)}${prevOut.term ? ' term' : ''}` : '-'} ex=${summary || '-'}`;
    const data = { ex: exits };
    if (prevOut) data.prev = prevOut;
    if (js) data.js = js;
    const nEx = exits.length;
    const hadPrev = !!prev;
    _ensureLifecycle();
    _send('perf_exit', info, data, () => { try { m.ack(0, nEx, hadPrev); } catch {} });
  } catch {}
}

/** Liga a coleta nativa (se o binário tiver) + o envio. Chamado pelo freezeWatch após o boot. */
export function startPerfTelemetry() {
  if (_perfStarted || !IS_NATIVE || _perfOff()) return;
  _perfStarted = true;
  const m = _perfNative();
  if (m) {
    try { m.start({}); } catch {}
    try { if (_perfRoute) m.setRoute(_perfPhase ? `${_perfRoute.slice(0, 40)}~${_perfPhase}` : _perfRoute); } catch {}
    try {
      if (typeof m.addListener === 'function') m.addListener('onPerfWindow', (e) => { try { _perfMaybeSend(e && e.why); } catch {} });
    } catch {}
  }
  try {
    AppState.addEventListener('change', (s) => {
      if (s !== 'background') return;
      try {
        if (_perfOff()) { if (m && typeof m.stop === 'function') m.stop(); return; }
        _perfMaybeSend('bg');
      } catch {}
    });
  } catch {}
  // sessão anterior/saídas: logo após o boot (o _send ainda espera o bootIdle)
  setTimeout(() => { try { _perfMaybeSend('boot'); } catch {} }, 1500);
  // binário antigo: sem evento nativo → varre os stalls do JS a cada 5 min
  if (!m) setInterval(() => { try { _perfMaybeSend('t'); } catch {} }, 5 * 60 * 1000);
}

/** Depuração (console): estado do coletor nativo. */
export function perfTelemetryStats() {
  const m = _perfNative();
  let st = null;
  try { st = m && typeof m.stats === 'function' ? m.stats() : null; } catch {}
  return { started: _perfStarted, native: !!m, route: _perfRoute, jsStalls: _jsStallN, sends: _perfSends, st };
}

// timer/AppState da cobertura começam no 1º import (tela de conversa / home)
try { _ensureLifecycle(); } catch {}
