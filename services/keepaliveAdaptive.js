// services/keepaliveAdaptive.js — [ka-adapt 2026-10-24] keepalive ADAPTATIVO por rede (tipo WhatsApp).
//
// Problema: o intervalo de ping era fixo (idle 20 s no app + ping de protocolo do hub a cada 25 s +
// TCP keepalive 30 s do nginx US) → o rádio LTE/5G acordava a cada ~20-25 s mesmo quando o NAT da
// operadora/roteador aguenta minutos. Aqui o app DESCOBRE quanto tempo de enlace mudo cada rede
// aguenta e pinga só um pouco antes disso.
//
// Algoritmo (por rede; chave = Wi-Fi: hash SSID/BSSID ou hash do IP público /24 (client-lb);
// celular: ASN da operadora (client-lb) + geração 4G/5G; nada sai do aparelho em claro):
//   • começa em START (25 s = o que já funciona hoje p/ todo mundo) e só sobe com PROVA:
//     prova "ok" = pong de um ping que saiu depois de `idle` ms SEM nenhum pacote no enlace
//     (o nativo v7 mede `idle` = ping − último frame recebido/enviado). NEED provas seguidas no
//     candidato → sobe (×1,5 até achar a 1ª queda; depois busca binária entre o maior ok e a menor
//     queda) até HI (270 s);
//   • prova "queda" = ping que saiu após ≥ 80 % do candidato mudo e NÃO voltou (pong_deadline),
//     em 1º plano contínuo e sem troca de rede recente → fail = idle; recua para o maior ok
//     (ou 90 % da queda) e trava quando ok e fail estão perto (≤ max(10 s, 25 %));
//   • travado: usa max(LO, min(ok, 0,9 × fail)); a cada 3 dias sem queda reabre a busca
//     (o NAT da rede pode ter mudado); 2 quedas no valor travado em 30 min → ok × 0,7.
//   • NUNCA aprende sem ka_ack do servidor nesta conexão física: sem o ack o hub/leaf ainda pinga a
//     cada 25 s e a "prova" seria falsa. O ack traz o teto (ms) que o servidor aceitou (QUIC: 45 s
//     enquanto o MaxIdleTimeout do leaf for 60 s).
//
// Limites: LO 20 s · HI 270 s (servidor: KA_MIN_MS/KA_MAX_MS) · teto do binário: kaCaps().maxMs
// (nativo v7 = 300 s; binário antigo sem kaCaps → recurso inativo no fio nativo).
//
// Liga/desliga: globalThis.__chatyy_ka_adapt === false → desliga (OTA/console); === true → liga p/
// qualquer conta (QA); senão só a allowlist (duarte/suporte/apitest/qa2). O servidor tem o próprio
// interruptor + allowlist (/etc/chatyy-ka.flags) — sem ka_ack nada muda.
//
// Telemetria (kind 'ka', canal nativeTelemetry → /var/mail/_native_diag): por tipo de rede, o
// intervalo escolhido, provas ok/queda, quedas evitadas (estirões de ociosidade real ≥ fail que o
// keepalive segurou), pings feitos × pings que o intervalo fixo de 20 s teria feito.

export const KA_LO = 20000;
export const KA_HI = 270000;
export const KA_START = 25000;
const NEED = 2;
const LOCK_GAP_MIN = 10000;
const LOCK_GAP_FRAC = 0.25; // trava quando a menor queda está a ≤ 25 % do maior ok (cada sonda acima do NAT custa 1 queda)
const REOPEN_MS = 3 * 24 * 3600 * 1000;
const NET_SETTLE_MS = 15000;
const MAX_KEYS = 32;
const STORE_KEY = 'ka_adapt_v1';
const FLUSH_MS = 10 * 60 * 1000;
const BASE_IV = 20000; // intervalo idle de antes (comparação de bateria)
export const KA_ALLOW = ['duarte@chatyy.com.br', 'suporte@chatyy.com.br', 'apitest@onemundo.com.br', 'qa2@chatyy.com.br'];

