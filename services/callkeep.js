/**
 * CallKeep Service — CallKit (iOS) via custom Expo Module
 * Uses modules/expo-callkit for native CallKit + PushKit integration
 */
import { Platform } from 'react-native';

let ExpoCallKit = null;
let _isSetup = false;

function loadModule() {
  if (Platform.OS === 'web') return false;
  try {
    if (!ExpoCallKit) {
      ExpoCallKit = require('../modules/expo-callkit');
    }
    return true;
  } catch (e) {
    console.warn('[CallKeep] Failed to load ExpoCallKit:', e.message);
    return false;
  }
}

function isChina() {
  try {
    const { NativeModules } = require('react-native');
    const locale = NativeModules?.SettingsManager?.settings?.AppleLocale
      || NativeModules?.I18nManager?.localeIdentifier
      || '';
    const region = locale.split('_').pop()?.toUpperCase() || '';
    if (region === 'CN') return true;
    // Also check via expo-localization if available
    try {
      const { getLocales } = require('expo-localization');
      const locales = getLocales();
      if (locales?.[0]?.regionCode === 'CN') return true;
    } catch {}
    return false;
  } catch { return false; }
}

export async function setupCallKeep() {
  if (_isSetup || Platform.OS === 'web') return;
  // Apple requires CallKit to be disabled in China (MIIT regulation)
  if (Platform.OS === 'ios' && isChina()) {
    console.log('[CallKeep] CallKit disabled in China per MIIT regulation');
    return;
  }

  // Report diagnostic to server
  const reportDiag = async (info) => {
    try {
      const apiMod = require('./api');
      await apiMod.apiCall('callkit_diag', { info, platform: Platform.OS }, 'POST');
    } catch {}
  };

  const loaded = loadModule();
  await reportDiag(loaded ? 'module_loaded' : 'module_load_failed');
  if (!loaded) return;

  // Check if NATIVE module actually exists (not just JS wrappers)
  let nativeExists = false;
  try {
    const { NativeModulesProxy } = require('expo-modules-core');
    nativeExists = !!NativeModulesProxy?.ExpoCallKit;
    await reportDiag('native_proxy:' + String(nativeExists));
    if (NativeModulesProxy) {
      const mods = Object.keys(NativeModulesProxy).filter(k => k.toLowerCase().includes('call') || k.toLowerCase().includes('kit') || k.toLowerCase().includes('voip'));
      await reportDiag('matching_native_mods:' + (mods.join(',') || 'none'));
    }
  } catch (ne) {
    await reportDiag('native_check_error:' + ne?.message);
  }

  // Also try requireNativeModule directly
  try {
    const { requireNativeModule } = require('expo-modules-core');
    const nm = requireNativeModule('ExpoCallKit');
    await reportDiag('requireNative:found,type=' + typeof nm);
  } catch (re) {
    await reportDiag('requireNative:failed=' + re?.message);
  }

  try {
    let setupOk = false;
    try {
      setupOk = await ExpoCallKit.setup();
    } catch (se) {
      await reportDiag('setup_threw:' + (se?.message || String(se)));
    }
    await reportDiag('setup_ok:' + String(setupOk));

    if (!setupOk) {
      await reportDiag('setup_failed_skipping');
      return;
    }
    _isSetup = true;

    // Listen for VoIP token
    try {
      ExpoCallKit.onVoipTokenReceived(({ token }) => {
        reportDiag('voip_token_received:' + (token?.substring(0, 8) || 'null'));
        sendVoipToken(token);
      });
      await reportDiag('voip_listener_registered');
    } catch (le) {
      await reportDiag('voip_listener_error:' + (le?.message || String(le)));
    }

    // Audio interruption listener — pause the WebRTC peer connection when
    // a system audio interruption (PSTN call, alarm) starts, resume after.
    // The actual peer pause/resume happens in app/call.js via _audioInterruptionRef.
    try {
      ExpoCallKit.onAudioInterruption?.(({ state, shouldResume }) => {
        try {
          const callState = require('./callState');
          if (state === 'began') {
            callState.notifyAudioInterruption?.('began');
          } else if (state === 'ended' && shouldResume) {
            callState.notifyAudioInterruption?.('ended');
          }
        } catch {}
      });
    } catch {}

    // Network reachability listener — surface to JS so the call screen can
    // show "Reconnecting..." badges when Wi-Fi drops mid-call.
    try {
      ExpoCallKit.onNetworkChange?.(({ status, isExpensive }) => {
        try {
          const callState = require('./callState');
          callState.notifyNetworkChange?.(status, !!isExpensive);
        } catch {}
      });
    } catch {}

    // Register for VoIP push (iOS)
    if (Platform.OS === 'ios') {
      try {
        ExpoCallKit.registerVoipPush();
        await reportDiag('voip_push_requested');
      } catch (ve) {
        await reportDiag('voip_push_error:' + (ve?.message || String(ve)));
      }

      // Check for cached token after a delay
      setTimeout(async () => {
        try {
          const cachedToken = ExpoCallKit.getVoipToken?.();
          await reportDiag('cached_voip_token:' + (cachedToken ? cachedToken.substring(0, 8) : 'null'));
          if (cachedToken) {
            sendVoipToken(cachedToken);
          }
        } catch {}

        // Get full diagnostics
        try {
          const diag = ExpoCallKit.getDiagnostics?.();
          if (diag) {
            await reportDiag('native_diag:' + JSON.stringify(diag));
          }
        } catch {}
      }, 5000);
    }
  } catch (e) {
    await reportDiag('outer_error:' + (e?.message || String(e)));
  }
}

