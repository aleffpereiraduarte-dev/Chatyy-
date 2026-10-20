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
// [2026-10-19 attach-none] Founder: fechar a folha do "+" deixa o teclado
// FECHADO. Composer api >= 7 entende 'none'; api 5/6 (734/737) trataria 'none'
// como 'will' → lá fica 'did' (sobe 1x no fim). Override: __chatyy_attach_restore.
// [2026-10-19 attach-hold] api 5/6 (734/737) também ficam 'none': lá não há
// prop p/ isso, então o JS manda attachInstant=false (o nativo deixa de devolver
// o foco ao fechar a folha) e abre a folha na hora ele mesmo (ver
// attachLegacyNoneActive). Antes: 'did' = foco devolvido no fim do dismiss →
// willShow + blur do ouvinte do menu = barra "levanta e abaixa" sem teclado.
// Voltar ao 'did' nesses binários: globalThis.__chatyy_attach_legacy_none = false.
export function attachRestoreMode() {
  try {
    const v = globalThis.__chatyy_attach_restore;
    if (v === 'will' || v === 'did') return v;
  } catch {}
  if (nativeComposerApi() >= 7) return 'none';
  try { if (globalThis.__chatyy_attach_legacy_none === false) return 'did'; } catch {}
  return 'none';
}

/** iOS composer api 5/6 com modo 'none': attachInstant=false no nativo + abertura instantânea pelo JS. */
export function attachLegacyNoneActive() {
  const api = nativeComposerApi();
  return api >= 5 && api < 7 && attachInstantOn() && attachRestoreMode() === 'none';
}

// [2026-10-19 attach-hold] composer iOS api >= 8: com o teclado aberto o "+"
// NÃO solta o teclado sozinho; o JS arma o hold da conversa e chama
// releaseForAttach() (rede nativa 350 ms). Kill: __chatyy_attach_hold = false.
export function attachHoldOn() {
  // [2026-10-20 kb-glued] opt-in: o teclado desce na hora e o composer desce grudado.
  try { if (globalThis.__chatyy_attach_hold === true) return true; } catch {}
  return false;
}

/** apiVersion da folha nativa expo-chat-attach (0 = sem módulo). */
export function nativeAttachApi() {
  try {
    // eslint-disable-next-line global-require
    const m = require('../modules/expo-chat-attach');
    return typeof m.apiVersion === 'function' ? (Number(m.apiVersion()) || 0) : 0;
  } catch {
    return 0;
  }
}

// [2026-10-19 attach-over-kb] iOS composer api >= 9 + folha api >= 6: o "+"
// com o teclado aberto NÃO solta o teclado; a folha nativa sobe numa janela
// ACIMA do teclado (que fica aberto por baixo) e ele só desce quando a folha
// fecha — sem quadro de buraco/wallpaper, conversa parada, sem hold/clamp JS.
// Kill switch OTA: globalThis.__chatyy_attach_over_kb = false (= api 8 hold).
// [2026-10-20 attach-panel-fotos] Build 744 no aparelho: a janela da folha
// ficou ABAIXO do painel/teclado (folha só até o meio, painel translúcido por
// cima). Agora DESLIGADO por padrão (opt-in globalThis.__chatyy_attach_over_kb
// = true): "Fotos" do painel faz o painel descer junto com a folha subindo
// (WhatsApp) e cancelar devolve o painel (composer api 10, build novo).
export function attachOverKeyboardOn() {
  try { if (globalThis.__chatyy_attach_over_kb !== true) return false; } catch { return false; }
  if (!attachInstantOn()) return false;
  return nativeComposerApi() >= 9 && nativeAttachApi() >= 6;
}

// [2026-10-20 attach-inputview] iOS composer api >= 10 (WhatsApp): o "+" troca
// o teclado pelo PAINEL de anexos no mesmo lugar (inputView, mesma altura,
// composer parado e focado; "+" vira ícone de teclado). Fotos abre a folha
// "Recentes" acima do painel. Kill switch OTA:
// globalThis.__chatyy_attach_inputview = false → "+" abre a folha (over-kb).
// [2026-10-20 attach-tg] Founder: "igual ao Telegram" — "+" com teclado aberto
// = teclado DESCE (composer grudado) e a folha de anexos sobe por cima; fechar
// não reabre nada. O painel no lugar do teclado virou opt-in:
// globalThis.__chatyy_attach_inputview = true.
export function attachInputPanelOn() {
  try { if (globalThis.__chatyy_attach_inputview !== true) return false; } catch { return false; }
  if (!attachInstantOn()) return false;
  return nativeComposerApi() >= 10;
}

// [2026-10-20 attach-inwindow] iOS composer api >= 12 + folha api >= 8: Fotos e
// Câmera do painel entram DENTRO da janela do painel (sem present/resign →
// nenhum evento de teclado, conversa parada). Kill switch OTA:
// globalThis.__chatyy_attach_inwindow = false → folha modal congelada (api 11).
export function attachInWindowOn() {
  try { if (globalThis.__chatyy_attach_inwindow === false) return false; } catch {}
  return nativeComposerApi() >= 12 && nativeAttachApi() >= 8;
}

// [2026-10-20 attach-inputview] Android composer api >= 7: o "+" não derruba o
// IME; o painel de anexos (components/chat/AttachInputPanel) entra no lugar do
// teclado e o IME só desce quando ele montou. Kill switch OTA (o mesmo do iOS):
// globalThis.__chatyy_attach_inputview = false → folha do "+" como antes.
export function androidAttachPanelOn() {
  // [2026-10-20 attach-tg] modelo Telegram também no Android: painel opt-in.
  try { if (globalThis.__chatyy_attach_inputview !== true) return false; } catch { return false; }
  if (!androidAttachInstantOn()) return false;
  return nativeComposerApi() >= 7;
}

// [2026-10-19 android-parity] "+" no Android nível WhatsApp Android: a folha
// nativa (Dialog, SOFT_INPUT_STATE_HIDDEN) abre NO MESMO TOQUE — o composer
// nativo já escondeu o IME — sem os 80 ms + render de antes. Vale em qualquer
// binário com a folha nativa (o composer api >= 5 só manda hadKeyboard REAL).
// Kill switch OTA: globalThis.__chatyy_android_attach_instant = false (ou o
// geral __chatyy_attach_instant = false) → caminho de 18/10.
export function androidAttachInstantOn() {
  try { if (globalThis.__chatyy_android_attach_instant === false) return false; } catch {}
  return attachInstantOn();
}

// [2026-10-19 android-parity] Mesmo combinado do iOS api 7 (founder): fechar a
// folha do "+" deixa o teclado FECHADO. Override OTA:
// globalThis.__chatyy_attach_restore = 'did' | 'will' → o JS devolve o teclado
// ao cancelar se ele estava aberto (comportamento de 18/10).
export function androidAttachRestoreMode() {
  try {
    const v = globalThis.__chatyy_attach_restore;
    if (v === 'will' || v === 'did') return 'did';
  } catch {}
  return 'none';
}

// [2026-10-19 kb-restore] Composer nativo (iOS apiVersion >= 6) recusa a
// devolução automática do first responder pelo UIKit (volta de tela, modal,
// menu, folha) — o teclado só volta por toque/foco explícito.
// [2026-10-19 android-parity] Android api >= 6: a volta do foco da janela
// (folha/diálogo/outra Activity/OEM) não reabre um IME que estava fechado.
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
