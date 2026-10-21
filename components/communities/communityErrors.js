// components/communities/communityErrors.js — [grupos 2026-10-21]
// O servidor (community_*) responde erros em inglês ("Handle already taken",
// "Not a member of this community"…) e as telas mostravam isso cru no alerta
// — ou "offline"/"Network request failed" no catch. Aqui vira texto traduzido.

/** Resposta de erro do servidor → texto para o usuário. */
export function communityErrorText(t, r, fallbackKey, fallbackText) {
  const m = String((r && (r.message || r.error || (r.data && r.data.message))) || '').toLowerCase();
  if (/handle.*(taken|in use)/.test(m)) return t('community.handleTaken', 'Esse @handle já está em uso. Escolha outro.');
  if (/handle/.test(m)) return t('community.qHandleHint', '3-32 chars: letras, números e underscore. Pessoas usarão pra encontrar.');
  if (/not a member/.test(m)) return t('community.notMember', 'Você não participa desta comunidade.');
  if (/not found/.test(m)) return t('community.notFound', 'Comunidade não encontrada');
  if (/rate limit|too many/.test(m)) return t('community.rateLimited', 'Muitas tentativas. Espere um pouco e tente de novo.');
  if (/only |must be|forbidden|permission|not allowed|admin/.test(m)) return t('community.noPermission', 'Só administradores podem fazer isso.');
  return fallbackKey ? t(fallbackKey, fallbackText || t('common.genericError', 'Não foi possível completar a ação. Tente de novo em instantes.'))
    : t('common.genericError', 'Não foi possível completar a ação. Tente de novo em instantes.');
}

/** Exceção (rede caída / timeout) → texto para o usuário. */
export function communityNetErrorText(t) {
  return t('common.networkError', 'Erro de rede. Verifique sua conexão.');
}
