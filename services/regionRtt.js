// ─── [roteamento-regiao 2026-10-13] RTT do app até cada região (us/br/eu/usw/in/sg + edges do client-lb) ───
// Para o servidor escolher o servidor de ligação (LiveKit) e o TURN mais perto do
// PAR/GRUPO (minimax). Quem decide é o servidor no join da chamada (o `url`/
// iceServers do chat_livekit_token / chat_call_invite_v2 já vêm da região escolhida).
//
// [regiao-v2 2026-10-13] Medição v2 — "onde a pessoa realmente está".
// A v1 (2 amostras seguidas, em paralelo entre regiões, logo no boot) deu, p/ 2
// pessoas na Flórida, us=124/145 e eu=99/149 (física: ~35 e ~115) → chamada entre
// elas foi parar em São Paulo. Causas: host US com jitter de rede (picos +100–200 ms)
// pegava as 2 amostras; relógio JS (Date.now numa thread ocupada no boot) só SOMA;
// requisições das 4 regiões competindo entre si. Agora:
//   • alvo de cada região = host DIRETO (sem Cloudflare) do próprio SFU: livekit
//     (US/NY), lk-br, lk-eu, lk-usw — todos nginx `/ping` 204 (fallback api-br/api-eu);
//   • warm-up por região (DNS+TCP+TLS, DESCARTADO) e depois 5 rodadas INTERCALADAS
//     (us→br→eu→usw, uma requisição por vez, intervalo entre rodadas) na mesma
//     conexão keep-alive → valor = MÍNIMO (ruído só soma); jit = mediana − mínimo;
//   • espera a UI assentar (InteractionManager) e aborta se o app sair de 1º plano;
//   • remede quando a rede muda (tipo wifi↔celular, IP, geração) e ao abrir a tela
//     de chamada se a medição tiver > 10 min; senão no máx. 1×/30 min;
//   • reporta {rtt, v:2, n, net, jit, cc}: net = wifi|cellular|…; cc = país da dica
//     region_hint (Cloudflare) já em cache. Servidor ignora medições v1.
// Nunca bloqueia nada; tudo em 2º plano.
import { AppState, InteractionManager, Platform } from 'react-native';

export const MEASURE_VERSION = 2;
const DEFAULT_TARGETS = {
  us: 'https://livekit.chatyy.com.br/ping',
  br: 'https://lk-br.chatyy.com.br/ping',
  eu: 'https://lk-eu.chatyy.com.br/ping',
  usw: 'https://lk-usw.chatyy.com.br/ping',
  in: 'https://lk-in.chatyy.com.br/ping', // [2026-10-15] edge Índia (Mumbai)
  sg: 'https://lk-sg.chatyy.com.br/ping', // [2026-10-15] edge Ásia (Jacarta; região lógica sg)
  // [hint-11 2026-10-22] edges do client-lb (21/10): medidos só quando o client-lb os considera (ver _extraRegions)
  br2: 'https://lk-br2.chatyy.com.br/ping',
  mia: 'https://lk-mia.chatyy.com.br/ping',
  mex: 'https://lk-mex.chatyy.com.br/ping',
  mad: 'https://lk-mad.chatyy.com.br/ping',
  scl: 'https://lk-scl.chatyy.com.br/ping',
};
// Mesmo IP do SFU; usados só se o alvo principal não responder no warm-up.
const ALT_TARGETS = {
  br: 'https://api-br.chatyy.com.br/ping',
  eu: 'https://api-eu.chatyy.com.br/ping',
  br2: 'https://api-br2.chatyy.com.br/ping',
  mia: 'https://api-mia.chatyy.com.br/ping',
  mex: 'https://api-mex.chatyy.com.br/ping',
  mad: 'https://api-mad.chatyy.com.br/ping',
  scl: 'https://api-scl.chatyy.com.br/ping',
};
// Regiões com SFU/TURN de ligação: SEMPRE medidas (o minimax da chamada precisa do RTT de todas).
const BASE_REGIONS = ['us', 'br', 'eu', 'usw', 'in', 'sg'];
// [hint-11 2026-10-22] Edges novos (client-lb): a casa regional das conversas (chat_user_region_hint →
// política do leaf) precisa enxergá-los — sem isso, alguém em Santiago (scl 11–17 ms) virava 'usw'.
// Limite de sondas: só os que o client-lb JÁ mediu nesta rede (results) ou escolheu, no máx. MAX_EXTRA,
// os de menor RTT do client-lb primeiro (não sonda os 11 sempre).
const EXTRA_REGIONS = ['br2', 'mia', 'mex', 'mad', 'scl'];
const REGIONS = [...BASE_REGIONS, ...EXTRA_REGIONS];
const MAX_EXTRA = 2;
const SAMPLES = 5;
const MIN_OK_SAMPLES = 3;
const ROUND_GAP_MS = 150;
const TTL_MS = 30 * 60 * 1000;
const MIN_GAP_MS = 10 * 60 * 1000;   // remedição "forçada" comum
const NET_CHANGE_GAP_MS = 60 * 1000; // rede mudou: pode remedir após 1 min
const CALL_MAX_AGE_MS = 10 * 60 * 1000;
const WARM_TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 2500;
const STORE_KEY = 'region_rtt_v2';
const TARGETS_KEY = 'region_rtt_targets_v2';

