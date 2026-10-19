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

// [2026-10-19 attach-instant] "+" nível WhatsApp/Telegram (iOS, composer
// nativo apiVersion >= 5 + folha nativa): a folha abre NA HORA (sem esperar o
// keyboardDidHide) e, ao cancelar, o composer devolve o teclado no NATIVO
// (sem focus/blur do JS). Kill switch OTA: globalThis.__chatyy_attach_instant
// = false → volta ao comportamento de 18/10 (espera o didHide + focus JS).
// Ajuste: globalThis.__chatyy_attach_restore = 'did' → teclado só volta no fim
// do dismiss da folha (padrão 'will' = sobe enquanto a folha desce).
export function attachInstantOn() {
  try { if (globalThis.__chatyy_attach_instant === false) return false; } catch {}
  return true;
}

// [2026-10-19 kb-restore] Padrão agora 'did': no modo 'will' o foco devolvido
// com a folha ainda apresentada era derrubado pelo dismiss do UIKit e a rede do
// DidClose focava de novo = teclado sobe-desce-sobe ("rapidão"). Voltar ao
// antigo: globalThis.__chatyy_attach_restore = 'will'.
export function attachRestoreMode() {
  try { if (globalThis.__chatyy_attach_restore === 'will') return 'will'; } catch {}
  return 'did';
}

// [2026-10-19 kb-restore] Composer nativo (iOS apiVersion >= 6) recusa a
// devolução automática do first responder pelo UIKit (volta de tela, modal,
// menu, folha) — o teclado só volta por toque/foco explícito.
// Kill switch OTA: globalThis.__chatyy_kb_restore_guard = false.
export function kbRestoreGuardOn() {
  try { if (globalThis.__chatyy_kb_restore_guard === false) return false; } catch {}
  return true;
}

// [2026-10-19 kb-restore] Troca de tela com teclado de um TextInput JS aberto
// (busca da lista, nova conversa, busca dentro de Info…): o teclado ficava em
// cima durante o push/pop e só descia quando a tela nova montava
// (Keyboard.dismiss do mount da conversa) ou a velha desmontava = "teclado
// abre e minimiza". Agora desce no INÍCIO do voltar (beforeRemove da rota que
// sai), junto com a animação. Não alcança o composer nativo (ele cuida de si).
// Kill switch OTA: globalThis.__chatyy_nav_kb_dismiss = false.
export function navKbDismissOn() {
  try { if (globalThis.__chatyy_nav_kb_dismiss === false) return false; } catch {}
  return true;
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
