// components/email/emailNativeAdapter.js — [2026-10-15 native-inbox]
//
// Adaptador da caixa de entrada NATIVA (modules/expo-chat-conversation-list,
// view ChatyyEmailList). Converte cada item do EmailList (e-mail ou cabeçalho
// de seção) numa linha PLANA pronta para desenhar — mesmas regras do
// components/EmailRow.js (hora relativa, prévia limpa, rótulos com cor,
// "Responder? N dias", "Adiado") — e reaproveita o patcher incremental da home
// (components/chatlist/nativeAdapter.js#createPatcher).

import { initialsOf, gradientIndex } from '../chatlist/nativeAdapter';

// ── cor → número 0xAARRGGBB (o nativo não interpreta CSS) ────────────────────
const _NAMED = { white: 0xFFFFFFFF, black: 0xFF000000, transparent: 0x00000000 };

export function toArgb(c) {
  if (c == null) return undefined;
  if (typeof c === 'number' && isFinite(c)) return c >>> 0;
  const s = String(c).trim().toLowerCase();
  if (!s) return undefined;
  if (Object.prototype.hasOwnProperty.call(_NAMED, s)) return _NAMED[s];
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map(x => x + x).join('');
    if (h.length === 6) return (0xFF000000 + parseInt(h, 16)) >>> 0;
    if (h.length === 8) {
      // CSS = RRGGBBAA → ARGB
      const rgb = parseInt(h.slice(0, 6), 16);
      const a = parseInt(h.slice(6, 8), 16);
      return ((a << 24) >>> 0) + rgb;
    }
    return undefined;
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(x => x.trim());
    if (p.length < 3) return undefined;
    const ch = (x) => Math.max(0, Math.min(255, Math.round(x.endsWith('%') ? parseFloat(x) * 2.55 : parseFloat(x))));
    const r = ch(p[0]); const g = ch(p[1]); const b = ch(p[2]);
    let a = p.length > 3 ? parseFloat(p[3]) : 1;
    if (p.length > 3 && p[3].endsWith('%')) a = parseFloat(p[3]) / 100;
    if (!isFinite(a)) a = 1;
    const A = Math.max(0, Math.min(255, Math.round(a * 255)));
    return ((A << 24) >>> 0) + (r << 16) + (g << 8) + b;
  }
  return undefined;
}

