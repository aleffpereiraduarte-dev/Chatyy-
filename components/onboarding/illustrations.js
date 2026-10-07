// [2026-10-07 welcome] Monochrome SVG illustrations for the welcome carousel,
// the first-run flow and the smart chat-list empty state. Black & white,
// theme-aware: every drawing takes { fg, bg, muted, size } so it inverts
// cleanly in dark mode (no hardcoded colors, no emoji, no raster assets).
import React from 'react';
import Svg, { Path, Rect, Circle, G } from 'react-native-svg';

/** Brand mark — rounded squircle + speech bubble with three dots. */
export function BrandMark({ size = 96, fg = '#111111', bg = '#ffffff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 96 96" fill="none">
      <Rect x="0" y="0" width="96" height="96" rx="28" fill={fg} />
      <Path
        d="M26 40c0-7.7 6.3-14 14-14h16c7.7 0 14 6.3 14 14v8c0 7.7-6.3 14-14 14H44l-10 9v-9.6c-4.8-2.2-8-7-8-12.4v-9z"
        stroke={bg} strokeWidth="4.5" strokeLinejoin="round"
      />
      <Circle cx="39" cy="44" r="3.2" fill={bg} />
      <Circle cx="48" cy="44" r="3.2" fill={bg} />
      <Circle cx="57" cy="44" r="3.2" fill={bg} />
    </Svg>
  );
}

/** Chat — incoming outline bubble + outgoing filled bubble with ✓✓ ticks. */
export function ChatArt({ size = 200, fg = '#111111', bg = '#ffffff', muted = '#E6E8EB' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 200 200" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <Circle cx="100" cy="100" r="92" fill={muted} opacity="0.55" />
      {/* incoming */}
      <Path d="M36 58c0-6.6 5.4-12 12-12h70c6.6 0 12 5.4 12 12v22c0 6.6-5.4 12-12 12H58l-14 10V91.4C39.3 89.6 36 85.2 36 80V58z" fill={bg} stroke={fg} strokeWidth="3" />
      <Rect x="50" y="60" width="58" height="6" rx="3" fill={fg} opacity="0.85" />
      <Rect x="50" y="73" width="38" height="6" rx="3" fill={fg} opacity="0.35" />
      {/* outgoing */}
      <Path d="M164 112c0-6.6-5.4-12-12-12H82c-6.6 0-12 5.4-12 12v22c0 6.6 5.4 12 12 12h60l14 10v-10.6c4.7-1.8 8-6.2 8-11.4v-22z" fill={fg} />
      <Rect x="84" y="114" width="56" height="6" rx="3" fill={bg} opacity="0.9" />
      <Rect x="84" y="127" width="30" height="6" rx="3" fill={bg} opacity="0.45" />
      <Path d="M125 131l4 4 7-8M132 135l7-8" stroke={bg} strokeWidth="2.6" />
    </Svg>
  );
}

/** Calls — avatar with sound rings + handset and camera badges. */
export function CallsArt({ size = 200, fg = '#111111', bg = '#ffffff', muted = '#E6E8EB' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 200 200" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <Circle cx="100" cy="100" r="92" fill={muted} opacity="0.55" />
      <Circle cx="100" cy="92" r="58" stroke={fg} strokeWidth="2" opacity="0.18" />
      <Circle cx="100" cy="92" r="44" stroke={fg} strokeWidth="2" opacity="0.32" />
      <Circle cx="100" cy="92" r="30" fill={fg} />
      <Circle cx="100" cy="85" r="9" fill={bg} />
      <Path d="M84 108c3-7.5 9-11 16-11s13 3.5 16 11" fill={bg} />
      {/* handset badge */}
      <G transform="translate(52, 138)">
        <Circle cx="18" cy="18" r="18" fill={fg} />
        <Path d="M11.5 12.5c0-1 .8-1.8 1.8-1.8h2.2l1.4 3.6-1.6 1.2a10 10 0 0 0 4.9 4.9l1.2-1.6 3.6 1.4v2.2c0 1-.8 1.8-1.8 1.8A11.7 11.7 0 0 1 11.5 12.5z" fill={bg} />
      </G>
      {/* camera badge */}
      <G transform="translate(112, 138)">
        <Circle cx="18" cy="18" r="18" fill={bg} stroke={fg} strokeWidth="2.5" />
        <Rect x="9" y="13" width="13" height="10" rx="2.5" stroke={fg} strokeWidth="2.2" />
        <Path d="M22 16.5l5-3v9l-5-3" stroke={fg} strokeWidth="2.2" />
      </G>
    </Svg>
  );
}

