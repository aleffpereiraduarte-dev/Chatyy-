import React, { useState, useRef, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Animated, Dimensions, TextInput } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useAuth, isChildAccount } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconPlus, IconPhone, IconSearch } from '../components/Icons';
import Svg, { Circle as SvgCircle, Path, Rect, Line, Defs, LinearGradient, Stop } from 'react-native-svg';
import ChatListTab from '../components/ChatListTab';
import ChatCallsTab from '../components/ChatCallsTab';
import ChatProfileTab from '../components/ChatProfileTab';
import ChatFeedTab from '../components/ChatFeedTab';
import ChatStatusTab from '../components/ChatStatusTab';
import KidsLearnTab from '../components/KidsLearnTab';
import KidsTVTab from '../components/KidsTVTab';

// ─── Custom SVG Icons for Tab Bar ───

function IconFeedTab({ size = 24, color = '#666', active }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={active ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="3" y="3" width="7" height="7" rx="1.5" fill={active ? color : 'none'} stroke={color} strokeWidth={active ? 0 : 1.8} />
      <Rect x="14" y="3" width="7" height="7" rx="1.5" fill={active ? color : 'none'} stroke={color} strokeWidth={active ? 0 : 1.8} />
      <Rect x="3" y="14" width="7" height="7" rx="1.5" fill={active ? color : 'none'} stroke={color} strokeWidth={active ? 0 : 1.8} />
      <Rect x="14" y="14" width="7" height="7" rx="1.5" fill={active ? color : 'none'} stroke={color} strokeWidth={active ? 0 : 1.8} />
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
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={active ? color : 'none'} stroke={color} strokeWidth={active ? 0 : 1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" fill={active ? color : 'none'} stroke={color} strokeWidth={active ? 0 : 1.8} />
      {!active && (
        <>
          <Line x1="8" y1="9" x2="16" y2="9" stroke={color} strokeWidth="1.5" />
          <Line x1="8" y1="13" x2="13" y2="13" stroke={color} strokeWidth="1.5" />
        </>
      )}
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
      <SvgCircle cx="12" cy="12" r="9" stroke={color} strokeWidth={active ? 2.5 : 1.8} strokeDasharray={active ? undefined : "4 3"} />
      <SvgCircle cx="12" cy="12" r="4" fill={active ? color : 'none'} stroke={active ? 'none' : color} strokeWidth="1.5" />
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
          <Text style={{ fontSize: 18, fontWeight: '700', color: '#dc2626', marginBottom: 12 }}>Error</Text>
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

const ACCENT = '#25D366';
const ACCENT_DARK = '#1FAD55';
const ACCENT_GLOW = 'rgba(37,211,102,0.35)';
const ACCENT2 = '#128C7E';
const DESKTOP_BREAKPOINT = 900;

// Kids mode: only show chats + calls + profile (no feed/status)
const TAB_KEYS_FULL = ['feed', 'status', 'calls', 'chats', 'config'];
const TAB_KEYS_KIDS = ['chats', 'learn', 'tv', 'config'];

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
  const TAB_KEYS = isKids ? TAB_KEYS_KIDS : TAB_KEYS_FULL;
  const [activeTab, setActiveTab] = useState(params.tab || 'chats');
  const [mountedTabs, setMountedTabs] = useState(new Set(['chats'])); // lazy mount: only mount tabs once visited
  const [searchOpen, setSearchOpen] = useState(false);
  const searchAnim = useRef(new Animated.Value(0)).current;

  // Track window dimensions for responsive layout
  const [windowWidth, setWindowWidth] = useState(Dimensions.get('window').width);
  useEffect(() => {
    const sub = Dimensions.addEventListener('change', ({ window }) => {
      setWindowWidth(window.width);
    });
    return () => sub?.remove?.();
  }, []);

  const isDesktop = Platform.OS === 'web' && windowWidth >= DESKTOP_BREAKPOINT;
  const isWeb = Platform.OS === 'web';

  // Animated indicator position
  const indicatorAnim = useRef(new Animated.Value(TAB_KEYS.indexOf('chats'))).current;
  const screenWidth = Dimensions.get('window').width;
  const tabWidth = isDesktop ? 72 : screenWidth / TAB_KEYS.length;

  // Content fade animation
  const contentOpacity = useRef(new Animated.Value(1)).current;

  const handleTabPress = useCallback((tab) => {
    if (tab === activeTab) return;
    const idx = TAB_KEYS.indexOf(tab);

    Animated.spring(indicatorAnim, {
      toValue: idx,
      useNativeDriver: false,
      tension: 80,
      friction: 14,
      overshootClamping: false,
    }).start();

    // Content crossfade
    Animated.sequence([
      Animated.timing(contentOpacity, { toValue: 0.3, duration: 80, useNativeDriver: false }),
      Animated.timing(contentOpacity, { toValue: 1, duration: 180, useNativeDriver: false }),
    ]).start();

    setActiveTab(tab);
    setMountedTabs(prev => { const next = new Set(prev); next.add(tab); return next; });
  }, [indicatorAnim, contentOpacity, activeTab]);

  const handleBack = useCallback(() => {
    if (activeTab !== 'chats') {
      handleTabPress('chats');
    } else if (!isKids) {
      router.back(); // Kids don't go back to inbox
    }
  }, [activeTab, handleTabPress, router]);

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
      Animated.timing(searchAnim, { toValue: 0, duration: 220, useNativeDriver: false }).start(() => setSearchOpen(false));
    } else {
      setSearchOpen(true);
      Animated.spring(searchAnim, { toValue: 1, tension: 100, friction: 15, useNativeDriver: false }).start();
    }
  }, [searchOpen, searchAnim]);

  const tabProps = { colors, isDark, t, user, router };

  const titles = {
    feed: t('feed.title') || 'Feed',
    status: 'Status',
    calls: t('chat.tabCalls') || 'Ligacoes',
    chats: 'Chatyy',
    config: t('chat.tabConfig') || 'Configuracoes',
    learn: 'Professora ONE 🎓',
    tv: 'Chatyy TV 🎬',
  };

  const renderHeaderAction = () => {
    const headerIconColor = '#fff';
    if (activeTab === 'chats') {
      return (
        <>
          <TouchableOpacity onPress={toggleSearch} activeOpacity={0.6}
            style={[styles.headerIconBtn, { backgroundColor: 'rgba(255,255,255,0.1)' }]}
          >
            <IconSearch size={18} color={headerIconColor} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push('/chat-new')} activeOpacity={0.6}
            style={[styles.headerIconBtn, { backgroundColor: 'rgba(255,255,255,0.1)' }]}>
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

  // WhatsApp 2026 header style
  const glassHeader = isKids
    ? (Platform.OS === 'web'
      ? { background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 40%, #ec4899 100%)' }
      : { backgroundColor: isDark ? '#3b1d6e' : '#6366f1' })
    : { backgroundColor: isDark ? '#0a0a0a' : '#075E54' };

  const glassTabBar = {
    backgroundColor: isDark ? '#0a0a0a' : '#ffffff',
  };

  // ── DESKTOP LAYOUT (side rail + content) ──
  if (isDesktop) {
    return (
      <View style={[styles.container, { backgroundColor: isDark ? '#000000' : '#f0f2f5', flexDirection: 'row' }]}>
        {/* Side Rail */}
        <View style={[styles.desktopRail, {
          backgroundColor: isKids ? (isDark ? '#3b1d6e' : '#6366f1') : (isDark ? '#0a0a0a' : '#075E54'),
          borderRightColor: 'transparent',
        }]}>
          {/* Brand at top */}
          <View style={styles.desktopBrandWrap}>
            <BrandTitle colors={colors} size={20} />
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
                  style={[styles.searchInput, { color: colors.text }]} />
                <TouchableOpacity onPress={toggleSearch} activeOpacity={0.6} style={styles.searchCloseBtn}>
                  <IconClose size={16} color={isDark ? '#6b7280' : '#9ca3af'} />
                </TouchableOpacity>
              </View>
            )}
          </Animated.View>

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
            {mountedTabs.has('config') && <View style={{ display: activeTab === 'config' ? 'flex' : 'none', flex: activeTab === 'config' ? 1 : undefined }}>
              <ChatErrorBoundary><ChatProfileTab {...tabProps} /></ChatErrorBoundary>
            </View>}
            {mountedTabs.has('learn') && <View style={{ display: activeTab === 'learn' ? 'flex' : 'none', flex: activeTab === 'learn' ? 1 : undefined }}>
              <ChatErrorBoundary><KidsLearnTab {...tabProps} /></ChatErrorBoundary>
            </View>}
            {mountedTabs.has('tv') && <View style={{ display: activeTab === 'tv' ? 'flex' : 'none', flex: activeTab === 'tv' ? 1 : undefined }}>
              <ChatErrorBoundary><KidsTVTab {...tabProps} /></ChatErrorBoundary>
            </View>}
          </Animated.View>
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
      {/* WhatsApp-style teal header */}
      <View style={[styles.header, {
        ...glassHeader,
        borderBottomWidth: 0,
      }]}>
        <TouchableOpacity onPress={handleBack} style={[styles.backBtn, {
          backgroundColor: 'rgba(255,255,255,0.1)',
        }]} activeOpacity={0.6}>
          <IconArrowLeft size={20} color="#fff" />
        </TouchableOpacity>

        <View style={styles.titleWrap}>
          {activeTab === 'chats' ? (
            <BrandTitle colors={colors} light />
          ) : (
            <Text style={[styles.title, { color: '#fff' }]}>{titles[activeTab]}</Text>
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
              style={[styles.searchInput, { color: colors.text }]} />
            <TouchableOpacity onPress={toggleSearch} activeOpacity={0.6} style={styles.searchCloseBtn}>
              <IconClose size={16} color={isDark ? '#6b7280' : '#9ca3af'} />
            </TouchableOpacity>
          </View>
        )}
      </Animated.View>

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
        {mountedTabs.has('config') && <View style={{ display: activeTab === 'config' ? 'flex' : 'none', flex: activeTab === 'config' ? 1 : undefined }}>
          <ChatErrorBoundary><ChatProfileTab {...tabProps} /></ChatErrorBoundary>
        </View>}
        {mountedTabs.has('learn') && <View style={{ display: activeTab === 'learn' ? 'flex' : 'none', flex: activeTab === 'learn' ? 1 : undefined }}>
          <ChatErrorBoundary><KidsLearnTab {...tabProps} /></ChatErrorBoundary>
        </View>}
      </Animated.View>

      {/* Bottom tab bar — frosted glass on web */}
      <View style={[styles.tabBar, {
        backgroundColor: isDark ? '#0a0a0a' : '#ffffff',
        borderTopColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
        paddingBottom: insets.bottom || 8,
        ...(isWeb ? {
          backdropFilter: 'blur(20px) saturate(180%)',
          WebkitBackdropFilter: 'blur(20px) saturate(180%)',
          backgroundColor: isDark ? 'rgba(31, 44, 51, 0.85)' : 'rgba(255, 255, 255, 0.88)',
        } : {}),
      }]}>
        {/* Animated indicator pill */}
        <Animated.View style={[styles.tabIndicator, {
          transform: [{ translateX: indicatorTranslateX }, { scaleX: indicatorScale }],
          backgroundColor: isKids ? '#ec4899' : ACCENT,
        }]} />

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
              active={activeTab === 'config'}
              onPress={() => handleTabPress('config')}
              isDark={isDark}
            />
          </>
        ) : (
          <>
            <TabBarItem
              icon={(active) => <IconFeedTab size={23} color={active ? ACCENT : (isDark ? '#5a6270' : '#a0a8b4')} active={active} />}
              label={t('feed.title') || 'Feed'}
              active={activeTab === 'feed'}
              onPress={() => handleTabPress('feed')}
              isDark={isDark}
            />
            <TabBarItem
              icon={(active) => <IconStatusTab size={23} color={active ? ACCENT : (isDark ? '#5a6270' : '#a0a8b4')} active={active} />}
              label="Status"
              active={activeTab === 'status'}
              onPress={() => handleTabPress('status')}
              isDark={isDark}
            />
            <TabBarItem
              icon={(active) => <IconCallsTab size={23} color={active ? ACCENT : (isDark ? '#5a6270' : '#a0a8b4')} active={active} />}
              label={t('chat.tabCalls') || 'Ligacoes'}
              active={activeTab === 'calls'}
              onPress={() => handleTabPress('calls')}
              isDark={isDark}
            />
            <TabBarItem
              icon={(active) => <IconChatsTab size={23} color={active ? ACCENT : (isDark ? '#5a6270' : '#a0a8b4')} active={active} />}
              label="Chats"
              active={activeTab === 'chats'}
              onPress={() => handleTabPress('chats')}
              isDark={isDark}
              badge={0}
            />
            <TabBarItem
              icon={(active) => <IconConfigTab size={23} color={active ? ACCENT : (isDark ? '#5a6270' : '#a0a8b4')} active={active} />}
              label={t('chat.tabConfig') || 'Config'}
              active={activeTab === 'config'}
              onPress={() => handleTabPress('config')}
              isDark={isDark}
            />
          </>
        )}
      </View>
    </View>
  );
}

