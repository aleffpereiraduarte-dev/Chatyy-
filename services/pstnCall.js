// pstnCall.js — Discador PSTN ("ligar pra qualquer número") via LiveKit + Vonage.
//
// Substitui o caminho Telnyx (conta suspensa). Fluxo:
//   1) POST email.php?action=pstn_dial { to, name } → backend cria sala LK +
//      manda a Vonage LIGAR pro número e conectar o áudio no livekit-sip.
//   2) App entra na MESMA sala LK com o token retornado (áudio 2-vias).
//   3) Quando o número ATENDE, o leg SIP entra na sala → ParticipantConnected
//      → estado 'connected'. Antes disso = 'ringing'.
//
// Interface espelha services/sipCall.js (startSipCall/hangupSipCall/muteSipCall/
// isCallActive) pra ChatCallsTab plugar sem mexer no resto.
//
// Áudio: usa o MESMO setup do app/call.js (LiveKit AudioSession) — _layout.js
// registra com autoConfigureAudioSession:false, então configuramos e iniciamos
// a sessão à mão (senão: conecta mas sem áudio). NÃO usa ExpoAudioSession aqui
// pra não disputar o AVAudioSession com o LiveKit.

import { Platform } from 'react-native';
import { Room, RoomEvent } from 'livekit-client';
import { apiCall } from './api';

let LK_AudioSession = null;
if (Platform.OS !== 'web') {
  try {
    const lkrn = require('@livekit/react-native');
    LK_AudioSession = lkrn.AudioSession || null;
  } catch (_) {}
}

let _room = null;
let _tickTimer = null;
let _connectedAt = 0;
let _onState = null;
let _ended = false;

async function _setupAudio() {
  if (Platform.OS === 'web' || !LK_AudioSession) return;
  try {
    const lkrn = require('@livekit/react-native');
    if (Platform.OS === 'ios'
        && typeof LK_AudioSession.setAppleAudioConfiguration === 'function'
        && typeof lkrn.getDefaultAppleAudioConfigurationForMode === 'function') {
      // 'localAndRemote' → playAndRecord; false = audio-only (voiceChat/earpiece).
      // Mesmo config que corrigiu o "conecta mas não escuto" nas ligações in-app.
      const cfg = lkrn.getDefaultAppleAudioConfigurationForMode('localAndRemote', false);
      await LK_AudioSession.setAppleAudioConfiguration(cfg);
    } else if (Platform.OS === 'android'
        && typeof LK_AudioSession.configureAudio === 'function'
        && lkrn.AndroidAudioTypePresets) {
      await LK_AudioSession.configureAudio({
        android: {
          preferredOutputList: ['earpiece'],
          audioTypeOptions: lkrn.AndroidAudioTypePresets.communication,
        },
      });
    }
  } catch (e) { console.warn('[PSTN] audio configure err:', e?.message); }
  try {
    await LK_AudioSession.startAudioSession();
    try { await LK_AudioSession.selectAudioOutput?.(Platform.OS === 'ios' ? 'default' : 'earpiece'); } catch (_) {}
  } catch (e) { console.warn('[PSTN] startAudioSession err:', e?.message); }
}

async function _teardownAudio() {
  if (Platform.OS === 'web' || !LK_AudioSession) return;
  try { await LK_AudioSession.stopAudioSession(); } catch (_) {}
}

function _startTick() {
  if (_tickTimer) return;
  _tickTimer = setInterval(() => { if (_room && _onState) { try { _onState('tick'); } catch (_) {} } }, 1000);
}

function _markConnected() {
  if (_connectedAt !== 0) return;
  _connectedAt = Date.now();
  try { _onState?.('connected'); } catch (_) {}
  _startTick();
}

function _finish(errMsg) {
  if (_ended) return;
  _ended = true;
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
  const r = _room; _room = null;
  if (r) { try { r.removeAllListeners?.(); } catch (_) {} try { r.disconnect(); } catch (_) {} }
  _teardownAudio();
  try { _onState?.(errMsg ? ('error:' + errMsg) : 'ended'); } catch (_) {}
}

export function isPstnCallActive() { return !!_room; }

export function mutePstnCall(muted) {
  try { _room?.localParticipant?.setMicrophoneEnabled(!muted); } catch (_) {}
}

export function hangupPstnCall() {
  if (!_room && !_tickTimer) return;
  _finish(null);
}

// startPstnCall(phoneNum, name, onState) — onState: 'ringing'|'connected'|'tick'|'ended'|'error:<msg>'
export async function startPstnCall(phoneNum, name, onStateChange) {
  if (_room) { try { hangupPstnCall(); } catch (_) {} }
  _onState = typeof onStateChange === 'function' ? onStateChange : () => {};
  _connectedAt = 0;
  _ended = false;

  let res;
  try {
    res = await apiCall('pstn_dial', { to: phoneNum, name: name || '' }, 'POST');
  } catch (e) {
    _ended = true; try { _onState('error:' + (e?.message || 'network')); } catch (_) {}
    return;
  }
  if (!res?.success || !res?.data?.token || !res?.data?.url) {
    _ended = true; try { _onState('error:' + (res?.message || 'Falha ao iniciar ligação')); } catch (_) {}
    return;
  }

  const { url, token } = res.data;
  try { _onState('ringing'); } catch (_) {}  // Vonage já está discando o número

  await _setupAudio();

  const room = new Room({ adaptiveStream: false, dynacast: false });
  _room = room;

  room.on(RoomEvent.ParticipantConnected, () => { _markConnected(); });
  room.on(RoomEvent.Disconnected, () => { _finish(null); });
  // Se o número ATENDE e depois desliga (leg SIP sai), encerra a ligação.
  room.on(RoomEvent.ParticipantDisconnected, () => {
    if (_connectedAt !== 0) _finish(null);
  });

  try {
    await room.connect(url, token);
    // Race: leg SIP já presente no connect (atendimento instantâneo).
    const remotes = room.remoteParticipants || room.participants;
    if (remotes && (remotes.size > 0 || remotes.length > 0)) _markConnected();
    await room.localParticipant.setMicrophoneEnabled(true);
  } catch (e) {
    _finish(e?.message || 'connect failed');
  }
}
