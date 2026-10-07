// [2026-10-07 native-ui-build] Blur NATIVO (expo-blur → UIVisualEffectView)
// só no iOS. Android fica SÓLIDO (RenderEffect/dimezisBlur custa GPU em
// aparelho fraco e a Material não usa vidro); web também sólido.
//
// GUARDA DE BINÁRIO: expo-blur entrou no build nativo de 2026-10-07. Um OTA
// deste código num binário 2.6.0 ANTIGO (sem o módulo) não pode chamar
// requireNativeViewManager('ExpoBlur') — então checamos o módulo nativo
// ANTES do require (requireOptionalNativeModule nunca lança) e caímos no
// fundo sólido quando ele não existe.
import React from 'react';
import { Platform, View, StyleSheet } from 'react-native';

let _BlurView; // undefined = não resolvido; null = indisponível
export function getNativeBlurView() {
  if (_BlurView !== undefined) return _BlurView;
  _BlurView = null;
  if (Platform.OS !== 'ios') return null;
  try {
    const core = require('expo-modules-core');
    const has = !!(core.requireOptionalNativeModule && core.requireOptionalNativeModule('ExpoBlur'))
      || !!globalThis?.expo?.modules?.ExpoBlur;
    if (has) _BlurView = require('expo-blur').BlurView || null;
  } catch { _BlurView = null; }
  return _BlurView;
}

// true quando dá p/ usar blur de verdade (iOS + módulo no binário).
export function canNativeBlur() { return !!getNativeBlurView(); }

// Backdrop de menu/sheet: iOS = material borrado + leve escurecida;
// demais = rgba sólido (o mesmo de antes). Preenche o pai (absoluteFill).
// `dim` é a escurecida do fallback sólido; no iOS usamos ~metade porque o
// blur já separa o primeiro plano.
export function BlurBackdrop({ isDark, dim = 0.4, intensity = 30, style, children, pointerEvents }) {
  const BlurView = getNativeBlurView();
  if (BlurView) {
    return (
      <BlurView
        intensity={intensity}
        tint={isDark ? 'systemThinMaterialDark' : 'systemUltraThinMaterialDark'}
        style={[StyleSheet.absoluteFillObject, style]}
        pointerEvents={pointerEvents}
      >
        <View style={[StyleSheet.absoluteFillObject, { backgroundColor: `rgba(0,0,0,${Math.max(0, dim * 0.45).toFixed(2)})` }]} pointerEvents="none" />
        {children}
      </BlurView>
    );
  }
  return (
    <View style={[StyleSheet.absoluteFillObject, { backgroundColor: `rgba(0,0,0,${dim})` }, style]} pointerEvents={pointerEvents}>
      {children}
    </View>
  );
}

// Fundo de barra (tab bar / toolbar): iOS = material translúcido do sistema
// (claro/escuro), demais = cor sólida passada em `solidColor`.
export function BarMaterial({ isDark, solidColor, style, intensity = 80 }) {
  const BlurView = getNativeBlurView();
  if (BlurView) {
    return (
      <BlurView
        intensity={intensity}
        tint={isDark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
        style={[StyleSheet.absoluteFillObject, style]}
        pointerEvents="none"
      />
    );
  }
  return <View style={[StyleSheet.absoluteFillObject, { backgroundColor: solidColor }, style]} pointerEvents="none" />;
}
