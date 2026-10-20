/**
 * [2026-10-15 native-transport] Shim WebSocket-compatível sobre o módulo nativo
 * ChatyyTransport (modules/expo-chat-transport).
 *
 * services/websocket.js continua dono de TODA a lógica de negócio (auth_success,
 * resume, subscribe, filas, recibos, chamadas…). Este arquivo só troca o "fio":
 * o objeto devolvido por createNativeSocket() se comporta como um WebSocket
 * (readyState / onopen / onmessage / onclose / send / close) mas é um socket
 * LÓGICO — quando o fio físico cai, o nativo reconecta e reautentica sozinho
 * (sem depender da thread JS), segura os frames de saída numa fila e só avisa
 * o JS via `onnativestate`. onclose só dispara em fechamento de NEGÓCIO
 * (4000-4999 do hub: session_replaced, superseded…) ou falha interna.
 *
 * Frames recebidos chegam em LOTE (evento com array de strings); viram objetos
 * com UM JSON.parse por lote e são entregues ao onmessage como
 * `{ data: null, __obj: <frame> }` (websocket.js lê __obj e pula o parse).
 *
 * Ativação: módulo presente (binário novo) + plataforma nativa +
 * `globalThis.__chatyy_native_ws !== false`. Kill switch OTA/console:
 * `globalThis.__chatyy_native_ws = false` → próximo connect volta ao WebSocket
 * JS. Falha interna do nativo marca `__chatyy_native_ws_broken` (só no processo)
 * e o websocket.js cai para o WebSocket JS.
 */
import { Platform } from 'react-native';

let _mod; // undefined = não resolvido; null = indisponível
let _subs = null;
const _sockets = new Map(); // sid → NativeTransportSocket
let _sidSeq = 0;

// Diagnóstico (lido por getNativeTransportStats / tela de diag).
const SLICE_MS = 12; // [2026-10-20 perf-js] fatia do despacho de lotes (ver _drain)
const _jsStats = {
  batches: 0,
  frames: 0,
  maxBatch: 0,
  jsMsTotal: 0,
  jsMsMax: 0,
  parseFallbacks: 0,
  states: {},
};

function _resolve() {
  if (_mod !== undefined) return _mod;
  _mod = null;
  try {
    if (Platform.OS === 'web') return _mod;
    const { requireOptionalNativeModule } = require('expo');
    const m = requireOptionalNativeModule('ChatyyTransport');
    if (m && typeof m.open === 'function' && typeof m.send === 'function' &&
        typeof m.version === 'function' && m.version() >= 1) {
      _mod = m;
    }
  } catch {
    _mod = null;
  }
  return _mod;
}

function _addListener(m, name, fn) {
  if (typeof m.addListener === 'function') return m.addListener(name, fn);
  const { EventEmitter } = require('expo-modules-core');
  return new EventEmitter(m).addListener(name, fn);
}

function _ensureSubs(m) {
  if (_subs) return;
  _subs = [
    _addListener(m, 'onTransportFrames', (ev) => {
      const s = ev && _sockets.get(ev.sid);
      if (s) s._onFrames(ev.frames);
    }),
    _addListener(m, 'onTransportState', (ev) => {
      if (ev && ev.state) _jsStats.states[ev.state] = (_jsStats.states[ev.state] || 0) + 1;
      const s = ev && _sockets.get(ev.sid);
      if (s) s._onState(ev);
    }),
  ];
}

/** Módulo nativo utilizável agora? (flag + binário + não quebrado neste processo) */
export function isNativeTransportEnabled() {
  try {
    if (Platform.OS === 'web') return false;
    const g = globalThis;
    if (g.__chatyy_native_ws === false) return false;
    if (g.__chatyy_native_ws_broken) return false;
    return !!_resolve();
  } catch {
    return false;
  }
}

export function markNativeTransportBroken(reason) {
  try {
    globalThis.__chatyy_native_ws_broken = { at: Date.now(), reason: String(reason || '') };
    console.warn('[WS] transporte nativo desativado neste processo: ' + reason);
  } catch {}
}

/**
 * Cria o socket lógico. Lança se o nativo recusar (URL inválida etc.) — o
 * chamador cai para o WebSocket JS.
 *   opts.fallbackUrl : URL US quando `url` é regional
 *   opts.authFrame   : objeto de auth (o nativo manda em TODA conexão física,
 *                      inclusive a 1ª, sem esperar a thread JS)
 *   opts.heartbeat   : { interval, deadline } (perfil atual do websocket.js)
 */
export function createNativeSocket(url, opts = {}) {
  const m = _resolve();
  if (!m) throw new Error('native transport unavailable');
  _ensureSubs(m);
  return new NativeTransportSocket(m, url, opts);
}

