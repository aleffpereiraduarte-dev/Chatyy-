/**
 * OpenAI Realtime client — WebRTC direct (ChatGPT-style live voice).
 *
 * Works on both WEB and NATIVE (iOS/Android). The server mints an
 * ephemeral token via POST /api/email.php?action=realtime_ephemeral_token
 * which calls OpenAI /v1/realtime/sessions. The client then opens an
 * RTCPeerConnection straight to OpenAI with that token — no proxy in
 * the middle.
 *
 * Flow:
 *   1. fetch ephemeral token from our backend
 *   2. create RTCPeerConnection, add local mic track, addTransceiver('audio')
 *   3. create data channel for events (transcripts, tool calls, etc.)
 *   4. createOffer → SDP → POST to https://api.openai.com/v1/realtime
 *   5. setRemoteDescription(answer)
 *   6. audio flows both ways; events on data channel
 *   7. stop() tears down peer connection + mic
 */
import { Platform } from 'react-native';
import * as api from './api';

// WebRTC primitives — platform-specific import
let RTCPeerConnection, RTCSessionDescription, mediaDevices, Audio;
if (Platform.OS === 'web') {
  if (typeof window !== 'undefined') {
    RTCPeerConnection = window.RTCPeerConnection;
    RTCSessionDescription = window.RTCSessionDescription;
    mediaDevices = navigator?.mediaDevices;
    Audio = typeof window.Audio !== 'undefined' ? window.Audio : null;
  }
} else {
  try {
    const webrtc = require('@livekit/react-native-webrtc');
    RTCPeerConnection = webrtc.RTCPeerConnection;
    RTCSessionDescription = webrtc.RTCSessionDescription;
    mediaDevices = webrtc.mediaDevices;
  } catch {}
}

// [bia-lenta 2026-10-19] SESSÃO FANTASMA: stop() durante o 'connecting' (token
// demora 1-3 s) não impedia o _startInner de seguir — criava um RTCPeerConnection
// NOVO depois do stop, conectava e ficava viva sem ninguém referenciando: uma 2ª
// Bia ouvindo o mic e falando no alto-falante com o contexto ANTIGO (respondia
// "coisa anterior", agradecia conversa já apagada, falava por cima e cortava a
// usuária). Agora: toda sessão viva fica neste registro, cada await do start
// confere se foi parada, e stopAllRealtimeSessions() derruba qualquer sobra.
const LIVE_SESSIONS = new Set();
export function stopAllRealtimeSessions(except = null) {
  for (const s of Array.from(LIVE_SESSIONS)) {
    if (s !== except) { try { s.stop(); } catch {} }
  }
}

export function isRealtimeSupported() {
  return !!(RTCPeerConnection && mediaDevices?.getUserMedia);
}

