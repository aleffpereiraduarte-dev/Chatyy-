// [sgu F4 P-1 2026-10-24] Ações que o servidor RECUSA numa conversa body_store = 3 (409 `sgu_f4_local_only`):
// o PG não tem a mensagem, então fixar / favoritar / encaminhar / agendar / "enviar quando online" / editar em
// claro não têm onde gravar. Desenho: /root/sem-gravar-no-us-2026-10-22/f4/DESENHO.md §7 (P-1).
//
//   - fixar e favoritar: SÓ no aparelho (MMKV por conta). Não chama o servidor. Se o servidor responder 409
//     sgu_f4_local_only (o aparelho ainda não sabia que a conversa é F4), aplica aqui e segue sem erro.
//   - encaminhar de/para F4: mensagem NOVA pelo caminho normal de envio (chatSend → cifra E2EE v5), um destino
//     por vez. O servidor não tem a origem, então chat_forward / chat_forward_multi nunca são chamados.
//   - agendar / enviar quando online: indisponível (resposta local `sgu_f4_local_only`, texto curto).
//   - chat_mark_read / chat_read: `device_id` do aparelho E2EE no corpo (o roteador grava o recibo por aparelho).
//   - filas de reenvio: 409 sgu_f4_local_only é recusa definitiva (sai da fila, sem retry).
//
// Inerte fora da F4: toda decisão começa por f4On() && isF4(cid); sem conversa F4 conhecida não lê nada.
// Kill OTA: globalThis.__chatyy_rt_f4 = false (rtF4.f4On()).

export const CODE = 'sgu_f4_local_only';
export const UNAVAILABLE_MSG = 'Indisponível nesta conversa';
const STAR_KEY = 'chatyy_f4_star_v1';   // { conta: { mid: snapshot } }
const PIN_KEY = 'chatyy_f4_pin_v1';     // { 'conta|cid': { pins: [snapshot + pinned_until], hidden: [mid] } }
const PIN_MAX = 3;
const STAR_MAX = 2000;
const DEV_RE = /^[PWTX][A-Z2-7]{12}$/;

function _F4() { try { return require('./rtF4'); } catch { return null; } }
export function f4On() { const f = _F4(); try { return !!(f && f.f4On()); } catch { return false; } }
export function isF4Conv(cid) {
  if (cid == null || cid === '') return false;
  const f = _F4();
  try { return !!(f && f.f4On() && f.isF4(cid)); } catch { return false; }
}
/** Alguma das conversas é F4 (e o kill não está ligado)? */
export function involves(cids) {
  if (!f4On()) return false;
  return (Array.isArray(cids) ? cids : [cids]).some((c) => isF4Conv(c));
}
function _hasAnyF4() { const f = _F4(); try { return !!(f && f.f4On() && f.f4ConvIds().length > 0); } catch { return false; } }

function _acct() {
  try { const api = require('./api'); return String(api.getActiveAccountEmail?.() || api.getTokenMeta?.()?.email || '').trim().toLowerCase(); } catch { return ''; }
}
function _mmGet(k) { try { const raw = require('./mmkv').getString(k); return raw ? JSON.parse(raw) : {}; } catch { return {}; } }
function _mmSet(k, v) { try { require('./mmkv').setString(k, JSON.stringify(v)); } catch {} }

