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
  IconPlus, IconUsers,
} from '../components/Icons';
import PhotoEditor from '../components/PhotoEditor';
import BrandFab from '../components/BrandFab';
import { generateBatch } from '../services/thumbnailCache';
import Svg, { Path, Circle as SvgCircle, Line, Polyline, Rect } from 'react-native-svg';

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

// Map pin icon for the new geo-tagged photos tab. Single-color stroke style
// matches the other tab icons (IconImage/IconAlbum/IconSearch/IconCloud).
function IconMap({ size = 24, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <SvgCircle cx="12" cy="10" r="3" />
    </Svg>
  );
}

// ============================================================
// CONSTANTS
// ============================================================
// Tabs include 'map' — surfaces geo-tagged photos on a clustered Google Maps
// WebView (no extra dep, uses the bundled gmaps embed). 'backup' stays last
// since users hit it least often during a normal session.
// Wave 14: 'people' (Pessoas) tab surfaces real face clusters built from
// on-device FaceNet embeddings (see services/faceEmbeddings.js + backend
// photos_face_clusters action).
const TABS = ['photos', 'albums', 'people', 'search', 'map', 'backup'];
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
  const { t, language } = useLanguage();
  // BCP-47 locale for Intl date formatting in Memories cards/viewer. Map our
  // short codes to full locales so month names render in the right language.
  const locale = ({ 'pt-BR': 'pt-BR', pt: 'pt-BR', en: 'en-US', es: 'es-ES' })[language] || language || 'pt-BR';
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
  // [#1345] Memory slideshow viewer — { title, subtitle, photos[] }. Opened
  // when a memory card is tapped (story-style auto-advancing player).
  const [memoryViewer, setMemoryViewer] = useState(null);
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

  // Wave 14 — photobook PDF generator
  const [photobookVisible, setPhotobookVisible] = useState(false);
  const [photobookLayout, setPhotobookLayout] = useState('grid');
  const [photobookSelectedIds, setPhotobookSelectedIds] = useState([]);
  const [photobookGenerating, setPhotobookGenerating] = useState(false);
  const [photobookResult, setPhotobookResult] = useState(null);
  const photobookSelectedCount = photobookSelectedIds.length;
  const openPhotobookForSelection = useCallback((ids) => {
    setPhotobookSelectedIds(ids);
    setPhotobookResult(null);
    setPhotobookLayout('grid');
    setPhotobookVisible(true);
  }, []);
  const generatePhotobook = useCallback(async () => {
    if (photobookSelectedIds.length === 0) return;
    setPhotobookGenerating(true);
    setPhotobookResult(null);
    try {
      const res = await api.photosPhotobookCreate(photobookSelectedIds, photobookLayout, 'Photobook');
      if (res?.success && res.data?.pdf_url) {
        setPhotobookResult(res.data);
      } else {
        safeAlert?.('Erro', res?.error || 'Falha ao gerar PDF');
      }
    } catch (e) {
      safeAlert?.('Erro', String(e?.message || e));
    } finally {
      setPhotobookGenerating(false);
    }
  }, [photobookSelectedIds, photobookLayout]);

  // Upload quality
  const [uploadQuality, setUploadQuality] = useState('economy'); // 'original' | 'economy'

  // Favorites filter
  const [showFavorites, setShowFavorites] = useState(false);
  const [presetFilter, setPresetFilter] = useState(null);
  // ML-backed result IDs for the active preset. When non-null, the grid
  // filter prefers AI semantic matches (person/face/sun/beach/etc) over
  // the date-only heuristic. null = use heuristic fallback only.
  const [presetMLIds, setPresetMLIds] = useState(null);
  const [presetLoading, setPresetLoading] = useState(false);

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
  // Retry-schedule state moved off the function object — static props leak
  // across renders, can't be cleared on unmount, and were resetting when a
  // manual tap re-entered startBackup, defeating the 20-cap. Component-scoped
  // refs let the unmount cleanup actually clear the pending setTimeout.
  const backupRetryTimerRef = useRef(null);
  const backupRetryCountRef = useRef(0);
  const backupZeroStreakRef = useRef(0);
  // Helper to clean up backup refresh timer + WS listener together
  const cleanupBackupRefresh = useCallback(() => {
    if (backupRefreshTimerRef.current) { clearInterval(backupRefreshTimerRef.current); backupRefreshTimerRef.current = null; }
    if (backupWsUnsubRef.current) { backupWsUnsubRef.current(); backupWsUnsubRef.current = null; }
    if (backupRetryTimerRef.current) { clearTimeout(backupRetryTimerRef.current); backupRetryTimerRef.current = null; }
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
  // 2026-05-18 (#1126): epoch (ms) of the last time we observed
  // (uploaded === 0 AND remaining > 0) at the end of a backup loop. That
  // means the native engine could not close the gap — the remaining
  // photos are phantom assets (iCloud-only, hidden, library-corrupt,
  // already-deleted-but-still-counted, etc.) so scheduling another retry
  // every 45s just spins forever. Block re-entry to startBackup for
  // COMPLETED_COOLDOWN_MS after we observe this state. The user can
  // still tap "Backup agora" — that calls forceStartBackup which
  // bypasses the cooldown by clearing the ref before invoking.
  const backupCompletedAtRef = useRef(0);
  const COMPLETED_COOLDOWN_MS = 30 * 60 * 1000;
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
    // [PERF 2026-05-21] Track if THIS invocation set the loading flag. If so,
    // the finally block must clear it even when the request goes stale —
    // otherwise the spinner is stranded forever (root cause of "Photos tela
    // travada" bug: cache-miss path setLoading(true), api roundtrip becomes
    // stale because a newer mount fires, finally's `requestId === current`
    // gate fails → loading stays true with no future call to reset it).
    let weSetLoading = false;
    let weSetLoadingMore = false;
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
          weSetLoading = true;
        }
      } else if (pageNum > 1) {
        setLoadingMore(true);
        weSetLoadingMore = true;
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
      // [PERF 2026-05-21] If we set loading/loadingMore on THIS invocation,
      // always clear them — even when a newer request bumped the ref. The
      // previous gate skipped cleanup on stale requests and stranded the
      // spinner permanently. A concurrent newer request will set them back
      // to true on its own setLoading(true) and clear them on its own
      // finally, so this is safe.
      if (weSetLoading || requestId === cloudLoadRequestIdRef.current) {
        setLoading(false);
      }
      if (weSetLoadingMore || requestId === cloudLoadRequestIdRef.current) {
        setLoadingMore(false);
      }
    }
  }, []);

  const [backupStats, setBackupStats] = useState(null); // { backed_up, backup_source, total_size, total_size_formatted }

  // GAP 9 — surface backup failures in a banner
  const [backupErrorCount, setBackupErrorCount] = useState(0);
  const [backupErrorVisible, setBackupErrorVisible] = useState(false);
  // v3 migration wiped @chatyy_backup/backed_up_map and stashed the previous
  // map at `_v2_backup` for recovery. We expose a button to restore it when
  // present — without this, users hit by the wipe had no way to get their
  // dedup state back and were forced to re-upload thousands of photos.
  const [hasV2Snapshot, setHasV2Snapshot] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const bs = require('../services/backup/backupStorage');
        if (bs.hasV2Snapshot) {
          const has = await bs.hasV2Snapshot();
          if (!cancelled) setHasV2Snapshot(!!has);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);
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

    // P1 FIX (2026-05-21): always kick a cloud-photos refresh on mount even
    // when context is "warm" (devicePhotos populated from a prior visit). The
    // old short-circuit would set loading=false and never re-fetch
    // cloudPhotos, so a user who landed on Photos with empty cloud (transient
    // 401/timeout on first try, or device had a few photos that hid cloud
    // via the old allPhotos exclusive logic) would see an empty grid forever
    // until the app was killed. Cloud refetch is cheap (cached + paginated).
    if (loadedRef.current && (devicePhotos.length > 0 || cloudPhotos.length > 0)) {
      setLoading(false);
      api.apiCall('drive_backup_count').then(r => { const t = r?.data?.count || 0; if (t > 0) setBackedUpTotal(t); }).catch(() => {});
      // Re-fire cloud fetch when cloudPhotos is empty but device has items
      // (covers "merge" path so backed-up photos surface even on revisit).
      if (cloudPhotos.length === 0) {
        if (Platform.OS === 'web') loadCloudPhotos(1);
        else setTimeout(() => loadCloudPhotos(1), 500);
      }
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
      // Mobile: device photos + cloud in parallel.
      // P1 FIX (2026-05-21): was `setTimeout(loadCloudPhotos, 2000)` which
      // left users with no photo permission staring at an empty illustration
      // for 2s+ before the cloud fetch even kicked off. Now both fire on
      // mount so the grid paints as soon as either resolves. Combined with
      // the new merge-based allPhotos, the user always sees their backed-up
      // photos regardless of device photo permission state.
      loadDevicePhotos();
      loadCloudPhotos(1);
      loadStorageInfo();
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
    // Bug 2026-05-14: threshold de 5 fazia status='complete' coexistir com
    // pendingCount=1-5 — usuário via "todas backed up" E "N pendentes" ao
    // mesmo tempo. Se há QUALQUER pendente real, status deve refletir isso.
    //
    // 2026-05-18 (#1126): if we just completed a run with uploaded=0 AND
    // remaining>0 (phantom drift the engine can't reconcile), DON'T flip
    // back to 'needs_backup' — that re-triggers the pending-photo effect
    // which auto-starts another engine pass (blocked by cooldown but
    // still ping-pongs the status state). Keep 'complete' visible until
    // the cooldown expires or the user manually taps "Reparar".
    const inCompletedCooldown = backupCompletedAtRef.current > 0 &&
      (Date.now() - backupCompletedAtRef.current) < COMPLETED_COOLDOWN_MS;
    if (dc > 0 && realPending > 0 && backupStatus === 'complete' && !inCompletedCooldown) {
      setBackupStatus('needs_backup');
    }
  }, [deviceTotalCount, backedUpTotal, backupStatus]);

  // Mark device photos that are already backed up.
  //
  // BUG 2026-05-18 (#1126): per-photo "cloud-slash" overlay kept rendering on
  // already-backed-up photos because the previous match used filename equality
  // against `cloudPhotos[]` — but cloudPhotos is paginated (only page 1 on
  // mobile, ~PAGE_SIZE items), AND the server stores files under a generated
  // name (md5(asset_id) suffix) that rarely equals the device filename. So the
  // overlay would scream "not backed up" on libraries that the global counter
  // (backedUpTotal vs deviceTotalCount) reported as 100% complete.
  //
  // Truth source = `getBackedUpMap()` from services/backup/backupStorage,
  // which is keyed by `asset_id` (the same identifier the server uses) and is
  // refreshed by the engine after every server precheck. That's what the
  // native iOS module syncs into too (NativeUpload.setBackedUpIds).
  useEffect(() => {
    if (devicePhotos.length === 0) return;
    let cancelled = false;
    (async () => {
      let backedUpIdSet = new Set();
      try {
        const bs = require('../services/backup/backupStorage');
        if (bs?.getBackedUpMap) {
          const map = await bs.getBackedUpMap();
          if (map && typeof map === 'object') backedUpIdSet = new Set(Object.keys(map));
        }
      } catch {}
      if (cancelled) return;
      // Fall-back: keep the legacy name-match as a secondary signal (still
      // helps web where there is no asset_id). Union of both signals.
      const cloudNames = new Set(cloudPhotos.map(p => p.name?.toLowerCase()));
      // Global "complete" override — if the screen as a whole has decided
      // backup is complete (server count caught up to device total), every
      // device photo MUST show cloud-check, otherwise the per-photo overlay
      // contradicts the banner. Without this, the user sees "100% complete"
      // alongside a sea of cloud-slash icons.
      const dt = deviceTotalCount || devicePhotos.length || 0;
      const globalComplete =
        backupStatus === 'complete' ||
        (dt > 0 && (backedUpTotal || 0) >= dt);
      const isPhotoBackedUp = (dp) => {
        if (globalComplete) return true;
        if (dp.deviceId && backedUpIdSet.has(dp.deviceId)) return true;
        if (dp.name && cloudNames.has(dp.name.toLowerCase())) return true;
        return false;
      };
      const backedUpCount = devicePhotos.filter(isPhotoBackedUp).length;
      setDevicePhotos(prev => prev.map(dp => ({
        ...dp,
        backedUp: isPhotoBackedUp(dp),
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
              // Bug 2026-05-15: scanLibrary read phantom UserDefaults assets
              // and reported pending >> device total (user saw "Faltam 18k
              // fotos" with only 12k on device). Cap by device-vs-server
              // truth so we never overstate.
              const nativePending = Math.max(0, res.totalPending);
              const truthCap = Math.max(0, totalOnDevice - estimatedBackedUp);
              setPendingCount(Math.min(nativePending, truthCap));
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
    })();
    return () => { cancelled = true; };
  }, [devicePhotos.length, cloudPhotos.length, backupEnabled, deviceTotalCount, backedUpTotal, backupStatus]);

  // Declared ABOVE onRefresh on purpose: onRefresh references refreshMemories
  // in its body + dependency array. Declaring it below caused a TDZ
  // ("Cannot access 'refreshMemories' before initialization") that crashed
  // Photos on first render. Keep this order.
  const memCacheKey = `photo_memories_v2_${user?.email || 'anon'}`;
  // [#1345 2026-05-26] Richer client-side memory model. The backend
  // (drive_memories) returns thin buckets { type, years, photos, memory_key }.
  // We enrich each bucket here with a representative date (pulled from the
  // first photo that carries one) and a `kind` tag so the card can render a
  // proper "On this day" / "X anos atrás" / "Destaques recentes" title +
  // a localized date label — without any backend change.
  const _photoDate = (p) => {
    if (!p) return null;
    const raw = p.created_at || p.taken_at || p.uploaded_at || p.modificationTime;
    if (!raw) return null;
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  };
  const refreshMemories = useCallback(async () => {
    try {
      const r = await api.driveMemories();
      const buckets = r?.success && Array.isArray(r.data?.buckets) ? r.data.buckets : null;
      if (!buckets || buckets.length === 0) return null;
      const yearsCards = [];
      const thisWeek = buckets.find(b => b?.type === 'this_week');
      buckets.forEach(b => {
        if (!b || !Array.isArray(b.photos) || b.photos.length === 0) return;
        if (b.type === 'years_ago') {
          // Pick a representative date from the bucket (first dated photo).
          let repDate = null;
          for (const p of b.photos) { repDate = _photoDate(p); if (repDate) break; }
          yearsCards.push({
            kind: 'years_ago',
            yearsAgo: Number(b.years) || 1,
            photos: b.photos,
            memoryKey: b.memory_key || `ya_${b.years || 1}`,
            date: repDate ? repDate.toISOString() : null,
          });
        }
      });
      yearsCards.sort((a, b) => a.yearsAgo - b.yearsAgo);
      let next = yearsCards;
      if (yearsCards.length === 0 && thisWeek?.photos?.length) {
        let repDate = null;
        for (const p of thisWeek.photos) { repDate = _photoDate(p); if (repDate) break; }
        next = [{
          kind: 'this_week',
          yearsAgo: 0,
          photos: thisWeek.photos,
          memoryKey: thisWeek.memory_key || 'wk_current',
          date: repDate ? repDate.toISOString() : null,
        }];
      }
      try { await AsyncStorage.setItem(memCacheKey, JSON.stringify(next)); } catch {}
      return next;
    } catch (e) {
      return null;
    }
  }, [memCacheKey]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setPage(1);
    // WAVE 80: pull-to-refresh re-fetches memories from backend (which serves
    // from chat_user_memories cache, regenerating if >24h stale). Stable order
    // preserved — same yearsAgo sort the carousel already uses.
    const memTask = refreshMemories().then(next => {
      if (next && next.length > 0) setMemoriesData(next);
    });
    await Promise.all([loadCloudPhotos(1), loadStorageInfo(), loadDevicePhotos(), memTask]);
    setRefreshing(false);
  }, [loadCloudPhotos, loadStorageInfo, loadDevicePhotos, refreshMemories]);

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
  // P1 FIX (2026-05-21): MERGE device + cloud (Google Photos / iCloud parity).
  // Previously: `if (devicePhotos.length > 0) return devicePhotos;` HID all cloud
  // photos as soon as the user had a single device photo. Worse, when the
  // user denied / limited photo permission AND the cloud fetch hadn't returned
  // yet (or returned empty due to a transient error), allPhotos stayed [] and
  // the screen rendered the empty illustration — even though the account had
  // tens of thousands of photos backed up to R2. Now: merge by a stable key
  // (device photos preferred over their cloud copy when both exist, matched by
  // basename) so the grid surfaces EVERY photo the user has. Web stays cloud-only.
  const allPhotos = useMemo(() => {
    if (Platform.OS === 'web') return cloudPhotos;
    if (devicePhotos.length === 0) return cloudPhotos;
    if (cloudPhotos.length === 0) return devicePhotos;
    // Merge: device first (live ph:// uri = faster preview), then any cloud
    // photo whose name isn't already represented on-device. Use lowercased
    // basename (strip server-added hash suffix) so "IMG_7160_6937a7fdb0.PNG"
    // dedupes against the device's "IMG_7160.PNG" / "IMG_7160.HEIC".
    const stripHashSuffix = (n) => {
      if (!n) return '';
      const s = String(n).toLowerCase();
      // strip "_<hex8+>.ext" tail added by backup upload
      return s.replace(/_[a-f0-9]{6,}(\.[a-z0-9]+)$/, '$1');
    };
    const deviceNames = new Set(devicePhotos.map(p => stripHashSuffix(p.name)));
    const cloudOnly = cloudPhotos.filter(p => !deviceNames.has(stripHashSuffix(p.name)));
    return [...devicePhotos, ...cloudOnly];
  }, [cloudPhotos, devicePhotos]);

  // Memories: TIER 1 — backend-driven "On this day" (DOY ±3 days vs prev years).
  // Backend: drive_memories returns { buckets: [{ type:'years_ago', years:N, photos:[],
  //   memory_key }, { type:'this_week', photos:[], memory_key }] }. We adapt that to
  //   the legacy shape { yearsAgo, photos, memoryKey } the carousel render expects.
  //
  // WAVE 80 (2026-05-21) — Persistence hardening:
  //   1) Hydrate from AsyncStorage IMMEDIATELY on mount (no flicker on cold start).
  //   2) Backend now persists buckets in chat_user_memories (PG) with 7-day TTL
  //      → same cards stay visible all week, not just for the exact DOY.
  //   3) Stop re-fetching on every allPhotos change — only on mount + manual
  //      refresh. Was a major "memories sumindo" cause: as device photos
  //      streamed in, the effect re-ran, hit fallback (allPhotos transient
  //      empty) and overwrote the carousel mid-render.
  //   4) Respect locally-muted memory_keys (long-press "Não mostrar").
  const [memoriesData, setMemoriesData] = useState([]);
  const [mutedMemoryKeys, setMutedMemoryKeys] = useState(() => new Set());
  const memoriesLoadedRef = useRef(false);
  const memMuteKey = `photo_memories_muted_v1_${user?.email || 'anon'}`;
  // memCacheKey + refreshMemories moved above onRefresh (TDZ fix) — see note there.

  useEffect(() => {
    let cancelled = false;
    if (memoriesLoadedRef.current) return;

    const buildClientFallback = () => {
      if (!allPhotos || allPhotos.length === 0) return [];
      try {
        const now = new Date();
        const currentMonth = now.getMonth();
        const currentYear = now.getFullYear();
        const groups = new Map();
        const recent = []; // last-30-days pool for the "recent highlights" card
        const recentCutoff = now.getTime() - 30 * 24 * 3600 * 1000;
        allPhotos.forEach(p => {
          try {
            const d = _photoDate(p);
            if (!d) return;
            // "On this day" — same calendar month, an earlier year.
            if (d.getMonth() === currentMonth && d.getFullYear() < currentYear) {
              const yearsAgo = currentYear - d.getFullYear();
              if (!groups.has(yearsAgo)) {
                groups.set(yearsAgo, {
                  kind: 'years_ago', yearsAgo, photos: [],
                  memoryKey: `local_ya_${yearsAgo}`, date: d.toISOString(),
                });
              }
              groups.get(yearsAgo).photos.push(p);
            }
            // Recent pool — collected so we can still show *something* rich
            // when there's no on-this-day match (brand-new accounts, etc.).
            if (d.getTime() >= recentCutoff) recent.push(p);
          } catch {}
        });
        const yearCards = Array.from(groups.values()).sort((a, b) => a.yearsAgo - b.yearsAgo);
        if (yearCards.length > 0) return yearCards;
        // No on-this-day memory → surface a "Destaques recentes" card from the
        // last 30 days so Memories is never empty when the user has photos.
        if (recent.length >= 3) {
          recent.sort((a, b) => (_photoDate(b)?.getTime() || 0) - (_photoDate(a)?.getTime() || 0));
          return [{
            kind: 'recent', yearsAgo: 0, photos: recent.slice(0, 30),
            memoryKey: 'local_recent', date: now.toISOString(),
          }];
        }
        return [];
      } catch { return []; }
    };

    (async () => {
      // 1) Hydrate muted set from AsyncStorage so cards we hid stay hidden.
      try {
        const muteRaw = await AsyncStorage.getItem(memMuteKey);
        if (muteRaw && !cancelled) {
          const arr = JSON.parse(muteRaw);
          if (Array.isArray(arr)) setMutedMemoryKeys(new Set(arr));
        }
      } catch {}

      // 2) Hydrate from AsyncStorage cache FIRST so the carousel paints
      //    instantly on cold-start (no "blink to empty" while network call).
      try {
        const cached = await AsyncStorage.getItem(memCacheKey);
        if (cached && !cancelled) {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setMemoriesData(parsed);
            memoriesLoadedRef.current = true;
          }
        }
      } catch {}

      // 3) Fetch fresh from backend (cache-served by chat_user_memories on backend).
      const next = await refreshMemories();
      if (cancelled) return;
      if (next && next.length > 0) {
        setMemoriesData(next);
        memoriesLoadedRef.current = true;
      } else if (!memoriesLoadedRef.current) {
        // Last resort — client-side from current allPhotos (may be empty mid-load).
        setMemoriesData(buildClientFallback());
        memoriesLoadedRef.current = true;
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.email]);

  // Long-press handler — hide a memory locally AND ask backend to mute it.
  const muteMemory = useCallback(async (memoryKey) => {
    if (!memoryKey) return;
    setMutedMemoryKeys(prev => {
      const next = new Set(prev);
      next.add(memoryKey);
      try { AsyncStorage.setItem(memMuteKey, JSON.stringify(Array.from(next))); } catch {}
      return next;
    });
    try {
      await api.photoMemoryMute(memoryKey, 1);
    } catch {}
  }, [memMuteKey]);

  // Apply mute filter so hidden memories don't render. Order is preserved
  // (stable across renders — same yearsAgo ordering returned by backend).
  const visibleMemoriesData = useMemo(() => {
    if (!Array.isArray(memoriesData) || memoriesData.length === 0) return memoriesData;
    if (mutedMemoryKeys.size === 0) return memoriesData;
    return memoriesData.filter(m => !mutedMemoryKeys.has(m.memoryKey));
  }, [memoriesData, mutedMemoryKeys]);

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
    // Preset memory filter — Google Photos-grade semantic search.
    // Why: presets like "Pessoas" / "Verão" need real intent matching, not
    // just date math. presetMLIds is populated by an AI search (photo_labels
    // tags/objects/scene) when the user taps a card; we intersect the AI hits
    // with the relevant date window for time-bound presets so "Verão 2026"
    // means "summer photos taken this summer" — same UX Google ships.
    if (presetFilter) {
      const now = new Date();
      const inSummer = (d) => {
        const m = d.getMonth(); const y = d.getFullYear();
        const summerYear = (now.getMonth() >= 11) ? now.getFullYear() + 1 : now.getFullYear();
        return (m === 11 && y === summerYear - 1) || ((m === 0 || m === 1) && y === summerYear);
      };
      const mlSet = presetMLIds ? new Set(presetMLIds.map(p => String(p.id || p))) : null;

      photos = photos.filter(p => {
        try {
          const d = new Date(p.created_at || p.uploaded_at || p.modificationTime);
          if (presetFilter === 'thisweek') {
            return !isNaN(d.getTime()) && (now.getTime() - d.getTime()) <= 7 * 24 * 60 * 60 * 1000;
          }
          if (presetFilter === 'summer') {
            // Prefer AI hits (beach/pool/sun/outdoor) but require the date to
            // match this summer. Falls back to pure date if AI is empty.
            const isThisSummer = !isNaN(d.getTime()) && inSummer(d);
            if (mlSet && mlSet.size > 0) {
              return isThisSummer && mlSet.has(String(p.id));
            }
            return isThisSummer;
          }
          if (presetFilter === 'people') {
            // Pure ML hits; fall back to portrait/face heuristic if AI empty.
            if (mlSet && mlSet.size > 0) return mlSet.has(String(p.id));
            try {
              if (p.photo_labels) {
                const labels = typeof p.photo_labels === 'string' ? JSON.parse(p.photo_labels) : p.photo_labels;
                const tags = (labels?.tags || []).map(s => String(s).toLowerCase());
                if (tags.some(t => /person|people|face|selfie|portrait/.test(t))) return true;
              }
            } catch {}
            const w = p.width || p.image_width || 0;
            const h = p.height || p.image_height || 0;
            return h > w && h / Math.max(w, 1) >= 1.3;
          }
          return true;
        } catch { return false; }
      });
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
  }, [allPhotos, searchText, showFavorites, mlSearchResults, presetFilter, presetMLIds]);

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
            // Track success/failure so we can surface real feedback instead of
            // silently swallowing API errors (used to leave the user wondering
            // why some photos "stayed" after Excluir).
            let ok = 0, fail = 0, skipped = 0;
            for (const id of ids) {
              if (id.startsWith('device_')) { skipped++; continue; }
              try {
                const r = await api.fileDelete(id);
                if (r?.success === false) fail++; else ok++;
              } catch {
                fail++;
              }
            }
            clearSelection();
            loadCloudPhotos(1);
            if (fail > 0) {
              safeAlert(
                t('photos.deletePartial') || 'Algumas falharam',
                (t('photos.deletePartialDesc') || '{ok} excluídas, {fail} falharam.')
                  .replace('{ok}', String(ok)).replace('{fail}', String(fail)),
              );
            }
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
    // User explicitly asked to repair — bust the post-complete cooldown
    // (#1126) so the next startBackup actually runs through the native engine.
    backupCompletedAtRef.current = 0;

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
    // 2026-05-18 (#1126): if the previous run completed with uploaded=0 AND
    // remaining>0 (phantom drift the engine can't reconcile), block re-entry
    // for COMPLETED_COOLDOWN_MS. Without this, the auto-correct effect
    // (line ~980) flips status back to 'needs_backup' the moment the loop
    // ends — which fires the pending-photo effect — which schedules another
    // startBackup in 3s — which runs an empty pass — which fires the
    // post-loop retry in 45s — ad infinitum. The user's perception:
    // "chega no final e continua tentando fazer backup".
    if (backupCompletedAtRef.current > 0 &&
        Date.now() - backupCompletedAtRef.current < COMPLETED_COOLDOWN_MS) {
      console.log('[backup] startBackup: in completed-cooldown — skipping (use forceStartBackup to override)');
      setBackupStatus('complete');
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

    // Watchdog: if backup makes no progress for 3 min, the native session
    // might be hung. But cancelAll() unconditionally is dangerous — native
    // tasks can still be uploading even when JS sees no progress callbacks
    // (URLSession.background fires onComplete in batches). Before cancelling
    // we ask the native module how many uploads are actually active. If any
    // are still in flight, extend the timeout (up to 5min hard cap) instead
    // of killing them. Only if 0 active OR >5min total stale do we force-
    // cancel and re-queue.
    let lastProgressAt = Date.now();
    let lastProgressCount = 0;
    let watchdogStartedAt = Date.now();
    if (backupWatchdogRef.current) clearInterval(backupWatchdogRef.current);
    backupWatchdogRef.current = setInterval(async () => {
      const stalledMs = Date.now() - lastProgressAt;
      if (stalledMs <= 3 * 60 * 1000) return;
      // Check native module first — if uploads are still active, don't kill them
      let nativeActive = -1;
      try {
        const NU = (Platform.OS==='ios'?require('../modules/expo-background-upload').default:null);
        if (NU?.getActiveCount) nativeActive = await NU.getActiveCount();
      } catch {}
      const hardStale = stalledMs > 5 * 60 * 1000;
      if (nativeActive > 0 && !hardStale) {
        // Native is still working — JS just lost the progress stream.
        // Reset the JS-side counter so we don't keep alarming.
        lastProgressAt = Date.now();
        api.apiCall('drive_backup_debug', {
          msg: 'watchdog_yield_to_native',
          data: `nativeActive=${nativeActive} stalledMs=${stalledMs}`,
        }, 'POST').catch(() => {});
        return;
      }
      // Either 0 active OR >5min stale even with active — truly hung.
      try { (Platform.OS==='ios'?require('../modules/expo-background-upload').default:null)?.cancelAll?.(); } catch {}
      backupAbortRef.current = true;
      backupInFlightRef.current = false;
      cleanupBackupRefresh();
      clearInterval(backupWatchdogRef.current);
      backupWatchdogRef.current = null;
      setBackupStatus('paused');
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
          // Real device total drives the progress bar — was hardcoded 43000
          // which made the % meaningless on libraries of any other size. Fall
          // back to current backed-up total + still-pending so the bar
          // monotonically grows toward 100%.
          const realTotal = deviceTotalCount
            || (total > 0 ? total : 0)
            || (((backedUpTotal || 0) + (current || 0)) || 0)
            || 1;
          setBackupProgress({ current: totalUploaded + current, total: realTotal });
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
          // Counter is component-scoped (ref) so it can't leak across
          // mounts and can't be silently reset by a manual re-tap.
          backupZeroStreakRef.current += 1;
          if (backupZeroStreakRef.current >= 5) {
            backupZeroStreakRef.current = 0;
            break;
          }
          // Exponential-ish backoff between retries so we don't hammer
          // iOS while it's throttling us: 2s, 4s, 8s, 15s, 25s.
          const waits = [2000, 4000, 8000, 15000, 25000];
          await new Promise(r => setTimeout(r, waits[backupZeroStreakRef.current - 1] || 25000));
          continue;
        }
        // Good round — reset the zero-streak and pause briefly before next.
        backupZeroStreakRef.current = 0;
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
          backupRetryCountRef.current = 0;
          backupCompletedAtRef.current = Date.now();
        } else if (totalUploaded === 0) {
          // 2026-05-18 (#1126): the foreground loop ran every native pass
          // it could (5 zero-rounds with backoff inside the for-loop) and
          // ZERO new photos went up — but the device count still says
          // there are `remaining` left. Those photos are phantom assets
          // the engine physically cannot reconcile from this device:
          //  • iCloud-only originals the user never downloaded
          //  • hidden / library-corrupt PHAssets
          //  • already-deleted on device but still tracked in MediaLibrary
          //    totalCount (iOS bug; clears on next photo app open)
          //  • formats the server rejects (videos in iCloud over plan limit)
          // Scheduling another 45s retry CAN'T close the gap; it just keeps
          // the engine hot. Stamp the completed-at ref so the 30min
          // cooldown above blocks every re-entry path (auto-correct
          // effect, AppState resume, MediaLibrary listener), surface
          // 'complete' to the UI, and let the user manually tap "Reparar"
          // (forceStartBackup) if they think the gap is real.
          clearInterval(refreshTimer);
          cleanupBackupRefresh();
          setBackupStatus('complete');
          backupRetryCountRef.current = 0;
          backupCompletedAtRef.current = Date.now();
          try {
            api.apiCall('drive_backup_debug', {
              msg: 'foreground_loop_zero_with_drift',
              data: `device=${dt} server=${freshServer} remaining=${remaining}`,
            }, 'POST').catch(() => {});
          } catch {}
        } else {
          // We DID upload something this run but the device still has more
          // to send — KEEP the 'backing_up' banner and schedule the next
          // round (iOS re-grants BG budget eventually). Capped at 20
          // re-schedulings so a broken session eventually releases the
          // lock and a fresh tap of "Backup agora" can try from scratch.
          //
          // Counter lives on a component ref (was a static prop on the
          // function — which leaked across mounts and got reset on any
          // manual tap, defeating the cap entirely). The timeout handle is
          // tracked on backupRetryTimerRef so unmount/cleanup can cancel
          // it.
          backupRetryCountRef.current += 1;
          setBackupStatus('backing_up');
          if (backupRetryCountRef.current < 20) {
            if (backupRetryTimerRef.current) clearTimeout(backupRetryTimerRef.current);
            backupRetryTimerRef.current = setTimeout(() => {
              backupRetryTimerRef.current = null;
              if (backupAbortRef.current) return;
              // force-unlock + relaunch
              backupInFlightRef.current = false;
              startBackup();
            }, 45000); // 45s wait before the next attempt
          } else {
            // Give up for this session — user can tap Reparar.
            backupRetryCountRef.current = 0;
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
        let FileSystem; try { FileSystem = require('expo-file-system/legacy'); } catch { FileSystem = require('expo-file-system'); }
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
        try { FileSystem = require('expo-file-system/legacy'); } catch { FileSystem = require('expo-file-system'); }
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
      // Only build a drive_download URL when we actually have an id. Without
      // this guard a row missing both cdn_url AND thumbnail_url AND id fired
      // `drive_download?id=undefined` → HTTP 400 "File ID required" (the
      // "2 console err 400" QA saw on the photos grid). Return '' so the
      // <Image> just shows its placeholder instead of a failing request.
      if (photo.id == null || photo.id === '' || photo.id === 'undefined') return '';
      return api.fileDownloadUrl(photo.id);
    }
    return photo.uri;
  }, []);

  const [viewerResolvedUri, setViewerResolvedUri] = useState(null);
  const viewerResolveTokenRef = useRef(0);

  const getFullUrl = useCallback((photo) => {
    // Same id-guard as getThumbnailUrl: never emit drive_download?id=undefined
    // (→ HTTP 400). Prefer cdn_url, else download-by-id only when id exists.
    if (!photo.isDevice) {
      if (photo.cdn_url) return photo.cdn_url;
      if (photo.id == null || photo.id === '' || photo.id === 'undefined') return '';
      return api.fileDownloadUrl(photo.id);
    }
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
    const gap = 2; // explicit 2px gap between items
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
              // User explicitly tapped — bypass the post-complete cooldown
              // (#1126) so they can force a fresh attempt even if we
              // believed nothing was pending.
              backupCompletedAtRef.current = 0;
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
  // FAB hide-on-scroll: translates the FAB down ~96px when user scrolls
  // down past a small threshold; reveals it again when they scroll up.
  // Pattern: Instagram/Google Photos hide overlays so the user can read
  // content without the FAB covering the bottom row.
  const fabTranslateY = useRef(new Animated.Value(0)).current;
  const fabLastScrollY = useRef(0);
  const fabIsHidden = useRef(false);

  // ============================================================
  // NEW POST FLOW — Instagram-style multi-select → carousel → publish
  // ============================================================
  // Picks 1..10 media items from device library (or camera) and hands them
  // off to /photo-new for reorder/edit/remove + caption + publish. We stash
  // the asset list in AsyncStorage (router params can't carry files) under a
  // short-lived key the next screen reads on mount.
  const startNewPostFlow = useCallback(async (mode = 'library') => {
    try {
      if (Platform.OS === 'web') {
        // Web: re-use the existing FAB no-op path. Web users post via the
        // feed CreatePostModal which is mounted elsewhere.
        const ip = await import('expo-image-picker').catch(() => null);
        if (!ip) return;
      }
      const ImagePicker = await import('expo-image-picker');
      // Permission gate — silent re-prompt is fine, picker prompts itself.
      if (mode !== 'camera') {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          safeAlert(
            t('photos.permissionDenied') || 'Permissão negada',
            t('photos.permissionDeniedDesc') || 'Permita acesso às fotos pra criar uma publicação.',
          );
          return;
        }
      }

      // [#1187 2026-05-19] iOS modal-over-modal race — UIKit silently drops
      // the 2nd Modal (PHPicker) if a previous modal (FAB sheet, dialog) is
      // still in its dismiss animation. User report: "clico em + nao aparece
      // nada". Wait one frame on iOS before launching the picker so any
      // prior dismiss completes.
      if (Platform.OS === 'ios') {
        await new Promise(resolve => setTimeout(resolve, 350));
      }

      const pick = mode === 'camera'
        ? await ImagePicker.launchCameraAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.All,
            quality: 0.9,
            videoMaxDuration: 60,
          })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.All,
            allowsMultipleSelection: true,
            selectionLimit: 10,
            quality: 0.9,
            orderedSelection: true,
          });

      if (pick.canceled || !pick.assets?.length) return;

      const items = pick.assets.map((a, idx) => {
        const isVid = (a.type === 'video') || (a.mimeType || '').startsWith('video');
        return {
          id: `${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 7)}`,
          uri: a.uri,
          type: isVid ? 'video' : 'image',
          width: a.width,
          height: a.height,
          duration: a.duration,
          fileName: a.fileName || `media_${Date.now()}_${idx}.${isVid ? 'mp4' : 'jpg'}`,
          mimeType: a.mimeType || (isVid ? 'video/mp4' : 'image/jpeg'),
        };
      });

      await AsyncStorage.setItem('photoNew.pending', JSON.stringify(items));
      router.push('/photo-new');
    } catch (e) {
      safeAlert(
        t('photos.pickerError') || 'Erro',
        e?.message || (t('photos.pickerErrorDesc') || 'Não foi possível abrir a galeria.'),
      );
    }
  }, [router, t]);

  // Thumbnails: 200x200 JPEG cached to disk via thumbnailCache service
  // Grid shows cached file:// thumbUri (instant) or ph:// uri as fallback

  // Memoized PhotoGridItem
  const PhotoGridItem = React.memo(({ photo, index, isSelected, selectMode: sm, gridItemSize: gis, onPress, onLongPress, primaryColor }) => {
    const isVideoItem = isVideo(photo);

    // Use cached thumbnail (file://) if available, then ph:// URI, then cloud thumbnail
    const imageUri = (photo.isDevice && photo.thumbUri) ? photo.thumbUri
      : (photo.isDevice ? photo.uri : getThumbnailUrl(photo));

    // WhatsApp/Google Photos pattern: warm the full-res URL the moment the
    // finger touches the cell. By the time onPress fires + the viewer modal
    // mounts (~120-200ms of spring animation), the full image has either
    // started decoding or is already on disk → no perceived load delay.
    const _prefetchFull = useCallback(() => {
      if (Platform.OS === 'web' || photo.isDevice) return;
      try {
        const url = photo.cdn_url || api.fileDownloadUrl(photo.id);
        if (url) ExpoImage.prefetch?.(url, 'memory-disk');
      } catch {}
    }, [photo.id, photo.isDevice, photo.cdn_url]);

    return (
      <Pressable
        onPress={onPress}
        onPressIn={_prefetchFull}
        onLongPress={onLongPress}
        style={[
          s.gridItem,
          { width: gis, height: gis, borderRadius: 8 },
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
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
          <View style={{ width: 4, height: 16, borderRadius: 3, backgroundColor: '#7C3AED' }} />
          <Text
            style={[
              s.sectionTitle,
              {
                color: colors.text,
                fontSize: 16,
                fontWeight: '800',
                letterSpacing: -0.3,
              },
            ]}
            numberOfLines={1}
          >
            {section.title}
          </Text>
        </View>
        {total > 0 && (
          <View style={[s.sectionCountChip, { backgroundColor: isDark ? 'rgba(124,58,237,0.18)' : 'rgba(124,58,237,0.08)' }]}>
            <Text style={[s.sectionCount, { color: '#7C3AED', fontWeight: '700' }]}>
              {total}
            </Text>
          </View>
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
            {/* SVG illustration: 3 grey rectangles fanned out + camera icon centered */}
            <Svg width={160} height={120} viewBox="0 0 160 120">
              {/* Back-left rectangle (rotated -10deg) */}
              <Rect
                x="18" y="28" width="56" height="68" rx="8"
                fill={isDark ? '#334155' : '#E5E7EB'}
                opacity="0.7"
                transform="rotate(-10 46 62)"
              />
              {/* Back-right rectangle (rotated +10deg) */}
              <Rect
                x="86" y="28" width="56" height="68" rx="8"
                fill={isDark ? '#334155' : '#E5E7EB'}
                opacity="0.7"
                transform="rotate(10 114 62)"
              />
              {/* Front rectangle */}
              <Rect
                x="52" y="22" width="56" height="74" rx="10"
                fill={isDark ? '#475569' : '#D1D5DB'}
              />
            </Svg>
            <View style={s.emptyIconCenter} pointerEvents="none">
              <IconImage size={36} color={isDark ? '#cbd5e1' : '#6B7280'} />
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

      // FAB hide-on-scroll: down past 8px → translate +96 (offscreen);
      // up by 8px → reset. Guard with isHidden to avoid re-animating each frame.
      const y = contentOffset.y;
      const delta = y - fabLastScrollY.current;
      if (delta > 8 && y > 40 && !fabIsHidden.current) {
        fabIsHidden.current = true;
        Animated.timing(fabTranslateY, { toValue: 96, duration: 200, useNativeDriver: true }).start();
      } else if (delta < -8 && fabIsHidden.current) {
        fabIsHidden.current = false;
        Animated.timing(fabTranslateY, { toValue: 0, duration: 200, useNativeDriver: true }).start();
      }
      fabLastScrollY.current = y;

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
          stickySectionHeadersEnabled={true}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          // Performance: the main Photos grid was rendering every row in the
          // dataset on mount with no windowing — first paint after open took
          // 2-4s on 5000+ photo backups. These props mirror the Albums grid
          // (which already has perf props) and let Metro window-render rows.
          removeClippedSubviews={Platform.OS !== 'web'}
          windowSize={7}
          maxToRenderPerBatch={6}
          initialNumToRender={4}
          updateCellsBatchingPeriod={50}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          ListHeaderComponent={
            <View>
              {renderBackupBanner()}
              {/* Active memory filter pill — surfaces what's selected and lets
                  the user bail out without hunting for a back button. */}
              {presetFilter && (
                <Pressable
                  onPress={() => { setPresetFilter(null); setPresetMLIds(null); }}
                  style={{
                    flexDirection: 'row', alignItems: 'center',
                    alignSelf: 'flex-start',
                    marginHorizontal: Spacing.lg, marginTop: 8, marginBottom: 4,
                    paddingHorizontal: 12, paddingVertical: 6,
                    borderRadius: 16,
                    backgroundColor: isDark ? 'rgba(124,58,237,0.22)' : 'rgba(124,58,237,0.10)',
                    gap: 6,
                  }}
                >
                  {presetLoading ? (
                    <ActivityIndicator size="small" color="#7C3AED" />
                  ) : null}
                  <Text style={{ fontSize: 13, fontWeight: '700', color: '#7C3AED' }}>
                    {(() => {
                      // Centralized label resolver — keeps the active-filter
                      // pill in sync with the card list. Falls back to a
                      // capitalized key so a future preset auto-labels even
                      // without a manual entry here.
                      const labels = {
                        summer: `Verão ${(new Date().getMonth() >= 11 ? new Date().getFullYear() + 1 : new Date().getFullYear())}`,
                        thisweek: 'Esta semana',
                        people: 'Pessoas',
                        selfies: 'Selfies',
                        food: 'Comida',
                        pets: 'Pets',
                        sunset: 'Por do sol',
                        documents: 'Documentos',
                      };
                      return labels[presetFilter] || (presetFilter.charAt(0).toUpperCase() + presetFilter.slice(1));
                    })()}
                  </Text>
                  <Text style={{ fontSize: 13, color: '#7C3AED', fontWeight: '700' }}>×</Text>
                </Pressable>
              )}
              {/* Memories — iOS Photos-grade horizontal carousel (320×180 cinematic 16:9). */}
              {/* Hard guard: section is hidden entirely when there's nothing to surface — */}
              {/*   no memoriesData buckets AND not enough photos for the curated presets. */}
              {/* Bucket-empty case (e.g. brand-new account) collapses cleanly. */}
              {!searchText && !showFavorites && !presetFilter && (visibleMemoriesData.length > 0 || filteredPhotos.length > 6) && (
                <MemoriesCarousel
                  colors={colors}
                  isDark={isDark}
                  t={t}
                  locale={locale}
                  memoriesData={visibleMemoriesData}
                  filteredPhotos={filteredPhotos}
                  getThumbnailUrl={getThumbnailUrl}
                  openViewer={openViewer}
                  openMemory={setMemoryViewer}
                  api={api}
                  setPresetFilter={setPresetFilter}
                  setPresetMLIds={setPresetMLIds}
                  setPresetLoading={setPresetLoading}
                  onMuteMemory={muteMemory}
                  s={s}
                />
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
      return loading ? (
        <GridSkeleton count={6} columns={3} />
      ) : (
        <View style={s.emptyState}>
          <View style={s.emptyIllustration}>
            <View style={[s.emptyIconCircle, { backgroundColor: isDark ? 'rgba(124,58,237,0.16)' : 'rgba(124,58,237,0.08)' }]}>
              <IconAlbum size={48} color="#7C3AED" />
            </View>
          </View>
          <Text style={[s.emptyTitle, { color: colors.text }]}>{t('photos.noAlbums')}</Text>
          <Text style={[s.emptySubtitle, { color: colors.textSecondary }]}>
            {t('photos.noAlbumsDesc') || 'Crie álbuns para organizar suas fotos favoritas.'}
          </Text>
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
                <View style={[s.albumCoverPlaceholder, { width: albumSize, aspectRatio: 1, backgroundColor: colors.surfaceVariant }]}>
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
                style={[s.albumCover, { width: albumSize, backgroundColor: colors.surfaceVariant || '#f1f5f9' }]}
                resizeMode="cover"
                defaultSource={undefined}
                onError={() => {}}
              />
            ) : (
              <View style={[s.albumCoverPlaceholder, { width: albumSize, aspectRatio: 1, backgroundColor: colors.surfaceVariant || '#f1f5f9' }]}>
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

  // ============================================================
  // PEOPLE TAB (Wave 14 — real face recognition via FaceNet embeddings)
  // ============================================================
  // Distinct from `faceClusters` (which is a coarse "1/2/3+ people" bucket
  // from the OpenAI vision pass). `realFaceClusters` is the cosine-clustered
  // FaceNet output the on-device pipeline + backend build over time.
  const [realFaceClusters, setRealFaceClusters] = useState([]);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [viewingCluster, setViewingCluster] = useState(null);     // {cluster_id, person_name}
  const [clusterPhotos, setClusterPhotos] = useState([]);
  const [clusterLoading, setClusterLoading] = useState(false);
  const [renameClusterTarget, setRenameClusterTarget] = useState(null);
  const [renameValue, setRenameValue] = useState('');

  useEffect(() => {
    if (activeTab !== 'people') return;
    setPeopleLoading(true);
    api.photosFaceClusters().then(res => {
      if (res?.success && res.data) {
        setRealFaceClusters(res.data.clusters || []);
      } else {
        setRealFaceClusters([]);
      }
    }).catch(() => setRealFaceClusters([])).finally(() => setPeopleLoading(false));
  }, [activeTab]);

  const openCluster = useCallback(async (cluster) => {
    setViewingCluster(cluster);
    setClusterLoading(true);
    setClusterPhotos([]);
    try {
      const res = await api.photosFaceClusterPhotos(cluster.cluster_id);
      if (res?.success && res.data) setClusterPhotos(res.data.photos || []);
    } catch {}
    setClusterLoading(false);
  }, []);

  const submitClusterRename = useCallback(async () => {
    if (!renameClusterTarget) return;
    const name = renameValue.trim();
    try {
      await api.photosFaceClusterName(renameClusterTarget.cluster_id, name);
      setRealFaceClusters(prev => prev.map(c =>
        c.cluster_id === renameClusterTarget.cluster_id ? { ...c, person_name: name || null } : c
      ));
      if (viewingCluster?.cluster_id === renameClusterTarget.cluster_id) {
        setViewingCluster({ ...viewingCluster, person_name: name || null });
      }
    } catch {}
    setRenameClusterTarget(null);
    setRenameValue('');
  }, [renameClusterTarget, renameValue, viewingCluster]);

  const renderPeopleTab = useCallback(() => {
    if (viewingCluster) {
      const title = viewingCluster.person_name || `Pessoa ${viewingCluster.cluster_id?.slice(2, 6) || ''}`;
      return (
        <View style={{ flex: 1 }}>
          <View style={[s.albumDetailHeader, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
            <TouchableOpacity onPress={() => { setViewingCluster(null); setClusterPhotos([]); }} style={s.albumBackBtn}>
              <IconArrowLeft size={24} color={colors.text} />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={[s.albumDetailTitle, { color: colors.text }]} numberOfLines={1}>{title}</Text>
              <Text style={[s.albumDetailCount, { color: colors.textSecondary }]}>
                {clusterPhotos.length} {t('photos.items') || 'fotos'}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => { setRenameClusterTarget(viewingCluster); setRenameValue(viewingCluster.person_name || ''); }}
              style={{ padding: 8 }}
              accessibilityLabel="Renomear"
            >
              <IconEdit size={20} color={colors.text} />
            </TouchableOpacity>
          </View>
          {clusterLoading ? (
            <GridSkeleton count={9} columns={3} />
          ) : (
            <FlatList
              data={clusterPhotos}
              numColumns={3}
              keyExtractor={(item) => `cp_${item.id}`}
              contentContainerStyle={{ paddingBottom: 80 + insets.bottom }}
              renderItem={({ item, index }) => renderPhotoItem({ item, index })}
              windowSize={10}
              maxToRenderPerBatch={15}
              initialNumToRender={18}
            />
          )}
        </View>
      );
    }
    return (
      <FlatList
        data={[1]}
        keyExtractor={() => 'people-content'}
        contentContainerStyle={{ paddingBottom: 80 + insets.bottom }}
        renderItem={() => (
          <View style={{ padding: Spacing.lg }}>
            <Text style={[s.cardTitle, { color: colors.text, marginBottom: 12 }]}>
              {t('photos.people') || 'Pessoas'}
            </Text>
            {peopleLoading ? (
              <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                <ActivityIndicator color={colors.primary} />
              </View>
            ) : realFaceClusters.length === 0 ? (
              <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                <View style={[s.emptyIconCircle, { backgroundColor: isDark ? 'rgba(124,58,237,0.16)' : 'rgba(124,58,237,0.08)' }]}>
                  <IconUsers size={44} color="#7C3AED" />
                </View>
                <Text style={{ color: colors.text, fontSize: 17, fontWeight: '800', marginTop: 16, letterSpacing: -0.3 }}>
                  {t('photos.peopleEmptyTitle') || 'Ninguém por aqui ainda'}
                </Text>
                <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 8, textAlign: 'center', lineHeight: 20, paddingHorizontal: 24 }}>
                  {t('photos.peopleEmpty') || 'Conforme suas fotos forem analisadas, rostos similares vao agrupar aqui automaticamente.'}
                </Text>
              </View>
            ) : (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
                {realFaceClusters.map((cluster) => {
                  const label = cluster.person_name || `Pessoa ${cluster.cluster_id?.slice(2, 6) || ''}`;
                  return (
                    <TouchableOpacity
                      key={cluster.cluster_id}
                      onPress={() => openCluster(cluster)}
                      onLongPress={() => { setRenameClusterTarget(cluster); setRenameValue(cluster.person_name || ''); }}
                      style={{ alignItems: 'center', width: 92 }}
                      accessibilityLabel={label}
                    >
                      {cluster.sample_url ? (
                        <Image
                          source={{ uri: cluster.sample_url }}
                          style={[s.clusterAvatar, { borderColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.05)' }]}
                        />
                      ) : (
                        <View style={[s.clusterAvatar, { backgroundColor: colors.surfaceVariant, alignItems: 'center', justifyContent: 'center', borderColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.05)' }]}>
                          <IconUsers size={32} color={colors.textTertiary} />
                        </View>
                      )}
                      <Text numberOfLines={1} style={{ color: colors.text, fontSize: 13, fontWeight: '600', marginTop: 6, textAlign: 'center' }}>
                        {label}
                      </Text>
                      <Text style={{ color: colors.textSecondary, fontSize: 11 }}>
                        {cluster.photo_count} {t('photos.items') || 'fotos'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </View>
        )}
      />
    );
  }, [viewingCluster, clusterPhotos, clusterLoading, peopleLoading, realFaceClusters, colors, insets.bottom, t, openCluster]);

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
                    {tag.count ? <Text style={{ color: colors.textSecondary, fontSize: 10, marginLeft: 4 }}>{tag.count}</Text> : null}
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
                    onPress={() => {
                      // User-initiated "Continuar" — bypass post-complete cooldown (#1126)
                      backupCompletedAtRef.current = 0;
                      setBackupStatus('idle');
                      startBackup();
                    }}
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
                onPress={() => {
                  // User-initiated "Backup agora" — bypass post-complete cooldown (#1126)
                  backupCompletedAtRef.current = 0;
                  startBackup();
                }}
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

              {/* v3 migration restore — only shown when a v2 snapshot exists.
                  The v3 migration wiped the backed-up map and saved the old
                  map at `_v2_backup`. Without this UI surface there was no
                  way for the user to recover from the wipe. */}
              {hasV2Snapshot && (
                <TouchableOpacity
                  style={[s.actionBtn, { borderBottomWidth: 1, borderBottomColor: colors.border }]}
                  onPress={() => {
                    safeAlert(
                      'Restaurar mapa anterior',
                      'Carrega o mapa de fotos backupeadas anterior à migração. Pode evitar re-uploads.',
                      [
                        { text: t('common.cancel'), style: 'cancel' },
                        {
                          text: 'Restaurar',
                          onPress: async () => {
                            try {
                              const bs = require('../services/backup/backupStorage');
                              const n = await bs.restoreV2Snapshot();
                              if (n > 0) {
                                safeAlert('', `${n} fotos marcadas como já backupeadas.`);
                                setHasV2Snapshot(false);
                              } else if (n === 0) {
                                safeAlert('', 'Mapa anterior vazio — nada a restaurar.');
                              } else {
                                safeAlert('', 'Nenhum mapa anterior encontrado.');
                              }
                            } catch (e) {
                              safeAlert('Erro', e?.message || 'falhou');
                            }
                          },
                        },
                      ]
                    );
                  }}
                  disabled={Platform.OS === 'web'}
                >
                  <IconRefresh size={20} color={colors.primary} />
                  <Text style={[s.actionBtnText, { color: colors.primary }]}>Restaurar mapa anterior</Text>
                </TouchableOpacity>
              )}

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
            {/* Print to canvas — opens a partner print service in the system
                browser. Stub for now: Mixtiles affiliate URL. Real wiring will
                pass the photo CDN URL as a query param once the partner SDK
                publishes the receive-import API. Keeps the print button real
                so users can already export their photos to physical media. */}
            <TouchableOpacity
              style={s.viewerBtn}
              onPress={async () => {
                try {
                  const photoUrl = encodeURIComponent(viewerResolvedUri || getFullUrl(viewerPhoto) || '');
                  // Mixtiles is the friendlier of the two big consumer-photo
                  // print services and they accept ?image= queries. Swap for
                  // a server-side affiliate redirect once revenue share is wired.
                  const partner = `https://www.mixtiles.com/?utm_source=chatyy&utm_medium=app&image_url=${photoUrl}`;
                  if (Platform.OS === 'web') {
                    window.open(partner, '_blank');
                  } else {
                    const WB = require('expo-web-browser');
                    await WB.openBrowserAsync(partner);
                  }
                } catch (e) { console.warn('[Photos] print partner error:', e); }
              }}
              accessibilityLabel={t('photos.print') || 'Imprimir'}
            >
              {/* Inline printer SVG to avoid pulling another icon. Visual
                  weight matches the existing 22-px outline icons next to it. */}
              <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <Polyline points="6 9 6 2 18 2 18 9" />
                <Path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                <Rect x="6" y="14" width="12" height="8" />
              </Svg>
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
                      cachePolicy="memory-disk"
                      priority="high"
                      transition={120}
                      // Paint the 200×200 thumbnail behind the full-res image
                      // so the modal doesn't show a black gap during decode.
                      // expo-image handles the crossfade once the high-res
                      // bytes arrive; on disk-cache hit the placeholder is
                      // invisible (full paints immediately).
                      placeholder={(() => {
                        const t = getThumbnailUrl(viewerPhoto);
                        return t ? { uri: t } : undefined;
                      })()}
                      placeholderContentFit="contain"
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
            const Ico = tab === 'photos' ? IconImage
              : tab === 'search' ? IconSearch
              : tab === 'albums' ? IconAlbum
              : tab === 'people' ? IconUsers
              : tab === 'map' ? IconMap
              : IconCloud;
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
                    ? [{ backgroundColor: '#7C3AED' }, s.tabPillActive]
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
            {activeTab === 'people' && renderPeopleTab()}
            {activeTab === 'map' && (
              <ErrorBoundary>
                <PhotosMapTab
                  colors={colors}
                  isDark={isDark}
                  insets={insets}
                  t={t}
                  api={api}
                  allPhotos={allPhotos}
                  openViewer={openViewer}
                />
              </ErrorBoundary>
            )}
            {activeTab === 'backup' && (
              <ErrorBoundary>
                {renderBackupTab()}
              </ErrorBoundary>
            )}
          </>
        )}
      </View>

      {/* FAB - New post (Instagram-style multi-select).
          Wrapped in Animated.View so it hides on scroll down (Instagram pattern). */}
      {!selectMode && activeTab === 'photos' && (
        <Animated.View style={[s.fabContainer, { bottom: 24 + insets.bottom, transform: [{ translateY: fabTranslateY }] }]}>
          {fabOpen && (
            <Animated.View style={[s.fabOptions, { opacity: fabRotateAnim }]}>
              <TouchableOpacity
                style={[s.fabOption, { backgroundColor: colors.surface, ...Shadow.md }]}
                onPress={() => { setFabOpen(false); startNewPostFlow('camera'); }}
              >
                <IconCamera size={20} color={colors.primary} />
                <Text style={[s.fabOptionText, { color: colors.text }]}>{t('photos.camera') || 'Camera'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.fabOption, { backgroundColor: colors.surface, ...Shadow.md }]}
                onPress={() => { setFabOpen(false); startNewPostFlow('library'); }}
              >
                <IconCloudUpload size={20} color={colors.primary} />
                <Text style={[s.fabOptionText, { color: colors.text }]}>{t('photos.newPost') || 'Nova publicação'}</Text>
              </TouchableOpacity>
            </Animated.View>
          )}
          <BrandFab
            size={56}
            color={colors.primary}
            onPress={() => {
              // Tap-to-open Instagram-style flow direct; long-press cycles options.
              // For now: single tap opens the multi-select library flow (the
              // user's #1 ask). Keep the legacy mini-menu accessible via the
              // spring rotation when they need camera explicitly.
              startNewPostFlow('library');
            }}
            onLongPress={() => {
              const newVal = !fabOpen;
              setFabOpen(newVal);
              Animated.spring(fabRotateAnim, { toValue: newVal ? 1 : 0, tension: 220, friction: 14, useNativeDriver: true }).start();
            }}
            accessibilityLabel={t('photos.newPost') || 'Nova publicação'}
            contentTransform={[
              { rotate: fabRotateAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '45deg'] }) },
            ]}
          >
            <IconPlus size={26} color="#fff" />
          </BrandFab>
        </Animated.View>
      )}

      {/* Batch operations toolbar — Google Photos grade */}
      {selectMode && selectedItems.size > 0 && (
        <View
          style={[
            s.batchToolbar,
            {
              backgroundColor: isDark ? 'rgba(15,23,42,0.96)' : 'rgba(255,255,255,0.98)',
              borderTopColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
              paddingBottom: (insets.bottom || 0) + 16,
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
          {/* Wave 14: photobook PDF */}
          <TouchableOpacity
            style={s.batchAction}
            onPress={() => {
              const ids = filteredPhotos
                .filter(p => selectedItems.has(p.id) && !p.isDevice)
                .map(p => p.id);
              if (ids.length === 0) return;
              if (ids.length > 100) {
                safeAlert?.('Limite 100', 'Selecione ate 100 fotos por album.');
                return;
              }
              openPhotobookForSelection(ids);
            }}
            accessibilityLabel="Criar album"
          >
            <View style={[s.batchActionPill, { backgroundColor: 'rgba(16,185,129,0.14)' }]}>
              <IconAlbum size={20} color="#10B981" />
            </View>
            <Text style={[s.batchActionText, { color: colors.text }]}>{t('photos.photobook') || 'Album'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.batchAction}
            onPress={async () => {
              // Export selected as a single ZIP. Server-side endpoint streams
              // the bytes, so on native we open the URL via expo-web-browser
              // (system browser handles download UX). On web we navigate
              // directly so the browser's downloader takes over.
              const selectedIds = filteredPhotos
                .filter(p => selectedItems.has(p.id) && !p.isDevice)
                .map(p => p.id);
              if (selectedIds.length === 0) return;
              if (selectedIds.length > 500) {
                safeAlert?.(t('photos.exportTooMany') || 'Limite 500', t('photos.exportTooManyDesc') || 'Selecione até 500 fotos.');
                return;
              }
              const url = api.photosExportZipUrl(selectedIds);
              try {
                if (Platform.OS === 'web') {
                  window.location.href = url;
                } else {
                  const WB = require('expo-web-browser');
                  await WB.openBrowserAsync(url);
                }
              } catch (e) {
                console.warn('[Photos] export zip error:', e);
              }
              clearSelection();
            }}
            accessibilityLabel={t('photos.exportZip') || 'Exportar ZIP'}
          >
            <View style={[s.batchActionPill, { backgroundColor: 'rgba(14,165,233,0.12)' }]}>
              {/* Reuse IconDownload for now — a dedicated archive icon would be
                  cleaner but the rest of the bar already uses Lucide-style
                  outline icons; the action label is the disambiguator. */}
              <IconDownload size={20} color="#0EA5E9" />
            </View>
            <Text style={[s.batchActionText, { color: colors.text }]}>{t('photos.exportZip') || 'ZIP'}</Text>
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

      {/* Wave 14 — rename face cluster modal */}
      <Modal visible={!!renameClusterTarget} transparent animationType="fade" onRequestClose={() => setRenameClusterTarget(null)}>
        <Pressable style={s.modalOverlay} onPress={() => setRenameClusterTarget(null)}>
          <Pressable style={[s.modalContent, { backgroundColor: colors.surface }]} onPress={e => e.stopPropagation()}>
            <Text style={[s.modalTitle, { color: colors.text }]}>
              {t('photos.namePerson') || 'Nomear pessoa'}
            </Text>
            <TextInput
              style={[s.modalInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
              placeholder={t('photos.personNamePlaceholder') || 'Nome da pessoa'}
              placeholderTextColor={colors.textTertiary}
              value={renameValue}
              onChangeText={setRenameValue}
              autoFocus
              onSubmitEditing={submitClusterRename}
            />
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 12, marginTop: 16 }}>
              <TouchableOpacity onPress={() => setRenameClusterTarget(null)} style={s.modalBtn}>
                <Text style={{ color: colors.textSecondary }}>{t('common.cancel') || 'Cancelar'}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={submitClusterRename} style={[s.modalBtn, { backgroundColor: colors.primary, borderRadius: 8 }]}>
                <Text style={{ color: '#fff', fontWeight: '600' }}>{t('common.save') || 'Salvar'}</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Wave 14 — photobook layout picker + progress */}
      <Modal visible={photobookVisible} transparent animationType="fade" onRequestClose={() => !photobookGenerating && setPhotobookVisible(false)}>
        <Pressable
          style={s.modalOverlay}
          onPress={() => !photobookGenerating && setPhotobookVisible(false)}
        >
          <Pressable style={[s.modalContent, { backgroundColor: colors.surface, width: 320 }]} onPress={e => e.stopPropagation()}>
            <Text style={[s.modalTitle, { color: colors.text }]}>
              {t('photos.createPhotobook') || 'Criar album'}
            </Text>
            <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 12 }}>
              {photobookSelectedCount} {t('photos.items') || 'fotos'} {t('photos.selected') || 'selecionadas'}
            </Text>
            {/* Layout choice */}
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
              {['grid', 'magazine', 'minimal'].map(layout => (
                <TouchableOpacity
                  key={layout}
                  disabled={photobookGenerating}
                  onPress={() => setPhotobookLayout(layout)}
                  style={[
                    {
                      flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: 'center',
                      backgroundColor: photobookLayout === layout ? colors.primary : (isDark ? 'rgba(255,255,255,0.06)' : '#F3F4F6'),
                    },
                  ]}
                >
                  <Text style={{
                    color: photobookLayout === layout ? '#fff' : colors.text,
                    fontWeight: '600', fontSize: 13,
                  }}>
                    {layout === 'grid' ? (t('photos.layoutGrid') || 'Grade')
                      : layout === 'magazine' ? (t('photos.layoutMagazine') || 'Revista')
                      : (t('photos.layoutMinimal') || 'Minimal')}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {photobookGenerating ? (
              <View style={{ paddingVertical: 16, alignItems: 'center' }}>
                <ActivityIndicator color={colors.primary} />
                <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 8 }}>
                  {t('photos.generatingPdf') || 'Gerando PDF...'}
                </Text>
              </View>
            ) : photobookResult?.pdf_url ? (
              <View style={{ paddingVertical: 8 }}>
                <Text style={{ color: colors.textSecondary, fontSize: 12, marginBottom: 10 }}>
                  {(photobookResult.page_count || 0)} {t('photos.pages') || 'paginas'} · {Math.round((photobookResult.size_bytes || 0) / 1024)} KB
                </Text>
                <TouchableOpacity
                  onPress={async () => {
                    try {
                      const url = photobookResult.pdf_url.startsWith('http')
                        ? photobookResult.pdf_url
                        : `https://chatyy.com.br${photobookResult.pdf_url}`;
                      if (Platform.OS === 'web') { window.open(url, '_blank'); }
                      else {
                        const WB = require('expo-web-browser');
                        await WB.openBrowserAsync(url);
                      }
                    } catch (e) { console.warn('[photobook] open failed:', e); }
                  }}
                  style={[s.modalBtn, { backgroundColor: colors.primary, borderRadius: 8, paddingHorizontal: 16 }]}
                >
                  <Text style={{ color: '#fff', fontWeight: '600' }}>
                    {t('photos.downloadPdf') || 'Baixar PDF'}
                  </Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 12, marginTop: 8 }}>
                <TouchableOpacity onPress={() => setPhotobookVisible(false)} style={s.modalBtn}>
                  <Text style={{ color: colors.textSecondary }}>{t('common.cancel') || 'Cancelar'}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={generatePhotobook} style={[s.modalBtn, { backgroundColor: colors.primary, borderRadius: 8 }]}>
                  <Text style={{ color: '#fff', fontWeight: '600' }}>{t('photos.generate') || 'Gerar'}</Text>
                </TouchableOpacity>
              </View>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Viewer modal */}
      {renderViewer()}

      {/* [#1345] Memory slideshow viewer — story-style auto-advancing player. */}
      {memoryViewer ? (
        <MemoryViewer
          memory={memoryViewer}
          onClose={() => setMemoryViewer(null)}
          getThumbnailUrl={getThumbnailUrl}
          t={t}
          colors={colors}
        />
      ) : null}

      {/* Photo Editor */}
      <PhotoEditor
        visible={editorVisible}
        imageUri={viewerPhoto ? getFullUrl(viewerPhoto) : null}
        photoId={viewerPhoto?.id}
        onSave={handleEditorSave}
        onClose={() => setEditorVisible(false)}
      />
    </Animated.View>
  );
}

// ============================================================
// MEMORIES CAROUSEL — iOS Photos parity
// ============================================================
// Cinematic 320×180 (16:9) cards with bottom-up dark gradient overlay, glass
// title slab, sparkle iconography, and a stagger fade+rise entrance (80ms per
// card). Extracted into its own component so the entrance animation owns its
// lifecycle (mounts once when section becomes visible) — folding it back into
// the parent re-renders every scroll tick and burns the spring.
function IconSparkles({ size = 16, color = '#fff' }) {
  // iOS Photos uses a triple-twinkle sparkle for Memories. Path is a 4-point
  // star with two satellite mini-stars — purely decorative, never load-bearing.
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3l1.6 4.6L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.4L12 3z"
        fill={color}
      />
      <Path d="M19 14l.7 1.8L21.5 16l-1.8.5L19 18l-.7-1.5L16.5 16l1.8-.5L19 14z" fill={color} opacity={0.8} />
      <Path d="M5 16l.5 1.3L7 18l-1.5.4L5 20l-.5-1.6L3 18l1.5-.7L5 16z" fill={color} opacity={0.65} />
    </Svg>
  );
}

// PhotosMapTab — Google Maps WebView with clustered pins for geo-tagged
// photos. Backend (photos_with_gps) buckets points by 2-decimal lat/lon so
// dense vacation albums collapse into a single ~1km cluster instead of
// thousands of overlapping pins. Tapping a pin asks the embedded JS bridge
// to surface the photo id; we then call openViewer on the matching frame.
// Why WebView + Google Maps embed: react-native-maps would need a native
// rebuild + Google billing token wiring. The embed is bundled, free, and
// works on iOS / Android / web with zero extra dep.
function PhotosMapTab({ colors, isDark, insets, t, api, allPhotos, openViewer }) {
  const [loading, setLoading] = React.useState(true);
  const [extracting, setExtracting] = React.useState(false);
  const [clusters, setClusters] = React.useState([]);
  const [total, setTotal] = React.useState(0);
  const [error, setError] = React.useState(null);

  // Lazy require so the import doesn't pull react-native-webview into web
  // bundles that don't need it.
  let WebView = null;
  try { WebView = require('react-native-webview').WebView; } catch {}

  const loadClusters = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.photosWithGps();
      if (r?.success && r?.data) {
        setClusters(r.data.clusters || []);
        setTotal(r.data.total || 0);
      } else {
        setError(r?.error || 'Falha ao carregar mapa');
      }
    } catch (e) {
      setError(e?.message || 'Falha ao carregar mapa');
    } finally {
      setLoading(false);
    }
  }, [api]);

  // Trigger an EXIF GPS extraction pass — pulls metadata from up to 100 photos
  // that don't yet have gps_lat. Re-fetches the clusters when done.
  const runExtract = React.useCallback(async () => {
    setExtracting(true);
    try {
      await api.photosExtractGps(100);
      await loadClusters();
    } catch {} finally {
      setExtracting(false);
    }
  }, [api, loadClusters]);

  React.useEffect(() => { loadClusters(); }, [loadClusters]);

  // Build the Google Maps embed HTML. We use the public /maps/embed/v1/view
  // endpoint when there's nothing to plot (just a centered view), and
  // /maps/embed/v1/search with a marker list for cluster centroids. The
  // simplest cross-platform path is to render markers via the JS API; the
  // free embed endpoint doesn't support clusters natively, so we use the
  // gmaps JS SDK with a placeholder API key the user can swap later.
  const mapHtml = React.useMemo(() => {
    const center = clusters.length > 0
      ? { lat: clusters[0].lat, lng: clusters[0].lon }
      : { lat: -23.5505, lng: -46.6333 }; // São Paulo fallback
    const markersJson = JSON.stringify(clusters.map(c => ({
      lat: c.lat, lng: c.lon, count: c.count, id: c.sample_id,
    })));
    // Inline HTML — OpenStreetMap via Leaflet (no API key needed, no per-load
    // billing). Pins clickable; click posts a message back to RN.
    return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>html,body,#map{height:100%;margin:0;padding:0;background:${isDark ? '#0b0f17' : '#fff'}}.cluster{background:#7C3AED;color:#fff;border-radius:18px;padding:4px 10px;font:600 13px system-ui;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3)}</style>
</head><body>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  const map = L.map('map', { zoomControl: true }).setView([${center.lat}, ${center.lng}], ${clusters.length > 0 ? 10 : 5});
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 19
  }).addTo(map);
  const markers = ${markersJson};
  const bounds = [];
  markers.forEach(m => {
    const icon = L.divIcon({ html: '<div class="cluster">' + m.count + '</div>', className: '', iconSize: [40, 28] });
    const pin = L.marker([m.lat, m.lng], { icon }).addTo(map);
    pin.on('click', () => {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'pin_tap', id: m.id }));
      }
    });
    bounds.push([m.lat, m.lng]);
  });
  if (bounds.length > 1) map.fitBounds(bounds, { padding: [40, 40] });
</script>
</body></html>`;
  }, [clusters, isDark]);

  const onMessage = React.useCallback((evt) => {
    try {
      const data = JSON.parse(evt?.nativeEvent?.data || '{}');
      if (data.type === 'pin_tap' && data.id) {
        const idx = (allPhotos || []).findIndex(p => String(p.id) === String(data.id));
        if (idx >= 0) openViewer(idx);
      }
    } catch {}
  }, [allPhotos, openViewer]);

  // Empty / loading / error states. Map renders only when we have a WebView
  // AND there are cluster points to show; otherwise we show a CTA explaining
  // how to populate EXIF metadata for backed-up photos.
  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color="#7C3AED" />
        <Text style={{ marginTop: 10, color: colors.textSecondary, fontSize: 13 }}>
          {t('photos.mapLoading') || 'Carregando mapa...'}
        </Text>
      </View>
    );
  }
  if (error) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>
          {error}
        </Text>
        <TouchableOpacity onPress={loadClusters} style={{ marginTop: 16, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, backgroundColor: '#7C3AED' }}>
          <Text style={{ color: '#fff', fontWeight: '700' }}>{t('common.retry') || 'Tentar de novo'}</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (clusters.length === 0) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <IconMap size={48} color={colors.textTertiary} />
        <Text style={{ marginTop: 12, color: colors.text, fontSize: 16, fontWeight: '700' }}>
          {t('photos.mapEmptyTitle') || 'Sem fotos no mapa'}
        </Text>
        <Text style={{ marginTop: 6, color: colors.textSecondary, fontSize: 13, textAlign: 'center' }}>
          {t('photos.mapEmptyDesc') || 'Para aparecer no mapa, a foto precisa ter GPS no EXIF. Rodamos uma extração agora — pode levar alguns segundos.'}
        </Text>
        <TouchableOpacity
          onPress={runExtract}
          disabled={extracting}
          style={{ marginTop: 18, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 12, backgroundColor: '#7C3AED', opacity: extracting ? 0.6 : 1 }}
        >
          {extracting
            ? <ActivityIndicator color="#fff" />
            : <Text style={{ color: '#fff', fontWeight: '700' }}>{t('photos.mapExtractGps') || 'Extrair GPS das fotos'}</Text>}
        </TouchableOpacity>
      </View>
    );
  }
  if (!WebView) {
    // Web fallback — embed via iframe (Leaflet works the same in a plain iframe).
    return (
      <View style={{ flex: 1, paddingBottom: insets.bottom }}>
        <iframe srcDoc={mapHtml} style={{ width: '100%', height: '100%', border: 0 }} />
      </View>
    );
  }
  return (
    <View style={{ flex: 1, paddingBottom: insets.bottom }}>
      <WebView
        originWhitelist={['*']}
        source={{ html: mapHtml }}
        onMessage={onMessage}
        style={{ flex: 1, backgroundColor: 'transparent' }}
      />
      <View style={{ position: 'absolute', top: 10, left: 10, backgroundColor: 'rgba(0,0,0,0.65)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14 }}>
        <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>
          {total} {t('photos.itemsOnMap') || 'fotos no mapa'}
        </Text>
      </View>
    </View>
  );
}

// [#1345] Build a rich, localized title + subtitle for a memory bucket from
// its `kind` + representative `date`. Keeps the data source (drive_memories)
// untouched — all the richness is derived client-side.
//   - years_ago → "Neste dia" / "On this day" + "há N anos · Mês AAAA"
//   - recent    → "Destaques recentes" + "últimos 30 dias"
//   - this_week → "Esta semana"
function buildMemoryMeta(mem, t, locale) {
  const count = Array.isArray(mem?.photos) ? mem.photos.length : 0;
  const photosLabel = (t('photos.memoryPhotos', { n: count }) || `${count} ${t('photos.items') || 'fotos'}`);
  let dateLabel = '';
  if (mem?.date) {
    const d = new Date(mem.date);
    if (!isNaN(d.getTime())) {
      try { dateLabel = d.toLocaleDateString(locale || undefined, { month: 'long', year: 'numeric' }); }
      catch { dateLabel = d.toLocaleDateString(); }
      // Capitalize first letter (pt-BR month names come lowercase).
      if (dateLabel) dateLabel = dateLabel.charAt(0).toUpperCase() + dateLabel.slice(1);
    }
  }
  if (mem?.kind === 'recent') {
    return {
      title: t('photos.recentHighlights') || 'Destaques recentes',
      subtitle: t('photos.recentHighlightsSub') || 'Suas últimas fotos',
      meta: photosLabel,
    };
  }
  if (mem?.kind === 'this_week' || mem?.yearsAgo === 0) {
    return {
      title: t('photos.thisWeek') || 'Esta semana',
      subtitle: dateLabel || photosLabel,
      meta: photosLabel,
    };
  }
  // years_ago — the marquee "On this day" memory.
  const yearsLabel = mem?.yearsAgo === 1
    ? (t('photos.yearsAgo', { n: 1 }) || '1 ano atrás')
    : (t('photos.yearsAgoPlural', { n: mem?.yearsAgo }) || `${mem?.yearsAgo} anos atrás`);
  return {
    title: t('photos.onThisDay') || 'Neste dia',
    subtitle: dateLabel ? `${yearsLabel} · ${dateLabel}` : yearsLabel,
    meta: photosLabel,
  };
}

function MemoriesCarousel({
  colors, isDark, t, locale, memoriesData, filteredPhotos, getThumbnailUrl,
  openViewer, openMemory, api, setPresetFilter, setPresetMLIds, setPresetLoading,
  onMuteMemory, s,
}) {
  // Build the card list up front so stagger indexes line up with what renders.
  // Years-ago buckets first (up to 4), then curated presets — same order as
  // the original inline mapping, just hoisted so we can iterate twice.
  const memoryCards = (memoriesData || []).slice(0, 4);
  // Curated presets — both date-based (thisweek) and AI-tag-based. The
  // AI cards run a photo_search_ml query whose tokens overlap photo_labels
  // produced by gpt-4o-mini Vision (already stored in drive_files.photo_labels
  // per the audit). Adding new categories is a matter of dropping an entry
  // here + extending the `queries` map below; no backend change required.
  const presetCards = [
    { key: 'summer', title: `Verão ${(new Date().getMonth() >= 11 ? new Date().getFullYear() + 1 : new Date().getFullYear())}`, sub: 'Os melhores momentos', tint: ['#7C3AED', '#EC4899'] },
    { key: 'thisweek', title: 'Esta semana', sub: 'Novas memórias', tint: ['#0EA5E9', '#7C3AED'] },
    { key: 'people', title: 'Pessoas', sub: 'Quem aparece mais', tint: ['#F59E0B', '#7C3AED'] },
    // Auto-categories ("Coleções automáticas") — surfaced via photo_labels.
    { key: 'selfies', title: 'Selfies', sub: 'Você no foco', tint: ['#EC4899', '#7C3AED'] },
    { key: 'food', title: 'Comida', sub: 'Pratos que marcaram', tint: ['#F97316', '#EF4444'] },
    { key: 'pets', title: 'Pets', sub: 'Animais que amam você', tint: ['#10B981', '#06B6D4'] },
    { key: 'sunset', title: 'Por do sol', tint: ['#F59E0B', '#EC4899'], sub: 'Céus inesquecíveis' },
    { key: 'documents', title: 'Documentos', sub: 'Recibos, comprovantes', tint: ['#64748B', '#0EA5E9'] },
  ];
  const totalCards = memoryCards.length + presetCards.length;

  // Stagger anim: each card gets its own Animated.Value and fires 80ms after
  // the previous one. useRef array — values persist across re-renders so the
  // animation doesn't restart on parent state changes.
  const animsRef = useRef(null);
  if (!animsRef.current || animsRef.current.length !== totalCards) {
    animsRef.current = Array.from({ length: totalCards }, () => new Animated.Value(0));
  }
  useEffect(() => {
    const anims = animsRef.current.map((v, i) =>
      Animated.timing(v, {
        toValue: 1,
        duration: 380,
        delay: i * 80,
        useNativeDriver: false,
      })
    );
    Animated.parallel(anims).start();
    // Run once on mount — entrance only plays the first time the section
    // appears (we don't want it replaying on filter toggle).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderAnimCard = (idx, children) => {
    const v = animsRef.current[idx] || new Animated.Value(1);
    return (
      <Animated.View
        style={{
          opacity: v,
          transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
        }}
      >
        {children}
      </Animated.View>
    );
  };

  return (
    <View style={{ marginTop: 8, marginBottom: 6 }}>
      {/* Section header: SVG sparkle + brand pill tag (replaces plain Text). */}
      <View style={s.memoriesHeader}>
        <View style={s.memoriesHeaderPill}>
          <IconSparkles size={13} color="#7C3AED" />
          <Text style={s.memoriesHeaderPillText}>
            {(t('photos.memories') || 'Memórias').toUpperCase()}
          </Text>
        </View>
        <View style={{ flex: 1 }} />
        <Text style={[s.memoriesHeaderCount, { color: colors.textSecondary }]}>
          {totalCards}
        </Text>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: Spacing.md, paddingRight: Spacing.lg, gap: 12 }}
        decelerationRate="fast"
        snapToInterval={332}
      >
        {/* Rich "On this day" / "Recent highlights" memory cards from real
            buckets. Cover is a 1-big-+-2-stacked collage (or a single photo
            when <3 are available). Tap → full-screen story-style slideshow. */}
        {memoryCards.map((mem, idx) => {
          const _uriOf = (p) => p ? (p.isDevice && Platform.OS === 'ios' ? p.uri : getThumbnailUrl(p)) : null;
          const covers = (mem.photos || []).slice(0, 3).map(_uriOf).filter(Boolean);
          const collage = covers.length >= 3; // 1 big + 2 stacked thumbnails
          const meta = buildMemoryMeta(mem, t, locale);
          return (
            <React.Fragment key={`mem-${mem.memoryKey || mem.yearsAgo}`}>
              {renderAnimCard(idx, (
                <Pressable
                  style={[s.memoryCardLg, { backgroundColor: colors.surface }]}
                  onPress={() => {
                    // Tap → open the story-style Memory slideshow viewer.
                    if (typeof openMemory === 'function') {
                      openMemory({ title: meta.title, subtitle: meta.subtitle, photos: mem.photos || [] });
                    } else {
                      const idx0 = filteredPhotos.findIndex(p => p.id === (mem.photos?.[0]?.id));
                      if (idx0 >= 0) openViewer(idx0);
                    }
                  }}
                  onLongPress={() => {
                    // Long-press → "Não mostrar essa memória". Mute is local
                    // (AsyncStorage) + backend (chat_user_memories.muted = 1)
                    // so it sticks across cold-starts AND across devices.
                    if (!onMuteMemory || !mem.memoryKey) return;
                    try {
                      Alert.alert(
                        t('photos.hideMemoryTitle') || 'Ocultar memória',
                        t('photos.hideMemoryBody') || 'Você não verá essa memória novamente.',
                        [
                          { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
                          { text: t('photos.hide') || 'Ocultar', style: 'destructive', onPress: () => onMuteMemory(mem.memoryKey) },
                        ]
                      );
                    } catch {
                      onMuteMemory(mem.memoryKey);
                    }
                  }}
                  delayLongPress={400}
                >
                  {collage ? (
                    // Collage: big photo on the left (62%), two stacked on right.
                    <View style={s.memoryCollage}>
                      <Image source={{ uri: covers[0] }} style={s.memoryCollageMain} resizeMode="cover" />
                      <View style={s.memoryCollageSide}>
                        <Image source={{ uri: covers[1] }} style={s.memoryCollageThumb} resizeMode="cover" />
                        <Image source={{ uri: covers[2] }} style={[s.memoryCollageThumb, { marginTop: 2 }]} resizeMode="cover" />
                      </View>
                    </View>
                  ) : covers[0] ? (
                    <Image source={{ uri: covers[0] }} style={s.memoryCoverLg} resizeMode="cover" />
                  ) : (
                    <View style={[s.memoryCoverLg, { backgroundColor: colors.surfaceVariant, alignItems: 'center', justifyContent: 'center' }]}>
                      <IconImage size={36} color={colors.textTertiary} />
                    </View>
                  )}
                  {/* iOS Photos pattern: bottom-up linear gradient covering ~50% */}
                  <View style={s.memoryGradient} pointerEvents="none" />
                  {/* Subtle top gradient softens the sparkle icon corner. */}
                  <View style={s.memoryGradientTop} pointerEvents="none" />
                  {/* Sparkle corner mark — signals "AI-curated memory". */}
                  <View style={s.memorySparkle} pointerEvents="none">
                    <IconSparkles size={16} color="#fff" />
                  </View>
                  {/* Centered play affordance — signals tap → slideshow. */}
                  <View style={s.memoryPlayBadge} pointerEvents="none">
                    <IconPlay size={20} color="#fff" />
                  </View>
                  <View style={s.memoryTextWrap}>
                    <Text style={s.memoryTitleLg} numberOfLines={1}>{meta.title}</Text>
                    <Text style={s.memorySubLg} numberOfLines={1}>{meta.subtitle}</Text>
                  </View>
                </Pressable>
              ))}
            </React.Fragment>
          );
        })}

        {/* Curated preset cards. */}
        {presetCards.map((preset, idx) => {
          const cover = filteredPhotos[(idx + 1) * 3] || filteredPhotos[idx] || null;
          const coverUri = cover ? (cover.isDevice && Platform.OS === 'ios' ? cover.uri : getThumbnailUrl(cover)) : null;
          return (
            <React.Fragment key={`preset-${preset.key}`}>
              {renderAnimCard(memoryCards.length + idx, (
                <Pressable
                  style={[s.memoryCardLg, { backgroundColor: preset.tint[0] }]}
                  onPress={async () => {
                    // Google Photos-grade memory: AI semantic search against
                    // photo_labels (tags/objects/scene) + optional date window.
                    setPresetFilter(preset.key);
                    setPresetMLIds(null);
                    // Each query token is matched against photo_labels.tags +
                    // .objects + .scene by photoMlSearch (see photo-ml.php).
                    // Wide PT+EN keyword nets so users phrasing either way hit.
                    const queries = {
                      summer: 'beach pool sun outdoor vacation summer praia piscina sol verão férias',
                      thisweek: '',
                      people: 'person people face portrait selfie group friends pessoa pessoas rosto retrato selfie amigos',
                      // Auto-categories — keep tokens tight so we don't pull in
                      // unrelated photos. AI Vision already emits these in its
                      // tag set so the recall is high.
                      selfies: 'selfie self-portrait front-camera autorretrato selfie autofoto',
                      food: 'food meal dish plate restaurant breakfast lunch dinner dessert comida prato refeição almoço jantar sobremesa cozinha',
                      pets: 'dog cat pet animal puppy kitten cachorro gato pet animal filhote',
                      sunset: 'sunset sunrise dusk horizon golden-hour pôr-do-sol nascer-do-sol crepúsculo entardecer',
                      documents: 'document receipt invoice form id-card passport screenshot text-document documento recibo comprovante nota-fiscal formulário rg cpf passaporte captura-de-tela',
                    };
                    const q = queries[preset.key] || '';
                    if (!q) return; // thisweek is purely date-based
                    setPresetLoading(true);
                    try {
                      const r = await api.photoSearchML(q, 1, 200);
                      if (r?.success && Array.isArray(r.data?.files)) {
                        setPresetMLIds(r.data.files);
                      }
                    } catch {} finally {
                      setPresetLoading(false);
                    }
                  }}
                >
                  {coverUri ? (
                    <Image source={{ uri: coverUri }} style={[s.memoryCoverLg, { opacity: 0.78 }]} resizeMode="cover" />
                  ) : null}
                  {/* Tint wash so curated cards keep their brand color even with cover photo. */}
                  <View style={[s.memoryTintWash, { backgroundColor: preset.tint[0] + '38' }]} pointerEvents="none" />
                  <View style={s.memoryGradient} pointerEvents="none" />
                  <View style={s.memoryGradientTop} pointerEvents="none" />
                  <View style={s.memorySparkle} pointerEvents="none">
                    <IconSparkles size={16} color="#fff" />
                  </View>
                  <View style={s.memoryTextWrap}>
                    <Text style={s.memoryTitleLg} numberOfLines={1}>{preset.title}</Text>
                    <Text style={s.memorySubLg} numberOfLines={1}>{preset.sub}</Text>
                  </View>
                </Pressable>
              ))}
            </React.Fragment>
          );
        })}
      </ScrollView>
    </View>
  );
}

// ============================================================
// [#1345] MEMORY VIEWER — story-style auto-advancing slideshow
// ============================================================
// Opened by tapping a memory card. Plays through the bucket's photos one by
// one (Apple Photos "Memories" / IG Stories pattern): segmented progress bars
// up top, auto-advance every ~3.2s with a Ken-Burns zoom, tap left/right to
// navigate, tap-and-hold to pause, swipe-down or X to close. Pure JS — reuses
// the same thumbnail URLs the grid already resolves.
function MemoryViewer({ memory, onClose, getThumbnailUrl, t, colors }) {
  const photos = Array.isArray(memory?.photos) ? memory.photos : [];
  const [index, setIndex] = React.useState(0);
  const [paused, setPaused] = React.useState(false);
  const progress = React.useRef(new Animated.Value(0)).current;
  const zoom = React.useRef(new Animated.Value(0)).current;
  const animRef = React.useRef(null);
  const SEGMENT_MS = 3200;

  const uriOf = React.useCallback((p) => (
    p ? (p.isDevice && Platform.OS === 'ios' ? p.uri : getThumbnailUrl(p)) : null
  ), [getThumbnailUrl]);

  // Drive the active segment's progress bar + Ken-Burns zoom. Advancing past
  // the last photo closes the viewer (story-style "caught up").
  React.useEffect(() => {
    if (!photos.length) return;
    progress.setValue(0);
    zoom.setValue(0);
    Animated.timing(zoom, { toValue: 1, duration: SEGMENT_MS + 400, useNativeDriver: true }).start();
    if (paused) return;
    animRef.current = Animated.timing(progress, { toValue: 1, duration: SEGMENT_MS, useNativeDriver: false });
    animRef.current.start(({ finished }) => {
      if (!finished) return;
      if (index >= photos.length - 1) onClose();
      else setIndex(i => i + 1);
    });
    return () => { try { animRef.current?.stop(); } catch {} };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, paused, photos.length]);

  if (!memory || !photos.length) return null;
  const cur = photos[index];
  const curUri = uriOf(cur);
  const scale = zoom.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });

  const goPrev = () => { if (index > 0) setIndex(i => i - 1); else progress.setValue(0); };
  const goNext = () => { if (index < photos.length - 1) setIndex(i => i + 1); else onClose(); };

  return (
    <Modal visible animationType="fade" transparent={false} onRequestClose={onClose} statusBarTranslucent>
      <View style={s.memViewerRoot}>
        {/* Active photo with subtle Ken-Burns zoom. */}
        {curUri ? (
          <Animated.Image
            source={{ uri: curUri }}
            style={[StyleSheet.absoluteFill, { transform: [{ scale }] }]}
            resizeMode="contain"
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
            <IconImage size={48} color="#555" />
          </View>
        )}

        {/* Tap zones: left third = prev, right two-thirds = next; hold = pause. */}
        <Pressable
          style={s.memViewerTapLeft}
          onPress={goPrev}
          onPressIn={() => setPaused(true)}
          onPressOut={() => setPaused(false)}
        />
        <Pressable
          style={s.memViewerTapRight}
          onPress={goNext}
          onPressIn={() => setPaused(true)}
          onPressOut={() => setPaused(false)}
        />

        {/* Segmented progress bars (one per photo). */}
        <View style={s.memViewerBars} pointerEvents="none">
          {photos.map((_, i) => (
            <View key={`seg-${i}`} style={s.memViewerBarTrack}>
              <Animated.View
                style={[
                  s.memViewerBarFill,
                  i < index
                    ? { width: '100%' }
                    : i === index
                      ? { width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }
                      : { width: '0%' },
                ]}
              />
            </View>
          ))}
        </View>

        {/* Header: title + subtitle + close. */}
        <View style={s.memViewerHeader} pointerEvents="box-none">
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.memViewerTitle} numberOfLines={1}>{memory.title}</Text>
            {!!memory.subtitle && (
              <Text style={s.memViewerSub} numberOfLines={1}>{memory.subtitle}</Text>
            )}
          </View>
          <TouchableOpacity
            onPress={onClose}
            style={s.memViewerClose}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel={t('common.close') || 'Fechar'}
          >
            <IconX size={22} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Footer counter "n / total". */}
        <View style={s.memViewerFooter} pointerEvents="none">
          <Text style={s.memViewerCounter}>{index + 1} / {photos.length}</Text>
        </View>
      </View>
    </Modal>
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
    height: 60,
  },
  headerBtn: {
    padding: 8,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
  },
  headerTitle: {
    fontSize: FontSize.heading,
    fontWeight: '800',
    marginLeft: 4,
    letterSpacing: -0.6,
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

  // Grid — tight square grid with rounded thumbs + subtle breathing gap
  gridRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  gridItem: {
    margin: 1.5,
    overflow: 'hidden',
    position: 'relative',
    borderRadius: 8,
    backgroundColor: '#e5e7eb',
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
  sectionCountChip: {
    minWidth: 22,
    height: 20,
    paddingHorizontal: 7,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionCount: {
    fontSize: FontSize.xs,
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
    aspectRatio: 1,
    backgroundColor: '#e5e7eb',
  },
  albumCoverPlaceholder: {
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  albumInfo: {
    paddingHorizontal: Spacing.md - 2,
    paddingVertical: Spacing.sm + 2,
  },
  albumName: {
    fontSize: FontSize.base,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  albumCount: {
    fontSize: FontSize.xs,
    marginTop: 3,
    fontWeight: '500',
  },
  // Circular avatar for People (face) clusters — subtle ring lifts it
  clusterAvatar: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: '#e5e7eb',
    borderWidth: 1,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.10, shadowRadius: 6 },
      android: { elevation: 2 },
      web: { boxShadow: '0 2px 8px rgba(0,0,0,0.10)' },
    }),
  },
  // Soft circular icon badge for empty states (albums / people)
  emptyIconCircle: {
    width: 104,
    height: 104,
    borderRadius: 52,
    alignItems: 'center',
    justifyContent: 'center',
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

  // Memories — iOS Photos-grade carousel cards (320×180, 16:9 cinematic).
  // Shadow elevation tuned to read as a separate plane from the grid below;
  // iOS uses similar values on the Memories carousel in Photos.app.
  memoryCardLg: {
    width: 320,
    aspectRatio: 16 / 9,
    borderRadius: 20,
    overflow: 'hidden',
    position: 'relative',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 12 },
      android: { elevation: 6 },
      web: { boxShadow: '0 4px 12px rgba(0,0,0,0.18)' },
    }),
  },
  memoryCoverLg: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#1a1a2e',
  },
  // Bottom-up dark gradient covering 50% of card height (iOS pattern).
  // On native, fallback to flat dark layer since RN doesn't support CSS gradients.
  memoryGradient: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    height: '60%',
    backgroundColor: 'rgba(0,0,0,0.52)',
    ...(Platform.OS === 'web' ? {
      background: 'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.45) 55%, rgba(0,0,0,0.8) 100%)',
      backgroundColor: 'transparent',
    } : {}),
  },
  // Subtle top gradient so the sparkle icon corner doesn't fight a bright sky.
  memoryGradientTop: {
    position: 'absolute',
    left: 0, right: 0, top: 0,
    height: '32%',
    ...(Platform.OS === 'web' ? {
      background: 'linear-gradient(180deg, rgba(0,0,0,0.28) 0%, transparent 100%)',
    } : {
      backgroundColor: 'rgba(0,0,0,0.16)',
    }),
  },
  memoryTintWash: {
    ...StyleSheet.absoluteFillObject,
  },
  memoryTextWrap: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 14,
  },
  memoryTitleLg: {
    fontSize: 19,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: -0.4,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 5,
  },
  memorySubLg: {
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.75)',
    marginTop: 3,
    letterSpacing: 0.1,
    textShadowColor: 'rgba(0,0,0,0.4)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  // Top-right sparkle marker (replaces the count chip). 16px SVG inside a
  // small translucent capsule so it stays legible on bright covers.
  memorySparkle: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.32)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // [#1345] Centered "play" affordance — circle with a play glyph that
  // signals the card opens a slideshow when tapped.
  memoryPlayBadge: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    marginLeft: -24,
    marginTop: -32,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(0,0,0,0.42)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // [#1345] Collage cover: big photo (62%) + two stacked thumbnails (38%).
  memoryCollage: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    backgroundColor: '#1a1a2e',
  },
  memoryCollageMain: {
    width: '62%',
    height: '100%',
  },
  memoryCollageSide: {
    width: '38%',
    height: '100%',
    marginLeft: 2,
  },
  memoryCollageThumb: {
    width: '100%',
    height: '49.5%',
    backgroundColor: '#23233a',
  },
  // Section header — sparkle + uppercase brand pill (replaces plain Text title).
  memoriesHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    marginBottom: 12,
  },
  memoriesHeaderPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: 'rgba(124,58,237,0.10)',
  },
  memoriesHeaderPillText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    color: '#7C3AED',
  },
  memoriesHeaderCount: {
    fontSize: 12,
    fontWeight: '700',
  },

  // [#1345] Memory slideshow viewer (story-style).
  memViewerRoot: { flex: 1, backgroundColor: '#000' },
  memViewerTapLeft: { position: 'absolute', top: 0, bottom: 0, left: 0, width: '33%' },
  memViewerTapRight: { position: 'absolute', top: 0, bottom: 0, right: 0, width: '67%' },
  memViewerBars: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 52 : ((require('react-native').StatusBar.currentHeight || 24) + 10),
    left: 10, right: 10,
    flexDirection: 'row',
    gap: 4,
  },
  memViewerBarTrack: {
    flex: 1,
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.32)',
    overflow: 'hidden',
  },
  memViewerBarFill: {
    height: '100%',
    borderRadius: 2,
    backgroundColor: '#fff',
  },
  memViewerHeader: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 64 : ((require('react-native').StatusBar.currentHeight || 24) + 22),
    left: 14, right: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  memViewerTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: -0.3,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  memViewerSub: {
    color: 'rgba(255,255,255,0.82)',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 2,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  memViewerClose: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center', justifyContent: 'center',
  },
  memViewerFooter: {
    position: 'absolute',
    bottom: Platform.OS === 'ios' ? 36 : 22,
    left: 0, right: 0,
    alignItems: 'center',
  },
  memViewerCounter: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    fontWeight: '600',
  },

  // Search pill (always visible, Google Photos style)
  searchPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 24,
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
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 16,
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

  // Tab pills (modern segmented control — active pill lifts with brand glow)
  tabPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 15,
    paddingVertical: 9,
    borderRadius: 20,
  },
  tabPillActive: {
    ...Platform.select({
      ios: { shadowColor: '#7C3AED', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.28, shadowRadius: 8 },
      android: { elevation: 4 },
      web: { boxShadow: '0 3px 10px rgba(124,58,237,0.30)' },
    }),
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
    backgroundColor: 'rgba(124,58,237,0.15)',
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 4,
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
    gap: 5,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 22,
    backgroundColor: 'rgba(128,128,128,0.13)',
  },
  filterChipText: {
    fontSize: 12.5,
    fontWeight: '700',
    letterSpacing: -0.1,
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
    // paddingBottom comes from inline style: insets.bottom + 16 (not hardcoded)
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
    paddingVertical: 12,
    borderRadius: 16,
    gap: 10,
    minWidth: 150,
  },
  fabOptionText: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: -0.1,
  },

  // Better empty state
  emptyIllustration: {
    marginBottom: 8,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  emptyIconCenter: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
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
    marginTop: 24,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 28,
    ...Platform.select({
      ios: { shadowColor: '#7C3AED', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.30, shadowRadius: 12 },
      android: { elevation: 5 },
      web: { boxShadow: '0 4px 14px rgba(124,58,237,0.30)' },
    }),
  },
  emptyUploadBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
});
