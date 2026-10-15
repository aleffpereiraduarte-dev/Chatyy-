// components/native/notesListAdapter.js — [2026-10-15 native-notes]
//
// Adaptador da lista/grade de NOTAS nativa (ChatyyNotesList em
// modules/expo-chat-conversation-list) usada por app/notes.js.
// Linhas PLANAS e curtas para a ponte (patches por id via createPatcher):
//   seção → { id: 's:<chave>', k: 's', t }            (t vazio = só espaço)
//   nota  → { id: 'n:<id>', k: 'n', t, p, d, c, pn, ar, tg, nb, rm, ro, rr, ph }
// Sem emoji; textos já traduzidos pela tela.

import { nativeColor } from '../contacts/contactListAdapter';
import { resultColors } from './resultListAdapter';

const PREVIEW_MAX = 280;

/** Markdown/blocos do editor → texto puro de prévia (1 parágrafo). */
export function notePreviewText(content) {
  let s = String(content || '');
  if (!s) return '';
  if (s.length > 4000) s = s.slice(0, 4000);
  s = s
    .replace(/<[^>]+>/g, ' ')                        // html eventual
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')           // imagens
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')         // links → texto
    .replace(/\[\[([^\]]+)\]\]/g, '$1')              // [[nota]]
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')              // títulos
    .replace(/^\s*>\s?/gm, '')                       // citação
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '')       // checklist
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')       // listas
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, ' ')// separador
    .replace(/`{1,3}/g, '')
    .replace(/(\*\*|__|~~|\*|_)(?=\S)([^*_~\n]*?\S)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX) : s;
}

/** Id da linha nativa ↔ id da nota. */
export const noteRowId = (note) => `n:${note?.id}`;
export const noteIdFromRow = (rowId) => String(rowId || '').replace(/^n:/, '');

/**
 * Linhas da lista (mesmas seções da FlatList JS: Fixadas, Com lembrete, Outras).
 * opts: { pinnedNotes, reminderNotes, otherNotes, activeFilter, activeTab, t,
 *         reminders, formatDate, reminderInfo(reminder) → {label, overdue, repeat} | null }
 */
export function buildNoteRows(opts) {
  const {
    pinnedNotes = [], reminderNotes = [], otherNotes = [], activeFilter, activeTab,
    t, reminders = {}, formatDate, reminderInfo,
  } = opts || {};
  const tr = (k, fb) => { try { const v = t?.(k); return v && v !== k ? v : fb; } catch { return fb; } };
  const untitled = tr('notes.untitled', 'Sem título');
  const rows = [];
  const noteRow = (n) => {
    if (!n || n.id == null) return null;
    let rm = ''; let ro = false; let rr = false;
    const r = reminders[String(n.id)];
    if (r && typeof reminderInfo === 'function') {
      try {
        const info = reminderInfo(r);
        if (info && info.label) { rm = String(info.label); ro = !!info.overdue; rr = !!info.repeat; }
      } catch {}
    }
    const title = String(n.title || '').replace(/\s+/g, ' ').trim();
    const preview = notePreviewText(n.content);
    const row = {
      id: noteRowId(n),
      k: 'n',
      t: title,
      p: preview,
      d: n.updated_at && typeof formatDate === 'function' ? String(formatDate(n.updated_at) || '') : '',
    };
    const c = nativeColor(n.color || '#FFF9C4');
    if (c !== undefined) row.c = c;
    if (n.is_pinned) row.pn = 1;
    if (n.is_archived) row.ar = 1;
    if (Array.isArray(n.tags) && n.tags.length) row.tg = n.tags.slice(0, 4).map((x) => String(x));
    if (n.notebook_name) row.nb = String(n.notebook_name);
    if (rm) { row.rm = rm; if (ro) row.ro = 1; if (rr) row.rr = 1; }
    if (!title && !preview) row.ph = untitled;
    return row;
  };
  const push = (n) => { const r = noteRow(n); if (r) rows.push(r); };

  if (activeFilter === 'pinned') {
    pinnedNotes.forEach(push);
    return rows;
  }
  if (pinnedNotes.length) {
    rows.push({ id: 's:pinned', k: 's', t: tr('notes.pinned', 'Fixadas') });
    pinnedNotes.forEach(push);
  }
  if (reminderNotes.length) {
    rows.push({ id: 's:reminder', k: 's', t: tr('noteReminder.section', 'Com lembrete') });
    reminderNotes.forEach(push);
  }
  if ((pinnedNotes.length || reminderNotes.length) && otherNotes.length) {
    const label = activeTab === 'archived'
      ? tr('notes.archived', 'Arquivadas')
      : (reminderNotes.length ? tr('noteReminder.othersSection', 'Outras') : '');
    rows.push({ id: 's:others', k: 's', t: label });
  }
  otherNotes.forEach(push);
  return rows;
}

/** Ações do toque longo (as mesmas do menu de contexto JS da tela). */
export function buildNoteMenu(t) {
  const tr = (k, fb) => { try { const v = t?.(k); return v && v !== k ? v : fb; } catch { return fb; } };
  return [
    { a: 'edit', t: tr('notes.editNote', 'Editar'), g: 'edit' },
    { a: 'pin', t: tr('notes.pin', 'Fixar'), t2: tr('notes.unpin', 'Desafixar'), g: 'pin' },
    { a: 'archive', t: tr('notes.archive', 'Arquivar'), t2: tr('notes.unarchive', 'Desarquivar'), g: 'archive' },
    { a: 'color', t: tr('notes.changeColor', 'Mudar cor'), g: 'color' },
    { a: 'email', t: tr('notes.sendByEmail', 'Enviar por e-mail'), g: 'mail' },
    { a: 'pdf', t: tr('notes.exportPdf', 'Exportar PDF'), g: 'download' },
    { a: 'copy', t: tr('notes.copyText', 'Copiar texto'), g: 'copy' },
    { a: 'delete', t: tr('notes.deleteNote', 'Apagar'), g: 'trash', x: 1 },
  ];
}

/** Cores do ThemeContext → prop `colors` (ARGB) com o fundo do card. */
export function notesColors(colors, isDark) {
  const c = colors || {};
  const base = resultColors(c, isDark);
  const card = nativeColor(isDark ? (c.surface || '#1C1C1E') : '#FFFFFF');
  const border = nativeColor(isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)');
  if (card !== undefined) base.card = card;
  if (border !== undefined) base.cardBorder = border;
  return base;
}
