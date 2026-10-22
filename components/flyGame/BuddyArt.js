// components/flyGame/BuddyArt.js — [voar 2026-10-22] a "Bolhinha" do Brisa em SVG (mesmos caminhos do
// renderer.js): capa da grade de jogos, ícone do cartão, cartão de compartilhar e telas. Nunca emoji.
import React from 'react';
import Svg, { G, Path, Circle, Rect, Defs, LinearGradient, Stop } from 'react-native-svg';
import { BODY_D, BELLY_D, WING_D, PAL } from '../../services/flyGame/renderer';

/** Só o personagem, centrado num viewBox 80×80. */
export function Buddy({ size = 48, tilt = -12, wing = 0.6 }) {
  const wa = -35 * wing + 18 * (1 - wing);
  return (
    <Svg width={size} height={size} viewBox="-40 -40 80 80">
      <G rotation={tilt}>
        <G x={-4} y={2} rotation={wa * 0.7 + 10} scale={0.8}><Path d={WING_D} fill={PAL.wingDark} /></G>
        <Path d={BODY_D} fill={PAL.body} />
        <Path d={BELLY_D} fill={PAL.bodyShade} />
        <Circle cx={-8} cy={-12} r={7} fill="rgba(255,255,255,0.75)" />
        <Circle cx={14} cy={6} r={5} fill={PAL.blush} />
        <Circle cx={9} cy={-6} r={4.6} fill={PAL.eye} />
        <Circle cx={10.6} cy={-7.8} r={1.5} fill="#FFFFFF" />
        <Circle cx={-8} cy={12} r={2.3} fill={PAL.dots} />
        <Circle cx={-1} cy={11} r={2.3} fill={PAL.dots} />
        <Circle cx={6} cy={12} r={2.3} fill={PAL.dots} />
        <G x={-2} y={4} rotation={wa}><Path d={WING_D} fill={PAL.wing} /></G>
      </G>
    </Svg>
  );
}

/** Capa 70×70 da grade "Jogar agora": céu, coluna, personagem. */
export function FlyCover({ size = 70 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 70 70">
      <Defs>
        <LinearGradient id="flyc" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={PAL.sky0} /><Stop offset="1" stopColor={PAL.sky3} />
        </LinearGradient>
      </Defs>
      <Rect x={3} y={3} width={64} height={64} rx={14} fill="url(#flyc)" />
      <Circle cx={53} cy={16} r={5} fill={PAL.moon} />
      <Rect x={44} y={3} width={13} height={18} rx={3} fill={PAL.pipeCap} />
      <Rect x={45} y={19} width={11} height={2} fill={PAL.pipeEdge} />
      <Rect x={44} y={44} width={13} height={23} rx={3} fill={PAL.pipeCap} />
      <Rect x={45} y={44} width={11} height={2} fill={PAL.pipeEdge} />
      <Rect x={3} y={60} width={64} height={7} fill={PAL.ground} />
      <G x={24} y={34} scale={0.62}>
        <G x={-4} y={2} rotation={-6}><Path d={WING_D} fill={PAL.wingDark} /></G>
        <Path d={BODY_D} fill={PAL.body} />
        <Circle cx={9} cy={-6} r={4.6} fill={PAL.eye} />
        <Circle cx={-8} cy={12} r={2.3} fill={PAL.dots} /><Circle cx={-1} cy={11} r={2.3} fill={PAL.dots} /><Circle cx={6} cy={12} r={2.3} fill={PAL.dots} />
        <G x={-2} y={4} rotation={-30}><Path d={WING_D} fill={PAL.wing} /></G>
      </G>
    </Svg>
  );
}

/** Ícone pequeno (cartão do jogo na conversa) — silhueta monocromática na cor pedida. */
export function IconFly({ size = 16, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="-30 -30 60 60">
      <Path d={BODY_D} fill={color} />
      <G x={-2} y={4} rotation={-28}><Path d={WING_D} fill={color} opacity={0.55} /></G>
    </Svg>
  );
}

export default Buddy;
