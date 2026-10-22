// services/flyGame/renderer.js — [voar 2026-10-22] desenho do "Brisa" (arte vetorial própria do Chatyy).
// Mundo: céu grafite-azulado do entardecer, 3 camadas de parallax (montanhas longe, morros/torres perto,
// nuvens), colunas grafite com filete azul-claro, chão com faixas, partículas leves e a "Bolhinha"
// (balão de conversa com asa, olho e os 3 pontinhos de "digitando"). Sem bitmap, sem emoji.
//
// O desenho fala com um "pintor" mínimo (retângulo, retângulo arredondado, círculo, caminho SVG, gradiente
// vertical, save/restore/translate/rotate/scale) com DUAS implementações:
//   • canvas2dPainter(ctx)       — web (react-native-web) e a prévia preview-2026/voar.html;
//   • skiaPainter(Skia, canvas)  — app nativo (gravado num SkPicture por quadro; UI thread do Skia desenha).
// Cosmético apenas: partículas/ângulo/asa podem usar Math.random/tempo — a física é do engine.js.
/* eslint-disable no-param-reassign */
const E = require('./engine');

const PAL = {
  sky0: '#141A24', sky1: '#232C3B', sky2: '#3B4A60', sky3: '#5B6F88',
  glow: 'rgba(158,216,255,0.22)', moon: '#EAF4FF', moonHalo: 'rgba(214,236,255,0.10)',
  star: 'rgba(230,240,255,0.75)',
  far: '#2C3749', far2: '#334158', farTop: 'rgba(158,216,255,0.10)', mid: '#283242', midLight: 'rgba(158,216,255,0.55)',
  cloud: 'rgba(235,244,255,0.10)', cloud2: 'rgba(235,244,255,0.06)',
  pipe: '#262D38', pipeHi: '#343D4B', pipeEdge: '#8FD3FF', pipeCap: '#2E3644', pipeShade: 'rgba(0,0,0,0.22)',
  ground: '#1B212A', groundLip: 'rgba(143,211,255,0.45)', groundStripe: '#232A35',
  body: '#F3F7FB', bodyShade: '#D9E3EE', blush: 'rgba(143,211,255,0.55)', eye: '#161C26', wing: '#8FD3FF', wingDark: '#6BBDF0', dots: '#8FD3FF',
};

// ─── pintores ────────────────────────────────────────────────────────────────
function canvas2dPainter(ctx) {
  const paths = new Map();
  return {
    kind: 'canvas2d',
    makePath(d) { let p = paths.get(d); if (!p) { p = new Path2D(d); paths.set(d, p); } return p; },
    save() { ctx.save(); }, restore() { ctx.restore(); },
    translate(x, y) { ctx.translate(x, y); }, scale(s) { ctx.scale(s, s); }, rotate(deg) { ctx.rotate((deg * Math.PI) / 180); },
    rect(x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); },
    rrect(x, y, w, h, r, c) {
      ctx.fillStyle = c; ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else { ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
      ctx.fill();
    },
    circle(x, y, r, c) { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); },
    path(p, c) { ctx.fillStyle = c; ctx.fill(p); },
    vgrad(x, y, w, h, colors, stops) {
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      for (let i = 0; i < colors.length; i++) g.addColorStop(stops[i], colors[i]);
      ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    },
    rgrad(x, y, r, c0, c1) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, c0); g.addColorStop(1, c1);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    },
  };
}

