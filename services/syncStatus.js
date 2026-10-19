// [2026-10-13 sync-status] Fonte ÚNICA do "estado de sincronização" da home.
//
// Antes: 3 superfícies independentes, cada uma com seu timer/heurística —
//   • components/SyncBar.js (topo do /chat): "Conectando…"/"Sem internet" com
//     grace de 8-19 s; ramos de progresso (sync/bootstrap) desligados com
//     `return` → nunca mostrava progresso real;
//   • ChatListTab "Sincronizando..." (orchestrator, gate 7 s + teto 4 s,
//     só nativo) e "Reconectando…" (grace 12-18 s + watchdog 1,5 s);
//   • OfflineNotice raiz ("Sem conexão", 4 s).
// Resultado: estados empilhados/contraditórios, cópia genérica
// ("Sincronizando") e, ao mesmo tempo, demora demais p/ avisar um problema real.
//
// Agora este módulo deriva UM estado bruto das fontes de verdade e aplica a
// política de exibição num lugar só (todas as superfícies concordam):
//
//   bruto     fonte                                           rótulo
//   offline   networkInfo (device sem rede) && WS caído       "Aguardando rede"
//   connecting device online && WS não autenticado            "Conectando…"
//   bootstrap fullHistorySync 1ª vez (chat_bootstrap_progress) "Baixando conversas 37%"
//   updating  onlineRecoveryOrchestrator / initialSync /
//             trackUpdate() (catch-up do reconnect)            "Atualizando…"
//   idle      nada pendente                                    (título normal)
//
// Política (nível WhatsApp):
//   • debounce: só aparece se o período "ocupado" durar > SHOW_DELAY (1,5 s;
//     2,5-3 s logo após abrir/voltar do 2º plano, quando o rádio ainda acorda) —
//     reconexão/delta instantâneos nunca piscam;
//   • uma vez visível, troca de rótulo na hora (Conectando → Atualizando) e
//     some (fade no componente) assim que ficar idle, após MIN_VISIBLE;
//   • em 2º plano: nada visível, timers cancelados;
//   • watchdog: 1 s de poll enquanto ocupado/visível re-deriva do socket real
//     ("socket vivo vence" — cura evento 'authenticated' perdido); estado de
//     progresso (updating/bootstrap) parado > N s sem progresso → esconde e loga
//     (breadcrumb) e só volta quando o estado bruto mudar;
//     connecting parado > 30 s → loga + chuta ensureHealthy() (continua honesto).
import { AppState, Platform } from 'react-native';

const SHOW_DELAY_MS = 1500;
const SHOW_DELAY_UPDATING_MS = 2000;
const WAKE_WINDOW_MS = 4000;         // cold start / volta do 2º plano
const SHOW_DELAY_WAKE_MS = 2000;     // [2026-10-19 http-fallback] 2,5→2 s (o HTTP de reserva cobre o resto)
const SHOW_DELAY_UPDATING_WAKE_MS = 3000;
const MIN_VISIBLE_MS = 600;
const STALL_UPDATING_MS = 15000;     // sem fim do recovery/delta
const STALL_BOOTSTRAP_MS = 30000;    // sem evento de progresso do bootstrap
const STALL_CONNECTING_MS = 30000;   // só loga + kick (estado é honesto)
const INITIAL_SYNC_STALE_MS = 15000;
const TRACK_MAX_MS = 20000;
const POLL_MS = 1000;

const IDLE = Object.freeze({ kind: 'idle', progress: null });

let _started = false;
let _mailWs = null;
let _listeners = new Set();
let _display = IDLE;

// fontes
let _netOnline = true;
let _wsAuthedEvt = false;
let _hasAuthedOnce = false;
let _recovering = false;
let _initialRunning = false;
let _initialAt = 0;
let _tracked = 0;
let _boot = { running: false, done: 0, total: 0, at: 0 };
let _appActive = true;
let _lastWakeAt = Date.now();

// política
let _busySince = 0;
let _rawKind = 'idle';
let _rawSince = 0;
let _suppressedKind = null;
let _showTimer = null;
let _hideTimer = null;
let _shownAt = 0;
let _poll = null;
let _connectingKickedAt = 0;

