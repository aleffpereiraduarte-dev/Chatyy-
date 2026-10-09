// [2026-10-09 p2p-calls] Ligação 1:1 PEER-TO-PEER (WebRTC direto entre os 2
// aparelhos, igual WhatsApp). O SFU LiveKit vira FALLBACK automático.
//
// Sinalização pelo hub Go (/opt/chatyy-ws-go/p2p_signal.go), roteada só entre
// caller/callee de uma CallState ACCEPTED:
//   call_p2p_ready     callee → caller  "estou pronto, manda a oferta"
//   call_p2p_offer     caller → callee  {sdp, gen}
//   call_p2p_answer    callee → caller  {sdp, gen}
//   call_p2p_candidate ambos            {candidates:[...], gen}  (lote ~40ms)
//   call_p2p_restart   callee → caller  "troquei de rede, faz ICE restart"
//   call_p2p_fallback  ambos            "desisti do P2P, vamos p/ o LiveKit"
//
// Regras: só o CALLER cria ofertas (sem glare). Transceivers de áudio E vídeo
// sempre presentes (sendrecv) → ligar câmera no meio = replaceTrack, sem
// renegociar. Opus com FEC+DTX; vídeo VP8/H264 (hw quando houver), sem
// simulcast; banda adaptada pelo GCC do libwebrtc + teto por qualidade.
//
// Flag: chat_livekit_token devolve `p2p: {enabled, connect_timeout_ms, ...}`
// (CALL_P2P / CALL_P2P_ACCOUNTS no /etc/mail-api.env). DESLIGADO por padrão.
import { Platform } from 'react-native';

const P2P_TYPES = ['call_p2p_ready', 'call_p2p_offer', 'call_p2p_answer', 'call_p2p_candidate', 'call_p2p_restart', 'call_p2p_fallback'];
const BUFFER_TTL_MS = 45000;

const _sessions = new Map(); // callId → session
const _buffer = new Map();   // callId → [{msg, ts}] (chegou antes da sessão existir)
let _listenersInstalled = false;

function _ws() {
  try { return require('./websocket').default; } catch { return null; }
}

function _rtc() {
  if (Platform.OS === 'web') {
    const g = typeof globalThis !== 'undefined' ? globalThis : {};
    return {
      RTCPeerConnection: g.RTCPeerConnection,
      RTCSessionDescription: g.RTCSessionDescription,
      RTCIceCandidate: g.RTCIceCandidate,
      MediaStream: g.MediaStream,
      mediaDevices: g.navigator && g.navigator.mediaDevices,
    };
  }
  try {
    const w = require('@livekit/react-native-webrtc');
    return {
      RTCPeerConnection: w.RTCPeerConnection,
      RTCSessionDescription: w.RTCSessionDescription,
      RTCIceCandidate: w.RTCIceCandidate,
      MediaStream: w.MediaStream,
      mediaDevices: w.mediaDevices,
    };
  } catch {
    return {};
  }
}

function _lsGet(k) {
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') return localStorage.getItem(k);
  } catch {}
  return null;
}

function _installListeners() {
  if (_listenersInstalled) return;
  const ws = _ws();
  if (!ws || typeof ws.on !== 'function') return;
  _listenersInstalled = true;
  P2P_TYPES.forEach((type) => {
    ws.on(type, (raw) => {
      const msg = raw && raw.type ? raw : { ...(raw || {}), type };
      const callId = msg && msg.call_id ? String(msg.call_id) : '';
      if (!callId) return;
      const s = _sessions.get(callId);
      if (s) { s._onSignal(msg); return; }
      const now = Date.now();
      const arr = (_buffer.get(callId) || []).filter((e) => now - e.ts < BUFFER_TTL_MS);
      if (arr.length < 80) arr.push({ msg, ts: now });
      _buffer.set(callId, arr);
      if (_buffer.size > 20) {
        for (const [k, v] of _buffer) {
          if (!v.length || now - v[v.length - 1].ts > BUFFER_TTL_MS) _buffer.delete(k);
        }
      }
    });
  });
}

// Chamado cedo (ex.: no mount do /call) p/ não perder ready/offer que chegam
// antes da sessão ser criada.
export function ensureP2PSignalListeners() {
  _installListeners();
}

