// components/chat/AttachInputPanel.js — [2026-10-20 attach-inputview]
//
// Android: painel de anexos NO LUGAR do teclado (WhatsApp). Mesma casca do
// painel de emoji (KeyboardPanelShell): altura = último teclado e, no UI
// thread, max(0, alvo − (teclado − padComposer)) → o IME descendo faz o painel
// crescer na mesma proporção (e vice-versa), sem buraco nem pulo. A tela só
// derruba o IME quando o painel já montou (onShown). Composer Android api 7:
// o "+" não derruba o IME e vira ícone de teclado (prop attachPanelOpen).
// No iOS o painel é nativo (inputView do composer api 10) — este arquivo não
// é usado lá. Kill switch OTA: globalThis.__chatyy_attach_inputview = false.
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { KeyboardPanelShell, getPanelKeyboardHeight } from './NativeEmojiPanelBridge';

const COLS = 4;

function Cell({ item, onPress, isDark, ink }) {
  const Icon = item.icon;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={item.label}
      style={({ pressed }) => [{ width: `${100 / COLS}%`, alignItems: 'center', paddingVertical: 10, opacity: pressed ? 0.6 : 1 }]}
    >
      <View style={{ width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', backgroundColor: isDark ? '#2c2c2e' : '#ffffff' }}>
        {Icon ? <Icon size={26} color={ink} /> : null}
      </View>
      <Text numberOfLines={1} style={{ marginTop: 7, fontSize: 13, color: ink, maxWidth: '92%' }}>{item.label}</Text>
    </Pressable>
  );
}

export default function AttachInputPanel({ visible, items, onPick, onShown, isDark, insetBottom = 0, composerPad = 0, windowHeight = 800 }) {
  const [mounted, setMounted] = useState(!!visible);
  const cbRef = useRef(onShown);
  cbRef.current = onShown;
  useEffect(() => {
    if (visible) { setMounted(true); return undefined; }
    const tm = setTimeout(() => setMounted(false), 260);
    return () => clearTimeout(tm);
  }, [visible]);
  useEffect(() => {
    if (!visible || !mounted) return undefined;
    let raf = null;
    try { raf = requestAnimationFrame(() => { raf = null; try { cbRef.current?.(); } catch {} }); } catch { try { cbRef.current?.(); } catch {} }
    return () => { if (raf != null) { try { cancelAnimationFrame(raf); } catch {} } };
  }, [visible, mounted]);
  if (!mounted || Platform.OS === 'web') return null;
  const fullHeight = getPanelKeyboardHeight(insetBottom, windowHeight);
  const bg = isDark ? '#1c1c1e' : '#ececef';
  const ink = isDark ? '#f2f2f7' : '#111111';
  return (
    <KeyboardPanelShell visible={!!visible} fullHeight={fullHeight} compactHeight={0} composerPad={composerPad} background={bg}>
      <ScrollView
        style={{ height: fullHeight }}
        contentContainerStyle={{ flexDirection: 'row', flexWrap: 'wrap', paddingTop: 14, paddingBottom: Math.max(12, insetBottom) }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
      >
        {(items || []).map((it) => (
          <Cell key={it.key} item={it} isDark={isDark} ink={ink} onPress={() => { try { onPick?.(it.key); } catch {} }} />
        ))}
      </ScrollView>
    </KeyboardPanelShell>
  );
}
