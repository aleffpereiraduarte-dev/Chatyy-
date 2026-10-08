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
import { AppState, Keyboard, KeyboardAvoidingView, Platform, TurboModuleRegistry } from 'react-native';

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
function KCThreadKeyboardAvoider({ style, bottomInset, children }) {
  const { setEnabled } = KC.useKeyboardController();
  // height: 0 → -keyboardHeight (measured from the screen bottom, so it
  // includes the home indicator / Android nav bar). The composer keeps a
  // constant `bottomInset` padding, so the container only needs to rise by
  // keyboardHeight - bottomInset for the composer to sit flush on the keyboard.
  const { height, progress } = KC.useReanimatedKeyboardAnimation();
  const settled = Rea.useSharedValue(0);

  useEffect(() => {
    _enabledRefs += 1;
    setEnabled(true);
    const settle = () => {
      settled.value = 1;
      // Also clear KC's stale value so the NEXT open is a real change (a
      // stuck -336 followed by an open to -336 wouldn't fire the reaction).
      try { if (height.value !== 0) { height.value = 0; progress.value = 0; } } catch {}
    };
    const settleIfHidden = () => {
      try { if (!Keyboard.isVisible()) settle(); } catch {}
    };
    settleIfHidden();
    const subHide = Keyboard.addListener('keyboardDidHide', settle);
    const subShow = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => { settled.value = 0; });
    let appStateTimer = null;
    const subApp = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      if (appStateTimer) clearTimeout(appStateTimer);
      // iOS restores a previously-open keyboard right after resume — give it
      // time to emit keyboardWillShow before deciding it's closed.
      appStateTimer = setTimeout(settleIfHidden, 700);
    });
    return () => {
      try { subHide.remove(); } catch {}
      try { subShow.remove(); } catch {}
      try { subApp.remove(); } catch {}
      if (appStateTimer) clearTimeout(appStateTimer);
      _enabledRefs = Math.max(0, _enabledRefs - 1);
      if (_enabledRefs === 0) {
        setEnabled(false);
        // KC stops observing now — don't leave a keyboard height behind for
        // the next thread to inherit.
        try { height.value = 0; progress.value = 0; } catch {}
      }
    };
  }, [setEnabled]);

  // Any real keyboard movement (open / interactive drag) → follow KC again.
  Rea.useAnimatedReaction(
    () => height.value,
    (cur, prev) => {
      'worklet';
      if (prev !== null && prev !== undefined && cur !== prev && cur !== 0) settled.value = 0;
    },
    [],
  );

  const inset = bottomInset || 0;
  const animatedStyle = Rea.useAnimatedStyle(() => {
    'worklet';
    if (settled.value === 1) return { paddingBottom: 0 };
    return { paddingBottom: Math.max(0, -height.value - inset) };
  }, [inset]);

  const AnimatedView = Rea.default.View;
  return <AnimatedView style={[style, animatedStyle]}>{children}</AnimatedView>;
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

// Android: interactive keyboard swipe over the message list (KC
// KeyboardGestureArea, API 30+). iOS uses the ScrollView's native
// keyboardDismissMode="interactive" (KC tracks it), so no wrapper there —
// keeps the iOS/web layout tree identical.
export function ThreadKeyboardGestureArea({ children }) {
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
