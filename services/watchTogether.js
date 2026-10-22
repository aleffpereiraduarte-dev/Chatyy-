// services/watchTogether.js — [assistir-junto 2026-10-20] "Assistir junto" / "Ouvir junto" (FASE 1).
//
// Estado da sala por conversa (mesmo formato no hub Go /opt/chatyy-ws-go/watch.go e no api/watch.php):
//   {sid, conversation_id, kind: video|music, status: live|ended, item, qi, queue[], playing, pos, rate,
//    server_ts, seq, host, host_name, ctrl_mode: all|host, hold:{by,n,until}|null, viewers[{e,n,at}],
//    by, by_name, cmd, message_id, started_at, delta?}
//   pos vale no instante server_ts; tocando → posição = pos + (agoraServidor - server_ts)/1000 * rate.
//   hold = todos pausados esperando alguém carregar (até `until`, máx. 8 s).
//
// Transporte:
//   • HUB (preferido): frames watch.* pelo WebSocket; resposta/broadcast `watch_state`, erro `watch_error`,
//     relógio por `watch.ping` → `watch_pong`. Detectado com uma sonda watch.state (1,5 s).
//   • HTTP (reserva, funciona já pela OTA): watch_cmd/watch_state/watch_time no email.php → watch.php,
//     que publica `watch_state` no canal chat_user_<membro> (o mesmo evento chega pelo WS que já existe).
//     Enquanto a sala/mini-player está aberta há poll curto (5 s na sala, 20 s na conversa) p/ cobrir perdas.
// Relógio: ping NTP-like (4 amostras, menor RTT; refaz a cada 5 min) → offset = server_ts - (t0 + rtt/2).
// Kill switch OTA: globalThis.__chatyy_watch_together = false (some do "+", cabeçalho, cartão vira texto).
import { Platform, AppState } from 'react-native';
import { makeClock, expectedPosition, PLAY_LEAD } from './watchSync';

const _api = () => require('./api');
const _ws = () => { try { return require('./websocket').default; } catch { return null; } };

export function watchEnabled() {
  try { if (globalThis.__chatyy_watch_together === false) return false; } catch {}
  return Platform.OS !== 'web' || true;
}

// ─── relógio ────────────────────────────────────────────────────────────────
// [sync 22/10] amostras NTP-like (hub: watch_pong; HTTP: watch_time c/ t1/t2) → mediana da metade de menor
// atraso (services/watchSync.makeClock). Rajada de 6 ao entrar/reconectar/voltar ao 1º plano; 1 amostra a
// cada 30 s com sala aberta. Kill: globalThis.__chatyy_watch_sync2 = false → volta à 1 amostra de menor RTT.
const _clock = makeClock();
let _offset = null; // serverNow - Date.now()
let _offsetAt = 0;
let _clockP = null;
function _sync2() { try { return globalThis.__chatyy_watch_sync2 !== false; } catch { return true; } }
export function serverNow() {
  if (_offset !== null && Math.abs(_offset) < 365 * 86400000) return Date.now() + _offset;
  try { const w = _ws(); if (w && typeof w.serverNow === 'function') return w.serverNow(); } catch {}
  return Date.now();
}
export function clockOffset() { return _offset; }
export function clockInfo() { return _clock.estimate(); }

