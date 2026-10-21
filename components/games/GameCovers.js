// components/games/GameCovers.js — [jogos 2026-10-21 painel] capas desenhadas de cada jogo (mockup aprovado
// preview-2026/jogos2.html): arte SVG 70×70 por chave + tinta de fundo suave (claro/escuro) + ordem/selo NOVO.
// Usado na grade "Jogar agora", nos cartões "Continue" (arte grande no canto) e no histórico (ícone tingido).
// Jogo sem capa aqui = capa neutra (controle) → um jogo novo registrado no servidor nunca quebra a grade.
// Nunca emoji: tudo SVG (react-native-svg; `color` do <Svg> alimenta o currentColor).
import React from 'react';
import Svg, { Rect, Circle, Path, G, Line } from 'react-native-svg';

/** Chaves dos 8 jogos novos (selo NOVO na grade). */
export const NEW_GAMES = { ligue4: 1, naval: 1, domino: 1, memoria: 1, termo: 1, ppt: 1, stop: 1, desenho: 1 };
export function isNewGame(type) { return !!NEW_GAMES[type]; }

/** Ordem da grade (o que não estiver aqui vai para o fim, na ordem do catálogo). */
export const COVER_ORDER = ['ligue4', 'damas', 'cartas', 'naval', 'termo', 'velha', 'ppt', 'quiz', 'memoria', 'forca', 'domino', 'stop', 'desenho'];

/** Títulos de reserva (pt) dos jogos novos, usados só se o app ainda não tiver a tradução. */
export const COVER_TITLE_FB = {
  ligue4: 'Ligue 4', naval: 'Batalha Naval', domino: 'Dominó', memoria: 'Jogo da Memória',
  termo: 'Termo em dupla', ppt: 'Pedra, papel e tesoura', stop: 'Stop', desenho: 'Desenha e Adivinha',
};
/** Frase curta de reserva (pt) — chave i18n games.blurb.<tipo>. */
export const COVER_BLURB_FB = {
  ligue4: '4 em linha, fichas que caem', naval: 'Afunde os barcos do outro', domino: 'Clássico de 2, pedra que encaixa',
  memoria: 'Vire pares, acerto joga de novo', termo: 'Adivinhe a palavra de 5 letras', ppt: 'Melhor de 3, jogada secreta',
  stop: 'Letra sorteada e... STOP', desenho: 'Um desenha, o outro chuta',
};

// tinta do fundo da capa: claro (mockup) / escuro (mesmo matiz, bem baixo)
const TINT = {
  damas: ['#EFE8DC', '#2A261F'], cartas: ['#FBE9D6', '#2E241A'], ligue4: ['#DFE5FB', '#1C2238'], naval: ['#E3EFF6', '#17252D'],
  termo: ['#E2F1E5', '#18271C'], ppt: ['#F6E5EE', '#2B1C24'], memoria: ['#ECE6F8', '#231E31'], stop: ['#FBE3E1', '#2E1C1B'],
  desenho: ['#FCF1D6', '#2C2717'], domino: ['#ECEBE6', '#25252A'],
};
/** Fundo da capa. Jogos sem tinta própria usam a superfície 2 do Grafite. */
export function coverTint(type, isDark) {
  const t = TINT[type];
  if (t) return isDark ? t[1] : t[0];
  return isDark ? '#232327' : '#EAEAE6';
}
// cartões "Continue": grafite (padrão) ou grafite azulado/esverdeado por jogo — sempre escuros, texto branco
const CONT = { quiz: ['#2F3A5A', '#151A2A'], naval: ['#23404F', '#111C24'], ligue4: ['#2B3566', '#141833'], termo: ['#27412F', '#121E16'] };
export function continueGradient(type) { return CONT[type] || ['#3A3A40', '#17171A']; }

const SQ = [0, 1, 2, 3];

