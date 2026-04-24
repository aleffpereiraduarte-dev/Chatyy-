import { useState, useCallback, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, FlatList, ActivityIndicator, ScrollView, Platform, Dimensions, Animated } from 'react-native';
import { Image } from 'expo-image';
import Svg, { Path, Circle as SvgCircle, Rect, Polygon, Line, G, Defs, LinearGradient, Stop } from 'react-native-svg';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';

const { width: SCREEN_W } = Dimensions.get('window');

// ─── SVG Icons ───

function IconTV({ size = 24, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
      <Polygon points="17,2 12,7 7,2" fill="none" stroke={color} />
    </Svg>
  );
}

function IconPlay({ size = 28, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Path d="M8 5v14l11-7z" />
    </Svg>
  );
}

function IconArrowBack({ size = 22, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <Line x1="19" y1="12" x2="5" y2="12" />
      <Path d="M12 19l-7-7 7-7" />
    </Svg>
  );
}

function IconStar({ size = 16, color = '#a855f7' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none">
      <Path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </Svg>
  );
}

function IconClock({ size = 14, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <SvgCircle cx="12" cy="12" r="10" />
      <Path d="M12 6v6l4 2" />
    </Svg>
  );
}

// ─── Category Pills ───
const TV_CATEGORIES = [
  { key: 'all', emoji: '\uD83C\uDF1F', color: '#8b5cf6', i18nKey: null },
  { key: 'cartoons', emoji: '\uD83C\uDFA8', color: '#ec4899', i18nKey: 'kids.categories.cartoons' },
  { key: 'educational', emoji: '\uD83D\uDCDA', color: '#10b981', i18nKey: 'kids.categories.educational' },
  { key: 'music', emoji: '\uD83C\uDFB5', color: '#3b82f6', i18nKey: 'kids.categories.music' },
  { key: 'stories', emoji: '\uD83D\uDCDA', color: '#f59e0b', i18nKey: 'kids.categories.stories' },
];

// ─── BounceIn animation ───
function BounceIn({ children, delay = 0 }) {
  const scale = useRef(new Animated.Value(0.5)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, delay, tension: 80, friction: 8, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, delay, duration: 250, useNativeDriver: true }),
    ]).start();
  }, []);
  return <Animated.View style={{ transform: [{ scale }], opacity }}>{children}</Animated.View>;
}

// Channel icon: colored circle with emoji/initial
function ChannelIcon({ name, emoji, color, size = 60 }) {
  const letter = (name || '?')[0].toUpperCase();
  return (
    <View style={{
      width: size, height: size, borderRadius: size * 0.35,
      backgroundColor: color || '#8b5cf6', alignItems: 'center', justifyContent: 'center',
      ...(Platform.OS === 'web' ? { boxShadow: `0 4px 12px ${(color || '#8b5cf6')}40` } : {}),
    }}>
      <Text style={{ fontSize: size * 0.35, fontWeight: '800', color: '#fff' }}>{emoji || letter}</Text>
    </View>
  );
}

// Play button overlay for thumbnails
function PlayOverlay({ size = 52 }) {
  return (
    <View style={st.playOverlay}>
      <View style={{
        width: size, height: size, borderRadius: size / 2,
        backgroundColor: 'rgba(139,92,246,0.92)', alignItems: 'center', justifyContent: 'center',
        ...(Platform.OS === 'web' ? { boxShadow: '0 6px 24px rgba(139,92,246,0.5)' } : {}),
      }}>
        <IconPlay size={size * 0.45} color="#fff" />
      </View>
    </View>
  );
}

// Watch time badge
function WatchTimeBadge({ minutes }) {
  if (!minutes) return null;
  return (
    <View style={{
      position: 'absolute', bottom: 8, right: 8,
      backgroundColor: 'rgba(0,0,0,0.75)', paddingHorizontal: 8, paddingVertical: 4,
      borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 4,
    }}>
      <IconClock size={11} color="#fff" />
      <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>{minutes} min</Text>
    </View>
  );
}

// Channel color palette
const CHANNEL_COLORS = ['#8b5cf6', '#ec4899', '#10b981', '#f59e0b', '#3b82f6', '#f43f5e', '#06b6d4', '#84cc16'];

