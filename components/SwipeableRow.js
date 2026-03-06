import { useRef, useCallback } from 'react';
import {
  View, Text, Animated, PanResponder, StyleSheet, Platform,
  useWindowDimensions, Vibration, Easing,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing } from '../constants/theme';
import { IconArchive, IconTrash } from './Icons';

const SWIPE_THRESHOLD = 40;
const CONFIRM_THRESHOLD = 80;
const VELOCITY_THRESHOLD = 0.08;

export default function SwipeableRow({ children, onSwipeLeft, onSwipeRight }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { width } = useWindowDimensions();
  const translateX = useRef(new Animated.Value(0)).current;
  const rowHeight = useRef(new Animated.Value(1)).current;
  const rowOpacity = useRef(new Animated.Value(1)).current;
  const hapticFired = useRef(false);
  const swiping = useRef(false);

  const resetRow = useCallback(() => {
    Animated.spring(translateX, {
      toValue: 0,
      useNativeDriver: Platform.OS !== 'web',
      tension: 100,
      friction: 14,
    }).start();
    hapticFired.current = false;
  }, [translateX]);

  const completeSwipe = useCallback((direction, callback) => {
    const safeWidth = Math.max(width || 320, 320);
    const toValue = direction === 'right' ? safeWidth : -safeWidth;

    Animated.timing(translateX, {
      toValue,
      duration: 280,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    }).start(() => {
      Animated.parallel([
        Animated.timing(rowOpacity, {
          toValue: 0,
          duration: 150,
          useNativeDriver: false,
        }),
        Animated.timing(rowHeight, {
          toValue: 0,
          duration: 220,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: false,
        }),
      ]).start(() => {
        if (callback) callback();
        translateX.setValue(0);
        rowHeight.setValue(1);
        rowOpacity.setValue(1);
      });
    });
  }, [translateX, rowHeight, rowOpacity, width]);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gs) => {
        return Math.abs(gs.dx) > 5 && Math.abs(gs.dx) > Math.abs(gs.dy);
      },
      onMoveShouldSetPanResponderCapture: (_, gs) => {
        return swiping.current && Math.abs(gs.dx) > 10;
      },
      onPanResponderTerminationRequest: () => {
        return !swiping.current;
      },
      onPanResponderGrant: () => {
        hapticFired.current = false;
        swiping.current = true;
      },
      onPanResponderMove: (_, gs) => {
        translateX.setValue(gs.dx);
        swiping.current = true;

        if (!hapticFired.current && Math.abs(gs.dx) > SWIPE_THRESHOLD) {
          hapticFired.current = true;
          if (Platform.OS !== 'web') {
            try { Vibration.vibrate(10); } catch {}
          }
        }
      },
      onPanResponderRelease: (_, gs) => {
        swiping.current = false;
        const { dx, vx } = gs;

        if ((dx > SWIPE_THRESHOLD || (dx > 15 && vx > VELOCITY_THRESHOLD)) && onSwipeRight) {
          completeSwipe('right', onSwipeRight);
        }
        else if ((dx < -SWIPE_THRESHOLD || (dx < -15 && vx < -VELOCITY_THRESHOLD)) && onSwipeLeft) {
          completeSwipe('left', onSwipeLeft);
        }
        else {
          resetRow();
        }
      },
      onPanResponderTerminate: () => {
        swiping.current = false;
        resetRow();
      },
    })
  ).current;

  // Desktop doesn't need swipe (has hover actions), also guard against 0/undefined width
  if ((Platform.OS === 'web' && width >= 768) || !width || width < 100) {
    return children;
  }

  // Background icons: smooth fade in + scale with overshoot
  const archiveOpacity = translateX.interpolate({
    inputRange: [0, 15, SWIPE_THRESHOLD],
    outputRange: [0, 0.3, 1],
    extrapolate: 'clamp',
  });
  const archiveScale = translateX.interpolate({
    inputRange: [0, SWIPE_THRESHOLD * 0.7, SWIPE_THRESHOLD, CONFIRM_THRESHOLD],
    outputRange: [0.4, 0.85, 1, 1.15],
    extrapolate: 'clamp',
  });
  const deleteOpacity = translateX.interpolate({
    inputRange: [-SWIPE_THRESHOLD, -15, 0],
    outputRange: [1, 0.3, 0],
    extrapolate: 'clamp',
  });
  const deleteScale = translateX.interpolate({
    inputRange: [-CONFIRM_THRESHOLD, -SWIPE_THRESHOLD, -SWIPE_THRESHOLD * 0.7, 0],
    outputRange: [1.15, 1, 0.85, 0.4],
    extrapolate: 'clamp',
  });

  // Background color: smooth gradient shift on confirm
  const archiveBg = translateX.interpolate({
    inputRange: [0, SWIPE_THRESHOLD, CONFIRM_THRESHOLD],
    outputRange: [colors.primary, colors.primary, '#059669'],
    extrapolate: 'clamp',
  });
  const deleteBg = translateX.interpolate({
    inputRange: [-CONFIRM_THRESHOLD, -SWIPE_THRESHOLD, 0],
    outputRange: ['#b91c1c', colors.error, colors.error],
    extrapolate: 'clamp',
  });

  // Subtle row tilt for depth feel
  const rowRotate = translateX.interpolate({
    inputRange: [-200, 0, 200],
    outputRange: ['-0.5deg', '0deg', '0.5deg'],
    extrapolate: 'clamp',
  });

  return (
    <Animated.View style={[
      s.wrapper,
      {
        maxHeight: rowHeight.interpolate({ inputRange: [0, 1], outputRange: [0, 200] }),
        opacity: rowOpacity,
      },
    ]}>
      {/* Archive background (swipe right) */}
      <Animated.View style={[s.bgLeft, { backgroundColor: archiveBg }]}>
        <Animated.View style={[s.bgIconWrap, { opacity: archiveOpacity, transform: [{ scale: archiveScale }] }]}>
          <IconArchive size={24} color="#fff" />
          <Text style={s.bgText}>{t('contextMenu.archive')}</Text>
        </Animated.View>
      </Animated.View>

      {/* Delete background (swipe left) */}
      <Animated.View style={[s.bgRight, { backgroundColor: deleteBg }]}>
        <Animated.View style={[s.bgIconWrap, { opacity: deleteOpacity, transform: [{ scale: deleteScale }] }]}>
          <Text style={s.bgText}>{t('contextMenu.delete')}</Text>
          <IconTrash size={24} color="#fff" />
        </Animated.View>
      </Animated.View>

      {/* Foreground */}
      <Animated.View
        style={{
          transform: [{ translateX }, { rotate: rowRotate }],
          backgroundColor: colors.surface,
        }}
        {...panResponder.panHandlers}
      >
        {children}
      </Animated.View>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  wrapper: { position: 'relative', overflow: 'hidden' },
  bgLeft: {
    position: 'absolute', top: 0, left: 0, bottom: 0, width: '100%',
    flexDirection: 'row', alignItems: 'center', paddingLeft: Spacing.xl,
  },
  bgRight: {
    position: 'absolute', top: 0, right: 0, bottom: 0, width: '100%',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', paddingRight: Spacing.xl,
  },
  bgIconWrap: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
  },
  bgText: { color: '#fff', fontSize: FontSize.base, fontWeight: '700', letterSpacing: 0.3 },
});
