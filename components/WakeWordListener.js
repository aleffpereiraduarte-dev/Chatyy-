/**
 * WakeWordListener — Passive "Ei Chatyy" wake word detector.
 *
 * Strategy:
 *  - Web:    Wraps the browser Web Speech API in continuous + interimResults mode.
 *            Scans every partial transcript for the wake phrase without sending
 *            audio to a server. Restarts automatically on end/error so it stays
 *            alive as long as the component is mounted.
 *  - Native: Uses expo-speech-recognition (iOS SFSpeechRecognizer / Android
 *            SpeechRecognizer) with continuous:true + interimResults:true.
 *            Same keyword scan on every partial result.  Auto-restarts on
 *            network/no-speech errors (non-fatal) with a 2-second back-off.
 *
 * Usage:
 *   import WakeWordListener from '../components/WakeWordListener';
 *   // Anywhere in the component tree (renders nothing visible):
 *   <WakeWordListener onWake={() => router.push('/one')} />
 *
 *   // Or disable it temporarily:
 *   <WakeWordListener enabled={isListening} onWake={handleWake} />
 *
 * IMPORTANT NOTES:
 *  1. This component requires a native build — expo-speech-recognition uses
 *     native modules (iOS SFSpeechRecognizer / Android SpeechRecognizer).
 *     OTA updates are fine once a build with the plugin exists.
 *  2. On iOS the user sees "Listening…" in the status bar while recognition
 *     is active.  Apple restricts background audio indefinitely — see
 *     VOICE_WAKE_WORD.md for guidance on foreground-service workarounds.
 *  3. On Android below API 31 (Android 12), continuous mode is not supported
 *     by expo-speech-recognition.  The component falls back to polling mode
 *     (stops + restarts every ANDROID_POLL_MS milliseconds).
 *  4. The Web Speech API requires a HTTPS origin or localhost.
 *     Chrome is the most reliable; Firefox has partial/no support.
 *  5. Battery impact is real — only mount this component when the user has
 *     explicitly enabled the wake word feature (guarded by a settings flag).
 *
 * Wake phrases detected (case-insensitive, partial match):
 *   "ei chatyy", "hey chatyy", "oi chatyy", "chatyy" (fallback)
 */

import React, { useEffect, useRef, useCallback } from 'react';
import { Platform } from 'react-native';

// --- Configuration -----------------------------------------------------------

const WAKE_PHRASES = ['ei chatyy', 'hey chatyy', 'oi chatyy'];
const WAKE_PHRASE_FALLBACK = 'chatyy'; // broadest fallback
const RECOGNITION_LANG = 'pt-BR';      // primary language; change to 'en-US' for English
const RESTART_DELAY_MS = 2000;         // delay before restarting after a non-fatal error
const ANDROID_POLL_MS = 8000;          // re-start interval for Android <12 (no continuous mode)
const COOLDOWN_MS = 3000;              // ignore further triggers for N ms after one fires

// Errors that are worth retrying (network blip, timeout, no-speech).
// Fatal errors (not-allowed, service-not-allowed) are NOT retried.
const RETRYABLE_ERRORS = new Set([
  'network', 'no-speech', 'speech-timeout', 'audio-capture', 'aborted', 'busy',
]);

// ----------------------------------------------------------------------------

function containsWakePhrase(text) {
  if (!text) return false;
  const lower = text.toLowerCase().trim();
  for (const phrase of WAKE_PHRASES) {
    if (lower.includes(phrase)) return true;
  }
  return lower.includes(WAKE_PHRASE_FALLBACK);
}

// ─── Web implementation ──────────────────────────────────────────────────────

function useWebWakeWord(onWake, enabled) {
  const recognitionRef = useRef(null);
  const activeRef = useRef(false);
  const cooldownRef = useRef(false);
  const restartTimerRef = useRef(null);

  const triggerWake = useCallback(() => {
    if (cooldownRef.current) return;
    cooldownRef.current = true;
    onWake?.();
    setTimeout(() => { cooldownRef.current = false; }, COOLDOWN_MS);
  }, [onWake]);

  const stop = useCallback(() => {
    activeRef.current = false;
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    try { recognitionRef.current?.abort(); } catch {}
    recognitionRef.current = null;
  }, []);

  const start = useCallback(() => {
    if (!enabled || activeRef.current) return;

    const SR = typeof window !== 'undefined' &&
      (window.SpeechRecognition || window.webkitSpeechRecognition);

    if (!SR) {
      console.warn('[WakeWordListener] Web Speech API not available in this browser.');
      return;
    }

    const recognition = new SR();
    recognitionRef.current = recognition;
    activeRef.current = true;

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = RECOGNITION_LANG;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (containsWakePhrase(transcript)) {
          triggerWake();
        }
      }
    };

    recognition.onerror = (event) => {
      // 'not-allowed' = user denied mic or origin not HTTPS → don't retry
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        console.warn('[WakeWordListener] Speech recognition permission denied:', event.error);
        activeRef.current = false;
        return;
      }
      // All other errors: schedule restart
      scheduleRestart();
    };

    recognition.onend = () => {
      // Auto-restarts are needed because browsers stop recognition after
      // a final result or a period of silence even with continuous:true.
      if (activeRef.current) scheduleRestart();
    };

    try {
      recognition.start();
    } catch (e) {
      // Already started (InvalidStateError) — safe to ignore
      if (e?.name !== 'InvalidStateError') {
        scheduleRestart();
      }
    }
  }, [enabled, triggerWake]); // eslint-disable-line react-hooks/exhaustive-deps

  function scheduleRestart() {
    if (!activeRef.current) return;
    restartTimerRef.current = setTimeout(() => {
      if (activeRef.current) {
        try { recognitionRef.current?.abort(); } catch {}
        recognitionRef.current = null;
        start();
      }
    }, RESTART_DELAY_MS);
  }

  useEffect(() => {
    if (enabled) {
      start();
    } else {
      stop();
    }
    return stop;
  }, [enabled, start, stop]);
}

