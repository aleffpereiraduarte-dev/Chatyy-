/**
 * ReactionSwipeUp
 * ---------------
 * Instagram-style swipe-up emoji reaction picker for the status viewer.
 *
 * UX spec:
 *   - User swipes UP on the bottom area of the viewer (~50 px tall strip).
 *   - As they drag, a floating emoji bar scales in from the bottom.
 *   - Release past the threshold → the emoji under the finger fires,
 *     a big burst animation plays, and the picker collapses.
 *   - Release below threshold → picker animates back down (no react).
 *
 * Reactions are PRIVATE: viewer gets a quick celebratory burst only.
 * Only the author sees the list (surfaced in status_viewers).
 *
 * This component is headless-ish: it provides its own PanResponder and
 * handles all gesture math, only emitting `onReact(emoji)` when the user
 * commits. Parent is responsible for pausing/resuming the story timer
 * via the `onOpen` / `onClose` callbacks.
 */
import { useCallback, useRef, useState } from 'react';
import {
  Animated,
  PanResponder,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

const DEFAULT_EMOJIS = ['❤️', '\u{1F525}', '\u{1F602}', '\u{1F44F}', '\u{1F622}', '\u{1F62E}'];
const OPEN_THRESHOLD = 40;  // px of upward drag to start revealing
const COMMIT_THRESHOLD = 90; // px to actually pick the emoji under finger

export default function ReactionSwipeUp({
  emojis = DEFAULT_EMOJIS,
  onReact,
  onOpen,
  onClose,
  activeEmoji,
  // bottom offset so the picker sits above the reply input
  bottomOffset = 72,
}) {
  const translateY = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.7)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const [revealed, setRevealed] = useState(false);
  const [hoverIdx, setHoverIdx] = useState(-1);
  const widthRef = useRef(0);

  // The PanResponder below is created once (useRef), so its callbacks close
  // over the FIRST render — `revealed`/`hoverIdx`/props would be frozen there
  // and a swipe-up could never commit. Mirror SliderStickerView: synchronous
  // refs for gesture state + a liveRef re-assigned every render for the rest.
  const revealedRef = useRef(false);
  const hoverIdxRef = useRef(-1);
  const liveRef = useRef({});

  // Burst animation for the committed emoji — scales up fast then fades.
  const burstScale = useRef(new Animated.Value(0)).current;
  const burstOpacity = useRef(new Animated.Value(0)).current;
  const [burstEmoji, setBurstEmoji] = useState(null);

  const fireBurst = useCallback((emoji) => {
    setBurstEmoji(emoji);
    burstScale.setValue(0.4);
    burstOpacity.setValue(1);
    Animated.parallel([
      Animated.spring(burstScale, { toValue: 1.6, friction: 4, tension: 80, useNativeDriver: true }),
      Animated.timing(burstOpacity, { toValue: 0, duration: 800, delay: 200, useNativeDriver: true }),
    ]).start(() => setBurstEmoji(null));
  }, [burstScale, burstOpacity]);

  const collapse = useCallback((commitIdx = -1) => {
    Animated.parallel([
      Animated.timing(scale, { toValue: 0.7, duration: 140, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0, duration: 140, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: 140, useNativeDriver: true }),
    ]).start(() => {
      revealedRef.current = false;
      hoverIdxRef.current = -1;
      setRevealed(false);
      setHoverIdx(-1);
      onClose?.();
      if (commitIdx >= 0 && commitIdx < emojis.length) {
        fireBurst(emojis[commitIdx]);
        onReact?.(emojis[commitIdx]);
      }
    });
  }, [scale, opacity, translateY, emojis, onReact, onClose, fireBurst]);

  liveRef.current = { emojis, onOpen, collapse };

  const panR = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dy < -8 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderGrant: () => {
        liveRef.current.onOpen?.();
      },
      onPanResponderMove: (_, g) => {
        const up = Math.max(0, -g.dy);
        if (up > OPEN_THRESHOLD && !revealedRef.current) {
          revealedRef.current = true;
          setRevealed(true);
          Animated.parallel([
            Animated.spring(scale, { toValue: 1, friction: 5, tension: 80, useNativeDriver: true }),
            Animated.timing(opacity, { toValue: 1, duration: 140, useNativeDriver: true }),
          ]).start();
        }
        translateY.setValue(Math.min(0, g.dy / 2)); // rubber-band up
        // Figure out which emoji the finger is "over" — divide width by slots.
        if (revealedRef.current && widthRef.current > 0) {
          const count = liveRef.current.emojis.length;
          const slot = widthRef.current / count;
          const x = g.moveX;
          const idx = Math.max(0, Math.min(count - 1, Math.floor(x / slot)));
          hoverIdxRef.current = idx;
          setHoverIdx(idx);
        }
      },
      onPanResponderRelease: (_, g) => {
        const up = Math.max(0, -g.dy);
        if (up > COMMIT_THRESHOLD && hoverIdxRef.current >= 0) {
          liveRef.current.collapse(hoverIdxRef.current);
        } else {
          liveRef.current.collapse(-1);
        }
      },
      onPanResponderTerminate: () => liveRef.current.collapse(-1),
    })
  ).current;

  return (
    <>
      {/* Invisible touch strip at the bottom of the viewer that captures
          the swipe-up gesture. Short enough to not eat reply-input taps. */}
      <View
        {...panR.panHandlers}
        style={[styles.gestureStrip, { bottom: bottomOffset }]}
        pointerEvents="box-only"
      />

      {/* Floating emoji bar. Shows up only when user has dragged past the
          open threshold. Animates in with scale + fade. */}
      {revealed && (
        <Animated.View
          onLayout={(e) => { widthRef.current = e.nativeEvent.layout.width; }}
          style={[
            styles.bar,
            {
              bottom: bottomOffset + 48,
              opacity,
              transform: [{ scale }, { translateY }],
            },
          ]}
          pointerEvents="none"
        >
          {emojis.map((em, i) => {
            const isHover = i === hoverIdx;
            const isActive = activeEmoji === em;
            return (
              <View
                key={em}
                style={[
                  styles.slot,
                  isHover && styles.slotHover,
                ]}
              >
                <Text
                  style={[
                    styles.emoji,
                    isHover && { transform: [{ scale: 1.35 }] },
                    isActive && styles.emojiActive,
                  ]}
                >
                  {em}
                </Text>
              </View>
            );
          })}
        </Animated.View>
      )}

      {/* Celebratory burst — plays after commit */}
      {burstEmoji ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.burst,
            { opacity: burstOpacity, transform: [{ scale: burstScale }] },
          ]}
        >
          <Text style={{ fontSize: 120 }}>{burstEmoji}</Text>
        </Animated.View>
      ) : null}
    </>
  );
}

