// [2026-10-18 bia-orb-icon] Ícone ESTÁTICO da Bia = o ORB (esfera preta
// brilhante), no lugar da "estrelinha" (IconSparkles) que o founder achou feia.
//
// Drop-in de ícone: mesma assinatura dos components/Icons ({ size, color, style })
// → serve em <SettingsRow icon={BiaIcon}>, <SettingsIconTile Icon={BiaIcon}>,
// listas `ic: I(BiaIcon)` e no lugar de <IconSparkles size color />.
//   • Sem `color` (ou cor escura) → esfera PRETA (identidade da Bia), com aro
//     claro sutil p/ não sumir em fundo escuro.
//   • `color` clara (ex.: '#fff' em botão preto, colors.text no tema escuro) →
//     esfera CLARA (mesmo desenho invertido), legível em fundo escuro.
//   • ≤ 18 px → círculo sólido + 1 brilho (lê bem em 12–18 px); maior → esfera
//     com gradiente radial, reflexo especular e borda de luz.
// O orb animado (Skia) continua em components/bia/BiaOrb.js (telas da Bia).
import React, { memo, useRef } from 'react';
import { View } from 'react-native';
import Svg, { Defs, RadialGradient, Stop, Circle, Ellipse } from 'react-native-svg';

let _seq = 0;

// Luminância relativa aproximada (0 escuro … 1 claro). Desconhecida → -1.
function _lum(color) {
  if (!color || typeof color !== 'string') return -1;
  const c = color.trim().toLowerCase();
  if (c === 'white') return 1;
  if (c === 'black') return 0;
  let r; let g; let b;
  let m = /^#([0-9a-f]{3,8})$/.exec(c);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      r = parseInt(h[0] + h[0], 16); g = parseInt(h[1] + h[1], 16); b = parseInt(h[2] + h[2], 16);
    } else if (h.length === 6 || h.length === 8) {
      r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
    } else return -1;
  } else {
    m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(c);
    if (!m) return -1;
    r = +m[1]; g = +m[2]; b = +m[3];
  }
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function biaIconIsLight(color) { return _lum(color) > 0.6; }

function BiaIcon({ size = 24, color, style, light }) {
  const idRef = useRef(null);
  if (idRef.current == null) idRef.current = `bic${_seq++}`;
  const id = idRef.current;
  const s = Math.max(8, Number(size) || 24);
  const r = s / 2;
  const isLight = light != null ? !!light : biaIconIsLight(color);
  const small = s <= 18;

  // Paleta P&B: esfera preta (padrão) ou clara (sobre fundo escuro).
  const base = isLight
    ? ['#FFFFFF', '#E6E6EA', '#A7A7AE']
    : ['#55555C', '#1A1A1E', '#030304'];
  const rim = isLight ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.16)';
  const hiOpacity = isLight ? 1 : 0.85;

  return (
    <View
      style={[{ width: s, height: s }, style]}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Svg width={s} height={s} viewBox={`0 0 ${s} ${s}`}>
        {small ? (
          <>
            <Circle cx={r} cy={r} r={r - 0.25} fill={isLight ? '#F2F2F4' : '#111113'} />
            <Ellipse cx={r * 0.7} cy={r * 0.62} rx={r * 0.3} ry={r * 0.22} fill="#FFFFFF" opacity={isLight ? 0.95 : 0.7} />
            <Circle cx={r} cy={r} r={r - 0.5} fill="none" stroke={rim} strokeWidth={0.75} />
          </>
        ) : (
          <>
            <Defs>
              <RadialGradient id={`${id}b`} cx="38%" cy="32%" r="72%" fx="38%" fy="32%">
                <Stop offset="0" stopColor={base[0]} />
                <Stop offset="0.55" stopColor={base[1]} />
                <Stop offset="1" stopColor={base[2]} />
              </RadialGradient>
              <RadialGradient id={`${id}h`} cx="50%" cy="50%" r="50%">
                <Stop offset="0" stopColor="#FFFFFF" stopOpacity={hiOpacity} />
                <Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
              </RadialGradient>
              <RadialGradient id={`${id}l`} cx="50%" cy="50%" r="50%">
                <Stop offset="0" stopColor="#FFFFFF" stopOpacity={isLight ? 0 : 0.22} />
                <Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
              </RadialGradient>
            </Defs>
            <Circle cx={r} cy={r} r={r - 0.5} fill={`url(#${id}b)`} />
            {/* luz refletida embaixo (volume) */}
            <Ellipse cx={r * 1.12} cy={r * 1.52} rx={r * 0.52} ry={r * 0.24} fill={`url(#${id}l)`} />
            {/* reflexo especular suave em cima à esquerda */}
            <Ellipse cx={r * 0.72} cy={r * 0.6} rx={r * 0.42} ry={r * 0.3} fill={`url(#${id}h)`} />
            <Circle cx={r} cy={r} r={r - 0.6} fill="none" stroke={rim} strokeWidth={Math.max(0.75, s / 48)} />
          </>
        )}
      </Svg>
    </View>
  );
}

const BiaIconMemo = memo(BiaIcon);
// SettingsIconTile: o orb ocupa o ladrilho inteiro (sem fundo/chip atrás).
BiaIconMemo.__fillsTile = true;
BiaIconMemo.displayName = 'BiaIcon';
export default BiaIconMemo;
export { BiaIconMemo as BiaIcon };
