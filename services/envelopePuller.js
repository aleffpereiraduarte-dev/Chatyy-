/**
 * services/envelopePuller.js — Foreground pull loop for encrypted
 * envelopes (SQLite-first chat migration, Stage 5).
 *
 * When the receiver is foreground, every 30s we hit chat_envelopes_pull
 * for our (email, device_id), nacl.box.open each ciphertext, write the
 * plaintext into SQLite via localDb.saveMessage(), then ack the IDs so
 * the server can drop them. On AppState transition active→background we
 * pause; coming back to active we trigger an immediate pull (and the
 * 30s timer resumes). Background delivery is the job of Stage 4 silent
 * push wake — this file only covers foreground.
 *
 * Feature-gated: only starts when globalThis.__chatyy_envelope_mode is
 * truthy. Default OFF — Stage 6 rolls it on per-account.
 *
 * Usage (call once from app root after auth):
 *   import { startEnvelopePuller } from './services/envelopePuller';
 *   startEnvelopePuller();
 */

import { AppState, Platform } from 'react-native';
import { chatEnvelopesPull, chatEnvelopeAck, chatDeviceKeyPublish } from './api';
import { decryptEnvelope, decryptSenderKeysEnvelope } from './envelope';
// [#1188 Agent F PATCH-5 2026-05-19] CRITICAL bug: previously imported
// getDeviceId from './e2ee' which returns a `dev_<base36>` legacy id.
// However the sender side (api.js chatSend → buildEnvelopes / buildSenderKeysEnvelope)
// uses recipient device_ids from `chat_device_keys` which were published
// using getDeviceId from './e2e' (UUIDv4 form). The two schemes never
// collided in storage but the puller was polling with the WRONG id, so
// chat_envelopes_pull always returned 0 envelopes → text never reached
// the recipient even though encryption + WS push + storage all worked.
// Now both sides resolve device_id from the same source-of-truth './e2e'.
import { getDeviceId, getIdentityKeyPair, getDevicePublicKey, getDeviceKeyPair } from './e2e';

let _appStateSub = null;
let _wsEnvUnsub = null;
let _wsConnUnsub = null;
let _running = false;
let _inFlight = false;
let _pullSafetyTimer = null;

// [#1206 2026-05-19] CRITICAL — `messages.id` in SQLite is INTEGER PRIMARY KEY
// (rowid alias). Passing the envelope's `client_message_id` string (e.g.
// "cmi_abc123") directly into saveMessage()'s `id` field causes SQLite to
// coerce it to rowid 0 — so EVERY envelope-mode message overwrote the same
// row. (Symptom: receiver saw only the latest envelope and lost all prior.)
//
// Fix: derive a deterministic NEGATIVE integer from the client_message_id
// hash. We use the negative half of int32 space so envelope placeholder rows
// can never collide with server-confirmed rows (which always have positive
// PG-issued ids). The `client_temp_id` column carries the real string so the
// server-confirm path (saveMessage's swap-by-ctid) can later delete this
// placeholder and insert the real positive-id row in its place.
//
// djb2 variant — fast, stable across runs, no deps. Negative-space mapping
// via -Math.abs() guarantees the value fits in SQLite's signed INTEGER and
// never collides with PG ids (which are positive auto-increment).
function _hashClientId(cmi) {
  if (!cmi) return 0;
  const s = String(cmi);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) | 0;
  // Force negative + non-zero so collisions with server ids (positive) and
  // sentinel 0 (which means "no id") are impossible. Math.min(-1) handles
  // the (extremely unlikely) all-zero hash.
  return Math.min(-1, -Math.abs(h));
}

// [#1188 PATCH-6 2026-05-19] Auto-republish device pubkey when decrypt
// repeatedly fails. Root cause: when app reinstall / store wipe / cache
// reset rotates the LOCAL device keypair but the OLD pubkey is still
// what `chat_device_keys` has → senders fetch the stale pubkey →
// envelopes are nacl.box-sealed for a privkey that no longer exists →
// `nacl.box.open` returns null forever. Symptoms: messages arrive,
// get ack'd (we ack to avoid re-delivery loops), and silently vanish.
// Fix: count consecutive decrypt-fails per pull batch; once we cross
// the threshold within a short window, fire-and-forget republish the
// CURRENT local pubkey (idempotent UPSERT server-side). Subsequent
// sends will use the fresh pubkey → decrypt succeeds → counter resets.
// Dedupe with a 60s cooldown so we don't hammer the endpoint when an
// honest replay (e.g. peer SPK swap) is also failing.
let _decryptFailsInSession = 0;
let _lastRepublishAt = 0;
const REPUBLISH_AFTER_FAILS = 3;
const REPUBLISH_COOLDOWN_MS = 60 * 1000;

