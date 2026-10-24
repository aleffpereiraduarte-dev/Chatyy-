// [sgu F4 P-1 2026-10-24] Simulação de services/rtF4Local.js (fixar/favoritar locais, 409 sem retry, encaminhar como
// mensagem nova, device_id no recibo de leitura) + guardas das filas (localDb.replayOfflineQueue).
// node tests/rtF4/p1.cjs   (saída != 0 = falhou). Sem RN: módulos do app trocados por stubs.
const fs = require('fs'); const path = require('path'); const Module = require('module');
const babel = require('@babel/core');
// stubs valem também nos require() preguiçosos (em tempo de execução), como no sim.cjs
const STUBS = {};
const origLoad = Module._load;
Module._load = function (req) { if (STUBS[req]) return STUBS[req]; return origLoad.apply(this, arguments); };
const compile = (rel, stubs) => {
  Object.assign(STUBS, stubs);
  const src = path.join(__dirname, '../..', rel);
  const code = babel.transformSync(fs.readFileSync(src, 'utf8'), { filename: src, presets: ['babel-preset-expo'], babelrc: false, configFile: false }).code;
  const m = new Module(src, module); m.filename = src; m.paths = Module._nodeModulePaths(path.dirname(src)); m._compile(code, src); return m.exports;
};

const mm = new Map(); const sends = []; const noted = [];
let e5on = false; let fwdClient = null;
const F4 = new Set(['1033']);
const stubs = {
  'react-native': { Platform: { OS: 'ios' }, AppState: { addEventListener() {} } },
  './rtF4': { f4On: () => globalThis.__chatyy_rt_f4 !== false, isF4: (c) => F4.has(String(c)), f4ConvIds: () => [...F4] },
  './rtStore': { noteConvBodyStore: (c, bs) => { noted.push([String(c), bs]); if (bs >= 3) F4.add(String(c)); } },
  './mmkv': { getString: (k) => mm.get(k) || null, setString: (k, v) => mm.set(k, v) },
  './api': {
    getActiveAccountEmail: () => 'apitest@chatyy.com.br',
    chatSend: async (id, content, type, a, b, c, d, e, f, opts) => { sends.push({ id, content, type, fwd: opts && opts.fwd }); return { success: true, data: { id: 9000 + sends.length } }; },
  },
  './dlvDevice': { dlvDeviceIdSync: () => 'PQADEVSENDAAA' },
  './sqliteStore': { getSyncDb: () => ({ getFirstSync: (sql, args) => (Number(args[0]) === 501 ? { c: 1033 } : null) }) },
  './e2ee/e2ee5': { isOn: () => e5on, isEnvelope: (s) => typeof s === 'string' && s.startsWith('{"e2e":5'), forwardClient: async (...a) => (fwdClient ? fwdClient(...a) : null) },
};
const L = compile('services/rtF4Local.js', stubs);

let n = 0, fails = 0;
const eq = (name, got, want) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log((ok ? 'ok   ' : 'FALHA') + ' ' + name + (ok ? '' : `  → ${JSON.stringify(got)} (esperado ${JSON.stringify(want)})`)); };
const R409 = { success: false, data: { code: 'sgu_f4_local_only', conversation_id: 1044, action: 'chat_star_message' }, message: 'Conversa sem cópia no servidor: esta ação fica no aparelho.' };

