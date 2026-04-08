import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, FlatList, Text, TouchableOpacity, StyleSheet, TextInput,
  ActivityIndicator, RefreshControl, Alert, Platform, Modal, Linking, Image,
  Animated, Easing,
} from 'react-native';
// FlashList reverted to FlatList
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { BorderRadius, FontSize, Spacing, Shadow } from '../constants/theme';
import * as api from '../services/api';
import { getCached, setCache } from '../services/cache';
import {
  IconFolder, IconFolderPlus, IconFileText, IconImage, IconMusic, IconFilm,
  IconUpload, IconDownload, IconTrash, IconStar, IconStarFilled, IconSearch,
  IconEdit, IconMoreVert, IconArrowLeft, IconPlus, IconClock, IconChevronRight,
  IconPaperclip, IconCheck, IconX, IconArchive, IconCamera, IconInbox,
  IconEye,
} from '../components/Icons';
import FileViewer from '../components/FileViewer';
import { ListSkeleton } from '../components/SkeletonLoader';

const TABS = ['all', 'recent', 'starred', 'trash'];

const isWeb = Platform.OS === 'web';

const safeAlert = (title, message, buttons) => {
  if (isWeb) {
    if (buttons?.length) {
      const ok = buttons.find(b => b.style !== 'cancel');
      if (ok?.onPress && window.confirm(`${title}\n${message || ''}`)) ok.onPress();
      else { const cancel = buttons.find(b => b.style === 'cancel'); cancel?.onPress?.(); }
    } else { window.alert(message || title); }
  } else { Alert.alert(title, message, buttons); }
};

// ============================================================
// FILE TYPE ACCENT COLORS
// ============================================================

const FILE_TYPE_COLORS = {
  image:        { accent: '#f59e0b', bg: '#fffbeb', bgDark: '#451a03', icon: '#d97706' },
  video:        { accent: '#8b5cf6', bg: '#f5f3ff', bgDark: '#2e1065', icon: '#7c3aed' },
  audio:        { accent: '#6366f1', bg: '#eef2ff', bgDark: '#1e1b4b', icon: '#4f46e5' },
  pdf:          { accent: '#dc2626', bg: '#fef2f2', bgDark: '#450a0a', icon: '#dc2626' },
  document:     { accent: '#2563eb', bg: '#eff6ff', bgDark: '#172554', icon: '#2563eb' },
  spreadsheet:  { accent: '#16a34a', bg: '#f0fdf4', bgDark: '#052e16', icon: '#16a34a' },
  presentation: { accent: '#d97706', bg: '#fffbeb', bgDark: '#451a03', icon: '#d97706' },
  archive:      { accent: '#64748b', bg: '#f8fafc', bgDark: '#1e293b', icon: '#64748b' },
  default:      { accent: '#94a3b8', bg: '#f1f5f9', bgDark: '#1e293b', icon: '#94a3b8' },
};

const FOLDER_COLORS = [
  '#2563eb', '#8b5cf6', '#16a34a', '#f59e0b', '#dc2626', '#6366f1', '#0891b2', '#ea580c',
];

function getFolderColor(folderId) {
  if (!folderId) return '#2563eb';
  const hash = typeof folderId === 'number' ? folderId : String(folderId).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return FOLDER_COLORS[hash % FOLDER_COLORS.length];
}

function getTypeColors(iconType, isDark) {
  const c = FILE_TYPE_COLORS[iconType] || FILE_TYPE_COLORS.default;
  return { accent: c.accent, bg: isDark ? c.bgDark : c.bg, icon: c.icon };
}

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

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function getFileIcon(iconType, size, color) {
  switch (iconType) {
    case 'image': return <IconImage size={size} color={color} />;
    case 'video': return <IconFilm size={size} color={color} />;
    case 'audio': return <IconMusic size={size} color={color} />;
    case 'pdf': return <IconFileText size={size} color={FILE_TYPE_COLORS.pdf.icon} />;
    case 'document': return <IconFileText size={size} color={FILE_TYPE_COLORS.document.icon} />;
    case 'spreadsheet': return <IconFileText size={size} color={FILE_TYPE_COLORS.spreadsheet.icon} />;
    case 'presentation': return <IconFileText size={size} color={FILE_TYPE_COLORS.presentation.icon} />;
    case 'archive': return <IconArchive size={size} color={color} />;
    default: return <IconFileText size={size} color={color} />;
  }
}

function getFileTypeBadge(iconType) {
  switch (iconType) {
    case 'pdf': return 'PDF';
    case 'document': return 'DOC';
    case 'spreadsheet': return 'XLS';
    case 'presentation': return 'PPT';
    case 'archive': return 'ZIP';
    case 'audio': return 'MP3';
    default: return null;
  }
}

// ============================================================
// GLASSMORPHISM STYLE HELPERS
// ============================================================

function glassStyle(isDark) {
  const base = {
    borderWidth: 1,
    borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.7)',
  };
  if (isWeb) {
    base.backdropFilter = 'blur(20px) saturate(180%)';
    base.WebkitBackdropFilter = 'blur(20px) saturate(180%)';
  }
  return base;
}

function glassCardBg(isDark) {
  return isDark ? 'rgba(30,41,59,0.6)' : 'rgba(255,255,255,0.72)';
}

function glassHeaderBg(isDark) {
  return isDark ? 'rgba(15,23,42,0.85)' : 'rgba(248,250,252,0.82)';
}

// ============================================================
// ANIMATED COMPONENTS
// ============================================================

function FolderCard({ folder, colors, onPress, onLongPress, onContextMenu, t, isDark }) {
  const folderColor = getFolderColor(folder.id);
  const folderBg = isDark ? folderColor + '18' : folderColor + '10';
  const hoverAnim = useRef(new Animated.Value(0)).current;
  const pressAnim = useRef(new Animated.Value(0)).current;

  const onHoverIn = () => {
    if (!isWeb) return;
    Animated.timing(hoverAnim, { toValue: 1, duration: 180, useNativeDriver: false, easing: Easing.out(Easing.quad) }).start();
  };
  const onHoverOut = () => {
    if (!isWeb) return;
    Animated.timing(hoverAnim, { toValue: 0, duration: 220, useNativeDriver: false, easing: Easing.out(Easing.quad) }).start();
  };

  const onPressIn = () => {
    Animated.timing(pressAnim, { toValue: 1, duration: 80, useNativeDriver: false }).start();
  };
  const onPressOut = () => {
    Animated.timing(pressAnim, { toValue: 0, duration: 200, useNativeDriver: false }).start();
  };

  const animatedBg = pressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [glassCardBg(isDark), isDark ? 'rgba(96,165,250,0.12)' : 'rgba(37,99,235,0.08)'],
  });

  const animatedStyle = isWeb ? {
    transform: [{ scale: hoverAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.02] }) }],
    shadowOpacity: hoverAnim.interpolate({ inputRange: [0, 1], outputRange: [0.04, 0.12] }),
  } : {};

  return (
    <Animated.View style={animatedStyle}>
      <TouchableOpacity
        style={[
          styles.itemCard,
          {
            borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
          },
          glassStyle(isDark),
        ]}
        onPress={onPress}
        onLongPress={onLongPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        activeOpacity={0.7}
        {...(isWeb ? { onMouseEnter: onHoverIn, onMouseLeave: onHoverOut, onContextMenu } : {})}
      >
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: animatedBg, borderRadius: BorderRadius.xl }]} />
        <View style={[styles.itemIconWrap, { backgroundColor: folderBg }]}>
          <IconFolder size={24} color={folderColor} />
        </View>
        <View style={styles.itemInfo}>
          <Text style={[styles.itemName, { color: colors.text }]} numberOfLines={1}>
            {folder.name}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
            <Text style={[styles.itemMeta, { color: colors.textTertiary, marginTop: 0 }]}>
              {t('files.folder')}
            </Text>
            {folder.updated_at ? (
              <Text style={[styles.itemMeta, { color: colors.textTertiary, marginTop: 0 }]}>
                {formatDate(folder.updated_at, t)}
              </Text>
            ) : null}
          </View>
        </View>
        <View style={[styles.folderChevron, { backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }]}>
          <IconChevronRight size={16} color={colors.textTertiary} />
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

function FileCard({ file, colors, onPress, onLongPress, onContextMenu, onStar, t, isSelected, onSelect, multiSelect, isDark }) {
  const hasThumb = (file.icon_type === 'image' || file.icon_type === 'video') && file.id;
  const thumbUrl = hasThumb ? (file.thumbnail_url || file.cdn_url || api.fileDownloadUrl(file.id)) : null;
  const typeColors = getTypeColors(file.icon_type, isDark);
  const typeBadge = getFileTypeBadge(file.icon_type);
  const hoverAnim = useRef(new Animated.Value(0)).current;

  const onHoverIn = () => {
    if (!isWeb) return;
    Animated.timing(hoverAnim, { toValue: 1, duration: 180, useNativeDriver: false, easing: Easing.out(Easing.quad) }).start();
  };
  const onHoverOut = () => {
    if (!isWeb) return;
    Animated.timing(hoverAnim, { toValue: 0, duration: 220, useNativeDriver: false, easing: Easing.out(Easing.quad) }).start();
  };

  const animatedStyle = isWeb ? {
    transform: [{ scale: hoverAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.02] }) }],
    shadowOpacity: hoverAnim.interpolate({ inputRange: [0, 1], outputRange: [0.04, 0.12] }),
  } : {};

  return (
    <Animated.View style={animatedStyle}>
      <TouchableOpacity
        style={[
          styles.itemCard,
          {
            backgroundColor: glassCardBg(isDark),
            borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
          },
          glassStyle(isDark),
          isSelected && {
            backgroundColor: isDark ? colors.primary + '20' : colors.primaryLight,
            borderColor: colors.primary + '60',
            ...(isDark && isWeb ? { boxShadow: `0 0 12px ${colors.primary}33` } : {}),
          },
        ]}
        onPress={multiSelect ? onSelect : onPress}
        onLongPress={onLongPress}
        activeOpacity={0.7}
        {...(isWeb ? { onMouseEnter: onHoverIn, onMouseLeave: onHoverOut, onContextMenu } : {})}
      >
        {multiSelect && (
          <TouchableOpacity onPress={onSelect} style={styles.checkboxWrap}>
            <View style={[
              styles.checkbox,
              { borderColor: isDark ? 'rgba(255,255,255,0.2)' : colors.border },
              isSelected && { backgroundColor: colors.primary, borderColor: colors.primary },
            ]}>
              {isSelected && <IconCheck size={12} color="#fff" />}
            </View>
          </TouchableOpacity>
        )}
        {hasThumb ? (
          <View style={[styles.itemThumbWrap]}>
            <Image
              source={{ uri: thumbUrl }}
              style={styles.itemThumb}
              resizeMode="cover"
            />
            {file.icon_type === 'video' && (
              <View style={styles.videoOverlay}>
                <IconFilm size={14} color="#fff" />
              </View>
            )}
          </View>
        ) : (
          <View style={[styles.itemIconWrap, { backgroundColor: typeColors.bg }]}>
            {getFileIcon(file.icon_type, 22, typeColors.icon)}
            {typeBadge && (
              <View style={[styles.typeBadge, { backgroundColor: typeColors.accent }]}>
                <Text style={styles.typeBadgeText}>{typeBadge}</Text>
              </View>
            )}
          </View>
        )}
        <View style={styles.itemInfo}>
          <Text style={[styles.itemName, { color: colors.text }]} numberOfLines={1}>
            {file.original_name}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
            {/* Size pill */}
            <View style={[styles.sizePill, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }]}>
              <Text style={[styles.sizePillText, { color: colors.textTertiary }]}>
                {file.size_formatted || ''}
              </Text>
            </View>
            {file.updated_at ? (
              <Text style={[styles.itemMeta, { color: colors.textTertiary, marginTop: 0 }]}>
                {formatDate(file.updated_at, t)}
              </Text>
            ) : null}
          </View>
        </View>
        <TouchableOpacity onPress={onStar} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={styles.starBtn}>
          {file.is_starred === 1 ? (
            <IconStarFilled size={18} color={colors.starColor || '#f59e0b'} />
          ) : (
            <IconStar size={18} color={isDark ? 'rgba(255,255,255,0.15)' : colors.textTertiary} />
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    </Animated.View>
  );
}

