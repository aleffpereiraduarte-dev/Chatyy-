// [2026-10-15 native-status-studio] Ponte JS ↔ modules/expo-status-studio
// (estúdio de status NATIVO) e câmera do status nativa (modules/expo-chat-attach
// com statusModes, apiVersion >= 3).
//
// • nativeStudioUsable(): módulo no binário + kill switch
//   globalThis.__chatyy_native_status_studio !== false. Binário antigo / web →
//   false e o StatusStudio JS segue idêntico.
// • runNativeStudio(seed, ctx): abre o estúdio nativo e, ao publicar, entrega à
//   MESMA fila durável (services/statusPublishQueue) com o mesmo JSON de meta do
//   estúdio JS (stickers/text_overlays/draw_paths/mentions/filter/is_boomerang).
//   Resolve 'presented' | 'unavailable' (o chamador usa o JS).
// • runNativeStatusCamera(t): câmera do chat-attach em modo status (Texto ·
//   Normal · Boomerang). Resolve null quando não apresentou.
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { STATUS_FILTERS } from './statusFilters';
import { TEXT_STATUS_COLORS, TEXT_STATUS_FONTS, TEXT_STATUS_MAX } from './textStatus';
import { TEXT_BG_GRADIENTS } from './textGradients';

const AUDIENCE_KEY = 'status_audience_v1'; // mesmo do StatusStudio JS
const PALETTE = ['#FFFFFF', '#000000', '#9CA3AF', '#EF4444', '#F97316', '#FACC15', '#22C55E', '#14B8A6', '#3B82F6', '#8B5CF6', '#EC4899'];
// Gradientes oferecidos no status de texto (o viewer resolve `gradient:<id>`).
const TEXT_GRADIENT_IDS = ['noir', 'midnight', 'ocean', 'dusk', 'peach', 'ember', 'forest', 'lagoon', 'sunset', 'blue_cyan'];

let _mod;
function studioMod() {
  if (_mod !== undefined) return _mod;
  _mod = null;
  if (Platform.OS === 'web') return _mod;
  try {
    // eslint-disable-next-line global-require
    const m = require('../../modules/expo-status-studio');
    _mod = (m && (m.default || m)) || null;
  } catch { _mod = null; }
  return _mod;
}

let _attach;
function attachMod() {
  if (_attach !== undefined) return _attach;
  _attach = null;
  if (Platform.OS === 'web') return _attach;
  try {
    // eslint-disable-next-line global-require
    _attach = require('../../modules/expo-chat-attach');
  } catch { _attach = null; }
  return _attach;
}

export function nativeStudioUsable() {
  try {
    if (Platform.OS === 'web') return false;
    if (globalThis.__chatyy_native_status_studio === false) return false;
    const m = studioMod();
    return !!(m && m.isAvailable && m.isAvailable() && m.apiVersion() >= 1);
  } catch { return false; }
}

/** Câmera do status nativa: precisa do estúdio nativo E da câmera com statusModes. */
export function nativeStatusCameraUsable() {
  try {
    if (!nativeStudioUsable()) return false;
    if (globalThis.__chatyy_native_status_camera === false) return false;
    const a = attachMod();
    return !!(a && a.isCameraAvailable && a.isCameraAvailable() && typeof a.apiVersion === 'function' && a.apiVersion() >= 3);
  } catch { return false; }
}

function tt(t, key, fallback, params) {
  try {
    const v = typeof t === 'function' ? t(key, params) : null;
    return (typeof v === 'string' && v && v !== key) ? v : fallback;
  } catch { return fallback; }
}

