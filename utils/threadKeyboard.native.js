// threadKeyboard (iOS / Android) — WhatsApp-style keyboard handling for the
// chat thread (app/chat-conversation.js).
//
// [2026-10-06 keyboard-controller] Replaces the old `keyboardHeight` React
// state + keyboardWillShow/DidShow listeners, which re-rendered the whole
// 33k-line thread screen on every keyboard open/close and made the composer
// "snap" (padding 0 ↔ inset) instead of following the keyboard.
//
// With react-native-keyboard-controller (KC) the keyboard position arrives as
// a Reanimated shared value on the UI thread, so:
//   • the thread container's paddingBottom follows the keyboard frame-by-frame
//     (open, close AND iOS interactive swipe-down) with ZERO React renders;
//   • the composer keeps a constant bottom inset — no layout jump;
//   • Android gets an interactive swipe-to-dismiss via KeyboardGestureArea
//     (interpolator "ios": the keyboard follows the finger once it touches it).
//
// OTA SAFETY: KC/Reanimated/Worklets are NATIVE modules that only exist in
// binaries built from this commit on (runtimeVersion bumped to 2.6.0 in
// app.json so old binaries never receive this JS). As a second belt we probe
// the TurboModules before touching the JS packages; if any is missing we fall
// back to RN's KeyboardAvoidingView with the same geometry (no crash).
import React, { useEffect } from 'react';
import { AppState, Keyboard, KeyboardAvoidingView, Platform, TurboModuleRegistry, View } from 'react-native';
import { isAppResuming, kbResumeGuardOn as isAppResumingGuardOn } from './kbResumeGuard';
import { kbNativeTransitionsOn, subscribeKeyboardSync } from './kbNativeTransitions'; // [2026-10-19 kb-native]

// [2026-10-19 kb-native] Navegação opcional (signup/parental também usam o
// avoider; fora de um navigator o hook lança → sem ouvintes de foco).
function _useOptionalNavigation() {
  try {
    // eslint-disable-next-line global-require
    return require('@react-navigation/native').useNavigation();
  } catch {
    return null;
  }
}

let KC = null;
let Rea = null;

function probeKeyboardController() {
  try {
    if (!TurboModuleRegistry.get('KeyboardController')) return false;
    if (!TurboModuleRegistry.get('WorkletsModule')) return false;
    // [2026-10-07 wb586] NUNCA instanciar 'ReanimatedModule' aqui. No Android o
    // construtor (NativeProxy.initHybrid) lê o WorkletsModuleProxy, que só existe
    // depois que o JS do react-native-worklets chama installTurboModule() — ou
    // seja, depois do require abaixo. Pedido antes disso → NullPointerException
    // engolida por este try/catch, MAS o TurboModuleManager deixa o ModuleHolder
    // preso em "creating" (endCreatingModule nunca roda) e o próximo acesso ao
    // ReanimatedModule (o próprio require do reanimated) espera PRA SEMPRE na
    // thread JS → tela branca no boot (build 586, runtime 2.6.0). O require do
    // reanimated já cria o módulo na ordem certa (worklets → reanimated) e lança
    // se o nativo faltar, o que cai no catch.
    // eslint-disable-next-line global-require
    Rea = require('react-native-reanimated');
    // eslint-disable-next-line global-require
    KC = require('react-native-keyboard-controller');
    return !!(
      KC && KC.KeyboardProvider && KC.useReanimatedKeyboardAnimation && KC.useKeyboardController
      && Rea && Rea.default && Rea.useAnimatedStyle
    );
  } catch (e) {
    if (__DEV__) console.warn('[threadKeyboard] keyboard-controller unavailable, using RN KeyboardAvoidingView:', e?.message || e);
    KC = null;
    Rea = null;
    return false;
  }
}

export const KEYBOARD_CONTROLLER_ACTIVE = probeKeyboardController();

// Composer TextInput nativeID (KeyboardGestureArea uses it to scope the gesture).
export const THREAD_COMPOSER_NATIVE_ID = 'chatyy-thread-composer';

// Android only honours 'on-drag' / 'none' on ScrollView; 'interactive' is an
// iOS mode. With KC on Android 11+ (API 30, WindowInsetsAnimationController)
// the KeyboardGestureArea drives the interactive dismiss, so the list must NOT
// also dismiss on the first drag pixel.
export const THREAD_LIST_KEYBOARD_DISMISS_MODE =
  Platform.OS === 'ios'
    ? 'interactive'
    : (KEYBOARD_CONTROLLER_ACTIVE && Platform.Version >= 30 ? 'interactive' : 'on-drag');

// Root provider. Mounted DISABLED: KC on Android takes over IME insets
// (edge-to-edge + adjustNothing on modals), so it is switched on only while a
// chat thread is mounted (ThreadKeyboardAvoider below, ref-counted). Every
// other screen keeps its current RN KeyboardAvoidingView behaviour.
export function ChatyyKeyboardProvider({ children }) {
  if (!KEYBOARD_CONTROLLER_ACTIVE) return children;
  return <KC.KeyboardProvider enabled={false}>{children}</KC.KeyboardProvider>;
}

// [2026-10-13 android-kbd-flicker] Handler de teclado (worklets no UI thread)
// só no Android; iOS recebe um no-op estável (árvore/efeitos do iOS intactos).
// useGeneric… = sem o useResizeMode extra (useReanimatedKeyboardAnimation já faz).
const _IS_ANDROID = Platform.OS === 'android';
function _noopKbHandler() {}
const _useKbHandlerAndroid = (_IS_ANDROID && KC && typeof KC.useGenericKeyboardHandler === 'function')
  ? KC.useGenericKeyboardHandler
  : _noopKbHandler;

