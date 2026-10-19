// components/games/sound.js — [jogos 2026-10-18] efeitos sonoros dos jogos (sutis, originais, gerados
// para o Chatyy). Liga/desliga pelo botão de som da tela do jogo (AsyncStorage 'chatyy_games_sound', padrão
// ligado). Nunca lança; não mexe no modo de áudio do app (não atrapalha chamadas/música).
import AsyncStorage from '@react-native-async-storage/async-storage';

const SRC = {
  tap: require('../../assets/sounds/games/tap.wav'),
  move: require('../../assets/sounds/games/move.wav'),
  capture: require('../../assets/sounds/games/capture.wav'),
  card: require('../../assets/sounds/games/card.wav'),
  draw: require('../../assets/sounds/games/draw.wav'),
  turn: require('../../assets/sounds/games/turn.wav'),
  win: require('../../assets/sounds/games/win.wav'),
  wrong: require('../../assets/sounds/games/wrong.wav'),
  correct: require('../../assets/sounds/games/correct.wav'),
};
const KEY = 'chatyy_games_sound';
let _on = true;
let _loaded = false;
const _players = {};
const _subs = new Set();

export async function loadSoundPref() {
  if (_loaded) return _on;
  _loaded = true;
  try { const v = await AsyncStorage.getItem(KEY); if (v === '0') _on = false; } catch {}
  for (const fn of Array.from(_subs)) { try { fn(_on); } catch {} }
  return _on;
}
export function soundOn() { return _on; }
export function onSoundPref(fn) { _subs.add(fn); return () => _subs.delete(fn); }
export function setSoundOn(v) {
  _on = !!v;
  try { AsyncStorage.setItem(KEY, _on ? '1' : '0').catch(() => {}); } catch {}
  for (const fn of Array.from(_subs)) { try { fn(_on); } catch {} }
}
const _lastAt = {};
export function playSfx(name) {
  if (!_on || !SRC[name]) return;
  // mesmo som 2x em < 70 ms (ex.: lance + eco do WS) soa como estalo: toca 1 vez só
  const now = Date.now();
  if (_lastAt[name] && now - _lastAt[name] < 70) return;
  _lastAt[name] = now;
  try {
    let p = _players[name];
    if (!p) {
      const { createAudioPlayer } = require('expo-audio');
      p = createAudioPlayer(SRC[name]);
      try { p.volume = name === 'win' ? 0.55 : 0.4; } catch {}
      _players[name] = p;
    }
    try { p.seekTo(0); } catch {}
    p.play();
  } catch {}
}
export function releaseSfx() {
  for (const k of Object.keys(_players)) { try { _players[k].remove(); } catch {} delete _players[k]; }
}
