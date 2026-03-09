import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, TextInput,
  ActivityIndicator, RefreshControl, Alert, Platform, Modal, Linking,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { BorderRadius, FontSize, Spacing, Shadow } from '../constants/theme';
import * as api from '../services/api';
import {
  IconFolder, IconFolderPlus, IconFileText, IconImage, IconMusic, IconFilm,
  IconUpload, IconDownload, IconTrash, IconStar, IconStarFilled, IconSearch,
  IconEdit, IconMoreVert, IconArrowLeft, IconPlus, IconClock, IconChevronRight,
  IconPaperclip, IconCheck, IconX, IconArchive,
} from '../components/Icons';
import FileViewer from '../components/FileViewer';

const TABS = ['all', 'recent', 'starred', 'trash'];

function formatDate(dateStr, t) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return t ? t('files.timeNow') : 'Now';
  if (diffMin < 60) return t ? t('files.timeMinAgo', { n: diffMin }) : `${diffMin}m`;
  if (diffHr < 24) return t ? t('files.timeHrAgo', { n: diffHr }) : `${diffHr}h`;
  if (diffDays < 7) return t ? t('files.timeDaysAgo', { n: diffDays }) : `${diffDays}d`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

function getFileIcon(iconType, size, color) {
  switch (iconType) {
    case 'image': return <IconImage size={size} color={color} />;
    case 'video': return <IconFilm size={size} color={color} />;
    case 'audio': return <IconMusic size={size} color={color} />;
    case 'pdf': return <IconFileText size={size} color="#dc2626" />;
    case 'document': return <IconFileText size={size} color="#2563eb" />;
    case 'spreadsheet': return <IconFileText size={size} color="#16a34a" />;
    case 'presentation': return <IconFileText size={size} color="#d97706" />;
    case 'archive': return <IconArchive size={size} color={color} />;
    default: return <IconFileText size={size} color={color} />;
  }
}

function getIconBgColor(iconType, colors) {
  switch (iconType) {
    case 'image': return '#dbeafe';
    case 'video': return '#fce7f3';
    case 'audio': return '#e0e7ff';
    case 'pdf': return '#fef2f2';
    case 'document': return '#dbeafe';
    case 'spreadsheet': return '#f0fdf4';
    case 'presentation': return '#fffbeb';
    case 'archive': return '#f1f5f9';
    default: return colors.surfaceVariant || '#f1f5f9';
  }
}

// ============================================================
// COMPONENTS
// ============================================================