// [2026-10-19 kb-translate] iOS: teclado "arrastando" ao fechar (founder).
// RAIZ: o avoider mexia no paddingBottom do container (prop de LAYOUT) a cada
// quadro. No Fabric isso é um commit do Reanimated + Yoga da tela inteira +
// mount por quadro, e a lista nativa muda de altura a cada quadro
// (CMLListView.layoutSubviews re-crava o contentOffset → briga com o dedo no
// dismiss interativo). E o commit do Reanimated é ADIADO enquanto o React
// commita (blur → setInputFocused re-renderiza a conversa no início do
// fechamento) = barra e lista param e depois pulam.
// AGORA (modo "translate", iOS, lista nativa, sem painel de emoji/figurinha/GIF
// aberto): o layout NÃO muda durante o movimento. Barra de digitar (ThreadKeyboardBar)
// e lista (ThreadKeyboardGestureArea = recorte + miolo) andam só por
// transform translateY = -lift, no UI thread (worklet do keyboard-controller,
// onMove/onInteractive), igual iMessage/Telegram: a lista sobe/desce em bloco
// e o topo dela some sob o cabeçalho (recorte). Em repouso, o espaço escondido
// no topo vira inset do lado das antigas na lista nativa (useThreadKbRestLift),
// publicado pelo JS SÓ depois do movimento (didShow/didHide).
// Com painel aberto (emoji nativo/figurinhas/GIF) volta o modo padding de
// sempre; a troca é atômica (mesmo quadro do Reanimated: padding↔transform).
// [2026-10-19 hotfix] DESLIGADO por padrão: founder viu barra+lista presas no
// alto com o teclado FECHADO (lift não voltou a 0). Opt-in (lido ao montar a
// conversa): globalThis.__chatyy_kb_translate = true. A auto-cura [kb-heal]
// (didHide/blur/active/foco/watchdog → lift 0 sem teclado) vale nos DOIS modos.
// [2026-10-20 native-dock] Composer GRUDADO no teclado pelo próprio UIKit
// (composer iOS api 13, prop nativeDock): o nativo ancora uma sonda no
// window.keyboardLayoutGuide e aplica translateY = −(teclado − inset) nas
// views testID "chatyy-dock-bar" (barra/composer) e "chatyy-dock-list" (lista)
// DENTRO do bloco de animação do teclado (mesma curva/duração; arraste
// interativo quadro a quadro). O JS NÃO mexe em padding/transform nessa tela
// (paddingBottom 0; wrappers sem estilo animado); só publica o inset de
// repouso da lista. Kill switch OTA: globalThis.__chatyy_composer_native_dock = false.
export function composerNativeDockOn() {
  if (Platform.OS !== 'ios') return false;
  // [2026-10-20 dock-off] build 746: conversa abriu VAZIA (sem lista e sem composer) → opt-in até corrigir.
  try { if (globalThis.__chatyy_composer_native_dock !== true) return false; } catch { return false; }
  try {
    // eslint-disable-next-line global-require
    const m = require('./kbNativeTransitions');
    return m.nativeComposerApi() >= 13;
  } catch { return false; }
}
function _kbTranslateOn() {
  try { if (globalThis.__chatyy_kb_translate === true) return true; } catch {}
  return false;
}
// [2026-10-19 kb-heal] KC diz teclado aberto? Exige isVisible() E
// state().height > 0 (state = último did-event do KC; 0 = fechado).
function _kcStateOpen() {
  const K = KC && KC.KeyboardController;
  if (!K) return false;
  let vis = false;
  try { vis = !!(K.isVisible && K.isVisible()); } catch {}
  if (!vis) return false;
  let h = 0;
  try { h = Number(K.state && K.state() && K.state().height) || 0; } catch {}
  return h > 1;
}
const ThreadKbCtx = React.createContext(null);
let _restLift = 0;
const _restSubs = new Set();
function _setRestLift(v) {
  const n = Math.max(0, Math.round(Number(v) || 0));
  if (n === _restLift) return;
  _restLift = n;
  _restSubs.forEach((fn) => { try { fn(n); } catch {} });
}
/** [kb-translate] px do topo da lista escondidos sob o recorte com o teclado
 *  aberto (0 fora do modo translate). Só muda em repouso. */
export function useThreadKbRestLift() {
  const [v, setV] = React.useState(_restLift);
  useEffect(() => {
    const fn = (n) => setV(n);
    _restSubs.add(fn);
    setV(_restLift);
    return () => { _restSubs.delete(fn); };
  }, []);
  return v;
}
// [2026-10-19 kb-heal] Avoiders montados → função de auto-cura (ver
// KCThreadKeyboardAvoider). O composer (NativeComposerBridge) avisa no blur.
const _healFns = new Set();
/** Composer perdeu o foco: cada conversa montada confere (depois da descida do
 *  teclado) se ainda há "lift" sem teclado nenhum e o leva a 0. */
export function threadKbNoteComposerBlur() {
  _composerFocused = false; // [2026-10-19 attach-hold]
  _healFns.forEach((fn) => { try { fn('blur'); } catch {} });
}

