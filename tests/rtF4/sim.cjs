// [sgu F4 2026-10-23] Simulação de services/rtF4.js (fila de eventos por pts, recibos, reações, apagar, contadores).
// node tests/rtF4/sim.cjs   (saída != 0 = falhou). Sem RN: módulos do app trocados por stubs.
const fs = require('fs'); const path = require('path'); const Module = require('module');
const babel = require('@babel/core');
const src = path.join(__dirname, '../../services/rtF4.js');
const code = babel.transformSync(fs.readFileSync(src, 'utf8'), { filename: src, presets: ['babel-preset-expo'], babelrc: false, configFile: false }).code;

const mm = new Map(); const emitted = []; const ingested = []; const calls = [];
let replies = []; let unreadRow = { n: 4 };
const stubs = {
  'react-native': { Platform: { OS: 'ios' }, AppState: { addEventListener() {} } },
  './rtStore': { convBodyStore: (c) => (String(c) === '1033' ? 3 : 0), rtConvIds: () => ['1033', '959'], onRtConvsChange() {} },
  './mmkv': { getString: (k) => mm.get(k) || null, setString: (k, v) => mm.set(k, v) },
  './websocket': { default: { _emit: (ev, d) => emitted.push([ev, d]), on() {} } },
  './rtInbox': { ingestItems: async (it) => { ingested.push(...it); return new Map(); } },
  './api': { getActiveAccountEmail: () => 'apitest@onemundo.com.br', apiCall: async (a, b) => { calls.push([a, b]); return replies.shift() || { success: true, data: { items: [] } }; } },
  './dlvDevice': { dlvDeviceIdSync: () => 'PQADEVSENDAAA' },
  './sqliteStore': { getSyncDb: () => ({ getFirstSync: () => unreadRow }) },
};
const origLoad = Module._load;
Module._load = function (req, parent, isMain) { if (stubs[req]) return stubs[req]; return origLoad.apply(this, arguments); };
const m = new Module(src, module); m.filename = src; m.paths = Module._nodeModulePaths(path.dirname(src)); m._compile(code, src);
const F = m.exports;

let n = 0, fails = 0;
const eq = (name, got, want) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log((ok ? 'ok   ' : 'FALHA') + ' ' + name + (ok ? '' : `  → ${JSON.stringify(got)} (esperado ${JSON.stringify(want)})`)); };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const ENV = '{"e2e":5,"c":{"ciphertext":"x"}}';

(async () => {
  eq('isF4', [F.isF4(1033), F.isF4(959)], [true, false]);
  // lote fora de ordem: msg, recibo do outro, recibo meu (outro aparelho), reação, lápide, apagar
  const top = await F.applyItems(1033, [
    { kind: 'receipt', pts: 5, from: 'qa2@chatyy.com.br', rtype: 'r', upto: 2, upto_mid: 101 },
    { kind: 'msg', pts: 1, mid: 101, env_b64: b64(ENV), from: 'qa2@chatyy.com.br', type: 'text' },
    { kind: 'msg', pts: 2, mid: 102, env_b64: b64(ENV), from: 'apitest@chatyy.com.br' },
    { kind: 'receipt', pts: 6, from: 'apitest@chatyy.com.br', rtype: 'r', upto: 1, upto_mid: 101 },
    { kind: 'receipt', pts: 7, from: 'qa2@chatyy.com.br', rtype: 'd', upto: 2, upto_mid: 102 },
    { kind: 'reaction', pts: 8, ref: 101, from: 'qa2@chatyy.com.br', rx_type: 'r', env_b64: b64('{"e2e":5,"rx":1}') },
    { kind: 'msg', pts: 9, mid: 102, env_b64: b64('{"e2e_del":1,"mid":102}'), tomb: true },
    { kind: 'delete', pts: 10, ref: 103, from: 'apitest@chatyy.com.br' },
  ]);
  eq('maior pts', top, 10);
  eq('mensagens vão ao ingest (sem a lápide)', ingested.map((x) => x.mid), [101, 102]);
  eq('envelope decodificado', ingested[0].envelope, ENV);
  const evs = emitted.map(([e]) => e);
  eq('eventos na ordem de pts', evs, ['message_read', 'chat_read', 'message_delivered', 'reaction', 'delete', 'delete']);
  eq('lida do outro → message_read c/ last_read_id', [emitted[0][1].read_by, emitted[0][1].last_read_id], ['qa2@chatyy.com.br', 101]);
  eq('lida minha (outro aparelho) → chat_read', emitted[1][1].reader_email, 'apitest@chatyy.com.br');
  eq('entregue → message_delivered', emitted[2][1].message_ids, [102]);
  eq('reação agregada', emitted[3][1].message.reactions.map((r) => r.users[0]), ['qa2@chatyy.com.br']);
  eq('lápide e apagar → delete', [emitted[4][1].id, emitted[5][1].id], [102, 103]);
  // remoção de reação
  emitted.length = 0;
  await F.applyItems(1033, [{ kind: 'reaction', pts: 11, ref: 101, from: 'qa2@chatyy.com.br', rx_type: 'r', env_b64: b64('{"rx":"remove","k":"r"}') }]);
  eq('reação removida', emitted[0][1].message.reactions, []);

  // sync com cursor por pts e paginação
  replies = [
    { success: true, data: { items: [{ kind: 'msg', pts: 12, mid: 110, env_b64: b64(ENV) }], cursor_pts: 12, more: true } },
    { success: true, data: { items: [{ kind: 'receipt', pts: 13, from: 'qa2@chatyy.com.br', rtype: 'd', upto: 12, upto_mid: 110 }], cursor_pts: 13, more: false } },
  ];
  await F.syncConv(1033, 'test');
  eq('2 páginas', calls.map(([a, b]) => [a, b.since_pts]), [['chat_f4_sync', 0], ['chat_f4_sync', 12]]);
  eq('cursor gravado', JSON.parse(mm.get('chatyy_f4_pts_v1'))['apitest@onemundo.com.br|PQADEVSENDAAA|1033'], 13);
  calls.length = 0; replies = [{ success: true, data: { items: [], cursor_pts: 13 } }];
  await F.syncConv(1033, 'test2');
  eq('próximo sync começa do cursor', calls[0][1].since_pts, 13);
  calls.length = 0;
  await F.syncConv(959, 'x');
  eq('conversa não F4 não sincroniza', calls.length, 0);

  // contadores: roteador fora → calcula do aparelho; com contador do servidor não mexe
  const resp = { data: [{ id: 1033, body_store: 3, f4_counts: 'device', unread_count: 0 }, { id: 1034, body_store: 3, unread_count: 7, f4: { pts: 3 } }, { id: 5, unread_count: 2 }] };
  F.applyListCounts(resp);
  eq('não lidas do aparelho', resp.data.map((c) => c.unread_count), [4, 7, 2]);

  // kill OTA
  globalThis.__chatyy_rt_f4 = false;
  calls.length = 0;
  await F.syncConv(1033, 'kill');
  eq('kill __chatyy_rt_f4', calls.length, 0);
  console.log(`RESULTADO ${n - fails}/${n}`);
  process.exit(fails ? 1 : 0);
})();
