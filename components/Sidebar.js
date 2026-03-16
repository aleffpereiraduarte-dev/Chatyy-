import { useState, useRef, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Platform, ScrollView, Alert, Animated, Easing } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing, Shadow, Transition, AnimTiming } from '../constants/theme';
import {
  IconInbox, IconSend, IconDraft, IconTrash, IconAlertTriangle,
  IconArchive, IconStarFilled, IconCompose, IconFolder, IconClock,
  IconFolderPlus, IconPlus, IconX, IconCheck,
  IconFilm, IconMessageSquare, IconCalendar, IconGlobe, IconUser, IconZap, IconCamera, IconStar,
} from './Icons';
import { LABEL_COLORS, LABEL_NAMES } from './LabelPicker';
import * as api from '../services/api';

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
  { name: 'Drafts' }, { name: 'Trash' }, { name: 'Spam' },
];

// Animated badge component with entrance animation
function AnimatedBadge({ count, isActive, colors, showTotal }) {
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
          useNativeDriver: Platform.OS !== 'web',
        }).start();
      }
    } else {
      Animated.timing(scaleAnim, {
        toValue: 0,
        duration: AnimTiming.fast,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: Platform.OS !== 'web',
      }).start();
    }
    prevCount.current = count;
  }, [count]);

  if (count <= 0 && prevCount.current === 0) return null;

  return (
    <Animated.View
      style={[
        s.badgeWrap,
        {
          backgroundColor: isActive ? colors.primary : (showTotal ? colors.textTertiary : colors.badge),
          transform: [{ scale: scaleAnim }],
          opacity: scaleAnim,
        },
      ]}
    >
      <Text style={[s.badgeText, { fontWeight: '700' }]}>{count || prevCount.current}</Text>
    </Animated.View>
  );
}

