// components/native/driveListAdapter.js — [2026-10-15 native-drive]
//
// Adaptador da lista de ARQUIVOS nativa (ChatyyDriveList em
// modules/expo-chat-conversation-list): app/drive.js e app/files.js.
// Linhas PLANAS e curtas para a ponte (patches por id via createPatcher):
//   seção → { id, k: 's', t }
//   item  → { id, k: 'r', t, sb, gl, bd, th, vd, st, sh, wn, wu, cv, sw, sl, mn, sel, a11y }
//     gl  = glifo do tipo: folder | image | video | audio | pdf | doc | sheet |
//           slides | zip | code | text | file
//     bd  = selo curto (PDF, XLS…) · th = miniatura (URL; cache em disco no nativo)
//     vd  = vídeo (play por cima da miniatura) · st = favorito · sh = compartilhado
//     wn/wu = linha de aviso (contagem da lixeira) / urgente (vermelho)
//     cv  = chevron (pasta) · sw/sl = ações do swipe à esquerda/direita
//     mn  = ações do toque longo (menu nativo) — tudo "a,b,c" (ids de ação)
// Ações: open | download | share | rename | move | star | delete | restore |
//        purge | more. Os títulos vêm da prop `labels` (i18n da tela).
// O nativo só desenha; a tela resolve o item pelo id (mapa `meta`) e roda os
// fluxos JS de sempre (confirmações, modais, toasts).

import { nativeColors } from '../contacts/contactListAdapter';

const EXT_GLYPH = {
  pdf: 'pdf',
  doc: 'doc', docx: 'doc', odt: 'doc', rtf: 'doc', pages: 'doc',
  xls: 'sheet', xlsx: 'sheet', csv: 'sheet', ods: 'sheet', numbers: 'sheet',
  ppt: 'slides', pptx: 'slides', odp: 'slides', key: 'slides',
  zip: 'zip', rar: 'zip', '7z': 'zip', tar: 'zip', gz: 'zip', tgz: 'zip', bz2: 'zip',
  js: 'code', ts: 'code', jsx: 'code', tsx: 'code', json: 'code', xml: 'code', html: 'code', htm: 'code',
  css: 'code', php: 'code', py: 'code', rb: 'code', java: 'code', kt: 'code', swift: 'code', c: 'code',
  cpp: 'code', h: 'code', go: 'code', rs: 'code', sh: 'code', sql: 'code', yml: 'code', yaml: 'code',
  txt: 'text', md: 'text', log: 'text',
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', heic: 'image', heif: 'image', bmp: 'image', svg: 'image', tif: 'image', tiff: 'image',
  mp4: 'video', mov: 'video', avi: 'video', mkv: 'video', webm: 'video', m4v: 'video', '3gp': 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', opus: 'audio', amr: 'audio',
};

const ICON_TYPE_GLYPH = {
  image: 'image', video: 'video', audio: 'audio', pdf: 'pdf', document: 'doc',
  spreadsheet: 'sheet', presentation: 'slides', archive: 'zip', code: 'code', text: 'text',
};

const BADGE = {
  pdf: 'PDF', doc: 'DOC', docx: 'DOC', xls: 'XLS', xlsx: 'XLS', csv: 'CSV', ppt: 'PPT', pptx: 'PPT',
  zip: 'ZIP', rar: 'RAR', '7z': '7Z', mp3: 'MP3', wav: 'WAV', ogg: 'OGG', txt: 'TXT', json: 'JSON', xml: 'XML',
};

function extOf(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  if (i < 0 || i === s.length - 1) return '';
  return s.slice(i + 1).toLowerCase();
}

/** Glifo do tipo a partir de pasta/icon_type/extensão/mime. */
export function driveGlyph(item) {
  if (!item) return 'file';
  if (item.is_folder || item._type === 'folder') return 'folder';
  const ext = extOf(item.original_name || item.name);
  if (ext && EXT_GLYPH[ext]) return EXT_GLYPH[ext];
  const it = ICON_TYPE_GLYPH[String(item.icon_type || '')];
  if (it) return it;
  const mime = String(item.mime_type || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('spreadsheet') || mime.includes('excel') || mime.includes('csv')) return 'sheet';
  if (mime.includes('presentation') || mime.includes('powerpoint')) return 'slides';
  if (mime.includes('word') || mime.includes('document')) return 'doc';
  if (mime.includes('zip') || mime.includes('compressed') || mime.includes('archive')) return 'zip';
  if (mime.startsWith('text/')) return 'text';
  return 'file';
}

/** Selo curto (PDF/XLS…) para arquivos sem miniatura. */
export function driveBadge(item) {
  if (!item || item.is_folder || item._type === 'folder') return '';
  return BADGE[extOf(item.original_name || item.name)] || '';
}

const _csv = (a) => (Array.isArray(a) ? a.filter(Boolean).join(',') : String(a || ''));

/**
 * Linha de item. `o`: { id, title, sub, thumb, video, starred, shared, warn,
 * warnUrgent, chevron, swipe[], swipeLeft[], menu[], selectable, a11y }.
 */
export function driveRow(item, o) {
  const row = {
    id: String(o.id),
    k: 'r',
    t: String(o.title || ''),
    gl: driveGlyph(item),
  };
  if (o.sub) row.sb = String(o.sub);
  const bd = driveBadge(item);
  if (bd) row.bd = bd;
  if (o.thumb) row.th = String(o.thumb);
  if (o.video) row.vd = 1;
  if (o.starred) row.st = 1;
  if (o.shared) row.sh = 1;
  if (o.warn) { row.wn = String(o.warn); if (o.warnUrgent) row.wu = 1; }
  if (o.chevron) row.cv = 1;
  const sw = _csv(o.swipe); if (sw) row.sw = sw;
  const sl = _csv(o.swipeLeft); if (sl) row.sl = sl;
  const mn = _csv(o.menu); if (mn) row.mn = mn;
  if (o.selectable === false) row.sel = 0;
  if (o.a11y) row.a11y = String(o.a11y);
  return row;
}

export function driveSection(id, title) {
  return { id: `s:${id}`, k: 's', t: String(title || '') };
}

/** Uploads → prop `uploads` [{ id, name, progress (0..100; 0 = indeterminado), state: up|done|error }]. */
export function driveUploads(list) {
  return (Array.isArray(list) ? list : []).map((u, i) => ({
    id: String(u.id != null ? u.id : i),
    name: String(u.name || ''),
    progress: Math.max(0, Math.min(100, Number(u.progress) || 0)),
    state: u.error ? 'error' : (u.done ? 'done' : String(u.state || 'up')),
  }));
}

/** Cores do ThemeContext → prop `colors` (ARGB). */
export function driveColors(colors, isDark) {
  const c = colors || {};
  return nativeColors({
    dark: !!isDark,
    bg: c.background,
    text: c.text,
    sub: c.textSecondary,
    faint: c.textTertiary || c.textSecondary,
    hair: c.borderLight || c.border,
    primary: c.primary,
    onPrimary: c.onPrimary,
    error: c.error || '#FF3B30',
    press: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
    chipBg: isDark ? '#1C1C1E' : '#F1F3F5',
    border: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)',
    card: isDark ? '#111113' : '#FFFFFF',
    selBg: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(17,17,17,0.06)',
  });
}
