import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, TextInput,
  ActivityIndicator, RefreshControl, Alert, Platform, Modal, Linking,
  ScrollView, useWindowDimensions, Image, Pressable, Animated,
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
  IconPaperclip, IconCheck, IconX, IconArchive, IconGrid, IconShare, IconLink,
  IconCopy, IconMenu, IconUsers, IconPlay, IconHome, IconRefresh, IconCamera,
} from '../components/Icons';
import FileViewer from '../components/FileViewer';

// ============================================================
// CONSTANTS
// ============================================================
const TABS = ['files', 'photos', 'shared', 'trash'];
const STORAGE_LIMIT_GB = 20;
const PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff', 'svg'];
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'm4v', '3gp'];

// ============================================================
// HELPERS
// ============================================================
const safeAlert = (title, message, buttons) => {
  if (Platform.OS === 'web') {
    if (buttons?.length) {
      const ok = buttons.find(b => b.style !== 'cancel');
      if (ok?.onPress && window.confirm(`${title}\n${message || ''}`)) ok.onPress();
      else { const cancel = buttons.find(b => b.style === 'cancel'); cancel?.onPress?.(); }
    } else { window.alert(message || title); }
  } else { Alert.alert(title, message, buttons); }
};

function formatDate(dateStr, t) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMin < 1) return t('drive.timeNow');
  if (diffMin < 60) return t('drive.timeMinAgo', { n: diffMin });
  if (diffHr < 24) return t('drive.timeHrAgo', { n: diffHr });
  if (diffDays < 7) return t('drive.timeDaysAgo', { n: diffDays });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatGB(bytes) {
  if (!bytes) return '0';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}

