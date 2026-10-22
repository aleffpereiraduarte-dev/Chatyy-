/* eslint-disable no-bitwise */
// services/flyGame/engine.js — [voar 2026-10-22] motor DETERMINÍSTICO do "Brisa" (jogo de voar com um toque).
//
// Mesmo motor portado 1:1 para PHP em api/games_engine_fly.php (fly_engine_*). Regras do porte:
//   • só INTEIROS (unidades × 1000 = "mu"), sem float, sem Math.sin/sqrt/pow — dá o mesmo bit a bit em JS e PHP;
//   • divisões só por constantes pequenas com Math.floor (= intdiv para positivos);
//   • RNG xorshift32 com seed (uint32); a ordem das chamadas ao RNG é parte do contrato;
//   • passo fixo 1/120 s; entradas = lista de ticks em que houve toque (estritamente crescente, 1º = 0).
// Mudou QUALQUER regra/constante → suba FLY_VER aqui E no PHP (o servidor só aceita versões conhecidas)
// e rode o teste de equivalência (scripts/fly-equiv: 1000 partidas node × PHP).
//
// Mundo: altura 1000 u, chão em y=880 u; o jogador fica em x = dist (a câmera segue). Obstáculos = pares de
// colunas com um vão; pontua ao passar o centro da coluna. Dificuldade: velocidade sobe com a pontuação,
// vão estreita e o deslocamento entre vãos cresce com o índice da coluna (começa justo, acelera).
// CommonJS de propósito: o mesmo arquivo roda no app (Metro), no node (testes) e na prévia HTML.

const FLY_VER = 1;
const HZ = 120;            // ticks por segundo (passo fixo)
const FP = 1000;           // mu por unidade
const H = 1000;            // altura do mundo (u)
const GROUND = 880;        // topo do chão (u)
const R_HIT = 22;          // raio de colisão (u) — o desenho tem ~26 (perdoa raspão)
const PW = 96;             // largura da coluna (u)
const GRAV = 180;          // mu/tick²
const FLAP = -6400;        // mu/tick (velocidade vertical ao tocar)
const VMAX = 9300;         // queda máxima mu/tick
const SPEED0 = 1700;       // mu/tick (204 u/s)
const SPEED_STEP = 14;     // +mu/tick por ponto
const SPEED_ADD_MAX = 1050; // teto (330 u/s a partir de 75 pontos)
const GAP0 = 320;          // vão inicial (u)
const GAP_MIN = 215;       // vão mínimo (u, a partir da coluna 105)
const SPACE0 = 300;        // distância entre colunas (u) + rng%41
const FIRST_X = 620;       // 1ª coluna (u)
const MARGIN = 80;         // margem do vão até o teto/chão (u)
const AHEAD = 1500;        // gera colunas até dist+AHEAD (u)
const BEHIND = 700;        // descarta colunas que ficaram AHEAD atrás (u)
const MIN_TAP_GAP = 6;     // ticks mínimos entre toques (20 toques/s)
const MAX_TICKS = 144000;  // 20 min
const MAX_TAPS = 12000;

function rngNext(st) {
  let x = st.s;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5; x >>>= 0;
  st.s = x;
  return x;
}

function gapFor(k) { return Math.max(GAP_MIN, GAP0 - k); }
function driftFor(k) { return 150 + Math.min(k * 2, 100); }

function spawn(st) {
  const k = st.k;
  const gap = gapFor(k);
  const lo = MARGIN + Math.floor(gap / 2);
  const hi = GROUND - MARGIN - Math.floor(gap / 2);
  let c;
  if (k === 0) {
    c = Math.floor((lo + hi) / 2) + (rngNext(st) % 61) - 30;
  } else {
    const d = driftFor(k);
    c = st.lastC + (rngNext(st) % (2 * d + 1)) - d;
  }
  if (c < lo) c = lo;
  if (c > hi) c = hi;
  st.lastC = c;
  st.pipes.push({ k, x: st.nextX, top: (c - Math.floor(gap / 2)) * FP, bot: (c + gap - Math.floor(gap / 2)) * FP, passed: false });
  st.k = k + 1;
  st.nextX += (SPACE0 + (rngNext(st) % 41)) * FP;
}

/** Estado novo para a seed (uint32). */
function createState(seed) {
  let s = ((Number(seed) >>> 0) ^ 0x9E3779B9) >>> 0;
  if (s === 0) s = 1;
  const st = { v: FLY_VER, s, t: 0, y: 420 * FP, vy: 0, dist: 0, score: 0, alive: true, pipes: [], k: 0, nextX: FIRST_X * FP, lastC: 0, flaps: 0 };
  for (let i = 0; i < 8; i++) rngNext(st);
  while (st.nextX < st.dist + AHEAD * FP) spawn(st);
  return st;
}

