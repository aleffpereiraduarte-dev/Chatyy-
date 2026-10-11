// [2026-10-11 ligacao-melhorias] Teste real de ligação 1:1 apitest -> qa2 (contas QA).
// Roda no edge BR via `chatyy-qa-remote run call_e2e.js --files bearers.json -- <plano>`
// (cópia original em /root/ligacao-melhorias/testes) e no CI:
// .github/workflows/e2e-call-tests.yml (runner ubuntu do GitHub, só workflow_dispatch +
// agenda diária; bearers.json gerado por mint-ci.sh a partir de secrets).
// Env opcionais: PW_MODULE (caminho do playwright), BEARERS (caminho do bearers.json).
// Sinalização = hub Go real (wss://ws.chatyy.com.br/ws: call_invite / call_accepted / call_end),
// mídia = LiveKit real (sala call_<ts>_qa...), Chromium com mic/câmera falsos.
// Callee roda num network namespace próprio (slirp4netns = NAT de usuário) p/ simular
// queda de rede de verdade (ip link down) sem tocar no firewall do servidor.
// Nunca imprime bearer/senha.
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const PW_MODULE = process.env.PW_MODULE
  || (fs.existsSync('/opt/chatyy-qa/pw/node_modules/playwright') ? '/opt/chatyy-qa/pw/node_modules/playwright' : 'playwright');
const { chromium } = require(PW_MODULE);

const B = JSON.parse(fs.readFileSync(process.env.BEARERS || path.join(__dirname, 'bearers.json'), 'utf8'));
const CONV = B.conv || 971;
const API = 'https://chatyy.com.br/api/email.php?action=chat_livekit_token';
const HUB = process.env.HUB || 'wss://ws.chatyy.com.br/ws';
const LK_UMD = 'https://cdn.jsdelivr.net/npm/livekit-client@2.19.0/dist/livekit-client.umd.js';
const OUT = process.env.QA_OUT || '.';
const PLAN = (process.argv[2] || 'all').split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

// ───────── netns p/ o callee ─────────
const NS = 'qacall';
let slirp = null;
function sh(c) { return execSync(c, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim(); }
function nsUp() {
  try { sh(`ip netns del ${NS}`); } catch {}
  sh(`ip netns add ${NS}`);
  fs.mkdirSync(`/etc/netns/${NS}`, { recursive: true });
  fs.writeFileSync(`/etc/netns/${NS}/resolv.conf`, 'nameserver 10.0.2.3\n');
  slirp = spawn('slirp4netns', ['--configure', '--mtu=1500', '--disable-host-loopback', '--netns-type=path', `/var/run/netns/${NS}`, 'tap0'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if (sh(`ip netns exec ${NS} ip -4 route`).includes('default')) break; } catch {}
    execSync('sleep 0.1');
  }
  sh(`ip netns exec ${NS} ip link set lo up`);
  const exe = chromium.executablePath();
  const wrap = path.join(__dirname, 'chrome-ns.sh');
  fs.writeFileSync(wrap, `#!/bin/sh\nexec ip netns exec ${NS} "${exe}" "$@"\n`, { mode: 0o755 });
  return wrap;
}
function nsDown() {
  try { slirp && slirp.kill(); } catch {}
  try { sh(`ip netns del ${NS}`); } catch {}
  try { fs.rmSync(`/etc/netns/${NS}`, { recursive: true, force: true }); } catch {}
}
function cut() { sh(`ip netns exec ${NS} ip link set tap0 down`); }
function restore() {
  sh(`ip netns exec ${NS} ip link set tap0 up`);
  try { sh(`ip netns exec ${NS} ip route add default via 10.0.2.2 dev tap0`); } catch {}
}

// ───────── hub (sinalização) ─────────
class Hub {
  constructor(name, token) { this.name = name; this.token = token; this.ev = []; this.waiters = []; }
  open() {
    return new Promise((res, rej) => {
      const ws = new WebSocket(HUB);
      this.ws = ws;
      const to = setTimeout(() => rej(new Error(this.name + ' hub auth timeout')), 10000);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: this.token, instance_id: 'qa-calltest-' + this.name + '-' + now(), client: 'qa', platform: 'web' }));
      ws.onmessage = (m) => {
        let d; try { d = JSON.parse(m.data); } catch { return; }
        const t = d.type || d.event;
        if (t === 'auth_success') { clearTimeout(to); res(); }
        this.ev.push({ t, at: now(), d });
        this.waiters = this.waiters.filter((w) => { if (w.f(t, d)) { w.r({ at: now(), d }); return false; } return true; });
      };
      ws.onerror = () => {};
      this._ping = setInterval(() => { try { ws.send(JSON.stringify({ type: 'ping' })); } catch {} }, 20000);
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  wait(f, ms = 15000) {
    const hit = this.ev.find((e) => f(e.t, e.d));
    if (hit) return Promise.resolve({ at: hit.at, d: hit.d });
    return new Promise((res) => { const w = { f, r: res }; this.waiters.push(w); setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); res(null); }, ms); });
  }
  close() { clearInterval(this._ping); try { this.ws.close(); } catch {} }
}

