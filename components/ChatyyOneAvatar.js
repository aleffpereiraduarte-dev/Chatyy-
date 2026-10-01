// Chatyy One avatar — app icon (assets/icon.png) with a blinking-eye overlay.
//
// The new app icon is a purple chat bubble with two white oval "eyes" baked
// into the artwork (see assets/icon.png). To make the mascot read as alive,
// we overlay two purple-tinted bars over those exact eye positions and
// animate their scaleY 0→1 in a 4–8s random cadence. When the overlay is
// at scaleY=0 the user sees the underlying white ovals (eyes open); when
// it scales to 1 it fully covers the white ovals (eyes closed = blink).
//
// Why a dedicated component:
//   1. The bot's avatar needs to match the actual app icon (WAVE 46 brand
//      refresh). Previously the AvatarCircle special-case painted a solid
//      purple circle + IconSparkles, which no longer matches the brand.
//   2. The user asked for "olho piscando" — a subtle organic motion so One
//      reads as alive, not a static logo.
//   3. Centralising it means AvatarCircle.js, ChatListTab.js quick-access
//      row, and the One header all share one source of truth — no more
//      copy-pasted purple circles.
//
// Performance notes:
//   - useNativeDriver:true so the JS thread is untouched — a 150ms
//      transform animation never registers as jank.
//   - Random next-blink delay (4000–8000ms) prevents every avatar on screen
//      from blinking in lockstep, which would look uncanny.
//   - unmount-guard with an isMounted ref so a navigation pop mid-timeout
//      doesn't fire setState on a dead component.

import React, { useEffect, useRef } from 'react';
import { View, Image, Animated } from 'react-native';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Circle as SvgCircle } from 'react-native-svg';

const ICON = require('../assets/icon.png');

// Per-instance gradient ids. react-native-svg resolves gradient `url(#id)`
// references by id within the document, so two avatars mounted at once
// (header size 18 + empty-state size 96 + streaming row) must not share an
// id or web renders the wrong fill. A module counter gives each mounted
// instance a stable, unique suffix (lazy-assigned once via a ref).
let _avatarIdSeq = 0;

// Eye positions are measured from the actual artwork in assets/icon.png
// (1254×1254 source). Normalised to fractions of `size` so the overlay
// scales correctly at any avatar diameter (24px chip → 96px empty state).
//
// The two oval eyes in the icon sit slightly above vertical center, ~12%
// of the icon width to either side of horizontal center. Each eye is
// roughly 10% wide × 14% tall (oval, taller than wide). The icon has a
// rounded-square frame, but our avatar is a circle (borderRadius=size/2),
// which crops the corners — the eyes themselves stay safely inside the
// circle.
const EYE_W_FRAC = 0.13;
const EYE_H_FRAC = 0.17;
const EYE_OFFSET_X_FRAC = 0.13; // distance of each eye from horizontal center
const EYE_TOP_FRAC = 0.39; // top of eye relative to avatar height
// Eyelid colour. It fully covers the white pupils at scaleY=1 for a clean
// "closed eyes" look. The bubble now carries a soft charcoal→black gradient
// (premium depth, still the founder's black&white mascot — no colour added),
// so the lid is tuned to the gradient's value at eye height (~47% down) and
// the blink (80ms close / 110ms open) is far too fast to read any seam.
const EYELID_COLOR = '#191A1F';
// Bubble gradient — subtle top-lit charcoal falling to near-black. Reads as a
// soft, modern mascot rather than a flat black disc, while staying monochrome.
const BUBBLE_TOP = '#2B2B31';
const BUBBLE_BOTTOM = '#0A0A0C';

// Random delay between 4s and 8s. Phase-offsetting blinks so two visible
// avatars don't blink in lockstep.
function randomBlinkDelay() {
  return 4000 + Math.random() * 4000;
}

