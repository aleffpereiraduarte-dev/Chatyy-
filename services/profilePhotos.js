// services/profilePhotos.js — [perfil-fotos 2026-10-19]
//
// Galeria de fotos de perfil estilo Telegram + "Publicar no perfil".
//
// Servidor (/api/email.php, profile_photos.php):
//   profile_photos {email}         → {photos:[{id,url,thumb_url,is_main}], can_manage, hidden}
//   profile_photo_add (multipart)  → foto nova (main=1 = vira a principal; a atual vira histórico)
//   profile_photo_set_main {id} / profile_photo_remove {id}
// A privacidade (foto de perfil: todos / contatos / ninguém + bloqueio) é
// aplicada no servidor: visitante sem permissão recebe photos=[] (hidden).
//
// Kill switches (OTA/console):
//   globalThis.__chatyy_profile_gallery = false    → sem galeria (avatar único, como antes)
//   globalThis.__chatyy_profile_posts_ci = false   → sem publicações em "Dados do contato"
//                                                     e sem os atalhos "Publicar no perfil"
//
// Visualizador: viewer NATIVO (services/nativeMediaOpen) quando todas as URLs
// são públicas (R2/CDN); senão (ou binário sem o módulo) o JS
// components/profile/ProfilePhotoGallery via openProfilePhotoGallery → evento.
import { Platform, DeviceEventEmitter } from 'react-native';

export function isProfileGalleryEnabled() {
  try { if (globalThis.__chatyy_profile_gallery === false) return false; } catch {}
  return true;
}

export function isProfilePostsCiEnabled() {
  try { if (globalThis.__chatyy_profile_posts_ci === false) return false; } catch {}
  return true;
}

// ── i18n: t() primeiro; sem chave no dicionário → tabela local pt/en/es ──
const L = {
  addPhoto: { pt: 'Adicionar foto de perfil', en: 'Add profile photo', es: 'Añadir foto de perfil' },
  addPhotoHint: { pt: 'Entra na galeria de fotos do perfil', en: 'Goes to your profile photo gallery', es: 'Se suma a la galería de fotos del perfil' },
  publish: { pt: 'Publicar no perfil', en: 'Post to profile', es: 'Publicar en el perfil' },
  publishHint: { pt: 'Fotos e vídeos que aparecem no seu perfil', en: 'Photos and videos shown on your profile', es: 'Fotos y videos que aparecen en tu perfil' },
  addPost: { pt: 'Adicionar publicação', en: 'Add post', es: 'Añadir publicación' },
  posts: { pt: 'Publicações', en: 'Posts', es: 'Publicaciones' },
  setMain: { pt: 'Definir como principal', en: 'Set as main photo', es: 'Definir como principal' },
  remove: { pt: 'Apagar foto', en: 'Delete photo', es: 'Eliminar foto' },
  removeTitle: { pt: 'Apagar esta foto?', en: 'Delete this photo?', es: '¿Eliminar esta foto?' },
  removeMsg: { pt: 'Ela some do seu perfil para todo mundo.', en: 'It will be removed from your profile for everyone.', es: 'Se quitará de tu perfil para todos.' },
  cancel: { pt: 'Cancelar', en: 'Cancel', es: 'Cancelar' },
  close: { pt: 'Fechar', en: 'Close', es: 'Cerrar' },
  more: { pt: 'Mais opções', en: 'More options', es: 'Más opciones' },
  added: { pt: 'Foto adicionada ao perfil', en: 'Photo added to your profile', es: 'Foto añadida al perfil' },
  failed: { pt: 'Não foi possível salvar a foto', en: 'Could not save the photo', es: 'No se pudo guardar la foto' },
  photos: { pt: 'Fotos do perfil', en: 'Profile photos', es: 'Fotos del perfil' },
  of: { pt: 'de', en: 'of', es: 'de' },
  permTitle: { pt: 'Permissão negada', en: 'Permission denied', es: 'Permiso denegado' },
  permMsg: { pt: 'Permita acesso às fotos para continuar.', en: 'Allow photo access to continue.', es: 'Permite el acceso a las fotos para continuar.' },
};
const KEYS = {
  addPhoto: 'profilePhotos.add', addPhotoHint: 'profilePhotos.addHint', publish: 'profilePhotos.publish',
  publishHint: 'profilePhotos.publishHint', addPost: 'profilePhotos.addPost', posts: 'nativeProfile.posts',
  setMain: 'profilePhotos.setMain', remove: 'profilePhotos.remove', removeTitle: 'profilePhotos.removeTitle',
  removeMsg: 'profilePhotos.removeMsg', cancel: 'common.cancel', close: 'common.close', more: 'nativeProfile.more',
  added: 'profilePhotos.added', failed: 'profilePhotos.failed', photos: 'profilePhotos.title', of: 'profilePhotos.of',
  permTitle: 'photos.permissionDenied', permMsg: 'profilePhotos.permMsg',
};

function _lang() {
  try {
    const h = require('./api').getAuthHeaders?.() || {};
    const l = String(h['X-User-Language'] || '').slice(0, 2).toLowerCase();
    if (l === 'en' || l === 'es') return l;
  } catch {}
  return 'pt';
}

