import { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet, ActivityIndicator,
  RefreshControl, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import AvatarCircle from '../components/AvatarCircle';
import {
  IconArrowLeft, IconHeart, IconMessageCircle, IconUser,
  IconSparkles, IconBell,
} from '../components/Icons';

const ACCENT = '#7C3AED';

function timeAgo(iso, t) {
  if (!iso) return '';
  const then = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z').getTime();
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return t?.('time.now') || 'agora';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d`;
  {const _d = new Date(iso); return isNaN(_d.getTime()) ? "" : _d.toLocaleDateString();}
}

function NotificationIcon({ type, colors }) {
  if (type === 'feed_like') return <IconHeart size={22} color="#ef4444" />;
  if (type === 'feed_comment') return <IconMessageCircle size={22} color="#A78BFA" />;
  if (type === 'follow') return <IconUser size={22} color={ACCENT} />;
  if (type === 'one_alert') return <IconSparkles size={20} color="#f59e0b" />;
  return <IconMessageCircle size={22} color={colors.textSecondary} />;
}

export default function NotificationsFeedScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  const load = useCallback(async (p = 1) => {
    // Marca loading no início — antes loading só ia pra true no mount,
    // permitindo paginação dispar várias requisições simultâneas.
    setLoading(true);
    try {
      const r = await api.notificationsList(p, 30);
      if (r?.success) {
        const list = r.data?.notifications || [];
        setItems(prev => p === 1 ? list : [...prev, ...list]);
        setHasMore(!!r.data?.has_more);
      }
    } catch {}
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    load(1);
    // Mark all as read when the screen opens
    api.notificationsMarkRead().catch(() => {});
  }, [load]);

  const onRefresh = () => { setRefreshing(true); setPage(1); load(1); };
  const onEndReached = () => {
    if (!hasMore || loading) return;
    const next = page + 1;
    setPage(next);
    load(next);
  };

  const handlePress = (item) => {
    const data = item.data || {};
    if (item.type === 'follow' && item.author_email) {
      router.push(`/u/${encodeURIComponent(item.author_email)}`);
    } else if ((item.type === 'feed_like' || item.type === 'feed_comment') && data.post_id) {
      // /feed-comments is not a registered route — open the public post page
      // instead, which renders the full post with likes + inline comments
      // and works for both logged-in and logged-out viewers.
      router.push(`/feed/${data.post_id}`);
    } else if (item.type === 'one_alert') {
      // One flagged an urgent email — open inbox
      router.push('/inbox');
    }
  };

  const renderItem = ({ item }) => {
    const countSuffix = item.count > 1 ? ` +${item.count - 1}` : '';
    return (
      <TouchableOpacity
        onPress={() => handlePress(item)}
        activeOpacity={0.7}
        style={[styles.row, { backgroundColor: item.read ? 'transparent' : (isDark ? 'rgba(124,58,237,0.08)' : 'rgba(124,58,237,0.05)') }]}
      >
        <View style={{ position: 'relative' }}>
          <AvatarCircle email={item.author_email} name={item.author_email} size={44} />
          <View style={[styles.iconBadge, { backgroundColor: colors.background }]}>
            <NotificationIcon type={item.type} colors={colors} />
          </View>
        </View>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={{ color: colors.text, fontSize: 14 }} numberOfLines={2}>
            <Text style={{ fontWeight: '700' }}>{item.author_email?.split('@')[0] || ''}</Text>
            {countSuffix ? <Text style={{ color: colors.textSecondary }}>{countSuffix}</Text> : null}
            {'  '}
            <Text style={{ color: colors.textSecondary }}>{(item.body || '').replace(item.author_email + ' ', '')}</Text>
          </Text>
          <Text style={{ color: colors.textTertiary, fontSize: 11.5, marginTop: 3 }}>
            {timeAgo(item.created_at, t)}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn} accessibilityLabel={t('common.back') || 'Voltar'}>
          <IconArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('notifications.title') || 'Atividade'}</Text>
        <View style={styles.headerBtn} />
      </View>

      {loading && items.length === 0 ? (
        <View style={styles.empty}>
          <ActivityIndicator size="large" color={ACCENT} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.empty}>
          {/* Empty state: SVG bell on a soft purple disc instead of the
              🔔 emoji — sharp at every density, dark-mode contrast safe,
              and matches the brand accent. */}
          <View style={{
            width: 72, height: 72, borderRadius: 36, marginBottom: 14,
            backgroundColor: 'rgba(124,58,237,0.12)',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <IconBell size={32} color={ACCENT} />
          </View>
          <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 4 }}>
            {t('notifications.empty') || 'Sem notificações ainda'}
          </Text>
          <Text style={{ fontSize: 13, color: colors.textSecondary, textAlign: 'center' }}>
            {t('notifications.emptyHint') || 'Curtidas, comentários e novos seguidores aparecem aqui.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item, i) => String(item.id) + '_' + i}
          renderItem={renderItem}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.6}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} />}
          contentContainerStyle={{ paddingVertical: 4 }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '800' },
  row: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 11,
  },
  iconBadge: {
    position: 'absolute', right: -4, bottom: -4,
    borderRadius: 14, padding: 2,
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
});
