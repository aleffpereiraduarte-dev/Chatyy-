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
// [2026-10-16 motion] Molas/durações/limiares = constants/motion (Springs.sheet,
// Durations.enter/exit, Gestures.sheetDismiss*). Prop `dragAnywhere` (padrão
// true) — painel inteiro arrasta quando `scroll` é false.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated, Keyboard, Modal, PanResponder, Platform, Pressable, ScrollView,
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
import { Springs, Durations, Easings, Gestures, motionEnabled } from '../../constants/motion';

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
  // [2026-10-16 motion] false = só alça/cabeçalho arrastam (corpo com gesto próprio).
  dragAnywhere = true,
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
  const visibleRef = useRef(!!visible);
  visibleRef.current = !!visible;
  // Altura real do painel (onLayout) — fundo esmaece proporcional ao arrasto.
  const [panelH, setPanelH] = useState(0);

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
      const reduce = isReduceMotionEnabled() || !motionEnabled();
      Animated.parallel([
        Animated.timing(fade, { toValue: 1, duration: Durations.enter, easing: Easings.fadeIn, useNativeDriver: true }),
        reduce
          ? Animated.timing(slide, { toValue: 0, duration: 1, useNativeDriver: true })
          : Animated.spring(slide, { toValue: 0, ...Springs.sheet, useNativeDriver: true }),
      ]).start();
    } else if (rendered) {
      Animated.parallel([
        Animated.timing(fade, { toValue: 0, duration: Durations.exit, easing: Easings.fadeOut, useNativeDriver: true }),
        Animated.timing(slide, { toValue: 1, duration: Durations.exit, easing: Easings.accelerate, useNativeDriver: true }),
      ]).start(() => { if (!cancelled) setRendered(false); });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, useSystemSheet]);

  // Arrastar p/ baixo fecha: > Gestures.sheetDismissDistance (96px) ou flick
  // rápido (vy > 0.9). [2026-10-16 motion] Telegram/iOS:
  //  • sem `scroll`, o painel INTEIRO arrasta (não só a alça) — toques curtos
  //    continuam indo p/ as linhas; só um arrasto vertical claro é capturado;
  //  • o fundo esmaece proporcional ao arrasto (backdropOpacity abaixo);
  //  • soltar continua o movimento com a VELOCIDADE do dedo (mola com
  //    velocity) — fechar segue o flick, voltar assenta sem degrau;
  //  • começar a arrastar recolhe o teclado.
  // Kill switch: globalThis.__chatyy_motion_sheet_drag = false → só alça/cabeçalho,
  // fechamento pelo timing de saída (comportamento anterior).
  const richDrag = motionEnabled('sheet_drag');
  const panelHRef = useRef(0);
  panelHRef.current = panelH;
  const dragStart = useRef(0);
  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => !wide && dismissable && g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx) * 1.2,
    onPanResponderGrant: () => {
      // (valor de mola nativa não volta síncrono p/ o JS → recomeça do dedo)
      dragStart.current = 0;
      drag.stopAnimation();
      if (richDrag) { try { Keyboard.dismiss(); } catch {} }
    },
    onPanResponderMove: (_e, g) => { drag.setValue(Math.max(0, dragStart.current + g.dy)); },
    onPanResponderRelease: (_e, g) => {
      const closing = (dragStart.current + g.dy) > Gestures.sheetDismissDistance || g.vy > Gestures.sheetDismissVelocity;
      if (closing) {
        if (richDrag && !isReduceMotionEnabled()) {
          const h = panelHRef.current || winH;
          Animated.spring(drag, {
            toValue: h + 24, velocity: Math.max(0, g.vy) * 1000,
            ...Springs.sheet, overshootClamping: true, useNativeDriver: true,
          }).start();
          // Se o pai não fechar (onClose ignorado), o painel volta.
          setTimeout(() => {
            if (visibleRef.current) Animated.spring(drag, { toValue: 0, ...Springs.sheet, useNativeDriver: true }).start();
          }, 420);
        }
        requestClose();
        return;
      }
      Animated.spring(drag, {
        toValue: 0, ...Springs.sheet, useNativeDriver: true,
        ...(richDrag ? { velocity: g.vy * 1000 } : null),
      }).start();
    },
    onPanResponderTerminationRequest: () => false,
    onPanResponderTerminate: () => {
      Animated.spring(drag, { toValue: 0, ...Springs.sheet, useNativeDriver: true }).start();
    },
  }), [wide, dismissable, drag, requestClose, richDrag, winH]);

  // Painel inteiro arrastável só quando o corpo não rola (ScrollView nativo
  // disputaria o gesto) e no celular (web largo = cartão central).
  const panelDrag = richDrag && dragAnywhere && !scroll && !wide;
  const header = (
    <View {...(panelDrag ? null : pan.panHandlers)}>
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
  // Fundo: fade de entrada/saída × (1 − arrasto/altura do painel).
  const backdropOpacity = richDrag && !wide
    ? Animated.multiply(fade, drag.interpolate({
      inputRange: [0, Math.max(1, panelH || Math.round(winH * 0.5))], outputRange: [1, 0], extrapolate: 'clamp',
    }))
    : fade;
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
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: backdropOpacity }]}>
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
            onLayout={richDrag ? (e) => { const h = e.nativeEvent.layout.height; if (Math.abs(h - panelH) > 1) setPanelH(h); } : undefined}
            {...(panelDrag ? pan.panHandlers : null)}
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
