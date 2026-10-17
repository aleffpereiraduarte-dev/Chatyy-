import React, { useState, useRef, useEffect, useCallback, useMemo, Suspense } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform, Animated, Dimensions, TextInput, Modal, Pressable, KeyboardAvoidingView, AppState, PanResponder, DeviceEventEmitter } from 'react-native';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
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
import { isReduceMotionEnabled } from '../components/reducedMotion';
import { SearchReveal, searchRevealEnabled } from '../components/chatlist/SearchReveal'; // [2026-10-16 motion-nav] busca abre c/ mola na UI thread
import Svg, { Circle as SvgCircle, Path, Rect, Line, Defs, LinearGradient, Stop } from 'react-native-svg';
// [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag
import { WALLET_ENABLED } from '../constants/featureFlags';
import { haptic } from '../constants/theme';
import { setActiveInterval } from '../utils/activeInterval'; // [2026-10-10 perf-battery]
import ChatListTab from '../components/ChatListTab';
import { IS_TABLET_DEVICE } from '../utils/responsive'; // [2026-10-10 tablet-split]
import AvatarCircle from '../components/AvatarCircle';
// Heavy non-default tabs — code-split via React.lazy so cold start doesn't pay
// the ChatStatusTab (4.5k LOC), ChatFeedTab, ChannelsTab, CommunitiesTab, kids
// tabs parse cost upfront. Each chunk only loads when the user actually opens
// the tab. [2026-10-11 boot-split] ChatCallsTab is lazy too now: the badge
// helpers (getCallHistoryCached/markMissedCallsRead) live in
// services/callHistoryStore, so the 4k-LOC tab only loads on first open.
const ChatCallsTab = React.lazy(() => import('../components/ChatCallsTab'));
const ChatFeedTab = React.lazy(() => import('../components/ChatFeedTab'));
const ChatStatusTab = React.lazy(() => import('../components/ChatStatusTab'));
const ChannelsTab = React.lazy(() => import('../components/ChannelsTab'));
const CommunitiesTab = React.lazy(() => import('../components/CommunitiesTab'));
const KidsLearnTab = React.lazy(() => import('../components/KidsLearnTab'));
const KidsTVTab = React.lazy(() => import('../components/KidsTVTab'));
// [reels-v1 2026-10-13] Aba Reels (tela cheia, ranking do servidor) — lazy: só monta ao abrir.
const ReelsHomeTab = React.lazy(() => import('../components/ReelsHomeTab'));
// [2026-10-14 perf] 1º toque em Ligações/Reels: o lazy suspendia → skeleton e o
// React 19 segura a revelação ≥300 ms. Resolve os 2 lazies em idle após a 1ª
// pintura da lista (Ligações ~25 KB gz na web; Reels ~1 KB) → troca de aba sem espera.
try {
  require('../services/bootTrace').afterFirstPaint(() => {
    try { require('../services/webRoutePrewarm').prewarmLazyComponents([ChatCallsTab, ReelsHomeTab]); } catch {}
  }, 2500);
} catch {}
// [2026-10-13 sync-status] SyncBar (faixa no topo) saiu da home: o status de
// sincronização agora troca o TÍTULO ("Conversas" → "Conectando…"), padrão
// WhatsApp, via services/syncStatus.js (fonte única). SyncBar segue na conversa.
import SyncStatusTitle from '../components/SyncStatusTitle';
import { claimHomeSyncSurface } from '../services/syncStatus';
import { trackScreenView } from '../services/analytics'; // [2026-10-15 tab-telemetry]
import { CallListSkeleton } from '../components/SkeletonLoader'; // [2026-10-11 boot-split] lazy Calls fallback
import { isSyncComplete, runInitialSync } from '../services/initialSync';
import PlusOnboardingTour, { checkShouldShowPlusOnboarding } from '../components/PlusOnboardingTour';
import GlobalSearch from '../components/GlobalSearch';
import FirstRunGate from '../components/onboarding/FirstRunGate'; // [2026-10-07 welcome]
import { BarMaterial, canNativeBlur } from '../components/NativeBlur'; // [2026-10-07 native-ui-build]
import NativeHomeTabBar, { nativeTabsAvailable } from '../components/NativeHomeTabBar'; // [2026-10-15 native-tabs]
import { useCollapsedTitleAnim } from '../components/LargeTitleHeader'; // [2026-10-15 nav-motion]
import { USE_NATIVE_SHEETS, NativeSheet, NativeSheetKeyboardView, nativeSheetBottomPad } from '../components/NativeSheet'; // [2026-10-15 native-sheets-v2]
import AppsDrawerModal from '../components/apps/AppsSheet'; // [2026-10-15 apps-v3]
import HomeDiscoverPills from '../components/home/HomeDiscoverPills'; // [2026-10-16 wave12-c]

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
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={active ? color : 'none'} stroke={color} strokeWidth={active ? 1.6 : 1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z" />
    </Svg>
  );
}

// [reels-v1 2026-10-13] Reels: quadro arredondado com faixa de claquete + play (mesma família
// de traço dos outros ícones da barra; play preenchido quando ativo).
function IconReelsTab({ size = 24, color = '#666', active }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={active ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="3" y="3" width="18" height="18" rx="5" />
      <Line x1="3" y1="8.5" x2="21" y2="8.5" />
      <Line x1="9" y1="3.2" x2="11.5" y2="8.5" />
      <Line x1="14.5" y1="3.2" x2="17" y2="8.5" />
      <Path d="M10.5 12.2v5.1l4.2-2.55z" fill={active ? color : 'none'} />
    </Svg>
  );
}