/** Texto traduzido: t(chave) → tabela local (pt/en/es) → pt. */
export function ppT(t, name) {
  const k = KEYS[name];
  try { if (k && typeof t === 'function') { const v = t(k); if (v && v !== k && typeof v === 'string') return v; } } catch {}
  const row = L[name];
  if (!row) return name;
  return row[_lang()] || row.pt;
}

// ── Cache + assinantes ─────────────────────────────────────────────────────
const _cache = new Map(); // email → { photos, hidden, canManage, at }
const _inflight = new Map();
const EVT = 'chatyy:profilePhotos';

function _key(email) { return String(email || '').trim().toLowerCase(); }

export function getCachedProfilePhotos(email) {
  return _cache.get(_key(email)) || null;
}

function _put(email, data) {
  const k = _key(email);
  if (!k) return;
  const photos = Array.isArray(data?.photos) ? data.photos.filter((p) => p && p.url) : [];
  const v = { photos, hidden: !!data?.hidden, canManage: !!data?.can_manage, at: Date.now() };
  _cache.set(k, v);
  try { DeviceEventEmitter.emit(EVT, { email: k, value: v }); } catch {}
}

export function subscribeProfilePhotos(fn) {
  const s = DeviceEventEmitter.addListener(EVT, fn);
  return () => { try { s.remove(); } catch {} };
}

/** Busca (dedupe + cache 60 s; force ignora o cache). */
export async function fetchProfilePhotos(email, { force = false } = {}) {
  const k = _key(email);
  if (!k || !isProfileGalleryEnabled()) return null;
  const c = _cache.get(k);
  if (!force && c && Date.now() - c.at < 60000) return c;
  if (_inflight.has(k)) return _inflight.get(k);
  const p = (async () => {
    try {
      const api = require('./api');
      const r = await api.apiCall('profile_photos', { email: k }, 'GET');
      if (r && r.success && r.data) { _put(k, r.data); return _cache.get(k); }
    } catch {}
    return c || null;
  })();
  _inflight.set(k, p);
  try { return await p; } finally { _inflight.delete(k); }
}

function _myEmail() {
  try { return _key(require('./api').getActiveAccountEmail?.() || ''); } catch { return ''; }
}

function _afterWrite(r, email) {
  const me = _key(email) || _myEmail();
  if (r && r.success && r.data) {
    if (Array.isArray(r.data.photos) && me) _put(me, { photos: r.data.photos, can_manage: true, hidden: false });
    const v = r.data.avatar_version;
    if (v && me) { try { require('./api').bustAvatarCache?.(me, Number(v)); } catch {} }
  }
  return r;
}

/** Envia uma foto à galeria. file = { uri, name, type } (nativo) ou File/Blob (web). */
export async function addProfilePhoto(file, { main = true, email = '' } = {}) {
  const api = require('./api');
  const fd = new FormData();
  fd.append('action', 'profile_photo_add');
  fd.append('main', main ? '1' : '0');
  try {
    if (typeof File !== 'undefined' && file instanceof File) fd.append('photo', file, file.name || 'photo.jpg');
    else if (typeof Blob !== 'undefined' && file instanceof Blob) fd.append('photo', file, 'photo.jpg');
    else if (file && file.uri) {
      if (Platform.OS !== 'web') fd.append('photo', { uri: file.uri, type: file.type || 'image/jpeg', name: file.name || 'photo.jpg' });
      else { const blob = await fetch(file.uri).then((x) => x.blob()); fd.append('photo', blob, file.name || 'photo.jpg'); }
    } else return { success: false, message: 'Invalid file' };
  } catch { return { success: false, message: 'Failed to read file' }; }
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const to = setTimeout(() => { try { ctl && ctl.abort(); } catch {} }, 60000);
  try {
    const res = await fetch(`${api.getApiUrl()}?action=profile_photo_add`, {
      method: 'POST', headers: api.getAuthHeaders(), body: fd, credentials: 'include', ...(ctl ? { signal: ctl.signal } : null),
    });
    const text = await res.text();
    let r = null;
    try { r = JSON.parse(text); } catch { r = { success: false, message: 'Servidor indisponível' }; }
    return _afterWrite(r, email);
  } catch (e) {
    return { success: false, message: e && e.name === 'AbortError' ? 'Tempo limite excedido' : 'Connection error' };
  } finally { clearTimeout(to); }
}

export async function setMainProfilePhoto(id, email = '') {
  try { return _afterWrite(await require('./api').apiCall('profile_photo_set_main', { id: Number(id) }, 'POST'), email); } catch { return { success: false }; }
}

export async function removeProfilePhoto(id, email = '') {
  try { return _afterWrite(await require('./api').apiCall('profile_photo_remove', { id: Number(id) }, 'POST'), email); } catch { return { success: false }; }
}

