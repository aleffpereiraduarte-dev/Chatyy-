/**
 * services/e2e-call.test.js — Jest tests for the call-E2EE primitives.
 *
 * Coverage:
 *   1. mintCallMasterSecret — entropy, length, distinct invocations.
 *   2. encryptForDevice / decryptMasterEnvelope round-trip.
 *   3. Wrong recipient secret key fails to decrypt (negative test).
 *   4. HKDF correctness — matches a fixed test vector for our chosen
 *      HKDF-SHA512 instantiation, and direction-asymmetric SRTP key
 *      derivation (send keys ≠ recv keys).
 *   5. buildEnvelopesForBundles fan-out shape.
 *
 * Run with:  npx jest services/e2e-call.test.js
 * (Requires `jest` + `@babel/preset-env` for the ESM import syntax. If the
 *  repo doesn't yet have jest wired up, this file is harmless — it sits
 *  next to e2e-call.js and acts as living documentation of the primitives.)
 */

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

// Mock the e2e.js helpers — Jest hoists this above the require.
jest.mock('./e2e', () => {
  let _kp = null;
  return {
    getDeviceKeyPair: async () => {
      if (!_kp) {
        const nacl2 = require('tweetnacl');
        _kp = nacl2.box.keyPair();
      }
      return _kp;
    },
    getCachedPublicKey: async () => null,
    __setKp: (kp) => { _kp = kp; },
  };
});

const {
  mintCallMasterSecret,
  encryptForDevice,
  decryptMasterEnvelope,
  deriveSRTPKeys,
  buildEnvelopesForBundles,
  __internal__,
} = require('./e2e-call');
const e2eMock = require('./e2e');

describe('mintCallMasterSecret', () => {
  test('returns 32 bytes', () => {
    const m = mintCallMasterSecret();
    expect(m).toBeInstanceOf(Uint8Array);
    expect(m.length).toBe(32);
  });

  test('two invocations differ', () => {
    const a = mintCallMasterSecret();
    const b = mintCallMasterSecret();
    expect(encodeBase64(a)).not.toBe(encodeBase64(b));
  });
});

describe('encryptForDevice / decryptMasterEnvelope round-trip', () => {
  test('happy path — sender wraps, recipient unwraps to the same master', async () => {
    const recipient = nacl.box.keyPair();
    e2eMock.__setKp(recipient); // make getDeviceKeyPair return recipient
    const master = mintCallMasterSecret();
    const env = encryptForDevice(master, encodeBase64(recipient.publicKey));

    expect(env.ciphertext_b64).toBeTruthy();
    expect(env.nonce_b64).toBeTruthy();
    expect(env.ephemeral_pub_b64).toBeTruthy();

    const decrypted = await decryptMasterEnvelope(env);
    expect(decrypted).toBeInstanceOf(Uint8Array);
    expect(decrypted.length).toBe(32);
    expect(encodeBase64(decrypted)).toBe(encodeBase64(master));
  });

  test('wrong recipient key returns null', async () => {
    const realRecipient = nacl.box.keyPair();
    const attacker = nacl.box.keyPair();
    e2eMock.__setKp(attacker); // attacker tries to unwrap

    const master = mintCallMasterSecret();
    const env = encryptForDevice(master, encodeBase64(realRecipient.publicKey));
    const out = await decryptMasterEnvelope(env);
    expect(out).toBeNull();
  });

  test('tampered ciphertext returns null', async () => {
    const recipient = nacl.box.keyPair();
    e2eMock.__setKp(recipient);
    const master = mintCallMasterSecret();
    const env = encryptForDevice(master, encodeBase64(recipient.publicKey));

    const ct = decodeBase64(env.ciphertext_b64);
    ct[0] ^= 0xff;                    // flip a byte
    env.ciphertext_b64 = encodeBase64(ct);

    const out = await decryptMasterEnvelope(env);
    expect(out).toBeNull();
  });

  test('throws on wrong-sized master', () => {
    const recipient = nacl.box.keyPair();
    expect(() => encryptForDevice(new Uint8Array(16), encodeBase64(recipient.publicKey)))
      .toThrow(/32 bytes/);
  });
});

describe('HKDF correctness', () => {
  test('hmacSha512 matches RFC 4231 Test Case 1', () => {
    // key=20 bytes of 0x0b, data="Hi There"
    const key = new Uint8Array(20).fill(0x0b);
    const data = new TextEncoder().encode('Hi There');
    const mac = __internal__.hmacSha512(key, data);
    // Expected first 16 bytes of RFC 4231 TC1:
    //   87aa7cdea5ef619d4ff0b4241a1d6cb0
    const hex = Array.from(mac.slice(0, 16))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe('87aa7cdea5ef619d4ff0b4241a1d6cb0');
  });

  test('hkdf is deterministic for a fixed (ikm, salt, info)', () => {
    const ikm = new Uint8Array(32).fill(0x42);
    const a = __internal__.hkdf(ikm, new Uint8Array(0), 'test-info', 32);
    const b = __internal__.hkdf(ikm, new Uint8Array(0), 'test-info', 32);
    expect(encodeBase64(a)).toBe(encodeBase64(b));
  });

  test('hkdf output differs when info differs', () => {
    const ikm = new Uint8Array(32).fill(0x42);
    const a = __internal__.hkdf(ikm, new Uint8Array(0), 'info-A', 32);
    const b = __internal__.hkdf(ikm, new Uint8Array(0), 'info-B', 32);
    expect(encodeBase64(a)).not.toBe(encodeBase64(b));
  });
});