const _clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Núcleo puro (testável): estado por rede + decisões. now() injetável. */
export class KaCore {
  constructor(opts = {}) {
    this.now = opts.now || (() => Date.now());
    this.lo = opts.lo || KA_LO;
    this.hi = opts.hi || KA_HI;
    this.nets = opts.nets && typeof opts.nets === 'object' ? opts.nets : {};
  }

  _e(key) {
    let e = this.nets[key];
    if (!e || typeof e !== 'object') {
      e = { cand: KA_START, ok: 0, fail: 0, okN: 0, lock: 0, at: this.now(), lockAt: 0, deadAt: 0, deadN: 0 };
      this.nets[key] = e;
      this._prune();
    }
    return e;
  }

  _prune() {
    const ks = Object.keys(this.nets);
    if (ks.length <= MAX_KEYS) return;
    ks.sort((a, b) => (this.nets[a].at || 0) - (this.nets[b].at || 0));
    for (const k of ks.slice(0, ks.length - MAX_KEYS)) delete this.nets[k];
  }

  /** Intervalo a usar nesta rede, já com o teto (servidor/binário). */
  interval(key, cap) {
    const e = this._e(key);
    const hi = Math.min(this.hi, cap || this.hi);
    if (e.lock && e.lockAt && this.now() - e.lockAt > REOPEN_MS && !(e.deadAt && this.now() - e.deadAt < REOPEN_MS)) {
      // reabre a busca: a menor queda "envelhece" 25 % (o NAT pode ter mudado)
      e.lock = 0; e.fail = e.fail ? Math.round(e.fail * 1.25) : 0; e.okN = 0;
      e.cand = this._next(e);
    }
    return _clamp(Math.round(e.cand), this.lo, Math.max(this.lo, hi));
  }

  _next(e) {
    if (e.fail) {
      const gap = e.fail - e.ok;
      if (gap <= Math.max(LOCK_GAP_MIN, e.ok * LOCK_GAP_FRAC)) return this._locked(e);
      return Math.round((e.ok + e.fail) / 2);
    }
    return Math.min(this.hi, Math.max(e.ok + 15000, Math.round(e.ok * 1.5)));
  }

  _locked(e) {
    e.lock = 1; e.lockAt = this.now();
    return Math.max(this.lo, Math.min(e.ok || this.lo, e.fail ? Math.round(e.fail * 0.9) : this.hi));
  }

  /** Pong de um ping que saiu após `idle` ms de enlace mudo. → 'up' | 'ok' | null */
  ok(key, idle, cap) {
    if (!(idle > 0)) return null;
    const e = this._e(key);
    e.at = this.now();
    const hi = Math.min(this.hi, cap || this.hi);
    if (idle >= this.lo * 0.9 && idle > e.ok) e.ok = Math.min(idle, hi * 1.2);
    if (e.fail && e.ok >= e.fail) e.fail = 0; // queda antiga desmentida (rede mudou p/ melhor)
    if (idle < e.cand * 0.9) return null; // tráfego real no meio: não prova o candidato
    e.okN += 1;
    if (e.lock) return 'ok';
    if (e.okN >= NEED) {
      e.okN = 0;
      const nx = Math.min(hi, this._next(e));
      if (nx > e.cand) { e.cand = nx; return 'up'; }
      if (!e.lock && e.cand >= hi) { e.lock = 1; e.lockAt = this.now(); }
    }
    return 'ok';
  }