function _hubPing() {
  return new Promise((resolve) => {
    const ws = _ws();
    if (!ws || !ws.isConnected) { resolve(null); return; }
    const t0 = Date.now();
    let done = false;
    const off = ws.on('watch_pong', (d) => {
      const x = (d && d.t0 !== undefined ? d : (d && d.data)) || {};
      if (done || Number(x.t0) !== t0) return;
      done = true; off && off();
      resolve({ t0, t3: Date.now(), ts: Number(x.server_ts) });
    });
    try { ws.send({ type: 'watch.ping', t0 }); } catch {}
    setTimeout(() => { if (!done) { done = true; off && off(); resolve(null); } }, 1500);
  });
}
async function _httpPing() {
  const t0 = Date.now();
  try {
    const r = await _api().apiCall('watch_time', { t0 }, 'GET');
    const t3 = Date.now();
    const d = r && r.data;
    const ts = d && Number(d.server_ts);
    if (!ts) return null;
    return { t0, t3, ts, t1: Number(d.t1) || 0, t2: Number(d.t2) || 0 };
  } catch { return null; }
}
function _applyClock() {
  const o = _clock.offset();
  if (o !== null) { _offset = o; _offsetAt = Date.now(); }
}
/** Uma amostra (hub se disponível, senão HTTP). */
async function _sampleOnce() {
  const x = (_hub === true ? await _hubPing() : null) || await _httpPing();
  if (!x) return false;
  if (!_sync2()) {
    const rtt = x.t3 - x.t0;
    if (_offset === null || rtt <= (_clock.rtt() ?? 1e9)) { _clock.reset(); _clock.add(x); _applyClock(); }
    return true;
  }
  _clock.add(x);
  _applyClock();
  return true;
}
export function syncClock(force = false) {
  if (!force && _offset !== null && Date.now() - _offsetAt < 5 * 60 * 1000) return Promise.resolve(_offset);
  if (_clockP) return _clockP;
  _clockP = (async () => {
    const n = _sync2() ? 6 : 4;
    for (let i = 0; i < n; i++) {
      const ok = await _sampleOnce();
      if (i === 0 && !ok) break;
      if (i < n - 1) await new Promise((r) => setTimeout(r, 60));
    }
    _clockP = null;
    return _offset;
  })();
  return _clockP;
}
/** Amostra solta (manutenção com a sala aberta). */
export function clockTick() { if (!_clockP) _sampleOnce().catch(() => {}); }

// ─── estado ─────────────────────────────────────────────────────────────────
const _sessions = new Map(); // cid → state|null
const _subs = new Map();     // cid → Set(fn)
const _anySubs = new Set();
let _hub = null;             // null = não sabe, true/false
let _hubAt = 0;
let _wsAttached = false;

const _k = (cid) => String(cid || '');

export function getSession(cid) { return _sessions.get(_k(cid)) || null; }
export function isLive(s) { return !!(s && s.status === 'live' && s.item); }
export function liveSession(cid) { const s = getSession(cid); return isLive(s) ? s : null; }

function _emit(cid, s, meta) {
  const set = _subs.get(_k(cid));
  if (set) for (const fn of Array.from(set)) { try { fn(s, meta || {}); } catch {} }
  for (const fn of Array.from(_anySubs)) { try { fn(_k(cid), s, meta || {}); } catch {} }
}
export function subscribe(cid, fn) {
  _attachWs();
  const k = _k(cid);
  if (!_subs.has(k)) _subs.set(k, new Set());
  _subs.get(k).add(fn);
  return () => { const s = _subs.get(k); if (s) { s.delete(fn); if (!s.size) _subs.delete(k); } };
}
/** Ouvinte de qualquer conversa: fn(cid, state, meta). Usado pela lista nativa (cartões ao vivo). */
export function onAnySession(fn) { _attachWs(); _anySubs.add(fn); return () => _anySubs.delete(fn); }

/** Aplica um estado vindo do servidor/hub. Devolve true se trocou. */
export function applyState(cid, s, meta) {
  const k = _k(cid || (s && s.conversation_id));
  if (!k) return false;
  const cur = _sessions.get(k);
  if (s === null) {
    if (cur === null) return false;
    // hub sem sessão na memória não apaga uma sessão ao vivo conhecida (o PHP é quem encerra)
    if (cur && meta && meta.origin === 'hub' && cur.status === 'live') return false;
    _sessions.set(k, null); _emit(k, null, meta); return true;
  }
  if (!s || !s.sid) return false;
  if (cur && cur.sid === s.sid) {
    const ended = s.status !== 'live' && cur.status === 'live';
    if (!ended && Number(s.seq || 0) <= Number(cur.seq || 0) && !(meta && meta.force)) return false;
  } else if (cur && cur.sid !== s.sid && cur.status === 'live' && s.status !== 'live' && Number(s.started_at || 0) < Number(cur.started_at || 0)) {
    return false; // fim de uma sessão ANTIGA não derruba a nova
  }
  const next = { ...s, _rx: Date.now() };
  _sessions.set(k, next);
  _emit(k, next, meta);
  return true;
}

