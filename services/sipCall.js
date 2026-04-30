/**
 * Telnyx Verto Call — Raw Verto protocol
 * WebSocket JSON-RPC + native RTCPeerConnection
 */
import { Platform } from 'react-native';
import { getBaseUrl } from './api';

let RTCPeerConnection = null;
let RTCSessionDescription = null;
let mediaDevices = null;

// Lazy init — only load WebRTC when actually making a call
function ensureWebRTC() {
  if (RTCPeerConnection) return true;
  try {
    if (Platform.OS !== 'web') {
      const webrtc = require('@stream-io/react-native-webrtc');
      RTCPeerConnection = webrtc.RTCPeerConnection;
      RTCSessionDescription = webrtc.RTCSessionDescription;
      mediaDevices = webrtc.mediaDevices;
      try { webrtc.registerGlobals?.(); } catch (e) {}
    } else {
      RTCPeerConnection = window.RTCPeerConnection;
      RTCSessionDescription = window.RTCSessionDescription;
      mediaDevices = navigator.mediaDevices;
    }
    return !!RTCPeerConnection && !!mediaDevices;
  } catch (e) {
    if (__DEV__) console.warn('[Verto] WebRTC load error:', e.message);
    return false;
  }
}

// WebSocket URL - use our proxy (works on iOS/Android/Web without ATS issues)
function getTelnyxWsUrl() {
  return 'wss://chatyy.com.br/telnyx-ws';
}

const ICE_SERVERS = [
  { urls: 'stun:stun.telnyx.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:mail.onemundo.com.br:3478' },
  // TURN via our coturn — credentials set dynamically in startSipCall if available
];

// TURN credentials can be injected before calling startSipCall
let _turnCredentials = null;
export function setTurnCredentials(creds) { _turnCredentials = creds; }

function getIceServers() {
  const servers = [...ICE_SERVERS];
  if (_turnCredentials?.urls) {
    servers.push({
      urls: _turnCredentials.urls,
      username: _turnCredentials.username,
      credential: _turnCredentials.credential,
    });
  }
  return servers;
}

// Timeouts
const LOGIN_TIMEOUT_MS = 10000;  // 10s for Verto login
const CALL_SETUP_TIMEOUT_MS = 45000; // 45s for call to connect

// SIP error code → user-friendly message mapping
const SIP_ERROR_MESSAGES = {
  403: 'Call rejected — permission denied',
  404: 'Number not found',
  408: 'Call timed out — no response',
  480: 'User temporarily unavailable',
  486: 'Line is busy',
  487: 'Call was cancelled',
  488: 'Call not acceptable — codec mismatch',
  500: 'Server error — try again later',
  502: 'Gateway error — try again later',
  503: 'Service unavailable — try again later',
  600: 'Line is busy',
  603: 'Call declined',
  location: 'Number not reachable',
};

function getSipErrorMessage(code, fallback) {
  if (code && SIP_ERROR_MESSAGES[code]) return SIP_ERROR_MESSAGES[code];
  return fallback || 'Call ended';
}

// E.164 phone number validation
function isValidE164(number) {
  // Must start with + and have 7-15 digits
  return /^\+[1-9]\d{6,14}$/.test(number);
}

let _ws = null;
let _pc = null;
let _localStream = null;
let _onStateChange = null;
let _tickInterval = null;
let _sessid = null;
let _callId = null;
let _dest = null;
let _callerId = '';
let _loginDone = false;
let _callInProgress = false;
let _loginTimer = null;
let _callSetupTimer = null;

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function wsSend(method, params = {}) {
  try {
    if (!_ws || _ws.readyState !== 1) return;
    _ws.send(JSON.stringify({
      jsonrpc: '2.0', id: uuid(), method,
      params: { ...params, sessid: _sessid },
    }));
  } catch (e) {
    if (__DEV__) console.warn('[Verto] wsSend error:', e.message);
  }
}

function clearTimers() {
  if (_loginTimer) { clearTimeout(_loginTimer); _loginTimer = null; }
  if (_callSetupTimer) { clearTimeout(_callSetupTimer); _callSetupTimer = null; }
}

