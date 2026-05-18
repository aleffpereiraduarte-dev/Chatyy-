// <ShortsPlayer /> — React Native wrapper around the native ExpoShortsPlayer view.
//
// Stage 2 (2026-05-16): native side is now real — ExoPlayer (Android) +
// AVPlayer (iOS) loaned from a 3-slot pool. The JS surface is unchanged
// from Stage 1 so callers don't have to update.
//
// Stage 3 (2026-05-18):
//   - `onTime` event (~8fps) replaces the WebView postMessage scrubber tick.
//   - Imperative `seek(ms)` exposed via ref so the scrubber can drive the
//     bound native player without a round-trip.
//
// Statics:
//   - `ShortsPlayer.prefetch(id, url)` — pool warm-up (same as Stage 2).
//   - `ShortsPlayer.releasePool()` — pool drain.

import * as React from 'react';
import { NativeSyntheticEvent, StyleSheet, ViewProps, findNodeHandle, UIManager } from 'react-native';
import { requireNativeViewManager, requireNativeModule } from 'expo-modules-core';
import { prefetchShortsVideo, releaseShortsPool } from './index';

export interface ShortsPlayerProps extends ViewProps {
  /** Remote HLS / progressive MP4 URL. Routed to ExoPlayer / AVPlayer. */
  videoUrl: string;
  /**
   * When true and the view is the focused page of the parent pager, playback
   * runs. Flipping to false pauses without tearing down the player so the
   * next focus resumes instantly.
   */
  playWhenInFocus: boolean;
  /** Mute toggle. Honoured by both platforms. Defaults to muted in native. */
  muted: boolean;
  /** 1.0 default; 1.25 / 1.5 / 2.0 for power-user fast playback. */
  playbackRate?: number;
  /** Fired when the player has decoded enough to paint the first frame. */
  onPlaybackReady?: () => void;
  /** Buffering progress 0..1 — for the thin progress bar atop the bubble. */
  onBuffering?: (progress: number) => void;
  /** Decoder/network error surfaced from native. */
  onError?: (msg: string) => void;
  /** Periodic playhead update (~8fps) for the scrubber. Both ms. */
  onTime?: (ms: number, durMs: number) => void;
}

// Native event payload shapes — must match the keys emitted from the
// Kotlin/Swift sides.
type ReadyEvent = NativeSyntheticEvent<Record<string, never>>;
type BufferingEvent = NativeSyntheticEvent<{ progress: number }>;
type ErrorEvent = NativeSyntheticEvent<{ message: string }>;
type TimeEvent = NativeSyntheticEvent<{ ms: number; dur: number }>;

interface NativeViewProps extends Omit<ShortsPlayerProps, 'onPlaybackReady' | 'onBuffering' | 'onError' | 'onTime'> {
  onPlaybackReady?: (event: ReadyEvent) => void;
  onBuffering?: (event: BufferingEvent) => void;
  onError?: (event: ErrorEvent) => void;
  onTime?: (event: TimeEvent) => void;
}

const NativeView: React.ComponentType<NativeViewProps & { ref?: React.Ref<any> }> =
  requireNativeViewManager('ExpoShortsPlayer');

export interface ShortsPlayerHandle {
  /** Seek the bound native player to [ms]. */
  seek: (ms: number) => Promise<void>;
}

interface ShortsPlayerComponent extends React.ForwardRefExoticComponent<
  ShortsPlayerProps & React.RefAttributes<ShortsPlayerHandle>
> {
  /** Warm the player pool with `url` so the upcoming swipe is instant. */
  prefetch: (id: string, url: string) => Promise<void>;
  /** Drain the 3-slot player pool. Call on Reels unmount / memory warning. */
  releasePool: () => Promise<void>;
}

// Lazy-load the native module so a missing native binary in dev doesn't
// blow up the JS bundle at import time.
let _module: any = null;
function getModule(): any {
  if (_module) return _module;
  try {
    _module = requireNativeModule('ExpoShorts');
  } catch {
    _module = null;
  }
  return _module;
}

const ShortsPlayerImpl = React.forwardRef<ShortsPlayerHandle, ShortsPlayerProps>(({
  style,
  onPlaybackReady,
  onBuffering,
  onError,
  onTime,
  ...rest
}, ref) => {
  const nativeRef = React.useRef<any>(null);

  React.useImperativeHandle(ref, () => ({
    seek: async (ms: number) => {
      const node = findNodeHandle(nativeRef.current);
      if (node == null) return;
      const mod = getModule();
      if (!mod || typeof mod.seek !== 'function') {
        // Fallback: UIManager dispatch (covers older Expo Modules builds).
        try {
          const cmd = (UIManager as any).getViewManagerConfig?.('ExpoShortsPlayer')?.Commands?.seek;
          if (cmd != null) {
            (UIManager as any).dispatchViewManagerCommand(node, cmd, [ms]);
          }
        } catch {}
        return;
      }
      try {
        await mod.seek(node, ms);
      } catch (e) {
        if (__DEV__) console.warn('[ShortsPlayer] seek error:', e);
      }
    },
  }), []);

  return (
    <NativeView
      ref={nativeRef}
      style={[styles.fill, style]}
      {...rest}
      onPlaybackReady={onPlaybackReady ? () => onPlaybackReady() : undefined}
      onBuffering={
        onBuffering
          ? (e: BufferingEvent) => onBuffering(e.nativeEvent.progress)
          : undefined
      }
      onError={
        onError ? (e: ErrorEvent) => onError(e.nativeEvent.message) : undefined
      }
      onTime={
        onTime
          ? (e: TimeEvent) => onTime(Number(e.nativeEvent.ms) || 0, Number(e.nativeEvent.dur) || 0)
          : undefined
      }
    />
  );
});

const ShortsPlayer = ShortsPlayerImpl as unknown as ShortsPlayerComponent;
ShortsPlayer.prefetch = prefetchShortsVideo;
ShortsPlayer.releasePool = releaseShortsPool;

const styles = StyleSheet.create({
  fill: {
    width: '100%',
    height: '100%',
  },
});

export default ShortsPlayer;