function _attachWs() {
  if (_wsAttached) return;
  const ws = _ws();
  if (!ws) return;
  _wsAttached = true;
  ws.on('watch_state', (d) => {
    const data = d && (d.state !== undefined || d.conversation_id) ? d : (d && d.data) || d;
    if (!data) return;
    if (data.origin === 'hub') { _hub = true; _hubAt = Date.now(); }
    applyState(data.conversation_id || (data.state && data.state.conversation_id), data.state || null, { origin: data.origin, by: data.state && data.state.by, rid: data.rid, reply: !!data.reply });
    if (data.rid) _ackRid(data.rid, true);
  });
  ws.on('watch_error', (d) => {
    const data = (d && d.data) || d || {};
    _hub = true; _hubAt = Date.now();
    if (data.state) applyState(data.conversation_id, data.state, { origin: 'hub', force: true });
    if (data.rid) _ackRid(data.rid, false, data.error);
  });
  // reconectou → pede o estado de novo das salas abertas (o hub não guarda no ws_event_log)
  try {
    ws.on('connection', (e) => {
      if (!e || e.status !== 'authenticated') return;
      _hub = null; // hub pode ter sido trocado (kit aplicado) → sonda de novo
      _resyncOpen('ws');
    });
  } catch {}
  // [sync 22/10] voltou ao 1º plano → relógio (rajada) + estado das salas abertas (o WS pode ter caído)
  try {
    AppState.addEventListener('change', (st) => { if (st === 'active') _resyncOpen('fg'); });
  } catch {}
}
let _resyncAt = 0;
function _resyncOpen(why) {
  if (!_open.size) return;
  const now = Date.now();
  if (now - _resyncAt < 1500) return; // fg + ws juntos
  _resyncAt = now;
  for (const cid of Array.from(_open.keys())) refresh(cid).catch(() => {});
  syncClock(true).then(() => { for (const cid of Array.from(_open.keys())) refresh(cid).catch(() => {}); }).catch(() => {});
}

// ─── transporte ─────────────────────────────────────────────────────────────
const _pendRid = new Map(); // rid → {resolve, timer}
function _ackRid(rid, ok, err) {
  const p = _pendRid.get(rid);
  if (!p) return;
  _pendRid.delete(rid); clearTimeout(p.timer);
  p.resolve({ ok, error: err || null });
}
let _ridN = 0;
function _rid() { _ridN = (_ridN + 1) % 1e9; return Date.now().toString(36) + '.' + _ridN.toString(36); }

function _hubSend(frame, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const ws = _ws();
    if (!ws || !ws.isConnected) { resolve({ ok: false, error: 'offline', timeout: true }); return; }
    const rid = _rid();
    const timer = setTimeout(() => { _pendRid.delete(rid); resolve({ ok: false, error: 'timeout', timeout: true }); }, timeoutMs);
    _pendRid.set(rid, { resolve, timer });
    try { ws.send({ ...frame, rid }); } catch { clearTimeout(timer); _pendRid.delete(rid); resolve({ ok: false, error: 'send', timeout: true }); }
  });
}

/**
 * Hub entende watch.*? Nunca bloqueia o comando: devolve o que já se sabe e, se o palpite está velho
 * (sim: 10 min · não: 2 min), sonda em 2º plano com um watch.state (1,5 s).
 */
let _probeP = null;
function _hubReady(cid) {
  try { if (globalThis.__chatyy_watch_hub === false) return false; } catch {}
  const stale = _hub === null || Date.now() - _hubAt > (_hub ? 10 : 2) * 60 * 1000;
  if (stale && !_probeP && cid) {
    _probeP = _hubSend({ type: 'watch.state', conversation_id: Number(cid) }, 1500)
      .then((r) => { _hub = !r.timeout; _hubAt = Date.now(); })
      .catch(() => {})
      .then(() => { _probeP = null; });
  }
  return _hub === true;
}