// [2026-10-19 attach-hold] "+" com o teclado aberto (founder, vídeo iPhone):
//  ABRIR — o teclado sumia e a lista + barra DESPENCAVAM até o fim da tela
//  (barra no meio/baixo sem nada embaixo) e só depois a folha nativa subia.
//  FECHAR — ~0,5 s depois de a folha sumir a barra SUBIA a altura do teclado
//  (vão branco embaixo, sem teclado) e caía de novo ("levanta e abaixa").
//  RAIZ (fechar): o lift é um DEGRAU no iOS (KC só escreve `height` no
//  willShow/willHide/interativo) e qualquer escrita de −altura do teclado sem
//  teclado de verdade (devolução de foco 'did' do composer api 5/6 seguida do
//  blur do ouvinte do menu = willShow sem teclado visível; didShow/sync
//  atrasados) vale até o hideTimer do didHide (120 + 450 ms) assentar = os
//  ~530 ms do vídeo.
//  AGORA (WhatsApp): ao tocar no "+", a conversa fica PARADA na altura do
//  teclado (hold) enquanto o teclado desce e a folha sobe por cima; com a
//  folha cobrindo a barra, o lift vai a 0 por baixo dela. Da abertura até
//  ~0,7 s depois de a folha fechar o lift fica TRAVADO em 0 (clamp): nada
//  levanta a barra sem teclado; foco no composer (toque/foco explícito) solta
//  na hora. Ao soltar: sem teclado ⇒ assenta (zera o valor velho do KC).
//  Composer nativo api >= 8: o resign do "+" espera o JS armar o hold
//  (releaseForAttach) → zero quadro de queda. Binários antigos: o hold entra
//  1-2 quadros depois do willHide (queda mínima, volta na hora).
// Kill switches OTA: globalThis.__chatyy_attach_hold = false (sem hold, sem
// adiar o resign) · globalThis.__chatyy_attach_clamp = false (sem trava).
const _attachFns = new Set();
let _composerFocused = false;
// [2026-10-20 kb-glued] Founder: "no WhatsApp a barrinha fica grudada no
// teclado — sobe e desce junto, nunca fica parada no alto esperando". Hold,
// clamp e freeze faziam exatamente o oposto → agora DESLIGADOS (opt-in === true).
// O composer segue o teclado/inputView quadro a quadro pelo KC (o valor muda
// dentro do bloco de animação do teclado do UIKit = mesma curva/duração).
function _attachHoldOn() {
  try { if (globalThis.__chatyy_attach_hold === true) return Platform.OS === 'ios'; } catch {}
  return false;
}
function _attachClampOn() {
  try { if (globalThis.__chatyy_attach_clamp === true) return Platform.OS === 'ios'; } catch {}
  return false;
}
/** "+" do composer (folha nativa abrindo agora). hadKeyboard = teclado do composer estava aberto. */
export function threadKbAttachBegin(hadKeyboard) {
  _attachFns.forEach((o) => { try { o.begin(!!hadKeyboard); } catch {} });
}
/** Folha do "+" fechou (qualquer motivo) ou não abriu (immediate = solta já). */
export function threadKbAttachEnd(immediate) {
  _attachFns.forEach((o) => { try { o.end(!!immediate); } catch {} });
}
// [2026-10-20 attach-freeze] "Fotos" do painel / "+" com teclado (founder,
// vídeo 744): a apresentação MODAL da folha tira o painel/teclado num quadro
// (stash do UIKit) → composer caía, lista re-layoutava e rolava, 1 quadro sem
// folha. AGORA a conversa CONGELA na altura do painel/teclado (hold sem prazo)
// e um "painel falso" (cor do teclado) ocupa o vão por baixo da folha até ela
// fechar. Fechar: painel devolvido pelo nativo (composer api 11) = solta já,
// sem pulo; senão desce animado junto com a folha saindo.
// Kill switch OTA: globalThis.__chatyy_attach_freeze = false.
export function threadKbAttachFreezeOn() {
  // [2026-10-20 kb-glued] opt-in (=== true): composer grudado no teclado é o padrão.
  try { if (globalThis.__chatyy_attach_freeze === true) return Platform.OS === 'ios'; } catch {}
  return false;
}
/** Congela a conversa na altura atual do teclado/painel (color = painel falso). */
export function threadKbAttachFreeze(color) {
  let any = false;
  _attachFns.forEach((o) => { try { if (o.freeze(color)) any = true; } catch {} });
  return any;
}
/** Solta o congelamento. waitKbMs > 0 = espera o painel/teclado voltar (até X ms) antes de decidir. */
export function threadKbAttachThaw(waitKbMs) {
  _attachFns.forEach((o) => { try { o.thaw(Number(waitKbMs) || 0); } catch {} });
}
// [2026-10-20 attach-tgwin] Telegram (ChatController withUpdatedInputHeight(nil)):
// com a folha de anexos na tela o chat IGNORA o teclado (legenda/busca dentro
// da folha não mexem em lista nem composer). Ligado pelo onArmedShown (a folha
// só entra depois de o teclado descer ⇒ lift já é 0).
const _ignoreFns = new Set();
export function threadKbIgnoreKeyboard(on) {
  _ignoreFns.forEach((fn) => { try { fn(!!on); } catch {} });
}
/** Composer ganhou foco (toque/foco explícito) → trava solta na hora. */
export function threadKbNoteComposerFocus() {
  _composerFocused = true;
  _attachFns.forEach((o) => { try { o.focus(); } catch {} });
}
const _clipStyle = { flex: 1, overflow: 'hidden' };
const _fakePanelBase = { position: 'absolute', left: 0, right: 0, bottom: 0 }; // [2026-10-20 attach-freeze]
const _flex1 = { flex: 1 };

// Ref-count of mounted threads (chat → chat pushes) so unmounting one thread
// doesn't disable KC under another that is still on the stack.
let _enabledRefs = 0;

