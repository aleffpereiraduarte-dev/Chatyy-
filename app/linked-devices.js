import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, Platform, Modal } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { USE_NATIVE_HEADER, nativeHeaderOptions } from '../components/nativeHeader'; // [2026-10-09 native-sheets-headers]
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { IconArrowLeft, IconShield, IconMonitor, IconSmartphone, IconCamera, IconUserPlus, IconX } from '../components/Icons';
import * as api from '../services/api';
import * as settingsCache from '../services/settingsCache'; // [2026-10-13 settings-instant]
import { loadDeviceRegistry, installAppStateHook } from '../services/deviceRegistry';
import FadeSlideIn from '../components/FadeSlideIn';
import UIRefreshControl from '../components/ui/RefreshControl';
import { useGroupedColors, SettingsGroup, SettingsRow, SettingsIconTile, SettingsValueText } from '../components/settings/SettingsKit'; // [2026-10-10 settings-polish] [2026-10-17 settings-wa] listas agrupadas

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
  // [2026-10-10 settings-polish] P&B: header claro como as outras telas de
  // Configurações (era barra preta fixa), selo "Este dispositivo" neutro (era
  // verde), CTA primário em tinta do tema (no escuro #111 sumia no fundo preto).
  const g = useGroupedColors();
  const { t } = useLanguage();
  const { user } = useAuth();

  // [2026-10-13 settings-instant] última lista de sessões salva no aparelho
  // (por conta) → abre na hora; spinner só na 1ª vez na vida.
  const [sessions, setSessions] = useState(() => { const c = settingsCache.peek('sessions'); return Array.isArray(c) ? c : []; });
  const [loading, setLoading] = useState(() => settingsCache.peek('sessions') == null);
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
    if (settingsCache.peek('sessions') == null) setLoading(true);
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
          try { settingsCache.put('sessions', list); } catch {}
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
        const r = await api.apiCall('revoke_session', { session_id: session.id || session.token_hash }, 'POST');
        // [2026-10-18 wa-parity] falha (success:false) era muda — o aparelho seguia conectado sem aviso.
        if (r && r.success === false) throw new Error(r.message || r.error || '');
        await load();
      } catch (e) {
        console.warn('[devices] revoke:', e);
        _revokeFailed(e);
      }
      setRevoking(null);
    });
  };

  function _revokeFailed(e) {
    const title = t('common.error') || 'Erro';
    const msg = (e && e.message) || t('devices.revokeFailed') || 'Não foi possível desconectar. Tente de novo.';
    if (Platform.OS === 'web') { try { window.alert(`${title}\n\n${msg}`); } catch {} return; }
    try { Alert.alert(title, msg); } catch {}
  }

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
        const r = await api.apiCall('revoke_all_sessions', {}, 'POST');
        if (r && r.success === false) throw new Error(r.message || r.error || '');
        await load();
      } catch (e) { console.warn('[devices] revokeAll:', e); _revokeFailed(e); }
    });
  };

  // [2026-10-17 settings-wa] Lista agrupada (cartões inset) como o "Aparelhos
  // conectados" do WhatsApp: ações num cartão, sessões noutro (ícone em chip,
  // aparelho + app/SO/IP + última atividade), "Este dispositivo" como valor à
  // direita, tocar numa sessão = sair dela; "Sair de todos" = linha destrutiva
  // centralizada. Antes: linhas soltas de borda a borda, selo verde e botão
  // vermelho claro fixo (#FEF2F2) que brilhava no escuro.
  const [pulling, setPulling] = useState(false);
  const onPull = () => { setPulling(true); Promise.resolve(load()).finally(() => setPulling(false)); };
  const sessionRow = (item, idx) => {
    const parsed = parseUserAgent(item.user_agent || '');
    const isCurrent = !!item.is_current;
    const Icon = /iPhone|Android|Mobile/i.test(parsed.device) ? IconSmartphone : IconMonitor;
    // Falls back to em-dash when the field isn't on the response (don't mint
    // backend fields — the audit only allows display polish).
    const deviceLabel = parsed.device || item.device_name || (t('devices.unknownDevice') || 'Dispositivo desconhecido');
    const browserLabel = parsed.browser || item.app_name || '—';
    const ipLabel = item.ip || parsed.ip || '—';
    const lastActiveLabel = relativeTime(item.last_active || item.last_seen || item.created_at, t) || '';
    const meta = [browserLabel !== '—' ? browserLabel : null, parsed.os || null, ipLabel !== '—' ? `IP ${ipLabel}` : null].filter(Boolean).join(' · ');
    const sub = [meta, lastActiveLabel].filter(Boolean).join('\n') || undefined;
    const sid = item.id || item.token_hash;
    const busy = revoking === sid;
    return (
      <SettingsRow
        key={String(sid || idx)}
        icon={Icon}
        title={deviceLabel}
        subtitle={sub}
        subtitleLines={isCurrent ? 3 : 2 /* [2026-10-17 qa-web] o valor "Este dispositivo" estreita a coluna → meta quebra e cortava "Há 21m" */}
        value={isCurrent ? (t('devices.thisDevice') || 'This device') : undefined}
        chevron={false}
        onPress={isCurrent || busy ? undefined : () => revoke(item)}
        accessibilityLabel={isCurrent ? `${deviceLabel}, ${t('devices.thisDevice') || 'This device'}` : `${deviceLabel}, ${t('devices.signOut') || 'Sign out'}`}
        right={isCurrent ? undefined : (busy
          ? <ActivityIndicator color={g.secondary} size="small" />
          : <SettingsValueText color={g.destructive}>{t('devices.signOut') || 'Sign out'}</SettingsValueText>)}
      />
    );
  };

  const hasOther = sessions.some(s => !s.is_current);

  return (
    <View style={[styles.container, { backgroundColor: g.pageBg, paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }]}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({
          colors, isDark, title: t('devices.title'),
          headerStyle: { backgroundColor: g.pageBg },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: g.pageBg },
        })} />
      ) : (
      <View style={[styles.header, { backgroundColor: g.pageBg, paddingTop: 10, borderBottomColor: g.separator }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel={t('common.back') || 'Voltar'}>
          <IconArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{t('devices.title') || 'Linked devices'}</Text>
      </View>
      )}

      <ScrollView
        style={styles.flex1}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={[styles.scroll, { paddingBottom: 32 + insets.bottom }]}
        refreshControl={Platform.OS === 'web' ? undefined : <UIRefreshControl refreshing={pulling} onRefresh={onPull} tintColor={g.secondary} />}
      >
      <FadeSlideIn>
      <View style={styles.hero}>
        <SettingsIconTile Icon={IconShield} size={64} />
        <Text style={[styles.heroTitle, { color: g.text }]}>
          {t('devices.heroTitle') || 'Keep your account secure'}
        </Text>
        <Text style={[styles.heroSub, { color: g.secondary }]}>
          {t('devices.heroSub') || 'Check devices where you are signed in and sign out the ones you don\'t recognize.'}
        </Text>
      </View>

      {/* Companion-mode CTAs. Two paths into the same /chat_qr_login_*
          flow: (a) "Vincular outro celular" — this primary becomes the
          show-side and the OTHER phone scans; (b) "Escanear QR" — opens the
          camera to consume a chatyy://companion?token=... payload from a
          sibling phone and confirms the link from here. */}
      <SettingsGroup>
        <SettingsRow icon={IconUserPlus} title={t('devices.linkAnotherPhone') || 'Vincular outro celular'} onPress={() => router.push('/companion-qr')} testID="devices-link-phone" />
        <SettingsRow icon={IconCamera} title={t('devices.scanCompanion') || 'Escanear QR'} onPress={openScanner} testID="devices-scan" />
      </SettingsGroup>

      {loading ? (
        <SettingsGroup header={t('profile.activeSessions') || 'Sessões ativas'}>
          <SettingsRow title=" " chevron={false} right={<ActivityIndicator size="small" color={g.secondary} />} />
        </SettingsGroup>
      ) : sessions.length === 0 ? (
        <View style={styles.emptyWrap}>
          <SettingsIconTile Icon={IconMonitor} size={56} muted />
          <Text style={[styles.emptyTitle, { color: g.text }]}>
            {t('devices.emptyTitle') || 'Apenas este dispositivo'}
          </Text>
          <Text style={[styles.emptyText, { color: g.secondary }]}>
            {t('devices.empty') || 'Only this device is signed in.'}
          </Text>
        </View>
      ) : (
        <SettingsGroup header={t('profile.activeSessions') || 'Sessões ativas'}>
          {sessions.map(sessionRow)}
        </SettingsGroup>
      )}
      {!loading && hasOther && (
        <SettingsGroup>
          <SettingsRow title={t('devices.signOutAll') || 'Sign out all other devices'} destructive center onPress={revokeAll} testID="devices-signout-all" />
        </SettingsGroup>
      )}
      </FadeSlideIn>
      </ScrollView>
      {/* Camera-scan modal for the "I want to scan another phone" flow. We
          keep this inline (rather than a separate route) so the busy state +
          confirmation alert stays attached to this screen — the user lands
          back on the device list immediately after the link succeeds. */}
      <Modal visible={scanOpen} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setScanOpen(false)}>
        <View style={styles.scanRoot}>
          <View style={[styles.scanHeader, { paddingTop: Math.max(insets.top, 20) + 10 }]}>
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
  flex1: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontSize: 20, fontWeight: '700', marginLeft: 8 },
  scroll: { paddingHorizontal: 16, paddingTop: 8, width: '100%', maxWidth: 720, alignSelf: 'center' },
  hero: { alignItems: 'center', paddingTop: 12, paddingBottom: 24, paddingHorizontal: 12 },
  heroTitle: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3, textAlign: 'center', marginTop: 14 },
  heroSub: { fontSize: 14, lineHeight: 19, textAlign: 'center', marginTop: 6, maxWidth: 340 },
  emptyWrap: { alignItems: 'center', paddingTop: 16, paddingBottom: 28, paddingHorizontal: 32 },
  emptyTitle: { fontSize: 16, fontWeight: '600', textAlign: 'center', marginTop: 12 },
  emptyText: { textAlign: 'center', fontSize: 14, lineHeight: 19, marginTop: 4 },
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