export async function refresh(cid) {
  if (!cid) return null;
  _attachWs();
  // o HTTP é a verdade durável (cartão, início/fim); o hub responde pela memória quando ligado
  if (_hubReady(cid)) {
    const cur = getSession(cid);
    const r = await _hubSend({ type: 'watch.state', conversation_id: Number(cid), sid: (cur && cur.sid) || '' }, 1500);
    if (r.ok) { const s = getSession(cid); if (s || cur === null) return s; }
  }
  try {
    const r = await _api().apiCall('watch_state', { conversation_id: cid }, 'GET');
    if (r && r.success && r.data) {
      applyState(cid, r.data.session || null, { origin: 'http', force: !!(r.data.session && getSession(cid) && getSession(cid).status !== (r.data.session.status)) });
      return getSession(cid);
    }
  } catch {}
  return getSession(cid);
}

export async function catalog(params) {
  try {
    const r = await _api().apiCall('watch_catalog', params || {}, 'POST');
    if (r && r.success && r.data) return r.data;
    return { error: (r && (r.message || (r.data && r.data.error))) || 'error', items: [] };
  } catch (e) { return { error: 'network', items: [] }; }
}

export async function start(cid, kind, item, queue) {
  _attachWs();
  try {
    const cur = getSession(cid);
    const r = await _api().apiCall('watch_start', { conversation_id: cid, kind: kind === 'music' ? 'music' : 'video', item, queue: queue || [], base_seq: (cur && cur.seq) || 0 }, 'POST');
    if (r && r.success && r.data && r.data.session) { applyState(cid, r.data.session, { origin: 'http', force: true }); return { ok: true, session: r.data.session, created: !!r.data.created }; }
    return { ok: false, error: (r && r.data && r.data.error) || (r && r.message) || 'error' };
  } catch { return { ok: false, error: 'network' }; }
}

/** Aplica localmente (otimista) o efeito do comando — o eco do servidor (seq maior) confirma/corrige. */
function _optimistic(cid, cmd, args) {
  const s = getSession(cid);
  if (!isLive(s)) return;
  const now = serverNow();
  const n = { ...s };
  const pos = args && typeof args.pos === 'number' ? args.pos : positionAt(s, now);
  if (cmd === 'play') { n.pos = pos; n.playing = true; n.hold = null; }
  else if (cmd === 'pause') { n.pos = pos; n.playing = false; n.hold = null; }
  else if (cmd === 'seek') { n.pos = pos; n.hold = null; }
  else return;
  // [sync 22/10] o hub carimba quando o comando CHEGA (≈ meia ida depois) → o otimista já mira esse carimbo,
  // senão quem mandou fica adiantado meia ida em relação aos outros quando o eco chega
  const half = _sync2() ? Math.min(400, Math.max(0, (_clock.rtt() || 0) / 2)) : 0;
  n.server_ts = now + half; n.by = (args && args._me) || n.by; n.cmd = cmd; n._local = true;
  _sessions.set(_k(cid), n);
  _emit(cid, n, { origin: 'local' });
}

/**
 * Comando da sala. cmd: play|pause|seek|next|prev|pick|queue_add|queue_remove|ctrl|buffer|ready|join|leave|end.
 * args: {pos, item, index, mode, from_item, delta}. Resolve {ok, error}.
 */
export async function cmd(cid, name, args = {}) {
  const s = getSession(cid);
  if (!s && name !== 'end') return { ok: false, error: 'no_session' };
  _optimistic(cid, name, args);
  const payload = { conversation_id: Number(cid), sid: (s && s.sid) || '', ...args };
  delete payload._me;
  // início/fim mexem no cartão da conversa → sempre HTTP
  if (name !== 'end' && _hubReady(cid)) {
    const r = await _hubSend({ type: 'watch.' + name, ...payload });
    if (!r.timeout) {
      if (!r.ok && r.error === 'no_session') { /* hub perdeu a memória: segue p/ HTTP */ }
      else return r;
    } else { _hub = false; _hubAt = Date.now(); }
  }
  try {
    const r = await _api().apiCall(name === 'end' ? 'watch_end' : 'watch_cmd', { ...payload, cmd: name, base_seq: (s && s.seq) || 0 }, 'POST');
    const ses = r && r.data && r.data.session;
    if (ses) applyState(cid, ses, { origin: 'http', force: !(r && r.success) });
    if (r && r.success) return { ok: true };
    return { ok: false, error: (r && r.data && r.data.error) || (r && r.message) || 'error' };
  } catch { return { ok: false, error: 'network' }; }
}

