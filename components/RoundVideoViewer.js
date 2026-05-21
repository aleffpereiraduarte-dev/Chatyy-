// RoundVideoViewer.js — WhatsApp-style circular video note viewer modal.
//
// Appears when the user taps a video_note bubble in the chat. Keeps the
// circular shape — no rectangular fullscreen. Shows a play/pause overlay,
// tap-to-unmute with a visible mute indicator, and a close button.
//
// Layout:
//   • Circular clip: 320×320 (unmuted, looping, tap to pause/play)
//   • Bottom-left: mute/unmute icon overlay (SVG, never emoji)
//   • Top-right: close (X) button
//   • Dark scrim behind the circle so it feels like a modal

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Modal,
  View,
  TouchableOpacity,
  TouchableWithoutFeedback,
  StyleSheet,
  Platform,
  Text,
  StatusBar,
} from 'react-native';

// SVG icons — reuse app's Icons.js (never emoji)
import { IconX, IconVolume2, IconVolumeX, IconPlay, IconPause } from './Icons';

const SIZE = 320;
const RADIUS = SIZE / 2;

let _expoVideo = null;
function loadExpoVideo() {
  if (_expoVideo !== null) return _expoVideo;
  try { _expoVideo = require('expo-video'); } catch { _expoVideo = false; }
  return _expoVideo;
}

// ── Inner player (extracted so hooks stay unconditional) ──────────────────
function CircularPlayer({ uri, paused, muted, onReady }) {
  const ev = loadExpoVideo();
  if (!ev?.useVideoPlayer || !ev?.VideoView) {
    return (
      <View style={styles.fallback}>
        <IconPlay size={36} color="#fff" />
        <Text style={styles.fallbackText}>expo-video not available</Text>
      </View>
    );
  }

  const { useVideoPlayer, VideoView } = ev;

  const player = useVideoPlayer(uri, (p) => {
    try {
      p.muted = muted;
      p.loop = true;
      const r = p.play?.();
      if (r?.catch) r.catch(() => {});
    } catch {}
  });

  // Sync muted state
  useEffect(() => {
    if (!player) return;
    try { player.muted = muted; } catch {}
  }, [muted, player]);

  // Sync play/pause state
  useEffect(() => {
    if (!player) return;
    try {
      if (paused) {
        player.pause?.();
      } else {
        const r = player.play?.();
        if (r?.catch) r.catch(() => {});
      }
    } catch {}
  }, [paused, player]);

  // Signal ready after brief delay (expo-video has no clean onReady)
  useEffect(() => {
    const id = setTimeout(() => onReady?.(), 200);
    return () => clearTimeout(id);
  }, [onReady]);

  return (
    <VideoView
      player={player}
      style={styles.videoFill}
      contentFit="cover"
      nativeControls={false}
      allowsFullscreen={false}
    />
  );
}

// ── Main component ────────────────────────────────────────────────────────
export default function RoundVideoViewer({ visible, uri, onClose }) {
  const [muted, setMuted] = useState(true);  // start muted (tap to unmute)
  const [paused, setPaused] = useState(false);
  const [ready, setReady] = useState(false);

  // Reset state when the modal opens with a new URI
  useEffect(() => {
    if (visible) {
      setMuted(true);
      setPaused(false);
      setReady(false);
    }
  }, [visible, uri]);

  const handleReady = useCallback(() => setReady(true), []);

  const handleTogglePause = useCallback(() => {
    setPaused(p => !p);
  }, []);

  const handleToggleMute = useCallback(() => {
    setMuted(m => !m);
  }, []);

  if (!visible || !uri) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      {Platform.OS === 'android' && <StatusBar backgroundColor="rgba(0,0,0,0.85)" barStyle="light-content" />}

      {/* Dark scrim — tap outside closes */}
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.scrim} />
      </TouchableWithoutFeedback>

      {/* Centered column: close button above + circle below */}
      <View style={styles.centeredWrap} pointerEvents="box-none">
        {/* Close button row — sits above the circle */}
        <View style={styles.closeRow} pointerEvents="box-none">
          <TouchableOpacity
            onPress={onClose}
            accessibilityLabel="Fechar"
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <View style={styles.closeBtnInner}>
              <IconX size={18} color="#fff" />
            </View>
          </TouchableOpacity>
        </View>

        {/* The circular video container */}
        <View style={styles.circle}>
          {/* Video player */}
          <CircularPlayer
            uri={uri}
            paused={paused}
            muted={muted}
            onReady={handleReady}
          />

          {/* Tap overlay for play/pause */}
          <TouchableOpacity
            activeOpacity={1}
            onPress={handleTogglePause}
            style={styles.tapOverlay}
          />

          {/* Pause indicator */}
          {paused && (
            <View pointerEvents="none" style={styles.centerIcon}>
              <IconPause size={40} color="#fff" />
            </View>
          )}

          {/* Mute button — bottom-left */}
          <TouchableOpacity
            onPress={handleToggleMute}
            style={styles.muteBtn}
            accessibilityLabel={muted ? 'Unmute video' : 'Mute video'}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            {muted
              ? <IconVolumeX size={18} color="#fff" />
              : <IconVolume2 size={18} color="#fff" />
            }
          </TouchableOpacity>

          {/* Muted hint — visible until user taps mute button */}
          {ready && muted && (
            <View pointerEvents="none" style={styles.muteHint}>
              <IconVolumeX size={12} color="#fff" />
              <Text style={styles.muteHintText}>Som desativado</Text>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.85)',
  },
  centeredWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'column',
    gap: 12,
  },
  closeRow: {
    width: SIZE,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingRight: 4,
  },
  circle: {
    width: SIZE,
    height: SIZE,
    borderRadius: RADIUS,
    overflow: 'hidden',
    backgroundColor: '#000',
    position: 'relative',
  },
  videoFill: {
    width: SIZE,
    height: SIZE,
  },
  tapOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'transparent',
  },
  centerIcon: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  muteBtn: {
    position: 'absolute',
    bottom: 16,
    left: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  muteHint: {
    position: 'absolute',
    bottom: 16,
    left: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
  },
  muteHintText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
  closeBtnInner: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111',
  },
  fallbackText: {
    color: '#aaa',
    fontSize: 12,
    marginTop: 8,
  },
});
