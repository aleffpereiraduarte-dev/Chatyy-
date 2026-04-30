/**
 * Global audio manager — allows stopping all playing audio from anywhere.
 * AudioPlayer instances register their stop callback here.
 * Call stopAllAudio() before starting a call, etc.
 */
import { Platform } from 'react-native';

const _players = new Set();

export function registerAudioPlayer(stopFn) {
  _players.add(stopFn);
  return () => _players.delete(stopFn);
}

export function stopAllAudio() {
  // Stop all registered players (expo-av, expo-audio instances)
  // stopFn pode retornar Promise — engole rejection pra evitar unhandled.
  _players.forEach(fn => {
    try {
      const r = fn();
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {}
  });

  // Stop ringtone/calling tone (manages its own state independently)
  try {
    const { stopRingtone } = require('./ringtone');
    stopRingtone();
  } catch {}

  // On native: set audio session to doNotMix so background music
  // (Spotify, Apple Music, etc.) is interrupted for the call.
  if (Platform.OS !== 'web') {
    try {
      const { AudioModule } = require('expo-audio');
      AudioModule.setAudioMode({
        playsInSilentMode: true,
        interruptionMode: 'doNotMix',
        shouldPlayInBackground: true,
      });
    } catch {}
    // expo-av fallback (in case expo-audio not available)
    try {
      const { Audio } = require('expo-av');
      Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        interruptionModeIOS: 2, // DoNotMix — interrupts background audio
        interruptionModeAndroid: 1, // DoNotMix
        shouldDuckAndroid: false,
        playThroughEarpieceAndroid: false,
      });
    } catch {}
  }
}
