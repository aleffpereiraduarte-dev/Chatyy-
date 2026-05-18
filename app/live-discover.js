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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator,
  RefreshControl, ScrollView, Image, Platform, Animated, Easing, Modal, Pressable,
} from 'react-native';
import Svg, {
  Circle, Path, Rect, G, Defs, Line, Polyline,
  LinearGradient as SvgLinearGradient, Stop,
} from 'react-native-svg';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as api from '../services/api';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import {
  IconArrowLeft, IconUsers, IconVideo, IconBell, IconPlay,
  IconGiftBox, IconHeart, IconSparkles, IconMusic,
  IconMessageCircle, IconMapPin, IconSearch,
} from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';
import { formatCount as formatViewers } from '../components/AnimatedViewerCount';

// Brand purple from constants/theme.js (primary = #7C3AED).
const BRAND_PURPLE = '#7C3AED';
const BRAND_PURPLE_DARK = '#5B21B6';
const BRAND_PURPLE_LIGHT = '#A78BFA';

// ─── Pill icons ────────────────────────────────────────────────────────
// Inline 14px SVGs for category keys that don't have a matching icon in
// components/Icons.js (Gamepad, Activity, Coffee, Cpu, Book, Grid). Stroke
// width 1.9 matches the rest of the icon library (Lucide-style).
function PillSvg({ children, size = 14, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </Svg>
  );
}
function IconGamepad({ size = 14, color = '#fff' }) {
  return (
    <PillSvg size={size} color={color}>
      <Line x1="6" y1="12" x2="10" y2="12" />
      <Line x1="8" y1="10" x2="8" y2="14" />
      <Line x1="15" y1="13" x2="15.01" y2="13" />
      <Line x1="18" y1="11" x2="18.01" y2="11" />
      <Rect x="2" y="6" width="20" height="12" rx="6" />
    </PillSvg>
  );
}
function IconActivity({ size = 14, color = '#fff' }) {
  return (
    <PillSvg size={size} color={color}>
      <Polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </PillSvg>
  );
}
function IconCoffee({ size = 14, color = '#fff' }) {
  return (
    <PillSvg size={size} color={color}>
      <Path d="M17 8h1a4 4 0 0 1 0 8h-1" />
      <Path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z" />
      <Line x1="6" y1="2" x2="6" y2="5" />
      <Line x1="10" y1="2" x2="10" y2="5" />
      <Line x1="14" y1="2" x2="14" y2="5" />
    </PillSvg>
  );
}
function IconCpu({ size = 14, color = '#fff' }) {
  return (
    <PillSvg size={size} color={color}>
      <Rect x="4" y="4" width="16" height="16" rx="2" />
      <Rect x="9" y="9" width="6" height="6" />
      <Line x1="9" y1="1" x2="9" y2="4" />
      <Line x1="15" y1="1" x2="15" y2="4" />
      <Line x1="9" y1="20" x2="9" y2="23" />
      <Line x1="15" y1="20" x2="15" y2="23" />
      <Line x1="20" y1="9" x2="23" y2="9" />
      <Line x1="20" y1="14" x2="23" y2="14" />
      <Line x1="1" y1="9" x2="4" y2="9" />
      <Line x1="1" y1="14" x2="4" y2="14" />
    </PillSvg>
  );
}
function IconBook({ size = 14, color = '#fff' }) {
  return (
    <PillSvg size={size} color={color}>
      <Path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <Path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </PillSvg>
  );
}
function IconGrid4({ size = 14, color = '#fff' }) {
  // Used for the "All" pill — 2x2 grid is the de-facto "show all" glyph.
  return (
    <PillSvg size={size} color={color}>
      <Rect x="3" y="3" width="7" height="7" />
      <Rect x="14" y="3" width="7" height="7" />
      <Rect x="3" y="14" width="7" height="7" />
      <Rect x="14" y="14" width="7" height="7" />
    </PillSvg>
  );
}

// key → React component. `for_you` + '' are client-only pseudo-keys.
const CATEGORY_ICONS = {
  for_you:  IconSparkles,
  '':       IconGrid4,
  gaming:   IconGamepad,
  music:    IconMusic,
  chat:     IconMessageCircle,
  food:     IconCoffee,
  travel:   IconMapPin,
  tech:     IconCpu,
  sports:   IconActivity,
  learning: IconBook,
};

