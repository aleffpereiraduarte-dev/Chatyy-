// Feature Flags — global on/off switches.
//
// Convention: when a flag goes false, the matching UI entry points hide
// completely (tab bar entries, drawer rows, settings rows, popup buttons).
// Backend code + screens themselves stay intact so we can flip back in
// one config change. NEVER reference these from server code — server is
// always "on" and client decides what to surface.
//
// [2026-05-22 monetization pause] User decided to ship WhatsApp-style
// fully-free experience now. Wallet, Diamantes, Plans/Premium, and IAP/
// Stripe purchase flows all hide. Returns when product strategy says so.

// MONETIZATION_ENABLED — master switch for everything paid:
//   - /wallet tab + screen
//   - /diamonds shop + gift sheets in live/profile
//   - /plans (Plus / Pro / Premium subscription page)
//   - IAP (Apple StoreKit) + Stripe purchase flows
//   - "Storage upgrade" upsell tiles
//   - Diamond balance chips in headers
// Flip to `true` (and republish OTA) to bring all of it back instantly.
export const MONETIZATION_ENABLED = false;

// Convenience aliases that read better at call sites. All resolve to the
// same flag today but exist so future granular splits (e.g. enable Plans
// but not Diamonds) are a one-line change here, not 30 grep-and-replace.
export const WALLET_ENABLED       = MONETIZATION_ENABLED;
export const DIAMONDS_ENABLED     = MONETIZATION_ENABLED;
export const PLANS_ENABLED        = MONETIZATION_ENABLED;
export const IAP_ENABLED          = MONETIZATION_ENABLED;
export const STRIPE_ENABLED       = MONETIZATION_ENABLED;
export const PREMIUM_BADGES_VISIBLE = MONETIZATION_ENABLED;

// Helper: lets components default to "free" semantics when a feature is
// gated off. `requireMonetization` returns true when paid features should
// surface (and false during the WhatsApp-style free era).
export function isMonetizationActive() { return MONETIZATION_ENABLED; }

// ────────────────────────────────────────────────────────────────────────
// DEFAULT_E2EE — master kill-switch for end-to-end encrypted chat delivery
// (the "envelope mode" send/pull pipeline). **DEFAULT false.** DO NOT FLIP
// without full dual-device QA (see below).
//
// [2026-05-19] Envelope mode was turned OFF after receiver-side decrypt
// failed silently for days (messages "sent" but never arrived). The whole
// crypto stack (per-device keypairs, chat_envelope_send / chat_envelopes_pull
// / chat_envelope_ack on the backend, device-key publish on every auth,
// auto-republish on decrypt-fail) is CODE-COMPLETE and stays wired — it just
// must never engage until QA proves end-to-end decrypt works on two devices.
//
// This flag is the SINGLE source of truth for the OFF state. Everything that
// previously hardcoded `false` (services/api.js envelope-mode default,
// context/AuthContext.js globalThis.__chatyy_envelope_mode, the
// loadEnvelopeMode persisted-default) now derives from it. When this is
// false:
//   - chatSend() takes the plaintext chat_send path, byte-for-byte unchanged.
//   - globalThis.__chatyy_envelope_mode resolves to false at boot.
//   - the foreground envelopePuller is NOT started.
//   - a previously-persisted '1' opt-in (AsyncStorage @chatyy_envelope_mode)
//     is ignored — the flag wins, so flipping the build flag OFF is a true
//     kill-switch even for devices that opted in during an older build.
//   - device pubkey publish on auth STILL runs (cheap, idempotent UPSERT) so
//     that when the flag is later flipped ON the recipient device map is
//     already warm — no behavioral change to message delivery.
//
// BEFORE FLIPPING TO true:
//   1. Dual-device QA: login on device A + device B (same account), send a
//      message from a 3rd account, verify BOTH A and B decrypt + render it.
//   2. New-device migration QA: send encrypted msgs, then login on a FRESH
//      device, confirm new envelopes decrypt (device key auto-publishes +
//      sender re-fans-out) and that no thread blanks out.
//   3. Plaintext-fallback QA: send to a peer with NO published device key,
//      confirm the message still lands (api.js falls back to plaintext when
//      chat_envelope_send returns inserted:0).
export const DEFAULT_E2EE = false;

// Resolve the effective envelope-mode default. A runtime override
// (setEnvelopeMode / power-user opt-in) can still flip it ON at run time, but
// only when the build flag permits — when DEFAULT_E2EE is false this returns
// false unconditionally so the kill-switch can never be defeated by stale
// persisted state.
export function isE2eeDefaultOn() { return DEFAULT_E2EE === true; }
