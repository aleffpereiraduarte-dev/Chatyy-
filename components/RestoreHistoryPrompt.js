// RestoreHistoryPrompt — WhatsApp-grade first-launch download UI.
//
// Surfaced after a successful login on a fresh install (or any device whose
// SQLite store is missing messages compared to the server's chat_inventory).
// Two-state modal:
//   1. Idle  — "Baixar histórico completo (~XXX MB)" + "Mais tarde"
//   2. Active — full-screen progress card. "Continuar em background"
//      collapses it into a tiny chip; the bootstrap keeps running.
//
// Different from RestoreBackupPrompt — that one restores from a previous
// device's encrypted .CYB2 backup. THIS one downloads the full server-side
// chat_messages history into SQLite + every media file to disk, so the user
// can open the app offline tomorrow and see all old messages + photos.
//
// Wired from app/login.js after the existing RestoreBackupPrompt path (only
// if THAT prompt didn't fire — i.e. no cloud/server backup exists). The
// trigger is also exposed via Settings → Storage → "Baixar histórico
// completo" so the user can re-arm it any time.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, ActivityIndicator, StyleSheet,
  Platform, Animated, Easing,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing } from '../constants/theme';
import { IconCloud, IconCheck, IconRefresh } from './Icons';

// Rough heuristic — 250KB per message including media-bearing rows (audio
// + images dominate the size). The estimate is shown to the user upfront so
// they know what they're committing to before tapping "Baixar agora".
const MB_PER_MSG_HEURISTIC = 0.25;

let mailWs = null;
try { mailWs = require('../services/websocket').default; } catch {}

