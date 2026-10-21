// [e2ee5 WP-18] Teste de unidade do beacon services/e2ee/health.js (node puro, sem RN).
//   NODE_PATH=/root/webmail-app/node_modules node tests/e2ee/js/health.test.js
const babel = require('@babel/core');
const path = require('path');
const assert = require('assert');
const file = path.join(__dirname, '../../../services/e2ee/health.js');
const { code } = babel.transformFileSync(file, { presets: ['babel-preset-expo'], babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'] });
let fakeNow = 1_000_000;
Date.now = () => fakeNow;
const timers = [];
global.setTimeout = (fn, ms) => { timers.push({ fn, at: fakeNow + ms }); return timers.length; };
function load() {
  const mod = { exports: {} };
  const req = (n) => (n === 'react-native' ? { Platform: { OS: 'ios' } } : n === 'expo-constants' ? { default: { expoConfig: { version: '9.9.9' } } } : require(n));
  new Function('module', 'exports', 'require', code)(mod, mod.exports, req);
  return mod.exports;
}
(async () => {
  // 1) flag desligada = no-op
  global.__chatyy_e2ee5 = undefined;
  let h = load();
  h.recordEncrypt(10); h.recordDecrypt(false, 'missing_session', 'm1'); h.recordPlaintextRefused();
  assert.deepStrictEqual(h._peek().counters, {}, 'flag off não conta nada');
  assert.strictEqual(await h.flush(), false);

  // 2) flag ligada
  global.__chatyy_e2ee5 = true;
  h = load();
  const sent = [];
  h.setTransport(async (action, body) => { sent.push({ action, body }); });
  h.recordEncrypt(10); h.recordEncrypt(120, { claimed: true }); h.recordEncrypt(900);
  h.recordDecrypt(true);                              // núcleo conta decrypt_ok: host não
  h.recordDecrypt(false, 'corrupted', 'x');           // não retentável: não aguarda
  h.recordDecrypt(false, 'missing_session', 'a');     // vai resolver antes de 60 s
  h.recordDecrypt(false, 'unknown_index', 'b');       // vai passar de 60 s
  h.recordDecrypt(false, 'unknown_index', 'b');       // repetido: conta 1 vez
  fakeNow += 30_000; h.recordResolved('a');
  fakeNow += 40_000; timers.filter((t) => t.at <= fakeNow).forEach((t) => t.fn());
  h.recordResolved('b');                              // resolveu depois de 70 s: já contou utd_60s 1x
  h.recordPlaintextRefused(); h.recordNseFallback();
  const c = h._peek().counters;
  assert.deepStrictEqual(c, { enc_le50: 1, enc_le150: 1, missing_sessions: 1, enc_gt500: 1, utd_resolved: 2, utd_60s: 1, plaintext_refused: 1, nse_fallback: 1 }, JSON.stringify(c));
  assert.ok(!('decrypt_ok' in c) && !('encrypt' in c) && !('utd_total' in c), 'não duplica o snapshot do núcleo');
  assert.strictEqual(await h.flush(), true);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].action, 'metrics');
  assert.strictEqual(sent[0].body.platform, 'ios');
  assert.deepStrictEqual(sent[0].body.counters, c);
  assert.ok(!JSON.stringify(sent[0].body).match(/"a"|"b"|"x"/), 'ids locais nunca saem');
  assert.deepStrictEqual(h._peek().counters, {});

  // 3) falha de envio devolve os contadores (sem perder)
  h.setTransport(async () => { throw new Error('rede'); });
  h.recordPlaintextRefused();
  assert.strictEqual(await h.flush(), false);
  assert.deepStrictEqual(h._peek().counters, { plaintext_refused: 1 });
  console.log('health.test.js: OK');
})().catch((e) => { console.error('FALHOU', e.message); process.exit(1); });
