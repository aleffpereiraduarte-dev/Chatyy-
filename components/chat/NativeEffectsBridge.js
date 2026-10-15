// [2026-10-15 native-effects] Ponte JS → modules/expo-chat-effects.
//
// Efeitos de tela cheia em NATIVO (iOS Core Animation / Android partículas no
// DecorView). Devolve true quando o nativo assumiu o efeito — aí o chamador
// NÃO toca o fallback JS (MessageScreenEffect / MessageEffectOverlay).
// Binário antigo sem o módulo, web, ou globalThis.__chatyy_native_effects ===
// false → false, e tudo continua exatamente como antes.
import { Platform } from 'react-native';

let _m;
function _mod() {
  if (_m === undefined) {
    try { _m = require('../../modules/expo-chat-effects'); } catch { _m = null; }
  }
  return _m;
}

export function nativeEffectsAvailable() {
  try {
    if (Platform.OS === 'web') return false;
    if (globalThis.__chatyy_native_effects === false) return false;
    const m = _mod();
    return !!(m && m.isAvailable && m.isAvailable());
  } catch { return false; }
}

/** name: echo|spotlight|balloons|confetti|love|lasers|fireworks|shooting-star|celebration|hearts|fire|party */
export function playNativeEffect(name, opts) {
  try {
    if (!nativeEffectsAvailable()) return false;
    const m = _mod();
    return !!(m && m.play && m.play(name, opts || {}));
  } catch { return false; }
}

// Gatilhos por emoji/palavra-chave ao enviar (antigo MessageEffectOverlay):
// 'confetti' (parabéns/congrats/🎉) vira 'party' no nativo — o 'confetti' do
// nativo é o efeito de tela "Confete" do enviar-com-efeito.
export function playNativeKeywordEffect(kind, opts) {
  const name = kind === 'confetti' ? 'party' : kind;
  return playNativeEffect(name, opts);
}
