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
export let USE_PHOENIX_HUB = true; // [2026-10-01] cutover: Phoenix hub primário p/ chat+chamadas (Go segue em paralelo p/ email/status/fallback). Rollback: voltar p/ false + OTA.

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
