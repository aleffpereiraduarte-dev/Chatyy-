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
  if (!loadModule()) return;

  try {
    const ok = await ExpoCallKit.setup();
    if (!ok) return;

    _isSetup = true;
    console.log('[CallKeep] Setup complete');

    // Listen for VoIP token
    ExpoCallKit.onVoipTokenReceived(({ token }) => {
      console.log('[CallKeep] VoIP token received:', token?.substring(0, 8) + '...');
      sendVoipToken(token);
    });

    // Register for VoIP push (iOS)
    if (Platform.OS === 'ios') {
      ExpoCallKit.registerVoipPush();
      console.log('[CallKeep] VoIP push registration requested');
    }
  } catch (e) {
    console.warn('[CallKeep] Setup error:', e);
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