// [2026-10-08 chat-fix-composer-location] Composer "flutuando" no meio da tela
// com um vão branco do tamanho do teclado embaixo (teclado FECHADO).
// RAIZ: o KeyboardProvider fica disabled fora da conversa e, no iOS, disabled =
// observers nativos REMOVIDOS (KeyboardControllerView.unmount). O height
// shared value do KC só muda em onKeyboardMoveStart/Interactive — nunca é
// zerado ao desabilitar. Se o teclado fecha enquanto o KC está desligado
// (sair da conversa com o teclado aberto: o cleanup setEnabled(false) chega
// antes do keyboardWillHide do pop), o valor fica preso em -alturaDoTeclado.
// Na próxima conversa o KC religa com esse valor velho → paddingBottom ≈ 336pt
// sem teclado nenhum, e como o mount faz Keyboard.dismiss() sem teclado aberto
// nenhum evento novo chega pra corrigir. Mesmo efeito se um hide for perdido
// com um Modal (sheet de localização/anexo) por cima.
// FIX (auto-cura, sem depender do KC): o RN Keyboard (RCTKeyboardObserver,
// sempre inscrito) é a fonte de verdade de "teclado fechado":
//   • ao desligar o KC (última conversa saiu) → zera height/progress do KC;
//   • ao montar a conversa / voltar do background / keyboardDidHide, se o
//     teclado NÃO está visível → `settled`=1 força paddingBottom 0;
//   • qualquer movimento real do teclado (height muda no UI thread) limpa o
//     `settled` na hora (useAnimatedReaction), então abrir o teclado continua
//     colado frame-a-frame, sem esperar a thread JS.
function KCThreadKeyboardAvoider({ style, bottomInset, translateMode, dockable, children }) {
  const { setEnabled } = KC.useKeyboardController();
  // height: 0 → -keyboardHeight (measured from the screen bottom, so it
  // includes the home indicator / Android nav bar). The composer keeps a
  // constant `bottomInset` padding, so the container only needs to rise by
  // keyboardHeight - bottomInset for the composer to sit flush on the keyboard.
  const { height, progress } = KC.useReanimatedKeyboardAnimation();
  const settled = Rea.useSharedValue(0);
  // [2026-10-19 attach-hold] hold = lift fixo (px) durante a abertura da folha
  // do "+"; clamp = 1 → lift 0 (nada levanta a barra sem teclado).
  const hold = Rea.useSharedValue(0);
  const clamp = Rea.useSharedValue(0);
  // [2026-10-20 attach-freeze] painel falso no vão (altura = hold) enquanto congelado.
  const fake = Rea.useSharedValue(0);
  const ignoreKb = Rea.useSharedValue(0); // [2026-10-20 attach-tgwin]
  React.useEffect(() => {
    const fn = (on) => { try { ignoreKb.value = on ? 1 : 0; } catch {} };
    _ignoreFns.add(fn);
    return () => { _ignoreFns.delete(fn); };
  }, [ignoreKb]);
  const fakeColor = Rea.useSharedValue('#d6d7dc');
  // [2026-10-13 android-kbd-flicker] bottomInset atual p/ o restore do Android
  // (o effect abaixo só depende de setEnabled).
  const insetRef = React.useRef(bottomInset || 0);
  insetRef.current = bottomInset || 0;
  const nav = _useOptionalNavigation(); // [2026-10-19 kb-native]
  // [2026-10-19 kb-translate] base (wrappers montados) decidida 1x na montagem;
  // tmode (padding ↔ transform) segue a prop ao vivo, no UI thread.
  // [2026-10-20 native-dock] decidido 1x na montagem (lista nativa + api 13).
  const [dock] = React.useState(() => !!dockable && composerNativeDockOn());
  const [kbBase] = React.useState(() => Platform.OS === 'ios' && (dock || _kbTranslateOn()));
  const tOn = !!(dock || (kbBase && translateMode));
  const tmode = Rea.useSharedValue(tOn ? 1 : 0);
  const tOnRef = React.useRef(tOn);
  tOnRef.current = tOn;
  // Publica o "repouso" (fora do movimento): altura do teclado − inset.
  const pubRest = React.useRef(null);
  pubRest.current = (kh) => {
    if (!tOnRef.current) { _setRestLift(0); return; }
    const k = Number(kh) || 0;
    _setRestLift(k > 1 ? Math.max(0, k - (insetRef.current || 0)) : 0);
  };

  // [2026-10-13 android-kbd-flicker] ANDROID: o KC só sai do `settled` quando
  // uma ABERTURA começa (onStart com altura > 0) ou num arraste interativo — no
  // UI thread, já no 1º frame. Antes, no Android, QUALQUER movimento limpava
  // (useAnimatedReaction abaixo, que fica só p/ iOS): abrir a conversa com o
  // teclado da tela anterior ainda descendo (busca da lista / nova conversa) =
  // composer pulava ~altura do teclado e descia durante o push = "pisca".
  _useKbHandlerAndroid({
    onStart: (e) => {
      'worklet';
      if (e && e.height > 0) settled.value = 0;
    },
    onInteractive: () => {
      'worklet';
      settled.value = 0;
    },
  }, []);

  useEffect(() => {
    _enabledRefs += 1;
    setEnabled(true);
    const settle = () => {
      settled.value = 1;
      try { pubRest.current(0); } catch {} // [kb-translate]
      // Also clear KC's stale value so the NEXT open is a real change (a
      // stuck -336 followed by an open to -336 wouldn't fire the reaction).
      try { if (height.value !== 0) { height.value = 0; progress.value = 0; } } catch {}
    };
    const settleIfHidden = () => {
      try { if (!Keyboard.isVisible()) settle(); } catch {}
    };
    // [2026-10-19 kb-native] "Fechado" pelas DUAS fontes JS (RN + KC) → assenta
    // se ainda há padding de teclado (valor velho do KC / restore perdido).
    let lastShowAt = 0; // willShow/didShow recente = abertura em curso (não é valor velho)
    const settleIfHiddenStrict = () => {
      if (Date.now() - lastShowAt < 700) return;
      let rn = false;
      let kc = false;
      try { rn = !!Keyboard.isVisible(); } catch {}
      // [2026-10-19 kb-heal] KC.isVisible() vem só dos did-events SINTETIZADOS
      // pelo observer do KC (fim de animação); pode ficar "aberto" depois de um
      // fechamento sem animação achada → exige também state().height > 0.
      try { kc = _kcStateOpen(); } catch {}
      if (rn || kc) return;
      let cur = 0;
      try { cur = Math.abs(height.value); } catch {}
      if (cur > 1 || settled.value !== 1) settle();
    };
    // [2026-10-19 kb-heal] AUTO-CURA do lift (barra/lista presas no alto com o
    // teclado FECHADO — print do founder 19/10). No iOS o `height` do KC é um
    // DEGRAU: só muda em onKeyboardMoveStart (willShow → −kh, willHide → 0) e no
    // interativo (src/animated.tsx: updateSharedValues ['ios'] só nesses dois).
    // Se o willHide se perde (folha/modal por cima, observer do KC sem
    // animação, sync nativa descartada em transição) ou alguém escreve −kh
    // DEPOIS do último settle (restoreIfLost atrasado, sync nativa "focused",
    // KVO do interativo), o lift fica = altura cheia do teclado sem teclado e
    // nada mais o corrige. Agora: invariante "sem teclado ⇒ lift 0" checado em
    // didHide, blur do composer, AppState active, foco da tela e num watchdog
    // leve (1,5 s; sai na hora se o RN vê teclado).
    let lastNativeSync = null; // { h, at } do composer nativo (quadro REAL)
    const liftNow = () => {
      try {
        if (settled.value === 1 || clamp.value === 1) return 0; // [attach-hold]
        return Math.max(0, -height.value - (insetRef.current || 0));
      } catch { return 0; }
    };
    const kbClosedNow = () => {
      if (Date.now() - lastShowAt < 700) return false;
      try { if (Keyboard.isVisible()) return false; } catch {}
      // Quadro real do composer nativo (keyboardLayoutGuide) recente = juiz.
      if (lastNativeSync && Date.now() - lastNativeSync.at < 4000) return lastNativeSync.h <= 1;
      // KC: state().height === 0 (último did-event = fechado) → fechado.
      try { if (!_kcStateOpen()) return true; } catch { return true; }
      return false;
    };
    let healTimer = null;
    let healAnimTimer = null;
    let rnClosedStrikes = 0;
    const heal = (reason) => {
      if (healAnimTimer) return;
      if (isAppResuming()) return;
      const cur = liftNow();
      if (cur <= 1) {
        // Sem lift visível, mas valor velho do KC guardado → limpa (próxima
        // abertura volta a ser mudança real).
        let hv = 0;
        try { hv = Math.abs(height.value); } catch {}
        if (hv > 1 && settled.value === 1) settle();
        return;
      }
      // Desce animado (sem pulo seco) e assenta no fim se continuar fechado.
      try {
        if (Rea.withTiming) {
          height.value = Rea.withTiming(0, { duration: 220 });
          progress.value = Rea.withTiming(0, { duration: 220 });
        }
      } catch {}
      try { pubRest.current(0); } catch {}
      healAnimTimer = setTimeout(() => {
        healAnimTimer = null;
        if (Date.now() - lastShowAt < 700) return; // abriu de novo no meio
        try { if (Keyboard.isVisible()) return; } catch {}
        settle();
      }, 240);
      if (__DEV__) console.log('[threadKeyboard] kb-heal', reason, Math.round(cur));
    };
    const healIfClosed = (reason) => {
      if (kbClosedNow()) heal(reason);
    };
    const healSoon = (reason, ms) => {
      if (healTimer) clearTimeout(healTimer);
      healTimer = setTimeout(() => { healTimer = null; healIfClosed(reason); }, ms);
    };
    const healFn = (reason) => healSoon(reason, 650);
    _healFns.add(healFn);
    const watchdog = setInterval(() => {
      try {
        if (AppState.currentState !== 'active' || isAppResuming()) { rnClosedStrikes = 0; return; }
        if (Keyboard.isVisible()) { rnClosedStrikes = 0; return; } // barato: teclado aberto = nada a fazer
        if (Date.now() - lastShowAt < 1200) return;
        if (liftNow() <= 1) { rnClosedStrikes = 0; return; }
        rnClosedStrikes += 1;
        // Fontes concordam → já; só o RN dizendo fechado → 3 checagens (~4,5 s)
        // (só iOS: lá o RCTKeyboardObserver é sempre inscrito e confiável).
        if (kbClosedNow() || (!_IS_ANDROID && rnClosedStrikes >= 3)) { rnClosedStrikes = 0; heal('watchdog'); }
      } catch {}
    }, 1500);
    // [2026-10-19 kb-native] Quadro REAL do teclado vindo do composer nativo
    // (apiVersion >= 4: keyboardLayoutGuide no iOS, IME insets no Android) →
    // o padding nunca fica preso num valor velho.
    const onNativeSync = (e) => {
      const h = Math.max(0, Number(e && e.height) || 0);
      lastNativeSync = { h, at: Date.now() }; // [2026-10-19 kb-heal]
      let cur = 0;
      try { cur = Math.abs(height.value); } catch {}
      if (h <= 1) {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        if (cur > 1 || settled.value !== 1) settle();
        try { pubRest.current(0); } catch {} // [kb-translate]
        return;
      }
      // Aberto: só corrige se o teclado é DO composer (teclado de outra tela
      // ainda descendo no push não pode levantar a conversa — android-kbd-flicker).
      if (!(e && e.focused)) return;
      // [2026-10-19 kb-heal] nunca levanta sem o RN ver teclado (guia velho).
      try { if (!Keyboard.isVisible()) return; } catch {}
      lastShowAt = Date.now();
      if (showTimer) { clearTimeout(showTimer); showTimer = null; }
      if (Math.abs(cur - h) > 2) {
        try { height.value = -h; progress.value = 1; } catch {}
      }
      settled.value = 0;
      try { pubRest.current(h); } catch {} // [kb-translate]
    };
    const unsubSync = subscribeKeyboardSync(onNativeSync);
    // [2026-10-19 attach-hold] ver threadKbAttachBegin (topo do arquivo).
    let lastOpenKh = 0; // última altura REAL do teclado aberto (didShow / sync nativa)
    let attachOn = false;
    let frozen = false; // [2026-10-20 attach-freeze]
    let thawTimer = null;
    let holdTimer = null;
    let clampTimer = null;
    const ATTACH_HOLD_MS = 400; // folha (mola 0,52 s) já cobre a barra
    const ATTACH_CLAMP_TAIL_MS = 700; // depois de a folha fechar
    const releaseClamp = () => {
      if (clampTimer) { clearTimeout(clampTimer); clampTimer = null; }
      let was = 0;
      try { was = clamp.value; } catch {}
      if (was !== 1) return;
      // Sem teclado do composer: assenta (zera −altura velha do KC) ANTES de
      // destravar — a trava sai sem levantar nada.
      let vis = false;
      try { vis = !!Keyboard.isVisible(); } catch {}
      if (!_composerFocused && !vis) settle();
      try { clamp.value = 0; } catch {}
    };
    const attachObj = {
      begin: (had) => {
        attachOn = true;
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        if (clampTimer) { clearTimeout(clampTimer); clampTimer = null; }
        if (_attachClampOn()) { try { clamp.value = 1; } catch {} }
        if (!had || !_attachHoldOn()) return;
        const ins = insetRef.current || 0;
        let kh = 0;
        try { kh = settled.value === 1 ? 0 : -height.value; } catch {}
        if (!(kh > ins + 1)) { try { kh = Number(Keyboard.metrics()?.height) || 0; } catch {} }
        if (!(kh > ins + 1)) kh = lastOpenKh;
        const h = Math.max(0, kh - ins);
        if (h <= 1) return;
        try { hold.value = h; } catch {}
        holdTimer = setTimeout(() => {
          holdTimer = null;
          // Folha por cima da barra: desce o lift POR BAIXO dela (suave, a
          // lista visível sob o escurecido não pula).
          try {
            if (Rea.withTiming) hold.value = Rea.withTiming(0, { duration: 240 });
            else hold.value = 0;
          } catch { try { hold.value = 0; } catch {} }
        }, ATTACH_HOLD_MS);
      },
      end: (immediate) => {
        if (frozen) return; // [2026-10-20 attach-freeze] quem solta é o thaw
        if (!attachOn) return;
        attachOn = false;
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        try { if (hold.value !== 0) hold.value = 0; } catch {}
        // composer já focado (modo 'did'/'will' por override devolveu o teclado) = segue o KC já.
        if (immediate || _composerFocused) { releaseClamp(); return; }
        if (clampTimer) clearTimeout(clampTimer);
        clampTimer = setTimeout(() => { clampTimer = null; releaseClamp(); }, ATTACH_CLAMP_TAIL_MS);
      },
      // [2026-10-20 attach-freeze] ver threadKbAttachFreeze (topo do arquivo).
      freeze: (color) => {
        const ins = insetRef.current || 0;
        let kh = 0;
        try { kh = settled.value === 1 ? 0 : -height.value; } catch {}
        if (!(kh > ins + 1)) { try { if (Keyboard.isVisible()) kh = Number(Keyboard.metrics()?.height) || 0; } catch {} }
        const h = Math.max(0, kh - ins);
        if (h <= 1) return false;
        attachOn = true;
        frozen = true;
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        if (clampTimer) { clearTimeout(clampTimer); clampTimer = null; }
        if (thawTimer) { clearTimeout(thawTimer); thawTimer = null; }
        try { if (color) fakeColor.value = String(color); } catch {}
        try { hold.value = h; fake.value = 1; } catch {}
        try { clamp.value = 1; } catch {}
        return true;
      },
      thaw: (waitMs) => {
        if (!frozen) return;
        const finishKeep = () => {
          frozen = false;
          attachOn = false;
          // Painel/teclado de volta (KC já com −altura): solta sem mexer.
          try { clamp.value = 0; hold.value = 0; fake.value = 0; } catch {}
          try { settled.value = 0; } catch {}
        };
        const finishDrop = () => {
          frozen = false;
          attachOn = false;
          try {
            if (Rea.withTiming) hold.value = Rea.withTiming(0, { duration: 260 });
            else hold.value = 0;
          } catch { try { hold.value = 0; } catch {} }
          if (thawTimer) clearTimeout(thawTimer);
          thawTimer = setTimeout(() => {
            thawTimer = null;
            try { fake.value = 0; } catch {}
            if (frozen) return;
            let vis = false;
            try { vis = !!Keyboard.isVisible(); } catch {}
            if (!vis) settle();
            try { clamp.value = 0; } catch {}
          }, 300);
        };
        let vis = false;
        try { vis = !!Keyboard.isVisible(); } catch {}
        if (vis) { finishKeep(); return; }
        if (!(waitMs > 0)) { finishDrop(); return; }
        let done = false;
        let sub = null;
        const go = (kb) => {
          if (done) return;
          done = true;
          try { sub && sub.remove(); } catch {}
          if (kb) finishKeep(); else finishDrop();
        };
        try { sub = Keyboard.addListener('keyboardDidShow', () => go(true)); } catch {}
        setTimeout(() => { let v = false; try { v = !!Keyboard.isVisible(); } catch {} go(v); }, waitMs);
      },
      focus: () => {
        // Foco no composer = teclado dele vindo de verdade → segue o KC já.
        if (attachOn) return; // folha ainda aberta (foco não chega por baixo dela)
        if (clampTimer) { clearTimeout(clampTimer); clampTimer = null; }
        try { clamp.value = 0; } catch {}
      },
    };
    _attachFns.add(attachObj);
    const unsubKh = subscribeKeyboardSync((e) => {
      const h = Number(e && e.height) || 0;
      if (h > 1 && e && e.focused) lastOpenKh = h;
    });
    // [2026-10-19 kb-native] Tela voltou a ser a de cima / fim de transição:
    // confere (binários sem onKeyboardSync dependem só disto).
    let navTimer = null;
    const checkAfterNav = () => {
      if (navTimer) clearTimeout(navTimer);
      navTimer = setTimeout(() => {
        navTimer = null;
        if (isAppResuming()) return;
        if (kbNativeTransitionsOn()) settleIfHiddenStrict();
        healIfClosed('focus'); // [2026-10-19 kb-heal]
      }, 450);
    };
    const navSubs = [];
    try {
      if (nav && typeof nav.addListener === 'function') {
        navSubs.push(nav.addListener('focus', checkAfterNav));
        navSubs.push(nav.addListener('transitionEnd', checkAfterNav));
      }
    } catch {}
    // [2026-10-13 android-kbd-flicker] Android: assenta SEMPRE na montagem (a
    // conversa faz Keyboard.dismiss() ao montar; o teclado da tela anterior que
    // ainda está fechando não pode levantar o composer). Se depois do push o
    // teclado continuar aberto de verdade, volta a seguir o KC.
    let mountTimer = null;
    if (Platform.OS === 'android') {
      settle();
      mountTimer = setTimeout(() => {
        mountTimer = null;
        try { if (Keyboard.isVisible() && Math.abs(height.value) > 1) settled.value = 0; } catch {}
      }, 700);
    } else {
      settleIfHidden();
    }
    // [2026-10-12 composer-under-keyboard] Founder (iPhone): "às vezes" só o
    // teclado aparece, a barra de digitar fica ATRÁS dele. RAIZ: `settle()`
    // escrevia height.value = 0 a partir da thread JS no keyboardDidHide. Com a
    // JS ocupada (lista de imagens grandes pintando, abrir o teclado logo após
    // a conversa renderizar, fechar+abrir rápido), o didHide de um fechamento
    // ANTERIOR era processado DEPOIS de o KC (thread de UI) já ter levado o
    // height a -alturaDoTeclado da nova abertura → zerava o valor do teclado
    // ABERTO; o willShow seguinte só limpava `settled`, e como o KC não emite
    // mais nada até o próximo movimento, paddingBottom ficava 0 = composer
    // coberto. Fix: (1) o didHide só "assenta" depois de confirmar (fila JS
    // drenada) que o teclado continua fechado; (2) didShow com height ~0 =
    // valor perdido → restaura com a altura real do evento (auto-cura).
    let hideTimer = null;
    let showTimer = null; // [2026-10-13 android-kbd-flicker]
    const onHide = () => {
      // [2026-10-18 kb-resume] keyboardDidHide postado pelo iOS ao ir pro fundo
      // (ou processado na volta): o sistema devolve o teclado aberto sozinho.
      // Assentar aqui jogava o composer pra baixo e ele subia de novo = pisca.
      // A checagem do AppState 'active' abaixo decide depois da volta.
      // [2026-10-19 kb-native] Founder (729): composer PRESO no meio da tela com
      // o teclado fechado. Ignorar este didHide de vez deixava o padding velho
      // valendo quando o teclado NÃO voltava (só o AppState decidia, com o JS
      // da volta ainda ocupado). Agora adia: depois da janela de volta confere
      // o teclado de verdade e assenta se continuar fechado.
      if (isAppResuming()) {
        if (!kbNativeTransitionsOn()) return;
        if (hideTimer) clearTimeout(hideTimer);
        const later = () => {
          hideTimer = null;
          if (isAppResuming()) { hideTimer = setTimeout(later, 400); return; }
          settleIfHiddenStrict();
        };
        hideTimer = setTimeout(later, 900);
        return;
      }
      if (showTimer) { clearTimeout(showTimer); showTimer = null; }
      if (hideTimer) clearTimeout(hideTimer);
      try { pubRest.current(0); } catch {} // [kb-translate] teclado já desceu
      healSoon('didHide', 900); // [2026-10-19 kb-heal] rede depois do settle normal
      hideTimer = setTimeout(() => {
        hideTimer = null;
        // KC still reports a keyboard (UI thread) → a re-open may be in
        // flight; give its willShow time to arrive (it cancels this timer)
        // before trusting "closed" (a hide lost under a Modal still settles).
        let kcOpen = false;
        try { kcOpen = Math.abs(height.value) > 1; } catch {}
        if (!kcOpen) { settleIfHidden(); return; }
        hideTimer = setTimeout(() => { hideTimer = null; settleIfHidden(); }, 450);
      }, 120);
    };
    const onWillShow = () => {
      lastShowAt = Date.now(); // [2026-10-19 kb-native]
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      settled.value = 0;
    };
    // End of the open animation: KC must report the keyboard by now. ~0 here
    // = its value was lost/overwritten → restore it (composer back on top).
    const restoreIfLost = (kh) => {
      try {
        // [2026-10-19 kb-heal] didShow atrasado com o teclado já fechado não levanta.
        if (kh > 0 && Math.abs(height.value) < 1 && Keyboard.isVisible()) {
          height.value = -kh;
          progress.value = 1;
        }
      } catch {}
    };
    const onDidShow = (e) => {
      onWillShow();
      const kh = Number(e?.endCoordinates?.height) || 0;
      if (kh > 1) lastOpenKh = kh; // [2026-10-19 attach-hold]
      // [2026-10-13 android-kbd-flicker] ANDROID: o RN emite keyboardDidShow no
      // 1º global layout com o IME visível = INÍCIO da animação
      // (ReactRootView.checkForKeyboardEvents), quando o KC (que no Android só
      // atualiza `height` em onKeyboardMove, frame a frame) ainda está em ~0.
      // O restore imediato jogava o composer direto pro topo e o frame seguinte
      // do KC o puxava de volta pra baixo → "tela pisca" a cada abertura.
      // Além disso esse `height` do RN exclui a barra de navegação (ime −
      // systemBars) e o do KC inclui. Agora: confere só depois da animação e
      // soma a barra (bottomInset). iOS: inalterado (didShow = fim da animação).
      if (Platform.OS === 'android') {
        if (showTimer) clearTimeout(showTimer);
        showTimer = setTimeout(() => {
          showTimer = null;
          try { if (!Keyboard.isVisible()) return; } catch {}
          restoreIfLost(kh > 0 ? kh + (insetRef.current || 0) : 0);
        }, 450);
        return;
      }
      restoreIfLost(kh);
      try { pubRest.current(kh); } catch {} // [kb-translate] fim da subida
    };
    const subHide = Keyboard.addListener('keyboardDidHide', onHide);
    const subShow = Platform.OS === 'ios' ? Keyboard.addListener('keyboardWillShow', onWillShow) : null;
    const subShow2 = Keyboard.addListener('keyboardDidShow', onDidShow);
    let appStateTimer = null;
    const subApp = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      healSoon('active', 1800); // [2026-10-19 kb-heal] depois da janela de volta
      if (appStateTimer) clearTimeout(appStateTimer);
      // iOS restores a previously-open keyboard right after resume — give it
      // time to emit keyboardWillShow before deciding it's closed.
      // [2026-10-18 kb-resume] KC (thread de UI) ainda vê teclado → confere de
      // novo antes de assentar (o RN pode ter perdido o didShow da volta).
      appStateTimer = setTimeout(() => {
        appStateTimer = null;
        let kcOpen = false;
        try { kcOpen = Math.abs(height.value) > 1; } catch {}
        if (!kcOpen || !isAppResumingGuardOn()) { settleIfHidden(); return; }
        appStateTimer = setTimeout(() => {
          appStateTimer = null;
          // [2026-10-19 kb-native] RN + KC concordam que está fechado → assenta.
          if (kbNativeTransitionsOn()) settleIfHiddenStrict(); else settleIfHidden();
        }, 600);
      }, 700);
    });
    return () => {
      try { subHide.remove(); } catch {}
      try { subShow?.remove(); } catch {}
      try { subShow2.remove(); } catch {}
      if (hideTimer) clearTimeout(hideTimer);
      if (showTimer) clearTimeout(showTimer);
      if (mountTimer) clearTimeout(mountTimer);
      try { subApp.remove(); } catch {}
      if (appStateTimer) clearTimeout(appStateTimer);
      try { unsubSync(); } catch {}
      try { unsubKh(); } catch {} // [2026-10-19 attach-hold]
      _attachFns.delete(attachObj);
      if (holdTimer) clearTimeout(holdTimer);
      if (clampTimer) clearTimeout(clampTimer);
      if (thawTimer) clearTimeout(thawTimer); // [2026-10-20 attach-freeze]
      _healFns.delete(healFn); // [2026-10-19 kb-heal]
      clearInterval(watchdog);
      if (healTimer) clearTimeout(healTimer);
      if (healAnimTimer) clearTimeout(healAnimTimer);
      navSubs.forEach((u) => { try { if (typeof u === 'function') u(); } catch {} });
      if (navTimer) clearTimeout(navTimer);
      _enabledRefs = Math.max(0, _enabledRefs - 1);
      if (_enabledRefs === 0) {
        _setRestLift(0); // [kb-translate]
        setEnabled(false);
        // KC stops observing now — don't leave a keyboard height behind for
        // the next thread to inherit.
        try { height.value = 0; progress.value = 0; } catch {}
      }
    };
  }, [setEnabled]);

  // Any real keyboard movement (open / interactive drag) → follow KC again.
  // [2026-10-13 android-kbd-flicker] iOS only — Android usa onStart/onInteractive acima.
  Rea.useAnimatedReaction(
    () => height.value,
    (cur, prev) => {
      'worklet';
      if (_IS_ANDROID) return;
      if (prev !== null && prev !== undefined && cur !== prev && cur !== 0) settled.value = 0;
    },
    [],
  );

  const inset = bottomInset || 0;
  // [2026-10-19 kb-translate] lift = quanto a barra sobe (teclado − inset).
  const lift = Rea.useDerivedValue(() => {
    'worklet';
    if (ignoreKb.value === 1) return 0; // [2026-10-20 attach-tgwin] folha na tela: chat ignora o teclado
    if (hold.value > 0.5) return hold.value; // [2026-10-19 attach-hold] conversa parada sob a folha
    if (settled.value === 1 || clamp.value === 1) return 0;
    return Math.max(0, -height.value - inset);
  }, [inset]);
  // Troca padding ↔ transform: o shared value muda no UI thread e TODOS os
  // estilos (container, barra, lista) saem no mesmo quadro/commit = sem pulo.
  useEffect(() => {
    tmode.value = tOn ? 1 : 0;
    let kh = 0;
    try { if (Keyboard.isVisible()) kh = Number(Keyboard.metrics()?.height) || 0; } catch {}
    try { pubRest.current(kh); } catch {}
  }, [tOn, tmode]);
  const animatedStyle = Rea.useAnimatedStyle(() => {
    'worklet';
    if (tmode.value === 1) return { paddingBottom: 0 };
    return { paddingBottom: lift.value };
  }, []);
  const kbCtx = React.useMemo(() => (kbBase ? { base: true, lift, tmode, dock } : null), [kbBase, lift, tmode, dock]);

  // [2026-10-20 attach-freeze] painel falso no vão do lift congelado.
  const fakeStyle = Rea.useAnimatedStyle(() => {
    'worklet';
    const on = fake.value === 1;
    return { height: on ? Math.max(0, hold.value) : 0, opacity: on ? 1 : 0, backgroundColor: fakeColor.value };
  }, []);
  const AnimatedView = Rea.default.View;
  const body = (
    <AnimatedView style={[style, animatedStyle]}>
      {children}
      <AnimatedView pointerEvents="none" style={[_fakePanelBase, fakeStyle]} />
    </AnimatedView>
  );
  return kbCtx ? <ThreadKbCtx.Provider value={kbCtx}>{body}</ThreadKbCtx.Provider> : body;
}

