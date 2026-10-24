// [sgu F4 2026-10-23] Conversa body_store = 3 ("nível WhatsApp"): o servidor principal NÃO tem nenhuma linha de
// mensagem. O aparelho + a fila do roteador regional são a fonte da verdade de ordem (conv_pts), recibos ✓✓/lida,
// reações, apagar para todos e dos contadores da lista. Desenho: /root/sem-gravar-no-us-2026-10-22/f4/DESENHO.md.
//
// Este módulo (OTA-safe, inerte sem conversa body_store 3 conhecida):
//   1. syncConv(cid): `chat_f4_sync {conversation_id, since_pts, device_id}` → itens da fila desde o último pts
//      visto (cursor por conta+aparelho+conversa). Mensagem → rtInbox.ingestItems (grava + persisted, como F2);
//      lápide/apagar → evento 'delete'; reação → agrega por mensagem e emite 'reaction' (o servidor não tem a lista);
//      recibo → 'message_read' / 'message_delivered' / 'chat_read' (meus outros aparelhos). Os handlers que já
//      existem (ChatListTab, chatPersistence, e2ee5, chat-conversation) fazem o resto.
//   2. applyListCounts(resp): chat_list com `f4_counts:"device"` (roteador não respondeu) → não lidas calculadas do
//      SQLite local (mensagens de outros acima do last_read local). Com o bloco `f4` do servidor: guarda peers/pts.
//   3. Gatilhos: WS autenticado, 1º plano (20 s), conversa nova F4, frame `rt_available`.
// Kill OTA: globalThis.__chatyy_rt_f4 = false (nada roda; a conversa ainda funciona pelo WS ao vivo + rt_pull da F2).

import { AppState, Platform } from 'react-native';

const isWeb = Platform.OS === 'web';
export const SYNC_ACTION = 'chat_f4_sync';
const CUR_KEY = 'chatyy_f4_pts_v1';   // { 'conta|aparelho|cid': pts }
const RX_KEY = 'chatyy_f4_rx_v1';     // { 'cid|mid': { 'email|k': enc } }  (reações agregadas no aparelho)
const FG_MS = 20 * 1000;
const PAGE = 300;
const MAX_PAGES = 8;

let _started = false;
let _busy = new Map();          // cid → Promise
let _lastFg = 0;
const _m = { synced: 0, msgs: 0, receipts: 0, reactions: 0, deletes: 0, local_unread: 0, errors: 0 };

function _flag(n) { try { return globalThis[n]; } catch { return undefined; } }
export function f4On() { return _flag('__chatyy_rt_f4') !== false; }
export function isF4(cid) { try { return require('./rtStore').convBodyStore(cid) >= 3; } catch { return false; } }
export function f4ConvIds() { try { const s = require('./rtStore'); return s.rtConvIds().filter((c) => s.convBodyStore(c) >= 3); } catch { return []; } }
export function getRtF4Stats() { return { ..._m, started: _started, convs: f4ConvIds().length }; }

function _acct() {
  try { const api = require('./api'); return String(api.getActiveAccountEmail?.() || api.getTokenMeta?.()?.email || '').trim().toLowerCase(); } catch { return ''; }
}
function _canon(e) { return String(e || '').trim().toLowerCase().replace(/@onemundo\.com\.br$/, '@chatyy.com.br'); }
function _dev(acct) { try { return require('./dlvDevice').dlvDeviceIdSync(acct) || ''; } catch { return ''; } }
function _mmGet(k) { try { const raw = require('./mmkv').getString(k); return raw ? JSON.parse(raw) : {}; } catch { return {}; } }
function _mmSet(k, v) { try { require('./mmkv').setString(k, JSON.stringify(v)); } catch {} }
function _emit(ev, data) { try { require('./websocket').default?._emit?.(ev, data); } catch {} }
function _b64(s) { try { const bin = globalThis.atob ? globalThis.atob(String(s)) : ''; try { return decodeURIComponent(escape(bin)); } catch { return bin; } } catch { return ''; } }
function _envOf(it) { return typeof it.env === 'string' ? it.env : (typeof it.envelope === 'string' ? it.envelope : (it.env_b64 ? _b64(it.env_b64) : '')); }
export function isTomb(env) { return typeof env === 'string' && env.startsWith('{"e2e_del":1'); }