// [bia-voz 2026-10-18] "o que ela escreve não bate": o STT alucinava frases de
// legenda em silêncio/ruído ("Tchau.", "Obrigado.", "Legendas pela comunidade
// Amara.org") e o vídeo em PiP virava "fala do usuário". Filtro em 2 níveis:
//  - ALWAYS: frases que ninguém diz à Bia (créditos de legenda/YouTube) → sempre lixo.
//  - SHORT: despedidas/agradecimentos curtos → lixo SÓ se o trecho de áudio foi
//    curto ou de baixa energia (um "tchau" real, falado perto do mic, passa).
// ALWAYS_CONTAINS: trechos de crédito de legenda/YouTube — contidos em qualquer
// lugar já denunciam a alucinação. ALWAYS_EXACT: só se for a frase inteira.
const HALLU_ALWAYS_CONTAINS = [
  'amara org', 'legendas pela comunidade', 'legenda pela comunidade', 'obrigado por assistir',
  'obrigada por assistir', 'obrigado pela atencao e ate', 'inscreva se no canal', 'se inscreva no canal',
  'ative o sininho', 'legendado por', 'legendas por', 'transcricao por', 'thanks for watching',
  'thank you for watching', 'subtitles by',
];
const HALLU_ALWAYS_EXACT = ['e ai pessoal', 'ate o proximo video', 'ate a proxima', 'ate a proxima pessoal'];
const HALLU_ALWAYS = HALLU_ALWAYS_CONTAINS.concat(HALLU_ALWAYS_EXACT);
const HALLU_SHORT = [
  'tchau', 'tchau tchau', 'tchau tchau tchau', 'obrigado', 'obrigada', 'muito obrigado', 'muito obrigada',
  'hum', 'hmm', 'ah', 'beijo', 'beijos', 'bye', 'bye bye', 'thank you', 'thanks', 'you',
  'musica', 'aplausos', 'risos',
];
function normTx(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function isHalluCandidatePrefix(n) {
  // Enquanto o parcial ainda pode virar uma frase-lixo, não mostra (evita piscar "Tchau").
  if (!n) return true;
  for (const h of HALLU_ALWAYS) if (h.startsWith(n)) return true;
  for (const h of HALLU_SHORT) if (h.startsWith(n)) return true;
  return false;
}
// "Tchau" real = ~300 ms de prefix_padding + ~400-700 ms de fala ≈ 0,7-1,4 s.
const SHORT_SEG_MS = 600;       // menos que isso é só o padding + um estalo
const LONG_SEG_MS = 2500;       // 2,5 s+ de áudio virando 1-2 palavras = som de fundo (vídeo/TV)
const LOW_RMS = 0.012;          // ~ -38 dBFS médio no trecho = fundo/longe do mic
export function classifyUserTranscript(text, seg) {
  const n = normTx(text);
  if (!n) return 'empty';
  // ruído com cara de legenda: "[música]", "♪", "(aplausos)"
  if (/^[\s\[\]()♪♫*.\-…]+$/.test(String(text)) || /^\s*[\[(].*[\])]\s*$/.test(String(text))) return 'noise_tag';
  if (HALLU_ALWAYS_EXACT.includes(n) || HALLU_ALWAYS_CONTAINS.some(h => n.includes(h))) return 'hallucination';
  // repetição "tchau tchau tchau tchau..." / "obrigado obrigado obrigado"
  const w = n.split(' ');
  if (w.length >= 3 && new Set(w).size === 1) return 'hallucination';
  if (HALLU_SHORT.includes(n)) {
    const dur = seg && seg.durMs != null ? seg.durMs : null;
    const rms = seg && seg.rms != null ? seg.rms : null;
    if (rms != null && rms < LOW_RMS) return 'hallucination';
    if (dur != null && (dur < SHORT_SEG_MS || dur > LONG_SEG_MS)) return 'hallucination';
    if (dur == null && rms == null) return 'hallucination'; // sem prova de fala real → não confia
  }
  return 'ok';
}

function userTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
}

async function mintEphemeralToken() {
  // [bia-ferramentas-voz 2026-10-18] tools=1 = este app sabe executar ferramentas
  // (one_tool_exec). Servidor sem o kit ignora o campo → sessão sem ferramentas,
  // nada muda.
  const res = await api.apiCall('realtime_ephemeral_token', { tools: 1, timezone: userTimezone() }, 'POST');
  if (!res?.success || !res?.data?.client_secret) {
    throw new Error(res?.message || 'token mint failed');
  }
  return {
    token: res.data.client_secret,
    model: res.data.model || 'gpt-realtime',
    toolsEnabled: Number(res.data.tools_enabled || 0) > 0,
  };
}

// ── [bia-ferramentas-voz 2026-10-18] ferramentas na voz ──────────────────────
// O modelo pede a função (response.function_call_arguments.done) → o app chama
// one_tool_exec (escopo do usuário logado) → devolve function_call_output +
// response.create. Ações de saída/destrutivas voltam "confirm_required" com um
// resumo + token: a Bia lê o resumo e pergunta; o app SÓ reenvia com o token se
// houve uma NOVA fala do usuário depois da pergunta (e não foi um "não").
const CONFIRM_TTL_MS = 290 * 1000; // servidor: 300 s
const NEGATIVE_RE = /^(nao|cancela|cancelar|cancele|para|pare|espera|espere|deixa|deixa pra la|melhor nao|nem|negativo|no|nope|stop|wait)\b/;
function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}
function clipOutput(obj) {
  let out = '';
  try { out = JSON.stringify(obj); } catch { out = '{"error":"bad_result"}'; }
  return out.length > 16000 ? out.slice(0, 16000) : out;
}

