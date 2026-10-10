// E2EE v4 — o NÚCLEO (services/e2eeV4Core.js) com o adaptador nativo
// (services/e2eeV4Native.js → makeV) conversa com o núcleo usando o wasm do web.
//
//   node native/e2ee/js-test/core-interop.mjs
//
// O "módulo nativo" aqui é um FALSO com a mesma API de handles do
// ChatyyE2EEModule (Swift/Kotlin), por baixo usando o wasm. Isto testa o
// adaptador + o protocolo de handles + o núcleo sem mudança. A compatibilidade
// do Rust nativo com o wasm é testada em native/e2ee/rust/tests/vectors.rs e
// native/e2ee/vectors/wasm-vectors.mjs. Servidor = falso, em memória (nada de
// rede, nada de produção).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const W = await import(path.join(root, 'vendor/chatyy-e2ee/vodozemac.js'));
const b64 = (await import(path.join(root, 'vendor/chatyy-e2ee/vodozemac_wasm_b64.js'))).default;
await W.default({ module_or_path: Buffer.from(b64, 'base64') });
const { E2EEv4 } = await import(path.join(root, 'services/e2eeV4Core.js'));
const { makeV } = await import(path.join(root, 'services/e2eeV4Native.js'));

let failures = 0;
function ok(cond, what) { if (cond) console.log('ok', what); else { failures++; console.error('FAIL', what); } }

// ---------- módulo "nativo" falso: mesma API do ChatyyE2EEModule ----------
function fakeNative() {
  const objs = new Map(); let next = 1;
  const put = (o) => { const h = next++; objs.set(h, o); return h; };
  const get = (h, cls) => { const o = objs.get(h); if (!o || !(o instanceof cls)) throw new Error(`e2ee: invalid handle ${h}`); return o; };
  const key = (b) => { const k = new Uint8Array(Buffer.from(b, 'base64')); if (k.length !== 32) throw new Error('e2ee: pickle key must be 32 bytes (base64)'); return k; };
  const N = {
    available: () => true, coreVersion: () => 'fake-over-wasm', liveHandles: () => objs.size,
    ed25519Verify: (a, b, c) => W.ed25519Verify(a, b, c), preKeySessionId: (t, b) => W.preKeySessionId(t, b),
    free: (h) => { const o = objs.get(h); objs.delete(h); try { o?.free?.(); } catch {} },
    accountNew: () => put(new W.OlmAccount()),
    accountFromPickle: (p, k) => put(W.OlmAccount.fromPickle(p, key(k))),
    accountPickle: (a, k) => get(a, W.OlmAccount).pickle(key(k)),
    accountCurve25519: (a) => get(a, W.OlmAccount).curve25519,
    accountEd25519: (a) => get(a, W.OlmAccount).ed25519,
    accountSign: (a, m) => get(a, W.OlmAccount).sign(m),
    accountGenerateOneTimeKeys: (a, n) => get(a, W.OlmAccount).generateOneTimeKeys(n),
    accountOneTimeKeys: (a) => get(a, W.OlmAccount).oneTimeKeys(),
    accountGenerateFallbackKey: (a) => get(a, W.OlmAccount).generateFallbackKey(),
    accountFallbackKey: (a) => get(a, W.OlmAccount).fallbackKey(),
    accountMarkKeysAsPublished: (a) => get(a, W.OlmAccount).markKeysAsPublished(),
    accountMaxOneTimeKeys: (a) => get(a, W.OlmAccount).maxOneTimeKeys(),
    accountCreateOutboundSession: (a, ik, otk) => put(get(a, W.OlmAccount).createOutboundSession(ik, otk)),
    accountCreateInboundSession: (a, ik, t, b) => { const r = get(a, W.OlmAccount).createInboundSession(ik, t, b); return { session: put(r.takeSession()), plaintext: r.plaintext }; },
    sessionFromPickle: (p, k) => put(W.OlmSession.fromPickle(p, key(k))),
    sessionPickle: (s, k) => get(s, W.OlmSession).pickle(key(k)),
    sessionId: (s) => get(s, W.OlmSession).sessionId,
    sessionEncrypt: (s, pt) => get(s, W.OlmSession).encrypt(pt),
    sessionDecrypt: (s, t, b) => get(s, W.OlmSession).decrypt(t, b),
    megolmOutboundNew: () => put(new W.MegolmOutbound()),
    megolmOutboundSessionKey: (g) => get(g, W.MegolmOutbound).sessionKey(),
    megolmOutboundSessionId: (g) => get(g, W.MegolmOutbound).sessionId,
    megolmOutboundEncrypt: (g, p) => get(g, W.MegolmOutbound).encrypt(p),
    megolmOutboundPickle: (g, k) => get(g, W.MegolmOutbound).pickle(key(k)),
    megolmOutboundFromPickle: (p, k) => put(W.MegolmOutbound.fromPickle(p, key(k))),
    megolmInboundNew: (sk) => put(new W.MegolmInbound(sk)),
    megolmInboundSessionId: (g) => get(g, W.MegolmInbound).sessionId,
    megolmInboundDecrypt: (g, m) => get(g, W.MegolmInbound).decrypt(m),
    megolmInboundPickle: (g, k) => get(g, W.MegolmInbound).pickle(key(k)),
    megolmInboundFromPickle: (p, k) => put(W.MegolmInbound.fromPickle(p, key(k))),
  };
  return N;
}

