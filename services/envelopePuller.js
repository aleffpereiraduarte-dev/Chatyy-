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
import { chatEnvelopesPull, chatEnvelopeAck } from './api';
import { decryptEnvelope, decryptSenderKeysEnvelope } from './envelope';
import { getDeviceId } from './e2ee';
import { getIdentityKeyPair } from './e2e';

let _appStateSub = null;
let _wsEnvUnsub = null;
let _wsConnUnsub = null;
let _running = false;
let _inFlight = false;

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

      // Lazy import of localDb — it's a React-Native-only module and we
      // don't want envelope-mode-off builds to load it eagerly.
      let saveMessage = null;
      try {
        const ld = require('./localDb');
        if (ld && typeof ld.saveMessage === 'function') saveMessage = ld.saveMessage;
      } catch (e) {
        console.warn('[envelopePuller] localDb unavailable', e?.message);
      }

      const identity = await getIdentityKeyPair();
      const mySecret = identity?.secretKey;
      if (!mySecret) {
        console.warn('[envelopePuller] no identity secret key — skipping batch');
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
          continue;
        }
        if (saveMessage) {
          try {
            await saveMessage({
              // Use the client_message_id as the dedup key — there is no
              // server message_id in envelope mode (chat_messages row
              // doesn't exist). saveMessage()'s client_temp_id swap path
              // collapses any optimistic row the receiver may have made
              // for the same cmi.
              id: env.client_message_id,
              client_message_id: env.client_message_id,
              client_temp_id: env.client_message_id,
              conversation_id: env.conversation_id,
              sender_email: env.sender_email,
              content: plaintext,
              type: 'text',
              created_at: env.created_at || new Date().toISOString(),
              pending_state: 'sent',
            });
          } catch (e) {
            console.warn('[envelopePuller] saveMessage failed', e?.message);
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
}

/**
 * Manual one-shot — useful right after silent-push wake to flush
 * envelopes before the OS hibernates the process again.
 */
export async function flushEnvelopesNow() {
  await pullOnce();
}

export default { startEnvelopePuller, stopEnvelopePuller, flushEnvelopesNow };
