import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing } from '../constants/theme';
import { IconArrowLeft, IconLock, IconUpload, IconRefresh } from '../components/Icons';
import {
  backupNow,
  listBackups,
  restoreFromBackup,
  scheduleAutomaticBackup,
} from 'expo-chat-backup';

const AUTO_KEY = '@chatyy_backup_auto';

/**
 * Stage 8 UI — Chat backup screen.
 *
 * - "Backup now" encrypts chatyy.db locally with the password the user
 *   types here and uploads to iCloud Drive (iOS) / Google Drive (Android).
 * - "Restore" picks a backup from the list and decrypts in-place.
 *
 * Password is NEVER sent to Chatyy servers. The native module derives
 * the AES key via PBKDF2 (600k iters) on-device.
 */
export default function ChatBackupScreen() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [password, setPassword] = useState('');
  const [working, setWorking] = useState(false);
  const [busyAction, setBusyAction] = useState(null); // 'backup' | 'restore' | 'list'
  const [backups, setBackups] = useState([]);
  const [autoSchedule, setAutoSchedule] = useState(false);

  const fmtBytes = (n) => {
    if (!n && n !== 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const fmtDate = (iso) => {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  const refreshList = useCallback(async () => {
    setBusyAction('list');
    try {
      const list = await listBackups();
      setBackups(Array.isArray(list) ? list : []);
    } catch (e) {
      const msg = String(e?.message || e);
      // Surface Google Sign-In requirement clearly on Android.
      if (msg.includes('ERR_GOOGLE_SIGNIN') || msg.toLowerCase().includes('sign in with google')) {
        Alert.alert(
          t('backup.googleSignInTitle') || 'Sign in to Google',
          t('backup.googleSignInMsg') ||
            'Backups live in your Google Drive. Sign in with Google to continue.'
        );
      } else {
        Alert.alert(t('backup.listFailed') || 'Could not list backups', msg);
      }
    } finally {
      setBusyAction(null);
    }
  }, [t]);

  useEffect(() => { refreshList(); }, [refreshList]);

  // Load persisted auto-schedule preference on mount.
  useEffect(() => {
    (async () => {
      try {
        const v = await AsyncStorage.getItem(AUTO_KEY);
        if (v === '1') setAutoSchedule(true);
      } catch {}
    })();
  }, []);

  // Toggle daily automatic backup. ON  → scheduleAutomaticBackup(1).
  // OFF → scheduleAutomaticBackup(0) tells the native module to cancel
  // the scheduled task. Persist the user's choice so it survives reload.
  const handleToggleAutoSchedule = useCallback(async () => {
    const next = !autoSchedule;
    setAutoSchedule(next);
    try { await AsyncStorage.setItem(AUTO_KEY, next ? '1' : '0'); } catch {}
    try {
      await scheduleAutomaticBackup(next ? 1 : 0);
    } catch (e) {
      // Surface but don't roll back the toggle — user can retry.
      Alert.alert(
        t('backup.autoFailedTitle') || 'Auto backup',
        String(e?.message || e)
      );
    }
  }, [autoSchedule, t]);

  const handleBackup = async () => {
    if (password.length < 8) {
      Alert.alert(
        t('backup.weakPassTitle') || 'Password too short',
        t('backup.weakPassMsg') || 'Use at least 8 characters. Remember it — without it your backup cannot be restored.'
      );
      return;
    }
    setWorking(true);
    setBusyAction('backup');
    try {
      const result = await backupNow(password);
      Alert.alert(
        t('backup.uploadedTitle') || 'Backup uploaded',
        (t('backup.uploadedMsg') || 'Encrypted backup uploaded') + ` (${fmtBytes(result?.size || 0)}).`
      );
      if (autoSchedule) {
        try { await scheduleAutomaticBackup(1); } catch {}
      }
      await refreshList();
    } catch (e) {
      Alert.alert(t('backup.failedTitle') || 'Backup failed', String(e?.message || e));
    } finally {
      setWorking(false);
      setBusyAction(null);
    }
  };

  const handleRestore = async (filename) => {
    if (password.length < 8) {
      Alert.alert(
        t('backup.needPassTitle') || 'Password required',
        t('backup.needPassMsg') || 'Type the backup password to restore.'
      );
      return;
    }
    Alert.alert(
      t('backup.restoreConfirmTitle') || 'Restore from backup?',
      (t('backup.restoreConfirmMsg') || 'This will replace your current chat database with the contents of') + ` ${filename}.`,
      [
        { text: t('common.cancel') || 'Cancel', style: 'cancel' },
        {
          text: t('backup.restoreConfirmCta') || 'Restore',
          style: 'destructive',
          onPress: async () => {
            setWorking(true);
            setBusyAction('restore');
            try {
              const r = await restoreFromBackup(filename, password);
              Alert.alert(
                t('backup.restoredTitle') || 'Restored',
                (t('backup.restoredMsg') || 'Database restored with') + ` ${r?.messageCount || 0} messages.`
              );
            } catch (e) {
              Alert.alert(t('backup.restoreFailed') || 'Restore failed', String(e?.message || e));
            } finally {
              setWorking(false);
              setBusyAction(null);
            }
          },
        },
      ]
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn} accessibilityLabel="Back">
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>
          {t('backup.chatBackupTitle') || 'Chat backup'}
        </Text>
        <TouchableOpacity onPress={refreshList} style={styles.headerBtn} accessibilityLabel="Refresh">
          <IconRefresh size={20} color={colors.text} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: Spacing.lg, paddingBottom: insets.bottom + 80 }}>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.row}>
            <IconLock size={18} color={colors.text} />
            <Text style={[styles.cardTitle, { color: colors.text }]}>
              {t('backup.e2eHeader') || 'End-to-end encrypted'}
            </Text>
          </View>
          <Text style={[styles.cardBody, { color: colors.textMuted }]}>
            {t('backup.e2eBody') ||
              'Your password encrypts the backup on this device. Chatyy servers never see it. If you forget your password, the backup cannot be recovered.'}
          </Text>
        </View>

        <Text style={[styles.label, { color: colors.text }]}>{t('backup.passwordLabel') || 'Backup password'}</Text>
        <TextInput
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t('backup.passwordHint') || 'At least 8 characters'}
          placeholderTextColor={colors.textMuted}
          style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
        />

        <TouchableOpacity
          onPress={handleBackup}
          disabled={working}
          style={[styles.primaryBtn, { backgroundColor: colors.primary, opacity: working ? 0.5 : 1 }]}
        >
          {busyAction === 'backup' ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <IconUpload size={18} color="#fff" />
              <Text style={styles.primaryBtnText}>{t('backup.backupNowCta') || 'Backup now'}</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          onPress={handleToggleAutoSchedule}
          style={[styles.toggleRow, { borderColor: colors.border }]}
        >
          <View style={{ flex: 1, paddingRight: Spacing.sm }}>
            <Text style={[styles.toggleLabel, { color: colors.text }]}>
              {t('backup.autoDaily') || 'Configurar backup automatico'}
            </Text>
            <Text style={[styles.toggleHelp, { color: colors.textMuted }]}>
              {Platform.OS === 'ios'
                ? 'Backup diario na sua iCloud, cifrado com sua senha.'
                : 'Backup diario no seu Google Drive, cifrado com sua senha.'}
            </Text>
          </View>
          <Text style={[styles.toggleState, { color: autoSchedule ? colors.primary : colors.textMuted }]}>
            {autoSchedule ? (t('common.on') || 'ON') : (t('common.off') || 'OFF')}
          </Text>
        </TouchableOpacity>

        <Text style={[styles.privacyNote, { color: colors.textMuted }]}>
          {Platform.OS === 'ios'
            ? 'Backup vai pro seu iCloud (iOS) cifrado com sua senha — Chatyy nunca ve o conteudo.'
            : 'Backup vai pro seu Google Drive cifrado com sua senha — Chatyy nunca ve o conteudo.'}
        </Text>

        <Text style={[styles.sectionHeader, { color: colors.text }]}>
          {t('backup.previousBackups') || 'Previous backups'}
        </Text>

        {busyAction === 'list' && (
          <ActivityIndicator color={colors.primary} style={{ marginTop: Spacing.md }} />
        )}

        {(!backups || backups.length === 0) && busyAction !== 'list' && (
          <Text style={[styles.empty, { color: colors.textMuted }]}>
            {t('backup.noBackups') || 'No backups yet. Tap “Backup now” to create your first.'}
          </Text>
        )}

        {backups.map((b) => (
          <View key={b.filename} style={[styles.backupRow, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.backupName, { color: colors.text }]}>{b.filename}</Text>
              <Text style={[styles.backupMeta, { color: colors.textMuted }]}>
                {fmtDate(b.createdAt)} · {fmtBytes(b.size)}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => handleRestore(b.filename)}
              disabled={working}
              style={[styles.restoreBtn, { borderColor: colors.primary, opacity: working ? 0.5 : 1 }]}
            >
              <Text style={[styles.restoreBtnText, { color: colors.primary }]}>
                {t('backup.restoreCta') || 'Restore'}
              </Text>
            </TouchableOpacity>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { padding: Spacing.sm },
  headerTitle: { flex: 1, fontSize: FontSize.lg, fontWeight: '600', textAlign: 'center' },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.lg,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  cardTitle: { marginLeft: Spacing.sm, fontWeight: '600', fontSize: FontSize.md },
  cardBody: { marginTop: Spacing.xs, fontSize: FontSize.sm, lineHeight: 19 },
  label: { fontSize: FontSize.sm, fontWeight: '600', marginBottom: Spacing.xs },
  input: {
    borderWidth: 1,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Platform.OS === 'ios' ? 12 : 8,
    fontSize: FontSize.md,
    marginBottom: Spacing.md,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: BorderRadius.md,
    gap: Spacing.sm,
  },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: FontSize.md, marginLeft: Spacing.sm },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.sm,
    marginTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  toggleLabel: { fontSize: FontSize.md },
  toggleHelp: { fontSize: FontSize.sm, marginTop: 2 },
  toggleState: { fontWeight: '700' },
  privacyNote: {
    fontSize: FontSize.sm,
    fontStyle: 'italic',
    marginTop: Spacing.sm,
    lineHeight: 18,
  },
  sectionHeader: { fontSize: FontSize.md, fontWeight: '700', marginTop: Spacing.xl, marginBottom: Spacing.sm },
  empty: { fontSize: FontSize.sm, fontStyle: 'italic', marginTop: Spacing.md },
  backupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: BorderRadius.md,
    marginBottom: Spacing.sm,
  },
  backupName: { fontSize: FontSize.md, fontWeight: '600' },
  backupMeta: { fontSize: FontSize.sm, marginTop: 2 },
  restoreBtn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderWidth: 1,
    borderRadius: BorderRadius.md,
  },
  restoreBtnText: { fontWeight: '700' },
});
