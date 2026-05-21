// WalletReceiveSheet — "Receber saldo" sheet.
//
// WAVE 57 (2026-05-21) — single-currency wallet redesign.
// Shows a QR code with the user's pay link, a copy-to-clipboard chip,
// and a native Share button. The link format is:
//   https://chatyy.com.br/pay/<email-or-username>
// Backend isn't required for this surface — the receiver just shares
// the link and the sender opens /wallet → "Enviar" → searches them by
// name/email in the contact list.

import React, { useCallback, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, StyleSheet, Share, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import * as Haptics from 'expo-haptics';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import { IconX, IconCopy, IconShare, IconCheck } from '../Icons';
import AvatarCircle from '../AvatarCircle';

const PURPLE = '#A855F7';
const GREEN  = '#10B981';

function tap(kind = 'light') {
  try {
    if (kind === 'light')  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (kind === 'success') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  } catch {}
}

export default function WalletReceiveSheet({ visible, onClose }) {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const [copied, setCopied] = useState(false);

  const email = String(user?.email || '').toLowerCase();
  const handle = email ? email.split('@')[0] : 'me';
  const link = `https://chatyy.com.br/pay/${encodeURIComponent(email || handle)}`;

  const onCopy = useCallback(async () => {
    try {
      const mod = await import('expo-clipboard').catch(() => null);
      if (mod?.setStringAsync) await mod.setStringAsync(link);
      tap('success');
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  }, [link]);

  const onShare = useCallback(async () => {
    try {
      tap('light');
      await Share.share({
        message: (t('wallet.shareMessage') || 'Me envie saldo no Chatyy: {link}').replace('{link}', link),
        url: link,
      });
    } catch {}
  }, [link, t]);

  const surface = isDark ? '#0B0B0F' : '#F7F7FB';
  const cardBg  = isDark ? '#16161E' : '#FFFFFF';
  const border  = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(15,23,42,0.06)';
  const subtle  = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(15,23,42,0.55)';
  const chipBg  = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.05)';

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.scrim}>
        <View style={[styles.sheet, { backgroundColor: surface, paddingBottom: Math.max(insets.bottom, 18) }]}>
          <View style={styles.handleRow}>
            <View style={[styles.handle, { backgroundColor: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(15,23,42,0.18)' }]} />
          </View>

          <View style={styles.head}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.eyebrow, { color: subtle }]}>{t('wallet.receiveEyebrow') || 'RECEBER'}</Text>
              <Text style={[styles.title, { color: colors.text }]}>{t('wallet.receiveTitle') || 'Receber saldo'}</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={[styles.closeBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.06)' }]} accessibilityRole="button">
              <IconX size={18} color={colors.text} />
            </TouchableOpacity>
          </View>

          {/* User card */}
          <View style={[styles.userCard, { backgroundColor: cardBg, borderColor: border }]}>
            <AvatarCircle size={56} email={email} name={user?.name || handle} />
            <View style={{ flex: 1, marginLeft: 14 }}>
              <Text style={[styles.userName, { color: colors.text }]} numberOfLines={1}>
                {user?.name || handle}
              </Text>
              <Text style={[styles.userHandle, { color: subtle }]} numberOfLines={1}>
                @{handle}
              </Text>
            </View>
          </View>

          {/* QR */}
          <View style={[styles.qrWrap, { backgroundColor: '#fff', borderColor: border }]}>
            <QRCode
              value={link}
              size={200}
              backgroundColor="#FFFFFF"
              color="#0B0B0F"
            />
          </View>

          <Text style={[styles.scanHint, { color: subtle }]}>
            {t('wallet.scanHint') || 'Escaneie o QR para enviar saldo'}
          </Text>

          {/* Link chip */}
          <View style={[styles.linkChip, { backgroundColor: chipBg }]}>
            <Text style={[styles.linkText, { color: colors.text }]} numberOfLines={1}>
              {link.replace('https://', '')}
            </Text>
          </View>

          {/* Actions */}
          <View style={styles.actionsRow}>
            <TouchableOpacity onPress={onCopy} activeOpacity={0.85} style={[styles.action, { backgroundColor: cardBg, borderColor: border }]}>
              {copied ? <IconCheck size={18} color={GREEN} /> : <IconCopy size={18} color={colors.text} />}
              <Text style={[styles.actionText, { color: copied ? GREEN : colors.text }]}>
                {copied ? (t('common.copied') || 'Copiado') : (t('wallet.copyLink') || 'Copiar link')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onShare} activeOpacity={0.9} style={[styles.action, { backgroundColor: PURPLE, borderColor: PURPLE }]}>
              <IconShare size={18} color="#fff" />
              <Text style={[styles.actionText, { color: '#fff' }]}>
                {t('wallet.shareLink') || 'Compartilhar'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: 18, paddingTop: 8,
  },
  handleRow: { alignItems: 'center', paddingVertical: 6 },
  handle: { width: 38, height: 4, borderRadius: 2 },

  head: { flexDirection: 'row', alignItems: 'center', marginBottom: 14, paddingTop: 4 },
  eyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6 },
  title: { fontSize: 22, fontWeight: '800', marginTop: 2 },
  closeBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },

  userCard: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12, paddingHorizontal: 14,
    borderRadius: 18, borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 18,
  },
  userName: { fontSize: 16, fontWeight: '700' },
  userHandle: { fontSize: 13, marginTop: 2 },

  qrWrap: {
    alignSelf: 'center',
    padding: 18,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
  },
  scanHint: { fontSize: 12, textAlign: 'center', marginTop: 12, marginBottom: 14 },

  linkChip: {
    paddingHorizontal: 14, paddingVertical: 12,
    borderRadius: 12, marginBottom: 14,
  },
  linkText: { fontSize: 13, fontWeight: '600', textAlign: 'center' },

  actionsRow: { flexDirection: 'row', gap: 10 },
  action: {
    flex: 1,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  actionText: { fontSize: 14, fontWeight: '700' },
});
