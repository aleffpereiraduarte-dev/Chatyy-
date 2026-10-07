import { requireNativeModule } from 'expo';
import { Platform } from 'react-native';

declare class AudioClass {
  /** Start recording to a file. Returns the file path. */
  startRecording(filePath?: string, sampleHz?: number): Promise<string>;
  /** Stop recording. Returns { path, durationMs, samples, sizeBytes? } (Android also adds sizeBytes/uri). */
  stopRecording(): Promise<{ path: string; durationMs: number; samples: number[]; sizeBytes?: number; uri?: string }>;
  /** Cancel recording without saving. */
  cancelRecording(): Promise<void>;
  /** Pause recording (Android 7+ and iOS). */
  pauseRecording?(): Promise<void>;
  /** Resume a paused recording. */
  resumeRecording?(): Promise<void>;
  /** Get current recording level (0..1) for waveform. */
  currentLevelSync(): number;
  /** Synchronous raw amplitude (Android exposes MediaRecorder.maxAmplitude; iOS approximates). */
  getAmplitude?(): number;
  /** Get current recording duration in ms. */
  currentDurationMsSync(): number;
  /** Play an audio file. Pauses any currently playing one. */
  playFile(fileUrl: string): Promise<void>;
  /** Play an audio file and get a handle id back (Android emits onComplete with the id). */
  playAudio?(uri: string): Promise<number>;
  /** Stop playback for a specific handle (Android). */
  stopAudio?(id: number): Promise<void>;
  /** Pause playback. */
  pausePlayback(): Promise<void>;
  /** Stop playback. */
  stopPlayback(): Promise<void>;
  /** Set playback rate (0.5x to 2x). */
  setPlaybackRate(rate: number): Promise<void>;
  /** True if currently playing audio. */
  isPlayingSync(): boolean;
  // ── [2026-10-07 voice-native] Voice-note player (binaries built after
  // 2026-10-07; JS feature-detects `voicePlay` — see services/voiceNotePlayer.js).
  /** Play a voice note (file://, content:// or https). `token` is echoed in events. */
  voicePlay?(uri: string, startMs: number, rate: number, token: number): Promise<void>;
  voicePause?(): Promise<void>;
  voiceResume?(): Promise<void>;
  voiceSeek?(ms: number): Promise<void>;
  voiceSetRate?(rate: number): Promise<void>;
  /** Stop + release session/route/proximity. */
  voiceStop?(): Promise<void>;
  /** Raise-to-ear: proximity → earpiece + screen off while playing. */
  voiceSetProximityEnabled?(enabled: boolean): Promise<void>;
  voiceGetStatus?(): Promise<{ token: number; positionMs: number; durationMs: number; playing: boolean; earpiece: boolean }>;
  /** Subscribe to events (Android emits onLevel/onComplete/onError; both emit onVoiceStatus/onVoiceProximity). */
  addListener?(eventName: 'onLevel' | 'onComplete' | 'onError' | 'onVoiceStatus' | 'onVoiceProximity', listener: (e: any) => void): { remove: () => void };
}

// The native module is shipped on both iOS and Android. requireNativeModule
// throws on platforms where it isn't registered (e.g. web), so we guard the
// load and export `null` so callers can fall back to expo-audio.
const Audio: AudioClass | null = (() => {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    return requireNativeModule<AudioClass>('ExpoNativeAudio');
  } catch {
    return null;
  }
})();

export default Audio as AudioClass;
