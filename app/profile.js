import { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, StyleSheet, ScrollView, ActivityIndicator, Platform, Alert, Image, Animated, KeyboardAvoidingView,
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
} from '../components/Icons';
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
    // Try to extract iPhone model
    const match = ua.match(/iPhone\s*([\d,]+)?/i);
    deviceName = 'iPhone';
  } else if (/Android/i.test(ua)) {
    type = 'mobile';
    // Try to extract device model
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
  // Try parsing DD/MM/YYYY or YYYY-MM-DD or other formats
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

export default function ProfileScreen() {
  const { user, updateUser } = useAuth();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();
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

  // Inline editing states
  const [editingField, setEditingField] = useState(null); // 'name' | 'phone' | 'birthday' | 'recovery'
  const [editValue, _setEditValue] = useState('');
  const editValueRef = useRef('');
  const setEditValue = (v) => { editValueRef.current = v; _setEditValue(v); };
  const scrollViewRef = useRef(null);

  // Keyboard handling removed - let ScrollView handle it natively

  // Animations
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const avatarScale = useRef(new Animated.Value(0.7)).current;
  const card1Slide = useRef(new Animated.Value(30)).current;
  const card1Opacity = useRef(new Animated.Value(0)).current;
  const card2Slide = useRef(new Animated.Value(30)).current;
  const card2Opacity = useRef(new Animated.Value(0)).current;
  const card3Slide = useRef(new Animated.Value(30)).current;
  const card3Opacity = useRef(new Animated.Value(0)).current;
  const card4Slide = useRef(new Animated.Value(30)).current;
  const card4Opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Fade in whole page
    Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    // Avatar scale pop
    Animated.spring(avatarScale, { toValue: 1, tension: 80, friction: 8, useNativeDriver: true, delay: 150 }).start();
    // Staggered card slide-in
    const cardAnims = [
      { slide: card1Slide, opacity: card1Opacity },
      { slide: card2Slide, opacity: card2Opacity },
      { slide: card3Slide, opacity: card3Opacity },
      { slide: card4Slide, opacity: card4Opacity },
    ];
    cardAnims.forEach((c, i) => {
      setTimeout(() => {
        Animated.parallel([
          Animated.timing(c.slide, { toValue: 0, duration: 350, useNativeDriver: true }),
          Animated.timing(c.opacity, { toValue: 1, duration: 350, useNativeDriver: true }),
        ]).start();
      }, 200 + i * 100);
    });
  }, []);

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    try {
      // Show cached profile instantly
      const { getCached, setCache } = await import('../services/cache');
      const cached = await getCached('user_profile');
      if (cached) {
        setProfile(cached);
        if (cached.has_avatar || cached.avatar) setAvatarUrl(api.getAvatarUrlForEmail(user?.email));
      }
      // Fetch fresh profile data in background
      const r = await api.getProfile();
      if (r.success) {
        setProfile(r.data || {});
        if (r.data?.has_avatar || r.data?.avatar) setAvatarUrl(api.getAvatarUrlForEmail(user?.email));
        setCache('user_profile', r.data, 600000).catch(() => {});
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

      const r = await api.updateProfile(payload);
      if (r.success) {
        setSaveMsg(t('profile.saved'));
        setEditingField(null);
        loadProfile();
        // Update auth context so name reflects everywhere (sidebar, chat, email)
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

  const avatarColor = getAvatarColor(user?.name || user?.email);
  const displayName = profile?.display_name || profile?.name || user?.name || '';
  const age = calculateAge(profile?.birthday);
  const formattedBirthday = formatBirthday(profile?.birthday);
  const memberSince = formatMemberSince(profile?.created_at);

  // Device icon component
  const DeviceIcon = ({ type, size = 22, color }) => {
    if (type === 'mobile') return <IconSmartphone size={size} color={color} />;
    if (type === 'tablet') return <IconSmartphone size={size} color={color} />;
    return <IconMonitor size={size} color={color} />;
  };

  // Editable info row - uses LOCAL state for TextInput to prevent keyboard dismiss
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
                  // Scroll to make the editing field visible above keyboard
                  setTimeout(() => {
                    if (rowRef.current && scrollViewRef.current) {
                      rowRef.current.measureLayout?.(
                        scrollViewRef.current.getInnerViewNode?.() || scrollViewRef.current,
                        (x, y) => {
                          scrollViewRef.current.scrollTo?.({ y: Math.max(0, y - 120), animated: true });
                        },
                        () => {
                          // fallback: just scroll down
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

  return (
    <View style={[s.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[s.header, { backgroundColor: colors.surface + 'F0' }]}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} accessibilityLabel="Back" accessibilityRole="button">
          <IconArrowLeft size={24} color={colors.textSecondary} />
        </TouchableOpacity>
        <View style={s.headerContent}>
          <Text style={[s.headerTitle, { color: colors.text }]}>{t('profile.title')}</Text>
          <Text style={[s.headerSubtitle, { color: colors.textTertiary }]}>{t('profile.manageAccount')}</Text>
        </View>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
      <Animated.ScrollView ref={scrollViewRef} contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ opacity: fadeAnim }}>
        {/* Profile card with avatar */}
        <Animated.View style={[s.profileCard, { backgroundColor: colors.surface + 'F0', borderColor: colors.borderLight + '40', transform: [{ translateY: card1Slide }], opacity: card1Opacity }]}>
          <TouchableOpacity onPress={handleAvatarUpload} style={s.avatarWrap} activeOpacity={0.7} accessibilityLabel="Change avatar" accessibilityRole="button">
            <Animated.View style={[s.avatarRing, { transform: [{ scale: avatarScale }] }, Platform.select({
              web: { background: `linear-gradient(135deg, ${colors.primary}, #8b5cf6, #ec4899)` },
              default: { backgroundColor: colors.primary },
            })]}>
              {avatarUrl ? (
                <View style={s.avatarInner}>
                  {Platform.OS === 'web' ? (
                    <img src={avatarUrl} style={{ width: 108, height: 108, borderRadius: 54, objectFit: 'cover' }} alt="avatar" />
                  ) : (
                    <Image source={{ uri: avatarUrl }} style={{ width: 108, height: 108, borderRadius: 54 }} />
                  )}
                </View>
              ) : (
                <View style={[s.avatarInner, { backgroundColor: avatarColor }]}>
                  <Text style={s.avatarText}>{(user?.name || user?.email || '?')[0].toUpperCase()}</Text>
                </View>
              )}
            </Animated.View>
            <View style={[s.avatarBadge, { backgroundColor: colors.primary, borderColor: colors.surface }]}>
              {uploadingAvatar
                ? <ActivityIndicator size="small" color="#fff" />
                : <IconImage size={14} color="#fff" />
              }
            </View>
          </TouchableOpacity>
          <Text style={[s.profileName, { color: colors.text }]}>
            {displayName || t('profile.user')}
          </Text>
          <Text style={[s.profileEmail, { color: colors.textSecondary }]}>{user?.email}</Text>
          {memberSince && (
            <View style={[s.memberSinceBadge, { backgroundColor: colors.primary + '10' }]}>
              <IconClock size={12} color={colors.primary} />
              <Text style={[s.memberSinceText, { color: colors.primary }]}>
                {t('profile.memberSince')} {memberSince}
              </Text>
            </View>
          )}
        </Animated.View>

        {!!saveMsg && (
          <View style={[s.saveMsgWrap, { backgroundColor: saveMsg === t('profile.saved') ? (colors.successBg || '#dcfce7') : (colors.errorBg || '#fef2f2') }]}>
            <Text style={[s.saveMsgText, { color: saveMsg === t('profile.saved') ? (colors.success || '#16a34a') : (colors.error || '#dc2626') }]}>{saveMsg}</Text>
          </View>
        )}

        {/* Personal Info section */}
        <Animated.View style={[s.section, { backgroundColor: colors.surface + 'F0', borderColor: colors.borderLight + '40', transform: [{ translateY: card2Slide }], opacity: card2Opacity }]}>
          <View style={s.sectionHeader}>
            <Text style={[s.sectionTitle, { color: colors.text }]}>{t('profile.personalInfo')}</Text>
          </View>

          <InfoRow icon={IconMail} iconColor="#ea4335" label={t('profile.email')} value={user?.email} />

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
        </Animated.View>

        {/* Security section */}
        <Animated.View style={[s.section, { backgroundColor: colors.surface + 'F0', borderColor: colors.borderLight + '40', transform: [{ translateY: card3Slide }], opacity: card3Opacity }]}>
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
        </Animated.View>

        {/* Sessions / Your Devices */}
        <Animated.View style={[s.section, { backgroundColor: colors.surface + 'F0', borderColor: colors.borderLight + '40', transform: [{ translateY: card4Slide }], opacity: card4Opacity }]}>
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

                  {/* Sign out all other devices */}
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
        </Animated.View>

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

        <View style={{ height: 40 }} />
      </Animated.ScrollView>
      </KeyboardAvoidingView>

      <ChangePasswordModal visible={showChangePassword} onClose={() => setShowChangePassword(false)} />
      <TwoFactorSetup visible={showTwoFactor} onClose={() => setShowTwoFactor(false)} />
      <VacationResponder visible={showVacation} onClose={() => setShowVacation(false)} />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8 },
      android: { elevation: 3 },
      web: { boxShadow: '0 1px 12px rgba(0,0,0,0.06)', backdropFilter: 'blur(20px) saturate(180%)', WebkitBackdropFilter: 'blur(20px) saturate(180%)' },
    }),
  },
  backBtn: { padding: Spacing.sm, marginRight: Spacing.sm, borderRadius: 20 },
  headerContent: { flex: 1 },
  headerTitle: { fontSize: FontSize.xxl, fontWeight: '700', letterSpacing: -0.3 },
  headerSubtitle: { fontSize: FontSize.sm, marginTop: 1, opacity: 0.7 },

  scroll: { padding: Spacing.lg, maxWidth: 600, alignSelf: 'center', width: '100%' },

  // Profile card
  profileCard: {
    alignItems: 'center', padding: Spacing.xl, paddingTop: Spacing.xxxl, paddingBottom: Spacing.xl,
    borderRadius: 24, marginBottom: Spacing.lg, borderWidth: 1,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.08, shadowRadius: 16 },
      android: { elevation: 4 },
      web: { boxShadow: '0 4px 24px rgba(0,0,0,0.06)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' },
    }),
  },
  avatarWrap: { position: 'relative', marginBottom: Spacing.lg },
  avatarRing: {
    width: 116, height: 116, borderRadius: 58, padding: 4,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 12 },
      android: { elevation: 6 },
      web: { boxShadow: '0 4px 20px rgba(99,102,241,0.3)' },
    }),
  },
  avatarInner: {
    width: 108, height: 108, borderRadius: 54,
    justifyContent: 'center', alignItems: 'center', overflow: 'hidden',
  },
  avatarText: { color: '#fff', fontSize: 40, fontWeight: '700' },
  avatarBadge: {
    position: 'absolute', bottom: 0, right: 0,
    width: 34, height: 34, borderRadius: 17,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 3,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 4 },
      android: { elevation: 4 },
      web: { boxShadow: '0 2px 8px rgba(0,0,0,0.15)' },
    }),
  },
  profileName: { fontSize: FontSize.title, fontWeight: '700', letterSpacing: -0.3, textAlign: 'center' },
  profileEmail: { fontSize: FontSize.base, marginTop: Spacing.xs, opacity: 0.6, textAlign: 'center' },
  memberSinceBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: Spacing.md, paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20,
  },
  memberSinceText: { fontSize: FontSize.xs, fontWeight: '600' },

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
