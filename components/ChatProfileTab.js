import { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Platform,
  TextInput, Alert, ActivityIndicator, Switch, Image as RNImage, Share, Modal, Linking, Animated,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Auto backup module (native only)
let autoBackupMod = null;
try { autoBackupMod = require('../services/autoBackup'); } catch {}
import { clearAudioCache, getAudioCacheSize, getAudioCacheCount } from '../services/audioCache';
import Svg, { Path, Circle as SvgCircle, Rect, Line, Polygon } from 'react-native-svg';
import AvatarCircle from './AvatarCircle';
import {
  IconUser, IconEdit, IconCamera, IconChevronRight, IconLock, IconArrowLeft,
  IconPhone, IconMail, IconImage, IconX, IconCheck, IconBell, IconSparkles,
  IconShield, IconGlobe, IconTranslate, IconSmartphone, IconInfo,
  IconHeart, IconMessageSquare, IconUsers, IconKey, IconTrash,
  IconEye, IconEyeOff, IconFileText, IconLogout, IconUpload, IconDownload,
  IconStar, IconMusic, IconFilm,
} from './Icons';
import { CallerIdVerifyContent } from './ChatCallsTab';

// ─── Kids Profile SVG Icons (no emojis) ───
function KidsIconShieldUser({ size = 18, color = '#8b5cf6' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <SvgCircle cx="12" cy="10" r="3" />
      <Path d="M7 20.662V19a2 2 0 012-2h6a2 2 0 012 2v1.662" />
    </Svg>
  );
}

function KidsIconSOS({ size = 24, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <Line x1="12" y1="8" x2="12" y2="12" />
      <Line x1="12" y1="16" x2="12.01" y2="16" />
    </Svg>
  );
}

function KidsIconFamily({ size = 20, color = '#8b5cf6' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <SvgCircle cx="9" cy="7" r="3" />
      <Path d="M3 21v-2a4 4 0 014-4h4a4 4 0 014 4v2" />
      <SvgCircle cx="17" cy="9" r="2" />
      <Path d="M21 21v-1.5a3 3 0 00-3-3h-1" />
    </Svg>
  );
}

function KidsIconMailPerm({ size = 18, color = '#8b5cf6' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="2" y="4" width="20" height="16" rx="2" />
      <Path d="M22 4l-10 8L2 4" />
    </Svg>
  );
}

function KidsIconTrashPerm({ size = 18, color = '#8b5cf6' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </Svg>
  );
}

function KidsIconKeyPerm({ size = 18, color = '#8b5cf6' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </Svg>
  );
}

function KidsIconMoon({ size = 18, color = '#8b5cf6' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
    </Svg>
  );
}

function KidsIconCheckCircle({ size = 14, color = '#10b981' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none">
      <Path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
    </Svg>
  );
}

function KidsIconXCircle({ size = 14, color = '#ef4444' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none">
      <Path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z" />
    </Svg>
  );
}

function KidsIconShieldProtected({ size = 20, color = '#8b5cf6' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <Path d="M9 12l2 2 4-4" />
    </Svg>
  );
}
import * as api from '../services/api';
import { emailToDisplayName } from '../services/api';
import { getCached, setCache } from '../services/cache';
import { SettingsSkeleton } from './SkeletonLoader';
import { LANGUAGES } from '../i18n';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth, isChildAccount, getChildRestrictions } from '../context/AuthContext';
import { useBiometric } from '../context/BiometricContext';

const ACCENT = '#7C3AED';

// Brand pill with press scale 0.97 (spring). Used for "Editar perfil" hero
// CTA and similar tactile buttons in the profile tab.
function PressablePill({ onPress, style, children, accessibilityLabel, disabled }) {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const handleIn = () => Animated.spring(scaleAnim, { toValue: 0.97, useNativeDriver: true, tension: 300, friction: 10 }).start();
  const handleOut = () => Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, tension: 200, friction: 12 }).start();
  return (
    <Animated.View style={{ flex: style?.flex, transform: [{ scale: scaleAnim }] }}>
      <TouchableOpacity
        onPress={onPress}
        onPressIn={handleIn}
        onPressOut={handleOut}
        activeOpacity={0.9}
        style={style}
        disabled={disabled}
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
      >
        {children}
      </TouchableOpacity>
    </Animated.View>
  );
}

// Device-type SVG (web / mobile / desktop) for the Linked Devices row
// subtitle. Stroke-style icons matching Icons.js conventions.
function IconDeviceWeb({ size = 14, color = '#7C3AED' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="2" y="3" width="20" height="14" rx="2" />
      <Line x1="8" y1="21" x2="16" y2="21" />
      <Line x1="12" y1="17" x2="12" y2="21" />
    </Svg>
  );
}
function IconDeviceMobile({ size = 14, color = '#7C3AED' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="6" y="2" width="12" height="20" rx="2" />
      <Line x1="12" y1="18" x2="12.01" y2="18" />
    </Svg>
  );
}

// ─── MMKV synchronous preload for instant first paint (anti-flicker) ───
// Read cached profile + settings at module load time so the component's very
// first render already has data on screen. Eliminates the empty-state flash
// that used to happen while we awaited getCached() asynchronously.
let _preloadedProfile = null;
let _preloadedSettings = null;
if (Platform.OS !== 'web') {
  try {
    const { getString: _gs } = require('../services/mmkv');
    const raw = _gs('chat_profile');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.profile) _preloadedProfile = parsed.profile;
      if (parsed?.settings) _preloadedSettings = parsed.settings;
    }
  } catch {}
}

// Fingerprint helper — only setState if the profile payload actually changed.
function _profileFingerprint(p) {
  if (!p) return '';
  return [
    p.name || '',
    p.about || p.recado || '',
    p.phone || p.verified_phone || '',
    p.has_avatar ? 1 : 0,
    p.telnyx_caller_id_verified ? 1 : 0,
    p._avatar_v || '',
    p.username || '',
  ].join('|');
}
function _settingsFingerprint(s) {
  if (!s) return '';
  try { return JSON.stringify(s); } catch { return ''; }
}

function safeAlert(title, message, buttons) {
  if (Platform.OS === 'web') {
    if (buttons && buttons.length > 0) {
      const cancelBtn = buttons.find(b => b.style === 'cancel');
      const actionBtn = buttons.find(b => b.style !== 'cancel') || buttons[0];
      const confirmed = window.confirm(`${title}\n\n${message || ''}`);
      if (confirmed && actionBtn?.onPress) actionBtn.onPress();
      else if (!confirmed && cancelBtn?.onPress) cancelBtn.onPress();
    } else {
      try { window.alert(message || title); } catch {}
    }
  } else {
    try { Alert.alert(title, message, buttons); } catch {}
  }
}

function getStorage(key) {
  if (Platform.OS === 'web') {
    try { return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null; } catch { return null; }
  }
  return null;
}
function setStorage(key, val) {
  if (Platform.OS === 'web') {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, val); } catch {}
  } else {
    AsyncStorage.setItem(key, val).catch(() => {});
  }
}

// Shadow helper for cross-platform
const cardShadow = (isDark) => Platform.select({
  ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: isDark ? 0.35 : 0.06, shadowRadius: 12 },
  android: { elevation: 3 },
  web: { boxShadow: isDark ? '0 2px 16px rgba(0,0,0,0.35)' : '0 2px 16px rgba(0,0,0,0.06)' },
});

const smallShadow = (isDark) => Platform.select({
  ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: isDark ? 0.2 : 0.04, shadowRadius: 6 },
  android: { elevation: 2 },
  web: { boxShadow: isDark ? '0 1px 8px rgba(0,0,0,0.2)' : '0 1px 8px rgba(0,0,0,0.04)' },
});

