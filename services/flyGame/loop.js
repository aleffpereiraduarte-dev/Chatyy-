// services/flyGame/loop.js — [voar 2026-10-22] laço da partida do "Brisa" (app e prévia HTML usam o MESMO).
// Passo fixo de 1/120 s com acumulador (quadro lento = mais passos, nunca física diferente); o toque vale no
// PRÓXIMO tick e respeita o intervalo mínimo do motor (toque cedo demais fica guardado até poder).
// Saída para o servidor: ticks (lista de ticks com toque) — o servidor re-joga com a mesma seed.
const E = require('./engine');
const R = require('./renderer');

const DT = 1 / E.HZ;

function createRunner(opts) {
  const o = opts || {};
  const me = {
    phase: 'ready', seed: (o.seed >>> 0) || 1, st: null, ticks: [], acc: 0, lastTap: -1e9, pending: false,
    paused: false, fx: R.createFx(), startedAt: 0, endedAt: 0, timeMs: 0,
    reduceMotion: !!o.reduceMotion,
  };
  const emit = (name, a) => { try { o[name] && o[name](a, me); } catch (e) { /* nunca derruba o laço */ } };
  me.tap = function tap() {
    if (me.phase === 'dead') return false;
    if (me.paused) { me.paused = false; me.acc = 0; }
    if (me.phase === 'ready') {
      me.st = E.createState(me.seed); me.phase = 'play'; me.startedAt = Date.now(); me.acc = DT; // 1º passo já no próximo quadro
      emit('onStart');
    }
    me.pending = true;
    return true;
  };
  me.pause = function pause() { if (me.phase === 'play') me.paused = true; };
  /** Avança dtSec de relógio (chamado a cada quadro). Devolve true se algo mudou. */
  me.frame = function frame(dtSec) {
    const dt = Math.max(0, Math.min(0.25, Number(dtSec) || 0));
    me.timeMs += dt * 1000;
    R.fxUpdate(me.fx, dt);
    if (me.phase !== 'play' || me.paused) return true;
    me.acc += dt;
    let n = 0;
    while (me.acc >= DT && n < 30) {
      const st = me.st;
      const flap = me.pending && st.t - me.lastTap >= E.MIN_TAP_GAP;
      if (flap) { me.ticks.push(st.t); me.lastTap = st.t; me.pending = false; }
      const ev = E.step(st, flap);
      if (ev & 1) { R.fxEmit(me.fx, 'flap', st.dist / E.FP - 18, st.y / E.FP + 10, me.reduceMotion); emit('onFlap'); }
      if (ev & 2) { R.fxEmit(me.fx, 'score', st.dist / E.FP, st.y / E.FP, me.reduceMotion); emit('onScore', st.score); }
      if (ev & 4) {
        R.fxEmit(me.fx, 'death', st.dist / E.FP, st.y / E.FP, me.reduceMotion);
        me.phase = 'dead'; me.endedAt = Date.now();
        emit('onDeath', { score: st.score, ticks: me.ticks.slice(), durTicks: st.t, wallMs: me.endedAt - me.startedAt });
        break;
      }
      me.acc -= DT; n += 1;
    }
    if (n >= 30) me.acc = 0; // engasgo grande: descarta o atraso (a física segue igual, só fica "mais lenta")
    return true;
  };
  me.draw = function draw(P, view) { R.drawFrame(P, me.st, me.fx, view, { timeMs: me.timeMs, reduceMotion: me.reduceMotion, camDist: 0 }); };
  me.score = function score() { return me.st ? me.st.score : 0; };
  return me;
}

module.exports = { createRunner, DT };
