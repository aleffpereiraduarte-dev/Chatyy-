// [2026-10-07 login-ux] Keyboard-aware scroll container for the auth screens.
//
// Native (binary with react-native-keyboard-controller, runtime >= 2.6.0):
// KC's KeyboardAwareScrollView keeps the FOCUSED input (+ bottomOffset, so the
// primary button too) above the keyboard frame-by-frame — no jump, works with
// Android edge-to-edge where adjustResize no longer resizes the window.
// The root KeyboardProvider is mounted DISABLED (utils/threadKeyboard), so we
// enable it while mounted and restore the previous state on unmount (never
// disabling it under a chat thread that had it on).
//
// Web / binaries without KC: RN KeyboardAvoidingView + ScrollView (old path).
import { useEffect, useRef } from 'react';
import { KeyboardAvoidingView, ScrollView, Platform } from 'react-native';
import { KEYBOARD_CONTROLLER_ACTIVE } from '../../utils/threadKeyboard';

let KC = null;
if (KEYBOARD_CONTROLLER_ACTIVE) {
  // Already required (and proven present) by the threadKeyboard probe.
  // eslint-disable-next-line global-require
  try { KC = require('react-native-keyboard-controller'); } catch { KC = null; }
}
const KC_OK = !!(KC && KC.KeyboardAwareScrollView && KC.useKeyboardController);

function KCScroll({ children, contentContainerStyle, bottomOffset = 24, scrollRef }) {
  const { enabled, setEnabled } = KC.useKeyboardController();
  const wasEnabledRef = useRef(enabled);
  useEffect(() => {
    const was = wasEnabledRef.current;
    if (!was) setEnabled(true);
    return () => { if (!was) setEnabled(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const Aware = KC.KeyboardAwareScrollView;
  return (
    <Aware
      ref={scrollRef}
      bottomOffset={bottomOffset}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={contentContainerStyle}
      style={{ flex: 1 }}
    >
      {children}
    </Aware>
  );
}

function RNScroll({ children, contentContainerStyle, keyboardVerticalOffset = 0, scrollRef }) {
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={keyboardVerticalOffset}
    >
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={contentContainerStyle}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export default function LoginKeyboardScroll(props) {
  if (KC_OK && Platform.OS !== 'web') return <KCScroll {...props} />;
  return <RNScroll {...props} />;
}