  /** Ping que saiu após `idle` ms mudo e morreu. ctx.fgMs = 1º plano contínuo; ctx.netAgoMs = desde a troca de rede. → 'down' | null */
  dead(key, idle, ctx = {}) {
    const e = this._e(key);
    if (!(idle > 0) || idle < e.cand * 0.8 || idle < this.lo * 0.9) return null; // queda com tráfego recente = não é NAT
    if (typeof ctx.fgMs === 'number' && ctx.fgMs < idle) return null;            // passou pelo 2º plano
    if (typeof ctx.netAgoMs === 'number' && ctx.netAgoMs < idle + NET_SETTLE_MS) return null; // troca de rede
    const t = this.now();
    e.at = t;
    const repeat = e.lock && e.deadAt && t - e.deadAt < 30 * 60 * 1000;
    e.deadN = repeat ? e.deadN + 1 : 1;
    e.deadAt = t;
    e.fail = e.fail ? Math.min(e.fail, idle) : idle;
    if (e.ok >= idle) e.ok = Math.max(this.lo, Math.round(idle * 0.5));      // NAT encolheu: redescobre da metade
    else if (e.deadN >= 2) e.ok = Math.max(this.lo, Math.round(e.ok * 0.7)); // 2 quedas no valor travado
    e.okN = 0;
    e.lock = 0;
    const back = Math.max(this.lo, Math.min(e.ok || this.lo, Math.round(e.fail * 0.9)));
    const gap = e.fail - e.ok;
    e.cand = back;
    if (gap <= Math.max(LOCK_GAP_MIN, e.ok * LOCK_GAP_FRAC)) { e.lock = 1; e.lockAt = t; }
    return 'down';
  }

  get(key) { return this.nets[key] || null; }
}

// ─── Integração com o app ────────────────────────────────────────────────────
let _core = null;
let _loaded = false;
let _acct = '';
let _ack = null;          // { ms, q, at } da conexão física atual (null = servidor não aceitou)
let _binCap = 0;          // teto do binário (0 = desconhecido)
let _fgSince = Date.now();
let _hidden = false;
let _netAt = 0;
let _lastKey = null;
let _realAt = Date.now(); // último frame "de verdade" (não ping/pong) — quedas evitadas
let _avoidMark = 0;
let _listeners = new Set();
let _flushTimer = null;
const _stats = {};        // por tipo de rede → contadores da sessão
let _activeSince = 0;

function _mm() { try { return require('./mmkv'); } catch { return null; } }

function _load() {
  if (_loaded) return _core;
  _loaded = true;
  let nets = {};
  try { const raw = _mm()?.getString(STORE_KEY); const p = raw ? JSON.parse(raw) : null; if (p && typeof p === 'object') nets = p; } catch {}
  _core = new KaCore({ nets });
  return _core;
}
let _saveT = null;
function _save() {
  if (_saveT) return;
  _saveT = setTimeout(() => {
    _saveT = null;
    try { _mm()?.setString(STORE_KEY, JSON.stringify(_core ? _core.nets : {})); } catch {}
  }, 2000);
}

/** Liga p/ esta conta? (flag local; o servidor decide de verdade com o ka_ack) */
export function kaEnabled(account) {
  try {
    const g = globalThis.__chatyy_ka_adapt;
    if (g === false) return false;
    const { Platform } = require('react-native');
    if (Platform.OS === 'web') return false; // aba do navegador estrangula timers
    if (g === true) return true;
  } catch { return false; }
  const a = String(account || _acct || '').trim().toLowerCase();
  return KA_ALLOW.includes(a);
}
export function kaSetAccount(a) { _acct = String(a || '').trim().toLowerCase(); }

/** Teto do binário nativo (0 = binário sem kaCaps → no fio nativo o recurso fica inativo). */
export function kaBinaryCap() {
  if (_binCap) return _binCap;
  try {
    const { requireOptionalNativeModule } = require('expo');
    const m = requireOptionalNativeModule('ChatyyTransport');
    const c = m && typeof m.kaCaps === 'function' ? m.kaCaps() : null;
    _binCap = c && Number(c.maxMs) > 0 ? Number(c.maxMs) : -1;
  } catch { _binCap = -1; }
  return _binCap;
}

function _netType(st) {
  if (!st || st.isConnected === false) return 'none';
  if (st.type === 'wifi' || st.type === 'ethernet') return st.type === 'ethernet' ? 'eth' : 'wifi';
  if (st.type === 'cellular') return 'c' + String(st.cellularGeneration || 'x').toLowerCase().replace(/[^a-z0-9]/g, '');
  return String(st.type || 'unknown').slice(0, 8);
}