function _now() { return Date.now(); }

function _log(step, info) {
  try { require('./crashReporter').addBreadcrumb?.(step, info); } catch {}
  try { if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn('[syncStatus]', step, info || ''); } catch {}
}

function _wsLive() {
  try {
    if (_mailWs && typeof _mailWs.authenticated === 'boolean') return !!_mailWs.authenticated;
  } catch {}
  return _wsAuthedEvt;
}

// [2026-10-19 http-fallback] WS fora mas o HTTP de reserva (services/httpFallback.js)
// respondendo = app CONECTADO por HTTP (Wi-Fi de avião/satélite, proxy que derruba
// WS): nada de "Conectando…". 1ª requisição ainda em voo (até 8 s) também segura o
// rótulo. Só sem rede do SO → "Aguardando rede"; só com WS E HTTP falhando →
// "Conectando…". Kill switch: globalThis.__chatyy_http_fallback = false.
function _httpCovers() {
  try {
    const hf = require('./httpFallback');
    return !!(hf.isHttpHealthy() || hf.isHttpPending());
  } catch { return false; }
}

function _rawState() {
  if (!_wsLive()) {
    if (!_netOnline) return { kind: 'offline', progress: null };
    if (_httpCovers()) return { kind: 'idle', progress: null };
    return { kind: 'connecting', progress: null };
  }
  // [2026-10-18 bg-sync] O download de histórico NÃO toma mais o título
  // ("Baixando conversas 37%" passava a ideia de "espere"). Ele roda em 2º
  // plano e aparece só na pílula discreta da lista (components/BackgroundSyncPill).
  // Religar o modo antigo: globalThis.__chatyy_bootstrap_title = true.
  if (_boot.running && _boot.total > 0 && globalThis.__chatyy_bootstrap_title === true) {
    const pct = Math.max(0, Math.min(99, Math.floor((_boot.done / _boot.total) * 100)));
    return { kind: 'bootstrap', progress: pct };
  }
  const initialLive = _initialRunning && (_now() - _initialAt) < INITIAL_SYNC_STALE_MS;
  if (_recovering || initialLive || _tracked > 0) {
    // [2026-10-19 em-ligacao] Durante uma ligação o catch-up roda disputando a
    // rede com o áudio/vídeo (lento) e cada volta inactive→active do iOS
    // (CallKit, pílula, alerta) refazia o recovery → título "Atualizando…" quase
    // o tempo todo (founder 19/10, print com "Toque para voltar à ligação").
    // O socket está VIVO (chat ao vivo): o delta é trabalho de fundo, não estado
    // a exibir. Kill switch: globalThis.__chatyy_sync_title_in_call = true.
    if (globalThis.__chatyy_sync_title_in_call !== true && _inCall()) return { kind: 'idle', progress: null };
    return { kind: 'updating', progress: null };
  }
  return { kind: 'idle', progress: null };
}

let _inCallAt = 0;
let _inCallVal = false;
function _inCall() {
  const t = _now();
  if (t - _inCallAt < 1000) return _inCallVal; // leitura síncrona do nativo no máx. 1×/s
  _inCallAt = t;
  try { _inCallVal = !!require('./ongoingCall').isCallOngoing(); } catch { _inCallVal = false; }
  return _inCallVal;
}

function _emit() {
  try { require('./httpFallback').noteUiState(_display.kind); } catch {}
  _listeners.forEach((fn) => { try { fn(_display); } catch {} });
}

function _setDisplay(kind, progress) {
  if (kind === 'idle') {
    if (_display === IDLE) return;
    _display = IDLE;
    _shownAt = 0;
  } else {
    if (_display.kind === kind && _display.progress === progress) return;
    if (_display.kind === 'idle') _shownAt = _now();
    _display = Object.freeze({ kind, progress: progress == null ? null : progress });
  }
  _emit();
}

function _clearShowTimer() { if (_showTimer) { clearTimeout(_showTimer); _showTimer = null; } }
function _clearHideTimer() { if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; } }

function _showDelayFor(kind) {
  const waking = (_now() - _lastWakeAt) < WAKE_WINDOW_MS || !_hasAuthedOnce;
  if (kind === 'updating') return waking ? SHOW_DELAY_UPDATING_WAKE_MS : SHOW_DELAY_UPDATING_MS;
  return waking ? SHOW_DELAY_WAKE_MS : SHOW_DELAY_MS;
}

