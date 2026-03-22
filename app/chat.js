import React, { useState, useRef, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Animated, Dimensions, TextInput } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconPlus, IconPhone, IconSearch } from '../components/Icons';
import Svg, { Circle as SvgCircle, Path, Rect, Line, Defs, LinearGradient, Stop } from 'react-native-svg';
import ChatListTab from '../components/ChatListTab';
import ChatCallsTab from '../components/ChatCallsTab';
import ChatProfileTab from '../components/ChatProfileTab';
import ChatFeedTab from '../components/ChatFeedTab';
import ChatStatusTab from '../components/ChatStatusTab';

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

const TAB_KEYS = ['feed', 'status', 'calls', 'chats', 'config'];

// Gradient brand title for "Chatyy" (web only renders as two-tone, native as well)
function BrandTitle({ colors, size = 22, light }) {
  return (
    <View style={styles.brandWrap}>
      <Text style={[styles.brandTitle, { color: light ? '#fff' : colors.text, fontSize: size }]}>Chatyy</Text>
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
  const tabWidth = isDesktop ? 72 : screenWidth / 5;

  // Content fade animation
  const contentOpacity = useRef(new Animated.Value(1)).current;

  const handleTabPress = useCallback((tab) => {
    if (tab === activeTab) return;
    const idx = TAB_KEYS.indexOf(tab);

    Animated.spring(indicatorAnim, {
      toValue: idx,
      useNativeDriver: true,
      tension: 80,
      friction: 14,
      overshootClamping: false,
    }).start();

    // Content crossfade
    Animated.sequence([
      Animated.timing(contentOpacity, { toValue: 0.3, duration: 80, useNativeDriver: true }),
      Animated.timing(contentOpacity, { toValue: 1, duration: 180, useNativeDriver: true }),
    ]).start();

    setActiveTab(tab);
    setMountedTabs(prev => { const next = new Set(prev); next.add(tab); return next; });
  }, [indicatorAnim, contentOpacity, activeTab]);

  const handleBack = useCallback(() => {
    if (activeTab !== 'chats') {
      handleTabPress('chats');
    } else {
      router.back();
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
  const glassHeader = {
    backgroundColor: isDark ? '#1F2C33' : '#075E54',
  };

  const glassTabBar = {
    backgroundColor: isDark ? '#1F2C33' : '#ffffff',
  };

  // ── DESKTOP LAYOUT (side rail + content) ──
  if (isDesktop) {
    return (
      <View style={[styles.container, { backgroundColor: isDark ? '#000000' : '#f0f2f5', flexDirection: 'row' }]}>
        {/* Side Rail */}
        <View style={[styles.desktopRail, {
          backgroundColor: isDark ? '#1F2C33' : '#075E54',
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

          {/* Back button at bottom */}
          <TouchableOpacity onPress={() => router.back()} activeOpacity={0.6}
            style={[styles.desktopBackBtn, {
              backgroundColor: 'rgba(255,255,255,0.1)',
            }]}>
            <IconArrowLeft size={20} color="rgba(255,255,255,0.8)" />
          </TouchableOpacity>
        </View>

        {/* Main content area */}
        <View style={{ flex: 1, flexDirection: 'column' }}>
          {/* Desktop header with glass */}
          <View style={[styles.desktopHeader, {
            ...glassHeader,
            borderBottomWidth: 0,
          }]}>
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
          </Animated.View>
        </View>
      </View>
    );
  }

  // ── MOBILE LAYOUT (bottom tab bar) ──
  return (
    <View style={[styles.container, {
      backgroundColor: isDark ? '#0B141A' : '#ffffff',
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
      </Animated.View>

      {/* Bottom tab bar */}
      <View style={[styles.tabBar, {
        backgroundColor: isDark ? '#1F2C33' : '#ffffff',
        borderTopColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)',
        paddingBottom: insets.bottom || 8,
      }]}>
        {/* Animated indicator pill */}
        <Animated.View style={[styles.tabIndicator, {
          transform: [{ translateX: indicatorTranslateX }, { scaleX: indicatorScale }],
          backgroundColor: ACCENT,
        }]} />

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

// ── Mobile tab bar item with dot indicator ──
function TabBarItem({ icon, label, active, onPress, isDark, badge }) {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const bgAnim = useRef(new Animated.Value(active ? 1 : 0)).current;
  const isWeb = Platform.OS === 'web';

  useEffect(() => {
    Animated.timing(bgAnim, { toValue: active ? 1 : 0, duration: 200, useNativeDriver: false }).start();
  }, [active, bgAnim]);

  const handlePressIn = () => {
    Animated.spring(scaleAnim, { toValue: 0.85, useNativeDriver: false, tension: 300, friction: 10 }).start();
  };
  const handlePressOut = () => {
    Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: false, tension: 200, friction: 12 }).start();
  };

  const pillBg = bgAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['transparent', isDark ? 'rgba(37,211,102,0.12)' : 'rgba(37,211,102,0.08)'],
  });

  return (
    <TouchableOpacity style={styles.tabItem} onPress={onPress} onPressIn={handlePressIn} onPressOut={handlePressOut} activeOpacity={1}>
      <Animated.View style={[styles.tabIconWrap, { transform: [{ scale: scaleAnim }], backgroundColor: pillBg, borderRadius: 16 }]}>
        {icon(active)}
        {badge > 0 && (
          <View style={[styles.badge, isWeb && isDark && { boxShadow: `0 0 8px ${ACCENT_GLOW}` }]}>
            <Text style={styles.badgeText}>{badge > 99 ? '99+' : badge}</Text>
          </View>
        )}
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
    ...(Platform.OS === 'web' ? { transition: 'background-color 0.2s ease, transform 0.15s ease' } : {}),
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

  // Tab bar (mobile bottom)
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 6,
    position: 'relative',
  },
  tabIndicator: {
    position: 'absolute',
    top: 0,
    width: 36,
    height: 3.5,
    borderRadius: 2,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 2,
    position: 'relative',
  },
  tabIconWrap: {
    width: 42,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  tabLabel: {
    fontSize: 10.5,
    marginTop: 1,
    letterSpacing: 0.2,
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