export class OneRealtimeSession {
  constructor(handlers = {}) {
    // onState, onTranscript, onUserPartial, onTranscriptDiscarded, onAssistantText, onError, onClose
    this.handlers = handlers;
    this._items = new Map(); // item_id → { startMs, endMs, e0, e1, text, shown }
    this._lastCommittedItem = null;
    this._responseActive = false;
    this._audioBufEvents = false; // WebRTC manda output_audio_buffer.started/stopped (GA)
    // [bia-ferramentas-voz 2026-10-18]
    this._toolsEnabled = false;
    this._toolCalls = new Set();     // call_id já tratados (2 eventos GA p/ a mesma chamada)
    this._toolInflight = 0;
    this._needResponse = false;      // mandou function_call_output → falta response.create
    this._pendingConfirm = new Map(); // tool|args → { token, seq, exp, summary }
    this._userTurnSeq = 0;           // conta falas VÁLIDAS do usuário
    this._lastUserText = '';
    this.pc = null;
    this.dc = null;
    this.localStream = null;
    this.remoteAudioEl = null; // web <audio>
    this.active = false;
    this._stopped = false; // [bia-lenta 2026-10-19] parada é definitiva (não religa)
    this.currentState = 'idle';
  }

  _alive() {
    if (this._stopped) { const e = new Error('aborted'); e.aborted = true; throw e; }
  }

  _emit(name, payload) {
    if (this._stopped) return; // sessão parada não fala mais com a tela
    const fn = this.handlers[name];
    if (typeof fn === 'function') {
      try { fn(payload); } catch (e) { if (__DEV__) console.warn('[oneRealtime] handler err:', e?.message); }
    }
  }

  _setState(s) {
    if (s === this.currentState) return;
    this.currentState = s;
    this._emit('onState', s);
  }

  async start() {
    if (this.active) return;
    this._alive();
    if (!isRealtimeSupported()) throw new Error('WebRTC not available');
    this.active = true;
    LIVE_SESSIONS.add(this);
    this._setState('connecting');

    try {
      await this._startInner();
    } catch (e) {
      // Any failure mid-handshake must release mic + pc so we don't leak
      // a red recording indicator or a dangling connection.
      this.stop();
      throw e;
    }
  }