function formatBytes(n) {
  const num = Math.max(0, Number(n) || 0);
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(0)} MB`;
  return `${(num / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * @param {object} props
 * @param {boolean} props.visible
 * @param {() => void} props.onClose       — called on Skip / Continue-in-bg
 * @param {string} props.email             — user email (for gate keys)
 * @param {object} [props.inventory]       — pre-fetched chat_inventory data
 *                                           { totalMsgs, totalConvs }; if
 *                                           absent we fetch on mount.
 */
export default function RestoreHistoryPrompt({ visible, onClose, email, inventory }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();

  // Web kill-switch (no SQLite there).
  if (Platform.OS === 'web') return null;

  // 'idle' (showing the offer) | 'running' (progress card) | 'done' (briefly)
  const [phase, setPhase] = useState('idle');
  const [inv, setInv] = useState(inventory || null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({
    convDone: 0, convTotal: 0,
    msgsLoaded: 0, mediaLoaded: 0,
    currentConvName: null,
  });
  const progressAnim = useRef(new Animated.Value(0)).current;

  // Fetch inventory on first render if not supplied.
  useEffect(() => {
    if (!visible) return;
    if (inv && Number(inv.totalMsgs) > 0) return;
    let alive = true;
    (async () => {
      try {
        const api = require('../services/api');
        const r = await api.apiCall('chat_inventory', {});
        if (!alive) return;
        const list = r?.data?.conversations || r?.conversations || [];
        let totalMsgs = 0;
        for (const c of list) totalMsgs += Number(c?.count || 0);
        setInv({ totalMsgs, totalConvs: list.length });
      } catch {
        if (alive) setInv({ totalMsgs: 0, totalConvs: 0 });
      }
    })();
    return () => { alive = false; };
  }, [visible]);

  // Subscribe to bootstrap progress events while the loop runs.
  useEffect(() => {
    if (!visible || phase !== 'running') return;
    const handler = (payload) => {
      setProgress((prev) => ({
        ...prev,
        convDone: payload.convDone ?? prev.convDone,
        convTotal: payload.convTotal ?? prev.convTotal,
        msgsLoaded: payload.msgsLoaded ?? prev.msgsLoaded,
        mediaLoaded: payload.mediaLoaded ?? prev.mediaLoaded,
        currentConvName: payload.currentConvName || prev.currentConvName,
      }));
      if (payload.phase === 'done') {
        setPhase('done');
        // Brief "✓ Concluído" flash then auto-close.
        setTimeout(() => { onClose?.(); }, 1500);
      }
    };
    try { mailWs?.on?.('chat_bootstrap_progress', handler); } catch {}
    return () => { try { mailWs?.off?.('chat_bootstrap_progress', handler); } catch {} };
  }, [visible, phase, onClose]);

  // Animate the progress bar smoothly to the new percent.
  const percent = (() => {
    if (phase !== 'running') return 0;
    const { convDone, convTotal } = progress;
    if (!convTotal) return 0;
    return Math.max(0, Math.min(1, convDone / convTotal));
  })();
  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue: percent,
      duration: 350,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [percent]);

  const handleStart = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setPhase('running');
    try {
      const api = require('../services/api');
      const { forceFullHistoryDownload } = require('../services/fullHistorySync');
      // Fire and forget — progress comes via WS events. We DON'T await here
      // because the loop can run 1-30min; the modal is interactive while it
      // runs ("Continuar em background" minimises it).
      forceFullHistoryDownload(api.apiCall, email, { includeAllMedia: true })
        .catch(() => {})
        .finally(() => { setBusy(false); });
    } catch (e) {
      setBusy(false);
      setPhase('idle');
    }
  }, [busy, email]);

  const handleLater = useCallback(() => {
    onClose?.();
  }, [onClose]);

  const handleBackground = useCallback(() => {
    // Bootstrap keeps running silently — we just close the modal. The
    // SyncBar at the top of the screen will continue to display the
    // "Sincronizando histórico • N/M" pill until done.
    onClose?.();
  }, [onClose]);

  if (!visible) return null;

  const totalMsgs = Number(inv?.totalMsgs || 0);
  const totalConvs = Number(inv?.totalConvs || 0);
  const estMb = Math.round(totalMsgs * MB_PER_MSG_HEURISTIC);
  const estLabel = estMb > 0
    ? `~${estMb < 1024 ? `${estMb} MB` : `${(estMb / 1024).toFixed(1)} GB`}`
    : '';

  const sumLabel = totalMsgs > 0
    ? (t('restoreHistory.sizeHint') || 'Cerca de {n} mensagens em {c} conversas')
        .replace('{n}', totalMsgs.toLocaleString())
        .replace('{c}', String(totalConvs))
    : '';

  return (
    <Modal visible={visible} animationType="fade" transparent>
      <View style={[s.backdrop, { backgroundColor: 'rgba(0,0,0,0.55)' }]}>
        <View style={[s.card, { backgroundColor: colors.surface }]}>
          {/* Header — same brand badge whether idle / running / done */}
          <View style={[s.iconWrap, { backgroundColor: colors.primary + '18' }]}>
            {phase === 'done'
              ? <IconCheck size={48} color={colors.primary} />
              : <IconCloud size={48} color={colors.primary} />}
          </View>

          {phase === 'idle' && (
            <>
              <Text style={[s.title, { color: colors.text }]}>
                {t('restoreHistory.title') || 'Baixar histórico completo'}
              </Text>
              <Text style={[s.body, { color: colors.textSecondary }]}>
                {t('restoreHistory.body')
                  || 'Para ver suas mensagens antigas e fotos sem internet, baixe tudo agora. Recomendamos uma rede Wi-Fi.'}
              </Text>
              {!!sumLabel && (
                <Text style={[s.summary, { color: colors.textTertiary }]}>
                  {sumLabel}{estLabel ? `  •  ${estLabel}` : ''}
                </Text>
              )}
              <View style={s.actionsCol}>
                <TouchableOpacity
                  style={[s.btnPrimary, { backgroundColor: colors.primary }]}
                  onPress={handleStart}
                  disabled={busy}
                  accessibilityRole="button"
                >
                  {busy
                    ? <ActivityIndicator color="#fff" />
                    : <Text style={s.btnPrimaryText}>{t('restoreHistory.startNow') || 'Baixar agora'}</Text>}
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.btnSecondary}
                  onPress={handleLater}
                  disabled={busy}
                  accessibilityRole="button"
                >
                  <Text style={[s.btnSecondaryText, { color: colors.textSecondary }]}>
                    {t('restoreHistory.later') || 'Mais tarde'}
                  </Text>
                </TouchableOpacity>
              </View>
            </>
          )}

          {phase === 'running' && (
            <>
              <Text style={[s.title, { color: colors.text }]}>
                {t('restoreHistory.downloading') || 'Baixando suas conversas…'}
              </Text>
              {progress.currentConvName ? (
                <Text style={[s.body, { color: colors.textSecondary }]} numberOfLines={1}>
                  {progress.currentConvName}
                </Text>
              ) : (
                <Text style={[s.body, { color: colors.textSecondary }]}>
                  {t('restoreHistory.preparing') || 'Preparando…'}
                </Text>
              )}
              {/* Big counter — convs done */}
              <Text style={[s.bigCount, { color: colors.text }]}>
                {progress.convDone.toLocaleString()}
                <Text style={{ color: colors.textTertiary }}> / {Math.max(progress.convTotal || 0, progress.convDone).toLocaleString()}</Text>
              </Text>
              <Text style={[s.bigCountLabel, { color: colors.textTertiary }]}>
                {t('restoreHistory.convsDone') || 'conversas'}
              </Text>
              {/* Progress bar */}
              <View style={[s.track, { backgroundColor: colors.borderLight }]}>
                <Animated.View
                  style={[s.fill, {
                    backgroundColor: colors.primary,
                    width: progressAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: ['0%', '100%'],
                    }),
                  }]}
                />
              </View>
              {progress.mediaLoaded > 0 && (
                <Text style={[s.summary, { color: colors.textTertiary }]}>
                  {(t('restoreHistory.mediaLoaded') || '{n} mídias baixadas').replace('{n}', progress.mediaLoaded.toLocaleString())}
                </Text>
              )}
              <TouchableOpacity
                style={s.btnSecondary}
                onPress={handleBackground}
                accessibilityRole="button"
              >
                <Text style={[s.btnSecondaryText, { color: colors.textSecondary }]}>
                  {t('restoreHistory.continueInBackground') || 'Continuar em segundo plano'}
                </Text>
              </TouchableOpacity>
            </>
          )}

          {phase === 'done' && (
            <>
              <Text style={[s.title, { color: colors.text }]}>
                {t('restoreHistory.complete') || 'Histórico baixado!'}
              </Text>
              <Text style={[s.body, { color: colors.textSecondary }]}>
                {t('restoreHistory.completeBody')
                  || 'Você já pode usar o app sem internet.'}
              </Text>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: Spacing.lg },
  card: {
    width: '100%', maxWidth: 380,
    borderRadius: BorderRadius.xl,
    padding: Spacing.xl,
    alignItems: 'center',
  },
  iconWrap: {
    width: 88, height: 88, borderRadius: 44,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.lg,
  },
  title: {
    fontSize: FontSize.xl, fontWeight: '700',
    textAlign: 'center', marginBottom: Spacing.sm,
  },
  body: {
    fontSize: FontSize.md, lineHeight: 20,
    textAlign: 'center', marginBottom: Spacing.md,
  },
  summary: {
    fontSize: FontSize.sm,
    textAlign: 'center', marginBottom: Spacing.md,
  },
  actionsCol: {
    width: '100%', gap: Spacing.sm, marginTop: Spacing.sm,
  },
  btnPrimary: {
    paddingVertical: 14,
    borderRadius: BorderRadius.lg,
    alignItems: 'center', justifyContent: 'center',
  },
  btnPrimaryText: { color: '#fff', fontSize: FontSize.md, fontWeight: '600' },
  btnSecondary: {
    paddingVertical: 12,
    alignItems: 'center', justifyContent: 'center',
    marginTop: Spacing.xs,
  },
  btnSecondaryText: { fontSize: FontSize.md, fontWeight: '500' },
  bigCount: {
    fontSize: 36, fontWeight: '700',
    marginTop: Spacing.md,
    fontVariant: ['tabular-nums'],
  },
  bigCountLabel: {
    fontSize: FontSize.sm,
    marginBottom: Spacing.md,
  },
  track: {
    width: '100%', height: 6, borderRadius: 3,
    overflow: 'hidden', marginTop: Spacing.sm, marginBottom: Spacing.md,
  },
  fill: { height: '100%' },
});
