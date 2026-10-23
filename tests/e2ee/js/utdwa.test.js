// [e2ee5 utd-wa 2026-10-23] "Aguardando" nível WhatsApp — teste de unidade de services/e2ee/e2ee5.js (node puro, sem RN).
//   NODE_PATH=/root/webmail-app/node_modules node tests/e2ee/js/utdwa.test.js
// Cobre: sessão pronta SEM esperar o 1º sync (aparelho assinado), onNewKeys do núcleo re-decifra a pendente,
// re-tentativa local (lock_busy), pedido de chave ligado pela flag do servidor (após sync), prewarm ao abrir a
// conversa, beacon utd_wait e o kill switch __chatyy_e2ee5_utdfix = false.
const babel = require('@babel/core');
const path = require('path');
const assert = require('assert');
const file = path.join(__dirname, '../../../services/e2ee/e2ee5.js');
const { code } = babel.transformFileSync(file, { presets: ['babel-preset-expo'], babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'] });

const realSetTimeout = setTimeout;
const tick = (ms = 0) => new Promise((r) => realSetTimeout(r, ms));
const ENV = (sid, ct) => '{"e2e":5,"c":{"algorithm":"m.megolm.v1.aes-sha2","sender_key":"sk","session_id":"' + sid + '","ciphertext":"' + ct + '","device_id":"PDEVA"}}';

function load({ flags = {}, keyreqServer = false } = {}) {
  const calls = [];
  const listeners = {};
  const beacons = [];
  const counters = [];
  const st = { syncGate: null, have: new Set(), lockBusyOnce: new Set() };
  const crypto = {
    setAuth: async () => ({}),
    status: async () => ({ enabled: true, contract: 'e2ee5-contrato/1.7', uid: '4', flags: { e2ee5_native: true, e2ee5_keyreq: keyreqServer } }),
    open: async () => ({ deviceId: 'PME' }),
    thisDevice: async () => { calls.push('thisDevice'); return { signedByOwner: true }; },
    sync: async () => { calls.push('sync'); if (st.syncGate) await st.syncGate; return { toDeviceProcessed: 0, convsWithNewKeys: [] }; },
    close: async () => {},
    trackUsers: async () => {},
    decrypt: async (i) => {
      calls.push('decrypt:' + i.serverMid);
      const sid = /"session_id":"([^"]+)"/.exec(i.envelopeJson)[1];
      if (st.lockBusyOnce.has(sid)) { st.lockBusyOnce.delete(sid); const e = new Error('busy'); e.code = 'lock_busy'; throw e; }
      if (!st.have.has(sid)) { const e = new Error('utd'); e.code = 'utd'; e.reason = 'missing_session'; throw e; }
      return { payloadJson: JSON.stringify({ v: 1, t: 'text', body: 'ok-' + i.serverMid, cmid: i.cmid }), trust: 'tofu' };
    },
    requestRoomKey: async (conv, sid, su, mid) => { calls.push('keyreq:' + mid); return { sent: true }; },
    prewarmConversation: async (conv, uids) => { calls.push('prewarm:' + conv + ':' + uids.slice().sort().join(',')); return { keyShareRequests: 1 }; },
    addListener: (name, cb) => { listeners[name] = cb; return { remove() {} }; },
    metricsSnapshot: async () => null,
    rotateConversation: async () => {},
  };
  const api = { getAuthToken: () => 'tok', getActiveAccountEmail: () => 'duarte@chatyy.com.br' };
  const ws = { on() {}, _emit() {} };
  const health = { default: { setTransport() {}, recordDecrypt() {}, recordResolved() {}, recordCounter: (n) => counters.push(n), flush() {} } };
  const req = (n) => {
    if (n === 'react-native') return { Platform: { OS: 'ios' }, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } };
    if (n === '../crypto') return crypto;
    if (n === '../api') return api;
    if (n === '../websocket') return { default: ws };
    if (n === './health') return health;
    if (n === '../nativeTelemetry') return { nativeBeacon: (k, step, s) => beacons.push(step + ' ' + s) };
    if (n === './accountFlag') return { bootPeek: () => true, bootTried: () => true, bootAccount: () => 'duarte@chatyy.com.br' };
    if (n === './backup') return { shouldDeferBootstrap: () => false, offerRestore() {}, onSession() {}, backupOnSync: () => false };
    if (n === './link') return { onSession() {} };
    if (n === 'expo') return { requireOptionalNativeModule: () => null };
    if (n.startsWith('@babel/')) return require(n);
    return {};
  };
  global.fetch = async (url, o) => ({ ok: true, status: 200, json: async () => ({ success: true, data: { e2ee_mode: 1, members: [{ uid: 3, email: 'suporte@chatyy.com.br' }, { uid: 4, email: 'duarte@chatyy.com.br' }] } }) });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, req);
  return { E: mod.exports, calls, listeners, beacons, counters, st };
}

