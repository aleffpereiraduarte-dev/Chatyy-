#!/usr/bin/env node
// [e2ee5 WP-04] Junta glue (no-modules) + worker.src.js em workerBundle.generated.js e grava o
// manifest com o SHA-256 do .wasm. Uso: node gen-worker-bundle.js <vendorDir> <appDir>
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const [vendor, app] = process.argv.slice(2);
const wasm = fs.readFileSync(path.join(vendor, 'chatyy_crypto_bg.wasm'));
const glue = fs.readFileSync(path.join(vendor, 'chatyy_crypto_wasm.js'), 'utf8');
const src = fs.readFileSync(path.join(app, 'services/crypto/worker/worker.src.js'), 'utf8');
const sha = crypto.createHash('sha256').update(wasm).digest('hex');
const gz = require('zlib').gzipSync(wasm, { level: 9 }).length;
// coreVersion: format!() no Rust (não é literal no wasm) → monta a partir das fontes do núcleo.
const lib = fs.readFileSync(path.join(app, 'native/chatyy-crypto/src/lib.rs'), 'utf8');
const c = /CONTRACT_VERSION: &str = "([^"]+)"/.exec(lib);
const v = /^version = "([^"]+)"/m.exec(fs.readFileSync(path.join(app, 'native/chatyy-crypto/Cargo.toml'), 'utf8'));
const coreVersion = `chatyy-crypto ${v ? v[1] : '?'}; contrato ${c ? c[1] : '?'}; matrix-sdk-crypto 0.18.0; vodozemac 0.10.0`;
const workerSource = `${glue}\n;\n${src}\n`;
const header = '// GERADO por vendor/chatyy-crypto-wasm/build.sh — NÃO EDITAR. Fonte: services/crypto/worker/worker.src.js + glue wasm-bindgen.\n';
const out =
  header +
  `export const WASM_SHA256 = ${JSON.stringify(sha)};\n` +
  `export const WASM_BYTES = ${wasm.length};\n` +
  `export const CORE_VERSION = ${JSON.stringify(coreVersion)};\n` +
  `export const WORKER_SOURCE = ${JSON.stringify(workerSource)};\n`;
fs.writeFileSync(path.join(app, 'services/crypto/worker/workerBundle.generated.js'), out);
const manifest = {
  generated_at: new Date().toISOString(),
  core_version: coreVersion,
  wasm: { file: 'chatyy_crypto_bg.wasm', bytes: wasm.length, gzip_bytes: gz, sha256: sha },
  worker_source_bytes: Buffer.byteLength(workerSource),
  wasm_bindgen: '0.2.129',
  target: 'wasm32-unknown-unknown (no-modules glue, Web Worker dedicado)',
};
fs.writeFileSync(path.join(vendor, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest));