export function studioLabels(t) {
  return {
    close: tt(t, 'common.close', 'Fechar'),
    cancel: tt(t, 'common.cancel', 'Cancelar'),
    done: tt(t, 'common.done', 'Concluir'),
    share: tt(t, 'status.studio.share', 'Seu status'),
    captionPlaceholder: tt(t, 'status.studio.captionPlaceholder', 'Adicionar legenda…'),
    textPlaceholder: tt(t, 'status.studio.textPlaceholder', 'Digite algo…'),
    typeStatus: tt(t, 'status.text.placeholder', 'Digite um status'),
    font: tt(t, 'status.text.changeFont', 'Trocar fonte'),
    color: tt(t, 'status.text.changeColor', 'Trocar cor'),
    align: tt(t, 'status.studio.alignment', 'Alinhamento'),
    textBg: tt(t, 'status.studio.textBackground', 'Fundo do texto'),
    text: tt(t, 'status.studio.text', 'Texto'),
    stickers: tt(t, 'status.studio.stickers', 'Figurinhas'),
    draw: tt(t, 'status.studio.draw', 'Desenhar'),
    filters: tt(t, 'status.studio.filters', 'Filtros'),
    music: tt(t, 'status.music', 'Música'),
    gallery: tt(t, 'status.gallery', 'Galeria'),
    camera: tt(t, 'status.camera', 'Câmera'),
    undo: tt(t, 'status.studio.undo', 'Desfazer'),
    mention: tt(t, 'status.stickerMention', 'Menção'),
    location: tt(t, 'status.stickerLocation', 'Local'),
    link: tt(t, 'status.stickerLink', 'Link'),
    poll: tt(t, 'status.stickerPoll', 'Enquete'),
    question: tt(t, 'status.stickerQuestion', 'Pergunta'),
    countdown: tt(t, 'status.stickerCountdown', 'Contagem'),
    pollQuestion: tt(t, 'status.studio.pollQuestion', 'Faça uma pergunta…'),
    pollDefault: tt(t, 'statusTab.pollDefaultQuestion', 'Sim ou não?'),
    optionA: tt(t, 'istickers.optionLabel', 'Opção 1', { opt: 1 }),
    optionB: tt(t, 'istickers.optionLabel', 'Opção 2', { opt: 2 }),
    yes: tt(t, 'common.yes', 'Sim'),
    no: tt(t, 'common.no', 'Não'),
    questionDefault: tt(t, 'istickers.questionDefault', 'Me pergunte algo…'),
    countdownLabel: tt(t, 'status.studio.countdownName', 'Nome do evento'),
    countdownDefault: tt(t, 'statusTab.countdownDefaultLabel', 'Evento'),
    ended: tt(t, 'istickers.ended', 'Encerrado'),
    linkLabel: tt(t, 'status.studio.linkLabel', 'Texto do botão (opcional)'),
    locationPlaceholder: tt(t, 'status.studio.locationPlaceholder', 'Onde você está?'),
    useMyLocation: tt(t, 'status.studio.useMyLocation', 'Usar minha localização'),
    searchContacts: tt(t, 'search.placeholder', 'Buscar'),
    noContacts: tt(t, 'status.studio.noContacts', 'Nenhum contato'),
    searchMusic: tt(t, 'statusCam.searchMusic', 'Buscar música…'),
    noTracks: tt(t, 'statusCam.noTracks', 'Nenhuma faixa encontrada'),
    audienceTitle: tt(t, 'status.audience.title', 'Quem pode ver'),
    audAll: tt(t, 'status.audience.all', 'Todos'),
    audAllSub: tt(t, 'status.audience.allSub', 'Seus contatos e conversas'),
    audContacts: tt(t, 'status.audience.contacts', 'Meus contatos'),
    audContactsSub: tt(t, 'status.audience.contactsSub', 'Só quem está na sua agenda'),
    audClose: tt(t, 'status.audience.closeFriends', 'Melhores amigos'),
    audCloseSub: tt(t, 'status.audience.closeFriendsSub', 'Anel com estrela, só a sua lista'),
    audExcept: tt(t, 'status.audience.except', 'Ocultar de…'),
    audExceptSub: tt(t, 'status.audience.exceptSub', 'Todos, menos quem você escolher'),
    audEdit: tt(t, 'status.audience.edit', 'Editar'),
    closeFriendsEmpty: tt(t, 'status.audience.closeFriendsEmpty', 'Sua lista está vazia. Toque em Editar para adicionar pessoas.'),
    brushPen: tt(t, 'status.studio.brushPen', 'Caneta'),
    brushMarker: tt(t, 'status.studio.brushMarker', 'Marca-texto'),
    brushNeon: tt(t, 'status.studio.brushNeon', 'Neon'),
    brushEraser: tt(t, 'status.studio.brushEraser', 'Borracha'),
    brushSize: tt(t, 'status.studio.brushSize', 'Espessura'),
    discardTitle: tt(t, 'status.studio.discardTitle', 'Descartar alterações?'),
    discard: tt(t, 'common.discard', 'Descartar'),
    keep: tt(t, 'status.studio.keepEditing', 'Continuar editando'),
    processing: tt(t, 'status.studio.processing', 'Preparando…'),
    publishFailed: tt(t, 'status.publishFailed', 'Não foi possível publicar o status.'),
    tapToReply: tt(t, 'statusTab.tapToReply', 'Toque para responder'),
  };
}

