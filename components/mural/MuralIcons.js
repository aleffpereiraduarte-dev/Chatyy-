// [mural 2026-10-20] Ícones do mockup preview-2026/perfil.html (traço 1.8, pontas
// redondas), SVG puro — sem emoji. `fill` pinta o miolo (coração curtido etc.).
import React from 'react';
import Svg, { Path, Circle, Rect } from 'react-native-svg';

const P = {
  back: <Path d="M15 5l-7 7 7 7" />,
  heart: <Path d="M12 20.5s-7.5-4.6-9.3-9.3A5 5 0 0 1 12 7.3a5 5 0 0 1 9.3 3.9C19.5 15.9 12 20.5 12 20.5z" />,
  comment: <Path d="M20.5 12a8.5 8.5 0 0 1-12.3 7.6L3.5 20.5l1-4.4A8.5 8.5 0 1 1 20.5 12z" />,
  share: <><Path d="M21 3.5L10.5 14" /><Path d="M21 3.5l-6.5 17.5-4-7-7-4z" /></>,
  more: <><Circle cx="5.5" cy="12" r="1.3" fill="currentColor" /><Circle cx="12" cy="12" r="1.3" fill="currentColor" /><Circle cx="18.5" cy="12" r="1.3" fill="currentColor" /></>,
  x: <Path d="M6 6l12 12M18 6L6 18" />,
  image: <><Rect x="3" y="4.5" width="18" height="15" rx="3" /><Circle cx="9" cy="10" r="1.7" /><Path d="M21 16l-5-5-9 8.5" /></>,
  users: <><Circle cx="9" cy="8" r="3.5" /><Path d="M2.5 19.5c1-3.5 3.5-5 6.5-5s5.5 1.5 6.5 5" /><Path d="M16 4.5a3.5 3.5 0 0 1 0 7" /><Path d="M18 14.5c2 .6 3.2 2.2 3.8 5" /></>,
  globe: <><Circle cx="12" cy="12" r="9" /><Path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" /></>,
  lock: <><Rect x="5" y="11" width="14" height="10" rx="2.5" /><Path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  camera: <><Path d="M4 8h3l2-3h6l2 3h3v11H4z" /><Circle cx="12" cy="13" r="3.5" /></>,
  bookmark: <Path d="M6 3.5h12v17l-6-4-6 4z" />,
  stack: <><Rect x="7.5" y="7.5" width="13" height="13" rx="2.5" /><Path d="M4 16V6.5A2.5 2.5 0 0 1 6.5 4H16" /></>,
  up: <Path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />,
  eye: <><Path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><Circle cx="12" cy="12" r="3" /></>,
  plus: <Path d="M12 5v14M5 12h14" />,
  edit: <><Path d="M4 20h4L19 9l-4-4L4 16z" /><Path d="M13.5 6.5l4 4" /></>,
  trash: <><Path d="M4 7h16" /><Path d="M9 7V4.5h6V7" /><Path d="M6.5 7l1 13h9l1-13" /></>,
  check: <Path d="M5 12.5l4.5 4.5L19 7.5" />,
  play: <Path d="M7 4.5v15l12-7.5z" />,
};

export const AUD_ICON = { everyone: 'globe', contacts: 'users', only_me: 'lock' };

export default function MIcon({ name, size = 24, color = '#000', fill = 'none', strokeWidth = 1.8, style }) {
  const body = P[name];
  if (!body) return null;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={color} strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" color={color} style={style}>
      {body}
    </Svg>
  );
}