/**
 * [2026-10-18 ws-400] Versão da API do módulo nativo (0 = indisponível).
 *   v4+: HTTP 400/401/403 no handshake é TERMINAL já na 1ª recusa — o nativo
 *        emite onTransportState {state:'handshake_rejected', http} e fecha a
 *        sessão lógica (4400 = 400, 4401 = 401/403) sem backoff.
 *   < v4: 401/403 → 4401; 400 seguia em backoff ('reconnecting' com http) e só
 *        fechava (4400) após 4 recusas — o websocket.js trata o 1º
 *        'reconnecting' com http 400/401/403 como recusa terminal.
 */
export function nativeTransportVersion() {
  try {
    const m = _resolve();
    return m ? (Number(m.version()) || 0) : 0;
  } catch {
    return 0;
  }
}

export function getNativeTransportStats() {
  const out = { js: { ..._jsStats, states: { ..._jsStats.states } } };
  try {
    const m = _resolve();
    if (m && typeof m.getStats === 'function') out.native = m.getStats();
  } catch {}
  return out;
}

class NativeTransportSocket {
  constructor(m, url, opts) {
    this.__native = true;
    this._m = m;
    this.url = url;
    this.protocol = '';
    this.binaryType = 'arraybuffer';
    this.readyState = 0; // CONNECTING até o 1º open físico
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.onnativestate = null;
    _sidSeq += 1;
    this.sid = 'nt-' + Date.now().toString(36) + '-' + _sidSeq;
    const hb = opts.heartbeat || {};
    const urls = [url];
    if (opts.fallbackUrl && opts.fallbackUrl !== url) urls.push(opts.fallbackUrl);
    const cfg = {
      urls,
      pingIntervalMs: hb.interval || 20000,
      pongDeadlineMs: hb.deadline || 10000,
      authWatchdogMs: opts.authWatchdogMs || 6000,
      connectTimeoutMs: opts.connectTimeoutMs || 10000,
      fgProbeMs: opts.fgProbeMs || 2500,
      // [2026-10-19 resume-reuse] nativo v5+ (versões antigas ignoram as chaves).
      bgStaleMs: opts.bgStaleMs || 20000,
      adaptiveTimeouts: opts.adaptiveTimeouts !== false,
      // [2026-10-19 bg-grace] nativo v6+: graça de 2º plano (iOS ~28 s) + volta
      // sonda/reusa + evento 'resume'; DNS pré-resolvido; URLSession compartilhada
      // (retomada TLS, iOS); 1ª tentativa com prazo curto. Ausente/false = v5.
      bgGrace: opts.bgGrace === true,
      bgGraceMs: opts.bgGraceMs || 28000,
      dnsPrewarm: opts.dnsPrewarm === true,
      reuseSession: opts.reuseSession === true,
      fastFirst: opts.fastFirst === true,
      batchMs: 16,
      outboxMax: 500,
      // [2026-10-15 fase 2b] conta da sessão + gravação direta no store nativo
      account: String(opts.account || ''),
      storeIngest: !!opts.storeIngest,
    };
    if (opts.authFrame) {
      try { cfg.authFrame = JSON.stringify(opts.authFrame); } catch {}
    }
    _sockets.set(this.sid, this);
    try {
      m.open(this.sid, cfg);
    } catch (e) {
      _sockets.delete(this.sid);
      throw e;
    }
  }

  send(data) {
    if (this.readyState !== 1) throw new Error('INVALID_STATE_ERR');
    if (typeof data !== 'string') {
      // Modo nativo só fala JSON texto (msgpack/CWP ficam desligados nele).
      throw new Error('native transport: text frames only');
    }
    this._m.send(this.sid, data);
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    try { if (!this._draining) this._flushQueue(); } catch {}
    if (this.readyState >= 2) return;
    this.readyState = 3;
    _sockets.delete(this.sid);
    try { this._m.close(this.sid, Number(code) || 1000, String(reason || '')); } catch {}
    const cb = this.onclose;
    if (cb) setTimeout(() => { try { cb({ code: Number(code) || 1000, reason: String(reason || ''), wasClean: true }); } catch {} }, 0);
  }

  // ─── extras do transporte nativo (usados por websocket.js) ───
  setHeartbeat(interval, deadline) {
    if (this.readyState >= 2) return;
    try { this._m.setHeartbeat(this.sid, Number(interval) || 20000, Number(deadline) || 10000); } catch {}
  }

  probe(ms) {
    if (this.readyState >= 2) return;
    try { this._m.probe(this.sid, Number(ms) || 2500); } catch {}
  }