function textBackgrounds() {
  const out = TEXT_STATUS_COLORS.map(c => ({ value: c, colors: [c] }));
  for (const id of TEXT_GRADIENT_IDS) {
    const g = TEXT_BG_GRADIENTS.find(x => x.id === id);
    if (g) out.push({ value: `gradient:${g.id}`, colors: g.colors });
  }
  return out;
}

function mediaUrl(api, u) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  try { return api?.getMediaUrl ? api.getMediaUrl(u) : u; } catch { return u; }
}

function normTracks(api, list) {
  return (Array.isArray(list) ? list : []).filter(x => x && (x.title || x.name)).slice(0, 60).map(x => ({
    id: String(x.id ?? ''),
    title: String(x.title || x.name || ''),
    artist: String(x.artist || x.user || ''),
    previewUrl: mediaUrl(api, x.preview_url || x.previewUrl || x.url || ''),
    coverUrl: mediaUrl(api, x.image_url || x.cover_url || x.coverUrl || x.artwork || ''),
    durationSec: Number(x.duration_sec || x.duration || 0) || 0,
  }));
}

// Contexto (contatos p/ menção, catálogo de música, listas de público) em
// cache: a 1ª abertura espera no máx. ~1.2 s; as próximas abrem na hora e
// atualizam em segundo plano.
let _envCache = null;
let _envAt = 0;
async function loadContext(api) {
  const fresh = fetchContext(api).then((env) => { _envCache = env; _envAt = Date.now(); return env; });
  if (_envCache && Date.now() - _envAt < 3 * 60 * 1000) return { env: _envCache, fresh };
  const env = await fresh;
  return { env, fresh };
}

async function fetchContext(api) {
  const out = { contacts: [], musicCatalog: [], exceptList: [], closeFriendsCount: -1 };
  const jobs = [
    (async () => {
      const r = await api.chatConversations?.();
      const convs = (r?.success && r.data?.conversations) ? r.data.conversations : [];
      const seen = new Set();
      for (const c of convs) {
        if (c.is_group || c.type === 'group') continue;
        const email = c.other_email || c.email;
        if (!email || seen.has(email)) continue;
        seen.add(email);
        out.contacts.push({ email, name: c.name || c.other_name || String(email).split('@')[0] });
        if (out.contacts.length >= 400) break;
      }
    })(),
    (async () => {
      const pv = await api.chatPrivacyGet?.();
      if (pv?.success && Array.isArray(pv.data?.status_except)) out.exceptList = pv.data.status_except.map(e => String(e || '').toLowerCase()).filter(Boolean);
    })(),
    (async () => {
      const cf = await api.closeFriendsList?.();
      if (cf?.success) {
        const d = cf.data || {};
        const list = d.close_friends || d.list || d.friends || [];
        out.closeFriendsCount = typeof d.count === 'number' ? d.count : (Array.isArray(list) ? list.length : -1);
      }
    })(),
    (async () => {
      const r = await api.reelsMusicCatalog?.();
      if (r?.success && Array.isArray(r.data?.tracks)) out.musicCatalog = normTracks(api, r.data.tracks);
    })(),
  ];
  // Nada disso pode segurar a abertura por muito tempo.
  await Promise.race([
    Promise.allSettled(jobs.map(p => p.catch(() => {}))),
    new Promise(r => setTimeout(r, 1200)),
  ]);
  return out;
}

