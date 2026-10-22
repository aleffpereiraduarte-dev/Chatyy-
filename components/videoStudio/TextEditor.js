// [2026-10-13 video-studio] Editor de texto (tela cheia sobre a prévia):
// fonte, cor, fundo (nenhum / caixa / contorno), alinhamento.
import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, Modal, StyleSheet, TouchableOpacity, ScrollView, Platform } from 'react-native';
import KeyboardSafeView from '../ui/KeyboardSafeView'; // [2026-10-22 kb-uniforme]
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Rect } from 'react-native-svg';
import { fontStyleFor, contrastOn } from './OverlayLayer';

export const FONTS = [
  { id: 'classic', labelKey: 'studio.text.fontClassic' },
  { id: 'modern', labelKey: 'studio.text.fontModern' },
  { id: 'serif', labelKey: 'studio.text.fontSerif' },
  { id: 'mono', labelKey: 'studio.text.fontMono' },
  { id: 'strong', labelKey: 'studio.text.fontStrong' },
];
export const PALETTE = ['#FFFFFF', '#000000', '#9CA3AF', '#EF4444', '#F97316', '#FACC15', '#22C55E', '#14B8A6', '#3B82F6', '#8B5CF6', '#EC4899'];
const BGS = ['none', 'box', 'outline'];
const ALIGNS = ['center', 'left', 'right'];

function BgIcon({ bg, color = '#fff' }) {
  if (bg === 'box') return <Svg width={22} height={22} viewBox="0 0 24 24"><Rect x={3} y={5} width={18} height={14} rx={3} fill={color} /><Path d="M8 15l4-8 4 8M9.5 12h5" stroke="#000" strokeWidth={1.8} fill="none" strokeLinecap="round" /></Svg>;
  if (bg === 'outline') return <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><Path d="M6 19l6-14 6 14M8.5 13h7" /><Path d="M4 19l6.5-15h3L20 19" strokeWidth={0.9} /></Svg>;
  return <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round"><Path d="M6 19l6-14 6 14M8.5 13h7" /></Svg>;
}
function AlignIcon({ align, color = '#fff' }) {
  const d = align === 'left' ? 'M4 6h16M4 10h10M4 14h16M4 18h10' : align === 'right' ? 'M4 6h16M10 10h10M4 14h16M10 18h10' : 'M4 6h16M7 10h10M4 14h16M7 18h10';
  return <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round"><Path d={d} /></Svg>;
}

export default function TextEditor({ visible, initial, onDone, onCancel, t }) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [style, setStyle] = useState({ font: 'classic', color: '#FFFFFF', bg: 'none', align: 'center' });
  useEffect(() => {
    if (!visible) return;
    setText(initial?.text || '');
    setStyle({ font: 'classic', color: '#FFFFFF', bg: 'none', align: 'center', ...(initial?.style || {}) });
  }, [visible, initial]);

  const fs = 30;
  const boxed = style.bg === 'box';
  const inputStyle = [
    fontStyleFor(style.font),
    { fontSize: fs, lineHeight: fs * 1.2, textAlign: style.align, color: boxed ? contrastOn(style.color) : style.color },
    boxed ? { backgroundColor: style.color, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 4 } : null,
    style.bg === 'outline' ? { textShadowColor: contrastOn(style.color), textShadowRadius: 3, textShadowOffset: { width: 0, height: 0 } } : null,
  ];
  const cycle = (arr, v) => arr[(arr.indexOf(v) + 1) % arr.length];

  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <KeyboardSafeView style={[styles.root, { paddingTop: insets.top + 6 }]}>
        <View style={styles.top}>
          <TouchableOpacity onPress={onCancel} hitSlop={10} accessibilityRole="button"><Text style={styles.topTxt}>{t('common.cancel')}</Text></TouchableOpacity>
          <View style={styles.topMid}>
            <TouchableOpacity onPress={() => setStyle((s) => ({ ...s, bg: cycle(BGS, s.bg) }))} style={styles.roundBtn} accessibilityRole="button" accessibilityLabel={t('studio.text.background')}>
              <BgIcon bg={style.bg} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setStyle((s) => ({ ...s, align: cycle(ALIGNS, s.align) }))} style={styles.roundBtn} accessibilityRole="button" accessibilityLabel={t('studio.text.align')}>
              <AlignIcon align={style.align} />
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={() => onDone({ text: text.trim(), style })} hitSlop={10} accessibilityRole="button"><Text style={[styles.topTxt, { fontWeight: '800' }]}>{t('studio.done')}</Text></TouchableOpacity>
        </View>
        <View style={styles.center}>
          <TextInput
            value={text}
            onChangeText={setText}
            autoFocus
            multiline
            placeholder={t('studio.text.placeholder')}
            placeholderTextColor="rgba(255,255,255,0.45)"
            style={[styles.input, ...inputStyle]}
            maxLength={300}
            selectionColor="#fff"
          />
        </View>
        <View style={[styles.bottom, { paddingBottom: 10 }]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} keyboardShouldPersistTaps="always">
            {PALETTE.map((c) => (
              <TouchableOpacity key={c} onPress={() => setStyle((s) => ({ ...s, color: c }))} style={[styles.swatch, { backgroundColor: c }, style.color === c && styles.swatchOn]} accessibilityRole="button" accessibilityLabel={c} />
            ))}
          </ScrollView>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} keyboardShouldPersistTaps="always">
            {FONTS.map((f) => {
              const on = style.font === f.id;
              return (
                <TouchableOpacity key={f.id} onPress={() => setStyle((s) => ({ ...s, font: f.id }))} style={[styles.font, on && styles.fontOn]} accessibilityRole="button">
                  <Text style={[fontStyleFor(f.id), { fontSize: 13, color: on ? '#000' : '#fff' }]}>{t(f.labelKey)}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      </KeyboardSafeView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)' },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, height: 48 },
  topMid: { flexDirection: 'row', gap: 10 },
  topTxt: { color: '#fff', fontSize: 16 },
  roundBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' },
  center: { flex: 1, justifyContent: 'center', paddingHorizontal: 20 },
  input: { minHeight: 60, maxHeight: 260, alignSelf: 'stretch' },
  bottom: { gap: 10 },
  row: { paddingHorizontal: 14, gap: 10, alignItems: 'center' },
  swatch: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: 'rgba(255,255,255,0.5)' },
  swatchOn: { borderColor: '#fff', transform: [{ scale: 1.18 }] },
  font: { height: 34, paddingHorizontal: 14, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' },
  fontOn: { backgroundColor: '#fff' },
});