// Animated folder item with active indicator
function FolderItem({ folder, isActive, onPress, colors, t, dragOverFolder, setDragOverFolder, onMoveEmail, currentFolder, folderAnim, children }) {
  const FolderIcon = FOLDER_ICONS[folder.name] || IconFolder;
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
        useNativeDriver: nd,
      }),
    ]).start();
  }, [isActive]);

  const webHover = Platform.OS === 'web' ? {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  } : {};

  return (
    <Animated.View style={{ opacity: folderAnim }}>
      <View style={{ position: 'relative' }}>
        {/* Animated active background */}
        <Animated.View
          style={[
            s.folderActiveBg,
            {
              backgroundColor: colors.sidebarActiveBg,
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
          {/* Animated active left border */}
          <Animated.View
            style={[
              s.activeIndicator,
              {
                width: activeIndicatorWidth,
                backgroundColor: colors.primary,
              },
            ]}
          />
          <View style={s.folderIconWrap}>
            <FolderIcon size={20} color={isActive ? colors.primary : colors.textSecondary} />
          </View>
          <Text style={[
            s.folderLabel,
            { color: colors.text },
            isActive && { fontWeight: '600', color: colors.primary },
          ]}>
            {folder.name === 'INBOX' ? (t('folder.allMail') || 'Todos os emails') : (FOLDER_KEYS[folder.name] ? t(FOLDER_KEYS[folder.name]) : folder.name)}
          </Text>
          {children}
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

export default function Sidebar({ folders, currentFolder, onFolderPress, onCompose, onFoldersChanged, onMoveEmail, onNavigate, activeSidePanel }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [dragOverFolder, setDragOverFolder] = useState(null);
  const [chatUnread, setChatUnread] = useState(0);

  // Fetch chat unread count
  useEffect(() => {
    let mounted = true;
    const fetchChatUnread = async () => {
      try {
        const r = await api.chatUnreadCount();
        if (mounted && r.success) setChatUnread(r.data?.count || 0);
      } catch {}
    };
    fetchChatUnread();
    const interval = setInterval(fetchChatUnread, 30000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  // Compose button press animation
  const composeScale = useRef(new Animated.Value(1)).current;

  const folderList = folders?.length > 0
    ? [{ name: 'Flagged' }, { name: 'Snoozed' }, ...folders.filter(f => f.name !== 'Flagged' && f.name !== 'Snoozed')]
    : DEFAULT_FOLDERS;

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
        useNativeDriver: nd,
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
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, []);

  const handleComposePressOut = useCallback(() => {
    Animated.spring(composeScale, {
      toValue: 1,
      tension: 160,
      friction: 10,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, []);

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
        const inboxFolder = folderList.find(f => f.name === 'INBOX');
        const inboxBadge = inboxFolder ? (inboxFolder.unread || inboxFolder.unseen || 0) : 0;
        return (
          <QuickAccessItem
            item={{ label: t('sidebar.inbox'), icon: IconInbox, route: '/inbox', badge: inboxBadge }}
            colors={colors}
            onPress={() => { onFolderPress('INBOX'); }}
          />
        );
      })()}

      {/* Quick Access */}
      <View style={[s.divider, { borderTopColor: colors.borderLight }]} />
      <Text style={[s.sectionLabel, { color: colors.textTertiary }]}>{t('sidebar.quickAccess')}</Text>
      {[
        { label: t('sidebar.messages'), icon: IconMessageSquare, route: '/chat', badge: chatUnread },
        { label: t('sidebar.meetings'), icon: IconFilm, route: '/meetings' },
        { label: t('sidebar.calendar'), icon: IconCalendar, route: '/calendar' },
        { label: 'Chatyy Drive', icon: IconFolder, route: '/drive', color: '#f59e0b' },
        { label: t('photos.title'), icon: IconCamera, route: '/photos', color: '#e11d48' },
        { label: t('sidebar.contacts'), icon: IconUser, route: '/contacts' },
        { label: t('sidebar.documents'), icon: IconGlobe, route: '/documentos', color: '#4285f4' },
        { label: 'One', icon: IconZap, route: '/one', color: '#6366f1' },
        { label: 'Chatyy Plus', icon: IconStar, route: '/plans', color: '#6366f1' },
      ].map(item => (
        <QuickAccessItem
          key={item.route}
          item={item}
          colors={colors}
          isActive={activeSidePanel === item.route}
          onPress={() => onNavigate?.(item.route)}
        />
      ))}
      <View style={[s.divider, { borderTopColor: colors.borderLight }]} />

      {folderList.map((f, index) => {
        const isActive = currentFolder === f.name;
        while (folderAnims.length < folderList.length) folderAnims.push(new Animated.Value(0));
        const showTotal = ['Trash', 'Spam', 'Junk', 'Drafts'].includes(f.name);
        const badgeCount = showTotal ? (f.total || 0) : (f.unread || f.unseen || 0);
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

      {/* Labels section */}
      <View style={[s.divider, { borderTopColor: colors.borderLight }]} />
      <Text style={[s.sectionLabel, { color: colors.textTertiary }]}>{t('sidebar.labels')}</Text>
      {LABEL_NAMES.map(name => {
        const labelStyle = LABEL_COLORS[name];
        return (
          <LabelItem
            key={name}
            name={name}
            labelStyle={labelStyle}
            colors={colors}
            onPress={() => onFolderPress('INBOX', name)}
          />
        );
      })}
    </ScrollView>
  );
}

// Quick Access item with hover effect and optional badge
function QuickAccessItem({ item, colors, onPress, isActive }) {
  const [hovered, setHovered] = useState(false);
  const webHover = Platform.OS === 'web' ? {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  } : {};

  return (
    <TouchableOpacity
      style={[
        s.folderItem,
        hovered && { backgroundColor: colors.folderHover },
        isActive && { backgroundColor: (item.color || colors.primary) + '15', borderLeftWidth: 3, borderLeftColor: item.color || colors.primary },
        Platform.OS === 'web' && s.folderTransition,
      ]}
      onPress={onPress}
      activeOpacity={0.6}
      {...webHover}
    >
      <View style={s.folderIconWrap}>
        <item.icon size={20} color={isActive ? (item.color || colors.primary) : (item.color || colors.textSecondary)} />
      </View>
      <Text style={[s.folderLabel, { color: isActive ? (item.color || colors.primary) : colors.text, fontWeight: isActive ? '700' : '500' }]}>{item.label}</Text>
      {item.badge > 0 && (
        <View style={[s.quickBadge, { backgroundColor: colors.primary }]}>
          <Text style={s.quickBadgeText}>{item.badge > 99 ? '99+' : item.badge}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

// Label item with hover effect
function LabelItem({ name, labelStyle, colors, onPress }) {
  const [hovered, setHovered] = useState(false);
  const webHover = Platform.OS === 'web' ? {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  } : {};

  return (
    <TouchableOpacity
      style={[
        s.labelItem,
        hovered && { backgroundColor: colors.folderHover },
        Platform.OS === 'web' && s.folderTransition,
      ]}
      onPress={onPress}
      activeOpacity={0.6}
      {...webHover}
    >
      <View style={[s.labelDot, { backgroundColor: labelStyle.text }]} />
      <Text style={[s.labelText, { color: colors.text }]} numberOfLines={1}>
        {name.charAt(0).toUpperCase() + name.slice(1)}
      </Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  sidebar: { flex: 1 },
  sidebarContent: { paddingHorizontal: Spacing.md, paddingTop: Spacing.lg, paddingBottom: Spacing.xxl },
  composeBtn: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: BorderRadius.xxl, paddingVertical: 14, paddingHorizontal: Spacing.xxl,
    marginBottom: Spacing.xl, marginHorizontal: Spacing.xs,
    ...Platform.select({
      web: {
        transition: 'all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)',
        cursor: 'pointer',
        boxShadow: '0 1px 3px rgba(37, 99, 235, 0.25), 0 6px 16px rgba(37, 99, 235, 0.15)',
      },
      default: {},
    }),
  },
  composeBtnText: { fontSize: FontSize.lg, fontWeight: '600' },
  folderItem: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 11, paddingHorizontal: Spacing.lg,
    borderRadius: 0, borderTopRightRadius: BorderRadius.xxl, borderBottomRightRadius: BorderRadius.xxl,
    marginBottom: 2, marginRight: Spacing.sm,
    position: 'relative',
    overflow: 'hidden',
  },
  folderActiveBg: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: Spacing.sm,
    bottom: 0,
  },
  activeIndicator: {
    position: 'absolute',
    left: 0,
    top: 4,
    bottom: 4,
    borderTopRightRadius: 2,
    borderBottomRightRadius: 2,
  },
  folderTransition: Platform.OS === 'web' ? {
    transition: 'background-color 0.2s ease, transform 0.15s ease',
    cursor: 'pointer',
  } : {},
  folderIconWrap: { marginRight: Spacing.md, width: 24, alignItems: 'center' },
  folderLabel: { fontSize: FontSize.base, flex: 1 },
  badgeWrap: {
    borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, minWidth: 24, alignItems: 'center',
  },
  badgeText: { color: '#fff', fontSize: FontSize.xs, fontWeight: '700' },
  quickBadge: {
    borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2, minWidth: 20, alignItems: 'center',
  },
  quickBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  // Labels section
  divider: { borderTopWidth: 1, marginVertical: Spacing.md, marginHorizontal: Spacing.lg },
  sectionLabel: {
    fontSize: FontSize.sm, fontWeight: '600',
    paddingHorizontal: Spacing.lg, marginBottom: Spacing.sm,
  },
  labelItem: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 8, paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.lg, marginBottom: 1,
  },
  labelDot: { width: 12, height: 12, borderRadius: 6, marginRight: Spacing.md },
  labelText: { fontSize: FontSize.base, flex: 1 },
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
  emptyTrashBtn: { paddingLeft: 56, paddingVertical: 4, paddingBottom: 6 },
  emptyTrashText: { fontSize: FontSize.xs, fontWeight: '600' },
});
