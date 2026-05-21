// components/CallVideoStats.js — In-call stats peek + low-fps warning banner.
//
// Created 2026-05-18 alongside services/videoCallTuning.js. Two purposes:
//
// 1. <CallVideoStats /> — Tiny dev/debug overlay showing FPS (received & sent),
//    bitrate, RTT, and packet loss. Hidden by default; opens via a long-press
//    on the signal-bars area (wired in call.js). Useful for QA + power users.
//
// 2. <PoorConnectionWarning /> — User-facing toast that surfaces "Conexão fraca"
//    when received fps drops below 15 OR the adaptive loop pins us to the
//    "very_poor" bucket. Auto-dismisses after 3s of recovered stats.
//
// Both components are presentation-only — they read state passed in as props
// from call.js. The adaptive loop in services/videoCallTuning.js owns the
// actual bucket math and persistence; this file just paints it.

import React, { useEffect, useState, useRef } from 'react';
import { View, Text, StyleSheet, Animated, TouchableOpacity } from 'react-native';
import Svg, { Path as SvgPath, Circle as SvgCircle } from 'react-native-svg';

// ─── Color tokens (matches the rest of /call.js) ──────────────────────────────
const COLORS = {
  good: '#22c55e',     // green-500
  warn: '#f59e0b',     // amber-500
  bad: '#ef4444',      // red-500
  bg: 'rgba(0, 0, 0, 0.55)',
  text: '#ffffff',
  textDim: 'rgba(255, 255, 255, 0.7)',
};

// Map a bucket → status color for the stats card border.
function bucketColor(bucket) {
  if (bucket === 'excellent' || bucket === 'good') return COLORS.good;
  if (bucket === 'poor') return COLORS.warn;
  return COLORS.bad;
}

function formatBitrate(kbps) {
  if (!kbps || kbps < 1) return '— kbps';
  if (kbps >= 1000) return (kbps / 1000).toFixed(1) + ' Mbps';
  return Math.round(kbps) + ' kbps';
}

// ─── <CallVideoStats /> ───────────────────────────────────────────────────────
// Props:
//   • visible (bool) — caller decides when to mount this
//   • snapshot — { fps, sentFps, bitrateKbps, rttMs, lossPct, bucket, frameW, frameH }
//   • onClose — tap dismiss
export default function CallVideoStats({ visible, snapshot, onClose, style }) {
  if (!visible || !snapshot) return null;
  const color = bucketColor(snapshot.bucket);
  const resolution = (snapshot.frameW && snapshot.frameH)
    ? `${snapshot.frameW}×${snapshot.frameH}`
    : '—';

  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={onClose}
      style={[styles.statsCard, { borderColor: color }, style]}
      accessibilityRole="button"
      accessibilityLabel="Estatísticas da chamada"
    >
      <View style={styles.statsHeaderRow}>
        <View style={[styles.statsDot, { backgroundColor: color }]} />
        <Text style={styles.statsTitle}>Stats</Text>
      </View>
      <StatLine label="FPS (recv / sent)" value={`${snapshot.fps || 0} / ${snapshot.sentFps || 0}`} />
      <StatLine label="Bitrate" value={formatBitrate(snapshot.bitrateKbps)} />
      <StatLine label="RTT" value={snapshot.rttMs ? `${snapshot.rttMs} ms` : '—'} />
      <StatLine label="Loss" value={`${snapshot.lossPct || 0}%`} />
      <StatLine label="Res" value={resolution} />
      <StatLine label="Mode" value={snapshot.bucket || '—'} />
    </TouchableOpacity>
  );
}

function StatLine({ label, value }) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

// ─── <PoorConnectionWarning /> ────────────────────────────────────────────────
// User-facing toast — "Conexão fraca" when fps < 15 sustained, or bucket =
// very_poor. Fades in/out (300ms). Suppress while the LK reconnecting banner
// is already showing so we don't stack overlapping alerts.
export function PoorConnectionWarning({ snapshot, suppressed, label, style }) {
  const [show, setShow] = useState(false);
  const fadeRef = useRef(new Animated.Value(0)).current;
  const lowSinceRef = useRef(0);

  useEffect(() => {
    const fps = snapshot?.fps ?? 0;
    const bucket = snapshot?.bucket || 'good';
    // [WAVE 104E 2026-05-21] fps=0 means receiver stats haven't resolved yet,
    // not that video is frozen. Guard requires fps > 0 (already existed) AND
    // the fps threshold only applies when bucket is already 'poor' — avoiding
    // a dual-trigger (bucket AND fps) that fires the banner immediately.
    // very_poor alone is sufficient since evaluateBucket now requires 2
    // consecutive samples to reach that bucket.
    const isPoor = bucket === 'very_poor' || (bucket === 'poor' && fps > 0 && fps < 12);

    if (suppressed) {
      lowSinceRef.current = 0;
      if (show) setShow(false);
      return;
    }

    if (isPoor) {
      if (!lowSinceRef.current) lowSinceRef.current = Date.now();
      // [WAVE 104E 2026-05-21] Sustained window 2500ms → 6000ms.
      // The adaptive loop ticks every 3s and SAMPLES_BEFORE_DOWNGRADE=2 means
      // we need 6s of bad samples to reach very_poor. The banner should only
      // appear AFTER that — not race ahead of the bucket hysteresis.
      if (Date.now() - lowSinceRef.current >= 6000 && !show) setShow(true);
    } else {
      // Recovered — hide after a brief delay.
      lowSinceRef.current = 0;
      if (show) setShow(false);
    }
  }, [snapshot, suppressed, show]);

  useEffect(() => {
    Animated.timing(fadeRef, {
      toValue: show ? 1 : 0,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [show, fadeRef]);

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.warnBanner,
        { opacity: fadeRef, transform: [{ translateY: fadeRef.interpolate({ inputRange: [0, 1], outputRange: [-10, 0] }) }] },
        style,
      ]}
    >
      <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" style={{ marginRight: 6 }}>
        <SvgPath d="M12 2L2 22h20L12 2z" stroke={COLORS.bad} strokeWidth={2} fill="rgba(239,68,68,0.25)" />
        <SvgPath d="M12 10v5M12 18v.5" stroke={COLORS.bad} strokeWidth={2.2} strokeLinecap="round" />
      </Svg>
      <Text style={styles.warnText}>{label || 'Conexão fraca'}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  statsCard: {
    position: 'absolute',
    top: 90,
    left: 12,
    backgroundColor: COLORS.bg,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1.5,
    minWidth: 150,
    zIndex: 60,
  },
  statsHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  statsDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statsTitle: {
    color: COLORS.text,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 1,
  },
  statLabel: {
    color: COLORS.textDim,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  statValue: {
    color: COLORS.text,
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    marginLeft: 10,
  },
  warnBanner: {
    position: 'absolute',
    top: 130,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 100,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.5)',
    zIndex: 55,
  },
  warnText: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '600',
  },
});
