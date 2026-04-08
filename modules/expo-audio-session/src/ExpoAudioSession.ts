import { requireNativeModule } from 'expo';

declare class ExpoAudioSessionClass {
  /**
   * Activate the audio session for a voice call.
   * Category: .playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker]
   */
  activateForCall(useSpeaker: boolean): Promise<boolean>;

  /**
   * Activate the audio session for a video call.
   * Category: .playAndRecord, mode: .videoChat, options: [.allowBluetooth, .defaultToSpeaker]
   */
  activateForVideoCall(): Promise<boolean>;

  /**
   * Switch between speaker and earpiece during an active call.
   */
  setSpeaker(enabled: boolean): Promise<void>;

  /**
   * Properly tear down the audio session at the end of a call.
   * Sends notifyOthersOnDeactivation so Spotify/Music resume playback.
   */
  deactivate(): Promise<void>;

  /**
   * Activate ringtone playback (mode: .default, category: .ambient — respects mute switch).
   */
  activateForRingtone(): Promise<void>;

  /**
   * Get current category + mode for debugging.
   */
  getCurrentCategory(): string;
}

export default requireNativeModule<ExpoAudioSessionClass>('ExpoAudioSession');