function BreadcrumbBar({ breadcrumb, colors, onNavigate, t, isDark }) {
  return (
    <View style={[styles.breadcrumb, { backgroundColor: isDark ? 'rgba(30,41,59,0.4)' : 'rgba(241,245,249,0.6)' }]}>
      <TouchableOpacity
        onPress={() => onNavigate(null)}
        style={[styles.breadcrumbPill, { backgroundColor: isDark ? 'rgba(96,165,250,0.12)' : '#eff6ff' }]}
      >
        <IconFolder size={13} color={colors.primary} />
        <Text style={[styles.breadcrumbPillText, { color: colors.primary }]}>{t('files.home')}</Text>
      </TouchableOpacity>
      {breadcrumb.map((crumb, idx) => (
        <React.Fragment key={crumb.id}>
          <IconChevronRight size={13} color={colors.textTertiary} />
          <TouchableOpacity
            onPress={() => onNavigate(crumb.id)}
            style={[
              styles.breadcrumbPill,
              idx === breadcrumb.length - 1 && {
                backgroundColor: isDark ? colors.primary + '20' : colors.primary + '12',
              },
            ]}
          >
            <Text
              style={[
                styles.breadcrumbPillText,
                { color: idx === breadcrumb.length - 1 ? colors.primary : colors.textSecondary },
                idx === breadcrumb.length - 1 && { fontWeight: '700' },
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

function formatStorageBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function StorageBar({ storageInfo, colors, t, isDark }) {
  if (!storageInfo) return null;
  const percent = Math.min(storageInfo.percentage || 0, 100);
  const driveUsed = storageInfo.drive_used || 0;
  const emailUsed = storageInfo.email_used || 0;
  const quota = storageInfo.quota || storageInfo.plan_quota || 15 * 1024 * 1024 * 1024;

  const drivePct = quota > 0 ? Math.min((driveUsed / quota) * 100, 100) : 0;
  const emailPct = quota > 0 ? Math.min((emailUsed / quota) * 100, 100 - drivePct) : 0;

  // Animated fill
  const fillAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fillAnim, {
      toValue: 1,
      duration: 800,
      delay: 300,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [percent]);

  const driveWidth = fillAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', `${drivePct}%`] });
  const emailWidth = fillAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', `${emailPct}%`] });

  const isHigh = percent > 80;
  const isMedium = percent > 60;

  return (
    <View style={[
      styles.storageBar,
      {
        backgroundColor: glassCardBg(isDark),
        borderTopColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
      },
      glassStyle(isDark),
    ]}>
      {/* Percentage display */}
      <View style={styles.storageHeader}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.storageMainText, { color: colors.text }]}>
            {Math.round(percent)}% {t('files.storageUsed', { used: '', quota: '' }).trim() || 'usado'}
          </Text>
          <Text style={[styles.storageSubLine, { color: colors.textTertiary }]}>
            {storageInfo.used_formatted || formatStorageBytes(storageInfo.total_used || 0)} / {storageInfo.total_formatted || formatStorageBytes(quota)}
          </Text>
        </View>
        <View style={[
          styles.storagePercentBadge,
          { backgroundColor: isHigh ? '#dc262615' : isMedium ? '#d9770615' : colors.primary + '12' },
        ]}>
          <Text style={[
            styles.storagePercentText,
            { color: isHigh ? '#dc2626' : isMedium ? '#d97706' : colors.primary },
          ]}>
            {Math.round(percent)}%
          </Text>
        </View>
      </View>

      {/* Gradient progress bar */}
      <View style={[styles.storageTrack, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}>
        <View style={{ flexDirection: 'row', height: '100%' }}>
          {drivePct > 0 && (
            <Animated.View style={[styles.storageFillDrive, { width: driveWidth }]}>
              <View style={styles.storageFillGradient} />
            </Animated.View>
          )}
          {emailPct > 0 && (
            <Animated.View style={[
              styles.storageFillEmail,
              { width: emailWidth },
              drivePct > 0 && { borderTopLeftRadius: 0, borderBottomLeftRadius: 0 },
            ]} />
          )}
        </View>
      </View>

      {/* Legend */}
      <View style={styles.storageLegend}>
        <View style={styles.storageLegendItem}>
          <View style={[styles.storageLegendDot, { backgroundColor: colors.primary }]} />
          <Text style={[styles.storageLegendText, { color: colors.textTertiary }]}>
            Drive {storageInfo.drive_formatted || formatStorageBytes(driveUsed)}
          </Text>
        </View>
        <View style={styles.storageLegendItem}>
          <View style={[styles.storageLegendDot, { backgroundColor: '#f59e0b' }]} />
          <Text style={[styles.storageLegendText, { color: colors.textTertiary }]}>
            Email {storageInfo.email_formatted || formatStorageBytes(emailUsed)}
          </Text>
        </View>
        <Text style={[styles.storageLegendText, { color: colors.textTertiary }]}>
          {t('files.fileCount', { count: storageInfo.file_count || 0 })}
        </Text>
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

// ---- Polished Empty State for Files ----
function FilesEmptyState({ tab, isDark, colors, t, onUpload }) {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.85)).current;
  const slideAnim = useRef(new Animated.Value(16)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
      Animated.spring(scaleAnim, { toValue: 1, tension: 80, friction: 12, useNativeDriver: false }),
      Animated.timing(slideAnim, { toValue: 0, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
    ]).start();
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.05, duration: 2200, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 2200, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, []);

  const emptyMap = {
    all: { title: t('files.emptyAll'), sub: t('files.emptyAllDesc') },
    recent: { title: t('files.emptyRecent'), sub: t('files.emptyRecentDesc') },
    starred: { title: t('files.emptyStarred'), sub: t('files.emptyStarredDesc') },
    trash: { title: t('files.emptyTrash'), sub: t('files.emptyTrashDesc') },
  };
  const empty = emptyMap[tab] || emptyMap.all;
  const accentColor = isDark ? colors.primary : '#2563eb';

  return (
    <Animated.View style={[styles.emptyContainer, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
      <Animated.View style={[styles.emptyIconCircle, {
        backgroundColor: isDark ? colors.primary + '12' : '#eff6ff',
        transform: [{ scale: pulseAnim }],
      }]}>
        <Animated.View style={[styles.emptyIconInner, {
          backgroundColor: isDark ? colors.primary + '20' : '#dbeafe',
          transform: [{ scale: scaleAnim }],
        }]}>
          {tab === 'trash' ? (
            <IconTrash size={40} color={accentColor} />
          ) : (
            <IconUpload size={40} color={accentColor} />
          )}
        </Animated.View>
      </Animated.View>
      <Text style={[styles.emptyTitle, { color: colors.text }]}>{empty.title}</Text>
      <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>{empty.sub}</Text>
      {tab !== 'trash' && (
        <TouchableOpacity
          style={[styles.emptyCta, { backgroundColor: colors.primary }]}
          onPress={onUpload}
          activeOpacity={0.8}
        >
          <IconUpload size={18} color="#fff" />
          <Text style={styles.emptyCtaText}>{t('files.upload')}</Text>
        </TouchableOpacity>
      )}
    </Animated.View>
  );
}

// ============================================================
// MAIN SCREEN
// ============================================================

function FilesScreenInner() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [tab, setTab] = useState('all');
  const [currentFolderId, setCurrentFolderId] = useState(null);
  // ALL data lives in these 3 arrays - loaded once, filtered locally
  const [allFolders, setAllFolders] = useState([]);
  const [allFiles, setAllFiles] = useState([]);
  const [allTrash, setAllTrash] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [storageInfo, setStorageInfo] = useState(null);
  const [searchMode, setSearchMode] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [showFab, setShowFab] = useState(false);
  const [actionMenu, setActionMenu] = useState(null);
  const [renameModal, setRenameModal] = useState(null);
  const [newFolderModal, setNewFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [shareModal, setShareModal] = useState(null);
  const [shareEmail, setShareEmail] = useState('');
  const [sharePermission, setSharePermission] = useState('view');
  const [viewerFile, setViewerFile] = useState(null);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [moveModal, setMoveModal] = useState(null);
  const [toast, setToast] = useState(null);
  const [viewMode, setViewMode] = useState('list');
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [sortBy, setSortBy] = useState('name'); // 'name' | 'date' | 'size' | 'type'
  const [sortAsc, setSortAsc] = useState(true);
  const [showSortMenu, setShowSortMenu] = useState(false);

  const searchTimeout = useRef(null);
  const searchBarAnim = useRef(new Animated.Value(0)).current;
  const toastAnim = useRef(new Animated.Value(0)).current;

  // Show toast helper
  const showToast = useCallback((msg) => {
    setToast(msg);
    Animated.sequence([
      Animated.timing(toastAnim, { toValue: 1, duration: 250, useNativeDriver: false, easing: Easing.out(Easing.back(1.2)) }),
      Animated.delay(2000),
      Animated.timing(toastAnim, { toValue: 0, duration: 200, useNativeDriver: false }),
    ]).start(() => setToast(null));
  }, [toastAnim]);

  // ---- MULTI-SELECT ----
  const toggleSelect = useCallback((id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      if (next.size === 0) setMultiSelect(false);
      return next;
    });
  }, []);

  const enterMultiSelect = useCallback((id) => {
    setMultiSelect(true);
    setSelectedIds(new Set([id]));
  }, []);

  const exitMultiSelect = useCallback(() => {
    setMultiSelect(false);
    setSelectedIds(new Set());
  }, []);

  // Moved ABOVE handleBulkDelete to avoid TDZ (Temporal Dead Zone) crash
  const loadStorageInfo = useCallback(async () => {
    try {
      // Show cached storage instantly
      const cached = await getCached('drive_storage_info');
      if (cached) setStorageInfo(cached);
      // Fetch fresh
      const r = await api.fileStorageInfo();
      if (r?.success && r.data) {
        setStorageInfo(r.data);
        setCache('drive_storage_info', r.data, 7776000000);
      } else if (r?.total_used !== undefined || r?.percentage !== undefined) {
        // Response may not have wrapper — use as-is
        setStorageInfo(r);
        setCache('drive_storage_info', r, 7776000000);
      }
    } catch (e) {
      console.warn('Storage info load failed:', e);
    }
  }, []);

  const handleBulkDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    for (const id of selectedIds) {
      try { await api.fileDelete(id); } catch {}
    }
    showToast(t('files.movedToTrash'));
    // Move items from allFiles to allTrash locally
    setAllFiles(prev => {
      const deleted = prev.filter(f => selectedIds.has(f.id));
      setAllTrash(tr => [...deleted.map(f => ({ ...f, is_trashed: 1 })), ...tr]);
      return prev.filter(f => !selectedIds.has(f.id));
    });
    setAllFolders(prev => {
      const deleted = prev.filter(f => selectedIds.has(f.id));
      setAllTrash(tr => [...deleted.map(f => ({ ...f, is_trashed: 1 })), ...tr]);
      return prev.filter(f => !selectedIds.has(f.id));
    });
    exitMultiSelect();
    loadStorageInfo();
  }, [selectedIds, showToast, exitMultiSelect, loadStorageInfo]);

  const handleBulkStar = useCallback(async () => {
    if (selectedIds.size === 0) return;
    for (const id of selectedIds) {
      try { await api.fileStar(id); } catch {}
    }
    showToast(t('files.starred'));
    // Toggle starred locally
    setAllFiles(prev => prev.map(f =>
      selectedIds.has(f.id) ? { ...f, is_starred: f.is_starred === 1 ? 0 : 1 } : f
    ));
    exitMultiSelect();
  }, [selectedIds, showToast, exitMultiSelect]);

  // ---- LOAD ALL DATA ONCE ----
  // Load folder content (fast - only current folder, not ALL 18K files)
  const folderCache = useRef({});
  const loadRequestIdRef = useRef(0); // Race condition guard
  const loadAllFiles = useCallback(async (showLoader = true) => {
    const cacheKey = currentFolderId || 'root';
    const persistKey = `files_${cacheKey}`;
    const requestId = ++loadRequestIdRef.current;
    // ALWAYS show cached data instantly (cache-first pattern)
    if (folderCache.current[cacheKey]) {
      const data = folderCache.current[cacheKey];
      setAllFolders(data.folders || []);
      setAllFiles(data.files || []);
      setLoading(false);
    } else {
      try {
        let cached = null;
        if (!cached) cached = await getCached(persistKey);
        if (cached) {
          folderCache.current[cacheKey] = cached;
          if (requestId !== loadRequestIdRef.current) return; // Stale request
          setAllFolders(cached.folders || []);
          setAllFiles(cached.files || []);
          setLoading(false);
        } else if (showLoader) {
          setLoading(true);
        }
      } catch {
        if (showLoader) setLoading(true);
      }
    }
    try {
      // Fetch fresh data in background
      const r = await api.fileList(currentFolderId);
      if (requestId !== loadRequestIdRef.current) return; // Stale request - discard
      if (r.success) {
        const rawData = r.data || {};
        // API returns all items in 'files' array (folders + files mixed)
        // Split them for separate state management
        // Normalize: backend may use 'starred' instead of 'is_starred', and may lack 'original_name'/'size_formatted'
        const normalize = (f) => ({
          ...f,
          is_starred: f.is_starred ?? f.starred ?? 0,
          original_name: f.original_name || f.name || '',
          size_formatted: f.size_formatted || formatSize(f.size || 0),
        });
        const allItems = (rawData.files || []).map(normalize);
        const data = {
          folders: (rawData.folders || allItems.filter(f => f.is_folder)).map(normalize),
          files: (rawData.files_only || allItems.filter(f => !f.is_folder)).map(normalize),
          breadcrumbs: rawData.breadcrumbs,
          storage: rawData.storage,
        };
        folderCache.current[cacheKey] = data;
        setAllFolders(data.folders);
        setAllFiles(data.files);
        setCache(persistKey, data, 7776000000).catch(() => {});
      }
      // Load trash separately only if on trash tab
      if (tab === 'trash') {
        const rt = await api.fileTrash();
        if (requestId !== loadRequestIdRef.current) return;
        if (rt.success) {
          const normalizeTrash = (f) => ({
            ...f,
            is_starred: f.is_starred ?? f.starred ?? 0,
            original_name: f.original_name || f.name || '',
            size_formatted: f.size_formatted || formatSize(f.size || 0),
          });
          setAllTrash((rt.data?.files || []).map(normalizeTrash));
        }
      }
    } catch {} finally {
      if (requestId === loadRequestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [currentFolderId, tab]);

  // Load on mount AND reload when folder changes
  useEffect(() => {
    loadAllFiles(true);
    loadStorageInfo();
  }, [loadAllFiles]);

  // Reload when app comes to foreground or screen gets focus
  useEffect(() => {
    const handleFocus = () => {
      loadAllFiles(false); // Silent refresh
      loadStorageInfo();
    };
    // For web: reload when tab becomes visible
    let visHandler;
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      visHandler = () => { if (!document.hidden) handleFocus(); };
      document.addEventListener('visibilitychange', visHandler);
    }
    // For native: use AppState
    const { AppState } = require('react-native');
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') handleFocus();
    });
    return () => {
      sub?.remove();
      if (visHandler && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', visHandler);
      }
    };
  }, [loadAllFiles, loadStorageInfo]);

  // Reload on tab change
  useEffect(() => {
    setSearchMode(false);
    setSearchText('');
    setSearchResults(null);
    if (tab === 'all') {
      loadAllFiles(false);
    } else if (tab === 'trash') {
      api.fileTrash().then(r => {
        if (r.success) {
          const normalizeTrash = (f) => ({
            ...f,
            is_starred: f.is_starred ?? f.starred ?? 0,
            original_name: f.original_name || f.name || '',
            size_formatted: f.size_formatted || formatSize(f.size || 0),
          });
          setAllTrash((r.data?.files || []).map(normalizeTrash));
        }
      });
    } else if (tab === 'recent') {
      // Use dedicated recent API that searches ALL folders, not just root
      api.fileRecent().then(r => {
        if (r.success) {
          const normalize = (f) => ({
            ...f,
            is_starred: f.is_starred ?? f.starred ?? 0,
            original_name: f.original_name || f.name || '',
            size_formatted: f.size_formatted || formatSize(f.size || 0),
          });
          setAllFiles((r.data?.files || []).map(normalize));
        }
      });
      setAllFolders([]);
      setCurrentFolderId(null);
    } else if (tab === 'starred') {
      // Use dedicated starred API that searches ALL folders, not just root
      api.fileStar(null).then(r => {
        // fileStar with null id acts as list mode in the backend (drive_starred without id)
        if (r.success) {
          const normalize = (f) => ({
            ...f,
            is_starred: f.is_starred ?? f.starred ?? 0,
            original_name: f.original_name || f.name || '',
            size_formatted: f.size_formatted || formatSize(f.size || 0),
          });
          setAllFiles((r.data?.files || []).map(normalize));
        }
      });
      setAllFolders([]);
      setCurrentFolderId(null);
    }
  }, [tab]);

  useEffect(() => {
    return () => {
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
    };
  }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadAllFiles(false);
    loadStorageInfo();
  }, [loadAllFiles, loadStorageInfo]);

  // ---- INSTANT NAVIGATION (local state only) ----
  const navigateToFolder = useCallback(async (folderId) => {
    setTab('all');
    setCurrentFolderId(folderId);

    // Update breadcrumb
    if (folderId === null) {
      breadcrumbStackRef.current = [];
      setBreadcrumb([]);
    } else {
      // Check if going back (folder is already in breadcrumb)
      const existIdx = breadcrumbStackRef.current.findIndex(b => b.id === folderId);
      if (existIdx >= 0) {
        breadcrumbStackRef.current = breadcrumbStackRef.current.slice(0, existIdx + 1);
      } else {
        // Going forward - find folder name from current display
        const targetFolder = allFolders.find(f => f.id === folderId);
        const name = targetFolder?.name || targetFolder?.original_name || 'Folder';
        breadcrumbStackRef.current = [...breadcrumbStackRef.current, { id: folderId, name }];
      }
      setBreadcrumb([...breadcrumbStackRef.current]);
    }

    // Show cached folder content instantly
    const cacheKey = folderId || 'root';
    const cached = folderCache.current[cacheKey];
    if (cached) {
      setAllFolders(cached.folders || []);
      setAllFiles(cached.files || []);
    } else {
      // No cache - show loading briefly
      setAllFolders([]);
      setAllFiles([]);
    }

    // Fetch fresh
    try {
      const r = await api.fileList(folderId);
      if (r.success) {
        const rawData = r.data || {};
        const normalize = (f) => ({
          ...f,
          is_starred: f.is_starred ?? f.starred ?? 0,
          original_name: f.original_name || f.name || '',
          size_formatted: f.size_formatted || formatSize(f.size || 0),
        });
        const allItems = (rawData.files || []).map(normalize);
        const data = {
          folders: (rawData.folders || allItems.filter(f => f.is_folder)).map(normalize),
          files: (rawData.files_only || allItems.filter(f => !f.is_folder)).map(normalize),
          breadcrumbs: rawData.breadcrumbs,
          storage: rawData.storage,
        };
        folderCache.current[cacheKey] = data;
        setAllFolders(data.folders);
        setAllFiles(data.files);
      }
    } catch {}
  }, [allFolders]);

  // Breadcrumb stack - track locally as we navigate
  const breadcrumbStackRef = useRef([]);
  const [breadcrumb, setBreadcrumb] = useState([]);

  // Data already comes filtered from API - no need to filter locally
  const folders = tab === 'all' ? allFolders : [];
  const files = tab === 'trash' ? allTrash : allFiles;

  // ---- SEARCH ----
  // Detects natural-language queries (>3 words OR contains stopwords) and uses AI semantic search.
  // Otherwise falls back to plain text search.
  const handleSearch = useCallback(async (query) => {
    const q = query.trim();
    if (!q) {
      setSearchResults(null);
      return;
    }
    const wordCount = q.split(/\s+/).length;
    const isNaturalLanguage = wordCount >= 4 || /\b(que|qual|sobre|encontre|achar|do|da|de|para|com)\b/i.test(q);
    try {
      // Always start with text search to get a candidate set
      const r = await api.fileSearch(q);
      if (r.success) {
        const normalize = (f) => ({
          ...f,
          is_starred: f.is_starred ?? f.starred ?? 0,
          original_name: f.original_name || f.name || '',
          size_formatted: f.size_formatted || formatSize(f.size || 0),
        });
        let allItems = (r.data?.files || []).map(normalize);

        // If natural language query and we have any files at all, try AI re-ranking
        if (isNaturalLanguage && allFiles.length > 0) {
          try {
            const candidates = (allItems.length > 0 ? allItems : allFiles).slice(0, 100).map(f => ({
              name: f.name || f.original_name,
              type: f.mime_type || '',
              size: f.size || 0,
            }));
            const aiRes = await api.aiFileSearch(q, candidates);
            if (aiRes?.success && Array.isArray(aiRes.data?.matches) && aiRes.data.matches.length > 0) {
              const baseList = (allItems.length > 0 ? allItems : allFiles);
              allItems = aiRes.data.matches
                .map(m => baseList[(m.index || 1) - 1])
                .filter(Boolean)
                .map(normalize);
            }
          } catch {}
        }

        setSearchResults({
          files: allItems.filter(f => !f.is_folder),
          folders: allItems.filter(f => f.is_folder),
        });
      }
    } catch {}
  }, [allFiles]);

  const onSearchChange = useCallback((text) => {
    setSearchText(text);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => handleSearch(text), 400);
  }, [handleSearch]);

  const toggleSearchMode = useCallback((on) => {
    setSearchMode(on);
    if (!on) {
      setSearchText('');
      setSearchResults(null);
    }
    Animated.timing(searchBarAnim, {
      toValue: on ? 1 : 0,
      duration: 250,
      useNativeDriver: false,
      easing: Easing.out(Easing.cubic),
    }).start();
  }, [searchBarAnim]);

  // ---- UPLOAD ----
  const handleUpload = useCallback(async () => {
    setShowFab(false);
    try {
      let DocumentPicker;
      try { DocumentPicker = require('expo-document-picker'); } catch {
        safeAlert(t('common.error'), t('files.documentPickerUnavailable'));
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

      const fileData = isWeb && asset.file
        ? { _raw: asset.file, name: asset.name, type: asset.mimeType }
        : { uri: asset.uri, name: asset.name, mimeType: asset.mimeType };

      const r = await api.fileUploadDirect(fileData, tab === 'all' ? currentFolderId : null);
      if (r.success) {
        showToast(t('files.fileUploaded'));
        loadAllFiles(false);
        loadStorageInfo();
      } else {
        safeAlert(t('files.uploadFailed'), r.message || t('files.uploadFailedDesc'));
      }
    } catch (err) {
      safeAlert(t('common.error'), t('files.uploadError') + ': ' + (err.message || t('files.unknownError')));
    } finally {
      setUploading(false);
    }
  }, [currentFolderId, tab, showToast, loadAllFiles, loadStorageInfo]);

  // ---- SCAN DOCUMENT ----
  const handleScanDocument = useCallback(async () => {
    try {
      let ImagePicker;
      try { ImagePicker = require('expo-image-picker'); } catch {
        safeAlert(t('common.error'), t('files.cameraUnavailable'));
        return;
      }

      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        safeAlert(t('common.error'), t('files.cameraPermissionDenied'));
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        quality: 0.9,
        allowsEditing: false,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) return;

      setUploading(true);
      const asset = result.assets[0];

      let finalUri = asset.uri;
      try {
        const ImageManipulator = require('expo-image-manipulator');
        const manipulated = await ImageManipulator.manipulateAsync(
          asset.uri,
          [{ resize: { width: Math.min(asset.width || 2048, 2048) } }],
          { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG }
        );
        finalUri = manipulated.uri;
      } catch (e) {}

      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const scanName = `Scan_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}.jpg`;

      const fileData = { uri: finalUri, name: scanName, mimeType: 'image/jpeg' };
      const r = await api.fileUploadDirect(fileData, tab === 'all' ? currentFolderId : null);
      if (r.success) {
        showToast(t('files.scanSaved'));
        loadAllFiles(false);
        loadStorageInfo();
      } else {
        safeAlert(t('files.uploadFailed'), r.message || t('files.uploadFailedDesc'));
      }
    } catch (err) {
      safeAlert(t('common.error'), t('files.scanError') + ': ' + (err.message || t('files.unknownError')));
    } finally {
      setUploading(false);
    }
  }, [currentFolderId, tab, showToast, loadAllFiles, loadStorageInfo]);

  // ---- CREATE FOLDER ----
  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim()) return;
    try {
      const r = await api.fileCreateFolder(newFolderName.trim(), tab === 'all' ? currentFolderId : null);
      if (r.success) {
        showToast(t('files.folderCreated'));
        setNewFolderModal(false);
        setNewFolderName('');
        loadAllFiles(false);
      } else {
        safeAlert(t('common.error'), r.message || t('files.folderCreateFailed'));
      }
    } catch {
      safeAlert(t('common.error'), t('files.folderCreateError'));
    }
  }, [newFolderName, currentFolderId, tab, showToast, loadAllFiles]);

  // ---- FILE ACTIONS ----
  const handleStar = useCallback(async (fileId) => {
    try {
      const r = await api.fileStar(fileId);
      if (r.success) {
        // Backend may return 'starred' or 'is_starred' depending on version
        const newVal = (r.data?.is_starred ?? r.data?.starred) ? 1 : 0;
        setAllFiles(prev => prev.map(f =>
          f.id == fileId ? { ...f, is_starred: newVal, starred: newVal } : f
        ));
      }
    } catch {}
  }, []);

  const handleDelete = useCallback(async (fileId) => {
    try {
      const r = await api.fileDelete(fileId);
      if (r.success) {
        showToast(t('files.movedToTrash'));
        // Move to trash locally
        const deleted = allFiles.find(f => f.id == fileId) || allFolders.find(f => f.id == fileId);
        if (deleted) setAllTrash(prev => [{ ...deleted, is_trashed: 1 }, ...prev]);
        setAllFiles(prev => prev.filter(f => f.id != fileId));
        setAllFolders(prev => prev.filter(f => f.id != fileId));
        setActionMenu(null);
        loadStorageInfo();
      }
    } catch {}
  }, [showToast, loadStorageInfo, allFiles, allFolders]);

  const handleRestore = useCallback(async (fileId) => {
    try {
      const r = await api.fileRestore(fileId);
      if (r.success) {
        showToast(t('files.fileRestored'));
        // Move from trash back to active
        const restored = allTrash.find(f => f.id == fileId);
        if (restored) {
          const clean = { ...restored, is_trashed: 0 };
          if (clean.is_folder) setAllFolders(prev => [...prev, clean]);
          else setAllFiles(prev => [...prev, clean]);
        }
        setAllTrash(prev => prev.filter(f => f.id != fileId));
        setActionMenu(null);
        loadStorageInfo();
      }
    } catch {}
  }, [showToast, loadStorageInfo, allTrash]);

  const handlePermanentDelete = useCallback(async (fileId) => {
    safeAlert(t('files.permanentDeleteTitle'), t('files.permanentDeleteDesc'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('files.delete'), style: 'destructive', onPress: async () => {
          try {
            const r = await api.filePermanentDelete(fileId);
            if (r.success) {
              showToast(t('files.permanentlyDeleted'));
              setAllTrash(prev => prev.filter(f => f.id != fileId));
              setActionMenu(null);
              loadStorageInfo();
            }
          } catch {}
        }
      },
    ]);
  }, [showToast, loadStorageInfo]);

  const handleEmptyTrash = useCallback(() => {
    safeAlert(t('drive.emptyTrashConfirm') || 'Empty Trash?', t('drive.emptyTrashConfirmDesc') || 'All files in trash will be permanently deleted.', [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('drive.emptyTrash') || 'Empty Trash', style: 'destructive', onPress: async () => {
          try {
            const r = await api.fileEmptyTrash();
            if (r.success) {
              showToast(t('files.trashEmptied') || 'Trash emptied');
              setAllTrash([]);
              loadStorageInfo();
            }
          } catch {}
        }
      },
    ]);
  }, [showToast, loadStorageInfo, t]);

  const handleRename = useCallback(async () => {
    if (!renameModal || !renameModal.name.trim()) return;
    try {
      const r = await api.fileRename(renameModal.id, renameModal.type, renameModal.name.trim());
      if (r.success) {
        showToast(t('files.renamed'));
        const newName = renameModal.name.trim();
        const rid = renameModal.id;
        // Update name locally
        setAllFiles(prev => prev.map(f => f.id == rid ? { ...f, name: newName, original_name: newName } : f));
        setAllFolders(prev => prev.map(f => f.id == rid ? { ...f, name: newName } : f));
        setRenameModal(null);
      } else {
        safeAlert(t('common.error'), r.message || t('files.renameFailed'));
      }
    } catch {}
  }, [renameModal, showToast]);

  const handleDownload = useCallback((fileId, file) => {
    // Prefer cdn_url for direct CDN download (faster, no server proxy)
    const url = file?.cdn_url || api.fileDownloadUrl(fileId);
    if (isWeb) {
      window.open(url, '_blank');
    } else {
      Linking.openURL(url).catch(() => {});
    }
    setActionMenu(null);
  }, []);

  const handleFileOpen = useCallback((file, index) => {
    const mime = (file.mime_type || '').toLowerCase();
    const name = (file.name || file.original_name || '').toLowerCase();
    const isPdf = name.endsWith('.pdf');
    const isDocx = name.endsWith('.docx') || name.endsWith('.doc');
    const isSheet = mime.includes('spreadsheet') || mime.includes('ms-excel') || mime.includes('csv') || name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv');
    const isEditableDoc = mime.includes('document') || mime.includes('msword') || mime.includes('text/plain') || mime.includes('text/html') || mime.includes('rtf') || name.endsWith('.txt') || name.endsWith('.rtf');

    // DOC/DOCX/RTF/TXT: open in Chatyy Docs editor (CKEditor 5) — same platform
    if (isDocx || isEditableDoc) {
      const docsUrl = `/docs/editor.html#import-drive-${file.id}`;
      if (isWeb) { window.open(docsUrl, '_blank'); }
      else {
        router.push({ pathname: '/documentos', params: { import: 'drive-' + file.id, type: 'editor' } });
      }
      return;
    }

    // XLSX/XLS/CSV: open in Chatyy Docs spreadsheet (Jspreadsheet) — same platform
    if (isSheet) {
      const docsUrl = `/docs/spreadsheet.html#import-drive-${file.id}`;
      if (isWeb) { window.open(docsUrl, '_blank'); }
      else {
        router.push({ pathname: '/documentos', params: { import: 'drive-' + file.id, type: 'spreadsheet' } });
      }
      return;
    }

    // PDF: inline preview.html (Chatyy native PDF viewer via embed/iframe)
    if (isPdf) {
      const downloadUrl = file.cdn_url || api.fileDownloadUrl(file.id);
      const fileName = file.name || file.original_name || 'file';
      if (isWeb) {
        const previewUrl = `/preview.html?url=${encodeURIComponent(downloadUrl)}&type=pdf&name=${encodeURIComponent(fileName)}`;
        window.open(previewUrl, '_blank');
      } else {
        // Native: in-app modal with WebView (no external browser)
        setViewerFile(file);
        setViewerIndex(index);
      }
      return;
    }

    setViewerFile(file);
    setViewerIndex(index);
  }, [router]);

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
        safeAlert(t('common.error'), r.message || t('files.shareFailed'));
      }
    } catch {}
  }, [shareModal, shareEmail, sharePermission, showToast]);

  const handleMove = useCallback(async (targetFolderId) => {
    if (!moveModal) return;
    try {
      const r = await api.fileMove(moveModal.file_id, targetFolderId);
      if (r.success) {
        showToast(t('files.fileMoved'));
        const fid = moveModal.file_id;
        // Remove moved item from current folder view (it's now in a different folder)
        setAllFiles(prev => prev.filter(f => f.id != fid));
        setAllFolders(prev => prev.filter(f => f.id != fid));
        setMoveModal(null);
      } else {
        safeAlert(t('common.error'), r.message || t('files.moveFailed'));
      }
    } catch {}
  }, [moveModal, showToast]);

  const openMoveModal = useCallback((fileId) => {
    setActionMenu(null);
    // Use local folder data - no API call needed
    setMoveModal({ file_id: fileId, folders: allFolders });
  }, [allFolders]);

  // ---- LONG PRESS / ACTION MENU ----
  const showActionMenu = useCallback((type, item) => {
    setActionMenu({ type, item });
  }, []);

  // ---- SORT HELPER ----
  const sortFiles = useCallback((fileList) => {
    if (!fileList?.length) return fileList;
    const sorted = [...fileList];
    sorted.sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case 'name':
          cmp = (a.original_name || a.name || '').localeCompare(b.original_name || b.name || '');
          break;
        case 'date':
          cmp = new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0);
          break;
        case 'size':
          cmp = (b.size || 0) - (a.size || 0);
          break;
        case 'type':
          cmp = (a.icon_type || a.mime_type || '').localeCompare(b.icon_type || b.mime_type || '');
          break;
        default:
          cmp = 0;
      }
      return sortAsc ? cmp : -cmp;
    });
    return sorted;
  }, [sortBy, sortAsc]);

  const handleSort = useCallback((by) => {
    if (sortBy === by) {
      setSortAsc(prev => !prev);
    } else {
      setSortBy(by);
      setSortAsc(by === 'name'); // name asc by default, date/size desc
    }
    setShowSortMenu(false);
  }, [sortBy]);

  // ---- RENDER LIST DATA ----
  const displayFolders = searchResults ? (searchResults.folders || []) : folders;
  const displayFiles = searchResults ? (searchResults.files || []) : files;

  const listData = useMemo(() => [
    ...displayFolders.map(f => ({ ...f, _type: 'folder' })),
    ...sortFiles(displayFiles).map(f => ({ ...f, _type: 'file' })),
  ], [displayFolders, displayFiles, sortFiles]);

  const renderItem = ({ item }) => {
    if (item._type === 'folder') {
      return (
        <FolderCard
          folder={item}
          colors={colors}
          onPress={() => navigateToFolder(item.id)}
          onLongPress={() => showActionMenu('folder', item)}
          onContextMenu={isWeb ? (e) => { e?.preventDefault?.(); showActionMenu('folder', item); } : undefined}
          t={t}
          isDark={isDark}
        />
      );
    }
    const fileIndex = displayFiles.indexOf(item);
    const isSelected = selectedIds.has(item.id);
    return (
      <FileCard
        file={item}
        colors={colors}
        t={t}
        multiSelect={multiSelect}
        isSelected={isSelected}
        onSelect={() => toggleSelect(item.id)}
        onPress={() => {
          if (tab === 'trash') {
            showActionMenu('trash_file', item);
          } else {
            handleFileOpen(item, fileIndex >= 0 ? fileIndex : 0);
          }
        }}
        onContextMenu={isWeb ? (e) => { e?.preventDefault?.(); showActionMenu(tab === 'trash' ? 'trash_file' : 'file', item); } : undefined}
        onLongPress={() => {
          // Long-press always opens action menu
          showActionMenu(tab === 'trash' ? 'trash_file' : 'file', item);
          return;
          if (!multiSelect && tab !== 'trash') {
            enterMultiSelect(item.id);
          } else {
            showActionMenu(tab === 'trash' ? 'trash_file' : 'file', item);
          }
        }}
        onStar={() => tab !== 'trash' && handleStar(item.id)}
        isDark={isDark}
      />
    );
  };

  const renderEmpty = () => {
    if (loading) return null;
    return <FilesEmptyState tab={tab} isDark={isDark} colors={colors} t={t} onUpload={handleUpload} />;
  };

  // ---- HEADER TITLE ----
  const TAB_LABELS = { all: t('files.tabAll'), recent: t('files.tabRecent'), starred: t('files.tabStarred'), trash: t('files.tabTrash') };

  const headerTitle = searchMode
    ? t('files.searchFiles')
    : breadcrumb.length > 0
      ? breadcrumb[breadcrumb.length - 1].name
      : t('files.title');

  // ---- GRID ITEM RENDERER ----
  const renderGridItem = ({ item }) => {
    if (item._type === 'folder') {
      const folderColor = getFolderColor(item.id);
      return (
        <TouchableOpacity
          style={[
            styles.gridItem,
            {
              backgroundColor: glassCardBg(isDark),
              borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
            },
            glassStyle(isDark),
          ]}
          onPress={() => navigateToFolder(item.id)}
          onLongPress={() => showActionMenu('folder', item)}
          activeOpacity={0.7}
        >
          <View style={[styles.gridItemIcon, { backgroundColor: isDark ? folderColor + '18' : folderColor + '10' }]}>
            <IconFolder size={30} color={folderColor} />
          </View>
          <Text style={[styles.gridItemName, { color: colors.text }]} numberOfLines={2}>{item.name}</Text>
          <Text style={[styles.gridItemMeta, { color: colors.textTertiary }]}>{t('files.folder')}</Text>
        </TouchableOpacity>
      );
    }
    const fileIndex = displayFiles.indexOf(item);
    const hasGridThumb = (item.icon_type === 'image' || item.icon_type === 'video') && item.id;
    const gridThumbUrl = hasGridThumb ? (item.thumbnail_url || item.cdn_url || api.fileDownloadUrl(item.id)) : null;
    const typeColors = getTypeColors(item.icon_type, isDark);
    const typeBadge = getFileTypeBadge(item.icon_type);
    const isItemSelected = selectedIds.has(item.id);

    return (
      <TouchableOpacity
        style={[
          styles.gridItem,
          {
            backgroundColor: glassCardBg(isDark),
            borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
          },
          glassStyle(isDark),
          isItemSelected && {
            borderColor: colors.primary + '60',
            ...(isDark && isWeb ? { boxShadow: `0 0 12px ${colors.primary}33` } : {}),
          },
        ]}
        onPress={() => {
          if (multiSelect) { toggleSelect(item.id); return; }
          if (tab === 'trash') showActionMenu('trash_file', item);
          else handleFileOpen(item, fileIndex >= 0 ? fileIndex : 0);
        }}
        onLongPress={() => {
          // Long-press always opens action menu (not multi-select)
          showActionMenu(tab === 'trash' ? 'trash_file' : 'file', item);
        }}
        // Web: right-click also opens action menu
        {...(isWeb ? { onContextMenu: (e) => { e?.preventDefault?.(); showActionMenu(tab === 'trash' ? 'trash_file' : 'file', item); } } : {})}
        activeOpacity={0.7}
      >
        {multiSelect && (
          <View style={styles.gridCheckbox}>
            <View style={[
              styles.checkbox,
              { borderColor: isDark ? 'rgba(255,255,255,0.2)' : colors.border },
              isItemSelected && { backgroundColor: colors.primary, borderColor: colors.primary },
            ]}>
              {isItemSelected && <IconCheck size={10} color="#fff" />}
            </View>
          </View>
        )}
        {hasGridThumb ? (
          <View style={styles.gridThumbWrap}>
            <Image source={{ uri: gridThumbUrl }} style={styles.gridThumb} resizeMode="cover" />
            {item.icon_type === 'video' && (
              <View style={styles.gridVideoOverlay}><IconFilm size={16} color="#fff" /></View>
            )}
          </View>
        ) : (
          <View style={[styles.gridItemIcon, { backgroundColor: typeColors.bg }]}>
            {getFileIcon(item.icon_type, 30, typeColors.icon)}
            {typeBadge && (
              <View style={[styles.gridTypeBadge, { backgroundColor: typeColors.accent }]}>
                <Text style={styles.gridTypeBadgeText}>{typeBadge}</Text>
              </View>
            )}
          </View>
        )}
        <Text style={[styles.gridItemName, { color: colors.text }]} numberOfLines={2}>{item.original_name}</Text>
        <View style={[styles.gridSizePill, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }]}>
          <Text style={[styles.gridSizePillText, { color: colors.textTertiary }]}>{item.size_formatted}</Text>
        </View>
        {item.is_starred === 1 && (
          <View style={styles.gridStarBadge}>
            <IconStarFilled size={12} color="#f59e0b" />
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header - Frosted Glass */}
      <View style={[
        styles.header,
        {
          backgroundColor: glassHeaderBg(isDark),
          borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
        },
        isWeb && {
          backdropFilter: 'blur(24px) saturate(200%)',
          WebkitBackdropFilter: 'blur(24px) saturate(200%)',
        },
      ]}>
        <TouchableOpacity
          onPress={() => {
            if (searchMode) {
              toggleSearchMode(false);
            } else if (breadcrumb.length > 0 && tab === 'all') {
              const parent = breadcrumb.length > 1 ? breadcrumb[breadcrumb.length - 2].id : null;
              navigateToFolder(parent);
            } else {
              router.back();
            }
          }}
          style={styles.headerBtn}
        >
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        {searchMode ? (
          <View style={[
            styles.searchInputWrap,
            {
              backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)',
              borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
            },
          ]}>
            <IconSearch size={16} color={colors.textTertiary} />
            <TextInput
              style={[styles.searchInput, { color: colors.text }]}
              placeholder={t('files.searchPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              value={searchText}
              onChangeText={onSearchChange}
              autoFocus
            />
          </View>
        ) : (
          <Text style={[styles.headerTitle, { color: colors.text }]}>{headerTitle}</Text>
        )}
        {searchMode ? (
          <TouchableOpacity onPress={() => toggleSearchMode(false)} style={styles.headerBtn}>
            <IconX size={20} color={colors.text} />
          </TouchableOpacity>
        ) : (
          <>
            <TouchableOpacity
              onPress={() => setViewMode(v => v === 'list' ? 'grid' : 'list')}
              style={[
                styles.viewToggleBtn,
                { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' },
              ]}
            >
              {viewMode === 'list' ? (
                <View style={styles.gridIcon}>
                  <View style={styles.gridIconRow}>
                    <View style={[styles.gridIconDot, { backgroundColor: colors.text }]} />
                    <View style={[styles.gridIconDot, { backgroundColor: colors.text }]} />
                  </View>
                  <View style={styles.gridIconRow}>
                    <View style={[styles.gridIconDot, { backgroundColor: colors.text }]} />
                    <View style={[styles.gridIconDot, { backgroundColor: colors.text }]} />
                  </View>
                </View>
              ) : (
                <View style={styles.listIcon}>
                  <View style={[styles.listIconLine, { backgroundColor: colors.text }]} />
                  <View style={[styles.listIconLine, { backgroundColor: colors.text }]} />
                  <View style={[styles.listIconLine, { backgroundColor: colors.text }]} />
                </View>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setShowSortMenu(v => !v)}
              style={[
                styles.viewToggleBtn,
                { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', marginLeft: 4 },
              ]}
            >
              <Text style={{ fontSize: 11, fontWeight: '700', color: colors.text }}>
                {sortBy === 'name' ? 'A-Z' : sortBy === 'date' ? (t('files.sortDate') || 'Date') : sortBy === 'size' ? (t('files.sortSize') || 'Size') : (t('files.sortType') || 'Type')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => toggleSearchMode(true)} style={styles.headerBtn}>
              <IconSearch size={20} color={colors.text} />
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* Sort menu dropdown */}
      {showSortMenu && (
        <>
        <TouchableOpacity
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 99 }}
          onPress={() => setShowSortMenu(false)}
          activeOpacity={1}
        />
        <View style={[styles.sortMenu, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }]}>
          {[
            { key: 'name', label: t('files.sortName') || 'Name' },
            { key: 'date', label: t('files.sortDate') || 'Date' },
            { key: 'size', label: t('files.sortSize') || 'Size' },
            { key: 'type', label: t('files.sortType') || 'Type' },
          ].map(opt => (
            <TouchableOpacity
              key={opt.key}
              style={[styles.sortMenuItem, sortBy === opt.key && { backgroundColor: isDark ? 'rgba(59,130,246,0.12)' : 'rgba(37,99,235,0.06)' }]}
              onPress={() => handleSort(opt.key)}
              activeOpacity={0.6}
            >
              <Text style={[styles.sortMenuText, { color: sortBy === opt.key ? colors.primary : colors.text }]}>
                {opt.label}
              </Text>
              {sortBy === opt.key && (
                <Text style={{ color: colors.primary, fontSize: 12 }}>{sortAsc ? '\u2191' : '\u2193'}</Text>
              )}
            </TouchableOpacity>
          ))}
        </View>
        </>
      )}

      {/* Multi-select toolbar */}
      {multiSelect && (
        <View style={[
          styles.multiSelectBar,
          {
            backgroundColor: isDark ? colors.primary + '18' : colors.primaryLight,
            borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : colors.border,
          },
        ]}>
          <TouchableOpacity onPress={exitMultiSelect} style={styles.headerBtn}>
            <IconX size={20} color={colors.primary} />
          </TouchableOpacity>
          <Text style={[styles.multiSelectCount, { color: colors.primary }]}>
            {t('files.selectedCount', { count: selectedIds.size })}
          </Text>
          <View style={{ flex: 1 }} />
          <TouchableOpacity onPress={handleBulkStar} style={[styles.multiSelectAction, { backgroundColor: isDark ? 'rgba(245,158,11,0.12)' : '#fffbeb' }]}>
            <IconStar size={18} color="#f59e0b" />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleBulkDelete} style={[styles.multiSelectAction, { backgroundColor: isDark ? 'rgba(220,38,38,0.12)' : '#fef2f2' }]}>
            <IconTrash size={18} color={colors.error} />
          </TouchableOpacity>
        </View>
      )}

      {/* Tab Bar */}
      {!searchMode && !multiSelect && (
        <View style={[styles.tabBar, { backgroundColor: isDark ? 'rgba(30,41,59,0.5)' : 'rgba(241,245,249,0.8)' }]}>
          {TABS.map((key) => {
            const TabIcon = key === 'all' ? IconInbox : key === 'recent' ? IconClock : key === 'starred' ? IconStarFilled : IconTrash;
            const isActive = tab === key;
            return (
              <TouchableOpacity
                key={key}
                style={[
                  styles.tab,
                  isActive && [
                    { backgroundColor: isDark ? colors.primary + '25' : colors.primary },
                    isDark && isWeb && { boxShadow: `0 0 10px ${colors.primary}30` },
                  ],
                ]}
                onPress={() => { setTab(key); setCurrentFolderId(null); exitMultiSelect(); }}
              >
                <View style={styles.tabContent}>
                  <TabIcon size={14} color={isActive ? (isDark ? colors.primary : '#fff') : colors.textSecondary} />
                  <Text style={[
                    styles.tabText,
                    { color: isActive ? (isDark ? colors.primary : '#fff') : colors.textSecondary },
                    isActive && { fontWeight: '700' },
                  ]}>
                    {TAB_LABELS[key]}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {/* Empty Trash button */}
      {tab === 'trash' && allTrash.length > 0 && !searchMode && !multiSelect && (
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 16, paddingVertical: 8 }}>
          <TouchableOpacity
            onPress={handleEmptyTrash}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 6,
              borderWidth: 1, borderColor: '#dc2626', borderRadius: 10,
              paddingHorizontal: 14, paddingVertical: 7,
            }}
            activeOpacity={0.7}
          >
            <IconTrash size={14} color="#dc2626" />
            <Text style={{ color: '#dc2626', fontSize: 13, fontWeight: '600' }}>{t('sidebar.emptyTrash')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Breadcrumb - pill style */}
      {tab === 'all' && breadcrumb.length > 0 && !searchMode && (
        <BreadcrumbBar
          breadcrumb={breadcrumb}
          colors={colors}
          onNavigate={navigateToFolder}
          t={t}
          isDark={isDark}
        />
      )}

      {/* Toast */}
      {toast && (
        <Animated.View style={[
          styles.toast,
          {
            backgroundColor: isDark ? '#f1f5f9' : '#1e293b',
            transform: [
              { translateY: toastAnim.interpolate({ inputRange: [0, 1], outputRange: [-20, 0] }) },
              { scale: toastAnim.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) },
            ],
            opacity: toastAnim,
          },
        ]}>
          <View style={[styles.toastIcon, { backgroundColor: isDark ? '#16a34a' : '#4ade80' }]}>
            <IconCheck size={12} color="#fff" />
          </View>
          <Text style={[styles.toastText, { color: isDark ? '#0f172a' : '#f8fafc' }]}>{toast}</Text>
        </Animated.View>
      )}

      {/* Upload progress */}
      {uploading && (
        <View style={[styles.uploadBar, { backgroundColor: isDark ? colors.primary + '12' : colors.primary + '08' }]}>
          <View style={styles.uploadSpinner}>
            <ActivityIndicator size="small" color={colors.primary} />
          </View>
          <Text style={[styles.uploadText, { color: colors.primary }]}>{t('files.uploading')}</Text>
          <View style={[styles.uploadProgress, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}>
            <View style={[styles.uploadProgressFill, { backgroundColor: colors.primary }]} />
          </View>
        </View>
      )}

      {/* File List */}
      {loading && !refreshing && files.length === 0 && folders.length === 0 ? (
        <ListSkeleton count={6} />
      ) : (
        <View style={{ flex: 1 }}>
          <FlatList
            key={viewMode}
            data={listData}
            keyExtractor={(item) => `${item._type}-${item.id}`}
            renderItem={viewMode === 'grid' ? renderGridItem : renderItem}
            numColumns={viewMode === 'grid' ? 3 : 1}
            ListEmptyComponent={renderEmpty}
            contentContainerStyle={[styles.list, listData.length === 0 && styles.listEmpty]}
            columnWrapperStyle={viewMode === 'grid' ? styles.gridRow : undefined}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
            }
            getItemLayout={viewMode === 'list' ? (data, index) => ({
              length: 76,
              offset: 76 * index,
              index,
            }) : undefined}
            maxToRenderPerBatch={20}
            windowSize={10}
            initialNumToRender={20}
            removeClippedSubviews={!isWeb}
          />
        </View>
      )}

      {/* Storage Bar */}
      <StorageBar storageInfo={storageInfo} colors={colors} t={t} isDark={isDark} />

      {/* FAB Row */}
      <View style={[styles.fabRow, { paddingBottom: insets.bottom + Spacing.md }]}>
        <TouchableOpacity
          style={[
            styles.fab,
            styles.fabSecondary,
            {
              backgroundColor: glassCardBg(isDark),
              borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
            },
            glassStyle(isDark),
          ]}
          onPress={() => setNewFolderModal(true)}
        >
          <IconFolderPlus size={20} color={colors.primary} />
          <Text style={[styles.fabText, { color: colors.primary }]}>{t('files.newFolder')}</Text>
        </TouchableOpacity>
        {!isWeb && (
          <TouchableOpacity
            style={[
              styles.fab,
              styles.fabSecondary,
              {
                backgroundColor: glassCardBg(isDark),
                borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
              },
              glassStyle(isDark),
            ]}
            onPress={handleScanDocument}
            disabled={uploading}
          >
            <IconCamera size={20} color={colors.primary} />
            <Text style={[styles.fabText, { color: colors.primary }]}>{t('files.scanDocument')}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[styles.fab, styles.fabPrimary, { backgroundColor: colors.primary }, Shadow.float]}
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
      <Modal visible={!!actionMenu} transparent animationType="slide" onRequestClose={() => setActionMenu(null)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setActionMenu(null)}>
          <View style={[
            styles.actionSheet,
            {
              backgroundColor: isDark ? 'rgba(21,30,46,0.95)' : 'rgba(255,255,255,0.97)',
            },
            isWeb && {
              backdropFilter: 'blur(30px) saturate(200%)',
              WebkitBackdropFilter: 'blur(30px) saturate(200%)',
            },
          ]}>
            {/* Drag handle */}
            <View style={[styles.actionSheetHandle, { backgroundColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)' }]} />
            <View style={[styles.actionSheetHeader, { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}>
              <Text style={[styles.actionSheetTitle, { color: colors.text }]} numberOfLines={1}>
                {actionMenu?.item?.name || actionMenu?.item?.original_name || t('files.item')}
              </Text>
            </View>

            {actionMenu?.type === 'folder' && (
              <>
                <TouchableOpacity style={styles.actionItem} onPress={() => { setActionMenu(null); setRenameModal({ id: actionMenu.item.id, type: 'folder', name: actionMenu.item.name }); }}>
                  <View style={[styles.actionItemIcon, { backgroundColor: isDark ? '#2563eb18' : '#eff6ff' }]}>
                    <IconEdit size={18} color="#2563eb" />
                  </View>
                  <Text style={[styles.actionItemText, { color: colors.text }]}>{t('files.rename')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionItem} onPress={() => openMoveModal(actionMenu.item.id)}>
                  <View style={[styles.actionItemIcon, { backgroundColor: isDark ? '#8b5cf618' : '#f5f3ff' }]}>
                    <IconFolder size={18} color="#8b5cf6" />
                  </View>
                  <Text style={[styles.actionItemText, { color: colors.text }]}>{t('files.moveTo')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionItem} onPress={() => handleDelete(actionMenu.item.id)}>
                  <View style={[styles.actionItemIcon, { backgroundColor: isDark ? '#dc262618' : '#fef2f2' }]}>
                    <IconTrash size={18} color="#dc2626" />
                  </View>
                  <Text style={[styles.actionItemText, { color: colors.error }]}>{t('files.delete')}</Text>
                </TouchableOpacity>
              </>
            )}

            {actionMenu?.type === 'file' && (
              <>
                {/* Analyze with One AI — prominently at the top */}
                <TouchableOpacity style={[styles.actionItem, { backgroundColor: isDark ? 'rgba(168,85,247,0.08)' : 'rgba(168,85,247,0.05)' }]} onPress={() => {
                  const f = actionMenu.item;
                  setActionMenu(null);
                  const fileUrl = f.cdn_url || api.fileDownloadUrl(f.id);
                  const fileName = f.name || f.original_name || 'file';
                  const mime = (f.mime_type || '').toLowerCase();
                  try {
                    const intent = JSON.stringify({
                      type: 'analyze_file',
                      file_id: f.id,
                      file_name: fileName,
                      file_url: fileUrl,
                      mime_type: mime,
                    });
                    router.push({ pathname: '/one', params: { intent, prefill: `Analise esse arquivo: ${fileName}` } });
                  } catch {}
                }}>
                  <View style={[styles.actionItemIcon, { backgroundColor: '#a855f7' }]}>
                    <Text style={{ fontSize: 16, color: '#fff' }}>✨</Text>
                  </View>
                  <Text style={[styles.actionItemText, { color: '#a855f7', fontWeight: '700' }]}>{t('files.analyzeWithOne') || 'Analisar com One AI'}</Text>
                </TouchableOpacity>
                {(() => {
                  const m = (actionMenu.item.mime_type || '').toLowerCase();
                  const n = (actionMenu.item.name || actionMenu.item.original_name || '').toLowerCase();
                  const isEditableDoc = m.includes('document') || m.includes('msword') || m.includes('text/plain') || m.includes('text/html') || m.includes('rtf') || n.endsWith('.docx') || n.endsWith('.doc') || n.endsWith('.txt');
                  const isEditableSheet = m.includes('spreadsheet') || m.includes('ms-excel') || m.includes('csv') || n.endsWith('.xlsx') || n.endsWith('.xls') || n.endsWith('.csv');
                  const isPreviewable = n.endsWith('.pdf') || n.endsWith('.docx') || n.endsWith('.doc');
                  return (
                    <>
                      {isPreviewable && (
                        <TouchableOpacity style={styles.actionItem} onPress={() => {
                          setActionMenu(null);
                          const downloadUrl = actionMenu.item.cdn_url || api.fileDownloadUrl(actionMenu.item.id);
                          const type = n.endsWith('.pdf') ? 'pdf' : 'docx';
                          const fileName = actionMenu.item.name || actionMenu.item.original_name || 'file';
                          const previewUrl = `/preview.html?url=${encodeURIComponent(downloadUrl)}&type=${encodeURIComponent(type)}&name=${encodeURIComponent(fileName)}`;
                          if (isWeb) {
                            window.open(previewUrl, '_blank');
                          } else {
                            setViewerFile(actionMenu.item);
                            setViewerIndex(0);
                          }
                        }}>
                          <View style={[styles.actionItemIcon, { backgroundColor: isDark ? '#2563eb18' : '#eff6ff' }]}>
                            <IconEye size={18} color="#2563eb" />
                          </View>
                          <Text style={[styles.actionItemText, { color: '#2563eb', fontWeight: '600' }]}>{t('drive.preview') || 'Visualizar'}</Text>
                        </TouchableOpacity>
                      )}
                      {(isEditableDoc || isEditableSheet) && (
                        <TouchableOpacity style={styles.actionItem} onPress={() => {
                          setActionMenu(null);
                          const docsUrl = `/docs/${isEditableSheet ? 'spreadsheet' : 'editor'}.html#import-drive-${actionMenu.item.id}`;
                          if (isWeb) window.open(docsUrl, '_blank');
                          else router.push('/documentos');
                        }}>
                          <View style={[styles.actionItemIcon, { backgroundColor: isDark ? '#4285f418' : '#e8f0fe' }]}>
                            <IconFileText size={18} color="#4285f4" />
                          </View>
                          <Text style={[styles.actionItemText, { color: '#4285f4', fontWeight: '600' }]}>{t('files.editWithDocs') || 'Editar com Documentos'}</Text>
                        </TouchableOpacity>
                      )}
                    </>
                  );
                })()}
                <TouchableOpacity style={styles.actionItem} onPress={() => handleDownload(actionMenu.item.id, actionMenu.item)}>
                  <View style={[styles.actionItemIcon, { backgroundColor: isDark ? '#16a34a18' : '#f0fdf4' }]}>
                    <IconDownload size={18} color="#16a34a" />
                  </View>
                  <Text style={[styles.actionItemText, { color: colors.text }]}>{t('files.download')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionItem} onPress={() => { setActionMenu(null); setRenameModal({ id: actionMenu.item.id, type: 'file', name: actionMenu.item.original_name }); }}>
                  <View style={[styles.actionItemIcon, { backgroundColor: isDark ? '#2563eb18' : '#eff6ff' }]}>
                    <IconEdit size={18} color="#2563eb" />
                  </View>
                  <Text style={[styles.actionItemText, { color: colors.text }]}>{t('files.rename')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionItem} onPress={() => openMoveModal(actionMenu.item.id)}>
                  <View style={[styles.actionItemIcon, { backgroundColor: isDark ? '#8b5cf618' : '#f5f3ff' }]}>
                    <IconFolder size={18} color="#8b5cf6" />
                  </View>
                  <Text style={[styles.actionItemText, { color: colors.text }]}>{t('files.moveTo')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionItem} onPress={() => { handleStar(actionMenu.item.id); setActionMenu(null); }}>
                  <View style={[styles.actionItemIcon, { backgroundColor: isDark ? '#f59e0b18' : '#fffbeb' }]}>
                    {actionMenu.item.is_starred === 1 ? (
                      <IconStarFilled size={18} color="#f59e0b" />
                    ) : (
                      <IconStar size={18} color="#f59e0b" />
                    )}
                  </View>
                  <Text style={[styles.actionItemText, { color: colors.text }]}>
                    {actionMenu.item.is_starred === 1 ? t('files.unstar') : t('files.star')}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionItem} onPress={async () => {
                  const fid = actionMenu.item.id;
                  setActionMenu(null);
                  let shared = [];
                  try {
                    const r = await api.fileGetShared(fid);
                    if (r.success) shared = r.data || [];
                  } catch {}
                  setShareModal({ file_id: fid, shared });
                }}>
                  <View style={[styles.actionItemIcon, { backgroundColor: isDark ? '#0891b218' : '#ecfeff' }]}>
                    <IconPaperclip size={18} color="#0891b2" />
                  </View>
                  <Text style={[styles.actionItemText, { color: colors.text }]}>{t('files.share')}</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.actionItem} onPress={() => handleDelete(actionMenu.item.id)}>
                  <View style={[styles.actionItemIcon, { backgroundColor: isDark ? '#dc262618' : '#fef2f2' }]}>
                    <IconTrash size={18} color="#dc2626" />
                  </View>
                  <Text style={[styles.actionItemText, { color: colors.error }]}>{t('files.delete')}</Text>
                </TouchableOpacity>
              </>
            )}

            {actionMenu?.type === 'trash_file' && (
              <>
                <TouchableOpacity style={styles.actionItem} onPress={() => handleRestore(actionMenu.item.id)}>
                  <View style={[styles.actionItemIcon, { backgroundColor: isDark ? '#16a34a18' : '#f0fdf4' }]}>
                    <IconArchive size={18} color="#16a34a" />
                  </View>
                  <Text style={[styles.actionItemText, { color: colors.success || '#16a34a' }]}>{t('files.restore')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionItem} onPress={() => handlePermanentDelete(actionMenu.item.id)}>
                  <View style={[styles.actionItemIcon, { backgroundColor: isDark ? '#dc262618' : '#fef2f2' }]}>
                    <IconTrash size={18} color="#dc2626" />
                  </View>
                  <Text style={[styles.actionItemText, { color: colors.error }]}>{t('files.deletePermanently')}</Text>
                </TouchableOpacity>
              </>
            )}

            <TouchableOpacity style={[styles.actionItem, { marginTop: 4 }]} onPress={() => setActionMenu(null)}>
              <View style={[styles.actionItemIcon, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]}>
                <IconX size={18} color={colors.textTertiary} />
              </View>
              <Text style={[styles.actionItemText, { color: colors.textTertiary }]}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ============ RENAME MODAL ============ */}
      <Modal visible={!!renameModal} transparent animationType="fade" onRequestClose={() => setRenameModal(null)}>
        <TouchableOpacity style={styles.modalBackdropCenter} activeOpacity={1} onPress={() => setRenameModal(null)}>
          <View style={[
            styles.dialogBox,
            {
              backgroundColor: isDark ? 'rgba(21,30,46,0.95)' : 'rgba(255,255,255,0.98)',
              borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
            },
            isWeb && { backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' },
          ]} onStartShouldSetResponder={() => true}>
            <Text style={[styles.dialogTitle, { color: colors.text }]}>{t('files.rename')}</Text>
            <TextInput
              style={[styles.dialogInput, {
                color: colors.text,
                borderColor: isDark ? 'rgba(255,255,255,0.12)' : colors.border,
                backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
              }]}
              value={renameModal?.name || ''}
              onChangeText={(text) => setRenameModal(prev => prev ? { ...prev, name: text } : null)}
              autoFocus
              selectTextOnFocus
              onSubmitEditing={handleRename}
            />
            <View style={styles.dialogBtns}>
              <TouchableOpacity style={[styles.dialogBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]} onPress={() => setRenameModal(null)}>
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
        <TouchableOpacity style={styles.modalBackdropCenter} activeOpacity={1} onPress={() => setNewFolderModal(false)}>
          <View style={[
            styles.dialogBox,
            {
              backgroundColor: isDark ? 'rgba(21,30,46,0.95)' : 'rgba(255,255,255,0.98)',
              borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
            },
            isWeb && { backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' },
          ]} onStartShouldSetResponder={() => true}>
            <Text style={[styles.dialogTitle, { color: colors.text }]}>{t('files.newFolder')}</Text>
            <TextInput
              style={[styles.dialogInput, {
                color: colors.text,
                borderColor: isDark ? 'rgba(255,255,255,0.12)' : colors.border,
                backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
              }]}
              placeholder={t('files.folderNamePlaceholder')}
              placeholderTextColor={colors.textTertiary}
              value={newFolderName}
              onChangeText={setNewFolderName}
              autoFocus
              onSubmitEditing={handleCreateFolder}
            />
            <View style={styles.dialogBtns}>
              <TouchableOpacity style={[styles.dialogBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]} onPress={() => { setNewFolderModal(false); setNewFolderName(''); }}>
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
        <TouchableOpacity style={styles.modalBackdropCenter} activeOpacity={1} onPress={() => setShareModal(null)}>
          <View style={[
            styles.dialogBox,
            {
              backgroundColor: isDark ? 'rgba(21,30,46,0.95)' : 'rgba(255,255,255,0.98)',
              borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
              maxHeight: '80%',
            },
            isWeb && { backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' },
          ]} onStartShouldSetResponder={() => true}>
            <Text style={[styles.dialogTitle, { color: colors.text }]}>{t('files.shareFile')}</Text>

            {shareModal?.shared?.length > 0 && (
              <View style={{ marginBottom: 12 }}>
                <Text style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 6, fontWeight: '600' }}>
                  {t('files.sharedWith') || 'Compartilhado com'}
                </Text>
                {shareModal.shared.map((s, i) => (
                  <View key={i} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: i < shareModal.shared.length - 1 ? 1 : 0, borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }}>
                    <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: colors.primary + '22', alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
                      <Text style={{ fontSize: 14, fontWeight: '700', color: colors.primary }}>{(s.email || '?')[0].toUpperCase()}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 13, color: colors.text }} numberOfLines={1}>{s.email}</Text>
                      <Text style={{ fontSize: 11, color: s.permission === 'edit' ? '#22c55e' : colors.textTertiary }}>
                        {s.permission === 'edit' ? (t('files.canEdit') || 'Pode editar') : (t('files.viewOnly') || 'Visualizar')}
                      </Text>
                    </View>
                    <TouchableOpacity onPress={async () => {
                      try {
                        await api.fileUnshare(shareModal.file_id, s.email);
                        setShareModal(prev => ({ ...prev, shared: prev.shared.filter(x => x.email !== s.email) }));
                        showToast(t('files.shareRemoved') || 'Acesso removido');
                      } catch {}
                    }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <IconX size={16} color={colors.textTertiary} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}

            <Text style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 6, fontWeight: '600' }}>
              {t('files.addPerson') || 'Adicionar pessoa'}
            </Text>
            <TextInput
              style={[styles.dialogInput, {
                color: colors.text,
                borderColor: isDark ? 'rgba(255,255,255,0.12)' : colors.border,
                backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
              }]}
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
                style={[
                  styles.permissionBtn,
                  {
                    borderColor: isDark ? 'rgba(255,255,255,0.1)' : '#e2e8f0',
                    backgroundColor: sharePermission === 'view' ? colors.primary : 'transparent',
                  },
                ]}
                onPress={() => setSharePermission('view')}
              >
                <Text style={[styles.permissionText, { color: sharePermission === 'view' ? '#fff' : colors.textSecondary }]}>
                  {t('files.viewOnly')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.permissionBtn,
                  {
                    borderColor: isDark ? 'rgba(255,255,255,0.1)' : '#e2e8f0',
                    backgroundColor: sharePermission === 'edit' ? colors.primary : 'transparent',
                  },
                ]}
                onPress={() => setSharePermission('edit')}
              >
                <Text style={[styles.permissionText, { color: sharePermission === 'edit' ? '#fff' : colors.textSecondary }]}>
                  {t('files.canEdit')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.permissionBtn,
                  {
                    borderColor: isDark ? 'rgba(255,255,255,0.1)' : '#e2e8f0',
                    backgroundColor: sharePermission === 'admin' ? '#f59e0b' : 'transparent',
                  },
                ]}
                onPress={() => setSharePermission('admin')}
              >
                <Text style={[styles.permissionText, { color: sharePermission === 'admin' ? '#fff' : colors.textSecondary }]}>
                  Admin
                </Text>
              </TouchableOpacity>
            </View>
            <View style={styles.dialogBtns}>
              <TouchableOpacity style={[styles.dialogBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]} onPress={() => { setShareModal(null); setShareEmail(''); }}>
                <Text style={[styles.dialogBtnText, { color: colors.textSecondary }]}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.dialogBtn, styles.dialogBtnPrimary, { backgroundColor: colors.primary }]} onPress={async () => {
                await handleShare();
                if (shareModal?.file_id) {
                  try {
                    const r = await api.fileGetShared(shareModal.file_id);
                    if (r.success) setShareModal(prev => ({ ...prev, shared: r.data || [] }));
                  } catch {}
                }
              }}>
                <Text style={[styles.dialogBtnText, { color: '#fff' }]}>{t('files.share')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ============ MOVE MODAL ============ */}
      <Modal visible={!!moveModal} transparent animationType="fade" onRequestClose={() => setMoveModal(null)}>
        <TouchableOpacity style={styles.modalBackdropCenter} activeOpacity={1} onPress={() => setMoveModal(null)}>
          <View style={[
            styles.dialogBox,
            {
              backgroundColor: isDark ? 'rgba(21,30,46,0.95)' : 'rgba(255,255,255,0.98)',
              borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
              maxHeight: 400,
            },
            isWeb && { backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' },
          ]} onStartShouldSetResponder={() => true}>
            <Text style={[styles.dialogTitle, { color: colors.text }]}>{t('files.moveToFolder')}</Text>
            <TouchableOpacity
              style={[styles.moveItem, { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}
              onPress={() => handleMove(null)}
            >
              <View style={[styles.moveItemIconWrap, { backgroundColor: isDark ? colors.primary + '18' : '#eff6ff' }]}>
                <IconFolder size={18} color={colors.primary} />
              </View>
              <Text style={[styles.moveItemText, { color: colors.primary, fontWeight: '600' }]}>{t('files.rootHome')}</Text>
            </TouchableOpacity>
            <FlatList
              data={moveModal?.folders || allFolders}
              keyExtractor={(item) => String(item.id)}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[styles.moveItem, { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}
                  onPress={() => handleMove(item.id)}
                >
                  <View style={[styles.moveItemIconWrap, { backgroundColor: isDark ? getFolderColor(item.id) + '18' : getFolderColor(item.id) + '10' }]}>
                    <IconFolder size={18} color={getFolderColor(item.id)} />
                  </View>
                  <Text style={[styles.moveItemText, { color: colors.text }]}>{item.name}</Text>
                </TouchableOpacity>
              )}
              style={{ maxHeight: 250 }}
            />
            <TouchableOpacity style={[styles.dialogBtn, { alignSelf: 'flex-end', marginTop: Spacing.sm, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]} onPress={() => setMoveModal(null)}>
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
        getUrl={(f) => f.cdn_url || api.fileDownloadUrl(f.id)}
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
    borderBottomWidth: 1,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20 },
  headerTitle: { fontSize: FontSize.xl, fontWeight: '700', flex: 1, textAlign: 'center', letterSpacing: -0.3 },

  // Search
  searchInputWrap: {
    flex: 1, flexDirection: 'row', alignItems: 'center', height: 38,
    borderRadius: 19, paddingHorizontal: 14, marginHorizontal: Spacing.xs,
    borderWidth: 1, gap: 8,
  },
  searchInput: {
    flex: 1, height: 36, fontSize: FontSize.md,
    paddingHorizontal: 0,
    ...(isWeb ? { outline: 'none' } : {}),
  },

  // View toggle
  viewToggleBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },

  // Sort menu
  sortMenu: {
    position: 'absolute', top: 56, right: 80, zIndex: 100,
    borderRadius: 10, borderWidth: 1,
    paddingVertical: 4, minWidth: 120,
    ...(isWeb ? { boxShadow: '0 4px 16px rgba(0,0,0,0.12)' } : { elevation: 8 }),
  },
  sortMenuItem: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 10,
  },
  sortMenuText: { fontSize: 14, fontWeight: '500' },

  // Tabs
  tabBar: {
    flexDirection: 'row', marginHorizontal: Spacing.md, marginTop: Spacing.sm,
    borderRadius: BorderRadius.xl, padding: 3, gap: 4,
  },
  tab: {
    flex: 1, paddingVertical: Spacing.xs + 3, borderRadius: BorderRadius.lg,
    alignItems: 'center',
  },
  tabContent: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  tabText: { fontSize: FontSize.sm, fontWeight: '600' },

  // Breadcrumb - pill style
  breadcrumb: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs + 2,
    flexWrap: 'wrap', gap: 4,
    marginTop: 2,
  },
  breadcrumbPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 4, paddingHorizontal: 10, borderRadius: 12,
  },
  breadcrumbPillText: { fontSize: FontSize.sm, fontWeight: '500' },

  // List
  list: { padding: Spacing.md, gap: 6 },
  listEmpty: { flexGrow: 1 },
  loaderWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loaderCircle: {
    width: 64, height: 64, borderRadius: 32, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },

  // Item card - glassmorphism
  itemCard: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: BorderRadius.xl, padding: Spacing.md,
    borderWidth: 1, marginBottom: 4,
    ...Shadow.md,
  },
  itemIconWrap: {
    width: 48, height: 48, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center', marginRight: Spacing.md,
    position: 'relative',
  },
  itemThumbWrap: {
    width: 48, height: 48, borderRadius: 14,
    overflow: 'hidden', marginRight: Spacing.md, position: 'relative',
  },
  itemThumb: {
    width: 48, height: 48, borderRadius: 14,
  },
  videoOverlay: {
    position: 'absolute', bottom: 2, right: 2,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 8,
    width: 22, height: 22, alignItems: 'center', justifyContent: 'center',
  },

  // Type badge on icon
  typeBadge: {
    position: 'absolute', bottom: -3, right: -3,
    paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4,
    minWidth: 22, alignItems: 'center',
  },
  typeBadgeText: { fontSize: 7, fontWeight: '800', color: '#fff', letterSpacing: 0.3 },

  // Size pill
  sizePill: {
    paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8,
  },
  sizePillText: { fontSize: 10, fontWeight: '600' },

  // Checkbox
  checkboxWrap: { marginRight: Spacing.sm },
  checkbox: {
    width: 22, height: 22, borderRadius: 7, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  itemInfo: { flex: 1 },
  itemName: { fontSize: FontSize.md, fontWeight: '600', letterSpacing: -0.1 },
  itemMeta: { fontSize: FontSize.xs, marginTop: 2 },
  starBtn: { padding: 8 },

  // Folder chevron
  folderChevron: {
    width: 28, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },

  // Empty state
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: Spacing.xl },
  emptyIconCircle: {
    width: 120, height: 120, borderRadius: 60,
    alignItems: 'center', justifyContent: 'center',
  },
  emptyIconInner: {
    width: 80, height: 80, borderRadius: 40,
    alignItems: 'center', justifyContent: 'center',
  },
  emptyTitle: { fontSize: FontSize.xxl, fontWeight: '700', marginTop: Spacing.lg, letterSpacing: -0.3 },
  emptySubtitle: { fontSize: FontSize.md, textAlign: 'center', marginTop: Spacing.xs, lineHeight: 20 },
  emptyCta: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 24, paddingVertical: 12, borderRadius: BorderRadius.xl,
    marginTop: Spacing.lg,
    ...Shadow.float,
  },
  emptyCtaText: { fontSize: FontSize.md, fontWeight: '700', color: '#fff' },

  // FAB row
  fabRow: {
    flexDirection: 'row', gap: Spacing.sm, paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
  },
  fab: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: Spacing.sm + 3, borderRadius: BorderRadius.xl,
  },
  fabPrimary: {},
  fabSecondary: { borderWidth: 1 },
  fabText: { fontSize: FontSize.md, fontWeight: '700' },

  // Toast
  toast: {
    position: 'absolute', top: 120, alignSelf: 'center', zIndex: 100,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm + 2,
    borderRadius: BorderRadius.full || 99,
    ...Shadow.lg,
  },
  toastIcon: {
    width: 22, height: 22, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
  },
  toastText: { fontSize: FontSize.sm, fontWeight: '600' },

  // Upload bar
  uploadBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    marginHorizontal: Spacing.md, marginTop: Spacing.xs,
    borderRadius: BorderRadius.lg,
  },
  uploadSpinner: {},
  uploadText: { fontSize: FontSize.sm, fontWeight: '600', flex: 1 },
  uploadProgress: {
    width: 60, height: 4, borderRadius: 2, overflow: 'hidden',
  },
  uploadProgressFill: {
    width: '60%', height: '100%', borderRadius: 2,
  },

  // Storage bar
  storageBar: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm + 2,
    borderTopWidth: 1,
  },
  storageHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8,
  },
  storageMainText: { fontSize: FontSize.sm, fontWeight: '700', letterSpacing: -0.2 },
  storageSubLine: { fontSize: 10, marginTop: 1 },
  storagePercentBadge: {
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10,
  },
  storagePercentText: { fontSize: FontSize.sm, fontWeight: '800' },
  storageTrack: { height: 8, borderRadius: 4, overflow: 'hidden' },
  storageFillDrive: {
    height: '100%', borderRadius: 4,
    backgroundColor: '#2563eb',
  },
  storageFillGradient: {
    flex: 1, borderRadius: 4,
    ...(isWeb ? {
      background: 'linear-gradient(90deg, #2563eb, #8b5cf6)',
    } : {
      backgroundColor: '#2563eb',
    }),
  },
  storageFillEmail: {
    height: '100%', borderRadius: 4,
    backgroundColor: '#f59e0b',
  },
  storageLegend: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 6, gap: 8,
  },
  storageLegendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  storageLegendDot: { width: 8, height: 8, borderRadius: 4 },
  storageLegendText: { fontSize: 10, fontWeight: '500' },

  // Multi-select bar
  multiSelectBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.sm, paddingVertical: Spacing.xs,
    borderBottomWidth: 1, gap: 4,
  },
  multiSelectCount: { fontSize: FontSize.md, fontWeight: '700', marginLeft: Spacing.sm },
  multiSelectAction: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center', marginLeft: 4,
  },

  // Modals
  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end', alignItems: 'center',
  },
  modalBackdropCenter: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center', alignItems: 'center',
  },
  actionSheet: {
    width: '100%', maxWidth: 500,
    borderTopLeftRadius: BorderRadius.xxl, borderTopRightRadius: BorderRadius.xxl,
    paddingBottom: 40, paddingTop: Spacing.xs,
  },
  actionSheetHandle: {
    width: 36, height: 4, borderRadius: 2, alignSelf: 'center',
    marginTop: 8, marginBottom: 8,
  },
  actionSheetHeader: {
    paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm,
    borderBottomWidth: 1, marginBottom: 4,
  },
  actionSheetTitle: { fontSize: FontSize.md, fontWeight: '700', letterSpacing: -0.1 },
  actionItem: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm + 2,
  },
  actionItemIcon: {
    width: 36, height: 36, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  actionItemText: { fontSize: FontSize.md, fontWeight: '500' },

  // Dialog boxes
  dialogBox: {
    width: '90%', maxWidth: 400, borderRadius: BorderRadius.xxl,
    padding: Spacing.lg, borderWidth: 1,
    ...Shadow.xl,
  },
  dialogTitle: { fontSize: FontSize.lg, fontWeight: '700', marginBottom: Spacing.md, letterSpacing: -0.2 },
  dialogInput: {
    height: 46, borderRadius: BorderRadius.lg, borderWidth: 1,
    paddingHorizontal: Spacing.md, fontSize: FontSize.md, marginBottom: Spacing.md,
  },
  dialogBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.sm },
  dialogBtn: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm + 2, borderRadius: BorderRadius.lg },
  dialogBtnPrimary: {},
  dialogBtnText: { fontSize: FontSize.md, fontWeight: '700' },
  permissionRow: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.md },
  permissionBtn: {
    flex: 1, paddingVertical: Spacing.xs + 3, borderRadius: BorderRadius.lg,
    alignItems: 'center', borderWidth: 1,
  },
  permissionText: { fontSize: FontSize.sm, fontWeight: '600' },

  // Move modal
  moveItem: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    paddingVertical: Spacing.sm + 2, borderBottomWidth: 1,
  },
  moveItemIconWrap: {
    width: 34, height: 34, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  moveItemText: { fontSize: FontSize.md },

  // Grid view
  gridRow: { gap: 8, paddingHorizontal: 12 },
  gridItem: {
    flex: 1, margin: 4, borderRadius: 18, borderWidth: 1,
    padding: 14, alignItems: 'center', minHeight: 140,
    ...Shadow.md,
    position: 'relative',
  },
  gridItemIcon: {
    width: 56, height: 56, borderRadius: 16,
    justifyContent: 'center', alignItems: 'center', marginBottom: 10,
    position: 'relative',
  },
  gridTypeBadge: {
    position: 'absolute', bottom: -2, right: -2,
    paddingHorizontal: 3, paddingVertical: 1, borderRadius: 3,
    minWidth: 18, alignItems: 'center',
  },
  gridTypeBadgeText: { fontSize: 6, fontWeight: '800', color: '#fff' },
  gridThumbWrap: {
    width: 56, height: 56, borderRadius: 16,
    overflow: 'hidden', marginBottom: 10, position: 'relative',
  },
  gridThumb: { width: 56, height: 56 },
  gridVideoOverlay: {
    position: 'absolute', bottom: 2, right: 2,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 8,
    width: 22, height: 22, alignItems: 'center', justifyContent: 'center',
  },
  gridCheckbox: {
    position: 'absolute', top: 8, left: 8, zIndex: 2,
  },
  gridItemName: { fontSize: 12, fontWeight: '600', textAlign: 'center', letterSpacing: -0.1 },
  gridSizePill: {
    marginTop: 4, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6,
  },
  gridSizePillText: { fontSize: 9, fontWeight: '600' },
  gridItemMeta: { fontSize: 10, marginTop: 2, fontWeight: '500' },
  gridStarBadge: {
    position: 'absolute', top: 8, right: 8,
  },
  gridIcon: { width: 20, height: 20, justifyContent: 'center', gap: 3 },
  gridIconRow: { flexDirection: 'row', gap: 3, justifyContent: 'center' },
  gridIconDot: { width: 7, height: 7, borderRadius: 2 },
  listIcon: { width: 20, height: 20, justifyContent: 'center', gap: 3 },
  listIconLine: { height: 2, borderRadius: 1, width: '100%' },
});
