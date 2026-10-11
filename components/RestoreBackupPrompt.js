// RestoreBackupPrompt — first-login-on-new-device hook that surfaces
// existing chat backups from the user's iCloud (iOS) / Google Drive
// (Android) and offers to hydrate the local SQLite cache from one.
//
// Mounted by app/login.js after a successful auth when:
//   - Platform.OS !== 'web'
//   - the user has NOT previously dismissed this prompt
//     (@chatyy_skip_restore !== '1')
//   - services/db.dbGetConversations() returns an empty/null list
//     (no local chats yet — heuristic for "fresh install on new device")
//   - api.chatBackupList() returns ≥1 server-hosted backup, OR
//     expo-chat-backup.listBackups() returns ≥1 iCloud/Drive backup
//
// The whole feature is no-op on web (the native module is iOS/Android only).
//
// Each backup entry carries a `source` field — 'server' (Wave-7 backend
// blob, downloaded + decrypted in-process via chatBackupCloud.downloadAndRestore)
// or 'cloud' (legacy expo-chat-backup native restore path). The restore
// handler branches on `source` to call the right pipeline.
//
// Strings are hardcoded pt-BR for the first cut. TODO: extract to
// i18n/pt-BR.js / en.js / es.js under `backup.restorePrompt.*` once the
// English/Spanish translators sign off on copy.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Platform,
  Pressable,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing } from '../constants/theme';
import { IconLock, IconCloud, IconCheck, IconAlertTriangle, IconRefresh } from './Icons';

const SKIP_KEY = '@chatyy_skip_restore';

// Phase labels rendered while restoreFromBackup is in flight. We can't get
// progress callbacks from the native module so the labels just rotate by
// time elapsed (downloading → decrypting → restoring).
const PHASES = [
  { atMs: 0,    labelKey: Platform.OS === 'ios' ? 'restorePrompt.phaseDownloadIcloud' : 'restorePrompt.phaseDownloadDrive' },
  { atMs: 4500, labelKey: 'restorePrompt.phaseDecrypt' },
  { atMs: 9000, labelKey: 'restorePrompt.phaseRestore' },
];

function formatRelative(iso, t) {
  if (!iso) return '';
  let d;
  try { d = new Date(iso); } catch { return ''; }
  if (Number.isNaN(d.getTime())) return '';
  const now = Date.now();
  const diffMs = now - d.getTime();
  const min = Math.round(diffMs / 60000);
  if (min < 1) return t('restorePrompt.justNow');
  if (min < 60) return t('restorePrompt.agoMin', { n: min });
  const hr = Math.round(min / 60);
  if (hr < 24) return t('restorePrompt.agoHours', { n: hr });
  const day = Math.round(hr / 24);
  if (day === 1) return t('time.yesterday');
  if (day < 7) return t('restorePrompt.agoDays', { n: day });
  if (day < 30) {
    const w = Math.round(day / 7);
    return w === 1 ? t('restorePrompt.agoWeek') : t('restorePrompt.agoWeeks', { n: w });
  }
  // Fallback to a plain date for old backups.
  try { return d.toLocaleDateString(); } catch { return iso; }
}

function formatBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * @param {object} props
 * @param {boolean} props.visible
 * @param {() => void} props.onClose
 * @param {Array<{filename:string,createdAt:string,size:number}>} [props.backups]
 *   Pre-fetched list from listBackups(). If absent, we fetch on mount.
 * @param {() => void} [props.onRestored] Fired after a successful restore so
 *   the parent can re-render its chat list / re-sync.
 */
