// Scheduled calls — list of upcoming call appointments.
//
// Shows my upcoming scheduled calls (organizer + invitee). Each row:
// title, relative time ("em 2h"), participant avatars, "Iniciar" button
// that's only enabled within ±5min of the slot. Tap row → expand to
// see participants list + cancel option (if I'm organizer).
import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator,
  RefreshControl, Platform, Alert,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { USE_NATIVE_HEADER, nativeHeaderOptions } from '../components/nativeHeader'; // [2026-10-09 native-sheets-headers]
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { Spacing, BorderRadius, FontSize } from '../constants/theme';
import { IconArrowLeft, IconCalendar, IconPhone, IconX, IconClock } from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';
import ScreenEmptyState from '../components/ScreenEmptyState';

// [2026-10-21] tempos relativos/datas passam pelo i18n (eram fixos em pt e dd/mm).
function formatRelative(iso, t) {
  if (!iso) return '';
  const now = Date.now();
  const ts = new Date(iso).getTime();
  if (!ts) return '';
  const diffMin = Math.round((ts - now) / 60000);
  if (diffMin <= -60) { const hh = Math.round(-diffMin / 60); return hh < 24 ? t('calls.rel.hoursAgo', { n: hh, defaultValue: 'há {n} h' }) : t('calls.rel.daysAgo', { n: Math.round(hh / 24), defaultValue: 'há {n} d' }); }
  if (diffMin <= -2) return t('calls.rel.minAgo', { n: Math.abs(diffMin), defaultValue: 'há {n} min' });
  if (diffMin <= 0) return t('calls.rel.now', 'agora');
  if (diffMin < 60) return t('calls.rel.inMin', { n: diffMin, defaultValue: 'em {n} min' });
  const h = Math.round(diffMin / 60);
  if (h < 24) return t('calls.rel.inHours', { n: h, defaultValue: 'em {n} h' });
  const d = Math.round(h / 24);
  return t('calls.rel.inDays', { n: d, defaultValue: 'em {n} d' });
}

function formatDateTime(iso, language) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString(language || undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}