let _running = false;
let _started = false;
let _timer = null;
let _netUnsub = null;
let _appStateSub = null;
let _last = null; // { v, ts, rtt, jit, net, sig }
let _sig = null;  // assinatura da rede atual

function _mm() { try { return require('./mmkv'); } catch { return null; } }
const _now = () => {
  try { if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') return performance.now(); } catch {}
  return Date.now();
};
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function _netInfo() {
  if (Platform.OS === 'web') return null;
  try { return require('@react-native-community/netinfo').default || null; } catch { return null; }
}
// Tipo da rede p/ o servidor: só a classe (sem IP/SSID).
function _netClass(t) {
  const s = String(t || '').toLowerCase();
  if (s === 'wifi' || s === 'cellular' || s === 'ethernet' || s === 'vpn' || s === 'wimax' || s === 'bluetooth') return s;
  return 'other';
}
// Assinatura LOCAL da rede (nunca sai do aparelho): tipo + IP (wifi/ethernet) + geração celular.
function _sigOf(st) {
  if (!st || st.isConnected === false) return null;
  const d = st.details || {};
  return [_netClass(st.type), d.ipAddress || '', d.cellularGeneration || '', d.carrier || ''].join('|');
}
async function _currentNet() {
  const NI = _netInfo();
  if (NI) {
    try { const st = await NI.fetch(); if (st) { _sig = _sigOf(st); return { net: _netClass(st.type), sig: _sig }; } } catch {}
  }
  try {
    const st = require('./networkInfo').getNetworkState();
    if (st && st.isConnected !== false) return { net: _netClass(st.type), sig: _netClass(st.type) };
  } catch {}
  return { net: 'other', sig: null };
}

function _load() {
  if (_last) return _last;
  try {
    const raw = _mm()?.getString(STORE_KEY);
    if (raw) { const p = JSON.parse(raw); if (p && p.v === MEASURE_VERSION && p.ts && p.rtt) _last = p; }
  } catch {}
  return _last;
}

function _targets() {
  try {
    const raw = _mm()?.getString(TARGETS_KEY);
    if (raw) {
      const t = JSON.parse(raw);
      const out = {};
      for (const r of REGIONS) {
        const u = t && t[r];
        if (typeof u === 'string' && /^https:\/\/[a-z0-9.-]+\.chatyy\.com\.br\/[a-z0-9/_-]*$/i.test(u)) out[r] = u;
      }
      if (Object.keys(out).length) return { ...DEFAULT_TARGETS, ...out };
    }
  } catch {}
  return DEFAULT_TARGETS;
}

// País da dica region_hint (Cloudflare) que o services/api.js já guardou.
// [video-fullhd 2026-10-22] país só se a dica for RECENTE (≤ 6 h) e da MESMA rede: o founder em
// Santiago mandava cc=US da dica do dia anterior (estava nos EUA) e o roteamento de chamada tratava
// Chile↔Chile como América do Norte (sala em NY). Servidor também descarta cc contradito pelo RTT.
const HINT_CC_MAX_AGE_MS = 6 * 3600 * 1000;
function _hintCountry(net) {
  try {
    const raw = _mm()?.getString('edge_region_hint');
    const h = raw ? JSON.parse(raw) : null;
    const c = h ? h.country : null;
    if (!(typeof c === 'string' && /^[A-Z]{2}$/.test(c))) return null;
    if (globalThis.__chatyy_rtt_cc_fresh === false) return c; // kill switch: comportamento antigo
    const ts = Number(h.ts) || 0;
    if (!ts || Date.now() - ts > HINT_CC_MAX_AGE_MS) return null;
    if (net && h.net && _netClass(h.net) !== net) return null;
    return c;
  } catch { return null; }
}

async function _timed(url, ms) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => { try { ctl && ctl.abort(); } catch {} }, ms);
  const t0 = _now();
  try {
    const res = await fetch(url, { method: 'GET', cache: 'no-store', signal: ctl ? ctl.signal : undefined });
    const dt = _now() - t0;
    return res && (res.status === 204 || res.ok) ? dt : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

function _afterInteractions(maxMs = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    try { InteractionManager.runAfterInteractions(fin); } catch { fin(); }
    setTimeout(fin, maxMs);
  });
}
const _active = () => !AppState.currentState || AppState.currentState === 'active';

