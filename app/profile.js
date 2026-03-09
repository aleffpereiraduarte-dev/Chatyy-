import { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, StyleSheet, ScrollView, ActivityIndicator, Platform, Alert, Image,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { Colors } from '../constants/theme';
import {
  IconArrowLeft, IconMail, IconUser, IconPhone, IconCalendar,
  IconLock, IconChevronRight, IconShield, IconClock, IconImage,
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

export default function ProfileScreen() {
  const { user } = useAuth();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showTwoFactor, setShowTwoFactor] = useState(false);
  const [showVacation, setShowVacation] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [showSessions, setShowSessions] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editRecovery, setEditRecovery] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [avatarUrl, setAvatarUrl] = useState(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    try {
      const { getProfile, getAvatarUrl } = await import('../services/api');
      const r = await getProfile();
      if (r.success) {
        setProfile(r.data || {});
        if (r.data?.has_avatar || r.data?.avatar) setAvatarUrl(getAvatarUrl(user?.email));
      }
    } catch {} finally {
      setLoading(false);
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
        setUploadingAvatar(true);
        try {
          const { uploadAvatar, getAvatarUrl } = await import('../services/api');
          const r = await uploadAvatar({ _raw: file, name: file.name, type: file.type });
          if (r.success) setAvatarUrl(getAvatarUrl(user?.email));
        } catch {} finally {
          setUploadingAvatar(false);
        }
      };
      input.click();
    } else {
      // Mobile: use expo-image-picker to open gallery
      try {
        const ImagePicker = await import('expo-image-picker');
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert(t('profile.permissionRequired') || 'Permissao necessaria', t('profile.galleryPermission') || 'Precisamos de acesso a sua galeria para escolher uma foto.');
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
          const { uploadAvatar, getAvatarUrl } = await import('../services/api');
          const r = await uploadAvatar({ uri: asset.uri, name: asset.fileName || 'avatar.jpg', type: asset.mimeType || 'image/jpeg' });
          if (r.success) setAvatarUrl(getAvatarUrl(user?.email));
        } catch {} finally {
          setUploadingAvatar(false);
        }
      } catch {}
    }
  };

  const avatarColor = getAvatarColor(user?.name || user?.email);

  const InfoRow = ({ icon: IconComp, label, value, badge }) => (
    <View style={[s.infoRow, { borderBottomColor: colors.borderLight }]}>
      <View style={s.infoIconWrap}>
        <IconComp size={20} color={colors.textSecondary} />
      </View>
      <View style={s.infoContent}>
        <Text style={[s.infoLabel, { color: colors.textTertiary }]}>{label}</Text>
        <View style={s.infoValueRow}>
          <Text style={[s.infoValue, { color: colors.text }]}>{value || t('profile.notConfigured')}</Text>
          {badge && (
            <View style={[s.badge, { backgroundColor: colors.successBg }]}>
              <Text style={[s.badgeText, { color: colors.success }]}>{badge}</Text>
            </View>
          )}
        </View>
      </View>
    </View>
  );

  if (loading) {
    return (
      <View style={[s.loadingContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={[s.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[s.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <IconArrowLeft size={24} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={[s.headerTitle, { color: colors.text }]}>{t('profile.title')}</Text>
      </View>

      <ScrollView contentContainerStyle={s.scroll}>
        {/* Avatar card */}
        <View style={[s.avatarCard, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <TouchableOpacity onPress={handleAvatarUpload} style={s.avatarWrap} activeOpacity={0.7}>
            {avatarUrl ? (
              <View style={s.avatar}>
                {Platform.OS === 'web' ? (
                  <img src={avatarUrl} style={{ width: 88, height: 88, borderRadius: 44, objectFit: 'cover' }} alt="avatar" />
                ) : (
                  <Image source={{ uri: avatarUrl }} style={{ width: 88, height: 88, borderRadius: 44 }} />
                )}
              </View>
            ) : (
              <View style={[s.avatar, { backgroundColor: avatarColor }]}>
                <Text style={s.avatarText}>{(user?.name || user?.email || '?')[0].toUpperCase()}</Text>
              </View>
            )}
            <View style={[s.avatarBadge, { backgroundColor: colors.primary }]}>
              {uploadingAvatar
                ? <ActivityIndicator size="small" color="#fff" />
                : <IconImage size={14} color="#fff" />
              }
            </View>
          </TouchableOpacity>
          <Text style={[s.userName, { color: colors.text }]}>
            {profile?.first_name
              ? `${profile.first_name} ${profile.last_name || ''}`
              : user?.name || t('profile.user')}
          </Text>
          <Text style={[s.userEmail, { color: colors.textSecondary }]}>{user?.email}</Text>
        </View>

        {/* Info section */}
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <View style={s.sectionHeader}>
            <Text style={[s.sectionTitle, { color: colors.text }]}>{t('profile.accountInfo')}</Text>
            {!editing ? (
              <TouchableOpacity onPress={() => {
                setEditName(profile?.display_name || profile?.name || user?.name || '');
                setEditPhone(profile?.phone || '');
                setEditRecovery(profile?.recovery_email || '');
                setEditing(true);
                setSaveMsg('');
              }}>
                <Text style={[s.editBtn, { color: colors.primary }]}>{t('profile.edit')}</Text>
              </TouchableOpacity>
            ) : (
              <View style={s.editActions}>
                <TouchableOpacity onPress={() => { setEditing(false); setSaveMsg(''); }}>
                  <Text style={[s.editBtn, { color: colors.textSecondary }]}>{t('common.cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={async () => {
                  setSaving(true);
                  try {
                    const { updateProfile } = await import('../services/api');
                    const r = await updateProfile({ display_name: editName, phone: editPhone, recovery_email: editRecovery });
                    if (r.success) {
                      setSaveMsg(t('profile.saved'));
                      setEditing(false);
                      loadProfile();
                    } else {
                      setSaveMsg(r.message || t('profile.errorSave'));
                    }
                  } catch { setSaveMsg(t('profile.connectionError')); }
                  finally { setSaving(false); }
                }} disabled={saving}>
                  <Text style={[s.editBtn, { color: colors.primary, fontWeight: '700' }]}>
                    {saving ? t('profile.saving') : t('profile.save')}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
          {!!saveMsg && <Text style={[s.saveMsg, { color: saveMsg === t('profile.saved') ? colors.success : colors.error }]}>{saveMsg}</Text>}
          <InfoRow icon={IconMail} label={t('profile.email')} value={user?.email} />
          {editing ? (
            <>
              <View style={[s.editRow, { borderBottomColor: colors.borderLight }]}>
                <View style={s.infoIconWrap}><IconUser size={20} color={colors.textSecondary} /></View>
                <View style={s.infoContent}>
                  <Text style={[s.infoLabel, { color: colors.textTertiary }]}>{t('profile.name')}</Text>
                  <TextInput style={[s.editInput, { color: colors.text, borderColor: colors.borderLight }]} value={editName} onChangeText={setEditName} placeholder={t('profile.namePlaceholder')} placeholderTextColor={colors.textTertiary} />
                </View>
              </View>
              <View style={[s.editRow, { borderBottomColor: colors.borderLight }]}>
                <View style={s.infoIconWrap}><IconPhone size={20} color={colors.textSecondary} /></View>
                <View style={s.infoContent}>
                  <Text style={[s.infoLabel, { color: colors.textTertiary }]}>{t('profile.phone')}</Text>
                  <TextInput style={[s.editInput, { color: colors.text, borderColor: colors.borderLight }]} value={editPhone} onChangeText={setEditPhone} placeholder="(11) 99999-9999" placeholderTextColor={colors.textTertiary} keyboardType="phone-pad" />
                </View>
              </View>
              <View style={[s.editRow, { borderBottomColor: colors.borderLight }]}>
                <View style={s.infoIconWrap}><IconMail size={20} color={colors.textSecondary} /></View>
                <View style={s.infoContent}>
                  <Text style={[s.infoLabel, { color: colors.textTertiary }]}>{t('profile.recoveryEmail')}</Text>
                  <TextInput style={[s.editInput, { color: colors.text, borderColor: colors.borderLight }]} value={editRecovery} onChangeText={setEditRecovery} placeholder="email@gmail.com" placeholderTextColor={colors.textTertiary} keyboardType="email-address" autoCapitalize="none" />
                </View>
              </View>
            </>
          ) : (
            <>
              <InfoRow icon={IconUser} label={t('profile.name')} value={profile?.display_name || profile?.name || user?.name} />
              <InfoRow icon={IconPhone} label={t('profile.phone')} value={profile?.phone || t('profile.notConfigured')} badge={profile?.phone_verified ? t('profile.verified') : null} />
              <InfoRow icon={IconMail} label={t('profile.recoveryEmail')} value={profile?.recovery_email} />
            </>
          )}
          <InfoRow icon={IconCalendar} label={t('profile.birthday')} value={profile?.birthday} />
          <InfoRow icon={IconCalendar} label={t('profile.createdAt')} value={profile?.created_at || t('profile.notAvailable')} />
        </View>

        {/* Security section */}
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>{t('profile.security')}</Text>
          <TouchableOpacity style={[s.actionRow, { borderBottomColor: colors.borderLight }]} onPress={() => setShowChangePassword(true)}>
            <View style={s.actionIconWrap}><IconLock size={20} color={colors.textSecondary} /></View>
            <Text style={[s.actionText, { color: colors.text }]}>{t('profile.changePassword')}</Text>
            <IconChevronRight size={20} color={colors.textTertiary} />
          </TouchableOpacity>
          <TouchableOpacity style={[s.actionRow, { borderBottomColor: colors.borderLight }]} onPress={() => setShowTwoFactor(true)}>
            <View style={s.actionIconWrap}><IconShield size={20} color={colors.textSecondary} /></View>
            <Text style={[s.actionText, { color: colors.text }]}>{t('profile.twoFactor')}</Text>
            <IconChevronRight size={20} color={colors.textTertiary} />
          </TouchableOpacity>
          <TouchableOpacity style={[s.actionRow, { borderBottomColor: colors.borderLight }]} onPress={() => Alert.alert(t('profile.verifyPhoneTitle'), t('profile.verifyPhoneMessage'))}>
            <View style={s.actionIconWrap}><IconPhone size={20} color={colors.textSecondary} /></View>
            <Text style={[s.actionText, { color: colors.text }]}>{t('profile.verifyPhone')}</Text>
            <IconChevronRight size={20} color={colors.textTertiary} />
          </TouchableOpacity>
          <TouchableOpacity style={[s.actionRow, { borderBottomColor: colors.borderLight }]} onPress={async () => {
            const { getSessionsList } = await import('../services/api');
            const r = await getSessionsList();
            if (r.success) setSessions(r.data || []);
            setShowSessions(!showSessions);
          }}>
            <View style={s.actionIconWrap}><IconClock size={20} color={colors.textSecondary} /></View>
            <Text style={[s.actionText, { color: colors.text }]}>{t('profile.activeSessions')}</Text>
            <IconChevronRight size={20} color={colors.textTertiary} />
          </TouchableOpacity>
          {showSessions && sessions.length > 0 && (
            <View style={s.sessionsList}>
              {sessions.map((sess, i) => (
                <View key={i} style={[s.sessionRow, { borderBottomColor: colors.borderLight }]}>
                  <Text style={[s.sessionAgent, { color: colors.text }]} numberOfLines={1}>
                    {sess.user_agent || t('profile.unknownSession')}
                  </Text>
                  <Text style={[s.sessionMeta, { color: colors.textTertiary }]}>
                    IP: {sess.ip || '?'} - {sess.last_active || sess.created_at || ''}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* Vacation responder */}
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>{t('profile.autoReply')}</Text>
          <TouchableOpacity style={[s.actionRow, { borderBottomColor: colors.borderLight }]} onPress={() => setShowVacation(true)}>
            <View style={s.actionIconWrap}><IconClock size={20} color={colors.textSecondary} /></View>
            <Text style={[s.actionText, { color: colors.text }]}>{t('profile.vacationResponse')}</Text>
            <IconChevronRight size={20} color={colors.textTertiary} />
          </TouchableOpacity>
        </View>
      </ScrollView>

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
    borderBottomWidth: 1,
  },
  backBtn: { padding: Spacing.sm, marginRight: Spacing.sm },
  headerTitle: { fontSize: FontSize.xxl, fontWeight: '600' },
  // Scroll
  scroll: { padding: Spacing.lg },
  // Avatar card
  avatarCard: {
    alignItems: 'center', padding: Spacing.xxxl, borderRadius: BorderRadius.xl, marginBottom: Spacing.lg,
  },
  avatar: {
    width: 88, height: 88, borderRadius: 44,
    justifyContent: 'center', alignItems: 'center', overflow: 'hidden',
  },
  avatarText: { color: '#fff', fontSize: 36, fontWeight: '600' },
  avatarWrap: { position: 'relative', marginBottom: Spacing.lg },
  avatarBadge: {
    position: 'absolute', bottom: 0, right: 0,
    width: 28, height: 28, borderRadius: 14,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2, borderColor: '#fff',
  },
  userName: { fontSize: FontSize.title, fontWeight: '600' },
  userEmail: { fontSize: FontSize.lg, marginTop: Spacing.xs },
  // Section
  section: {
    borderRadius: BorderRadius.xl, padding: Spacing.xl, marginBottom: Spacing.lg,
  },
  sectionTitle: { fontSize: FontSize.xl, fontWeight: '600' },
  // Info row
  infoRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: Spacing.md, borderBottomWidth: 1,
  },
  infoIconWrap: { marginRight: Spacing.md, width: 28, alignItems: 'center' },
  infoContent: { flex: 1 },
  infoLabel: { fontSize: FontSize.sm },
  infoValueRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  infoValue: { fontSize: FontSize.lg },
  badge: {
    marginLeft: Spacing.sm, paddingHorizontal: Spacing.sm, paddingVertical: 2,
    borderRadius: BorderRadius.sm,
  },
  badgeText: { fontSize: FontSize.xs, fontWeight: '600' },
  // Action row
  actionRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: Spacing.md, borderBottomWidth: 1,
  },
  actionIconWrap: { marginRight: Spacing.md, width: 28, alignItems: 'center' },
  actionText: { flex: 1, fontSize: FontSize.lg },
  // Edit mode
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.lg },
  editBtn: { fontSize: FontSize.base, fontWeight: '600' },
  editActions: { flexDirection: 'row', gap: Spacing.lg },
  editRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.sm, borderBottomWidth: 1 },
  editInput: {
    fontSize: FontSize.lg, borderWidth: 1, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.sm, paddingVertical: Platform.OS === 'web' ? 8 : 6,
    marginTop: 4,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  saveMsg: { fontSize: FontSize.sm, fontWeight: '600', marginBottom: Spacing.sm },
  // Sessions
  sessionsList: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm },
  sessionRow: { paddingVertical: Spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  sessionAgent: { fontSize: FontSize.sm, fontWeight: '500' },
  sessionMeta: { fontSize: FontSize.xs, marginTop: 2 },
});