  async _startInner() {
    // 0. Native iOS: configure AVAudioSession for play+record before getUserMedia.
    // Without this the mic prompt may not fire, audio routes to the earpiece,
    // and the silent switch mutes the assistant. shouldRouteThroughEarpiece:false
    // forces speaker — hands-free ChatGPT-style.
    //
    // [bia-voz 2026-10-18] Vídeo em PiP / música de outro app vazava pro mic e
    // virava "fala do usuário". (a) pausa os players de mídia do próprio app
    // (registry do audioManager); (b) iOS: sessão .playAndRecord + mode
    // .voiceChat SEM .duckOthers/.mixWithOthers (ExpoAudioSession.activateForCall,
    // já presente nos builds — é o mesmo da ligação) → o iOS INTERROMPE o áudio de
    // outros apps (YouTube/PiP do Safari) em vez de só abaixar, e liga o
    // processamento de voz do sistema. O expo-audio punha mode .default +
    // duckOthers (o vídeo seguia tocando baixinho no mic). AEC do áudio da
    // própria Bia já vem do VoiceProcessingIO do WebRTC. Sem BT → alto-falante.
    try { require('./audioManager').pauseMediaPlayers?.(); } catch {}
    let sessionOk = false;
    if (Platform.OS === 'ios') {
      try {
        const AS = require('../modules/expo-audio-session').default;
        if (AS && typeof AS.activateForCall === 'function') {
          let bt = false;
          try { bt = !!AS.isBluetoothConnectedSync?.(); } catch {}
          sessionOk = !!(await AS.activateForCall(!bt));
          this._iosVoiceSession = sessionOk;
        }
      } catch {}
    }
    if (Platform.OS !== 'web' && !sessionOk) {
      try {
        const expoAudio = require('expo-audio');
        await expoAudio.setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
          // Android: doNotMix pede foco de áudio exclusivo (pausa música/vídeo de outros apps).
          interruptionMode: Platform.OS === 'android' ? 'doNotMix' : 'duckOthers',
          shouldPlayInBackground: false,
          shouldRouteThroughEarpiece: false,
        });
      } catch {}
    }

    this._alive();
    // 1. Ephemeral token from our backend
    const { token, model, toolsEnabled } = await mintEphemeralToken();
    this._alive();
    this._toolsEnabled = !!toolsEnabled;

    // 2. Mic stream
    const __ls = await mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
    if (this._stopped) { try { __ls?.getTracks?.().forEach(t => t.stop()); } catch {} this._alive(); }
    this.localStream = __ls;
    const tracks = this.localStream.getAudioTracks?.() || [];
    if (!tracks.length) throw new Error('no microphone track');

    // 3. Peer connection
    this.pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

    // Add mic track
    tracks.forEach(track => this.pc.addTrack(track, this.localStream));

    // Remote audio playback
    if (Platform.OS === 'web') {
      // <audio autoplay> picks up remote track via ontrack
      this.pc.ontrack = (ev) => {
        const stream = ev.streams?.[0];
        if (!stream) return;
        if (!this.remoteAudioEl) {
          this.remoteAudioEl = new Audio();
          this.remoteAudioEl.autoplay = true;
          this.remoteAudioEl.playsInline = true;
        }
        this.remoteAudioEl.srcObject = stream;
      };
    } else {
      // Native: react-native-webrtc plays remote audio automatically.
      // Speakerphone is already forced via expo-audio.setAudioModeAsync above.
      this.pc.ontrack = () => { this._setState('listening'); };
    }

    // 4. Data channel for events (transcripts, VAD signals)
    this.dc = this.pc.createDataChannel('oai-events');
    this.dc.onopen = () => { this._setState('listening'); };
    this.dc.onmessage = (ev) => { if (!this._stopped) this._onEvent(ev.data); };
    this.dc.onclose = () => { if (this.active) this._emit('onClose'); };
    this.dc.onerror = (e) => this._emit('onError', e);

    this.pc.oniceconnectionstatechange = () => {
      const s = this.pc?.iceConnectionState;
      if (s === 'failed') {
        // [2026-10-04 P1] Estado terminal: libera mic/pc e sinaliza close pra o
        // app cair no fallback (Whisper) em vez de deixar o orb "ouvindo" morto
        // com o microfone preso. (stop() zera active antes de fechar, então o
        // onClose do data-channel não dispara em dobro.)
        this._emit('onError', new Error('ICE failed'));
        if (this.active) this._emit('onClose');
        this.stop();
      } else if (s === 'disconnected') {
        this._emit('onError', new Error('ICE disconnected'));
      }
    };

    // 5. SDP offer → OpenAI → answer
    const offer = await this.pc.createOffer();
    this._alive();
    await this.pc.setLocalDescription(offer);
    this._alive();

    // [2026-10-04] GA endpoint. A Beta (/v1/realtime) foi DESLIGADA pelo OpenAI
    // ("The Realtime Beta API is no longer supported. Please use
    // /v1/realtime/calls for the GA API.") → o SDP exchange falhava e a chamada
    // de voz da Bia nunca conectava. O token efêmero já é mintado no endpoint GA.
    const sdpRes = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`, {
      method: 'POST',
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/sdp',
      },
    });
    if (!sdpRes.ok) {
      throw new Error(`OpenAI SDP exchange failed: ${sdpRes.status}`);
    }
    const answerSdp = await sdpRes.text();
    this._alive();
    await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: answerSdp }));
    this._alive();

    this._setState('listening');
  }

  _send(obj) {
    try { if (this.dc && this.dc.readyState === 'open') this.dc.send(JSON.stringify(obj)); } catch {}
  }

  _item(id) {
    if (!id) return null;
    let it = this._items.get(id);
    if (!it) {
      it = { startMs: null, endMs: null, e0: null, e1: null, text: '', shown: false };
      this._items.set(id, it);
      if (this._items.size > 40) { const k = this._items.keys().next().value; this._items.delete(k); }
    }
    return it;
  }

  // Energia do mic (RTCStats media-source: totalAudioEnergy/totalSamplesDuration).
  // Web (Chrome/Safari) e libwebrtc nativo expõem; se não houver, fica null e o
  // filtro usa só a duração.
  async _micEnergy() {
    try {
      const st = await this.pc?.getStats?.();
      let out = null;
      st?.forEach?.((r) => {
        if (r && r.type === 'media-source' && (r.kind === 'audio' || r.totalAudioEnergy != null)
          && typeof r.totalAudioEnergy === 'number' && typeof r.totalSamplesDuration === 'number') {
          out = { e: r.totalAudioEnergy, d: r.totalSamplesDuration };
        }
      });
      return out;
    } catch { return null; }
  }

  _segInfo(it) {
    if (!it) return null;
    const durMs = (it.startMs != null && it.endMs != null) ? Math.max(0, it.endMs - it.startMs) : null;
    let rms = null;
    if (it.e0 && it.e1) {
      const dd = it.e1.d - it.e0.d;
      if (dd > 0.05) rms = Math.sqrt(Math.max(0, (it.e1.e - it.e0.e) / dd));
    }
    return { durMs, rms };
  }

  // Trecho descartado (alucinação/ruído): some da tela e NÃO vira turno — cancela
  // a resposta que o VAD já disparou p/ esse item e tira o item do contexto.
  _discardItem(itemId, reason, text) {
    const it = this._items.get(itemId);
    const wasShown = !!it?.shown;
    if (itemId && itemId === this._lastCommittedItem) {
      if (this._responseActive) this._send({ type: 'response.cancel' });
      this._send({ type: 'output_audio_buffer.clear' });
    }
    if (itemId) this._send({ type: 'conversation.item.delete', item_id: itemId });
    this._items.delete(itemId);
    if (__DEV__) console.log('[oneRealtime] descartado', reason, JSON.stringify(text || ''));
    this._emit('onTranscriptDiscarded', { itemId, reason, text, wasShown });
  }

  _onEvent(raw) {
    let msg;
    try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
    const t = msg.type;

    // ── Usuário (STT) ──────────────────────────────────────────────
    if (t === 'input_audio_buffer.speech_started') {
      const it = this._item(msg.item_id);
      if (it) {
        it.startMs = typeof msg.audio_start_ms === 'number' ? msg.audio_start_ms : null;
        this._micEnergy().then((e) => { if (e && !it.e0) it.e0 = e; });
      }
      this._setState('listening');
      return;
    }
    if (t === 'input_audio_buffer.speech_stopped') {
      const it = this._item(msg.item_id);
      if (it) {
        it.endMs = typeof msg.audio_end_ms === 'number' ? msg.audio_end_ms : null;
        this._micEnergy().then((e) => { if (e) it.e1 = e; });
      }
      return;
    }
    if (t === 'input_audio_buffer.committed') {
      if (msg.item_id) this._lastCommittedItem = msg.item_id;
      return;
    }
    if (t === 'conversation.item.input_audio_transcription.delta' && msg.delta) {
      const it = this._item(msg.item_id);
      if (!it) return;
      it.text += msg.delta;
      // Parcial ao vivo (estilo ChatGPT voz) — segura enquanto ainda pode ser
      // uma frase-lixo ("Tch…", "Obriga…") p/ não piscar.
      if (isHalluCandidatePrefix(normTx(it.text))) return;
      it.shown = true;
      this._emit('onUserPartial', { itemId: msg.item_id, text: it.text });
      return;
    }
    if (t === 'conversation.item.input_audio_transcription.completed') {
      const text = String(msg.transcript || '').trim();
      const it = this._items.get(msg.item_id);
      const verdict = classifyUserTranscript(text, this._segInfo(it));
      if (verdict !== 'ok') { this._discardItem(msg.item_id, verdict, text); return; }
      if (it) it.text = text;
      this._userTurnSeq += 1;
      this._lastUserText = text;
      this._emit('onTranscript', text, { itemId: msg.item_id });
      this._items.delete(msg.item_id);
      return;
    }
    if (t === 'conversation.item.input_audio_transcription.failed') {
      const it = this._items.get(msg.item_id);
      if (it?.shown) this._emit('onTranscriptDiscarded', { itemId: msg.item_id, reason: 'failed', wasShown: true });
      this._items.delete(msg.item_id);
      return;
    }

    // ── Bia (resposta) — nomes GA + beta ───────────────────────────
    if ((t === 'response.output_audio_transcript.delta' || t === 'response.audio_transcript.delta') && msg.delta) {
      this._emit('onAssistantText', { delta: msg.delta });
      return;
    }
    if ((t === 'response.output_audio_transcript.done' || t === 'response.audio_transcript.done') && msg.transcript) {
      this._emit('onAssistantText', { transcript: msg.transcript, done: true });
      return;
    }
    if (t === 'response.created') { this._responseActive = true; return; }
    // ── Ferramentas (GA) ───────────────────────────────────────────
    if (t === 'response.function_call_arguments.done' && msg.call_id) {
      this._onFunctionCall(msg.call_id, msg.name, msg.arguments);
      return;
    }
    if (t === 'response.output_item.done' && msg.item?.type === 'function_call' && msg.item.call_id) {
      this._onFunctionCall(msg.item.call_id, msg.item.name, msg.item.arguments);
      return;
    }
    if (t === 'output_audio_buffer.started') {
      this._audioBufEvents = true;
      this._setState('speaking');
      return;
    }
    if (t === 'output_audio_buffer.stopped' || t === 'output_audio_buffer.cleared') {
      this._audioBufEvents = true;
      if (this.active) this._setState('listening');
      return;
    }
    if (t === 'response.output_audio.delta' || t === 'response.audio.delta') {
      this._setState('speaking');
      return;
    }
    if (t === 'response.done' || t === 'response.output_audio.done' || t === 'response.audio.done') {
      if (t === 'response.done') {
        this._responseActive = false;
        this._maybeContinue();
      }
      // WebRTC: response.done chega quando a GERAÇÃO acaba, antes do áudio tocar
      // todo — se o servidor manda output_audio_buffer.*, é ele quem volta p/ "ouvindo".
      if (!this._audioBufEvents) setTimeout(() => { if (this.active) this._setState('listening'); }, 50);
      return;
    }
    if (t === 'error') {
      // cancel/delete de item que já não existe → erro benigno, não propaga.
      const code = String(msg.error?.code || '');
      const em = String(msg.error?.message || '');
      if (code === 'response_cancel_not_active' || /no active response|cancel.*not active|item.*(does not exist|not found)/i.test(em)) return;
      this._emit('onError', msg.error || msg);
    }
  }

  // ── [bia-ferramentas-voz 2026-10-18] ─────────────────────────────
  _onFunctionCall(callId, name, argsRaw) {
    if (!callId || this._toolCalls.has(callId)) return;
    this._toolCalls.add(callId);
    if (this._toolCalls.size > 60) { const k = this._toolCalls.values().next().value; this._toolCalls.delete(k); }
    this._toolInflight += 1;
    this._runTool(String(name || ''), argsRaw)
      .catch(() => ({ error: 'unavailable', message: 'Nao consegui fazer isso pela voz agora. Ofereca fazer pelo chat de texto.' }))
      .then((output) => {
        this._toolInflight = Math.max(0, this._toolInflight - 1);
        if (!this.active) return;
        this._send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: clipOutput(output) } });
        this._needResponse = true;
        this._maybeContinue();
      });
  }

  _maybeContinue() {
    // Só pede a próxima resposta quando TODAS as funções desta rodada voltaram
    // e a resposta que as pediu já terminou (senão: "conversation_already_has_active_response").
    if (!this.active || !this._needResponse || this._toolInflight > 0 || this._responseActive) return;
    this._needResponse = false;
    this._send({ type: 'response.create' });
  }

  async _runTool(name, argsRaw) {
    if (!this._toolsEnabled || !/^[a-z][a-z0-9_]{1,63}$/.test(name)) return { error: 'unknown_tool' };
    let args = {};
    try { args = typeof argsRaw === 'string' ? (argsRaw.trim() ? JSON.parse(argsRaw) : {}) : (argsRaw || {}); } catch { return { error: 'bad_arguments', message: 'Argumentos invalidos; tente de novo.' }; }
    if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
    const key = name + '|' + stableStringify(args);
    const now = Date.now();
    for (const [k, p] of this._pendingConfirm) if (p.exp < now) this._pendingConfirm.delete(k);

    const body = { tool: name, args, timezone: userTimezone() };
    const pending = this._pendingConfirm.get(key);
    if (pending) {
      // Confirmação exige uma fala NOVA do usuário depois da pergunta.
      if (this._userTurnSeq <= pending.seq) {
        return { status: 'awaiting_user', summary: pending.summary, message: 'O usuario ainda nao respondeu. Leia o resumo, pergunte se pode e espere ele dizer sim.' };
      }
      this._pendingConfirm.delete(key);
      if (NEGATIVE_RE.test(normTx(this._lastUserText))) {
        this._emit('onToolEvent', { phase: 'cancelled', tool: name });
        return { status: 'cancelled_by_user', message: 'O usuario nao confirmou. Nao execute; diga que cancelou.' };
      }
      body.confirm_token = pending.token;
    }

    this._emit('onToolEvent', { phase: 'running', tool: name });
    let res = null;
    try { res = await api.apiCall('one_tool_exec', body, 'POST'); } catch { res = null; }
    const d = res?.data || {};
    if (!res?.success && !d.status) {
      this._emit('onToolEvent', { phase: 'error', tool: name });
      return { error: d.error || 'unavailable', message: res?.message || 'Nao consegui fazer isso pela voz agora.' };
    }
    if (d.status === 'confirm_required' && d.confirm_token) {
      this._pendingConfirm.set(key, { token: d.confirm_token, seq: this._userTurnSeq, exp: Date.now() + CONFIRM_TTL_MS, summary: d.summary || '' });
      this._emit('onToolEvent', { phase: 'confirm', tool: name, summary: d.summary || '' });
      return {
        status: 'confirmation_required',
        summary: d.summary || '',
        instruction: 'Leia este resumo para o usuario em voz e pergunte se pode fazer. So chame esta ferramenta de novo, com exatamente os mesmos argumentos, depois que ele disser que sim.',
      };
    }
    if (d.status === 'confirm_invalid') {
      this._emit('onToolEvent', { phase: 'error', tool: name });
      return { status: 'confirmation_expired', summary: d.summary || '', message: 'A confirmacao expirou ou os dados mudaram. Leia o resumo de novo e pergunte outra vez.' };
    }
    this._emit('onToolEvent', { phase: 'done', tool: name, status: d.status });
    return d.status === 'blocked' ? (d.result || { error: 'data_access_off' }) : (d.result ?? { status: d.status || 'ok' });
  }

  stop() {
    this._stopped = true;
    LIVE_SESSIONS.delete(this);
    this.active = false;
    try { this.dc?.close?.(); } catch {}
    try { this.pc?.close?.(); } catch {}
    try { this.localStream?.getTracks?.().forEach(t => t.stop()); } catch {}
    try {
      if (this.remoteAudioEl) {
        this.remoteAudioEl.pause();
        this.remoteAudioEl.srcObject = null;
        this.remoteAudioEl = null;
      }
    } catch {}
    if (Platform.OS !== 'web') {
      // Return the audio session to normal playback so other sounds (ringtone,
      // notification chimes) aren't stuck ducking once the call ends.
      // iOS voiceChat: deactivate() avisa (notifyOthersOnDeactivation) → o
      // YouTube/Spotify/PiP de outro app volta a tocar.
      const restore = () => {
        try {
          const expoAudio = require('expo-audio');
          expoAudio.setAudioModeAsync({
            allowsRecording: false,
            playsInSilentMode: true,
            interruptionMode: 'mixWithOthers',
            shouldPlayInBackground: false,
            shouldRouteThroughEarpiece: false,
          }).catch(() => {});
        } catch {}
      };
      let deact = null;
      if (this._iosVoiceSession) {
        this._iosVoiceSession = false;
        try { deact = require('../modules/expo-audio-session').default?.deactivate?.(); } catch {}
      }
      // Em série: o deactivate() roda na fila nativa dele; se o expo-audio
      // rodasse em paralelo, o .ambient do deactivate podia ganhar no fim.
      if (deact && typeof deact.then === 'function') deact.then(restore, restore);
      else restore();
    }
    this.dc = null;
    this.pc = null;
    this.localStream = null;
    this._items.clear();
    this._lastCommittedItem = null;
    this._responseActive = false;
    this._toolCalls.clear();
    this._pendingConfirm.clear();
    this._toolInflight = 0;
    this._needResponse = false;
    this._setState('idle');
  }
}
