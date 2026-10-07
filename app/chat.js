import React, { useState, useRef, useEffect, useCallback, useMemo, Suspense } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform, Animated, Dimensions, TextInput, Modal, Pressable, KeyboardAvoidingView, AppState, PanResponder } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useAuth, isChildAccount } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import {
  IconArrowLeft, IconPlus, IconPhone, IconSearch, IconMail, IconCalendar,
  IconFilm, IconFolder, IconCloud, IconFileText, IconStickyNote, IconUsers,
  IconImage, IconVideo, IconSparkles, IconUser, IconSettings, IconStar,
  IconBell, IconShield, IconGlobe, IconGrid, IconCamera, IconMapPin,
  IconCreditCard, IconDiamond,
  // [2026-10-07 apps-menu] Apps drawer redesign icons
  IconMegaphone, IconUsersSmall, IconReels, IconBroadcast,
  IconCheckCircle, // [2026-10-08 apps-native] tile Tarefas
} from '../components/Icons';
import PressableScale from '../components/PressableScale';
import Svg, { Circle as SvgCircle, Path, Rect, Line, Defs, LinearGradient, Stop } from 'react-native-svg';
// [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag
import { WALLET_ENABLED } from '../constants/featureFlags';
import { haptic } from '../constants/theme';
import ChatListTab from '../components/ChatListTab';
import AvatarCircle from '../components/AvatarCircle';
import ChatCallsTab from '../components/ChatCallsTab';
// Heavy non-default tabs — code-split via React.lazy so cold start doesn't pay
// the ChatStatusTab (4.5k LOC), ChatFeedTab, ChannelsTab, CommunitiesTab, kids
// tabs parse cost upfront. Each chunk only loads when the user actually opens
// the tab. ChatCallsTab stays eager because chat.js has a require() reference
// to its `getCallHistoryCached` named export at startup (missed-calls badge).
const ChatFeedTab = React.lazy(() => import('../components/ChatFeedTab'));
const ChatStatusTab = React.lazy(() => import('../components/ChatStatusTab'));
const ChannelsTab = React.lazy(() => import('../components/ChannelsTab'));
const CommunitiesTab = React.lazy(() => import('../components/CommunitiesTab'));
const KidsLearnTab = React.lazy(() => import('../components/KidsLearnTab'));
const KidsTVTab = React.lazy(() => import('../components/KidsTVTab'));
import SyncBar from '../components/SyncBar';
import { isSyncComplete, runInitialSync } from '../services/initialSync';
import PlusOnboardingTour, { checkShouldShowPlusOnboarding } from '../components/PlusOnboardingTour';
import GlobalSearch from '../components/GlobalSearch';
import FirstRunGate from '../components/onboarding/FirstRunGate'; // [2026-10-07 welcome]
import { BarMaterial, canNativeBlur } from '../components/NativeBlur'; // [2026-10-07 native-ui-build]

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

function ChatErrorFallback({ error }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20, backgroundColor: colors.background }}>
      <Text style={{ fontSize: 18, fontWeight: '700', color: colors.error, marginBottom: 12 }}>{t('common.error') || 'Erro'}</Text>
      <Text style={{ fontSize: 13, color: colors.textSecondary, textAlign: 'center' }}>{String(error)}</Text>
    </View>
  );
}

class ChatErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return <ChatErrorFallback error={this.state.error} />;
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

const ACCENT = '#111111';
const ACCENT_DARK = '#111111';
const ACCENT_GLOW = 'rgba(17, 17, 17,0.35)';
const ACCENT2 = '#111111';
// WhatsApp-parity accent (2026-10-04) — the founder wants the Conversas list to
// carry WhatsApp's signature green on the "new chat" action. Kept as a single
// brand constant (same in light/dark, like WhatsApp itself).
const WA_GREEN = '#25D366';
const DESKTOP_BREAKPOINT = 900;

