// services/netQuality.js — [F-Q0 quic-noise 2026-10-23] MEDIR reconexões e trocas de rede
// reais ANTES de construir QUIC/Noise.
//
// O que mede (só metadados, nunca conteúdo, nunca SSID/IP/e-mail/ids de mensagem):
//   gap  — janela SEM socket utilizável: do instante em que o socket deixou de servir
//          (queda/close/ping morto/troca de rede/2º plano) até reconectar E autenticar.
//          Causa (c): net | bg | close | ping | probe | timeout | srv | replaced | boot | other,
//          detalhe (d: close code ou motivo curto do nativo), tipo de troca de rede (nk),
//          plataforma/região/transporte, envios tocados durante a janela e quanto esperaram.
//   net  — troca de rede (w2c/c2w/ssid/ip/gen/down/up/x2y): o socket SOBREVIVEU (surv)?
//          (é exatamente o que a migração de conexão do QUIC resolveria).
//   hs   — handshake WS: total, connect (TCP+TLS+upgrade), auth, e no Android nativo
//          (próximo build) dns/tcp/tls separados + RTT do ping → nº de RTTs gastos.
//   sum  — resumo: tempo em 1º plano, envios totais/afetados, janelas.
//
// Canal: o coletor de telemetria que o app JÁ usa (callkit_diag → /var/mail/_native_diag/
// AAAA-MM-DD.jsonl, kind 'netq', usuário = hash, rate-limit no servidor). Relatório:
// /root/quic-noise-2026-10-23/fq0/relatorio.sh.
//
// Consentimento/kill (mesmos do app): sem login = nada (callkit_diag exige auth) ·
// globalThis.__chatyy_native_telemetry === false · client-lb cfg.beacon === false ·
// kill próprio globalThis.__chatyy_netq === false (OTA) · amostra por sessão =
// globalThis.__chatyy_netq_sample (0..1) > client-lb cfg.netq (servidor, 0 = desliga) > 0.5.
// Modo economia de bateria/dados → não envia.

const SAMPLE_DEFAULT = 0.5;
const NET_ATTRIB_MS = 15000;     // queda até 15 s depois de uma troca de rede = causada pela troca
const NET_SURVIVE_MS = 20000;    // socket que passa 20 s vivo depois da troca = sobreviveu
const FG_ATTRIB_MS = 6000;       // queda até 6 s depois de voltar ao 1º plano = herança do 2º plano
const LATE_SEND_MS = 90000;      // janela fechada espera envios atrasados (✓ depois do reconnect)
const GAP_MAX_MS = 30 * 60 * 1000;
const MAX_WAITS = 8;
const ROWS_PER_POST = 10;
const MAX_ROWS_SESSION = 240;
const FLUSH_IDLE_MS = 5 * 60 * 1000;

const _rx = (s, n = 24) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').slice(0, n);
const _int = (v) => { const x = Number(v); return Number.isFinite(x) ? Math.max(-1, Math.round(x)) : -1; };

/** Tipo de troca de rede a partir de 2 fotos do networkInfo (só compara; nada sai do aparelho). */
export function netChangeKind(prev, next) {
  if (!prev || !next) return null;
  const pu = prev.isConnected !== false, nu = next.isConnected !== false;
  if (pu && !nu) return 'down';
  if (!pu && nu) return 'up';
  if (!nu) return null;
  const pt = _netClass(prev.type), nt = _netClass(next.type);
  if (pt !== nt) {
    if (pt === 'w' && nt === 'c') return 'w2c';
    if (pt === 'c' && nt === 'w') return 'c2w';
    if (pt === 'u' || nt === 'u') return null; // 'unknown' no boot não é troca
    return pt + '2' + nt;
  }
  if (nt === 'w' && prev.ssid && next.ssid && prev.ssid !== next.ssid) return 'ssid';
  if (nt === 'w' && prev.bssid && next.bssid && prev.bssid !== next.bssid) return 'bssid';
  if (prev.ipAddress && next.ipAddress && prev.ipAddress !== next.ipAddress) return 'ip';
  if (nt === 'c' && prev.cellularGeneration && next.cellularGeneration && prev.cellularGeneration !== next.cellularGeneration) return 'gen';
  return null;
}
function _netClass(t) {
  if (t === 'wifi' || t === 'ethernet') return 'w';
  if (t === 'cellular') return 'c';
  if (t === 'vpn') return 'v';
  if (t === 'none') return 'n';
  return 'u';
}
function _netShort(st) {
  if (!st) return '';
  if (st.isConnected === false) return 'none';
  const c = _netClass(st.type);
  if (c === 'c') return st.cellularGeneration ? 'c' + String(st.cellularGeneration).replace(/[^0-9g]/gi, '').toLowerCase() : 'cell';
  return c === 'w' ? 'wifi' : (c === 'v' ? 'vpn' : 'unk');
}