// ─── posição ────────────────────────────────────────────────────────────────
/** Posição (s) do estado no instante (ms de servidor) `at`. */
export function positionAt(s, at) { return expectedPosition(s, at); }
export function positionNow(s) { return positionAt(s, serverNow()); }
/** [sync 22/10] posição p/ mandar no "play": um pouco antes de onde parou → todos começam juntos (partida agendada). */
export function playPos(s) { const p = positionNow(s); return _sync2() ? Math.max(0, p - PLAY_LEAD) : p; }
export function isHeld(s) { return !!(s && s.playing && s.hold && Number(s.hold.until) > serverNow()); }
export function canControl(s, me) {
  if (!s) return false;
  if (s.ctrl_mode !== 'host') return true;
  return String(s.host || '').toLowerCase() === String(me || '').toLowerCase();
}

// ─── sala aberta (heartbeat + poll) ─────────────────────────────────────────
const _open = new Map(); // cid → {room: n, conv: n, timer, hb}
function _tick(cid) {
  const o = _open.get(_k(cid));
  if (!o) return;
  const room = o.room > 0;
  const s = getSession(cid);
  // só faz poll HTTP quando o hub não está servindo (com hub, o WS basta)
  const needPoll = _hub !== true && (room || isLive(s));
  if (needPoll) refresh(cid).catch(() => {});
  if (room && isLive(s) && Date.now() - (o.hbAt || 0) > 45000) { o.hbAt = Date.now(); cmd(cid, 'join').catch(() => {}); }
  if (room && isLive(s) && Date.now() - (o.clkAt || 0) > 30000) { o.clkAt = Date.now(); clockTick(); }
  clearTimeout(o.timer);
  o.timer = setTimeout(() => _tick(cid), room ? 5000 : 20000);
}
/** Conversa aberta: mantém o mini-player em dia. Devolve a função de saída. */
export function watchConversation(cid) {
  if (!cid) return () => {};
  _attachWs();
  const k = _k(cid);
  const o = _open.get(k) || { room: 0, conv: 0 };
  o.conv++;
  _open.set(k, o);
  if (o.conv === 1 && o.room === 0) { refresh(cid).catch(() => {}); clearTimeout(o.timer); o.timer = setTimeout(() => _tick(cid), 20000); }
  return () => { o.conv = Math.max(0, o.conv - 1); if (!o.conv && !o.room) { clearTimeout(o.timer); _open.delete(k); } };
}
/** Sala aberta (tela cheia): entra (join), heartbeat 45 s, poll 5 s. Devolve a função de saída. */
export function enterRoom(cid) {
  if (!cid) return () => {};
  _attachWs();
  const k = _k(cid);
  const o = _open.get(k) || { room: 0, conv: 0 };
  o.room++;
  _open.set(k, o);
  syncClock(o.room === 1).catch(() => {}); // [sync 22/10] entrou na sala → rajada nova
  o.hbAt = Date.now(); o.clkAt = Date.now();
  if (isLive(getSession(cid))) cmd(cid, 'join').catch(() => {});
  clearTimeout(o.timer);
  o.timer = setTimeout(() => _tick(cid), 3000);
  return () => {
    o.room = Math.max(0, o.room - 1);
    if (!o.room) {
      if (isLive(getSession(cid))) cmd(cid, 'leave').catch(() => {});
      clearTimeout(o.timer);
      if (!o.conv) _open.delete(k);
      else o.timer = setTimeout(() => _tick(cid), 20000);
    }
  };
}

