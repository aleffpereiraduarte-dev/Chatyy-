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
  /** Subscribe to events (Android emits onLevel/onComplete/onError). */
  addListener?(eventName: 'onLevel' | 'onComplete' | 'onError', listener: (e: any) => void): { remove: () => void };
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
