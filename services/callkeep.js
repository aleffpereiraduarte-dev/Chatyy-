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

export async function setupCallKeep() {
  if (_isSetup || Platform.OS === 'web') return;

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

export function displayIncomingCall(callId, callerName, callerEmail, isVideo = false) {
  if (!ExpoCallKit) return false;
  try {
    ExpoCallKit.displayIncomingCall(callId || generateUUID(), callerName || callerEmail || 'Unknown', isVideo);
    return true;
  } catch (e) {
    console.warn('[CallKeep] displayIncomingCall error:', e);
    return false;
  }
}

export function endCall(callId) {
  if (!ExpoCallKit) return;
  try {
    ExpoCallKit.endCall(callId);
  } catch {}
}

export function reportConnected(callId) {
  // Not needed - CallKit handles via answer action
}

export function startCall(callId, callerName, callerEmail, isVideo = false) {
  // Outgoing calls don't need CallKit
}

export function addCallKeepListeners({ onAnswer, onEnd }) {
  if (!ExpoCallKit) return () => {};

  const unsub1 = ExpoCallKit.onCallAnswered(({ callId }) => {
    console.log('[CallKeep] Call answered:', callId);
    if (onAnswer) onAnswer(callId);
  });

  const unsub2 = ExpoCallKit.onCallEnded(({ callId }) => {
    console.log('[CallKeep] Call ended:', callId);
    if (onEnd) onEnd(callId);
  });

  return () => {
    unsub1();
    unsub2();
  };
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export const CallKeeper = null;
export const isSetup = false;