// ---------- servidor falso (mesmas actions que o núcleo usa) ----------
const server = { devices: new Map(), otks: new Map(), fallback: new Map() };
const mkApi = (who) => async (action, body) => {
  const me = who.toLowerCase();
  if (action === 'e2ee_v4_otk_count') return { success: true, data: { allowed: true, count: (server.otks.get(`${me}|${body.device_id}`) || []).length } };
  if (action === 'e2ee_v4_register') {
    const k = `${me}|${body.device_id}`;
    const list = server.devices.get(me) || [];
    if (!list.find((d) => d.device_id === body.device_id)) list.push({ device_id: body.device_id, curve25519: body.curve25519, ed25519: body.ed25519, device_sig: body.device_sig, platform: body.platform });
    server.devices.set(me, list);
    server.otks.set(k, [...(server.otks.get(k) || []), ...body.otks]);
    if (body.fallback) server.fallback.set(k, body.fallback);
    return { success: true, data: {} };
  }
  if (action === 'e2ee_v4_devices') {
    const users = {};
    for (const e of body.emails) users[e] = { allowed: true, devices: server.devices.get(e) || [] };
    return { success: true, data: { users } };
  }
  if (action === 'e2ee_v4_claim') {
    const keys = {};
    for (const t of body.targets) {
      const k = `${t.email}|${t.device_id}`;
      const list = server.otks.get(k) || [];
      if (list.length) keys[k] = { ...list.shift(), kind: 'otk' };
      else if (server.fallback.get(k)) keys[k] = { ...server.fallback.get(k), kind: 'fallback' };
    }
    return { success: true, data: { keys } };
  }
  return { success: false, message: 'unknown ' + action };
};
const mkStore = () => { const m = new Map(); return {
  m, get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, setMany: async (o) => { for (const [k, v] of Object.entries(o)) m.set(k, v); },
  getSecret: async (k) => m.get('S' + k) ?? null, setSecret: async (k, v) => { m.set('S' + k, v); } }; };

const N = fakeNative();
const VN = makeV(N);
const WEB = 'web@x.test', PHONE = 'phone@x.test';
const web = new E2EEv4({ api: mkApi(WEB), store: mkStore(), V: W, platform: 'web' });
const phone = new E2EEv4({ api: mkApi(PHONE), store: mkStore(), V: VN, platform: 'ios' });
await web.init(WEB); await phone.init(PHONE);
await web.ensureRegistered(); await phone.ensureRegistered();
ok(server.devices.get(PHONE)?.length === 1 && (server.otks.get(`${PHONE}|${phone.deviceId}`) || []).length === 50, 'native device registered with 50 signed OTKs');
const cid = 42;

