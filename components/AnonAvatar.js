// [anon-comment 2026-10-14] Avatar genérico P&B para comentário anônimo.
// Nunca usa foto/inicial/cor do autor real — só a silhueta (chapéu + óculos).
// Sem emoji (regra do app): desenho em react-native-svg.
import React, { memo } from 'react';
import { View } from 'react-native';
import Svg, { Path, Circle, Rect } from 'react-native-svg';

function AnonAvatar({ size = 32, isDark = false, style }) {
  const bg = isDark ? '#2a2a2a' : '#111111';
  const fg = isDark ? '#f2f2f2' : '#ffffff';
  return (
    <View
      style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }, style]}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      <Svg width={size * 0.66} height={size * 0.66} viewBox="0 0 24 24">
        {/* aba + copa do chapéu */}
        <Rect x="2.5" y="9" width="19" height="1.8" rx="0.9" fill={fg} />
        <Path d="M6.5 9 L8 3.8 C8.2 3.1 8.9 2.8 9.5 3.1 L12 4.2 L14.5 3.1 C15.1 2.8 15.8 3.1 16 3.8 L17.5 9 Z" fill={fg} />
        {/* óculos */}
        <Circle cx="8.2" cy="15.5" r="2.9" fill="none" stroke={fg} strokeWidth="1.7" />
        <Circle cx="15.8" cy="15.5" r="2.9" fill="none" stroke={fg} strokeWidth="1.7" />
        <Path d="M11.1 15.2 C11.7 14.6 12.3 14.6 12.9 15.2" fill="none" stroke={fg} strokeWidth="1.5" strokeLinecap="round" />
      </Svg>
    </View>
  );
}

export default memo(AnonAvatar);
