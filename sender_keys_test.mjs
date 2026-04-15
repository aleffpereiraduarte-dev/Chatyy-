// Standalone Node test for services/sender-keys.js
// Simulates Alice, Bob, Charlie in a group:
//   1. Alice creates SCK, issues SKDMs to Bob and Charlie (transported
//      over a fake 1:1 authenticated channel — stands in for
//      createEnvelopeV3 for this unit test).
//   2. Alice sends 3 messages, broadcasts each to the group.
//   3. Bob and Charlie each process the SKDM once, then decrypt all 3.
//   4. Also verify an out-of-order delivery works (skipped-key stash).
//
// Run:  node sender_keys_test.mjs

import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
const { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } = naclUtil;
import { createSenderKeyService, createMemoryStore } from './services/sender-keys.js';

// ---- minimal "1:1 channel" to carry SKDMs (stands in for createEnvelopeV3) ----
// Each participant has a long-term box keypair; sender uses ephemeral -> box.
function mk1on1Channel() {
  return {
    encrypt(plaintext, recipientPubKey) {
      const ephemeral = nacl.box.keyPair();
      const nonce = nacl.randomBytes(nacl.box.nonceLength);
      const ct = nacl.box(decodeUTF8(plaintext), nonce, recipientPubKey, ephemeral.secretKey);
      return {
        ct: encodeBase64(ct),
        nonce: encodeBase64(nonce),
        ek: encodeBase64(ephemeral.publicKey),
      };
    },
    decrypt(env, mySecretKey) {
      const plain = nacl.box.open(
        decodeBase64(env.ct),
        decodeBase64(env.nonce),
        decodeBase64(env.ek),
        mySecretKey,
      );
      return plain ? encodeUTF8(plain) : null;
    },
  };
}

function log(ok, msg) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  const channel = mk1on1Channel();

  // Participants — identity keypair + sender-key service each.
  const alice = {
    email: 'alice@chatyy.com.br',
    ident: nacl.box.keyPair(),
    svc: createSenderKeyService({ myEmail: 'alice@chatyy.com.br', store: createMemoryStore() }),
  };
  const bob = {
    email: 'bob@chatyy.com.br',
    ident: nacl.box.keyPair(),
    svc: createSenderKeyService({ myEmail: 'bob@chatyy.com.br', store: createMemoryStore() }),
  };
  const charlie = {
    email: 'charlie@chatyy.com.br',
    ident: nacl.box.keyPair(),
    svc: createSenderKeyService({ myEmail: 'charlie@chatyy.com.br', store: createMemoryStore() }),
  };

  const groupId = 'grp_test_1';

  // Alice creates fresh SCK and builds SKDMs for Bob and Charlie.
  await alice.svc.createSenderKey(groupId);

  const recipientBundles = {
    [bob.email]:     { pub: encodeBase64(bob.ident.publicKey) },
    [charlie.email]: { pub: encodeBase64(charlie.ident.publicKey) },
  };
  const skdms = await alice.svc.buildSKDM(
    groupId,
    recipientBundles,
    async (payload, email, bundle) => channel.encrypt(payload, decodeBase64(bundle.pub)),
  );
  log(skdms.length === 2, `Alice built SKDMs for 2 members (got ${skdms.length})`);

  // Bob and Charlie receive + process their SKDMs.
  for (const { member_email, skdm_envelope } of skdms) {
    const peer = member_email === bob.email ? bob : charlie;
    const plaintext = channel.decrypt(skdm_envelope, peer.ident.secretKey);
    log(!!plaintext, `${member_email}: 1:1 channel decrypted SKDM`);
    const ok = await peer.svc.processSKDM(plaintext, alice.email, groupId);
    log(ok, `${member_email}: processSKDM accepted`);
  }

  // Alice sends 3 group messages — single ciphertext each.
  const messages = ['hello team', 'second message', 'third — with emoji ✨'];
  const envelopes = [];
  for (const m of messages) {
    envelopes.push(await alice.svc.encryptGroupMessage(groupId, m));
  }
  log(
    envelopes.every((e, i) => e.iteration === i && e.e2e === 4),
    `3 envelopes have iterations 0..2 and e2e==4`,
  );
  // All broadcasts are distinct (fresh nonces / MK each step).
  const cts = new Set(envelopes.map(e => e.ct));
  log(cts.size === 3, `3 distinct ciphertexts (size=${cts.size})`);

  // Bob decrypts all 3 in order.
  for (let i = 0; i < envelopes.length; i++) {
    const pt = await bob.svc.decryptGroupMessage(groupId, alice.email, envelopes[i]);
    log(pt === messages[i], `Bob decrypted msg[${i}] -> "${pt}"`);
  }

  // Charlie decrypts out of order (2, 0, 1) to exercise skipped-keys.
  const order = [2, 0, 1];
  for (const i of order) {
    const pt = await charlie.svc.decryptGroupMessage(groupId, alice.email, envelopes[i]);
    log(pt === messages[i], `Charlie (out-of-order) decrypted msg[${i}] -> "${pt}"`);
  }

  // Replay of an already-consumed iteration returns null (no double-decrypt).
  const replay = await bob.svc.decryptGroupMessage(groupId, alice.email, envelopes[0]);
  log(replay === null, `Bob replay of msg[0] rejected (got ${JSON.stringify(replay)})`);

  // Non-member Charlie is not affected by Bob's chain state — independence check.
  const bobRecv = await bob.svc._store.get(`sk:rcv:${bob.email}:${groupId}:${alice.email}`);
  const charlieRecv = await charlie.svc._store.get(`sk:rcv:${charlie.email}:${groupId}:${alice.email}`);
  log(!!bobRecv && !!charlieRecv, `Independent receiver states stored for Bob and Charlie`);

  console.log(process.exitCode ? '\nSome tests FAILED.' : '\nAll tests passed.');
}

main().catch((e) => {
  console.error('test crashed:', e);
  process.exit(1);
});
