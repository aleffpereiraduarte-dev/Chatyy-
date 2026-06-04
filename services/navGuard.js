// [2026-06-04] Trava de navegação compartilhada — impede empilhar várias telas
// (ex: tocar vários e-mails rápido abria várias telas de leitura uma atrás da
// outra). É de nível de MÓDULO de propósito: a trava vale ENTRE telas, então
// um toque na inbox + um toque numa notificação não conseguem empilhar dois
// /read ao mesmo tempo. Janela curta (650ms) só pega o multi-tap acidental;
// navegação intencional depois disso passa normal.

let _lastNavAt = 0;
const NAV_WINDOW_MS = 650;

/**
 * Retorna true se a navegação pode acontecer agora (e "arma" a trava).
 * Use quando você quer fazer a navegação você mesmo:
 *   if (!canNavigateNow()) return;
 *   router.push(...);
 */
export function canNavigateNow() {
  const now = Date.now();
  if (now - _lastNavAt < NAV_WINDOW_MS) return false;
  _lastNavAt = now;
  return true;
}

/**
 * router.push com trava embutida. Ignora silenciosamente toques repetidos
 * dentro da janela. Aceita string ou objeto {pathname, params}, igual o
 * expo-router. Retorna true se navegou, false se foi bloqueado.
 */
export function guardedPush(router, target) {
  if (!canNavigateNow()) return false;
  try { router.push(target); } catch {}
  return true;
}
