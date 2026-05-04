import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform, Animated, Dimensions, TextInput, Modal, Pressable } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useAuth, isChildAccount } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import {
  IconArrowLeft, IconPlus, IconPhone, IconSearch, IconMail, IconCalendar,
  IconFilm, IconFolder, IconCloud, IconFileText, IconStickyNote, IconUsers,
  IconImage, IconVideo, IconSparkles, IconUser, IconSettings, IconStar,
  IconBell, IconShield, IconGlobe, IconGrid, IconCamera,
} from '../components/Icons';
import Svg, { Circle as SvgCircle, Path, Rect, Line, Defs, LinearGradient, Stop } from 'react-native-svg';
import ChatListTab from '../components/ChatListTab';
import AvatarCircle from '../components/AvatarCircle';
import ChatCallsTab from '../components/ChatCallsTab';
import ChatFeedTab from '../components/ChatFeedTab';
import ChatStatusTab from '../components/ChatStatusTab';
import ChannelsTab from '../components/ChannelsTab';
import CommunitiesTab from '../components/CommunitiesTab';
import KidsLearnTab from '../components/KidsLearnTab';
import KidsTVTab from '../components/KidsTVTab';
import SyncBar from '../components/SyncBar';
import { isSyncComplete, runInitialSync } from '../services/initialSync';
import PlusOnboardingTour, { checkShouldShowPlusOnboarding } from '../components/PlusOnboardingTour';
import GlobalSearch from '../components/GlobalSearch';

// ─── Custom SVG Icons for Tab Bar ───

function IconFeedTab({ size = 24, color = '#666', active }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={active ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="3" y="3" width="7" height="7" rx="1.5" />
      <Rect x="14" y="3" width="7" height="7" rx="1.5" />
      <Rect x="3" y="14" width="7" height="7" rx="1.5" />
      <Rect x="14" y="14" width="7" height="7" rx="1.5" />
    </Svg>
  );
}

function IconCallsTab({ size = 24, color = '#666', active }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={active ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z" />
    </Svg>
  );
}

function IconChatsTab({ size = 24, color = '#666', active }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={active ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
      <Line x1="8" y1="9" x2="16" y2="9" stroke={color} strokeWidth="1.5" />
      <Line x1="8" y1="13" x2="13" y2="13" stroke={color} strokeWidth="1.5" />
    </Svg>
  );
}

function IconConfigTab({ size = 24, color = '#666', active }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={active ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" />
      <SvgCircle cx="12" cy="12" r="3" />
    </Svg>
  );
}

function IconStatusTab({ size = 24, color = '#666', active }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={active ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round">
      <SvgCircle cx="12" cy="12" r="9" strokeDasharray={active ? undefined : "4 3"} />
      <SvgCircle cx="12" cy="12" r="4" />
    </Svg>
  );
}

function IconOneTab({ size = 24, color = '#666', active }) {
  // Sparkle / AI glyph for the One assistant tab
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={active ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z" fill={active ? color : 'none'} />
      <Path d="M19 15l.9 2.3L22 18l-2.1.7L19 21l-.9-2.3L16 18l2.1-.7z" fill={active ? color : 'none'} />
    </Svg>
  );
}

function IconAppsTab({ size = 24, color = '#666', active }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <SvgCircle cx="5" cy="5" r="2" fill={color} />
      <SvgCircle cx="12" cy="5" r="2" fill={color} />
      <SvgCircle cx="19" cy="5" r="2" fill={color} />
      <SvgCircle cx="5" cy="12" r="2" fill={color} />
      <SvgCircle cx="12" cy="12" r="2" fill={color} />
      <SvgCircle cx="19" cy="12" r="2" fill={color} />
      <SvgCircle cx="5" cy="19" r="2" fill={color} />
      <SvgCircle cx="12" cy="19" r="2" fill={color} />
      <SvgCircle cx="19" cy="19" r="2" fill={color} />
    </Svg>
  );
}

function IconEmailTab({ size = 24, color = '#666', active }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={active ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="2" y="4" width="20" height="16" rx="2" />
      <Path d="M2 7l10 6 10-6" />
    </Svg>
  );
}

function IconCameraHeader({ size = 18, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
      <SvgCircle cx="12" cy="13" r="4" />
    </Svg>
  );
}

function IconClose({ size = 20, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Line x1="18" y1="6" x2="6" y2="18" />
      <Line x1="6" y1="6" x2="18" y2="18" />
    </Svg>
  );
}

class ChatErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: '#dc2626', marginBottom: 12 }}>Erro</Text>
          <Text style={{ fontSize: 13, color: '#666', textAlign: 'center' }}>{String(this.state.error)}</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

export default function ChatScreenWrapper() {
  return (
    <ChatErrorBoundary>
      <ChatHub />
    </ChatErrorBoundary>
  );
}

const ACCENT = '#7C3AED';
const ACCENT_DARK = '#6D28D9';
const ACCENT_GLOW = 'rgba(124,58,237,0.35)';
const ACCENT2 = '#6D28D9';
const DESKTOP_BREAKPOINT = 900;

// Mobile bottom bar: 5 tabs — Email + Reels + Chats + Calls + Apps
// On desktop (width ≥ 900) the sidebar already has Email, so TAB_KEYS_DESKTOP
// omits it; the phone bottom bar keeps Email as a primary tab.
const TAB_KEYS_FULL = ['email', 'reels', 'chats', 'calls', 'apps'];
// Desktop keeps the classic email-hub layout — user asked for it to stay as-is.
// Profile is no longer a chat tab — tap the avatar in the header to reach
// /u/{email}. Keeps a single profile surface across the whole app.
const TAB_KEYS_DESKTOP = ['feed', 'calls', 'chats'];
const TAB_KEYS_KIDS = ['chats', 'learn', 'tv'];

// Gradient brand title for "Chatyy" (web only renders as two-tone, native as well)
function BrandTitle({ colors, size = 22, light }) {
  return (
    <View style={styles.brandWrap}>
      {isChildAccount() ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
            <Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="#ec4899" opacity={0.9} />
            <Path d="M9 12l2 2 4-4" stroke="#fff" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
          <Text style={[styles.brandTitle, { color: '#fff', fontSize: size }]}>Chatyy</Text>
          <View style={{ backgroundColor: '#ec4899', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 }}>
            <Text style={{ color: '#fff', fontSize: size - 6, fontWeight: '800' }}>Kids</Text>
          </View>
        </View>
      ) : (
        <Text style={[styles.brandTitle, { color: light ? '#fff' : colors.text, fontSize: size }]}>Chatyy</Text>
      )}
    </View>
  );
}

