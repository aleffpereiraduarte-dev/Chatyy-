// [e2ee5 WP-04] Teste headless do host web (roda NO EDGE BR via chatyy-qa-remote, nunca no US).
// Dist = expo export real (com uma rota QA temporária só na cópia de teste) servido em QA_BASE_URL.
// e2ee5.php real: as chamadas /api/email.php?action=e2ee5_* do worker são roteadas pelo
// Playwright para https://chatyy.com.br (contas QA apitest uid1 / qa2 uid2). Nada de conteúdo
// ou bearer nos logs/resultados.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.QA_BASE_URL;
const OUT = process.env.QA_OUT || '.';
const API = process.env.E2EE5_API || 'https://chatyy.com.br';
const tok = (n) => fs.readFileSync(path.join(__dirname, n), 'utf8').trim();
const TOK = { 1: tok('tok_apitest'), 2: tok('tok_qa2') };
const CONV = '971'; // direct apitest <-> qa2
const R = { steps: [], ok: true, started: new Date().toISOString() };
const created = []; // {uid, deviceId}

function step(name, ok, info) {
  R.steps.push({ name, ok: !!ok, ...(info || {}) });
  if (!ok) R.ok = false;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${info ? ' ' + JSON.stringify(info) : ''}`);
}

async function newCtx(browser, { flag = true } = {}) {
  const ctx = await browser.newContext();
  const stats = { wasm: 0, routed: 0, routedFromWorker: 0, apiStatus: {} };
  ctx.on('request', (r) => {
    if (/chatyy_crypto_bg.*\.wasm/.test(r.url())) stats.wasm++;
  });
  await ctx.route(/\/api\/email\.php\?action=e2ee5_/, async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    stats.routed++;
    try {
      if (req.frame && !req.frame()) stats.routedFromWorker++;
    } catch (_) {
      stats.routedFromWorker++;
    }
    const resp = await route.fetch({ url: API + u.pathname + u.search, timeout: 20000 });
    const a = u.searchParams.get('action');
    stats.apiStatus[a + ':' + resp.status()] = (stats.apiStatus[a + ':' + resp.status()] || 0) + 1;
    await route.fulfill({ response: resp });
  });
  if (flag) await ctx.addInitScript(() => { window.__chatyy_e2ee5 = true; window.__e2ee5_qa_boot = true; });
  else await ctx.addInitScript(() => { window.__e2ee5_qa_boot = true; });
  return { ctx, stats };
}

async function qaPage(ctx) {
  const p = await ctx.newPage();
  await p.goto(BASE + '/e2ee5-qa', { waitUntil: 'load', timeout: 60000 });
  await p.waitForFunction(() => !!window.__e2ee5 || !!window.__e2ee5_err, null, { timeout: 60000 });
  const err = await p.evaluate(() => window.__e2ee5_err || null);
  if (err) throw new Error('qa route import failed: ' + err);
  return p;
}

// Chama services/crypto dentro da página. Erros voltam como {__err: code, details}.
async function E(p, fn, arg) {
  return p.evaluate(
    async ({ fn, arg }) => {
      const m = window.__e2ee5;
      try {
        return await m[fn](...(arg || []));
      } catch (e) {
        return { __err: (e && e.code) || String(e), details: e && e.details, reason: e && e.reason };
      }
    },
    { fn, arg }
  );
}

// Transporte modo 'main': o worker pede à página, que faz fetch same-origin (interceptado pelo
// ctx.route). O fetch DE DENTRO do worker (blob:) não é interceptado pelo Playwright, e o
// dist do teste não está na origem da API (CORS), por isso o modo 'main' só no teste.
async function auth(p, uid) {
  return p.evaluate(async (bearer) => {
    try {
      await window.__e2ee5.setAuth({ mode: 'main', base: '', bearer, transport: async (action, body, dev) => {
        const h = { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' };
        if (dev) h['X-E2EE-Device'] = dev;
        const r = await fetch('/api/email.php?action=e2ee5_' + action, { method: 'POST', headers: h, body });
        return { status: r.status, body: await r.text() };
      } });
      return {};
    } catch (e) { return { __err: e.code || String(e) }; }
  }, TOK[uid]);
}

async function setup(p, uid) {
  const a = await auth(p, uid);
  const st = await E(p, 'status');
  const op = await E(p, 'open', [String(uid), { prefix: 'X' }]);
  if (op && op.deviceId) created.push({ uid: String(uid), deviceId: op.deviceId });
  const s1 = await E(p, 'sync');
  const bi = await E(p, 'bootstrapIdentity');
  const s2 = await E(p, 'sync');
  const td = await E(p, 'thisDevice');
  return { a, st, op, s1, bi, s2, td };
}

async function deleteDevice(request, uid, deviceId) {
  const r = await request.post(API + '/api/email.php?action=e2ee5_device_delete', {
    headers: { Authorization: 'Bearer ' + TOK[uid], 'X-E2EE-Device': deviceId, 'Content-Type': 'application/json' },
    data: JSON.stringify({ device_id: deviceId }),
    timeout: 20000,
  });
  return r.status();
}

(async () => {
  const browser = await chromium.launch();
  try {
    // ---------- T0: flag desligada = nada carrega; boot do app sem wasm ----------
    {
      const { ctx, stats } = await newCtx(browser, { flag: false });
      const p0 = await ctx.newPage();
      const reqs = [];
      p0.on('request', (r) => reqs.push(r.url()));
      await p0.goto(BASE + '/', { waitUntil: 'load', timeout: 60000 });
      await p0.waitForTimeout(4000);
      const bootWasm = reqs.filter((u) => /chatyy_crypto/.test(u)).length;
      step('T0 boot do app não baixa wasm do E2EE', bootWasm === 0, { requests: reqs.length, chatyy_crypto: bootWasm });
      const p = await qaPage(ctx);
      const sup = await E(p, 'isSupported');
      const en = await E(p, 'isEnabled');
      const cv = await E(p, 'coreVersion');
      await p.waitForTimeout(500);
      const workers = p.workers().length;
      step('T0 flag off: isEnabled=false, isSupported.ok=false, chamadas rejeitam "disabled", sem worker/wasm',
        en === false && sup.ok === false && cv && cv.__err === 'disabled' && stats.wasm === 0 && workers === 0,
        { en, sup, cv: cv && cv.__err, wasm: stats.wasm, workers });
      await ctx.close();
    }

    // ---------- T1/T2: dois usuários, contextos (IndexedDB) separados ----------
    const A = await newCtx(browser);
    const B = await newCtx(browser);
    const pa = await qaPage(A.ctx);
    const pb = await qaPage(B.ctx);
    const wasmBefore = A.stats.wasm;
    const t0 = Date.now();
    const supA = await E(pa, 'isSupported');
    const tInit = Date.now() - t0;
    step('T1 lazy: wasm só baixa na 1ª chamada', wasmBefore === 0 && A.stats.wasm === 1, { before: wasmBefore, after: A.stats.wasm, init_ms: tInit });
    step('T1 isSupported (Chromium)', supA && supA.ok === true, supA);
    const cv = await E(pa, 'coreVersion');
    step('T1 coreVersion', typeof cv === 'string' && /e2ee5-contrato\//.test(cv), { cv });
    step('T1 worker dedicado criado', pa.workers().length === 1, { workers: pa.workers().length });

    const ta = Date.now();
    const sa = await setup(pa, 1);
    const sb = await setup(pb, 2);
    step('T2 status (servidor real) A/B', sa.st && sa.st.uid === '1' && sb.st && sb.st.uid === '2', { a: sa.st && sa.st.uid, b: sb.st && sb.st.uid, contract: sa.st && sa.st.contract, enabledA: sa.st && sa.st.enabled });
    step('T2 open cria aparelho X novo', sa.op && sa.op.created === true && /^X[A-Z2-7]{12}$/.test(sa.op.deviceId) && sb.op && sb.op.created === true, { a: sa.op, b: sb.op });
    step('T2 sync + bootstrapIdentity + sync', !sa.s1.__err && !sa.bi.__err && !sa.s2.__err && !sb.bi.__err && sa.bi.isPrimary === true, { a_s1: sa.s1.__err || 'ok', a_bi: sa.bi.__err || sa.bi.isPrimary, b_bi: sb.bi.__err || sb.bi.isPrimary, a_s2: sa.s2.__err || 'ok' });
    step('T2 aparelho assinado pelo dono', sa.td && sa.td.signedByOwner === true && sb.td && sb.td.signedByOwner === true, { a: sa.td && sa.td.signedByOwner, b: sb.td && sb.td.signedByOwner });
    R.setup_ms = Date.now() - ta;
    step('T2 chamadas e2ee5_* do núcleo chegaram ao servidor real (transporte modo main)', A.stats.routed > 0, { routedA: A.stats.routed, fromWorkerA: A.stats.routedFromWorker, apiA: A.stats.apiStatus });

    // ---------- T3: A cifra para B; B decifra (contra e2ee5.php real) ----------
    await E(pa, 'trackUsers', [['2']]);
    await E(pb, 'trackUsers', [['1']]);
    await E(pa, 'sync');
    const cmid = 'cm-wp04-' + Date.now();
    const SECRET = 'oi do WP-04 ' + Math.random().toString(36).slice(2);
    const payload = { v: 1, t: 'text', conv: CONV, cmid, body: SECRET };
    const te = Date.now();
    const enc = await E(pa, 'encrypt', [CONV, ['2'], payload]);
    const encMs = Date.now() - te;
    const env = enc && enc.envelopeJson;
    step('T3 encrypt → envelope e2e:5 sem texto claro', env && /^\{"e2e":5/.test(env) && env.indexOf(SECRET) < 0, { err: enc && enc.__err, details: enc && enc.details, bytes: env && env.length, keyShareRequests: enc && enc.keyShareRequests, ms: encMs });
    let dec = null;
    let tries = 0;
    const td0 = Date.now();
    for (; tries < 6; tries++) {
      const sy = await E(pb, 'sync');
      dec = await E(pb, 'decrypt', [{ convId: CONV, envelopeJson: env, senderUid: '1', serverMid: '9000001', cmid, tsMs: Date.now() }]);
      if (dec && !dec.__err) break;
      if (sy && sy.__err) R.syncErr = sy;
      await pb.waitForTimeout(1000);
    }
    const body = dec && dec.payloadJson ? JSON.parse(dec.payloadJson).body : null;
    step('T3 B decifra a mensagem de A', body === SECRET, { tries: tries + 1, err: dec && dec.__err, reason: dec && dec.reason, details: dec && dec.details, trust: dec && dec.trust, senderDevice: dec && dec.senderDeviceId === sa.op.deviceId, ms: Date.now() - td0 });
    // B responde, A decifra
    const cmid2 = 'cm-wp04r-' + Date.now();
    const enc2 = await E(pb, 'encrypt', [CONV, ['1'], { v: 1, t: 'text', conv: CONV, cmid: cmid2, body: 'resposta' }]);
    let dec2 = null;
    for (let i = 0; i < 6; i++) {
      await E(pa, 'sync');
      dec2 = await E(pa, 'decrypt', [{ convId: CONV, envelopeJson: enc2.envelopeJson, senderUid: '2', serverMid: '9000002', cmid: cmid2, tsMs: Date.now() }]);
      if (dec2 && !dec2.__err) break;
      await pa.waitForTimeout(1000);
    }
    step('T3 A decifra a resposta de B', dec2 && dec2.payloadJson && JSON.parse(dec2.payloadJson).body === 'resposta', { err: dec2 && dec2.__err, reason: dec2 && dec2.reason });
    // contexto trocado (servidor "move" a mensagem) => context_mismatch
    const mv = await E(pb, 'decrypt', [{ convId: CONV, envelopeJson: env, senderUid: '1', serverMid: '9000001', cmid: 'cm-outro-000000', tsMs: Date.now() }]);
    step('T3 cmid trocado → utd context_mismatch', mv && mv.__err === 'utd' && mv.reason === 'context_mismatch', { err: mv && mv.__err, reason: mv && mv.reason });
    const bad = await E(pb, 'decrypt', [{ convId: CONV, envelopeJson: '{"e2e":5,"c":{"algorithm":"m.megolm.v1.aes-sha2","ciphertext":"AAAA","session_id":"x","sender_key":"y","device_id":"z"}}', senderUid: '1', serverMid: '9000003', cmid: '', tsMs: Date.now() }]);
    step('T3 envelope lixo → utd (não quebra o worker)', bad && bad.__err === 'utd', { err: bad && bad.__err, reason: bad && bad.reason });

    // ---------- T4: recarregar a página mantém sessões ----------
    R.urlBeforeReload = pb.url().replace(BASE, '');
    await pb.goto(BASE + '/e2ee5-qa', { waitUntil: 'load', timeout: 60000 }); // recarrega a página (rota pode ter redirecionado)
    await pb.waitForFunction(() => !!window.__e2ee5, null, { timeout: 60000 });
    await auth(pb, 2);
    const op2 = await E(pb, 'open', ['2', { prefix: 'X' }]);
    const decR = await E(pb, 'decrypt', [{ convId: CONV, envelopeJson: env, senderUid: '1', serverMid: '9000001', cmid, tsMs: Date.now() }]);
    step('T4 reload: mesmo aparelho e decifra de novo sem rede nova', op2 && op2.created === false && op2.deviceId === sb.op.deviceId && decR && decR.payloadJson && JSON.parse(decR.payloadJson).body === SECRET, { created: op2 && op2.created, sameDevice: op2 && op2.deviceId === sb.op.deviceId, err: decR && decR.__err });

    // ---------- T5: duas abas do mesmo usuário (mesmo IndexedDB) ----------
    const pb2 = await qaPage(B.ctx);
    await auth(pb2, 2);
    const op3 = await E(pb2, 'open', ['2', { prefix: 'X' }]);
    step('T5 2ª aba abre o MESMO aparelho', op3 && op3.deviceId === sb.op.deviceId && op3.created === false, { created: op3 && op3.created });
    // novas mensagens de A, decifradas em paralelo pelas duas abas, com syncs concorrentes
    const msgs = [];
    for (let i = 0; i < 4; i++) {
      const c = 'cm-wp04-tab-' + i + '-' + Date.now();
      const e = await E(pa, 'encrypt', [CONV, ['2'], { v: 1, t: 'text', conv: CONV, cmid: c, body: 'aba ' + i }]);
      msgs.push({ c, env: e.envelopeJson, i });
    }
    // sonda de lock: durante um sync da aba 1, a aba 2 vê o lock exclusivo
    const lockProbe = pb2.evaluate(async () => {
      const seen = [];
      for (let k = 0; k < 40; k++) {
        const q = await navigator.locks.query();
        const h = (q.held || []).filter((l) => /chatyy-e2ee5-core-2/.test(l.name)).length;
        const pd = (q.pending || []).filter((l) => /chatyy-e2ee5-core-2/.test(l.name)).length;
        seen.push(h + ':' + pd);
        await new Promise((r) => setTimeout(r, 25));
      }
      return seen;
    });
    const par = await Promise.all([
      E(pb, 'sync'), E(pb2, 'sync'), E(pb, 'sync'), E(pb2, 'sync'),
      ...msgs.map((m, k) => E(k % 2 ? pb : pb2, 'decrypt', [{ convId: CONV, envelopeJson: m.env, senderUid: '1', serverMid: String(9100000 + m.i), cmid: m.c, tsMs: Date.now() }])),
    ]);
    const seen = await lockProbe;
    const maxHeld = Math.max(...seen.map((s) => +s.split(':')[0]));
    const anyPending = seen.some((s) => +s.split(':')[1] > 0);
    step('T5 Web Lock exclusivo entre abas (nunca 2 donos ao mesmo tempo)', maxHeld === 1, { maxHeld, anyPending, samples: seen.length });
    const parErrs = par.filter((x) => x && x.__err).map((x) => x.__err + ':' + (x.reason || ''));
    // decifragens que falharam por chave ainda não sincronizada: re-tenta após sync
    const okMsgs = [];
    for (const m of msgs) {
      let d = null;
      for (let k = 0; k < 4; k++) {
        const pg = m.i % 2 ? pb2 : pb;
        d = await E(pg, 'decrypt', [{ convId: CONV, envelopeJson: m.env, senderUid: '1', serverMid: String(9100000 + m.i), cmid: m.c, tsMs: Date.now() }]);
        if (d && !d.__err) break;
        await E(pg, 'sync');
      }
      okMsgs.push(d && d.payloadJson && JSON.parse(d.payloadJson).body === 'aba ' + m.i);
    }
    const storeErrs = parErrs.filter((e) => /^(store|lock_busy|internal|wasm_trap)/.test(e));
    step('T5 duas abas: sem corrupção (todas decifram nas duas abas, sem erro de store)', okMsgs.every(Boolean) && storeErrs.length === 0, { okMsgs, parErrs });
    // depois da concorrência, a aba 1 ainda decifra a msg original (store íntegro)
    const decAfter = await E(pb, 'decrypt', [{ convId: CONV, envelopeJson: env, senderUid: '1', serverMid: '9000001', cmid, tsMs: Date.now() }]);
    step('T5 store íntegro após concorrência', decAfter && decAfter.payloadJson && JSON.parse(decAfter.payloadJson).body === SECRET, { err: decAfter && decAfter.__err });
    const mB = await E(pb, 'metricsSnapshot');
    R.metricsB = mB;

    // ---------- T7: mídia ----------
    const media = await pa.evaluate(async () => {
      const m = window.__e2ee5;
      const plain = new Uint8Array(300 * 1024);
      crypto.getRandomValues(plain.subarray(0, 65536));
      const t = performance.now();
      const enc = await m.encryptBytes(plain);
      const back = await m.decryptBytes(enc.data, enc.infoJson);
      const same = back.length === plain.length && back.every((b, i) => b === plain[i]);
      const tam = new Uint8Array(enc.data);
      tam[100] ^= 1;
      let tamper = 'not_rejected';
      try { await m.decryptBytes(tam, enc.infoJson); } catch (e) { tamper = e.code; }
      return { same, tamper, ms: Math.round(performance.now() - t), ctBytes: enc.data.length };
    });
    step('T7 mídia 300 KB ida e volta + adulteração rejeitada', media.same && media.tamper === 'media', media);

    // ---------- T6: "limpar dados" = aparelho novo ----------
    const oldB = sb.op.deviceId;
    R.cleanup = R.cleanup || [];
    await pb2.close();
    R.cleanup.push({ uid: '2', device: 'B1', status: await deleteDevice(A.ctx.request, 2, oldB) });
    created.splice(created.findIndex((d) => d.deviceId === oldB), 1);
    const w = await E(pb, 'wipe', ['2']);
    const op4 = await E(pb, 'open', ['2', { prefix: 'X' }]);
    if (op4 && op4.deviceId) created.push({ uid: '2', deviceId: op4.deviceId });
    const dbs = await pb.evaluate(async () => (indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : []));
    step('T6 wipe → open = aparelho NOVO (device_id diferente)', w && !w.__err && op4 && op4.created === true && op4.deviceId !== oldB, { deleted: w && w.deleted, created: op4 && op4.created, differs: op4 && op4.deviceId !== oldB, dbs });
    // o aparelho novo NÃO tem a sessão antiga: a mensagem antiga dá UTD (sem chave), não texto
    const decOld = await E(pb, 'decrypt', [{ convId: CONV, envelopeJson: env, senderUid: '1', serverMid: '9000001', cmid, tsMs: Date.now() }]);
    step('T6 aparelho novo não lê o passado sem chave (utd)', decOld && decOld.__err === 'utd', { err: decOld && decOld.__err, reason: decOld && decOld.reason });

    R.statsA = A.stats;
    R.statsB = B.stats;
    await A.ctx.close();
    await B.ctx.close();
  } catch (e) {
    step('EXCEPTION', false, { msg: String(e && e.message).slice(0, 300) });
  } finally {
    // limpeza: revoga os aparelhos X criados nas contas QA
    try {
      const ctx = await browser.newContext();
      R.cleanup = R.cleanup || [];
      for (const d of created) R.cleanup.push({ uid: d.uid, status: await deleteDevice(ctx.request, d.uid, d.deviceId) });
      await ctx.close();
    } catch (e) {
      R.cleanupErr = String(e && e.message).slice(0, 200);
    }
    await browser.close();
    R.finished = new Date().toISOString();
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 2));
    console.log(R.ok ? 'RESULT: ALL OK' : 'RESULT: FAILURES');
    process.exit(R.ok ? 0 : 1);
  }
})();