export default function RestoreBackupPrompt({ visible, onClose, backups: backupsProp, onRestored }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();

  // Web kill-switch — the native module isn't loadable on web, so refuse to
  // even render. (Login.js also gates the mount, this is belt-and-braces.)
  if (Platform.OS === 'web') return null;

  const [backups, setBackups] = useState(Array.isArray(backupsProp) ? backupsProp : null);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState(null);
  // 'list' (choose backup) | 'password' (typing pwd) | 'restoring' | 'done' | 'error'
  const [stage, setStage] = useState('list');
  const [selected, setSelected] = useState(null);
  const [password, setPassword] = useState('');
  const [phaseLabel, setPhaseLabel] = useState(() => t(PHASES[0].labelKey));
  const [restoreError, setRestoreError] = useState(null);
  const [restoredCount, setRestoredCount] = useState(0);

  // Lazy-require so the module loader doesn't try to bind native on web
  // builds where the .web bundle is shared by Expo Router.
  const ChatBackup = useMemo(() => {
    try { return require('expo-chat-backup'); } catch { return null; }
  }, []);

  // Sync backups prop → state if the parent later passes a fresh list.
  useEffect(() => {
    if (Array.isArray(backupsProp)) setBackups(backupsProp);
  }, [backupsProp]);

  // If the parent didn't pre-fetch, fetch ourselves when the modal opens.
  useEffect(() => {
    if (!visible) return;
    if (backups !== null) return;
    if (!ChatBackup?.listBackups) return;
    setListing(true);
    setListError(null);
    ChatBackup.listBackups()
      .then((list) => { setBackups(Array.isArray(list) ? list : []); })
      .catch((e) => {
        const msg = String(e?.message || e || '');
        setListError(msg);
        setBackups([]);
      })
      .finally(() => setListing(false));
  }, [visible, backups, ChatBackup]);

  // Rotate phase labels while restoring.
  useEffect(() => {
    if (stage !== 'restoring') return;
    const start = Date.now();
    const id = setInterval(() => {
      const elapsed = Date.now() - start;
      const current = [...PHASES].reverse().find((p) => elapsed >= p.atMs);
      if (current) setPhaseLabel(t(current.labelKey));
    }, 700);
    return () => clearInterval(id);
  }, [stage, t]);

  const reset = useCallback(() => {
    setStage('list');
    setSelected(null);
    setPassword('');
    setRestoreError(null);
    setRestoredCount(0);
  }, []);

  const handleSkip = useCallback(async () => {
    try { await AsyncStorage.setItem(SKIP_KEY, '1'); } catch {}
    reset();
    onClose?.();
  }, [reset, onClose]);

  const handleDismissOnce = useCallback(() => {
    // Plain close (no skip flag) — user might want to be asked next time.
    reset();
    onClose?.();
  }, [reset, onClose]);

  const handlePickBackup = useCallback((b) => {
    setSelected(b);
    setStage('password');
    setRestoreError(null);
  }, []);

  const handleRestore = useCallback(async () => {
    if (!selected?.filename) return;
    if (!password || password.length < 1) {
      setRestoreError(t('restorePrompt.enterPassword'));
      return;
    }
    setStage('restoring');
    setPhaseLabel(t(PHASES[0].labelKey));
    setRestoreError(null);

    try {
      let restoredCount = 0;

      // Branch on source — server-hosted goes through chatBackupCloud
      // (download via api, decrypt locally with nacl.secretbox, restore via
      // chat_restore_from_blob); cloud-provider goes through the legacy
      // native module expo-chat-backup (iCloud/Drive in-process restore).
      if (selected.source === 'server') {
        // Lazy-require so RestoreBackupPrompt remains lightweight when the
        // server path isn't needed (e.g. a Drive-only backup pick).
        const chatBackupCloud = require('../services/chatBackupCloud');
        if (typeof chatBackupCloud.downloadAndRestore !== 'function') {
          throw new Error('downloadAndRestore unavailable');
        }
        const r = await chatBackupCloud.downloadAndRestore(selected.id, password, {
          onProgress: (p) => {
            if (p?.stage === 'download') setPhaseLabel(t(PHASES[0].labelKey));
            else if (p?.stage === 'decrypt') setPhaseLabel(t(PHASES[1].labelKey));
            else if (p?.stage === 'restore') {
              const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
              setPhaseLabel(t('restorePrompt.phaseRestorePct', { pct }));
            }
          },
        });
        restoredCount = (r?.inserted || 0) + (r?.skipped || 0);
      } else {
        // Legacy iCloud/Drive native path.
        if (!ChatBackup?.restoreFromBackup) {
          throw new Error(t('restorePrompt.moduleUnavailable'));
        }
        const r = await ChatBackup.restoreFromBackup(selected.filename, password);
        restoredCount = r?.messageCount || 0;
      }

      setRestoredCount(restoredCount);
      setStage('done');
      try { onRestored?.(); } catch {}
    } catch (e) {
      const msg = String(e?.message || e || '');
      const code = e?.code || '';
      const lower = msg.toLowerCase();
      let userMsg;
      // ERR_DECRYPT from chatBackupCloud OR generic mac/gcm hints from the
      // native path → "Senha incorreta".
      if (code === 'ERR_DECRYPT' || lower.includes('mac') || lower.includes('gcm') ||
          lower.includes('decrypt') || lower.includes('password') || lower.includes('senha') ||
          lower.includes('wrong passphrase')) {
        userMsg = t('restorePrompt.errWrongPassword');
      } else if (lower.includes('corrupt') || lower.includes('magic') || lower.includes('format')) {
        userMsg = t('restorePrompt.errCorrupt');
      } else if (code === 'ERR_DOWNLOAD' || lower.includes('network') || lower.includes('download') || lower.includes('timeout')) {
        userMsg = t('restorePrompt.errDownload');
      } else {
        userMsg = msg || t('backup.restoreFailed');
      }
      setRestoreError(userMsg);
      setStage('error');
    }
  }, [selected, password, ChatBackup, onRestored, t]);

  const isGoogleSigninError = useMemo(() => {
    if (!listError) return false;
    const m = listError.toLowerCase();
    return m.includes('err_google_signin') || m.includes('sign in with google') || m.includes('sign-in');
  }, [listError]);

  const retrySignIn = useCallback(async () => {
    if (!ChatBackup?.listBackups) return;
    setListing(true);
    setListError(null);
    try {
      const list = await ChatBackup.listBackups();
      setBackups(Array.isArray(list) ? list : []);
    } catch (e) {
      setListError(String(e?.message || e || ''));
    } finally {
      setListing(false);
    }
  }, [ChatBackup]);

  const styles = useMemo(() => buildStyles(colors, isDark), [colors, isDark]);

  // Defensive empty state — login.js shouldn't mount us when backups is
  // empty, but if it does we render a small "no backups" view + skip.
  const empty = Array.isArray(backups) && backups.length === 0 && !listing;

  return (
    <Modal
      visible={!!visible}
      transparent
      animationType="fade"
      onRequestClose={handleDismissOnce}
      statusBarTranslucent
    >
      <Pressable style={styles.backdrop} onPress={handleDismissOnce}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerIcon}>
              <IconCloud size={28} color={colors.primary} />
            </View>
            <Text style={styles.title}>{t('restorePrompt.title')}</Text>
            <Text style={styles.subtitle}>
              {(() => {
                // Tailor the copy to the actual source — server-hosted
                // backups should NOT advertise iCloud/Drive when the user
                // has only the Wave-7 backend blob.
                const hasServer = Array.isArray(backups) && backups.some((b) => b.source === 'server');
                if (hasServer) return t('restorePrompt.subtitleServer');
                if (Platform.OS === 'ios') return t('restorePrompt.subtitleIcloud');
                return t('restorePrompt.subtitleDrive');
              })()}
            </Text>
          </View>

          {/* Body */}
          <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: Spacing.md }}>
            {/* Listing error (e.g. Google Sign-In required on Android) */}
            {listError && isGoogleSigninError && (
              <View style={styles.errBox}>
                <IconAlertTriangle size={18} color="#f59e0b" />
                <Text style={styles.errText}>
                  {t('restorePrompt.connectGoogle')}
                </Text>
                <TouchableOpacity onPress={retrySignIn} style={styles.smallBtn}>
                  <Text style={styles.smallBtnText}>{t('restorePrompt.connect')}</Text>
                </TouchableOpacity>
              </View>
            )}
            {listError && !isGoogleSigninError && (
              <View style={styles.errBox}>
                <IconAlertTriangle size={18} color="#f59e0b" />
                <Text style={styles.errText} numberOfLines={3}>
                  {t('restorePrompt.listFailed', { error: listError })}
                </Text>
                <TouchableOpacity onPress={retrySignIn} style={styles.smallBtn}>
                  <IconRefresh size={14} color={colors.primary} />
                  <Text style={styles.smallBtnText}>{t('common.tryAgain')}</Text>
                </TouchableOpacity>
              </View>
            )}

            {listing && (
              <View style={styles.center}>
                <ActivityIndicator color={colors.primary} />
                <Text style={styles.mutedSmall}>{t('restorePrompt.searching')}</Text>
              </View>
            )}

            {empty && !listError && (
              <View style={styles.center}>
                <Text style={styles.mutedSmall}>
                  {t('restorePrompt.noneFound')}
                </Text>
              </View>
            )}

            {/* STAGE: list */}
            {stage === 'list' && Array.isArray(backups) && backups.length > 0 && (
              <View>
                {backups.map((b) => (
                  <TouchableOpacity
                    key={b.filename}
                    style={styles.backupRow}
                    onPress={() => handlePickBackup(b)}
                    activeOpacity={0.7}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.backupName} numberOfLines={1}>{b.filename}</Text>
                      <Text style={styles.backupMeta}>
                        {formatRelative(b.createdAt, t)} · {formatBytes(b.size)}
                      </Text>
                    </View>
                    <Text style={styles.pickCta}>{t('backup.restore')}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* STAGE: password */}
            {stage === 'password' && selected && (
              <View>
                <View style={styles.selectedHeader}>
                  <IconLock size={16} color={colors.textMuted} />
                  <Text style={styles.selectedName} numberOfLines={1}>{selected.filename}</Text>
                </View>
                <Text style={styles.label}>{t('backup.passwordLabel')}</Text>
                <TextInput
                  value={password}
                  onChangeText={(v) => { setPassword(v); if (restoreError) setRestoreError(null); }}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder={t('restorePrompt.passwordPlaceholder')}
                  placeholderTextColor={colors.textMuted}
                  style={styles.input}
                  autoFocus
                />
                {restoreError ? (
                  <Text style={styles.inlineErr}>{restoreError}</Text>
                ) : (
                  <Text style={styles.mutedSmall}>
                    {t('restorePrompt.passwordHint')}
                  </Text>
                )}
                <TouchableOpacity
                  style={styles.primaryBtn}
                  onPress={handleRestore}
                  activeOpacity={0.85}
                >
                  <Text style={styles.primaryBtnText}>{t('backup.restore')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.linkBtn}
                  onPress={() => setStage('list')}
                  activeOpacity={0.7}
                >
                  <Text style={styles.linkBtnText}>{t('common.back')}</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* STAGE: restoring */}
            {stage === 'restoring' && (
              <View style={styles.center}>
                <ActivityIndicator size="large" color={colors.primary} />
                <Text style={styles.phaseLabel}>{phaseLabel}</Text>
                <Text style={styles.mutedSmall}>{t('restorePrompt.dontClose')}</Text>
              </View>
            )}

            {/* STAGE: done */}
            {stage === 'done' && (
              <View style={styles.center}>
                <View style={[styles.headerIcon, { backgroundColor: 'rgba(16,185,129,0.15)' }]}>
                  <IconCheck size={28} color="#10b981" />
                </View>
                <Text style={styles.doneTitle}>{t('restorePrompt.doneTitle')}</Text>
                <Text style={styles.mutedSmall}>
                  {restoredCount > 0
                    ? t('ownBackup.restoredNotice', { n: restoredCount })
                    : t('ownBackup.restoreDoneTitle')}
                </Text>
                <TouchableOpacity
                  style={styles.primaryBtn}
                  onPress={() => { reset(); onClose?.(); }}
                  activeOpacity={0.85}
                >
                  <Text style={styles.primaryBtnText}>{t('common.done')}</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* STAGE: error (after a failed restore attempt) */}
            {stage === 'error' && (
              <View>
                <View style={styles.errBox}>
                  <IconAlertTriangle size={18} color="#ef4444" />
                  <Text style={styles.errText}>{restoreError || t('backup.restoreFailed')}</Text>
                </View>
                <TouchableOpacity
                  style={styles.primaryBtn}
                  onPress={() => { setStage('password'); setRestoreError(null); }}
                  activeOpacity={0.85}
                >
                  <Text style={styles.primaryBtnText}>{t('common.tryAgain')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.linkBtn}
                  onPress={() => { reset(); }}
                  activeOpacity={0.7}
                >
                  <Text style={styles.linkBtnText}>{t('restorePrompt.chooseOther')}</Text>
                </TouchableOpacity>
              </View>
            )}
          </ScrollView>

          {/* Footer — always shows a "skip" so the user is never trapped. */}
          {stage !== 'restoring' && stage !== 'done' && (
            <View style={styles.footer}>
              <TouchableOpacity onPress={handleSkip} activeOpacity={0.7} style={styles.skipBtn}>
                <Text style={styles.skipText}>{t('onboarding.skip')}</Text>
              </TouchableOpacity>
            </View>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function buildStyles(colors, isDark) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.55)',
      justifyContent: 'center',
      alignItems: 'center',
      padding: Spacing.lg,
    },
    sheet: {
      width: '100%',
      maxWidth: 440,
      maxHeight: '88%',
      backgroundColor: colors.surface || colors.background,
      borderRadius: BorderRadius.lg,
      overflow: 'hidden',
      ...Platform.select({
        ios: { shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 24, shadowOffset: { width: 0, height: 12 } },
        android: { elevation: 18 },
        default: {},
      }),
    },
    header: {
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.lg,
      paddingBottom: Spacing.md,
      alignItems: 'center',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    headerIcon: {
      width: 56, height: 56, borderRadius: 28,
      backgroundColor: isDark ? 'rgba(59,130,246,0.15)' : 'rgba(59,130,246,0.10)',
      alignItems: 'center', justifyContent: 'center',
      marginBottom: Spacing.sm,
    },
    title: {
      fontSize: FontSize.lg,
      fontWeight: '700',
      color: colors.text,
      textAlign: 'center',
    },
    subtitle: {
      marginTop: Spacing.xs,
      fontSize: FontSize.sm,
      color: colors.textMuted,
      textAlign: 'center',
      lineHeight: 19,
    },
    body: {
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.md,
    },
    center: {
      alignItems: 'center',
      paddingVertical: Spacing.lg,
      gap: Spacing.sm,
    },
    phaseLabel: {
      marginTop: Spacing.sm,
      fontSize: FontSize.md,
      fontWeight: '600',
      color: colors.text,
      textAlign: 'center',
    },
    mutedSmall: {
      fontSize: FontSize.sm,
      color: colors.textMuted,
      textAlign: 'center',
    },
    doneTitle: {
      fontSize: FontSize.lg,
      fontWeight: '700',
      color: colors.text,
      marginTop: Spacing.sm,
    },
    backupRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: Spacing.md,
      paddingHorizontal: Spacing.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: BorderRadius.md,
      marginBottom: Spacing.sm,
      backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
    },
    backupName: {
      fontSize: FontSize.md,
      fontWeight: '600',
      color: colors.text,
    },
    backupMeta: {
      marginTop: 2,
      fontSize: FontSize.sm,
      color: colors.textMuted,
    },
    pickCta: {
      fontSize: FontSize.sm,
      fontWeight: '700',
      color: colors.primary,
      marginLeft: Spacing.sm,
    },
    selectedHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.xs,
      marginBottom: Spacing.sm,
    },
    selectedName: {
      flex: 1,
      fontSize: FontSize.sm,
      color: colors.textMuted,
    },
    label: {
      fontSize: FontSize.sm,
      fontWeight: '600',
      color: colors.text,
      marginBottom: Spacing.xs,
    },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: BorderRadius.md,
      paddingHorizontal: Spacing.md,
      paddingVertical: Platform.OS === 'ios' ? 12 : 8,
      fontSize: FontSize.md,
      color: colors.text,
      backgroundColor: colors.background,
      marginBottom: Spacing.xs,
    },
    inlineErr: {
      fontSize: FontSize.sm,
      color: '#ef4444',
      marginBottom: Spacing.xs,
    },
    primaryBtn: {
      backgroundColor: colors.primary,
      paddingVertical: 14,
      borderRadius: BorderRadius.md,
      alignItems: 'center',
      marginTop: Spacing.md,
    },
    primaryBtnText: {
      color: colors.onPrimary || '#fff',
      fontSize: FontSize.md,
      fontWeight: '700',
    },
    linkBtn: {
      paddingVertical: Spacing.sm,
      alignItems: 'center',
      marginTop: Spacing.xs,
    },
    linkBtnText: {
      color: colors.primary,
      fontSize: FontSize.sm,
      fontWeight: '600',
    },
    footer: {
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      alignItems: 'center',
    },
    skipBtn: {
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.lg,
    },
    skipText: {
      color: colors.textMuted,
      fontSize: FontSize.md,
      fontWeight: '600',
    },
    errBox: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: Spacing.sm,
      padding: Spacing.md,
      borderRadius: BorderRadius.md,
      backgroundColor: isDark ? 'rgba(245,158,11,0.12)' : 'rgba(245,158,11,0.10)',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: isDark ? 'rgba(245,158,11,0.3)' : 'rgba(245,158,11,0.4)',
      marginBottom: Spacing.md,
    },
    errText: {
      flex: 1,
      fontSize: FontSize.sm,
      color: colors.text,
    },
    smallBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.xs,
      borderRadius: BorderRadius.sm,
      borderWidth: 1,
      borderColor: colors.primary,
    },
    smallBtnText: {
      color: colors.primary,
      fontSize: FontSize.sm,
      fontWeight: '700',
    },
  });
}
