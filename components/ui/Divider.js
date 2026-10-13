// Divider — separador hairline do tema.
//   <Divider />                 // full width
//   <Divider inset={68} />      // alinhado ao texto (após avatar/ícone)
//   <Divider vertical style={{height:20}} />
//   <Divider spacing={8} />     // margem vertical (ou horizontal se vertical)
import React from 'react';
import { StyleSheet, View } from 'react-native';
import useSurface from './useSurface';

export default function Divider({ inset = 0, insetRight = 0, vertical = false, spacing = 0, color, style }) {
  const s = useSurface();
  const c = color || s.separator;
  if (vertical) {
    return <View style={[{ width: StyleSheet.hairlineWidth, alignSelf: 'stretch', backgroundColor: c, marginHorizontal: spacing }, style]} />;
  }
  return <View style={[{ height: StyleSheet.hairlineWidth, backgroundColor: c, marginLeft: inset, marginRight: insetRight, marginVertical: spacing }, style]} />;
}
