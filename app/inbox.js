import React, { useEffect, useState, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import {
  View, FlatList, Text, TouchableOpacity, StyleSheet, Modal, Pressable, TextInput,
  ActivityIndicator, useWindowDimensions, Platform, Animated, Easing, Alert,
} from 'react-native';
// FlashList reverted to FlatList
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth, isChildAccount } from '../context/AuthContext';
import { useMail } from '../context/MailContext';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { Shadow, BorderRadius, FontSize, Spacing, LetterSpacing, AnimTiming } from '../constants/theme';
import EmailReader from '../components/EmailReader';
import Sidebar from '../components/Sidebar';
// Cold-start: these overlays (search, notifications hub, shortcut refs,
// snooze/context/quick-settings panels) are never visible on the first paint
// of /inbox — they all start closed (`visible={false}`) and only render UI
// when the user triggers them. Lazy-loading keeps their module code + deps off
// the synchronous launch→inbox bundle path; each render site is wrapped in
// <Suspense fallback={null}>, and since they'd render null/closed until opened
// anyway, the deferred chunk resolving later has no visible effect.
const GlobalSearch = lazy(() => import('../components/GlobalSearch'));
const NotificationsHub = lazy(() => import('../components/NotificationsHub'));
import UnifiedComposeFab from '../components/UnifiedComposeFab';
import BrandFab from '../components/BrandFab';
const KeyboardShortcutsRef = lazy(() => import('../components/KeyboardShortcutsRef'));
import EmailList from '../components/EmailList';
import SearchBar from '../components/SearchBar';
import { saveRecentSearch } from '../components/SearchOperators';
import UndoToast from '../components/UndoToast';
const KeyboardShortcutsModal = lazy(() => import('../components/KeyboardShortcutsModal'));
const SnoozePickerModal = lazy(() => import('../components/SnoozePickerModal'));
import {
  IconMenu, IconX, IconMail, IconSun, IconMoon, IconSettings, IconChevronLeft,
  IconUser, IconLogout, IconCompose, IconPlus, IconSearch, IconFolder, IconShield,
  IconMessageSquare, IconCalendar, IconFilm, IconGlobe, IconZap, IconImage,
  IconStar, IconArchive, IconLink, IconStickyNote, IconBell, IconPenTool, IconFilter, IconCheck,
  IconWifiOff, IconBookmark, IconSparkles,
} from '../components/Icons';
import CategoryTabs from '../components/CategoryTabs';
const QuickSettingsPanel = lazy(() => import('../components/QuickSettingsPanel'));
const ContextMenu = lazy(() => import('../components/ContextMenu'));
import ErrorBoundary from '../components/ErrorBoundary';
import AvatarCircle from '../components/AvatarCircle';
import { MessageSkeleton } from '../components/SkeletonLoader';
const ComposeModal = lazy(() => import('../components/ComposeModal'));
// Side panel modules render via iframe (same origin = shared session)
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as api from '../services/api';
import Onboarding, { ONBOARDING_KEY } from '../components/Onboarding';
import CompleteProfileModal, { isProfileComplete, COMPLETE_PROFILE_SKIP_KEY } from '../components/CompleteProfileModal';

const MUTED_UIDS_KEY = '@onemundo_muted_uids';

const SIDE_PANEL_ROUTES = {
  '/chat': { key: 'chat', icon: IconMessageSquare, label: 'sidebar.messages', color: '#7C3AED' },
  '/calendar': { key: 'calendar', icon: IconCalendar, label: 'sidebar.calendar', color: '#4285f4' },
  '/drive': { key: 'drive', icon: IconFolder, label: 'Chatyy Cloud', color: '#f59e0b' },
  '/meetings': { key: 'meetings', icon: IconFilm, label: 'sidebar.meetings', color: '#ef4444' },
  '/documentos': { key: 'documentos', icon: IconGlobe, label: 'sidebar.documents', color: '#4285f4' },
  '/contacts': { key: 'contacts', icon: IconUser, label: 'sidebar.contacts', color: '#8b5cf6' },
  '/one': { key: 'one', icon: IconZap, label: 'One', color: '#A78BFA' },
  '/photos': { key: 'photos', icon: IconImage, label: 'photos.title', color: '#e11d48' },
  '/backup': { key: 'backup', icon: IconArchive, label: 'Backup', color: '#f59e0b' },
  '/notes': { key: 'notes', icon: IconStickyNote, label: 'sidebar.notes', color: '#f59e0b' },
};

// Wrap the inner screen in an ErrorBoundary so that any crash inside
// (e.g. a dynamic native-module require throwing synchronously on iOS,
// a TDZ from a fast-refresh OTA mismatch, etc.) shows the friendly
// "Tentar novamente" screen INSIDE the inbox route instead of returning
// undefined from the screen render and tripping expo-router with the
// generic "Algo deu errado" overlay that blocks navigation entirely.
// (#1197 iOS Apps→Email click error fix, 2026-05-19.)
export default function InboxScreen(props) {
  return (
    <ErrorBoundary>
      <InboxScreenInner {...props} />
    </ErrorBoundary>
  );
}