function FolderCard({ folder, colors, onPress, onLongPress, t }) {
  return (
    <TouchableOpacity
      style={[styles.itemCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.7}
    >
      <View style={[styles.itemIconWrap, { backgroundColor: '#eff6ff' }]}>
        <IconFolder size={22} color="#2563eb" />
      </View>
      <View style={styles.itemInfo}>
        <Text style={[styles.itemName, { color: colors.text }]} numberOfLines={1}>
          {folder.name}
        </Text>
        <Text style={[styles.itemMeta, { color: colors.textTertiary }]}>
          {t('files.folder')} {folder.updated_at ? ' \u00b7 ' + formatDate(folder.updated_at, t) : ''}
        </Text>
      </View>
      <IconChevronRight size={18} color={colors.textTertiary} />
    </TouchableOpacity>
  );
}

function FileCard({ file, colors, onPress, onLongPress, onStar, t }) {
  return (
    <TouchableOpacity
      style={[styles.itemCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.7}
    >
      <View style={[styles.itemIconWrap, { backgroundColor: getIconBgColor(file.icon_type, colors) }]}>
        {getFileIcon(file.icon_type, 22, colors.textSecondary)}
      </View>
      <View style={styles.itemInfo}>
        <Text style={[styles.itemName, { color: colors.text }]} numberOfLines={1}>
          {file.original_name}
        </Text>
        <Text style={[styles.itemMeta, { color: colors.textTertiary }]}>
          {file.size_formatted} {file.updated_at ? ' \u00b7 ' + formatDate(file.updated_at, t) : ''}
        </Text>
      </View>
      <TouchableOpacity onPress={onStar} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={styles.starBtn}>
        {file.is_starred == 1 ? (
          <IconStarFilled size={18} color={colors.starColor || '#f59e0b'} />
        ) : (
          <IconStar size={18} color={colors.textTertiary} />
        )}
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

function BreadcrumbBar({ breadcrumb, colors, onNavigate, t }) {
  return (
    <View style={[styles.breadcrumb, { borderBottomColor: colors.border }]}>
      <TouchableOpacity onPress={() => onNavigate(null)} style={styles.breadcrumbItem}>
        <IconFolder size={14} color={colors.primary} />
        <Text style={[styles.breadcrumbText, { color: colors.primary }]}>{t('files.home')}</Text>
      </TouchableOpacity>
      {breadcrumb.map((crumb, idx) => (
        <React.Fragment key={crumb.id}>
          <IconChevronRight size={14} color={colors.textTertiary} />
          <TouchableOpacity
            onPress={() => onNavigate(crumb.id)}
            style={styles.breadcrumbItem}
          >
            <Text
              style={[
                styles.breadcrumbText,
                { color: idx === breadcrumb.length - 1 ? colors.text : colors.primary },
                idx === breadcrumb.length - 1 && { fontWeight: '600' },
              ]}
              numberOfLines={1}
            >
              {crumb.name}
            </Text>
          </TouchableOpacity>
        </React.Fragment>
      ))}
    </View>
  );
}

function StorageBar({ storageInfo, colors, t }) {
  if (!storageInfo) return null;
  const percent = Math.min(storageInfo.usage_percent || 0, 100);

  return (
    <View style={[styles.storageBar, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
      <View style={styles.storageRow}>
        <Text style={[styles.storageText, { color: colors.textSecondary }]}>
          {t('files.storageUsed', { used: storageInfo.total_formatted || '0 B', quota: storageInfo.quota_formatted || '1 GB' })}
        </Text>
        <Text style={[styles.storageText, { color: colors.textTertiary }]}>
          {t('files.fileCount', { count: storageInfo.file_count || 0 })}
        </Text>
      </View>
      <View style={[styles.storageTrack, { backgroundColor: colors.border }]}>
        <View
          style={[
            styles.storageFill,
            {
              backgroundColor: percent > 90 ? colors.error : percent > 70 ? colors.warning : colors.primary,
              width: `${percent}%`,
            },
          ]}
        />
      </View>
    </View>
  );
}

// ============================================================
// ERROR BOUNDARY
// ============================================================

class FilesErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: '#dc2626', marginBottom: 12 }}>Files Error</Text>
          <Text style={{ fontSize: 13, color: '#666', textAlign: 'center' }}>{String(this.state.error)}</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

export default function FilesScreenWrapper() {
  return (
    <FilesErrorBoundary>
      <FilesScreenInner />
    </FilesErrorBoundary>
  );
}

// ============================================================
// MAIN SCREEN
// ============================================================

function FilesScreenInner() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [tab, setTab] = useState('all');
  const [currentFolderId, setCurrentFolderId] = useState(null);
  const [folders, setFolders] = useState([]);
  const [files, setFiles] = useState([]);
  const [breadcrumb, setBreadcrumb] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [storageInfo, setStorageInfo] = useState(null);
  const [searchMode, setSearchMode] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [showFab, setShowFab] = useState(false);
  const [actionMenu, setActionMenu] = useState(null); // { type, item }
  const [renameModal, setRenameModal] = useState(null); // { id, type, name }
  const [newFolderModal, setNewFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [shareModal, setShareModal] = useState(null); // { file_id }
  const [shareEmail, setShareEmail] = useState('');
  const [sharePermission, setSharePermission] = useState('view');
  const [viewerFile, setViewerFile] = useState(null);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [moveModal, setMoveModal] = useState(null); // { file_id }
  const [moveFolders, setMoveFolders] = useState([]);
  const [toast, setToast] = useState(null);
  const [viewMode, setViewMode] = useState('list'); // 'list' or 'grid'

  const searchTimeout = useRef(null);

  // Show toast helper
  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  // ---- LOAD DATA ----
  const loadFiles = useCallback(async (folderId, showLoader = true) => {
    if (showLoader) setLoading(true);
    try {
      const r = await api.fileList(folderId);
      if (r.success) {
        setFolders(r.data?.folders || []);
        setFiles(r.data?.files || []);
        setBreadcrumb(r.data?.breadcrumb || []);
      }
    } catch {} finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadStorageInfo = useCallback(async () => {
    try {
      const r = await api.fileStorageInfo();
      if (r.success) setStorageInfo(r.data);
    } catch {}
  }, []);

  const loadTrash = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true);
    try {
      const r = await api.fileTrash();
      if (r.success) {
        setFiles(r.data?.files || []);
        setFolders([]);
        setBreadcrumb([]);
      }
    } catch {} finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadRecent = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true);
    try {
      const r = await api.fileRecent();
      if (r.success) {
        setFiles(r.data?.files || []);
        setFolders([]);
        setBreadcrumb([]);
      }
    } catch {} finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadStarred = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true);
    try {
      const r = await api.fileSearch('*'); // Fetch all, filter starred
      // Better: load all files and filter. Since we don't have a dedicated endpoint, we use file_list
      const r2 = await api.fileList(null);
      if (r2.success) {
        const allFiles = (r2.data?.files || []).filter(f => f.is_starred == 1);
        setFiles(allFiles);
        setFolders([]);
        setBreadcrumb([]);
      }
    } catch {} finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Load based on tab
  useEffect(() => {
    setSearchMode(false);
    setSearchText('');
    setSearchResults(null);
    if (tab === 'all') {
      loadFiles(currentFolderId, true);
    } else if (tab === 'recent') {
      loadRecent(true);
    } else if (tab === 'starred') {
      loadStarred(true);
    } else if (tab === 'trash') {
      loadTrash(true);
    }
  }, [tab, currentFolderId]);

  useEffect(() => { loadStorageInfo(); }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    if (tab === 'all') loadFiles(currentFolderId, false);
    else if (tab === 'recent') loadRecent(false);
    else if (tab === 'starred') loadStarred(false);
    else if (tab === 'trash') loadTrash(false);
    loadStorageInfo();
  }, [tab, currentFolderId]);

  // ---- NAVIGATION ----
  const navigateToFolder = useCallback((folderId) => {
    setTab('all');
    setCurrentFolderId(folderId);
  }, []);

  // ---- SEARCH ----
  const handleSearch = useCallback(async (query) => {
    if (!query.trim()) {
      setSearchResults(null);
      return;
    }
    try {
      const r = await api.fileSearch(query.trim());
      if (r.success) {
        setSearchResults({ files: r.data?.files || [], folders: r.data?.folders || [] });
      }
    } catch {}
  }, []);

  const onSearchChange = useCallback((text) => {
    setSearchText(text);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => handleSearch(text), 400);
  }, [handleSearch]);

  // ---- UPLOAD ----
  const handleUpload = useCallback(async () => {
    setShowFab(false);
    try {
      let DocumentPicker;
      try { DocumentPicker = require('expo-document-picker'); } catch {
        Alert.alert(t('common.error'), t('files.documentPickerUnavailable'));
        return;
      }

      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        multiple: false,
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) return;

      const asset = result.assets[0];
      setUploading(true);

      const fileData = Platform.OS === 'web' && asset.file
        ? { _raw: asset.file, name: asset.name, type: asset.mimeType }
        : { uri: asset.uri, name: asset.name, mimeType: asset.mimeType };

      const r = await api.fileUpload(fileData, tab === 'all' ? currentFolderId : null);
      if (r.success) {
        showToast(t('files.fileUploaded'));
        if (tab === 'all') loadFiles(currentFolderId, false);
        else if (tab === 'recent') loadRecent(false);
        loadStorageInfo();
      } else {
        Alert.alert(t('files.uploadFailed'), r.message || t('files.uploadFailedDesc'));
      }
    } catch (err) {
      Alert.alert(t('common.error'), t('files.uploadError') + ': ' + (err.message || t('files.unknownError')));
    } finally {
      setUploading(false);
    }
  }, [currentFolderId, tab, showToast, loadFiles, loadRecent, loadStorageInfo]);

  // ---- CREATE FOLDER ----
  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim()) return;
    try {
      const r = await api.fileCreateFolder(newFolderName.trim(), tab === 'all' ? currentFolderId : null);
      if (r.success) {
        showToast(t('files.folderCreated'));
        setNewFolderModal(false);
        setNewFolderName('');
        loadFiles(currentFolderId, false);
      } else {
        Alert.alert(t('common.error'), r.message || t('files.folderCreateFailed'));
      }
    } catch {
      Alert.alert(t('common.error'), t('files.folderCreateError'));
    }
  }, [newFolderName, currentFolderId, tab, showToast, loadFiles]);

  // ---- FILE ACTIONS ----
  const handleStar = useCallback(async (fileId) => {
    try {
      const r = await api.fileStar(fileId);
      if (r.success) {
        setFiles(prev => prev.map(f =>
          f.id == fileId ? { ...f, is_starred: r.data?.is_starred ? 1 : 0 } : f
        ));
      }
    } catch {}
  }, []);

  const handleDelete = useCallback(async (fileId) => {
    try {
      const r = await api.fileDelete(fileId);
      if (r.success) {
        showToast(t('files.movedToTrash'));
        setFiles(prev => prev.filter(f => f.id != fileId));
        setActionMenu(null);
        loadStorageInfo();
      }
    } catch {}
  }, [showToast, loadStorageInfo]);

  const handleRestore = useCallback(async (fileId) => {
    try {
      const r = await api.fileRestore(fileId);
      if (r.success) {
        showToast(t('files.fileRestored'));
        setFiles(prev => prev.filter(f => f.id != fileId));
        setActionMenu(null);
        loadStorageInfo();
      }
    } catch {}
  }, [showToast, loadStorageInfo]);

  const handlePermanentDelete = useCallback(async (fileId) => {
    Alert.alert(t('files.permanentDeleteTitle'), t('files.permanentDeleteDesc'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('files.delete'), style: 'destructive', onPress: async () => {
          try {
            const r = await api.filePermanentDelete(fileId);
            if (r.success) {
              showToast(t('files.permanentlyDeleted'));
              setFiles(prev => prev.filter(f => f.id != fileId));
              setActionMenu(null);
              loadStorageInfo();
            }
          } catch {}
        }
      },
    ]);
  }, [showToast, loadStorageInfo]);

  const handleRename = useCallback(async () => {
    if (!renameModal || !renameModal.name.trim()) return;
    try {
      const r = await api.fileRename(renameModal.id, renameModal.type, renameModal.name.trim());
      if (r.success) {
        showToast(t('files.renamed'));
        setRenameModal(null);
        if (tab === 'all') loadFiles(currentFolderId, false);
        else if (tab === 'recent') loadRecent(false);
      } else {
        Alert.alert(t('common.error'), r.message || t('files.renameFailed'));
      }
    } catch {}
  }, [renameModal, tab, currentFolderId, showToast, loadFiles, loadRecent]);

  const handleDownload = useCallback((fileId) => {
    const url = api.fileDownloadUrl(fileId);
    if (Platform.OS === 'web') {
      window.open(url, '_blank');
    } else {
      Linking.openURL(url).catch(() => {});
    }
    setActionMenu(null);
  }, []);

  const handleFileOpen = useCallback((file, index) => {
    setViewerFile(file);
    setViewerIndex(index);
  }, []);

  const handleShare = useCallback(async () => {
    if (!shareModal || !shareEmail.trim()) return;
    try {
      const r = await api.fileShare(shareModal.file_id, shareEmail.trim(), sharePermission);
      if (r.success) {
        showToast(t('files.fileShared'));
        setShareModal(null);
        setShareEmail('');
        setSharePermission('view');
      } else {
        Alert.alert(t('common.error'), r.message || t('files.shareFailed'));
      }
    } catch {}
  }, [shareModal, shareEmail, sharePermission, showToast]);

  const handleMove = useCallback(async (targetFolderId) => {
    if (!moveModal) return;
    try {
      const r = await api.fileMove(moveModal.file_id, targetFolderId);
      if (r.success) {
        showToast(t('files.fileMoved'));
        setMoveModal(null);
        if (tab === 'all') loadFiles(currentFolderId, false);
      } else {
        Alert.alert(t('common.error'), r.message || t('files.moveFailed'));
      }
    } catch {}
  }, [moveModal, tab, currentFolderId, showToast, loadFiles]);

  const openMoveModal = useCallback(async (fileId) => {
    setActionMenu(null);
    // Load root folders for move destination
    try {
      const r = await api.fileList(null);
      if (r.success) {
        setMoveFolders(r.data?.folders || []);
        setMoveModal({ file_id: fileId });
      }
    } catch {}
  }, []);

  // ---- LONG PRESS / ACTION MENU ----
  const showActionMenu = useCallback((type, item) => {
    setActionMenu({ type, item });
  }, []);

  // ---- RENDER LIST DATA ----
  const displayFolders = searchResults ? searchResults.folders : (tab === 'all' ? folders : []);
  const displayFiles = searchResults ? searchResults.files : files;

  const listData = [
    ...displayFolders.map(f => ({ ...f, _type: 'folder' })),
    ...displayFiles.map(f => ({ ...f, _type: 'file' })),
  ];

  const renderItem = ({ item }) => {
    if (item._type === 'folder') {
      return (
        <FolderCard
          folder={item}
          colors={colors}
          onPress={() => navigateToFolder(item.id)}
          onLongPress={() => showActionMenu('folder', item)}
          t={t}
        />
      );
    }
    const fileIndex = displayFiles.indexOf(item);
    return (
      <FileCard
        file={item}
        colors={colors}
        t={t}
        onPress={() => {
          if (tab === 'trash') {
            showActionMenu('trash_file', item);
          } else {
            handleFileOpen(item, fileIndex >= 0 ? fileIndex : 0);
          }
        }}
        onLongPress={() => showActionMenu(tab === 'trash' ? 'trash_file' : 'file', item)}
        onStar={() => tab !== 'trash' && handleStar(item.id)}
      />
    );
  };

  const renderEmpty = () => {
    if (loading) return null;
    const emptyMap = {
      all: { title: t('files.emptyAll'), sub: t('files.emptyAllDesc') },
      recent: { title: t('files.emptyRecent'), sub: t('files.emptyRecentDesc') },
      starred: { title: t('files.emptyStarred'), sub: t('files.emptyStarredDesc') },
      trash: { title: t('files.emptyTrash'), sub: t('files.emptyTrashDesc') },
    };
    const empty = emptyMap[tab] || emptyMap.all;
    return (
      <View style={styles.emptyContainer}>
        {tab === 'trash' ? (
          <IconTrash size={64} color={colors.textTertiary} />
        ) : (
          <IconFolder size={64} color={colors.textTertiary} />
        )}
        <Text style={[styles.emptyTitle, { color: colors.text }]}>{empty.title}</Text>
        <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>{empty.sub}</Text>
      </View>
    );
  };

  // ---- HEADER TITLE ----
  const TAB_LABELS = { all: t('files.tabAll'), recent: t('files.tabRecent'), starred: t('files.tabStarred'), trash: t('files.tabTrash') };

  const headerTitle = searchMode
    ? t('files.searchFiles')
    : breadcrumb.length > 0
      ? breadcrumb[breadcrumb.length - 1].name
      : t('files.title');

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity
          onPress={() => {
            if (searchMode) {
              setSearchMode(false);
              setSearchText('');
              setSearchResults(null);
            } else if (breadcrumb.length > 0 && tab === 'all') {
              const parent = breadcrumb.length > 1 ? breadcrumb[breadcrumb.length - 2].id : null;
              setCurrentFolderId(parent);
            } else {
              router.back();
            }
          }}
          style={styles.headerBtn}
        >
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        {searchMode ? (
          <TextInput
            style={[styles.searchInput, { color: colors.text, backgroundColor: colors.surfaceVariant || colors.background }]}
            placeholder={t('files.searchPlaceholder')}
            placeholderTextColor={colors.textTertiary}
            value={searchText}
            onChangeText={onSearchChange}
            autoFocus
          />
        ) : (
          <Text style={[styles.headerTitle, { color: colors.text }]}>{headerTitle}</Text>
        )}
        {searchMode ? (
          <TouchableOpacity onPress={() => { setSearchMode(false); setSearchText(''); setSearchResults(null); }} style={styles.headerBtn}>
            <IconX size={20} color={colors.text} />
          </TouchableOpacity>
        ) : (
          <>
            <TouchableOpacity
              onPress={() => setViewMode(v => v === 'list' ? 'grid' : 'list')}
              style={styles.headerBtn}
            >
              {viewMode === 'list' ? (
                <View style={styles.gridIcon}>
                  <View style={styles.gridIconRow}><View style={[styles.gridIconDot, { backgroundColor: colors.text }]} /><View style={[styles.gridIconDot, { backgroundColor: colors.text }]} /></View>
                  <View style={styles.gridIconRow}><View style={[styles.gridIconDot, { backgroundColor: colors.text }]} /><View style={[styles.gridIconDot, { backgroundColor: colors.text }]} /></View>
                </View>
              ) : (
                <View style={styles.listIcon}>
                  <View style={[styles.listIconLine, { backgroundColor: colors.text }]} />
                  <View style={[styles.listIconLine, { backgroundColor: colors.text }]} />
                  <View style={[styles.listIconLine, { backgroundColor: colors.text }]} />
                </View>
              )}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setSearchMode(true)} style={styles.headerBtn}>
              <IconSearch size={20} color={colors.text} />
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* Tab Bar */}
      {!searchMode && (
        <View style={[styles.tabBar, { backgroundColor: colors.surfaceVariant || colors.background }]}>
          {TABS.map((key) => (
            <TouchableOpacity
              key={key}
              style={[styles.tab, tab === key && { backgroundColor: colors.primary }]}
              onPress={() => { setTab(key); setCurrentFolderId(null); }}
            >
              <Text style={[styles.tabText, { color: tab === key ? '#fff' : colors.textSecondary }]}>
                {TAB_LABELS[key]}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Breadcrumb */}
      {tab === 'all' && breadcrumb.length > 0 && !searchMode && (
        <BreadcrumbBar
          breadcrumb={breadcrumb}
          colors={colors}
          onNavigate={navigateToFolder}
          t={t}
        />
      )}

      {/* Toast */}
      {toast && (
        <View style={[styles.toast, { backgroundColor: colors.text }]}>
          <IconCheck size={14} color={colors.background} />
          <Text style={[styles.toastText, { color: colors.background }]}>{toast}</Text>
        </View>
      )}

      {/* Upload progress */}
      {uploading && (
        <View style={[styles.uploadBar, { backgroundColor: colors.primaryLight || colors.primary + '15' }]}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={[styles.uploadText, { color: colors.primary }]}>{t('files.uploading')}</Text>
        </View>
      )}

      {/* File List */}
      {loading && !refreshing ? (
        <View style={styles.loaderWrap}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          key={viewMode}
          data={listData}
          keyExtractor={(item) => `${item._type}-${item.id}`}
          renderItem={viewMode === 'grid' ? ({ item }) => {
            if (item._type === 'folder') {
              return (
                <TouchableOpacity
                  style={[styles.gridItem, { backgroundColor: colors.surface, borderColor: colors.border }]}
                  onPress={() => navigateToFolder(item.id)}
                  onLongPress={() => showActionMenu('folder', item)}
                  activeOpacity={0.7}
                >
                  <View style={[styles.gridItemIcon, { backgroundColor: '#eff6ff' }]}>
                    <IconFolder size={32} color="#2563eb" />
                  </View>
                  <Text style={[styles.gridItemName, { color: colors.text }]} numberOfLines={2}>{item.name}</Text>
                  <Text style={[styles.gridItemMeta, { color: colors.textTertiary }]}>{t('files.folder')}</Text>
                </TouchableOpacity>
              );
            }
            const fileIndex = displayFiles.indexOf(item);
            return (
              <TouchableOpacity
                style={[styles.gridItem, { backgroundColor: colors.surface, borderColor: colors.border }]}
                onPress={() => {
                  if (tab === 'trash') showActionMenu('trash_file', item);
                  else handleFileOpen(item, fileIndex >= 0 ? fileIndex : 0);
                }}
                onLongPress={() => showActionMenu(tab === 'trash' ? 'trash_file' : 'file', item)}
                activeOpacity={0.7}
              >
                <View style={[styles.gridItemIcon, { backgroundColor: getIconBgColor(item.icon_type, colors) }]}>
                  {getFileIcon(item.icon_type, 32, colors.textSecondary)}
                </View>
                <Text style={[styles.gridItemName, { color: colors.text }]} numberOfLines={2}>{item.original_name}</Text>
                <Text style={[styles.gridItemMeta, { color: colors.textTertiary }]}>{item.size_formatted}</Text>
                {item.is_starred == 1 && (
                  <View style={styles.gridStarBadge}>
                    <IconStarFilled size={12} color="#f59e0b" />
                  </View>
                )}
              </TouchableOpacity>
            );
          } : renderItem}
          numColumns={viewMode === 'grid' ? 3 : 1}
          ListEmptyComponent={renderEmpty}
          contentContainerStyle={[styles.list, listData.length === 0 && styles.listEmpty]}
          columnWrapperStyle={viewMode === 'grid' ? styles.gridRow : undefined}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
        />
      )}

      {/* Storage Bar */}
      <StorageBar storageInfo={storageInfo} colors={colors} t={t} />

      {/* FAB Row */}
      <View style={[styles.fabRow, { paddingBottom: insets.bottom + Spacing.md }]}>
        <TouchableOpacity
          style={[styles.fab, styles.fabSecondary, { backgroundColor: colors.surface, borderColor: colors.border }]}
          onPress={() => setNewFolderModal(true)}
        >
          <IconFolderPlus size={20} color={colors.primary} />
          <Text style={[styles.fabText, { color: colors.primary }]}>{t('files.newFolder')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.fab, styles.fabPrimary, { backgroundColor: colors.primary }]}
          onPress={handleUpload}
          disabled={uploading}
        >
          {uploading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <IconUpload size={20} color="#fff" />
              <Text style={[styles.fabText, { color: '#fff' }]}>{t('files.upload')}</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {/* ============ ACTION MENU MODAL ============ */}
      <Modal visible={!!actionMenu} transparent animationType="fade" onRequestClose={() => setActionMenu(null)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setActionMenu(null)}>
          <View style={[styles.actionSheet, { backgroundColor: colors.surface }]}>
            <View style={[styles.actionSheetHeader, { borderBottomColor: colors.border }]}>
              <Text style={[styles.actionSheetTitle, { color: colors.text }]} numberOfLines={1}>
                {actionMenu?.item?.name || actionMenu?.item?.original_name || t('files.item')}
              </Text>
            </View>

            {actionMenu?.type === 'folder' && (
              <>
                <TouchableOpacity style={styles.actionItem} onPress={() => { setActionMenu(null); setRenameModal({ id: actionMenu.item.id, type: 'folder', name: actionMenu.item.name }); }}>
                  <IconEdit size={20} color={colors.textSecondary} />
                  <Text style={[styles.actionItemText, { color: colors.text }]}>{t('files.rename')}</Text>
                </TouchableOpacity>
              </>
            )}

            {actionMenu?.type === 'file' && (
              <>
                <TouchableOpacity style={styles.actionItem} onPress={() => handleDownload(actionMenu.item.id)}>
                  <IconDownload size={20} color={colors.textSecondary} />
                  <Text style={[styles.actionItemText, { color: colors.text }]}>{t('files.download')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionItem} onPress={() => { setActionMenu(null); setRenameModal({ id: actionMenu.item.id, type: 'file', name: actionMenu.item.original_name }); }}>
                  <IconEdit size={20} color={colors.textSecondary} />
                  <Text style={[styles.actionItemText, { color: colors.text }]}>{t('files.rename')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionItem} onPress={() => openMoveModal(actionMenu.item.id)}>
                  <IconFolder size={20} color={colors.textSecondary} />
                  <Text style={[styles.actionItemText, { color: colors.text }]}>{t('files.moveTo')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionItem} onPress={() => { handleStar(actionMenu.item.id); setActionMenu(null); }}>
                  {actionMenu.item.is_starred == 1 ? (
                    <IconStarFilled size={20} color="#f59e0b" />
                  ) : (
                    <IconStar size={20} color={colors.textSecondary} />
                  )}
                  <Text style={[styles.actionItemText, { color: colors.text }]}>
                    {actionMenu.item.is_starred == 1 ? t('files.unstar') : t('files.star')}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionItem} onPress={() => { setActionMenu(null); setShareModal({ file_id: actionMenu.item.id }); }}>
                  <IconPaperclip size={20} color={colors.textSecondary} />
                  <Text style={[styles.actionItemText, { color: colors.text }]}>{t('files.share')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionItem} onPress={() => handleDelete(actionMenu.item.id)}>
                  <IconTrash size={20} color={colors.error} />
                  <Text style={[styles.actionItemText, { color: colors.error }]}>{t('files.delete')}</Text>
                </TouchableOpacity>
              </>
            )}

            {actionMenu?.type === 'trash_file' && (
              <>
                <TouchableOpacity style={styles.actionItem} onPress={() => handleRestore(actionMenu.item.id)}>
                  <IconArchive size={20} color={colors.success || '#16a34a'} />
                  <Text style={[styles.actionItemText, { color: colors.success || '#16a34a' }]}>{t('files.restore')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionItem} onPress={() => handlePermanentDelete(actionMenu.item.id)}>
                  <IconTrash size={20} color={colors.error} />
                  <Text style={[styles.actionItemText, { color: colors.error }]}>{t('files.deletePermanently')}</Text>
                </TouchableOpacity>
              </>
            )}

            <TouchableOpacity style={[styles.actionItem, { marginTop: 4 }]} onPress={() => setActionMenu(null)}>
              <IconX size={20} color={colors.textTertiary} />
              <Text style={[styles.actionItemText, { color: colors.textTertiary }]}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ============ RENAME MODAL ============ */}
      <Modal visible={!!renameModal} transparent animationType="fade" onRequestClose={() => setRenameModal(null)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setRenameModal(null)}>
          <View style={[styles.dialogBox, { backgroundColor: colors.surface }]} onStartShouldSetResponder={() => true}>
            <Text style={[styles.dialogTitle, { color: colors.text }]}>{t('files.rename')}</Text>
            <TextInput
              style={[styles.dialogInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
              value={renameModal?.name || ''}
              onChangeText={(text) => setRenameModal(prev => prev ? { ...prev, name: text } : null)}
              autoFocus
              selectTextOnFocus
              onSubmitEditing={handleRename}
            />
            <View style={styles.dialogBtns}>
              <TouchableOpacity style={styles.dialogBtn} onPress={() => setRenameModal(null)}>
                <Text style={[styles.dialogBtnText, { color: colors.textSecondary }]}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.dialogBtn, styles.dialogBtnPrimary, { backgroundColor: colors.primary }]} onPress={handleRename}>
                <Text style={[styles.dialogBtnText, { color: '#fff' }]}>{t('files.rename')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ============ NEW FOLDER MODAL ============ */}
      <Modal visible={newFolderModal} transparent animationType="fade" onRequestClose={() => setNewFolderModal(false)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setNewFolderModal(false)}>
          <View style={[styles.dialogBox, { backgroundColor: colors.surface }]} onStartShouldSetResponder={() => true}>
            <Text style={[styles.dialogTitle, { color: colors.text }]}>{t('files.newFolder')}</Text>
            <TextInput
              style={[styles.dialogInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
              placeholder={t('files.folderNamePlaceholder')}
              placeholderTextColor={colors.textTertiary}
              value={newFolderName}
              onChangeText={setNewFolderName}
              autoFocus
              onSubmitEditing={handleCreateFolder}
            />
            <View style={styles.dialogBtns}>
              <TouchableOpacity style={styles.dialogBtn} onPress={() => { setNewFolderModal(false); setNewFolderName(''); }}>
                <Text style={[styles.dialogBtnText, { color: colors.textSecondary }]}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.dialogBtn, styles.dialogBtnPrimary, { backgroundColor: colors.primary }]} onPress={handleCreateFolder}>
                <Text style={[styles.dialogBtnText, { color: '#fff' }]}>{t('files.create')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ============ SHARE MODAL ============ */}
      <Modal visible={!!shareModal} transparent animationType="fade" onRequestClose={() => setShareModal(null)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setShareModal(null)}>
          <View style={[styles.dialogBox, { backgroundColor: colors.surface }]} onStartShouldSetResponder={() => true}>
            <Text style={[styles.dialogTitle, { color: colors.text }]}>{t('files.shareFile')}</Text>
            <TextInput
              style={[styles.dialogInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
              placeholder={t('files.emailPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              value={shareEmail}
              onChangeText={setShareEmail}
              autoFocus
              keyboardType="email-address"
              autoCapitalize="none"
            />
            <View style={styles.permissionRow}>
              <TouchableOpacity
                style={[styles.permissionBtn, sharePermission === 'view' && { backgroundColor: colors.primary }]}
                onPress={() => setSharePermission('view')}
              >
                <Text style={[styles.permissionText, { color: sharePermission === 'view' ? '#fff' : colors.textSecondary }]}>
                  {t('files.viewOnly')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.permissionBtn, sharePermission === 'edit' && { backgroundColor: colors.primary }]}
                onPress={() => setSharePermission('edit')}
              >
                <Text style={[styles.permissionText, { color: sharePermission === 'edit' ? '#fff' : colors.textSecondary }]}>
                  {t('files.canEdit')}
                </Text>
              </TouchableOpacity>
            </View>
            <View style={styles.dialogBtns}>
              <TouchableOpacity style={styles.dialogBtn} onPress={() => { setShareModal(null); setShareEmail(''); }}>
                <Text style={[styles.dialogBtnText, { color: colors.textSecondary }]}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.dialogBtn, styles.dialogBtnPrimary, { backgroundColor: colors.primary }]} onPress={handleShare}>
                <Text style={[styles.dialogBtnText, { color: '#fff' }]}>{t('files.share')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ============ MOVE MODAL ============ */}
      <Modal visible={!!moveModal} transparent animationType="fade" onRequestClose={() => setMoveModal(null)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setMoveModal(null)}>
          <View style={[styles.dialogBox, { backgroundColor: colors.surface, maxHeight: 400 }]} onStartShouldSetResponder={() => true}>
            <Text style={[styles.dialogTitle, { color: colors.text }]}>{t('files.moveToFolder')}</Text>
            <TouchableOpacity
              style={[styles.moveItem, { borderBottomColor: colors.border }]}
              onPress={() => handleMove(null)}
            >
              <IconFolder size={20} color={colors.primary} />
              <Text style={[styles.moveItemText, { color: colors.primary }]}>{t('files.rootHome')}</Text>
            </TouchableOpacity>
            <FlatList
              data={moveFolders}
              keyExtractor={(item) => String(item.id)}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[styles.moveItem, { borderBottomColor: colors.border }]}
                  onPress={() => handleMove(item.id)}
                >
                  <IconFolder size={20} color={colors.textSecondary} />
                  <Text style={[styles.moveItemText, { color: colors.text }]}>{item.name}</Text>
                </TouchableOpacity>
              )}
              style={{ maxHeight: 250 }}
            />
            <TouchableOpacity style={[styles.dialogBtn, { alignSelf: 'flex-end', marginTop: Spacing.sm }]} onPress={() => setMoveModal(null)}>
              <Text style={[styles.dialogBtnText, { color: colors.textSecondary }]}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ============ FILE VIEWER ============ */}
      <FileViewer
        visible={!!viewerFile}
        file={viewerFile}
        files={displayFiles}
        initialIndex={viewerIndex}
        onClose={() => setViewerFile(null)}
        getUrl={(f) => api.fileDownloadUrl(f.id)}
      />
    </View>
  );
}

