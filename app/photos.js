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
import { formatBytes, getFileExt, PHOTO_EXTENSIONS, VIDEO_EXTENSIONS } from '../services/format';
import { safeAlert } from '../services/alerts';
import { mapApiError } from '../services/errorMap';
import useIsMounted from '../hooks/useIsMounted';
import { GridSkeleton } from '../components/SkeletonLoader';
import ErrorBoundary from '../components/ErrorBoundary';
let mailWs = null;
try { mailWs = require('../services/websocket').default; } catch {}
import {
  IconImage, IconFilm, IconSearch, IconArrowLeft, IconCheck, IconX,
  IconTrash, IconDownload, IconShare, IconStar, IconStarFilled,
  IconMoreVert, IconCamera, IconGrid, IconPlay, IconInfo, IconRefresh,
  IconChevronLeft, IconChevronRight, IconSettings, IconCheckCircle, IconEdit,
  IconPlus,
} from '../components/Icons';
import PhotoEditor from '../components/PhotoEditor';
import BrandFab from '../components/BrandFab';
import { generateBatch } from '../services/thumbnailCache';
import Svg, { Path, Circle as SvgCircle, Line, Polyline } from 'react-native-svg';

let photoBackup = null;
try { photoBackup = require('../services/photoBackup'); } catch {}

let autoBackupMod = null;
try { autoBackupMod = require('../services/autoBackup'); } catch {}

// Gesture handlers for pinch-zoom + horizontal swipe in the viewer.
// Safe-required so the screen still renders if the library is missing.
let PinchGestureHandler = null;
let PanGestureHandler = null;
let GHState = null;
try {
  const GH = require('react-native-gesture-handler');
  PinchGestureHandler = GH.PinchGestureHandler;
  PanGestureHandler = GH.PanGestureHandler;
  GHState = GH.State;
} catch {}

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
const TABS = ['photos', 'albums', 'search', 'backup'];
const PAGE_SIZE = Platform.OS === 'web' ? 200 : 60;

