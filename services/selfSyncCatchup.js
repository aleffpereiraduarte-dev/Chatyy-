// [2026-10-21 tg3] Catch-up dos eventos de MULTI-APARELHO depois de um full_sync.
//
// Os eventos do canal próprio (chat_user_<email>) ficam em ws_event_log e o
// `resume` do hub os reentrega ao reconectar. Mas quando o atraso passa do teto
// do resume (200 eventos — ex.: noite inteira offline com rascunhos/digitando),
// o hub responde `resume_full_sync`, o app adota o high-water e faz o sync HTTP
// normal (chat_list / chat_sync). Esse sync NÃO cobre o que foi feito no outro
// aparelho e não muda a lista: "apagar p/ mim" (message_hidden), "limpar
// conversa" (chat_cleared), "apagar conversa" (conversation_deleted), arquivar /
// silenciar / fixar (conv_state). Aqui buscamos SÓ esses tipos desde o cursor
// antigo (chat_ws_events?types=…, sem teto de 600 no servidor) e entregamos pelo
// mesmo _handleMessage do WebSocket (os handlers são idempotentes).
//   - conv_state: só o ÚLTIMO de cada conversa (estado final);
//   - eventos com event_id > high-water adotado já chegam ao vivo → ignorados.
// Kill: globalThis.__chatyy_selfsync_catchup = false.

const TYPES = 'conv_state,message_hidden,chat_cleared,conversation_deleted';
const MAX_PAGES = 5;
const PAGE = 200;

let _inflight = false;
let _pending = null; // { from, to } pedido enquanto rodava

function _on() {
  try { return globalThis.__chatyy_selfsync_catchup !== false; } catch { return true; }
}

/**
 * fromEventId: cursor ANTES do full_sync (último event_id que o app viu).
 * toEventId: high-water que o servidor mandou adotar (0 = sem teto).
 * ws: instância do services/websocket (precisa de _handleMessage).
 */
export function catchUpSelfSync(fromEventId, toEventId, ws) {
  const from = Number(fromEventId) || 0;
  const to = Number(toEventId) || 0;
  if (!_on() || from <= 0 || !ws || typeof ws._handleMessage !== 'function') return;
  if (to > 0 && to <= from) return;
  if (_inflight) {
    _pending = _pending
      ? { from: Math.min(_pending.from, from), to: Math.max(_pending.to, to) }
      : { from, to };
    return;
  }
  _inflight = true;
  _run(from, to, ws)
    .catch(() => {})
    .finally(() => {
      _inflight = false;
      const p = _pending;
      _pending = null;
      if (p) setTimeout(() => catchUpSelfSync(p.from, p.to, ws), 500);
    });
}

async function _run(from, to, ws) {
  let api = null;
  try { api = require('./api'); } catch {}
  if (!api || typeof api.apiCall !== 'function') return;
  let cursor = from;
  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    let r = null;
    try {
      r = await api.apiCall('chat_ws_events', { since: cursor, types: TYPES, limit: PAGE }, 'GET');
    } catch { return; }
    const d = r && r.success ? r.data : null;
    if (!d || !Array.isArray(d.events)) return; // servidor antigo/410: nada a fazer
    if (!Array.isArray(d.types)) return;          // servidor sem o filtro: ignoraria types
    for (const e of d.events) {
      if (!e || typeof e !== 'object') continue;
      const id = Number(e.event_id) || 0;
      if (id <= from) continue;
      if (to > 0 && id > to) continue;
      all.push(e);
    }
    const last = Number(d.last_event_id) || 0;
    if (!d.has_more || last <= cursor) break;
    cursor = last;
  }
  if (!all.length) return;
  // conv_state: só o último de cada conversa.
  const lastConvState = new Map();
  all.forEach((e, i) => {
    if (e.type !== 'conv_state') return;
    const dd = e.data && typeof e.data === 'object' ? e.data : e;
    if (dd && dd.conversation_id != null) lastConvState.set(String(dd.conversation_id), i);
  });
  let n = 0;
  all.forEach((e, i) => {
    if (e.type === 'conv_state') {
      const dd = e.data && typeof e.data === 'object' ? e.data : e;
      if (!dd || dd.conversation_id == null || lastConvState.get(String(dd.conversation_id)) !== i) return;
    }
    try { ws._handleMessage({ ...e, resumed: true, via: 'selfsync_catchup' }); n++; } catch {}
  });
  if (__DEV__) { try { console.log('[selfsync_catchup]', n, 'eventos', from, '→', to); } catch {} }
}

export default catchUpSelfSync;
