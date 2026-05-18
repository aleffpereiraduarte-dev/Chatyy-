// components/CallAudioStats.js
// =================================================================
// Audio diagnostics modal — surfaced from the in-call "More" sheet or
// from settings while a call is active. Shows the LIVE network stats
// LiveKit hands back from the publisher PeerConnection (RTT, loss,
// jitter, current bitrate, codec) plus a Telegram-style 4-bar quality
// indicator.
//
// Why this exists: when a user complains "minha chamada tá ruim" the
// support team currently has no number to anchor the conversation. Now
// they can ask "abre Mais → Diagnóstico de áudio e me diz a perda" and
// get a real metric. Also useful for us in QA — saves digging through
// adb logcat to find the WebRTC stats line.
//
// The component is *pure presentational*: it takes a `stats` prop and
// renders. The owner (app/call.js) is responsible for polling.
//
// Stats shape (matches livekitTuning.pollNetworkStats output):
//   { rtt: number ms, loss: number %, jitter: number ms,
//     bitrate: number bps, codec: string, ts: number ms-epoch }
//
import React, { useMemo } from 'react';
import {
  View, Text, Modal, Pressable, TouchableOpacity, StyleSheet,
} from 'react-native';
import ConnectionBars from './ConnectionBars';
import { IconX, IconInfo } from './Icons';
import { classifyQuality } from '../services/livekitTuning';

export default function CallAudioStats({ visible, stats, t, onClose }) {
  const c = useMemo(() => classifyQuality(stats || {}), [stats]);

  const rttStr = formatMs(stats?.rtt);
  const lossStr = formatPct(stats?.loss);
  const jitterStr = formatMs(stats?.jitter);
  const codecStr = (stats?.codec || 'opus').toUpperCase();
  const bitrateStr = formatBitrate(stats?.bitrate || c.bitrate);

  // Translate level → label/color. We keep this in-component so the
  // modal stays self-contained for support contexts.
  const qualityLabel =
    c.level >= 3 ? (t?.('call.audio.quality.good') || 'Qualidade boa')
                 : (t?.('call.audio.quality.poor') || 'Qualidade ruim');
  const qualityColor =
    c.level >= 3 ? '#10b981'
    : c.level === 2 ? '#f59e0b'
    : '#ef4444';

  return (
    <Modal
      visible={!!visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation?.()}>
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <IconInfo size={18} color="#fff" />
              <Text style={styles.title}>
                {t?.('call.audio.diagnostics.title') || 'Diagnóstico de áudio'}
              </Text>
            </View>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              accessibilityRole="button"
              accessibilityLabel={t?.('common.close') || 'Fechar'}
            >
              <IconX size={20} color="#fff" />
            </TouchableOpacity>
          </View>

          {/* Quality summary */}
          <View style={styles.qualityRow}>
            <ConnectionBars level={c.level} size={22} />
            <Text style={[styles.qualityLabel, { color: qualityColor }]}>
              {qualityLabel}
            </Text>
          </View>

          {/* Metrics grid */}
          <View style={styles.metrics}>
            <Metric
              label={t?.('call.audio.diagnostics.rtt') || 'Latência'}
              value={rttStr}
            />
            <Metric
              label={t?.('call.audio.diagnostics.loss') || 'Perda'}
              value={lossStr}
            />
            <Metric
              label={t?.('call.audio.diagnostics.jitter') || 'Jitter'}
              value={jitterStr}
            />
            <Metric
              label={t?.('call.audio.diagnostics.bitrate') || 'Bitrate'}
              value={bitrateStr}
            />
            <Metric
              label={t?.('call.audio.diagnostics.codec') || 'Codec'}
              value={codecStr}
            />
            <Metric
              label={t?.('call.audio.diagnostics.dtx') || 'DTX'}
              value={c.dtx ? 'ON' : 'OFF'}
            />
          </View>

          {/* Helper hint */}
          <Text style={styles.hint}>
            {t?.('call.audio.diagnostics.hint')
              || 'Estes valores ajudam o suporte a entender por que sua chamada está com qualidade reduzida.'}
          </Text>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Metric({ label, value }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel} numberOfLines={1}>{label}</Text>
      <Text style={styles.metricValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function formatMs(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  return `${Math.round(n)} ms`;
}
function formatPct(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  return `${(Math.round(n * 10) / 10).toFixed(1)}%`;
}
function formatBitrate(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return '—';
  if (bps < 1000) return `${bps} bps`;
  return `${Math.round(bps / 1000)} kbps`;
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  sheet: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#1f2937',
    borderRadius: 18,
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 18,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  qualityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 12,
    marginBottom: 14,
  },
  qualityLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  metrics: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -4,
  },
  metric: {
    width: '50%',
    paddingHorizontal: 4,
    paddingVertical: 6,
  },
  metricLabel: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 11,
    fontWeight: '500',
    marginBottom: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  metricValue: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  hint: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12,
    marginTop: 12,
    lineHeight: 17,
  },
});
