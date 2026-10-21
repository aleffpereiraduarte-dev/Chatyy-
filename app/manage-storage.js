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
import { View, Text, ActivityIndicator, Platform, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';
import { useLanguage } from '../context/LanguageContext';
import { useResponsive } from '../utils/responsive';
import { useConfirm } from '../components/ConfirmModal';
import * as api from '../services/api';
import { invalidatePlanState, loadPlanState, usePlanState } from '../services/planState';
import { SettingsScreen, SettingsGroup, SettingsRow, SettingsCardContent, SettingsValueText, useGroupedColors } from '../components/settings/SettingsKit';
import StorageMeter, { meterFromPlan, saveDriveSplit, fmtBytes } from '../components/storage/StorageMeter';
import { IconFilm, IconFile, IconImage, IconSmartphone, IconTrash, IconZap, IconPlay, IconCheck } from '../components/Icons';
import FileViewer from '../components/FileViewer';
import { absoluteFileUrl } from '../components/NativeDocPreview';
import { MONETIZATION_ENABLED } from '../constants/featureFlags';
import { recommendTier, formatGbShort, offerHref } from '../services/storageOffers';

const MIN_BIG = 5 * 1024 * 1024; // abaixo de 5 MB não é "item grande"
const LIST_MAX = 15;
const NATIVE = Platform.OS === 'ios' || Platform.OS === 'android';

function tt(t, k, fb, p) {
  try { const v = t(k, p); if (v && v !== k) return v; } catch {}
  if (!p) return fb;
  return String(fb).replace(/\{(\w+)\}/g, (_, n) => (p[n] != null ? String(p[n]) : ''));
}

// ── Título humano ────────────────────────────────────────────────────────
// "9b0bc01d_ScreenRecording_09-29-2026 20-27-45_1.mp4" → "Gravação de tela"
// "IMG_6326_9d2b1252d0.MOV" → "IMG_6326". A data vai no subtítulo.
const _isHash = (x) => x.length >= 8 && /^[0-9a-f]+$/i.test(x) && /[a-f]/i.test(x) && /\d/.test(x);
function humanTitle(f, t) {
  const raw = String(f?.name || f?.original_name || '').trim();
  if (!raw) return '—';
  let base = raw.replace(/\.[a-z0-9]{2,5}$/i, '');
  const parts = base.split(/[_-]/);
  if (parts.length > 1 && _isHash(parts[0])) base = base.slice(parts[0].length + 1);
  const p2 = base.split(/[_-]/);
  if (p2.length > 1 && _isHash(p2[p2.length - 1])) base = base.slice(0, base.length - p2[p2.length - 1].length - 1);
  if (/^(ScreenRecording|Screen Recording|RPReplay|Gravação de Tela|Grabación de pantalla)/i.test(base)) {
    return tt(t, 'manageStorage.screenRecording', 'Gravação de tela');
  }
  base = base.trim();
  return base || raw;
}

// Data "de verdade" do vídeo: a do nome (gravação de tela / câmera), senão a do upload.
function takenDate(f) {
  const n = String(f?.name || '');
  let m = n.match(/(\d{2})-(\d{2})-(\d{4})[ _](\d{2})-(\d{2})-(\d{2})/);
  if (m) {
    let mo = +m[1], d = +m[2];
    if (mo > 12 && d <= 12) { const x = mo; mo = d; d = x; }
    const dt = new Date(+m[3], mo - 1, d, +m[4], +m[5], +m[6]);
    if (!isNaN(dt.getTime()) && mo >= 1 && mo <= 12) return { d: dt, time: true };
  }
  m = n.match(/(20\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})/);
  if (m) {
    const dt = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    if (!isNaN(dt.getTime()) && +m[2] >= 1 && +m[2] <= 12) return { d: dt, time: true };
  }
  const iso = f?.created_at || f?.updated_at;
  if (!iso) return null;
  const dt = new Date(String(iso).replace(' ', 'T'));
  return isNaN(dt.getTime()) ? null : { d: dt, time: false };
}