function _ensurePoll(on) {
  if (on && !_poll) {
    _poll = setInterval(_recompute, POLL_MS);
  } else if (!on && _poll) {
    clearInterval(_poll);
    _poll = null;
  }
}

function _checkStall(raw) {
  const t = _now();
  if (raw.kind === 'updating' && t - _rawSince > STALL_UPDATING_MS) {
    _log('sync_status_stall', { kind: 'updating', ms: t - _rawSince });
    _suppressedKind = 'updating';
    return true;
  }
  if (raw.kind === 'bootstrap' && t - (_boot.at || _rawSince) > STALL_BOOTSTRAP_MS) {
    _log('sync_status_stall', { kind: 'bootstrap', ms: t - _boot.at, done: _boot.done, total: _boot.total });
    _suppressedKind = 'bootstrap';
    return true;
  }
  if (raw.kind === 'connecting' && t - _rawSince > STALL_CONNECTING_MS && t - _connectingKickedAt > STALL_CONNECTING_MS) {
    _connectingKickedAt = t;
    _log('sync_status_connecting_long', { ms: t - _rawSince });
    try { _mailWs?.ensureHealthy?.(1000)?.catch?.(() => {}); } catch {}
  }
  return false;
}

function _recompute() {
  const t = _now();
  const raw = _appActive ? _rawState() : { kind: 'idle', progress: null };
  if (raw.kind !== _rawKind) {
    _rawKind = raw.kind;
    _rawSince = t;
    if (_suppressedKind && _suppressedKind !== raw.kind) _suppressedKind = null;
  }
  if (raw.kind === 'idle') _busySince = 0;
  else if (!_busySince) _busySince = t;

  const stalled = raw.kind !== 'idle' && _suppressedKind !== raw.kind && _checkStall(raw);
  const quiet = raw.kind === 'idle' || stalled || _suppressedKind === raw.kind;

  _ensurePoll(_appActive && (raw.kind !== 'idle' || _display !== IDLE));

  if (quiet) {
    _clearShowTimer();
    if (_display === IDLE) return;
    if (!_appActive) { _clearHideTimer(); _setDisplay('idle'); return; }
    const left = MIN_VISIBLE_MS - (t - _shownAt);
    if (left > 0 && !stalled) {
      if (!_hideTimer) _hideTimer = setTimeout(() => { _hideTimer = null; _recompute(); }, left);
      return;
    }
    _clearHideTimer();
    _setDisplay('idle');
    return;
  }

  _clearHideTimer();
  if (_display !== IDLE) { _setDisplay(raw.kind, raw.progress); return; }
  const due = _busySince + _showDelayFor(raw.kind);
  if (t >= due) { _clearShowTimer(); _setDisplay(raw.kind, raw.progress); return; }
  if (!_showTimer) _showTimer = setTimeout(() => { _showTimer = null; _recompute(); }, due - t);
}

