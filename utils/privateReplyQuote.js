// [responder-privado 2026-10-15] "Responder em privado" COM a citação da mensagem original
// (igual WhatsApp). A citação aponta para OUTRA conversa, então não dá para usar reply_to_id
// (só vale na mesma conversa). O app manda reply_ext_conv_id/reply_ext_msg_id; o servidor confere
// que sou membro de lá e que a mensagem é visível p/ mim, e grava em reply_quote_text um JSON
// {"xq":1,cid,mid,se,sn,t,ty,fn} montado DO BANCO. Aqui:
//   extSourceOf(msg, convId)   → campos extras do payload do "Responder em privado"
//   extSendOpts(replyTo)       → opts.replyExt para api.chatSend
//   applyExtQuotes(arr)        → mensagens com {"xq"...} ganham reply_to sintético (bolha JS e nativa
//                                 já desenham reply_to) e reply_quote_text limpo (nunca mostrar o JSON)
//   openExtSource(reply_to)    → toque na citação abre a conversa de origem na mensagem
// Kill switch (OTA): globalThis.__chatyy_reply_ext = false → não envia mais a origem (a renderização
// continua, para nunca mostrar o JSON cru).

const XQ_PREFIX = '{"xq"';

function _on() {
  try { return globalThis.__chatyy_reply_ext !== false; } catch { return true; }
}

function _posInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && Math.floor(n) === n ? n : 0;
}

export function extSourceOf(srcMsg, fallbackConvId) {
  if (!_on() || !srcMsg) return {};
  const mid = _posInt(srcMsg.id);
  const cid = _posInt(srcMsg.conversation_id) || _posInt(fallbackConvId);
  if (!mid || !cid) return {};
  return { ext_cid: cid, ext_mid: mid };
}

export function extSendOpts(replyTo) {
  if (!_on() || !replyTo || typeof replyTo !== 'object') return null;
  if (replyTo.id != null && replyTo.id !== '') return null; // resposta normal (mesma conversa)
  const cid = _posInt(replyTo.ext_cid);
  const mid = _posInt(replyTo.ext_mid);
  return cid && mid ? { cid, mid } : null;
}

export function isExtQuoteText(s) {
  return typeof s === 'string' && s.startsWith(XQ_PREFIX);
}

export function parseExtQuote(s) {
  if (!isExtQuoteText(s)) return null;
  try {
    const o = JSON.parse(s);
    if (!o || o.xq !== 1) return null;
    return o;
  } catch { return null; }
}

const _memo = new WeakMap();

function _apply(m) {
  if (!m || typeof m !== 'object' || !isExtQuoteText(m.reply_quote_text)) return m;
  const hit = _memo.get(m);
  if (hit) return hit;
  const x = parseExtQuote(m.reply_quote_text);
  let out;
  if (!x || m.deleted_at) {
    out = { ...m, reply_quote_text: '' };
  } else {
    out = {
      ...m,
      reply_quote_text: '',
      reply_to: {
        id: null,
        sender_email: String(x.se || ''),
        sender_name: String(x.sn || ''),
        content: String(x.t || ''),
        type: String(x.ty || 'text'),
        file_name: x.fn ? String(x.fn) : null,
        file_url: null,
        deleted_at: null,
        _ext: { cid: _posInt(x.cid), mid: _posInt(x.mid) },
      },
    };
  }
  _memo.set(m, out);
  return out;
}

/** Devolve o MESMO array quando nada muda (memo das linhas intacto). */
export function applyExtQuotes(arr) {
  if (!Array.isArray(arr)) return arr;
  let out = null;
  for (let i = 0; i < arr.length; i++) {
    const m = arr[i];
    const n = _apply(m);
    if (n !== m) {
      if (!out) out = arr.slice();
      out[i] = n;
    }
  }
  return out || arr;
}

export function openExtSource(replyTo) {
  const e = replyTo && replyTo._ext;
  if (!e || !e.cid) return false;
  try {
    const q = `/chat-conversation?id=${e.cid}${e.mid ? `&scrollToMessageId=${e.mid}` : ''}`;
    require('../services/openConversation').openConversation(q, { source: 'reply_ext' });
    return true;
  } catch { return false; }
}

/** Bolha otimista: o mesmo {"xq"...} que o servidor vai gravar (o eco do servidor substitui). */
export function optimisticExtQuoteText(replyTo) {
  const o = extSendOpts(replyTo);
  if (!o) return null;
  try {
    return JSON.stringify({
      xq: 1, cid: o.cid, mid: o.mid,
      se: String(replyTo.sender_email || ''), sn: String(replyTo.sender_name || ''),
      t: String(replyTo.quoteText || replyTo.content || '').slice(0, 240), ty: String(replyTo.type || 'text'),
    });
  } catch { return null; }
}
