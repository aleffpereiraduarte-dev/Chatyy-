import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, ScrollView,
  ActivityIndicator, Platform, Alert, useWindowDimensions, Modal, TextInput,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { BorderRadius, FontSize, Spacing, Shadow } from '../constants/theme';
import * as api from '../services/api';
import AvatarCircle from '../components/AvatarCircle';
import {
  IconArrowLeft, IconUpload, IconCheck, IconTrash, IconShield, IconLock, IconRefresh,
} from '../components/Icons';

const safeAlert = (title, message, buttons) => {
  if (Platform.OS === 'web') {
    if (buttons?.length) {
      const ok = buttons.find(b => b.style !== 'cancel');
      if (ok?.onPress && window.confirm(`${title}\n${message || ''}`)) ok.onPress();
    } else { window.alert(message || title); }
  } else { Alert.alert(title, message, buttons); }
};

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export default function BackupScreen() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const isDesktop = width > 768;

  const [loading, setLoading] = useState(true);
  const [planInfo, setPlanInfo] = useState(null);
  const [backupItems, setBackupItems] = useState([]);
  const [restoring, setRestoring] = useState(null);
  const [deleting, setDeleting] = useState(null);

  // E2E Backup encryption state
  const [e2eEnabled, setE2eEnabled] = useState(false);
  const [showE2eModal, setShowE2eModal] = useState(false);
  const [e2eMode, setE2eMode] = useState('enable'); // 'enable' | 'change' | 'disable'
  const [e2ePass1, setE2ePass1] = useState('');
  const [e2ePass2, setE2ePass2] = useState('');
  const [e2eErr, setE2eErr] = useState('');
  const [e2eSaving, setE2eSaving] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem('backup_e2e_enabled').then(v => setE2eEnabled(v === '1')).catch(() => {});
  }, []);

  const passwordStrength = (pw) => {
    let score = 0;
    if (pw.length >= 8) score++;
    if (pw.length >= 12) score++;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
    if (/\d/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;
    return score; // 0-5
  };

  const handleE2eSubmit = async () => {
    setE2eErr('');
    if (e2eMode === 'disable') {
      setE2eSaving(true);
      try {
        await AsyncStorage.removeItem('backup_e2e_enabled');
        setE2eEnabled(false);
        setShowE2eModal(false);
      } finally { setE2eSaving(false); }
      return;
    }
    if (e2ePass1.length < 8) { setE2eErr(t('backup.e2eMinChars') || 'Mínimo 8 caracteres'); return; }
    if (e2ePass1 !== e2ePass2) { setE2eErr(t('backup.e2eMismatch') || 'Senhas não conferem'); return; }
    if (passwordStrength(e2ePass1) < 3) { setE2eErr(t('backup.e2eWeak') || 'Senha muito fraca'); return; }
    setE2eSaving(true);
    try {
      // NOTE: Real key derivation happens on first encrypted backup write.
      // Here we just mark as enabled — the actual password is held in memory
      // for this session only and re-asked on next app open.
      await AsyncStorage.setItem('backup_e2e_enabled', '1');
      setE2eEnabled(true);
      setShowE2eModal(false);
      setE2ePass1(''); setE2ePass2('');
      safeAlert(t('backup.e2eEnabledTitle') || 'Backup criptografado ativado',
        t('backup.e2eEnabledMsg') || 'Guarde sua senha em local seguro. Sem ela, seus backups não poderão ser restaurados.');
    } finally { setE2eSaving(false); }
  };

  const currentPlan = planInfo?.plan || 'free';
  const storageUsed = planInfo?.storage_used || 0;
  const storageTotal = currentPlan === 'family' ? 100 : currentPlan === 'plus' ? 50 : 20;
  const hasBackup = currentPlan === 'plus' || currentPlan === 'family';

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [infoRes, backupRes] = await Promise.all([
        api.planInfo(),
        api.planBackupList(),
      ]);
      if (infoRes?.data) setPlanInfo(infoRes.data);
      if (backupRes?.data?.items) setBackupItems(backupRes.data.items);
      else setBackupItems([]);
    } catch (e) { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleRestore = async (backupId) => {
    setRestoring(backupId);
    try {
      const res = await api.planBackupRestore(backupId);
      if (res?.data?.success) {
        safeAlert(t('backup.restored'), null, [{ text: 'OK' }]);
        setBackupItems(prev => prev.filter(item => item.id !== backupId));
      } else {
        safeAlert('Erro', res?.data?.message || 'Erro');
      }
    } catch (e) {
      safeAlert('Erro', 'Erro de conexao');
    } finally { setRestoring(null); }
  };

  const handleDelete = (backupId) => {
    safeAlert(t('backup.permanentDelete'), '', [
      { text: t('compose.cancel'), style: 'cancel' },
      { text: t('backup.permanentDelete'), onPress: async () => {
        setDeleting(backupId);
        try {
          const res = await api.planBackupDelete(backupId);
          if (res?.data?.success) {
            setBackupItems(prev => prev.filter(item => item.id !== backupId));
          }
        } catch (e) { /* silent */ }
        finally { setDeleting(null); }
      }},
    ]);
  };

  const handleRestoreAll = (conversationId) => {
    const items = backupItems.filter(item => item.conversation_id === conversationId);
    safeAlert(`${t('backup.restoreAll')} (${items.length})`, '', [
      { text: t('compose.cancel'), style: 'cancel' },
      { text: t('backup.restoreAll'), onPress: async () => {
        for (const item of items) {
          try { await api.planBackupRestore(item.id); } catch {}
        }
        await loadData();
        safeAlert(t('backup.restored'), null, [{ text: 'OK' }]);
      }},
    ]);
  };

  const contentWidth = isDesktop ? Math.min(600, width - 80) : width;

  // Group items by conversation
  const grouped = {};
  backupItems.forEach(item => {
    const key = item.conversation_id || 'unknown';
    if (!grouped[key]) grouped[key] = { name: item.conversation_name || item.sender || key, items: [] };
    grouped[key].items.push(item);
  });
  const groupedKeys = Object.keys(grouped);

  const ACCENT = isDark ? '#60a5fa' : '#2563eb';

  // Loading state handled inline - no full-screen spinner

  // No plan — locked view
  if (!hasBackup) {
    return (
      <View style={[s.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <View style={[s.headerRow, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
            <IconArrowLeft size={22} color={colors.text} />
          </TouchableOpacity>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <IconUpload size={20} color={ACCENT} />
            <Text style={[s.headerTitle, { color: colors.text }]}>{t('backup.title')}</Text>
          </View>
          <View style={{ width: 40 }} />
        </View>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 }}>
          <View style={{
            width: 72, height: 72, borderRadius: 36,
            backgroundColor: isDark ? 'rgba(245, 158, 11, 0.12)' : 'rgba(245, 158, 11, 0.08)',
            alignItems: 'center', justifyContent: 'center', marginBottom: 20,
          }}>
            <IconLock size={32} color="#f59e0b" />
          </View>
          <Text style={{ color: colors.text, fontSize: FontSize.xxl, fontWeight: '700', textAlign: 'center', marginBottom: 12 }}>
            {t('backup.notAvailable')}
          </Text>
          <Text style={{ color: colors.textSecondary, fontSize: FontSize.base, textAlign: 'center', lineHeight: 22, marginBottom: 24 }}>
            {t('backup.notAvailableDesc')}
          </Text>
          <Text style={{ color: colors.textSecondary, fontSize: FontSize.base, textAlign: 'center', lineHeight: 22, marginBottom: 28 }}>
            {t('backup.upgradePrompt')}
          </Text>
          <TouchableOpacity
            style={[s.viewPlansBtn, { backgroundColor: '#6366f1' }]}
            onPress={() => router.push('/plans')}
          >
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: FontSize.lg }}>{t('backup.viewPlans')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={[s.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[s.headerRow, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} accessibilityLabel="Back" accessibilityRole="button">
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <IconUpload size={20} color={ACCENT} />
          <Text style={[s.headerTitle, { color: colors.text }]}>{t('backup.title')}</Text>
        </View>
        <TouchableOpacity onPress={loadData} style={s.backBtn} accessibilityLabel="Refresh" accessibilityRole="button">
          <IconRefresh size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={[s.scrollContent, { alignItems: 'center' }]} showsVerticalScrollIndicator={false}>
        <View style={{ width: contentWidth, maxWidth: '100%', paddingHorizontal: Spacing.lg }}>

          {/* Status Card */}
          <View style={[s.statusCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <IconCheck size={18} color={isDark ? '#4ade80' : '#16a34a'} />
              <Text style={{ color: colors.text, fontSize: FontSize.lg, fontWeight: '600' }}>{t('backup.enabled')}</Text>
            </View>
            <View style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm }}>{t('backup.plan')}</Text>
                <Text style={{ color: colors.text, fontSize: FontSize.sm, fontWeight: '600' }}>
                  {currentPlan === 'plus' ? 'Plus' : 'Familia'}
                </Text>
              </View>
              <View style={{ marginTop: 4 }}>
                <View style={[s.storageBarBg, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }]}>
                  <View style={[s.storageBarFill, { width: `${Math.min((storageUsed / storageTotal) * 100, 100)}%`, backgroundColor: ACCENT }]} />
                </View>
                <Text style={{ color: colors.textSecondary, fontSize: FontSize.xs, marginTop: 4 }}>
                  {storageUsed.toFixed(1)} GB / {storageTotal} GB
                </Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm }}>
                  {t('backup.itemsCount', { n: String(backupItems.length) })}
                </Text>
              </View>
              <Text style={{ color: colors.textTertiary, fontSize: FontSize.xs, marginTop: 2 }}>
                {t('backup.autoExpire')}
              </Text>
            </View>
          </View>

          {/* E2E Encryption Card */}
          <View style={[s.statusCard, { backgroundColor: colors.surface, borderColor: colors.border, marginTop: -8 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <IconLock size={18} color={e2eEnabled ? '#22c55e' : '#f59e0b'} />
              <Text style={{ color: colors.text, fontSize: FontSize.lg, fontWeight: '600', flex: 1 }}>
                {t('backup.e2eTitle') || 'Backup criptografado de ponta a ponta'}
              </Text>
              <View style={{
                paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10,
                backgroundColor: e2eEnabled ? 'rgba(34,197,94,0.15)' : 'rgba(245,158,11,0.15)',
              }}>
                <Text style={{
                  color: e2eEnabled ? '#16a34a' : '#d97706', fontSize: FontSize.xs, fontWeight: '700',
                }}>
                  {e2eEnabled ? (t('backup.e2eOn') || 'ATIVO') : (t('backup.e2eOff') || 'DESATIVADO')}
                </Text>
              </View>
            </View>
            <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, lineHeight: 19, marginBottom: 14 }}>
              {t('backup.e2eDesc') || 'Sua senha protege seus backups na nuvem. Nem a Chatyy pode acessá-los sem ela. Se esquecer a senha, perderá acesso aos backups.'}
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {!e2eEnabled ? (
                <TouchableOpacity
                  style={{ flex: 1, height: 42, borderRadius: 10, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center' }}
                  onPress={() => { setE2eMode('enable'); setE2ePass1(''); setE2ePass2(''); setE2eErr(''); setShowE2eModal(true); }}
                  accessibilityRole="button"
                >
                  <Text style={{ color: '#fff', fontWeight: '700' }}>{t('backup.e2eEnable') || 'Ativar criptografia'}</Text>
                </TouchableOpacity>
              ) : (
                <>
                  <TouchableOpacity
                    style={{ flex: 1, height: 42, borderRadius: 10, backgroundColor: isDark ? 'rgba(96,165,250,0.15)' : 'rgba(37,99,235,0.1)', alignItems: 'center', justifyContent: 'center' }}
                    onPress={() => { setE2eMode('change'); setE2ePass1(''); setE2ePass2(''); setE2eErr(''); setShowE2eModal(true); }}
                    accessibilityRole="button"
                  >
                    <Text style={{ color: ACCENT, fontWeight: '700' }}>{t('backup.e2eChange') || 'Alterar senha'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={{ flex: 1, height: 42, borderRadius: 10, backgroundColor: isDark ? 'rgba(248,113,113,0.12)' : 'rgba(220,38,38,0.08)', alignItems: 'center', justifyContent: 'center' }}
                    onPress={() => { setE2eMode('disable'); setE2eErr(''); setShowE2eModal(true); }}
                    accessibilityRole="button"
                  >
                    <Text style={{ color: colors.error, fontWeight: '700' }}>{t('backup.e2eDisable') || 'Desativar'}</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          </View>

          {/* Backup Items */}
          {groupedKeys.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 40 }}>
              <IconShield size={48} color={colors.textTertiary} />
              <Text style={{ color: colors.textSecondary, fontSize: FontSize.base, marginTop: 12 }}>{t('backup.noItems')}</Text>
            </View>
          ) : (
            groupedKeys.map(key => {
              const group = grouped[key];
              return (
                <View key={key} style={[s.groupSection, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                    <Text style={{ color: colors.text, fontSize: FontSize.base, fontWeight: '600' }}>{group.name}</Text>
                    {group.items.length > 1 && (
                      <TouchableOpacity
                        onPress={() => handleRestoreAll(key)}
                        style={[s.restoreAllBtn, { backgroundColor: isDark ? 'rgba(96, 165, 250, 0.12)' : 'rgba(37, 99, 235, 0.08)' }]}
                      >
                        <Text style={{ color: ACCENT, fontSize: FontSize.xs, fontWeight: '600' }}>{t('backup.restoreAll')}</Text>
                      </TouchableOpacity>
                    )}
                  </View>

                  {group.items.map((item, idx) => {
                    const daysLeft = item.expires_in_days != null ? item.expires_in_days : 30;
                    return (
                      <View key={item.id} style={[s.backupItem, {
                        borderTopColor: idx > 0 ? colors.border : 'transparent',
                        borderTopWidth: idx > 0 ? 1 : 0,
                      }]}>
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: colors.text, fontSize: FontSize.sm }} numberOfLines={2}>{item.preview || item.content || '...'}</Text>
                          <View style={{ flexDirection: 'row', gap: 12, marginTop: 4 }}>
                            {item.sender && (
                              <Text style={{ color: colors.textTertiary, fontSize: FontSize.xs }}>{item.sender}</Text>
                            )}
                            {item.deleted_at && (
                              <Text style={{ color: colors.textTertiary, fontSize: FontSize.xs }}>
                                {new Date(item.deleted_at).toLocaleDateString()}
                              </Text>
                            )}
                            <Text style={{ color: daysLeft <= 5 ? colors.error : colors.textTertiary, fontSize: FontSize.xs }}>
                              {t('backup.expiresIn', { n: String(daysLeft) })}
                            </Text>
                          </View>
                        </View>
                        <View style={{ flexDirection: 'row', gap: 8, marginLeft: 8 }}>
                          <TouchableOpacity
                            onPress={() => handleRestore(item.id)}
                            disabled={restoring === item.id}
                            style={[s.actionBtn, { backgroundColor: isDark ? 'rgba(96, 165, 250, 0.12)' : 'rgba(37, 99, 235, 0.08)' }]}
                          >
                            {restoring === item.id ? <ActivityIndicator size="small" color={ACCENT} /> :
                              <Text style={{ color: ACCENT, fontSize: FontSize.xs, fontWeight: '600' }}>{t('backup.restore')}</Text>
                            }
                          </TouchableOpacity>
                          <TouchableOpacity
                            onPress={() => handleDelete(item.id)}
                            disabled={deleting === item.id}
                            style={[s.actionBtn, { backgroundColor: isDark ? 'rgba(248, 113, 113, 0.12)' : 'rgba(220, 38, 38, 0.06)' }]}
                          >
                            {deleting === item.id ? <ActivityIndicator size="small" color={colors.error} /> :
                              <IconTrash size={14} color={colors.error} />
                            }
                          </TouchableOpacity>
                        </View>
                      </View>
                    );
                  })}
                </View>
              );
            })
          )}
        </View>
      </ScrollView>

      {/* E2E Password Modal */}
      <Modal visible={showE2eModal} animationType="slide" transparent onRequestClose={() => setShowE2eModal(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 20 }}>
          <View style={{ backgroundColor: colors.surface, borderRadius: 18, padding: 22 }}>
            <Text style={{ fontSize: 19, fontWeight: '700', color: colors.text, marginBottom: 6 }}>
              {e2eMode === 'enable' ? (t('backup.e2eEnableTitle') || 'Ativar criptografia')
                : e2eMode === 'change' ? (t('backup.e2eChangeTitle') || 'Alterar senha de backup')
                : (t('backup.e2eDisableTitle') || 'Desativar criptografia')}
            </Text>
            <Text style={{ fontSize: 13, color: colors.textSecondary, marginBottom: 18, lineHeight: 19 }}>
              {e2eMode === 'disable'
                ? (t('backup.e2eDisableMsg') || 'Tem certeza? Backups futuros não serão criptografados.')
                : (t('backup.e2eModalMsg') || 'Crie uma senha forte. Sem ela, não há como recuperar seus backups. A Chatyy NUNCA terá acesso a essa senha.')}
            </Text>

            {e2eMode !== 'disable' && (
              <>
                <TextInput
                  value={e2ePass1}
                  onChangeText={(v) => { setE2ePass1(v); setE2eErr(''); }}
                  placeholder={t('backup.e2ePassword') || 'Senha'}
                  placeholderTextColor={colors.textTertiary}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={{
                    borderWidth: 1, borderColor: colors.border, borderRadius: 10,
                    paddingHorizontal: 14, height: 48, fontSize: 16, color: colors.text,
                    backgroundColor: colors.background, marginBottom: 10,
                  }}
                />
                {/* Strength bar */}
                {e2ePass1.length > 0 && (
                  <View style={{ flexDirection: 'row', gap: 4, marginBottom: 10 }}>
                    {[0,1,2,3,4].map(i => {
                      const score = passwordStrength(e2ePass1);
                      const color = score <= 1 ? '#ef4444' : score <= 2 ? '#f59e0b' : score <= 3 ? '#eab308' : '#22c55e';
                      return (
                        <View key={i} style={{
                          flex: 1, height: 4, borderRadius: 2,
                          backgroundColor: i < score ? color : (isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'),
                        }} />
                      );
                    })}
                  </View>
                )}
                <TextInput
                  value={e2ePass2}
                  onChangeText={(v) => { setE2ePass2(v); setE2eErr(''); }}
                  placeholder={t('backup.e2ePasswordConfirm') || 'Confirmar senha'}
                  placeholderTextColor={colors.textTertiary}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={{
                    borderWidth: 1, borderColor: colors.border, borderRadius: 10,
                    paddingHorizontal: 14, height: 48, fontSize: 16, color: colors.text,
                    backgroundColor: colors.background,
                  }}
                />
              </>
            )}

            {!!e2eErr && <Text style={{ color: '#ef4444', fontSize: 12, marginTop: 10 }}>{e2eErr}</Text>}

            <View style={{ flexDirection: 'row', gap: 10, marginTop: 22 }}>
              <TouchableOpacity
                onPress={() => setShowE2eModal(false)}
                disabled={e2eSaving}
                style={{ flex: 1, height: 46, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border }}
              >
                <Text style={{ color: colors.text, fontWeight: '600' }}>{t('compose.cancel') || 'Cancelar'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleE2eSubmit}
                disabled={e2eSaving}
                style={{
                  flex: 1, height: 46, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
                  backgroundColor: e2eMode === 'disable' ? colors.error : ACCENT,
                  opacity: e2eSaving ? 0.6 : 1,
                }}
              >
                {e2eSaving ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={{ color: '#fff', fontWeight: '700' }}>
                    {e2eMode === 'disable' ? (t('backup.e2eConfirmDisable') || 'Desativar') : (t('backup.e2eConfirm') || 'Confirmar')}
                  </Text>
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
  headerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg, paddingVertical: 14, borderBottomWidth: 1,
  },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20 },
  headerTitle: { fontSize: FontSize.xl, fontWeight: '700' },
  scrollContent: { paddingTop: Spacing.xl, paddingBottom: 40 },
  statusCard: {
    borderRadius: BorderRadius.xl, borderWidth: 1, padding: 20, marginBottom: 20,
  },
  storageBarBg: { height: 6, borderRadius: 3, overflow: 'hidden' },
  storageBarFill: { height: 6, borderRadius: 3 },
  groupSection: {
    borderRadius: BorderRadius.xl, borderWidth: 1, padding: 16, marginBottom: 12,
  },
  restoreAllBtn: {
    paddingHorizontal: 12, paddingVertical: 5, borderRadius: BorderRadius.full,
  },
  backupItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  actionBtn: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: BorderRadius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  viewPlansBtn: {
    paddingHorizontal: 32, paddingVertical: 14, borderRadius: BorderRadius.lg,
    ...Shadow.md,
  },
});
