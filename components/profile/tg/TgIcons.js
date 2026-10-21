// [mural 2026-10-20] Ícones do perfil (mockup preview-2026/perfil.html): traço
// 1.8, pontas redondas, SVG puro — nada de emoji.
import React from 'react';
import Svg, { Path, Circle, Rect } from 'react-native-svg';
import { v2Stroke as _v2Stroke } from '../../../constants/theme';

const P = {
  back: <Path d="M15 5l-7 7 7 7" />,
  chev: <Path d="M9 5l7 7-7 7" />,
  phone: <Path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />,
  video: <><Rect x="2.5" y="6" width="13" height="12" rx="2.5" /><Path d="M15.5 10.5l6-3.5v10l-6-3.5" /></>,
  user: <><Rect x="3" y="3" width="18" height="18" rx="5" /><Circle cx="12" cy="10" r="3.2" /><Path d="M6.5 18.5c1.2-2.6 3.2-3.8 5.5-3.8s4.3 1.2 5.5 3.8" /></>,
  search: <><Circle cx="11" cy="11" r="7" /><Path d="M20 20l-4-4" /></>,
  bell: <><Path d="M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15z" /><Path d="M10 20.5a2 2 0 0 0 4 0" /></>,
  heart: <Path d="M12 20.5s-7.5-4.6-9.3-9.3A5 5 0 0 1 12 7.3a5 5 0 0 1 9.3 3.9C19.5 15.9 12 20.5 12 20.5z" />,
  comment: <Path d="M20.5 12a8.5 8.5 0 0 1-12.3 7.6L3.5 20.5l1-4.4A8.5 8.5 0 1 1 20.5 12z" />,
  share: <><Path d="M21 3.5L10.5 14" /><Path d="M21 3.5l-6.5 17.5-4-7-7-4z" /></>,
  grid: <><Rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><Rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><Rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><Rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></>,
  list: <><Rect x="4" y="4" width="16" height="7" rx="2" /><Rect x="4" y="14" width="16" height="6" rx="2" /></>,
  more: <><Circle cx="5.5" cy="12" r="1.3" fill="currentColor" /><Circle cx="12" cy="12" r="1.3" fill="currentColor" /><Circle cx="18.5" cy="12" r="1.3" fill="currentColor" /></>,
  image: <><Rect x="3" y="4.5" width="18" height="15" rx="3" /><Circle cx="9" cy="10" r="1.7" /><Path d="M21 16l-5-5-9 8.5" /></>,
  link: <><Path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><Path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  doc: <><Path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><Path d="M14 3v5h5" /></>,
  mic: <><Rect x="9" y="3" width="6" height="11" rx="3" /><Path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>,
  users: <><Circle cx="9" cy="8" r="3.5" /><Path d="M2.5 19.5c1-3.5 3.5-5 6.5-5s5.5 1.5 6.5 5" /><Path d="M16 4.5a3.5 3.5 0 0 1 0 7" /><Path d="M18 14.5c2 .6 3.2 2.2 3.8 5" /></>,
  block: <><Circle cx="12" cy="12" r="9" /><Path d="M5.6 5.6l12.8 12.8" /></>,
  flag: <Path d="M5 21V4h12l-2 4 2 4H5" />,
  plus: <Path d="M12 5v14M5 12h14" />,
  edit: <><Path d="M4 20h4L19 9l-4-4L4 16z" /><Path d="M13.5 6.5l4 4" /></>,
  globe: <><Circle cx="12" cy="12" r="9" /><Path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" /></>,
  lock: <><Rect x="5" y="11" width="14" height="10" rx="2.5" /><Path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  camera: <><Path d="M4 8h3l2-3h6l2 3h3v11H4z" /><Circle cx="12" cy="13" r="3.5" /></>,
  bookmark: <Path d="M6 3.5h12v17l-6-4-6 4z" />,
  stack: <><Rect x="7.5" y="7.5" width="13" height="13" rx="2.5" /><Path d="M4 16V6.5A2.5 2.5 0 0 1 6.5 4H16" /></>,
  star: <Path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z" />,
  clock: <><Circle cx="12" cy="12" r="9" /><Path d="M12 7v5l3 2" /></>,
  play: <Path d="M7 4.5v15l12-7.5z" />,
  pause: <><Rect x="6.5" y="5" width="3.5" height="14" rx="1" /><Rect x="14" y="5" width="3.5" height="14" rx="1" /></>,
  eye: <><Path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><Circle cx="12" cy="12" r="3" /></>,
  check: <Path d="M5 12.5l4.5 4.5L19 7.5" />,
  pin: <><Path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z" /><Circle cx="12" cy="10" r="2.3" /></>,
  wall: <><Path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.8 1.8-1.8 0-1.4-1.1-1.6-1.1-2.7 0-1 .8-1.6 1.8-1.6H17a4 4 0 0 0 4-4C21 6.5 17 3 12 3z" /><Circle cx="7.5" cy="11" r="1" /><Circle cx="10.5" cy="7.3" r="1" /><Circle cx="15" cy="7.8" r="1" /></>,
  shield: <Path d="M12 3l7.5 3v5.5c0 4.5-3.2 8.2-7.5 9.5-4.3-1.3-7.5-5-7.5-9.5V6z" />,
  sparkles: <><Path d="M12 3.5l1.6 4.4 4.4 1.6-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6z" /><Path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" /></>,
  chart: <Path d="M4 20V10M10 20V4M16 20v-7M21 20H3" />,
  calendar: <><Rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><Path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  export: <><Path d="M12 15V3.5M7.5 8L12 3.5 16.5 8" /><Path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></>,
  download: <><Path d="M12 3.5V15M7.5 10.5L12 15l4.5-4.5" /><Path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" /></>,
  archive: <><Rect x="3" y="4" width="18" height="5" rx="1.5" /><Path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4" /></>,
  trash: <><Path d="M4 7h16" /><Path d="M9 7V4.5h6V7" /><Path d="M6.5 7l1 13h9l1-13" /></>,
  logout: <><Path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><Path d="M10 16l-4-4 4-4M6 12h10" /></>,
  secret: <><Rect x="5" y="11" width="14" height="10" rx="2.5" /><Path d="M8 11V8a4 4 0 0 1 8 0v3" /><Circle cx="12" cy="16" r="1.2" /></>,
  music: <><Path d="M9 18V5l11-2v13" /><Circle cx="6.5" cy="18" r="2.5" /><Circle cx="17.5" cy="16" r="2.5" /></>,
  mapPin: <><Path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z" /><Circle cx="12" cy="10" r="2.3" /></>,
  bellOff: <><Path d="M6 16v-5a6 6 0 0 1 9.5-4.9M18 11v5l1.5 2H8" /><Path d="M10 20.5a2 2 0 0 0 4 0M3.5 3.5l17 17" /></>,
  palette: null,
  qr: <><Rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><Rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><Rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><Path d="M14 14h2.5v2.5H14zM18 18h2.5v2.5H18zM18 14h2.5M14 18v2.5" /></>,
};
P.palette = P.wall;

/** <TgIcon name="phone" size={24} color="#000" fill?="#f00" width?={1.8} /> */
export default function TgIcon({ name, size = 24, color = '#000', fill = 'none', strokeWidth: _sw, style }) {
  const strokeWidth = _v2Stroke(_sw, 1.8); // [2026-10-20 grafite] traço 1,6
  const body = P[name] || P.chev;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" color={color} style={style}>
      {body}
    </Svg>
  );
}

export function hasTgIcon(name) { return !!P[name]; }
