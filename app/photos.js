import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, TextInput, ScrollView,
  ActivityIndicator, RefreshControl, Platform, Modal, Image,
  useWindowDimensions, Animated, Switch, Alert, Pressable, SectionList,
  Share, Linking, AppState,
} from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// expo-image for native (ph:// URIs), standard Image for web
import { Image as ExpoImage } from 'expo-image';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { usePhotos } from '../context/PhotosContext';
import { BorderRadius, FontSize, Spacing, Shadow } from '../constants/theme';
import * as api from '../services/api';
import { getCached, setCache } from '../services/cache';
import { GridSkeleton } from '../components/SkeletonLoader';
import mailWs from '../services/websocket';
import {
  IconImage, IconFilm, IconSearch, IconArrowLeft, IconCheck, IconX,
  IconTrash, IconDownload, IconShare, IconStar, IconStarFilled,
  IconMoreVert, IconCamera, IconGrid, IconPlay, IconInfo, IconRefresh,
  IconChevronLeft, IconChevronRight, IconSettings, IconCheckCircle, IconEdit,
} from '../components/Icons';
import PhotoEditor from '../components/PhotoEditor';
import { generateBatch } from '../services/thumbnailCache';
import Svg, { Path, Circle as SvgCircle, Line, Polyline } from 'react-native-svg';

let photoBackup = null;
try { photoBackup = require('../services/photoBackup'); } catch {}

let autoBackupMod = null;
try { autoBackupMod = require('../services/autoBackup'); } catch {}

// Background task is now registered in services/autoBackup.js (TaskManager.defineTask at module level)

// ============================================================
// CUSTOM ICONS
// ============================================================
function IconCloud({ size = 24, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z" />
    </Svg>
  );
}

function IconCloudOff({ size = 24, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M22.61 16.95A5 5 0 0018 10h-1.26a8 8 0 00-7.05-6M5 5a8 8 0 004 15h9a5 5 0 001.7-.3" />
      <Line x1="1" y1="1" x2="23" y2="23" />
    </Svg>
  );
}

function IconCloudCheck({ size = 16, color = '#16a34a' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z" />
      <Polyline points="9 14 11 16 15 12" />
    </Svg>
  );
}

function IconCloudUpload({ size = 24, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z" />
      <Polyline points="16 16 12 12 8 16" />
      <Line x1="12" y1="12" x2="12" y2="21" />
    </Svg>
  );
}

function IconPause({ size = 24, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Line x1="6" y1="4" x2="6" y2="20" />
      <Line x1="18" y1="4" x2="18" y2="20" />
    </Svg>
  );
}

function IconAlbum({ size = 24, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2z" />
      <Polyline points="2 14 8 8 14 14" />
      <SvgCircle cx="17" cy="9" r="2" />
    </Svg>
  );
}

// ============================================================
// CONSTANTS
// ============================================================
const PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff'];
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'm4v', '3gp'];
const TABS = ['photos', 'search', 'albums', 'backup'];
const PAGE_SIZE = Platform.OS === 'web' ? 200 : 60;

const safeAlert = (title, message, buttons) => {
  if (Platform.OS === 'web') {
    if (buttons?.length) {
      const ok = buttons.find(b => b.style !== 'cancel');
      if (ok?.onPress && window.confirm(`${title}\n${message || ''}`)) ok.onPress();
      else { const cancel = buttons.find(b => b.style === 'cancel'); cancel?.onPress?.(); }
    } else { window.alert(message || title); }
  } else { Alert.alert(title, message, buttons); }
};

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

