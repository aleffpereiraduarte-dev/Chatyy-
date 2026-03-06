import { useState, useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Platform, ScrollView, Alert, Animated, Easing } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing, Shadow, Transition } from '../constants/theme';
import {
  IconInbox, IconSend, IconDraft, IconTrash, IconAlertTriangle,
  IconArchive, IconStarFilled, IconCompose, IconFolder, IconClock,
  IconFolderPlus, IconPlus, IconX, IconCheck,
  IconFilm, IconMessageSquare, IconCalendar, IconGlobe,
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

export default function Sidebar({ folders, currentFolder, onFolderPress, onCompose, onFoldersChanged, onMoveEmail, onNavigate }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [dragOverFolder, setDragOverFolder] = useState(null);

  const folderList = folders?.length > 0
    ? [{ name: 'Flagged' }, { name: 'Snoozed' }, ...folders.filter(f => f.name !== 'Flagged' && f.name !== 'Snoozed')]
    : DEFAULT_FOLDERS;

  // Staggered fade-in for folder items
  const folderAnims = useRef([]).current;
  while (folderAnims.length < folderList.length) folderAnims.push(new Animated.Value(0));

  useEffect(() => {
    folderAnims.forEach((anim, i) => {
      anim.setValue(0);
      Animated.timing(anim, {
        toValue: 1, duration: 200, delay: i * 40,
        useNativeDriver: true,
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

  return (
    <ScrollView style={[s.sidebar, { backgroundColor: colors.sidebarBg }]} showsVerticalScrollIndicator={false} contentContainerStyle={s.sidebarContent}>
      {/* Compose */}
      <TouchableOpacity
        style={[s.composeBtn, Shadow.sm, { backgroundColor: colors.composeBg }]}
        onPress={onCompose}
        activeOpacity={0.7}
      >
        <IconCompose size={20} color={colors.composeText} style={{ marginRight: 10 }} />
        <Text style={[s.composeBtnText, { color: colors.composeText }]}>{t('sidebar.compose')}</Text>
      </TouchableOpacity>

      {/* Quick Access */}
      <View style={[s.divider, { borderTopColor: colors.borderLight }]} />
      <Text style={[s.sectionLabel, { color: colors.textTertiary }]}>{t('sidebar.quickAccess')}</Text>
      {[
        { label: t('sidebar.meetings'), icon: IconFilm, route: '/meetings' },
        { label: t('sidebar.files'), icon: IconFolder, route: '/files' },
        { label: t('sidebar.messages'), icon: IconMessageSquare, route: '/chat' },
        { label: t('sidebar.calendar'), icon: IconCalendar, route: '/calendar' },
        { label: t('sidebar.documents'), icon: IconGlobe, route: '/documentos', color: '#4285f4' },
      ].map(item => (
        <TouchableOpacity
          key={item.route}
          style={[s.folderItem, Platform.OS === 'web' && s.folderTransition]}
          onPress={() => onNavigate?.(item.route)}
          activeOpacity={0.6}
        >
          <View style={s.folderIconWrap}>
            <item.icon size={20} color={item.color || colors.textSecondary} />
          </View>
          <Text style={[s.folderLabel, { color: colors.text }]}>{item.label}</Text>
        </TouchableOpacity>
      ))}
      <View style={[s.divider, { borderTopColor: colors.borderLight }]} />

      {folderList.map((f, index) => {
        const isActive = currentFolder === f.name;
        const FolderIcon = FOLDER_ICONS[f.name] || IconFolder;
        while (folderAnims.length < folderList.length) folderAnims.push(new Animated.Value(0));
        return (
          <Animated.View key={f.name} style={{ opacity: folderAnims[index] }}>
            <TouchableOpacity
              style={[
                s.folderItem,
                isActive && { backgroundColor: colors.sidebarActiveBg, borderLeftWidth: 3, borderLeftColor: colors.primary, paddingLeft: Spacing.lg - 3 },
                dragOverFolder === f.name && { backgroundColor: colors.primaryLight, borderColor: colors.primary, borderWidth: 1 },
                Platform.OS === 'web' && s.folderTransition,
              ]}
              onPress={() => onFolderPress(f.name)}
              activeOpacity={0.6}
              {...(Platform.OS === 'web' ? {
                onDragOver: (e) => { e.preventDefault?.(); setDragOverFolder(f.name); },
                onDragLeave: () => setDragOverFolder(null),
                onDrop: (e) => {
                  e.preventDefault?.();
                  setDragOverFolder(null);
                  try {
                    const data = JSON.parse(e.dataTransfer?.getData('text/plain') || '{}');
                    if (data.uid && f.name !== currentFolder) onMoveEmail?.(data.uid, f.name);
                  } catch {}
                },
              } : {})}
            >
              <View style={s.folderIconWrap}>
                <FolderIcon size={20} color={isActive ? colors.primary : colors.textSecondary} />
              </View>
              <Text style={[
                s.folderLabel,
                { color: colors.text },
                isActive && { fontWeight: '600', color: colors.primary },
              ]}>
                {FOLDER_KEYS[f.name] ? t(FOLDER_KEYS[f.name]) : f.name}
              </Text>
              {(() => {
                // Trash/Spam/Drafts: show total count; others: show unread count
                const showTotal = ['Trash', 'Spam', 'Junk', 'Drafts'].includes(f.name);
                const badgeCount = showTotal ? (f.total || 0) : (f.unread || f.unseen || 0);
                return badgeCount > 0 ? (
                  <View style={[
                    s.badgeWrap,
                    { backgroundColor: isActive ? colors.primary : (showTotal ? colors.textTertiary : colors.badge) },
                  ]}>
                    <Text style={[s.badgeText, { fontWeight: '700' }]}>{badgeCount}</Text>
                  </View>
                ) : null;
              })()}
            </TouchableOpacity>
            {f.name === 'Trash' && isActive && (
              <TouchableOpacity onPress={handleEmptyTrash} style={s.emptyTrashBtn} activeOpacity={0.6}>
                <Text style={[s.emptyTrashText, { color: colors.error }]}>{t('sidebar.emptyTrash')}</Text>
              </TouchableOpacity>
            )}
          </Animated.View>
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
          <TouchableOpacity
            key={name}
            style={[s.labelItem, Platform.OS === 'web' && s.folderTransition]}
            onPress={() => onFolderPress('INBOX', name)}
            activeOpacity={0.6}
          >
            <View style={[s.labelDot, { backgroundColor: labelStyle.text }]} />
            <Text style={[s.labelText, { color: colors.text }]} numberOfLines={1}>
              {name.charAt(0).toUpperCase() + name.slice(1)}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
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
  },
  folderTransition: Platform.OS === 'web' ? {
    transition: 'all 0.2s ease',
    cursor: 'pointer',
  } : {},
  folderIconWrap: { marginRight: Spacing.md, width: 24, alignItems: 'center' },
  folderLabel: { fontSize: FontSize.base, flex: 1 },
  badgeWrap: {
    borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, minWidth: 24, alignItems: 'center',
  },
  badgeText: { color: '#fff', fontSize: FontSize.xs, fontWeight: '700' },
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
