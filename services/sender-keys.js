/**
 * Sender Keys protocol for group chats (Signal / WhatsApp parity).
 *
 * Today (v3 envelopes): a group message with N recipients creates N
 * independent Double-Ratchet envelopes — ciphertext grows linearly with
 * group size. For groups this is wasteful: both on bandwidth (N AEAD
 * ciphertexts per message) and on sender CPU (N DH ratchets).
 *
 * Sender Keys flip the model:
 *   - Each sender holds a per-group Sender Chain Key (SCK) + monotonic
 *     iteration counter. Message key MK = KDF(SCK, iteration).
 *   - The plaintext is AEAD-encrypted ONCE with MK and broadcast as a
 *     single (ct, nonce, iteration) tuple — O(1) bandwidth regardless of
 *     group size.
 *   - To bootstrap each recipient, the sender sends a one-time Sender
 *     Key Distribution Message (SKDM) containing (SCK, iteration) over
 *     the existing X3DH / Double-Ratchet 1:1 channel. Recipients cache
 *     the SCK keyed by (group_id, sender_email) and advance their own
 *     chain to decrypt each new broadcast.
 *   - New members joining later just need a fresh SKDM; they can't
 *     decrypt historical messages (same guarantee WhatsApp gives).
 *   - If the sender suspects compromise they generate a fresh SCK and
 *     re-publish SKDMs — analog of the DR DH ratchet, at the group layer.
 *
 * KDF style is the same as Double Ratchet's kdfCK in e2e.js:
 *   mk   = HASH(ck || 0x01)
 *   next = HASH(ck || 0x02)
 *
 * Envelope wire format:
 *   { e2e: 4, group_id, sender_email, iteration, nonce, ct }   // broadcast
 *   { e2e: 4, skdm: true, group_id, sender_email,
 *     iteration, sck }                                          // SKDM plaintext
 * The SKDM plaintext is the payload that gets fed INTO createEnvelopeV3
 * (i.e. it rides the existing 1:1 DR channel to each member). The outer
 * broadcast envelope is what's stored on the group message row.
 *
 * This module is deliberately storage-agnostic: you pass in a `store`
 * adapter with get/set methods. In the app we'll wire expo-secure-store
 * (plus a plaintext fallback on web, same as e2e.js); in tests we use a
 * plain Map. Keeping the crypto path pure also makes it trivially unit
 * testable without React Native runtime.
 */

import nacl from 'tweetnacl';
// tweetnacl-util is CJS; use default-import and destructure so the module
// loads cleanly under both the Metro bundler (React Native) and Node's
// native ESM loader (needed for the unit test).
import naclUtil from 'tweetnacl-util';
const { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } = naclUtil;

// ---- KDF (matches kdfCK in e2e.js) ----
function concat(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}
function kdfCK(ck) {
  const mk   = nacl.hash(concat(ck, new Uint8Array([0x01]))).slice(0, 32);
  const next = nacl.hash(concat(ck, new Uint8Array([0x02]))).slice(0, 32);
  return { mk, next };
}

// ---- In-memory default store (replaced in-app) ----
function createMemoryStore() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async set(k, v) { m.set(k, v); },
    async del(k) { m.delete(k); },
  };
}

const MAX_SKIP = 200;

/**
 * Factory — one instance per active account. Pass `myEmail` and an async
 * `store` {get,set,del} of JSON-serialisable values.
 */
