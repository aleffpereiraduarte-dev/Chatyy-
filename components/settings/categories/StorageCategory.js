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
import { IconRefresh, IconImage, IconUser, IconUsers } from '../../Icons';
import { useSettingsCollector } from '../nativeCollect'; // [2026-10-18 settings-sub-native-2]
import AvatarCircle from '../../AvatarCircle';
import { SettingsGroup, SettingsRow, SettingsSwitchRow, SettingsPickerRow, SettingsValueText, SettingsCardContent, useGroupedColors } from '../SettingsKit';
import StorageMeter, { StorageNudgeCard } from '../../storage/StorageMeter'; // [2026-10-17 smart-storage]
import { PLAN_NAME } from '../../../services/brandPlan';
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
  // [2026-10-19 media-quality] { wifi, cell } por conta: Padrão / HD / Full HD.
  const [uploadQuality, setUploadQuality] = useState(() => {
    try { return require('../../../services/mediaUploadQuality').getUploadQualityPrefs(); } catch { return { wifi: 'hd', cell: 'standard' }; }
  });
  useEffect(() => {
    try { return require('../../../services/mediaUploadQuality').onUploadQualityChange(setUploadQuality); } catch { return undefined; }
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

  const collecting = !!useSettingsCollector();
  const cloud = (
    <>
      <SettingsGroup header={t('storageData.cloud')}>
        {/* [2026-10-17 one-merge] Armazenamento = mesma tela do cartão Chatyy One (/settings-one) */}
        <SettingsRow title={t('storage.title')} subtitle={PLAN_NAME} onPress={() => safeNav('/settings-one')} />
        {/* [2026-10-17 smart-storage] medidor de uso da nuvem (por tipo) + Gerenciar armazenamento */}
        <SettingsCardContent style={{ paddingTop: 4, paddingBottom: 14 }}>
          <StorageMeter legend="dots" onPress={() => safeNav('/settings-one')} testID="storage-cat-meter" />
        </SettingsCardContent>
        <SettingsRow title={t('manageStorage.title')} subtitle={t('manageStorage.rowSub')} onPress={() => safeNav('/manage-storage')} testID="storage-cat-manage" />
      </SettingsGroup>
      <StorageNudgeCard style={{ marginHorizontal: collecting ? 0 : 16, marginBottom: 24 }} testID="storage-cat-nudge" />
    </>
  );

  return (
    <View ref={registerAnchor('mediaAutoDownload')}>
      {/* [2026-10-18 settings-sub-native-2] Lista nativa: o cartão da nuvem (medidor
          JS + aviso de espaço) vai no slot do header, igual à tela JS. */}
      {collecting ? <SettingsGroup nativeHeader nativeHeaderBare>{cloud}</SettingsGroup> : cloud}
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

      <SettingsGroup
        header={t('settings.mediaUploadQuality.title') || 'Qualidade de envio de mídia'}
        footer={t('settings.mediaUploadQuality.footer2') || 'Padrão: fotos até 1600 px e vídeos 720p. HD: fotos até 2560 px e vídeos 1080p. Full HD: fotos na resolução original e vídeos 1080p em alta qualidade. Com a economia de dados ligada ou em rede fraca, o envio usa Padrão. Você pode trocar em cada envio pelo botão HD.'}
      >
        {[
          { col: 'wifi', title: t('settings.mediaUploadQuality.wifi') || 'No Wi-Fi' },
          { col: 'cell', title: t('settings.mediaUploadQuality.cell') || 'Nos dados móveis' },
        ].map(({ col, title }) => (
          <SettingsPickerRow
            key={col}
            title={title}
            value={uploadQuality?.[col] || (col === 'wifi' ? 'hd' : 'standard')}
            sheetTitle={title}
            cancelLabel={t('common.cancel') || 'Cancelar'}
            options={[
              { value: 'standard', label: t('settings.mediaUploadQuality.standard') || 'Padrão', sub: t('settings.mediaUploadQuality.standardDesc2') || 'Envio mais rápido, usa menos dados (fotos 1600 px, vídeo 720p)' },
              { value: 'hd', label: t('settings.mediaUploadQuality.hd') || 'HD', sub: t('settings.mediaUploadQuality.hdDesc2') || 'Mais nítido, arquivos até 4x maiores (fotos 2560 px, vídeo 1080p)' },
              { value: 'full', label: t('settings.mediaUploadQuality.full') || 'Full HD', sub: t('settings.mediaUploadQuality.fullDesc') || 'Fotos na resolução original, vídeo 1080p em alta qualidade (arquivos bem maiores)' },
            ]}
            onChange={(v) => { try { setUploadQuality(require('../../../services/mediaUploadQuality').setUploadQualityPref(col, v)); } catch {} }}
          />
        ))}
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
  const collecting = !!useSettingsCollector();
  const [stats, setStats] = useState(() => settingsCache.peek('storage_stats'));
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [clearingConv, setClearingConv] = useState(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // [2026-10-18 storage-names] Nome + avatar de cada conversa SÍNCRONOS no 1º
  // frame (cache local da lista + último nome resolvido salvo), com a mesma
  // regra da lista de conversas (apelido > agenda > perfil > e-mail formatado).
  // Nunca "#id": até o cache completo responder → shimmer; sem nada → "Conversa".
  const syncIdx = useRef(null);
  if (syncIdx.current === null) {
    try { syncIdx.current = require('../../../services/convDisplay').convIndexSync(); } catch { syncIdx.current = new Map(); }
  }
  const persistedNames = useRef(null);
  if (persistedNames.current === null) {
    let v = null;
    try { v = settingsCache.peek('storage_conv_names'); } catch {}
    persistedNames.current = (v && typeof v === 'object') ? v : {};
  }
  const [fullIdx, setFullIdx] = useState(null);
  const [agenda, setAgenda] = useState(null);
  const [namesSettled, setNamesSettled] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const cd = require('../../../services/convDisplay');
        const [idx, ag] = await Promise.all([cd.convIndexAsync(syncIdx.current), cd.agendaNamesAsync()]);
        if (!alive.current) return;
        setFullIdx(idx);
        if (ag && ag.size) setAgenda(ag);
      } catch {}
      if (alive.current) setNamesSettled(true);
    })();
  }, []);
  const resolveConv = useCallback((cid) => {
    const p = persistedNames.current[cid];
    // Antes da agenda/cache completo responderem, o último nome RESOLVIDO salvo
    // (já com agenda) vence — sem trocar "Ana Carla Pereira Ramos" → "Ana Carla".
    if (!namesSettled && p && p.n) return { title: String(p.n), email: p.e || null, uri: p.u || '', members: undefined, isGroup: !!p.g };
    const c = (fullIdx && fullIdx.get(cid)) || syncIdx.current.get(cid);
    if (c) {
      try {
        const d = require('../../../services/convDisplay').convDisplay(c, { t, agenda });
        if (d && d.title) return d;
      } catch {}
    }
    if (p && p.n) return { title: String(p.n), email: p.e || null, uri: p.u || '', members: undefined, isGroup: !!p.g };
    return null;
  }, [fullIdx, agenda, t, namesSettled]);

  const refresh = useCallback(async () => {
    try {
      const mc = require('../../../services/mediaCache');
      if (typeof mc.getStorageStats !== 'function') return;
      const st = await mc.getStorageStats();
      if (!alive.current) return;
      setStats(st);
      try { if (st && typeof st === 'object') settingsCache.put('storage_stats', st); } catch {}
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

  // Salva o último nome/avatar resolvido (próxima abertura já pinta o nome certo).
  const convKey = conv.map((r) => String(r.conversationId)).join(',');
  useEffect(() => {
    if (!namesSettled || !convKey) return;
    try {
      const next = {};
      for (const cid of convKey.split(',')) {
        if (!cid || cid === '_') continue;
        const d = resolveConv(cid);
        if (d && d.title) next[cid] = { n: d.title, e: d.email || '', u: d.uri || '', g: d.isGroup ? 1 : 0 };
      }
      const prev = persistedNames.current || {};
      const same = Object.keys(next).length === Object.keys(prev).length
        && Object.keys(next).every((k) => prev[k] && prev[k].n === next[k].n && prev[k].e === next[k].e && prev[k].u === next[k].u);
      if (!same) { persistedNames.current = next; settingsCache.put('storage_conv_names', next); }
    } catch {}
  }, [namesSettled, convKey, resolveConv]);

  return (
    <View ref={registerAnchor('storage')}>
      <SettingsGroup header={t('settings.storage.title')}>
        <SettingsRow
          title={t('settings.rd.mediaTotal') || 'Mídia no aparelho'}
          onPress={busy ? undefined : refresh}
          chevron={false}
          accessibilityLabel={t('common.refresh') || 'Atualizar'}
          native={collecting ? { val: stats == null ? '…' : fmtBytes(mediaTotal), acc: busy ? 's' : 'n' } : undefined}
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
            const other = cid === '_';
            const info = other ? null : resolveConv(cid);
            const pending = !other && !info && !namesSettled;
            const label = other
              ? (t('settings.storage.unknownChat') || 'Outras mídias')
              : ((info && info.title) || (pending ? '' : (t('settings.storage.chatFallback') || 'Conversa')));
            const rowBusy = clearingConv === row.conversationId;
            const avatar = other
              ? (
                <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: gc.chipBg, alignItems: 'center', justifyContent: 'center' }}>
                  <IconImage size={17} color={gc.chipFg} />
                </View>
              )
              : (info
                ? <AvatarCircle name={info.title} email={info.email || undefined} uri={info.uri || undefined} members={info.members} size={34} />
                : <Shimmer style={{ width: 34, height: 34, borderRadius: 17 }} />);
            if (collecting) {
              // Nativo: ícone no lugar do avatar; "Limpar mídia" em vermelho (api ≥ 4).
              return (
                <SettingsRow
                  key={'cm_' + cid}
                  icon={other ? IconImage : (info && info.isGroup ? IconUsers : IconUser)}
                  title={pending ? '…' : label}
                  subtitle={`${fmtBytes(row.bytes)} · ${fmtCount(row.count)}`}
                  chevron={false}
                  onPress={rowBusy ? undefined : () => onClearConv(row.conversationId, label)}
                  native={{ val: rowBusy ? '' : (t('settings.storage.clearChatMedia') || 'Limpar mídia'), acc: rowBusy ? 's' : 'n', vd: true }}
                />
              );
            }
            return (
              <SettingsRow
                key={'cm_' + cid}
                left={avatar}
                title={pending ? ' ' : label}
                subtitle={`${fmtBytes(row.bytes)} · ${fmtCount(row.count)}`}
                chevron={false}
                accessibilityLabel={`${t('settings.storage.clearChatMedia') || 'Limpar mídia'} ${label}`}
                onPress={rowBusy ? undefined : () => onClearConv(row.conversationId, label)}
                right={rowBusy
                  ? <ActivityIndicator size="small" color={colors.text} />
                  : <SettingsValueText color={gc.destructive}>{t('settings.storage.clearChatMedia') || 'Limpar mídia'}</SettingsValueText>}
              >
                {pending ? <Shimmer style={{ position: 'absolute', left: 0, top: 4, width: 132, height: 13, borderRadius: 6 }} /> : null}
              </SettingsRow>
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
