// Sheet — bottom sheet ÚNICO do design system de overlays (2026-10-12).
//
// Visual: alça 36x5, topo arredondado 20 (= sheet nativo do sistema), fundo
// elevado (#1c1c1e no escuro), backdrop 0.4 que FADE (iOS: material borrado),
// painel sobe com mola criticamente amortecida; arrastar a alça/cabeçalho p/
// baixo fecha; Android back / Esc no web = fechar; respeita safe-area inferior;
// altura máxima 90%; opcionalmente keyboard-aware (SheetKeyboardAvoider).
// Web largo (>= 768px): vira cartão centralizado (fade + escala), como
// WhatsApp Web / iOS em iPad.
//
// Uso:
//   <Sheet visible={open} onClose={() => setOpen(false)} title="Anexar">
//     <ActionList items={[...]} onDone={() => setOpen(false)} />
//   </Sheet>
//
// `native` (iOS/Android): delega ao sheet DO SISTEMA (components/NativeSheet,
// rota /native-sheet) — mesma API, o sistema desenha alça/raio/backdrop.
// Sem dependências nativas novas (Animated + PanResponder, useNativeDriver).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated, Easing, Modal, PanResponder, Platform, Pressable, ScrollView,
  StyleSheet, Text, View, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { Overlay, overlayColors, OverlayShadow } from '../../constants/theme';
import { BlurBackdrop } from '../NativeBlur';
import SheetKeyboardAvoider from '../chat/SheetKeyboardAvoider';
import { USE_NATIVE_SHEETS, NativeSheet, nativeSheetBottomPad } from '../NativeSheet';
import { isReduceMotionEnabled } from '../reducedMotion';

export function useOverlayColors() {
  const { colors, isDark } = useTheme() || {};
  return useMemo(() => overlayColors(colors, !!isDark), [colors, isDark]);
}

export function SheetHandle({ color, style }) {
  const oc = useOverlayColors();
  const h = Overlay.handle;
  return (
    <View
      style={[{
        width: h.width, height: h.height, borderRadius: h.radius, alignSelf: 'center',
        marginTop: h.marginTop, marginBottom: h.marginBottom, backgroundColor: color || oc.handle,
      }, style]}
    />
  );
}