  kick(reason, force) {
    if (this.readyState >= 2) return;
    try { this._m.kick(this.sid, String(reason || 'js'), !!force); } catch {}
  }

  setAuthToken(token) {
    if (this.readyState >= 2 || !token) return;
    try { this._m.setAuthToken(this.sid, String(token)); } catch {}
  }

  _onFrames(frames) {
    if (!Array.isArray(frames) || frames.length === 0 || this.readyState === 3) return;
    const t0 = Date.now();
    let arr;
    try {
      // 1 parse por lote (os frames do hub são sempre objetos JSON).
      arr = frames.length === 1 ? [JSON.parse(frames[0])] : JSON.parse('[' + frames.join(',') + ']');
    } catch {
      _jsStats.parseFallbacks++;
      arr = [];
      for (const f of frames) {
        try { arr.push(JSON.parse(f)); } catch {}
      }
    }
    _jsStats.batches++;
    _jsStats.frames += arr.length;
    if (arr.length > _jsStats.maxBatch) _jsStats.maxBatch = arr.length;
    // [2026-10-20 perf-js] Lote grande (replay do resume: até 200 eventos, cada
    // chat_message com 5–7 ouvintes) rodava inteiro num tick só → trava de
    // centenas de ms a segundos na volta do 2º plano. Agora: fila FIFO, fatias
    // de ~12 ms e o resto no próximo tick (toque/quadro passam no meio). Ordem
    // preservada (lote novo entra no fim da fila). Fechar o socket drena a fila
    // antes (nada se perde). Kill switch: globalThis.__chatyy_ws_slice = false.
    let slice = true;
    try { slice = globalThis.__chatyy_ws_slice !== false; } catch {}
    if (!this._q) this._q = [];
    for (let i = 0; i < arr.length; i++) this._q.push(arr[i]);
    if (this._qTimer) return; // fatia já agendada consome o novo lote
    this._drain(slice ? SLICE_MS : 0, t0);
  }

  // budgetMs 0 = tudo agora (sem fatiar).
  _drain(budgetMs, t0) {
    if (this._draining) return; // reentrante (handler que fecha/reabre): o laço de fora segue
    this._draining = true;
    const start = t0 || Date.now();
    try {
      const q = this._q || [];
      let n = 0;
      while (q.length) {
        if (this.readyState === 3) { q.length = 0; break; }
        const cb = this.onmessage;
        if (!cb) { q.length = 0; break; }
        const obj = q.shift();
        n++;
        try { cb({ data: null, __obj: obj }); } catch {}
        if (budgetMs > 0 && q.length && Date.now() - start >= budgetMs) {
          _jsStats.slices = (_jsStats.slices || 0) + 1;
          this._qTimer = setTimeout(() => { this._qTimer = null; this._drain(budgetMs, 0); }, 0);
          break;
        }
      }
      const dt = Date.now() - start;
      _jsStats.jsMsTotal += dt;
      if (dt > _jsStats.jsMsMax) _jsStats.jsMsMax = dt;
      if (n >= 30 || dt >= 30) { try { require('./perfTrace').traceSpan('nt:batch', dt); } catch {} }
    } finally {
      this._draining = false;
    }
  }

  // Processa já o que estiver na fila (antes de fechar).
  _flushQueue() {
    if (this._qTimer) { clearTimeout(this._qTimer); this._qTimer = null; }
    if (this._q && this._q.length && this.readyState !== 3) this._drain(0, 0);
  }

  _onState(ev) {
    // [perf-js] estado nunca passa na frente de frames já recebidos
    try { if (this._q && this._q.length && !this._draining) this._flushQueue(); } catch {}
    const st = ev.state;
    if (st === 'open' && this.readyState === 0) {
      this.readyState = 1;
      try { this.onopen && this.onopen({}); } catch {}
      return;
    }
    if (st === 'closed' || st === 'failed') {
      if (this.readyState === 3) return;
      try { if (!this._draining) this._flushQueue(); } catch {}
      if (this.readyState === 3) return;
      this.readyState = 3;
      _sockets.delete(this.sid);
      if (st === 'failed') markNativeTransportBroken(ev.reason || 'failed');
      const code = st === 'failed' ? 4990 : (Number(ev.code) || 1006);
      try { this.onerror && this.onerror({ message: ev.reason || st }); } catch {}
      try { this.onclose && this.onclose({ code, reason: String(ev.reason || ''), wasClean: false }); } catch {}
      return;
    }
    try { this.onnativestate && this.onnativestate(ev); } catch {}
  }
}

export default { isNativeTransportEnabled, createNativeSocket, getNativeTransportStats, markNativeTransportBroken, nativeTransportVersion };
