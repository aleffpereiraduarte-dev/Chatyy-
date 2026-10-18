// services/mailLocalSearch.js — [2026-10-18 email-local-search]
//
// Busca INSTANTÂNEA no que já está no aparelho: linhas da caixa (remetente,
// para, assunto, prévia) na hora, e corpos em cache (offlineCache, até 200) logo
// em seguida. O resultado do servidor (Meilisearch → IMAP, p95 ~1,9 s) chega
// depois e é mesclado por cima (MailContext.loadEmails). Offline = só local.
//
// Consulta com operador (from:, has:, is:, older_than:…) → null (fica só no
// servidor, que entende a sintaxe).
// Kill switch (OTA): globalThis.__chatyy_mail_local_search = false.
import { getCachedMessageUids, getMessageFromCache } from './offlineCache';

export function isLocalSearchOn() {
  try { return globalThis.__chatyy_mail_local_search !== false; } catch { return true; }
}

function _norm(s) {
  let t = String(s || '').toLowerCase();
  try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch {}
  return t;
}

/** tokens normalizados, ou null se a consulta usa operadores do servidor. */
export function parseLocalQuery(q) {
  const raw = String(q || '').trim();
  if (!raw) return null;
  if (/(^|\s)-?[a-z_]+:\S/i.test(raw)) return null;
  const toks = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(raw))) {
    const tk = _norm(m[1] || m[2]).trim();
    if (tk) toks.push(tk);
  }
  return toks.length ? toks : null;
}

function _rowHay(e) {
  return _norm([
    e.from_name, e.from, e.from_email, e.to, e.cc, e.subject, e.preview, e.snippet,
  ].filter(Boolean).join(' \u0001 '));
}

function _all(hay, toks) {
  for (const t of toks) if (hay.indexOf(t) === -1) return false;
  return true;
}

function _dateKey(e) {
  if (!e) return -Infinity;
  if (Number.isFinite(e.date_ts)) return e.date_ts;
  const t = e.date ? Date.parse(e.date) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}

export function sortByDateDesc(list) {
  return list
    .map((e, i) => ({ e, i, k: _dateKey(e) }))
    .sort((a, b) => (b.k - a.k) || (a.i - b.i))
    .map((x) => x.e);
}

/** Filtra linhas da lista (síncrono). Dedup por uid, ordem por data. */
export function matchLocalRows(rows, q) {
  const toks = parseLocalQuery(q);
  if (!toks) return null;
  const seen = new Set();
  const out = [];
  for (const e of rows || []) {
    if (!e || e._sectionHeader || e.uid == null) continue;
    const k = String(e.uid);
    if (seen.has(k) || String(k).startsWith('local-')) continue;
    seen.add(k);
    if (_all(_rowHay(e), toks)) out.push({ ...e, _localHit: true });
  }
  return sortByDateDesc(out);
}

// Texto normalizado dos corpos (LRU em memória — corpo é imutável).
const _bodyText = new Map();
const BODY_CAP = 300;
function _bodyHay(key, m) {
  if (_bodyText.has(key)) return _bodyText.get(key);
  const d = m && m.data && typeof m.data === 'object' ? m.data : (m || {});
  let text = String(d.body_text || d.body_plain || d.text || '');
  if (!text.trim()) {
    text = String(d.body_html || d.html || d.body || '')
      .replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&[a-z#0-9]+;/gi, ' ');
  }
  const hay = _norm(text.replace(/\s+/g, ' ').slice(0, 30000));
  _bodyText.set(key, hay);
  if (_bodyText.size > BODY_CAP) _bodyText.delete(_bodyText.keys().next().value);
  return hay;
}

function _rowFromMessage(uid, m) {
  const d = m && m.data && typeof m.data === 'object' ? m.data : (m || {});
  const preview = String(d.preview || d.body_text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return {
    uid: d.uid != null ? d.uid : uid,
    from: d.from || d.from_email || '',
    from_name: d.from_name || '',
    to: d.to || '',
    subject: d.subject || '',
    date: d.date || '',
    date_ts: Number.isFinite(d.date_ts) ? d.date_ts : undefined,
    preview,
    seen: d.seen !== false,
    flagged: !!d.flagged,
    has_attachments: Array.isArray(d.attachments) && d.attachments.length > 0,
    labels: Array.isArray(d.labels) ? d.labels : [],
    _localHit: true,
  };
}

/**
 * Procura nos corpos em cache da pasta. `excludeUids` = já achados nas linhas.
 * `isStale()` → aborta no meio (usuário já trocou a consulta).
 */
export async function searchCachedBodies(folder, q, excludeUids, isStale, limit = 60) {
  const toks = parseLocalQuery(q);
  if (!toks) return [];
  const out = [];
  const ex = excludeUids instanceof Set ? excludeUids : new Set();
  const uids = getCachedMessageUids(folder);
  for (const uid of uids) {
    if (out.length >= limit) break;
    if (typeof isStale === 'function' && isStale()) return [];
    if (ex.has(String(uid))) continue;
    let m = null;
    try { m = await getMessageFromCache(uid, folder); } catch {}
    if (!m) continue;
    const d = m.data && typeof m.data === 'object' ? m.data : m;
    const hay = _norm([d.from_name, d.from, d.to, d.cc, d.subject].filter(Boolean).join(' ')) + ' ' + _bodyHay(folder + '|' + uid, m);
    if (_all(hay, toks)) out.push(_rowFromMessage(uid, m));
  }
  return out;
}

/** Une servidor + local (servidor ganha no conteúdo da linha). */
export function mergeSearchResults(serverRows, localRows) {
  const server = Array.isArray(serverRows) ? serverRows : [];
  if (!Array.isArray(localRows) || !localRows.length) return server;
  const have = new Set(server.map((e) => String(e && e.uid)));
  const extra = localRows.filter((e) => e && !have.has(String(e.uid)));
  if (!extra.length) return server;
  return sortByDateDesc([...server, ...extra]);
}
