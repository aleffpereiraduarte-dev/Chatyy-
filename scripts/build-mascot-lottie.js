#!/usr/bin/env node
// scripts/build-mascot-lottie.js — [2026-10-16 mascote] Gera a figurinha
// animada (Lottie JSON) do mascote ORIGINAL do Chatyy a partir da MESMA
// geometria do app (components/mascot/mascotArt.js).
//
//   node scripts/build-mascot-lottie.js          → public/stickers/chatyy-aceno.json
//
// O JSON vai junto no deploy web (public/ → dist/ → /var/www/mail/stickers/)
// e é o file_url da mensagem `lottie_sticker` de saudação. Apps atuais tocam
// com lottie-react-native (já no binário); a versão nova reconhece a URL e
// desenha o mascote local (sem baixar nada).
'use strict';
const fs = require('fs');
const path = require('path');
const { ART, MASCOT_COLORS: MC } = require('../components/mascot/mascotArt');

const FR = 60;
const OP = 150; // 2.5 s
const W = 360;
const SC = W / ART.size; // 3

const hex = (h) => { const n = parseInt(h.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1].map((x) => +x.toFixed(4)); };
const st = (v) => ({ a: 0, k: v });

// ── SVG path (M L H V C Q Z absolutos) → forma Lottie ──
function pathToShapes(d) {
  const toks = d.match(/[MLHVCQZ]|-?\d*\.?\d+(?:e-?\d+)?/gi);
  const subs = []; let cur = null; let i = 0; let cmd = null; let p = [0, 0];
  const num = () => parseFloat(toks[i++]);
  const start = (pt) => { cur = { v: [pt], i: [[0, 0]], o: [[0, 0]], c: false }; subs.push(cur); };
  const lineTo = (pt) => { cur.v.push(pt); cur.i.push([0, 0]); cur.o.push([0, 0]); };
  const cubTo = (c1, c2, pt) => {
    const last = cur.v.length - 1; const pv = cur.v[last];
    cur.o[last] = [c1[0] - pv[0], c1[1] - pv[1]];
    cur.v.push(pt); cur.i.push([c2[0] - pt[0], c2[1] - pt[1]]); cur.o.push([0, 0]);
  };
  while (i < toks.length) {
    if (/^[A-Z]$/i.test(toks[i])) cmd = toks[i++];
    switch (cmd) {
      case 'M': p = [num(), num()]; start(p); cmd = 'L'; break;
      case 'L': p = [num(), num()]; lineTo(p); break;
      case 'H': p = [num(), p[1]]; lineTo(p); break;
      case 'V': p = [p[0], num()]; lineTo(p); break;
      case 'C': { const c1 = [num(), num()]; const c2 = [num(), num()]; p = [num(), num()]; cubTo(c1, c2, p); break; }
      case 'Q': {
        const q = [num(), num()]; const p0 = p; const p1 = [num(), num()];
        const c1 = [p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])];
        const c2 = [p1[0] + (2 / 3) * (q[0] - p1[0]), p1[1] + (2 / 3) * (q[1] - p1[1])];
        p = p1; cubTo(c1, c2, p); break;
      }
      case 'Z': {
        cur.c = true;
        const n = cur.v.length - 1;
        if (n > 0 && Math.abs(cur.v[n][0] - cur.v[0][0]) < 1e-6 && Math.abs(cur.v[n][1] - cur.v[0][1]) < 1e-6) {
          cur.i[0] = cur.i[n]; cur.v.pop(); cur.i.pop(); cur.o.pop();
        }
        cmd = null; break;
      }
      default: i++;
    }
  }
  const r = (a) => a.map((q) => q.map((x) => +x.toFixed(3)));
  return subs.map((s) => ({ ty: 'sh', d: 1, ks: st({ i: r(s.i), o: r(s.o), v: r(s.v), c: s.c }) }));
}

const fillI = (c, o = 100) => ({ ty: 'fl', c: st(hex(c)), o: st(o), r: 1, bm: 0 });
const strokeI = (c, w) => ({ ty: 'st', c: st(hex(c)), o: st(100), w: st(w), lc: 2, lj: 2, ml: 4, bm: 0 });
const trI = () => ({ ty: 'tr', p: st([0, 0]), a: st([0, 0]), s: st([100, 100]), r: st(0), o: st(100), sk: st(0), sa: st(0) });
const group = (nm, items) => ({ ty: 'gr', nm, it: [...items, trI()], np: items.length, bm: 0 });
const pathG = (nm, d, { fill, stroke, w, op } = {}) => group(nm, [
  ...pathToShapes(d),
  ...(stroke ? [strokeI(stroke, w)] : []),
  ...(fill ? [fillI(fill, op == null ? 100 : op)] : []),
]);
const ellG = (nm, e, { fill, stroke, w, op } = {}) => group(nm, [
  { ty: 'el', d: 1, p: st([e.cx, e.cy]), s: st([e.rx * 2, e.ry * 2]) },
  ...(stroke ? [strokeI(stroke, w)] : []),
  ...(fill ? [fillI(fill, op == null ? 100 : op)] : []),
]);

// keyframes [fração, valor|array] com ease in-out
function anim(pairs, ease = [0.42, 0.58], spatial = false) {
  const arr = (v) => (Array.isArray(v) ? v : [v]);
  const n = arr(pairs[0][1]).length;
  return {
    a: 1,
    k: pairs.map(([f, v], idx) => {
      const kf = { t: Math.round(f * OP), s: arr(v) };
      if (idx < pairs.length - 1) {
        if (spatial) { // posição: tangentes escalares + to/ti (formato do bodymovin)
          kf.o = { x: ease[0], y: 0 }; kf.i = { x: ease[1], y: 1 };
          kf.to = [0, 0, 0]; kf.ti = [0, 0, 0];
        } else {
          kf.o = { x: Array(n).fill(ease[0]), y: Array(n).fill(0) };
          kf.i = { x: Array(n).fill(ease[1]), y: Array(n).fill(1) };
        }
      }
      return kf;
    }),
  };
}