async function mint(bearer, room, dev) {
  const t0 = now();
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer }, body: JSON.stringify({ conversation_id: CONV, room, device_id: dev }) });
  const j = await r.json();
  if (!j.success) throw new Error('token fail ' + r.status + ' ' + (j.error || ''));
  return { ms: now() - t0, region: r.headers.get('x-chatyy-turn-region'), token: j.data.token, url: j.data.url, iceServers: j.data.iceServers };
}

// filtro de iceServers p/ testar UM servidor TURN por vez (relay-only)
function onlyTurn(ice, re) {
  const out = [];
  for (const s of ice || []) {
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => re.test(u));
    if (urls.length && s.credential) out.push({ ...s, urls });
  }
  return out;
}
function turnByIp(ice, ip, proto) { // coturn regional pelo IP (mesma credencial REST)
  const c = (ice || []).find((s) => s.credential);
  return c ? [{ username: c.username, credential: c.credential, urls: [`turn:${ip}:3478?transport=${proto}`] }] : [];
}

const PAGE_INIT = () => {
  window.__pcs = [];
  const Orig = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...a) { const pc = new Orig(...a); window.__pcs.push(pc); return pc; };
  window.RTCPeerConnection.prototype = Orig.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, Orig);
};

async function openPage(browser) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  await page.addInitScript(PAGE_INIT);
  await page.route('http://localhost/bench', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.goto('http://localhost/bench');
  await page.addScriptTag({ url: LK_UMD });
  return { ctx, page };
}

// entra na sala; registra eventos com timestamps epoch
async function join(page, tok, ice, policy, tune) {
  return page.evaluate(async ({ tok, ice, policy, tune }) => {
    const { Room, RoomEvent, DefaultReconnectPolicy } = window.LivekitClient;
    const ro = { adaptiveStream: true, dynacast: true, publishDefaults: { dtx: true, red: true } };
    if (tune && tune.retryDelays) ro.reconnectPolicy = new DefaultReconnectPolicy(tune.retryDelays);
    const room = new Room(ro);
    window.__room = room;
    const E = window.__E = [];
    const mark = (k, x) => E.push({ k, at: Date.now(), ...(x || {}) });
    room.on(RoomEvent.TrackSubscribed, (tr, pub, p) => { mark('trackSubscribed', { kind: tr.kind }); try { const el = tr.attach(); el.muted = true; document.body.appendChild(el); } catch {} });
    room.on(RoomEvent.Reconnecting, () => mark('reconnecting'));
    room.on(RoomEvent.Reconnected, () => mark('reconnected'));
    room.on(RoomEvent.SignalReconnecting, () => mark('signalReconnecting'));
    room.on(RoomEvent.Disconnected, (r) => mark('disconnected', { reason: String(r) }));
    room.on(RoomEvent.ParticipantConnected, (p) => mark('participantConnected'));
    room.on(RoomEvent.ParticipantDisconnected, (p) => mark('participantDisconnected'));
    room.on(RoomEvent.ConnectionStateChanged, (s) => mark('state', { s }));
    mark('joinStart');
    const rtcConfig = ice ? { iceServers: ice, iceTransportPolicy: policy || 'all' } : { iceTransportPolicy: policy || 'all' };
    try {
      await Promise.race([new Promise((_, rj) => setTimeout(() => rj(new Error('connect timeout 20s')), 20000)), room.connect(tok.url, tok.token, { rtcConfig, ...((tune && tune.connOpts) || {}) })]);
      mark('connected');
      await room.localParticipant.setMicrophoneEnabled(true);
      mark('micPublished');
      return { ok: true };
    } catch (e) { mark('joinError', { msg: String(e.message || e) }); return { ok: false, err: String(e.message || e) }; }
  }, { tok, ice, policy, tune });
}