export async function startSipCall(creds, destinationNumber, onStateChange) {
  // Prevent double calls — check WS exists OR flag is set
  if (_callInProgress || _ws) {
    if (__DEV__) console.log('[Verto] Call already in progress, ignoring duplicate');
    return { success: true };
  }
  if (!ensureWebRTC()) {
    onStateChange('error:WebRTC not available on this device');
    return { success: false };
  }

  // Validate E.164 format
  if (!isValidE164(destinationNumber)) {
    onStateChange('error:Invalid phone number. Use E.164 format (e.g. +15551234567)');
    return { success: false };
  }

  _onStateChange = onStateChange;
  _dest = destinationNumber;
  _callerId = creds?.caller_id || '';
  _sessid = uuid();
  _callId = null;
  onStateChange('connecting');

  try {
    cleanup();
    // Marcar APÓS cleanup — antes a flag era setada acima e cleanup logo
    // em seguida zerava, abrindo janela pra chamadas duplicadas.
    _callInProgress = true;

    const wsUrl = getTelnyxWsUrl();
    if (__DEV__) console.log('[Verto] Connecting to', wsUrl);
    _ws = new WebSocket(wsUrl);

    // Login timeout — if login doesn't complete in 10s, abort
    _loginTimer = setTimeout(() => {
      if (!_loginDone) {
        if (__DEV__) console.warn('[Verto] Login timeout after ' + LOGIN_TIMEOUT_MS + 'ms');
        onStateChange('error:Connection timed out — check your internet');
        cleanup();
      }
    }, LOGIN_TIMEOUT_MS);

    _ws.onopen = () => {
      if (__DEV__) console.log('[Verto] WS open');
      try {
        // Use SIP user/password (linked to Telnyx connection with outbound profile)
        const loginParams = (creds?.sip_user && creds?.sip_password)
          ? { login: creds.sip_user, passwd: creds.sip_password, userVariables: {} }
          : { login_token: creds?.token, userVariables: {} };
        wsSend('login', loginParams);
      } catch (e) {
        if (__DEV__) console.warn('[Verto] Login send error:', e.message);
        onStateChange('error:Login failed');
      }
    };

    _ws.onmessage = (e) => {
      try { handleMessage(JSON.parse(e.data)); }
      catch (err) { console.warn('[Verto] msg parse error:', err.message); }
    };

    let _errorHandled = false;
    _ws.onerror = (e) => {
      if (_errorHandled) return;
      _errorHandled = true;
      onStateChange('error:Network error — check your connection');
      cleanup();
    };
    _ws.onclose = (e) => {
      if (_errorHandled) return; // Already handled by onerror
      if (_callId) { onStateChange('ended'); cleanup(); }
      else if (!_loginDone) {
        // Don't show error immediately — give login timer a chance
        // The loginTimer (10s) will handle the timeout message
      }
    };

    return { success: true };
  } catch (e) {
    if (__DEV__) console.warn('[Verto] startSipCall error:', e.message);
    onStateChange('error:' + e.message);
    cleanup();
    return { success: false };
  }
}

