// ─── [roteamento-regiao 2026-10-13] RTT do app até cada região (us/br/eu/usw) ───
// Para o servidor escolher o servidor de ligação (LiveKit) e o TURN mais perto do
// PAR/GRUPO (minimax). Barato e em segundo plano:
//   • alvos = /ping (nginx 204, sem corpo) em cada região; lista vem do servidor
//     (resposta do report) e fica em cache — muda sem OTA;
//   • por região: 1 warm-up (DNS+TCP+TLS) + 2 medições na conexão quente → menor;
//   • no máx. 1 rodada a cada 30 min (e na troca de rede, respeitando 10 min);
//   • só com o app em primeiro plano e logado; nunca bloqueia nada;
//   • envia SÓ {us,br,eu,usw → ms}. Sem IP, sem tipo de rede.
//   • [usw 2026-10-13] usw = US-West (Seattle, lk-usw). Servidor sem o patch usw ignora a chave.
// O resultado não muda nada no cliente: quem decide é o servidor no join da
// chamada (o `url`/iceServers do chat_livekit_token / chat_call_invite_v2 já
// vêm da região escolhida — JS e nativo usam o que vier).
import { AppState } from 'react-native';

const DEFAULT_TARGETS = {
  us: 'https://livekit.chatyy.com.br/ping',
  br: 'https://api-br.chatyy.com.br/ping',
  eu: 'https://api-eu.chatyy.com.br/ping',
  usw: 'https://lk-usw.chatyy.com.br/ping',
};
const REGIONS = ['us', 'br', 'eu', 'usw'];
const TTL_MS = 30 * 60 * 1000;
const MIN_GAP_MS = 10 * 60 * 1000;
const WARM_TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 2500;
const STORE_KEY = 'region_rtt_v1';
const TARGETS_KEY = 'region_rtt_targets_v1';

let _running = false;
let _started = false;
let _timer = null;
let _last = null; // { ts, rtt, net }

function _mm() { try { return require('./mmkv'); } catch { return null; } }
function _netKey() {
  try {
    const st = require('./networkInfo').getNetworkState();
    if (!st || st.isConnected === false) return null;
    return st.type && st.type !== 'unknown' && st.type !== 'none' ? String(st.type) : null;
  } catch { return null; }
}

function _load() {
  if (_last) return _last;
  try {
    const raw = _mm()?.getString(STORE_KEY);
    if (raw) { const p = JSON.parse(raw); if (p && p.ts && p.rtt) _last = p; }
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

async function _timed(url, ms) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => { try { ctl && ctl.abort(); } catch {} }, ms);
  const t0 = Date.now();
  try {
    await fetch(url, { method: 'GET', cache: 'no-store', signal: ctl ? ctl.signal : undefined });
    return Date.now() - t0;
  } catch { return null; } finally { clearTimeout(timer); }
}

async function _probe(url) {
  if ((await _timed(url, WARM_TIMEOUT_MS)) == null) return null; // warm-up paga DNS/TLS
  const a = await _timed(url, PROBE_TIMEOUT_MS);
  const b = await _timed(url, PROBE_TIMEOUT_MS);
  const v = [a, b].filter((x) => x != null);
  return v.length ? Math.max(1, Math.min(...v)) : null;
}

// Exportada p/ teste: decide se precisa medir de novo.
export function _shouldMeasure(last, now, net, force) {
  if (!last || !last.ts) return true;
  const age = now - last.ts;
  if (age < MIN_GAP_MS) return false;
  if (force) return true;
  if (net && last.net && net !== last.net) return true;
  return age >= TTL_MS;
}

export async function measureAndReport({ force = false } = {}) {
  if (_running) return null;
  if (AppState.currentState && AppState.currentState !== 'active') return null;
  const net = _netKey();
  if (!_shouldMeasure(_load(), Date.now(), net, force)) return _last;
  _running = true;
  try {
    const tg = _targets();
    const vals = await Promise.all(REGIONS.map((r) => _probe(tg[r])));
    const rtt = {};
    REGIONS.forEach((r, i) => { if (vals[i] != null && vals[i] < 5000) rtt[r] = vals[i]; });
    if (!Object.keys(rtt).length) return null; // offline/péssimo: tenta na próxima
    _last = { ts: Date.now(), rtt, net };
    try { _mm()?.setString(STORE_KEY, JSON.stringify(_last)); } catch {}
    try {
      const { apiCall } = require('./api');
      const res = await apiCall('chat_region_rtt_report', { rtt }, 'POST');
      const t = res && res.data && res.data.targets;
      if (t && typeof t === 'object') { try { _mm()?.setString(TARGETS_KEY, JSON.stringify(t)); } catch {} }
    } catch {}
    if (__DEV__) console.log('[regionRtt] ' + REGIONS.map((r) => r + '=' + (rtt[r] ?? '-')).join(' '));
    return _last;
  } catch { return null; } finally { _running = false; }
}

export function getLastRegionRtt() { return _load(); }

// Liga a medição em 2º plano (idempotente). delayMs = folga após o login/boot.
export function startRegionRtt(delayMs = 20000) {
  if (_started) return;
  _started = true;
  setTimeout(() => { measureAndReport().catch(() => {}); }, delayMs);
  _timer = setInterval(() => { measureAndReport().catch(() => {}); }, 5 * 60 * 1000); // barato: só mede após TTL
  try {
    AppState.addEventListener('change', (s) => { if (s === 'active') measureAndReport().catch(() => {}); });
  } catch {}
  try {
    let prev;
    require('./networkInfo').onNetworkChange((st) => {
      const k = st && st.isConnected !== false ? String(st.type || '') : '';
      if (prev !== undefined && k && k !== prev) setTimeout(() => { measureAndReport({ force: true }).catch(() => {}); }, 4000);
      prev = k;
    });
  } catch {}
}

export function stopRegionRtt() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _started = false;
}

export default { startRegionRtt, stopRegionRtt, measureAndReport, getLastRegionRtt };
