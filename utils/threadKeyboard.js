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

export const THREAD_LIST_KEYBOARD_DISMISS_MODE = 'on-drag';
export const THREAD_COMPOSER_NATIVE_ID = 'chatyy-thread-composer';
