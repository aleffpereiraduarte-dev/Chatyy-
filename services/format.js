// Shared formatters — extracted to kill ~50+ inline duplicates across screens.
// Keep these tiny + side-effect-free; UI screens compose them with i18n.

/**
 * Bytes → "1.2 MB" / "560 KB" / "12 B". Returns "—" for invalid.
 * Single source of truth — was duplicated in drive.js, photos.js, backup.js,
 * AttachmentPicker.js with subtle differences (some used 1024 vs 1000, some
 * added "B" suffix, some didn't). Now everyone uses 1024-base + 1 decimal.
 */
// [2026-10-16 polish-r2] "57.3 MB de 1024.0 GB" → "57,3 MB de 1024 GB":
// vírgula decimal fora dos idiomas de ponto (idioma do app em
// globalThis.__chatyyLang, setado pelo LanguageProvider) e sem ",0" inútil.
const _DOT_LANGS = /^(en|zh|ja|ko|he|th|hi|bn|ta|te|mr|ur|ms|fil|tl|sw|am|my|km|ne|si|ga|cy)/i;
function _dec(v) {
  let s = v.toFixed(1);
  if (s.endsWith('.0')) s = s.slice(0, -2);
  let lang = 'pt-BR';
  try { lang = String(globalThis.__chatyyLang || 'pt-BR'); } catch {}
  return _DOT_LANGS.test(lang) ? s : s.replace('.', ',');
}
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${_dec(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${_dec(n / (1024 * 1024))} MB`;
  return `${_dec(n / (1024 * 1024 * 1024))} GB`;
}

// [2026-10-19 plano-consistente] Tamanho de ARMAZENAMENTO (cota/uso) num formato
// só: "81,4 GB de 2 TB" (antes "81.4 GB de 1.95 TB" no medidor e "2.0 TB" no
// nome do plano — cota de 2000 GiB lida de 3 jeitos). Base 1024; ≥ 1000 GB vira
// TB; 1 casa só quando ajuda (< 100 GB / < 10 TB / < 10 MB), sem ",0"; vírgula
// decimal pelo idioma do app.
function _dec1(v) {
  let s = (Math.round(v * 10) / 10).toFixed(1);
  if (s.endsWith('.0')) s = s.slice(0, -2);
  let lang = 'pt-BR';
  try { lang = String(globalThis.__chatyyLang || 'pt-BR'); } catch {}
  return _DOT_LANGS.test(lang) ? s : s.replace('.', ',');
}
export function formatStorage(bytes) {
  const v = Math.max(0, Number(bytes) || 0);
  const KB = 1024; const MB = KB * 1024; const GB = MB * 1024; const TB = GB * 1024;
  if (v >= 1000 * GB) { const tb = v / TB; return (tb >= 10 ? String(Math.round(tb)) : _dec1(tb)) + ' TB'; }
  if (v >= 1000 * MB) { const gb = v / GB; return (gb >= 100 ? String(Math.round(gb)) : _dec1(Math.max(gb, 1))) + ' GB'; }
  if (v >= MB) { const mb = v / MB; return (mb >= 10 ? String(Math.round(mb)) : _dec1(mb)) + ' MB'; }
  if (v >= KB) return Math.round(v / KB) + ' KB';
  return Math.round(v) + ' B';
}

/**
 * "report.final.pdf" → "pdf". Empty for files with no extension.
 */
export function getFileExt(name) {
  if (!name || typeof name !== 'string') return '';
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

// MIME / extension classification — was duplicated in 5+ screens with slightly
// different lists. PHOTO/VIDEO arrays match what photos.js + drive.js used.
export const PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff', 'avif'];
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', '3gp', 'flv'];
export const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac', 'opus'];
export const DOC_EXTENSIONS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods'];

export function isImageMime(mime) {
  return typeof mime === 'string' && mime.toLowerCase().startsWith('image/');
}
export function isVideoMime(mime) {
  return typeof mime === 'string' && mime.toLowerCase().startsWith('video/');
}
export function isAudioMime(mime) {
  return typeof mime === 'string' && mime.toLowerCase().startsWith('audio/');
}
export function isImageExt(name) { return PHOTO_EXTENSIONS.includes(getFileExt(name)); }
export function isVideoExt(name) { return VIDEO_EXTENSIONS.includes(getFileExt(name)); }
export function isAudioExt(name) { return AUDIO_EXTENSIONS.includes(getFileExt(name)); }
export function isDocExt(name)   { return DOC_EXTENSIONS.includes(getFileExt(name)); }

/**
 * Strip HTML tags. Used by compose body counter, email previews, search
 * highlighting. Centralized to avoid each call site reinventing the regex.
 *
 * Critically also strips the CONTENT of <style>, <script>, <head> and HTML
 * comments before removing tags. Without that pre-pass, marketing emails
 * (Serasa, banks, newsletters) leak raw CSS into the inbox preview line
 * (e.g. "p { margin: 0; } .img-responsive { max-width: 100% !important; }").
 */
export function stripHtmlTags(html) {
  if (typeof html !== 'string') return '';
  return html
    // Drop non-visible block content first — the tag-stripper below would
    // otherwise turn each <style> body into plain CSS text in the output.
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Now strip remaining tags.
    .replace(/<[^>]*>/g, '')
    // Decode the bare-minimum HTML entities so previews don't show `&nbsp;`,
    // `&amp;` literally. Full decoding is intentionally avoided to keep this
    // hot path cheap; if a preview slips through with an exotic entity the
    // user will see it, not a security issue.
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Collapse runs of whitespace so the preview is a single tidy line.
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Escape HTML entities for safe text insertion into HTML strings.
 * Use when injecting user content into a string template you'll set as innerHTML.
 */
export function escapeHtml(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
