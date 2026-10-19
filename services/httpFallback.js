// [2026-10-19 http-fallback] Transporte HTTP de RESERVA do realtime + detector de
// enlace degradado + telemetria de "tempo até conectar".
//
// Por quê (founder 19/10, Wi-Fi de avião): RTT 600-1500 ms com perda; o WebSocket
// leva 2-9 s p/ autenticar (TLS + upgrade + auth = 4-5 RTT) e cai depois de poucos
// segundos (hub: sockets de 1,5-26 s, "1006 unexpected EOF"), enquanto o HTTP pelo
// Cloudflare (h2/h3, keep-alive, TLS perto da estação terrestre) segue funcionando.
// Resultado: "Conectando…" em toda abertura mesmo com o HTTP respondendo.
//
// O que faz:
//   1. WS fora (não autenticado) por > GRACE_MS (0 em enlace degradado), app em 1º
//      plano e rede do SO de pé → short-poll de GET chat_ws_events na ORIGEM US
//      (espelho HTTP do `resume` do hub: ws_event_log do usuário, id > cursor). Os
//      frames entram no MESMO mailWs._handleMessage do WebSocket (cursor
//      _lastEventId compartilhado → o resume do WS continua de onde o HTTP parou).
//      Intervalo adaptativo (3 s com eventos/degradado, 8 s ocioso, ±15 %, backoff
//      em falha até 20 s; o servidor pode impor um piso via `poll_ms`). WS autenticou → para (o resume do WS assume).
//   2. Saúde HTTP → services/syncStatus.js: com o HTTP respondendo o título NÃO diz
//      "Conectando…" (o app está conectado, só que por HTTP); com a 1ª requisição
//      ainda em voo (< PENDING_SUPPRESS_MS) também não.
//   3. Enlace degradado (handshake WS lento, quedas curtas repetidas, RTT HTTP
//      alto): websocket.js usa prazos generosos (handshake 20 s, auth 15 s) e o
//      HTTP entra sem carência. Persistido 30 min por tipo de rede. Limpa sozinho
//      depois de 3 min de WS estável com handshake rápido.
//   4. Telemetria (push_diag do aparelho): `net_mode` (troca ws/http/down com
//      motivo, RTT, handshake, rede) e `ws_ttc` (por volta ao 1º plano / boot:
//      ms até o WS autenticar e até o 1º HTTP ok, quanto tempo o "Conectando"
//      ficou visível, rede, transporte).
//
// Kill switches (OTA): globalThis.__chatyy_http_fallback = false (tudo) ·
// __chatyy_link_degraded_off = true (detector) · servidor: CHAT_WS_EVENTS_HTTP=0.
import { AppState, Platform } from 'react-native';

const GRACE_MS = 1500;
const POLL_FAST_MS = 3000;
const POLL_IDLE_MS = 8000;
const POLL_FAIL_MAX_MS = 20000;
const HEALTHY_FOR_MS = 15000;
const PENDING_SUPPRESS_MS = 8000;
const REQ_TIMEOUT_MS = 15000;
const REQ_TIMEOUT_DEGRADED_MS = 25000;
const MAX_PAGES = 3;
const EVENTS_HOT_MS = 30000;

const HS_SLOW_MS = 4000;
const HS_GOOD_MS = 2500;
const SHORT_LIFE_MS = 30000;
const DROPS_WINDOW_MS = 3 * 60 * 1000;
const DROPS_DEGRADED = 2;
const HTTP_RTT_DEGRADED_MS = 1500;
const SRTT_DEGRADED_MS = 700;
const DEGRADED_TTL_MS = 30 * 60 * 1000;
const DEGRADED_CLEAR_STABLE_MS = 3 * 60 * 1000;
const DEG_KEY = 'chatyy_link_degraded_v1';

const TTC_MAX_MS = 30000;
const TTC_KEPT_MS = 3000;

