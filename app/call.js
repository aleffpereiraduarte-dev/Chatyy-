// app/call.js — Mobile fallback for /call route.
//
// Expo Router requires a sibling without platform extension when call.web.js
// exists, otherwise the entire web bundle fails to register routes with:
// "The file ./call.web.js does not have a fallback sibling file without a
// platform extension."
//
// On mobile, outgoing calls in foreground are handled by the native
// CallActivity (Android) / CallViewController (iOS) via voipNative.js, not
// via this screen. When the JS-side router does land here (rare — typically
// a stale push or deep-link), we just send the user back to the chat list
// so the native flow can re-arm on its own terms instead of rendering a
// dead WebRTC stub.
import { useEffect } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';

export default function CallMobileFallback() {
  useEffect(() => {
    try { router.replace('/chat'); } catch { /* nav unavailable */ }
  }, []);
  return <View />;
}
