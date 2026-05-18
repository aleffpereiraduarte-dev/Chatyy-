// /live-discover — Browse active lives by category.
//
// Top: horizontal pill rail of 8 categories (Gaming, Música, Bate-papo, …).
// Body: grid of currently-live sessions sorted by viewer_count DESC. Tap
// row → /live-viewer?id=X.
//
// Backend: live_categories (static catalog) + live_discover(category?) which
// returns top-50 with optional filter. Subscriber-only lives the viewer can't
// access are server-side filtered (no client gate needed).
//
// This screen is opened from the Lives strip on the Feed/Inbox or directly
// via the live tab. Cheap to load — 1 categories call (cacheable) + 1 list
// call per filter change.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator,
  RefreshControl, ScrollView, Image, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as api from '../services/api';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconUsers } from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';

// Map of category key → emoji-free fallback label (rendered when i18n keys
// are missing). Keep in sync with the backend live_categories action.
const FALLBACK_LABELS = {
  gaming:   'Gaming',
  music:    'Música',
  chat:     'Bate-papo',
  food:     'Comida',
  travel:   'Viagens',
  tech:     'Tecnologia',
  sports:   'Esportes',
  learning: 'Aprendizado',
};

export default function LiveDiscoverScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t, locale } = useLanguage();

  const [categories, setCategories] = useState([]);
  const [activeCategory, setActiveCategory] = useState('');  // '' = All
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  // Avoid stomping a faster-arriving response with a slow-arriving one when
  // the user spam-taps category pills. Ref-counted ticket pattern.
  const ticketRef = useRef(0);

  // Load categories once on mount — server-static, no need to refresh.
  useEffect(() => {
    (async () => {
      try {
        const res = await api.liveCategories();
        if (res?.success && Array.isArray(res.data?.categories)) {
          setCategories(res.data.categories);
        }
      } catch (e) {
        // Soft failure — we still render lives with the All filter active.
        console.warn('[live-discover] liveCategories failed', e?.message);
      }
    })();
  }, []);

  // Load discover whenever the active filter changes. Drop late responses
  // via the ticket counter.
  const loadDiscover = useCallback(async (cat = '', showSpinner = true) => {
    const myTicket = ++ticketRef.current;
    if (showSpinner) setLoading(true);
    setError('');
    try {
      const res = await api.liveDiscover(cat);
      if (myTicket !== ticketRef.current) return; // stale response
      if (res?.success && Array.isArray(res.data?.sessions)) {
        setSessions(res.data.sessions);
      } else {
        setSessions([]);
        if (!res?.success) setError(res?.message || '');
      }
    } catch (e) {
      if (myTicket !== ticketRef.current) return;
      setError(e?.message || 'Falha ao carregar');
      setSessions([]);
    } finally {
      if (myTicket === ticketRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => { loadDiscover(activeCategory, true); }, [activeCategory, loadDiscover]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadDiscover(activeCategory, false);
  }, [activeCategory, loadDiscover]);

  const onOpenLive = useCallback((sess) => {
    if (!sess?.id && !sess?.session_id) return;
    const sid = sess.id || sess.session_id;
    router.push(`/live-viewer?id=${encodeURIComponent(sid)}`);
  }, [router]);

  // Resolve label by locale. Backend supplies pt + en; for es we fall back
  // to pt-pt (close enough — these are short noun labels).
  const labelFor = useCallback((cat) => {
    if (!cat) return '';
    if (locale && locale.startsWith('en')) return cat.label_en || cat.label_pt || FALLBACK_LABELS[cat.key] || cat.key;
    return cat.label_pt || cat.label_en || FALLBACK_LABELS[cat.key] || cat.key;
  }, [locale]);

  // Render a single live card — thumbnail + host strip + viewer pill.
  const renderItem = useCallback(({ item }) => {
    const thumb = item.thumbnail_url || '';
    const cat = (categories || []).find(c => c.key === item.category);
    const catColor = cat?.color || '#A855F7';
    return (
      <TouchableOpacity
        onPress={() => onOpenLive(item)}
        activeOpacity={0.85}
        style={[styles.card, { backgroundColor: isDark ? '#0F172A' : '#F8FAFC' }]}
        accessibilityRole="button"
        accessibilityLabel={item.title || item.host_name}
      >
        <View style={styles.thumbWrap}>
          {thumb ? (
            <Image source={{ uri: thumb }} style={styles.thumb} resizeMode="cover" />
          ) : (
            <View style={[styles.thumb, { backgroundColor: '#1F2C34', alignItems: 'center', justifyContent: 'center' }]}>
              <AvatarCircle name={item.host_name} email={item.host_email} size={48} />
            </View>
          )}
          <View style={styles.liveBadge}>
            <View style={styles.liveDot} />
            <Text style={styles.liveBadgeText}>{t('live.live') || 'AO VIVO'}</Text>
          </View>
          <View style={styles.viewerPill}>
            <IconUsers size={11} color="#fff" />
            <Text style={styles.viewerPillText}>{item.viewer_count || 0}</Text>
          </View>
          {item.category ? (
            <View style={[styles.catChip, { backgroundColor: catColor + 'CC' }]}>
              <Text style={styles.catChipText} numberOfLines={1}>{labelFor(cat) || FALLBACK_LABELS[item.category] || item.category}</Text>
            </View>
          ) : null}
          {item.subscribers_only ? (
            <View style={styles.subOnlyChip}>
              <Text style={styles.subOnlyChipText}>SUBS</Text>
            </View>
          ) : null}
        </View>
        <View style={styles.cardBody}>
          <Text numberOfLines={1} style={[styles.cardTitle, { color: colors.text }]}>
            {item.title || (t('live.live') || 'Live')}
          </Text>
          <Text numberOfLines={1} style={[styles.cardHost, { color: colors.textSecondary }]}>
            {item.host_name || item.host_email}
          </Text>
        </View>
      </TouchableOpacity>
    );
  }, [categories, colors, isDark, labelFor, onOpenLive, t]);

  const keyExtractor = useCallback((item) => String(item.id || item.session_id || item.host_email), []);

  return (
    <View style={[styles.fill, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel={t('common.back') || 'Voltar'}
        >
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>
          {t('live.discover') || 'Descobrir lives'}
        </Text>
        <View style={{ width: 36 }} />
      </View>

      {/* Category pill rail */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.pillRow}
      >
        <CategoryPill
          label={t('common.all') || 'Todos'}
          color="#6B7280"
          active={activeCategory === ''}
          onPress={() => setActiveCategory('')}
        />
        {(categories || []).map(cat => (
          <CategoryPill
            key={cat.key}
            label={labelFor(cat)}
            color={cat.color}
            active={activeCategory === cat.key}
            onPress={() => setActiveCategory(cat.key)}
          />
        ))}
      </ScrollView>

      {/* List */}
      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      ) : error && !sessions.length ? (
        <View style={styles.center}>
          <Text style={{ color: colors.textSecondary }}>{error}</Text>
        </View>
      ) : !sessions.length ? (
        <View style={styles.center}>
          <Text style={[styles.emptyTitle, { color: colors.text }]}>
            {t('live.discoverEmpty') || 'Nenhuma live ativa agora'}
          </Text>
          <Text style={[styles.emptyHint, { color: colors.textSecondary }]}>
            {t('live.discoverEmptyHint') || 'Volte mais tarde ou comece a sua própria live.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={sessions}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          numColumns={2}
          columnWrapperStyle={styles.colWrap}
          contentContainerStyle={styles.listPad}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        />
      )}
    </View>
  );
}

function CategoryPill({ label, color, active, onPress }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={[
        styles.pill,
        active ? { backgroundColor: color || '#A855F7', borderColor: color || '#A855F7' } : { backgroundColor: 'transparent', borderColor: '#9CA3AF44' },
      ]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
    >
      <Text style={[styles.pillText, active && { color: '#fff', fontWeight: '800' }]} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    justifyContent: 'space-between',
  },
  backBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 17, fontWeight: '700' },

  pillRow: {
    paddingHorizontal: 12,
    paddingBottom: 8,
    gap: 8,
    flexDirection: 'row',
  },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    marginRight: 8,
  },
  pillText: { fontSize: 13, fontWeight: '600', color: '#9CA3AF' },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 16, fontWeight: '700', marginBottom: 6 },
  emptyHint: { fontSize: 13, textAlign: 'center' },

  listPad: { padding: 8, paddingBottom: 32 },
  colWrap: { gap: 8, marginBottom: 8 },

  card: {
    flex: 1,
    borderRadius: 14,
    overflow: 'hidden',
    marginHorizontal: 4,
  },
  thumbWrap: { aspectRatio: 9 / 14, position: 'relative' },
  thumb: { width: '100%', height: '100%' },
  liveBadge: {
    position: 'absolute', top: 8, left: 8,
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#DC2626',
    paddingHorizontal: 6, paddingVertical: 3,
    borderRadius: 999,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff', marginRight: 4 },
  liveBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },

  viewerPill: {
    position: 'absolute', top: 8, right: 8,
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 7, paddingVertical: 3,
    borderRadius: 999, gap: 3,
  },
  viewerPillText: { color: '#fff', fontSize: 11, fontWeight: '700' },

  catChip: {
    position: 'absolute', bottom: 8, left: 8,
    paddingHorizontal: 7, paddingVertical: 3,
    borderRadius: 8,
  },
  catChipText: { color: '#fff', fontSize: 10, fontWeight: '700', maxWidth: 80 },

  subOnlyChip: {
    position: 'absolute', bottom: 8, right: 8,
    paddingHorizontal: 7, paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: '#F59E0B',
  },
  subOnlyChipText: { color: '#fff', fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },

  cardBody: { padding: 8, gap: 2 },
  cardTitle: { fontSize: 13, fontWeight: '700' },
  cardHost: { fontSize: 11 },
});