function ChatHub() {
  const { colors, isDark } = useTheme();
  const { user } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();
  const params = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const isKids = isChildAccount();
  // Valid tabs — anything else (legacy 'config'/'settings' deep links) falls back to 'chats' to avoid a blank page.
  const VALID_TABS = ['chats','calls','feed','status','learn','tv','channels','communities'];
  const _initialTab = VALID_TABS.includes(params.tab) ? params.tab : 'chats';
  const [activeTab, setActiveTab] = useState(_initialTab);
  const [mountedTabs, setMountedTabs] = useState(() => new Set(['chats', _initialTab])); // lazy mount: include initial tab to avoid white screen on deep-link
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchAnim = useRef(new Animated.Value(0)).current;

  // Universal search overlay (search_global backend) — opens via "Buscar tudo"
  // chip dentro da search bar local; vai além do chat e procura emails, posts,
  // users, files numa única tela.
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);

  // Plus onboarding tour: 1ª vez que detecta plan='one'/'plus' depois do
  // upgrade, abre um tour de 5 slides explicando o que desbloqueou. AsyncStorage
  // guarda o flag pra não mostrar de novo. Delay de 1.2s pra deixar a tela
  // assentar antes do modal aparecer.
  const [showPlusTour, setShowPlusTour] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const should = await checkShouldShowPlusOnboarding();
        if (!cancelled && should) setShowPlusTour(true);
      } catch {}
    }, 1200);
    return () => { cancelled = true; clearTimeout(t); };
  }, []);

  // Track window dimensions for responsive layout
  const [windowWidth, setWindowWidth] = useState(Dimensions.get('window').width);
  useEffect(() => {
    const sub = Dimensions.addEventListener('change', ({ window }) => {
      setWindowWidth(window.width);
    });
    return () => sub?.remove?.();
  }, []);

  // Use tablet/desktop layout on web OR when width is tablet-sized (iPad, Android tablets)
  const isDesktop = windowWidth >= DESKTOP_BREAKPOINT;
  const isWeb = Platform.OS === 'web';

  // Mobile and desktop have different layouts — mobile put One/Apps in the
  // bottom bar, desktop keeps the classic Feed/Status rail.
  const TAB_KEYS = isKids ? TAB_KEYS_KIDS : (isDesktop ? TAB_KEYS_DESKTOP : TAB_KEYS_FULL);

  // Animated indicator position
  const indicatorAnim = useRef(new Animated.Value(TAB_KEYS.indexOf('chats'))).current;
  const screenWidth = Dimensions.get('window').width;
  const tabWidth = isDesktop ? 72 : screenWidth / TAB_KEYS.length;

  // Content fade animation
  const contentOpacity = useRef(new Animated.Value(1)).current;

  const [showAppsDrawer, setShowAppsDrawer] = useState(false);
  // Per-app badge counts surfaced on the apps drawer tiles. Refreshed
  // whenever the drawer opens — no need to keep this hot in the
  // background since the badges only matter when the drawer is visible.
  const [appsBadges, setAppsBadges] = useState({});

  const closeAppsDrawer = useCallback(() => setShowAppsDrawer(false), []);

  // Refresh badge counts on drawer open. Pulls a single quick endpoint
  // that returns { email_unread, notifications_unread, calls_missed }
  // — no individual calls per app. Failure is silent: tiles just render
  // without badges, no error UI required.
  React.useEffect(() => {
    if (!showAppsDrawer) return;
    let cancelled = false;
    (async () => {
      try {
        const api = require('../services/api');
        const [emailR, notifR, callsR] = await Promise.all([
          (api.inboxUnreadCount ? api.inboxUnreadCount() : Promise.resolve(null)).catch(() => null),
          (api.notificationsUnreadCount ? api.notificationsUnreadCount() : Promise.resolve(null)).catch(() => null),
          (api.callsMissedCount ? api.callsMissedCount() : Promise.resolve(null)).catch(() => null),
        ]);
        if (cancelled) return;
        const next = {};
        const eu = Number(emailR?.data?.unread || emailR?.data?.count || 0);
        const nu = Number(notifR?.data?.unread || notifR?.data?.count || 0);
        const cm = Number(callsR?.data?.missed || callsR?.data?.count || 0);
        if (eu > 0) next.email = eu;
        if (nu > 0) next.notifications = nu;
        if (cm > 0) next.calls = cm;
        setAppsBadges(next);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [showAppsDrawer]);

  const handleTabPress = useCallback((tab) => {
    // "Apps" is a drawer overlay — it doesn't switch tabs, so we keep the
    // chats tab active underneath and just open the modal.
    if (tab === 'apps') { setShowAppsDrawer(true); return; }
    // "One" is the AI assistant screen — full navigation, not an inline tab.
    if (tab === 'one') { try { router.push('/one'); } catch (e) { console.warn("[chat] router.push failed:", e); } return; }
    // "Email" jumps to the inbox screen (same pattern as One).
    if (tab === 'email') { try { router.push('/inbox'); } catch (e) { console.warn("[chat] router.push failed:", e); } return; }
    // "Reels" opens feed with reels tab active
    if (tab === 'reels') { handleTabPress('feed'); return; }
    if (tab === activeTab) return;
    const idx = TAB_KEYS.indexOf(tab);

    // Tabs in the bottom bar slide the indicator. Off-bar tabs (Feed/Status
    // launched from the Apps drawer on mobile) just switch content without
    // animating the indicator.
    if (idx >= 0) {
      Animated.spring(indicatorAnim, {
        toValue: idx,
        useNativeDriver: false,
        tension: 120,
        friction: 16,
        overshootClamping: false,
      }).start();
    }

    // Premium crossfade: fast fade out, spring fade in
    Animated.sequence([
      Animated.timing(contentOpacity, { toValue: 0, duration: 60, useNativeDriver: false }),
      Animated.spring(contentOpacity, { toValue: 1, useNativeDriver: false, tension: 100, friction: 18 }),
    ]).start();

    setActiveTab(tab);
    setMountedTabs(prev => { const next = new Set(prev); next.add(tab); return next; });
  }, [indicatorAnim, contentOpacity, activeTab, TAB_KEYS]);

  // Trigger initial sync ONCE (not on every open)
  const syncTriggered = useRef(false);
  useEffect(() => {
    if (!syncTriggered.current && !isSyncComplete() && user?.token) {
      syncTriggered.current = true;
      const api = require('../services/api');
      runInitialSync(api).catch(() => {});
    }
  }, [user?.token]);

  const handleBack = useCallback(() => {
    if (activeTab !== 'chats') {
      handleTabPress('chats');
      return;
    }
    if (isKids) return;
    try {
      if (router.canGoBack && router.canGoBack()) {
        router.back();
      } else if (isDesktop) {
        // Desktop: fall back to inbox if there's no stack entry to pop
        router.replace('/inbox');
      }
      // Mobile: do nothing (WhatsApp-style — chat IS the home screen,
      // there's nowhere "back" to go). Previous code sent users to /inbox
      // which made the app feel like email was the main screen.
    } catch { if (isDesktop) { try { router.replace('/inbox'); } catch (e) { console.warn("[chat] router.push failed:", e); } } }
  }, [activeTab, handleTabPress, router, isKids, isDesktop]);

  const openFeedFromApps = useCallback(() => { setShowAppsDrawer(false); handleTabPress('feed'); }, [handleTabPress]);
  const openStatusFromApps = useCallback(() => { setShowAppsDrawer(false); handleTabPress('status'); }, [handleTabPress]);
  const openChannelsFromApps = useCallback(() => { setShowAppsDrawer(false); handleTabPress('channels'); }, [handleTabPress]);
  const openCommunitiesFromApps = useCallback(() => { setShowAppsDrawer(false); handleTabPress('communities'); }, [handleTabPress]);

  // Handle hardware/browser back button on web
  useEffect(() => {
    if (Platform.OS === 'web' && typeof window !== 'undefined' && activeTab !== 'chats') {
      window.history.pushState(null, '', window.location.href);
      const onPopState = () => {
        window.history.pushState(null, '', window.location.href);
        handleTabPress('chats');
      };
      window.addEventListener('popstate', onPopState);
      return () => window.removeEventListener('popstate', onPopState);
    }
  }, [activeTab, handleTabPress]);

  const toggleSearch = useCallback(() => {
    if (searchOpen) {
      setSearchQuery(''); // clear on close
      Animated.timing(searchAnim, { toValue: 0, duration: 220, useNativeDriver: false }).start(() => setSearchOpen(false));
    } else {
      setSearchOpen(true);
      Animated.spring(searchAnim, { toValue: 1, tension: 100, friction: 15, useNativeDriver: false }).start();
    }
  }, [searchOpen, searchAnim]);

  // When profile screen routes user here with `new=1`, ChatStatusTab picks
  // that up and opens the creator immediately. Reset on first consume so a
  // refresh/re-render doesn't re-open the composer.
  const [autoNewStatus, setAutoNewStatus] = useState(() => params.new === '1');
  useEffect(() => {
    if (autoNewStatus) {
      const t = setTimeout(() => setAutoNewStatus(false), 500);
      return () => clearTimeout(t);
    }
  }, [autoNewStatus]);
  const tabProps = { colors, isDark, t, user, router, searchQuery, setActiveTab, autoNewStatus };

  const titles = {
    feed: t('feed.title') || 'Feed',
    status: 'Status',
    calls: t('chat.tabCalls') || 'Ligacoes',
    chats: t('chat.tabChats') || 'Conversas',
    config: t('chat.tabConfig') || 'Configuracoes',
    learn: 'Professora ONE 🎓',
    tv: 'Chatyy TV 🎬',
    channels: t('channel.title') || 'Channels',
    communities: t('community.title') || 'Communities',
  };

  const renderHeaderAction = () => {
    const headerIconColor = '#fff';
    const btnStyle = [styles.headerIconBtn, { backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 20 }];
    if (activeTab === 'chats') {
      return (
        <>
          <TouchableOpacity onPress={() => { try { router.push('/photos?camera=1'); } catch (e) { console.warn("[chat] router.push failed:", e); } }} activeOpacity={0.6}
            style={btnStyle} accessibilityLabel="Camera">
            <IconCamera size={19} color={headerIconColor} />
          </TouchableOpacity>
          <TouchableOpacity onPress={toggleSearch} activeOpacity={0.6}
            style={btnStyle} accessibilityLabel="Search">
            <IconSearch size={18} color={headerIconColor} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push('/chat-new')} activeOpacity={0.6}
            style={btnStyle} accessibilityLabel="New chat">
            <IconPlus size={18} color={headerIconColor} />
          </TouchableOpacity>
        </>
      );
    }
    if (activeTab === 'calls') {
      return (
        <TouchableOpacity onPress={() => router.push('/chat-new')} activeOpacity={0.6}
          style={[styles.headerIconBtn, { backgroundColor: 'rgba(255,255,255,0.1)' }]}>
          <IconPhone size={17} color={headerIconColor} />
        </TouchableOpacity>
      );
    }
    if (activeTab === 'status') {
      return (
        <TouchableOpacity onPress={() => {}} activeOpacity={0.6}
          style={[styles.headerIconBtn, { backgroundColor: 'rgba(255,255,255,0.1)' }]}>
          <IconCameraHeader size={18} color={headerIconColor} />
        </TouchableOpacity>
      );
    }
    if (activeTab === 'feed') {
      return (
        <TouchableOpacity onPress={toggleSearch} activeOpacity={0.6}
          style={[styles.headerIconBtn, { backgroundColor: 'rgba(255,255,255,0.1)' }]}>
          <IconSearch size={18} color={headerIconColor} />
        </TouchableOpacity>
      );
    }
    return null;
  };

  // Mobile bottom tab bar indicator
  const indicatorTranslateX = indicatorAnim.interpolate({
    inputRange: [0, 1, 2, 3, 4],
    outputRange: TAB_KEYS.map((_, i) => (i * tabWidth) + (tabWidth / 2) - 18),
  });

  const indicatorScale = indicatorAnim.interpolate({
    inputRange: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4],
    outputRange: [1, 1.15, 1, 1.15, 1, 1.15, 1, 1.15, 1],
  });

  const searchHeight = searchAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 52] });
  const searchOpacity = searchAnim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 0, 1] });

  // WhatsApp 2026 header style — premium gradient
  const glassHeader = isKids
    ? (Platform.OS === 'web'
      ? { background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 40%, #ec4899 100%)' }
      : { backgroundColor: isDark ? '#3b1d6e' : '#6366f1' })
    : (Platform.OS === 'web'
      ? { background: isDark ? 'linear-gradient(180deg, #1a0a2e 0%, #0a0a0a 100%)' : 'linear-gradient(180deg, #5B21B6 0%, #7C3AED 100%)' }
      : { backgroundColor: isDark ? '#0d0a14' : '#6D28D9' });

  const glassTabBar = {
    backgroundColor: isDark ? '#0a0a0a' : '#ffffff',
  };

  // ── DESKTOP LAYOUT (side rail + content) ──
  if (isDesktop) {
    return (
      <View style={[styles.container, { backgroundColor: isDark ? '#000000' : '#f0f2f5', flexDirection: 'row' }]}>
        {/* Side Rail */}
        <View style={[styles.desktopRail, {
          backgroundColor: isKids ? (isDark ? '#3b1d6e' : '#6366f1') : (isDark ? '#0a0a0a' : '#6D28D9'),
          borderRightColor: 'transparent',
        }]}>
          {/* Brand at top — icon only: 72px rail is too narrow for the "Chatyy" wordmark, which would overflow to the left. */}
          <View style={styles.desktopBrandWrap}>
            <Svg width={28} height={28} viewBox="0 0 24 24" fill="none">
              <Path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            </Svg>
          </View>

          {/* Tab items */}
          <View style={styles.desktopTabList}>
            {TAB_KEYS.map((key) => (
              <DesktopTabItem
                key={key}
                tabKey={key}
                icon={key === 'feed' ? IconFeedTab : key === 'status' ? IconStatusTab : key === 'calls' ? IconCallsTab : key === 'chats' ? IconChatsTab : IconConfigTab}
                label={key === 'chats' ? 'Chats' : key === 'feed' ? 'Feed' : key === 'status' ? 'Status' : key === 'calls' ? (t('chat.tabCalls') || 'Ligacoes') : (t('chat.tabConfig') || 'Config')}
                active={activeTab === key}
                onPress={() => handleTabPress(key)}
                isDark={isDark}
              />
            ))}
          </View>

          {/* Back button at bottom (hidden for kids) */}
          {!isKids && (
          <TouchableOpacity onPress={() => router.back()} activeOpacity={0.6}
            style={[styles.desktopBackBtn, {
              backgroundColor: 'rgba(255,255,255,0.1)',
            }]}>
            <IconArrowLeft size={20} color="rgba(255,255,255,0.8)" />
          </TouchableOpacity>
          )}
        </View>

        {/* Main content area */}
        <View style={{ flex: 1, flexDirection: 'column' }}>
          {/* Desktop header with glass */}
          <View style={[styles.desktopHeader, {
            ...glassHeader,
            borderBottomWidth: 0,
          }]}>
            <View style={styles.titleWrap}>
              <Text style={[styles.title, { color: '#fff' }]}>{titles[activeTab]}</Text>
            </View>
            <View style={styles.headerActions}>
              {renderHeaderAction()}
            </View>
          </View>

          {/* Search bar */}
          <Animated.View style={[styles.searchBarOuter, {
            height: searchHeight, opacity: searchOpacity,
            ...glassHeader,
            borderBottomColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
            overflow: 'hidden',
          }]}>
            {searchOpen && (
              <View style={[styles.searchBar, {
                backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)',
                ...(isWeb ? { backdropFilter: 'blur(8px)' } : {}),
              }]}>
                <IconSearch size={16} color={isDark ? '#6b7280' : '#9ca3af'} />
                <TextInput autoFocus placeholder={t('common.search') || 'Buscar...'} placeholderTextColor={isDark ? '#6b7280' : '#9ca3af'}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  returnKeyType="search"
                  clearButtonMode="while-editing"
                  style={[styles.searchInput, { color: colors.text }]} />
                {/* Buscar tudo — abre Spotlight overlay com results de
                    emails + posts + users além das conversas. */}
                <TouchableOpacity
                  onPress={() => setShowGlobalSearch(true)}
                  activeOpacity={0.6}
                  style={{ paddingHorizontal: 8, paddingVertical: 4, marginRight: 4, borderRadius: 12, backgroundColor: isDark ? 'rgba(124,58,237,0.18)' : 'rgba(124,58,237,0.10)' }}
                >
                  <Text style={{ fontSize: 11, fontWeight: '700', color: '#7C3AED' }}>{t('common.searchAll') || 'Tudo'}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={toggleSearch} activeOpacity={0.6} style={styles.searchCloseBtn}>
                  <IconClose size={16} color={isDark ? '#6b7280' : '#9ca3af'} />
                </TouchableOpacity>
              </View>
            )}
          </Animated.View>

          {/* WhatsApp-style sync bar */}
          <SyncBar />

          {/* Content - lazy mount: only mount tab once visited, then keep mounted hidden */}
          <Animated.View style={{ flex: 1, opacity: contentOpacity }}>
            <View style={{ display: activeTab === 'chats' ? 'flex' : 'none', flex: activeTab === 'chats' ? 1 : undefined }}>
              <ChatErrorBoundary><ChatListTab {...tabProps} /></ChatErrorBoundary>
            </View>
            {mountedTabs.has('calls') && <View style={{ display: activeTab === 'calls' ? 'flex' : 'none', flex: activeTab === 'calls' ? 1 : undefined }}>
              <ChatErrorBoundary><ChatCallsTab {...tabProps} /></ChatErrorBoundary>
            </View>}
            {mountedTabs.has('feed') && <View style={{ display: activeTab === 'feed' ? 'flex' : 'none', flex: activeTab === 'feed' ? 1 : undefined }}>
              <ChatErrorBoundary><ChatFeedTab {...tabProps} /></ChatErrorBoundary>
            </View>}
            {mountedTabs.has('status') && <View style={{ display: activeTab === 'status' ? 'flex' : 'none', flex: activeTab === 'status' ? 1 : undefined }}>
              <ChatErrorBoundary><ChatStatusTab {...tabProps} /></ChatErrorBoundary>
            </View>}
            {/* Removed: 'config' tab rendered ChatProfileTab which duplicated
                the unified profile. Taps on the header avatar now open /u/{me}. */}
            {mountedTabs.has('learn') && <View style={{ display: activeTab === 'learn' ? 'flex' : 'none', flex: activeTab === 'learn' ? 1 : undefined }}>
              <ChatErrorBoundary><KidsLearnTab {...tabProps} /></ChatErrorBoundary>
            </View>}
            {mountedTabs.has('tv') && <View style={{ display: activeTab === 'tv' ? 'flex' : 'none', flex: activeTab === 'tv' ? 1 : undefined }}>
              <ChatErrorBoundary><KidsTVTab {...tabProps} /></ChatErrorBoundary>
            </View>}
            {mountedTabs.has('channels') && <View style={{ display: activeTab === 'channels' ? 'flex' : 'none', flex: activeTab === 'channels' ? 1 : undefined }}>
              <ChatErrorBoundary><ChannelsTab {...tabProps} /></ChatErrorBoundary>
            </View>}
            {mountedTabs.has('communities') && <View style={{ display: activeTab === 'communities' ? 'flex' : 'none', flex: activeTab === 'communities' ? 1 : undefined }}>
              <ChatErrorBoundary><CommunitiesTab {...tabProps} /></ChatErrorBoundary>
            </View>}
          </Animated.View>
          {/* ChatListTab has its own FAB (new chat/group/channel), and
              ChatFeedTab has its own composer — nothing to render here. */}
        </View>
      </View>
    );
  }

  // ── MOBILE LAYOUT (bottom tab bar) ──
  return (
    <View style={[styles.container, {
      backgroundColor: isDark ? '#000000' : '#ffffff',
      paddingTop: insets.top,
    }]}>
      {/* WhatsApp-style header — no back arrow on mobile (Chatyy IS home) */}
      <View style={[styles.header, {
        ...glassHeader,
        borderBottomWidth: 0,
        paddingLeft: 14,
      }]}>
        {/* Profile avatar — opens the unified profile (/u/{me}).
            Was routing to the deprecated "config" tab (ChatProfileTab),
            which duplicated the profile UI inside the chat shell. */}
        {activeTab === 'chats' && (
          <TouchableOpacity
            onPress={() => user?.email && router.push(`/u/${encodeURIComponent(user.email)}`)}
            activeOpacity={0.7}
            style={{ marginRight: 10 }}
            accessibilityLabel="Profile"
          >
            <AvatarCircle name={user?.name || user?.email} email={user?.email} size={32} />
          </TouchableOpacity>
        )}
        <View style={[styles.titleWrap, { flex: 1 }]}>
          {activeTab === 'chats' ? (
            <BrandTitle colors={colors} light />
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <TouchableOpacity onPress={() => handleTabPress('chats')} hitSlop={10}>
                <IconArrowLeft size={18} color="rgba(255,255,255,0.8)" />
              </TouchableOpacity>
              <Text style={[styles.title, { color: '#fff' }]}>{titles[activeTab]}</Text>
            </View>
          )}
        </View>
        <View style={styles.headerActions}>
          {renderHeaderAction()}
        </View>
      </View>

      {/* Animated search bar */}
      <Animated.View style={[styles.searchBarOuter, {
        height: searchHeight, opacity: searchOpacity,
        ...glassHeader,
        borderBottomColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
        overflow: 'hidden',
      }]}>
        {searchOpen && (
          <View style={[styles.searchBar, {
            backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)',
            ...(isWeb ? { backdropFilter: 'blur(8px)' } : {}),
          }]}>
            <IconSearch size={16} color={isDark ? '#6b7280' : '#9ca3af'} />
            <TextInput autoFocus placeholder={t('common.search') || 'Buscar...'} placeholderTextColor={isDark ? '#6b7280' : '#9ca3af'}
              value={searchQuery}
              onChangeText={setSearchQuery}
              returnKeyType="search"
              clearButtonMode="while-editing"
              style={[styles.searchInput, { color: colors.text }]} />
            <TouchableOpacity onPress={toggleSearch} activeOpacity={0.6} style={styles.searchCloseBtn}>
              <IconClose size={16} color={isDark ? '#6b7280' : '#9ca3af'} />
            </TouchableOpacity>
          </View>
        )}
      </Animated.View>

      {/* WhatsApp-style sync bar */}
      <SyncBar />

      {/* Tab content with fade - lazy mount: only mount tab once visited */}
      <Animated.View style={{ flex: 1, opacity: contentOpacity }}>
        <View style={{ display: activeTab === 'chats' ? 'flex' : 'none', flex: activeTab === 'chats' ? 1 : undefined }}>
          <ChatErrorBoundary><ChatListTab {...tabProps} /></ChatErrorBoundary>
        </View>
        {mountedTabs.has('calls') && <View style={{ display: activeTab === 'calls' ? 'flex' : 'none', flex: activeTab === 'calls' ? 1 : undefined }}>
          <ChatErrorBoundary><ChatCallsTab {...tabProps} /></ChatErrorBoundary>
        </View>}
        {mountedTabs.has('feed') && <View style={{ display: activeTab === 'feed' ? 'flex' : 'none', flex: activeTab === 'feed' ? 1 : undefined }}>
          <ChatErrorBoundary><ChatFeedTab {...tabProps} /></ChatErrorBoundary>
        </View>}
        {mountedTabs.has('status') && <View style={{ display: activeTab === 'status' ? 'flex' : 'none', flex: activeTab === 'status' ? 1 : undefined }}>
          <ChatErrorBoundary><ChatStatusTab {...tabProps} /></ChatErrorBoundary>
        </View>}
        {/* Removed: config/profile duplicate — header avatar routes to /u/{me} */}
        {mountedTabs.has('learn') && <View style={{ display: activeTab === 'learn' ? 'flex' : 'none', flex: activeTab === 'learn' ? 1 : undefined }}>
          <ChatErrorBoundary><KidsLearnTab {...tabProps} /></ChatErrorBoundary>
        </View>}
        {mountedTabs.has('channels') && <View style={{ display: activeTab === 'channels' ? 'flex' : 'none', flex: activeTab === 'channels' ? 1 : undefined }}>
          <ChatErrorBoundary><ChannelsTab {...tabProps} /></ChatErrorBoundary>
        </View>}
        {mountedTabs.has('communities') && <View style={{ display: activeTab === 'communities' ? 'flex' : 'none', flex: activeTab === 'communities' ? 1 : undefined }}>
          <ChatErrorBoundary><CommunitiesTab {...tabProps} /></ChatErrorBoundary>
        </View>}
      </Animated.View>

      {/* Bottom tab bar — frosted glass on web */}
      <View style={[styles.tabBar, {
        backgroundColor: isDark ? '#0a0a0a' : '#ffffff',
        borderTopColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
        paddingBottom: insets.bottom || 10,
        ...(isWeb ? {
          backdropFilter: 'blur(24px) saturate(200%)',
          WebkitBackdropFilter: 'blur(24px) saturate(200%)',
          backgroundColor: isDark ? 'rgba(10, 10, 10, 0.92)' : 'rgba(255, 255, 255, 0.92)',
          boxShadow: isDark ? '0 -1px 0 rgba(255,255,255,0.04)' : '0 -1px 12px rgba(0,0,0,0.03)',
        } : {}),
      }]}>
        {isKids ? (
          <>
            <TabBarItem
              icon={(active) => <IconChatsTab size={25} color={active ? '#8b5cf6' : (isDark ? '#5a6270' : '#a0a8b4')} active={active} />}
              label={t('kids.chat') || 'Chats'}
              active={activeTab === 'chats'}
              onPress={() => handleTabPress('chats')}
              isDark={isDark}
              badge={0}
            />
            <TabBarItem
              icon={(active) => {
                const c = active ? '#ec4899' : (isDark ? '#5a6270' : '#a0a8b4');
                return (
                  <Svg width={25} height={25} viewBox="0 0 24 24" fill="none">
                    <Path d="M12 3L1 9l11 6 9-4.91V17h2V9L12 3z" fill={c} />
                    <Path d="M5 13.18v4L12 21l7-3.82v-4L12 17l-7-3.82z" fill={c} opacity={active ? 0.85 : 0.6} />
                  </Svg>
                );
              }}
              label={t('kids.learn') || 'ONE'}
              active={activeTab === 'learn'}
              onPress={() => handleTabPress('learn')}
              isDark={isDark}
            />
            <TabBarItem
              icon={(active) => {
                const c = active ? '#f59e0b' : (isDark ? '#5a6270' : '#a0a8b4');
                return (
                  <Svg width={25} height={25} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={active ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round">
                    <Rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
                    <Path d="M17 2L12 7 7 2" />
                  </Svg>
                );
              }}
              label="TV"
              active={activeTab === 'tv'}
              onPress={() => handleTabPress('tv')}
              isDark={isDark}
            />
            {/* Kids: "Perfil" tab now opens the unified profile, no more
                separate ChatProfileTab duplicate. */}
            <TabBarItem
              icon={(active) => {
                const c = active ? '#10b981' : (isDark ? '#5a6270' : '#a0a8b4');
                return (
                  <Svg width={25} height={25} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={active ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round">
                    <SvgCircle cx="12" cy="8" r="5" />
                    <Path d="M20 21a8 8 0 10-16 0" />
                  </Svg>
                );
              }}
              label={t('kids.profile') || 'Perfil'}
              active={false}
              onPress={() => user?.email && router.push(`/u/${encodeURIComponent(user.email)}`)}
              isDark={isDark}
            />
          </>
        ) : (
          <>
            <TabBarItem
              icon={(active) => <IconEmailTab size={22} color={active ? ACCENT : (isDark ? '#5a6270' : '#a0a8b4')} active={active} />}
              label="Email"
              active={false}
              onPress={() => handleTabPress('email')}
              isDark={isDark}
            />
            <TabBarItem
              icon={(active) => <IconVideo size={22} color={active ? ACCENT : (isDark ? '#5a6270' : '#a0a8b4')} />}
              label={t('chat.tabReels') || 'Reels'}
              active={false}
              onPress={() => handleTabPress('reels')}
              isDark={isDark}
            />
            <TabBarItem
              icon={(active) => <IconChatsTab size={22} color={active ? ACCENT : (isDark ? '#5a6270' : '#a0a8b4')} active={active} />}
              label={t('chat.tabChats') || 'Chats'}
              active={activeTab === 'chats'}
              onPress={() => handleTabPress('chats')}
              isDark={isDark}
              badge={0}
            />
            <TabBarItem
              icon={(active) => <IconCallsTab size={22} color={active ? ACCENT : (isDark ? '#5a6270' : '#a0a8b4')} active={active} />}
              label={t('chat.tabCalls') || 'Ligações'}
              active={activeTab === 'calls'}
              onPress={() => handleTabPress('calls')}
              isDark={isDark}
            />
            <TabBarItem
              icon={(active) => <IconAppsTab size={22} color={active ? ACCENT : (isDark ? '#5a6270' : '#a0a8b4')} active={active} />}
              label={t('chat.tabApps') || 'Apps'}
              active={showAppsDrawer}
              onPress={() => handleTabPress('apps')}
              isDark={isDark}
            />
          </>
        )}
      </View>
      <AppsDrawerModal
        visible={showAppsDrawer}
        onClose={closeAppsDrawer}
        router={router}
        colors={colors}
        isDark={isDark}
        t={t}
        onOpenFeed={openFeedFromApps}
        onOpenStatus={openStatusFromApps}
        onOpenChannels={openChannelsFromApps}
        onOpenCommunities={openCommunitiesFromApps}
        badges={appsBadges}
      />
      {/* No UnifiedComposeFab here — ChatListTab has its own FAB with
          new chat/group/channel, and each other tab owns its composer. */}
      <PlusOnboardingTour
        visible={showPlusTour}
        onClose={() => setShowPlusTour(false)}
        colors={colors}
        isDark={isDark}
      />
      <GlobalSearch
        visible={showGlobalSearch}
        onClose={() => setShowGlobalSearch(false)}
        colors={colors}
        isDark={isDark}
        t={t}
        router={router}
      />
    </View>
  );
}

