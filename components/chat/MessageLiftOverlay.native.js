// [2026-10-08 chat-native] WhatsApp-style "lifted bubble in place" for the
// message long-press menu.
//
// Flow (driven by app/chat-conversation.js):
//   1. long-press → captureBubbleAnchor(bubbleNode) measures the REAL bubble
//      (measureInWindow) and snapshots it (react-native-view-shot, already in
//      every binary) → { uri, x, y, w, h }.
//   2. the existing message-menu Modal renders, over a blurred (iOS) / dimmed
//      (Android) backdrop: <LiftedBubble> = the snapshot at the exact on-screen
//      rect, which springs to its final spot (pushed up/down only as much as
//      needed so the reaction bar fits above and the action list below);
//      <LiftReactionBar> above it; the action card below it.
//   3. computeLiftLayout() is pure → the card/bar positions are plain numbers,
//      the motion runs on the UI thread (Reanimated 4).
//
// Works with FlashList (the snapshot is a bitmap — recycling the cell under
// the overlay changes nothing). Any failure (no view-shot, no Reanimated,
// zero-size view, >260 ms) → captureBubbleAnchor resolves null and the caller
// opens the classic centered menu, so this can never block the long-press.
//
// OTA SAFETY: Reanimated is only touched when utils/threadKeyboard already
// loaded it successfully on this binary (same gate as SwipeReplyRow.native).
import React, { useEffect } from 'react';
import { Image, Platform, StyleSheet } from 'react-native';
import { KEYBOARD_CONTROLLER_ACTIVE } from '../../utils/threadKeyboard';
import { isReduceMotionEnabled } from '../reducedMotion';

let Rea = null;
if (KEYBOARD_CONTROLLER_ACTIVE) {
  try {
    // eslint-disable-next-line global-require
    Rea = require('react-native-reanimated');
  } catch { Rea = null; }
}

export const LIFT_AVAILABLE = !!(
  Platform.OS !== 'web' && Rea && Rea.default && Rea.useSharedValue && Rea.useAnimatedStyle
  && Rea.withSpring && Rea.withTiming && Rea.withSequence
);

export const LIFT_REACT_H = 56; // reaction bar height (48 button + 2×4 pad)
export const LIFT_GAP = 8;
const SPRING = { damping: 17, stiffness: 240, mass: 0.8 };

// Measure + snapshot the bubble. Resolves null on ANY problem (caller falls
// back to the classic menu). Never rejects.
export function captureBubbleAnchor(node, { timeoutMs = 260 } = {}) {
  return new Promise((resolve) => {
    if (!LIFT_AVAILABLE || !node || typeof node.measureInWindow !== 'function') { resolve(null); return; }
    let done = false;
    let shot = null;
    const finish = (v) => {
      if (done) {
        // Late snapshot after the timeout already opened the classic menu.
        if (v && v.uri) { try { shot && shot.releaseCapture && shot.releaseCapture(v.uri); } catch {} }
        return;
      }
      done = true;
      clearTimeout(tm);
      resolve(v);
    };
    const tm = setTimeout(() => finish(null), timeoutMs);
    try {
      node.measureInWindow((x, y, w, h) => {
        if (!(w > 0 && h > 0) || !Number.isFinite(x) || !Number.isFinite(y)) { finish(null); return; }
        try {
          // eslint-disable-next-line global-require
          shot = require('react-native-view-shot');
        } catch { shot = null; }
        if (!shot || typeof shot.captureRef !== 'function') { finish(null); return; }
        let p;
        try {
          p = shot.captureRef(node, { format: 'png', result: 'tmpfile', quality: 1 });
        } catch { finish(null); return; }
        Promise.resolve(p)
          .then((uri) => finish(uri ? { uri, x, y, w, h } : null))
          .catch(() => finish(null));
      });
    } catch { finish(null); }
  });
}

export function releaseBubbleAnchor(anchor) {
  if (!anchor || !anchor.uri) return;
  try {
    // eslint-disable-next-line global-require
    const shot = require('react-native-view-shot');
    shot.releaseCapture && shot.releaseCapture(anchor.uri);
  } catch {}
}

// Pure layout: where the bubble / reaction bar / card end up.
//   anchor  { x, y, w, h, isOwn }
//   menuH   measured card height (0 = not measured yet)
//   menuW   card width
export function computeLiftLayout({ anchor, menuH = 0, menuW = 250, winW, winH, insets }) {
  const topSafe = ((insets && insets.top) || 0) + LIFT_GAP;
  const botSafe = winH - ((insets && insets.bottom) || 0) - LIFT_GAP;
  const mh = menuH || 0;
  const avail = botSafe - topSafe - LIFT_REACT_H - LIFT_GAP * 2 - mh;
  let s = 1;
  if (anchor.h > avail) s = Math.max(0.3, avail / anchor.h);
  const bh = anchor.h * s;
  const bw = anchor.w * s;
  // Keep the bubble where it is; move only as much as needed.
  let top = anchor.y;
  top = Math.min(top, botSafe - mh - LIFT_GAP - bh);
  top = Math.max(top, topSafe + LIFT_REACT_H + LIFT_GAP);
  const left = anchor.isOwn ? (anchor.x + anchor.w - bw) : anchor.x;
  // Card: aligned to the bubble's side, clamped inside the screen.
  const edge = 10;
  let cardLeft = anchor.isOwn ? (left + bw - menuW) : left;
  cardLeft = Math.max(edge, Math.min(cardLeft, winW - edge - menuW));
  let menuTop = top + bh + LIFT_GAP;
  if (mh) menuTop = Math.min(menuTop, botSafe - mh);
  return {
    s, top, left, bw, bh,
    // translate for a scale-about-center transform on the original rect
    tx: left - anchor.x - (anchor.w - bw) / 2,
    ty: top - anchor.y - (anchor.h - bh) / 2,
    reactTop: top - LIFT_GAP - LIFT_REACT_H,
    menuTop,
    cardLeft,
  };
}