// ─── 409 sgu_f4_local_only ──────────────────────────────────────────────────
/** Resposta do servidor (ou local) "esta ação fica no aparelho". */
export function isLocalOnly(r) {
  try {
    if (!r || typeof r !== 'object' || r.success !== false) return false;
    return (r.data && r.data.code === CODE) || r.code === CODE || r.error === CODE;
  } catch { return false; }
}
/** Erro lançado por uma fila com a mensagem do servidor ("chat_x_failed: Conversa sem cópia no servidor…"). */
export function isLocalOnlyErr(e) {
  const s = String((e && (e.message || e.code)) || e || '');
  return s.indexOf(CODE) >= 0 || /sem c[oó]pia no servidor|Indispon[ií]vel nesta conversa/i.test(s);
}
/** O servidor disse que a conversa é F4: o aparelho passa a saber (decisões seguintes já não chamam o servidor). */
export function noteF4From(r) {
  try {
    const cid = r && r.data && r.data.conversation_id;
    if (cid == null || !f4On()) return null;
    require('./rtStore').noteConvBodyStore(cid, 3);
    return cid;
  } catch { return null; }
}
/** Resposta local de recusa (agendar, enviar quando online, editar sem E2EE) — texto curto, sem retry. */
export function unavailable(action, cid) {
  return { success: false, code: CODE, error: CODE, message: UNAVAILABLE_MSG, data: { code: CODE, conversation_id: cid != null ? Number(cid) : null, action: String(action || ''), f4_local: 1 } };
}

/** conversation_id de uma mensagem pelo banco local (só se existe conversa F4 conhecida; síncrono, barato). */
export function cidOfMid(mid) {
  if (!(Number(mid) > 0) || !_hasAnyF4()) return null;
  try {
    const db = require('./sqliteStore').getSyncDb();
    if (!db) return null;
    const r = db.getFirstSync('SELECT conversation_id AS c FROM messages WHERE id = ? LIMIT 1', [Number(mid)]);
    return r && r.c != null ? Number(r.c) : null;
  } catch { return null; }
}

// ─── aparelho E2EE no recibo de leitura ─────────────────────────────────────
export function deviceId() {
  try { const d = String(require('./dlvDevice').dlvDeviceIdSync(_acct()) || ''); return DEV_RE.test(d) ? d : ''; } catch { return ''; }
}
/** Corpo do chat_mark_read / chat_read: + device_id só em conversa F4. Nunca muta `params`. */
export function withReadDevice(params, cid) {
  if (!isF4Conv(cid)) return params;
  const d = deviceId();
  return d ? { ...(params || {}), device_id: d } : params;
}

// ─── snapshot mínimo da mensagem (lista de favoritas / faixa de fixadas) ────
function _snap(mid, cid, m) {
  const s = m && typeof m === 'object' ? m : {};
  const content = typeof s.content === 'string' ? s.content.slice(0, 1000) : '';
  const out = { id: Number(mid), conversation_id: cid != null ? Number(cid) : (s.conversation_id != null ? Number(s.conversation_id) : null), content, type: s.type || 'text', f4_local: 1 };
  for (const k of ['sender_email', 'sender_name', 'sender_avatar', 'created_at', 'file_url', 'file_name', 'thumb_url', 'thumbnail_url', 'duration', 'conversation_name']) {
    if (s[k] != null && s[k] !== '') out[k] = s[k];
  }
  return out;
}