let _started = false;
let _startedAt = 0;
let _disabled = false;       // 410 do servidor → desliga nesta sessão
let _authFail = false;       // 401 → espera o WS/login resolver
let _authFailTok = '';
let _appActive = true;
let _netOnline = true;
let _netType = 'unknown';

let _wsAuthedAt = 0;
let _wsDownSince = 0;
let _drops = [];
let _lastHsMs = -1;
let _lastHsTransport = '';

let _timer = null;
let _inflightAt = 0;
let _firstTryAt = 0;         // 1ª tentativa HTTP desde que o WS caiu
let _lastPollAt = 0;
let _lastOkAt = 0;
let _lastFailAt = 0;
let _failStreak = 0;
let _lastEventAt = 0;
let _rttEwma = 0;
let _srvMinMs = 0;            // piso de intervalo ditado pelo servidor (poll_ms)
let _rttSamples = 0;
let _lastRtt = 0;
let _polls = 0;
let _okPolls = 0;
let _eventsIn = 0;

let _degraded = null;        // { reason, at, net }
let _clearTimer = null;

let _mode = 'none';          // 'ws' | 'http' | 'down' | 'none'
let _modeSince = Date.now();
let _modeBeaconAt = {};

let _ttc = null;             // medição da volta ao 1º plano em curso
let _lastResume = null;      // [bg-grace] último evento 'resume' do nativo v6 {at, kept, probeMs, reason, grace}
let _uiKind = 'idle';
let _uiSince = 0;

const _listeners = new Set();

function _now() { return Date.now(); }
function _off() { try { return globalThis.__chatyy_http_fallback === false; } catch { return false; } }
function _degOff() { try { return globalThis.__chatyy_link_degraded_off === true; } catch { return false; } }
function _ws() { try { return require('./websocket').default; } catch { return null; } }
function _api() { try { return require('./api'); } catch { return null; } }
function _token() { try { return _api()?.getAuthToken?.() || ''; } catch { return ''; } }
function _wsAuthed() { try { return !!(_ws()?.authenticated); } catch { return false; } }

function _emitChange() {
  _listeners.forEach((fn) => { try { fn(); } catch {} });
}

function _beacon(step, info) {
  try { require('./crashReporter').reportStep?.(step, info); } catch {}
}

function _netDesc() {
  try {
    const ni = require('./networkInfo');
    const st = ni.getNetworkState?.() || {};
    const t = ni.getNetworkType?.() || 'unknown';
    const g = st.cellularGeneration ? '/' + st.cellularGeneration : '';
    return t + g;
  } catch { return 'unknown'; }
}

function _srtt() { try { return require('./networkInfo').getSrtt?.() || 0; } catch { return 0; } }

function _transportDesc() {
  try {
    const w = _ws();
    const k = w?.transportKind || '-';
    let reg = '-';
    try { reg = _api()?.getEdgeInfo?.()?.region || 'us'; } catch {}
    return `${k}@${reg}`;
  } catch { return '-'; }
}

// ─── degradado ────────────────────────────────────────────────────────────

function _loadDegraded() {
  try {
    const raw = require('./mmkv').getString(DEG_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d && d.at && (_now() - d.at) < DEGRADED_TTL_MS && (!d.net || d.net === _netType)) _degraded = d;
  } catch {}
}

function _saveDegraded() {
  try { require('./mmkv').setString(DEG_KEY, _degraded ? JSON.stringify(_degraded) : ''); } catch {}
}

function _markDegraded(reason) {
  if (_degOff()) return;
  const was = !!_degraded;
  _degraded = { reason, at: _now(), net: _netType };
  _saveDegraded();
  if (!was) {
    _beacon('net_degraded', `on reason=${reason} hs=${_lastHsMs} hrtt=${Math.round(_rttEwma)} srtt=${_srtt()} drops=${_drops.length} net=${_netDesc()} tr=${_transportDesc()}`);
    _emitChange();
    // Socket preso num handshake com prazo curto → o próximo já usa o generoso.
    _arm();
  }
}

