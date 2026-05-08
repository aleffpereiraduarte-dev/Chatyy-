// Community discover — paginated public list with optional search + category filter.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, Image,
  ActivityIndicator, RefreshControl, TextInput, Animated, Easing,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { BorderRadius } from '../../constants/theme';
import * as api from '../../services/api';
import { IconArrowLeft, IconPlus } from '../../components/Icons';

// Slide-up entrance for discovery cards. Each card translates 24px up while
// fading in, staggered 60ms per index. Native driver (transform+opacity).
function SlideUpCard({ index, children }) {
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const t = setTimeout(() => {
      Animated.timing(enter, {
        toValue: 1,
        duration: 360,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }, Math.min(index, 8) * 60);
    return () => clearTimeout(t);
  }, [enter, index]);
  return (
    <Animated.View
      style={{
        opacity: enter,
        transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
      }}
    >
      {children}
    </Animated.View>
  );
}

// Category chip with scale-pop on tap — gives the chip a quick squish-then-
// rebound when selected. Independent Animated.Value per chip so taps stay
// crisp regardless of which one fired last.
function CategoryChip({ active, onPress, label, activeBg, idleBg, activeColor, idleColor, style }) {
  const scale = useRef(new Animated.Value(1)).current;
  const handlePress = () => {
    Animated.sequence([
      Animated.timing(scale, { toValue: 0.88, duration: 80, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, friction: 4, tension: 220, useNativeDriver: true }),
    ]).start();
    onPress?.();
  };
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <TouchableOpacity
        onPress={handlePress}
        activeOpacity={0.75}
        style={[style, { backgroundColor: active ? activeBg : idleBg }]}
      >
        <Text style={{ fontSize: 13, fontWeight: '600', color: active ? activeColor : idleColor }}>{label}</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const CATEGORIES = [
  { key: 'all',      labelKey: 'community.catAll',      fallback: 'Tudo' },
  { key: 'news',     labelKey: 'community.catNews',     fallback: 'Notícias' },
  { key: 'tech',     labelKey: 'community.catTech',     fallback: 'Tech' },
  { key: 'sports',   labelKey: 'community.catSports',   fallback: 'Esportes' },
  { key: 'music',    labelKey: 'community.catMusic',    fallback: 'Música' },
  { key: 'business', labelKey: 'community.catBusiness', fallback: 'Negócios' },
  { key: 'other',    labelKey: 'community.catOther',    fallback: 'Outros' },
];

export default function CommunityDiscoverScreen() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();

  const [q, setQ] = useState('');
  const [cat, setCat] = useState('all');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [myComm, setMyComm] = useState([]);

  const sty = makeStyles(colors, isDark);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await api.communityDiscover({ category: cat, q });
      if (r.success) setItems(r.data?.communities || []);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [cat, q]);

  const loadMy = useCallback(async () => {
    try {
      const r = await api.communityList();
      if (r.success) setMyComm(r.data?.communities || []);
    } catch (_) {}
  }, []);

  // Only re-fire `load` when the category changes or on initial mount —
  // not on every keystroke of the search input. Submitting the search
  // (onSubmitEditing on the TextInput) calls load() explicitly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [cat]);
  useEffect(() => { loadMy(); }, [loadMy]);

  const onJoin = async (item) => {
    const r = await api.communityJoin(item.id);
    if (r.success) router.push(`/community/${item.id}`);
  };

  const renderItem = ({ item, index }) => (
    <SlideUpCard index={index}>
    <TouchableOpacity
      onPress={() => router.push(`/community/${item.id}`)}
      style={[sty.row, { backgroundColor: isDark ? '#1c1c1e' : '#f8f8fa' }]}
    >
      <View style={sty.avatarWrap}>
        {item.photo_url ? (
          <Image source={{ uri: item.photo_url }} style={sty.avatar} />
        ) : (
          <View style={[sty.avatar, { backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }]}>
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 18 }}>
              {(item.name || '?').slice(0, 1).toUpperCase()}
            </Text>
          </View>
        )}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[sty.name, { color: colors.text }]} numberOfLines={1}>{item.name}</Text>
        {item.handle ? (
          <Text style={[sty.handle, { color: colors.textSecondary }]}>@{item.handle}</Text>
        ) : null}
        <Text style={[sty.subtitle, { color: colors.textSecondary }]} numberOfLines={2}>
          {(t('community.membersCount') || '{n} membros').replace('{n}', String(item.member_count || 0))}
          {item.description ? ' · ' + item.description : ''}
        </Text>
      </View>
      {!item.is_member && (
        <TouchableOpacity onPress={() => onJoin(item)} style={[sty.joinBtn, { backgroundColor: colors.primary }]}>
          <Text style={sty.joinBtnText}>{t('community.join') || 'Entrar'}</Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
    </SlideUpCard>
  );

  return (
    <View style={[sty.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={sty.header}>
        <TouchableOpacity onPress={() => router.back()} style={sty.headerBtn} accessibilityRole="button" accessibilityLabel={t('common.back') || 'Voltar'}>
          <IconArrowLeft size={22} color={colors.primary} />
        </TouchableOpacity>
        <Text style={[sty.headerTitle, { color: colors.text }]} numberOfLines={1}>
          {t('community.discoverTitle') || 'Descobrir comunidades'}
        </Text>
        <TouchableOpacity onPress={() => router.push('/community/create')} style={sty.headerBtn} accessibilityRole="button" accessibilityLabel={t('community.create') || 'Criar comunidade'}>
          <IconPlus size={22} color={colors.primary} />
        </TouchableOpacity>
      </View>

      <View style={sty.searchWrap}>
        <TextInput
          value={q} onChangeText={setQ} onSubmitEditing={() => load()}
          placeholder={t('common.search') || 'Buscar…'}
          placeholderTextColor={colors.textSecondary}
          returnKeyType="search"
          style={[sty.search, { backgroundColor: isDark ? '#1c1c1e' : '#f0f0f3', color: colors.text }]}
        />
      </View>

      <FlatList
        horizontal
        data={CATEGORIES}
        keyExtractor={(c) => c.key}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8 }}
        renderItem={({ item }) => (
          <CategoryChip
            active={cat === item.key}
            onPress={() => setCat(item.key)}
            label={t(item.labelKey) || item.fallback}
            style={sty.chip}
            activeBg={colors.primary}
            idleBg={isDark ? '#1c1c1e' : '#f0f0f3'}
            activeColor="#fff"
            idleColor={colors.text}
          />
        )}
      />

      {/* My communities (subset) */}
      {myComm.length > 0 && (
        <View style={{ paddingHorizontal: 12, paddingTop: 8 }}>
          <Text style={[sty.sectionTitle, { color: colors.textSecondary }]}>
            {t('community.myCommunities') || 'Suas comunidades'}
          </Text>
          {myComm.slice(0, 5).map(c => (
            <TouchableOpacity
              key={c.id}
              onPress={() => router.push(`/community/${c.id}`)}
              style={[sty.row, { backgroundColor: isDark ? '#1c1c1e' : '#f8f8fa' }]}
            >
              <View style={sty.avatarWrap}>
                {c.photo_url ? (
                  <Image source={{ uri: c.photo_url }} style={sty.avatar} />
                ) : (
                  <View style={[sty.avatar, { backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }]}>
                    <Text style={{ color: '#fff', fontWeight: '700' }}>{(c.name || '?').slice(0, 1).toUpperCase()}</Text>
                  </View>
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[sty.name, { color: colors.text }]} numberOfLines={1}>{c.name}</Text>
                <Text style={[sty.subtitle, { color: colors.textSecondary }]}>
                  {(t('community.membersCount') || '{n} membros').replace('{n}', String(c.member_count || 0))}
                </Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => String(i.id)}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 12, paddingBottom: 80 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); }} tintColor={colors.primary} />}
          ListHeaderComponent={
            <Text style={[sty.sectionTitle, { color: colors.textSecondary, marginTop: myComm.length ? 16 : 0 }]}>
              {t('community.public') || 'Comunidades públicas'}
            </Text>
          }
          ListEmptyComponent={
            <Text style={{ color: colors.textSecondary, textAlign: 'center', marginTop: 40 }}>
              {t('community.empty') || 'Nenhuma comunidade encontrada'}
            </Text>
          }
        />
      )}
    </View>
  );
}

const makeStyles = (colors, isDark) => StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10,
    borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerBtnText: { fontSize: 28, fontWeight: '300' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600' },
  searchWrap: { padding: 12 },
  search: { borderRadius: BorderRadius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, marginRight: 8 },
  chipText: { fontSize: 13, fontWeight: '600' },
  sectionTitle: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: BorderRadius.md, marginBottom: 8, gap: 12 },
  avatarWrap: { width: 48, height: 48, borderRadius: 24 },
  avatar: { width: 48, height: 48, borderRadius: 24 },
  name: { fontSize: 15, fontWeight: '600' },
  handle: { fontSize: 12, marginTop: 1 },
  subtitle: { fontSize: 12, marginTop: 2 },
  joinBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999 },
  joinBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
});