(async () => {
  // ── decisão local ───────────────────────────────────────────────────────
  eq('F4 decide local / não F4 não', [L.isF4Conv(1033), L.isF4Conv(959), L.involves([959, 1033]), L.involves([959])], [true, false, true, false]);
  eq('cid pela mensagem (banco local)', [L.cidOfMid(501), L.cidOfMid(777)], [1033, null]);

  // favoritar
  const s1 = L.starLocal(501, true, 1033, { id: 501, content: 'oi', type: 'text', sender_email: 'qa2@chatyy.com.br', created_at: '2026-10-24T10:00:00Z' });
  eq('favoritar local = sucesso', [s1.success, s1.data.starred, s1.data.f4_local], [true, true, 1]);
  eq('favorita marcada', L.isStarredLocal(501), true);
  const srv = { success: true, data: { items: [{ id: 10, conversation_id: 5, created_at: '2026-10-20T00:00:00Z' }] } };
  const merged = L.mergeStarred(srv);
  eq('lista de favoritas = local + servidor', merged.data.items.map((m) => m.id), [501, 10]);
  const rows = [{ id: 501 }, { id: 502 }];
  L.applyStarFlags(rows, 1033);
  eq('estrela local nas linhas F4', rows.map((m) => !!m.starred), [true, false]);
  const rowsN = [{ id: 501 }]; L.applyStarFlags(rowsN, 959);
  eq('conversa não F4: linhas intactas', rowsN[0].starred, undefined);
  L.starLocal(501, false, 1033);
  eq('desfavoritar local', [L.isStarredLocal(501), L.mergeStarred(srv) === srv], [false, true]);

  // fixar (idempotente: duração = fixa, sem duração = desafixa)
  const p1 = L.pinLocal(1033, 501, 86400, { id: 501, content: 'fixa' });
  const p1b = L.pinLocal(1033, 501, 86400, { id: 501, content: 'fixa' });
  eq('fixar 2x continua fixada (sem toggle)', [p1.data.pinned, p1b.data.pinned, L.mergePinned(1033, null).data.items.map((p) => p.id)], [true, true, [501]]);
  const withSrv = L.mergePinned(1033, { success: true, data: { items: [{ id: 400 }] } });
  eq('fixadas = aparelho + antigas do servidor', withSrv.data.items.map((p) => p.id), [501, 400]);
  L.pinLocal(1033, 400, undefined);
  L.pinLocal(1033, 501, undefined);
  eq('desafixar esconde também a antiga do servidor', L.mergePinned(1033, { success: true, data: { items: [{ id: 400 }] } }).data.items, []);
  for (const id of [601, 602, 603, 604]) L.pinLocal(1033, id, 604800, { id });
  eq('máx. 3 fixadas (mais nova primeiro)', L.mergePinned(1033, null).data.items.map((p) => p.id), [604, 603, 602]);

  // ── 409 sgu_f4_local_only ───────────────────────────────────────────────
  eq('isLocalOnly', [L.isLocalOnly(R409), L.isLocalOnly({ success: false, message: 'x' }), L.isLocalOnly({ success: true }), L.isLocalOnly(L.unavailable('chat_schedule_message', 1033))], [true, false, false, true]);
  eq('isLocalOnlyErr (throw da fila)', [L.isLocalOnlyErr(new Error('chat_star_failed:Conversa sem cópia no servidor: esta ação fica no aparelho.')), L.isLocalOnlyErr(new Error('Network request failed'))], [true, false]);
  eq('409 ensina a conversa F4', [L.noteF4From(R409), L.isF4Conv(1044)], [1044, true]);
  eq('agendar indisponível (texto curto, sem emoji)', [L.unavailable('chat_schedule_message', 1033).message, L.unavailable('x', 1).data.code], ['Indisponível nesta conversa', 'sgu_f4_local_only']);

  // fila do localDb: 409 sai da fila; erro comum conta retry
  const dbRuns = []; const queue = [{ id: 1, action: 'chat_star_message', payload: '{"message_id":501,"star":1}' }, { id: 2, action: 'chat_pin_message', payload: '{"message_id":502}' }];
  const fakeDb = new Proxy({ runAsync: async (sql, ...a) => { if (/offline_queue/.test(sql)) dbRuns.push([sql.trim().split(' ')[0], a[a.length - 1]]); }, getAllAsync: async (sql) => (/offline_queue/.test(sql) ? queue : []), getFirstAsync: async () => null }, { get: (o, k) => (k in o ? o[k] : (k === 'then' ? undefined : async () => null)) });
  const LD = compile('services/localDb.js', { ...stubs, 'react-native': { Platform: { OS: 'ios' } }, 'expo-sqlite': { openDatabaseAsync: async () => fakeDb }, './sqliteWriteLane': { chatyyDbOpenOptions: () => ({}) }, './rtF4Local': L });
  if (typeof LD.__setTestDb === 'function') LD.__setTestDb(fakeDb);
  const replies = [R409, { success: false, message: 'Servidor indisponivel' }];
  let dbOk = true;
  try { await LD.replayOfflineQueue(async () => replies.shift()); } catch { dbOk = false; }
  const del = dbRuns.filter(([v, id]) => v === 'DELETE' && id === 1).length;
  const upd = dbRuns.filter(([v, id]) => v === 'UPDATE' && id === 2).length;
  if (dbOk && dbRuns.length) eq('localDb: 409 removido, erro comum = retry', [del, upd], [1, 1]);
  else console.log('pula  localDb (banco não abre no node: ' + dbRuns.length + ' operações)');

  // ── encaminhar = mensagem nova ──────────────────────────────────────────
  sends.length = 0;
  const f1 = await L.forwardAsNew(501, [959, 1033], { sourceMsg: { id: 501, type: 'text', content: 'olá', forward_count: 1 } });
  eq('texto encaminhado vira envio novo por destino', sends.map((x) => [x.id, x.content, x.type, x.fwd]), [[959, 'olá', 'text', 2], [1033, 'olá', 'text', 2]]);
  eq('resultado no formato do chat_forward_multi', [f1.success, f1.data.results.map((x) => x.success)], [true, [true, true]]);
  eq('1 destino → formato chat_forward', L.asSingle(f1, 959).data.id, 9001);
  sends.length = 0;
  const f2 = await L.forwardAsNew(501, [959], { sourceMsg: { id: 501, type: 'text', content: '{"e2e":5,"c":{}}' } });
  eq('envelope não decifrado não vai em claro', [sends.length, f2.success, f2.data.code], [0, false, 'f4_forward_unsupported']);
  eq('recusa definitiva marcada p/ fila', L.asSingle(f2, 959).data.code, 'f4_forward_unsupported');
  e5on = true; fwdClient = async (mid, ids) => ({ success: true, data: { results: ids.map((id) => ({ conversation_id: id, success: true, message_id: 77 })) } });
  sends.length = 0;
  const f3 = await L.forwardAsNew(501, [1033], { sourceMsg: { id: 501, type: 'image', content: '' } });
  eq('E2EE v5 ligado: recifra pelo e2ee5 (mídia sem reenviar bytes)', [sends.length, f3.data.results[0].message_id], [0, 77]);
  fwdClient = async (mid, ids) => ({ success: false, data: { results: ids.map((id) => ({ conversation_id: id, success: false, error: 'e2ee5_forward_unsupported' })) } });
  const f4 = await L.forwardAsNew(501, [959], { sourceMsg: { id: 501, type: 'text', content: 'texto' } });
  eq('e2ee5 sem a origem: cai no texto pelo envio normal', [sends.length, f4.success], [1, true]);
  e5on = false; fwdClient = null;

  // ── recibo de leitura com aparelho ──────────────────────────────────────
  eq('mark_read F4 leva device_id', L.withReadDevice({ conversation_id: 1033, message_id: 9 }, 1033), { conversation_id: 1033, message_id: 9, device_id: 'PQADEVSENDAAA' });
  const plain = { conversation_id: 959, message_id: 9 };
  eq('mark_read não F4 intacto (mesmo objeto)', L.withReadDevice(plain, 959) === plain, true);

  // ── kill OTA ────────────────────────────────────────────────────────────
  globalThis.__chatyy_rt_f4 = false;
  eq('kill: nada é F4', [L.isF4Conv(1033), L.involves([1033]), L.cidOfMid(501), L.withReadDevice(plain, 1033) === plain], [false, false, null, true]);
  const rowsK = [{ id: 601 }]; L.applyStarFlags(rowsK, 1033);
  eq('kill: linhas intactas', rowsK[0].starred, undefined);
  globalThis.__chatyy_rt_f4 = undefined;

  console.log(`\n${n - fails}/${n} ok`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
