import React, { useState, useEffect, useCallback, useRef } from 'react';
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
import { formatBytes } from '../services/format';
import { safeAlert } from '../services/alerts';
import { mapApiError } from '../services/errorMap';
import AvatarCircle from '../components/AvatarCircle';
import {
  IconArrowLeft, IconUpload, IconCheck, IconTrash, IconShield, IconLock, IconRefresh,
} from '../components/Icons';
// Backup engine config / progress hooks. Quality toggle reads/writes the
// shared settings store the engine consults at runtime, so flipping it here
// affects the very next photo the engine compresses (or skips, for original).
let backupSvc = null;
try { backupSvc = require('../services/backup'); } catch {}

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

  // Originals quality toggle. When ON the engine skips ImageManipulator
  // compression and uploads the raw photo bytes (engine already accepts
  // `quality: 'original'` per audit). Default OFF = 1600 px / 0.78 JPEG
  // economy preset which is what most users want on cellular.
  const [originalsQuality, setOriginalsQuality] = useState(false);
  const [originalsSaving, setOriginalsSaving] = useState(false);

  // Backup progress + ETA. Engine emits onProgress with cumulative bytes;
  // we keep a rolling 30s window of (timestamp, uploadedBytes) samples and
  // derive bytes_per_sec from window-newest minus window-oldest. Then ETA =
  // remaining / bytes_per_sec. Avoids "infinity" spikes when the very first
  // chunk lands.
  const [bkProgress, setBkProgress] = useState(null); // { uploadedBytes, totalBytes, completedFiles, totalFiles, isRunning }
  const speedSamplesRef = useRef([]); // [{ t: ms, b: bytes }, ...]
  const speedWindowMs = 30000;

  // Compute bytes/sec from rolling window. Empty / single sample → 0.
  const computeBytesPerSec = useCallback(() => {
    const samples = speedSamplesRef.current;
    if (!samples || samples.length < 2) return 0;
    const newest = samples[samples.length - 1];
    const oldest = samples[0];
    const dt = (newest.t - oldest.t) / 1000;
    if (dt <= 0) return 0;
    return Math.max(0, (newest.b - oldest.b) / dt);
  }, []);

  // Render an ETA string in user-friendly Portuguese. "Restam X min" per
  // task spec; short form ("Restam Xs") for sub-minute deltas, hour+min
  // composite for long jobs.
  const formatEta = useCallback((sec) => {
    if (!sec || !isFinite(sec) || sec < 0) return '';
    if (sec < 60) return (t('backup.etaSeconds', { n: String(Math.round(sec)) }) || `Restam ${Math.round(sec)}s`);
    if (sec < 3600) return (t('backup.etaMinutes', { n: String(Math.round(sec / 60)) }) || `Restam ${Math.round(sec / 60)} min`);
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return (t('backup.etaHoursMin', { h: String(h), m: String(m) }) || `Restam ${h}h ${m}min`);
  }, [t]);

  useEffect(() => {
    AsyncStorage.getItem('backup_e2e_enabled').then(v => setE2eEnabled(v === '1')).catch(() => {});
    // Load current engine quality preference. The engine reads `settings.quality`
    // every time it queues a batch, so reflecting the persisted value here
    // keeps the toggle truthful even after an app restart.
    (async () => {
      try {
        if (backupSvc?.getBackupSettings) {
          const s = await backupSvc.getBackupSettings();
          if (s?.quality === 'original') setOriginalsQuality(true);
        }
      } catch {}
    })();
  }, []);

  // Engine progress poll. The engine pushes via onProgress callbacks but that
  // path is wired in runBackupNow which the user may not have started from
  // this screen. Polling getBackupStats every 1s captures both: ongoing runs
  // kicked off by autoBackup AND foreground runs the user starts here. Light
  // (just an in-memory snapshot read), no AsyncStorage round trip.
  useEffect(() => {
    if (!backupSvc?.getBackupStats) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const stats = await backupSvc.getBackupStats();
        if (cancelled) return;
        if (stats && (stats.isRunning || stats.uploadedBytes > 0)) {
          setBkProgress(stats);
          // Add a sample to the rolling window so the ETA computation has data.
          const samples = speedSamplesRef.current;
          const now = Date.now();
          samples.push({ t: now, b: stats.uploadedBytes || 0 });
          // Drop samples older than 30s. Cheap loop — at most ~30 samples kept.
          while (samples.length > 0 && samples[0].t < now - speedWindowMs) {
            samples.shift();
          }
        } else if (!stats?.isRunning) {
          // Reset window once a run ends so the next run starts fresh.
          speedSamplesRef.current = [];
          if (bkProgress?.isRunning) setBkProgress(stats || null);
        }
      } catch {}
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => { cancelled = true; clearInterval(id); };
    // bkProgress.isRunning intentionally omitted — we want the poll to keep
    // running so we detect the next backup start without remounting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggleOriginals = useCallback(async (value) => {
    setOriginalsSaving(true);
    setOriginalsQuality(value);
    try {
      if (backupSvc?.setBackupSettings) {
        await backupSvc.setBackupSettings({ quality: value ? 'original' : 'economy' });
      }
    } catch (err) {
      // Revert on failure so the UI matches the actual persisted state.
      setOriginalsQuality(!value);
      safeAlert(t('common.error') || 'Erro', t('backup.qualitySaveFail') || 'Não foi possível salvar a preferência.');
    } finally {
      setOriginalsSaving(false);
    }
  }, [t]);

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
  // Server returns storage_used in BYTES. Without dividing, .toFixed(1) prints
  // raw bytes labelled as "GB" — which is why the user always saw "0.0 GB"
  // even after uploading: the result was zero only when no bytes existed,
  // but ANY usage would have shown a comically large number. Convert here.
  const storageUsedBytes = planInfo?.storage_used || 0;
  const storageUsed = storageUsedBytes / (1024 * 1024 * 1024);
  // Storage limit is authoritative from the server (plans.php). We only
  // fall back to 100GB — matches the free tier — when the API hasn't
  // responded yet so the UI doesn't flash a stingier number first.
  const storageTotalBytes = planInfo?.storage_limit
    || planInfo?.quota
    || 100 * 1024 * 1024 * 1024;
  const storageTotal = Math.round(storageTotalBytes / (1024 * 1024 * 1024));
  // Backup is now included free for every account (100 GB tier).
  // Kept as a constant so the gating branch below stays in the file
  // but never triggers — IAP code paths remain dormant for future use.
  const hasBackup = true;

  // History snapshot state — single-backup model. Mirrors backend
  // chat_user_plans.snapshot_* columns. `schedule = 'off'` means manual only.
  const [snapshot, setSnapshot] = useState({ schedule: 'off', last_at: null, size: 0, msg_count: 0, has_backup: false });
  const [snapshotBusy, setSnapshotBusy] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [infoRes, backupRes, snapRes] = await Promise.all([
        api.planInfo(),
        api.planBackupList(),
        api.historySnapshotStatus().catch(() => null),
      ]);
      if (infoRes?.data) setPlanInfo(infoRes.data);
      if (backupRes?.data?.items) setBackupItems(backupRes.data.items);
      else setBackupItems([]);
      if (snapRes?.data) setSnapshot(snapRes.data);
    } catch (e) { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Snapshot actions
  const handleSetSchedule = useCallback(async (sched) => {
    setSnapshotBusy(true);
    try {
      const r = await api.historySnapshotSetSchedule(sched);
      if (r?.success !== false) setSnapshot(s => ({ ...s, schedule: sched }));
      else safeAlert(t('common.error') || 'Error', mapApiError(r, t, 'backup'));
    } finally { setSnapshotBusy(false); }
  }, [t]);

  const handleSnapshotNow = useCallback(async () => {
    setSnapshotBusy(true);
    try {
      const r = await api.historySnapshotRun();
      if (r?.data?.ok) {
        setSnapshot(s => ({
          ...s,
          last_at: r.data.created_at,
          size: r.data.size,
          msg_count: r.data.msg_count,
          has_backup: true,
        }));
        safeAlert(t('backup.snapshotDoneTitle') || 'Backup feito', t('backup.snapshotDoneMsg') || 'Substituiu o backup anterior.');
      } else {
        safeAlert(t('common.error') || 'Error', mapApiError(r, t, 'backup'));
      }
    } finally { setSnapshotBusy(false); }
  }, [t]);

  const handleSnapshotRestore = useCallback(() => {
    safeAlert(
      t('backup.restoreTitle') || 'Restaurar backup',
      t('backup.restoreConfirm') || 'Mensagens deletadas dentro do período do backup voltam pra conversa. OK?',
      [
        { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
        {
          text: t('backup.restoreYes') || 'Restaurar', onPress: async () => {
            setSnapshotBusy(true);
            try {
              const r = await api.historySnapshotRestore();
              if (r?.data?.ok) {
                safeAlert(t('backup.restoreDone') || 'Restaurado', `${r.data.restored || 0} mensagens recuperadas.`);
              } else {
                safeAlert(t('common.error') || 'Error', mapApiError(r, t, 'backup'));
              }
            } finally { setSnapshotBusy(false); }
          },
        },
      ]
    );
  }, [t]);

  const handleSnapshotDelete = useCallback(() => {
    safeAlert(
      t('backup.deleteTitle') || 'Apagar backup',
      t('backup.deleteConfirm') || 'O snapshot atual será apagado. Próximo backup começa do zero. Confirma?',
      [
        { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
        {
          text: t('backup.deleteYes') || 'Apagar', style: 'destructive', onPress: async () => {
            setSnapshotBusy(true);
            try {
              const r = await api.historySnapshotDelete();
              if (r?.success !== false) {
                setSnapshot(s => ({ ...s, last_at: null, size: 0, msg_count: 0, has_backup: false }));
              } else {
                safeAlert(t('common.error') || 'Error', mapApiError(r, t, 'backup'));
              }
            } finally { setSnapshotBusy(false); }
          },
        },
      ]
    );
  }, [t]);

  const handleRestore = async (backupId) => {
    setRestoring(backupId);
    try {
      const res = await api.planBackupRestore(backupId);
      if (res?.data?.success) {
        safeAlert(t('backup.restored'), null, [{ text: 'OK' }]);
        setBackupItems(prev => prev.filter(item => item.id !== backupId));
      } else {
        safeAlert('Erro', mapApiError(res?.data || res, t, 'backup'));
      }
    } catch (e) {
      safeAlert('Erro', mapApiError(e, t, 'backup'));
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

  const ACCENT = isDark ? '#A78BFA' : '#7C3AED';

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
          <View style={{ marginTop: 16, padding: 16, borderRadius: 12, backgroundColor: (colors.primary || '#7C3AED') + '12' }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: colors.primary || '#7C3AED' }}>
              {t?.('backup.freeTier') || '100 GB grátis'}
            </Text>
            <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 4 }}>
              {t?.('backup.freeTierDesc') || 'Backup automático de fotos e arquivos incluído.'}
            </Text>
          </View>
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
            {/* Status pill: green=enabled, orange=warning, gray=disabled */}
            {(() => {
              const statusKind = currentPlan ? 'ok' : (storageUsed > storageTotal * 0.9 ? 'warn' : 'idle');
              const pillBg = statusKind === 'ok'
                ? 'rgba(34,197,94,0.15)'
                : statusKind === 'warn'
                  ? 'rgba(245,158,11,0.15)'
                  : 'rgba(148,163,184,0.18)';
              const pillFg = statusKind === 'ok'
                ? (isDark ? '#4ade80' : '#16a34a')
                : statusKind === 'warn'
                  ? (isDark ? '#fbbf24' : '#d97706')
                  : colors.textSecondary;
              return (
                <View style={{
                  alignSelf: 'flex-start',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 12,
                  backgroundColor: pillBg,
                  borderRadius: 14,
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                }}>
                  <IconCheck size={16} color={pillFg} />
                  <Text style={{ color: pillFg, fontSize: FontSize.sm, fontWeight: '700', letterSpacing: 0.2 }}>{t('backup.enabled')}</Text>
                </View>
              );
            })()}
            <View style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm }}>{t('backup.plan')}</Text>
                <Text style={{ color: colors.text, fontSize: FontSize.sm, fontWeight: '600' }}>
                  {currentPlan === 'family' ? 'Família' : 'Chatyy One'}
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
                  {(() => {
                    // Split count so user sees "10 fotos · 45 mensagens"
                    // instead of a single inflated number that mixed text +
                    // media. User feedback: total was bigger than actual
                    // photos because every forward/reply inflated the row.
                    const mediaCount = backupItems.filter(i => i && i.file_url && ['image','video','audio','voice','gif','sticker','file'].includes(i.type)).length;
                    const textCount = Math.max(0, backupItems.length - mediaCount);
                    if (mediaCount && textCount) return `${mediaCount} ${t('backup.media') || 'mídias'} · ${textCount} ${t('backup.texts') || 'mensagens'}`;
                    if (mediaCount) return `${mediaCount} ${t('backup.media') || 'mídias'}`;
                    return t('backup.itemsCount', { n: String(backupItems.length) });
                  })()}
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

          {/* Originals quality toggle. OFF (default) = 1600 px / 0.78 JPEG
              compression which uses 4-8× less storage and uploads 5-10× faster
              on cellular. ON keeps the raw camera bytes — ideal on WiFi or
              when archival is the goal. Routes through getBackupSettings so
              the engine picks it up on the next batch. */}
          <View style={[s.statusCard, { backgroundColor: colors.surface, borderColor: colors.border, marginTop: -8 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <IconUpload size={18} color={ACCENT} />
              <Text style={{ color: colors.text, fontSize: FontSize.lg, fontWeight: '600', flex: 1 }}>
                {t('backup.originalQuality') || 'Qualidade original'}
              </Text>
              <TouchableOpacity
                onPress={() => handleToggleOriginals(!originalsQuality)}
                disabled={originalsSaving}
                accessibilityRole="switch"
                accessibilityState={{ checked: originalsQuality }}
                style={{
                  width: 46, height: 28, borderRadius: 14, padding: 3,
                  backgroundColor: originalsQuality ? ACCENT : (isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.18)'),
                  opacity: originalsSaving ? 0.6 : 1,
                  justifyContent: 'center',
                }}
              >
                <View style={{
                  width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff',
                  alignSelf: originalsQuality ? 'flex-end' : 'flex-start',
                  ...(Platform.OS === 'web' ? { transition: 'all 160ms ease' } : {}),
                }} />
              </TouchableOpacity>
            </View>
            <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, lineHeight: 19 }}>
              {originalsQuality
                ? (t('backup.originalQualityOnDesc') || 'Subindo arquivos originais. Usa mais dados e armazenamento, mas preserva resolução máxima e EXIF.')
                : (t('backup.originalQualityOffDesc') || 'Subindo versão otimizada (1600 px). Economiza dados e armazenamento. Recomendado em rede móvel.')}
            </Text>
          </View>

          {/* Live backup progress + ETA. Renders only while the engine is
              actually running so the card disappears when idle. Bytes/sec
              comes from the 30s rolling window; ETA = remaining / bps. */}
          {bkProgress?.isRunning && (() => {
            const bps = computeBytesPerSec();
            const remaining = Math.max(0, (bkProgress.totalBytes || 0) - (bkProgress.uploadedBytes || 0));
            const etaSec = bps > 0 ? remaining / bps : 0;
            const pct = bkProgress.totalBytes > 0
              ? Math.min(100, Math.round((bkProgress.uploadedBytes / bkProgress.totalBytes) * 100))
              : (bkProgress.percentage || 0);
            return (
              <View style={[s.statusCard, { backgroundColor: colors.surface, borderColor: colors.border, marginTop: -8 }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <ActivityIndicator size="small" color={ACCENT} />
                  <Text style={{ color: colors.text, fontSize: FontSize.lg, fontWeight: '600', flex: 1 }}>
                    {t('backup.progressTitle') || 'Backup em andamento'}
                  </Text>
                  <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, fontWeight: '600' }}>
                    {pct}%
                  </Text>
                </View>
                <View style={[s.storageBarBg, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', marginBottom: 8 }]}>
                  <View style={[s.storageBarFill, { width: `${pct}%`, backgroundColor: ACCENT }]} />
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ color: colors.textSecondary, fontSize: FontSize.xs }}>
                    {bkProgress.completedFiles || 0} / {bkProgress.totalFiles || 0} · {formatBytes(bkProgress.uploadedBytes || 0)}
                  </Text>
                  {etaSec > 0 && (
                    <Text style={{ color: ACCENT, fontSize: FontSize.xs, fontWeight: '700' }}>
                      {formatEta(etaSec)}
                    </Text>
                  )}
                </View>
              </View>
            );
          })()}

          {/* Snapshot Backup Card — single-snapshot model with schedule */}
          <View style={[s.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <IconUpload size={20} color={ACCENT} />
              <Text style={{ color: colors.text, fontSize: FontSize.lg, fontWeight: '700', flex: 1 }}>
                {t('backup.historyTitle') || 'Backup das mensagens'}
              </Text>
              {snapshot.has_backup && (
                <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: 'rgba(34,197,94,0.15)' }}>
                  <Text style={{ color: '#16a34a', fontSize: FontSize.xs, fontWeight: '700' }}>
                    {snapshot.msg_count} msgs
                  </Text>
                </View>
              )}
            </View>
            <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, lineHeight: 19, marginBottom: 14 }}>
              {t('backup.historyDesc') || 'Faz uma cópia completa das suas mensagens. Sempre fica salvo só o último — quando faz um novo, o antigo é substituído. Pode restaurar mensagens deletadas a partir desse snapshot.'}
            </Text>
            {/* Schedule picker */}
            <Text style={{ color: colors.text, fontSize: FontSize.sm, fontWeight: '600', marginBottom: 8 }}>
              {t('backup.schedule') || 'Frequência'}
            </Text>
            <View style={{ flexDirection: 'row', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
              {[
                { v: 'off',     label: t('backup.schedOff')     || 'Manual' },
                { v: 'daily',   label: t('backup.schedDaily')   || 'Diário' },
                { v: 'weekly',  label: t('backup.schedWeekly')  || 'Semanal' },
                { v: 'monthly', label: t('backup.schedMonthly') || 'Mensal' },
              ].map(opt => {
                const active = snapshot.schedule === opt.v;
                return (
                  <TouchableOpacity
                    key={opt.v}
                    onPress={() => handleSetSchedule(opt.v)}
                    disabled={snapshotBusy}
                    style={{
                      paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
                      backgroundColor: active ? ACCENT : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'),
                      borderWidth: active ? 0 : 1, borderColor: colors.border,
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                  >
                    <Text style={{ color: active ? '#fff' : colors.text, fontSize: FontSize.sm, fontWeight: '600' }}>{opt.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {/* Status line */}
            {snapshot.has_backup ? (
              <Text style={{ color: colors.textSecondary, fontSize: FontSize.xs, marginBottom: 12 }}>
                {(t('backup.lastBackup') || 'Último backup')}: {snapshot.last_at ? new Date(snapshot.last_at).toLocaleString() : '—'} · {formatBytes(snapshot.size)}
              </Text>
            ) : (
              <Text style={{ color: colors.textTertiary, fontSize: FontSize.xs, marginBottom: 12 }}>
                {t('backup.noBackupYet') || 'Nenhum backup feito ainda.'}
              </Text>
            )}
            {/* Action row */}
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <TouchableOpacity
                onPress={handleSnapshotNow}
                disabled={snapshotBusy}
                style={{ flex: 1, minWidth: 140, height: 42, borderRadius: 10, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center', opacity: snapshotBusy ? 0.6 : 1 }}
                accessibilityRole="button"
              >
                {snapshotBusy
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={{ color: '#fff', fontWeight: '700' }}>{t('backup.snapshotNow') || 'Fazer backup agora'}</Text>}
              </TouchableOpacity>
              {snapshot.has_backup && (
                <>
                  <TouchableOpacity
                    onPress={handleSnapshotRestore}
                    disabled={snapshotBusy}
                    style={{ minWidth: 110, height: 42, paddingHorizontal: 14, borderRadius: 10, backgroundColor: isDark ? 'rgba(96,165,250,0.15)' : 'rgba(37,99,235,0.1)', alignItems: 'center', justifyContent: 'center' }}
                    accessibilityRole="button"
                  >
                    <Text style={{ color: ACCENT, fontWeight: '700' }}>{t('backup.snapshotRestore') || 'Restaurar'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={handleSnapshotDelete}
                    disabled={snapshotBusy}
                    style={{ minWidth: 90, height: 42, paddingHorizontal: 14, borderRadius: 10, backgroundColor: isDark ? 'rgba(248,113,113,0.12)' : 'rgba(220,38,38,0.08)', alignItems: 'center', justifyContent: 'center' }}
                    accessibilityRole="button"
                  >
                    <Text style={{ color: colors.error, fontWeight: '700' }}>{t('backup.snapshotDelete') || 'Apagar'}</Text>
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
                        style={[s.restoreAllBtn, { backgroundColor: isDark ? 'rgba(167, 139, 250, 0.12)' : 'rgba(124, 58, 237, 0.08)' }]}
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
                                {(_d => isNaN(_d.getTime()) ? '' : _d.toLocaleDateString())(new Date(item.deleted_at))}
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
                            style={[s.actionBtn, { backgroundColor: isDark ? 'rgba(167, 139, 250, 0.12)' : 'rgba(124, 58, 237, 0.08)' }]}
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
  // Why: header back button + title typography matched to the rest of cycle 2
  // polish — back has web hover, title has tighter letter-spacing.
  backBtn: {
    width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20,
    ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'background-color 160ms ease' } : {}),
  },
  headerTitle: { fontSize: FontSize.xl, fontWeight: '700', letterSpacing: -0.4 },
  scrollContent: { paddingTop: Spacing.xl, paddingBottom: 40 },
  statusCard: {
    borderRadius: BorderRadius.xl, borderWidth: 1, padding: 20, marginBottom: 20,
  },
  // Storage bar bumped 6→7 height + tighter radius so the fill is more
  // visible — was disappearing on small screens.
  storageBarBg: { height: 10, borderRadius: 5, overflow: 'hidden' },
  storageBarFill: { height: 10, borderRadius: 5 },
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
