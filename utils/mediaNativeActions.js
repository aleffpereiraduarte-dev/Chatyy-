// [2026-10-09 more-native] Ações nativas do visualizador de mídia (OTA-safe).
//
// 1. shareMediaFile — compartilha o ARQUIVO (não o link). Antes o botão
//    Compartilhar do visualizador mandava `Share.share({ url: 'https://…' })`:
//    o share sheet do sistema recebia só um link → sem "Salvar imagem",
//    AirDrop/Instagram/Fotos recebiam texto. WhatsApp entrega o arquivo.
//    Agora: baixa p/ cacheDirectory (se ainda for remoto) e abre o share sheet
//    nativo com o arquivo (expo-sharing → UIActivityViewController /
//    Intent.ACTION_SEND com content:// via FileProvider). Falha → link (antes).
//
// 2. recognizeImageText — "Copiar texto da foto" (Live Text-lite). Usa o
//    Vision OCR on-device que JÁ está no binário iOS
//    (ExpoNativeChatSecurity.ocrImage — modules/expo-native-toolkit/ios/
//    ExpoNativeChatSecurity.swift). Detectado com requireOptionalNativeModule
//    (nunca lança; null em Android/web/binário sem o módulo) → o botão só
//    aparece onde funciona.
//
// Tudo lazy (require dentro das funções) — nada é sondado no import.
import { Platform, Share } from 'react-native';

function _fs() {
  try { return require('expo-file-system/legacy'); } catch {}
  try { return require('expo-file-system'); } catch {}
  return null;
}

const _EXT_RE = /\.(png|jpe?g|gif|webp|heic|heif|mp4|mov|m4v|webm|pdf|mp3|m4a|aac|ogg|opus|wav|docx?|xlsx?|pptx?|zip|txt)(\?|#|$)/i;

function _safeExt(url, fileName) {
  const fromUrl = String(url || '').match(_EXT_RE)?.[1];
  if (fromUrl) return fromUrl.toLowerCase();
  const nameExt = String(fileName || '').split('?')[0].split('.').pop();
  if (nameExt && /^[a-zA-Z0-9]{2,5}$/.test(nameExt)) return nameExt.toLowerCase();
  return 'jpg';
}

const _MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v',
  webm: 'video/webm', pdf: 'application/pdf', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', txt: 'text/plain', zip: 'application/zip',
};
const _UTI = {
  jpg: 'public.jpeg', jpeg: 'public.jpeg', png: 'public.png', gif: 'com.compuserve.gif',
  heic: 'public.heic', mp4: 'public.mpeg-4', mov: 'com.apple.quicktime-movie', pdf: 'com.adobe.pdf',
};

/** Garante um file:// local (baixa p/ cache se for http). null se não der. */
export async function ensureLocalFile(url, fileName) {
  if (!url || typeof url !== 'string') return null;
  const FS = _fs();
  if (!FS) return null;
  if (url.startsWith('file://')) {
    try {
      const info = await FS.getInfoAsync(url);
      return info?.exists ? url : null;
    } catch { return url; }
  }
  if (!/^https?:\/\//i.test(url)) return null;
  const ext = _safeExt(url, fileName);
  const dest = `${FS.cacheDirectory}chatyy_share_${Date.now()}.${ext}`;
  try {
    const r = await FS.downloadAsync(url, dest);
    if (!r?.uri || (r.status && r.status >= 400)) return null;
    return r.uri;
  } catch { return null; }
}

/**
 * Abre o share sheet nativo com o ARQUIVO. Devolve true se abriu.
 * Web e falhas caem no comportamento antigo (link).
 */
export async function shareMediaFile({ url, fileName, dialogTitle } = {}) {
  if (!url) return false;
  if (Platform.OS !== 'web') {
    try {
      const Sharing = require('expo-sharing');
      const avail = typeof Sharing?.isAvailableAsync === 'function' ? await Sharing.isAvailableAsync() : false;
      if (avail) {
        const local = await ensureLocalFile(url, fileName);
        if (local) {
          const ext = _safeExt(local, fileName);
          await Sharing.shareAsync(local, {
            mimeType: _MIME[ext],
            UTI: _UTI[ext],
            dialogTitle: dialogTitle || undefined,
          });
          return true;
        }
      }
    } catch {}
  }
  try {
    if (Platform.OS === 'web') {
      if (typeof navigator !== 'undefined' && navigator.share) { await navigator.share({ url }).catch(() => {}); return true; }
      await navigator?.clipboard?.writeText?.(url);
      return true;
    }
    await Share.share({ url, message: url });
    return true;
  } catch { return false; }
}

let _ocrMod;
function _ocrModule() {
  if (_ocrMod !== undefined) return _ocrMod;
  _ocrMod = null;
  if (Platform.OS !== 'ios') return null;
  try {
    const { requireOptionalNativeModule } = require('expo');
    const m = typeof requireOptionalNativeModule === 'function' ? requireOptionalNativeModule('ExpoNativeChatSecurity') : null;
    if (m && typeof m.ocrImage === 'function') _ocrMod = m;
  } catch { _ocrMod = null; }
  return _ocrMod;
}

/** true quando o binário tem o OCR on-device (iOS com ExpoNativeChatSecurity). */
export function canRecognizeImageText() {
  return !!_ocrModule();
}

function _ocrLocales(lang) {
  const l = String(lang || '').toLowerCase();
  const base = ['pt-BR', 'en-US', 'es-ES'];
  if (l.startsWith('en')) return ['en-US', 'pt-BR', 'es-ES'];
  if (l.startsWith('es')) return ['es-ES', 'en-US', 'pt-BR'];
  return base;
}

/** OCR on-device. Devolve { text } (text '' quando não há texto) ou { error }. */
export async function recognizeImageText(url, { fileName, language } = {}) {
  const m = _ocrModule();
  if (!m) return { error: 'unavailable', text: '' };
  const local = await ensureLocalFile(url, fileName);
  if (!local) return { error: 'download_failed', text: '' };
  try {
    const r = await m.ocrImage(local, _ocrLocales(language));
    if (r?.error) return { error: String(r.error), text: '' };
    return { text: String(r?.text || '').trim() };
  } catch (e) {
    return { error: String(e?.message || e || 'ocr_failed'), text: '' };
  }
}