// ─── eventos da fila → handlers que o app já tem ────────────────────────────
function _reaction(cid, it, me) {
  const ref = Number(it.ref || 0);
  if (!(ref > 0)) return;
  const from = _canon(it.from || '');
  const k = `${cid}|${ref}`;
  const all = _mmGet(RX_KEY);
  const cur = all[k] || {};
  const kind = it.rx_type === 'v' ? 'v' : 'r';
  const env = _envOf(it);
  const slot = `${from}|${kind}`;
  if (!env || env.startsWith('{"rx":"remove"')) delete cur[slot]; else cur[slot] = env;
  all[k] = cur;
  const keys = Object.keys(all); if (keys.length > 4000) for (const x of keys.slice(0, keys.length - 4000)) delete all[x];
  _mmSet(RX_KEY, all);
  const reactions = Object.entries(cur).map(([s, enc]) => {
    const [email, kk] = s.split('|');
    return { emoji: (kk === 'v' ? 'v' : '') + enc, enc, count: 1, users: [email] };
  });
  _m.reactions++;
  _emit('reaction', { message: { id: ref, conversation_id: Number(cid), reactions }, id: ref, conversation_id: Number(cid), f4: 1 });
}

function _receipt(cid, it, me) {
  const from = _canon(it.from || '');
  const upto = Number(it.upto_mid || it.ref || 0) || 0;
  _m.receipts++;
  if (from && from === me) {
    // eu li em OUTRO aparelho → zera aqui também
    if (it.rtype === 'r') _emit('chat_read', { conversation_id: Number(cid), reader_email: me, email: me, last_read_id: upto, message_id: upto, f4: 1 });
    return;
  }
  if (it.rtype === 'r') _emit('message_read', { conversation_id: Number(cid), read_by: from, email: from, last_read_id: upto, f4_upto_pts: it.upto, f4: 1 });
  else _emit('message_delivered', { conversation_id: Number(cid), message_ids: upto ? [upto] : [], email: from, delivered_to: from, f4_upto_pts: it.upto, f4: 1 });
}

function _delete(cid, mid, by) {
  if (!(Number(mid) > 0)) return;
  _m.deletes++;
  _emit('delete', { id: Number(mid), conversation_id: Number(cid), deleted: true, deleted_for_all: true, deleted_by: by || '', f4: 1 });
}

/** Aplica um lote de itens de UMA conversa (ordem de pts). Devolve o maior pts visto. */
export async function applyItems(cid, items) {
  const me = _canon(_acct());
  let maxPts = 0;
  const msgs = [];
  const sorted = (Array.isArray(items) ? items : []).slice().sort((a, b) => (Number(a.pts) || 0) - (Number(b.pts) || 0));
  for (const it of sorted) {
    maxPts = Math.max(maxPts, Number(it.pts) || 0);
    const kind = String(it.kind || 'msg');
    try {
      if (kind === 'receipt') _receipt(cid, it, me);
      else if (kind === 'reaction') _reaction(cid, it, me);
      else if (kind === 'delete') _delete(cid, it.ref, it.from);
      else if (kind === 'msg') {
        const env = _envOf(it);
        if (isTomb(env) || it.tomb) _delete(cid, it.mid, it.from);
        else msgs.push({ ...it, cid: Number(cid), envelope: env, kind: 'msg' });
      }
    } catch { _m.errors++; }
  }
  if (msgs.length) {
    try { await require('./rtInbox').ingestItems(msgs); _m.msgs += msgs.length; } catch { _m.errors++; }
  }
  return maxPts;
}

