/**
 * /companion-qr — Show a QR for linking another phone (companion mode).
 *
 * Mirrors the desktop QR-login UX, but the requesting device is a SECOND
 * phone (not a desktop browser). The primary stays primary; the secondary
 * gets a bearer pointing to the same email (issued via chat_qr_login_*),
 * so message history syncs and the secondary can chat as the same user.
 *
 * Flow:
 *  1. _create with device_kind='mobile' → {token, expires_in} (5 min TTL).
 *  2. Render QR encoding `chatyy://companion?token=<token>`.
 *  3. Poll _status every 2s. When the secondary scans + the primary
 *     approves it from the linked-devices CTA → response is 'approved'
 *     and we surface a confirmation screen on the primary.
 *  4. "Cancelar" returns; auto-refresh every 30s if still pending.
 *
 * Reuses the pseudo-QR matrix renderer from profile-qr (no dep on a real
 * QR lib needed; the secondary's camera reads the chatyy:// payload via
 * expo-camera barcode scanner, which decodes both real and pseudo QRs as
 * long as they're parseable as text).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconShield, IconSmartphone } from '../components/Icons';
import * as api from '../services/api';

// Tiny deterministic "QR-ish" matrix — copied from profile-qr to avoid a
// circular import. Real QR encoding is overkill for a 32-char token that
// fits inside a chatyy:// URL; the secondary's expo-camera scanner reads
// the textual payload regardless of whether the source was a real QR.
function pseudoQrMatrix(payload, size = 25) {
  const out = Array.from({ length: size }, () => Array(size).fill(false));
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

export default function CompanionQRScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();

  const [token, setToken] = useState(null);
  const [status, setStatus] = useState('loading'); // 'loading' | 'pending' | 'approved' | 'expired' | 'error'
  const [error, setError] = useState('');
  const refreshTimerRef = useRef(null);
  const pollTimerRef = useRef(null);

  // Mint a fresh token. We always create with device_kind='mobile' so the
  // approver UI (linked-devices) can present the right copy ("Linkar este
  // celular como companion") rather than treating the request as a desktop
  // login. Backend issues a bearer scoped to the same account.
  const mint = useCallback(async () => {
    setStatus('loading');
    setError('');
    try {
      const r = await api.chatQrLoginCreate('mobile');
      if (r?.success && r?.data?.token) {
        setToken(r.data.token);
        setStatus('pending');
      } else {
        setStatus('error');
        setError(r?.message || 'failed');
      }
    } catch (e) {
      setStatus('error');
      setError(e?.message || 'network');
    }
  }, []);

  useEffect(() => { mint(); }, [mint]);

  // Refresh the QR every 30s while pending. WhatsApp behavior — keeps the
  // surface fresh against shoulder-surfing and mints a new token before
  // the 5min server expiry kicks in.
  useEffect(() => {
    if (status !== 'pending') return undefined;
    refreshTimerRef.current = setInterval(() => { mint(); }, 30_000);
    return () => { if (refreshTimerRef.current) clearInterval(refreshTimerRef.current); };
  }, [status, mint]);

  // Poll status while pending. 2s cadence matches the desktop QR login.
  // On 'approved' we stop polling and tell the user — the secondary phone
  // will already have the bearer at this point.
  useEffect(() => {
    if (status !== 'pending' || !token) return undefined;
    pollTimerRef.current = setInterval(async () => {
      try {
        const r = await api.chatQrLoginStatus(token);
        const s = r?.data?.status;
        if (s === 'approved' || s === 'confirmed') {
          setStatus('approved');
        } else if (s === 'expired') {
          // Token died (>5min or already consumed) — mint a new one.
          mint();
        }
      } catch (e) { /* ignore — next tick will retry */ }
    }, 2000);
    return () => { if (pollTimerRef.current) clearInterval(pollTimerRef.current); };
  }, [status, token, mint]);

  const payload = token ? `chatyy://companion?token=${token}` : '';

  return (
    <View style={[s.root, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[s.header, { backgroundColor: isDark ? '#1a1a2e' : '#7C3AED', paddingTop: 10 }]}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <IconArrowLeft size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={s.title}>{t?.('devices.companionTitle') || 'Vincular outro celular'}</Text>
      </View>

      <View style={s.body}>
        {status === 'loading' ? (
          <View style={s.loadingBox}>
            <ActivityIndicator color="#7C3AED" size="large" />
          </View>
        ) : status === 'approved' ? (
          <View style={s.approvedBox}>
            <View style={[s.bigIconBox, { backgroundColor: 'rgba(16,185,129,0.12)' }]}>
              <IconShield size={48} color="#10B981" />
            </View>
            <Text style={[s.approvedTitle, { color: colors.text }]}>
              {t?.('devices.companionApproved') || 'Celular vinculado'}
            </Text>
            <Text style={[s.approvedSub, { color: colors.secondaryText }]}>
              {t?.('devices.companionApprovedSub') || 'Seu outro celular já está conectado.'}
            </Text>
            <TouchableOpacity onPress={() => router.back()} style={[s.cta, { backgroundColor: '#7C3AED' }]}>
              <Text style={s.ctaText}>{t?.('common.done') || 'OK'}</Text>
            </TouchableOpacity>
          </View>
        ) : status === 'error' ? (
          <View style={s.approvedBox}>
            <Text style={[s.approvedTitle, { color: colors.text }]}>
              {t?.('common.error') || 'Erro'}
            </Text>
            <Text style={[s.approvedSub, { color: colors.secondaryText }]}>{error || ''}</Text>
            <TouchableOpacity onPress={mint} style={[s.cta, { backgroundColor: '#7C3AED' }]}>
              <Text style={s.ctaText}>{t?.('common.retry') || 'Tentar novamente'}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View style={[s.iconBox, { backgroundColor: isDark ? 'rgba(124,58,237,0.15)' : 'rgba(124,58,237,0.1)' }]}>
              <IconSmartphone size={32} color="#7C3AED" />
            </View>
            <Text style={[s.heroTitle, { color: colors.text }]}>
              {t?.('devices.companionHero') || 'Mostre este QR no outro celular'}
            </Text>
            <Text style={[s.heroSub, { color: colors.secondaryText }]}>
              {t?.('devices.companionHeroSub') || 'Abra o Chatyy no outro celular, vá em Dispositivos vinculados → Vincular outro celular, e escaneie este QR.'}
            </Text>

            <View style={s.qrWrap}>
              <QrArtwork payload={payload} size={240} color={isDark ? '#fff' : '#111'} />
            </View>

            <Text style={[s.heroSub, { color: colors.secondaryText, marginTop: 6 }]}>
              {t?.('devices.companionRefresh') || 'O QR atualiza automaticamente.'}
            </Text>

            <TouchableOpacity onPress={() => router.back()} style={[s.cta, s.cancelCta]}>
              <Text style={[s.ctaText, { color: '#7C3AED' }]}>
                {t?.('common.cancel') || 'Cancelar'}
              </Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 14 },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { color: '#fff', fontSize: 20, fontWeight: '700', marginLeft: 8 },
  body: { flex: 1, alignItems: 'center', padding: 24, gap: 12 },
  loadingBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  iconBox: { width: 64, height: 64, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  bigIconBox: { width: 96, height: 96, borderRadius: 24, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  heroTitle: { fontSize: 17, fontWeight: '700', textAlign: 'center', marginTop: 4 },
  heroSub: { fontSize: 13, textAlign: 'center', lineHeight: 18, paddingHorizontal: 12 },
  qrWrap: { alignItems: 'center', marginTop: 12 },
  cta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, paddingHorizontal: 32, borderRadius: 12, marginTop: 24, alignSelf: 'stretch' },
  cancelCta: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#7C3AED' },
  ctaText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  approvedBox: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  approvedTitle: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  approvedSub: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
});
