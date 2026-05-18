// UploadProgressRing — reusable circular upload/download progress indicator.
//
// WhatsApp-style ring: light gray background circle + colored progress arc.
// Drop-in replacement for the horizontal bar uploads we ship today.
//
// Props:
//   progress      0.0 – 1.0 (clamped). 0 → empty ring, 1 → full circle.
//   size          outer width/height in px. Default 60.
//   strokeWidth   ring thickness. Default 4.
//   color         progress arc color. Default '#7C3AED' (brand purple).
//   bgColor       background ring color. Default 'rgba(255,255,255,0.25)'.
//   textColor     percent label color. Default '#fff'.
//   showPercent   show "{n}%" in the center. Default true.
//   paused        when true, replace percent label with a pause square (SVG).
//   style         passes through to the wrapper View for positioning.
//
// Differs from CircularProgressArc (the existing single-arc primitive):
//   - Renders TWO concentric circles (bg + fg) so the "track" is always visible
//     (matches WhatsApp). CircularProgressArc only draws the active arc.
//   - Uses strokeDasharray + strokeDashoffset (simpler math), not arc paths.
//   - Adds a centered text/pause indicator overlay.
// Keep CircularProgressArc for the existing chat-conversation overlays (3px
// inset, no track), use UploadProgressRing for new upload UI surfaces.

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle, Rect } from 'react-native-svg';

export default function UploadProgressRing({
  progress = 0,
  size = 60,
  strokeWidth = 4,
  color = '#7C3AED',
  bgColor = 'rgba(255,255,255,0.25)',
  textColor = '#fff',
  showPercent = true,
  paused = false,
  style,
}) {
  const p = Math.max(0, Math.min(1, Number(progress) || 0));
  const radius = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - p);
  const pct = Math.round(p * 100);

  // Pause square: 30% of inner diameter, centered.
  const pauseSize = Math.max(8, Math.round((size - strokeWidth * 2) * 0.3));
  const pauseX = cx - pauseSize / 2;
  const pauseY = cy - pauseSize / 2;

  return (
    <View style={[{ width: size, height: size }, style]}>
      <Svg
        width={size}
        height={size}
        // Rotate so the arc starts at 12 o'clock (default SVG circle starts at 3).
        style={{ transform: [{ rotate: '-90deg' }] }}
      >
        {/* Background track */}
        <Circle
          cx={cx}
          cy={cy}
          r={radius}
          stroke={bgColor}
          strokeWidth={strokeWidth}
          fill="none"
        />
        {/* Foreground progress arc */}
        <Circle
          cx={cx}
          cy={cy}
          r={radius}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={dashOffset}
        />
        {/* Pause indicator (drawn inside SVG, un-rotated via its own transform) */}
        {paused && (
          <Rect
            x={pauseX}
            y={pauseY}
            width={pauseSize}
            height={pauseSize}
            fill={textColor}
            rx={1}
            ry={1}
            // Counter-rotate so the square stays axis-aligned regardless of
            // the parent's -90deg rotation.
            transform={`rotate(90 ${cx} ${cy})`}
          />
        )}
      </Svg>
      {!paused && showPercent && (
        <View style={styles.labelWrap} pointerEvents="none">
          <Text
            style={[
              styles.label,
              {
                color: textColor,
                fontSize: Math.max(9, Math.round(size * 0.22)),
              },
            ]}
            numberOfLines={1}
          >
            {pct}%
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  labelWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontWeight: '600',
    textAlign: 'center',
    includeFontPadding: false,
  },
});
