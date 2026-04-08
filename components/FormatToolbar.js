import React from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';

const BUTTONS = [
  { label: 'B',     marker: '*',  style: { fontWeight: '700' } },
  { label: 'I',     marker: '_',  style: { fontStyle: 'italic' } },
  { label: 'S',     marker: '~',  style: { textDecorationLine: 'line-through' } },
  { label: '</>',   marker: '`',  style: { fontFamily: 'monospace', fontSize: 12 } },
  { label: '◼',     marker: '||', style: { fontWeight: '700', color: '#a78bfa' }, tooltip: 'Spoiler' },
  { label: '⌨',     marker: '```', style: { fontFamily: 'monospace', fontSize: 11 }, tooltip: 'Code block' },
];

export default function FormatToolbar({ text, setText, selection, colors }) {
  const wrapSelection = (marker) => {
    const start = selection?.start ?? text.length;
    const end = selection?.end ?? text.length;
    if (start === end) {
      const newText = text.slice(0, start) + marker + marker + text.slice(start);
      setText(newText);
    } else {
      const selected = text.slice(start, end);
      const newText = text.slice(0, start) + marker + selected + marker + text.slice(end);
      setText(newText);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
      {BUTTONS.map(b => (
        <TouchableOpacity
          key={b.label}
          onPress={() => wrapSelection(b.marker)}
          style={[styles.btn, { backgroundColor: colors.background }]}
          activeOpacity={0.6}
          accessibilityLabel={b.tooltip || b.label}
        >
          <Text style={[styles.btnText, { color: colors.text }, b.style]}>{b.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 6,
    gap: 8, borderTopWidth: 1,
  },
  btn: {
    width: 36, height: 32, borderRadius: 6,
    alignItems: 'center', justifyContent: 'center',
  },
  btnText: { fontSize: 15 },
});
