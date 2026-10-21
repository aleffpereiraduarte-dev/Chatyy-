#!/usr/bin/env node
// [e2ee5 WP-13 2026-10-21] Gera services/lkE2eeWorker.web.js com o worker de E2EE do
// livekit-client (dist/livekit-client.e2ee.worker.js, UMD/clássico, autocontido) como string.
// A web cria o Worker por Blob (o Metro não empacota `new Worker(new URL(..))`), igual ao
// worker do núcleo (services/crypto/worker). Rodar de novo SEMPRE que o livekit-client mudar:
//   node scripts/build-lk-e2ee-worker.js
// O arquivo gerado guarda a versão; em runtime, versão diferente do livekit-client carregado =
// sem E2EE (a ligação cifrada não sobe — falha fechada).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.join(__dirname, '..');
const pkgDir = path.join(root, 'node_modules', 'livekit-client');
const version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
let src = fs.readFileSync(path.join(pkgDir, 'dist', 'livekit-client.e2ee.worker.js'), 'utf8');
src = src.replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
const sha = crypto.createHash('sha256').update(src).digest('hex');
const out = `// GERADO por scripts/build-lk-e2ee-worker.js — NÃO EDITAR. livekit-client ${version}, sha256 ${sha}
// [e2ee5 WP-13] Worker de E2EE (insertable streams / RTCRtpScriptTransform) do LiveKit para a web.
/* eslint-disable */
export const LK_E2EE_WORKER_VERSION = ${JSON.stringify(version)};
export const LK_E2EE_WORKER_SHA256 = ${JSON.stringify(sha)};
const WORKER_SOURCE = ${JSON.stringify(src)};
let _url = null;
/** Worker novo (um por Room). null = navegador sem Worker/Blob. */
export function createLkE2eeWorker() {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return null;
  if (!_url) _url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
  return new Worker(_url, { name: 'chatyy-lk-e2ee' });
}
export default createLkE2eeWorker;
`;
fs.writeFileSync(path.join(root, 'services', 'lkE2eeWorker.web.js'), out);
console.log('lkE2eeWorker.web.js', version, sha.slice(0, 12), out.length, 'bytes');