// Config vinda do chat_livekit_token. Overrides locais (só web, p/ QA):
//   localStorage.chatyy_p2p = 'off' | 'on'
export function resolveP2PConfig(serverCfg) {
  const cfg = serverCfg && typeof serverCfg === 'object' ? serverCfg : null;
  let enabled = !!(cfg && cfg.enabled);
  const ov = _lsGet('chatyy_p2p');
  if (ov === 'off') enabled = false;
  return {
    enabled,
    connectTimeoutMs: Math.max(1500, Math.min(15000, Number(cfg && cfg.connect_timeout_ms) || 4000)),
    readyWaitMs: Math.max(800, Math.min(8000, Number(cfg && cfg.ready_wait_ms) || 2500)),
    reconnectGraceMs: Math.max(3000, Math.min(30000, Number(cfg && cfg.reconnect_grace_ms) || 8000)),
    maxVideoKbps: Math.max(150, Math.min(4000, Number(cfg && cfg.max_video_kbps) || 1500)),
    maxAudioKbps: Math.max(12, Math.min(96, Number(cfg && cfg.max_audio_kbps) || 40)),
    // [2026-10-09] Os coturns de produção só relayam p/ o IP do SFU
    // (allowed-peer-ip) → relay cliente↔cliente dá 403. Por padrão o P2P usa
    // SÓ STUN (host/srflx); sem caminho direto → fallback LiveKit. Quando
    // existir um coturn/realm próprio p/ P2P o servidor manda `turn: true`
    // e/ou `ice_servers` dedicados.
    allowTurn: !!(cfg && cfg.turn),
    iceServers: cfg && Array.isArray(cfg.ice_servers) && cfg.ice_servers.length ? cfg.ice_servers : null,
  };
}

export function isP2PSupported() {
  const r = _rtc();
  return !!(r.RTCPeerConnection && r.mediaDevices && typeof r.mediaDevices.getUserMedia === 'function');
}

// ── SDP ──────────────────────────────────────────────────────────────────
// Opus: FEC in-band + DTX + teto de bitrate (voz), mono. Mantém o que já
// existir no fmtp e só acrescenta o que falta.
function _mungeOpus(sdp, maxAudioKbps) {
  try {
    const m = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp);
    if (!m) return sdp;
    const pt = m[1];
    const re = new RegExp('a=fmtp:' + pt + ' ([^\\r\\n]*)');
    const want = { useinbandfec: '1', usedtx: '1', maxaveragebitrate: String(maxAudioKbps * 1000), stereo: '0' };
    if (re.test(sdp)) {
      return sdp.replace(re, (line, params) => {
        const kv = {};
        params.split(';').forEach((p) => { const [k, v] = p.split('='); if (k) kv[k.trim()] = (v || '').trim(); });
        Object.keys(want).forEach((k) => { if (!(k in kv)) kv[k] = want[k]; });
        return 'a=fmtp:' + pt + ' ' + Object.keys(kv).map((k) => k + '=' + kv[k]).join(';');
      });
    }
    return sdp.replace(m[0], m[0] + '\r\na=fmtp:' + pt + ' ' + Object.keys(want).map((k) => k + '=' + want[k]).join(';'));
  } catch {
    return sdp;
  }
}

function _preferCodecs(transceiver, kind, order) {
  try {
    if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return;
    const g = typeof globalThis !== 'undefined' ? globalThis : {};
    const Caps = g.RTCRtpReceiver && g.RTCRtpReceiver.getCapabilities ? g.RTCRtpReceiver : null;
    let caps = null;
    if (Caps) caps = Caps.getCapabilities(kind);
    if (!caps) {
      try { const w = require('@livekit/react-native-webrtc'); caps = w.RTCRtpReceiver && w.RTCRtpReceiver.getCapabilities && w.RTCRtpReceiver.getCapabilities(kind); } catch {}
    }
    if (!caps || !Array.isArray(caps.codecs) || !caps.codecs.length) return;
    const rank = (c) => {
      const mt = String(c.mimeType || '').toLowerCase();
      const i = order.findIndex((o) => mt === (kind + '/' + o).toLowerCase());
      return i === -1 ? order.length : i;
    };
    const codecs = caps.codecs.slice().sort((a, b) => rank(a) - rank(b));
    transceiver.setCodecPreferences(codecs);
  } catch {}
}

function _trackAdapter(track, kind, MS) {
  if (!track) return null;
  let stream = null;
  try { stream = MS ? new MS([track]) : null; } catch {}
  return {
    sid: 'p2p-' + kind + '-' + (track.id || Math.random().toString(36).slice(2)),
    kind,
    source: kind === 'video' ? 'camera' : 'microphone',
    isP2P: true,
    isMuted: false,
    mediaStreamTrack: track,
    mediaStream: stream,
    attach(el) {
      if (!el) return el;
      try { el.srcObject = stream || (MS ? new MS([track]) : null); } catch {}
      try { const p = el.play && el.play(); if (p && p.catch) p.catch(() => {}); } catch {}
      return el;
    },
    detach(el) {
      if (el) { try { el.srcObject = null; } catch {} }
      return el ? [el] : [];
    },
    on() { return this; },
    off() { return this; },
  };
}

