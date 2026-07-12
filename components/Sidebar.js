import React, { useState, useRef, useEffect, useCallback, memo } from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Platform, ScrollView, Alert, Animated, Easing } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing, Shadow, Transition, AnimTiming } from '../constants/theme';
import {
  IconInbox, IconSend, IconDraft, IconTrash, IconAlertTriangle,
  IconArchive, IconStarFilled, IconCompose, IconFolder, IconClock,
  IconFolderPlus, IconPlus, IconX, IconCheck,
  IconFilm, IconMessageSquare, IconCalendar, IconGlobe, IconUser, IconZap, IconCamera, IconStar, IconStickyNote, IconBell, IconSearch, IconBookmark, IconChevronDown, IconLogout,
  IconMapPin, IconPlay,
} from './Icons';
import AvatarCircle from './AvatarCircle';
import { LABEL_COLORS, LABEL_NAMES } from './LabelPicker';
import * as api from '../services/api';
import { useConfirm } from './ConfirmModal';

const FOLDER_ICONS = {
  INBOX: IconInbox,
  Sent: IconSend,
  Drafts: IconDraft,
  Trash: IconTrash,
  Spam: IconAlertTriangle,
  Archive: IconArchive,
  Flagged: IconStarFilled,
  Snoozed: IconClock,
};

// Colorful folder icon colors
const FOLDER_COLORS = {
  INBOX: '#7C3AED',
  Sent: '#10b981',
  Drafts: '#f59e0b',
  Trash: '#ef4444',
  Spam: '#8b5cf6',
  Archive: '#6b7280',
  Flagged: '#f59e0b',
  Snoozed: '#A78BFA',
  Junk: '#8b5cf6',
};

const FOLDER_BG_COLORS = {
  INBOX: '#EDE9FE',
  Sent: '#d1fae5',
  Drafts: '#fef3c7',
  Trash: '#fee2e2',
  Spam: '#ede9fe',
  Archive: '#f3f4f6',
  Flagged: '#fef3c7',
  Snoozed: '#e0e7ff',
  Junk: '#ede9fe',
};

const FOLDER_KEYS = {
  INBOX: 'folder.inbox',
  Sent: 'folder.sent',
  Drafts: 'folder.drafts',
  Trash: 'folder.trash',
  Spam: 'folder.spam',
  Archive: 'folder.archive',
  Flagged: 'folder.flagged',
  Snoozed: 'folder.snoozed',
};

const DEFAULT_FOLDERS = [
  { name: 'INBOX' }, { name: 'Flagged' }, { name: 'Snoozed' }, { name: 'Sent' },
  { name: 'Drafts' }, { name: 'Archive' }, { name: 'Trash' }, { name: 'Spam' },
];

// Animated badge component with entrance animation
function AnimatedBadge({ count, isActive, colors, showTotal, folderColor, isInbox }) {
  const scaleAnim = useRef(new Animated.Value(0)).current;
  const prevCount = useRef(count);

  useEffect(() => {
    if (count > 0) {
      // Bounce in on first appear or count change
      if (prevCount.current !== count || prevCount.current === 0) {
        scaleAnim.setValue(0.3);
        Animated.spring(scaleAnim, {
          toValue: 1,
          tension: 200,
          friction: 12,
          useNativeDriver: false,
        }).start();
      }
    } else {
      Animated.timing(scaleAnim, {
        toValue: 0,
        duration: AnimTiming.fast,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: false,
      }).start();
    }
    prevCount.current = count;
  }, [count]);

  if (count <= 0 && prevCount.current === 0) return null;

  const badgeBg = isActive
    ? (folderColor || colors.primary)
    : showTotal
      ? colors.textTertiary
      : (folderColor || colors.badge);

  return (
    <Animated.View
      style={[
        s.badgeWrap,
        isInbox && s.badgeWrapInbox,
        {
          backgroundColor: badgeBg,
          transform: [{ scale: scaleAnim }],
          opacity: scaleAnim,
        },
      ]}
    >
      <Text style={[s.badgeText, { fontWeight: '700' }, isInbox && s.badgeTextInbox]}>
        {count || prevCount.current}
      </Text>
    </Animated.View>
  );
}

