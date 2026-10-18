// [2026-10-18 bg-sync] Sinal barato de "o usuário está mexendo agora"
// (toque/arrasto na raiz, digitação no compositor, rolagem da lista). O
// download de histórico em 2º plano (services/fullHistorySync) pausa enquanto
// isso estiver recente, p/ nunca disputar CPU/rede/ponte com a interação.
// Só guarda um timestamp — custo zero no caminho quente.
let _lastAt = 0;

export function noteUserActivity() { _lastAt = Date.now(); }

export function lastUserActivityAt() { return _lastAt; }

/** true se houve interação nos últimos `windowMs` ms. */
export function isUserActive(windowMs = 2500) {
  return _lastAt > 0 && (Date.now() - _lastAt) < windowMs;
}

export default { noteUserActivity, lastUserActivityAt, isUserActive };
