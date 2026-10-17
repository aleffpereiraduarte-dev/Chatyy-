// [2026-10-15 settings-split] Categoria "Armazenamento e dados": nuvem,
// download automático (settingsCache 'defaults'), roaming/galeria, qualidade
// de envio, chamadas com menos dados e (nativo) uso do aparelho por tipo e
// por conversa, histórico e limpar cache. O scan de armazenamento (pesado)
// só roda com esta categoria aberta (throttle 30 s).
import { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, ActivityIndicator, Platform } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useTheme } from '../../../context/ThemeContext';
import { useLanguage } from '../../../context/LanguageContext';
import { useConfirm } from '../../ConfirmModal';
import * as settingsCache from '../../../services/settingsCache';
import { Shimmer } from '../../SkeletonLoader';
import { IconRefresh } from '../../Icons';
import { SettingsGroup, SettingsRow, SettingsSwitchRow, SettingsPickerRow, SettingsValueText, useGroupedColors } from '../SettingsKit';
import HistoryDownloadGroup from './HistoryDownloadGroup';
import { useSafeNav, useSettingsHost, useChatDefaults, useLocalKeys, setStorage, useSettingsRefresh } from './shared';

const isWeb = Platform.OS === 'web';

function fmtBytes(b) {
  const bytes = Math.max(0, Number(b) || 0);
  if (bytes < 1024) return bytes === 0 ? '0 KB' : '< 1 KB';
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(2) : gb.toFixed(1)} GB`;
}

export default function StorageCategory() {
  const { t } = useLanguage();
  const safeNav = useSafeNav();
  const { registerAnchor } = useSettingsHost();
  const { defaults, updateDefault } = useChatDefaults();

  const [roaming, setRoaming] = useState(false);
  const [lowDataCalls, setLowDataCalls] = useState(false);
  // null = ponte indisponível (web / binário antigo) → vale o AsyncStorage.
  const nativeCallDataSaver = useRef(null);
  const [uploadQuality, setUploadQuality] = useState(() => {
    try { return require('../../../services/mediaUploadQuality').getMediaUploadQuality(); } catch { return 'hd'; }
  });
  useEffect(() => {
    try { return require('../../../services/mediaUploadQuality').onMediaUploadQualityChange(setUploadQuality); } catch { return undefined; }
  }, []);
  // Chamadas: a pref nativa (a mesma do "Economizar dados" da chamada) manda.
  useEffect(() => {
    if (isWeb) return;
    try {
      const ck = require('../../../modules/expo-callkit');
      if (typeof ck.isCallDataSaverAvailable === 'function' && ck.isCallDataSaverAvailable()) {
        const v = !!ck.getCallDataSaver();
        nativeCallDataSaver.current = v;
        setLowDataCalls(v);
        setStorage('chatyy_low_data_calls', String(v));
      }
    } catch {}
  }, []);
  // [2026-10-15 media-visibility] "Salvar na galeria" mudou p/ Conversas (por conta, sincronizado).
  useLocalKeys(['media_auto_dl_roaming', 'chatyy_low_data_calls'], (kv) => {
    if (kv.media_auto_dl_roaming === 'true') setRoaming(true);
    if ((kv.chatyy_low_data_calls === 'true' || kv.chatyy_low_data_calls === '1') && nativeCallDataSaver.current === null) setLowDataCalls(true);
  });

  return (
    <View ref={registerAnchor('mediaAutoDownload')}>
      <SettingsGroup header={t('storageData.cloud')}>
        {/* [2026-10-17 one-merge] Armazenamento = mesma tela do cartão Chatyy One (/settings-one) */}
        <SettingsRow title={t('storage.title')} subtitle="Chatyy One" onPress={() => safeNav('/settings-one')} />
      </SettingsGroup>
      {!isWeb && (
        <>
          <SettingsGroup header={t('settings.mediaAutoDownload')} footer={t('settings.mediaAutoDownloadDesc')}>
            {[
              { key: 'media_auto_dl_photos', label: t('settings.mediaPhotos') },
              { key: 'media_auto_dl_audio', label: t('settings.mediaAudio') },
              { key: 'media_auto_dl_videos', label: t('settings.mediaVideos') },
              { key: 'media_auto_dl_docs', label: t('settings.mediaDocs') },
            ].map((row) => (
              <SettingsPickerRow
                key={row.key}
                title={row.label}
                value={defaults[row.key]}
                sheetTitle={row.label}
                sheetMessage={t('settings.rd.autoDownloadSheet') || 'Baixar automaticamente quando estiver em'}
                cancelLabel={t('common.cancel') || 'Cancelar'}
                options={[
                  { value: 'mobile', label: t('settings.rd.dlWifiMobile') || 'Wi-Fi e dados móveis' },
                  { value: 'wifi', label: t('settings.rd.dlWifi') || 'Só Wi-Fi' },
                  { value: 'never', label: t('settings.mediaNever') || 'Nunca' },
                ]}
                onChange={(v) => updateDefault({ [row.key]: v })}
              />
            ))}
          </SettingsGroup>
          <SettingsGroup>
            <SettingsSwitchRow
              title={t('settings.roaming.title') || 'Permitir em roaming'}
              subtitle={t('settings.roaming.desc') || 'Permite baixar mídia quando estiver em roaming. Desligue pra economizar dados internacionais.'}
              value={roaming}
              onValueChange={(v) => {
                setRoaming(v);
                setStorage('media_auto_dl_roaming', String(v));
                try { require('../../../services/mediaCache').setMediaDownloadPrefs?.({ media_auto_dl_roaming: v }); } catch {}
              }}
            />
          </SettingsGroup>
        </>
      )}

      <SettingsGroup footer={t('settings.mediaUploadQuality.footer') || 'Vale como padrão para vídeos. No modo economia de dados ou em rede fraca, o envio usa a qualidade padrão. Você pode trocar em cada envio pelo botão HD.'}>
        <SettingsPickerRow
          title={t('settings.mediaUploadQuality.title') || 'Qualidade de envio de mídia'}
          value={uploadQuality}
          sheetTitle={t('settings.mediaUploadQuality.title') || 'Qualidade de envio de mídia'}
          cancelLabel={t('common.cancel') || 'Cancelar'}
          options={[
            { value: 'standard', label: t('settings.mediaUploadQuality.standard') || 'Padrão', sub: t('settings.mediaUploadQuality.standardDesc') || 'Envio mais rápido, usa menos dados (720p)' },
            { value: 'hd', label: t('settings.mediaUploadQuality.hd') || 'HD', sub: t('settings.mediaUploadQuality.hdDesc') || 'Melhor qualidade, arquivos até 3x maiores (Full HD 1080p)' },
          ]}
          onChange={(v) => { try { setUploadQuality(require('../../../services/mediaUploadQuality').setMediaUploadQuality(v)); } catch {} }}
        />
      </SettingsGroup>

      <SettingsGroup header={t('settings.rd.calls') || 'Chamadas'}>
        <SettingsSwitchRow
          title={t('settings.lowDataCalls.title') || 'Usar menos dados em chamadas'}
          subtitle={t('settings.lowDataCalls.desc') || 'Limita o vídeo a 360p / 15 fps. Útil em redes lentas ou móveis. Ativa automaticamente em roaming.'}
          value={lowDataCalls}
          onValueChange={(v) => {
            setLowDataCalls(v);
            setStorage('chatyy_low_data_calls', String(v));
            try {
              const ck = require('../../../modules/expo-callkit');
              if (typeof ck.setCallDataSaver === 'function' && ck.setCallDataSaver(v)) nativeCallDataSaver.current = v;
            } catch {}
          }}
        />
      </SettingsGroup>

      {!isWeb && <DeviceStorage />}
    </View>
  );
}

// Uso do aparelho (mediaCache.getStorageStats) — por tipo, por conversa,
// histórico e limpar cache.
function DeviceStorage() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const gc = useGroupedColors();
  const confirm = useConfirm();
  const { registerAnchor } = useSettingsHost();
  const [stats, setStats] = useState(() => settingsCache.peek('storage_stats'));
  const [busy, setBusy] = useState(false);
  const [convNames, setConvNames] = useState({});
  const [showAll, setShowAll] = useState(false);
  const [clearingConv, setClearingConv] = useState(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const refresh = useCallback(async () => {
    try {
      const mc = require('../../../services/mediaCache');
      if (typeof mc.getStorageStats !== 'function') return;
      const st = await mc.getStorageStats();
      if (!alive.current) return;
      setStats(st);
      try { if (st && typeof st === 'object') settingsCache.put('storage_stats', st); } catch {}
      if (st && Array.isArray(st.conversations) && st.conversations.length) {
        try {
          const cc = require('../../../services/chatCache');
          const list = (await cc.getCachedConversations?.()) || [];
          const names = {};
          for (const c of list) {
            if (!c || c.id == null) continue;
            const nm = c.display_name || c.name || c.title || c.other_name || c.peer_name || c.other_email || '';
            if (nm) names[String(c.id)] = String(nm);
          }
          if (alive.current) setConvNames(names);
        } catch {}
      }
    } catch {}
  }, []);
  // Ao abrir e ao voltar de outra tela (throttle 30 s — pickers re-focam a tela).
  const scanAt = useRef(0);
  const maybeScan = useCallback(() => {
    const now = Date.now();
    if (now - scanAt.current > 30000) { scanAt.current = now; refresh(); }
  }, [refresh]);
  useFocusEffect(useCallback(() => { maybeScan(); return undefined; }, [maybeScan]));
  useSettingsRefresh(() => { scanAt.current = Date.now(); refresh(); });

  const fmtCount = (n) => {
    const num = Number(n) || 0;
    const key = num === 1 ? 'settings.storage.itemsSingular' : 'settings.storage.items';
    return (t(key) || `${num} items`).replace('{n}', String(num));
  };
  const s = stats || { totalBytes: 0, cacheBytes: 0, savedBytes: 0, byType: { image: 0, video: 0, audio: 0, document: 0 }, counts: { image: 0, video: 0, audio: 0, document: 0 } };
  const byType = s.byType || {};
  const counts = s.counts || {};
  const mediaTotal = (byType.image || 0) + (byType.video || 0) + (byType.audio || 0) + (byType.document || 0);
  const rows = [
    { key: 'image', label: t('settings.storage.photos'), bytes: byType.image || 0, count: counts.image || 0 },
    { key: 'video', label: t('settings.storage.videos'), bytes: byType.video || 0, count: counts.video || 0 },
    { key: 'audio', label: t('settings.storage.audios'), bytes: byType.audio || 0, count: counts.audio || 0 },
    { key: 'document', label: t('settings.storage.documents'), bytes: byType.document || 0, count: counts.document || 0 },
  ];
  const onClear = async () => {
    const ok = await confirm({
      title: t('settings.storage.clearConfirmTitle'),
      message: t('settings.storage.clearConfirm'),
      confirmLabel: t('settings.storage.clearCache'),
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try { const mc = require('../../../services/mediaCache'); if (typeof mc.clearAllCache === 'function') await mc.clearAllCache(); } catch {}
    await refresh();
    if (alive.current) setBusy(false);
  };
  const onClearConv = async (convId, label) => {
    const ok = await confirm({
      title: t('settings.storage.clearChatConfirmTitle') || 'Limpar mídia desta conversa?',
      message: (label ? label + '\n\n' : '') + (t('settings.storage.clearChatConfirm') || ''),
      confirmLabel: t('settings.storage.clearChatMedia') || 'Limpar mídia',
      destructive: true,
    });
    if (!ok) return;
    setClearingConv(convId);
    try { await require('../../../services/mediaCache').clearConversationLocalMedia?.(convId === '_' ? '_' : convId); } catch {}
    await refresh();
    if (alive.current) setClearingConv(null);
  };
  const conv = Array.isArray(s.conversations) ? s.conversations : [];
  const shown = showAll ? conv : conv.slice(0, 8);

  return (
    <View ref={registerAnchor('storage')}>
      <SettingsGroup header={t('settings.storage.title')}>
        <SettingsRow
          title={t('settings.rd.mediaTotal') || 'Mídia no aparelho'}
          onPress={busy ? undefined : refresh}
          chevron={false}
          accessibilityLabel={t('common.refresh') || 'Atualizar'}
          right={(
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              {stats == null
                ? <Shimmer style={{ width: 64, height: 14, borderRadius: 7, marginRight: 8 }} />
                : <SettingsValueText style={{ marginRight: 8 }}>{fmtBytes(mediaTotal)}</SettingsValueText>}
              {busy ? <ActivityIndicator size="small" color={colors.text} /> : <IconRefresh size={16} color={gc.tertiary} />}
            </View>
          )}
        />
        {rows.map((row) => (
          <SettingsRow key={row.key} title={row.label} subtitle={fmtCount(row.count)} value={fmtBytes(row.bytes)} />
        ))}
        <SettingsRow title={t('settings.storage.appCache')} value={fmtBytes(s.totalBytes)} />
      </SettingsGroup>

      {conv.length > 0 && (
        <SettingsGroup header={t('settings.storage.byChat') || 'Mídia por conversa'} footer={t('settings.storage.byChatFooter')}>
          {shown.map((row) => {
            const cid = String(row.conversationId);
            const label = cid === '_' ? (t('settings.storage.unknownChat') || 'Outras mídias') : (convNames[cid] || ('#' + cid));
            const rowBusy = clearingConv === row.conversationId;
            return (
              <SettingsRow
                key={'cm_' + cid}
                title={label}
                subtitle={`${fmtBytes(row.bytes)} · ${fmtCount(row.count)}`}
                chevron={false}
                accessibilityLabel={`${t('settings.storage.clearChatMedia') || 'Limpar mídia'} ${label}`}
                onPress={rowBusy ? undefined : () => onClearConv(row.conversationId, label)}
                right={rowBusy
                  ? <ActivityIndicator size="small" color={colors.text} />
                  : <SettingsValueText color={gc.destructive}>{t('settings.storage.clearChatMedia') || 'Limpar mídia'}</SettingsValueText>}
              />
            );
          })}
          {!showAll && conv.length > shown.length && (
            <SettingsRow title={(t('settings.storage.showAllChats') || 'Ver todas ({n})').replace('{n}', String(conv.length))} onPress={() => setShowAll(true)} />
          )}
        </SettingsGroup>
      )}

      <HistoryDownloadGroup />

      <SettingsGroup>
        <SettingsRow
          title={busy ? '…' : t('settings.storage.clearCache')}
          destructive
          disabled={busy}
          onPress={onClear}
          accessibilityLabel={t('settings.storage.clearCache')}
        />
      </SettingsGroup>
    </View>
  );
}