async function stats(page) {
  return page.evaluate(async () => {
    const o = { at: Date.now(), inAudio: 0, inPk: 0, inLost: 0, jitter: null, conceal: 0, samples: 0, outAudio: 0, pair: null };
    for (const pc of window.__pcs || []) {
      if (pc.connectionState === 'closed') continue;
      let st; try { st = await pc.getStats(); } catch { continue; }
      const byId = {}; st.forEach((s) => { byId[s.id] = s; });
      st.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') { o.inAudio += s.bytesReceived || 0; o.inPk += s.packetsReceived || 0; o.inLost += s.packetsLost || 0; o.jitter = s.jitter; o.conceal += s.concealedSamples || 0; o.samples += s.totalSamplesReceived || 0; }
        if (s.type === 'outbound-rtp' && s.kind === 'audio') o.outAudio += s.bytesSent || 0;
        if (s.type === 'transport' && s.selectedCandidatePairId && byId[s.selectedCandidatePairId]) {
          const p = byId[s.selectedCandidatePairId]; const l = byId[p.localCandidateId] || {}; const r = byId[p.remoteCandidateId] || {};
          if (!o.pair || (p.bytesReceived || 0) > (o.pair.rx || 0)) o.pair = { local: l.candidateType, proto: l.protocol, relayProto: l.relayProtocol, relayUrl: l.url, remote: r.candidateType, rtt: p.currentRoundTripTime, rx: p.bytesReceived };
        }
      });
    }
    return o;
  });
}
const events = (page) => page.evaluate(() => window.__E || []);

// espera bytes de áudio de entrada crescerem
async function waitAudio(page, ms = 20000) {
  const t0 = now(); let base = null;
  while (now() - t0 < ms) {
    const s = await stats(page);
    if (base == null) base = s.inAudio;
    if (s.inAudio > 0 && s.inAudio > base) return { at: now(), s };
    await sleep(100);
  }
  return null;
}
function rate(a, b) {
  const dt = (b.at - a.at) / 1000; const pk = b.inPk - a.inPk; const lost = b.inLost - a.inLost;
  return { kbpsIn: Math.round((b.inAudio - a.inAudio) * 8 / dt / 1000), kbpsOut: Math.round((b.outAudio - a.outAudio) * 8 / dt / 1000), lossPct: +(100 * lost / Math.max(1, pk + lost)).toFixed(2), jitterMs: b.jitter != null ? +(b.jitter * 1000).toFixed(1) : null, concealPct: +(100 * (b.conceal - a.conceal) / Math.max(1, b.samples - a.samples)).toFixed(2), pair: b.pair };
}

