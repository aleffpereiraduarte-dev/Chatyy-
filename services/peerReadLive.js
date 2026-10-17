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