// Mobile bottom bar: 4 tabs — Reels + Chats + Calls + Apps.
// Email moved into the Apps drawer (still a top-level entry there) because
// 5 tabs felt cluttered and competed with chats/calls for the user's eye.
// Desktop already omits email since the sidebar exposes it.
// [2026-10-03 founder] Barra de baixo: Email no lugar do Reels. Chatyy é
// chat+email (OneMundo Mail) → Email é utilidade diária + diferencial, merece a
// barra; Reels (engajamento/Instagram) migra pro drawer de Apps (segue acessível
// pelo botão Apps → Feed). Ordem: Chats (primário/default) · Email (diferencial)
// · Ligações · Apps (hub/overflow na ponta).
const TAB_KEYS_FULL = ['chats', 'email', 'calls', 'apps'];
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
            <Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="#111111" opacity={0.9} />
            <Path d="M9 12l2 2 4-4" stroke="#fff" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
          <Text style={[styles.brandTitle, { color: colors.text, fontSize: size }]}>Chatyy</Text>
          <View style={{ backgroundColor: '#111111', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 }}>
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
  // [2026-10-01 STATUS CONSOLIDATION] 'status' is NO LONGER a navigable full-screen
  // tab. The separate (ugly, redundant) Status screen is retired: status now lives
  // ONLY in the feed/chat-list stories strip, which opens ChatStatusTab's StoryViewer
  // + composer as portaled Modals (via requestOpenStatus / requestNewStatus) floating
  // over the current tab — never as a visible tab body. A `?tab=status` deep-link
  // therefore falls back to 'chats' (which still shows the stories strip); the
  // composer deep-link (`?new=1`) still mounts the hidden status surface below.
  const VALID_TABS = ['chats','calls','feed','learn','tv','channels','communities'];
  // ?tab=reels / ?tab=apps are special — they trigger handleTabPress side-effects
  // (setPendingReels+goto feed / openAppsDrawer) instead of mapping 1:1 to a
  // renderable tab. We start on 'chats' and let a useEffect below dispatch them.
  const _initialTab = VALID_TABS.includes(params.tab) ? params.tab : 'chats';
  // Composer deep-link (`?new=1`, from the share sheet / UnifiedComposeFab /
  // notifications) needs the hidden status surface mounted so ChatStatusTab's
  // camera composer Modal can open over the current tab on first mount.
  const _wantsStatusComposer = params.new === '1';
  const [activeTab, setActiveTab] = useState(_initialTab);
  const [mountedTabs, setMountedTabs] = useState(() => {
    const s = new Set(['chats', _initialTab]); // lazy mount: include initial tab to avoid white screen on deep-link
    if (_wantsStatusComposer) s.add('status');
    return s;
  });
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

  // Animated indicator position. Width comes from the responsive `windowWidth`
  // state (not a one-shot Dimensions.get) so the sliding indicator stays
  // centered after rotation / split-view resize.
  const indicatorAnim = useRef(new Animated.Value(TAB_KEYS.indexOf('chats'))).current;
  const screenWidth = windowWidth;
  const tabWidth = isDesktop ? 72 : screenWidth / TAB_KEYS.length;

  // Content fade animation
  const contentOpacity = useRef(new Animated.Value(1)).current;
  // [beauty 2026-10-03] Subtle directional slide paired with the content fade
  // so switching tabs eases in from the swipe direction (Instagram-style).
  const contentTranslateX = useRef(new Animated.Value(0)).current;

  const [showAppsDrawer, setShowAppsDrawer] = useState(false);
  // Per-app badge counts surfaced on the apps drawer tiles. Refreshed
  // whenever the drawer opens — no need to keep this hot in the
  // background since the badges only matter when the drawer is visible.
  const [appsBadges, setAppsBadges] = useState({});
  // Missed-call badge for the bottom-bar "Ligações" tab. Derived from the
  // local call history cache (any unread missed call) plus an opportunistic
  // fetch — keeps the dot live without spinning a network call on every
  // render. Cleared when the user opens the Calls tab.
  const [missedCallBadge, setMissedCallBadge] = useState(0);
  // Bottom-nav badges for the other tabs — chats unread (sum of unread_count
  // across conversations), status unseen (statusList groups not yet viewed by
  // this user), feed unread (feed_list rows newer than the last seen ts).
  // All three poll on the same 60s cadence + reset when the user lands on
  // the corresponding tab. Status feed lives off statusList groups whose
  // items[].viewed_by_me is false; feed unread comes off the latest cursor
  // we've seen versus what api.feedList() returns.
  const [chatsBadge, setChatsBadge] = useState(0);
  // [2026-10-03] Badge de email não-lido na barra de baixo (aba Email).
  const [emailBadge, setEmailBadge] = useState(0);
  const [statusBadge, setStatusBadge] = useState(0);
  const [feedBadge, setFeedBadge] = useState(0);

  const closeAppsDrawer = useCallback(() => setShowAppsDrawer(false), []);

  // [2026-10-07 native-ui-build] Large title "Conversas" que colapsa com o
  // scroll (padrão UINavigationBar / M3 large top app bar). O título grande
  // mora DENTRO da lista (ChatListTab → rola 1:1, sem relayout); quando ele
  // passa por baixo do header o ChatListTab avisa e aqui o título COMPACTO +
  // a hairline fazem fade-in (Animated nativo, zero re-render do chat.js).
  // Header/searchBar NATIVOS (headerLargeTitle/headerSearchBarOptions) exigem
  // o /chat virar tela com header do RNS + abas internas viradas rotas — refactor
  // grande; isto é o equivalente fiel sem tocar na estrutura.
  const LIST_LARGE_TITLE = Platform.OS !== 'web';
  const chatTitleAnim = useRef(new Animated.Value(0)).current;
  const onChatTitleCollapse = useCallback((collapsed) => {
    Animated.timing(chatTitleAnim, { toValue: collapsed ? 1 : 0, duration: 160, useNativeDriver: true }).start();
  }, [chatTitleAnim]);
  // Tab bar de VIDRO no iOS (UIVisualEffectView via expo-blur): fica absoluta
  // sobre o conteúdo e a lista de conversas rola por baixo (bottomInset).
  // Android/web/binário sem expo-blur: barra sólida no fluxo, como antes.
  const GLASS_TAB_BAR = Platform.OS === 'ios' && canNativeBlur();
  const [tabBarH, setTabBarH] = useState(0);
  const onTabBarLayout = useCallback((e) => {
    const h = Math.round(e?.nativeEvent?.layout?.height || 0);
    setTabBarH(prev => (prev === h ? prev : h));
  }, []);

  // Compute missed-call count from cached call history.
  // We gate by a persisted "calls last seen" timestamp — counting only missed
  // calls that arrived AFTER the user last opened the Calls tab. This is
  // resilient to cache refreshes from the backend that don't carry a read
  // flag (was the bug: backend fetch wrote `read:false` back into cache, so
  // the badge "13" reappeared every time activeTab changed).
  React.useEffect(() => {
    let cancelled = false;
    const compute = async () => {
      let count = 0;
      try {
        const { getCallHistoryCached } = require('../components/ChatCallsTab');
        const cached = (typeof getCallHistoryCached === 'function') ? getCallHistoryCached() : [];
        let lastSeen = 0;
        try {
          if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
            lastSeen = Number(localStorage.getItem('calls_last_seen_ts') || 0);
          } else {
            const { getString } = require('../services/mmkv');
            lastSeen = Number(getString?.('calls_last_seen_ts') || 0);
          }
        } catch {}
        count = (cached || []).reduce((acc, c) => {
          if (c?.type !== 'missed') return acc;
          if (c?.read === true || c?.read === 1) return acc;
          // Normalize timestamp: server may return seconds or ms.
          const raw = c?.timestamp ?? c?.created_at;
          let ts = 0;
          if (typeof raw === 'number') ts = raw < 1e12 ? raw * 1000 : raw;
          else if (typeof raw === 'string') ts = Date.parse(raw) || 0;
          if (lastSeen > 0 && ts > 0 && ts <= lastSeen) return acc;
          return acc + 1;
        }, 0);
      } catch {}
      if (!cancelled) setMissedCallBadge(count);
    };
    compute();
    return () => { cancelled = true; };
  }, [activeTab]);

  // Clear the badge as soon as the user lands on the Calls tab. We persist
  // a `calls_last_seen_ts` cursor so the recompute effect (which re-reads
  // call history from the backend cache) skips anything that arrived BEFORE
  // this moment — bug 2026-05-08: backend fetch wrote `read:false` back into
  // the local cache, so the badge "13" kept reappearing. Cache marking alone
  // didn't survive a refresh; the timestamp cursor is durable.
  React.useEffect(() => {
    if (activeTab === 'calls') {
      try {
        const { markMissedCallsRead } = require('../components/ChatCallsTab');
        markMissedCallsRead?.();
      } catch {}
      try {
        const ts = String(Date.now());
        if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
          localStorage.setItem('calls_last_seen_ts', ts);
        } else {
          const { setString } = require('../services/mmkv');
          setString?.('calls_last_seen_ts', ts);
        }
      } catch {}
      if (missedCallBadge > 0) setMissedCallBadge(0);
    }
  }, [activeTab, missedCallBadge]);

  // ── Tab badges polling (chats unread + status unseen + feed unread) ──
  // Single 60s loop covers all three so we never fan out three timers.
  // Each branch tolerates failure independently — a 502 on feed_list won't
  // wipe the chats badge. Polling pauses when the tab is foreground-active
  // because the underlying screen is doing its own real-time refresh.
  React.useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const api = require('../services/api');
        // Chats: sum unread across conversations from chat_list.
        if (activeTab !== 'chats') {
          try {
            const r = await api.chatUnreadCount?.().catch(() => null);
            if (!cancelled) {
              const n = Number(r?.data?.unread_count || 0);
              setChatsBadge(n);
            }
          } catch {}
        }
        // Status: count groups (other users) with at least one unseen item.
        if (activeTab !== 'status') {
          try {
            const r = await api.statusList?.().catch(() => null);
            if (!cancelled) {
              const groups = r?.data?.statuses || r?.data?.groups || r?.data || [];
              const me = (user?.email || '').toLowerCase();
              const list = Array.isArray(groups) ? groups : [];
              const unseen = list.reduce((acc, g) => {
                const owner = (g?.email || g?.user_email || '').toLowerCase();
                if (owner && owner === me) return acc; // ignore my own
                const items = g?.items || g?.statuses || [];
                const hasUnseen = items.some(it => !(it?.viewed_by_me || it?.seen || it?.viewed));
                return hasUnseen ? acc + 1 : acc;
              }, 0);
              setStatusBadge(unseen);
            }
          } catch {}
        }
        // Feed: count posts newer than the last-seen cursor we persist locally.
        if (activeTab !== 'feed') {
          try {
            const r = await (api.feedList ? api.feedList(1, 20) : Promise.resolve(null)).catch(() => null);
            const posts = r?.data?.posts || r?.data || [];
            const list = Array.isArray(posts) ? posts : [];
            let lastSeen = 0;
            try {
              if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
                lastSeen = Number(localStorage.getItem('feed_last_seen_ts') || 0);
              } else {
                const { getString } = require('../services/mmkv');
                lastSeen = Number(getString?.('feed_last_seen_ts') || 0);
              }
            } catch {}
            const fresh = list.reduce((acc, p) => {
              // created_at can be ISO string (Date.parse → ms), timestamp may
              // be ms or s (numeric). Handle both: if numeric < 1e12 assume
              // seconds and scale up. Without this, NaN was producing fresh=0
              // OR fresh=length (depending on lastSeen) and the badge flapped.
              const raw = p?.created_at ?? p?.timestamp;
              let ts = 0;
              if (typeof raw === 'string') ts = Date.parse(raw) || 0;
              else if (typeof raw === 'number') ts = raw < 1e12 ? raw * 1000 : raw;
              return ts > lastSeen ? acc + 1 : acc;
            }, 0);
            if (!cancelled) setFeedBadge(fresh);
          } catch {}
        }
      } catch {}
    };
    refresh();
    const id = setInterval(refresh, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, [activeTab, user?.email]);

  // Reset feed badge on landing on feed tab — store the most recent post ts
  // we've shown so subsequent polls only count posts newer than that. We
  // ALWAYS bump the cursor when on feed (not gated on `feedBadge > 0`),
  // otherwise the first time the user opens Reels with a 0 badge we don't
  // persist anything, and the next 60s poll counts every post as fresh —
  // making the badge "reaparecer" with the same number after the user
  // already saw the content. Bug 2026-05-08.
  React.useEffect(() => {
    if (activeTab === 'feed') {
      if (feedBadge > 0) setFeedBadge(0);
      try {
        const ts = String(Date.now());
        if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
          localStorage.setItem('feed_last_seen_ts', ts);
        } else {
          const { setString } = require('../services/mmkv');
          setString?.('feed_last_seen_ts', ts);
        }
      } catch {}
    }
  }, [activeTab, feedBadge]);

  // Reset status badge when user opens status tab.
  React.useEffect(() => {
    if (activeTab === 'status' && statusBadge > 0) setStatusBadge(0);
  }, [activeTab, statusBadge]);

  // Reset chats badge when user lands on chats — ChatListTab marks rows read
  // as the user opens conversations, so we just clear the surface state here
  // and let the next 60s tick pick up any still-unread rows.
  React.useEffect(() => {
    if (activeTab === 'chats' && chatsBadge > 0) setChatsBadge(0);
  }, [activeTab, chatsBadge]);

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

  // [2026-10-03] Badge de email não-lido na barra de baixo — busca leve (só a
  // CONTAGEM) no mount e a cada 60s. Silencioso; nunca derruba a UI.
  useEffect(() => {
    let cancelled = false; let timer = null;
    const fetchEmailUnread = async () => {
      try {
        const api = require('../services/api');
        if (!api.inboxUnreadCount) return;
        const r = await api.inboxUnreadCount().catch(() => null);
        if (cancelled) return;
        const n = Number(r?.data?.unread || r?.data?.count || 0);
        setEmailBadge(Number.isFinite(n) && n > 0 ? n : 0);
      } catch {}
    };
    fetchEmailUnread();
    timer = setInterval(fetchEmailUnread, 60000);
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, []);

  const handleTabPress = useCallback((tab) => {
    // "Apps" is a drawer overlay — it doesn't switch tabs, so we keep the
    // chats tab active underneath and just open the modal.
    if (tab === 'apps') { setShowAppsDrawer(true); return; }
    // "One" is the AI assistant screen — full navigation, not an inline tab.
    if (tab === 'one') { try { router.push('/one'); } catch (e) { console.warn("[chat] router.push failed:", e); } return; }
    // "Email" jumps to the inbox screen (same pattern as One).
    if (tab === 'email') { try { router.replace('/inbox'); } catch (e) { console.warn("[chat] router.replace failed:", e); } return; }
    // "Reels" bottom-nav button opens the feed screen on the Posts tab by
    // default (Reels is the second sub-tab inside the feed). Reverts #896
    // which forced reels mode — user feedback 2026-05-21: clicking Reels
    // should land on Posts so the feed feels like an Instagram-style home.
    if (tab === 'reels') { handleTabPress('feed'); return; }
    if (tab === activeTab) return;
    // [beauty 2026-10-01] Tactile tap on a real tab switch (web-safe no-op).
    // [2026-10-07 app-feel-nav] No nativo o haptic sai do próprio TabBarItem
    // (cobre Email/Apps também) — aqui só no desktop/web p/ não vibrar 2x.
    if (Platform.OS === 'web') { try { haptic.select(); } catch {} }
    const idx = TAB_KEYS.indexOf(tab);

    // Tabs in the bottom bar slide the indicator. Off-bar tabs (Feed/Status
    // launched from the Apps drawer on mobile) just switch content without
    // animating the indicator.
    if (idx >= 0) {
      Animated.spring(indicatorAnim, {
        toValue: idx,
        useNativeDriver: true,
        tension: 120,
        friction: 16,
        overshootClamping: false,
      }).start();
    }

    // [beauty 2026-10-01] Fade the INCOMING tab in only. The old sequence
    // dropped the shared content wrapper to opacity 0 first, which blanked the
    // whole content area for a frame (read as a flicker, not a crossfade, since
    // tabs swap via display:none with no simultaneous out/in). Now it starts at
    // 0.6 and springs to 1 — a quick settle-in with no blank frame.
    // [beauty 2026-10-03] Direction of the subtle content slide: compare the
    // incoming tab index against the outgoing one (fall back to a forward
    // nudge for off-bar tabs like Feed/Status that aren't in TAB_KEYS).
    const prevIdx = TAB_KEYS.indexOf(activeTab);
    const dir = (idx >= 0 && prevIdx >= 0 && idx !== prevIdx) ? (idx > prevIdx ? 1 : -1) : 1;
    contentOpacity.setValue(0.6);
    contentTranslateX.setValue(dir * 16);
    Animated.parallel([
      Animated.spring(contentOpacity, { toValue: 1, useNativeDriver: true, tension: 100, friction: 18 }),
      Animated.spring(contentTranslateX, { toValue: 0, useNativeDriver: true, tension: 100, friction: 18 }),
    ]).start();

    setActiveTab(tab);
    setMountedTabs(prev => { const next = new Set(prev); next.add(tab); return next; });
  }, [indicatorAnim, contentOpacity, contentTranslateX, activeTab, TAB_KEYS]);

  // Trigger initial sync ONCE per account (not per app-version-bump).
  // Old gate was a global `sync_version` bump that re-ran the 8-phase
  // pull on every release → users felt "always syncing". Now we key the
  // gate on the account email so the heavy fetch happens exactly once
  // after the user's very first login on this device. WS push +
  // event-driven deltaSync handle everything afterwards.
  const syncTriggered = useRef(false);
  useEffect(() => {
    if (syncTriggered.current) return;
    const email = user?.email;
    if (!email || !user?.token) return;
    syncTriggered.current = true;

    try {
      const { getString, setString } = require('../services/mmkv');
      const gateKey = `initial_sync_done:${email}`;
      const api = require('../services/api');

      // WhatsApp-grade "tudo no celular" (#1194/#1196): kick off the
      // per-conversation FULL history bootstrap UNCONDITIONALLY here.
      // It MUST NOT be gated by `initial_sync_done:<email>` — that flag
      // gets sealed on the user's first launch (well before #1194
      // shipped), so existing installs would never get the new bootstrap
      // if we piggybacked on the initial-sync gate. The bootstrap has its
      // own SQLite-backed gate (`chat_full_bootstrap:<email>` in
      // sync_state); calling it on every chat-screen mount is cheap —
      // a single sync_state lookup short-circuits to skipped='already_done'.
      try {
        const { bootstrapFullHistoryOnce } = require('../services/fullHistorySync');
        // Defer past first paint so the chat list animates in cleanly
        // before the network traffic starts.
        setTimeout(() => {
          bootstrapFullHistoryOnce(api.apiCall, email).catch(() => {});
        }, 2500);
      } catch {}

      if (getString?.(gateKey) === '1') return; // initial sync already done for this account
      runInitialSync(api).then((r) => {
        // Mark done only on success (or skip path). Avoid sealing the
        // gate on transient errors so the user gets another chance.
        if (r && !r.error) {
          try { setString?.(gateKey, '1'); } catch {}
        }
      }).catch(() => {});
    } catch {}
  }, [user?.email, user?.token]);

  // AppState-driven retry for the full-history bootstrap (#1200 Stage D,
  // 2026-05-20). The mount-once trigger above only fires when the chat
  // screen first mounts. If the bootstrap was interrupted (background, OS
  // kill, network blip, per-conv 403), the gate sits at 'pending'/'started'
  // and never gets a second chance from this screen alone. Re-fire whenever
  // the app resumes from background and the gate isn't 'done'. Cheap:
  // `nudgeFullHistorySync` short-circuits when a loop is already running,
  // and `bootstrapFullHistoryOnce` short-circuits on the SQLite gate read.
  useEffect(() => {
    const email = user?.email;
    if (!email || !user?.token) return;
    if (Platform.OS === 'web') return;
    let sub = null;
    try {
      const api = require('../services/api');
      const { nudgeFullHistorySync } = require('../services/fullHistorySync');
      const localDb = require('../services/localDb');
      const handle = async (state) => {
        if (state !== 'active') return;
        try {
          const v = await localDb.getSyncState?.(`chat_full_bootstrap:${email.toLowerCase()}`);
          if (v === 'done') return;
          nudgeFullHistorySync(api.apiCall, email);
        } catch {}
      };
      sub = AppState.addEventListener('change', handle);
    } catch {}
    return () => { try { sub?.remove?.(); } catch {} };
  }, [user?.email, user?.token]);

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
  // [2026-10-01] openStatusFromApps removed — the Status screen is retired as a
  // standalone tab (status lives in the feed/chat-list stories strip now). The
  // Apps drawer already dropped its Status tile; this handler was dead wiring.
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

  // [2026-06-09 sweep] Web keyboard shortcuts (WhatsApp Web parity):
  // Ctrl/Cmd+K opens + focuses conversation search (the TextInput autoFocuses
  // on open); Esc closes it. Listener skips when another modal-ish element
  // owns focus is not needed — Ctrl+K is a deliberate chord, and Esc only
  // acts while the search bar is open.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onKeyDown = (e) => {
      try {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
          e.preventDefault();
          if (!searchOpen) toggleSearch();
          return;
        }
        if (e.key === 'Escape' && searchOpen) {
          toggleSearch();
        }
      } catch {}
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [searchOpen, toggleSearch]);

  // When profile screen routes user here with `new=1`, ChatStatusTab picks
  // that up and opens the creator immediately. Reset on first consume so a
  // refresh/re-render doesn't re-open the composer.
  const [autoNewStatus, setAutoNewStatus] = useState(() => params.new === '1');
  const [pendingReels, setPendingReels] = useState(false);
  // [2026-05-30 STATUS CONSOLIDATION] When the chat-list home strip (ChatListTab)
  // taps a story ring, it flips to the canonical `status` tab and stashes the
  // tapped email here so ChatStatusTab deep-opens that user's viewer. This
  // replaces ChatListTab's OWN duplicate StoryViewer — one status system now.
  const [openStatusEmail, setOpenStatusEmail] = useState(null);
  useEffect(() => {
    if (autoNewStatus) {
      const t = setTimeout(() => setAutoNewStatus(false), 500);
      return () => clearTimeout(t);
    }
  }, [autoNewStatus]);
  // [#1247 2026-05-20] tabActive flag por tab — fix audio leak no Reels.
  // ChatFeedTab/ReelsViewer ficam mounted com display:none quando user troca
  // de aba (Chats/Calls). Sem esse flag o ReelsViewer só checava useIsFocused
  // (route ainda é /chat = true) e o native ShortsPlayer mantinha tocando
  // áudio em background. Cada tab agora recebe `tabActive` próprio.
  // requestOpenStatus(email): single entry point the feed + chat-list stories
  // strips call to open a story. [2026-10-01] We NO LONGER switch activeTab to
  // the retired 'status' screen — we just mount the hidden status surface so
  // ChatStatusTab's StoryViewer Modal (which portals to the document body /
  // native modal host) floats OVER the current tab. ChatStatusTab consumes
  // openStatusEmail and clears it via onOpenStatusConsumed.
  const requestOpenStatus = useCallback((email) => {
    setOpenStatusEmail(email || null);
    setMountedTabs(prev => prev.has('status') ? prev : new Set(prev).add('status'));
    // Opening a story counts as "seen" for the unread badge. The old reset
    // keyed on activeTab==='status' no longer fires since we never switch tabs.
    setStatusBadge(0);
  }, []);
  // requestNewStatus(): stories strip "+" → open the canonical status composer
  // as an overlay. Flips autoNewStatus so ChatStatusTab opens its creator Modal
  // over the current tab. Re-armable across taps (chat.js resets it ~500ms later).
  const requestNewStatus = useCallback(() => {
    setMountedTabs(prev => prev.has('status') ? prev : new Set(prev).add('status'));
    setAutoNewStatus(true);
  }, []);
  // PERF: these two were inline arrows inside the tabProps literal, so every
  // chat.js render minted fresh function identities → tabProps changed → every
  // mounted tab (ChatListTab, Feed, Status, …) re-rendered even on unrelated
  // state churn (SyncBar ticks, badge updates). useCallback pins them.
  const onOpenStatusConsumed = useCallback(() => setOpenStatusEmail(null), []);
  const onFeedModeConsumed = useCallback(() => setPendingReels(false), []);
  // [2026-10-07 apps-menu] Apps drawer "Reels" tile → feed tab in reels mode
  // (ChatFeedTab consumes initialFeedMode='reels' → full-screen ReelsViewer).
  const openReelsFromApps = useCallback(() => { setShowAppsDrawer(false); setPendingReels(true); handleTabPress('feed'); }, [handleTabPress]);
  // PERF: tabProps was a fresh object every render and is spread into ALL
  // mounted tabs. Memoizing it means a tab only re-renders when a value it
  // actually consumes changes, not on every parent re-render.
  const tabProps = useMemo(() => ({ colors, isDark, t, user, router, searchQuery, setActiveTab, autoNewStatus, openStatusEmail, onOpenStatusConsumed, requestOpenStatus, requestNewStatus, initialFeedMode: pendingReels ? 'reels' : undefined, onFeedModeConsumed, tabActive: activeTab }), [colors, isDark, t, user, router, searchQuery, setActiveTab, autoNewStatus, openStatusEmail, onOpenStatusConsumed, requestOpenStatus, requestNewStatus, pendingReels, onFeedModeConsumed, activeTab]);

  const titles = {
    feed: t('feed.title') || 'Feed',
    status: 'Status',
    calls: t('chat.tabCalls') || 'Ligacoes',
    chats: t('chat.tabChats') || 'Conversas',
    config: t('chat.tabConfig') || 'Configuracoes',
    learn: 'Professora ONE',
    tv: 'Chatyy TV',
    channels: t('channel.title') || 'Channels',
    communities: t('community.title') || 'Communities',
  };

  const renderHeaderAction = () => {
    const headerIconColor = colors.text;
    // [beauty 2026-10-01] Header action icons are now bare (no filled chip) —
    // WhatsApp's header icons sit on the plain white bar, which reads lighter
    // and airier. Kept transparent on both themes.
    const headerBtnBg = 'transparent';
    const btnStyle = [styles.headerIconBtn, { backgroundColor: headerBtnBg, borderRadius: 20 }];
    if (activeTab === 'chats') {
      return (
        <>
          <TouchableOpacity onPress={() => { try { router.push('/photos?camera=1'); } catch (e) { console.warn("[chat] router.push failed:", e); } }} activeOpacity={0.6}
            hitSlop={6} style={btnStyle} accessibilityLabel={t('a11y.camera')}>
            <IconCamera size={19} color={headerIconColor} />
          </TouchableOpacity>
          <TouchableOpacity onPress={toggleSearch} activeOpacity={0.6}
            hitSlop={6} style={btnStyle} accessibilityLabel={t('a11y.search')}>
            <IconSearch size={18} color={headerIconColor} />
          </TouchableOpacity>
          {/* WhatsApp-parity: "new chat" is a filled GREEN circle (the one
              pop of color in the otherwise clean header). */}
          <TouchableOpacity onPress={() => router.push('/chat-new')} activeOpacity={0.75}
            hitSlop={6} style={[styles.headerIconBtn, { backgroundColor: headerBtnBg }]} accessibilityLabel={t('a11y.newChat')}>
            {/* [2026-10-06 founder] "+" do topo era VERDE (#25D366 + ícone branco) e
                chamava atenção demais; WhatsApp usa ícones neutros no header.
                Agora igual aos outros botões do topo: fundo cinza + ícone na cor
                do texto. (headerPlusGreen fica no stylesheet p/ eventual uso.) */}
            <IconPlus size={20} color={headerIconColor} />
          </TouchableOpacity>
        </>
      );
    }
    if (activeTab === 'calls') {
      return (
        <TouchableOpacity onPress={() => router.push('/chat-new')} activeOpacity={0.6}
          style={[styles.headerIconBtn, { backgroundColor: headerBtnBg }]} accessibilityRole="button" accessibilityLabel={t('a11y.newCall')}>
          <IconPhone size={17} color={headerIconColor} />
        </TouchableOpacity>
      );
    }
    if (activeTab === 'status') {
      return (
        // [2026-06-04] era onPress={() => {}} — botão de câmera morto (caçada
        // R2). Reusa o fluxo do strip "+ status": requestNewStatus() flipa
        // autoNewStatus e o ChatStatusTab abre o composer canônico.
        <TouchableOpacity onPress={requestNewStatus} activeOpacity={0.6}
          style={[styles.headerIconBtn, { backgroundColor: headerBtnBg }]}>
          <IconCameraHeader size={18} color={headerIconColor} />
        </TouchableOpacity>
      );
    }
    if (activeTab === 'feed') {
      return (
        <TouchableOpacity onPress={toggleSearch} activeOpacity={0.6}
          style={[styles.headerIconBtn, { backgroundColor: headerBtnBg }]}>
          <IconSearch size={18} color={headerIconColor} />
        </TouchableOpacity>
      );
    }
    return null;
  };

  // Mobile bottom tab bar indicator — inputRange must match outputRange
  // length, and outputRange follows TAB_KEYS which is dynamic (3 kids/desktop, 4 full).
  const indicatorTranslateX = indicatorAnim.interpolate({
    inputRange: TAB_KEYS.map((_, i) => i),
    outputRange: TAB_KEYS.map((_, i) => (i * tabWidth) + (tabWidth / 2) - 16),
  });

  const indicatorScale = (() => {
    const n = TAB_KEYS.length;
    const inputRange = [];
    const outputRange = [];
    for (let i = 0; i < n; i++) {
      inputRange.push(i);
      outputRange.push(1);
      if (i < n - 1) {
        inputRange.push(i + 0.5);
        outputRange.push(1.15);
      }
    }
    return indicatorAnim.interpolate({ inputRange, outputRange });
  })();

  const searchHeight = searchAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 52] });
  const searchOpacity = searchAnim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 0, 1] });

  // WhatsApp 2026 header style — CLEAN WHITE (2026-09-30 "much less black").
  // Was a solid black surface (#111 in both modes). Now a white (light) /
  // surface (dark) header with dark text + a hairline separator, so the top
  // chrome reads airy instead of a heavy black bar.
  const glassHeader = {
    backgroundColor: isDark ? '#111b21' : '#ffffff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: isDark ? '#1a2730' : '#eef0f1',
  };

  const glassTabBar = {
    backgroundColor: isDark ? '#111b21' : '#ffffff',
  };

  // ── DESKTOP LAYOUT (side rail + content) ──
  if (isDesktop) {
    return (
      <View style={[styles.container, { backgroundColor: isDark ? '#0e1621' : '#f0f2f5', flexDirection: 'row' }]}>
        {/* Side Rail */}
        <View style={[styles.desktopRail, {
          backgroundColor: isDark ? '#0a0a0a' : '#111111',
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
            {TAB_KEYS.map((key) => {
              // Per-tab badge: chats unread, status unseen groups, feed new
              // posts, calls missed. Each one is cleared by a parallel effect
              // when that tab becomes active so the dot stays meaningful.
              const tabBadge = key === 'chats' ? chatsBadge
                : key === 'status' ? statusBadge
                : key === 'feed' ? feedBadge
                : key === 'calls' ? missedCallBadge
                : 0;
              return (
                <DesktopTabItem
                  key={key}
                  tabKey={key}
                  icon={key === 'feed' ? IconFeedTab : key === 'status' ? IconStatusTab : key === 'calls' ? IconCallsTab : key === 'chats' ? IconChatsTab : IconConfigTab}
                  label={key === 'chats' ? 'Chats' : key === 'feed' ? 'Feed' : key === 'status' ? 'Status' : key === 'calls' ? (t('chat.tabCalls') || 'Ligacoes') : (t('chat.tabConfig') || 'Config')}
                  active={activeTab === key}
                  onPress={() => handleTabPress(key)}
                  isDark={isDark}
                  badge={tabBadge}
                />
              );
            })}
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
          }]}>
            <View style={styles.titleWrap}>
              <Text style={[styles.title, { color: colors.text }]}>{titles[activeTab]}</Text>
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
                  style={{ paddingHorizontal: 9, paddingVertical: 4, marginRight: 4, borderRadius: 12, backgroundColor: isDark ? 'rgba(233,237,239,0.14)' : 'rgba(17,17,17,0.07)' }}
                >
                  <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 0.2, color: isDark ? '#e9edef' : '#111111' }}>{t('common.searchAll') || 'Tudo'}</Text>
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
          <Animated.View style={{ flex: 1, opacity: contentOpacity, transform: [{ translateX: contentTranslateX }] }}>
            <View style={{ display: activeTab === 'chats' ? 'flex' : 'none', flex: activeTab === 'chats' ? 1 : undefined }}>
              <ChatErrorBoundary><ChatListTab key={'cl_' + (user?.email || 'anon')} {...tabProps} /></ChatErrorBoundary>
            </View>
            {mountedTabs.has('calls') && <View style={{ display: activeTab === 'calls' ? 'flex' : 'none', flex: activeTab === 'calls' ? 1 : undefined }}>
              <ChatErrorBoundary><ChatCallsTab {...tabProps} /></ChatErrorBoundary>
            </View>}
            {mountedTabs.has('feed') && <View style={{ display: activeTab === 'feed' ? 'flex' : 'none', flex: activeTab === 'feed' ? 1 : undefined }}>
              <ChatErrorBoundary><Suspense fallback={null}><ChatFeedTab {...tabProps} /></Suspense></ChatErrorBoundary>
            </View>}
            {mountedTabs.has('status') && <View style={{ display: activeTab === 'status' ? 'flex' : 'none', flex: activeTab === 'status' ? 1 : undefined }}>
              <ChatErrorBoundary><Suspense fallback={null}><ChatStatusTab {...tabProps} /></Suspense></ChatErrorBoundary>
            </View>}
            {/* Removed: 'config' tab rendered ChatProfileTab which duplicated
                the unified profile. Taps on the header avatar now open /u/{me}. */}
            {mountedTabs.has('learn') && <View style={{ display: activeTab === 'learn' ? 'flex' : 'none', flex: activeTab === 'learn' ? 1 : undefined }}>
              <ChatErrorBoundary><Suspense fallback={null}><KidsLearnTab {...tabProps} /></Suspense></ChatErrorBoundary>
            </View>}
            {mountedTabs.has('tv') && <View style={{ display: activeTab === 'tv' ? 'flex' : 'none', flex: activeTab === 'tv' ? 1 : undefined }}>
              <ChatErrorBoundary><Suspense fallback={null}><KidsTVTab {...tabProps} /></Suspense></ChatErrorBoundary>
            </View>}
            {mountedTabs.has('channels') && <View style={{ display: activeTab === 'channels' ? 'flex' : 'none', flex: activeTab === 'channels' ? 1 : undefined }}>
              <ChatErrorBoundary><Suspense fallback={null}><ChannelsTab {...tabProps} /></Suspense></ChatErrorBoundary>
            </View>}
            {mountedTabs.has('communities') && <View style={{ display: activeTab === 'communities' ? 'flex' : 'none', flex: activeTab === 'communities' ? 1 : undefined }}>
              <ChatErrorBoundary><Suspense fallback={null}><CommunitiesTab {...tabProps} /></Suspense></ChatErrorBoundary>
            </View>}
          </Animated.View>
          {/* ChatListTab has its own FAB (new chat/group/channel), and
              ChatFeedTab has its own composer — nothing to render here. */}
        </View>
        {/* [2026-10-07 welcome] per-account first-run (renders null when done) */}
        {!isKids ? <FirstRunGate /> : null}
      </View>
    );
  }

  // ── MOBILE LAYOUT (bottom tab bar) ──
  return (
    <View style={[styles.container, {
      backgroundColor: isDark ? '#0e1621' : '#ffffff',
      paddingTop: insets.top,
    }]}>
      {/* WhatsApp-style header — no back arrow on mobile (Chatyy IS home) */}
      <View style={[styles.header, {
        ...glassHeader,
        paddingLeft: 14,
        // [2026-10-07 native-ui-build] large title: sem hairline fixa — ela
        // aparece (fade) só quando a lista rola por baixo do header.
        ...(LIST_LARGE_TITLE && activeTab === 'chats' ? { borderBottomWidth: 0 } : {}),
      }]}>
        {LIST_LARGE_TITLE && activeTab === 'chats' && (
          <>
            <Animated.View pointerEvents="none" style={[styles.compactTitleWrap, { opacity: chatTitleAnim }]}>
              <Text numberOfLines={1} accessibilityElementsHidden importantForAccessibility="no" style={[styles.compactTitle, { color: colors.text }]}>
                {titles.chats}
              </Text>
            </Animated.View>
            <Animated.View
              pointerEvents="none"
              style={[styles.headerHairline, { backgroundColor: isDark ? '#1a2730' : 'rgba(0,0,0,0.12)', opacity: chatTitleAnim }]}
            />
          </>
        )}
        {/* Profile avatar — opens the unified profile (/u/{me}).
            Was routing to the deprecated "config" tab (ChatProfileTab),
            which duplicated the profile UI inside the chat shell. */}
        {activeTab === 'chats' && (
          <TouchableOpacity
            onPress={() => user?.email && router.push(`/u/${encodeURIComponent(user.email)}`)}
            activeOpacity={0.7}
            style={{ marginRight: 10 }}
            accessibilityLabel={t('a11y.profile')}
          >
            <AvatarCircle name={user?.name || user?.email} email={user?.email} size={32} />
          </TouchableOpacity>
        )}
        <View style={[styles.titleWrap, { flex: 1 }]}>
          {activeTab === 'chats' ? (
            // WhatsApp iOS "pegada": big bold left-aligned title instead of the
            // Chatyy wordmark. Uses the i18n label already defined in `titles`.
            // [2026-10-07 native-ui-build] Nativo: o título grande foi p/ dentro
            // da lista (large title que colapsa); aqui fica vazio.
            LIST_LARGE_TITLE ? null : (
            <Text style={[styles.bigTitle, { color: colors.text }]} numberOfLines={1}>
              {titles.chats}
            </Text>
            )
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <TouchableOpacity onPress={() => handleTabPress('chats')} hitSlop={10}>
                <IconArrowLeft size={18} color={colors.text} />
              </TouchableOpacity>
              <Text style={[styles.title, { color: colors.text }]}>{titles[activeTab]}</Text>
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
      {/* [2026-10-07 native-ui-build] Tab bar de vidro (iOS) é absoluta: as
          outras abas ganham paddingBottom = altura da barra (layout igual ao
          de antes); a de Conversas rola POR BAIXO (bottomInset na lista). */}
      <Animated.View style={{ flex: 1, opacity: contentOpacity, transform: [{ translateX: contentTranslateX }], ...(GLASS_TAB_BAR && activeTab !== 'chats' ? { paddingBottom: tabBarH } : {}) }}>
        <View style={{ display: activeTab === 'chats' ? 'flex' : 'none', flex: activeTab === 'chats' ? 1 : undefined }}>
          <ChatErrorBoundary><ChatListTab
            key={'cl_' + (user?.email || 'anon')}
            {...tabProps}
            largeTitle={LIST_LARGE_TITLE ? titles.chats : undefined}
            onLargeTitleCollapsedChange={LIST_LARGE_TITLE ? onChatTitleCollapse : undefined}
            bottomInset={GLASS_TAB_BAR ? tabBarH : 0}
          /></ChatErrorBoundary>
        </View>
        {mountedTabs.has('calls') && <View style={{ display: activeTab === 'calls' ? 'flex' : 'none', flex: activeTab === 'calls' ? 1 : undefined }}>
          <ChatErrorBoundary><ChatCallsTab {...tabProps} /></ChatErrorBoundary>
        </View>}
        {mountedTabs.has('feed') && <View style={{ display: activeTab === 'feed' ? 'flex' : 'none', flex: activeTab === 'feed' ? 1 : undefined }}>
          <ChatErrorBoundary><Suspense fallback={null}><ChatFeedTab {...tabProps} /></Suspense></ChatErrorBoundary>
        </View>}
        {mountedTabs.has('status') && <View style={{ display: activeTab === 'status' ? 'flex' : 'none', flex: activeTab === 'status' ? 1 : undefined }}>
          <ChatErrorBoundary><Suspense fallback={null}><ChatStatusTab {...tabProps} /></Suspense></ChatErrorBoundary>
        </View>}
        {/* Removed: config/profile duplicate — header avatar routes to /u/{me} */}
        {mountedTabs.has('learn') && <View style={{ display: activeTab === 'learn' ? 'flex' : 'none', flex: activeTab === 'learn' ? 1 : undefined }}>
          <ChatErrorBoundary><Suspense fallback={null}><KidsLearnTab {...tabProps} /></Suspense></ChatErrorBoundary>
        </View>}
        {mountedTabs.has('channels') && <View style={{ display: activeTab === 'channels' ? 'flex' : 'none', flex: activeTab === 'channels' ? 1 : undefined }}>
          <ChatErrorBoundary><Suspense fallback={null}><ChannelsTab {...tabProps} /></Suspense></ChatErrorBoundary>
        </View>}
        {mountedTabs.has('communities') && <View style={{ display: activeTab === 'communities' ? 'flex' : 'none', flex: activeTab === 'communities' ? 1 : undefined }}>
          <ChatErrorBoundary><Suspense fallback={null}><CommunitiesTab {...tabProps} /></Suspense></ChatErrorBoundary>
        </View>}
      </Animated.View>

      {/* Bottom tab bar. [2026-10-07 app-feel-nav] Nativo: barra RETA colada
          na borda com hairline no topo (UITabBar / Material NavigationBar) —
          antes era um "card flutuante" (cantos 22 + sombra -4/elevation 16),
          padrão de site. Altura = 49pt iOS / 64-80dp Android + home indicator. */}
      <View accessibilityRole="tabbar" onLayout={GLASS_TAB_BAR ? onTabBarLayout : undefined} style={[styles.tabBar, {
        backgroundColor: GLASS_TAB_BAR ? 'transparent' : (isDark ? '#111b21' : '#ffffff'),
        ...(GLASS_TAB_BAR ? { position: 'absolute', left: 0, right: 0, bottom: 0 } : {}),
        paddingBottom: Platform.OS === 'web' ? (insets.bottom || 10) : Math.max(insets.bottom, Platform.OS === 'android' ? 12 : 8),
        ...(Platform.OS !== 'web' ? {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.12)',
        } : {
          borderTopColor: 'transparent',
          borderTopLeftRadius: 22,
          borderTopRightRadius: 22,
          backdropFilter: 'blur(24px) saturate(200%)',
          WebkitBackdropFilter: 'blur(24px) saturate(200%)',
          backgroundColor: isDark ? 'rgba(17, 27, 33, 0.92)' : 'rgba(255, 255, 255, 0.92)',
          boxShadow: isDark
            ? '0 -2px 6px rgba(0,0,0,0.35), 0 -1px 0 rgba(255,255,255,0.04)'
            : '0 -1px 3px rgba(0,0,0,0.06), 0 -1px 0 rgba(0,0,0,0.04)',
        }),
      }]}>
        {/* [beauty 2026-10-01] WhatsApp-style sliding active indicator. The
            spring driving indicatorAnim already ran on every tab switch but no
            view consumed it — now a 3px accent bar rides under the active tab.
            Gated to the full/desktop bar (kids bar has its own 3-item layout). */}
        {/* [2026-10-07 app-feel-nav] iOS UITabBar não tem barra indicadora —
            só a cor do ícone/label. Mantida no Android/web. */}
        {/* [2026-10-07 native-ui-build] iOS: material translúcido do sistema
            (systemChromeMaterial, igual UITabBar) atrás dos itens. */}
        {GLASS_TAB_BAR && <BarMaterial isDark={isDark} solidColor={isDark ? '#111b21' : '#ffffff'} />}
        {!isKids && Platform.OS !== 'ios' && (
          <Animated.View
            pointerEvents="none"
            style={[styles.tabIndicator, {
              backgroundColor: isDark ? '#e9edef' : ACCENT,
              transform: [{ translateX: indicatorTranslateX }, { scaleX: indicatorScale }],
            }]}
          />
        )}
        {isKids ? (
          <>
            <TabBarItem
              icon={(active) => <IconChatsTab size={25} color={active ? '#111111' : (isDark ? '#5a6270' : '#a0a8b4')} active={active} />}
              label={t('kids.chat') || 'Chats'}
              active={activeTab === 'chats'}
              onPress={() => handleTabPress('chats')}
              isDark={isDark}
              badge={0}
            />
            <TabBarItem
              icon={(active) => {
                const c = active ? '#111111' : (isDark ? '#5a6270' : '#a0a8b4');
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
              icon={(active) => <IconChatsTab size={22} color={active ? ACCENT : (isDark ? '#5a6270' : '#a0a8b4')} active={active} />}
              label={t('chat.tabChats') || 'Chats'}
              active={activeTab === 'chats'}
              onPress={() => handleTabPress('chats')}
              isDark={isDark}
              badge={chatsBadge}
            />
            {/* [2026-10-03] Email no lugar do Reels — diferencial do super-app
                + utilidade diária. Abre o inbox (/inbox) via handleTabPress('email'). */}
            <TabBarItem
              icon={(active) => <IconMail size={22} color={active ? ACCENT : (isDark ? '#5a6270' : '#a0a8b4')} />}
              label={t('chat.tabEmail') || 'Email'}
              active={false}
              onPress={() => handleTabPress('email')}
              isDark={isDark}
              badge={emailBadge}
            />
            <TabBarItem
              icon={(active) => <IconCallsTab size={22} color={active ? ACCENT : (isDark ? '#5a6270' : '#a0a8b4')} active={active} />}
              label={t('chat.tabCalls') || 'Ligações'}
              active={activeTab === 'calls'}
              onPress={() => handleTabPress('calls')}
              isDark={isDark}
              badge={missedCallBadge}
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
        userEmail={user?.email}
        onOpenFeed={openFeedFromApps}
        onOpenReels={openReelsFromApps}
        onOpenChannels={openChannelsFromApps}
        onOpenCommunities={openCommunitiesFromApps}
        badges={appsBadges}
      />
      {/* No UnifiedComposeFab here — ChatListTab has its own FAB with
          new chat/group/channel, and each other tab owns its composer. */}
      {/* [2026-10-07 welcome] per-account first-run (renders null when done) */}
      {!isKids ? <FirstRunGate /> : null}
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
// App-usage counter — increments on every launch and persists alongside the
// MRU list. Used to sort items within each section so the apps the user
// actually touches surface at the top (iOS Spotlight + Pixel launcher pattern).
const APP_USAGE_KEY = 'apps_usage_v1';
const _readRecentApps = () => {
  try {
    if (Platform.OS === 'web') {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(RECENT_APPS_KEY) : null;
      return raw ? JSON.parse(raw) : [];
    }
    // [2026-10-07 apps-menu] services/mmkv exports getString/setString — there is
    // no `mmkv` named export, so native Recentes/usage never persisted.
    const { getString } = require('../services/mmkv');
    const raw = getString(RECENT_APPS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
};
const _writeRecentApps = (list) => {
  try {
    const v = JSON.stringify(list.slice(0, 8));
    if (Platform.OS === 'web') {
      if (typeof localStorage !== 'undefined') localStorage.setItem(RECENT_APPS_KEY, v);
    } else {
      const { setString } = require('../services/mmkv');
      setString(RECENT_APPS_KEY, v);
    }
  } catch {}
};
const _readAppUsage = () => {
  try {
    if (Platform.OS === 'web') {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(APP_USAGE_KEY) : null;
      return raw ? JSON.parse(raw) : {};
    }
    // [2026-10-07 apps-menu] services/mmkv exports getString/setString — there is
    // no `mmkv` named export, so native Recentes/usage never persisted.
    const { getString } = require('../services/mmkv');
    const raw = getString(APP_USAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
};
const _writeAppUsage = (obj) => {
  try {
    const v = JSON.stringify(obj || {});
    if (Platform.OS === 'web') {
      if (typeof localStorage !== 'undefined') localStorage.setItem(APP_USAGE_KEY, v);
    } else {
      const { setString } = require('../services/mmkv');
      setString(APP_USAGE_KEY, v);
    }
  } catch {}
};
const _bumpRecentApp = (key) => {
  const cur = _readRecentApps().filter(k => k !== key);
  cur.unshift(key);
  _writeRecentApps(cur);
  // Bump usage count too so section sort knows the user's favorites.
  try {
    const u = _readAppUsage();
    u[key] = (u[key] || 0) + 1;
    _writeAppUsage(u);
  } catch {}
};

// [2026-10-07 apps-menu] Apps drawer redesign — super-app launcher pattern
// (WeChat "Discover" / Grab home / Revolut hub / Telegram mini-apps):
//   • featured Bia card, then "Recentes" (MRU), then grouped sections
//     Comunicação · Social · Ferramentas · Conta, each a soft rounded card;
//   • 4-col grid, colored rounded-square tiles (soft tint + colored glyph,
//     SVG from components/Icons — never emoji), label below (2 lines max);
//   • accent/diacritic-insensitive search over label + keywords + section;
//   • PressableScale press feedback; light/dark via theme tokens + isDark.
// Routes/actions are unchanged from the previous drawer; NEW entries: Reels
// (feed tab in reels mode — same ReelsViewer the old bottom-bar Reels opened)
// and Feed (posts — onOpenFeed was already wired but had no tile).

// Hex "#rrggbb" + alpha 0..1 → rgba(). Tiles are tinted from the app color.
const _hexA = (hex, a) => {
  const h = String(hex || '#111111').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
// Mix hex toward white (dark-mode glyphs need a lighter tone to keep contrast).
const _lighten = (hex, p) => {
  const h = String(hex || '#111111').replace('#', '');
  const n = parseInt(h, 16);
  const m = (v) => Math.round(v + (255 - v) * p);
  return `rgb(${m((n >> 16) & 255)},${m((n >> 8) & 255)},${m(n & 255)})`;
};
// Accent/diacritic-insensitive lowercase ("vídeo" ≈ "video").
const _norm = (s) => {
  try { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  catch { return String(s || '').toLowerCase(); }
};

// One app tile (Recentes row + section grids). PressableScale gives the
// spring + haptic; the badge keeps its pulse + rolling counter.
function AppTile({ item, badge, onPress, colors, isDark, t }) {
  const badgePulse = useRef(new Animated.Value(1)).current;
  const rollY = useRef(new Animated.Value(0)).current;
  const rollOpacity = useRef(new Animated.Value(1)).current;
  const prevBadgeRef = useRef(badge);
  useEffect(() => {
    if (!badge) return undefined;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(badgePulse, { toValue: 1.15, duration: 700, useNativeDriver: true }),
      Animated.timing(badgePulse, { toValue: 1, duration: 700, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [badge]);
  useEffect(() => {
    const prev = prevBadgeRef.current;
    if (prev !== badge && (prev || badge)) {
      rollY.setValue(-10);
      rollOpacity.setValue(0);
      Animated.parallel([
        Animated.spring(rollY, { toValue: 0, tension: 280, friction: 14, useNativeDriver: true }),
        Animated.timing(rollOpacity, { toValue: 1, duration: 180, useNativeDriver: true }),
      ]).start();
    }
    prevBadgeRef.current = badge;
  }, [badge, rollY, rollOpacity]);
  // [2026-10-07 apps-menu mono] Founder: manter preto e branco (identidade [MONO]),
  // só mais bonito — ladrilho neutro com borda fina + sombra suave, ícone em tinta.
  const tileBg = isDark ? '#1f2a30' : '#ffffff';
  const glyph = isDark ? '#e9edef' : '#111111';
  const a11y = item.label + (badge ? ', ' + (t('apps.badgeNew', { count: badge > 99 ? '99+' : badge })) : '');
  return (
    <View style={{ width: '25%', paddingVertical: 8 }}>
      <PressableScale
        onPress={onPress}
        scaleTo={0.92}
        haptic="select"
        activeOpacity={0.85}
        style={{ alignItems: 'center', width: '100%' }}
        accessibilityRole="button"
        accessibilityLabel={a11y}
        testID={'apps-tile-' + item.key}
      >
        <View style={{ width: 56, height: 56 }}>
          <View style={{
            width: 56, height: 56, borderRadius: 17,
            backgroundColor: tileBg,
            alignItems: 'center', justifyContent: 'center',
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: isDark ? '#2f3b42' : '#e3e6ea',
            shadowColor: '#000', shadowOpacity: isDark ? 0 : 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
            elevation: isDark ? 0 : 1,
          }}>
            <item.ic.Comp size={26} color={glyph} />
          </View>
          {!!badge && (
            <Animated.View style={{
              position: 'absolute', top: -5, right: -7,
              minWidth: 20, height: 20, paddingHorizontal: 5,
              borderRadius: 10, backgroundColor: isDark ? '#e9edef' : (colors.badge || '#111111'),
              alignItems: 'center', justifyContent: 'center',
              borderWidth: 2, borderColor: isDark ? '#1b2329' : '#f6f7f9',
              transform: [{ scale: badgePulse }],
              overflow: 'hidden',
            }}>
              <Animated.Text
                style={{ color: isDark ? '#111b21' : '#fff', fontSize: 10, fontWeight: '800', transform: [{ translateY: rollY }], opacity: rollOpacity }}
                numberOfLines={1}
              >
                {badge > 99 ? '99+' : String(badge)}
              </Animated.Text>
            </Animated.View>
          )}
        </View>
        <Text
          style={{ fontSize: 12, lineHeight: 15, color: colors.text, fontWeight: '500', textAlign: 'center', marginTop: 7, paddingHorizontal: 2, letterSpacing: -0.1 }}
          numberOfLines={2}
        >
          {item.label}
        </Text>
      </PressableScale>
    </View>
  );
}

// Section header + rounded card holding a 4-col grid of tiles.
function AppsSection({ title, items, badges, onItemPress, colors, isDark, t }) {
  return (
    <View style={{ marginBottom: 16 }} accessibilityRole="none">
      <Text
        style={{ fontSize: 13, fontWeight: '700', color: colors.textSecondary || (isDark ? '#9ca3af' : '#667781'), letterSpacing: 0.2, marginBottom: 8, paddingHorizontal: 6 }}
        accessibilityRole="header"
      >
        {title}
      </Text>
      <View style={{
        flexDirection: 'row', flexWrap: 'wrap',
        backgroundColor: isDark ? 'rgba(255,255,255,0.045)' : '#f6f7f9',
        borderRadius: 22, paddingVertical: 6, paddingHorizontal: 2,
      }}>
        {items.map((it) => (
          <AppTile
            key={it.key}
            item={it}
            badge={badges?.[it.key] || 0}
            onPress={() => onItemPress(it)}
            colors={colors}
            isDark={isDark}
            t={t}
          />
        ))}
      </View>
    </View>
  );
}

const AppsDrawerModal = React.memo(function AppsDrawerModal({ visible, onClose, router, colors, isDark, t, userEmail, onOpenFeed, onOpenReels, onOpenChannels, onOpenCommunities, badges }) {
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState('');
  // MRU + usage counters (local only). Refreshed whenever the drawer opens.
  const [recentKeys, setRecentKeys] = useState(() => _readRecentApps());
  const [usageMap, setUsageMap] = useState(() => _readAppUsage());
  React.useEffect(() => {
    if (visible) {
      setRecentKeys(_readRecentApps());
      setUsageMap(_readAppUsage());
    } else {
      setQ('');
    }
  }, [visible]);

  const I = (Comp, c) => ({ Comp, c });
  const go = useCallback((path) => () => { onClose(); try { router.push(path); } catch (e) { console.warn('[chat] router.push failed:', e); } }, [onClose, router]);

  // Sections. Every key/route/action below existed before except reels/feed.
  // `kw` = extra search keywords (pt/en/es) so "video", "tiktok", "agenda"…
  // find the right app. `featured` items render in the hero card instead of
  // the grid (still searchable + eligible for Recentes).
  const sections = useMemo(() => ([
    {
      key: 'communication',
      title: t('apps.communication'),
      items: [
        { key: 'email',       label: t('apps.email'),        ic: I(IconMail, '#dc2626'),      route: '/inbox',     kw: 'email mail inbox caixa entrada correo' },
        { key: 'meet',        label: t('sidebar.meetings'),  ic: I(IconVideo, '#2563eb'),     route: '/meetings',  kw: 'meet reuniao meeting video chamada call reunion' },
        { key: 'channels',    label: t('channel.title'),     ic: I(IconMegaphone, '#0284c7'), action: onOpenChannels,    kw: 'canais channels canales broadcast' },
        { key: 'communities', label: t('community.title'),   ic: I(IconUsersSmall, '#16a34a'), action: onOpenCommunities, kw: 'comunidades communities grupos groups' },
      ],
    },
    {
      key: 'social',
      title: t('apps.social'),
      items: [
        { key: 'reels',   label: t('apps.reels'),   ic: I(IconReels, '#db2777'),     action: onOpenReels,  kw: 'reels videos curtos shorts tiktok video' },
        { key: 'feed',    label: t('apps.feed'),    ic: I(IconGrid, '#ea580c'),      action: onOpenFeed,   kw: 'feed posts publicacoes timeline' },
        { key: 'live',    label: t('apps.goLive'),  ic: I(IconBroadcast, '#9333ea'), route: '/live-broadcast', kw: 'live ao vivo transmissao stream en vivo' },
        { key: 'snapmap', label: t('snapmap.tile'), ic: I(IconMapPin, '#65a30d'),    route: '/snap-map',   kw: 'mapa map amigos friends localizacao location' },
      ],
    },
    {
      key: 'tools',
      title: t('apps.tools'),
      items: [
        { key: 'one',      label: 'Bia',                  ic: I(IconSparkles, '#111111'), route: '/one', featured: true, kw: 'bia ia ai assistente assistant one' },
        { key: 'calendar', label: t('sidebar.calendar'),  ic: I(IconCalendar, '#6366f1'), route: '/calendar',   kw: 'agenda calendario calendar eventos events' },
        { key: 'contacts', label: t('sidebar.contacts'),  ic: I(IconUsers, '#0d9488'),    route: '/contacts',   kw: 'contatos contacts agenda contactos' },
        { key: 'files',    label: t('sidebar.files'),     ic: I(IconFolder, '#0ea5e9'),   route: '/files',      kw: 'arquivos files cloud drive nuvem archivos' },
        { key: 'docs',     label: t('sidebar.documents'), ic: I(IconFileText, '#2563eb'), route: '/documentos', kw: 'docs documentos documents planilhas sheets' },
        { key: 'notes',    label: t('sidebar.notes'),     ic: I(IconStickyNote, '#d97706'), route: '/notes',    kw: 'notas notes anotacoes' },
        // [2026-10-08 apps-native] /tasks existia (pendentes/concluídas, criada de e-mail) mas não tinha tile.
        { key: 'tasks',    label: t('tasks.title'),       ic: I(IconCheckCircle, '#7c3aed'), route: '/tasks',   kw: 'tarefas tasks todo afazeres pendentes tareas' },
        { key: 'photos',   label: t('sidebar.photos'),    ic: I(IconImage, '#14b8a6'),    route: '/photos',     kw: 'fotos photos galeria gallery imagens' },
      ],
    },
    {
      key: 'account',
      title: t('apps.account'),
      items: [
        { key: 'profile', label: t('sidebar.profile'), ic: I(IconUser, '#475569'), kw: 'perfil profile conta account',
          action: () => { onClose(); if (userEmail) try { router.push(`/u/${encodeURIComponent(userEmail)}`); } catch (e) { console.warn('[chat] router.push failed:', e); } } },
        // [2026-05-22 monetization-pause] wallet tile only when WALLET_ENABLED.
        ...(WALLET_ENABLED ? [{ key: 'wallet', label: t('apps.wallet'), ic: I(IconCreditCard, '#059669'), route: '/wallet', kw: 'carteira wallet saldo pagamentos' }] : []),
        { key: 'notifications', label: t('sidebar.notifications'), ic: I(IconBell, '#f97316'),     route: '/notifications', kw: 'alertas notificacoes notifications' },
        { key: 'backup',        label: t('sidebar.backup'),        ic: I(IconShield, '#0891b2'),   route: '/backup',        kw: 'backup copia seguranca' },
        { key: 'settings',      label: t('sidebar.settings'),      ic: I(IconSettings, '#64748b'), action: go('/settings'), kw: 'configuracoes settings ajustes preferencias' },
      ],
    },
  ]), [t, onOpenFeed, onOpenReels, onOpenChannels, onOpenCommunities, onClose, router, userEmail, go]);

  const qn = _norm(q.trim());
  const sortByUsage = useCallback((items) => {
    const score = (k) => (usageMap?.[k] || 0);
    return [...items].sort((a, b) => score(b.key) - score(a.key));
  }, [usageMap]);
  const filteredSections = useMemo(() => {
    const base = qn
      ? sections.map(s => {
          const secHit = _norm(s.title).includes(qn);
          return { ...s, items: s.items.filter(i => secHit || _norm(i.label).includes(qn) || _norm(i.kw).includes(qn)) };
        })
      : sections.map(s => ({ ...s, items: s.items.filter(i => !i.featured) }));
    return base.filter(s => s.items.length > 0).map(s => ({ ...s, items: sortByUsage(s.items) }));
  }, [qn, sections, sortByUsage]);

  const handlePress = useCallback((it) => {
    try {
      _bumpRecentApp(it.key);
      setUsageMap(_readAppUsage());
    } catch {}
    if (it.action) { it.action(); return; }
    onClose();
    try { router.push(it.route); } catch (e) { console.warn('[chat] router.push failed:', e); }
  }, [onClose, router]);

  const itemByKey = useMemo(() => {
    const m = new Map();
    for (const s of sections) for (const it of s.items) m.set(it.key, it);
    return m;
  }, [sections]);
  const recentItems = useMemo(() => (
    (recentKeys || []).map(k => itemByKey.get(k)).filter(Boolean).slice(0, 4)
  ), [recentKeys, itemByKey]);

  // [2026-10-07 native-ui-build] Sheet nativo: o Modal "slide" arrastava o
  // backdrop JUNTO com o sheet (tell de modal web). Agora: backdrop FADE,
  // sheet sobe com SPRING, arrastar o grabber/cabeçalho p/ baixo fecha
  // (UISheetPresentationController / M3 bottom sheet). Mantém o mount até a
  // animação de saída terminar.
  const _winH = Dimensions.get('window').height || 800;
  const [mounted, setMounted] = useState(!!visible);
  const [openTick, setOpenTick] = useState(0);
  const backdropA = useRef(new Animated.Value(0)).current;
  const sheetY = useRef(new Animated.Value(_winH)).current;
  const dragY = useRef(new Animated.Value(0)).current;
  const sheetHRef = useRef(_winH);
  const closingByDragRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  React.useEffect(() => {
    if (visible) { closingByDragRef.current = false; setMounted(true); setOpenTick(n => n + 1); return; }
    if (!mounted) return;
    if (closingByDragRef.current) { sheetY.setValue(sheetHRef.current); dragY.setValue(0); setMounted(false); return; }
    Animated.parallel([
      Animated.timing(backdropA, { toValue: 0, duration: 180, useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(sheetY, { toValue: sheetHRef.current, duration: 220, useNativeDriver: Platform.OS !== 'web' }),
    ]).start(({ finished }) => { if (finished) setMounted(false); }); // reaberto no meio → não desmonta
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  // Abre DEPOIS do commit do Modal (valores já ligados à view nativa).
  React.useEffect(() => {
    if (!mounted || !visible) return;
    dragY.setValue(0);
    // sheetY/backdropA já estão em "fechado" (init ou fim da saída); se foi
    // reaberto NO MEIO da saída, parte de onde está (sem salto).
    Animated.parallel([
      Animated.timing(backdropA, { toValue: 1, duration: 220, useNativeDriver: Platform.OS !== 'web' }),
      Animated.spring(sheetY, { toValue: 0, tension: 70, friction: 12, useNativeDriver: Platform.OS !== 'web' }),
    ]).start();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, openTick]);
  const dragResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx) * 1.2,
    onPanResponderMove: (_e, g) => { dragY.setValue(Math.max(0, g.dy)); },
    onPanResponderRelease: (_e, g) => {
      if (g.dy > 110 || g.vy > 0.9) {
        closingByDragRef.current = true;
        try { haptic.light?.(); } catch {}
        Animated.parallel([
          Animated.timing(dragY, { toValue: sheetHRef.current, duration: 200, useNativeDriver: Platform.OS !== 'web' }),
          Animated.timing(backdropA, { toValue: 0, duration: 200, useNativeDriver: Platform.OS !== 'web' }),
        ]).start(() => { try { onCloseRef.current?.(); } catch {} });
      } else {
        Animated.spring(dragY, { toValue: 0, tension: 120, friction: 14, useNativeDriver: Platform.OS !== 'web' }).start();
      }
    },
    onPanResponderTerminate: () => {
      Animated.spring(dragY, { toValue: 0, tension: 120, friction: 14, useNativeDriver: Platform.OS !== 'web' }).start();
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);
  const backdropOpacity = Animated.multiply(backdropA, dragY.interpolate({ inputRange: [0, 400], outputRange: [1, 0.35], extrapolate: 'clamp' }));

  if (!mounted) return null;

  const sheetBg = isDark ? '#111b21' : '#ffffff';
  const fieldBg = isDark ? 'rgba(255,255,255,0.07)' : '#f0f2f5';
  const muted = colors.textSecondary || '#667781';

  return (
    <Modal visible={mounted} transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        {/* Backdrop — tap to close. Web gets a light CSS blur. [2026-10-07 native-ui-build] FADE próprio (não sobe com o sheet). */}
        <Animated.View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: backdropOpacity }}>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
          style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: isDark ? 'rgba(8,8,14,0.62)' : 'rgba(10,10,18,0.40)',
            ...(Platform.OS === 'web' ? { backdropFilter: 'blur(6px) saturate(120%)', WebkitBackdropFilter: 'blur(6px) saturate(120%)', cursor: 'default' } : {}),
          }}
        />
        </Animated.View>
        <Animated.View
          onLayout={(e) => { const h = e?.nativeEvent?.layout?.height; if (h > 0) sheetHRef.current = h + 40; }}
          style={{
            transform: [{ translateY: Animated.add(sheetY, dragY) }],
            backgroundColor: sheetBg,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            paddingTop: 8,
            paddingHorizontal: 16,
            maxHeight: '90%',
            ...(Platform.OS === 'web' ? { boxShadow: '0 -8px 32px rgba(0,0,0,0.18)' } : {}),
          }}
          accessibilityViewIsModal
        >
          {/* [2026-10-07 native-ui-build] Grabber + cabeçalho = alça de arrasto
              (a ScrollView dos apps fica livre p/ rolar). */}
          <View {...dragResponder.panHandlers}>
          {/* Grabber */}
          <View style={{ alignItems: 'center', marginBottom: 8, paddingTop: 2, paddingBottom: 2 }}>
            <View style={{ width: 38, height: 5, borderRadius: 3, backgroundColor: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.12)' }} />
          </View>
          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12, paddingHorizontal: 4 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 24, fontWeight: '800', letterSpacing: -0.5, color: colors.text }} accessibilityRole="header">
                {t('chat.apps')}
              </Text>
              <Text style={{ fontSize: 13, color: muted, marginTop: 1 }} numberOfLines={1}>
                {t('apps.subtitle')}
              </Text>
            </View>
            <PressableScale
              onPress={onClose}
              scaleTo={0.9}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={t('common.close')}
              style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: fieldBg, alignItems: 'center', justifyContent: 'center' }}
            >
              <IconClose size={18} color={isDark ? '#c7cdd2' : '#54656f'} />
            </PressableScale>
          </View>
          </View>
          {/* Search */}
          <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: fieldBg, borderRadius: 14, paddingHorizontal: 12, height: 42, marginBottom: 14 }}>
            <IconSearch size={17} color={muted} />
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder={t('apps.searchPlaceholder')}
              placeholderTextColor={isDark ? '#6b7a84' : '#8696a0'}
              style={{ flex: 1, paddingVertical: 0, paddingHorizontal: 8, color: colors.text, fontSize: 15, height: 42, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) }}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
              accessibilityLabel={t('apps.searchPlaceholder')}
            />
            {!!q && (
              <Pressable onPress={() => setQ('')} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('apps.clearSearch')}
                style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: isDark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.22)', alignItems: 'center', justifyContent: 'center' }}>
                <IconClose size={12} color={isDark ? '#111b21' : '#ffffff'} />
              </Pressable>
            )}
          </View>
          <ScrollView
            style={{ flexGrow: 0, flexShrink: 1 }}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 12) + 12 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          >
            {/* Featured — Bia (personal AI). */}
            {!qn && (
              <PressableScale
                onPress={() => { const one = itemByKey.get('one'); if (one) handlePress(one); }}
                scaleTo={0.98}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 14,
                  backgroundColor: isDark ? '#e9edef' : '#111111',
                  borderRadius: 20, paddingVertical: 14, paddingHorizontal: 16, marginBottom: 18,
                }}
                accessibilityRole="button"
                accessibilityLabel={'Bia, ' + t('one.subtitle')}
              >
                <View style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: isDark ? '#111b21' : '#ffffff', alignItems: 'center', justifyContent: 'center' }}>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    <View style={{ width: 5, height: 9, borderRadius: 3, backgroundColor: isDark ? '#e9edef' : '#111111' }} />
                    <View style={{ width: 5, height: 9, borderRadius: 3, backgroundColor: isDark ? '#e9edef' : '#111111' }} />
                  </View>
                </View>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={{ fontSize: 17, fontWeight: '700', color: isDark ? '#111b21' : '#ffffff', letterSpacing: -0.2 }}>Bia</Text>
                    <View style={{ backgroundColor: isDark ? 'rgba(17,27,33,0.12)' : 'rgba(255,255,255,0.20)', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                      <Text style={{ fontSize: 9, fontWeight: '800', letterSpacing: 0.5, color: isDark ? '#111b21' : '#ffffff' }}>AI</Text>
                    </View>
                  </View>
                  <Text style={{ fontSize: 13, color: isDark ? 'rgba(17,27,33,0.7)' : 'rgba(255,255,255,0.75)', marginTop: 2 }} numberOfLines={1}>
                    {t('one.subtitle')}
                  </Text>
                </View>
                <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={isDark ? 'rgba(17,27,33,0.5)' : 'rgba(255,255,255,0.6)'} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                  <Path d="M9 18l6-6-6-6" />
                </Svg>
              </PressableScale>
            )}
            {/* Recentes (MRU) — only when not searching and there is history. */}
            {!qn && recentItems.length > 0 && (
              <AppsSection
                title={t('apps.recent')}
                items={recentItems}
                badges={badges}
                onItemPress={handlePress}
                colors={colors}
                isDark={isDark}
                t={t}
              />
            )}
            {filteredSections.length === 0 ? (
              <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                <View style={{ width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: fieldBg, marginBottom: 10 }}>
                  <IconSearch size={26} color={muted} />
                </View>
                <Text style={{ color: muted, fontSize: 14 }}>{t('apps.noResults')}</Text>
              </View>
            ) : filteredSections.map((section) => (
              <AppsSection
                key={section.key}
                title={section.title}
                items={section.items}
                badges={badges}
                onItemPress={handlePress}
                colors={colors}
                isDark={isDark}
                t={t}
              />
            ))}
          </ScrollView>
        </Animated.View>
      </View>
      </KeyboardAvoidingView>
    </Modal>
  );
});

// ── Desktop sidebar tab item with hover ──
function DesktopTabItem({ tabKey, icon: IconComp, label, active, onPress, isDark, badge, dot }) {
  const { colors } = useTheme();
  const [hovered, setHovered] = useState(false);
  // [2026-10-06 UX] Rail background is near-black on BOTH themes (see
  // desktopRail below), so the active item must be light-on-dark. It used to
  // be '#111111' (brand ink) → icon, label and left border were literally
  // black-on-black: the active "Chats" item rendered as an empty dark square
  // under "Ligações".
  const color = active ? '#ffffff' : 'rgba(255,255,255,0.6)';
  const isWeb = Platform.OS === 'web';

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={[styles.desktopTabItem, {
        backgroundColor: active
          ? 'rgba(255,255,255,0.12)'
          : hovered
            ? 'rgba(255,255,255,0.06)'
            : 'transparent',
        borderLeftColor: active ? '#ffffff' : 'transparent',
        cursor: 'pointer',
        ...(isWeb ? { transition: 'all 0.2s cubic-bezier(0.4,0,0.2,1)' } : {}),
      }]}
    >
      <View style={{ position: 'relative' }}>
        <IconComp size={22} color={color} active={active} />
        {badge > 0 && <PulseBadge badge={badge} isDark={isDark} />}
        {!badge && dot && (
          <View style={{
            position: 'absolute', top: -2, right: -2,
            width: 8, height: 8, borderRadius: 4,
            backgroundColor: colors.badge,
            borderWidth: 1.5, borderColor: '#0f1115',
          }} />
        )}
      </View>
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
// 2026-05-13 hotfix: drives transform.scale only — native-compatible. Flipping
// useNativeDriver to true removes any chance of cross-driver leakage with the
// surrounding TabBarItem animations and frees the JS thread on cold start.
function PulseBadge({ badge, isDark }) {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const isWeb = Platform.OS === 'web';

  useEffect(() => {
    // [2026-10-07 app-feel-nav] Badge de aba nativo é ESTÁTICO (UITabBarItem /
    // Material Badge). Pulso infinito 1.2x = cara de site + gasta frame.
    // Agora: um "pop" curto só quando o número muda.
    if (Platform.OS !== 'web' && badge > 0) {
      pulseAnim.setValue(0.85);
      Animated.spring(pulseAnim, { toValue: 1, useNativeDriver: true, tension: 300, friction: 12 }).start();
      return;
    }
    if (badge > 0) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.2, duration: 800, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
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
    }]}>
      <Text style={styles.badgeText}>{badge > 99 ? '99+' : badge}</Text>
    </Animated.View>
  );
}

// ── Mobile tab bar item with dot indicator ──
function TabBarItem({ icon, label, active, onPress, isDark, badge, dot }) {
  const { colors } = useTheme();
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const bounceAnim = useRef(new Animated.Value(0)).current;
  // [beauty 2026-10-01] Removed the dead `glowAnim` — it ran a 220ms JS-thread
  // (non-native) timing on every activation but was never referenced in the
  // JSX, so it was pure wasted work on the exact frame the new tab paints.
  const isWeb = Platform.OS === 'web';

  useEffect(() => {
    if (active) {
      Animated.sequence([
        Animated.spring(bounceAnim, { toValue: -3, useNativeDriver: true, tension: 400, friction: 10 }),
        Animated.spring(bounceAnim, { toValue: 0, useNativeDriver: true, tension: 260, friction: 14 }),
      ]).start();
    }
  }, [active]);

  const handlePressIn = () => {
    Animated.spring(scaleAnim, { toValue: 0.9, useNativeDriver: true, tension: 400, friction: 28 }).start();
  };
  const handlePressOut = () => {
    Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, tension: 260, friction: 14 }).start();
  };

  // [2026-10-07 app-feel-nav] Pressable nativo: ripple Material no Android,
  // role=tab + selected (VoiceOver/TalkBack anunciam "aba, selecionada"),
  // haptic leve em TODO toque (antes só na troca real de aba; Email/Apps mudos).
  const handlePress = () => {
    if (!active && Platform.OS !== 'web') { try { haptic.select(); } catch {} }
    onPress && onPress();
  };
  return (
    <Pressable
      style={styles.tabItem}
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      accessibilityRole="tab"
      accessibilityState={{ selected: !!active }}
      accessibilityLabel={typeof label === 'string' ? (badge > 0 ? `${label}, ${badge}` : label) : undefined}
      android_ripple={Platform.OS === 'android' ? { borderless: true, radius: 34, color: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)' } : undefined}
      hitSlop={4}
    >
      <Animated.View style={[styles.tabIconWrap, {
        transform: [{ scale: scaleAnim }, { translateY: bounceAnim }],
        backgroundColor: 'transparent',
      }]}>
        {icon(active)}
        {badge > 0 && <PulseBadge badge={badge} isDark={isDark} />}
        {!badge && dot && (
          <View style={{
            position: 'absolute', top: 2, right: 2,
            width: 8, height: 8, borderRadius: 4,
            backgroundColor: colors.badge,
            borderWidth: 1.5, borderColor: isDark ? '#0f1115' : '#ffffff',
          }} />
        )}
      </Animated.View>
      <Text selectable={false} numberOfLines={1} maxFontSizeMultiplier={1.3} style={[styles.tabLabel, {
        color: active ? ACCENT : (isDark ? '#6b7280' : '#9ca3af'),
        fontWeight: active ? '700' : '500',
        ...(isWeb ? { transition: 'color 0.18s ease' } : {}),
      }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  // Header (mobile) — 2026 premium (compact + soft drop shadow)
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 11,
    paddingBottom: 11,
    minHeight: 54,
    zIndex: 10,
    // [2026-10-07 app-feel-nav] Sem sombra/elevation: UINavigationBar e o
    // Material 3 top app bar são CHAPADOS com só a hairline (já vem do
    // glassHeader). Sombra embaixo do header = visual de site/card.
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
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  headerIconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? { transition: 'background-color 0.2s ease, transform 0.15s cubic-bezier(0.34,1.56,0.64,1)', cursor: 'pointer' } : {}),
  },
  headerAccentBtn: {
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  // WhatsApp-parity filled green "new chat" circle.
  headerPlusGreen: {
    backgroundColor: WA_GREEN,
    marginLeft: 2,
    ...Platform.select({
      ios: { shadowColor: WA_GREEN, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.3, shadowRadius: 4 },
      android: { elevation: 2 },
      web: { boxShadow: '0 1px 5px rgba(37,211,102,0.4)' },
      default: {},
    }),
  },
  // [2026-10-07 native-ui-build] título compacto (aparece quando o large
  // title rola por baixo do header) — 17pt semibold centrado, UINavigationBar.
  compactTitleWrap: {
    position: 'absolute', left: 96, right: 96, top: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  compactTitle: {
    fontSize: 17, fontWeight: '600', letterSpacing: -0.3, textAlign: 'center',
  },
  headerHairline: {
    position: 'absolute', left: 0, right: 0, bottom: 0, height: StyleSheet.hairlineWidth,
  },
  // WhatsApp iOS large title ("Conversas") — big, bold, left-aligned.
  bigTitle: {
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: -0.9,
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
    height: 42,
    borderRadius: 21,
    paddingHorizontal: 14,
    gap: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    fontWeight: '400',
    letterSpacing: -0.1,
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
    // [2026-10-07 app-feel-nav] iOS: 49pt de conteúdo (UITabBar); era ~66.
    paddingTop: Platform.OS === 'ios' ? 5 : 10,
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
    marginTop: 3,
    fontWeight: '500',
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
      web: { backgroundColor: ACCENT },
      ios: { backgroundColor: ACCENT },
      android: { backgroundColor: ACCENT, elevation: 1 },
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
