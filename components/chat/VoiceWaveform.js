// [2026-10-07 voice-native] Web (and default) resolution of VoiceWaveform —
// RN Animated implementation. iOS/Android resolve VoiceWaveform.native.js
// (Reanimated + gesture-handler on the UI thread), so the web bundle never
// pulls react-native-reanimated from here (same rule as SwipeReplyRow).
export { default } from './VoiceWaveformLegacy';
export const VOICE_WAVEFORM_UI_THREAD = false;