// ─── textos ─────────────────────────────────────────────────────────────────
export function tr(t, k, fb, vars) {
  let s = fb;
  try { const v = t ? t(k) : null; if (typeof v === 'string' && v && v !== k) s = v; } catch {}
  if (vars && typeof s === 'string') Object.keys(vars).forEach((x) => { s = s.split('{' + x + '}').join(String(vars[x])); });
  return s;
}
export function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(x).padStart(2, '0');
}
export function parseWatchContent(c) {
  if (c && typeof c === 'object') return c.kind === 'watch' ? c : null;
  if (typeof c !== 'string') return null;
  const s = c.trim();
  if (!s.startsWith('{')) return null;
  try { const j = JSON.parse(s); return j && j.kind === 'watch' && j.sid ? j : null; } catch { return null; }
}
/** Rótulo da licença/fonte (sempre visível). */
export function licenseLabel(t, it) {
  if (!it) return '';
  const src = it.source;
  if (src === 'conv') return tr(t, 'watch.src.conv', 'Da conversa');
  if (it.lic === 'public_domain' || src === 'pd') return tr(t, 'watch.src.pd', 'Domínio público');
  if (it.lic) return it.lic;
  return tr(t, 'watch.src.cc', 'Creative Commons');
}
export function sourceLabel(t, it) {
  if (!it) return '';
  if (it.source === 'jamendo') return 'Jamendo · ' + (it.lic || 'CC');
  return licenseLabel(t, it);
}
export function previewText(t, content) {
  const j = parseWatchContent(content);
  if (!j) return '';
  const k = j.mode === 'music' ? 'watch.preview.music' : 'watch.preview.video';
  return tr(t, k, j.mode === 'music' ? 'Ouvir junto: {title}' : 'Assistir junto: {title}', { title: j.title || '' });
}
export function viewersOf(s) {
  const now = serverNow();
  return (s && Array.isArray(s.viewers) ? s.viewers : []).filter((v) => v && now - Number(v.at || 0) <= 90000);
}

// ─── ícones da barra nativa do "+" (OTA, sem build) ─────────────────────────
// Folha nativa (expo-chat-attach) e painel do composer (iOS) têm mapa FIXO chave→ícone; chaves novas
// caíam na grade 2x2. Até o build com o mapa novo, as chaves vão "fantasiadas" de chaves que o binário
// já desenha (filme / nota musical) e voltam ao nome real em handlePickAttachment.
// 'short_video' e 'music' não existem mais no "+" (attach-enxuto 20/10), então não há colisão.
// Kill: globalThis.__chatyy_watch_icon_alias = false (manda as chaves reais).
const _ICON_ALIAS = { watch_together: 'short_video', listen_together: 'music' };
const _ICON_UNALIAS = { short_video: 'watch_together', music: 'listen_together' };
function _aliasOn() { try { return globalThis.__chatyy_watch_icon_alias !== false; } catch { return true; } }
export function attachAliasKey(key) { return _aliasOn() && _ICON_ALIAS[key] ? _ICON_ALIAS[key] : key; }
export function attachUnaliasKey(key) { return _aliasOn() && _ICON_UNALIAS[key] ? _ICON_UNALIAS[key] : key; }

// ─── fase 2 (20/10): reações, fila arrastável, letra, chamada (PiP + "abaixa o som quando falam") ───
const _reactSubs = new Map(); // cid → Set(fn)
let _reactAttached = false;
function _attachReact() {
  if (_reactAttached) return;
  const ws = _ws();
  if (!ws) return;
  _reactAttached = true;
  ws.on('watch_react', (d) => {
    const data = (d && d.r ? d : (d && d.data)) || {};
    const set = _reactSubs.get(_k(data.conversation_id));
    if (set) for (const fn of Array.from(set)) { try { fn(data); } catch {} }
  });
}
/** Reações flutuantes da sala: fn({e, n, r, pos, ts}). */
export function onReact(cid, fn) {
  _attachReact();
  const k = _k(cid);
  if (!_reactSubs.has(k)) _reactSubs.set(k, new Set());
  _reactSubs.get(k).add(fn);
  return () => { const s = _reactSubs.get(k); if (s) { s.delete(fn); if (!s.size) _reactSubs.delete(k); } };
}
/** Manda uma reação (heart|laugh|fire|wow). Sempre HTTP (o hub só cuida do estado). */
export async function react(cid, r, pos) {
  const s = getSession(cid);
  if (!isLive(s)) return { ok: false };
  try {
    const x = await _api().apiCall('watch_cmd', { conversation_id: cid, sid: s.sid, cmd: 'react', r, pos }, 'POST');
    return { ok: !!(x && x.success) };
  } catch { return { ok: false }; }
}
/** Reordena a fila (arrastar). HTTP: o PHP grava e publica; o hub adota pelo /broadcast. */
export async function queueMove(cid, from, to) {
  const s = getSession(cid);
  if (!isLive(s) || from === to) return { ok: false };
  // otimista: a lista já aparece na ordem nova
  const q = [...(s.queue || [])];
  const cur = q[s.qi];
  const [mv] = q.splice(from, 1); q.splice(to, 0, mv);
  const n = { ...s, queue: q, qi: Math.max(0, q.indexOf(cur)) };
  _sessions.set(_k(cid), n); _emit(cid, n, { origin: 'local' });
  try {
    const r = await _api().apiCall('watch_cmd', { conversation_id: cid, sid: s.sid, cmd: 'queue_move', from, to, base_seq: s.seq || 0 }, 'POST');
    const ses = r && r.data && r.data.session;
    if (ses) applyState(cid, ses, { origin: 'http', force: true });
    return { ok: !!(r && r.success), error: r && r.data && r.data.error };
  } catch { refresh(cid).catch(() => {}); return { ok: false }; }
}
const _lyr = new Map();
export async function lyrics(itemId) {
  if (!/^jm-\d+$/.test(String(itemId || ''))) return '';
  if (_lyr.has(itemId)) return _lyr.get(itemId);
  try {
    const r = await _api().apiCall('watch_lyrics', { id: itemId }, 'GET');
    const v = (r && r.success && r.data && r.data.lyrics) || '';
    _lyr.set(itemId, v);
    return v;
  } catch { return ''; }
}