// ───────── um cenário completo ─────────
async function scenario(bA, bB, name, opt = {}) {
  const callId = 'call_' + now() + '_qa' + Math.random().toString(36).slice(2, 8);
  const R = { name, callId };
  const hA = new Hub('A', B.a), hB = new Hub('B', B.b);
  await Promise.all([hA.open(), hB.open()]);
  const A = await openPage(bA), Bp = await openPage(bB);
  try {
    const [ta, tb] = await Promise.all([mint(B.a, callId, 'qa-ct-a'), mint(B.b, callId, 'qa-ct-b')]);
    R.tokenMs = { a: ta.ms, b: tb.ms }; R.turnRegion = { a: ta.region, b: tb.region };
    const iceA = opt.ice ? opt.ice(ta.iceServers) : ta.iceServers;
    const iceB = opt.ice ? opt.ice(tb.iceServers) : tb.iceServers;
    if (opt.ice && iceB && !iceB.length) throw new Error('filtro TURN vazio');
    // 1) convite + caller entra na sala em paralelo (igual app)
    const tInvite = now();
    hA.send({ type: 'call_invite', call_id: callId, target_email: B.eb, conversation_id: String(CONV), video: false });
    const joinA = join(A.page, ta, iceA, opt.policy, opt.tune);
    const ring = await hB.wait((t, d) => t === 'call_invite' && d.call_id === callId, 10000);
    R.inviteToRingMs = ring ? ring.at - tInvite : null;
    if (!ring) R.hubEvents = { A: hA.ev.map((e) => e.t).slice(-10), B: hB.ev.map((e) => e.t).slice(-10) };
    // 2) "usuário" atende após 1,5 s
    await sleep(1500);
    const tAnswer = now();
    hB.send({ type: 'call_accepted', call_id: callId, target_email: B.ea, conversation_id: String(CONV) });
    const joinB = join(Bp.page, tb, iceB, opt.policy, opt.tune);
    const acc = await hA.wait((t, d) => t === 'call_accepted' && d.call_id === callId, 10000);
    R.answerToCallerAcceptedMs = acc ? acc.at - tAnswer : null;
    R.join = { A: await joinA, B: await joinB };
    const [aA, aB] = await Promise.all([waitAudio(A.page), waitAudio(Bp.page)]);
    const eA = await events(A.page), eB = await events(Bp.page);
    const t = (E, k) => { const x = E.find((e) => e.k === k); return x ? x.at : null; };
    R.callee = { joinToConnectedMs: t(eB, 'connected') - t(eB, 'joinStart'), answerToAudioInMs: aB ? aB.at - tAnswer : null };
    R.caller = { joinToConnectedMs: t(eA, 'connected') - t(eA, 'joinStart'), answerToAudioInMs: aA ? aA.at - tAnswer : null };
    R.answerToMediaBothWaysMs = aA && aB ? Math.max(aA.at, aB.at) - tAnswer : null;
    R.audioBothWays = !!(aA && aB);
    // 3) regime: 6 s
    const s0 = await Promise.all([stats(A.page), stats(Bp.page)]);
    await sleep(opt.steadyMs || 6000);
    const s1 = await Promise.all([stats(A.page), stats(Bp.page)]);
    R.steady = { A: rate(s0[0], s1[0]), B: rate(s0[1], s1[1]) };
    // 4) queda de rede no callee
    if (opt.outages && opt.netns) {
      R.outages = [];
      for (const secs of opt.outages) {
        const before = await Promise.all([stats(A.page), stats(Bp.page)]);
        const nA = (await events(A.page)).length, nB = (await events(Bp.page)).length;
        const tCut = now(); cut(); log(name, 'corte', secs, 's');
        await sleep(secs * 1000);
        const tRest = now(); restore();
        // espera áudio voltar dos 2 lados (até 40 s)
        let backA = null, backB = null; const tw = now();
        let lastA = (await stats(A.page)).inAudio, lastB = (await stats(Bp.page)).inAudio;
        while (now() - tw < 40000 && (!backA || !backB)) {
          await sleep(200);
          const [x, y] = await Promise.all([stats(A.page), stats(Bp.page)]);
          if (!backA && x.inAudio > lastA) backA = now(); else lastA = x.inAudio;
          if (!backB && y.inAudio > lastB) backB = now(); else lastB = y.inAudio;
        }
        await sleep(1500);
        const evA = (await events(A.page)).slice(nA).map((e) => ({ k: e.k, s: e.s, reason: e.reason, tFromCut: e.at - tCut }));
        const evB = (await events(Bp.page)).slice(nB).map((e) => ({ k: e.k, s: e.s, reason: e.reason, tFromCut: e.at - tCut }));
        const o = { secs, audioBackCallerMsAfterRestore: backA ? backA - tRest : null, audioBackCalleeMsAfterRestore: backB ? backB - tRest : null, callerEvents: evA, calleeEvents: evB };
        R.outages.push(o); log(name, 'corte', secs, JSON.stringify({ a: o.audioBackCallerMsAfterRestore, b: o.audioBackCalleeMsAfterRestore }));
        await sleep(3000);
      }
    }
    R.pairA = s1[0].pair; R.pairB = s1[1].pair;
    // 5) desliga
    const tEnd = now();
    hA.send({ type: 'call_end', call_id: callId, target_email: B.eb, reason: 'hangup' });
    const endB = await hB.wait((t, d) => t === 'call_end' && d.call_id === callId, 8000);
    R.hangupToCalleeMs = endB ? endB.at - tEnd : null;
  } catch (e) {
    R.error = String(e.message || e);
    try { hA.send({ type: 'call_end', call_id: callId, target_email: B.eb, reason: 'hangup' }); } catch {}
  } finally {
    for (const p of [A.page, Bp.page]) { try { await p.evaluate(() => window.__room && window.__room.disconnect()); } catch {} }
    await A.ctx.close().catch(() => {}); await Bp.ctx.close().catch(() => {});
    hA.close(); hB.close();
  }
  return R;
}

