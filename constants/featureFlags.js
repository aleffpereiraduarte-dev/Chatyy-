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
// [2026-10-04 monetização LIGADA — storage pago via Stripe/cartão] Split
// granular: storage plans + Stripe/cartão ON; IAP OFF (produtos ASC/Play ainda
// nos preços antigos → cobraria errado; liga quando o founder atualizar a loja);
// diamonds/wallet OFF até polir.
export const MONETIZATION_ENABLED = true;

export const WALLET_ENABLED       = false;
export const DIAMONDS_ENABLED     = false;
export const PLANS_ENABLED        = true;
export const IAP_ENABLED          = false;
export const STRIPE_ENABLED       = true;
// Checkout Stripe de ARMAZENAMENTO: so ligar apos o backend stripe_checkout
// aceitar kind:'storage' + tier/period e o webhook chamar setStorageTier().
export const STRIPE_STORAGE_CHECKOUT = true;  // [2026-10-04] backend storage checkout wired + testado (cs_live OK)
export const PREMIUM_BADGES_VISIBLE = true;

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

// ────────────────────────────────────────────────────────────────────────
// [2026-10-07 native-core] NATIVE_CORE_ENABLED — phase 1 of the native
// messaging core (WhatsApp/Signal model: native socket + native store, the UI
// renders the store). Phase 1 = SHADOW: a native WebSocket (ChatyyChatCore
// module in modules/expo-callkit — OkHttp on Android, URLSessionWebSocketTask
// on iOS) runs IN PARALLEL with the JS socket while the app is in the
// foreground, journals chat frames into the existing bg journal and logs
// native-vs-JS parity to push_diag (step `native_core_parity`). The JS socket
// is untouched. **DEFAULT false** → services/nativeCore.js init() returns on
// its first line (no listener, no native call, no require of the module).
// Needs a binary with ChatCoreModule (capability-detected; older binaries =
// no-op even when ON).
//
// Per-device test without turning it on for everyone: put the test ACCOUNT
// e-mail(s) in NATIVE_CORE_TEST_ACCOUNTS (lowercase) and publish an OTA — only
// those accounts start the shadow socket. Dev console: globalThis.
// __chatyy_native_core = true then require('services/nativeCore').init().
//
// [2026-10-08 native-core-2] Shadow ON for the two QA accounts only (apitest +
// founder's QA account duarte@). Hub side (chatyy-ws-go) already treats
// client:"native-core" sockets as non-presence (no initial_data, no offline
// queue flush, no online/last_seen, own 4-socket cap — never evicts JS).
export const NATIVE_CORE_ENABLED = false;
export const NATIVE_CORE_TEST_ACCOUNTS = [
  'apitest@onemundo.com.br',
  'duarte@chatyy.com.br',
];

// ────────────────────────────────────────────────────────────────────────
// [2026-10-08 native-core-2] NATIVE_CORE_PRIMARY — phase 2 of the native core.
// When ON (and the shadow is running + authenticated for this account):
//   - frames that carry a per-user `event_id` (chat_message / chat_summary /
//     receipts / edits / deletes … everything logged in ws_event_log) are
//     forwarded RAW by the native socket and injected into services/websocket
//     `_handleMessage` (same listeners as today); a shared event_id dedup makes
//     whichever socket delivers first win, the other copy is dropped;
//   - text sends that today go over the JS socket's native chat_send
//     (services/api.js _tryNativeWsSend, hub cap `native_send`) go through the
//     NATIVE outbox instead (ChatCoreSocket sendText: persisted, retried on
//     reconnect with the same client_message_id; ack/fallback emitted to JS).
//     JS keeps its 4 s timeout → HTTP with the same cmi (PHP + hub dedup).
// The JS socket stays connected as the fallback for everything (calls,
// presence, typing, acks, frames without event_id).
// **DEFAULT false.** Applies only to accounts for which the shadow is enabled
// (isEnabledFor). Dev override: globalThis.__chatyy_native_core_primary = true|false.
// Needs a binary whose ChatyyChatCore reports version() >= 2.
export const NATIVE_CORE_PRIMARY = false;

