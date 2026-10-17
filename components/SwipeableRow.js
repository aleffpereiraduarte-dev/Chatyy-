import React, { useRef, useCallback, useMemo } from 'react';
import { View, StyleSheet, Animated, PanResponder, Platform, Easing, Text, LayoutAnimation, UIManager } from 'react-native';
import { IconTrash, IconArchive } from './Icons';
import { useLanguageOptional } from '../context/LanguageContext';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const USE_NATIVE = Platform.OS !== 'web';
const THRESHOLD = 80;

/**
 * iOS Mail-style swipe row using native-driven Animated.
 * Key: useNativeDriver=true on mobile for 60fps on the UI thread.
 * The PanResponder gesture detection still runs on JS thread,
 * but the actual animation (translateX) runs natively.
 */
export default function SwipeableRow({ children, onDelete, onArchive, onSnooze, colors }) {
  const _lang = useLanguageOptional();
  const _tr = (k, fb) => { try { const v = _lang?.t?.(k); if (v && v !== k) return v; } catch {} return fb; };
  const tx = useRef(new Animated.Value(0)).current;
  const isAnimating = useRef(false);

  // Interpolations (these work with native driver).
  // Why: opacity-only fade felt flat. Adding a scale that pops 0.7→1.05 at the
  // threshold gives the icon an "active" beat — lines up with the iOS Mail
  // moment where the action becomes committable. The Text label fades in last
  // (after 60% of the threshold) so swipe still feels uncluttered.
  const archiveOpacity = tx.interpolate({
    inputRange: [0, 40, THRESHOLD],
    outputRange: [0, 0.5, 1],
    extrapolate: 'clamp',
  });
  const archiveScale = tx.interpolate({
    inputRange: [0, 40, THRESHOLD, THRESHOLD + 40],
    outputRange: [0.7, 0.9, 1, 1.05],
    extrapolate: 'clamp',
  });
  const archiveLabelOpacity = tx.interpolate({
    inputRange: [THRESHOLD * 0.6, THRESHOLD],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const deleteOpacity = tx.interpolate({
    inputRange: [-THRESHOLD, -40, 0],
    outputRange: [1, 0.5, 0],
    extrapolate: 'clamp',
  });
  const deleteScale = tx.interpolate({
    inputRange: [-(THRESHOLD + 40), -THRESHOLD, -40, 0],
    outputRange: [1.05, 1, 0.9, 0.7],
    extrapolate: 'clamp',
  });
  const deleteLabelOpacity = tx.interpolate({
    inputRange: [-THRESHOLD, -THRESHOLD * 0.6],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => {
        if (isAnimating.current) return false;
        return Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 2;
      },
      onPanResponderGrant: () => {
        tx.stopAnimation();
        tx.extractOffset();
      },
      onPanResponderMove: (_, g) => {
        // Block if no handler for that direction
        if (g.dx > 5 && !onArchive) return;
        if (g.dx < -5 && !onDelete) return;

        // Rubber-band beyond threshold
        const abs = Math.abs(g.dx);
        const sign = g.dx >= 0 ? 1 : -1;
        const val = abs < THRESHOLD
          ? sign * abs
          : sign * (THRESHOLD + (abs - THRESHOLD) * 0.2);
        tx.setValue(val);
      },
      onPanResponderRelease: (_, g) => {
        tx.flattenOffset();
        const dx = g.dx;
        const vx = g.vx;

        // Fast flick or past threshold → execute action
        if ((dx < -THRESHOLD || vx < -1.2) && onDelete) {
          isAnimating.current = true;
          Animated.timing(tx, {
            toValue: -500,
            duration: 200,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }).start(() => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            onDelete();
            tx.setValue(0);
            isAnimating.current = false;
          });
          return;
        }

        if ((dx > THRESHOLD || vx > 1.2) && onArchive) {
          isAnimating.current = true;
          Animated.timing(tx, {
            toValue: 500,
            duration: 200,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }).start(() => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            onArchive();
            tx.setValue(0);
            isAnimating.current = false;
          });
          return;
        }

        // Snap back — stiff spring for snappy feel
        Animated.spring(tx, {
          toValue: 0,
          stiffness: 500,
          damping: 35,
          mass: 0.8,
          useNativeDriver: true,
        }).start();
      },
      onPanResponderTerminate: () => {
        tx.flattenOffset();
        Animated.spring(tx, {
          toValue: 0,
          stiffness: 500, damping: 35, mass: 0.8,
          useNativeDriver: true,
        }).start();
      },
    })
  ).current;

  return (
    <View style={s.container}>
      {onArchive && (
        <Animated.View style={[s.bg, s.bgLeft, { opacity: archiveOpacity }]}>
          <Animated.View style={{ transform: [{ scale: archiveScale }], alignItems: 'center', gap: 4 }}>
            <IconArchive size={22} color="#fff" />
            <Animated.Text style={[s.bgLabel, { opacity: archiveLabelOpacity }]}>{_tr('contextMenu.archive', 'Arquivar')}</Animated.Text>
          </Animated.View>
        </Animated.View>
      )}
      {onDelete && (
        <Animated.View style={[s.bg, s.bgRight, { opacity: deleteOpacity }]}>
          <Animated.View style={{ transform: [{ scale: deleteScale }], alignItems: 'center', gap: 4 }}>
            <IconTrash size={22} color="#fff" />
            <Animated.Text style={[s.bgLabel, { opacity: deleteLabelOpacity }]}>{_tr('common.delete', 'Excluir')}</Animated.Text>
          </Animated.View>
        </Animated.View>
      )}
      <Animated.View
        // [2026-10-16 polish] 'inherit' só existe no web — no nativo é cor inválida.
        style={{ transform: [{ translateX: tx }], zIndex: 2, ...(Platform.OS === 'web' ? { backgroundColor: 'inherit' } : null) }}
        {...panResponder.panHandlers}
      >
        {children}
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { overflow: 'hidden', position: 'relative' },
  // [2026-10-16 polish] Fundo de largura total (antes 110px): no flick a linha
  // sai até 500px e abria um vão branco atrás. Cada lado só aparece na sua
  // direção (opacidade 0 na outra), então podem se sobrepor. Ícone colado à
  // borda de onde a linha sai, como no Mail/lista de chat.
  bg: {
    position: 'absolute', top: 0, bottom: 0, left: 0, right: 0,
    justifyContent: 'center', zIndex: 1,
  },
  // Mesmas cores da lista de chat (SWIPE_C em ChatListTab / CLTheme nativo):
  // escala de cinzas + vermelho só no destrutivo (P&B premium).
  bgLeft: { alignItems: 'flex-start', paddingLeft: 28, backgroundColor: '#3A3A3C' },
  bgRight: { alignItems: 'flex-end', paddingRight: 28, backgroundColor: '#FF3B30' },
  bgLabel: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
});