// Static inline tap row — keeps the existing behavior when users prefer
// tapping instead of swiping. Shares the same `onReact` contract.
export function ReactionInlineRow({ emojis = DEFAULT_EMOJIS, activeEmoji, onReact }) {
  return (
    <View style={styles.inlineRow}>
      {emojis.map((em) => (
        <TouchableOpacity
          key={em}
          onPress={() => onReact?.(em)}
          style={[
            styles.inlineBtn,
            activeEmoji === em && styles.inlineBtnActive,
          ]}
          activeOpacity={0.6}
        >
          <Text style={styles.emoji}>{em}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  gestureStrip: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 60,
  },
  bar: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 28,
    backgroundColor: 'rgba(0,0,0,0.65)',
    ...(Platform.OS === 'web'
      ? { backdropFilter: 'blur(18px)', boxShadow: '0 6px 24px rgba(0,0,0,0.4)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 6 },
          shadowOpacity: 0.45,
          shadowRadius: 14,
          elevation: 10,
        }),
  },
  slot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    borderRadius: 18,
  },
  slotHover: { backgroundColor: 'rgba(255,255,255,0.15)' },
  emoji: { fontSize: 30 },
  emojiActive: { transform: [{ scale: 1.25 }] },
  inlineRow: {
    flexDirection: 'row',
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 28,
    backgroundColor: 'rgba(0,0,0,0.45)',
    gap: 6,
  },
  inlineBtn: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 18,
  },
  inlineBtnActive: { backgroundColor: 'rgba(255,255,255,0.18)' },
  burst: {
    position: 'absolute',
    top: '40%',
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
