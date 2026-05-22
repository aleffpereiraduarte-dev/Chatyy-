import { Platform, Vibration } from 'react-native';

let audioContext = null;
let ringtoneInterval = null;
let ringtoneTimeout = null;
let ringtoneSound = null;
let callingSound = null;
let nativePlayer = null;
let ringtoneGeneration = 0; // Track generation to cancel async creation

// [mute-call-ringtone, 2026-05-19] Cached value of the "Modo silencioso
// para ligações" toggle. Hydrated lazily from AsyncStorage on first
// startRingtone — synchronous reads aren't available cross-platform, and
// startRingtone is called from the hot path (incoming call observer) so we
// can't afford a 30-50ms IO blocked on UI thread. The cache returns the
// previous run's value within ~1ms, and we kick a fresh re-hydrate in the
// background each call so the next ring reflects any setting changes the
// user made since.
//
// AsyncStorage key matches the one the settings screen writes
// (`mute_call_ringtone`). false = ring normally (default).
let muteCallRingtoneCached = false;
let muteCallRingtoneHydrated = false;
function hydrateMuteCallRingtone() {
  if (Platform.OS === 'web') {
    try {
      const v = (typeof localStorage !== 'undefined') ? localStorage.getItem('mute_call_ringtone') : null;
      muteCallRingtoneCached = v === 'true';
      muteCallRingtoneHydrated = true;
    } catch {}
    return;
  }
  // Native — fire and forget AsyncStorage read; first call uses the cached
  // (possibly stale) value. Each subsequent call refreshes the cache.
  import('@react-native-async-storage/async-storage').then(m => {
    m.default.getItem('mute_call_ringtone').then(v => {
      muteCallRingtoneCached = v === 'true';
      muteCallRingtoneHydrated = true;
    }).catch(() => {});
  }).catch(() => {});
}

function getAudioContext() {
  if (Platform.OS !== 'web') return null;
  if (!audioContext && typeof AudioContext !== 'undefined') {
    audioContext = new AudioContext();
  }
  return audioContext;
}

function playRingBurst(ctx) {
  if (!ctx || ctx.state === 'closed') return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});

  const now = ctx.currentTime;

  // Rich phone ring: dual-tone (440+480Hz) with harmonic overtone and smooth envelope
  const tones = [
    { freq: 440, vol: 0.12, type: 'sine' },
    { freq: 480, vol: 0.12, type: 'sine' },
    { freq: 880, vol: 0.025, type: 'sine' }, // harmonic for richness
  ];

  tones.forEach(({ freq, vol, type }) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    // Smooth envelope: fade in, sustain, fade out
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(vol, now + 0.04);
    gain.gain.setValueAtTime(vol, now + 0.7);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.85);
    osc.start(now);
    osc.stop(now + 0.9);
  });
}

// Generate a WAV buffer for a ringtone (works on both web and native)
function generateRingtoneWav() {
  const sampleRate = 16000;
  // Ring pattern: 0.8s ring, 0.2s pause, 0.8s ring = 1.8s total, then 2.2s pause in loop
  const ringDuration = 0.8;
  const pauseBetween = 0.2;
  const totalDuration = ringDuration + pauseBetween + ringDuration;
  const samples = Math.floor(sampleRate * totalDuration);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);

  // WAV header
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples * 2, true);

  // Generate dual-tone ring (440Hz + 480Hz)
  const ring1End = Math.floor(sampleRate * ringDuration);
  const pauseEnd = Math.floor(sampleRate * (ringDuration + pauseBetween));
  const ring2End = samples;

  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    let val = 0;
    if (i < ring1End || i >= pauseEnd) {
      // Ring tone - two frequencies mixed
      val = (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)) * 0.15;
    }
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, val)) * 32767, true);
  }

  return buffer;
}

// Generate a WAV for calling tone (what the caller hears - single 425Hz)
function generateCallingToneWav() {
  const sampleRate = 16000;
  const duration = 1.2; // 1.2s tone
  const samples = Math.floor(sampleRate * duration);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples * 2, true);

  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    // Fade in/out envelope
    let envelope = 1;
    if (t < 0.02) envelope = t / 0.02;
    else if (t > duration - 0.05) envelope = (duration - t) / 0.05;
    const val = Math.sin(2 * Math.PI * 425 * t) * 0.25 * envelope;
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, val)) * 32767, true);
  }

  return buffer;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Start incoming call ringtone (ring-ring pattern)
