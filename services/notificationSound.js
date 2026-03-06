import { Platform } from 'react-native';

let _haptics = null;

// Lazy load expo-haptics
async function getHaptics() {
  if (Platform.OS === 'web') return null;
  if (!_haptics) {
    try { _haptics = await import('expo-haptics'); } catch { return null; }
  }
  return _haptics;
}

// Play notification sound — mobile relies on native notification sound (sound: true),
// web uses AudioContext chime
export async function playNotificationSound() {
  if (Platform.OS === 'web') {
    playWebSound();
  }
  // On mobile, sound is handled by the native notification system
  // (expo-notifications with sound: true + channelId with sound enabled)
}

// Web: generate pleasant notification chime via AudioContext
function playWebSound() {
  if (typeof window === 'undefined') return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;

    // 3-note chime: C5 -> E5 -> G5
    const notes = [
      { freq: 523.25, start: 0, dur: 0.18, vol: 0.12 },
      { freq: 659.25, start: 0.15, dur: 0.18, vol: 0.12 },
      { freq: 783.99, start: 0.30, dur: 0.25, vol: 0.10 },
    ];

    for (const { freq, start, dur, vol } of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(vol, now + start);
      gain.gain.exponentialRampToValueAtTime(0.001, now + start + dur);
      osc.start(now + start);
      osc.stop(now + start + dur);

      // Subtle harmonic
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.type = 'sine';
      osc2.frequency.value = freq * 2;
      gain2.gain.setValueAtTime(vol * 0.15, now + start);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + start + dur);
      osc2.start(now + start);
      osc2.stop(now + start + dur);
    }
  } catch {}
}

// Vibrate device — works on both mobile (expo-haptics) and web (Vibration API)
export async function vibrateDevice() {
  if (Platform.OS === 'web') {
    // Use browser Vibration API (supported on Android Chrome, some desktop browsers)
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate([200, 100, 200]);
      }
    } catch {}
    return;
  }
  const h = await getHaptics();
  if (h) {
    try {
      await h.notificationAsync(h.NotificationFeedbackType.Success);
    } catch {}
  }
}

// Combined: play sound + vibrate based on settings
export async function playNewEmailAlert(settings = {}) {
  const soundEnabled = settings.notification_sound !== false;
  const vibrationEnabled = settings.notification_vibration !== false;

  const promises = [];
  if (soundEnabled) promises.push(playNotificationSound());
  if (vibrationEnabled) promises.push(vibrateDevice());

  await Promise.allSettled(promises);
}
