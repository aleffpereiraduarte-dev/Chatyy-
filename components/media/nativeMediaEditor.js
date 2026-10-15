// [2026-10-15 native-editor] Ponte JS do editor NATIVO de foto/vídeo
// (modules/expo-media-editor). Monta rótulos (i18n), filtros (mesmas matrizes
// do status) e converte o resultado no descritor de arquivo que o envio já usa.
//
// Troca isolada: só liga com o módulo no binário E
// globalThis.__chatyy_native_editor !== false. Qualquer falha → o chamador
// segue no editor JS (MediaPreview/PhotoEditor/VideoTrimBar), idêntico a antes.
import { Platform } from 'react-native';

let _ME;
function me() {
  if (_ME !== undefined) return _ME;
  _ME = null;
  if (Platform.OS === 'web') return null;
  try {
    // eslint-disable-next-line global-require
    _ME = require('../../modules/expo-media-editor');
  } catch {
    _ME = null;
  }
  return _ME;
}

export function nativeEditorAvailable() {
  try {
    if (globalThis.__chatyy_native_editor === false) return false;
  } catch {}
  const m = me();
  try { return !!m && m.isAvailable(); } catch { return false; }
}

export function isVideoFile(f) {
  if (!f) return false;
  return (f.type || '').startsWith('video') || /\.(mp4|mov|webm|avi|mkv|m4v|3gp)(\?|$)/i.test(f.name || f.uri || '');
}

export function isGifFile(f) {
  if (!f) return false;
  return /image\/gif/i.test(f.type || '') || /\.gif(\?|$)/i.test(f.name || f.uri || '');
}

/** Só file:// / content:// / caminho local (o nativo não baixa http nem lê blob:). */
export function isEditableLocal(f) {
  const u = String(f?.uri || '');
  if (!u || f?.blob) return false;
  if (isGifFile(f)) return false;
  return /^(file|content):/i.test(u) || u.startsWith('/');
}

function makeL(t) {
  return (k, fb) => {
    try {
      const s = typeof t === 'function' ? t(k) : null;
      return s && s !== k ? s : fb;
    } catch { return fb; }
  };
}

export function buildLabels(t) {
  const L = makeL(t);
  return {
    close: L('common.close', 'Fechar'),
    cancel: L('common.cancel', 'Cancelar'),
    undo: L('photoEditor.undo', 'Desfazer'),
    crop: L('photoEditor.crop', 'Recortar'),
    filters: L('status.studio.filters', 'Filtros'),
    stickers: L('status.studio.stickers', 'Figurinhas'),
    text: L('photoEditor.text', 'Texto'),
    draw: L('photoEditor.draw', 'Desenhar'),
    rotate: L('photoEditor.rotate', 'Girar'),
    reset: L('status.studio.reset', 'Redefinir'),
    ratioFree: L('photoEditor.ratioFree', 'Livre'),
    ratioOriginal: L('photoEditor.ratioOriginal', 'Original'),
    done: L('photoEditor.done', 'Concluir'),
    send: L('chatConv.send', 'Enviar'),
    captionPlaceholder: L('chatConv.addCaption', 'Adicionar legenda...'),
    viewOnce: L('a11y.viewOnce', 'Visualização única'),
    viewOnceHint: L('chatConv.viewOnceHint', 'Foto/vídeo só pode ser visto uma vez'),
    hdOn: L('chatConv.hdOn', 'Qualidade HD'),
    hdOff: L('chatConv.hdOff', 'Qualidade padrão'),
    soundOn: L('mediaEditor.soundOn', 'Som ativado'),
    soundOff: L('mediaEditor.soundOff', 'Sem som'),
    cover: L('mediaEditor.cover', 'Capa'),
    coverHint: L('mediaEditor.coverHint', 'Escolha o quadro da capa'),
    discardTitle: L('photoEditor.discardTitle', 'Descartar alterações?'),
    discard: L('photoEditor.discard', 'Descartar'),
    processing: L('mediaEditor.processing', 'Preparando…'),
    saveFailed: L('photoEditor.saveFailTitle', 'Não foi possível salvar'),
    textPlaceholder: L('photoEditor.textPlaceholder', 'Digite um texto'),
    font: L('mediaEditor.font', 'Fonte'),
    textBackground: L('mediaEditor.textBackground', 'Fundo do texto'),
    brushSize: L('mediaEditor.brushSize', 'Espessura'),
    fontClassic: L('status.studio.fontClassic', 'Clássico'),
    fontModern: L('status.studio.fontModern', 'Moderno'),
    fontSerif: L('status.studio.fontSerif', 'Serifa'),
    fontMono: L('status.studio.fontMono', 'Máquina'),
    fontStrong: L('status.studio.fontStrong', 'Forte'),
    filterOriginal: L('status.filter.original', 'Original'),
  };
}

