// components/mascot/mascotArt.js — [2026-10-16 mascote] Arte ORIGINAL do Chatyy.
//
// "Chaty": um balão de conversa P&B (contorno tinta #111, corpo branco) com
// carinha, bochechas rosadas suaves e um rabinho de balão. Desenho 100% nosso
// (formas vetoriais simples) — NÃO derivado de figurinhas de terceiros.
//
// Fonte ÚNICA da geometria (viewBox 0 0 120 120), usada por:
//   • components/mascot/ChatyyMascot.js  (SVG em camadas + Animated nativo)
//   • scripts/build-mascot-lottie.js     (gera public/stickers/chatyy-*.json,
//     a figurinha animada Lottie que vai na mensagem)
// Mudou a arte aqui → rode o script p/ regenerar o Lottie.
//
// CommonJS de propósito: o script node lê o mesmo arquivo sem Babel.

const C = {
  ink: '#111111',
  fill: '#FFFFFF',
  fillDark: '#F5F5F7',
  blush: '#FF9DB0',
  tongue: '#FF7A93',
  lens: '#9CC7FF',
  confetti: ['#FFB4C2', '#9CD8C3', '#FFD98A', '#A9C8FF'],
};

const ART = {
  size: 120,
  // Corpo = balão com rabinho embaixo à esquerda.
  body: 'M50 26 H70 C85.5 26 98 38.5 98 54 V58 C98 73.5 85.5 86 70 86 H54 L39 98 C37 99.6 34.6 98 35.3 95.6 L38.4 84.2 C28.6 79.6 22 69.7 22 58 V54 C22 38.5 34.5 26 50 26 Z',
  bodyStroke: 3.5,
  shadow: { cx: 60, cy: 108, rx: 26, ry: 3.4, op: 0.1 },
  cheeks: [{ cx: 40.5, cy: 64.5, rx: 5, ry: 3 }, { cx: 79.5, cy: 64.5, rx: 5, ry: 3 }],
  cheekOp: 0.6,
  eyes: [{ cx: 49, cy: 54, rx: 4.6, ry: 6 }, { cx: 71, cy: 54, rx: 4.6, ry: 6 }],
  eyeShine: [{ cx: 50.7, cy: 51.4, r: 1.6 }, { cx: 72.7, cy: 51.4, r: 1.6 }],
  eyesCenter: [60, 54],
  sleepEyes: ['M44.5 54.5 Q49 58.5 53.5 54.5', 'M66.5 54.5 Q71 58.5 75.5 54.5'],
  mouth: {
    open: 'M53 64 C54.5 71.8 65.5 71.8 67 64 Z',
    tongue: 'M56.4 68.4 C58.4 66.7 61.6 66.7 63.6 68.4 C62 70.3 58 70.3 56.4 68.4 Z',
    smile: 'M54 65 Q60 70 66 65',
    small: 'M56.5 66.5 Q60 68.5 63.5 66.5',
    wavy: 'M53 67.5 Q56.5 64.8 60 67.5 Q63.5 70.2 67 67.5',
    o: { cx: 60, cy: 67, rx: 2.3, ry: 2.8 },
  },
  // Braço que acena (direito). Pivô = ombro, escondido atrás do corpo.
  armR: {
    pivot: [95, 63],
    arm: 'M93 64 C101 61 105.5 53 106.5 45',
    // mão "luva" com polegar + 2 riscos de dedos
    hand: 'M104 46 C101.5 45 99 43 99.3 41 C99.6 39.4 101.3 39.2 102.5 40.3 L102.3 37.5 C102.3 34.5 104.5 32.3 107.2 32.3 C110 32.3 112.2 34.5 112.2 37.5 V41 C112.2 44 110 46 107.5 46 Z',
    fingers: ['M105.6 33.4 V36.2', 'M108.9 33.4 V36.2'],
    lines: ['M113.5 31 Q117.5 34.5 117.5 39', 'M101.5 29 Q104.5 25.5 109 25.8'],
  },
  armL: {
    pivot: [25, 63],
    arm: 'M27 64 C19 61 14.5 53 13.5 45',
    hand: 'M16 46 C18.5 45 21 43 20.7 41 C20.4 39.4 18.7 39.2 17.5 40.3 L17.7 37.5 C17.7 34.5 15.5 32.3 12.8 32.3 C10 32.3 7.8 34.5 7.8 37.5 V41 C7.8 44 10 46 12.5 46 Z',
    fingers: ['M14.4 33.4 V36.2', 'M11.1 33.4 V36.2'],
  },
  // Lupa na frente do olho direito (pose "procurar").
  magnifier: {
    lens: { cx: 72, cy: 54, r: 10.5 },
    handle: 'M79.6 61.6 L89 71',
    arm: 'M96.5 66 C98.5 70 96.5 73.5 92 74.5',
    hand: { cx: 90.5, cy: 73, r: 4.6 },
  },
  zs: [
    { d: 'M98 33 H105 L98 40 H105', w: 2.6 },
    { d: 'M106 19 H111.5 L106 24.5 H111.5', w: 2.2 },
    { d: 'M112.5 8 H116.5 L112.5 12 H116.5', w: 1.8 },
  ],
  // Confete (pose "celebrar"): 2 levas que se alternam.
  confettiA: [
    { t: 'r', x: 14, y: 22, w: 5, h: 8, rot: -20, c: 0 },
    { t: 'c', x: 104, y: 16, r: 3, c: 1 },
    { t: 'r', x: 60, y: 8, w: 5, h: 8, rot: 25, c: 2 },
  ],
  confettiB: [
    { t: 'c', x: 30, y: 10, r: 2.6, c: 3 },
    { t: 'r', x: 92, y: 6, w: 4.5, h: 7.5, rot: -35, c: 0 },
    { t: 'c', x: 110, y: 32, r: 2.4, c: 2 },
    { t: 'r', x: 8, y: 36, w: 4, h: 7, rot: 30, c: 1 },
  ],
  wifiOff: {
    arcs: ['M49 15 Q60 6 71 15', 'M53.5 19.8 Q60 15 66.5 19.8'],
    dot: { cx: 60, cy: 23.5, r: 1.9 },
    slash: 'M50.5 9 L69.5 26',
  },
};

module.exports = { ART, MASCOT_COLORS: C };