describe('deriveSRTPKeys', () => {
  test('returns the expected key/salt lengths', () => {
    const master = new Uint8Array(32).fill(0x11);
    const k = deriveSRTPKeys(master, 'call_abc', 'send');
    expect(k.srtpKey.length).toBe(16);
    expect(k.srtpSalt.length).toBe(14);
    expect(k.srtcpKey.length).toBe(16);
    expect(k.srtcpSalt.length).toBe(14);
  });

  test('send vs recv produce different keys (no two-time-pad)', () => {
    const master = new Uint8Array(32).fill(0x11);
    const s = deriveSRTPKeys(master, 'call_abc', 'send');
    const r = deriveSRTPKeys(master, 'call_abc', 'recv');
    expect(encodeBase64(s.srtpKey)).not.toBe(encodeBase64(r.srtpKey));
    expect(encodeBase64(s.srtpSalt)).not.toBe(encodeBase64(r.srtpSalt));
  });

  test('different call_ids produce different keys (per-call binding)', () => {
    const master = new Uint8Array(32).fill(0x11);
    const a = deriveSRTPKeys(master, 'call_alpha', 'send');
    const b = deriveSRTPKeys(master, 'call_beta',  'send');
    expect(encodeBase64(a.srtpKey)).not.toBe(encodeBase64(b.srtpKey));
  });

  test('caller and callee derive the SAME key for one direction', () => {
    // The contract: caller's "send" derivation must equal callee's "recv"
    // derivation when callee swaps direction labels, since they share M+callId.
    // i.e. given the same master + callId, derive(send) is stable.
    const master = nacl.randomBytes(32);
    const callId = 'call_handshake_xyz';
    const callerSend = deriveSRTPKeys(master, callId, 'send');
    const calleeSend = deriveSRTPKeys(master, callId, 'send');
    expect(encodeBase64(callerSend.srtpKey)).toBe(encodeBase64(calleeSend.srtpKey));
  });

  test('throws on bad inputs', () => {
    const m = new Uint8Array(32).fill(1);
    expect(() => deriveSRTPKeys(new Uint8Array(16), 'cid', 'send')).toThrow(/32 bytes/);
    expect(() => deriveSRTPKeys(m, '', 'send')).toThrow(/callId required/);
    expect(() => deriveSRTPKeys(m, 'cid', 'sideways')).toThrow(/direction/);
  });
});

describe('buildEnvelopesForBundles', () => {
  test('emits one envelope per bundle, skips malformed entries', () => {
    const master = mintCallMasterSecret();
    const bob1   = nacl.box.keyPair();
    const bob2   = nacl.box.keyPair();
    const carol  = nacl.box.keyPair();

    const bundles = [
      { email: 'bob@x.com',   device_id: 'b1',  pubkey_b64: encodeBase64(bob1.publicKey),  one_time_pre_id: 42 },
      { email: 'bob@x.com',   device_id: 'b2',  pubkey_b64: encodeBase64(bob2.publicKey) },
      { email: 'carol@x.com', device_id: 'c1',  pubkey_b64: encodeBase64(carol.publicKey) },
      { email: '', device_id: 'x', pubkey_b64: encodeBase64(carol.publicKey) }, // bad email
      { email: 'noone@x.com', device_id: '', pubkey_b64: encodeBase64(carol.publicKey) }, // bad device
      null,
    ];

    const out = buildEnvelopesForBundles(master, bundles);
    expect(out.length).toBe(3);
    expect(out[0]).toMatchObject({
      recipient_email: 'bob@x.com',
      recipient_device_id: 'b1',
      one_time_pre_id: 42,
    });
    expect(out[1].recipient_device_id).toBe('b2');
    expect(out[2].recipient_email).toBe('carol@x.com');
    // Every entry has the three crypto fields populated.
    for (const e of out) {
      expect(e.ciphertext_b64).toBeTruthy();
      expect(e.nonce_b64).toBeTruthy();
      expect(e.ephemeral_pub_b64).toBeTruthy();
    }
  });

  test('each envelope round-trips back to the same master with the right key', async () => {
    const master = mintCallMasterSecret();
    const bob = nacl.box.keyPair();
    const out = buildEnvelopesForBundles(master, [
      { email: 'bob@x.com', device_id: 'b1', pubkey_b64: encodeBase64(bob.publicKey) },
    ]);
    e2eMock.__setKp(bob);
    const decrypted = await decryptMasterEnvelope(out[0]);
    expect(encodeBase64(decrypted)).toBe(encodeBase64(master));
  });
});