// ─── favoritas (só no aparelho) ─────────────────────────────────────────────
export function starLocal(mid, star, cid, msg) {
  const acct = _acct();
  const all = _mmGet(STAR_KEY);
  const mine = all[acct] || {};
  const k = String(mid);
  if (star) mine[k] = { ..._snap(mid, cid, msg), starred_at: new Date().toISOString() };
  else delete mine[k];
  const keys = Object.keys(mine); if (keys.length > STAR_MAX) for (const x of keys.slice(0, keys.length - STAR_MAX)) delete mine[x];
  all[acct] = mine;
  _mmSet(STAR_KEY, all);
  return { success: true, data: { message_id: Number(mid), starred: !!star, f4_local: 1 } };
}
export function isStarredLocal(mid) { const mine = _mmGet(STAR_KEY)[_acct()] || {}; return !!mine[String(mid)]; }
export function starredLocalList() {
  const mine = _mmGet(STAR_KEY)[_acct()] || {};
  return Object.values(mine).sort((a, b) => String(b.starred_at || '').localeCompare(String(a.starred_at || '')));
}
/** chat_starred_messages + favoritas F4 do aparelho (sem duplicar). Sem favorita local: devolve `r` intacta. */
export function mergeStarred(r) {
  try {
    const loc = starredLocalList();
    if (!loc.length || !r || typeof r !== 'object' || r.success === false) return r;
    const d = r.data;
    const list = Array.isArray(d) ? d : (d && Array.isArray(d.items) ? d.items : (d && Array.isArray(d.messages) ? d.messages : null));
    if (!list) return r;
    const seen = new Set(list.map((m) => String(m && m.id)));
    const add = loc.filter((m) => !seen.has(String(m.id)));
    if (!add.length) return r;
    const merged = [...add, ...list].sort((a, b) => String((b && (b.starred_at || b.created_at)) || '').localeCompare(String((a && (a.starred_at || a.created_at)) || '')));
    if (Array.isArray(d)) return { ...r, data: merged };
    return { ...r, data: { ...d, ...(Array.isArray(d.items) ? { items: merged } : { messages: merged }) } };
  } catch { return r; }
}
/** Linhas de mensagem de uma conversa F4: aplica a estrela local (o servidor não sabe). Muta; nunca lança. */
export function applyStarFlags(list, cid) {
  try {
    if (!Array.isArray(list) || !isF4Conv(cid)) return;
    const mine = _mmGet(STAR_KEY)[_acct()] || {};
    if (!Object.keys(mine).length) return;
    for (const m of list) if (m && mine[String(m.id)]) m.starred = true;
  } catch {}
}

// ─── fixadas (só no aparelho) ───────────────────────────────────────────────
function _pinGet(cid) { const all = _mmGet(PIN_KEY); return { all, k: `${_acct()}|${cid}`, cur: all[`${_acct()}|${cid}`] || { pins: [], hidden: [] } }; }
function _alive(p, now) { const t = p && p.pinned_until ? Date.parse(p.pinned_until) : NaN; return !Number.isFinite(t) || t > now; }
/**
 * Fixar (com duração) / desafixar (sem duração) — idempotente (reenviar não inverte, ao contrário do toggle do
 * servidor). Desafixar também esconde uma fixação que veio do servidor antes da conversa virar F4.
 */
export function pinLocal(cid, mid, durationSeconds, msg) {
  const { all, k, cur } = _pinGet(cid);
  const now = Date.now();
  const id = String(mid);
  let pins = (cur.pins || []).filter((p) => _alive(p, now) && String(p.id) !== id);
  let hidden = (cur.hidden || []).filter((h) => String(h) !== id);
  const pin = !!(durationSeconds && Number(durationSeconds) > 0);
  let pinnedUntil = null;
  if (pin) {
    pinnedUntil = new Date(now + Number(durationSeconds) * 1000).toISOString();
    pins = [{ ..._snap(mid, cid, msg), pinned_until: pinnedUntil, pinned_at: new Date(now).toISOString() }, ...pins].slice(0, PIN_MAX);
  } else {
    hidden = [id, ...hidden].slice(0, 50);
  }
  all[k] = { pins, hidden };
  _mmSet(PIN_KEY, all);
  return { success: true, data: { message_id: Number(mid), pinned: pin, pinned_until: pinnedUntil, f4_local: 1 } };
}
/** chat_pinned_messages de conversa F4: fixadas do aparelho + as antigas do servidor que não foram desafixadas. */
export function mergePinned(cid, r) {
  const { cur } = _pinGet(cid);
  const now = Date.now();
  const hidden = new Set((cur.hidden || []).map(String));
  const local = (cur.pins || []).filter((p) => _alive(p, now));
  const d = r && r.success !== false ? r.data : null;
  const srv = Array.isArray(d) ? d : (d && (Array.isArray(d.items) ? d.items : (Array.isArray(d.messages) ? d.messages : []))) || [];
  const seen = new Set(local.map((p) => String(p.id)));
  const items = [...local, ...srv.filter((p) => p && !hidden.has(String(p.id)) && !seen.has(String(p.id)))].slice(0, PIN_MAX);
  return { success: true, data: { items, f4_local: 1 } };
}