// Average pill width — used as snapToInterval for the FlatList rail and
// as the fallback width for the underline before pills measure on layout.
const PILL_SNAP = 116;

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

  // Animated underline that slides between active pills. The X position
  // is tied to the active pill's measured frame (see pillLayouts).
  const underlineX = useRef(new Animated.Value(0)).current;
  const underlineW = useRef(new Animated.Value(28)).current;
  const pillLayoutsRef = useRef({});  // key → { x, w }
  const pillRailRef = useRef(null);

  // Avoid stomping a faster-arriving response with a slow-arriving one when
  // the user spam-taps category pills. Ref-counted ticket pattern.
  const ticketRef = useRef(0);

  // ── Hero breathing pulse — drives the big AO VIVO halo + the Go-Live CTA
  // scale. Native-driven (transform-only) so it costs nothing on the JS
  // thread. The CTA pulse is the "user has been online >2h without going
  // live" nudge — wired statically for now per the task brief (no
  // inactivity timer yet).
  const heroPulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(heroPulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(heroPulse, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [heroPulse]);
  const liveHaloScale   = heroPulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.55] });
  const liveHaloOpacity = heroPulse.interpolate({ inputRange: [0, 1], outputRange: [0.65, 0.0] });
  const heroCtaScale    = heroPulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.045] });

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

  // Resolve label by locale. Backend supplies pt + en; for es we fall back
  // to pt-pt (close enough — these are short noun labels). Defined here
  // (before railData) to avoid the TDZ when railData reads it inside its
  // useMemo factory.
  const labelFor = useCallback((cat) => {
    if (!cat) return '';
    if (locale && locale.startsWith('en')) return cat.label_en || cat.label_pt || FALLBACK_LABELS[cat.key] || cat.key;
    return cat.label_pt || cat.label_en || FALLBACK_LABELS[cat.key] || cat.key;
  }, [locale]);

  // Order: "Para você" (personalized) → "Todos" → backend categories.
  // Synthetic keys live in the same array so FlatList can snap to them.
  const railData = useMemo(() => ([
    { key: 'for_you', label: t('live.forYou') || 'Para você' },
    { key: '',        label: t('common.all') || 'Todos' },
    ...(categories || []).map(c => ({ key: c.key, label: labelFor(c) })),
  ]), [categories, labelFor, t]);

  // Slide the underline whenever the active category changes. Uses
  // measured pill frames so it lines up with the exact pill width — falls
  // back to PILL_SNAP estimate before layout has run.
  useEffect(() => {
    const frame = pillLayoutsRef.current[activeCategory];
    if (!frame) return;
    Animated.parallel([
      Animated.spring(underlineX, {
        toValue: frame.x + 12, // skip leading paddingHorizontal
        useNativeDriver: false,
        speed: 18, bounciness: 6,
      }),
      Animated.spring(underlineW, {
        toValue: Math.max(24, frame.w - 24),
        useNativeDriver: false,
        speed: 18, bounciness: 6,
      }),
    ]).start();
    // Scroll the active pill into view (handy when it's off-screen after
    // a quick filter switch from the search results).
    try {
      pillRailRef.current?.scrollToOffset?.({
        offset: Math.max(0, frame.x - 32),
        animated: true,
      });
    } catch {}
  }, [activeCategory, railData, underlineX, underlineW]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadDiscover(activeCategory, false);
  }, [activeCategory, loadDiscover]);

  const onOpenLive = useCallback((sess) => {
    if (!sess?.id && !sess?.session_id) return;
    const sid = sess.id || sess.session_id;
    router.push({ pathname: '/live-viewer', params: { id: sid } });
  }, [router]);

  const onGoLive = useCallback(() => {
    router.push('/live-broadcast');
  }, [router]);

  // Real-time count of currently-active lives. Reflects the current category
  // filter on purpose so the header tracks what the user is actually
  // browsing (matches TikTok / Twitch hero behavior).
  const liveCount = sessions.length;

  // Hero palette: deep purple base + lighter accent blob — light/dark aware.
  // We fake the gradient with 2 stacked blob layers (no expo-linear-gradient
  // dep just for one screen).
  const heroBg     = isDark ? '#1a0a2e' : BRAND_PURPLE_DARK;
  const heroAccent = isDark ? '#2e1065' : BRAND_PURPLE;

  // Long-press popover (Compartilhar / Reportar). Stubbed buttons for now —
  // wired to nothing until ShareSheet + report flows land. Triggers haptic
  // on open as the tactile confirmation users expect from long-press.
  const [popoverItem, setPopoverItem] = useState(null);
  const onLongPressCard = useCallback((item) => {
    if (Platform.OS !== 'web') {
      try {
        const Haptics = require('expo-haptics');
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      } catch {}
    }
    setPopoverItem(item || null);
  }, []);

  // (labelFor defined above — before railData — to avoid TDZ.)

  // Render a single live card — full-bleed 9:16 thumbnail with overlays.
  // Delegates to LiveCard so each card owns its entrance animation + breathing
  // pulse refs without bloating the parent.
  const renderItem = useCallback(({ item, index }) => (
    <LiveCard
      item={item}
      index={index}
      isDark={isDark}
      t={t}
      onPress={onOpenLive}
      onLongPress={onLongPressCard}
    />
  ), [isDark, onLongPressCard, onOpenLive, t]);

  const keyExtractor = useCallback((item) => String(item.id || item.session_id || item.host_email), []);

  return (
    <View style={[styles.fill, { backgroundColor: colors.background }]}>
      {/* ── Premium gradient hero ─────────────────────────────────────── */}
      <View style={[styles.heroBarWrap, { backgroundColor: heroBg, paddingTop: insets.top + 4 }]}>
        {/* 2 accent blobs to fake a gradient (no expo-linear-gradient dep). */}
        <View pointerEvents="none" style={[styles.heroBarBlob, { backgroundColor: heroAccent }]} />
        <View pointerEvents="none" style={[styles.heroBarBlob2, { backgroundColor: heroAccent }]} />

        {/* Top row: glassy back btn + actions cluster (search + Go-Live CTA). */}
        <View style={styles.heroBarTopRow}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.heroGlassBtn}
            accessibilityRole="button"
            accessibilityLabel={t('common.back') || 'Voltar'}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <IconArrowLeft size={20} color="#fff" />
          </TouchableOpacity>

          <View style={styles.heroBarActions}>
            <TouchableOpacity
              style={styles.heroGlassBtn}
              accessibilityRole="button"
              accessibilityLabel={t('common.search') || 'Buscar'}
              hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            >
              <IconSearch size={18} color="#fff" />
            </TouchableOpacity>

            {/* Go-Live CTA — subtle pulse when user is "stale" (per brief
                the inactivity timer isn't wired yet, so it always pulses). */}
            <Animated.View style={{ transform: [{ scale: heroCtaScale }] }}>
              <TouchableOpacity
                onPress={onGoLive}
                activeOpacity={0.85}
                style={styles.heroGoLiveBtn}
                accessibilityRole="button"
                accessibilityLabel={t('live.goLive') || 'Criar live'}
              >
                <IconVideo size={14} color={BRAND_PURPLE} />
                <Text style={styles.heroGoLiveText}>
                  {t('live.goLive') || 'Criar live'}
                </Text>
              </TouchableOpacity>
            </Animated.View>
          </View>
        </View>

        {/* Big AO VIVO badge w/ breathing halo + real-time live count. */}
        <View style={styles.heroBarBadgeRow}>
          <View style={styles.heroBigBadge}>
            <View style={styles.heroBigBadgeDotWrap}>
              <Animated.View
                style={[styles.heroBigBadgeHalo, {
                  transform: [{ scale: liveHaloScale }],
                  opacity: liveHaloOpacity,
                }]}
              />
              <View style={styles.heroBigBadgeDot} />
            </View>
            <Text style={styles.heroBigBadgeText}>
              {t('live.aoVivo') || 'AO VIVO'}
            </Text>
          </View>

          {(loading && !sessions.length) ? null : (
            <Text style={styles.heroBarCountText}>
              {liveCount}{' '}
              {liveCount === 1
                ? (t('live.headerCountOne') || 'transmissão agora')
                : (t('live.headerCount') || 'transmissões agora')}
            </Text>
          )}
        </View>

        <Text style={styles.heroBarTitle}>
          {t('live.discover') || 'Lives'}
        </Text>
        <Text style={styles.heroBarSubtitle}>
          {t('live.heroSubtitle') || 'Entre numa live, mande presente, ou comece a sua agora.'}
        </Text>
      </View>

      {/* Category pill rail — snap-scroll FlatList with sliding underline */}
      <View style={styles.pillRailWrap}>
        <FlatList
          ref={pillRailRef}
          data={railData}
          keyExtractor={(it) => `pill_${it.key || 'all'}`}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.pillRow}
          decelerationRate="fast"
          snapToInterval={PILL_SNAP}
          snapToAlignment="start"
          renderItem={({ item }) => (
            <CategoryPill
              pillKey={item.key}
              label={item.label}
              icon={CATEGORY_ICONS[item.key]}
              active={activeCategory === item.key}
              onPress={() => setActiveCategory(item.key)}
              onLayout={(e) => {
                const { x, width } = e.nativeEvent.layout;
                pillLayoutsRef.current[item.key] = { x, w: width };
                if (item.key === activeCategory) {
                  underlineX.setValue(x + 12);
                  underlineW.setValue(Math.max(24, width - 24));
                }
              }}
            />
          )}
        />
        {/* Animated 2px underline that spring-slides between active pills. */}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.pillUnderline,
            { transform: [{ translateX: underlineX }], width: underlineW },
          ]}
        />
      </View>

      {/* List */}
      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      ) : error && !sessions.length ? (
        <View style={styles.center}>
          <Text style={{ color: colors.textSecondary }}>{error}</Text>
        </View>
      ) : !sessions.length ? (
        <EmptyLiveDiscover
          colors={colors}
          isDark={isDark}
          t={t}
          router={router}
          refreshing={refreshing}
          onRefresh={onRefresh}
        />
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

      {/* Long-press popover: Compartilhar / Reportar (stubs for now). */}
      <Modal
        visible={!!popoverItem}
        transparent
        animationType="fade"
        onRequestClose={() => setPopoverItem(null)}
      >
        <Pressable style={styles.popoverBackdrop} onPress={() => setPopoverItem(null)}>
          <View style={[styles.popoverCard, { backgroundColor: isDark ? '#1F2937' : '#FFFFFF' }]}>
            <TouchableOpacity style={styles.popoverBtn} onPress={() => setPopoverItem(null)} activeOpacity={0.7}>
              <Text style={[styles.popoverBtnText, { color: colors.text }]}>
                {t('common.share') || 'Compartilhar'}
              </Text>
            </TouchableOpacity>
            <View style={[styles.popoverDivider, { backgroundColor: isDark ? '#374151' : '#E5E7EB' }]} />
            <TouchableOpacity style={styles.popoverBtn} onPress={() => setPopoverItem(null)} activeOpacity={0.7}>
              <Text style={[styles.popoverBtnText, { color: '#EF4444' }]}>
                {t('common.report') || 'Reportar'}
              </Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

// One live tile: 9:16 thumbnail + AO VIVO breathing pulse + viewer glass pill +
// bottom gradient overlay with avatar/title/host. Owns its entrance animation
// (fade + slide-up 8px) staggered by index*40ms so the grid waterfalls in.
function LiveCard({ item, index, isDark, t, onPress, onLongPress }) {
  const thumb = item.thumbnail_url || '';
  const viewerCount = Number(item.viewer_count) || 0;
  const creatorName = item.creator_name || item.host_name || item.host_email || '';
  const creatorAvatar = item.creator_avatar || '';
  const creatorEmail = item.host_email || item.creator_email || '';
  const title = item.title || (t('live.live') || 'Live');

  // Entrance: fade 0→1, translateY 8→0. Staggered via delay = index*40ms so
  // 2-col grid reveals diagonally like TikTok Live's first paint. Cap delay
  // at 480ms so cards far down still appear quickly on long lists.
  const fade = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(8)).current;
  useEffect(() => {
    const delay = Math.min((index || 0) * 40, 480);
    Animated.parallel([
      Animated.timing(fade, {
        toValue: 1, duration: 260, delay,
        easing: Easing.out(Easing.cubic), useNativeDriver: true,
      }),
      Animated.timing(slide, {
        toValue: 0, duration: 260, delay,
        easing: Easing.out(Easing.cubic), useNativeDriver: true,
      }),
    ]).start();
  }, []);

  // AO VIVO breathing pulse — same pattern as CallStatusBar's pulsing red
  // dot. Loops 0→1→0 at 900ms each leg so the badge "breathes" without
  // demanding attention. Drives opacity + scale on the inner dot.
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    ).start();
  }, []);
  const dotOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] });
  const dotScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.15] });

  return (
    <Animated.View style={[styles.cardOuter, { opacity: fade, transform: [{ translateY: slide }] }]}>
      <TouchableOpacity
        onPress={() => onPress(item)}
        onLongPress={() => onLongPress(item)}
        delayLongPress={350}
        activeOpacity={0.9}
        style={[styles.card, { backgroundColor: isDark ? '#0F172A' : '#F1F5F9' }]}
        accessibilityRole="button"
        accessibilityLabel={`${title} — ${creatorName} — ${viewerCount} viewers`}
      >
        <View style={styles.thumbWrap}>
          {thumb ? (
            <Image source={{ uri: thumb }} style={styles.thumb} resizeMode="cover" />
          ) : (
            // Skeleton fallback: 3-band gradient (lights/mid/dark) — no
            // expo-linear-gradient dep, just stacked Views with alpha. Same
            // trick used in ChatReelsTab's bottomFade.
            <View style={[styles.thumb, styles.skeleton]}>
              <View style={[styles.skelBand, { backgroundColor: '#1E293B' }]} />
              <View style={[styles.skelBand, { backgroundColor: '#334155', opacity: 0.85 }]} />
              <View style={[styles.skelBand, { backgroundColor: '#0F172A' }]} />
            </View>
          )}

          {/* Bottom dark→transparent overlay for legibility. Three stacked
              translucent bands fake a linear gradient (no dep). */}
          <View pointerEvents="none" style={styles.gradOverlay}>
            <View style={[styles.gradBand, { height: '40%', backgroundColor: 'rgba(0,0,0,0)' }]} />
            <View style={[styles.gradBand, { height: '30%', backgroundColor: 'rgba(0,0,0,0.35)' }]} />
            <View style={[styles.gradBand, { height: '30%', backgroundColor: 'rgba(0,0,0,0.7)' }]} />
          </View>

          {/* AO VIVO badge (top-left, breathing). */}
          <View style={styles.liveBadge}>
            <Animated.View style={[styles.liveDot, { opacity: dotOpacity, transform: [{ scale: dotScale }] }]} />
            <Text style={styles.liveBadgeText}>{t('live.live') || 'AO VIVO'}</Text>
          </View>

          {/* Viewer count (top-right, glass). */}
          <View style={styles.viewerPill}>
            <IconUsers size={11} color="#fff" />
            <Text style={styles.viewerPillText}>{formatViewers(viewerCount)}</Text>
          </View>

          {/* Bottom overlay: avatar + title + creator name */}
          <View style={styles.bottomOverlay} pointerEvents="none">
            <AvatarCircle
              name={creatorName}
              email={creatorEmail}
              avatarUrl={creatorAvatar}
              size={28}
            />
            <View style={styles.bottomOverlayText}>
              <Text numberOfLines={1} style={styles.bottomTitle}>{title}</Text>
              <Text numberOfLines={1} style={styles.bottomHost}>{creatorName}</Text>
            </View>
          </View>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

// Pill with brand-purple selected fill + spring scale + soft shadow + icon.
// Why useRef + spring: keeps the press feel snappy across re-renders without
// re-creating the Animated.Value each frame.
function CategoryPill({ pillKey, label, icon: Icon, active, onPress, onLayout }) {
  const scale = useRef(new Animated.Value(active ? 1.05 : 1)).current;

  useEffect(() => {
    Animated.spring(scale, {
      toValue: active ? 1.05 : 1,
      useNativeDriver: true,
      speed: 18,
      bounciness: 9,
    }).start();
  }, [active, scale]);

  const iconColor = active ? '#fff' : '#9CA3AF';
  return (
    <Animated.View
      onLayout={onLayout}
      style={{ transform: [{ scale }] }}
    >
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.85}
        style={[
          styles.pill,
          active
            ? styles.pillActive
            : styles.pillInactive,
        ]}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={label}
      >
        {Icon ? <Icon size={14} color={iconColor} /> : null}
        <Text
          style={[
            styles.pillText,
            active && styles.pillTextActive,
          ]}
          numberOfLines={1}
        >
          {label}
        </Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─────────────────────────────────────────────────────────────
// Rich empty state — shown when zero lives are active.
// Replaces the old "Nenhuma live ativa agora" wasteland with:
//   1. Hero SVG (camera + signal waves, brand purple)
//   2. Pulsing primary CTA → /live-broadcast
//   3. "Próximas lives agendadas" (real api.liveScheduled or skeletons)
//   4. "Replays populares" (real api.liveReplays/feedRecent or skeletons)
//   5. "Por que ir ao vivo?" 3-bullet info card
// All API calls are best-effort — falls back to mock placeholders.
// ─────────────────────────────────────────────────────────────
function EmptyLiveDiscover({ colors, isDark, t, router, refreshing, onRefresh }) {
  const [scheduled, setScheduled] = useState(null); // null = loading, [] = no data
  const [replays, setReplays] = useState(null);

  // Halo pulse animation for the primary CTA.
  const pulseAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1400,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulseAnim]);

  // Fetch scheduled lives (graceful fallback if endpoint missing).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (typeof api.liveScheduled !== 'function') {
          if (!cancelled) setScheduled([]);
          return;
        }
        const res = await api.liveScheduled();
        if (cancelled) return;
        const list = res?.data?.scheduled || res?.data?.lives || res?.data?.items || [];
        setScheduled(Array.isArray(list) ? list : []);
      } catch (e) {
        if (!cancelled) setScheduled([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Fetch popular replays (graceful fallback).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let list = [];
        if (typeof api.liveReplays === 'function') {
          const res = await api.liveReplays();
          list = res?.data?.replays || res?.data?.items || [];
        } else if (typeof api.feedRecent === 'function') {
          const res = await api.feedRecent({ type: 'live_replay', limit: 8 });
          list = res?.data?.items || res?.data?.posts || [];
        }
        if (!cancelled) setReplays(Array.isArray(list) ? list : []);
      } catch (e) {
        if (!cancelled) setReplays([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const onStartLive = useCallback(() => {
    router.push('/live-broadcast');
  }, [router]);

  const haloScale = pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.45] });
  const haloOpacity = pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] });

  const cardBg = isDark ? '#1F1147' : '#FAF7FF';
  const subText = colors.textSecondary || '#6B7280';

  return (
    <ScrollView
      contentContainerStyle={styles.emptyScroll}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={!!refreshing}
          onRefresh={onRefresh}
          tintColor={BRAND_PURPLE}
        />
      }
    >
      {/* 1. Hero illustration */}
      <View style={styles.heroWrap}>
        <LiveHeroIllustration isDark={isDark} />
      </View>

      <Text style={[styles.heroTitle, { color: colors.text }]}>
        {t('live.discoverEmpty') || 'Nenhuma live ativa agora'}
      </Text>
      <Text style={[styles.heroSubtitle, { color: subText }]}>
        {t('live.emptySubtitle') || 'Seja o(a) primeiro(a) a entrar ao vivo. Sua audiência está esperando.'}
      </Text>

      {/* 2. Primary CTA with pulse halo */}
      <View style={styles.ctaWrap}>
        <Animated.View
          pointerEvents="none"
          style={[
            styles.ctaHalo,
            { transform: [{ scale: haloScale }], opacity: haloOpacity },
          ]}
        />
        <TouchableOpacity
          activeOpacity={0.88}
          onPress={onStartLive}
          style={styles.ctaBtn}
          accessibilityRole="button"
          accessibilityLabel={t('live.startNowCta') || 'Você poderia começar agora'}
        >
          <IconVideo size={20} color="#fff" />
          <Text style={styles.ctaText}>
            {t('live.startNowCta') || 'Você poderia começar agora!'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* 3. Próximas lives agendadas */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>
            {t('live.upcomingScheduled') || 'Próximas lives agendadas'}
          </Text>
        </View>
        <ScheduledList
          items={(scheduled === null || scheduled.length === 0) ? MOCK_SCHEDULED : scheduled}
          skeleton={scheduled === null}
          colors={colors}
          cardBg={cardBg}
          subText={subText}
          t={t}
        />
      </View>

      {/* 4. Replays populares */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>
            {t('live.popularReplays') || 'Replays populares'}
          </Text>
        </View>
        <ReplayStrip
          items={(replays === null || replays.length === 0) ? MOCK_REPLAYS : replays}
          loading={replays === null}
          colors={colors}
          subText={subText}
          cardBg={cardBg}
          isDark={isDark}
          t={t}
        />
      </View>

      {/* 5. Por que ir ao vivo? */}
      <View style={[styles.whyCard, { backgroundColor: cardBg, borderColor: isDark ? '#3B2270' : '#EDE9FE' }]}>
        <Text style={[styles.whyTitle, { color: colors.text }]}>
          {t('live.whyGoLive') || 'Por que ir ao vivo?'}
        </Text>
        <WhyBullet
          icon={<IconHeart size={16} color="#EC4899" />}
          text={t('live.whyConnect') || 'Conecte em tempo real'}
          color={colors.text}
        />
        <WhyBullet
          icon={<IconGiftBox size={16} color={BRAND_PURPLE} />}
          text={t('live.whyGifts') || 'Receba gifts'}
          color={colors.text}
        />
        <WhyBullet
          icon={<IconSparkles size={16} color="#F59E0B" />}
          text={t('live.whyReach') || 'Aumente seu alcance'}
          color={colors.text}
        />
      </View>

      <View style={{ height: 24 }} />
    </ScrollView>
  );
}

