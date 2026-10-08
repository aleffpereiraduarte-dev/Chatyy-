// [2026-10-08 sticker-maker] Recorte automático do objeto (remoção de fundo)
// para o criador de figurinhas.
//
// Ordem:
//   1. NO APARELHO — módulo nativo ExpoStickerCutout (expo-native-toolkit):
//      iOS 17+ Vision "subject lifting" / Android ML Kit Subject Segmentation.
//      Pego com requireOptionalNativeModule NA HORA da chamada → binários
//      antigos (sem o módulo) devolvem null e caem no passo 2 sem crash.
//   2. SERVIDOR — chat_sticker_cutout (rembg/isnet no edge BR, ~3-5 s).
//      Web sempre usa este caminho.
//
// Entrada: uri local (file://, content://, blob:, data:) ou remota (https://
// — baixada para o cache antes, no nativo). Saída:
//   { ok: true, uri, width, height, method: 'device'|'server' }
//   { ok: false, reason: 'no_subject'|'unavailable'|'network'|'rate_limited'|... }
import { Platform } from 'react-native';
import * as api from './api';

let _mod;
function nativeCutout() {
  if (Platform.OS === 'web') return null;
  if (_mod !== undefined) return _mod;
  _mod = null;
  try {
    // eslint-disable-next-line global-require
    const expo = require('expo');
    const m = typeof expo.requireOptionalNativeModule === 'function'
      ? expo.requireOptionalNativeModule('ExpoStickerCutout')
      : null;
    if (m && typeof m.liftSubject === 'function') _mod = m;
  } catch { _mod = null; }
  return _mod;
}

/** true quando o recorte roda no próprio aparelho (sem rede). */
export function hasOnDeviceCutout() {
  const m = nativeCutout();
  if (!m) return false;
  try { return typeof m.isSupported === 'function' ? !!m.isSupported() : true; } catch { return false; }
}

/** Android: pede ao Play services o download do modelo (idempotente, silencioso). */
export function prepareOnDeviceCutout() {
  const m = nativeCutout();
  if (!m || typeof m.prepare !== 'function') return;
  try { m.prepare().catch(() => {}); } catch {}
}

/** Garante um arquivo local (nativo) para o módulo nativo / upload multipart. */
export async function ensureLocalFile(uri) {
  if (!uri || Platform.OS === 'web') return uri;
  if (!/^https?:\/\//i.test(uri)) return uri;
  try {
    // eslint-disable-next-line global-require
    const FS = require('expo-file-system/legacy');
    const extMatch = String(uri).split('?')[0].match(/\.(jpe?g|png|webp|heic|gif)$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
    const dest = `${FS.cacheDirectory}sticker-src-${Date.now()}.${ext}`;
    const r = await FS.downloadAsync(uri, dest);
    return r?.uri || null;
  } catch {
    return null;
  }
}

/**
 * Normaliza a foto antes do recorte: aplica EXIF, limita a 1600 px e converte
 * HEIC → JPEG (o servidor e o ML Kit leem JPEG sem surpresa).
 */
async function normalizeForCutout(uri) {
  if (Platform.OS === 'web') return { uri };
  try {
    // eslint-disable-next-line global-require
    const IM = require('expo-image-manipulator');
    if (!IM?.manipulateAsync) return { uri };
    const r0 = await IM.manipulateAsync(uri, [], { compress: 0.9, format: IM.SaveFormat.JPEG });
    const big = Math.max(r0.width || 0, r0.height || 0);
    if (big > 1600) {
      const r1 = await IM.manipulateAsync(r0.uri, [{ resize: (r0.width >= r0.height) ? { width: 1600 } : { height: 1600 } }], { compress: 0.88, format: IM.SaveFormat.JPEG });
      return { uri: r1.uri, width: r1.width, height: r1.height };
    }
    return { uri: r0.uri, width: r0.width, height: r0.height };
  } catch {
    return { uri };
  }
}

export async function cutoutSubject(srcUri, { allowServer = true } = {}) {
  if (!srcUri) return { ok: false, reason: 'bad_image' };
  let local = await ensureLocalFile(srcUri);
  if (!local) return { ok: false, reason: 'network' };

  // 1) No aparelho
  const m = nativeCutout();
  if (m && hasOnDeviceCutout()) {
    try {
      const norm = await normalizeForCutout(local);
      local = norm.uri || local;
      const r = await m.liftSubject(local, 1024);
      if (r && r.uri) return { ok: true, uri: r.uri, width: r.width || 0, height: r.height || 0, method: 'device' };
      if (r === null) return { ok: false, reason: 'no_subject' };
    } catch {
      // modelo ainda baixando (Android) / iOS sem Neural Engine → servidor
    }
  }

  // 2) Servidor
  if (!allowServer) return { ok: false, reason: 'unavailable' };
  let file;
  if (Platform.OS === 'web') {
    file = { uri: local, name: 'photo.png' };
  } else {
    const norm = await normalizeForCutout(local);
    file = { uri: norm.uri || local, name: 'photo.jpg', type: 'image/jpeg' };
  }
  const r = await api.chatStickerCutout(file, { max: 768 });
  if (r?.processed && r.dataUri) {
    if (Platform.OS === 'web') {
      return { ok: true, uri: r.dataUri, width: r.width, height: r.height, method: 'server' };
    }
    // Nativo: grava o PNG em arquivo (view-shot/Image lidam melhor com file://)
    try {
      // eslint-disable-next-line global-require
      const FS = require('expo-file-system/legacy');
      const dest = `${FS.cacheDirectory}sticker-cutout-${Date.now()}.png`;
      await FS.writeAsStringAsync(dest, r.base64, { encoding: FS.EncodingType.Base64 });
      return { ok: true, uri: dest, width: r.width, height: r.height, method: 'server' };
    } catch {
      return { ok: true, uri: r.dataUri, width: r.width, height: r.height, method: 'server' };
    }
  }
  return { ok: false, reason: r?.reason || 'unavailable' };
}