// Animated folder item with active indicator
function FolderItem({ folder, isActive, onPress, colors, t, dragOverFolder, setDragOverFolder, onMoveEmail, currentFolder, folderAnim, children }) {
  const FolderIcon = FOLDER_ICONS[folder.name] || IconFolder;
  const folderColor = FOLDER_COLORS[folder.name] || colors.textSecondary;
  const folderBgColor = FOLDER_BG_COLORS[folder.name] || colors.surfaceVariant;
  const activeIndicatorWidth = useRef(new Animated.Value(isActive ? 3 : 0)).current;
  const bgOpacity = useRef(new Animated.Value(isActive ? 1 : 0)).current;
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    const nd = Platform.OS !== 'web';
    Animated.parallel([
      Animated.spring(activeIndicatorWidth, {
        toValue: isActive ? 3 : 0,
        ...AnimTiming.springSnappy,
        useNativeDriver: false,
      }),
      Animated.timing(bgOpacity, {
        toValue: isActive ? 1 : 0,
        duration: AnimTiming.normal,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }),
    ]).start();
  }, [isActive]);

  const webHover = Platform.OS === 'web' ? {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  } : {};

  // Show folder count (total for trash/spam/drafts, unread for others)
  const showTotal = ['Trash', 'Spam', 'Junk', 'Drafts'].includes(folder.name);
  const folderCount = showTotal ? (folder.total || 0) : (folder.unread || folder.unseen || 0);

  return (
    <Animated.View style={{ opacity: folderAnim }}>
      <View style={{ position: 'relative' }}>
        {/* Animated active background */}
        <Animated.View
          style={[
            s.folderActiveBg,
            {
              backgroundColor: folderColor + '12',
              opacity: bgOpacity,
              borderTopRightRadius: BorderRadius.xxl,
              borderBottomRightRadius: BorderRadius.xxl,
            },
          ]}
          pointerEvents="none"
        />
        <TouchableOpacity
          style={[
            s.folderItem,
            hovered && !isActive && { backgroundColor: colors.folderHover },
            hovered && !isActive && Platform.OS === 'web' && s.folderItemHoverShadow,
            dragOverFolder === folder.name && { backgroundColor: colors.primaryLight, borderColor: colors.primary, borderWidth: 1 },
            Platform.OS === 'web' && s.folderTransition,
          ]}
          onPress={() => onPress(folder.name)}
          activeOpacity={0.6}
          {...webHover}
          {...(Platform.OS === 'web' ? {
            onDragOver: (e) => { e.preventDefault?.(); setDragOverFolder(folder.name); },
            onDragLeave: () => setDragOverFolder(null),
            onDrop: (e) => {
              e.preventDefault?.();
              setDragOverFolder(null);
              try {
                const data = JSON.parse(e.dataTransfer?.getData('text/plain') || '{}');
                if (data.uid && folder.name !== currentFolder) onMoveEmail?.(data.uid, folder.name);
              } catch {}
            },
          } : {})}
        >
          {/* Animated active left border — 3px purple accent for clear selection */}
          <Animated.View
            style={[
              s.activeIndicator,
              {
                width: activeIndicatorWidth,
                backgroundColor: colors.primary,
                borderRadius: 2,
              },
            ]}
          />
          {/* Colored icon background pill — keep dimensions stable on activate so
              the label doesn't jump; only the tinted fill fades in. [beauty2 2026-05-31] */}
          <View style={[s.folderIconWrap, isActive && { backgroundColor: folderBgColor }]}>
            <FolderIcon size={18} color={isActive ? folderColor : folderColor + '99'} />
          </View>
          <Text style={[
            s.folderLabel,
            { color: colors.text },
            isActive && { fontWeight: '700', color: folderColor },
          ]}>
            {folder.name === 'INBOX' ? (t('folder.allMail') || 'Todos os emails') : (FOLDER_KEYS[folder.name] ? t(FOLDER_KEYS[folder.name]) : folder.name)}
          </Text>
          {children}
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

function Sidebar({ folders, currentFolder, onFolderPress, onCompose, onFoldersChanged, onMoveEmail, onNavigate, activeSidePanel, activeLabel, labelCounts, collapsed }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const confirm = useConfirm();
  const { logout: doLogout, user } = require('../context/AuthContext').useAuth();
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [dragOverFolder, setDragOverFolder] = useState(null);
  const [chatUnread, setChatUnread] = useState(0);
  const [notifsUnread, setNotifsUnread] = useState(0);
  const [showMoreQuick, setShowMoreQuick] = useState(false);

  // Fetch chat + notifications unread counts. Two badges users actually scan
  // for in the rail — Notificações was previously a "dead" entry with no
  // signal, so users had to open it to find out if anything was waiting.
  useEffect(() => {
    let mounted = true;
    const fetchCounts = async () => {
      try {
        const [chat, notifs] = await Promise.all([
          api.chatUnreadCount?.().catch(() => null),
          api.notificationsUnreadCount?.().catch(() => null),
        ]);
        if (!mounted) return;
        if (chat?.success) setChatUnread(chat.data?.count || 0);
        if (notifs?.success) setNotifsUnread(notifs.data?.count || notifs.data?.unread || 0);
      } catch {}
    };
    fetchCounts();
    const interval = setInterval(fetchCounts, 30000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  // Compose button press animation
  const composeScale = useRef(new Animated.Value(1)).current;

  const folderList = folders?.length > 0
    ? [{ name: 'Flagged' }, { name: 'Snoozed' }, ...folders.filter(f => f.name !== 'Flagged' && f.name !== 'Snoozed' && f.name !== 'INBOX')]
    : DEFAULT_FOLDERS.filter(f => f.name !== 'INBOX');

  // Staggered fade-in for folder items
  const folderAnims = useRef([]).current;
  while (folderAnims.length < folderList.length) folderAnims.push(new Animated.Value(0));

  useEffect(() => {
    const nd = Platform.OS !== 'web';
    folderAnims.forEach((anim, i) => {
      anim.setValue(0);
      Animated.timing(anim, {
        toValue: 1,
        duration: AnimTiming.normal,
        delay: i * AnimTiming.staggerFast,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }).start();
    });
  }, [folders?.length]);

  // Separate system folders from custom folders
  const systemFolderNames = ['INBOX', 'Sent', 'Drafts', 'Trash', 'Spam', 'Archive', 'Flagged', 'Snoozed', 'Junk'];
  const customFolders = folderList.filter(f => !systemFolderNames.includes(f.name) && !f.name?.startsWith('.'));

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    const r = await api.createFolder(name);
    if (r.success) {
      setNewFolderName('');
      setShowNewFolder(false);
      onFoldersChanged?.();
    }
  };

  const confirmAction = (title, message, onConfirm) => {
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(message)) onConfirm();
    } else {
      Alert.alert(title, message, [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('common.confirm'), style: 'destructive', onPress: onConfirm },
      ]);
    }
  };

  const handleDeleteFolder = async (name) => {
    confirmAction(
      t('sidebar.deleteFolder'),
      t('sidebar.deleteFolderConfirm', { name }),
      async () => {
        const r = await api.deleteFolder(name);
        if (r.success) {
          if (currentFolder === name) onFolderPress('INBOX');
          onFoldersChanged?.();
        }
      }
    );
  };

  const handleEmptyTrash = async () => {
    confirmAction(
      t('sidebar.emptyTrash'),
      t('sidebar.emptyTrashConfirm'),
      async () => {
        await api.emptyTrash();
        if (currentFolder === 'Trash') onFoldersChanged?.();
      }
    );
  };

  const handleComposePressIn = useCallback(() => {
    Animated.spring(composeScale, {
      toValue: 0.95,
      ...AnimTiming.springSnappy,
      useNativeDriver: false,
    }).start();
  }, []);

  const handleComposePressOut = useCallback(() => {
    Animated.spring(composeScale, {
      toValue: 1,
      tension: 160,
      friction: 10,
      useNativeDriver: false,
    }).start();
  }, []);

  // Collapsed mode: icon-only sidebar with tooltips
  if (collapsed) {
    const quickItems = [
      { label: t('sidebar.inbox'), icon: IconInbox, route: '/inbox', onPress: () => onFolderPress('INBOX') },
      { label: t('sidebar.messages'), icon: IconMessageSquare, route: '/chat', color: '#7C3AED', badge: chatUnread },
      { label: t('sidebar.meetings'), icon: IconFilm, route: '/meetings', color: '#ef4444' },
      { label: t('sidebar.calendar'), icon: IconCalendar, route: '/calendar', color: '#4285f4' },
      { label: 'Cloud', icon: IconFolder, route: '/drive', color: '#f59e0b' },
      { label: t('photos.title'), icon: IconCamera, route: '/photos', color: '#e11d48' },
      { label: t('sidebar.contacts'), icon: IconUser, route: '/contacts', color: '#8b5cf6' },
      { label: t('sidebar.documents'), icon: IconGlobe, route: '/documentos', color: '#4285f4' },
      { label: t('sidebar.notes'), icon: IconStickyNote, route: '/notes', color: '#f59e0b' },
      { label: 'One', icon: IconZap, route: '/one', color: '#A78BFA' },
      { label: t('snapmap.sidebar') || 'Mapa', icon: IconMapPin, route: '/snap-map', color: '#22c55e' },
    ];
    return (
      <ScrollView style={[s.sidebar, { backgroundColor: colors.sidebarBg }]} showsVerticalScrollIndicator={false} contentContainerStyle={s.collapsedContent}>
        {/* Collapsed compose button - icon only */}
        <Animated.View style={{ transform: [{ scale: composeScale }] }}>
          <TouchableOpacity
            style={[s.collapsedComposeBtn, { backgroundColor: colors.composeBg }]}
            onPress={onCompose}
            onPressIn={handleComposePressIn}
            onPressOut={handleComposePressOut}
            activeOpacity={1}
            {...(Platform.OS === 'web' ? { title: t('sidebar.compose') } : {})}
          >
            <IconCompose size={20} color={colors.composeText} />
          </TouchableOpacity>
        </Animated.View>
        {quickItems.map(item => {
          const isActive = item.route === '/inbox'
            ? !activeSidePanel?.length
            : (Array.isArray(activeSidePanel) ? activeSidePanel.includes(item.route) : activeSidePanel === item.route);
          const iconColor = item.color || colors.primary;
          return (
            <CollapsedItem
              key={item.route}
              item={item}
              isActive={isActive}
              iconColor={iconColor}
              colors={colors}
              onPress={item.onPress || (() => onNavigate?.(item.route))}
            />
          );
        })}
      </ScrollView>
    );
  }

  return (
    <ScrollView style={[s.sidebar, { backgroundColor: colors.sidebarBg }]} showsVerticalScrollIndicator={false} contentContainerStyle={s.sidebarContent}>
      {/* Compose */}
      <Animated.View style={{ transform: [{ scale: composeScale }] }}>
        <TouchableOpacity
          style={[s.composeBtn, Shadow.sm, { backgroundColor: colors.composeBg }]}
          onPress={onCompose}
          onPressIn={handleComposePressIn}
          onPressOut={handleComposePressOut}
          activeOpacity={1}
        >
          <IconCompose size={20} color={colors.composeText} style={{ marginRight: 10 }} />
          <Text style={[s.composeBtnText, { color: colors.composeText }]}>{t('sidebar.compose')}</Text>
        </TouchableOpacity>
      </Animated.View>

      {/* Inbox at top */}
      {(() => {
        const inboxFolder = folders?.find(f => f.name === 'INBOX');
        const inboxBadge = inboxFolder ? (inboxFolder.unread || inboxFolder.unseen || 0) : 0;
        return (
          <QuickAccessItem
            item={{ label: t('sidebar.inbox'), icon: IconInbox, route: '/inbox', badge: inboxBadge }}
            colors={colors}
            onPress={() => { onFolderPress('INBOX'); }}
          />
        );
      })()}

      {/* Quick Access — 5 primary items + More overflow.
          Split keeps the sidebar scannable; "Mais" expands to the rest
          without bloating the rail with 10+ icons the user rarely taps. */}
      <View style={[s.divider, { borderTopColor: colors.borderLight }]} />
      <Text style={[s.sectionLabel, { color: colors.textTertiary }]}>{t('sidebar.quickAccess')}</Text>
      {(() => {
        // Minimal default: utility (Search/Notif) + chat (most common pivot
        // from email). Tudo o resto vai pro "Mais" — antes ficava com 6 ícones
        // visíveis sempre, duplicando o que o Apps drawer (chat tab) já oferece.
        // Reclamação do usuário: "abre todas as funções de novo no menu lateral".
        const primary = [
          { label: t('sidebar.search') || 'Buscar', icon: IconSearch, route: '__search__', color: '#7C3AED' },
          { label: t('notifications.title') || 'Notificações', icon: IconBell, route: '__notifications__', color: '#f59e0b', badge: notifsUnread },
          { label: t('sidebar.messages'), icon: IconMessageSquare, route: '/chat', badge: chatUnread },
        ];
        const secondary = [
          { label: 'One',                  icon: IconZap,        route: '/one',       color: '#A78BFA' },
          { label: t('photos.title'),      icon: IconCamera,     route: '/photos',    color: '#e11d48' },
          { label: 'Chatyy Cloud',         icon: IconFolder,     route: '/drive',     color: '#f59e0b' },
          { label: t('sidebar.meetings'),  icon: IconFilm,       route: '/meetings' },
          { label: t('sidebar.calendar'),  icon: IconCalendar,   route: '/calendar' },
          { label: t('sidebar.contacts'),  icon: IconUser,       route: '/contacts' },
          { label: t('sidebar.documents'), icon: IconGlobe,      route: '/documentos', color: '#4285f4' },
          { label: t('sidebar.notes'),     icon: IconStickyNote, route: '/notes',      color: '#f59e0b' },
          // Saved Messages — Telegram-style "chat with yourself" with
          // dedicated screen (tabs, search, schedule reminders). Floppy-
          // disk feel uses IconBookmark since the codebase already ships it.
          { label: t('chat.savedMessages') || 'Mensagens Salvas', icon: IconBookmark, route: '/saved-messages', color: '#7C3AED' },
          // Lives salvas — replays of broadcasts the user saved (CF Stream
          // VOD). WAVE 99 (2026-05-21): user reported "salvo em lives mas
          // onde tá essa opção?" — the only discoverable entry points were
          // the Profile "Lives" tab and the end-card CTA after a broadcast.
          // Surfacing it in the sidebar More section gives a permanent
          // navigation target so the host can find their replays anytime.
          { label: t('sidebar.livesSaved') || 'Lives salvas', icon: IconPlay, route: '/lives-saved', color: '#7C3AED' },
          // Snap-Map / Friends-on-a-Map — Snapchat-style "where are my
          // friends" screen. Pin-icon is overloaded for "live location"
          // semantics already; the green color (matches the live-share
          // pulse) reads as "live now" at a glance.
          { label: t('snapmap.sidebar') || 'Mapa de Amigos', icon: IconMapPin, route: '/snap-map', color: '#22c55e' },
        ];
        const list = showMoreQuick ? [...primary, ...secondary] : primary;
        return (
          <>
            {list.map(item => (
              <QuickAccessItem
                key={item.route}
                item={item}
                colors={colors}
                isActive={Array.isArray(activeSidePanel) ? activeSidePanel.includes(item.route) : activeSidePanel === item.route}
                onPress={() => onNavigate?.(item.route)}
              />
            ))}
            {/* [beauty2 2026-05-31] align with QuickAccessItem rows (shared folderItem/iconWrap) */}
            <TouchableOpacity
              onPress={() => setShowMoreQuick(v => !v)}
              style={[s.folderItem, Platform.OS === 'web' && s.folderTransition]}
              activeOpacity={0.6}
            >
              <View style={s.folderIconWrap}>
                <IconPlus size={17} color={colors.textSecondary} />
              </View>
              <Text style={[s.folderLabel, { color: colors.textSecondary, fontWeight: '500' }]}>
                {showMoreQuick ? (t('sidebar.less') || 'Menos') : (t('sidebar.more') || 'Mais')}
              </Text>
            </TouchableOpacity>
          </>
        );
      })()}
      <View style={[s.divider, { borderTopColor: colors.borderLight }]} />

      {folderList.map((f, index) => {
        const isActive = currentFolder === f.name;
        while (folderAnims.length < folderList.length) folderAnims.push(new Animated.Value(0));
        const showTotal = ['Trash', 'Spam', 'Junk', 'Drafts'].includes(f.name);
        const badgeCount = showTotal ? (f.total || 0) : (f.unread || f.unseen || 0);
        const fColor = FOLDER_COLORS[f.name] || colors.primary;
        return (
          <View key={f.name}>
            <FolderItem
              folder={f}
              isActive={isActive}
              onPress={onFolderPress}
              colors={colors}
              t={t}
              dragOverFolder={dragOverFolder}
              setDragOverFolder={setDragOverFolder}
              onMoveEmail={onMoveEmail}
              currentFolder={currentFolder}
              folderAnim={folderAnims[index]}
            >
              <AnimatedBadge
                count={badgeCount}
                isActive={isActive}
                colors={colors}
                showTotal={showTotal}
                folderColor={fColor}
                isInbox={f.name === 'INBOX'}
              />
            </FolderItem>
            {f.name === 'Trash' && isActive && (
              <TouchableOpacity onPress={handleEmptyTrash} style={s.emptyTrashBtn} activeOpacity={0.6}>
                <Text style={[s.emptyTrashText, { color: colors.error }]}>{t('sidebar.emptyTrash')}</Text>
              </TouchableOpacity>
            )}
          </View>
        );
      })}

      {/* Custom folders */}
      {customFolders.length > 0 && (
        <>
          <View style={[s.divider, { borderTopColor: colors.borderLight }]} />
          <Text style={[s.sectionLabel, { color: colors.textTertiary }]}>{t('sidebar.folders')}</Text>
          {customFolders.map(f => (
            <View key={f.name} style={s.customFolderRow}>
              <TouchableOpacity
                style={[
                  s.folderItem, { flex: 1 },
                  currentFolder === f.name && { backgroundColor: colors.sidebarActiveBg },
                  Platform.OS === 'web' && s.folderTransition,
                ]}
                onPress={() => onFolderPress(f.name)}
                activeOpacity={0.6}
              >
                <View style={s.folderIconWrap}>
                  <IconFolder size={20} color={currentFolder === f.name ? colors.primary : colors.textSecondary} />
                </View>
                <Text style={[
                  s.folderLabel, { color: colors.text },
                  currentFolder === f.name && { fontWeight: '600', color: colors.primary },
                ]}>
                  {f.name}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => handleDeleteFolder(f.name)} style={s.deleteFolderBtn}>
                <IconX size={14} color={colors.textTertiary} />
              </TouchableOpacity>
            </View>
          ))}
        </>
      )}

      {/* Create folder */}
      {showNewFolder ? (
        <View style={[s.newFolderRow, { borderBottomColor: colors.borderLight }]}>
          <TextInput
            style={[s.newFolderInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceVariant }]}
            value={newFolderName}
            onChangeText={setNewFolderName}
            placeholder={t('sidebar.folderPlaceholder')}
            placeholderTextColor={colors.textTertiary}
            autoFocus
            onSubmitEditing={handleCreateFolder}
          />
          <TouchableOpacity onPress={handleCreateFolder} style={s.newFolderBtn}>
            <IconCheck size={16} color={colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { setShowNewFolder(false); setNewFolderName(''); }} style={s.newFolderBtn}>
            <IconX size={16} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity
          style={[s.createFolderBtn, Platform.OS === 'web' && s.folderTransition]}
          onPress={() => setShowNewFolder(true)}
          activeOpacity={0.6}
        >
          <View style={s.folderIconWrap}>
            <IconFolderPlus size={18} color={colors.textTertiary} />
          </View>
          <Text style={[s.createFolderText, { color: colors.textTertiary }]}>{t('sidebar.createFolder')}</Text>
        </TouchableOpacity>
      )}

      {/* Labels section — collapsible (chevron rotate spring) */}
      <View style={[s.divider, { borderTopColor: colors.borderLight }]} />
      <CollapsibleSection
        title={t('sidebar.labels')}
        colors={colors}
        defaultExpanded={true}
        storageKey="labels"
      >
        {LABEL_NAMES.map(name => {
          const labelStyle = LABEL_COLORS[name];
          const lc = labelCounts?.[name];
          const unreadCount = lc?.unread || 0;
          const totalCount = lc?.total || 0;
          return (
            <LabelItem
              key={name}
              name={name}
              labelStyle={labelStyle}
              colors={colors}
              isActive={activeLabel === name}
              unreadCount={unreadCount}
              totalCount={totalCount}
              onPress={() => onFolderPress('INBOX', name)}
            />
          );
        })}
      </CollapsibleSection>

      {/* User pill footer — avatar + name + status dot, tappable → profile.
          Replaces the old text-only logout row. Logout moves to a small icon
          on the right so the rail still has a one-tap escape, but the primary
          action is "view/edit my profile" (Gmail/Outlook pattern). */}
      <View style={[s.divider, { borderTopColor: colors.borderLight }]} />
      <UserPill
        user={user}
        colors={colors}
        t={t}
        onPress={() => onNavigate?.('/profile')}
        onLogout={async () => {
          const ok = Platform.OS === 'web'
            ? window.confirm(t('sidebar.logoutConfirm') || 'Deseja sair da conta?')
            : await confirm({
                title: t('sidebar.logout') || 'Sair',
                message: t('sidebar.logoutConfirm') || 'Deseja sair da conta?',
                confirmLabel: t('sidebar.logout') || 'Sair',
                destructive: true,
              });
          if (ok) doLogout?.();
        }}
      />
      <View style={{ height: 30 }} />
    </ScrollView>
  );
}