(async () => {
  global.__chatyy_e2ee5 = true;
  global.__chatyy_e2ee5_debug = false;

  // 1) sessão pronta sem esperar o 1º sync (que fica pendurado) → decifra
  {
    const t = load();
    let release; t.st.syncGate = new Promise((r) => { release = r; });
    t.st.have.add('S1');
    const p = t.E.decryptRow({ id: '101', conversation_id: '959', sender_email: 'suporte@chatyy.com.br', content: ENV('S1', 'aaaaaaaaaaaa'), _senderUid: '3' }, '959');
    const r = await Promise.race([p, tick(300).then(() => 'TIMEOUT')]);
    assert.notStrictEqual(r, 'TIMEOUT', 'decifrar não pode esperar o 1º sync');
    assert.strictEqual(r.text, 'ok-101');
    await tick(30);
    assert.ok(t.calls.includes('sync'), '1º sync roda em 2º plano');
    release();
  }

  // 2) falta a chave → onNewKeys do núcleo (ingestão nativa consumiu o to-device) re-decifra na hora
  {
    const t = load();
    const r1 = await t.E.decryptRow({ id: '102', conversation_id: '959', sender_email: 'suporte@chatyy.com.br', content: ENV('S2', 'bbbbbbbbbbbb'), _senderUid: '3' }, '959');
    assert.strictEqual(r1.state, 'waiting');
    assert.ok(typeof t.listeners.onNewKeys === 'function', 'assina onNewKeys do núcleo');
    t.st.have.add('S2');
    const n0 = t.calls.filter((c) => c === 'decrypt:102').length;
    t.listeners.onNewKeys({ uid: '4', convIds: ['959'] });
    await tick(20);
    assert.ok(t.calls.filter((c) => c === 'decrypt:102').length > n0, 're-tentou ao receber onNewKeys');
    assert.strictEqual(t.E.peekByMid('102').text, 'ok-102');
  }

  // 3) lock_busy (NSE segurando o store) → nova tentativa local em ~1,5 s, sem depender de evento
  {
    const t = load();
    t.st.have.add('S3'); t.st.lockBusyOnce.add('S3');
    const r1 = await t.E.decryptRow({ id: '103', conversation_id: '959', sender_email: 'suporte@chatyy.com.br', content: ENV('S3', 'cccccccccccc'), _senderUid: '3' }, '959');
    assert.strictEqual(r1.state, 'waiting');
    await tick(1700);
    assert.ok(t.E.peekByMid('103') && t.E.peekByMid('103').text === 'ok-103', 'resolveu pela re-tentativa local');
    const u = t.E.utdState();
    assert.strictEqual(u.waiting, 0);
  }

  // 4) pedido de chave: ligado pela flag do SERVIDOR, sai ~2,5 s depois, precedido de sync
  {
    const t = load({ keyreqServer: true });
    const r1 = await t.E.decryptRow({ id: '104', conversation_id: '959', sender_email: 'suporte@chatyy.com.br', content: ENV('S4', 'dddddddddddd'), _senderUid: '3' }, '959');
    assert.strictEqual(r1.state, 'waiting');
    assert.strictEqual(t.E.utdState().keyreq, true);
    await tick(4300);
    assert.ok(t.calls.includes('keyreq:104'), 'pediu a chave ao remetente');
    const iReq = t.calls.indexOf('keyreq:104');
    assert.ok(t.calls.slice(0, iReq).lastIndexOf('sync') >= 0, 'sync antes do pedido');
  }

  // 5) prewarm ao abrir a conversa (todos os membros + eu)
  {
    const t = load();
    await t.E.prepareConversation('959');
    await tick(10);
    assert.ok(t.calls.includes('prewarm:959:3,4'), t.calls.join(' '));
    await t.E.prepareConversation('959');
    assert.strictEqual(t.calls.filter((c) => c.startsWith('prewarm:')).length, 1, 'no máx. 1 prewarm/10 min por conversa');
  }

  // 6) kill switch: sem prewarm, sem listener, sync0 volta a bloquear (comportamento anterior)
  {
    global.__chatyy_e2ee5_utdfix = false;
    const t = load();
    await t.E.prepareConversation('959');
    await tick(10);
    assert.ok(!t.calls.some((c) => c.startsWith('prewarm:')));
    assert.ok(!t.listeners.onNewKeys);
    assert.ok(t.calls.indexOf('sync') < t.calls.indexOf('thisDevice'), 'kill: sync0 antes do thisDevice (como antes)');
    global.__chatyy_e2ee5_utdfix = undefined;
  }
  console.log('utdwa.test.js: OK');
  process.exit(0);
})().catch((e) => { console.error('FALHOU', e && e.stack); process.exit(1); });