function _start() {
  if (_started) return;
  _started = true;
  try { _mailWs = require('./websocket').default; } catch {}
  try { _hasAuthedOnce = _wsLive(); _wsAuthedEvt = _hasAuthedOnce; } catch {}
  // [2026-10-19 http-fallback] transporte HTTP de reserva + saúde → recompute.
  try {
    const hf = require('./httpFallback');
    hf.startHttpFallback();
    hf.subscribeHttpFallback(() => _recompute());
  } catch {}

  try {
    _mailWs?.on?.('connection', (d) => {
      const s = d && d.status;
      if (s === 'authenticated') { _wsAuthedEvt = true; _hasAuthedOnce = true; }
      else if (s === 'disconnected' || s === 'session_replaced') _wsAuthedEvt = false;
      _recompute();
    });
    _mailWs?.on?.('sync_progress', (d) => {
      const ph = d && d.phase;
      if (ph === 'start' || ph === 'progress') {
        _initialRunning = !((d.progress || 0) >= 100);
        _initialAt = _now();
      } else if (ph === 'done' || ph === 'error') {
        _initialRunning = false;
      }
      _recompute();
    });
    _mailWs?.on?.('chat_bootstrap_progress', (d) => {
      if (Platform.OS === 'web') return; // bootstrap SQLite é só nativo
      const ph = d && d.phase;
      if (ph === 'start' || ph === 'conv') {
        _boot = { running: true, done: Number(d.convDone) || 0, total: Number(d.convTotal) || 0, at: _now() };
      } else if (ph === 'done') {
        _boot = { running: false, done: 0, total: 0, at: _now() };
      }
      _recompute();
    });
  } catch {}

  try {
    require('./networkInfo').onNetworkChange((st) => {
      _netOnline = !(st && st.isConnected === false);
      _recompute();
    });
  } catch {}

  try {
    const orch = require('./onlineRecoveryOrchestrator');
    orch?.subscribeSyncStatus?.(({ running }) => { _recovering = !!running; _recompute(); });
  } catch {}

  try {
    if (Platform.OS !== 'web') {
      _appActive = AppState.currentState === 'active' || AppState.currentState == null;
      AppState.addEventListener('change', (next) => {
        if (next === 'inactive') return; // transitório (iOS)
        const active = next === 'active';
        if (active && !_appActive) _lastWakeAt = _now();
        _appActive = active;
        if (!active) { _clearShowTimer(); _busySince = 0; }
        _recompute();
      });
    }
  } catch {}

  // Web: aba oculta = "2º plano" (o socket pode ser estacionado); ao voltar,
  // janela de despertar maior p/ não piscar "Conectando…".
  try {
    if (Platform.OS === 'web' && typeof document !== 'undefined' && document.addEventListener) {
      _appActive = document.visibilityState !== 'hidden';
      document.addEventListener('visibilitychange', () => {
        const active = document.visibilityState !== 'hidden';
        if (active && !_appActive) _lastWakeAt = _now();
        _appActive = active;
        if (!active) { _clearShowTimer(); _busySince = 0; }
        _recompute();
      });
    }
  } catch {}

  _recompute();
}

/** Assina o estado EXIBÍVEL ({kind, progress}). Retorna unsubscribe. */
export function subscribeSyncStatus(fn) {
  if (typeof fn !== 'function') return () => {};
  _start();
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

/** Snapshot estável (mesma identidade até mudar) — p/ useSyncExternalStore. */
export function getSyncStatus() {
  _start();
  return _display;
}

/**
 * Marca trabalho de "atualizar" (puxar delta/mensagens) fora do orchestrator.
 * Aceita uma Promise; teto de TRACK_MAX_MS p/ nunca prender o indicador.
 */
export function trackUpdate(promise) {
  _start();
  _tracked += 1;
  let done = false;
  const end = () => { if (done) return; done = true; _tracked = Math.max(0, _tracked - 1); _recompute(); };
  const timer = setTimeout(() => { _log('sync_status_track_timeout', {}); end(); }, TRACK_MAX_MS);
  _recompute();
  Promise.resolve(promise).then(() => { clearTimeout(timer); end(); }, () => { clearTimeout(timer); end(); });
  return promise;
}

// ── Superfície da home: quando a home mostra o status no título, o
// OfflineNotice raiz não precisa pintar a 2ª faixa "Sem conexão" (WhatsApp
// mostra UMA indicação). Contador por instância focada.
let _homeClaims = 0;
const _homeListeners = new Set();
export function claimHomeSyncSurface() {
  _homeClaims += 1;
  _homeListeners.forEach((fn) => { try { fn(_homeClaims > 0); } catch {} });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    _homeClaims = Math.max(0, _homeClaims - 1);
    _homeListeners.forEach((fn) => { try { fn(_homeClaims > 0); } catch {} });
  };
}
export function isHomeSyncSurfaceActive() { return _homeClaims > 0; }
export function subscribeHomeSyncSurface(fn) {
  if (typeof fn !== 'function') return () => {};
  _homeListeners.add(fn);
  return () => { _homeListeners.delete(fn); };
}

export default {
  subscribeSyncStatus,
  getSyncStatus,
  trackUpdate,
  claimHomeSyncSurface,
  isHomeSyncSurfaceActive,
  subscribeHomeSyncSurface,
};