function _clearDegraded(why) {
  if (!_degraded) return;
  const r = _degraded.reason;
  _degraded = null;
  _saveDegraded();
  _beacon('net_degraded', `off was=${r} why=${why} hs=${_lastHsMs} hrtt=${Math.round(_rttEwma)} net=${_netDesc()}`);
  _emitChange();
}

function _armClearCheck() {
  if (_clearTimer) { clearTimeout(_clearTimer); _clearTimer = null; }
  if (!_degraded) return;
  const since = _wsAuthedAt;
  _clearTimer = setTimeout(() => {
    _clearTimer = null;
    if (_degraded && _wsAuthedAt === since && _wsAuthed() && _lastHsMs >= 0 && _lastHsMs < HS_GOOD_MS && _rttEwma < HTTP_RTT_DEGRADED_MS) {
      _clearDegraded('ws_stable');
    }
  }, DEGRADED_CLEAR_STABLE_MS);
}

// ─── modo + telemetria ────────────────────────────────────────────────────

function _setMode(m, why) {
  if (m === _mode) return;
  const prev = _mode;
  const dur = _now() - _modeSince;
  _mode = m;
  _modeSince = _now();
  _emitChange();
  // 'ws' é o normal: só reporta a volta ao WS quando vinha de http/down.
  if (m === 'ws' && prev === 'none') return;
  const t = _now();
  if (_modeBeaconAt[m] && t - _modeBeaconAt[m] < 20000) return;
  _modeBeaconAt[m] = t;
  _beacon('net_mode', `mode=${m} prev=${prev} prevMs=${dur} why=${why || '-'} deg=${_degraded ? _degraded.reason : 0} hs=${_lastHsMs} hrtt=${Math.round(_rttEwma)} srtt=${_srtt()} polls=${_okPolls}/${_polls} ev=${_eventsIn} drops=${_drops.length} net=${_netDesc()} tr=${_transportDesc()}`);
}

function _ttcStart(why, bgMs) {
  _ttcFinish('superseded');
  _ttc = {
    why, t0: _now(), bgMs: bgMs || 0, net: _netDesc(), tr: _transportDesc(),
    wsAt: 0, httpAt: 0, sawDown: false, uiMs: 0, uiFrom: (_uiKind === 'connecting' || _uiKind === 'offline') ? _now() : 0,
    authedAtStart: _wsAuthed(), timer: null,
    // [bg-grace] o nativo decide no willEnterForeground/onActivityStarted — o
    // evento costuma chegar ANTES do AppState 'active' do JS.
    nres: (why === 'resume' && _lastResume && _now() - _lastResume.at < 5000) ? _lastResume : null,
  };
  const me = _ttc;
  me.timer = setTimeout(() => { if (_ttc === me) _ttcFinish('timeout'); }, TTC_MAX_MS);
  // Socket que sobreviveu à volta (nenhuma queda em TTC_KEPT_MS) = 0 ms.
  // Nativo v6 com a sonda ainda em voo: espera o veredito dela (até +3 s).
  const keptCheck = (waited) => {
    if (_ttc !== me) return;
    if (me.sawDown || !_wsAuthed()) return;
    if (why === 'resume' && !me.nres && _nativeResumeCapable() && waited < 3000) {
      setTimeout(() => keptCheck(waited + 500), 500);
      return;
    }
    me.wsAt = me.t0;
    _ttcFinish('kept');
  };
  setTimeout(() => keptCheck(0), TTC_KEPT_MS);
}

function _nativeResumeCapable() {
  try {
    const w = _ws();
    if (!w || w.transportKind !== 'native') return false;
    return Number(require('./nativeTransport').nativeTransportVersion()) >= 6 && globalThis.__chatyy_ws_bg_grace !== false;
  } catch { return false; }
}

function _onNativeResume(d) {
  if (!d) return;
  _lastResume = { at: _now(), kept: !!d.kept, probeMs: Number(d.probeMs), reason: String(d.reason || '-'), grace: !!d.grace, why: String(d.why || '') };
  const m = _ttc;
  if (m && m.why === 'resume' && !m.nres) m.nres = _lastResume;
}

