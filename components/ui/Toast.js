// Toast — snackbar GLOBAL único do design system de overlays (2026-10-12).
//
//   import { showToast } from '../components/ui/Toast';
//   showToast({ message: t('undo.archived'), kind: 'success',
//               action: { label: t('undo.button'), onPress: undo } });
//   showToast('Copiado');                     // atalho só com texto
//
// Um host (<ToastHost/>) montado UMA vez em app/_layout.js. Um toast por vez
// (o novo substitui o atual). Fica embaixo, acima da tab bar / home indicator;
// pílula 14 de raio, ícone SVG 20 + texto 14 + ação opcional ("Desfazer");
// arrastar p/ baixo dispensa; respeita reduzir-movimento. Sem deps nativas.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated, PanResponder, Platform, Pressable, Text, View, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Overlay, OverlayShadow } from '../../constants/theme';
import { IconCheckCircle, IconAlertCircle, IconInfo } from '../Icons';
import { isReduceMotionEnabled } from '../reducedMotion';
import { Springs, Durations, Distances, Easings, Gestures, motionEnabled } from '../../constants/motion';
import { useOverlayColors } from './Sheet';

const _listeners = new Set();
let _seq = 0;

// opts: string | { message, kind: 'success'|'error'|'info', icon, action: {label,onPress},
//                  duration (ms, default 3500 / 5000 c/ ação), bottomOffset (px extra) }
export function showToast(opts) {
  const o = typeof opts === 'string' ? { message: opts } : (opts || {});
  if (!o.message) return 0;
  const id = ++_seq;
  const payload = { ...o, id };
  if (!_listeners.size) {
    // Sem host montado (testes/telas isoladas): não quebra; no web usa console.
    try { if (Platform.OS === 'web') console.info('[toast]', o.message); } catch {}
    return id;
  }
  _listeners.forEach((fn) => { try { fn(payload); } catch {} });
  return id;
}

// [2026-10-20 ux] Erro amigável (Telegram): toast de erro + "Tentar de novo" em vez de Alert cru.
// Háptico de erro (respeita a preferência de vibração) e o retry abre a sonda do breaker
// de leituras (utils/userRetry). retryLabel vem do chamador: t('common.retry').
//   showErrorToast({ message: t('x.failed'), retryLabel: t('common.retry'), onRetry: load });
export function showErrorToast({ message, onRetry, retryLabel, haptic = true, duration } = {}) {
  if (!message) return 0;
  if (haptic) { try { require('../../services/haptics').error(); } catch {} }
  let action;
  if (typeof onRetry === 'function') {
    let press = onRetry;
    try { press = require('../../utils/userRetry').wrapRetryPress(onRetry, retryLabel || 'retry', true); } catch {}
    action = { label: retryLabel || 'Tentar novamente', onPress: press };
  }
  return showToast({ message, kind: 'error', action, duration });
}

export function hideToast(id) {
  _listeners.forEach((fn) => { try { fn({ hide: true, id }); } catch {} });
}

const KIND_ICON = { success: IconCheckCircle, error: IconAlertCircle, info: IconInfo };

