/**
 * Multi-device E2E envelope test.
 *
 * Scenario:
 *   Alice has 2 devices (web + mobile).
 *   Bob has 1 device (mobile).
 *   Alice sends a message from her WEB device.
 *   Expect: Alice's MOBILE device and Bob's MOBILE device can both decrypt it.
 *
 * This test boots multiple "virtual devices" — each has its own in-memory
 * SecureStore + localStorage + identity keypair. We reset module cache per
 * device so services/e2e.js global _identityKeyPair etc. don't leak across.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const nacl = require('tweetnacl');
const naclUtil = require('tweetnacl-util');
const Module = require('module');
const babel = require('@babel/core');

// Transpile-on-require: services/e2e.js uses ESM syntax. Transform to CJS
// using Babel so plain `node multi_device_test.js` works without a build step.
require.extensions['.js'] = function (module, filename) {
  const src = fs.readFileSync(filename, 'utf8');
  // Only transform files that use ESM export syntax (cheap filter).
  if (/^\s*export\s/m.test(src) || /^\s*import\s/m.test(src)) {
    const out = babel.transformSync(src, {
      filename,
      plugins: ['@babel/plugin-transform-modules-commonjs'],
      babelrc: false,
      configFile: false,
    });
    module._compile(out.code, filename);
  } else {
    module._compile(src, filename);
  }
};

// Map of storage-scope -> key/value. Each virtual device gets its own scope.
const DEVICE_STORES = new Map();
let ACTIVE_SCOPE = null;
function store() {
  if (!DEVICE_STORES.has(ACTIVE_SCOPE)) DEVICE_STORES.set(ACTIVE_SCOPE, new Map());
  return DEVICE_STORES.get(ACTIVE_SCOPE);
}

// Node doesn't ship with localStorage or SecureStore. Provide both globally
// so services/e2e.js works unchanged. Platform.OS === 'web' path uses
// localStorage; we emulate that because it's synchronous + simple.
global.localStorage = {
  getItem(k) { return store().has(k) ? store().get(k) : null; },
  setItem(k, v) { store().set(k, String(v)); },
  removeItem(k) { store().delete(k); },
};

// Shim react-native — only Platform.OS is used. Force 'web' so e2e.js takes
// the localStorage path instead of importing expo-secure-store.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'react-native') return path.resolve(__dirname, 'multi_device_test_rn_shim.js');
  return originalResolve.call(this, request, parent, ...rest);
};

// Write the shim on disk so require() can find it deterministically.
require('fs').writeFileSync(
  path.resolve(__dirname, 'multi_device_test_rn_shim.js'),
  `module.exports = { Platform: { OS: 'web' } };\n`
);

// Isolate services/e2e.js per device by wiping require cache on device switch.
const E2E_PATH = path.resolve(__dirname, 'services', 'e2e.js');
function requireE2EFresh() {
  delete require.cache[E2E_PATH];
  return require(E2E_PATH);
}

// Per-device cached module handle
const DEVICES = {}; // id -> { email, deviceId, e2e }

function createDevice(id, email) {
  ACTIVE_SCOPE = id;
  const e2e = requireE2EFresh();
  e2e.setActiveAccount(email);
  DEVICES[id] = { id, email, deviceId: `did_${id}`, e2e };
  return DEVICES[id];
}

function useDevice(id) {
  ACTIVE_SCOPE = id;
  // Re-bind the module-scoped identity: we saved each device's module in its
  // cache, but since we delete cache on createDevice, subsequent uses should
  // also re-load that device's module. Keep the already-loaded module but
  // restore its internal state by re-importing.
  // Simplest: require a fresh copy and reinit active account.
  const dev = DEVICES[id];
  const e2e = requireE2EFresh();
  e2e.setActiveAccount(dev.email);
  dev.e2e = e2e;
  return dev;
}

async function registerBundle(dev) {
  // Build the server-side bundle the sender would retrieve. Each device
  // publishes identity, signing key, signed prekey, and one one-time prekey.
  useDevice(dev.id);
  const identity = await dev.e2e.getIdentityKeyPair();
  const ikPubB64 = naclUtil.encodeBase64(identity.publicKey);
  const signingPubB64 = await dev.e2e.getSigningPublicKeyBase64();
  const signed = await dev.e2e.rotateSignedPrekey();
  const opks = await dev.e2e.generateOneTimePrekeys(5);
  const opk = opks[0];
  return {
    device_id: dev.deviceId,
    identity_key: { pub: ikPubB64 },
    signing_key: signingPubB64,
    signed_prekey: { id: signed.id, key: signed.pub, sig: signed.sig },
    prekey: { id: opk.id, key: opk.publicKey },
  };
}

async function run() {
  console.log('[test] Bootstrapping 3 virtual devices...');
  const aliceWeb = createDevice('alice_web', 'alice@chatyy.com.br');
  const aliceMob = createDevice('alice_mob', 'alice@chatyy.com.br');
  const bobMob   = createDevice('bob_mob',   'bob@chatyy.com.br');

  // Each device registers its bundle. In the real system these go to
  // `/api/email?action=e2ee_register_keys` keyed by (user_email, device_id).
  const aliceWebBundle = await registerBundle(aliceWeb);
  const aliceMobBundle = await registerBundle(aliceMob);
  const bobMobBundle   = await registerBundle(bobMob);

  console.log('[test] Bundles registered. Simulating multi-device get_key_bundle response.');
  // This is what the new backend should return: per-user list of devices.
  const serverBundles = {
    'alice@chatyy.com.br': { devices: [aliceWebBundle, aliceMobBundle] },
    'bob@chatyy.com.br':   { devices: [bobMobBundle] },
  };

  // Alice@web sends. She must NOT fan out to her own current device.
  useDevice('alice_web');
  const plaintext = 'hello from alice web — multi-device test';
  const envelopeJson = await aliceWeb.e2e.createEnvelopeV3(
    plaintext,
    'alice@chatyy.com.br',
    serverBundles,
    aliceWeb.deviceId,
  );
  const parsed = JSON.parse(envelopeJson);
  console.log('[test] Envelope keys:', Object.keys(parsed.envelopes));

  const expectedKeys = [
    'alice@chatyy.com.br|' + aliceMob.deviceId,
    'bob@chatyy.com.br|' + bobMob.deviceId,
  ];
  for (const k of expectedKeys) {
    if (!(k in parsed.envelopes)) throw new Error('Missing envelope: ' + k);
  }
  if (('alice@chatyy.com.br|' + aliceWeb.deviceId) in parsed.envelopes) {
    throw new Error('BUG: sender device should not have its own envelope');
  }

  // alice@mobile decrypts
  useDevice('alice_mob');
  const r1 = await aliceMob.e2e.openEnvelopeV3(parsed, 'alice@chatyy.com.br', aliceMob.deviceId);
  console.log('[test] alice@mobile decrypted ->', JSON.stringify(r1.text));
  if (r1.text !== plaintext) throw new Error('alice@mobile decrypt failed: ' + r1.text);

  // bob@mobile decrypts
  useDevice('bob_mob');
  const r2 = await bobMob.e2e.openEnvelopeV3(parsed, 'bob@chatyy.com.br', bobMob.deviceId);
  console.log('[test] bob@mobile   decrypted ->', JSON.stringify(r2.text));
  if (r2.text !== plaintext) throw new Error('bob decrypt failed: ' + r2.text);

  // Backward-compat v3: envelope keyed by plain email (no device_id).
  // Use a FRESH device pair (carol -> dave) so there's no existing DR state
  // — this is the initial-bootstrap case an old client would produce.
  const carol = createDevice('carol', 'carol@chatyy.com.br');
  const dave  = createDevice('dave',  'dave@chatyy.com.br');
  const daveBundle = await registerBundle(dave);
  useDevice('carol');
  const legacyBundles = { 'dave@chatyy.com.br': daveBundle }; // flat bundle, no .devices
  const legacyEnvJson = await carol.e2e.createEnvelopeV3('hi dave (legacy shape)', 'carol@chatyy.com.br', legacyBundles);
  const legacyParsed = JSON.parse(legacyEnvJson);
  if (!('dave@chatyy.com.br' in legacyParsed.envelopes)) {
    throw new Error('Legacy envelope should be keyed by plain email');
  }
  useDevice('dave');
  // openEnvelopeV3 without myDeviceId — falls back to plain-email lookup.
  const r3 = await dave.e2e.openEnvelopeV3(legacyParsed, 'dave@chatyy.com.br');
  console.log('[test] dave legacy decrypted ->', JSON.stringify(r3.text));
  if (r3.text !== 'hi dave (legacy shape)') throw new Error('legacy fallback failed: ' + r3.text);

  console.log('\nALL CHECKS PASSED');
}

run().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