async function pickGallery() {
  try {
    const IP = await import('expo-image-picker');
    const perm = await IP.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return [];
    const r = await IP.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, selectionLimit: 10, quality: 1 });
    if (r.canceled || !r.assets?.length) return [];
    return r.assets.map(a => ({
      uri: a.uri,
      type: (a.type === 'video' || /\.(mp4|mov|m4v|webm)$/i.test(a.uri || '') || String(a.mimeType || '').startsWith('video')) ? 'video' : 'image',
      width: a.width || 0,
      height: a.height || 0,
    }));
  } catch { return []; }
}

async function detectLocation() {
  try {
    // eslint-disable-next-line global-require
    const Loc = require('expo-location');
    const perm = await Loc.requestForegroundPermissionsAsync();
    if (perm?.status !== 'granted') return '';
    const pos = await Loc.getCurrentPositionAsync({ accuracy: Loc.Accuracy?.Balanced ?? 3 });
    const geo = await Loc.reverseGeocodeAsync({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
    const g = geo?.[0];
    if (!g) return '';
    const label = g.district || g.city || g.subregion || g.region || '';
    return g.city && g.district && g.city !== g.district ? `${g.district}, ${g.city}` : label;
  } catch { return ''; }
}

/**
 * Abre o estúdio nativo para o seed do StatusStudio ({ mode, items, music, isBoomerang }).
 * ctx: { t, user, onClose(result), onOpenCamera, router }.
 * Resolve 'presented' (o nativo cuidou de tudo) ou 'unavailable' (use o JS).
 */
export async function runNativeStudio(seed, ctx) {
  const m = studioMod();
  if (!m || !nativeStudioUsable()) return 'unavailable';
  // eslint-disable-next-line global-require
  const api = require('../../services/api');
  // eslint-disable-next-line global-require
  const { enqueueStatusPublish } = require('../../services/statusPublishQueue');
  const t = ctx?.t;
  const its = (seed?.items || []).filter(i => i?.uri).slice(0, 10);
  const mode = seed?.mode === 'text' || !its.length ? 'text' : 'media';
  let audience = 'all';
  try { const a = await AsyncStorage.getItem(AUDIENCE_KEY); if (a && ['all', 'contacts', 'close_friends', 'except'].includes(a)) audience = a; } catch {}
  const { env, fresh } = await loadContext(api);
  const sm = seed?.music;
  const options = {
    mode,
    items: its.map((it, i) => ({
      uri: it.uri,
      type: it.type === 'video' ? 'video' : 'image',
      width: Number(it.width) || 0,
      height: Number(it.height) || 0,
      filter: it.filter || '',
      boomerang: !!(it.isBoomerang || (i === 0 && seed?.isBoomerang)),
    })),
    labels: studioLabels(t),
    filters: STATUS_FILTERS.map(f => ({ id: f.id, label: tt(t, f.labelKey, f.id), m: Array.from(f.m) })),
    textBackgrounds: textBackgrounds(),
    textBgIndex: Math.floor(Math.random() * TEXT_STATUS_COLORS.length),
    fonts: TEXT_STATUS_FONTS.map(f => ({ id: f.id, label: tt(t, f.labelKey, f.id) })),
    textMax: TEXT_STATUS_MAX,
    palette: PALETTE,
    contacts: env.contacts,
    musicCatalog: env.musicCatalog,
    music: sm && (sm.title || sm.previewUrl) ? {
      title: String(sm.title || ''), artist: String(sm.artist || ''), previewUrl: String(sm.previewUrl || ''),
      coverUrl: String(sm.coverUrl || ''), startMs: Number(sm.startMs) || 0,
    } : null,
    audience,
    closeFriendsCount: env.closeFriendsCount,
    exceptCount: env.exceptList.length,
    canCamera: !!ctx?.onOpenCamera,
    canGallery: true,
  };

  const sub = m.addRequestListener(async (e) => {
    const reqId = e?.reqId;
    try {
      if (e?.kind === 'musicSearch') {
        const r = await api.reelsMusicSearch?.(String(e.q || ''));
        m.respond(reqId, { tracks: (r?.success && Array.isArray(r.data?.tracks)) ? normTracks(api, r.data.tracks) : [] });
      } else if (e?.kind === 'gallery') {
        m.respond(reqId, { items: await pickGallery() });
      } else if (e?.kind === 'location') {
        m.respond(reqId, { label: await detectLocation() });
      } else {
        m.respond(reqId, {});
      }
    } catch { m.respond(reqId, {}); }
  });

  let r = null;
  try {
    r = await m.open(options);
  } finally {
    try { sub.remove(); } catch {}
  }
  if (!r || r.action === 'error') {
    if (r && __DEV__) console.warn('[native-status-studio] error', r.error);
    return 'unavailable';
  }
  if (r.action === 'cancel') { ctx?.onClose?.(); return 'presented'; }
  if (r.action === 'camera') {
    ctx?.onClose?.();
    setTimeout(() => { try { ctx?.onOpenCamera?.(); } catch {} }, Platform.OS === 'ios' ? 500 : 200);
    return 'presented';
  }
  if (r.action === 'editAudience') {
    _envCache = null; // a lista vai mudar
    const which = r.which === 'except' ? 'except' : 'close_friends';
    try { AsyncStorage.setItem(AUDIENCE_KEY, which); } catch {}
    ctx?.onClose?.();
    setTimeout(() => { try { ctx?.router?.push?.(which === 'except' ? '/status-except' : '/close-friends'); } catch {} }, 200);
    return 'presented';
  }
  if (r.action !== 'publish') { ctx?.onClose?.(); return 'presented'; }

  // ── publicar: mesmo formato do StatusStudio JS ──
  const aud = ['all', 'contacts', 'close_friends', 'except'].includes(r.audience) ? r.audience : 'all';
  try { AsyncStorage.setItem(AUDIENCE_KEY, aud); } catch {}
  // Lista "ocultar de" SEMPRE a atual (o cache pode estar velho).
  let envNow = env;
  try { envNow = await Promise.race([fresh, new Promise(res => setTimeout(() => res(env), 4000))]); } catch {}
  const base = {};
  if (aud !== 'all') base.privacy = aud;
  if (aud === 'except' && envNow.exceptList.length) base.except_emails = envNow.exceptList;
  const email = ctx?.user?.email || '';
  let haptic = null;
  try { haptic = require('../../services/haptics').HapticsCompat; } catch {}
  try {
    if (r.text && String(r.text.text || '').trim()) {
      await enqueueStatusPublish({
        email, kind: 'text',
        content: Array.from(String(r.text.text).trim()).slice(0, TEXT_STATUS_MAX).join(''),
        background: String(r.text.bg || TEXT_STATUS_COLORS[0]),
        meta: {
          ...base,
          font_style: TEXT_STATUS_FONTS.some(f => f.id === r.text.font) ? r.text.font : 'sans',
          // [status-texto 2026-10-16] binário novo manda o alinhamento (antes virava imagem).
          ...(r.text.align === 'left' || r.text.align === 'right' ? { text_align: r.text.align } : {}),
        },
      });
    } else {
      const items = Array.isArray(r.items) ? r.items : [];
      const caption = String(r.caption || '').trim();
      const music = r.music && (r.music.title || r.music.previewUrl) ? r.music : null;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it?.uri) continue;
        const stickers = (Array.isArray(it.stickers) ? it.stickers : []).map(({ email: _e, ...rest }) => rest);
        const mentions = Array.from(new Set((Array.isArray(it.mentions) ? it.mentions : []).filter(Boolean)));
        const meta = {
          ...base,
          ...(i === 0 && caption ? { caption } : {}),
          ...(it.kind !== 'video' && it.filter && it.filter !== 'original' ? { filter: it.filter } : {}),
          ...(stickers.length ? { stickers } : {}),
          ...(mentions.length ? { mentions } : {}),
        };
        if (it.kind === 'video') {
          if (Array.isArray(it.textOverlays) && it.textOverlays.length) meta.text_overlays = it.textOverlays;
          if (Array.isArray(it.drawPaths) && it.drawPaths.length) meta.draw_paths = it.drawPaths;
          if (it.boomerang) meta.is_boomerang = true;
          await enqueueStatusPublish({ email, kind: 'video', file: { uri: it.uri, name: 'status.mp4', type: 'video/mp4' }, meta, music: i === 0 ? music : null });
        } else {
          await enqueueStatusPublish({ email, kind: 'image', file: { uri: it.uri, name: 'status.jpg', type: 'image/jpeg' }, thumbUri: it.uri, meta, music: i === 0 ? music : null });
        }
      }
    }
    ctx?.onClose?.({ published: true });
  } catch (err) {
    console.warn('[native-status-studio] publish failed', err?.message || err);
    try { haptic?.notificationAsync?.(haptic.NotificationFeedbackType?.Error); } catch {}
    try {
      // eslint-disable-next-line global-require
      const { Alert } = require('react-native');
      Alert.alert(tt(t, 'common.error', 'Erro'), tt(t, 'status.publishFailed', 'Não foi possível publicar o status.'));
    } catch {}
    ctx?.onClose?.();
  }
  return 'presented';
}

