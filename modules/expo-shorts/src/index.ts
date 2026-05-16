// expo-shorts — Native Shorts/Reels player.
//
// Stage 2 (2026-05-16): ExoPlayer (Android) + AVPlayer (iOS) live behind the
// <ShortsPlayer> view. prefetchShortsVideo now warms the player pool.
// releasePool tears the whole pool down when the Reels feed unmounts.
//
// Lazy module lookup keeps JS safe if the native side fails to link in dev.

import { requireNativeModule } from 'expo-modules-core';

export { default as ShortsPlayer } from './ShortsPlayer';
export type { ShortsPlayerProps } from './ShortsPlayer';

interface ExpoShortsModuleType {
  prefetchShortsVideo(id: string, url: string): Promise<void>;
  releasePool(): Promise<void>;
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
