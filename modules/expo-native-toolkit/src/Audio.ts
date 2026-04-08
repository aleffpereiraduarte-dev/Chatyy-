import { requireNativeModule } from 'expo';

declare class AudioClass {
  /** Start recording to a file. Returns the file path. */
  startRecording(): Promise<string>;
  /** Stop recording. Returns { path, durationMs, samples }. */
  stopRecording(): Promise<{ path: string; durationMs: number; samples: number[] }>;
  /** Cancel recording without saving. */
  cancelRecording(): Promise<void>;
  /** Get current recording level (0..1) for waveform. */
  currentLevelSync(): number;
  /** Get current recording duration in ms. */
  currentDurationMsSync(): number;
  /** Play an audio file. Pauses any currently playing one. */
  playFile(fileUrl: string): Promise<void>;
  /** Pause playback. */
  pausePlayback(): Promise<void>;
  /** Stop playback. */
  stopPlayback(): Promise<void>;
  /** Set playback rate (0.5x to 2x). */
  setPlaybackRate(rate: number): Promise<void>;
  /** True if currently playing audio. */
  isPlayingSync(): boolean;
}

export default requireNativeModule<AudioClass>('ExpoNativeAudio');
