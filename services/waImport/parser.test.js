/**
 * [2026-10-10 wa-import] Testes do parser de export do WhatsApp + sha256 + zip.
 * Só amostras SINTÉTICAS (nomes e textos inventados).
 *
 * Rodar:  node services/waImport/parser.test.js
 * (transpila os módulos ESM com @babel/core do próprio projeto; usa node:test.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const Module = require('module');
const babel = require('@babel/core');

function load(rel) {
  const file = path.join(__dirname, rel);
  const { code } = babel.transformFileSync(file, {
    babelrc: false, configFile: false,
    plugins: ['@babel/plugin-transform-modules-commonjs'],
  });
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  const origReq = m.require.bind(m);
  m.require = (id) => (id.startsWith('.') ? load(path.join(path.dirname(rel), id) + (id.endsWith('.js') ? '' : '.js')) : origReq(id));
  m._compile(code, file);
  return m.exports;
}

const P = load('parser.js');
const S = load('sha256.js');
const Z = load('zip.js');

const LRM = '\u200e';
const NNBSP = '\u202f';

test('sha256 = node crypto', () => {
  for (const s of ['', 'abc', 'ação ✓ 😀 日本語', 'x'.repeat(1000), 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64)]) {
    assert.equal(S.sha256Hex(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'));
  }
});

test('iOS pt-BR 24h com segundos, multilinha, anexo, mídia oculta, apagada, editada, sistema', () => {
  const txt = [
    `[03/01/24, 09:15:02] Grupo Teste: ${LRM}As mensagens e as chamadas são protegidas com a criptografia de ponta a ponta.`,
    `[03/01/24, 09:15:10] Ana Exemplo: Bom dia!`,
    `[03/01/24, 09:16:00] Bruno Ficticio: Linha 1`,
    `Linha 2`,
    ``,
    `Linha 4`,
    `[03/01/24, 09:17:30] Ana Exemplo: ${LRM}<anexado: 00000003-PHOTO-2024-01-03-09-17-30.jpg>`,
    `[03/01/24, 09:18:00] Bruno Ficticio: ${LRM}imagem ocultada`,
    `[13/01/24, 21:00:00] Ana Exemplo: ${LRM}Mensagem apagada`,
    `[13/01/24, 21:01:00] Bruno Ficticio: texto corrigido ${LRM}<Mensagem editada>`,
    `[13/01/24, 21:02:00] Grupo Teste: ${LRM}Ana Exemplo adicionou Carla Inventada`,
  ].join('\n');
  const r = P.parseWhatsAppChat(txt, { fileName: 'WhatsApp Chat - Grupo Teste.zip', title: 'Grupo Teste' });
  assert.equal(r.platform, 'ios');
  assert.equal(r.dateOrder, 'dmy');
  assert.equal(r.title, 'Grupo Teste');
  const k = r.messages.map((m) => m.kind);
  assert.deepEqual(k, ['system', 'text', 'text', 'media', 'media_omitted', 'deleted', 'text', 'system']);
  assert.equal(r.messages[0].sender, null);
  assert.equal(r.messages[1].tsLocal, '2024-01-03T09:15:10');
  assert.equal(r.messages[2].text, 'Linha 1\nLinha 2\n\nLinha 4');
  assert.equal(r.messages[3].attachment, '00000003-PHOTO-2024-01-03-09-17-30.jpg');
  assert.equal(r.messages[6].edited, true);
  assert.equal(r.messages[6].text, 'texto corrigido');
  assert.deepEqual(r.participants.map((p) => p.name).sort(), ['Ana Exemplo', 'Bruno Ficticio']);
});

test('iOS en-US 12h AM/PM com U+202F', () => {
  const txt = [
    `[1/2/24, 9:05:12${NNBSP}PM] Dana Sample: hello`,
    `[1/2/24, 11:59:59${NNBSP}PM] Eli Mock: hi`,
    `[1/3/24, 12:00:01${NNBSP}AM] Dana Sample: ${LRM}This message was deleted.`,
    `[1/3/24, 12:30:00${NNBSP}PM] Eli Mock: ${LRM}<attached: 00000009-AUDIO-2024-01-03-12-30-00.opus>`,
    `[1/13/24, 8:00:00${NNBSP}AM] Eli Mock: ${LRM}video omitted`,
  ].join('\n');
  const r = P.parseWhatsAppChat(txt, {});
  assert.equal(r.dateOrder, 'mdy');
  assert.deepEqual(r.messages.map((m) => m.tsLocal), [
    '2024-01-02T21:05:12', '2024-01-02T23:59:59', '2024-01-03T00:00:01', '2024-01-03T12:30:00', '2024-01-13T08:00:00',
  ]);
  assert.deepEqual(r.messages.map((m) => m.kind), ['text', 'text', 'deleted', 'media', 'media_omitted']);
  assert.equal(P.mediaKindFromName(r.messages[3].attachment), 'voice');
});

test('Android pt-BR "dd/mm/aaaa hh:mm - " com anexo + legenda e <Mídia oculta>', () => {
  const txt = [
    `14/02/2023 08:01 - As mensagens e as chamadas são protegidas com a criptografia de ponta a ponta. Ninguém fora desta conversa pode ler ou ouvi-las.`,
    `14/02/2023 08:02 - Fabio Teste: Oi`,
    `14/02/2023 08:03 - Gabi Exemplo: IMG-20230214-WA0001.jpg (arquivo anexado)`,
    `legenda da foto`,
    `14/02/2023 08:04 - Gabi Exemplo: <Mídia oculta>`,
    `14/02/2023 08:05 - Fabio Teste: Você apagou esta mensagem`,
    `14/02/2023 08:06 - Fabio Teste: horário: 10:30 - ok?`,
    `14/02/2023 08:07 - Fabio Teste: editei <Mensagem editada>`,
  ].join('\n');
  const r = P.parseWhatsAppChat(txt, { fileName: 'Conversa do WhatsApp com Gabi Exemplo.txt', mediaNames: ['IMG-20230214-WA0001.jpg'] });
  assert.equal(r.platform, 'android');
  assert.equal(r.title, 'Gabi Exemplo');
  assert.deepEqual(r.messages.map((m) => m.kind), ['system', 'text', 'media', 'media_omitted', 'deleted', 'text', 'text']);
  assert.equal(r.messages[2].attachment, 'IMG-20230214-WA0001.jpg');
  assert.equal(r.messages[2].text, 'legenda da foto');
  assert.equal(r.messages[5].text, 'horário: 10:30 - ok?');
  assert.equal(r.messages[6].edited, true);
  assert.equal(P.guessMe(r.participants, { title: r.title }), 'Fabio Teste');
});

test('Android en-US "m/d/yy, h:mm AM - " (U+202F) + file attached', () => {
  const txt = [
    `12/25/22, 9:05${NNBSP}PM - Hal Fake: Merry fake day`,
    `12/25/22, 10:15${NNBSP}PM - Ivy Mock: VID-20221225-WA0002.mp4 (file attached)`,
    `12/26/22, 7:00${NNBSP}AM - Ivy Mock: <Media omitted>`,
    `12/26/22, 7:01${NNBSP}AM - Hal Fake: Hello <This message was edited>`,
  ].join('\n');
  const r = P.parseWhatsAppChat(txt, { fileName: 'WhatsApp Chat with Ivy Mock.txt' });
  assert.equal(r.dateOrder, 'mdy');
  assert.equal(r.messages[0].tsLocal, '2022-12-25T21:05:00');
  assert.equal(r.messages[2].tsLocal, '2022-12-26T07:00:00');
  assert.deepEqual(r.messages.map((m) => m.kind), ['text', 'media', 'media_omitted', 'text']);
  assert.equal(r.messages[3].edited, true);
  assert.equal(r.title, 'Ivy Mock');
});

test('Alemão "dd.mm.yy, hh:mm - " e espanhol "p. m."', () => {
  const de = [
    `05.03.21, 18:30 - Jan Probe: Hallo`,
    `05.03.21, 18:31 - Kim Test: <Medien ausgeschlossen>`,
    `05.03.21, 18:32 - Kim Test: Diese Nachricht wurde gelöscht`,
  ].join('\n');
  const r1 = P.parseWhatsAppChat(de, {});
  assert.deepEqual(r1.messages.map((m) => m.kind), ['text', 'media_omitted', 'deleted']);
  assert.equal(r1.messages[0].tsLocal, '2021-03-05T18:30:00');
  const es = [
    `7/4/21, 3:15 p. m. - Lu Prueba: Hola`,
    `7/4/21, 3:16 p. m. - Lu Prueba: <Multimedia omitido>`,
  ].join('\n');
  const r2 = P.parseWhatsAppChat(es, { localeHint: 'es' });
  assert.equal(r2.messages[0].tsLocal, '2021-04-07T15:15:00');
  assert.equal(r2.messages[1].kind, 'media_omitted');
});

test('ano primeiro (ja/ISO) e dígitos arábicos', () => {
  const ja = [`2022/08/09 23:10 - Mio Kari: こんにちは`, `[2022-08-10 07:05:00] Mio Kari: おはよう`].join('\n');
  const r = P.parseWhatsAppChat(ja, {});
  assert.equal(r.dateOrder, 'ymd');
  assert.equal(r.messages[0].tsLocal, '2022-08-09T23:10:00');
  assert.equal(r.messages[1].tsLocal, '2022-08-10T07:05:00');
  const ar = `٢٥/١٢/٢٠٢٣ ٩:٠٥ م - Nur Mock: مرحبا`;
  const r2 = P.parseWhatsAppChat(ar, {});
  assert.equal(r2.messages[0].tsLocal, '2023-12-25T21:05:00');
  assert.equal(r2.messages[0].sender, 'Nur Mock');
});

test('ordem ambígua resolvida pela cronologia; dica de idioma no empate', () => {
  // 01/02 → 02/03 → 03/04 : só "mdy" e "dmy" são ambos válidos; cronologia decide.
  const txt = [`01/02/24 10:00 - A: a`, `02/01/24 10:00 - A: b`, `03/01/24 10:00 - A: c`].join('\n');
  // dmy: 1 fev, 2 jan, 3 jan (1 volta) ; mdy: 2 jan, 1 fev, 1 mar (0 voltas) → mdy
  assert.equal(P.parseWhatsAppChat(txt, {}).dateOrder, 'mdy');
  const one = `05/06/24 10:00 - A: a`;
  assert.equal(P.parseWhatsAppChat(one, { localeHint: 'en-US' }).dateOrder, 'mdy');
  assert.equal(P.parseWhatsAppChat(one, { localeHint: 'pt-BR' }).dateOrder, 'dmy');
});

test('chaves estáveis e únicas (mensagens idênticas no mesmo minuto)', () => {
  const txt = [`01/02/2024 10:00 - Ana: ok`, `01/02/2024 10:00 - Ana: ok`, `01/02/2024 10:01 - Bia: ok`].join('\n');
  const a = P.parseWhatsAppChat(txt, {});
  const b = P.parseWhatsAppChat(txt + '\n01/02/2024 10:02 - Bia: nova', {});
  assert.equal(new Set(a.messages.map((m) => m.key)).size, 3);
  assert.deepEqual(b.messages.slice(0, 3).map((m) => m.key), a.messages.map((m) => m.key));
});

test('BOM/UTF-16, CRLF, linhas antes do 1º cabeçalho', () => {
  const s = '\ufefflixo\r\n25/12/2023 21:05 - Ana: oi\r\nsegunda\r\n';
  const r = P.parseWhatsAppChat(s.replace(/\r/g, ''), {});
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].text, 'oi\nsegunda');
  const u16 = Buffer.from('\ufeff25/12/2023 21:05 - Ana: olá', 'utf16le');
  assert.match(P.decodeChatBytes(new Uint8Array(u16)), /Ana: olá/);
  assert.equal(P.decodeChatBytes(new Uint8Array(Buffer.from('\ufeffabc'))), 'abc');
  assert.equal(P.looksLikeWhatsAppChat('25/12/2023 21:05 - Ana: oi\n25/12/2023 21:06 - Bia: oi'), true);
  assert.equal(P.looksLikeWhatsAppChat('lista de compras\nleite\npão'), false);
});

test('títulos de arquivo', () => {
  assert.equal(P.titleFromFileName('WhatsApp Chat - Fulano de Tal.zip'), 'Fulano de Tal');
  assert.equal(P.titleFromFileName('WhatsApp Chat with Team X (1).txt'), 'Team X');
  assert.equal(P.titleFromFileName('Chat de WhatsApp con Pepe.txt'), 'Pepe');
  assert.equal(P.titleFromFileName('WhatsApp Chat mit Max.zip'), 'Max');
  assert.equal(P.titleFromFileName('Discussion WhatsApp avec Zoé.txt'), 'Zoé');
  assert.equal(P.titleFromFileName('_chat.txt'), '');
  assert.equal(P.titleFromFileName('WhatsApp_Chat_-_Grupo_X.zip'), 'Grupo X');
  assert.equal(P.titleFromFileName('1791234567_WhatsApp Chat - Ana.zip'), 'Ana');
});

test('guessMe pelo nome do perfil', () => {
  const parts = [{ name: 'José Exemplo' }, { name: 'Maria Teste' }];
  assert.equal(P.guessMe(parts, { myName: 'jose exemplo' }), 'José Exemplo');
  assert.equal(P.guessMe(parts, { myName: 'Outro' }), null);
});

test('localTsToIso', () => {
  const iso = P.localTsToIso('2024-01-02T21:05:12');
  const d = new Date(iso);
  assert.equal(d.getFullYear(), 2024); assert.equal(d.getHours(), 21); assert.equal(d.getSeconds(), 12);
  assert.equal(P.localTsToIso('lixo'), null);
});

// ── zip ────────────────────────────────────────────────────────────────────
function makeZip(files) {
  // files: [{ name, data:Buffer, deflate:bool }]
  const locals = []; const centrals = []; let off = 0;
  for (const f of files) {
    const nameB = Buffer.from(f.name, 'utf8');
    const comp = f.deflate ? zlib.deflateRawSync(f.data) : f.data;
    const crc = zlib.crc32 ? zlib.crc32(f.data) : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(f.deflate ? 8 : 0, 8); lh.writeUInt32LE(crc >>> 0, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(nameB.length, 26);
    locals.push(lh, nameB, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(f.deflate ? 8 : 0, 10); ch.writeUInt32LE(crc >>> 0, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt32LE(off, 42);
    centrals.push(ch, nameB);
    off += 30 + nameB.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
function memSource(buf) {
  return { size: buf.length, read: async (o, n) => new Uint8Array(buf.subarray(o, o + n)) };
}

test('zip: lista e extrai (stored + deflate, em pedaços)', async () => {
  const chat = Buffer.from('[03/01/24, 09:15:10] Ana Exemplo: Bom dia!\n', 'utf8');
  const big = crypto.randomBytes(300000);
  const zipBuf = makeZip([
    { name: '_chat.txt', data: chat, deflate: true },
    { name: '00000003-PHOTO-2024-01-03-09-17-30.jpg', data: big, deflate: false },
    { name: 'doc.pdf', data: Buffer.from('x'.repeat(200000)), deflate: true },
  ]);
  const src = memSource(zipBuf);
  const entries = await Z.listZipEntries(src);
  assert.deepEqual(entries.map((e) => e.name), ['_chat.txt', '00000003-PHOTO-2024-01-03-09-17-30.jpg', 'doc.pdf']);
  const txt = await Z.readZipEntryBytes(src, entries[0]);
  assert.equal(Buffer.from(txt).toString('utf8'), chat.toString('utf8'));
  for (const [i, ref] of [[1, big], [2, Buffer.from('x'.repeat(200000))]]) {
    const parts = [];
    await Z.extractZipEntry(src, entries[i], (chunk) => { parts.push(Buffer.from(chunk)); }, { chunkSize: 65536 });
    assert.ok(Buffer.concat(parts).equals(ref));
  }
  assert.equal(await Z.isZip(src), true);
  assert.equal(await Z.isZip(memSource(Buffer.from('not a zip at all'))), false);
});
