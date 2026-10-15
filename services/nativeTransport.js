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
    for (let i = 0; i < arr.length; i++) {
      if (this.readyState === 3) break;
      const cb = this.onmessage;
      if (!cb) break;
      try { cb({ data: null, __obj: arr[i] }); } catch {}
    }
    const dt = Date.now() - t0;
    _jsStats.batches++;
    _jsStats.frames += arr.length;
    if (arr.length > _jsStats.maxBatch) _jsStats.maxBatch = arr.length;
    _jsStats.jsMsTotal += dt;
    if (dt > _jsStats.jsMsMax) _jsStats.jsMsMax = dt;
  }

  _onState(ev) {
    const st = ev.state;
    if (st === 'open' && this.readyState === 0) {
      this.readyState = 1;
      try { this.onopen && this.onopen({}); } catch {}
      return;
    }
    if (st === 'closed' || st === 'failed') {
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

export default { isNativeTransportEnabled, createNativeSocket, getNativeTransportStats, markNativeTransportBroken };