async function _maybeRepublishDeviceKey() {
  const now = Date.now();
  if (now - _lastRepublishAt < REPUBLISH_COOLDOWN_MS) return;
  _lastRepublishAt = now;
  try {
    const [did, pub] = await Promise.all([getDeviceId(), getDevicePublicKey()]);
    if (!did || !pub) return;
    const kind = Platform.OS === 'web' ? 'web' : Platform.OS;
    console.warn('[envelopePuller] decrypt fails crossed threshold — republishing device pubkey', did, kind);
    await chatDeviceKeyPublish(did, pub, kind);
  } catch (e) {
    console.warn('[envelopePuller] republish failed', e?.message);
  }
}

function _isEnabled() {
  try {
    return (typeof globalThis !== 'undefined') && globalThis.__chatyy_envelope_mode === true;
  } catch { return false; }
}

/**
 * Pull all available envelopes for this device, decrypt them, persist to
 * SQLite, and ack. Idempotent — re-running mid-batch will pick up where
 * we left off because the server marks delivered_at on pull (but only
 * deletes on ack).
 */
async function pullOnce() {
  if (_inFlight) return;
  if (!_isEnabled()) return;
  _inFlight = true;
  try {
    const deviceId = await getDeviceId();
    if (!deviceId) return;
    // Loop until the server returns 0 — server caps each response at 100,
    // so a backlog from a long background spell drains in a few rounds.
    for (let safety = 0; safety < 20; safety++) {
      const resp = await chatEnvelopesPull(deviceId);
      const envelopes = resp?.data?.envelopes || resp?.envelopes || [];
      if (!Array.isArray(envelopes) || envelopes.length === 0) break;

      // Lazy import of localDb. The Metro/web bundler resolves this to the
      // platform variant:
      //   - native  → localDb.js      (expo-sqlite, exposes saveMessage())
      //   - web     → localDb.web.js  (IndexedDB, exposes webSaveMessages())
      // [WEB-RECV 2026-06-28] localDb.web.js has NO saveMessage() — so on web
      // the old code left `saveMessage` null and silently dropped every
      // decrypted envelope (ack'd but never persisted → secret chats never
      // appeared on web). We now resolve a platform-correct persist function:
      // native writes through saveMessage(), web writes through
      // webSaveMessages(convId, [row]) into the IndexedDB `messages` store
      // (indexed by conversation_id, the same store the web chat screen reads
      // via webGetMessages). This only changes behavior when envelope mode is
      // ON (default OFF) and only ADDS reception on web — native path is byte
      // identical to before.
      const isWeb = Platform.OS === 'web';
      let saveMessage = null;       // native (localDb.js)
      let webSaveMessages = null;   // web (localDb.web.js)
      try {
        const ld = require('./localDb');
        if (isWeb) {
          if (ld && typeof ld.webSaveMessages === 'function') webSaveMessages = ld.webSaveMessages;
        } else if (ld && typeof ld.saveMessage === 'function') {
          saveMessage = ld.saveMessage;
        }
      } catch (e) {
        console.warn('[envelopePuller] localDb unavailable', e?.message);
      }

      // [#1188 PATCH-7 2026-05-19] CRITICAL bug: we were using the
      // IDENTITY secret key to decrypt envelopes, but envelopes are
      // encrypted to the per-DEVICE pubkey (the one we publish via
      // chat_device_key_publish, which is the device keypair from
      // getDevicePublicKey, NOT the identity pubkey). The two keypairs
      // are deliberately separate (e2e.js#L249-336) so logout can wipe
      // the device key without losing X3DH replayability. Using the
      // wrong privkey → nacl.box.open returns null every time → silent
      // black hole even though the server has the right pubkey. Fix:
      // load the device keypair's secret. Fall back to identity for
      // back-compat with extremely old envelopes during rollout (won't
      // ever match, but at least we keep the previous behavior).
      let mySecret = null;
      try {
        let devicePair = await getDeviceKeyPair();
        // [WEB-RECV 2026-06-28] On web (and any fresh device) the per-device
        // keypair is lazy — getDeviceKeyPair() returns null until something
        // calls getDevicePublicKey() to generate+persist it. Auth normally
        // bootstraps it (AuthContext publishes the device pubkey on every
        // login, web included), but make the puller self-sufficient: if the
        // keypair isn't there yet, generate+persist it now (getDevicePublicKey
        // does exactly that via the same SecureStore/localStorage abstraction)
        // and re-load. tweetnacl runs natively in the browser, so this works
        // on web unchanged. Republish so senders pick up the fresh pubkey.
        if (!devicePair?.secretKey) {
          try {
            const pub = await getDevicePublicKey(); // generate+persist if missing
            devicePair = await getDeviceKeyPair();
            if (pub && devicePair?.secretKey) {
              const did2 = await getDeviceId();
              const kind = Platform.OS === 'web' ? 'web' : Platform.OS;
              if (did2) chatDeviceKeyPublish(did2, pub, kind).catch(() => {});
            }
          } catch {}
        }
        if (devicePair?.secretKey) mySecret = devicePair.secretKey;
      } catch {}
      if (!mySecret) {
        const identity = await getIdentityKeyPair();
        mySecret = identity?.secretKey;
        if (mySecret) {
          console.warn('[envelopePuller] device keypair unavailable — falling back to identity secret (may not decrypt)');
        }
      }
      if (!mySecret) {
        console.warn('[envelopePuller] no secret key — skipping batch');
        break;
      }

      const okIds = [];
      for (const env of envelopes) {
        let plaintext = null;
        try {
          // ── Shape detection ────────────────────────────────────────
          // Sender-Keys (v2) envelopes carry a `body_ciphertext` /
          // `body` field plus a `key_*` triplet. Legacy envelopes
          // carry a top-level `ciphertext` + `ephemeral_pubkey` +
          // `nonce`. The server populates whichever shape the sender
          // used; both formats can land in the same pull batch during
          // rollout because old + new clients coexist.
          const isSenderKeys = !!(
            env && (
              env.body_ciphertext ||
              (env.body && env.body.ciphertext) ||
              env.key_ciphertext
            )
          );
          if (isSenderKeys) {
            // Normalize: server may return body fields flat or nested.
            const body = env.body || {
              ciphertext: env.body_ciphertext,
              iv:         env.body_iv,
              tag:        env.body_tag,
              algo:       env.body_algo || 'nacl_secretbox',
            };
            const keyEnvelope = {
              key_ciphertext:       env.key_ciphertext,
              key_ephemeral_pubkey: env.key_ephemeral_pubkey,
              key_nonce:            env.key_nonce,
            };
            plaintext = decryptSenderKeysEnvelope(body, keyEnvelope, mySecret);
          } else {
            plaintext = decryptEnvelope(env, mySecret);
          }
        } catch (e) {
          // Bad envelope (wrong key, tampered, etc.). Still ack so the
          // server stops re-delivering — there's no recovery on this
          // device anyway. Log for debugging.
          console.warn('[envelopePuller] decrypt failed for envelope', env.id, e?.message);
          okIds.push(env.id);
          // [#1188 PATCH-6 2026-05-19] Trip republish after N fails in
          // a single batch. Most likely cause is stale server-side
          // pubkey for this device_id (local keypair was rotated by a
          // reinstall / SecureStore wipe). Re-uploading the current
          // local pubkey fixes the NEXT send automatically. Existing
          // ciphertexts in the queue stay un-decryptable (no privkey
          // recovery), but they're ack'd above so they don't pile up.
          _decryptFailsInSession++;
          if (_decryptFailsInSession >= REPUBLISH_AFTER_FAILS) {
            _decryptFailsInSession = 0;
            // Fire-and-forget — don't block the rest of the batch.
            _maybeRepublishDeviceKey();
          }
          continue;
        }
        // [#1188 PATCH-6] At least one decrypt succeeded this batch —
        // reset the consecutive-fail counter so we don't republish on
        // an occasional honest-bad-envelope.
        _decryptFailsInSession = 0;
        if (saveMessage || webSaveMessages) {
          try {
            // 2026-05-28 Lester QA: "Limpar conversa" re-paints porque
            // envelopes ANTERIORES ao clear ainda eram entregues pelo WS
            // após reconnect. Backend agora filtra, mas mantemos
            // belt-and-suspenders local: pula envelope cujo created_at
            // <= cleared_at_<conv_id> persistido (ChatListTab grava esse
            // watermark sempre que user limpa). Continue ainda permite ack
            // pra server tirar da fila — não voltamos a pullar.
            // [WEB-RECV 2026-06-28] AsyncStorage ships a web shim backed by
            // localStorage, so this watermark check works on web too; the
            // try/catch keeps it harmless if the shim is ever absent.
            try {
              const AsyncStorage = require('@react-native-async-storage/async-storage').default;
              const clearedRaw = await AsyncStorage.getItem(`cleared_at_${env.conversation_id}`);
              if (clearedRaw) {
                const clearedTs = Number(clearedRaw);
                const envTs = Date.parse(env.created_at || 0) || 0;
                if (clearedTs && envTs && envTs <= clearedTs) {
                  // ack so server stops re-firing envelope_available
                  if (env.id != null) okIds.push(env.id);
                  continue;
                }
              }
            } catch { /* AsyncStorage unavailable on web fallback — skip */ }
            const placeholderId = _hashClientId(env.client_message_id);
            const row = {
              id: placeholderId,
              client_message_id: env.client_message_id,
              client_temp_id: env.client_message_id,
              conversation_id: env.conversation_id,
              sender_email: env.sender_email,
              content: plaintext,
              type: 'text',
              created_at: env.created_at || new Date().toISOString(),
              pending_state: 'sent',
            };
            // [WEB-RECV 2026-06-28] Platform-split persistence. Native uses
            // saveMessage() (handles placeholder→server-row swap by
            // client_temp_id). Web uses webSaveMessages(convId, [row]) which
            // does store.put keyed by `id` (our deterministic negative hash,
            // so re-pulling the same envelope overwrites in place rather than
            // duplicating) into the IndexedDB `messages` store — exactly the
            // store the web chat screen reads via webGetMessages(convId).
            if (isWeb) {
              await webSaveMessages(env.conversation_id, [row]);
            } else {
              await saveMessage(row);
            }
          } catch (e) {
            console.warn('[envelopePuller] saveMessage failed', e?.message);
            try { require('./crashReporter').reportCrash?.({ type: 'persistence_error', context: 'envelopePuller_saveMessage', message: `cmi=${env?.client_message_id} ${e?.message}`, stack: e?.stack }); } catch {}
            // Skip ack — we'll retry on next pull.
            continue;
          }
        }
        okIds.push(env.id);
      }

      if (okIds.length) {
        try {
          await chatEnvelopeAck(okIds, deviceId);
        } catch (e) {
          console.warn('[envelopePuller] ack failed', e?.message);
          // Don't break — server will return same envelopes next pull
          // (delivered_at is set but rows still exist). Eventual ack.
        }
      }

      if (envelopes.length < 100) break; // server didn't fill the page
    }
  } catch (e) {
    console.warn('[envelopePuller] pullOnce error', e?.message);
  } finally {
    _inFlight = false;
  }
}

