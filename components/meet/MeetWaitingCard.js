// [2026-10-15 meet-v2] "Aguardando participantes" — aparece quando você está sozinho na sala.
// Link copiável + Compartilhar convite (share sheet nativo) + QR code. P&B, sem emoji.
import { memo, useState, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, Share, Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { IconCopy, IconShare, IconX, IconCheck } from '../Icons';

let QRCode = null;
try { QRCode = require('react-native-qrcode-svg').default; } catch {}

function MeetWaitingCard({ t, link, title, onClose }) {
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);

  const copy = useCallback(async () => {
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) await navigator.clipboard.writeText(link);
      else await Clipboard.setStringAsync(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  }, [link]);

  const share = useCallback(async () => {
    const message = t('meetV2.inviteMsg', { title: title || t('meet.title'), link });
    try {
      if (Platform.OS === 'web') {
        if (typeof navigator !== 'undefined' && navigator.share) { await navigator.share({ title: title || '', text: message, url: link }); return; }
        await copy();
        return;
      }
      await Share.share(Platform.OS === 'ios' ? { message, url: link } : { message });
    } catch {}
  }, [t, title, link, copy]);

  return (
    <View style={s.card} accessibilityRole="summary">
      {onClose ? (
        <Pressable onPress={onClose} hitSlop={10} style={s.close} accessibilityRole="button" accessibilityLabel={t('common.close')}>
          <IconX size={16} color="rgba(255,255,255,0.6)" />
        </Pressable>
      ) : null}
      <Text style={s.title}>{t('meetV2.waitingTitle')}</Text>
      <Text style={s.sub}>{t('meetV2.waitingSub')}</Text>

      {showQr && QRCode ? (
        <View style={s.qrWrap}>
          <QRCode value={link} size={156} color="#000" backgroundColor="#fff" ecl="M" />
        </View>
      ) : null}

      <Pressable onPress={copy} style={({ pressed }) => [s.linkRow, pressed && { opacity: 0.75 }]} accessibilityRole="button" accessibilityLabel={t('meet.copyLink')}>
        <Text style={s.linkText} numberOfLines={1}>{link.replace(/^https?:\/\//, '')}</Text>
        <View style={s.copyBtn}>
          {copied ? <IconCheck size={15} color="#000" /> : <IconCopy size={15} color="#000" />}
          <Text style={s.copyText}>{copied ? t('meetV2.linkCopied') : t('meet.copyLink')}</Text>
        </View>
      </Pressable>

      <View style={s.row}>
        <Pressable onPress={share} style={({ pressed }) => [s.primary, pressed && { opacity: 0.85 }]} accessibilityRole="button" accessibilityLabel={t('meetV2.shareInvite')}>
          <IconShare size={17} color="#000" />
          <Text style={s.primaryText} numberOfLines={1}>{t('meetV2.shareInvite')}</Text>
        </Pressable>
        {QRCode ? (
          <Pressable onPress={() => setShowQr((v) => !v)} style={({ pressed }) => [s.secondary, showQr && s.secondaryOn, pressed && { opacity: 0.85 }]} accessibilityRole="button" accessibilityLabel={t('meetV2.qrCode')} accessibilityState={{ expanded: showQr }}>
            <Text style={[s.secondaryText, showQr && { color: '#000' }]}>{t('meetV2.qrCode')}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export default memo(MeetWaitingCard);

const s = StyleSheet.create({
  card: {
    width: '100%', maxWidth: 380, padding: 22, paddingTop: 24, borderRadius: 24,
    backgroundColor: 'rgba(18,18,18,0.94)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
  },
  close: { position: 'absolute', top: 12, right: 12, padding: 4 },
  title: { color: '#fff', fontSize: 19, fontWeight: '700', textAlign: 'center', letterSpacing: -0.2 },
  sub: { color: 'rgba(255,255,255,0.6)', fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 6, marginBottom: 18 },
  qrWrap: { padding: 12, backgroundColor: '#fff', borderRadius: 16, marginBottom: 16 },
  linkRow: {
    alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingLeft: 14, paddingRight: 6, paddingVertical: 6, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.08)',
  },
  linkText: { flex: 1, color: 'rgba(255,255,255,0.75)', fontSize: 13.5 },
  copyBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#fff', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 },
  copyText: { color: '#000', fontSize: 13, fontWeight: '700' },
  row: { alignSelf: 'stretch', flexDirection: 'row', gap: 10, marginTop: 12 },
  primary: { flex: 1, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff', borderRadius: 14, paddingVertical: 13 },
  primaryText: { color: '#000', fontSize: 15, fontWeight: '700' },
  secondary: { paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.12)' },
  secondaryOn: { backgroundColor: '#fff' },
  secondaryText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
