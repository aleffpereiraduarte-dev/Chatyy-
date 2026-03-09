import { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Platform,
  TextInput, Alert, ActivityIndicator, Switch, Image, Share, Modal, Linking,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import AvatarCircle from './AvatarCircle';
import {
  IconUser, IconEdit, IconCamera, IconChevronRight, IconLock, IconArrowLeft,
  IconPhone, IconMail, IconImage, IconX, IconCheck, IconBell,
  IconShield, IconGlobe, IconTranslate, IconSmartphone, IconInfo,
  IconHeart, IconMessageSquare, IconUsers, IconKey, IconTrash,
  IconEye, IconEyeOff, IconFileText, IconLogout,
} from './Icons';
import * as api from '../services/api';
import { LANGUAGES } from '../i18n';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { useBiometric } from '../context/BiometricContext';

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
  const [subScreen, setSubScreen] = useState(null); // 'account' | 'privacy' | 'notifications' | 'chats' | 'storage' | 'language' | 'help' | 'blocked' | null

  // Account sub-screen state (must be at top level for hooks rules)
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [changingPw, setChangingPw] = useState(false);
  const [showPw, setShowPw] = useState(false);

  // Settings state (loaded from server + local)
  const [settings, setSettings] = useState({
    notifications: true,
    notification_sound: true,
    notification_vibration: true,
    read_receipts: true,
    font_size: 'medium',
    wallpaper: 'none',
    last_seen_privacy: 'everyone', // 'everyone' | 'contacts' | 'nobody'
    profile_photo_privacy: 'everyone',
    about_privacy: 'everyone',
    blocked_contacts: [],
  });

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
      // Load local notification prefs
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

  const saveSettings = async (updates) => {
    const newSettings = { ...settings, ...updates };
    setSettings(newSettings);
    try {
      await api.chatUpdateSettings(updates);
      // Also persist notification prefs locally
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
    const msg = t?.('chat.inviteMessage') || 'Ei! Baixa o Chatyy pra gente conversar!\nhttps://mail.onemundo.com.br';
    if (Platform.OS === 'web') {
      try { await navigator.clipboard.writeText(msg); Alert.alert('Chatyy', t?.('chat.inviteCopied') || 'Link copiado!'); } catch {}
    } else {
      try { await Share.share({ message: msg, title: 'Chatyy' }); } catch {}
    }
  };

  const handleLogout = () => {
    Alert.alert(
      t?.('config.logoutTitle') || 'Sair',
      t?.('config.logoutConfirm') || 'Tem certeza que deseja sair?',
      [
        { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
        { text: t?.('config.logout') || 'Sair', style: 'destructive', onPress: () => { logout(); router.replace('/login'); } },
      ]
    );
  };

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color="#25D366" />
      </View>
    );
  }

  const name = profile?.name || currentName;
  const about = profile?.about || profile?.recado || t?.('profile.defaultAbout') || 'Disponível';
  const phone = profile?.phone || profile?.verified_phone || '';

  // ─── Sub-screen header ───
  const SubHeader = ({ title }) => (
    <View style={[styles.subHeader, { backgroundColor: colors.background, borderBottomColor: colors.border }]}>
      <TouchableOpacity onPress={() => setSubScreen(null)} style={styles.subBackBtn}>
        <IconArrowLeft size={22} color={colors.text} />
      </TouchableOpacity>
      <Text style={[styles.subTitle, { color: colors.text }]}>{title}</Text>
      <View style={{ width: 40 }} />
    </View>
  );

  // ─── Privacy sub-screen ───
  if (subScreen === 'privacy') {
    const privacyOptions = [
      { value: 'everyone', label: t?.('config.everyone') || 'Todos' },
      { value: 'contacts', label: t?.('config.contacts') || 'Meus contatos' },
      { value: 'nobody', label: t?.('config.nobody') || 'Ninguém' },
    ];
    return (
      <View style={[styles.container, { backgroundColor: isDark ? '#000' : '#f0f2f5' }]}>
        <SubHeader title={t?.('config.privacy') || 'Privacidade'} />
        <ScrollView>
          <View style={[styles.section, { backgroundColor: colors.background }]}>
            {/* Last seen */}
            <Text style={[styles.privacyLabel, { color: colors.textSecondary }]}>
              {t?.('config.lastSeen') || 'Visto por último e online'}
            </Text>
            <View style={styles.radioGroup}>
              {privacyOptions.map(opt => (
                <TouchableOpacity key={opt.value} style={styles.radioRow} onPress={() => saveSettings({ last_seen_privacy: opt.value })}>
                  <View style={[styles.radio, { borderColor: colors.border }, settings.last_seen_privacy === opt.value && styles.radioActive]}>
                    {settings.last_seen_privacy === opt.value && <View style={styles.radioDot} />}
                  </View>
                  <Text style={[styles.radioLabel, { color: colors.text }]}>{opt.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Profile photo */}
            <Text style={[styles.privacyLabel, { color: colors.textSecondary, marginTop: 20 }]}>
              {t?.('config.profilePhoto') || 'Foto do perfil'}
            </Text>
            <View style={styles.radioGroup}>
              {privacyOptions.map(opt => (
                <TouchableOpacity key={opt.value} style={styles.radioRow} onPress={() => saveSettings({ profile_photo_privacy: opt.value })}>
                  <View style={[styles.radio, { borderColor: colors.border }, settings.profile_photo_privacy === opt.value && styles.radioActive]}>
                    {settings.profile_photo_privacy === opt.value && <View style={styles.radioDot} />}
                  </View>
                  <Text style={[styles.radioLabel, { color: colors.text }]}>{opt.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* About */}
            <Text style={[styles.privacyLabel, { color: colors.textSecondary, marginTop: 20 }]}>
              {t?.('config.aboutVisibility') || 'Recado'}
            </Text>
            <View style={styles.radioGroup}>
              {privacyOptions.map(opt => (
                <TouchableOpacity key={opt.value} style={styles.radioRow} onPress={() => saveSettings({ about_privacy: opt.value })}>
                  <View style={[styles.radio, { borderColor: colors.border }, settings.about_privacy === opt.value && styles.radioActive]}>
                    {settings.about_privacy === opt.value && <View style={styles.radioDot} />}
                  </View>
                  <Text style={[styles.radioLabel, { color: colors.text }]}>{opt.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Read receipts */}
            <View style={[styles.switchRow, { borderTopColor: colors.border, marginTop: 20 }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.readReceipts') || 'Confirmação de leitura'}</Text>
                <Text style={[styles.switchDesc, { color: colors.textSecondary }]}>{t?.('config.readReceiptsDesc') || 'Mostrar quando você leu mensagens'}</Text>
              </View>
              <Switch
                value={settings.read_receipts}
                onValueChange={(v) => saveSettings({ read_receipts: v })}
                trackColor={{ false: colors.border, true: '#25D36666' }}
                thumbColor={settings.read_receipts ? '#25D366' : '#ccc'}
              />
            </View>

            {/* Biometric lock (native only) */}
            {Platform.OS !== 'web' && biometricAvailable && (
              <View style={[styles.switchRow, { borderTopColor: colors.border }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.appLock') || 'Bloqueio do app'}</Text>
                  <Text style={[styles.switchDesc, { color: colors.textSecondary }]}>{t?.('config.appLockDesc') || 'Usar biometria para desbloquear'}</Text>
                </View>
                <Switch
                  value={biometricEnabled}
                  onValueChange={toggleBiometric}
                  trackColor={{ false: colors.border, true: '#25D36666' }}
                  thumbColor={biometricEnabled ? '#25D366' : '#ccc'}
                />
              </View>
            )}

            {/* Blocked contacts */}
            <TouchableOpacity
              style={[styles.linkRow, { borderTopColor: colors.border }]}
              onPress={() => setSubScreen('blocked')}
            >
              <IconX size={18} color="#dc2626" />
              <Text style={[styles.linkText, { color: '#dc2626' }]}>{t?.('config.blocked') || 'Contatos bloqueados'}</Text>
              <Text style={[styles.linkCount, { color: colors.textSecondary }]}>{(settings.blocked_contacts || []).length}</Text>
              <IconChevronRight size={16} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>
        </ScrollView>
      </View>
    );
  }

  // ─── Notifications sub-screen ───
  if (subScreen === 'notifications') {
    return (
      <View style={[styles.container, { backgroundColor: isDark ? '#000' : '#f0f2f5' }]}>
        <SubHeader title={t?.('config.notifications') || 'Notificações'} />
        <ScrollView>
          <View style={[styles.section, { backgroundColor: colors.background }]}>
            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.notifMessages') || 'Notificações de mensagens'}</Text>
                <Text style={[styles.switchDesc, { color: colors.textSecondary }]}>{t?.('config.notifMessagesDesc') || 'Receber notificações de novas mensagens'}</Text>
              </View>
              <Switch
                value={settings.notifications}
                onValueChange={(v) => saveSettings({ notifications: v })}
                trackColor={{ false: colors.border, true: '#25D36666' }}
                thumbColor={settings.notifications ? '#25D366' : '#ccc'}
              />
            </View>

            {settings.notifications && (
              <>
                <View style={[styles.switchRow, { borderTopColor: colors.border, paddingLeft: 32 }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.notifSound') || 'Sons'}</Text>
                    <Text style={[styles.switchDesc, { color: colors.textSecondary }]}>{t?.('config.notifSoundDesc') || 'Tocar som ao receber mensagem'}</Text>
                  </View>
                  <Switch
                    value={settings.notification_sound}
                    onValueChange={(v) => saveSettings({ notification_sound: v })}
                    trackColor={{ false: colors.border, true: '#25D36666' }}
                    thumbColor={settings.notification_sound ? '#25D366' : '#ccc'}
                  />
                </View>
                <View style={[styles.switchRow, { borderTopColor: colors.border, paddingLeft: 32 }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.notifVibration') || 'Vibração'}</Text>
                    <Text style={[styles.switchDesc, { color: colors.textSecondary }]}>{t?.('config.notifVibrationDesc') || 'Vibrar ao receber mensagem'}</Text>
                  </View>
                  <Switch
                    value={settings.notification_vibration}
                    onValueChange={(v) => saveSettings({ notification_vibration: v })}
                    trackColor={{ false: colors.border, true: '#25D36666' }}
                    thumbColor={settings.notification_vibration ? '#25D366' : '#ccc'}
                  />
                </View>
              </>
            )}

            {/* Web notification permission */}
            {Platform.OS === 'web' && typeof window !== 'undefined' && 'Notification' in window && (
              <View style={[styles.switchRow, { borderTopColor: colors.border }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.desktopNotifs') || 'Notificações do desktop'}</Text>
                  <Text style={[styles.switchDesc, { color: colors.textSecondary }]}>
                    {Notification.permission === 'granted' ? (t?.('config.notifsEnabled') || 'Ativadas') : (t?.('config.notifsDisabled') || 'Desativadas')}
                  </Text>
                </View>
                {Notification.permission !== 'granted' && Notification.permission !== 'denied' && (
                  <TouchableOpacity
                    style={[styles.enableBtn, { backgroundColor: '#25D366' }]}
                    onPress={async () => { await Notification.requestPermission(); }}
                  >
                    <Text style={{ color: '#fff', fontWeight: '600', fontSize: 13 }}>{t?.('config.enable') || 'Ativar'}</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
          </View>
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
      <View style={[styles.container, { backgroundColor: isDark ? '#000' : '#f0f2f5' }]}>
        <SubHeader title={t?.('config.wallpaper') || 'Papel de parede do chat'} />
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          {/* No wallpaper */}
          <Text style={{ fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: 12, textTransform: 'uppercase' }}>
            {t?.('config.wallpaperDefault') || 'Padrão'}
          </Text>
          <View style={{ flexDirection: 'row', gap: 12, marginBottom: 24 }}>
            <TouchableOpacity
              onPress={() => selectWallpaper('none')}
              style={{
                width: 48, height: 48, borderRadius: 24, borderWidth: 3,
                borderColor: currentWp === 'none' ? '#25D366' : colors.border,
                backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center',
              }}
            >
              {currentWp === 'none' && <IconCheck size={20} color="#25D366" />}
            </TouchableOpacity>
            <View style={{ justifyContent: 'center' }}>
              <Text style={{ fontSize: 15, color: colors.text }}>{t?.('config.wallpaperNone') || 'Sem papel de parede'}</Text>
            </View>
          </View>

          {/* Solid colors */}
          <Text style={{ fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: 12, textTransform: 'uppercase' }}>
            {t?.('config.wallpaperSolid') || 'Cores sólidas'}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 24 }}>
            {WALLPAPER_COLORS.map(c => (
              <TouchableOpacity
                key={c}
                onPress={() => selectWallpaper(c)}
                style={{
                  width: 48, height: 48, borderRadius: 24, backgroundColor: c, borderWidth: 3,
                  borderColor: currentWp === c ? '#fff' : 'transparent',
                  alignItems: 'center', justifyContent: 'center',
                  ...(currentWp === c ? { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 4 } : {}),
                }}
              >
                {currentWp === c && <IconCheck size={20} color="#fff" />}
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      </View>
    );
  }

  // ─── Chats/Conversations sub-screen ───
  if (subScreen === 'chats') {
    return (
      <View style={[styles.container, { backgroundColor: isDark ? '#000' : '#f0f2f5' }]}>
        <SubHeader title={t?.('config.chatSettings') || 'Conversas'} />
        <ScrollView>
          <View style={[styles.section, { backgroundColor: colors.background }]}>
            {/* Theme */}
            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.darkMode') || 'Modo escuro'}</Text>
                <Text style={[styles.switchDesc, { color: colors.textSecondary }]}>{t?.('config.darkModeDesc') || 'Alternar tema claro/escuro'}</Text>
              </View>
              <Switch
                value={isDark}
                onValueChange={toggleTheme}
                trackColor={{ false: colors.border, true: '#25D36666' }}
                thumbColor={isDark ? '#25D366' : '#ccc'}
              />
            </View>

            {/* Font size */}
            <View style={[styles.switchRow, { borderTopColor: colors.border }]}>
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
                    style={[styles.btnOption, { borderColor: colors.border }, settings.font_size === f.val && styles.btnOptionActive]}
                    onPress={() => saveSettings({ font_size: f.val })}
                  >
                    <Text style={[styles.btnOptionText, { color: colors.text }, settings.font_size === f.val && styles.btnOptionTextActive]}>
                      {f.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Density */}
            <View style={[styles.switchRow, { borderTopColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.density') || 'Densidade'}</Text>
              </View>
              <View style={styles.btnGroup}>
                {[
                  { val: 'compact', label: t?.('config.compact') || 'Compacto' },
                  { val: 'comfortable', label: t?.('config.comfortable') || 'Confortável' },
                ].map(d => (
                  <TouchableOpacity
                    key={d.val}
                    style={[styles.btnOption, { borderColor: colors.border }, density === d.val && styles.btnOptionActive]}
                    onPress={() => setDensity(d.val)}
                  >
                    <Text style={[styles.btnOptionText, { color: colors.text }, density === d.val && styles.btnOptionTextActive]}>
                      {d.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Wallpaper */}
            <TouchableOpacity style={[styles.linkRow, { borderTopColor: colors.border }]} onPress={() => setSubScreen('wallpaper')}>
              <IconImage size={18} color="#25D366" />
              <Text style={[styles.linkText, { color: colors.text }]}>{t?.('config.wallpaper') || 'Papel de parede do chat'}</Text>
              {settings.wallpaper && settings.wallpaper !== 'none' && (
                <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: settings.wallpaper.startsWith('#') ? settings.wallpaper : '#25D366', marginRight: 4 }} />
              )}
              <IconChevronRight size={16} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>
        </ScrollView>
      </View>
    );
  }

  // ─── Language sub-screen ───
  if (subScreen === 'language') {
    return (
      <View style={[styles.container, { backgroundColor: isDark ? '#000' : '#f0f2f5' }]}>
        <SubHeader title={t?.('config.language') || 'Idioma do app'} />
        <ScrollView>
          <View style={[styles.section, { backgroundColor: colors.background }]}>
            {LANGUAGES.map((l, i) => (
              <TouchableOpacity
                key={l.code}
                style={[styles.langRow, i < LANGUAGES.length - 1 && { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth }]}
                onPress={() => { changeLanguage(l.code); }}
              >
                <Text style={styles.langFlag}>{l.flag}</Text>
                <Text style={[styles.langName, { color: colors.text }]}>{l.label}</Text>
                {language === l.code && <IconCheck size={20} color="#25D366" />}
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      </View>
    );
  }

  // ─── Storage sub-screen ───
  if (subScreen === 'storage') {
    return (
      <View style={[styles.container, { backgroundColor: isDark ? '#000' : '#f0f2f5' }]}>
        <SubHeader title={t?.('config.storage') || 'Armazenamento e dados'} />
        <ScrollView>
          <View style={[styles.section, { backgroundColor: colors.background }]}>
            <View style={styles.storageInfo}>
              <IconSmartphone size={40} color="#25D366" />
              <Text style={[styles.storageTitle, { color: colors.text }]}>{t?.('config.storageUsage') || 'Uso de armazenamento'}</Text>
              <Text style={[styles.storageDesc, { color: colors.textSecondary }]}>
                {t?.('config.storageDesc2') || 'As mensagens e mídia são armazenadas no servidor. O app mantém um cache local mínimo.'}
              </Text>
            </View>

            <TouchableOpacity
              style={[styles.linkRow, { borderTopColor: colors.border }]}
              onPress={async () => {
                if (Platform.OS === 'web') {
                  try { localStorage.clear(); Alert.alert('Chatyy', t?.('config.cacheCleared') || 'Cache limpo!'); } catch {}
                } else {
                  try { await AsyncStorage.clear(); Alert.alert('Chatyy', t?.('config.cacheCleared') || 'Cache limpo!'); } catch {}
                }
              }}
            >
              <IconTrash size={18} color="#E17055" />
              <Text style={[styles.linkText, { color: colors.text }]}>{t?.('config.clearCache') || 'Limpar cache'}</Text>
              <IconChevronRight size={16} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>
        </ScrollView>
      </View>
    );
  }

  // ─── Help sub-screen ───
  if (subScreen === 'help') {
    return (
      <View style={[styles.container, { backgroundColor: isDark ? '#000' : '#f0f2f5' }]}>
        <SubHeader title={t?.('config.help') || 'Ajuda'} />
        <ScrollView>
          <View style={[styles.section, { backgroundColor: colors.background }]}>
            <TouchableOpacity
              style={[styles.helpRow, { borderBottomColor: colors.border }]}
              onPress={() => Linking.openURL('mailto:contato@onemundo.com.br')}
            >
              <IconMail size={20} color="#25D366" />
              <View style={{ flex: 1, marginLeft: 14 }}>
                <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.contactUs') || 'Fale conosco'}</Text>
                <Text style={[styles.switchDesc, { color: colors.textSecondary }]}>contato@onemundo.com.br</Text>
              </View>
              <IconChevronRight size={16} color={colors.textTertiary} />
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.helpRow, { borderBottomColor: colors.border }]}
              onPress={() => Linking.openURL('https://onemundo.com.br')}
            >
              <IconGlobe size={20} color="#25D366" />
              <View style={{ flex: 1, marginLeft: 14 }}>
                <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.website') || 'Site'}</Text>
                <Text style={[styles.switchDesc, { color: colors.textSecondary }]}>onemundo.com.br</Text>
              </View>
              <IconChevronRight size={16} color={colors.textTertiary} />
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.helpRow, { borderBottomColor: colors.border }]}
              onPress={() => Linking.openURL('https://onemundo.com.br/termos')}
            >
              <IconFileText size={20} color="#25D366" />
              <View style={{ flex: 1, marginLeft: 14 }}>
                <Text style={[styles.switchLabel, { color: colors.text }]}>{t?.('config.terms') || 'Termos e privacidade'}</Text>
              </View>
              <IconChevronRight size={16} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>

          <View style={[styles.section, { backgroundColor: colors.background, marginTop: 8 }]}>
            <View style={styles.storageInfo}>
              <Text style={[styles.appNameBig, { color: colors.text }]}>Chatyy</Text>
              <Text style={[styles.storageDesc, { color: colors.textSecondary }]}>by OneMundo Mail</Text>
              <Text style={[styles.storageDesc, { color: colors.textSecondary, marginTop: 4 }]}>v1.4.0</Text>
            </View>
          </View>
        </ScrollView>
      </View>
    );
  }

  // ─── Account sub-screen ───
  if (subScreen === 'account') {
    const handleChangePassword = async () => {
      if (!currentPw || !newPw) return;
      if (newPw !== confirmPw) {
        Alert.alert('Chatyy', t?.('config.passwordMismatch') || 'As senhas não coincidem');
        return;
      }
      if (newPw.length < 6) {
        Alert.alert('Chatyy', t?.('config.passwordTooShort') || 'A senha deve ter pelo menos 6 caracteres');
        return;
      }
      setChangingPw(true);
      try {
        const r = await api.changePassword(currentPw, newPw);
        if (r.success) {
          Alert.alert('Chatyy', t?.('config.passwordChanged') || 'Senha alterada com sucesso!');
          setCurrentPw(''); setNewPw(''); setConfirmPw('');
        } else {
          Alert.alert('Chatyy', r.message || t?.('config.passwordError') || 'Erro ao alterar senha');
        }
      } catch {
        Alert.alert('Chatyy', t?.('config.passwordError') || 'Erro ao alterar senha');
      } finally {
        setChangingPw(false);
      }
    };

    return (
      <View style={[styles.container, { backgroundColor: isDark ? '#000' : '#f0f2f5' }]}>
        <SubHeader title={t?.('config.account') || 'Conta'} />
        <ScrollView>
          {/* Account info */}
          <View style={[styles.section, { backgroundColor: colors.background }]}>
            <View style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
              <Text style={[styles.privacyLabel, { color: colors.textSecondary, paddingHorizontal: 0 }]}>
                {t?.('config.email') || 'E-mail'}
              </Text>
              <Text style={[{ fontSize: 16, color: colors.text, marginTop: 4 }]}>{currentEmail}</Text>
            </View>
            {phone ? (
              <View style={{ paddingHorizontal: 16, paddingBottom: 14 }}>
                <Text style={[styles.privacyLabel, { color: colors.textSecondary, paddingHorizontal: 0 }]}>
                  {t?.('config.phone') || 'Telefone'}
                </Text>
                <Text style={[{ fontSize: 16, color: colors.text, marginTop: 4 }]}>{phone}</Text>
              </View>
            ) : null}
          </View>

          {/* Change password */}
          <View style={[styles.section, { backgroundColor: colors.background }]}>
            <Text style={[styles.privacyLabel, { color: colors.textSecondary }]}>
              {t?.('config.changePassword') || 'Alterar senha'}
            </Text>
            <View style={{ paddingHorizontal: 16, gap: 10, paddingBottom: 16 }}>
              <View style={{ position: 'relative' }}>
                <TextInput
                  style={[styles.pwInput, { color: colors.text, borderColor: colors.border, backgroundColor: isDark ? '#1a1a1a' : '#f8f9fa' }]}
                  placeholder={t?.('config.currentPassword') || 'Senha atual'}
                  placeholderTextColor={colors.textTertiary}
                  secureTextEntry={!showPw}
                  value={currentPw}
                  onChangeText={setCurrentPw}
                  autoCapitalize="none"
                />
              </View>
              <TextInput
                style={[styles.pwInput, { color: colors.text, borderColor: colors.border, backgroundColor: isDark ? '#1a1a1a' : '#f8f9fa' }]}
                placeholder={t?.('config.newPassword') || 'Nova senha'}
                placeholderTextColor={colors.textTertiary}
                secureTextEntry={!showPw}
                value={newPw}
                onChangeText={setNewPw}
                autoCapitalize="none"
              />
              <TextInput
                style={[styles.pwInput, { color: colors.text, borderColor: colors.border, backgroundColor: isDark ? '#1a1a1a' : '#f8f9fa' }]}
                placeholder={t?.('config.confirmPassword') || 'Confirmar nova senha'}
                placeholderTextColor={colors.textTertiary}
                secureTextEntry={!showPw}
                value={confirmPw}
                onChangeText={setConfirmPw}
                autoCapitalize="none"
              />
              <TouchableOpacity onPress={() => setShowPw(!showPw)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 }}>
                {showPw ? <IconEyeOff size={16} color={colors.textSecondary} /> : <IconEye size={16} color={colors.textSecondary} />}
                <Text style={{ color: colors.textSecondary, fontSize: 13 }}>{showPw ? (t?.('config.hidePassword') || 'Ocultar senhas') : (t?.('config.showPassword') || 'Mostrar senhas')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.enableBtn, { backgroundColor: '#25D366', alignSelf: 'flex-start', marginTop: 4, opacity: changingPw ? 0.6 : 1 }]}
                onPress={handleChangePassword}
                disabled={changingPw}
              >
                {changingPw ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={{ color: '#fff', fontWeight: '600', fontSize: 14 }}>{t?.('config.changePasswordBtn') || 'Alterar senha'}</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>

          {/* Delete account */}
          <View style={[styles.section, { backgroundColor: colors.background }]}>
            <TouchableOpacity
              style={styles.logoutRow}
              onPress={() => Alert.alert('Chatyy', t?.('config.deleteAccountInfo') || 'Para excluir sua conta, entre em contato: contato@onemundo.com.br')}
            >
              <IconTrash size={20} color="#dc2626" />
              <Text style={styles.logoutText}>{t?.('config.deleteAccount') || 'Excluir conta'}</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </View>
    );
  }

  // ─── Blocked contacts sub-screen ───
  if (subScreen === 'blocked') {
    const blocked = settings.blocked_contacts || [];

    const handleUnblock = (email) => {
      Alert.alert(
        t?.('config.unblock') || 'Desbloquear',
        (t?.('config.unblockConfirm') || 'Desbloquear {email}?').replace('{email}', email),
        [
          { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
          {
            text: t?.('config.unblock') || 'Desbloquear',
            onPress: () => {
              const newBlocked = blocked.filter(e => e !== email);
              saveSettings({ blocked_contacts: newBlocked });
            },
          },
        ]
      );
    };

    return (
      <View style={[styles.container, { backgroundColor: isDark ? '#000' : '#f0f2f5' }]}>
        <SubHeader title={t?.('config.blocked') || 'Contatos bloqueados'} />
        <ScrollView>
          <View style={[styles.section, { backgroundColor: colors.background }]}>
            {blocked.length === 0 ? (
              <View style={styles.storageInfo}>
                <IconShield size={40} color={colors.textTertiary} />
                <Text style={[styles.storageTitle, { color: colors.text }]}>{t?.('config.noBlocked') || 'Nenhum contato bloqueado'}</Text>
                <Text style={[styles.storageDesc, { color: colors.textSecondary }]}>
                  {t?.('config.noBlockedDesc') || 'Contatos bloqueados não podem enviar mensagens para você no Chatyy'}
                </Text>
              </View>
            ) : (
              blocked.map((email, i) => (
                <View key={email} style={[styles.blockedRow, i < blocked.length - 1 && { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth }]}>
                  <AvatarCircle name={email} email={email} size={40} />
                  <Text style={[styles.blockedEmail, { color: colors.text }]} numberOfLines={1}>{email}</Text>
                  <TouchableOpacity onPress={() => handleUnblock(email)} style={[styles.enableBtn, { backgroundColor: '#dc262620' }]}>
                    <Text style={{ color: '#dc2626', fontWeight: '600', fontSize: 12 }}>{t?.('config.unblock') || 'Desbloquear'}</Text>
                  </TouchableOpacity>
                </View>
              ))
            )}
          </View>
        </ScrollView>
      </View>
    );
  }

  // ─── Main settings screen ───
  return (
    <View style={[styles.container, { backgroundColor: isDark ? '#000' : '#f0f2f5' }]}>
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Profile Card */}
        <TouchableOpacity
          style={[styles.profileCard, { backgroundColor: colors.background }]}
          onPress={() => { setEditing('name'); setEditValue(name); }}
          activeOpacity={0.8}
        >
          <TouchableOpacity style={styles.avatarContainer} onPress={handleAvatarPick} activeOpacity={0.8}>
            {avatarUrl ? (
              <Image source={{ uri: avatarUrl }} style={styles.avatar} />
            ) : (
              <AvatarCircle name={name} email={currentEmail} size={72} />
            )}
            <View style={styles.cameraOverlay}>
              <IconCamera size={16} color="#fff" />
            </View>
          </TouchableOpacity>
          <View style={styles.profileInfo}>
            {editing === 'name' ? (
              <View style={styles.editRow}>
                <TextInput
                  style={[styles.editInput, { color: colors.text, borderColor: '#25D366' }]}
                  value={editValue}
                  onChangeText={setEditValue}
                  autoFocus
                  maxLength={40}
                />
                <TouchableOpacity onPress={() => handleSave('name')} disabled={saving}>
                  {saving ? <ActivityIndicator size="small" color="#25D366" /> : <IconCheck size={20} color="#25D366" />}
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setEditing(null)} style={{ marginLeft: 4 }}>
                  <IconX size={20} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>
            ) : (
              <Text style={[styles.profileName, { color: colors.text }]}>{name}</Text>
            )}
            {editing === 'about' ? (
              <View style={[styles.editRow, { marginTop: 4 }]}>
                <TextInput
                  style={[styles.editInput, { color: colors.text, borderColor: '#25D366', fontSize: 14 }]}
                  value={editValue}
                  onChangeText={setEditValue}
                  autoFocus
                  maxLength={140}
                />
                <TouchableOpacity onPress={() => handleSave('about')} disabled={saving}>
                  {saving ? <ActivityIndicator size="small" color="#25D366" /> : <IconCheck size={20} color="#25D366" />}
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setEditing(null)} style={{ marginLeft: 4 }}>
                  <IconX size={20} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity onPress={() => { setEditing('about'); setEditValue(about); }}>
                <Text style={[styles.profileAbout, { color: colors.textSecondary }]} numberOfLines={1}>{about}</Text>
              </TouchableOpacity>
            )}
          </View>
          <IconChevronRight size={20} color={colors.textTertiary} />
        </TouchableOpacity>

        {/* Account Section */}
        <View style={[styles.section, { backgroundColor: colors.background }]}>
          <SettingItem icon={<IconKey size={20} color="#5E6BE0" />} iconBg="#ECEEF8"
            title={t?.('config.account') || 'Conta'}
            subtitle={t?.('config.accountDesc') || 'Segurança, alterar senha, excluir conta'}
            colors={colors} onPress={() => setSubScreen('account')} />
          <SettingItem icon={<IconLock size={20} color="#25D366" />} iconBg="#E8F5E9"
            title={t?.('config.privacy') || 'Privacidade'}
            subtitle={t?.('config.privacyDesc') || 'Visto por último, foto de perfil, recado'}
            colors={colors} onPress={() => setSubScreen('privacy')} />
          <SettingItem icon={<IconBell size={20} color="#E84393" />} iconBg="#FDE8F0"
            title={t?.('config.notifications') || 'Notificações'}
            subtitle={t?.('config.notificationsDesc') || 'Sons, vibração, notificações de mensagem'}
            colors={colors} onPress={() => setSubScreen('notifications')} />
          <SettingItem icon={<IconImage size={20} color="#E17055" />} iconBg="#FDEAE6"
            title={t?.('config.chatSettings') || 'Conversas'}
            subtitle={t?.('config.chatSettingsDesc') || 'Tema, papel de parede, tamanho da fonte'}
            colors={colors} onPress={() => setSubScreen('chats')} last />
        </View>

        {/* Storage & Language */}
        <View style={[styles.section, { backgroundColor: colors.background }]}>
          <SettingItem icon={<IconSmartphone size={20} color="#00B894" />} iconBg="#E0F5EF"
            title={t?.('config.storage') || 'Armazenamento e dados'}
            subtitle={t?.('config.storageDesc') || 'Uso de rede, download automático'}
            colors={colors} onPress={() => setSubScreen('storage')} />
          <SettingItem icon={<IconTranslate size={20} color="#1A73E8" />} iconBg="#E3F0FD"
            title={t?.('config.language') || 'Idioma do app'}
            subtitle={LANGUAGES.find(l => l.code === language)?.label || 'Português (BR)'}
            colors={colors} onPress={() => setSubScreen('language')} last />
        </View>

        {/* Help & Invite */}
        <View style={[styles.section, { backgroundColor: colors.background }]}>
          <SettingItem icon={<IconInfo size={20} color="#636e72" />} iconBg="#E9ECEF"
            title={t?.('config.help') || 'Ajuda'}
            subtitle={t?.('config.helpDesc') || 'Central de ajuda, contato, termos e privacidade'}
            colors={colors} onPress={() => setSubScreen('help')} />
          <SettingItem icon={<IconHeart size={20} color="#E84393" />} iconBg="#FDE8F0"
            title={t?.('config.invite') || 'Convidar amigos'}
            subtitle={t?.('config.inviteDesc') || 'Compartilhar o Chatyy com seus contatos'}
            colors={colors} onPress={handleInvite} last />
        </View>

        {/* Logout */}
        <View style={[styles.section, { backgroundColor: colors.background }]}>
          <TouchableOpacity style={styles.logoutRow} onPress={handleLogout}>
            <IconLogout size={20} color="#dc2626" />
            <Text style={styles.logoutText}>{t?.('config.logout') || 'Sair da conta'}</Text>
          </TouchableOpacity>
        </View>

        {/* App Info */}
        <View style={styles.appInfo}>
          <Text style={[styles.appName, { color: colors.text }]}>Chatyy</Text>
          <Text style={[styles.appVersion, { color: colors.textSecondary }]}>by OneMundo Mail</Text>
        </View>
        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

function SettingItem({ icon, iconBg, title, subtitle, colors, onPress, last }) {
  return (
    <TouchableOpacity
      style={[styles.settingItem, !last && { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth }]}
      onPress={onPress} activeOpacity={0.7}
    >
      <View style={[styles.settingIconWrap, { backgroundColor: iconBg || 'transparent' }]}>{icon}</View>
      <View style={styles.settingContent}>
        <Text style={[styles.settingTitle, { color: colors.text }]}>{title}</Text>
        {subtitle ? <Text style={[styles.settingSubtitle, { color: colors.textSecondary }]} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      <IconChevronRight size={18} color={colors.textTertiary} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  // Sub-screen header
  subHeader: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  subBackBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  subTitle: { fontSize: 20, fontWeight: '700', flex: 1 },

  // Profile Card
  profileCard: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 16, marginBottom: 8,
  },
  avatarContainer: { position: 'relative' },
  avatar: { width: 72, height: 72, borderRadius: 36 },
  cameraOverlay: {
    position: 'absolute', bottom: 0, right: 0,
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: '#25D366', alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: '#fff',
  },
  profileInfo: { flex: 1, marginLeft: 14 },
  profileName: { fontSize: 20, fontWeight: '700' },
  profileAbout: { fontSize: 14, marginTop: 2 },
  editRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  editInput: { fontSize: 16, fontWeight: '600', borderBottomWidth: 2, paddingVertical: 2, flex: 1 },

  // Section
  section: { marginBottom: 8 },

  // Setting Item
  settingItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16 },
  settingIconWrap: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  settingContent: { flex: 1, marginLeft: 14 },
  settingTitle: { fontSize: 16, fontWeight: '500' },
  settingSubtitle: { fontSize: 13, marginTop: 1 },

  // Privacy
  privacyLabel: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  radioGroup: { paddingHorizontal: 16 },
  radioRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  radioActive: { borderColor: '#25D366' },
  radioDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#25D366' },
  radioLabel: { fontSize: 15 },

  // Switch rows
  switchRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth },
  switchLabel: { fontSize: 15, fontWeight: '500' },
  switchDesc: { fontSize: 12, marginTop: 1 },

  // Link rows
  linkRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, gap: 12, borderTopWidth: StyleSheet.hairlineWidth },
  linkText: { flex: 1, fontSize: 15, fontWeight: '500' },
  linkCount: { fontSize: 14 },

  // Button group
  btnGroup: { flexDirection: 'row', gap: 6 },
  btnOption: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16, borderWidth: 1 },
  btnOptionActive: { backgroundColor: '#25D366', borderColor: '#25D366' },
  btnOptionText: { fontSize: 13, fontWeight: '600' },
  btnOptionTextActive: { color: '#fff' },

  enableBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 16 },

  // Storage
  storageInfo: { alignItems: 'center', paddingVertical: 30, paddingHorizontal: 24 },
  storageTitle: { fontSize: 17, fontWeight: '600', marginTop: 12 },
  storageDesc: { fontSize: 13, textAlign: 'center', marginTop: 6 },

  // Language
  langRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 },
  langFlag: { fontSize: 24, marginRight: 14 },
  langName: { flex: 1, fontSize: 16, fontWeight: '500' },

  // Help
  helpRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },

  // Logout
  logoutRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 16 },
  logoutText: { fontSize: 16, fontWeight: '600', color: '#dc2626' },

  // App Info
  appInfo: { alignItems: 'center', paddingVertical: 24 },
  appName: { fontSize: 18, fontWeight: '700', letterSpacing: 0.5 },
  appNameBig: { fontSize: 24, fontWeight: '800', letterSpacing: 0.5 },
  appVersion: { fontSize: 12, marginTop: 2 },

  // Password input
  pwInput: { fontSize: 15, borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10 },

  // Blocked contacts
  blockedRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 12 },
  blockedEmail: { flex: 1, fontSize: 15 },
});
