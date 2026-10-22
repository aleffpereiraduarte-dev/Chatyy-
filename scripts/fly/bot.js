// scripts/fly/bot.js — [voar 2026-10-22] gerador de partidas para testes (node): bot "humano" com ruído + seeds aleatórias.
// uso: node scripts/fly/bot.js N [skill 0..1] > partidas.json   (cada linha = {seed, ticks, score, dur})
const E = require('../../services/flyGame/engine');
function rand32(r) { r.s ^= r.s << 13; r.s >>>= 0; r.s ^= r.s >>> 17; r.s ^= r.s << 5; r.s >>>= 0; return r.s; }
function play(seed, skill, noiseSeed) {
  const r = { s: (noiseSeed >>> 0) || 7 };
  const st = E.createState(seed);
  const ticks = [];
  let last = -999; let react = 0;
  // 1º toque no tick 0 (começa a partida)
  while (st.alive && st.t < E.MAX_TICKS) {
    let flap = false;
    if (st.t === 0) flap = true;
    else if (st.t - last >= E.MIN_TAP_GAP) {
      // alvo = vão da próxima coluna à frente
      let p = null; for (const q of st.pipes) { if (q.x + E.PW * E.FP >= st.dist - E.R_HIT * E.FP) { p = q; break; } }
      const target = p ? Math.floor((p.top + p.bot) / 2) + Math.floor((p.bot - p.top) / 6) : 450 * E.FP;
      const err = Math.floor(((rand32(r) % 1000) - 500) * (1 - skill) * 260);
      if (react > 0) react--;
      else if (st.y + Math.floor(st.vy * 8) > target + err && st.vy > -2000) { flap = true; react = (rand32(r) % 6); }
    }
    if (flap) { ticks.push(st.t); last = st.t; }
    E.step(st, flap);
  }
  return { seed, ticks, score: st.score, dur: st.t };
}
module.exports = { play };
if (require.main === module) {
  const n = Number(process.argv[2] || 10); const skill = Number(process.argv[3] || 0.8);
  const r = { s: 12345 };
  const out = [];
  for (let i = 0; i < n; i++) {
    const sk = process.argv[3] ? skill : 0.55 + (rand32(r) % 450) / 1000;
    out.push(play(rand32(r), sk, rand32(r)));
  }
  process.stdout.write(JSON.stringify(out));
}

// bot "bom" por busca: em cada tick de decisão testa tocar/não tocar e olha 70 ticks à frente com a política simples.
function clone(st) { return { ...st, pipes: st.pipes.map((p) => ({ ...p })) }; }
function rollout(st, depth, k, off) {
  const s = clone(st); let last = -999;
  for (let i = 0; i < depth && s.alive; i++) {
    let p = null; for (const q of s.pipes) { if (q.x + E.PW * E.FP >= s.dist - E.R_HIT * E.FP) { p = q; break; } }
    const target = p ? Math.floor((p.top + p.bot) / 2) + Math.floor(((p.bot - p.top) * off) / 100) : 450 * E.FP;
    const f = i - last >= E.MIN_TAP_GAP && s.y + s.vy * k > target;
    if (f) last = i;
    E.step(s, f);
  }
  return s.alive;
}
function survives(st, depth) {
  for (const k of [6, 10, 3, 14, 0]) for (const off of [12, 0, 25]) if (rollout(st, depth, k, off)) return true;
  return false;
}
function playGood(seed, maxScore, noiseSeed) {
  const r = { s: (noiseSeed >>> 0) || 9 };
  const st = E.createState(seed); const ticks = []; let last = -999;
  while (st.alive && st.t < E.MAX_TICKS) {
    let flap = st.t === 0;
    if (!flap && st.t - last >= E.MIN_TAP_GAP && st.score < maxScore) {
      const a = clone(st); E.step(a, true); const b = clone(st); E.step(b, false);
      const sa = a.alive && survives(a, 110); const sb = b.alive && survives(b, 110);
      flap = sa && !sb ? true : (!sa && sb ? false : (sa && sb ? (rand32(r) % 100) < 4 && st.y > 300 * E.FP : false));
    }
    if (flap) { ticks.push(st.t); last = st.t; }
    E.step(st, flap);
  }
  return { seed, ticks, score: st.score, dur: st.t };
}
module.exports.playGood = playGood;
