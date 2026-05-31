/**
 * /profile-qr — Show the user's contact QR + scan others.
 *
 * Payload format: chatyy://add-contact?email={user.email}&name={user.name}
 * Other users (or any compatible scanner) can scan it to start a chat
 * straight away. Uses expo-camera's built-in barcode scanner — already
 * relied on elsewhere in the app (chat-new.js, inbox.js, login.js).
 *
 * QR rendering: uses react-native-qrcode-svg (real QR w/ error correction)
 * so the artwork is actually scannable by any camera app — not just the
 * in-app scanner. Falls back gracefully if the lib isn't bundled.
 */
import React, { useMemo, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform,
  Share, ScrollView, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { Spacing, BorderRadius } from '../constants/theme';
import { IconX, IconShare, IconCamera, IconUserPlus } from './../components/Icons';
import AvatarCircle from './../components/AvatarCircle';
import { getAvatarUrlForEmail } from '../services/api';

// Lazy-load react-native-qrcode-svg so an environment without it (or web
// SSR without react-native-svg) doesn't crash. Real QRs are preferred but
// not required for the screen to render.
let QRCode = null;
try {
  QRCode = require('react-native-qrcode-svg').default;
} catch {}

// Lazy-load expo-camera so web doesn't crash if it's not bundled.
let CameraView = null;
let useCameraPermissions = null;
try {
  const cam = require('expo-camera');
  CameraView = cam.CameraView;
  useCameraPermissions = cam.useCameraPermissions;
} catch {}

function buildPayload(email, name) {
  const params = new URLSearchParams({ email: email || '' });
  if (name) params.set('name', name);
  return `chatyy://add-contact?${params.toString()}`;
}

// [WA-parity 2026-05-31] Canonical PUBLIC web URL for a profile so the link
// works outside the app (browser, other messengers). Prefers an @handle; falls
// back to the email local-part. The web route /u/<id> resolves it server-side
// (deep-links into the app on devices that have it). We don't invent a backend
// endpoint here — just emit the canonical universal URL.
function buildProfileWebUrl(user) {
  const handle = String(user?.handle || user?.username || '').replace(/^@/, '').trim();
  const email = String(user?.email || '').trim();
  const slug = handle || (email.includes('@') ? email.split('@')[0] : email);
  return `https://chatyy.com.br/u/${encodeURIComponent(slug || 'me')}`;
}

function QrArtwork({ payload, size = 240, color = '#111', backgroundColor = '#fff', logoUri = '' }) {
  // Real QR via react-native-qrcode-svg. Embeds the avatar as a center logo
  // so the QR doubles as a profile card (WhatsApp / Telegram parity).
  if (QRCode) {
    return (
      <View style={{ padding: 12, backgroundColor, borderRadius: 12 }}>
        <QRCode
          value={payload}
          size={size}
          color={color}
          backgroundColor={backgroundColor}
          {...(logoUri ? { logo: { uri: logoUri }, logoSize: 48, logoBackgroundColor: backgroundColor, logoBorderRadius: 24, logoMargin: 2 } : {})}
        />
      </View>
    );
  }
  // Fallback when the lib isn't bundled — render a neutral placeholder
  // and rely on the share/copy action instead of pretending it's a QR.
  return (
    <View style={{ width: size, height: size, backgroundColor, padding: 8, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color, fontSize: 12, textAlign: 'center', paddingHorizontal: 16 }}>{payload}</Text>
    </View>
  );
}

export default function ProfileQRScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [mode, setMode] = useState('show'); // 'show' | 'scan'
  const [scanned, setScanned] = useState(false);
  // Always-call shape so hook order stays stable. The fallback no-op hook
  // returns [null, () => {}] when expo-camera isn't bundled (web).
  const _useCamPerm = useCameraPermissions || (() => [null, () => {}]);
  const [permission, requestPermission] = _useCamPerm();

  const payload = buildPayload(user?.email || '', user?.name || '');
  // [WA-parity 2026-05-31] public web URL for share-link CTA (works outside app).
  const profileWebUrl = buildProfileWebUrl(user);

  const handleShare = async () => {
    try {
      await Share.share({
        message: `${t('profile.qrSharePrefix') || 'Adicione-me no Chatyy:'} ${payload}`,
      });
    } catch (e) { /* dismissed */ }
  };

  // [WA-parity 2026-05-31] Share a PUBLIC https link to the profile (WhatsApp
  // "share your link" parity). Uses the native Share sheet so it lands in any
  // app/browser, not just the in-app QR scanner.
  const handleShareLink = async () => {
    try {
      await Share.share({
        message: `${t('profile.qrLinkSharePrefix') || 'Veja meu perfil no Chatyy:'} ${profileWebUrl}`,
        url: profileWebUrl, // iOS surfaces this as a rich link
      });
    } catch (e) { /* dismissed */ }
  };

  const handleScanned = ({ data }) => {
    if (scanned) return;
    setScanned(true);
    if (typeof data !== 'string' || !data.startsWith('chatyy://add-contact')) {
      Alert.alert(t('profile.qrCode') || 'QR de contato', t('profile.qrInvalid') || 'QR inválido');
      setTimeout(() => setScanned(false), 1200);
      return;
    }
    try {
      const q = data.split('?')[1] || '';
      const params = new URLSearchParams(q);
      const email = params.get('email') || '';
      const name = params.get('name') || email.split('@')[0];
      if (!email || !email.includes('@')) {
        Alert.alert(t('profile.qrCode') || 'QR de contato', t('profile.qrInvalid') || 'QR inválido');
        setScanned(false);
        return;
      }
      // Open chat with that contact.
      router.push(`/chat-conversation?email=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}`);
    } catch (e) {
      Alert.alert(t('profile.qrCode') || 'QR de contato', t('profile.qrInvalid') || 'QR inválido');
      setScanned(false);
    }
  };

  return (
    <View style={[s.root, { backgroundColor: colors.background }]}>
      <View style={[s.header, { borderBottomColor: colors.borderLight }]}>
        <TouchableOpacity onPress={() => router.back()} style={s.iconBtn}>
          <IconX size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[s.title, { color: colors.text }]}>{t('profile.qrCode') || 'QR de contato'}</Text>
        <View style={s.iconBtn} />
      </View>

      <View style={[s.tabs, { borderColor: colors.borderLight }]}>
        <TouchableOpacity
          style={[s.tab, mode === 'show' && { backgroundColor: '#7C3AED' }]}
          onPress={() => setMode('show')}
        >
          <Text style={[s.tabText, { color: mode === 'show' ? '#fff' : colors.text }]}>
            {t('profile.myQr') || 'Meu QR'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.tab, mode === 'scan' && { backgroundColor: '#7C3AED' }]}
          onPress={() => { setMode('scan'); setScanned(false); }}
        >
          <Text style={[s.tabText, { color: mode === 'scan' ? '#fff' : colors.text }]}>
            {t('profile.scanQr') || 'Escanear'}
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={s.body}>
        {mode === 'show' ? (
          <>
            <View style={{ alignItems: 'center', marginTop: 12 }}>
              <AvatarCircle email={user?.email} name={user?.name} size={72} />
              <Text style={[s.name, { color: colors.text }]}>{user?.name || user?.email?.split('@')[0]}</Text>
              <Text style={[s.email, { color: colors.textSecondary }]}>{user?.email}</Text>
            </View>

            <View style={{ alignItems: 'center', marginTop: 24 }}>
              <QrArtwork
                payload={payload}
                size={240}
                color={isDark ? '#fff' : '#000'}
                backgroundColor={isDark ? '#000' : '#fff'}
                logoUri={user?.email ? getAvatarUrlForEmail(user.email) : ''}
              />
            </View>

            <Text style={[s.hint, { color: colors.textSecondary }]}>
              {t('profile.qrHint') || 'Outros usuários podem escanear pra te adicionar'}
            </Text>

            <TouchableOpacity onPress={handleShare} style={[s.cta, { backgroundColor: '#7C3AED' }]}>
              <IconShare size={18} color="#fff" />
              <Text style={s.ctaText}>{t('profile.shareQr') || 'Compartilhar QR'}</Text>
            </TouchableOpacity>

            {/* [WA-parity 2026-05-31] Share a public https profile link */}
            <TouchableOpacity
              onPress={handleShareLink}
              style={[s.cta, s.ctaSecondary, { borderColor: '#7C3AED', marginTop: 12 }]}
            >
              <IconShare size={18} color="#7C3AED" />
              <Text style={[s.ctaText, { color: '#7C3AED' }]}>{t('profile.shareLink') || 'Compartilhar link'}</Text>
            </TouchableOpacity>
          </>
        ) : (
          <View style={{ flex: 1, alignItems: 'center', paddingTop: 12 }}>
            {Platform.OS !== 'web' && CameraView ? (
              permission?.granted ? (
                <View style={s.scanBox}>
                  <CameraView
                    style={StyleSheet.absoluteFill}
                    facing="back"
                    barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                    onBarcodeScanned={scanned ? undefined : handleScanned}
                  />
                  <View style={s.scanFrame} />
                </View>
              ) : (
                <View style={{ alignItems: 'center', padding: 24 }}>
                  <IconCamera size={48} color={colors.textSecondary} />
                  <Text style={[s.hint, { color: colors.textSecondary, marginTop: 12 }]}>
                    {t('profile.qrCameraNeeded') || 'Permissão de câmera necessária'}
                  </Text>
                  <TouchableOpacity onPress={requestPermission} style={[s.cta, { backgroundColor: '#7C3AED' }]}>
                    <Text style={s.ctaText}>{t('profile.grantCamera') || 'Permitir câmera'}</Text>
                  </TouchableOpacity>
                </View>
              )
            ) : (
              <View style={{ alignItems: 'center', padding: 24 }}>
                <IconUserPlus size={48} color={colors.textSecondary} />
                <Text style={[s.hint, { color: colors.textSecondary, marginTop: 12 }]}>
                  {t('profile.qrScanWebUnavailable') || 'Use o aplicativo móvel pra escanear'}
                </Text>
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1 },
  title: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700' },
  iconBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  tabs: { flexDirection: 'row', margin: 12, borderRadius: BorderRadius.lg, borderWidth: 1, overflow: 'hidden' },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  tabText: { fontSize: 14, fontWeight: '700' },
  body: { padding: 16, paddingBottom: 40 },
  name: { fontSize: 18, fontWeight: '700', marginTop: 10 },
  email: { fontSize: 13, marginTop: 2 },
  hint: { fontSize: 13, textAlign: 'center', marginTop: 12, paddingHorizontal: 24 },
  cta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: BorderRadius.lg, marginTop: 20, alignSelf: 'stretch' },
  ctaSecondary: { backgroundColor: 'transparent', borderWidth: 1.5 }, // [WA-parity 2026-05-31]
  ctaText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  scanBox: { width: 280, height: 280, borderRadius: 18, overflow: 'hidden', backgroundColor: '#000' },
  scanFrame: { ...StyleSheet.absoluteFillObject, borderRadius: 18, borderWidth: 2, borderColor: '#fff', margin: 30 },
});