export default function ChatyyOneAvatar({ size = 48, style, blink = true }) {
  // Eyelid scaleY: 0 = eyes fully open (overlay invisible), 1 = eyes closed.
  // We invert the more intuitive "open=1" so resting state lets the underlying
  // white pupils show through with a transform that compiles to identity.
  const lidScale = useRef(new Animated.Value(0)).current;
  const isMounted = useRef(true);
  // Lazy, stable per-instance id so concurrent avatars never share a gradient.
  const gradIdRef = useRef(null);
  if (gradIdRef.current === null) gradIdRef.current = `biaAv${_avatarIdSeq++}`;
  const gradId = gradIdRef.current;
  const sheenId = `${gradId}s`;

  useEffect(() => {
    isMounted.current = true;
    let timeoutId = null;

    const scheduleNext = () => {
      if (!isMounted.current) return;
      timeoutId = setTimeout(() => {
        if (!isMounted.current) return;
        // Two-step blink: close (80ms) then open (110ms). Slightly slower
        // re-open feels more natural — real eyelids drop fast, re-open
        // marginally slower.
        Animated.sequence([
          Animated.timing(lidScale, {
            toValue: 1,
            duration: 80,
            useNativeDriver: true,
          }),
          Animated.timing(lidScale, {
            toValue: 0,
            duration: 110,
            useNativeDriver: true,
          }),
        ]).start(() => scheduleNext());
      }, randomBlinkDelay());
    };

    if (blink) scheduleNext();

    return () => {
      isMounted.current = false;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [blink, lidScale]);

  const eyeW = Math.round(size * EYE_W_FRAC);
  const eyeH = Math.round(size * EYE_H_FRAC);
  const eyeOffsetX = Math.round(size * EYE_OFFSET_X_FRAC);
  const eyeTop = Math.round(size * EYE_TOP_FRAC);
  // borderRadius scales with the eye height so the eyelid keeps the same
  // pill shape as the underlying white pupil.
  const eyeRadius = Math.round(eyeH / 2);

  return (
    <View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          overflow: 'hidden',
          backgroundColor: BUBBLE_BOTTOM,
        },
        style,
      ]}
      accessibilityLabel="Bia"
      accessibilityRole="image"
    >
      {/* Bubble fill — soft charcoal→black gradient + a faint top sheen for a
          premium, lightly-lit mascot. Still monochrome (founder 2026-09-29:
          pure Uber black&white), just with depth instead of a flat disc. */}
      <Svg
        width={size}
        height={size}
        style={{ position: 'absolute', top: 0, left: 0 }}
        pointerEvents="none"
      >
        <Defs>
          <SvgLinearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={BUBBLE_TOP} />
            <Stop offset="1" stopColor={BUBBLE_BOTTOM} />
          </SvgLinearGradient>
          <SvgLinearGradient id={sheenId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#FFFFFF" stopOpacity="0.16" />
            <Stop offset="0.55" stopColor="#FFFFFF" stopOpacity="0" />
          </SvgLinearGradient>
        </Defs>
        <SvgCircle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${gradId})`} />
        <SvgCircle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${sheenId})`} />
      </Svg>
      {/* Two white eyes. The blink eyelids below cover these pupils on scaleY=1. */}
      <View
        pointerEvents="none"
        style={{ position: 'absolute', top: eyeTop, left: size / 2 - eyeOffsetX - eyeW / 2, width: eyeW, height: eyeH, borderRadius: eyeRadius, backgroundColor: '#FFFFFF' }}
      />
      <View
        pointerEvents="none"
        style={{ position: 'absolute', top: eyeTop, left: size / 2 + eyeOffsetX - eyeW / 2, width: eyeW, height: eyeH, borderRadius: eyeRadius, backgroundColor: '#FFFFFF' }}
      />
      {blink && (
        <>
          {/* Left eyelid — covers the icon's left white pupil when scaleY=1 */}
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: eyeTop,
              left: size / 2 - eyeOffsetX - eyeW / 2,
              width: eyeW,
              height: eyeH,
              borderRadius: eyeRadius,
              backgroundColor: EYELID_COLOR,
              transform: [{ scaleY: lidScale }],
            }}
          />
          {/* Right eyelid */}
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: eyeTop,
              left: size / 2 + eyeOffsetX - eyeW / 2,
              width: eyeW,
              height: eyeH,
              borderRadius: eyeRadius,
              backgroundColor: EYELID_COLOR,
              transform: [{ scaleY: lidScale }],
            }}
          />
        </>
      )}
    </View>
  );
}
