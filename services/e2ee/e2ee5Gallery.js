// services/e2ee/e2ee5Gallery.js — [2026-10-22 galeria-e2ee] "Mídia, links e docs" de conversa CIFRADA.
//
// O servidor só guarda ciphertext (sem file_url, sem texto) → chat_shared_items não acha nada.
// A galeria é montada do que já está decifrado NO APARELHO (e2ee5.localEntries: memória, store nativo
// e2e_plain, IndexedDB web), com as linhas da tela aberta + cache local da conversa como índice
// (remetente/data/apagada). Mídia: arquivos decifrados locais (e2ee5Media); o que ainda não está no
// aparelho é pedido em 2º plano (miniatura primeiro) e aberto por e2ee5.mediaFileFor. Links = URLs do
// texto/legenda decifrados (+ link_preview cifrado). Docs = anexo cifrado `t:'file'`.
// Itens no MESMO formato do chat_shared_items (components/MediaGallery), com `_e5: true`.

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

function _E5() { return require('./e2ee5'); }

export function isE2eeConv(convId) {
  try { return !!_E5().isConvE2eeSync(convId); } catch (_) { return false; }
}

function _iso(ts) {
  const n = Number(ts) || 0;
  return n > 0 ? new Date(n).toISOString() : '';
}
function _hidden(r) {
  if (!r) return true; // sem linha (apagada p/ mim / limpa): não aparece
  if (r.deleted_at || r.is_deleted) return true;
  const v = r.is_view_once ?? r.isViewOnce ?? r.view_once;
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}
function _host(u) {
  const m = /^https?:\/\/([^/?#:]+)/i.exec(String(u || ''));
  return m ? m[1].replace(/^www\./i, '').toLowerCase() : '';
}
function _cleanUrl(u) {
  let s = String(u || '');
  while (/[.,;:!?)\]}>'"]$/.test(s)) {
    if (s.endsWith(')') && (s.match(/\(/g) || []).length >= (s.match(/\)/g) || []).length) break;
    s = s.slice(0, -1);
  }
  return s;
}

/** Linhas conhecidas da conversa: as da tela (já decifradas) + cache local (envelopes). */
async function _rowsOf(convId, extraRows) {
  const byId = new Map();
  for (const r of extraRows || []) { if (r && r.id != null && /^\d+$/.test(String(r.id))) byId.set(String(r.id), r); }
  try {
    const cached = await require('../chatCache').getCachedMessages(convId, 5000);
    for (const r of cached || []) { if (r && r.id != null && /^\d+$/.test(String(r.id)) && !byId.has(String(r.id))) byId.set(String(r.id), r); }
  } catch (_) {}
  return Array.from(byId.values());
}

function _mediaItem(e, r, P) {
  const p = e.payload || {};
  const M = P.mainMedia(p);
  if (!M || !M.url || !M.file) return null;
  const t = e.t;
  const kind = t === 'image' ? 'image' : t === 'video' ? (p.round ? 'video_note' : 'video') : t === 'voice' ? 'voice' : t === 'audio' ? 'audio' : t === 'file' ? 'file' : t === 'gif' ? 'image' : null;
  if (!kind) return null;
  let loc = null;
  try { loc = _E5().mediaLocalFor(e.mid, { want: kind === 'image' || kind === 'video' || kind === 'video_note' }) || null; } catch (_) { loc = null; }
  const caption = typeof p.caption === 'string' ? p.caption : '';
  return {
    id: Number(e.mid) || e.mid,
    _e5: true,
    type: kind,
    // file_url = arquivo DECIFRADO local (file:// / blob:) quando já está no aparelho; nunca a URL cifrada
    file_url: (loc && loc.uri) || '',
    thumbnail_url: (loc && (loc.thumb || loc.poster)) || '',
    _e5Thumb: (loc && (loc.thumb || loc.poster)) || '',
    _e5Url: M.url,
    file_name: M.name || (kind === 'voice' ? 'voice.m4a' : ''),
    file_size: Number(M.size) || 0,
    mime_type: M.mime || '',
    duration: Number(M.dur != null ? M.dur : p.dur) || 0,
    thumb_b64: typeof M.lqip === 'string' && M.lqip.length < 6000 ? M.lqip : '',
    content: caption,
    sender_email: (r && r.sender_email) || e.sender || '',
    created_at: (r && r.created_at) || _iso(e.ts),
    conversation_id: r && r.conversation_id,
  };
}

