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
