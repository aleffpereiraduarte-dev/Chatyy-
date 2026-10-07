// [2026-10-08 chat-native] Attachment sheet ("+" / clip) — native-feeling
// bottom sheet:
//   • slides up on the UI thread (Reanimated 4), backdrop opacity follows the
//     sheet position frame-by-frame;
//   • drag the sheet (or its grabber) down to dismiss — follows the finger,
//     rubber-bands upward, flick velocity or >28% travel closes, otherwise it
//     springs back (RNGH Pan, no JS per frame);
//   • 4-column grid of SVG icons (same items/handlers as the legacy sheet,
//     built by chat-conversation's buildAttachItems), staggered pop-in,
//     PressableScale + light haptic per tap;
//   • respects the bottom safe-area (home indicator / gesture nav).
//
// OTA SAFETY: same gate as SwipeReplyRow.native — Reanimated / RNGH are only
// used when utils/threadKeyboard already loaded them on this binary. If not,
// ATTACH_SHEET_NATIVE=false and chat-conversation keeps the legacy sheet.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KEYBOARD_CONTROLLER_ACTIVE } from '../../utils/threadKeyboard';
import PressableScale from '../PressableScale';
import { isReduceMotionEnabled } from '../reducedMotion';

let Rea = null;
let GH = null;
if (KEYBOARD_CONTROLLER_ACTIVE) {
  try {
    // eslint-disable-next-line global-require
    Rea = require('react-native-reanimated');
    // eslint-disable-next-line global-require
    GH = require('react-native-gesture-handler');
  } catch { Rea = null; GH = null; }
}

const runOnJS = Rea ? Rea.runOnJS : null;
const withSpring = Rea ? Rea.withSpring : null;
const withTiming = Rea ? Rea.withTiming : null;
const interpolate = Rea ? Rea.interpolate : null;

export const ATTACH_SHEET_NATIVE = !!(
  Rea && Rea.default && Rea.useSharedValue && Rea.useAnimatedStyle && Rea.withSpring
  && Rea.withTiming && Rea.interpolate && Rea.runOnJS
  && GH && GH.Gesture && GH.Gesture.Pan && GH.GestureDetector
);

const OPEN_SPRING = { damping: 22, stiffness: 260, mass: 0.9 };
const BACK_SPRING = { damping: 20, stiffness: 300 };
const HIDDEN = 600; // off-screen offset before the sheet height is measured

// [2026-10-08 chat-beauty-chrome] theme sniff without a new prop: the sheet
// only receives `colors` — dark palettes have a dark `background`.
function isDarkColors(colors) {
  const bg = String((colors && (colors.background || colors.surface)) || '#ffffff').replace('#', '');
  if (bg.length < 6) return false;
  const r = parseInt(bg.slice(0, 2), 16), g = parseInt(bg.slice(2, 4), 16), b = parseInt(bg.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) < 96;
}

let _haptics = null;
function _tick(kind) {
  try {
    if (!_haptics) _haptics = require('../../services/haptics');
    if (kind === 'select') _haptics.selection(); else _haptics.tap('light');
  } catch {}
}

function GridItem({ item, index, progress, colors, onPress, width }) {
  const A = Rea.default;
  const st = Rea.useAnimatedStyle(() => {
    const p = progress.get();
    const start = Math.min(0.25 + index * 0.06, 0.8);
    return {
      opacity: interpolate(p, [start, 1], [0, 1], 'clamp'),
      transform: [{ scale: interpolate(p, [start, 1], [0.6, 1], 'clamp') }],
    };
  });
  const Icon = item.icon;
  return (
    <A.View style={[{ width }, st]}>
      <PressableScale
        onPress={onPress}
        haptic="light"
        scaleTo={0.9}
        style={styles.item}
        accessibilityRole="button"
        accessibilityLabel={item.label}
      >
        {/* [2026-10-08 chat-beauty-chrome] monochrome circle: neutral fill +
            hairline ring, glyph in text color, label in secondary. */}
        <View style={[styles.iconCircle, {
          backgroundColor: isDarkColors(colors) ? '#2c2c2e' : '#f2f2f4',
          borderColor: isDarkColors(colors) ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
        }]}>
          {Icon ? <Icon size={26} color={colors.text} /> : null}
        </View>
        <Text style={[styles.label, { color: colors.textSecondary || colors.text }]} numberOfLines={1}>{item.label}</Text>
      </PressableScale>
    </A.View>
  );
}

