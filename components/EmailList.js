import { useRef, useEffect, useMemo, useCallback } from 'react';
import { View, FlatList, Text, TouchableOpacity, ActivityIndicator, RefreshControl, StyleSheet, Platform } from 'react-native';
// FlatList only (FlashList crashes iOS SDK55)
const ListComponent = FlatList;
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, DENSITY_CONFIG } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';
import EmailRow from './EmailRow';
import EmptyState from './EmptyState';
import { EmailSkeleton } from './SkeletonLoader';
import {
  IconRefresh, IconChevronLeft, IconChevronRight,
  IconCheckbox, IconCheckboxChecked, IconTrash, IconArchive,
  IconMarkRead, IconMarkUnread, IconX,
} from './Icons';

function getDateSectionKey(dateStr) {
  if (!dateStr) return 'date.older';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 'date.older';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const emailDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.floor((today - emailDay) / 86400000);

  if (diffDays === 0) return 'date.today';
  if (diffDays === 1) return 'date.yesterday';
  if (diffDays < 7) return 'date.thisWeek';
  if (diffDays < 30) return 'date.thisMonth';
  return 'date.older';
}

function addSectionHeaders(emails) {
  if (!emails?.length) return [];
  const result = [];
  let lastSection = null;
  for (const email of emails) {
    const section = getDateSectionKey(email.date);
    if (section !== lastSection) {
      result.push({ _sectionHeader: true, _sectionKey: section, _key: `section_${section}` });
      lastSection = section;
    }
    result.push(email);
  }
  return result;
}

function calcImportanceScore(email) {
  let score = 0;
  if (email.flagged) score += 30;
  if (email.thread_count > 1) score += 15;
  if (email.has_attachments || email.attachments?.length > 0) score += 5;
  const from = (email.from || '').toLowerCase();
  if (!from.includes('noreply') && !from.includes('no-reply')) score += 10;
  if (!from.includes('newsletter') && !from.includes('promo') && !from.includes('marketing')) score += 10;
  if (email.labels?.length > 0) score += 10;
  if (!email.seen) score += 5;
  return score;
}

function splitImportant(emails) {
  const important = [];
  const rest = [];
  for (const email of emails) {
    if (calcImportanceScore(email) > 30) important.push(email);
    else rest.push(email);
  }
  return { important, rest };
}

