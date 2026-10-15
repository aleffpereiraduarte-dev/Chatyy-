// [2026-10-15 native-onboarding] Bandeira do país como SVG (nunca emoji na UI).
// As SVGs (constants/flagSvgs.js, ~110 KB) só são carregadas na 1a bandeira.
import React, { memo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SvgXml } from 'react-native-svg';

let _svgs;
function svgFor(code) {
  if (_svgs === undefined) {
    try {
      // eslint-disable-next-line global-require
      const m = require('../../constants/flagSvgs');
      _svgs = m.FLAG_SVGS || m.default || null;
    } catch { _svgs = null; }
  }
  return _svgs ? _svgs[String(code || '').toUpperCase()] : null;
}

function FlagIcon({ code, width = 28, borderColor = 'rgba(0,0,0,0.12)', textColor = '#111' }) {
  const height = Math.round((width * 2) / 3);
  const xml = svgFor(code);
  return (
    <View
      style={[st.box, { width, height, borderRadius: Math.max(3, Math.round(width / 9)), borderColor }]}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      {xml ? (
        <SvgXml xml={xml} width={width} height={height} preserveAspectRatio="xMidYMid slice" />
      ) : (
        <Text style={[st.iso, { color: textColor, fontSize: Math.max(8, Math.round(width / 3)) }]}>{String(code || '').toUpperCase()}</Text>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  box: { overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  iso: { fontWeight: '800', letterSpacing: 0.4 },
});

export default memo(FlagIcon);
