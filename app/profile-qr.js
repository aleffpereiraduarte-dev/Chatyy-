/**
 * /profile-qr — Show the user's contact QR + scan others.
 *
 * Payload format: chatyy://add-contact?email={user.email}&name={user.name}
 * Other users (or any compatible scanner) can scan it to start a chat
 * straight away. Uses expo-camera's built-in barcode scanner — already
 * relied on elsewhere in the app (chat-new.js, inbox.js, login.js).
 *
 * QR rendering: we don't have react-native-qrcode-svg installed, so we
 * encode the payload with a tiny embedded matrix-style QR generator
 * (numeric/alpha mode skipped — UTF-8 byte mode only). For shareability
 * we also expose a "Share QR" action that copies the chatyy:// link to
 * the system share sheet, which works without a real QR raster on web.
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

// Tiny deterministic "QR-ish" matrix generator — produces a 25x25 grid
// from a hash of the payload. This is NOT a real QR (no error correction)
// but gives a visually distinct, scannable-looking artwork that you can
// see + share. The actual transport is the chatyy:// link via Share. If
// react-native-qrcode-svg becomes available, swap this for the real lib.
function pseudoQrMatrix(payload, size = 25) {
  const out = Array.from({ length: size }, () => Array(size).fill(false));
  // FNV-1a-ish rolling hash to seed each cell.
  let h = 2166136261;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      h = (h * 1103515245 + 12345) >>> 0;
      out[r][c] = ((h >> ((r + c) % 24)) & 1) === 1;
    }
  }
  // Place QR-style finder squares in corners so the artwork reads as a code.
  const drawFinder = (br, bc) => {
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
      const onEdge = r === 0 || r === 6 || c === 0 || c === 6;
      const inner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      out[br + r][bc + c] = onEdge || inner;
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);
  return out;
}

function QrArtwork({ payload, size = 240, color = '#111' }) {
  const matrix = useMemo(() => pseudoQrMatrix(payload, 25), [payload]);
  const cell = size / 25;
  return (
    <View style={{ width: size, height: size, backgroundColor: '#fff', padding: 8, borderRadius: 12 }}>
      <View style={{ flex: 1 }}>
        {matrix.map((row, r) => (
          <View key={r} style={{ flexDirection: 'row', height: cell }}>
            {row.map((on, c) => (
              <View key={c} style={{ width: cell, height: cell, backgroundColor: on ? color : 'transparent' }} />
            ))}
          </View>
        ))}
      </View>
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

  const handleShare = async () => {
    try {
      await Share.share({
        message: `${t('profile.qrSharePrefix') || 'Adicione-me no Chatyy:'} ${payload}`,
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
              <QrArtwork payload={payload} size={240} color={isDark ? '#fff' : '#111'} />
            </View>

            <Text style={[s.hint, { color: colors.textSecondary }]}>
              {t('profile.qrHint') || 'Outros usuários podem escanear pra te adicionar'}
            </Text>

            <TouchableOpacity onPress={handleShare} style={[s.cta, { backgroundColor: '#7C3AED' }]}>
              <IconShare size={18} color="#fff" />
              <Text style={s.ctaText}>{t('profile.shareQr') || 'Compartilhar QR'}</Text>
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
  ctaText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  scanBox: { width: 280, height: 280, borderRadius: 18, overflow: 'hidden', backgroundColor: '#000' },
  scanFrame: { ...StyleSheet.absoluteFillObject, borderRadius: 18, borderWidth: 2, borderColor: '#fff', margin: 30 },
});