function getFileExt(name) {
  if (!name) return '';
  const parts = name.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

function isPhoto(item) {
  const ext = getFileExt(item.name);
  return item.icon_type === 'image' || PHOTO_EXTENSIONS.includes(ext);
}

function isVideo(item) {
  const ext = getFileExt(item.name);
  return item.icon_type === 'video' || VIDEO_EXTENSIONS.includes(ext);
}

function isMedia(item) {
  return isPhoto(item) || isVideo(item);
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

function getIconBgColor(iconType, isDark) {
  if (isDark) {
    switch (iconType) {
      case 'image': return '#1e3a5f'; case 'video': return '#4a1942';
      case 'audio': return '#312e81'; case 'pdf': return '#450a0a';
      case 'document': return '#1e3a5f'; case 'spreadsheet': return '#052e16';
      case 'presentation': return '#451a03'; case 'archive': return '#1e293b';
      default: return '#1e293b';
    }
  }
  switch (iconType) {
    case 'image': return '#dbeafe'; case 'video': return '#fce7f3';
    case 'audio': return '#e0e7ff'; case 'pdf': return '#fef2f2';
    case 'document': return '#dbeafe'; case 'spreadsheet': return '#f0fdf4';
    case 'presentation': return '#fffbeb'; case 'archive': return '#f1f5f9';
    default: return '#f1f5f9';
  }
}

function getFileTypeBadge(item) {
  const ext = getFileExt(item.name);
  if (!ext || item.is_folder) return null;
  const badges = {
    pdf: { label: 'PDF', bg: '#dc2626' },
    doc: { label: 'DOC', bg: '#2563eb' }, docx: { label: 'DOC', bg: '#2563eb' },
    xls: { label: 'XLS', bg: '#16a34a' }, xlsx: { label: 'XLS', bg: '#16a34a' }, csv: { label: 'CSV', bg: '#16a34a' },
    ppt: { label: 'PPT', bg: '#d97706' }, pptx: { label: 'PPT', bg: '#d97706' },
    zip: { label: 'ZIP', bg: '#6b7280' }, rar: { label: 'RAR', bg: '#6b7280' }, '7z': { label: '7Z', bg: '#6b7280' },
    mp3: { label: 'MP3', bg: '#7c3aed' }, wav: { label: 'WAV', bg: '#7c3aed' }, ogg: { label: 'OGG', bg: '#7c3aed' },
    mp4: { label: 'MP4', bg: '#db2777' }, mov: { label: 'MOV', bg: '#db2777' }, avi: { label: 'AVI', bg: '#db2777' },
    png: { label: 'PNG', bg: '#0891b2' }, jpg: { label: 'JPG', bg: '#0891b2' }, jpeg: { label: 'JPG', bg: '#0891b2' },
    gif: { label: 'GIF', bg: '#0891b2' }, webp: { label: 'WEBP', bg: '#0891b2' }, svg: { label: 'SVG', bg: '#0891b2' },
    txt: { label: 'TXT', bg: '#6b7280' }, json: { label: 'JSON', bg: '#6b7280' }, xml: { label: 'XML', bg: '#6b7280' },
  };
  return badges[ext] || null;
}

function groupByDate(items, t) {
  const groups = [];
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
  const monthAgo = new Date(today); monthAgo.setMonth(monthAgo.getMonth() - 1);

  const buckets = { today: [], yesterday: [], week: [], month: [], older: [] };
  items.forEach(item => {
    const d = new Date(item.created_at || item.uploaded_at);
    if (d >= today) buckets.today.push(item);
    else if (d >= yesterday) buckets.yesterday.push(item);
    else if (d >= weekAgo) buckets.week.push(item);
    else if (d >= monthAgo) buckets.month.push(item);
    else buckets.older.push(item);
  });

  if (buckets.today.length) groups.push({ title: t('drive.today'), data: buckets.today });
  if (buckets.yesterday.length) groups.push({ title: t('drive.yesterday'), data: buckets.yesterday });
  if (buckets.week.length) groups.push({ title: t('drive.thisWeek'), data: buckets.week });
  if (buckets.month.length) groups.push({ title: t('drive.thisMonth'), data: buckets.month });
  if (buckets.older.length) groups.push({ title: t('drive.older'), data: buckets.older });
  return groups;
}

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function DriveScreen() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const isDesktop = width >= 768;

  // State
  const [activeTab, setActiveTab] = useState('files');
  const [viewMode, setViewMode] = useState('grid'); // grid | list
  const [sortBy, setSortBy] = useState('name'); // name | date | size
  const [sortDir, setSortDir] = useState('asc');
  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [isSearching, setIsSearching] = useState(false);

  // Data
  const [files, setFiles] = useState([]);
  const [folders, setFolders] = useState([]);
  const [sharedFiles, setSharedFiles] = useState([]);
  const [trashFiles, setTrashFiles] = useState([]);
  const [storageInfo, setStorageInfo] = useState(null);
  const [breadcrumbs, setBreadcrumbs] = useState([{ id: null, name: t('drive.home') }]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState([]);

  // Selection
  const [selectedItems, setSelectedItems] = useState(new Set());
  const [selectMode, setSelectMode] = useState(false);

  // Modals
  const [contextMenu, setContextMenu] = useState(null);
  const [newFolderModal, setNewFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renameModal, setRenameModal] = useState(null);
  const [renameText, setRenameText] = useState('');
  const [shareModal, setShareModal] = useState(null);
  const [shareEmail, setShareEmail] = useState('');
  const [sharePermission, setSharePermission] = useState('view');
  const [moveModal, setMoveModal] = useState(null);
  const [moveFolders, setMoveFolders] = useState([]);
  const [storageModal, setStorageModal] = useState(false);
  const [previewFile, setPreviewFile] = useState(null);
  const [previewPanelFile, setPreviewPanelFile] = useState(null); // desktop side panel
  const [detailsFile, setDetailsFile] = useState(null); // file details bottom sheet
  const [dragOver, setDragOver] = useState(false);
  const [dragHasFolders, setDragHasFolders] = useState(false);
  const [dragOverFolder, setDragOverFolder] = useState(null); // folder id being dragged over
  const [focusedIndex, setFocusedIndex] = useState(-1); // keyboard navigation index
  const containerRef = useRef(null);

  // Native DOM drag/drop — must use document-level listeners because
  // React Native Web doesn't properly handle preventDefault on drag events
  const handleDropUploadRef = useRef(null);

  useEffect(() => {
    if (Platform.OS !== 'web') return;

    const onDragOver = (e) => {
      e.preventDefault();
      // Don't show upload overlay for internal file-to-folder drags
      if (e.dataTransfer?.types?.includes('text/x-drive-file-id')) return;
      if (!dragOver) setDragOver(true);
    };

    const onDragLeave = (e) => {
      e.preventDefault();
      // Only trigger when actually leaving the window
      if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
        setDragOver(false);
        setDragHasFolders(false);
      }
    };

    const onDrop = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      setDragHasFolders(false);

      // Skip internal file-to-folder drags (handled by folder onDrop)
      const dt = e.dataTransfer;
      if (!dt) return;
      if (dt.types?.includes('text/x-drive-file-id')) return;

      // Try webkitGetAsEntry for folder support
      const items = dt.items;
      let allFiles = [];
      let hasEntryApi = false;

      if (items && items.length > 0 && items[0].webkitGetAsEntry) {
        hasEntryApi = true;
        const traverseEntry = (entry, path) => {
          return new Promise((resolve) => {
            if (entry.isFile) {
              entry.file((file) => {
                file._relativePath = path + file.name;
                allFiles.push(file);
                resolve();
              }, () => resolve());
            } else if (entry.isDirectory) {
              const reader = entry.createReader();
              const readAll = (entries) => {
                reader.readEntries(async (batch) => {
                  if (batch.length === 0) {
                    await Promise.all(entries.map(e => traverseEntry(e, path + entry.name + '/')));
                    resolve();
                  } else {
                    readAll([...entries, ...batch]);
                  }
                }, () => resolve());
              };
              readAll([]);
            } else {
              resolve();
            }
          });
        };

        const promises = [];
        for (let i = 0; i < items.length; i++) {
          const entry = items[i].webkitGetAsEntry();
          if (entry) promises.push(traverseEntry(entry, ''));
        }
        await Promise.all(promises);
      }

      if (!hasEntryApi || allFiles.length === 0) {
        allFiles = Array.from(dt.files || []);
      }

      if (allFiles.length > 0 && handleDropUploadRef.current) {
        handleDropUploadRef.current(allFiles);
      }
    };

    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);

    return () => {
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
    };
  }, [dragOver]);
  const [sortMenuVisible, setSortMenuVisible] = useState(false);
  const [fabOpen, setFabOpen] = useState(false);
  const [photoColumns, setPhotoColumns] = useState(isDesktop ? 5 : 3);

  const searchTimerRef = useRef(null);
  const dropPulseAnim = useRef(new Animated.Value(1)).current;
  const currentFolderId = breadcrumbs[breadcrumbs.length - 1]?.id || null;

  // ============================================================
  // DATA LOADING
  // ============================================================
  const loadFiles = useCallback(async (folderId = currentFolderId) => {
    try {
      const res = await api.fileList(folderId);
      if (res.success) {
        const d = res.data || res;
        const allItems = d.files || [];
        setFolders(allItems.filter(f => f.is_folder));
        setFiles(allItems.filter(f => !f.is_folder));
        if (d.breadcrumbs) setBreadcrumbs(d.breadcrumbs);
        if (d.storage) setStorageInfo(d.storage);
      }
    } catch {}
  }, [currentFolderId]);

  const loadTrash = useCallback(async () => {
    try {
      const res = await api.fileTrash();
      if (res.success) setTrashFiles((res.data || res).files || []);
    } catch {}
  }, []);

  const loadShared = useCallback(async () => {
    try {
      const res = await api.fileSharedWithMe();
      if (res.success) {
        const d = res.data || res;
        setSharedFiles(d.files || []);
      }
    } catch {}
  }, []);

  const loadStorage = useCallback(async () => {
    try {
      const res = await api.fileStorageInfo();
      if (res.success) setStorageInfo(res.data || res);
    } catch {}
  }, []);

  const loadAll = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    await Promise.all([loadFiles(), loadStorage()]);
    setLoading(false);
  }, [loadFiles, loadStorage]);

  useEffect(() => {
    loadAll();
  }, []);

  useEffect(() => {
    if (activeTab === 'trash') loadTrash();
    if (activeTab === 'shared') loadShared();
  }, [activeTab]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadAll(false);
    if (activeTab === 'trash') await loadTrash();
    if (activeTab === 'shared') await loadShared();
    setRefreshing(false);
  }, [loadAll, activeTab, loadTrash, loadShared]);

  // ============================================================
  // SEARCH
  // ============================================================
  const handleSearch = useCallback((text) => {
    setSearchText(text);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!text.trim()) { setSearchResults(null); return; }
    searchTimerRef.current = setTimeout(async () => {
      setIsSearching(true);
      try {
        const res = await api.fileSearch(text.trim());
        if (res.success) setSearchResults((res.data || res).files || []);
      } catch {} finally { setIsSearching(false); }
    }, 400);
  }, []);

  // ============================================================
  // NAVIGATION
  // ============================================================
  const navigateToFolder = useCallback((folder) => {
    setBreadcrumbs(prev => [...prev, { id: folder.id, name: folder.name }]);
    loadFiles(folder.id);
  }, [loadFiles]);

  const navigateToBreadcrumb = useCallback((index) => {
    const newCrumbs = breadcrumbs.slice(0, index + 1);
    setBreadcrumbs(newCrumbs);
    const folderId = newCrumbs[newCrumbs.length - 1]?.id || null;
    loadFiles(folderId);
  }, [breadcrumbs, loadFiles]);

  // ============================================================
  // FILE ACTIONS
  // ============================================================
  const handleUploadFile = useCallback(async () => {
    setFabOpen(false);
    try {
      let result;
      if (Platform.OS === 'web') {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.onchange = async (e) => {
          const filesList = Array.from(e.target.files);
          if (!filesList.length) return;
          setUploading(true);
          setUploadProgress(filesList.map(f => ({ name: f.name, progress: 0, done: false, error: false })));
          for (let i = 0; i < filesList.length; i++) {
            const f = filesList[i];
            setUploadProgress(prev => prev.map((p, j) => j === i ? { ...p, progress: 50 } : p));
            const res = await api.fileUpload({ _raw: f, name: f.name }, currentFolderId);
            setUploadProgress(prev => prev.map((p, j) => j === i ? { ...p, progress: 100, done: true, error: !res.success } : p));
          }
          await loadFiles(currentFolderId);
          setTimeout(() => { setUploading(false); setUploadProgress([]); }, 1500);
        };
        input.click();
      } else {
        const DocumentPicker = require('expo-document-picker');
        result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
        if (result.canceled || !result.assets?.length) return;
        setUploading(true);
        const assets = result.assets;
        setUploadProgress(assets.map(f => ({ name: f.name, progress: 0, done: false, error: false })));
        for (let i = 0; i < assets.length; i++) {
          const f = assets[i];
          setUploadProgress(prev => prev.map((p, j) => j === i ? { ...p, progress: 50 } : p));
          const res = await api.fileUpload({ uri: f.uri, name: f.name, mimeType: f.mimeType }, currentFolderId);
          setUploadProgress(prev => prev.map((p, j) => j === i ? { ...p, progress: 100, done: true, error: !res.success } : p));
        }
        await loadFiles(currentFolderId);
        setTimeout(() => { setUploading(false); setUploadProgress([]); }, 1500);
      }
    } catch { setUploading(false); setUploadProgress([]); }
  }, [currentFolderId, loadFiles]);

  const handleUploadPhotos = useCallback(async () => {
    setFabOpen(false);
    try {
      if (Platform.OS === 'web') {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = 'image/*,video/*';
        input.onchange = async (e) => {
          const filesList = Array.from(e.target.files);
          if (!filesList.length) return;
          setUploading(true);
          setUploadProgress(filesList.map(f => ({ name: f.name, progress: 0, done: false, error: false })));
          for (let i = 0; i < filesList.length; i++) {
            const f = filesList[i];
            setUploadProgress(prev => prev.map((p, j) => j === i ? { ...p, progress: 50 } : p));
            const res = await api.fileUpload({ _raw: f, name: f.name }, currentFolderId);
            setUploadProgress(prev => prev.map((p, j) => j === i ? { ...p, progress: 100, done: true, error: !res.success } : p));
          }
          await loadFiles(currentFolderId);
          setTimeout(() => { setUploading(false); setUploadProgress([]); }, 1500);
        };
        input.click();
      } else {
        const ImagePicker = require('expo-image-picker');
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) { safeAlert(t('drive.permissionNeeded'), t('drive.photoPermissionMsg')); return; }
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.All,
          allowsMultipleSelection: true,
          quality: 0.9,
        });
        if (result.canceled || !result.assets?.length) return;
        setUploading(true);
        const assets = result.assets;
        setUploadProgress(assets.map(f => ({ name: f.fileName || 'photo', progress: 0, done: false, error: false })));
        for (let i = 0; i < assets.length; i++) {
          const f = assets[i];
          setUploadProgress(prev => prev.map((p, j) => j === i ? { ...p, progress: 50 } : p));
          const res = await api.fileUpload({
            uri: f.uri,
            name: f.fileName || `photo_${Date.now()}.jpg`,
            mimeType: f.type === 'video' ? 'video/mp4' : 'image/jpeg',
          }, currentFolderId);
          setUploadProgress(prev => prev.map((p, j) => j === i ? { ...p, progress: 100, done: true, error: !res.success } : p));
        }
        await loadFiles(currentFolderId);
        setTimeout(() => { setUploading(false); setUploadProgress([]); }, 1500);
      }
    } catch { setUploading(false); setUploadProgress([]); }
  }, [currentFolderId, loadFiles, t]);

  const handleDelete = useCallback(async (item) => {
    setContextMenu(null);
    const res = await api.fileDelete(item.id);
    if (res.success) { safeAlert(t('drive.movedToTrash')); loadFiles(currentFolderId); }
  }, [currentFolderId, loadFiles, t]);

  const handleRestore = useCallback(async (item) => {
    setContextMenu(null);
    const res = await api.fileRestore(item.id);
    if (res.success) { safeAlert(t('drive.fileRestored')); loadTrash(); }
  }, [loadTrash, t]);

  const handlePermanentDelete = useCallback(async (item) => {
    setContextMenu(null);
    safeAlert(t('drive.permanentDeleteTitle'), t('drive.permanentDeleteDesc'), [
      { text: t('drive.cancel'), style: 'cancel' },
      { text: t('drive.delete'), style: 'destructive', onPress: async () => {
        const res = await api.filePermanentDelete(item.id);
        if (res.success) { safeAlert(t('drive.permanentlyDeleted')); loadTrash(); }
      }},
    ]);
  }, [loadTrash, t]);

  const handleEmptyTrash = useCallback(async () => {
    safeAlert(t('drive.emptyTrashConfirm'), t('drive.emptyTrashConfirmDesc'), [
      { text: t('drive.cancel'), style: 'cancel' },
      { text: t('drive.delete'), style: 'destructive', onPress: async () => {
        for (const item of trashFiles) {
          await api.filePermanentDelete(item.id);
        }
        loadTrash();
      }},
    ]);
  }, [trashFiles, loadTrash, t]);

  const handleRename = useCallback(async () => {
    if (!renameModal || !renameText.trim()) return;
    const res = await api.fileRename(renameModal.id, renameModal.is_folder ? 'folder' : 'file', renameText.trim());
    if (res.success) { loadFiles(currentFolderId); }
    else { safeAlert(t('drive.renameFailed')); }
    setRenameModal(null);
    setRenameText('');
  }, [renameModal, renameText, currentFolderId, loadFiles, t]);

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim()) return;
    const res = await api.fileCreateFolder(newFolderName.trim(), currentFolderId);
    if (res.success) { loadFiles(currentFolderId); }
    else { safeAlert(t('drive.folderCreateFailed')); }
    setNewFolderModal(false);
    setNewFolderName('');
  }, [newFolderName, currentFolderId, loadFiles, t]);

  const handleShare = useCallback(async () => {
    if (!shareModal || !shareEmail.trim()) return;
    const res = await api.fileShare(shareModal.id, shareEmail.trim(), sharePermission);
    if (res.success) { safeAlert(t('drive.fileShared')); }
    else { safeAlert(t('drive.shareFailed')); }
    setShareModal(null);
    setShareEmail('');
    setSharePermission('view');
  }, [shareModal, shareEmail, sharePermission, t]);

  const handleMove = useCallback(async (targetFolderId) => {
    if (!moveModal) return;
    const res = await api.fileMove(moveModal.id, targetFolderId);
    if (res.success) { loadFiles(currentFolderId); }
    else { safeAlert(t('drive.moveFailed')); }
    setMoveModal(null);
  }, [moveModal, currentFolderId, loadFiles, t]);

  const handleStar = useCallback(async (item) => {
    setContextMenu(null);
    await api.fileStar(item.id);
    loadFiles(currentFolderId);
  }, [currentFolderId, loadFiles]);

  const handleDownload = useCallback((item) => {
    setContextMenu(null);
    const url = api.fileDownloadUrl(item.id);
    if (Platform.OS === 'web') { window.open(url, '_blank'); }
    else { Linking.openURL(url); }
  }, []);

  // Drag & drop upload (web) — supports folders via webkitGetAsEntry
  const handleDropUpload = useCallback(async (droppedFiles, targetFolderId) => {
    if (!droppedFiles || droppedFiles.length === 0) return;
    const destFolder = targetFolderId !== undefined ? targetFolderId : currentFolderId;

    // Group files by folder path
    const folderMap = {}; // path -> [files]
    const rootFiles = [];

    droppedFiles.forEach(f => {
      const relPath = f._relativePath || f.webkitRelativePath || '';
      const parts = relPath.split('/').filter(Boolean);
      if (parts.length > 1) {
        // File is inside subfolder(s) — use all but last segment as folder path
        const folderPath = parts.slice(0, -1).join('/');
        if (!folderMap[folderPath]) folderMap[folderPath] = [];
        folderMap[folderPath].push(f);
      } else {
        rootFiles.push(f);
      }
    });

    const allEntries = [];
    rootFiles.forEach(f => allEntries.push({ file: f, label: f.name, folderPath: null }));
    Object.keys(folderMap).sort().forEach(path => {
      folderMap[path].forEach(f => allEntries.push({ file: f, label: path + '/' + f.name, folderPath: path }));
    });

    setUploading(true);
    setUploadProgress(allEntries.map(e => ({ name: e.label, progress: 0, done: false, error: false })));

    // Upload root files first
    let idx = 0;
    for (const f of rootFiles) {
      const i = idx++;
      setUploadProgress(prev => prev.map((p, j) => j === i ? { ...p, progress: 50 } : p));
      const res = await api.fileUpload({ _raw: f.file || f, name: f.name }, destFolder);
      setUploadProgress(prev => prev.map((p, j) => j === i ? { ...p, progress: 100, done: true, error: !res.success } : p));
    }

    // Create folders and upload contents preserving hierarchy
    const createdFolders = {}; // path -> folderId
    const sortedPaths = Object.keys(folderMap).sort();

    for (const folderPath of sortedPaths) {
      // Create each level of the folder path
      const segments = folderPath.split('/');
      let parentId = destFolder;

      for (let s = 0; s < segments.length; s++) {
        const partialPath = segments.slice(0, s + 1).join('/');
        if (createdFolders[partialPath]) {
          parentId = createdFolders[partialPath];
          continue;
        }
        const folderRes = await api.fileCreateFolder(segments[s], parentId);
        if (folderRes.success && folderRes.folder) {
          createdFolders[partialPath] = folderRes.folder.id;
          parentId = folderRes.folder.id;
        } else {
          // Folder might already exist — try to use existing
          parentId = folderRes.folder?.id || parentId;
          createdFolders[partialPath] = parentId;
        }
      }

      // Upload files into this folder
      const folderFiles = folderMap[folderPath];
      for (const f of folderFiles) {
        const i = idx++;
        setUploadProgress(prev => prev.map((p, j) => j === i ? { ...p, progress: 50 } : p));
        const res = await api.fileUpload({ _raw: f, name: f.name }, parentId);
        setUploadProgress(prev => prev.map((p, j) => j === i ? { ...p, progress: 100, done: true, error: !res.success } : p));
      }
    }

    await loadFiles(destFolder);
    setTimeout(() => { setUploading(false); setUploadProgress([]); }, 1500);
  }, [currentFolderId, loadFiles]);

  // Keep drop handler ref updated for document-level listener
  useEffect(() => { handleDropUploadRef.current = handleDropUpload; }, [handleDropUpload]);

  // Keyboard shortcuts (web only)
  const kbStateRef = useRef({ selectedItems, selectMode, files, folders, activeTab, focusedIndex, previewFile, contextMenu });
  useEffect(() => {
    kbStateRef.current = { selectedItems, selectMode, files, folders, activeTab, focusedIndex, previewFile, contextMenu };
  }, [selectedItems, selectMode, files, folders, activeTab, focusedIndex, previewFile, contextMenu]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKeyDown = (e) => {
      const st = kbStateRef.current;
      // Don't handle if typing in input/textarea
      const tag = e.target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      // Don't handle if a modal is open
      if (st.previewFile || st.contextMenu) return;

      const allItems = [...st.folders, ...st.files];
      const curIdx = st.focusedIndex;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (st.selectedItems.size > 0) {
          e.preventDefault();
          handleBulkDelete();
        } else if (curIdx >= 0 && curIdx < allItems.length) {
          e.preventDefault();
          handleDelete(allItems[curIdx]);
        }
      } else if (e.key === 'Enter') {
        if (curIdx >= 0 && curIdx < allItems.length) {
          e.preventDefault();
          handleItemPress(allItems[curIdx]);
        }
      } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const next = new Set();
        allItems.forEach(it => next.add(`${it.is_folder ? 'f' : 'i'}_${it.id}`));
        setSelectedItems(next);
        setSelectMode(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setSelectedItems(new Set());
        setSelectMode(false);
        setFocusedIndex(-1);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        const next = Math.min(curIdx + 1, allItems.length - 1);
        setFocusedIndex(Math.max(next, 0));
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const next = Math.max(curIdx - 1, 0);
        setFocusedIndex(next);
      } else if (e.key === 'F2' && curIdx >= 0 && curIdx < allItems.length) {
        e.preventDefault();
        const item = allItems[curIdx];
        setRenameModal(item);
        setRenameText(item.name);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [handleBulkDelete, handleDelete, handleItemPress]);

  const toggleSelect = useCallback((item) => {
    setSelectedItems(prev => {
      const next = new Set(prev);
      const key = `${item.is_folder ? 'f' : 'i'}_${item.id}`;
      if (next.has(key)) next.delete(key); else next.add(key);
      if (next.size === 0) setSelectMode(false);
      else setSelectMode(true);
      return next;
    });
  }, []);

  const lastClickRef = useRef({ id: null, time: 0 });

  const lastSelectedIndexRef = useRef(null);

  const handleItemPress = useCallback((item, event) => {
    const allItems = [...folders, ...files];
    const itemIndex = allItems.findIndex(i => i.id === item.id && i.is_folder === item.is_folder);

    // Shift+click: select range (web/desktop)
    if (Platform.OS === 'web' && event?.shiftKey && lastSelectedIndexRef.current !== null) {
      const start = Math.min(lastSelectedIndexRef.current, itemIndex);
      const end = Math.max(lastSelectedIndexRef.current, itemIndex);
      setSelectedItems(prev => {
        const next = new Set(prev);
        for (let i = start; i <= end; i++) {
          const it = allItems[i];
          if (it) next.add(`${it.is_folder ? 'f' : 'i'}_${it.id}`);
        }
        return next;
      });
      setSelectMode(true);
      return;
    }

    // Ctrl/Cmd+click: toggle individual (web/desktop)
    if (Platform.OS === 'web' && (event?.ctrlKey || event?.metaKey)) {
      toggleSelect(item);
      lastSelectedIndexRef.current = itemIndex;
      return;
    }

    if (selectMode) {
      toggleSelect(item);
      lastSelectedIndexRef.current = itemIndex;
      return;
    }
    if (item.is_folder) {
      navigateToFolder(item);
      return;
    }
    // Desktop: single click shows preview panel, double click opens full viewer
    if (isDesktop && Platform.OS === 'web') {
      const now = Date.now();
      const last = lastClickRef.current;
      if (last.id === item.id && now - last.time < 400) {
        setPreviewFile(item);
        setPreviewPanelFile(null);
        lastClickRef.current = { id: null, time: 0 };
      } else {
        setPreviewPanelFile(item);
        lastClickRef.current = { id: item.id, time: now };
      }
    } else {
      setPreviewFile(item);
    }
  }, [selectMode, navigateToFolder, isDesktop, folders, files, toggleSelect]);

  const handleRightClick = useCallback((item, e) => {
    if (Platform.OS !== 'web') return;
    e.preventDefault();
    const position = { x: e.clientX || e.pageX || 100, y: e.clientY || e.pageY || 100 };
    setContextMenu({ item, position });
  }, []);

  const handleItemLongPress = useCallback((item, event) => {
    if (selectMode) return;
    const position = event?.nativeEvent ? { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY } : { x: 100, y: 100 };
    setContextMenu({ item, position });
  }, [selectMode]);

  const handleBulkDelete = useCallback(async () => {
    const items = [...files, ...folders];
    for (const key of selectedItems) {
      const id = parseInt(key.split('_')[1]);
      await api.fileDelete(id);
    }
    setSelectedItems(new Set());
    setSelectMode(false);
    loadFiles(currentFolderId);
  }, [selectedItems, files, folders, currentFolderId, loadFiles]);

  const clearSelection = useCallback(() => {
    setSelectedItems(new Set());
    setSelectMode(false);
  }, []);

  // ============================================================
  // SORTED & FILTERED DATA
  // ============================================================
  const displayItems = useMemo(() => {
    if (searchResults !== null) return searchResults;
    let items;
    if (activeTab === 'files') {
      items = [...folders, ...files];
    } else if (activeTab === 'photos') {
      return [...files].filter(f => isMedia(f));
    } else if (activeTab === 'shared') {
      return sharedFiles;
    } else if (activeTab === 'trash') {
      return trashFiles;
    }
    // Sort
    if (items) {
      items.sort((a, b) => {
        // Folders first
        if (a.is_folder && !b.is_folder) return -1;
        if (!a.is_folder && b.is_folder) return 1;
        let cmp = 0;
        if (sortBy === 'name') cmp = (a.name || '').localeCompare(b.name || '');
        else if (sortBy === 'date') cmp = new Date(b.created_at || 0) - new Date(a.created_at || 0);
        else if (sortBy === 'size') cmp = (b.size || 0) - (a.size || 0);
        else if (sortBy === 'type') cmp = getFileExt(a.name).localeCompare(getFileExt(b.name));
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }
    return items || [];
  }, [activeTab, files, folders, sharedFiles, trashFiles, searchResults, sortBy, sortDir]);

  // Recent files - last 10 modified, only shown at root
  const recentFiles = useMemo(() => {
    if (activeTab !== 'files' || breadcrumbs.length > 1 || searchResults !== null) return [];
    const allFiles = [...files].filter(f => !f.is_folder);
    return allFiles
      .sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0))
      .slice(0, 10);
  }, [activeTab, files, breadcrumbs, searchResults]);

  const photoGroups = useMemo(() => {
    if (activeTab !== 'photos') return [];
    const media = [...files].filter(f => isMedia(f));
    return groupByDate(media, t);
  }, [activeTab, files, t]);

  // ============================================================
  // STORAGE BAR
  // ============================================================
  const storageUsedBytes = storageInfo?.total_used || storageInfo?.used_bytes || 0;
  const storageTotalBytes = storageInfo?.quota || storageInfo?.plan_quota || (STORAGE_LIMIT_GB * 1024 * 1024 * 1024);
  const storagePercent = Math.min((storageUsedBytes / storageTotalBytes) * 100, 100);
  const storageColor = storagePercent > 90 ? '#dc2626' : storagePercent > 70 ? '#f59e0b' : '#2563eb';

  // ============================================================
  // RENDER HELPERS
  // ============================================================

  // --- Storage Bar ---
  const renderStorageBar = () => {
    const driveBytes = storageInfo?.drive_bytes || storageUsedBytes;
    const emailBytes = storageInfo?.email_bytes || 0;
    const chatBytes = storageInfo?.chat_bytes || 0;
    const feedBytes = storageInfo?.feed_bytes || 0;
    const segments = [
      { label: 'Drive', bytes: driveBytes, color: '#2563eb' },
      { label: 'Email', bytes: emailBytes, color: '#16a34a' },
      { label: 'Chat', bytes: chatBytes, color: '#f59e0b' },
      { label: 'Feed', bytes: feedBytes, color: '#8b5cf6' },
    ].filter(s => s.bytes > 0);

    return (
      <TouchableOpacity
        style={[styles.storageBar, { backgroundColor: colors.surface, borderColor: colors.border }]}
        onPress={() => setStorageModal(true)}
        activeOpacity={0.7}
      >
        <View style={styles.storageInfo}>
          <Text style={[styles.storageText, { color: colors.text }]}>
            {formatBytes(storageUsedBytes)} {t('drive.ofStorage', { total: formatBytes(storageTotalBytes) })}
          </Text>
          <Text style={[styles.storagePercent, { color: colors.textSecondary }]}>
            {storagePercent.toFixed(0)}%
          </Text>
        </View>
        <View style={[styles.storageTrack, { backgroundColor: isDark ? colors.surfaceVariant : '#e5e7eb' }]}>
          {segments.length > 0 ? (
            <View style={{ flexDirection: 'row', height: '100%' }}>
              {segments.map((seg, i) => {
                const pct = (seg.bytes / storageTotalBytes) * 100;
                return <View key={i} style={{ width: `${Math.max(pct, 0.5)}%`, height: '100%', backgroundColor: seg.color, borderTopLeftRadius: i === 0 ? 3 : 0, borderBottomLeftRadius: i === 0 ? 3 : 0 }} />;
              })}
            </View>
          ) : (
            <View style={[styles.storageFill, { width: `${Math.max(storagePercent, 1)}%`, backgroundColor: storageColor }]} />
          )}
        </View>
        {segments.length > 1 && (
          <View style={{ flexDirection: 'row', gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
            {segments.map((seg, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: seg.color }} />
                <Text style={{ fontSize: 10, color: colors.textTertiary }}>{seg.label} {formatBytes(seg.bytes)}</Text>
              </View>
            ))}
          </View>
        )}
      </TouchableOpacity>
    );
  };

  // --- Breadcrumbs ---
  const renderBreadcrumbs = () => {
    if (activeTab !== 'files' || breadcrumbs.length <= 1) return null;
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.breadcrumbContainer} contentContainerStyle={styles.breadcrumbContent}>
        {breadcrumbs.map((crumb, i) => {
          const isLast = i === breadcrumbs.length - 1;
          return (
            <View key={i} style={styles.breadcrumbItem}>
              {i > 0 && <Text style={{ color: colors.textTertiary, marginHorizontal: 4, fontSize: 14 }}>/</Text>}
              {isLast ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  {i === 0 && <IconHome size={14} color={colors.text} />}
                  <Text style={[styles.breadcrumbText, { color: colors.text, fontWeight: '700' }]}>{crumb.name}</Text>
                </View>
              ) : (
                <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }} onPress={() => navigateToBreadcrumb(i)}>
                  {i === 0 && <IconHome size={14} color={colors.primary} />}
                  <Text style={[styles.breadcrumbText, { color: colors.primary }]}>{crumb.name}</Text>
                </TouchableOpacity>
              )}
            </View>
          );
        })}
      </ScrollView>
    );
  };

  // --- Tab Bar ---
  const renderTabs = () => (
    <View style={[styles.tabBar, { borderBottomColor: colors.border }]}>
      {TABS.map(tab => (
        <TouchableOpacity
          key={tab}
          style={[styles.tab, activeTab === tab && { borderBottomColor: colors.primary, borderBottomWidth: 2 }]}
          onPress={() => { setActiveTab(tab); setSearchResults(null); setSearchText(''); clearSelection(); }}
        >
          {tab === 'files' && <IconFolder size={16} color={activeTab === tab ? colors.primary : colors.textSecondary} />}
          {tab === 'photos' && <IconImage size={16} color={activeTab === tab ? colors.primary : colors.textSecondary} />}
          {tab === 'shared' && <IconUsers size={16} color={activeTab === tab ? colors.primary : colors.textSecondary} />}
          {tab === 'trash' && <IconTrash size={16} color={activeTab === tab ? colors.primary : colors.textSecondary} />}
          <Text style={[styles.tabText, { color: activeTab === tab ? colors.primary : colors.textSecondary }]}>
            {t(`drive.tab${tab.charAt(0).toUpperCase() + tab.slice(1)}`)}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  // --- File/Folder Item (List View) ---
  const renderListItem = ({ item, index }) => {
    const isFolder = item.is_folder;
    const itemKey = `${isFolder ? 'f' : 'i'}_${item.id}`;
    const isSelected = selectedItems.has(itemKey);
    const hasShare = item.shared_with?.length > 0;
    const isDragTarget = isFolder && dragOverFolder === item.id;
    const isFocused = focusedIndex === index;

    // Web drag-to-folder props
    const webDragProps = Platform.OS === 'web' && !isFolder ? {
      draggable: true,
      onDragStart: (e) => { e.dataTransfer.setData('text/x-drive-file-id', String(item.id)); e.dataTransfer.effectAllowed = 'move'; },
    } : {};
    const webDropProps = Platform.OS === 'web' && isFolder ? {
      onDragOver: (e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; setDragOverFolder(item.id); },
      onDragEnter: (e) => { e.preventDefault(); e.stopPropagation(); setDragOverFolder(item.id); },
      onDragLeave: (e) => { e.stopPropagation(); if (!e.currentTarget.contains(e.relatedTarget)) setDragOverFolder(null); },
      onDrop: async (e) => {
        e.preventDefault(); e.stopPropagation();
        const fileId = e.dataTransfer.getData('text/x-drive-file-id');
        if (fileId) { await api.fileMove(parseInt(fileId), item.id); loadFiles(currentFolderId); }
        setDragOverFolder(null);
      },
    } : {};

    return (
      <View {...(Platform.OS === 'web' ? { onContextMenu: (e) => handleRightClick(item, e) } : {})} {...webDragProps} {...webDropProps}>
      <TouchableOpacity
        style={[
          styles.listItem,
          { backgroundColor: isSelected ? (isDark ? colors.selectedBg : '#dbeafe') : 'transparent', borderBottomColor: colors.border },
          isDragTarget && { backgroundColor: isDark ? '#1e3a5f' : '#bfdbfe', borderColor: '#2563eb', borderWidth: 2, borderRadius: 8 },
          isFocused && !isSelected && { backgroundColor: isDark ? colors.surfaceVariant : '#f1f5f9' },
          Platform.OS === 'web' && !isFolder && { cursor: 'grab' },
        ]}
        onPress={(e) => { setFocusedIndex(index); handleItemPress(item, e); }}
        onLongPress={(e) => handleItemLongPress(item, e)}
        delayLongPress={400}
        activeOpacity={0.6}
      >
        {selectMode && (
          <TouchableOpacity style={styles.checkboxArea} onPress={() => toggleSelect(item)}>
            <View style={[styles.checkbox, isSelected && { backgroundColor: colors.primary, borderColor: colors.primary }, { borderColor: colors.textTertiary }]}>
              {isSelected && <IconCheck size={14} color="#fff" />}
            </View>
          </TouchableOpacity>
        )}
        <View style={[styles.listIconContainer, { backgroundColor: isFolder ? (isDark ? '#78350f20' : '#fef3c7') : getIconBgColor(item.icon_type, isDark) }]}>
          {isFolder
            ? <IconFolder size={22} color="#f59e0b" />
            : getFileIcon(item.icon_type, 22, colors.textSecondary)
          }
        </View>
        <View style={styles.listItemInfo}>
          <Text style={[styles.listItemName, { color: colors.text }]} numberOfLines={1}>{item.name}</Text>
          <View style={styles.listItemMeta}>
            {!isFolder && <Text style={[styles.listItemSize, { color: colors.textTertiary }]}>{formatBytes(item.size)}</Text>}
            <Text style={[styles.listItemDate, { color: colors.textTertiary }]}>{formatDate(item.created_at || item.uploaded_at, t)}</Text>
            {hasShare && <IconUsers size={12} color={colors.primary} style={{ marginLeft: 6 }} />}
            {item.is_starred && <IconStarFilled size={12} color="#f59e0b" style={{ marginLeft: 4 }} />}
          </View>
        </View>
        <TouchableOpacity style={styles.moreBtn} onPress={(e) => handleItemLongPress(item, e)}>
          <IconMoreVert size={18} color={colors.textSecondary} />
        </TouchableOpacity>
      </TouchableOpacity>
      </View>
    );
  };

  // --- File/Folder Item (Grid View) ---
  const [hoveredItem, setHoveredItem] = useState(null);
  const renderGridItem = ({ item, index }) => {
    const isFolder = item.is_folder;
    const itemKey = `${isFolder ? 'f' : 'i'}_${item.id}`;
    const isSelected = selectedItems.has(itemKey);
    const hasShare = item.shared_with?.length > 0;
    const gridCols = isDesktop ? (previewPanelFile ? 4 : 5) : 2;
    const contentWidth = previewPanelFile && isDesktop ? width * 0.65 : width;
    const itemWidth = (contentWidth - (isDesktop ? 80 : 32) - (gridCols - 1) * 12) / gridCols;
    const badge = !isFolder ? getFileTypeBadge(item) : null;
    const isHovered = hoveredItem === itemKey;
    const isDragTarget = isFolder && dragOverFolder === item.id;
    const isFocused = focusedIndex === index;

    // Web drag-to-folder props
    const webDragProps = Platform.OS === 'web' && !isFolder ? {
      draggable: true,
      onDragStart: (e) => { e.dataTransfer.setData('text/x-drive-file-id', String(item.id)); e.dataTransfer.effectAllowed = 'move'; },
    } : {};
    const webDropProps = Platform.OS === 'web' && isFolder ? {
      onDragOver: (e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; setDragOverFolder(item.id); },
      onDragEnter: (e) => { e.preventDefault(); e.stopPropagation(); setDragOverFolder(item.id); },
      onDragLeave: (e) => { e.stopPropagation(); if (!e.currentTarget.contains(e.relatedTarget)) setDragOverFolder(null); },
      onDrop: async (e) => {
        e.preventDefault(); e.stopPropagation();
        const fileId = e.dataTransfer.getData('text/x-drive-file-id');
        if (fileId) { await api.fileMove(parseInt(fileId), item.id); loadFiles(currentFolderId); }
        setDragOverFolder(null);
      },
    } : {};

    return (
      <View
        {...(Platform.OS === 'web' ? {
          onMouseEnter: () => setHoveredItem(itemKey),
          onMouseLeave: () => setHoveredItem(null),
          onContextMenu: (e) => handleRightClick(item, e),
        } : {})}
        {...webDragProps}
        {...webDropProps}
      >
        <TouchableOpacity
          style={[
            styles.gridItem,
            {
              width: itemWidth,
              backgroundColor: isSelected ? (isDark ? colors.selectedBg : '#dbeafe') : colors.surface,
              borderColor: isSelected ? colors.primary : colors.border,
            },
            Platform.OS === 'web' && isHovered && !isSelected && {
              borderColor: colors.primary + '50',
              ...(isDark ? { backgroundColor: colors.surfaceVariant } : { backgroundColor: '#f8fafc' }),
              transform: [{ translateY: -1 }],
            },
            isDragTarget && { borderColor: '#2563eb', borderWidth: 2, backgroundColor: isDark ? '#1e3a5f' : '#bfdbfe' },
            isFocused && !isSelected && !isDragTarget && { borderColor: colors.primary, borderWidth: 2 },
            Platform.OS === 'web' && { cursor: isFolder ? 'pointer' : 'grab', transition: 'all 0.15s ease' },
          ]}
          onPress={(e) => { setFocusedIndex(index); handleItemPress(item, e); }}
          onLongPress={(e) => handleItemLongPress(item, e)}
          delayLongPress={400}
          activeOpacity={0.7}
        >
          {selectMode && (
            <TouchableOpacity style={styles.gridCheckbox} onPress={() => toggleSelect(item)}>
              <View style={[styles.checkbox, isSelected && { backgroundColor: colors.primary, borderColor: colors.primary }, { borderColor: colors.textTertiary }]}>
                {isSelected && <IconCheck size={12} color="#fff" />}
              </View>
            </TouchableOpacity>
          )}
          <View style={[styles.gridIconArea, { backgroundColor: isFolder ? (isDark ? '#78350f20' : '#fef3c7') : getIconBgColor(item.icon_type, isDark) }]}>
            {isFolder
              ? <View style={{ alignItems: 'center' }}>
                  <IconFolder size={40} color="#f59e0b" />
                </View>
              : (isPhoto(item) && item.thumbnail_url
                ? <Image source={{ uri: item.thumbnail_url }} style={styles.gridThumbnail} resizeMode="cover" />
                : getFileIcon(item.icon_type, 36, colors.textSecondary))
            }
            {badge && (
              <View style={[styles.fileTypeBadge, { backgroundColor: badge.bg }]}>
                <Text style={styles.fileTypeBadgeText}>{badge.label}</Text>
              </View>
            )}
          </View>
          <View style={styles.gridItemInfo}>
            <Text style={[styles.gridItemName, { color: colors.text }]} numberOfLines={2}>{item.name}</Text>
            <View style={styles.gridItemMeta}>
              {!isFolder && <Text style={[styles.gridItemSize, { color: colors.textTertiary }]}>{formatBytes(item.size)}</Text>}
              {hasShare && <IconUsers size={10} color={colors.primary} style={{ marginLeft: 4 }} />}
            </View>
          </View>
        </TouchableOpacity>
      </View>
    );
  };

  // --- Photo Gallery Item ---
  const renderPhotoItem = (item) => {
    const colWidth = (width - (isDesktop ? 80 : 24) - (photoColumns - 1) * 2) / photoColumns;
    const isVid = isVideo(item);
    const thumbUrl = item.thumbnail_url || api.fileDownloadUrl(item.id);

    return (
      <TouchableOpacity
        key={item.id}
        style={[styles.photoItem, { width: colWidth, height: colWidth }]}
        onPress={() => setPreviewFile(item)}
        onLongPress={(e) => handleItemLongPress(item, e)}
        delayLongPress={400}
        activeOpacity={0.8}
      >
        <Image source={{ uri: thumbUrl }} style={styles.photoThumb} resizeMode="cover" />
        {isVid && (
          <View style={styles.videoOverlay}>
            <View style={styles.playIconBg}>
              <IconPlay size={20} color="#fff" />
            </View>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  // --- Photos Tab Content ---
  const renderPhotosTab = () => {
    const media = [...files].filter(f => isMedia(f));
    if (media.length === 0) {
      return (
        <View style={styles.emptyState}>
          <IconImage size={56} color={colors.textTertiary} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>{t('drive.emptyPhotos')}</Text>
          <Text style={[styles.emptyDesc, { color: colors.textSecondary }]}>{t('drive.emptyPhotosDesc')}</Text>
          <TouchableOpacity style={[styles.emptyBtn, { backgroundColor: colors.primary }]} onPress={handleUploadPhotos}>
            <IconCamera size={18} color="#fff" />
            <Text style={styles.emptyBtnText}>{t('drive.backupPhotos')}</Text>
          </TouchableOpacity>
        </View>
      );
    }

    const groups = groupByDate(media, t);
    return (
      <ScrollView contentContainerStyle={styles.photosContainer}>
        {/* Backup button */}
        <TouchableOpacity style={[styles.backupBtn, { backgroundColor: isDark ? colors.surfaceVariant : '#eff6ff', borderColor: colors.primary + '30' }]} onPress={handleUploadPhotos}>
          <IconCamera size={18} color={colors.primary} />
          <Text style={[styles.backupBtnText, { color: colors.primary }]}>{t('drive.backupPhotos')}</Text>
        </TouchableOpacity>
        {groups.map((group, gi) => (
          <View key={gi}>
            <Text style={[styles.photoGroupTitle, { color: colors.text }]}>{group.title}</Text>
            <View style={styles.photoGrid}>
              {group.data.map(item => renderPhotoItem(item))}
            </View>
          </View>
        ))}
      </ScrollView>
    );
  };

  // --- Empty States ---
  const renderEmptyState = () => {
    const configs = {
      files: { icon: <IconFolder size={64} color={colors.textTertiary} />, title: t('drive.noFiles'), desc: t('drive.uploadHint') },
      photos: { icon: <IconImage size={64} color={colors.textTertiary} />, title: t('drive.emptyPhotos'), desc: t('drive.emptyPhotosDesc') },
      shared: { icon: <IconUsers size={64} color={colors.textTertiary} />, title: t('drive.emptyShared'), desc: t('drive.emptySharedDesc') },
      trash: { icon: <IconTrash size={64} color={colors.textTertiary} />, title: t('drive.emptyTrash'), desc: t('drive.emptyTrashDesc') },
    };
    const cfg = configs[activeTab];
    return (
      <View style={styles.emptyState}>
        <View style={[styles.emptyIconCircle, { backgroundColor: isDark ? colors.surfaceVariant : '#f1f5f9' }]}>
          {cfg.icon}
        </View>
        <Text style={[styles.emptyTitle, { color: colors.text }]}>{cfg.title}</Text>
        <Text style={[styles.emptyDesc, { color: colors.textSecondary }]}>{cfg.desc}</Text>
        {activeTab === 'files' && (
          <TouchableOpacity style={[styles.emptyBtn, { backgroundColor: colors.primary }]} onPress={handleUploadFile}>
            <IconUpload size={18} color="#fff" />
            <Text style={styles.emptyBtnText}>{t('drive.uploadFile')}</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  // --- Upload Progress Overlay ---
  const renderUploadProgress = () => {
    if (!uploading || uploadProgress.length === 0) return null;
    return (
      <View style={[styles.uploadOverlay, { backgroundColor: colors.surface, borderColor: colors.border, ...Shadow.lg }]}>
        <Text style={[styles.uploadTitle, { color: colors.text }]}>{t('drive.uploading')}</Text>
        {uploadProgress.map((p, i) => (
          <View key={i} style={styles.uploadItem}>
            <Text style={[styles.uploadFileName, { color: colors.textSecondary }]} numberOfLines={1}>{p.name}</Text>
            <View style={[styles.uploadTrack, { backgroundColor: isDark ? colors.surfaceVariant : '#e5e7eb' }]}>
              <View style={[styles.uploadFill, { width: `${p.progress}%`, backgroundColor: p.error ? '#dc2626' : p.done ? '#16a34a' : colors.primary }]} />
            </View>
          </View>
        ))}
      </View>
    );
  };

  // ============================================================
  // MODALS
  // ============================================================

  // Context Menu
  const renderContextMenu = () => {
    if (!contextMenu) return null;
    const { item, position } = contextMenu;
    const isTrashTab = activeTab === 'trash';
    // Check if file can be edited with Docs (Word/Excel/CSV/Text)
    const editableExts = ['docx', 'doc', 'xlsx', 'xls', 'csv', 'txt', 'html', 'htm'];
    const fileExt = getFileExt(item.name);
    const canEditWithDocs = !item.is_folder && editableExts.includes(fileExt);

    const menuItems = isTrashTab ? [
      { label: t('drive.restore'), icon: <IconRefresh size={18} color={colors.text} />, onPress: () => handleRestore(item) },
      { label: t('drive.deletePermanently'), icon: <IconTrash size={18} color="#dc2626" />, onPress: () => handlePermanentDelete(item), danger: true },
    ] : [
      canEditWithDocs && { label: t('drive.editWithDocs') || 'Editar com Documentos', icon: <IconFileText size={18} color="#4285f4" />, onPress: () => {
        setContextMenu(null);
        const docsUrl = `/docs/index.html#import-drive-${item.id}`;
        if (Platform.OS === 'web') window.open(docsUrl, '_blank');
        else router.push('/documentos');
      }},
      !item.is_folder && { label: t('drive.download'), icon: <IconDownload size={18} color={colors.text} />, onPress: () => handleDownload(item) },
      { label: t('drive.share'), icon: <IconShare size={18} color={colors.text} />, onPress: () => { setContextMenu(null); setShareModal(item); } },
      { label: t('drive.rename'), icon: <IconEdit size={18} color={colors.text} />, onPress: () => { setContextMenu(null); setRenameModal(item); setRenameText(item.name); } },
      { label: t('drive.moveTo'), icon: <IconFolder size={18} color={colors.text} />, onPress: () => { setContextMenu(null); setMoveModal(item); loadMoveFolders(); } },
      { label: item.is_starred ? t('drive.unstar') : t('drive.star'), icon: item.is_starred ? <IconStarFilled size={18} color="#f59e0b" /> : <IconStar size={18} color={colors.text} />, onPress: () => handleStar(item) },
      !item.is_folder && { label: t('drive.fileInfo'), icon: <IconFileText size={18} color={colors.text} />, onPress: () => { setContextMenu(null); setDetailsFile(item); } },
      { label: t('drive.delete'), icon: <IconTrash size={18} color="#dc2626" />, onPress: () => handleDelete(item), danger: true },
    ].filter(Boolean);

    return (
      <Modal transparent visible animationType="fade" onRequestClose={() => setContextMenu(null)}>
        <Pressable style={styles.modalOverlay} onPress={() => setContextMenu(null)}>
          <View style={[styles.contextMenuContainer, {
            backgroundColor: colors.surface,
            borderColor: colors.border,
            ...Shadow.lg,
            ...(Platform.OS === 'web' ? { position: 'absolute', left: Math.min(position.x, width - 220), top: Math.min(position.y, 500) } : { alignSelf: 'center', marginTop: 'auto', marginBottom: 40 }),
          }]}>
            <View style={[styles.contextMenuHeader, { borderBottomColor: colors.border }]}>
              <Text style={[styles.contextMenuTitle, { color: colors.text }]} numberOfLines={1}>{item.name}</Text>
            </View>
            {menuItems.map((mi, i) => (
              <TouchableOpacity key={i} style={styles.contextMenuItem} onPress={mi.onPress} activeOpacity={0.6}>
                {mi.icon}
                <Text style={[styles.contextMenuText, { color: mi.danger ? '#dc2626' : colors.text }]}>{mi.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </Pressable>
      </Modal>
    );
  };

  // Load folders for move modal
  const loadMoveFolders = async () => {
    try {
      const res = await api.fileList(null);
      if (res.success) setMoveFolders(((res.data || res).files || []).filter(f => f.is_folder));
    } catch {}
  };

  // New Folder Modal
  const renderNewFolderModal = () => (
    <Modal transparent visible={newFolderModal} animationType="fade" onRequestClose={() => setNewFolderModal(false)}>
      <Pressable style={styles.modalOverlay} onPress={() => setNewFolderModal(false)}>
        <View style={[styles.modalCard, { backgroundColor: colors.surface, ...Shadow.xl }]}>
          <Text style={[styles.modalTitle, { color: colors.text }]}>{t('drive.newFolder')}</Text>
          <TextInput
            style={[styles.modalInput, { color: colors.text, borderColor: colors.border, backgroundColor: isDark ? colors.surfaceVariant : '#f8fafc' }]}
            value={newFolderName}
            onChangeText={setNewFolderName}
            placeholder={t('drive.folderNamePlaceholder')}
            placeholderTextColor={colors.textTertiary}
            autoFocus
            onSubmitEditing={handleCreateFolder}
          />
          <View style={styles.modalBtns}>
            <TouchableOpacity style={[styles.modalBtn, { backgroundColor: isDark ? colors.surfaceVariant : '#f1f5f9' }]} onPress={() => setNewFolderModal(false)}>
              <Text style={[styles.modalBtnText, { color: colors.textSecondary }]}>{t('drive.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.modalBtn, { backgroundColor: colors.primary }]} onPress={handleCreateFolder}>
              <Text style={[styles.modalBtnText, { color: '#fff' }]}>{t('drive.create')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Pressable>
    </Modal>
  );

  // Rename Modal
  const renderRenameModal = () => (
    <Modal transparent visible={!!renameModal} animationType="fade" onRequestClose={() => setRenameModal(null)}>
      <Pressable style={styles.modalOverlay} onPress={() => setRenameModal(null)}>
        <View style={[styles.modalCard, { backgroundColor: colors.surface, ...Shadow.xl }]}>
          <Text style={[styles.modalTitle, { color: colors.text }]}>{t('drive.rename')}</Text>
          <TextInput
            style={[styles.modalInput, { color: colors.text, borderColor: colors.border, backgroundColor: isDark ? colors.surfaceVariant : '#f8fafc' }]}
            value={renameText}
            onChangeText={setRenameText}
            autoFocus
            onSubmitEditing={handleRename}
          />
          <View style={styles.modalBtns}>
            <TouchableOpacity style={[styles.modalBtn, { backgroundColor: isDark ? colors.surfaceVariant : '#f1f5f9' }]} onPress={() => setRenameModal(null)}>
              <Text style={[styles.modalBtnText, { color: colors.textSecondary }]}>{t('drive.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.modalBtn, { backgroundColor: colors.primary }]} onPress={handleRename}>
              <Text style={[styles.modalBtnText, { color: '#fff' }]}>{t('drive.save')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Pressable>
    </Modal>
  );

  // Share Modal
  const renderShareModal = () => (
    <Modal transparent visible={!!shareModal} animationType="fade" onRequestClose={() => setShareModal(null)}>
      <Pressable style={styles.modalOverlay} onPress={() => setShareModal(null)}>
        <View style={[styles.modalCard, { backgroundColor: colors.surface, ...Shadow.xl }]}>
          <Text style={[styles.modalTitle, { color: colors.text }]}>{t('drive.shareFile')}</Text>
          {shareModal && (
            <Text style={[styles.shareFileName, { color: colors.textSecondary }]} numberOfLines={1}>{shareModal.name}</Text>
          )}
          <TextInput
            style={[styles.modalInput, { color: colors.text, borderColor: colors.border, backgroundColor: isDark ? colors.surfaceVariant : '#f8fafc' }]}
            value={shareEmail}
            onChangeText={setShareEmail}
            placeholder={t('drive.emailPlaceholder')}
            placeholderTextColor={colors.textTertiary}
            keyboardType="email-address"
            autoCapitalize="none"
            autoFocus
          />
          <View style={styles.permissionRow}>
            <Text style={[styles.permissionLabel, { color: colors.text }]}>{t('drive.permission')}:</Text>
            <TouchableOpacity
              style={[styles.permissionOption, sharePermission === 'view' && { backgroundColor: colors.primary + '20', borderColor: colors.primary }]}
              onPress={() => setSharePermission('view')}
            >
              <Text style={[styles.permissionText, { color: sharePermission === 'view' ? colors.primary : colors.textSecondary }]}>{t('drive.viewOnly')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.permissionOption, sharePermission === 'edit' && { backgroundColor: colors.primary + '20', borderColor: colors.primary }]}
              onPress={() => setSharePermission('edit')}
            >
              <Text style={[styles.permissionText, { color: sharePermission === 'edit' ? colors.primary : colors.textSecondary }]}>{t('drive.canEdit')}</Text>
            </TouchableOpacity>
          </View>
          {/* Copy link */}
          <TouchableOpacity
            style={[styles.copyLinkBtn, { borderColor: colors.border }]}
            onPress={() => {
              const url = api.fileDownloadUrl(shareModal?.id);
              if (Platform.OS === 'web' && navigator.clipboard) navigator.clipboard.writeText(url);
              safeAlert(t('drive.linkCopied'));
            }}
          >
            <IconLink size={16} color={colors.primary} />
            <Text style={[styles.copyLinkText, { color: colors.primary }]}>{t('drive.copyLink')}</Text>
          </TouchableOpacity>
          <View style={styles.modalBtns}>
            <TouchableOpacity style={[styles.modalBtn, { backgroundColor: isDark ? colors.surfaceVariant : '#f1f5f9' }]} onPress={() => setShareModal(null)}>
              <Text style={[styles.modalBtnText, { color: colors.textSecondary }]}>{t('drive.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.modalBtn, { backgroundColor: colors.primary }]} onPress={handleShare}>
              <Text style={[styles.modalBtnText, { color: '#fff' }]}>{t('drive.share')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Pressable>
    </Modal>
  );

  // Move Modal
  const renderMoveModal = () => (
    <Modal transparent visible={!!moveModal} animationType="fade" onRequestClose={() => setMoveModal(null)}>
      <Pressable style={styles.modalOverlay} onPress={() => setMoveModal(null)}>
        <View style={[styles.modalCard, { backgroundColor: colors.surface, ...Shadow.xl, maxHeight: 400 }]}>
          <Text style={[styles.modalTitle, { color: colors.text }]}>{t('drive.moveToFolder')}</Text>
          <TouchableOpacity style={[styles.moveFolderItem, { borderBottomColor: colors.border }]} onPress={() => handleMove(null)}>
            <IconHome size={18} color={colors.primary} />
            <Text style={[styles.moveFolderName, { color: colors.text }]}>{t('drive.rootHome')}</Text>
          </TouchableOpacity>
          <FlatList
            data={moveFolders.filter(f => f.id !== moveModal?.id)}
            keyExtractor={item => String(item.id)}
            renderItem={({ item }) => (
              <TouchableOpacity style={[styles.moveFolderItem, { borderBottomColor: colors.border }]} onPress={() => handleMove(item.id)}>
                <IconFolder size={18} color="#f59e0b" />
                <Text style={[styles.moveFolderName, { color: colors.text }]}>{item.name}</Text>
              </TouchableOpacity>
            )}
            style={{ maxHeight: 250 }}
          />
          <TouchableOpacity style={[styles.modalBtn, { backgroundColor: isDark ? colors.surfaceVariant : '#f1f5f9', marginTop: 12 }]} onPress={() => setMoveModal(null)}>
            <Text style={[styles.modalBtnText, { color: colors.textSecondary }]}>{t('drive.cancel')}</Text>
          </TouchableOpacity>
        </View>
      </Pressable>
    </Modal>
  );

  // Storage Info Modal
  const renderStorageModal = () => {
    const driveBytes = storageInfo?.drive_bytes || storageUsedBytes;
    const emailBytes = storageInfo?.email_bytes || 0;
    const chatBytes = storageInfo?.chat_bytes || 0;
    const feedBytes = storageInfo?.feed_bytes || 0;
    const freeBytes = storageTotalBytes - storageUsedBytes;

    const segments = [
      { label: 'Drive', bytes: driveBytes, color: '#2563eb' },
      { label: 'Email', bytes: emailBytes, color: '#16a34a' },
      { label: 'Chat', bytes: chatBytes, color: '#f59e0b' },
      { label: 'Feed', bytes: feedBytes, color: '#8b5cf6' },
    ].filter(s => s.bytes > 0);

    return (
      <Modal transparent visible={storageModal} animationType="fade" onRequestClose={() => setStorageModal(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setStorageModal(false)}>
          <View style={[styles.modalCard, { backgroundColor: colors.surface, ...Shadow.xl, maxWidth: 400 }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>{t('drive.storageDetails')}</Text>

            {/* Usage bar */}
            <View style={[styles.storageModalBar, { backgroundColor: isDark ? colors.surfaceVariant : '#e5e7eb' }]}>
              {segments.map((seg, i) => {
                const pct = (seg.bytes / storageTotalBytes) * 100;
                return <View key={i} style={{ width: `${Math.max(pct, 0.5)}%`, height: '100%', backgroundColor: seg.color, borderRadius: i === 0 ? 4 : 0 }} />;
              })}
            </View>

            {/* Breakdown */}
            <View style={styles.storageBreakdown}>
              {segments.map((seg, i) => (
                <View key={i} style={styles.storageSegmentRow}>
                  <View style={[styles.storageColorDot, { backgroundColor: seg.color }]} />
                  <Text style={[styles.storageSegLabel, { color: colors.text }]}>{seg.label}</Text>
                  <Text style={[styles.storageSegValue, { color: colors.textSecondary }]}>{formatBytes(seg.bytes)}</Text>
                </View>
              ))}
              <View style={styles.storageDivider} />
              <View style={styles.storageSegmentRow}>
                <View style={[styles.storageColorDot, { backgroundColor: isDark ? '#374151' : '#d1d5db' }]} />
                <Text style={[styles.storageSegLabel, { color: colors.text }]}>{t('drive.free')}</Text>
                <Text style={[styles.storageSegValue, { color: colors.textSecondary }]}>{formatBytes(Math.max(freeBytes, 0))}</Text>
              </View>
            </View>

            <Text style={[styles.storageTotalText, { color: colors.textSecondary }]}>
              {formatBytes(storageUsedBytes)} {t('drive.ofStorage', { total: formatBytes(storageTotalBytes) })}
            </Text>

            <TouchableOpacity style={[styles.modalBtn, { backgroundColor: colors.primary, marginTop: 16, alignSelf: 'center' }]} onPress={() => setStorageModal(false)}>
              <Text style={[styles.modalBtnText, { color: '#fff' }]}>{t('drive.close')}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    );
  };

  // Sort Menu
  const renderSortMenu = () => {
    if (!sortMenuVisible) return null;
    const options = [
      { key: 'name', label: t('drive.sortName') },
      { key: 'date', label: t('drive.sortDate') },
      { key: 'size', label: t('drive.sortSize') },
      { key: 'type', label: t('drive.sortType') },
    ];
    return (
      <Modal transparent visible animationType="fade" onRequestClose={() => setSortMenuVisible(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setSortMenuVisible(false)}>
          <View style={[styles.sortMenu, { backgroundColor: colors.surface, borderColor: colors.border, ...Shadow.lg }]}>
            {options.map(opt => (
              <TouchableOpacity
                key={opt.key}
                style={[styles.sortOption, sortBy === opt.key && { backgroundColor: isDark ? colors.primaryLight : '#eff6ff' }]}
                onPress={() => {
                  if (sortBy === opt.key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
                  else { setSortBy(opt.key); setSortDir('asc'); }
                  setSortMenuVisible(false);
                }}
              >
                <Text style={[styles.sortOptionText, { color: sortBy === opt.key ? colors.primary : colors.text }]}>{opt.label}</Text>
                {sortBy === opt.key && (
                  <Text style={{ color: colors.primary, fontSize: 12 }}>{sortDir === 'asc' ? '\u2191' : '\u2193'}</Text>
                )}
              </TouchableOpacity>
            ))}
          </View>
        </Pressable>
      </Modal>
    );
  };

  // File Details Modal (bottom sheet)
  const renderDetailsModal = () => {
    if (!detailsFile) return null;
    const item = detailsFile;
    const ext = getFileExt(item.name);
    const badge = getFileTypeBadge(item);
    const downloadUrl = api.fileDownloadUrl(item.id);
    const sharedList = item.shared_with || [];
    // Build folder path from breadcrumbs
    const folderPath = breadcrumbs.map(b => b.name).join(' / ');

    return (
      <Modal transparent visible animationType="slide" onRequestClose={() => setDetailsFile(null)}>
        <Pressable style={styles.modalOverlay} onPress={() => setDetailsFile(null)}>
          <Pressable style={[styles.detailsSheet, { backgroundColor: colors.surface }]} onPress={(e) => e.stopPropagation()}>
            {/* Drag handle */}
            <View style={styles.detailsHandle}>
              <View style={[styles.detailsHandleBar, { backgroundColor: colors.textTertiary }]} />
            </View>

            {/* File header */}
            <View style={styles.detailsHeader}>
              <View style={[styles.detailsIconWrap, { backgroundColor: getIconBgColor(item.icon_type, isDark) }]}>
                {getFileIcon(item.icon_type, 32, colors.textSecondary)}
                {badge && (
                  <View style={[styles.fileTypeBadge, { backgroundColor: badge.bg, bottom: -2, right: -2, top: 'auto', left: 'auto' }]}>
                    <Text style={[styles.fileTypeBadgeText, { fontSize: 7 }]}>{badge.label}</Text>
                  </View>
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.detailsFileName, { color: colors.text }]} numberOfLines={2}>{item.name}</Text>
                <Text style={[styles.detailsFileType, { color: colors.textTertiary }]}>
                  {ext.toUpperCase()} {item.icon_type ? `\u2022 ${item.icon_type}` : ''}
                </Text>
              </View>
            </View>

            {/* Details rows */}
            <View style={styles.detailsBody}>
              <View style={[styles.detailsRow, { borderBottomColor: colors.border }]}>
                <Text style={[styles.detailsLabel, { color: colors.textTertiary }]}>{t('drive.sortSize')}</Text>
                <Text style={[styles.detailsValue, { color: colors.text }]}>{formatBytes(item.size)}</Text>
              </View>
              <View style={[styles.detailsRow, { borderBottomColor: colors.border }]}>
                <Text style={[styles.detailsLabel, { color: colors.textTertiary }]}>{t('drive.detailsModified')}</Text>
                <Text style={[styles.detailsValue, { color: colors.text }]}>
                  {item.updated_at ? new Date(item.updated_at).toLocaleString() : '-'}
                </Text>
              </View>
              <View style={[styles.detailsRow, { borderBottomColor: colors.border }]}>
                <Text style={[styles.detailsLabel, { color: colors.textTertiary }]}>{t('drive.detailsCreated')}</Text>
                <Text style={[styles.detailsValue, { color: colors.text }]}>
                  {item.created_at ? new Date(item.created_at).toLocaleString() : '-'}
                </Text>
              </View>
              <View style={[styles.detailsRow, { borderBottomColor: colors.border }]}>
                <Text style={[styles.detailsLabel, { color: colors.textTertiary }]}>{t('drive.detailsLocation')}</Text>
                <Text style={[styles.detailsValue, { color: colors.text }]}>{folderPath || t('drive.rootHome')}</Text>
              </View>
              {sharedList.length > 0 && (
                <View style={[styles.detailsRow, { borderBottomColor: colors.border }]}>
                  <Text style={[styles.detailsLabel, { color: colors.textTertiary }]}>{t('drive.detailsSharedWith')}</Text>
                  <View style={{ flex: 1, alignItems: 'flex-end' }}>
                    {sharedList.map((s, i) => (
                      <Text key={i} style={[styles.detailsValue, { color: colors.text }]}>{s.email || s}</Text>
                    ))}
                  </View>
                </View>
              )}
            </View>

            {/* Action buttons */}
            <View style={styles.detailsActions}>
              <TouchableOpacity
                style={[styles.detailsActionBtn, { backgroundColor: colors.primary }]}
                onPress={() => { setDetailsFile(null); setPreviewFile(item); }}
              >
                <IconFileText size={16} color="#fff" />
                <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>{t('drive.open')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.detailsActionBtn, { backgroundColor: isDark ? colors.surfaceVariant : '#f1f5f9' }]}
                onPress={() => { setDetailsFile(null); handleDownload(item); }}
              >
                <IconDownload size={16} color={colors.text} />
                <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>{t('drive.download')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.detailsActionBtn, { backgroundColor: isDark ? colors.surfaceVariant : '#f1f5f9' }]}
                onPress={() => { setDetailsFile(null); setShareModal(item); }}
              >
                <IconShare size={16} color={colors.text} />
                <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>{t('drive.share')}</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    );
  };

  // FAB Menu
  const renderFAB = () => {
    if (activeTab === 'trash') return null;
    return (
      <View style={[styles.fabContainer, { bottom: insets.bottom + 20 }]}>
        {fabOpen && (
          <View style={[styles.fabMenu, { backgroundColor: colors.surface, borderColor: colors.border, ...Shadow.xl }]}>
            <TouchableOpacity style={styles.fabMenuItem} onPress={handleUploadFile}>
              <View style={[styles.fabMenuIcon, { backgroundColor: '#dbeafe' }]}>
                <IconUpload size={18} color="#2563eb" />
              </View>
              <Text style={[styles.fabMenuText, { color: colors.text }]}>{t('drive.uploadFile')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.fabMenuItem} onPress={handleUploadPhotos}>
              <View style={[styles.fabMenuIcon, { backgroundColor: '#fce7f3' }]}>
                <IconCamera size={18} color="#db2777" />
              </View>
              <Text style={[styles.fabMenuText, { color: colors.text }]}>{t('drive.uploadPhotos')}</Text>
            </TouchableOpacity>
            {Platform.OS === 'web' && (
              <TouchableOpacity style={styles.fabMenuItem} onPress={() => {
                setFabOpen(false);
                const input = document.createElement('input');
                input.type = 'file';
                input.webkitdirectory = true;
                input.multiple = true;
                input.onchange = (e) => {
                  const files = Array.from(e.target.files || []);
                  if (files.length > 0) handleDropUpload(files);
                };
                input.click();
              }}>
                <View style={[styles.fabMenuIcon, { backgroundColor: '#e0e7ff' }]}>
                  <IconFolder size={18} color="#4f46e5" />
                </View>
                <Text style={[styles.fabMenuText, { color: colors.text }]}>{t('drive.uploadFolder') || 'Upload de Pasta'}</Text>
              </TouchableOpacity>
            )}
            {Platform.OS !== 'web' && (
              <TouchableOpacity style={styles.fabMenuItem} onPress={async () => {
                setFabOpen(false);
                try {
                  const ImagePicker = require('expo-image-picker');
                  const perm = await ImagePicker.requestCameraPermissionsAsync();
                  if (!perm.granted) { safeAlert(t('drive.permissionNeeded'), t('drive.cameraPermissionMsg')); return; }
                  const result = await ImagePicker.launchCameraAsync({ quality: 0.9 });
                  if (result.canceled || !result.assets?.length) return;
                  setUploading(true);
                  const f = result.assets[0];
                  setUploadProgress([{ name: f.fileName || 'photo.jpg', progress: 0, done: false, error: false }]);
                  setUploadProgress(p => p.map(x => ({ ...x, progress: 50 })));
                  const res = await api.fileUpload({
                    uri: f.uri,
                    name: f.fileName || `photo_${Date.now()}.jpg`,
                    mimeType: 'image/jpeg',
                  }, currentFolderId);
                  setUploadProgress(p => p.map(x => ({ ...x, progress: 100, done: true, error: !res.success })));
                  await loadFiles(currentFolderId);
                  setTimeout(() => { setUploading(false); setUploadProgress([]); }, 1500);
                } catch { setUploading(false); setUploadProgress([]); }
              }}>
                <View style={[styles.fabMenuIcon, { backgroundColor: '#dcfce7' }]}>
                  <IconCamera size={18} color="#16a34a" />
                </View>
                <Text style={[styles.fabMenuText, { color: colors.text }]}>{t('drive.takePhoto')}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.fabMenuItem} onPress={() => { setFabOpen(false); setNewFolderModal(true); }}>
              <View style={[styles.fabMenuIcon, { backgroundColor: '#fef3c7' }]}>
                <IconFolderPlus size={18} color="#d97706" />
              </View>
              <Text style={[styles.fabMenuText, { color: colors.text }]}>{t('drive.newFolder')}</Text>
            </TouchableOpacity>
          </View>
        )}
        <TouchableOpacity
          style={[styles.fab, { backgroundColor: colors.primary, ...Shadow.float }]}
          onPress={() => setFabOpen(!fabOpen)}
          activeOpacity={0.8}
        >
          {fabOpen ? <IconX size={24} color="#fff" /> : <IconPlus size={24} color="#fff" />}
        </TouchableOpacity>
      </View>
    );
  };

  // --- Recent Files Section ---
  const renderRecentFiles = () => {
    if (recentFiles.length === 0) return null;
    return (
      <View style={styles.recentSection}>
        <Text style={[styles.recentTitle, { color: colors.text }]}>{t('drive.recent')}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recentScroll}>
          {recentFiles.map(item => {
            const badge = getFileTypeBadge(item);
            return (
              <TouchableOpacity
                key={item.id}
                style={[styles.recentItem, { backgroundColor: colors.surface, borderColor: colors.border }]}
                onPress={() => handleItemPress(item)}
                {...(Platform.OS === 'web' ? { onContextMenu: (e) => handleRightClick(item, e) } : {})}
                activeOpacity={0.7}
              >
                <View style={[styles.recentThumb, { backgroundColor: getIconBgColor(item.icon_type, isDark) }]}>
                  {isPhoto(item) && item.thumbnail_url
                    ? <Image source={{ uri: item.thumbnail_url }} style={{ width: '100%', height: '100%', borderRadius: 6 }} resizeMode="cover" />
                    : getFileIcon(item.icon_type, 24, colors.textSecondary)
                  }
                  {badge && (
                    <View style={[styles.fileTypeBadge, { backgroundColor: badge.bg, bottom: 2, right: 2, top: 'auto', left: 'auto' }]}>
                      <Text style={[styles.fileTypeBadgeText, { fontSize: 7 }]}>{badge.label}</Text>
                    </View>
                  )}
                </View>
                <Text style={[styles.recentName, { color: colors.text }]} numberOfLines={1}>{item.name}</Text>
                <Text style={[styles.recentDate, { color: colors.textTertiary }]}>{formatDate(item.updated_at || item.created_at, t)}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
    );
  };

  // --- Desktop Preview Panel ---
  const renderPreviewPanel = () => {
    if (!previewPanelFile || !isDesktop) return null;
    const item = previewPanelFile;
    const downloadUrl = api.fileDownloadUrl(item.id);
    const ext = getFileExt(item.name);
    const isPdf = ext === 'pdf' || item.icon_type === 'pdf';
    const isImg = isPhoto(item);
    const isVid = isVideo(item);

    return (
      <View style={[styles.previewPanel, { backgroundColor: colors.surface, borderLeftColor: colors.border }]}>
        <View style={[styles.previewPanelHeader, { borderBottomColor: colors.border }]}>
          <Text style={[styles.previewPanelTitle, { color: colors.text }]} numberOfLines={1}>{item.name}</Text>
          <TouchableOpacity onPress={() => setPreviewPanelFile(null)} style={{ padding: 4 }}>
            <IconX size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
        <ScrollView style={styles.previewPanelBody} contentContainerStyle={{ alignItems: 'center' }}>
          {isImg ? (
            <Image source={{ uri: downloadUrl }} style={styles.previewPanelImage} resizeMode="contain" />
          ) : isVid ? (
            Platform.OS === 'web' ? (
              <View style={styles.previewPanelMedia}>
                <video src={downloadUrl} controls style={{ width: '100%', maxHeight: 280, borderRadius: 8 }} />
              </View>
            ) : (
              <View style={[styles.previewPanelPlaceholder, { backgroundColor: getIconBgColor(item.icon_type, isDark) }]}>
                <IconFilm size={48} color={colors.textSecondary} />
              </View>
            )
          ) : isPdf && Platform.OS === 'web' ? (
            <View style={styles.previewPanelMedia}>
              <iframe src={downloadUrl} style={{ width: '100%', height: 350, border: 'none', borderRadius: 8 }} title={item.name} />
            </View>
          ) : (
            <View style={[styles.previewPanelPlaceholder, { backgroundColor: getIconBgColor(item.icon_type, isDark) }]}>
              {getFileIcon(item.icon_type, 56, colors.textSecondary)}
            </View>
          )}

          {/* File info */}
          <View style={styles.previewPanelInfo}>
            <Text style={[styles.previewInfoLabel, { color: colors.textSecondary }]}>{t('drive.fileInfo')}</Text>
            <View style={styles.previewInfoRow}>
              <Text style={[styles.previewInfoKey, { color: colors.textTertiary }]}>{t('drive.sortType')}</Text>
              <Text style={[styles.previewInfoValue, { color: colors.text }]}>{ext.toUpperCase() || item.icon_type || '-'}</Text>
            </View>
            <View style={styles.previewInfoRow}>
              <Text style={[styles.previewInfoKey, { color: colors.textTertiary }]}>{t('drive.sortSize')}</Text>
              <Text style={[styles.previewInfoValue, { color: colors.text }]}>{formatBytes(item.size)}</Text>
            </View>
            <View style={styles.previewInfoRow}>
              <Text style={[styles.previewInfoKey, { color: colors.textTertiary }]}>{t('drive.detailsModified')}</Text>
              <Text style={[styles.previewInfoValue, { color: colors.text }]}>{item.updated_at ? new Date(item.updated_at).toLocaleString() : '-'}</Text>
            </View>
            <View style={styles.previewInfoRow}>
              <Text style={[styles.previewInfoKey, { color: colors.textTertiary }]}>{t('drive.detailsCreated')}</Text>
              <Text style={[styles.previewInfoValue, { color: colors.text }]}>{item.created_at ? new Date(item.created_at).toLocaleString() : '-'}</Text>
            </View>
          </View>
        </ScrollView>

        {/* Actions */}
        <View style={[styles.previewPanelActions, { borderTopColor: colors.border }]}>
          <TouchableOpacity style={[styles.previewActionBtn, { backgroundColor: colors.primary }]} onPress={() => { setPreviewPanelFile(null); setPreviewFile(item); }}>
            <IconFileText size={16} color="#fff" />
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>{t('drive.open')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.previewActionBtn, { backgroundColor: isDark ? colors.surfaceVariant : '#f1f5f9' }]} onPress={() => handleDownload(item)}>
            <IconDownload size={16} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.previewActionBtn, { backgroundColor: isDark ? colors.surfaceVariant : '#f1f5f9' }]} onPress={() => { setPreviewPanelFile(null); setShareModal(item); }}>
            <IconShare size={16} color={colors.text} />
            <Text style={{ color: colors.text, fontSize: 12, fontWeight: '600' }}>{t('drive.share')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.previewActionBtn, { backgroundColor: '#fef2f2' }]} onPress={() => { setPreviewPanelFile(null); handleDelete(item); }}>
            <IconTrash size={16} color="#dc2626" />
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // File Preview
  const renderPreview = () => {
    if (!previewFile) return null;
    // Collect all previewable files for navigation (photos tab: media only, else all non-folder files)
    const previewableFiles = activeTab === 'photos'
      ? [...files].filter(f => isMedia(f))
      : [...files].filter(f => !f.is_folder);
    const idx = previewableFiles.findIndex(f => f.id === previewFile.id);
    return (
      <FileViewer
        visible={true}
        file={previewFile}
        files={previewableFiles.length > 1 ? previewableFiles : undefined}
        initialIndex={idx >= 0 ? idx : 0}
        onClose={() => setPreviewFile(null)}
        getUrl={(f) => api.fileDownloadUrl(f.id)}
      />
    );
  };

  // ============================================================
  // MAIN RENDER
  // ============================================================
  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const gridCols = isDesktop ? (previewPanelFile ? 4 : 5) : 2;
  const gridKey = `grid-${gridCols}`;

  return (
    <View
      style={[styles.container, { backgroundColor: colors.background, paddingTop: Platform.OS === 'web' ? 0 : insets.top }]}
      {...(Platform.OS === 'web' ? {
        onDragOver: (e) => {
          e.preventDefault();
          // Don't show upload overlay for internal file-to-folder drags
          if (e.dataTransfer?.types?.includes('text/x-drive-file-id')) return;
          if (!dragOver) {
            setDragOver(true);
            // Detect if items contain folders
            const items = e.dataTransfer?.items;
            if (items) {
              let hasFolder = false;
              for (let i = 0; i < items.length; i++) {
                const entry = items[i].webkitGetAsEntry?.();
                if (entry && entry.isDirectory) { hasFolder = true; break; }
              }
              setDragHasFolders(hasFolder);
            }
            // Start pulse animation
            Animated.loop(
              Animated.sequence([
                Animated.timing(dropPulseAnim, { toValue: 1.08, duration: 800, useNativeDriver: true }),
                Animated.timing(dropPulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
              ])
            ).start();
          }
        },
        onDragLeave: (e) => {
          e.preventDefault();
          // Only hide if leaving the container (not entering a child)
          if (e.currentTarget && !e.currentTarget.contains(e.relatedTarget)) {
            setDragOver(false);
            setDragHasFolders(false);
            setDragOverFolder(null);
            dropPulseAnim.stopAnimation();
            dropPulseAnim.setValue(1);
          }
        },
        onDrop: (e) => {
          e.preventDefault();
          setDragOver(false);
          setDragHasFolders(false);
          dropPulseAnim.stopAnimation();
          dropPulseAnim.setValue(1);

          // Skip internal file-to-folder drags (handled by folder onDrop)
          const dt = e.dataTransfer;
          if (dt?.types?.includes('text/x-drive-file-id')) return;

          // Use webkitGetAsEntry to recursively read folder contents
          const items = dt?.items;
          let hasEntryApi = false;

          if (items && items.length > 0) {
            const firstEntry = items[0].webkitGetAsEntry?.();
            if (firstEntry) hasEntryApi = true;
          }

          if (hasEntryApi) {
            // Modern API: traverse directory entries
            (async () => {
              const files = [];
              const traverseEntry = async (entry, path) => {
                if (entry.isFile) {
                  const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
                  file._relativePath = path + entry.name;
                  files.push(file);
                } else if (entry.isDirectory) {
                  const reader = entry.createReader();
                  let allEntries = [];
                  // readEntries may return partial results, must call repeatedly
                  const readAll = () => new Promise((resolve, reject) => {
                    reader.readEntries((entries) => {
                      if (entries.length === 0) resolve(allEntries);
                      else { allEntries = allEntries.concat(Array.from(entries)); readAll().then(resolve).catch(reject); }
                    }, reject);
                  });
                  await readAll();
                  for (const child of allEntries) {
                    await traverseEntry(child, path + entry.name + '/');
                  }
                }
              };

              for (let i = 0; i < items.length; i++) {
                const entry = items[i].webkitGetAsEntry?.();
                if (entry) await traverseEntry(entry, '');
              }

              if (files.length > 0) handleDropUpload(files);
            })();
          } else {
            // Fallback: plain file list
            const droppedFiles = Array.from(dt?.files || []);
            if (droppedFiles.length > 0) handleDropUpload(droppedFiles);
          }
        },
      } : {})}
    >
      {/* Drag & Drop Overlay — full screen with pulse */}
      {dragOver && Platform.OS === 'web' && (
        <View style={styles.dragOverlay}>
          <Animated.View style={[styles.dragOverlayInner, { transform: [{ scale: dropPulseAnim }] }]}>
            {dragHasFolders ? <IconFolder size={52} color="#fff" /> : <IconUpload size={48} color="#fff" />}
            <Text style={styles.dragOverlayText}>
              {dragHasFolders ? (t('drive.dropFolders') || 'Solte as pastas aqui') : t('drive.dropFiles')}
            </Text>
            {dragHasFolders && (
              <Text style={styles.dragOverlaySubtext}>
                {t('drive.dropFoldersHint') || 'A estrutura de pastas será preservada'}
              </Text>
            )}
          </Animated.View>
        </View>
      )}

      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <IconArrowLeft size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Chatyy Drive</Text>
          <View style={styles.headerActions}>
            <TouchableOpacity style={styles.headerActionBtn} onPress={() => setViewMode(v => v === 'grid' ? 'list' : 'grid')}>
              {viewMode === 'grid' ? <IconMenu size={20} color={colors.textSecondary} /> : <IconGrid size={20} color={colors.textSecondary} />}
            </TouchableOpacity>
            <TouchableOpacity style={styles.headerActionBtn} onPress={() => setSortMenuVisible(true)}>
              <IconMoreVert size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Search */}
        <View style={[styles.searchContainer, { backgroundColor: isDark ? colors.surfaceVariant : '#f1f5f9', borderColor: colors.border }]}>
          <IconSearch size={18} color={colors.textTertiary} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            value={searchText}
            onChangeText={handleSearch}
            placeholder={t('drive.searchPlaceholder')}
            placeholderTextColor={colors.textTertiary}
          />
          {searchText.length > 0 && (
            <TouchableOpacity onPress={() => { setSearchText(''); setSearchResults(null); }}>
              <IconX size={16} color={colors.textTertiary} />
            </TouchableOpacity>
          )}
          {isSearching && <ActivityIndicator size="small" color={colors.primary} style={{ marginLeft: 6 }} />}
        </View>
      </View>

      {/* Storage Bar */}
      {renderStorageBar()}

      {/* Bulk Actions Bar */}
      {selectMode && (
        <View style={[styles.bulkBar, { backgroundColor: isDark ? colors.primaryLight : '#eff6ff', borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={clearSelection} style={styles.bulkCloseBtn}>
            <IconX size={18} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.bulkText, { color: colors.text }]}>
            {selectedItems.size} {t('drive.selected')}
          </Text>
          <View style={styles.bulkActions}>
            <TouchableOpacity style={styles.bulkActionBtn} onPress={handleBulkDelete}>
              <IconTrash size={18} color="#dc2626" />
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Tabs */}
      {renderTabs()}

      {/* Breadcrumbs */}
      {renderBreadcrumbs()}

      {/* Trash header */}
      {activeTab === 'trash' && trashFiles.length > 0 && (
        <View style={[styles.trashHeader, { backgroundColor: isDark ? '#450a0a' : '#fef2f2', borderBottomColor: colors.border }]}>
          <Text style={[styles.trashHeaderText, { color: isDark ? '#fca5a5' : '#991b1b' }]}>{t('drive.trashNote')}</Text>
          <TouchableOpacity style={[styles.emptyTrashBtn, { borderColor: '#dc2626' }]} onPress={handleEmptyTrash}>
            <Text style={{ color: '#dc2626', fontSize: 12, fontWeight: '600' }}>{t('drive.emptyTrash')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Content with optional side preview panel */}
      <View style={{ flex: 1, flexDirection: 'row' }}>
        <View style={{ flex: 1 }}>
          {/* Recent Files Section */}
          {renderRecentFiles()}

          {/* Content */}
          {activeTab === 'photos' ? (
            renderPhotosTab()
          ) : displayItems.length === 0 ? (
            renderEmptyState()
          ) : viewMode === 'list' ? (
            <FlatList
              data={displayItems}
              keyExtractor={item => `${item.is_folder ? 'f' : 'i'}_${item.id}`}
              renderItem={renderListItem}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
              contentContainerStyle={{ paddingBottom: 100 }}
            />
          ) : (
            <FlatList
              data={displayItems}
              keyExtractor={item => `${item.is_folder ? 'f' : 'i'}_${item.id}`}
              renderItem={renderGridItem}
              numColumns={gridCols}
              key={gridKey}
              columnWrapperStyle={styles.gridRow}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
              contentContainerStyle={{ padding: isDesktop ? 24 : 12, paddingBottom: 100 }}
            />
          )}
        </View>

        {/* Desktop Preview Panel */}
        {renderPreviewPanel()}
      </View>

      {/* Overlays & Modals */}
      {renderUploadProgress()}
      {renderFAB()}
      {renderContextMenu()}
      {renderNewFolderModal()}
      {renderRenameModal()}
      {renderShareModal()}
      {renderMoveModal()}
      {renderStorageModal()}
      {renderSortMenu()}
      {renderDetailsModal()}
      {renderPreview()}
    </View>
  );
}

// ============================================================
// STYLES
// ============================================================
const styles = StyleSheet.create({
  container: { flex: 1 },

  // Header
  header: { borderBottomWidth: 1, paddingHorizontal: 16, paddingBottom: 12, paddingTop: 12 },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  backBtn: { padding: 4, marginRight: 8 },
  headerTitle: { fontSize: FontSize.title, fontWeight: '700', flex: 1, letterSpacing: -0.3 },
  headerActions: { flexDirection: 'row', gap: 4 },
  headerActionBtn: { padding: 8, borderRadius: BorderRadius.md },

  // Search
  searchContainer: { flexDirection: 'row', alignItems: 'center', borderRadius: BorderRadius.lg, paddingHorizontal: 12, height: 40, borderWidth: 1 },
  searchInput: { flex: 1, marginLeft: 8, fontSize: FontSize.base, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) },

  // Storage
  storageBar: { marginHorizontal: 16, marginTop: 10, padding: 12, borderRadius: BorderRadius.lg, borderWidth: 1 },
  storageInfo: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  storageText: { fontSize: FontSize.sm, fontWeight: '500' },
  storagePercent: { fontSize: FontSize.sm },
  storageTrack: { height: 6, borderRadius: 3, overflow: 'hidden' },
  storageFill: { height: '100%', borderRadius: 3 },

  // Tabs
  tabBar: { flexDirection: 'row', borderBottomWidth: 1, paddingHorizontal: 16 },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12 },
  tabText: { fontSize: FontSize.sm, fontWeight: '600' },

  // Breadcrumbs
  breadcrumbContainer: { maxHeight: 40, borderBottomWidth: 0 },
  breadcrumbContent: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8 },
  breadcrumbItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  breadcrumbText: { fontSize: FontSize.sm, fontWeight: '500' },

  // Bulk bar
  bulkBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1 },
  bulkCloseBtn: { padding: 4, marginRight: 8 },
  bulkText: { flex: 1, fontSize: FontSize.base, fontWeight: '600' },
  bulkActions: { flexDirection: 'row', gap: 8 },
  bulkActionBtn: { padding: 8, borderRadius: BorderRadius.md },

  // Trash header
  trashHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1 },
  trashHeaderText: { fontSize: FontSize.xs, flex: 1 },
  emptyTrashBtn: { borderWidth: 1, borderRadius: BorderRadius.md, paddingHorizontal: 12, paddingVertical: 4 },

  // List item
  listItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  checkboxArea: { paddingRight: 12 },
  checkbox: { width: 20, height: 20, borderRadius: 4, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  listIconContainer: { width: 42, height: 42, borderRadius: BorderRadius.md, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  listItemInfo: { flex: 1 },
  listItemName: { fontSize: FontSize.base, fontWeight: '500', marginBottom: 2 },
  listItemMeta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  listItemSize: { fontSize: FontSize.xs },
  listItemDate: { fontSize: FontSize.xs },
  moreBtn: { padding: 8 },

  // Grid item
  gridRow: { gap: 12, marginBottom: 12 },
  gridItem: { borderRadius: BorderRadius.lg, borderWidth: 1, overflow: 'hidden' },
  gridCheckbox: { position: 'absolute', top: 8, left: 8, zIndex: 2 },
  gridIconArea: { height: 100, alignItems: 'center', justifyContent: 'center' },
  gridThumbnail: { width: '100%', height: '100%' },
  gridItemInfo: { padding: 10 },
  gridItemName: { fontSize: FontSize.sm, fontWeight: '500', marginBottom: 2 },
  gridItemMeta: { flexDirection: 'row', alignItems: 'center' },
  gridItemSize: { fontSize: FontSize.xs },

  // Photos
  photosContainer: { padding: 12 },
  backupBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 10, borderRadius: BorderRadius.lg, borderWidth: 1, marginBottom: 16 },
  backupBtnText: { fontSize: FontSize.base, fontWeight: '600' },
  photoGroupTitle: { fontSize: FontSize.lg, fontWeight: '700', marginTop: 12, marginBottom: 8, paddingHorizontal: 4 },
  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 2 },
  photoItem: { borderRadius: 4, overflow: 'hidden' },
  photoThumb: { width: '100%', height: '100%' },
  videoOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.2)' },
  playIconBg: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },

  // Empty state
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, paddingTop: 60 },
  emptyTitle: { fontSize: FontSize.xl, fontWeight: '600', marginTop: 16, marginBottom: 6 },
  emptyDesc: { fontSize: FontSize.base, textAlign: 'center', lineHeight: 20 },
  emptyBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 20, paddingHorizontal: 24, paddingVertical: 12, borderRadius: BorderRadius.lg },
  emptyBtnText: { color: '#fff', fontSize: FontSize.base, fontWeight: '600' },

  // Upload progress
  uploadOverlay: { position: 'absolute', bottom: 100, right: 20, width: 280, borderRadius: BorderRadius.lg, padding: 14, borderWidth: 1 },
  uploadTitle: { fontSize: FontSize.sm, fontWeight: '700', marginBottom: 8 },
  uploadItem: { marginBottom: 6 },
  uploadFileName: { fontSize: FontSize.xs, marginBottom: 3 },
  uploadTrack: { height: 4, borderRadius: 2, overflow: 'hidden' },
  uploadFill: { height: '100%', borderRadius: 2 },

  // Modal overlay
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  modalCard: { width: '90%', maxWidth: 420, borderRadius: BorderRadius.xl, padding: 24 },
  modalTitle: { fontSize: FontSize.xxl, fontWeight: '700', marginBottom: 16 },
  modalInput: { borderWidth: 1, borderRadius: BorderRadius.md, paddingHorizontal: 14, height: 44, fontSize: FontSize.base, marginBottom: 12 },
  modalBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  modalBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: BorderRadius.md },
  modalBtnText: { fontSize: FontSize.base, fontWeight: '600' },

  // Context menu
  contextMenuContainer: { width: 220, borderRadius: BorderRadius.lg, borderWidth: 1, overflow: 'hidden' },
  contextMenuHeader: { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1 },
  contextMenuTitle: { fontSize: FontSize.sm, fontWeight: '600' },
  contextMenuItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  contextMenuText: { fontSize: FontSize.base },

  // Share modal extras
  shareFileName: { fontSize: FontSize.sm, marginBottom: 12, marginTop: -8 },
  permissionRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  permissionLabel: { fontSize: FontSize.sm, fontWeight: '500' },
  permissionOption: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: 'transparent' },
  permissionText: { fontSize: FontSize.sm },
  copyLinkBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 12, borderWidth: 1, borderRadius: BorderRadius.md, marginBottom: 12 },
  copyLinkText: { fontSize: FontSize.sm, fontWeight: '500' },

  // Move modal
  moveFolderItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  moveFolderName: { fontSize: FontSize.base },

  // Storage modal
  storageModalBar: { height: 10, borderRadius: 5, overflow: 'hidden', flexDirection: 'row', marginBottom: 20 },
  storageBreakdown: { marginBottom: 12 },
  storageSegmentRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  storageColorDot: { width: 10, height: 10, borderRadius: 5, marginRight: 10 },
  storageSegLabel: { flex: 1, fontSize: FontSize.sm, fontWeight: '500' },
  storageSegValue: { fontSize: FontSize.sm },
  storageDivider: { height: 1, backgroundColor: '#e5e7eb', marginVertical: 6 },
  storageTotalText: { fontSize: FontSize.sm, textAlign: 'center', marginTop: 4 },

  // Sort menu
  sortMenu: { width: 200, borderRadius: BorderRadius.lg, borderWidth: 1, overflow: 'hidden', position: 'absolute', top: 80, right: 20 },
  sortOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  sortOptionText: { fontSize: FontSize.base },

  // Drag & drop overlay — covers entire viewport on web
  dragOverlay: { position: Platform.OS === 'web' ? 'fixed' : 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999, backgroundColor: 'rgba(37, 99, 235, 0.88)', alignItems: 'center', justifyContent: 'center' },
  dragOverlayInner: { alignItems: 'center', gap: 16, padding: 48, borderRadius: 24, borderWidth: 3, borderColor: 'rgba(255,255,255,0.7)', borderStyle: 'dashed' },
  dragOverlayText: { color: '#fff', fontSize: 24, fontWeight: '700', marginTop: 4 },
  dragOverlaySubtext: { color: 'rgba(255,255,255,0.85)', fontSize: 15, fontWeight: '500', marginTop: -4 },

  // File type badge
  fileTypeBadge: { position: 'absolute', bottom: 4, right: 4, paddingHorizontal: 5, paddingVertical: 1.5, borderRadius: 3 },
  fileTypeBadgeText: { color: '#fff', fontSize: 8, fontWeight: '800', letterSpacing: 0.3 },

  // Empty icon circle
  emptyIconCircle: { width: 120, height: 120, borderRadius: 60, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },

  // Recent files
  recentSection: { paddingTop: 16, paddingBottom: 4, paddingHorizontal: 16 },
  recentTitle: { fontSize: FontSize.base, fontWeight: '700', marginBottom: 10 },
  recentScroll: { gap: 10, paddingRight: 16 },
  recentItem: { width: 120, borderRadius: BorderRadius.lg, borderWidth: 1, overflow: 'hidden', paddingBottom: 8 },
  recentThumb: { width: '100%', height: 72, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  recentName: { fontSize: 11, fontWeight: '500', paddingHorizontal: 8, marginBottom: 2 },
  recentDate: { fontSize: 9, paddingHorizontal: 8 },

  // Preview panel (desktop)
  previewPanel: { width: '35%', maxWidth: 400, borderLeftWidth: 1 },
  previewPanelHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
  previewPanelTitle: { fontSize: FontSize.base, fontWeight: '600', flex: 1, marginRight: 8 },
  previewPanelBody: { flex: 1, padding: 16 },
  previewPanelImage: { width: '100%', height: 250, borderRadius: 8, marginBottom: 16 },
  previewPanelMedia: { width: '100%', marginBottom: 16 },
  previewPanelPlaceholder: { width: '100%', height: 160, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  previewPanelInfo: { width: '100%', paddingTop: 8 },
  previewInfoLabel: { fontSize: FontSize.sm, fontWeight: '700', marginBottom: 10 },
  previewInfoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  previewInfoKey: { fontSize: FontSize.sm },
  previewInfoValue: { fontSize: FontSize.sm, fontWeight: '500' },
  previewPanelActions: { flexDirection: 'row', gap: 8, padding: 12, borderTopWidth: 1 },
  previewActionBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: BorderRadius.md },

  // File details sheet
  detailsSheet: { position: 'absolute', bottom: 0, left: 0, right: 0, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 32, maxHeight: '80%' },
  detailsHandle: { alignItems: 'center', paddingVertical: 10 },
  detailsHandleBar: { width: 36, height: 4, borderRadius: 2, opacity: 0.4 },
  detailsHeader: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingBottom: 16 },
  detailsIconWrap: { width: 52, height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  detailsFileName: { fontSize: FontSize.lg, fontWeight: '700' },
  detailsFileType: { fontSize: FontSize.xs, marginTop: 2 },
  detailsBody: { paddingHorizontal: 20 },
  detailsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  detailsLabel: { fontSize: FontSize.sm, fontWeight: '500' },
  detailsValue: { fontSize: FontSize.sm, fontWeight: '500', textAlign: 'right', maxWidth: '60%' },
  detailsActions: { flexDirection: 'row', gap: 10, paddingHorizontal: 20, paddingTop: 20 },
  detailsActionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: BorderRadius.md },

  // FAB
  fabContainer: { position: 'absolute', right: 20, alignItems: 'flex-end' },
  fabMenu: { marginBottom: 12, borderRadius: BorderRadius.lg, borderWidth: 1, overflow: 'hidden' },
  fabMenuItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  fabMenuIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  fabMenuText: { fontSize: FontSize.base, fontWeight: '500' },
  fab: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
});
