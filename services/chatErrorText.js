// [notmember-ryw 2026-10-17] Texto de erro do chat SEMPRE traduzido.
//
// Founder: tocou "Fala oi" na notificação "adriano entrou no Chatyy!" e a
// conversa abriu com "Não foi possível carregar — Not a member of this
// conversation" (texto cru em inglês do servidor). O servidor agora manda
// data.code = 'not_member'; este helper mapeia códigos conhecidos para i18n e
// nunca repassa mensagem técnica crua (ASCII/inglês) do servidor para a tela.

const NOT_MEMBER_RE = /not a member|not_member/i;

function _code(res) {
  if (!res || typeof res !== 'object') return '';
  const d = res.data && typeof res.data === 'object' ? res.data : null;
  return String((d && (d.code || d.error_code)) || res.code || res.error || '');
}

export function isNotMemberError(res) {
  if (!res) return false;
  if (_code(res) === 'not_member') return true;
  return NOT_MEMBER_RE.test(String(res.message || ''));
}

function _tr(t, key, pt) {
  try {
    const s = typeof t === 'function' ? t(key) : '';
    if (s && s !== key) return s;
  } catch {}
  return pt;
}

/**
 * @param t        função de tradução (useTranslation().t)
 * @param res      resposta {success,message,data} ou Error
 * @param fallback texto já traduzido para erros genéricos
 */
export function chatErrorText(t, res, fallback) {
  if (isNotMemberError(res)) return _tr(t, 'chatConv.notMember', 'Você não participa desta conversa.');
  const m = String((res && res.message) || '').trim();
  if (!m) return fallback;
  // Mensagem técnica do servidor/transporte (ex.: "Not authenticated",
  // "Network request failed", "conversation_id required") = ASCII puro →
  // mostra o texto genérico traduzido em vez do inglês cru.
  if (/^[\x20-\x7E]+$/.test(m)) return fallback;
  return m;
}
