// [verificado 2026-10-24] Selo azul de conta verificada (roseta + check, estilo Instagram). SVG, sem emoji.
// <VerifiedBadge email="x@y" />  → só aparece se a conta estiver na lista de selos (services/verification).
// <VerifiedBadge verified />     → força (ex.: a própria conta pelo verif_status).
import React from 'react';
import { View } from 'react-native';
import Svg, { Path, Polyline } from 'react-native-svg';
import { useIsVerified } from '../services/verification';
import { useLanguage } from '../context/LanguageContext';

export const VERIFIED_BLUE = '#0095F6';

// Roseta de 12 pontas (calculada uma vez).
const ROSETTE = (() => {
  const n = 12, cx = 12, cy = 12, rO = 11.2, rI = 9.6;
  let d = '';
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? rO : rI;
    const a = (Math.PI * i) / n - Math.PI / 2;
    const x = (cx + r * Math.cos(a)).toFixed(2), y = (cy + r * Math.sin(a)).toFixed(2);
    d += (i === 0 ? 'M' : 'L') + x + ' ' + y + ' ';
  }
  return d + 'Z';
})();

export const VerifiedGlyph = React.memo(function VerifiedGlyph({ size = 14, color = VERIFIED_BLUE, checkColor = '#ffffff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={ROSETTE} fill={color} stroke={color} strokeWidth={1.4} strokeLinejoin="round" />
      <Polyline points="7.6 12.4 10.6 15.3 16.4 9.3" fill="none" stroke={checkColor} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
});

// Ícone de linha p/ SettingsRow (recebe size/color como os outros ícones).
export function IconVerifiedOutline({ size = 22, color = '#000' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={ROSETTE} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" />
      <Polyline points="7.8 12.4 10.6 15.1 16.2 9.5" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function VerifiedBadgeInner({ size, style, color }) {
  const { t } = useLanguage();
  const label = t('verif.badgeA11y');
  return (
    <View
      style={[{ marginLeft: Math.max(3, Math.round(size * 0.28)) }, style]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={label && label !== 'verif.badgeA11y' ? label : 'Verified'}
    >
      <VerifiedGlyph size={size} color={color} />
    </View>
  );
}

const ByEmail = React.memo(function ByEmail({ email, size, style, color }) {
  const v = useIsVerified(email);
  return v ? <VerifiedBadgeInner size={size} style={style} color={color} /> : null;
});

export default function VerifiedBadge({ email, verified, size = 14, style, color = VERIFIED_BLUE }) {
  if (verified === true) return <VerifiedBadgeInner size={size} style={style} color={color} />;
  if (!email) return null;
  return <ByEmail email={email} size={size} style={style} color={color} />;
}