// Persisted MRU of recently opened apps. Plain MMKV/localStorage so we
// don't bother the network with a sync — local feel is the point.
const RECENT_APPS_KEY = 'apps_recent_v1';
const _readRecentApps = () => {
  try {
    if (Platform.OS === 'web') {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(RECENT_APPS_KEY) : null;
      return raw ? JSON.parse(raw) : [];
    }
    const { mmkv } = require('../services/mmkv');
    const raw = mmkv?.getString(RECENT_APPS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
};
const _writeRecentApps = (list) => {
  try {
    const v = JSON.stringify(list.slice(0, 8));
    if (Platform.OS === 'web') {
      if (typeof localStorage !== 'undefined') localStorage.setItem(RECENT_APPS_KEY, v);
    } else {
      const { mmkv } = require('../services/mmkv');
      mmkv?.set(RECENT_APPS_KEY, v);
    }
  } catch {}
};
const _bumpRecentApp = (key) => {
  const cur = _readRecentApps().filter(k => k !== key);
  cur.unshift(key);
  _writeRecentApps(cur);
};

// One app tile in the drawer (used in both Recentes row and section grid).
// Press scales the icon down 0.9 with spring back; if there's an unread
// badge, the badge gets a subtle continuous pulse so the user's eye catches
// it without us yelling — iOS Mail / Sparrow style.
function AppTile({ item, badge, onPress, colors, isDark }) {
  const scale = useRef(new Animated.Value(1)).current;
  const badgePulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!badge) return undefined;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(badgePulse, { toValue: 1.18, duration: 700, useNativeDriver: true }),
      Animated.timing(badgePulse, { toValue: 1, duration: 700, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [badge]);
  const press = (to) => Animated.spring(scale, {
    toValue: to, tension: 320, friction: 14, useNativeDriver: true,
  }).start();
  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => press(0.9)}
      onPressOut={() => press(1)}
      style={({ hovered }) => ({
        width: '25%', alignItems: 'center', paddingVertical: 10,
        ...(hovered ? { opacity: 0.85 } : null),
      })}
      accessibilityRole="button"
      accessibilityLabel={item.label + (badge ? `, ${badge} novos` : '')}
    >
      <Animated.View style={{ width: 56, height: 56, transform: [{ scale }] }}>
        <View style={{
          width: 56, height: 56, borderRadius: 16,
          backgroundColor: item.ic.c + '18',
          alignItems: 'center', justifyContent: 'center',
          ...(Platform.OS === 'web' ? { boxShadow: `0 2px 8px ${item.ic.c}22` } : {}),
        }}>
          <item.ic.Comp size={26} color={item.ic.c} />
        </View>
        {!!badge && (
          <Animated.View style={{
            position: 'absolute', top: -4, right: -4,
            minWidth: 18, height: 18, paddingHorizontal: 5,
            borderRadius: 9, backgroundColor: '#ef4444',
            alignItems: 'center', justifyContent: 'center',
            borderWidth: 2, borderColor: isDark ? '#0f0f14' : '#fff',
            transform: [{ scale: badgePulse }],
          }}>
            <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800' }} numberOfLines={1}>
              {badge > 99 ? '99+' : String(badge)}
            </Text>
          </Animated.View>
        )}
      </Animated.View>
      <Text style={{ fontSize: 12, color: colors.text, fontWeight: '600', textAlign: 'center', marginTop: 8, letterSpacing: -0.1 }} numberOfLines={1}>{item.label}</Text>
    </Pressable>
  );
}

