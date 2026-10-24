// [ka-adapt 2026-10-24] Simulação do KaCore contra NATs sintéticos.  node tests/ka/kaCore.test.cjs
const path = require('path');
const babel = require('@babel/core');
const src = babel.transformFileSync(path.join(__dirname, '../../services/keepaliveAdaptive.js'), {
  babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'],
}).code;
const m = { exports: {} };
new Function('module', 'exports', 'require', src)(m, m.exports, require);
const { KaCore, KA_LO, KA_HI, KA_START } = m.exports;
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('FALHOU:', msg); } else console.log('ok  ', msg); };

// Simula N ciclos ociosos: NAT mata mapeamento ocioso > natMs. Retorna {iv final, quedas, pings, traj}.
function sim(natMs, cycles, opts = {}) {
  let t = 0;
  const core = new KaCore({ now: () => t });
  const key = 'k';
  let drops = 0, pings = 0;
  const traj = [];
  for (let i = 0; i < cycles; i++) {
    const nat = typeof natMs === 'function' ? natMs(i) : natMs;
    const iv = core.interval(key, opts.cap);
    t += iv;
    pings++;
    if (iv <= nat) core.ok(key, iv, opts.cap);
    else { drops++; core.dead(key, iv, { fgMs: 1e12, netAgoMs: 1e12 }); t += 2000; }
    traj.push(Math.round(iv / 1000));
  }
  return { iv: core.interval(key, opts.cap), drops, pings, traj, e: core.get(key) };
}

for (const nat of [30000, 60000, 95000, 120000, 180000, 300000, 1e9]) {
  const r = sim(nat, 80);
  const want = Math.min(KA_HI, nat);
  console.log(`NAT ${nat >= 1e9 ? '∞' : nat / 1000 + 's'}: iv=${r.iv / 1000}s quedas=${r.drops} traj=${r.traj.slice(0, 18).join(',')}…`);
  ok(r.iv <= Math.max(KA_LO, nat), `NAT ${nat}: intervalo final ${r.iv} nunca acima do NAT`);
  ok(r.iv >= Math.min(want * 0.75, KA_HI * 0.75) || nat < KA_START, `NAT ${nat}: intervalo final ${r.iv} ≥ 75% do possível`);
  ok(r.drops <= 3, `NAT ${nat}: no máximo 3 quedas na descoberta (foram ${r.drops})`);
  // depois de travar: 200 ciclos sem queda
  const r2 = sim(nat, 300);
  ok(r2.drops === r.drops, `NAT ${nat}: zero quedas depois de travar (${r2.drops} vs ${r.drops})`);
}

// NAT de 20 s (abaixo do início 25 s): recua para LO e não cai mais
{
  const r = sim(21000, 60);
  ok(r.iv === KA_LO && r.drops <= 2, `NAT 21 s: recua p/ ${KA_LO} (iv=${r.iv}, quedas=${r.drops})`);
}
// teto do servidor (QUIC 45 s)
{
  const r = sim(1e9, 60, { cap: 45000 });
  ok(r.iv === 45000 && r.drops === 0, `teto 45 s respeitado (iv=${r.iv})`);
}
// NAT encolhe no meio (operadora mudou): recua e volta a ficar estável
{
  const r = sim((i) => (i < 60 ? 180000 : 60000), 200);
  ok(r.iv <= 60000 && r.drops <= 5, `NAT 180→60 s: iv=${r.iv} quedas=${r.drops}`);
}
// prova inválida: queda com tráfego recente (idle < 80% do candidato) não conta
{
  let t = 0; const c = new KaCore({ now: () => t });
  c.interval('x'); c.ok('x', 25000); c.ok('x', 25000);
  const before = c.interval('x');
  ok(c.dead('x', 5000, { fgMs: 1e9, netAgoMs: 1e9 }) === null && c.interval('x') === before, 'queda com idle curto ignorada');
  ok(c.dead('x', before, { fgMs: 1000, netAgoMs: 1e9 }) === null, 'queda que passou pelo 2º plano ignorada');
  ok(c.dead('x', before, { fgMs: 1e9, netAgoMs: 1000 }) === null, 'queda logo após troca de rede ignorada');
}
// reabre a busca depois de 3 dias travado
{
  let t = 0; const c = new KaCore({ now: () => t });
  for (let i = 0; i < 40; i++) { const iv = c.interval('r'); t += iv; if (iv <= 100000) c.ok('r', iv); else c.dead('r', iv, { fgMs: 1e12, netAgoMs: 1e12 }); }
  const e = c.get('r'); const locked = e.lock;
  t += 4 * 24 * 3600 * 1000;
  c.interval('r');
  ok(locked === 1 && c.get('r').lock === 0, 'trava e reabre após 3 dias');
}
// economia: pings em 1 h ociosa vs fixo 20 s, NAT 120 s
{
  const r = sim(120000, 400);
  const tail = r.traj.slice(-30); const avg = tail.reduce((a, b) => a + b, 0) / tail.length;
  console.log(`NAT 120 s: intervalo estável ~${avg.toFixed(0)} s → ${(3600 / avg).toFixed(0)} pings/h vs ${3600 / 20} com 20 s fixo`);
}
console.log(fails ? `\n${fails} FALHA(S)` : '\nTUDO OK');
process.exit(fails ? 1 : 0);
