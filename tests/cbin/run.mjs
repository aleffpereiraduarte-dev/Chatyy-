import fs from 'fs';
import { encode, decode, CBIN_DICT_HASH } from './cbin.mjs';
const V = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let ok = 0, fail = 0, exact = 0, exactN = 0;
const hex = (u8) => Buffer.from(u8).toString('hex');
const norm = (x) => (Array.isArray(x) ? x.map(norm) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, norm(x[k])])) : x);
const eq = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
if (V.dict_hash !== CBIN_DICT_HASH) { console.log('HASH DIFERENTE', V.dict_hash, CBIN_DICT_HASH); process.exit(1); }
for (const v of V.vectors) {
  try {
    // 1) decodificar bytes do Go → igual ao JSON.parse do canônico do Go
    const got = decode(Buffer.from(v.cbin, 'hex'));
    if (!eq(got, JSON.parse(v.canon))) throw new Error('decode ≠ canon');
    // 2) JS codifica o mesmo valor → Go-compatível: decodifica no JS de volta igual
    const js = JSON.parse(v.json);
    const e = encode(js);
    if (!eq(decode(e), JSON.parse(JSON.stringify(js)))) throw new Error('ida-e-volta JS');
    // 3) bytes idênticos aos do Go quando o JSON é "canônico do JS" (números sem forma especial)
    if (JSON.stringify(js) === v.canon || JSON.stringify(JSON.parse(v.canon)) === v.canon) {
      exactN++; if (hex(e) === v.cbin) exact++; else if (process.env.V) console.log('bytes ≠', v.json.slice(0, 120), hex(e).slice(0, 80), v.cbin.slice(0, 80));
    }
    ok++;
  } catch (err) { fail++; if (fail < 8) console.log('FALHA', err.message, v.json.slice(0, 200)); }
}
for (const h of V.reject_decode) { try { decode(Buffer.from(h, 'hex')); console.log('ACEITOU lixo', h); fail++; } catch {} }
for (const j of V.reject_encode) { try { encode(JSON.parse(j)); console.log('ACEITOU surrogate', j); fail++; } catch {} }
// fuzz: bytes aleatórios nunca travam/explodem fora de Error; mutações de vetores válidos
let fz = 0;
for (let i = 0; i < 200000; i++) {
  const base = Buffer.from(V.vectors[i % V.vectors.length].cbin, 'hex');
  const b = Buffer.from(base); const k = 1 + (i % 4);
  for (let j = 0; j < k; j++) b[Math.floor(Math.random() * b.length)] = Math.floor(Math.random() * 256);
  try { const x = decode(b); JSON.stringify(x); fz++; } catch (e) { if (!(e instanceof Error) || !/cbin|JSON|Unexpected|Invalid|BigInt|range/i.test(e.message)) { console.log('fuzz exceção estranha', e); fail++; break; } }
}
// bench
const frames = V.vectors.map((v) => JSON.parse(v.json));
const bins = V.vectors.map((v) => Buffer.from(v.cbin, 'hex'));
const texts = V.vectors.map((v) => v.json);
const N = 20000;
let t = process.hrtime.bigint(); for (let i = 0; i < N; i++) encode(frames[i % frames.length]); const te = Number(process.hrtime.bigint() - t) / N / 1000;
t = process.hrtime.bigint(); for (let i = 0; i < N; i++) decode(bins[i % bins.length]); const td = Number(process.hrtime.bigint() - t) / N / 1000;
t = process.hrtime.bigint(); for (let i = 0; i < N; i++) JSON.parse(texts[i % texts.length]); const tp = Number(process.hrtime.bigint() - t) / N / 1000;
t = process.hrtime.bigint(); for (let i = 0; i < N; i++) JSON.stringify(frames[i % frames.length]); const ts = Number(process.hrtime.bigint() - t) / N / 1000;
console.log(`vetores ok=${ok} falha=${fail} bytes_idênticos_ao_Go=${exact}/${exactN} fuzz_aceitos=${fz}/200000`);
console.log(`µs/frame (node, média do corpus): encode ${te.toFixed(1)} · decode ${td.toFixed(1)} · JSON.stringify ${ts.toFixed(1)} · JSON.parse ${tp.toFixed(1)}`);
process.exit(fail ? 1 : 0);
