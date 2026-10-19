// [2026-10-19 kb-native] Teclado nível WhatsApp/Telegram nas TROCAS DE TELA.
//
// Founder (iOS 729): conversa com o teclado FECHADO e a barra de digitar presa
// no meio da tela (vão do tamanho do teclado embaixo, papel de parede à
// mostra). O paddingBottom da conversa vem do react-native-keyboard-controller
// (ThreadKeyboardAvoider); quando um evento do teclado se perde (fundo/volta,
// troca de tela, folha por cima) o valor velho ficava valendo para sempre.
//
// Agora o compositor NATIVO (apiVersion >= 4) mede o teclado de verdade
// (iOS: keyboardLayoutGuide da janela; Android: WindowInsets IME) e emite
// onKeyboardSync ao voltar do fundo, ao reaparecer a tela, ao entrar na janela
// e a cada did show/hide. Este módulo é só o "hub" entre o composer
// (components/chat/NativeComposerBridge.js) e o ThreadKeyboardAvoider
// (utils/threadKeyboard.native.js), que corrige o padding pelo valor REAL.
//
// Kill switch OTA: globalThis.__chatyy_kb_native_transitions = false
//   → sem sync, resign SEM animação no nativo (comportamento de 18/10) e o JS
//     volta a fazer blur/re-foco nas transições da conversa.

const _subs = new Set();

export function kbNativeTransitionsOn() {
  try { if (globalThis.__chatyy_kb_native_transitions === false) return false; } catch {}
  return true;
}

/** Composer nativo → altura REAL do teclado ({ height, visible, focused, reason }). */
export function reportKeyboardSync(e) {
  if (!kbNativeTransitionsOn() || !e) return;
  _subs.forEach((fn) => { try { fn(e); } catch {} });
}

export function subscribeKeyboardSync(fn) {
  _subs.add(fn);
  return () => { _subs.delete(fn); };
}

/** apiVersion do composer nativo (0 = sem módulo). */
export function nativeComposerApi() {
  try {
    // eslint-disable-next-line global-require
    const m = require('../modules/expo-chat-composer');
    const f = m && (m.apiVersion || (m.default && m.default.apiVersion));
    return typeof f === 'function' ? (Number(f()) || 0) : 0;
  } catch {
    return 0;
  }
}