// [2026-10-19 kb-translate] transform da barra/lista (UI thread, só transform).
function _useLiftTransform(ctx) {
  const lift = ctx.lift;
  const tmode = ctx.tmode;
  return Rea.useAnimatedStyle(() => {
    'worklet';
    return { transform: [{ translateY: tmode.value === 1 ? -lift.value : 0 }] };
  }, []);
}

// [2026-10-20 native-dock] o nativo move estas views (testID) — sem estilo do JS.
function ThreadKbBarDock({ children }) {
  return <View testID="chatyy-dock-bar" pointerEvents="box-none" collapsable={false}>{children}</View>;
}
function ThreadKbListDock({ children }) {
  return (
    <View style={_clipStyle} collapsable={false}>
      <View testID="chatyy-dock-list" style={_flex1} collapsable={false}>{children}</View>
    </View>
  );
}

function ThreadKbBarInner({ ctx, children }) {
  const st = _useLiftTransform(ctx);
  const AV = Rea.default.View;
  return <AV style={st} pointerEvents="box-none" collapsable={false}>{children}</AV>;
}

function ThreadKbListClip({ ctx, children }) {
  const st = _useLiftTransform(ctx);
  const AV = Rea.default.View;
  return (
    <View style={_clipStyle} collapsable={false}>
      <AV style={[_flex1, st]} collapsable={false}>{children}</AV>
    </View>
  );
}

