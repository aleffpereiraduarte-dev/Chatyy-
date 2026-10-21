// Smoke wasm em Node do núcleo REAL via a ponte do WP-04 (glue --target nodejs).
// IndexedDB não existe no Node: o openCore fica para o Playwright do WP-04 (runner BR).
// Uso: node smoke.mjs <dir com chatyy_crypto.js (nodejs)>
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const m = require(path.join(path.resolve(process.argv[2]), 'chatyy_crypto.js'));
const v = m.coreVersion();
if (!v.startsWith('chatyy-crypto ')) throw new Error('coreVersion inesperado');
if (m.envelopeVersion('{"e2e":5,"c":{}}') !== 5) throw new Error('envelopeVersion');
const dev = m.newDeviceId('W');
const plain = new TextEncoder().encode('foto 🔒');
const [data, info] = m.encryptBytes(plain);
const back = m.decryptBytes(data, info);
if (Buffer.compare(Buffer.from(back), Buffer.from(plain)) !== 0) throw new Error('mídia');
console.log(`WASM SMOKE OK: ${v} | device ${dev.length} chars | mídia ok (Node ${process.version})`);