function skiaPainter(Skia, TileMode, canvas, cache) {
  const C = cache || (cache = {});
  if (!C.colors) {
    C.colors = new Map(); C.paths = new Map(); C.grads = new Map();
    C.paint = Skia.Paint(); C.paint.setAntiAlias(true);
    C.gpaint = Skia.Paint(); C.gpaint.setAntiAlias(true); // só gradiente (a tinta sólida nunca recebe shader)
  }
  const col = (s) => { let c = C.colors.get(s); if (c === undefined) { c = Skia.Color(s); C.colors.set(s, c); } return c; };
  const paint = C.paint; const gpaint = C.gpaint;
  const solid = (s) => { paint.setColor(col(s)); return paint; };
  return {
    kind: 'skia',
    makePath(d) { let p = C.paths.get(d); if (!p) { p = Skia.Path.MakeFromSVGString(d); C.paths.set(d, p); } return p; },
    save() { canvas.save(); }, restore() { canvas.restore(); },
    translate(x, y) { canvas.translate(x, y); }, scale(s) { canvas.scale(s, s); }, rotate(deg) { canvas.rotate(deg, 0, 0); },
    rect(x, y, w, h, c) { canvas.drawRect(Skia.XYWHRect(x, y, w, h), solid(c)); },
    rrect(x, y, w, h, r, c) { canvas.drawRRect(Skia.RRectXY(Skia.XYWHRect(x, y, w, h), r, r), solid(c)); },
    circle(x, y, r, c) { canvas.drawCircle(x, y, r, solid(c)); },
    path(p, c) { if (p) canvas.drawPath(p, solid(c)); },
    vgrad(x, y, w, h, colors, stops) {
      const k = colors.join('|') + '@' + y + ':' + h;
      let sh = C.grads.get(k);
      if (!sh) { sh = Skia.Shader.MakeLinearGradient({ x: 0, y }, { x: 0, y: y + h }, colors.map(col), stops, TileMode.Clamp); C.grads.set(k, sh); }
      gpaint.setShader(sh); canvas.drawRect(Skia.XYWHRect(x, y, w, h), gpaint);
    },
    rgrad(x, y, r, c0, c1) {
      const k = 'r' + c0 + c1 + r;
      let sh = C.grads.get(k);
      if (!sh) { sh = Skia.Shader.MakeRadialGradient({ x: 0, y: 0 }, r, [col(c0), col(c1)], [0, 1], TileMode.Clamp); C.grads.set(k, sh); }
      canvas.save(); canvas.translate(x, y); gpaint.setShader(sh); canvas.drawCircle(0, 0, r, gpaint); canvas.restore();
    },
  };
}