// Exportada p/ teste: valor de uma região a partir das amostras (null = pouco dado).
export function _summarize(samples) {
  const v = (samples || []).filter((x) => typeof x === 'number' && isFinite(x) && x > 0).sort((a, b) => a - b);
  if (v.length < MIN_OK_SAMPLES) return null;
  const min = Math.max(1, Math.round(v[0]));
  const med = Math.round(v[Math.floor((v.length - 1) / 2)]);
  return { min, jit: Math.max(0, med - min), n: v.length };
}

// Exportada p/ teste: decide se precisa medir de novo.
//   opts.force = troca de rede/pedido explícito; opts.maxAgeMs = idade máxima aceita (tela de chamada).
export function _shouldMeasure(last, now, sig, opts = {}) {
  if (!last || !last.ts || last.v !== MEASURE_VERSION) return true;
  const age = now - last.ts;
  if (age < NET_CHANGE_GAP_MS) return false;
  if (sig && last.sig && sig !== last.sig) return true; // rede (ou IP) mudou
  if (typeof opts.maxAgeMs === 'number') return age >= opts.maxAgeMs;
  if (opts.force && age >= MIN_GAP_MS) return true;
  return age >= TTL_MS;
}

// [hint-11] Estado do client-lb (services/api.js): região/origem escolhidas + RTTs da última medição.
function _lbInfo() {
  try { const i = require('./api').getClientLbInfo?.(); return i && i.on ? i : null; } catch { return null; }
}
// Exportada p/ teste: quais edges novos medir (reaproveita a medição do client-lb p/ escolher; ≤ max).
export function _extraRegions(info, max = MAX_EXTRA) {
  if (!info) return [];
  const res = (info.results && typeof info.results === 'object') ? info.results : {};
  const usable = Array.isArray(info.usable) ? info.usable : [];
  const score = (id) => {
    if (id === 'br2') return info.origin === 'br2' ? (typeof res.br === 'number' ? res.br : 0) : null; // br2 = host da região br
    if (!usable.includes(id)) return null;
    if (info.region === id) return typeof res[id] === 'number' ? res[id] : 0;
    return typeof res[id] === 'number' && res[id] > 0 ? res[id] : null;
  };
  return EXTRA_REGIONS.map((id) => [id, score(id)]).filter(([, v]) => v != null)
    .sort((a, b) => a[1] - b[1]).slice(0, Math.max(0, max)).map(([id]) => id);
}
// Exportada p/ teste: região que o client-lb escolheu, na identidade do leaf (br + origem br2 → br2).
export function _lbPick(info) {
  if (!info || typeof info.region !== 'string') return null;
  const id = info.region === 'br' && info.origin === 'br2' ? 'br2' : info.region;
  return /^[a-z][a-z0-9]{1,5}$/.test(id) ? id : null;
}

async function _measure(tg, regions = BASE_REGIONS) {
  // 1) warm-up por região (paga DNS+TCP+TLS e acorda o rádio) — DESCARTADO
  const urls = {};
  await Promise.all(regions.map(async (r) => {
    if ((await _timed(tg[r], WARM_TIMEOUT_MS)) != null) { urls[r] = tg[r]; return; }
    if (ALT_TARGETS[r] && (await _timed(ALT_TARGETS[r], WARM_TIMEOUT_MS)) != null) urls[r] = ALT_TARGETS[r];
  }));
  const live = regions.filter((r) => urls[r]);
  if (!live.length) return null;
  // 2) N rodadas intercaladas, UMA requisição por vez (ninguém compete), conexão quente
  const samples = {};
  live.forEach((r) => { samples[r] = []; });
  for (let i = 0; i < SAMPLES; i++) {
    if (!_active()) return null; // app foi p/ 2º plano: timers/rede congelam → medição inválida
    const order = i % 2 ? [...live].reverse() : live;
    for (const r of order) {
      const dt = await _timed(urls[r], PROBE_TIMEOUT_MS);
      if (dt != null) samples[r].push(dt);
    }
    if (i < SAMPLES - 1) await _sleep(ROUND_GAP_MS);
  }
  const rtt = {}; const jit = {};
  for (const r of live) {
    const s = _summarize(samples[r]);
    if (s && s.min < 5000) { rtt[r] = s.min; jit[r] = s.jit; }
  }
  return Object.keys(rtt).length ? { rtt, jit } : null;
}

