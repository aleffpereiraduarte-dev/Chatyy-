#!/usr/bin/env node
/* eslint-disable */
// [2026-10-13 vídeo-sumiu] services/chatOrder.js — pendentes no fim + recarga de janela preserva pendentes.
//   cd /root/webmail-app && node scripts/tests/pending-order.test.js

const path = require('path');
const babel = require(require.resolve('@babel/core', { paths: ['/root/webmail-app'] }));
const Module = require('module');
const src = '/root/webmail-app/services/chatOrder.js';
const { code } = babel.transformFileSync(src, { babelrc: false, configFile: false,
  plugins: [require.resolve('@babel/plugin-transform-modules-commonjs', { paths: ['/root/webmail-app'] })] });
const m = new Module(src); m.filename = src; m.paths = Module._nodeModulePaths(path.dirname(src));
m._compile(code, src);
const co = m.exports;
const assert = require('assert');
let ok = 0; const t = (n, f) => { f(); ok++; console.log('ok -', n); };

const now = Date.parse('2026-10-13T21:35:04Z');
const srv = (id, sec, extra) => ({ id, created_at: new Date(now + sec * 1000).toISOString(), sort_ts: new Date(now + sec * 1000).toISOString(), ...extra });
// bolha de vídeo SEM _negId (como uploadAndSendFile/outbox criavam antes)
const vid = { id: 'tmp_upload_1', type: 'video', created_at: new Date(now).toISOString(), _pending: true, _uploading: true, _client_id: 'msg_1791927304688_0cjot8' };
const txt = { id: 'tmp_2', _negId: (now + 30000) * 1000, type: 'text', created_at: new Date(now + 30000).toISOString(), _pending: true, _client_id: 'msg_t' };
const imported = srv(30000, -86400 * 365, { client_message_id: 'wai:x' }); // id alto, data antiga

t('orderKey: tmp sem _negId usa created_at (fim), não 0', () => {
  assert.ok(co.orderKey(vid) > 1e15);
  assert.strictEqual(co.orderKey(srv(22170, 5)), 22170);
  assert.strictEqual(co.orderKey({ id: 'tmp_x' }), Number.MAX_SAFE_INTEGER);
});

t('compareById: vídeo pendente fica DEPOIS das msgs do servidor', () => {
  const arr = [srv(22168, -60), vid, srv(22170, 12), srv(22172, 26), txt].sort(co.compareById);
  assert.deepStrictEqual(arr.map(x => x.id), [22168, 22170, 22172, 'tmp_upload_1', 'tmp_2']);
});

t('compareMsgs (conversa por data / importada): vídeo pendente no fim', () => {
  const arr = [srv(22172, 26), vid, imported, srv(22168, -60), txt].sort(co.compareMsgs);
  assert.strictEqual(arr[0].id, 30000); // importada (data antiga) no topo
  assert.deepStrictEqual(arr.slice(-2).map(x => x.id), ['tmp_upload_1', 'tmp_2']);
});

t('regressão: comparador antigo (|| 0) jogava o vídeo p/ o TOPO', () => {
  const old = (a, b) => (typeof a.id === 'number' ? a.id : (a._negId || 0)) - (typeof b.id === 'number' ? b.id : (b._negId || 0));
  const arr = [srv(22168, -60), vid, srv(22170, 12)].sort(old);
  assert.strictEqual(arr[0].id, 'tmp_upload_1');
});

t('keepLocalPending: substituição da janela devolve pendentes', () => {
  const prev = [srv(22168, -60), vid, txt];
  const next = [srv(22168, -60), srv(22170, 12)];
  const out = co.keepLocalPending(prev, next);
  assert.deepStrictEqual(out.map(x => x.id), [22168, 22170, 'tmp_upload_1', 'tmp_2']);
});

t('keepLocalPending: pendente confirmado (mesmo cmi) não duplica', () => {
  const prev = [vid];
  const next = [srv(22186, 141, { client_message_id: 'msg_1791927304688_0cjot8' })];
  assert.strictEqual(co.keepLocalPending(prev, next), next);
});

t('keepLocalPending: sem pendentes devolve a mesma referência', () => {
  const next = [srv(1, 0)];
  assert.strictEqual(co.keepLocalPending([srv(1, 0)], next), next);
});

t('isLocalPending: falhou (vermelho) também é preservado', () => {
  assert.ok(co.isLocalPending({ id: 'msg_x', _failed: true }));
  assert.ok(!co.isLocalPending(srv(5, 0)));
});
console.log(`\n${ok} testes ok`);