export default function ChatProfileTab({ colors, isDark, t, user, router }) {
  const { toggle: toggleTheme, density, setDensity } = useTheme();
  const { language, changeLanguage } = useLanguage();
  const { logout } = useAuth();
  const biometric = useBiometric();
  const biometricEnabled = biometric?.biometricEnabled;
  const biometricAvailable = biometric?.biometricAvailable;
  const toggleBiometric = biometric?.toggleBiometric;

  // Initialize from MMKV preload so the very first render already has data.
  const [profile, setProfile] = useState(() => _preloadedProfile || null);
  // Skip loading spinner if we already painted from cache
  const [loading, setLoading] = useState(() => !_preloadedProfile);
  // Instagram-style social stats (loaded async, persists across renders)
  const [igStats, setIgStats] = useState({ posts: 0, followers: 0, following: 0 });
  const [showVerifyCallerId, setShowVerifyCallerId] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editValue, setEditValue] = useState('');
  // Username (@handle) state
  const [usernameInput, setUsernameInput] = useState('');
  const [usernameStatus, setUsernameStatus] = useState(null); // null | 'checking' | 'available' | 'taken' | 'invalid' | 'error'
  const usernameCheckRef = useRef(null);
  const [savingUsername, setSavingUsername] = useState(false);
  const [saving, setSaving] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState(() => {
    if (_preloadedProfile && (_preloadedProfile.has_avatar || _preloadedProfile.avatar)) {
      try { return api.getAvatarUrl(user?.email || ''); } catch { return null; }
    }
    return null;
  });
  // Fingerprint refs for delta-sync change detection (prevents unnecessary setState)
  const lastProfileFpRef = useRef(_profileFingerprint(_preloadedProfile));
  const lastSettingsFpRef = useRef(_settingsFingerprint(_preloadedSettings));
  const [subScreen, setSubScreen] = useState(null);
  const [blockedCount, setBlockedCount] = useState(0);
  const [blockedList, setBlockedList] = useState([]);
  const [blockedLoading, setBlockedLoading] = useState(true);

  // Account sub-screen state
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [changingPw, setChangingPw] = useState(false);
  const [showPw, setShowPw] = useState(false);

  // Settings state — seed from MMKV preload when available
  const [settings, setSettings] = useState(() => ({
    notifications: true,
    notification_sound: true,
    notification_vibration: true,
    notification_groups: true,
    notification_calls: true,
    notification_tone: 'default',
    read_receipts: true,
    font_size: 'medium',
    wallpaper: 'none',
    last_seen_privacy: 'everyone',
    profile_photo_privacy: 'everyone',
    about_privacy: 'everyone',
    blocked_contacts: [],
    ...(_preloadedSettings || {}),
  }));

  // Storage stats
  const [storageStats, setStorageStats] = useState(null);
  const [storageLoading, setStorageLoading] = useState(false);

  // WhatsApp 4×3 auto-download policy matrix. Hydrated from server
  // (chat_get_user_defaults) on mount; defaults match WhatsApp factory.
  const [autoDlPolicy, setAutoDlPolicy] = useState(() => ({
    photos:    { mobile: 1, wifi: 1, roaming: 0 },
    audio:     { mobile: 1, wifi: 1, roaming: 0 },
    videos:    { mobile: 0, wifi: 1, roaming: 0 },
    documents: { mobile: 0, wifi: 1, roaming: 0 },
  }));

  // Backup state
  const [backupRunning, setBackupRunning] = useState(false);
  const [backupElapsed, setBackupElapsed] = useState(0);
  const [backupResult, setBackupResult] = useState(null); // { success: true, conversations, messages } | 'error' | null
  const backupTimerRef = useRef(null);
  const saveSettingsChainRef = useRef(Promise.resolve());

  // Restore state
  const [restoreModalVisible, setRestoreModalVisible] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [backupsList, setBackupsList] = useState([]);
  const [restoreRunning, setRestoreRunning] = useState(false);
  const [restoreResult, setRestoreResult] = useState(null); // { conversations, messages } | null

  const handleBackupNow = async () => {
    if (backupRunning) return;
    setBackupRunning(true);
    setBackupElapsed(0);
    setBackupResult(null);

    // Elapsed time counter (updates every second)
    backupTimerRef.current = setInterval(() => {
      setBackupElapsed(prev => prev + 1);
    }, 1000);

    try {
      const r = await api.chatBackupCreate();
      if (r?.success) {
        const data = r.data || r;
        setBackupResult({
          success: true,
          conversations: data.conversations || 0,
          messages: data.message_count || 0,
        });
        setTimeout(() => setBackupResult(null), 8000);
      } else {
        safeAlert(t?.('common.error') || 'Erro', r?.message || t?.('chat.backupErrorDesc') || 'Falhou');
        setBackupResult('error');
      }
    } catch (e) {
      safeAlert(t?.('common.error') || 'Erro', e?.message || t?.('chat.backupErrorDesc') || 'Erro ao fazer backup');
      setBackupResult('error');
    } finally {
      if (backupTimerRef.current) {
        clearInterval(backupTimerRef.current);
        backupTimerRef.current = null;
      }
      setBackupRunning(false);
    }
  };

  const handleRestoreOpen = async () => {
    setRestoreModalVisible(true);
    setRestoreLoading(true);
    setRestoreResult(null);
    try {
      const r = await api.chatBackupList();
      if (r.success) {
        setBackupsList(r.data?.backups || r.backups || []);
      } else {
        setBackupsList([]);
      }
    } catch {
      setBackupsList([]);
    } finally {
      setRestoreLoading(false);
    }
  };

  const handleRestoreBackup = async (backupId) => {
    safeAlert(
      t?.('chat.restoreBackupTitle') || 'Restaurar backup',
      t?.('chat.restoreBackupConfirm') || 'Tem certeza que deseja restaurar este backup? Mensagens existentes nao serao duplicadas.',
      [
        { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
        {
          text: t?.('chat.restoreBackup') || 'Restaurar',
          onPress: async () => {
            setRestoreRunning(true);
            try {
              const r = await api.chatBackupRestore(backupId);
              if (r.success) {
                const data = r.data || r;
                setRestoreResult({
                  conversations: data.restored_conversations || 0,
                  messages: data.restored_messages || 0,
                });
                safeAlert(
                  t?.('chat.restoreSuccess') || 'Restaurado!',
                  (t?.('chat.restoreSuccessMsg') || '{convs} conversas e {msgs} mensagens restauradas')
                    .replace('{convs}', data.restored_conversations || 0)
                    .replace('{msgs}', data.restored_messages || 0)
                );
              } else {
                safeAlert(t?.('common.error') || 'Erro', r.message || 'Falhou');
              }
            } catch {
              safeAlert(t?.('common.error') || 'Erro', t?.('chat.restoreError') || 'Erro ao restaurar backup');
            } finally {
              setRestoreRunning(false);
            }
          },
        },
      ]
    );
  };

  // Entrance animation
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(20)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 350, useNativeDriver: false }),
      Animated.timing(slideAnim, { toValue: 0, duration: 350, useNativeDriver: false }),
    ]).start();
  }, [fadeAnim, slideAnim]);

  // Cleanup backupTimerRef on unmount
  useEffect(() => {
    return () => {
      if (backupTimerRef.current) {
        clearInterval(backupTimerRef.current);
        backupTimerRef.current = null;
      }
    };
  }, []);

  const currentEmail = user?.email || '';
  const currentName = user?.name || currentEmail.split('@')[0];

  const loadProfile = useCallback(async () => {
    // FAST PATH: if we already have profile data painted (from MMKV preload
    // or a previous load), skip the async SQLite/getCached read entirely and
    // go straight to a silent background delta sync. No flicker, no waiting.
    let alreadyHasVisible = false;
    setProfile(prev => { alreadyHasVisible = !!prev; return prev; });

    if (!alreadyHasVisible) {
      // SLOW PATH: no data yet — try async cache for instant first paint
      try {
        const cached = await getCached('chat_profile');
        if (cached?.profile) {
          setProfile(cached.profile);
          lastProfileFpRef.current = _profileFingerprint(cached.profile);
          if (cached.profile.has_avatar || cached.profile.avatar) setAvatarUrl(api.getAvatarUrl(currentEmail));
          if (cached.settings) {
            setSettings(prev => ({ ...prev, ...cached.settings }));
            lastSettingsFpRef.current = _settingsFingerprint({ ...(cached.settings || {}) });
          }
        }
      } catch {}
    }

    // Silent background delta sync — only setState if payload actually changed
    try {
      const [profileR, settingsR] = await Promise.all([
        api.getProfile(),
        api.chatGetSettings(),
      ]);
      if (profileR.success && profileR.data) {
        const fpNew = _profileFingerprint(profileR.data);
        if (fpNew !== lastProfileFpRef.current) {
          lastProfileFpRef.current = fpNew;
          setProfile(profileR.data);
          if (profileR.data.has_avatar || profileR.data.avatar) {
            setAvatarUrl(api.getAvatarUrl(currentEmail));
          }
        }
      }
      if (settingsR.success && settingsR.data) {
        const merged = { ...settingsR.data };
        const fpNew = _settingsFingerprint(merged);
        if (fpNew !== lastSettingsFpRef.current) {
          lastSettingsFpRef.current = fpNew;
          setSettings(prev => ({ ...prev, ...settingsR.data }));
        }
      }
      // Save to cache (async getCached/setCache + synchronous MMKV mirror)
      const cachePayload = { profile: profileR.data, settings: settingsR.data };
      setCache('chat_profile', cachePayload, 2592000000).catch(() => {}); // 30 days
      if (Platform.OS !== 'web') {
        try {
          const { setString: _ss } = require('../services/mmkv');
          _ss('chat_profile', JSON.stringify(cachePayload));
        } catch {}
      }
      if (Platform.OS === 'web') {
        const np = getStorage('chatyy_notif_prefs');
        if (np) try { setSettings(prev => ({ ...prev, ...JSON.parse(np) })); } catch {}
      } else {
        const np = await AsyncStorage.getItem('chatyy_notif_prefs').catch(() => null);
        if (np) try { setSettings(prev => ({ ...prev, ...JSON.parse(np) })); } catch {}
      }
    } catch {} finally {
      setLoading(false);
    }
  }, [currentEmail]);

  useEffect(() => { loadProfile(); }, [loadProfile]);

  // Load Instagram-style social stats (posts/followers/following)
  useEffect(() => {
    if (!currentEmail) return;
    let alive = true;
    api.getPublicProfile(currentEmail).then(r => {
      if (!alive) return;
      if (r?.success && r.data) {
        setIgStats({
          posts: r.data.post_count || r.data.posts_count || 0,
          followers: r.data.followers_count || 0,
          following: r.data.following_count || 0,
        });
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, [currentEmail]);
  useEffect(() => {
    api.chatBlockedList().then(r => {
      if (r.success) {
        const data = r.data || [];
        setBlockedCount(data.length);
        setBlockedList(data);
      }
    }).catch(() => {}).finally(() => setBlockedLoading(false));
  }, [subScreen]);

  // Serialize settings updates through a single promise chain. Without
  // this, rapid switch toggles fire parallel chatUpdateSettings calls and
  // the LAST request to land at the server wins, even if it's an older
  // value (classic out-of-order persistence). Chaining guarantees writes
  // arrive in the order the user toggled them.
  const saveSettings = (updates) => {
    setSettings(prev => ({ ...prev, ...updates }));
    saveSettingsChainRef.current = saveSettingsChainRef.current.then(async () => {
      try {
        await api.chatUpdateSettings(updates);
        const merged = { ...settings, ...updates };
        const notifPrefs = {
          notification_sound: merged.notification_sound,
          notification_vibration: merged.notification_vibration,
        };
        setStorage('chatyy_notif_prefs', JSON.stringify(notifPrefs));
      } catch {}
    });
    return saveSettingsChainRef.current;
  };

  // Hydrate the auto-download matrix from chat_user_defaults on first mount
  // so the storage subscreen renders the user's actual cells instead of the
  // factory defaults. Also pushes the policy into mediaCache so the gate is
  // live before the user ever opens the subscreen.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.chatGetUserDefaults();
        if (!alive || !r?.success || !r.data) return;
        const p = r.data.auto_download_policy;
        if (p && typeof p === 'object') {
          setAutoDlPolicy(prev => ({ ...prev, ...p }));
          try {
            const mc = require('../services/mediaCache');
            if (mc && typeof mc.setAutoDownloadPolicy === 'function') {
              mc.setAutoDownloadPolicy(p);
            }
          } catch {}
        }
      } catch {}
    })();
    return () => { alive = false; };
  }, []);

  // Optimistic single-cell toggle. Updates local UI immediately, mirrors
  // into mediaCache (so the next cacheMedia auto-flow respects it without a
  // round-trip), then sends the patch to the server. Server merges with the
  // stored matrix and echoes it back as canonical.
  const togglePolicyCell = useCallback((bucket, column) => {
    setAutoDlPolicy(prev => {
      const cur = prev[bucket] || { mobile: 0, wifi: 0, roaming: 0 };
      const nextVal = cur[column] ? 0 : 1;
      const next = { ...prev, [bucket]: { ...cur, [column]: nextVal } };
      try {
        const mc = require('../services/mediaCache');
        if (mc && typeof mc.setAutoDownloadPolicy === 'function') {
          mc.setAutoDownloadPolicy(next);
        }
      } catch {}
      // Fire-and-forget — server merges and returns canonical matrix.
      api.chatSetAutoDownloadPolicy({ bucket, column, value: nextVal })
        .catch(() => {});
      return next;
    });
  }, []);

  const handleSave = async (field) => {
    if (saving) return;
    setSaving(true);
    try {
      const updates = {};
      if (field === 'name') updates.name = editValue.trim();
      if (field === 'about') updates.about = editValue.trim();
      if (field === 'phone') updates.phone = editValue.trim();
      const r = await api.updateProfile(updates);
      if (r.success) {
        setProfile(prev => ({ ...prev, ...updates }));
        setEditing(null);
      }
    } catch {} finally {
      setSaving(false);
    }
  };

  // Username real-time validation
  const handleUsernameChange = (val) => {
    const clean = val.toLowerCase().replace(/[^a-z0-9_]/g, '');
    setUsernameInput(clean);
    clearTimeout(usernameCheckRef.current);
    if (!clean || clean.length < 3) {
      setUsernameStatus(clean.length > 0 ? 'tooShort' : null);
      return;
    }
    if (!/^[a-z0-9_]+$/.test(clean)) {
      setUsernameStatus('invalid');
      return;
    }
    // If same as current, no need to check
    if (clean === (profile?.username || '')) {
      setUsernameStatus(null);
      return;
    }
    setUsernameStatus('checking');
    usernameCheckRef.current = setTimeout(async () => {
      try {
        const r = await api.searchByUsername(clean);
        // If exact_match found and the email is not ours, it's taken
        if (r?.success && r?.data?.exact_match) {
          const matchEmail = (r.data.users?.[0]?.email || '').toLowerCase();
          if (matchEmail === (user?.email || '').toLowerCase()) {
            setUsernameStatus(null); // Our own username
          } else {
            setUsernameStatus('taken');
          }
        } else {
          setUsernameStatus('available');
        }
      } catch {
        setUsernameStatus('error');
      }
    }, 400);
  };

  const handleSaveUsername = async () => {
    if (savingUsername) return;
    const handle = usernameInput.trim().toLowerCase();
    if (!handle || handle.length < 3) return;
    if (usernameStatus === 'taken' || usernameStatus === 'invalid') return;
    setSavingUsername(true);
    try {
      const r = await api.setUsername(handle);
      if (r?.success) {
        setProfile(prev => ({ ...(prev || {}), username: handle }));
        setEditing(null);
        setUsernameStatus(null);
        safeAlert('Chatyy', t?.('profile.usernameSaved') || 'Username saved!');
      } else {
        safeAlert(t?.('common.error') || 'Erro', r?.message || 'Failed');
      }
    } catch (e) {
      safeAlert(t?.('common.error') || 'Erro', e?.message || 'Failed');
    } finally {
      setSavingUsername(false);
    }
  };

  const handleAvatarPick = async () => {
    const onUploaded = (r) => {
      if (!r?.success) {
        safeAlert(t?.('common.error') || 'Erro', r?.message || 'Falha ao subir foto');
        return;
      }
      // Cache bust: append timestamp so React Native Image refetches
      const fresh = api.getAvatarUrl(currentEmail) + '&t=' + Date.now();
      setAvatarUrl(fresh);
      // Also update profile state so other UI parts re-render
      setProfile(prev => ({ ...(prev || {}), has_avatar: true, _avatar_v: Date.now() }));
      // Bump global avatar cache so AvatarCircle elsewhere refreshes
      try { require('./AvatarCircle').bumpAvatarCache && require('./AvatarCircle').bumpAvatarCache(currentEmail); } catch {}
    };
    if (Platform.OS === 'web') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          const r = await api.uploadAvatar(file);
          onUploaded(r);
        } catch (err) {
          safeAlert(t?.('common.error') || 'Erro', String(err?.message || err));
        }
      };
      input.click();
    } else {
      try {
        const ImagePicker = require('expo-image-picker');
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          safeAlert(t?.('common.error') || 'Erro', 'Permita acesso às fotos em Ajustes do app');
          return;
        }
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          quality: 0.8, allowsEditing: true, aspect: [1, 1],
        });
        if (!result.canceled && result.assets?.[0]) {
          const asset = result.assets[0];
          const r = await api.uploadAvatar({
            uri: asset.uri, name: 'avatar.jpg',
            type: asset.mimeType || 'image/jpeg',
          });
          onUploaded(r);
        }
      } catch (err) {
        safeAlert(t?.('common.error') || 'Erro', String(err?.message || err));
      }
    }
  };

  const handleInvite = async () => {
    const msg = t?.('chat.inviteMessage') || 'Ei! Baixa o Chatyy pra gente conversar!\nhttps://chatyy.com.br';
    if (Platform.OS === 'web') {
      try { await navigator.clipboard.writeText(msg); safeAlert('Chatyy', t?.('chat.inviteCopied') || 'Link copiado!'); } catch {}
    } else {
      try { await Share.share({ message: msg, title: 'Chatyy' }); } catch {}
    }
  };

  const handleLogout = () => {
    // WhatsApp parity: bearer is perpetual on the backend — only this
    // explicit Sair confirm (or a server-side revoke) actually nukes the
    // session. The strong message warns the user they'll need to re-auth.
    safeAlert(
      t?.('config.logoutTitle') || 'Sair',
      t?.('config.logoutConfirmStrong') || 'Tem certeza? Você terá que fazer login de novo.',
      [
        { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
        { text: t?.('config.logout') || 'Sair', style: 'destructive', onPress: () => { logout(); router.replace('/login'); } },
      ]
    );
  };

  // Shared surface color for section cards
  const surfaceBg = isDark ? '#161b22' : '#ffffff';
  const screenBg = isDark ? '#0d1117' : '#f0f2f5';

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: screenBg }]}>
        <SettingsSkeleton sections={3} rows={3} />
      </View>
    );
  }

  const name = profile?.name || currentName;
  const about = profile?.about || profile?.recado || t?.('profile.defaultAbout') || 'Disponivel';
  const phone = profile?.phone || profile?.verified_phone || '';

  // ─── Kids simplified profile ───
  if (isChildAccount()) {
    const restrictions = getChildRestrictions() || {};
    const parentEmail = restrictions.parent_email || '';
    const PERM_ITEMS = [
      { label: 'Enviar emails', allowed: !!restrictions.can_send_email, Icon: KidsIconMailPerm },
      { label: 'Deletar mensagens', allowed: !!restrictions.can_delete_messages, Icon: KidsIconTrashPerm },
      { label: 'Trocar senha', allowed: !!restrictions.can_change_password, Icon: KidsIconKeyPerm },
    ];
    return (
      <View style={[styles.container, { backgroundColor: isDark ? '#1a1025' : '#faf5ff' }]}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 100 }}>
          {/* Profile card with gradient */}
          <View style={{ margin: 16, borderRadius: 24, overflow: 'hidden', backgroundColor: isDark ? '#2d1b4e' : '#fff',
            ...Platform.select({ ios: { shadowColor: '#8b5cf6', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.1, shadowRadius: 12 }, android: { elevation: 4 }, web: { boxShadow: '0 4px 20px rgba(139,92,246,0.1)' } }) }}>
            <View style={{ height: 100, backgroundColor: '#A78BFA', ...(Platform.OS === 'web' ? { background: 'linear-gradient(135deg, #A78BFA, #8b5cf6, #ec4899)' } : {}) }} />
            <View style={{ alignItems: 'center', marginTop: -48 }}>
              <View style={{ borderWidth: 4, borderColor: isDark ? '#2d1b4e' : '#fff', borderRadius: 52 }}>
                <AvatarCircle name={name} email={currentEmail} size={96} />
              </View>
            </View>
            <View style={{ alignItems: 'center', padding: 16 }}>
              <Text style={{ fontSize: 22, fontWeight: '800', color: isDark ? '#e9d5ff' : '#1e1b4b' }}>{name}</Text>
              <View style={{ marginTop: 8, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: isDark ? 'rgba(139,92,246,0.15)' : '#ede9fe', paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20 }}>
                <KidsIconShieldUser size={14} color="#8b5cf6" />
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#8b5cf6' }}>Chatyy Kids</Text>
              </View>
            </View>
          </View>

          {/* SOS Emergency Button */}
          <TouchableOpacity
            onPress={async () => {
              const { Alert } = require('react-native');
              Alert.alert('EMERGENCIA', 'Enviar alerta de emergencia para seus pais?', [
                { text: 'Cancelar', style: 'cancel' },
                { text: 'SIM, PRECISO DE AJUDA', style: 'destructive', onPress: async () => {
                  try {
                    const api = require('../services/api');
                    let lat = null, lng = null, acc = null;
                    try {
                      const Loc = require('expo-location');
                      const { status } = await Loc.requestForegroundPermissionsAsync();
                      if (status === 'granted') {
                        const loc = await Loc.getCurrentPositionAsync({ accuracy: Loc.Accuracy.High });
                        lat = loc.coords.latitude; lng = loc.coords.longitude; acc = loc.coords.accuracy;
                      }
                    } catch {}
                    await api.parentalSOS('general', 'Preciso de ajuda!', lat, lng, acc, -1);
                    Alert.alert('Alerta enviado!', 'Seus pais foram notificados. Fique calmo!');
                  } catch { Alert.alert('Erro', 'Tente novamente'); }
                }},
              ]);
            }}
            style={{ marginHorizontal: 16, marginTop: 4, borderRadius: 20, padding: 20, backgroundColor: '#ef4444', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12,
              ...(Platform.OS === 'web' ? { boxShadow: '0 4px 16px rgba(239,68,68,0.25)' } : {}),
            }}
            activeOpacity={0.7}
          >
            <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center' }}>
              <KidsIconSOS size={24} color="#fff" />
            </View>
            <View>
              <Text style={{ color: '#fff', fontSize: 18, fontWeight: '800' }}>Botao de Emergencia</Text>
              <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 12, fontWeight: '500' }}>Toque para alertar seus pais</Text>
            </View>
          </TouchableOpacity>

          {/* Parent info */}
          {parentEmail ? (
            <View style={{ marginHorizontal: 16, marginTop: 12, borderRadius: 20, padding: 16, backgroundColor: isDark ? '#1e1145' : '#fff', flexDirection: 'row', alignItems: 'center', gap: 14,
              ...Platform.select({ ios: { shadowColor: '#8b5cf6', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8 }, android: { elevation: 2 }, web: { boxShadow: '0 2px 12px rgba(139,92,246,0.06)' } }) }}>
              <View style={{ width: 40, height: 40, borderRadius: 14, backgroundColor: isDark ? 'rgba(139,92,246,0.15)' : '#ede9fe', alignItems: 'center', justifyContent: 'center' }}>
                <KidsIconFamily size={20} color="#8b5cf6" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 12, fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 }}>Responsavel</Text>
                <Text style={{ fontSize: 15, fontWeight: '600', color: isDark ? '#e9d5ff' : '#1e1b4b', marginTop: 2 }}>{parentEmail}</Text>
              </View>
              <IconShield size={20} color="#8b5cf6" />
            </View>
          ) : null}

          {/* Restrictions */}
          <View style={{ marginHorizontal: 16, marginTop: 12, borderRadius: 20, overflow: 'hidden', backgroundColor: isDark ? '#1e1145' : '#fff',
            ...Platform.select({ ios: { shadowColor: '#8b5cf6', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8 }, android: { elevation: 2 }, web: { boxShadow: '0 2px 12px rgba(139,92,246,0.06)' } }) }}>
            <View style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 }}>Permissoes</Text>
            </View>
            {PERM_ITEMS.map((item, idx) => (
              <View key={idx} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: idx > 0 ? 0.5 : 0, borderTopColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }}>
                <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: isDark ? 'rgba(139,92,246,0.12)' : '#f3e8ff', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                  <item.Icon size={16} color={isDark ? '#a78bfa' : '#8b5cf6'} />
                </View>
                <Text style={{ flex: 1, fontSize: 15, fontWeight: '500', color: isDark ? '#e9d5ff' : '#1e1b4b' }}>{item.label}</Text>
                <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: item.allowed ? (isDark ? 'rgba(16,185,129,0.15)' : '#dcfce7') : (isDark ? 'rgba(239,68,68,0.15)' : '#fee2e2'), alignItems: 'center', justifyContent: 'center' }}>
                  {item.allowed ? <KidsIconCheckCircle size={16} color={isDark ? '#34d399' : '#10b981'} /> : <KidsIconXCircle size={16} color={isDark ? '#f87171' : '#ef4444'} />}
                </View>
              </View>
            ))}
            {restrictions.bedtime_start && (
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 0.5, borderTopColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }}>
                <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: isDark ? 'rgba(139,92,246,0.12)' : '#f3e8ff', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                  <KidsIconMoon size={16} color={isDark ? '#a78bfa' : '#8b5cf6'} />
                </View>
                <Text style={{ flex: 1, fontSize: 15, fontWeight: '500', color: isDark ? '#e9d5ff' : '#1e1b4b' }}>Hora de dormir</Text>
                <Text style={{ fontSize: 13, fontWeight: '600', color: '#8b5cf6' }}>{restrictions.bedtime_start} - {restrictions.bedtime_end}</Text>
              </View>
            )}
          </View>

          <View style={{ alignItems: 'center', marginTop: 24 }}>
            <KidsIconShieldProtected size={28} color={isDark ? '#A78BFA' : '#8b5cf6'} />
            <Text style={{ fontSize: 13, color: '#9ca3af', textAlign: 'center', marginTop: 8, fontWeight: '500' }}>Sua conta e protegida pelo seu responsavel</Text>
          </View>

          {/* Logout button */}
          <TouchableOpacity
            onPress={handleLogout}
            style={{ marginHorizontal: 16, marginTop: 20, marginBottom: 40, borderRadius: 20, padding: 16, backgroundColor: isDark ? '#1e1145' : '#fff', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
              ...Platform.select({ ios: { shadowColor: '#ef4444', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 8 }, android: { elevation: 2 }, web: { boxShadow: '0 2px 8px rgba(239,68,68,0.1)' } })
            }}
            activeOpacity={0.7}
          >
            <IconLogout size={20} color="#ef4444" />
            <Text style={{ fontSize: 15, fontWeight: '600', color: '#ef4444' }}>Sair da conta</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  // ─── Sub-screen header ───
  const SubHeader = ({ title }) => (
    <View style={[styles.subHeader, {
      backgroundColor: isDark ? '#1F2C33' : '#6D28D9',
      borderBottomWidth: 0,
    }]}>
      <TouchableOpacity onPress={() => setSubScreen(null)} style={styles.subBackBtn} activeOpacity={0.7}>
        <View style={[styles.subBackCircle, { backgroundColor: 'rgba(255,255,255,0.1)' }]}>
          <IconArrowLeft size={18} color="#fff" />
        </View>
      </TouchableOpacity>
      <Text style={[styles.subTitle, { color: '#fff' }]}>{title}</Text>
      <View style={{ width: 48 }} />
    </View>
  );

  // ─── Section Card wrapper ───
  const SectionCard = ({ children, style }) => (
    <View style={[styles.sectionCard, { backgroundColor: surfaceBg }, cardShadow(isDark), style]}>
      {children}
    </View>
  );

  // ─── Section Header text ───
  const SectionLabel = ({ label }) => (
    <Text style={[styles.sectionLabel, { color: isDark ? '#6b7280' : '#6b7280' }]}>{label}</Text>
  );

  // ─── Caller ID verify sub-screen ───
  if (subScreen === 'callerid') {
    return (
      <View style={[styles.container, { backgroundColor: screenBg }]}>
        <SubHeader title={t?.('callerId.title') || 'Verificar Caller ID'} />
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 60 }}>
          <CallerIdVerifyContent
            onClose={() => setSubScreen(null)}
            onVerified={() => { /* stays on screen showing success */ }}
            isDark={isDark}
            t={t}
          />
        </ScrollView>
      </View>
    );
  }

  // ─── Privacy sub-screen ───
  if (subScreen === 'privacy') {
    const privacyOptions = [
      { value: 'everyone', label: t?.('config.everyone') || 'Todos' },
      { value: 'contacts', label: t?.('config.contacts') || 'Meus contatos' },
      { value: 'nobody', label: t?.('config.nobody') || 'Ninguem' },
    ];
    return (
      <View style={[styles.container, { backgroundColor: screenBg }]}>
        <SubHeader title={t?.('config.privacy') || 'Privacidade'} />
        <ScrollView contentContainerStyle={{ paddingBottom: 100 }}>
          <SectionCard style={{ marginTop: 16 }}>
            {/* Last seen */}
            <Text style={[styles.privacyLabel, { color: isDark ? '#6b7280' : '#6b7280' }]}>
              {t?.('config.lastSeen') || 'Visto por ultimo e online'}
            </Text>
            <View style={styles.radioGroup}>
              {privacyOptions.map(opt => (
                <TouchableOpacity key={opt.value} style={styles.radioRow} onPress={() => saveSettings({ last_seen_privacy: opt.value })} activeOpacity={0.7}>
                  <View style={[styles.radio, { borderColor: isDark ? '#374151' : '#d1d5db' }, settings.last_seen_privacy === opt.value && styles.radioActive]}>
                    {settings.last_seen_privacy === opt.value && <View style={styles.radioDot} />}
                  </View>
                  <Text style={[styles.radioLabel, { color: colors.text }]}>{opt.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={[styles.dividerFull, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }]} />

            {/* Profile photo */}
            <Text style={[styles.privacyLabel, { color: isDark ? '#6b7280' : '#6b7280' }]}>
              {t?.('config.profilePhoto') || 'Foto do perfil'}
            </Text>
            <View style={styles.radioGroup}>
              {privacyOptions.map(opt => (
                <TouchableOpacity key={opt.value} style={styles.radioRow} onPress={() => saveSettings({ profile_photo_privacy: opt.value })} activeOpacity={0.7}>
                  <View style={[styles.radio, { borderColor: isDark ? '#374151' : '#d1d5db' }, settings.profile_photo_privacy === opt.value && styles.radioActive]}>
                    {settings.profile_photo_privacy === opt.value && <View style={styles.radioDot} />}
                  </View>
                  <Text style={[styles.radioLabel, { color: colors.text }]}>{opt.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={[styles.dividerFull, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }]} />

            {/* About */}
            <Text style={[styles.privacyLabel, { color: isDark ? '#6b7280' : '#6b7280' }]}>
              {t?.('config.aboutVisibility') || 'Recado'}
            </Text>
            <View style={styles.radioGroup}>
              {privacyOptions.map(opt => (
                <TouchableOpacity key={opt.value} style={styles.radioRow} onPress={() => saveSettings({ about_privacy: opt.value })} activeOpacity={0.7}>
                  <View style={[styles.radio, { borderColor: isDark ? '#374151' : '#d1d5db' }, settings.about_privacy === opt.value && styles.radioActive]}>
                    {settings.about_privacy === opt.value && <View style={styles.radioDot} />}
                  </View>
                  <Text style={[styles.radioLabel, { color: colors.text }]}>{opt.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Groups privacy */}
            <Text style={[styles.privacyLabel, { color: isDark ? '#6b7280' : '#6b7280' }]}>
              {t?.('config.groupsPrivacy') || 'Quem pode me adicionar a grupos'}
            </Text>
            <View style={styles.radioGroup}>
              {privacyOptions.map(opt => (
                <TouchableOpacity key={opt.value} style={styles.radioRow} onPress={() => saveSettings({ groups_privacy: opt.value })} activeOpacity={0.7}>
                  <View style={[styles.radio, { borderColor: isDark ? '#374151' : '#d1d5db' }, (settings.groups_privacy || 'everyone') === opt.value && styles.radioActive]}>
                    {(settings.groups_privacy || 'everyone') === opt.value && <View style={styles.radioDot} />}
                  </View>
                  <Text style={[styles.radioLabel, { color: colors.text }]}>{opt.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={[styles.dividerFull, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }]} />

            {/* Default disappearing messages timer */}
            <Text style={[styles.privacyLabel, { color: isDark ? '#6b7280' : '#6b7280' }]}>
              {t?.('config.defaultDisappearing') || 'Mensagens temporarias por padrao'}
            </Text>
            <View style={styles.radioGroup}>
              {[
                { value: 0, label: t?.('config.off') || 'Desativado' },
                { value: 86400, label: '24h' },
                { value: 604800, label: t?.('config.7days') || '7 dias' },
                { value: 7776000, label: t?.('config.90days') || '90 dias' },
              ].map(opt => (
                <TouchableOpacity key={opt.value} style={styles.radioRow} onPress={() => {
                  try { api.chatSetDefaultDisappearing?.(opt.value); } catch {}
                  saveSettings({ default_disappearing_seconds: opt.value });
                }} activeOpacity={0.7}>
                  <View style={[styles.radio, { borderColor: isDark ? '#374151' : '#d1d5db' }, (settings.default_disappearing_seconds || 0) === opt.value && styles.radioActive]}>
                    {(settings.default_disappearing_seconds || 0) === opt.value && <View style={styles.radioDot} />}
                  </View>
                  <Text style={[styles.radioLabel, { color: colors.text }]}>{opt.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={{ fontSize: 12, color: isDark ? '#6b7280' : '#9ca3af', paddingHorizontal: 16, marginTop: -4, marginBottom: 12 }}>
              {t?.('config.defaultDisappearingHint') || 'Aplica-se apenas a novas conversas'}
            </Text>

            <View style={[styles.dividerFull, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }]} />

            {/* Read receipts */}
            <View style={styles.switchRowModern}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.readReceipts') || 'Confirmação de leitura'}</Text>
                <Text style={[styles.switchDesc, { color: isDark ? '#6b7280' : '#9ca3af' }]}>{t?.('config.readReceiptsDesc') || 'Mostrar quando você leu mensagens'}</Text>
              </View>
              <Switch
                value={settings.read_receipts}
                onValueChange={(v) => saveSettings({ read_receipts: v })}
                trackColor={{ false: isDark ? '#374151' : '#d1d5db', true: 'rgba(124,58,237,0.4)' }}
                thumbColor={settings.read_receipts ? ACCENT : isDark ? '#555' : '#ccc'}
              />
            </View>

            {/* Smart-pin: auto-fixar conversas mais ativas */}
            <View style={[styles.rowSeparator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }]} />
            <View style={styles.switchRowModern}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.smartPin') || 'Fixar conversas mais ativas'}</Text>
                <Text style={[styles.switchDesc, { color: isDark ? '#6b7280' : '#9ca3af' }]}>{t?.('config.smartPinDesc') || 'Top 3 conversas dos últimos 30 dias aparecem fixadas automaticamente'}</Text>
              </View>
              <Switch
                value={!!settings.smart_pin_enabled}
                onValueChange={(v) => saveSettings({ smart_pin_enabled: v })}
                trackColor={{ false: isDark ? '#374151' : '#d1d5db', true: 'rgba(245,158,11,0.4)' }}
                thumbColor={settings.smart_pin_enabled ? '#F59E0B' : isDark ? '#555' : '#ccc'}
              />
            </View>

            {/* HD media quality */}
            <View style={[styles.rowSeparator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }]} />
            <View style={styles.switchRowModern}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.hdMediaQuality') || 'Qualidade HD de mídia'}</Text>
                <Text style={[styles.switchDesc, { color: isDark ? '#6b7280' : '#9ca3af' }]}>{t?.('config.hdMediaQualityDesc') || 'Enviar fotos e vídeos em qualidade HD (usa mais dados)'}</Text>
              </View>
              <Switch
                value={!!settings.hd_media_quality}
                onValueChange={(v) => saveSettings({ hd_media_quality: v })}
                trackColor={{ false: isDark ? '#374151' : '#d1d5db', true: 'rgba(124,58,237,0.4)' }}
                thumbColor={settings.hd_media_quality ? ACCENT : isDark ? '#555' : '#ccc'}
              />
            </View>

            {/* Biometric lock (native only) */}
            {Platform.OS !== 'web' && biometricAvailable && (
              <>
                <View style={[styles.rowSeparator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }]} />
                <View style={styles.switchRowModern}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.appLock') || 'Bloqueio do app'}</Text>
                    <Text style={[styles.switchDesc, { color: isDark ? '#6b7280' : '#9ca3af' }]}>{t?.('config.appLockDesc') || 'Usar biometria para desbloquear'}</Text>
                  </View>
                  <Switch
                    value={biometricEnabled}
                    onValueChange={toggleBiometric}
                    trackColor={{ false: isDark ? '#374151' : '#d1d5db', true: 'rgba(124,58,237,0.4)' }}
                    thumbColor={biometricEnabled ? ACCENT : isDark ? '#555' : '#ccc'}
                  />
                </View>
              </>
            )}

            <View style={[styles.dividerFull, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }]} />

            {/* Bots (developers) */}
            <TouchableOpacity
              style={styles.linkRowModern}
              onPress={() => router.push('/bots')}
              activeOpacity={0.7}
            >
              <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(124,58,237,0.1)' : '#ede9fe' }]}>
                <IconSparkles size={14} color="#7C3AED" />
              </View>
              <Text style={[styles.linkText, { color: colors.text }]}>{t?.('bots.title') || 'Bots'}</Text>
              <IconChevronRight size={16} color={isDark ? '#4b5563' : '#c5c5c5'} />
            </TouchableOpacity>

            {/* Close Friends */}
            <TouchableOpacity
              style={styles.linkRowModern}
              onPress={() => router.push('/close-friends')}
              activeOpacity={0.7}
            >
              <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(34,197,94,0.1)' : '#dcfce7' }]}>
                <IconStar size={16} color="#22C55E" />
              </View>
              <Text style={[styles.linkText, { color: colors.text }]}>{t?.('closeFriends.title') || 'Amigos proximos'}</Text>
              <IconChevronRight size={16} color={isDark ? '#4b5563' : '#c5c5c5'} />
            </TouchableOpacity>

            {/* Starred Messages */}
            <TouchableOpacity
              style={styles.linkRowModern}
              onPress={() => { try { router.push('/starred-messages'); } catch (e) { console.warn('[profile] nav:', e); } }}
              activeOpacity={0.7}
            >
              <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(255,193,7,0.1)' : '#fef9c3' }]}>
                <IconStar size={16} color="#FFC107" />
              </View>
              <Text style={[styles.linkText, { color: colors.text }]}>{t?.('starred.title') || 'Mensagens favoritas'}</Text>
              <IconChevronRight size={16} color={isDark ? '#4b5563' : '#c5c5c5'} />
            </TouchableOpacity>

            {/* Linked Devices — show current device type as subtitle so the
                user sees at-a-glance which platform they're on (web/mobile). */}
            <TouchableOpacity
              style={styles.linkRowModern}
              onPress={() => { try { router.push('/linked-devices'); } catch (e) { console.warn('[profile] nav:', e); } }}
              activeOpacity={0.7}
            >
              <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(59,130,246,0.1)' : '#EDE9FE' }]}>
                {Platform.OS === 'web'
                  ? <IconDeviceWeb size={16} color="#3B82F6" />
                  : <IconDeviceMobile size={16} color="#3B82F6" />}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.linkText, { color: colors.text, flex: undefined }]}>{t?.('devices.title') || 'Dispositivos conectados'}</Text>
                <Text style={[styles.deviceSubLine, { color: isDark ? '#6b7280' : '#9ca3af' }]}>
                  {(t?.('devices.thisDevice') || 'Este dispositivo')}
                  {' · '}
                  {Platform.OS === 'web' ? 'Web' : (Platform.OS === 'ios' ? 'iOS' : 'Android')}
                  {' · '}
                  {t?.('time.now') || 'agora'}
                </Text>
              </View>
              <IconChevronRight size={16} color={isDark ? '#4b5563' : '#c5c5c5'} />
            </TouchableOpacity>

            {/* Verify Caller ID */}
            <TouchableOpacity
              style={styles.linkRowModern}
              onPress={() => setSubScreen('callerid')}
              activeOpacity={0.7}
            >
              <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(0,122,255,0.1)' : '#EDE9FE' }]}>
                <IconPhone size={16} color="#007AFF" />
              </View>
              <Text style={[styles.linkText, { color: colors.text }]}>{t?.('callerId.title') || 'Verificar Caller ID'}</Text>
              <IconChevronRight size={16} color={isDark ? '#4b5563' : '#c5c5c5'} />
            </TouchableOpacity>

            {/* Blocked contacts */}
            <TouchableOpacity
              style={styles.linkRowModern}
              onPress={() => setSubScreen('blocked')}
              activeOpacity={0.7}
            >
              <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(220,38,38,0.1)' : '#fef2f2' }]}>
                <IconX size={16} color="#dc2626" />
              </View>
              <Text style={[styles.linkText, { color: '#dc2626' }]}>{t?.('config.blocked') || 'Contatos bloqueados'}</Text>
              <Text style={[styles.linkCount, { color: isDark ? '#6b7280' : '#9ca3af' }]}>{blockedCount}</Text>
              <IconChevronRight size={16} color={isDark ? '#4b5563' : '#c5c5c5'} />
            </TouchableOpacity>
          </SectionCard>
        </ScrollView>
      </View>
    );
  }

  // ─── Notifications sub-screen ───
  if (subScreen === 'notifications') {
    return (
      <View style={[styles.container, { backgroundColor: screenBg }]}>
        <SubHeader title={t?.('config.notifications') || 'Notificacoes'} />
        <ScrollView contentContainerStyle={{ paddingBottom: 100 }}>
          <SectionCard style={{ marginTop: 16 }}>
            <View style={styles.switchRowModern}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.notifMessages') || 'Notificacoes de mensagens'}</Text>
                <Text style={[styles.switchDesc, { color: isDark ? '#6b7280' : '#9ca3af' }]}>{t?.('config.notifMessagesDesc') || 'Receber notificacoes de novas mensagens'}</Text>
              </View>
              <Switch
                value={settings.notifications}
                onValueChange={(v) => saveSettings({ notifications: v })}
                trackColor={{ false: isDark ? '#374151' : '#d1d5db', true: 'rgba(124,58,237,0.4)' }}
                thumbColor={settings.notifications ? ACCENT : isDark ? '#555' : '#ccc'}
              />
            </View>

            {settings.notifications && (
              <>
                <View style={[styles.rowSeparator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)', marginLeft: 20 }]} />
                <View style={[styles.switchRowModern, { paddingLeft: 36 }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.notifSound') || 'Sons'}</Text>
                    <Text style={[styles.switchDesc, { color: isDark ? '#6b7280' : '#9ca3af' }]}>{t?.('config.notifSoundDesc') || 'Tocar som ao receber mensagem'}</Text>
                  </View>
                  <Switch
                    value={settings.notification_sound}
                    onValueChange={(v) => saveSettings({ notification_sound: v })}
                    trackColor={{ false: isDark ? '#374151' : '#d1d5db', true: 'rgba(124,58,237,0.4)' }}
                    thumbColor={settings.notification_sound ? ACCENT : isDark ? '#555' : '#ccc'}
                  />
                </View>
                {Platform.OS !== 'web' && (
                  <>
                    <View style={[styles.rowSeparator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)', marginLeft: 36 }]} />
                    <View style={[styles.switchRowModern, { paddingLeft: 36 }]}>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.notifVibration') || 'Vibracao'}</Text>
                        <Text style={[styles.switchDesc, { color: isDark ? '#6b7280' : '#9ca3af' }]}>{t?.('config.notifVibrationDesc') || 'Vibrar ao receber mensagem'}</Text>
                      </View>
                      <Switch
                        value={settings.notification_vibration}
                        onValueChange={(v) => saveSettings({ notification_vibration: v })}
                        trackColor={{ false: isDark ? '#374151' : '#d1d5db', true: 'rgba(124,58,237,0.4)' }}
                        thumbColor={settings.notification_vibration ? ACCENT : isDark ? '#555' : '#ccc'}
                      />
                    </View>
                  </>
                )}
              </>
            )}

            {/* Group notifications */}
            <View style={[styles.rowSeparator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }]} />
            <View style={styles.switchRowModern}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.notifGroups') || 'Notificacoes de grupos'}</Text>
                <Text style={[styles.switchDesc, { color: isDark ? '#6b7280' : '#9ca3af' }]}>{t?.('config.notifGroupsDesc') || 'Receber notificacoes de mensagens em grupos'}</Text>
              </View>
              <Switch
                value={settings.notification_groups}
                onValueChange={(v) => saveSettings({ notification_groups: v })}
                trackColor={{ false: isDark ? '#374151' : '#d1d5db', true: 'rgba(124,58,237,0.4)' }}
                thumbColor={settings.notification_groups ? ACCENT : isDark ? '#555' : '#ccc'}
              />
            </View>

            {/* Call notifications */}
            <View style={[styles.rowSeparator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }]} />
            <View style={styles.switchRowModern}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.notifCalls') || 'Notificacoes de chamadas'}</Text>
                <Text style={[styles.switchDesc, { color: isDark ? '#6b7280' : '#9ca3af' }]}>{t?.('config.notifCallsDesc') || 'Receber notificacoes de chamadas de voz e video'}</Text>
              </View>
              <Switch
                value={settings.notification_calls}
                onValueChange={(v) => saveSettings({ notification_calls: v })}
                trackColor={{ false: isDark ? '#374151' : '#d1d5db', true: 'rgba(124,58,237,0.4)' }}
                thumbColor={settings.notification_calls ? ACCENT : isDark ? '#555' : '#ccc'}
              />
            </View>

            {/* Sound picker */}
            <View style={[styles.rowSeparator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }]} />
            <View style={[styles.switchRowModern, { flexDirection: 'column', alignItems: 'flex-start' }]}>
              <Text style={[styles.switchLabel, { color: colors.text, marginBottom: 10 }]}>{t?.('config.soundPicker') || 'Som de notificacao'}</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {[
                  { val: 'default', label: t?.('config.soundDefault') || 'Padrao' },
                  { val: 'chime', label: t?.('config.soundChime') || 'Sino' },
                  { val: 'bubble', label: t?.('config.soundBubble') || 'Bolha' },
                  { val: 'ding', label: t?.('config.soundDing') || 'Ding' },
                  { val: 'none', label: t?.('config.soundNone') || 'Nenhum' },
                ].map(s2 => (
                  <TouchableOpacity
                    key={s2.val}
                    style={[styles.btnOption, {
                      borderColor: settings.notification_tone === s2.val ? ACCENT : (isDark ? '#374151' : '#d1d5db'),
                      backgroundColor: settings.notification_tone === s2.val ? (isDark ? 'rgba(124,58,237,0.1)' : '#ecfdf5') : 'transparent',
                    }]}
                    onPress={() => saveSettings({ notification_tone: s2.val })}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.btnOptionText, { color: settings.notification_tone === s2.val ? ACCENT : colors.text }]}>
                      {s2.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Web notification permission */}
            {Platform.OS === 'web' && typeof window !== 'undefined' && 'Notification' in window && (
              <>
                <View style={[styles.rowSeparator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }]} />
                <View style={styles.switchRowModern}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.desktopNotifs') || 'Notificacoes do desktop'}</Text>
                    <Text style={[styles.switchDesc, { color: isDark ? '#6b7280' : '#9ca3af' }]}>
                      {Notification.permission === 'granted' ? (t?.('config.notifsEnabled') || 'Ativadas') : (t?.('config.notifsDisabled') || 'Desativadas')}
                    </Text>
                  </View>
                  {Notification.permission !== 'granted' && Notification.permission !== 'denied' && (
                    <TouchableOpacity
                      style={styles.enableBtnModern}
                      onPress={async () => { await Notification.requestPermission(); }}
                      activeOpacity={0.8}
                    >
                      <Text style={{ color: '#fff', fontWeight: '600', fontSize: 13 }}>{t?.('config.enable') || 'Ativar'}</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </>
            )}
          </SectionCard>
        </ScrollView>
      </View>
    );
  }

  // ─── Wallpaper picker sub-screen ───
  if (subScreen === 'wallpaper') {
    const WALLPAPER_COLORS = [
      '#6D28D9', '#0C8767', '#E4DCD4', '#008069', '#1B3A2D',
      '#111B21', '#D5DBDF', '#EFEAE2', '#B3C8D6', '#FFC4C4',
    ];
    const currentWp = settings.wallpaper || 'none';
    const selectWallpaper = (val) => {
      saveSettings({ wallpaper: val });
    };
    return (
      <View style={[styles.container, { backgroundColor: screenBg }]}>
        <SubHeader title={t?.('config.wallpaper') || 'Papel de parede do chat'} />
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 100 }}>
          <SectionCard>
            <SectionLabel label={t?.('config.wallpaperDefault') || 'Padrao'} />
            <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 20, paddingBottom: 20 }}>
              <TouchableOpacity
                onPress={() => selectWallpaper('none')}
                style={{
                  width: 52, height: 52, borderRadius: 26, borderWidth: 3,
                  borderColor: currentWp === 'none' ? ACCENT : (isDark ? '#374151' : '#e5e7eb'),
                  backgroundColor: isDark ? '#1f2937' : '#f9fafb', alignItems: 'center', justifyContent: 'center',
                }}
                activeOpacity={0.7}
              >
                {currentWp === 'none' && <IconCheck size={20} color={ACCENT} />}
              </TouchableOpacity>
              <View style={{ justifyContent: 'center' }}>
                <Text style={{ fontSize: 15, color: colors.text, fontWeight: '500' }}>{t?.('config.wallpaperNone') || 'Sem papel de parede'}</Text>
              </View>
            </View>
          </SectionCard>

          <SectionCard style={{ marginTop: 12 }}>
            <SectionLabel label={t?.('config.wallpaperSolid') || 'Cores solidas'} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14, paddingHorizontal: 20, paddingBottom: 20 }}>
              {WALLPAPER_COLORS.map(c => (
                <TouchableOpacity
                  key={c}
                  onPress={() => selectWallpaper(c)}
                  style={{
                    width: 52, height: 52, borderRadius: 26, backgroundColor: c, borderWidth: 3,
                    borderColor: currentWp === c ? '#fff' : 'transparent',
                    alignItems: 'center', justifyContent: 'center',
                    ...(currentWp === c ? Platform.select({
                      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4 },
                      android: { elevation: 4 },
                      web: { boxShadow: '0 2px 8px rgba(0,0,0,0.3)' },
                    }) : {}),
                  }}
                  activeOpacity={0.7}
                >
                  {currentWp === c && <IconCheck size={20} color="#fff" />}
                </TouchableOpacity>
              ))}
            </View>
          </SectionCard>

          {/* Upload custom wallpaper */}
          <SectionCard style={{ marginTop: 12 }}>
            <SectionLabel label={t?.('config.wallpaperCustom') || 'Personalizado'} />
            <TouchableOpacity
              style={[styles.linkRowModern, { paddingVertical: 14 }]}
              onPress={async () => {
                if (Platform.OS === 'web') {
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.accept = 'image/*';
                  input.onchange = async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    try {
                      const reader = new FileReader();
                      reader.onload = () => {
                        const dataUrl = reader.result;
                        saveSettings({ wallpaper: dataUrl.substring(0, 500000) });
                      };
                      reader.readAsDataURL(file);
                    } catch {}
                  };
                  input.click();
                } else {
                  try {
                    const { launchImageLibraryAsync } = await import('expo-image-picker');
                    const result = await launchImageLibraryAsync({
                      mediaTypes: ['images'],
                      quality: 0.6, allowsEditing: true,
                    });
                    if (!result.canceled && result.assets?.[0]) {
                      saveSettings({ wallpaper: result.assets[0].uri });
                    }
                  } catch {}
                }
              }}
              activeOpacity={0.7}
            >
              <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(124,58,237,0.1)' : '#ecfdf5' }]}>
                <IconUpload size={16} color={ACCENT} />
              </View>
              <Text style={[styles.linkText, { color: colors.text }]}>{t?.('config.wallpaperUpload') || 'Enviar imagem'}</Text>
              <IconChevronRight size={16} color={isDark ? '#4b5563' : '#c5c5c5'} />
            </TouchableOpacity>
            {/* Preview current custom wallpaper */}
            {settings.wallpaper && !settings.wallpaper.startsWith('#') && settings.wallpaper !== 'none' && settings.wallpaper.length > 20 && (
              <View style={{ paddingHorizontal: 20, paddingBottom: 16 }}>
                <View style={{ width: '100%', height: 120, borderRadius: 12, overflow: 'hidden', backgroundColor: isDark ? '#1f2937' : '#f3f4f6' }}>
                  <RNImage source={{ uri: settings.wallpaper }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                </View>
                <TouchableOpacity
                  onPress={() => selectWallpaper('none')}
                  style={{ marginTop: 8, alignSelf: 'center', paddingHorizontal: 16, paddingVertical: 6, borderRadius: 16, backgroundColor: isDark ? 'rgba(220,38,38,0.1)' : '#fef2f2' }}
                  activeOpacity={0.7}
                >
                  <Text style={{ color: '#dc2626', fontSize: 12, fontWeight: '600' }}>{t?.('common.remove') || 'Remover'}</Text>
                </TouchableOpacity>
              </View>
            )}
          </SectionCard>
        </ScrollView>
      </View>
    );
  }

  // ─── Chats/Conversations sub-screen ───
  if (subScreen === 'chats') {
    return (
      <View style={[styles.container, { backgroundColor: screenBg }]}>
        <SubHeader title={t?.('config.chatSettings') || 'Conversas'} />
        <ScrollView contentContainerStyle={{ paddingBottom: 100 }}>
          <SectionCard style={{ marginTop: 16 }}>
            {/* Theme */}
            <View style={styles.switchRowModern}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.darkMode') || 'Modo escuro'}</Text>
                <Text style={[styles.switchDesc, { color: isDark ? '#6b7280' : '#9ca3af' }]}>{t?.('config.darkModeDesc') || 'Alternar tema claro/escuro'}</Text>
              </View>
              <Switch
                value={isDark}
                onValueChange={toggleTheme}
                trackColor={{ false: isDark ? '#374151' : '#d1d5db', true: 'rgba(124,58,237,0.4)' }}
                thumbColor={isDark ? ACCENT : '#ccc'}
              />
            </View>

            <View style={[styles.rowSeparator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }]} />

            {/* Font size */}
            <View style={styles.switchRowModern}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.fontSize') || 'Tamanho da fonte'}</Text>
              </View>
              <View style={styles.btnGroup}>
                {[
                  { val: 'small', label: t?.('config.fontSmall') || 'P' },
                  { val: 'medium', label: t?.('config.fontMedium') || 'M' },
                  { val: 'large', label: t?.('config.fontLarge') || 'G' },
                ].map(f => (
                  <TouchableOpacity
                    key={f.val}
                    style={[styles.btnOption, { borderColor: isDark ? '#374151' : '#d1d5db' }, settings.font_size === f.val && styles.btnOptionActive]}
                    onPress={() => saveSettings({ font_size: f.val })}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.btnOptionText, { color: colors.text }, settings.font_size === f.val && styles.btnOptionTextActive]}>
                      {f.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={[styles.rowSeparator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }]} />

            {/* Density */}
            <View style={styles.switchRowModern}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.density') || 'Densidade'}</Text>
              </View>
              <View style={styles.btnGroup}>
                {[
                  { val: 'compact', label: t?.('config.compact') || 'Compacto' },
                  { val: 'comfortable', label: t?.('config.comfortable') || 'Confortavel' },
                ].map(d => (
                  <TouchableOpacity
                    key={d.val}
                    style={[styles.btnOption, { borderColor: isDark ? '#374151' : '#d1d5db' }, density === d.val && styles.btnOptionActive]}
                    onPress={() => setDensity(d.val)}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.btnOptionText, { color: colors.text }, density === d.val && styles.btnOptionTextActive]}>
                      {d.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={[styles.rowSeparator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }]} />

            {/* Wallpaper */}
            <TouchableOpacity style={styles.linkRowModern} onPress={() => setSubScreen('wallpaper')} activeOpacity={0.7}>
              <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(124,58,237,0.1)' : '#ecfdf5' }]}>
                <IconImage size={16} color={ACCENT} />
              </View>
              <Text style={[styles.linkText, { color: colors.text }]}>{t?.('config.wallpaper') || 'Papel de parede do chat'}</Text>
              {settings.wallpaper && settings.wallpaper !== 'none' && (
                <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: settings.wallpaper.startsWith('#') ? settings.wallpaper : ACCENT, marginRight: 4, borderWidth: 2, borderColor: isDark ? '#374151' : '#e5e7eb' }} />
              )}
              <IconChevronRight size={16} color={isDark ? '#4b5563' : '#c5c5c5'} />
            </TouchableOpacity>
          </SectionCard>
        </ScrollView>
      </View>
    );
  }

  // ─── Language sub-screen ───
  if (subScreen === 'language') {
    return (
      <View style={[styles.container, { backgroundColor: screenBg }]}>
        <SubHeader title={t?.('config.language') || 'Idioma do app'} />
        <ScrollView contentContainerStyle={{ paddingBottom: 100 }}>
          <SectionCard style={{ marginTop: 16 }}>
            {LANGUAGES.map((l, i) => (
              <View key={l.code}>
                <TouchableOpacity
                  style={styles.langRowModern}
                  onPress={() => { changeLanguage(l.code); }}
                  activeOpacity={0.7}
                >
                  <Text style={styles.langFlag}>{l.flag}</Text>
                  <Text style={[styles.langName, { color: colors.text }]}>{l.label}</Text>
                  {language === l.code && (
                    <View style={[styles.checkCircle, { backgroundColor: ACCENT }]}>
                      <IconCheck size={14} color="#fff" />
                    </View>
                  )}
                </TouchableOpacity>
                {i < LANGUAGES.length - 1 && (
                  <View style={[styles.rowSeparator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)', marginLeft: 56 }]} />
                )}
              </View>
            ))}
          </SectionCard>
        </ScrollView>
      </View>
    );
  }

  // ─── Storage sub-screen ───
  if (subScreen === 'storage') {
    // Media auto-download matrix (WhatsApp Settings → Data and Storage). Keys
    // map 1:1 to the `auto_download_policy` JSONB row in chat_user_defaults.
    const autoDownloadItems = [
      { key: 'photos',    label: t?.('settings.autoDownload.photos')    || t?.('config.autoDownloadPhotos') || 'Fotos',      Icon: IconCamera   },
      { key: 'audio',     label: t?.('settings.autoDownload.audio')     || t?.('config.autoDownloadAudio')  || 'Áudios',     Icon: IconMusic    },
      { key: 'videos',    label: t?.('settings.autoDownload.videos')    || t?.('config.autoDownloadVideos') || 'Vídeos',     Icon: IconFilm     },
      { key: 'documents', label: t?.('settings.autoDownload.documents') || t?.('config.autoDownloadDocs')   || 'Documentos', Icon: IconFileText },
    ];
    const autoDownloadCols = [
      { key: 'mobile',  label: t?.('settings.autoDownload.colMobile')  || 'Mobile' },
      { key: 'wifi',    label: t?.('settings.autoDownload.colWifi')    || 'Wi-Fi'  },
      { key: 'roaming', label: t?.('settings.autoDownload.colRoaming') || 'Roaming' },
    ];

    // Fetch REAL storage stats by walking cache directories
    const loadStorageStats = async () => {
      if (storageStats) return;
      setStorageLoading(true);
      try {
        let imagesSize = 0, videosSize = 0, audioSize = 0, docsSize = 0;

        const isImg = (n) => /\.(jpe?g|png|gif|webp|bmp|heic|heif|svg)$/i.test(n);
        const isVid = (n) => /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i.test(n);
        const isAud = (n) => /\.(mp3|m4a|wav|ogg|aac|opus|webm)$/i.test(n);

        if (Platform.OS === 'web') {
          // Web: walk Cache Storage and read Content-Length headers (real bytes)
          try {
            const names = await (caches?.keys?.() || Promise.resolve([]));
            for (const name of names || []) {
              const cache = await caches.open(name);
              const reqs = await cache.keys();
              for (const req of reqs) {
                try {
                  const resp = await cache.match(req);
                  if (!resp) continue;
                  const cl = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
                  const url = req.url || '';
                  if (isImg(url)) imagesSize += cl;
                  else if (isVid(url)) videosSize += cl;
                  else if (isAud(url)) audioSize += cl;
                  else docsSize += cl;
                } catch {}
              }
            }
          } catch {}
        } else {
          // Native: walk expo-file-system cache dirs
          try {
            let FS; try { FS = require('expo-file-system/legacy'); } catch { FS = require('expo-file-system'); }
            const walk = async (dir, depth = 0) => {
              if (depth > 6) return;
              try {
                const items = await FS.readDirectoryAsync(dir);
                for (const name of items) {
                  const path = dir.endsWith('/') ? dir + name : dir + '/' + name;
                  try {
                    const info = await FS.getInfoAsync(path, { size: true });
                    if (info.exists && info.isDirectory) {
                      await walk(path, depth + 1);
                    } else if (info.exists && info.size) {
                      if (isImg(name)) imagesSize += info.size;
                      else if (isVid(name)) videosSize += info.size;
                      else if (isAud(name)) audioSize += info.size;
                      else docsSize += info.size;
                    }
                  } catch {}
                }
              } catch {}
            };
            // Walk all chat-related cache subdirs
            const baseDirs = [FS.cacheDirectory, FS.documentDirectory].filter(Boolean);
            for (const base of baseDirs) {
              for (const sub of ['chat-media', 'chat-audio', 'audio-cache', 'media-cache', 'images', 'videos']) {
                try { await walk(base + sub); } catch {}
              }
            }
          } catch (e) { console.warn('[storage] walk failed:', e?.message); }
          // Also include the audioManager-tracked cache (separate accounting)
          const audioCacheBytes = await getAudioCacheSize().catch(() => 0);
          audioSize += audioCacheBytes;
        }
        setStorageStats({ images: imagesSize, videos: videosSize, audio: audioSize, docs: docsSize });
      } catch {} finally { setStorageLoading(false); }
    };
    if (!storageStats && !storageLoading) loadStorageStats();

    const formatSize = (bytes) => {
      if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
      return bytes + ' B';
    };

    const mediaItems = [
      { label: t?.('config.storageImages') || 'Imagens', size: storageStats?.images || 0, color: '#A78BFA', icon: <IconImage size={16} color="#A78BFA" /> },
      { label: t?.('config.storageVideos') || 'Videos', size: storageStats?.videos || 0, color: '#ef4444', icon: <IconImage size={16} color="#ef4444" /> },
      { label: t?.('config.storageAudio') || 'Audio', size: storageStats?.audio || 0, color: '#f59e0b', icon: <IconImage size={16} color="#f59e0b" /> },
      { label: t?.('config.storageDocs') || 'Documentos', size: storageStats?.docs || 0, color: '#10b981', icon: <IconFileText size={16} color="#10b981" /> },
    ];
    const totalSize = mediaItems.reduce((acc, m) => acc + m.size, 0);

    return (
      <View style={[styles.container, { backgroundColor: screenBg }]}>
        <SubHeader title={t?.('config.storage') || 'Armazenamento e dados'} />
        <ScrollView contentContainerStyle={{ paddingBottom: 100 }}>
          {/* Auto-download policy matrix (WhatsApp Settings → Data and Storage).
              4 media buckets × 3 network columns (Mobile / Wi-Fi / Roaming).
              Each cell toggles independently; persisted to chat_user_defaults
              .auto_download_policy via chat_set_auto_download_policy. */}
          <SectionCard style={{ marginTop: 16 }}>
            <Text style={[styles.sectionTitle, { color: colors.text, marginBottom: 4 }]}>
              {t?.('settings.autoDownload.title') || t?.('config.autoDownload') || 'Download automático'}
            </Text>
            <Text style={{ fontSize: 12, color: isDark ? '#6b7280' : '#9ca3af', marginBottom: 12, paddingHorizontal: 4 }}>
              {t?.('settings.autoDownload.subtitle') || t?.('config.autoDownloadDesc') || 'Escolha quando o app baixa mídias automaticamente'}
            </Text>
            {/* Column header row */}
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }}>
              <View style={{ width: 20, marginRight: 12 }} />
              <Text style={{ flex: 1, fontSize: 12, fontWeight: '600', color: isDark ? '#9ca3af' : '#6b7280' }}>
                {t?.('settings.autoDownload.colMedia') || 'Mídia'}
              </Text>
              {autoDownloadCols.map(col => (
                <Text key={col.key} style={{ width: 64, textAlign: 'center', fontSize: 12, fontWeight: '600', color: isDark ? '#9ca3af' : '#6b7280' }}>
                  {col.label}
                </Text>
              ))}
            </View>
            {autoDownloadItems.map(item => {
              const row = autoDlPolicy[item.key] || { mobile: 0, wifi: 0, roaming: 0 };
              return (
                <View key={item.key} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10 }}>
                  <View style={{ width: 20, marginRight: 12, alignItems: 'center' }}>
                    <item.Icon size={20} color={isDark ? '#9ca3af' : '#6b7280'} />
                  </View>
                  <Text style={[styles.switchLabel, { color: colors.text, flex: 1 }]}>{item.label}</Text>
                  {autoDownloadCols.map(col => {
                    const on = !!row[col.key];
                    return (
                      <TouchableOpacity
                        key={col.key}
                        accessibilityRole="switch"
                        accessibilityState={{ checked: on }}
                        accessibilityLabel={`${item.label} ${col.label}`}
                        onPress={() => togglePolicyCell(item.key, col.key)}
                        activeOpacity={0.7}
                        style={{ width: 64, alignItems: 'center', justifyContent: 'center', paddingVertical: 4 }}>
                        <View style={{
                          width: 22, height: 22, borderRadius: 6,
                          borderWidth: 2,
                          borderColor: on ? ACCENT : (isDark ? '#4b5563' : '#d1d5db'),
                          backgroundColor: on ? ACCENT : 'transparent',
                          alignItems: 'center', justifyContent: 'center',
                        }}>
                          {on ? <IconCheck size={14} color="#fff" /> : null}
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              );
            })}
          </SectionCard>

          <SectionCard style={{ marginTop: 16 }}>
            <View style={styles.storageInfoModern}>
              <View style={[styles.storageIconCircle, { backgroundColor: isDark ? 'rgba(124,58,237,0.1)' : '#ecfdf5' }]}>
                <IconSmartphone size={32} color={ACCENT} />
              </View>
              <Text style={[styles.storageTitle, { color: colors.text }]}>{t?.('config.storageUsage') || 'Uso de armazenamento'}</Text>
              {storageLoading ? (
                <ActivityIndicator size="small" color={ACCENT} style={{ marginTop: 8 }} />
              ) : (
                <Text style={[styles.storageDesc, { color: isDark ? '#6b7280' : '#9ca3af', fontSize: 13, fontWeight: '600' }]}>
                  {formatSize(totalSize)} {t?.('config.storageDesc2') || 'em cache local'}
                </Text>
              )}
            </View>

            {/* Media breakdown bar */}
            {totalSize > 0 && (
              <View style={{ paddingHorizontal: 20, paddingBottom: 16 }}>
                <View style={{ flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', backgroundColor: isDark ? '#1f2937' : '#f3f4f6' }}>
                  {mediaItems.filter(m => m.size > 0).map((m, i) => (
                    <View key={i} style={{ flex: m.size, backgroundColor: m.color, borderRadius: i === 0 ? 4 : 0 }} />
                  ))}
                </View>
              </View>
            )}

            {/* Media type breakdown */}
            {mediaItems.map((m, i) => (
              <View key={i}>
                {i > 0 && <View style={[styles.rowSeparator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)', marginLeft: 56 }]} />}
                <View style={[styles.linkRowModern, { paddingVertical: 12 }]}>
                  <View style={[styles.iconCircle, { backgroundColor: m.color + '15' }]}>
                    {m.icon}
                  </View>
                  <Text style={[styles.linkText, { color: colors.text, flex: 1 }]}>{m.label}</Text>
                  <Text style={{ color: isDark ? '#6b7280' : '#9ca3af', fontSize: 13, fontWeight: '500' }}>{formatSize(m.size)}</Text>
                </View>
              </View>
            ))}

            <View style={[styles.dividerFull, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }]} />

            <TouchableOpacity
              style={styles.linkRowModern}
              onPress={async () => {
                const cacheKeys = ['chatyy_notif_prefs', 'chatyy_sticker_recents', 'chat_draft_', 'link_preview_'];
                if (Platform.OS === 'web') {
                  try {
                    const toRemove = [];
                    for (let i = 0; i < localStorage.length; i++) {
                      const key = localStorage.key(i);
                      if (cacheKeys.some(ck => key?.startsWith(ck))) toRemove.push(key);
                    }
                    toRemove.forEach(k => localStorage.removeItem(k));
                    safeAlert('Chatyy', t?.('config.cacheCleared') || 'Cache limpo!');
                  } catch {}
                } else {
                  try {
                    const allKeys = await AsyncStorage.getAllKeys();
                    const toRemove = allKeys.filter(k => cacheKeys.some(ck => k.startsWith(ck)));
                    if (toRemove.length) await AsyncStorage.multiRemove(toRemove);
                    safeAlert('Chatyy', t?.('config.cacheCleared') || 'Cache limpo!');
                  } catch {}
                }
              }}
              activeOpacity={0.7}
            >
              <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(225,112,85,0.1)' : '#fef3c7' }]}>
                <IconTrash size={16} color="#E17055" />
              </View>
              <Text style={[styles.linkText, { color: colors.text }]}>{t?.('config.clearCache') || 'Limpar cache'}</Text>
              <IconChevronRight size={16} color={isDark ? '#4b5563' : '#c5c5c5'} />
            </TouchableOpacity>

            <View style={[styles.rowSeparator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)', marginLeft: 56 }]} />

            <TouchableOpacity
              style={styles.linkRowModern}
              onPress={async () => {
                try {
                  const size = await getAudioCacheSize();
                  const count = await getAudioCacheCount();
                  const sizeMB = (size / (1024 * 1024)).toFixed(1);
                  const desc = count > 0 ? `${count} audios (${sizeMB} MB)` : (t?.('config.cacheEmpty') || 'Cache vazio');
                  const doIt = () => clearAudioCache().then(() => safeAlert('Chatyy', t?.('config.audioCacheCleared') || 'Cache de audio limpo!')).catch(() => {});
                  if (Platform.OS === 'web') { doIt(); } else {
                    Alert.alert(
                      t?.('config.clearAudioCache') || 'Limpar cache de audio',
                      desc,
                      [{ text: t?.('common.cancel') || 'Cancelar', style: 'cancel' }, { text: t?.('common.clear') || 'Limpar', style: 'destructive', onPress: doIt }]
                    );
                  }
                } catch { clearAudioCache().catch(() => {}); }
              }}
              activeOpacity={0.7}
            >
              <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(108,92,231,0.1)' : '#ede9fe' }]}>
                <IconTrash size={16} color="#6C5CE7" />
              </View>
              <Text style={[styles.linkText, { color: colors.text }]}>{t?.('config.clearAudioCache') || 'Limpar cache de audio'}</Text>
              <IconChevronRight size={16} color={isDark ? '#4b5563' : '#c5c5c5'} />
            </TouchableOpacity>
          </SectionCard>
        </ScrollView>
      </View>
    );
  }

  // ─── Help sub-screen ───
  if (subScreen === 'help') {
    return (
      <View style={[styles.container, { backgroundColor: screenBg }]}>
        <SubHeader title={t?.('config.help') || 'Ajuda'} />
        <ScrollView contentContainerStyle={{ paddingBottom: 100 }}>
          <SectionCard style={{ marginTop: 16 }}>
            <TouchableOpacity
              style={styles.helpRowModern}
              onPress={() => Linking.openURL('mailto:contato@chatyy.com.br')}
              activeOpacity={0.7}
            >
              <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(107,114,128,0.1)' : '#f3f4f6' }]}>
                <IconMail size={16} color="#6b7280" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.contactUs') || 'Fale conosco'}</Text>
                <Text style={[styles.switchDesc, { color: isDark ? '#6b7280' : '#9ca3af' }]}>contato@chatyy.com.br</Text>
              </View>
              <IconChevronRight size={16} color={isDark ? '#4b5563' : '#c5c5c5'} />
            </TouchableOpacity>

            <View style={[styles.rowSeparator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)', marginLeft: 56 }]} />

            <TouchableOpacity
              style={styles.helpRowModern}
              onPress={() => Linking.openURL('https://chatyy.com.br')}
              activeOpacity={0.7}
            >
              <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(107,114,128,0.1)' : '#f3f4f6' }]}>
                <IconGlobe size={16} color="#6b7280" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.website') || 'Site'}</Text>
                <Text style={[styles.switchDesc, { color: isDark ? '#6b7280' : '#9ca3af' }]}>chatyy.com.br</Text>
              </View>
              <IconChevronRight size={16} color={isDark ? '#4b5563' : '#c5c5c5'} />
            </TouchableOpacity>

            <View style={[styles.rowSeparator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)', marginLeft: 56 }]} />

            <TouchableOpacity
              style={styles.helpRowModern}
              onPress={() => Linking.openURL('https://chatyy.com.br/termos')}
              activeOpacity={0.7}
            >
              <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(107,114,128,0.1)' : '#f3f4f6' }]}>
                <IconFileText size={16} color="#6b7280" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.terms') || 'Termos e privacidade'}</Text>
              </View>
              <IconChevronRight size={16} color={isDark ? '#4b5563' : '#c5c5c5'} />
            </TouchableOpacity>
          </SectionCard>

          <SectionCard style={{ marginTop: 12 }}>
            <View style={styles.storageInfoModern}>
              <Text style={[styles.appNameBig, { color: ACCENT }]}>Chatyy</Text>
              <Text style={[styles.storageDesc, { color: isDark ? '#6b7280' : '#9ca3af' }]}>by Chatyy</Text>
              <Text style={[styles.storageDesc, { color: isDark ? '#4b5563' : '#c5c5c5', marginTop: 4, fontSize: 12 }]}>v1.4.0</Text>
            </View>
          </SectionCard>
        </ScrollView>
      </View>
    );
  }

  // ─── Account sub-screen ───
  if (subScreen === 'account') {
    const handleChangePassword = async () => {
      if (!currentPw || !newPw) return;
      if (newPw !== confirmPw) {
        safeAlert('Chatyy', t?.('config.passwordMismatch') || 'As senhas não coincidem');
        return;
      }
      if (newPw.length < 6) {
        safeAlert('Chatyy', t?.('config.passwordTooShort') || 'A senha deve ter pelo menos 6 caracteres');
        return;
      }
      setChangingPw(true);
      try {
        const r = await api.changePassword(currentPw, newPw);
        if (r.success) {
          safeAlert('Chatyy', t?.('config.passwordChanged') || 'Senha alterada com sucesso!');
          setCurrentPw(''); setNewPw(''); setConfirmPw('');
        } else {
          safeAlert('Chatyy', r.message || t?.('config.passwordError') || 'Erro ao alterar senha');
        }
      } catch {
        safeAlert('Chatyy', t?.('config.passwordError') || 'Erro ao alterar senha');
      } finally {
        setChangingPw(false);
      }
    };

    return (
      <View style={[styles.container, { backgroundColor: screenBg }]}>
        <SubHeader title={t?.('config.account') || 'Conta'} />
        <ScrollView contentContainerStyle={{ paddingBottom: 100 }}>
          {/* Account info */}
          <SectionLabel label={t?.('config.email') || 'INFORMACOES'} />
          <SectionCard>
            <View style={{ paddingHorizontal: 20, paddingVertical: 16 }}>
              <Text style={[styles.privacyLabelInline, { color: isDark ? '#6b7280' : '#6b7280' }]}>
                {t?.('config.email') || 'E-mail'}
              </Text>
              <Text style={[{ fontSize: 16, color: colors.text, marginTop: 4, fontWeight: '500' }]}>{currentEmail}</Text>
            </View>
            {phone ? (
              <>
                <View style={[styles.rowSeparator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }]} />
                <View style={{ paddingHorizontal: 20, paddingVertical: 16 }}>
                  <Text style={[styles.privacyLabelInline, { color: isDark ? '#6b7280' : '#6b7280' }]}>
                    {t?.('config.phone') || 'Telefone'}
                  </Text>
                  <Text style={[{ fontSize: 16, color: colors.text, marginTop: 4, fontWeight: '500' }]}>{phone}</Text>
                </View>
              </>
            ) : null}
          </SectionCard>

          {/* Change password */}
          <SectionLabel label={t?.('config.changePassword') || 'ALTERAR SENHA'} />
          <SectionCard>
            <View style={{ paddingHorizontal: 20, gap: 12, paddingVertical: 20 }}>
              <View style={{ position: 'relative' }}>
                <TextInput
                  style={[styles.pwInputModern, { color: colors.text, borderColor: isDark ? '#374151' : '#e5e7eb', backgroundColor: isDark ? '#0d1117' : '#f9fafb' }]}
                  placeholder={t?.('config.currentPassword') || 'Senha atual'}
                  placeholderTextColor={isDark ? '#4b5563' : '#9ca3af'}
                  secureTextEntry={!showPw}
                  value={currentPw}
                  onChangeText={setCurrentPw}
                  autoCapitalize="none"
                />
              </View>
              <TextInput
                style={[styles.pwInputModern, { color: colors.text, borderColor: isDark ? '#374151' : '#e5e7eb', backgroundColor: isDark ? '#0d1117' : '#f9fafb' }]}
                placeholder={t?.('config.newPassword') || 'Nova senha'}
                placeholderTextColor={isDark ? '#4b5563' : '#9ca3af'}
                secureTextEntry={!showPw}
                value={newPw}
                onChangeText={setNewPw}
                autoCapitalize="none"
              />
              <TextInput
                style={[styles.pwInputModern, { color: colors.text, borderColor: isDark ? '#374151' : '#e5e7eb', backgroundColor: isDark ? '#0d1117' : '#f9fafb' }]}
                placeholder={t?.('config.confirmPassword') || 'Confirmar nova senha'}
                placeholderTextColor={isDark ? '#4b5563' : '#9ca3af'}
                secureTextEntry={!showPw}
                value={confirmPw}
                onChangeText={setConfirmPw}
                autoCapitalize="none"
              />
              <TouchableOpacity onPress={() => setShowPw(!showPw)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 }} activeOpacity={0.7}>
                {showPw ? <IconEyeOff size={16} color={isDark ? '#6b7280' : '#9ca3af'} /> : <IconEye size={16} color={isDark ? '#6b7280' : '#9ca3af'} />}
                <Text style={{ color: isDark ? '#6b7280' : '#9ca3af', fontSize: 13 }}>{showPw ? (t?.('config.hidePassword') || 'Ocultar senhas') : (t?.('config.showPassword') || 'Mostrar senhas')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.changePwBtn, { opacity: changingPw ? 0.6 : 1 }]}
                onPress={handleChangePassword}
                disabled={changingPw}
                activeOpacity={0.8}
              >
                {changingPw ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>{t?.('config.changePasswordBtn') || 'Alterar senha'}</Text>
                )}
              </TouchableOpacity>
            </View>
          </SectionCard>

          {/* Delete account */}
          <SectionCard style={{ marginTop: 12 }}>
            <TouchableOpacity
              style={styles.deleteAccountRow}
              onPress={() => safeAlert('Chatyy', t?.('config.deleteAccountInfo') || 'Para excluir sua conta, entre em contato: contato@chatyy.com.br')}
              activeOpacity={0.7}
            >
              <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(220,38,38,0.1)' : '#fef2f2' }]}>
                <IconTrash size={16} color="#dc2626" />
              </View>
              <Text style={styles.deleteAccountText}>{t?.('config.deleteAccount') || 'Excluir conta'}</Text>
            </TouchableOpacity>
          </SectionCard>
        </ScrollView>
      </View>
    );
  }

  // ─── Blocked contacts sub-screen ───
  if (subScreen === 'blocked') {
    const handleUnblock = (email) => {
      safeAlert(
        t?.('config.unblock') || 'Desbloquear',
        (t?.('config.unblockConfirm') || 'Desbloquear {email}?').replace('{email}', email),
        [
          { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
          {
            text: t?.('config.unblock') || 'Desbloquear',
            onPress: async () => {
              try {
                await api.chatUnblockUser(email);
                setBlockedList(prev => prev.filter(e => e.blocked_email !== email));
              } catch {}
            },
          },
        ]
      );
    };
    const blocked = blockedList.map(b => b.blocked_email);

    return (
      <View style={[styles.container, { backgroundColor: screenBg }]}>
        <SubHeader title={t?.('config.blocked') || 'Contatos bloqueados'} />
        <ScrollView contentContainerStyle={{ paddingBottom: 100 }}>
          <SectionCard style={{ marginTop: 16 }}>
            {blockedLoading ? (
              <ActivityIndicator style={{ padding: 30 }} color={colors.primary} />
            ) : blocked.length === 0 ? (
              <View style={styles.storageInfoModern}>
                <View style={[styles.storageIconCircle, { backgroundColor: isDark ? 'rgba(107,114,128,0.1)' : '#f3f4f6' }]}>
                  <IconShield size={32} color={isDark ? '#4b5563' : '#9ca3af'} />
                </View>
                <Text style={[styles.storageTitle, { color: colors.text }]}>{t?.('config.noBlocked') || 'Nenhum contato bloqueado'}</Text>
                <Text style={[styles.storageDesc, { color: isDark ? '#6b7280' : '#9ca3af' }]}>
                  {t?.('config.noBlockedDesc') || 'Contatos bloqueados não podem enviar mensagens para você no Chatyy'}
                </Text>
              </View>
            ) : (
              blocked.map((email, i) => (
                <View key={email}>
                  <View style={styles.blockedRowModern}>
                    <AvatarCircle name={emailToDisplayName(email)} email={email} size={42} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.blockedEmail, { color: colors.text }]} numberOfLines={1}>{emailToDisplayName(email)}</Text>
                      <Text style={{ color: isDark ? '#6b7280' : '#9ca3af', fontSize: 12, marginTop: 2 }} numberOfLines={1}>{email}</Text>
                    </View>
                    <TouchableOpacity onPress={() => handleUnblock(email)} style={styles.unblockBtn} activeOpacity={0.7}>
                      <Text style={{ color: '#dc2626', fontWeight: '600', fontSize: 12 }}>{t?.('config.unblock') || 'Desbloquear'}</Text>
                    </TouchableOpacity>
                  </View>
                  {i < blocked.length - 1 && (
                    <View style={[styles.rowSeparator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)', marginLeft: 66 }]} />
                  )}
                </View>
              ))
            )}
          </SectionCard>
        </ScrollView>
      </View>
    );
  }

  // ─── Main settings screen ───
  return (
    <View style={[styles.container, { backgroundColor: screenBg }]}>
      <Animated.ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 100 }}
        style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}
      >
        {/* Profile Card - large, prominent */}
        <View style={[styles.profileCardModern, { backgroundColor: surfaceBg }, cardShadow(isDark)]}>
          {/* Gradient tint behind avatar */}
          <View style={styles.profileGradientBg}>
            <View style={[styles.profileGradient, { backgroundColor: isDark ? '#0a1f0a' : '#f0fdf4' }]} />
          </View>

          <View style={styles.profileCardContent}>
            {/* Avatar with brand ring + camera overlay */}
            <TouchableOpacity style={styles.avatarContainerModern} onPress={handleAvatarPick} activeOpacity={0.8}>
              <View style={[styles.avatarBrandRing, {
                borderColor: isDark ? 'rgba(167,139,250,0.55)' : 'rgba(124,58,237,0.45)',
              }]}>
                {avatarUrl ? (
                  <ExpoImage source={{ uri: avatarUrl }} style={styles.avatarModern} cachePolicy="memory-disk" transition={200} />
                ) : (
                  <AvatarCircle name={name} email={currentEmail} size={96} />
                )}
              </View>
              <View style={[styles.cameraOverlayModern, Platform.select({
                ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.35, shadowRadius: 4 },
                android: { elevation: 4 },
                web: { boxShadow: '0 2px 8px rgba(124,58,237,0.35)' },
              })]}>
                <IconCamera size={15} color="#fff" />
              </View>
            </TouchableOpacity>

            {/* Name - editable inline */}
            <View style={styles.profileInfoModern}>
              {editing === 'name' ? (
                <View style={styles.editRow}>
                  <TextInput
                    style={[styles.editInputModern, { color: colors.text, borderColor: ACCENT }]}
                    value={editValue}
                    onChangeText={setEditValue}
                    autoFocus
                    maxLength={40}
                  />
                  <TouchableOpacity onPress={() => handleSave('name')} disabled={saving} style={styles.editActionBtn}>
                    {saving ? <ActivityIndicator size="small" color={ACCENT} /> : <IconCheck size={18} color={ACCENT} />}
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => { setEditing(null); setEditValue(''); }} style={styles.editActionBtn}>
                    <IconX size={18} color={isDark ? '#6b7280' : '#9ca3af'} />
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity onPress={() => { setEditing('name'); setEditValue(name); }} activeOpacity={0.7} style={styles.editableTouchable}>
                  <Text style={[styles.profileNameModern, { color: colors.text }]}>{name}</Text>
                  <IconEdit size={14} color={isDark ? '#4b5563' : '#c5c5c5'} />
                </TouchableOpacity>
              )}

              <Text style={[styles.profileEmailModern, { color: isDark ? '#4b5563' : '#9ca3af' }]} numberOfLines={1}>{currentEmail}</Text>

              {/* Username (@handle) - inline in profile card */}
              {editing === 'username' ? (
                <View style={[styles.editRow, { marginTop: 6 }]}>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Text style={{ color: isDark ? '#6b7280' : '#9ca3af', fontSize: 14, fontWeight: '600' }}>@</Text>
                      <TextInput
                        style={[styles.editInputModern, { color: colors.text, borderColor: ACCENT, fontSize: 14, flex: 1, marginLeft: 2 }]}
                        value={usernameInput}
                        onChangeText={handleUsernameChange}
                        autoFocus
                        maxLength={30}
                        autoCapitalize="none"
                        autoCorrect={false}
                        placeholder={t?.('profile.usernameAdd') || 'Add username'}
                        placeholderTextColor={isDark ? '#374151' : '#d1d5db'}
                      />
                    </View>
                    {usernameStatus === 'checking' && (
                      <Text style={{ fontSize: 11, color: isDark ? '#6b7280' : '#9ca3af', marginTop: 2 }}>{t?.('profile.usernameChecking') || 'Checking...'}</Text>
                    )}
                    {usernameStatus === 'available' && (
                      <Text style={{ fontSize: 11, color: '#22c55e', marginTop: 2 }}>{t?.('profile.usernameAvailable') || 'Available'}</Text>
                    )}
                    {usernameStatus === 'taken' && (
                      <Text style={{ fontSize: 11, color: '#ef4444', marginTop: 2 }}>{t?.('profile.usernameTaken') || 'Already taken'}</Text>
                    )}
                    {usernameStatus === 'tooShort' && (
                      <Text style={{ fontSize: 11, color: '#f59e0b', marginTop: 2 }}>{t?.('profile.usernameTooShort') || 'Min 3 characters'}</Text>
                    )}
                    {usernameStatus === 'invalid' && (
                      <Text style={{ fontSize: 11, color: '#ef4444', marginTop: 2 }}>{t?.('profile.usernameInvalid') || 'Only lowercase letters, numbers and _'}</Text>
                    )}
                  </View>
                  <TouchableOpacity
                    onPress={handleSaveUsername}
                    disabled={savingUsername || usernameStatus === 'taken' || usernameStatus === 'invalid' || usernameStatus === 'tooShort' || usernameStatus === 'checking'}
                    style={styles.editActionBtn}
                  >
                    {savingUsername ? <ActivityIndicator size="small" color={ACCENT} /> : <IconCheck size={18} color={usernameStatus === 'available' || usernameStatus === null ? ACCENT : '#9ca3af'} />}
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => { setEditing(null); setUsernameStatus(null); }} style={styles.editActionBtn}>
                    <IconX size={18} color={isDark ? '#6b7280' : '#9ca3af'} />
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity
                  onPress={() => { setEditing('username'); setUsernameInput(profile?.username || ''); setUsernameStatus(null); }}
                  activeOpacity={0.7}
                  style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}
                >
                  <Text style={{ fontSize: 14, color: profile?.username ? (isDark ? '#a78bfa' : ACCENT) : (isDark ? '#374151' : '#d1d5db'), fontWeight: profile?.username ? '600' : '400' }}>
                    {profile?.username ? `@${profile.username}` : (t?.('profile.usernameAdd') || 'Add username')}
                  </Text>
                  <IconEdit size={12} color={isDark ? '#374151' : '#d1d5db'} style={{ marginLeft: 6 }} />
                </TouchableOpacity>
              )}

              {/* Phone number - inline in profile card */}
              {phone ? (
                <View style={styles.profilePhoneRow}>
                  <IconPhone size={13} color={isDark ? '#4b5563' : '#9ca3af'} />
                  <Text style={[styles.profilePhoneText, { color: isDark ? '#4b5563' : '#9ca3af' }]} numberOfLines={1}>{phone}</Text>
                  <View style={[styles.verifiedDot, { backgroundColor: ACCENT }]} />
                </View>
              ) : null}

              {/* About/Status - editable */}
              {editing === 'about' ? (
                <View style={[styles.editRow, { marginTop: 8 }]}>
                  <TextInput
                    style={[styles.editInputModern, { color: colors.text, borderColor: ACCENT, fontSize: 13 }]}
                    value={editValue}
                    onChangeText={setEditValue}
                    autoFocus
                    maxLength={140}
                  />
                  <TouchableOpacity onPress={() => handleSave('about')} disabled={saving} style={styles.editActionBtn}>
                    {saving ? <ActivityIndicator size="small" color={ACCENT} /> : <IconCheck size={18} color={ACCENT} />}
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => { setEditing(null); setEditValue(''); }} style={styles.editActionBtn}>
                    <IconX size={18} color={isDark ? '#6b7280' : '#9ca3af'} />
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity onPress={() => { setEditing('about'); setEditValue(about); }} activeOpacity={0.7} style={[styles.aboutTouchable, { marginTop: 6 }]}>
                  <View style={[styles.aboutPill, { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)' }]}>
                    <Text style={[styles.profileAboutModern, { color: isDark ? '#6b7280' : '#6b7280' }]} numberOfLines={1}>{about}</Text>
                    <IconEdit size={11} color={isDark ? '#374151' : '#d1d5db'} />
                  </View>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>

        {/* ─── Instagram-style stats row + action buttons ─── */}
        <View style={{ marginHorizontal: 12, marginTop: 10, padding: 16, borderRadius: 18, backgroundColor: surfaceBg, ...cardShadow(isDark) }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingBottom: 14 }}>
            <View style={{ alignItems: 'center', flex: 1 }}>
              <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text }}>{igStats.posts}</Text>
              <Text style={{ fontSize: 12, color: isDark ? '#9ca3af' : '#6b7280', marginTop: 2 }}>{t?.('profile.posts') || 'Posts'}</Text>
            </View>
            <View style={{ width: StyleSheet.hairlineWidth, height: 32, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }} />
            <TouchableOpacity activeOpacity={0.7} style={{ alignItems: 'center', flex: 1 }} onPress={() => router?.push?.('/profile')}>
              <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text }}>{igStats.followers}</Text>
              <Text style={{ fontSize: 12, color: isDark ? '#9ca3af' : '#6b7280', marginTop: 2 }}>{t?.('profile.followers') || 'Seguidores'}</Text>
            </TouchableOpacity>
            <View style={{ width: StyleSheet.hairlineWidth, height: 32, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }} />
            <TouchableOpacity activeOpacity={0.7} style={{ alignItems: 'center', flex: 1 }} onPress={() => router?.push?.('/profile')}>
              <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text }}>{igStats.following}</Text>
              <Text style={{ fontSize: 12, color: isDark ? '#9ca3af' : '#6b7280', marginTop: 2 }}>{t?.('profile.following') || 'Seguindo'}</Text>
            </TouchableOpacity>
          </View>
          {/* Action buttons row — brand Edit pill (press scale 0.97) + outlined Share */}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <PressablePill
              onPress={() => router?.push?.('/profile')}
              style={{
                flex: 1, backgroundColor: ACCENT, borderRadius: 10,
                paddingVertical: 10, alignItems: 'center', justifyContent: 'center',
                ...Platform.select({
                  ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 6 },
                  android: { elevation: 2 },
                  web: { boxShadow: '0 2px 8px rgba(124,58,237,0.25)' },
                }),
              }}
            >
              <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700', letterSpacing: 0.2 }}>
                {t?.('profile.editProfile') || 'Editar perfil'}
              </Text>
            </PressablePill>
            <TouchableOpacity
              onPress={() => {
                try {
                  // Use single `url` field — passing both message+url causes
                  // iOS Share Extension to receive duplicate NSItemProviders
                  // (text + url), making recipients see body x2.
                  Share.share({
                    url: `https://chatyy.com.br/u/${currentEmail.split('@')[0]}`,
                  });
                } catch {}
              }}
              activeOpacity={0.85}
              style={{
                flex: 1, borderRadius: 8, borderWidth: 1,
                borderColor: isDark ? '#374151' : '#dbdbdb',
                paddingVertical: 9, alignItems: 'center', justifyContent: 'center',
              }}
            >
              <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>
                {t?.('profile.share') || 'Compartilhar'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Phone Number */}
        <SectionCard style={{ marginTop: 10 }}>
          <View style={styles.phoneRowModern}>
            <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(124,58,237,0.1)' : '#ecfdf5' }]}>
              <IconPhone size={16} color={ACCENT} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.phoneLabelModern, { color: isDark ? '#6b7280' : '#6b7280' }]}>
                {t?.('config.phoneNumber') || 'Numero de telefone'}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3 }}>
                <Text style={[styles.phoneValueModern, { color: colors.text }]}>
                  {phone || (t?.('config.noPhone') || 'Nenhum telefone verificado')}
                </Text>
                {phone ? (
                  <View style={[styles.verifiedBadge, { backgroundColor: isDark ? 'rgba(124,58,237,0.1)' : '#ecfdf5' }]}>
                    <IconCheck size={10} color={ACCENT} />
                    <Text style={styles.verifiedText}>
                      {t?.('profile.verified') || 'Verificado'}
                    </Text>
                  </View>
                ) : null}
              </View>
            </View>
          </View>
          <Text style={[styles.phoneHintModern, { color: isDark ? '#374151' : '#9ca3af' }]}>
            {t?.('config.phoneHint') || 'Seus contatos com este numero poderao encontra-lo no Chatyy'}
          </Text>
        </SectionCard>

        {/* Verified Caller ID — show your number to non-Chatyy contacts when calling */}
        {(() => {
          const callerVerified = !!profile?.telnyx_caller_id_verified;
          return (
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => { if (!callerVerified) setShowVerifyCallerId(true); }}
              style={{
                marginHorizontal: 12, marginTop: 10, padding: 16, borderRadius: 18,
                backgroundColor: callerVerified
                  ? (isDark ? 'rgba(124,58,237,0.08)' : '#ecfdf5')
                  : (isDark ? 'rgba(99,102,241,0.10)' : '#eef2ff'),
                borderWidth: 1,
                borderColor: callerVerified
                  ? (isDark ? 'rgba(124,58,237,0.18)' : 'rgba(124,58,237,0.25)')
                  : (isDark ? 'rgba(99,102,241,0.20)' : 'rgba(99,102,241,0.25)'),
                flexDirection: 'row', alignItems: 'center', gap: 14,
                ...(Platform.OS === 'web' ? { boxShadow: callerVerified ? '0 2px 12px rgba(124,58,237,0.10)' : '0 2px 12px rgba(99,102,241,0.10)' } : {}),
              }}
            >
              <View style={{
                width: 46, height: 46, borderRadius: 14,
                backgroundColor: callerVerified ? '#22c55e' : '#A78BFA',
                alignItems: 'center', justifyContent: 'center',
              }}>
                {callerVerified ? <IconCheck size={22} color="#fff" /> : <IconPhone size={22} color="#fff" />}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text, marginBottom: 2 }}>
                  {callerVerified
                    ? (t?.('config.callerIdVerifiedTitle') || 'Numero verificado')
                    : (t?.('config.callerIdCtaTitle') || 'Verifique seu número')}
                </Text>
                <Text style={{ fontSize: 12, color: isDark ? '#9ca3af' : '#6b7280', lineHeight: 17 }}>
                  {callerVerified
                    ? (t?.('config.callerIdVerifiedDesc') || 'Seus amigos verao seu número quando você ligar — mesmo se ainda nao usarem o Chatyy.')
                    : (t?.('config.callerIdCtaDesc') || 'Quer que seus amigos que ainda não têm Chatyy vejam seu número quando você ligar? Verifique seu número aqui.')}
                </Text>
              </View>
              {!callerVerified && <IconChevronRight size={20} color={isDark ? '#9ca3af' : '#6b7280'} />}
            </TouchableOpacity>
          );
        })()}

        {/* Account & Privacy Section */}
        <SectionLabel label={t?.('config.account') || 'CONTA'} />
        <SectionCard>
          <SettingItem icon={<IconKey size={18} color="#A78BFA" />} iconBg={isDark ? 'rgba(59,130,246,0.1)' : '#EDE9FE'}
            title={t?.('config.account') || 'Conta'}
            subtitle={t?.('config.accountDesc') || 'Seguranca, alterar senha, excluir conta'}
            colors={colors} isDark={isDark} onPress={() => setSubScreen('account')} />
          <SettingItem icon={<IconLock size={18} color="#8b5cf6" />} iconBg={isDark ? 'rgba(139,92,246,0.1)' : '#ede9fe'}
            title={t?.('config.privacy') || 'Privacidade'}
            subtitle={t?.('config.privacyDesc') || 'Visto por ultimo, foto de perfil, recado'}
            colors={colors} isDark={isDark} onPress={() => setSubScreen('privacy')} />
          <SettingItem icon={<IconBell size={18} color="#f97316" />} iconBg={isDark ? 'rgba(249,115,22,0.1)' : '#fff7ed'}
            title={t?.('config.notifications') || 'Notificacoes'}
            subtitle={t?.('config.notificationsDesc') || 'Sons, vibracao, notificacoes de mensagem'}
            colors={colors} isDark={isDark} onPress={() => setSubScreen('notifications')} />
          <SettingItem icon={<IconImage size={18} color="#10b981" />} iconBg={isDark ? 'rgba(16,185,129,0.1)' : '#ecfdf5'}
            title={t?.('config.chatSettings') || 'Conversas'}
            subtitle={t?.('config.chatSettingsDesc') || 'Tema, papel de parede, tamanho da fonte'}
            colors={colors} isDark={isDark} onPress={() => setSubScreen('chats')} last />
        </SectionCard>

        {/* Storage & Language */}
        <SectionLabel label={t?.('config.storage') || 'GERAL'} />
        <SectionCard>
          <SettingItem icon={<IconSmartphone size={18} color="#f59e0b" />} iconBg={isDark ? 'rgba(245,158,11,0.1)' : '#fef3c7'}
            title={t?.('config.storage') || 'Armazenamento e dados'}
            subtitle={t?.('config.storageDesc') || 'Uso de rede, download automatico'}
            colors={colors} isDark={isDark} onPress={() => setSubScreen('storage')} />
          <SettingItem icon={<IconTranslate size={18} color="#06b6d4" />} iconBg={isDark ? 'rgba(6,182,212,0.1)' : '#ecfeff'}
            title={t?.('config.language') || 'Idioma do app'}
            subtitle={LANGUAGES.find(l => l.code === language)?.label || 'Portugues (BR)'}
            colors={colors} isDark={isDark} onPress={() => setSubScreen('language')} last />
        </SectionCard>

        {/* Help & Invite */}
        <SectionLabel label={t?.('config.help') || 'SUPORTE'} />
        <SectionCard>
          <SettingItem icon={<IconInfo size={18} color="#6b7280" />} iconBg={isDark ? 'rgba(107,114,128,0.1)' : '#f3f4f6'}
            title={t?.('config.help') || 'Ajuda'}
            subtitle={t?.('config.helpDesc') || 'Central de ajuda, contato, termos e privacidade'}
            colors={colors} isDark={isDark} onPress={() => setSubScreen('help')} last />
        </SectionCard>

        {/* Invite Friends - prominent card */}
        <TouchableOpacity
          style={[styles.inviteCard, {
            backgroundColor: isDark ? 'rgba(124,58,237,0.06)' : '#f0fdf4',
            borderColor: isDark ? 'rgba(124,58,237,0.15)' : 'rgba(124,58,237,0.2)',
          }, smallShadow(isDark)]}
          onPress={handleInvite}
          activeOpacity={0.8}
        >
          <View style={[styles.inviteIconWrap, { backgroundColor: ACCENT }, Platform.select({
            ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 6 },
            android: { elevation: 3 },
            web: { boxShadow: '0 2px 10px rgba(124,58,237,0.3)' },
          })]}>
            <IconHeart size={18} color="#fff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.inviteTitle, { color: isDark ? '#4ade80' : '#166534' }]}>{t?.('config.invite') || 'Convidar amigos'}</Text>
            <Text style={[styles.inviteSubtitle, { color: isDark ? 'rgba(74,222,128,0.5)' : 'rgba(21,128,61,0.6)' }]}>{t?.('config.inviteDesc') || 'Compartilhar o Chatyy com seus contatos'}</Text>
          </View>
          <IconChevronRight size={18} color={isDark ? '#4ade80' : '#166534'} />
        </TouchableOpacity>

        {/* Chat Backup */}
        <SectionCard style={{ marginTop: 6 }}>
          <TouchableOpacity
            onPress={handleBackupNow}
            disabled={backupRunning}
            style={[styles.backupRow, { opacity: backupRunning ? 0.7 : 1 }]}
            activeOpacity={0.7}
          >
            <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(124,58,237,0.1)' : '#ecfdf5' }]}>
              {backupRunning ? (
                <ActivityIndicator size="small" color={ACCENT} />
              ) : backupResult?.success ? (
                <IconCheck size={18} color={ACCENT} />
              ) : (
                <IconUpload size={18} color={ACCENT} />
              )}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.switchLabel, { color: colors.text }]}>
                {backupRunning
                  ? `${t?.('chat.backupInProgress') || 'Fazendo backup...'} ${backupElapsed}s`
                  : backupResult?.success
                    ? (t?.('chat.backupComplete') || 'Backup concluido!')
                    : (t?.('chat.backupNow') || 'Fazer backup agora')}
              </Text>
              {backupRunning ? (
                <Text style={[styles.switchDesc, { color: isDark ? '#6b7280' : '#9ca3af' }]}>
                  {t?.('chat.backupPreparing') || 'Isso pode levar alguns segundos...'}
                </Text>
              ) : backupResult?.success ? (
                <Text style={[styles.switchDesc, { color: ACCENT }]}>
                  {`${backupResult.conversations} ${t?.('chat.backupConversations') || 'conversas'}, ${backupResult.messages} ${t?.('chat.backupMessages') || 'mensagens'}`}
                </Text>
              ) : backupResult === 'error' ? (
                <Text style={[styles.switchDesc, { color: '#dc2626' }]}>
                  {t?.('chat.backupErrorDesc') || 'Erro ao fazer backup. Tente novamente.'}
                </Text>
              ) : (
                <Text style={[styles.switchDesc, { color: isDark ? '#6b7280' : '#9ca3af' }]}>
                  {t?.('chat.backupDescWeb') || 'Criar backup das suas conversas'}
                </Text>
              )}
            </View>
            {!backupRunning && !backupResult?.success && (
              <IconChevronRight size={16} color={isDark ? '#4b5563' : '#c5c5c5'} />
            )}
          </TouchableOpacity>

          {/* Restore backup button */}
          <View style={[styles.rowSeparator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }]} />
          <TouchableOpacity
            onPress={handleRestoreOpen}
            disabled={restoreRunning}
            style={[styles.backupRow, { opacity: restoreRunning ? 0.7 : 1 }]}
            activeOpacity={0.7}
          >
            <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(59,130,246,0.1)' : '#F5F3FF' }]}>
              {restoreRunning ? (
                <ActivityIndicator size="small" color="#A78BFA" />
              ) : (
                <IconDownload size={18} color="#A78BFA" />
              )}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.switchLabel, { color: colors.text }]}>
                {restoreRunning
                  ? (t?.('chat.restoreInProgress') || 'Restaurando...')
                  : (t?.('chat.restoreBackup') || 'Restaurar backup')}
              </Text>
              <Text style={[styles.switchDesc, { color: isDark ? '#6b7280' : '#9ca3af' }]}>
                {restoreResult
                  ? (t?.('chat.restoreSuccessMsg') || '{convs} conversas e {msgs} mensagens restauradas')
                      .replace('{convs}', restoreResult.conversations)
                      .replace('{msgs}', restoreResult.messages)
                  : (t?.('chat.restoreBackupDesc') || 'Restaurar conversas de um backup anterior')}
              </Text>
            </View>
            {!restoreRunning && (
              <IconChevronRight size={16} color={isDark ? '#4b5563' : '#c5c5c5'} />
            )}
          </TouchableOpacity>
        </SectionCard>

        {/* Restore Backup Modal */}
        <Modal
          visible={restoreModalVisible}
          animationType="slide"
          transparent
          onRequestClose={() => setRestoreModalVisible(false)}
        >
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
            <View style={{
              backgroundColor: surfaceBg,
              borderTopLeftRadius: 20, borderTopRightRadius: 20,
              maxHeight: '70%', paddingBottom: 40,
            }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }}>
                <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>
                  {t?.('chat.restoreBackupTitle') || 'Restaurar backup'}
                </Text>
                <TouchableOpacity onPress={() => setRestoreModalVisible(false)} style={{ padding: 4 }}>
                  <IconX size={20} color={colors.text} />
                </TouchableOpacity>
              </View>

              {restoreLoading ? (
                <View style={{ padding: 40, alignItems: 'center' }}>
                  <ActivityIndicator size="large" color={ACCENT} />
                  <Text style={{ color: isDark ? '#6b7280' : '#9ca3af', marginTop: 12 }}>
                    {t?.('common.loading') || 'Carregando...'}
                  </Text>
                </View>
              ) : backupsList.length === 0 ? (
                <View style={{ padding: 40, alignItems: 'center' }}>
                  <IconUpload size={40} color={isDark ? '#374151' : '#d1d5db'} />
                  <Text style={{ color: isDark ? '#6b7280' : '#9ca3af', marginTop: 12, textAlign: 'center' }}>
                    {t?.('chat.noBackups') || 'Nenhum backup'}
                  </Text>
                </View>
              ) : (
                <ScrollView style={{ maxHeight: 400 }}>
                  {backupsList.map((backup, index) => {
                    const date = new Date(backup.date);
                    const dateStr = date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                    const sizeStr = backup.size > 1024 * 1024
                      ? (backup.size / (1024 * 1024)).toFixed(1) + ' MB'
                      : (backup.size / 1024).toFixed(0) + ' KB';
                    const convCount = backup.conversation_count || 0;
                    const msgCount = backup.message_count || 0;

                    return (
                      <View key={backup.id}>
                        <TouchableOpacity
                          style={{ paddingHorizontal: 16, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 14 }}
                          onPress={() => handleRestoreBackup(backup.id)}
                          disabled={restoreRunning}
                          activeOpacity={0.7}
                        >
                          <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(59,130,246,0.1)' : '#F5F3FF' }]}>
                            <IconFileText size={18} color="#A78BFA" />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={{ color: colors.text, fontSize: 15, fontWeight: '500' }}>{dateStr}</Text>
                            <Text style={{ color: isDark ? '#6b7280' : '#9ca3af', fontSize: 12, marginTop: 2 }}>
                              {convCount} {t?.('chat.conversations') || 'conversas'} · {msgCount} {t?.('chat.messagesCount') || 'mensagens'} · {sizeStr}
                            </Text>
                          </View>
                          <IconChevronRight size={16} color={isDark ? '#4b5563' : '#c5c5c5'} />
                        </TouchableOpacity>
                        {index < backupsList.length - 1 && (
                          <View style={[styles.rowSeparator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)', marginLeft: 66 }]} />
                        )}
                      </View>
                    );
                  })}
                </ScrollView>
              )}
            </View>
          </View>
        </Modal>

        {/* Logout */}
        <SectionCard style={{ marginTop: 12, backgroundColor: isDark ? 'rgba(220,38,38,0.04)' : '#fef2f2' }}>
          <TouchableOpacity style={styles.logoutRowModern} onPress={handleLogout} activeOpacity={0.7}>
            <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(220,38,38,0.1)' : '#fee2e2' }]}>
              <IconLogout size={16} color="#dc2626" />
            </View>
            <Text style={styles.logoutTextModern}>{t?.('config.logout') || 'Sair da conta'}</Text>
          </TouchableOpacity>
        </SectionCard>

        {/* App Info */}
        <View style={styles.appInfoModern}>
          <View style={styles.appLogoWrap}>
            <Text style={[styles.appLogoText, { color: ACCENT }]}>C</Text>
          </View>
          <Text style={[styles.appNameModern, { color: isDark ? '#374151' : '#d1d5db' }]}>Chatyy</Text>
          <Text style={[styles.appVersionModern, { color: isDark ? '#1f2937' : '#e5e7eb' }]}>by Chatyy · v1.4.0</Text>
        </View>
      </Animated.ScrollView>

      {/* Caller ID verification overlay */}
      <Modal visible={showVerifyCallerId} transparent animationType="fade" onRequestClose={() => setShowVerifyCallerId(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 20 }}>
          <CallerIdVerifyContent
            isDark={isDark}
            t={t}
            onClose={() => setShowVerifyCallerId(false)}
            onVerified={() => {
              setShowVerifyCallerId(false);
              setProfile(prev => ({ ...(prev || {}), telnyx_caller_id_verified: true }));
            }}
          />
        </View>
      </Modal>
    </View>
  );
}