async function sendVoipToken(token) {
  if (!token) return;
  try {
    const api = require('./api');
    await api.apiCall('register_voip_token', { token }, 'POST');
    console.log('[CallKeep] VoIP token sent to server');
  } catch (e) {
    console.warn('[CallKeep] Failed to send VoIP token:', e);
  }
}

export function displayIncomingCall(callId, callerName, callerEmail, isVideo = false, conversationId = '') {
  // Carrega o módulo lazy se ainda não foi setupado — antes retornava false
  // sempre que setupCallKeep não tinha rodado (ex.: push wake-up cedo).
  if (!ExpoCallKit && !loadModule()) return false;
  try {
    ExpoCallKit.displayIncomingCall(
      callId || generateUUID(),
      callerName || callerEmail || 'Unknown',
      isVideo,
      callerEmail || '',
      conversationId || ''
    );
    return true;
  } catch (e) {
    console.warn('[CallKeep] displayIncomingCall error:', e);
    return false;
  }
}

export function endCall(callId) {
  if (!loadModule()) return;
  try {
    ExpoCallKit.endCall(callId);
  } catch {}
}

/**
 * Tell the native side ("WhatsApp-grade warm path") that the in-app call
 * screen has mounted and is ready to show. On Android this dismisses the
 * IncomingCallActivity overlay that's been showing "Conectando com X..."
 * since the user tapped Atender — without this the overlay sits on top
 * of the freshly-loaded /call screen for 8s (its safety timeout). iOS
 * implements this as a no-op since CallKit handles the handoff natively.
 */
export function notifyAppReady() {
  if (!loadModule()) return;
  try {
    ExpoCallKit.notifyAppReady?.();
  } catch {}
}

// [bug 2026-05-15 #981] Toggle iOS speaker mode at runtime. Native default
// is earpiece (audio call); /call calls this with true on mount when the
// call is video, or on the user's "speaker" button press. No-op on Android
// (Android speaker is managed via in-call manager / AudioManager).
export function setSpeakerEnabled(enabled) {
  if (!loadModule()) return;
  try {
    ExpoCallKit.setSpeakerEnabled?.(!!enabled);
  } catch {}
}

export function reportConnected(callId) {
  // Not needed - CallKit handles via answer action
}

export function startCall(callId, callerName, callerEmail, isVideo = false) {
  // Outgoing calls don't need CallKit
}

