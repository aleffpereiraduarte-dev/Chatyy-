// app/live-diagnose.js — WAVE 98 (2026-05-21)
//
// Diagnostic screen for the Live broadcast WHIP publish pipeline.
//
// Why this exists: live broadcasts go through Cloudflare Stream via WHIP
// (WebRTC HTTP Ingestion). When the host taps "Go Live" the device opens
// a peer connection to CF's ingest endpoint and pushes the camera+mic.
// If ANYTHING in that chain fails (NAT-blocked ICE, CF answer rejecting
// our SDP, no media tracks, etc.) the host's UI used to flip to "AO VIVO"
// happily while NO frames ever reached CF — and every viewer joining the
// session sat on "Conectando..." forever (because the HLS playlist had
// no segments to serve). For weeks this bug was completely invisible:
// host saw no error, viewer saw no error, replay never materialized.
//
// This screen reads the persisted ring buffer written by
// services/cfStreamPublisher.js (key: chatyy.live_diag) and shows the
// last ~100 events in chronological order with level coloring. Open it
// via:
//   - Tap "Diagnóstico" on the Alert that fires when WHIP publish fails
//   - Manually: `router.push('/live-diagnose')` (e.g. from Settings)
//   - Deep link / typed URL: /live-diagnose
//
// Pattern mirrors app/share-diagnose.js (WAVE 87) so users have ONE
// consistent place to dig into native pipeline failures.

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, RefreshControl, Platform,
  Alert, StyleSheet,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { USE_NATIVE_HEADER, nativeHeaderOptions, HeaderIconButton } from '../components/nativeHeader'; // [2026-10-09 native-sheets-headers] header NATIVO
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconTrash } from '../components/Icons';
import { liveDiagRead, liveDiagClear } from '../services/cfStreamPublisher';

function fmtTs(ts) {
  if (!ts || typeof ts !== 'number') return '?';
  try {
    const d = new Date(ts * 1000);
    return d.toLocaleString();
  } catch {
    return String(ts);
  }
}

function levelColor(level, colors) {
  if (level === 'error') return '#ef4444';
  // P&B: só erro ganha cor (vermelho = problema); aviso = tinta cheia.
  if (level === 'warn') return colors.text || '#111';
  return colors.textSecondary || '#6b7280';
}

function summarizeEntries(entries, t) {
  // Quick heuristic so the user can see "what broke" at the top without
  // having to read every line. We look for known failure signatures from
  // services/cfStreamPublisher.js.
  if (!entries || entries.length === 0) return null;
  const errs = entries.filter(e => e.level === 'error');
  if (errs.length === 0) {
    const ok = entries.find(e => e.msg && e.msg.includes('WHIP publish OK'));
    if (ok) return { ok: true, summary: t('liveDiag.okSummary') };
    return null;
  }
  const last = errs[errs.length - 1];
  const m = String(last.msg || '');
  let summary = m;
  if (m.includes('ICE failed') || m.includes('NAT')) {
    summary = t('liveDiag.iceNat');
  } else if (m.includes('ICE connect timeout')) {
    summary = t('liveDiag.iceTimeout');
  } else if (m.includes('CF answered with a=inactive')) {
    summary = t('liveDiag.inactive');
  } else if (m.includes('WHIP failed: 4')) {
    summary = t('liveDiag.whip4xx');
  } else if (m.includes('no audio or video tracks')) {
    summary = t('liveDiag.noTracks');
  } else if (m.includes('WHIP POST network failure')) {
    summary = t('liveDiag.network');
  } else if (m.includes('no localStream')) {
    summary = t('liveDiag.noStream');
  }
  return { ok: false, summary, raw: m };
}

