import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, useWindowDimensions, Platform, Animated, Easing,
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
  IconUser, IconLogout, IconCompose, IconPlus, IconSearch,
} from '../components/Icons';
import CategoryTabs from '../components/CategoryTabs';
import QuickSettingsPanel from '../components/QuickSettingsPanel';
import ContextMenu from '../components/ContextMenu';

export default function InboxScreen() {
  const { user, logout, accounts, switchAccount, switching } = useAuth();
  const {
    emails, folders, currentFolder, selectedEmail, loadingList, loadingMessage,
    page, total, search,
    loadFolders, loadEmails, openEmail, changeFolder, refresh, doSearch,
    deleteEmail, setSelectedEmail, setPage,
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
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showSnooze, setShowSnooze] = useState(false);
  const [snoozeTarget, setSnoozeTarget] = useState(null);
  const [activeCategory, setActiveCategory] = useState('all');
  const [activeLabel, setActiveLabel] = useState(null);
  const [showQuickSettings, setShowQuickSettings] = useState(false);
  const [contextMenu, setContextMenu] = useState({ visible: false, email: null, position: { x: 0, y: 0 } });
  const [showSearchOperators, setShowSearchOperators] = useState(false);

  const unreadCount = emails.filter(e => !e.seen).length;
  const prevIsDesktop = useRef(isDesktop);

  // Clear selected email when switching from desktop to mobile to prevent crash
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
  const sidebarSlideAnim = useRef(new Animated.Value(-256)).current;
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
          Animated.timing(sidebarSlideAnim, { toValue: -256, duration: 220, easing: Easing.in(Easing.cubic), useNativeDriver: nd }),
          Animated.timing(sidebarOverlayOpacity, { toValue: 0, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: nd }),
        ]).start();
      }
    }
  }, [showSidebar, isDesktop]);



  useEffect(() => {
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
    if (user?.email) {
      resetMailState();
      loadFolders();
      loadEmails('INBOX', 1, '');
      setActiveCategory('all');
      setActiveLabel(null);
    }
  }, [user?.email]);

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

  // Keyboard shortcuts (web only)
  useEffect(() => {
    if (Platform.OS !== 'web') return;

    const handleKey = (e) => {
      // Don't trigger if user is typing in an input or using modifier keys
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.contentEditable === 'true') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const idx = selectedEmail
        ? emails.findIndex(em => em.uid === selectedEmail.uid)
        : -1;

      switch (e.key) {
        case 'j': // Next email
          if (idx < emails.length - 1 && isDesktop) {
            openEmail(emails[idx + 1].uid, currentFolder);
          }
          break;
        case 'k': // Previous email
          if (idx > 0 && isDesktop) {
            openEmail(emails[idx - 1].uid, currentFolder);
          }
          break;
        case 'c': // Compose
          router.push('/compose');
          break;
        case 'r': // Reply
          if (selectedEmail) {
            handleReply(selectedEmail);
          }
          break;
        case 'e': // Archive
          if (selectedEmail) {
            handleArchive(selectedEmail);
          }
          break;
        case '#': // Delete
          if (selectedEmail) {
            handleDelete(selectedEmail.uid);
          }
          break;
        case 's': // Star
          if (selectedEmail) {
            handleStar(selectedEmail);
          }
          break;
        case 'x': // Select/deselect
          if (selectedEmail) {
            toggleSelect(selectedEmail.uid);
          }
          break;
        case '/': // Focus search
          e.preventDefault();
          document.querySelector('[data-search-input]')?.focus();
          break;
        case 'z': // Undo (Ctrl+Z or just z)
          if (undoAction) {
            executeUndo();
          }
          break;
        case 'p': // Print
          if (selectedEmail && Platform.OS === 'web') {
            const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            const pw = window.open('', '_blank');
            if (pw) {
              pw.document.write(`<!DOCTYPE html><html><head><title>${esc(selectedEmail.subject || 'Email')}</title><style>body{font-family:-apple-system,system-ui,sans-serif;padding:40px;max-width:800px;margin:0 auto}.header{border-bottom:1px solid #ddd;padding-bottom:16px;margin-bottom:16px}.from{font-weight:600;font-size:16px}.meta{color:#666;font-size:13px;margin-top:4px}.body{font-size:14px;line-height:1.7}img{max-width:100%}@media print{body{padding:20px}}</style></head><body><div class="header"><div class="from">${esc(selectedEmail.from_name || selectedEmail.from)}</div><div class="meta">Para: ${esc(selectedEmail.to || '')}</div><div class="meta">${esc(selectedEmail.date || '')}</div><div style="font-size:18px;margin-top:12px">${esc(selectedEmail.subject || '')}</div></div><div class="body">${selectedEmail.body_html || esc(selectedEmail.body_text || '').replace(/\n/g, '<br>')}</div></body></html>`);
              pw.document.close();
              setTimeout(() => pw.print(), 300);
            }
          }
          break;
        case '?': // Show keyboard shortcuts
          setShowShortcuts(true);
          break;
        case 'Escape':
          if (showShortcuts) setShowShortcuts(false);
          else if (showSnooze) { setShowSnooze(false); setSnoozeTarget(null); }
          else if (selectMode) clearSelection();
          else if (selectedEmail) setSelectedEmail(null);
          break;
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [emails, selectedEmail, currentFolder, selectMode, undoAction, showShortcuts, showSnooze]);

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

  const handleStar = async (email) => {
    const { starEmail, unstarEmail } = await import('../services/api');
    if (email.flagged) {
      await unstarEmail(email.uid, currentFolder);
    } else {
      await starEmail(email.uid, currentFolder);
    }
    refresh();
  };

  const handleCompose = () => router.push('/compose');

  const handleLogout = async () => {
    await logout();
    router.replace('/login');
  };

  const handleFolderPress = (name, label) => {
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
    let url = `/compose?reply_uid=${email.uid}&folder=${encodeURIComponent(currentFolder)}&to=${encodeURIComponent(email.from)}&subject=${encodeURIComponent('Re: ' + (email.subject || ''))}`;
    if (email.smartReply) {
      url += `&smart_reply=${encodeURIComponent(email.smartReply)}`;
    }
    router.push(url);
  };

  const handleReplyAll = (email) => {
    const allRecipients = [email?.to, email?.cc].filter(Boolean).join(',');
    let url = `/compose?reply_uid=${email.uid}&reply_all=1&folder=${encodeURIComponent(currentFolder)}&to=${encodeURIComponent(email.from)}&cc=${encodeURIComponent(allRecipients)}&subject=${encodeURIComponent('Re: ' + (email.subject || ''))}`;
    router.push(url);
  };

  const handleForward = (email) => {
    router.push(`/compose?forward_uid=${email.uid}&folder=${encodeURIComponent(currentFolder)}&subject=${encodeURIComponent('Fwd: ' + (email.subject || ''))}`);
  };

  const handleDelete = async (uid) => {
    await deleteEmail(uid);
  };

  const handleArchive = async (email) => {
    const { archiveEmail } = await import('../services/api');
    await archiveEmail(email.uid, currentFolder);
    refresh();
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
          <TouchableOpacity onPress={() => setShowSidebar(!showSidebar)} style={s.menuBtn}>
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
            <Text style={[s.logoText, { color: colors.primary }]}>OneMundo Mail</Text>
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
          <TouchableOpacity onPress={() => setShowMenu(!showMenu)} style={s.avatarBtn}>
            <View style={[s.headerAvatar, { backgroundColor: colors.primary, borderColor: colors.focusGlow }]}>
              <Text style={[s.headerAvatarText, { color: colors.textOnPrimary }]}>
                {(user?.name || user?.email || '?')[0].toUpperCase()}
              </Text>
            </View>
          </TouchableOpacity>
        </View>

        {showMenu && (
          <>
            {/* Backdrop to close menu */}
            {Platform.OS === 'web' && (
              <TouchableOpacity
                style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 99 }}
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
                {accounts.filter(a => a.email !== user?.email).map(acc => (
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
          opacity: Animated.multiply(listAnim, folderTransitionAnim),
          transform: [
            { translateY: listAnim.interpolate({ inputRange: [0, 1], outputRange: [30, 0] }) },
            { translateY: folderTransitionAnim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
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
              />
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
      </View>

      {/* FAB — mobile, solid primary with premium press animation */}
      {!isDesktop && (
        <Animated.View style={{
          opacity: fabAnim,
          transform: [
            { scale: Animated.multiply(
              fabAnim.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }),
              fabScaleAnim
            ) },
            { translateY: fabAnim.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }) },
          ],
        }}>
          <TouchableOpacity
            style={[s.fab, Shadow.float, { bottom: insets.bottom + 20, backgroundColor: colors.composeBg }]}
            onPress={handleCompose}
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
        }}
      />

      {/* Quick Settings Panel */}
      <QuickSettingsPanel visible={showQuickSettings} onClose={() => setShowQuickSettings(false)} />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.lg, paddingVertical: 10,
    borderBottomWidth: 1, zIndex: 50,
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
    borderRadius: BorderRadius.xl, paddingVertical: Spacing.sm, minWidth: 280,
    zIndex: 100, borderWidth: 1,
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
  sidebarWrap: { width: 256, borderRightWidth: 1 },
  sidebarOverlay: {
    position: 'absolute', top: 0, left: 0, bottom: 0, zIndex: 50,
    ...Shadow.lg,
  },
  backdrop: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 40,
  },
  readPanel: { flex: 1.5, borderLeftWidth: 1 },
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
});
