/**
 * Global audio manager — allows stopping all playing audio from anywhere.
 * AudioPlayer instances register their stop callback here.
 * Call stopAllAudio() before starting a call, etc.
 *
 * Also exposes a media-player registry (status/reels/feed video) so an
 * incoming call can pause everything in lockstep, not just voice msgs.
 */
import { Platform } from 'react-native';

const _players = new Set();
const _mediaPlayers = new Set();

export function registerAudioPlayer(stopFn) {
  _players.add(stopFn);
  return () => _players.delete(stopFn);
}

// Register a video/media stop callback. Used by status viewer, reels viewer,
// chat-conversation video bubbles. The fn should pause the player AND mark
// state so it doesn't auto-resume on re-render. Returns an unregister fn.
export function registerMediaPlayer(stopFn) {
  _mediaPlayers.add(stopFn);
  return () => _mediaPlayers.delete(stopFn);
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
  // Also pause every registered video/media player so an incoming call
  // doesn't fight a status story or a chat video at full volume.
  _mediaPlayers.forEach(fn => {
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
