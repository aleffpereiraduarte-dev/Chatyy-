import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, Pressable, FlatList,
  ActivityIndicator, useWindowDimensions, Platform, Animated, Easing, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useMail } from '../context/MailContext';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { Shadow, BorderRadius, FontSize, Spacing, LetterSpacing, AnimTiming } from '../constants/theme';
import EmailReader from '../components/EmailReader';
import Sidebar from '../components/Sidebar';
import EmailList from '../components/EmailList';
import SearchBar from '../components/SearchBar';
import { saveRecentSearch } from '../components/SearchOperators';
import UndoToast from '../components/UndoToast';
import KeyboardShortcutsModal from '../components/KeyboardShortcutsModal';
import SnoozePickerModal from '../components/SnoozePickerModal';
import {
  IconMenu, IconX, IconMail, IconSun, IconMoon, IconSettings,
  IconUser, IconLogout, IconCompose, IconPlus, IconSearch, IconFolder,
  IconMessageSquare, IconCalendar, IconFilm, IconGlobe, IconZap, IconImage,
  IconStar, IconArchive, IconLink,
} from '../components/Icons';
import CategoryTabs from '../components/CategoryTabs';
import QuickSettingsPanel from '../components/QuickSettingsPanel';
import ContextMenu from '../components/ContextMenu';
import ErrorBoundary from '../components/ErrorBoundary';
import AvatarCircle from '../components/AvatarCircle';
import ComposeModal from '../components/ComposeModal';

const SIDE_PANEL_ROUTES = {
  '/chat': { key: 'chat', icon: IconMessageSquare, label: 'sidebar.messages', color: '#25D366', width: 420 },
  '/calendar': { key: 'calendar', icon: IconCalendar, label: 'sidebar.calendar', color: '#4285f4', width: 520 },
  '/drive': { key: 'drive', icon: IconFolder, label: 'Chatyy Drive', color: '#f59e0b', width: 520 },
  '/meetings': { key: 'meetings', icon: IconFilm, label: 'sidebar.meetings', color: '#ef4444', width: 460 },
  '/documentos': { key: 'documentos', icon: IconGlobe, label: 'sidebar.documents', color: '#4285f4', width: 560 },
  '/contacts': { key: 'contacts', icon: IconUser, label: 'sidebar.contacts', color: '#8b5cf6', width: 420 },
  '/one': { key: 'one', icon: IconZap, label: 'One', color: '#6366f1', width: 480 },
  '/photos': { key: 'photos', icon: IconImage, label: 'photos.title', color: '#e11d48', width: 520 },
  '/plans': { key: 'plans', icon: IconStar, label: 'Chatyy Plus', color: '#6366f1', width: 480 },
  '/backup': { key: 'backup', icon: IconArchive, label: 'Backup', color: '#f59e0b', width: 460 },
};