// ─── sincronização por conversa (desde o último pts) ─────────────────────────
export function syncConv(cid, why) {
  if (!f4On() || !isF4(cid)) return Promise.resolve();
  const k = String(cid);
  if (_busy.has(k)) return _busy.get(k);
  const p = (async () => {
    const acct = _acct(); const dev = _dev(acct);
    if (!acct || !dev) return;
    const ck = `${acct}|${dev}|${k}`;
    let since = Number(_mmGet(CUR_KEY)[ck] || 0) || 0;
    const api = require('./api');
    for (let page = 0; page < MAX_PAGES; page++) {
      let r = null;
      try { r = await api.apiCall(SYNC_ACTION, { conversation_id: Number(cid), since_pts: since, device_id: dev, limit: PAGE, why: String(why || '').slice(0, 16) }, 'POST'); } catch { r = null; }
      const d = r && (r.data || r);
      if (!r || r.success === false || !d || !Array.isArray(d.items)) { if (r) _m.errors++; return; }
      const top = await applyItems(cid, d.items);
      const next = Math.max(since, Number(d.cursor_pts) || 0, top);
      if (next > since) { since = next; const c = _mmGet(CUR_KEY); c[ck] = since; _mmSet(CUR_KEY, c); }
      _m.synced++;
      if (!d.more || !d.items.length) break;
    }
  })().catch(() => { _m.errors++; }).finally(() => { _busy.delete(k); });
  _busy.set(k, p);
  return p;
}

export function syncAll(why) {
  if (!f4On()) return Promise.resolve();
  return Promise.all(f4ConvIds().map((c) => syncConv(c, why)));
}

// ─── contadores da lista ────────────────────────────────────────────────────
/** Não lidas do aparelho: mensagens de outros acima do last_read local (nativo). null = não sei (web/sem banco). */
export function localUnreadSync(cid) {
  if (isWeb) return null;
  try {
    const db = require('./sqliteStore').getSyncDb();
    if (!db) return null;
    const me = _canon(_acct());
    const r = db.getFirstSync(
      `SELECT COUNT(*) AS n FROM messages
        WHERE conversation_id = ? AND id > COALESCE((SELECT last_read_message_id FROM conversations WHERE id = ?), 0)
          AND LOWER(COALESCE(sender_email, '')) <> ? AND REPLACE(LOWER(COALESCE(sender_email, '')), '@onemundo.com.br', '@chatyy.com.br') <> ?
          AND COALESCE(deleted, 0) = 0 AND COALESCE(type, 'text') NOT IN ('system', 'call_card')`,
      [Number(cid), Number(cid), me, me]);
    return r ? Number(r.n) || 0 : 0;
  } catch { return null; }
}

/** chat_list: conversa F4 sem contadores do roteador → calcula aqui. Muta a resposta; nunca lança. */
export function applyListCounts(resp) {
  try {
    if (!f4On() || !resp || typeof resp !== 'object') return;
    const list = Array.isArray(resp.data) ? resp.data : (resp.data && Array.isArray(resp.data.conversations) ? resp.data.conversations : null);
    if (!list) return;
    for (const c of list) {
      if (!c || typeof c !== 'object' || Number(c.body_store) < 3) continue;
      if (c.f4_counts === 'device') {
        const n = localUnreadSync(c.id);
        if (n != null) { c.unread_count = n; _m.local_unread++; }
      }
    }
  } catch {}
}

// ─── gatilhos ───────────────────────────────────────────────────────────────
export function ensureStarted() {
  if (_started || !f4On()) return;
  _started = true;
  try {
    const ws = require('./websocket').default;
    ws?.on?.('connection', (ev) => { if (ev && ev.status === 'authenticated') setTimeout(() => syncAll('ws'), 1200); });
    ws?.on?.('rt_available', (d) => { const c = d && (d.conversation_id || d.cid); if (c && isF4(c)) syncConv(c, 'hint'); else syncAll('hint'); });
  } catch {}
  try { AppState.addEventListener('change', (s) => { if (s === 'active' && Date.now() - _lastFg > FG_MS) { _lastFg = Date.now(); syncAll('fg'); } }); } catch {}
  try { require('./rtStore').onRtConvsChange((cid, n, prev) => { if (n >= 3 && prev < 3) syncConv(cid, 'conv'); }); } catch {}
  setTimeout(() => syncAll('boot'), 2000);
}