/**
 * Check for a call that was accepted from the native Android UI while the app was dead.
 * Returns call data or null. Should be called once on app startup.
 */
export function consumePendingCall() {
  if (!loadModule()) return null;
  try {
    return ExpoCallKit.consumePendingCall();
  } catch {
    return null;
  }
}

// Track whether pending events have been consumed (only do it once)
let _pendingEventsConsumed = false;

let _diag = () => {};
try { _diag = require('./voipDiag').default; } catch {}

export function addCallKeepListeners({ onAnswer, onEnd }) {
  if (!loadModule()) return () => {};

  _diag('callkeep_listeners_register', '', { hasOnAnswer: !!onAnswer, hasOnEnd: !!onEnd });

  const unsub1 = ExpoCallKit.onCallAnswered((data) => {
    console.log('[CallKeep] Call answered:', data.callId);
    _diag('callkeep_answered_live', data?.callId || '', { callerEmail: data?.callerEmail || '' });
    if (onAnswer) onAnswer(data);
  });

  const unsub2 = ExpoCallKit.onCallEnded(({ callId }) => {
    console.log('[CallKeep] Call ended:', callId);
    _diag('callkeep_ended_live', callId || '');
    if (onEnd) onEnd(callId);
  });

  // Consume any events that were buffered before JS was ready (cold start)
  // Only call once — a second call would return empty and lose events
  if (!_pendingEventsConsumed) {
    _pendingEventsConsumed = true;
    try {
      const pendingEvents = ExpoCallKit.consumePendingEvents();
      _diag('callkeep_consume_pending', '', { count: (pendingEvents || []).length, names: (pendingEvents || []).map(e => e._eventName) });
      if (pendingEvents && pendingEvents.length > 0) {
        console.log('[CallKeep] Processing', pendingEvents.length, 'pending events from cold start');
        // Store incoming call events for addIncomingCallListener to pick up
        _bufferedIncomingCallEvents = [];
        for (const evt of pendingEvents) {
          const eventName = evt._eventName;
          if (eventName === 'onCallAnswered' && onAnswer) {
            console.log('[CallKeep] Replaying buffered onCallAnswered:', evt.callId);
            _diag('callkeep_replay_answered', evt.callId, { callerEmail: evt?.callerEmail || '', callerName: evt?.callerName || '' });
            onAnswer(evt);
          } else if (eventName === 'onCallEnded' && onEnd) {
            console.log('[CallKeep] Replaying buffered onCallEnded:', evt.callId);
            _diag('callkeep_replay_ended', evt.callId);
            onEnd(evt.callId);
          } else if (eventName === 'onIncomingCall') {
            _diag('callkeep_replay_incoming_buffered', evt.callId, { callerEmail: evt?.callerEmail || '' });
            _bufferedIncomingCallEvents.push(evt);
          }
        }
      }
    } catch (e) {
      console.warn('[CallKeep] consumePendingEvents error:', e);
      _diag('callkeep_consume_error', '', { msg: String(e?.message || e) });
    }
  }

  return () => {
    if (typeof unsub1 === 'function') unsub1();
    if (typeof unsub2 === 'function') unsub2();
  };
}

// Buffer for incoming call events consumed by addCallKeepListeners before
// addIncomingCallListener is registered
let _bufferedIncomingCallEvents = [];

export function addIncomingCallListener(callback) {
  if (!loadModule()) return () => {};
  const unsub = ExpoCallKit.onIncomingCall((data) => {
    console.log('[CallKeep] Incoming call event:', data.callId);
    if (callback) callback(data);
  });

  // Replay any buffered onIncomingCall events that were consumed earlier
  if (_bufferedIncomingCallEvents.length > 0 && callback) {
    for (const evt of _bufferedIncomingCallEvents) {
      console.log('[CallKeep] Replaying buffered onIncomingCall:', evt.callId);
      callback(evt);
    }
    _bufferedIncomingCallEvents = [];
  }

  return typeof unsub === 'function' ? unsub : () => {};
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export const CallKeeper = null;
export const isSetup = false;
