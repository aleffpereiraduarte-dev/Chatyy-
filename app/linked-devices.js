import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, Platform, Modal } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { IconArrowLeft, IconShield, IconMonitor, IconSmartphone, IconCamera, IconUserPlus, IconX } from '../components/Icons';
import * as api from '../services/api';
import { loadDeviceRegistry, installAppStateHook } from '../services/deviceRegistry';
import FadeSlideIn from '../components/FadeSlideIn';
import PressableScale from '../components/PressableScale';

// Lazy-load expo-camera so web doesn't crash if it's not bundled. Same
// pattern as profile-qr.js / chat-new.js.
let CameraView = null;
let useCameraPermissions = null;
try {
  const cam = require('expo-camera');
  CameraView = cam.CameraView;
  useCameraPermissions = cam.useCameraPermissions;
} catch {}

function parseUserAgent(ua) {
  if (!ua) return { device: '', os: '', browser: '', ip: '' };
  let device = 'Desktop';
  let os = '';
  let browser = '';
  let ip = '';
  if (/iPhone|iPad|iPod/i.test(ua)) { device = 'iPhone/iPad'; os = 'iOS'; }
  else if (/Android/i.test(ua)) { device = 'Android'; os = 'Android'; }
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac OS/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';
  if (/Chatyy.*iOS/i.test(ua)) browser = 'Chatyy iOS';
  else if (/Chatyy.*Android/i.test(ua)) browser = 'Chatyy Android';
  else if (/Chatyy/i.test(ua)) browser = 'Chatyy App';
  else if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome/i.test(ua)) browser = 'Chrome';
  else if (/Safari/i.test(ua)) browser = 'Safari';
  else if (/Firefox/i.test(ua)) browser = 'Firefox';
  // Some servers stuff "ip=1.2.3.4" or trailing "(1.2.3.4)" into the UA blob
  const ipMatch = ua.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
  if (ipMatch) ip = ipMatch[1];
  return { device, os, browser, ip };
}

// i18n-aware relative time. `ts` is a Unix timestamp in SECONDS. Falls back
// to PT-BR when no `t` is supplied. Uses the proven files.time*Ago keys (they
// already carry the {n} placeholder and exist across locales) instead of the
// shared formatRelativeTime() — that helper has a latent "{n}" leak when called
// without params, and it expects epoch-ms not seconds.
function relativeTime(ts, t) {
  try {
    const d = new Date(ts * 1000);
    if (isNaN(d.getTime())) return '';
    const now = Date.now();
    const diff = Math.floor((now - d.getTime()) / 1000);
    if (diff < 60) return t?.('devices.activeNow') || 'ativo agora';
    if (diff < 3600) return t?.('files.timeMinAgo', { n: Math.floor(diff/60) }) || `${Math.floor(diff/60)} min`;
    if (diff < 86400) return t?.('files.timeHrAgo', { n: Math.floor(diff/3600) }) || `${Math.floor(diff/3600)}h`;
    if (diff < 604800) return t?.('files.timeDaysAgo', { n: Math.floor(diff/86400) }) || `${Math.floor(diff/86400)}d`;
    return d.toLocaleDateString();
  } catch { return ''; }
}