export function createSenderKeyService({ myEmail, store } = {}) {
  if (!myEmail) throw new Error('myEmail required');
  store = store || createMemoryStore();

  const senderKey = (gid) => `sk:snd:${myEmail}:${gid}`;
  const recvKey   = (gid, from) => `sk:rcv:${myEmail}:${gid}:${from}`;

  // ---------- SENDER SIDE ----------

  /**
   * Generate a fresh Sender Chain Key for a group we're about to send to.
   * Overwrites any previous SCK (= "re-publish" flow, e.g. after member
   * removal when we want forward secrecy against the kicked member).
   */
  async function createSenderKey(groupId) {
    const sck = nacl.randomBytes(32);
    const state = {
      sck: encodeBase64(sck),
      iteration: 0,
      createdAt: Date.now(),
    };
    await store.set(senderKey(groupId), state);
    return state;
  }

  async function getOrCreateSenderKey(groupId) {
    const s = await store.get(senderKey(groupId));
    if (s) return s;
    return createSenderKey(groupId);
  }

  /**
   * Build SKDMs for a set of members. `recipientBundles` is the same
   * shape createEnvelopeV3 wants ({ email: bundle, ... }). We call the
   * caller-supplied `encryptToMember(payloadJson, email, bundle)` so this
   * module stays decoupled from the 1:1 DR plumbing — in production
   * `encryptToMember` wraps createEnvelopeV3 for a single recipient; in
   * tests it can be any authenticated encrypt-to-pubkey primitive.
   *
   * Returns [{ member_email, skdm_envelope }] ready to POST to the backend
   * so the server can fan out one SKDM per (group, sender, member) pair.
   */
  async function buildSKDM(groupId, recipientBundles, encryptToMember) {
    const state = await getOrCreateSenderKey(groupId);
    const payload = JSON.stringify({
      e2e: 4,
      skdm: true,
      group_id: groupId,
      sender_email: myEmail,
      iteration: state.iteration,
      sck: state.sck, // base64
    });
    const out = [];
    for (const [email, bundle] of Object.entries(recipientBundles || {})) {
      if (email === myEmail) continue; // don't SKDM ourselves
      const env = await encryptToMember(payload, email, bundle);
      if (env) out.push({ member_email: email, skdm_envelope: env });
    }
    return out;
  }

  /**
   * Encrypt a group message under our current SCK and advance the chain.
   * Same ciphertext is broadcast to all members.
   */
  async function encryptGroupMessage(groupId, plaintext) {
    const state = await getOrCreateSenderKey(groupId);
    const ck = decodeBase64(state.sck);
    const { mk, next } = kdfCK(ck);
    const iteration = state.iteration;

    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const ct = nacl.secretbox(decodeUTF8(plaintext), nonce, mk);

    state.sck = encodeBase64(next);
    state.iteration = iteration + 1;
    await store.set(senderKey(groupId), state);

    // zero MK from memory after use
    for (let i = 0; i < mk.length; i++) mk[i] = 0;

    return {
      e2e: 4,
      group_id: groupId,
      sender_email: myEmail,
      iteration,
      nonce: encodeBase64(nonce),
      ct: encodeBase64(ct),
    };
  }

  // ---------- RECEIVER SIDE ----------

  /**
   * Handle an incoming SKDM that was decrypted from our 1:1 DR channel.
   * `plaintext` is the JSON payload produced by buildSKDM. Stores the
   * sender's SCK indexed by (groupId, fromEmail). If we already have an
   * SCK with a higher iteration we keep ours — SKDMs can arrive out of
   * order and a later SCK shouldn't be overwritten by an earlier one.
   */
  async function processSKDM(plaintext, fromEmail, groupId) {
    let parsed;
    try { parsed = JSON.parse(plaintext); } catch { return false; }
    if (!parsed || parsed.e2e !== 4 || !parsed.skdm) return false;
    if (parsed.sender_email !== fromEmail) return false;
    if (parsed.group_id !== groupId) return false;

    const existing = await store.get(recvKey(groupId, fromEmail));
    // Prefer the SKDM with the LOWEST iteration base when it's a fresh
    // chain (createdAt newer). Simpler rule: accept if we don't have
    // anything, or if the incoming chain advertises a strictly newer
    // chain epoch. We track "epoch" via createdAt in the SKDM.
    if (existing) {
      // If same sck/iteration we already have, no-op.
      if (existing.base_sck === parsed.sck && existing.base_iteration === parsed.iteration) {
        return true;
      }
      // SKDM antigo (iteration menor) chegando depois — ignora pra não
      // fazer rollback da cadeia já avançada.
      if (parsed.iteration < existing.base_iteration) {
        return true;
      }
    }

    const state = {
      base_sck: parsed.sck,
      base_iteration: parsed.iteration,
      sck: parsed.sck,          // advancing chain
      nextExpected: parsed.iteration,
      skipped: {},              // { iteration: base64(mk) }
    };
    await store.set(recvKey(groupId, fromEmail), state);
    return true;
  }

  function trimSkipped(skipped) {
    const keys = Object.keys(skipped);
    if (keys.length <= MAX_SKIP) return skipped;
    const drop = keys.length - MAX_SKIP;
    for (let i = 0; i < drop; i++) delete skipped[keys[i]];
    return skipped;
  }

  /**
   * Decrypt a broadcast group envelope (e2e:4 form). Ratchets the stored
   * receiver chain forward to env.iteration, stashing any skipped MKs so
   * out-of-order deliveries still decrypt (bounded by MAX_SKIP).
   */
  async function decryptGroupMessage(groupId, fromEmail, env) {
    if (!env || env.e2e !== 4 || env.sender_email !== fromEmail) return null;
    const stored = await store.get(recvKey(groupId, fromEmail));
    if (!stored) return null; // no SKDM yet — can't decrypt
    // Clone profundo — antes mutávamos o state retornado por referência;
    // se decrypt falhasse no meio, o store ficava com cadeia avançada
    // sem MK decrypted, corrompendo recebimentos futuros.
    const state = JSON.parse(JSON.stringify(stored));

    state.skipped = state.skipped || {};
    const iterKey = String(env.iteration);

    let mk = null;

    if (state.skipped[iterKey]) {
      mk = decodeBase64(state.skipped[iterKey]);
      delete state.skipped[iterKey];
    } else {
      if (env.iteration < state.nextExpected) {
        // Too old and not in skipped — we already consumed & discarded
        return null;
      }
      if (env.iteration - state.nextExpected > MAX_SKIP) return null;
      let ck = decodeBase64(state.sck);
      while (state.nextExpected < env.iteration) {
        const step = kdfCK(ck);
        state.skipped[String(state.nextExpected)] = encodeBase64(step.mk);
        ck = step.next;
        state.nextExpected++;
      }
      // Now nextExpected === env.iteration
      const step = kdfCK(ck);
      mk = step.mk;
      ck = step.next;
      state.sck = encodeBase64(ck);
      state.nextExpected++;
      state.skipped = trimSkipped(state.skipped);
    }

    const ct = decodeBase64(env.ct);
    const nonce = decodeBase64(env.nonce);
    const plain = nacl.secretbox.open(ct, nonce, mk);
    for (let i = 0; i < mk.length; i++) mk[i] = 0;
    if (!plain) return null;

    await store.set(recvKey(groupId, fromEmail), state);
    return encodeUTF8(plain);
  }

  /** Forget everything for a group (e.g. user left). */
  async function wipeGroup(groupId, members = []) {
    await store.del(senderKey(groupId));
    for (const m of members) await store.del(recvKey(groupId, m));
  }

  return {
    createSenderKey,
    getOrCreateSenderKey,
    buildSKDM,
    encryptGroupMessage,
    processSKDM,
    decryptGroupMessage,
    wipeGroup,
    _store: store, // exposed for tests/migration
  };
}

// Re-export the memory store helper for tests.
export { createMemoryStore };
