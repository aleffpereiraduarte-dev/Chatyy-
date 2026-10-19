// components/games/GameIcons.js — [jogos 2026-10-18] glifos SVG dos jogos (traço 24×24, mesmo
// estilo do components/Icons.js). Também funcionam como nós nativos (nativeNodes.icon()).
import React from 'react';
import Svg, { Path, Circle, Rect, Line } from 'react-native-svg';

function S({ size = 24, color = '#111', children, fill = 'none', strokeWidth = 1.9 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </Svg>
  );
}

export function IconGamepad(p) {
  return (
    <S {...p}>
      <Path d="M6.5 7h11a4.5 4.5 0 0 1 4.4 5.4l-1 4.7a2.5 2.5 0 0 1-4.3 1.2L14.4 16H9.6l-2.2 2.3a2.5 2.5 0 0 1-4.3-1.2l-1-4.7A4.5 4.5 0 0 1 6.5 7z" />
      <Line x1="7.5" y1="10.2" x2="7.5" y2="13.8" />
      <Line x1="5.7" y1="12" x2="9.3" y2="12" />
      <Circle cx="16" cy="10.8" r="0.9" />
      <Circle cx="17.6" cy="13.2" r="0.9" />
    </S>
  );
}
export function IconGameDamas(p) {
  return (
    <S {...p}>
      <Circle cx="12" cy="12" r="8.5" />
      <Circle cx="12" cy="12" r="5" />
      <Circle cx="12" cy="12" r="1.4" />
    </S>
  );
}
export function IconGameVelha(p) {
  return (
    <S {...p}>
      <Line x1="9" y1="3.5" x2="9" y2="20.5" />
      <Line x1="15" y1="3.5" x2="15" y2="20.5" />
      <Line x1="3.5" y1="9" x2="20.5" y2="9" />
      <Line x1="3.5" y1="15" x2="20.5" y2="15" />
      <Path d="M4.8 4.8l2.4 2.4M7.2 4.8L4.8 7.2" />
      <Circle cx="18" cy="18" r="1.6" />
    </S>
  );
}
export function IconGameCartas(p) {
  return (
    <S {...p}>
      <Path d="M10 6.2H6a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h6.5a2 2 0 0 0 2-2v-.5" />
      <Rect x="9.5" y="3" width="10.5" height="14.5" rx="2" />
      <Circle cx="14.75" cy="10.25" r="2.3" />
    </S>
  );
}
export function IconGameQuiz(p) {
  return (
    <S {...p}>
      <Circle cx="12" cy="12" r="9" />
      <Path d="M9.4 9.3a2.7 2.7 0 1 1 3.9 2.4c-.8.4-1.3 1-1.3 1.9v.5" />
      <Circle cx="12" cy="16.9" r="0.6" />
    </S>
  );
}
export function IconGameForca(p) {
  return (
    <S {...p}>
      <Path d="M3.5 21h9" />
      <Path d="M6.5 21V3.5h8.5v2.8" />
      <Path d="M6.5 7.5l3.5-4" />
      <Circle cx="15" cy="8.6" r="2.2" />
      <Path d="M15 10.8v4.6M15 12.3l-2.2 1.8M15 12.3l2.2 1.8M15 15.4l-1.8 3M15 15.4l1.8 3" />
    </S>
  );
}
export function IconTrophy(p) {
  return (
    <S {...p}>
      <Path d="M8 4h8v5a4 4 0 0 1-8 0V4z" />
      <Path d="M8 6H5a2.5 2.5 0 0 0 3 4" />
      <Path d="M16 6h3a2.5 2.5 0 0 1-3 4" />
      <Path d="M12 13v3.5" />
      <Path d="M8.5 20h7l-.8-3.5H9.3z" />
    </S>
  );
}
export function IconCrown(p) {
  return (
    <S {...p}>
      <Path d="M4 17.5l-1-9 5 4 4-7 4 7 5-4-1 9z" />
      <Line x1="4.5" y1="20.5" x2="19.5" y2="20.5" />
    </S>
  );
}
export function IconRematch(p) {
  return (
    <S {...p}>
      <Path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.7" />
      <Path d="M20 4v4.7h-4.7" />
      <Path d="M20 12a8 8 0 0 1-13.7 5.6L4 15.3" />
      <Path d="M4 20v-4.7h4.7" />
    </S>
  );
}
export function IconFlagResign(p) {
  return (
    <S {...p}>
      <Path d="M5 21V4" />
      <Path d="M5 4h11l-2 4 2 4H5" />
    </S>
  );
}
export function IconPodium(p) {
  return (
    <S {...p}>
      <Rect x="9" y="7" width="6" height="14" rx="1" />
      <Rect x="3" y="11" width="6" height="10" rx="1" />
      <Rect x="15" y="14" width="6" height="7" rx="1" />
    </S>
  );
}
export function IconEye(p) {
  return (
    <S {...p}>
      <Path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
      <Circle cx="12" cy="12" r="2.8" />
    </S>
  );
}
export function IconClockSmall(p) {
  return (
    <S {...p}>
      <Circle cx="12" cy="12" r="8.5" />
      <Path d="M12 7.5V12l3 2" />
    </S>
  );
}

// [jogos 2026-10-19] empate combinado (dois discos iguais com "="), mais opções, cancelar/expirado
export function IconDrawOffer(p) {
  return (
    <S {...p}>
      <Circle cx="8" cy="12" r="5" />
      <Circle cx="16" cy="12" r="5" />
      <Line x1="10.6" y1="10.6" x2="13.4" y2="10.6" />
      <Line x1="10.6" y1="13.4" x2="13.4" y2="13.4" />
    </S>
  );
}
export function IconMore(p) {
  return (
    <S {...p}>
      <Circle cx="5.5" cy="12" r="1.2" />
      <Circle cx="12" cy="12" r="1.2" />
      <Circle cx="18.5" cy="12" r="1.2" />
    </S>
  );
}
export function IconBan(p) {
  return (
    <S {...p}>
      <Circle cx="12" cy="12" r="8.5" />
      <Line x1="6.2" y1="17.8" x2="17.8" y2="6.2" />
    </S>
  );
}
export function IconHourglass(p) {
  return (
    <S {...p}>
      <Path d="M7 3.5h10M7 20.5h10" />
      <Path d="M8 3.5c0 4.5 4 5.5 4 8.5s-4 4-4 8.5M16 3.5c0 4.5-4 5.5-4 8.5s4 4 4 8.5" />
    </S>
  );
}

export function GameTypeIcon({ type, ...p }) {
  switch (type) {
    case 'damas': return <IconGameDamas {...p} />;
    case 'velha': return <IconGameVelha {...p} />;
    case 'cartas': return <IconGameCartas {...p} />;
    case 'quiz': return <IconGameQuiz {...p} />;
    case 'forca': return <IconGameForca {...p} />;
    default: return <IconGamepad {...p} />;
  }
}
export function gameTypeIconComp(type) {
  return { damas: IconGameDamas, velha: IconGameVelha, cartas: IconGameCartas, quiz: IconGameQuiz, forca: IconGameForca }[type] || IconGamepad;
}