export default function LinkedDevicesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();

  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState(null);
  // Companion-mode scanner state. We use the same modal-camera shape that
  // profile-qr.js / chat-new.js do — lazy-loaded expo-camera, with a
  // fallback message for web where it can't bundle.
  const [scanOpen, setScanOpen] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const _useCamPerm = useCameraPermissions || (() => [null, () => {}]);
  const [permission, requestPermission] = _useCamPerm();

  const load = useCallback(async () => {
    setLoading(true);
    // sessions_list requires auth; on a cold mount the auth can lag a tick
    // behind the screen (QA robot flagged a transient 401 here). Preflight:
    // wait for auth to be READY before the FIRST request so it goes out authed.
    // [2026-07-12] On WEB there is NO bearer (getAuthToken() is empty forever —
    // web authenticates via session cookie), so the old bearer-only gate never
    // satisfied and the first fetch raced the cookie → 401 logged to console
    // even though the retry recovered. Now we treat auth as ready when EITHER a
    // bearer exists (native) OR the AuthContext user is hydrated (web cookie is
    // established once user.email is present). Never fire an unauthed request.
    const _authReady = () => (typeof api.getAuthToken === 'function' && api.getAuthToken()) || !!user?.email;
    for (let w = 0; w < 20 && !_authReady(); w++) {
      await new Promise((res) => setTimeout(res, 100));
    }
    // Retry a couple times with a short backoff so we never surface an unauthed miss.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Still not authed? Don't fire (would 401 + log to console) — wait + retry.
        if (!_authReady()) { await new Promise((res) => setTimeout(res, 400 * (attempt + 1))); continue; }
        const r = await api.apiCall('sessions_list');
        if (r?.success && r.data) {
          const list = Array.isArray(r.data) ? r.data : (r.data.sessions || []);
          setSessions(list);
          break;
        }
        if (r && r.success === false && attempt < 2) {
          await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
          continue;
        }
        break;
      } catch (e) {
        if (attempt < 2) { await new Promise((res) => setTimeout(res, 400 * (attempt + 1))); continue; }
        console.warn('[devices] load:', e);
      }
    }
    setLoading(false);
  }, [user?.email]);

  useEffect(() => { load(); }, [load]);

  // Stage 2 of SQLite-first chat migration: warm the per-device pubkey
  // registry on this screen mount so the phone always sees the most
  // recent linked-device list, and install the AppState=active hook
  // (idempotent — calling more than once is a no-op) so subsequent
  // foregrounds refresh the cache for free.
  useEffect(() => {
    installAppStateHook();
    loadDeviceRegistry({ force: true }).catch(() => {});
  }, []);

  // Companion-mode scanner handler. Decodes the chatyy://companion?token=...
  // payload from a sibling phone, calls _approve from this primary device,
  // and the secondary picks up the bearer via its _status poll. We pass
  // device_kind='mobile' explicitly so the backend marks the row as a
  // mobile-to-mobile pair (the secondary's create call already did the
  // same, so this is a belt-and-suspenders check).
  const handleScanned = ({ data }) => {
    if (scanned || scanBusy) return;
    if (typeof data !== 'string' || !data.startsWith('chatyy://companion')) {
      // Reject anything else silently — the contact-QR scanner in /profile-qr
      // handles "chatyy://add-contact" links; we shouldn't accept either side
      // by mistake.
      return;
    }
    setScanned(true);
    setScanBusy(true);
    (async () => {
      try {
        const q = data.split('?')[1] || '';
        const params = new URLSearchParams(q);
        const token = params.get('token') || '';
        if (!token || !/^[a-f0-9]{32}$/.test(token)) {
          throw new Error('invalid token');
        }
        const r = await api.chatQrLoginApprove(token, 'mobile');
        if (!r?.success) throw new Error(r?.message || 'approve_failed');
        setScanOpen(false);
        const okMsg = t('devices.companionLinkedTitle') || 'Celular vinculado';
        const okBody = t('devices.companionLinkedBody') || 'O outro celular já está conectado.';
        if (Platform.OS === 'web') {
          if (window?.alert) window.alert(`${okMsg}\n\n${okBody}`);
        } else {
          Alert.alert(okMsg, okBody);
        }
        // Reload sessions list — the new device should show up there.
        load();
      } catch (e) {
        const errTitle = t('common.error') || 'Erro';
        const errBody = (e?.message) || 'failed';
        if (Platform.OS === 'web') {
          if (window?.alert) window.alert(`${errTitle}: ${errBody}`);
        } else {
          Alert.alert(errTitle, errBody);
        }
      } finally {
        setScanBusy(false);
        // Allow another scan attempt without re-mounting the camera.
        setTimeout(() => setScanned(false), 800);
      }
    })();
  };

  const openScanner = async () => {
    if (Platform.OS === 'web' || !CameraView) {
      const msg = t('profile.qrScanWebUnavailable') || 'Use o aplicativo móvel pra escanear';
      if (Platform.OS === 'web') {
        if (window?.alert) window.alert(msg);
      } else {
        Alert.alert(t('common.notice') || 'Aviso', msg);
      }
      return;
    }
    if (!permission?.granted) {
      const r = await requestPermission?.();
      if (!r?.granted) return;
    }
    setScanned(false);
    setScanOpen(true);
  };

  const revoke = (session) => {
    const confirmFn = Platform.OS === 'web'
      ? (cb) => { if (window.confirm(t('devices.confirmRevoke') || 'Remove this device?')) cb(); }
      : (cb) => Alert.alert(
          t('devices.confirmRevokeTitle') || 'Remove device',
          t('devices.confirmRevoke') || 'This device will be signed out immediately.',
          [
            { text: t('common.cancel') || 'Cancel', style: 'cancel' },
            { text: t('common.remove') || 'Remove', style: 'destructive', onPress: cb },
          ]
        );

    confirmFn(async () => {
      // Biometric gate: removing a linked device is destructive — it
      // signs the other surface out and rotates session state. If a thief
      // grabs the phone while it's unlocked they could otherwise kick the
      // legitimate user off every other device. Face ID / passcode first.
      try {
        const { confirmWithBiometric } = require('../services/biometricGate');
        const ok = await confirmWithBiometric({
          reason: t('devices.confirmRevokeTitle') || 'Remove device',
        });
        if (!ok) return;
      } catch {}
      setRevoking(session.id || session.token_hash);
      try {
        await api.apiCall('revoke_session', { session_id: session.id || session.token_hash }, 'POST');
        await load();
      } catch (e) {
        console.warn('[devices] revoke:', e);
      }
      setRevoking(null);
    });
  };

  const revokeAll = () => {
    const confirmFn = Platform.OS === 'web'
      ? (cb) => { if (window.confirm(t('devices.confirmRevokeAll') || 'Sign out all other devices?')) cb(); }
      : (cb) => Alert.alert(
          t('devices.confirmRevokeAllTitle') || 'Sign out all other devices',
          t('devices.confirmRevokeAll') || 'All devices except this one will be signed out.',
          [
            { text: t('common.cancel') || 'Cancel', style: 'cancel' },
            { text: t('common.confirm') || 'Confirm', style: 'destructive', onPress: cb },
          ]
        );

    confirmFn(async () => {
      try {
        await api.apiCall('revoke_all_sessions', {}, 'POST');
        await load();
      } catch (e) { console.warn('[devices] revokeAll:', e); }
    });
  };

  const renderSession = ({ item }) => {
    const parsed = parseUserAgent(item.user_agent || '');
    const isCurrent = !!item.is_current;
    const Icon = /iPhone|Android|Mobile/i.test(parsed.device) ? IconSmartphone : IconMonitor;
    // Each row surfaces: device label, browser/app, IP, last active relative.
    // Falls back to em-dash when the field isn't on the response (don't mint
    // backend fields — the audit only allows display polish).
    const deviceLabel = parsed.device || item.device_name || (t('devices.unknownDevice') || 'Dispositivo desconhecido');
    const browserLabel = parsed.browser || item.app_name || '—';
    const ipLabel = item.ip || parsed.ip || '—';
    const lastActiveLabel = relativeTime(item.last_active || item.last_seen || item.created_at, t) || '—';

    return (
      <View style={[styles.row, { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}>
        <View style={[styles.iconBox, { backgroundColor: isDark ? 'rgba(124,58,237,0.15)' : 'rgba(124,58,237,0.1)' }]}>
          <Icon size={22} color="#7C3AED" />
        </View>
        <View style={styles.rowBody}>
          <View style={styles.rowHead}>
            <Text style={[styles.rowName, { color: colors.text }]} numberOfLines={1}>
              {deviceLabel}
            </Text>
            {isCurrent && (
              <View style={styles.currentBadge}>
                <Text style={styles.currentBadgeText}>
                  {t('devices.thisDevice') || 'This device'}
                </Text>
              </View>
            )}
          </View>
          <Text style={[styles.rowMeta, { color: colors.textSecondary }]} numberOfLines={1}>
            {browserLabel}{parsed.os ? ` · ${parsed.os}` : ''} · IP {ipLabel}
          </Text>
          <Text style={[styles.rowTime, { color: colors.textSecondary }]}>
            {lastActiveLabel}
          </Text>
        </View>
        {!isCurrent && (
          <TouchableOpacity onPress={() => revoke(item)} disabled={revoking === (item.id || item.token_hash)} style={styles.signOutBtn}>
            {revoking === (item.id || item.token_hash)
              ? <ActivityIndicator color="#EF4444" size="small" />
              : <Text style={styles.signOutText}>{t('devices.signOut') || 'Sign out'}</Text>}
          </TouchableOpacity>
        )}
      </View>
    );
  };

  const hasOther = sessions.some(s => !s.is_current);

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { backgroundColor: isDark ? '#1a1a2e' : '#7C3AED', paddingTop: 10 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <IconArrowLeft size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>{t('devices.title') || 'Linked devices'}</Text>
      </View>

      <FadeSlideIn>
      <View style={[styles.hero, { backgroundColor: isDark ? 'rgba(124,58,237,0.1)' : 'rgba(124,58,237,0.06)' }]}>
        <IconShield size={40} color="#7C3AED" />
        <Text style={[styles.heroTitle, { color: colors.text }]}>
          {t('devices.heroTitle') || 'Keep your account secure'}
        </Text>
        <Text style={[styles.heroSub, { color: colors.textSecondary }]}>
          {t('devices.heroSub') || 'Check devices where you are signed in and sign out the ones you don\'t recognize.'}
        </Text>
      </View>

      {/* Companion-mode CTAs. Two paths into the same /chat_qr_login_*
          flow: (a) "Mostrar QR" — this primary becomes the show-side and the
          OTHER phone scans, then THIS device approves via the URL handler;
          (b) "Escanear QR de outro celular" — opens the camera to consume a
          chatyy://companion?token=... payload from a sibling phone and
          confirms the link from here. WhatsApp/Telegram offer both
          directions; we mirror that. */}
      <View style={styles.ctaRow}>
        <PressableScale
          style={[styles.ctaBtn, { backgroundColor: '#7C3AED' }]}
          onPress={() => router.push('/companion-qr')}
        >
          <IconUserPlus size={18} color="#fff" />
          <Text style={styles.ctaBtnText}>
            {t('devices.linkAnotherPhone') || 'Vincular outro celular'}
          </Text>
        </PressableScale>
        <TouchableOpacity
          style={[styles.ctaBtn, styles.ctaBtnSecondary, { borderColor: '#7C3AED' }]}
          onPress={openScanner}
        >
          <IconCamera size={18} color="#7C3AED" />
          <Text style={[styles.ctaBtnText, { color: '#7C3AED' }]}>
            {t('devices.scanCompanion') || 'Escanear QR'}
          </Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loading}><ActivityIndicator color="#7C3AED" size="large" /></View>
      ) : (
        <>
          <FlatList
            data={sessions}
            keyExtractor={(s, i) => String(s.id || s.token_hash || i)}
            renderItem={renderSession}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={
              <View style={styles.emptyWrap}>
                <View style={[styles.emptyIconBox, { backgroundColor: isDark ? 'rgba(124,58,237,0.15)' : 'rgba(124,58,237,0.1)' }]}>
                  <IconMonitor size={34} color="#7C3AED" />
                </View>
                <Text style={[styles.emptyTitle, { color: colors.text }]}>
                  {t('devices.emptyTitle') || 'Apenas este dispositivo'}
                </Text>
                <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                  {t('devices.empty') || 'Only this device is signed in.'}
                </Text>
              </View>
            }
          />
          {hasOther && (
            <TouchableOpacity onPress={revokeAll} style={[styles.revokeAllBtn, { marginBottom: 16 + insets.bottom }]}>
              <Text style={styles.revokeAllText}>
                {t('devices.signOutAll') || 'Sign out all other devices'}
              </Text>
            </TouchableOpacity>
          )}
        </>
      )}
      </FadeSlideIn>

      {/* Camera-scan modal for the "I want to scan another phone" flow. We
          keep this inline (rather than a separate route) so the busy state +
          confirmation alert stays attached to this screen — the user lands
          back on the device list immediately after the link succeeds. */}
      <Modal visible={scanOpen} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setScanOpen(false)}>
        <View style={styles.scanRoot}>
          <View style={styles.scanHeader}>
            <TouchableOpacity onPress={() => setScanOpen(false)} style={styles.backBtn}>
              <IconX size={24} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.scanTitle}>
              {t('devices.scanCompanion') || 'Escanear QR'}
            </Text>
          </View>
          {Platform.OS !== 'web' && CameraView && permission?.granted ? (
            <View style={styles.cameraBox}>
              <CameraView
                style={StyleSheet.absoluteFill}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={scanned ? undefined : handleScanned}
              />
              <View style={styles.scanFrame} />
              {scanBusy && (
                <View style={styles.scanBusy}>
                  <ActivityIndicator color="#fff" size="large" />
                </View>
              )}
            </View>
          ) : (
            <View style={styles.scanFallback}>
              <IconCamera size={48} color="#fff" />
              <Text style={styles.scanFallbackText}>
                {t('profile.qrCameraNeeded') || 'Permissão de câmera necessária'}
              </Text>
            </View>
          )}
          <Text style={styles.scanHint}>
            {t('devices.scanHint') || 'Aponte para o QR mostrado no outro celular.'}
          </Text>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 14 },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, color: '#fff', fontSize: 20, fontWeight: '700', marginLeft: 8 },
  hero: { alignItems: 'center', padding: 20, gap: 8 },
  heroTitle: { fontSize: 17, fontWeight: '700', textAlign: 'center' },
  heroSub: { fontSize: 13, textAlign: 'center', lineHeight: 18 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  // flex:1 bounds the list to the space between the CTA row and the sticky
  // "Sign out all" footer so it scrolls internally — without it the list
  // rendered at full content height and its tail drew UNDER the footer
  // button (last row clipped). paddingBottom keeps the final row clear of
  // the footer even mid-scroll.
  list: { flex: 1 },
  listContent: { paddingBottom: 8 },
  row: { flexDirection: 'row', padding: 16, gap: 12, alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  iconBox: { width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  rowBody: { flex: 1, minWidth: 0 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowName: { flexShrink: 1, fontSize: 15, fontWeight: '600' },
  currentBadge: { flexShrink: 0, backgroundColor: '#10B981', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  currentBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  rowMeta: { fontSize: 13, marginTop: 2 },
  rowTime: { fontSize: 12, marginTop: 4 },
  signOutBtn: { flexShrink: 0, marginLeft: 4, paddingHorizontal: 12, paddingVertical: 8 },
  signOutText: { color: '#EF4444', fontSize: 13, fontWeight: '600' },
  emptyWrap: { alignItems: 'center', paddingTop: 40, paddingHorizontal: 32, gap: 10 },
  emptyIconBox: { width: 64, height: 64, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: 16, fontWeight: '700', textAlign: 'center', marginTop: 6 },
  emptyText: { textAlign: 'center', fontSize: 13, paddingHorizontal: 16 },
  revokeAllBtn: { margin: 16, padding: 14, borderRadius: 12, backgroundColor: '#FEF2F2', alignItems: 'center', borderWidth: 1, borderColor: '#FEE2E2' },
  revokeAllText: { color: '#EF4444', fontSize: 14, fontWeight: '700' },
  ctaRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 8 },
  ctaBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, borderRadius: 12 },
  ctaBtnSecondary: { backgroundColor: 'transparent', borderWidth: 1 },
  ctaBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  scanRoot: { flex: 1, backgroundColor: '#000' },
  scanHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 50, paddingBottom: 14 },
  scanTitle: { color: '#fff', fontSize: 18, fontWeight: '700', marginLeft: 8 },
  cameraBox: { flex: 1, backgroundColor: '#000' },
  scanFrame: { position: 'absolute', top: '20%', left: '15%', right: '15%', bottom: '20%', borderRadius: 18, borderWidth: 2, borderColor: '#fff' },
  scanBusy: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' },
  scanFallback: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  scanFallbackText: { color: '#fff', fontSize: 14, paddingHorizontal: 32, textAlign: 'center' },
  scanHint: { color: '#fff', textAlign: 'center', fontSize: 13, padding: 16 },
});