function IconChatsTab({ size = 24, color = '#666', active }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={active ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" fill={active ? color : 'none'} />
      {/* [2026-10-13 design-system] ativo = balão PREENCHIDO (sem as linhas) */}
      {!active && <Line x1="8" y1="9" x2="16" y2="9" stroke={color} strokeWidth="1.5" />}
      {!active && <Line x1="8" y1="13" x2="13" y2="13" stroke={color} strokeWidth="1.5" />}
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
    // [2026-10-13 design-system] Era uma grade de 9 bolinhas cheias (pesada,
    // destoava do traço fino dos outros ícones). Agora 2x2 quadrados
    // arredondados no mesmo traço; preenchidos quando ativo.
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={active ? color : 'none'} stroke={color} strokeWidth={1.8} strokeLinejoin="round">
      <Rect x="3.5" y="3.5" width="7" height="7" rx="2" />
      <Rect x="13.5" y="3.5" width="7" height="7" rx="2" />
      <Rect x="3.5" y="13.5" width="7" height="7" rx="2" />
      <Rect x="13.5" y="13.5" width="7" height="7" rx="2" />
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
  state = { error: null, resetKey: this.props.resetKey };
  static getDerivedStateFromError(error) { return { error }; }
  // [2026-10-09 tf653-status] Um erro na superfície OCULTA do status (aba
  // montada fora da tela) virava fallback invisível e nenhum status/compositor
  // abria mais até reiniciar o app — sem log nenhum. Agora: reporta (push_diag)
  // e um NOVO pedido (resetKey muda) remonta a superfície.
  static getDerivedStateFromProps(props, state) {
    if (props.resetKey !== state.resetKey) return { resetKey: props.resetKey, error: null };
    return null;
  }
  componentDidCatch(error, info) {
    try {
      require('../services/crashReporter').reportCrash({
        type: 'render_error',
        context: String(this.props.name || 'chat').slice(0, 30),
        message: String(error?.message || error).slice(0, 200),
        stack: (error?.stack || '') + ' | ' + String(info?.componentStack || '').slice(0, 300),
      });
    } catch {}
  }
  render() {
    if (this.state.error) {
      return <ChatErrorFallback error={this.state.error} />;
    }
    return this.props.children;
  }
}

// [2026-10-09 tf653-status] Superfície do status (ChatStatusTab) fica montada
// FORA DA TELA e só serve de host p/ os <Modal> do viewer/câmera. Antes era
// `display:'none'`: no Fabric (iOS/Android, nova arquitetura) o Yoga não faz
// layout de NENHUM descendente de um nó display:none — o <Modal> até monta,
// mas o conteúdo fica 0×0/sem layout → tocar no status "não abre nada". No web
// display:none é inofensivo (portal DOM) e continua. Nativo: caixa 0×0
// absoluta, recortada e invisível — os descendentes recebem layout normal e o
// Modal (janela/VC própria) aparece por cima.
const _STATUS_SURFACE_HIDDEN = Platform.OS === 'web'
  ? { display: 'none' }
  : { position: 'absolute', left: 0, top: 0, width: 0, height: 0, overflow: 'hidden', opacity: 0 };
const _STATUS_SURFACE_ACTIVE = { display: 'flex', flex: 1 };
function _statusSurfaceStyle(active) { return active ? _STATUS_SURFACE_ACTIVE : _STATUS_SURFACE_HIDDEN; }

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
// [2026-10-08 chat-beauty-list] B&W shell tokens (header / tab bar).
const SHELL_DARK = '#0b0b0b';
const TAB_ON_LIGHT = '#0b0b0b';
const TAB_ON_DARK = '#f5f5f5';
// [2026-10-13 design-system] inativos com contraste AA (era #9a9a9e 2.8:1 /
// #7c7c80) — o estado ativo agora se distingue por ícone PREENCHIDO + pílula.
const TAB_OFF_LIGHT = '#6e6e73';
const TAB_OFF_DARK = '#8e8e93';
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
// [reels-v1 2026-10-13 founder] Reels VOLTA pra barra, no centro (Instagram): "as pessoas gostam
// de scroll". Ordem: Conversas · Email · Reels · Ligações · Apps.
const TAB_KEYS_FULL = ['chats', 'email', 'reels', 'calls', 'apps'];
// Desktop keeps the classic email-hub layout — user asked for it to stay as-is.
// Profile is no longer a chat tab — tap the avatar in the header to reach
// /u/{email}. Keeps a single profile surface across the whole app.
// [2026-10-12 chatlist-polish] Conversas first (WhatsApp Web rail order).
const TAB_KEYS_DESKTOP = ['chats', 'calls', 'feed'];
const TAB_KEYS_KIDS = ['chats', 'learn', 'tv'];

// Gradient brand title for "Chatyy" (web only renders as two-tone, native as well)
function BrandTitle({ colors, size = 22, light }) {
  const { t } = useLanguage();
  return (
    <View style={styles.brandWrap}>
      {isChildAccount() ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
            <Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill={colors.primary} opacity={0.9} />
            <Path d="M9 12l2 2 4-4" stroke="#fff" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
          <Text style={[styles.brandTitle, { color: colors.text, fontSize: size }]}>Chatyy</Text>
          <View style={{ backgroundColor: '#111111', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 }}>
            <Text style={{ color: '#fff', fontSize: size - 6, fontWeight: '800' }}>{t('kids.brandBadge') || 'Kids'}</Text>
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
  // [2026-10-08 reels-publish] retoma reels que ficaram publicando quando o app
  // foi fechado (fila durável no nativo). Atrasado p/ não competir com o boot.
  useEffect(() => {
    if (!user?.email || Platform.OS === 'web') return undefined;
    const id = setTimeout(() => {
      try { require('../services/reelPublishQueue').resumeReelPublishes(user.email); } catch {}
      try { require('../services/videoStudio/renderQueue').resumeStudioRenders(); } catch {} // [2026-10-13 video-studio]
    }, 6000);
    return () => clearTimeout(id);
  }, [user?.email]);
  // Valid tabs — anything else (legacy 'config'/'settings' deep links) falls back to 'chats' to avoid a blank page.
  // [2026-10-01 STATUS CONSOLIDATION] 'status' is NO LONGER a navigable full-screen
  // tab. The separate (ugly, redundant) Status screen is retired: status now lives
  // ONLY in the feed/chat-list stories strip, which opens ChatStatusTab's StoryViewer
  // + composer as portaled Modals (via requestOpenStatus / requestNewStatus) floating
  // over the current tab — never as a visible tab body. A `?tab=status` deep-link
  // therefore falls back to 'chats' (which still shows the stories strip); the
  // composer deep-link (`?new=1`) still mounts the hidden status surface below.
  const VALID_TABS = ['chats','calls','feed','learn','tv','channels','communities','reels'];
  // ?tab=reels / ?tab=apps are special — they trigger handleTabPress side-effects
  // (setPendingReels+goto feed / openAppsDrawer) instead of mapping 1:1 to a
  // renderable tab. We start on 'chats' and let a useEffect below dispatch them.
  // [2026-10-11 social-qa] ?tab=reels used to fall through to 'chats' (the
  // dispatch effect mentioned above never existed). Now 'reels' starts on the
  // feed tab already in reels mode; 'apps'/'email'/'one' are dispatched by the
  // ?tab= effect further below (also handles param changes while mounted).
  const _tabParam = typeof params.tab === 'string' ? params.tab : '';
  // [reels-v1 2026-10-13] Reels é aba própria no celular; desktop/Kids seguem no modo reels do Feed.
  const _reelsIsTab = !isKids && !(Platform.OS === 'web' && Dimensions.get('window').width >= DESKTOP_BREAKPOINT);
  const _initialTab = _tabParam === 'reels' ? (_reelsIsTab ? 'reels' : 'feed') : (VALID_TABS.includes(_tabParam) && (_tabParam !== 'reels') ? _tabParam : 'chats');
  // Composer deep-link (`?new=1`, from the share sheet / UnifiedComposeFab /
  // notifications) needs the hidden status surface mounted so ChatStatusTab's
  // camera composer Modal can open over the current tab on first mount.
  const _wantsStatusComposer = params.new === '1';
  const [activeTab, setActiveTab] = useState(_initialTab);
  // [2026-10-13 sync-status] Home focada na aba Conversas = o título já diz
  // "Aguardando rede"/"Conectando…" → OfflineNotice raiz não pinta 2ª faixa.
  useFocusEffect(useCallback(() => (activeTab === 'chats' ? claimHomeSyncSurface() : undefined), [activeTab]));
  const [mountedTabs, setMountedTabs] = useState(() => {
    const s = new Set(['chats', _initialTab]); // lazy mount: include initial tab to avoid white screen on deep-link
    if (_wantsStatusComposer) s.add('status');
    return s;
  });
  // [2026-10-14 perf] Aba lazy montada → quando o chunk resolver, 1 re-render normal
  // da home. Sem isso o <Suspense> da aba podia ficar preso no fallback (web, após
  // reload: Ligações em skeleton >15 s) e, no melhor caso, pagava o throttle de
  // 300 ms do React 19. Inócuo quando o lazy já está pronto (não re-renderiza).
  const [, _setLazyTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const LAZY = { calls: ChatCallsTab, feed: ChatFeedTab, status: ChatStatusTab, channels: ChannelsTab, communities: CommunitiesTab, learn: KidsLearnTab, tv: KidsTVTab, reels: ReelsHomeTab };
    try {
      const { whenLazyReady } = require('../services/webRoutePrewarm');
      mountedTabs.forEach((k) => {
        const l = LAZY[k];
        if (!l || (l._payload && l._payload._status === 1)) return;
        whenLazyReady(l).then((ok) => { if (ok && alive) _setLazyTick((n) => n + 1); }, () => {});
      });
    } catch {}
    return () => { alive = false; };
  }, [mountedTabs]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchAnim = useRef(new Animated.Value(0)).current;
  // [2026-10-16 motion-nav] Nativo c/ Reanimated: a barra abre/fecha por
  // components/chatlist/SearchReveal (mola na UI thread, interrompível);
  // searchShown = alvo da mola, searchOpen continua = "barra montada" (cai p/
  // false quando a mola de fechar termina). Kill switch: __chatyy_motion_search=false.
  const [searchShown, setSearchShown] = useState(false);
  const _searchRea = Platform.OS !== 'web' && searchRevealEnabled();
  const _onSearchHidden = useCallback(() => { setSearchOpen(false); }, []);

  // Universal search overlay (search_global backend) — opens via "Buscar tudo"
  // chip dentro da search bar local; vai além do chat e procura emails, posts,
  // users, files numa única tela.
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);

  // Plus onboarding tour: 1ª vez que detecta plan='one'/'plus' depois do
  // upgrade, abre um tour de 5 slides explicando o que desbloqueou. AsyncStorage
  // guarda o flag pra não mostrar de novo. Delay de 1.2s pra deixar a tela
  // assentar antes do modal aparecer.
  // [2026-10-16 wave12-c] Só depois do 1º uso REAL (1ª mensagem enviada ou 3ª
  // abertura da home, e first-run concluído) — nunca por cima do 1º contato.
  const [showPlusTour, setShowPlusTour] = useState(false);
  const _plusTourEmail = String(user?.email || '').toLowerCase();
  useEffect(() => {
    if (!_plusTourEmail) return undefined;
    let cancelled = false;
    let stopWatch = null;
    const { noteHomeOpen, isPastFirstUse, watchFirstMessageSent } = require('../components/onboarding/firstUse');
    const tryShow = async () => {
      try {
        if (cancelled || !(await isPastFirstUse(_plusTourEmail))) return false;
        const should = await checkShouldShowPlusOnboarding();
        if (!cancelled && should) setShowPlusTour(true);
      } catch {}
      return true;
    };
    const tm = setTimeout(async () => {
      try { await noteHomeOpen(_plusTourEmail); } catch {}
      if (cancelled) return;
      const past = await tryShow();
      // Só registra: a 1ª mensagem sai de dentro da conversa e o tour não pode
      // abrir por cima dela — aparece na próxima abertura da home.
      if (!past && !cancelled) stopWatch = watchFirstMessageSent(_plusTourEmail);
    }, 1200);
    return () => { cancelled = true; clearTimeout(tm); try { stopWatch?.(); } catch {} };
  }, [_plusTourEmail]);

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
  // [2026-10-11 visual polish] Start on the INITIAL tab (deep links like
  // /chat?tab=calls), not always 'chats' — the bar showed Ligações active with
  // the indicator still parked under Conversas.
  const indicatorAnim = useRef(new Animated.Value(
    TAB_KEYS.indexOf(_initialTab) >= 0 ? TAB_KEYS.indexOf(_initialTab) : TAB_KEYS.indexOf('chats')
  )).current;
  // Keep the indicator in sync when the tab changes without handleTabPress
  // (tabProps.setActiveTab from child tabs). Same target value → no-op spring.
  useEffect(() => {
    const i = TAB_KEYS.indexOf(activeTab);
    if (i >= 0) Animated.spring(indicatorAnim, { toValue: i, useNativeDriver: true, tension: 120, friction: 16 }).start();
  }, [activeTab, TAB_KEYS, indicatorAnim]);
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
  // [2026-10-16 motion-telegram] Conversas usa a MESMA mola (e Reduzir
  // Movimento) do título compacto de Ligações/Status — antes timing 160ms linear.
  const [chatTitleAnim, onChatTitleCollapse] = useCollapsedTitleAnim();
  // [2026-10-16 wave12-c] Atalhos Comunidades/Canais moram no espaço livre do
  // header e saem de cena quando o título compacto entra (lista rolada).
  const [chatTitleCollapsed, setChatTitleCollapsed] = useState(false);
  const onChatTitleCollapseHome = useCallback((c) => {
    onChatTitleCollapse(c);
    setChatTitleCollapsed(!!c);
  }, [onChatTitleCollapse]);
  const discoverPillsOpacity = useMemo(() => chatTitleAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }), [chatTitleAnim]);
  // [2026-10-16 wave8-list] Lista nativa (api 3) com o header POR CIMA: as
  // conversas rolam por baixo de um vidro NATIVO (UIVisualEffectView / blur
  // RenderEffect no Android 12+) que a própria lista desenha no topo — o
  // ChatListTab avisa quando dá (onNativeTopBar) e aqui o header fica
  // transparente e a lista sobe por baixo dele (topOverlayInset).
  const [homeTopBar, setHomeTopBar] = useState(false);
  const [homeHeaderH, setHomeHeaderH] = useState(0);
  const onHomeHeaderLayout = useCallback((e) => {
    const h = Math.round(e?.nativeEvent?.layout?.height || 0);
    setHomeHeaderH(prev => (prev === h ? prev : h));
  }, []);
  // Título compacto sobe 6px enquanto aparece (Telegram/UINavigationBar) — só
  // transform/opacity no native driver, interpolação memoizada por valor.
  const _ctMotionCache = useRef(new Map()).current;
  const _compactTitleMotion = (anim) => {
    let st = _ctMotionCache.get(anim);
    if (!st) {
      st = { opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [6, 0], extrapolate: 'clamp' }) }] };
      _ctMotionCache.set(anim, st);
    }
    return st;
  };
  // [2026-10-15 nav-motion] Mesmo título grande colapsável nas abas Ligações e
  // Status (components/LargeTitleHeader.js). Cada aba tem o seu valor (o
  // scroll de cada uma é preservado ao trocar de aba).
  const [callsTitleAnim, onCallsTitleCollapse] = useCollapsedTitleAnim();
  const [statusTitleAnim, onStatusTitleCollapse] = useCollapsedTitleAnim();
  const _ltTab = LIST_LARGE_TITLE && !isKids && (activeTab === 'calls' || activeTab === 'status') ? activeTab : null;
  // Tab bar de VIDRO no iOS (UIVisualEffectView via expo-blur): fica absoluta
  // sobre o conteúdo e a lista de conversas rola por baixo (bottomInset).
  // Android/web/binário sem expo-blur: barra sólida no fluxo, como antes.
  const GLASS_TAB_BAR = Platform.OS === 'ios' && canNativeBlur();
  const [tabBarH, setTabBarH] = useState(0);
  const onTabBarLayout = useCallback((e) => {
    const h = Math.round(e?.nativeEvent?.layout?.height || 0);
    setTabBarH(prev => (prev === h ? prev : h));
  }, []);
  // [2026-10-15 native-tabs] Barra inferior NATIVA (UITabBar / barra M3 em
  // Views) — components/NativeHomeTabBar + modules/expo-native-tabbar. Só
  // celular não-Kids com o módulo no binário; kill switch
  // globalThis.__chatyy_native_tabs = false → barra JS (TabBarItem) de antes.
  // Mesmo comportamento: badge de Conversas/Email/Ligações, Email abre /inbox
  // (nunca fica marcada), segurar Conversas = câmera do status.
  const NATIVE_TABS = useMemo(() => !isKids && nativeTabsAvailable(), [isKids]);
  const nativeTabItems = useMemo(() => {
    if (!NATIVE_TABS) return null;
    return [
      { key: 'chats', label: t('chat.tabChats') || 'Chats', sfSymbol: 'bubble.left.and.bubble.right', sfSymbolActive: 'bubble.left.and.bubble.right.fill', androidIcon: 'chats', badge: chatsBadge || 0, longPress: true },
      { key: 'email', label: t('chat.tabEmail') || 'Email', sfSymbol: 'envelope', sfSymbolActive: 'envelope.fill', androidIcon: 'email', badge: emailBadge || 0, selectable: false },
      { key: 'reels', label: t('reels.title') || 'Reels', sfSymbol: 'play.rectangle', sfSymbolActive: 'play.rectangle.fill', androidIcon: 'reels' },
      { key: 'calls', label: t('chat.tabCalls') || 'Ligações', sfSymbol: 'phone', sfSymbolActive: 'phone.fill', androidIcon: 'calls', badge: missedCallBadge || 0 },
      { key: 'apps', label: t('chat.tabApps') || 'Apps', sfSymbol: 'square.grid.2x2', sfSymbolActive: 'square.grid.2x2.fill', androidIcon: 'apps' },
    ];
  }, [NATIVE_TABS, t, chatsBadge, emailBadge, missedCallBadge]);

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
        const { getCallHistoryCached } = require('../services/callHistoryStore');
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
        // [2026-10-17 sem-pstn] ligações de telefone (PSTN) não contam no badge.
        let _skipPstn = null;
        try {
          if (!require('../constants/featureFlags').isPstnEnabled()) _skipPstn = require('../services/chatyyOnlyCalls').isPstnHistoryRow;
        } catch {}
        count = (cached || []).reduce((acc, c) => {
          if (c?.type !== 'missed') return acc;
          if (_skipPstn && _skipPstn(c)) return acc;
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
        const { markMissedCallsRead } = require('../services/callHistoryStore');
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
  const badgeLastRefreshRef = useRef(0);
  const badgeEmailRef = useRef(null);
  React.useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      badgeLastRefreshRef.current = Date.now();
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
    // [2026-10-10 perf] Was: refresh() at t=0 on mount (status_list + a
    // 20-post feed_list + chat_list racing the chat list's cold start) AND on
    // EVERY tab switch, with the 60 s loop also running in background.
    // Now: first run 1.5 s after mount, tab switches refresh only if the last
    // run is >= 15 s old, and the loop pauses while backgrounded.
    let firstTimer = null;
    if (badgeEmailRef.current !== (user?.email || '')) {
      // account switch → behave like a fresh mount (no stale badges).
      badgeEmailRef.current = user?.email || '';
      badgeLastRefreshRef.current = 0;
    }
    const last = badgeLastRefreshRef.current;
    if (!last) firstTimer = setTimeout(refresh, 1500);
    else if (Date.now() - last >= 15000) refresh();
    const stopPoll = setActiveInterval(refresh, 60000);
    return () => { cancelled = true; if (firstTimer) clearTimeout(firstTimer); stopPoll(); };
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

  // [2026-10-15 unread-instant] Aba "Conversas" segue o estado LOCAL da lista
  // (services/unreadBadge) na hora — antes só o poll de 60 s a atualizava, então
  // ler uma conversa (aqui, pela notificação ou em outro aparelho) deixava o
  // número velho na aba por até 1 min.
  React.useEffect(() => {
    if (activeTab === 'chats') return undefined;
    let ub = null;
    try { ub = require('../services/unreadBadge'); } catch { return undefined; }
    try { const cur = ub.getLocalUnreadTotal(); if (cur != null) setChatsBadge(cur); } catch {}
    return ub.subscribeUnreadTotal((n) => { try { setChatsBadge(Math.max(0, Number(n) || 0)); } catch {} });
  }, [activeTab]);

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
    // [2026-10-15 ws-badge] Era HTTP a cada 60 s. O hub já avisa e-mail novo no
    // canal `mail_{email}` (MailContext assina) → reconta no aviso (debounce) e
    // ao (re)autenticar o WS (cobre o que chegou desconectado). O poll vira
    // rede de segurança de 5 min, só com o app em primeiro plano.
    let wsRecount = null;
    const scheduleRecount = (ms) => { if (wsRecount) clearTimeout(wsRecount); wsRecount = setTimeout(fetchEmailUnread, ms); };
    let offWsNew = null; let offWsConn = null;
    try {
      const ws = require('../services/websocket').default;
      offWsNew = ws.on('new_email', () => scheduleRecount(1500));
      offWsConn = ws.on('connection', (ev) => { if (ev && ev.status === 'authenticated') scheduleRecount(800); });
    } catch {}
    const stopPoll = setActiveInterval(fetchEmailUnread, 300000);
    timer = null;
    // [2026-10-11] Abriu/marcou e-mail → o número baixa NA HORA e é recontado
    // quando o servidor confirma (antes só mudava no próximo ciclo de 60s).
    let recount = null;
    const sub = DeviceEventEmitter.addListener('mail:unread-changed', (ev) => {
      if (ev && ev.delta < 0) setEmailBadge(n => Math.max(0, n + ev.delta));
      if (ev && ev.synced) { if (recount) clearTimeout(recount); recount = setTimeout(fetchEmailUnread, 400); }
    });
    // Voltou para o app → reconta.
    const appSub = AppState.addEventListener('change', (st) => { if (st === 'active') fetchEmailUnread(); });
    return () => {
      cancelled = true; if (timer) clearInterval(timer); if (recount) clearTimeout(recount);
      if (wsRecount) clearTimeout(wsRecount);
      try { stopPoll(); } catch {} try { offWsNew && offWsNew(); } catch {} try { offWsConn && offWsConn(); } catch {}
      try { sub.remove(); } catch {} try { appSub.remove(); } catch {}
    };
  }, []);

  const _tabSettleDirRef = useRef(null); // [2026-10-16 pisca] direção pendente do assentamento da aba
  React.useLayoutEffect(() => {
    const dir = _tabSettleDirRef.current;
    if (dir == null) return;
    _tabSettleDirRef.current = null;
    // [2026-10-16 motion-nav] Reduzir Movimento: troca de aba seca (sem
    // deslize/esmaecer), como o push vira dissolve no _layout.
    if (isReduceMotionEnabled()) { contentOpacity.setValue(1); contentTranslateX.setValue(0); return; }
    contentOpacity.setValue(0.6);
    contentTranslateX.setValue(dir * 16);
    Animated.parallel([
      Animated.spring(contentOpacity, { toValue: 1, useNativeDriver: true, tension: 100, friction: 18 }),
      Animated.spring(contentTranslateX, { toValue: 0, useNativeDriver: true, tension: 100, friction: 18 }),
    ]).start();
  }, [activeTab, contentOpacity, contentTranslateX]);

  const handleTabPress = useCallback((tab) => {
    // "Apps" is a drawer overlay — it doesn't switch tabs, so we keep the
    // chats tab active underneath and just open the modal.
    if (tab === 'apps') { setShowAppsDrawer(true); return; }
    // "One" is the AI assistant screen — full navigation, not an inline tab.
    if (tab === 'one') { try { router.push('/one'); } catch (e) { console.warn("[chat] router.push failed:", e); } return; }
    // "Email" jumps to the inbox screen (same pattern as One).
    // [2026-10-14 piscada-nav] push (não replace): o replace DESMONTAVA a /chat → voltar do
    // e-mail remontava a lista inteira (skeleton/avatares recarregando = piscada) e a
    // transição era um fade de 100 ms. Push = slide nativo + swipe-back; o "Conversas"
    // do inbox (goToChats) já faz router.back() quando há pilha.
    if (tab === 'email') { try { router.push('/inbox'); } catch (e) { console.warn("[chat] router.push failed:", e); } return; }
    // "Reels" bottom-nav button opens the feed screen on the Posts tab by
    // default (Reels is the second sub-tab inside the feed). Reverts #896
    // which forced reels mode — user feedback 2026-05-21: clicking Reels
    // should land on Posts so the feed feels like an Instagram-style home.
    // [reels-v1 2026-10-13] Celular: Reels é aba própria (cai no fluxo normal abaixo).
    // Desktop/Kids: modo reels do Feed, como antes.
    if (tab === 'reels' && (isDesktop || isKids)) { setPendingReels(true); handleTabPress('feed'); return; }
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
    // [2026-10-16 pisca] O setValue(0.6) rodava AQUI, antes do commit da aba
    // nova: a aba ANTIGA ficava esmaecida/deslocada enquanto a nova renderizava
    // (1ª visita a Ligações = ~2,6k nós montando → 100-300 ms no Android) =
    // "piscada" na troca de aba. Agora o assentamento começa no layout effect do
    // commit da aba nova (useLayoutEffect abaixo): a antiga nunca esmaece.
    _tabSettleDirRef.current = dir;

    setActiveTab(tab);
    setMountedTabs(prev => { const next = new Set(prev); next.add(tab); return next; });
  }, [indicatorAnim, contentOpacity, contentTranslateX, activeTab, TAB_KEYS, isDesktop, isKids]);

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
  // [2026-10-16 wave12-c] atalhos à vista na home (HomeDiscoverPills).
  const openDiscoverTab = useCallback((k) => { try { haptic.select(); } catch {} handleTabPress(k); }, [handleTabPress]);
  // Vazio da lista (components/onboarding/ChatListSmartEmpty) pede a troca de aba por evento.
  const openDiscoverTabRef = useRef(openDiscoverTab);
  useEffect(() => { openDiscoverTabRef.current = openDiscoverTab; }, [openDiscoverTab]);
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('chatyy:openHomeTab', (k) => {
      if (k === 'channels' || k === 'communities') openDiscoverTabRef.current?.(k);
    });
    return () => { try { sub.remove(); } catch {} };
  }, []);

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
      // [motion-nav] tocou de novo enquanto a mola fechava → reabre do ponto atual.
      if (_searchRea && !searchShown) { setSearchShown(true); return; }
      setSearchQuery(''); // clear on close
      if (_searchRea) { setSearchShown(false); return; } // SearchReveal → _onSearchHidden
      Animated.timing(searchAnim, { toValue: 0, duration: 220, useNativeDriver: false }).start(() => setSearchOpen(false));
    } else {
      setSearchOpen(true);
      if (_searchRea) { setSearchShown(true); return; }
      Animated.spring(searchAnim, { toValue: 1, tension: 100, friction: 15, useNativeDriver: false }).start();
    }
  }, [searchOpen, searchAnim, _searchRea, searchShown]);

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
  // [2026-10-09 status-composer] Pedido de "novo status" à prova de corrida:
  // um timestamp por pedido, consumido 1x pelo ChatStatusTab (lazy). O
  // autoNewStatus acima sumia em 500ms e, se o tab lazy ainda não tinha
  // montado, o compositor simplesmente não abria (o "+" parecia morto).
  const [newStatusNonce, setNewStatusNonce] = useState(() => (params.new === '1' ? Date.now() : 0));
  const [pendingReels, setPendingReels] = useState(() => _tabParam === 'reels' && !_reelsIsTab);
  // [2026-10-11 social-qa] ChatFeedTab reports its sub-mode so the mobile
  // shell can drop the "Feed" header and go full-bleed while Reels is open
  // (Instagram parity — was showing the feed header over the reel).
  const [feedReelsMode, setFeedReelsMode] = useState(() => _tabParam === 'reels' && !_reelsIsTab);
  const onFeedModeChange = useCallback((mode) => setFeedReelsMode(mode === 'reels'), []);
  // [2026-10-15 tab-telemetry] Troca de aba da home -> screen_view em
  // analytics_page_views (page '/chat/<aba>'). A abertura inicial em 'chats' ja
  // vira pageview '/chat' no _layout; aqui so as trocas (e aba inicial != chats).
  const _tabTrackRef = useRef(null);
  useEffect(() => {
    const key = activeTab === 'feed' && feedReelsMode ? 'reels' : activeTab;
    const prev = _tabTrackRef.current;
    _tabTrackRef.current = key;
    if (prev === key || (prev === null && key === 'chats')) return;
    try { trackScreenView('/chat/' + key); } catch {}
  }, [activeTab, feedReelsMode]);
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
    try { trackScreenView('/chat/status'); } catch {} // [2026-10-15 tab-telemetry]
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
    try { trackScreenView('/chat/status/new'); } catch {} // [2026-10-15 tab-telemetry]
    setNewStatusNonce(Date.now());
  }, []);
  // PERF: these two were inline arrows inside the tabProps literal, so every
  // chat.js render minted fresh function identities → tabProps changed → every
  // mounted tab (ChatListTab, Feed, Status, …) re-rendered even on unrelated
  // state churn (SyncBar ticks, badge updates). useCallback pins them.
  // [2026-10-15 system-integration] Ícone do app → "Câmera do status"
  // (onemundomail://chat?new=1) com a home JÁ montada: o useState acima só lê
  // ?new=1 na montagem. Reage à mudança do parâmetro e o limpa, para o próximo
  // atalho disparar de novo. Na montagem fria o pedido já saiu pelo useState.
  const _newParamMountRef = useRef(params.new === '1');
  useEffect(() => {
    if (params.new !== '1') { _newParamMountRef.current = false; return; }
    if (!_newParamMountRef.current) requestNewStatus();
    _newParamMountRef.current = false;
    try { router.setParams({ new: undefined }); } catch {}
  }, [params.new]); // eslint-disable-line react-hooks/exhaustive-deps
  const onOpenStatusConsumed = useCallback(() => setOpenStatusEmail(null), []);
  const onFeedModeConsumed = useCallback(() => setPendingReels(false), []);
  // [2026-10-07 apps-menu] Apps drawer "Reels" tile → feed tab in reels mode
  // (ChatFeedTab consumes initialFeedMode='reels' → full-screen ReelsViewer).
  const openReelsFromApps = useCallback(() => { setShowAppsDrawer(false); handleTabPress('reels'); }, [handleTabPress]);
  // [2026-10-11 social-qa] Respect ?tab= for EVERY tab, on mount and when the
  // param changes while /chat stays mounted (router.push('/chat?tab=reels')).
  // Renderable tabs were already applied by useState on mount; the special
  // ones (reels/apps/email/one) are dispatched here.
  const lastTabParamRef = useRef(VALID_TABS.includes(_tabParam) || _tabParam === 'reels' ? _tabParam : null);
  useEffect(() => {
    const tp = typeof params.tab === 'string' ? params.tab : '';
    if (!tp || tp === lastTabParamRef.current) return;
    lastTabParamRef.current = tp;
    if (tp === 'reels') { handleTabPress('reels'); return; }
    if (tp === 'apps' || tp === 'email' || tp === 'one') { handleTabPress(tp); return; }
    if (VALID_TABS.includes(tp)) handleTabPress(tp);
  }, [params.tab]); // eslint-disable-line react-hooks/exhaustive-deps
  // PERF: tabProps was a fresh object every render and is spread into ALL
  // mounted tabs. Memoizing it means a tab only re-renders when a value it
  // actually consumes changes, not on every parent re-render.
  const tabProps = useMemo(() => ({ colors, isDark, t, user, router, searchQuery, setActiveTab, autoNewStatus, newStatusNonce, openStatusEmail, onOpenStatusConsumed, requestOpenStatus, requestNewStatus, initialFeedMode: pendingReels ? 'reels' : undefined, onFeedModeConsumed, onFeedModeChange, tabActive: activeTab }), [colors, isDark, t, user, router, searchQuery, setActiveTab, autoNewStatus, newStatusNonce, openStatusEmail, onOpenStatusConsumed, requestOpenStatus, requestNewStatus, pendingReels, onFeedModeConsumed, onFeedModeChange, activeTab]);

  const titles = {
    feed: t('feed.title') || 'Feed',
    status: 'Status',
    calls: t('chat.tabCalls') || 'Ligações',
    chats: t('chat.tabChats') || 'Conversas',
    config: t('chat.tabConfig') || 'Configurações',
    learn: 'Professora ONE',
    tv: 'Chatyy TV',
    channels: t('channel.title') || 'Canais',
    communities: t('community.title') || 'Comunidades',
    reels: t('reels.title') || 'Reels',
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
            onLongPress={() => { try { haptic.select(); } catch {} requestNewStatus(); }} delayLongPress={350}
            hitSlop={6} style={btnStyle} accessibilityLabel={t('a11y.camera')} accessibilityHint={t('status.ring.newStatus')}>
            <IconCamera size={22} color={headerIconColor} />{/* [2026-10-17 wa-polish] 19/18/20 → one optical size */}
          </TouchableOpacity>
          <TouchableOpacity onPress={toggleSearch} activeOpacity={0.6}
            hitSlop={6} style={btnStyle} accessibilityLabel={t('a11y.search')}>
            <IconSearch size={21} color={headerIconColor} />
          </TouchableOpacity>
          {/* WhatsApp-parity: "new chat" is a filled GREEN circle (the one
              pop of color in the otherwise clean header). */}
          <TouchableOpacity onPress={() => router.push('/chat-new')} activeOpacity={0.75}
            hitSlop={6} style={[styles.headerIconBtn, { backgroundColor: headerBtnBg }]} accessibilityLabel={t('a11y.newChat')}>
            {/* [2026-10-06 founder] "+" do topo era VERDE (#25D366 + ícone branco) e
                chamava atenção demais; WhatsApp usa ícones neutros no header.
                Agora igual aos outros botões do topo: fundo cinza + ícone na cor
                do texto. (headerPlusGreen fica no stylesheet p/ eventual uso.) */}
            <IconPlus size={23} color={headerIconColor} />
          </TouchableOpacity>
        </>
      );
    }
    if (activeTab === 'calls') {
      return (
        <TouchableOpacity onPress={() => { try { if (globalThis.__chatyyOpenNewCall?.()) return; } catch {} router.push('/chat-new'); }} activeOpacity={0.6}
          style={[styles.headerIconBtn, { backgroundColor: headerBtnBg }]} accessibilityRole="button" accessibilityLabel={t('a11y.newCall')}>{/* [2026-10-17 sem-pstn] abre "Nova chamada" (só Chatyy) da aba Ligações */}
          <IconPhone size={17} color={headerIconColor} />
        </TouchableOpacity>
      );
    }
    if (activeTab === 'status') {
      return (
        // [2026-06-04] era onPress={() => {}} — botão de câmera morto (caçada
        // R2). Reusa o fluxo do strip "+ status": requestNewStatus() flipa
        // autoNewStatus e o ChatStatusTab abre o composer canônico.
        <TouchableOpacity onPress={requestNewStatus} activeOpacity={0.6} accessibilityRole="button" accessibilityLabel={t('a11y.camera')}
          style={[styles.headerIconBtn, { backgroundColor: headerBtnBg }]}>
          <IconCameraHeader size={18} color={headerIconColor} />
        </TouchableOpacity>
      );
    }
    // [2026-10-14 vis3] feed: sem lupa no topo — o feed já tem o campo "Buscar pessoas"
    // logo abaixo (2 buscas empilhadas na mesma tela). Espaçador mantém a altura do header.
    if (activeTab === 'feed') return <View style={styles.headerIconBtn} pointerEvents="none" />;
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
  // [motion-nav] casca da barra: SearchReveal (mola UI thread) ou o Animated.View antigo.
  const SearchShell = _searchRea ? SearchReveal : Animated.View;
  const _searchShellProps = _searchRea ? { shown: searchShown && searchOpen, onHidden: _onSearchHidden, height: 52 } : null;
  const _searchAnimStyle = _searchRea ? null : { height: searchHeight, opacity: searchOpacity };

  // WhatsApp 2026 header style — CLEAN WHITE (2026-09-30 "much less black").
  // Was a solid black surface (#111 in both modes). Now a white (light) /
  // surface (dark) header with dark text + a hairline separator, so the top
  // chrome reads airy instead of a heavy black bar.
  // [2026-10-08 chat-beauty-list] B&W premium shell: near-black #0b0b0b in
  // dark (was WhatsApp navy #111b21/#0e1621), neutral hairlines (no blue cast).
  const glassHeader = {
    backgroundColor: isDark ? SHELL_DARK : '#ffffff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: isDark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.08)',
  };

  const glassTabBar = {
    backgroundColor: isDark ? SHELL_DARK : '#ffffff',
  };
  const searchFieldBg = isDark ? '#1c1c1e' : '#f2f2f2';
  const searchIconC = isDark ? '#8e8e93' : '#8a8a8e';

  // ── DESKTOP LAYOUT (side rail + content) ──
  if (isDesktop) {
    return (
      <View style={[styles.container, { backgroundColor: isDark ? SHELL_DARK : '#f0f2f5', flexDirection: 'row' }]}>
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
                  label={key === 'chats' ? (t('chat.tabChats') || 'Conversas') : key === 'feed' ? (t('feed.title') || 'Feed') : key === 'status' ? 'Status' : key === 'calls' ? (t('chat.tabCalls') || 'Ligações') : (t('chat.tabConfig') || 'Configurações')}
                  active={activeTab === key}
                  onPress={() => handleTabPress(key)}
                  isDark={isDark}
                  badge={tabBadge}
                />
              );
            })}
            {/* [2026-10-12 chatlist-polish] Desktop had no way into the Apps
                drawer (Email, Reuniões, Canais, Comunidades, Agenda…). Same
                drawer as the mobile "Apps" tab. */}
            {!isKids && (
              <DesktopTabItem
                tabKey="apps"
                icon={IconAppsTab}
                label={t('chat.tabApps') || 'Apps'}
                active={showAppsDrawer}
                onPress={() => handleTabPress('apps')}
                isDark={isDark}
                badge={0}
              />
            )}
          </View>

          {/* Back button at bottom (hidden for kids) */}
          {!isKids && (
          <TouchableOpacity onPress={() => router.back()} activeOpacity={0.6} accessibilityRole="button" accessibilityLabel={t('a11y.back')}
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
              {activeTab === 'chats' ? (
                <SyncStatusTitle title={titles.chats} titleStyle={[styles.title, { color: colors.text }]} announce />
              ) : (
                <Text style={[styles.title, { color: colors.text }]}>{titles[activeTab]}</Text>
              )}
            </View>
            <View style={styles.headerActions}>
              {renderHeaderAction()}
            </View>
          </View>

          {/* Search bar */}
          <SearchShell {..._searchShellProps} style={[styles.searchBarOuter, _searchAnimStyle, {
            ...glassHeader,
            borderBottomColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
            overflow: 'hidden',
            ...(searchOpen ? null : { paddingBottom: 0, borderBottomWidth: 0 }),
          }]}>
            {searchOpen && (
              <View style={[styles.searchBar, {
                backgroundColor: searchFieldBg,
              }]}>
                <IconSearch size={16} color={searchIconC} />
                <TextInput autoFocus placeholder={t('common.search') || 'Buscar...'} placeholderTextColor={searchIconC}
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
                  <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 0.2, color: isDark ? '#F5F5F7' : '#111111' }}>{t('common.searchAll') || 'Tudo'}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={toggleSearch} activeOpacity={0.6} style={styles.searchCloseBtn} accessibilityRole="button" accessibilityLabel={t('a11y.closeSearch')}>
                  <IconClose size={16} color={searchIconC} />
                </TouchableOpacity>
              </View>
            )}
          </SearchShell>


          {/* Content - lazy mount: only mount tab once visited, then keep mounted hidden */}
          <Animated.View style={{ flex: 1, opacity: contentOpacity, transform: [{ translateX: contentTranslateX }] }}>
            <View style={{ display: activeTab === 'chats' ? 'flex' : 'none', flex: activeTab === 'chats' ? 1 : undefined }}>
              {IS_TABLET_DEVICE ? (
                // [2026-10-10 tablet-split] iPad/tablet: lista à esquerda + painel
                // vazio à direita (WhatsApp iPad). Tocar numa conversa abre a tela
                // dividida (lista + conversa) — ver ChatConversationScreen.
                <View style={{ flex: 1, flexDirection: 'row' }}>
                  <View style={{ width: 400, maxWidth: '42%', minWidth: 300, borderRightWidth: 1, borderRightColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
                    <ChatErrorBoundary><ChatListTab key={'cl_' + (user?.email || 'anon')} {...tabProps} /></ChatErrorBoundary>
                  </View>
                  <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, backgroundColor: isDark ? '#000000' : '#f7f7f7' }}>
                    <Svg width={56} height={56} viewBox="0 0 24 24" fill="none">
                      <Path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke={isDark ? '#8e8e93' : '#8a8a8e'} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                    </Svg>
                    <Text style={{ marginTop: 14, fontSize: 17, fontWeight: '600', color: colors.text, textAlign: 'center' }}>{t('chat.tabletPickTitle')}</Text>
                    <Text style={{ marginTop: 6, fontSize: 14, color: isDark ? '#8e8e93' : '#6b6b70', textAlign: 'center', maxWidth: 360 }}>{t('chat.tabletPickHint')}</Text>
                  </View>
                </View>
              ) : (
                <ChatErrorBoundary><ChatListTab key={'cl_' + (user?.email || 'anon')} {...tabProps} /></ChatErrorBoundary>
              )}
            </View>
            {mountedTabs.has('calls') && <View style={{ display: activeTab === 'calls' ? 'flex' : 'none', flex: activeTab === 'calls' ? 1 : undefined }}>
              <ChatErrorBoundary><Suspense fallback={<CallListSkeleton />}><ChatCallsTab {...tabProps} /></Suspense></ChatErrorBoundary>
            </View>}
            {mountedTabs.has('feed') && <View style={{ display: activeTab === 'feed' ? 'flex' : 'none', flex: activeTab === 'feed' ? 1 : undefined }}>
              <ChatErrorBoundary><Suspense fallback={null}><ChatFeedTab {...tabProps} /></Suspense></ChatErrorBoundary>
            </View>}
            {mountedTabs.has('reels') && <View style={{ display: activeTab === 'reels' ? 'flex' : 'none', flex: activeTab === 'reels' ? 1 : undefined, backgroundColor: '#000' }}>
              <ChatErrorBoundary name="reels"><Suspense fallback={null}><ReelsHomeTab {...tabProps} /></Suspense></ChatErrorBoundary>
            </View>}
            {mountedTabs.has('status') && <View style={_statusSurfaceStyle(activeTab === 'status')} pointerEvents={activeTab === 'status' ? 'auto' : 'box-none'}>
              <ChatErrorBoundary name="status" resetKey={`${newStatusNonce}|${openStatusEmail || ''}`}><Suspense fallback={null}><ChatStatusTab {...tabProps} /></Suspense></ChatErrorBoundary>
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
        {!isKids && (
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
        )}
        {/* [2026-10-07 welcome] per-account first-run (renders null when done) */}
        {!isKids ? <FirstRunGate /> : null}
      </View>
    );
  }

  // ── MOBILE LAYOUT (bottom tab bar) ──
  // Reels = full-bleed immersive (Instagram): no shell header / search bar;
  // ChatFeedTab's own "Posts" pill is the way back.
  const reelsImmersive = (activeTab === 'feed' && feedReelsMode) || activeTab === 'reels';
  // [reels-v1 2026-10-13] Barra escura sobre o vídeo (Instagram) quando a aba Reels está ativa.
  const barDark = isDark || activeTab === 'reels';
  // [wave8-list] header sobreposto à lista (só Conversas, busca fechada).
  const homeOverlay = homeTopBar && LIST_LARGE_TITLE && activeTab === 'chats' && !searchOpen && !reelsImmersive && homeHeaderH > 0;
  // [2026-10-16 wave12-c] web/fallback: atalhos Comunidades/Canais numa linha sob o header.
  const showDiscoverRow = !LIST_LARGE_TITLE && !isKids && activeTab === 'chats' && !searchOpen && !reelsImmersive;
  return (
    <View style={[styles.container, {
      backgroundColor: reelsImmersive ? '#000' : (isDark ? SHELL_DARK : '#ffffff'),
      // [2026-10-13 reels-visual] Aba Reels = vídeo de borda a borda (TikTok/Instagram):
      // começa atrás da status bar; o ReelsViewer aplica o inset no cabeçalho + gradiente.
      paddingTop: activeTab === 'reels' ? 0 : insets.top,
    }]}>
      {/* WhatsApp-style header — no back arrow on mobile (Chatyy IS home) */}
      <View onLayout={onHomeHeaderLayout} style={[styles.header, {
        ...glassHeader,
        ...(reelsImmersive ? { display: 'none' } : null),
        paddingLeft: 14,
        // [2026-10-07 native-ui-build] large title: sem hairline fixa — ela
        // aparece (fade) só quando a lista rola por baixo do header.
        ...(LIST_LARGE_TITLE && (activeTab === 'chats' || _ltTab) ? { borderBottomWidth: 0 } : {}),
        ...(showDiscoverRow ? { borderBottomWidth: 0 } : null),
        // [wave8-list] por cima da lista: o vidro nativo da lista é o fundo.
        ...(homeOverlay ? { backgroundColor: 'transparent' } : null),
      }]}>
        {/* [2026-10-15 nav-motion] Ligações/Status: título compacto + hairline
            aparecem quando o título grande passa por baixo do header. */}
        {!!_ltTab && (
          <>
            <Animated.View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.compactTitleWrap, _compactTitleMotion(_ltTab === 'calls' ? callsTitleAnim : statusTitleAnim)]}>
              <Text numberOfLines={1} style={[styles.compactTitle, { color: colors.text }]}>{titles[_ltTab]}</Text>
            </Animated.View>
            <Animated.View
              pointerEvents="none"
              style={[styles.headerHairline, { backgroundColor: isDark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.08)', opacity: _ltTab === 'calls' ? callsTitleAnim : statusTitleAnim }]}
            />
          </>
        )}
        {LIST_LARGE_TITLE && activeTab === 'chats' && (
          <>
            <Animated.View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.compactTitleWrap, _compactTitleMotion(chatTitleAnim)]}>
              <SyncStatusTitle
                title={titles.chats}
                align="center"
                accessibilityRole="none"
                titleStyle={[styles.compactTitle, { color: colors.text }]}
              />
            </Animated.View>
            {!homeOverlay && (
            <Animated.View
              pointerEvents="none"
              style={[styles.headerHairline, { backgroundColor: isDark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.08)', opacity: chatTitleAnim }]}
            />
            )}
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
            // [2026-10-16 wave12-c] …e o vazio vira os atalhos Comunidades/Canais.
            LIST_LARGE_TITLE ? (isKids || searchOpen ? null : (
            <Animated.View
              pointerEvents={chatTitleCollapsed ? 'none' : 'auto'}
              accessibilityElementsHidden={chatTitleCollapsed}
              importantForAccessibility={chatTitleCollapsed ? 'no-hide-descendants' : 'auto'}
              style={{ flex: 1, minWidth: 0, opacity: discoverPillsOpacity }}
            >
              <HomeDiscoverPills t={t} isDark={isDark} colors={colors} onOpen={openDiscoverTab} />
            </Animated.View>
            )) : (
            <SyncStatusTitle
              title={titles.chats}
              announce
              titleStyle={[styles.bigTitle, { color: colors.text }]}
            />
            )
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              {/* [2026-10-15 nav-motion] Ligações é aba da barra → sem "voltar"
                  (como Conversas); o título mora na lista (grande → compacto). */}
              {/* [2026-10-16 polish3] web/fallback (sem large title) também: aba da barra não tem "voltar". */}
              {_ltTab !== 'calls' && activeTab !== 'calls' && (
              <TouchableOpacity onPress={() => handleTabPress('chats')} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.back') || 'Voltar'}>
                <IconArrowLeft size={18} color={colors.text} />
              </TouchableOpacity>
              )}
              {!_ltTab && <Text style={[activeTab === 'calls' ? styles.bigTitle : styles.title, { color: colors.text }]}>{titles[activeTab]}</Text>}
            </View>
          )}
        </View>
        <View style={styles.headerActions}>
          {renderHeaderAction()}
        </View>
      </View>

      {/* [2026-10-16 wave12-c] Web/fallback (título no header): atalhos numa linha fina abaixo. */}
      {showDiscoverRow && (
        <View style={[glassHeader, { paddingHorizontal: 14, paddingBottom: 8 }]}>
          <HomeDiscoverPills t={t} isDark={isDark} colors={colors} onOpen={openDiscoverTab} />
        </View>
      )}

      {/* Animated search bar */}
      <SearchShell {..._searchShellProps} style={[styles.searchBarOuter, _searchAnimStyle, {
        ...glassHeader,
        borderBottomColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
        overflow: 'hidden',
        // [2026-10-11 visual polish] Collapsed (height 0) the 8px paddingBottom +
        // hairline still rendered on web (border-box) → 9px blank band + double
        // divider under the header on every tab. Only pad/border while open.
        ...(searchOpen ? null : { paddingBottom: 0, borderBottomWidth: 0 }),
        ...(reelsImmersive ? { display: 'none' } : null),
      }]}>
        {searchOpen && (
          <View style={[styles.searchBar, {
            backgroundColor: searchFieldBg,
          }]}>
            <IconSearch size={16} color={searchIconC} />
            <TextInput autoFocus placeholder={t('common.search') || 'Buscar...'} placeholderTextColor={searchIconC}
              value={searchQuery}
              onChangeText={setSearchQuery}
              returnKeyType="search"
              clearButtonMode="while-editing"
              style={[styles.searchInput, { color: colors.text }]} />
            <TouchableOpacity onPress={toggleSearch} activeOpacity={0.6} style={styles.searchCloseBtn} accessibilityRole="button" accessibilityLabel={t('a11y.closeSearch')}>
              <IconClose size={16} color={searchIconC} />
            </TouchableOpacity>
          </View>
        )}
      </SearchShell>


      {/* Tab content with fade - lazy mount: only mount tab once visited */}
      {/* [2026-10-07 native-ui-build] Tab bar de vidro (iOS) é absoluta: as
          outras abas ganham paddingBottom = altura da barra (layout igual ao
          de antes); a de Conversas rola POR BAIXO (bottomInset na lista). */}
      <Animated.View style={{ flex: 1, opacity: contentOpacity, transform: [{ translateX: contentTranslateX }], ...(GLASS_TAB_BAR && activeTab !== 'chats' ? { paddingBottom: tabBarH } : {}), ...(homeOverlay ? { marginTop: -homeHeaderH } : null) }}>
        <View style={{ display: activeTab === 'chats' ? 'flex' : 'none', flex: activeTab === 'chats' ? 1 : undefined }}>
          <ChatErrorBoundary><ChatListTab
            key={'cl_' + (user?.email || 'anon')}
            {...tabProps}
            largeTitle={LIST_LARGE_TITLE ? titles.chats : undefined}
            onLargeTitleCollapsedChange={LIST_LARGE_TITLE ? onChatTitleCollapseHome : undefined}
            bottomInset={GLASS_TAB_BAR ? tabBarH : 0}
            topOverlayInset={homeOverlay ? homeHeaderH : 0}
            onNativeTopBar={LIST_LARGE_TITLE ? setHomeTopBar : undefined}
          /></ChatErrorBoundary>
        </View>
        {mountedTabs.has('calls') && <View style={{ display: activeTab === 'calls' ? 'flex' : 'none', flex: activeTab === 'calls' ? 1 : undefined }}>
          <ChatErrorBoundary><Suspense fallback={<CallListSkeleton />}><ChatCallsTab {...tabProps} largeTitle={LIST_LARGE_TITLE && !isKids ? titles.calls : undefined} onLargeTitleCollapsedChange={LIST_LARGE_TITLE && !isKids ? onCallsTitleCollapse : undefined} /></Suspense></ChatErrorBoundary>
        </View>}
        {mountedTabs.has('feed') && <View style={{ display: activeTab === 'feed' ? 'flex' : 'none', flex: activeTab === 'feed' ? 1 : undefined }}>
          <ChatErrorBoundary><Suspense fallback={null}><ChatFeedTab {...tabProps} /></Suspense></ChatErrorBoundary>
        </View>}
        {mountedTabs.has('reels') && <View style={{ display: activeTab === 'reels' ? 'flex' : 'none', flex: activeTab === 'reels' ? 1 : undefined, backgroundColor: '#000' }}>
          <ChatErrorBoundary name="reels"><Suspense fallback={null}><ReelsHomeTab {...tabProps} /></Suspense></ChatErrorBoundary>
        </View>}
        {mountedTabs.has('status') && <View style={_statusSurfaceStyle(activeTab === 'status')} pointerEvents={activeTab === 'status' ? 'auto' : 'box-none'}>
          <ChatErrorBoundary name="status" resetKey={`${newStatusNonce}|${openStatusEmail || ''}`}><Suspense fallback={null}><ChatStatusTab {...tabProps} largeTitle={LIST_LARGE_TITLE && !isKids ? titles.status : undefined} onLargeTitleCollapsedChange={LIST_LARGE_TITLE && !isKids ? onStatusTitleCollapse : undefined} /></Suspense></ChatErrorBoundary>
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
      {NATIVE_TABS && nativeTabItems ? (
        <NativeHomeTabBar
          items={nativeTabItems}
          selectedKey={showAppsDrawer ? 'apps' : ((activeTab === 'chats' || activeTab === 'reels' || activeTab === 'calls') ? activeTab : null)}
          isDark={barDark}
          translucent={GLASS_TAB_BAR}
          bottomInset={insets.bottom}
          activeColor={barDark ? TAB_ON_DARK : TAB_ON_LIGHT}
          inactiveColor={barDark ? TAB_OFF_DARK : TAB_OFF_LIGHT}
          backgroundColor={barDark ? SHELL_DARK : '#ffffff'}
          hairlineColor={barDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.12)'}
          onTabPress={handleTabPress}
          onTabLongPress={(key) => { if (key === 'chats') requestNewStatus(); /* [2026-10-09 status-composer] segurar = câmera do status */ }}
          onLayout={GLASS_TAB_BAR ? onTabBarLayout : undefined}
          style={GLASS_TAB_BAR ? { position: 'absolute', left: 0, right: 0, bottom: 0 } : null}
        />
      ) : (
      <View accessibilityRole={Platform.OS === 'ios' ? 'tabbar' : 'tablist'} onLayout={GLASS_TAB_BAR ? onTabBarLayout : undefined} style={[styles.tabBar, {
        backgroundColor: GLASS_TAB_BAR ? 'transparent' : (barDark ? SHELL_DARK : '#ffffff'),
        ...(GLASS_TAB_BAR ? { position: 'absolute', left: 0, right: 0, bottom: 0 } : {}),
        paddingBottom: Platform.OS === 'web' ? (insets.bottom || 10) : Math.max(insets.bottom, Platform.OS === 'android' ? 12 : 8),
        ...(Platform.OS !== 'web' ? {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: barDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.12)',
        } : {
          // [2026-10-08 chat-beauty-list] web: flat bar + hairline (same as
          // native) instead of a rounded floating card with a drop shadow.
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: barDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)',
          backdropFilter: 'blur(24px) saturate(180%)',
          WebkitBackdropFilter: 'blur(24px) saturate(180%)',
          backgroundColor: barDark ? 'rgba(11, 11, 11, 0.94)' : 'rgba(255, 255, 255, 0.94)',
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
        {GLASS_TAB_BAR && <BarMaterial isDark={barDark} solidColor={barDark ? SHELL_DARK : '#ffffff'} />}
        {/* [2026-10-13 design-system] A barrinha deslizante de 3px no topo
            (Android/web) foi trocada pela pílula M3 atrás do ícone ativo
            (TabBarItem). A barra ficava "estacionada" sob Conversas quando a
            aba ativa não estava na barra (Feed/Status via Apps) e não seguia
            o Apps aberto. */}
        {isKids ? (
          <>
            <TabBarItem
              icon={(active) => <IconChatsTab size={25} color={active ? (barDark ? TAB_ON_DARK : TAB_ON_LIGHT) : (barDark ? TAB_OFF_DARK : TAB_OFF_LIGHT)} active={active} />}
              label={t('kids.chat') || 'Chats'}
              active={activeTab === 'chats'}
              onPress={() => handleTabPress('chats')}
              isDark={barDark}
              badge={0}
            />
            <TabBarItem
              icon={(active) => {
                const c = active ? (barDark ? TAB_ON_DARK : TAB_ON_LIGHT) : (barDark ? TAB_OFF_DARK : TAB_OFF_LIGHT);
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
              isDark={barDark}
            />
            <TabBarItem
              icon={(active) => {
                const c = active ? '#f59e0b' : (barDark ? '#636366' : '#a0a8b4');
                return (
                  <Svg width={25} height={25} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={active ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round">
                    <Rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
                    <Path d="M17 2L12 7 7 2" />
                  </Svg>
                );
              }}
              label={t('kids.tv') || 'TV'}
              active={activeTab === 'tv'}
              onPress={() => handleTabPress('tv')}
              isDark={barDark}
            />
            {/* Kids: "Perfil" tab now opens the unified profile, no more
                separate ChatProfileTab duplicate. */}
            <TabBarItem
              icon={(active) => {
                const c = active ? '#10b981' : (barDark ? '#636366' : '#a0a8b4');
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
              isDark={barDark}
            />
          </>
        ) : (
          <>
            <TabBarItem
              icon={(active) => <IconChatsTab size={22} color={active ? (barDark ? TAB_ON_DARK : TAB_ON_LIGHT) : (barDark ? TAB_OFF_DARK : TAB_OFF_LIGHT)} active={active} />}
              label={t('chat.tabChats') || 'Chats'}
              active={activeTab === 'chats'}
              onPress={() => handleTabPress('chats')}
              onLongPress={requestNewStatus /* [2026-10-09 status-composer] segurar = câmera do status (Instagram) */}
              isDark={barDark}
              badge={chatsBadge}
            />
            {/* [2026-10-03] Email no lugar do Reels — diferencial do super-app
                + utilidade diária. Abre o inbox (/inbox) via handleTabPress('email'). */}
            {/* [2026-10-15] No web, quando o chat está no painel lateral (iframe) do inbox, o e-mail já está aberto ao lado — esconde a aba. */}
            {!(Platform.OS === 'web' && typeof window !== 'undefined' && (() => { try { return window.self !== window.top; } catch { return true; } })()) && (
            <TabBarItem
              icon={(active) => <IconEmailTab size={22} color={active ? (barDark ? TAB_ON_DARK : TAB_ON_LIGHT) : (barDark ? TAB_OFF_DARK : TAB_OFF_LIGHT)} active={active} />}
              label={t('chat.tabEmail') || 'Email'}
              active={false}
              onPress={() => handleTabPress('email')}
              isDark={barDark}
              badge={emailBadge}
            />
            )}
            {/* [reels-v1 2026-10-13] Reels no centro da barra (tela cheia + ranking "Para você"). */}
            <TabBarItem
              icon={(active) => <IconReelsTab size={22} color={active ? (barDark ? TAB_ON_DARK : TAB_ON_LIGHT) : (barDark ? TAB_OFF_DARK : TAB_OFF_LIGHT)} active={active} />}
              label={t('reels.title') || 'Reels'}
              active={activeTab === 'reels'}
              onPress={() => handleTabPress('reels')}
              isDark={barDark}
            />
            <TabBarItem
              icon={(active) => <IconCallsTab size={22} color={active ? (barDark ? TAB_ON_DARK : TAB_ON_LIGHT) : (barDark ? TAB_OFF_DARK : TAB_OFF_LIGHT)} active={active} />}
              label={t('chat.tabCalls') || 'Ligações'}
              active={activeTab === 'calls'}
              onPress={() => handleTabPress('calls')}
              isDark={barDark}
              badge={missedCallBadge}
            />
            <TabBarItem
              icon={(active) => <IconAppsTab size={22} color={active ? (barDark ? TAB_ON_DARK : TAB_ON_LIGHT) : (barDark ? TAB_OFF_DARK : TAB_OFF_LIGHT)} active={active} />}
              label={t('chat.tabApps') || 'Apps'}
              active={showAppsDrawer}
              onPress={() => handleTabPress('apps')}
              isDark={barDark}
            />
          </>
        )}
      </View>
      )}
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

// [2026-10-15 apps-v3] Painel de Apps (AppTile/AppsSection/AppsDrawerModal) extraído →
// components/apps/AppsSheet.js (motion iOS 26 / Telegram, ver cabeçalho de lá).

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
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active }}
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
function PulseBadge({ badge, isDark, style }) {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const isWeb = Platform.OS === 'web';

  useEffect(() => {
    // [2026-10-07 app-feel-nav] Badge de aba nativo é ESTÁTICO (UITabBarItem /
    // Material Badge). Pulso infinito 1.2x = cara de site + gasta frame.
    // Agora: um "pop" curto só quando o número muda.
    if (badge > 0) { // [2026-10-08 chat-beauty-list] web too: pop, no infinite pulse
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
      // [2026-10-08 chat-beauty-list] B&W, inverted in dark (#111 on the dark
      // bar was invisible) + a ring in the bar colour so it cuts the icon.
      backgroundColor: isDark ? TAB_ON_DARK : TAB_ON_LIGHT,
      borderWidth: 2, borderColor: isDark ? SHELL_DARK : '#ffffff',
      transform: [{ scale: pulseAnim }],
    }, style]}>
      <Text style={[styles.badgeText, { color: isDark ? '#0b0b0b' : '#ffffff' }]}>{badge > 99 ? '99+' : badge}</Text>
    </Animated.View>
  );
}

// ── Mobile tab bar item with dot indicator ──
function TabBarItem({ icon, label, active, onPress, onLongPress, isDark, badge, dot }) {
  const { colors } = useTheme();
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const bounceAnim = useRef(new Animated.Value(0)).current;
  // [beauty 2026-10-01] Removed the dead `glowAnim` — it ran a 220ms JS-thread
  // (non-native) timing on every activation but was never referenced in the
  // JSX, so it was pure wasted work on the exact frame the new tab paints.
  const isWeb = Platform.OS === 'web';
  // [2026-10-13 design-system] Android/web: pílula M3 atrás do ícone ativo
  // (fade + leve expansão horizontal). iOS segue UITabBar: só cor/preenchimento.
  const showPill = Platform.OS !== 'ios';
  const pillAnim = useRef(new Animated.Value(active ? 1 : 0)).current;

  useEffect(() => {
    if (showPill) {
      Animated.spring(pillAnim, { toValue: active ? 1 : 0, useNativeDriver: true, tension: 260, friction: 24 }).start();
    }
    if (active && !showPill) {
      Animated.sequence([
        Animated.spring(bounceAnim, { toValue: -2, useNativeDriver: true, tension: 400, friction: 12 }),
        Animated.spring(bounceAnim, { toValue: 0, useNativeDriver: true, tension: 260, friction: 16 }),
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
      onLongPress={onLongPress ? () => { try { haptic.select(); } catch {} onLongPress(); } : undefined}
      delayLongPress={380}
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
        {showPill && (
          <Animated.View pointerEvents="none" style={[styles.tabPill, {
            backgroundColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.07)',
            opacity: pillAnim,
            transform: [{ scaleX: pillAnim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }],
          }]} />
        )}
        {icon(active)}
        {badge > 0 && <PulseBadge badge={badge} isDark={isDark} style={styles.tabBadgePos} />}
        {!badge && dot && (
          <View style={{
            position: 'absolute', top: 2, right: 12,
            width: 8, height: 8, borderRadius: 4,
            backgroundColor: colors.badge,
            borderWidth: 1.5, borderColor: isDark ? SHELL_DARK : '#ffffff', // [2026-10-10 polish-list] was navy #0f1115
          }} />
        )}
      </Animated.View>
      <Text selectable={false} numberOfLines={1} maxFontSizeMultiplier={1.3} style={[styles.tabLabel, {
        color: active ? (isDark ? TAB_ON_DARK : TAB_ON_LIGHT) : (isDark ? TAB_OFF_DARK : TAB_OFF_LIGHT),
        // [2026-10-17 wa-polish] 700↔500 made labels jump width on switch; UITabBar keeps one weight.
        fontWeight: active ? '600' : '500',
        ...(isWeb ? { transition: 'color 0.15s ease' } : {}),
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
    gap: 6, // [2026-10-17 wa-polish] 2→6: icons were crammed (WhatsApp ~20pt between glyphs)
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
    fontWeight: '700',
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
  // [2026-10-17 wa-polish] UISearchBar metrics: 36pt field, radius 10, 16pt text.
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 36,
    borderRadius: 10,
    paddingHorizontal: 10,
    gap: 7,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
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
    width: 56,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    borderRadius: 16,
  },
  // [2026-10-13 design-system] pílula do ativo (Android/web) + badge alinhado
  // ao canto do ícone (o wrap ficou 56 de largura).
  tabPill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    borderRadius: 16,
  },
  tabBadgePos: {
    top: -4,
    right: 5,
  },
  tabLabel: {
    fontSize: 11,
    lineHeight: 13,
    marginTop: 3,
    fontWeight: '500',
    letterSpacing: 0,
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
    top: -3,
    right: -1,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
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
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 13,
    fontVariant: ['tabular-nums'],
    includeFontPadding: false,
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