function _ttcFinish(how) {
  const m = _ttc;
  if (!m) return;
  _ttc = null;
  try { clearTimeout(m.timer); } catch {}
  if (how === 'superseded' && !m.wsAt && !m.httpAt) return;
  if (m.uiFrom) m.uiMs += _now() - m.uiFrom;
  const ws = m.wsAt ? m.wsAt - m.t0 : -1;
  const http = m.httpAt ? m.httpAt - m.t0 : -1;
  const first = (ws >= 0 && (http < 0 || ws <= http)) ? 'ws' : (http >= 0 ? 'http' : 'none');
  // [bg-grace] kept/probe_ms/reason: veredito do NATIVO v6 quando houver (socket
  // reusado após 1 ping); senão a heurística do JS (sem queda em 3 s).
  const nr = m.nres;
  const kept = nr ? (nr.kept ? 1 : 0) : (how === 'kept' ? 1 : 0);
  const probeMs = nr && nr.probeMs >= 0 ? Math.round(nr.probeMs) : -1;
  const reason = nr ? nr.reason : (how === 'kept' ? 'js_kept' : '-');
  _beacon('ws_ttc', `why=${m.why} how=${how} ws=${ws} http=${http} first=${first} ui=${Math.round(m.uiMs)} kept=${kept} probe_ms=${probeMs} reason=${reason} grace=${nr ? (nr.grace ? 1 : 0) : '-'} ksrc=${nr ? 'n' : 'js'} bg=${Math.round(m.bgMs / 1000)}s hs=${_lastHsMs} hrtt=${Math.round(_rttEwma)} srtt=${_srtt()} deg=${_degraded ? _degraded.reason : 0} net=${m.net} tr=${m.tr}`);
}

function _ttcNote(kind) {
  const m = _ttc;
  if (!m) return;
  if (kind === 'down') m.sawDown = true;
  if (kind === 'ws' && !m.wsAt) {
    m.wsAt = _now();
    _ttcFinish('ws');
  } else if (kind === 'http' && !m.httpAt) {
    m.httpAt = _now();
  }
}

// ─── loop HTTP ────────────────────────────────────────────────────────────

function _canRun() {
  if (!_started || _disabled || _off()) return false;
  if (!_appActive || !_netOnline) return false;
  const tok = _token();
  if (!tok) return false;
  if (_authFail) {
    if (tok === _authFailTok) return false;
    _authFail = false; // token novo
  }
  const w = _ws();
  if (!w || w._authReloginStopped || w._hsStopped || w._loggedOut) return false;
  return true;
}

function _stop() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

function _interval() {
  if (_failStreak > 0) return Math.min(POLL_FAIL_MAX_MS, 2000 * Math.pow(2, Math.min(_failStreak - 1, 4)));
  const hot = _degraded || (_now() - _lastEventAt) < EVENTS_HOT_MS;
  const base = Math.max(hot ? POLL_FAST_MS : POLL_IDLE_MS, _srvMinMs);
  // jitter ±15 %: a frota não bate em lockstep numa queda geral do hub.
  return Math.round(base * (0.85 + Math.random() * 0.3));
}

function _arm() {
  _stop();
  if (!_canRun() || _wsAuthed()) return;
  if (!_wsDownSince) _wsDownSince = _now();
  const t = _now();
  let delay;
  if (_lastPollAt < _wsDownSince) {
    const grace = _degraded ? 0 : GRACE_MS;
    delay = Math.max(0, _wsDownSince + grace - t);
  } else {
    delay = Math.max(0, _lastPollAt + _interval() - t);
  }
  _timer = setTimeout(_tick, delay);
}

function _tick() {
  _timer = null;
  if (!_canRun() || _wsAuthed()) return;
  if (_inflightAt && _now() - _inflightAt < REQ_TIMEOUT_DEGRADED_MS + 2000) return;
  _poll().catch(() => {}).finally(() => { _arm(); });
}

