// [rcpt-bg 2026-10-24] Recibos ✓✓ (entregue) / ✓✓ azul (lido) certos NA HORA ao abrir o app — nível WhatsApp.
//
// Antes: com o app em 2º plano/fechado o remetente só via o ✓✓/azul depois de o WS reconectar e o `resume`
// reentregar os eventos (medido 24/10 via edge BR: auth 1,4-3 s + 0,6-1,5 s de replay; com 40 eventos na fila,
// 1,45 s depois do auth) ou do chat_list voltar (0,3-1,6 s, 20 KB). Até lá a lista/conversa pintavam o cache
// velho (✓ cinza).
//
// Agora, ao abrir / voltar ao 1º plano (ordem):
//   1. PISO do aparelho: o que o push silencioso `chat_rcpt` / a carona da NSE gravaram no store nativo em 2º
//      plano (ChatyyChatStore.rcptBgSeedSync, BUILD) → services/peerReadLive (o mesmo piso que a lista e a
//      conversa já aplicam a todo snapshot). Síncrono, antes da 1ª pintura do JS.
//   2. CATCH-UP em 1 ida: GET chat_ws_events&rcpt=1&since=<cursor próprio> (servidor rcpt-bg.php; edge local,
//      ~70 ms no servidor) → por (conversa, quem) o maior id entregue/lido → os MESMOS eventos chat_delivered /
//      chat_read do WS (mailWs._emit: lista, conversa aberta, piso global) + store nativo (foto da conversa/home).
//      Não mexe no _lastEventId do resume (cursor separado) → o WS continua de onde estava, sem duplicar/pular.
// `rcptReady(ms)` = promessa do 1º catch-up (quem abre uma conversa pode esperar até ms antes de pintar).
//
// Flag por conta no SERVIDOR (allowlist /var/mail/.chatyy-rcpt-bg/allow): fora dela → 410 → para na sessão.
// Kill OTA: globalThis.__chatyy_rcpt_bg = false.
import { AppState, Platform } from 'react-native';

const CURSOR_KEY = '@chatyy_rcpt_cursor_v1:';
const MIN_GAP_MS = 3000;
const BG_MIN_MS = 4000;
const REQ_TIMEOUT_MS = 8000;

let _started = false;
let _disabled = false;
let _inflight = null;
let _lastRunAt = 0;
let _bgAt = 0;
let _firstDone = false;
let _readyResolve = null;
let _ready = new Promise((r) => { _readyResolve = r; });
let _stats = { runs: 0, items: 0, lastMs: -1, seeded: 0, last: '' };

function _ws() { try { return require('./websocket').default; } catch { return null; } }
function _api() { try { return require('./api'); } catch { return null; } }
function _AS() { try { return require('@react-native-async-storage/async-storage').default; } catch { return null; } }
function _killed() { try { return globalThis.__chatyy_rcpt_bg === false; } catch { return false; } }
function _beacon(step, info) { try { require('./crashReporter').reportStep?.(step, info); } catch {} }

let _nm;
function _native() {
  if (_nm !== undefined) return _nm;
  _nm = null;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return _nm;
  try {
    const expo = require('expo');
    _nm = (typeof expo.requireOptionalNativeModule === 'function' && expo.requireOptionalNativeModule('ChatyyChatStore')) || null;
  } catch { _nm = null; }
  return _nm;
}

function _me() {
  try {
    const w = _ws();
    const a = _api();
    const e = (w && w.email) || (a && a.getActiveAccountEmail && a.getActiveAccountEmail()) || (a && a.getSavedEmail && a.getSavedEmail()) || '';
    return String(e || '').trim().toLowerCase();
  } catch { return ''; }
}

function _token() { try { return _api()?.getAuthToken?.() || ''; } catch { return ''; } }

function _markReady() {
  if (_firstDone) return;
  _firstDone = true;
  try { _readyResolve && _readyResolve(); } catch {}
}

/** Promessa do 1º catch-up desta sessão, com teto (nunca segura a tela). */
export function rcptReady(maxMs = 600) {
  if (_firstDone || _disabled || _killed()) return Promise.resolve();
  return Promise.race([_ready, new Promise((r) => setTimeout(r, Math.max(0, maxMs)))]);
}

export function rcptCatchupStats() { return { ..._stats, disabled: _disabled }; }

/** 1. Piso do que o nativo gravou em 2º plano (binário sem a função = no-op). */
function _seedFromNative(me) {
  const m = _native();
  if (!m || typeof m.rcptBgSeedSync !== 'function' || !me) return 0;
  let raw = '';
  try { raw = m.rcptBgSeedSync(me) || ''; } catch { return 0; }
  if (!raw) return 0;
  let obj = null;
  try { obj = JSON.parse(raw); } catch { return 0; }
  if (!obj || typeof obj !== 'object') return 0;
  let n = 0;
  try {
    const PRL = require('./peerReadLive');
    for (const conv of Object.keys(obj)) {
      const v = obj[conv];
      if (!Array.isArray(v)) continue;
      const d = Number(v[0]) || 0;
      const r = Number(v[1]) || 0;
      // ator "~peer": o push só leva DM / grupo de 2 → qualquer peer = o peer
      if (r > 0 && PRL.notePeerReadLive) PRL.notePeerReadLive(me, conv, '~peer', r);
      if (d > 0 && PRL.notePeerDeliveredLive) PRL.notePeerDeliveredLive(me, conv, '~peer', d);
      n += 1;
    }
  } catch {}
  _stats.seeded += n;
  return n;
}

