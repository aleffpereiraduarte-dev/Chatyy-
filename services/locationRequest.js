// services/locationRequest.js — [loc-pedido 2026-10-19] Pedido de localização DENTRO da conversa.
//
// Mensagem type='location_request' enviada pelo caminho normal (chat_send → outbox, sync, push).
// content = texto legível ("Pediu sua localização") p/ app antigo; o estado vem em msg.meta
// (string JSON ou objeto): {kind,v,status:'pending'|'shared'|'declined',requester,target,
// expires_at,responded_at,responder,response_message_id,live}. Expirado = pending + 24 h.
//
// Compartilhar = mandar localização (atual ou ao vivo 15 min/1 h/8 h) RESPONDENDO ao pedido:
// o servidor marca 'shared' no chat_send. Recusar = chat_location_request_respond.
// Mudanças chegam pelo WS 'location_request_update' {conversation_id, message_id, meta}.
// Cartão que ficou 'pending' em cache (aparelho offline) → refreshStatuses() (1x por sessão).
//
// Kill switch OTA: globalThis.__chatyy_loc_request === false → menu volta ao pedido antigo
// (mapa de amigos) e o tipo cai no texto/fallback.

export const LOC_REQ_TTL_MS = 24 * 60 * 60 * 1000;

export function locReqEnabled() {
  try { return globalThis.__chatyy_loc_request !== false; } catch { return true; }
}

function _api() { const m = require('./api'); return m.default && m.default.apiCall ? m.default : m; }

export function tr(t, k, fb, vars) {
  let s = fb;
  try { const v = t ? t(k) : ''; if (v && v !== k) s = v; } catch {}
  if (vars && typeof s === 'string') Object.keys(vars).forEach((x) => { s = s.split('{' + x + '}').join(String(vars[x])); });
  return s;
}

export function isLocReq(m) { return !!m && m.type === 'location_request' && !m.deleted_at; }