export default function LiveDiagnose() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [entries, setEntries] = useState([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await liveDiagRead();
      // Newest first
      setEntries([...list].reverse());
    } catch {
      setEntries([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setTimeout(() => setRefreshing(false), 300);
  }, [load]);

  const clearAll = useCallback(() => {
    Alert.alert(
      t('liveDiag.clearTitle'),
      t('liveDiag.clearBody'),
      [
        { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
        {
          text: t('liveDiag.clear'),
          style: 'destructive',
          onPress: async () => {
            await liveDiagClear();
            await load();
          },
        },
      ],
    );
  }, [load, t]);

  const summary = summarizeEntries([...entries].reverse(), t);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {USE_NATIVE_HEADER && <Stack.Screen options={nativeHeaderOptions({
        colors, title: t('liveDiag.title'),
        headerRight: () => (
          <HeaderIconButton onPress={clearAll} accessibilityLabel={t('liveDiag.clear')}>
            <IconTrash size={21} color={colors.text} />
          </HeaderIconButton>
        ),
      })} />}
      {!USE_NATIVE_HEADER && (
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} accessibilityRole="button" accessibilityLabel={t('common.back') || 'Voltar'}>
          <IconArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{t('liveDiag.title')}</Text>
        <TouchableOpacity onPress={clearAll} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} accessibilityRole="button" accessibilityLabel={t('liveDiag.clear')}>
          <IconTrash size={22} color={colors.textSecondary || '#6b7280'} />
        </TouchableOpacity>
      </View>
      )}

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text} />}
      >
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>{t('liveDiag.whatTitle')}</Text>
          <Text style={[styles.cardBody, { color: colors.textSecondary }]}>
            {t('liveDiag.whatBody')}
          </Text>
        </View>

        {summary && (
          <View
            style={[
              styles.card,
              styles.summaryCard,
              { backgroundColor: colors.card, borderColor: colors.border, borderLeftColor: summary.ok ? (colors.text || '#111') : '#ef4444' },
            ]}
          >
            <Text style={[styles.cardTitle, { color: summary.ok ? colors.text : '#ef4444' }]}>
              {summary.ok ? t('liveDiag.lastBroadcast') : t('liveDiag.whatHappened')}
            </Text>
            <Text style={[styles.cardBody, { color: colors.text, marginTop: 4 }]}>
              {summary.summary}
            </Text>
            {!summary.ok && summary.raw && (
              <Text style={[styles.cardBody, { color: colors.textSecondary, marginTop: 8, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11 }]} selectable>
                {summary.raw.slice(0, 300)}
              </Text>
            )}
          </View>
        )}

        <Text style={[styles.sectionTitle, { color: colors.text }]}>
          {t('liveDiag.events', { n: entries.length })}
        </Text>

        {entries.length === 0 ? (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.cardBody, { color: colors.textSecondary }]}>
              {t('liveDiag.empty')}
            </Text>
          </View>
        ) : (
          entries.map((e, i) => (
            <View
              key={`${e.ts}_${i}`}
              style={[
                styles.row,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  borderLeftColor: levelColor(e.level, colors),
                },
              ]}
            >
              <View style={styles.rowHeader}>
                <Text style={[styles.rowLevel, { color: levelColor(e.level, colors) }]}>
                  {String(e.level || 'info').toUpperCase()}
                </Text>
                <Text style={[styles.timestamp, { color: colors.textSecondary }]}>
                  {fmtTs(e.ts)}
                </Text>
              </View>
              <Text
                style={[
                  styles.rowMsg,
                  {
                    color: colors.text,
                    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                  },
                ]}
                selectable
              >
                {String(e.msg || '').slice(0, 500)}
              </Text>
              {e.extra && (
                <Text
                  style={[
                    styles.rowExtra,
                    {
                      color: colors.textSecondary,
                      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                    },
                  ]}
                  selectable
                >
                  {JSON.stringify(e.extra, null, 2).slice(0, 600)}
                </Text>
              )}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 16,
  },
  title: { flex: 1, fontSize: 17, fontWeight: '700', letterSpacing: -0.2 },
  card: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 12,
  },
  summaryCard: { borderLeftWidth: 3 },
  cardTitle: { fontSize: 15, fontWeight: '700', marginBottom: 6 },
  cardBody: { fontSize: 14, lineHeight: 20 },
  sectionTitle: { fontSize: 12, fontWeight: '700', marginTop: 12, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.6, opacity: 0.7 },
  row: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: 3,
    padding: 12,
    marginBottom: 8,
  },
  rowHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  rowLevel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  timestamp: { fontSize: 11 },
  rowMsg: { fontSize: 12, lineHeight: 16 },
  rowExtra: { fontSize: 11, lineHeight: 15, marginTop: 6, opacity: 0.8 },
});