// ============================================================
// STYLES
// ============================================================

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: FontSize.xl, fontWeight: '700', flex: 1, textAlign: 'center' },
  searchInput: {
    flex: 1, height: 38, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, fontSize: FontSize.md, marginHorizontal: Spacing.xs,
  },
  tabBar: {
    flexDirection: 'row', marginHorizontal: Spacing.md, marginTop: Spacing.sm,
    borderRadius: BorderRadius.lg, padding: 3, gap: 4,
  },
  tab: {
    flex: 1, paddingVertical: Spacing.xs + 2, borderRadius: BorderRadius.md,
    alignItems: 'center',
  },
  tabText: { fontSize: FontSize.sm, fontWeight: '600' },
  breadcrumb: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs + 2, borderBottomWidth: StyleSheet.hairlineWidth,
    flexWrap: 'wrap', gap: 2,
  },
  breadcrumbItem: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 2, paddingHorizontal: 4 },
  breadcrumbText: { fontSize: FontSize.sm },
  list: { padding: Spacing.md, gap: Spacing.xs },
  listEmpty: { flexGrow: 1 },
  loaderWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  itemCard: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: BorderRadius.lg, padding: Spacing.md,
    borderWidth: StyleSheet.hairlineWidth, marginBottom: Spacing.xs,
    ...Shadow.sm,
  },
  itemIconWrap: {
    width: 44, height: 44, borderRadius: BorderRadius.md,
    alignItems: 'center', justifyContent: 'center', marginRight: Spacing.md,
  },
  itemInfo: { flex: 1 },
  itemName: { fontSize: FontSize.md, fontWeight: '500' },
  itemMeta: { fontSize: FontSize.sm, marginTop: 2 },
  starBtn: { padding: 8 },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: Spacing.xl },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '600', marginTop: Spacing.md },
  emptySubtitle: { fontSize: FontSize.sm, textAlign: 'center', marginTop: Spacing.xs },
  fabRow: {
    flexDirection: 'row', gap: Spacing.sm, paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
  },
  fab: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: Spacing.sm + 2, borderRadius: BorderRadius.lg,
    ...Shadow.md,
  },
  fabPrimary: {},
  fabSecondary: { borderWidth: 1 },
  fabText: { fontSize: FontSize.md, fontWeight: '600' },
  toast: {
    position: 'absolute', top: 120, alignSelf: 'center', zIndex: 100,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.full || 99,
  },
  toastText: { fontSize: FontSize.sm, fontWeight: '500' },
  uploadBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2,
  },
  uploadText: { fontSize: FontSize.sm, fontWeight: '500' },
  storageBar: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  storageRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  storageText: { fontSize: FontSize.xs },
  storageTrack: { height: 4, borderRadius: 2, overflow: 'hidden' },
  storageFill: { height: '100%', borderRadius: 2 },
  // Modals
  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end', alignItems: 'center',
  },
  actionSheet: {
    width: '100%', maxWidth: 500, borderTopLeftRadius: BorderRadius.xl, borderTopRightRadius: BorderRadius.xl,
    paddingBottom: 34, paddingTop: Spacing.sm,
  },
  actionSheetHeader: {
    paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, marginBottom: 4,
  },
  actionSheetTitle: { fontSize: FontSize.md, fontWeight: '600' },
  actionItem: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
  },
  actionItemText: { fontSize: FontSize.md },
  dialogBox: {
    width: '90%', maxWidth: 400, borderRadius: BorderRadius.xl,
    padding: Spacing.lg,
    position: 'absolute', top: '30%',
    alignSelf: 'center',
    ...Shadow.lg,
  },
  dialogTitle: { fontSize: FontSize.lg, fontWeight: '700', marginBottom: Spacing.md },
  dialogInput: {
    height: 44, borderRadius: BorderRadius.md, borderWidth: 1,
    paddingHorizontal: Spacing.md, fontSize: FontSize.md, marginBottom: Spacing.md,
  },
  dialogBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.sm },
  dialogBtn: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, borderRadius: BorderRadius.md },
  dialogBtnPrimary: {},
  dialogBtnText: { fontSize: FontSize.md, fontWeight: '600' },
  permissionRow: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.md },
  permissionBtn: {
    flex: 1, paddingVertical: Spacing.xs + 2, borderRadius: BorderRadius.md,
    alignItems: 'center', borderWidth: 1, borderColor: '#e2e8f0',
  },
  permissionText: { fontSize: FontSize.sm, fontWeight: '500' },
  moveItem: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    paddingVertical: Spacing.sm + 2, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  moveItemText: { fontSize: FontSize.md },
  gridRow: { gap: 8, paddingHorizontal: 12 },
  gridItem: {
    flex: 1, margin: 4, borderRadius: 12, borderWidth: 1,
    padding: 12, alignItems: 'center', minHeight: 120,
  },
  gridItemIcon: {
    width: 48, height: 48, borderRadius: 12,
    justifyContent: 'center', alignItems: 'center', marginBottom: 8,
  },
  gridItemName: { fontSize: 12, fontWeight: '500', textAlign: 'center' },
  gridItemMeta: { fontSize: 10, marginTop: 2 },
  gridStarBadge: {
    position: 'absolute', top: 6, right: 6,
  },
  gridIcon: { width: 20, height: 20, justifyContent: 'center', gap: 3 },
  gridIconRow: { flexDirection: 'row', gap: 3, justifyContent: 'center' },
  gridIconDot: { width: 7, height: 7, borderRadius: 2 },
  listIcon: { width: 20, height: 20, justifyContent: 'center', gap: 3 },
  listIconLine: { height: 2, borderRadius: 1, width: '100%' },
});