/** Classe de causa a partir do motivo do websocket.js / transporte nativo. */
export function causeOf(why, code) {
  const w = String(why || '').toLowerCase();
  const c = Number(code) || 0;
  if (c === 4002 || /replaced/.test(w)) return 'replaced';
  if (/net_(up|change|down|event)|offline|no_network/.test(w)) return 'net';
  if (/foreground|visible|appstate|paused|background|bg_/.test(w)) return 'bg';
  if (/pong|ping|zombie|heartbeat/.test(w)) return 'ping';
  if (/probe|warm_|ensurehealthy/.test(w)) return 'probe';
  if (/timeout|watchdog/.test(w)) return 'timeout';
  if (/auth|token|http_4|handshake/.test(w)) return 'auth';
  if (c === 1000 || c === 1001 || c === 1012 || c === 1013 || (c >= 4000 && c < 5000)) return 'srv';
  if (c === 1006 || /failure|eof|reset|abort|close/.test(w)) return 'close';
  return 'other';
}

/** Núcleo puro (relógio injetável → testável em node: tests/netQuality/sim.mjs). */
export class NetQCore {
  constructor({ now = () => Date.now(), ctx = () => ({}) } = {}) {
    this.now = now;
    this.ctx = ctx;              // () => { reg, tr, net, rtt }
    this.up = false;
    this.fg = true;
    this.fgAt = 0;
    this.gap = null;             // janela aberta
    this.recent = [];            // janelas fechadas esperando envios atrasados
    this.netEv = [];             // trocas de rede aguardando veredito (sobreviveu?)
    this.lastNet = null;         // { at, kind }
    this.rows = [];
    this.total = 0;
    this.sum = { fgMs: 0, sends: 0, aff: 0, gaps: 0, gapMs: 0, net: 0, netDrop: 0, since: this.now() };
    this.fgSince = this.now();
  }

  _push(row) {
    if (this.total >= MAX_ROWS_SESSION) return;
    this.total++;
    this.rows.push(row);
  }

  /** Socket começou "não utilizável" (boot). */
  boot(authed) {
    if (authed) { this.up = true; return; }
    this._open('boot', '', null);
  }

  _open(c, d, nk, t0) {
    const x = this.ctx() || {};
    this.gap = {
      t0: t0 || this.now(), c, d: _rx(d, 24), nk: nk || '', reg: x.reg || '', tr: x.tr || '',
      net0: x.net || '', fg: this.fg ? 1 : 0, off: 0, offAt: 0, sends: [], att: 0,
    };
  }

  /** Socket deixou de servir. why = motivo (ensureConnected/close/nativo), code = close code. */
  drop(why, code) {
    const t = this.now();
    if (!this.up) {
      if (this.gap) this.gap.att++;
      return;
    }
    this.up = false;
    // Some no 2º plano: a janela começa na volta ao 1º plano (ver foreground()).
    if (!this.fg) { this._bgLost = true; return; }
    let c = causeOf(why, code);
    let nk = null;
    let t0 = t;
    const ln = this.lastNet;
    if (ln && t - ln.at <= NET_ATTRIB_MS && c !== 'replaced' && c !== 'auth') {
      // half-open depois da troca: o socket morreu NA troca, não quando o ping percebeu
      nk = ln.kind; t0 = Math.max(ln.at, t - NET_ATTRIB_MS);
      if (c !== 'net') c = 'net';
    } else if (this.fgAt && t - this.fgAt <= FG_ATTRIB_MS) {
      c = 'bg'; t0 = this.fgAt;
    }
    for (const e of this.netEv) if (e.surv < 0 && t - e.at <= NET_ATTRIB_MS) { e.surv = 0; e.dms = t - e.at; }
    const d = (code ? String(code) + '_' : '') + String(why || '');
    this._open(c, d, nk, t0);
  }

