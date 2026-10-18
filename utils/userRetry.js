// utils/userRetry.js — [2026-10-18 breaker-ux]
// Botões "Tentar de novo"/"Recarregar" explícitos avisam o breaker de leituras
// (services/api.js noteUserRetry) ANTES de refazer a carga → cada chave aberta
// deixa sair UMA sonda em vez de falhar na hora por até 60 s.
const RETRY_LABEL_RE = /tentar|tente|retry|try again|reintentar|intentar|recarregar|reload|atualizar|refresh|actualizar/i;

export function noteUserRetry() {
  try { require('../services/api').noteUserRetry?.(); } catch {}
}

/** true se o rótulo do botão é de "tentar de novo"/recarregar. */
export function isRetryLabel(label) {
  return typeof label === 'string' && RETRY_LABEL_RE.test(label);
}

/**
 * Envolve um onPress: se `force` ou o rótulo for de retry, abre a janela de
 * sonda do breaker e chama o handler original. Sem handler → devolve o próprio.
 */
export function wrapRetryPress(onPress, label, force = false) {
  if (typeof onPress !== 'function') return onPress;
  if (!force && !isRetryLabel(label)) return onPress;
  return (...args) => { noteUserRetry(); return onPress(...args); };
}
