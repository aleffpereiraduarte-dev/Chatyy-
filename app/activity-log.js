/**
 * /activity-log — Unified security audit log.
 *
 * Surfaced from Settings → Segurança → "Histórico de atividades".
 * Renders the rows returned by `user_activity_log_list` with i18n labels
 * for each action key. Pull-to-refresh + infinite scroll.
 */

import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, RefreshControl,
  ActivityIndicator, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';
import { IconArrowLeft, IconShield } from '../components/Icons';
import * as api from '../services/api';

const PAGE = 100;

/**
 * Maps an `action` token to a human-friendly label + an icon-colored tier.
 * Tiers: critical (red), important (amber), routine (neutral).
 */
function describeAction(action, t) {
  const map = {
    login:                 { label: t('activity.login') || 'Login realizado',        tier: 'routine' },
    logout:                { label: t('activity.logout') || 'Logout',                tier: 'routine' },
    password_change:       { label: t('activity.passwordChange') || 'Senha alterada', tier: 'important' },
    twofa_enabled:         { label: t('activity.twofaEnabled') || '2FA ativado',      tier: 'important' },
    twofa_disabled:        { label: t('activity.twofaDisabled') || '2FA desativado',  tier: 'critical' },
    device_linked:         { label: t('activity.deviceLinked') || 'Dispositivo vinculado',   tier: 'important' },
    device_revoked:        { label: t('activity.deviceRevoked') || 'Dispositivo removido',   tier: 'important' },
    chat_delete:           { label: t('activity.chatDelete') || 'Conversa excluída',         tier: 'routine' },
    message_delete_for_all:{ label: t('activity.msgDeleteForAll') || 'Mensagem apagada para todos', tier: 'routine' },
    spam_report:           { label: t('activity.spamReport') || 'Reportou como spam',        tier: 'routine' },
    byok_key_set:          { label: t('activity.byokSet') || 'Chave avançada definida',      tier: 'important' },
    byok_key_cleared:      { label: t('activity.byokCleared') || 'Chave avançada removida',  tier: 'critical' },
    discoverable_on:       { label: t('activity.discoverableOn') || 'Descoberta por número ativada',  tier: 'routine' },
    discoverable_off:      { label: t('activity.discoverableOff') || 'Descoberta por número desativada', tier: 'routine' },
  };
  return map[action] || { label: action, tier: 'routine' };
}

function formatTs(unixSec, t) {
  try {
    const d = new Date(unixSec * 1000);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60)  return t('time.now') || 'agora';
    if (diff < 3600) return Math.floor(diff / 60) + ' min';
    if (diff < 86400) return Math.floor(diff / 3600) + ' h';
    return d.toLocaleString();
  } catch { return ''; }
}

export default function ActivityLogScreen() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [items, setItems] = useState([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const load = useCallback(async (reset = false) => {
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

  useEffect(() => { load(true); /* eslint-disable-next-line */ }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setOffset(0);
    load(true);
  }, [load]);

  const onEnd = useCallback(() => {
    if (!loading && hasMore) load(false);
  }, [load, loading, hasMore]);

  const renderItem = ({ item }) => {
    const meta = describeAction(item.action, t);
    const tierColor = meta.tier === 'critical' ? '#dc2626' :
                      meta.tier === 'important' ? '#f59e0b' :
                      colors.textTertiary;
    const detail = [
      item.device_label || '',
      item.ip || '',
    ].filter(Boolean).join(' · ');
    return (
      <View style={[styles.row, { borderBottomColor: colors.borderLight }]}>
        <View style={[styles.dot, { backgroundColor: tierColor }]} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.action, { color: colors.text }]}>{meta.label}</Text>
          {detail ? (
            <Text style={[styles.detail, { color: colors.textTertiary }]} numberOfLines={1}>{detail}</Text>
          ) : null}
        </View>
        <Text style={[styles.ts, { color: colors.textTertiary }]}>{formatTs(item.created_at, t)}</Text>
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: colors.borderLight }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, marginLeft: Spacing.md }}>
          <IconShield size={20} color={colors.primary} />
          <Text style={[styles.title, { color: colors.text }]}>{t('activity.title') || 'Histórico de atividades'}</Text>
        </View>
      </View>

      {loading && items.length === 0 ? (
        <ActivityIndicator style={{ marginTop: 48 }} color={colors.primary} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={i => String(i.id)}
          renderItem={renderItem}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          onEndReachedThreshold={0.5}
          onEndReached={onEnd}
          ListEmptyComponent={
            <View style={styles.empty}>
              <IconShield size={36} color={colors.textTertiary} />
              <Text style={[styles.emptyText, { color: colors.textTertiary }]}>
                {t('activity.empty') || 'Nenhuma atividade ainda.'}
              </Text>
            </View>
          }
          contentContainerStyle={{ paddingBottom: 32 }}
        />
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
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: 14, gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  action: { fontSize: FontSize.md, fontWeight: '600' },
  detail: { fontSize: FontSize.sm, marginTop: 2 },
  ts: { fontSize: FontSize.sm },
  empty: { alignItems: 'center', paddingTop: 64, gap: 12 },
  emptyText: { fontSize: FontSize.md },
});