// ─── arte (caminhos em unidades do mundo) ────────────────────────────────────
// montanhas longe: ladrilho de 1200 u; morros perto: ladrilho de 900 u (gerados uma vez, determinísticos)
function ridge(width, base, amp, seed, steps, sharp) {
  let s = seed >>> 0;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return (s % 1000) / 1000; };
  const pts = [];
  for (let i = 0; i <= steps; i++) pts.push([(width * i) / steps, base - amp * (0.35 + 0.65 * rnd())]);
  pts[steps][1] = pts[0][1]; // emenda do ladrilho
  let d = `M0 ${H_}` + ` L0 ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i <= steps; i++) {
    const [x0, y0] = pts[i - 1]; const [x1, y1] = pts[i];
    const mx = (x0 + x1) / 2;
    if (sharp) d += ` L${x1.toFixed(1)} ${y1.toFixed(1)}`;
    else d += ` Q${x0.toFixed(1)} ${y0.toFixed(1)} ${mx.toFixed(1)} ${((y0 + y1) / 2).toFixed(1)}`;
  }
  d += ` L${width} ${pts[steps][1].toFixed(1)} L${width} ${H_} Z`;
  return d;
}
const H_ = 1000;
const FAR_W = 1200; const MID_W = 900;
const FAR_D = ridge(FAR_W, 700, 330, 7, 14, true);
const FAR2_D = ridge(FAR_W, 740, 200, 41, 10, true);
const MID_D = ridge(MID_W, 760, 120, 29, 7);
// torres de antena no morro (detalhe do mundo Chatyy: sinal)
const MID_TOWERS = [[150, 690], [520, 705], [770, 680]];
const CLOUD_D = 'M0 30 C0 14 16 4 30 10 C38 -4 62 -6 72 8 C86 2 104 12 102 28 C114 30 116 46 100 48 L8 48 C-6 48 -8 32 0 30 Z';
// Bolhinha (centro 0,0; raio ~26): balão com rabicho para trás-baixo
const BODY_D = 'M0 -26 C14.4 -26 26 -14.4 26 0 C26 14.4 14.4 26 0 26 C-5 26 -9.6 24.6 -13.6 22.2 L-25 28 L-21 15.6 C-24.4 11.2 -26 5.8 -26 0 C-26 -14.4 -14.4 -26 0 -26 Z';
const BELLY_D = 'M-20 6 C-14 20 12 24 22 8 C18 20 8 26 0 26 C-8 26 -16 20 -20 6 Z';
const WING_D = 'M0 0 C-6 -16 -28 -18 -32 -6 C-34 2 -24 8 -12 7 C-6 6.5 -2 4 0 0 Z';
const STARS = (() => { const o = []; let s = 99; for (let i = 0; i < 26; i++) { s = (s * 1103515245 + 12345) % 2147483648; const x = s % 1600; s = (s * 1103515245 + 12345) % 2147483648; const y = 20 + (s % 380); o.push([x, y, 0.8 + (i % 3) * 0.5]); } return o; })();

// ─── partículas (só visual) ──────────────────────────────────────────────────
function createFx() { return { parts: [], shake: 0, wing: 0, ang: 0, flash: 0, dead: false, deathT: 0 }; }
function fxEmit(fx, kind, x, y, reduceMotion) {
  const n = reduceMotion ? 0 : (kind === 'flap' ? 5 : kind === 'score' ? 10 : 22);
  for (let i = 0; i < n; i++) {
    const a = kind === 'flap' ? (Math.PI * (0.65 + Math.random() * 0.5)) : Math.random() * Math.PI * 2;
    const sp = kind === 'flap' ? 60 + Math.random() * 70 : kind === 'score' ? 90 + Math.random() * 90 : 120 + Math.random() * 220;
    fx.parts.push({ k: kind, x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + (kind === 'flap' ? 40 : 0), life: kind === 'death' ? 0.9 : 0.55, t: 0, r: kind === 'flap' ? 4 + Math.random() * 4 : 2 + Math.random() * 3 });
  }
  if (kind === 'flap') fx.wing = 1;
  if (kind === 'death') { fx.dead = true; fx.deathT = 0; if (!reduceMotion) fx.shake = 1; }
  if (kind === 'score') fx.flash = 1;
  if (fx.parts.length > 160) fx.parts.splice(0, fx.parts.length - 160);
}
function fxUpdate(fx, dt) {
  for (let i = fx.parts.length - 1; i >= 0; i--) {
    const p = fx.parts[i]; p.t += dt;
    if (p.t >= p.life) { fx.parts.splice(i, 1); continue; }
    p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.96; p.vy = p.vy * 0.96 + (p.k === 'death' ? 300 : 20) * dt;
  }
  if (fx.dead) fx.deathT += dt;
  fx.wing = Math.max(0, fx.wing - dt * 5);
  fx.shake = Math.max(0, fx.shake - dt * 3);
  fx.flash = Math.max(0, fx.flash - dt * 3);
}

// ─── quadro ──────────────────────────────────────────────────────────────────
/**
 * Desenha um quadro. st = estado do engine (ou null p/ tela de espera), view = {w,h} em px,
 * opts = {timeMs, ready (bolhinha flutuando antes do 1º toque), reduceMotion, camDist (u)}.
 */
function drawFrame(P, st, fx, view, opts) {
  const o = opts || {};
  const scale = view.h / H_;
  const visW = view.w / scale;
  const t = (o.timeMs || 0) / 1000;
  const dist = st ? st.dist / E.FP : (o.camDist || 0);
  const camX = dist - visW * 0.3;
  const shake = fx && fx.shake > 0 ? fx.shake * 7 : 0;
  P.save();
  P.scale(scale);
  if (shake) P.translate(Math.sin(t * 90) * shake, Math.cos(t * 77) * shake * 0.6);
  // 1) céu
  P.vgrad(-20, -20, visW + 40, H_ + 40, [PAL.sky0, PAL.sky1, PAL.sky2, PAL.sky3], [0, 0.42, 0.78, 1]);
  P.rgrad(visW * 0.5, 820, visW * 0.9, PAL.glow, 'rgba(158,216,255,0)');
  // estrelas (parallax 0.02) + lua
  const sx = camX * 0.02;
  for (let i = 0; i < STARS.length; i++) {
    const s = STARS[i]; const x = ((s[0] - sx) % 1600 + 1600) % 1600;
    if (x > visW + 4) continue;
    const tw = o.reduceMotion ? 1 : 0.6 + 0.4 * Math.sin(t * 1.7 + i * 1.3);
    P.circle(x, s[1], s[2] * tw, PAL.star);
  }
  P.rgrad(visW * 0.78, 150, 120, PAL.moonHalo, 'rgba(214,236,255,0)');
  P.circle(visW * 0.78, 150, 34, PAL.moon);
  P.circle(visW * 0.78 + 12, 140, 30, 'rgba(35,44,59,0.92)'); // lua crescente
  // 2) montanhas longe (0.12)
  const far = P.makePath(FAR_D);
  const fx0 = -(((camX * 0.12) % FAR_W) + FAR_W) % FAR_W;
  for (let x = fx0; x < visW; x += FAR_W) { P.save(); P.translate(x, 0); P.path(far, PAL.far); P.restore(); }
  const far2 = P.makePath(FAR2_D);
  const f20 = -(((camX * 0.2) % FAR_W) + FAR_W) % FAR_W;
  for (let x = f20; x < visW; x += FAR_W) { P.save(); P.translate(x, 0); P.path(far2, PAL.far2); P.restore(); }
  // nuvens (0.25)
  const cloud = P.makePath(CLOUD_D);
  const cx0 = camX * 0.25;
  for (let i = 0; i < 6; i++) {
    const span = 1500; const bx = ((i * 270 + 60 - cx0) % span + span) % span - 140;
    if (bx > visW + 10) continue;
    const by = 230 + ((i * 97) % 220);
    const sc = 0.9 + (i % 3) * 0.35;
    P.save(); P.translate(bx, by); P.scale(sc); P.path(cloud, i % 2 ? PAL.cloud : PAL.cloud2); P.restore();
  }
  // 3) morros perto + torres de sinal (0.4)
  const mid = P.makePath(MID_D);
  const m0 = -(((camX * 0.4) % MID_W) + MID_W) % MID_W;
  for (let x = m0; x < visW; x += MID_W) {
    P.save(); P.translate(x, 0); P.path(mid, PAL.mid);
    for (let k = 0; k < MID_TOWERS.length; k++) {
      const [tx, ty] = MID_TOWERS[k];
      P.rect(tx - 2, ty - 70, 4, 74, PAL.mid);
      P.rect(tx - 9, ty - 52, 18, 3, PAL.mid);
      const blink = o.reduceMotion ? 0.8 : (Math.sin(t * 2.2 + k * 2) > 0.2 ? 1 : 0.35);
      P.circle(tx, ty - 72, 4, `rgba(143,211,255,${(0.55 * blink).toFixed(2)})`);
    }
    P.restore();
  }
  // 4) colunas
  if (st) {
    for (let i = 0; i < st.pipes.length; i++) {
      const p = st.pipes[i];
      const x = p.x / E.FP - camX;
      if (x > visW + 4 || x + E.PW < -4) continue;
      const top = p.top / E.FP; const bot = p.bot / E.FP;
      drawPillar(P, x, -30, top + 30, true);
      drawPillar(P, x, bot, E.GROUND - bot + 4, false);
    }
  }
  // 5) chão (1.0)
  P.rect(-20, E.GROUND, visW + 40, H_ - E.GROUND + 30, PAL.ground);
  const g0 = -((camX % 60) + 60) % 60;
  for (let x = g0 - 60; x < visW + 60; x += 60) P.rrect(x, E.GROUND + 22, 34, 8, 4, PAL.groundStripe);
  for (let x = g0 * 0.5 - 120; x < visW + 120; x += 120) P.rrect(x, E.GROUND + 54, 70, 6, 3, PAL.groundStripe);
  P.rect(-20, E.GROUND, visW + 40, 3, PAL.groundLip);
  // 6) partículas
  if (fx) {
    for (let i = 0; i < fx.parts.length; i++) {
      const q = fx.parts[i]; const a = 1 - q.t / q.life;
      const c = q.k === 'flap' ? `rgba(235,244,255,${(0.45 * a).toFixed(3)})` : q.k === 'score' ? `rgba(143,211,255,${(0.9 * a).toFixed(3)})` : `rgba(243,247,251,${(0.85 * a).toFixed(3)})`;
      P.circle(q.x - camX, q.y, q.r * (q.k === 'flap' ? 1 + (1 - a) * 0.8 : 1), c);
    }
  }
  // 7) Bolhinha
  const px = dist - camX;
  let py; let ang;
  if (st) {
    py = st.y / E.FP;
    if (!st.alive && fx && fx.dead) py = Math.min(E.GROUND - 24, py + 1300 * fx.deathT * fx.deathT);
    const target = st.alive ? (st.vy < 0 ? -20 : Math.min(70, -20 + (st.vy / 9300) * 100)) : 80;
    if (fx) { fx.ang += (target - fx.ang) * (st.alive ? 0.22 : 0.12); ang = fx.ang; } else ang = target;
  } else {
    py = 420 + (o.reduceMotion ? 0 : Math.sin(t * 3.2) * 14);
    ang = o.reduceMotion ? 0 : Math.sin(t * 3.2 + 1.2) * 6;
  }
  const wingUp = fx ? fx.wing : 0;
  const idleFlap = !st && !o.reduceMotion ? (Math.sin(t * 9) * 0.5 + 0.5) * 0.6 : 0;
  drawBuddy(P, px, py, ang, Math.max(wingUp, idleFlap), t, st ? st.alive : true, o.reduceMotion);
  if (fx && fx.flash > 0) P.rgrad(px, py, 70 + (1 - fx.flash) * 40, `rgba(143,211,255,${(0.28 * fx.flash).toFixed(3)})`, 'rgba(143,211,255,0)');
  P.restore();
}

function drawPillar(P, x, y, h, isTop) {
  if (h <= 0) return;
  P.rrect(x + 6, y, E.PW - 12, h, 10, PAL.pipe);
  P.rect(x + 16, y + 6, 10, Math.max(0, h - 12), PAL.pipeHi);
  P.rect(x + E.PW - 22, y + 6, 6, Math.max(0, h - 12), PAL.pipeShade);
  // capitel do lado do vão
  const capH = 30;
  const cy = isTop ? y + h - capH : y;
  P.rrect(x, cy, E.PW, capH, 12, PAL.pipeCap);
  P.rect(x + 10, isTop ? cy + capH - 5 : cy + 2, E.PW - 20, 3, PAL.pipeEdge);
  P.circle(x + E.PW / 2, isTop ? cy + 12 : cy + capH - 12, 4, 'rgba(143,211,255,0.85)');
}

function drawBuddy(P, x, y, ang, wing, t, alive, rm) {
  P.save();
  P.translate(x, y);
  P.rotate(ang);
  // asa de trás (mais escura)
  const wa = -35 * wing + 18 * (1 - wing);
  P.save(); P.translate(-4, 2); P.rotate(wa * 0.7 + 10); P.scale(0.8); P.path(P.makePath(WING_D), PAL.wingDark); P.restore();
  // corpo
  P.path(P.makePath(BODY_D), PAL.body);
  P.path(P.makePath(BELLY_D), PAL.bodyShade);
  P.circle(-8, -12, 7, 'rgba(255,255,255,0.75)');
  // bochecha + olho
  P.circle(14, 6, 5, PAL.blush);
  if (alive) {
    P.circle(9, -6, 4.6, PAL.eye);
    P.circle(10.6, -7.8, 1.5, '#FFFFFF');
  } else {
    P.save(); P.translate(9, -6); P.rotate(45); P.rrect(-5, -1.2, 10, 2.4, 1.2, PAL.eye); P.rotate(90); P.rrect(-5, -1.2, 10, 2.4, 1.2, PAL.eye); P.restore();
  }
  // os 3 pontinhos de "digitando"
  for (let i = 0; i < 3; i++) {
    const k = rm ? 0 : Math.max(0, Math.sin(t * 6 - i * 0.8));
    P.circle(-8 + i * 7, 12 - k * 2, 2.3, PAL.dots);
  }
  // asa da frente
  P.save(); P.translate(-2, 4); P.rotate(wa); P.path(P.makePath(WING_D), PAL.wing); P.restore();
  P.restore();
}

module.exports = { PAL, canvas2dPainter, skiaPainter, createFx, fxEmit, fxUpdate, drawFrame, BODY_D, BELLY_D, WING_D };