async function _getCursor(me) {
  const AS = _AS();
  if (!AS) return 0;
  try { return Number(await AS.getItem(CURSOR_KEY + me)) || 0; } catch { return 0; }
}

async function _setCursor(me, c) {
  const AS = _AS();
  if (!AS || !(c > 0)) return;
  try { await AS.setItem(CURSOR_KEY + me, String(c)); } catch {}
}

async function _fetchJson(url, headers) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const to = setTimeout(() => { try { ctl && ctl.abort(); } catch {} }, REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: ctl ? ctl.signal : undefined });
    let body = null;
    try { body = await res.json(); } catch {}
    return { status: res.status, body };
  } finally { clearTimeout(to); }
}

/** 2. Catch-up em 1 ida. Aplica pelos mesmos eventos do WS. */
async function _catchup(reason) {
  const me = _me();
  const tok = _token();
  const api = _api();
  if (!me || !tok || !api) return { skipped: 'noauth' };
  const base = (api.getRealtimeHttpBase && api.getRealtimeHttpBase()) || (api.getOriginBase && api.getOriginBase()) || 'https://chatyy.com.br';
  const since = await _getCursor(me);
  const headers = (api.getAuthHeaders && api.getAuthHeaders()) || {};
  if (!headers.Authorization) headers.Authorization = `Bearer ${tok}`;
  const t0 = Date.now();
  const { status, body } = await _fetchJson(`${base}/api/email.php?action=chat_ws_events&rcpt=1&since=${since}`, headers);
  const ms = Date.now() - t0;
  if (status === 410) { _disabled = true; return { disabled: true }; }
  const data = body && body.success ? body.data : null;
  if (!data || !Array.isArray(data.items)) return { error: 'http_' + status, ms };
  const w = _ws();
  const frames = [];
  const nowIso = new Date().toISOString();
  for (const it of data.items) {
    const c = Number(it && it.c);
    const e = String((it && it.e) || '').toLowerCase();
    if (!(c > 0) || !e || e === me) continue;
    const d = Number(it.d) || 0;
    const r = Number(it.r) || 0;
    if (d > 0) {
      const ids = Array.isArray(it.ids) && it.ids.length ? it.ids.map(Number).filter((x) => x > 0) : [d];
      const dp = { conversation_id: c, email: e, message_id: d, message_ids: ids, delivered_at: nowIso, rcpt_catchup: 1 };
      try { w && w._emit && w._emit('chat_delivered', dp); } catch {}
      frames.push(JSON.stringify({ type: 'chat_delivered', data: dp }));
    }
    if (r > 0) {
      const rp = { conversation_id: c, email: e, last_read_id: r, rcpt_catchup: 1 };
      try { w && w._emit && w._emit('chat_read', rp); } catch {}
      frames.push(JSON.stringify({ type: 'chat_read', data: rp }));
    }
  }
  // store nativo (foto da conversa + da home certas no próximo cold start)
  if (frames.length) {
    const m = _native();
    if (m && typeof m.ingestFramesAsync === 'function') { try { m.ingestFramesAsync(me, frames).catch(() => {}); } catch {} }
  }
  await _setCursor(me, Number(data.cursor) || 0);
  _stats.runs += 1;
  _stats.items += data.items.length;
  _stats.lastMs = ms;
  _stats.last = reason;
  return { n: data.items.length, ms, srvMs: data.ms, edge: data.edge };
}

/** Roda seed + catch-up (com trava e intervalo mínimo). */
export function runRcptCatchup(reason = 'manual') {
  if (_disabled || _killed()) { _markReady(); return Promise.resolve({ skipped: 'off' }); }
  if (_inflight) return _inflight;
  const now = Date.now();
  if (now - _lastRunAt < MIN_GAP_MS) return Promise.resolve({ skipped: 'gap' });
  _lastRunAt = now;
  const me = _me();
  const seeded = _seedFromNative(me);
  _inflight = _catchup(reason)
    .then((r) => {
      if (reason === 'boot' || reason === 'fg') _beacon('rcpt_catchup', `${reason} seed=${seeded} n=${r && r.n != null ? r.n : '-'} ms=${r && r.ms != null ? r.ms : '-'}${r && r.disabled ? ' off' : ''}${r && r.error ? ' ' + r.error : ''}`);
      return r;
    })
    .catch((e) => ({ error: String((e && e.message) || e) }))
    .finally(() => { _inflight = null; _markReady(); });
  return _inflight;
}

/** Idempotente. Chamado cedo no boot (components/chatlist/nativeAdapter.js carrega com a lista). */
export function ensureRcptCatchup() {
  if (_started || Platform.OS === 'web') return;
  _started = true;
  // boot: espera o token (login restaurado) por até ~10 s
  let tries = 0;
  const boot = () => {
    if (_disabled || _killed()) { _markReady(); return; }
    if (_token() && _me()) { runRcptCatchup('boot'); return; }
    if (++tries < 34) setTimeout(boot, 300); else _markReady();
  };
  setTimeout(boot, 0);
  try {
    AppState.addEventListener('change', (st) => {
      if (st === 'background' || st === 'inactive') { if (!_bgAt) _bgAt = Date.now(); return; }
      if (st !== 'active') return;
      const away = _bgAt ? Date.now() - _bgAt : 0;
      _bgAt = 0;
      if (away < BG_MIN_MS) return;
      _firstDone = false;
      _ready = new Promise((r) => { _readyResolve = r; });
      runRcptCatchup('fg');
    });
  } catch {}
}