export function parseMeta(m) {
  if (!m) return {};
  const raw = m.meta;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string' && raw.trim().startsWith('{')) { try { const j = JSON.parse(raw); return j && typeof j === 'object' ? j : {}; } catch {} }
  return {};
}

function _ts(v) { if (!v) return 0; const n = Date.parse(String(v).replace(' ', 'T')); return isNaN(n) ? 0 : n; }

/**
 * Estado efetivo do pedido p/ o cartão.
 * → { status: 'pending'|'shared'|'declined'|'expired', own, live, responseId, meta }
 */
export function locReqState(m, myEmail, now) {
  const meta = parseMeta(m);
  const me = String(myEmail || '').toLowerCase();
  const own = !!me && String(m?.sender_email || meta.requester || '').toLowerCase() === me;
  let status = String(meta.status || 'pending');
  if (status !== 'shared' && status !== 'declined' && status !== 'cancelled') status = 'pending';
  if (status === 'pending') {
    const exp = _ts(meta.expires_at) || (_ts(m?.created_at) ? _ts(m.created_at) + LOC_REQ_TTL_MS : 0);
    if (exp && (now || Date.now()) > exp) status = 'expired';
  }
  return { status, own, live: !!meta.live, responseId: meta.response_message_id || null, meta };
}

/**
 * Textos do cartão. peerName = nome do outro lado da conversa.
 * [v2] title fixo "Pedido de localização"; sub = quem pediu a quem; chip = estado.
 */
export function locReqTexts(t, st, peerName, senderName) {
  const peer = String(peerName || '').trim() || tr(t, 'locReq.someone', 'Contato');
  const who = String(senderName || '').trim() || peer;
  const sub = st.own
    ? tr(t, 'locReq.titleOut', 'Você pediu a localização de {name}', { name: peer })
    : tr(t, 'locReq.titleIn', '{name} pediu sua localização', { name: who });
  let chip = '';
  if (st.status === 'shared') chip = tr(t, 'locReq.chipShared', 'Compartilhada');
  else if (st.status === 'declined') chip = tr(t, 'locReq.declined', 'Recusado');
  else if (st.status === 'cancelled') chip = st.own ? tr(t, 'locReq.chipCancelled', 'Cancelado') : tr(t, 'locReq.cancelledIn', 'Pedido cancelado');
  else if (st.status === 'expired') chip = tr(t, 'locReq.chipExpired', 'Expirado');
  else chip = tr(t, 'locReq.waiting', 'Aguardando resposta');
  return {
    title: tr(t, 'locReq.preview', 'Pedido de localização'),
    sub, chip,
    share: tr(t, 'locReq.share', 'Compartilhar'),
    decline: tr(t, 'locReq.decline', 'Recusar'),
    cancel: tr(t, 'locReq.cancel', 'Cancelar pedido'),
    label: tr(t, 'locReq.preview', 'Pedido de localização'),
  };
}

/** Quem pediu pode cancelar enquanto pendente (e já confirmado no servidor). */
export function locReqCancelable(m, st) {
  return !!m && st.own && st.status === 'pending' && !m._pending && !(typeof m.id === 'string' && m.id.startsWith('tmp_'));
}

// ─── ilustração do mapa (P&B) — mesmos números no JS (react-native-svg) e na lista nativa ──
// Palco 236×120: quarteirões, ruas finas, 1 avenida larga, 1 diagonal, anéis de pulso + pino.
export const MAP_W = 236;
export const MAP_H = 120;
export const MAP_STREETS_H = [22, 58, 96];           // y das ruas horizontais finas
export const MAP_STREETS_V = [34, 92, 168, 206];     // x das ruas verticais finas
export const MAP_AVE_H = 76;                         // avenida horizontal (y, 7 de altura)
export const MAP_AVE_V = 128;                        // avenida vertical (x, 7 de largura)
export const MAP_BLOCKS = [[8, 30, 20, 22], [44, 4, 40, 14], [176, 30, 24, 22], [140, 100, 22, 16]]; // [x,y,w,h] quarteirões claros
export const MAP_DIAG = 'M0 116L70 52L120 30';       // via diagonal (quadrado 120×120 no canto esquerdo do palco)
// Pino (viewBox 24): gota cheia + furo central (pintado na cor do palco).
export const PIN_OUTER = 'M12 1.5C7.6 1.5 4.2 4.9 4.2 9.2C4.2 14.8 12 22.5 12 22.5C12 22.5 19.8 14.8 19.8 9.2C19.8 4.9 16.4 1.5 12 1.5Z';
export const PIN_HOLE = 'M12 6.1A3 3 0 1 1 12 12.1A3 3 0 1 1 12 6.1Z';
export const MAP_BG = '#0b0b0b';

/** O cartão mostra os botões? (só quem recebeu, pedido pendente e já confirmado no servidor). */
export function locReqActionable(m, st) {
  return !!m && !st.own && st.status === 'pending' && !m._pending && !(typeof m.id === 'string' && m.id.startsWith('tmp_'));
}

/** Aplica meta nova numa mensagem (mantém string JSON como veio do servidor). */
export function withMeta(m, meta) {
  if (!m || !meta) return m;
  return { ...m, meta: JSON.stringify(meta) };
}

// ─── API ────────────────────────────────────────────────────────────────────
export async function respond(messageId, action, extra) {
  const api = _api();
  return api.apiCall('chat_location_request_respond', { message_id: messageId, action, ...(extra || {}) }, 'POST');
}

const _checked = new Set();
/** Busca o estado de pedidos que aparecem 'pending' (1x por id por sessão). fn(items). */
export async function refreshStatuses(messages, myEmail) {
  if (!locReqEnabled() || !Array.isArray(messages)) return [];
  const ids = [];
  for (let i = messages.length - 1; i >= 0 && ids.length < 50; i--) {
    const m = messages[i];
    if (!isLocReq(m) || m.id == null || typeof m.id === 'string') continue;
    if (_checked.has(m.id)) continue;
    const st = locReqState(m, myEmail);
    if (st.status !== 'pending') continue;
    _checked.add(m.id);
    ids.push(m.id);
  }
  if (!ids.length) return [];
  try {
    const r = await _api().apiCall('chat_location_request_status', { message_ids: ids }, 'POST');
    const items = r && r.success && r.data && Array.isArray(r.data.items) ? r.data.items : [];
    return items;
  } catch { ids.forEach((x) => _checked.delete(x)); return []; }
}

// ─── tempo real ─────────────────────────────────────────────────────────────
const _subs = new Set();
let _wsAttached = false;
function _ensureWs() {
  if (_wsAttached) return;
  _wsAttached = true;
  try {
    const ws = require('./websocket').default;
    ws.on('location_request_update', (d) => {
      const data = d && d.message_id ? d : (d && d.data && d.data.message_id ? d.data : null);
      if (!data) return;
      for (const fn of Array.from(_subs)) { try { fn(data); } catch {} }
    });
  } catch { _wsAttached = false; }
}
/** fn({conversation_id, message_id, meta}) a cada mudança de estado. */
export function onLocReqUpdate(fn) { _ensureWs(); _subs.add(fn); return () => _subs.delete(fn); }
