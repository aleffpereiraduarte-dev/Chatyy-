/**
 * /email-outbox — "Caixa de saída" [2026-10-08 email-outbox]
 *
 * Lists e-mails waiting in the durable device outbox (services/emailOutbox):
 * sent while offline, while attachments were still uploading, or after a
 * network/5xx failure. They go out automatically on reconnect / foreground;
 * here the user can force a retry, edit (reopens the composer and removes the
 * entry) or delete. Scoped to the ACTIVE account only.
 */
import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, FlatList, Platform } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { USE_NATIVE_HEADER, nativeHeaderOptions, HeaderBackButton } from '../components/nativeHeader'; // [2026-10-09 native-sheets-headers]
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { Spacing, BorderRadius, FontSize } from '../constants/theme';
import { IconSend, IconPaperclip, IconAlertTriangle, IconWifiOff, IconRotateCw, IconEdit, IconTrash } from '../components/Icons';
import ModalHeader from '../components/ModalHeader';
import { useConfirm } from '../components/ConfirmModal';
import {
  subscribeEmailOutbox, getEmailOutbox, retryOutboxEmail, deleteOutboxEmail,
  takeOutboxEmailForEdit, drainEmailOutbox, isEmailDeviceOffline,
} from '../services/emailOutbox';
import { setEmailComposeRestore } from '../services/emailUndo';

export default function EmailOutboxScreen() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const confirm = useConfirm();
  const [items, setItems] = useState(getEmailOutbox());
  const [offline, setOffline] = useState(isEmailDeviceOffline());

  useEffect(() => subscribeEmailOutbox((list) => setItems([...(list || [])])), []);
  useEffect(() => {
    drainEmailOutbox().catch(() => {});
    const id = setInterval(() => setOffline(isEmailDeviceOffline()), 3000);
    return () => clearInterval(id);
  }, []);

  const onDelete = useCallback(async (csid) => {
    const msg = t('emailOutbox.deleteConfirm');
    const ok = Platform.OS === 'web'
      ? (typeof window !== 'undefined' && window.confirm(msg))
      : await confirm({ title: t('emailOutbox.delete'), message: msg, confirmLabel: t('emailOutbox.delete'), destructive: true });
    if (ok) await deleteOutboxEmail(csid);
  }, [confirm, t]);

  const onEdit = useCallback(async (csid) => {
    const r = await takeOutboxEmailForEdit(csid);
    if (!r) return;
    setEmailComposeRestore(r);
    try { router.push({ pathname: '/compose', params: { restore_undo: '1' } }); } catch {}
  }, [router]);

  const statusOf = (e) => {
    if (e.status === 'sending') return { text: t('emailOutbox.statusSending'), color: colors.primary, Icon: IconSend };
    if (e.status === 'failed') {
      const why = e.lastError === 'attachment_lost' ? t('emailOutbox.attachmentLost') : (e.lastError || '');
      return { text: t('emailOutbox.statusFailed') + (why ? ' · ' + why : ''), color: colors.error, Icon: IconAlertTriangle };
    }
    if (offline || e.lastError === 'offline') return { text: t('emailOutbox.statusOffline'), color: colors.textSecondary, Icon: IconWifiOff };
    if ((e.attempts || 0) > 0) return { text: t('emailOutbox.statusRetry', { n: e.attempts }), color: colors.warning || colors.textSecondary, Icon: IconRotateCw };
    return { text: t('emailOutbox.statusQueued'), color: colors.textSecondary, Icon: IconSend };
  };

  const renderItem = ({ item: e }) => {
    const st = statusOf(e);
    const nAtt = (e.attachments || []).length;
    const busy = e.status === 'sending';
    return (
      <View style={[s.card, { backgroundColor: colors.surface || colors.background, borderColor: colors.borderLight }]}>
        <Text style={[s.subject, { color: colors.text }]} numberOfLines={1}>
          {e.subject || t('emailOutbox.noSubject')}
        </Text>
        <Text style={[s.meta, { color: colors.textSecondary }]} numberOfLines={1}>
          {t('emailOutbox.to', { to: e.to })}
        </Text>
        {nAtt > 0 && (
          <View style={s.row}>
            <IconPaperclip size={13} color={colors.textTertiary} />
            <Text style={[s.meta, { color: colors.textTertiary, marginLeft: 4 }]}>{t('emailOutbox.attachments', { n: nAtt })}</Text>
          </View>
        )}
        <View style={[s.row, { marginTop: 6 }]}>
          <st.Icon size={14} color={st.color} />
          <Text style={[s.status, { color: st.color }]} numberOfLines={2}>{st.text}</Text>
        </View>
        <View style={s.actions}>
          <TouchableOpacity disabled={busy} onPress={() => retryOutboxEmail(e.csid)} style={[s.btn, { backgroundColor: colors.primaryLight, opacity: busy ? 0.5 : 1 }]} accessibilityRole="button">
            <IconRotateCw size={14} color={colors.primary} />
            <Text style={[s.btnText, { color: colors.primary }]}>{t('emailOutbox.retryNow')}</Text>
          </TouchableOpacity>
          <TouchableOpacity disabled={busy} onPress={() => onEdit(e.csid)} style={[s.btn, { backgroundColor: colors.surfaceVariant, opacity: busy ? 0.5 : 1 }]} accessibilityRole="button">
            <IconEdit size={14} color={colors.text} />
            <Text style={[s.btnText, { color: colors.text }]}>{t('emailOutbox.edit')}</Text>
          </TouchableOpacity>
          <TouchableOpacity disabled={busy} onPress={() => onDelete(e.csid)} style={[s.btn, { backgroundColor: colors.errorBg, opacity: busy ? 0.5 : 1 }]} accessibilityRole="button">
            <IconTrash size={14} color={colors.error} />
            <Text style={[s.btnText, { color: colors.error }]}>{t('emailOutbox.delete')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <View style={[s.root, { backgroundColor: colors.background }]}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({ colors, isDark, title: t('emailOutbox.title') })} />
      ) : (
        <ModalHeader title={t('emailOutbox.title')} onClose={() => router.back()} />
      )}
      <FlatList
        data={items}
        keyExtractor={(e) => e.csid}
        renderItem={renderItem}
        contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 48, gap: Spacing.md, flexGrow: 1 }}
        ListEmptyComponent={(
          <View style={s.empty}>
            <IconSend size={28} color={colors.textTertiary} />
            <Text style={[s.emptyTitle, { color: colors.text }]}>{t('emailOutbox.empty')}</Text>
            <Text style={[s.emptyHint, { color: colors.textSecondary }]}>{t('emailOutbox.emptyHint')}</Text>
          </View>
        )}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: BorderRadius.lg, padding: Spacing.md },
  subject: { fontSize: FontSize.base, fontWeight: '600' },
  meta: { fontSize: FontSize.sm, marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  status: { fontSize: FontSize.sm, marginLeft: 6, flex: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginTop: Spacing.md },
  btn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: BorderRadius.full },
  btnText: { fontSize: FontSize.sm, fontWeight: '600' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 64, paddingHorizontal: 24 },
  emptyTitle: { fontSize: FontSize.base, fontWeight: '600', marginTop: 12 },
  emptyHint: { fontSize: FontSize.sm, textAlign: 'center', marginTop: 6, lineHeight: 19 },
});
