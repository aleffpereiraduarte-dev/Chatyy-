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
  Animated, Easing, PanResponder, Platform, Pressable, Text, View, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Overlay, OverlayShadow } from '../../constants/theme';
import { IconCheckCircle, IconAlertCircle, IconInfo } from '../Icons';
import { isReduceMotionEnabled } from '../reducedMotion';
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
  const timer = useRef(null);
  const current = useRef(null);

  const dismiss = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const shown = current.current;
    Animated.timing(anim, { toValue: 0, duration: Overlay.exitMs, easing: Easing.in(Easing.quad), useNativeDriver: true })
      .start(() => { if (current.current === shown) { current.current = null; setToast(null); } });
  }, [anim]);

  useEffect(() => {
    const fn = (p) => {
      if (p.hide) { if (!p.id || current.current?.id === p.id) dismiss(); return; }
      if (timer.current) clearTimeout(timer.current);
      current.current = p;
      drag.setValue(0);
      anim.setValue(0);
      setToast(p);
      if (isReduceMotionEnabled()) {
        Animated.timing(anim, { toValue: 1, duration: 120, useNativeDriver: true }).start();
      } else {
        Animated.spring(anim, { toValue: 1, ...Overlay.spring, useNativeDriver: true }).start();
      }
      const ms = typeof p.duration === 'number' ? p.duration : (p.action ? 5000 : 3500);
      timer.current = setTimeout(dismiss, ms);
    };
    _listeners.add(fn);
    return () => { _listeners.delete(fn); if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dismiss]);

  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => g.dy > 4 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderMove: (_e, g) => drag.setValue(Math.max(0, g.dy)),
    onPanResponderRelease: (_e, g) => {
      if (g.dy > 30 || g.vy > 0.6) dismiss();
      else Animated.spring(drag, { toValue: 0, ...Overlay.spring, useNativeDriver: true }).start();
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
          opacity: anim,
          transform: [
            { translateY: Animated.add(anim.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }), drag) },
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
