// components/games/boards/chessPieces.js — [jogos3 2026-10-22] peças de xadrez desenhadas em SVG (sem fonte/emoji).
// Silhuetas próprias em viewBox 45×45; brancas = marfim com contorno grafite, pretas = ônix com filete claro.
// ChessShape devolve só os <G>/<Path> (reaproveitado na capa do jogo); ChessPiece embrulha num <Svg> memoizado.
import React, { memo } from 'react';
import Svg, { G, Path, Circle, Rect } from 'react-native-svg';

export function chessInk(white) {
  return white ? { fill: '#F7F6F1', stroke: '#2A2A2E', detail: '#2A2A2E' } : { fill: '#1F1F23', stroke: '#0A0A0B', detail: '#D9D8D2' };
}

/** Formas da peça `k` ('p','n','b','r','q','k') — use dentro de um <Svg viewBox="0 0 45 45">. */
export function ChessShape({ k, white }) {
  const { fill, stroke, detail } = chessInk(white);
  const P = { fill, stroke, strokeWidth: 1.6, strokeLinejoin: 'round', strokeLinecap: 'round' };
  const D = { fill: 'none', stroke: detail, strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' };
  const base = <Rect x={10.5} y={35.5} width={24} height={4.5} rx={1.6} {...P} />;
  switch (k) {
    case 'p':
      return (
        <G>
          <Path d="M15.5 35.5c.4-5.2 2.8-8.6 5.3-10.6h3.4c2.5 2 4.9 5.4 5.3 10.6z" {...P} />
          <Path d="M18.2 24.9h8.6" {...P} />
          <Circle cx={22.5} cy={17.2} r={5.2} {...P} />
          {base}
        </G>
      );
    case 'r':
      return (
        <G>
          <Path d="M14.5 35.5l1.3-15.2h13.4l1.3 15.2z" {...P} />
          <Path d="M12.5 20.3V11.5h4v3h3.6v-3h4.8v3h3.6v-3h4v8.8z" {...P} />
          <Path d="M16 24h13M15.6 31h13.8" {...D} />
          {base}
        </G>
      );
    case 'n':
      return (
        <G>
          <Path d="M13.6 35.5c0-7.4 2.6-11.4 7.4-15-2.4.2-4.8 1.4-6.6 3.2l-2.6-2.4c-.9-.9-.8-2.2.2-3l7.2-6.7.5-3.6 2.8 2.8c6.6.6 10.5 6 10.5 13.6v11.1z" {...P} />
          <Circle cx={20.4} cy={14.2} r={1.1} fill={detail} />
          <Path d="M26.5 13.6c1.6 2.2 2.3 5 2.3 8.6" {...D} />
          {base}
        </G>
      );
    case 'b':
      return (
        <G>
          <Path d="M16.5 35.5c1.8-2.4 3-5.8 3-9.6h6c0 3.8 1.2 7.2 3 9.6z" {...P} />
          <Path d="M22.5 8.6c-4.2 3.6-6.8 7.4-6.8 11.3 0 3.6 2.7 6 6.8 6s6.8-2.4 6.8-6c0-3.9-2.6-7.7-6.8-11.3z" {...P} />
          <Circle cx={22.5} cy={6.6} r={2.1} {...P} />
          <Path d="M24.8 13.6l-4.2 4.6M22.5 18.4v4" {...D} />
          {base}
        </G>
      );
    case 'q':
      return (
        <G>
          <Path d="M12.8 32.5L9.6 17.8l6.2 8.6 1.6-11.6 5.1 10 5.1-10 1.6 11.6 6.2-8.6-3.2 14.7z" {...P} />
          <Path d="M12.4 35.5c0-1.8.2-3 .4-3h19.4c.2 0 .4 1.2.4 3z" {...P} />
          {[[9.6, 16.4], [17.4, 13.4], [22.5, 11.6], [27.6, 13.4], [35.4, 16.4]].map(([cx, cy], i) => <Circle key={i} cx={cx} cy={cy} r={2} {...P} />)}
          {base}
        </G>
      );
    case 'k':
    default:
      return (
        <G>
          <Path d="M13.4 33c-3.6-4.6-4.4-9.8-.3-12.4 3.4-2.1 7.2-.2 9.4 3.2 2.2-3.4 6-5.3 9.4-3.2 4.1 2.6 3.3 7.8-.3 12.4z" {...P} />
          <Path d="M22.5 23.8V16" {...P} />
          <Path d="M22.5 6.5v8M19 10h7" stroke={stroke} strokeWidth={2.2} strokeLinecap="round" fill="none" />
          <Path d="M13.2 33h18.6M13 35.5h19" {...P} />
          {base}
        </G>
      );
  }
}

/** Peça a partir do caractere do tabuleiro (maiúscula = branca). */
export const ChessPiece = memo(function ChessPiece({ ch, size }) {
  if (!ch || ch === '.') return null;
  const white = ch === ch.toUpperCase();
  return (
    <Svg width={size} height={size} viewBox="0 0 45 45">
      <ChessShape k={ch.toLowerCase()} white={white} />
    </Svg>
  );
});