// ────────────────────────────────────────────────────────────────────────
// [2026-10-07 native-group-call] NATIVE_GROUP_CALL — /group-call renders the
// LiveKit room NATIVELY (livekit-client Room + @livekit/react-native VideoView,
// hooks/useLiveKitRoom.js + components/groupcall/*) instead of loading
// /livekit-room.html inside a WebView. Same token endpoint
// (chat_livekit_token), same overlays (participants sheet, host controls,
// reactions, raise-hand banner, recording banner). Reactions / raise-hand go
// over LiveKit data messages (topic GROUP_CALL_DATA_TOPIC, JSON payload =
// the same { type:'reaction'|'raise_hand'|'lower_hand', ... } shape the
// WebView used to postMessage) AND over the existing WS events.
//
// **DEFAULT false** for everyone → the WebView stays the path. Accounts listed
// in NATIVE_GROUP_CALL_TEST_ACCOUNTS (lowercase) get the native screen. Dev
// override at runtime: globalThis.__chatyy_native_group_call = true | false
// (wins over both). Needs a binary that links @livekit/react-native (all
// current binaries do); if the native module is missing the screen falls back
// to the WebView automatically. Decided ONCE per screen mount (never switches
// mid-call).
export const NATIVE_GROUP_CALL = false;
export const NATIVE_GROUP_CALL_TEST_ACCOUNTS = [
  'apitest@onemundo.com.br',
  'duarte@chatyy.com.br',
];
export const GROUP_CALL_DATA_TOPIC = 'chatyy.call';

// ────────────────────────────────────────────────────────────────────────
// [2026-10-09 native-group-call] NATIVE_GROUP_CALL_UI — group calls on
// mobile run on the FULLY NATIVE screen (iOS GroupCallViewController /
// Android GroupCallActivity, LiveKit native SDK) instead of the RN grid in
// /call?groupCall=1. Covers outgoing (chat header), join-ongoing (chip /
// link / scheduled) and — via the App Group flag mirrored by
// services/nativeGroupCall.syncNativeGroupCallFlag — the iOS CallKit answer
// path. Needs a binary that reports supportsNativeGroupCallUI() >= 1 (builds
// after 2026-10-09); older binaries keep /call.js automatically.
// **DEFAULT false.** QA accounts below get it; dev override:
// globalThis.__chatyy_native_group_call_ui = true | false.
// Web never uses it (web keeps the LiveKit web room).
export const NATIVE_GROUP_CALL_UI = false;
export const NATIVE_GROUP_CALL_UI_TEST_ACCOUNTS = [
  'apitest@onemundo.com.br',
  'qa2@chatyy.com.br',
];
export function isNativeGroupCallUiEnabled(email) {
  try {
    const o = typeof globalThis !== 'undefined' ? globalThis.__chatyy_native_group_call_ui : undefined;
    if (o === true || o === false) return o;
  } catch {}
  if (NATIVE_GROUP_CALL_UI === true) return true;
  const e = String(email || '').trim().toLowerCase();
  return !!e && NATIVE_GROUP_CALL_UI_TEST_ACCOUNTS.includes(e);
}
export function isNativeGroupCallEnabled(email) {
  try {
    const o = typeof globalThis !== 'undefined' ? globalThis.__chatyy_native_group_call : undefined;
    if (o === true || o === false) return o;
  } catch {}
  if (NATIVE_GROUP_CALL === true) return true;
  const e = String(email || '').trim().toLowerCase();
  return !!e && NATIVE_GROUP_CALL_TEST_ACCOUNTS.includes(e);
}

// ────────────────────────────────────────────────────────────────────────
// [2026-10-10 sem-telnyx-vonage] Telnyx + Vonage contas MORTAS (401 blocked /
// unauthorized). Tudo que dependia deles fica escondido:
//   - VOICE_OTP_ENABLED: "Receber código por chamada" no cadastro/login.
//   - PSTN_ENABLED: discador / ligar para números comuns (não-Chatyy),
//     promo "Chamadas ilimitadas", saldo de minutos, ligações SIP/PSTN.
// Backend também recusa (410). Só religar com um provedor novo.
export const VOICE_OTP_ENABLED = false;
export const PSTN_ENABLED = false;