// ── Sessão ───────────────────────────────────────────────────────────────
// opts:
//   callId, isCaller, video (bool), iceServers, cfg (resolveP2PConfig)
//   onRemoteAudio(adapter|null), onRemoteVideo(adapter|null), onLocalVideo(adapter|null)
//   onConnected({ms, stats}), onReconnecting(bool), onFallback(reason), onData(obj), log(evt, data)
export function startP2PSession(opts) {
  _installListeners();
  const callId = String(opts.callId);
  const prev = _sessions.get(callId);
  if (prev) { try { prev.close('replaced'); } catch {} }
  const s = new P2PSession({ ...opts, callId });
  _sessions.set(callId, s);
  const buf = _buffer.get(callId) || [];
  _buffer.delete(callId);
  s._start(buf.filter((e) => Date.now() - e.ts < BUFFER_TTL_MS).map((e) => e.msg));
  return s;
}

export function getP2PSession(callId) {
  return _sessions.get(String(callId)) || null;
}

class P2PSession {
  constructor(o) {
    this.o = o;
    this.callId = o.callId;
    this.isCaller = !!o.isCaller;
    this.cfg = o.cfg || resolveP2PConfig(null);
    this.rtc = _rtc();
    this.pc = null;
    this.state = 'new'; // new → negotiating → connected → (reconnecting) → closed|fallback
    this.gen = 0;
    this.remoteGen = -1;
    this.t0 = Date.now();
    this.connectedAt = 0;
    this.localStream = null;
    this.localAudio = null;
    this.localVideo = null;
    this.audioTx = null;
    this.videoTx = null;
    this.dc = null;
    this._pendingCands = [];
    this._outCands = [];
    this._outTimer = null;
    this._timers = new Set();
    this._readyResolve = null;
    this._gotReady = false;
    this._haveRemote = false;
    this._discTimer = null;
    this._graceTimer = null;
    this._qualityTimer = null;
    this._netUnsub = null;
    this._micEnabled = true;
    this._videoEnabled = !!o.video;
    this._remoteAudioEl = null;
    this._lastQ = 'good';
    this._done = false;
    this.blockCandidates = _lsGet('chatyy_p2p_block') === '1';
    this.forceRelay = _lsGet('chatyy_p2p_relay') === '1';
    this.ready = new Promise((res) => { this._resolveReady = res; });
  }

  _log(evt, data) {
    try { this.o.log && this.o.log(evt, data || {}); } catch {}
  }

  _timeout(fn, ms) {
    const t = setTimeout(() => { this._timers.delete(t); fn(); }, ms);
    this._timers.add(t);
    return t;
  }

  _send(type, extra) {
    const ws = _ws();
    if (!ws) return;
    try { ws._send({ type, call_id: this.callId, gen: this.gen, ...(extra || {}) }); } catch {}
  }

  async _start(buffered) {
    try {
      if (!this.rtc.RTCPeerConnection) throw new Error('no_rtc');
      // Mídia local primeiro (permissão) — mesmo padrão de captura do LiveKit.
      await this._getLocalMedia();
      if (this._done) return;
      this._createPC();
      this._log('p2p_start', { caller: this.isCaller, video: !!this.o.video, ice: (this.o.iceServers || []).length, relay: this.forceRelay, block: this.blockCandidates });
      const armDeadline = (ms) => this._timeout(() => {
        if (this.state !== 'connected' && !this._done) this.fallback('connect_timeout');
      }, ms);
      // Reaplica sinalização que chegou antes da sessão.
      for (const m of buffered) this._onSignal(m);
      if (this.isCaller) {
        if (!this._gotReady) {
          await new Promise((res) => {
            this._readyResolve = res;
            this._timeout(res, this.cfg.readyWaitMs);
          });
        }
        if (this._done) return;
        if (!this._gotReady) { this.fallback('peer_not_ready'); return; }
        // Prazo p/ conectar conta a partir do "pronto" do par.
        armDeadline(this.cfg.connectTimeoutMs);
        await this._makeOffer(false);
      } else {
        armDeadline(this.cfg.connectTimeoutMs + 500);
        // O call_accepted do callee pode chegar ao hub DEPOIS do ready (hub só
        // aceita P2P em ACCEPTED) → reenvia até a oferta chegar.
        const sendReady = (n) => {
          if (this._done || this._haveRemote || n > 6) return;
          this._send('call_p2p_ready');
          this._timeout(() => sendReady(n + 1), 600);
        };
        sendReady(0);
      }
      this._watchNetwork();
    } catch (e) {
      this._log('p2p_start_err', { msg: String((e && e.message) || e).slice(0, 160) });
      this.fallback('start_error');
    }
  }

