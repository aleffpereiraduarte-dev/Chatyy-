import { Platform } from 'react-native';

let _haptics = null;
let _audioModule = null;

// Lazy load expo-haptics
async function getHaptics() {
  if (Platform.OS === 'web') return null;
  if (!_haptics) {
    try { _haptics = await import('expo-haptics'); } catch { return null; }
  }
  return _haptics;
}

// Lazy load expo-av for native sound playback
async function getAudio() {
  if (Platform.OS === 'web') return null;
  if (!_audioModule) {
    try { _audioModule = await import('expo-av'); } catch { return null; }
  }
  return _audioModule;
}

// ============================================================
// Web Audio API — synthesized notification tones
// ============================================================

// Shared: create an oscillator note with optional harmonics
function _webNote(ctx, now, freq, start, dur, vol, type = 'sine', harmonicRatio = 0.15) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol, now + start);
  gain.gain.exponentialRampToValueAtTime(0.001, now + start + dur);
  osc.start(now + start);
  osc.stop(now + start + dur + 0.05);

  // Subtle harmonic overtone for richness
  if (harmonicRatio > 0) {
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.type = 'sine';
    osc2.frequency.value = freq * 2;
    gain2.gain.setValueAtTime(vol * harmonicRatio, now + start);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + start + dur);
    osc2.start(now + start);
    osc2.stop(now + start + dur + 0.05);
  }
}

// Email: elegant 3-note ascending chime (C5 -> E5 -> G5)
function playWebEmailSound() {
  if (typeof window === 'undefined') return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    const notes = [
      { freq: 523.25, start: 0, dur: 0.18, vol: 0.11 },
      { freq: 659.25, start: 0.14, dur: 0.18, vol: 0.11 },
      { freq: 783.99, start: 0.28, dur: 0.28, vol: 0.09 },
    ];
    for (const n of notes) _webNote(ctx, now, n.freq, n.start, n.dur, n.vol, 'sine', 0.15);
  } catch {}
}

// Chat: quick 2-note pop (higher, friendlier — A5 -> C6)
function playWebChatSound() {
  if (typeof window === 'undefined') return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    const notes = [
      { freq: 880.00, start: 0, dur: 0.10, vol: 0.10 },
      { freq: 1046.50, start: 0.08, dur: 0.15, vol: 0.09 },
    ];
    for (const n of notes) _webNote(ctx, now, n.freq, n.start, n.dur, n.vol, 'sine', 0.12);
  } catch {}
}

// Meeting: warm 3-note descending bell (G5 -> E5 -> C5, triangle wave for warmth)
function playWebMeetingSound() {
  if (typeof window === 'undefined') return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    const notes = [
      { freq: 783.99, start: 0, dur: 0.22, vol: 0.10 },
      { freq: 659.25, start: 0.18, dur: 0.22, vol: 0.10 },
      { freq: 523.25, start: 0.36, dur: 0.35, vol: 0.08 },
    ];
    for (const n of notes) _webNote(ctx, now, n.freq, n.start, n.dur, n.vol, 'triangle', 0.08);
  } catch {}
}

// ============================================================
// Native sound playback via expo-av (system sounds)
// ============================================================

async function playNativeSound() {
  const av = await getAudio();
  if (!av) return;
  try {
    // Use expo-av to play a short system-compatible tone
    // We generate silence-based audio object and use system notification sound
    // On native, the actual sound is handled by the notification channel (sound: true)
    // This is a fallback for in-app foreground alerts
    const { Sound } = av.Audio;
    await av.Audio.setAudioModeAsync({
      playsInSilentModeIOS: false,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
    });
    // No bundled audio file — native foreground toasts use haptics instead
    // The system notification sound plays via expo-notifications channels
  } catch {}
}

// ============================================================
// Haptic feedback patterns per notification type
// ============================================================

export async function triggerHaptic(type = 'email') {
  const h = await getHaptics();
  if (!h) return;

  try {
    switch (type) {
      case 'chat':
        // Light, quick tap for chat
        await h.impactAsync(h.ImpactFeedbackStyle.Light);
        break;
      case 'meeting':
        // Medium impact for meeting reminders
        await h.impactAsync(h.ImpactFeedbackStyle.Medium);
        break;
      case 'email':
      default:
        // Success notification pattern for new email
        await h.notificationAsync(h.NotificationFeedbackType.Success);
        break;
    }
  } catch {}
}

// ============================================================
// Public API
// ============================================================

/**
 * Play notification sound based on notification type.
 * @param {'email' | 'chat' | 'meeting'} type
 */
export async function playNotificationSound(type = 'email') {
  if (Platform.OS === 'web') {
    switch (type) {
      case 'chat':
        playWebChatSound();
        break;
      case 'meeting':
        playWebMeetingSound();
        break;
      case 'email':
      default:
        playWebEmailSound();
        break;
    }
  }
  // On native, sound is handled by the notification system channels
  // (expo-notifications with sound: true + channelId with sound enabled)
}

// Vibrate device — works on both mobile (expo-haptics) and web (Vibration API)
export async function vibrateDevice(type = 'email') {
  if (Platform.OS === 'web') {
    // Use browser Vibration API (supported on Android Chrome, some desktop browsers)
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        switch (type) {
          case 'chat':
            navigator.vibrate([120, 60, 120]);
            break;
          case 'meeting':
            navigator.vibrate([200, 80, 200, 80, 200]);
            break;
          case 'email':
          default:
            navigator.vibrate([200, 100, 200]);
            break;
        }
      }
    } catch {}
    return;
  }
  // On native, use expo-haptics with type-specific feedback
  await triggerHaptic(type);
}

/**
 * Play the appropriate sound + vibration for a toast notification.
 * Called from NotificationToast and MailContext.
 * @param {object} settings - User notification preferences
 * @param {'email' | 'chat' | 'meeting'} type - Notification type
 */
export async function playNotificationAlert(settings = {}, type = 'email') {
  const soundEnabled = settings.notification_sound !== false;
  const vibrationEnabled = settings.notification_vibration !== false;

  const promises = [];
  if (soundEnabled) promises.push(playNotificationSound(type));
  if (vibrationEnabled) promises.push(vibrateDevice(type));

  await Promise.allSettled(promises);
}

// Backward-compatible alias — used by MailContext
export async function playNewEmailAlert(settings = {}) {
  return playNotificationAlert(settings, 'email');
}
