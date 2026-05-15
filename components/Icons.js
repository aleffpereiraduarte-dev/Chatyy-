// SVG Icon Library — Material Design Outlined style
// Cross-platform: uses react-native-svg (works on iOS, Android, and Web)

import React from 'react';
import Svg, { Line, Circle, Path, Polyline, Polygon, Rect, G, Ellipse } from 'react-native-svg';

// Base wrapper.
// Why: bumped default stroke from 2 → 1.9 (Lucide-standard) so icons read
// less industrial and match the polished feel of the rest of the UI.
// Added strokeMiterlimit=10 so sharp corners (e.g. chevrons) don't spike
// when react-native-svg falls back to the platform default of 4.
function I({ children, size = 24, color = 'currentColor', fill = 'none', style, strokeWidth = 1.9, viewBox = '0 0 24 24', ...props }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill={fill}
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeMiterlimit={10}
      style={typeof style === 'object' ? style : undefined}
      {...props}
    >
      {children}
    </Svg>
  );
}

// ===================== NAVIGATION =====================

export function IconMenu({ size, color, style }) {
  return <I size={size} color={color} style={style}><Line x1="3" y1="12" x2="21" y2="12"/><Line x1="3" y1="6" x2="21" y2="6"/><Line x1="3" y1="18" x2="21" y2="18"/></I>;
}

export function IconX({ size, color, style }) {
  return <I size={size} color={color} style={style}><Line x1="18" y1="6" x2="6" y2="18"/><Line x1="6" y1="6" x2="18" y2="18"/></I>;
}

export function IconArrowLeft({ size, color, style }) {
  return <I size={size} color={color} style={style}><Line x1="19" y1="12" x2="5" y2="12"/><Polyline points="12 19 5 12 12 5"/></I>;
}

export function IconArrowRight({ size, color, style }) {
  return <I size={size} color={color} style={style}><Line x1="5" y1="12" x2="19" y2="12"/><Polyline points="12 5 19 12 12 19"/></I>;
}

