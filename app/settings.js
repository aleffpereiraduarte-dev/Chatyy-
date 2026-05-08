import ErrorBoundary from "../components/ErrorBoundary";
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  Switch, ActivityIndicator, Platform, Alert, Image, Linking, Share, Modal, Pressable,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import AvatarCircle from '../components/AvatarCircle';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import {
  IconArrowLeft, IconSparkles, IconMessageSquare, IconPenTool, IconDraft,
  IconFilter, IconChevronRight, IconGlobe, IconTrash, IconBell, IconForward,
  IconShield, IconFileText, IconUser, IconUsers, IconPlus, IconShare, IconCheck,
  IconMail, IconPhone, IconAlertTriangle, IconCopy,
} from '../components/Icons';
import { useBiometric } from '../context/BiometricContext';
import { useConfirm } from '../components/ConfirmModal';
import { useAuth } from '../context/AuthContext';
import FilterRuleEditor from '../components/FilterRuleEditor';
import { PrivacyModal, TermsModal } from '../components/LoginModals';
import * as api from '../services/api';
import { getCached, setCache } from '../services/cache';
import { SettingsSkeleton } from '../components/SkeletonLoader';

function getStorage(key) {
  if (Platform.OS === 'web') {
    try { return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null; } catch { return null; }
  }
  return null; // async handled separately
}
function setStorage(key, val) {
  if (Platform.OS === 'web') {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, val); } catch {}
  } else {
    import('@react-native-async-storage/async-storage').then(m => m.default.setItem(key, val)).catch(() => {});
  }
}