async function handleMessage(msg) {
  try {
    // Login OK (guard against double login response)
    if ((msg.result?.message === 'logged in' || msg.result?.sessid) && !_loginDone) {
      _loginDone = true;
      clearTimeout(_loginTimer); _loginTimer = null;
      if (__DEV__) console.log('[Verto] Logged in');
      _onStateChange?.('registered');

      // Start call setup timeout — 45s to get connected
      _callSetupTimer = setTimeout(() => {
        if (_callId && _onStateChange) {
          if (__DEV__) console.warn('[Verto] Call setup timeout after ' + CALL_SETUP_TIMEOUT_MS + 'ms');
          _onStateChange('error:Call timed out — no answer');
          hangupSipCall();
        }
      }, CALL_SETUP_TIMEOUT_MS);

      await placeCall();
      return;
    }

    // Acknowledge server methods
    if (msg.method === 'telnyx_rtc.gatewayState' || msg.method === 'telnyx_rtc.clientReady') {
      if (msg.id) _ws?.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { method: msg.method } }));
      return;
    }

    // Ringing
    if (msg.method === 'telnyx_rtc.ringing' || msg.method === 'telnyx_rtc.earlyMedia') {
      if (__DEV__) console.log('[Verto] Ringing');
      _onStateChange?.('ringing');
      if (msg.id) _ws?.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { method: msg.method } }));
      return;
    }

    // Answer SDP
    if (msg.method === 'telnyx_rtc.media') {
      const sdp = msg.params?.sdp;
      if (sdp && _pc) {
        await _pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
        if (__DEV__) console.log('[Verto] Remote SDP set');
      }
      if (msg.id) _ws?.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { method: msg.method } }));
      return;
    }

    // Connected
    if (msg.method === 'telnyx_rtc.answer') {
      if (__DEV__) console.log('[Verto] Connected!');
      clearTimeout(_callSetupTimer); _callSetupTimer = null;
      _onStateChange?.('connected');
      _tickInterval = setInterval(() => _onStateChange?.('tick'), 1000);
      if (msg.id) _ws?.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { method: msg.method } }));
      return;
    }

    // Bye
    if (msg.method === 'telnyx_rtc.bye') {
      const sipCode = msg.params?.sipCode || msg.params?.causeCode;
      const sipReason = msg.params?.sipReason || msg.params?.cause;
      if (__DEV__) console.log('[Verto] BYE received, cause:', msg.params?.cause, 'causeCode:', msg.params?.causeCode, 'sipCode:', sipCode, 'sipReason:', sipReason);

      if (msg.id) _ws?.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { method: msg.method } }));

      // Map SIP code to user-friendly message
      const friendlyMsg = getSipErrorMessage(sipCode, sipReason);
      _onStateChange?.(sipCode >= 400 ? 'error:' + friendlyMsg : 'ended');
      cleanup();
      // Keep _callInProgress true briefly to prevent React re-render from starting new call
      _callInProgress = true;
      setTimeout(() => { _callInProgress = false; }, 1000);
      return;
    }

    // Call created
    if (msg.result?.callID) {
      _callId = msg.result.callID;
      return;
    }

    // Error from server
    if (msg.error) {
      const errCode = msg.error.code;
      const errMsg = msg.error.message || 'Error';
      if (__DEV__) console.warn('[Verto] Server error:', errMsg, 'code:', errCode);
      _onStateChange?.('error:' + getSipErrorMessage(errCode, errMsg));
      cleanup();
    }
  } catch (e) {
    if (__DEV__) console.warn('[Verto] handleMessage error:', e.message);
  }
}