function Damas() {
  return (
    <G>
      <Rect x={5} y={5} width={60} height={60} rx={10} fill="#E9E4DA" />
      {SQ.map((r) => SQ.map((c) => ((r + c) % 2 ? <Rect key={`${r}${c}`} x={5 + c * 15} y={5 + r * 15} width={15} height={15} fill="#6B5A48" /> : null)))}
      <Circle cx={27.5} cy={27.5} r={5.5} fill="#fff" stroke="#222" strokeWidth={1.5} />
      <Circle cx={42.5} cy={42.5} r={5.5} fill="#222" />
      <Circle cx={57.5} cy={12.5} r={5.5} fill="#222" />
    </G>
  );
}
function Velha() {
  return (
    <G fill="none" strokeLinecap="round">
      <Path d="M27 10v50M43 10v50M10 27h50M10 43h50" stroke="currentColor" strokeWidth={3} opacity={0.35} />
      <Path d="M14 14l8 8M22 14l-8 8M48 48l8 8M56 48l-8 8" stroke="currentColor" strokeWidth={4} />
      <Circle cx={35} cy={35} r={5} stroke="currentColor" strokeWidth={4} />
      <Circle cx={52} cy={18} r={5} stroke="currentColor" strokeWidth={4} />
    </G>
  );
}
function Cartas() {
  return (
    <G>
      <Rect x={12} y={16} width={28} height={40} rx={5} fill="#E5484D" transform="rotate(-14 26 36)" />
      <Rect x={22} y={13} width={28} height={40} rx={5} fill="#F2C94C" />
      <G transform="rotate(14 46 36)">
        <Rect x={32} y={16} width={28} height={40} rx={5} fill="#3B82F6" />
        {/* "7" desenhado */}
        <Path d="M41 29h10l-6 16" stroke="#fff" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </G>
    </G>
  );
}
function Quiz() {
  return (
    <G>
      <Rect x={8} y={12} width={54} height={40} rx={14} fill="currentColor" opacity={0.12} />
      <Path d="M28.5 25.5a6.5 6.5 0 1 1 9.4 5.8c-1.9 1-2.9 2.2-2.9 4.2v1.5" stroke="currentColor" strokeWidth={4.2} strokeLinecap="round" fill="none" />
      <Circle cx={35} cy={44} r={2.6} fill="currentColor" />
      <Circle cx={18} cy={58} r={4} fill="#2FB36B" />
      <Circle cx={30} cy={58} r={4} fill="currentColor" opacity={0.3} />
      <Circle cx={42} cy={58} r={4} fill="currentColor" opacity={0.3} />
    </G>
  );
}
function Forca() {
  return (
    <G fill="none" stroke="currentColor" strokeWidth={3.5} strokeLinecap="round">
      <Path d="M12 62h26M20 62V10h26v8" />
      <Circle cx={46} cy={25} r={6} />
      <Path d="M46 31v14M46 36l-7 5M46 36l7 5" />
      <Path d="M42 58h6M52 58h6" opacity={0.4} />
    </G>
  );
}
const L4_FILLED = { '2,2': '#E5484D', '2,3': '#F2C94C', '1,3': '#E5484D', '2,1': '#F2C94C', '1,2': '#E5484D', '0,3': '#F2C94C' };
function Ligue4() {
  const cells = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) cells.push(<Circle key={`${r}${c}`} cx={14 + c * 10.5} cy={22 + r * 14} r={4.3} fill={L4_FILLED[`${r},${c}`] || '#1F2F8A'} />);
  return (
    <G>
      <Rect x={6} y={12} width={58} height={48} rx={10} fill="#3B5BDB" />
      {cells}
    </G>
  );
}
function Naval() {
  return (
    <G fill="none">
      <Rect x={6} y={6} width={58} height={58} rx={10} fill="#CFE3EF" />
      <Path d="M6 25h58M6 45h58M25 6v58M45 6v58" stroke="#9CC0D6" />
      <Path d="M14 36h22l-4 6H18z" fill="#34343A" />
      <Path d="M22 36v-6h6v6" fill="#34343A" />
      <Circle cx={54} cy={16} r={5} fill="#E5484D" />
      <Path d="M50 52l8 8M58 52l-8 8" stroke="#34343A" strokeWidth={2.5} strokeLinecap="round" />
    </G>
  );
}
const TERMO = [['#2FB36B', '#8F8F94', '#E0A800', '#8F8F94', '#8F8F94'], ['#2FB36B', '#2FB36B', '#2FB36B', '#E0A800', '#2FB36B']];
function Termo() {
  return (
    <G>
      {TERMO.map((row, r) => row.map((c, i) => <Rect key={`${r}${i}`} x={6 + i * 12} y={18 + r * 13} width={10} height={10} rx={2.5} fill={c} />))}
      {[0, 1, 2, 3, 4].map((i) => <Rect key={`e${i}`} x={6 + i * 12} y={44} width={10} height={10} rx={2.5} fill="none" stroke="currentColor" strokeWidth={1.4} opacity={0.35} />)}
    </G>
  );
}
function Ppt() {
  return (
    <G>
      {/* pedra */}
      <Path d="M8 46c0-7 5-12 11-12 5 0 9 3 10 8 1 6-3 11-10 11-7 0-11-2-11-7z" fill="#8F8F94" />
      {/* papel */}
      <G transform="rotate(-8 35 26)">
        <Rect x={25} y={12} width={20} height={26} rx={3} fill="#fff" stroke="currentColor" strokeWidth={1.4} opacity={0.95} />
        <Path d="M29 19h12M29 24h12M29 29h8" stroke="currentColor" strokeWidth={1.4} opacity={0.4} strokeLinecap="round" />
      </G>
      {/* tesoura */}
      <G stroke="#E5484D" strokeWidth={2.6} fill="none" strokeLinecap="round">
        <Circle cx={47} cy={55} r={4.5} />
        <Circle cx={59} cy={55} r={4.5} />
        <Path d="M49.5 51.5L62 36M56.5 51.5L44 36" />
      </G>
    </G>
  );
}
function Memoria() {
  const cards = [];
  for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
    const x = 8 + c * 19; const y = 14 + r * 23;
    const up = (r === 0 && c === 0) || (r === 1 && c === 2);
    cards.push(
      <G key={`${r}${c}`}>
        <Rect x={x} y={y} width={16} height={20} rx={3.5} fill={up ? '#fff' : '#6E56CF'} stroke={up ? '#6E56CF' : 'none'} strokeWidth={1.4} />
        {up ? <Path d={`M${x + 8} ${y + 5}l1.9 3.9 4.2.6-3 3 .7 4.2-3.8-2-3.8 2 .7-4.2-3-3 4.2-.6z`} fill="#F2C94C" />
          : <Circle cx={x + 8} cy={y + 10} r={3} fill="none" stroke="#fff" strokeWidth={1.2} opacity={0.6} />}
      </G>,
    );
  }
  return <G>{cards}</G>;
}
function Stop() {
  return (
    <G>
      <Rect x={8} y={10} width={36} height={48} rx={5} fill="#fff" stroke="currentColor" strokeWidth={1.4} opacity={0.95} />
      <Path d="M14 22h24M14 31h24M14 40h18M14 49h20" stroke="currentColor" strokeWidth={1.6} opacity={0.35} strokeLinecap="round" />
      <Path d="M45 30l7-7h10l7 7v10l-7 7H52l-7-7z" fill="#E5484D" />
      <Rect x={49.5} y={33} width={15} height={4} rx={2} fill="#fff" />
    </G>
  );
}
function Desenho() {
  return (
    <G>
      <Rect x={7} y={10} width={48} height={42} rx={7} fill="#fff" stroke="currentColor" strokeWidth={1.4} opacity={0.95} />
      <Path d="M14 40c5-12 9-14 12-6s7 6 9-4 7-8 11 0" stroke="#3B82F6" strokeWidth={3} fill="none" strokeLinecap="round" />
      <G transform="rotate(40 54 44)">
        <Rect x={50} y={22} width={8} height={30} rx={2} fill="#F2C94C" />
        <Path d="M50 52h8l-4 8z" fill="#E9C9A0" />
        <Path d="M53 57.5h2l-1 2.5z" fill="#34343A" />
        <Rect x={50} y={22} width={8} height={5} rx={2} fill="#E5484D" />
      </G>
    </G>
  );
}
function Pips({ x, y, n }) {
  const P = { 1: [[1, 1]], 2: [[0, 0], [2, 2]], 3: [[0, 0], [1, 1], [2, 2]], 4: [[0, 0], [2, 0], [0, 2], [2, 2]], 5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]], 6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]] }[n] || [];
  return <G>{P.map(([a, b], i) => <Circle key={i} cx={x + 4 + a * 5} cy={y + 4 + b * 5} r={1.8} fill="#18181B" />)}</G>;
}
function Domino() {
  return (
    <G>
      <G transform="rotate(-12 26 36)">
        <Rect x={16} y={12} width={20} height={40} rx={4} fill="#fff" stroke="#18181B" strokeWidth={1.6} />
        <Line x1={19} y1={32} x2={33} y2={32} stroke="#18181B" strokeWidth={1.4} />
        <Pips x={21} y={15} n={5} />
        <Pips x={21} y={35} n={2} />
      </G>
      <G transform="rotate(14 46 38)">
        <Rect x={36} y={18} width={20} height={40} rx={4} fill="#34343A" />
        <Line x1={39} y1={38} x2={53} y2={38} stroke="#fff" strokeWidth={1.4} opacity={0.6} />
        {[[46, 28], [42, 44], [50, 52], [46, 48]].map(([cx, cy], i) => <Circle key={i} cx={cx} cy={cy} r={1.8} fill="#fff" />)}
      </G>
    </G>
  );
}
function Generic() {
  return (
    <G fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M20 26h30c6 0 10 5 11 11l2 10c1 5-5 8-9 4l-5-5H21l-5 5c-4 4-10 1-9-4l2-10c1-6 5-11 11-11z" />
      <Path d="M22 34v8M18 38h8" />
      <Circle cx={47} cy={35} r={1.6} fill="currentColor" />
      <Circle cx={52} cy={40} r={1.6} fill="currentColor" />
    </G>
  );
}

const ART = { damas: Damas, velha: Velha, cartas: Cartas, quiz: Quiz, forca: Forca, ligue4: Ligue4, naval: Naval, termo: Termo, ppt: Ppt, memoria: Memoria, stop: Stop, desenho: Desenho, domino: Domino };
export function hasCover(type) { return !!ART[type]; }

/** Capa do jogo (só a arte; o fundo tingido fica no contêiner). `color` = currentColor (traços neutros). */
export function GameCover({ type, size = 70, color = '#18181B', opacity }) {
  const A = ART[type] || Generic;
  return (
    <Svg width={size} height={size} viewBox="0 0 70 70" color={color} opacity={opacity}>
      <A />
    </Svg>
  );
}

export default GameCover;
