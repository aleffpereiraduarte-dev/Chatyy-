// components/watch/WatchIcons.js — [assistir-junto 2026-10-20] ícones SVG do "Assistir/Ouvir junto"
// (mesmo traço do mockup preview-2026/assistir-junto.html; sem emoji).
import React from 'react';
import Svg, { Path, Rect, Circle, Text as SvgText } from 'react-native-svg';

function I({ children, size = 24, color = '#111', strokeWidth = 1.8, style }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" style={style}>
      {children}
    </Svg>
  );
}

export function IconTogether({ size, color, style }) {
  return (
    <I size={size} color={color} style={style}>
      <Rect x="2.5" y="4" width="19" height="12" rx="2.5" />
      <Path d="M10 8v4l3.5-2z" fill={color} />
      <Circle cx="8" cy="19.5" r="1.5" />
      <Circle cx="16" cy="19.5" r="1.5" />
    </I>
  );
}
export function IconHeadphones({ size, color, style }) {
  return (
    <I size={size} color={color} style={style}>
      <Path d="M4 15v-3a8 8 0 0 1 16 0v3" />
      <Rect x="3" y="14" width="4.5" height="6.5" rx="1.8" />
      <Rect x="16.5" y="14" width="4.5" height="6.5" rx="1.8" />
    </I>
  );
}
export function IconPlayFill({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M7 4.5v15l12-7.5z" fill={color} stroke="none" /></I>;
}
export function IconPauseFill({ size, color, style }) {
  return (
    <I size={size} color={color} style={style}>
      <Rect x="6" y="4.5" width="4" height="15" rx="1.2" fill={color} stroke="none" />
      <Rect x="14" y="4.5" width="4" height="15" rx="1.2" fill={color} stroke="none" />
    </I>
  );
}
export function IconBack10({ size = 30, color, style }) {
  return (
    <I size={size} color={color} style={style} strokeWidth={1.6}>
      <Path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
      <Path d="M4 3.5v4h4" />
      <SvgText x="12" y="15.2" fontSize="7" fontWeight="700" fill={color} stroke="none" textAnchor="middle">10</SvgText>
    </I>
  );
}
export function IconFwd10({ size = 30, color, style }) {
  return (
    <I size={size} color={color} style={style} strokeWidth={1.6}>
      <Path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <Path d="M20 3.5v4h-4" />
      <SvgText x="12" y="15.2" fontSize="7" fontWeight="700" fill={color} stroke="none" textAnchor="middle">10</SvgText>
    </I>
  );
}
export function IconNextTrack({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M6 5v14l10-7z" fill={color} stroke="none" /><Path d="M18 5v14" strokeWidth={2.4} /></I>;
}
export function IconPrevTrack({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M18 5v14L8 12z" fill={color} stroke="none" /><Path d="M6 5v14" strokeWidth={2.4} /></I>;
}
export function IconQueue({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M4 6h12M4 12h12M4 18h7" /><Path d="M16 15v6l5-3z" fill={color} /></I>;
}
export function IconSync({ size, color, style }) {
  return (
    <I size={size} color={color} style={style}>
      <Path d="M20 11a8 8 0 0 0-14.3-4.5L4 8.5M4 13a8 8 0 0 0 14.3 4.5L20 15.5" />
      <Path d="M4 4v4.5h4.5M20 20v-4.5h-4.5" />
    </I>
  );
}
export function IconCrown({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M4 17l-1-10 5.5 4L12 5l3.5 6L21 7l-1 10z" /></I>;
}
export function IconClip({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.3 8.3a1.7 1.7 0 0 1-2.4-2.4l7.6-7.6" /></I>;
}
export function IconPd({ size, color, style }) {
  return <I size={size} color={color} style={style}><Circle cx="12" cy="12" r="9" /><Path d="M9.5 16.5v-9h3a2.6 2.6 0 0 1 0 5.2h-3" /></I>;
}
export function IconCc({ size, color, style }) {
  return <I size={size} color={color} style={style}><Circle cx="12" cy="12" r="9" /><Path d="M10.5 9.8a2.6 2.6 0 1 0 0 4.4M16.5 9.8a2.6 2.6 0 1 0 0 4.4" /></I>;
}
export function IconTv({ size, color, style }) {
  return <I size={size} color={color} style={style}><Rect x="3" y="6" width="18" height="12" rx="2.5" /><Path d="M8 3l4 3 4-3M9 21h6" /></I>;
}
export function IconChevronDown({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M5 9l7 7 7-7" /></I>;
}
export function IconHeart({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M12 20.5s-7.5-4.6-9.3-9.3A5 5 0 0 1 12 7.3a5 5 0 0 1 9.3 3.9C19.5 15.9 12 20.5 12 20.5z" fill={color} /></I>;
}
export function IconLaugh({ size, color, style }) {
  return (
    <I size={size} color={color} style={style}>
      <Circle cx="12" cy="12" r="9" />
      <Path d="M7.5 13h9a4.5 4.5 0 0 1-9 0z" fill={color} />
      <Path d="M8 9.5l1.5-1 1.5 1M13 9.5l1.5-1 1.5 1" />
    </I>
  );
}
export function IconFire({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M12 21c-4 0-6.5-2.6-6.5-6.2 0-3.6 3-5.6 3.6-9.3 2 1.2 3.4 3.3 3.6 5.6.9-.7 1.5-1.9 1.6-3.2 2.4 1.8 4.2 4.4 4.2 7.1 0 3.4-2.5 6-6.5 6z" /></I>;
}
export function IconWow({ size, color, style }) {
  return (
    <I size={size} color={color} style={style}>
      <Circle cx="12" cy="12" r="9" />
      <Circle cx="12" cy="15" r="2.4" fill={color} />
      <Circle cx="9" cy="9.5" r="1" fill={color} />
      <Circle cx="15" cy="9.5" r="1" fill={color} />
    </I>
  );
}

/** Ícone do selo da fonte (domínio público / CC / Jamendo / da conversa). */
export function SourceIcon({ source, size = 12, color }) {
  if (source === 'pd') return <IconPd size={size} color={color} />;
  if (source === 'conv') return <IconClip size={size} color={color} />;
  return <IconCc size={size} color={color} />;
}
