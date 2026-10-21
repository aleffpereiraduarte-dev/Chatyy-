// components/chat/groupErrors.js — [2026-10-21 conversa-grupo]
// Ações de grupo/conversa (renomear, limpar histórico, link de convite, pedidos de entrada,
// bloquear/desbloquear…) mostravam `r.message` / `e.message` CRU do servidor ou do fetch
// ("Forbidden: admin only", "Network request failed", "Failed to block user") no alerta.
// Aqui a resposta vira texto traduzido; o texto do servidor nunca vai direto para a tela.

function _tt(t, key, fb) {
  try {
    const v = t ? t(key) : '';
    return typeof v === 'string' && v && v !== key ? v : fb;
  } catch { return fb; }
}

/** Resposta {success:false,…} do servidor → texto para o usuário. */
export function groupErrorText(t, r, fallbackKey, fallbackText) {
  const m = String((r && (r.message || r.error || r.code || (r.data && (r.data.message || r.data.code)))) || '').toLowerCase();
  if (/rate.?limit|too many|slow/.test(m)) return _tt(t, 'community.rateLimited', 'Muitas tentativas. Espere um pouco e tente de novo.');
  if (/not a member|not member|no longer a member/.test(m)) return _tt(t, 'group.err.notMember', 'Você não participa mais deste grupo.');
  if (/forbidden|admin|permission|not allowed|only /.test(m)) return _tt(t, 'group.err.noPermission', 'Só admins do grupo podem fazer isso.');
  if (/network|offline|timeout|timed out|abort|failed to fetch/.test(m)) return _tt(t, 'common.networkError', 'Erro de rede. Verifique sua conexão.');
  return _tt(t, fallbackKey, fallbackText || _tt(t, 'common.genericError', 'Algo deu errado. Tente de novo.'));
}

/** Exceção (rede caída / timeout / throw) → texto para o usuário. */
export function groupNetErrorText(t, e, fallbackKey, fallbackText) {
  const m = String((e && e.message) || e || '').toLowerCase();
  if (/network|offline|timeout|timed out|abort|failed to fetch|connection/.test(m) || !m) return _tt(t, 'common.networkError', 'Erro de rede. Verifique sua conexão.');
  return groupErrorText(t, { message: m }, fallbackKey, fallbackText);
}