export async function measureAndReport(opts = {}) {
  if (_running) return null;
  if (!_active()) return null;
  _running = true;
  try {
    const { net, sig } = await _currentNet();
    if (!_shouldMeasure(_load(), Date.now(), sig, opts)) return _last;
    await _afterInteractions();
    if (!_active()) return null;
    const lb = _lbInfo();
    const m = await _measure(_targets(), [...BASE_REGIONS, ..._extraRegions(lb)]);
    if (!m) return null; // offline/péssimo/2º plano: tenta na próxima
    _last = { v: MEASURE_VERSION, ts: Date.now(), rtt: m.rtt, jit: m.jit, net, sig };
    try { _mm()?.setString(STORE_KEY, JSON.stringify(_last)); } catch {}
    try {
      const { apiCall } = require('./api');
      const body = { rtt: m.rtt, v: MEASURE_VERSION, n: SAMPLES, net, jit: m.jit };
      const cc = _hintCountry(net);
      if (cc) body.cc = cc;
      // [hint-11] região do client-lb (HTTP+WS) → servidor grava como hint da casa regional (fonte 'lb')
      const pick = _lbPick(lb);
      if (pick) body.lb = { reg: pick, rtt: typeof m.rtt[pick] === 'number' ? m.rtt[pick] : null };
      const res = await apiCall('chat_region_rtt_report', body, 'POST');
      const t = res && res.data && res.data.targets;
      if (t && typeof t === 'object') { try { _mm()?.setString(TARGETS_KEY, JSON.stringify(t)); } catch {} }
    } catch {}
    if (__DEV__) console.log('[regionRtt v2] ' + net + ' ' + REGIONS.map((r) => r + '=' + (m.rtt[r] ?? '-') + (m.jit[r] != null ? '±' + m.jit[r] : '')).join(' '));
    return _last;
  } catch { return null; } finally { _running = false; }
}

// Tela de chamada abrindo: remede em 2º plano se a medição tiver > 10 min (ou rede mudou).
export function refreshForCall() {
  measureAndReport({ maxAgeMs: CALL_MAX_AGE_MS }).catch(() => {});
}

export function getLastRegionRtt() { return _load(); }

// Liga a medição em 2º plano (idempotente). delayMs = folga após o login/boot.
export function startRegionRtt(delayMs = 20000) {
  if (_started) return;
  _started = true;
  setTimeout(() => { measureAndReport().catch(() => {}); }, delayMs);
  _timer = setInterval(() => { measureAndReport().catch(() => {}); }, 5 * 60 * 1000); // barato: só mede após TTL
  try {
    _appStateSub = AppState.addEventListener('change', (s) => { if (s === 'active') setTimeout(() => { measureAndReport().catch(() => {}); }, 3000); });
  } catch {}
  // Rede mudou (wifi↔celular, outro IP/wifi, 4G→5G): remede após assentar.
  let debounce = null;
  let first = true; // 1º evento = estado atual no boot (já coberto pela medição atrasada acima)
  const onChange = (sig) => {
    if (first) { first = false; if (sig) _sig = sig; return; }
    if (!sig || sig === _sig) return;
    _sig = sig;
    const last = _load();
    if (last && last.sig === sig) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { measureAndReport({ force: true }).catch(() => {}); }, 4000);
  };
  const NI = _netInfo();
  if (NI) {
    try { _netUnsub = NI.addEventListener((st) => onChange(_sigOf(st))); } catch {}
  } else {
    try { _netUnsub = require('./networkInfo').onNetworkChange((st) => onChange(st && st.isConnected !== false ? _netClass(st.type) : null)); } catch {}
  }
}

export function stopRegionRtt() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  try { typeof _netUnsub === 'function' && _netUnsub(); } catch {}
  try { _appStateSub && _appStateSub.remove && _appStateSub.remove(); } catch {}
  _netUnsub = null; _appStateSub = null;
  _started = false;
}

export default { startRegionRtt, stopRegionRtt, measureAndReport, refreshForCall, getLastRegionRtt };
