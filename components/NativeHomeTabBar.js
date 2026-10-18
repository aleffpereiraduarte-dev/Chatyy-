// [2026-10-15 native-tabs] Ponte JS da barra de abas NATIVA da home
// (modules/expo-native-tabbar: UITabBar no iOS / barra M3 em Views no Android).
//
// - Só iOS/Android. Web e binário sem o módulo → nativeTabsAvailable() false e
//   app/chat.js usa a barra JS (TabBarItem) exatamente como antes.
// - Kill switch (OTA/console): globalThis.__chatyy_native_tabs = false.
// - A view só desenha e entrega toques; o que cada aba faz continua no chat.js
//   (handleTabPress / requestNewStatus). Haptic e bounce saem do nativo.
import React, { useCallback, useMemo, useState } from 'react';
import { Platform, processColor } from 'react-native';

let _mod; // undefined = não resolvido; null = indisponível
function nativeMod() {
  if (_mod !== undefined) return _mod;
  _mod = null;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try { _mod = require('../modules/expo-native-tabbar'); } catch { _mod = null; }
  return _mod;
}

export function nativeTabsAvailable() {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return false;
  try { if (globalThis.__chatyy_native_tabs === false) return false; } catch {}
  const m = nativeMod();
  try { return !!(m && m.isAvailable && m.isAvailable()); } catch { return false; }
}

// [2026-10-18 you-tab] Versão do módulo nativo (0 = sem módulo / desconhecida).
// Android api 2+ desenha o ícone "you" (aba Você); antes disso o chat.js usa a barra JS.
export function nativeTabsApi() {
  const m = nativeMod();
  try { return Number(m && m.apiVersion ? m.apiVersion() : 0) || 0; } catch { return 0; }
}

// Altura do conteúdo (sem a área do home indicator / gestos):
// iOS = UITabBar 49 pt; Android = mesma altura da barra JS (10 + 56).
const CONTENT_H = Platform.OS === 'ios' ? 49 : 66;

function color(c) {
  if (c == null) return null;
  try { const v = processColor(c); return typeof v === 'number' ? v : null; } catch { return null; }
}

export default function NativeHomeTabBar({
  items, selectedKey, isDark, translucent, bottomInset = 0,
  activeColor, inactiveColor, backgroundColor, hairlineColor,
  onTabPress, onTabLongPress, style, onLayout,
}) {
  const NativeView = nativeMod()?.getNativeTabBarView?.() || null;
  const [prefH, setPrefH] = useState(0);

  const theme = useMemo(() => ({
    dark: !!isDark,
    active: color(activeColor),
    inactive: color(inactiveColor),
    background: color(backgroundColor),
    hairline: color(hairlineColor),
    // Badge P&B invertido (igual ao PulseBadge JS).
    badgeBackground: color(activeColor),
    badgeText: color(isDark ? '#0b0b0b' : '#ffffff'),
    pill: color(isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.07)'),
    ripple: color(isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)'),
  }), [isDark, activeColor, inactiveColor, backgroundColor, hairlineColor]);

  const handlePress = useCallback((e) => {
    const key = e?.nativeEvent?.key;
    if (key && onTabPress) onTabPress(key);
  }, [onTabPress]);
  const handleLongPress = useCallback((e) => {
    const key = e?.nativeEvent?.key;
    if (key && onTabLongPress) onTabLongPress(key);
  }, [onTabLongPress]);
  const handlePreferredHeight = useCallback((e) => {
    const h = Number(e?.nativeEvent?.height) || 0;
    if (h >= 40 && h <= 160) setPrefH((prev) => (Math.abs(prev - h) < 0.5 ? prev : h));
  }, []);

  if (!NativeView) return null;
  // Android: mesmo respiro da barra JS (mín. 12 dp acima da barra de gestos).
  const inset = Platform.OS === 'android' ? Math.max(bottomInset, 12) : bottomInset;
  const height = Platform.OS === 'ios' && prefH > 0 ? prefH : CONTENT_H + inset;
  return (
    <NativeView
      style={[{ height, alignSelf: 'stretch' }, style]}
      items={items}
      selectedKey={selectedKey || null}
      theme={theme}
      translucent={!!translucent}
      bottomInset={inset}
      bounce
      onTabPress={handlePress}
      onTabLongPress={handleLongPress}
      onPreferredHeight={handlePreferredHeight}
      onLayout={onLayout}
    />
  );
}
