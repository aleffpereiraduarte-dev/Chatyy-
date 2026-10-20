// components/games/sound.js — [jogos 2026-10-18] efeitos sonoros dos jogos (sutis, originais, gerados
// para o Chatyy). Liga/desliga pelo botão de som da tela do jogo (AsyncStorage 'chatyy_games_sound', padrão
// ligado). Nunca lança; não mexe no modo de áudio do app (não atrapalha chamadas/música).
//
// [2026-10-20 call-safe] "Quando começamos a jogar, a ligação cai": o expo-audio (iOS, AudioModule.swift)
// faz AVAudioSession.setActive(true) no play() e, com keepAudioSessionActive=false (padrão), setActive(false,
// .notifyOthersOnDeactivation) 0,1 s depois de CADA som terminar — numa ligação isso derruba a sessão do
// CallKit/LiveKit (I/O parado no meio da chamada). Agora: com ligação ativa (ou tocando/conectando) os jogos
// ficam MUDOS (nem criam player) e os players existentes são soltos; fora da ligação nada muda.
// Kill: globalThis.__chatyy_games_sfx_in_call === true volta a tocar durante a ligação (não recomendado).
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
/** Ligação viva/tocando/conectando (nativa ou JS) → true. Na dúvida (erro), trata como ligação. */
export function callBusyForSfx() {
  try { if (globalThis.__chatyy_games_sfx_in_call === true) return false; } catch {}
  try {
    if (globalThis.__chatyyNativeCallActive || globalThis.__chatyyCallActive) return true;
    if (require('../../services/ongoingCall').isCallOngoing()) return true;
    const cs = require('../../services/callState');
    const st = cs && cs.getCallState ? cs.getCallState() : null;
    if (st === 'active' || st === 'answered' || st === 'ringing' || st === 'connecting' || st === 'calling') return true;
  } catch { return true; }
  return false;
}
const _lastAt = {};
export function playSfx(name) {
  if (!_on || !SRC[name]) return;
  if (callBusyForSfx()) { if (Object.keys(_players).length) releaseSfx(); return; }
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
