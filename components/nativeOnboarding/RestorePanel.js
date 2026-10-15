// [2026-10-15 native-onboarding] Passo "Restaurar" em tela cheia (backup E2E
// no servidor do Chatyy — services/ownBackup), com barra de progresso real
// (onProgress do restoreBackup). Mesma lógica do OwnBackupRestorePrompt:
// senha do backup OU chave de 64 dígitos; cada senha errada consome 1
// tentativa no cofre do servidor (o servidor trava ao estourar).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, Animated, Easing, StyleSheet, Platform } from 'react-native';
import * as ownBackup from '../../services/ownBackup';
import { fmtBytes, fmtDate, errorText } from '../OwnBackupCard';
import { IconCloud, IconCheck, IconAlertTriangle, IconLock } from '../Icons';

export default function RestorePanel({ candidate, colors, t, reduced, onFinished, Primary, Secondary }) {
  const set = candidate?.set || null;
  const [secret, setSecret] = useState('');
  const [useKey, setUseKey] = useState(!candidate?.hasPassword);
  const [stage, setStage] = useState('ask'); // ask | restoring | done
  const [error, setError] = useState('');
  const [progress, setProgress] = useState({ done: 0, total: set?.msg_count || 0 });
  const [result, setResult] = useState(null);
  const bar = useRef(new Animated.Value(0)).current;
  const passwordMode = !!candidate?.hasPassword && !useKey;

  const pct = progress.total ? Math.max(0.03, Math.min(1, (progress.done || 0) / progress.total)) : (stage === 'done' ? 1 : 0.04);
  useEffect(() => {
    if (stage === 'ask') { bar.setValue(0); return; }
    const to = stage === 'done' ? 1 : pct;
    if (reduced) { bar.setValue(to); return; }
    Animated.timing(bar, { toValue: to, duration: 280, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [pct, stage, reduced, bar]);

  const restore = useCallback(async () => {
    if (!set || !secret || stage === 'restoring') return;
    setError(''); setStage('restoring'); setProgress({ done: 0, total: set.msg_count || 0 });
    try {
      const isKey = !passwordMode || !!ownBackup.parseRecoveryKey(secret);
      const u = await ownBackup.unlockBackup({
        uid: set.uid, manifest: set.manifest,
        password: isKey ? undefined : secret,
        recoveryKey: isKey ? secret : undefined,
      }, candidate.email);
      const r = await ownBackup.restoreBackup(set.uid, {
        manifest: u.manifest, email: candidate.email,
        onProgress: (p) => { if (p && (p.phase === 'restore' || p.phase === 'done')) setProgress({ done: p.done || 0, total: p.total || 0 }); },
      });
      setResult(r); setStage('done');
      try { require('../../services/haptics').success?.(); } catch {}
    } catch (e) {
      const left = e?.attemptsLeft;
      setError(errorText(t, e) + (left != null && e?.code === 'ERR_BAD_PASSWORD' ? ` ${t('ownBackup.attemptsLeft', { n: left })}` : ''));
      setStage('ask');
      try { require('../../services/haptics').error?.(); } catch {}
    }
  }, [set, secret, stage, passwordMode, candidate, t]);

  if (!set) return null;
  const busy = stage === 'restoring';
  const pctLabel = progress.total ? `${Math.round(pct * 100)}% · ${progress.done || 0}/${progress.total}` : '';

  return (
    <View style={{ flex: 1 }}>
      <View style={st.center}>
        <View style={[st.badge, { backgroundColor: colors.surfaceVariant }]}>
          {stage === 'done' ? <IconCheck size={34} color={colors.text} strokeWidth={2.6} /> : <IconCloud size={34} color={colors.text} />}
        </View>
        <Text style={[st.title, { color: colors.text }]} accessibilityRole="header" maxFontSizeMultiplier={1.3}>
          {stage === 'done' ? t('ownBackup.restoreDoneTitle') : t('ownBackup.restorePromptTitle')}
        </Text>
        <Text style={[st.sub, { color: colors.textSecondary }]} maxFontSizeMultiplier={1.5}>
          {stage === 'done'
            ? t('ownBackup.restoredNotice', { n: result?.restored || 0 })
            : t('ownBackup.restorePromptBody', { date: fmtDate(set.created_at), n: set.msg_count, size: fmtBytes(set.size_bytes) })}
        </Text>
      </View>

      {stage !== 'done' && (
        <View style={{ marginTop: 22 }}>
          <View style={st.row}>
            <IconLock size={14} color={colors.textSecondary} />
            <Text style={[st.small, { color: colors.textSecondary, flex: 1 }]}>
              {passwordMode ? t('ownBackup.unlockHintPassword') : t('ownBackup.unlockHintKey')}
            </Text>
          </View>
          <TextInput
            value={secret}
            onChangeText={(v) => { setSecret(v); if (error) setError(''); }}
            editable={!busy}
            secureTextEntry={passwordMode}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={passwordMode ? t('ownBackup.passwordPlaceholder') : t('ownBackup.keyPlaceholder')}
            placeholderTextColor={colors.textTertiary}
            style={[st.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceVariant }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]}
            onSubmitEditing={restore}
            accessibilityLabel={passwordMode ? t('ownBackup.passwordPlaceholder') : t('ownBackup.keyPlaceholder')}
            testID="nob-restore-secret"
          />
          {candidate?.hasPassword ? (
            <Pressable disabled={busy} onPress={() => { setUseKey(!useKey); setSecret(''); setError(''); }} hitSlop={8} accessibilityRole="button">
              <Text style={[st.link, { color: colors.text }]}>{useKey ? t('ownBackup.usePasswordInstead') : t('ownBackup.useKeyInstead')}</Text>
            </Pressable>
          ) : null}
          {!!error && (
            <View style={[st.row, { marginTop: 10 }]} accessibilityLiveRegion="polite">
              <IconAlertTriangle size={14} color={colors.error || colors.text} />
              <Text style={[st.small, { color: colors.error || colors.text, flex: 1 }]}>{error}</Text>
            </View>
          )}
        </View>
      )}

      {(busy || stage === 'done') && (
        <View
          style={{ marginTop: 26 }}
          accessible
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: 100, now: Math.round((stage === 'done' ? 1 : pct) * 100) }}
          testID="nob-restore-progress"
        >
          <View style={[st.track, { backgroundColor: colors.border }]}>
            <Animated.View style={[st.fill, { backgroundColor: colors.text, transform: [{ scaleX: bar }] }]} />
          </View>
          <Text style={[st.small, { color: colors.textSecondary, marginTop: 8 }]}>
            {stage === 'done' ? t('ownBackup.restoreDoneTitle') : `${t('ownBackup.phaseRestore')}${pctLabel ? ` ${pctLabel}` : ''}`}
          </Text>
        </View>
      )}

      <View style={{ flex: 1 }} />
      {stage === 'done' ? (
        <Primary label={t('ownBackup.continue')} onPress={() => onFinished?.('restored')} testID="nob-restore-continue" />
      ) : (
        <>
          <Primary label={t('ownBackup.restore')} onPress={restore} loading={busy} disabled={!secret} testID="nob-restore-go" />
          <Secondary label={t('ownBackup.notNow')} onPress={() => onFinished?.('skipped')} disabled={busy} testID="nob-restore-skip" />
        </>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  center: { alignItems: 'center', marginTop: 12 },
  badge: { width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  title: { fontSize: 26, fontWeight: '800', letterSpacing: -0.5, textAlign: 'center' },
  sub: { fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: 8, paddingHorizontal: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  small: { fontSize: 13, lineHeight: 18 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, marginTop: 10 },
  link: { fontSize: 13, textDecorationLine: 'underline', marginTop: 10 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  // scaleX a partir da esquerda: largura cheia + transformOrigin.
  fill: { height: 6, width: '100%', borderRadius: 3, transformOrigin: 'left' },
});