let IND = 0;
function layer(nm, { ty = 4, shapes, parent, a = [0, 0, 0], p = [0, 0, 0], s = [100, 100, 100], r = 0, o = 100 }) {
  const L = {
    ddd: 0, ind: ++IND, ty, nm, sr: 1,
    ks: {
      o: typeof o === 'object' ? o : st(o),
      r: typeof r === 'object' ? r : st(r),
      p: p.a ? p : st(p),
      a: st(a),
      s: s.a ? s : st(s),
    },
    ao: 0, ip: 0, op: OP, st: 0, bm: 0,
  };
  if (ty === 4) L.shapes = shapes;
  if (parent) L.parent = parent;
  return L;
}

function buildWave() {
  IND = 0;
  const ink = MC.ink; const sw = ART.bodyStroke;
  // null "corpo": quica 2× por ciclo
  const bob = (dy) => [W / 2, W / 2 + dy * SC, 0];
  const body = layer('corpo', {
    ty: 3, a: [60, 60, 0], s: [SC * 100, SC * 100, 100],
    p: anim([[0, bob(0)], [0.25, bob(-1.6)], [0.5, bob(0)], [0.75, bob(-1.6)], [1, bob(0)]], undefined, true),
  });
  const pv = ART.armR.pivot;
  const wav = [[0, 0], [0.06, -18], [0.14, 10], [0.22, -18], [0.30, 10], [0.38, -18], [0.48, 0], [1, 0]];
  const arm = layer('braco', {
    parent: body.ind, a: [pv[0], pv[1], 0], p: [pv[0], pv[1], 0], r: anim(wav),
    shapes: [
      ...ART.armR.fingers.map((d, i) => pathG(`dedo${i}`, d, { stroke: ink, w: 1.8 })),
      pathG('mao', ART.armR.hand, { fill: MC.fill, stroke: ink, w: sw - 0.5 }),
      pathG('braco', ART.armR.arm, { stroke: ink, w: sw + 0.6 }),
      // contorno branco "recortado" (fica visível em chat de fundo escuro)
      pathG('mao-halo', ART.armR.hand, { fill: MC.fill, stroke: MC.fill, w: sw + 3.5 }),
      pathG('braco-halo', ART.armR.arm, { stroke: MC.fill, w: sw + 4.6 }),
    ],
  });
  const lines = layer('tracos', {
    parent: arm.ind, a: [0, 0, 0], p: [0, 0, 0],
    o: anim([[0, 0], [0.06, 100], [0.40, 100], [0.48, 0], [1, 0]]),
    shapes: [
      ...ART.armR.lines.map((d, i) => pathG(`t${i}`, d, { stroke: ink, w: 2.4 })),
      ...ART.armR.lines.map((d, i) => pathG(`th${i}`, d, { stroke: MC.fill, w: 5.4 })),
    ],
  });
  const M = ART.mouth;
  const face = layer('rosto', {
    parent: body.ind,
    shapes: [
      pathG('lingua', M.tongue, { fill: MC.tongue }),
      pathG('boca', M.open, { fill: ink, stroke: ink, w: 1.4 }),
      ...ART.cheeks.map((c, i) => ellG(`bochecha${i}`, c, { fill: MC.blush, op: ART.cheekOp * 100 })),
      pathG('balao', ART.body, { fill: MC.fill, stroke: ink, w: sw }),
      pathG('balao-halo', ART.body, { fill: MC.fill, stroke: MC.fill, w: sw + 4 }),
    ],
  });
  const ec = ART.eyesCenter;
  const blink = (v) => [100, v, 100];
  const eyes = layer('olhos', {
    parent: body.ind, a: [ec[0], ec[1], 0], p: [ec[0], ec[1], 0],
    s: anim([[0, blink(100)], [0.6, blink(100)], [0.63, blink(10)], [0.66, blink(100)], [1, blink(100)]]),
    shapes: [
      ...ART.eyeShine.map((e, i) => ellG(`brilho${i}`, { cx: e.cx, cy: e.cy, rx: e.r, ry: e.r }, { fill: '#FFFFFF' })),
      ...ART.eyes.map((e, i) => ellG(`olho${i}`, e, { fill: ink })),
    ],
  });
  const sh = ART.shadow;
  const sx = (v) => [SC * 100 * v, SC * 100, 100];
  const shadow = layer('sombra', {
    a: [sh.cx, sh.cy, 0], p: [sh.cx * SC, sh.cy * SC, 0],
    s: anim([[0, sx(1)], [0.25, sx(0.94)], [0.5, sx(1)], [0.75, sx(0.94)], [1, sx(1)]]),
    shapes: [ellG('sombra', sh, { fill: ink, op: sh.op * 100 })],
  });
  // ordem Lottie: 1º = topo
  return {
    v: '5.7.4', fr: FR, ip: 0, op: OP, w: W, h: W, nm: 'chatyy-aceno', ddd: 0, assets: [],
    layers: [eyes, face, lines, arm, body, shadow],
    meta: { g: 'Chatyy mascot (original art)' },
  };
}

const outDir = path.join(__dirname, '..', 'public', 'stickers');
fs.mkdirSync(outDir, { recursive: true });
const json = JSON.stringify(buildWave());
fs.writeFileSync(path.join(outDir, 'chatyy-aceno.json'), json);
console.log('chatyy-aceno.json', json.length, 'bytes');