export default function EmailList({
  emails, loading, currentFolder, selectedUid, search,
  page, totalPages,
  onEmailPress, onStar, onRefresh, onPageChange,
  // Selection props
  selectMode, selectedUids, onToggleSelect, onSelectAll, onClearSelection,
  onBulkDelete, onBulkArchive, onBulkMarkRead, onBulkMarkUnread,
  onArchiveEmail, onDeleteEmail, onSnoozeEmail,
  // Context menu
  onContextMenu,
  // Search highlighting
  searchQuery,
  // Muted UIDs
  mutedUids,
  // Trash / Spam actions
  onEmptyTrash,
  onClearSpam,
}) {
  const { colors, inboxType } = useTheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const dragRef = useRef({ active: false });

  // Drag-to-select: global mouseup listener
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const handleMouseUp = () => { dragRef.current.active = false; };
    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, []);

  const handleDragStart = (uid) => {
    dragRef.current.active = true;
    if (!selectedUids?.has(uid)) onToggleSelect(uid);
  };

  const handleDragEnter = (uid) => {
    if (dragRef.current.active && !selectedUids?.has(uid)) {
      onToggleSelect(uid);
    }
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

  const selectedCount = selectedUids?.size || 0;
  const allSelected = selectedCount > 0 && selectedCount === emails.length;

  const sectionedData = useMemo(() => {
    if (inboxType === 'important_first' && currentFolder === 'INBOX' && emails?.length) {
      const { important, rest } = splitImportant(emails);
      const result = [];
      if (important.length) {
        result.push({ _sectionHeader: true, _sectionKey: 'priority.important', _key: 'section_important' });
        result.push(...important);
      }
      if (rest.length) {
        result.push({ _sectionHeader: true, _sectionKey: 'priority.everythingElse', _key: 'section_rest' });
        result.push(...rest);
      }
      return result;
    }
    return addSectionHeaders(emails);
  }, [emails, inboxType, currentFolder]);

  const renderItem = useCallback(({ item }) => {
    if (item._sectionHeader) {
      return (
        <View style={[s.sectionHeader, { backgroundColor: colors.background, borderBottomColor: colors.borderLight }]}>
          <Text style={[s.sectionText, { color: colors.textSecondary }]}>{t(item._sectionKey)}</Text>
        </View>
      );
    }
    return (
      <EmailRow
        email={item}
        isSelected={selectedUid === item.uid}
        isChecked={selectedUids?.has(item.uid)}
        selectMode={selectMode}
        currentFolder={currentFolder}
        onPress={onEmailPress}
        onStar={onStar}
        onToggleSelect={onToggleSelect}
        onArchive={onArchiveEmail}
        onDelete={onDeleteEmail}
        onSnooze={onSnoozeEmail}
        onDragStart={handleDragStart}
        onDragEnter={handleDragEnter}
        onContextMenu={onContextMenu}
        searchQuery={searchQuery}
        isMuted={mutedUids?.has?.(String(item.uid))}
      />
    );
  }, [colors, t, selectedUid, selectedUids, selectMode, currentFolder, onEmailPress, onStar, onToggleSelect, onArchiveEmail, onDeleteEmail, onSnoozeEmail, searchQuery, mutedUids]);

  return (
    <View style={[s.container, { backgroundColor: colors.surface }]}>
      {/* Bulk action toolbar */}
      {selectMode && selectedCount > 0 ? (
        <View style={[s.bulkBar, { backgroundColor: colors.bulkToolbarBg, borderBottomColor: colors.borderLight }]}>
          <TouchableOpacity onPress={allSelected ? onClearSelection : onSelectAll} style={s.bulkCheckWrap}>
            {allSelected ? (
              <IconCheckboxChecked size={20} color={colors.primary} />
            ) : (
              <IconCheckbox size={20} color={colors.textSecondary} />
            )}
          </TouchableOpacity>
          <Text style={[s.bulkCount, { color: colors.text }]}>
            {selectedCount > 1 ? t('bulk.selectedPlural', { count: selectedCount }) : t('bulk.selected', { count: selectedCount })}
          </Text>
          <View style={s.bulkActions}>
            <TouchableOpacity onPress={onBulkArchive} style={s.bulkBtn} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}>
              <IconArchive size={18} color={colors.textSecondary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={onBulkDelete} style={s.bulkBtn} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}>
              <IconTrash size={18} color={colors.textSecondary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={onBulkMarkRead} style={s.bulkBtn} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}>
              <IconMarkRead size={18} color={colors.textSecondary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={onBulkMarkUnread} style={s.bulkBtn} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}>
              <IconMarkUnread size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={onClearSelection} style={s.bulkClose}>
            <IconX size={16} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      ) : (
        /* Normal folder header */
        <View style={[s.header, { borderBottomColor: colors.borderLight }]}>
          <TouchableOpacity
            onPress={onSelectAll}
            style={s.headerCheckWrap}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <IconCheckbox size={18} color={colors.textTertiary} />
          </TouchableOpacity>
          <Text style={[s.title, { color: colors.textSecondary }]}>
            {FOLDER_KEYS[currentFolder] ? t(FOLDER_KEYS[currentFolder]) : currentFolder}
          </Text>
          {/* Empty Trash button */}
          {currentFolder === 'Trash' && emails.length > 0 && onEmptyTrash && (
            <TouchableOpacity
              onPress={onEmptyTrash}
              style={[s.folderActionBtn, { borderColor: '#dc2626' }]}
              activeOpacity={0.7}
            >
              <IconTrash size={13} color="#dc2626" />
              <Text style={{ color: '#dc2626', fontSize: 12, fontWeight: '600' }}>{t('sidebar.emptyTrash')}</Text>
            </TouchableOpacity>
          )}
          {/* Clear Spam button */}
          {(currentFolder === 'Junk' || currentFolder === 'Spam') && emails.length > 0 && onClearSpam && (
            <TouchableOpacity
              onPress={onClearSpam}
              style={[s.folderActionBtn, { borderColor: '#f59e0b' }]}
              activeOpacity={0.7}
            >
              <IconTrash size={13} color="#f59e0b" />
              <Text style={{ color: '#f59e0b', fontSize: 12, fontWeight: '600' }}>{t('inbox.clearSpam')}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={onRefresh} style={s.refreshBtn}>
            <IconRefresh size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      )}

      {/* List */}
      {loading && emails.length === 0 ? (
        <EmailSkeleton count={8} />
      ) : emails.length === 0 ? (
        <EmptyState search={search} folder={currentFolder} onRefresh={onRefresh} />
      ) : (
        <ListComponent
          data={sectionedData}
          keyExtractor={i => i._sectionHeader ? i._key : String(i.uid)}
          estimatedItemSize={72}
          renderItem={renderItem}
          contentContainerStyle={Platform.OS !== 'web' ? { paddingBottom: insets.bottom + 80 } : undefined}
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={onRefresh} colors={[colors.primary]} />
          }
          removeClippedSubviews={Platform.OS !== 'web'}
        />
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <View style={[s.pagination, { borderTopColor: colors.borderLight, backgroundColor: colors.surface }]}>
          <TouchableOpacity
            style={[s.pageBtn, page <= 1 && s.pageBtnDisabled]}
            disabled={page <= 1}
            onPress={() => onPageChange(page - 1)}
          >
            <IconChevronLeft size={18} color={colors.primary} />
          </TouchableOpacity>
          <Text style={[s.pageInfo, { color: colors.textSecondary }]}>{page} / {totalPages}</Text>
          <TouchableOpacity
            style={[s.pageBtn, page >= totalPages && s.pageBtnDisabled]}
            disabled={page >= totalPages}
            onPress={() => onPageChange(page + 1)}
          >
            <IconChevronRight size={18} color={colors.primary} />
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, minWidth: 320 },
  // Normal header
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerCheckWrap: { marginRight: Spacing.sm },
  title: { flex: 1, fontSize: 14, fontWeight: '600', letterSpacing: 0.2 },
  refreshBtn: { padding: 6 },
  folderActionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderWidth: 1, borderRadius: BorderRadius.md,
    paddingHorizontal: 10, paddingVertical: 4, marginRight: 6,
  },
  // Bulk toolbar - frosted glass floating bar
  bulkBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: 10,
    borderBottomWidth: 1,
    ...Platform.select({
      web: {
        animation: 'slideUp 0.2s ease-out',
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
      },
      default: {},
    }),
  },
  bulkCheckWrap: { marginRight: Spacing.sm },
  bulkCount: { fontSize: FontSize.base, fontWeight: '700', marginRight: Spacing.md },
  bulkActions: { flexDirection: 'row', gap: 6, flex: 1 },
  bulkBtn: {
    padding: 9, borderRadius: 12,
    ...Platform.select({
      web: { transition: 'all 0.15s ease', cursor: 'pointer' },
      default: {},
    }),
  },
  bulkClose: {
    padding: 9, borderRadius: 12,
    ...Platform.select({
      web: { transition: 'all 0.15s ease', cursor: 'pointer' },
      default: {},
    }),
  },
  // Section headers
  sectionHeader: {
    paddingHorizontal: Spacing.lg, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sectionText: {
    fontSize: 10, fontWeight: '800',
    textTransform: 'uppercase', letterSpacing: 1.5,
  },
  // List
  loader: { marginTop: 60 },
  // Pagination
  pagination: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: Spacing.md, borderTopWidth: 1,
  },
  pageBtn: {
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm, borderRadius: 20,
    ...Platform.select({
      web: { transition: 'all 0.15s ease', cursor: 'pointer' },
      default: {},
    }),
  },
  pageBtnDisabled: {
    opacity: 0.4,
    ...Platform.select({ web: { cursor: 'default' }, default: {} }),
  },
  pageInfo: { fontSize: FontSize.base, marginHorizontal: Spacing.lg },
});