function formatGB(bytes) {
  if (!bytes) return '0';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1);
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
  // Google Photos-style scan + ETA + speed UI
  const [backupPhase, setBackupPhase] = useState('idle'); // 'idle' | 'scanning' | 'uploading' | 'done'
  const [scanState, setScanState] = useState({ scanned: 0, total: 0, pending: 0, pendingBytes: 0 });
  const [uploadStats, setUploadStats] = useState({
    uploaded: 0, total: 0, bytesUploaded: 0, totalBytes: 0,
    bytesPerSec: 0, etaSec: 0, currentFile: '',
  });

  // Subscribe to native scan + upload events
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let NativeUpload = null;
    try { NativeUpload = (Platform.OS==='ios'?require('../modules/expo-background-upload').default:null); } catch {}
    if (!NativeUpload?.addListener) return;

    const subScan = NativeUpload.addListener('onScanProgress', (e) => {
      setScanState({
        scanned: e.scanned || 0,
        total: e.total || 0,
        pending: e.pending || 0,
        pendingBytes: e.pendingBytes || 0,
      });
      if (e.isComplete) setBackupPhase((p) => (p === 'scanning' ? 'uploading' : p));
    });
    const subUp = NativeUpload.addListener('onUploadProgress', (e) => {
      setUploadStats({
        uploaded: e.uploaded || 0,
        total: e.total || 0,
        bytesUploaded: e.bytesUploaded || 0,
        totalBytes: e.totalBytes || 0,
        bytesPerSec: e.bytesPerSec || 0,
        etaSec: e.etaSec || 0,
        currentFile: e.currentFile || '',
      });
    });
    return () => { subScan?.remove?.(); subUp?.remove?.(); };
  }, []);

  // Helpers for the polished progress UI
  const fmtBytes = (b) => {
    if (!b) return '0 B';
    if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
    if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
    return b + ' B';
  };
  const fmtSpeed = (bps) => {
    if (!bps) return '—';
    if (bps >= 1e6) return (bps / 1e6).toFixed(1) + ' MB/s';
    if (bps >= 1e3) return (bps / 1e3).toFixed(0) + ' KB/s';
    return bps + ' B/s';
  };
  const fmtEta = (sec) => {
    if (!sec || sec < 0) return '—';
    if (sec < 60) return sec + 's restantes';
    if (sec < 3600) return Math.round(sec / 60) + ' min restantes';
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return `${h}h ${m}min restantes`;
  };

  // Selection
  const [selectedItems, setSelectedItems] = useState(new Set());
  const [selectMode, setSelectMode] = useState(false);

  // Viewer
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [viewerStarred, setViewerStarred] = useState(false);
  const [aiCaption, setAiCaption] = useState('');
  const [aiCaptionLoading, setAiCaptionLoading] = useState(false);
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
  const isMountedRef = useIsMounted();
  const autoLoadTimerRef = useRef(null);
  const cloudLoadRequestIdRef = useRef(0);
  // Single-flight guard for backup. Multiple effects can trigger startBackup
  // around the same time (foreground listener, auto-start timer, pending
  // photos effect) — without this lock the backup loop runs in parallel,
  // duplicating uploads.
  const backupInFlightRef = useRef(false);
  const backupWatchdogRef = useRef(null);
  const lastUserEmailRef = useRef(user?.email || '');

  // ⭐ Wipe in-memory state when the active account changes. Without this,
  // the previous account's photos stay painted on screen until the fresh
  // fetch returns — and any subscribed timers/WS handlers were keyed off
  // the old user.
  useEffect(() => {
    const cur = user?.email || '';
    if (lastUserEmailRef.current && cur && lastUserEmailRef.current !== cur) {
      setCloudPhotos([]);
      setDevicePhotos([]);
      setStorageInfo(null);
      setBackedUpTotal(0);
      cloudLoadRequestIdRef.current++;
      backupInFlightRef.current = false;
      cleanupBackupRefresh();
      if (autoLoadTimerRef.current) { clearTimeout(autoLoadTimerRef.current); autoLoadTimerRef.current = null; }
    }
    lastUserEmailRef.current = cur;
  }, [user?.email]);

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
  // Namespace cache keys by user.email so a previous account's photos can't
  // bleed into a new account after switching. Without this, the global
  // 'cloud_photos' / 'drive_storage_info' / 'photos_backed_up_total' keys
  // hold whichever data was written last → photo leak across accounts.
  const cacheKeyFor = (base) => `${base}_${user?.email || 'anon'}`;
  const loadCloudPhotos = useCallback(async (pageNum = 1, append = false) => {
    // Guard against parallel/stale requests on first page load
    const requestId = (pageNum === 1 && !append) ? ++cloudLoadRequestIdRef.current : cloudLoadRequestIdRef.current;
    const userToken = user?.email || '';
    try {
      // Show cached photos instantly on first load
      if (pageNum === 1 && !append) {
        const cached = await getCached(cacheKeyFor('cloud_photos'));
        if (cached && cached.length > 0) {
          if (requestId !== cloudLoadRequestIdRef.current) return;
          if (userToken !== (user?.email || '')) return; // account switched
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
      if (userToken !== (user?.email || '')) return; // account switched mid-flight
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
          // Always dedup (not just on append) — page-1 reload after a
          // cached paint can otherwise reintroduce duplicates if the
          // backend pagination shifts.
          const seen = new Set();
          const uniq = [];
          for (const p of sorted) {
            if (p && p.id != null && !seen.has(p.id)) { seen.add(p.id); uniq.push(p); }
          }
          setCloudPhotos(uniq);
          // Cache first page with 30min TTL for instant load next time
          if (pageNum === 1) setCache(cacheKeyFor('cloud_photos'), uniq, CLOUD_CACHE_TTL).catch(() => {});
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

  const [backupStats, setBackupStats] = useState(null); // { backed_up, backup_source, total_size, total_size_formatted }

  // GAP 9 — surface backup failures in a banner
  const [backupErrorCount, setBackupErrorCount] = useState(0);
  const [backupErrorVisible, setBackupErrorVisible] = useState(false);
  const loadStorageInfo = useCallback(async () => {
    const userToken = user?.email || '';
    try {
      // Show cached instantly
      const { getCached, setCache } = await import('../services/cache');
      const cached = await getCached(cacheKeyFor('drive_storage_info'));
      if (cached && !storageInfo) setStorageInfo(cached);
      // Also cache backedUpTotal
      const cachedCount = await getCached(cacheKeyFor('photos_backed_up_total'));
      if (cachedCount && !backedUpTotal) setBackedUpTotal(cachedCount);
      // Fetch fresh — both global storage AND photo-backup-specific stats
      const [res, statusRes] = await Promise.all([
        api.fileStorageInfo(),
        api.apiCall('drive_backup_status').catch(() => null),
      ]);
      if (userToken !== (user?.email || '')) return;
      if (res?.success) {
        setStorageInfo(res.data || res);
        setCache(cacheKeyFor('drive_storage_info'), res.data || res, 7776000000);
      }
      if (statusRes?.success && statusRes.data) {
        setBackupStats(statusRes.data);
      }
    } catch (e) {
      console.warn('Failed to load storage info:', e);
    }
  }, [user?.email]);

  const [photoError, setPhotoError] = useState(null);
  const deviceEndCursorRef = useRef(null);
  const deviceHasMoreRef = useRef(false);
  const deviceLoadingMoreRef = useRef(false);
  // deviceTotalCount and backedUpTotal from PhotosContext

  const loadDevicePhotos = useCallback(async () => {
    if (Platform.OS === 'web') return;

    try {
      const MediaLibrary = require('expo-media-library');
      // Read state without prompting first. With granular=true,
      // requestPermissionsAsync re-shows the iOS "Edit Selection" dialog every
      // call when the user is on Limited access — users were seeing the photo
      // permission popup on every login. Only prompt if status is undetermined.
      // granular=true eh iOS-only (Limited access). Android ignora e em
      // alguns casos da throw — passa undefined no Android (default).
      const granularArg = Platform.OS === 'ios' ? true : undefined;
      let perm = await MediaLibrary.getPermissionsAsync(granularArg);
      if (perm.status === 'undetermined') {
        perm = await MediaLibrary.requestPermissionsAsync(granularArg);
      }
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
    // Persist the include-videos preference too. Was state-only before:
    // mobile users couldn't durably opt out of video backup and the toggle
    // reset to `true` every cold start (potentially blowing through cell
    // data on launch).
    AsyncStorage.getItem('backup_include_videos').then(v => { if (v !== null) setBackupIncludeVideos(v === 'true'); }).catch(() => {});

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

  // Auto-correct stale 'complete' state when there are real pending photos.
  // Truth = device count − server count. The native scanLibrary `pendingCount`
  // can lie (UserDefaults inflated with phantom IDs from failed past
  // registrations), so it's not safe to gate on. If the user has 14k device
  // photos missing from the server, the screen MUST show needs_backup so the
  // engine restarts the loop.
  useEffect(() => {
    const dc = deviceTotalCount || 0;
    const realPending = Math.max(0, dc - (backedUpTotal || 0));
    if (dc > 0 && realPending > 5 && backupStatus === 'complete') {
      setBackupStatus('needs_backup');
    }
  }, [deviceTotalCount, backedUpTotal, backupStatus]);

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
      // CAP estimatedBackedUp at totalOnDevice — backedUpTotal can include
      // photos that have since been DELETED from the device (or were on a
      // different device in the same account). User reported the count
      // "doesn't go above 29779" because the cached server total was higher
      // than the current device library so pending always = 0.
      const rawBackedUp = backedUpTotal || backedUpCount || 0;
      const estimatedBackedUp = totalOnDevice > 0
        ? Math.min(rawBackedUp, totalOnDevice)
        : rawBackedUp;
      // If we don't know device total yet, try to get it now
      if (totalOnDevice === 0 && Platform.OS !== 'web') {
        try {
          const ML = require('expo-media-library');
          ML.getAssetsAsync({ mediaType: [ML.MediaType.photo, ML.MediaType.video], first: 1 })
            .then(r => { if (r?.totalCount > 0) setDeviceTotalCount(r.totalCount); })
            .catch(() => {});
        } catch {}
      }
      // Prefer native scanLibrary (it walks PHAssets and intersects with the
      // backedUpSet UserDefaults — catches photos the server thinks are
      // backed up but the user has retaken/deleted/added since.)
      let pending = totalOnDevice > 0 ? Math.max(0, totalOnDevice - estimatedBackedUp) : 0;
      try {
        const NativeUpload = (Platform.OS==='ios'?require('../modules/expo-background-upload').default:null);
        if (NativeUpload?.scanLibrary && totalOnDevice > 0) {
          NativeUpload.scanLibrary().then((res) => {
            if (res?.totalPending !== undefined) {
              setPendingCount(Math.max(0, res.totalPending));
            }
          }).catch(() => {});
        }
      } catch {}
      setPendingCount(pending);
      if (totalOnDevice > 0 && pending > 0 && backupStatus !== 'backing_up') {
        setBackupStatus('needs_backup');
        // Auto-start backup when there are pending photos. Previously fired
        // only once per mount (autoStartedRef never reset), so if the first
        // pass stopped (iOS killed the bg task, network blip, etc.) the user
        // had to tap manually. Now re-armed after 5 min so each screen focus
        // can retry while pending > 0.
        if (pending > 0 && autoBackupMod?.startForegroundBackup && !autoStartedRef.current) {
          autoStartedRef.current = true;
          setTimeout(() => {
            if (backupStatus !== 'backing_up') {
              setBackupStatus('backing_up');
              startBackup();
            }
          }, 3000);
          // Re-arm so a stalled pass can retry on the next focus/effect run.
          setTimeout(() => { autoStartedRef.current = false; }, 5 * 60 * 1000);
        }
      } else if (totalOnDevice > 0 && pending === 0 && estimatedBackedUp > 0) {
        // Pending hit 0 — flip to complete even if we were 'backing_up',
        // otherwise the "Backup em andamento" banner sticks while showing
        // the server count which can exceed device total.
        if (backupStatus !== 'complete') setBackupStatus('complete');
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
  // Stable id→index map so renderItem doesn't have to do an O(n) indexOf
  // for every cell — and so duplicate object identities (rare under
  // race conditions) don't return the wrong index and open the wrong photo.
  const photoIndexMap = useMemo(() => {
    const m = new Map();
    for (let i = 0; i < filteredPhotos.length; i++) {
      const p = filteredPhotos[i];
      if (p && p.id != null && !m.has(p.id)) m.set(p.id, i);
    }
    return m;
  }, [filteredPhotos]);

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
  // Force-clean and restart: wipes all backup locks (in-flight flag, native
  // URLSession tasks, watchdog, refresh timers) AND clears the local
  // "backed-up IDs" dedup map if it has drifted past what the server shows,
  // then kicks off a fresh run. Used by the "Reparar backup" button shown
  // when backup looks stalled.
  const repairBackup = useCallback(async () => {
    if (Platform.OS === 'web') return;
    try { (Platform.OS==='ios'?require('../modules/expo-background-upload').default:null)?.cancelAll?.(); } catch {}
    if (backupWatchdogRef.current) { clearInterval(backupWatchdogRef.current); backupWatchdogRef.current = null; }
    cleanupBackupRefresh();
    backupInFlightRef.current = false;
    backupAbortRef.current = false;
    autoStartedRef.current = false;

    // Drift check: if the JS/native dedup map claims >100 more photos backed
    // up than the server actually has, the dedup got corrupt and is making
    // native skip photos that were never really uploaded. Reset it.
    try {
      const r = await api.apiCall('drive_backup_count').catch(() => null);
      const serverCount = r?.data?.count || r?.data?.total || 0;
      const storage = require('../services/backup/backupStorage');
      const map = await storage.getBackedUpMap?.();
      const localSize = map ? Object.keys(map).length : 0;
      if (localSize > serverCount + 100) {
        if (autoBackupMod?.resetBackupHistory) await autoBackupMod.resetBackupHistory();
        try { (Platform.OS==='ios'?require('../modules/expo-background-upload').default:null)?.resetBackedUpIds?.(); } catch {}
        api.apiCall('drive_backup_debug', {
          msg: 'repair_drift_reset',
          data: `local=${localSize} server=${serverCount}`,
        }, 'POST').catch(() => {});
      }
    } catch {}

    setBackupStatus('idle');
    setBackupProgress({ current: 0, total: 0 });
    setTimeout(() => { setBackupStatus('backing_up'); startBackup(); }, 400);
  }, [cleanupBackupRefresh]);

  const startBackup = useCallback(async () => {
    if (Platform.OS === 'web') return;
    if (!autoBackupMod?.startForegroundBackup) {
      safeAlert('Backup', 'Módulo de backup não disponível. Atualize o app.');
      return;
    }
    // PRE-CHECK: só começa backup se tiver pending real.
    // User reportou que "backup feito não para de subir tá duplicando" —
    // a gente rodava rounds até o native retornar zero uploads 5x seguido,
    // mesmo que o server já tivesse tudo. Verifica antes: se device count
    // <= server count, está completo. Só dispara native se falta algo.
    try {
      const preCheck = await api.apiCall('drive_backup_count').catch(() => null);
      const serverCount = preCheck?.data?.count || preCheck?.data?.total || 0;
      const dt = deviceTotalCount || devicePhotos.length || 0;
      if (serverCount > 0) setBackedUpTotal(serverCount);
      if (dt > 0 && serverCount >= dt) {
        // Tudo já no servidor — marca complete e sai sem rodar o native.
        console.log('[backup] Pre-check: device=' + dt + ' server=' + serverCount + ' — nothing pending, skipping');
        setBackupStatus('complete');
        setBackupProgress({ current: dt, total: dt });
        return;
      }
    } catch {}

    // Single-flight: ignore re-entry while a backup loop is running.
    // Without this, foreground listener + auto-start timer + pending-photo
    // effect can all fire startBackup near-simultaneously and run multiple
    // backup loops in parallel (duplicate uploads, leaked timers).
    if (backupInFlightRef.current) {
      // Stuck-detection: if a previous run has been "in flight" for >5min without
      // any progress tick, it's hung (native URLSession stalled, iCloud photo
      // fetch frozen, etc). Force-release so the user can retry.
      const since = backupInFlightRef.current._startedAt || 0;
      if (since && Date.now() - since > 5 * 60 * 1000) {
        try { (Platform.OS==='ios'?require('../modules/expo-background-upload').default:null)?.cancelAll?.(); } catch {}
        backupInFlightRef.current = false;
        cleanupBackupRefresh();
      } else {
        return;
      }
    }
    backupInFlightRef.current = { _startedAt: Date.now() };

    backupAbortRef.current = false;
    setBackupStatus('backing_up');
    setBackupProgress({ current: 0, total: 0 });
    uploadSpeedRef.current = { bytes: 0, startTime: Date.now(), lastSpeed: 0 };

    // Watchdog: if backup makes no progress for 3 min, assume the native
    // session hung (common symptoms: iCloud photo stuck fetching, server
    // returning 502s in a loop, background task expired mid-upload). Cancel
    // all native tasks and reset JS state so the user can retry immediately.
    let lastProgressAt = Date.now();
    let lastProgressCount = 0;
    if (backupWatchdogRef.current) clearInterval(backupWatchdogRef.current);
    backupWatchdogRef.current = setInterval(() => {
      const stale = Date.now() - lastProgressAt > 3 * 60 * 1000;
      if (stale) {
        try { (Platform.OS==='ios'?require('../modules/expo-background-upload').default:null)?.cancelAll?.(); } catch {}
        backupAbortRef.current = true;
        backupInFlightRef.current = false;
        cleanupBackupRefresh();
        clearInterval(backupWatchdogRef.current);
        backupWatchdogRef.current = null;
        setBackupStatus('paused');
      }
    }, 30000);

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
            // If count hasn't changed for 5 min (30 polls of 10s), the server
            // isn't receiving new uploads. But only mark 'complete' if device
            // count is actually matched — previously this set 'complete'
            // even with hundreds of photos still pending because the
            // foreground loop had nothing to enqueue (drift/iCloud optimized).
            if (staleCount >= 30) {
              clearInterval(refreshTimer);
              const dt = deviceTotalCount || devicePhotos.length || 0;
              if (dt > 0 && t >= dt) {
                setBackupStatus('complete');
              } else {
                setBackupStatus('needs_backup');
              }
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
          // Progress tick — resets the watchdog timer each time a photo completes
          if (current > lastProgressCount) {
            lastProgressAt = Date.now();
            lastProgressCount = current;
          }
          setBackupProgress({ current: totalUploaded + current, total: 43000 }); // estimate
        });

        const uploaded = result?.uploaded || result?.completedFiles || 0;
        totalUploaded += uploaded;

        // Stop conditions
        if (result?.error === 'permission_denied' || result?.error === 'web_unsupported') {
          break;
        }
        if (uploaded === 0) {
          // Nothing new uploaded this round — but that doesn't mean we're
          // done if the device still has pending photos. iOS throttles
          // background task budgets heavily; each startNativeBackup call
          // can exit early after a handful of uploads when iOS decides
          // we've had enough for now. Previously we'd break on the first
          // zero round and stop — user saw the "Fazendo backup" banner
          // flash then disappear with nothing uploaded. Now we retry with
          // backoff up to 5 times before giving up; the heartbeat already
          // logs drift so we'll still see stuck states in the server log.
          const checkRes = await api.apiCall('drive_backup_count').catch(() => null);
          const serverCount = checkRes?.data?.count || 0;
          if (serverCount > 0) setBackedUpTotal(serverCount);
          const dt = (deviceTotalCount || 0);
          const pendingNow = Math.max(0, dt - serverCount);
          try {
            if (pendingNow > 0) {
              const localMap = await require('../services/backup/backupStorage').getBackedUpMap?.();
              const localSize = localMap ? Object.keys(localMap).length : -1;
              api.apiCall('drive_backup_debug', {
                msg: 'native_zero_still_pending',
                data: `round=${round} device=${dt} server=${serverCount} pending=${pendingNow} localMap=${localSize} result=${JSON.stringify(result || {}).slice(0, 180)}`,
              }, 'POST').catch(() => {});
            }
          } catch {}
          // Really done? (device count <= server count → yes, stop).
          if (pendingNow <= 0) break;
          // Track consecutive zero rounds and bail after a few so we
          // don't hot-spin forever when native is permanently stuck.
          if (!startBackup._zeroStreak) startBackup._zeroStreak = 0;
          startBackup._zeroStreak += 1;
          if (startBackup._zeroStreak >= 5) {
            startBackup._zeroStreak = 0;
            break;
          }
          // Exponential-ish backoff between retries so we don't hammer
          // iOS while it's throttling us: 2s, 4s, 8s, 15s, 25s.
          const waits = [2000, 4000, 8000, 15000, 25000];
          await new Promise(r => setTimeout(r, waits[startBackup._zeroStreak - 1] || 25000));
          continue;
        }
        // Good round — reset the zero-streak and pause briefly before next.
        startBackup._zeroStreak = 0;
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
        // Surface to user via banner + Alert (GAP 9)
        setBackupErrorCount(c => c + 1);
        setBackupErrorVisible(true);
        safeAlert('Erro no backup', mapApiError(result, t, 'photos'));
        clearInterval(refreshTimer);
        cleanupBackupRefresh();
        setBackupStatus('needs_backup');
        return;
      }
      if (result.alreadyComplete) {
        clearInterval(refreshTimer);
        cleanupBackupRefresh();
        // Only say "complete" if the server count actually caught up to the
        // device count. alreadyComplete just means "nothing queued this run"
        // which is not the same as "all your photos are on the server".
        const dt = deviceTotalCount || devicePhotos.length || 0;
        const cnt = await api.apiCall('drive_backup_count').then(r => r?.data?.count || r?.data?.total || 0).catch(() => 0);
        setBackupStatus(dt > 0 && cnt >= dt ? 'complete' : 'needs_backup');
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
        // Post-loop status:
        //  - uploaded > 0 → progress was made, keep refresh timer + status
        //  - uploaded = 0 AND server >= device (rare, user deleted local) → complete
        //  - uploaded = 0 AND device > server → KEEP status as 'needs_backup'
        //    so the user sees the pending count and the 'Reparar' button
        //    remains visible. Previously we marked 'complete' on a 10-photo
        //    tolerance, which misled the user into thinking backup was done
        //    while hundreds of photos were still pending.
        const r = await api.apiCall('drive_backup_count').catch(() => null);
        const freshServer = r?.data?.count || r?.data?.total || 0;
        if (freshServer > 0) setBackedUpTotal(freshServer);
        const dt = deviceTotalCount || devicePhotos.length || 0;
        const remaining = Math.max(0, dt - freshServer);
        if (totalUploaded > 0) setLastBackupDate(new Date().toISOString());
        if (remaining <= 0) {
          clearInterval(refreshTimer);
          cleanupBackupRefresh();
          setBackupStatus('complete');
          setLastBackupDate(new Date().toISOString());
        } else {
          // Device still has pending photos — KEEP the status as
          // 'backing_up' (banner stays visible) and schedule the next
          // round. iOS will re-grant BG budget eventually; without a
          // persistent UI signal the user assumed backup had died. We
          // cap at 20 re-schedulings so a broken session eventually
          // releases the lock and a fresh tap of "Backup agora" can
          // try from scratch.
          if (!startBackup._retrySchedule) startBackup._retrySchedule = 0;
          startBackup._retrySchedule += 1;
          setBackupStatus('backing_up');
          if (startBackup._retrySchedule < 20) {
            setTimeout(() => {
              if (!backupAbortRef.current && backupInFlightRef.current) {
                startBackup._retrySchedule = 0;
                // force-unlock + relaunch
                backupInFlightRef.current = false;
                startBackup();
              } else if (!backupAbortRef.current) {
                backupInFlightRef.current = false;
                startBackup._retrySchedule = 0;
                startBackup();
              }
            }, 45000); // 45s wait before the next attempt
          } else {
            // Give up for this session — user can tap Reparar.
            startBackup._retrySchedule = 0;
            clearInterval(refreshTimer);
            cleanupBackupRefresh();
            setBackupStatus('needs_backup');
          }
        }
      }
    } catch (e) {
      console.warn('[backup] startBackup error:', e);
      // Surface to user via banner (GAP 9) — silent failure was hiding upload errors
      setBackupErrorCount(c => c + 1);
      setBackupErrorVisible(true);
      clearInterval(refreshTimer);
      cleanupBackupRefresh();
      setBackupStatus('needs_backup');
    }
    // Final refresh
    api.apiCall('drive_backup_count').then(r => {
      const t = r?.data?.count || r?.data?.total || 0;
      if (t > 0) setBackedUpTotal(t);
    }).catch(() => {});
    backupInFlightRef.current = false;
    if (backupWatchdogRef.current) { clearInterval(backupWatchdogRef.current); backupWatchdogRef.current = null; }
  }, [loadCloudPhotos]);

  const pauseBackup = useCallback(() => {
    backupAbortRef.current = true;
    backupInFlightRef.current = false;
    if (autoBackupMod?.pause) autoBackupMod.pause();
    setBackupStatus('needs_backup');
  }, []);

  // GAP 9 — retry backup after a surfaced failure
  const retryBackup = useCallback(() => {
    setBackupErrorVisible(false);
    setBackupErrorCount(0);
    backupAbortRef.current = false;
    backupInFlightRef.current = false;
    if (Platform.OS !== 'web') startBackup();
  }, [startBackup]);

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
      // Fresh activation: clear BOTH dedup caches so the engine re-scans
      // every device asset against truth (server). Without this, the JS
      // engine's startForegroundBackup unions the local backedUpMap (which
      // can be poisoned with phantom IDs from old failed registrations)
      // with server-confirmed IDs, then setBackedUpIds(union) tells native
      // to skip everything → zero uploads.
      //
      //   1. Native UserDefaults: com.onemundo.backedUpAssets
      //   2. JS AsyncStorage:     @chatyy_backup/backed_up_map
      //
      // Server-side dedup (drive_precheck_asset_ids by md5(assetId) tag)
      // re-establishes truth in the next backup pass; we don't lose info,
      // we just stop trusting stale local guesses.
      try {
        const NativeUpload = (Platform.OS==='ios'?require('../modules/expo-background-upload').default:null);
        NativeUpload?.resetBackedUpIds?.();
      } catch {}
      try {
        const storage = require('../services/backup/backupStorage');
        storage.clearBackedUpMap?.().catch(() => {});
      } catch {}
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

  // Pinch-zoom + swipe-between-photos state for the viewer.
  // - baseScale: committed zoom (1, 2, or pinch-end value), animated for spring
  // - pinchScale: live gesture multiplier (resets to 1 between gestures)
  // - displayScale = baseScale * pinchScale (used in transform)
  // - panX: horizontal translation while pan-gesturing between photos at zoom=1
  // - lastTapRef: timestamp of last tap (double-tap detection)
  const baseScale = useRef(new Animated.Value(1)).current;
  const pinchScale = useRef(new Animated.Value(1)).current;
  const lastBaseScaleRef = useRef(1);
  const panX = useRef(new Animated.Value(0)).current;
  const lastTapRef = useRef(0);

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

  // Reset AI caption when photo changes
  useEffect(() => {
    setAiCaption('');
    setAiCaptionLoading(false);
  }, [viewerPhoto?.id || viewerPhoto?.uri || viewerIndex]);

  // Generate AI caption from photo metadata (size, date, location, type)
  const generateAiCaption = useCallback(async () => {
    if (!viewerPhoto || aiCaptionLoading) return;
    setAiCaptionLoading(true);
    try {
      let dateStr = '';
      try {
        const d = new Date(viewerPhoto.created_at || viewerPhoto.uploaded_at || viewerPhoto.modificationTime || Date.now());
        dateStr = d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
      } catch {}
      const location = viewerPhoto.location || viewerPhoto.locationName || '';
      const dims = viewerPhoto.width && viewerPhoto.height ? `${viewerPhoto.width}x${viewerPhoto.height}` : '';
      const description = `${viewerPhoto.name || 'foto'} (${dims})`;
      const r = await api.aiPhotoCaption(description, location, dateStr);
      if (r?.success && r.data?.caption) setAiCaption(r.data.caption);
    } catch {} finally {
      setAiCaptionLoading(false);
    }
  }, [viewerPhoto, aiCaptionLoading]);

  const navigateViewer = useCallback((dir) => {
    const next = viewerIndex + dir;
    if (next >= 0 && next < filteredPhotos.length) {
      setViewerIndex(next);
      setViewerStarred(!!filteredPhotos[next]?.starred);
      setViewerResolvedUri(null); // reset so getFullUrl resolves new photo
      // Reset zoom + pan when switching photos
      baseScale.setValue(1);
      pinchScale.setValue(1);
      lastBaseScaleRef.current = 1;
      panX.setValue(0);
    }
  }, [viewerIndex, filteredPhotos, baseScale, pinchScale, panX]);

  // Reset zoom whenever the viewer opens or photo changes (defensive — also
  // covered by navigateViewer, but openViewer skips that path).
  useEffect(() => {
    if (!viewerVisible) return;
    baseScale.setValue(1);
    pinchScale.setValue(1);
    lastBaseScaleRef.current = 1;
    panX.setValue(0);
  }, [viewerVisible, viewerIndex, baseScale, pinchScale, panX]);

  // Pinch handler: pinchScale tracks the live gesture (1 = no zoom),
  // displayed scale is baseScale * pinchScale; on release we commit
  // base * gesture into baseScale (clamped 1..4) and reset pinchScale.
  const onPinchEvent = Animated.event(
    [{ nativeEvent: { scale: pinchScale } }],
    { useNativeDriver: false }
  );
  const onPinchStateChange = useCallback((e) => {
    if (!GHState) return;
    if (e.nativeEvent.oldState === GHState.ACTIVE) {
      const committed = Math.max(1, Math.min(4, lastBaseScaleRef.current * (e.nativeEvent.scale || 1)));
      lastBaseScaleRef.current = committed;
      pinchScale.setValue(1);
      Animated.spring(baseScale, {
        toValue: committed,
        friction: 7,
        tension: 50,
        useNativeDriver: false,
      }).start();
    }
  }, [baseScale, pinchScale]);

  // Pan handler: only consume horizontal swipes when NOT zoomed (so panning
  // a zoomed photo doesn't accidentally page). When released past threshold,
  // navigate next/prev.
  const onPanEvent = Animated.event(
    [{ nativeEvent: { translationX: panX } }],
    { useNativeDriver: false }
  );
  const onPanStateChange = useCallback((e) => {
    if (!GHState) return;
    if (e.nativeEvent.oldState === GHState.ACTIVE) {
      const tx = e.nativeEvent.translationX || 0;
      const vx = e.nativeEvent.velocityX || 0;
      const zoomed = lastBaseScaleRef.current > 1.05;
      const SWIPE_THRESHOLD = 80;
      if (!zoomed && (Math.abs(tx) > SWIPE_THRESHOLD || Math.abs(vx) > 600)) {
        if (tx < 0) navigateViewer(1);
        else navigateViewer(-1);
      }
      // Always snap pan back to 0
      Animated.spring(panX, { toValue: 0, friction: 8, tension: 60, useNativeDriver: false }).start();
    }
  }, [panX, navigateViewer]);

  // Double-tap to toggle 2x zoom (or reset)
  const onImageTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTapRef.current < 280) {
      const target = lastBaseScaleRef.current > 1.05 ? 1 : 2;
      lastBaseScaleRef.current = target;
      Animated.spring(baseScale, {
        toValue: target,
        friction: 6,
        tension: 50,
        useNativeDriver: false,
      }).start();
      lastTapRef.current = 0;
    } else {
      lastTapRef.current = now;
    }
  }, [baseScale]);

  const deleteViewerPhoto = useCallback(async () => {
    if (!viewerPhoto) return;
    const isDevice = viewerPhoto.id?.startsWith('device_');
    const isCloud = !isDevice;

    const buttons = [{ text: t('common.cancel'), style: 'cancel' }];

    if (isCloud) {
      // Cloud photo - delete from our server
      buttons.push({
        text: t('photos.deleteFromCloud') || 'Deletar da nuvem',
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
        text: t('photos.removeBackup') || 'Remover do backup',
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
  const viewerResolveTokenRef = useRef(0);

  const getFullUrl = useCallback((photo) => {
    if (!photo.isDevice) return photo.cdn_url || api.fileDownloadUrl(photo.id);
    // For device photos, resolve localUri for the viewer
    if (Platform.OS === 'ios' && photo.uri?.startsWith('ph://')) {
      const assetId = photo.uri.replace('ph://', '').split('/')[0];
      const ML = require('expo-media-library');
      // Tag this resolve with a token + the requesting photo's id. Rapid
      // swipes can race ML.getAssetInfoAsync resolutions; only commit the
      // result if the user is still on the SAME photo (and this is the
      // latest token).
      const token = ++viewerResolveTokenRef.current;
      const requestedId = photo.id;
      ML.getAssetInfoAsync(assetId).then(info => {
        if (token !== viewerResolveTokenRef.current) return;
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
    // Includes 1-col fullbleed mode (Google Photos: pinch-out to one column)
    const options = isDesktop ? [1, 3, 4, 5, 6] : [1, 3, 4, 5];
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
        <View style={[s.backupBanner, { backgroundColor: isDark ? '#172554' : '#F5F3FF', borderColor: colors.primary + '40' }]}>
          <View style={s.backupBannerLeft}>
            <IconCloudUpload size={20} color={colors.primary} />
            <View style={{ marginLeft: 10, flex: 1 }}>
              <Text style={[s.backupBannerTitle, { color: colors.text }]}>
                {Math.min(backedUpTotal, deviceCount || backedUpTotal)} de {deviceCount} fotos salvas
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

    // Only render "Backup completo" banner when device really is caught up.
    // Source of truth = deviceCount − serverCount, NOT the native
    // scanLibrary pendingCount (UserDefaults can be stale/inflated).
    const _bannerDeviceCount = deviceTotalCount || devicePhotos.length || 0;
    const _bannerRealPending = Math.max(0, _bannerDeviceCount - (backedUpTotal || 0));
    if (backupStatus === 'complete' && _bannerRealPending === 0 && _bannerDeviceCount > 0) {
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
          <View style={[s.backupBanner, { backgroundColor: isDark ? '#172554' : '#F5F3FF', borderColor: colors.primary + '40' }]}>
            <View style={s.backupBannerLeft}>
              <ActivityIndicator size="small" color={colors.primary} />
              <View style={{ marginLeft: 10, flex: 1 }}>
                <Text style={[s.backupBannerTitle, { color: colors.text }]}>Verificando fotos...</Text>
              </View>
            </View>
          </View>
        );
      }
      // Cap backedUpTotal at deviceCount so a stale server count (e.g. 29779
      // photos historically uploaded but only 9 currently on device) doesn't
      // make pending bogus. Without this, pending always = 0 once
      // backedUpTotal exceeds deviceCount, and the screen claims "complete"
      // even when there are photos that aren't really backed up.
      const cappedBackedUp = Math.min(deviceCount, backedUpTotal || 0);
      const pending = Math.max(0, deviceCount - cappedBackedUp);
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
      // ─── Google-Photos-style backup banner ───────────────────────
      // Three states: idle (with start button), scanning, uploading.
      // Each shows the appropriate live data: scan count, ETA, speed, "keep open" tip.
      const isScanning = backupPhase === 'scanning';
      const isUploading = backupPhase === 'uploading' || (uploadStats.total > 0 && uploadStats.uploaded < uploadStats.total);
      const progressPct = uploadStats.totalBytes > 0
        ? Math.min(100, Math.round((uploadStats.bytesUploaded / uploadStats.totalBytes) * 100))
        : (uploadStats.total > 0 ? Math.round((uploadStats.uploaded / uploadStats.total) * 100) : 0);

      if (isScanning) {
        return (
          <View style={[s.backupBanner, { backgroundColor: isDark ? '#0c1f3a' : '#F5F3FF', borderColor: colors.primary + '40', flexDirection: 'column', alignItems: 'stretch' }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={{ marginLeft: 10, fontSize: 14, fontWeight: '600', color: colors.text, flex: 1 }}>
                Escaneando biblioteca...
              </Text>
              <Text style={{ fontSize: 12, color: colors.textSecondary }}>
                {scanState.scanned}/{scanState.total}
              </Text>
            </View>
            <View style={{ height: 4, backgroundColor: colors.border, borderRadius: 2, overflow: 'hidden' }}>
              <View style={{
                height: 4,
                width: `${scanState.total > 0 ? (scanState.scanned / scanState.total) * 100 : 0}%`,
                backgroundColor: colors.primary,
              }} />
            </View>
            <Text style={{ fontSize: 11, color: colors.textSecondary, marginTop: 6 }}>
              {scanState.pending} fotos pendentes • {fmtBytes(scanState.pendingBytes)}
            </Text>
          </View>
        );
      }

      if (isUploading) {
        return (
          <View style={[s.backupBanner, { backgroundColor: isDark ? '#0c1f3a' : '#F5F3FF', borderColor: colors.primary + '40', flexDirection: 'column', alignItems: 'stretch' }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
              <IconCloudUpload size={20} color={colors.primary} />
              <Text style={{ marginLeft: 10, fontSize: 14, fontWeight: '600', color: colors.text, flex: 1 }}>
                Fazendo backup
              </Text>
              <Text style={{ fontSize: 13, fontWeight: '700', color: colors.primary }}>{progressPct}%</Text>
            </View>
            <View style={{ height: 6, backgroundColor: colors.border, borderRadius: 3, overflow: 'hidden' }}>
              <View style={{
                height: 6,
                width: `${progressPct}%`,
                backgroundColor: colors.primary,
                borderRadius: 3,
              }} />
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
              <Text style={{ fontSize: 11, color: colors.textSecondary }}>
                {uploadStats.uploaded} de {uploadStats.total} • {fmtBytes(uploadStats.bytesUploaded)} / {fmtBytes(uploadStats.totalBytes)}
              </Text>
              <Text style={{ fontSize: 11, color: colors.textSecondary, fontWeight: '600' }}>
                {fmtSpeed(uploadStats.bytesPerSec)}
              </Text>
            </View>
            <Text style={{ fontSize: 11, color: colors.primary, marginTop: 4, fontWeight: '600' }}>
              {fmtEta(uploadStats.etaSec)}
            </Text>
            <View style={{
              flexDirection: 'row', alignItems: 'center', marginTop: 10,
              paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border + '60',
            }}>
              <Text style={{ fontSize: 11, color: colors.textTertiary, flex: 1 }}>
                💡 Mantenha o app aberto para um backup mais rápido
              </Text>
            </View>
          </View>
        );
      }

      // Has pending photos - show start button
      return (
        <View style={[s.backupBanner, { backgroundColor: isDark ? '#172554' : '#F5F3FF', borderColor: colors.primary + '40' }]}>
          <View style={s.backupBannerLeft}>
            <IconCloudUpload size={20} color={colors.primary} />
            <View style={{ marginLeft: 10, flex: 1 }}>
              <Text style={[s.backupBannerTitle, { color: colors.text }]}>
                {Math.min(backedUpTotal, deviceCount || backedUpTotal)} de {deviceCount} fotos salvas
              </Text>
              {storageText ? <Text style={[s.backupBannerSub, { color: colors.textSecondary }]}>{storageText}</Text> : null}
            </View>
          </View>
          <TouchableOpacity
            style={[s.backupBtn, { backgroundColor: colors.primary }]}
            onPress={async () => {
              // Trigger native scan first if available — instant Google-Photos UX
              if (Platform.OS === 'ios') {
                try {
                  const NativeUpload = (Platform.OS==='ios'?require('../modules/expo-background-upload').default:null);
                  if (NativeUpload?.scanLibrary) {
                    setBackupPhase('scanning');
                    NativeUpload.scanLibrary().catch(() => {});
                  }
                } catch {}
              }
              startBackup();
            }}
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

        {/* Favorite heart overlay (Google Photos style) — top-right */}
        {photo.starred && !sm && (
          <View style={s.favoriteOverlay} pointerEvents="none">
            <View style={s.favoriteOverlayShadow} />
            <Svg width={16} height={16} viewBox="0 0 24 24">
              <Path
                d="M12 21s-7-4.35-7-10a4.5 4.5 0 018-2.83A4.5 4.5 0 0119 11c0 5.65-7 10-7 10z"
                fill="#fff"
                stroke="rgba(0,0,0,0.18)"
                strokeWidth={1}
              />
            </Svg>
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
  const renderSectionHeader = useCallback(({ section }) => {
    // Total photos in this section (sum across rows)
    let total = 0;
    try {
      (section.data || []).forEach(row => { total += row?.items?.length || 0; });
    } catch {}
    return (
      <View
        style={[
          s.sectionHeader,
          {
            backgroundColor: isDark
              ? 'rgba(15,23,42,0.92)'
              : 'rgba(255,255,255,0.92)',
          },
        ]}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ width: 3, height: 14, borderRadius: 2, backgroundColor: '#7C3AED' }} />
          <Text
            style={[
              s.sectionTitle,
              {
                color: colors.text,
                fontSize: 15,
                fontWeight: '700',
                letterSpacing: -0.2,
              },
            ]}
            numberOfLines={1}
          >
            {section.title}
          </Text>
        </View>
        {total > 0 && (
          <Text style={[s.sectionCount, { color: colors.textSecondary, fontWeight: '600' }]}>
            {total}
          </Text>
        )}
      </View>
    );
  }, [colors, t, isDark]);

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
                <IconImage size={48} color={isDark ? '#818cf8' : '#A78BFA'} />
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
      // Includes 1 (fullbleed) — Google Photos pinch-out goes all the way to one big photo
      const options = isDesktop ? [1, 3, 4, 5, 6, 7] : [1, 3, 4, 5];
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
                // Use the precomputed id→index map (O(1)) instead of
                // an O(n) indexOf that returns the FIRST matching object
                // and could open a wrong photo under duplicates.
                const absIdx = photoIndexMap.get(photo.id) ?? -1;
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
              {/* Memories — Google Photos-grade horizontal carousel (280×140 with gradient overlay) */}
              {!searchText && !showFavorites && (memoriesData.length > 0 || filteredPhotos.length > 6) && (
                <View style={{ marginTop: 4, marginBottom: 4 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.lg, marginBottom: 10 }}>
                    <Text style={[s.sectionTitle, { color: colors.text, fontSize: 17, letterSpacing: -0.3 }]}>
                      {t('photos.memories') || 'Memórias'}
                    </Text>
                    <View style={{ flex: 1 }} />
                    <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: '#7C3AED', marginRight: 6 }} />
                    <Text style={{ fontSize: 12, color: colors.textSecondary, fontWeight: '600' }}>
                      {(memoriesData.length || 0) + 3}
                    </Text>
                  </View>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ paddingHorizontal: Spacing.md, paddingRight: Spacing.lg, gap: 10 }}
                    decelerationRate="fast"
                    snapToInterval={290}
                  >
                    {/* "1 ano atrás" / "X anos atrás" cards from real memories */}
                    {memoriesData.slice(0, 4).map((mem, idx) => {
                      const cover = mem.photos[0];
                      const coverUri = cover ? (cover.isDevice && Platform.OS === 'ios'
                        ? cover.uri
                        : getThumbnailUrl(cover)) : null;
                      const label = mem.yearsAgo === 1
                        ? (t('photos.yearsAgo', { n: 1 }) || '1 ano atrás')
                        : (t('photos.yearsAgoPlural', { n: mem.yearsAgo }) || `${mem.yearsAgo} anos atrás`);
                      return (
                        <Pressable
                          key={`mem-${mem.yearsAgo}`}
                          style={[s.memoryCardLg, { backgroundColor: colors.surface }]}
                          onPress={() => {
                            // Jump into first photo of memory bucket
                            const idx0 = filteredPhotos.findIndex(p => p.id === cover?.id);
                            if (idx0 >= 0) openViewer(idx0);
                          }}
                        >
                          {coverUri ? (
                            <Image source={{ uri: coverUri }} style={s.memoryCoverLg} resizeMode="cover" />
                          ) : (
                            <View style={[s.memoryCoverLg, { backgroundColor: colors.surfaceVariant, alignItems: 'center', justifyContent: 'center' }]}>
                              <IconImage size={32} color={colors.textTertiary} />
                            </View>
                          )}
                          <View style={s.memoryGradient} pointerEvents="none" />
                          <View style={s.memoryGradient2} pointerEvents="none" />
                          <View style={s.memoryBadge}>
                            <Text style={s.memoryBadgeText}>{mem.photos.length}</Text>
                          </View>
                          <View style={s.memoryTextWrap}>
                            <Text style={s.memoryTitleLg} numberOfLines={1}>{label}</Text>
                            <Text style={s.memorySubLg} numberOfLines={1}>{mem.photos.length} {t('photos.items') || 'fotos'}</Text>
                          </View>
                        </Pressable>
                      );
                    })}
                    {/* Curated preset cards: "Verão 2025" / "Esta semana" / "Pessoas" */}
                    {[
                      { key: 'summer', title: 'Verão 2025', sub: 'Os melhores momentos', tint: ['#7C3AED', '#EC4899'] },
                      { key: 'thisweek', title: 'Esta semana', sub: 'Novas memórias', tint: ['#0EA5E9', '#7C3AED'] },
                      { key: 'people', title: 'Pessoas', sub: 'Quem aparece mais', tint: ['#F59E0B', '#7C3AED'] },
                    ].map((preset, idx) => {
                      const cover = filteredPhotos[(idx + 1) * 3] || filteredPhotos[idx] || null;
                      const coverUri = cover ? (cover.isDevice && Platform.OS === 'ios' ? cover.uri : getThumbnailUrl(cover)) : null;
                      return (
                        <Pressable
                          key={`preset-${preset.key}`}
                          style={[s.memoryCardLg, { backgroundColor: preset.tint[0] }]}
                          onPress={() => {
                            const idx0 = filteredPhotos.findIndex(p => p.id === cover?.id);
                            if (idx0 >= 0) openViewer(idx0);
                          }}
                        >
                          {coverUri ? (
                            <Image source={{ uri: coverUri }} style={[s.memoryCoverLg, { opacity: 0.78 }]} resizeMode="cover" />
                          ) : null}
                          <View style={[s.memoryGradient, { backgroundColor: preset.tint[0] + '40' }]} pointerEvents="none" />
                          <View style={s.memoryGradient2} pointerEvents="none" />
                          <View style={s.memoryTextWrap}>
                            <Text style={s.memoryTitleLg} numberOfLines={1}>{preset.title}</Text>
                            <Text style={s.memorySubLg} numberOfLines={1}>{preset.sub}</Text>
                          </View>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
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
    const rawBackedUp = backedUpTotal || 0; // confirmed on server (can exceed device when user deleted local copies or has limited photo permission)
    // Cap displayed "backed up" at device total so the math always makes sense.
    const backedUpCount = deviceCount > 0 ? Math.min(rawBackedUp, deviceCount) : rawBackedUp;
    const totalPhotos = deviceCount;
    const pendingPhotos = Math.max(0, deviceCount - rawBackedUp);

    // Live heartbeat so we can see from the server exactly what the phone
    // thinks every time this screen is alive. Throttled to once per 30s.
    // Also auto-repairs when it detects a corrupt local dedup map: if the
    // server says we have N backed up but the phone's local map has far
    // fewer entries, the native layer will iterate past all the already-
    // backed-up photos trying to re-upload them, wasting bandwidth and
    // blocking the real pending ones. Resetting the map + native list
    // forces a fresh scan so progress can actually happen.
    const _lastHbRef = backupWatchdogRef; // reuse existing ref holder
    (function sendHeartbeat() {
      try {
        if (Platform.OS === 'web') return;
        const now = Date.now();
        if (_lastHbRef._lastHb && now - _lastHbRef._lastHb < 30000) return;
        _lastHbRef._lastHb = now;
        (async () => {
          try {
            let localMapSize = -1;
            try {
              const storage = require('../services/backup/backupStorage');
              const map = await storage.getBackedUpMap?.();
              localMapSize = map ? Object.keys(map).length : 0;
            } catch {}
            let permStatus = 'unknown';
            try {
              const ML = require('expo-media-library');
              const p = await ML.getPermissionsAsync();
              permStatus = p?.status + (p?.accessPrivileges ? ':' + p.accessPrivileges : '');
            } catch {}
            let nativeActive = -1;
            try {
              const NU = (Platform.OS==='ios'?require('../modules/expo-background-upload').default:null);
              nativeActive = (await NU?.getActiveCount?.()) ?? -1;
            } catch {}
            api.apiCall('drive_backup_debug', {
              msg: 'photos_screen_heartbeat',
              data: `device=${deviceCount} server=${backedUpCount} pending=${pendingPhotos} status=${backupStatus} localMap=${localMapSize} nativeActive=${nativeActive} perm=${permStatus} inFlight=${!!backupInFlightRef.current}`,
            }, 'POST').catch(() => {});

            // (removed auto-reset on drift — it triggered Swift to re-upload
            // 34k photos that already exist on server, causing ON CONFLICT
            // UPDATEs with zero real progress. Instead we rely on the server
            // to stamp those UPDATEs fast and move on; the 'Reparar backup'
            // button remains available if the user wants to force a reset.)
          } catch {}
        })();
      } catch {}
    })();

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
            {backupStatus === 'backing_up' && (() => {
              const total = deviceTotalCount || devicePhotos.length || 0;
              const cur = Math.min(backedUpTotal || 0, total || (backedUpTotal || 0));
              const pct = total > 0 ? Math.min((cur / total) * 100, 100) : 0;
              return (
                <View style={[s.card, { backgroundColor: isDark ? '#172554' : '#F5F3FF', borderColor: colors.primary + '40', marginBottom: Spacing.md }]}>
                  <View style={{ padding: 16 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                      <ActivityIndicator size="small" color={colors.primary} />
                      <Text style={{ color: colors.text, fontWeight: '600', fontSize: 15, flex: 1 }}>
                        {cur} de {total} fotos
                      </Text>
                      <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 14 }}>
                        {Math.round(pct)}%
                      </Text>
                    </View>
                    <View style={[s.progressBar, { backgroundColor: colors.border }]}>
                      <View style={[s.progressFill, { width: `${pct}%`, backgroundColor: colors.primary }]} />
                    </View>
                  </View>
                </View>
              );
            })()}
            {backupStatus === 'complete' && pendingPhotos === 0 && (
              <View style={[s.card, { backgroundColor: isDark ? '#052e16' : '#f0fdf4', borderColor: '#22c55e40', marginBottom: Spacing.md }]}>
                <View style={{ padding: 16, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <IconCheck size={20} color="#22c55e" />
                  <Text style={{ color: '#22c55e', fontWeight: '600' }}>Backup completo!</Text>
                </View>
              </View>
            )}
            {backupStatus === 'paused' && (
              <View style={[s.card, { backgroundColor: isDark ? '#451a03' : '#fef3c7', borderColor: '#d97706', marginBottom: Spacing.md }]}>
                <View style={{ padding: 16, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Text style={{ fontSize: 20 }}>⏸</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: isDark ? '#fbbf24' : '#92400e', fontWeight: '700', fontSize: 14 }}>Backup pausado</Text>
                    <Text style={{ color: isDark ? '#fde68a' : '#78350f', fontSize: 12, marginTop: 2 }}>Sem progresso há alguns minutos.</Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => { setBackupStatus('idle'); startBackup(); }}
                    style={{ backgroundColor: '#d97706', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 }}
                    accessibilityLabel="Continuar backup"
                    accessibilityRole="button"
                  >
                    <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>Continuar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={repairBackup}
                    style={{ backgroundColor: '#b91c1c', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 }}
                    accessibilityLabel="Reparar backup"
                    accessibilityRole="button"
                  >
                    <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>Reparar</Text>
                  </TouchableOpacity>
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
                    {backupStats?.total_size_formatted
                      ? backupStats.total_size_formatted
                      : (backupStats?.total_size != null
                          ? formatBytes(backupStats.total_size)
                          : (storageInfo ? formatBytes(storageInfo.drive_used || 0) : '—'))}
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
                // Threshold-based color so the bar visually surfaces
                // pressure: green / amber / orange / red.
                const usedPct = quota > 0 ? Math.min((totalUsed / quota) * 100, 100) : 0;
                const driveColor = usedPct < 50
                  ? '#22c55e'
                  : usedPct < 80 ? '#f59e0b'
                  : usedPct < 95 ? '#ef6c00'
                  : '#ef4444';
                return (
                  <View style={{ marginTop: Spacing.md }}>
                    <View style={[s.storageBar, { backgroundColor: colors.border }]}>
                      <View style={{ flexDirection: 'row', height: '100%' }}>
                        {drivePct > 0 && <View style={[s.storageFill, { width: `${drivePct}%`, backgroundColor: driveColor }]} />}
                        {emailPct > 0 && <View style={[s.storageFill, { width: `${emailPct}%`, backgroundColor: '#f59e0b', borderTopLeftRadius: drivePct > 0 ? 0 : 3, borderBottomLeftRadius: drivePct > 0 ? 0 : 3 }]} />}
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: driveColor }} />
                          <Text style={[s.storageText, { color: colors.textSecondary }]}>Drive: {storageInfo.drive_formatted || formatBytes(driveUsed)}</Text>
                        </View>
                        {emailUsed > 0 && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#f59e0b' }} />
                          <Text style={[s.storageText, { color: colors.textSecondary }]}>Email: {storageInfo.email_formatted || formatBytes(emailUsed)}</Text>
                        </View>}
                      </View>
                      <Text style={[s.storageText, { color: driveColor, fontWeight: '700' }]}>
                        {Math.round(usedPct)}%
                      </Text>
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
                  onValueChange={(v) => {
                    setBackupIncludeVideos(v);
                    AsyncStorage.setItem('backup_include_videos', String(v)).catch(() => {});
                  }}
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
                  style={[s.qualityBadge, { backgroundColor: uploadQuality === 'original' ? '#7C3AED20' : '#16a34a20' }]}
                >
                  <Text style={{ color: uploadQuality === 'original' ? '#7C3AED' : '#16a34a', fontSize: 12, fontWeight: '700' }}>
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
                <IconDownload size={20} color="#A78BFA" />
                <Text style={[s.cardTitle, { color: colors.text }]}>{t('photos.restorePhotos')}</Text>
              </View>
              <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 12 }}>
                {t('photos.restorePhotosDesc')}
              </Text>
              <TouchableOpacity
                style={[s.backupBtn, { backgroundColor: '#A78BFA', alignSelf: 'flex-start' }]}
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

              {/* Force-restart: cancels every pending native task and runs the
                  backup from scratch. Rescue button for when backup looks
                  stuck and "Backup agora" keeps no-oping because a stale
                  in-flight lock is still held. */}
              <TouchableOpacity
                style={[s.actionBtn, { borderBottomWidth: 1, borderBottomColor: colors.border }]}
                onPress={repairBackup}
                disabled={Platform.OS === 'web'}
              >
                <IconRefresh size={20} color="#b91c1c" />
                <Text style={[s.actionBtnText, { color: '#b91c1c' }]}>Reparar backup</Text>
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
                {t('photos.lastBackup')}: {(_d=>isNaN(_d.getTime())?'':_d.toLocaleString())(new Date(lastBackupDate))}
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

          {/* Image with scale animation + pinch-zoom + swipe-between-photos */}
          <Animated.View style={[s.viewerImageContainer, { transform: [{ scale: viewerScaleAnim }] }]}>
            <TouchableOpacity
              onPress={() => navigateViewer(-1)}
              style={[s.viewerNav, s.viewerNavLeft]}
              disabled={viewerIndex <= 0}
            >
              {viewerIndex > 0 && <IconChevronLeft size={32} color="rgba(255,255,255,0.7)" />}
            </TouchableOpacity>

            {(() => {
              // displayScale = baseScale * pinchScale (committed * live gesture)
              const displayScale = Animated.multiply(baseScale, pinchScale);
              const imageNode = (
                <Pressable onPress={onImageTap} style={s.viewerImage}>
                  <Animated.View style={{
                    flex: 1,
                    transform: [
                      { translateX: panX },
                      { scale: displayScale },
                    ],
                  }}>
                    <ExpoImage
                      source={{ uri: viewerResolvedUri || getFullUrl(viewerPhoto) }}
                      style={{ flex: 1, width: '100%', height: '100%' }}
                      contentFit="contain"
                    />
                  </Animated.View>
                </Pressable>
              );
              // Wrap with PinchGestureHandler + PanGestureHandler when available.
              if (PinchGestureHandler && PanGestureHandler) {
                return (
                  <PanGestureHandler
                    onGestureEvent={onPanEvent}
                    onHandlerStateChange={onPanStateChange}
                    activeOffsetX={[-10, 10]}
                    failOffsetY={[-30, 30]}
                  >
                    <Animated.View style={s.viewerImage}>
                      <PinchGestureHandler
                        onGestureEvent={onPinchEvent}
                        onHandlerStateChange={onPinchStateChange}
                      >
                        <Animated.View style={{ flex: 1 }}>
                          {imageNode}
                        </Animated.View>
                      </PinchGestureHandler>
                    </Animated.View>
                  </PanGestureHandler>
                );
              }
              return imageNode;
            })()}

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

          {/* AI caption (auto-generated, click to refresh) */}
          {aiCaption && (
            <TouchableOpacity
              onPress={generateAiCaption}
              style={{ alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, marginTop: 4, maxWidth: '85%' }}
            >
              <Text style={{ color: '#fff', fontSize: 13, fontStyle: 'italic' }} numberOfLines={2}>✨ {aiCaption}</Text>
            </TouchableOpacity>
          )}

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

            <TouchableOpacity style={s.viewerAction} onPress={generateAiCaption} disabled={aiCaptionLoading}>
              <Text style={{ fontSize: 22 }}>{aiCaptionLoading ? '...' : '✨'}</Text>
              <Text style={s.viewerActionText}>Caption</Text>
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
                  {(() => { try { const d = new Date(viewerPhoto.created_at || viewerPhoto.uploaded_at || viewerPhoto.modificationTime); if (isNaN(d.getTime())) return ''; return d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } })()}
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
          // Selection header — Google Photos grade with counter chip
          <View style={s.headerRow}>
            <TouchableOpacity onPress={clearSelection} style={s.headerBtn}>
              <IconX size={24} color={colors.text} />
            </TouchableOpacity>
            <View style={s.selectCounterChip}>
              <View style={[s.selectCounterDot, { backgroundColor: '#7C3AED' }]} />
              <Text style={[s.selectCounterText, { color: colors.text }]}>
                {selectedItems.size} {t('photos.selected') || 'selecionadas'}
              </Text>
            </View>
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={selectAll} style={s.headerBtn} accessibilityLabel="Selecionar tudo">
              <IconCheckCircle size={22} color="#7C3AED" />
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
          <>
            <View style={s.headerRow}>
              <TouchableOpacity onPress={() => { if (Platform.OS === "web" && window.parent !== window) { try { window.parent.postMessage({ type: "close-side-panel", route: "/photos" }, "*"); } catch {} } else { router.back(); } }} style={s.headerBtn}>
                <IconArrowLeft size={24} color={colors.text} />
              </TouchableOpacity>
              <IconCloud size={22} color="#7C3AED" />
              <Text style={[s.headerTitle, { color: colors.text, marginLeft: 8 }]}>{t('photos.title')}</Text>
              <View style={{ flex: 1 }} />
              {/* Backup status pill — Tudo sincronizado / Enviando / Pausado */}
              {(() => {
                const dc = deviceTotalCount || devicePhotos.length || 0;
                const realPending = Math.max(0, dc - (backedUpTotal || 0));
                let mode = null;
                if (backupStatus === 'backing_up') mode = 'uploading';
                else if (backupEnabled === false || backupStatus === 'paused') mode = 'paused';
                else if (dc > 0 && realPending === 0) mode = 'synced';
                if (!mode) return null;
                const palette = mode === 'synced'
                  ? { bg: isDark ? 'rgba(34,197,94,0.14)' : '#DCFCE7', fg: '#16A34A', dot: '#22C55E' }
                  : mode === 'uploading'
                  ? { bg: isDark ? 'rgba(124,58,237,0.16)' : '#EDE9FE', fg: '#7C3AED', dot: '#7C3AED' }
                  : { bg: isDark ? 'rgba(245,158,11,0.16)' : '#FEF3C7', fg: '#D97706', dot: '#F59E0B' };
                const label = mode === 'synced'
                  ? (t('photos.allSynced') || 'Sincronizado')
                  : mode === 'uploading'
                  ? `${t('photos.uploadingShort') || 'Enviando'} ${Math.max(realPending, 1)}`
                  : (t('photos.paused') || 'Pausado');
                return (
                  <Pressable
                    onPress={() => setActiveTab('backup')}
                    style={[s.statusPill, { backgroundColor: palette.bg }]}
                  >
                    {mode === 'uploading' ? (
                      <ActivityIndicator size="small" color={palette.fg} style={{ marginRight: 4, transform: [{ scale: 0.7 }] }} />
                    ) : (
                      <View style={[s.statusPillDot, { backgroundColor: palette.dot }]} />
                    )}
                    <Text style={[s.statusPillText, { color: palette.fg }]} numberOfLines={1}>{label}</Text>
                  </Pressable>
                );
              })()}
              {activeTab === 'photos' && (
                <TouchableOpacity onPress={cycleGridColumns} style={[s.headerBtn, { marginLeft: 4 }]}>
                  <IconGrid size={22} color={colors.textSecondary} />
                  <Text style={[s.gridLabel, { color: colors.textSecondary }]}>{gridColumns}</Text>
                </TouchableOpacity>
              )}
            </View>
            {/* Always-visible search bar (Google Photos style) */}
            {(activeTab === 'photos' || activeTab === 'search' || activeTab === 'albums') && (
              <View style={{ paddingHorizontal: Spacing.md, paddingBottom: 8 }}>
                <Pressable
                  onPress={() => { if (activeTab !== 'search') setActiveTab('search'); setShowSearch(true); }}
                  style={[s.searchPill, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#F3F4F6' }]}
                >
                  <IconSearch size={18} color={colors.textSecondary} />
                  <Text style={[s.searchPillText, { color: colors.textSecondary }]} numberOfLines={1}>
                    {t('photos.searchPeoplePlaces') || 'Pesquisar pessoas, lugares...'}
                  </Text>
                </Pressable>
              </View>
            )}
          </>
        )}

        {/* Fixed backup progress banner (Google Photos style - visible across all tabs) */}
        {backupStatus === 'backing_up' && (
          <View style={{ backgroundColor: isDark ? '#172554' : '#EDE9FE', paddingHorizontal: 16, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <ActivityIndicator size="small" color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>
                Backup em andamento · {Math.min(backedUpTotal, deviceTotalCount || devicePhotos.length || backedUpTotal)} fotos salvas
              </Text>
              <Text style={{ color: colors.textSecondary, fontSize: 11, marginTop: 1 }}>
                Continua mesmo com o app minimizado
              </Text>
            </View>
          </View>
        )}
        {backupStatus === 'complete' && (() => {
          // Use the SAME pending math as the Backup tab card (deviceCount −
          // serverCount) instead of the native scanLibrary `pendingCount`.
          // The native count can lie when UserDefaults has stale IDs (e.g.
          // failed uploads marked locally as backed up). Server-vs-device
          // delta is the single source of truth.
          const dc = deviceTotalCount || devicePhotos.length || 0;
          const realPending = Math.max(0, dc - (backedUpTotal || 0));
          return realPending === 0 && dc > 0;
        })() && (
          <TouchableOpacity
            onPress={() => setBackupStatus('idle')}
            style={{ backgroundColor: isDark ? '#052e16' : '#dcfce7', paddingHorizontal: 16, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 8 }}
          >
            <IconCheck size={16} color="#22c55e" />
            <Text style={{ color: '#16a34a', fontSize: 13, fontWeight: '600', flex: 1 }}>Backup completo! {backedUpTotal} fotos salvas</Text>
            <IconX size={14} color="#16a34a" />
          </TouchableOpacity>
        )}

        {/* GAP 9 — backup failure banner (surfaces silent upload errors) */}
        {backupErrorVisible && backupErrorCount > 0 && (
          <View style={{
            flexDirection: 'row', alignItems: 'center',
            backgroundColor: (colors.error || '#dc2626') + '15',
            borderRadius: 12, marginHorizontal: 12, marginVertical: 8,
            padding: 12, gap: 10,
          }}>
            <IconCloudOff size={18} color={colors.error || '#dc2626'} />
            <Text style={{ flex: 1, fontSize: 13, color: colors.text }}>
              {t('photos.backupFailedCount', { count: backupErrorCount })}
            </Text>
            <TouchableOpacity onPress={retryBackup} style={{ padding: 6 }}>
              <IconRefresh size={16} color={colors.primary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setBackupErrorVisible(false)} style={{ padding: 6 }}>
              <IconX size={16} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
        )}

        {/* Tabs — modern pills (Google Photos / Telegram-grade) */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: Spacing.md, paddingBottom: 10, gap: 8 }}
        >
          {TABS.map((tab) => {
            const isActive = activeTab === tab;
            const Ico = tab === 'photos' ? IconImage : tab === 'search' ? IconSearch : tab === 'albums' ? IconAlbum : IconCloud;
            return (
              <Pressable
                key={tab}
                onPress={() => {
                  setActiveTab(tab);
                  setViewingAlbum(null);
                }}
                style={[
                  s.tabPill,
                  isActive
                    ? { backgroundColor: '#7C3AED' }
                    : { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#F3F4F6' },
                ]}
              >
                <Ico size={15} color={isActive ? '#fff' : colors.textSecondary} />
                <Text
                  style={[
                    s.tabPillText,
                    { color: isActive ? '#fff' : colors.text },
                  ]}
                >
                  {t(`photos.tab_${tab}`)}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
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
            {activeTab === 'backup' && (
              <ErrorBoundary>
                {renderBackupTab()}
              </ErrorBoundary>
            )}
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
          <BrandFab
            size={56}
            color={colors.primary}
            onPress={() => {
              const newVal = !fabOpen;
              setFabOpen(newVal);
              Animated.spring(fabRotateAnim, { toValue: newVal ? 1 : 0, tension: 220, friction: 14, useNativeDriver: true }).start();
            }}
            accessibilityLabel={t('photos.upload') || 'Upload'}
            contentTransform={[
              { rotate: fabRotateAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '45deg'] }) },
            ]}
          >
            <IconPlus size={26} color="#fff" />
          </BrandFab>
        </View>
      )}

      {/* Batch operations toolbar — Google Photos grade */}
      {selectMode && selectedItems.size > 0 && (
        <View
          style={[
            s.batchToolbar,
            {
              backgroundColor: isDark ? 'rgba(15,23,42,0.96)' : 'rgba(255,255,255,0.98)',
              borderTopColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
              paddingBottom: 16 + (insets.bottom || 0),
            },
          ]}
        >
          <TouchableOpacity
            style={s.batchAction}
            onPress={() => {
              const selected = filteredPhotos.filter(p => selectedItems.has(p.id) && !p.isDevice);
              if (selected.length > 0) sharePhoto(selected[0]);
            }}
            accessibilityLabel={t('photos.share')}
          >
            <View style={[s.batchActionPill, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#F3F4F6' }]}>
              <IconShare size={20} color={colors.text} />
            </View>
            <Text style={[s.batchActionText, { color: colors.text }]}>{t('photos.share') || 'Compartilhar'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.batchAction}
            onPress={() => {
              const selected = filteredPhotos.filter(p => selectedItems.has(p.id));
              selected.forEach(p => toggleStar(p));
              clearSelection();
            }}
            accessibilityLabel={t('photos.favorites')}
          >
            <View style={[s.batchActionPill, { backgroundColor: 'rgba(245,158,11,0.14)' }]}>
              <IconStar size={20} color="#F59E0B" />
            </View>
            <Text style={[s.batchActionText, { color: colors.text }]}>{t('photos.favorites') || 'Favoritar'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.batchAction}
            onPress={() => setCreateAlbumVisible(true)}
            accessibilityLabel="Adicionar a album"
          >
            <View style={[s.batchActionPill, { backgroundColor: 'rgba(124,58,237,0.14)' }]}>
              <IconAlbum size={20} color="#7C3AED" />
            </View>
            <Text style={[s.batchActionText, { color: colors.text }]}>{t('photos.addToAlbum') || 'Adicionar'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.batchAction}
            onPress={() => {
              const selected = filteredPhotos.filter(p => selectedItems.has(p.id) && !p.isDevice);
              selected.forEach(p => downloadPhoto(p));
              clearSelection();
            }}
            accessibilityLabel={t('photos.download')}
          >
            <View style={[s.batchActionPill, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#F3F4F6' }]}>
              <IconDownload size={20} color={colors.text} />
            </View>
            <Text style={[s.batchActionText, { color: colors.text }]}>{t('photos.download') || 'Baixar'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.batchAction}
            onPress={deleteSelected}
            accessibilityLabel={t('photos.delete')}
          >
            <View style={[s.batchActionPill, { backgroundColor: 'rgba(220,38,38,0.12)' }]}>
              <IconTrash size={20} color="#DC2626" />
            </View>
            <Text style={[s.batchActionText, { color: '#DC2626' }]}>{t('photos.delete') || 'Excluir'}</Text>
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

  // Memories — Google Photos-grade carousel cards
  memoryCardLg: {
    width: 280,
    height: 140,
    borderRadius: 18,
    overflow: 'hidden',
    position: 'relative',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.12, shadowRadius: 12 },
      android: { elevation: 4 },
      web: { boxShadow: '0 4px 20px rgba(0,0,0,0.10)' },
    }),
  },
  memoryCoverLg: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#1a1a2e',
  },
  memoryGradient: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    height: '70%',
    backgroundColor: 'rgba(0,0,0,0.55)',
    ...(Platform.OS === 'web' ? {
      background: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.18) 40%, rgba(0,0,0,0.78) 100%)',
      backgroundColor: 'transparent',
    } : {}),
  },
  memoryGradient2: {
    position: 'absolute',
    left: 0, right: 0, top: 0,
    height: '40%',
    ...(Platform.OS === 'web' ? {
      background: 'linear-gradient(180deg, rgba(0,0,0,0.32) 0%, transparent 100%)',
    } : {
      backgroundColor: 'rgba(0,0,0,0.18)',
    }),
  },
  memoryTextWrap: {
    position: 'absolute',
    left: 14,
    right: 14,
    bottom: 12,
  },
  memoryTitleLg: {
    fontSize: 17,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: -0.3,
    textShadowColor: 'rgba(0,0,0,0.4)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  memorySubLg: {
    fontSize: 12,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.86)',
    marginTop: 2,
    textShadowColor: 'rgba(0,0,0,0.4)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  memoryBadge: {
    position: 'absolute',
    top: 10,
    right: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.45)',
    minWidth: 22,
    alignItems: 'center',
  },
  memoryBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },

  // Search pill (always visible, Google Photos style)
  searchPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
  },
  searchPillText: {
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
  },

  // Backup status pill (top header)
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    maxWidth: 160,
  },
  statusPillDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusPillText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.1,
  },

  // Tab pills (modern row)
  tabPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
  },
  tabPillText: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: -0.1,
    textTransform: 'capitalize',
  },

  // Selection counter chip
  selectCounterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    marginLeft: 4,
  },
  selectCounterDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  selectCounterText: {
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: -0.2,
  },

  // Batch action pill (bottom toolbar)
  batchActionPill: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },

  // Favorite heart overlay (top-right of grid item)
  favoriteOverlay: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  favoriteOverlayShadow: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.18)',
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