const b1 = await web.encryptText(cid, PHONE, 'web → celular 1');
const b2 = await web.encryptText(cid, PHONE, 'web → celular 2');
ok(!b1.includes('celular'), 'envelope has no plaintext');
let r = await phone.decryptBlob(b2, { convId: cid, senderEmail: WEB });
ok(r.ok && r.text === 'web → celular 2', 'native opens web pre-key msg (out of order)');
r = await phone.decryptBlob(b1, { convId: cid, senderEmail: WEB });
ok(r.ok && r.text === 'web → celular 1', 'native opens earlier web msg');
const p1 = await phone.encryptText(cid, WEB, 'celular → web');
r = await web.decryptBlob(p1, { convId: cid, senderEmail: PHONE });
ok(r.ok && r.text === 'celular → web', 'web opens native msg');
const b3 = await web.encryptText(cid, PHONE, 'depois da resposta');
ok(JSON.parse(b3).c[`${PHONE}|${phone.deviceId}`].t === 1, 'ratchet advanced (normal msg)');
r = await phone.decryptBlob(b3, { convId: cid, senderEmail: WEB });
ok(r.ok && r.text === 'depois da resposta', 'native opens normal msg');
const moved = await web.encryptText(cid, PHONE, 'mover?');
r = await phone.decryptBlob(moved, { convId: 999, senderEmail: WEB });
ok(!r.ok && r.code === 'bad_envelope', 'binding mismatch rejected on native');

// celular reabre o app: mesma store, adaptador novo
const phone2 = new E2EEv4({ api: mkApi(PHONE), store: phone.store, V: makeV(N), platform: 'ios' });
await phone2.init(PHONE);
const b4 = await web.encryptText(cid, PHONE, 'depois do reload');
r = await phone2.decryptBlob(b4, { convId: cid, senderEmail: WEB });
ok(r.ok && r.text === 'depois do reload', 'native reload (pickles from store) keeps ratchet');

// segundo aparelho nativo do mesmo usuário + cópia para meus outros aparelhos
const phoneB = new E2EEv4({ api: mkApi(PHONE), store: mkStore(), V: makeV(N), platform: 'android' });
await phoneB.init(PHONE); await phoneB.ensureRegistered();
web.dir.clear();
const b5 = await web.encryptText(cid, PHONE, 'para os dois aparelhos');
ok(Object.keys(JSON.parse(b5).c).length === 2, 'web encrypts to both native devices');
r = await phoneB.decryptBlob(b5, { convId: cid, senderEmail: WEB });
ok(r.ok && r.text === 'para os dois aparelhos', 'second native device opens it');
phone2.dir.clear();
const p2 = await phone2.encryptText(cid, WEB, 'eu e meu outro aparelho');
r = await phoneB.decryptBlob(p2, { convId: cid, senderEmail: PHONE });
ok(r.ok && r.text === 'eu e meu outro aparelho', 'own-other-device copy opens natively');

// OTKs esgotadas → fallback key
server.otks.set(`${PHONE}|${phoneB.deviceId}`, []);
const webNew = new E2EEv4({ api: mkApi(WEB), store: mkStore(), V: W, platform: 'web' });
await webNew.init(WEB); await webNew.ensureRegistered();
const b6 = await webNew.encryptText(cid, PHONE, 'via fallback');
r = await phoneB.decryptBlob(b6, { convId: cid, senderEmail: WEB });
ok(r.ok && r.text === 'via fallback', 'fallback key path works on native');

// número de segurança igual nos dois lados
const sw = await web.safetyNumber(PHONE), sp = await phone2.safetyNumber(WEB);
ok(sw && sp && sw.digits === sp.digits, 'safety number matches web ↔ native');

// adaptador: erros viram exceção, nunca estado quebrado
let threw = false; try { VN.OlmAccount.fromPickle('lixo', new Uint8Array(32)); } catch { threw = true; }
ok(threw, 'bad pickle throws');
threw = false; try { VN.OlmSession.fromPickle('x', new Uint8Array(31)); } catch { threw = true; }
ok(threw, 'short key throws');
ok(VN.ed25519Verify('', '', '') === false, 'ed25519Verify(bad) === false');
const g = new VN.MegolmOutbound(); const gi = new VN.MegolmInbound(g.sessionKey());
ok(JSON.parse(gi.decrypt(g.encrypt('grupo'))).p === 'grupo', 'megolm via adapter');
g.free(); gi.free();
const live = N.liveHandles();
ok(live <= 8, `handles freed by the core (live=${live})`);

if (failures) { console.error(`${failures} FAIL`); process.exit(1); }
console.log('ALL OK (core + native adapter ↔ web wasm)');
