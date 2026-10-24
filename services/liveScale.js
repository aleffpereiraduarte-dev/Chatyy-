// [live-10k 2026-10-24] LIVE para 10 mil espectadores — lado do app.
//
// 1) liveScaleJoin(): pergunta ao servidor (live-scale.php) como assistir:
//      mode 'hls'    → player HLS do CDN (live.chatyy.com.br, ABR 1080/720/480/240, ~4–5 s de atraso)
//      mode 'webrtc' → LiveKit como hoje (host, convidado, "baixa latência" p/ poucos, ou escada ainda subindo)
//    Sem a flag no servidor (data/.live-scale-on) a resposta é sempre 'webrtc' e nada muda.
// 2) LiveRelay: comentários/corações/contagem pelo relay REGIONAL (wss://<edge>/live/ws), não pelo hub US.
//    O relay devolve 1 lote a cada 0,5 s: até ~24 comentários/s (host/convidado sempre), corações somados,
//    espectadores aproximados. Corações locais saem em lote de 250 ms ({t:'h',n}).
//    Sem relay (flag off, edge fora, ticket negado) o chamador continua no caminho antigo (hub WS + PHP).
import { Platform } from 'react-native';
import * as api from './api';

export async function liveScaleJoin(sessionId, opts = {}) {
  try {
    const p = { session_id: sessionId };
    if (opts.lowLatency) p.low_latency = 1;
    const r = await api.apiCall('live_scale_join', p, 'POST');
    const d = r?.data || null;
    if (!r?.success || !d || d.scale === false) return null;
    return d; // {mode, hls_url?, relay:{ticket,path,exp}, role}
  } catch { return null; }
}

export async function liveScaleTicket(sessionId) {
  try {
    const r = await api.apiCall('live_scale_ticket', { session_id: sessionId }, 'POST');
    return r?.success ? (r.data?.relay || null) : null;
  } catch { return null; }
}

export async function liveScaleHlsStart(sessionId) {
  try { return await api.apiCall('live_scale_hls_start', { session_id: sessionId }, 'POST'); } catch { return null; }
}
export async function liveScaleHlsStop(sessionId) {
  try { return await api.apiCall('live_scale_hls_stop', { session_id: sessionId }, 'POST'); } catch { return null; }
}
export async function liveScaleMod(sessionId, args) {
  try { return await api.apiCall('live_scale_mod', { session_id: sessionId, ...(args || {}) }, 'POST'); } catch { return null; }
}

// wss do relay = mesmo edge que o app já usa p/ o chat (api-<região>); web/US → chatyy.com.br
function relayBase() {
  let b = '';
  try { b = api.getChatBase?.() || ''; } catch {}
  if (!b || Platform.OS === 'web') b = 'https://chatyy.com.br';
  return b.replace(/^http/i, 'ws').replace(/\/+$/, '');
}

export class LiveRelay {
  // handlers: onComment({id,name,content,role,ts}), onHearts(n, total), onViewers(n),
  //           onAck({cid,id,shadow}), onReject({cid,why,wait}), onEnded(), onEvent(ev), onState('open'|'closed')
  constructor(sessionId, relay, handlers = {}) {
    this.sid = sessionId;
    this.relay = relay;
    this.h = handlers;
    this.ws = null;
    this.closed = false;
    this.attempt = 0;
    this.pendingHearts = 0;
    this.heartTimer = null;
    this.mine = new Set(); // ids dos meus comentários (o lote traz de novo → não duplicar)
    this.cid = 0;
    this.lastSeq = 0;
    this.open = false;
  }

  start() { this._connect(); return this; }

  _connect() {
    if (this.closed || !this.relay?.ticket) return;
    const url = relayBase() + (this.relay.path || '/live/ws') + '?t=' + encodeURIComponent(this.relay.ticket);
    let ws;
    try { ws = new WebSocket(url); } catch { this._retry(); return; }
    this.ws = ws;
    ws.onopen = () => { this.open = true; this.attempt = 0; this.h.onState?.('open'); };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } this._on(m); };
    ws.onerror = () => {};
    ws.onclose = (e) => {
      this.open = false;
      this.h.onState?.('closed');
      if (this.closed) return;
      if (e?.code === 4000) { this.h.onEnded?.(); return; } // live acabou
      this._retry();
    };
  }

  async _retry() {
    if (this.closed) return;
    const d = [500, 1000, 2000, 4000, 8000][Math.min(this.attempt, 4)];
    this.attempt += 1;
    // ticket vence em 2 h; a cada 3 falhas renova (cobre 401 por expiração/banimento revisto)
    if (this.attempt % 3 === 0) {
      const nt = await liveScaleTicket(this.sid);
      if (nt?.ticket) this.relay = nt;
    }
    setTimeout(() => this._connect(), d);
  }

  _on(m) {
    switch (m.t) {
      case 'b': {
        if (m.seq && m.seq <= this.lastSeq && this.lastSeq - m.seq < 1000) return;
        this.lastSeq = m.seq || this.lastSeq;
        if (Array.isArray(m.c)) {
          for (const c of m.c) {
            if (this.mine.has(c.id)) { this.mine.delete(c.id); continue; }
            this.h.onComment?.({ id: c.id, name: c.n, content: c.t, role: c.r || 'viewer', ts: c.ts });
          }
        }
        if (m.h) this.h.onHearts?.(m.h, m.ht);
        if (typeof m.v === 'number') this.h.onViewers?.(m.v);
        if (Array.isArray(m.ev)) m.ev.forEach((ev) => this.h.onEvent?.(ev));
        break;
      }
      case 'ack':
        if (m.id) { this.mine.add(m.id); if (this.mine.size > 200) this.mine.delete(this.mine.values().next().value); }
        this.h.onAck?.(m);
        break;
      case 'rej':
        this.h.onReject?.(m);
        break;
      case 'fim':
        this.h.onEnded?.();
        break;
      default:
    }
  }

  isOpen() { return !!(this.ws && this.open && this.ws.readyState === 1); }

  sendComment(text) {
    if (!this.isOpen()) return null;
    const cid = String(++this.cid);
    try { this.ws.send(JSON.stringify({ t: 'c', txt: String(text).slice(0, 200), cid })); } catch { return null; }
    return cid;
  }

  heart(n = 1) {
    this.pendingHearts += n;
    if (this.heartTimer) return;
    this.heartTimer = setTimeout(() => {
      this.heartTimer = null;
      const k = Math.min(this.pendingHearts, 20);
      this.pendingHearts = 0;
      if (k > 0 && this.isOpen()) { try { this.ws.send(JSON.stringify({ t: 'h', n: k })); } catch {} }
    }, 250);
  }

  stop() {
    this.closed = true;
    if (this.heartTimer) { clearTimeout(this.heartTimer); this.heartTimer = null; }
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }
}
