// Shared formatters — extracted to kill ~50+ inline duplicates across screens.
// Keep these tiny + side-effect-free; UI screens compose them with i18n.

/**
 * Bytes → "1.2 MB" / "560 KB" / "12 B". Returns "—" for invalid.
 * Single source of truth — was duplicated in drive.js, photos.js, backup.js,
 * AttachmentPicker.js with subtle differences (some used 1024 vs 1000, some
 * added "B" suffix, some didn't). Now everyone uses 1024-base + 1 decimal.
 */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
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
 */
export function stripHtmlTags(html) {
  if (typeof html !== 'string') return '';
  return html.replace(/<[^>]*>/g, '');
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