function _textOf(e) {
  const p = e.payload || {};
  let txt = typeof p.body === 'string' ? p.body : (typeof p.caption === 'string' ? p.caption : '');
  try { const ed = _E5().editOf(e.mid, e.sender); if (ed && typeof ed.text === 'string') txt = ed.text; } catch (_) {}
  return txt || '';
}

/**
 * Itens da aba (`media` | `link` | `file` | `audio`) desta conversa cifrada, mais recentes primeiro.
 * extraRows = mensagens da tela aberta (opcional). → Promise<items[]>
 */
export async function localSharedItems(convId, tab, extraRows) {
  if (!convId) return [];
  const E5 = _E5();
  const P = require('./payload');
  const rows = await _rowsOf(convId, extraRows);
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  let entries = [];
  try { entries = await E5.localEntries(convId, rows); } catch (_) { entries = []; }
  const out = [];
  for (const e of entries) {
    const r = byId.get(String(e.mid)) || null;
    if (_hidden(r)) continue;
    const p = e.payload || {};
    if (p.vo) continue; // visualização única nunca entra na galeria
    const t = e.t;
    if (tab === 'link') {
      if (t !== 'text' && !P.MEDIA_T.has(t)) continue;
      const txt = _textOf(e);
      const seen = new Set();
      const lp = p.link_preview && typeof p.link_preview === 'object' ? p.link_preview : null;
      const urls = (txt.match(URL_RE) || []).map(_cleanUrl);
      if (lp && typeof lp.url === 'string' && /^https?:\/\//i.test(lp.url) && !urls.includes(lp.url)) urls.unshift(lp.url);
      for (const u of urls) {
        if (!u || seen.has(u)) continue;
        seen.add(u);
        const same = lp && lp.url === u;
        out.push({
          id: Number(e.mid) || e.mid, _e5: true, url: u, host: _host(u),
          title: same && typeof lp.title === 'string' ? lp.title.slice(0, 200) : '',
          description: same && typeof lp.desc === 'string' ? lp.desc.slice(0, 300) : '',
          site_name: same && typeof lp.site === 'string' ? lp.site.slice(0, 80) : '',
          image: '', favicon: '',
          sender_email: (r && r.sender_email) || e.sender || '',
          created_at: (r && r.created_at) || _iso(e.ts),
        });
      }
      continue;
    }
    if (!P.MEDIA_T.has(t) || t === 'sticker') continue;
    const it = _mediaItem(e, r, P);
    if (!it) continue;
    if (tab === 'media' && (it.type === 'image' || it.type === 'video' || it.type === 'video_note')) out.push(it);
    else if (tab === 'file' && it.type === 'file') out.push(it);
    else if (tab === 'audio' && (it.type === 'audio' || it.type === 'voice')) out.push(it);
  }
  const tsOf = (x) => { const n = Date.parse(String(x.created_at || '').replace(' ', 'T')); return Number.isFinite(n) ? n : 0; };
  out.sort((a, b) => (tsOf(b) - tsOf(a)) || (Number(b.id) - Number(a.id)));
  return out;
}

/** Arquivo decifrado local de um item cifrado (baixa+decifra se preciso) → Promise<uri|null>. */
export async function ensureItemFile(item) {
  if (!item || !item._e5) return null;
  if (item.file_url && /^(file|content|blob):/i.test(item.file_url)) return item.file_url;
  try { const r = await _E5().mediaFileFor(item.id); return (r && r.uri) || null; } catch (_) { return null; }
}

/** fn() quando um arquivo cifrado fica pronto (a galeria repinta as miniaturas). */
export function onMediaReady(fn) {
  try { return require('./e2ee5Media').subscribe(fn); } catch (_) { return () => {}; }
}
