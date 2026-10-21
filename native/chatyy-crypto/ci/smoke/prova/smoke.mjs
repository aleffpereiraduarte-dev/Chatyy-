// Smoke wasm em Node do núcleo TEMPORÁRIO (prova): glue wasm-bindgen --target nodejs.
// Uso: node smoke.mjs <dir com chatyy_crypto.js (nodejs)>
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const dir = path.resolve(process.argv[2]);
const m = require(path.join(dir, 'chatyy_crypto.js'));
const v = m.coreVersion();
if (!v.startsWith('chatyy-crypto')) throw new Error('coreVersion inesperado');
const msg = 'Olá, isto é E2EE de verdade 🔒';
const out = await m.provaRoundtrip(msg);
if (out !== msg) throw new Error('roundtrip divergente');
console.log(`WASM SMOKE OK: ${v} | roundtrip Olm/Megolm ok (Node ${process.version})`);