function SettingsScreenInner() {
  const { colors, isDark, toggle, density, setDensity } = useTheme();
  const { t, language, changeLanguage } = useLanguage();
  const { biometricEnabled, biometricAvailable, toggleBiometric } = useBiometric();
  const { logout, user } = useAuth();
  const confirm = useConfirm();
  const router = useRouter();
  const params = useLocalSearchParams();
  const insets = useSafeAreaInsets();

  // Scroll-to-section when opened from ProfileSettingsSheet with ?section=X.
  // onLayout y-coords are relative to the PARENT view, which doesn't work
  // when the target row is nested inside a section card. We stash a ref for
  // each named anchor and measure it against the ScrollView's native handle
  // so we get an absolute offset. Runs once the node is mounted *and* the
  // requested section matches.
  const scrollRef = useRef(null);
  const sectionRefs = useRef({});
  const requestedSection = typeof params?.section === 'string' ? params.section : null;
  const registerSectionRef = useCallback((key) => (node) => {
    if (!node) return;
    sectionRefs.current[key] = node;
    if (key === requestedSection && scrollRef.current) {
      // Defer until layout settles — RN measureLayout against a freshly-
      // mounted ScrollView can yield stale coords on the first call.
      setTimeout(() => {
        try {
          const scrollNode = scrollRef.current?.getInnerViewNode?.()
            || scrollRef.current?._nativeRef
            || scrollRef.current;
          if (!scrollNode || !node.measureLayout) return;
          node.measureLayout(
            scrollNode,
            (_x, y) => { scrollRef.current?.scrollTo?.({ y: Math.max(0, y - 12), animated: true }); },
            () => {}
          );
        } catch {}
      }, 120);
    }
  }, [requestedSection]);
  const [undoDelay, setUndoDelay] = useState(5);
  const [smartComposeOn, setSmartComposeOn] = useState(true);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [deleteAcknowledged, setDeleteAcknowledged] = useState(false);
  const [deleteTypedWord, setDeleteTypedWord] = useState('');
  // Alterar senha — modal state
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [cpCurrent, setCpCurrent] = useState('');
  const [cpNew, setCpNew] = useState('');
  const [cpConfirm, setCpConfirm] = useState('');
  const [cpLoading, setCpLoading] = useState(false);
  const [cpError, setCpError] = useState('');
  const [cpSuccess, setCpSuccess] = useState(false);
  // 2FA PIN modal state
  const [twoFAOpen, setTwoFAOpen] = useState(false);
  const [twoFADigits, setTwoFADigits] = useState(['', '', '', '']);
  const twoFARefs = useRef([null, null, null, null]);
  const [twoFALoading, setTwoFALoading] = useState(false);
  const [twoFAError, setTwoFAError] = useState('');
  const [twoFASuccess, setTwoFASuccess] = useState(false);
  // Registration Lock (anti-SIM-swap) PIN modal — same shape as 2FA but
  // writes to a different backend key (registration_lock vs 2fa_pin) and
  // gates phone-OTP login instead of password login.
  const [regLockOpen, setRegLockOpen] = useState(false);
  const [regLockDigits, setRegLockDigits] = useState(['', '', '', '']);
  const regLockRefs = useRef([null, null, null, null]);
  const [regLockLoading, setRegLockLoading] = useState(false);
  const [regLockError, setRegLockError] = useState('');
  const [regLockSuccess, setRegLockSuccess] = useState(false);
  const [oneEnabled, setOneEnabled] = useState(true);
  const [oneNotifLevel, setOneNotifLevel] = useState('push'); // 'email', 'push', 'urgent' — for One AI
  const [pushNotifLevel, setPushNotifLevel] = useState('all'); // 'all', 'urgent', 'silent' — global push delivery
  const [avatarKey, setAvatarKey] = useState(Date.now());
  // Referral system
  const [referralCode, setReferralCode] = useState('');
  const [referralCount, setReferralCount] = useState(0);
  const [referralLoading, setReferralLoading] = useState(false);

  useEffect(() => {
    if (Platform.OS === 'web') {
      const oe = getStorage('one_enabled');
      if (oe === 'false') setOneEnabled(false);
      const ol = getStorage('one_notif_level');
      if (ol) setOneNotifLevel(ol);
      const pl = getStorage('push_notif_level');
      if (pl) setPushNotifLevel(pl);
    } else {
      import('@react-native-async-storage/async-storage').then(m => {
        Promise.all([
          m.default.getItem('one_enabled'),
          m.default.getItem('one_notif_level'),
          m.default.getItem('push_notif_level'),
        ]).then(([enabled, level, pushLevel]) => {
          if (enabled === 'false') setOneEnabled(false);
          if (level) setOneNotifLevel(level);
          if (pushLevel) setPushNotifLevel(pushLevel);
        }).catch(() => {});
      }).catch(() => {});
    }
  }, []);

  const [settings, setSettings] = useState({
    signature: '',
    emails_per_page: 20,
    notifications: true,
    notification_sound: true,
    notification_vibration: true,
    language: 'pt-BR',
    auto_reply: false,
    auto_reply_message: '',
    forwarding_email: '',
    forwarding_enabled: false,
    font_size: 'medium',
    read_receipts: false,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const savedTimerRef = require('react').useRef(null);
  const initialSettingsRef = require('react').useRef(null);
  const [showFilters, setShowFilters] = useState(false);
  const [notifPermission, setNotifPermission] = useState(
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'default'
  );

  useEffect(() => {
    loadSettings();
    // Load undo delay + smart compose + notif prefs
    if (Platform.OS === 'web') {
      const d = getStorage('undo_send_delay');
      if (d) setUndoDelay(parseInt(d, 10) || 5);
      const sc = getStorage('smart_compose');
      if (sc === 'false') setSmartComposeOn(false);
      try {
        const np = getStorage('notif_prefs');
        if (np) {
          const parsed = JSON.parse(np);
          setSettings(prev => ({ ...prev, ...parsed }));
        }
      } catch {}
    } else {
      import('@react-native-async-storage/async-storage').then(m => {
        m.default.getItem('undo_send_delay').then(d => {
          if (d) setUndoDelay(parseInt(d, 10) || 5);
        }).catch(() => {});
        m.default.getItem('smart_compose').then(v => {
          if (v === 'false') setSmartComposeOn(false);
        }).catch(() => {});
        m.default.getItem('notif_prefs').then(v => {
          if (v) {
            try {
              const parsed = JSON.parse(v);
              setSettings(prev => ({ ...prev, ...parsed }));
            } catch {}
          }
        }).catch(() => {});
      }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  // Load referral code
  useEffect(() => {
    api.getReferralCode().then(r => {
      if (r.success && r.data) {
        setReferralCode(r.data.code || '');
        setReferralCount(r.data.referred_count || 0);
      }
    }).catch(() => {});
  }, []);

  const handleShareReferral = async () => {
    const link = `https://chatyy.com.br/signup?ref=${referralCode}`;
    const msg = t('referral.shareMessage').replace('{code}', referralCode).replace('{link}', link);
    if (Platform.OS === 'web') {
      try {
        await navigator.clipboard.writeText(msg);
        if (Platform.OS === 'web') Alert.alert(t('referral.copied'));
      } catch {
        try { await navigator.share({ text: msg }); } catch {}
      }
    } else {
      try { await Share.share({ message: msg }); } catch {}
    }
  };

  const loadSettings = async () => {
    try {
      const { getSettings } = await import('../services/api');
      const r = await getSettings();
      if (r.success && r.data) {
        setSettings(prev => {
          const merged = { ...prev, ...r.data };
          initialSettingsRef.current = JSON.stringify(merged);
          return merged;
        });
      } else {
        setSettings(prev => { initialSettingsRef.current = JSON.stringify(prev); return prev; });
      }
    } catch {} finally {
      setLoading(false);
    }
  };

  const isDirty = () => {
    try { return initialSettingsRef.current && JSON.stringify(settings) !== initialSettingsRef.current; } catch { return false; }
  };
  const handleBack = () => {
    if (isDirty()) {
      Alert.alert(
        t('settings.unsavedTitle') || 'Alterações não salvas',
        t('settings.unsavedMessage') || 'Quer salvar antes de sair?',
        [
          { text: t('settings.discard') || 'Descartar', style: 'destructive', onPress: () => router.back() },
          { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
          { text: t('settings.save') || 'Salvar', onPress: async () => { await handleSave(); router.back(); } },
        ]
      );
    } else {
      router.back();
    }
  };
  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const { updateSettings } = await import('../services/api');
      const r = await updateSettings(settings);
      if (r.success) {
        setSaved(true);
        initialSettingsRef.current = JSON.stringify(settings);
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => setSaved(false), 2000);
      }
      // Persist notification prefs locally + update MailContext
      const notifPrefs = {
        notification_sound: settings.notification_sound,
        notification_vibration: settings.notification_vibration,
      };
      const json = JSON.stringify(notifPrefs);
      setStorage('notif_prefs', json);
      try {
        const { updateNotifSettings } = await import('../context/MailContext');
        updateNotifSettings(notifPrefs);
      } catch {}
    } catch {} finally {
      setSaving(false);
    }
  };

  const handleChangePhoto = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return;
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      if (!result.canceled && result.assets?.[0]) {
        const asset = result.assets[0];
        // Reject huge files at the client edge — upload silently times out
        // for files >25MB and the user gets no feedback.
        if (asset.fileSize && asset.fileSize > 25 * 1024 * 1024) {
          Alert.alert(t('common.error') || 'Erro', t('settings.avatarTooBig') || 'Foto muito grande (máx 25MB).');
          return;
        }
        const { uploadAvatar } = await import('../services/api');
        const file = { uri: asset.uri, name: 'avatar.jpg', type: 'image/jpeg' };
        try {
          const r = await uploadAvatar(file);
          if (r?.success) {
            setAvatarKey(Date.now());
          } else {
            Alert.alert(t('common.error') || 'Erro', r?.message || (t('settings.avatarUploadFailed') || 'Falha ao salvar foto.'));
          }
        } catch (e) {
          Alert.alert(t('common.error') || 'Erro', e?.message || (t('settings.avatarUploadFailed') || 'Falha ao salvar foto.'));
        }
      }
    } catch (e) {
      console.warn('[settings/avatar]', e?.message || e);
    }
  };

  return (
    <View style={[s.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[s.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={handleBack} style={s.backBtn} accessibilityLabel={t('common.back') || 'Voltar'} accessibilityRole="button">
          <IconArrowLeft size={24} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={[s.headerTitle, { color: colors.text }]}>{t('settings.title')}</Text>
        <TouchableOpacity
          style={[s.saveBtn, { backgroundColor: colors.primary }, saving && s.saveBtnDisabled]}
          onPress={handleSave}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={s.saveBtnText}>{saved ? t('settings.saved') : t('settings.save')}</Text>
          )}
        </TouchableOpacity>
      </View>

      {loading ? (
        <SettingsSkeleton sections={4} rows={3} />
      ) : (
      <ScrollView ref={scrollRef} contentContainerStyle={s.scroll}>
        {/* Profile Photo */}
        <View style={[s.section, s.profileSection, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <AvatarCircle key={avatarKey} email={user?.email} name={user?.email} size={80} />
          <Text style={[s.profileEmail, { color: colors.text }]}>{user?.email}</Text>
          <TouchableOpacity style={[s.changePhotoBtn, { borderColor: colors.primary }]} onPress={handleChangePhoto}>
            <Text style={[s.changePhotoBtnText, { color: colors.primary }]}>{t('settings.changePhoto')}</Text>
          </TouchableOpacity>
        </View>

        {/* Appearance */}
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>{t('settings.appearance')}</Text>

          <View style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.darkMode')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.darkModeDesc')}
              </Text>
            </View>
            <Switch
              value={isDark}
              onValueChange={toggle}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={isDark ? colors.primary : '#fff'}
            />
          </View>

          {/* Density */}
          <View style={[s.settingRowColumn, { borderBottomColor: colors.borderLight }]}>
            <View style={{ width: '100%' }}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.density')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.densityDesc')}
              </Text>
            </View>
            <View style={[s.perPageBtns, { marginTop: 10, flexWrap: 'wrap' }]}>
              {[
                { val: 'compact', label: t('settings.densityCompact') },
                { val: 'comfortable', label: t('settings.densityComfortable') },
                { val: 'spacious', label: t('settings.densitySpacious') },
              ].map(d => (
                <TouchableOpacity
                  key={d.val}
                  style={[
                    s.perPageBtn,
                    { borderColor: colors.divider },
                    density === d.val && { backgroundColor: colors.primary, borderColor: colors.primary },
                  ]}
                  onPress={() => setDensity(d.val)}
                >
                  <Text style={[
                    s.perPageText, { color: colors.text },
                    density === d.val && { color: '#fff' },
                  ]}>
                    {d.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>

        {/* Undo Send */}
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>{t('settings.undoSend')}</Text>
          <Text style={[s.settingDesc, { color: colors.textTertiary, marginBottom: Spacing.md }]}>
            {t('settings.undoSendDesc')}
          </Text>
          <View style={s.perPageBtns}>
            {[5, 10, 15, 30].map(n => (
              <TouchableOpacity
                key={n}
                style={[
                  s.perPageBtn,
                  { borderColor: colors.divider },
                  undoDelay === n && { backgroundColor: colors.primary, borderColor: colors.primary },
                ]}
                onPress={() => { setUndoDelay(n); setStorage('undo_send_delay', String(n)); }}
              >
                <Text style={[
                  s.perPageText, { color: colors.text },
                  undoDelay === n && { color: '#fff' },
                ]}>
                  {t('settings.undoSendSeconds', { n })}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Email */}
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>{t('settings.email')}</Text>

          <View style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.perPage')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.perPageDesc')}
              </Text>
            </View>
            <View style={s.perPageBtns}>
              {[20, 50, 100].map(n => (
                <TouchableOpacity
                  key={n}
                  style={[
                    s.perPageBtn,
                    { borderColor: colors.divider },
                    settings.emails_per_page === n && { backgroundColor: colors.primary, borderColor: colors.primary },
                  ]}
                  onPress={() => setSettings(prev => ({ ...prev, emails_per_page: n }))}
                >
                  <Text style={[
                    s.perPageText,
                    { color: colors.text },
                    settings.emails_per_page === n && { color: '#fff' },
                  ]}>
                    {n}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View ref={registerSectionRef('notifications')} style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.notifications')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.notificationsDesc')}
              </Text>
            </View>
            <Switch
              value={settings.notifications}
              onValueChange={(v) => setSettings(prev => ({ ...prev, notifications: v }))}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={settings.notifications ? colors.primary : '#fff'}
            />
          </View>

          {settings.notifications && (
            <>
              <View style={[s.settingRow, { borderBottomColor: colors.borderLight, paddingLeft: Spacing.xl }]}>
                <View style={s.settingInfo}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.notifSound')}</Text>
                  <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                    {t('settings.notifSoundDesc')}
                  </Text>
                </View>
                <Switch
                  value={settings.notification_sound}
                  onValueChange={(v) => setSettings(prev => ({ ...prev, notification_sound: v }))}
                  trackColor={{ false: colors.divider, true: colors.primaryLight }}
                  thumbColor={settings.notification_sound ? colors.primary : '#fff'}
                />
              </View>

              <View style={[s.settingRow, { borderBottomColor: colors.borderLight, paddingLeft: Spacing.xl }]}>
                <View style={s.settingInfo}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.notifVibration')}</Text>
                  <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                    {t('settings.notifVibrationDesc')}
                  </Text>
                </View>
                <Switch
                  value={settings.notification_vibration}
                  onValueChange={(v) => setSettings(prev => ({ ...prev, notification_vibration: v }))}
                  trackColor={{ false: colors.divider, true: colors.primaryLight }}
                  thumbColor={settings.notification_vibration ? colors.primary : '#fff'}
                />
              </View>
            </>
          )}
        </View>

        {/* Morning Briefing */}
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>{t('settings.morningBriefing') || 'Bom dia diário'}</Text>
          <View style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.morningEnabled') || 'Resumo matinal da ONE'}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.morningEnabledDesc') || 'Receba um resumo do dia com emails, eventos e clima às 8h'}
              </Text>
            </View>
            <Switch
              value={settings.morning_briefing !== false}
              onValueChange={(v) => setSettings(prev => ({ ...prev, morning_briefing: v }))}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={settings.morning_briefing !== false ? colors.primary : '#fff'}
            />
          </View>
        </View>

        {/* Signatures */}
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>{t('settings.signatures')}</Text>
          <Text style={[s.settingDesc, { color: colors.textTertiary, marginBottom: Spacing.md }]}>
            {t('settings.signatureDesc')}
          </Text>
          {(settings.signatures || [{ name: t('settings.signatureDefault'), content: settings.signature || '', isDefault: true }]).map((sig, idx) => (
            <View key={idx} style={[s.sigCard, { borderColor: colors.divider, backgroundColor: colors.surfaceVariant }]}>
              <View style={s.sigHeader}>
                <TextInput
                  style={[s.sigNameInput, { color: colors.text, borderColor: colors.divider }]}
                  value={sig.name}
                  onChangeText={(v) => {
                    const sigs = [...(settings.signatures || [{ name: t('settings.signatureDefault'), content: settings.signature || '', isDefault: true }])];
                    sigs[idx] = { ...sigs[idx], name: v };
                    setSettings(prev => ({ ...prev, signatures: sigs }));
                  }}
                  placeholder={t('settings.signatureName')}
                  placeholderTextColor={colors.textTertiary}
                />
                <TouchableOpacity
                  onPress={() => {
                    const sigs = [...(settings.signatures || [{ name: t('settings.signatureDefault'), content: settings.signature || '', isDefault: true }])];
                    sigs.forEach((s, i) => { s.isDefault = i === idx; });
                    setSettings(prev => ({ ...prev, signatures: sigs }));
                  }}
                  style={[s.defaultBtn, sig.isDefault && { backgroundColor: colors.primaryLight }]}
                >
                  <Text style={{ fontSize: FontSize.xs, color: sig.isDefault ? colors.primary : colors.textTertiary, fontWeight: '600' }}>
                    {t('settings.signatureDefault')}
                  </Text>
                </TouchableOpacity>
                {(settings.signatures || []).length > 1 && (
                  <TouchableOpacity onPress={() => {
                    const sigs = (settings.signatures || []).filter((_, i) => i !== idx);
                    if (sig.isDefault && sigs.length > 0) sigs[0].isDefault = true;
                    setSettings(prev => ({ ...prev, signatures: sigs }));
                  }}>
                    <IconTrash size={16} color={colors.error} />
                  </TouchableOpacity>
                )}
              </View>
              <TextInput
                style={[s.signatureInput, { color: colors.text, borderColor: colors.divider, backgroundColor: colors.surface, marginTop: 8, minHeight: 60 }]}
                value={sig.content}
                onChangeText={(v) => {
                  const sigs = [...(settings.signatures || [{ name: t('settings.signatureDefault'), content: settings.signature || '', isDefault: true }])];
                  sigs[idx] = { ...sigs[idx], content: v };
                  setSettings(prev => ({ ...prev, signatures: sigs, signature: sigs.find(s => s.isDefault)?.content || '' }));
                }}
                placeholder={t('settings.signaturePlaceholder')}
                placeholderTextColor={colors.textTertiary}
                multiline
                numberOfLines={3}
                textAlignVertical="top"
              />
            </View>
          ))}
          <TouchableOpacity
            onPress={() => {
              const sigs = [...(settings.signatures || [{ name: t('settings.signatureDefault'), content: settings.signature || '', isDefault: true }])];
              sigs.push({ name: '', content: '', isDefault: false });
              setSettings(prev => ({ ...prev, signatures: sigs }));
            }}
            style={[s.addSigBtn, { borderColor: colors.primary }]}
          >
            <Text style={{ color: colors.primary, fontSize: FontSize.sm, fontWeight: '600' }}>+ {t('settings.addSignature')}</Text>
          </TouchableOpacity>
        </View>

        {/* Language */}
        <View ref={registerSectionRef('language')} style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <View style={s.sectionTitleRow}>
            <IconGlobe size={18} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[s.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('settings.language')}</Text>
          </View>
          <View style={[s.settingRow, { borderBottomColor: colors.borderLight, marginTop: Spacing.md }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.languageLabel')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.languageDesc')}
              </Text>
            </View>
            <View style={s.perPageBtns}>
              {[{ val: 'pt-BR', label: '🇧🇷 PT' }, { val: 'en', label: '🇺🇸 EN' }, { val: 'es', label: '🇪🇸 ES' }].map(l => (
                <TouchableOpacity
                  key={l.val}
                  style={[
                    s.perPageBtn,
                    { borderColor: colors.divider },
                    language === l.val && { backgroundColor: colors.primary, borderColor: colors.primary },
                  ]}
                  onPress={() => { changeLanguage(l.val); setSettings(prev => ({ ...prev, language: l.val })); }}
                >
                  <Text style={[
                    s.perPageText, { color: colors.text },
                    language === l.val && { color: '#fff' },
                  ]}>
                    {l.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>

        {/* Auto-reply */}
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>{t('settings.autoReply')}</Text>
          <Text style={[s.settingDesc, { color: colors.textTertiary, marginBottom: Spacing.md }]}>
            {t('settings.autoReplyDesc')}
          </Text>
          <View style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.autoReplyEnable')}</Text>
            </View>
            <Switch
              value={settings.auto_reply}
              onValueChange={(v) => setSettings(prev => ({ ...prev, auto_reply: v }))}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={settings.auto_reply ? colors.primary : '#fff'}
            />
          </View>
          {settings.auto_reply && (
            <TextInput
              style={[
                s.signatureInput,
                { color: colors.text, borderColor: colors.divider, backgroundColor: colors.surfaceVariant, marginTop: Spacing.md },
              ]}
              value={settings.auto_reply_message}
              onChangeText={(v) => setSettings(prev => ({ ...prev, auto_reply_message: v }))}
              placeholder={t('settings.autoReplyPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
          )}
        </View>

        {/* Filters & Rules */}
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>{t('settings.filters')}</Text>
          <Text style={[s.settingDesc, { color: colors.textTertiary, marginBottom: Spacing.md }]}>
            {t('settings.filtersDesc')}
          </Text>
          <TouchableOpacity
            style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
            onPress={() => setShowFilters(true)}
          >
            <View style={s.settingInfo}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <IconFilter size={18} color={colors.primary} style={{ marginRight: Spacing.sm }} />
                <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.manageFilters')}</Text>
              </View>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.manageFiltersDesc')}
              </Text>
            </View>
            <IconChevronRight size={20} color={colors.textTertiary} />
          </TouchableOpacity>
        </View>

        {/* AI Features */}
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <View style={s.sectionTitleRow}>
            <IconSparkles size={18} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[s.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('settings.ai')}</Text>
          </View>
          <Text style={[s.settingDesc, { color: colors.textTertiary, marginTop: Spacing.sm }]}>
            {t('settings.aiDesc')}
          </Text>
          <View style={s.aiFeatures}>
            <View style={s.aiFeatureRow}>
              <View style={s.aiFeatureIconWrap}><IconMessageSquare size={18} color={colors.primary} /></View>
              <Text style={[s.aiFeatureText, { color: colors.text }]}>{t('settings.aiSmartReply')}</Text>
            </View>
            <View style={s.aiFeatureRow}>
              <View style={s.aiFeatureIconWrap}><IconPenTool size={18} color={colors.primary} /></View>
              <Text style={[s.aiFeatureText, { color: colors.text }]}>{t('settings.aiDrafts')}</Text>
            </View>
            <View style={s.aiFeatureRow}>
              <View style={s.aiFeatureIconWrap}><IconDraft size={18} color={colors.primary} /></View>
              <Text style={[s.aiFeatureText, { color: colors.text }]}>{t('settings.aiSummary')}</Text>
            </View>
            <View style={s.aiFeatureRow}>
              <View style={s.aiFeatureIconWrap}><IconSparkles size={18} color={colors.primary} /></View>
              <Text style={[s.aiFeatureText, { color: colors.text }]}>{t('settings.aiEnhance')}</Text>
            </View>
          </View>
          <View style={[s.settingRow, { borderTopColor: colors.borderLight, borderTopWidth: 1, paddingTop: Spacing.md, marginTop: Spacing.md }]}>
            <View style={{ flex: 1 }}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.smartCompose')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>{t('settings.smartComposeDesc')}</Text>
            </View>
            <TouchableOpacity
              onPress={() => {
                const next = !smartComposeOn;
                setSmartComposeOn(next);
                setStorage('smart_compose', String(next));
              }}
              style={[
                s.toggleTrack,
                { backgroundColor: smartComposeOn ? colors.primary : colors.borderLight },
              ]}
            >
              <View style={[s.toggleThumb, smartComposeOn && s.toggleThumbActive]} />
            </TouchableOpacity>
          </View>
        </View>

        {/* One AI Assistant */}
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <View style={s.sectionTitleRow}>
            <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: '#6366f1', alignItems: 'center', justifyContent: 'center', marginRight: 8 }}>
              <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>O</Text>
            </View>
            <Text style={[s.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('settings.oneAssistant')}</Text>
          </View>
          <Text style={[s.settingDesc, { color: colors.textSecondary, marginTop: Spacing.sm }]}>
            {t('settings.oneAssistantDesc')}
          </Text>

          <View style={[s.settingRow, { borderBottomColor: colors.borderLight, marginTop: Spacing.md }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.oneEnabled')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>{t('settings.oneEnabledDesc')}</Text>
            </View>
            <Switch
              value={oneEnabled}
              onValueChange={(v) => {
                setOneEnabled(v);
                setStorage('one_enabled', String(v));
              }}
              trackColor={{ false: colors.divider, true: '#6366f1' + '66' }}
              thumbColor={oneEnabled ? '#6366f1' : '#fff'}
            />
          </View>

          {oneEnabled && (
            <>
              <Text style={[s.settingLabel, { color: colors.text, paddingHorizontal: Spacing.md, paddingTop: Spacing.md }]}>{t('settings.oneNotifPrefs')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary, paddingHorizontal: Spacing.md, marginBottom: Spacing.sm }]}>{t('settings.oneNotifUrgentDesc')}</Text>
              <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: Spacing.md, paddingBottom: Spacing.md }}>
                {[
                  { val: 'email', label: t('settings.oneNotifEmail'), Icon: IconMail },
                  { val: 'push', label: t('settings.oneNotifPush'), Icon: IconBell },
                  { val: 'urgent', label: t('settings.oneNotifUrgent'), Icon: IconPhone },
                ].map(opt => {
                  const isSel = oneNotifLevel === opt.val;
                  return (
                  <TouchableOpacity
                    key={opt.val}
                    style={[
                      s.perPageBtn,
                      { borderColor: colors.divider, flex: 1, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
                      isSel && { backgroundColor: '#6366f1', borderColor: '#6366f1' },
                    ]}
                    onPress={() => {
                      setOneNotifLevel(opt.val);
                      setStorage('one_notif_level', opt.val);
                    }}
                  >
                    <opt.Icon size={14} color={isSel ? '#fff' : colors.text} />
                    <Text style={[
                      s.perPageText, { color: colors.text, textAlign: 'center' },
                      isSel && { color: '#fff' },
                    ]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                  );
                })}
              </View>
            </>
          )}
        </View>

        {/* Desktop Notifications */}
        {Platform.OS === 'web' && (
          <View ref={registerSectionRef('notifications')} style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
            <View style={s.sectionTitleRow}>
              <IconBell size={18} color={colors.primary} style={{ marginRight: 8 }} />
              <Text style={[s.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('settings.desktopNotifs')}</Text>
            </View>
            <Text style={[s.settingDesc, { color: colors.textTertiary, marginTop: Spacing.sm }]}>
              {t('settings.desktopNotifsDesc')}
            </Text>
            <View style={[s.settingRow, { borderBottomColor: colors.borderLight, marginTop: Spacing.md }]}>
              <View style={s.settingInfo}>
                <Text style={[s.settingLabel, { color: colors.text }]}>
                  {notifPermission === 'granted' ? t('settings.notifsEnabled') : notifPermission === 'denied' ? t('settings.notifsBlocked') : t('settings.notifsEnable')}
                </Text>
                <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                  {notifPermission === 'denied' ? t('settings.notifsBlockedDesc') : t('settings.notifsAlertDesc')}
                </Text>
              </View>
              {notifPermission !== 'granted' && notifPermission !== 'denied' && (
                <TouchableOpacity
                  style={[s.perPageBtn, { borderColor: colors.primary, backgroundColor: colors.primaryLight }]}
                  onPress={async () => {
                    const perm = await Notification.requestPermission();
                    setNotifPermission(perm);
                  }}
                >
                  <Text style={[s.perPageText, { color: colors.primary }]}>{t('settings.notifsEnable')}</Text>
                </TouchableOpacity>
              )}
              {notifPermission === 'granted' && (
                <Text style={[s.perPageText, { color: colors.success || '#34a853' }]}>{t('settings.notifsActive')}</Text>
              )}
            </View>
          </View>
        )}

        {/* Security — Biometric Lock (native only) */}
        {Platform.OS !== 'web' && biometricAvailable && (
          <View ref={registerSectionRef('security')} style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
            {/* Família — Apple Family Sharing-style hub */}
            <TouchableOpacity
              style={[s.settingRow, { borderBottomColor: colors.borderLight, marginBottom: Spacing.sm, backgroundColor: isDark ? '#1a1530' : '#faf5ff', borderRadius: 14, padding: 14 }]}
              onPress={() => router.push('/family')}
            >
              <View style={s.settingInfo}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <IconShield size={20} color="#7C3AED" />
                  <Text style={[s.settingLabel, { color: colors.text, fontWeight: '700' }]}>Família</Text>
                </View>
                <Text style={[s.settingDesc, { color: colors.textTertiary }]}>Compartilhe plano, álbum, calendário e mais com a família</Text>
              </View>
              <IconChevronRight size={18} color={colors.textSecondary} />
            </TouchableOpacity>

            {/* Parental Controls */}
            <TouchableOpacity
              style={[s.settingRow, { borderBottomColor: colors.borderLight, marginBottom: Spacing.lg, backgroundColor: isDark ? '#1a2e1a' : '#f0fdf4', borderRadius: 14, padding: 14 }]}
              onPress={() => router.push('/parental')}
            >
              <View style={s.settingInfo}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <IconShield size={20} color="#7C3AED" />
                  <Text style={[s.settingLabel, { color: colors.text, fontWeight: '700' }]}>Controle Parental</Text>
                </View>
                <Text style={[s.settingDesc, { color: colors.textTertiary }]}>Crie contas monitoradas para seus filhos</Text>
              </View>
              <IconChevronRight size={18} color={colors.textSecondary} />
            </TouchableOpacity>

            <View style={s.sectionTitleRow}>
              <IconShield size={18} color={colors.primary} style={{ marginRight: 8 }} />
              <Text style={[s.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('settings.security')}</Text>
            </View>
            <View style={[s.settingRow, { borderBottomColor: colors.borderLight, marginTop: Spacing.md }]}>
              <View style={s.settingInfo}>
                <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.biometricLock')}</Text>
                <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                  {t('settings.biometricDesc')}
                </Text>
              </View>
              <Switch
                value={biometricEnabled}
                onValueChange={toggleBiometric}
                trackColor={{ false: colors.divider, true: colors.primaryLight }}
                thumbColor={biometricEnabled ? colors.primary : '#fff'}
              />
            </View>

            {/* Alterar senha — abre modal com senha atual + nova senha + confirmar */}
            <TouchableOpacity
              style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
              onPress={() => setChangePasswordOpen(true)}
              activeOpacity={0.65}
            >
              <View style={s.settingInfo}>
                <Text style={[s.settingLabel, { color: colors.text }]}>
                  {t('settings.changePassword') || 'Alterar senha'}
                </Text>
                <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                  {t('settings.changePasswordDesc') || 'Atualize sua senha de acesso a qualquer momento'}
                </Text>
              </View>
              <Text style={{ color: colors.textTertiary, fontSize: 20 }}>›</Text>
            </TouchableOpacity>

            {/* 2FA PIN — opens 4-digit entry modal */}
            <TouchableOpacity
              style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
              onPress={() => {
                setTwoFADigits(['', '', '', '']);
                setTwoFAError('');
                setTwoFASuccess(false);
                setTwoFAOpen(true);
                setTimeout(() => { try { twoFARefs.current[0]?.focus?.(); } catch {} }, 250);
              }}
              activeOpacity={0.65}
            >
              <View style={[s.settingInfo, { flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
                <IconShield size={18} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>
                    {t('settings.twoFactor') || 'Verificação em duas etapas'}
                  </Text>
                  <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                    {t('settings.twoFactorDesc') || 'Adicione uma camada extra de segurança ao seu Chatyy'}
                  </Text>
                </View>
              </View>
              <Text style={{ color: colors.textTertiary, fontSize: 20 }}>›</Text>
            </TouchableOpacity>

            {/* Registration Lock (anti-SIM-swap) — separate concept from 2FA.
                A short PIN that adds a second factor to phone-OTP login,
                defeating SIM-swap attacks where the attacker steals the
                number, gets the OTP, and takes over the account. Same
                4-digit PIN UI as 2FA but writes to a different backend key. */}
            <TouchableOpacity
              style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
              onPress={() => {
                setRegLockDigits(['', '', '', '']);
                setRegLockError('');
                setRegLockSuccess(false);
                setRegLockOpen(true);
                setTimeout(() => { try { regLockRefs.current[0]?.focus?.(); } catch {} }, 250);
              }}
              activeOpacity={0.65}
            >
              <View style={[s.settingInfo, { flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
                <IconShield size={18} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>
                    {t('settings.registrationLock') || 'PIN de segurança (anti-SIM-swap)'}
                  </Text>
                  <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                    {t('settings.registrationLockDesc') || 'PIN extra no login por telefone — protege se trocarem seu chip.'}
                  </Text>
                </View>
              </View>
              <Text style={{ color: colors.textTertiary, fontSize: 20 }}>›</Text>
            </TouchableOpacity>

            {/* Alterar número de telefone (SIM swap recovery, WhatsApp pattern).
                Migrates the account to a NEW phone while keeping all chats /
                contacts / handle. Routes to /change-phone for the multi-step
                flow (confirm old → pick new → OTP → success). */}
            <TouchableOpacity
              style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
              onPress={() => router.push('/change-phone')}
              activeOpacity={0.65}
            >
              <View style={[s.settingInfo, { flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
                <IconPhone size={18} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>
                    {t('settings.changePhone') || 'Alterar número de telefone'}
                  </Text>
                  <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                    {t('settings.changePhoneDesc') || 'Migre sua conta para um novo número mantendo seus chats e contatos.'}
                  </Text>
                </View>
              </View>
              <Text style={{ color: colors.textTertiary, fontSize: 20 }}>›</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Forwarding */}
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <View style={s.sectionTitleRow}>
            <IconForward size={18} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[s.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('settings.forwarding')}</Text>
          </View>
          <Text style={[s.settingDesc, { color: colors.textTertiary, marginTop: Spacing.sm, marginBottom: Spacing.md }]}>
            {t('settings.forwardingDesc')}
          </Text>
          <View style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.forwardingEnable')}</Text>
            </View>
            <Switch
              value={settings.forwarding_enabled}
              onValueChange={(v) => setSettings(prev => ({ ...prev, forwarding_enabled: v }))}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={settings.forwarding_enabled ? colors.primary : '#fff'}
            />
          </View>
          {settings.forwarding_enabled && (
            <TextInput
              style={[
                s.signatureInput,
                { color: colors.text, borderColor: colors.divider, backgroundColor: colors.surfaceVariant, marginTop: Spacing.md, minHeight: 44 },
              ]}
              value={settings.forwarding_email}
              onChangeText={(v) => setSettings(prev => ({ ...prev, forwarding_email: v }))}
              placeholder={t('settings.forwardingPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              keyboardType="email-address"
              autoCapitalize="none"
            />
          )}
        </View>

        {/* Reading */}
        <View ref={registerSectionRef('reading')} style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>{t('settings.reading')}</Text>

          <View style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.fontSize')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.fontSizeDesc')}
              </Text>
            </View>
            <View style={s.perPageBtns}>
              {[{ val: 'small', label: t('settings.fontSmall') }, { val: 'medium', label: t('settings.fontMedium') }, { val: 'large', label: t('settings.fontLarge') }].map(f => (
                <TouchableOpacity
                  key={f.val}
                  style={[
                    s.perPageBtn,
                    { borderColor: colors.divider },
                    settings.font_size === f.val && { backgroundColor: colors.primary, borderColor: colors.primary },
                  ]}
                  onPress={() => setSettings(prev => ({ ...prev, font_size: f.val }))}
                >
                  <Text style={[
                    s.perPageText, { color: colors.text },
                    settings.font_size === f.val && { color: '#fff' },
                  ]}>
                    {f.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.readReceipts')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.readReceiptsDesc')}
              </Text>
            </View>
            <Switch
              value={settings.read_receipts}
              onValueChange={(v) => setSettings(prev => ({ ...prev, read_receipts: v }))}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={settings.read_receipts ? colors.primary : '#fff'}
            />
          </View>
        </View>

        {/* Legal — Privacy & Terms */}
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <View style={s.sectionTitleRow}>
            <IconFileText size={18} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[s.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('settings.legal')}</Text>
          </View>
          <TouchableOpacity
            style={[s.settingRow, { borderBottomColor: colors.borderLight, marginTop: Spacing.md }]}
            onPress={() => setShowPrivacy(true)}
          >
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.privacyPolicy')}</Text>
            </View>
            <IconChevronRight size={20} color={colors.textTertiary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
            onPress={() => setShowTerms(true)}
          >
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.termsOfService')}</Text>
            </View>
            <IconChevronRight size={20} color={colors.textTertiary} />
          </TouchableOpacity>
        </View>

        {/* Notifications — push delivery level. Surfaces oneNotifLevel state
            (was set in code but no UI exposed it — GAP 11). Three radio rows:
            all / urgent / silent. Persisted via setStorage (mirrors One
            Assistant section pattern). */}
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <View style={s.sectionTitleRow}>
            <IconBell size={18} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[s.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('settings.notificationsTitle')}</Text>
          </View>
          {[
            { val: 'all', label: t('settings.notifAll'), sub: t('settings.notifAllSub') },
            { val: 'urgent', label: t('settings.notifUrgent'), sub: t('settings.notifUrgentSub') },
            { val: 'silent', label: t('settings.notifSilent'), sub: t('settings.notifSilentSub') },
          ].map((opt, idx, arr) => {
            const selected = pushNotifLevel === opt.val;
            const isLast = idx === arr.length - 1;
            return (
              <TouchableOpacity
                key={opt.val}
                onPress={() => {
                  setPushNotifLevel(opt.val);
                  setStorage('push_notif_level', opt.val);
                }}
                style={[
                  s.settingRow,
                  { borderBottomColor: colors.borderLight, borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth },
                ]}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                accessibilityLabel={opt.label}
              >
                <IconBell size={20} color={selected ? colors.primary : colors.textSecondary} style={{ marginRight: 12 }} />
                <View style={s.settingInfo}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>{opt.label}</Text>
                  <Text style={[s.settingDesc, { color: colors.textTertiary }]}>{opt.sub}</Text>
                </View>
                {selected && <IconCheck size={20} color={colors.primary} />}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Convidar amigos — hero card. Reescrita: header gigante com
            título + descrição + GB ganhos, código grande tappable, botão
            Compartilhar largo, contador no rodapé. Saiu de "uma row apertada"
            pra um card que parece feature de growth. */}
        <View style={{
          marginBottom: Spacing.lg,
          borderRadius: 18,
          overflow: 'hidden',
          backgroundColor: colors.primary,
          ...Platform.select({
            ios: { shadowColor: colors.primary, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.18, shadowRadius: 16 },
            android: { elevation: 4 },
            web: { boxShadow: `0 8px 24px ${colors.primary}33` },
          }),
        }}>
          <View style={{ padding: 20, gap: 14 }}>
            {/* Header com ícone + título */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={{
                width: 42, height: 42, borderRadius: 21,
                backgroundColor: 'rgba(255,255,255,0.2)',
                alignItems: 'center', justifyContent: 'center',
              }}>
                <IconUsers size={22} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 17, fontWeight: '800', color: '#fff', letterSpacing: -0.2 }}>
                  {t('referral.inviteFriends') || 'Convidar amigos'}
                </Text>
                <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.82)', marginTop: 2, fontWeight: '500' }}>
                  {t('referral.subtitle') || '1 GB grátis pra cada amigo que entrar'}
                </Text>
              </View>
            </View>

            {/* Code box — grande, copia long-press */}
            {referralCode ? (
              <View style={{ gap: 10 }}>
                <TouchableOpacity
                  onPress={async () => {
                    try {
                      const Clipboard = require('expo-clipboard');
                      await Clipboard.setStringAsync(referralCode);
                      Alert.alert(t('referral.copied') || 'Código copiado');
                    } catch {}
                  }}
                  activeOpacity={0.7}
                  accessibilityLabel={t('referral.copyCode') || 'Tocar pra copiar código'}
                  accessibilityRole="button"
                  style={{
                    backgroundColor: 'rgba(255,255,255,0.18)',
                    borderRadius: 14,
                    paddingVertical: 16,
                    paddingHorizontal: 18,
                    alignItems: 'center',
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    borderWidth: 1.5,
                    borderColor: 'rgba(255,255,255,0.25)',
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: 'rgba(255,255,255,0.7)', letterSpacing: 1.2, textTransform: 'uppercase' }}>
                      {t('referral.yourCode') || 'Seu código'}
                    </Text>
                    <Text style={{ fontSize: 24, fontWeight: '900', color: '#fff', letterSpacing: 4, marginTop: 2 }}>
                      {referralCode}
                    </Text>
                  </View>
                  <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center' }}>
                    <IconCopy size={18} color="#fff" />
                  </View>
                </TouchableOpacity>

                {/* Botão compartilhar — largo */}
                <TouchableOpacity
                  onPress={handleShareReferral}
                  activeOpacity={0.85}
                  style={{
                    backgroundColor: '#fff',
                    borderRadius: 14,
                    paddingVertical: 14,
                    alignItems: 'center',
                    flexDirection: 'row',
                    justifyContent: 'center',
                    gap: 8,
                  }}
                >
                  <IconShare size={18} color={colors.primary} />
                  <Text style={{ fontSize: 15, fontWeight: '700', color: colors.primary }}>
                    {t('referral.share') || 'Compartilhar'}
                  </Text>
                </TouchableOpacity>

                {/* Stats footer */}
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 6 }}>
                  <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)', fontWeight: '600' }}>
                    {referralCount === 1
                      ? '1 amigo convidado'
                      : `${referralCount} amigos convidados`}
                  </Text>
                  <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)', fontWeight: '700' }}>
                    {`+${referralCount} GB`}
                  </Text>
                </View>
              </View>
            ) : (
              <View style={{ paddingVertical: 30, alignItems: 'center' }}>
                <ActivityIndicator size="small" color="#fff" />
              </View>
            )}
          </View>
        </View>

        {/* Danger Zone */}
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.error }]}>{t('settings.dangerZone')}</Text>
          <TouchableOpacity
            style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
            onPress={async () => {
              const doEmpty = async () => {
                const { emptyTrash } = await import('../services/api');
                await emptyTrash();
              };
              const ok = Platform.OS === 'web'
                ? (typeof window !== 'undefined' && window.confirm(t('settings.emptyTrashConfirmWeb')))
                : await confirm({
                    title: t('settings.emptyTrashTitle'),
                    message: t('settings.emptyTrashConfirmNative'),
                    confirmLabel: t('common.confirm'),
                    destructive: true,
                  });
              if (ok) doEmpty();
            }}
          >
            <View style={s.settingInfo}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <IconTrash size={18} color={colors.error} style={{ marginRight: Spacing.sm }} />
                <Text style={[s.settingLabel, { color: colors.error }]}>{t('settings.emptyTrash')}</Text>
              </View>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.emptyTrashDesc')}
              </Text>
            </View>
            <IconChevronRight size={20} color={colors.textTertiary} />
          </TouchableOpacity>

          {/* Account Deletion — Apple Requirement */}
          <TouchableOpacity
            style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
            onPress={async () => {
              const openSheet = () => {
                setDeleteConfirm(true);
                setDeletePassword('');
                setDeleteError('');
                setDeleteAcknowledged(false);
                setDeleteTypedWord('');
              };
              if (Platform.OS === 'web') { openSheet(); return; }
              const ok = await confirm({
                title: t('settings.deleteAccountConfirmTitle'),
                message: t('settings.deleteAccountConfirmMessage'),
                confirmLabel: t('settings.deleteAccount'),
                destructive: true,
              });
              if (ok) openSheet();
            }}
          >
            <View style={s.settingInfo}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <IconUser size={18} color={colors.error} style={{ marginRight: Spacing.sm }} />
                <Text style={[s.settingLabel, { color: colors.error }]}>{t('settings.deleteAccount')}</Text>
              </View>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.deleteAccountDesc')}
              </Text>
            </View>
            <IconChevronRight size={20} color={colors.textTertiary} />
          </TouchableOpacity>

          {deleteConfirm && (() => {
            const confirmWord = t('settings.deleteAccountTypeWord') || 'DELETE';
            const typedOk = (deleteTypedWord || '').trim().toUpperCase() === String(confirmWord).toUpperCase();
            const canDelete = deleteAcknowledged && typedOk && !!deletePassword.trim() && !deleting;
            return (
            <View style={[s.deleteConfirmBox, { backgroundColor: colors.errorBg || (colors.error + '08'), borderColor: colors.error + '30' }]}>
              <Text style={[s.deleteConfirmTitle, { color: colors.error }]}>{t('settings.confirmAccountDeletion')}</Text>

              {/* Destructive warning banner */}
              <View style={{
                flexDirection: 'row', gap: 12, padding: 14,
                backgroundColor: (colors.error || '#dc2626') + '15',
                borderRadius: 12, borderWidth: 1,
                borderColor: (colors.error || '#dc2626') + '40',
                marginBottom: 16,
              }}>
                <IconAlertTriangle size={20} color={colors.error || '#dc2626'} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.error || '#dc2626', fontSize: 14, fontWeight: '700', marginBottom: 4 }}>
                    {t('settings.deleteAccountWarningTitle')}
                  </Text>
                  <Text style={{ color: colors.text, fontSize: 13, lineHeight: 18 }}>
                    {t('settings.deleteAccountWarningBody')}
                  </Text>
                </View>
              </View>

              <Text style={[s.deleteConfirmText, { color: colors.textSecondary }]}>
                {t('settings.deleteAccountPasswordMessage')}
              </Text>
              <TextInput
                style={[s.deletePasswordInput, { color: colors.text, borderColor: colors.error + '40', backgroundColor: colors.surface }]}
                value={deletePassword}
                onChangeText={setDeletePassword}
                placeholder={t('settings.yourPassword')}
                placeholderTextColor={colors.textTertiary}
                secureTextEntry
              />

              {/* Type-to-confirm word */}
              <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 12, marginBottom: 6 }}>
                {(t('settings.deleteAccountTypeHint') || 'Type {word} to confirm').replace('{word}', confirmWord)}
              </Text>
              <TextInput
                style={[s.deletePasswordInput, {
                  color: colors.text,
                  borderColor: typedOk ? (colors.success || '#16a34a') + '60' : (colors.error + '40'),
                  backgroundColor: colors.surface,
                  marginTop: 0,
                  letterSpacing: 1,
                  fontWeight: '700',
                }]}
                value={deleteTypedWord}
                onChangeText={setDeleteTypedWord}
                placeholder={confirmWord}
                placeholderTextColor={colors.textTertiary}
                autoCapitalize="characters"
                autoCorrect={false}
              />

              {/* Acknowledge checkbox */}
              <TouchableOpacity
                onPress={() => setDeleteAcknowledged(v => !v)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14, paddingVertical: 4 }}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: deleteAcknowledged }}
              >
                <View style={{
                  width: 22, height: 22, borderRadius: 6,
                  borderWidth: 2,
                  borderColor: deleteAcknowledged ? (colors.error || '#dc2626') : colors.border,
                  backgroundColor: deleteAcknowledged ? (colors.error || '#dc2626') : 'transparent',
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  {deleteAcknowledged ? <IconCheck size={14} color="#fff" /> : null}
                </View>
                <Text style={{ flex: 1, color: colors.text, fontSize: 13, lineHeight: 18 }}>
                  {t('settings.deleteAccountConfirmCheckbox')}
                </Text>
              </TouchableOpacity>

              {!!deleteError && <Text style={[s.deleteErrorText, { color: colors.error, marginTop: 10 }]}>{deleteError}</Text>}
              <View style={s.deleteActions}>
                <TouchableOpacity
                  onPress={() => { setDeleteConfirm(false); setDeletePassword(''); setDeleteError(''); setDeleteAcknowledged(false); setDeleteTypedWord(''); }}
                  style={[s.deleteCancelBtn, { borderColor: colors.border }]}
                >
                  <Text style={[s.deleteCancelText, { color: colors.text }]}>{t('common.cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={async () => {
                    if (!canDelete) return;
                    setDeleting(true);
                    setDeleteError('');
                    try {
                      const { deleteAccount } = await import('../services/api');
                      const r = await deleteAccount(deletePassword);
                      if (r.success) {
                        setDeleteConfirm(false);
                        if (Platform.OS === 'web') {
                          window.alert(t('settings.accountDeletedMessage'));
                        } else {
                          Alert.alert(t('settings.accountDeleted'), t('settings.accountDeletedMessage'));
                        }
                        logout();
                      } else {
                        setDeleteError(r.message || t('settings.deleteAccountError'));
                      }
                    } catch {
                      setDeleteError(t('common.networkError'));
                    } finally {
                      setDeleting(false);
                    }
                  }}
                  disabled={!canDelete}
                  style={[s.deleteConfirmBtn, { backgroundColor: colors.error, opacity: canDelete ? 1 : 0.4 }]}
                >
                  {deleting ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={s.deleteConfirmBtnText}>{t('settings.deleteMyAccount')}</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
            );
          })()}
        </View>
      </ScrollView>
      )}

      <FilterRuleEditor visible={showFilters} onClose={() => setShowFilters(false)} />
      <PrivacyModal visible={showPrivacy} onClose={() => setShowPrivacy(false)} />
      <TermsModal visible={showTerms} onClose={() => setShowTerms(false)} />

      {/* Change Password Modal */}
      <Modal
        visible={changePasswordOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setChangePasswordOpen(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center' }}
          onPress={() => setChangePasswordOpen(false)}
        >
          <Pressable
            onPress={e => e.stopPropagation?.()}
            style={{
              margin: 20,
              backgroundColor: colors.surface,
              borderRadius: 20,
              padding: 24,
              ...(Platform.OS === 'web' ? { boxShadow: '0 20px 50px rgba(0,0,0,0.25)' } : {}),
            }}
          >
            <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text, marginBottom: 4 }}>
              {t('settings.changePassword') || 'Alterar senha'}
            </Text>
            <Text style={{ fontSize: 13, color: colors.textTertiary, marginBottom: 20 }}>
              {t('settings.changePasswordBody') || 'Sua nova senha precisa ter no mínimo 8 caracteres.'}
            </Text>

            {/* Current password */}
            <Text style={{ fontSize: 12, fontWeight: '600', color: colors.textSecondary, marginBottom: 6, letterSpacing: 0.3 }}>
              {(t('settings.currentPassword') || 'Senha atual').toUpperCase()}
            </Text>
            <TextInput
              value={cpCurrent}
              onChangeText={v => { setCpCurrent(v); setCpError(''); }}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="••••••••"
              placeholderTextColor={colors.textTertiary}
              style={{
                borderWidth: 1,
                borderColor: cpError ? colors.error : colors.border,
                borderRadius: 12,
                paddingHorizontal: 14,
                paddingVertical: 12,
                fontSize: 15,
                color: colors.text,
                backgroundColor: colors.surfaceVariant || colors.background,
                marginBottom: 14,
                ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
              }}
              editable={!cpLoading}
            />

            {/* New password */}
            <Text style={{ fontSize: 12, fontWeight: '600', color: colors.textSecondary, marginBottom: 6, letterSpacing: 0.3 }}>
              {(t('settings.newPassword') || 'Nova senha').toUpperCase()}
            </Text>
            <TextInput
              value={cpNew}
              onChangeText={v => { setCpNew(v); setCpError(''); }}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={t('settings.newPasswordPlaceholder') || 'Mínimo 8 caracteres'}
              placeholderTextColor={colors.textTertiary}
              style={{
                borderWidth: 1,
                borderColor: cpError ? colors.error : colors.border,
                borderRadius: 12,
                paddingHorizontal: 14,
                paddingVertical: 12,
                fontSize: 15,
                color: colors.text,
                backgroundColor: colors.surfaceVariant || colors.background,
                marginBottom: 14,
                ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
              }}
              editable={!cpLoading}
            />

            {/* Confirm */}
            <Text style={{ fontSize: 12, fontWeight: '600', color: colors.textSecondary, marginBottom: 6, letterSpacing: 0.3 }}>
              {(t('settings.confirmNewPassword') || 'Confirmar nova senha').toUpperCase()}
            </Text>
            <TextInput
              value={cpConfirm}
              onChangeText={v => { setCpConfirm(v); setCpError(''); }}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="••••••••"
              placeholderTextColor={colors.textTertiary}
              style={{
                borderWidth: 1,
                borderColor: cpError ? colors.error : colors.border,
                borderRadius: 12,
                paddingHorizontal: 14,
                paddingVertical: 12,
                fontSize: 15,
                color: colors.text,
                backgroundColor: colors.surfaceVariant || colors.background,
                marginBottom: 6,
                ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
              }}
              editable={!cpLoading}
            />

            {cpError ? (
              <Text style={{ color: colors.error, fontSize: 13, marginTop: 4 }}>{cpError}</Text>
            ) : null}
            {cpSuccess ? (
              <Text style={{ color: '#16A34A', fontSize: 13, marginTop: 4, fontWeight: '600' }}>
                ✓ {t('settings.passwordChanged') || 'Senha alterada com sucesso'}
              </Text>
            ) : null}

            {/* Actions */}
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 20 }}>
              <TouchableOpacity
                onPress={() => {
                  setChangePasswordOpen(false);
                  setCpCurrent(''); setCpNew(''); setCpConfirm('');
                  setCpError(''); setCpSuccess(false);
                }}
                disabled={cpLoading}
                style={{
                  flex: 1, paddingVertical: 14,
                  borderRadius: 12,
                  backgroundColor: colors.surfaceVariant || 'transparent',
                  borderWidth: 1, borderColor: colors.border,
                  alignItems: 'center', opacity: cpLoading ? 0.5 : 1,
                }}
              >
                <Text style={{ color: colors.text, fontWeight: '600' }}>
                  {t('common.cancel') || 'Cancelar'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={async () => {
                  setCpError(''); setCpSuccess(false);
                  if (!cpCurrent) { setCpError(t('settings.currentPasswordRequired') || 'Informe a senha atual'); return; }
                  if (cpNew.length < 8) { setCpError(t('settings.newPasswordTooShort') || 'Nova senha precisa ter 8+ caracteres'); return; }
                  if (cpNew !== cpConfirm) { setCpError(t('settings.passwordsDontMatch') || 'As senhas não coincidem'); return; }
                  setCpLoading(true);
                  try {
                    const { changePassword } = require('../services/api');
                    const r = await changePassword(cpCurrent, cpNew);
                    if (r?.success) {
                      setCpSuccess(true);
                      setTimeout(() => {
                        setChangePasswordOpen(false);
                        setCpCurrent(''); setCpNew(''); setCpConfirm('');
                        setCpSuccess(false);
                      }, 1400);
                    } else {
                      setCpError(r?.message || (t('settings.passwordChangeFailed') || 'Não foi possível alterar a senha'));
                    }
                  } catch (e) {
                    setCpError(e?.message || 'Erro');
                  } finally {
                    setCpLoading(false);
                  }
                }}
                disabled={cpLoading}
                style={{
                  flex: 1, paddingVertical: 14,
                  borderRadius: 12,
                  backgroundColor: colors.primary,
                  alignItems: 'center', opacity: cpLoading ? 0.6 : 1,
                }}
              >
                {cpLoading ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={{ color: '#fff', fontWeight: '700' }}>
                    {t('settings.save') || t('common.save') || 'Salvar'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* 2FA PIN Entry Modal — 4 digit boxes */}
      <Modal
        visible={twoFAOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setTwoFAOpen(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center' }}
          onPress={() => setTwoFAOpen(false)}
        >
          <Pressable
            onPress={e => e.stopPropagation?.()}
            style={{
              margin: 20,
              backgroundColor: colors.surface,
              borderRadius: 20,
              padding: 24,
              ...(Platform.OS === 'web' ? { boxShadow: '0 20px 50px rgba(0,0,0,0.25)' } : {}),
            }}
          >
            <View style={{ alignItems: 'center', marginBottom: 14 }}>
              <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: colors.primary + '22', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
                <IconShield size={28} color={colors.primary} />
              </View>
              <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text, textAlign: 'center' }}>
                {t('settings.twoFactor') || 'Verificação em duas etapas'}
              </Text>
              <Text style={{ fontSize: 13, color: colors.textTertiary, marginTop: 6, textAlign: 'center', lineHeight: 18 }}>
                {t('settings.twoFactorDesc') || 'Adicione uma camada extra de segurança ao seu Chatyy'}
              </Text>
            </View>

            {/* 4 digit boxes */}
            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 12, marginVertical: 18 }}>
              {[0, 1, 2, 3].map(idx => (
                <TextInput
                  key={idx}
                  ref={el => { twoFARefs.current[idx] = el; }}
                  value={twoFADigits[idx]}
                  onChangeText={(v) => {
                    const digit = (v || '').replace(/\D/g, '').slice(-1);
                    setTwoFADigits(prev => {
                      const next = [...prev];
                      next[idx] = digit;
                      return next;
                    });
                    setTwoFAError('');
                    if (digit && idx < 3) {
                      try { twoFARefs.current[idx + 1]?.focus?.(); } catch {}
                    }
                  }}
                  onKeyPress={(e) => {
                    if (e?.nativeEvent?.key === 'Backspace' && !twoFADigits[idx] && idx > 0) {
                      try { twoFARefs.current[idx - 1]?.focus?.(); } catch {}
                    }
                  }}
                  keyboardType="number-pad"
                  maxLength={1}
                  secureTextEntry
                  style={{
                    width: 56, height: 64, borderRadius: 14,
                    borderWidth: 1.5, borderColor: twoFADigits[idx] ? colors.primary : colors.border,
                    backgroundColor: colors.surfaceVariant || colors.surface,
                    color: colors.text, textAlign: 'center',
                    fontSize: 26, fontWeight: '700',
                    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
                  }}
                />
              ))}
            </View>

            {!!twoFAError && (
              <Text style={{ color: colors.error || '#EF4444', fontSize: 13, textAlign: 'center', marginBottom: 8 }}>
                {twoFAError}
              </Text>
            )}
            {twoFASuccess && (
              <Text style={{ color: '#10B981', fontSize: 13, textAlign: 'center', marginBottom: 8, fontWeight: '600' }}>
                {t('settings.twoFactorEnabled') || 'PIN ativado com sucesso'}
              </Text>
            )}

            <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
              <TouchableOpacity
                onPress={() => { setTwoFAOpen(false); }}
                disabled={twoFALoading}
                style={{
                  flex: 1, paddingVertical: 14, borderRadius: 12,
                  backgroundColor: colors.surfaceVariant || 'transparent',
                  borderWidth: 1, borderColor: colors.border,
                  alignItems: 'center', opacity: twoFALoading ? 0.5 : 1,
                }}
              >
                <Text style={{ color: colors.text, fontWeight: '600' }}>
                  {t('common.cancel') || 'Cancelar'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={async () => {
                  const pin = twoFADigits.join('');
                  if (pin.length !== 4) {
                    setTwoFAError(t('settings.twoFactorPinLen') || 'Digite os 4 dígitos');
                    return;
                  }
                  setTwoFAError(''); setTwoFALoading(true);
                  try {
                    const r = await api.enable2fa(pin);
                    if (r?.success) {
                      setTwoFASuccess(true);
                      setTimeout(() => { setTwoFAOpen(false); setTwoFASuccess(false); }, 1100);
                    } else {
                      setTwoFAError(r?.message || (t('settings.twoFactorFailed') || 'Não foi possível ativar o PIN'));
                    }
                  } catch (e) {
                    setTwoFAError(e?.message || (t('settings.twoFactorFailed') || 'Não foi possível ativar o PIN'));
                  } finally {
                    setTwoFALoading(false);
                  }
                }}
                disabled={twoFALoading}
                style={{
                  flex: 1, paddingVertical: 14, borderRadius: 12,
                  backgroundColor: colors.primary,
                  alignItems: 'center', opacity: twoFALoading ? 0.6 : 1,
                }}
              >
                {twoFALoading ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={{ color: '#fff', fontWeight: '700' }}>
                    {t('settings.twoFactorEnable') || 'Ativar PIN'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Registration Lock PIN Entry Modal — same shape as 2FA but writes a
          separate backend key (registration_lock) that gates phone-OTP login
          rather than email/password login. The PIN is the second factor on
          phone_login_verify; without it, even a successful SIM-swap can't
          take over the account. */}
      <Modal
        visible={regLockOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setRegLockOpen(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center' }}
          onPress={() => setRegLockOpen(false)}
        >
          <Pressable
            onPress={e => e.stopPropagation?.()}
            style={{
              margin: 20,
              backgroundColor: colors.surface,
              borderRadius: 20,
              padding: 24,
              ...(Platform.OS === 'web' ? { boxShadow: '0 20px 50px rgba(0,0,0,0.25)' } : {}),
            }}
          >
            <View style={{ alignItems: 'center', marginBottom: 14 }}>
              <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: colors.primary + '22', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
                <IconShield size={28} color={colors.primary} />
              </View>
              <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text, textAlign: 'center' }}>
                {t('settings.registrationLock') || 'PIN de segurança (anti-SIM-swap)'}
              </Text>
              <Text style={{ fontSize: 13, color: colors.textTertiary, marginTop: 6, textAlign: 'center', lineHeight: 18 }}>
                {t('settings.registrationLockDesc') || 'PIN extra no login por telefone — protege se trocarem seu chip.'}
              </Text>
            </View>

            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 12, marginVertical: 18 }}>
              {[0, 1, 2, 3].map(idx => (
                <TextInput
                  key={idx}
                  ref={el => { regLockRefs.current[idx] = el; }}
                  value={regLockDigits[idx]}
                  onChangeText={(v) => {
                    const digit = (v || '').replace(/\D/g, '').slice(-1);
                    setRegLockDigits(prev => {
                      const next = [...prev];
                      next[idx] = digit;
                      return next;
                    });
                    setRegLockError('');
                    if (digit && idx < 3) {
                      try { regLockRefs.current[idx + 1]?.focus?.(); } catch {}
                    }
                  }}
                  onKeyPress={(e) => {
                    if (e?.nativeEvent?.key === 'Backspace' && !regLockDigits[idx] && idx > 0) {
                      try { regLockRefs.current[idx - 1]?.focus?.(); } catch {}
                    }
                  }}
                  keyboardType="number-pad"
                  maxLength={1}
                  secureTextEntry
                  style={{
                    width: 56, height: 64, borderRadius: 14,
                    borderWidth: 1.5, borderColor: regLockDigits[idx] ? colors.primary : colors.border,
                    backgroundColor: colors.surfaceVariant || colors.surface,
                    color: colors.text, textAlign: 'center',
                    fontSize: 26, fontWeight: '700',
                    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
                  }}
                />
              ))}
            </View>

            {!!regLockError && (
              <Text style={{ color: colors.error || '#EF4444', fontSize: 13, textAlign: 'center', marginBottom: 8 }}>
                {regLockError}
              </Text>
            )}
            {regLockSuccess && (
              <Text style={{ color: '#10B981', fontSize: 13, textAlign: 'center', marginBottom: 8, fontWeight: '600' }}>
                {t('settings.registrationLockEnabled') || 'PIN ativado com sucesso'}
              </Text>
            )}

            <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
              <TouchableOpacity
                onPress={() => { setRegLockOpen(false); }}
                disabled={regLockLoading}
                style={{
                  flex: 1, paddingVertical: 14, borderRadius: 12,
                  backgroundColor: colors.surfaceVariant || 'transparent',
                  borderWidth: 1, borderColor: colors.border,
                  alignItems: 'center', opacity: regLockLoading ? 0.5 : 1,
                }}
              >
                <Text style={{ color: colors.text, fontWeight: '600' }}>
                  {t('common.cancel') || 'Cancelar'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={async () => {
                  const pin = regLockDigits.join('');
                  if (pin.length !== 4) {
                    setRegLockError(t('settings.registrationLockPinLen') || 'Digite os 4 dígitos');
                    return;
                  }
                  setRegLockError(''); setRegLockLoading(true);
                  try {
                    const r = await api.setRegistrationLock(pin);
                    if (r?.success) {
                      setRegLockSuccess(true);
                      setTimeout(() => { setRegLockOpen(false); setRegLockSuccess(false); }, 1100);
                    } else {
                      setRegLockError(r?.message || (t('settings.registrationLockFailed') || 'Não foi possível ativar o PIN'));
                    }
                  } catch (e) {
                    setRegLockError(e?.message || (t('settings.registrationLockFailed') || 'Não foi possível ativar o PIN'));
                  } finally {
                    setRegLockLoading(false);
                  }
                }}
                disabled={regLockLoading}
                style={{
                  flex: 1, paddingVertical: 14, borderRadius: 12,
                  backgroundColor: colors.primary,
                  alignItems: 'center', opacity: regLockLoading ? 0.6 : 1,
                }}
              >
                {regLockLoading ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={{ color: '#fff', fontWeight: '700' }}>
                    {t('settings.registrationLockEnable') || 'Ativar PIN'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
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
    borderBottomWidth: 1,
    ...Platform.select({
      web: { backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' },
      default: {},
    }),
  },
  backBtn: { padding: Spacing.sm, marginRight: Spacing.sm, borderRadius: 12 },
  headerTitle: { flex: 1, fontSize: FontSize.xxl, fontWeight: '700', letterSpacing: -0.3 },
  saveBtn: {
    borderRadius: 24, paddingVertical: Spacing.sm + 2, paddingHorizontal: Spacing.xl,
    ...Platform.select({
      web: { background: 'linear-gradient(135deg, #7C3AED 0%, #A855F7 100%)', boxShadow: '0 4px 12px rgba(124,58,237,0.3)' },
      default: {},
    }),
  },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText: { color: '#fff', fontSize: FontSize.base, fontWeight: '700' },
  // Scroll — paddingBottom extra pra "Excluir conta" (último item da Zona
  // perigosa) não ficar colado no safe-area inferior do iPhone, e pro modal
  // de confirmação não ser cortado quando aparece. User reportou: "embaixo
  // zona perigosa quebra fica tudo cortando".
  scroll: { padding: Spacing.lg, paddingBottom: 80 },
  // Section
  section: {
    borderRadius: 22, padding: Spacing.xl, marginBottom: Spacing.lg + 2,
    ...Platform.select({
      web: {
        transition: 'box-shadow 0.2s ease',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04)',
      },
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.04, shadowRadius: 12 },
      android: { elevation: 1 },
    }),
  },
  profileSection: {
    alignItems: 'center', paddingVertical: Spacing.xxl,
  },
  profileEmail: {
    fontSize: FontSize.lg, marginTop: Spacing.md, marginBottom: Spacing.sm, fontWeight: '500',
  },
  changePhotoBtn: {
    marginTop: Spacing.sm, borderWidth: 1.5, borderRadius: 24,
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.sm + 2,
  },
  changePhotoBtnText: {
    fontSize: FontSize.md, fontWeight: '700',
  },
  sectionTitle: { fontSize: 20, fontWeight: '800', marginBottom: Spacing.lg, letterSpacing: -0.5 },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.lg },
  // Setting row — adds a soft hover state on web so each row reads as
  // "tappable" without an explicit border. Spacing bumped slightly for
  // a more relaxed iOS-Settings density.
  settingRow: {
    flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8,
    paddingVertical: Spacing.md + 6, borderBottomWidth: 1,
    ...Platform.select({
      web: { transition: 'background-color 0.15s ease', cursor: 'pointer' },
      default: {},
    }),
  },
  settingRowColumn: {
    flexDirection: 'column', alignItems: 'flex-start',
    paddingVertical: Spacing.md + 4, borderBottomWidth: 1,
  },
  settingInfo: { flex: 1 },
  settingLabel: { fontSize: 15.5, fontWeight: '600', letterSpacing: -0.15 },
  settingDesc: { fontSize: 13, marginTop: 3, opacity: 0.7, lineHeight: 18 },
  // Per page
  perPageBtns: { flexDirection: 'row', gap: Spacing.sm },
  perPageBtn: {
    borderWidth: 1.5, borderRadius: 12,
    paddingHorizontal: Spacing.md, paddingVertical: 8,
    ...Platform.select({
      web: { transition: 'all 0.15s ease', cursor: 'pointer' },
      default: {},
    }),
  },
  perPageText: { fontSize: FontSize.base, fontWeight: '600' },
  // Signature
  sigCard: { borderWidth: 1, borderRadius: 14, padding: Spacing.md, marginBottom: Spacing.sm },
  sigHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sigNameInput: {
    flex: 1, fontSize: FontSize.sm, borderBottomWidth: 1, paddingVertical: 2, fontWeight: '500',
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  defaultBtn: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: BorderRadius.xxl },
  addSigBtn: { borderWidth: 1.5, borderStyle: 'dashed', borderRadius: 14, paddingVertical: 12, alignItems: 'center' },
  signatureInput: {
    borderWidth: 1, borderRadius: BorderRadius.md,
    padding: Spacing.md, fontSize: FontSize.base,
    minHeight: 100, ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  // AI Features
  aiFeatures: { marginTop: Spacing.md },
  aiFeatureRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: Spacing.sm,
  },
  aiFeatureIconWrap: { marginRight: Spacing.md, width: 24, alignItems: 'center' },
  aiFeatureText: { fontSize: FontSize.base },
  // Toggle switch
  toggleTrack: {
    width: 48, height: 26, borderRadius: 13,
    justifyContent: 'center', padding: 2,
    ...Platform.select({
      web: { transition: 'background-color 0.2s ease', cursor: 'pointer' },
      default: {},
    }),
  },
  toggleThumb: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: '#fff',
    ...(Platform.OS === 'web' ? { boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'all 0.2s ease' } : {}),
  },
  toggleThumbActive: { alignSelf: 'flex-end' },
  // Delete account
  deleteConfirmBox: {
    borderWidth: 1, borderRadius: BorderRadius.md, padding: Spacing.lg, marginTop: Spacing.md,
  },
  deleteConfirmTitle: { fontSize: FontSize.lg, fontWeight: '700', marginBottom: Spacing.sm },
  deleteConfirmText: { fontSize: FontSize.sm, lineHeight: 20, marginBottom: Spacing.md },
  deletePasswordInput: {
    borderWidth: 1, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, paddingVertical: 10,
    fontSize: FontSize.base, marginBottom: Spacing.sm,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  deleteErrorText: { fontSize: FontSize.sm, fontWeight: '500', marginBottom: Spacing.sm },
  deleteActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.sm, marginTop: Spacing.sm },
  deleteCancelBtn: {
    borderWidth: 1, borderRadius: BorderRadius.md,
    paddingVertical: 10, paddingHorizontal: Spacing.xl,
  },
  deleteCancelText: { fontSize: FontSize.base, fontWeight: '500' },
  deleteConfirmBtn: {
    borderRadius: BorderRadius.md,
    paddingVertical: 10, paddingHorizontal: Spacing.xl,
  },
  deleteConfirmBtnText: { color: '#fff', fontSize: FontSize.base, fontWeight: '700' },
});

export default function SettingsScreen() { return <ErrorBoundary><SettingsScreenInner /></ErrorBoundary>; }