  /** Reconectou E autenticou. info: { nrm (reconnectMs do nativo) }. */
  authed(info) {
    const t = this.now();
    this.up = true;
    this._bgLost = false;
    const g = this.gap;
    this.gap = null;
    if (!g) return;
    if (g.offAt) { g.off += t - g.offAt; g.offAt = 0; }
    const x = this.ctx() || {};
    const ms = t - g.t0;
    if (ms < 0 || ms > GAP_MAX_MS) return;
    g.t1 = t; g.ms = ms; g.end = 'up'; g.reg2 = x.reg || ''; g.net1 = x.net || ''; g.tr2 = x.tr || '';
    if (info && typeof info.nrm === 'number' && info.nrm >= 0) g.nrm = Math.round(info.nrm);
    if (g.fg) { this.sum.gaps++; this.sum.gapMs += ms; }
    g.flushAt = t + LATE_SEND_MS;
    this.recent.push(g);
  }

  /** Troca de rede vista pelo SO (kind de netChangeKind). */
  netChange(kind) {
    if (!kind) return;
    const t = this.now();
    this.lastNet = { at: t, kind };
    if (kind === 'up') {
      if (this.gap && this.gap.offAt) { this.gap.off += t - this.gap.offAt; this.gap.offAt = 0; }
    } else if (kind === 'down') {
      if (this.gap && !this.gap.offAt) this.gap.offAt = t;
    }
    if (!this.fg) return;
    this.sum.net++;
    const x = this.ctx() || {};
    this.netEv.push({ at: t, k: kind, up: this.up ? 1 : 0, surv: this.up ? -1 : -2, dms: -1, net: x.net || '', reg: x.reg || '', tr: x.tr || '' });
    if (this.netEv.length > 20) this.netEv.shift();
    if (kind === 'down' && this.up) this.drop('net_down', 0);
  }

  background() {
    const t = this.now();
    if (this.fg) this.sum.fgMs += t - this.fgSince;
    this.fg = false;
    // janela aberta no 1º plano e cortada pelo 2º plano: registra (end=bg), fora do p50
    const g = this.gap;
    if (g && g.fg) {
      if (g.offAt) { g.off += t - g.offAt; g.offAt = 0; }
      g.t1 = t; g.ms = t - g.t0; g.end = 'bg'; g.flushAt = t;
      this.recent.push(g);
      this.gap = null;
    } else if (g) {
      this.gap = null;
    }
    this._verdictNet(true);
  }

  foreground(authed) {
    const t = this.now();
    this.fg = true;
    this.fgAt = t;
    this.fgSince = t;
    if (authed) { this.up = true; return; }
    this.up = false;
    if (!this.gap) this._open('bg', this._bgLost ? 'lost_in_bg' : 'fg_dead', null, t);
    this._bgLost = false;
  }

  /** Um envio (texto/mídia): tapAt = toque, ackAt = ✓ do servidor. */
  send(tapAt, ackAt, kind) {
    if (!(tapAt > 0) || !(ackAt >= tapAt)) return;
    this.sum.sends++;
    const hit = (g, t1) => tapAt <= t1 && ackAt >= g.t0;
    let g = null;
    if (this.gap && hit(this.gap, this.now())) g = this.gap;
    else for (let i = this.recent.length - 1; i >= 0; i--) { if (hit(this.recent[i], this.recent[i].t1)) { g = this.recent[i]; break; } }
    if (!g) return;
    this.sum.aff++;
    if (g.sends.length < 64) g.sends.push({ w: ackAt - tapAt, k: kind === 'media' ? 'm' : 't', pre: tapAt < g.t0 ? 1 : 0 });
  }

  hs(ev) {
    if (!ev || typeof ev.ms !== 'number' || ev.ms < 0 || ev.ms > 120000) return;
    const x = this.ctx() || {};
    const r = { e: 'hs', ms: _int(ev.ms), cn: _int(ev.connectMs), au: _int(ev.authMs), tr: _rx(ev.transport || x.tr, 8), reg: x.reg || '', net: x.net || '', rtt: _int(x.rtt), att: _int(ev.attempt), pr: ev.precise ? 1 : 0 };
    if (ev.dnsMs != null) r.dns = _int(ev.dnsMs);
    if (ev.tcpMs != null) r.tcp = _int(ev.tcpMs);
    if (ev.tlsMs != null) r.tls = _int(ev.tlsMs);
    if (ev.connReused != null) r.ru = ev.connReused ? 1 : 0;
    r.fg = this.fg ? 1 : 0;
    this._push(r);
  }

