import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconShield, IconMonitor, IconSmartphone } from '../components/Icons';
import * as api from '../services/api';

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

function relativeTime(ts) {
  try {
    const d = new Date(ts * 1000);
    if (isNaN(d.getTime())) return '';
    const now = Date.now();
    const diff = Math.floor((now - d.getTime()) / 1000);
    if (diff < 60) return 'ativo agora';
    if (diff < 3600) return `${Math.floor(diff/60)} min`;
    if (diff < 86400) return `${Math.floor(diff/3600)}h atrás`;
    if (diff < 604800) return `${Math.floor(diff/86400)}d atrás`;
    return d.toLocaleDateString();
  } catch { return ''; }
}

export default function LinkedDevicesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();

  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.apiCall('sessions_list');
      if (r?.success && r.data) {
        const list = Array.isArray(r.data) ? r.data : (r.data.sessions || []);
        setSessions(list);
      }
    } catch (e) { console.warn('[devices] load:', e); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

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
    const isCurrent = item.is_current;
    const Icon = /iPhone|Android|Mobile/i.test(parsed.device) ? IconSmartphone : IconMonitor;
    // Each row surfaces: device label, browser/app, IP, last active relative.
    // Falls back to em-dash when the field isn't on the response (don't mint
    // backend fields — the audit only allows display polish).
    const deviceLabel = parsed.device || item.device_name || (t('devices.unknownDevice') || 'Dispositivo desconhecido');
    const browserLabel = parsed.browser || item.app_name || '—';
    const ipLabel = item.ip || parsed.ip || '—';
    const lastActiveLabel = relativeTime(item.last_active || item.last_seen || item.created_at) || '—';

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
          <Text style={[styles.rowMeta, { color: colors.secondaryText }]} numberOfLines={1}>
            {browserLabel}{parsed.os ? ` · ${parsed.os}` : ''} · IP {ipLabel}
          </Text>
          <Text style={[styles.rowTime, { color: colors.secondaryText }]}>
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
        <Text style={styles.title}>{t('devices.title') || 'Linked devices'}</Text>
      </View>

      <View style={[styles.hero, { backgroundColor: isDark ? 'rgba(124,58,237,0.1)' : 'rgba(124,58,237,0.06)' }]}>
        <IconShield size={40} color="#7C3AED" />
        <Text style={[styles.heroTitle, { color: colors.text }]}>
          {t('devices.heroTitle') || 'Keep your account secure'}
        </Text>
        <Text style={[styles.heroSub, { color: colors.secondaryText }]}>
          {t('devices.heroSub') || 'Check devices where you are signed in and sign out the ones you don\'t recognize.'}
        </Text>
      </View>

      {loading ? (
        <View style={styles.loading}><ActivityIndicator color="#7C3AED" size="large" /></View>
      ) : (
        <>
          <FlatList
            data={sessions}
            keyExtractor={(s, i) => String(s.id || s.token_hash || i)}
            renderItem={renderSession}
            ListEmptyComponent={
              <View style={styles.emptyWrap}>
                <View style={[styles.emptyIconBox, { backgroundColor: isDark ? 'rgba(124,58,237,0.15)' : 'rgba(124,58,237,0.1)' }]}>
                  <IconMonitor size={34} color="#7C3AED" />
                </View>
                <Text style={[styles.emptyTitle, { color: colors.text }]}>
                  {t('devices.emptyTitle') || 'Apenas este dispositivo'}
                </Text>
                <Text style={[styles.emptyText, { color: colors.secondaryText }]}>
                  {t('devices.empty') || 'Only this device is signed in.'}
                </Text>
              </View>
            }
          />
          {hasOther && (
            <TouchableOpacity onPress={revokeAll} style={styles.revokeAllBtn}>
              <Text style={styles.revokeAllText}>
                {t('devices.signOutAll') || 'Sign out all other devices'}
              </Text>
            </TouchableOpacity>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 14 },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { color: '#fff', fontSize: 20, fontWeight: '700', marginLeft: 8 },
  hero: { alignItems: 'center', padding: 20, gap: 8 },
  heroTitle: { fontSize: 17, fontWeight: '700', textAlign: 'center' },
  heroSub: { fontSize: 13, textAlign: 'center', lineHeight: 18 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  row: { flexDirection: 'row', padding: 16, gap: 12, alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  iconBox: { width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowName: { fontSize: 15, fontWeight: '600' },
  currentBadge: { backgroundColor: '#10B981', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  currentBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  rowMeta: { fontSize: 13, marginTop: 2 },
  rowTime: { fontSize: 12, marginTop: 4 },
  signOutBtn: { paddingHorizontal: 12, paddingVertical: 8 },
  signOutText: { color: '#EF4444', fontSize: 13, fontWeight: '600' },
  emptyWrap: { alignItems: 'center', paddingTop: 40, paddingHorizontal: 32, gap: 10 },
  emptyIconBox: { width: 64, height: 64, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: 16, fontWeight: '700', textAlign: 'center', marginTop: 6 },
  emptyText: { textAlign: 'center', fontSize: 13, paddingHorizontal: 16 },
  revokeAllBtn: { margin: 16, padding: 14, borderRadius: 12, backgroundColor: '#FEF2F2', alignItems: 'center', borderWidth: 1, borderColor: '#FEE2E2' },
  revokeAllText: { color: '#EF4444', fontSize: 14, fontWeight: '700' },
});