function formatDuration(seconds) {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function groupPhotosByDate(items, t) {
  const groups = [];
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const buckets = new Map();
  const order = [];

  items.forEach(item => {
    const d = new Date(item.created_at || item.uploaded_at || item.modificationTime);
    let key, label;

    if (d >= today) {
      key = 'today'; label = t('photos.today');
    } else if (d >= yesterday) {
      key = 'yesterday'; label = t('photos.yesterday');
    } else if (d >= weekAgo) {
      key = 'thisWeek'; label = t('photos.thisWeek');
    } else if (d >= monthStart) {
      key = 'thisMonth'; label = t('photos.thisMonth');
    } else {
      // Group by month/year
      const monthNames = [
        'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
        'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
      ];
      key = `${d.getFullYear()}-${d.getMonth()}`;
      label = `${monthNames[d.getMonth()]} ${d.getFullYear()}`;
    }

    if (!buckets.has(key)) {
      buckets.set(key, { title: label, data: [] });
      order.push(key);
    }
    buckets.get(key).data.push(item);
  });

  order.forEach(key => {
    const bucket = buckets.get(key);
    if (bucket.data.length > 0) {
      groups.push(bucket);
    }
  });

  return groups;
}

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function PhotosScreen() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const isDesktop = width >= 768;

  // State
  const [activeTab, setActiveTab] = useState('photos');
  const [gridColumns, setGridColumns] = useState(isDesktop ? 5 : 3);
  const [searchText, setSearchText] = useState('');
  const [showSearch, setShowSearch] = useState(false);

  // Data - from PhotosContext (persists between navigations)
  const photosCtx = usePhotos();
  const {
    cloudPhotos, setCloudPhotos,
    devicePhotos, setDevicePhotos,
    storageInfo, setStorageInfo,
    deviceTotalCount, setDeviceTotalCount,
    backedUpTotal, setBackedUpTotal,
    backupStatus, setBackupStatus,
    backupEnabled, setBackupEnabled,
    lastBackupDate, setLastBackupDate,
    albums, setAlbums,
    loadedRef,
  } = photosCtx;

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Plan info
  const [userPlan, setUserPlan] = useState('free');

  // Backup state (local only)
  const [backupWifiOnly, setBackupWifiOnly] = useState(false);
  const [backupIncludeVideos, setBackupIncludeVideos] = useState(true);
  const [backupProgress, setBackupProgress] = useState({ current: 0, total: 0 });
  const [pendingCount, setPendingCount] = useState(0);

  // Selection
  const [selectedItems, setSelectedItems] = useState(new Set());
  const [selectMode, setSelectMode] = useState(false);

  // Viewer
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [viewerStarred, setViewerStarred] = useState(false);
  const [editorVisible, setEditorVisible] = useState(false);

  // Albums (albums state from PhotosContext)
  const [createAlbumVisible, setCreateAlbumVisible] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState('');
  const [viewingAlbum, setViewingAlbum] = useState(null); // album object when viewing album photos
  const [albumPhotos, setAlbumPhotos] = useState([]);
  const [albumLoading, setAlbumLoading] = useState(false);

  // Upload quality
  const [uploadQuality, setUploadQuality] = useState('economy'); // 'original' | 'economy'

  // Favorites filter
  const [showFavorites, setShowFavorites] = useState(false);

  // Trash
  const [trashItems, setTrashItems] = useState([]);
  const [showTrash, setShowTrash] = useState(false);

  // Photo info panel
  const [showInfoPanel, setShowInfoPanel] = useState(false);
  const infoPanelAnim = useRef(new Animated.Value(0)).current;

  // Upload speed tracking
  const uploadSpeedRef = useRef({ bytes: 0, startTime: 0, lastSpeed: 0 });
  const backupAbortRef = useRef(false);
  const autoStartedRef = useRef(false);
  const backupRefreshTimerRef = useRef(null);
  const backupWsUnsubRef = useRef(null);
  // Helper to clean up backup refresh timer + WS listener together
  const cleanupBackupRefresh = useCallback(() => {
    if (backupRefreshTimerRef.current) { clearInterval(backupRefreshTimerRef.current); backupRefreshTimerRef.current = null; }
    if (backupWsUnsubRef.current) { backupWsUnsubRef.current(); backupWsUnsubRef.current = null; }
  }, []);
  const isMountedRef = useRef(true);
  const autoLoadTimerRef = useRef(null);
  const cloudLoadRequestIdRef = useRef(0);

  // Memories
  const [memories, setMemories] = useState([]);

  // Photo restore from cloud state
  const [photoRestoreModal, setPhotoRestoreModal] = useState(false);
  const [cloudPhotoMonths, setCloudPhotoMonths] = useState([]);
  const [cloudPhotoTotal, setCloudPhotoTotal] = useState(0);
  const [selectedMonths, setSelectedMonths] = useState(new Set());
  const [photoRestoreLoading, setPhotoRestoreLoading] = useState(false);
  const [photoRestoreRunning, setPhotoRestoreRunning] = useState(false);
  const [photoRestoreProgress, setPhotoRestoreProgress] = useState({ current: 0, total: 0 });

  // Animations
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: false }).start();
  }, []);

  // ============================================================
  // DATA LOADING
  // ============================================================
  const CLOUD_CACHE_TTL = 7776000000; // 90 days — always show cached, refresh in background
  const loadCloudPhotos = useCallback(async (pageNum = 1, append = false) => {
    // Guard against parallel/stale requests on first page load
    const requestId = (pageNum === 1 && !append) ? ++cloudLoadRequestIdRef.current : cloudLoadRequestIdRef.current;
    try {
      // Show cached photos instantly on first load
      if (pageNum === 1 && !append) {
        const cached = await getCached('cloud_photos');
        if (cached && cached.length > 0) {
          if (requestId !== cloudLoadRequestIdRef.current) return;
          setCloudPhotos(cached);
          setLoading(false);
          // Still fetch fresh in background (don't return, continue below)
        } else {
          setLoading(true);
        }
      } else if (pageNum > 1) {
        setLoadingMore(true);
      }

      const res = await api.filePhotos('all', pageNum, PAGE_SIZE);
      if (requestId !== cloudLoadRequestIdRef.current) return; // Stale request
      const files = res?.data?.files || res?.files;
      if (res?.success && files) {
        // Update backed up total from server (real count)
        const serverTotal = 0; // dont use drive_photos total (oscillates)
        if (serverTotal > 0) setBackedUpTotal(serverTotal);

        const sorted = files.sort((a, b) => {
          const da = new Date(a.created_at || a.uploaded_at);
          const db = new Date(b.created_at || b.uploaded_at);
          return db - da;
        });
        if (append) {
          // Deduplicate by id when appending
          setCloudPhotos(prev => {
            const existingIds = new Set(prev.map(p => p.id));
            const newItems = sorted.filter(p => !existingIds.has(p.id));
            return [...prev, ...newItems];
          });
        } else {
          setCloudPhotos(sorted);
          // Cache first page with 30min TTL for instant load next time
          if (pageNum === 1) setCache('cloud_photos', sorted, CLOUD_CACHE_TTL).catch(() => {});
        }
        setHasMore(sorted.length >= PAGE_SIZE);
        // On web: auto-load next pages until all photos are loaded
        if (Platform.OS === 'web' && sorted.length >= PAGE_SIZE && isMountedRef.current) {
          autoLoadTimerRef.current = setTimeout(() => {
            if (isMountedRef.current) loadCloudPhotos(pageNum + 1, true);
          }, 500);
        }
      } else {
        if (!append) setCloudPhotos([]);
        setHasMore(false);
      }
    } catch (e) {
      console.warn('Failed to load cloud photos:', e);
      if (!append) setCloudPhotos([]);
    } finally {
      if (requestId === cloudLoadRequestIdRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  const loadStorageInfo = useCallback(async () => {
    try {
      // Show cached instantly
      const { getCached, setCache } = await import('../services/cache');
      const cached = await getCached('drive_storage_info');
      if (cached && !storageInfo) setStorageInfo(cached);
      // Also cache backedUpTotal
      const cachedCount = await getCached('photos_backed_up_total');
      if (cachedCount && !backedUpTotal) setBackedUpTotal(cachedCount);
      // Fetch fresh
      const res = await api.fileStorageInfo();
      if (res?.success) {
        setStorageInfo(res.data || res);
        setCache('drive_storage_info', res.data || res, 7776000000);
      }
    } catch (e) {
      console.warn('Failed to load storage info:', e);
    }
  }, []);

  const [photoError, setPhotoError] = useState(null);
  const deviceEndCursorRef = useRef(null);
  const deviceHasMoreRef = useRef(false);
  const deviceLoadingMoreRef = useRef(false);
  // deviceTotalCount and backedUpTotal from PhotosContext

  const loadDevicePhotos = useCallback(async () => {
    if (Platform.OS === 'web') return;

    try {
      const MediaLibrary = require('expo-media-library');
      // Request FULL access (not limited) so all photos including today's are visible
      const perm = await MediaLibrary.requestPermissionsAsync(true); // true = granularPermissions (iOS 14+)
      if (perm.status !== 'granted' && perm.accessPrivileges !== 'all') {
        if (perm.accessPrivileges === 'limited') {
          setPhotoError('⚠️ Acesso LIMITADO: só vejo ' + (perm.totalCount || 'algumas') + ' fotos.\n\nPara fazer backup de TODAS:\nAjustes → Chatyy → Fotos → "Acesso Total"');
        } else {
          setPhotoError('Permissão negada. Vá em Ajustes → Chatyy → Fotos e permita acesso.');
        }
        if (perm.status !== 'granted' && perm.accessPrivileges !== 'limited') return;
      }

      // Load first batch only (like Google Photos - load more on scroll)
      const firstPage = await MediaLibrary.getAssetsAsync({
        mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
        sortBy: [MediaLibrary.SortBy.creationTime],
        first: 500,
      });
      deviceEndCursorRef.current = firstPage?.endCursor;
      deviceHasMoreRef.current = firstPage?.hasNextPage ?? false;
      setDeviceTotalCount(firstPage?.totalCount ?? firstPage?.assets?.length ?? 0);

      if (firstPage?.assets?.length > 0) {
        // Build photo objects from assets — grid appears INSTANTLY with ph:// URIs
        const photos = firstPage.assets.map(a => ({
          id: `device_${a.id}`,
          deviceId: a.id,
          name: a.filename,
          uri: a.uri,
          thumbUri: null, // will be filled by thumbnail cache
          created_at: new Date(a.creationTime).toISOString(),
          icon_type: a.mediaType === 'video' ? 'video' : 'image',
          duration: a.duration,
          width: a.width,
          height: a.height,
          isDevice: true,
          backedUp: false,
        }));

        // Show grid immediately with ph:// URIs (expo-image handles these)
        setDevicePhotos(photos);

        // Generate 200x200 JPEG thumbnails in background (progressive update)
        generateBatch(photos, (done, total) => {
          // Progress callback — not used for intermediate updates since
          // generateBatch returns all results at the end
        }).then(thumbs => {
          // Update photos with cached file:// thumbnail URIs
          setDevicePhotos(prev => prev.map(p => {
            const thumb = thumbs.get(p.deviceId);
            return thumb ? { ...p, thumbUri: thumb } : p;
          }));
        }).catch(() => {});
      }
    } catch (e) {
      console.warn('Media library not available:', e);
      setPhotoError('Módulo de fotos não disponível. Atualize o app pela App Store/Play Store para ativar o backup de fotos.');
    }
  }, []);

  // Load more device photos on scroll (infinite scroll like Google Photos)
  const loadMoreDevicePhotos = useCallback(async () => {
    if (Platform.OS === 'web' || !deviceHasMoreRef.current || deviceLoadingMoreRef.current) return;
    deviceLoadingMoreRef.current = true;
    try {
      const MediaLibrary = require('expo-media-library');
      const page = await MediaLibrary.getAssetsAsync({
        mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
        sortBy: [MediaLibrary.SortBy.creationTime],
        first: 500,
        after: deviceEndCursorRef.current,
      });
      if (page?.assets?.length > 0) {
        const newPhotos = page.assets.map(a => ({
          id: `device_${a.id}`,
          deviceId: a.id,
          name: a.filename,
          uri: a.uri,
          thumbUri: null,
          created_at: new Date(a.creationTime).toISOString(),
          icon_type: a.mediaType === 'video' ? 'video' : 'image',
          duration: a.duration,
          width: a.width,
          height: a.height,
          isDevice: true,
          backedUp: false,
        }));
        // Show immediately with ph:// URIs
        setDevicePhotos(prev => [...prev, ...newPhotos]);
        deviceEndCursorRef.current = page.endCursor;
        deviceHasMoreRef.current = page.hasNextPage;

        // Generate thumbnails in background for newly loaded photos
        generateBatch(newPhotos).then(thumbs => {
          setDevicePhotos(prev => prev.map(p => {
            const thumb = thumbs.get(p.deviceId);
            return thumb && !p.thumbUri ? { ...p, thumbUri: thumb } : p;
          }));
        }).catch(() => {});
      } else {
        deviceHasMoreRef.current = false;
      }
    } catch {} finally {
      deviceLoadingMoreRef.current = false;
    }
  }, []);

  const loadAlbums = useCallback(async () => {
    // Group cloud photos by folder
    const folderMap = new Map();
    cloudPhotos.forEach(photo => {
      const folder = photo.folder_name || t('photos.noAlbum');
      if (!folderMap.has(folder)) {
        folderMap.set(folder, { name: folder, photos: [], cover: null });
      }
      const album = folderMap.get(folder);
      album.photos.push(photo);
      if (!album.cover) album.cover = photo;
    });

    // Add device albums on native
    if (Platform.OS !== 'web') {
      try {
        const MediaLibrary = require('expo-media-library');
        const deviceAlbums = await MediaLibrary.getAlbumsAsync();
        for (const da of deviceAlbums) {
          if (da.assetCount > 0) {
            // Get cover photo for this album
            let cover = null;
            try {
              const albumAssets = await MediaLibrary.getAssetsAsync({
                album: da.id,
                first: 1,
                sortBy: [MediaLibrary.SortBy.creationTime],
              });
              if (albumAssets?.assets?.[0]) {
                const a = albumAssets.assets[0];
                cover = { id: `device_${a.id}`, uri: a.uri, isDevice: true };
              }
            } catch {}

            if (folderMap.has(da.title)) {
              // Merge with existing
              const existing = folderMap.get(da.title);
              existing.count = (existing.count || existing.photos.length) + da.assetCount;
              if (!existing.cover && cover) existing.cover = cover;
            } else {
              folderMap.set(da.title, {
                name: da.title,
                photos: [],
                count: da.assetCount,
                deviceAlbumId: da.id,
                cover,
              });
            }
          }
        }
      } catch {}
    }

    // Also group device photos by date as "virtual albums"
    if (devicePhotos.length > 0 && !folderMap.has('Recentes')) {
      folderMap.set('Recentes', {
        name: 'Recentes',
        photos: devicePhotos.slice(0, 50),
        count: devicePhotos.length,
        cover: devicePhotos[0],
      });
    }

    const albumList = Array.from(folderMap.values());
    setAlbums(albumList);
  }, [cloudPhotos, devicePhotos, t]);

  // Open album — load photos for that album
  const openAlbum = useCallback(async (album) => {
    setViewingAlbum(album);
    setAlbumLoading(true);
    try {
      // If album has device photos (deviceAlbumId), load from MediaLibrary
      if (album.deviceAlbumId && Platform.OS !== 'web') {
        const MediaLibrary = require('expo-media-library');
        const result = await MediaLibrary.getAssetsAsync({
          album: album.deviceAlbumId,
          mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
          sortBy: [MediaLibrary.SortBy.creationTime],
          first: 500,
        });
        const photos = (result?.assets || []).map(a => ({
          id: `device_${a.id}`,
          deviceId: a.id,
          name: a.filename,
          uri: a.uri,
          thumbUri: null,
          created_at: new Date(a.creationTime).toISOString(),
          icon_type: a.mediaType === 'video' ? 'video' : 'image',
          duration: a.duration,
          width: a.width,
          height: a.height,
          isDevice: true,
        }));
        setAlbumPhotos(photos);
      } else if (album.name === 'Recentes') {
        // Virtual album — just use device photos
        setAlbumPhotos(devicePhotos);
      } else if (album.photos?.length > 0) {
        // Cloud album — already has photos
        setAlbumPhotos(album.photos);
      } else {
        setAlbumPhotos([]);
      }
    } catch (e) {
      console.warn('Failed to load album photos:', e);
      setAlbumPhotos(album.photos || []);
    }
    setAlbumLoading(false);
  }, [devicePhotos]);

  useEffect(() => {
    let mounted = true;
    // Skip full reload if already loaded (data persists in PhotosContext)
    // Always load backup setting (even on re-visit)
    AsyncStorage.getItem('backup_auto_enabled').then(v => { if (v === 'true') setBackupEnabled(true); }).catch(() => {});
    AsyncStorage.getItem('backup_wifi_only').then(v => { if (v !== null) setBackupWifiOnly(v === 'true'); }).catch(() => {});

    // ALWAYS refresh device total count (critical for backup progress)
    if (Platform.OS !== 'web') {
      (async () => {
        try {
          const ML = require('expo-media-library');
          const { status } = await ML.getPermissionsAsync();
          if (status === 'granted') {
            const r = await ML.getAssetsAsync({ mediaType: [ML.MediaType.photo, ML.MediaType.video], first: 1 });
            const total = r?.totalCount || 0;
            if (total > 0 && mounted) {
              setDeviceTotalCount(total);
              console.log('[Photos] Device total count:', total);
            }
          }
        } catch (e) { console.warn('[Photos] Count error:', e?.message); }
      })();
    }

    if (loadedRef.current && (devicePhotos.length > 0 || cloudPhotos.length > 0)) {
      setLoading(false);
      api.apiCall('drive_backup_count').then(r => { const t = r?.data?.count || 0; if (t > 0) setBackedUpTotal(t); }).catch(() => {});
      const timer = setInterval(() => {
        api.apiCall('drive_backup_count').then(r => { const t = r?.data?.count || 0; if (t > 0) setBackedUpTotal(t); }).catch(() => {});
      }, 5000);
      return () => { mounted = false; clearInterval(timer); };
    }
    loadedRef.current = true;
    if (Platform.OS === 'web') {
      // Web: load cloud photos immediately (no device photos)
      loadCloudPhotos(1);
      loadStorageInfo();
    } else {
      // Mobile: device photos first, cloud in background
      loadDevicePhotos();
      setTimeout(() => { loadCloudPhotos(1); loadStorageInfo(); }, 2000);
    }
    // Load all preferences in parallel
    Promise.all([
      api.planInfo().catch(() => null),
      AsyncStorage.getItem('last_backup_date').catch(() => null),
      AsyncStorage.getItem('backup_auto_enabled').catch(() => null),
      AsyncStorage.getItem('backup_quality').catch(() => null),
      api.fileTrash().catch(() => null),
      AsyncStorage.getItem('backed_up_photos').catch(() => null),
    ]).then(([planRes, lastDate, autoEnabled, quality, trashRes, backedUpSaved]) => {
      if (!mounted) return;
      if (planRes?.success) setUserPlan((planRes.data || planRes).plan || 'free');
      if (lastDate) setLastBackupDate(lastDate);
      if (autoEnabled === 'true') setBackupEnabled(true);
      if (quality) setUploadQuality(quality);
      if (trashRes?.success) setTrashItems(trashRes.data?.files || trashRes.files || []);
      if (backedUpSaved) {
        try {
          const ids = JSON.parse(backedUpSaved);
          setDevicePhotos(prev => prev.map(p => p.deviceId && ids[p.deviceId] ? { ...p, backedUp: true } : p));
        } catch {}
      }
      // Get real backed up count from server (more accurate than local)
      api.apiCall('drive_backup_count').then(r => {
        const serverTotal = r?.data?.count || r?.data?.total || 0;
        if (serverTotal > 0 && mounted) setBackedUpTotal(serverTotal);
      }).catch(() => {});
    });
    // Refresh backed up count every 15 seconds
    const backupRefreshTimer = setInterval(() => {
      api.apiCall('drive_backup_count').then(r => {
        const serverTotal = r?.data?.count || r?.data?.total || 0;
        if (serverTotal > 0) setBackedUpTotal(serverTotal);
      }).catch(() => {});
    }, 5000);
    return () => { mounted = false; clearInterval(backupRefreshTimer); };
  }, []);

  // When app returns to foreground, refresh backup status
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        // Refresh backed up count from server
        api.apiCall('drive_backup_count').then(r => {
          const total = r?.data?.count || r?.data?.total || 0;
          if (total > 0) setBackedUpTotal(total);
        }).catch(() => {});
        // Auto-restart backup if enabled but stopped
        if (backupEnabled && backupStatus !== 'backing_up') {
          setTimeout(() => {
            if (backupStatus !== 'backing_up') {
              setBackupStatus('backing_up');
              startBackup();
            }
          }, 3000);
        }
      }
    });
    return () => sub?.remove();
  }, [backupStatus, loadCloudPhotos]);

  // Auto-start backup every time photos screen opens (if enabled)
  useEffect(() => {
    if (Platform.OS === 'web') return;
    // Wait for AsyncStorage to load backupEnabled
    const timer = setTimeout(async () => {
      const enabled = await AsyncStorage.getItem('backup_auto_enabled').catch(() => null);
      if (enabled === 'true' && backupStatus !== 'backing_up') {
        setBackupEnabled(true);
        setBackupStatus('backing_up');
        startBackup();
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  // Central cleanup on unmount: clear all persistent timers
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      cleanupBackupRefresh();
      if (scrubberTimer.current) clearTimeout(scrubberTimer.current);
      if (scrollDateTimer.current) clearTimeout(scrollDateTimer.current);
      if (mlSearchTimerRef.current) clearTimeout(mlSearchTimerRef.current);
      if (autoLoadTimerRef.current) clearTimeout(autoLoadTimerRef.current);
    };
  }, []);

  useEffect(() => {
    loadAlbums();
  }, [cloudPhotos, devicePhotos]);

  // Mark device photos that are already backed up
  useEffect(() => {
    if (devicePhotos.length > 0) {
      const cloudNames = new Set(cloudPhotos.map(p => p.name?.toLowerCase()));
      const backedUpCount = devicePhotos.filter(dp => cloudNames.has(dp.name?.toLowerCase())).length;
      setDevicePhotos(prev => prev.map(dp => ({
        ...dp,
        backedUp: cloudNames.has(dp.name?.toLowerCase()),
      })));
      // Calculate pending: use deviceTotalCount (from MediaLibrary) if available
      const totalOnDevice = deviceTotalCount || 0;
      const estimatedBackedUp = backedUpTotal || backedUpCount || 0;
      // If we don't know device total yet, try to get it now
      if (totalOnDevice === 0 && Platform.OS !== 'web') {
        try {
          const ML = require('expo-media-library');
          ML.getAssetsAsync({ mediaType: [ML.MediaType.photo, ML.MediaType.video], first: 1 })
            .then(r => { if (r?.totalCount > 0) setDeviceTotalCount(r.totalCount); })
            .catch(() => {});
        } catch {}
      }
      const pending = totalOnDevice > 0 ? Math.max(0, totalOnDevice - estimatedBackedUp) : 0;
      setPendingCount(pending);
      if (totalOnDevice > 0 && pending > 0 && backupStatus !== 'backing_up') {
        setBackupStatus('needs_backup');
        // Auto-start backup when there are pending photos (only once)
        if (pending > 0 && autoBackupMod?.startForegroundBackup && !autoStartedRef.current) {
          autoStartedRef.current = true;
          setTimeout(() => {
            if (backupStatus !== 'backing_up') {
              setBackupStatus('backing_up');
              startBackup();
            }
          }, 3000);
        }
      } else if (totalOnDevice > 0 && pending === 0 && estimatedBackedUp > 0 && backupStatus !== 'backing_up') {
        setBackupStatus('complete');
      }
      // If totalOnDevice still 0, don't set any status (wait for count to load)
    }
  }, [devicePhotos.length, cloudPhotos.length, backupEnabled, deviceTotalCount]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setPage(1);
    await Promise.all([loadCloudPhotos(1), loadStorageInfo(), loadDevicePhotos()]);
    setRefreshing(false);
  }, [loadCloudPhotos, loadStorageInfo, loadDevicePhotos]);

  const loadMore = useCallback(() => {
    // Load more cloud photos
    if (hasMore && !loadingMore && !loading) {
      const nextPage = page + 1;
      setPage(nextPage);
      loadCloudPhotos(nextPage, true);
    }
    // Load more device photos (infinite scroll)
    loadMoreDevicePhotos();
  }, [hasMore, loadingMore, loading, page, loadCloudPhotos, loadMoreDevicePhotos]);

  // ============================================================
  // COMBINED PHOTOS
  // ============================================================
  const allPhotos = useMemo(() => {
    if (Platform.OS === 'web') return cloudPhotos;
    // On mobile: show ONLY device photos (like Google Photos)
    // Cloud photos only shown on web or if no device photos
    if (devicePhotos.length > 0) return devicePhotos;
    return cloudPhotos;
  }, [cloudPhotos, devicePhotos]);

  // Memories: photos from same month in previous years (Google Photos "On this day")
  const memoriesData = useMemo(() => {
    if (allPhotos.length === 0) return [];
    try {
      const now = new Date();
      const currentMonth = now.getMonth();
      const currentYear = now.getFullYear();
      const groups = new Map();
      allPhotos.forEach(p => {
        try {
          const d = new Date(p.created_at || p.uploaded_at || p.modificationTime);
          if (!isNaN(d.getTime()) && d.getMonth() === currentMonth && d.getFullYear() < currentYear) {
            const yearsAgo = currentYear - d.getFullYear();
            if (!groups.has(yearsAgo)) groups.set(yearsAgo, { yearsAgo, photos: [] });
            groups.get(yearsAgo).photos.push(p);
          }
        } catch {}
      });
      return Array.from(groups.values()).sort((a, b) => a.yearsAgo - b.yearsAgo);
    } catch { return []; }
  }, [allPhotos]);

  // ML search results (from Claude Vision API)
  const [mlSearchResults, setMlSearchResults] = useState(null);
  const mlSearchTimerRef = useRef(null);

  // Trigger ML search when user types (debounced)
  useEffect(() => {
    if (!searchText.trim() || searchText.length < 2) {
      setMlSearchResults(null);
      return;
    }
    if (mlSearchTimerRef.current) clearTimeout(mlSearchTimerRef.current);
    mlSearchTimerRef.current = setTimeout(async () => {
      try {
        const res = await api.photoSearchML(searchText);
        if (res?.success && res.data?.files?.length > 0) {
          setMlSearchResults(res.data.files);
        } else {
          setMlSearchResults(null);
        }
      } catch { setMlSearchResults(null); }
    }, 600);
    return () => { if (mlSearchTimerRef.current) clearTimeout(mlSearchTimerRef.current); };
  }, [searchText]);

  const filteredPhotos = useMemo(() => {
    let photos = allPhotos;
    // Favorites filter
    if (showFavorites) {
      photos = photos.filter(p => p.starred);
    }
    // Search filter
    if (searchText.trim()) {
      const q = searchText.toLowerCase();
      const monthNames = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
      const monthNamesEn = ['january','february','march','april','may','june','july','august','september','october','november','december'];

      // Local search (name + date)
      const localMatches = photos.filter(p => {
        try {
          if (p.name?.toLowerCase().includes(q)) return true;
          // Search in ML tags if available
          if (p.photo_labels) {
            const labels = typeof p.photo_labels === 'string' ? JSON.parse(p.photo_labels) : p.photo_labels;
            if (labels?.tags?.some(t => t.toLowerCase().includes(q))) return true;
            if (labels?.objects?.some(o => o.toLowerCase().includes(q))) return true;
            if (labels?.scene?.toLowerCase().includes(q)) return true;
          }
          const d = new Date(p.created_at || p.uploaded_at || p.modificationTime);
          if (isNaN(d.getTime())) return false;
          if (q.match(/^\d{4}$/) && d.getFullYear().toString() === q) return true;
          const monthIdx = monthNames.findIndex(m => m.startsWith(q));
          const monthIdxEn = monthNamesEn.findIndex(m => m.startsWith(q));
          if ((monthIdx >= 0 && d.getMonth() === monthIdx) || (monthIdxEn >= 0 && d.getMonth() === monthIdxEn)) return true;
          return false;
        } catch { return false; }
      });

      // Merge with ML search results (if available)
      if (mlSearchResults) {
        const localIds = new Set(localMatches.map(p => p.id));
        const mlOnly = mlSearchResults.filter(p => !localIds.has(p.id));
        return [...localMatches, ...mlOnly];
      }
      return localMatches;
    }
    return photos;
  }, [allPhotos, searchText, showFavorites, mlSearchResults]);

  const groupedPhotos = useMemo(() => groupPhotosByDate(filteredPhotos, t), [filteredPhotos, t]);

  // ============================================================
  // SELECTION
  // ============================================================
  const toggleSelect = useCallback((id) => {
    setSelectedItems(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      if (next.size === 0) setSelectMode(false);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedItems(new Set());
    setSelectMode(false);
  }, []);

  const selectAll = useCallback(() => {
    setSelectedItems(new Set(filteredPhotos.map(p => p.id)));
    setSelectMode(true);
  }, [filteredPhotos]);

  const deleteSelected = useCallback(async () => {
    const ids = Array.from(selectedItems);
    safeAlert(
      t('photos.deleteSelected'),
      t('photos.deleteConfirm', { n: ids.length }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: async () => {
            for (const id of ids) {
              if (!id.startsWith('device_')) {
                try { await api.fileDelete(id); } catch {}
              }
            }
            clearSelection();
            loadCloudPhotos(1);
          },
        },
      ]
    );
  }, [selectedItems, t, clearSelection, loadCloudPhotos]);

  // ============================================================
  // BACKUP ACTIONS
  // ============================================================
  const startBackup = useCallback(async () => {
    if (Platform.OS === 'web') return;
    if (!autoBackupMod?.startForegroundBackup) {
      safeAlert('Backup', 'Módulo de backup não disponível. Atualize o app.');
      return;
    }

    backupAbortRef.current = false;
    setBackupStatus('backing_up');
    setBackupProgress({ current: 0, total: 0 });
    uploadSpeedRef.current = { bytes: 0, startTime: Date.now(), lastSpeed: 0 };

    // Live refresh: WS real-time backup progress + 30s fallback polling
    if (backupRefreshTimerRef.current) clearInterval(backupRefreshTimerRef.current);
    if (backupWsUnsubRef.current) { backupWsUnsubRef.current(); backupWsUnsubRef.current = null; }
    // WebSocket: instant backup progress updates from server
    backupWsUnsubRef.current = mailWs.on('backup_progress', (data) => {
      // WS backup_progress disabled - only drive_backup_count updates the counter
    });
    // Fallback polling at 10s — quick count refresh during backup
    let lastTotal = 0;
    let staleCount = 0;
    const refreshTimer = setInterval(() => {
      api.apiCall('drive_backup_count').then(r => {
        const t = r?.data?.count || r?.data?.total || 0;
        if (t > 0) {
          setBackedUpTotal(t);
          if (t === lastTotal) {
            staleCount++;
            // If count hasn't changed for 5 minutes (30 polls of 10s), backup is done
            if (staleCount >= 30) {
              clearInterval(refreshTimer);
              setBackupStatus('complete');
            }
          } else {
            staleCount = 0;
            lastTotal = t;
          }
        }
      }).catch(() => {});
    }, 10000);
    backupRefreshTimerRef.current = refreshTimer;

    try {
      // Run backup in LOOP until all photos are uploaded (like Google Photos)
      let totalUploaded = 0;
      for (let round = 0; round < 100; round++) { // max 100 rounds safety
        if (backupAbortRef.current) break;

        const result = await autoBackupMod.startForegroundBackup(({ current, total }) => {
          setBackupProgress({ current: totalUploaded + current, total: 43000 }); // estimate
        });

        const uploaded = result?.uploaded || result?.completedFiles || 0;
        totalUploaded += uploaded;

        // Stop conditions
        if (result?.error === 'permission_denied' || result?.error === 'web_unsupported') {
          break;
        }
        if (uploaded === 0) {
          // Nothing new uploaded this round — check if really done
          const checkRes = await api.apiCall("drive_backup_count").catch(() => null);
          const serverCount = checkRes?.data?.count || 0;
          if (serverCount > 0) setBackedUpTotal(serverCount);
          break; // done or stuck — either way, stop looping
        }

        // Brief pause between rounds
        await new Promise(r => setTimeout(r, 2000));
      }

      const result = { uploaded: totalUploaded };

      // wifi_required should never happen for manual backup — ignore completely
      if (result.error === 'wifi_required') {
        console.warn('[backup] Ignoring wifi_required for manual backup');
        // Don't block — just continue
      }
      if (result?.error === 'permission_denied') {
        safeAlert('Permissão', 'Permita acesso às fotos em Ajustes');
        clearInterval(refreshTimer);
        cleanupBackupRefresh();
        setBackupStatus('idle');
        return;
      }
      if (result.error === 'web_unsupported') {
        clearInterval(refreshTimer);
        cleanupBackupRefresh();
        setBackupStatus('idle');
        return;
      }
      if (result.error) {
        safeAlert('Erro no backup', result.error);
        clearInterval(refreshTimer);
        cleanupBackupRefresh();
        setBackupStatus('needs_backup');
        return;
      }
      if (result.alreadyComplete) {
        clearInterval(refreshTimer);
        cleanupBackupRefresh();
        setBackupStatus('complete');
        return;
      }
      if (false && result.alreadyComplete) {
        clearInterval(refreshTimer);
        cleanupBackupRefresh();
        safeAlert('Backup completo', `Todas as fotos já foram salvas!\n\n${result.backedUpCount} fotos no backup.`, [
          { text: 'OK' },
          { text: 'Refazer tudo', onPress: async () => {
            if (autoBackupMod?.resetBackupHistory) await autoBackupMod.resetBackupHistory();
            setBackedUpTotal(0);
            setDevicePhotos(prev => prev.map(p => ({ ...p, backedUp: false })));
            safeAlert('Histórico limpo', 'Clique em "Fazer backup" novamente');
          }},
        ]);
        setBackupStatus('complete');
        return;
      }

      // Backup finished - refresh count from server
      api.apiCall('drive_backup_count').then(r => {
        const t = r?.data?.count || r?.data?.total || 0;
        if (t > 0) setBackedUpTotal(t);
      }).catch(() => {});
      if (backupAbortRef.current) {
        clearInterval(refreshTimer);
        setBackupStatus('needs_backup');
      } else {
        // Always keep backing_up - uploads continue in background via NSURLSession
        // The refreshTimer keeps updating the count from server every 10s
        setBackupStatus('backing_up');
        if (result.uploaded > 0) setLastBackupDate(new Date().toISOString());
      }
    } catch (e) {
      console.warn('[backup] startBackup error:', e);
      clearInterval(refreshTimer);
      cleanupBackupRefresh();
      // Don't go to idle - background uploads may still be running
      setBackupStatus('backing_up');
    }
    // Final refresh
    api.apiCall('drive_backup_count').then(r => {
      const t = r?.data?.count || r?.data?.total || 0;
      if (t > 0) setBackedUpTotal(t);
    }).catch(() => {});
  }, [loadCloudPhotos]);

  const pauseBackup = useCallback(() => {
    backupAbortRef.current = true;
    if (autoBackupMod?.pause) autoBackupMod.pause();
    setBackupStatus('needs_backup');
  }, []);

  // Star/favorite toggle
  const toggleStar = useCallback(async (photo) => {
    if (photo.isDevice) return;
    try {
      await api.fileStar(photo.id);
      setCloudPhotos(prev => prev.map(p => p.id === photo.id ? { ...p, starred: !p.starred } : p));
      if (viewerVisible) setViewerStarred(v => !v);
    } catch {}
  }, [viewerVisible]);

  // Share photo
  const sharePhoto = useCallback(async (photo) => {
    if (!photo) return;
    try {
      if (photo.isDevice) {
        if (Platform.OS === 'web') return;
        await Share.share({ url: photo.uri, message: photo.name });
      } else {
        const url = api.fileDownloadUrl(photo.id);
        if (Platform.OS === 'web') {
          if (navigator.share) {
            await navigator.share({ title: photo.name, url });
          } else {
            await navigator.clipboard?.writeText(url);
            safeAlert(t('photos.linkCopied'), '');
          }
        } else {
          await Share.share({ url, message: photo.name });
        }
      }
    } catch {}
  }, [t]);

  // Download photo
  const downloadPhoto = useCallback(async (photo) => {
    if (!photo) return;
    try {
      if (Platform.OS === 'web') {
        const url = api.fileDownloadUrl(photo.id);
        Linking.openURL(url);
      } else {
        if (photo.isDevice) return; // Already on device
        const ML = require('expo-media-library');
        const { status } = await ML.requestPermissionsAsync();
        if (status !== 'granted') return;
        const url = api.fileDownloadUrl(photo.id);
        const FileSystem = require('expo-file-system');
        const download = await FileSystem.downloadAsync(url, FileSystem.cacheDirectory + photo.name);
        if (download.uri) {
          await ML.saveToLibraryAsync(download.uri);
          safeAlert(t('photos.savedToDevice'), '');
        }
      }
    } catch {}
  }, [t]);

  // Free up space - delete backed up photos from device
  const freeUpSpace = useCallback(async () => {
    if (Platform.OS === 'web') return;
    try {
      const saved = await AsyncStorage.getItem('backed_up_photos');
      if (!saved) return;
      const ids = JSON.parse(saved);
      const backedUpDevicePhotos = devicePhotos.filter(p => p.deviceId && ids[p.deviceId]);
      if (backedUpDevicePhotos.length === 0) {
        safeAlert('', 'Nenhuma foto para liberar');
        return;
      }
      const estimatedSize = backedUpDevicePhotos.length * 3 * 1024 * 1024; // ~3MB avg
      safeAlert(
        t('photos.freeUpSpace'),
        t('photos.freeUpSpaceConfirm', { n: backedUpDevicePhotos.length }),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('photos.freeUpSpace'),
            style: 'destructive',
            onPress: async () => {
              try {
                const ML = require('expo-media-library');
                const assetIds = backedUpDevicePhotos.map(p => p.deviceId);
                await ML.deleteAssetsAsync(assetIds);
                setDevicePhotos(prev => prev.filter(p => !p.deviceId || !ids[p.deviceId]));
                safeAlert('', t('photos.freeUpSpaceSuccess', { size: formatBytes(estimatedSize), n: assetIds.length }));
              } catch {}
            },
          },
        ]
      );
    } catch {}
  }, [devicePhotos, t]);

  // Photo restore from cloud
  const openPhotoRestore = useCallback(async () => {
    setPhotoRestoreModal(true);
    setPhotoRestoreLoading(true);
    setSelectedMonths(new Set());
    setPhotoRestoreProgress({ current: 0, total: 0 });
    try {
      const r = await api.drivePhotoSyncList(1, 1);
      if (r.success) {
        setCloudPhotoTotal(r.data?.total || 0);
        setCloudPhotoMonths(r.data?.months || []);
        // Select all months by default
        const allKeys = new Set((r.data?.months || []).map(m => m.month_key));
        setSelectedMonths(allKeys);
      }
    } catch {} finally {
      setPhotoRestoreLoading(false);
    }
  }, []);

  const toggleMonth = useCallback((monthKey) => {
    setSelectedMonths(prev => {
      const next = new Set(prev);
      if (next.has(monthKey)) next.delete(monthKey);
      else next.add(monthKey);
      return next;
    });
  }, []);

  const startPhotoRestore = useCallback(async () => {
    if (selectedMonths.size === 0) return;
    setPhotoRestoreRunning(true);
    const totalToDownload = cloudPhotoMonths
      .filter(m => selectedMonths.has(m.month_key))
      .reduce((sum, m) => sum + parseInt(m.count || 0), 0);
    setPhotoRestoreProgress({ current: 0, total: totalToDownload });

    let downloaded = 0;

    // Get MediaLibrary on native
    let ML = null;
    let FileSystem = null;
    if (Platform.OS !== 'web') {
      try {
        ML = require('expo-media-library');
        FileSystem = require('expo-file-system');
        const { status } = await ML.requestPermissionsAsync();
        if (status !== 'granted') {
          safeAlert('', t('photos.permissionRequired'));
          setPhotoRestoreRunning(false);
          return;
        }
      } catch {}
    }

    // Download in batches per selected month
    for (const monthKey of selectedMonths) {
      let page = 1;
      let hasMore = true;
      while (hasMore) {
        try {
          const r = await api.drivePhotoSyncList(page, 10, monthKey);
          if (!r.success || !r.data?.files?.length) { hasMore = false; break; }
          const files = r.data.files;

          // Download each file in this batch
          for (const file of files) {
            try {
              if (Platform.OS !== 'web' && ML && FileSystem) {
                // Native: download and save to gallery
                const downloadUrl = file.download_url || file.url;
                if (downloadUrl) {
                  const localUri = FileSystem.cacheDirectory + (file.name || `photo_${file.id}.jpg`);
                  await FileSystem.downloadAsync(downloadUrl, localUri);
                  await ML.createAssetAsync(localUri);
                  // Clean up cache
                  try { await FileSystem.deleteAsync(localUri, { idempotent: true }); } catch {}
                }
              } else if (Platform.OS === 'web') {
                // Web: trigger download via hidden link
                const downloadUrl = file.download_url || file.url;
                if (downloadUrl) {
                  const a = document.createElement('a');
                  a.href = downloadUrl;
                  a.download = file.name || `photo_${file.id}.jpg`;
                  a.style.display = 'none';
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  // Small delay to avoid browser download limits
                  await new Promise(r => setTimeout(r, 300));
                }
              }
            } catch {}
            downloaded++;
            setPhotoRestoreProgress({ current: downloaded, total: totalToDownload });
          }

          hasMore = page < (r.data.pages || 1);
          page++;
        } catch { hasMore = false; }
      }
    }

    setPhotoRestoreRunning(false);
    safeAlert(
      t('photos.restoreComplete') || 'Concluido!',
      (t('photos.restoreCompleteMsg') || '{n} fotos restauradas com sucesso').replace('{n}', downloaded)
    );
  }, [selectedMonths, cloudPhotoMonths, t]);

  // Create album
  const createAlbum = useCallback(async () => {
    if (!newAlbumName.trim()) return;
    try {
      await api.apiCall('drive_create_folder', { name: newAlbumName.trim(), parent_id: null }, 'POST');
      setCreateAlbumVisible(false);
      setNewAlbumName('');
      loadCloudPhotos(1);
    } catch {}
  }, [newAlbumName, loadCloudPhotos]);

  // Toggle info panel
  const toggleInfoPanel = useCallback(() => {
    if (showInfoPanel) {
      Animated.timing(infoPanelAnim, { toValue: 0, duration: 250, useNativeDriver: false }).start(() => setShowInfoPanel(false));
    } else {
      setShowInfoPanel(true);
      Animated.timing(infoPanelAnim, { toValue: 1, duration: 300, useNativeDriver: false }).start();
    }
  }, [showInfoPanel, infoPanelAnim]);

  const isPaidPlan = userPlan !== 'free';

  const toggleBackup = useCallback((val) => {
    setBackupEnabled(val);
    AsyncStorage.setItem('backup_auto_enabled', val ? 'true' : 'false').catch(() => {});
    // Start/stop global auto-backup listeners (MediaLibrary + AppState)
    if (autoBackupMod?.onBackupSettingChanged) {
      autoBackupMod.onBackupSettingChanged(val).catch(() => {});
    }
    if (val) {
      // Start backup immediately when enabled
      startBackup();
    } else {
      setBackupStatus('idle');
    }
  }, [startBackup]);

  // ============================================================
  // VIEWER
  // ============================================================
  // Must declare animation refs BEFORE callbacks that use them
  const viewerScaleAnim = useRef(new Animated.Value(0.85)).current;
  const viewerBgOpacity = useRef(new Animated.Value(0)).current;

  const openViewer = useCallback((index) => {
    setViewerIndex(index);
    setViewerStarred(!!filteredPhotos[index]?.starred);
    viewerScaleAnim.setValue(0.85);
    viewerBgOpacity.setValue(0);
    setViewerVisible(true);
    Animated.parallel([
      Animated.spring(viewerScaleAnim, { toValue: 1, friction: 8, tension: 65, useNativeDriver: false }),
      Animated.timing(viewerBgOpacity, { toValue: 1, duration: 250, useNativeDriver: false }),
    ]).start();
  }, [filteredPhotos, viewerScaleAnim, viewerBgOpacity]);

  const closeViewer = useCallback(() => {
    Animated.parallel([
      Animated.timing(viewerScaleAnim, { toValue: 0.85, duration: 220, useNativeDriver: false }),
      Animated.timing(viewerBgOpacity, { toValue: 0, duration: 220, useNativeDriver: false }),
    ]).start(() => {
      setViewerVisible(false);
    });
  }, [viewerScaleAnim, viewerBgOpacity]);

  const viewerPhoto = filteredPhotos[viewerIndex];

  const navigateViewer = useCallback((dir) => {
    const next = viewerIndex + dir;
    if (next >= 0 && next < filteredPhotos.length) {
      setViewerIndex(next);
      setViewerStarred(!!filteredPhotos[next]?.starred);
      setViewerResolvedUri(null); // reset so getFullUrl resolves new photo
    }
  }, [viewerIndex, filteredPhotos]);

  const deleteViewerPhoto = useCallback(async () => {
    if (!viewerPhoto) return;
    const isDevice = viewerPhoto.id?.startsWith('device_');
    const isCloud = !isDevice;

    const buttons = [{ text: t('common.cancel'), style: 'cancel' }];

    if (isCloud) {
      // Cloud photo - delete from our server
      buttons.push({
        text: 'Deletar da nuvem',
        style: 'destructive',
        onPress: async () => {
          try { await api.fileDelete(viewerPhoto.id); } catch {}
          closeViewer();
          loadCloudPhotos(1);
        },
      });
    } else if (isDevice && viewerPhoto.backedUp) {
      // Device photo that was backed up - offer to remove backup
      buttons.push({
        text: 'Remover do backup',
        style: 'destructive',
        onPress: async () => {
          // Remove from backed up tracking
          try {
            const saved = await AsyncStorage.getItem('backed_up_photos');
            if (saved) {
              const ids = JSON.parse(saved);
              delete ids[viewerPhoto.deviceId];
              await AsyncStorage.setItem('backed_up_photos', JSON.stringify(ids));
              // Don't set backedUpTotal from local - let server count be authoritative
              setDevicePhotos(prev => prev.map(p => p.id === viewerPhoto.id ? { ...p, backedUp: false } : p));
            }
          } catch {}
          closeViewer();
        },
      });
    }

    safeAlert(t('photos.deletePhoto'), t('photos.deletePhotoConfirm'), buttons);
  }, [viewerPhoto, t, closeViewer, loadCloudPhotos]);

  // ============================================================
  // THUMBNAIL URL
  // ============================================================
  // Cache for resolved ph:// URIs
  const resolvedUriCache = useRef({});

  const getThumbnailUrl = useCallback((photo) => {
    if (!photo.isDevice) {
      // Use CDN URL (R2 global cache) — fastest, works for JPG/PNG
      if (photo.cdn_url) return photo.cdn_url;
      if (photo.thumbnail_url) {
        const base = photo.thumbnail_url.startsWith('http') ? '' : api.BASE_URL;
        return base + photo.thumbnail_url;
      }
      return api.fileDownloadUrl(photo.id);
    }
    return photo.uri;
  }, []);

  const [viewerResolvedUri, setViewerResolvedUri] = useState(null);

  const getFullUrl = useCallback((photo) => {
    if (!photo.isDevice) return photo.cdn_url || api.fileDownloadUrl(photo.id);
    // For device photos, resolve localUri for the viewer
    if (Platform.OS === 'ios' && photo.uri?.startsWith('ph://')) {
      const assetId = photo.uri.replace('ph://', '').split('/')[0];
      const ML = require('expo-media-library');
      ML.getAssetInfoAsync(assetId).then(info => {
        const localUri = (info?.localUri || '').split('#')[0];
        if (localUri) setViewerResolvedUri(localUri);
      }).catch(() => {});
      return photo.thumbUri || photo.uri; // show thumbnail while resolving
    }
    return photo.uri;
  }, []);

  // ============================================================
  // GRID SIZE
  // ============================================================
  const gridItemSize = useMemo(() => {
    const gap = 2;
    return (width - gap * (gridColumns + 1)) / gridColumns;
  }, [width, gridColumns]);

  const cycleGridColumns = useCallback(() => {
    const options = isDesktop ? [4, 5, 6] : [3, 4, 5];
    const idx = options.indexOf(gridColumns);
    setGridColumns(options[(idx + 1) % options.length]);
  }, [gridColumns, isDesktop]);

  // ============================================================
  // BACKUP BANNER
  // ============================================================
  const renderBackupBanner = () => {
    if (Platform.OS === 'web') return null;

    // Show error if media library not available
    if (photoError) {
      return (
        <View style={[s.backupBanner, { backgroundColor: isDark ? '#451a03' : '#fef2f2', borderColor: '#ef4444' + '40' }]}>
          <View style={s.backupBannerLeft}>
            <View style={{ marginLeft: 10, flex: 1 }}>
              <Text style={[s.backupBannerTitle, { color: '#ef4444' }]}>Backup indisponível</Text>
              <Text style={[s.backupBannerSub, { color: colors.textSecondary }]}>{photoError}</Text>
            </View>
          </View>
        </View>
      );
    }

    const storageText = storageInfo
      ? `${formatGB(storageInfo.total_used || storageInfo.used_bytes || 0)} GB ${t('photos.of')} ${formatGB(storageInfo.quota || storageInfo.plan_quota || 15 * 1024 * 1024 * 1024)} GB`
      : '';

    if (!backupEnabled) {
      return (
        <View style={[s.backupBanner, { backgroundColor: isDark ? '#1e293b' : '#f8fafc', borderColor: colors.border }]}>
          <View style={s.backupBannerLeft}>
            <IconCloudOff size={20} color={colors.textSecondary} />
            <View style={{ marginLeft: 10, flex: 1 }}>
              <Text style={[s.backupBannerTitle, { color: colors.text }]}>{t('photos.backupOff')}</Text>
              {storageText ? <Text style={[s.backupBannerSub, { color: colors.textSecondary }]}>{storageText}</Text> : null}
            </View>
          </View>
          <TouchableOpacity
            style={[s.backupBtn, { backgroundColor: colors.primary }]}
            onPress={() => toggleBackup(true)}
          >
            <Text style={s.backupBtnText}>{t('photos.enable')}</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (backupStatus === 'backing_up') {
      const deviceCount = deviceTotalCount || devicePhotos.length;
      const pct = deviceCount > 0 ? Math.min((backedUpTotal / deviceCount) * 100, 100) : 0;
      return (
        <View style={[s.backupBanner, { backgroundColor: isDark ? '#172554' : '#eff6ff', borderColor: colors.primary + '40' }]}>
          <View style={s.backupBannerLeft}>
            <IconCloudUpload size={20} color={colors.primary} />
            <View style={{ marginLeft: 10, flex: 1 }}>
              <Text style={[s.backupBannerTitle, { color: colors.text }]}>
                {backedUpTotal} de {deviceCount} fotos salvas
              </Text>
              <View style={[s.progressBar, { backgroundColor: colors.border }]}>
                <View style={[s.progressFill, { width: `${pct}%`, backgroundColor: colors.primary }]} />
              </View>
            </View>
          </View>
          <TouchableOpacity onPress={pauseBackup} style={{ padding: 8 }}>
            <IconPause size={20} color={colors.primary} />
          </TouchableOpacity>
        </View>
      );
    }

    if (backupStatus === 'complete') {
      return (
        <View style={[s.backupBanner, { backgroundColor: isDark ? '#052e16' : '#f0fdf4', borderColor: isDark ? '#16a34a40' : '#bbf7d040' }]}>
          <View style={s.backupBannerLeft}>
            <IconCloudCheck size={20} color={colors.success || '#16a34a'} />
            <View style={{ marginLeft: 10, flex: 1 }}>
              <Text style={[s.backupBannerTitle, { color: colors.success || '#16a34a' }]}>{t('photos.backupComplete')}</Text>
              {storageText ? <Text style={[s.backupBannerSub, { color: colors.textSecondary }]}>{storageText}</Text> : null}
            </View>
          </View>
        </View>
      );
    }

    if (backupStatus === 'needs_backup' || backupStatus === 'idle') {
      // NEVER show complete unless we know real device count
      const deviceCount = deviceTotalCount; // 0 = not loaded yet
      if (deviceCount === 0) {
        // Still loading device count — show "checking..."
        return (
          <View style={[s.backupBanner, { backgroundColor: isDark ? '#172554' : '#eff6ff', borderColor: colors.primary + '40' }]}>
            <View style={s.backupBannerLeft}>
              <ActivityIndicator size="small" color={colors.primary} />
              <View style={{ marginLeft: 10, flex: 1 }}>
                <Text style={[s.backupBannerTitle, { color: colors.text }]}>Verificando fotos...</Text>
              </View>
            </View>
          </View>
        );
      }
      const pending = Math.max(0, deviceCount - backedUpTotal);
      if (pending <= 0 && backedUpTotal > 0) {
        // All backed up - show complete
        return (
          <View style={[s.backupBanner, { backgroundColor: isDark ? '#052e16' : '#f0fdf4', borderColor: isDark ? '#16a34a40' : '#bbf7d040' }]}>
            <View style={s.backupBannerLeft}>
              <IconCloudCheck size={20} color={colors.success || '#16a34a'} />
              <View style={{ marginLeft: 10, flex: 1 }}>
                <Text style={[s.backupBannerTitle, { color: colors.success || '#16a34a' }]}>{backedUpTotal} fotos salvas na nuvem</Text>
                {storageText ? <Text style={[s.backupBannerSub, { color: colors.textSecondary }]}>{storageText}</Text> : null}
              </View>
            </View>
          </View>
        );
      }
      // Has pending photos - show progress with start button
      return (
        <View style={[s.backupBanner, { backgroundColor: isDark ? '#172554' : '#eff6ff', borderColor: colors.primary + '40' }]}>
          <View style={s.backupBannerLeft}>
            <IconCloudUpload size={20} color={colors.primary} />
            <View style={{ marginLeft: 10, flex: 1 }}>
              <Text style={[s.backupBannerTitle, { color: colors.text }]}>
                {backedUpTotal} de {deviceCount} fotos salvas
              </Text>
              {storageText ? <Text style={[s.backupBannerSub, { color: colors.textSecondary }]}>{storageText}</Text> : null}
            </View>
          </View>
          <TouchableOpacity
            style={[s.backupBtn, { backgroundColor: colors.primary }]}
            onPress={startBackup}
          >
            <Text style={s.backupBtnText}>{t('photos.startBackup')}</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return null;
  };

  // ============================================================
  // PHOTO GRID ITEM
  // ============================================================

  // Timeline scrubber state
  const sectionListRef = useRef(null);
  const [scrollDateLabel, setScrollDateLabel] = useState('');
  const scrollDateOpacity = useRef(new Animated.Value(0)).current;
  const scrollDateTimer = useRef(null);
  const [scrubberVisible, setScrubberVisible] = useState(false);
  const scrubberOpacity = useRef(new Animated.Value(0)).current;
  const scrubberTimer = useRef(null);
  const [scrollPercent, setScrollPercent] = useState(0);
  const scrollContentHeight = useRef(0);
  const scrollViewHeight = useRef(0);

  // Pinch to zoom state
  const pinchRef = useRef({ active: false, startDist: 0, startCols: gridColumns });

  // Tab indicator animation
  const tabIndicatorLeft = useRef(new Animated.Value(0)).current;
  const tabWidthRef = useRef(0);

  // FAB state
  const [fabOpen, setFabOpen] = useState(false);
  const fabRotateAnim = useRef(new Animated.Value(0)).current;

  // Thumbnails: 200x200 JPEG cached to disk via thumbnailCache service
  // Grid shows cached file:// thumbUri (instant) or ph:// uri as fallback

  // Memoized PhotoGridItem
  const PhotoGridItem = React.memo(({ photo, index, isSelected, selectMode: sm, gridItemSize: gis, onPress, onLongPress, primaryColor }) => {
    const isVideoItem = isVideo(photo);

    // Use cached thumbnail (file://) if available, then ph:// URI, then cloud thumbnail
    const imageUri = (photo.isDevice && photo.thumbUri) ? photo.thumbUri
      : (photo.isDevice ? photo.uri : getThumbnailUrl(photo));

    return (
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        style={[
          s.gridItem,
          { width: gis, height: gis, borderRadius: 2 },
          isSelected && { borderWidth: 3, borderColor: primaryColor },
        ]}
      >
        <View style={{ flex: 1, backgroundColor: '#e5e7eb' }}>
          <View style={{ flex: 1 }}>
            {Platform.OS === 'web' ? (
              <Image
                source={{ uri: imageUri }}
                style={s.gridImage}
                resizeMode="cover"
              />
            ) : photo.thumbUri ? (
              <Image
                source={{ uri: photo.thumbUri }}
                style={s.gridImage}
                resizeMode="cover"
              />
            ) : (
              <ExpoImage
                source={{ uri: imageUri }}
                style={s.gridImage}
                contentFit="cover"
                cachePolicy="memory-disk"
                recyclingKey={photo.id}
              />
            )}
          </View>
        </View>

        {/* Video duration overlay */}
        {isVideoItem && (
          <View style={s.videoDuration}>
            <IconPlay size={10} color="#fff" />
            <Text style={s.videoDurationText}>
              {formatDuration(photo.duration)}
            </Text>
          </View>
        )}

        {/* Backup status indicator */}
        {photo.isDevice && (
          <View style={s.backupIndicator}>
            {photo.backedUp ? (
              <IconCloudCheck size={14} color="#16a34a" />
            ) : (
              <IconCloudOff size={14} color="#94a3b8" />
            )}
          </View>
        )}

        {/* Selection checkmark */}
        {sm && (
          <View style={[
            s.selectCircle,
            isSelected && { backgroundColor: primaryColor, borderColor: primaryColor },
          ]}>
            {isSelected && <IconCheck size={14} color="#fff" />}
          </View>
        )}
      </Pressable>
    );
  });

  const renderPhotoItem = useCallback(({ item: photo, index }) => {
    const isSelected = selectedItems.has(photo.id);

    return (
      <PhotoGridItem
        photo={photo}
        index={index}
        isSelected={isSelected}
        selectMode={selectMode}
        gridItemSize={gridItemSize}
        primaryColor={colors.primary}
        onPress={() => {
          if (selectMode) {
            toggleSelect(photo.id);
          } else {
            openViewer(index);
          }
        }}
        onLongPress={() => {
          if (!selectMode) {
            setSelectMode(true);
            toggleSelect(photo.id);
          }
        }}
      />
    );
  }, [selectMode, selectedItems, gridItemSize, colors, toggleSelect, openViewer, getThumbnailUrl]);

  // ============================================================
  // SECTION HEADER
  // ============================================================
  const renderSectionHeader = useCallback(({ section }) => (
    <View style={[s.sectionHeader, { backgroundColor: colors.background }]}>
      <Text style={[s.sectionTitle, { color: colors.text }]}>{section.title}</Text>
      <Text style={[s.sectionCount, { color: colors.textSecondary }]}>
        {t('photos.photoCount', { n: section.data[0]?.items?.length || section.data.length })}
      </Text>
    </View>
  ), [colors, t]);

  // ============================================================
  // PHOTOS TAB
  // ============================================================
  const renderPhotosTab = () => {
    if (loading && cloudPhotos.length === 0) {
      return <GridSkeleton count={12} columns={3} />;
    }

    if (filteredPhotos.length === 0 && !showFavorites) {
      return (
        <View style={s.emptyState}>
          <View style={s.emptyIllustration}>
            <View style={[s.emptyCircleOuter, { borderColor: isDark ? 'rgba(99,102,241,0.15)' : 'rgba(99,102,241,0.1)' }]}>
              <View style={[s.emptyCircleInner, { backgroundColor: isDark ? 'rgba(99,102,241,0.12)' : 'rgba(99,102,241,0.08)' }]}>
                <IconImage size={48} color={isDark ? '#818cf8' : '#6366f1'} />
              </View>
            </View>
          </View>
          <Text style={[s.emptyTitle, { color: colors.text }]}>{t('photos.noPhotos')}</Text>
          <Text style={[s.emptySubtitle, { color: colors.textSecondary }]}>{t('photos.noPhotosDesc')}</Text>
          {Platform.OS !== 'web' && (
            <TouchableOpacity
              onPress={() => { /* could trigger photo picker */ }}
              style={[s.emptyUploadBtn, { backgroundColor: colors.primary }]}
            >
              <IconCloudUpload size={18} color="#fff" />
              <Text style={s.emptyUploadBtnText}>{t('photos.uploadFirst') || 'Upload photos'}</Text>
            </TouchableOpacity>
          )}
        </View>
      );
    }

    // Convert grouped into section list format — chunk into rows for proper virtualization
    // Each row is a separate SectionList item, so rows outside viewport are unmounted
    const sections = groupedPhotos.map(g => {
      const rows = [];
      for (let i = 0; i < g.data.length; i += gridColumns) {
        rows.push({ items: g.data.slice(i, i + gridColumns), rowIndex: i });
      }
      return { title: g.title, data: rows };
    });

    const handleScroll = (e) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      scrollContentHeight.current = contentSize.height;
      scrollViewHeight.current = layoutMeasurement.height;
      const maxScroll = contentSize.height - layoutMeasurement.height;
      if (maxScroll > 0) {
        setScrollPercent(contentOffset.y / maxScroll);
      }

      // Show scrubber while scrolling
      Animated.timing(scrubberOpacity, { toValue: 1, duration: 150, useNativeDriver: false }).start();
      if (scrubberTimer.current) clearTimeout(scrubberTimer.current);
      scrubberTimer.current = setTimeout(() => {
        Animated.timing(scrubberOpacity, { toValue: 0, duration: 600, useNativeDriver: false }).start();
      }, 1200);

      // Determine which section is visible for floating date label
      const scrollY = contentOffset.y;
      let accumH = 0;
      for (const sec of sections) {
        const sectionH = 40 + ((sec.data?.length || 0) * (gridItemSize + 2));
        if (accumH + sectionH > scrollY) {
          if (scrollDateLabel !== sec.title) setScrollDateLabel(sec.title);
          break;
        }
        accumH += sectionH;
      }

      // Show/hide floating date label
      Animated.timing(scrollDateOpacity, { toValue: 1, duration: 100, useNativeDriver: false }).start();
      if (scrollDateTimer.current) clearTimeout(scrollDateTimer.current);
      scrollDateTimer.current = setTimeout(() => {
        Animated.timing(scrollDateOpacity, { toValue: 0, duration: 400, useNativeDriver: false }).start();
      }, 1000);
    };

    // Pinch-to-zoom handlers
    const handleTouchStart = (e) => {
      if (e.nativeEvent.touches.length === 2) {
        const t1 = e.nativeEvent.touches[0];
        const t2 = e.nativeEvent.touches[1];
        const dist = Math.hypot(t2.pageX - t1.pageX, t2.pageY - t1.pageY);
        pinchRef.current = { active: true, startDist: dist, startCols: gridColumns };
      }
    };
    const handleTouchMove = (e) => {
      if (!pinchRef.current.active || e.nativeEvent.touches.length !== 2) return;
      const t1 = e.nativeEvent.touches[0];
      const t2 = e.nativeEvent.touches[1];
      const dist = Math.hypot(t2.pageX - t1.pageX, t2.pageY - t1.pageY);
      const diff = dist - pinchRef.current.startDist;
      const options = isDesktop ? [3, 4, 5, 6, 7] : [2, 3, 4, 5];
      const startIdx = options.indexOf(pinchRef.current.startCols);
      const threshold = 50;
      if (diff > threshold && startIdx > 0) {
        // Pinch out = fewer columns (bigger thumbs)
        setGridColumns(options[startIdx - 1]);
        pinchRef.current.startDist = dist;
        pinchRef.current.startCols = options[startIdx - 1];
      } else if (diff < -threshold && startIdx < options.length - 1) {
        // Pinch in = more columns (smaller thumbs)
        setGridColumns(options[startIdx + 1]);
        pinchRef.current.startDist = dist;
        pinchRef.current.startCols = options[startIdx + 1];
      }
    };
    const handleTouchEnd = () => {
      pinchRef.current.active = false;
    };

    return (
      <View style={{ flex: 1 }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <SectionList
          ref={sectionListRef}
          sections={sections}
          keyExtractor={(item, idx) => `row-${item.rowIndex}-${idx}`}
          renderSectionHeader={renderSectionHeader}
          renderItem={({ item }) => (
            <View style={s.gridRow}>
              {item.items.map((photo) => {
                const absIdx = filteredPhotos.indexOf(photo);
                return (
                  <React.Fragment key={photo.id}>
                    {renderPhotoItem({ item: photo, index: absIdx })}
                  </React.Fragment>
                );
              })}
            </View>
          )}
          stickySectionHeadersEnabled
          onScroll={handleScroll}
          scrollEventThrottle={16}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          ListHeaderComponent={
            <View>
              {renderBackupBanner()}
              {/* Memories (Google Photos "On this day") — plain Views, no nested FlatList */}
              {memoriesData.length > 0 && !searchText && !showFavorites && (
                <View style={{ marginTop: 8 }}>
                  <Text style={[s.sectionTitle, { color: colors.text, paddingHorizontal: Spacing.lg, marginBottom: 8 }]}>{t('photos.memories')}</Text>
                  <View style={{ flexDirection: 'row', paddingHorizontal: Spacing.md, overflow: 'hidden' }}>
                    {memoriesData.slice(0, 5).map(mem => (
                      <View key={mem.yearsAgo} style={[s.memoryCard, { backgroundColor: colors.surface, borderColor: colors.border, marginRight: 10 }]}>
                        {mem.photos[0] && (
                          mem.photos[0].isDevice && Platform.OS === 'ios'
                            ? <Image source={{ uri: mem.photos[0].uri }} style={s.memoryCover} resizeMode="cover" />
                            : <Image source={{ uri: getThumbnailUrl(mem.photos[0]) }} style={s.memoryCover} resizeMode="cover" />
                        )}
                        <Text style={[s.memoryLabel, { color: colors.text }]}>
                          {mem.yearsAgo === 1 ? t('photos.yearsAgo', { n: 1 }) : t('photos.yearsAgoPlural', { n: mem.yearsAgo })}
                        </Text>
                        <Text style={[s.memoryCount, { color: colors.textSecondary }]}>{mem.photos.length} {t('photos.items')}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              )}
            </View>
          }
          ListFooterComponent={loadingMore ? (
            <View style={{ padding: 20 }}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : null}
          contentContainerStyle={{ paddingBottom: 80 + insets.bottom }}
        />

        {/* Floating date label (Google Photos style) */}
        <Animated.View style={[s.floatingDateLabel, { opacity: scrollDateOpacity, backgroundColor: isDark ? 'rgba(50,50,60,0.92)' : 'rgba(255,255,255,0.95)' }]} pointerEvents="none">
          <Text style={[s.floatingDateText, { color: colors.text }]}>{scrollDateLabel}</Text>
        </Animated.View>

        {/* Timeline scrubber (right side) */}
        <Animated.View style={[s.timelineScrubber, { opacity: scrubberOpacity }]} pointerEvents="none">
          <View style={[s.scrubberTrack, { backgroundColor: isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.18)' }]}>
            <View style={[s.scrubberThumb, { backgroundColor: colors.primary, top: `${Math.min(scrollPercent * 100, 95)}%` }]} />
          </View>
        </Animated.View>
      </View>
    );
  };

  // ============================================================
  // ALBUMS TAB
  // ============================================================
  const renderAlbumsTab = () => {
    if (albums.length === 0) {
      return (
        <View style={s.emptyState}>
          {loading ? (
            <GridSkeleton count={6} columns={3} />
          ) : (
            <>
              <IconAlbum size={64} color={colors.textTertiary} />
              <Text style={[s.emptyTitle, { color: colors.text }]}>{t('photos.noAlbums')}</Text>
            </>
          )}
        </View>
      );
    }

    const albumSize = isDesktop ? (width - 60) / 4 : (width - 36) / 2;

    return (
      <FlatList
        data={[{ isCreateButton: true }, ...albums]}
        numColumns={isDesktop ? 4 : 2}
        key={isDesktop ? 'albums-4' : 'albums-2'}
        keyExtractor={(item, idx) => item.isCreateButton ? 'create' : `album-${item.name || idx}`}
        contentContainerStyle={{ padding: Spacing.md, paddingBottom: 80 + insets.bottom }}
        maxToRenderPerBatch={8}
        windowSize={10}
        initialNumToRender={12}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
        renderItem={({ item: album }) => {
          if (album.isCreateButton) {
            return (
              <TouchableOpacity
                style={[s.albumCard, { width: albumSize, backgroundColor: colors.surface, borderColor: colors.border }]}
                onPress={() => setCreateAlbumVisible(true)}
              >
                <View style={[s.albumCoverPlaceholder, { height: albumSize - 16, backgroundColor: colors.surfaceVariant }]}>
                  <Text style={{ fontSize: 32, color: colors.primary, fontWeight: '300' }}>+</Text>
                </View>
                <View style={s.albumInfo}>
                  <Text style={[s.albumName, { color: colors.primary }]}>{t('photos.createAlbum')}</Text>
                </View>
              </TouchableOpacity>
            );
          }
          return (
          <TouchableOpacity
            style={[s.albumCard, { width: albumSize, backgroundColor: colors.surface, borderColor: colors.border }]}
            onPress={() => openAlbum(album)}
            activeOpacity={0.7}
          >
            {album.cover ? (
              <Image
                source={{ uri: album.cover.isDevice ? album.cover.uri : getThumbnailUrl(album.cover) }}
                style={[s.albumCover, { height: albumSize - 16, backgroundColor: colors.surfaceVariant || '#f1f5f9' }]}
                resizeMode="cover"
                defaultSource={undefined}
                onError={() => {}}
              />
            ) : (
              <View style={[s.albumCoverPlaceholder, { height: albumSize - 16, backgroundColor: colors.surfaceVariant || '#f1f5f9' }]}>
                <IconImage size={32} color={colors.textTertiary || '#94a3b8'} />
              </View>
            )}
            <View style={s.albumInfo}>
              <Text style={[s.albumName, { color: colors.text }]} numberOfLines={1}>{album.name}</Text>
              <Text style={[s.albumCount, { color: colors.textSecondary }]}>
                {album.count || album.photos.length} {t('photos.items')}
              </Text>
            </View>
          </TouchableOpacity>
          );
        }}
      />
    );
  };

  // ============================================================
  // SEARCH TAB (Google Photos ML search)
  // ============================================================
  const [suggestedTags, setSuggestedTags] = useState([]);
  const [faceClusters, setFaceClusters] = useState([]);
  const [searchTabQuery, setSearchTabQuery] = useState('');
  const [searchTabResults, setSearchTabResults] = useState([]);
  const [searchTabLoading, setSearchTabLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

  // Load suggestions and faces when search tab is opened
  useEffect(() => {
    if (activeTab !== 'search') return;
    api.photoSuggestTags().then(res => {
      if (res?.success && res.data) setSuggestedTags(res.data.tags || res.data || []);
    }).catch(() => {});
    api.photoFaces().then(res => {
      if (res?.success && res.data) setFaceClusters(res.data.clusters || res.data || []);
    }).catch(() => {});
  }, [activeTab]);

  const doMLSearch = useCallback(async (query) => {
    if (!query.trim()) { setSearchTabResults([]); return; }
    setSearchTabLoading(true);
    try {
      const res = await api.photoSearchML(query);
      setSearchTabResults(res?.success ? (res.data?.files || []) : []);
    } catch { setSearchTabResults([]); }
    setSearchTabLoading(false);
  }, []);

  const startAnalysis = useCallback(async () => {
    setAnalyzing(true);
    try {
      const res = await api.photoAnalyzeBatch(50);
      if (res?.success) {
        const d = res.data || {};
        safeAlert('Analise ML', `${d.analyzed || 0} fotos analisadas!\n${d.remaining || 0} restantes.`);
      }
    } catch {}
    setAnalyzing(false);
  }, []);

  const renderSearchTab = () => (
    <FlatList
      data={[1]}
      keyExtractor={() => 'search-content'}
      contentContainerStyle={{ paddingBottom: 80 + insets.bottom }}
      renderItem={() => (
        <View style={{ padding: Spacing.lg }}>
          {/* ML Search bar */}
          <View style={[s.card, { backgroundColor: colors.surface, borderColor: colors.border, padding: 0, overflow: 'hidden' }]}>
            <TextInput
              style={{ padding: 14, fontSize: 15, color: colors.text }}
              placeholder='Buscar por "cachorro", "praia", "festa"...'
              placeholderTextColor={colors.textTertiary}
              value={searchTabQuery}
              onChangeText={setSearchTabQuery}
              onSubmitEditing={() => doMLSearch(searchTabQuery)}
              returnKeyType="search"
            />
          </View>

          {/* Search results */}
          {searchTabLoading && (
            <View style={{ padding: 20, alignItems: 'center' }}>
              <ActivityIndicator color={colors.primary} />
            </View>
          )}
          {searchTabResults.length > 0 && (
            <View style={{ marginTop: Spacing.md }}>
              <Text style={[s.cardTitle, { color: colors.text, marginBottom: 8 }]}>
                {searchTabResults.length} resultados
              </Text>
              <View style={s.gridRow}>
                {searchTabResults.map((photo, idx) => (
                  <React.Fragment key={photo.id}>
                    {renderPhotoItem({ item: photo, index: idx })}
                  </React.Fragment>
                ))}
              </View>
            </View>
          )}

          {/* Faces section */}
          {faceClusters.length > 0 && !searchTabQuery && (
            <View style={{ marginTop: Spacing.lg }}>
              <Text style={[s.cardTitle, { color: colors.text, marginBottom: 12 }]}>Pessoas</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
                {faceClusters.map((cluster, idx) => (
                  <TouchableOpacity key={idx} style={{ alignItems: 'center', width: 80 }}
                    onPress={() => { setSearchTabQuery(cluster.label || 'pessoa'); doMLSearch(cluster.label || 'pessoa'); }}>
                    {cluster.cover ? (
                      <Image source={{ uri: api.fileDownloadUrl(cluster.cover.id) }} style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: '#1a1a2e' }} />
                    ) : (
                      <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: colors.surfaceVariant, alignItems: 'center', justifyContent: 'center' }}>
                        <IconImage size={24} color={colors.textTertiary} />
                      </View>
                    )}
                    <Text style={{ color: colors.text, fontSize: 11, marginTop: 4, textAlign: 'center' }} numberOfLines={1}>
                      {cluster.label || `Pessoa ${idx + 1}`}
                    </Text>
                    <Text style={{ color: colors.textSecondary, fontSize: 10 }}>{cluster.count} fotos</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          {/* Tag suggestions */}
          {suggestedTags.length > 0 && !searchTabQuery && (
            <View style={{ marginTop: Spacing.lg }}>
              <Text style={[s.cardTitle, { color: colors.text, marginBottom: 12 }]}>Explorar</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {suggestedTags.slice(0, 20).map((tag, idx) => (
                  <TouchableOpacity key={idx}
                    style={[s.filterChip, { backgroundColor: colors.surfaceVariant }]}
                    onPress={() => { setSearchTabQuery(tag.tag || tag); doMLSearch(tag.tag || tag); }}
                  >
                    <Text style={[s.filterChipText, { color: colors.text }]}>{tag.tag || tag}</Text>
                    {tag.count && <Text style={{ color: colors.textSecondary, fontSize: 10, marginLeft: 4 }}>{tag.count}</Text>}
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          {/* Analyze button */}
          <View style={[s.card, { backgroundColor: colors.surface, borderColor: colors.border, marginTop: Spacing.lg }]}>
            <View style={s.cardHeader}>
              <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={colors.primary} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <SvgCircle cx="11" cy="11" r="8" />
                <Line x1="21" y1="21" x2="16.65" y2="16.65" />
              </Svg>
              <Text style={[s.cardTitle, { color: colors.text }]}>Inteligencia Artificial</Text>
            </View>
            <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 12 }}>
              Analisa suas fotos com IA para busca por conteudo (pessoas, objetos, cenas, cores)
            </Text>
            <TouchableOpacity
              style={[s.backupBtn, { backgroundColor: colors.primary, alignSelf: 'flex-start', opacity: analyzing ? 0.6 : 1 }]}
              onPress={startAnalysis}
              disabled={analyzing}
            >
              {analyzing ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={s.backupBtnText}>Analisar fotos</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}
    />
  );

  // ============================================================
  // BACKUP TAB
  // ============================================================
  const renderBackupTab = () => {
    const deviceCount = deviceTotalCount || devicePhotos.length; // total on phone (from MediaLibrary)
    const backedUpCount = backedUpTotal; // confirmed on server
    const totalPhotos = deviceCount; // total on phone
    const pendingPhotos = Math.max(0, deviceCount - backedUpCount);

    return (
      <FlatList
        data={[1]} // single item to enable pull-to-refresh
        keyExtractor={() => 'backup-content'}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
        contentContainerStyle={{ paddingBottom: 80 + insets.bottom }}
        renderItem={() => (
          <View style={{ padding: Spacing.lg }}>
            {/* Backup progress banner */}
            {backupStatus === 'backing_up' && (
              <View style={[s.card, { backgroundColor: isDark ? '#172554' : '#eff6ff', borderColor: colors.primary + '40', marginBottom: Spacing.md }]}>
                <View style={{ padding: 16 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <ActivityIndicator size="small" color={colors.primary} />
                    <Text style={{ color: colors.text, fontWeight: '600', fontSize: 15 }}>
                      {backedUpTotal} de {deviceTotalCount || devicePhotos.length} fotos salvas
                    </Text>
                  </View>
                  <View style={[s.progressBar, { backgroundColor: colors.border }]}>
                    <View style={[s.progressFill, { width: `${(deviceTotalCount || devicePhotos.length) > 0 ? Math.min((backedUpTotal / (deviceTotalCount || devicePhotos.length)) * 100, 100) : 0}%`, backgroundColor: colors.primary }]} />
                  </View>
                </View>
              </View>
            )}
            {backupStatus === 'complete' && (
              <View style={[s.card, { backgroundColor: isDark ? '#052e16' : '#f0fdf4', borderColor: '#22c55e40', marginBottom: Spacing.md }]}>
                <View style={{ padding: 16, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <IconCheck size={20} color="#22c55e" />
                  <Text style={{ color: '#22c55e', fontWeight: '600' }}>Backup completo!</Text>
                </View>
              </View>
            )}

            {/* Status card */}
            <View style={[s.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={s.cardHeader}>
                <IconCloud size={24} color={colors.primary} />
                <Text style={[s.cardTitle, { color: colors.text }]}>{t('photos.backupStatus')}</Text>
              </View>

              <View style={s.statsGrid}>
                <View style={s.statItem}>
                  <Text style={[s.statValue, { color: colors.text }]}>{totalPhotos}</Text>
                  <Text style={[s.statLabel, { color: colors.textSecondary }]}>{t('photos.totalPhotos')}</Text>
                </View>
                <View style={s.statItem}>
                  <Text style={[s.statValue, { color: colors.success || '#16a34a' }]}>{backedUpCount}</Text>
                  <Text style={[s.statLabel, { color: colors.textSecondary }]}>{t('photos.backedUp')}</Text>
                </View>
                <View style={s.statItem}>
                  <Text style={[s.statValue, { color: pendingPhotos > 0 ? (colors.warning || '#d97706') : colors.text }]}>{pendingPhotos}</Text>
                  <Text style={[s.statLabel, { color: colors.textSecondary }]}>{t('photos.pending')}</Text>
                </View>
                <View style={s.statItem}>
                  <Text style={[s.statValue, { color: colors.text }]}>
                    {storageInfo ? formatBytes(storageInfo.total_used || storageInfo.drive_used || storageInfo.used_bytes || 0) : '—'}
                  </Text>
                  <Text style={[s.statLabel, { color: colors.textSecondary }]}>{t('photos.spaceUsed')}</Text>
                </View>
              </View>

              {/* Storage bar */}
              {storageInfo && (() => {
                const quota = storageInfo.quota || storageInfo.plan_quota || 15 * 1024 * 1024 * 1024;
                const driveUsed = storageInfo.drive_used || 0;
                const emailUsed = storageInfo.email_used || 0;
                const totalUsed = storageInfo.total_used || driveUsed + emailUsed;
                const drivePct = quota > 0 ? Math.min((driveUsed / quota) * 100, 100) : 0;
                const emailPct = quota > 0 ? Math.min((emailUsed / quota) * 100, 100 - drivePct) : 0;
                return (
                  <View style={{ marginTop: Spacing.md }}>
                    <View style={[s.storageBar, { backgroundColor: colors.border }]}>
                      <View style={{ flexDirection: 'row', height: '100%' }}>
                        {drivePct > 0 && <View style={[s.storageFill, { width: `${drivePct}%`, backgroundColor: colors.primary }]} />}
                        {emailPct > 0 && <View style={[s.storageFill, { width: `${emailPct}%`, backgroundColor: '#f59e0b', borderTopLeftRadius: drivePct > 0 ? 0 : 3, borderBottomLeftRadius: drivePct > 0 ? 0 : 3 }]} />}
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary }} />
                          <Text style={[s.storageText, { color: colors.textSecondary }]}>Drive: {storageInfo.drive_formatted || formatBytes(driveUsed)}</Text>
                        </View>
                        {emailUsed > 0 && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#f59e0b' }} />
                          <Text style={[s.storageText, { color: colors.textSecondary }]}>Chat: {storageInfo.email_formatted || formatBytes(emailUsed)}</Text>
                        </View>}
                      </View>
                    </View>
                    <Text style={[s.storageText, { color: colors.textSecondary, marginTop: 2 }]}>
                      {formatGB(totalUsed)} GB {t('photos.of')} {formatGB(quota)} GB
                    </Text>
                  </View>
                );
              })()}
            </View>

            {/* Settings card */}
            <View style={[s.card, { backgroundColor: colors.surface, borderColor: colors.border, marginTop: Spacing.md }]}>
              <View style={s.cardHeader}>
                <IconSettings size={20} color={colors.textSecondary} />
                <Text style={[s.cardTitle, { color: colors.text }]}>{t('photos.backupSettings')}</Text>
              </View>

              <View style={s.settingRow}>
                <View style={{ flex: 1 }}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>{t('photos.backupAuto')}</Text>
                  <Text style={[s.settingDesc, { color: colors.textSecondary }]}>{t('photos.backupAutoDesc')}</Text>
                </View>
                <Switch
                  value={backupEnabled}
                  onValueChange={toggleBackup}
                  trackColor={{ false: colors.border, true: colors.primary + '80' }}
                  thumbColor={backupEnabled ? colors.primary : colors.textSecondary}
                />
              </View>

              <View style={[s.settingRow, { borderTopWidth: 1, borderTopColor: colors.border }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>{t('photos.backupWifiOnly')}</Text>
                  <Text style={[s.settingDesc, { color: colors.textSecondary }]}>{t('photos.backupWifiOnlyDesc')}</Text>
                </View>
                <Switch
                  value={backupWifiOnly}
                  onValueChange={(val) => {
                    setBackupWifiOnly(val);
                    AsyncStorage.setItem('backup_wifi_only', val ? 'true' : 'false').catch(() => {});
                    try { const bs = require('../services/backup/backupStorage'); bs.saveSettings({ wifiOnly: val }).catch(() => {}); } catch {}
                  }}
                  trackColor={{ false: colors.border, true: colors.primary + '80' }}
                  thumbColor={backupWifiOnly ? colors.primary : colors.textSecondary}
                />
              </View>

              <View style={[s.settingRow, { borderTopWidth: 1, borderTopColor: colors.border }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>{t('photos.backupIncludeVideos')}</Text>
                  <Text style={[s.settingDesc, { color: colors.textSecondary }]}>{t('photos.backupIncludeVideosDesc')}</Text>
                </View>
                <Switch
                  value={backupIncludeVideos}
                  onValueChange={setBackupIncludeVideos}
                  trackColor={{ false: colors.border, true: colors.primary + '80' }}
                  thumbColor={backupIncludeVideos ? colors.primary : colors.textSecondary}
                />
              </View>

              {/* Upload Quality Toggle */}
              <View style={[s.settingRow, { borderTopWidth: 1, borderTopColor: colors.border }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>{t('photos.uploadQuality')}</Text>
                  <Text style={[s.settingDesc, { color: colors.textSecondary }]}>
                    {uploadQuality === 'original' ? t('photos.qualityOriginalDesc') : t('photos.qualityEconomyDesc')}
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => {
                    const next = uploadQuality === 'original' ? 'economy' : 'original';
                    setUploadQuality(next);
                    AsyncStorage.setItem('backup_quality', next).catch(() => {});
                  }}
                  style={[s.qualityBadge, { backgroundColor: uploadQuality === 'original' ? '#2563eb20' : '#16a34a20' }]}
                >
                  <Text style={{ color: uploadQuality === 'original' ? '#2563eb' : '#16a34a', fontSize: 12, fontWeight: '700' }}>
                    {uploadQuality === 'original' ? t('photos.qualityOriginal') : t('photos.qualityEconomy')}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Free up space card */}
            {Platform.OS !== 'web' && backedUpTotal > 0 && (
              <View style={[s.card, { backgroundColor: colors.surface, borderColor: colors.border, marginTop: Spacing.md }]}>
                <View style={s.cardHeader}>
                  <IconTrash size={20} color={colors.primary} />
                  <Text style={[s.cardTitle, { color: colors.text }]}>{t('photos.freeUpSpace')}</Text>
                </View>
                <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 12 }}>{t('photos.freeUpSpaceDesc')}</Text>
                <TouchableOpacity
                  style={[s.backupBtn, { backgroundColor: '#dc2626', alignSelf: 'flex-start' }]}
                  onPress={freeUpSpace}
                >
                  <Text style={s.backupBtnText}>{t('photos.freeUpSpace')} (~{storageInfo ? formatBytes(storageInfo.total_used || storageInfo.drive_used || 0) : '?'})</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Restore photos from cloud */}
            <View style={[s.card, { backgroundColor: colors.surface, borderColor: colors.border, marginTop: Spacing.md }]}>
              <View style={s.cardHeader}>
                <IconDownload size={20} color="#3b82f6" />
                <Text style={[s.cardTitle, { color: colors.text }]}>{t('photos.restorePhotos')}</Text>
              </View>
              <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 12 }}>
                {t('photos.restorePhotosDesc')}
              </Text>
              <TouchableOpacity
                style={[s.backupBtn, { backgroundColor: '#3b82f6', alignSelf: 'flex-start' }]}
                onPress={openPhotoRestore}
              >
                <Text style={s.backupBtnText}>{t('photos.downloadFromCloud')}</Text>
              </TouchableOpacity>
            </View>

            {/* Photo Restore Modal */}
            <Modal
              visible={photoRestoreModal}
              animationType="slide"
              transparent
              onRequestClose={() => !photoRestoreRunning && setPhotoRestoreModal(false)}
            >
              <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
                <View style={{
                  backgroundColor: colors.surface,
                  borderTopLeftRadius: 20, borderTopRightRadius: 20,
                  maxHeight: '80%', paddingBottom: 40,
                }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
                    <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>
                      {t('photos.downloadFromCloud')}
                    </Text>
                    {!photoRestoreRunning && (
                      <TouchableOpacity onPress={() => setPhotoRestoreModal(false)} style={{ padding: 4 }}>
                        <IconX size={20} color={colors.text} />
                      </TouchableOpacity>
                    )}
                  </View>

                  {photoRestoreLoading ? (
                    <View style={{ padding: 40, alignItems: 'center' }}>
                      <ActivityIndicator size="large" color={colors.primary} />
                    </View>
                  ) : photoRestoreRunning ? (
                    <View style={{ padding: 24 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                        <ActivityIndicator size="small" color={colors.primary} />
                        <Text style={{ color: colors.text, fontWeight: '600', fontSize: 15 }}>
                          {photoRestoreProgress.current} / {photoRestoreProgress.total} {t('photos.photosRestored')}
                        </Text>
                      </View>
                      <View style={[s.progressBar, { backgroundColor: colors.border }]}>
                        <View style={[s.progressFill, {
                          width: `${photoRestoreProgress.total > 0 ? Math.min((photoRestoreProgress.current / photoRestoreProgress.total) * 100, 100) : 0}%`,
                          backgroundColor: colors.primary,
                        }]} />
                      </View>
                      <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 8, textAlign: 'center' }}>
                        {t('photos.restoreInProgress')}
                      </Text>
                    </View>
                  ) : (
                    <ScrollView style={{ maxHeight: 400 }}>
                      {/* Summary */}
                      <View style={{ padding: 16, flexDirection: 'row', gap: 16 }}>
                        <View style={{ flex: 1, backgroundColor: colors.background, borderRadius: 12, padding: 12, alignItems: 'center' }}>
                          <Text style={{ color: colors.primary, fontSize: 24, fontWeight: '700' }}>{cloudPhotoTotal}</Text>
                          <Text style={{ color: colors.textSecondary, fontSize: 11, marginTop: 2 }}>{t('photos.inCloud')}</Text>
                        </View>
                        <View style={{ flex: 1, backgroundColor: colors.background, borderRadius: 12, padding: 12, alignItems: 'center' }}>
                          <Text style={{ color: colors.text, fontSize: 24, fontWeight: '700' }}>{deviceTotalCount || devicePhotos.length}</Text>
                          <Text style={{ color: colors.textSecondary, fontSize: 11, marginTop: 2 }}>{t('photos.onDevice')}</Text>
                        </View>
                      </View>

                      {/* Month selection */}
                      <Text style={{ paddingHorizontal: 16, fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: 8, textTransform: 'uppercase' }}>
                        {t('photos.selectMonths')}
                      </Text>
                      {cloudPhotoMonths.map((month) => (
                        <TouchableOpacity
                          key={month.month_key}
                          style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 }}
                          onPress={() => toggleMonth(month.month_key)}
                          activeOpacity={0.7}
                        >
                          <View style={{
                            width: 22, height: 22, borderRadius: 4, borderWidth: 2,
                            borderColor: selectedMonths.has(month.month_key) ? colors.primary : colors.border,
                            backgroundColor: selectedMonths.has(month.month_key) ? colors.primary : 'transparent',
                            alignItems: 'center', justifyContent: 'center',
                          }}>
                            {selectedMonths.has(month.month_key) && <IconCheck size={14} color="#fff" />}
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={{ color: colors.text, fontSize: 15 }}>{month.month_label || month.month_key}</Text>
                          </View>
                          <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
                            {month.count} {t('photos.items')}
                          </Text>
                        </TouchableOpacity>
                      ))}

                      {cloudPhotoMonths.length === 0 && (
                        <View style={{ padding: 30, alignItems: 'center' }}>
                          <Text style={{ color: colors.textSecondary }}>{t('photos.noCloudPhotos')}</Text>
                        </View>
                      )}

                      {/* Download button */}
                      {cloudPhotoMonths.length > 0 && (
                        <View style={{ padding: 16 }}>
                          <TouchableOpacity
                            style={[s.backupBtn, {
                              backgroundColor: selectedMonths.size > 0 ? colors.primary : colors.border,
                              alignSelf: 'stretch', alignItems: 'center', paddingVertical: 14,
                            }]}
                            onPress={startPhotoRestore}
                            disabled={selectedMonths.size === 0}
                          >
                            <Text style={[s.backupBtnText, { fontSize: 15 }]}>
                              {(t('photos.downloadNPhotos') || 'Baixar {n} fotos').replace('{n}',
                                cloudPhotoMonths
                                  .filter(m => selectedMonths.has(m.month_key))
                                  .reduce((sum, m) => sum + parseInt(m.count || 0), 0)
                              )}
                            </Text>
                          </TouchableOpacity>
                        </View>
                      )}
                    </ScrollView>
                  )}
                </View>
              </View>
            </Modal>

            {/* Trash card */}
            {trashItems.length > 0 && (
              <View style={[s.card, { backgroundColor: colors.surface, borderColor: colors.border, marginTop: Spacing.md }]}>
                <View style={s.cardHeader}>
                  <IconTrash size={20} color={colors.textSecondary} />
                  <Text style={[s.cardTitle, { color: colors.text }]}>{t('photos.trash')}</Text>
                </View>
                <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 4 }}>
                  {t('photos.trashCount', { n: trashItems.length })}
                </Text>
                <Text style={{ color: colors.textTertiary, fontSize: 11, marginBottom: 12 }}>
                  {t('photos.trashInfo')}
                </Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TouchableOpacity
                    style={[s.backupBtn, { backgroundColor: colors.primary }]}
                    onPress={async () => {
                      for (const item of trashItems) {
                        try { await api.fileRestore(item.id); } catch {}
                      }
                      setTrashItems([]);
                      loadCloudPhotos(1);
                    }}
                  >
                    <Text style={s.backupBtnText}>{t('photos.restore')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[s.backupBtn, { backgroundColor: '#dc2626' }]}
                    onPress={() => {
                      safeAlert(t('photos.emptyTrash'), t('photos.deleteConfirm', { n: trashItems.length }), [
                        { text: t('common.cancel'), style: 'cancel' },
                        {
                          text: t('photos.permanentDelete'), style: 'destructive',
                          onPress: async () => {
                            await api.fileEmptyTrash().catch(() => {});
                            setTrashItems([]);
                          },
                        },
                      ]);
                    }}
                  >
                    <Text style={s.backupBtnText}>{t('photos.emptyTrash')}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* Actions */}
            <View style={[s.card, { backgroundColor: colors.surface, borderColor: colors.border, marginTop: Spacing.md }]}>
              <TouchableOpacity
                style={[s.actionBtn, { borderBottomWidth: 1, borderBottomColor: colors.border }]}
                onPress={startBackup}
                disabled={Platform.OS === 'web'}
              >
                <IconCloudUpload size={20} color={colors.primary} />
                <Text style={[s.actionBtnText, { color: colors.primary }]}>{t('photos.backupNow')}</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={s.actionBtn}
                onPress={() => {
                  safeAlert(t('photos.clearHistory'), t('photos.clearHistoryConfirm'), [
                    { text: t('common.cancel'), style: 'cancel' },
                    {
                      text: t('common.confirm'),
                      onPress: async () => {
                        // Clear AsyncStorage backed_up_photos (forces re-scan)
                        try { await AsyncStorage.removeItem('backed_up_photos'); } catch {}
                        // Also reset via autoBackup module
                        if (autoBackupMod?.resetBackupHistory) {
                          try { await autoBackupMod.resetBackupHistory(); } catch {}
                        }
                        setDevicePhotos(prev => prev.map(p => ({ ...p, backedUp: false })));
                        setBackupStatus('needs_backup');
                        setPendingCount(deviceTotalCount || devicePhotos.length);
                        setBackedUpTotal(0);
                      },
                    },
                  ]);
                }}
              >
                <IconRefresh size={20} color={colors.textSecondary} />
                <Text style={[s.actionBtnText, { color: colors.textSecondary }]}>{t('photos.clearHistory')}</Text>
              </TouchableOpacity>
            </View>

            {/* Last backup */}
            {lastBackupDate && (
              <Text style={[s.lastBackup, { color: colors.textTertiary }]}>
                {t('photos.lastBackup')}: {new Date(lastBackupDate).toLocaleString()}
              </Text>
            )}
          </View>
        )}
      />
    );
  };

  // ============================================================
  // VIEWER MODAL
  // ============================================================
  const renderViewer = () => {
    if (!viewerVisible || !viewerPhoto) return null;

    return (
      <Modal visible={viewerVisible} animationType="none" transparent onRequestClose={closeViewer}>
        <Animated.View style={[s.viewer, { backgroundColor: '#000', opacity: viewerBgOpacity }]}>
          {/* Top bar */}
          <Animated.View style={[s.viewerTopBar, { paddingTop: insets.top + 8, opacity: viewerBgOpacity }]}>
            <TouchableOpacity onPress={closeViewer} style={s.viewerBtn}>
              <IconArrowLeft size={24} color="#fff" />
            </TouchableOpacity>
            <View style={{ flex: 1 }} />
            <TouchableOpacity
              onPress={() => toggleStar(viewerPhoto)}
              style={s.viewerBtn}
            >
              {viewerStarred ? (
                <IconStarFilled size={24} color="#f59e0b" />
              ) : (
                <IconStar size={24} color="#fff" />
              )}
            </TouchableOpacity>
            <TouchableOpacity style={s.viewerBtn} onPress={() => sharePhoto(viewerPhoto)}>
              <IconShare size={22} color="#fff" />
            </TouchableOpacity>
          </Animated.View>

          {/* Image with scale animation */}
          <Animated.View style={[s.viewerImageContainer, { transform: [{ scale: viewerScaleAnim }] }]}>
            <TouchableOpacity
              onPress={() => navigateViewer(-1)}
              style={[s.viewerNav, s.viewerNavLeft]}
              disabled={viewerIndex <= 0}
            >
              {viewerIndex > 0 && <IconChevronLeft size={32} color="rgba(255,255,255,0.7)" />}
            </TouchableOpacity>

            <ExpoImage
              source={{ uri: viewerResolvedUri || getFullUrl(viewerPhoto) }}
              style={s.viewerImage}
              contentFit="contain"
            />

            <TouchableOpacity
              onPress={() => navigateViewer(1)}
              style={[s.viewerNav, s.viewerNavRight]}
              disabled={viewerIndex >= filteredPhotos.length - 1}
            >
              {viewerIndex < filteredPhotos.length - 1 && <IconChevronRight size={32} color="rgba(255,255,255,0.7)" />}
            </TouchableOpacity>
          </Animated.View>

          {/* Photo info */}
          <Text style={s.viewerFilename} numberOfLines={1}>{viewerPhoto.name}</Text>

          {/* Bottom bar */}
          <View style={[s.viewerBottomBar, { paddingBottom: insets.bottom + 8 }]}>
            <TouchableOpacity style={s.viewerAction} onPress={() => sharePhoto(viewerPhoto)}>
              <IconShare size={22} color="#fff" />
              <Text style={s.viewerActionText}>{t('photos.share')}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={s.viewerAction} onPress={() => setEditorVisible(true)}>
              <IconEdit size={22} color="#fff" />
              <Text style={s.viewerActionText}>{t('photos.edit')}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={s.viewerAction} onPress={deleteViewerPhoto}>
              <IconTrash size={22} color="#fff" />
              <Text style={s.viewerActionText}>{t('photos.delete')}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={s.viewerAction} onPress={toggleInfoPanel}>
              <IconInfo size={22} color="#fff" />
              <Text style={s.viewerActionText}>{t('photos.info')}</Text>
            </TouchableOpacity>

            {!viewerPhoto.isDevice && (
              <TouchableOpacity style={s.viewerAction} onPress={() => downloadPhoto(viewerPhoto)}>
                <IconDownload size={22} color="#fff" />
                <Text style={s.viewerActionText}>{t('photos.download')}</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Info Panel (slide up) */}
          {showInfoPanel && viewerPhoto && (
            <Animated.View style={[s.infoPanel, {
              transform: [{ translateY: infoPanelAnim.interpolate({ inputRange: [0, 1], outputRange: [300, 0] }) }],
              opacity: infoPanelAnim,
            }]}>
              <View style={s.infoPanelHandle} />
              <Text style={s.infoPanelTitle}>{t('photos.photoDetails')}</Text>
              <View style={s.infoRow}>
                <Text style={s.infoLabel}>{t('photos.dateTaken')}</Text>
                <Text style={s.infoValue}>
                  {(() => { try { const d = new Date(viewerPhoto.created_at || viewerPhoto.uploaded_at || viewerPhoto.modificationTime); return d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } })()}
                </Text>
              </View>
              <View style={s.infoRow}>
                <Text style={s.infoLabel}>{viewerPhoto.name}</Text>
                <Text style={s.infoValue}>
                  {viewerPhoto.width && viewerPhoto.height ? `${viewerPhoto.width} x ${viewerPhoto.height}` : ''}
                  {viewerPhoto.size ? ` · ${formatBytes(viewerPhoto.size)}` : ''}
                </Text>
              </View>
              <View style={s.infoRow}>
                <Text style={s.infoLabel}>{t('photos.cloudStatus')}</Text>
                <Text style={[s.infoValue, { color: viewerPhoto.isDevice && !viewerPhoto.backedUp ? '#f59e0b' : '#22c55e' }]}>
                  {viewerPhoto.isDevice && !viewerPhoto.backedUp ? t('photos.localOnly') : t('photos.inCloud')}
                </Text>
              </View>
              <TouchableOpacity onPress={toggleInfoPanel} style={s.infoPanelClose}>
                <IconX size={20} color="#fff" />
              </TouchableOpacity>
            </Animated.View>
          )}
        </Animated.View>
      </Modal>
    );
  };

  const handleEditorSave = useCallback((editedUri) => {
    setEditorVisible(false);
    if (editedUri && viewerPhoto) {
      const originalUri = getFullUrl(viewerPhoto);
      if (editedUri !== originalUri) {
        // Optionally: upload edited photo as new file
        // For now, just close the editor — the editedUri can be used by the caller
      }
    }
  }, [viewerPhoto, getFullUrl]);

  // ============================================================
  // RENDER
  // ============================================================
  return (
    <Animated.View style={[s.container, { backgroundColor: colors.background, opacity: fadeAnim }]}>
      {/* Header */}
      <View style={[s.header, { backgroundColor: colors.headerBgSolid, borderBottomColor: colors.headerBorder, paddingTop: insets.top }]}>
        {selectMode ? (
          // Selection header
          <View style={s.headerRow}>
            <TouchableOpacity onPress={clearSelection} style={s.headerBtn}>
              <IconX size={24} color={colors.text} />
            </TouchableOpacity>
            <Text style={[s.headerTitle, { color: colors.text }]}>
              {selectedItems.size} {t('photos.selected')}
            </Text>
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={selectAll} style={s.headerBtn}>
              <IconCheckCircle size={22} color={colors.primary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={deleteSelected} style={s.headerBtn}>
              <IconTrash size={22} color={colors.error} />
            </TouchableOpacity>
            <TouchableOpacity style={s.headerBtn}>
              <IconShare size={22} color={colors.text} />
            </TouchableOpacity>
          </View>
        ) : showSearch ? (
          // Search header
          <View style={s.headerRow}>
            <TouchableOpacity onPress={() => { setShowSearch(false); setSearchText(''); }} style={s.headerBtn}>
              <IconArrowLeft size={24} color={colors.text} />
            </TouchableOpacity>
            <TextInput
              style={[s.searchInput, { color: colors.text, backgroundColor: colors.surfaceVariant }]}
              placeholder={t('photos.searchPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              value={searchText}
              onChangeText={setSearchText}
              autoFocus
            />
          </View>
        ) : (
          // Normal header
          <View style={s.headerRow}>
            <TouchableOpacity onPress={() => { if (Platform.OS === "web" && window.parent !== window) { try { window.parent.postMessage({ type: "close-side-panel", route: "/photos" }, "*"); } catch {} } else { router.back(); } }} style={s.headerBtn}>
              <IconArrowLeft size={24} color={colors.text} />
            </TouchableOpacity>
            <IconCloud size={22} color={colors.primary} />
            <Text style={[s.headerTitle, { color: colors.text, marginLeft: 8 }]}>{t('photos.title')}</Text>
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={() => setShowSearch(true)} style={s.headerBtn}>
              <IconSearch size={22} color={colors.textSecondary} />
            </TouchableOpacity>
            {activeTab === 'photos' && (
              <TouchableOpacity onPress={cycleGridColumns} style={s.headerBtn}>
                <IconGrid size={22} color={colors.textSecondary} />
                <Text style={[s.gridLabel, { color: colors.textSecondary }]}>{gridColumns}</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Fixed backup progress banner (Google Photos style - visible across all tabs) */}
        {backupStatus === 'backing_up' && (
          <View style={{ backgroundColor: isDark ? '#172554' : '#dbeafe', paddingHorizontal: 16, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <ActivityIndicator size="small" color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>
                Backup em andamento · {backedUpTotal} fotos salvas
              </Text>
              <Text style={{ color: colors.textSecondary, fontSize: 11, marginTop: 1 }}>
                Continua mesmo com o app minimizado
              </Text>
            </View>
          </View>
        )}
        {backupStatus === 'complete' && (
          <TouchableOpacity
            onPress={() => setBackupStatus('idle')}
            style={{ backgroundColor: isDark ? '#052e16' : '#dcfce7', paddingHorizontal: 16, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 8 }}
          >
            <IconCheck size={16} color="#22c55e" />
            <Text style={{ color: '#16a34a', fontSize: 13, fontWeight: '600', flex: 1 }}>Backup completo! {backedUpTotal} fotos salvas</Text>
            <IconX size={14} color="#16a34a" />
          </TouchableOpacity>
        )}

        {/* Tabs with sliding indicator */}
        <View style={s.tabs} onLayout={(e) => { tabWidthRef.current = e.nativeEvent.layout.width / TABS.length; }}>
          {TABS.map((tab, i) => (
            <TouchableOpacity
              key={tab}
              style={s.tab}
              onPress={() => {
                setActiveTab(tab);
                setViewingAlbum(null); // close album detail view when switching tabs
                Animated.spring(tabIndicatorLeft, { toValue: i * (tabWidthRef.current || (width - Spacing.md * 2) / TABS.length), friction: 10, tension: 80, useNativeDriver: false }).start();
              }}
            >
              {tab === 'photos' && <IconImage size={16} color={activeTab === tab ? colors.primary : colors.textSecondary} />}
              {tab === 'search' && <IconSearch size={16} color={activeTab === tab ? colors.primary : colors.textSecondary} />}
              {tab === 'albums' && <IconAlbum size={16} color={activeTab === tab ? colors.primary : colors.textSecondary} />}
              {tab === 'backup' && <IconCloud size={16} color={activeTab === tab ? colors.primary : colors.textSecondary} />}
              <Text style={[s.tabText, { color: activeTab === tab ? colors.primary : colors.textSecondary }]}>
                {t(`photos.tab_${tab}`)}
              </Text>
            </TouchableOpacity>
          ))}
          <Animated.View style={[s.tabIndicator, { backgroundColor: colors.primary, width: tabWidthRef.current || ((width - Spacing.md * 2) / TABS.length), transform: [{ translateX: tabIndicatorLeft }] }]} />
        </View>
      </View>

      {/* Filter chips (photos tab only) */}
      {activeTab === 'photos' && (
        <View style={{ flexDirection: 'row', paddingHorizontal: Spacing.md, paddingVertical: 6, gap: 8, backgroundColor: colors.background }}>
          <TouchableOpacity
            onPress={() => setShowFavorites(false)}
            style={[s.filterChip, !showFavorites && { backgroundColor: colors.primary }]}
          >
            <Text style={[s.filterChipText, !showFavorites && { color: '#fff' }]}>{t('photos.allPhotos')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setShowFavorites(true)}
            style={[s.filterChip, showFavorites && { backgroundColor: colors.primary }]}
          >
            <IconStarFilled size={12} color={showFavorites ? '#fff' : '#f59e0b'} />
            <Text style={[s.filterChipText, showFavorites && { color: '#fff' }]}>{t('photos.favorites')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Content */}
      <View style={{ flex: 1 }}>
        {viewingAlbum ? (
          <View style={{ flex: 1 }}>
            {/* Album header with back button */}
            <View style={[s.albumDetailHeader, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
              <TouchableOpacity
                onPress={() => { setViewingAlbum(null); setAlbumPhotos([]); }}
                style={s.albumBackBtn}
              >
                <IconArrowLeft size={24} color={colors.text} />
              </TouchableOpacity>
              <View style={{ flex: 1 }}>
                <Text style={[s.albumDetailTitle, { color: colors.text }]} numberOfLines={1}>{viewingAlbum.name}</Text>
                <Text style={[s.albumDetailCount, { color: colors.textSecondary }]}>
                  {albumPhotos.length || viewingAlbum.count || viewingAlbum.photos?.length || 0} {t('photos.items')}
                </Text>
              </View>
            </View>
            {albumLoading ? (
              <GridSkeleton count={12} columns={3} />
            ) : albumPhotos.length === 0 ? (
              <View style={s.emptyState}>
                <IconImage size={64} color={colors.textTertiary} />
                <Text style={[s.emptyTitle, { color: colors.text }]}>{t('photos.noPhotos') || 'Nenhuma foto'}</Text>
              </View>
            ) : (
              <FlatList
                data={albumPhotos}
                numColumns={3}
                keyExtractor={(item) => item.id}
                contentContainerStyle={{ paddingBottom: 80 + insets.bottom }}
                renderItem={({ item: photo, index }) => renderPhotoItem({ item: photo, index })}
                windowSize={10}
                maxToRenderPerBatch={15}
                initialNumToRender={18}
              />
            )}
          </View>
        ) : (
          <>
            {activeTab === 'photos' && renderPhotosTab()}
            {activeTab === 'search' && renderSearchTab()}
            {activeTab === 'albums' && renderAlbumsTab()}
            {activeTab === 'backup' && renderBackupTab()}
          </>
        )}
      </View>

      {/* FAB - Upload/Camera (Google Photos style) */}
      {!selectMode && activeTab === 'photos' && (
        <View style={[s.fabContainer, { bottom: 24 + insets.bottom }]}>
          {fabOpen && (
            <Animated.View style={[s.fabOptions, { opacity: fabRotateAnim }]}>
              <TouchableOpacity
                style={[s.fabOption, { backgroundColor: colors.surface, ...Shadow.md }]}
                onPress={() => { setFabOpen(false); /* trigger camera */ }}
              >
                <IconCamera size={20} color={colors.primary} />
                <Text style={[s.fabOptionText, { color: colors.text }]}>{t('photos.camera') || 'Camera'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.fabOption, { backgroundColor: colors.surface, ...Shadow.md }]}
                onPress={() => { setFabOpen(false); /* trigger upload */ }}
              >
                <IconCloudUpload size={20} color={colors.primary} />
                <Text style={[s.fabOptionText, { color: colors.text }]}>{t('photos.upload') || 'Upload'}</Text>
              </TouchableOpacity>
            </Animated.View>
          )}
          <TouchableOpacity
            style={[s.fabMain, { backgroundColor: colors.primary, ...Shadow.lg }]}
            onPress={() => {
              const newVal = !fabOpen;
              setFabOpen(newVal);
              Animated.spring(fabRotateAnim, { toValue: newVal ? 1 : 0, friction: 8, useNativeDriver: false }).start();
            }}
            activeOpacity={0.85}
          >
            <Animated.View style={{ transform: [{ rotate: fabRotateAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '45deg'] }) }] }}>
              <Text style={{ color: '#fff', fontSize: 28, fontWeight: '300', lineHeight: 30 }}>+</Text>
            </Animated.View>
          </TouchableOpacity>
        </View>
      )}

      {/* Batch operations toolbar */}
      {selectMode && selectedItems.size > 0 && (
        <View style={[s.batchToolbar, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
          <TouchableOpacity style={s.batchAction} onPress={() => {
            const selected = filteredPhotos.filter(p => selectedItems.has(p.id));
            selected.forEach(p => toggleStar(p));
            clearSelection();
          }}>
            <IconStar size={20} color={colors.text} />
            <Text style={[s.batchActionText, { color: colors.text }]}>{t('photos.favorites')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.batchAction} onPress={() => {
            const selected = filteredPhotos.filter(p => selectedItems.has(p.id) && !p.isDevice);
            if (selected.length > 0) sharePhoto(selected[0]);
          }}>
            <IconShare size={20} color={colors.text} />
            <Text style={[s.batchActionText, { color: colors.text }]}>{t('photos.share')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.batchAction} onPress={deleteSelected}>
            <IconTrash size={20} color="#dc2626" />
            <Text style={[s.batchActionText, { color: '#dc2626' }]}>{t('photos.delete')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.batchAction} onPress={() => {
            const selected = filteredPhotos.filter(p => selectedItems.has(p.id) && !p.isDevice);
            selected.forEach(p => downloadPhoto(p));
            clearSelection();
          }}>
            <IconDownload size={20} color={colors.text} />
            <Text style={[s.batchActionText, { color: colors.text }]}>{t('photos.download')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Create album modal */}
      <Modal visible={createAlbumVisible} transparent animationType="fade" onRequestClose={() => setCreateAlbumVisible(false)}>
        <Pressable style={s.modalOverlay} onPress={() => setCreateAlbumVisible(false)}>
          <Pressable style={[s.modalContent, { backgroundColor: colors.surface }]} onPress={e => e.stopPropagation()}>
            <Text style={[s.modalTitle, { color: colors.text }]}>{t('photos.createAlbum')}</Text>
            <TextInput
              style={[s.modalInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
              placeholder={t('photos.albumName')}
              placeholderTextColor={colors.textTertiary}
              value={newAlbumName}
              onChangeText={setNewAlbumName}
              autoFocus
            />
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 12, marginTop: 16 }}>
              <TouchableOpacity onPress={() => setCreateAlbumVisible(false)} style={s.modalBtn}>
                <Text style={{ color: colors.textSecondary }}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={createAlbum} style={[s.modalBtn, { backgroundColor: colors.primary, borderRadius: 8 }]}>
                <Text style={{ color: '#fff', fontWeight: '600' }}>{t('photos.createAlbum')}</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Viewer modal */}
      {renderViewer()}

      {/* Photo Editor */}
      <PhotoEditor
        visible={editorVisible}
        imageUri={viewerPhoto ? getFullUrl(viewerPhoto) : null}
        onSave={handleEditorSave}
        onClose={() => setEditorVisible(false)}
      />
    </Animated.View>
  );
}

// ============================================================
// STYLES
// ============================================================
const s = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Header — frosted glass
  header: {
    borderBottomWidth: 0,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 10 },
      android: { elevation: 3 },
      web: { boxShadow: '0 2px 16px rgba(0,0,0,0.05)', backdropFilter: 'blur(24px) saturate(180%)', WebkitBackdropFilter: 'blur(24px) saturate(180%)' },
    }),
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.sm,
    height: 56,
  },
  headerBtn: {
    padding: 8,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
  },
  headerTitle: {
    fontSize: FontSize.xxl,
    fontWeight: '800',
    marginLeft: 4,
    letterSpacing: -0.3,
  },
  searchInput: {
    flex: 1,
    height: 40,
    borderRadius: 20,
    paddingHorizontal: Spacing.lg,
    fontSize: FontSize.base,
    marginLeft: 8,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none', transition: 'border-color 0.2s ease' } : {}),
  },
  gridLabel: {
    fontSize: FontSize.xs,
    fontWeight: '700',
    marginLeft: 2,
  },

  // Tabs
  tabs: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.md,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.md,
    borderBottomWidth: 3,
    borderBottomColor: 'transparent',
    gap: 6,
  },
  tabText: {
    fontSize: FontSize.sm,
    fontWeight: '700',
    textTransform: 'capitalize',
  },

  // Backup Banner — frosted glass card
  backupBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md + 2,
    marginHorizontal: Spacing.sm,
    marginTop: Spacing.sm,
    borderRadius: 16,
    borderWidth: 0,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 10 },
      android: { elevation: 2 },
      web: { boxShadow: '0 2px 14px rgba(0,0,0,0.05)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)' },
    }),
  },
  backupBannerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  backupBannerTitle: {
    fontSize: FontSize.sm,
    fontWeight: '700',
  },
  backupBannerSub: {
    fontSize: FontSize.xs,
    marginTop: 2,
    opacity: 0.6,
  },
  backupBtn: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderRadius: 14,
    marginLeft: Spacing.md,
    ...Platform.select({
      ios: { shadowColor: '#4F46E5', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 6 },
      android: { elevation: 3 },
      web: { boxShadow: '0 2px 10px rgba(79,70,229,0.2)' },
    }),
  },
  backupBtnText: {
    color: '#fff',
    fontSize: FontSize.sm,
    fontWeight: '700',
  },
  progressBar: {
    height: 5,
    borderRadius: 3,
    marginTop: 8,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
  },

  // Grid — clean masonry, minimal gaps
  gridRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  gridItem: {
    margin: 0.5,
    overflow: 'hidden',
    position: 'relative',
    borderRadius: 2,
  },
  gridImage: {
    width: '100%',
    height: '100%',
  },
  videoDuration: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.75)',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6,
    gap: 3,
  },
  videoDurationText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  backupIndicator: {
    position: 'absolute',
    top: 4,
    right: 4,
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderRadius: 10,
    padding: 2,
  },
  selectCircle: {
    position: 'absolute',
    top: 6,
    left: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2.5,
    borderColor: 'rgba(255,255,255,0.9)',
    backgroundColor: 'rgba(0,0,0,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.2, shadowRadius: 3 },
      android: { elevation: 2 },
      web: { boxShadow: '0 1px 4px rgba(0,0,0,0.2)' },
    }),
  },

  // Section headers — sticky frosted glass
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm + 2,
    ...Platform.select({
      web: { backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)' },
      default: {},
    }),
  },
  sectionTitle: {
    fontSize: FontSize.base,
    fontWeight: '800',
    letterSpacing: -0.1,
  },
  sectionCount: {
    fontSize: FontSize.xs,
    opacity: 0.5,
  },

  // Empty — animated camera icon
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 80,
  },
  emptyTitle: {
    fontSize: FontSize.xl + 2,
    fontWeight: '800',
    marginTop: Spacing.lg,
    letterSpacing: -0.3,
  },
  emptySubtitle: {
    fontSize: FontSize.base,
    marginTop: Spacing.sm,
    textAlign: 'center',
    paddingHorizontal: 40,
    opacity: 0.6,
    lineHeight: 22,
  },

  // Albums
  albumCard: {
    margin: Spacing.sm,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 0,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 10 },
      android: { elevation: 3 },
      web: { boxShadow: '0 2px 14px rgba(0,0,0,0.06)' },
    }),
  },
  albumCover: {
    width: '100%',
    backgroundColor: '#1a1a2e',
  },
  albumCoverPlaceholder: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  albumInfo: {
    padding: Spacing.sm,
  },
  albumName: {
    fontSize: FontSize.sm,
    fontWeight: '700',
  },
  albumCount: {
    fontSize: FontSize.xs,
    marginTop: 2,
  },
  albumDetailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
  },
  albumBackBtn: {
    padding: 8,
    marginRight: 8,
  },
  albumDetailTitle: {
    fontSize: FontSize.lg,
    fontWeight: '700',
  },
  albumDetailCount: {
    fontSize: FontSize.xs,
    marginTop: 2,
  },

  // Backup tab cards — frosted glass
  card: {
    borderRadius: 18,
    borderWidth: 0,
    padding: Spacing.lg + 4,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.08, shadowRadius: 14 },
      android: { elevation: 3 },
      web: { boxShadow: '0 3px 18px rgba(0,0,0,0.06)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)' },
    }),
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.lg,
  },
  cardTitle: {
    fontSize: FontSize.lg,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  statItem: {
    width: '50%',
    paddingVertical: Spacing.sm,
  },
  statValue: {
    fontSize: FontSize.title,
    fontWeight: '700',
  },
  statLabel: {
    fontSize: FontSize.xs,
    marginTop: 2,
  },
  storageBar: {
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
  },
  storageFill: {
    height: '100%',
    borderRadius: 4,
    ...(Platform.OS === 'web' ? { background: 'linear-gradient(90deg, #4F46E5, #8b5cf6, #ec4899)', transition: 'width 0.5s ease' } : {}),
  },
  storageText: {
    fontSize: FontSize.xs,
    marginTop: 4,
    textAlign: 'right',
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.md,
  },
  settingLabel: {
    fontSize: FontSize.base,
    fontWeight: '500',
  },
  settingDesc: {
    fontSize: FontSize.xs,
    marginTop: 2,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
  },
  actionBtnText: {
    fontSize: FontSize.base,
    fontWeight: '500',
  },
  lastBackup: {
    fontSize: FontSize.xs,
    textAlign: 'center',
    marginTop: Spacing.lg,
  },

  // Viewer
  viewer: {
    flex: 1,
  },
  viewerTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  viewerBtn: {
    padding: 10,
  },
  viewerImageContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
  },
  viewerImage: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  viewerNav: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 60,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 5,
  },
  viewerNavLeft: {
    left: 0,
  },
  viewerNavRight: {
    right: 0,
  },
  viewerFilename: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: 20,
    marginBottom: 4,
  },
  viewerBottomBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 12,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  viewerAction: {
    alignItems: 'center',
    gap: 4,
  },
  viewerActionText: {
    color: '#fff',
    fontSize: 11,
  },

  // Info panel
  infoPanel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.9)',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    paddingBottom: 30,
  },
  infoPanelHandle: {
    width: 40,
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.3)',
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 16,
  },
  infoPanelTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 16,
  },
  infoRow: {
    marginBottom: 12,
  },
  infoLabel: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
    marginBottom: 2,
  },
  infoValue: {
    color: '#fff',
    fontSize: 14,
  },
  infoPanelClose: {
    position: 'absolute',
    top: 16,
    right: 16,
    padding: 4,
  },

  // Memories
  memoryCard: {
    width: 120,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
  },
  memoryCover: {
    width: 120,
    height: 120,
    backgroundColor: '#1a1a2e',
  },
  memoryLabel: {
    fontSize: 12,
    fontWeight: '600',
    paddingHorizontal: 8,
    paddingTop: 6,
  },
  memoryCount: {
    fontSize: 10,
    paddingHorizontal: 8,
    paddingBottom: 6,
  },

  // Filter chips
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: 'rgba(128,128,128,0.15)',
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: '600',
  },

  // Quality badge
  qualityBadge: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },

  // Batch toolbar
  batchToolbar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 10,
    paddingBottom: 24,
    borderTopWidth: 1,
    ...Shadow.md,
  },
  batchAction: {
    alignItems: 'center',
    gap: 4,
  },
  batchActionText: {
    fontSize: 10,
    fontWeight: '600',
  },

  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: '85%',
    maxWidth: 400,
    borderRadius: 16,
    padding: 24,
    ...Shadow.lg,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 16,
  },
  modalInput: {
    height: 44,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  modalBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },

  // Progressive image loading placeholder
  gridImagePlaceholder: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#e5e7eb',
    justifyContent: 'center',
    alignItems: 'center',
  },
  gridImagePlaceholderShimmer: {
    width: '60%',
    height: '60%',
    borderRadius: 4,
    backgroundColor: 'rgba(0,0,0,0.04)',
  },

  // Tab sliding indicator
  tabIndicator: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    height: 2.5,
    borderRadius: 2,
  },

  // Floating date label (Google Photos style)
  floatingDateLabel: {
    position: 'absolute',
    top: 8,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 20,
    ...Shadow.sm,
    zIndex: 10,
  },
  floatingDateText: {
    fontSize: 13,
    fontWeight: '600',
  },

  // Timeline scrubber
  timelineScrubber: {
    position: 'absolute',
    right: 2,
    top: 48,
    bottom: 48,
    width: 20,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 5,
  },
  scrubberTrack: {
    width: 3,
    height: '100%',
    borderRadius: 2,
    position: 'relative',
  },
  scrubberThumb: {
    position: 'absolute',
    width: 12,
    height: 28,
    borderRadius: 6,
    left: -4.5,
  },

  // FAB
  fabContainer: {
    position: 'absolute',
    right: 20,
    alignItems: 'center',
    zIndex: 20,
  },
  fabMain: {
    width: 56,
    height: 56,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  fabOptions: {
    marginBottom: 12,
    gap: 8,
  },
  fabOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    gap: 10,
    minWidth: 130,
  },
  fabOptionText: {
    fontSize: 13,
    fontWeight: '600',
  },

  // Better empty state
  emptyIllustration: {
    marginBottom: 8,
  },
  emptyCircleOuter: {
    width: 130,
    height: 130,
    borderRadius: 65,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyCircleInner: {
    width: 100,
    height: 100,
    borderRadius: 50,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyUploadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 20,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 24,
  },
  emptyUploadBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