  _verdictNet(force) {
    const t = this.now();
    const keep = [];
    for (const e of this.netEv) {
      if (e.surv === -1 && (force || t - e.at >= NET_SURVIVE_MS)) e.surv = (force && t - e.at < NET_SURVIVE_MS) ? -3 : 1;
      if (e.surv === -1) { keep.push(e); continue; }
      if (e.surv === 0) this.sum.netDrop++;
      // surv: 1 sobreviveu · 0 caiu (dms = ms até cair) · -2 já estava sem socket · -3 indefinido (2º plano)
      this._push({ e: 'net', k: e.k, up: e.up, surv: e.surv, dms: e.dms, net: e.net, reg: e.reg, tr: e.tr });
    }
    this.netEv = keep;
  }

  /** Move pro buffer de saída o que já tem veredito. force = app indo pro fundo. */
  tick(force) {
    const t = this.now();
    this._verdictNet(!!force);
    const keep = [];
    for (const g of this.recent) {
      if (!force && t < g.flushAt) { keep.push(g); continue; }
      const ws = g.sends.map((s) => s.w).sort((a, b) => a - b);
      const r = {
        e: 'gap', c: g.c, d: g.d, nk: g.nk, ms: _int(g.ms), end: g.end, fg: g.fg, off: _int(g.off),
        reg: g.reg, reg2: g.reg2 || '', tr: g.tr, tr2: g.tr2 || '', net0: g.net0, net1: g.net1 || '', att: g.att,
        ns: g.sends.length, nm: g.sends.filter((s) => s.k === 'm').length, npre: g.sends.filter((s) => s.pre).length,
        wmax: ws.length ? _int(ws[ws.length - 1]) : -1, w: ws.slice(-MAX_WAITS).map(_int),
      };
      if (g.nrm != null) r.nrm = _int(g.nrm);
      this._push(r);
    }
    this.recent = keep;
  }

  summary() {
    const t = this.now();
    const s = this.sum;
    const fgMs = s.fgMs + (this.fg ? t - this.fgSince : 0);
    const r = { e: 'sum', fgs: Math.round(fgMs / 1000), sends: s.sends, aff: s.aff, gaps: s.gaps, gapms: s.gapMs, net: s.net, netdrop: s.netDrop, up: this.up ? 1 : 0 };
    this.sum = { fgMs: 0, sends: 0, aff: 0, gaps: 0, gapMs: 0, net: 0, netDrop: 0, since: t };
    if (this.fg) this.fgSince = t;
    if (r.fgs <= 0 && !r.sends && !r.gaps && !r.net) return;
    this._push(r);
  }

  take(n) { return this.rows.splice(0, n || this.rows.length); }
}

// ── Ligação com o app (React Native) ───────────────────────────────────────
let _core = null;
let _started = false;
let _rnd = Math.random();
let _flushTimer = null;
let _tickTimer = null;
let _lastNetSnap = null;

function _killed() {
  try {
    if (globalThis.__chatyy_netq === false) return true;
    if (globalThis.__chatyy_native_telemetry === false) return true;
  } catch {}
  return false;
}
function _rate() {
  try { const o = globalThis.__chatyy_netq_sample; if (typeof o === 'number' && o >= 0 && o <= 1) return o; } catch {}
  try {
    const l = require('./clientLb').getList?.();
    if (l && l.cfg) {
      if (l.cfg.beacon === false) return 0;
      if (typeof l.cfg.netq === 'number' && l.cfg.netq >= 0) return l.cfg.netq;
    }
  } catch {}
  return SAMPLE_DEFAULT;
}
function _ws() { try { return require('./websocket').default; } catch { return null; } }
function _ctx() {
  const o = {};
  try {
    const w = _ws();
    if (w) {
      o.reg = String(w.effRegion || '').slice(0, 8);
      o.tr = String(w.transportKind || '').slice(0, 8);
      // [quic-noise rollout 2026-10-24] fio físico do nativo: 'quic' separa a telemetria do QUIC da do WSS (gates do rollout)
      if (o.tr === 'native') { try { if (require('./quicProto').currentWire() === 'quic') o.tr = 'quic'; } catch {} }
      const l = Number(w._latency);
      if (l > 0) o.rtt = Math.min(99999, Math.round(l));
    }
  } catch {}
  try { o.net = _netShort(require('./networkInfo').getNetworkState?.()); } catch {}
  return o;
}

