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
    const webrtc = require('@stream-io/react-native-webrtc');
    RTCPeerConnection = webrtc.RTCPeerConnection;
    RTCSessionDescription = webrtc.RTCSessionDescription;
    mediaDevices = webrtc.mediaDevices;
  } catch {}
}

export function isRealtimeSupported() {
  return !!(RTCPeerConnection && mediaDevices?.getUserMedia);
}

async function mintEphemeralToken() {
  const res = await api.apiCall('realtime_ephemeral_token', {}, 'POST');
  if (!res?.success || !res?.data?.client_secret) {
    throw new Error(res?.message || 'token mint failed');
  }
  return {
    token: res.data.client_secret,
    model: res.data.model || 'gpt-4o-realtime-preview',
  };
}

export class OneRealtimeSession {
  constructor(handlers = {}) {
    this.handlers = handlers; // onState, onTranscript, onAssistantText, onError, onClose
    this.pc = null;
    this.dc = null;
    this.localStream = null;
    this.remoteAudioEl = null; // web <audio>
    this.active = false;
    this.currentState = 'idle';
  }

  _emit(name, payload) {
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
    if (!isRealtimeSupported()) throw new Error('WebRTC not available');
    this.active = true;
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
    if (Platform.OS !== 'web') {
      try {
        const expoAudio = require('expo-audio');
        await expoAudio.setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
          interruptionMode: 'duckOthers',
          shouldPlayInBackground: false,
          shouldRouteThroughEarpiece: false,
        });
      } catch {}
    }

    // 1. Ephemeral token from our backend
    const { token, model } = await mintEphemeralToken();

    // 2. Mic stream
    this.localStream = await mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
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
    this.dc.onmessage = (ev) => this._onEvent(ev.data);
    this.dc.onclose = () => { if (this.active) this._emit('onClose'); };
    this.dc.onerror = (e) => this._emit('onError', e);

    this.pc.oniceconnectionstatechange = () => {
      const s = this.pc?.iceConnectionState;
      if (s === 'failed' || s === 'disconnected') {
        this._emit('onError', new Error('ICE ' + s));
      }
    };

    // 5. SDP offer → OpenAI → answer
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    const sdpRes = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
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
    await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: answerSdp }));

    this._setState('listening');
  }

  _onEvent(raw) {
    let msg;
    try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
    const t = msg.type;

    if (t === 'conversation.item.input_audio_transcription.completed' && msg.transcript) {
      this._emit('onTranscript', msg.transcript);
      return;
    }
    if (t === 'response.audio_transcript.delta' && msg.delta) {
      this._emit('onAssistantText', { delta: msg.delta });
      return;
    }
    if (t === 'response.audio_transcript.done' && msg.transcript) {
      this._emit('onAssistantText', { transcript: msg.transcript, done: true });
      return;
    }
    if (t === 'input_audio_buffer.speech_started') {
      this._setState('listening');
      return;
    }
    if (t === 'response.audio.delta') {
      this._setState('speaking');
      return;
    }
    if (t === 'response.audio.done' || t === 'response.done') {
      // Playback continues through the audio stream, but mark transition.
      setTimeout(() => { if (this.active) this._setState('listening'); }, 50);
      return;
    }
    if (t === 'error') {
      this._emit('onError', msg.error || msg);
    }
  }

  stop() {
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
    }
    this.dc = null;
    this.pc = null;
    this.localStream = null;
    this._setState('idle');
  }
}
