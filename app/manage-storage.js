// [2026-10-17 smart-storage] /manage-storage — "Gerenciar armazenamento"
// (estilo Google One / WhatsApp): medidor por tipo, itens grandes, vídeos
// grandes e atalhos para liberar espaço (fotos já no backup → apagar do
// aparelho em Fotos; cache de mídia do aparelho em Armazenamento e dados).
//
// Dados: drive_list_all (já existente, o mesmo do seletor de anexos do Drive)
// → ordena por tamanho NO APARELHO. Mover para a lixeira = drive_delete
// (restaurável; a lixeira não conta no espaço — updateStorageUsage ignora
// is_trashed). Backend ideal p/ contas enormes: ver relatório (drive_largest).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ActivityIndicator, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useLanguage } from '../context/LanguageContext';
import { useResponsive } from '../utils/responsive';
import { useConfirm } from '../components/ConfirmModal';
import * as api from '../services/api';
import { invalidatePlanState, loadPlanState, usePlanState } from '../services/planState';
import { SettingsScreen, SettingsGroup, SettingsRow, SettingsCardContent, SettingsValueText, useGroupedColors } from '../components/settings/SettingsKit';
import StorageMeter, { meterFromPlan, saveDriveSplit, fmtBytes } from '../components/storage/StorageMeter';
import { IconFilm, IconFile, IconImage, IconSmartphone, IconTrash, IconZap } from '../components/Icons';
import { MONETIZATION_ENABLED } from '../constants/featureFlags';
import { recommendTier, formatGbShort, offerHref } from '../services/storageOffers';

const MIN_BIG = 5 * 1024 * 1024; // abaixo de 5 MB não é "item grande"
const LIST_MAX = 15;