async function _fetchJson(url, headers, timeoutMs) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const to = setTimeout(() => { try { ctl && ctl.abort(); } catch {} }, timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: ctl ? ctl.signal : undefined, credentials: Platform.OS === 'web' ? 'include' : undefined });
    let body = null;
    try { body = await res.json(); } catch {}
    return { status: res.status, body };
  } finally {
    clearTimeout(to);
  }
}

async function _poll() {
  const w = _ws();
  const api = _api();
  if (!w || !api) return;
  if (!_firstTryAt || _firstTryAt < _wsDownSince) _firstTryAt = _now();
  _inflightAt = _now();
  _lastPollAt = _inflightAt;
  _polls += 1;
  _emitChange();
  // Fim da janela "em voo segura o Conectando" não tem evento próprio → avisa.
  setTimeout(_emitChange, PENDING_SUPPRESS_MS + 50);
  // [failover 2026-10-19] US marcado fora (api.js) → poll no edge de reserva (chat_ws_events local lá).
  const base = (api.getRealtimeHttpBase && api.getRealtimeHttpBase()) || (api.getOriginBase && api.getOriginBase()) || 'https://chatyy.com.br';
  const timeoutMs = _degraded ? REQ_TIMEOUT_DEGRADED_MS : REQ_TIMEOUT_MS;
  let pages = 0;
  let gotEvents = 0;
  try {
    while (pages < MAX_PAGES) {
      pages += 1;
      const since = Number(w._lastEventId) || 0;
      const headers = (api.getAuthHeaders && api.getAuthHeaders()) || {};
      const tok = _token();
      if (!headers.Authorization && tok) headers.Authorization = `Bearer ${tok}`;
      const url = `${base}/api/email.php?action=chat_ws_events&since=${since}&limit=100`;
      const t0 = _now();
      const { status, body } = await _fetchJson(url, headers, timeoutMs);
      const ms = _now() - t0;
      if (status === 410) { _disabled = true; _beacon('net_mode', 'http_disabled_410'); return; }
      if (status === 401 || status === 403) {
        _authFail = true;
        _authFailTok = tok;
        _lastFailAt = _now();
        return;
      }
      const data = body && body.success ? body.data : null;
      if (!data || typeof data !== 'object') throw new Error('http_' + status);
      // RTT (inclui ~20-40 ms do PHP): EWMA só p/ classificar o enlace.
      _lastRtt = ms;
      _srvMinMs = Math.min(60000, Math.max(0, Number(data.poll_ms) || 0));
      _rttEwma = _rttSamples === 0 ? ms : (0.7 * _rttEwma + 0.3 * ms);
      _rttSamples += 1;
      _lastOkAt = _now();
      _failStreak = 0;
      _okPolls += 1;
      _ttcNote('http');
      if (_rttSamples >= 2 && _rttEwma > HTTP_RTT_DEGRADED_MS) _markDegraded('http_rtt');
      // WS voltou enquanto a requisição viajava → o resume dele já cobre (evita
      // entrega dupla do mesmo event_id).
      if (w.authenticated) break;
      _setMode('http', 'poll_ok');
      const cur = Number(data.current_event_id) || 0;
      if (data.full_sync || (since <= 0 && cur > 0)) {
        // Mesmo caminho do resume_full_sync do hub: adota o high-water e dispara o
        // catch-up HTTP normal (chat_sync / chat_list via 'foreground').
        try { w._handleMessage({ type: 'resume_full_sync', reason: 'http_' + (data.reason || 'full_sync'), current_event_id: cur }); } catch {}
        break;
      }
      const evs = Array.isArray(data.events) ? data.events : [];
      for (let i = 0; i < evs.length; i++) {
        const e = evs[i];
        if (!e || typeof e !== 'object') continue;
        if (typeof e.event_id === 'number' && e.event_id <= (Number(w._lastEventId) || 0)) continue;
        if (w.authenticated) break;
        try { w._handleMessage(e); } catch {}
        gotEvents += 1;
      }
      const last = Number(data.last_event_id) || 0;
      if (last > (Number(w._lastEventId) || 0) && !w.authenticated) {
        w._lastEventId = last;
        try { w._persistLastEventId?.(); } catch {}
      }
      if (!data.has_more || w.authenticated) break;
    }
    if (gotEvents > 0) {
      _eventsIn += gotEvents;
      _lastEventAt = _now();
      try { w._persistLastEventId?.(); } catch {}
    }
  } catch (e) {
    _lastFailAt = _now();
    _failStreak += 1;
    if (!_wsAuthed()) _setMode('down', String((e && e.message) || 'fail').slice(0, 24));
  } finally {
    _inflightAt = 0;
    _emitChange();
  }
}

