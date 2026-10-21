// call-recap.js (2026-05-17)
//
// Post-call recap screen. Shown after a call ends IF the user enabled the
// recording toggle in the more sheet (`session.recording`). Pipeline:
//   1. /call.js teardown uploads the recorded audio via uploadCallRecording
//      → backend stores it on R2 and writes a row in chat_call_recordings.
//   2. User taps "Resumo da chamada" in chat or call history → navigates
//      to /call-recap?callId=<id>.
//   3. This screen POSTs `chat_call_recap` which kicks off the Whisper +
//      GPT summary pipeline (same model the voicemail pipeline uses —
//      _voicemailTranscribeAsync in chat.php). Returns:
//        - { pending: true }                  → still processing (poll)
//        - { transcript, summary, duration }  → done
//   4. Renders the summary + a collapsible full transcript.

import React, { useEffect, useState, useRef } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { useRouter, useLocalSearchParams, Stack } from 'expo-router';
import { USE_NATIVE_HEADER, nativeHeaderOptions } from '../components/nativeHeader'; // [2026-10-09 native-sheets-headers] header NATIVO
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing } from '../constants/theme';
import { IconArrowLeft, IconClock, IconMessageCircle, IconChevronDown, IconChevronUp } from '../components/Icons';
import * as api from '../services/api';

const POLL_INTERVAL_MS = 4000;
const POLL_MAX_ATTEMPTS = 30; // ~2 minutes — Whisper rarely takes longer

export default function CallRecapScreen() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { callId } = useLocalSearchParams();

  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const [recap, setRecap] = useState(null); // { transcript, summary, duration }
  const [showFullTranscript, setShowFullTranscript] = useState(false);
  const pollTimer = useRef(null);
  const attemptsRef = useRef(0);
  // [2026-10-21] resposta que chega depois de sair da tela não reagenda o poll
  const aliveRef = useRef(true);

  const fetchRecap = async () => {
    if (!callId) {
      setError(t('callRecap.missingId') || 'ID da chamada não informado');
      setLoading(false);
      return;
    }
    try {
      const resp = await api.chatCallRecap(String(callId));
      if (!aliveRef.current) return;
      if (resp && resp.success && resp.data) {
        if (resp.data.pending) {
          setPending(true);
          attemptsRef.current += 1;
          if (attemptsRef.current < POLL_MAX_ATTEMPTS) {
            pollTimer.current = setTimeout(fetchRecap, POLL_INTERVAL_MS);
          } else {
            setError(t('callRecap.timeout') || 'Tempo esgotado — tente novamente em alguns minutos');
            setPending(false);
            setLoading(false);
          }
          return;
        }
        setRecap(resp.data);
        setPending(false);
      } else {
        setError(resp?.message || t('callRecap.error') || 'Erro ao gerar resumo');
      }
    } catch (e) {
      if (!aliveRef.current) return;
      setError(t('common.networkError', 'Erro de rede. Verifique sua conexão.'));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    aliveRef.current = true;
    fetchRecap();
    return () => {
      aliveRef.current = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId]);

  const formatDuration = (s) => {
    if (!s || s <= 0) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {USE_NATIVE_HEADER && <Stack.Screen options={nativeHeaderOptions({ colors, isDark, title: t('callRecap.title') })} />}
      {!USE_NATIVE_HEADER && (
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)' }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} activeOpacity={0.7} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.back') || 'Voltar'}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text }]}>{t('callRecap.title') || 'Resumo da chamada'}</Text>
      </View>
      )}

      <ScrollView contentContainerStyle={{ padding: Spacing.lg, paddingBottom: insets.bottom + 24 }}>
        {(loading || pending) && (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.text} />
            <Text style={[styles.muted, { color: colors.textSecondary }]}>
              {pending
                ? (t('callRecap.processing') || 'Processando áudio...')
                : (t('callRecap.loading') || 'Carregando...')}
            </Text>
          </View>
        )}

        {error && !loading && (
          <View style={styles.center}>
            <Text style={[styles.error, { color: colors.error || '#dc2626' }]}>{error}</Text>
            {callId ? (
              <TouchableOpacity
                onPress={() => { attemptsRef.current = 0; setError(null); setLoading(true); fetchRecap(); }}
                style={[styles.retryBtn, { backgroundColor: colors.primary }]}
                activeOpacity={0.8}
                accessibilityRole="button"
              >
                <Text style={[styles.retryText, { color: colors.onPrimary || '#fff' }]}>{t('common.tryAgain', 'Tentar de novo')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        )}

        {recap && !loading && !error && (
          <>
            {recap.duration > 0 && (
              <View style={styles.metaRow}>
                <IconClock size={16} color={colors.textSecondary} />
                <Text style={[styles.meta, { color: colors.textSecondary }]}>
                  {t('callRecap.duration') || 'Duração'}: {formatDuration(recap.duration)}
                </Text>
              </View>
            )}

            <View style={[styles.card, { backgroundColor: colors.surfaceVariant }]}>
              <Text style={[styles.cardTitle, { color: colors.text }]}>
                {t('callRecap.summary') || 'Resumo'}
              </Text>
              <Text style={[styles.cardBody, { color: colors.text }]}>
                {recap.summary || (t('callRecap.noSummary') || 'Nenhum resumo disponível')}
              </Text>
            </View>

            {!!recap.transcript && (
              <View style={[styles.card, { backgroundColor: colors.surfaceVariant }]}>
                <TouchableOpacity
                  onPress={() => setShowFullTranscript(!showFullTranscript)}
                  style={styles.transcriptHeader}
                  activeOpacity={0.7}
                >
                  <IconMessageCircle size={16} color={colors.text} />
                  <Text style={[styles.cardTitle, { color: colors.text, marginLeft: 8, marginBottom: 0 }]}>
                    {t('callRecap.transcript') || 'Transcrição completa'}
                  </Text>
                  <View style={{ marginLeft: 'auto' }}>
                    {showFullTranscript
                      ? <IconChevronUp size={18} color={colors.textSecondary} />
                      : <IconChevronDown size={18} color={colors.textSecondary} />}
                  </View>
                </TouchableOpacity>
                {showFullTranscript && (
                  <Text style={[styles.cardBody, { color: colors.text, marginTop: 8 }]}>
                    {recap.transcript}
                  </Text>
                )}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: 12 },
  backBtn: { padding: 8, marginLeft: -8 },
  title: { fontSize: 18, fontWeight: '600' },
  center: { paddingVertical: 40, alignItems: 'center', gap: 12 },
  muted: { fontSize: 13 },
  error: { fontSize: 14, textAlign: 'center' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 },
  meta: { fontSize: 13 },
  card: { padding: 16, borderRadius: 14, marginBottom: 12 },
  cardTitle: { fontSize: 15, fontWeight: '600', marginBottom: 8 },
  cardBody: { fontSize: 15, lineHeight: 22 },
  transcriptHeader: { flexDirection: 'row', alignItems: 'center', minHeight: 32 },
  retryBtn: { marginTop: 16, paddingHorizontal: 22, paddingVertical: 11, borderRadius: 999 },
  retryText: { fontSize: 15, fontWeight: '700' },
});
