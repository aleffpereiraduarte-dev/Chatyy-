// ConnectionBars — Telegram-style signal indicator
// =================================================
// Renders 4 vertical bars whose color + active count map to a 0-4 quality
// level. NO numeric/ms text is shown — clients reading a ping in ms tend
// to think their connection is bad even when 230ms is perfectly fine for
// a voice call. Bars are universal and read as "signal" instantly.
//
// Level mapping (callers compute from RTT + packet loss):
//   0 : red          (rtt > 400ms OR loss > 8%)   — really bad
//   1 : orange       (rtt > 200ms OR loss > 4%)   — bad
//   2 : yellow       (rtt > 100ms OR loss > 1%)   — meh
//   3 : green        (rtt > 50ms)                 — good
//   4 : bright green (rtt <= 50ms AND loss<0.5%)  — excellent
//
// Inactive bars render at opacity 0.25 so the silhouette stays readable
// against any background (light or dark).
//
// Telegram pattern: callers can choose to HIDE the component once quality
// is >= 3 — "no news is good news". Drawing it only when there's a
// problem is what makes the user trust the indicator when it shows.
import React from 'react';
import { View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';

const COLOR_BY_LEVEL = {
  0: '#ef4444', // red
  1: '#f97316', // orange
  2: '#f59e0b', // amber/yellow
  3: '#22c55e', // green
  4: '#16a34a', // brighter green
};

// 4 bars, increasing heights. Width 3, gap 1.5, radius 1.
// Heights chosen so the silhouette reads as a clean staircase (~4/6/9/12)
// at the default size of 18px tall. Bars are bottom-aligned via y-coord.
const BAR_HEIGHTS = [4, 6, 9, 12];
const BAR_WIDTH = 3;
const BAR_GAP = 1.5;
const VIEW_WIDTH = BAR_HEIGHTS.length * BAR_WIDTH + (BAR_HEIGHTS.length - 1) * BAR_GAP; // 16.5
const VIEW_HEIGHT = 12;

export default function ConnectionBars({ level = 4, size = 18, color: colorOverride, style }) {
  const lvl = Math.max(0, Math.min(4, Number(level) || 0));
  const fill = colorOverride || COLOR_BY_LEVEL[lvl] || COLOR_BY_LEVEL[4];
  // Scale to caller-requested size while preserving the aspect ratio of
  // the source 16.5×12 box. We render width-proportional so 4 bars at
  // size=18 fit the original ~14px height of the call status strip.
  const w = (VIEW_WIDTH / VIEW_HEIGHT) * size;
  return (
    <View style={[{ width: w, height: size, alignItems: 'flex-end' }, style]}>
      <Svg width={w} height={size} viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}>
        {BAR_HEIGHTS.map((h, i) => {
          const x = i * (BAR_WIDTH + BAR_GAP);
          const y = VIEW_HEIGHT - h;
          // Active bars are i < lvl. Level 0 = all inactive (still draws
          // silhouette so user sees "no signal" instead of nothing).
          const active = i < lvl;
          return (
            <Rect
              key={i}
              x={x}
              y={y}
              width={BAR_WIDTH}
              height={h}
              rx={1}
              ry={1}
              fill={fill}
              opacity={active ? 1 : 0.25}
            />
          );
        })}
      </Svg>
    </View>
  );
}