let _filtersCache = null;
export function buildFilters(t) {
  const L = makeL(t);
  if (!_filtersCache) {
    try {
      // eslint-disable-next-line global-require
      const { STATUS_FILTERS } = require('../status/statusFilters');
      _filtersCache = (STATUS_FILTERS || []).map(f => ({ id: f.id, labelKey: f.labelKey, m: Array.from(f.m || []) }));
    } catch {
      _filtersCache = [];
    }
  }
  return _filtersCache.map(f => ({ id: f.id, label: L(f.labelKey, f.id), m: f.id === 'original' ? null : f.m }));
}

// Figurinhas = emoji como OBJETO sobre a foto (conteúdo, não UI) — mesma
// lista do editor JS (components/PhotoEditor.js › STICKER_PACKS.emoji) + extras.
export const EDITOR_STICKERS = [
  '\u{1F600}', '\u{1F602}', '\u{1F60D}', '\u{1F973}', '\u{1F525}', '\u{2728}', '\u{2764}\u{FE0F}', '\u{1F44D}',
  '\u{1F44F}', '\u{1F389}', '\u{1F4AF}', '\u{2B50}', '\u{1F60E}', '\u{1F929}', '\u{1F64C}', '\u{1F49C}',
  '\u{1F618}', '\u{1F62D}', '\u{1F631}', '\u{1F914}', '\u{1F644}', '\u{1F64F}', '\u{1F4AA}', '\u{1F339}',
];

/**
 * Abre o editor nativo. Resolve SEMPRE (nunca lança):
 *   { action: 'send' | 'done' | 'cancel' | 'error', uri, width, height, durationMs, ... }
 */
export async function openNativeMediaEditor({
  file, t, mode = 'compose', caption = '', captionMax = 1024,
  viewOnce = false, allowViewOnce = true, hd = false, allowHd = true,
  secure = false, tools = null, context = 'chat',
}) {
  const m = me();
  if (!m || !nativeEditorAvailable() || !file?.uri) return { action: 'error', error: 'unavailable' };
  const video = isVideoFile(file);
  try {
    return await m.open({
      uri: file.uri,
      type: video ? 'video' : 'image',
      mode,
      caption: caption || '',
      captionMax,
      viewOnce: !!viewOnce,
      allowViewOnce: !!allowViewOnce,
      hd: !!hd,
      allowHd: !!allowHd,
      filters: video ? [] : buildFilters(t),
      stickers: EDITOR_STICKERS,
      labels: buildLabels(t),
      maxDim: 3072,
      hdMaxDim: 4096,
      quality: 0.92,
      secure: !!secure,
      tools: tools || (context === 'status' ? { cover: false } : undefined),
    });
  } catch (e) {
    return { action: 'error', error: String(e?.message || e) };
  }
}

/**
 * Resultado → descritor de arquivo do envio (mesmo shape do MediaPreview:
 * { uri, name, type, size, width, height, duration, coverUri }). Sem edição
 * (`edits.changed === false`) devolve o original intacto (sem re-encode).
 */
export function fileFromResult(f, r) {
  if (!f || !r || !r.uri) return f;
  const changed = !!r.edits?.changed && r.uri !== f.uri;
  const out = { ...f };
  if (Number(r.width) > 0 && Number(r.height) > 0) { out.width = Number(r.width); out.height = Number(r.height); }
  if (r.type === 'video' && Number(r.durationMs) > 0) out.duration = Number(r.durationMs);
  if (r.coverUri) { out.coverUri = r.coverUri; out.coverMs = Number(r.coverMs) || 0; }
  if (!changed) return out;
  out.uri = r.uri;
  out._raw = null;
  out.blob = null;
  if (Number(r.size) > 0) out.size = Number(r.size);
  const base = String(f.name || (r.type === 'video' ? 'video' : 'photo')).replace(/\.[a-z0-9]{2,5}$/i, '');
  if (r.type === 'video') {
    const mov = /quicktime/.test(r.mimeType || '');
    out.type = r.mimeType || 'video/mp4';
    out.name = `${base}.${mov ? 'mov' : 'mp4'}`;
  } else {
    out.type = 'image/jpeg';
    out.name = `${base}.jpg`;
  }
  return out;
}

/** Vídeo: o nativo não conseguiu cortar (exportFailed) → tenta o trimVideo antigo. */
export async function fallbackTrim(f, r) {
  try {
    const e = r?.edits || {};
    if (!e.exportFailed || r?.type !== 'video') return f;
    const start = Number(e.trimStartMs) || 0;
    const end = Number(e.trimEndMs) || 0;
    if (!(end > start)) return f;
    // eslint-disable-next-line global-require
    const NV = require('../../modules/expo-native-video');
    if (!NV.isTrimAvailable?.()) return f;
    const tr = await NV.trimVideo(f.uri, start, end);
    if (!tr?.uri) return f;
    const base = String(f.name || 'video').replace(/\.[a-z0-9]{2,5}$/i, '');
    const mov = /quicktime/.test(tr.mimeType || '');
    return { ...f, uri: tr.uri, _raw: null, blob: null, size: tr.size || 0, type: tr.mimeType || 'video/mp4', name: `${base}.${mov ? 'mov' : 'mp4'}`, duration: tr.durationMs || f.duration };
  } catch {
    return f;
  }
}