export default function InboxScreen() {
  const { user, loading: authLoading, logout, accounts, switchAccount, switching } = useAuth();
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
    addLabelToEmail, removeLabelFromEmail,
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
  const [showMenu, setShowMenu] = useState(false);
  const [showQRScanner, setShowQRScanner] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showSnooze, setShowSnooze] = useState(false);
  const [snoozeTarget, setSnoozeTarget] = useState(null);
  const [activeCategory, setActiveCategory] = useState('all');
  const [activeLabel, setActiveLabel] = useState(null);
  const [showQuickSettings, setShowQuickSettings] = useState(false);
  const [contextMenu, setContextMenu] = useState({ visible: false, email: null, position: { x: 0, y: 0 } });
  const [showSearchOperators, setShowSearchOperators] = useState(false);
  const [moveToTarget, setMoveToTarget] = useState(null); // email to move
  const [sidePanels, setSidePanels] = useState([]); // array of up to 2 routes — desktop module panels
  // Floating compose modal (desktop only) — null=closed, object=open with params
  const [composeModal, setComposeModal] = useState(null);

  const unreadCount = useMemo(() => emails.filter(e => !e.seen).length, [emails]);
  const otherAccounts = useMemo(() => accounts.filter(a => a.email !== user?.email), [accounts, user?.email]);
  const prevIsDesktop = useRef(isDesktop);

  // Auth guard — redirect to login if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      router.replace('/login');
    }
  }, [authLoading, user]);

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
        useNativeDriver: nd,
      }).start();
    }
  }, [currentFolder]);

  // Animate sidebar slide on mobile
  useEffect(() => {
    if (!isDesktop) {
      const nd = Platform.OS !== 'web';
      if (showSidebar) {
        Animated.parallel([
          Animated.spring(sidebarSlideAnim, { toValue: 0, tension: 80, friction: 14, useNativeDriver: nd }),
          Animated.timing(sidebarOverlayOpacity, { toValue: 1, duration: 250, easing: Easing.out(Easing.cubic), useNativeDriver: nd }),
        ]).start();
      } else {
        Animated.parallel([
          Animated.timing(sidebarSlideAnim, { toValue: -310, duration: 220, easing: Easing.in(Easing.cubic), useNativeDriver: nd }),
          Animated.timing(sidebarOverlayOpacity, { toValue: 0, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: nd }),
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
      Animated.timing(headerAnim, { toValue: 1, duration: 350, easing: Easing.out(Easing.exp), useNativeDriver: nd }),
      Animated.timing(sidebarAnim, { toValue: 1, duration: 400, easing: Easing.out(Easing.exp), useNativeDriver: nd }),
      Animated.timing(listAnim, { toValue: 1, duration: 400, easing: Easing.out(Easing.exp), useNativeDriver: nd }),
      Animated.spring(fabAnim, { toValue: 1, tension: 100, friction: 10, useNativeDriver: nd }),
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

  // Reload emails when activeCategory changes
  useEffect(() => {
    if (currentFolder === 'INBOX') {
      if (activeCategory === 'all') {
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

    const handleKey = (e) => {
      // Don't trigger if user is typing in an input or using modifier keys
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.contentEditable === 'true') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

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

  const handleSearch = () => {
    doSearch(searchText);
    setShowSearchOperators(false);
    if (searchText.trim()) saveRecentSearch(searchText.trim());
  };
  const handleClearSearch = () => {
    setSearchText('');
    doSearch('');
    setShowSearchOperators(false);
  };

  const handleEmailPress = (email) => {
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
      router.push(`/read?uid=${email.uid}&folder=${encodeURIComponent(currentFolder)}`);
    }
  };

  const handleStar = (email) => {
    ctxStarEmail(email.uid);
  };

  const handleCompose = () => {
    if (isDesktop && Platform.OS === 'web') {
      setComposeModal({});
    } else {
      router.push('/compose');
    }
  };

  const handleLogout = async () => {
    await logout();
    router.replace('/login');
  };

  const handleFolderPress = (name, label) => {
    setSelectedEmail(null);
    if (label) {
      // Navigate to INBOX filtered by label
      setActiveLabel(label);
      setActiveCategory('all');
      changeFolder('INBOX');
      loadEmails('INBOX', 1, '', '', label);
    } else {
      setActiveLabel(null);
      changeFolder(name);
    }
    setShowSidebar(false);
  };

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
    const { reportHam } = await import('../services/api');
    await reportHam(email.uid, currentFolder);
    refresh();
    if (selectedEmail?.uid === email.uid) setSelectedEmail(null);
  };

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

  const handlePageChange = (pg) => {
    setPage(pg);
    loadEmails(currentFolder, pg, search);
  };

  const perPage = 20;
  const totalPages = Math.ceil(total / perPage);

  // Don't render anything while redirecting to login
  if (!user) return <View style={{ flex: 1, backgroundColor: '#f8fafc' }} />;

  return (
    <View style={[s.container, { paddingTop: insets.top, backgroundColor: colors.background }]}>
      {/* Account switching overlay */}
      {switching && (
        <View style={s.switchOverlay}>
          <ActivityIndicator size="large" color={colors.textOnPrimary} />
          <Text style={[s.switchText, { color: colors.textOnPrimary }]}>{t('account.switching', { email: '' })}</Text>
        </View>
      )}

      {/* Header — glassmorphism */}
      <Animated.View style={[
        s.header,
        { backgroundColor: Platform.OS === 'web' ? colors.headerBg : colors.headerBgSolid,
          borderBottomColor: colors.headerBorder,
          opacity: headerAnim,
          transform: [{ translateY: headerAnim.interpolate({ inputRange: [0, 1], outputRange: [-40, 0] }) }],
        },
        Platform.OS === 'web' && s.headerGlass,
      ]}>
        {!isDesktop && (
          <TouchableOpacity onPress={() => { setShowSidebar(!showSidebar); if (!showSidebar) setShowMenu(false); }} style={s.menuBtn} accessibilityLabel={showSidebar ? 'Close menu' : 'Open menu'} accessibilityRole="button">
            {showSidebar ? (
              <IconX size={22} color={colors.textSecondary} />
            ) : (
              <IconMenu size={22} color={colors.textSecondary} />
            )}
          </TouchableOpacity>
        )}

        {/* Logo / Greeting */}
        <View style={s.logoWrap}>
          <View style={{ position: 'relative' }}>
            <IconMail size={24} color={colors.primary} style={{ marginRight: 6 }} />
            <View style={[s.wsDot, { borderColor: colors.headerBgSolid || colors.background, backgroundColor: wsStatus === 'authenticated' ? colors.connectionGood : wsStatus === 'connected' ? colors.connectionWarn : colors.connectionBad }]} />
          </View>
          {isDesktop ? (
            <Text style={[s.logoText, { color: colors.primary }]}>Chatyy</Text>
          ) : (
            <View>
              <Text style={[s.greetingText, { color: colors.text }]}>
                {getGreeting()}{user?.name ? `, ${user.name.split(' ')[0]}` : ''}
              </Text>
              {unreadCount > 0 && (
                <Text style={[s.unreadHint, { color: colors.textTertiary }]}>
                  {unreadCount > 1 ? t('inbox.unreadPlural', { count: unreadCount }) : t('inbox.unread', { count: unreadCount })}
                </Text>
              )}
            </View>
          )}
        </View>

        {/* Right actions */}
        <View style={s.headerActions}>
          <TouchableOpacity onPress={() => { setShowMenu(!showMenu); if (!showMenu) setShowSidebar(false); }} style={s.avatarBtn}>
            <AvatarCircle name={user?.name || user?.email || '?'} email={user?.email} size={32} />
          </TouchableOpacity>
        </View>

        {showMenu && (
          <>
            {/* Backdrop to close menu */}
            {Platform.OS === 'web' && (
              <TouchableOpacity
                style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 105 }}
                onPress={() => setShowMenu(false)}
                activeOpacity={1}
              />
            )}
          <View style={[
            s.dropMenu, Shadow.lg,
            { backgroundColor: Platform.OS === 'web' ? colors.headerBg : colors.surface,
              borderColor: colors.headerBorder,
              maxWidth: Platform.OS === 'web' ? 320 : width - 32 },
            Platform.OS === 'web' && s.dropMenuGlass,
          ]}>
            <View style={[s.dropHeader, { borderBottomColor: colors.borderLight }]}>
              <View style={[s.dropAvatar, { backgroundColor: colors.primary }]}>
                <Text style={[s.dropAvatarText, { color: colors.textOnPrimary }]}>
                  {(user?.name || user?.email || '?')[0].toUpperCase()}
                </Text>
              </View>
              <Text style={[s.dropName, { color: colors.text }]}>{user?.name || t('menu.user')}</Text>
              <Text style={[s.dropEmail, { color: colors.textSecondary }]}>{user?.email}</Text>
            </View>
            <TouchableOpacity style={s.dropItem} onPress={() => { setShowMenu(false); router.push('/profile'); }}>
              <View style={s.dropItemIconWrap}><IconUser size={18} color={colors.textSecondary} /></View>
              <Text style={[s.dropItemText, { color: colors.text }]}>{t('menu.profile')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.dropItem} onPress={() => { setShowMenu(false); router.push('/contacts'); }}>
              <View style={s.dropItemIconWrap}><IconUser size={18} color={colors.textSecondary} /></View>
              <Text style={[s.dropItemText, { color: colors.text }]}>{t('menu.contacts')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.dropItem} onPress={() => { setShowMenu(false); router.push('/settings'); }}>
              <View style={s.dropItemIconWrap}><IconSettings size={18} color={colors.textSecondary} /></View>
              <Text style={[s.dropItemText, { color: colors.text }]}>{t('menu.settings')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.dropItem} onPress={() => { toggle(); }}>
              <View style={s.dropItemIconWrap}>{isDark ? <IconSun size={18} color={colors.textSecondary} /> : <IconMoon size={18} color={colors.textSecondary} />}</View>
              <Text style={[s.dropItemText, { color: colors.text }]}>{isDark ? t('theme.light') : t('theme.dark')}</Text>
            </TouchableOpacity>
            {/* Account Switcher */}
            {accounts.length > 1 && (
              <>
                <View style={[s.dropDivider, { borderTopColor: colors.borderLight }]} />
                <Text style={[s.dropSectionLabel, { color: colors.textTertiary }]}>{t('account.switch')}</Text>
                {otherAccounts.map(acc => (
                  <TouchableOpacity
                    key={acc.email}
                    style={s.dropItem}
                    onPress={() => { setShowMenu(false); switchAccount(acc.email); }}
                  >
                    <View style={[s.dropMiniAvatar, { backgroundColor: colors.primaryLight }]}>
                      <Text style={[s.dropMiniAvatarText, { color: colors.primary }]}>
                        {(acc.name || acc.email || '?')[0].toUpperCase()}
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.dropItemText, { color: colors.text }]} numberOfLines={1}>
                        {acc.name || acc.email}
                      </Text>
                      <Text style={{ fontSize: FontSize.sm, color: colors.textTertiary }} numberOfLines={1}>
                        {acc.email}
                      </Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </>
            )}
            <TouchableOpacity style={s.dropItem} onPress={() => { setShowMenu(false); router.push('/login?add_account=1'); }}>
              <View style={s.dropItemIconWrap}><IconPlus size={18} color={colors.primary} /></View>
              <Text style={[s.dropItemText, { color: colors.primary }]}>{t('account.add')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.dropItem} onPress={() => {
              setShowMenu(false);
              if (Platform.OS === 'web') {
                // On desktop: show instructions to scan from phone
                const msg = 'Para conectar outro dispositivo:\n\n1. Abra o Chatyy no celular\n2. Vá em Configurações\n3. Toque em "Dispositivos conectados"\n4. Escaneie o QR Code na tela de login do computador';
                window.alert(msg);
              } else {
                // On mobile: open QR scanner
                setShowQRScanner(true);
              }
            }}>
              <View style={s.dropItemIconWrap}><IconLink size={18} color={colors.text} /></View>
              <Text style={[s.dropItemText, { color: colors.text }]}>Dispositivos conectados</Text>
            </TouchableOpacity>
            <View style={[s.dropDivider, { borderTopColor: colors.borderLight }]} />
            <TouchableOpacity style={s.dropItem} onPress={() => { setShowMenu(false); handleLogout(); }}>
              <View style={s.dropItemIconWrap}><IconLogout size={18} color={colors.error} /></View>
              <Text style={[s.dropItemText, { color: colors.error }]}>{t('menu.logout')}</Text>
            </TouchableOpacity>
          </View>
          </>
        )}
      </Animated.View>

      {/* Search bar — own row below header */}
      <View style={[s.searchRow, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <SearchBar
          value={searchText}
          onChange={setSearchText}
          onSubmit={handleSearch}
          onClear={handleClearSearch}
        />
      </View>

      {/* Category Tabs */}
      {currentFolder === 'INBOX' && (
        <CategoryTabs activeCategory={activeCategory} onCategoryChange={setActiveCategory} />
      )}

      {/* Body */}
      <View style={s.body}>
        {/* Desktop sidebar with entry animation */}
        {isDesktop && (
          <Animated.View style={[
            s.sidebarWrap,
            { backgroundColor: colors.sidebarBg, borderRightColor: colors.border,
              opacity: sidebarAnim,
              transform: [{ translateX: sidebarAnim.interpolate({ inputRange: [0, 1], outputRange: [-60, 0] }) }],
            },
          ]}>
            <Sidebar
              folders={folders}
              currentFolder={currentFolder}
              onFolderPress={(f) => { setSidePanels([]); handleFolderPress(f); }}
              onCompose={handleCompose}
              onFoldersChanged={loadFolders}
              onNavigate={(route) => {
                setShowSidebar(false);
                // Desktop: open as side panel if supported route
                if (isDesktop && SIDE_PANEL_ROUTES[route]) {
                  setSidePanels(prev => {
                    // Toggle off if already open
                    if (prev.includes(route)) {
                      return prev.filter(r => r !== route);
                    }
                    // Add if fewer than 2 panels open
                    if (prev.length < 2) {
                      return [...prev, route];
                    }
                    // 2 panels already open — ask which one to close
                    const panelA = SIDE_PANEL_ROUTES[prev[0]];
                    const panelB = SIDE_PANEL_ROUTES[prev[1]];
                    const newPanel = SIDE_PANEL_ROUTES[route];
                    if (Platform.OS === 'web' && typeof window !== 'undefined') {
                      const labelA = panelA?.key || prev[0];
                      const labelB = panelB?.key || prev[1];
                      const choice = window.confirm(
                        `Dois painéis já estão abertos (${labelA} e ${labelB}).\n\nClicar OK fecha "${labelA}" e abre "${newPanel?.key || route}".\nClicar Cancelar fecha "${labelB}" e abre "${newPanel?.key || route}".`
                      );
                      // true = OK = close first panel; false = Cancel = close second panel
                      return choice ? [prev[1], route] : [prev[0], route];
                    }
                    // Native fallback: replace the last panel
                    return [prev[0], route];
                  });
                  return;
                }
                router.push(route);
              }}
              onMoveEmail={async (uid, folder) => {
                const { moveEmail } = await import('../services/api');
                await moveEmail(uid, folder, currentFolder);
                refresh();
              }}
              activeSidePanel={sidePanels}
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
                onNavigate={(route) => { setShowSidebar(false); router.push(route); }}
                onMoveEmail={async (uid, folder) => {
                  const { moveEmail } = await import('../services/api');
                  await moveEmail(uid, folder, currentFolder);
                  refresh();
                }}
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

        {/* Email List */}
        <Animated.View style={[{ flex: 1 }, {
          opacity: listAnim,
          transform: [
            { translateY: listAnim.interpolate({ inputRange: [0, 1], outputRange: [30, 0] }) },
          ],
        }]}>
        <EmailList
          emails={emails}
          loading={loadingList}
          currentFolder={currentFolder}
          selectedUid={selectedEmail?.uid}
          search={search}
          page={page}
          totalPages={totalPages}
          onEmailPress={handleEmailPress}
          onStar={handleStar}
          onRefresh={refresh}
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

        />
        </Animated.View>

        {/* Reading Pane — desktop */}
        {isDesktop && (
          <View style={[s.readPanel, { backgroundColor: colors.surface, borderLeftColor: colors.border }]}>
            {loadingMessage ? (
              <ActivityIndicator style={s.loader} size="large" color={colors.primary} />
            ) : selectedEmail ? (
              <ErrorBoundary>
                <EmailReader
                  email={selectedEmail}
                  folder={currentFolder}
                  onReply={(e) => handleReply(e || selectedEmail)}
                  onReplyAll={(e) => handleReplyAll(e || selectedEmail)}
                  onForward={() => handleForward(selectedEmail)}
                  onDelete={() => handleDelete(selectedEmail.uid)}
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
                <View style={[
                  s.noSelectionCircle,
                  {
                    backgroundColor: colors.primaryLight,
                    opacity: 0.6,
                    width: Math.min(120, width * 0.3),
                    height: Math.min(120, width * 0.3),
                    borderRadius: Math.min(60, width * 0.15),
                  },
                  Platform.OS === 'web' && { animation: 'pulseGlow 3s ease-in-out infinite' },
                ]}>
                  <IconMail size={Math.min(44, width * 0.1)} color={colors.primary} style={{ opacity: 0.5 }} />
                </View>
                <Text style={[s.noSelectionTitle, { color: colors.textSecondary }]}>
                  {t('inbox.selectEmail')}
                </Text>
                <Text style={[s.noSelectionSub, { color: colors.textTertiary }]}>
                  {t('inbox.selectHint')}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Side Panel Modules — desktop only (Chat, Calendar, Files, etc.) */}
        {isDesktop && sidePanels.length > 0 && sidePanels.map((panelRoute, panelIdx) => {
          const panelInfo = SIDE_PANEL_ROUTES[panelRoute];
          if (!panelInfo) return null;
          const PanelIcon = panelInfo.icon;
          return (
            <View key={panelRoute} style={[s.sideModule, {
              backgroundColor: colors.surface, borderLeftColor: colors.border,
              width: panelInfo.width || 420, maxWidth: sidePanels.length > 1 ? '35%' : '45%',
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
                  accessibilityLabel="Open full screen"
                >
                  <IconCompose size={14} color={colors.textSecondary} />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setSidePanels(prev => prev.filter(r => r !== panelRoute))}
                  style={s.sideModuleCloseBtn}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel="Close panel"
                >
                  <IconX size={16} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>
              <iframe
                src={panelRoute}
                style={{ flex: 1, border: 'none', width: '100%', height: '100%' }}
                title={t(panelInfo.label)}
              />
            </View>
          );
        })}
      </View>

      {/* FAB — mobile, solid primary with premium press animation */}
      {!isDesktop && (
        <Animated.View style={{
          opacity: fabAnim,
          transform: [
            { scale: fabAnim.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }) },
            { translateY: fabAnim.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }) },
          ],
        }}>
          <TouchableOpacity
            style={[s.fab, Shadow.float, { bottom: insets.bottom + 20, backgroundColor: colors.composeBg }]}
            onPress={handleCompose}
            accessibilityLabel={t('compose.title')}
            accessibilityRole="button"
            onPressIn={() => {
              Animated.spring(fabScaleAnim, {
                toValue: 0.88,
                ...AnimTiming.springSnappy,
                useNativeDriver: Platform.OS !== 'web',
              }).start();
            }}
            onPressOut={() => {
              Animated.spring(fabScaleAnim, {
                toValue: 1,
                tension: 160,
                friction: 10,
                useNativeDriver: Platform.OS !== 'web',
              }).start();
            }}
            activeOpacity={1}
          >
            <IconCompose size={22} color={colors.composeText} />
          </TouchableOpacity>
        </Animated.View>
      )}

      {/* Undo Toast */}
      <UndoToast action={undoAction} onUndo={executeUndo} onDismiss={dismissUndo} />

      {/* Keyboard Shortcuts Modal */}
      <KeyboardShortcutsModal visible={showShortcuts} onClose={() => setShowShortcuts(false)} />

      {/* Snooze Picker Modal */}
      <SnoozePickerModal
        visible={showSnooze}
        onClose={() => { setShowSnooze(false); setSnoozeTarget(null); }}
        onSnooze={handleSnoozeConfirm}
      />

      {/* Context Menu */}
      <ContextMenu
        visible={contextMenu.visible}
        position={contextMenu.position}
        email={contextMenu.email}
        onClose={() => setContextMenu({ visible: false, email: null, position: { x: 0, y: 0 } })}
        actions={{
          onReply: handleReply,
          onReplyAll: handleReplyAll,
          onForward: handleForward,
          onArchive: handleArchive,
          onDelete: (e) => handleDelete(e.uid),
          onStar: handleStar,
          onSnooze: handleSnoozeEmail,
          onSpam: handleReportSpam,
          onMarkRead: async (e) => { const { markRead } = await import('../services/api'); await markRead(e.uid, currentFolder); refresh(); },
          onMarkUnread: async (e) => { const { markUnread } = await import('../services/api'); await markUnread(e.uid, currentFolder); refresh(); },
          onMoveTo: (e) => setMoveToTarget(e),
        }}
      />

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
      <QuickSettingsPanel visible={showQuickSettings} onClose={() => setShowQuickSettings(false)} />

      {/* Floating Compose Modal — desktop web only */}
      {isDesktop && Platform.OS === 'web' && composeModal !== null && (
        <ComposeModal
          params={composeModal}
          onClose={() => setComposeModal(null)}
        />
      )}

      {/* QR Code Scanner Modal */}
      {showQRScanner && Platform.OS !== 'web' && (
        <Modal visible animationType="slide" onRequestClose={() => setShowQRScanner(false)}>
          <QRScannerView onScan={async (token) => {
            setShowQRScanner(false);
            try {
              const cleanToken = token.replace('chatyy://qr/', '').replace('https://chatyy.com.br/qr/', '').trim();
              const res = await api.qrConfirm(cleanToken);
              if (res?.success) Alert.alert('Conectado!', 'Dispositivo conectado com sucesso!');
              else Alert.alert('Erro', res?.message || 'QR Code inválido');
            } catch { Alert.alert('Erro', 'Falha ao conectar'); }
          }} onClose={() => setShowQRScanner(false)} />
        </Modal>
      )}
    </View>
  );
}

// QR Scanner component using expo-camera
function QRScannerView({ onScan, onClose }) {
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
        <Text style={{ color: '#fff', marginTop: 16 }}>Abrindo câmera...</Text>
      </View>
    );
  }

  if (hasPermission === false) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000', padding: 40 }}>
        <Text style={{ color: '#fff', fontSize: 18, fontWeight: '600', textAlign: 'center' }}>Permissão da câmera necessária</Text>
        <Text style={{ color: '#aaa', fontSize: 14, textAlign: 'center', marginTop: 8 }}>Vá em Ajustes → Chatyy → Câmera e permita o acesso</Text>
        <TouchableOpacity onPress={onClose} style={{ marginTop: 24, padding: 14, backgroundColor: '#6366f1', borderRadius: 12, paddingHorizontal: 32 }}>
          <Text style={{ color: '#fff', fontWeight: '600' }}>Fechar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  let CameraComponent;
  try { CameraComponent = require('expo-camera').CameraView; } catch { CameraComponent = null; }

  if (!CameraComponent) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' }}>
        <Text style={{ color: '#fff', fontSize: 16 }}>Câmera não disponível</Text>
        <TouchableOpacity onPress={onClose} style={{ marginTop: 24, padding: 14, backgroundColor: '#6366f1', borderRadius: 12 }}>
          <Text style={{ color: '#fff', fontWeight: '600' }}>Fechar</Text>
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
        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '500', marginTop: 24, textAlign: 'center' }}>Aponte para o QR Code na tela do computador</Text>
      </View>
      {/* Close button */}
      <TouchableOpacity onPress={onClose} style={{ position: 'absolute', top: 50, left: 20, padding: 12, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 25 }}>
        <IconX size={24} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.lg, paddingVertical: 10,
    borderBottomWidth: 1, zIndex: 100,
  },
  headerGlass: Platform.OS === 'web' ? {
    backdropFilter: 'blur(24px) saturate(200%)',
    WebkitBackdropFilter: 'blur(24px) saturate(200%)',
  } : {},
  menuBtn: { padding: Spacing.sm, marginRight: Spacing.xs },
  logoWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', marginRight: Spacing.md },
  wsDot: { position: 'absolute', bottom: -1, right: 4, width: 7, height: 7, borderRadius: 4, borderWidth: 1.5 },
  searchBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm, borderBottomWidth: 1 },
  searchBannerText: { flex: 1, fontSize: FontSize.sm },
  searchBannerClear: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: BorderRadius.sm },
  searchBannerClearText: { fontSize: FontSize.xs, fontWeight: '600' },
  logoText: { fontSize: FontSize.xxl, fontWeight: '700', letterSpacing: LetterSpacing.tight },
  greetingText: { fontSize: FontSize.lg, fontWeight: '700' },
  unreadHint: { fontSize: FontSize.xs, marginTop: 1 },
  searchRow: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderBottomWidth: 1,
  },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  headerIconBtn: {
    padding: 8, borderRadius: 20,
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
    position: 'absolute', top: 58, right: Spacing.lg,
    borderRadius: BorderRadius.xl, paddingVertical: Spacing.sm, minWidth: 260, maxWidth: 360,
    zIndex: 110, borderWidth: 1,
  },
  dropMenuGlass: Platform.OS === 'web' ? {
    boxShadow: '0 10px 40px rgba(0,0,0,0.14), 0 2px 10px rgba(0,0,0,0.06)',
    backdropFilter: 'blur(24px) saturate(180%)',
    WebkitBackdropFilter: 'blur(24px) saturate(180%)',
    animation: 'dropdownIn 0.22s cubic-bezier(0.34, 1.56, 0.64, 1)',
  } : {},
  dropHeader: {
    alignItems: 'center', paddingVertical: Spacing.lg, paddingHorizontal: Spacing.xl,
    borderBottomWidth: 1,
  },
  dropAvatar: {
    width: 56, height: 56, borderRadius: 28,
    justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.sm,
  },
  dropAvatarText: { fontSize: FontSize.title, fontWeight: '600' },
  dropName: { fontSize: FontSize.lg, fontWeight: '600' },
  dropEmail: { fontSize: FontSize.md, marginTop: 2 },
  dropItem: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
    ...Platform.select({ web: { transition: 'background-color 0.15s ease', cursor: 'pointer' }, default: {} }),
  },
  dropItemIconWrap: { marginRight: Spacing.md, width: 24, alignItems: 'center' },
  dropItemText: { fontSize: FontSize.lg },
  dropDivider: { borderTopWidth: 1, marginVertical: Spacing.xs },
  dropSectionLabel: {
    fontSize: FontSize.sm, fontWeight: '600', textTransform: 'uppercase',
    letterSpacing: 0.8, paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm, paddingBottom: Spacing.xs,
  },
  dropMiniAvatar: {
    width: 28, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center', marginRight: Spacing.md,
  },
  dropMiniAvatarText: { fontSize: FontSize.sm, fontWeight: '600' },
  switchOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 200,
    backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center',
  },
  switchText: { fontSize: FontSize.lg, marginTop: Spacing.md, fontWeight: '500' },
  body: { flex: 1, flexDirection: 'row' },
  sidebarWrap: { width: 280, maxWidth: '30%', minWidth: 220, borderRightWidth: 1 },
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
    minWidth: 340,
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
  noSelectionCircle: {
    width: 120, height: 120, borderRadius: 60,
    justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.xxl,
  },
  noSelectionTitle: { fontSize: FontSize.xxl, fontWeight: '600', letterSpacing: -0.3 },
  noSelectionSub: { fontSize: FontSize.base, marginTop: Spacing.sm, textAlign: 'center', maxWidth: 280, lineHeight: 20 },
  loader: { marginTop: 60 },
  fab: {
    position: 'absolute', right: 20, alignItems: 'center', justifyContent: 'center',
    borderRadius: 18, width: 58, height: 58,
    ...Platform.select({
      web: {
        boxShadow: '0 4px 14px rgba(37, 99, 235, 0.35), 0 8px 24px rgba(37, 99, 235, 0.18)',
        transition: 'box-shadow 0.3s ease',
      },
      default: {},
    }),
  },
  moveOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center', alignItems: 'center', padding: 24,
  },
  moveCard: {
    width: '100%', maxWidth: 360, borderRadius: 16, borderWidth: 1,
    overflow: 'hidden',
    ...Platform.select({
      web: { boxShadow: '0 8px 32px rgba(0,0,0,0.18)' },
      default: { elevation: 8 },
    }),
  },
  moveHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1,
  },
  moveTitle: { flex: 1, fontSize: 16, fontWeight: '700' },
  moveRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  moveFolderName: { fontSize: 15, fontWeight: '500' },
});