function speedOf(st) { return SPEED0 + Math.min(st.score * SPEED_STEP, SPEED_ADD_MAX); }

function hitRect(px, py, x0, y0, x1, y1) {
  const r = R_HIT * FP;
  const cx = px < x0 ? x0 : (px > x1 ? x1 : px);
  const cy = py < y0 ? y0 : (py > y1 ? y1 : py);
  const dx = px - cx; const dy = py - cy;
  // dx,dy ≤ ~1e5 aqui (só colunas perto) → quadrados < 2^53
  return dx * dx + dy * dy < r * r;
}

/**
 * Um passo de 1/120 s. flap=true = toque neste tick. Devolve bitmask: 1 = bateu asa, 2 = pontuou, 4 = morreu.
 */
function step(st, flap) {
  if (!st.alive) return 0;
  let ev = 0;
  if (flap) { st.vy = FLAP; st.flaps += 1; ev |= 1; }
  st.vy += GRAV;
  if (st.vy > VMAX) st.vy = VMAX;
  st.y += st.vy;
  if (st.y < R_HIT * FP) { st.y = R_HIT * FP; if (st.vy < 0) st.vy = 0; }
  st.dist += speedOf(st);
  while (st.nextX < st.dist + AHEAD * FP) spawn(st);
  while (st.pipes.length && st.pipes[0].x + PW * FP < st.dist - BEHIND * FP) st.pipes.shift();
  const px = st.dist; const py = st.y; const rr = R_HIT * FP;
  for (let i = 0; i < st.pipes.length; i++) {
    const p = st.pipes[i];
    if (p.x > px + rr) break; // ordenadas por x: o resto está à frente
    if (p.x + PW * FP < px - rr) continue;
    if (hitRect(px, py, p.x, 0, p.x + PW * FP, p.top) || hitRect(px, py, p.x, p.bot, p.x + PW * FP, GROUND * FP)) {
      st.alive = false; ev |= 4; break;
    }
  }
  if (st.alive) {
    for (let i = 0; i < st.pipes.length; i++) {
      const p = st.pipes[i];
      if (!p.passed && px >= p.x + Math.floor((PW * FP) / 2)) { p.passed = true; st.score += 1; ev |= 2; }
    }
    if (st.y + R_HIT * FP >= GROUND * FP) { st.y = (GROUND - R_HIT) * FP; st.alive = false; ev |= 4; }
  }
  st.t += 1;
  return ev;
}

/** Confere a forma da lista de toques (sem rodar). null = ok, senão código do erro. */
function checkTicks(ticks) {
  if (!Array.isArray(ticks) || !ticks.length) return 'no_ticks';
  if (ticks.length > MAX_TAPS) return 'too_many_taps';
  if (ticks[0] !== 0) return 'bad_first_tick';
  for (let i = 0; i < ticks.length; i++) {
    const v = ticks[i];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_TICKS) return 'bad_tick';
    if (i > 0 && v - ticks[i - 1] < MIN_TAP_GAP) return 'tap_too_fast';
  }
  return null;
}

/**
 * Re-joga a partida: seed + ticks → {ok, err, score, ticks (duração em ticks), flaps}.
 * Toque depois da morte = partida impossível (err 'ticks_after_death').
 */
function simulate(seed, ticks) {
  const bad = checkTicks(ticks);
  if (bad) return { ok: false, err: bad, score: 0, ticks: 0 };
  const st = createState(seed);
  let i = 0;
  while (st.alive && st.t < MAX_TICKS) {
    const flap = i < ticks.length && ticks[i] === st.t;
    if (flap) i += 1;
    step(st, flap);
  }
  if (st.alive) return { ok: false, err: 'too_long', score: st.score, ticks: st.t };
  if (i < ticks.length) return { ok: false, err: 'ticks_after_death', score: st.score, ticks: st.t };
  return { ok: true, err: null, score: st.score, ticks: st.t, flaps: st.flaps };
}

/** Delta-encode (envio compacto): [0, 14, 30, ...] → [0, 14, 16, ...]. */
function encodeTicks(ticks) { const o = []; let p = 0; for (let i = 0; i < ticks.length; i++) { o.push(ticks[i] - p); p = ticks[i]; } return o; }
function decodeTicks(d) { const o = []; let p = 0; for (let i = 0; i < d.length; i++) { p += d[i]; o.push(p); } return o; }

module.exports = {
  FLY_VER, HZ, FP, H, GROUND, R_HIT, PW, MIN_TAP_GAP, MAX_TICKS, MAX_TAPS, GAP0, GAP_MIN,
  createState, step, simulate, checkTicks, speedOf, gapFor, encodeTicks, decodeTicks, rngNext,
};
