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
import AvatarCircle from './AvatarCircle';
import {
  IconUser, IconEdit, IconCamera, IconChevronRight, IconLock, IconArrowLeft,
  IconPhone, IconMail, IconImage, IconX, IconCheck, IconBell,
  IconShield, IconGlobe, IconTranslate, IconSmartphone, IconInfo,
  IconHeart, IconMessageSquare, IconUsers, IconKey, IconTrash,
  IconEye, IconEyeOff, IconFileText, IconLogout, IconUpload, IconDownload,
} from './Icons';
import * as api from '../services/api';
import { emailToDisplayName } from '../services/api';
import { LANGUAGES } from '../i18n';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { useBiometric } from '../context/BiometricContext';

const ACCENT = '#25D366';

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

  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState(null);
  const [subScreen, setSubScreen] = useState(null);
  const [blockedCount, setBlockedCount] = useState(0);

  // Account sub-screen state
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [changingPw, setChangingPw] = useState(false);
  const [showPw, setShowPw] = useState(false);

  // Settings state
  const [settings, setSettings] = useState({
    notifications: true,
    notification_sound: true,
    notification_vibration: true,
    read_receipts: true,
    font_size: 'medium',
    wallpaper: 'none',
    last_seen_privacy: 'everyone',
    profile_photo_privacy: 'everyone',
    about_privacy: 'everyone',
    blocked_contacts: [],
  });

  // Backup state
  const [backupRunning, setBackupRunning] = useState(false);
  const [backupProgress, setBackupProgress] = useState({ current: 0, total: 0 });
  const [backupResult, setBackupResult] = useState(null); // 'success' | 'error' | null

  // Restore state
  const [restoreModalVisible, setRestoreModalVisible] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [backupsList, setBackupsList] = useState([]);
  const [restoreRunning, setRestoreRunning] = useState(false);
  const [restoreResult, setRestoreResult] = useState(null); // { conversations, messages } | null

  const handleBackupNow = async () => {
    if (backupRunning) return;
    setBackupRunning(true);
    setBackupProgress({ current: 0, total: 0 });
    setBackupResult(null);

    // Always use chat backup API (conversation backup, not photo backup)
    try {
      const r = await api.chatBackupCreate();
      if (r.success) {
        setBackupResult('success');
        setTimeout(() => setBackupResult(null), 5000);
      } else {
        safeAlert(t?.('common.error') || 'Error', r.message || t?.('chat.backupErrorDesc') || 'Failed');
        setBackupResult('error');
      }
    } catch {
      setBackupResult('error');
    }
    setBackupRunning(false);
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
                safeAlert(t?.('common.error') || 'Erro', r.message || 'Failed');
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

  const currentEmail = user?.email || '';
  const currentName = user?.name || currentEmail.split('@')[0];

  const loadProfile = useCallback(async () => {
    try {
      const [profileR, settingsR] = await Promise.all([
        api.getProfile(),
        api.chatGetSettings(),
      ]);
      if (profileR.success && profileR.data) {
        setProfile(profileR.data);
        if (profileR.data.has_avatar || profileR.data.avatar) {
          setAvatarUrl(api.getAvatarUrl(currentEmail));
        }
      }
      if (settingsR.success && settingsR.data) {
        setSettings(prev => ({ ...prev, ...settingsR.data }));
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
  useEffect(() => {
    api.chatBlockedList().then(r => {
      if (r.success) setBlockedCount((r.data || []).length);
    }).catch(() => {});
  }, [subScreen]);

  const saveSettings = async (updates) => {
    const newSettings = { ...settings, ...updates };
    setSettings(newSettings);
    try {
      await api.chatUpdateSettings(updates);
      const notifPrefs = {
        notification_sound: newSettings.notification_sound,
        notification_vibration: newSettings.notification_vibration,
      };
      setStorage('chatyy_notif_prefs', JSON.stringify(notifPrefs));
    } catch {}
  };

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

  const handleAvatarPick = async () => {
    if (Platform.OS === 'web') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          const r = await api.uploadAvatar(file);
          if (r.success) setAvatarUrl(api.getAvatarUrl(currentEmail) + '&t=' + Date.now());
        } catch {}
      };
      input.click();
    } else {
      try {
        const { launchImageLibraryAsync, MediaTypeOptions } = await import('expo-image-picker');
        const result = await launchImageLibraryAsync({
          mediaTypes: MediaTypeOptions.Images,
          quality: 0.8, allowsEditing: true, aspect: [1, 1],
        });
        if (!result.canceled && result.assets?.[0]) {
          const asset = result.assets[0];
          const r = await api.uploadAvatar({
            uri: asset.uri, name: 'avatar.jpg',
            type: asset.mimeType || 'image/jpeg',
          });
          if (r.success) setAvatarUrl(api.getAvatarUrl(currentEmail) + '&t=' + Date.now());
        }
      } catch {}
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
    safeAlert(
      t?.('config.logoutTitle') || 'Sair',
      t?.('config.logoutConfirm') || 'Tem certeza que deseja sair?',
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
    const skBg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
    return (
      <View style={[styles.container, { backgroundColor: screenBg, paddingTop: 40, alignItems: 'center', gap: 16 }]}>
        <View style={{ width: 90, height: 90, borderRadius: 45, backgroundColor: skBg }} />
        <View style={{ width: 150, height: 16, borderRadius: 8, backgroundColor: skBg }} />
        <View style={{ width: 200, height: 12, borderRadius: 6, backgroundColor: skBg }} />
        <View style={{ width: '85%', gap: 10, marginTop: 24 }}>
          {[0,1,2,3,4].map(i => (
            <View key={i} style={{ height: 52, borderRadius: 14, backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : '#fff' }} />
          ))}
        </View>
      </View>
    );
  }

  const name = profile?.name || currentName;
  const about = profile?.about || profile?.recado || t?.('profile.defaultAbout') || 'Disponivel';
  const phone = profile?.phone || profile?.verified_phone || '';

  // ─── Sub-screen header ───
  const SubHeader = ({ title }) => (
    <View style={[styles.subHeader, {
      backgroundColor: isDark ? '#1F2C33' : '#075E54',
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
                trackColor={{ false: isDark ? '#374151' : '#d1d5db', true: 'rgba(37,211,102,0.4)' }}
                thumbColor={settings.read_receipts ? ACCENT : isDark ? '#555' : '#ccc'}
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
                    trackColor={{ false: isDark ? '#374151' : '#d1d5db', true: 'rgba(37,211,102,0.4)' }}
                    thumbColor={biometricEnabled ? ACCENT : isDark ? '#555' : '#ccc'}
                  />
                </View>
              </>
            )}

            <View style={[styles.dividerFull, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }]} />

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
                trackColor={{ false: isDark ? '#374151' : '#d1d5db', true: 'rgba(37,211,102,0.4)' }}
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
                    trackColor={{ false: isDark ? '#374151' : '#d1d5db', true: 'rgba(37,211,102,0.4)' }}
                    thumbColor={settings.notification_sound ? ACCENT : isDark ? '#555' : '#ccc'}
                  />
                </View>
                <View style={[styles.rowSeparator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)', marginLeft: 36 }]} />
                <View style={[styles.switchRowModern, { paddingLeft: 36 }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.notifVibration') || 'Vibracao'}</Text>
                    <Text style={[styles.switchDesc, { color: isDark ? '#6b7280' : '#9ca3af' }]}>{t?.('config.notifVibrationDesc') || 'Vibrar ao receber mensagem'}</Text>
                  </View>
                  <Switch
                    value={settings.notification_vibration}
                    onValueChange={(v) => saveSettings({ notification_vibration: v })}
                    trackColor={{ false: isDark ? '#374151' : '#d1d5db', true: 'rgba(37,211,102,0.4)' }}
                    thumbColor={settings.notification_vibration ? ACCENT : isDark ? '#555' : '#ccc'}
                  />
                </View>
              </>
            )}

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
      '#075E54', '#0C8767', '#E4DCD4', '#008069', '#1B3A2D',
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
                trackColor={{ false: isDark ? '#374151' : '#d1d5db', true: 'rgba(37,211,102,0.4)' }}
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
              <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(37,211,102,0.1)' : '#ecfdf5' }]}>
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
    return (
      <View style={[styles.container, { backgroundColor: screenBg }]}>
        <SubHeader title={t?.('config.storage') || 'Armazenamento e dados'} />
        <ScrollView contentContainerStyle={{ paddingBottom: 100 }}>
          <SectionCard style={{ marginTop: 16 }}>
            <View style={styles.storageInfoModern}>
              <View style={[styles.storageIconCircle, { backgroundColor: isDark ? 'rgba(37,211,102,0.1)' : '#ecfdf5' }]}>
                <IconSmartphone size={32} color={ACCENT} />
              </View>
              <Text style={[styles.storageTitle, { color: colors.text }]}>{t?.('config.storageUsage') || 'Uso de armazenamento'}</Text>
              <Text style={[styles.storageDesc, { color: isDark ? '#6b7280' : '#9ca3af' }]}>
                {t?.('config.storageDesc2') || 'As mensagens e midia sao armazenadas no servidor. O app mantem um cache local minimo.'}
              </Text>
            </View>

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
    const [blockedList, setBlockedList] = useState([]);
    const [blockedLoading, setBlockedLoading] = useState(true);

    useEffect(() => {
      api.chatBlockedList().then(r => {
        if (r.success) setBlockedList(r.data || []);
      }).catch(() => {}).finally(() => setBlockedLoading(false));
    }, []);

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
            {/* Avatar with camera overlay */}
            <TouchableOpacity style={styles.avatarContainerModern} onPress={handleAvatarPick} activeOpacity={0.8}>
              {avatarUrl ? (
                <ExpoImage source={{ uri: avatarUrl }} style={styles.avatarModern} cachePolicy="memory-disk" transition={200} />
              ) : (
                <AvatarCircle name={name} email={currentEmail} size={96} />
              )}
              <View style={[styles.cameraOverlayModern, Platform.select({
                ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.35, shadowRadius: 4 },
                android: { elevation: 4 },
                web: { boxShadow: '0 2px 8px rgba(37,211,102,0.35)' },
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
                  <TouchableOpacity onPress={() => setEditing(null)} style={styles.editActionBtn}>
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
                  <TouchableOpacity onPress={() => setEditing(null)} style={styles.editActionBtn}>
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

        {/* Phone Number */}
        <SectionCard style={{ marginTop: 10 }}>
          <View style={styles.phoneRowModern}>
            <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(37,211,102,0.1)' : '#ecfdf5' }]}>
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
                  <View style={[styles.verifiedBadge, { backgroundColor: isDark ? 'rgba(37,211,102,0.1)' : '#ecfdf5' }]}>
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

        {/* Account & Privacy Section */}
        <SectionLabel label={t?.('config.account') || 'CONTA'} />
        <SectionCard>
          <SettingItem icon={<IconKey size={18} color="#3b82f6" />} iconBg={isDark ? 'rgba(59,130,246,0.1)' : '#e0f2fe'}
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
            backgroundColor: isDark ? 'rgba(37,211,102,0.06)' : '#f0fdf4',
            borderColor: isDark ? 'rgba(37,211,102,0.15)' : 'rgba(37,211,102,0.2)',
          }, smallShadow(isDark)]}
          onPress={handleInvite}
          activeOpacity={0.8}
        >
          <View style={[styles.inviteIconWrap, { backgroundColor: ACCENT }, Platform.select({
            ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 6 },
            android: { elevation: 3 },
            web: { boxShadow: '0 2px 10px rgba(37,211,102,0.3)' },
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
            <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(37,211,102,0.1)' : '#ecfdf5' }]}>
              {backupRunning ? (
                <ActivityIndicator size="small" color={ACCENT} />
              ) : backupResult === 'success' ? (
                <IconCheck size={18} color={ACCENT} />
              ) : (
                <IconUpload size={18} color={ACCENT} />
              )}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.switchLabel, { color: colors.text }]}>
                {backupRunning
                  ? (t?.('chat.backupInProgress') || 'Fazendo backup...')
                  : backupResult === 'success'
                    ? (t?.('chat.backupComplete') || 'Backup concluido!')
                    : (t?.('chat.backupNow') || 'Fazer backup agora')}
              </Text>
              {backupRunning && backupProgress.total > 0 ? (
                <View style={{ marginTop: 4 }}>
                  <Text style={[styles.switchDesc, { color: ACCENT, fontWeight: '600' }]}>
                    {backupProgress.current} / {backupProgress.total} {t?.('chat.backupPhotos') || 'fotos'}
                  </Text>
                  <View style={{ height: 4, borderRadius: 2, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', marginTop: 6, overflow: 'hidden' }}>
                    <View style={{ height: '100%', width: `${Math.min((backupProgress.current / backupProgress.total) * 100, 100)}%`, backgroundColor: ACCENT, borderRadius: 2 }} />
                  </View>
                </View>
              ) : backupRunning ? (
                <Text style={[styles.switchDesc, { color: isDark ? '#6b7280' : '#9ca3af' }]}>
                  {t?.('chat.backupPreparing') || 'Preparando...'}
                </Text>
              ) : backupResult === 'success' ? (
                <Text style={[styles.switchDesc, { color: ACCENT }]}>
                  {t?.('chat.backupSuccessDesc') || 'Seus dados foram salvos com sucesso'}
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
            {!backupRunning && backupResult !== 'success' && (
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
            <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(59,130,246,0.1)' : '#eff6ff' }]}>
              {restoreRunning ? (
                <ActivityIndicator size="small" color="#3b82f6" />
              ) : (
                <IconDownload size={18} color="#3b82f6" />
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
                          <View style={[styles.iconCircle, { backgroundColor: isDark ? 'rgba(59,130,246,0.1)' : '#eff6ff' }]}>
                            <IconFileText size={18} color="#3b82f6" />
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
      web: { boxShadow: '0 2px 10px rgba(37,211,102,0.25)' },
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
      web: { boxShadow: '0 2px 10px rgba(37,211,102,0.3)' },
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