/**
 * Câmera do status nativa. Resolve null (não apresentou → câmera JS) ou
 * { action: 'capture'|'pick', capture } | { action: 'text' } | { action: 'gallery' } | { action: 'cancel' }.
 * `capture` já no formato do onCapture do StatusCamera JS.
 */
export async function runNativeStatusCamera(t, opts = {}) {
  if (!nativeStatusCameraUsable()) return null;
  const a = attachMod();
  let labels = {};
  try {
    // eslint-disable-next-line global-require
    labels = require('../chat/NativeAttachSheet').nativeAttachLabels(t) || {};
  } catch {}
  labels = {
    ...labels,
    modeText: tt(t, 'status.text.openEditor', 'Texto'),
    modeNormal: tt(t, 'statusCam.modeNormal', 'Normal'),
    modeBoomerang: tt(t, 'statusCam.modeBoomerang', 'Boomerang'),
    boomerangHint: tt(t, 'statusCam.boomerangHint', 'Toque para gravar um boomerang'),
  };
  let r = null;
  try {
    r = await a.openCamera({
      labels,
      dark: true,
      maxVideoSec: opts.maxVideoSec || 60,
      maxSelect: 10,
      withAudio: true,
      statusModes: true,
      boomerangSec: 1.5,
    });
  } catch (e) {
    if (__DEV__) console.warn('[native-status-camera] failed', e?.message || e);
    return null;
  }
  if (!r || !r.action) return null;
  if (r.action === 'capture' || r.action === 'pick') {
    const items = (Array.isArray(r.items) ? r.items : []).filter(x => x && x.uri).slice(0, 10).map(x => ({
      uri: x.uri,
      type: x.mediaType === 'video' ? 'video' : 'photo',
      width: Number(x.width) || undefined,
      height: Number(x.height) || undefined,
      isBoomerang: !!x.boomerang,
    }));
    if (!items.length) return { action: 'cancel' };
    const capture = items.length === 1
      ? { ...items[0] }
      : { multi: true, items };
    return { action: r.action, capture };
  }
  return { action: r.action };
}

export async function pickStatusGallery() {
  const list = await pickGallery();
  return list.map(a => ({ ...a, type: a.type === 'video' ? 'video' : 'photo' }));
}