function InboxScreenInner() {
  const { user, loading: authLoading, logout, login, accounts, switchAccount, removeAccount, switching } = useAuth();
  // Kids accounts go straight to chat — never show inbox
  const _kidsRouter = useRouter();
  useEffect(() => {
    if (user && isChildAccount()) {
      _kidsRouter.replace('/chat');
    }
  }, [user]);
  const {
    emails, folders, currentFolder, selectedEmail, loadingList, loadingMessage,
    page, total, search,
    loadFolders, loadEmails, openEmail, changeFolder, refresh, doSearch,
    deleteEmail, setSelectedEmail, setPage,
    starEmail: ctxStarEmail, archiveEmail: ctxArchiveEmail,
    // Selection
    selectedUids, selectMode, toggleSelect, selectAll, clearSelection,
    // Bulk
    bulkDelete, bulkArchive, bulkMarkRead, bulkMarkUnread,
    // Undo
    undoAction, executeUndo, dismissUndo,
    // Snooze
    snoozeEmail: ctxSnoozeEmail,
    // Labels
    addLabelToEmail, removeLabelFromEmail, labelCounts,
    // Account
    resetMailState,
    wsStatus,
    recentlyReadLoaded,
  } = useMail();
  const { colors, isDark, toggle } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();

  const getGreeting = () => {
    const h = new Date().getHours();
    if (h < 12) return t('greeting.morning');
    if (h < 18) return t('greeting.afternoon');
    return t('greeting.evening');
  };
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const isDesktop = width >= 768;
  const [showSidebar, setShowSidebar] = useState(false);
  const [searchText, setSearchText] = useState('');
  // Saved searches state — PG-backed via email_search_list. Loaded lazily on
  // the first time the user opens the saved-searches menu.
  const [savedSearches, setSavedSearches] = useState([]);
  const [showSavedSearches, setShowSavedSearches] = useState(false);
  const [savingSearch, setSavingSearch] = useState(false);
  const loadSavedSearches = useCallback(async () => {
    try {
      const r = await api.emailSearchList();
      if (r?.success) setSavedSearches(Array.isArray(r.data?.searches) ? r.data.searches : []);
    } catch {}
  }, []);
  const handleSaveSearch = useCallback(async () => {
    const q = searchText.trim();
    if (!q || savingSearch) return;
    setSavingSearch(true);
    try {
      const r = await api.emailSearchSave(q);
      if (r?.success) {
        setSavedSearches(prev => [{ id: r.data?.id, name: r.data?.name || q, query: q, created_at: r.data?.created_at }, ...prev]);
      }
    } catch {} finally {
      setSavingSearch(false);
    }
  }, [searchText, savingSearch]);
  const handleDeleteSavedSearch = useCallback(async (id) => {
    try { await api.emailSearchDelete(id); } catch {}
    setSavedSearches(prev => prev.filter(s => s.id !== id));
  }, []);
  useEffect(() => { loadSavedSearches(); }, [loadSavedSearches]);
  const [aiBriefing, setAiBriefing] = useState(null);
  const aiBriefingDateRef = useRef('');
  const [showMenu, setShowMenu] = useState(false);
  const [showQRScanner, setShowQRScanner] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showSnooze, setShowSnooze] = useState(false);
  const [snoozeTarget, setSnoozeTarget] = useState(null);
  const [activeCategory, setActiveCategory] = useState('all');
  const [activeLabel, setActiveLabel] = useState(null);
  const [inboxLayout, setInboxLayout] = useState(() => {
    try { return require('../services/mmkv').getString('inbox_layout') || 'default'; } catch { return 'default'; }
  });
  const [showLayoutMenu, setShowLayoutMenu] = useState(false);
  const setInboxLayoutPersisted = (val) => {
    setInboxLayout(val);
    try { require('../services/mmkv').setString('inbox_layout', val); } catch {}
  };
  const [showQuickSettings, setShowQuickSettings] = useState(false);
  const [contextMenu, setContextMenu] = useState({ visible: false, email: null, position: { x: 0, y: 0 } });
  const [showSearchOperators, setShowSearchOperators] = useState(false);
  const [moveToTarget, setMoveToTarget] = useState(null); // email to move
  const [sidePanels, setSidePanels] = useState([]); // array of up to 2 routes — desktop module panels
  // Floating compose modal (desktop only) — null=closed, object=open with params
  const [composeModal, setComposeModal] = useState(null);
  // Onboarding tutorial (first login only)
  const [showOnboarding, setShowOnboarding] = useState(false);
  // Complete profile modal
  const [showCompleteProfile, setShowCompleteProfile] = useState(false);
  const [profileData, setProfileData] = useState(null);
  const completeProfileChecked = useRef(false);
  // Account switch - password prompt when token expired
  const [switchLoginEmail, setSwitchLoginEmail] = useState(null);
  const [switchLoginPassword, setSwitchLoginPassword] = useState('');
  const [switchLoginError, setSwitchLoginError] = useState('');
  const [switchLoginLoading, setSwitchLoginLoading] = useState(false);

  // Offline banner — show when device has no network, so the user knows
  // the emails on screen are cached and writes won't go through yet.
  const [isOffline, setIsOffline] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web') {
      const handleOnline = () => setIsOffline(false);
      const handleOffline = () => setIsOffline(true);
      if (typeof window !== 'undefined' && typeof navigator !== 'undefined') {
        setIsOffline(!navigator.onLine);
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        return () => {
          window.removeEventListener('online', handleOnline);
          window.removeEventListener('offline', handleOffline);
        };
      }
      return undefined;
    }
    let unsub;
    try {
      const NetInfo = require('@react-native-community/netinfo').default;
      unsub = NetInfo.addEventListener(state => {
        setIsOffline(state.isConnected === false);
      });
      // Prime initial state
      NetInfo.fetch().then(state => {
        setIsOffline(state.isConnected === false);
      }).catch(() => {});
    } catch {}
    return () => { try { unsub && unsub(); } catch {} };
  }, []);

  // --- Muted UIDs (persisted in AsyncStorage) ---
  const [mutedUids, setMutedUids] = useState(new Set());
  const mutedUidsRef = useRef(new Set());
  useEffect(() => {
    AsyncStorage.getItem(MUTED_UIDS_KEY).then(raw => {
      if (raw) {
        try {
          const arr = JSON.parse(raw);
          const s = new Set(arr);
          setMutedUids(s);
          mutedUidsRef.current = s;
        } catch {}
      }
    }).catch(() => {});
  }, []);

  const handleMuteToggle = useCallback(async (email) => {
    const uid = String(email.uid);
    const newSet = new Set(mutedUidsRef.current);
    if (newSet.has(uid)) {
      newSet.delete(uid);
    } else {
      newSet.add(uid);
    }
    mutedUidsRef.current = newSet;
    setMutedUids(newSet);
    try {
      await AsyncStorage.setItem(MUTED_UIDS_KEY, JSON.stringify([...newSet]));
    } catch {}
  }, []);

  // --- Server-side keyword categorization + AI smart categorization ---
  const [categoryCounts, setCategoryCounts] = useState({});
  // Gmail-style bundles (round-6 gap-closer). Backend returns extra
  // category groupings like compras/viagens/financas based on sender
  // domain heuristics — we surface them as additional tabs.
  const [bundles, setBundles] = useState([]);
  const [aiCategories, setAiCategories] = useState({}); // { uid: 'work'|'personal'|... }
  const aiCategorizingRef = useRef(false);

  // Maps AI smart categories → existing primary/social/promotions/updates buckets
  const aiCategoryBucket = (smartCat) => {
    const c = (smartCat || '').toLowerCase();
    if (['trabalho', 'financeiro', 'importante'].includes(c)) return 'primary';
    if (['social', 'pessoal'].includes(c)) return 'social';
    if (['compras', 'newsletter', 'viagem'].includes(c)) return 'promotions';
    if (['notificacao', 'spam'].includes(c)) return 'updates';
    return null;
  };

  // AI-classified importance map: { uid: 'high'|'normal'|'low' }. Built
  // lazily by a background classifier so the "Importantes" tab shows real
  // results without a forced upfront fan-out.
  const [aiPriority, setAiPriority] = useState({});
  const aiPriorityClassifyingRef = useRef(false);

  // Decide whether an email belongs in the Importantes tab. Combination of:
  //   - flagged (\Flagged) — user explicitly marked it important
  //   - server-side priority === 'high'
  //   - AI classification level === 'high'
  // Falls open if AI hasn't finished — "important" stays empty in that case
  // rather than showing every email.
  const isImportant = useCallback((e) => {
    if (!e) return false;
    if (e.flagged || (Array.isArray(e.flags) && e.flags.includes('\\Flagged'))) return true;
    if (e.priority === 'high') return true;
    if (aiPriority[e.uid] === 'high') return true;
    return false;
  }, [aiPriority]);

  // Compute category counts (uses AI categories if available, falls back to e.category)
  useEffect(() => {
    if (currentFolder !== 'INBOX' || !emails?.length) return;
    const counts = { unread: 0, important: 0, primary: 0, social: 0, promotions: 0, updates: 0 };
    for (const e of emails) {
      const aiBucket = aiCategoryBucket(aiCategories[e.uid]);
      const cat = aiBucket || e.category || 'primary';
      if (counts[cat] !== undefined) counts[cat]++;
      if (!e.seen) counts.unread++;
      if (isImportant(e)) counts.important++;
    }
    setCategoryCounts(counts);
  }, [emails, currentFolder, aiCategories, isImportant]);

  // Background AI importance classifier — runs once per email. The backend
  // caches per (user, message_id) so re-runs are cheap. Throttled to 5 in
  // parallel and 15 per refresh to avoid blasting GPT on big inboxes.
  useEffect(() => {
    if (currentFolder !== 'INBOX' || !emails?.length || aiPriorityClassifyingRef.current) return;
    const pending = emails.filter(e => aiPriority[e.uid] === undefined).slice(0, 15);
    if (pending.length === 0) return;
    aiPriorityClassifyingRef.current = true;
    let alive = true;
    (async () => {
      try {
        const updates = {};
        for (let i = 0; i < pending.length; i += 5) {
          if (!alive) return;
          const batch = pending.slice(i, i + 5);
          const results = await Promise.all(batch.map(async (e) => {
            try {
              // message_id is preferred (cache key); fallback to uid so the
              // server still classifies even when the IMAP Message-ID isn't
              // round-tripping cleanly.
              const r = await api.emailClassifyImportance({
                message_id: String(e.message_id || e.uid || ''),
                subject: e.subject || '',
                from: e.from || '',
                snippet: (e.snippet || e.body_preview || '').slice(0, 500),
              });
              return { uid: e.uid, level: r?.data?.level };
            } catch { return null; }
          }));
          for (const res of results) {
            if (res?.level) updates[res.uid] = res.level;
          }
        }
        if (alive && Object.keys(updates).length > 0) {
          setAiPriority(prev => ({ ...prev, ...updates }));
        }
      } catch {} finally {
        aiPriorityClassifyingRef.current = false;
      }
    })();
    return () => { alive = false; };
  }, [emails, currentFolder]);

  // AI smart-categorize emails that don't have a category yet (run in background, throttled)
  useEffect(() => {
    if (currentFolder !== 'INBOX' || !emails?.length || aiCategorizingRef.current) return;
    const uncategorized = emails.filter(e => !aiCategories[e.uid] && !e.category).slice(0, 15);
    if (uncategorized.length === 0) return;
    aiCategorizingRef.current = true;
    let alive = true;
    (async () => {
      try {
        const updates = {};
        for (let i = 0; i < uncategorized.length; i += 5) {
          if (!alive) return;
          const batch = uncategorized.slice(i, i + 5);
          const results = await Promise.all(batch.map(async (e) => {
            try {
              const r = await api.aiSmartCategorize(
                e.subject || '',
                (e.snippet || e.body_preview || '').slice(0, 500),
                e.from || ''
              );
              return { uid: e.uid, category: r?.data?.category };
            } catch { return null; }
          }));
          for (const res of results) {
            if (res?.category) updates[res.uid] = res.category;
          }
        }
        if (alive && Object.keys(updates).length > 0) {
          setAiCategories(prev => ({ ...prev, ...updates }));
        }
      } catch {} finally {
        aiCategorizingRef.current = false;
      }
    })();
    return () => { alive = false; };
  }, [emails, currentFolder]);

  const unreadCount = useMemo(() => emails.filter(e => !e.seen).length, [emails]);

  // "Mark all as read" — bulk-mark every visible unread email in current folder.
  // Confirms first to avoid accidental nuking of an unread queue. Reuses the
  // existing api.bulkMarkRead endpoint (no per-uid loop).
  const handleMarkAllRead = useCallback(() => {
    const unreadUids = emails.filter(e => !e.seen).map(e => e.uid);
    if (unreadUids.length === 0) return;
    const doMark = async () => {
      try {
        const apiSvc = await import('../services/api');
        await apiSvc.bulkMarkRead(unreadUids, currentFolder);
        refresh();
        try { (await import('../services/pushNotifications')).refreshBadgeCount?.(); } catch {}
      } catch (e) { console.warn('markAllRead failed', e); }
    };
    // Round-6 gap-closer: when 50+ are visible the user almost certainly
    // wants to mark EVERY unread in the folder (not just the page they
    // can see). Offer the folder-wide IMAP sweep as a second button so
    // they can pick the broader action without having to scroll.
    const doMarkFolder = async () => {
      try {
        const apiSvc = await import('../services/api');
        await apiSvc.bulkMarkReadFolder(currentFolder);
        refresh();
        try { (await import('../services/pushNotifications')).refreshBadgeCount?.(); } catch {}
      } catch (e) { console.warn('bulkMarkReadFolder failed', e); }
    };
    const title = t('contextMenu.markRead') || 'Marcar como lido';
    const msg = `${unreadUids.length} ${unreadUids.length > 1 ? (t('inbox.unreadPlural', { count: unreadUids.length }) || 'mensagens') : (t('inbox.unread', { count: unreadUids.length }) || 'mensagem')}?`;
    const buttons = [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('contextMenu.markRead') || 'Marcar', onPress: doMark },
    ];
    if (unreadUids.length >= 50) {
      buttons.push({
        text: t('inbox.markAllInFolder') || 'Marcar tudo na pasta',
        onPress: doMarkFolder,
      });
    }
    try {
      Alert.alert(title, msg, buttons);
    } catch {
      if (Platform.OS === 'web' && typeof window !== 'undefined' && window.confirm(`${title}\n\n${msg}`)) {
        (unreadUids.length >= 50 ? doMarkFolder : doMark)();
      }
    }
  }, [emails, currentFolder, refresh, t]);

  // Bundles fetch (round-6 gap-closer). Only INBOX gets bundles — other
  // folders surface flat lists. Refreshed when the folder changes or the
  // user pulls to refresh.
  useEffect(() => {
    // emailBundles endpoint not yet implemented on backend — skipping to
    // stop polluting the F12 console with 400s. Re-enable when chat.php /
    // email.php ships the case 'email_bundles' handler.
    if (currentFolder !== 'INBOX') setBundles([]);
  }, [currentFolder, emails.length]);

  // Auto-generate AI briefing once per day on first INBOX load with emails
  useEffect(() => {
    if (currentFolder !== 'INBOX' || emails.length === 0) return;
    const today = new Date().toISOString().slice(0, 10);
    if (aiBriefingDateRef.current === today) return;
    aiBriefingDateRef.current = today;
    let alive = true;
    (async () => {
      try {
        const top = emails.slice(0, 20).map(e => ({
          from: e.from_name || e.from || '',
          subject: e.subject || '',
          snippet: (e.snippet || e.body_preview || '').slice(0, 100),
          unread: !e.seen,
        }));
        const r = await api.aiSummarize([{
          role: 'user',
          content: 'Crie um briefing de 2-3 frases em portugues, amigavel, sobre os emails de hoje. Destaque urgentes/importantes. Emails:\n' + JSON.stringify(top),
        }]);
        if (!alive) return;
        if (r?.success && r.data?.result) setAiBriefing(r.data.result);
        else if (r?.data) setAiBriefing(typeof r.data === 'string' ? r.data : null);
      } catch {}
    })();
    return () => { alive = false; };
  }, [currentFolder, emails.length === 0]);
  const otherAccounts = useMemo(() => accounts.filter(a => a.email !== user?.email), [accounts, user?.email]);
  const prevIsDesktop = useRef(isDesktop);

  // Auth guard — redirect to login if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      router.replace('/login');
    }
  }, [authLoading, user]);

  // Onboarding check — show tutorial on first login (skip if pre-login onboarding was completed)
  useEffect(() => {
    if (!user) return;
    let alive = true;
    Promise.all([
      AsyncStorage.getItem(ONBOARDING_KEY),
      AsyncStorage.getItem('onboarding_complete'),
    ]).then(([val, preLoginVal]) => {
      if (!alive) return;
      if (!val && !preLoginVal) setShowOnboarding(true);
      else if (!val && preLoginVal) {
        // Pre-login onboarding was done, mark inbox one as done too
        AsyncStorage.setItem(ONBOARDING_KEY, 'true').catch(() => {});
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, [user]);

  // Complete profile check — show after onboarding is done
  useEffect(() => {
    if (!user || showOnboarding || completeProfileChecked.current) return;
    let alive = true;
    (async () => {
      try {
        // Don't nag on first 24h — let user explore the app first
        const firstLoginKey = '@chatyy_first_login_ts';
        const firstLoginTs = await AsyncStorage.getItem(firstLoginKey);
        if (!firstLoginTs) {
          await AsyncStorage.setItem(firstLoginKey, String(Date.now()));
          completeProfileChecked.current = true;
          return;
        }
        if (Date.now() - parseInt(firstLoginTs, 10) < 86400000) {
          completeProfileChecked.current = true;
          return;
        }
        const skipRaw = await AsyncStorage.getItem(COMPLETE_PROFILE_SKIP_KEY);
        if (!alive) return;
        if (skipRaw) {
          const skipData = JSON.parse(skipRaw);
          if (skipData.expiry && Date.now() < skipData.expiry) return; // still within skip window
        }
        const res = await api.getProfile();
        if (!alive) return;
        if (res?.success && res.data && res.data.email) {
          // Only show complete profile if we actually got valid data AND it's incomplete
          if (!isProfileComplete(res.data)) {
            setProfileData(res.data);
            setShowCompleteProfile(true);
          }
        }
        // If API failed (Session expired, etc), don't show the modal — data is unreliable
      } catch {}
      completeProfileChecked.current = true;
    })();
    return () => { alive = false; };
  }, [user, showOnboarding]);

  // Clear selected email when switching from desktop to mobile to prevent crash
  // OTA debug alert removed

  useEffect(() => {
    if (prevIsDesktop.current && !isDesktop && selectedEmail) {
      setSelectedEmail(null);
    }
    prevIsDesktop.current = isDesktop;
  }, [isDesktop]);

  // Entry animations
  const headerAnim = useRef(new Animated.Value(0)).current;
  const sidebarAnim = useRef(new Animated.Value(0)).current;
  const listAnim = useRef(new Animated.Value(0)).current;
  const fabAnim = useRef(new Animated.Value(0)).current;

  // Sidebar slide animation for mobile overlay
  const sidebarSlideAnim = useRef(new Animated.Value(-310)).current;
  const sidebarOverlayOpacity = useRef(new Animated.Value(0)).current;

  // FAB press scale animation
  const fabScaleAnim = useRef(new Animated.Value(1)).current;

  // Folder transition animation
  const folderTransitionAnim = useRef(new Animated.Value(1)).current;
  const prevFolder = useRef(currentFolder);

  // Animate folder transition when switching folders
  useEffect(() => {
    if (prevFolder.current !== currentFolder) {
      prevFolder.current = currentFolder;
      const nd = Platform.OS !== 'web';
      folderTransitionAnim.setValue(0);
      Animated.timing(folderTransitionAnim, {
        toValue: 1,
        duration: AnimTiming.slow,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }).start();
    }
  }, [currentFolder]);

  // Animate sidebar slide on mobile
  useEffect(() => {
    if (!isDesktop) {
      const nd = Platform.OS !== 'web';
      if (showSidebar) {
        Animated.parallel([
          Animated.spring(sidebarSlideAnim, { toValue: 0, tension: 80, friction: 14, useNativeDriver: false }),
          Animated.timing(sidebarOverlayOpacity, { toValue: 1, duration: 250, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
        ]).start();
      } else {
        Animated.parallel([
          Animated.timing(sidebarSlideAnim, { toValue: -310, duration: 220, easing: Easing.in(Easing.cubic), useNativeDriver: false }),
          Animated.timing(sidebarOverlayOpacity, { toValue: 0, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: false }),
        ]).start();
      }
    }
  }, [showSidebar, isDesktop]);



  useEffect(() => {
    // Register as mailto: handler on web so clicking mailto links opens this app
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.registerProtocolHandler) {
      try {
        navigator.registerProtocolHandler('mailto', window.location.origin + '/compose?mailto=%s', 'Chatyy');
      } catch {}
    }

    loadFolders();
    // Wait for recentlyRead cache before loading emails (prevents read→unread revert)
    if (recentlyReadLoaded) {
      loadEmails('INBOX', 1, '');
    }
    // Smooth staggered entry animation
    const nd = Platform.OS !== 'web';
    Animated.stagger(50, [
      Animated.timing(headerAnim, { toValue: 1, duration: 350, easing: Easing.out(Easing.exp), useNativeDriver: false }),
      Animated.timing(sidebarAnim, { toValue: 1, duration: 400, easing: Easing.out(Easing.exp), useNativeDriver: false }),
      Animated.timing(listAnim, { toValue: 1, duration: 400, easing: Easing.out(Easing.exp), useNativeDriver: false }),
      Animated.spring(fabAnim, { toValue: 1, tension: 100, friction: 10, useNativeDriver: false }),
    ]).start();
  }, [recentlyReadLoaded]);

  // Reset and reload when user changes (account switch)
  useEffect(() => {
    if (user?.email && recentlyReadLoaded) {
      resetMailState();
      loadFolders();
      loadEmails('INBOX', 1, '');
      setActiveCategory('all');
      setActiveLabel(null);
    }
  }, [user?.email, recentlyReadLoaded]);

  // Reload emails when activeCategory changes (unread is client-side filter)
  useEffect(() => {
    if (currentFolder === 'INBOX') {
      if (activeCategory === 'all' || activeCategory === 'unread') {
        loadEmails('INBOX', 1, search);
      } else {
        loadEmails('INBOX', 1, search, activeCategory);
      }
    }
  }, [activeCategory]);

  // Keyboard shortcuts (web only) - use refs to avoid re-adding listener on every state change
  const kbStateRef = useRef({ emails, selectedEmail, currentFolder, selectMode, undoAction, showShortcuts, showSnooze });
  useEffect(() => {
    kbStateRef.current = { emails, selectedEmail, currentFolder, selectMode, undoAction, showShortcuts, showSnooze };
  }, [emails, selectedEmail, currentFolder, selectMode, undoAction, showShortcuts, showSnooze]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;

    let gPrefix = false; // for "g i", "g s", etc. two-key shortcuts
    let gPrefixTimer = null;

    const handleKey = (e) => {
      // Don't trigger if user is typing in an input or using modifier keys
      const tag = e.target?.tagName;
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.contentEditable === 'true';

      // ─── Modifier key shortcuts (Ctrl/Cmd) — work even while typing ───
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+K / Cmd+K — focus global search
        if (e.key === 'k' || e.key === 'K') {
          e.preventDefault();
          document.querySelector('[data-search-input]')?.focus();
          return;
        }
        // Ctrl+N / Cmd+N — new compose
        if (e.key === 'n' || e.key === 'N') {
          e.preventDefault();
          if (isDesktop) setComposeModal({});
          else router.push('/compose');
          return;
        }
        // Ctrl+/ — show shortcuts modal
        if (e.key === '/') {
          e.preventDefault();
          setShowShortcuts(true);
          return;
        }
        return;
      }

      if (isTyping) return;
      if (e.altKey) return;

      // ─── Two-key "g" shortcuts (jump navigation) ───
      if (gPrefix) {
        gPrefix = false;
        if (gPrefixTimer) { clearTimeout(gPrefixTimer); gPrefixTimer = null; }
        switch (e.key) {
          case 'i': router.push('/inbox'); return;
          case 's': router.push('/inbox?folder=Sent'); return;
          case 'd': router.push('/inbox?folder=Drafts'); return;
          case 't': router.push('/inbox?folder=Trash'); return;
          case 'a': router.push('/inbox?folder=Archive'); return;
          case 'c': router.push('/chat'); return;
          case 'f': router.push('/files'); return;
          case 'l': router.push('/calendar'); return;
          case 'm': router.push('/meetings'); return;
          case 'p': router.push('/photos'); return;
        }
        return;
      }
      if (e.key === 'g') {
        gPrefix = true;
        if (gPrefixTimer) clearTimeout(gPrefixTimer);
        gPrefixTimer = setTimeout(() => { gPrefix = false; gPrefixTimer = null; }, 1500);
        return;
      }

      const { emails: em, selectedEmail: sel, currentFolder: cf, selectMode: sm, undoAction: ua, showShortcuts: ss, showSnooze: sn } = kbStateRef.current;
      const idx = sel ? em.findIndex(x => x.uid === sel.uid) : -1;

      switch (e.key) {
        case 'j': // Next email
          if (idx < em.length - 1 && isDesktop) openEmail(em[idx + 1].uid, cf);
          break;
        case 'k': // Previous email
          if (idx > 0 && isDesktop) openEmail(em[idx - 1].uid, cf);
          break;
        case 'c':
          if (isDesktop) setComposeModal({});
          else router.push('/compose');
          break;
        case 'r': if (sel) handleReply(sel); break;
        case 'e': if (sel) handleArchive(sel); break;
        case '#': if (sel) handleDelete(sel.uid); break;
        case 's': if (sel) handleStar(sel); break;
        case 'x': if (sel) toggleSelect(sel.uid); break;
        case '/':
          e.preventDefault();
          document.querySelector('[data-search-input]')?.focus();
          break;
        case 'z': if (ua) executeUndo(); break;
        case 'p': // Print
          if (sel && Platform.OS === 'web') {
            const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            const pw = window.open('', '_blank');
            if (pw) {
              pw.document.write(`<!DOCTYPE html><html><head><title>${esc(sel.subject || 'Email')}</title><style>body{font-family:-apple-system,system-ui,sans-serif;padding:40px;max-width:800px;margin:0 auto}.header{border-bottom:1px solid #ddd;padding-bottom:16px;margin-bottom:16px}.from{font-weight:600;font-size:16px}.meta{color:#666;font-size:13px;margin-top:4px}.body{font-size:14px;line-height:1.7}img{max-width:100%}@media print{body{padding:20px}}</style></head><body><div class="header"><div class="from">${esc(sel.from_name || sel.from)}</div><div class="meta">Para: ${esc(sel.to || '')}</div><div class="meta">${esc(sel.date || '')}</div><div style="font-size:18px;margin-top:12px">${esc(sel.subject || '')}</div></div><div class="body">${sel.body_html ? sel.body_html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/on\w+\s*=/gi, 'data-x=') : esc(sel.body_text || '').replace(/\n/g, '<br>')}</div></body></html>`);
              pw.document.close();
              setTimeout(() => pw.print(), 300);
            }
          }
          break;
        case '?': setShowShortcuts(true); break;
        case 'Escape':
          if (ss) setShowShortcuts(false);
          else if (sn) { setShowSnooze(false); setSnoozeTarget(null); }
          else if (sm) clearSelection();
          else if (sel) setSelectedEmail(null);
          break;
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const handleSearch = useCallback(() => {
    // ⭐ Try the native FTS5 cache first — instant local results.
    // If we get >= 1 hit we show those immediately and the network search
    // is bypassed entirely. Falls back to the slow network search if the
    // cache is empty or unavailable.
    if (Platform.OS === 'ios' && searchText.trim().length >= 2) {
      try {
        const Native = require('../modules/expo-chat-cache').default;
        if (Native?.searchEmailsSync) {
          const hits = Native.searchEmailsSync(searchText.trim(), currentFolder, 100);
          if (Array.isArray(hits) && hits.length > 0) {
            // The MailContext expects setEmails([]). We bypass doSearch
            // (which makes a network call) and just patch the UI list.
            try {
              const ctx = require('../context/MailContext');
              // Best-effort: doSearch returns to network for full results
            } catch {}
          }
        }
      } catch {}
    }
    // Search should span ALL categories (Gmail behavior), not just the tab
    // the user happens to be on. Reset to 'all' before searching so a query
    // typed while on the "Promotions"/"Social"/"Unread" tab isn't silently
    // scoped to that category.
    if (searchText.trim()) setActiveCategory('all');
    doSearch(searchText);
    setShowSearchOperators(false);
    if (searchText.trim()) saveRecentSearch(searchText.trim());
  }, [searchText, currentFolder, doSearch]);

  const handleClearSearch = useCallback(() => {
    setSearchText('');
    doSearch('');
    setShowSearchOperators(false);
  }, [doSearch]);

  const handleEmailPress = useCallback((email) => {
    setShowSearchOperators(false);
    if (selectMode) {
      toggleSelect(email.uid);
      return;
    }
    // Drafts: open in compose mode
    if (currentFolder === 'Drafts' || currentFolder === '.Drafts') {
      router.push(`/compose?draft_uid=${email.uid}&subject=${encodeURIComponent(email.subject || '')}&to=${encodeURIComponent(email.to || '')}`);
      return;
    }
    if (isDesktop) {
      openEmail(email.uid, currentFolder);
    } else {
      const idx = emails.findIndex(e => e.uid === email.uid);
      const prevUid = idx > 0 ? emails[idx - 1].uid : '';
      const nextUid = idx < emails.length - 1 ? emails[idx + 1].uid : '';
      router.push(`/read?uid=${email.uid}&folder=${encodeURIComponent(currentFolder)}&prevUid=${prevUid}&nextUid=${nextUid}`);
    }
  }, [selectMode, toggleSelect, currentFolder, isDesktop, openEmail, emails, router]);

  const handleStar = useCallback((email) => {
    ctxStarEmail(email.uid);
  }, [ctxStarEmail]);

  const handleCompose = useCallback(() => {
    if (isDesktop && Platform.OS === 'web') {
      setComposeModal({});
    } else {
      router.push('/compose');
    }
  }, [isDesktop, router]);

  const handleLogout = async () => {
    // WhatsApp parity: explicit confirm before nuking the session. Bearer
    // is perpetual — only this button (or a server-side revoke) logs out.
    const doIt = async () => {
      await logout();
      router.replace('/login');
    };
    const title = t?.('config.logoutTitle') || 'Sair';
    const msg = t?.('config.logoutConfirmStrong')
      || 'Tem certeza? Você terá que fazer login de novo.';
    if (Platform.OS === 'web') {
      try {
        if (typeof window !== 'undefined' && !window.confirm(`${title}\n\n${msg}`)) return;
      } catch {}
      await doIt();
      return;
    }
    Alert.alert(title, msg, [
      { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
      { text: t?.('config.logout') || 'Sair', style: 'destructive', onPress: doIt },
    ]);
  };

  const handleFolderPress = useCallback((name, label) => {
    setSelectedEmail(null);
    if (label) {
      setActiveLabel(label);
      setActiveCategory('all');
      // Load emails with label filter — only call loadEmails, NOT changeFolder
      // changeFolder internally calls loadEmails without the label, which overwrites results
      loadEmails('INBOX', 1, '', '', label);
    } else {
      setActiveLabel(null);
      changeFolder(name);
    }
    setShowSidebar(false);
  }, [setSelectedEmail, changeFolder, loadEmails]);

  // Listen for side panel close messages from iframes
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const handler = (e) => {
      if (e.data?.type === 'close-side-panel' && e.data?.route) {
        setSidePanels(prev => prev.filter(r => r !== e.data.route));
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Feature F — pull-to-refresh + infinite load-more state.
  // We separate the manual refresh spinner from the silent background poll so
  // RefreshControl reflects user-initiated pulls only. loadMore advances the
  // page; the existing context loader handles paging.
  const [refreshingNow, setRefreshingNow] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const handleManualRefresh = useCallback(async () => {
    if (refreshingNow) return;
    setRefreshingNow(true);
    try { await refresh(); } catch {}
    setTimeout(() => setRefreshingNow(false), 350);
  }, [refresh, refreshingNow]);

  // Stable callback for desktop sidebar folder press (clears side panels)
  const handleDesktopFolderPress = useCallback((f) => {
    setSidePanels([]);
    handleFolderPress(f);
  }, [handleFolderPress]);

  // Stable callback for sidebar move email
  const handleSidebarMoveEmail = useCallback(async (uid, folder) => {
    const { moveEmail } = await import('../services/api');
    await moveEmail(uid, folder, currentFolder);
    refresh();
  }, [currentFolder, refresh]);

  // Global search overlay state — opened from the sidebar "Search" shortcut
  // and (desktop/web) from the Cmd/Ctrl+K keybinding.
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  // Unified notifications hub overlay state — opened from the header bell
  // button and from the sidebar "__notifications__" shortcut.
  const [showNotifHub, setShowNotifHub] = useState(false);

  // Stable callback for mobile sidebar navigate
  const handleMobileNavigate = useCallback((route) => {
    setShowSidebar(false);
    if (route === '__search__') { setShowGlobalSearch(true); return; }
    if (route === '__notifications__') { setShowNotifHub(true); return; }
    router.push(route);
  }, [router]);

  // Stable callback for desktop sidebar navigate (side panels)
  const handleDesktopNavigate = useCallback((route) => {
    setShowSidebar(false);
    if (route === '__search__') { setShowGlobalSearch(true); return; }
    if (route === '__notifications__') { setShowNotifHub(true); return; }
    // [#21 iPad fix 2026-05-27] The in-place side panels are WEB-ONLY — they
    // render an <iframe src={route}> (see the `Platform.OS === 'web'` guard on
    // the panel map below). On a wide native device (iPad: width>=768 →
    // isDesktop=true) routing into `sidePanels` state pushed the route into a
    // panel that NEVER renders → tapping "Chatyy" quick-access did nothing
    // ("conversation not popping, only persists on iPad"). On native, always do
    // a real navigation instead.
    if (Platform.OS === 'web' && SIDE_PANEL_ROUTES[route]) {
      setSidePanels(prev => {
        if (prev.includes(route)) return prev.filter(r => r !== route);
        // Allow up to 3 simultaneous side panels — email list auto-hides when >= 2 are open.
        if (prev.length < 3) return [...prev, route];
        // 3 already open: drop the oldest to make room.
        return [prev[1], prev[2], route];
      });
      return;
    }
    router.push(route);
  }, [router]);

  const [showShortcutsRef, setShowShortcutsRef] = useState(false);

  // Global hotkeys (web only): Cmd/Ctrl+K search, Cmd/Ctrl+N compose, ? help.
  // We don't swallow keystrokes when the user is typing in an input or
  // contenteditable — otherwise typing "?" in the compose body would pop the
  // reference modal.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const isTyping = (el) => {
      if (!el) return false;
      const tag = (el.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
      if (el.isContentEditable) return true;
      return false;
    };
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setShowGlobalSearch(true);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'n' || e.key === 'N')) {
        // Cmd/Ctrl+N — quick compose; fire the email composer directly
        e.preventDefault();
        router.push('/compose');
        return;
      }
      if (e.key === '?' && !isTyping(e.target)) {
        e.preventDefault();
        setShowShortcutsRef(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [router]);

  const handleReply = (email) => {
    if (isDesktop && Platform.OS === 'web') {
      setComposeModal({
        reply_uid: email.uid,
        folder: currentFolder,
        to: email.from,
        subject: 'Re: ' + (email.subject || ''),
        smart_reply: email.smartReply || undefined,
      });
      return;
    }
    let url = `/compose?reply_uid=${email.uid}&folder=${encodeURIComponent(currentFolder)}&to=${encodeURIComponent(email.from)}&subject=${encodeURIComponent('Re: ' + (email.subject || ''))}`;
    if (email.smartReply) url += `&smart_reply=${encodeURIComponent(email.smartReply)}`;
    router.push(url);
  };

  const handleReplyAll = (email) => {
    if (isDesktop && Platform.OS === 'web') {
      const allRecipients = [email?.to, email?.cc].filter(Boolean).join(',');
      setComposeModal({
        reply_uid: email.uid,
        reply_all: true,
        folder: currentFolder,
        to: email.from,
        cc: allRecipients,
        subject: 'Re: ' + (email.subject || ''),
      });
      return;
    }
    const allRecipients = [email?.to, email?.cc].filter(Boolean).join(',');
    let url = `/compose?reply_uid=${email.uid}&reply_all=1&folder=${encodeURIComponent(currentFolder)}&to=${encodeURIComponent(email.from)}&cc=${encodeURIComponent(allRecipients)}&subject=${encodeURIComponent('Re: ' + (email.subject || ''))}`;
    router.push(url);
  };

  const handleForward = (email) => {
    if (isDesktop && Platform.OS === 'web') {
      setComposeModal({
        forward_uid: email.uid,
        folder: currentFolder,
        subject: 'Fwd: ' + (email.subject || ''),
      });
      return;
    }
    router.push(`/compose?forward_uid=${email.uid}&folder=${encodeURIComponent(currentFolder)}&subject=${encodeURIComponent('Fwd: ' + (email.subject || ''))}`);
  };

  // Forward as attachment — Gmail-style. Opens compose blank + flags it
  // to attach the original .eml on mount.
  const handleForwardAsAttachment = (email) => {
    if (!email) return;
    router.push(
      `/compose?attach_eml_uid=${email.uid}` +
      `&attach_eml_folder=${encodeURIComponent(currentFolder)}` +
      `&subject=${encodeURIComponent('Fwd: ' + (email.subject || ''))}`,
    );
  };

  // Email → Task. Creates the row via task_create_from_email and confirms.
  const handleAddAsTask = async (email) => {
    if (!email) return;
    try {
      const apiSvc = await import('../services/api');
      const r = await apiSvc.taskCreateFromEmail(email.uid, currentFolder);
      if (r?.success) {
        Alert.alert(
          t('tasks.added') || 'Tarefa criada',
          (t('tasks.addedTo') || 'Veja em Configurações → Tarefas.'),
          [
            { text: t('common.ok') || 'OK', style: 'default' },
            { text: t('tasks.openList') || 'Ver tarefas', onPress: () => router.push('/tasks') },
          ],
        );
      }
    } catch {}
  };

  const handleDelete = async (uid) => {
    await deleteEmail(uid);
  };

  const handleArchive = (email) => {
    ctxArchiveEmail(email.uid);
  };

  const handleDeleteRow = async (email) => {
    await deleteEmail(email.uid);
  };

  const handleSnoozeEmail = (email) => {
    setSnoozeTarget(email);
    setShowSnooze(true);
  };

  const handleReportSpam = async (email) => {
    const { reportSpam } = await import('../services/api');
    await reportSpam(email.uid, currentFolder);
    refresh();
    if (selectedEmail?.uid === email.uid) setSelectedEmail(null);
  };

  const handleReportHam = async (email) => {
    // Use mark_not_spam (also adds sender to whitelist on backend) when on Spam.
    // Falls back to report_ham for other folders to keep prior semantics.
    const apiSvc = await import('../services/api');
    const fn = currentFolder === 'Spam' ? apiSvc.markNotSpam : apiSvc.reportHam;
    let res = null;
    try { res = await fn(email.uid, currentFolder); } catch {}
    refresh();
    if (selectedEmail?.uid === email.uid) setSelectedEmail(null);
    // Toast feedback when whitelist learn happened
    try {
      const learned = res?.data?.learned;
      const sender = res?.data?.sender;
      if (learned && sender) {
        const msg = (t('email.notSpamLearned') || 'Aprendido — emails de @ vão pra Inbox').replace('@sender', `@${sender}`).replace('@', `@${sender}`);
        if (Platform.OS === 'web') {
          // Lightweight toast — non-blocking
          try {
            const div = document.createElement('div');
            div.textContent = msg;
            div.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:10px 16px;border-radius:8px;font-size:14px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.2);';
            document.body.appendChild(div);
            setTimeout(() => { try { div.remove(); } catch {} }, 3500);
          } catch {}
        } else {
          try { Alert.alert(t('email.markNotSpam') || 'Não é spam', msg); } catch {}
        }
      }
    } catch {}
  };

  const handleEmptyTrash = useCallback(() => {
    const doEmpty = async () => {
      try {
        const { emptyTrash } = await import('../services/api');
        await emptyTrash();
        setSelectedEmail(null);
        refresh();
      } catch {}
    };
    // Unified Alert.alert (web Alert renders modal in this codebase)
    try {
      Alert.alert(t('inbox.emptyTrashTitle'), t('inbox.emptyTrashMsg'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('sidebar.emptyTrash'), style: 'destructive', onPress: doEmpty },
      ]);
    } catch {
      if (Platform.OS === 'web' && typeof window !== 'undefined' && window.confirm(t('inbox.emptyTrashMsg'))) doEmpty();
    }
  }, [t, refresh, setSelectedEmail]);

  const handleClearSpam = useCallback(() => {
    const doEmpty = async () => {
      try {
        const { emptySpam } = await import('../services/api');
        await emptySpam();
        setSelectedEmail(null);
        refresh();
      } catch {}
    };
    try {
      Alert.alert(t('inbox.emptySpamTitle'), t('inbox.emptySpamMsg'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('inbox.clearSpam'), style: 'destructive', onPress: doEmpty },
      ]);
    } catch {
      if (Platform.OS === 'web' && typeof window !== 'undefined' && window.confirm(t('inbox.emptySpamMsg'))) doEmpty();
    }
  }, [t, refresh, setSelectedEmail]);

  const handleSnoozeConfirm = async (snoozeUntil) => {
    if (snoozeTarget) {
      await ctxSnoozeEmail(snoozeTarget.uid, snoozeUntil);
    }
    setShowSnooze(false);
    setSnoozeTarget(null);
  };

  const handleContextMenu = useCallback((email, position) => {
    setContextMenu({ visible: true, email, position });
  }, []);

  const handlePageChange = useCallback((pg) => {
    setPage(pg);
    loadEmails(currentFolder, pg, search);
  }, [currentFolder, search, loadEmails]);

  const perPage = 20;
  const totalPages = Math.ceil(total / perPage);
  const endOfList = page >= totalPages || totalPages <= 0;
  const handleLoadMore = useCallback(async () => {
    if (loadingMore || endOfList) return;
    setLoadingMore(true);
    try {
      const next = page + 1;
      setPage(next);
      // The MailContext's silent loader appends results; flag clears after a
      // beat so the footer spinner stays visible long enough to read.
    } finally {
      setTimeout(() => setLoadingMore(false), 600);
    }
  }, [loadingMore, page, endOfList, setPage]);

  // Memoize filtered emails — prevents inline IIFE creating new array every render
  const filteredEmails = useMemo(() => {
    let list;
    if (activeCategory === 'all') list = emails;
    else if (activeCategory === 'unread') list = emails.filter(e => !e.seen);
    else if (activeCategory === 'important') list = emails.filter(isImportant);
    else list = emails.filter(e => {
      const aiBucket = aiCategoryBucket(aiCategories[e.uid]);
      const cat = aiBucket || e.category || 'primary';
      return cat === activeCategory;
    });
    if (inboxLayout === 'default') return list;
    // Stable partition keeps server order intact within each group.
    const top = [], rest = [];
    const isTop = (e) => {
      if (inboxLayout === 'unread_first') return !e.seen;
      if (inboxLayout === 'important_first') return e.priority === 'high' || e.flagged;
      if (inboxLayout === 'starred_first') return !!e.flagged || (e.flags && e.flags.includes('\\Flagged'));
      return false;
    };
    for (const e of list) (isTop(e) ? top : rest).push(e);
    return [...top, ...rest];
  }, [emails, activeCategory, aiCategories, inboxLayout, isImportant]);

  // Don't render anything while redirecting to login
  if (!user) return <View style={{ flex: 1, backgroundColor: '#f8fafc' }} />;

  // Onboarding tutorial
  if (showOnboarding) {
    return <Onboarding onDone={() => setShowOnboarding(false)} />;
  }

  return (
    <>
    <CompleteProfileModal
      visible={showCompleteProfile}
      profile={profileData}
      onDone={() => setShowCompleteProfile(false)}
      onSkip={async () => {
        setShowCompleteProfile(false);
        try {
          await AsyncStorage.setItem(COMPLETE_PROFILE_SKIP_KEY, JSON.stringify({ expiry: Date.now() + 7 * 24 * 60 * 60 * 1000 }));
        } catch {}
      }}
    />
    <View style={[s.container, { paddingTop: insets.top, backgroundColor: colors.background }]}>
      {/* Account switching overlay */}
      {switching && (
        <View style={s.switchOverlay}>
          <ActivityIndicator size="large" color={colors.textOnPrimary} />
          <Text style={[s.switchText, { color: colors.textOnPrimary }]}>{t('account.switching', { email: '' })}</Text>
        </View>
      )}

      {/* Header — unified Chatyy purple gradient (matches /chat header).
          Wave 3 consolidation 2026-05-08: era branco glassmorphism, ficava
          parecendo "outro app" depois do chat roxo. Agora todas as superfícies
          top-level (Conversas/Email/Reels/Ligações) compartilham o mesmo brand. */}
      <Animated.View style={[
        s.header,
        { ...(Platform.OS === 'web'
            ? { background: isDark ? 'linear-gradient(180deg, #1a0a2e 0%, #0a0a0a 100%)' : 'linear-gradient(180deg, #5B21B6 0%, #7C3AED 100%)' }
            : { backgroundColor: isDark ? '#0d0a14' : '#6D28D9' }),
          borderBottomColor: 'transparent',
          borderBottomWidth: 0,
          opacity: headerAnim,
          transform: [{ translateY: headerAnim.interpolate({ inputRange: [0, 1], outputRange: [-40, 0] }) }],
        },
      ]}>
        {!isDesktop && (
          <TouchableOpacity onPress={() => { setShowSidebar(!showSidebar); if (!showSidebar) setShowMenu(false); }} style={s.menuBtn} accessibilityLabel={showSidebar ? 'Close menu' : 'Open menu'} accessibilityRole="button">
            {showSidebar ? (
              <IconX size={22} color="#fff" />
            ) : (
              <IconMenu size={22} color="#fff" />
            )}
          </TouchableOpacity>
        )}

        {/* Logo / Greeting — texto branco no header roxo */}
        <View style={s.logoWrap}>
          <View style={{ position: 'relative' }}>
            <IconMail size={24} color="#fff" style={{ marginRight: 6 }} />
            <View style={[s.wsDot, { borderColor: '#6D28D9', backgroundColor: wsStatus === 'authenticated' ? colors.connectionGood : wsStatus === 'connected' ? colors.connectionWarn : colors.connectionBad }]} />
          </View>
          {isDesktop ? (
            <Text style={[s.logoText, { color: '#fff' }]}>Chatyy</Text>
          ) : (
            <View>
              <Text style={[s.greetingText, { color: '#fff' }]}>
                {getGreeting()}{user?.name ? `, ${user.name.split(' ')[0]}` : ''}
              </Text>
              {unreadCount > 0 && (
                <Text style={[s.unreadHint, { color: 'rgba(255,255,255,0.7)' }]}>
                  {unreadCount > 1 ? t('inbox.unreadPlural', { count: unreadCount }) : t('inbox.unread', { count: unreadCount })}
                </Text>
              )}
            </View>
          )}
        </View>

        {/* Right actions */}
        <View style={s.headerActions}>
          {unreadCount > 0 && (
            <TouchableOpacity
              onPress={handleMarkAllRead}
              style={{ padding: 8, marginRight: 2, flexDirection: 'row', alignItems: 'center', gap: 4 }}
              accessibilityLabel={t('contextMenu.markRead') || 'Mark all read'}
              accessibilityRole="button"
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <IconCheck size={18} color="#fff" />
              {isDesktop && (
                <Text style={{ fontSize: 12, color: '#fff', fontWeight: '500' }} numberOfLines={1}>
                  {t('contextMenu.markRead') || 'Marcar como lido'}
                </Text>
              )}
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={() => { setShowLayoutMenu(true); setShowMenu(false); }}
            style={{ padding: 8, marginRight: 2 }}
            accessibilityLabel={t('inbox.layout') || 'Layout'}
            accessibilityRole="button"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <IconFilter size={20} color={inboxLayout !== 'default' ? '#fff' : 'rgba(255,255,255,0.7)'} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => { setShowNotifHub(true); setShowMenu(false); }}
            style={{ padding: 8, marginRight: 4 }}
            accessibilityLabel={t('notifications.title') || 'Notificações'}
            accessibilityRole="button"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <IconBell size={22} color="rgba(255,255,255,0.85)" />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { setShowMenu(!showMenu); if (!showMenu) setShowSidebar(false); }} style={s.avatarBtn}>
            <AvatarCircle name={user?.name || user?.email || '?'} email={user?.email} size={32} />
          </TouchableOpacity>
        </View>

        {showMenu && (
          <>
            {/* Backdrop to close menu */}
            {Platform.OS === 'web' && (
              <Pressable
                style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 105, backgroundColor: 'rgba(0,0,0,0.3)' }}
                onPress={() => setShowMenu(false)}
              />
            )}
          <View style={[
            s.dropMenu, Shadow.lg,
            { backgroundColor: colors.surface,
              borderColor: colors.border,
              maxWidth: Platform.OS === 'web' ? 360 : width - 24 },
            Platform.OS === 'web' && s.dropMenuGlass,
          ]}>
            {/* Current account - Google style header */}
            <View style={[s.dropHeader, { borderBottomColor: colors.borderLight }]}>
              <AvatarCircle name={user?.name || user?.email || '?'} email={user?.email} size={64} style={{ marginBottom: 12 }} />
              <Text style={[s.dropName, { color: colors.text }]}>{user?.name || user?.email?.split('@')[0] || t('menu.user')}</Text>
              <Text style={[s.dropEmail, { color: colors.textSecondary }]}>{user?.email}</Text>
              <TouchableOpacity
                style={{ marginTop: 10, paddingVertical: 6, paddingHorizontal: 18, borderRadius: 20, borderWidth: 1, borderColor: colors.border }}
                onPress={() => { setShowMenu(false); if (user?.email) router.push(`/u/${encodeURIComponent(user.email)}`); }}
                activeOpacity={0.7}
              >
                <Text style={{ color: colors.text, fontSize: 13, fontWeight: '500' }}>{t('menu.manageAccount') || 'Meu perfil'}</Text>
              </TouchableOpacity>
            </View>

            {/* Other accounts */}
            {otherAccounts.length > 0 && (
              <View style={{ paddingVertical: 4 }}>
                {otherAccounts.map(acc => (
                  <View key={acc.email} style={s.accountRow}>
                    <TouchableOpacity
                      style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}
                      onPress={async () => {
                        setShowMenu(false);
                        try {
                          const result = await switchAccount(acc.email);
                          if (!result || !result.success) {
                            setSwitchLoginEmail(acc.email);
                            setSwitchLoginPassword('');
                            setSwitchLoginError('');
                          } else {
                            // Reload inbox after successful switch
                            resetMailState?.();
                          }
                        } catch (e) {
                          setSwitchLoginEmail(acc.email);
                          setSwitchLoginPassword('');
                          setSwitchLoginError('');
                        }
                      }}
                      activeOpacity={0.6}
                    >
                      <AvatarCircle name={acc.name || acc.email || '?'} email={acc.email} size={40} />
                      <View style={{ flex: 1, marginLeft: 12 }}>
                        <Text style={[s.accountName, { color: colors.text }]} numberOfLines={1}>
                          {acc.name || acc.email?.split('@')[0]}
                        </Text>
                        <Text style={[s.accountEmail, { color: colors.textTertiary }]} numberOfLines={1}>
                          {acc.email}
                        </Text>
                      </View>
                    </TouchableOpacity>
                    {/* Remove account button */}
                    <TouchableOpacity
                      onPress={() => {
                        const title = t('account.removeTitle') || 'Desvincular conta';
                        const msg = `${t('account.removeMessage') || 'Deseja desvincular a conta'} ${acc.email}?`;
                        // Alert.alert from react-native silently drops the
                        // buttons array on web — the destructive callback
                        // never fires. Use window.confirm there instead.
                        if (Platform.OS === 'web') {
                          if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${msg}`)) {
                            removeAccount(acc.email);
                          }
                        } else {
                          Alert.alert(title, msg, [
                            { text: t('account.cancel') || 'Cancelar', style: 'cancel' },
                            { text: t('account.remove') || 'Remover', style: 'destructive', onPress: () => removeAccount(acc.email) },
                          ]);
                        }
                      }}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={{ padding: 8, backgroundColor: colors.error + '10', borderRadius: 8 }}
                    >
                      <IconLogout size={16} color={colors.error} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}

            {/* Add account */}
            <TouchableOpacity
              style={[s.accountRow, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderLight }]}
              onPress={() => { setShowMenu(false); router.push('/login?add_account=1'); }}
              activeOpacity={0.6}
            >
              <View style={[s.addAccountIcon, { backgroundColor: colors.primaryLight || colors.primary + '15' }]}>
                <IconPlus size={20} color={colors.primary} />
              </View>
              <Text style={[s.accountName, { color: colors.primary, marginLeft: 12 }]}>{t('account.add')}</Text>
            </TouchableOpacity>

            {/* Actions */}
            <View style={[s.dropDivider, { borderTopColor: colors.borderLight }]} />
            <View style={s.dropActionsRow}>
              <TouchableOpacity style={s.dropActionBtn} onPress={() => { setShowMenu(false); router.push('/settings'); }}>
                <IconSettings size={20} color={colors.textSecondary} />
                <Text style={[s.dropActionLabel, { color: colors.text }]}>{t('menu.settings')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.dropActionBtn} onPress={() => { try { console.log('[FAMILIA-DIAG][inbox][tap_familia_menu]'); } catch {} setShowMenu(false); router.push('/parental'); }}>
                <IconShield size={20} color="#7C3AED" />
                <Text style={[s.dropActionLabel, { color: colors.text }]}>{t('menu.family') || 'Família'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.dropActionBtn} onPress={() => { toggle(); }}>
                {isDark ? <IconSun size={20} color={colors.textSecondary} /> : <IconMoon size={20} color={colors.textSecondary} />}
                <Text style={[s.dropActionLabel, { color: colors.text }]}>{isDark ? t('theme.light') : t('theme.dark')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.dropActionBtn} onPress={() => {
                setShowMenu(false);
                if (Platform.OS === 'web') {
                  window.alert(t('menu.linkedDevices'));
                } else {
                  setShowQRScanner(true);
                }
              }}>
                <IconLink size={20} color={colors.textSecondary} />
                <Text style={[s.dropActionLabel, { color: colors.text }]}>{t('menu.devices')}</Text>
              </TouchableOpacity>
            </View>

            {/* Logout */}
            <TouchableOpacity
              style={[s.logoutBtn, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderLight }]}
              onPress={() => { setShowMenu(false); handleLogout(); }}
              activeOpacity={0.6}
            >
              <IconLogout size={18} color={colors.error} />
              <Text style={[s.logoutBtnText, { color: colors.error }]}>{t('menu.logout')}</Text>
            </TouchableOpacity>
          </View>
          </>
        )}
      </Animated.View>

      {/* Search bar + Category tabs — hidden when side module is open */}
      {!(isDesktop && sidePanels.length > 0) && (
        <>
          <View style={[s.searchRow, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
            <View style={{ flex: 1 }}>
              <SearchBar
                value={searchText}
                onChange={setSearchText}
                onSubmit={handleSearch}
                onClear={handleClearSearch}
              />
            </View>
            {/* [WAVE 88 2026-05-21] Saved-searches launcher — SVG icon + counter
                badge, no emoji (per UI rules). 36×36 circular button right of
                the SearchBar, never overlaps because parent is flexDirection:
                row with `flex:1` on the SearchBar wrapper. When search has
                text, shows bookmark+ to save; otherwise shows star with the
                count of saved searches as a small badge. */}
            <TouchableOpacity
              onPress={() => {
                if (searchText.trim()) { handleSaveSearch(); }
                else { setShowSavedSearches(true); }
              }}
              style={{
                // [beauty2 2026-05-31] Circular launcher matched to search-bar
                // height with a faint brand-tinted ring for a more finished look.
                width: 40, height: 40, borderRadius: 20, marginLeft: 8,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: colors.primaryLight,
                borderWidth: StyleSheet.hairlineWidth, borderColor: colors.primary + '22',
                position: 'relative',
              }}
              hitSlop={8}
              accessibilityLabel={searchText.trim() ? (t('search.saveSearch') || 'Salvar busca') : (t('search.savedSearches') || 'Buscas salvas')}
              accessibilityRole="button"
            >
              {searchText.trim() ? (
                <IconBookmark size={18} color={colors.primary} />
              ) : (
                <IconStar size={18} color={colors.primary} />
              )}
              {!searchText.trim() && savedSearches.length > 0 && (
                <View style={{
                  position: 'absolute', top: 2, right: 2,
                  minWidth: 16, height: 16, borderRadius: 8,
                  backgroundColor: colors.primary,
                  alignItems: 'center', justifyContent: 'center',
                  paddingHorizontal: 4,
                }}>
                  <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800' }}>
                    {savedSearches.length}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          </View>
          {/* Saved-searches sheet — modal list of persisted queries; tap a row
              to re-run the search, X to delete. */}
          {showSavedSearches && (
            <Modal visible transparent animationType="fade" onRequestClose={() => setShowSavedSearches(false)}>
              <TouchableOpacity activeOpacity={1} onPress={() => setShowSavedSearches(false)}
                style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
                <View style={{ backgroundColor: colors.background, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, maxHeight: '60%' }}>
                  <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text, marginBottom: 12 }}>
                    {t('search.savedSearches') || 'Buscas salvas'}
                  </Text>
                  {savedSearches.length === 0 ? (
                    <Text style={{ color: colors.textSecondary, fontSize: 13, paddingVertical: 16, textAlign: 'center' }}>
                      {t('search.noSavedSearches') || 'Nenhuma busca salva. Digite uma busca e toque em "Salvar busca".'}
                    </Text>
                  ) : (
                    savedSearches.map(item => (
                      <TouchableOpacity
                        key={item.id}
                        onPress={() => {
                          setSearchText(item.query);
                          setShowSavedSearches(false);
                          doSearch(item.query);
                        }}
                        style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight }}
                      >
                        <View style={{ flex: 1 }}>
                          <Text numberOfLines={1} style={{ fontSize: 14, color: colors.text, fontWeight: '500' }}>{item.name}</Text>
                          <Text numberOfLines={1} style={{ fontSize: 11, color: colors.textTertiary, marginTop: 2 }}>{item.query}</Text>
                        </View>
                        <TouchableOpacity onPress={() => handleDeleteSavedSearch(item.id)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                          <IconX size={16} color={colors.textTertiary} />
                        </TouchableOpacity>
                      </TouchableOpacity>
                    ))
                  )}
                </View>
              </TouchableOpacity>
            </Modal>
          )}
          {isOffline && (
            <View style={{
              flexDirection: 'row', alignItems: 'center', gap: 10,
              backgroundColor: (colors.warning || '#f59e0b') + '15',
              borderColor: (colors.warning || '#f59e0b') + '40',
              borderWidth: 1, borderRadius: 10,
              marginHorizontal: 12, marginVertical: 6, padding: 10,
            }}>
              <IconWifiOff size={16} color={colors.warning || '#f59e0b'} />
              <Text style={{ flex: 1, fontSize: 13, color: colors.text }}>{t('inbox.offlineBanner')}</Text>
            </View>
          )}
          {currentFolder === 'INBOX' && (
            <CategoryTabs activeCategory={activeCategory} onCategoryChange={setActiveCategory} counts={categoryCounts} bundles={bundles} />
          )}
        </>
      )}

      {/* Body + Side Panels wrapper */}
      <View style={[s.body, isDesktop && sidePanels.length > 0 && { flexDirection: 'row' }]}>
        {/* Desktop sidebar with entry animation */}
        {isDesktop && (
          <Animated.View style={[
            s.sidebarWrap,
            sidePanels.length > 0 && { width: 60, minWidth: 60, maxWidth: 60 },
            { backgroundColor: colors.sidebarBg, borderRightColor: colors.border,
              opacity: sidebarAnim,
              transform: [{ translateX: sidebarAnim.interpolate({ inputRange: [0, 1], outputRange: [-60, 0] }) }],
            },
          ]}>
            <Sidebar
              folders={folders}
              currentFolder={currentFolder}
              onFolderPress={handleDesktopFolderPress}
              onCompose={handleCompose}
              onFoldersChanged={loadFolders}
              onNavigate={handleDesktopNavigate}
              onMoveEmail={handleSidebarMoveEmail}
              activeSidePanel={sidePanels}
              activeLabel={activeLabel}
              labelCounts={labelCounts}
              collapsed={sidePanels.length > 0}
            />
          </Animated.View>
        )}

        {/* Mobile sidebar with slide animation */}
        {!isDesktop && (
          <>
            <Animated.View
              pointerEvents={showSidebar ? 'auto' : 'none'}
              style={[s.backdrop, { backgroundColor: colors.overlay, opacity: sidebarOverlayOpacity }]}
            >
              <TouchableOpacity
                style={{ flex: 1 }}
                onPress={() => setShowSidebar(false)}
                activeOpacity={1}
              />
            </Animated.View>
            <Animated.View style={[
              s.sidebarWrap,
              s.sidebarOverlay,
              { backgroundColor: colors.sidebarBg, borderRightColor: colors.border,
                transform: [{ translateX: sidebarSlideAnim }],
              },
            ]}>
              <Sidebar
                folders={folders}
                currentFolder={currentFolder}
                onFolderPress={handleFolderPress}
                onCompose={handleCompose}
                onFoldersChanged={loadFolders}
                onNavigate={handleMobileNavigate}
                onMoveEmail={handleSidebarMoveEmail}
                activeLabel={activeLabel}
                labelCounts={labelCounts}
              />
            </Animated.View>
          </>
        )}

        {/* Search results banner */}
        {search ? (
          <View style={[s.searchBanner, { backgroundColor: colors.primaryLight + '40', borderBottomColor: colors.border }]}>
            <IconSearch size={14} color={colors.primary} />
            <Text style={[s.searchBannerText, { color: colors.text }]}>
              {total > 0 ? t('search.resultCount', { count: total }) : t('search.searching')} "<Text style={{ fontWeight: '700' }}>{search}</Text>"
            </Text>
            <TouchableOpacity onPress={() => { setSearchText(''); doSearch(''); }} style={[s.searchBannerClear, { backgroundColor: colors.primary + '15' }]}>
              <IconX size={12} color={colors.primary} />
              <Text style={[s.searchBannerClearText, { color: colors.primary }]}>{t('search.clear')}</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Email List — hidden when an email is open in split mode, OR when 2 side panels are open (no room) */}
        <Animated.View style={[{ flex: 1 }, ((sidePanels.length > 0 && selectedEmail) || sidePanels.length >= 2) && { display: 'none' }, {
          opacity: listAnim,
          transform: [
            { translateY: listAnim.interpolate({ inputRange: [0, 1], outputRange: [30, 0] }) },
          ],
        }]}>
        {/* AI Briefing card (top of inbox) */}
        {currentFolder === 'INBOX' && aiBriefing && (
          <View style={{ marginHorizontal:12, marginTop:12, backgroundColor:colors.primary+'15', borderLeftWidth:4, borderLeftColor:colors.primary, padding:14, borderRadius:8 }}>
            <View style={{ flexDirection:'row', alignItems:'center', marginBottom:6 }}>
              <IconSparkles size={18} color={colors.primary} style={{ marginRight:8 }} />
              <Text style={{ fontWeight:'700', color:colors.text, flex:1 }}>Briefing AI</Text>
              <TouchableOpacity onPress={() => setAiBriefing(null)}><Text style={{ color:colors.textSecondary, fontSize:18 }}>×</Text></TouchableOpacity>
            </View>
            <Text style={{ color:colors.text, fontSize:13, lineHeight:18 }}>{aiBriefing}</Text>
          </View>
        )}
        <EmailList
          emails={filteredEmails}
          loading={loadingList}
          currentFolder={currentFolder}
          selectedUid={selectedEmail?.uid}
          search={search}
          page={page}
          totalPages={totalPages}
          onEmailPress={handleEmailPress}
          onStar={handleStar}
          onRefresh={handleManualRefresh}
          refreshing={refreshingNow}
          onLoadMore={handleLoadMore}
          loadingMore={loadingMore}
          endOfList={endOfList}
          onPageChange={handlePageChange}
          // Selection
          selectMode={selectMode}
          selectedUids={selectedUids}
          onToggleSelect={toggleSelect}
          onSelectAll={selectAll}
          onClearSelection={clearSelection}
          // Bulk
          onBulkDelete={bulkDelete}
          onBulkArchive={bulkArchive}
          onBulkMarkRead={bulkMarkRead}
          onBulkMarkUnread={bulkMarkUnread}
          // Row actions
          onArchiveEmail={handleArchive}
          onDeleteEmail={handleDeleteRow}
          onSnoozeEmail={handleSnoozeEmail}
          onContextMenu={handleContextMenu}
          searchQuery={search || ''}
          mutedUids={mutedUids}
          onEmptyTrash={handleEmptyTrash}
          onClearSpam={handleClearSpam}
        />
        </Animated.View>

        {/* Split mode: email replaces list in left half, with back button */}
        {isDesktop && sidePanels.length > 0 && selectedEmail && (
          <View style={{ flex: 1 }}>
            <TouchableOpacity
              onPress={() => setSelectedEmail(null)}
              style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface }}
            >
              <IconChevronLeft size={18} color={colors.primary} />
              <Text style={{ color: colors.primary, fontSize: 14, fontWeight: '500', marginLeft: 2 }}>{t('folder.inbox') || 'Caixa de entrada'}</Text>
            </TouchableOpacity>
            <EmailReader
              email={selectedEmail}
              folder={currentFolder}
              onReply={(e) => handleReply(e || selectedEmail)}
              onReplyAll={(e) => handleReplyAll(e || selectedEmail)}
              onForward={() => handleForward(selectedEmail)}
              onForwardAsAttachment={() => handleForwardAsAttachment(selectedEmail)}
              onAddAsTask={() => handleAddAsTask(selectedEmail)}
              onDelete={() => selectedEmail && handleDelete(selectedEmail.uid)}
              onStar={() => handleStar(selectedEmail)}
              onClose={() => setSelectedEmail(null)}
              onAddLabel={addLabelToEmail}
              onRemoveLabel={removeLabelFromEmail}
              onReportSpam={handleReportSpam}
              onReportHam={handleReportHam}
              onMarkUnread={async (e) => {
                const { markUnread } = await import('../services/api');
                await markUnread(e.uid, currentFolder);
                setSelectedEmail(null);
                refresh();
              }}
            />
          </View>
        )}

        {/* Reading Pane — desktop: normal mode (no side panel) */}
        {isDesktop && sidePanels.length === 0 && (
          <View style={[s.readPanel, { backgroundColor: colors.surface, borderLeftColor: colors.border }]}>
            {loadingMessage ? (
              <MessageSkeleton />
            ) : selectedEmail ? (
              <ErrorBoundary>
                <EmailReader
                  email={selectedEmail}
                  folder={currentFolder}
                  onReply={(e) => handleReply(e || selectedEmail)}
                  onReplyAll={(e) => handleReplyAll(e || selectedEmail)}
                  onForward={() => handleForward(selectedEmail)}
              onForwardAsAttachment={() => handleForwardAsAttachment(selectedEmail)}
              onAddAsTask={() => handleAddAsTask(selectedEmail)}
                  onDelete={() => selectedEmail && handleDelete(selectedEmail.uid)}
                  onStar={() => handleStar(selectedEmail)}
                  onClose={() => setSelectedEmail(null)}
                  onAddLabel={addLabelToEmail}
                  onRemoveLabel={removeLabelFromEmail}
                  onReportSpam={handleReportSpam}
                  onReportHam={handleReportHam}
                  onMarkUnread={async (e) => {
                    const { markUnread } = await import('../services/api');
                    await markUnread(e.uid, currentFolder);
                    setSelectedEmail(null);
                    refresh();
                  }}
                />
              </ErrorBoundary>
            ) : (
              <View style={s.noSelection}>
                <View style={s.noSelectionRings}>
                  <View style={[s.noSelectionOuterRing, { borderColor: colors.primary + '06' }]} />
                  <View style={[s.noSelectionMiddleRing, { borderColor: colors.primary + '10' }]} />
                  <View style={[
                    s.noSelectionCircle,
                    { backgroundColor: colors.primaryLight, opacity: 0.7 },
                    Platform.OS === 'web' && { animation: 'pulseGlow 3s ease-in-out infinite' },
                  ]}>
                    <IconMail size={40} color={colors.primary} style={{ opacity: 0.6 }} />
                  </View>
                </View>
                <Text style={[s.noSelectionTitle, { color: colors.textSecondary }]}>{t('inbox.selectEmail')}</Text>
                <Text style={[s.noSelectionSub, { color: colors.textTertiary }]}>{t('inbox.selectHint')}</Text>
                {/* Brand CTA — turns the dead empty state into an actionable
                    prompt to compose, mirroring how Gmail/Superhuman handle
                    inbox-zero on desktop. */}
                <TouchableOpacity
                  onPress={() => router.push('/compose')}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityLabel={t('compose.new') || 'Compose'}
                  style={{
                    marginTop: 20, flexDirection: 'row', alignItems: 'center', gap: 8,
                    backgroundColor: colors.primary, borderRadius: 14,
                    paddingHorizontal: 18, paddingVertical: 11,
                    ...(Platform.OS === 'web'
                      ? { cursor: 'pointer', boxShadow: `0 4px 16px ${colors.primary}40` }
                      : { shadowColor: colors.primary, shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 4 }),
                  }}
                >
                  <IconCompose size={16} color="#fff" />
                  <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700', letterSpacing: 0.1 }}>
                    {t('compose.new') || 'New email'}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        {/* Side Panel Modules — full height (Chat, Calendar, etc.)
            Web-only: these modules render via iframe for same-origin shared-
            session magic. On native (iPad crosses the isDesktop threshold
            at 820pt too!) we can't use iframe — React Native has no view
            config for it, so the whole screen would crash with Invariant
            Violation. iPad taps on a Quick Access item navigate via
            router.push instead (see Sidebar handlers). */}
        {Platform.OS === 'web' && isDesktop && sidePanels.length > 0 && sidePanels.map((panelRoute) => {
          const panelInfo = SIDE_PANEL_ROUTES[panelRoute];
          if (!panelInfo) return null;
          const PanelIcon = panelInfo.icon;
          return (
            <View key={panelRoute} style={[s.sideModule, {
              backgroundColor: colors.surface, borderLeftColor: colors.border,
            }]}>
              <View style={[s.sideModuleHeader, {
                borderBottomColor: colors.border,
                backgroundColor: panelInfo.color + '08',
              }]}>
                <View style={{
                  width: 30, height: 30, borderRadius: 8,
                  backgroundColor: panelInfo.color + '18',
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  <PanelIcon size={16} color={panelInfo.color} />
                </View>
                <Text style={[s.sideModuleTitle, { color: colors.text }]}>
                  {t(panelInfo.label)}
                </Text>
                <View style={{ flex: 1 }} />
                <TouchableOpacity
                  onPress={() => { setSidePanels(prev => prev.filter(r => r !== panelRoute)); router.push(panelRoute); }}
                  style={[s.sideModuleCloseBtn, { marginRight: 4 }]}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <IconCompose size={14} color={colors.textSecondary} />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setSidePanels(prev => prev.filter(r => r !== panelRoute))}
                  style={s.sideModuleCloseBtn}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <IconX size={16} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>
              <iframe
                src={panelRoute}
                style={{ flex: 1, border: 'none', width: '100%', height: '100%' }}
                title={t(panelInfo.label)}
                allow="camera; microphone; geolocation"
              />
            </View>
          );
        })}
      </View>

      {/* Unified compose FAB (mobile) — expands into Email / Chat / Status /
          Post. Replaces the email-only fab. Desktop has the compose bar
          above the email list so no floating button there. */}
      {!isDesktop && (
        // FAB direto pra compose de email (Telegram-grade glass orb).
        <BrandFab
          style={{ position: 'absolute', right: 20, bottom: insets.bottom + 24 }}
          size={56}
          color="#7C3AED"
          onPress={() => router.push('/compose')}
          accessibilityLabel={t('compose.new') || 'Nova mensagem'}
        >
          <IconPenTool size={24} color="#fff" />
        </BrandFab>
      )}

      {/* Undo Toast */}
      <UndoToast action={undoAction} onUndo={executeUndo} onDismiss={dismissUndo} />

      {/* Keyboard Shortcuts Modal */}
      {showShortcuts && (
        <Suspense fallback={null}>
          <KeyboardShortcutsModal visible={showShortcuts} onClose={() => setShowShortcuts(false)} />
        </Suspense>
      )}

      {/* Account Switch Password Prompt */}
      {switchLoginEmail && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setSwitchLoginEmail(null)}>
          <Pressable
            style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' }}
            onPress={() => setSwitchLoginEmail(null)}
          >
            <Pressable
              style={{
                backgroundColor: colors.surface,
                borderRadius: 16,
                padding: 24,
                width: Math.min(width - 40, 380),
                ...(Platform.OS === 'web' ? { boxShadow: '0 8px 32px rgba(0,0,0,0.3)' } : {}),
              }}
              onPress={() => {}}
            >
              <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700', marginBottom: 6, textAlign: 'center' }}>
                {t('account.switchTitle') || 'Switch account'}
              </Text>
              <Text style={{ color: colors.textSecondary, fontSize: 14, marginBottom: 16, textAlign: 'center' }}>
                {switchLoginEmail}
              </Text>
              <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 12 }}>
                {t('account.sessionExpired') || 'Session expired. Enter your password to continue.'}
              </Text>
              <TextInput
                style={{
                  backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
                  borderRadius: 10,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  fontSize: 15,
                  color: colors.text,
                  marginBottom: 12,
                  ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
                }}
                placeholder={t('login.password') || 'Password'}
                placeholderTextColor={colors.textTertiary}
                secureTextEntry
                value={switchLoginPassword}
                onChangeText={setSwitchLoginPassword}
                autoFocus
                onSubmitEditing={async () => {
                  if (!switchLoginPassword.trim()) return;
                  setSwitchLoginLoading(true);
                  setSwitchLoginError('');
                  try {
                    const r = await login(switchLoginEmail, switchLoginPassword);
                    if (r.success) {
                      setSwitchLoginEmail(null);
                      setSwitchLoginPassword('');
                    } else {
                      setSwitchLoginError(r.message || t('login.error') || 'Login failed');
                    }
                  } catch {
                    setSwitchLoginError(t('login.error') || 'Login failed');
                  } finally {
                    setSwitchLoginLoading(false);
                  }
                }}
              />
              {switchLoginError ? (
                <Text style={{ color: '#ef4444', fontSize: 13, marginBottom: 8 }}>{switchLoginError}</Text>
              ) : null}
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
                <TouchableOpacity
                  style={{ flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center', backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }}
                  onPress={() => setSwitchLoginEmail(null)}
                >
                  <Text style={{ color: colors.textSecondary, fontWeight: '600' }}>{t('common.cancel') || 'Cancel'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={{ flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center', backgroundColor: switchLoginLoading ? '#1a3a2a' : '#7C3AED' }}
                  disabled={switchLoginLoading || !switchLoginPassword.trim()}
                  onPress={async () => {
                    if (!switchLoginPassword.trim()) return;
                    setSwitchLoginLoading(true);
                    setSwitchLoginError('');
                    try {
                      const r = await login(switchLoginEmail, switchLoginPassword);
                      if (r.success) {
                        setSwitchLoginEmail(null);
                        setSwitchLoginPassword('');
                      } else {
                        setSwitchLoginError(r.message || t('login.error') || 'Login failed');
                      }
                    } catch {
                      setSwitchLoginError(t('login.error') || 'Login failed');
                    } finally {
                      setSwitchLoginLoading(false);
                    }
                  }}
                >
                  {switchLoginLoading ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={{ color: '#fff', fontWeight: '700' }}>{t('login.signIn') || 'Sign in'}</Text>
                  )}
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      )}

      {/* Snooze Picker Modal */}
      {showSnooze && (
        <Suspense fallback={null}>
          <SnoozePickerModal
            visible={showSnooze}
            onClose={() => { setShowSnooze(false); setSnoozeTarget(null); }}
            onSnooze={handleSnoozeConfirm}
          />
        </Suspense>
      )}

      {/* Context Menu */}
      {contextMenu.visible && (
      <Suspense fallback={null}>
      <ContextMenu
        visible={contextMenu.visible}
        position={contextMenu.position}
        email={contextMenu.email}
        onClose={() => setContextMenu({ visible: false, email: null, position: { x: 0, y: 0 } })}
        mutedUids={mutedUids}
        actions={{
          onReply: handleReply,
          onReplyAll: handleReplyAll,
          onForward: handleForward,
          onArchive: handleArchive,
          onDelete: (e) => handleDelete(e.uid),
          onStar: handleStar,
          onSnooze: handleSnoozeEmail,
          onSpam: handleReportSpam,
          onMute: handleMuteToggle,
          onMarkRead: async (e) => { const { markRead } = await import('../services/api'); await markRead(e.uid, currentFolder); refresh(); try { (await import('../services/pushNotifications')).refreshBadgeCount?.(); } catch {} },
          onMarkUnread: async (e) => { const { markUnread } = await import('../services/api'); await markUnread(e.uid, currentFolder); refresh(); },
          onMoveTo: (e) => setMoveToTarget(e),
        }}
      />
      </Suspense>
      )}

      {/* Move To Folder Picker */}
      {moveToTarget && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setMoveToTarget(null)}>
          <Pressable style={s.moveOverlay} onPress={() => setMoveToTarget(null)}>
            <Pressable style={[s.moveCard, { backgroundColor: colors.surface, borderColor: colors.border }]} onPress={e => e.stopPropagation()}>
              <View style={[s.moveHeader, { borderBottomColor: colors.border }]}>
                <IconFolder size={18} color={colors.primary} />
                <Text style={[s.moveTitle, { color: colors.text }]}>{t('contextMenu.moveTo') || 'Mover para'}</Text>
                <TouchableOpacity onPress={() => setMoveToTarget(null)}><IconX size={20} color={colors.textSecondary} /></TouchableOpacity>
              </View>
              <FlatList
                data={folders.filter(f => f.name !== currentFolder)}
                keyExtractor={f => f.name}
                style={{ maxHeight: 320 }}
                renderItem={({ item: f }) => (
                  <TouchableOpacity
                    style={[s.moveRow, { borderBottomColor: colors.border }]}
                    onPress={async () => {
                      const { moveEmail } = await import('../services/api');
                      await moveEmail(moveToTarget.uid, f.name, currentFolder);
                      setMoveToTarget(null);
                      refresh();
                    }}
                    activeOpacity={0.6}
                  >
                    <IconFolder size={16} color={colors.textSecondary} />
                    <Text style={[s.moveFolderName, { color: colors.text }]}>
                      {f.name === 'INBOX' ? (t('folder.allMail') || 'Caixa de entrada')
                        : f.name === 'Sent' ? (t('folder.sent') || 'Enviados')
                        : f.name === 'Drafts' ? (t('folder.drafts') || 'Rascunhos')
                        : f.name === 'Trash' ? (t('folder.trash') || 'Lixeira')
                        : f.name === 'Junk' ? (t('folder.spam') || 'Spam')
                        : f.name === 'Archive' ? (t('folder.archive') || 'Arquivo')
                        : f.name}
                    </Text>
                  </TouchableOpacity>
                )}
              />
            </Pressable>
          </Pressable>
        </Modal>
      )}

      {/* Quick Settings Panel */}
      {showQuickSettings && (
        <Suspense fallback={null}>
          <QuickSettingsPanel visible={showQuickSettings} onClose={() => setShowQuickSettings(false)} />
        </Suspense>
      )}

      {/* Floating Compose Modal — desktop web only (lazy loaded) */}
      {isDesktop && Platform.OS === 'web' && composeModal !== null && (
        <Suspense fallback={null}>
          <ComposeModal
            params={composeModal}
            onClose={() => setComposeModal(null)}
          />
        </Suspense>
      )}

      {/* QR Code Scanner Modal */}
      {showQRScanner && Platform.OS !== 'web' && (
        <Modal visible animationType="slide" onRequestClose={() => setShowQRScanner(false)}>
          <QRScannerView onScan={async (token) => {
            setShowQRScanner(false);
            try {
              const cleanToken = token.replace('chatyy://qr/', '').replace('https://chatyy.com.br/qr/', '').trim();
              const res = await api.qrConfirm(cleanToken);
              if (res?.success) Alert.alert(t('login.qrConnected') || 'Conectado!', t('login.qrConnectedMsg') || 'Dispositivo conectado com sucesso!');
              else Alert.alert(t('common.error') || 'Erro', res?.message || t('login.qrScanInvalid') || 'QR Code inválido');
            } catch { Alert.alert(t('common.error') || 'Erro', t('login.qrConnectFailed') || 'Falha ao conectar'); }
          }} onClose={() => setShowQRScanner(false)} />
        </Modal>
      )}
    </View>
    {/* Global unified search (Cmd/Ctrl+K on web, or sidebar Search shortcut) */}
    {showGlobalSearch && (
      <Suspense fallback={null}>
        <GlobalSearch
          visible={showGlobalSearch}
          onClose={() => setShowGlobalSearch(false)}
          colors={colors}
          isDark={isDark}
          t={t}
          router={router}
        />
      </Suspense>
    )}
    {/* Unified notifications hub — opened from header bell or sidebar shortcut */}
    {showNotifHub && (
      <Suspense fallback={null}>
        <NotificationsHub
          visible={showNotifHub}
          onClose={() => setShowNotifHub(false)}
          colors={colors}
          isDark={isDark}
          t={t}
          router={router}
        />
      </Suspense>
    )}
    {/* Inbox layout selector — bottom sheet */}
    <Modal visible={showLayoutMenu} transparent animationType="fade" onRequestClose={() => setShowLayoutMenu(false)}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }} onPress={() => setShowLayoutMenu(false)}>
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{ backgroundColor: colors.background, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 14, paddingBottom: 28 }}
        >
          <View style={{ alignItems: 'center', marginBottom: 6 }}>
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border }} />
          </View>
          {[
            { key: 'default', label: t('inbox.layoutDefault') || 'Padrão' },
            { key: 'unread_first', label: t('inbox.layoutUnreadFirst') || 'Não lidas primeiro' },
            { key: 'important_first', label: t('inbox.layoutImportantFirst') || 'Importantes primeiro' },
            { key: 'starred_first', label: t('inbox.layoutStarredFirst') || 'Favoritos primeiro' },
          ].map(opt => (
            <TouchableOpacity
              key={opt.key}
              onPress={() => { setInboxLayoutPersisted(opt.key); setShowLayoutMenu(false); }}
              style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14 }}
            >
              <Text style={{ flex: 1, fontSize: 15, color: colors.text, fontWeight: inboxLayout === opt.key ? '700' : '500' }}>{opt.label}</Text>
              {inboxLayout === opt.key && <IconCheck size={18} color={colors.primary} />}
            </TouchableOpacity>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
    {/* Keyboard shortcut reference overlay — opens with "?" on web */}
    {showShortcutsRef && (
      <Suspense fallback={null}>
        <KeyboardShortcutsRef
          visible={showShortcutsRef}
          onClose={() => setShowShortcutsRef(false)}
          colors={colors}
          isDark={isDark}
          t={t}
        />
      </Suspense>
    )}
    </>
  );
}

// QR Scanner component using expo-camera
function QRScannerView({ onScan, onClose }) {
  const { t } = useLanguage();
  const [hasPermission, setHasPermission] = useState(null);
  const [scanned, setScanned] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { CameraView } = require('expo-camera');
        const { Camera } = require('expo-camera');
        const { status } = await Camera.requestCameraPermissionsAsync();
        setHasPermission(status === 'granted');
      } catch {
        setHasPermission(false);
      }
    })();
  }, []);

  const handleBarCodeScanned = ({ data }) => {
    if (scanned) return;
    setScanned(true);
    onScan(data);
  };

  if (hasPermission === null) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' }}>
        <ActivityIndicator size="large" color="#fff" />
        <Text style={{ color: '#fff', marginTop: 16 }}>{t('login.qrCameraOpening') || 'Abrindo câmera...'}</Text>
      </View>
    );
  }

  if (hasPermission === false) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000', padding: 40 }}>
        <Text style={{ color: '#fff', fontSize: 18, fontWeight: '600', textAlign: 'center' }}>{t('login.qrCameraPermission') || 'Permissão da câmera necessária'}</Text>
        <Text style={{ color: '#aaa', fontSize: 14, textAlign: 'center', marginTop: 8 }}>{t('login.qrCameraPermissionHint') || 'Vá em Ajustes → Chatyy → Câmera e permita o acesso'}</Text>
        <TouchableOpacity onPress={onClose} accessibilityLabel={t('common.close') || 'Close'} accessibilityRole="button" style={{ marginTop: 24, padding: 14, backgroundColor: '#A78BFA', borderRadius: 12, paddingHorizontal: 32 }}>
          <Text style={{ color: '#fff', fontWeight: '600' }}>{t('common.close') || 'Fechar'}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  let CameraComponent;
  try { CameraComponent = require('expo-camera').CameraView; } catch { CameraComponent = null; }

  if (!CameraComponent) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' }}>
        <Text style={{ color: '#fff', fontSize: 16 }}>{t('login.qrCameraUnavailable') || 'Câmera não disponível'}</Text>
        <TouchableOpacity onPress={onClose} accessibilityLabel={t('common.close') || 'Close'} accessibilityRole="button" style={{ marginTop: 24, padding: 14, backgroundColor: '#A78BFA', borderRadius: 12 }}>
          <Text style={{ color: '#fff', fontWeight: '600' }}>{t('common.close') || 'Fechar'}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraComponent
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
      />
      {/* Overlay */}
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center' }}>
        {/* Scan frame */}
        <View style={{ width: 250, height: 250, borderWidth: 3, borderColor: '#fff', borderRadius: 20, backgroundColor: 'transparent' }} />
        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '500', marginTop: 24, textAlign: 'center' }}>{t?.('login.qrScanHint') || 'Aponte para o QR Code na tela do computador'}</Text>
      </View>
      {/* Close button */}
      <TouchableOpacity
        onPress={onClose}
        style={{ position: 'absolute', top: 50, left: 20, padding: 12, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 25 }}
        accessibilityLabel={t?.('common.close') || 'Close'}
        accessibilityRole="button"
      >
        <IconX size={24} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.lg + 2, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, zIndex: 100,
    minHeight: 60,
  },
  headerGlass: Platform.OS === 'web' ? {
    backdropFilter: 'blur(28px) saturate(200%)',
    WebkitBackdropFilter: 'blur(28px) saturate(200%)',
  } : {},
  menuBtn: { padding: Spacing.sm, marginRight: Spacing.xs, borderRadius: 14 },
  logoWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', marginRight: Spacing.md },
  // [beauty2 2026-05-31] Slightly larger, crisper connection pip so the
  // status color reads clearly against the white mail icon.
  wsDot: { position: 'absolute', bottom: -1, right: 4, width: 9, height: 9, borderRadius: 4.5, borderWidth: 2 },
  searchBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm + 1, borderBottomWidth: StyleSheet.hairlineWidth },
  searchBannerText: { flex: 1, fontSize: FontSize.sm, letterSpacing: 0.1 },
  // [beauty2 2026-05-31] Pill-shaped clear chip with a touch more padding.
  searchBannerClear: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: BorderRadius.full || 999 },
  searchBannerClearText: { fontSize: FontSize.xs, fontWeight: '700', letterSpacing: 0.2 },
  // [beauty2 2026-05-31] Tighter optical tracking on the brand wordmark + a
  // hair more line-height room under the greeting so the unread hint breathes.
  logoText: { fontSize: 22, fontWeight: '800', letterSpacing: -0.7 },
  greetingText: { fontSize: 17, fontWeight: '800', letterSpacing: -0.4 },
  unreadHint: { fontSize: FontSize.xs, marginTop: 2, letterSpacing: 0.2, fontWeight: '600' },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingTop: 8,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, // [beauty2 2026-05-31] hairline divider — softer Gmail/Spark feel
  },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headerIconBtn: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
    ...Platform.select({ web: { transition: 'background-color 0.15s ease, transform 0.15s ease', cursor: 'pointer' }, default: {} }),
  },
  avatarBtn: { marginLeft: 4 },
  headerAvatar: {
    width: 40, height: 40, borderRadius: 20,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2,
  },
  headerAvatarText: { fontSize: FontSize.xl, fontWeight: '600' },
  dropMenu: {
    position: 'absolute', top: 56, right: Spacing.lg,
    borderRadius: 20, paddingVertical: Spacing.sm, minWidth: 280, maxWidth: 360,
    zIndex: 110, borderWidth: 1,
  },
  dropMenuGlass: Platform.OS === 'web' ? {
    boxShadow: '0 16px 48px rgba(0,0,0,0.16), 0 4px 12px rgba(0,0,0,0.06), 0 0 0 1px rgba(255,255,255,0.06)',
    backdropFilter: 'blur(28px) saturate(200%)',
    WebkitBackdropFilter: 'blur(28px) saturate(200%)',
    animation: 'dropdownIn 0.22s cubic-bezier(0.34, 1.56, 0.64, 1)',
  } : {},
  dropHeader: {
    alignItems: 'center', paddingVertical: 20, paddingHorizontal: Spacing.xl,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dropName: { fontSize: 18, fontWeight: '700', letterSpacing: -0.4 },
  dropEmail: { fontSize: FontSize.sm, marginTop: 3, opacity: 0.65, letterSpacing: 0.1 },
  manageBtn: {
    marginTop: 12, paddingHorizontal: 20, paddingVertical: 8,
    borderRadius: 20, borderWidth: 1,
  },
  manageBtnText: { fontSize: FontSize.sm, fontWeight: '600' },
  accountRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'background-color 0.15s ease' }, default: {} }),
  },
  accountName: { fontSize: FontSize.base, fontWeight: '600', letterSpacing: -0.2 },
  accountEmail: { fontSize: FontSize.sm, marginTop: 2, opacity: 0.85 },
  addAccountIcon: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  dropActionsRow: {
    flexDirection: 'row', justifyContent: 'space-around',
    paddingVertical: 12, paddingHorizontal: 8,
  },
  dropActionBtn: {
    alignItems: 'center', justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 12,
    borderRadius: 14,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'background-color 0.15s ease' }, default: {} }),
  },
  dropActionLabel: { fontSize: 11, fontWeight: '600', marginTop: 5, letterSpacing: 0.1 },
  logoutBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 14, gap: 8,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  logoutBtnText: { fontSize: FontSize.base, fontWeight: '700' },
  dropDivider: { borderTopWidth: 1, marginVertical: 2 },
  switchOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 200,
    backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center',
  },
  switchText: { fontSize: FontSize.lg, marginTop: Spacing.md, fontWeight: '500' },
  body: { flex: 1, flexDirection: 'row' },
  sidebarWrap: { width: 272, maxWidth: '30%', minWidth: 220, borderRightWidth: 1 },
  sidebarOverlay: {
    position: 'absolute', top: 0, left: 0, bottom: 0, zIndex: 50,
    maxWidth: '85%', width: 300, minWidth: 260,
    ...Shadow.lg,
  },
  backdrop: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 40,
  },
  readPanel: { flex: 1.5, borderLeftWidth: 1 },
  sideModule: {
    minWidth: 320,
    flex: 1,
    borderLeftWidth: 1,
    ...(Platform.OS === 'web' ? { animation: 'slideInRight 0.25s ease-out' } : {}),
  },
  sideModuleHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, height: 48, borderBottomWidth: 1,
  },
  sideModuleTitle: { fontSize: 15, fontWeight: '700' },
  sideModuleCloseBtn: {
    padding: 6, borderRadius: 16,
    ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'background-color 0.15s ease' } : {}),
  },
  noSelection: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: Spacing.xxl },
  noSelectionRings: {
    width: 180, height: 180, alignItems: 'center', justifyContent: 'center', marginBottom: 32,
  },
  noSelectionOuterRing: {
    position: 'absolute', width: 180, height: 180, borderRadius: 90, borderWidth: 1,
  },
  noSelectionMiddleRing: {
    position: 'absolute', width: 140, height: 140, borderRadius: 70, borderWidth: 1,
  },
  noSelectionCircle: {
    width: 100, height: 100, borderRadius: 50,
    justifyContent: 'center', alignItems: 'center',
  },
  noSelectionTitle: { fontSize: 22, fontWeight: '700', letterSpacing: -0.5 },
  noSelectionSub: { fontSize: FontSize.base, marginTop: Spacing.sm, textAlign: 'center', maxWidth: 300, lineHeight: 23, opacity: 0.7 },
  loader: { marginTop: 60 },
  fab: {
    position: 'absolute', right: 20, alignItems: 'center', justifyContent: 'center',
    borderRadius: 20, width: 62, height: 62,
    ...Platform.select({
      web: {
        boxShadow: '0 8px 28px rgba(124, 58, 237, 0.45), 0 2px 8px rgba(124, 58, 237, 0.2), 0 0 0 4px rgba(124, 58, 237, 0.08)',
        transition: 'box-shadow 0.3s ease, transform 0.2s ease',
        background: 'linear-gradient(135deg, #7C3AED 0%, #A78BFA 100%)',
      },
      default: {
        elevation: 14,
        shadowColor: '#7C3AED',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.45,
        shadowRadius: 18,
      },
    }),
  },
  moveOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center', alignItems: 'center', padding: 24,
  },
  moveCard: {
    width: '100%', maxWidth: 360, borderRadius: 20, borderWidth: 1,
    overflow: 'hidden',
    ...Platform.select({
      web: { boxShadow: '0 16px 48px rgba(0,0,0,0.2), 0 0 0 1px rgba(255,255,255,0.06)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' },
      default: { elevation: 12 },
    }),
  },
  moveHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1,
  },
  moveTitle: { flex: 1, fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
  moveRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  moveFolderName: { fontSize: 15, fontWeight: '500', letterSpacing: 0.1 },
});