export default function CallScheduleScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { colors, isDark } = useTheme();
  const { t, language } = useLanguage();
  const [calls, setCalls] = useState([]);
  // [2026-10-21] falha de carga ≠ "Nenhuma chamada agendada"
  const [loadErr, setLoadErr] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Force re-render every 30s so the "em Xmin" labels and the Iniciar
  // button enable/disable transitions update without user action.
  const [, setTick] = useState(0);
  const tickRef = useRef(null);

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const r = await api.callScheduleList();
      if (r?.success) {
        setCalls(Array.isArray(r.data?.calls) ? r.data.calls : []);
        setLoadErr(false);
      } else setLoadErr(true);
    } catch { setLoadErr(true); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => {
    load(true);
    tickRef.current = setInterval(() => setTick(n => n + 1), 30000);
    return () => { if (tickRef.current) clearInterval(tickRef.current); };
  }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load(false);
  }, [load]);

  const handleStart = useCallback(async (call) => {
    try {
      const r = await api.callScheduleJoin(call.id);
      if (!r?.success) {
        if (Platform.OS === 'web') {
          window.alert(r?.message || t('scheduleCall.unavailableNow'));
        } else {
          Alert.alert(t('common.error') || 'Erro', r?.message || t('scheduleCall.unavailableNow'));
        }
        return;
      }
      const room = r.data?.room_id || call.room_id;
      const cid = r.data?.conversation_id || call.conversation_id || 0;
      // [2026-10-09 native-group-call] Native group screen when available.
      try {
        const ngc = require('../services/nativeGroupCall');
        if (ngc.canUseNativeGroupCall(user?.email)) {
          const opened = await ngc.openNativeGroupCall({
            callId: String(room), conversationId: cid, isVideo: false, isCaller: false,
            title: call?.title || '', email: user?.email,
          });
          if (opened) return;
        }
      } catch {}
      router.push(`/call?callId=${encodeURIComponent(room)}&conversationId=${cid}&isVideo=0&isCaller=1&groupCall=1`);
    } catch (e) {
      if (Platform.OS === 'web') window.alert(e?.message || t('common.error'));
      else Alert.alert(t('common.error') || 'Erro', e?.message || t('common.error'));
    }
  }, [router, t, user?.email]);

  const handleCancel = useCallback(async (call) => {
    const confirmFn = (msg) => Platform.OS === 'web'
      ? Promise.resolve(window.confirm(msg))
      : new Promise(resolve => Alert.alert(
          t('common.confirm') || 'Confirmar',
          msg,
          [
            { text: t('common.cancel') || 'Cancelar', style: 'cancel', onPress: () => resolve(false) },
            { text: t('common.delete') || 'Excluir', style: 'destructive', onPress: () => resolve(true) },
          ]
        ));
    const ok = await confirmFn(`${t('calls.cancelConfirm') || 'Cancelar'} "${call.title || ''}"?`);
    if (!ok) return;
    try {
      const r = await api.callScheduleCancel(call.id);
      if (r?.success) setCalls(prev => prev.filter(c => c.id !== call.id));
      else throw new Error(r?.message || 'cancel_failed');
    } catch (e) {
      const m = e?.message && e.message !== 'cancel_failed' && !/network|offline|fetch/i.test(e.message) ? e.message : t('calls.cancelFailed', 'Não foi possível cancelar. Tente de novo.');
      try { require('../components/ui/Toast').showToast({ message: m, kind: 'error' }); } catch {}
    }
  }, [t]);

  const meLc = (user?.email || '').toLowerCase();
  // [2026-10-16 polish-calls] título de LISTA no plural (era "Chamada agendada")
  const _listTitle = (() => { const v = t('calls.scheduledTitle'); return v && v !== 'calls.scheduledTitle' ? v : (t('calls.scheduledList') && t('calls.scheduledList') !== 'calls.scheduledList' ? t('calls.scheduledList') : 'Chamadas agendadas'); })();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({ colors, isDark, title: _listTitle })} />
      ) : (
      // [2026-10-13 visual] web header follows the theme (was a solid black bar /
      // purple #110a1f in dark) like every other screen header.
      <View style={[styles.header, {
        backgroundColor: colors.background,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)',
        paddingTop: insets.top,
      }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.back') || 'Voltar'}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>{_listTitle}</Text>
        </View>
      </View>
      )}

      {loading ? (
        <View style={{ padding: Spacing.md }}>
          {[0, 1, 2].map(i => (
            <View key={i} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border, gap: 10 }]}>
              <View style={{ width: '55%', height: 14, borderRadius: 7, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }} />
              <View style={{ width: '40%', height: 11, borderRadius: 6, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.045)' }} />
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
                {[0, 1, 2].map(j => <View key={j} style={{ width: 28, height: 28, borderRadius: 14, marginLeft: j ? -6 : 0, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }} />)}
                <View style={{ flex: 1 }} />
                <View style={{ width: 92, height: 36, borderRadius: 18, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }} />
              </View>
            </View>
          ))}
        </View>
      ) : calls.length === 0 ? (
        <View style={styles.center}>
          {loadErr ? (
            <ScreenEmptyState
              kind="meetings"
              title={t('calls.scheduleLoadFailed', 'Não foi possível carregar')}
              subtitle={t('common.networkError', 'Erro de rede. Verifique sua conexão.')}
              cta={{ label: t('common.tryAgain', 'Tentar de novo'), onPress: () => load(true) }}
            />
          ) : (
            <ScreenEmptyState
              kind="meetings"
              title={t('calls.noScheduled') || 'Nenhuma chamada agendada'}
              subtitle={t('calls.scheduleHint') || 'Toque em "Agendar" na aba de Ligações.'}
            />
          )}
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: Spacing.md }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        >
          {calls.map(call => {
            const ts = new Date(call.scheduled_at).getTime();
            const now = Date.now();
            const earlyOk = (ts - now) <= 5 * 60 * 1000;
            const lateOk = (now - ts) <= Math.max(5 * 60 * 1000, (call.duration_min || 30) * 60 * 1000);
            const canJoin = earlyOk && lateOk && call.status === 'scheduled';
            const isOrg = String(call.organizer_email || '').toLowerCase() === meLc;
            const peers = Array.isArray(call.participants) ? call.participants : [];
            return (
              <View key={call.id} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
                      {call.title || (t('calls.scheduled') || 'Chamada')}
                    </Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 8, flexWrap: 'wrap' }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <IconClock size={13} color={colors.textSecondary} />
                        <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm }}>
                          {formatRelative(call.scheduled_at, t)} · {formatDateTime(call.scheduled_at, language)}
                        </Text>
                      </View>
                      <Text style={{ color: colors.textTertiary, fontSize: FontSize.xs }}>
                        {(call.duration_min || 30)}min
                      </Text>
                    </View>
                  </View>
                  {isOrg && (
                    <TouchableOpacity onPress={() => handleCancel(call)} style={{ padding: 6 }} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.cancel') || 'Cancelar'}>
                      <IconX size={18} color={colors.textSecondary} />
                    </TouchableOpacity>
                  )}
                </View>

                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12, gap: -6 }}>
                  {peers.slice(0, 5).map((em, i) => (
                    <View key={em + i} style={{ marginLeft: i === 0 ? 0 : -6, borderWidth: 2, borderColor: colors.surface, borderRadius: 999 }}>
                      <AvatarCircle email={em} size={28} />
                    </View>
                  ))}
                  {peers.length > 5 && (
                    <Text style={{ color: colors.textTertiary, marginLeft: 6, fontSize: FontSize.xs }}>
                      +{peers.length - 5}
                    </Text>
                  )}
                  <View style={{ flex: 1 }} />
                  <TouchableOpacity
                    onPress={() => canJoin && handleStart(call)}
                    disabled={!canJoin}
                    style={[
                      styles.startBtn,
                      // [2026-10-16 polish-calls] P&B: 'entrar agora' = tinta do tema (era verde)
                      { backgroundColor: canJoin ? colors.primary : colors.surfaceVariant },
                    ]}
                  >
                    <IconPhone size={14} color={canJoin ? colors.onPrimary : colors.textTertiary} />
                    <Text style={{
                      color: canJoin ? colors.onPrimary : colors.textTertiary,
                      fontSize: FontSize.sm, fontWeight: '600', marginLeft: 6,
                    }}>
                      {canJoin ? (t('calls.start') || 'Iniciar') : (lateOk ? (t('calls.notYet') || 'Ainda não') : t('calls.slotPassed', 'Já passou'))}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8,
    paddingBottom: 10,
  },
  headerBtn: { padding: 10 },
  headerTitle: { color: '#fff', fontSize: 18, fontWeight: '600' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: {
    padding: 16, borderRadius: 14, marginBottom: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: FontSize.md, fontWeight: '600' },
  startBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, minHeight: 40, borderRadius: 20,
  },
});