function SettingItem({ icon, iconBg, title, subtitle, colors, isDark, onPress, last }) {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = () => {
    Animated.spring(scaleAnim, { toValue: 0.98, useNativeDriver: false, tension: 300, friction: 10 }).start();
  };
  const handlePressOut = () => {
    Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: false, tension: 200, friction: 12 }).start();
  };

  return (
    <>
      <TouchableOpacity
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        activeOpacity={1}
      >
        <Animated.View style={[styles.settingItemModern, { transform: [{ scale: scaleAnim }] }]}>
          <View style={[styles.iconCircle, { backgroundColor: iconBg || 'transparent' }]}>{icon}</View>
          <View style={styles.settingContent}>
            <Text style={[styles.settingTitleModern, { color: colors.text }]}>{title}</Text>
            {subtitle ? <Text style={[styles.settingSubtitleModern, { color: isDark ? '#6b7280' : '#9ca3af' }]} numberOfLines={1}>{subtitle}</Text> : null}
          </View>
          <IconChevronRight size={16} color={isDark ? '#4b5563' : '#c5c5c5'} />
        </Animated.View>
      </TouchableOpacity>
      {!last && (
        <View style={[styles.rowSeparator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)', marginLeft: 56 }]} />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  // Sub-screen header
  subHeader: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, zIndex: 10,
  },
  subBackBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  subBackCircle: {
    width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
  },
  subTitle: { fontSize: 20, fontWeight: '700', flex: 1, letterSpacing: -0.3 },

  // Section Card
  sectionCard: {
    borderRadius: 12, marginHorizontal: 16, marginVertical: 6, overflow: 'hidden',
  },

  // Section Label
  sectionLabel: {
    fontSize: 11.5, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8,
    paddingHorizontal: 32, paddingTop: 22, paddingBottom: 6,
  },

  // Row separator
  rowSeparator: { height: StyleSheet.hairlineWidth, marginRight: 0 },

  // Full-width divider
  dividerFull: { height: StyleSheet.hairlineWidth },

  // Icon circle for menu items
  iconCircle: {
    width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
  },

  // Profile Card Modern
  profileCardModern: {
    borderRadius: 16, marginHorizontal: 16, marginTop: 12, marginBottom: 6,
    overflow: 'hidden',
  },
  profileGradientBg: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 80,
  },
  profileGradient: {
    flex: 1, opacity: 0.5,
  },
  profileCardContent: {
    alignItems: 'center', paddingTop: 24, paddingBottom: 24, paddingHorizontal: 20,
  },
  avatarContainerModern: { position: 'relative' },
  avatarBrandRing: {
    // Brand purple halo around 96px avatar — signals "your Chatyy identity".
    // 2.5px border with halo padding lifts the avatar off the gradient bg.
    padding: 3, borderRadius: 54, borderWidth: 2.5,
  },
  avatarModern: { width: 96, height: 96, borderRadius: 48 },
  cameraOverlayModern: {
    position: 'absolute', bottom: 0, right: 0,
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center',
    borderWidth: 3, borderColor: '#fff',
  },
  profileInfoModern: { alignItems: 'center', marginTop: 16, width: '100%' },
  profileNameModern: { fontSize: 22, fontWeight: '600', letterSpacing: 0 },
  profileEmailModern: { fontSize: 13, marginTop: 4, letterSpacing: 0.2 },
  profilePhoneRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4 },
  profilePhoneText: { fontSize: 13, letterSpacing: 0.2 },
  verifiedDot: { width: 7, height: 7, borderRadius: 3.5, marginLeft: 2 },
  profileAboutModern: { fontSize: 13, lineHeight: 18 },
  editableTouchable: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
  },
  aboutTouchable: {},
  aboutPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20,
  },

  editRow: { flexDirection: 'row', alignItems: 'center', gap: 6, width: '100%', paddingHorizontal: 20 },
  editInputModern: { fontSize: 16, fontWeight: '600', borderBottomWidth: 2, paddingVertical: 4, flex: 1, textAlign: 'center', ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) },
  editActionBtn: { padding: 6 },

  // Setting Item Modern
  settingItemModern: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16, minHeight: 58 },
  settingContent: { flex: 1, marginLeft: 14 },
  settingTitleModern: { fontSize: 16, fontWeight: '500', letterSpacing: 0 },
  settingSubtitleModern: { fontSize: 12.5, marginTop: 2, lineHeight: 16 },

  // Phone row modern
  phoneRowModern: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, gap: 14 },
  phoneLabelModern: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  phoneValueModern: { fontSize: 15, fontWeight: '500' },
  phoneHintModern: { fontSize: 12, paddingHorizontal: 66, paddingBottom: 16, lineHeight: 17 },
  verifiedBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10,
  },
  verifiedText: { fontSize: 10, color: ACCENT, fontWeight: '700' },

  // Privacy
  privacyLabel: {
    fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5,
    paddingHorizontal: 20, paddingTop: 18, paddingBottom: 8,
  },
  privacyLabelInline: {
    fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5,
  },
  radioGroup: { paddingHorizontal: 20 },
  radioRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  radioActive: { borderColor: ACCENT },
  radioDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: ACCENT },
  radioLabel: { fontSize: 15 },

  // Switch rows modern
  switchRowModern: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, minHeight: 56 },
  switchLabel: { fontSize: 15, fontWeight: '500' },
  switchDesc: { fontSize: 12, marginTop: 2, lineHeight: 16 },

  // Link rows modern
  linkRowModern: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, gap: 14, minHeight: 56 },
  linkText: { flex: 1, fontSize: 15, fontWeight: '500' },
  linkCount: { fontSize: 14, fontWeight: '500' },
  deviceSubLine: { fontSize: 11.5, marginTop: 2, letterSpacing: 0.15 },

  // Button group
  btnGroup: { flexDirection: 'row', gap: 6 },
  btnOption: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, borderWidth: 1 },
  btnOptionActive: { backgroundColor: ACCENT, borderColor: ACCENT },
  btnOptionText: { fontSize: 13, fontWeight: '600' },
  btnOptionTextActive: { color: '#fff' },

  enableBtnModern: { paddingHorizontal: 18, paddingVertical: 8, borderRadius: 20, backgroundColor: ACCENT },

  // Storage modern
  storageInfoModern: { alignItems: 'center', paddingVertical: 32, paddingHorizontal: 24 },
  storageIconCircle: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  storageTitle: { fontSize: 17, fontWeight: '600', marginTop: 8 },
  storageDesc: { fontSize: 13, textAlign: 'center', marginTop: 6, lineHeight: 18 },

  // Language modern
  langRowModern: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, minHeight: 56 },
  langFlag: { fontSize: 24, marginRight: 14 },
  langName: { flex: 1, fontSize: 16, fontWeight: '500' },
  checkCircle: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },

  // Help modern
  helpRowModern: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, gap: 14, minHeight: 56 },

  // Invite card
  inviteCard: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: 16, marginVertical: 8, borderRadius: 18,
    paddingHorizontal: 16, paddingVertical: 18, gap: 14,
    borderWidth: 1,
  },
  inviteIconWrap: {
    width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center',
  },
  inviteTitle: { fontSize: 15, fontWeight: '700' },
  inviteSubtitle: { fontSize: 12, marginTop: 2 },

  // Backup row
  backupRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, gap: 14, minHeight: 56 },

  // Logout modern
  logoutRowModern: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 16, minHeight: 56 },
  logoutTextModern: { fontSize: 15, fontWeight: '600', color: '#dc2626' },

  // Delete account
  deleteAccountRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 16, minHeight: 56 },
  deleteAccountText: { fontSize: 15, fontWeight: '600', color: '#dc2626' },

  // App Info modern
  appInfoModern: { alignItems: 'center', paddingVertical: 36 },
  appLogoWrap: {
    width: 44, height: 44, borderRadius: 12, backgroundColor: ACCENT,
    alignItems: 'center', justifyContent: 'center', marginBottom: 10,
    ...Platform.select({
      ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 6 },
      android: { elevation: 3 },
      web: { boxShadow: '0 2px 10px rgba(124,58,237,0.25)' },
    }),
  },
  appLogoText: { fontSize: 24, fontWeight: '900', color: '#fff' },
  appNameModern: { fontSize: 18, fontWeight: '800', letterSpacing: 0.5 },
  appNameBig: { fontSize: 26, fontWeight: '800', letterSpacing: 1.5 },
  appVersionModern: { fontSize: 11, marginTop: 4, letterSpacing: 0.3 },

  // Password input modern
  pwInputModern: { fontSize: 15, borderWidth: 1, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 13, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) },

  // Change password button
  changePwBtn: {
    backgroundColor: ACCENT, paddingHorizontal: 24, paddingVertical: 13,
    borderRadius: 14, alignSelf: 'flex-start', marginTop: 4,
    ...Platform.select({
      ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 6 },
      android: { elevation: 3 },
      web: { boxShadow: '0 2px 10px rgba(124,58,237,0.3)' },
    }),
  },

  // Blocked contacts modern
  blockedRowModern: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 14 },
  blockedEmail: { flex: 1, fontSize: 15, fontWeight: '500' },
  unblockBtn: {
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 12,
    backgroundColor: '#fef2f2', borderWidth: 1, borderColor: '#fecaca',
  },
});
