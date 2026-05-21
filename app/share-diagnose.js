// app/share-diagnose.js — WAVE 87 (2026-05-21)
//
// Diagnostic screen for the iOS Share Extension. Reads the App Group
// ring buffer that the native ShareExtension writes to
// `chatyy.share_diag` and surfaces it as a scrollable list so the user
// (or support) can see exactly where the last share attempt went wrong:
// auth missing, payload extraction failed, HTTP 401/500, iCloud timeout,
// etc. No JS-side network calls — purely read-side surfacing.
//
// Triggered manually by typing /share-diagnose into the deep-link box
// in Settings, or via the "Diagnóstico do compartilhamento" row that
// the host app surfaces when ShareExtensionLastError shows a recent
// failure (within the past hour).

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, RefreshControl, Platform,
  Alert, StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconTrash } from '../components/Icons';

function getIntents() {
  try {
    const mod = require('../modules/expo-native-toolkit');
    return mod?.Intents || null;
  } catch {
    return null;
  }
}

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
  if (level === 'warn') return '#f59e0b';
  return colors.textSecondary || '#6b7280';
}

export default function ShareDiagnose() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [entries, setEntries] = useState([]);
  const [lastErr, setLastErr] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    if (Platform.OS !== 'ios') {
      setEntries([]);
      setLastErr(null);
      return;
    }
    const Intents = getIntents();
    if (!Intents) {
      setEntries([]);
      setLastErr(null);
      return;
    }
    try {
      const list = Intents.getShareExtensionDiag() || [];
      // Newest first
      setEntries([...list].reverse());
    } catch {
      setEntries([]);
    }
    try {
      setLastErr(Intents.getShareExtensionLastError() || null);
    } catch {
      setLastErr(null);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
    setTimeout(() => setRefreshing(false), 300);
  }, [load]);

  const clearAll = useCallback(() => {
    Alert.alert(
      'Limpar diagnóstico?',
      'Apaga todos os registros de erro do compartilhamento. Use isso depois de reportar pro suporte.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Limpar',
          style: 'destructive',
          onPress: () => {
            const Intents = getIntents();
            try { Intents?.clearShareExtensionDiag(); } catch {}
            load();
          },
        },
      ],
    );
  }, [load]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <IconArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text }]}>Diagnóstico do compartilhamento</Text>
        <TouchableOpacity onPress={clearAll} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <IconTrash size={22} color={colors.textSecondary || '#6b7280'} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text} />}
      >
        {Platform.OS !== 'ios' ? (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.cardTitle, { color: colors.text }]}>
              Disponível apenas no iOS
            </Text>
            <Text style={[styles.cardBody, { color: colors.textSecondary }]}>
              O Share Extension diagnostic é específico do iOS. No Android, compartilhe direto via app principal.
            </Text>
          </View>
        ) : (
          <>
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.cardTitle, { color: colors.text }]}>O que é isso?</Text>
              <Text style={[styles.cardBody, { color: colors.textSecondary }]}>
                Quando você compartilha uma foto/vídeo do iPhone direto pro Chatyy (via menu Compartilhar do iOS), o
                extension grava aqui o que aconteceu. Use isso pra ver porque o último compartilhamento falhou.
              </Text>
            </View>

            {lastErr && lastErr.msg && (
              <View style={[styles.card, { backgroundColor: '#fef2f2', borderColor: '#fecaca' }]}>
                <Text style={[styles.cardTitle, { color: '#991b1b' }]}>Última falha</Text>
                <Text style={[styles.timestamp, { color: '#7f1d1d' }]}>{fmtTs(lastErr.ts)}</Text>
                <Text style={[styles.cardBody, { color: '#7f1d1d', marginTop: 4, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }]}>
                  {String(lastErr.msg).slice(0, 600)}
                </Text>
              </View>
            )}

            <Text style={[styles.sectionTitle, { color: colors.text }]}>
              Eventos ({entries.length})
            </Text>

            {entries.length === 0 ? (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.cardBody, { color: colors.textSecondary }]}>
                  Nenhum registro ainda. Tente compartilhar uma foto do app Fotos → Chatyy, depois volta aqui.
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
                </View>
              ))
            )}
          </>
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
  title: { flex: 1, fontSize: 17, fontWeight: '700' },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    marginBottom: 12,
  },
  cardTitle: { fontSize: 15, fontWeight: '700', marginBottom: 6 },
  cardBody: { fontSize: 14, lineHeight: 20 },
  sectionTitle: { fontSize: 13, fontWeight: '700', marginTop: 8, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  row: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: 3,
    padding: 12,
    marginBottom: 8,
  },
  rowHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  rowLevel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  timestamp: { fontSize: 11 },
  rowMsg: { fontSize: 12, lineHeight: 16 },
});
