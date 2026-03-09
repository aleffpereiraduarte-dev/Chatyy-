import { Platform, Vibration } from 'react-native';

let audioContext = null;
let ringtoneInterval = null;
let ringtoneSound = null;
let callingSound = null;
let ringtoneGeneration = 0; // Track generation to cancel async creation

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

  if (Platform.OS === 'web') {
    const ctx = getAudioContext();
    if (!ctx) return;
    // Play ring-ring...pause...ring-ring... (WhatsApp-like pattern)
    const playRingCycle = () => {
      playRingBurst(ctx);
      setTimeout(() => playRingBurst(ctx), 250);
    };
    playRingCycle();
    ringtoneInterval = setInterval(playRingCycle, 4000);
  } else {
    // Native: vibration only — do NOT use expo-audio here because it conflicts
    // with WebRTC's AVAudioSession (PlayAndRecord category) and kills call audio
    try {
      Vibration.vibrate([0, 800, 400, 800, 2000], true);
    } catch {}
  }
}

// Calling tone (what the CALLER hears) - gentle "tuuummm...tuuummm"
export function startCallingTone() {
  stopRingtone();

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
    // Native: no audio tone — avoid expo-audio which conflicts with WebRTC AVAudioSession
    // Just a gentle vibration pulse so the caller knows it's ringing
    try {
      Vibration.vibrate([0, 200, 3800], false);
      ringtoneInterval = setInterval(() => {
        try { Vibration.vibrate([0, 200, 3800], false); } catch {}
      }, 4000);
    } catch {}
  }
}

export function stopRingtone() {
  ringtoneGeneration++; // Cancel any pending async player creation
  if (ringtoneInterval) {
    clearInterval(ringtoneInterval);
    ringtoneInterval = null;
  }
  if (ringtoneSound) {
    try { ringtoneSound.pause(); ringtoneSound.remove(); } catch {}
    ringtoneSound = null;
  }
  if (callingSound) {
    try { callingSound.pause(); callingSound.remove(); } catch {}
    callingSound = null;
  }
  try { Vibration.cancel(); } catch {}
}
