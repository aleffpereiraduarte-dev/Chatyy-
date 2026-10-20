// services/callAudioGuard.js — [2026-10-20 call-audio-guard] guarda central de áudio x ligação.
//
// Causa (iOS, expo-audio 55 AudioModule.swift): cada player criado com keepAudioSessionActive=false
// (o padrão) chama AVAudioSession.setActive(false, .notifyOthersOnDeactivation) ~0,1 s depois de
// TERMINAR ou de pause(). setAudioModeAsync() faz setCategory(.playback/.playAndRecord, mode .default)
// e o gravador (prepareToRecordAsync) faz setCategory(.playAndRecord, mode: .default) + setActive(true).
// Numa ligação a sessão é a MESMA do CallKit/LiveKit (.playAndRecord + .voiceChat): desativar para o
// I/O da chamada ("a ligação cai"/fica muda) e trocar a categoria/modo mata o mic ou o AEC.
// Regras com ligação ativa (tocando/conectando/em curso):
//   • sons de UI/efeito: mudos (sfxMutedForCall) — nem criam player;
//   • players que precisam tocar (nota de voz, toque de chamada): callSafePlayerOptions() força
//     keepAudioSessionActive=true (nunca desativa a sessão) e callSafeSetAudioMode() NÃO mexe na sessão;
//   • gravar áudio (nota de voz, comentário, status, Bia): bloqueado com aviso (blockIfCall('record')).
// Kill switch: globalThis.__chatyy_call_audio_guard === false desliga tudo (comportamento antigo).
import { Platform, Alert } from 'react-native';

function _guardOn() {
  try { return globalThis.__chatyy_call_audio_guard !== false; } catch { return true; }
}

/** Ligação viva/tocando/conectando (CallKit nativo, /call.js, PSTN, barra de ligação). Erro → true. */
export function isCallActiveNow() {
  try {
    if (globalThis.__chatyyNativeCallActive || globalThis.__chatyyCallActive) return true;
  } catch {}
  try {
    // eslint-disable-next-line global-require
    if (require('./ongoingCall').isCallOngoing()) return true;
  } catch {}
  try {
    // eslint-disable-next-line global-require
    const cs = require('./callState');
    const st = cs && cs.getCallState ? cs.getCallState() : null;
    if (st === 'active' || st === 'answered' || st === 'ringing' || st === 'connecting' || st === 'calling') return true;
  } catch { return true; }
  return false;
}

/**
 * Versão ESTRITA (para BLOQUEAR ações do usuário, onde falso positivo irrita): só ligação de fato no ar
 * ou conectando — snapshot nativo do CallKit / barra de ligação (isCallOngoing) ou estado ativo/atendido.
 * Ignora 'ringing' e marcadores soltos que possam ter vazado. Erro → false (não bloqueia à toa).
 */
export function isCallLiveStrict() {
  try {
    // eslint-disable-next-line global-require
    if (require('./ongoingCall').isCallOngoing()) return true;
  } catch {}
  try { if (globalThis.__chatyyNativeCallActive === true) return true; } catch {}
  try {
    // eslint-disable-next-line global-require
    const st = require('./callState').getCallState();
    if (st === 'active' || st === 'answered') return true;
  } catch {}
  return false;
}

/** Guarda ligada E ligação ativa. Use para decidir "não mexer na sessão". */
export function callAudioGuardActive() {
  if (Platform.OS === 'web') return false;
  return _guardOn() && isCallActiveNow();
}

/** Sons de UI/efeito (bipes, prévias, música de status, TTS de prévia) devem ficar mudos agora? */
export function sfxMutedForCall() {
  return callAudioGuardActive();
}

/**
 * Opções de createAudioPlayer/useAudioPlayer seguras para ligação: no iOS durante a ligação o player
 * nunca desativa a AVAudioSession (keepAudioSessionActive=true). Fora da ligação: opções intactas.
 * `always` = força sempre (players que só existem DURANTE ligação, ex.: ringback).
 */
export function callSafePlayerOptions(opts, always) {
  const o = opts && typeof opts === 'object' ? { ...opts } : {};
  if (Platform.OS === 'ios' && _guardOn() && (always || isCallActiveNow())) o.keepAudioSessionActive = true;
  return o;
}

/**
 * setAudioModeAsync que NÃO toca na sessão durante ligação (iOS). Retorna true se aplicou.
 * `mod` = módulo expo-audio (opcional; carrega sozinho).
 */
export async function callSafeSetAudioMode(mode, mod) {
  if (Platform.OS === 'ios' && callAudioGuardActive()) return false;
  try {
    // eslint-disable-next-line global-require
    const m = mod || require('expo-audio');
    const fn = m && (m.setAudioModeAsync || (m.AudioModule && m.AudioModule.setAudioModeAsync));
    if (typeof fn !== 'function') return false;
    await fn(mode);
    return true;
  } catch { return false; }
}

/**
 * Para (e solta, se `release`) um player expo-audio sem desativar a sessão durante ligação:
 * no iOS o pause() de um player keepAudioSessionActive=false agenda setActive(false) — com ligação,
 * para via taxa 0 + mudo (setPlaybackRate não toca na sessão) e só então solta.
 */
export function callSafeStopPlayer(p, release) {
  if (!p) return;
  if (Platform.OS === 'ios' && callAudioGuardActive()) {
    try { p.muted = true; } catch {}
    try { if (typeof p.setPlaybackRate === 'function') p.setPlaybackRate(0); } catch {}
  } else {
    try { p.pause(); } catch {}
  }
  if (release) { try { p.remove(); } catch {} }
}

function _lang() {
  try { return String(globalThis.__chatyyLang || 'pt-BR').toLowerCase(); } catch { return 'pt-br'; }
}
const MSG = {
  record: {
    pt: ['Ligação em andamento', 'Termine a ligação para gravar áudio.'],
    es: ['Llamada en curso', 'Termina la llamada para grabar audio.'],
    en: ['Call in progress', 'End the call to record audio.'],
  },
  play: {
    pt: ['Ligação em andamento', 'Termine a ligação para ouvir.'],
    es: ['Llamada en curso', 'Termina la llamada para escuchar.'],
    en: ['Call in progress', 'End the call to listen.'],
  },
  voice: {
    pt: ['Ligação em andamento', 'Termine a ligação para falar com a Bia.'],
    es: ['Llamada en curso', 'Termina la llamada para hablar con Bia.'],
    en: ['Call in progress', 'End the call to talk to Bia.'],
  },
};
export function callBlockedText(kind) {
  const set = MSG[kind] || MSG.play;
  const l = _lang();
  const v = l.startsWith('pt') ? set.pt : (l.startsWith('es') ? set.es : set.en);
  return { title: v[0], message: v[1] };
}

let _lastAlertAt = 0;
/**
 * Bloqueia a ação se houver ligação ativa (iOS/Android). Mostra o aviso (no máx. 1 a cada 1,5 s)
 * e retorna true = "bloqueado, não continue". kind: 'record' | 'play' | 'voice'.
 */
export function blockIfCall(kind, opts) {
  if (Platform.OS === 'web' || !_guardOn()) return false;
  if (!isCallLiveStrict()) return false;
  if (!(opts && opts.silent)) {
    const now = Date.now();
    if (now - _lastAlertAt > 1500) {
      _lastAlertAt = now;
      try { const { title, message } = callBlockedText(kind); Alert.alert(title, message); } catch {}
    }
  }
  try {
    // eslint-disable-next-line global-require
    require('./crashReporter').reportStep?.('call_audio_blocked', String(kind || '?'));
  } catch {}
  return true;
}