// ─── fontes ───────────────────────────────────────────────────────────────

function _onConnection(d) {
  const s = d && d.status;
  const t = _now();
  if (s === 'authenticated') {
    _wsAuthedAt = t;
    _wsDownSince = 0;
    _stop();
    _setMode('ws', 'ws_authed');
    _ttcNote('ws');
    _armClearCheck();
    _emitChange();
    return;
  }
  if (s === 'disconnected' || s === 'reconnecting' || s === 'offline' || s === 'session_replaced') {
    if (_wsAuthedAt) {
      const life = t - _wsAuthedAt;
      _wsAuthedAt = 0;
      if (life < SHORT_LIFE_MS && _appActive && _netOnline) {
        _drops.push(t);
        _drops = _drops.filter((x) => t - x < DROPS_WINDOW_MS);
        if (_drops.length >= DROPS_DEGRADED) _markDegraded('ws_drops');
      }
    }
    if (!_wsDownSince) _wsDownSince = t;
    _ttcNote('down');
    _arm();
    _emitChange();
  }
}

function _onHandshake(d) {
  const ms = Number(d && d.ms);
  if (!(ms >= 0)) return;
  _lastHsMs = Math.round(ms);
  _lastHsTransport = String((d && d.transport) || '');
  // Medido no JS (nativo < v5 / WebSocket JS) logo após o boot inclui a thread JS
  // ocupada renderizando → não classifica o enlace por ele.
  const precise = !!(d && d.precise);
  if (!precise && (_now() - _startedAt) < 15000) return;
  if (ms > HS_SLOW_MS && ms < 60000 && _appActive && _netOnline) _markDegraded('slow_handshake');
}

export function startHttpFallback() {
  if (_started) return;
  _started = true;
  _startedAt = _now();
  try {
    const ni = require('./networkInfo');
    _netType = ni.getNetworkType?.() || 'unknown';
    _loadDegraded();
    ni.onNetworkChange?.((st) => {
      const online = !(st && st.isConnected === false);
      const type = (() => { try { return ni.getNetworkType?.() || 'unknown'; } catch { return 'unknown'; } })();
      const changed = online && type !== _netType && _netType !== 'unknown' && type !== 'unknown' && type !== 'none';
      _netOnline = online;
      if (online) {
        if (changed && _degraded) _clearDegraded('net_change');
        _netType = type;
      }
      if (!online) _stop(); else _arm();
      _emitChange();
    });
  } catch {}
  try {
    const w = _ws();
    if (w && typeof w.on === 'function') {
      w.on('connection', _onConnection);
      w.on('ws_handshake', _onHandshake);
      w.on('ws_resume', _onNativeResume);
      if (w.authenticated) { _wsAuthedAt = _now(); _mode = 'ws'; }
    }
  } catch {}
  try {
    if (Platform.OS !== 'web') {
      _appActive = AppState.currentState === 'active' || AppState.currentState == null;
      let bgAt = 0;
      AppState.addEventListener('change', (next) => {
        if (next === 'inactive') return;
        const active = next === 'active';
        if (active && !_appActive) {
          _ttcStart('resume', bgAt ? _now() - bgAt : 0);
          if (!_wsAuthed() && !_wsDownSince) _wsDownSince = _now();
        }
        if (!active && _appActive) { bgAt = _now(); _ttcFinish('background'); }
        _appActive = active;
        if (!active) _stop(); else _arm();
        _emitChange();
      });
    } else if (typeof document !== 'undefined' && document.addEventListener) {
      _appActive = document.visibilityState !== 'hidden';
      let hidAt = 0;
      document.addEventListener('visibilitychange', () => {
        const active = document.visibilityState !== 'hidden';
        if (active && !_appActive) _ttcStart('visible', hidAt ? _now() - hidAt : 0);
        if (!active && _appActive) { hidAt = _now(); _ttcFinish('hidden'); }
        _appActive = active;
        if (!active) _stop(); else _arm();
        _emitChange();
      });
    }
  } catch {}
  if (_appActive) _ttcStart('boot', 0);
  if (!_wsAuthed()) _arm();
}

