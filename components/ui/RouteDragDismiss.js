// [2026-10-20 tg-modal] Tela de modal cheio (compose, foto nova, criar reunião,
// compartilhar…) fecha ARRASTANDO PARA BAIXO no iOS, como folha do sistema.
//
// Por que não 'modal' (pageSheet) direto: essas telas usam KeyboardAvoidingView
// com insets.top (ver _layout.js _FULL_MODAL) — o KAV mede o layout relativo e
// erraria o teclado pelo topo da folha. Então a rota vira overFullScreen
// ('transparentModal', _layout.js _DRAG_MODAL: mesma geometria do fullScreenModal,
// insets reais, MAS a tela de baixo continua desenhada) e o arrasto é nosso:
//   - começa só pela faixa do topo (prop zone = status bar + cabeçalho) → não
//     briga com a rolagem, seleção de texto, sliders ou desenho do conteúdo;
//   - segue o dedo na UI thread (Reanimated + RNGH), solta: passou de 96 pt ou
//     veio rápido = fecha (onDismiss, ex. router.back()), senão volta com mola;
//   - shouldConfirm() → true = volta e chama onDismissAttempt() (ex.: "Descartar?").
// Android/web: sem efeito (o Android tem o voltar do sistema).
// Kill: globalThis.__chatyy_modal_drag = false (a rota continua abrindo igual).
import React, { useMemo, useRef } from 'react';
import { Keyboard, Platform, StyleSheet, useWindowDimensions } from 'react-native';

let RA = null;
let GH = null;
if (Platform.OS === 'ios') {
  try { RA = require('react-native-reanimated'); } catch {}
  try { GH = require('react-native-gesture-handler'); } catch {}
}
const OK = !!(RA && RA.useSharedValue && RA.useAnimatedStyle && RA.withSpring && RA.withTiming && RA.runOnJS && RA.default
  && GH && GH.Gesture && GH.Gesture.Pan && GH.GestureDetector && GH.GestureHandlerRootView);

export function routeDragDismissOn() {
  return OK && globalThis.__chatyy_modal_drag !== false;
}

const DIST = 96;
const VEL = 900; // pt/s

function DragRoot({ children, onDismiss, shouldConfirm, onDismissAttempt, style, zone }) {
  const { height: winH } = useWindowDimensions();
  const y = RA.useSharedValue(0);
  const z = RA.useSharedValue(Number(zone) || 0);
  z.value = Number(zone) || 0;
  const cb = useRef({});
  cb.current = { onDismiss, shouldConfirm, onDismissAttempt };
  const pan = useMemo(() => {
    const kb = () => { try { Keyboard.dismiss(); } catch {} };
    const blocked = () => { try { return !!(cb.current.shouldConfirm && cb.current.shouldConfirm()); } catch { return false; } };
    const attempt = () => { try { cb.current.onDismissAttempt && cb.current.onDismissAttempt(); } catch {} };
    const close = () => { try { cb.current.onDismiss && cb.current.onDismiss(); } catch {} };
    // Decide no JS (pode abrir Alert); a animação roda na UI thread.
    const release = (dy, vy) => {
      if (!(dy > DIST || vy > VEL) || blocked()) {
        y.value = RA.withSpring(0, { damping: 26, stiffness: 320 });
        if (dy > DIST || vy > VEL) attempt();
        return;
      }
      y.value = RA.withTiming(winH + 40, { duration: 180 }, (fin) => { 'worklet'; if (fin) RA.runOnJS(close)(); });
    };
    return GH.Gesture.Pan()
      .activeOffsetY(10)
      .failOffsetY(-10)
      .failOffsetX([-16, 16])
      // Só a faixa do topo (status bar + cabeçalho) começa o arrasto: o resto da
      // tela (rolagem, campos, sliders, desenho) nem vê este gesto.
      .onTouchesDown((e, mgr) => {
        'worklet';
        const t0 = e.allTouches && e.allTouches[0];
        if (!t0 || t0.y > z.value) mgr.fail();
      })
      .onStart(() => { 'worklet'; RA.runOnJS(kb)(); })
      .onUpdate((e) => { 'worklet'; y.value = Math.max(0, e.translationY); })
      .onEnd((e) => { 'worklet'; RA.runOnJS(release)(Math.max(0, e.translationY), e.velocityY); });
  }, [winH]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = RA.useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const AV = RA.default.View;
  return (
    <GH.GestureHandlerRootView style={styles.fill}>
      <GH.GestureDetector gesture={pan}>
        <AV style={[styles.fill, style, st]}>{children}</AV>
      </GH.GestureDetector>
    </GH.GestureHandlerRootView>
  );
}

/**
 * Envolve a tela inteira. zone = altura (pt, do topo da tela) onde o arrasto
 * pode começar — normalmente insets.top + altura do cabeçalho.
 * Sem suporte / desligado / enabled=false = devolve os filhos sem nada em volta.
 */
export function RouteDragDismiss({ children, onDismiss, shouldConfirm, onDismissAttempt, style, zone = 100, enabled = true }) {
  const on = useRef(null);
  if (on.current === null) on.current = routeDragDismissOn() && !!enabled;
  if (!on.current) return children;
  return (
    <DragRoot onDismiss={onDismiss} shouldConfirm={shouldConfirm} onDismissAttempt={onDismissAttempt} style={style} zone={zone}>
      {children}
    </DragRoot>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
