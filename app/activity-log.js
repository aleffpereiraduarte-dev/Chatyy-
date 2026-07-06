/**
 * /activity-log — Histórico de atividade unificado.
 *
 * Surfaced from Settings → "Sua atividade" → "Histórico de atividades".
 *
 * Wave 47 (2026-05-21): expanded from a flat list to a full screen with
 *  - Active sessions card on top (tap "Encerrar" to revoke a device)
 *  - Filter pills: All / Logins / Sessions / Sensitive
 *  - Day-grouped timeline ("Hoje", "Ontem", "Esta semana", "Antes")
 *  - Per-action SVG icon + tier color (critical=red, important=amber)
 *  - Pull-to-refresh + infinite scroll
 *  - i18n PT/EN/ES
 *
 * Backend endpoints used:
 *  - user_activity_log_list  (privacy_endpoints.php — paginated audit rows)
 *  - sessions_list           (email.php — active bearer tokens FS + PG)
 *  - revoke_session          (email.php — drops a token from FS/PG)
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, RefreshControl,
  ActivityIndicator, Alert, ScrollView, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';
import {
  IconArrowLeft, IconShield, IconClock, IconLock, IconKey, IconSmartphone,
  IconMonitor, IconUser, IconAlertTriangle, IconTrash, IconMessageSquare,
  IconFlag, IconLogOut, IconCheck, IconRefresh,
} from '../components/Icons';
import * as api from '../services/api';
import FadeSlideIn from '../components/FadeSlideIn';

const PAGE = 100;

// ─── Tier + icon mapping ───────────────────────────────────────────────
// `tier` drives the leading-dot color. `bucket` controls which filter pill
// the row belongs to (logins / sensitive / routine — "all" shows everything).
// `Icon` is the SVG component painted in the row's circle badge.
const ACTION_META = {
  login:                  { tier: 'routine',   bucket: 'logins',    Icon: IconUser,           tint: '#0ea5e9' },
  logout:                 { tier: 'routine',   bucket: 'logins',    Icon: IconLogOut,         tint: '#94a3b8' },
  password_change:        { tier: 'important', bucket: 'sensitive', Icon: IconLock,           tint: '#f59e0b' },
  twofa_enabled:          { tier: 'important', bucket: 'sensitive', Icon: IconShield,         tint: '#10b981' },
  twofa_disabled:         { tier: 'critical',  bucket: 'sensitive', Icon: IconShield,         tint: '#dc2626' },
  device_linked:          { tier: 'important', bucket: 'sensitive', Icon: IconSmartphone,     tint: '#7C3AED' },
  device_revoked:         { tier: 'important', bucket: 'sensitive', Icon: IconSmartphone,     tint: '#f59e0b' },
  chat_delete:            { tier: 'routine',   bucket: 'routine',   Icon: IconTrash,          tint: '#94a3b8' },
  message_delete_for_all: { tier: 'routine',   bucket: 'routine',   Icon: IconMessageSquare,  tint: '#94a3b8' },
  spam_report:            { tier: 'routine',   bucket: 'routine',   Icon: IconFlag,           tint: '#94a3b8' },
  byok_key_set:           { tier: 'important', bucket: 'sensitive', Icon: IconKey,            tint: '#f59e0b' },
  byok_key_cleared:       { tier: 'critical',  bucket: 'sensitive', Icon: IconKey,            tint: '#dc2626' },
  discoverable_on:        { tier: 'routine',   bucket: 'routine',   Icon: IconShield,         tint: '#10b981' },
  discoverable_off:       { tier: 'routine',   bucket: 'routine',   Icon: IconShield,         tint: '#94a3b8' },
};

function describeAction(action, t) {
  const meta = ACTION_META[action] || { tier: 'routine', bucket: 'routine', Icon: IconClock, tint: '#94a3b8' };
  const label = (() => {
    switch (action) {
      case 'login':                  return t('activity.login');
      case 'logout':                 return t('activity.logout');
      case 'password_change':        return t('activity.passwordChange');
      case 'twofa_enabled':          return t('activity.twofaEnabled');
      case 'twofa_disabled':         return t('activity.twofaDisabled');
      case 'device_linked':          return t('activity.deviceLinked');
      case 'device_revoked':         return t('activity.deviceRevoked');
      case 'chat_delete':            return t('activity.chatDelete');
      case 'message_delete_for_all': return t('activity.msgDeleteForAll');
      case 'spam_report':            return t('activity.spamReport');
      case 'byok_key_set':           return t('activity.byokSet');
      case 'byok_key_cleared':       return t('activity.byokCleared');
      case 'discoverable_on':        return t('activity.discoverableOn');
      case 'discoverable_off':       return t('activity.discoverableOff');
      default: return action;
    }
  })();
  return { ...meta, label: label || action };
}

// ─── Time helpers ──────────────────────────────────────────────────────
function formatRelTs(unixSec, t) {
  try {
    const d = new Date(unixSec * 1000);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60)    return t('time.now') || 'agora';
    if (diff < 3600)  return Math.floor(diff / 60) + ' min';
    if (diff < 86400) return Math.floor(diff / 3600) + ' h';
    return d.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

function dayBucket(unixSec, t) {
  try {
    const d = new Date(unixSec * 1000);
    const now = new Date();
    const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const today = startOf(now);
    const ts = startOf(d);
    if (ts === today)            return t('activity.today') || 'Hoje';
    if (ts === today - 86400000) return t('activity.yesterday') || 'Ontem';
    if (ts > today - 7 * 86400000) return t('activity.thisWeek') || 'Esta semana';
    return t('activity.earlier') || 'Antes';
  } catch { return ''; }
}

function deviceVisualForUA(ua) {
  const label = (ua || '').toLowerCase();
  if (label.includes('iphone') || label.includes('ipad') || label.includes('darwin') || label.includes('cfnetwork')) {
    return { Icon: IconSmartphone, tint: '#7C3AED', bg: '#7C3AED18' };
  }
  if (label.includes('android')) {
    return { Icon: IconSmartphone, tint: '#10b981', bg: '#10b98118' };
  }
  if (label.includes('mac') || label.includes('windows') || label.includes('linux') || label.includes('chrome') || label.includes('firefox') || label.includes('safari') || label.includes('edge')) {
    return { Icon: IconMonitor, tint: '#0ea5e9', bg: '#0ea5e918' };
  }
  return { Icon: IconShield, tint: '#94a3b8', bg: '#94a3b818' };
}

// ─── Sub-component: Active Sessions card (top of list) ────────────────
function SessionsCard({ sessions, onRevoke, revokingHash, t, colors }) {
  const items = Array.isArray(sessions) ? sessions : [];
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
      <View style={styles.cardHeader}>
        <IconSmartphone size={18} color={colors.primary} />
        <Text style={[styles.cardTitle, { color: colors.text }]} numberOfLines={1}>
          {t('activity.sessionsTitle') || 'Sessões ativas'}
        </Text>
        <Text style={[styles.cardCount, { color: colors.textTertiary }]}>
          {(t('activity.sessionsCount') || '{n} ativa(s)').replace('{n}', String(items.length))}
        </Text>
      </View>
      {items.length === 0 ? (
        <Text style={[styles.cardEmpty, { color: colors.textTertiary }]}>
          {t('activity.emptySessions') || 'Nenhuma sessão ativa.'}
        </Text>
      ) : items.map((s) => {
        const dv = deviceVisualForUA(s.user_agent || s.device_label);
        const isCurrent = !!s.is_current;
        const last = s.last_active || s.last_seen_at || s.created_at;
        return (
          <View key={s.token_hash || s.id} style={[styles.sessionRow, { borderTopColor: colors.borderLight }]}>
            <View style={[styles.sessionIconBg, { backgroundColor: dv.bg }]}>
              <dv.Icon size={18} color={dv.tint} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={[styles.sessionLabel, { color: colors.text }]} numberOfLines={1}>
                  {s.device_label || t('activity.thisDevice')}
                </Text>
                {isCurrent ? (
                  <View style={[styles.currentPill, { backgroundColor: colors.primary + '22' }]}>
                    <Text style={[styles.currentPillText, { color: colors.primary }]}>
                      {t('activity.thisDevice') || 'Este dispositivo'}
                    </Text>
                  </View>
                ) : null}
              </View>
              <Text style={[styles.sessionMeta, { color: colors.textTertiary }]} numberOfLines={1}>
                {[s.ip, last ? formatRelTs(last, t) : ''].filter(Boolean).join(' · ')}
              </Text>
            </View>
            {!isCurrent ? (
              <TouchableOpacity
                onPress={() => onRevoke(s.token_hash || s.id)}
                disabled={revokingHash === (s.token_hash || s.id)}
                style={[styles.endBtn, { borderColor: '#dc262644' }]}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                {revokingHash === (s.token_hash || s.id) ? (
                  <ActivityIndicator size="small" color="#dc2626" />
                ) : (
                  <Text style={[styles.endBtnText, { color: '#dc2626' }]}>
                    {t('activity.endSession') || 'Encerrar'}
                  </Text>
                )}
              </TouchableOpacity>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

// ─── Sub-component: Filter pills ──────────────────────────────────────
function FilterPills({ tab, setTab, t, colors }) {
  const tabs = [
    { key: 'all',       label: t('activity.tabs.all')       || 'Tudo' },
    { key: 'logins',    label: t('activity.tabs.logins')    || 'Logins' },
    { key: 'sessions',  label: t('activity.tabs.sessions')  || 'Sessões ativas' },
    { key: 'sensitive', label: t('activity.tabs.sensitive') || 'Ações sensíveis' },
  ];
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.pillsRow}>
      {tabs.map(tt => {
        const active = tab === tt.key;
        return (
          <TouchableOpacity
            key={tt.key}
            onPress={() => setTab(tt.key)}
            style={[
              styles.pill,
              { borderColor: active ? colors.primary : colors.borderLight,
                backgroundColor: active ? colors.primary + '14' : 'transparent' },
            ]}>
            <Text style={[styles.pillText, { color: active ? colors.primary : colors.textSecondary }]} numberOfLines={1}>
              {tt.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

// ─── Main screen ───────────────────────────────────────────────────────
export default function ActivityLogScreen() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [items, setItems]           = useState([]);
  const [offset, setOffset]         = useState(0);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hasMore, setHasMore]       = useState(true);
  const [tab, setTab]               = useState('all');
  const [sessions, setSessions]     = useState([]);
  const [revokingHash, setRevokingHash] = useState(null);

  const loadActivities = useCallback(async (reset = false) => {
    try {
      const r = await api.userActivityLogList(PAGE, reset ? 0 : offset);
      const data = r?.data?.items || r?.items || [];
      setHasMore(data.length === PAGE);
      setItems(prev => reset ? data : [...prev, ...data]);
      setOffset(prev => reset ? data.length : prev + data.length);
    } catch (e) {
      console.warn('[activity-log] load failed', e?.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [offset]);

  const loadSessions = useCallback(async () => {
    try {
      const r = await api.getSessionsList();
      const arr = Array.isArray(r?.data) ? r.data
                : (Array.isArray(r?.data?.sessions) ? r.data.sessions
                : (Array.isArray(r?.sessions) ? r.sessions : []));
      setSessions(arr);
    } catch (e) {
      console.warn('[activity-log] sessions failed', e?.message);
    }
  }, []);

  useEffect(() => {
    loadActivities(true);
    loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setOffset(0);
    loadActivities(true);
    loadSessions();
  }, [loadActivities, loadSessions]);

  const onEnd = useCallback(() => {
    if (!loading && hasMore) loadActivities(false);
  }, [loadActivities, loading, hasMore]);

  // ── Revoke flow ──────────────────────────────────────────────────────
  const confirmRevoke = useCallback((hash) => {
    Alert.alert(
      t('activity.endSessionConfirmTitle') || 'Encerrar sessão?',
      t('activity.endSessionConfirm') || 'Este dispositivo será deslogado imediatamente.',
      [
        { text: t('activity.cancel') || 'Cancelar', style: 'cancel' },
        {
          text: t('activity.confirm') || 'Encerrar',
          style: 'destructive',
          onPress: async () => {
            setRevokingHash(hash);
            try {
              await api.revokeSession(hash);
              setSessions(prev => (prev || []).filter(s => (s.token_hash || s.id) !== hash));
              // Refresh audit log — backend logs `device_revoked` upon revoke
              loadActivities(true);
            } catch (e) {
              Alert.alert('', t('activity.revokeFailed') || 'Não foi possível encerrar a sessão.');
            } finally {
              setRevokingHash(null);
            }
          },
        },
      ],
      { cancelable: true }
    );
  }, [t, loadActivities]);

  // ── Filter + group ───────────────────────────────────────────────────
  const filteredItems = useMemo(() => {
    if (tab === 'sessions') return [];          // sessions tab → only card, no list
    return (items || []).filter(it => {
      const meta = ACTION_META[it.action];
      if (!meta) return tab === 'all';
      if (tab === 'all')       return true;
      if (tab === 'logins')    return meta.bucket === 'logins';
      if (tab === 'sensitive') return meta.bucket === 'sensitive';
      return true;
    });
  }, [items, tab]);

  // Build a flat list with day-section headers interleaved. Each entry is
  // either { type:'header', label } or { type:'row', ...activityRow }.
  const listData = useMemo(() => {
    if (tab === 'sessions') return [];
    const out = [];
    let last = null;
    for (const it of filteredItems) {
      const bucket = dayBucket(it.created_at, t);
      if (bucket !== last) {
        out.push({ type: 'header', label: bucket, key: 'h_' + bucket + '_' + it.id });
        last = bucket;
      }
      out.push({ type: 'row', ...it, key: 'r_' + it.id });
    }
    return out;
  }, [filteredItems, tab, t]);

  // ── Render ───────────────────────────────────────────────────────────
  const renderListItem = ({ item }) => {
    if (item.type === 'header') {
      return (
        <View style={styles.dayHeader}>
          <Text style={[styles.dayHeaderText, { color: colors.textTertiary }]}>{item.label}</Text>
        </View>
      );
    }
    const meta = describeAction(item.action, t);
    const tierColor = meta.tier === 'critical' ? '#dc2626'
                    : meta.tier === 'important' ? '#f59e0b'
                    : colors.borderLight;
    const detail = [item.device_label || '', item.ip || ''].filter(Boolean).join(' · ');
    return (
      <View style={[styles.row, { borderBottomColor: colors.borderLight }]}>
        <View style={[styles.iconBubble, { backgroundColor: meta.tint + '1A' }]}>
          <meta.Icon size={18} color={meta.tint} />
          {meta.tier !== 'routine' ? (
            <View style={[styles.tierDot, { backgroundColor: tierColor, borderColor: colors.background }]} />
          ) : null}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.action, { color: colors.text }]} numberOfLines={1}>{meta.label}</Text>
          {detail ? (
            <Text style={[styles.detail, { color: colors.textTertiary }]} numberOfLines={1}>{detail}</Text>
          ) : null}
        </View>
        <Text style={[styles.ts, { color: colors.textTertiary }]}>{formatRelTs(item.created_at, t)}</Text>
      </View>
    );
  };

  const emptyForTab = () => {
    if (tab === 'logins')    return t('activity.emptyLogins')    || 'Nenhum login registrado.';
    if (tab === 'sensitive') return t('activity.emptySensitive') || 'Nenhuma ação sensível recente.';
    if (tab === 'sessions')  return t('activity.emptySessions')  || 'Nenhuma sessão ativa.';
    return t('activity.empty') || 'Nenhuma atividade ainda.';
  };

  const ListHeader = (
    <View>
      <Text style={[styles.subtitle, { color: colors.textTertiary }]}>
        {t('activity.headerSubtitle') || 'Logins, sessões e mudanças importantes na sua conta.'}
      </Text>
      <FilterPills tab={tab} setTab={setTab} t={t} colors={colors} />
      {(tab === 'all' || tab === 'sessions') ? (
        <SessionsCard
          sessions={sessions}
          onRevoke={confirmRevoke}
          revokingHash={revokingHash}
          t={t}
          colors={colors}
        />
      ) : null}
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: colors.borderLight }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, marginLeft: Spacing.md }}>
          <IconShield size={20} color={colors.primary} />
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
            {t('activity.title') || 'Histórico de atividades'}
          </Text>
        </View>
        <TouchableOpacity
          onPress={onRefresh}
          hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}
          accessibilityLabel="Refresh">
          <IconRefresh size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {loading && items.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <FadeSlideIn>
        <FlatList
          data={listData}
          keyExtractor={i => i.key || String(i.id || Math.random())}
          renderItem={renderListItem}
          ListHeaderComponent={ListHeader}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          onEndReachedThreshold={0.5}
          onEndReached={onEnd}
          ListEmptyComponent={
            tab === 'sessions' ? null : (
              <View style={styles.empty}>
                <IconShield size={36} color={colors.textTertiary} />
                <Text style={[styles.emptyText, { color: colors.textTertiary }]}>
                  {emptyForTab()}
                </Text>
              </View>
            )
          }
          contentContainerStyle={{ paddingBottom: 32 + insets.bottom }}
        />
        </FadeSlideIn>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: FontSize.lg, fontWeight: '700' },
  subtitle: { fontSize: FontSize.sm, paddingHorizontal: Spacing.md, paddingTop: 10, paddingBottom: 4 },

  pillsRow: { paddingHorizontal: Spacing.md, paddingVertical: 10, gap: 8 },
  pill: {
    paddingHorizontal: 14, paddingVertical: 7,
    borderRadius: 999, borderWidth: 1, marginRight: 6,
  },
  pillText: { fontSize: FontSize.sm, fontWeight: '600' },

  card: {
    marginHorizontal: Spacing.md, marginTop: 4, marginBottom: 14,
    borderRadius: BorderRadius.lg, borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 8,
  },
  cardHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: Spacing.md, paddingVertical: 10,
  },
  cardTitle: { fontSize: FontSize.md, fontWeight: '700', flex: 1 },
  cardCount: { fontSize: FontSize.xs, fontWeight: '500' },
  cardEmpty: { paddingHorizontal: Spacing.md, paddingVertical: 14, fontSize: FontSize.sm },

  sessionRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth, gap: 12,
  },
  sessionIconBg: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  sessionLabel: { fontSize: FontSize.md, fontWeight: '600', flexShrink: 1 },
  sessionMeta: { fontSize: FontSize.xs, marginTop: 2 },

  currentPill: {
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999,
  },
  currentPillText: { fontSize: 10, fontWeight: '700' },

  endBtn: {
    borderWidth: 1, borderRadius: 999,
    paddingHorizontal: 12, paddingVertical: 6, minWidth: 70, alignItems: 'center',
  },
  endBtnText: { fontSize: FontSize.sm, fontWeight: '700' },

  dayHeader: {
    paddingHorizontal: Spacing.md, paddingTop: 16, paddingBottom: 6,
  },
  dayHeaderText: {
    fontSize: FontSize.xs, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.5,
  },

  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: 12, gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconBubble: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center', position: 'relative',
  },
  tierDot: {
    width: 10, height: 10, borderRadius: 5,
    position: 'absolute', top: -2, right: -2, borderWidth: 2,
  },
  action: { fontSize: FontSize.md, fontWeight: '600' },
  detail: { fontSize: FontSize.sm, marginTop: 2 },
  ts: { fontSize: FontSize.sm },

  empty: { alignItems: 'center', paddingTop: 64, gap: 12 },
  emptyText: { fontSize: FontSize.md, textAlign: 'center', paddingHorizontal: Spacing.lg },
});