const AppsDrawerModal = React.memo(function AppsDrawerModal({ visible, onClose, router, colors, isDark, t, onOpenFeed, onOpenStatus, onOpenChannels, onOpenCommunities, badges }) {
  const [q, setQ] = useState('');
  // MRU drawer bar — reflects the last 4 apps the user opened. Refreshes
  // whenever the drawer opens (cheap, list is at most 8 entries).
  const [recentKeys, setRecentKeys] = useState(() => _readRecentApps());
  React.useEffect(() => {
    if (visible) setRecentKeys(_readRecentApps());
  }, [visible]);

  // SVG icon render helper — each item stores icon component + color
  const I = (Comp, c) => ({ Comp, c });

  // Reorganized 2026-05-01: 3 clear sections instead of 4 mixed.
  // - "Comunicação": all real-time messaging surfaces (was Social + chat tabs)
  // - "Produtividade": work tools (email, calendar, files, etc.)
  // - "Mídia & IA": photos/live/AI (own bucket so One doesn't sit alone, Photos
  //   leaves Social where it didn't belong, Live joins media correctly)
  // - "Conta": settings/plans (Backup is photo-backup, kept here as user setting)
  const sections = useMemo(() => ([
    {
      title: t('apps.communication') || 'Comunicação',
      items: [
        { key: 'feed',     label: t('feed.title') || 'Feed',             ic: I(IconGrid, '#f472b6'),     action: onOpenFeed },
        { key: 'status',   label: 'Status',                              ic: I(IconGlobe, '#06b6d4'),    action: onOpenStatus },
        { key: 'channels', label: t('channel.title') || 'Channels',      ic: I(IconBell, '#7C3AED'),     action: onOpenChannels },
        { key: 'communities', label: t('community.title') || 'Communities', ic: I(IconUsers, '#10b981'),   action: onOpenCommunities },
        { key: 'calls',    label: t('chat.tabCalls') || 'Ligações',      ic: I(IconPhone, '#3b82f6'),    action: () => { onClose(); try { router.push('/chat?tab=calls'); } catch (e) { console.warn("[chat] router.push failed:", e); } } },
      ],
    },
    {
      title: t('apps.productivity') || 'Produtividade',
      items: [
        { key: 'email',    label: t('sidebar.inbox') || 'Email',        ic: I(IconMail, '#ef4444'),      route: '/inbox' },
        { key: 'calendar', label: t('sidebar.calendar') || 'Agenda',    ic: I(IconCalendar, '#10b981'),  route: '/calendar' },
        { key: 'meet',     label: t('sidebar.meetings') || 'Meet',      ic: I(IconFilm, '#3b82f6'),      route: '/meetings' },
        { key: 'contacts', label: t('sidebar.contacts') || 'Contatos',  ic: I(IconUsers, '#8b5cf6'),     route: '/contacts' },
        { key: 'files',    label: t('sidebar.files') || 'Arquivos',     ic: I(IconFolder, '#f59e0b'),    route: '/files' },
        { key: 'docs',     label: t('sidebar.documents') || 'Docs',     ic: I(IconFileText, '#4285f4'),  route: '/documentos' },
        { key: 'notes',    label: t('sidebar.notes') || 'Notas',        ic: I(IconStickyNote, '#eab308'), route: '/notes' },
      ],
    },
    {
      title: t('apps.mediaAi') || 'Mídia & IA',
      items: [
        { key: 'photos',   label: t('sidebar.photos') || 'Fotos',        ic: I(IconImage, '#ec4899'),    route: '/photos' },
        { key: 'live',     label: t('apps.goLive') || 'Ao vivo',         ic: I(IconVideo, '#ef4444'),    route: '/live-broadcast' },
        { key: 'one',      label: 'One',                                 ic: I(IconSparkles, '#a855f7'), route: '/one' },
      ],
    },
    {
      title: t('apps.account') || 'Conta',
      items: [
        { key: 'profile',       label: t('sidebar.profile') || 'Perfil',         ic: I(IconUser, '#64748b'),     route: '/profile' },
        { key: 'settings',      label: t('sidebar.settings') || 'Configurações', ic: I(IconSettings, '#475569'), route: '/settings' },
        { key: 'notifications', label: t('sidebar.notifications') || 'Alertas',  ic: I(IconBell, '#f97316'),     route: '/notifications' },
        { key: 'backup',        label: t('sidebar.backup') || 'Backup',          ic: I(IconShield, '#0ea5e9'),   route: '/backup' },
      ],
    },
  ]), [t, onOpenFeed, onOpenStatus, onOpenChannels, onOpenCommunities, onClose, router]);

  const qLower = q.trim().toLowerCase();
  const filteredSections = useMemo(() => (
    qLower
      ? sections.map(s => ({ ...s, items: s.items.filter(i => i.label.toLowerCase().includes(qLower)) })).filter(s => s.items.length > 0)
      : sections
  ), [qLower, sections]);

  const handlePress = useCallback((it) => {
    // MRU bookkeeping — every launch bumps the key to the front of the
    // recents list so the drawer's "Recentes" row is always fresh.
    try { _bumpRecentApp(it.key); } catch {}
    if (it.action) { it.action(); return; }
    onClose();
    try { router.push(it.route); } catch (e) { console.warn('[chat] router.push failed:', e); }
  }, [onClose, router]);

  // Lookup table: key → item. Used to render the recents row below.
  const itemByKey = useMemo(() => {
    const m = new Map();
    for (const s of sections) for (const it of s.items) m.set(it.key, it);
    return m;
  }, [sections]);
  const recentItems = useMemo(() => (
    (recentKeys || []).map(k => itemByKey.get(k)).filter(Boolean).slice(0, 4)
  ), [recentKeys, itemByKey]);

  // Skip heavy render when hidden (hooks ran above — safe to bail now)
  if (!visible) return null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity
        activeOpacity={1}
        onPress={onClose}
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}
      >
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => {}}
          style={{
            backgroundColor: isDark ? '#0f0f14' : '#fff',
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            paddingTop: 10,
            paddingBottom: 32,
            paddingHorizontal: 16,
            maxHeight: '85%',
          }}
        >
          {/* Grabber */}
          <View style={{ alignItems: 'center', marginBottom: 10 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: isDark ? '#333' : '#ddd' }} />
          </View>
          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, paddingHorizontal: 4 }}>
            <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text }}>
              {t('chat.apps') || 'Apps'}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <Text style={{ fontSize: 24, color: isDark ? '#888' : '#888' }}>×</Text>
            </TouchableOpacity>
          </View>
          {/* Search */}
          <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: isDark ? '#1a1a22' : '#f3f4f6',
            borderRadius: 12,
            paddingHorizontal: 12,
            marginBottom: 12,
          }}>
            <IconSearch size={16} color={isDark ? '#666' : '#888'} />
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder={t('apps.searchPlaceholder') || 'Buscar apps'}
              placeholderTextColor={isDark ? '#555' : '#9ca3af'}
              style={{ flex: 1, paddingVertical: 10, paddingHorizontal: 8, color: colors.text, fontSize: 14, outlineStyle: 'none' }}
              autoCorrect={false}
            />
          </View>
          {/* Scrollable content */}
          <ScrollView
            style={{ maxHeight: 500 }}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 12 }}
            removeClippedSubviews={Platform.OS !== 'web'}
          >
            {/* Recently opened \u2014 only when not searching, only when MRU
                actually has entries. Mirrors iOS App Library "Recently
                Added" + Android launcher recents pattern. */}
            {!qLower && recentItems.length > 0 && (
              <View style={{ marginBottom: 18 }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: isDark ? '#9ca3af' : '#374151', letterSpacing: -0.1, textTransform: 'none', marginBottom: 12, paddingHorizontal: 6 }}>
                  {t('apps.recent') || 'Recentes'}
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                  {recentItems.map((it) => (
                    <AppTile
                      key={'r_' + it.key}
                      item={it}
                      badge={badges?.[it.key] || 0}
                      onPress={() => handlePress(it)}
                      colors={colors}
                      isDark={isDark}
                    />
                  ))}
                </View>
              </View>
            )}
            {filteredSections.length === 0 ? (
              <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                <View style={{ width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', marginBottom: 10 }}>
                  <IconSearch size={26} color={colors.textSecondary} />
                </View>
                <Text style={{ color: colors.textSecondary, fontSize: 13 }}>{t('apps.noResults') || 'Nenhum app encontrado'}</Text>
              </View>
            ) : filteredSections.map((section) => (
              <View key={section.title} style={{ marginBottom: 18 }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: isDark ? '#9ca3af' : '#374151', letterSpacing: -0.1, textTransform: 'none', marginBottom: 12, paddingHorizontal: 6 }}>
                  {section.title}
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                  {section.items.map((it) => (
                    <AppTile
                      key={it.key}
                      item={it}
                      badge={badges?.[it.key] || 0}
                      onPress={() => handlePress(it)}
                      colors={colors}
                      isDark={isDark}
                    />
                  ))}
                </View>
              </View>
            ))}
          </ScrollView>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
});

