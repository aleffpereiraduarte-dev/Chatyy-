/**
 * [wa-import-local 2026-10-22] Testes da importação do WhatsApp SÓ NO APARELHO (parse.js + localIds.js).
 * Só amostras SINTÉTICAS (nomes, números e textos inventados — nunca export de usuário real).
 *
 * Rodar:  node services/waImport/parse.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');

const _cache = new Map();
function load(rel) {
  const file = path.join(__dirname, rel);
  if (_cache.has(file)) return _cache.get(file).exports;
  const { code } = babel.transformFileSync(file, {
    babelrc: false, configFile: false,
    plugins: ['@babel/plugin-transform-modules-commonjs'],
  });
  const m = new Module(file, module);
  _cache.set(file, m);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  const origReq = m.require.bind(m);
  m.require = (id) => (id.startsWith('.') ? load(path.join(path.dirname(rel), id) + (id.endsWith('.js') ? '' : '.js')) : origReq(id));
  m._compile(code, file);
  return m.exports;
}

const P = load('parse.js');
const OWNER = 'qa.sintetico@chatyy.com.br';
const LRM = '‎';

// ── amostras ────────────────────────────────────────────────────────────
const IOS_PT = [
  `[25/12/2023, 21:00:00] Ana Sintética: ${LRM}As mensagens e as ligações são protegidas com a criptografia de ponta a ponta.`,
  '[25/12/2023, 21:05:12] Ana Sintética: oi, tudo bem?',
  '[25/12/2023, 21:05:40] Bruno Exemplo: tudo ótimo',
  'segunda linha da mesma mensagem',
  'terceira linha',
  `[25/12/2023, 21:07:00] Ana Sintética: ${LRM}<anexado: 00000012-PHOTO-2023-12-25-21-07-00.jpg>`,
  `[25/12/2023, 21:08:00] Bruno Exemplo: ${LRM}imagem omitida`,
  '[25/12/2023, 21:09:00] Bruno Exemplo: Esta mensagem foi apagada.',
  `[26/12/2023, 08:00:00] Ana Sintética: bom dia ${LRM}<Mensagem editada>`,
].join('\n');

const ANDROID_PT = [
  '25/12/2023 21:00 - As mensagens e ligações são protegidas com a criptografia de ponta a ponta. Toque para saber mais.',
  '25/12/2023 21:05 - +55 11 90000-0001: olá do número',
  '25/12/2023 21:06 - Carla Teste: IMG-20231225-WA0001.jpg (arquivo anexado)',
  'legenda da foto',
  '25/12/2023 21:07 - Carla Teste: <Mídia oculta>',
  '25/12/2023 21:08 - +55 11 90000-0001: PTT-20231225-WA0002.opus (arquivo anexado)',
].join('\n');

const IOS_EN = [
  '[12/25/23, 9:05:12 PM] John Sample: hi there',
  `[12/25/23, 9:06:00 PM] Jane Fake: ${LRM}image omitted`,
  '[12/25/23, 9:07:00 PM] Jane Fake: This message was deleted.',
  '[12/26/23, 7:00:00 AM] John Sample: good morning',
].join('\n');

const ANDROID_ES = [
  '25/12/23, 21:05 - Juan Prueba: hola',
  '25/12/23, 21:06 - María Ficticia: <Multimedia omitido>',
  '25/12/23, 21:07 - María Ficticia: Se eliminó este mensaje',
  '25/12/23, 21:08 - Juan Prueba creó el grupo "Grupo Falso"',
  '26/12/23, 09:00 - Juan Prueba: buenos días',
].join('\n');

// ── ids ─────────────────────────────────────────────────────────────────
test('localIds: conversa negativa, mensagens positivas no intervalo reservado, exatas no JS', () => {
  const slot = P.SLOTS - 1;
  const cid = P.localConvId(slot);
  assert.ok(cid < 0);
  assert.equal(P.isLocalImportConvId(cid), true);
  assert.equal(P.isLocalImportConvId(String(cid)), true);
  assert.equal(P.slotOfConvId(cid), slot);
  assert.equal(P.isLocalImportConvId(12345), false);
  assert.equal(P.isLocalImportConvId(-5), false);
  assert.equal(P.isLocalImportConvId(''), false);
  const top = P.localMsgId(slot, P.MSG_SPAN - 1);
  assert.ok(Number.isSafeInteger(top));
  assert.equal(P.isLocalImportMsgId(top), true);
  assert.equal(P.isLocalImportMsgId(P.localMsgId(0, 1)), true);
  assert.equal(P.isLocalImportMsgId(987654321), false);
  assert.ok(P.slotFromHex('ffffffff') < P.SLOTS);
});

// ── iOS pt-BR ───────────────────────────────────────────────────────────
test('iOS pt-BR: multilinha, anexado, imagem omitida, apagada, editada, sistema, eu × outro', () => {
  const media = new Map([['00000012-photo-2023-12-25-21-07-00.jpg', { local_path: 'file:///docs/wa-import-local/1/00000012-PHOTO-2023-12-25-21-07-00.jpg', size: 1234, mime: 'image/jpeg' }]]);
  const { rows, conversation, parsed } = P.parseToLocal(IOS_PT, { owner: OWNER, meName: 'Bruno Exemplo', importedAt: '2026-10-22T10:00:00.000Z', media, mediaNames: ['00000012-PHOTO-2023-12-25-21-07-00.jpg'] });
  assert.equal(parsed.platform, 'ios');
  assert.equal(rows.length, 7);
  const types = rows.map((r) => r.type);
  assert.equal(types[0], 'system');
  const multi = rows.find((r) => r.content.includes('segunda linha'));
  assert.ok(multi, 'multilinha preservada');
  assert.equal(multi.content, 'tudo ótimo\nsegunda linha da mesma mensagem\nterceira linha');
  assert.equal(multi.sender_email, OWNER, 'eu = e-mail da conta');
  assert.equal(multi.is_mine, 1);
  const ana = rows.find((r) => r.sender_name === 'Ana Sintética' && r.type === 'text');
  assert.match(ana.sender_email, /^wa-[0-9a-f]{16}@import\.local\.invalid$/, 'outro = e-mail sintético, nunca real');
  const photo = rows.find((r) => r.type === 'image');
  assert.equal(photo.file_name, '00000012-PHOTO-2023-12-25-21-07-00.jpg');
  assert.equal(photo.local_path, 'file:///docs/wa-import-local/1/00000012-PHOTO-2023-12-25-21-07-00.jpg');
  assert.equal(photo.file_size, 1234);
  assert.ok(rows.some((r) => r.media_omitted === 1), 'imagem omitida marcada');
  const del = rows.find((r) => r.deleted === 1);
  assert.ok(del && del.content === '' && del.deleted_at);
  const ed = rows.find((r) => r.edited === 1);
  assert.ok(ed && /bom dia/.test(ed.content));
  // marcas de cópia pessoal importada
  for (const r of rows) {
    assert.equal(r.imported, 1); assert.equal(r.is_imported, 1); assert.equal(r.import_source, 'whatsapp');
    assert.equal(r.imported_at, '2026-10-22T10:00:00.000Z');
    assert.equal(r.conversation_id, conversation.id);
    assert.ok(P.isLocalImportMsgId(r.id));
    assert.ok(!/[‪-‮]/.test(r.content));
    assert.ok(r.client_message_id.startsWith('wal:'), 'nunca "wai:" (servidor)');
  }
  // ordem = id crescente = cronológica
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].id > rows[i - 1].id);
    assert.ok(rows[i].created_at >= rows[i - 1].created_at);
  }
  assert.equal(conversation.archived, 1);
  assert.equal(conversation.imported, 1);
  assert.equal(conversation.local_only, 1);
  assert.equal(conversation.type, 'direct');
  assert.equal(conversation.message_count, 7);
  assert.equal(conversation.media_count, 1);
  assert.ok(P.isLocalImportConvId(conversation.id));
});

test('iOS pt-BR: mesma entrada → mesmos ids (reimportar não duplica)', () => {
  const a = P.parseToLocal(IOS_PT, { owner: OWNER, meName: 'Bruno Exemplo' });
  const b = P.parseToLocal(IOS_PT, { owner: OWNER, meName: 'Bruno Exemplo' });
  assert.deepEqual(a.rows.map((r) => r.id), b.rows.map((r) => r.id));
  assert.equal(a.conversation.id, b.conversation.id);
  const other = P.parseToLocal(IOS_PT, { owner: 'outra.conta@chatyy.com.br', meName: 'Bruno Exemplo' });
  assert.notEqual(other.conversation.chat_key, a.conversation.chat_key, 'outra conta no mesmo aparelho = outra chave');
});

// ── Android pt-BR ───────────────────────────────────────────────────────
test('Android pt-BR: remetente = telefone, "(arquivo anexado)" com legenda, <Mídia oculta>, áudio PTT', () => {
  const media = new Map([['img-20231225-wa0001.jpg', { local_path: 'file:///x/IMG-20231225-WA0001.jpg', size: 10 }]]);
  const { rows, parsed } = P.parseToLocal(ANDROID_PT, { owner: OWNER, meName: 'Carla Teste', media, mediaNames: ['IMG-20231225-WA0001.jpg', 'PTT-20231225-WA0002.opus'] });
  assert.equal(parsed.platform, 'android');
  assert.equal(rows[0].type, 'system');
  const phone = rows.find((r) => r.sender_name === '+55 11 90000-0001' && r.type === 'text');
  assert.ok(phone, 'remetente telefone preservado');
  assert.equal(phone.original_sender, '+55 11 90000-0001');
  const img = rows.find((r) => r.type === 'image');
  assert.equal(img.content, 'legenda da foto');
  assert.equal(img.local_path, 'file:///x/IMG-20231225-WA0001.jpg');
  assert.equal(img.sender_email, OWNER);
  const voice = rows.find((r) => r.type === 'voice');
  assert.ok(voice, 'PTT .opus = voz');
  assert.equal(voice.media_missing, 1, 'mídia citada mas fora do zip → marcada ausente');
  assert.ok(rows.some((r) => r.media_omitted === 1));
});

// ── iOS en-US ───────────────────────────────────────────────────────────
test('iOS en-US: 12 h com U+202F, image omitted, deleted', () => {
  const { rows } = P.parseToLocal(IOS_EN, { owner: OWNER, meName: 'John Sample' });
  assert.equal(rows.length, 4);
  assert.equal(new Date(rows[0].created_at).getHours(), 21);
  assert.equal(new Date(rows[3].created_at).getHours(), 7);
  assert.ok(rows.some((r) => r.media_omitted === 1));
  assert.ok(rows.some((r) => r.deleted === 1));
  assert.equal(rows[0].sender_email, OWNER);
  assert.notEqual(rows[1].sender_email, OWNER);
});

// ── Android es ──────────────────────────────────────────────────────────
test('Android es: <Multimedia omitido>, Se eliminó, sistema de grupo, dd/mm/aa', () => {
  const { rows, conversation } = P.parseToLocal(ANDROID_ES, { owner: OWNER, meName: 'Juan Prueba' });
  assert.equal(rows.length, 5);
  assert.ok(rows.some((r) => r.media_omitted === 1));
  assert.ok(rows.some((r) => r.deleted === 1));
  assert.ok(rows.some((r) => r.type === 'system' && /Grupo Falso/.test(r.content)));
  const d = new Date(rows[4].created_at);
  assert.equal(d.getFullYear(), 2023); assert.equal(d.getMonth(), 11); assert.equal(d.getDate(), 26);
  assert.ok(conversation.name);
});

test('cleanText: tira controles e bidi de override, mantém quebra de linha e acentos', () => {
  assert.equal(P.cleanText('a‮b\u0007c\nção'), 'abc\nção');
});

test('buildLocalRows: startSeq continua a numeração; linha sem data é descartada', () => {
  const msgs = [
    { tsLocal: '2023-01-01T10:00:00', sender: 'X', kind: 'text', text: 'a', key: 'k1' },
    { tsLocal: 'lixo', sender: 'X', kind: 'text', text: 'b', key: 'k2' },
    { tsLocal: '2023-01-01T10:01:00', sender: 'Y', kind: 'text', text: 'c', key: 'k3' },
  ];
  const rows = P.buildLocalRows(msgs, { slot: 7, chatKey: 'ab', owner: OWNER, meName: 'Y', startSeq: 10 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, P.localMsgId(7, 11));
  assert.equal(rows[1].id, P.localMsgId(7, 12));
  assert.equal(rows[1].sender_email, OWNER);
});