// [2026-10-20 native-dock] Elemento FLUTUANTE (position absolute, ancorado no
// rodapé — FAB de menções etc.): no dock nativo vai numa camada de tela cheia
// "chatyy-dock-bar" para subir grudado no teclado junto com a barra.
const _floatFill = { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 };
export function ThreadKeyboardFloat({ children }) {
  const ctx = React.useContext(ThreadKbCtx);
  if (!ctx || !ctx.dock) return children;
  return <View testID="chatyy-dock-bar" style={_floatFill} pointerEvents="box-none" collapsable={false}>{children}</View>;
}

/** [2026-10-19 kb-translate] Envolve o que fica ABAIXO da lista e precisa subir
 *  com o teclado (prévia de link, resposta, ↓, compositor). Fora do modo
 *  (Android, web, sem KC, kill switch) = os filhos direto (árvore de antes). */
export function ThreadKeyboardBar({ children }) {
  const ctx = React.useContext(ThreadKbCtx);
  if (!ctx || !ctx.base) return children;
  if (ctx.dock) return <ThreadKbBarDock>{children}</ThreadKbBarDock>; // [2026-10-20 native-dock]
  return <ThreadKbBarInner ctx={ctx}>{children}</ThreadKbBarInner>;
}

function RNThreadKeyboardAvoider({ style, bottomInset, children }) {
  return (
    <KeyboardAvoidingView
      // Same platform behaviours as before. The negative offset removes the
      // part of the keyboard that overlaps the composer's own bottom inset,
      // so the composer can keep a constant paddingBottom (no state needed).
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={-(bottomInset || 0)}
      style={style}
    >
      {children}
    </KeyboardAvoidingView>
  );
}

