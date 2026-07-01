/**
 * AccountSwitcherSheet — WhatsApp/browser-style multi-account switcher.
 *
 * The whole multi-account engine (roster, token-first switch, cross-account
 * cache wipe, Face ID rotation) already lives in AuthContext.switchAccount /
 * removeAccount + api.getStoredAccounts. Until now it was only surfaced in the
 * EMAIL inbox menu (app/inbox.js). This sheet is a reusable entry point so the
 * same switcher can be dropped anywhere in the main app (Settings, chat header).
 *
 * Behavior:
 *  - Lists the ACTIVE account first, highlighted with a check ("focus one").
 *  - Lists the other stored accounts — tap to switch.
 *  - Switch failure (expired token) routes to /login?add_account=1 prefilled so
 *    the user just re-enters their password.
 *  - "Adicionar conta" → /login?add_account=1 (keeps the current session).
 *  - Long-press / trash on a non-active row removes it.
 */
import React, { useCallback } from 'react';
import {
  Modal, View, Text, TouchableOpacity, StyleSheet, Platform, Alert, ScrollView, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useMail } from '../context/MailContext';
import AvatarCircle from './AvatarCircle';
import { IconPlus, IconLogout, IconCheck, IconX } from './Icons';

export default function AccountSwitcherSheet({ visible, onClose }) {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { user, accounts, switchAccount, removeAccount, switching } = useAuth();
  // MailContext is optional — this sheet can mount on screens outside the mail
  // provider (defensive: don't crash if the hook is unavailable there).
  let resetMailState;
  try { ({ resetMailState } = useMail() || {}); } catch {}

  const activeEmail = (user?.email || '').toLowerCase();
  const others = (accounts || []).filter(a => (a.email || '').toLowerCase() !== activeEmail);

  const goReLogin = useCallback((email) => {
    onClose?.();
    const q = email ? `&email=${encodeURIComponent(email)}` : '';
    router.push(`/login?add_account=1${q}`);
  }, [onClose, router]);

  const handleSwitch = useCallback(async (email) => {
    if (switching) return;
    try {
      const result = await switchAccount(email);
      if (result && result.success) {
        try { resetMailState?.(); } catch {}
        onClose?.();
      } else {
        // Token expired / server refused — send them to re-login (session kept)
        goReLogin(email);
      }
    } catch {
      goReLogin(email);
    }
  }, [switching, switchAccount, resetMailState, onClose, goReLogin]);

  const handleRemove = useCallback((email) => {
    const title = t('account.removeTitle') || 'Desvincular conta';
    const msg = `${t('account.removeMessage') || 'Deseja desvincular a conta'} ${email}?`;
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${msg}`)) removeAccount(email);
    } else {
      Alert.alert(title, msg, [
        { text: t('account.cancel') || 'Cancelar', style: 'cancel' },
        { text: t('account.remove') || 'Remover', style: 'destructive', onPress: () => removeAccount(email) },
      ]);
    }
  }, [t, removeAccount]);

  const handleAdd = useCallback(() => { goReLogin(); }, [goReLogin]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={[s.sheet, { backgroundColor: colors.surface }]} onPress={() => {}}>
          {/* grabber + header */}
          <View style={[s.grabber, { backgroundColor: colors.border }]} />
          <View style={s.headerRow}>
            <Text style={[s.title, { color: colors.text }]}>{t('account.switchTitle') || 'Trocar conta'}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <IconX size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
            {/* Active account — highlighted ("focus one") */}
            <View style={[s.row, s.activeRow, { backgroundColor: colors.primary + '12', borderColor: colors.primary + '40' }]}>
              <AvatarCircle name={user?.name || user?.email || '?'} email={user?.email} size={44} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={[s.name, { color: colors.text }]} numberOfLines={1}>
                  {user?.name || user?.email?.split('@')[0]}
                </Text>
                <Text style={[s.email, { color: colors.textTertiary }]} numberOfLines={1}>{user?.email}</Text>
              </View>
              <View style={[s.checkBadge, { backgroundColor: colors.primary }]}>
                <IconCheck size={14} color="#fff" strokeWidth={3} />
              </View>
            </View>

            {/* Other accounts */}
            {others.map(acc => (
              <TouchableOpacity
                key={acc.email}
                style={[s.row, { borderColor: colors.borderLight }]}
                activeOpacity={0.6}
                onPress={() => handleSwitch(acc.email)}
                onLongPress={() => handleRemove(acc.email)}
                disabled={switching}
              >
                <AvatarCircle name={acc.name || acc.email || '?'} email={acc.email} size={44} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={[s.name, { color: colors.text }]} numberOfLines={1}>
                    {acc.name || acc.email?.split('@')[0]}
                  </Text>
                  <Text style={[s.email, { color: colors.textTertiary }]} numberOfLines={1}>{acc.email}</Text>
                </View>
                <TouchableOpacity
                  onPress={() => handleRemove(acc.email)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={[s.trashBtn, { backgroundColor: colors.error + '12' }]}
                >
                  <IconLogout size={16} color={colors.error} />
                </TouchableOpacity>
              </TouchableOpacity>
            ))}

            {/* Add account */}
            <TouchableOpacity
              style={[s.row, s.addRow, { borderTopColor: colors.borderLight }]}
              activeOpacity={0.6}
              onPress={handleAdd}
              disabled={switching}
            >
              <View style={[s.addIcon, { backgroundColor: colors.primary + '15' }]}>
                <IconPlus size={22} color={colors.primary} />
              </View>
              <Text style={[s.name, { color: colors.primary, marginLeft: 12, fontWeight: '600' }]}>
                {t('account.add') || 'Adicionar conta'}
              </Text>
            </TouchableOpacity>
          </ScrollView>

          {switching && (
            <View style={[s.switchingOverlay, { backgroundColor: colors.surface + 'E6' }]}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={[s.switchingText, { color: colors.text }]}>
                {t('account.switching', { email: '' }) || 'Entrando...'}
              </Text>
            </View>
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 16, paddingBottom: 28, paddingTop: 8,
    ...(Platform.OS === 'web' ? { maxWidth: 460, width: '100%', alignSelf: 'center' } : {}),
  },
  grabber: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 12 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, paddingHorizontal: 2 },
  title: { fontSize: 18, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 8, borderRadius: 14 },
  activeRow: { borderWidth: 1, marginBottom: 6 },
  addRow: { borderTopWidth: StyleSheet.hairlineWidth, borderRadius: 0, marginTop: 6, paddingTop: 16 },
  name: { fontSize: 15, fontWeight: '600' },
  email: { fontSize: 12, marginTop: 1 },
  checkBadge: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  trashBtn: { padding: 8, borderRadius: 8 },
  addIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  switchingOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
  switchingText: { marginTop: 12, fontSize: 14, fontWeight: '600' },
});
