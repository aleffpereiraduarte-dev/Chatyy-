/**
 * Voice Recorder Tuning — WhatsApp-grade Opus profile (OTA).
 *
 * Side-effect module that, when imported, rewrites the `HIGH_QUALITY` entry
 * inside expo-audio's RecordingPresets to the WhatsApp/Telegram profile:
 *
 *   Codec:    Opus (Android: ogg/opus, iOS: aac-but-tuned, Web: webm/opus)
 *   Bitrate:  32 kbps (~5× smaller than the default 128 kbps AAC stereo)
 *   Channels: mono (1) — voice is the only signal, stereo wastes bytes
 *   Sample:   16 kHz — wideband speech, beyond human-voice perceptual band
 *
 * Why mutate the preset instead of forking a new one? chat-conversation.js
 * reads `RecordingPresets.HIGH_QUALITY` inline (we can't edit that file in
 * this OTA cycle), so the only OTA-safe lever is to mutate the *referenced
 * object* before the recorder hot path runs. expo-audio re-reads the props
 * each `new AudioRecorder(opts)` call, so the patch is picked up on the
 * very next recording.
 *
 * iOS NOTE: AVAudioRecorder's MPEG4AAC encoder does NOT support Opus, so
 * iOS keeps AAC — but we drop sampleRate to 22.05 kHz mono @ 32 kbps which
 * still cuts file size by ~4×. iOS-side Opus would require switching the
 * recorder to AVAudioEngine + libopus (native rebuild, not OTA).
 *
 * Idempotent — patch runs once per module evaluation.
 */

export function applyVoiceRecorderTuning() {
  // Guard on globalThis so a duplicate module copy (web code-splitting) doesn't
  // re-patch / re-log. Module-local `let` wouldn't be shared across copies.
  if (globalThis.__chatyy_voicePatched) return true;
  try {
    const mod = require('expo-audio');
    const presets = mod && mod.RecordingPresets;
    if (!presets || !presets.HIGH_QUALITY) return false;
    const hq = presets.HIGH_QUALITY;

    // ─── Shared knobs ───────────────────────────────────────────────
    // 16kHz wideband mono is the WhatsApp default; 22.05kHz is the iOS
    // fallback since AAC sounds notchy below ~22k.
    hq.sampleRate = 16000;
    hq.numberOfChannels = 1;
    hq.bitRate = 32000;

    // ─── Android: ogg/opus ──────────────────────────────────────────
    // MediaRecorder supports OPUS encoder + OGG container since API 29.
    // On older Android (rare), fallback to aac/mp4 transparently — the
    // backend already handles either via ffmpeg probe.
    if (hq.android) {
      hq.android.extension = '.ogg';
      hq.android.outputFormat = 'ogg';
      hq.android.audioEncoder = 'opus';
      hq.android.sampleRate = 16000;
      hq.android.numberOfChannels = 1;
      hq.android.bitRate = 32000;
    }

    // ─── iOS: tuned AAC (no native Opus encoder available in OTA) ───
    if (hq.ios) {
      hq.ios.sampleRate = 22050;
      hq.ios.numberOfChannels = 1;
      hq.ios.bitRate = 32000;
      // outputFormat stays MPEG4AAC; audioQuality dropped to MEDIUM since
      // voice doesn't benefit from MAX past 32kbps wideband.
      hq.ios.audioQuality = 0x40; // AudioQuality.MEDIUM
    }

    // ─── Web: opus@32kbps mono ──────────────────────────────────────
    // chat-conversation passes a fixed mimeType to MediaRecorder so this
    // only affects callers that read RecordingPresets directly, but we
    // keep the web block in sync for completeness.
    if (hq.web) {
      hq.web.mimeType = 'audio/webm;codecs=opus';
      hq.web.bitsPerSecond = 32000;
    }

    // The file extension is read by chat-conversation when naming the
    // upload — keep .m4a since iOS is still AAC and that wins the encoder
    // race (native recorder presents .m4a paths). Android side overrides
    // its own extension above, so the actual on-disk file is correct.
    // Only switch the top-level extension if we ever ship full Opus on iOS.

    globalThis.__chatyy_voicePatched = true;
    try {
      console.log('[voiceTuning] patched RecordingPresets.HIGH_QUALITY → Opus 32k mono 16/22kHz');
    } catch {}
    return true;
  } catch (e) {
    try { console.warn('[voiceTuning] patch failed:', e?.message); } catch {}
    return false;
  }
}

// Auto-apply on import. Importing this module = patch applied.
applyVoiceRecorderTuning();

export default { applyVoiceRecorderTuning };