function _flush(why) {
  if (!_core) return;
  try {
    _core.tick(why === 'bg');
    if (why === 'bg' || why === 'idle') _core.summary();
  } catch {}
  if (_killed() || !(_rnd < _rate())) { _core.take(); return; }
  try { if (require('./clientLb').isEconomy?.()) { _core.take(); return; } } catch {}
  let send = null;
  try { send = require('./nativeTelemetry').telemetrySend; } catch {}
  if (typeof send !== 'function') { _core.take(); return; }
  let guard = 0;
  while (_core.rows.length && guard++ < 6) {
    if (why !== 'bg' && _core.rows.length < ROWS_PER_POST && why !== 'idle') break;
    const rows = _core.take(ROWS_PER_POST);
    const kinds = {};
    for (const r of rows) kinds[r.e] = (kinds[r.e] || 0) + 1;
    try { send('netq', 'netq v1 ' + Object.keys(kinds).map((k) => k + ':' + kinds[k]).join(' '), { v: 1, rows }); } catch {}
  }
}

/** Chamado pelo websocket.js quando um socket que ESTAVA autenticado deixa de servir. */
export function nqDrop(why, code) {
  if (!_core || _killed()) return;
  try { _core.drop(why, code); } catch {}
}

/** Chamado pelo nativeTelemetry (send_ack/media_send). */
export function nqSend(tapAt, ackAt, kind) {
  if (!_core || _killed()) return;
  try { _core.send(tapAt, ackAt, kind); } catch {}
}

export function startNetQuality() {
  if (_started) return;
  let RN = null;
  try { RN = require('react-native'); } catch { return; }
  const OS = RN && RN.Platform && RN.Platform.OS;
  if (OS !== 'ios' && OS !== 'android') return;
  if (_killed()) return;
  _started = true;
  _core = new NetQCore({ ctx: _ctx });
  const w = _ws();
  try {
    const act = RN.AppState.currentState;
    _core.fg = act === 'active' || act == null;
  } catch {}
  try { _core.boot(!!(w && w.authenticated)); } catch {}
  try {
    if (w && typeof w.on === 'function') {
      w.on('connection', (e) => {
        try {
          if (!e) return;
          if (e.status === 'authenticated') {
            let nrm;
            try { const v = w._lastNativeReconnectMs; if (w.transportKind === 'native' && typeof v === 'number') nrm = v; } catch {}
            _core.authed({ nrm });
          } else if (e.status === 'disconnected' || e.status === 'offline' || e.status === 'session_replaced') {
            _core.drop(e.status === 'session_replaced' ? 'session_replaced' : (e.reason || e.status), e.code || (e.status === 'session_replaced' ? 4002 : 0));
          }
        } catch {}
      });
      w.on('ws_handshake', (ev) => { try { _core.hs(ev); } catch {} });
    }
  } catch {}
  try {
    const ni = require('./networkInfo');
    _lastNetSnap = ni.getNetworkState?.() || null;
    ni.onNetworkChange?.((st) => {
      try {
        if (!st) return;
        const k = netChangeKind(_lastNetSnap, st);
        _lastNetSnap = { ...st };
        if (k) _core.netChange(k);
      } catch {}
    });
  } catch {}
  try {
    RN.AppState.addEventListener('change', (s) => {
      try {
        if (s === 'inactive') return;
        if (s === 'active') {
          if (!_core.fg) _core.foreground(!!(_ws()?.authenticated));
        } else if (s === 'background') {
          if (_core.fg) { _core.background(); _flush('bg'); }
        }
      } catch {}
    });
  } catch {}
  // reconciliação barata (perdeu um evento? o estado real do socket manda) + lote parcial
  _tickTimer = setInterval(() => {
    try {
      if (!_core.fg) return;
      const a = !!(_ws()?.authenticated);
      if (a && !_core.up) _core.authed({});
      else if (!a && _core.up) _core.drop('silent', 0);
      _core.tick(false);
      _flush('tick');
    } catch {}
  }, 20000);
  _flushTimer = setInterval(() => { try { if (_core.fg) _flush('idle'); } catch {} }, FLUSH_IDLE_MS);
}

export function _debugNetQ() {
  return _core ? { up: _core.up, fg: _core.fg, gap: _core.gap, rows: _core.rows.length, total: _core.total, sum: _core.sum, rate: _rate(), sampled: _rnd < _rate() } : null;
}

export default { startNetQuality, nqDrop, nqSend, netChangeKind, causeOf, NetQCore, _debugNetQ };
