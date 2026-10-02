/**
 * services/flags.js — client feature flags (pure JS, OTA-able).
 *
 * Central, dependency-free spot for gradual-rollout toggles so we don't have
 * to hunt through modules. Everything here defaults OFF and is read at call
 * time (never captured at import time) so an OTA flip / A-B override takes
 * effect on the next connect without a reload.
 *
 * ─── USE_PHOENIX_HUB (strangler-fig migration step 3, prep only) ───
 * When TRUE, the app is *allowed* to open a connection to the new Phoenix
 * real-time hub via services/phoenixClient.js. It does NOT replace the legacy
 * WebSocket client (services/websocket.js) — the two coexist behind this flag
 * so we can shadow-test the Phoenix transport before cutting chat over.
 *
 * DEFAULT false. While false, NOTHING imports/uses phoenixClient and the
 * legacy WS remains the only live transport. See phoenixClient.js bottom for
 * the 2-3 lines that would flip it on.
 */

// Default OFF. A runtime override on globalThis wins so an OTA payload, a
// settings screen, or an A-B bucket can flip it without a rebuild — same
// idiom the WS client already uses for globalThis.__chatyy_cwp_ws / _msgpack_ws.
export let USE_PHOENIX_HUB = false; // [2026-10-01] ROLLBACK: Phoenix recusava TODA conexão (UserSocket REFUSED — token do cliente não bate com o esperado pelo hub). Volta pro Go (estável) enquanto conserto o token do phoenixClient. Re-flip só após provar connect real no app.

// Where the Phoenix hub lives. Standard Phoenix endpoint: the client appends
// `/websocket?token=<bearer>&vsn=2.0.0`. Kept next to the flag so a rollback
// is a one-line edit. (Dedicated WS host, bypasses the Cloudflare proxy that
// breaks long-lived sockets — same reasoning as ws.chatyy.com.br.)
export const PHOENIX_HUB_URL = 'wss://ws2.chatyy.com.br/socket';

/**
 * Effective read of USE_PHOENIX_HUB. A truthy globalThis.__chatyy_use_phoenix
 * overrides the compiled default (OTA / settings / A-B). Falls back to the
 * static export. Always call this rather than reading the export directly so
 * runtime overrides are honored.
 */
export function isPhoenixHubEnabled() {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.__chatyy_use_phoenix != null) {
      return globalThis.__chatyy_use_phoenix === true;
    }
  } catch {}
  return USE_PHOENIX_HUB === true;
}

/** Public toggle helper — flip at runtime without hunting through code. */
export function setPhoenixHubEnabled(on) {
  try { globalThis.__chatyy_use_phoenix = !!on; } catch {}
  USE_PHOENIX_HUB = !!on;
}

// [2026-10-02 Stage 3 cohort] Staged rollout allowlist. Phoenix is enabled ONLY
// for these test accounts (chat receive runs in parallel with Go + dedup; call
// signaling is load-bearing on Phoenix). Everyone else stays 100% on Go. The
// server side is proven (socket+auth+join + real phoenixMirror→client delivery);
// this lets the founder validate the REAL app (chat + a call) on his own account
// with ZERO risk to other users before a global flip. Widen this list to ramp;
// empty it (or set the names to nothing) to roll the cohort back instantly.
// [2026-10-02 ROLLBACK] Esvaziado. O cohort quebrou ligação cross-hub: um user
// no Phoenix (cohort) ligando pra um user no Go NÃO tem o call_offer/answer/ICE
// espelhado entre os hubs (só o chat.php espelha; a sinalização de chamada é
// client→hub→client direto no WS, hub-local) → áudio em mão única / não conecta.
// Além disso o user_socket.ex do Phoenix recusava o bearer CRU do app (ele só
// sanitizava; o Go faz sha256(token) primeiro). Reabilitar o cohort SÓ depois
// de: (1) Phoenix validar o token igual ao Go (sha256 primeiro) e (2) resolver
// a sinalização de chamada cross-hub (rotear call SEMPRE pelo Go até o cutover
// global, OU bridge de sinalização entre hubs). Chat-receive via Phoenix é
// seguro (espelhado); CALL não é, enquanto existir população mista.
export const PHOENIX_COHORT = [];

/**
 * Whether Phoenix should be used for THIS account. True when the global flag is
 * on (runtime override / future global default) OR the email is in the staged
 * cohort. Call this once at auth with the active email; it flips the runtime
 * global so every other isPhoenixHubEnabled() read stays consistent this session.
 */
export function isPhoenixForEmail(email) {
  if (isPhoenixHubEnabled()) return true;
  try {
    const e = String(email || '').toLowerCase().trim();
    return e !== '' && PHOENIX_COHORT.map((x) => x.toLowerCase()).includes(e);
  } catch {}
  return false;
}