/** Escolhe uma foto (corte 1:1) e adiciona como principal. → resposta do servidor ou null (cancelou). */
export async function pickAndAddProfilePhoto({ t, email = '', onBusy } = {}) {
  let ImagePicker = null;
  try { ImagePicker = require('expo-image-picker'); } catch { return null; }
  try {
    if (Platform.OS !== 'web') {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync?.();
      if (perm && !perm.granted) {
        try { require('./alerts').safeAlert(ppT(t, 'permTitle'), ppT(t, 'permMsg')); } catch {}
        return null;
      }
      if (Platform.OS === 'ios') await new Promise((r) => setTimeout(r, 350)); // modal sobre modal (folha fechando)
    }
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.9 });
    if (!res || res.canceled || !res.assets || !res.assets[0]) return null;
    const a = res.assets[0];
    try { onBusy && onBusy(true); } catch {}
    const r = await addProfilePhoto({ uri: a.uri, name: 'photo.jpg', type: a.mimeType && /png|webp|jpe?g/.test(a.mimeType) ? a.mimeType : 'image/jpeg' }, { main: true, email });
    if (!r || !r.success) {
      try { require('./alerts').safeAlert(ppT(t, 'failed'), (r && r.message) || ''); } catch {}
    } else {
      try { require('./haptics').hapticEvent?.('success'); } catch {}
    }
    return r;
  } catch (e) {
    try { require('./alerts').safeAlert(ppT(t, 'failed'), (e && e.message) || ''); } catch {}
    return null;
  } finally {
    try { onBusy && onBusy(false); } catch {}
  }
}

/**
 * "Publicar no perfil" → compositor /photo-new (carrossel até 10, formato, legenda,
 * quem pode ver, progresso). [perfil-publicar 2026-10-19] O seletor agora abre DE
 * DENTRO do compositor (antes abria aqui e o push do modal logo após o PHPicker
 * fechar era recusado pelo iOS → "não faz nada"). `from` = para onde voltar.
 */
export async function startProfilePost(router, t, { from = '', pick = 'library' } = {}) {
  try {
    return require('./profilePostComposer').openPostComposer(router, { pick, from });
  } catch (e) {
    try { require('./alerts').safeAlert(ppT(t, 'failed'), (e && e.message) || ''); } catch {}
    return false;
  }
}

/**
 * Lista do visualizador: principal primeiro (URL da galeria quando existe;
 * senão o avatar atual), depois as demais. [{ id, url, thumb, main }]
 */
export function galleryList(photos, avatarUrl) {
  const list = [];
  const arr = Array.isArray(photos) ? photos : [];
  const main = arr.find((p) => p && p.is_main);
  if (main) list.push({ id: main.id, url: main.url, thumb: main.thumb_url || main.url, main: true });
  else if (avatarUrl) list.push({ id: null, url: avatarUrl, thumb: avatarUrl, main: true });
  for (const p of arr) {
    if (!p || p.is_main || !p.url) continue;
    list.push({ id: p.id, url: p.url, thumb: p.thumb_url || p.url, main: false });
  }
  return list;
}

/** Extras do carrossel do cabeçalho (a 1ª foto é o avatar = `tile`). */
export function heroExtraPhotos(photos, max = 20) {
  const out = [];
  for (const p of Array.isArray(photos) ? photos : []) {
    if (!p || p.is_main || !p.url) continue;
    out.push({ u: String(p.url), a: /\/api\//.test(String(p.url)) ? 1 : 0 });
    if (out.length >= max) break;
  }
  return out;
}

export const GALLERY_OPEN_EVENT = 'chatyy:profileGalleryOpen';
let _hosts = 0;
/** ProfilePhotoGallery montado (Profile.js / chat-info) → 1; desmontou → chame o retorno. */
export function registerGalleryHost() {
  _hosts += 1;
  let done = false;
  return () => { if (!done) { done = true; _hosts = Math.max(0, _hosts - 1); } };
}

/**
 * Abre a galeria em tela cheia no índice `index` (0 = principal).
 * Nativo quando possível; senão emite GALLERY_OPEN_EVENT (ProfilePhotoGallery
 * montado na tela escuta) ou chama `fallback(list, index)`.
 */
export async function openProfilePhotoGallery({ email, name, photos, avatarUrl, index = 0, t, isSelf = false, fallback } = {}) {
  const list = galleryList(photos, avatarUrl);
  if (!list.length) return false;
  const at = Math.max(0, Math.min(list.length - 1, Number(index) || 0));
  const allPublic = list.every((x) => !/\/api\//.test(String(x.url)));
  if (allPublic && !isSelf) {
    try {
      const nmo = require('./nativeMediaOpen');
      if (nmo.nativeMediaAlways()) {
        const sid = await nmo.openNativeMediaList({
          list, index: at, t, allowShare: true, allowSave: true,
          toItem: (x) => ({ uri: String(x.url), thumbUri: String(x.thumb || x.url), type: 'image', senderName: String(name || ''), caption: '' }),
        });
        if (sid) return true;
      }
    } catch {}
  }
  const payload = { email: _key(email), name: String(name || ''), list, index: at, isSelf: !!isSelf };
  if (typeof fallback === 'function') { try { fallback(payload); return true; } catch {} }
  if (_hosts <= 0) return false;
  try { DeviceEventEmitter.emit(GALLERY_OPEN_EVENT, payload); return true; } catch {}
  return false;
}
