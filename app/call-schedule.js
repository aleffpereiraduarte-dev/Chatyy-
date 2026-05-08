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
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { Spacing, BorderRadius, FontSize } from '../constants/theme';
import { IconArrowLeft, IconCalendar, IconPhone, IconX, IconClock } from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';

function formatRelative(iso, t) {
  if (!iso) return '';
  const now = Date.now();
  const ts = new Date(iso).getTime();
  if (!ts) return '';
  const diffMin = Math.round((ts - now) / 60000);
  if (diffMin <= -2) return t('time.ago') ? `${Math.abs(diffMin)} min atrás` : 'agora';
  if (diffMin <= 0) return 'agora';
  if (diffMin < 60) return `em ${diffMin} min`;
  const h = Math.round(diffMin / 60);
  if (h < 24) return `em ${h}h`;
  const d = Math.round(h / 24);
  return `em ${d}d`;
}

function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function CallScheduleScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [calls, setCalls] = useState([]);
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
      }
    } catch {}
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
          window.alert(r?.message || 'Não disponível agora');
        } else {
          Alert.alert(t('common.error') || 'Erro', r?.message || 'Não disponível agora');
        }
        return;
      }
      const room = r.data?.room_id || call.room_id;
      const cid = r.data?.conversation_id || call.conversation_id || 0;
      router.push(`/group-call?room=${encodeURIComponent(room)}&conversation_id=${cid}&video=0`);
    } catch (e) {
      if (Platform.OS === 'web') window.alert(e?.message || 'Erro');
      else Alert.alert(t('common.error') || 'Erro', e?.message || 'Erro');
    }
  }, [router, t]);

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
    } catch {}
  }, [t]);

  const meLc = (user?.email || '').toLowerCase();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, {
        backgroundColor: isDark ? '#110a1f' : '#6D28D9',
        paddingTop: insets.top,
      }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn} hitSlop={10}>
          <IconArrowLeft size={22} color="#fff" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>{t('calls.scheduled') || 'Chamadas agendadas'}</Text>
        </View>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : calls.length === 0 ? (
        <View style={styles.center}>
          <View style={{
            width: 80, height: 80, borderRadius: 40,
            backgroundColor: colors.surfaceVariant,
            alignItems: 'center', justifyContent: 'center', marginBottom: 16,
          }}>
            <IconCalendar size={40} color={colors.textSecondary} />
          </View>
          <Text style={{ color: colors.text, fontSize: FontSize.md, fontWeight: '600' }}>
            {t('calls.noScheduled') || 'Nenhuma chamada agendada'}
          </Text>
          <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, marginTop: 6, textAlign: 'center', paddingHorizontal: 32 }}>
            {t('calls.scheduleHint') || 'Toque em "Agendar" na aba de Ligações.'}
          </Text>
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
                          {formatRelative(call.scheduled_at, t)} · {formatDateTime(call.scheduled_at)}
                        </Text>
                      </View>
                      <Text style={{ color: colors.textTertiary, fontSize: FontSize.xs }}>
                        {(call.duration_min || 30)}min
                      </Text>
                    </View>
                  </View>
                  {isOrg && (
                    <TouchableOpacity onPress={() => handleCancel(call)} style={{ padding: 6 }} hitSlop={8}>
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
                      { backgroundColor: canJoin ? '#10b981' : colors.surfaceVariant },
                    ]}
                  >
                    <IconPhone size={14} color={canJoin ? '#fff' : colors.textTertiary} />
                    <Text style={{
                      color: canJoin ? '#fff' : colors.textTertiary,
                      fontSize: FontSize.sm, fontWeight: '600', marginLeft: 6,
                    }}>
                      {canJoin ? (t('calls.start') || 'Iniciar') : (t('calls.notYet') || formatRelative(call.scheduled_at, t))}
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
    padding: 14, borderRadius: BorderRadius.lg, marginBottom: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: FontSize.md, fontWeight: '600' },
  startBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: BorderRadius.md,
  },
});