// ── Desktop sidebar tab item with hover ──
function DesktopTabItem({ tabKey, icon: IconComp, label, active, onPress, isDark }) {
  const [hovered, setHovered] = useState(false);
  const color = active ? '#7C3AED' : 'rgba(255,255,255,0.6)';
  const isWeb = Platform.OS === 'web';

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={[styles.desktopTabItem, {
        backgroundColor: active
          ? 'rgba(124,58,237,0.15)'
          : hovered
            ? 'rgba(255,255,255,0.1)'
            : 'transparent',
        borderLeftColor: active ? '#7C3AED' : 'transparent',
        cursor: 'pointer',
        ...(isWeb ? { transition: 'all 0.2s cubic-bezier(0.4,0,0.2,1)' } : {}),
        ...(active && isWeb ? { boxShadow: isDark ? `inset 0 0 20px rgba(124,58,237,0.05)` : `inset 0 0 20px rgba(124,58,237,0.04)` } : {}),
      }]}
    >
      <IconComp size={22} color={color} active={active} />
      <Text style={[styles.desktopTabLabel, {
        color,
        fontWeight: active ? '700' : '500',
      }]} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// ── Pulse animation for badge ──
function PulseBadge({ badge, isDark }) {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const isWeb = Platform.OS === 'web';

  useEffect(() => {
    if (badge > 0) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.2, duration: 800, useNativeDriver: false }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: false }),
        ])
      );
      pulse.start();
      return () => pulse.stop();
    }
  }, [badge]);

  if (badge <= 0) return null;
  return (
    <Animated.View style={[styles.badge, {
      transform: [{ scale: pulseAnim }],
    }, isWeb && isDark && { boxShadow: `0 0 12px ${ACCENT_GLOW}` }]}>
      <Text style={styles.badgeText}>{badge > 99 ? '99+' : badge}</Text>
    </Animated.View>
  );
}

