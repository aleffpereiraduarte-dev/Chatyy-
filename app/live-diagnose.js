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
import { useRouter } from 'expo-router';
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
  if (level === 'warn') return '#f59e0b';
  return colors.textSecondary || '#6b7280';
}

function summarizeEntries(entries) {
  // Quick heuristic so the user can see "what broke" at the top without
  // having to read every line. We look for known failure signatures from
  // services/cfStreamPublisher.js.
  if (!entries || entries.length === 0) return null;
  const errs = entries.filter(e => e.level === 'error');
  if (errs.length === 0) {
    const ok = entries.find(e => e.msg && e.msg.includes('WHIP publish OK'));
    if (ok) return { ok: true, summary: 'Última transmissão publicada com sucesso. RTP fluindo para CF Stream.' };
    return null;
  }
  const last = errs[errs.length - 1];
  const m = String(last.msg || '');
  let summary = m;
  if (m.includes('ICE failed') || m.includes('NAT')) {
    summary = 'ICE/NAT bloqueado: o celular não conseguiu estabelecer rota com o servidor Cloudflare. Comum em 4G/5G atrás de NAT simétrico. Tente WiFi.';
  } else if (m.includes('ICE connect timeout')) {
    summary = 'ICE não completou em 20s. Provavelmente bloqueado por firewall ou rede corporativa. Tente outra rede.';
  } else if (m.includes('CF answered with a=inactive')) {
    summary = 'Cloudflare recusou a direção do stream (sendrecv → inactive). Isso era o bug raiz histórico — o fix WAVE 98 força sendonly. Se aparecer aqui, abra um ticket.';
  } else if (m.includes('WHIP failed: 4')) {
    summary = 'Cloudflare recusou o offer SDP (4xx). Tente terminar a live e começar de novo; se persistir, é incompatibilidade de codec ou cert.';
  } else if (m.includes('no audio or video tracks')) {
    summary = 'Câmera ou microfone não disponíveis. Confira as permissões em Ajustes > Chatyy.';
  } else if (m.includes('WHIP POST network failure')) {
    summary = 'A requisição HTTP para Cloudflare não chegou. Sem internet ou DNS bloqueado.';
  } else if (m.includes('no localStream')) {
    summary = 'A captura da câmera não estava pronta quando começamos a publicar. Reabra a tela e tente de novo.';
  }
  return { ok: false, summary, raw: m };
}

export default function LiveDiagnose() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useLanguage(); // eslint-disable-line no-unused-vars
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
      'Limpar diagnóstico?',
      'Apaga todos os registros de erro do publish da live. Use isso depois de reportar pro suporte.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Limpar',
          style: 'destructive',
          onPress: async () => {
            await liveDiagClear();
            await load();
          },
        },
      ],
    );
  }, [load]);

  const summary = summarizeEntries([...entries].reverse());

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <IconArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text }]}>Diagnóstico de transmissão</Text>
        <TouchableOpacity onPress={clearAll} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
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
            Quando você abre uma live, o app envia a câmera+mic via WHIP para o servidor
            Cloudflare Stream — que então distribui o vídeo via HLS para todos os viewers. Se
            algo falhar nesse envio (rede, permissão, NAT), os viewers ficam em "Conectando..."
            sem fim, porque a playlist HLS nunca recebe segmentos. Aqui ficam os logs do último
            envio para você (ou suporte) saber exatamente onde travou.
          </Text>
        </View>

        {summary && (
          <View
            style={[
              styles.card,
              summary.ok
                ? { backgroundColor: '#ecfdf5', borderColor: '#a7f3d0' }
                : { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
            ]}
          >
            <Text style={[styles.cardTitle, { color: summary.ok ? '#065f46' : '#991b1b' }]}>
              {summary.ok ? 'Última transmissão' : 'O que aconteceu'}
            </Text>
            <Text style={[styles.cardBody, { color: summary.ok ? '#065f46' : '#7f1d1d', marginTop: 4 }]}>
              {summary.summary}
            </Text>
            {!summary.ok && summary.raw && (
              <Text style={[styles.cardBody, { color: '#7f1d1d', marginTop: 8, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11 }]} selectable>
                {summary.raw.slice(0, 300)}
              </Text>
            )}
          </View>
        )}

        <Text style={[styles.sectionTitle, { color: colors.text }]}>
          Eventos ({entries.length})
        </Text>

        {entries.length === 0 ? (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.cardBody, { color: colors.textSecondary }]}>
              Nenhum registro ainda. Abra uma live (tela "Live") e tente transmitir; volte aqui
              depois para ver o que aconteceu.
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
  rowExtra: { fontSize: 11, lineHeight: 15, marginTop: 6, opacity: 0.8 },
});
