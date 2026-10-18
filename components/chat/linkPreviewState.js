// [linkpreview 2026-10-18] Prévia de link nível Telegram — estado compartilhado (JS e cartões nativos).
//
// O servidor (kit /root/linkpreview-2026-10-18) resolve a prévia UMA vez por mensagem e grava em
// chat_messages.link_preview: {src,url,title,description,image,site_name,favicon} | {failed} | {disabled}.
// Chega no histórico (chat_messages), no frame WS da mensagem e no patch WS 'message_update'
// {kind:'link_preview'}. Sem o kit no servidor o app cai no caminho antigo (busca no render).
//
// Também guarda o estado da faixa de prévia do compositor (URL digitada → prévia / dispensada) e a
// prévia local por client_message_id (bolha do remetente antes do eco do servidor trazer o campo).

/** msg.link_preview (objeto ou JSON) → objeto ou null. */
export function parseLinkPreview(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  if (typeof v !== 'string' || v[0] !== '{') return null;
  try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : null; } catch { return null; }
}

// client_message_id → prévia que o remetente viu no compositor (ou {disabled:true}). Limitado.
const _localByCmi = new Map();
export function setLocalPreviewForCmi(cmi, lp) {
  if (!cmi || !lp) return;
  if (_localByCmi.size >= 200) { const k = _localByCmi.keys().next().value; if (k !== undefined) _localByCmi.delete(k); }
  _localByCmi.set(String(cmi), lp);
}

/**
 * Prévia conhecida da mensagem p/ a URL `url`:
 *   { kind:'ok', data }  → desenha o cartão sem rede
 *   { kind:'none' }      → sem cartão (falhou / remetente dispensou)
 *   null                 → desconhecida (cache/rede/esperar patch)
 * Prévia gravada p/ OUTRA url (mensagem editada) é ignorada.
 */
export function previewForMessage(msg, url) {
  if (!msg || !url) return null;
  let lp = parseLinkPreview(msg.link_preview);
  if (!lp && _localByCmi.size) {
    const cmi = msg.client_message_id || msg._client_id || null; // otimista usa _client_id
    if (cmi) lp = _localByCmi.get(String(cmi)) || null;
  }
  if (!lp) return null;
  if (lp.src && lp.src !== url) return null;
  if (lp.disabled || lp.failed) return { kind: 'none' };
  if (lp.title || lp.image) return { kind: 'ok', data: lp };
  return { kind: 'none' };
}

/** Mensagem recém-criada (≤ 90 s): o patch WS do servidor deve chegar logo → espera antes de buscar. */
export function isFreshMessage(msg) {
  try {
    const t = Date.parse(msg && msg.created_at);
    return Number.isFinite(t) && Math.abs(Date.now() - t) < 90000;
  } catch { return false; }
}

// ─── faixa do compositor ─────────────────────────────────────────────────────
let _composer = { url: null, data: null, loading: false, dismissedUrl: null };
const _subs = new Set();
export const composerLinkPreview = {
  get: () => _composer,
  set: (patch) => {
    _composer = { ..._composer, ...patch };
    _subs.forEach((fn) => { try { fn(_composer); } catch {} });
  },
  subscribe: (fn) => { _subs.add(fn); return () => { _subs.delete(fn); }; },
  reset: () => composerLinkPreview.set({ url: null, data: null, loading: false, dismissedUrl: null }),
};

/**
 * No envio: o que fazer com a prévia da 1ª URL de `text`.
 * → { noPreview: true, local: {src,url,disabled:true} } | { local: {src,...prévia} } | null
 */
export function composerSendDecision(text, firstUrl) {
  if (!firstUrl) return null;
  const s = _composer;
  if (s.dismissedUrl && s.dismissedUrl === firstUrl) return { noPreview: true, local: { src: firstUrl, url: firstUrl, disabled: true } };
  if (s.url === firstUrl && s.data && (s.data.title || s.data.image)) return { local: { ...s.data, src: firstUrl } };
  return null;
}

// Alturas do cartão (iguais a linkPreviewStyles / linkCard): imagem 140 + texto (pad 8+8, domínio 17+3,
// título 2×19, descrição 2×17). O esqueleto reserva o caso com imagem (o mais comum) p/ a lista não pular.
export const LP_SKELETON = { imageH: 140, textH: 16 + 20 + 40 + 34, width: 280 };