export function SheetHeader({ title, subtitle, right, left, align = 'center', style }) {
  const oc = useOverlayColors();
  if (!title && !subtitle && !right && !left) return null;
  const centered = align === 'center';
  return (
    <View style={[{
      flexDirection: 'row', alignItems: 'center', minHeight: 44,
      paddingHorizontal: Overlay.padX, paddingBottom: 6,
    }, style]}>
      <View style={{ minWidth: centered ? 44 : 0, alignItems: 'flex-start' }}>{left || null}</View>
      <View style={{ flex: 1, alignItems: centered ? 'center' : 'flex-start' }}>
        {title ? (
          <Text numberOfLines={1} accessibilityRole="header"
            style={{ fontSize: Overlay.titleSize, fontWeight: Overlay.titleWeight, color: oc.text, letterSpacing: -0.3 }}>
            {title}
          </Text>
        ) : null}
        {subtitle ? (
          <Text numberOfLines={2}
            style={{ fontSize: Overlay.subtitleSize, color: oc.textSecondary, marginTop: 2, textAlign: centered ? 'center' : 'left' }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <View style={{ minWidth: centered ? 44 : 0, alignItems: 'flex-end' }}>{right || null}</View>
    </View>
  );
}

// Estilo de CONTAINER do sheet — p/ sheets antigos que mantêm o próprio
// <Modal>/animação mas querem o mesmo visual (raio, fundo, sombra, safe-area).
export function sheetContainerStyle(oc, insets, { wide = false } = {}) {
  return {
    backgroundColor: oc.sheetBg,
    borderTopLeftRadius: Overlay.sheetRadius,
    borderTopRightRadius: Overlay.sheetRadius,
    ...(wide ? { borderRadius: Overlay.sheetRadius } : null),
    paddingBottom: Math.max(12, ((insets && insets.bottom) || 0) + 8),
    overflow: 'hidden',
    ...(Platform.OS === 'web' ? { boxShadow: '0 -8px 40px rgba(0,0,0,0.16)' } : null),
  };
}

export default function Sheet({
  visible,
  onClose,
  title,
  subtitle,
  headerLeft,
  headerRight,
  headerAlign = 'center',
  children,
  footer,
  showHandle = true,
  dismissable = true,
  scroll = false,
  keyboardAware = false,
  maxHeightRatio = Overlay.maxHeightRatio,
  backgroundColor,
  panelStyle,
  contentStyle,
  native = false,
  detents = 'fitToContents',
  testID,
}) {
  const oc = useOverlayColors();
  const { isDark } = useTheme() || {};
  const { t } = useLanguage() || {};
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();
  const wide = Platform.OS === 'web' && winW >= 768;
  const bg = backgroundColor || oc.sheetBg;

  const [rendered, setRendered] = useState(!!visible);
  const fade = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(1)).current; // 1 = fora da tela, 0 = aberto
  const drag = useRef(new Animated.Value(0)).current;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const requestClose = useCallback(() => {
    if (!dismissable) return;
    try { onCloseRef.current && onCloseRef.current(); } catch {}
  }, [dismissable]);

  const useSystemSheet = native && USE_NATIVE_SHEETS;

  useEffect(() => {
    if (useSystemSheet) return undefined;
    let cancelled = false;
    if (visible) {
      setRendered(true);
      drag.setValue(0);
      const reduce = isReduceMotionEnabled();
      Animated.parallel([
        Animated.timing(fade, { toValue: 1, duration: Overlay.enterMs, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        reduce
          ? Animated.timing(slide, { toValue: 0, duration: 1, useNativeDriver: true })
          : Animated.spring(slide, { toValue: 0, ...Overlay.spring, useNativeDriver: true }),
      ]).start();
    } else if (rendered) {
      Animated.parallel([
        Animated.timing(fade, { toValue: 0, duration: Overlay.exitMs, easing: Easing.in(Easing.quad), useNativeDriver: true }),
        Animated.timing(slide, { toValue: 1, duration: Overlay.exitMs, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
      ]).start(() => { if (!cancelled) setRendered(false); });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, useSystemSheet]);

  // Arrastar alça/cabeçalho p/ baixo: > 96px ou flick rápido fecha.
  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => !wide && dismissable && g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderMove: (_e, g) => { drag.setValue(Math.max(0, g.dy)); },
    onPanResponderRelease: (_e, g) => {
      if (g.dy > 96 || g.vy > 0.9) { requestClose(); return; }
      Animated.spring(drag, { toValue: 0, ...Overlay.spring, useNativeDriver: true }).start();
    },
    onPanResponderTerminate: () => {
      Animated.spring(drag, { toValue: 0, ...Overlay.spring, useNativeDriver: true }).start();
    },
  }), [wide, dismissable, drag, requestClose]);

  const header = (
    <View {...pan.panHandlers}>
      {showHandle && !wide ? <SheetHandle /> : <View style={{ height: wide ? 12 : 8 }} />}
      <SheetHeader title={title} subtitle={subtitle} left={headerLeft} right={headerRight} align={headerAlign} />
    </View>
  );

  const body = scroll ? (
    <ScrollView
      style={{ flexGrow: 0 }}
      contentContainerStyle={contentStyle}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={contentStyle}>{children}</View>
  );

  if (useSystemSheet) {
    return (
      <NativeSheet visible={!!visible} onClose={onClose} detents={detents} backgroundColor={bg}>
        <View style={{ paddingTop: 14, paddingBottom: nativeSheetBottomPad(insets, 8) }} testID={testID}>
          <SheetHeader title={title} subtitle={subtitle} left={headerLeft} right={headerRight} align={headerAlign} />
          {body}
          {footer || null}
        </View>
      </NativeSheet>
    );
  }

  if (!rendered) return null;

  const offscreen = wide ? 24 : winH;
  const translateY = Animated.add(
    slide.interpolate({ inputRange: [0, 1], outputRange: [0, offscreen] }),
    drag,
  );
  const panelBase = wide
    ? {
      width: '100%', maxWidth: Overlay.sheetMaxWidth, alignSelf: 'center',
      borderRadius: Overlay.sheetRadius, maxHeight: Math.round(winH * 0.86),
      paddingBottom: 12, ...OverlayShadow,
    }
    : {
      width: '100%', maxWidth: Platform.OS === 'web' ? Overlay.sheetMaxWidth : undefined, alignSelf: 'center',
      borderTopLeftRadius: Overlay.sheetRadius, borderTopRightRadius: Overlay.sheetRadius,
      maxHeight: Math.round(winH * maxHeightRatio),
      paddingBottom: Math.max(12, (insets.bottom || 0) + 8),
    };

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={requestClose}
    >
      <View style={StyleSheet.absoluteFill} testID={testID}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: fade }]}>
          <BlurBackdrop isDark={isDark} dim={Overlay.backdrop} />
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={requestClose}
            accessibilityRole="button"
            accessibilityLabel={(t && t('common.close')) || 'Fechar'}
          />
        </Animated.View>
        <SheetKeyboardAvoider
          ios={keyboardAware}
          pointerEvents="box-none"
          style={{ flex: 1, justifyContent: wide ? 'center' : 'flex-end', paddingHorizontal: wide ? 24 : 0 }}
        >
          <Animated.View
            style={[
              panelBase,
              { backgroundColor: bg, overflow: 'hidden' },
              wide
                ? { opacity: fade, transform: [{ translateY }, { scale: fade.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) }] }
                : { transform: [{ translateY }] },
              panelStyle,
            ]}
            accessibilityViewIsModal
          >
            {header}
            {body}
            {footer || null}
          </Animated.View>
        </SheetKeyboardAvoider>
      </View>
    </Modal>
  );
}