// SVG hero — stylized broadcast camera with concentric signal waves.
// Pure inline react-native-svg so it renders identically on web + native.
function LiveHeroIllustration({ isDark }) {
  const bg = isDark ? '#1F1147' : '#F5F0FF';
  const innerLens = isDark ? '#0F0628' : '#fff';
  return (
    <Svg width={180} height={140} viewBox="0 0 180 140" fill="none">
      <Defs>
        <SvgLinearGradient id="lensGrad" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={BRAND_PURPLE_LIGHT} stopOpacity="1" />
          <Stop offset="1" stopColor={BRAND_PURPLE_DARK} stopOpacity="1" />
        </SvgLinearGradient>
      </Defs>
      {/* Signal waves (left + right) */}
      <G opacity="0.85">
        <Path d="M40 30 Q55 22 70 30" stroke={BRAND_PURPLE} strokeWidth="2.5" strokeLinecap="round" fill="none" opacity="0.35" />
        <Path d="M32 22 Q55 8 78 22" stroke={BRAND_PURPLE} strokeWidth="2.5" strokeLinecap="round" fill="none" opacity="0.55" />
        <Path d="M24 14 Q55 -6 86 14" stroke={BRAND_PURPLE} strokeWidth="2.5" strokeLinecap="round" fill="none" opacity="0.85" />
        <Path d="M140 30 Q125 22 110 30" stroke={BRAND_PURPLE} strokeWidth="2.5" strokeLinecap="round" fill="none" opacity="0.35" />
        <Path d="M148 22 Q125 8 102 22" stroke={BRAND_PURPLE} strokeWidth="2.5" strokeLinecap="round" fill="none" opacity="0.55" />
        <Path d="M156 14 Q125 -6 94 14" stroke={BRAND_PURPLE} strokeWidth="2.5" strokeLinecap="round" fill="none" opacity="0.85" />
      </G>
      {/* Camera body */}
      <Rect x="40" y="50" width="90" height="62" rx="14" fill={bg} stroke={BRAND_PURPLE} strokeWidth="2.5" />
      {/* Camera lens */}
      <Circle cx="85" cy="81" r="22" fill="url(#lensGrad)" />
      <Circle cx="85" cy="81" r="12" fill={innerLens} opacity="0.92" />
      <Circle cx="85" cy="81" r="5" fill={BRAND_PURPLE_DARK} />
      {/* REC dot */}
      <Circle cx="118" cy="62" r="4" fill="#DC2626" />
      {/* Camera handle/tripod base */}
      <Rect x="78" y="112" width="14" height="10" rx="2" fill={BRAND_PURPLE_DARK} />
      <Path d="M55 132 L85 122 L115 132" stroke={BRAND_PURPLE_DARK} strokeWidth="3" strokeLinecap="round" fill="none" />
    </Svg>
  );
}

