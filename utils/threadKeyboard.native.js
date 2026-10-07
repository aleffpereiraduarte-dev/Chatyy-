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
import { KeyboardAvoidingView, Platform, TurboModuleRegistry } from 'react-native';

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

function KCThreadKeyboardAvoider({ style, bottomInset, children }) {
  const { setEnabled } = KC.useKeyboardController();
  useEffect(() => {
    _enabledRefs += 1;
    setEnabled(true);
    return () => {
      _enabledRefs = Math.max(0, _enabledRefs - 1);
      if (_enabledRefs === 0) setEnabled(false);
    };
  }, [setEnabled]);

  // height: 0 → -keyboardHeight (measured from the screen bottom, so it
  // includes the home indicator / Android nav bar). The composer keeps a
  // constant `bottomInset` padding, so the container only needs to rise by
  // keyboardHeight - bottomInset for the composer to sit flush on the keyboard.
  const { height } = KC.useReanimatedKeyboardAnimation();
  const inset = bottomInset || 0;
  const animatedStyle = Rea.useAnimatedStyle(() => {
    'worklet';
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
