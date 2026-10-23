// OwnBackupRestorePrompt — logo após o login num aparelho novo: "Restaurar
// backup de DD/MM (N mensagens)" do backup E2E no servidor do Chatyy
// (services/ownBackup.js). Pede a senha do backup ou a chave de 64 dígitos.
// [2026-10-09 own-backup] Preto e branco, ícones SVG, textos via t().
import React, { useCallback, useEffect, useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import SheetKeyboardAvoider from './chat/SheetKeyboardAvoider'; // [2026-10-22 kb-uniforme] Android: folha/diálogo acima do teclado (iOS igual)
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing } from '../constants/theme';
import { IconCloudCheck, IconLock, IconKey, IconAlertTriangle, IconCheck } from './Icons';
import * as ownBackup from '../services/ownBackup';
import { fmtBytes, fmtDate, errorText, ProgressBar } from './OwnBackupCard';
import { skipRestoreV4 } from './CloudBackupCard'; // [cbk4d] pular = decisão gravada; obrigatória = confirma

/**
 * @param {{ visible:boolean, candidate:{email:string,set:object,hasPassword:boolean}|null, onClose:()=>void }} props
 */
export default function OwnBackupRestorePrompt({ visible, candidate, onClose }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [secret, setSecret] = useState('');
  const [useKey, setUseKey] = useState(false);
  const [stage, setStage] = useState('ask'); // ask | restoring | done | error
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);

  const set = candidate?.set || null;
  const passwordMode = !!candidate?.hasPassword && !useKey;
  // [backup-nuvem 2026-10-22] candidato v4 (services/cloudBackup): mesma senha/chave; chave no aparelho → não pede.
  const v4 = candidate?.v === 4;
  const needSecret = !(v4 && candidate?.hasKey);
  const mandatory = v4 && !!candidate?.mandatory; // [cbk4d] servidor sem histórico (store-and-forward)
  const skip = useCallback(async () => { if (v4 && !(await skipRestoreV4(t, candidate))) return; onClose?.(); }, [v4, t, candidate, onClose]);

  useEffect(() => { if (visible) { setStage('ask'); setError(null); setSecret(''); setResult(null); setUseKey(!candidate?.hasPassword); } }, [visible, candidate]);

  const restore = useCallback(async () => {
    if (!set || (needSecret && !secret)) return;
    setError(null); setStage('restoring'); setProgress({ phase: 'restore', done: 0, total: set.msg_count || 0 });
    if (v4) {
      const cb = require('../services/cloudBackup');
      const unsub = cb.subscribe((p) => { if (p && (p.phase === 'restore' || p.phase === 'restored') && p.total) setProgress({ phase: 'restore', done: p.done || 0, total: p.total || 0 }); });
      try {
        const isKey = !passwordMode || !!ownBackup.parseRecoveryKey(secret);
        const cred = secret ? (isKey ? { recoveryKey: secret } : { password: secret }) : {};
        await cb.unlock(set, { email: candidate.email, ...cred });
        const r = await cb.restore(set, { email: candidate.email });
        setResult({ restored: r.msg_count, media: r.media_count }); setStage('done');
      } catch (e) {
        const left = e?.attemptsLeft;
        setError(errorText(t, e) + (left != null && e?.code === 'ERR_BAD_PASSWORD' ? ` ${t('ownBackup.attemptsLeft', { n: left })}` : ''));
        setStage('ask');
      } finally { unsub(); }
      return;
    }
    try {
      const u = await ownBackup.unlockBackup({
        uid: set.uid, manifest: set.manifest,
        password: passwordMode && !ownBackup.parseRecoveryKey(secret) ? secret : undefined,
        recoveryKey: !passwordMode || ownBackup.parseRecoveryKey(secret) ? secret : undefined,
      }, candidate.email);
      // [2026-10-18 bg-sync] destravou → restaura em 2º plano e fecha (faixa discreta na lista).
      if (globalThis.__chatyy_bg_restore !== false) {
        ownBackup.restoreInBackground(set.uid, { manifest: u.manifest, email: candidate.email });
        onClose?.();
        return;
      }
      const r = await ownBackup.restoreBackup(set.uid, { manifest: u.manifest, email: candidate.email, onProgress: setProgress });
      setResult(r); setStage('done');
    } catch (e) {
      const left = e?.attemptsLeft;
      setError(errorText(t, e) + (left != null && e?.code === 'ERR_BAD_PASSWORD' ? ` ${t('ownBackup.attemptsLeft', { n: left })}` : ''));
      setStage('ask');
    }
  }, [set, secret, passwordMode, candidate, t, onClose, v4, needSecret]);

  if (!visible || !set) return null;
  const busy = stage === 'restoring';

  return (
    <Modal visible transparent animationType="fade" onRequestClose={busy ? undefined : (mandatory ? skip : onClose)}>
      <SheetKeyboardAvoider style={[st.backdrop]}>
        <View style={[st.sheet, { backgroundColor: colors.background, borderColor: colors.border }]} testID="ownbk-restore-prompt">
          <View style={st.row}>
            {stage === 'done' ? <IconCheck size={22} color={colors.text} /> : <IconCloudCheck size={22} color={colors.text} />}
            <Text style={[st.title, { color: colors.text }]}>
              {stage === 'done' ? t('ownBackup.restoreDoneTitle') : t('ownBackup.restorePromptTitle')}
            </Text>
          </View>

          {stage === 'done' ? (
            <Text style={[st.body, { color: colors.text }]} testID="ownbk-restore-done">
              {v4 ? t('cbk4.restoredMedia', '{n} mensagens e {m} arquivos de mídia restaurados.').replace('{n}', String(result?.restored || 0)).replace('{m}', String(result?.media || 0))
                : t('ownBackup.restoredNotice', { n: result?.restored || 0 })}
            </Text>
          ) : (
            <>
              <Text style={[st.body, { color: colors.text }]} testID="ownbk-restore-summary">
                {t('ownBackup.restorePromptBody', { date: fmtDate(set.created_at), n: set.msg_count, size: fmtBytes(set.size_bytes) })}
              </Text>
              {mandatory ? (
                <Text style={[st.small, { color: colors.textSecondary, marginTop: Spacing.sm }]} testID="ownbk-restore-mandatory">
                  {t('cbk4.mandatoryHint', 'Suas conversas antigas só existem neste backup: o Chatyy não guarda mensagens depois de entregues.')}
                </Text>
              ) : null}
              {needSecret ? (<>
              <View style={[st.row, { marginTop: Spacing.sm }]}>
                {passwordMode ? <IconLock size={14} color={colors.textSecondary} /> : <IconKey size={14} color={colors.textSecondary} />}
                <Text style={[st.small, { color: colors.textSecondary, flex: 1 }]}>
                  {passwordMode ? t('ownBackup.unlockHintPassword') : t('ownBackup.unlockHintKey')}
                </Text>
              </View>
              <TextInput
                testID="ownbk-restore-input"
                value={secret}
                onChangeText={setSecret}
                editable={!busy}
                secureTextEntry={passwordMode}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={passwordMode ? t('ownBackup.passwordPlaceholder') : t('ownBackup.keyPlaceholder')}
                placeholderTextColor={colors.textSecondary}
                style={[st.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                onSubmitEditing={restore}
              />
              {candidate?.hasPassword ? (
                <TouchableOpacity disabled={busy} onPress={() => { setUseKey(!useKey); setSecret(''); setError(null); }} testID="ownbk-restore-toggle">
                  <Text style={[st.link, { color: colors.text }]}>{useKey ? t('ownBackup.usePasswordInstead') : t('ownBackup.useKeyInstead')}</Text>
                </TouchableOpacity>
              ) : null}
              </>) : null}
              {busy ? <ProgressBar progress={progress || { phase: 'restore' }} colors={colors} t={t} /> : null}
              {error ? (
                <View style={[st.row, { marginTop: Spacing.sm }]} testID="ownbk-restore-error">
                  <IconAlertTriangle size={14} color={colors.text} />
                  <Text style={[st.small, { color: colors.text, flex: 1 }]}>{error}</Text>
                </View>
              ) : null}
            </>
          )}

          <View style={st.actions}>
            {stage === 'done' ? (
              <TouchableOpacity testID="ownbk-restore-continue" style={[st.btn, { backgroundColor: colors.text }]} onPress={onClose}>
                <Text style={[st.btnText, { color: colors.background }]}>{t('ownBackup.continue')}</Text>
              </TouchableOpacity>
            ) : (
              <>
                <TouchableOpacity testID="ownbk-restore-skip" disabled={busy && !v4} style={[st.btn, { borderWidth: 1, borderColor: colors.text, opacity: busy && !v4 ? 0.4 : 1 }]} onPress={v4 && busy ? onClose : skip}>
                  <Text style={[st.btnText, { color: colors.text }]}>{v4 && busy ? t('cbk4.continueInApp', 'Continuar usando o app') : mandatory ? t('cbk4.skip', 'Pular') : t('ownBackup.notNow')}</Text>
                </TouchableOpacity>
                <TouchableOpacity testID="ownbk-restore-go" disabled={busy || (needSecret && !secret)} style={[st.btn, { backgroundColor: colors.text, opacity: busy || (needSecret && !secret) ? 0.45 : 1 }]} onPress={restore}>
                  {busy ? <ActivityIndicator color={colors.background} /> : <Text style={[st.btnText, { color: colors.background }]}>{t('ownBackup.restore')}</Text>}
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </SheetKeyboardAvoider>
    </Modal>
  );
}

const st = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: Spacing.lg },
  sheet: { width: '100%', maxWidth: 440, borderRadius: BorderRadius.lg || 14, borderWidth: 1, padding: Spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: FontSize.lg || 18, fontWeight: '700', flex: 1 },
  body: { fontSize: FontSize.md || 15, lineHeight: 21, marginTop: Spacing.md },
  small: { fontSize: FontSize.sm || 13, lineHeight: 18 },
  link: { fontSize: FontSize.sm || 13, textDecorationLine: 'underline', marginTop: 6 },
  input: { borderWidth: 1, borderRadius: BorderRadius.md || 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: FontSize.md || 15, marginTop: Spacing.sm },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: Spacing.lg },
  btn: { paddingVertical: 11, paddingHorizontal: 18, borderRadius: BorderRadius.md || 10, minWidth: 110, alignItems: 'center' },
  btnText: { fontSize: FontSize.md || 15, fontWeight: '600' },
});
