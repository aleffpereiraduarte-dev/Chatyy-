// E2EE v4 — vetores de compatibilidade wasm (web) <-> nativo (Rust/UniFFI).
//
//   node native/e2ee/vectors/wasm-vectors.mjs gen   [out.json]   → wasm-to-native.json
//   node native/e2ee/vectors/wasm-vectors.mjs check [in.json]    ← native-to-wasm.json
//
// Usa o MESMO wasm que o web carrega (vendor/chatyy-e2ee). O lado nativo é
// native/e2ee/rust/tests/vectors.rs (lê o JSON do wasm e gera o dele).
// Saída de "check": linhas "ok ..." e exit 1 na primeira divergência.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.resolve(here, '../../../vendor/chatyy-e2ee');
const V = await import(path.join(vendor, 'vodozemac.js'));
const b64 = (await import(path.join(vendor, 'vodozemac_wasm_b64.js'))).default;
await V.default({ module_or_path: Buffer.from(b64, 'base64') });

const enc = (u8) => Buffer.from(u8).toString('base64');
const dec = (s) => new Uint8Array(Buffer.from(s, 'base64'));
function fail(msg) { console.error('FAIL', msg); process.exit(1); }
function eq(a, b, what) { if (a !== b) fail(`${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); console.log('ok', what); }

const mode = process.argv[2] || 'gen';

if (mode === 'gen') {
  const out = process.argv[3] || path.join(here, 'wasm-to-native.json');
  const key = new Uint8Array(32); for (let i = 0; i < 32; i++) key[i] = (i * 7 + 3) & 0xff;
  const alice = new V.OlmAccount();
  const bob = new V.OlmAccount();
  bob.generateOneTimeKeys(3); bob.generateFallbackKey();
  const otks = JSON.parse(bob.oneTimeKeys());
  const [otkId, otk] = Object.entries(otks)[0];
  const otkSig = bob.sign(`chatyy-e2ee-v4:otk:bob@x:dB:${otkId}:${otk}`);
  bob.markKeysAsPublished();
  const bobPickle = bob.pickle(key); // conta do Bob ANTES de receber (OTK ainda livre)
  const sa = alice.createOutboundSession(bob.curve25519, otk);
  const texts = ['olá do web 1', 'olá do web 2 — acentuação ç ã é 🙂'.replace('🙂', ':)'), '{"v":1,"mid":"m3","txt":"json interno"}'];
  const messages = texts.map((pt) => ({ ...JSON.parse(sa.encrypt(pt)), pt }));
  const preSid = V.preKeySessionId(messages[0].t, messages[0].b);
  eq(preSid, sa.sessionId, 'wasm preKeySessionId == sessionId');
  // Megolm (grupos — fase 2)
  const g = new V.MegolmOutbound();
  const gKey = g.sessionKey();
  const megolm = { session_key: gKey, session_id: g.sessionId, messages: ['grupo 1', 'grupo 2'].map((p, i) => ({ b: g.encrypt(p), i, pt: p })) };
  const data = {
    about: 'gerado por native/e2ee/vectors/wasm-vectors.mjs gen (vodozemac 0.11.1 wasm)',
    pickle_key: enc(key),
    alice: { curve25519: alice.curve25519, ed25519: alice.ed25519, account_pickle: alice.pickle(key), session_pickle: sa.pickle(key), session_id: sa.sessionId },
    bob: { curve25519: bob.curve25519, ed25519: bob.ed25519, account_pickle: bobPickle, otk_id: otkId, otk, otk_sig: otkSig, otk_sig_msg: `chatyy-e2ee-v4:otk:bob@x:dB:${otkId}:${otk}` },
    messages,
    pre_key_session_id: preSid,
    megolm,
    megolm_outbound_pickle: g.pickle(key),
  };
  fs.writeFileSync(out, JSON.stringify(data, null, 2) + '\n');
  console.log('wrote', out);
} else if (mode === 'check') {
  const inp = process.argv[3] || path.join(here, 'native-to-wasm.json');
  const d = JSON.parse(fs.readFileSync(inp, 'utf8'));
  const key = dec(d.pickle_key);
  // 1) assinatura feita no nativo confere no wasm
  eq(V.ed25519Verify(d.bob.ed25519, d.bob.otk_sig_msg, d.bob.otk_sig), true, 'native sig verifies in wasm');
  eq(V.ed25519Verify(d.bob.ed25519, d.bob.otk_sig_msg + 'x', d.bob.otk_sig), false, 'tampered sig rejected in wasm');
  // 2) pickles nativos abrem no wasm
  const bob = V.OlmAccount.fromPickle(d.bob.account_pickle, key);
  eq(bob.curve25519, d.bob.curve25519, 'native account pickle opens in wasm (curve)');
  eq(bob.ed25519, d.bob.ed25519, 'native account pickle opens in wasm (ed)');
  // 3) mensagens cifradas no nativo abrem no wasm
  const m0 = d.messages[0];
  eq(V.preKeySessionId(m0.t, m0.b), d.pre_key_session_id, 'preKeySessionId of native msg');
  const r = bob.createInboundSession(d.alice.curve25519, m0.t, m0.b);
  eq(r.plaintext, m0.pt, 'wasm decrypts native pre-key msg');
  const sb = r.takeSession();
  for (let i = 1; i < d.messages.length; i++) eq(sb.decrypt(d.messages[i].t, d.messages[i].b), d.messages[i].pt, `wasm decrypts native msg ${i}`);
  // 4) resposta: wasm cifra → sessão da Alice (pickle NATIVO) decifra no wasm
  const rep = JSON.parse(sb.encrypt('resposta do web'));
  const sa = V.OlmSession.fromPickle(d.alice.session_pickle, key);
  eq(sa.sessionId, d.alice.session_id, 'native session pickle opens in wasm');
  eq(sa.decrypt(rep.t, rep.b), 'resposta do web', 'native-pickled session decrypts wasm reply');
  // 5) Megolm do nativo
  const gi = new V.MegolmInbound(d.megolm.session_key);
  for (const m of d.megolm.messages) { const o = JSON.parse(gi.decrypt(m.b)); eq(o.p, m.pt, `megolm msg ${m.i} text`); eq(o.i, m.i, `megolm msg ${m.i} index`); }
  // 6) replay da pré-chave na conta já consumida é recusado
  try { bob.createInboundSession(d.alice.curve25519, m0.t, m0.b); fail('OTK reuse accepted'); } catch { console.log('ok OTK consumed (replay rejected)'); }
  console.log('ALL OK (native → wasm)');
} else {
  fail('mode: gen | check');
}
