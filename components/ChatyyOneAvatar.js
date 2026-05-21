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

const ICON = require('../assets/icon.png');

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
// Purple matching the bubble exactly (sampled from the icon centre).
// When the eyelid is at scaleY=1 it fully covers the white pupils, giving
// a clean "closed eyes" look. When scaleY=0.05 the eyes are essentially
// open (we keep a 0.05 floor so the layer never disappears entirely —
// Android occasionally relayouts a 0-height view with a flash).
const EYELID_COLOR = '#7C3AED';

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
          backgroundColor: '#7C3AED',
        },
        style,
      ]}
      accessibilityLabel="Chatyy One"
      accessibilityRole="image"
    >
      <Image
        source={ICON}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        resizeMode="cover"
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