export default function AttachSheet({ visible, onClose, onPick, colors, items }) {
  const A = Rea.default;
  const insets = useSafeAreaInsets();
  const { width: winW } = useWindowDimensions();
  const [show, setShow] = useState(!!visible);
  const sheetH = Rea.useSharedValue(HIDDEN);
  const ty = Rea.useSharedValue(HIDDEN);       // 0 = fully open
  const progress = Rea.useSharedValue(0);      // 0..1 entrance (item stagger)

  const hide = useCallback(() => setShow(false), []);
  const requestClose = useCallback(() => { try { onClose && onClose(); } catch {} }, [onClose]);

  useEffect(() => {
    if (visible) {
      setShow(true);
      _tick('select');
      if (isReduceMotionEnabled()) { ty.set(0); progress.set(1); return; }
      // Height may not be measured yet on the very first open; onLayout below
      // re-targets the spring once it is.
      ty.set(withSpring(0, OPEN_SPRING));
      progress.set(withTiming(1, { duration: 360 }));
    } else if (show) {
      progress.set(withTiming(0, { duration: 160 }));
      ty.set(withTiming(sheetH.get(), { duration: 200 }, (fin) => {
        'worklet';
        if (fin) runOnJS(hide)();
      }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const onSheetLayout = useCallback((e) => {
    const h = e?.nativeEvent?.layout?.height || 0;
    if (h > 0) sheetH.set(h);
  }, [sheetH]);

  const pan = useMemo(() => GH.Gesture.Pan()
    .activeOffsetY([-6, 6])
    .failOffsetX([-24, 24])
    .onUpdate((e) => {
      'worklet';
      let y = e.translationY;
      if (y < 0) y = y * 0.2; // rubber-band upward
      ty.set(y);
    })
    .onEnd((e) => {
      'worklet';
      const h = sheetH.get();
      const shouldClose = e.translationY > h * 0.28 || e.velocityY > 900;
      if (shouldClose) {
        ty.set(withTiming(h, { duration: 180 }));
        runOnJS(requestClose)();
      } else {
        ty.set(withSpring(0, BACK_SPRING));
      }
    }), [requestClose, sheetH, ty]);

  const sheetStyle = Rea.useAnimatedStyle(() => ({
    transform: [{ translateY: ty.get() }],
  }));
  const backdropStyle = Rea.useAnimatedStyle(() => {
    const h = sheetH.get() || HIDDEN;
    return { opacity: interpolate(ty.get(), [0, h], [1, 0], 'clamp') };
  });

  if (!show) return null;

  const cols = 4;
  const gridW = Math.min(winW, 520) - 24;
  const cellW = Math.floor(gridW / cols);

  return (
    <View style={styles.fullscreen} pointerEvents="box-none">
      <A.View style={[styles.backdrop, backdropStyle]} pointerEvents={visible ? 'auto' : 'none'}>
        <Pressable style={StyleSheet.absoluteFill} onPress={requestClose} accessibilityRole="button" accessibilityLabel="Fechar" />
      </A.View>
      <GH.GestureDetector gesture={pan}>
        <A.View
          onLayout={onSheetLayout}
          style={[styles.sheet, {
            backgroundColor: isDarkColors(colors) ? '#1c1c1e' : '#ffffff',
            paddingBottom: Math.max(insets.bottom, 12) + 12,
          }, sheetStyle]}
        >
          <View style={styles.grabZone}>
            <View style={[styles.handle, { backgroundColor: isDarkColors(colors) ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.16)' }]} />
          </View>
          <View style={[styles.grid, { width: gridW }]}>
            {(items || []).map((item, idx) => (
              <GridItem
                key={item.key}
                item={item}
                index={idx}
                progress={progress}
                colors={colors}
                width={cellW}
                onPress={() => { requestClose(); onPick && onPick(item.key); }}
              />
            ))}
          </View>
        </A.View>
      </GH.GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  fullscreen: { ...StyleSheet.absoluteFillObject, zIndex: 9998 },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.38)' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: -2 }, shadowOpacity: 0.10, shadowRadius: 20,
    elevation: 24,
  },
  grabZone: { alignSelf: 'stretch', alignItems: 'center', paddingTop: 8, paddingBottom: 18 },
  handle: { width: 36, height: 5, borderRadius: 2.5 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  item: { alignItems: 'center', paddingVertical: 6, marginBottom: 10 },
  iconCircle: { width: 60, height: 60, borderRadius: 30, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  label: { fontSize: 12.5, fontWeight: '500', maxWidth: 84, textAlign: 'center', letterSpacing: -0.1 },
});