function ScheduledList({ items, skeleton, colors, cardBg, subText, t }) {
  return (
    <View style={{ gap: 8 }}>
      {items.slice(0, 3).map((it, idx) => (
        <View
          key={it.id || it.session_id || `sch-${idx}`}
          style={[styles.scheduledRow, { backgroundColor: cardBg }]}
        >
          <View style={{ opacity: skeleton ? 0.4 : 1 }}>
            <AvatarCircle
              name={it.host_name || it.name || 'Criador'}
              email={it.host_email || it.email}
              size={42}
            />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={[styles.scheduledName, { color: colors.text, opacity: skeleton ? 0.4 : 1 }]}>
              {(t('live.upcomingPrefix') || 'Em breve:')} {it.host_name || it.name || 'criador'}{' '}
              <Text style={[styles.scheduledNamePlain, { color: subText }]}>
                {t('live.upcomingGoLive') || 'vai entrar ao vivo'}
              </Text>
            </Text>
            <Text numberOfLines={1} style={[styles.scheduledTime, { color: subText }]}>
              {it.scheduled_label || it.starts_at_label || it.time_label || (t('live.timeSoon') || 'Em breve')}
            </Text>
          </View>
          <TouchableOpacity
            activeOpacity={0.85}
            style={styles.notifyBtn}
            disabled={!!skeleton}
            accessibilityRole="button"
            accessibilityLabel={t('live.notifyMe') || 'Avisar'}
          >
            <IconBell size={13} color="#fff" />
            <Text style={styles.notifyBtnText}>{t('live.notifyMe') || 'Avisar'}</Text>
          </TouchableOpacity>
        </View>
      ))}
    </View>
  );
}