export function startRingtone() {
  stopRingtone();
  const generation = ++ringtoneGeneration;

  // [WAVE 141] Mobile = native ONLY. iOS CallKit / Android Telecom play the
  // system ringtone — JS must NEVER duplicate (would cause double-ring during
  // foreground transitions). Only web (which has no native call surface) is
  // allowed past this gate.
  if (Platform.OS !== 'web') {
    return;
  }

  // [mute-call-ringtone, 2026-05-19] Honor the user's silent-mode-for-calls
  // toggle. We refresh from AsyncStorage (or localStorage on web) every call
  // so settings changes take effect on the next inbound ring without needing
  // a restart. First call uses the cached value (false default).
  hydrateMuteCallRingtone();
  if (muteCallRingtoneCached) {
    // Skip sound + vibration entirely. The UI (IncomingCallListener) still
    // surfaces the modal — only the audible/haptic feedback is muted.
    return;
  }

  if (Platform.OS === 'web') {
    const ctx = getAudioContext();
    if (!ctx) return;
    // Play ring-ring...pause...ring-ring... (WhatsApp-like pattern)
    const playRingCycle = () => {
      playRingBurst(ctx);
      // Guarda o id pra cancelar em stopRingtone — antes o segundo burst
      // ainda tocava após stop, gerando "ringo fantasma" ao atender.
      ringtoneTimeout = setTimeout(() => playRingBurst(ctx), 250);
    };
    playRingCycle();
    ringtoneInterval = setInterval(playRingCycle, 4000);
  } else {
    // Native: play ringtone audio + vibration
    try {
      Vibration.vibrate([0, 800, 400, 800, 2000], true);
    } catch {}
    (async () => {
      try {
        const { createAudioPlayer, AudioModule } = require('expo-audio');
        // CRITICAL: await setAudioMode so the AVAudioSession is fully
        // configured before createAudioPlayer probes it. Previously the
        // promise wasn't awaited and play() raced the session config,
        // resulting in silent ringtone on iOS.
        try {
          await AudioModule.setAudioMode({
            playsInSilentMode: true,
            interruptionMode: 'mixWithOthers',
            shouldPlayInBackground: true,
            allowsRecording: false,
          });
        } catch {}
        if (generation !== ringtoneGeneration) return;
        const ringtoneAsset = require('../assets/ringtone.wav');
        const player = createAudioPlayer(ringtoneAsset, { isLooping: true });
        try { player.volume = 1.0; } catch {}
        if (generation !== ringtoneGeneration) {
          try { player.remove(); } catch {}
          return;
        }
        nativePlayer = player;
        try { player.play(); } catch (playErr) {
          console.warn('[Ringtone] play() failed:', playErr);
        }
      } catch (e) {
        console.warn('[Ringtone] Native audio error:', e);
      }
    })();
  }
}

// Calling tone (what the CALLER hears) - gentle "tuuummm...tuuummm"
export function startCallingTone() {
  stopRingtone();
  const generation = ++ringtoneGeneration;

  if (Platform.OS === 'web') {
    const ctx = getAudioContext();
    if (!ctx) return;

    const playTone = () => {
      if (!ctx || ctx.state === 'closed') return;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const now = ctx.currentTime;
      const gainNode = ctx.createGain();
      gainNode.connect(ctx.destination);
      gainNode.gain.setValueAtTime(0.08, now);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(425, now);
      osc.connect(gainNode);
      osc.start(now);
      osc.stop(now + 1.2);
    };

    playTone();
    ringtoneInterval = setInterval(playTone, 4000);
  } else {
    // Native: ringback tone (caller waiting for callee to answer).
    // [WAVE 72 2026-05-21] NO vibration on the caller's side — only the
    // callee's phone should vibrate. The caller hears the audio ringback
    // tone (below), which is enough feedback that the call is dialing.
    // Previously we vibrated here, which made the caller's phone shake
    // every 4s during outgoing call setup — wrong UX (parity bug vs
    // WhatsApp/iOS native).

    (async () => {
      try {
        const { createAudioPlayer, AudioModule } = require('expo-audio');
        try {
          await AudioModule.setAudioMode({
            playsInSilentMode: true,
            interruptionMode: 'mixWithOthers',
            shouldPlayInBackground: true,
            allowsRecording: false,
          });
        } catch {}
        if (generation !== ringtoneGeneration) return;
        // Reuse ringtone.wav at lower volume — sounds like a ringback
        // (single tone repeating) without shipping another asset.
        const ringtoneAsset = require('../assets/ringtone.wav');
        const player = createAudioPlayer(ringtoneAsset, { isLooping: true });
        try { player.volume = 0.55; } catch {}
        if (generation !== ringtoneGeneration) {
          try { player.remove(); } catch {}
          return;
        }
        nativePlayer = player;
        try { player.play(); } catch (playErr) {
          console.warn('[CallingTone] play() failed:', playErr);
        }
      } catch (e) {
        console.warn('[CallingTone] Native audio error:', e);
      }
    })();
  }
}