// ── Desktop sidebar tab item with hover ──
function DesktopTabItem({ tabKey, icon: IconComp, label, active, onPress, isDark }) {
  const [hovered, setHovered] = useState(false);
  const color = active ? '#25D366' : 'rgba(255,255,255,0.6)';
  const isWeb = Platform.OS === 'web';

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={[styles.desktopTabItem, {
        backgroundColor: active
          ? 'rgba(37,211,102,0.15)'
          : hovered
            ? 'rgba(255,255,255,0.1)'
            : 'transparent',
        borderLeftColor: active ? '#25D366' : 'transparent',
        cursor: 'pointer',
        ...(isWeb ? { transition: 'all 0.2s cubic-bezier(0.4,0,0.2,1)' } : {}),
        ...(active && isWeb ? { boxShadow: isDark ? `inset 0 0 20px rgba(37,211,102,0.05)` : `inset 0 0 20px rgba(37,211,102,0.04)` } : {}),
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
  const bgAnim = useRef(new Animated.Value(active ? 1 : 0)).current;
  const bounceAnim = useRef(new Animated.Value(0)).current;
  const isWeb = Platform.OS === 'web';

  useEffect(() => {
    Animated.timing(bgAnim, { toValue: active ? 1 : 0, duration: 200, useNativeDriver: false }).start();
    if (active) {
      // Bounce the icon up slightly when activated
      Animated.sequence([
        Animated.spring(bounceAnim, { toValue: -3, useNativeDriver: false, tension: 400, friction: 8 }),
        Animated.spring(bounceAnim, { toValue: 0, useNativeDriver: false, tension: 200, friction: 12 }),
      ]).start();
    }
  }, [active, bgAnim]);

  const handlePressIn = () => {
    Animated.spring(scaleAnim, { toValue: 0.85, useNativeDriver: false, tension: 300, friction: 10 }).start();
  };
  const handlePressOut = () => {
    Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: false, tension: 200, friction: 12 }).start();
  };

  const pillBg = bgAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['transparent', isDark ? 'rgba(37,211,102,0.15)' : 'rgba(37,211,102,0.1)'],
  });

  return (
    <TouchableOpacity style={styles.tabItem} onPress={onPress} onPressIn={handlePressIn} onPressOut={handlePressOut} activeOpacity={1}>
      <Animated.View style={[styles.tabIconWrap, { transform: [{ scale: scaleAnim }, { translateY: bounceAnim }], backgroundColor: pillBg, borderRadius: 20 }]}>
        {icon(active)}
        <PulseBadge badge={badge} isDark={isDark} />
      </Animated.View>
      <Text style={[styles.tabLabel, {
        color: active ? ACCENT : (isDark ? '#5a6270' : '#a0a8b4'),
        fontWeight: active ? '700' : '500',
        opacity: active ? 1 : 0.85,
      }]}>
        {label}
      </Text>
      {/* Active dot indicator below label */}
      {active && (
        <View style={styles.tabActiveDot} />
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  // Header (mobile)
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 56,
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
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.5,
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

  // Tab bar (mobile bottom) — modern frosted glass
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    position: 'relative',
  },
  tabIndicator: {
    position: 'absolute',
    top: 0,
    width: 36,
    height: 3,
    borderRadius: 1.5,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 3,
    position: 'relative',
  },
  tabIconWrap: {
    width: 48,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  tabLabel: {
    fontSize: 10,
    marginTop: 2,
    letterSpacing: 0.3,
  },
  tabActiveDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
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
        background: `linear-gradient(135deg, ${ACCENT} 0%, #128C7E 100%)`,
        boxShadow: `0 2px 8px rgba(37,211,102,0.5)`,
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
    paddingVertical: 10,
    borderRadius: 12,
    borderLeftWidth: 3,
    gap: 3,
  },
  desktopTabLabel: {
    fontSize: 9,
    letterSpacing: 0.2,
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
