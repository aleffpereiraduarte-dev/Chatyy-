// app/call-diagnose.js — WAVE 104F (2026-05-21)
//
// Diagnostic screen for the LiveKit call pipeline.
//
// Why this exists: when a call fails ("Conectando forever", áudio mudo, ICE
// timeout, LK disconnect) the only observability we had was user screenshots.
// This screen reads the persistent ring buffer written by services/callDiag.js
// (AsyncStorage key: chatyy.call_diag) and shows the last ~100 events newest-
// first, with level coloring and optional payload. Open via:
//   - Settings → Sobre → "Diagnóstico de chamadas" (visible in __DEV__ or
//     when developer_mode is enabled)
//   - router.push('/call-diagnose')
//
// Pattern mirrors app/live-diagnose.js (WAVE 98).

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, RefreshControl, Platform,
  Alert, StyleSheet, Clipboard,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { getCallDiag, clearCallDiag } from '../services/callDiag';
import { IconArrowLeft, IconTrash, IconPhone } from '../components/Icons';

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

export default function CallDiagnose() {
  const router = useRouter();
  const { colors } = useTheme();
  const [entries, setEntries] = useState([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await getCallDiag();
      setEntries([...list].reverse()); // newest first
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
      'Limpar diagnóstico?',
      'Apaga todos os registros de chamadas. Use depois de reportar pro suporte.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Limpar',
          style: 'destructive',
          onPress: async () => {
            await clearCallDiag();
            await load();
          },
        },
      ],
    );
  }, [load]);

  const copyAll = useCallback(() => {
    try {
      const txt = [...entries].reverse().map(e => {
        const ts = fmtTs(e.ts);
        const lvl = String(e.level || 'info').toUpperCase();
        const payload = e.payload ? ' ' + JSON.stringify(e.payload) : '';
        return `[${ts}] ${lvl} ${e.msg}${payload}`;
      }).join('\n');
      if (Platform.OS === 'web') {
        try { navigator.clipboard?.writeText(txt); } catch {}
      } else {
        try { Clipboard.setString(txt); } catch {}
      }
      Alert.alert('Copiado', 'Log copiado para a área de transferência.');
    } catch {}
  }, [entries]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <IconArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <IconPhone size={18} color={colors.primary} />
          <Text style={[styles.title, { color: colors.text }]}>Diagnóstico de chamadas</Text>
        </View>
        <TouchableOpacity onPress={clearAll} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={{ marginRight: 12 }}>
          <IconTrash size={22} color={colors.textSecondary || '#6b7280'} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text} />}
      >
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>O que é isso?</Text>
          <Text style={[styles.cardBody, { color: colors.textSecondary }]}>
            Registra eventos críticos do ciclo de vida de chamadas: montagem da tela, conexão
            LiveKit, ICE, qualidade, áudio mudo remoto, timeouts e desconexão. Útil para
            diagnosticar "Conectando forever", áudio mudo ou quedas aleatórias sem precisar
            de Console/Xcode.
          </Text>
        </View>

        {entries.length > 0 && (
          <TouchableOpacity
            onPress={copyAll}
            style={[styles.copyBtn, { backgroundColor: colors.primary + '18', borderColor: colors.primary + '44' }]}
          >
            <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 14 }}>
              Copiar log ({entries.length} eventos)
            </Text>
          </TouchableOpacity>
        )}

        <Text style={[styles.sectionTitle, { color: colors.text }]}>
          Eventos ({entries.length})
        </Text>

        {entries.length === 0 ? (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.cardBody, { color: colors.textSecondary }]}>
              Nenhum registro ainda. Faça ou receba uma chamada e volte aqui para ver o que
              aconteceu.
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
              {e.payload && (
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
                  {JSON.stringify(e.payload, null, 2).slice(0, 600)}
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
  title: { fontSize: 17, fontWeight: '700' },
  copyBtn: {
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
    marginBottom: 12,
  },
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
  rowExtra: { fontSize: 11, lineHeight: 15, marginTop: 6, opacity: 0.8 },
});