// Collapsible section with chevron rotate spring.
// Why: Labels/folders accumulate quickly; users want to collapse sections
// they don't need without losing the section header context.
function CollapsibleSection({ title, colors, defaultExpanded = true, children }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const rotate = useRef(new Animated.Value(defaultExpanded ? 1 : 0)).current;
  const childOpacity = useRef(new Animated.Value(defaultExpanded ? 1 : 0)).current;
  const [hovered, setHovered] = useState(false);

  const toggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    Animated.parallel([
      Animated.spring(rotate, {
        toValue: next ? 1 : 0,
        ...AnimTiming.springSnappy,
        useNativeDriver: true,
      }),
      Animated.timing(childOpacity, {
        toValue: next ? 1 : 0,
        duration: AnimTiming.fast,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [expanded, rotate, childOpacity]);

  const rotateDeg = rotate.interpolate({ inputRange: [0, 1], outputRange: ['-90deg', '0deg'] });
  const webHover = Platform.OS === 'web' ? {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  } : {};

  return (
    <View>
      <TouchableOpacity
        onPress={toggle}
        activeOpacity={0.6}
        style={[
          s.collapsibleHeader,
          hovered && Platform.OS === 'web' && { backgroundColor: colors.folderHover },
        ]}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        {...webHover}
      >
        <Text style={[s.sectionLabel, { color: colors.textTertiary, paddingHorizontal: 0, marginBottom: 0, flex: 1 }]}>
          {title}
        </Text>
        <Animated.View style={{ transform: [{ rotate: rotateDeg }] }}>
          <IconChevronDown size={14} color={colors.textTertiary} />
        </Animated.View>
      </TouchableOpacity>
      {expanded && (
        <Animated.View style={{ opacity: childOpacity }}>
          {children}
        </Animated.View>
      )}
    </View>
  );
}

// User pill footer — avatar + name + green dot + small logout icon.
// Single tap on the pill body → profile; small X on the right → logout.
function UserPill({ user, colors, t, onPress, onLogout }) {
  const [hovered, setHovered] = useState(false);
  const pressScale = useRef(new Animated.Value(1)).current;
  const webHover = Platform.OS === 'web' ? {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  } : {};

  const name = user?.name || user?.email?.split('@')[0] || t('sidebar.profile') || 'Profile';
  const email = user?.email || '';

  return (
    <Animated.View style={{ transform: [{ scale: pressScale }] }}>
      <View style={[s.userPill, hovered && { backgroundColor: colors.folderHover }]} {...webHover}>
        <TouchableOpacity
          style={s.userPillBody}
          onPress={onPress}
          onPressIn={() => Animated.spring(pressScale, { toValue: 0.98, ...AnimTiming.springPress, useNativeDriver: true }).start()}
          onPressOut={() => Animated.spring(pressScale, { toValue: 1, ...AnimTiming.springSmooth, useNativeDriver: true }).start()}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel={t('sidebar.profile') || 'Profile'}
        >
          <View style={s.userPillAvatarWrap}>
            <AvatarCircle email={email} name={name} size={36} />
            {/* Online status dot — green ring + dot */}
            <View style={[s.userPillStatusDot, { borderColor: colors.sidebarBg, backgroundColor: '#10b981' }]} />
          </View>
          <View style={{ flex: 1, marginLeft: 10, minWidth: 0 }}>
            <Text numberOfLines={1} style={[s.userPillName, { color: colors.text }]}>{name}</Text>
            {!!email && (
              <Text numberOfLines={1} style={[s.userPillEmail, { color: colors.textTertiary }]}>{email}</Text>
            )}
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onLogout}
          style={s.userPillLogout}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel={t('sidebar.logout') || 'Sair'}
          {...(Platform.OS === 'web' ? { title: t('sidebar.logout') || 'Sair' } : {})}
        >
          <IconLogout size={18} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

// Collapsed sidebar item — icon only with tooltip on hover
function CollapsedItem({ item, isActive, iconColor, colors, onPress }) {
  const [hovered, setHovered] = useState(false);
  const webHover = Platform.OS === 'web' ? {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  } : {};

  return (
    <TouchableOpacity
      style={[
        s.collapsedItem,
        hovered && { backgroundColor: iconColor + '12' },
        isActive && { backgroundColor: iconColor + '18' },
      ]}
      onPress={onPress}
      activeOpacity={0.6}
      {...webHover}
      {...(Platform.OS === 'web' ? { title: item.label } : {})}
    >
      <item.icon size={20} color={isActive ? iconColor : colors.textSecondary} />
      {item.badge > 0 && (
        <View style={[s.collapsedBadge, { backgroundColor: colors.primary }]}>
          <Text style={s.collapsedBadgeText}>{item.badge > 9 ? '9+' : item.badge}</Text>
        </View>
      )}
      {/* Tooltip on hover */}
      {hovered && Platform.OS === 'web' && (
        <View style={[s.collapsedTooltip, { backgroundColor: colors.text }]}>
          <Text style={[s.collapsedTooltipText, { color: colors.background }]}>{item.label}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

// Quick Access item with hover effect and optional badge
function QuickAccessItem({ item, colors, onPress, isActive }) {
  const [hovered, setHovered] = useState(false);
  const webHover = Platform.OS === 'web' ? {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  } : {};

  const iconColor = item.color || colors.primary;

  return (
    <TouchableOpacity
      style={[
        s.folderItem,
        hovered && { backgroundColor: colors.folderHover },
        isActive && { backgroundColor: iconColor + '12' },
        Platform.OS === 'web' && s.folderTransition,
      ]}
      onPress={onPress}
      activeOpacity={0.6}
      {...webHover}
    >
      <View style={[s.folderIconWrap, { backgroundColor: isActive ? iconColor + '18' : (hovered ? iconColor + '0a' : 'transparent'), borderRadius: 8 }]}>
        <item.icon size={18} color={isActive ? iconColor : (item.color || colors.textSecondary)} />
      </View>
      <Text style={[s.folderLabel, { color: isActive ? iconColor : colors.text, fontWeight: isActive ? '700' : '500' }]}>{item.label}</Text>
      {item.badge > 0 && (
        <View style={[s.quickBadge, { backgroundColor: colors.primary }]}>
          <Text style={s.quickBadgeText}>{item.badge > 99 ? '99+' : item.badge}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

// Label item with hover effect and unread badge
function LabelItem({ name, labelStyle, colors, onPress, isActive, unreadCount, totalCount }) {
  const [hovered, setHovered] = useState(false);
  const webHover = Platform.OS === 'web' ? {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  } : {};

  return (
    <TouchableOpacity
      style={[
        s.labelItem,
        hovered && !isActive && { backgroundColor: colors.folderHover },
        isActive && { backgroundColor: labelStyle.text + '15' },
        Platform.OS === 'web' && s.folderTransition,
      ]}
      onPress={onPress}
      activeOpacity={0.6}
      {...webHover}
    >
      <View style={[s.labelDot, { backgroundColor: labelStyle.text }, isActive && { width: 12, height: 12, borderRadius: 6 }]} />
      <Text style={[s.labelText, { color: isActive ? labelStyle.text : colors.text }, isActive && { fontWeight: '700' }]} numberOfLines={1}>
        {name.charAt(0).toUpperCase() + name.slice(1)}
      </Text>
      {unreadCount > 0 && (
        <View style={[s.labelBadge, { backgroundColor: labelStyle.text }]}>
          <Text style={s.labelBadgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
        </View>
      )}
      {unreadCount === 0 && totalCount > 0 && (
        <Text style={[s.labelCountText, { color: colors.textTertiary }]}>{totalCount}</Text>
      )}
    </TouchableOpacity>
  );
}

export default memo(Sidebar, (prev, next) => {
  return prev.currentFolder === next.currentFolder
    && prev.activeSidePanel === next.activeSidePanel
    && prev.activeLabel === next.activeLabel
    && prev.folders === next.folders
    && prev.collapsed === next.collapsed
    && prev.labelCounts === next.labelCounts;
});

const s = StyleSheet.create({
  sidebar: { flex: 1 },
  sidebarContent: { paddingHorizontal: Spacing.sm, paddingTop: Spacing.md, paddingBottom: Spacing.xxl },
  // [beauty2 2026-05-31] softer brand-tinted shadow + a touch more breathing room
  composeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderRadius: 28, paddingVertical: 15, paddingHorizontal: 24,
    marginBottom: Spacing.lg, marginHorizontal: Spacing.sm,
    ...Platform.select({
      web: {
        transition: 'all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)',
        cursor: 'pointer',
        boxShadow: '0 4px 14px rgba(124,58,237,0.28)',
        backgroundColor: '#7C3AED',
      },
      default: {},
    }),
  },
  composeBtnText: { fontSize: 15, fontWeight: '700', letterSpacing: 0.3 },
  folderItem: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 11, paddingHorizontal: Spacing.lg,
    borderRadius: 14, borderTopRightRadius: 26, borderBottomRightRadius: 26,
    marginBottom: 3, marginRight: Spacing.xs,
    position: 'relative',
    overflow: 'hidden',
  },
  folderActiveBg: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: Spacing.xs,
    bottom: 0,
  },
  activeIndicator: {
    position: 'absolute',
    left: 0,
    top: 2,
    bottom: 2,
    borderTopRightRadius: 3,
    borderBottomRightRadius: 3,
  },
  folderTransition: Platform.OS === 'web' ? {
    transition: 'background-color 0.18s ease, transform 0.15s ease, box-shadow 0.18s ease',
    cursor: 'pointer',
  } : {},
  folderItemHoverShadow: Platform.OS === 'web' ? {
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
    transform: [{ translateX: 2 }],
  } : {},
  folderIconWrap: { marginRight: 14, width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 9 },
  folderLabel: { fontSize: 14, flex: 1, fontWeight: '600', letterSpacing: -0.15 },
  folderCount: { fontSize: 11, fontWeight: '600', marginRight: 6, minWidth: 18, textAlign: 'right' },
  badgeWrap: {
    borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3, minWidth: 24, alignItems: 'center',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 2px 6px rgba(0,0,0,0.15)',
    } : {
      shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 4, elevation: 3,
    }),
  },
  badgeWrapInbox: {
    borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4, minWidth: 28,
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.2 },
  badgeTextInbox: { fontSize: 12, fontWeight: '800' },
  quickBadge: {
    borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3, minWidth: 22, alignItems: 'center',
  },
  quickBadgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  // Labels section
  // [beauty2 2026-05-31] lighter hairline divider, calmer rhythm
  divider: { borderTopWidth: 1, marginVertical: Spacing.md, marginHorizontal: Spacing.lg, opacity: 0.7 },
  // [beauty2 2026-05-31] crisper, more premium uppercase header
  sectionLabel: {
    fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8,
    paddingHorizontal: Spacing.lg, marginBottom: Spacing.sm, marginTop: 2,
  },
  labelItem: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 8, paddingHorizontal: Spacing.lg,
    borderRadius: 10, marginBottom: 1,
    ...(Platform.OS === 'web' ? {
      transition: 'background-color 0.15s ease, transform 0.12s ease',
      cursor: 'pointer',
    } : {}),
  },
  labelDot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  labelText: { fontSize: 14, flex: 1, fontWeight: '500', letterSpacing: -0.1 },
  labelBadge: {
    borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2, minWidth: 20, alignItems: 'center',
  },
  labelBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  labelCountText: { fontSize: 11, fontWeight: '600', marginLeft: 4 },
  // Create folder
  createFolderBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 8, paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.lg, marginBottom: 1, marginTop: Spacing.xs,
  },
  createFolderText: { fontSize: FontSize.sm },
  newFolderRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm, gap: 4,
  },
  newFolderInput: {
    flex: 1, fontSize: FontSize.sm, borderWidth: 1, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.sm, paddingVertical: 4,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  newFolderBtn: { padding: 6 },
  customFolderRow: { flexDirection: 'row', alignItems: 'center' },
  deleteFolderBtn: { padding: 6, marginRight: Spacing.sm },
  // [beauty2 2026-05-31] align under the folder label (16 padding + 30 icon + 14 gap = 60)
  emptyTrashBtn: { paddingLeft: 60, paddingVertical: 4, paddingBottom: 8 },
  emptyTrashText: { fontSize: FontSize.xs, fontWeight: '600', letterSpacing: 0.1 },
  // Collapsed sidebar styles
  collapsedContent: { alignItems: 'center', paddingTop: Spacing.md, paddingBottom: Spacing.xxl, paddingHorizontal: 4 },
  // [beauty2 2026-05-31] brand-tinted shadow matches expanded compose CTA
  collapsedComposeBtn: {
    width: 44, height: 44, borderRadius: 15,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.md,
    ...(Platform.OS === 'web' ? {
      cursor: 'pointer',
      boxShadow: '0 4px 12px rgba(124,58,237,0.28)',
      backgroundColor: '#7C3AED',
      transition: 'transform 0.15s ease, box-shadow 0.15s ease',
    } : {}),
  },
  collapsedItem: {
    width: 44, height: 44, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 2, position: 'relative',
    ...(Platform.OS === 'web' ? {
      cursor: 'pointer',
      transition: 'background-color 0.15s ease, transform 0.12s ease',
    } : {}),
  },
  collapsedBadge: {
    position: 'absolute', top: 4, right: 4,
    borderRadius: 8, minWidth: 16, height: 16,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3,
  },
  collapsedBadgeText: { color: '#fff', fontSize: 9, fontWeight: '800' },
  collapsedTooltip: {
    position: 'absolute', left: 56, top: '50%',
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6,
    zIndex: 1000,
    ...(Platform.OS === 'web' ? {
      transform: [{ translateY: -14 }],
      boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
    } : {}),
  },
  collapsedTooltipText: { fontSize: 12, fontWeight: '600' },
  // Collapsible section header (chevron rotate spring)
  collapsibleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: 6,
    marginBottom: Spacing.sm,
    marginTop: 2,
    borderRadius: 8,
    ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'background-color 0.15s ease' } : {}),
  },
  // User pill footer (avatar + name + status dot, tappable to profile)
  // [beauty2 2026-05-31] roomier pill + larger radius for a softer footer
  userPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 9,
    marginHorizontal: 8,
    marginBottom: 4,
    borderRadius: 16,
    ...(Platform.OS === 'web' ? { transition: 'background-color 0.18s ease' } : {}),
  },
  userPillBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : {}),
  },
  userPillAvatarWrap: { position: 'relative', width: 36, height: 36 },
  userPillStatusDot: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 11,
    height: 11,
    borderRadius: 6,
    borderWidth: 2,
  },
  userPillName: { fontSize: 13.5, fontWeight: '700', letterSpacing: -0.15 },
  userPillEmail: { fontSize: 11, fontWeight: '500', marginTop: 2, letterSpacing: -0.05 },
  userPillLogout: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
    ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'background-color 0.15s ease' } : {}),
  },
});
