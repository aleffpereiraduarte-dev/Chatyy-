/**
 * Global audio manager — allows stopping all playing audio from anywhere.
 * AudioPlayer instances register their stop callback here.
 * Call stopAllAudio() before starting a call, etc.
 */

const _players = new Set();

export function registerAudioPlayer(stopFn) {
  _players.add(stopFn);
  return () => _players.delete(stopFn);
}

export function stopAllAudio() {
  _players.forEach(fn => { try { fn(); } catch {} });
}