export const ThreadKeyboardAvoider = KEYBOARD_CONTROLLER_ACTIVE
  ? KCThreadKeyboardAvoider
  : RNThreadKeyboardAvoider;

// [2026-10-15 native-emoji] Painel nativo de emoji/figurinhas/GIF do composer
// (components/chat/NativeEmojiPanelBridge.js) acompanha o MESMO valor do teclado
// (UI thread) que o ThreadKeyboardAvoider: abrir/fechar painel ⇄ teclado sem
// pulo de altura. Sem KC → null (o painel usa altura fixa).
export const useThreadKeyboardHeight = KEYBOARD_CONTROLLER_ACTIVE
  ? function useThreadKeyboardHeightKC() {
    const { height } = KC.useReanimatedKeyboardAnimation();
    return height;
  }
  : function useThreadKeyboardHeightNone() {
    return null;
  };

export function getThreadReanimated() {
  return KEYBOARD_CONTROLLER_ACTIVE ? Rea : null;
}

// Android: interactive keyboard swipe over the message list (KC
// KeyboardGestureArea, API 30+). iOS uses the ScrollView's native
// keyboardDismissMode="interactive" (KC tracks it), so no wrapper there —
// keeps the iOS/web layout tree identical.
export function ThreadKeyboardGestureArea({ children }) {
  const kbCtx = React.useContext(ThreadKbCtx); // [2026-10-19 kb-translate]
  if (Platform.OS === 'ios' && kbCtx && kbCtx.base) {
    if (kbCtx.dock) return <ThreadKbListDock>{children}</ThreadKbListDock>; // [2026-10-20 native-dock]
    return <ThreadKbListClip ctx={kbCtx}>{children}</ThreadKbListClip>;
  }
  if (!KEYBOARD_CONTROLLER_ACTIVE || Platform.OS !== 'android' || Platform.Version < 30) {
    return children;
  }
  return (
    <KC.KeyboardGestureArea
      style={{ flex: 1 }}
      interpolator="ios"
      textInputNativeID={THREAD_COMPOSER_NATIVE_ID}
    >
      {children}
    </KC.KeyboardGestureArea>
  );
}