function fmtDate(iso, language) {
  if (!iso) return '';
  const d = new Date(String(iso).replace(' ', 'T'));
  if (isNaN(d.getTime())) return '';
  try { return d.toLocaleDateString(language || undefined, { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return d.toISOString().slice(0, 10); }
}

export default function ManageStorageScreen() {
  const { t, language } = useLanguage();
  const g = useGroupedColors();
  const router = useRouter();
  const confirm = useConfirm();
  const { contentMaxWidth } = useResponsive();
  const { plan, refresh } = usePlanState();
  const [files, setFiles] = useState(null); // null = carregando
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [showAll, setShowAll] = useState({ video: false, file: false });
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const r = await api.fileListAll();
      const list = Array.isArray(r?.data?.files) ? r.data.files : (Array.isArray(r?.files) ? r.files : null);
      if (!alive.current) return;
      if (!list) { setFailed(true); setFiles([]); return; }
      setFiles(list.filter((f) => f && !f.is_folder && !f.is_trashed && (Number(f.size) || 0) > 0));
    } catch {
      if (alive.current) { setFailed(true); setFiles([]); }
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const { videos, others, split } = useMemo(() => {
    const out = { videos: [], others: [], split: { photos: 0, videos: 0, files: 0 } };
    for (const f of files || []) {
      const size = Number(f.size) || 0;
      const mt = String(f.media_type || '');
      const mime = String(f.mime_type || '');
      const isVid = mt === 'video' || mime.startsWith('video/');
      const isImg = !isVid && (mt === 'photo' || mt === 'image' || mime.startsWith('image/'));
      if (isVid) out.split.videos += size; else if (isImg) out.split.photos += size; else out.split.files += size;
      if (size < MIN_BIG) continue;
      (isVid ? out.videos : out.others).push(f);
    }
    out.videos.sort((a, b) => b.size - a.size);
    out.others.sort((a, b) => b.size - a.size);
    return out;
  }, [files]);
  // Fração por tipo → o medidor das outras telas passa a mostrar Fotos/Vídeos/Arquivos.
  useEffect(() => { if (files && files.length) saveDriveSplit(split); }, [files, split]);

  const trash = async (f) => {
    if (busyId) return;
    const ok = await confirm({
      title: t('manageStorage.trashTitle'),
      message: `${f.name || ''}\n${fmtBytes(f.size)}\n\n${t('manageStorage.trashBody')}`,
      confirmLabel: t('manageStorage.trashConfirm'),
      destructive: true,
    });
    if (!ok) return;
    setBusyId(f.id);
    try {
      const r = await api.fileDelete(f.id);
      if (r?.success !== false && alive.current) {
        setFiles((prev) => (prev || []).filter((x) => x.id !== f.id));
        invalidatePlanState();
        loadPlanState({ force: true }).catch(() => {});
        refresh?.(true);
      }
    } catch {}
    if (alive.current) setBusyId(null);
  };

  const meter = meterFromPlan(plan);
  const rec = MONETIZATION_ENABLED ? recommendTier(plan) : null;
  const nativeApp = Platform.OS !== 'web';

  const renderList = (kind, list, Icon) => {
    const expanded = showAll[kind];
    const shown = expanded ? list : list.slice(0, LIST_MAX);
    return (
      <>
        {shown.map((f) => {
          const busy = busyId === f.id;
          const date = fmtDate(f.created_at || f.updated_at, language);
          return (
            <SettingsRow
              key={kind + f.id}
              icon={Icon}
              title={f.name || f.original_name || '—'}
              subtitle={date ? `${fmtBytes(f.size)} · ${date}` : fmtBytes(f.size)}
              chevron={false}
              onPress={busy ? undefined : () => trash(f)}
              accessibilityLabel={`${t('manageStorage.trashConfirm')} ${f.name || ''}`}
              right={busy ? <ActivityIndicator size="small" color={g.secondary} /> : <IconTrash size={18} color={g.secondary} />}
              testID={`manage-${kind}-${f.id}`}
            />
          );
        })}
        {!expanded && list.length > shown.length ? (
          <SettingsRow
            title={t('manageStorage.showAll', { n: String(list.length) })}
            onPress={() => setShowAll((s) => ({ ...s, [kind]: true }))}
          />
        ) : null}
      </>
    );
  };

  return (
    <SettingsScreen title={t('manageStorage.title')} contentStyle={{ maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' }} testID="manage-storage">
      <SettingsGroup>
        <SettingsCardContent style={{ paddingVertical: 16 }}>
          {meter ? <StorageMeter meter={meter} legend="rows" /> : <ActivityIndicator color={g.secondary} />}
        </SettingsCardContent>
        {rec ? (
          <SettingsRow
            icon={IconZap}
            title={t('storageOffer.getSize', { size: formatGbShort(rec.tier.bytes) })}
            subtitle={rec.tier.priceLabel ? t('storageOffer.perMonth', { price: rec.tier.priceLabel }) : undefined}
            onPress={() => { try { router.push(offerHref(rec.tier.id)); } catch {} }}
            testID="manage-upgrade"
          />
        ) : null}
      </SettingsGroup>

      {nativeApp ? (
        <SettingsGroup header={t('manageStorage.deviceHeader')} footer={t('manageStorage.deviceFooter')}>
          <SettingsRow
            icon={IconImage}
            title={t('manageStorage.backedUpTitle')}
            subtitle={t('manageStorage.backedUpSub')}
            onPress={() => { try { router.push({ pathname: '/photos', params: { tab: 'backup' } }); } catch {} }}
            testID="manage-backed-up"
          />
          <SettingsRow
            icon={IconSmartphone}
            title={t('manageStorage.deviceCache')}
            onPress={() => { try { router.push({ pathname: '/settings-section', params: { section: 'storage_data', anchor: 'storage' } }); } catch {} }}
            testID="manage-device-cache"
          />
        </SettingsGroup>
      ) : null}

      {files == null ? (
        <View style={{ paddingVertical: 28, alignItems: 'center' }}><ActivityIndicator color={g.secondary} /></View>
      ) : (
        <>
          {failed ? (
            <SettingsGroup>
              <SettingsRow title={t('manageStorage.loadFailed')} onPress={() => { setFiles(null); load(); }} />
            </SettingsGroup>
          ) : null}
          {videos.length ? (
            <SettingsGroup header={t('manageStorage.bigVideos')} footer={t('manageStorage.trashFooter')}>
              {renderList('video', videos, IconFilm)}
            </SettingsGroup>
          ) : null}
          {others.length ? (
            <SettingsGroup header={t('manageStorage.bigItems')} footer={videos.length ? undefined : t('manageStorage.trashFooter')}>
              {renderList('file', others, IconFile)}
            </SettingsGroup>
          ) : null}
          {!failed && !videos.length && !others.length ? (
            <SettingsGroup>
              <SettingsRow title={t('manageStorage.nothingBig')} chevron={false} />
            </SettingsGroup>
          ) : null}
          <SettingsGroup>
            <SettingsRow
              title={t('manageStorage.openFiles')}
              right={<SettingsValueText>{files.length ? String(files.length) : ''}</SettingsValueText>}
              onPress={() => { try { router.push('/files'); } catch {} }}
            />
          </SettingsGroup>
        </>
      )}
    </SettingsScreen>
  );
}