async function placeCall() {
  // iOS: activate audio session BEFORE getUserMedia (required by @stream-io/react-native-webrtc)
  if (Platform.OS !== 'web') {
    try {
      const { RTCAudioSession } = require('@stream-io/react-native-webrtc');
      RTCAudioSession.audioSessionDidActivate();
      if (__DEV__) console.log('[Verto] iOS audio session activated');
    } catch (e) {
      if (__DEV__) console.warn('[Verto] RTCAudioSession not available:', e.message);
    }
    // Also configure expo-av for call mode
    try {
      const { Audio } = require('expo-av');
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        interruptionModeIOS: 1, // DuckOthers
      });
    } catch (e) {}
  }

  try {
    // Get mic
    _localStream = await mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    if (__DEV__) console.warn('[Verto] Mic error:', e.message);
    _onStateChange?.('error:Microphone not available. Check permissions.');
    cleanup();
    return;
  }

  try {
    // Create peer connection
    _pc = new RTCPeerConnection({
      iceServers: getIceServers(),
      // On iOS cellular, relay transport is essential for symmetric NAT traversal
      iceTransportPolicy: 'all',
    });

    // Monitor ICE connection state for debugging
    _pc.oniceconnectionstatechange = () => {
      if (__DEV__) console.log('[Verto] ICE connection state:', _pc?.iceConnectionState);
      if (_pc?.iceConnectionState === 'failed') {
        if (__DEV__) console.warn('[Verto] ICE connection FAILED — likely NAT/firewall issue');
        _onStateChange?.('error:Connection failed. Check your network.');
        cleanup();
      }
    };

    _localStream.getTracks().forEach(track => _pc.addTrack(track, _localStream));

    // Remote audio
    _pc.ontrack = (event) => {
      if (__DEV__) console.log('[Verto] Remote audio received, kind:', event.track?.kind, 'readyState:', event.track?.readyState);
      if (Platform.OS === 'web' && event.streams?.[0]) {
        let audio = document.getElementById('_vertoAudio');
        if (!audio) {
          audio = document.createElement('audio');
          audio.id = '_vertoAudio';
          audio.autoplay = true;
          document.body.appendChild(audio);
        }
        audio.srcObject = event.streams[0];
      }
      // On React Native (iOS/Android), audio plays automatically through the
      // native WebRTC audio track — no <audio> element needed. But we must
      // start InCallManager to route audio to earpiece/speaker properly.
      if (Platform.OS !== 'web') {
        try {
          const InCallManager = require('react-native-incall-manager').default;
          InCallManager.start({ media: 'audio' });
          InCallManager.setForceSpeakerphoneOn(false);
        } catch (e) {
          // InCallManager not installed — audio still works via default route
          if (__DEV__) console.log('[Verto] InCallManager not available, using default audio route');
        }
      }
    };

    // Create offer
    const offer = await _pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: false,
    });
    await _pc.setLocalDescription(offer);

    // Wait for ICE candidates (longer timeout on mobile for TURN relay gathering)
    const gatherTimeout = Platform.OS === 'web' ? 8000 : 15000;
    const sdp = await new Promise((resolve) => {
      if (_pc.iceGatheringState === 'complete') {
        resolve(_pc.localDescription.sdp);
        return;
      }
      let hasRelay = false;
      const timeout = setTimeout(() => {
        if (__DEV__) console.log('[Verto] ICE gathering timed out, hasRelay:', hasRelay);
        resolve(_pc.localDescription?.sdp || offer.sdp);
      }, gatherTimeout);
      _pc.onicecandidate = (e) => {
        if (e.candidate) {
          if (e.candidate.candidate.includes('relay')) hasRelay = true;
          if (__DEV__) console.log('[Verto] ICE candidate:', e.candidate.candidate.split(' ').slice(0, 8).join(' '));
        }
        if (!e.candidate) { clearTimeout(timeout); resolve(_pc.localDescription.sdp); }
      };
    });

    const relayCount = (sdp?.match(/typ relay/g) || []).length;
    const srflxCount = (sdp?.match(/typ srflx/g) || []).length;
    const hostCount = (sdp?.match(/typ host/g) || []).length;
    if (__DEV__) console.log('[Verto] Sending INVITE, SDP length:', sdp?.length, 'candidates: host=' + hostCount, 'srflx=' + srflxCount, 'relay=' + relayCount);

    wsSend('telnyx_rtc.invite', {
      sdp,
      dialogParams: {
        audio: true, video: false, useStereo: false,
        destination_number: _dest,
        caller_id_number: _callerId || '+19513931371', caller_id_name: 'Chatyy',
        callID: uuid(),
        remote_caller_id_name: '', remote_caller_id_number: _dest,
      },
    });
  } catch (e) {
    if (__DEV__) console.warn('[Verto] placeCall error:', e.message);
    _onStateChange?.('error:Failed to start call: ' + e.message);
    cleanup();
  }
}

export function hangupSipCall() {
  try {
    if (_callId && _ws?.readyState === 1) {
      wsSend('telnyx_rtc.bye', { dialogParams: { callID: _callId }, cause: 'NORMAL_CLEARING', causeCode: 16 });
    }
  } catch (e) {}
  _onStateChange?.('ended');
  cleanup();
}

export function muteSipCall(muted) {
  try {
    if (!_pc) return;
    _pc.getSenders().forEach(s => { if (s.track?.kind === 'audio') s.track.enabled = !muted; });
  } catch (e) {}
}

export function sendDTMF(digit) {
  try {
    if (!_pc) return;
    const sender = _pc.getSenders().find(s => s.track?.kind === 'audio');
    if (sender?.dtmf) sender.dtmf.insertDTMF(digit, 100, 70);
  } catch (e) {}
}

export function isCallActive() { return !!_callId; }

function cleanup() {
  clearTimers();
  clearInterval(_tickInterval); _tickInterval = null;
  _callId = null;
  _loginDone = false;
  _callInProgress = false;
  try { _localStream?.getTracks().forEach(t => t.stop()); } catch (e) {}
  _localStream = null;
  try { _pc?.close(); } catch (e) {}
  _pc = null;
  try { _ws?.close(); } catch (e) {}
  _ws = null;
  if (Platform.OS === 'web') {
    try { document.getElementById('_vertoAudio')?.remove(); } catch (e) {}
  }
  if (Platform.OS !== 'web') {
    try {
      const InCallManager = require('react-native-incall-manager').default;
      InCallManager.stop();
    } catch (e) {}
    try {
      const { RTCAudioSession } = require('@stream-io/react-native-webrtc');
      RTCAudioSession.audioSessionDidDeactivate();
    } catch (e) {}
  }
}
