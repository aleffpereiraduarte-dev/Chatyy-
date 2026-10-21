// [e2ee5 WP-04] Cliente do Web Worker do núcleo (só web). Carregado SOB DEMANDA por
// services/crypto/index.web.js via import() — nada daqui entra no bundle de boot.
//
// - Cria o worker a partir do código embutido em workerBundle.generated.js (Blob URL; a CSP já
//   permite `worker-src 'self' blob:`). O código do worker vem no mesmo chunk JS do app, então
//   herda a integridade do bundle; o .wasm é um asset do Metro e o worker confere o SHA-256
//   antes de instanciar (equivalente a SRI).
// - RPC por postMessage com ids; bytes vão como Uint8Array transferível.
// - Se o wasm abortar (panic/trap), o worker é descartado e recriado na próxima chamada.
// - Nunca loga conteúdo/chave/bearer.
import { WORKER_SOURCE, WASM_SHA256, WASM_BYTES, CORE_VERSION } from './workerBundle.generated';

const WASM_MODULE = require('../../../vendor/chatyy-crypto-wasm/chatyy_crypto_bg.wasm');

function assetUrl(mod) {
  let u = mod;
  if (u && typeof u === 'object') u = u.uri || u.default || u.httpServerLocation || '';
  if (typeof u === 'number') {
    try {
      // eslint-disable-next-line global-require
      const { Asset } = require('expo-asset');
      u = Asset.fromModule(u).uri;
    } catch (_) {
      u = '';
    }
  }
  if (typeof u !== 'string' || !u) throw codeErr('unsupported', { what: 'wasm_asset' });
  try {
    return new URL(u, globalThis.location && globalThis.location.href).href;
  } catch (_) {
    return u;
  }
}

function codeErr(code, extra) {
  const e = new Error(`e2ee5:${code}`);
  e.code = code;
  if (extra) Object.assign(e, { details: extra });
  return e;
}

function toError(obj) {
  const o = obj || {};
  const e = codeErr(o.code || 'internal');
  const d = { ...o };
  delete d.code;
  e.details = d;
  if (o.code === 'utd') {
    e.reason = o.reason;
    e.retryable = !!o.retryable;
  }
  return e;
}

let worker = null;
let booting = null;
let seq = 0;
const pending = new Map();
let mainTransport = null; // só testes: transporte implementado pela página
let lastAuth = null;

function spawn() {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    throw codeErr('unsupported', { what: 'worker' });
  }
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
  const w = new Worker(url, { name: 'chatyy-e2ee5' });
  // O Blob pode ser revogado depois que o worker carregou o script.
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch (_) {}
  }, 30000);
  w.onmessage = (ev) => onMessage(w, ev.data || {});
  w.onerror = () => {
    failAll(w, codeErr('worker_error'));
  };
  return w;
}

function failAll(w, err) {
  if (worker !== w) return;
  worker = null;
  booting = null;
  for (const [, p] of pending) p.reject(err);
  pending.clear();
  try {
    w.terminate();
  } catch (_) {}
}

function onMessage(w, m) {
  if (m.t === 'reply') {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.r);
    else {
      const e = toError(m.e);
      if (e.code === 'wasm_trap') {
        // Instância wasm morta: descarta o worker; a próxima chamada recria (store intacto).
        setTimeout(() => failAll(w, e), 0);
      }
      p.reject(e);
    }
    return;
  }
  if (m.t === 'transport') {
    const reply = (r) => w.postMessage({ t: 'transport_reply', tid: m.tid, ...r });
    if (!mainTransport) return reply({ ok: false });
    Promise.resolve()
      .then(() => mainTransport(m.action, m.body, m.device))
      .then((r) => reply({ ok: true, status: r.status, body: String(r.body == null ? '' : r.body) }))
      .catch(() => reply({ ok: false }));
  }
}

function post(w, op, args, transfer) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    try {
      w.postMessage({ id, op, args }, transfer || []);
    } catch (e) {
      pending.delete(id);
      reject(codeErr('internal', { msg: 'post_failed' }));
    }
  });
}

async function ensure() {
  if (worker && booting) {
    await booting;
    return worker;
  }
  const w = spawn();
  worker = w;
  booting = (async () => {
    const info = await post(w, 'init', { wasmUrl: assetUrl(WASM_MODULE), wasmSha256: WASM_SHA256 });
    if (lastAuth) await post(w, 'setAuth', lastAuth);
    return info;
  })();
  try {
    await booting;
  } catch (e) {
    failAll(w, e);
    throw e;
  }
  return w;
}

/** Chamada RPC genérica (usada por index.web.js). */
export async function rpc(op, args, transfer) {
  const w = await ensure();
  return post(w, op, args || {}, transfer);
}

export async function setAuth(a) {
  lastAuth = { ...(lastAuth || {}), ...a };
  if (lastAuth.mode === 'main' && typeof a.transport === 'function') mainTransport = a.transport;
  delete lastAuth.transport;
  if (worker) await rpc('setAuth', lastAuth);
}

/** Probe sem abrir store: o navegador consegue rodar o E2EE? */
export async function probe() {
  const base = {
    worker: typeof Worker !== 'undefined',
    wasm: typeof WebAssembly === 'object',
    subtle: !!(globalThis.crypto && globalThis.crypto.subtle),
  };
  if (!base.worker || !base.wasm || !base.subtle) return { ...base, ok: false };
  const r = await rpc('probe');
  return { ...r, ok: !!(r.worker && r.wasm && r.subtle && r.indexedDB) };
}

export function terminate() {
  if (worker) failAll(worker, codeErr('terminated'));
}

export const bundleInfo = { wasmSha256: WASM_SHA256, wasmBytes: WASM_BYTES, coreVersion: CORE_VERSION };
