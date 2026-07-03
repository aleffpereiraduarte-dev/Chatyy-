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
// CHAT_CUSTOM_NOTIF_TONE — Android per-conversation custom notification
// sound + vibration (WhatsApp parity). Backed by a per-conversation
// NotificationChannel created by the native expo-callkit module
// (ChatMessagingStyleHandler). The whole native path is fail-safe (any
// error falls back to the default "chat" channel) and the JS calls are
// guarded (no-op when the native method is missing — iOS / web / Expo Go /
// pre-rebuild), so this defaults ON. Flip false to stop the JS settings
// sheet from touching the native tone channels. Effective only on Android
// with the rebuilt native module; a no-op everywhere else.
export const CHAT_CUSTOM_NOTIF_TONE = true;

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

// ────────────────────────────────────────────────────────────────────────
// CALL_E2EE_ENABLED — master kill-switch for END-TO-END ENCRYPTED CALLS
// (per-call symmetric key, generated by the caller and distributed to the
// other participant(s) through the SAME secure per-device envelope channel
// already used for chat messages — see services/callE2ee.js). **DEFAULT
// false.** DO NOT FLIP without full dual-device QA (see below).
//
// When this is false (today, in production):
//   - app/call.js NEVER touches the call-key path. No key is generated, no
//     envelope is sent, the native ExpoCallKit.setCallE2EEKey is not called,
//     and the web LiveKit Room is built with NO `e2ee` option. The call
//     connects byte-for-byte exactly like the current DTLS-SRTP-only flow.
//   - The "Criptografada" lock indicator in the call topbar stays hidden.
//   - services/callE2ee.js helpers are never imported (lazy require gated on
//     this flag), so a stale build with the module present is still a true
//     no-op.
//
// BEFORE FLIPPING TO true (requires DUAL-DEVICE QA):
//   1. Real caller (device A) + real callee (device B) on a 1:1 call.
//      Confirm audio flows BOTH ways AND the lock/"Criptografada" badge shows
//      on BOTH ends (proves the key was distributed + unwrapped).
//   2. Confirm the callee receives + unwraps the envelope BEFORE the Room
//      connects (no race: callee must hold the key before media starts or
//      the first packets are undecryptable).
//   3. Fallback QA: peer with no published device key — the call STILL
//      connects (degrades to DTLS-SRTP, no hang).
//   4. Flag-OFF regression: with this false, a normal call is identical to
//      production today (no badge, no extra network calls).
export const CALL_E2EE_ENABLED = false;

// ────────────────────────────────────────────────────────────────────────
// PASSKEYS_ENABLED — master switch for WebAuthn / FIDO2 passwordless login
// ("Entrar com passkey"). **DEFAULT false.** DO NOT FLIP until the native
// passkey bridge ships in a build.
//
// The backend ceremony endpoints live in /api/passkeys.php (inert until
// called) and are complete. The MISSING piece is the native RN bridge that
// talks to the platform authenticator (Face ID / Touch ID / Android
// biometrics) — recommended dep `react-native-passkey`. Because adding a
// native dep has repeatedly broken the iOS Archive here, the dep is NOT
// installed yet, so this flag stays OFF and the login-screen affordance stays
// hidden. When ON, login.js calls passkey_login_begin/finish; the "Register
// passkey" affordance in settings calls passkey_register_begin/finish.
//
// BEFORE FLIPPING TO true:
//   1. Install + build with `react-native-passkey` (build, not OTA).
//   2. Ship apple-app-site-association (webcredentials) on chatyy.com.br +
//      Associated Domains entitlement, and Android assetlinks.json + Digital
//      Asset Links, so the platform trusts rpId=chatyy.com.br.
//   3. Set PASSKEY_ANDROID_ORIGIN in /etc/mail-api.env to the Android
//      apk-key-hash origin so passkeys.php accepts the native origin.
//   4. Dual-device QA: register on device A, login on device B.
export const PASSKEYS_ENABLED = false;

// ────────────────────────────────────────────────────────────────────────
// SCAN_DOCUMENT_ENABLED — master switch for the in-app "Digitalizar
// documento" scanner in the chat attach menu (native VisionKit on iOS /
// ML Kit Document Scanner on Android → multi-page PDF → attach to chat).
// **DEFAULT false.** DO NOT FLIP until the native scanner bridge ships.
//
// Native capture requires a dep that is NOT installed (recommended:
// `react-native-document-scanner-plugin`). While OFF, the attach-menu slot is
// not rendered. When ON, the produced PDF flows into the existing
// uploadAndSendFile() document path (with caption support) exactly like a
// picked PDF. Requires a native build (not OTA) to land the dep.
export const SCAN_DOCUMENT_ENABLED = false;