// Play a short descending "whoosh" tone when the call ends.
// 440Hz → 220Hz over ~300ms with exponential fade. Web Audio API on web,
// expo-audio with a small generated WAV on native. Honors chatyySettings
// (the caller should gate this — kept lightweight here).
export function playEndTone() {
  if (Platform.OS === 'web') {
    try {
      const ctx = getAudioContext();
      if (!ctx || ctx.state === 'closed') return;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      // Glide 440Hz -> 220Hz (one octave down) — that's the "whoosh down" feel.
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(220, now + 0.3);
      // Gentle envelope, slightly louder attack, exponential decay.
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.18, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.34);
    } catch (e) {
      // best-effort
    }
    return;
  }

  // Native: synthesize a 300ms 440→220 Hz sweep into a WAV buffer and play
  // via expo-audio (works under the LiveKit-owned playAndRecord session
  // because we use mixWithOthers / duckOthers below).
  (async () => {
    try {
      const { createAudioPlayer, AudioModule } = require('expo-audio');
      // Don't fight the in-call session for too long — duckOthers means the
      // brief tone plays at full volume but the call media keeps streaming.
      try {
        await AudioModule.setAudioMode({
          playsInSilentMode: true,
          interruptionMode: 'mixWithOthers',
          shouldPlayInBackground: true,
          allowsRecording: false,
        });
      } catch {}

      const sampleRate = 22050;
      const duration = 0.32;
      const samples = Math.floor(sampleRate * duration);
      const buffer = new ArrayBuffer(44 + samples * 2);
      const view = new DataView(buffer);
      const writeStr = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
      };
      writeStr(0, 'RIFF');
      view.setUint32(4, 36 + samples * 2, true);
      writeStr(8, 'WAVE');
      writeStr(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeStr(36, 'data');
      view.setUint32(40, samples * 2, true);

      // Exponential frequency sweep 440Hz -> 220Hz with phase accumulation
      // (avoid the discontinuity you'd get from snapping freq per-sample).
      let phase = 0;
      const f0 = 440;
      const f1 = 220;
      for (let i = 0; i < samples; i++) {
        const t = i / sampleRate;
        const norm = t / duration;
        // Exponential glide.
        const f = f0 * Math.pow(f1 / f0, norm);
        phase += (2 * Math.PI * f) / sampleRate;
        // Envelope: fast attack, exponential decay.
        let env;
        if (t < 0.03) env = t / 0.03;
        else env = Math.pow(0.001 / 1, (t - 0.03) / (duration - 0.03));
        const val = Math.sin(phase) * 0.45 * env;
        view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, val)) * 32767, true);
      }

      const base64 = arrayBufferToBase64(buffer);
      const dataUri = 'data:audio/wav;base64,' + base64;
      const player = createAudioPlayer({ uri: dataUri });
      try { player.volume = 1.0; } catch {}
      try { player.play(); } catch {}
      // Auto-cleanup after the tone duration.
      setTimeout(() => {
        try { player.pause(); } catch {}
        try { player.remove(); } catch {}
      }, 600);
    } catch (e) {
      // expo-audio not available → silent no-op
    }
  })();
}

export function stopRingtone() {
  ringtoneGeneration++; // Cancel any pending async player creation
  if (ringtoneInterval) {
    clearInterval(ringtoneInterval);
    ringtoneInterval = null;
  }
  if (ringtoneTimeout) {
    clearTimeout(ringtoneTimeout);
    ringtoneTimeout = null;
  }
  if (ringtoneSound) {
    try { ringtoneSound.pause(); ringtoneSound.remove(); } catch {}
    ringtoneSound = null;
  }
  if (callingSound) {
    try { callingSound.pause(); callingSound.remove(); } catch {}
    callingSound = null;
  }
  if (nativePlayer) {
    try {
      nativePlayer.pause();
      nativePlayer.remove();
    } catch {}
    nativePlayer = null;
    // Switch to doNotMix so the call audio session interrupts background music
    try {
      const { AudioModule } = require('expo-audio');
      AudioModule.setAudioMode({
        playsInSilentMode: true,
        interruptionMode: 'doNotMix',
        shouldPlayInBackground: true,
      });
    } catch {}
  }
  try { Vibration.cancel(); } catch {}
  // Configure iOS audio session for WebRTC call — DoNotMix interrupts Spotify/Apple Music
  if (Platform.OS === 'ios') {
    try {
      const { AudioModule } = require('expo-audio');
      AudioModule.setAudioMode({
        playsInSilentMode: true,
        interruptionMode: 'doNotMix',
        shouldPlayInBackground: true,
      });
    } catch (e) {}
  }
}
