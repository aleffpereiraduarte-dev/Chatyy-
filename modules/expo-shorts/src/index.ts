// expo-shorts — Native Shorts/Reels player.
//
// Stage 2 (2026-05-16): ExoPlayer (Android) + AVPlayer (iOS) live behind the
// <ShortsPlayer> view. prefetchShortsVideo now warms the player pool.
// releasePool tears the whole pool down when the Reels feed unmounts.
//
// Stage 3 (2026-05-18): added seek, onTime event + AVAudioSession helpers so
// ReelsViewer can drop the WebView/HTML5 path on native.
//
// Lazy module lookup keeps JS safe if the native side fails to link in dev.

import { requireNativeModule } from 'expo-modules-core';

export { default as ShortsPlayer } from './ShortsPlayer';
export type { ShortsPlayerProps } from './ShortsPlayer';

interface ExpoShortsModuleType {
  prefetchShortsVideo(id: string, url: string): Promise<void>;
  releasePool(): Promise<void>;
  setAudioSessionPlayback(): Promise<void>;
  restoreAudioSession(): Promise<void>;
}

let mod: ExpoShortsModuleType | null = null;

function getModule(): ExpoShortsModuleType | null {
  if (mod) return mod;
  try {
    mod = requireNativeModule<ExpoShortsModuleType>('ExpoShorts');
    return mod;
  } catch {
    return null;
  }
}

/**
 * Stage 2: warms the underlying player pool by binding the URL to a free
 * ExoPlayer / AVPlayer slot and starting prepare()/replaceCurrentItem.
 * Call for the next + previous reel in the feed on focus change so the
 * swipe is instant.
 */
export async function prefetchShortsVideo(id: string, url: string): Promise<void> {
  const m = getModule();
  if (!m) return;
  try {
    await m.prefetchShortsVideo(id, url);
  } catch (e) {
    console.warn('[ExpoShorts] prefetchShortsVideo error:', e);
  }
}

/**
 * Tears down the 3-player pool. Call when the user navigates away from the
 * Reels feed or on memory warning. Pool re-creates lazily on the next
 * <ShortsPlayer videoUrl=...> mount.
 */
export async function releaseShortsPool(): Promise<void> {
  const m = getModule();
  if (!m) return;
  try {
    await m.releasePool();
  } catch (e) {
    console.warn('[ExpoShorts] releasePool error:', e);
  }
}

/**
 * iOS: switch AVAudioSession to .playback so the reel audio keeps going on
 * the lock screen / when the user backgrounds the app (TikTok parity).
 * Android: no-op — ExoPlayer already owns audio focus by default.
 * Idempotent; ReelsViewer should call it once on mount.
 */
export async function setShortsAudioSessionPlayback(): Promise<void> {
  const m = getModule();
  if (!m) return;
  try {
    await m.setAudioSessionPlayback();
  } catch (e) {
    console.warn('[ExpoShorts] setAudioSessionPlayback error:', e);
  }
}

/**
 * Roll the AVAudioSession back to whatever was active before Reels mounted.
 * Call on unmount so other features (call, voice notes) own audio routing
 * the way they expect.
 */
export async function restoreShortsAudioSession(): Promise<void> {
  const m = getModule();
  if (!m) return;
  try {
    await m.restoreAudioSession();
  } catch (e) {
    console.warn('[ExpoShorts] restoreAudioSession error:', e);
  }
}