  async _getLocalMedia() {
    const md = this.rtc.mediaDevices;
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    const video = this.o.video
      ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }
      : false;
    let stream;
    try {
      stream = await md.getUserMedia({ audio, video });
    } catch (e) {
      if (!video) throw e;
      stream = await md.getUserMedia({ audio, video: false });
      this._videoEnabled = false;
    }
    this.localStream = stream;
    this.localAudio = (stream.getAudioTracks() || [])[0] || null;
    this.localVideo = (stream.getVideoTracks() || [])[0] || null;
    if (this.localVideo) {
      try { this.localVideo.contentHint = 'motion'; } catch {}
      try { this.o.onLocalVideo && this.o.onLocalVideo(_trackAdapter(this.localVideo, 'video', this.rtc.MediaStream)); } catch {}
    }
  }

  _createPC() {
    let ice = this.cfg.iceServers || (Array.isArray(this.o.iceServers) ? this.o.iceServers : []);
    if (!this.cfg.allowTurn) {
      ice = ice.map((sv) => {
        const urls = [].concat((sv && sv.urls) || []).filter((u) => /^stun:/i.test(String(u)));
        return urls.length ? { urls } : null;
      }).filter(Boolean);
    }
    // Sem STUN (ex.: token pré-mintado do invite_v2 não traz iceServers) →
    // STUN dos nossos coturns (STUN não passa pela restrição de peer do relay).
    if (!ice.length) ice = [{ urls: ['stun:147.93.12.236:3478', 'stun:turn.chatyy.com.br:3478'] }];
    const cfg = {
      iceServers: ice,
      iceTransportPolicy: this.forceRelay ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 2,
    };
    const pc = new this.rtc.RTCPeerConnection(cfg);
    this.pc = pc;
    // Transceivers fixos (ordem m=audio, m=video) nos DOIS lados.
    if (this.isCaller) {
      this.audioTx = pc.addTransceiver(this.localAudio || 'audio', { direction: 'sendrecv', streams: this.localStream ? [this.localStream] : [] });
      this.videoTx = pc.addTransceiver(this.localVideo || 'video', { direction: 'sendrecv', streams: this.localStream ? [this.localStream] : [] });
      _preferCodecs(this.audioTx, 'audio', ['opus']);
      _preferCodecs(this.videoTx, 'video', Platform.OS === 'web' ? ['VP8', 'H264', 'VP9'] : ['H264', 'VP8', 'VP9']);
      try {
        this.dc = pc.createDataChannel('chatyy', { ordered: true });
        this._wireDC(this.dc);
      } catch {}
    }
    pc.ondatachannel = (ev) => { if (!this.dc && ev && ev.channel) { this.dc = ev.channel; this._wireDC(this.dc); } };
    pc.onicecandidate = (ev) => {
      if (!ev || !ev.candidate) return;
      if (this.blockCandidates) return; // QA: simula P2P bloqueado → fallback
      const c = ev.candidate;
      this._outCands.push({ candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex });
      if (!this._outTimer) {
        this._outTimer = setTimeout(() => {
          this._outTimer = null;
          const batch = this._outCands.splice(0, 24);
          if (batch.length) this._send('call_p2p_candidate', { candidates: batch });
          if (this._outCands.length) { const rest = this._outCands.splice(0); this._send('call_p2p_candidate', { candidates: rest.slice(0, 24) }); }
        }, 40);
      }
    };
    pc.ontrack = (ev) => {
      const tr = ev && ev.track;
      if (!tr) return;
      if (tr.kind === 'audio') {
        const ad = _trackAdapter(tr, 'audio', this.rtc.MediaStream);
        if (Platform.OS === 'web') this._playRemoteAudio(ad);
        try { this.o.onRemoteAudio && this.o.onRemoteAudio(ad); } catch {}
      } else if (tr.kind === 'video') {
        const ad = _trackAdapter(tr, 'video', this.rtc.MediaStream);
        const show = () => { try { this.o.onRemoteVideo && this.o.onRemoteVideo(ad); } catch {} };
        const hide = () => { try { this.o.onRemoteVideo && this.o.onRemoteVideo(null); } catch {} };
        try { tr.onunmute = show; tr.onmute = hide; } catch {}
        if (!tr.muted) show();
      }
    };
    const onState = () => this._onConnState();
    pc.oniceconnectionstatechange = onState;
    pc.onconnectionstatechange = onState;
  }

  _wireDC(dc) {
    try {
      dc.onmessage = (ev) => {
        try {
          const obj = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
          if (obj && obj.__p2p === 'ping') { this._dcSend({ __p2p: 'pong', t: obj.t }); return; }
          if (obj && obj.__p2p === 'pong') return;
          this.o.onData && this.o.onData(obj);
        } catch {}
      };
    } catch {}
  }

  _dcSend(obj) {
    try { if (this.dc && this.dc.readyState === 'open') { this.dc.send(JSON.stringify(obj)); return true; } } catch {}
    return false;
  }

  sendData(obj) {
    return this._dcSend(obj);
  }

  _playRemoteAudio(ad) {
    try {
      if (typeof document === 'undefined') return;
      if (!this._remoteAudioEl) {
        const el = document.createElement('audio');
        el.autoplay = true;
        el.setAttribute('playsinline', '');
        el.setAttribute('data-chatyy-call-audio', 'p2p');
        el.style.display = 'none';
        document.body.appendChild(el);
        this._remoteAudioEl = el;
      }
      ad.attach(this._remoteAudioEl);
    } catch {}
  }

  _isUp() {
    const pc = this.pc;
    if (!pc) return false;
    const cs = pc.connectionState;
    const ics = pc.iceConnectionState;
    if (cs) return cs === 'connected';
    return ics === 'connected' || ics === 'completed';
  }

  _onConnState() {
    const pc = this.pc;
    if (!pc || this._done) return;
    const cs = pc.connectionState || '';
    const ics = pc.iceConnectionState || '';
    this._log('p2p_state', { cs, ics, gen: this.gen });
    if (this._isUp()) {
      if (this._discTimer) { clearTimeout(this._discTimer); this._discTimer = null; }
      if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null; }
      if (this.state !== 'connected') {
        const wasReconnecting = this.state === 'reconnecting';
        this.state = 'connected';
        if (!this.connectedAt) {
          this.connectedAt = Date.now();
          this._applySenderParams();
          this._startQualityLoop();
          this.getStats().then((st) => {
            this._log('p2p_connected', { ms: this.connectedAt - this.t0, ...st });
            try { this.o.onConnected && this.o.onConnected({ ms: this.connectedAt - this.t0, stats: st }); } catch {}
          });
          this._resolveReady && this._resolveReady('connected');
        } else if (wasReconnecting) {
          this.getStats().then((st) => this._log('p2p_reconnected', st));
          try { this.o.onReconnecting && this.o.onReconnecting(false); } catch {}
        }
      }
      return;
    }
    if (this.state !== 'connected' && this.state !== 'reconnecting') return; // ainda negociando: prazo global cuida
    if (cs === 'failed' || ics === 'failed') {
      this._beginRecovery(0);
    } else if (cs === 'disconnected' || ics === 'disconnected') {
      this._beginRecovery(1500);
    }
  }

  // Queda no meio da ligação: ICE restart (caller oferece; callee pede).
  // Sem voltar dentro de reconnectGraceMs → LiveKit.
  _beginRecovery(delayMs) {
    if (this._done) return;
    if (this.state === 'connected') {
      this.state = 'reconnecting';
      try { this.o.onReconnecting && this.o.onReconnecting(true); } catch {}
    }
    if (!this._graceTimer) {
      this._graceTimer = setTimeout(() => {
        this._graceTimer = null;
        if (!this._isUp() && !this._done) this.fallback('ice_lost');
      }, this.cfg.reconnectGraceMs);
    }
    if (this._discTimer) return;
    this._discTimer = setTimeout(() => {
      this._discTimer = null;
      if (this._isUp() || this._done) return;
      this.restartIce('ice_' + ((this.pc && this.pc.iceConnectionState) || '?'));
    }, delayMs);
  }

  restartIce(reason) {
    if (this._done || !this.pc) return;
    this._log('p2p_ice_restart', { reason, caller: this.isCaller });
    if (this.isCaller) {
      this._makeOffer(true).catch(() => {});
    } else {
      this._send('call_p2p_restart', { reason: String(reason || '').slice(0, 40) });
    }
  }

  // Troca de rede (wifi↔4G): restart proativo, sem esperar o ICE morrer.
  _watchNetwork() {
    const kick = () => {
      if (this._done || !this.connectedAt) return;
      this.restartIce('network_change');
    };
    if (Platform.OS === 'web') {
      try {
        const g = globalThis;
        const conn = g.navigator && g.navigator.connection;
        const onOnline = () => kick();
        g.addEventListener && g.addEventListener('online', onOnline);
        if (conn && conn.addEventListener) conn.addEventListener('change', kick);
        this._netUnsub = () => {
          try { g.removeEventListener && g.removeEventListener('online', onOnline); } catch {}
          try { conn && conn.removeEventListener && conn.removeEventListener('change', kick); } catch {}
        };
      } catch {}
      return;
    }
    try {
      const NetInfo = require('@react-native-community/netinfo').default;
      let last = null;
      this._netUnsub = NetInfo.addEventListener((st) => {
        const key = (st && st.type) + ':' + !!(st && st.isConnected);
        if (last !== null && key !== last && st && st.isConnected) kick();
        last = key;
      });
    } catch {}
  }

  async _makeOffer(iceRestart) {
    const pc = this.pc;
    if (!pc || this._done) return;
    if (pc.signalingState !== 'stable') {
      // Oferta anterior sem resposta (ex.: perdida na troca de rede) → rollback.
      try { await pc.setLocalDescription({ type: 'rollback' }); } catch {}
    }
    this.gen += 1;
    const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : {});
    const sdp = _mungeOpus(offer.sdp, this.cfg.maxAudioKbps);
    await pc.setLocalDescription({ type: 'offer', sdp });
    this._send('call_p2p_offer', { sdp, video: !!this.o.video });
    this._log('p2p_offer_sent', { gen: this.gen, restart: !!iceRestart });
  }

  async _onSignal(msg) {
    if (this._done || !msg) return;
    const t = msg.type;
    try {
      if (t === 'call_p2p_ready') {
        if (!this.isCaller) return;
        if (this.connectedAt && this.state !== 'connected') { this.restartIce('peer_ready_again'); return; }
        this._gotReady = true;
        if (this._readyResolve) { const r = this._readyResolve; this._readyResolve = null; r(); }
        return;
      }
      if (t === 'call_p2p_fallback') {
        this._log('p2p_peer_fallback', { reason: msg.reason });
        this.fallback('peer_' + (msg.reason || 'fallback'), true);
        return;
      }
      if (!this.pc) return;
      if (t === 'call_p2p_restart') {
        if (this.isCaller) this.restartIce('peer_request');
        return;
      }
      if (t === 'call_p2p_offer') {
        if (this.isCaller) return;
        const pc = this.pc;
        if (typeof msg.gen === 'number' && msg.gen <= this.remoteGen) return;
        this.remoteGen = typeof msg.gen === 'number' ? msg.gen : this.remoteGen + 1;
        await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        this._haveRemote = true;
        if (!this.audioTx) {
          const txs = pc.getTransceivers ? pc.getTransceivers() : [];
          this.audioTx = txs.find((x) => x.receiver && x.receiver.track && x.receiver.track.kind === 'audio') || null;
          this.videoTx = txs.find((x) => x.receiver && x.receiver.track && x.receiver.track.kind === 'video') || null;
          try {
            if (this.audioTx) { this.audioTx.direction = 'sendrecv'; if (this.localAudio) await this.audioTx.sender.replaceTrack(this.localAudio); }
            if (this.videoTx) { this.videoTx.direction = 'sendrecv'; if (this.localVideo) await this.videoTx.sender.replaceTrack(this.localVideo); }
            if (this.localStream && this.audioTx && this.audioTx.sender.setStreams) this.audioTx.sender.setStreams(this.localStream);
          } catch {}
          _preferCodecs(this.videoTx, 'video', Platform.OS === 'web' ? ['VP8', 'H264', 'VP9'] : ['H264', 'VP8', 'VP9']);
        }
        const ans = await pc.createAnswer();
        const sdp = _mungeOpus(ans.sdp, this.cfg.maxAudioKbps);
        await pc.setLocalDescription({ type: 'answer', sdp });
        this.gen = this.remoteGen;
        this._send('call_p2p_answer', { sdp });
        this._flushCands();
        return;
      }
      if (t === 'call_p2p_answer') {
        if (!this.isCaller) return;
        const pc = this.pc;
        if (typeof msg.gen === 'number' && msg.gen !== this.gen) return; // resposta velha
        if (pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        this._haveRemote = true;
        this._flushCands();
        return;
      }
      if (t === 'call_p2p_candidate') {
        const list = Array.isArray(msg.candidates) ? msg.candidates : [];
        if (this.blockCandidates) return;
        if (!this._haveRemote || !this.pc.remoteDescription) { this._pendingCands.push(...list); return; }
        for (const c of list) await this._addCand(c);
      }
    } catch (e) {
      this._log('p2p_signal_err', { t, msg: String((e && e.message) || e).slice(0, 160) });
    }
  }

  async _addCand(c) {
    if (!c || !this.pc) return;
    try {
      if (!c.candidate) return;
      const Ice = this.rtc.RTCIceCandidate;
      await this.pc.addIceCandidate(Ice ? new Ice(c) : c);
    } catch {}
  }

  async _flushCands() {
    const list = this._pendingCands.splice(0);
    for (const c of list) await this._addCand(c);
  }

  async _applySenderParams() {
    const set = async (tx, maxBitrate, extra) => {
      try {
        const snd = tx && tx.sender;
        if (!snd || !snd.getParameters) return;
        const p = snd.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = maxBitrate;
        Object.assign(p.encodings[0], extra || {});
        if (tx === this.videoTx) p.degradationPreference = 'balanced';
        await snd.setParameters(p);
      } catch {}
    };
    await set(this.audioTx, this.cfg.maxAudioKbps * 1000, { priority: 'high', networkPriority: 'high' });
    await set(this.videoTx, this.cfg.maxVideoKbps * 1000, { scaleResolutionDownBy: 1 });
  }

  // Adaptação de banda por cima do GCC: perda/RTT altos → teto menor e
  // resolução /2; voltou a ficar bom → restaura.
  _startQualityLoop() {
    if (this._qualityTimer) return;
    this._qualityTimer = setInterval(async () => {
      if (this._done) return;
      const st = await this.getStats();
      this.lastStats = st;
      let q = 'good';
      if (st.loss_pct >= 10 || st.rtt_ms >= 600) q = 'poor';
      else if (st.loss_pct >= 4 || st.rtt_ms >= 300) q = 'medium';
      if (q !== this._lastQ) {
        this._lastQ = q;
        try {
          const snd = this.videoTx && this.videoTx.sender;
          if (snd && snd.getParameters) {
            const p = snd.getParameters();
            if (p.encodings && p.encodings[0]) {
              p.encodings[0].maxBitrate = (q === 'poor' ? 0.25 : q === 'medium' ? 0.55 : 1) * this.cfg.maxVideoKbps * 1000;
              p.encodings[0].scaleResolutionDownBy = q === 'poor' ? 2 : 1;
              await snd.setParameters(p);
            }
          }
        } catch {}
        try { this.o.onQuality && this.o.onQuality(q, st); } catch {}
      }
    }, 2000);
  }

  async getStats() {
    const out = { rtt_ms: null, loss_pct: 0, local_type: null, remote_type: null, protocol: null, relay: false, bytes_in: 0, bytes_out: 0 };
    try {
      const rep = await this.pc.getStats();
      const by = {};
      rep.forEach((s) => { by[s.id] = s; });
      let pair = null;
      rep.forEach((s) => {
        if (s.type === 'transport' && s.selectedCandidatePairId && by[s.selectedCandidatePairId]) pair = by[s.selectedCandidatePairId];
      });
      if (!pair) rep.forEach((s) => { if (s.type === 'candidate-pair' && (s.selected || s.nominated) && s.state === 'succeeded') pair = pair || s; });
      if (pair) {
        if (typeof pair.currentRoundTripTime === 'number') out.rtt_ms = Math.round(pair.currentRoundTripTime * 1000);
        const l = by[pair.localCandidateId] || {};
        const r = by[pair.remoteCandidateId] || {};
        out.local_type = l.candidateType || null;
        out.remote_type = r.candidateType || null;
        out.protocol = l.relayProtocol || l.protocol || null;
        out.relay = l.candidateType === 'relay' || r.candidateType === 'relay';
        out.bytes_in = pair.bytesReceived || 0;
        out.bytes_out = pair.bytesSent || 0;
      }
      let lost = 0, recv = 0;
      rep.forEach((s) => {
        if (s.type === 'inbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio')) { lost += s.packetsLost || 0; recv += s.packetsReceived || 0; }
      });
      out.loss_pct = recv + lost > 0 ? Math.round((lost / (recv + lost)) * 1000) / 10 : 0;
    } catch {}
    return out;
  }

  // ── Controles ──
  setMicEnabled(on) {
    this._micEnabled = !!on;
    try { if (this.localAudio) this.localAudio.enabled = !!on; } catch {}
  }

  async setCameraEnabled(on) {
    if (this._done) return null;
    if (!on) {
      this._videoEnabled = false;
      try { if (this.videoTx) await this.videoTx.sender.replaceTrack(null); } catch {}
      try { if (this.localVideo) this.localVideo.stop(); } catch {}
      this.localVideo = null;
      try { this.o.onLocalVideo && this.o.onLocalVideo(null); } catch {}
      return null;
    }
    try {
      const st = await this.rtc.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }, audio: false });
      const vt = (st.getVideoTracks() || [])[0];
      if (!vt) return null;
      try { vt.contentHint = 'motion'; } catch {}
      this.localVideo = vt;
      this._videoEnabled = true;
      if (this.videoTx) {
        await this.videoTx.sender.replaceTrack(vt);
        try { if (this.videoTx.direction !== 'sendrecv') this.videoTx.direction = 'sendrecv'; } catch {}
        this._applySenderParams();
      }
      const ad = _trackAdapter(vt, 'video', this.rtc.MediaStream);
      try { this.o.onLocalVideo && this.o.onLocalVideo(ad); } catch {}
      return ad;
    } catch (e) {
      this._log('p2p_cam_err', { msg: String((e && e.message) || e).slice(0, 120) });
      return null;
    }
  }

  async switchCamera(facingFront) {
    const vt = this.localVideo;
    if (!vt) return false;
    try {
      if (typeof vt._switchCamera === 'function') { vt._switchCamera(); return true; } // react-native-webrtc
      const st = await this.rtc.mediaDevices.getUserMedia({ video: { facingMode: facingFront ? 'environment' : 'user' }, audio: false });
      const nv = (st.getVideoTracks() || [])[0];
      if (!nv) return false;
      if (this.videoTx) await this.videoTx.sender.replaceTrack(nv);
      try { vt.stop(); } catch {}
      this.localVideo = nv;
      try { this.o.onLocalVideo && this.o.onLocalVideo(_trackAdapter(nv, 'video', this.rtc.MediaStream)); } catch {}
      return true;
    } catch {
      return false;
    }
  }

  // Desiste do P2P (prazo, queda sem volta, virou grupo, pedido do par).
  fallback(reason, fromPeer) {
    if (this._done) return;
    this._log('p2p_fallback', { reason, from_peer: !!fromPeer, after_connected: !!this.connectedAt, ms: Date.now() - this.t0 });
    if (!fromPeer) this._send('call_p2p_fallback', { reason: String(reason || '').slice(0, 40) });
    this._teardown();
    this.state = 'fallback';
    this._resolveReady && this._resolveReady('fallback');
    try { this.o.onFallback && this.o.onFallback(reason); } catch {}
  }

  close(reason) {
    if (this._done) return;
    this._log('p2p_close', { reason });
    this._teardown();
    this.state = 'closed';
    this._resolveReady && this._resolveReady('closed');
  }

  _teardown() {
    this._done = true;
    if (_sessions.get(this.callId) === this) _sessions.delete(this.callId);
    this._timers.forEach((t) => clearTimeout(t));
    this._timers.clear();
    if (this._outTimer) { clearTimeout(this._outTimer); this._outTimer = null; }
    if (this._discTimer) { clearTimeout(this._discTimer); this._discTimer = null; }
    if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null; }
    if (this._qualityTimer) { clearInterval(this._qualityTimer); this._qualityTimer = null; }
    if (this._readyResolve) { const r = this._readyResolve; this._readyResolve = null; try { r(); } catch {} }
    try { this._netUnsub && this._netUnsub(); } catch {}
    try { if (this.dc) this.dc.close(); } catch {}
    try { if (this.pc) this.pc.close(); } catch {}
    this.pc = null;
    try { (this.localStream ? this.localStream.getTracks() : []).forEach((t) => { try { t.stop(); } catch {} }); } catch {}
    try { if (this.localVideo) this.localVideo.stop(); } catch {}
    try { if (this._remoteAudioEl) { this._remoteAudioEl.srcObject = null; this._remoteAudioEl.remove(); } } catch {}
    this._remoteAudioEl = null;
  }
}

// QA/diagnóstico (web): window.__chatyyP2P.get(callId).getStats()
try {
  if (typeof globalThis !== 'undefined') {
    globalThis.__chatyyP2P = {
      get: (id) => (id ? getP2PSession(id) : (_sessions.values().next().value || null)),
      sessions: () => Array.from(_sessions.keys()),
    };
  }
} catch {}
