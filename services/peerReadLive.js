// [2026-10-17 visto-lista-conversa] Watermark de leitura AO VIVO do(s) peer(s),
// GLOBAL (fora de qualquer tela).
//
// Bug (founder 17/10 13:50Z, conv 952): a LISTA pintou ✓✓ azul (recebeu o
// evento chat_read às 13:50:07.14) mas a CONVERSA aberta 1 s depois ficou em
// ✓✓ cinza. A conversa só conhecia o evento se estivesse MONTADA quando ele
// chegou (peerReadLiveRef era por-tela); ao abrir, o chat_messages veio da
// réplica do edge BR (atrasada < ~1 s em relação ao master logo após a leitura)
// → read_receipts/read_by velhos → cinza, e nenhum evento novo viria.
//
// Agora todo chat_read / message_read que passa pelo transporte (WS do hub ou
// TCP) é anotado aqui, com a mesma regra peer-only de sempre (o MEU próprio
// recibo nunca entra — causa raiz dos "azul falso" antigos). A conversa semeia
// o piso de 2 min com isto ao montar, e a lista usa o mesmo piso ao trocar a
// linha por um snapshot do chat_list. Mesma fonte → lista e conversa concordam.
//
// Só memória (o servidor volta a ser a verdade após o TTL; nada gruda).

const TTL_MS = 120000;
const MAX_CONVS = 300;
const _m = new Map(); // `${me}|${conv}` → Map(peerLc → { id, at })
const _subs = new Set();

function _k(me, convId) { return `${String(me || '').trim().toLowerCase()}|${String(convId)}`; }

export function notePeerReadLive(me, convId, peer, readId) {
  const meLc = String(me || '').trim().toLowerCase();
  const p = String(peer || '').trim().toLowerCase();
  const n = Number(readId);
  if (!meLc || !p || p === meLc || convId == null || convId === '' || !Number.isFinite(n) || n <= 0) return false;
  const k = _k(meLc, convId);
  let per = _m.get(k);
  if (!per) {
    per = new Map();
    _m.set(k, per);
    if (_m.size > MAX_CONVS) { const k0 = _m.keys().next().value; _m.delete(k0); }
  }
  const cur = per.get(p);
  if (cur && cur.id >= n) return false;
  per.set(p, { id: n, at: Date.now() });
  for (const fn of _subs) { try { fn(String(convId), p, n); } catch {} }
  return true;
}

/** [{ email, id, at }] dos peers com leitura ao vivo nos últimos `maxAgeMs`. */
export function getPeerReadLive(me, convId, maxAgeMs = TTL_MS) {
  const per = _m.get(_k(me, convId));
  if (!per) return [];
  const now = Date.now();
  const out = [];
  for (const [email, v] of per) if (v && (now - v.at) < maxAgeMs) out.push({ email, id: v.id, at: v.at });
  return out;
}

/** Maior watermark ao vivo de QUALQUER peer (1:1 = o peer). -1 = nenhum. */
export function getPeerReadLiveMax(me, convId, maxAgeMs = TTL_MS) {
  let max = -1;
  for (const x of getPeerReadLive(me, convId, maxAgeMs)) if (x.id > max) max = x.id;
  return max;
}

export function subscribePeerReadLive(fn) {
  _subs.add(fn);
  return () => _subs.delete(fn);
}

/**
 * Frame bruto de chat_read (PHP: {conversation_id, email, last_read_id}) ou
 * message_read (hub: {conversation_id, read_by, last_read_id | message_ids}).
 * Ignora o próprio usuário, eco local (_local) e frames sem id.
 */
export function ingestReadEvent(me, data) {
  try {
    if (!data || typeof data !== 'object' || data._local) return;
    const d = data.data && typeof data.data === 'object' && data.conversation_id == null ? data.data : data;
    const conv = d.conversation_id ?? d.conversationId;
    if (conv == null || conv === '') return;
    const peer = d.read_by || d.reader_email || d.email;
    if (!peer || typeof peer !== 'string') return;
    let id = Number(d.last_read_id) || 0;
    if (!id && Array.isArray(d.message_ids) && d.message_ids.length) {
      for (const x of d.message_ids) { const v = Number(x); if (Number.isFinite(v) && v > id) id = v; }
    }
    if (!id) return;
    notePeerReadLive(me, conv, peer, id);
  } catch {}
}

// [2026-10-18 lista-entregue] Watermark de ENTREGA ao vivo do peer (mesma regra
// peer-only). Bug founder (conv 934, 07:22Z): o GIF vai pela fila nativa, sem eco
// local na lista; o chat_delivered (+1,3 s) chegou ANTES do eco do servidor
// (_publishServerRow, depois da resposta HTTP via edge) → o handler da lista viu a
// prévia anterior já ✓✓ (no-op) e o eco seguinte entrou com delivered_at null →
// "✓ Você: GIF" preso com a bolha ✓✓. A lista aplica este piso sempre que troca a
// última msg. Entrega é monotônica (nunca volta), por isso o TTL é mais longo.
const DLV_TTL_MS = 600000;
const _d = new Map(); // `${me}|${conv}` → Map(peerLc → { id, at })

export function notePeerDeliveredLive(me, convId, peer, msgId) {
  const meLc = String(me || '').trim().toLowerCase();
  const p = String(peer || '').trim().toLowerCase();
  const n = Number(msgId);
  if (!meLc || !p || p === meLc || convId == null || convId === '' || !Number.isFinite(n) || n <= 0) return false;
  const k = _k(meLc, convId);
  let per = _d.get(k);
  if (!per) {
    per = new Map();
    _d.set(k, per);
    if (_d.size > MAX_CONVS) { const k0 = _d.keys().next().value; _d.delete(k0); }
  }
  const cur = per.get(p);
  if (cur && cur.id >= n) { cur.at = Date.now(); return false; }
  per.set(p, { id: n, at: Date.now() });
  return true;
}

/** Maior id ENTREGUE (ou lido — ler implica entregar) por QUALQUER peer. -1 = nenhum. */
export function getPeerDeliveredLiveMax(me, convId, maxAgeMs = DLV_TTL_MS) {
  let max = getPeerReadLiveMax(me, convId);
  const per = _d.get(_k(me, convId));
  if (per) {
    const now = Date.now();
    for (const v of per.values()) if (v && (now - v.at) < maxAgeMs && v.id > max) max = v.id;
  }
  return max;
}

/**
 * Frame de chat_delivered (PHP: {conversation_id, message_id, message_ids, email})
 * ou message_delivered (hub: {conversation_id, message_ids, email|delivered_to}).
 * email = QUEM recebeu; o meu próprio ack (msgs que EU recebi) é ignorado.
 */
export function ingestDeliveredEvent(me, data) {
  try {
    if (!data || typeof data !== 'object' || data._local) return;
    const d = data.data && typeof data.data === 'object' && data.conversation_id == null ? data.data : data;
    const conv = d.conversation_id ?? d.conversationId;
    if (conv == null || conv === '') return;
    const peer = d.email || (typeof d.delivered_to === 'string' ? d.delivered_to : '');
    if (!peer || typeof peer !== 'string') return;
    let id = Number(d.message_id) || 0;
    if (Array.isArray(d.message_ids)) {
      for (const x of d.message_ids) { const v = Number(x); if (Number.isFinite(v) && v > id) id = v; }
    }
    if (!id) return;
    notePeerDeliveredLive(me, conv, peer, id);
  } catch {}
}