// ── Mobile tab bar item with dot indicator ──
function TabBarItem({ icon, label, active, onPress, isDark, badge }) {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const bounceAnim = useRef(new Animated.Value(0)).current;
  // Active glow ring fades in when the tab activates — soft halo around
  // the icon that gives the tab bar a more "tech" feel without adding
  // any pixels to the layout footprint.
  const glowAnim = useRef(new Animated.Value(active ? 1 : 0)).current;
  const isWeb = Platform.OS === 'web';

  useEffect(() => {
    if (active) {
      Animated.sequence([
        Animated.spring(bounceAnim, { toValue: -3, useNativeDriver: false, tension: 400, friction: 10 }),
        Animated.spring(bounceAnim, { toValue: 0, useNativeDriver: false, tension: 260, friction: 14 }),
      ]).start();
    }
    Animated.timing(glowAnim, {
      toValue: active ? 1 : 0,
      duration: 220,
      useNativeDriver: false,
    }).start();
  }, [active]);

  const handlePressIn = () => {
    Animated.spring(scaleAnim, { toValue: 0.9, useNativeDriver: false, tension: 400, friction: 28 }).start();
  };
  const handlePressOut = () => {
    Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: false, tension: 260, friction: 14 }).start();
  };

  return (
    <TouchableOpacity style={styles.tabItem} onPress={onPress} onPressIn={handlePressIn} onPressOut={handlePressOut} activeOpacity={1}>
      <Animated.View style={[styles.tabIconWrap, {
        transform: [{ scale: scaleAnim }, { translateY: bounceAnim }],
        backgroundColor: glowAnim.interpolate({
          inputRange: [0, 1],
          outputRange: ['rgba(124,58,237,0)', isDark ? 'rgba(124,58,237,0.16)' : 'rgba(124,58,237,0.10)'],
        }),
        ...(isWeb ? {
          boxShadow: active
            ? `0 0 16px ${isDark ? 'rgba(124,58,237,0.35)' : 'rgba(124,58,237,0.20)'}`
            : 'none',
          transition: 'box-shadow 0.22s ease',
        } : {}),
      }]}>
        {icon(active)}
        {badge > 0 && <PulseBadge badge={badge} isDark={isDark} />}
      </Animated.View>
      <Text style={[styles.tabLabel, {
        color: active ? ACCENT : (isDark ? '#6b7280' : '#9ca3af'),
        fontWeight: active ? '700' : '500',
        ...(isWeb ? { transition: 'color 0.18s ease' } : {}),
      }]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  // Header (mobile) — 2026 premium
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 14,
    minHeight: 58,
    zIndex: 10,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  titleWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  brandWrap: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  brandTitle: {
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  title: {
    fontSize: 21,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 8,
  },
  headerIconBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? { transition: 'background-color 0.2s ease, transform 0.15s cubic-bezier(0.34,1.56,0.64,1)', cursor: 'pointer' } : {}),
  },
  headerAccentBtn: {
    backgroundColor: 'rgba(255,255,255,0.1)',
  },

  // Search bar
  searchBarOuter: {
    paddingHorizontal: 16,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    justifyContent: 'flex-end',
    zIndex: 9,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 40,
    borderRadius: 20,
    paddingHorizontal: 14,
    gap: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    fontWeight: '400',
    paddingVertical: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  searchCloseBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Tab bar (mobile bottom) — 2026 premium frosted glass
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    position: 'relative',
  },
  tabIndicator: {
    position: 'absolute',
    top: 0,
    width: 32,
    height: 3,
    borderRadius: 1.5,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    position: 'relative',
  },
  tabIconWrap: {
    width: 48,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    borderRadius: 16,
  },
  tabLabel: {
    fontSize: 10,
    marginTop: 2,
    fontWeight: '500',
    letterSpacing: 0.1,
  },
  tabActiveDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: ACCENT,
    marginTop: 3,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
    ...Platform.select({
      web: {
        background: `linear-gradient(135deg, ${ACCENT} 0%, #6D28D9 100%)`,
        boxShadow: `0 2px 8px rgba(124,58,237,0.5)`,
      },
      ios: { backgroundColor: ACCENT, shadowColor: ACCENT, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.4, shadowRadius: 3 },
      android: { backgroundColor: ACCENT, elevation: 3 },
    }),
  },
  badgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '800',
    lineHeight: 12,
  },

  // ── Desktop layout styles ──
  desktopRail: {
    width: 72,
    flexDirection: 'column',
    alignItems: 'center',
    borderRightWidth: 1,
    paddingTop: 16,
    paddingBottom: 16,
    zIndex: 10,
  },
  desktopBrandWrap: {
    width: '100%',
    alignItems: 'center',
    paddingBottom: 20,
    marginBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(128,128,128,0.1)',
  },
  desktopTabList: {
    flex: 1,
    width: '100%',
    gap: 4,
    paddingHorizontal: 4,
  },
  desktopTabItem: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 14,
    borderLeftWidth: 3,
    gap: 4,
  },
  desktopTabLabel: {
    fontSize: 9,
    fontWeight: '500',
    letterSpacing: 0.15,
    textAlign: 'center',
  },
  desktopBackBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  desktopHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderBottomWidth: 1,
    minHeight: 60,
    zIndex: 10,
  },
});
