// [2026-10-10 paste-image] Colar foto/GIF/figurinha no campo de mensagem.
//
// Dois caminhos, ambos opcionais e com checagem:
//  1. OTA (binário atual): expo-clipboard já está no binário. hasImageAsync()
//     só consulta o TIPO do conteúdo (não dispara o aviso "colar de…" do iOS
//     nem o toast do Android 12+); a imagem só é lida quando a pessoa toca em
//     "Colar foto". Vira PNG/JPEG (GIF animado perde a animação aqui).
//  2. Próximo build: módulo nativo ChatyyImagePaste (expo-native-toolkit)
//     — iOS: "Colar" do menu do campo aceita imagem (GIF/PNG/JPEG/WebP crus);
//     Android: OnReceiveContentListener = colar + GIF/figurinha do teclado
//     (Gboard commitContent). Entrega um arquivo local via evento.
import { Platform, findNodeHandle } from 'react-native';

let _native;
function nativePaste() {
  if (_native !== undefined) return _native;
  _native = null;
  if (Platform.OS === 'web') return _native;
  try {
    const core = require('expo-modules-core');
    _native = core.requireOptionalNativeModule?.('ChatyyImagePaste') || null;
  } catch { _native = null; }
  return _native;
}

/** O binário tem o colar nativo (teclado/menu do campo)? */
export function hasNativeImagePaste() {
  const m = nativePaste();
  return !!m && typeof m.attach === 'function';
}

/**
 * Liga o colar de imagem nativo no TextInput (ref). onImage({ uri, mimeType, width, height }).
 * Devolve uma função de limpeza. Sem módulo nativo = no-op.
 */
export function attachNativeImagePaste(inputRef, onImage) {
  const m = nativePaste();
  if (!m || typeof m.attach !== 'function') return () => {};
  let tag = null;
  try { tag = findNodeHandle(inputRef?.current); } catch { tag = null; }
  if (!tag) return () => {};
  let sub = null;
  try {
    sub = m.addListener?.('onImagePasted', (ev) => {
      try {
        if (!ev?.uri) return;
        if (ev.viewTag != null && Number(ev.viewTag) !== Number(tag)) return;
        onImage?.(ev);
      } catch {}
    });
  } catch { sub = null; }
  try { Promise.resolve(m.attach(tag)).catch(() => {}); } catch {}
  return () => {
    try { sub?.remove?.(); } catch {}
    try { Promise.resolve(m.detach?.(tag)).catch(() => {}); } catch {}
  };
}

function clip() {
  if (Platform.OS === 'web') return null;
  try { return require('expo-clipboard'); } catch { return null; }
}

/** Há imagem na área de transferência? (não lê o conteúdo) */
export async function clipboardHasImage() {
  const C = clip();
  if (!C || typeof C.hasImageAsync !== 'function') return false;
  try { return !!(await C.hasImageAsync()); } catch { return false; }
}

/** Assina mudanças da área de transferência; cb(hasImageHint|null). */
export function onClipboardChange(cb) {
  const C = clip();
  if (!C || typeof C.addClipboardListener !== 'function') return () => {};
  try {
    const sub = C.addClipboardListener((ev) => {
      try {
        const types = Array.isArray(ev?.contentTypes) ? ev.contentTypes : null;
        cb?.(types ? types.some(x => /image/i.test(String(x))) : null);
      } catch {}
    });
    return () => { try { C.removeClipboardListener?.(sub); } catch {} try { sub?.remove?.(); } catch {} };
  } catch { return () => {}; }
}

/**
 * Lê a imagem da área de transferência e grava em cache.
 * Devolve { uri, name, type, size, width, height } ou null.
 */
export async function readClipboardImageFile() {
  const C = clip();
  if (!C || typeof C.getImageAsync !== 'function') return null;
  let img = null;
  try { img = await C.getImageAsync({ format: 'png' }); } catch { img = null; }
  const data = img?.data || '';
  if (!data) return null;
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(data);
  const mime = m ? m[1].toLowerCase() : 'image/png';
  const b64 = m ? m[2] : data;
  const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : (mime.split('/')[1] || 'png').replace(/[^a-z0-9]/g, '') || 'png';
  try {
    const FS = require('expo-file-system/legacy');
    const dir = FS.cacheDirectory || '';
    if (!dir) return null;
    const name = `colado_${Date.now()}.${ext}`;
    const uri = `${dir}${name}`;
    await FS.writeAsStringAsync(uri, b64, { encoding: 'base64' });
    let size = 0;
    try { const info = await FS.getInfoAsync(uri); size = info?.size || 0; } catch {}
    return {
      uri, name, type: mime, size,
      width: img?.size?.width || 0, height: img?.size?.height || 0,
    };
  } catch {
    return null;
  }
}

/** Monta o descritor de arquivo (mesmo formato do seletor da galeria) a partir do evento nativo. */
export function fileFromNativePaste(ev) {
  if (!ev?.uri) return null;
  const mime = String(ev.mimeType || 'image/png').toLowerCase();
  const ext = mime.includes('gif') ? 'gif' : mime.includes('webp') ? 'webp' : (mime.includes('jpeg') || mime.includes('jpg')) ? 'jpg' : 'png';
  return {
    uri: ev.uri,
    name: `colado_${Date.now()}.${ext}`,
    type: mime,
    size: Number(ev.size) || 0,
    width: Number(ev.width) || 0,
    height: Number(ev.height) || 0,
  };
}
