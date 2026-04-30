/**
 * twilioCall — WebRTC PSTN dialer via Twilio Voice SDK.
 *
 * STAGE 1 da migração A3 (Telnyx Verto → Twilio). Por enquanto só funciona no
 * web (usa @twilio/voice-sdk, que tá nas deps). Mobile precisa
 * @twilio/voice-react-native-sdk (build nativo novo) — STAGE 2.
 *
 * API igual ao services/sipCall.js pra trocar 1:1 no ChatCallsTab:
 *   await startTwilioCall(creds, '+5511...', onStateChange)
 *   - creds: { token, identity, caller_id }  (de api.voipTwilioToken())
 *   - onStateChange: (state, data?) => void
 *     states: 'connecting' | 'ringing' | 'connected' | 'tick' | 'ended' | 'error:<msg>'
 */
import { Platform } from 'react-native';

let _device = null;     // Twilio Device
let _activeCall = null; // Twilio Call object
let _callInProgress = false;
let _onStateChange = null;
let _tickInterval = null;

function _emit(state, extra) {
  try { _onStateChange?.(state, extra); } catch {}
}

function _isValidE164(s) {
  return typeof s === 'string' && /^\+?[1-9]\d{6,15}$/.test(String(s).replace(/[^\d+]/g, ''));
}

/**
 * Pre-warm Device: registra com o token pra receber chamadas. Chamado no
 * start do app pelos clients que querem inbound (web only por ora).
 */
export async function registerTwilioDevice(creds) {
  if (Platform.OS !== 'web') return false; // mobile usa native SDK em STAGE 2
  if (!creds?.token) return false;
  try {
    const { Device } = await import('@twilio/voice-sdk');
    if (_device) {
      try { _device.updateToken(creds.token); } catch {}
      return true;
    }
    _device = new Device(creds.token, {
      logLevel: 'warn',
      codecPreferences: ['opus', 'pcmu'],
      closeProtection: true,
      enableImprovedSignalingErrorPrecision: true,
    });
    _device.on('error', (err) => {
      console.warn('[twilio] device error:', err?.message || err);
    });
    _device.on('tokenWillExpire', () => {
      // Cliente refaz fetch do token via api.voipTwilioToken() e chama
      // registerTwilioDevice de novo. Aqui só sinaliza.
      _emit('token_expiring');
    });
    await _device.register();
    return true;
  } catch (e) {
    console.warn('[twilio] device init failed:', e?.message);
    _device = null;
    return false;
  }
}

/**
 * Outbound call. Returns { success: true } if dialing started; the
 * onStateChange callback fires the actual call lifecycle events.
 */
export async function startTwilioCall(creds, destinationNumber, onStateChange) {
  if (Platform.OS !== 'web') {
    onStateChange?.('error:Twilio Voice mobile SDK not yet wired (STAGE 2 build pending)');
    return { success: false };
  }
  if (_callInProgress) return { success: true }; // dedup
  if (!_isValidE164(destinationNumber)) {
    onStateChange?.('error:Invalid phone number — use E.164 format (+55...)');
    return { success: false };
  }
  _onStateChange = onStateChange;

  try {
    if (!_device) {
      const ok = await registerTwilioDevice(creds);
      if (!ok) { _emit('error:Twilio device init failed'); return { success: false }; }
    }
    _emit('connecting');
    _callInProgress = true;

    const params = { To: destinationNumber };
    if (creds?.caller_id) params.CallerId = creds.caller_id;

    _activeCall = await _device.connect({ params });

    _activeCall.on('ringing', () => _emit('ringing'));
    _activeCall.on('accept', () => {
      _emit('connected');
      // Tick uma vez por segundo enquanto conectado pra UI mostrar duration
      let secs = 0;
      _tickInterval = setInterval(() => {
        secs += 1;
        _emit('tick', { duration: secs });
      }, 1000);
    });
    _activeCall.on('disconnect', () => {
      if (_tickInterval) { clearInterval(_tickInterval); _tickInterval = null; }
      _activeCall = null;
      _callInProgress = false;
      _emit('ended');
    });
    _activeCall.on('cancel', () => {
      _activeCall = null;
      _callInProgress = false;
      _emit('ended');
    });
    _activeCall.on('reject', () => {
      _activeCall = null;
      _callInProgress = false;
      _emit('ended');
    });
    _activeCall.on('error', (err) => {
      _emit('error:' + (err?.message || 'unknown'));
      try { _activeCall?.disconnect(); } catch {}
    });

    return { success: true };
  } catch (e) {
    console.warn('[twilio] startCall error:', e?.message);
    _emit('error:' + (e?.message || 'connect failed'));
    _callInProgress = false;
    return { success: false };
  }
}

export function hangupTwilioCall() {
  try { _activeCall?.disconnect(); } catch {}
  _activeCall = null;
  _callInProgress = false;
  if (_tickInterval) { clearInterval(_tickInterval); _tickInterval = null; }
}

export function muteTwilioCall(muted) {
  try { _activeCall?.mute(!!muted); } catch {}
}

export function sendTwilioDtmf(digit) {
  try { _activeCall?.sendDigits(String(digit)); } catch {}
}

export function isTwilioCallActive() {
  return !!_activeCall;
}

export function destroyTwilioDevice() {
  try { _device?.destroy(); } catch {}
  _device = null;
  _activeCall = null;
  _callInProgress = false;
  if (_tickInterval) { clearInterval(_tickInterval); _tickInterval = null; }
}
