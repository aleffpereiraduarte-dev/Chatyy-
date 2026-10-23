// [status-rapido 2026-10-23] Mídia de STATUS para EXIBIR (variante leve da CDN)
// vs ORIGINAL (salvar/encaminhar/repostar continuam usando media_url).
//
// O servidor (status-variants.php) grava meta.sv = { v, i | m, p, t, b, ob }:
//   i = foto 1080×1920 webp (~10–25 % do JPEG original de ~1 MB)
//   m = vídeo 720p H.264 faststart (moov no início → toca sem baixar o fim)
//   p = pôster webp do vídeo · t = miniatura 320 webp (~5–15 KB)
// Sem meta.sv (status antigo, job ainda não rodou, kill switch) → tudo igual a antes.
// Kill switch OTA/console: globalThis.__chatyy_status_variants = false.
import { Platform } from 'react-native';
import * as api from './api';

let _cacheMedia = null;
let _localSync = null;
try {
  const mc = require('./mediaCache');
  _cacheMedia = mc.cacheMedia;
  _localSync = mc.getLocalUriSyncJs;
} catch {}

const _CDN_RE = /^https:\/\/media\.chatyy\.com\.br\//i;

export function statusVariantsOn() {
  try { if (globalThis.__chatyy_status_variants === false) return false; } catch {}
  return true;
}

function _abs(raw) {
  if (!raw) return '';
  const s = String(raw).split('\n')[0].trim();
  if (!s) return '';
  if (/^(https?:|file:|content:|data:)/i.test(s)) return s;
  try { return api.getMediaUrl(s) || ''; } catch { return ''; }
}

function _sv(it) {
  if (!statusVariantsOn()) return null;
  const sv = it?.meta?.sv || it?.sv;
  if (!sv || typeof sv !== 'object' || sv.err) return null;
  return sv;
}

function _okUrl(u) { return typeof u === 'string' && _CDN_RE.test(u) ? u : ''; }

/** URL original (a mesma de antes desta mudança). */
export function statusOriginalUrl(it) {
  if (!it) return '';
  const media = it.type === 'image' || it.type === 'video';
  const raw = it.media_url
    || (media && /^(\/|https?:\/\/)/.test(String(it.content || '')) ? String(it.content).split('\n')[0] : '');
  return _abs(raw);
}

/**
 * { uri, original, thumb, poster }
 *   uri     = o que o visualizador deve tocar/pintar (variante quando existe)
 *   thumb   = miniatura leve remota (t320) ou ''
 *   poster  = pôster do vídeo (thumbnail_url do servidor ou p) ou ''
 */
export function statusDisplayMedia(it) {
  const original = statusOriginalUrl(it);
  const sv = _sv(it);
  let uri = original;
  if (sv && original) {
    if (it.type === 'image' && _okUrl(sv.i)) uri = sv.i;
    else if (it.type === 'video' && _okUrl(sv.m)) uri = sv.m;
  }
  const thumb = sv ? _okUrl(sv.t) : '';
  const poster = (it?.thumbnail_url ? _abs(it.thumbnail_url) : '') || (sv ? _okUrl(sv.p) : '') || '';
  return { uri, original, thumb, poster };
}

/** Arquivo local já baixado (variante primeiro, depois o original — ex. meu próprio status). */
export function statusLocalUri(it) {
  if (!_localSync || Platform.OS === 'web') return '';
  const { uri, original } = statusDisplayMedia(it);
  try { return (uri && _localSync(uri)) || (original && original !== uri && _localSync(original)) || ''; } catch { return ''; }
}

export function statusLocalThumb(it) {
  if (!_localSync || Platform.OS === 'web') return '';
  const { thumb } = statusDisplayMedia(it);
  try { return (thumb && _localSync(thumb)) || ''; } catch { return ''; }
}

/**
 * Pré-baixa a mídia de exibição para o disco (mediaCache) → ao abrir, o
 * visualizador nativo recebe localUri file:// e pinta sem rede.
 *   force:true  ignora a regra de download automático em dados móveis.
 * Vídeo só é forçado quando há variante leve (720p) — o original (7+ MB) segue
 * a regra normal de download automático.
 */
export function prefetchStatusItem(it, { force = false, thumbOnly = false } = {}) {
  if (!it || Platform.OS === 'web' || !_cacheMedia) return;
  if (it.type !== 'image' && it.type !== 'video') return;
  try {
    const d = statusDisplayMedia(it);
    if (d.thumb) _cacheMedia(d.thumb, { force: true }).catch(() => {});
    if (thumbOnly) return;
    if (it.type === 'video' && d.poster && !/^data:/i.test(d.poster)) {
      try {
        const { Image: ExpoImg } = require('expo-image');
        ExpoImg?.prefetch?.([d.poster]).catch(() => {});
      } catch {}
    }
    if (!d.uri) return;
    const light = d.uri !== d.original; // variante existe
    const f = it.type === 'video' ? (force && light) : force;
    _cacheMedia(d.uri, f ? { force: true } : undefined).catch(() => {});
  } catch {}
}

/**
 * Ao entrar na aba / na faixa de status: para cada pessoa, a 1ª história NÃO
 * vista (onde o visualizador abre) baixa inteira; as 2 seguintes só miniatura.
 * Limita a `maxGroups` pessoas para não gastar dados à toa.
 */
export function prefetchStatusGroups(groups, { maxGroups = 8, forceFirst = 4 } = {}) {
  if (!Array.isArray(groups) || Platform.OS === 'web') return;
  let n = 0;
  for (const g of groups) {
    if (n >= maxGroups) break;
    const items = Array.isArray(g?.items) ? g.items : (Array.isArray(g?.statuses) ? g.statuses : []);
    if (!items.length) continue;
    let start = items.findIndex((x) => x && !x.viewed);
    if (start < 0) continue; // tudo visto: não pré-baixa
    for (let k = 0; k < 3 && start + k < items.length; k++) {
      const it = items[start + k];
      if (k === 0) prefetchStatusItem(it, { force: n < forceFirst });
      else prefetchStatusItem(it, { thumbOnly: true });
    }
    n++;
  }
}

/** Toque/press-in num anel: a história de abertura + as 2 seguintes, forçado. */
export function prefetchStatusOpen(items, startIndex = 0) {
  if (!Array.isArray(items) || Platform.OS === 'web') return;
  const s = Math.max(0, Number(startIndex) || 0);
  for (let k = 0; k < 3 && s + k < items.length; k++) {
    prefetchStatusItem(items[s + k], { force: true });
  }
}