/** E-mail + Drive — envelope card overlapping a folder card. */
export function MailDriveArt({ size = 200, fg = '#111111', bg = '#ffffff', muted = '#E6E8EB' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 200 200" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <Circle cx="100" cy="100" r="92" fill={muted} opacity="0.55" />
      {/* folder (back) */}
      <Path d="M70 62h26l8 9h42c4.4 0 8 3.6 8 8v50c0 4.4-3.6 8-8 8H70c-4.4 0-8-3.6-8-8V70c0-4.4 3.6-8 8-8z" fill={fg} />
      <Rect x="76" y="86" width="56" height="5" rx="2.5" fill={bg} opacity="0.35" />
      {/* envelope (front) */}
      <Rect x="38" y="98" width="88" height="60" rx="10" fill={bg} stroke={fg} strokeWidth="3" />
      <Path d="M42 104l40 28 40-28" stroke={fg} strokeWidth="3" />
      {/* @ badge */}
      <Circle cx="132" cy="150" r="16" fill={fg} />
      <Circle cx="132" cy="150" r="4.2" stroke={bg} strokeWidth="2.2" />
      <Path d="M136.2 150v1.8c0 2 2.8 2.4 3.3 0 1.2-6-3.4-10-8.3-9.5a7.8 7.8 0 1 0 4.6 14.4" stroke={bg} strokeWidth="2.2" />
    </Svg>
  );
}

/** Contacts discovery — three overlapping avatars + magnifier. */
export function FriendsArt({ size = 160, fg = '#111111', bg = '#ffffff', muted = '#E6E8EB' }) {
  // Person glyph inside a circle: head + shoulders arc.
  const person = (cx, cy, r, filled) => {
    const ink = filled ? bg : fg;
    const hr = r * 0.3;
    const sy = cy + r * 0.62;
    const sw = r * 0.58;
    return (
      <G key={`${cx}-${cy}`}>
        <Circle cx={cx} cy={cy} r={r} fill={filled ? fg : bg} stroke={fg} strokeWidth="3" />
        <Circle cx={cx} cy={cy - r * 0.18} r={hr} fill={ink} />
        <Path d={`M${cx - sw} ${sy}a${sw} ${sw * 0.85} 0 0 1 ${sw * 2} 0z`} fill={ink} />
      </G>
    );
  };
  return (
    <Svg width={size} height={size} viewBox="0 0 160 160" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <Circle cx="80" cy="80" r="74" fill={muted} opacity="0.55" />
      {person(48, 82, 21, false)}
      {person(112, 82, 21, false)}
      {person(80, 74, 27, true)}
      <G transform="translate(98, 100)">
        <Circle cx="13" cy="13" r="11" fill={bg} stroke={fg} strokeWidth="3.5" />
        <Path d="M21.5 21.5l8 8" stroke={fg} strokeWidth="4.5" />
      </G>
    </Svg>
  );
}

/** Notifications — bell with a message badge. */
export function BellArt({ size = 160, fg = '#111111', bg = '#ffffff', muted = '#E6E8EB' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 160 160" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <Circle cx="80" cy="80" r="74" fill={muted} opacity="0.55" />
      <Path d="M80 38c-15.5 0-28 12.5-28 28v17l-8 14h72l-8-14V66c0-15.5-12.5-28-28-28z" fill={fg} />
      <Path d="M70 104a10 10 0 0 0 20 0" stroke={fg} strokeWidth="5" />
      <G transform="translate(96, 34)">
        <Rect x="0" y="0" width="38" height="28" rx="10" fill={bg} stroke={fg} strokeWidth="3" />
        <Circle cx="11" cy="14" r="2.6" fill={fg} />
        <Circle cx="19" cy="14" r="2.6" fill={fg} />
        <Circle cx="27" cy="14" r="2.6" fill={fg} />
      </G>
    </Svg>
  );
}

/** Small shield-with-lock used next to the privacy disclosure. */
export function ShieldGlyph({ size = 20, color = '#111111' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 2.5l8 3v6c0 5-3.4 8.7-8 10-4.6-1.3-8-5-8-10v-6l8-3z" />
      <Rect x="9" y="11" width="6" height="5" rx="1" />
      <Path d="M10 11V9.5a2 2 0 0 1 4 0V11" />
    </Svg>
  );
}

/** Mini phone preview for the theme picker (light / dark / split = system). */
export function ThemeSwatch({ mode = 'light', size = 64, fg = '#111111' }) {
  const L = '#ffffff'; const D = '#111111'; const LM = '#E6E8EB'; const DM = '#3A3A3C';
  const half = mode === 'system';
  const base = mode === 'dark' ? D : L;
  const line = mode === 'dark' ? DM : LM;
  return (
    <Svg width={size} height={size * 1.4} viewBox="0 0 50 70" fill="none">
      <Rect x="1.5" y="1.5" width="47" height="67" rx="9" fill={base} stroke={fg} strokeWidth="2" />
      {half ? <Path d="M25 2.5h14.5a8 8 0 0 1 8 8v49a8 8 0 0 1-8 8H25z" fill={D} /> : null}
      <Rect x="8" y="12" width="20" height="7" rx="3.5" fill={half ? LM : line} />
      <Rect x="22" y="25" width="20" height="7" rx="3.5" fill={half ? DM : (mode === 'dark' ? '#ffffff' : D)} />
      <Rect x="8" y="38" width="16" height="7" rx="3.5" fill={half ? LM : line} />
      <Rect x="26" y="51" width="16" height="7" rx="3.5" fill={half ? DM : (mode === 'dark' ? '#ffffff' : D)} />
    </Svg>
  );
}
