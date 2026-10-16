// [2026-10-15 native-onboarding] Primeira tela + cadastro "nível WhatsApp/Telegram".
//
// Liga/desliga do fluxo novo (components/nativeOnboarding/NativeOnboardingFlow):
//   globalThis.__chatyy_native_onboarding = false  → fluxo atual (SignupIntro +
//                                                   /login + /signup-phone legados)
//   globalThis.__chatyy_native_onboarding = true   → força o fluxo novo
//   (indefinido)                                   → padrão abaixo
//
// Padrão: web = ligado; nativo = SÓ no binário novo (marcador: editor nativo
// ChatyyMediaEditor apiVersion >= 2 = recorte circular do avatar). Binário
// antigo que recebe este JS por OTA continua IDÊNTICO (fluxo legado).
// Qualquer crash de render do fluxo novo desliga-o pelo resto da sessão
// (disableNativeOnboardingForSession) e o chamador cai no fluxo legado.
import { Platform } from 'react-native';

let _sessionOff = false;
let _sessionReason = '';
let _binaryOk;

function _newBinary() {
  if (_binaryOk !== undefined) return _binaryOk;
  _binaryOk = false;
  try {
    // eslint-disable-next-line global-require
    const ME = require('../../modules/expo-media-editor');
    _binaryOk = !!ME && typeof ME.apiVersion === 'function' && ME.apiVersion() >= 2;
  } catch { _binaryOk = false; }
  return _binaryOk;
}

export function isNativeOnboardingOn() {
  if (_sessionOff) return false;
  try {
    const o = globalThis.__chatyy_native_onboarding;
    if (o === false) return false;
    if (o === true) return true;
  } catch {}
  if (Platform.OS === 'web') return true;
  return _newBinary();
}

/** Recorte circular nativo disponível (mesmo marcador do binário novo). */
export function hasNativeCircleCrop() {
  if (Platform.OS === 'web') return false;
  try { if (globalThis.__chatyy_native_editor === false) return false; } catch {}
  return _newBinary();
}

export function disableNativeOnboardingForSession(reason) {
  if (_sessionOff) return;
  _sessionOff = true;
  _sessionReason = String(reason || '').slice(0, 300);
  try {
    require('../../services/nativeTelemetry').nativeBeacon('native_onboarding', 'disabled', _sessionReason); // [wave7]
  } catch {}
}

export function nativeOnboardingDisabledReason() { return _sessionReason; }