// The snapshot, placed on the original rect, springing to layout.{tx,ty,s}.
export function LiftedBubble({ anchor, layout, onPress }) {
  const A = Rea.default;
  const tx = Rea.useSharedValue(0);
  const ty = Rea.useSharedValue(0);
  const sc = Rea.useSharedValue(1);
  const lx = layout ? layout.tx : 0;
  const ly = layout ? layout.ty : 0;
  const ls = layout ? layout.s : 1;
  useEffect(() => {
    if (!layout) {
      // Not measured yet: a tiny "lift" so the press is acknowledged at once.
      sc.set(Rea.withTiming(1.03, { duration: 110 }));
      return;
    }
    if (isReduceMotionEnabled()) {
      tx.set(lx); ty.set(ly); sc.set(ls);
      return;
    }
    tx.set(Rea.withSpring(lx, SPRING));
    ty.set(Rea.withSpring(ly, SPRING));
    sc.set(Rea.withSequence(
      Rea.withTiming(ls * 1.035, { duration: 110 }),
      Rea.withSpring(ls, SPRING),
    ));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!layout, lx, ly, ls]);
  const st = Rea.useAnimatedStyle(() => ({
    transform: [{ translateX: tx.get() }, { translateY: ty.get() }, { scale: sc.get() }],
  }));
  return (
    <A.View
      pointerEvents={onPress ? 'auto' : 'none'}
      style={[styles.bubble, { left: anchor.x, top: anchor.y, width: anchor.w, height: anchor.h }, st]}
      onTouchEnd={onPress}
    >
      <Image source={{ uri: anchor.uri }} style={{ width: anchor.w, height: anchor.h }} fadeDuration={0} />
    </A.View>
  );
}

// Reaction shelf above the bubble: pops from the bubble side.
export function LiftReactionBar({ top, alignRight, edgeInset = 10, maxWidth, scale = 1, children }) {
  const A = Rea.default;
  const p = Rea.useSharedValue(0);
  useEffect(() => {
    if (isReduceMotionEnabled()) { p.set(1); return; }
    p.set(Rea.withDelay ? Rea.withDelay(30, Rea.withSpring(1, { damping: 15, stiffness: 260 })) : Rea.withSpring(1, { damping: 15, stiffness: 260 }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const st = Rea.useAnimatedStyle(() => {
    const v = p.get();
    return {
      opacity: Math.min(1, v * 1.6),
      transform: [{ translateY: (1 - v) * 14 }, { scale: (0.7 + 0.3 * v) * scale }],
    };
  });
  return (
    <A.View
      style={[
        styles.react,
        { top, maxWidth, transformOrigin: alignRight ? 'right bottom' : 'left bottom' },
        alignRight ? { right: edgeInset } : { left: edgeInset },
        st,
      ]}
    >
      {children}
    </A.View>
  );
}

// Style overrides for the action card when it is a vertical list under the
// lifted bubble (WhatsApp/iOS context-menu look) instead of the icon grid.
export const LIFT_LIST_STYLES = {
  ctxIconBar: {
    flexDirection: 'column', flexWrap: 'nowrap', alignItems: 'stretch', justifyContent: 'flex-start',
    paddingVertical: 4, paddingHorizontal: 6, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  ctxIconBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start',
    paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10,
  },
  ctxIconCircle: {
    width: 30, height: 30, borderRadius: 9, marginRight: 12,
    justifyContent: 'center', alignItems: 'center',
  },
  ctxIconLabel: { fontSize: 15, fontWeight: '500', textAlign: 'left', flexShrink: 1 },
  ctxSecondaryList: { paddingVertical: 4, paddingHorizontal: 6 },
  ctxSecondaryItem: {
    flexDirection: 'row', alignItems: 'center', gap: 18,
    paddingVertical: 12, paddingLeft: 16, paddingRight: 10, borderRadius: 10,
  },
  ctxSecondaryText: { fontSize: 15, fontWeight: '500' },
};

const styles = StyleSheet.create({
  bubble: {
    position: 'absolute',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.22, shadowRadius: 18 },
      default: {},
    }),
  },
  react: {
    position: 'absolute',
    height: LIFT_REACT_H,
    justifyContent: 'center',
  },
});