(async () => {
  const args = ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
  const bA = await chromium.launch({ args });
  let wrap = null, bNs = null;
  const all = [];
  const runs = [];
  if (PLAN.includes('all') || PLAN.includes('basic')) { runs.push(['normal-1', {}]); runs.push(['normal-2', {}]); runs.push(['normal-3', {}]); }
  if (PLAN.includes('lk')) runs.push(['relay LK embutido (servidores do livekit.yaml, igual nativo)', { policy: 'relay', ice: () => null }]);
  if (PLAN.includes('all') || PLAN.includes('turn')) {
    runs.push(['relay turn.chatyy.com.br UDP (US coturn)', { policy: 'relay', ice: (i) => onlyTurn(i, /^turn:turn\.chatyy\.com\.br:3478\?transport=udp/) }]);
    runs.push(['relay turn.chatyy.com.br TCP (US coturn)', { policy: 'relay', ice: (i) => onlyTurn(i, /^turn:turn\.chatyy\.com\.br:3478\?transport=tcp/) }]);
    runs.push(['relay turns:turn-br:443 (TLS)', { policy: 'relay', ice: (i) => onlyTurn(i, /^turns:turn-br\./) }]);
    runs.push(['relay turns:turn-eu:443 (TLS)', { policy: 'relay', ice: (i) => onlyTurn(i, /^turns:turn-eu\./) }]);
    runs.push(['relay coturn BR 147.93.12.236 UDP (lista nativa)', { policy: 'relay', ice: (i) => turnByIp(i, '147.93.12.236', 'udp') }]);
    runs.push(['relay coturn EU 191.215.43.225 UDP (lista nativa)', { policy: 'relay', ice: (i) => turnByIp(i, '191.215.43.225', 'udp') }]);
    runs.push(['relay LK embutido (servidores do livekit.yaml, igual nativo)', { policy: 'relay', ice: () => null }]);
  }
  if (PLAN.includes('all') || PLAN.includes('outage')) {
    try { wrap = nsUp(); bNs = await chromium.launch({ args, executablePath: wrap }); } catch (e) { log('netns falhou', e.message); }
    if (bNs) runs.push(['callee atrás de NAT (netns) + quedas 3s/10s/25s', { netns: true, outages: [3, 10, 25] }]);
  }
  if (PLAN.includes('tune')) {
    try { if (!bNs) { wrap = nsUp(); bNs = await chromium.launch({ args, executablePath: wrap }); } } catch (e) { log('netns falhou', e.message); }
    const T = { connOpts: { websocketTimeout: 6000, peerConnectionTimeout: 10000 }, retryDelays: [0, 300, 1200, 2000, 2500, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000] };
    runs.push(['BASE quedas 15s/25s', { netns: true, outages: [15, 25] }]);
    runs.push(['TUNED (ws 6s, pc 10s, retry<=3s) quedas 15s/25s', { netns: true, outages: [15, 25], tune: T }]);
    runs.push(['BASE#2 quedas 15s/25s', { netns: true, outages: [15, 25] }]);
    runs.push(['TUNED#2 quedas 15s/25s', { netns: true, outages: [15, 25], tune: T }]);
  }
  for (const [name, opt] of runs) {
    log('>>>', name);
    const r = await scenario(bA, opt.netns ? bNs : bA, name, opt);
    all.push(r);
    console.log('### ' + name + '\n' + JSON.stringify(r));
    fs.writeFileSync(path.join(OUT, 'call_e2e.json'), JSON.stringify(all, null, 1));
    await sleep(2500);
  }
  await bA.close(); if (bNs) await bNs.close();
  nsDown();
})().catch((e) => { console.error('ERR', e.stack || e.message); nsDown(); process.exit(1); });
