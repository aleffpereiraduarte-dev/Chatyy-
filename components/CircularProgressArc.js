// CircularProgressArc — single-arc progress circle.
//
// Replaces 7 inline copies of the same SVG path math sprinkled across
// chat-conversation.js (image/video/audio/file upload + download rings) and
// ChatListTab.js (status-publish ring). Each copy hard-coded the radius
// and inverted the rotate trick separately; this primitive owns the math.
//
// Props:
//   pct          0–100 (clamped). 0 → invisible arc, 100 → full circle.
//   size         outer width/height of the SVG. Default 68 (chat parity).
//   strokeWidth  arc thickness. Default 3.5.
//   color        stroke color. Default #fff (over-image overlays).
//   style        passes through to <Svg> for absolute positioning, etc.
//
// Math: the arc starts at the 12 o'clock position (rotate -90°) and
// sweeps clockwise. The endpoint is computed via standard
// (sin, 1−cos) on a unit circle scaled by r. The `large-arc-flag` flips
// at 50% so the path doesn't take the long way around.

import React from 'react';
import Svg, { Path } from 'react-native-svg';

export default function CircularProgressArc({
  pct = 0,
  size = 68,
  strokeWidth = 3.5,
  color = '#fff',
  // Distance from the outer SVG edge to where the arc sits. Defaults to 3px
  // (chat-conversation visual tuning). ChatListTab status-publish uses
  // `inset={5}` for its larger 120px ring — keeps the arc concentric with
  // the parent's 3px outer border + breathing room.
  inset = 3,
  style,
}) {
  const p = Math.max(0, Math.min(100, pct)) / 100;
  const r = (size / 2) - inset;
  const cx = size / 2;
  const yStart = inset;
  const dx = r * Math.sin(p * 2 * Math.PI);
  const dy = r - r * Math.cos(p * 2 * Math.PI);
  const largeArc = p > 0.5 ? 1 : 0;
  const d = `M${cx},${yStart} a${r},${r} 0 ${largeArc},1 ${dx},${dy}`;
  return (
    <Svg
      width={size}
      height={size}
      style={[{ transform: [{ rotate: '-90deg' }] }, style]}
    >
      <Path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}