/** Chave da rede atual → { key, type }. key estável entre sessões; nunca SSID/IP em claro. */
export function kaNetKey() {
  let st = null;
  try { st = require('./networkInfo').getNetworkState() || null; } catch {}
  const type = _netType(st);
  let k = null;
  try {
    const lb = require('./clientLb');
    const nk = lb.netKeys ? lb.netKeys(st) : null;
    if (nk) {
      if (type.startsWith('c')) {
        // celular: a operadora (ASN do client-lb) manda no CGNAT; /24 gira à toa
        const coarse = nk.coarse || nk.key;
        k = coarse ? 'c:' + coarse.replace(/^[a-z]+:/, '') + ':' + type : null;
        if (!k && st && st.carrier) k = 'c:o' + lb.fnv1a(st.carrier) + ':' + type;
      } else if (nk.key) {
        k = type + ':' + nk.key.replace(/^[a-z]+:/, '');
      }
    }
  } catch {}
  return { key: k || ('t:' + type), type };
}

function _st(type) {
  let s = _stats[type];
  if (!s) { s = _stats[type] = { okE: 0, deadE: 0, up: 0, down: 0, avoid: 0, pings: 0, fgMs: 0, iv: 0, key: '' }; }
  return s;
}

function _emitChange(why) { for (const f of _listeners) { try { f(why); } catch {} } }
export function kaOnChange(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }

/** Ativo AGORA (servidor aceitou nesta conexão + flag + binário)? */
export function kaActive(native) {
  if (!_ack || !(_ack.ms > 0)) return false;
  if (native && kaBinaryCap() <= 0) return false;
  return true;
}

function _cap(native) {
  let c = KA_HI;
  if (_ack && _ack.ms > 0) c = Math.min(c, _ack.ms);
  if (native) { const b = kaBinaryCap(); if (b > 0) c = Math.min(c, b); }
  return c;
}

/** Intervalo idle a usar (null = não ativo → o chamador usa o padrão de sempre). */
export function kaIdleInterval(native) {
  if (!kaActive(native)) return null;
  const c = _load();
  const { key, type } = kaNetKey();
  _lastKey = key;
  const iv = c.interval(key, _cap(native));
  const s = _st(type);
  s.iv = iv; s.key = key;
  return iv;
}

/** Frame p/ o servidor depois do auth_success (e quando o intervalo muda). */
export function kaSetFrame(native) {
  let want = KA_START;
  try {
    const c = _load();
    want = c.interval(kaNetKey().key, native ? Math.min(KA_HI, kaBinaryCap() > 0 ? kaBinaryCap() : KA_HI) : KA_HI);
  } catch {}
  return { type: 'ka_set', v: 1, ms: Math.round(want), max: native && kaBinaryCap() > 0 ? Math.min(KA_HI, kaBinaryCap()) : KA_HI };
}

/** ka_ack do hub/leaf. ms>0 = aceito (teto); ms 0/off = servidor não aceitou. */
export function kaOnAck(msg) {
  const ms = Number(msg && msg.ms) || 0;
  const prev = _ack;
  _ack = ms > 0 ? { ms, q: !!(msg && msg.q), at: Date.now() } : null;
  if (_ack && !prev) _activeSince = Date.now();
  _emitChange('ack');
}

/** Conexão física caiu / reconectando: até o próximo ack nada é prova. */
export function kaOnConnLost() {
  if (_ack) { _accFg(); _ack = null; }
}

function _accFg() {
  if (_activeSince && !_hidden) { try { _st(kaNetKey().type).fgMs += Date.now() - _activeSince; } catch {} }
  _activeSince = _ack && !_hidden ? Date.now() : 0;
}