function ReplayStrip({ items, loading, colors, subText, cardBg, isDark, t }) {
  const list = (items || []).slice(0, 6);
  if (!list.length) {
    return (
      <Text style={{ color: subText, fontSize: 13, paddingHorizontal: 4 }}>
        {t('live.replayEmpty') || 'Sem replays disponíveis.'}
      </Text>
    );
  }
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingRight: 12, gap: 10 }}
    >
      {list.map((it, idx) => {
        const thumb = it.thumbnail_url || it.thumb_url || it.poster_url || '';
        const views = it.view_count ?? it.views ?? it.viewer_count ?? 0;
        const duration = it.duration_label || it.duration || '';
        return (
          <View
            key={it.id || it.session_id || `rep-${idx}`}
            style={[styles.replayCard, { backgroundColor: cardBg, opacity: loading ? 0.55 : 1 }]}
          >
            <View style={[styles.replayThumb, { backgroundColor: isDark ? '#0F0628' : '#E9E1FF' }]}>
              {thumb ? (
                <Image source={{ uri: thumb }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
              ) : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                  <IconPlay size={28} color={BRAND_PURPLE_LIGHT} />
                </View>
              )}
              {duration ? (
                <View style={styles.replayDuration}>
                  <Text style={styles.replayDurationText}>{String(duration)}</Text>
                </View>
              ) : null}
              <View style={styles.replayViews}>
                <IconUsers size={10} color="#fff" />
                <Text style={styles.replayViewsText}>
                  {typeof formatViewers === 'function' ? formatViewers(views) : String(views)}
                </Text>
              </View>
            </View>
            <View style={styles.replayBody}>
              <AvatarCircle
                name={it.host_name || it.name || 'C'}
                email={it.host_email || it.email}
                size={22}
              />
              <Text numberOfLines={1} style={[styles.replayName, { color: colors.text }]}>
                {it.host_name || it.name || (t('live.creator') || 'Criador')}
              </Text>
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

function WhyBullet({ icon, text, color }) {
  return (
    <View style={styles.whyBullet}>
      <View style={styles.whyIcon}>{icon}</View>
      <Text style={[styles.whyText, { color }]}>{text}</Text>
    </View>
  );
}

// Mock data used as placeholder skeletons when backend endpoints are
// missing or return empty. Names are intentionally generic to avoid
// implying real users are scheduled.
const MOCK_SCHEDULED = [
  { id: 'mock-s1', name: 'criador favorito', scheduled_label: 'Em 2h' },
  { id: 'mock-s2', name: 'sua comunidade',   scheduled_label: 'Hoje, 21:00' },
  { id: 'mock-s3', name: 'novo talento',     scheduled_label: 'Amanhã' },
];

const MOCK_REPLAYS = [
  { id: 'mock-r1', name: 'destaques',    duration_label: '12:34', view_count: 1240 },
  { id: 'mock-r2', name: 'top de ontem', duration_label: '08:11', view_count: 8700 },
  { id: 'mock-r3', name: 'live épica',   duration_label: '24:02', view_count: 530 },
  { id: 'mock-r4', name: 'momentos',     duration_label: '05:48', view_count: 2100 },
];

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

  // ── Premium gradient hero (top of screen) ────────────────────────────
  heroBarWrap: {
    paddingHorizontal: 16,
    paddingBottom: 18,
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: BRAND_PURPLE, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.25, shadowRadius: 14 },
      android: { elevation: 6 },
      default: {},
    }),
  },
  heroBarBlob: {
    position: 'absolute',
    top: -60, right: -40,
    width: 220, height: 220,
    borderRadius: 999,
    opacity: 0.55,
  },
  heroBarBlob2: {
    position: 'absolute',
    bottom: -80, left: -60,
    width: 200, height: 200,
    borderRadius: 999,
    opacity: 0.35,
  },
  heroBarTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  heroBarActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  heroGlassBtn: {
    width: 38, height: 38,
    borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  heroGoLiveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 999,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 8 },
      android: { elevation: 4 },
      default: {},
    }),
  },
  heroGoLiveText: { color: BRAND_PURPLE, fontSize: 13, fontWeight: '800', letterSpacing: 0.2 },
  // Hero badge + count — stacked vertically and aligned right so the AO VIVO
  // badge sits above the live-count text in a tight column (round 51 polish).
  heroBarBadgeRow: {
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 4,
    marginBottom: 6,
    opacity: 1.0,
  },
  heroBigBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#DC2626',
    paddingLeft: 8, paddingRight: 10, paddingVertical: 5,
    borderRadius: 999,
  },
  heroBigBadgeDotWrap: {
    width: 12, height: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  heroBigBadgeDot: {
    width: 7, height: 7,
    borderRadius: 999,
    backgroundColor: '#fff',
  },
  heroBigBadgeHalo: {
    position: 'absolute',
    width: 12, height: 12,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.55)',
  },
  heroBigBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.6,
  },
  heroBarCountText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 12,
    fontWeight: '600',
  },
  heroBarTitle: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: -0.5,
    marginTop: 2,
  },
  heroBarSubtitle: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 13,
    fontWeight: '500',
    marginTop: 4,
    lineHeight: 18,
  },

  pillRailWrap: {
    // Hosts the FlatList + absolutely-positioned underline.
    paddingBottom: 10,
  },
  pillRow: {
    paddingHorizontal: 12,
    paddingBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    marginRight: 8,
    gap: 6,
  },
  pillInactive: {
    backgroundColor: 'transparent',
    borderColor: '#9CA3AF44',
  },
  pillActive: {
    backgroundColor: BRAND_PURPLE,
    borderColor: BRAND_PURPLE,
    // Soft purple glow under the selected pill so it pops off the rail.
    shadowColor: BRAND_PURPLE,
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  pillText: { fontSize: 13, fontWeight: '600', color: '#9CA3AF' },
  pillTextActive: { color: '#fff', fontWeight: '800' },
  pillUnderline: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    height: 2,
    borderRadius: 1,
    backgroundColor: BRAND_PURPLE,
  },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 16, fontWeight: '700', marginBottom: 6 },
  emptyHint: { fontSize: 13, textAlign: 'center' },

  listPad: { padding: 6, paddingBottom: 32 },
  // gap between columns; card has its own internal marginHorizontal for the
  // outer wrapper's breathing room, so total horizontal spacing = 14px.
  // Bumped gap+marginBottom for breathing room in the 2-col grid (TikTok parity).
  colWrap: { gap: 8, marginBottom: 12 },

  // Outer wrapper holds the entrance Animated.View. flex:1 so 2 columns split
  // evenly. We separate this from the inner pressable so transform animations
  // don't collide with the touch target's own active scale (RN quirk).
  cardOuter: { flex: 1, marginHorizontal: 3 },
  card: {
    flex: 1,
    borderRadius: 16,
    overflow: 'hidden',
    // Shadow tuned subtly — TikTok Live cards float without a hard drop.
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  thumbWrap: { aspectRatio: 9 / 16, position: 'relative' },
  thumb: { width: '100%', height: '100%' },

  // 3-band skeleton (no expo-linear-gradient dep).
  skeleton: { flexDirection: 'column' },
  skelBand: { flex: 1, width: '100%' },

  // Bottom dark→transparent overlay (stacked translucent bands).
  gradOverlay: {
    position: 'absolute', left: 0, right: 0, bottom: 0, top: 0,
    flexDirection: 'column',
  },
  gradBand: { width: '100%' },

  liveBadge: {
    position: 'absolute', top: 12, left: 12,
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#DC2626',
    paddingHorizontal: 7, paddingVertical: 3,
    borderRadius: 999,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff', marginRight: 5 },
  liveBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },

  viewerPill: {
    position: 'absolute', top: 12, right: 12,
    flexDirection: 'row', alignItems: 'center',
    // Glass: dark base + slight border for the "blur" suggestion. We can't do
    // a real backdrop-filter on native without expo-blur, so this is the
    // de-facto Instagram/TikTok-Live approximation.
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 7, paddingVertical: 3,
    borderRadius: 999, gap: 4,
  },
  viewerPillText: { color: '#fff', fontSize: 11, fontWeight: '700' },

  // Bottom info block sits on top of the gradient overlay. Padding tuned so
  // the avatar + 2-line text never collide with the safe edge.
  bottomOverlay: {
    position: 'absolute', left: 8, right: 8, bottom: 8,
    flexDirection: 'row', alignItems: 'center', gap: 8,
  },
  bottomOverlayText: { flex: 1, minWidth: 0 },
  bottomTitle: { color: '#fff', fontSize: 13, fontWeight: '600' },
  bottomHost: { color: 'rgba(255,255,255,0.78)', fontSize: 11, fontWeight: '500', marginTop: 1 },

  // Long-press popover.
  popoverBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 32,
  },
  popoverCard: {
    minWidth: 220, borderRadius: 14, overflow: 'hidden',
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 }, elevation: 8,
  },
  popoverBtn: { paddingVertical: 14, alignItems: 'center', justifyContent: 'center' },
  popoverBtnText: { fontSize: 15, fontWeight: '600' },
  popoverDivider: { height: StyleSheet.hairlineWidth, width: '100%' },

  // ── Empty state (EmptyLiveDiscover) ──
  emptyScroll: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 32 },

  heroWrap: { alignItems: 'center', marginTop: 8, marginBottom: 8 },
  heroTitle: { fontSize: 20, fontWeight: '800', textAlign: 'center', marginTop: 4 },
  heroSubtitle: {
    fontSize: 13, textAlign: 'center', marginTop: 6,
    paddingHorizontal: 12, lineHeight: 18,
  },

  ctaWrap: {
    alignItems: 'center', justifyContent: 'center',
    marginTop: 18, marginBottom: 8, height: 60,
  },
  ctaHalo: {
    position: 'absolute',
    width: 260, height: 60, borderRadius: 999,
    backgroundColor: BRAND_PURPLE,
  },
  ctaBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 24, paddingVertical: 14, borderRadius: 999,
    backgroundColor: BRAND_PURPLE, gap: 10,
    shadowColor: BRAND_PURPLE, shadowOpacity: 0.45,
    shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 8,
  },
  ctaText: { color: '#fff', fontSize: 15, fontWeight: '800', letterSpacing: 0.2 },

  section: { marginTop: 22 },
  sectionHeader: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', marginBottom: 10,
  },
  sectionTitle: { fontSize: 15, fontWeight: '800' },

  scheduledRow: {
    flexDirection: 'row', alignItems: 'center',
    padding: 10, borderRadius: 12, gap: 12,
  },
  scheduledName: { fontSize: 13, fontWeight: '700' },
  scheduledNamePlain: { fontSize: 13, fontWeight: '500' },
  scheduledTime: { fontSize: 11, marginTop: 2 },
  notifyBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
    backgroundColor: BRAND_PURPLE,
  },
  notifyBtnText: { color: '#fff', fontSize: 11, fontWeight: '800' },

  replayCard: {
    width: 140, borderRadius: 12, overflow: 'hidden',
  },
  replayThumb: {
    width: '100%', aspectRatio: 9 / 14, position: 'relative',
    alignItems: 'center', justifyContent: 'center',
  },
  replayDuration: {
    position: 'absolute', bottom: 6, right: 6,
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6,
  },
  replayDurationText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  replayViews: {
    position: 'absolute', top: 6, left: 6,
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999,
  },
  replayViewsText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  replayBody: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    padding: 8,
  },
  replayName: { fontSize: 12, fontWeight: '700', flex: 1 },

  whyCard: {
    marginTop: 22, padding: 16, borderRadius: 14, borderWidth: 1, gap: 10,
  },
  whyTitle: { fontSize: 14, fontWeight: '800', marginBottom: 4 },
  whyBullet: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  whyIcon: {
    width: 24, height: 24, alignItems: 'center', justifyContent: 'center',
  },
  whyText: { fontSize: 13, fontWeight: '600' },
});
