import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, StyleSheet, ScrollView, ActivityIndicator, Platform, Alert, Image, Animated, KeyboardAvoidingView,
  Dimensions, FlatList, Linking, useWindowDimensions, Modal,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { Colors } from '../constants/theme';
import * as api from '../services/api';
import {
  IconArrowLeft, IconMail, IconUser, IconPhone, IconCalendar,
  IconLock, IconChevronRight, IconShield, IconClock, IconImage,
  IconSmartphone, IconMonitor, IconCake, IconLogout,
  IconCamera, IconGrid, IconPlay, IconTag, IconLink, IconPlus,
  IconShare, IconSettings, IconHeart, IconBookmark,
} from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';
import ChangePasswordModal from '../components/ChangePasswordModal';
import TwoFactorSetup from '../components/TwoFactorSetup';
import VacationResponder from '../components/VacationResponder';

function getAvatarColor(name) {
  if (!name) return Colors.avatarBg;
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return Colors.avatarColors[Math.abs(hash) % Colors.avatarColors.length];
}

const safeAlert = (title, message, buttons) => {
  if (Platform.OS === 'web') {
    if (buttons?.length) {
      const ok = buttons.find(b => b.style !== 'cancel');
      if (ok?.onPress && window.confirm(`${title}\n${message || ''}`)) ok.onPress();
      else { const cancel = buttons.find(b => b.style === 'cancel'); cancel?.onPress?.(); }
    } else { window.alert(message || title); }
  } else { Alert.alert(title, message, buttons); }
};

// Parse user agent into device info
function parseUserAgent(ua) {
  if (!ua) return { type: 'desktop', name: 'Unknown', browser: '' };

  let type = 'desktop';
  let deviceName = '';
  let browser = '';

  // Detect device type
  if (/iPad/i.test(ua)) {
    type = 'tablet';
    deviceName = 'iPad';
  } else if (/iPhone/i.test(ua)) {
    type = 'mobile';
    deviceName = 'iPhone';
  } else if (/Android/i.test(ua)) {
    type = 'mobile';
    const match = ua.match(/;\s*([^;)]+)\s*Build/i);
    deviceName = match ? match[1].trim() : 'Android';
    if (/Tablet|SM-T|Tab/i.test(ua)) type = 'tablet';
  } else if (/Windows/i.test(ua)) {
    deviceName = 'Windows';
  } else if (/Macintosh|Mac OS/i.test(ua)) {
    deviceName = 'Mac';
  } else if (/Linux/i.test(ua)) {
    deviceName = 'Linux';
  } else if (/CrOS/i.test(ua)) {
    deviceName = 'Chromebook';
  }

  // Detect browser
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\//i.test(ua) || /Opera/i.test(ua)) browser = 'Opera';
  else if (/Chrome/i.test(ua) && !/Chromium/i.test(ua)) browser = 'Chrome';
  else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';
  else if (/Firefox/i.test(ua)) browser = 'Firefox';

  // Non-browser UA (API clients etc)
  if (!ua.includes('Mozilla') && !deviceName) {
    deviceName = ua.substring(0, 40);
  }

  // Compose final name
  let finalName = deviceName || 'Unknown';
  if (browser && type === 'desktop') {
    finalName = `${browser} on ${deviceName || 'Unknown'}`;
  } else if (browser && deviceName) {
    finalName = `${deviceName} - ${browser}`;
  }

  return { type, name: finalName, browser };
}

// Format relative time
function relativeTime(dateStr, t) {
  if (!dateStr) return '';
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMin < 2) return t('profile.activeNow');
  if (diffMin < 60) return `${diffMin} ${t('profile.minutesAgo')}`;
  if (diffHrs < 24) return `${diffHrs} ${t('profile.hoursAgo')}`;
  if (diffDays === 1) return t('profile.yesterday');
  if (diffDays < 30) return `${diffDays} ${t('profile.daysAgo')}`;
  return date.toLocaleDateString();
}

// Calculate age from birthday string
function calculateAge(birthday) {
  if (!birthday) return null;
  let date;
  const ddmmyyyy = birthday.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (ddmmyyyy) {
    date = new Date(parseInt(ddmmyyyy[3]), parseInt(ddmmyyyy[2]) - 1, parseInt(ddmmyyyy[1]));
  } else {
    date = new Date(birthday);
  }
  if (isNaN(date.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - date.getFullYear();
  const m = today.getMonth() - date.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < date.getDate())) age--;
  return age >= 0 ? age : null;
}

