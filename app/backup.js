import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, ScrollView,
  ActivityIndicator, Platform, Alert, useWindowDimensions,
} from 'react-native';
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

  if (loading) {
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
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </View>
    );
  }

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