/** Paleta do ThemeContext (mesmas cores do EmailRow JS). */
export function buildPalette(colors) {
  const c = colors || {};
  const out = {
    bg: toArgb(c.surface),
    sectionBg: toArgb(c.background),
    text: toArgb(c.text),
    sub: toArgb(c.textSecondary),
    faint: toArgb(c.textTertiary),
    hair: toArgb(c.borderLight),
    selectedBg: toArgb(c.selectedBg),
    primary: toArgb(c.primary),
    star: toArgb(c.starColor),
    starEmpty: toArgb(c.starEmpty),
    variant: toArgb(c.surfaceVariant),
    checkOn: toArgb(c.selectedCheckbox || c.primary),
    checkOff: toArgb(c.checkboxColor || c.textSecondary),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** Rótulos dos menus/swipes (todas as chaves já existem no i18n). */
export function buildLabels(t) {
  const tx = (k, fb) => {
    try { const v = t(k); return (typeof v === 'string' && v && v !== k) ? v : fb; } catch { return fb; }
  };
  return {
    reply: tx('contextMenu.reply', 'Responder'),
    replyAll: tx('contextMenu.replyAll', 'Responder a todos'),
    forward: tx('contextMenu.forward', 'Encaminhar'),
    markRead: tx('contextMenu.markRead', 'Marcar como lido'),
    markUnread: tx('contextMenu.markUnread', 'Marcar como não lido'),
    star: tx('contextMenu.star', 'Favoritar'),
    unstar: tx('contextMenu.unstar', 'Remover estrela'),
    snooze: tx('contextMenu.snooze', 'Adiar'),
    mute: tx('contextMenu.mute', 'Silenciar conversa'),
    unmute: tx('contextMenu.unmute', 'Reativar conversa'),
    moveTo: tx('contextMenu.moveTo', 'Mover para'),
    archive: tx('contextMenu.archive', 'Arquivar'),
    spam: tx('contextMenu.spam', 'Denunciar spam'),
    delete: tx('contextMenu.delete', 'Excluir'),
    select: tx('a11y.select', 'Selecionar'),
  };
}

// ── avatar (mesma URL/cache do AvatarCircle) ─────────────────────────────────
const _EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function _tile(ctx, name, email) {
  let u = '';
  let a = false;
  if (email && _EMAIL_RE.test(email)) {
    let url = '';
    try { url = (ctx.buildAvatarUrl && ctx.buildAvatarUrl(email, { name })) || ''; } catch { url = ''; }
    if (url) {
      u = url;
      try {
        const local = ctx.getCachedAvatarUriOrNull ? ctx.getCachedAvatarUriOrNull(url) : null;
        if (local) u = local;
      } catch {}
      if (u === url) {
        try { a = !!(ctx.avatarAuthHeaders && ctx.avatarAuthHeaders(url)); } catch { a = false; }
      }
    }
  }
  const tile = { u, i: initialsOf(name, email), g: gradientIndex(name || email || '') };
  if (a) tile.a = 1;
  return tile;
}

function _labelChips(labels, LABEL_COLORS) {
  const out = [];
  for (const lbl of (Array.isArray(labels) ? labels : []).slice(0, 2)) {
    const name = (typeof lbl === 'object' && lbl !== null) ? (lbl.name || '') : String(lbl || '');
    if (!name) continue;
    const c = (LABEL_COLORS && LABEL_COLORS[name]) || (lbl && lbl.color
      ? { bg: lbl.color + '22', text: lbl.color, border: lbl.color }
      : (LABEL_COLORS && LABEL_COLORS.cinza) || { bg: '#f5f5f5', text: '#616161', border: '#616161' });
    const chip = { n: name };
    const bg = toArgb(c.bg); const fg = toArgb(c.text); const bd = toArgb(c.border);
    if (bg !== undefined) chip.bg = bg;
    if (fg !== undefined) chip.fg = fg;
    if (bd !== undefined) chip.bd = bd;
    out.push(chip);
  }
  return out;
}

function _fullDate(dateStr, language) {
  if (!dateStr) return '';
  try {
    let str = String(dateStr);
    if (!str.includes('T') && !str.includes('+') && !str.endsWith('Z') && str.includes(' ')) str = str.replace(' ', 'T') + 'Z';
    const d = new Date(str);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(language || undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

export function emailRowId(item, index) {
  if (item && item._sectionHeader) return `§${item._key || item._sectionKey || index}`;
  if (item && item.uid != null && item.uid !== '') return String(item.uid);
  return `tmp_${index}`;
}

/** Item do EmailList (e-mail ou seção) → linha nativa. */
export function buildEmailRow(item, index, ctx) {
  const id = emailRowId(item, index);
  if (item._sectionHeader) {
    let title = '';
    try { title = ctx.t(item._sectionKey) || ''; } catch {}
    return { id, kind: 'section', title: String(title) };
  }
  const t = ctx.t;
  const unread = !item.seen;
  const fromName = item.from_name || item.from || '';
  let subject = item.subject || '';
  if (!subject) { try { subject = t('reader.noSubject'); } catch { subject = ''; } }
  let time = '';
  try { time = ctx.formatRelativeDate(item.date, t) || item.date_short || item.date || ''; } catch { time = item.date_short || ''; }
  let preview = '';
  if (item.preview) { try { preview = ctx.cleanPreview(item.preview); } catch { preview = ''; } }
  let nudge = '';
  if (ctx.currentFolder === 'INBOX' && unread && item.date) {
    const d = new Date(item.date);
    if (!isNaN(d.getTime())) {
      const days = Math.floor((Date.now() - d.getTime()) / 86400000);
      if (days >= 3) { try { nudge = t('nudge.reply', { n: days }) || ''; } catch {} }
    }
  }
  let snoozed = '';
  if (ctx.currentFolder === 'Snoozed') { try { snoozed = t('snooze.snoozed') || ''; } catch {} }
  const row = {
    id,
    kind: 'email',
    from: String(fromName),
    fromEmail: String(item.from || ''),
    subject: String(subject),
    preview: String(preview).slice(0, 400),
    time: String(time),
    dateFull: _fullDate(item.date, ctx.language),
    tiles: [_tile(ctx, fromName, item.from || '')],
  };
  if (unread) row.unread = 1;
  if (item.flagged) row.starred = 1;
  if (item.has_attachments || (item.attachments && item.attachments.length > 0)) row.attach = 1;
  if (ctx.mutedUids && ctx.mutedUids.has && ctx.mutedUids.has(String(item.uid))) row.muted = 1;
  if (item.thread_count > 1) row.thread = Number(item.thread_count) || 0;
  const chips = _labelChips(item.labels, ctx.LABEL_COLORS);
  if (chips.length) row.chips = chips;
  if (ctx.selectedUids && ctx.selectedUids.has && ctx.selectedUids.has(item.uid)) row.checked = 1;
  if (ctx.selectedUid != null && ctx.selectedUid === item.uid) row.active = 1;
  if (snoozed) row.snoozed = snoozed;
  if (nudge) row.nudge = nudge;
  let unreadLbl = '';
  if (unread) { try { unreadLbl = t('a11y.unread') || 'Unread'; } catch { unreadLbl = 'Unread'; } }
  row.a11y = `${unreadLbl ? unreadLbl + ' ' : ''}${fromName}, ${subject}${time ? ', ' + time : ''}`.trim();
  return row;
}

/** Igualdade rasa por campo (chips/tiles comparados por JSON curto). */
export function emailRowEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a); const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const va = a[k]; const vb = b[k];
    if (va === vb) continue;
    if (typeof va === 'object' && typeof vb === 'object') {
      if (JSON.stringify(va) !== JSON.stringify(vb)) return false;
      continue;
    }
    return false;
  }
  return true;
}

/** Corpo em texto para a prévia (peek) a partir do cache do e-mail. */
export function bodyTextFromCached(m) {
  if (!m || typeof m !== 'object') return '';
  const d = m.data && typeof m.data === 'object' ? m.data : m;
  let text = String(d.body_text || d.body_plain || d.text || '').trim();
  if (!text) {
    const html = String(d.body_html || d.html || d.body || '');
    text = html
      .replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
      .replace(/&[a-z#0-9]+;/gi, ' ');
  }
  return text.replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n\s*\n\s*\n+/g, '\n\n').trim().slice(0, 2400);
}