/**
 * Start the foreground envelope puller. Idempotent. Safe to call from
 * app root before login — pulls will no-op until auth + flag are set.
 *
 * WhatsApp-invisible-sync (2026-05-18): no more setInterval. Pulls fire
 * ONLY on event-driven triggers:
 *   - WS `envelope_available` push from server (real-time delivery)
 *   - WS `connection` becoming `authenticated` (reconnect catch-up)
 *   - AppState → 'active' (foreground wake; covers push-wake too)
 *   - Manual `flushEnvelopesNow()` from silent-push handler
 * Background wake is Stage 4 (silent push) and calls flushEnvelopesNow().
 */
export function startEnvelopePuller() {
  if (_running) return;
  _running = true;

  // One pull on start if we're already foreground.
  if (AppState.currentState === 'active') {
    pullOnce();
  }

  // Foreground transition → flush once. No timer anymore.
  _appStateSub = AppState.addEventListener('change', (next) => {
    if (next === 'active') {
      pullOnce();
    }
  });

  // Wire WS push triggers. Lazy-required so module load order is forgiving.
  try {
    const mailWs = require('./websocket').default;
    if (mailWs && typeof mailWs.on === 'function') {
      _wsEnvUnsub = mailWs.on('envelope_available', () => { pullOnce(); });
      _wsConnUnsub = mailWs.on('connection', (evt) => {
        if (evt?.status === 'authenticated') pullOnce();
      });
    }
  } catch {}

  // [#1188 Agent F PATCH-4 2026-05-19] Safety-net pull interval — 30s while
  // foreground. The WS push triggers (envelope_available + authenticated)
  // are PREFERRED, but backend currently does NOT emit envelope_available
  // (dead code on server side per Agent A/F audit), AND WS reconnect can
  // silently re-attach without firing authenticated. Without this interval,
  // recipient may wait minutes/forever to see a message even when both
  // devices are foreground + connected. Telegram/WhatsApp both keep a
  // background poll as belt-and-suspenders; matching that pattern.
  _pullSafetyTimer = setInterval(() => {
    if (AppState.currentState === 'active') {
      pullOnce();
    }
  }, 30000);
}

/**
 * Stop the puller (e.g. on logout). Safe to call when not running.
 */
export function stopEnvelopePuller() {
  _running = false;
  if (_appStateSub && typeof _appStateSub.remove === 'function') {
    try { _appStateSub.remove(); } catch {}
  }
  _appStateSub = null;
  if (_wsEnvUnsub) { try { _wsEnvUnsub(); } catch {} _wsEnvUnsub = null; }
  if (_wsConnUnsub) { try { _wsConnUnsub(); } catch {} _wsConnUnsub = null; }
  if (_pullSafetyTimer) { clearInterval(_pullSafetyTimer); _pullSafetyTimer = null; }
}

/**
 * Manual one-shot — useful right after silent-push wake to flush
 * envelopes before the OS hibernates the process again.
 */
export async function flushEnvelopesNow() {
  await pullOnce();
}

export default { startEnvelopePuller, stopEnvelopePuller, flushEnvelopesNow };
