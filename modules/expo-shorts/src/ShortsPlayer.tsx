// <ShortsPlayer /> — React Native wrapper around the native ExpoShortsPlayer view.
//
// Stage 2 (2026-05-16): native side is now real — ExoPlayer (Android) +
// AVPlayer (iOS) loaned from a 3-slot pool. The JS surface is unchanged
// from Stage 1 so callers don't have to update.
//
// New in Stage 2:
//   - `prefetch(id, url)` static helper attached to the component for the
//     "warm the next reel" idiom used by ReelsViewer once it swaps to
//     this native view.

import * as React from 'react';
import { NativeSyntheticEvent, StyleSheet, ViewProps } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';
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
}

// Native event payload shapes — must match the keys emitted from the
// Kotlin/Swift sides.
type ReadyEvent = NativeSyntheticEvent<Record<string, never>>;
type BufferingEvent = NativeSyntheticEvent<{ progress: number }>;
type ErrorEvent = NativeSyntheticEvent<{ message: string }>;

interface NativeViewProps extends Omit<ShortsPlayerProps, 'onPlaybackReady' | 'onBuffering' | 'onError'> {
  onPlaybackReady?: (event: ReadyEvent) => void;
  onBuffering?: (event: BufferingEvent) => void;
  onError?: (event: ErrorEvent) => void;
}

const NativeView: React.ComponentType<NativeViewProps> =
  requireNativeViewManager('ExpoShortsPlayer');

interface ShortsPlayerComponent extends React.FC<ShortsPlayerProps> {
  /** Warm the player pool with `url` so the upcoming swipe is instant. */
  prefetch: (id: string, url: string) => Promise<void>;
  /** Drain the 3-slot player pool. Call on Reels unmount / memory warning. */
  releasePool: () => Promise<void>;
}

const ShortsPlayer: ShortsPlayerComponent = (({
  style,
  onPlaybackReady,
  onBuffering,
  onError,
  ...rest
}) => {
  return (
    <NativeView
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
    />
  );
}) as ShortsPlayerComponent;

ShortsPlayer.prefetch = prefetchShortsVideo;
ShortsPlayer.releasePool = releaseShortsPool;

const styles = StyleSheet.create({
  fill: {
    width: '100%',
    height: '100%',
  },
});

export default ShortsPlayer;
