// scripts/fly/gen-equiv.js — [voar 2026-10-22] gera N partidas aleatórias (bots + toques aleatórios + inválidas)
// com o resultado do motor JS; o equiv.php re-joga cada uma no motor PHP e compara campo a campo.
const E = require('../../services/flyGame/engine');
const { play, playGood } = require('./bot');
const N = Number(process.argv[2] || 1000);
const r = { s: Number(process.argv[3] || 20261022) >>> 0 };
const rnd = () => { r.s ^= r.s << 13; r.s >>>= 0; r.s ^= r.s >>> 17; r.s ^= r.s << 5; r.s >>>= 0; return r.s; };
const out = [];
for (let i = 0; i < N; i++) {
  const seed = rnd();
  const kind = i % 10;
  let ticks;
  if (kind <= 4) ticks = play(seed, 0.5 + (rnd() % 500) / 1000, rnd()).ticks;
  else if (kind <= 6) ticks = playGood(seed, 5 + (rnd() % (i % 50 === 5 ? 400 : 80)), rnd()).ticks;
  else if (kind === 7) { ticks = [0]; let t = 0; const n = rnd() % 60; for (let k = 0; k < n; k++) { t += E.MIN_TAP_GAP + (rnd() % 40); ticks.push(t); } }
  else if (kind === 8) { ticks = play(seed, 0.9, rnd()).ticks.slice(); ticks.push(ticks[ticks.length - 1] + 400 + (rnd() % 300)); } // toque depois da morte
  else { ticks = play(seed, 0.8, rnd()).ticks.slice(); const m = rnd() % 4; if (m === 0) ticks[0] = 1; else if (m === 1 && ticks.length > 2) ticks[2] = ticks[1] + 1; else if (m === 2) ticks.splice(1, 0, 0); else ticks = []; }
  const res = E.simulate(seed, ticks);
  out.push({ seed, d: E.encodeTicks(ticks), score: res.score, ok: res.ok, err: res.err, ticks: res.ticks, flaps: res.flaps == null ? null : res.flaps });
}
process.stdout.write(JSON.stringify(out));