// Format birthday for display
function formatBirthday(birthday) {
  if (!birthday) return null;
  let date;
  const ddmmyyyy = birthday.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (ddmmyyyy) {
    date = new Date(parseInt(ddmmyyyy[3]), parseInt(ddmmyyyy[2]) - 1, parseInt(ddmmyyyy[1]));
  } else {
    date = new Date(birthday);
  }
  if (isNaN(date.getTime())) return birthday;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

// Format member since date
function formatMemberSince(dateStr) {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
}

// Format number compactly (1234 -> 1.2K)
function formatCount(n) {
  if (n === null || n === undefined) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 10000) return (n / 1000).toFixed(0) + 'K';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

// Parse media URLs from post
function parseMediaUrls(mediaStr) {
  if (!mediaStr) return [];
  if (Array.isArray(mediaStr)) return mediaStr;
  try { return JSON.parse(mediaStr); } catch { return mediaStr.split(',').filter(Boolean); }
}

// Tab identifiers
const TAB_GRID = 'grid';
const TAB_REELS = 'reels';
const TAB_TAGGED = 'tagged';
const TAB_ACCOUNT = 'account';

export default function ProfileScreen() {
  const { user, updateUser } = useAuth();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showTwoFactor, setShowTwoFactor] = useState(false);
  const [showVacation, setShowVacation] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [showSessions, setShowSessions] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [avatarUrl, setAvatarUrl] = useState(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [revokingSession, setRevokingSession] = useState(null);
  const [revokingAll, setRevokingAll] = useState(false);

  // Username @ handle state
  const [showUsernameModal, setShowUsernameModal] = useState(false);
  const [usernameInput, setUsernameInput] = useState('');
  const [usernameAvailable, setUsernameAvailable] = useState(null); // null | true | false
  const [usernameChecking, setUsernameChecking] = useState(false);
  const [usernameSaving, setUsernameSaving] = useState(false);
  const [usernameError, setUsernameError] = useState('');

  // Telnyx Caller ID verification state
  const [showCallerIdModal, setShowCallerIdModal] = useState(false);
  const [callerIdStep, setCallerIdStep] = useState('request'); // request | code | done
  const [callerIdCode, setCallerIdCode] = useState('');
  const [callerIdError, setCallerIdError] = useState('');
  const [callerIdLoading, setCallerIdLoading] = useState(false);

  // Instagram-style state
  const [activeTab, setActiveTab] = useState(TAB_GRID);
  const [userPosts, setUserPosts] = useState([]);
  const [postsLoading, setPostsLoading] = useState(false);
  const [postsPage, setPostsPage] = useState(1);
  const [hasMorePosts, setHasMorePosts] = useState(true);

  // Inline editing states
  const [editingField, setEditingField] = useState(null);
  const [editValue, _setEditValue] = useState('');
  const editValueRef = useRef('');
  const setEditValue = (v) => { editValueRef.current = v; _setEditValue(v); };
  const scrollViewRef = useRef(null);

  // Animations
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const avatarScale = useRef(new Animated.Value(0.7)).current;
  const tabIndicatorLeft = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: false }).start();
    Animated.spring(avatarScale, { toValue: 1, tension: 80, friction: 8, useNativeDriver: false, delay: 150 }).start();
  }, []);

  // Animate tab indicator
  const animateTabIndicator = useCallback((tabIndex) => {
    const contentWidth = Math.min(windowWidth, 600);
    const tabWidth = contentWidth / 3;
    Animated.spring(tabIndicatorLeft, {
      toValue: tabIndex * tabWidth,
      tension: 300,
      friction: 30,
      useNativeDriver: false,
    }).start();
  }, [windowWidth]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { getCached } = await import('../services/cache');
        const cached = await getCached('user_profile');
        if (cached && alive) {
          setProfile(cached);
          if (cached.has_avatar || cached.avatar) setAvatarUrl(api.getAvatarUrlForEmail(user?.email));
        }
      } catch {}
      try {
        const r = await api.getProfile();
        if (!alive) return;
        if (r.success) {
          setProfile(r.data || {});
          if (r.data?.has_avatar || r.data?.avatar) {
            setAvatarUrl(api.getAvatarUrlForEmail(user?.email) + (Platform.OS === 'web' ? '&t=' + Date.now() : ''));
          } else {
            setAvatarUrl(null);
          }
          try {
            const { setCache: _sc } = await import('../services/cache');
            _sc('user_profile', r.data, 600000).catch(() => {});
          } catch {}
        }
      } catch {}
    })();
    return () => { alive = false; };
  }, []);

  // Load user's feed posts
  useEffect(() => {
    if (user?.email) {
      loadUserPosts(1);
    }
  }, [user?.email]);

  const loadUserPosts = async (page = 1) => {
    if (postsLoading) return;
    setPostsLoading(true);
    try {
      const r = await api.feedUserPosts(user?.email, page);
      if (r.success) {
        const posts = r.data?.posts || r.data || [];
        if (page === 1) {
          setUserPosts(posts);
        } else {
          setUserPosts(prev => [...prev, ...posts]);
        }
        setHasMorePosts(posts.length >= 12);
        setPostsPage(page);
      }
    } catch {} finally {
      setPostsLoading(false);
    }
  };

  const loadProfile = async () => {
    try {
      const { getCached, setCache: _setCache } = await import('../services/cache');
      const cached = await getCached('user_profile');
      if (cached) {
        setProfile(cached);
        if (cached.has_avatar || cached.avatar) setAvatarUrl(api.getAvatarUrlForEmail(user?.email));
      }
    } catch {}
    try {
      const r = await api.getProfile();
      if (r.success) {
        setProfile(r.data || {});
        if (r.data?.has_avatar || r.data?.avatar) {
          setAvatarUrl(api.getAvatarUrlForEmail(user?.email) + (Platform.OS === 'web' ? '&t=' + Date.now() : ''));
        } else {
          setAvatarUrl(null);
        }
        try {
          const { setCache: _sc } = await import('../services/cache');
          _sc('user_profile', r.data, 600000).catch(() => {});
        } catch {}
      }
    } catch {}
  };

  const loadSessions = async () => {
    setLoadingSessions(true);
    try {
      const r = await api.getSessionsList();
      if (r.success) setSessions(r.data || []);
    } catch {} finally {
      setLoadingSessions(false);
    }
  };

  const handleAvatarUpload = async () => {
    if (Platform.OS === 'web') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        if (!validTypes.includes(file.type)) {
          safeAlert(t('common.error'), t('profile.invalidImageType') || 'Invalid image type. Use JPG, PNG, GIF or WebP.');
          return;
        }
        if (file.size > 10 * 1024 * 1024) {
          safeAlert(t('common.error'), t('profile.imageTooLarge') || 'Image too large. Max 10MB.');
          return;
        }
        setUploadingAvatar(true);
        try {
          const { uploadAvatar, getAvatarUrlForEmail } = await import('../services/api');
          const r = await uploadAvatar({ _raw: file, name: file.name, type: file.type });
          if (r.success) setAvatarUrl(getAvatarUrlForEmail(user?.email) + '&t=' + Date.now());
          else safeAlert(t('common.error'), t('profile.avatarUploadFailed') || 'Failed to upload photo');
        } catch {
          safeAlert(t('common.error'), t('profile.avatarUploadFailed') || 'Failed to upload photo');
        } finally {
          setUploadingAvatar(false);
        }
      };
      input.click();
    } else {
      try {
        const ImagePicker = await import('expo-image-picker');
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== 'granted') {
          safeAlert(t('profile.permissionRequired') || 'Permission required', t('profile.galleryPermission') || 'We need gallery access to choose a photo.');
          return;
        }
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsEditing: true,
          aspect: [1, 1],
          quality: 0.8,
        });
        if (result.canceled || !result.assets?.length) return;
        const asset = result.assets[0];
        setUploadingAvatar(true);
        try {
          const { uploadAvatar, getAvatarUrlForEmail } = await import('../services/api');
          const r = await uploadAvatar({ uri: asset.uri, name: asset.fileName || 'avatar.jpg', type: asset.mimeType || 'image/jpeg' });
          if (r.success) setAvatarUrl(getAvatarUrlForEmail(user?.email) + '&t=' + Date.now());
        } catch {} finally {
          setUploadingAvatar(false);
        }
      } catch {}
    }
  };

  const startEdit = (field, currentValue) => {
    setEditingField(field);
    setEditValue(currentValue || '');
    setSaveMsg('');
  };

  const cancelEdit = () => {
    setEditingField(null);
    setEditValue('');
    setSaveMsg('');
  };

  const saveField = async (field, value) => {
    setSaving(true);
    try {
      const payload = {};
      if (field === 'name') payload.display_name = value;
      else if (field === 'phone') payload.phone = value;
      else if (field === 'birthday') payload.birthday = value;
      else if (field === 'recovery') payload.recovery_email = value;
      else if (field === 'bio') payload.bio = value;
      else if (field === 'website') payload.website = value;
      else if (field === 'category') payload.category = value;

      const r = await api.updateProfile(payload);
      if (r.success) {
        setSaveMsg(t('profile.saved'));
        setEditingField(null);
        loadProfile();
        if (field === 'name' && value) {
          updateUser({ name: value });
        }
      } else {
        setSaveMsg(r.message || t('profile.errorSave'));
      }
    } catch { setSaveMsg(t('profile.connectionError')); }
    finally { setSaving(false); }
  };

  const handleRevokeSession = async (tokenHash) => {
    safeAlert(
      t('profile.signOut'),
      t('profile.signOutConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('profile.signOut'),
          style: 'destructive',
          onPress: async () => {
            setRevokingSession(tokenHash);
            try {
              const r = await api.revokeSession(tokenHash);
              if (r.success) {
                setSessions(prev => prev.filter(s => s.token_hash !== tokenHash));
                safeAlert(t('profile.sessionRevoked'));
              }
            } catch {} finally {
              setRevokingSession(null);
            }
          },
        },
      ]
    );
  };

  const handleRevokeAllSessions = async () => {
    const otherCount = sessions.filter(s => !s.is_current).length;
    if (otherCount === 0) {
      safeAlert(t('profile.noOtherSessions'));
      return;
    }
    safeAlert(
      t('profile.signOutAll'),
      t('profile.signOutAllConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('profile.signOutAll'),
          style: 'destructive',
          onPress: async () => {
            setRevokingAll(true);
            try {
              const r = await api.revokeAllSessions();
              if (r.success) {
                setSessions(prev => prev.filter(s => s.is_current));
                const count = r.data?.revoked_count || 0;
                safeAlert(`${count} ${t('profile.sessionsRevoked')}`);
              }
            } catch {} finally {
              setRevokingAll(false);
            }
          },
        },
      ]
    );
  };

  const handleShareProfile = useCallback(async () => {
    const profileUrl = `https://mail.onemundo.com.br/profile/${user?.email}`;
    if (Platform.OS === 'web') {
      try {
        if (navigator.share) {
          await navigator.share({ title: displayName, url: profileUrl });
        } else {
          await navigator.clipboard.writeText(profileUrl);
          safeAlert(t('profile.shareProfile'), 'Link copied!');
        }
      } catch {}
    } else {
      try {
        const { Share } = require('react-native');
        await Share.share({ message: profileUrl, title: displayName });
      } catch {}
    }
  }, [user?.email]);

  const avatarColor = getAvatarColor(user?.name || user?.email);
  const displayName = profile?.display_name || profile?.name || user?.name || '';
  const age = calculateAge(profile?.birthday);
  const formattedBirthday = formatBirthday(profile?.birthday);
  const memberSince = formatMemberSince(profile?.created_at);
  const bio = profile?.bio || '';
  const website = profile?.website || '';
  const category = profile?.category || '';
  const postsCount = profile?.posts_count ?? userPosts.length ?? 0;
  const followersCount = profile?.followers_count ?? 0;
  const followingCount = profile?.following_count ?? 0;

  // Grid image size
  const contentWidth = Math.min(windowWidth, 600);
  const gridGap = 2;
  const gridCols = 3;
  const gridItemSize = (contentWidth - gridGap * (gridCols - 1)) / gridCols;

  // Filter posts for reels tab (videos only)
  const videoPosts = userPosts.filter(p => p.media_type === 'video');

  // Highlights data (could come from API in the future)
  const highlights = profile?.highlights || [];

  // Device icon component
  const DeviceIcon = ({ type, size = 22, color }) => {
    if (type === 'mobile') return <IconSmartphone size={size} color={color} />;
    if (type === 'tablet') return <IconSmartphone size={size} color={color} />;
    return <IconMonitor size={size} color={color} />;
  };

  // Stat column (posts / followers / following)
  const StatColumn = ({ count, label, onPress }) => (
    <TouchableOpacity style={s.statCol} onPress={onPress} activeOpacity={0.6} disabled={!onPress}>
      <Text style={[s.statNumber, { color: colors.text }]}>{formatCount(count)}</Text>
      <Text style={[s.statLabel, { color: colors.textSecondary }]}>{label}</Text>
    </TouchableOpacity>
  );

  // Highlight circle
  const HighlightCircle = ({ item, isAdd }) => (
    <TouchableOpacity style={s.highlightItem} activeOpacity={0.7}>
      <View style={[s.highlightRing, {
        borderColor: isAdd ? colors.borderLight : colors.primary,
        backgroundColor: isAdd ? (isDark ? colors.surface : '#fafafa') : 'transparent',
      }]}>
        {isAdd ? (
          <View style={[s.highlightAdd, { backgroundColor: isDark ? colors.background : '#f5f5f5' }]}>
            <IconPlus size={24} color={colors.textSecondary} />
          </View>
        ) : (
          item?.cover_url ? (
            Platform.OS === 'web' ? (
              <img src={item.cover_url} style={{ width: 62, height: 62, borderRadius: 31, objectFit: 'cover' }} alt={item.title} />
            ) : (
              <Image source={{ uri: item.cover_url }} style={{ width: 62, height: 62, borderRadius: 31 }} />
            )
          ) : (
            <View style={[s.highlightPlaceholder, { backgroundColor: isDark ? '#2a2a2a' : '#e8e8e8' }]}>
              <Text style={{ fontSize: 20 }}>{item?.emoji || '+'}</Text>
            </View>
          )
        )}
      </View>
      <Text style={[s.highlightLabel, { color: colors.text }]} numberOfLines={1}>
        {isAdd ? t('profile.addHighlight') : (item?.title || '')}
      </Text>
    </TouchableOpacity>
  );

  // Post grid item
  const PostGridItem = ({ post }) => {
    const mediaUrls = parseMediaUrls(post.media_urls);
    const firstMedia = mediaUrls[0] || '';
    const isVideo = post.media_type === 'video';
    const isCarousel = mediaUrls.length > 1;

    return (
      <TouchableOpacity
        style={[s.gridItem, { width: gridItemSize, height: gridItemSize }]}
        activeOpacity={0.8}
        onPress={() => {
          // Could navigate to post detail
        }}
      >
        {firstMedia ? (
          Platform.OS === 'web' ? (
            <img
              src={firstMedia}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              alt={post.caption || ''}
              loading="lazy"
            />
          ) : (
            <Image
              source={{ uri: firstMedia }}
              style={{ width: '100%', height: '100%' }}
              resizeMode="cover"
            />
          )
        ) : (
          <View style={[s.gridItemPlaceholder, { backgroundColor: isDark ? '#1a1a1a' : '#f0f0f0' }]}>
            <IconImage size={24} color={colors.textTertiary} />
          </View>
        )}
        {/* Overlay icons for video or carousel */}
        {isVideo && (
          <View style={s.gridOverlayIcon}>
            <IconPlay size={18} color="#fff" />
          </View>
        )}
        {isCarousel && !isVideo && (
          <View style={s.gridOverlayIcon}>
            <View style={s.carouselIcon}>
              <View style={[s.carouselSquare, { borderColor: '#fff' }]} />
              <View style={[s.carouselSquare, s.carouselSquareBack, { borderColor: '#fff' }]} />
            </View>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  // Empty state for tabs
  const EmptyTabState = ({ icon: IconComp, title, subtitle }) => (
    <View style={s.emptyTab}>
      <View style={[s.emptyIconCircle, { borderColor: colors.text }]}>
        <IconComp size={40} color={colors.text} />
      </View>
      <Text style={[s.emptyTitle, { color: colors.text }]}>{title}</Text>
      {subtitle && <Text style={[s.emptySubtitle, { color: colors.textSecondary }]}>{subtitle}</Text>}
    </View>
  );

  // Editable info row
  const EditableInfoRow = ({ icon: IconComp, iconColor, label, value, displayValue, field, badge, keyboardType, placeholder }) => {
    const isEditing = editingField === field;
    const rowRef = useRef(null);
    return (
      <View ref={rowRef} style={[s.infoRow, { borderBottomColor: colors.borderLight + '40' }]}>
        <View style={[s.infoIconWrap, { backgroundColor: (iconColor || colors.primary) + '12' }]}>
          <IconComp size={18} color={iconColor || colors.primary} />
        </View>
        <View style={s.infoContent}>
          <Text style={[s.infoLabel, { color: colors.textTertiary }]}>{label}</Text>
          {isEditing ? (
            <View style={s.inlineEditWrap}>
              <TextInput
                style={[s.inlineEditInput, {
                  color: colors.text,
                  borderColor: colors.primary,
                  backgroundColor: colors.background,
                }]}
                defaultValue={editValueRef.current}
                onChangeText={(v) => { editValueRef.current = v; }}
                placeholder={placeholder}
                placeholderTextColor={colors.textTertiary}
                keyboardType={keyboardType || 'default'}
                autoCapitalize={field === 'recovery' ? 'none' : 'words'}
                autoFocus
                onFocus={() => {
                  setTimeout(() => {
                    if (rowRef.current && scrollViewRef.current) {
                      rowRef.current.measureLayout?.(
                        scrollViewRef.current.getInnerViewNode?.() || scrollViewRef.current,
                        (x, y) => {
                          scrollViewRef.current.scrollTo?.({ y: Math.max(0, y - 120), animated: true });
                        },
                        () => {
                          scrollViewRef.current.scrollTo?.({ y: 300, animated: true });
                        }
                      );
                    }
                  }, 300);
                }}
              />
              <View style={s.inlineEditActions}>
                <TouchableOpacity onPress={cancelEdit} style={[s.inlineBtn, { borderColor: colors.borderLight }]}>
                  <Text style={[s.inlineBtnText, { color: colors.textSecondary }]}>{t('common.cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => saveField(field, editValueRef.current)}
                  disabled={saving}
                  style={[s.inlineBtn, s.inlineBtnPrimary, { backgroundColor: colors.primary }]}
                >
                  {saving ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={[s.inlineBtnText, { color: '#fff', fontWeight: '600' }]}>{t('profile.save')}</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <View style={s.infoValueRow}>
              {value ? (
                <Text style={[s.infoValue, { color: colors.text }]}>{displayValue || value}</Text>
              ) : (
                <TouchableOpacity onPress={() => startEdit(field, '')}>
                  <Text style={[s.addValueText, { color: colors.primary }]}>
                    {field === 'phone' ? t('profile.addPhone') : field === 'birthday' ? t('profile.addBirthday') : t('profile.notConfigured')}
                  </Text>
                </TouchableOpacity>
              )}
              {badge && (
                <View style={[s.badge, { backgroundColor: colors.successBg || '#dcfce7' }]}>
                  <Text style={[s.badgeText, { color: colors.success || '#16a34a' }]}>{badge}</Text>
                </View>
              )}
            </View>
          )}
        </View>
        {!isEditing && value && field && (
          <TouchableOpacity onPress={() => startEdit(field, value)} style={s.editIconBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={[s.editPencil, { color: colors.primary }]}>{t('profile.edit')}</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  // Read-only info row
  const InfoRow = ({ icon: IconComp, iconColor, label, value, badge }) => (
    <View style={[s.infoRow, { borderBottomColor: colors.borderLight + '40' }]}>
      <View style={[s.infoIconWrap, { backgroundColor: (iconColor || colors.primary) + '12' }]}>
        <IconComp size={18} color={iconColor || colors.primary} />
      </View>
      <View style={s.infoContent}>
        <Text style={[s.infoLabel, { color: colors.textTertiary }]}>{label}</Text>
        <View style={s.infoValueRow}>
          <Text style={[s.infoValue, { color: colors.text }]}>{value || t('profile.notConfigured')}</Text>
          {badge && (
            <View style={[s.badge, { backgroundColor: colors.successBg || '#dcfce7' }]}>
              <Text style={[s.badgeText, { color: colors.success || '#16a34a' }]}>{badge}</Text>
            </View>
          )}
        </View>
      </View>
    </View>
  );

  // Tab content renderer
  const renderTabContent = () => {
    if (activeTab === TAB_GRID) {
      if (postsLoading && userPosts.length === 0) {
        return <View style={s.tabLoading}><ActivityIndicator size="large" color={colors.primary} /></View>;
      }
      if (userPosts.length === 0) {
        return (
          <EmptyTabState
            icon={IconCamera}
            title={t('profile.shareYourMoments')}
            subtitle={t('profile.startPosting')}
          />
        );
      }
      return (
        <View style={s.postsGrid}>
          {userPosts.map((post, i) => (
            <View key={post.id || i} style={{ marginRight: (i + 1) % gridCols !== 0 ? gridGap : 0, marginBottom: gridGap }}>
              <PostGridItem post={post} />
            </View>
          ))}
          {hasMorePosts && (
            <TouchableOpacity
              onPress={() => loadUserPosts(postsPage + 1)}
              style={[s.loadMoreBtn, { borderColor: colors.borderLight }]}
              disabled={postsLoading}
            >
              {postsLoading ? <ActivityIndicator size="small" color={colors.primary} /> : (
                <Text style={[s.loadMoreText, { color: colors.primary }]}>Load more</Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      );
    }

    if (activeTab === TAB_REELS) {
      if (videoPosts.length === 0) {
        return <EmptyTabState icon={IconPlay} title={t('profile.noReelsYet')} />;
      }
      return (
        <View style={s.postsGrid}>
          {videoPosts.map((post, i) => (
            <View key={post.id || i} style={{ marginRight: (i + 1) % gridCols !== 0 ? gridGap : 0, marginBottom: gridGap }}>
              <PostGridItem post={post} />
            </View>
          ))}
        </View>
      );
    }

    if (activeTab === TAB_TAGGED) {
      return <EmptyTabState icon={IconTag} title={t('profile.noTaggedPostsYet')} />;
    }

    // Account tab - shows the original profile settings
    if (activeTab === TAB_ACCOUNT) {
      return renderAccountSection();
    }

    return null;
  };

  // Account section (original profile info/security/sessions)
  const renderAccountSection = () => (
    <View style={s.accountSection}>
      {!!saveMsg && (
        <View style={[s.saveMsgWrap, { backgroundColor: saveMsg === t('profile.saved') ? (colors.successBg || '#dcfce7') : (colors.errorBg || '#fef2f2') }]}>
          <Text style={[s.saveMsgText, { color: saveMsg === t('profile.saved') ? (colors.success || '#16a34a') : (colors.error || '#dc2626') }]}>{saveMsg}</Text>
        </View>
      )}

      {/* Personal Info section */}
      <View style={[s.section, { backgroundColor: colors.surface + 'F0', borderColor: colors.borderLight + '40' }]}>
        <View style={s.sectionHeader}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>{t('profile.personalInfo')}</Text>
        </View>

        <InfoRow icon={IconMail} iconColor="#ea4335" label={t('profile.email')} value={user?.email} />

        <TouchableOpacity
          style={[s.infoRow, { borderBottomColor: colors.borderLight + '40' }]}
          onPress={() => {
            setUsernameInput(profile?.username || '');
            setUsernameAvailable(null);
            setUsernameError('');
            setShowUsernameModal(true);
          }}
          accessibilityRole="button"
          accessibilityLabel={t('profile.username') || 'Username'}
        >
          <View style={[s.infoIconWrap, { backgroundColor: '#25D366' + '12' }]}>
            <Text style={{ color: '#25D366', fontSize: 18, fontWeight: '700' }}>@</Text>
          </View>
          <View style={s.infoContent}>
            <Text style={[s.infoLabel, { color: colors.textSecondary }]}>
              {t('profile.username') || 'Username'}
            </Text>
            <Text style={[s.infoValue, { color: profile?.username ? colors.text : colors.textTertiary }]}>
              {profile?.username ? '@' + profile.username : (t('profile.usernameAdd') || 'Adicionar username')}
            </Text>
          </View>
          <IconChevronRight size={18} color={colors.textTertiary} />
        </TouchableOpacity>

        <EditableInfoRow
          icon={IconUser}
          iconColor="#4285f4"
          label={t('profile.name')}
          value={displayName}
          field="name"
          placeholder={t('profile.namePlaceholder')}
        />

        <EditableInfoRow
          icon={IconPhone}
          iconColor="#34a853"
          label={t('profile.phone')}
          value={profile?.phone}
          field="phone"
          badge={profile?.phone_verified ? t('profile.verified') : null}
          keyboardType="phone-pad"
          placeholder={t('profile.phonePlaceholder')}
        />

        {/* Telnyx Verified Caller ID — so PSTN call recipients see the user's real number */}
        {true && (
          <TouchableOpacity
            style={[s.infoRow, { borderBottomColor: colors.borderLight + '40' }]}
            onPress={() => {
              setShowCallerIdModal(true);
              setCallerIdStep(profile?.telnyx_caller_id_verified ? 'done' : 'request');
              setCallerIdCode('');
              setCallerIdError('');
            }}
            accessibilityRole="button"
          >
            <View style={[s.infoIconWrap, { backgroundColor: '#1DAA61' + '14' }]}>
              <Text style={{ fontSize: 18 }}>📞</Text>
            </View>
            <View style={s.infoContent}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={[s.infoLabel, { color: colors.textSecondary }]}>
                  {t('profile.callerId') || 'CALLER ID'}
                </Text>
                {profile?.telnyx_caller_id_verified && (
                  <View style={{
                    width: 14, height: 14, borderRadius: 7, backgroundColor: '#1DAA61',
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Text style={{ color: '#fff', fontSize: 9, fontWeight: '900' }}>✓</Text>
                  </View>
                )}
              </View>
              <Text style={[s.infoValue, { color: colors.text }]}>
                {profile?.telnyx_caller_id_verified
                  ? (t('profile.callerIdVerified') || 'Seu número aparece nas ligações')
                  : (t('profile.callerIdNotVerified') || 'Verificar para mostrar seu número')}
              </Text>
            </View>
            <IconChevronRight size={18} color={colors.textTertiary} />
          </TouchableOpacity>
        )}

        <EditableInfoRow
          icon={IconCake}
          iconColor="#fbbc04"
          label={t('profile.birthday')}
          value={profile?.birthday}
          displayValue={formattedBirthday ? (age !== null ? `${formattedBirthday} (${age} ${t('profile.yearsOld')})` : formattedBirthday) : null}
          field="birthday"
          placeholder={t('profile.birthdayPlaceholder')}
        />

        <EditableInfoRow
          icon={IconMail}
          iconColor="#ea4335"
          label={t('profile.recoveryEmail')}
          value={profile?.recovery_email}
          field="recovery"
          keyboardType="email-address"
          placeholder="email@gmail.com"
        />

        {profile?.created_at && (
          <InfoRow
            icon={IconCalendar}
            iconColor="#9333ea"
            label={t('profile.createdAt')}
            value={profile?.created_at_formatted || (profile?.created_at ? new Date(profile.created_at).toLocaleDateString() : null)}
          />
        )}
      </View>

      {/* Security section */}
      <View style={[s.section, { backgroundColor: colors.surface + 'F0', borderColor: colors.borderLight + '40' }]}>
        <Text style={[s.sectionTitle, { color: colors.text }]}>{t('profile.security')}</Text>

        <TouchableOpacity style={[s.actionRow, { borderBottomColor: colors.borderLight + '40' }]} onPress={() => setShowChangePassword(true)} accessibilityRole="button">
          <View style={[s.actionIconWrap, { backgroundColor: '#4285f4' + '12' }]}>
            <IconLock size={18} color="#4285f4" />
          </View>
          <Text style={[s.actionText, { color: colors.text }]}>{t('profile.changePassword')}</Text>
          <IconChevronRight size={18} color={colors.textTertiary} />
        </TouchableOpacity>

        <TouchableOpacity style={[s.actionRow, { borderBottomColor: colors.borderLight + '40' }]} onPress={() => setShowTwoFactor(true)} accessibilityRole="button">
          <View style={[s.actionIconWrap, { backgroundColor: '#8b5cf6' + '12' }]}>
            <IconShield size={18} color="#8b5cf6" />
          </View>
          <Text style={[s.actionText, { color: colors.text }]}>{t('profile.twoFactor')}</Text>
          <IconChevronRight size={18} color={colors.textTertiary} />
        </TouchableOpacity>

        <TouchableOpacity style={[s.actionRow, { borderBottomColor: colors.borderLight + '40' }]} onPress={() => safeAlert(t('profile.verifyPhoneTitle'), t('profile.verifyPhoneMessage'))} accessibilityRole="button">
          <View style={[s.actionIconWrap, { backgroundColor: '#34a853' + '12' }]}>
            <IconPhone size={18} color="#34a853" />
          </View>
          <Text style={[s.actionText, { color: colors.text }]}>{t('profile.verifyPhone')}</Text>
          <IconChevronRight size={18} color={colors.textTertiary} />
        </TouchableOpacity>
      </View>

      {/* Sessions / Your Devices */}
      <View style={[s.section, { backgroundColor: colors.surface + 'F0', borderColor: colors.borderLight + '40' }]}>
        <TouchableOpacity
          style={s.sectionHeaderTouchable}
          onPress={async () => {
            if (!showSessions) {
              await loadSessions();
            }
            setShowSessions(!showSessions);
          }}
          accessibilityRole="button"
        >
          <View style={s.sectionHeaderLeft}>
            <View style={[s.actionIconWrap, { backgroundColor: '#f59e0b' + '12' }]}>
              <IconMonitor size={18} color="#f59e0b" />
            </View>
            <Text style={[s.sectionTitle, { color: colors.text }]}>{t('profile.yourDevices')}</Text>
          </View>
          <View style={{ transform: [{ rotate: showSessions ? '90deg' : '0deg' }] }}>
            <IconChevronRight size={18} color={colors.textTertiary} />
          </View>
        </TouchableOpacity>

        {showSessions && (
          <View style={s.sessionsContainer}>
            {loadingSessions ? (
              <View style={s.sessionsLoading}>
                <ActivityIndicator size="small" color={colors.primary} />
              </View>
            ) : sessions.length === 0 ? (
              <Text style={[s.noSessions, { color: colors.textTertiary }]}>{t('profile.noOtherSessions')}</Text>
            ) : (
              <>
                {sessions.map((sess, i) => {
                  const device = parseUserAgent(sess.user_agent);
                  const lastActive = relativeTime(sess.last_active, t);
                  const isRevoking = revokingSession === sess.token_hash;

                  return (
                    <View key={sess.token_hash || i} style={[s.sessionCard, {
                      backgroundColor: sess.is_current ? (colors.primary + '08') : colors.background,
                      borderColor: sess.is_current ? (colors.primary + '30') : (colors.borderLight + '40'),
                    }]}>
                      <View style={s.sessionMain}>
                        <View style={[s.deviceIconWrap, {
                          backgroundColor: sess.is_current ? (colors.primary + '15') : (colors.textTertiary + '10'),
                        }]}>
                          <DeviceIcon type={device.type} size={20} color={sess.is_current ? colors.primary : colors.textSecondary} />
                        </View>
                        <View style={s.sessionInfo}>
                          <View style={s.sessionNameRow}>
                            <Text style={[s.sessionDeviceName, { color: colors.text }]} numberOfLines={1}>
                              {device.name}
                            </Text>
                            {sess.is_current && (
                              <View style={[s.currentBadge, { backgroundColor: colors.success || '#22c55e' }]}>
                                <View style={s.currentDot} />
                                <Text style={s.currentBadgeText}>{t('profile.currentSession')}</Text>
                              </View>
                            )}
                          </View>
                          <Text style={[s.sessionDetail, { color: colors.textTertiary }]}>
                            {sess.ip || '?'} {lastActive ? ` \u00B7 ${lastActive}` : ''}
                          </Text>
                        </View>
                        {!sess.is_current && (
                          <TouchableOpacity
                            onPress={() => handleRevokeSession(sess.token_hash)}
                            disabled={isRevoking}
                            style={[s.revokeBtn, { borderColor: '#ef4444' + '40' }]}
                            accessibilityLabel="Sign out session"
                            accessibilityRole="button"
                          >
                            {isRevoking ? (
                              <ActivityIndicator size="small" color="#ef4444" />
                            ) : (
                              <IconLogout size={16} color="#ef4444" />
                            )}
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  );
                })}

                {sessions.filter(s => !s.is_current).length > 0 && (
                  <TouchableOpacity
                    onPress={handleRevokeAllSessions}
                    disabled={revokingAll}
                    style={[s.signOutAllBtn, { borderColor: '#ef4444' + '30' }]}
                    accessibilityLabel="Sign out all other devices"
                    accessibilityRole="button"
                  >
                    {revokingAll ? (
                      <ActivityIndicator size="small" color="#ef4444" />
                    ) : (
                      <>
                        <IconLogout size={16} color="#ef4444" />
                        <Text style={s.signOutAllText}>{t('profile.signOutAll')}</Text>
                      </>
                    )}
                  </TouchableOpacity>
                )}
              </>
            )}
          </View>
        )}
      </View>

      {/* Vacation responder */}
      <View style={[s.section, { backgroundColor: colors.surface + 'F0', borderColor: colors.borderLight + '40' }]}>
        <Text style={[s.sectionTitle, { color: colors.text }]}>{t('profile.autoReply')}</Text>
        <TouchableOpacity style={[s.actionRow, { borderBottomColor: colors.borderLight + '40' }]} onPress={() => setShowVacation(true)} accessibilityRole="button">
          <View style={[s.actionIconWrap, { backgroundColor: '#f59e0b' + '12' }]}>
            <IconClock size={18} color="#f59e0b" />
          </View>
          <Text style={[s.actionText, { color: colors.text }]}>{t('profile.vacationResponse')}</Text>
          <IconChevronRight size={18} color={colors.textTertiary} />
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <View style={[s.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Instagram-style header bar */}
      <View style={[s.header, { backgroundColor: colors.background, borderBottomColor: colors.borderLight + '30' }]}>
        <TouchableOpacity onPress={() => router.back()} style={s.headerBackBtn} accessibilityLabel="Back" accessibilityRole="button">
          <IconArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={s.headerUsernameWrap}>
          <Text style={[s.headerUsername, { color: colors.text }]} numberOfLines={1}>
            {displayName || user?.email?.split('@')[0] || t('profile.user')}
          </Text>
        </View>
        <TouchableOpacity onPress={() => { setActiveTab(TAB_ACCOUNT); }} style={s.headerMenuBtn} accessibilityLabel="Settings" accessibilityRole="button">
          <IconSettings size={24} color={colors.text} />
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
      <Animated.ScrollView ref={scrollViewRef} contentContainerStyle={s.scrollContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ opacity: fadeAnim }}>
        <View style={s.scrollInner}>

        {/* ========== INSTAGRAM PROFILE HEADER ========== */}
        <View style={s.profileHeaderSection}>
          {/* Row: Avatar + Stats */}
          <View style={s.profileTopRow}>
            {/* Avatar with camera overlay */}
            <TouchableOpacity onPress={handleAvatarUpload} style={s.avatarContainer} activeOpacity={0.7} accessibilityLabel={t('profile.changePhoto')} accessibilityRole="button">
              <Animated.View style={[s.avatarOuter, { transform: [{ scale: avatarScale }] }]}>
                <View style={[s.avatarGradientRing, Platform.select({
                  web: { background: `linear-gradient(135deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888)` },
                  default: { backgroundColor: '#dc2743' },
                })]}>
                  <View style={[s.avatarInnerRing, { backgroundColor: colors.background }]}>
                    {avatarUrl ? (
                      Platform.OS === 'web' ? (
                        <img src={avatarUrl} style={{ width: 82, height: 82, borderRadius: 41, objectFit: 'cover' }} alt="avatar" />
                      ) : (
                        <Image source={{ uri: avatarUrl }} style={{ width: 82, height: 82, borderRadius: 41 }} />
                      )
                    ) : (
                      <View style={[s.avatarFallback, { backgroundColor: avatarColor }]}>
                        <Text style={s.avatarFallbackText}>{(user?.name || user?.email || '?')[0].toUpperCase()}</Text>
                      </View>
                    )}
                  </View>
                </View>
              </Animated.View>
              {/* Camera badge */}
              <View style={[s.cameraBadge, { backgroundColor: colors.primary, borderColor: colors.background }]}>
                {uploadingAvatar
                  ? <ActivityIndicator size={10} color="#fff" />
                  : <IconCamera size={12} color="#fff" />
                }
              </View>
            </TouchableOpacity>

            {/* Stats: Posts, Followers, Following */}
            <View style={s.statsRow}>
              <StatColumn count={postsCount} label={t('profile.posts')} />
              <StatColumn count={followersCount} label={t('profile.followers')} />
              <StatColumn count={followingCount} label={t('profile.following')} />
            </View>
          </View>

          {/* Name + Category */}
          <View style={s.nameSection}>
            <Text style={[s.profileDisplayName, { color: colors.text }]}>
              {displayName || t('profile.user')}
            </Text>
            {category ? (
              <Text style={[s.categoryLabel, { color: colors.textTertiary }]}>{category}</Text>
            ) : null}
          </View>

          {/* Bio */}
          {bio ? (
            <Text style={[s.bioText, { color: colors.text }]}>{bio}</Text>
          ) : null}

          {/* Website */}
          {website ? (
            <TouchableOpacity onPress={() => {
              const url = website.startsWith('http') ? website : `https://${website}`;
              Linking.openURL(url).catch(() => {});
            }}>
              <Text style={[s.websiteLink, { color: '#00376b' }]} numberOfLines={1}>
                {website.replace(/^https?:\/\//, '')}
              </Text>
            </TouchableOpacity>
          ) : null}

          {/* Edit Profile / Share Profile buttons */}
          <View style={s.actionButtonsRow}>
            <TouchableOpacity
              style={[s.actionButton, { backgroundColor: isDark ? '#363636' : '#efefef' }]}
              onPress={() => setActiveTab(TAB_ACCOUNT)}
              activeOpacity={0.7}
            >
              <Text style={[s.actionButtonText, { color: colors.text }]}>{t('profile.editProfile')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.actionButton, { backgroundColor: isDark ? '#363636' : '#efefef' }]}
              onPress={handleShareProfile}
              activeOpacity={0.7}
            >
              <Text style={[s.actionButtonText, { color: colors.text }]}>{t('profile.shareProfile')}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* ========== HIGHLIGHTS ROW ========== */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.highlightsRow}
          style={[s.highlightsContainer, { borderBottomColor: colors.borderLight + '20' }]}
        >
          <HighlightCircle isAdd />
          {highlights.map((hl, i) => (
            <HighlightCircle key={hl.id || i} item={hl} />
          ))}
        </ScrollView>

        {/* ========== TAB BAR ========== */}
        <View style={[s.tabBar, { borderBottomColor: colors.borderLight + '30' }]}>
          <TouchableOpacity
            style={s.tabItem}
            onPress={() => { setActiveTab(TAB_GRID); animateTabIndicator(0); }}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === TAB_GRID }}
          >
            <IconGrid size={24} color={activeTab === TAB_GRID ? colors.text : colors.textTertiary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={s.tabItem}
            onPress={() => { setActiveTab(TAB_REELS); animateTabIndicator(1); }}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === TAB_REELS }}
          >
            <IconPlay size={24} color={activeTab === TAB_REELS ? colors.text : colors.textTertiary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={s.tabItem}
            onPress={() => { setActiveTab(TAB_TAGGED); animateTabIndicator(2); }}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === TAB_TAGGED }}
          >
            <IconTag size={24} color={activeTab === TAB_TAGGED ? colors.text : colors.textTertiary} />
          </TouchableOpacity>

          {/* Animated tab indicator */}
          <Animated.View style={[s.tabIndicator, {
            backgroundColor: colors.text,
            width: contentWidth / 3,
            left: tabIndicatorLeft,
          }]} />
        </View>

        {/* ========== TAB CONTENT ========== */}
        {renderTabContent()}

        <View style={{ height: 40 }} />
        </View>
      </Animated.ScrollView>
      </KeyboardAvoidingView>

      <ChangePasswordModal visible={showChangePassword} onClose={() => setShowChangePassword(false)} />
      <TwoFactorSetup visible={showTwoFactor} onClose={() => setShowTwoFactor(false)} />
      <VacationResponder visible={showVacation} onClose={() => setShowVacation(false)} />

      {/* Telnyx Caller ID verification modal */}
      <Modal visible={showCallerIdModal} animationType="slide" transparent onRequestClose={() => setShowCallerIdModal(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 20 }}>
          <View style={{ backgroundColor: colors.surface, borderRadius: 18, padding: 22 }}>
            <View style={{ alignItems: 'center', marginBottom: 14 }}>
              <View style={{
                width: 64, height: 64, borderRadius: 32,
                backgroundColor: profile?.telnyx_caller_id_verified ? '#1DAA61' : '#1DAA61' + '18',
                alignItems: 'center', justifyContent: 'center', marginBottom: 10,
              }}>
                <Text style={{ fontSize: 32 }}>{profile?.telnyx_caller_id_verified ? '✓' : '📞'}</Text>
              </View>
              <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>
                {t('profile.callerIdTitle') || 'Verificar caller ID'}
              </Text>
            </View>

            {callerIdStep === 'done' || profile?.telnyx_caller_id_verified ? (
              <>
                <Text style={{ fontSize: 14, color: colors.textSecondary, lineHeight: 20, textAlign: 'center', marginBottom: 22 }}>
                  {t('profile.callerIdDoneMsg') || 'Seu número'} <Text style={{ color: colors.text, fontWeight: '700' }}>{profile?.verified_phone || profile?.phone}</Text>{' '}
                  {t('profile.callerIdDoneMsg2') || 'aparece pra quem recebe ligações suas pelo Chatyy.'}
                </Text>
                <TouchableOpacity
                  onPress={() => setShowCallerIdModal(false)}
                  style={{ height: 46, borderRadius: 10, backgroundColor: '#1DAA61', alignItems: 'center', justifyContent: 'center' }}
                >
                  <Text style={{ color: '#fff', fontWeight: '700' }}>OK</Text>
                </TouchableOpacity>
              </>
            ) : callerIdStep === 'request' ? (
              <>
                <Text style={{ fontSize: 13, color: colors.textSecondary, lineHeight: 19, marginBottom: 18, textAlign: 'center' }}>
                  {t('profile.callerIdReqMsg') || 'Vamos enviar um SMS para'}{' '}
                  <Text style={{ color: colors.text, fontWeight: '700' }}>{profile?.verified_phone || profile?.phone}</Text>{'.\n'}
                  {t('profile.callerIdReqMsg2') || 'Digite o código de 6 dígitos do Telnyx para confirmar que esse número é seu.'}
                </Text>
                {!!callerIdError && <Text style={{ color: '#ef4444', fontSize: 12, marginBottom: 10, textAlign: 'center' }}>{callerIdError}</Text>}
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <TouchableOpacity
                    onPress={() => setShowCallerIdModal(false)}
                    style={{ flex: 1, height: 46, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border }}
                  >
                    <Text style={{ color: colors.text, fontWeight: '600' }}>{t('common.cancel') || 'Cancelar'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    disabled={callerIdLoading}
                    onPress={async () => {
                      setCallerIdLoading(true);
                      setCallerIdError('');
                      try {
                        const r = await api.voipVerifiedNumberRequest();
                        if (r?.success) {
                          if (r.data?.already_verified) {
                            setProfile(p => ({ ...(p || {}), telnyx_caller_id_verified: true }));
                            setCallerIdStep('done');
                          } else {
                            setCallerIdStep('code');
                          }
                        } else {
                          setCallerIdError(r?.message || 'Erro');
                        }
                      } catch (e) {
                        setCallerIdError(String(e?.message || e));
                      } finally {
                        setCallerIdLoading(false);
                      }
                    }}
                    style={{ flex: 1, height: 46, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1DAA61', opacity: callerIdLoading ? 0.6 : 1 }}
                  >
                    {callerIdLoading
                      ? <ActivityIndicator color="#fff" />
                      : <Text style={{ color: '#fff', fontWeight: '700' }}>{t('profile.callerIdSendSms') || 'Enviar SMS'}</Text>}
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              <>
                <Text style={{ fontSize: 13, color: colors.textSecondary, lineHeight: 19, marginBottom: 14, textAlign: 'center' }}>
                  {t('profile.callerIdCodeMsg') || 'Digite o código de 6 dígitos que você recebeu por SMS do Telnyx.'}
                </Text>
                <TextInput
                  value={callerIdCode}
                  onChangeText={(v) => { setCallerIdCode(v.replace(/[^0-9]/g, '').slice(0, 8)); setCallerIdError(''); }}
                  placeholder="123456"
                  placeholderTextColor={colors.textTertiary}
                  keyboardType="number-pad"
                  autoFocus
                  style={{
                    borderWidth: 1, borderColor: colors.border, borderRadius: 10,
                    paddingHorizontal: 14, height: 54, fontSize: 22, color: colors.text,
                    backgroundColor: colors.background, textAlign: 'center', letterSpacing: 4, fontWeight: '700',
                  }}
                />
                {!!callerIdError && <Text style={{ color: '#ef4444', fontSize: 12, marginTop: 8, textAlign: 'center' }}>{callerIdError}</Text>}
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
                  <TouchableOpacity
                    onPress={() => setCallerIdStep('request')}
                    style={{ flex: 1, height: 46, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border }}
                  >
                    <Text style={{ color: colors.text, fontWeight: '600' }}>{t('common.back') || 'Voltar'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    disabled={callerIdLoading || callerIdCode.length < 4}
                    onPress={async () => {
                      setCallerIdLoading(true);
                      setCallerIdError('');
                      try {
                        const r = await api.voipVerifiedNumberConfirm(callerIdCode);
                        if (r?.success) {
                          setProfile(p => ({ ...(p || {}), telnyx_caller_id_verified: true }));
                          setCallerIdStep('done');
                        } else {
                          setCallerIdError(r?.message || 'Código incorreto');
                        }
                      } catch (e) {
                        setCallerIdError(String(e?.message || e));
                      } finally {
                        setCallerIdLoading(false);
                      }
                    }}
                    style={{
                      flex: 1, height: 46, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
                      backgroundColor: callerIdCode.length < 4 ? colors.border : '#1DAA61',
                      opacity: callerIdLoading ? 0.6 : 1,
                    }}
                  >
                    {callerIdLoading
                      ? <ActivityIndicator color="#fff" />
                      : <Text style={{ color: '#fff', fontWeight: '700' }}>{t('common.confirm') || 'Confirmar'}</Text>}
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* Username @ handle modal */}
      <Modal visible={showUsernameModal} animationType="slide" transparent onRequestClose={() => setShowUsernameModal(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 20 }}>
          <View style={{ backgroundColor: colors.surface, borderRadius: 18, padding: 22 }}>
            <Text style={{ fontSize: 19, fontWeight: '700', color: colors.text, marginBottom: 6 }}>
              {t('profile.usernameTitle') || 'Seu username'}
            </Text>
            <Text style={{ fontSize: 13, color: colors.textSecondary, marginBottom: 18, lineHeight: 19 }}>
              {t('profile.usernameSubtitle') || 'Pessoas podem te encontrar por @username sem precisar do seu telefone. 4-32 caracteres: letras, números e _.'}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: usernameAvailable === false ? '#ef4444' : usernameAvailable === true ? '#22c55e' : colors.border, borderRadius: 10, paddingHorizontal: 12, height: 50, backgroundColor: colors.background }}>
              <Text style={{ fontSize: 17, color: colors.textSecondary, fontWeight: '600' }}>@</Text>
              <TextInput
                value={usernameInput}
                onChangeText={(v) => {
                  const cleaned = v.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32);
                  setUsernameInput(cleaned);
                  setUsernameAvailable(null);
                  setUsernameError('');
                }}
                onBlur={async () => {
                  if (!usernameInput || usernameInput.length < 4) {
                    if (usernameInput.length > 0) setUsernameError(t('profile.usernameTooShort') || 'Mínimo 4 caracteres');
                    return;
                  }
                  if (usernameInput === profile?.username) {
                    setUsernameAvailable(true);
                    return;
                  }
                  setUsernameChecking(true);
                  try {
                    const r = await api.chatUsernameCheck(usernameInput);
                    if (r.success) {
                      setUsernameAvailable(!!r.data?.available);
                      if (!r.data?.available) {
                        setUsernameError(r.data?.reason === 'reserved' ? (t('profile.usernameReserved') || 'Reservado') : (t('profile.usernameTaken') || 'Já em uso'));
                      }
                    } else {
                      setUsernameError(r.message || 'Erro');
                    }
                  } catch (e) {
                    setUsernameError(String(e?.message || e));
                  } finally {
                    setUsernameChecking(false);
                  }
                }}
                placeholder="meu_username"
                placeholderTextColor={colors.textTertiary}
                autoCapitalize="none"
                autoCorrect={false}
                style={{ flex: 1, fontSize: 17, color: colors.text, marginLeft: 4, paddingVertical: 0 }}
              />
              {usernameChecking && <ActivityIndicator size="small" color={colors.primary} />}
              {!usernameChecking && usernameAvailable === true && (
                <Text style={{ color: '#22c55e', fontWeight: '700' }}>✓</Text>
              )}
            </View>
            {!!usernameError && (
              <Text style={{ color: '#ef4444', fontSize: 12, marginTop: 8 }}>{usernameError}</Text>
            )}
            {profile?.username && usernameInput === profile.username && (
              <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 10 }}>
                {t('profile.usernamePublicLink') || 'Link público'}: chatyy.com.br/@{profile.username}
              </Text>
            )}
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 22 }}>
              <TouchableOpacity
                onPress={() => setShowUsernameModal(false)}
                style={{ flex: 1, height: 46, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border }}
                accessibilityRole="button"
              >
                <Text style={{ color: colors.text, fontWeight: '600' }}>{t('common.cancel') || 'Cancelar'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                disabled={usernameSaving || usernameInput.length < 4 || usernameAvailable === false || usernameInput === profile?.username}
                onPress={async () => {
                  setUsernameSaving(true);
                  setUsernameError('');
                  try {
                    const r = await api.chatUsernameClaim(usernameInput);
                    if (r.success) {
                      setProfile(p => ({ ...(p || {}), username: usernameInput }));
                      setShowUsernameModal(false);
                    } else {
                      setUsernameError(r.message || 'Erro ao salvar');
                    }
                  } catch (e) {
                    setUsernameError(String(e?.message || e));
                  } finally {
                    setUsernameSaving(false);
                  }
                }}
                style={{
                  flex: 1, height: 46, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
                  backgroundColor: (usernameInput.length < 4 || usernameAvailable === false || usernameInput === profile?.username) ? colors.border : '#25D366',
                  opacity: usernameSaving ? 0.6 : 1,
                }}
                accessibilityRole="button"
              >
                {usernameSaving ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={{ color: '#fff', fontWeight: '700' }}>{t('common.save') || 'Salvar'}</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },

  // Header bar (Instagram-style)
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBackBtn: {
    padding: Spacing.xs,
    marginRight: Spacing.sm,
  },
  headerUsernameWrap: {
    flex: 1,
  },
  headerUsername: {
    fontSize: FontSize.xxl,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  headerMenuBtn: {
    padding: Spacing.xs,
    marginLeft: Spacing.sm,
  },

  // Scroll
  scrollContent: {
    maxWidth: 600,
    alignSelf: 'center',
    width: '100%',
  },
  scrollInner: {
    width: '100%',
  },

  // Instagram profile header
  profileHeaderSection: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
  },
  profileTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.md,
  },

  // Avatar
  avatarContainer: {
    position: 'relative',
    marginRight: Spacing.xxl,
  },
  avatarOuter: {},
  avatarGradientRing: {
    width: 90,
    height: 90,
    borderRadius: 45,
    padding: 3,
  },
  avatarInnerRing: {
    width: 84,
    height: 84,
    borderRadius: 42,
    padding: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarFallback: {
    width: 82,
    height: 82,
    borderRadius: 41,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarFallbackText: {
    color: '#fff',
    fontSize: 32,
    fontWeight: '700',
  },
  cameraBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.2, shadowRadius: 2 },
      android: { elevation: 3 },
      web: { boxShadow: '0 1px 4px rgba(0,0,0,0.2)' },
    }),
  },

  // Stats row
  statsRow: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  statCol: {
    alignItems: 'center',
    minWidth: 55,
  },
  statNumber: {
    fontSize: FontSize.xl + 2,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  statLabel: {
    fontSize: FontSize.sm,
    fontWeight: '400',
    marginTop: 1,
  },

  // Name / Category / Bio / Website
  nameSection: {
    marginBottom: 2,
  },
  profileDisplayName: {
    fontSize: FontSize.base,
    fontWeight: '700',
    letterSpacing: -0.1,
  },
  categoryLabel: {
    fontSize: FontSize.sm,
    fontWeight: '400',
    marginTop: 1,
  },
  bioText: {
    fontSize: FontSize.base,
    lineHeight: 20,
    marginTop: 4,
  },
  websiteLink: {
    fontSize: FontSize.base,
    fontWeight: '600',
    marginTop: 2,
  },

  // Action buttons (Edit Profile / Share Profile)
  actionButtonsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: Spacing.md,
    marginBottom: Spacing.sm,
  },
  actionButton: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionButtonText: {
    fontSize: FontSize.base,
    fontWeight: '600',
  },

  // Highlights row
  highlightsContainer: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  highlightsRow: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    gap: Spacing.lg,
  },
  highlightItem: {
    alignItems: 'center',
    width: 68,
  },
  highlightRing: {
    width: 68,
    height: 68,
    borderRadius: 34,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  highlightAdd: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: 'center',
    justifyContent: 'center',
  },
  highlightPlaceholder: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: 'center',
    justifyContent: 'center',
  },
  highlightLabel: {
    fontSize: FontSize.xs,
    textAlign: 'center',
  },

  // Tab bar
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    position: 'relative',
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.md,
  },
  tabIndicator: {
    position: 'absolute',
    bottom: 0,
    height: 1.5,
  },

  // Tab content
  tabLoading: {
    padding: Spacing.xxxl * 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  postsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  gridItem: {
    overflow: 'hidden',
    position: 'relative',
  },
  gridItemPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridOverlayIcon: {
    position: 'absolute',
    top: 8,
    right: 8,
  },
  carouselIcon: {
    width: 18,
    height: 18,
    position: 'relative',
  },
  carouselSquare: {
    width: 12,
    height: 12,
    borderRadius: 2,
    borderWidth: 1.5,
    position: 'absolute',
    bottom: 0,
    left: 0,
  },
  carouselSquareBack: {
    bottom: 3,
    left: 3,
    opacity: 0.7,
  },

  // Empty tab state
  emptyTab: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.xxxl * 2,
    paddingHorizontal: Spacing.xl,
  },
  emptyIconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.lg,
  },
  emptyTitle: {
    fontSize: FontSize.xxl + 4,
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: -0.3,
    marginBottom: Spacing.sm,
  },
  emptySubtitle: {
    fontSize: FontSize.base,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 280,
  },

  // Load more button
  loadMoreBtn: {
    width: '100%',
    paddingVertical: Spacing.md,
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: Spacing.sm,
  },
  loadMoreText: {
    fontSize: FontSize.base,
    fontWeight: '600',
  },

  // Account section (below grid tabs)
  accountSection: {
    padding: Spacing.lg,
  },

  // Save message banner
  saveMsgWrap: {
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm,
    borderRadius: 12, marginBottom: Spacing.md,
  },
  saveMsgText: { fontSize: FontSize.sm, fontWeight: '600', textAlign: 'center' },

  // Section card
  section: {
    borderRadius: 20, padding: Spacing.lg, marginBottom: Spacing.lg, borderWidth: 1,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 12 },
      android: { elevation: 2 },
      web: { boxShadow: '0 2px 12px rgba(0,0,0,0.04)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)' },
    }),
  },
  sectionHeader: { marginBottom: Spacing.md },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: '700', letterSpacing: -0.2 },
  sectionHeaderTouchable: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: Spacing.xs,
  },
  sectionHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },

  // Info row
  infoRow: {
    flexDirection: 'row', alignItems: 'flex-start',
    paddingVertical: Spacing.md, borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 56,
  },
  infoIconWrap: {
    marginRight: Spacing.md, width: 36, height: 36, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center', marginTop: 2,
  },
  infoContent: { flex: 1 },
  infoLabel: { fontSize: FontSize.xs, fontWeight: '600', letterSpacing: 0.3, textTransform: 'uppercase', opacity: 0.6 },
  infoValueRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4, flexWrap: 'wrap', gap: 6 },
  infoValue: { fontSize: FontSize.base, fontWeight: '500', lineHeight: 22 },
  addValueText: { fontSize: FontSize.base, fontWeight: '600' },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
  badgeText: { fontSize: FontSize.xs, fontWeight: '700' },

  // Edit button (right side of row)
  editIconBtn: { marginLeft: Spacing.sm, paddingVertical: Spacing.sm, paddingHorizontal: Spacing.xs },
  editPencil: { fontSize: FontSize.sm, fontWeight: '600' },

  // Inline editing
  inlineEditWrap: { marginTop: 6 },
  inlineEditInput: {
    fontSize: FontSize.base, borderWidth: 2, borderRadius: 12,
    paddingHorizontal: Spacing.md, paddingVertical: Platform.OS === 'web' ? 10 : 8,
    ...Platform.select({ web: { outlineStyle: 'none', transition: 'border-color 0.2s ease' }, default: {} }),
  },
  inlineEditActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 8 },
  inlineBtn: {
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8,
    borderWidth: 1, borderColor: 'transparent', minWidth: 70, alignItems: 'center',
  },
  inlineBtnPrimary: { borderWidth: 0 },
  inlineBtnText: { fontSize: FontSize.sm, fontWeight: '500' },

  // Action row
  actionRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: Spacing.md, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  actionIconWrap: {
    marginRight: Spacing.md, width: 36, height: 36, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  actionText: { flex: 1, fontSize: FontSize.base, fontWeight: '500' },

  // Sessions
  sessionsContainer: { marginTop: Spacing.md },
  sessionsLoading: { padding: Spacing.xl, alignItems: 'center' },
  noSessions: { padding: Spacing.lg, textAlign: 'center', fontSize: FontSize.sm },

  sessionCard: {
    borderRadius: 14, borderWidth: 1, padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  sessionMain: { flexDirection: 'row', alignItems: 'center' },
  deviceIconWrap: {
    width: 42, height: 42, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center', marginRight: Spacing.md,
  },
  sessionInfo: { flex: 1, marginRight: Spacing.sm },
  sessionNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  sessionDeviceName: { fontSize: FontSize.sm, fontWeight: '600' },
  currentBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10,
  },
  currentDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' },
  currentBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  sessionDetail: { fontSize: FontSize.xs, marginTop: 3 },

  revokeBtn: {
    width: 36, height: 36, borderRadius: 10, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },

  signOutAllBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 12, borderRadius: 12, borderWidth: 1,
    marginTop: Spacing.sm,
  },
  signOutAllText: { color: '#ef4444', fontSize: FontSize.sm, fontWeight: '600' },
});