// ─── encaminhar de/para F4 = mensagem nova pelo envio normal ────────────────
function _plainText(m) {
  if (!m || typeof m !== 'object') return null;
  const t = String(m.type || 'text');
  if (t !== 'text') return null;
  const c = m.content;
  if (typeof c !== 'string' || !c.trim()) return null;
  try { if (require('./e2ee/e2ee5').isEnvelope(c)) return null; } catch {}
  if (/^\s*\{"e2e/.test(c)) return null;
  return c;
}
/**
 * Encaminha `mid` para `targets` como mensagens NOVAS. Ordem: (1) e2ee5.forwardClient (recifra o mesmo payload,
 * inclusive mídia sem reenviar bytes, quando a mensagem está decifrada nesta sessão); (2) texto da mensagem
 * (opts.sourceMsg) por api.chatSend — o mesmo caminho de quando o usuário digita (cifra se a conversa é E2EE).
 * Nunca chama chat_forward / chat_forward_multi. → formato do chat_forward_multi: { success, data: { results } }.
 */
export async function forwardAsNew(mid, targets, opts) {
  const ids = (Array.isArray(targets) ? targets : [targets]).filter((x) => x != null && x !== '');
  const src = opts && opts.sourceMsg ? opts.sourceMsg : null;
  const text = _plainText(src);
  const api = require('./api');
  try {
    const e5 = require('./e2ee/e2ee5');
    if (e5.isOn()) {
      const r5 = await e5.forwardClient(mid, ids, { ...(opts || {}), ...(text != null ? { sourceText: text } : {}) });
      if (r5 && r5.data && Array.isArray(r5.data.results)) {
        const bad = r5.data.results.filter((x) => !x.success && x.error === 'e2ee5_forward_unsupported').map((x) => x.conversation_id);
        if (!bad.length || text == null) return r5;
        // destinos que o e2ee5 não soube recifrar: vai o texto pelo envio normal
        const extra = await _sendText(api, text, bad, src);
        const results = r5.data.results.filter((x) => !bad.includes(x.conversation_id)).concat(extra);
        const okN = results.filter((x) => x.success).length;
        return { success: okN > 0, data: { results, success: okN, f4_local: 1 } };
      }
    }
  } catch {}
  if (text == null) {
    return { success: false, code: 'f4_forward_unsupported', message: 'f4_forward_unsupported', data: { code: 'f4_forward_unsupported', results: ids.map((id) => ({ conversation_id: id, success: false, error: 'f4_forward_unsupported' })), success: 0, f4_local: 1 } };
  }
  const results = await _sendText(api, text, ids, src);
  const okN = results.filter((x) => x.success).length;
  return { success: okN > 0, data: { results, success: okN, f4_local: 1 } };
}
async function _sendText(api, text, ids, src) {
  const n = (src && Number(src.forward_count) > 0 ? Number(src.forward_count) : 0) + 1;
  const out = [];
  for (const id of ids) {
    try {
      const r = await api.chatSend(id, text, 'text', null, null, null, null, null, null, { skipRust: true, fwd: n, _e5fwd: true });
      out.push({ conversation_id: id, success: !!(r && r.success), error: r && !r.success ? (r.code || r.message || 'failed') : undefined, message_id: r && r.data ? r.data.id : undefined });
    } catch { out.push({ conversation_id: id, success: false, error: 'network' }); }
  }
  return out;
}
/** Resultado multi → formato do chat_forward (1 destino). */
export function asSingle(r, target) {
  const x = (r && r.data && Array.isArray(r.data.results) && r.data.results[0]) || {};
  const perm = !x.success && /forward_unsupported/.test(String(x.error || '')); // recusa definitiva → a fila descarta
  return { success: !!x.success, code: x.error, message: x.error || '', data: { id: x.message_id, conversation_id: target, f4_local: 1, ...(perm ? { code: String(x.error) } : {}) } };
}
