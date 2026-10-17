// [2026-10-15 settings-split] Histórico/mídia no aparelho (Armazenamento e
// dados) — movido do app/settings.js sem mudanças de comportamento.
import { memo, useState, useEffect, useRef, useCallback } from 'react';
import { View, ActivityIndicator, Platform } from 'react-native';
import { useTheme } from '../../../context/ThemeContext';
import { useLanguage } from '../../../context/LanguageContext';
import { IconCheck, IconDownload, IconRefresh } from '../../Icons';
import { SettingsGroup, SettingsRow, SettingsValueText } from '../SettingsKit';

// History download / missing-media UI used inside the Storage section of
// SettingsScreenInner. Hooks pull theme + i18n; SQLite counters come from
// services/db.getSyncStats() refreshed on mount + every 4s while a download
// is running. Manual triggers route to services/fullHistorySync.
export default memo(function HistoryDownloadGroup() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [stats, setStats] = useState(null);
  const [busyHistory, setBusyHistory] = useState(false);
  const [busyMedia, setBusyMedia] = useState(false);
  const [mediaProgress, setMediaProgress] = useState(null); // {loaded,total,percent}
  const [historyProgress, setHistoryProgress] = useState(null);
  // #1247 (2026-05-21): live progress from the background media auto-sync
  // loop. When phase='syncing', the row morphs into "Sincronizando X/Y"
  // (vs the alarming "Mídias faltantes: Y"); when nothing is pending and
  // the loop has settled, it shows "Sincronizado ✓".
  const [autoSync, setAutoSync] = useState(null);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const refreshStats = useCallback(async () => {
    if (Platform.OS === 'web') return;
    try {
      const dbMod = require('../../../services/db');
      const r = await dbMod.getSyncStats?.();
      if (aliveRef.current) setStats(r || null);
    } catch {}
  }, []);
  useEffect(() => { refreshStats(); }, [refreshStats]);

  // Poll stats every 4s while a download is running so the counters reflect
  // progress in near-real-time.
  useEffect(() => {
    if (!busyHistory && !busyMedia) return undefined;
    const id = setInterval(refreshStats, 4000);
    return () => clearInterval(id);
  }, [busyHistory, busyMedia, refreshStats]);

  // Subscribe to bootstrap progress for live convs counter.
  useEffect(() => {
    if (Platform.OS === 'web' || !busyHistory) return undefined;
    let ws = null;
    try { ws = require('../../../services/websocket').default; } catch {}
    const handler = (payload) => {
      setHistoryProgress({
        convDone: payload.convDone || 0,
        convTotal: payload.convTotal || 0,
        phase: payload.phase,
      });
      if (payload.phase === 'done') {
        setBusyHistory(false);
        refreshStats();
      }
    };
    try { ws?.on?.('chat_bootstrap_progress', handler); } catch {}
    return () => { try { ws?.off?.('chat_bootstrap_progress', handler); } catch {} };
  }, [busyHistory, refreshStats]);

  // [#1247] Subscribe to media auto-sync progress. Always-on so the row
  // reflects whatever the background loop is doing. Seed with current
  // snapshot so a mid-pass open shows progress immediately.
  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    let ws = null;
    try { ws = require('../../../services/websocket').default; } catch {}
    try {
      const mas = require('../../../services/mediaAutoSync');
      const snap = mas.getAutoSyncProgress?.();
      if (snap) setAutoSync(snap);
    } catch {}
    const handler = (payload) => {
      if (!aliveRef.current) return;
      setAutoSync({ ...(payload || {}) });
      if (payload?.phase === 'done') refreshStats();
    };
    try { ws?.on?.('media_auto_sync_progress', handler); } catch {}
    return () => { try { ws?.off?.('media_auto_sync_progress', handler); } catch {} };
  }, [refreshStats]);

  const onDownloadAll = useCallback(async () => {
    if (busyHistory) return;
    setBusyHistory(true);
    setHistoryProgress(null);
    try {
      const api = require('../../../services/api');
      const { forceFullHistoryDownload } = require('../../../services/fullHistorySync');
      const email = api.getActiveAccountEmail?.() || '';
      await forceFullHistoryDownload(api.apiCall, email, { includeAllMedia: true });
    } catch {}
    setBusyHistory(false);
    refreshStats();
  }, [busyHistory, refreshStats]);

  const onDownloadMissing = useCallback(async () => {
    if (busyMedia) return;
    setBusyMedia(true);
    setMediaProgress({ loaded: 0, total: 0, percent: 0 });
    // Also nudge the background auto-sync — user pressed "Sincronizar agora",
    // so push it past any cellular gate.
    try {
      const mas = require('../../../services/mediaAutoSync');
      mas.nudgeMediaAutoSync?.('settings-manual');
    } catch {}
    try {
      const { downloadMissingMediaOnly } = require('../../../services/fullHistorySync');
      await downloadMissingMediaOnly({
        onProgress: (p) => {
          if (aliveRef.current) setMediaProgress(p);
        },
      });
    } catch {}
    setBusyMedia(false);
    refreshStats();
  }, [busyMedia, refreshStats]);

  if (Platform.OS === 'web') return null;

  const msgsTotal = Number(stats?.msgsTotal || 0);
  const mediaPending = Number(stats?.mediaPending || 0);
  // [#1247] Derived UI state. Priority: live syncing > pending > all-synced.
  const autoSyncing = autoSync?.phase === 'syncing' && (autoSync?.total || 0) > 0;
  const allSynced = mediaPending === 0 && !autoSyncing;

  // [2026-10-08 settings-redesign] grouped list (was ad-hoc rows inside the storage card)
  const syncValue = autoSyncing
    ? `${(autoSync?.loaded || 0).toLocaleString()}/${(autoSync?.total || 0).toLocaleString()}`
    : allSynced
      ? (t('settings.storage.allSynced') || 'Sincronizado')
      : `${mediaPending.toLocaleString()} ${t('settings.storage.pending') || 'pendentes'}`;
  return (
    <SettingsGroup header={t('settings.rd.history') || 'Histórico'}>
      <SettingsRow
        title={t('settings.storage.msgsOnDevice') || 'Mensagens no celular'}
        value={msgsTotal.toLocaleString()}
      />
      <SettingsRow
        title={t('settings.storage.mediaSyncStatus') || 'Mídias'}
        right={autoSyncing ? (
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <ActivityIndicator size="small" color={colors.text} style={{ marginRight: 6 }} />
            <SettingsValueText style={{ fontVariant: ['tabular-nums'] }}>{syncValue}</SettingsValueText>
          </View>
        ) : allSynced ? (
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {/* [2026-10-17 settings-wa] P&B: check na cor do valor (era verde) e mesma fonte do `value` das linhas. */}
            <IconCheck size={16} color={colors.textSecondary} style={{ marginRight: 4 }} />
            <SettingsValueText>{syncValue}</SettingsValueText>
          </View>
        ) : (
          <SettingsValueText style={{ fontVariant: ['tabular-nums'] }}>{syncValue}</SettingsValueText>
        )}
      />
      <SettingsRow
        title={busyHistory
          ? (historyProgress && historyProgress.convTotal
              ? `${t('settings.storage.downloadingMsgs') || 'Baixando histórico…'} ${historyProgress.convDone}/${historyProgress.convTotal}`
              : (t('settings.storage.downloadingMsgs') || 'Baixando histórico…'))
          : (t('settings.storage.downloadAll') || 'Baixar histórico completo')}
        onPress={onDownloadAll}
        disabled={busyHistory}
        chevron={false}
        right={busyHistory ? <ActivityIndicator size="small" color={colors.text} /> : <IconDownload size={18} color={colors.textTertiary} />}
        accessibilityLabel={t('settings.storage.downloadAll')}
      />
      <SettingsRow
        title={busyMedia
          ? (mediaProgress && mediaProgress.total
              ? `${t('settings.storage.downloadingMedia') || 'Baixando mídias…'} ${mediaProgress.loaded}/${mediaProgress.total} (${mediaProgress.percent || 0}%)`
              : (t('settings.storage.downloadingMedia') || 'Baixando mídias…'))
          : (t('settings.storage.syncNow') || 'Sincronizar agora')}
        onPress={onDownloadMissing}
        disabled={busyMedia}
        chevron={false}
        right={busyMedia ? <ActivityIndicator size="small" color={colors.text} /> : <IconRefresh size={18} color={colors.textTertiary} />}
        accessibilityLabel={t('settings.storage.syncNow') || t('settings.storage.downloadMedia')}
      />
    </SettingsGroup>
  );
});