function fmtTaken(f, language) {
  const td = takenDate(f);
  if (!td) return '';
  const opts = { day: '2-digit', month: 'short', year: 'numeric', ...(td.time ? { hour: '2-digit', minute: '2-digit' } : {}) };
  try { return td.d.toLocaleString(language || undefined, opts); } catch { return td.d.toISOString().slice(0, 10); }
}

function fmtDur(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

const VID_URL_RE = /\.(mov|mp4|m4v|webm|3gp|mkv|avi)$/i;
function isVideoFile(f) {
  const mt = String(f?.media_type || '');
  const mime = String(f?.mime_type || '');
  return mt === 'video' || mime.startsWith('video/') || f?.icon_type === 'video';
}
function isImageFile(f) {
  const mt = String(f?.media_type || '');
  const mime = String(f?.mime_type || '');
  return !isVideoFile(f) && (mt === 'photo' || mt === 'image' || mime.startsWith('image/') || f?.icon_type === 'image');
}
// URL tocável do arquivo (CDN assinada; senão drive_download c/ token, como em Arquivos).
function playUrl(f) {
  if (!f) return '';
  if (f.cdn_url) return absoluteFileUrl(f.cdn_url);
  return api.fileDownloadUrl(f.id);
}
// Pôster REAL do servidor (thumbnail gerado). O backend devolve o próprio vídeo
// em thumbnail_url quando não há pôster — isso não serve de imagem.
function serverPoster(f) {
  const tu = f?.thumbnail_url;
  if (!tu || typeof tu !== 'string') return null;
  if (tu === f.cdn_url || tu === f.stream_url) return null;
  const path = tu.split('?')[0];
  if (isVideoFile(f) && VID_URL_RE.test(path)) return null;
  if (/^\/api\//.test(tu)) return null; // proxy local de thumb não existe no roteador
  return absoluteFileUrl(tu);
}

// ── Miniatura + duração dos vídeos sem pôster (1 por vez, cache por id) ──────
// Kill switches (OTA/console): __chatyy_storage_vthumb=false (sem 1º frame),
// __chatyy_storage_vinfo=false (sem duração).
const META_KEY = 'manage_storage_vmeta_v1';
const _meta = new Map(); // id → { f?: 'file://…', d?: ms, x?: tentou }
const _mem = new Map(); // id → src não persistível (expo-video VideoThumbnail)
const _subs = new Set();
const _queue = [];
let _busy = false;
let _hydrated = false;
let _persistT = null;
let _infoDead = false;
function _mmkv() { try { return require('../services/mmkv'); } catch { return null; } }
function _hydrate() {
  if (_hydrated) return;
  _hydrated = true;
  try {
    const o = _mmkv()?.getJSON?.(META_KEY);
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object') _meta.set(k, { f: v.f, d: v.d });
  } catch {}
}
function _persist() {
  if (_persistT) return;
  _persistT = setTimeout(() => {
    _persistT = null;
    try {
      const o = {};
      let n = 0;
      for (const [k, v] of Array.from(_meta.entries()).slice(-200)) { if (v.f || v.d) { o[k] = { f: v.f, d: v.d }; n++; } }
      if (n) _mmkv()?.setJSON?.(META_KEY, o);
    } catch {}
  }, 800);
}
function _on(k) { try { return globalThis[k] !== false; } catch { return true; } }
function _withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}
async function _work(f) {
  const id = String(f.id);
  const cur = { ...(_meta.get(id) || {}) };
  const url = playUrl(f);
  if (!url) return;
  if (!cur.f && !serverPoster(f) && _on('__chatyy_storage_vthumb')) {
    try {
      const vff = require('../services/videoFirstFrame');
      if (vff?.isVideoFirstFrameOn?.()) {
        const file = await _withTimeout(vff.requestVideoFirstFrame(url), 20000);
        if (file) cur.f = file;
      }
    } catch {}
    if (!cur.f && !_mem.has(id)) {
      // reserva: expo-video (frame em memória, não persiste)
      let player = null;
      try {
        const mod = require('expo-video');
        if (mod?.createVideoPlayer) {
          player = mod.createVideoPlayer(url);
          try { player.muted = true; } catch {}
          if (typeof player.generateThumbnailsAsync === 'function') {
            const r = await _withTimeout(player.generateThumbnailsAsync([0.5], { maxWidth: 240, maxHeight: 240 }), 12000);
            if (Array.isArray(r) && r[0]) _mem.set(id, r[0]);
          }
        }
      } catch {}
      finally { try { player?.release?.(); } catch {} }
    }
  }
  // Android: MediaMetadataRetriever remoto só é confiável quando o 1º frame saiu
  // (binário com o fix de setDataSource); 1 timeout desliga a sonda na sessão.
  if (!cur.d && !_infoDead && _on('__chatyy_storage_vinfo') && (Platform.OS !== 'android' || cur.f)) {
    try {
      const NVm = require('../modules/expo-native-video');
      const NV = NVm?.default || NVm;
      if (NV && typeof NV.isAvailable === 'function' && NV.isAvailable() && typeof NV.getInfo === 'function') {
        const info = await _withTimeout(NV.getInfo(url), 12000);
        const d = Number(info?.durationMs) || 0;
        if (d > 0 && d < 48 * 3600 * 1000) cur.d = d;
      }
    } catch (e) { if (String(e?.message || '') === 'timeout') _infoDead = true; }
  }
  cur.x = true;
  _meta.set(id, cur);
  _persist();
  _subs.forEach((fn) => { try { fn(id); } catch {} });
}
async function _pump() {
  if (_busy) return;
  _busy = true;
  try {
    while (_queue.length) {
      const f = _queue.shift();
      // eslint-disable-next-line no-await-in-loop
      try { await _work(f); } catch {}
    }
  } finally { _busy = false; }
}
function requestVideoMeta(f) {
  if (!NATIVE || !f || f.id == null || f.unavailable) return;
  _hydrate();
  const id = String(f.id);
  const m = _meta.get(id);
  if (m && (m.x || (m.d && (m.f || serverPoster(f))))) return;
  if (_queue.some((q) => String(q.id) === id)) return;
  _queue.push(f);
  _pump();
}
function useVideoMeta(f) {
  const id = f && f.id != null ? String(f.id) : '';
  const read = () => { _hydrate(); return { ...(_meta.get(id) || {}), mem: _mem.get(id) || null }; };
  const [m, setM] = useState(read);
  useEffect(() => {
    if (!id) return undefined;
    const fn = (k) => { if (k === id) setM(read()); };
    _subs.add(fn);
    if (isVideoFile(f)) requestVideoMeta(f);
    return () => { _subs.delete(fn); };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return m;
}

function Thumb({ f, g, video }) {
  const meta = useVideoMeta(video ? f : null);
  const [posterFailed, setPosterFailed] = useState(false);
  const [frameFailed, setFrameFailed] = useState(false);
  const poster = posterFailed ? null : (video ? serverPoster(f) : (f.thumbnail_url ? absoluteFileUrl(f.thumbnail_url) : (f.cdn_url ? absoluteFileUrl(f.cdn_url) : null)));
  let src = null;
  if (poster) src = { uri: poster };
  else if (video && meta.f && !frameFailed) src = { uri: meta.f };
  else if (video && meta.mem) src = meta.mem;
  const dur = video ? fmtDur(meta.d) : '';
  return (
    <View style={[s.thumb, { backgroundColor: g.fill }]}>
      {src ? (
        <ExpoImage
          source={src}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          recyclingKey={String(f.id)}
          transition={140}
          onError={() => { if (poster) setPosterFailed(true); else setFrameFailed(true); }}
          accessible={false}
        />
      ) : (
        video ? <IconFilm size={20} color={g.secondary} /> : <IconImage size={20} color={g.secondary} />
      )}
      {video ? (
        dur ? (
          <View style={s.durPill}><Text style={s.durText} numberOfLines={1}>{dur}</Text></View>
        ) : src ? (
          <View style={s.playDot}><IconPlay size={9} color="#FFFFFF" /></View>
        ) : null
      ) : null}
    </View>
  );
}

function SelectCircle({ on, g }) {
  return (
    <View style={[s.selCircle, on ? { backgroundColor: g.ink, borderColor: g.ink } : { borderColor: g.tertiary }]}>
      {on ? <IconCheck size={14} color={g.onInk} strokeWidth={2.6} /> : null}
    </View>
  );
}

export default function ManageStorageScreen() {
  const { t, language } = useLanguage();
  const g = useGroupedColors();
  const router = useRouter();
  const confirm = useConfirm();
  const insets = useSafeAreaInsets();
  const { contentMaxWidth } = useResponsive();
  const { plan, refresh } = usePlanState();
  const [files, setFiles] = useState(null); // null = carregando
  const [failed, setFailed] = useState(false);
  const [busyIds, setBusyIds] = useState(() => new Set());
  const [showAll, setShowAll] = useState({ video: false, file: false });
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [viewer, setViewer] = useState(null); // { file, list }
  const [note, setNote] = useState(null);
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
      const isVid = isVideoFile(f);
      const isImg = !isVid && isImageFile(f);
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

  const afterTrash = (ids) => {
    if (!ids.length || !alive.current) return;
    const gone = new Set(ids.map(String));
    setFiles((prev) => (prev || []).filter((x) => !gone.has(String(x.id))));
    invalidatePlanState();
    loadPlanState({ force: true }).catch(() => {});
    try { refresh?.(true); } catch {}
  };
  const markBusy = (ids, on) => setBusyIds((prev) => {
    const n = new Set(prev);
    ids.forEach((id) => (on ? n.add(String(id)) : n.delete(String(id))));
    return n;
  });

  const trash = async (f) => {
    if (busyIds.has(String(f.id))) return;
    const ok = await confirm({
      title: t('manageStorage.trashTitle'),
      message: `${humanTitle(f, t)}\n${fmtBytes(f.size)}\n\n${t('manageStorage.trashBody')}`,
      confirmLabel: t('manageStorage.trashConfirm'),
      destructive: true,
    });
    if (!ok) return;
    markBusy([f.id], true);
    try {
      const r = await api.fileDelete(f.id);
      if (r?.success !== false) afterTrash([f.id]);
      else if (alive.current) setNote(tt(t, 'manageStorage.trashPartial', 'Alguns itens não puderam ser movidos. Tente de novo.'));
    } catch {
      if (alive.current) setNote(tt(t, 'manageStorage.trashPartial', 'Alguns itens não puderam ser movidos. Tente de novo.'));
    }
    if (alive.current) markBusy([f.id], false);
  };

  const allBig = useMemo(() => [...videos, ...others], [videos, others]);
  const selItems = useMemo(() => allBig.filter((f) => selected.has(String(f.id))), [allBig, selected]);
  const selBytes = selItems.reduce((a, f) => a + (Number(f.size) || 0), 0);

  const trashSelected = async () => {
    const items = selItems;
    if (!items.length) return;
    const n = items.length;
    const ok = await confirm({
      title: n === 1 ? t('manageStorage.trashTitle') : tt(t, 'manageStorage.trashManyTitle', 'Mover {n} itens para a lixeira?', { n: String(n) }),
      message: `${fmtBytes(selBytes)}\n\n${t('manageStorage.trashBody')}`,
      confirmLabel: t('manageStorage.trashConfirm'),
      destructive: true,
    });
    if (!ok) return;
    const ids = items.map((f) => f.id);
    markBusy(ids, true);
    const done = [];
    for (const f of items) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await api.fileDelete(f.id);
        if (r?.success !== false) done.push(f.id);
      } catch {}
    }
    if (!alive.current) return;
    markBusy(ids, false);
    afterTrash(done);
    setSelected(new Set());
    if (done.length < ids.length) setNote(tt(t, 'manageStorage.trashPartial', 'Alguns itens não puderam ser movidos. Tente de novo.'));
    else { setNote(null); setSelecting(false); }
  };

  const toggleSel = (f) => setSelected((prev) => {
    const n = new Set(prev);
    const k = String(f.id);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });
  const exitSelect = () => { setSelecting(false); setSelected(new Set()); };

  const meter = meterFromPlan(plan);
  const rec = MONETIZATION_ENABLED ? recommendTier(plan) : null;
  const nativeApp = Platform.OS !== 'web';
  const hasBig = allBig.length > 0;

  const headerRight = useCallback(() => (hasBig ? (
    <Pressable
      onPress={() => (selecting ? exitSelect() : setSelecting(true))}
      hitSlop={10}
      accessibilityRole="button"
      style={({ pressed }) => [s.hdrBtn, pressed && { opacity: 0.5 }]}
      testID="manage-select-toggle"
    >
      <Text style={[s.hdrBtnText, { color: g.ink }, selecting && { fontWeight: '600' }]}>
        {selecting ? tt(t, 'manageStorage.cancel', 'Cancelar') : tt(t, 'manageStorage.select', 'Selecionar')}
      </Text>
    </Pressable>
  ) : null), [hasBig, selecting, g.ink, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const openItem = (f, list) => {
    if (selecting) { toggleSel(f); return; }
    // Kill switch OTA: __chatyy_storage_preview=false → toque volta a ser "mover p/ lixeira".
    let previewOn = true;
    try { previewOn = globalThis.__chatyy_storage_preview !== false; } catch {}
    if (!previewOn) { trash(f); return; }
    try { setViewer({ file: f, list }); } catch {}
  };

  const renderList = (kind, list) => {
    const expanded = showAll[kind];
    const shown = expanded ? list : list.slice(0, LIST_MAX);
    return (
      <>
        {shown.map((f) => {
          const k = String(f.id);
          const busy = busyIds.has(k);
          const video = kind === 'video' || isVideoFile(f);
          const media = video || isImageFile(f);
          const date = fmtTaken(f, language);
          const title = humanTitle(f, t);
          const sub = [date, fmtBytes(f.size)].filter(Boolean).join(' · ');
          const isSel = selected.has(k);
          const left = (
            <View style={s.leftWrap}>
              {selecting ? <View style={s.selWrap}><SelectCircle on={isSel} g={g} /></View> : null}
              {media ? <Thumb f={f} g={g} video={video} /> : (
                <View style={[s.thumb, { backgroundColor: g.fill }]}><IconFile size={20} color={g.secondary} /></View>
              )}
            </View>
          );
          const right = busy ? <ActivityIndicator size="small" color={g.secondary} /> : selecting ? null : (
            <Pressable
              onPress={() => trash(f)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`${t('manageStorage.trashConfirm')} ${title}`}
              style={({ pressed }) => [s.trashBtn, { backgroundColor: pressed ? g.fill : 'transparent' }]}
              testID={`manage-trash-${kind}-${f.id}`}
            >
              <IconTrash size={18} color={g.secondary} />
            </Pressable>
          );
          return (
            <SettingsRow
              key={kind + f.id}
              left={left}
              title={title}
              subtitle={sub}
              subtitleLines={1}
              chevron={false}
              checked={undefined}
              onPress={busy ? undefined : () => openItem(f, list)}
              onLongPress={busy || selecting ? undefined : () => { setSelecting(true); toggleSel(f); }}
              accessibilityLabel={selecting ? title : `${video ? tt(t, 'manageStorage.play', 'Reproduzir') + ' ' : ''}${title}, ${sub}`}
              right={right || <View />}
              testID={`manage-${kind}-${f.id}`}
            />
          );
        })}
        {!expanded && list.length > shown.length ? (
          <SettingsRow
            title={t('manageStorage.showAll', { n: String(list.length) })}
            onPress={() => setShowAll((st) => ({ ...st, [kind]: true }))}
          />
        ) : null}
      </>
    );
  };

  const selBar = selecting ? (
    <View style={[s.selBar, { backgroundColor: g.cardBg, borderTopColor: g.separator, paddingBottom: 12 + (insets.bottom || 0) }]}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[s.selCount, { color: g.text }]} numberOfLines={1}>
          {selItems.length === 0
            ? tt(t, 'manageStorage.selectHint', 'Toque nos itens para selecionar')
            : selItems.length === 1
              ? tt(t, 'manageStorage.selectedOne', '1 item selecionado')
              : tt(t, 'manageStorage.selectedMany', '{n} itens selecionados', { n: String(selItems.length) })}
        </Text>
        {selItems.length ? <Text style={[s.selBytes, { color: g.secondary }]} numberOfLines={1}>{fmtBytes(selBytes)}</Text> : null}
      </View>
      <Pressable
        onPress={trashSelected}
        disabled={!selItems.length}
        accessibilityRole="button"
        style={({ pressed }) => [s.selTrash, { backgroundColor: g.destructive, opacity: !selItems.length ? 0.35 : (pressed ? 0.75 : 1) }]}
        testID="manage-trash-selected"
      >
        <IconTrash size={16} color="#FFFFFF" />
        <Text style={s.selTrashText} numberOfLines={1}>{tt(t, 'manageStorage.trashSelected', 'Mover para a lixeira')}</Text>
      </Pressable>
    </View>
  ) : null;

  const viewerOverlay = viewer ? (
    <FileViewer
      visible
      file={viewer.file}
      files={viewer.list}
      initialIndex={Math.max(0, viewer.list.findIndex((x) => x.id === viewer.file.id))}
      onClose={() => setViewer(null)}
      getUrl={(f) => playUrl(f)}
    />
  ) : null;

  return (
    <SettingsScreen
      title={tt(t, 'manageStorage.screenTitle', 'Armazenamento')}
      opaqueHeader
      headerRight={hasBig ? headerRight : undefined}
      overlay={<>{selBar}{viewerOverlay}</>}
      contentStyle={{ maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center', ...(selecting ? { paddingBottom: 120 + (insets.bottom || 0) } : null) }}
      testID="manage-storage"
    >
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

      {nativeApp && !selecting ? (
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
          {note ? (
            <SettingsGroup>
              <SettingsRow title={note} chevron={false} onPress={() => setNote(null)} />
            </SettingsGroup>
          ) : null}
          {videos.length ? (
            <SettingsGroup header={t('manageStorage.bigVideos')} footer={tt(t, 'manageStorage.tapFooter', 'Toque num item para ver. Use a lixeira ao lado para liberar espaço — a lixeira não conta no seu espaço.')}>
              {renderList('video', videos)}
            </SettingsGroup>
          ) : null}
          {others.length ? (
            <SettingsGroup header={t('manageStorage.bigItems')} footer={videos.length ? undefined : tt(t, 'manageStorage.tapFooter', 'Toque num item para ver. Use a lixeira ao lado para liberar espaço — a lixeira não conta no seu espaço.')}>
              {renderList('file', others)}
            </SettingsGroup>
          ) : null}
          {!failed && !videos.length && !others.length ? (
            <SettingsGroup>
              <SettingsRow title={t('manageStorage.nothingBig')} chevron={false} />
            </SettingsGroup>
          ) : null}
          {!selecting ? (
            <SettingsGroup>
              <SettingsRow
                title={t('manageStorage.openFiles')}
                right={<SettingsValueText>{files.length ? String(files.length) : ''}</SettingsValueText>}
                onPress={() => { try { router.push('/files'); } catch {} }}
              />
            </SettingsGroup>
          ) : null}
        </>
      )}
    </SettingsScreen>
  );
}

const s = StyleSheet.create({
  leftWrap: { flexDirection: 'row', alignItems: 'center' },
  selWrap: { marginRight: 12 },
  thumb: { width: 52, height: 52, borderRadius: 10, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  durPill: { position: 'absolute', right: 3, bottom: 3, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 5, backgroundColor: 'rgba(0,0,0,0.62)' },
  durText: { color: '#FFFFFF', fontSize: 10.5, fontWeight: '600', fontVariant: ['tabular-nums'] },
  playDot: { position: 'absolute', right: 4, bottom: 4, width: 18, height: 18, borderRadius: 9, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', paddingLeft: 1 },
  selCircle: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.6, alignItems: 'center', justifyContent: 'center' },
  trashBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  hdrBtn: { paddingHorizontal: 4, minHeight: 36, justifyContent: 'center' },
  hdrBtnText: { fontSize: 17, fontWeight: '400' },
  selBar: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  selCount: { fontSize: 15, fontWeight: '600' },
  selBytes: { fontSize: 13, marginTop: 1 },
  selTrash: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 40, borderRadius: 20, marginLeft: 12 },
  selTrashText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
});
