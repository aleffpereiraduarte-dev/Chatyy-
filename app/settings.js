import ErrorBoundary from "../components/ErrorBoundary";
import { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  Switch, ActivityIndicator, Platform, Alert, Image, Linking, Share,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import AvatarCircle from '../components/AvatarCircle';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import {
  IconArrowLeft, IconSparkles, IconMessageSquare, IconPenTool, IconDraft,
  IconFilter, IconChevronRight, IconGlobe, IconTrash, IconBell, IconForward,
  IconShield, IconFileText, IconUser, IconUsers, IconPlus,
} from '../components/Icons';
import { useBiometric } from '../context/BiometricContext';
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
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [undoDelay, setUndoDelay] = useState(5);
  const [smartComposeOn, setSmartComposeOn] = useState(true);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [oneEnabled, setOneEnabled] = useState(true);
  const [oneNotifLevel, setOneNotifLevel] = useState('push'); // 'email', 'push', 'urgent'
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
    } else {
      import('@react-native-async-storage/async-storage').then(m => {
        Promise.all([
          m.default.getItem('one_enabled'),
          m.default.getItem('one_notif_level'),
        ]).then(([enabled, level]) => {
          if (enabled === 'false') setOneEnabled(false);
          if (level) setOneNotifLevel(level);
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
        setSettings(prev => ({ ...prev, ...r.data }));
      }
    } catch {} finally {
      setLoading(false);
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
        const { uploadAvatar } = await import('../services/api');
        const file = { uri: asset.uri, name: 'avatar.jpg', type: 'image/jpeg' };
        const r = await uploadAvatar(file);
        if (r.success) setAvatarKey(Date.now());
      }
    } catch {}
  };

  return (
    <View style={[s.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[s.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
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
      <ScrollView contentContainerStyle={s.scroll}>
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
          <View style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.density')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.densityDesc')}
              </Text>
            </View>
            <View style={s.perPageBtns}>
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

          <View style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
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
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
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
                  { val: 'email', label: t('settings.oneNotifEmail'), icon: '📧' },
                  { val: 'push', label: t('settings.oneNotifPush'), icon: '🔔' },
                  { val: 'urgent', label: t('settings.oneNotifUrgent'), icon: '📞' },
                ].map(opt => (
                  <TouchableOpacity
                    key={opt.val}
                    style={[
                      s.perPageBtn,
                      { borderColor: colors.divider, flex: 1, paddingVertical: 10 },
                      oneNotifLevel === opt.val && { backgroundColor: '#6366f1', borderColor: '#6366f1' },
                    ]}
                    onPress={() => {
                      setOneNotifLevel(opt.val);
                      setStorage('one_notif_level', opt.val);
                    }}
                  >
                    <Text style={[
                      s.perPageText, { color: colors.text, textAlign: 'center' },
                      oneNotifLevel === opt.val && { color: '#fff' },
                    ]}>
                      {opt.icon} {opt.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          )}
        </View>

        {/* Desktop Notifications */}
        {Platform.OS === 'web' && (
          <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
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
          <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
            {/* Parental Controls */}
            <TouchableOpacity
              style={[s.settingRow, { borderBottomColor: colors.borderLight, marginBottom: Spacing.lg, backgroundColor: isDark ? '#1a2e1a' : '#f0fdf4', borderRadius: 14, padding: 14 }]}
              onPress={() => router.push('/parental')}
            >
              <View style={s.settingInfo}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <IconShield size={20} color="#25D366" />
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
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
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

        {/* Danger Zone */}
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.error }]}>{t('settings.dangerZone')}</Text>
          <TouchableOpacity
            style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
            onPress={() => {
              const doEmpty = async () => {
                const { emptyTrash } = await import('../services/api');
                await emptyTrash();
              };
              if (Platform.OS === 'web') {
                if (typeof window !== 'undefined' && window.confirm(t('settings.emptyTrashConfirmWeb'))) doEmpty();
              } else {
                Alert.alert(
                  t('settings.emptyTrashTitle'),
                  t('settings.emptyTrashConfirmNative'),
                  [
                    { text: t('common.cancel'), style: 'cancel' },
                    { text: t('common.confirm'), style: 'destructive', onPress: doEmpty },
                  ]
                );
              }
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

          {/* Referral System */}
          <View style={[s.settingRow, { borderBottomColor: colors.borderLight, flexDirection: 'column', alignItems: 'stretch' }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.sm }}>
              <IconUsers size={18} color={colors.primary} style={{ marginRight: Spacing.sm }} />
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('referral.inviteFriends')}</Text>
            </View>
            <Text style={[s.settingDesc, { color: colors.textTertiary, marginBottom: Spacing.md }]}>
              {t('referral.description')}
            </Text>
            {referralCode ? (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.sm, gap: 8 }}>
                  <View style={{ flex: 1, backgroundColor: colors.surfaceVariant || colors.border + '30', borderRadius: BorderRadius.md, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center' }}>
                    <Text style={{ fontSize: 20, fontWeight: '800', color: colors.primary, letterSpacing: 3 }}>{referralCode}</Text>
                  </View>
                  <TouchableOpacity onPress={handleShareReferral} style={{ backgroundColor: colors.primary, borderRadius: BorderRadius.md, paddingVertical: 10, paddingHorizontal: 16 }}>
                    <Text style={{ color: '#fff', fontWeight: '600', fontSize: FontSize.sm }}>{t('referral.share')}</Text>
                  </TouchableOpacity>
                </View>
                <Text style={{ fontSize: FontSize.xs, color: colors.textSecondary }}>
                  {t('referral.friendsInvited').replace('{count}', String(referralCount))}
                </Text>
              </>
            ) : (
              <ActivityIndicator size="small" color={colors.primary} />
            )}
          </View>

          {/* Account Deletion — Apple Requirement */}
          <TouchableOpacity
            style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
            onPress={() => {
              if (Platform.OS === 'web') {
                setDeleteConfirm(true);
                setDeletePassword('');
                setDeleteError('');
              } else {
                Alert.alert(
                  t('settings.deleteAccountConfirmTitle'),
                  t('settings.deleteAccountConfirmMessage'),
                  [
                    { text: t('common.cancel'), style: 'cancel' },
                    { text: t('settings.deleteAccount'), style: 'destructive', onPress: () => {
                      setDeleteConfirm(true);
                      setDeletePassword('');
                      setDeleteError('');
                    }},
                  ]
                );
              }
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

          {deleteConfirm && (
            <View style={[s.deleteConfirmBox, { backgroundColor: colors.errorBg || (colors.error + '08'), borderColor: colors.error + '30' }]}>
              <Text style={[s.deleteConfirmTitle, { color: colors.error }]}>{t('settings.confirmAccountDeletion')}</Text>
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
              {!!deleteError && <Text style={[s.deleteErrorText, { color: colors.error }]}>{deleteError}</Text>}
              <View style={s.deleteActions}>
                <TouchableOpacity
                  onPress={() => { setDeleteConfirm(false); setDeletePassword(''); setDeleteError(''); }}
                  style={[s.deleteCancelBtn, { borderColor: colors.border }]}
                >
                  <Text style={[s.deleteCancelText, { color: colors.text }]}>{t('common.cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={async () => {
                    if (!deletePassword.trim()) { setDeleteError(t('settings.enterPassword')); return; }
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
                  disabled={deleting}
                  style={[s.deleteConfirmBtn, { backgroundColor: colors.error }]}
                >
                  {deleting ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={s.deleteConfirmBtnText}>{t('settings.deleteMyAccount')}</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      </ScrollView>
      )}

      <FilterRuleEditor visible={showFilters} onClose={() => setShowFilters(false)} />
      <PrivacyModal visible={showPrivacy} onClose={() => setShowPrivacy(false)} />
      <TermsModal visible={showTerms} onClose={() => setShowTerms(false)} />
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
      web: { background: 'linear-gradient(135deg, #2563eb 0%, #6366f1 100%)', boxShadow: '0 4px 12px rgba(37,99,235,0.3)' },
      default: {},
    }),
  },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText: { color: '#fff', fontSize: FontSize.base, fontWeight: '700' },
  // Scroll
  scroll: { padding: Spacing.lg },
  // Section
  section: {
    borderRadius: 20, padding: Spacing.xl, marginBottom: Spacing.lg,
    ...Platform.select({
      web: {
        transition: 'box-shadow 0.2s ease',
        boxShadow: '0 1px 4px rgba(0,0,0,0.03)',
      },
      default: {},
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
  sectionTitle: { fontSize: FontSize.xl, fontWeight: '700', marginBottom: Spacing.lg, letterSpacing: -0.2 },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.lg },
  // Setting row
  settingRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: Spacing.md + 2, borderBottomWidth: 1,
  },
  settingInfo: { flex: 1 },
  settingLabel: { fontSize: FontSize.lg, fontWeight: '500' },
  settingDesc: { fontSize: FontSize.md, marginTop: 2, opacity: 0.65 },
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