export default function KidsTVTab() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [channels, setChannels] = useState([]);
  const [categories, setCategories] = useState([]);
  const [featured, setFeatured] = useState([]);
  const [selectedChannel, setSelectedChannel] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingVideos, setLoadingVideos] = useState(false);
  const [playingVideo, setPlayingVideo] = useState(null);

  useEffect(() => { loadHome(); }, []);

  const loadHome = useCallback(async () => {
    setLoading(true);
    try {
      const [chRes, ftRes] = await Promise.all([
        api.kidsTVChannels(),
        api.kidsTVFeatured(),
      ]);
      if (chRes?.success) {
        setChannels(chRes.data?.channels || []);
        setCategories(chRes.data?.categories || []);
      }
      if (ftRes?.success) setFeatured(ftRes.data?.videos || []);
    } catch {} finally { setLoading(false); }
  }, []);

  const openChannel = useCallback(async (channel) => {
    setSelectedChannel(channel);
    setLoadingVideos(true);
    setPlayingVideo(null);
    try {
      const r = await api.kidsTVVideos(channel.id);
      if (r?.success) setVideos(r.data?.videos || []);
    } catch {} finally { setLoadingVideos(false); }
  }, []);

  const bg = isDark ? '#0f0720' : '#faf5ff';
  const cardBg = isDark ? '#1e1145' : '#fff';
  const textColor = isDark ? '#e9d5ff' : '#1e1b4b';
  const subColor = isDark ? '#a78bfa' : '#6b7280';

  // === PLAYING VIDEO ===
  if (playingVideo) {
    return (
      <View style={[st.container, { backgroundColor: '#000' }]}>
        <TouchableOpacity
          onPress={() => setPlayingVideo(null)} style={st.closeBtn} activeOpacity={0.8}
          accessibilityLabel={t('kids.back')} accessibilityRole="button"
        >
          <View style={{ backgroundColor: 'rgba(0,0,0,0.7)', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <IconArrowBack size={18} color="#fff" />
            <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>{t('kids.back')}</Text>
          </View>
        </TouchableOpacity>
        <Text style={{ color: '#fff', fontSize: 17, fontWeight: '700', padding: 14, paddingTop: 54 }} numberOfLines={2}>{playingVideo.title}</Text>
        {Platform.OS === 'web' ? (
          <View style={{ flex: 1 }}>
            <iframe src={playingVideo.url} style={{ width: '100%', height: '100%', border: 'none' }} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen />
          </View>
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#fff', fontSize: 18 }}>Abrindo video...</Text>
          </View>
        )}
      </View>
    );
  }

  // === CHANNEL VIDEOS ===
  if (selectedChannel) {
    const chColor = selectedChannel.color || CHANNEL_COLORS[channels.indexOf(selectedChannel) % CHANNEL_COLORS.length];
    return (
      <View style={[st.container, { backgroundColor: bg }]}>
        <View style={[st.header, Platform.OS === 'web'
          ? { background: 'linear-gradient(135deg, #6366f1, #a855f7, #ec4899)' }
          : { backgroundColor: '#6366f1' }
        ]}>
          <TouchableOpacity
            onPress={() => { setSelectedChannel(null); setVideos([]); }}
            style={{ padding: 6 }} activeOpacity={0.7}
            accessibilityLabel={t('kids.back')} accessibilityRole="button"
          >
            <IconArrowBack size={24} color="#fff" />
          </TouchableOpacity>
          <ChannelIcon name={selectedChannel.name} color={chColor} size={42} />
          <View style={{ flex: 1 }}>
            <Text style={st.headerTitle}>{selectedChannel.name}</Text>
            <Text style={st.headerSub}>{videos.length} {t('kids.videos').toLowerCase()}</Text>
          </View>
        </View>
        {loadingVideos ? (
          <View style={st.center}><ActivityIndicator size="large" color="#8b5cf6" /></View>
        ) : (
          <FlatList data={videos} keyExtractor={item => item.id} contentContainerStyle={{ padding: 14 }}
            renderItem={({ item, index }) => (
              <BounceIn delay={index * 50}>
                <TouchableOpacity
                  style={[st.videoCard, { backgroundColor: cardBg }]}
                  onPress={() => setPlayingVideo(item)} activeOpacity={0.8}
                  accessibilityLabel={item.title} accessibilityRole="button"
                >
                  <View style={{ position: 'relative' }}>
                    <CachedImage source={{ uri: item.thumbnail }} style={st.videoThumb} contentFit="cover" />
                    <PlayOverlay size={50} />
                    <WatchTimeBadge minutes={item.duration} />
                  </View>
                  <View style={st.videoInfo}>
                    <Text style={[st.videoTitle, { color: textColor }]} numberOfLines={2}>{item.title}</Text>
                    <Text style={{ fontSize: 13, color: subColor, marginTop: 6 }}>{selectedChannel.name}</Text>
                  </View>
                </TouchableOpacity>
              </BounceIn>
            )}
            ListEmptyComponent={
              <View style={st.center}>
                <Text style={{ fontSize: 40 }}>{'\uD83D\uDCFA'}</Text>
                <Text style={{ color: subColor, fontSize: 17, fontWeight: '600', marginTop: 8 }}>{t('kids.noVideos')}</Text>
              </View>
            }
          />
        )}
      </View>
    );
  }

  // === HOME (categories + channels + featured) ===
  return (
    <View style={[st.container, { backgroundColor: bg }]}>
      <View style={[st.header, Platform.OS === 'web'
        ? { background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 40%, #ec4899 70%, #f43f5e 100%)' }
        : { backgroundColor: '#6366f1' }
      ]}>
        <View style={{ width: 48, height: 48, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center' }}>
          <IconTV size={26} color="#fff" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={st.headerTitle}>{t('kids.tvTitle')}</Text>
          <Text style={st.headerSub}>{t('kids.tvDesc')}</Text>
        </View>
      </View>

      {loading ? (
        <View style={st.center}><ActivityIndicator size="large" color="#8b5cf6" /></View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 80 }}>
          {/* Category pills */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 14, gap: 10 }}>
            {TV_CATEGORIES.map(cat => {
              const isActive = selectedCategory === cat.key;
              return (
                <TouchableOpacity
                  key={cat.key}
                  style={[st.catPill, {
                    backgroundColor: isActive ? cat.color : (isDark ? '#1e1145' : '#fff'),
                    borderColor: isActive ? cat.color : (isDark ? '#2d1b4e' : '#e5e7eb'),
                    ...(isActive && Platform.OS === 'web' ? { boxShadow: `0 4px 12px ${cat.color}40` } : {}),
                  }]}
                  onPress={() => setSelectedCategory(cat.key)}
                  activeOpacity={0.7}
                  accessibilityLabel={cat.i18nKey ? t(cat.i18nKey) : 'All'}
                  accessibilityRole="button"
                >
                  <Text style={{ fontSize: 18 }}>{cat.emoji}</Text>
                  <Text style={[st.catPillText, { color: isActive ? '#fff' : textColor }]}>
                    {cat.i18nKey ? t(cat.i18nKey) : 'Todos'}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {/* Featured Videos - horizontal scroll with large cards */}
          {featured.length > 0 && (
            <View style={{ marginTop: 4 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, marginBottom: 14 }}>
                <IconStar size={18} color={isDark ? '#a78bfa' : '#8b5cf6'} />
                <Text style={[st.sectionTitle, { color: textColor, marginBottom: 0, paddingHorizontal: 0 }]}>{t('kids.featured')}</Text>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 14, gap: 14 }}>
                {featured.map((v, idx) => (
                  <BounceIn key={v.id} delay={idx * 80}>
                    <TouchableOpacity
                      style={[st.featCard, { backgroundColor: cardBg }]}
                      onPress={() => setPlayingVideo({ ...v, url: 'https://www.youtube.com/embed/' + v.id + '?autoplay=1&rel=0' })}
                      activeOpacity={0.8}
                      accessibilityLabel={v.title} accessibilityRole="button"
                    >
                      <View style={{ position: 'relative' }}>
                        <CachedImage source={{ uri: v.thumbnail }} style={st.featThumb} contentFit="cover" />
                        <PlayOverlay size={44} />
                        <WatchTimeBadge minutes={v.duration} />
                      </View>
                      <View style={{ padding: 12 }}>
                        <Text style={[st.featTitle, { color: textColor }]} numberOfLines={2}>{v.title}</Text>
                        <Text style={{ fontSize: 12, color: subColor, marginTop: 4 }}>{v.channel}</Text>
                      </View>
                    </TouchableOpacity>
                  </BounceIn>
                ))}
              </ScrollView>
            </View>
          )}

          {/* Channels grid - large colorful cards */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, marginTop: 28, marginBottom: 14 }}>
            <Text style={{ fontSize: 20 }}>{'\uD83D\uDCFA'}</Text>
            <Text style={[st.sectionTitle, { color: textColor, marginBottom: 0, paddingHorizontal: 0 }]}>{t('kids.channels')}</Text>
          </View>
          <View style={st.channelGrid}>
            {channels.map((ch, idx) => {
              const chColor = ch.color || CHANNEL_COLORS[idx % CHANNEL_COLORS.length];
              return (
                <BounceIn key={ch.id} delay={idx * 60}>
                  <TouchableOpacity
                    style={[st.channelCard, { backgroundColor: cardBg }]}
                    onPress={() => openChannel(ch)} activeOpacity={0.8}
                    accessibilityLabel={ch.name} accessibilityRole="button"
                  >
                    <ChannelIcon name={ch.name} emoji={ch.emoji} color={chColor} size={64} />
                    <Text style={[st.channelName, { color: textColor }]} numberOfLines={1}>{ch.name}</Text>
                    <Text style={[st.channelDesc, { color: subColor }]} numberOfLines={1}>{ch.description}</Text>
                    {ch.video_count > 0 && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 }}>
                        <IconPlay size={10} color={subColor} />
                        <Text style={{ fontSize: 11, color: subColor, fontWeight: '600' }}>{ch.video_count} {t('kids.videos').toLowerCase()}</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                </BounceIn>
              );
            })}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 18, paddingVertical: 14 },
  headerTitle: { fontSize: 20, fontWeight: '800', color: '#fff', letterSpacing: 0.3 },
  headerSub: { fontSize: 13, color: 'rgba(255,255,255,0.75)', fontWeight: '500' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  sectionTitle: { fontSize: 18, fontWeight: '800', paddingHorizontal: 18, marginBottom: 14 },
  // Category pills
  catPill: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 18, paddingVertical: 12, borderRadius: 20, borderWidth: 2,
    minHeight: 48,
  },
  catPillText: { fontSize: 15, fontWeight: '700' },
  // Featured
  featCard: {
    width: 240, borderRadius: 20, overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: '#8b5cf6', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.15, shadowRadius: 12 },
      android: { elevation: 5 },
      web: { boxShadow: '0 6px 20px rgba(139,92,246,0.12)' },
    }),
  },
  featThumb: { width: 240, height: 135, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  featTitle: { fontSize: 14, fontWeight: '700', lineHeight: 20 },
  // Channel grid
  channelGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 14, gap: 14 },
  channelCard: {
    width: (SCREEN_W - 42) / 2, borderRadius: 24, padding: 18, alignItems: 'center',
    ...Platform.select({
      ios: { shadowColor: '#8b5cf6', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.12, shadowRadius: 12 },
      android: { elevation: 4 },
      web: { boxShadow: '0 6px 20px rgba(139,92,246,0.1)' },
    }),
  },
  channelName: { fontSize: 15, fontWeight: '800', textAlign: 'center', marginTop: 12 },
  channelDesc: { fontSize: 12, textAlign: 'center', marginTop: 3 },
  // Videos
  videoCard: {
    borderRadius: 20, marginBottom: 14, overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.1, shadowRadius: 10 },
      android: { elevation: 4 },
      web: { boxShadow: '0 4px 16px rgba(0,0,0,0.1)' },
    }),
  },
  videoThumb: { width: '100%', height: 210 },
  playOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.2)' },
  videoInfo: { padding: 16 },
  videoTitle: { fontSize: 16, fontWeight: '700', lineHeight: 22 },
  closeBtn: { position: 'absolute', top: 12, left: 12, zIndex: 10 },
});
