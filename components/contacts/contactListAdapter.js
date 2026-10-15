// components/contacts/contactListAdapter.js — [2026-10-15 native-contacts]
//
// Adaptador da lista de CONTATOS nativa (ChatyyContactList em
// modules/expo-chat-conversation-list). Transforma as `sections` que as telas já
// montam para a SectionList (app/contacts.js "Meus contatos" e app/chat-new.js
// lista padrão) numa sequência PLANA de linhas para a ponte:
//   seção   → { id: 's:<key>', k: 's', t, sbg, sfg, bar, up, fs, fw, pt, pb, ph, hl, ls, ix }
//   contato → { id, k: 'r', t, tw, sx, vb, nb, sb, sbt, un, s2, s2t, s2i, ch, me,
//               tiles, on, av, ar, gl, gbg, pl, pf, pi, pb, st, tr, ck, sw, tap, lp, a11y }
// O nativo só desenha; ações voltam por id e a tela resolve o item em `meta`.
// Patches incrementais = createPatcher do nativeAdapter (home).

import { processColor } from 'react-native';
import { initialsOf, gradientIndex } from '../chatlist/nativeAdapter';

function _lazy(fn) {
  let v; let done = false;
  return () => { if (!done) { done = true; try { v = fn(); } catch { v = null; } } return v; };
}
const _avatarSvc = _lazy(() => require('../../services/avatar'));
const _avatarCache = _lazy(() => require('../../services/avatarCache'));

const _EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Ladrilho do avatar (mesmas regras do AvatarCircle / nativeAdapter._tile). */
export function contactTile(email, name) {
  const e = String(email || '').trim();
  const n = String(name || '');
  let url = '';
  if (e && _EMAIL_RE.test(e) && e.toLowerCase() !== 'ai@chatyy.com.br') {
    try { url = (_avatarSvc()?.buildAvatarUrl && _avatarSvc().buildAvatarUrl(e, { name: n })) || ''; } catch { url = ''; }
  }
  let u = '';
  let a = false;
  if (url) {
    u = url;
    try {
      const local = _avatarCache()?.getCachedAvatarUriOrNull ? _avatarCache().getCachedAvatarUriOrNull(url) : null;
      if (local) u = local;
    } catch {}
    if (u === url) {
      try { a = !!(_avatarSvc()?.avatarAuthHeaders && _avatarSvc().avatarAuthHeaders(url)); } catch { a = false; }
    }
  }
  const tile = { u, i: initialsOf(n, e), g: gradientIndex(n || e || '') };
  if (a) tile.a = 1;
  return [tile];
}

/** Cor do RN → número ARGB (o que o nativo lê); undefined quando inválida. */
export function nativeColor(c) {
  if (c == null || c === '') return undefined;
  try {
    const v = processColor(c);
    return typeof v === 'number' ? v : undefined;
  } catch { return undefined; }
}

/** Mapa de cores da tela → prop `colors` do nativo. */
export function nativeColors(map) {
  const out = {};
  for (const k of Object.keys(map || {})) {
    if (k === 'dark') { out.dark = !!map.dark; continue; }
    const v = nativeColor(map[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * sections [{ key, title, data }] → { rows, meta }.
 *   sectionRow(section, index) → campos visuais da seção (t, bar, up, fs…, ix) ou null (sem cabeçalho)
 *   itemRow(item, section, index) → { key, row } (row sem id/k) ou null (pula)
 * Ids: 's:<section.key|index>' p/ seções; '<section.key>|<item key>' p/ contatos
 * (o mesmo contato pode aparecer em 2 seções: "Recentes" + letra).
 */
export function buildFlatRows(sections, sectionRow, itemRow) {
  const rows = [];
  const meta = new Map();
  const seen = new Set();
  (Array.isArray(sections) ? sections : []).forEach((sec, si) => {
    if (!sec) return;
    const skey = String(sec.key != null ? sec.key : `${si}:${sec.title || ''}`);
    let sr = null;
    try { sr = sectionRow(sec, si); } catch { sr = null; }
    if (sr) {
      const id = `s:${skey}`;
      if (!seen.has(id)) {
        seen.add(id);
        rows.push({ ...sr, id, k: 's' });
        meta.set(id, { section: sec });
      }
    }
    const data = Array.isArray(sec.data) ? sec.data : [];
    data.forEach((item, ii) => {
      let r = null;
      try { r = itemRow(item, sec, ii); } catch { r = null; }
      if (!r || !r.row) return;
      let id = `${skey}|${r.key != null && r.key !== '' ? r.key : ii}`;
      if (seen.has(id)) id = `${id}#${ii}`;
      seen.add(id);
      rows.push({ ...r.row, id, k: 'r' });
      meta.set(id, { item, section: sec });
    });
  });
  return { rows, meta };
}
