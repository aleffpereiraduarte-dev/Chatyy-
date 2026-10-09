// [2026-10-09 native-docs] Documents without Google.
//
// Before: Office files (and PDFs on old Android binaries) were rendered by
// pointing a WebView at docs.google.com/viewer?url=<attachment URL>. That URL
// can carry the perpetual auth token (Drive: drive_download&token=…), so the
// token went to Google; it was also slow and never worked offline.
//
// Now the file is downloaded to the app cache and opened ON DEVICE:
//   1. ExpoChatyyDocPreview (next binary): iOS QuickLook / Android ACTION_VIEW
//      through the FileProvider (system "Open with").
//   2. Current binary fallbacks (no new native code):
//      - iOS: WKWebView renders Office/iWork/RTF/CSV from a LOCAL file:// URL
//        natively (same engine as QuickLook) — see NativeDocPreview.
//      - Android / anything else: expo-sharing share sheet with the local file
//        (Word, WPS, Drive, Files… all accept it).
// Nothing here ever builds a third-party viewer URL.
import { Platform } from 'react-native';

const MIME = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  txt: 'text/plain',
  csv: 'text/csv',
  pages: 'application/vnd.apple.pages',
  numbers: 'application/vnd.apple.numbers',
  key: 'application/vnd.apple.keynote',
};

// iOS UTIs for the share sheet (helps "Open in Word/Pages" suggestions).
const UTI = {
  pdf: 'com.adobe.pdf',
  doc: 'com.microsoft.word.doc',
  docx: 'org.openxmlformats.wordprocessingml.document',
  xls: 'com.microsoft.excel.xls',
  xlsx: 'org.openxmlformats.spreadsheetml.sheet',
  ppt: 'com.microsoft.powerpoint.ppt',
  pptx: 'org.openxmlformats.presentationml.presentation',
  rtf: 'public.rtf',
  txt: 'public.plain-text',
  csv: 'public.comma-separated-values-text',
};

// Formats WKWebView renders natively from a local file (iOS).
const IOS_WEBVIEW_EXTS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'txt', 'csv', 'pages', 'numbers', 'key'];

export function docExt(filename, url) {
  const fromName = String(filename || '').split('?')[0];
  if (fromName.includes('.')) return fromName.split('.').pop().toLowerCase();
  const fromUrl = String(url || '').split(/[?#]/)[0];
  return fromUrl.includes('.') ? fromUrl.split('.').pop().toLowerCase() : '';
}

export function docMime(filename, url) {
  return MIME[docExt(filename, url)] || 'application/octet-stream';
}

export function iosWebViewCanRender(filename, url) {
  return IOS_WEBVIEW_EXTS.includes(docExt(filename, url));
}

let _mod;
// Native QuickLook / ACTION_VIEW bridge of the installed binary, or null.
export function docPreviewModule() {
  if (_mod !== undefined) return _mod;
  _mod = null;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return _mod;
  try {
    const { requireOptionalNativeModule } = require('expo');
    const m = requireOptionalNativeModule('ExpoChatyyDocPreview');
    if (m && typeof m.preview === 'function') _mod = m;
  } catch {}
  return _mod;
}

export function hasNativeDocPreview() {
  return !!docPreviewModule();
}

function _hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function _safeName(filename, ext) {
  let n = String(filename || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  if (!n) n = 'documento' + (ext ? '.' + ext : '');
  if (ext && !n.toLowerCase().endsWith('.' + ext)) n += '.' + ext;
  return n.slice(-120);
}

const _inflight = new Map();

// Download `url` into the cache (once per URL) and resolve the local file:// URI.
// Local URIs pass through. Throws on HTTP errors / HTML responses (SPA fallback).
export async function ensureLocalDocument(url, filename, headers) {
  const u = String(url || '');
  if (!u) throw new Error('no_url');
  if (/^file:/i.test(u)) return u;
  if (Platform.OS === 'web') throw new Error('web');
  if (_inflight.has(u)) return _inflight.get(u);
  const p = (async () => {
    const FileSystem = require('expo-file-system/legacy');
    const ext = docExt(filename, u);
    // Strip auth query params from the cache key so a rotated token still hits.
    const key = _hash(u.replace(/([?&])(token|dl|sig|expires)=[^&]*/gi, '$1'));
    const dir = FileSystem.cacheDirectory + 'docs/' + key + '/';
    const dest = dir + _safeName(filename, ext);
    try {
      const info = await FileSystem.getInfoAsync(dest);
      if (info?.exists && (info.size || 0) > 0) return dest;
    } catch {}
    try { await FileSystem.makeDirectoryAsync(dir, { intermediates: true }); } catch {}
    const r = await FileSystem.downloadAsync(u, dest, headers ? { headers } : undefined);
    const status = r?.status || 0;
    const ctype = String((r?.headers && (r.headers['Content-Type'] || r.headers['content-type'])) || '');
    if (status < 200 || status >= 300 || (/text\/html/i.test(ctype) && ext !== 'html' && ext !== 'htm')) {
      try { await FileSystem.deleteAsync(dest, { idempotent: true }); } catch {}
      const e = new Error('http_' + status);
      e.status = status;
      throw e;
    }
    return dest;
  })();
  _inflight.set(u, p);
  try { return await p; } finally { _inflight.delete(u); }
}

// Open a document with the system (QuickLook / "Open with" / share sheet).
// Resolves 'native' | 'share' | false. Never throws.
export async function openDocumentWithSystem({ url, filename, mimeType, headers, dialogTitle } = {}) {
  if (Platform.OS === 'web') {
    try { if (url && typeof window !== 'undefined') window.open(url, '_blank', 'noopener'); return 'share'; } catch { return false; }
  }
  let local;
  try { local = await ensureLocalDocument(url, filename, headers); } catch { return false; }
  const ext = docExt(filename, url);
  const mime = mimeType || MIME[ext] || 'application/octet-stream';
  const mod = docPreviewModule();
  if (mod) {
    try {
      const ok = Platform.OS === 'android'
        ? await mod.preview(local, mime, filename || null)
        : await mod.preview(local, filename || null);
      if (ok) return 'native';
    } catch {}
  }
  try {
    const Sharing = require('expo-sharing');
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(local, { mimeType: mime, UTI: UTI[ext], dialogTitle: dialogTitle || filename || undefined });
      return 'share';
    }
  } catch {}
  return false;
}