// ─── Native implementation ───────────────────────────────────────────────────

function useNativeWakeWord(onWake, enabled) {
  const activeRef = useRef(false);
  const cooldownRef = useRef(false);
  const restartTimerRef = useRef(null);
  const pollTimerRef = useRef(null);

  // Lazily resolve expo-speech-recognition so the component doesn't crash if
  // the native module isn't linked yet (e.g. running in Expo Go).
  const getModule = useCallback(() => {
    try {
      return require('expo-speech-recognition');
    } catch {
      return null;
    }
  }, []);

  const triggerWake = useCallback(() => {
    if (cooldownRef.current) return;
    cooldownRef.current = true;
    onWake?.();
    setTimeout(() => { cooldownRef.current = false; }, COOLDOWN_MS);
  }, [onWake]);

  const stop = useCallback(() => {
    activeRef.current = false;
    clearTimeout(restartTimerRef.current);
    clearInterval(pollTimerRef.current);
    restartTimerRef.current = null;
    pollTimerRef.current = null;
    try {
      const mod = getModule();
      mod?.ExpoSpeechRecognitionModule?.abort();
    } catch {}
  }, [getModule]);

  const start = useCallback(async () => {
    if (!enabled || activeRef.current) return;
    const esrMod = getModule();
    if (!esrMod) {
      console.warn('[WakeWordListener] expo-speech-recognition not available.');
      return;
    }

    const { ExpoSpeechRecognitionModule } = esrMod;

    // Request permissions
    let perm;
    try {
      perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    } catch (e) {
      console.warn('[WakeWordListener] Permission request failed:', e);
      return;
    }
    if (!perm?.granted) {
      console.warn('[WakeWordListener] Speech recognition permission denied.');
      return;
    }

    activeRef.current = true;

    // On Android < 12, continuous mode is not supported — use polling instead.
    const useContinuous = Platform.OS === 'ios' || (Platform.OS === 'android' && Platform.Version >= 31);

    // Subscribe to result events
    const resultSub = ExpoSpeechRecognitionModule.addListener('result', (event) => {
      const results = event?.results ?? [];
      for (const r of results) {
        if (containsWakePhrase(r?.transcript)) {
          triggerWake();
        }
      }
    });

    // Subscribe to error events
    const errorSub = ExpoSpeechRecognitionModule.addListener('error', (event) => {
      const code = event?.error;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        console.warn('[WakeWordListener] Fatal error:', code);
        resultSub?.remove();
        errorSub?.remove();
        endSub?.remove();
        activeRef.current = false;
        return;
      }
      if (RETRYABLE_ERRORS.has(code)) {
        scheduleRestart();
      }
    });

    // Subscribe to end event for non-continuous mode restart
    const endSub = ExpoSpeechRecognitionModule.addListener('end', () => {
      if (!useContinuous && activeRef.current) {
        // Poll mode: restart immediately
        scheduleRestart();
      }
    });

    function scheduleRestart() {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = setTimeout(() => {
        resultSub?.remove();
        errorSub?.remove();
        endSub?.remove();
        if (activeRef.current) {
          activeRef.current = false; // reset so start() can proceed
          start();
        }
      }, RESTART_DELAY_MS);
    }

    try {
      ExpoSpeechRecognitionModule.start({
        lang: RECOGNITION_LANG,
        interimResults: true,
        continuous: useContinuous,
        requiresOnDeviceRecognition: false,
        // Hint the recognizer toward the wake phrase for better accuracy
        contextualStrings: ['Chatyy', 'ei Chatyy', 'hey Chatyy', 'oi Chatyy'],
      });
    } catch (e) {
      console.warn('[WakeWordListener] Failed to start recognition:', e);
      resultSub?.remove();
      errorSub?.remove();
      endSub?.remove();
      activeRef.current = false;
      scheduleRestart();
    }
  }, [enabled, getModule, triggerWake]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (enabled) {
      start();
    } else {
      stop();
    }
    return stop;
  }, [enabled, start, stop]);
}

// ─── Public component ─────────────────────────────────────────────────────────

/**
 * @param {object} props
 * @param {() => void} props.onWake  — Called when the wake phrase is detected.
 * @param {boolean}    [props.enabled=true]  — Set to false to suspend listening.
 */
export default function WakeWordListener({ onWake, enabled = true }) {
  // Both hooks are always called (Rules of Hooks) but only one branch is
  // actually active at runtime based on Platform.OS.
  const isWeb = Platform.OS === 'web';
  useWebWakeWord(isWeb ? onWake : null, isWeb && enabled);
  useNativeWakeWord(!isWeb ? onWake : null, !isWeb && enabled);

  // This component renders nothing — it is purely a side-effect hook.
  return null;
}