// chamada: alguém falando (app/call.js → ActiveSpeakersChanged) e janela flutuante (PiP)
let _speaking = false;
const _speakSubs = new Set();
export function setCallSpeaking(v) {
  const b = !!v;
  if (b === _speaking) return;
  _speaking = b;
  for (const fn of Array.from(_speakSubs)) { try { fn(b); } catch {} }
}
export function isCallSpeaking() { return _speaking; }
export function onCallSpeaking(fn) { _speakSubs.add(fn); return () => _speakSubs.delete(fn); }
export function inCall() {
  try {
    if (globalThis.__chatyyNativeCallActive) return true;
    const cs = require('./callState');
    const st = cs.getCallState && cs.getCallState();
    return st === 'active' || st === 'answered';
  } catch { return false; }
}
let _pip = null; // {cid, name}
const _pipSubs = new Set();
export function setPip(v) {
  _pip = v && v.cid ? { cid: String(v.cid), name: v.name || '' } : null;
  for (const fn of Array.from(_pipSubs)) { try { fn(_pip); } catch {} }
}
export function getPip() { return _pip; }
export function onPip(fn) { _pipSubs.add(fn); return () => _pipSubs.delete(fn); }
/** iOS sem o patch do expo-video: tocar durante ligação derrubaria o áudio da chamada (ver WatchPlayer/README do kit). */
export function callPlaybackBlocked() {
  try {
    const { Platform: P } = require('react-native');
    if (P.OS === 'android') return globalThis.__chatyy_watch_call_android === false;
    if (P.OS !== 'ios') return false;
    return globalThis.__chatyy_watch_call_ios !== true;
  } catch { return true; }
}

// "Ouvir junto" fora da sala (2º plano / outras telas): o player vive no WatchAudioHost (raiz do app)
let _listen = null; // cid ouvindo
const _listenSubs = new Set();
export function setListening(cid) {
  const v = cid ? String(cid) : null;
  if (v === _listen) return;
  _listen = v;
  for (const fn of Array.from(_listenSubs)) { try { fn(v); } catch {} }
}
export function getListening() { return _listen; }
export function onListening(fn) { _listenSubs.add(fn); return () => _listenSubs.delete(fn); }
const _syncSt = new Map();
const _syncSubs = new Set();
export function setSyncStatus(cid, st) { _syncSt.set(_k(cid), st); for (const fn of Array.from(_syncSubs)) { try { fn(_k(cid), st); } catch {} } }
export function getSyncStatus(cid) { return _syncSt.get(_k(cid)) || null; }
export function onSyncStatus(fn) { _syncSubs.add(fn); return () => _syncSubs.delete(fn); }