export function IconChevronLeft({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polyline points="15 18 9 12 15 6"/></I>;
}

export function IconChevronRight({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polyline points="9 18 15 12 9 6"/></I>;
}

export function IconChevronDown({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polyline points="6 9 12 15 18 9"/></I>;
}

export function IconSearch({ size, color, style }) {
  return <I size={size} color={color} style={style}><Circle cx="11" cy="11" r="8"/><Line x1="21" y1="21" x2="16.65" y2="16.65"/></I>;
}

export function IconRefresh({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polyline points="23 4 23 10 17 10"/><Polyline points="1 20 1 14 7 14"/><Path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></I>;
}

export function IconSettings({ size, color, style }) {
  return <I size={size} color={color} style={style}><Circle cx="12" cy="12" r="3"/><Path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></I>;
}

export function IconSun({ size, color, style }) {
  return <I size={size} color={color} style={style}><Circle cx="12" cy="12" r="5"/><Line x1="12" y1="1" x2="12" y2="3"/><Line x1="12" y1="21" x2="12" y2="23"/><Line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><Line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><Line x1="1" y1="12" x2="3" y2="12"/><Line x1="21" y1="12" x2="23" y2="12"/><Line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><Line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></I>;
}

export function IconMoon({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></I>;
}

// ===================== EMAIL =====================

export function IconMail({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><Polyline points="22,6 12,13 2,6"/></I>;
}

export function IconInbox({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><Path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></I>;
}

export function IconSend({ size, color, style }) {
  return <I size={size} color={color} style={style}><Line x1="22" y1="2" x2="11" y2="13"/><Polygon points="22 2 15 22 11 13 2 9 22 2"/></I>;
}

export function IconDraft({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><Path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></I>;
}

export function IconTrash({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polyline points="3 6 5 6 21 6"/><Path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><Line x1="10" y1="11" x2="10" y2="17"/><Line x1="14" y1="11" x2="14" y2="17"/></I>;
}

export function IconAlertTriangle({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><Line x1="12" y1="9" x2="12" y2="13"/><Line x1="12" y1="17" x2="12.01" y2="17"/></I>;
}

export function IconAlertCircle({ size, color, style }) {
  return <I size={size} color={color} style={style}><Circle cx="12" cy="12" r="10"/><Line x1="12" y1="8" x2="12" y2="12"/><Line x1="12" y1="16" x2="12.01" y2="16"/></I>;
}

export function IconArchive({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polyline points="21 8 21 21 3 21 3 8"/><Rect x="1" y="3" width="22" height="5" rx="1"/><Line x1="10" y1="12" x2="14" y2="12"/></I>;
}

export function IconStar({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></I>;
}

export function IconStarFilled({ size, color, style }) {
  return <I size={size} color={color} fill={color} strokeWidth={0} style={style}><Polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></I>;
}

export function IconReply({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polyline points="9 17 4 12 9 7"/><Path d="M20 18v-2a4 4 0 0 0-4-4H4"/></I>;
}

export function IconReplyAll({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polyline points="7 17 2 12 7 7"/><Polyline points="12 17 7 12 12 7"/><Path d="M22 18v-2a4 4 0 0 0-4-4H7"/></I>;
}

export function IconForward({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polyline points="15 17 20 12 15 7"/><Path d="M4 18v-2a4 4 0 0 1 4-4h12"/></I>;
}

export function IconCompose({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M12 20h9"/><Path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></I>;
}

export function IconMailOpen({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0l8 6z"/><Polyline points="22,10 12,17 2,10"/></I>;
}

// ===================== USER =====================

export function IconUser({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><Circle cx="12" cy="7" r="4"/></I>;
}

export function IconVolume2({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><Path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><Path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></I>;
}

export function IconVolumeX({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><Line x1="23" y1="9" x2="17" y2="15"/><Line x1="17" y1="9" x2="23" y2="15"/></I>;
}

export function IconUserPlus({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><Circle cx="8.5" cy="7" r="4"/><Line x1="20" y1="8" x2="20" y2="14"/><Line x1="23" y1="11" x2="17" y2="11"/></I>;
}

export function IconLogout({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><Polyline points="16 17 21 12 16 7"/><Line x1="21" y1="12" x2="9" y2="12"/></I>;
}

export function IconLock({ size, color, style }) {
  return <I size={size} color={color} style={style}><Rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><Path d="M7 11V7a5 5 0 0 1 10 0v4"/></I>;
}

export function IconPhone({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></I>;
}

export function IconCalendar({ size, color, style }) {
  return <I size={size} color={color} style={style}><Rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><Line x1="16" y1="2" x2="16" y2="6"/><Line x1="8" y1="2" x2="8" y2="6"/><Line x1="3" y1="10" x2="21" y2="10"/></I>;
}

export function IconCake({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8"/><Path d="M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2.5 2 4 2 2-1 2-1"/><Path d="M2 21h20"/><Path d="M7 8v2"/><Path d="M12 8v2"/><Path d="M17 8v2"/><Path d="M7 4h.01"/><Path d="M12 4h.01"/><Path d="M17 4h.01"/></I>;
}

// ===================== ATTACHMENTS =====================

export function IconFileText({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><Polyline points="14 2 14 8 20 8"/><Line x1="16" y1="13" x2="8" y2="13"/><Line x1="16" y1="17" x2="8" y2="17"/><Polyline points="10 9 9 9 8 9"/></I>;
}

export function IconBarChart({ size, color, style }) {
  return <I size={size} color={color} style={style}><Line x1="12" y1="20" x2="12" y2="10"/><Line x1="18" y1="20" x2="18" y2="4"/><Line x1="6" y1="20" x2="6" y2="16"/></I>;
}

export function IconImage({ size, color, style }) {
  return <I size={size} color={color} style={style}><Rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><Circle cx="8.5" cy="8.5" r="1.5"/><Polyline points="21 15 16 10 5 21"/></I>;
}

export function IconPackage({ size, color, style }) {
  return <I size={size} color={color} style={style}><Line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><Path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><Polyline points="3.27 6.96 12 12.01 20.73 6.96"/><Line x1="12" y1="22.08" x2="12" y2="12"/></I>;
}

export function IconMusic({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M9 18V5l12-2v13"/><Circle cx="6" cy="18" r="3"/><Circle cx="18" cy="16" r="3"/></I>;
}

export function IconFilm({ size, color, style }) {
  return <I size={size} color={color} style={style}><Rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><Line x1="7" y1="2" x2="7" y2="22"/><Line x1="17" y1="2" x2="17" y2="22"/><Line x1="2" y1="12" x2="22" y2="12"/><Line x1="2" y1="7" x2="7" y2="7"/><Line x1="2" y1="17" x2="7" y2="17"/><Line x1="17" y1="17" x2="22" y2="17"/><Line x1="17" y1="7" x2="22" y2="7"/></I>;
}

// Round-video-note icon (Telegram/iMessage video-note button). A circle
// with a play triangle inside — distinguishes "round short video note"
// from the rectangular IconVideo (call) and IconFilm (gallery).
export function IconVideoNote({ size, color, style }) {
  return (
    <I size={size} color={color} style={style}>
      <Circle cx="12" cy="12" r="9"/>
      <Path d="M10 8.5l5.5 3.5L10 15.5z" fill={color || 'currentColor'} strokeWidth={0}/>
    </I>
  );
}

export function IconPaperclip({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></I>;
}

export function IconFolder({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></I>;
}

// ===================== AI =====================

export function IconSparkles({ size, color, style }) {
  return (
    <I size={size} color={color} fill={color} strokeWidth={0} style={style}>
      <Path d="M12 2L13.09 8.26L18 6L14.74 10.91L22 12L14.74 13.09L18 18L13.09 15.74L12 22L10.91 15.74L6 18L9.26 13.09L2 12L9.26 10.91L6 6L10.91 8.26L12 2Z"/>
    </I>
  );
}

export function IconMessageSquare({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></I>;
}

export function IconPenTool({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M12 19l7-7 3 3-7 7-3-3z"/><Path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><Path d="M2 2l7.586 7.586"/><Circle cx="11" cy="11" r="2"/></I>;
}

// ===================== STATUS =====================

export function IconCheck({ size, color, style, strokeWidth }) {
  return <I size={size} color={color} strokeWidth={strokeWidth} style={style}><Polyline points="20 6 9 17 4 12"/></I>;
}

export function IconCheckCircle({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><Polyline points="22 4 12 14.01 9 11.01"/></I>;
}

// WhatsApp Business / X premium-style verified badge — filled circle with a
// white checkmark. Used on call screens and contact rows when the caller's
// number is Telnyx-verified (telnyx_caller_id_verified flag). The fill color
// is rendered via the `color` prop so callers can pass brand blue or green.
export function IconVerifiedBadge({ size = 14, color = '#007AFF', style }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" style={typeof style === 'object' ? style : undefined}>
      <Circle cx="12" cy="12" r="11" fill={color} stroke="none" />
      <Polyline
        points="7.5 12.5 10.5 15.5 16.5 9"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function IconEye({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><Circle cx="12" cy="12" r="3"/></I>;
}

export function IconEyeOff({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><Line x1="1" y1="1" x2="23" y2="23"/></I>;
}

export function IconParty({ size, color, style }) {
  return (
    <I size={size} color={color} style={style}>
      <Path d="M5.8 11.3L2 22l10.7-3.79"/><Path d="M4 3h.01"/><Path d="M22 8h.01"/><Path d="M15 2h.01"/><Path d="M22 20h.01"/><Path d="M22 2l-2.24.75a2.9 2.9 0 0 0-1.96 3.12v0c.1.86-.57 1.63-1.45 1.63h-.38c-.86 0-1.6.6-1.76 1.44L14 10"/><Path d="M22 13l-1.34-.45a2.9 2.9 0 0 0-3.12 1.96v0a1.53 1.53 0 0 1-1.46 1.05 1.46 1.46 0 0 1-1.08-.57L14 14"/>
    </I>
  );
}

// ===================== GMAIL FEATURES =====================

export function IconCheckbox({ size, color, style }) {
  return <I size={size} color={color} style={style}><Rect x="3" y="3" width="18" height="18" rx="2"/></I>;
}

export function IconCheckboxChecked({ size, color, style }) {
  return <I size={size} color={color} style={style}><Rect x="3" y="3" width="18" height="18" rx="2"/><Polyline points="9 11 12 14 22 4" strokeWidth="2.5"/></I>;
}

export function IconMarkRead({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0l8 6z"/><Polyline points="22,10 12,17 2,10"/></I>;
}

export function IconMarkUnread({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><Polyline points="22,6 12,13 2,6"/><Circle cx="18" cy="5" r="3" fill={color} stroke="none"/></I>;
}

export function IconClock({ size, color, style }) {
  return <I size={size} color={color} style={style}><Circle cx="12" cy="12" r="10"/><Polyline points="12 6 12 12 16 14"/></I>;
}

export function IconTag({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><Line x1="7" y1="7" x2="7.01" y2="7"/></I>;
}

export function IconUndo({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polyline points="1 4 1 10 7 10"/><Path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></I>;
}

// Image-editor toolbar icons (rotate / flip / crop / pencil / HD).
// Modern lucide-style strokes so the preview header stops looking like
// emoji art (↺ ↻ ⇋ ⇅ ⌗ ✏️ → SVGs).
export function IconRotateCcw({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polyline points="1 4 1 10 7 10"/><Path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></I>;
}
export function IconRotateCw({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polyline points="23 4 23 10 17 10"/><Path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></I>;
}
export function IconFlipHorizontal({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M3 7V5a2 2 0 0 1 2-2h2"/><Path d="M17 3h2a2 2 0 0 1 2 2v2"/><Path d="M21 17v2a2 2 0 0 1-2 2h-2"/><Path d="M7 21H5a2 2 0 0 1-2-2v-2"/><Line x1="12" y1="3" x2="12" y2="21"/></I>;
}
export function IconFlipVertical({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M7 3H5a2 2 0 0 0-2 2v2"/><Path d="M3 17v2a2 2 0 0 0 2 2h2"/><Path d="M17 21h2a2 2 0 0 0 2-2v-2"/><Path d="M21 7V5a2 2 0 0 0-2-2h-2"/><Line x1="3" y1="12" x2="21" y2="12"/></I>;
}
export function IconCrop({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M6.13 1L6 16a2 2 0 0 0 2 2h15"/><Path d="M1 6.13L16 6a2 2 0 0 1 2 2v15"/></I>;
}
export function IconPencil({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M12 20h9"/><Path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></I>;
}

export function IconMoreVert({ size, color, style }) {
  return <I size={size} color={color} fill={color} strokeWidth={0} style={style}><Circle cx="12" cy="5" r="1.5"/><Circle cx="12" cy="12" r="1.5"/><Circle cx="12" cy="19" r="1.5"/></I>;
}

export function IconBold({ size, color, style }) {
  return <I size={size} color={color} strokeWidth={2.5} style={style}><Path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/><Path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/></I>;
}

export function IconItalic({ size, color, style }) {
  return <I size={size} color={color} style={style}><Line x1="19" y1="4" x2="10" y2="4"/><Line x1="14" y1="20" x2="5" y2="20"/><Line x1="15" y1="4" x2="9" y2="20"/></I>;
}

export function IconUnderline({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3"/><Line x1="4" y1="21" x2="20" y2="21"/></I>;
}

export function IconLink({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><Path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></I>;
}

export function IconAttach({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></I>;
}

export function IconFilter({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></I>;
}

export function IconInfo({ size, color, style }) {
  return <I size={size} color={color} style={style}><Circle cx="12" cy="12" r="10"/><Line x1="12" y1="16" x2="12" y2="12"/><Line x1="12" y1="8" x2="12.01" y2="8"/></I>;
}

export function IconGlobe({ size, color, style }) {
  return <I size={size} color={color} style={style}><Circle cx="12" cy="12" r="10"/><Line x1="2" y1="12" x2="22" y2="12"/><Path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></I>;
}

export function IconSmartphone({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M12 18h.01"/><Rect x="6" y="3" width="12" height="18" rx="2" ry="2"/></I>;
}

export function IconDownload({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><Polyline points="7 10 12 15 17 10"/><Line x1="12" y1="15" x2="12" y2="3"/></I>;
}

export function IconPrint({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polyline points="6 9 6 2 18 2 18 9"/><Path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><Rect x="6" y="14" width="12" height="8"/></I>;
}

export function IconFlag({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><Line x1="4" y1="22" x2="4" y2="15"/></I>;
}

export function IconShield({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></I>;
}

export function IconZap({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></I>;
}

// Branded mail logo
export function IconMailLogo({ size = 32, color, style }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={typeof style === 'object' ? style : undefined}>
      <Rect x="2" y="6" width="28" height="20" rx="4" fill={color} opacity="0.15"/>
      <Rect x="3" y="7" width="26" height="18" rx="3" stroke={color} strokeWidth="1.8" fill="none"/>
      <Path d="M3 10l12.2 8.2a1.5 1.5 0 001.6 0L29 10" stroke={color} strokeWidth="1.8" strokeLinecap="round" fill="none"/>
      <Circle cx="24" cy="11" r="5" fill={color}/>
      <Path d="M22 11l1.5 1.5L25.5 9.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </Svg>
  );
}

export function IconAtSign({ size, color, style }) {
  return <I size={size} color={color} style={style}><Circle cx="12" cy="12" r="4"/><Path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/></I>;
}

export function IconHelpCircle({ size, color, style }) {
  return <I size={size} color={color} style={style}><Circle cx="12" cy="12" r="10"/><Path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><Line x1="12" y1="17" x2="12.01" y2="17"/></I>;
}

export function IconAward({ size, color, style }) {
  return <I size={size} color={color} style={style}><Circle cx="12" cy="8" r="6"/><Path d="m8.21 13.89-1.21 8.61 5-3 5 3-1.21-8.62"/></I>;
}

export function IconBuilding({ size, color, style }) {
  return <I size={size} color={color} style={style}><Rect x="4" y="2" width="16" height="20" rx="2"/><Path d="M9 22v-4h6v4"/><Path d="M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01"/></I>;
}

export function IconBriefcase({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><Rect width="20" height="14" x="2" y="6" rx="2"/></I>;
}

export function IconPlus({ size = 24, color = 'currentColor', ...props }) {
  return (
    <I size={size} color={color} {...props}>
      <Line x1="12" y1="5" x2="12" y2="19" />
      <Line x1="5" y1="12" x2="19" y2="12" />
    </I>
  );
}

export function IconEdit({ size = 24, color = 'currentColor', ...props }) {
  return (
    <I size={size} color={color} {...props}>
      <Path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <Path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </I>
  );
}

export function IconCloud({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></I>;
}

export function IconUpload({ size = 24, color = 'currentColor', ...props }) {
  return (
    <I size={size} color={color} {...props}>
      <Polyline points="16 16 12 12 8 16" />
      <Line x1="12" y1="12" x2="12" y2="21" />
      <Path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
    </I>
  );
}

export function IconKey({ size = 24, color = 'currentColor', ...props }) {
  return (
    <I size={size} color={color} {...props}>
      <Path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </I>
  );
}

export function IconCopy({ size = 24, color = 'currentColor', ...props }) {
  return (
    <I size={size} color={color} {...props}>
      <Rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <Path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </I>
  );
}

export function IconHash({ size, color, style }) {
  return <I size={size} color={color} style={style}><Line x1="4" y1="9" x2="20" y2="9"/><Line x1="4" y1="15" x2="20" y2="15"/><Line x1="10" y1="3" x2="8" y2="21"/><Line x1="16" y1="3" x2="14" y2="21"/></I>;
}

export function IconWifiOff({ size, color, style }) {
  return <I size={size} color={color} style={style}><Line x1="1" y1="1" x2="23" y2="23"/><Path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><Path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><Path d="M10.71 5.05A16 16 0 0 1 22.56 9"/><Path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><Path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><Line x1="12" y1="20" x2="12.01" y2="20"/></I>;
}

export function IconFolderPlus({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><Line x1="12" y1="11" x2="12" y2="17"/><Line x1="9" y1="14" x2="15" y2="14"/></I>;
}

export function IconBell({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><Path d="M13.73 21a2 2 0 0 1-3.46 0"/></I>;
}

export function IconChevronUp({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polyline points="18 15 12 9 6 15"/></I>;
}

export function IconTranslate({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M5 8l6 6"/><Path d="M4 14l6-6 2-3"/><Path d="M2 5h12"/><Path d="M7 2v3"/><Path d="M22 22l-5-10-5 10"/><Path d="M14 18h6"/></I>;
}

export function IconReceipt({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1-2-1z"/><Line x1="8" y1="10" x2="16" y2="10"/><Line x1="8" y1="14" x2="16" y2="14"/></I>;
}

export function IconUsers({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><Circle cx="9" cy="7" r="4"/><Path d="M23 21v-2a4 4 0 0 0-3-3.87"/><Path d="M16 3.13a4 4 0 0 1 0 7.75"/></I>;
}

export function IconFileDown({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><Polyline points="14 2 14 8 20 8"/><Line x1="12" y1="18" x2="12" y2="12"/><Polyline points="9 15 12 18 15 15"/></I>;
}

export function IconFileUp({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><Polyline points="14 2 14 8 20 8"/><Line x1="12" y1="12" x2="12" y2="18"/><Polyline points="9 15 12 12 15 15"/></I>;
}

// ===================== ILLUSTRATIONS =====================

export function IllustrationEmptyInbox({ size = 200, color = '#1a73e8', style }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 200 200" fill="none" style={typeof style === 'object' ? style : undefined}>
      <Rect x="40" y="80" width="120" height="80" rx="12" fill={color} opacity="0.08"/>
      <Rect x="50" y="70" width="100" height="80" rx="10" fill={color} opacity="0.12" stroke={color} strokeWidth="2"/>
      <Path d="M50 90 L100 60 L150 90" stroke={color} strokeWidth="2.5" fill="none"/>
      <G transform="translate(72, 30)">
        <Rect x="0" y="0" width="56" height="40" rx="6" fill="white" stroke={color} strokeWidth="2"/>
        <Polyline points="0,0 28,20 56,0" stroke={color} strokeWidth="2" fill="none"/>
      </G>
      <Circle cx="45" cy="50" r="3" fill={color} opacity="0.3"/>
      <Circle cx="160" cy="45" r="4" fill={color} opacity="0.2"/>
      <Circle cx="155" cy="75" r="2" fill={color} opacity="0.25"/>
      <Circle cx="35" cy="110" r="2.5" fill={color} opacity="0.2"/>
      <Rect x="65" y="170" width="70" height="6" rx="3" fill={color} opacity="0.15"/>
      <Rect x="78" y="182" width="44" height="4" rx="2" fill={color} opacity="0.1"/>
    </Svg>
  );
}

export function IllustrationSearch({ size = 200, color = '#1a73e8', style }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 200 200" fill="none" style={typeof style === 'object' ? style : undefined}>
      <Circle cx="88" cy="88" r="45" stroke={color} strokeWidth="3" opacity="0.15" fill={color} fillOpacity="0.05"/>
      <Circle cx="88" cy="88" r="30" stroke={color} strokeWidth="2.5" fill="none"/>
      <Line x1="110" y1="110" x2="140" y2="140" stroke={color} strokeWidth="4" strokeLinecap="round"/>
      <Path d="M83 80a8 8 0 0 1 10 0c3 3 3 7 0 10l-5 3" stroke={color} strokeWidth="2.5" fill="none" strokeLinecap="round"/>
      <Circle cx="88" cy="98" r="1.5" fill={color}/>
      <Rect x="140" y="50" width="30" height="8" rx="4" fill={color} opacity="0.12"/>
      <Rect x="145" y="62" width="20" height="6" rx="3" fill={color} opacity="0.08"/>
      <Rect x="30" y="130" width="25" height="6" rx="3" fill={color} opacity="0.1"/>
      <Circle cx="160" cy="130" r="4" fill={color} opacity="0.15"/>
      <Rect x="55" y="170" width="90" height="6" rx="3" fill={color} opacity="0.15"/>
      <Rect x="70" y="182" width="60" height="4" rx="2" fill={color} opacity="0.1"/>
    </Svg>
  );
}

export function IllustrationLogin({ size = 300, color = '#ffffff', style }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 300 300" fill="none" style={typeof style === 'object' ? style : undefined}>
      <G transform="translate(80, 60)">
        <Rect x="0" y="30" width="140" height="100" rx="14" fill={color} opacity="0.2" stroke={color} strokeWidth="2"/>
        <Polyline points="0,30 70,85 140,30" stroke={color} strokeWidth="2.5" fill="none" opacity="0.5"/>
        <Rect x="25" y="55" width="90" height="5" rx="2.5" fill={color} opacity="0.25"/>
        <Rect x="25" y="67" width="70" height="4" rx="2" fill={color} opacity="0.18"/>
        <Rect x="25" y="78" width="80" height="4" rx="2" fill={color} opacity="0.18"/>
      </G>
      <G transform="translate(195, 40)">
        <Path d="M20 0 L40 10 L40 25 C40 38 20 48 20 48 C20 48 0 38 0 25 L0 10 Z" fill={color} opacity="0.15" stroke={color} strokeWidth="1.5"/>
        <Polyline points="12,24 18,30 30,18" stroke={color} strokeWidth="2.5" fill="none" opacity="0.4"/>
      </G>
      <G transform="translate(40, 95)">
        <Path d="M15 0 L17 10 L25 8 L19 15 L28 18 L19 21 L25 28 L17 26 L15 36 L13 26 L5 28 L11 21 L2 18 L11 15 L5 8 L13 10 Z" fill={color} opacity="0.2"/>
      </G>
      <Circle cx="250" cy="220" r="12" fill={color} opacity="0.1"/>
      <Circle cx="55" cy="200" r="8" fill={color} opacity="0.12"/>
      <Circle cx="260" cy="100" r="6" fill={color} opacity="0.1"/>
      <Circle cx="30" cy="60" r="5" fill={color} opacity="0.08"/>
      <Line x1="50" y1="170" x2="80" y2="155" stroke={color} strokeWidth="1" opacity="0.15"/>
      <Line x1="220" y1="170" x2="250" y2="210" stroke={color} strokeWidth="1" opacity="0.1"/>
      <G transform="translate(110, 210)">
        <Circle cx="40" cy="40" r="30" stroke={color} strokeWidth="1.5" opacity="0.2" fill="none"/>
        <Ellipse cx="40" cy="40" rx="15" ry="30" stroke={color} strokeWidth="1" opacity="0.15" fill="none"/>
        <Line x1="10" y1="40" x2="70" y2="40" stroke={color} strokeWidth="1" opacity="0.15"/>
      </G>
    </Svg>
  );
}

// ===================== MEETING =====================

export function IconMic({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><Path d="M19 10v2a7 7 0 0 1-14 0v-2"/><Line x1="12" y1="19" x2="12" y2="23"/><Line x1="8" y1="23" x2="16" y2="23"/></I>;
}

export function IconMicOff({ size, color, style }) {
  return <I size={size} color={color} style={style}><Line x1="1" y1="1" x2="23" y2="23"/><Path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><Path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.35 2.17"/><Line x1="12" y1="19" x2="12" y2="23"/><Line x1="8" y1="23" x2="16" y2="23"/></I>;
}

export function IconRecord({ size, color, style }) {
  return <I size={size} color={color} style={style} strokeWidth={0} fill={color || 'currentColor'}><Circle cx="12" cy="12" r="8"/></I>;
}

export function IconVideo({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polygon points="23 7 16 12 23 17 23 7"/><Rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></I>;
}

export function IconVideoOff({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"/><Line x1="1" y1="1" x2="23" y2="23"/></I>;
}

export function IconMonitor({ size, color, style }) {
  return <I size={size} color={color} style={style}><Rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><Line x1="8" y1="21" x2="16" y2="21"/><Line x1="12" y1="17" x2="12" y2="21"/></I>;
}

export function IconPhoneOff({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><Line x1="23" y1="1" x2="1" y2="23"/></I>;
}

export function IconMessageCircle({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></I>;
}

export function IconMapPin({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><Circle cx="12" cy="10" r="3"/></I>;
}

export function IconRepeat({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polyline points="17 1 21 5 17 9"/><Path d="M3 11V9a4 4 0 0 1 4-4h14"/><Polyline points="7 23 3 19 7 15"/><Path d="M21 13v2a4 4 0 0 1-4 4H3"/></I>;
}

// ===================== REACTIONS & GESTURES =====================

export function IconThumbsUp({ size, color, style }) {
  return (
    <I size={size} color={color} fill={color} strokeWidth={0} style={style}>
      <Path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3m7-2V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/>
    </I>
  );
}

// Mirror of IconThumbsUp — used by the One AI "Bad response" affordance
// in the message context sheet (ChatGPT parity).
export function IconThumbsDown({ size, color, style }) {
  return (
    <I size={size} color={color} style={style}>
      <Path d="M17 2h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3m-7 2v3a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7L2.34 12.7a2 2 0 0 0 2 2.3H10z"/>
    </I>
  );
}

export function IconHeart({ size, color = '#ef4444', style }) {
  return (
    <I size={size} color={color} fill={color} strokeWidth={0} style={style}>
      <Path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
    </I>
  );
}

export function IconLaughFace({ size, color, style }) {
  return (
    <I size={size} color={color} style={style}>
      <Circle cx="12" cy="12" r="10"/>
      <Path d="M8 14s1.5 2 4 2 4-2 4-2"/>
      <Line x1="9" y1="9" x2="9.01" y2="9" strokeWidth={3}/>
      <Line x1="15" y1="9" x2="15.01" y2="9" strokeWidth={3}/>
      <Path d="M6.5 11.5c.3.2.6.2.8 0M17.5 11.5c-.3.2-.6.2-.8 0" strokeWidth={1}/>
    </I>
  );
}

export function IconClap({ size, color, style }) {
  return (
    <I size={size} color={color} fill={color} strokeWidth={0} style={style}>
      <Path d="M12 2.5l.6 1.8.6-1.8h1.9l-1.5 1.2.6 1.8L12 4.3l-1.2.9.6-1.8L10 2.5h1.9z" opacity="0.5"/>
      <Path d="M18 4l.4 1.2.4-1.2h1.3l-1 .8.4 1.2-.8-.6-.8.6.4-1.2-1-.8H18z" opacity="0.5"/>
      <Path d="M6 5l.4 1.2.4-1.2h1.3l-1 .8.4 1.2-.8-.6-.8.6.4-1.2-1-.8H6z" opacity="0.5"/>
      <Path d="M8.5 8.5l3-3a1.5 1.5 0 0 1 2.1 2.1l-1 1 3-3a1.5 1.5 0 0 1 2.1 2.1l-3 3 .5-.5a1.5 1.5 0 0 1 2.1 2.1l-.5.5a1.5 1.5 0 0 1 2.1 2.1l-4.5 4.5c-2.5 2.5-6.5 2.5-9 0l-.5-.5a4 4 0 0 1 0-5.7L8.5 8.5z"/>
    </I>
  );
}

export function IconSurpriseFace({ size, color, style }) {
  return (
    <I size={size} color={color} style={style}>
      <Circle cx="12" cy="12" r="10"/>
      <Circle cx="12" cy="16" r="2"/>
      <Line x1="9" y1="9" x2="9.01" y2="9" strokeWidth={3}/>
      <Line x1="15" y1="9" x2="15.01" y2="9" strokeWidth={3}/>
    </I>
  );
}

export function IconFlame({ size, color = '#f97316', style }) {
  return (
    <I size={size} color={color} fill={color} strokeWidth={0} style={style}>
      <Path d="M12 22c-4.97 0-8-3.58-8-7.5C4 10 8 6 9.5 4.5c0 0 1 3 3.5 4.5 1-.5 2-3 2-3C17 8 20 10.5 20 14.5c0 3.92-3.03 7.5-8 7.5zm0-3c1.66 0 3-1.12 3-2.5S13.5 14 12 13c-1.5 1-3 1.62-3 3S10.34 19 12 19z"/>
    </I>
  );
}

export function IconThinkingFace({ size, color, style }) {
  return (
    <I size={size} color={color} style={style}>
      <Circle cx="12" cy="12" r="10"/>
      <Path d="M8 15c0 0 1 1.5 2.5 1.5"/>
      <Line x1="9" y1="9" x2="9.01" y2="9" strokeWidth={3}/>
      <Line x1="15" y1="9" x2="15.01" y2="9" strokeWidth={3}/>
      <Path d="M15 13c-.5.5-1 1-2 1s-1.5-.5-2-1" strokeWidth={1.5}/>
    </I>
  );
}

export function IconHundred({ size, color = '#ef4444', style }) {
  return (
    <I size={size} color="none" fill={color} strokeWidth={0} style={style} viewBox="0 0 24 24">
      <Path d="M3 18h1.5V8H3v-.5c1 0 1.8-.5 2.2-1h1V18h1.3v1.2H3V18z"/>
      <Path d="M10.5 12.5c0-3.6.8-5.5 2.5-5.5s2.5 1.9 2.5 5.5-.8 5.5-2.5 5.5-2.5-1.9-2.5-5.5zm3.7 0c0-3-.4-4.3-1.2-4.3s-1.2 1.3-1.2 4.3.4 4.3 1.2 4.3 1.2-1.3 1.2-4.3z"/>
      <Path d="M17 12.5c0-3.6.8-5.5 2.5-5.5S22 8.9 22 12.5 21.2 18 19.5 18 17 16.1 17 12.5zm3.7 0c0-3-.4-4.3-1.2-4.3s-1.2 1.3-1.2 4.3.4 4.3 1.2 4.3 1.2-1.3 1.2-4.3z"/>
      <Rect x="1" y="20" width="22" height="2" rx="1"/>
      <Rect x="1" y="20" width="22" height="2" rx="1" transform="rotate(-15 12 21)"/>
    </I>
  );
}

export function IconRaisedHand({ size, color, style }) {
  return (
    <I size={size} color={color} fill={color} strokeWidth={0} style={style}>
      <Path d="M18 9.5V5.5a1.5 1.5 0 0 0-3 0V9m0-4.5v-2a1.5 1.5 0 0 0-3 0V9m0-5.5a1.5 1.5 0 0 0-3 0V9m0-3.5a1.5 1.5 0 0 0-3 0v8l-1.8-1.8a1.5 1.5 0 0 0-2.1 2.1L7.6 19A6 6 0 0 0 12 21h1a6 6 0 0 0 6-6V9.5a1.5 1.5 0 0 0-1-1.4z"/>
    </I>
  );
}

export function IconSmileFace({ size, color, style }) {
  return (
    <I size={size} color={color} style={style}>
      <Circle cx="12" cy="12" r="10"/>
      <Path d="M8 14s1.5 2 4 2 4-2 4-2"/>
      <Line x1="9" y1="9" x2="9.01" y2="9" strokeWidth={3}/>
      <Line x1="15" y1="9" x2="15.01" y2="9" strokeWidth={3}/>
    </I>
  );
}

export function IconSadFace({ size, color, style }) {
  return (
    <I size={size} color={color} style={style}>
      <Circle cx="12" cy="12" r="10"/>
      <Path d="M16 16s-1.5-2-4-2-4 2-4 2"/>
      <Line x1="9" y1="9" x2="9.01" y2="9" strokeWidth={3}/>
      <Line x1="15" y1="9" x2="15.01" y2="9" strokeWidth={3}/>
    </I>
  );
}

export function IconPrayHands({ size, color, style }) {
  return (
    <I size={size} color={color} fill={color} strokeWidth={0} style={style}>
      <Path d="M12 2C11 2 10 3 10 4v7l-2 2.5C7 14.5 7.5 16 8.5 16H10v3c0 1.7 1.3 3 3 3h-2c-1.7 0-3-1.3-3-3v-3H6.5C4.5 16 4 13.5 5 12l3-4V4c0-1 1-2 2-2h4c1 0 2 1 2 2v4l3 4c1 1.5.5 4-1.5 4H16v3c0 1.7-1.3 3-3 3h-2c1.7 0 3-1.3 3-3v-3h1.5c1 0 1.5-1.5.5-2.5L14 11V4c0-1-1-2-2-2z"/>
      <Line x1="12" y1="6" x2="12" y2="22" stroke={color} strokeWidth={1.5}/>
    </I>
  );
}

export function IconFlashlight({ size, color, style }) {
  return (
    <I size={size} color={color} style={style}>
      <Path d="M18 6l-3 3"/>
      <Path d="M9 3l-6 6 3 3 2-2 4 4 2-2 3 3 3-3-6-6 2-2-3-3z"/>
      <Line x1="3" y1="21" x2="9" y2="15"/>
    </I>
  );
}

export function IconUnlock({ size, color, style }) {
  return <I size={size} color={color} style={style}><Rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><Path d="M7 11V7a5 5 0 0 1 9.9-1"/></I>;
}

export function IconHome({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><Polyline points="9 22 9 12 15 12 15 22"/></I>;
}

export function IconCamera({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><Circle cx="12" cy="13" r="4"/></I>;
}

export function IconPlay({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polygon points="5 3 19 12 5 21 5 3"/></I>;
}

export function IconPause({ size, color, style }) {
  return <I size={size} color={color} style={style}><Rect x="6" y="4" width="4" height="16"/><Rect x="14" y="4" width="4" height="16"/></I>;
}

export function IconStop({ size, color, style }) {
  return <I size={size} color={color} style={style}><Rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></I>;
}

// Gift box icon — outlined, matches the IconHeart/IconShare stroke style.
// Used by the live composer "send gift" button (LiveCommentInput) so the
// linter can resolve it from the canonical Icons import (vs LiveGiftPicker
// which also exports a copy for use inside the picker grid sheet).
export function IconGiftBox({ size, color, style }) {
  return (
    <I size={size} color={color} style={style}>
      <Rect x="3" y="8" width="18" height="13" rx="2" ry="2"/>
      <Line x1="3" y1="12" x2="21" y2="12"/>
      <Line x1="12" y1="8" x2="12" y2="21"/>
      <Path d="M8 8c-1.5 0-3-1-3-2.5S6.5 3 8 3s4 2 4 5"/>
      <Path d="M16 8c1.5 0 3-1 3-2.5S17.5 3 16 3s-4 2-4 5"/>
    </I>
  );
}

export function IconSmile({ size, color, style }) {
  return <I size={size} color={color} style={style}><Circle cx="12" cy="12" r="10"/><Path d="M8 14s1.5 2 4 2 4-2 4-2"/><Line x1="9" y1="9" x2="9.01" y2="9"/><Line x1="15" y1="9" x2="15.01" y2="9"/></I>;
}

// ─── Photo/Status editor tool icons ─────────────────────────────────
// Feather-style strokes so they match the rest of the icon set (stroke 2,
// 24x24 viewBox). Added instead of leaking raw emojis into the UI.
export function IconType({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polyline points="4 7 4 4 20 4 20 7"/><Line x1="9" y1="20" x2="15" y2="20"/><Line x1="12" y1="4" x2="12" y2="20"/></I>;
}
export function IconBrush({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><Path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/></I>;
}
export function IconUndo2({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polyline points="3 7 3 13 9 13"/><Path d="M3 13a9 9 0 1 0 3-6.7L3 9"/></I>;
}

export function IconNavigation({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polygon points="3 11 22 2 13 21 11 13 3 11"/></I>;
}

export function IconCameraFlip({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M20 16v4a2 2 0 0 1-2 2h-4"/><Path d="M14 15l6 1 1-6"/><Path d="M4 8V4a2 2 0 0 1 2-2h4"/><Path d="M10 9L4 8 3 14"/><Circle cx="12" cy="12" r="3"/></I>;
}

export function IconScreenShare({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3"/><Polyline points="8 21 12 17 16 21"/><Line x1="12" y1="12" x2="12" y2="17"/><Path d="M17 8l4-4-4-4"/><Path d="M21 4h-7"/></I>;
}

export function IconBluetooth({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/></I>;
}

// ===================== FEED =====================

export function IconHeartOutline({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></I>;
}

export function IconBookmark({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></I>;
}

export function IconBookmarkFilled({ size, color, style }) {
  return <I size={size} color={color} fill={color} strokeWidth={0} style={style}><Path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></I>;
}

export function IconGrid({ size, color, style }) {
  return <I size={size} color={color} style={style}><Rect x="3" y="3" width="7" height="7"/><Rect x="14" y="3" width="7" height="7"/><Rect x="14" y="14" width="7" height="7"/><Rect x="3" y="14" width="7" height="7"/></I>;
}

export function IconShare({ size, color, style }) {
  return <I size={size} color={color} style={style}><Circle cx="18" cy="5" r="3"/><Circle cx="6" cy="12" r="3"/><Circle cx="18" cy="19" r="3"/><Line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><Line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></I>;
}

export function IconMoreHorizontal({ size, color, style }) {
  return <I size={size} color={color} fill={color} strokeWidth={0} style={style}><Circle cx="12" cy="12" r="1.5"/><Circle cx="19" cy="12" r="1.5"/><Circle cx="5" cy="12" r="1.5"/></I>;
}

// ===================== NOTES =====================

export function IconStickyNote({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3z"/><Polyline points="14 3 14 9 21 9"/></I>;
}

export function IconPin({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M12 17v5"/><Path d="M9 2h6l-1.5 6.5L16 12H8l2.5-3.5L9 2z"/></I>;
}

// ───── Settings sheet icons (added for unified profile gear) ─────────
export function IconCreditCard({ size, color, style }) {
  return <I size={size} color={color} style={style}><Rect x="2" y="5" width="20" height="14" rx="2"/><Line x1="2" y1="10" x2="22" y2="10"/></I>;
}
export function IconDatabase({ size, color, style }) {
  return <I size={size} color={color} style={style}><Ellipse cx="12" cy="5" rx="9" ry="3"/><Path d="M3 5v6c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><Path d="M3 11v6c0 1.66 4.03 3 9 3s9-1.34 9-3v-6"/></I>;
}
export function IconHelp({ size, color, style }) {
  return <I size={size} color={color} style={style}><Circle cx="12" cy="12" r="10"/><Path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><Line x1="12" y1="17" x2="12.01" y2="17"/></I>;
}
export function IconLogOut({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><Polyline points="16 17 21 12 16 7"/><Line x1="21" y1="12" x2="9" y2="12"/></I>;
}

// ───── Wave 10 polish aliases ─────────
export function IconFile({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><Polyline points="14 2 14 8 20 8"/></I>;
}
export function IconAlbum({ size, color, style }) {
  return <I size={size} color={color} style={style}><Rect x="3" y="3" width="18" height="18" rx="2"/><Polyline points="11 3 11 11 14 8 17 11 17 3"/></I>;
}
export function IconCloudUpload({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M16 16l-4-4-4 4"/><Path d="M12 12v9"/><Path d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 3 15.25"/></I>;
}
export function IconCloudOff({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M2 2l20 20"/><Path d="M5.78 5.78A8 8 0 0 0 8 21h11a4 4 0 0 0 .9-7.89"/></I>;
}
export function IconCloudCheck({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 3 15.25"/><Polyline points="9 13 11 15 15 11"/></I>;
}
export function IconVolume({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><Path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><Path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></I>;
}
export function IconMegaphone({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M3 11l18-7v16L3 13z"/><Path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></I>;
}
export function IconUsersSmall({ size, color, style }) {
  return <I size={size} color={color} style={style}><Path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><Circle cx="9" cy="7" r="4"/><Path d="M22 21v-2a4 4 0 0 0-3-3.87"/><Path d="M16 3.13a4 4 0 0 1 0 7.75"/></I>;
}
export function IconHashtag({ size, color, style }) {
  return <I size={size} color={color} style={style}><Line x1="4" y1="9" x2="20" y2="9"/><Line x1="4" y1="15" x2="20" y2="15"/><Line x1="10" y1="3" x2="8" y2="21"/><Line x1="16" y1="3" x2="14" y2="21"/></I>;
}

// Sliders icon — used for the Status interactive Slider sticker tray entry.
// Mirrors lucide's "sliders-horizontal": three horizontal rails with a knob
// on each, so users immediately read it as "drag bar".
export function IconSliders({ size, color, style }) {
  return <I size={size} color={color} style={style}><Line x1="4" y1="6" x2="20" y2="6"/><Line x1="4" y1="12" x2="20" y2="12"/><Line x1="4" y1="18" x2="20" y2="18"/><Circle cx="9" cy="6" r="2"/><Circle cx="15" cy="12" r="2"/><Circle cx="11" cy="18" r="2"/></I>;
}

// Feed/repost icon — used by the "Postar também no Feed" toggle in the
// status publish modal so the icon hints at "broadcast to Feed".
export function IconFeedShare({ size, color, style }) {
  return <I size={size} color={color} style={style}><Polyline points="17 1 21 5 17 9"/><Path d="M3 11V9a4 4 0 0 1 4-4h14"/><Polyline points="7 23 3 19 7 15"/><Path d="M21 13v2a4 4 0 0 1-4 4H3"/></I>;
}