export function kaNoteForeground(fg) {
  _accFg();
  _hidden = !fg;
  if (fg) { _fgSince = Date.now(); _activeSince = _ack ? Date.now() : 0; } else { _activeSince = 0; kaFlush('bg'); }
}
export function kaNoteNetChange() {
  _netAt = Date.now();
  const k = kaNetKey().key;
  if (k !== _lastKey) { _lastKey = k; _emitChange('net'); }
}
/** Frame real (não ping/pong) entrou ou saiu. */
export function kaNoteReal() { _realAt = Date.now(); }

/** Pong com a ociosidade medida. native = fio nativo (idle do nativo). */
export function kaOnPong(idleMs, native) {
  if (!kaActive(native) || _hidden) return;
  const c = _load();
  const { key, type } = kaNetKey();
  const s = _st(type);
  s.pings += 1;
  const fgFor = Date.now() - _fgSince;
  if (!(idleMs > 0) || fgFor < idleMs) return;
  if (_netAt && Date.now() - _netAt < idleMs + NET_SETTLE_MS) return;
  const r = c.ok(key, idleMs, _cap(native));
  if (r) s.okE += 1;
  // queda evitada: estirão de ociosidade REAL ≥ menor queda conhecida que o keepalive segurou (1x por estirão)
  const e = c.get(key);
  if (e && e.fail && Date.now() - _realAt >= e.fail && _avoidMark !== _realAt) { _avoidMark = _realAt; s.avoid += 1; }
  _save();
  if (r === 'up') { s.up += 1; _emitChange('up'); }
}

/** Ping morto (pong_deadline) após idleMs mudo. */
export function kaOnDead(idleMs, native) {
  // Só vale se o servidor tinha aceitado NESTA conexão (o nativo emite 'ka' antes do 'reconnecting').
  if (!kaActive(native)) return;
  const c = _load();
  const { key, type } = kaNetKey();
  const s = _st(type);
  const r = c.dead(key, idleMs, { fgMs: _hidden ? 0 : Date.now() - _fgSince, netAgoMs: _netAt ? Date.now() - _netAt : 1e12 });
  if (r) { s.deadE += 1; s.down += 1; _save(); _emitChange('down'); }
}

/** Telemetria da sessão (só com o recurso ligado nesta conta). */
export function kaFlush(why) {
  try {
    if (!kaEnabled()) return;
    const rows = [];
    for (const t of Object.keys(_stats)) {
      const s = _stats[t];
      if (!s.pings && !s.deadE && !s.fgMs) continue;
      const e = _core && s.key ? _core.get(s.key) : null;
      let n = '';
      try { n = require('./clientLb').fnv1a('ka|' + s.key).slice(0, 6); } catch {}
      rows.push({
        e: 'ka', nt: t, n, iv: s.iv, ok: e ? e.ok : 0, fail: e ? e.fail : 0, lock: e ? e.lock : 0,
        okE: s.okE, deadE: s.deadE, up: s.up, down: s.down, avoid: s.avoid, pings: s.pings,
        base: Math.round(s.fgMs / BASE_IV), fgs: Math.round(s.fgMs / 1000), cap: _ack ? _ack.ms : 0,
        q: _ack && _ack.q ? 1 : 0,
      });
      _stats[t] = { okE: 0, deadE: 0, up: 0, down: 0, avoid: 0, pings: 0, fgMs: 0, iv: s.iv, key: s.key };
    }
    if (!rows.length) return;
    const send = require('./nativeTelemetry').telemetrySend;
    if (typeof send === 'function') send('ka', 'ka v1 ' + why + ' ' + rows.map((r) => r.nt + ':' + Math.round(r.iv / 1000) + 's').join(' '), { v: 1, rows });
  } catch {}
}

export function kaStartTelemetry() {
  if (_flushTimer) return;
  try { _flushTimer = setInterval(() => { _accFg(); kaFlush('timer'); }, FLUSH_MS); } catch {}
}

export function kaDebug() {
  return { ack: _ack, binCap: kaBinaryCap(), key: kaNetKey(), nets: _core ? _core.nets : null, stats: _stats };
}
export function _kaResetForTest() { _core = null; _loaded = false; _ack = null; _binCap = 0; for (const k of Object.keys(_stats)) delete _stats[k]; }