export function ToastHost({ bottomOffset = 64 }) {
  const oc = useOverlayColors();
  const insets = useSafeAreaInsets();
  const { width: winW } = useWindowDimensions();
  const [toast, setToast] = useState(null);
  const anim = useRef(new Animated.Value(0)).current;
  const drag = useRef(new Animated.Value(0)).current;
  // [2026-10-16 motion] arrastar p/ o LADO dispensa (Telegram/iOS); o timer
  // pausa enquanto o dedo está no toast. Kill: __chatyy_motion_toast_swipe=false.
  const dragX = useRef(new Animated.Value(0)).current;
  const timer = useRef(null);
  const current = useRef(null);
  const msRef = useRef(Durations.toast);
  const winWRef = useRef(winW);
  winWRef.current = winW;

  const dismiss = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const shown = current.current;
    Animated.timing(anim, { toValue: 0, duration: Durations.exit, easing: Easings.fadeOut, useNativeDriver: true })
      .start(() => { if (current.current === shown) { current.current = null; setToast(null); } });
  }, [anim]);

  useEffect(() => {
    const fn = (p) => {
      if (p.hide) { if (!p.id || current.current?.id === p.id) dismiss(); return; }
      if (timer.current) clearTimeout(timer.current);
      current.current = p;
      drag.setValue(0);
      dragX.setValue(0);
      anim.setValue(0);
      setToast(p);
      if (isReduceMotionEnabled() || !motionEnabled()) {
        Animated.timing(anim, { toValue: 1, duration: 120, useNativeDriver: true }).start();
      } else {
        Animated.spring(anim, { toValue: 1, ...Springs.sheet, useNativeDriver: true }).start();
      }
      const ms = typeof p.duration === 'number' ? p.duration : (p.action ? Durations.toastWithAction : Durations.toast);
      msRef.current = ms;
      timer.current = setTimeout(dismiss, ms);
    };
    _listeners.add(fn);
    return () => { _listeners.delete(fn); if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dismiss]);

  const axis = useRef(null); // 'x' | 'y' — trava no eixo do 1º movimento
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => {
      if (g.dy > 4 && Math.abs(g.dy) > Math.abs(g.dx)) { axis.current = 'y'; return true; }
      if (motionEnabled('toast_swipe') && Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.2) { axis.current = 'x'; return true; }
      return false;
    },
    onPanResponderGrant: () => {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    },
    onPanResponderMove: (_e, g) => {
      if (axis.current === 'x') dragX.setValue(g.dx);
      else drag.setValue(Math.max(0, g.dy));
    },
    onPanResponderRelease: (_e, g) => {
      if (axis.current === 'x') {
        if (Math.abs(g.dx) > Gestures.toastSwipeX || Math.abs(g.vx) > Gestures.toastSwipeVx) {
          const dir = (g.dx || g.vx) < 0 ? -1 : 1;
          const shown = current.current;
          Animated.spring(dragX, {
            toValue: dir * (winWRef.current || 400), velocity: g.vx * 1000,
            ...Springs.snappy, overshootClamping: true, useNativeDriver: true,
          }).start(() => { if (current.current === shown) { current.current = null; setToast(null); } });
          return;
        }
        Animated.spring(dragX, { toValue: 0, ...Springs.snappy, velocity: g.vx * 1000, useNativeDriver: true }).start();
        timer.current = setTimeout(dismiss, Math.min(msRef.current, 2500));
        return;
      }
      if (g.dy > Gestures.toastDismissDistance || g.vy > Gestures.toastDismissVelocity) dismiss();
      else {
        Animated.spring(drag, { toValue: 0, ...Springs.sheet, useNativeDriver: true }).start();
        timer.current = setTimeout(dismiss, Math.min(msRef.current, 2500));
      }
    },
    onPanResponderTerminate: () => {
      Animated.spring(drag, { toValue: 0, ...Springs.sheet, useNativeDriver: true }).start();
      Animated.spring(dragX, { toValue: 0, ...Springs.snappy, useNativeDriver: true }).start();
      if (!timer.current) timer.current = setTimeout(dismiss, 2500);
    },
  })).current;

  if (!toast) return null;

  const Icon = toast.icon || KIND_ICON[toast.kind] || null;
  const wide = Platform.OS === 'web' && winW >= 768;
  const bottom = wide ? 24 : (insets.bottom || 0) + bottomOffset + (toast.bottomOffset || 0);

  return (
    <View
      pointerEvents="box-none"
      style={{ position: Platform.OS === 'web' ? 'fixed' : 'absolute', left: 0, right: 0, bottom, alignItems: 'center', zIndex: 10000, elevation: 30 }}
    >
      <Animated.View
        {...pan.panHandlers}
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
        style={[{
          flexDirection: 'row', alignItems: 'center', gap: 12,
          minHeight: Overlay.toastMinHeight, maxWidth: Overlay.toastMaxWidth,
          width: wide ? undefined : winW - 24, alignSelf: 'center',
          paddingLeft: 16, paddingRight: toast.action ? 6 : 16, paddingVertical: 8,
          borderRadius: Overlay.toastRadius, backgroundColor: oc.toastBg,
          opacity: Animated.multiply(anim, dragX.interpolate({
            inputRange: [-(winW || 400), 0, (winW || 400)], outputRange: [0.2, 1, 0.2], extrapolate: 'clamp',
          })),
          transform: [
            { translateX: dragX },
            { translateY: Animated.add(anim.interpolate({ inputRange: [0, 1], outputRange: [Distances.toast, 0] }), drag) },
            { scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
          ],
        }, OverlayShadow]}
      >
        {Icon ? (React.isValidElement(Icon) ? Icon : <Icon size={20} color={oc.toastText} />) : null}
        <Text numberOfLines={3} style={{ flexShrink: 1, flexGrow: 1, fontSize: 14, fontWeight: '500', color: oc.toastText, lineHeight: 19 }}>
          {toast.message}
        </Text>
        {toast.action ? (
          <Pressable
            onPress={() => { try { toast.action.onPress && toast.action.onPress(); } catch {} dismiss(); }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={toast.action.label}
            style={({ pressed }) => ({
              paddingHorizontal: 14, height: 36, borderRadius: 10, justifyContent: 'center',
              backgroundColor: oc.toastActionBg, opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text style={{ fontSize: 14, fontWeight: '700', color: oc.toastAction }}>{toast.action.label}</Text>
          </Pressable>
        ) : null}
      </Animated.View>
    </View>
  );
}

export default ToastHost;