// ─── API p/ syncStatus / SyncBar / websocket.js ───────────────────────────

/** HTTP de reserva respondendo agora (WS fora): o app está "conectado por HTTP". */
export function isHttpHealthy() {
  if (!_started || _off() || _disabled || _authFail) return false;
  if (!_lastOkAt || _lastFailAt > _lastOkAt) return false;
  return (_now() - _lastOkAt) < Math.max(HEALTHY_FOR_MS, _interval() * 2.5);
}

/** 1ª requisição HTTP desde a queda ainda em voo (dá a ela uma chance antes do "Conectando"). */
export function isHttpPending() {
  if (!_started || _off() || _disabled || _authFail) return false;
  if (!_inflightAt) return false;
  return _firstTryAt > 0 && (_now() - _firstTryAt) < PENDING_SUPPRESS_MS && _lastFailAt < _firstTryAt;
}

/** O HTTP entregou eventos com sucesso há pouco (gap do WS coberto). */
export function httpCoveredRecently() {
  if (!_started || _off() || _disabled || !_lastOkAt || _okPolls === 0) return false;
  return _lastOkAt >= _lastFailAt && (_now() - _lastOkAt) < HEALTHY_FOR_MS;
}

/** Enlace degradado (satélite/avião/2G): prazos generosos no WS. */
export function isLinkDegraded() {
  if (_degOff() || !_degraded) return false;
  return (_now() - _degraded.at) < DEGRADED_TTL_MS;
}

export function getLinkDegradedReason() { return _degraded ? _degraded.reason : null; }

/** syncStatus informa o que está NA TELA (p/ medir quanto tempo o "Conectando" ficou visível). */
export function noteUiState(kind) {
  const k = kind || 'idle';
  if (k === _uiKind) return;
  const t = _now();
  const m = _ttc;
  const wasBad = _uiKind === 'connecting' || _uiKind === 'offline';
  const isBad = k === 'connecting' || k === 'offline';
  if (m) {
    if (wasBad && !isBad && m.uiFrom) { m.uiMs += t - m.uiFrom; m.uiFrom = 0; }
    if (!wasBad && isBad) m.uiFrom = t;
  }
  _uiKind = k;
  _uiSince = t;
}

export function subscribeHttpFallback(fn) {
  if (typeof fn !== 'function') return () => {};
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

export function getHttpFallbackStats() {
  return {
    mode: _mode, modeMs: _now() - _modeSince, degraded: _degraded ? { ..._degraded } : null,
    healthy: isHttpHealthy(), pending: isHttpPending(), polls: _polls, okPolls: _okPolls, events: _eventsIn,
    lastRttMs: _lastRtt, rttEwmaMs: Math.round(_rttEwma), failStreak: _failStreak, lastHsMs: _lastHsMs,
    lastHsTransport: _lastHsTransport, drops: _drops.length, wsDownMs: _wsDownSince ? _now() - _wsDownSince : 0,
    uiKind: _uiKind, uiMs: _uiSince ? _now() - _uiSince : 0, srtt: _srtt(),
  };
}

export default {
  startHttpFallback, isHttpHealthy, isHttpPending, isLinkDegraded, getLinkDegradedReason, httpCoveredRecently,
  noteUiState, subscribeHttpFallback, getHttpFallbackStats,
};
