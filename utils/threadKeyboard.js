// threadKeyboard (WEB / default) — keyboard handling for the chat thread.
//
// The native build (`threadKeyboard.native.js`) glues the composer to the
// keyboard frame-by-frame with react-native-keyboard-controller + Reanimated.
// On web none of that exists (react-native-web has no soft keyboard events),
// so this file keeps the EXACT previous behaviour: RN-web's
// KeyboardAvoidingView (a plain View there), no gesture area, no provider.
// Metro picks `.native.js` on iOS/Android, so the web bundle never pulls
// react-native-keyboard-controller / react-native-reanimated from here.
import React from 'react';
import { KeyboardAvoidingView } from 'react-native';

export const KEYBOARD_CONTROLLER_ACTIVE = false;

export function ChatyyKeyboardProvider({ children }) {
  return children;
}

export function ThreadKeyboardAvoider({ style, children }) {
  return <KeyboardAvoidingView style={style}>{children}</KeyboardAvoidingView>;
}

export function ThreadKeyboardGestureArea({ children }) {
  return children;
}

// [2026-10-19 kb-translate] mesmas exports do .native.js (web: sem teclado virtual).
export function ThreadKeyboardBar({ children }) {
  return children;
}

export function useThreadKbRestLift() {
  return 0;
}

// [2026-10-19 kb-heal] mesma export do .native.js (web: nada a curar).
export function threadKbNoteComposerBlur() {}
// [2026-10-19 attach-hold] mesmas exports do .native.js (web: no-op).
export function threadKbAttachBegin() {}
export function threadKbAttachEnd() {}
export function threadKbAttachFreezeOn() { return false; } // [2026-10-20 attach-freeze]
export function composerNativeDockOn() { return false; } // [2026-10-20 native-dock]
export function ThreadKeyboardFloat({ children }) { return children; }
export function threadKbIgnoreKeyboard() {} // [2026-10-20 attach-tgwin]
export function threadKbAttachFreeze() { return false; }
export function threadKbAttachThaw() {}
export function threadKbNoteComposerFocus() {}

export const THREAD_LIST_KEYBOARD_DISMISS_MODE = 'on-drag';
export const THREAD_COMPOSER_NATIVE_ID = 'chatyy-thread-composer';

// [2026-10-15 native-emoji] mesmas exports do .native.js (web: sem teclado virtual).
export function useThreadKeyboardHeight() {
  return null;
}

export function getThreadReanimated() {
  return null;
}
