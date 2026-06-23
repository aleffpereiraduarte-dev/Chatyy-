import { Platform } from 'react-native';
import { scaleSize, moderateScale } from '../utils/responsive';

export const Colors = {
  // Primary — Cosmic Purple
  // Why: primaryLight was a leftover blue (#dbeafe) from the old palette while
  // primary is purple. Harmonized to violet (#EDE9FE) so tinted backgrounds
  // (badges, chips, focus glows) finally match the brand identity.
  primary: '#7C3AED',
  primaryLight: '#EDE9FE',
  primaryDark: '#5B21B6',
  primaryContainer: '#EDE9FE',
  onPrimary: '#ffffff',
  onPrimaryContainer: '#5B21B6',

  // Background / Surface — warm slate
  background: '#F7F7FA',
  surface: '#ffffff',
  surfaceVariant: '#f1f5f9',
  surfaceHover: '#F7F7FA',

  // Header
  headerBg: 'rgba(255, 255, 255, 0.95)',
  headerBgSolid: '#ffffff',
  headerBorder: 'rgba(0, 0, 0, 0.06)',
  sidebarActiveBg: 'rgba(124, 58, 237, 0.08)',

  // Text — slate palette.
  // Why: tertiary `#94a3b8` only hit ~3.7:1 on white, below WCAG AA for body
  // copy. Bumped to `#7c8ba0` (~4.7:1) so timestamps, captions and "X mins ago"
  // finally clear AA without losing the soft, secondary-rank feel.
  text: '#0f172a',
  textSecondary: '#64748b',
  textTertiary: '#7c8ba0',
  textOnPrimary: '#ffffff',

  // Border — softer slate
  border: '#e2e8f0',
  borderLight: '#f1f5f9',
  divider: '#e2e8f0',

  // Status — saturated modern
  error: '#dc2626',
  errorBg: '#fef2f2',
  success: '#16a34a',
  successBg: '#f0fdf4',
  warning: '#d97706',
  warningBg: '#fffbeb',

  // Email states
  unreadBg: '#F5F3FF',
  unreadAccent: '#7C3AED',
  selectedBg: '#EDE9FE',
  starColor: '#f59e0b',
  starEmpty: '#d1d5db',

  // Compose — solid primary
  composeBg: '#7C3AED',
  composeText: '#ffffff',

  // Sidebar
  sidebarBg: '#ffffff',
  folderActive: '#F5F3FF',
  folderHover: '#f8fafc',
  badge: '#dc2626',

  // Avatar
  avatarBg: '#A78BFA',
  avatarColors: ['#7C3AED', '#16a34a', '#dc2626', '#f59e0b', '#A78BFA', '#8b5cf6', '#ea580c', '#0d9488'],

  // Chat — Cosmic Purple (2026 refined)
  chatPrimary: '#7C3AED',
  chatBubbleOwn: '#EDE9FE',
  chatBubbleOwnBorder: 'rgba(124,58,237,0.08)',
  chatBubbleOther: '#FFFFFF',
  chatBubbleOtherBorder: 'rgba(0,0,0,0.04)',
  chatBackground: '#F3EFF8',
  chatInputBg: '#FFFFFF',
  chatInputBorder: 'rgba(0,0,0,0.06)',

  // Overlay
  overlay: 'rgba(0, 0, 0, 0.4)',
  shadow: '#0f172a',

  // Features
  hoverActionBg: 'rgba(0, 0, 0, 0.04)',
  toastBg: '#1e293b',
  toastText: '#f8fafc',
  checkboxColor: '#64748b',
  selectedCheckbox: '#7C3AED',
  focusBorder: '#7C3AED',
  bulkToolbarBg: '#F5F3FF',
  gradientStart: '#7C3AED',
  gradientEnd: '#A78BFA',
  loginPanelBg: '#F5F3FF',

  // Focus glow — violet to match the actual primary color.
  focusGlow: 'rgba(124, 58, 237, 0.15)',

  // Secondary & Tertiary accents
  secondary: '#10b981',
  secondaryLight: '#d1fae5',
  secondaryDark: '#059669',
  tertiary: '#8b5cf6',
  tertiaryLight: '#ede9fe',
  tertiaryDark: '#7c3aed',

  // Brand colors
  brandPrimary: '#7C3AED',
  brandSecondary: '#10b981',
  brandAccent: '#f59e0b',
  brandDanger: '#ef4444',

  // Folder colors
  folderInbox: '#7C3AED',
  folderSent: '#10b981',
  folderDrafts: '#f59e0b',
  folderTrash: '#ef4444',
  folderSpam: '#8b5cf6',
  folderArchive: '#6b7280',
  folderFlagged: '#f59e0b',
  folderSnoozed: '#6366f1',

  // Storage gradient
  storageGradientStart: '#7C3AED',
  storageGradientMid: '#A78BFA',
  storageGradientEnd: '#ec4899',

  // Meeting
  meetBg: '#111827',
  meetSurface: 'rgba(31, 41, 55, 0.92)',
  meetSurfaceSolid: '#1e293b',
  meetText: '#f1f5f9',
  meetTextSecondary: '#94a3b8',
  meetBorder: 'rgba(255, 255, 255, 0.1)',
  meetBtnBg: 'rgba(255, 255, 255, 0.12)',
  meetBtnActive: '#dc2626',
  meetEndCall: '#dc2626',
  meetScreenShare: '#7C3AED',
  meetHandRaised: '#f59e0b',

  // Connection status
  connectionGood: '#16a34a',
  connectionWarn: '#f59e0b',
  connectionBad: '#dc2626',

  // Auth pages — Google Material Design 3 style
  authBg: '#f0f4f9',
  authBgSubtle: '#e8edf5',
  authPatternColor: 'rgba(124, 58, 237, 0.03)',
  authPatternDot: 'rgba(124, 58, 237, 0.06)',
  authCardBg: '#ffffff',
  authCardBorder: 'transparent',
  authCardShadow: 'rgba(0, 0, 0, 0.08)',
  authInputBg: 'transparent',
  authInputBorder: '#dadce0',
  authInputFocusBorder: '#7C3AED',
  authInputFocusGlow: 'rgba(124, 58, 237, 0.08)',
  authLabelColor: '#5f6368',
  authLabelFloatColor: '#7C3AED',
  authDividerColor: '#e2e8f0',
  authFooterText: '#94a3b8',
  authFooterLink: '#64748b',
  authBtnGradientStart: '#7C3AED',
  authBtnGradientEnd: '#5B21B6',
  authSecondaryBtn: 'rgba(124, 58, 237, 0.04)',
  authSecondaryBtnBorder: '#EDE9FE',
  authSecondaryBtnHover: 'rgba(124, 58, 237, 0.08)',
  authAccentGlow: 'rgba(124, 58, 237, 0.08)',
  authAccentLine: 'rgba(124, 58, 237, 0.15)',
  authStepDoneBg: '#10b981',
  authStepActiveBg: '#7C3AED',
  authStepPendingBg: '#cbd5e1',
  authStepConnector: '#e2e8f0',
  authStepConnectorDone: '#10b981',
  authSuccessGreen: '#10b981',
  authChipBg: '#F5F3FF',
  authChipBorder: '#DDD6FE',
  authLeftPanelBg: '#F5F3FF',
  authLeftPanelAccent: '#7C3AED',
  authGridColor: 'rgba(124, 58, 237, 0.04)',
};

export const DarkColors = {
  // Primary — Cosmic Purple for OLED
  primary: '#A78BFA',
  primaryLight: '#2D1B69',
  primaryDark: '#C4B5FD',
  primaryContainer: '#2D1B69',
  onPrimary: '#1F1147',
  onPrimaryContainer: '#DDD6FE',

  // Background / Surface — true OLED black with layered depth
  background: '#000000',
  surface: '#0d0d0d',
  surfaceVariant: '#1a1a1a',
  surfaceHover: '#141414',
  surfaceElevated: '#1a1a1a',
  surfaceGlass: 'rgba(13, 13, 13, 0.80)',
  surfaceGlassBorder: 'rgba(255, 255, 255, 0.06)',

  // Header dark
  headerBg: 'rgba(13, 13, 13, 0.97)',
  headerBgSolid: '#0d0d0d',
  headerBorder: 'rgba(255, 255, 255, 0.06)',
  sidebarActiveBg: 'rgba(167, 139, 250, 0.15)',

  // Text. Why: tertiary `#64748b` was ~3.5:1 on OLED #000 — fails AA for any
  // body text and made timestamps/captions disappear on devices with HDR
  // dimming. Bumped to `#8a98ad` (~5.6:1) so secondary metadata clears AA
  // while still reading as a quieter rank than primary slate text.
  text: '#f1f5f9',
  textSecondary: '#94a3b8',
  textTertiary: '#8a98ad',
  textOnPrimary: '#1F1147',

  // Border — subtle for OLED
  border: 'rgba(255, 255, 255, 0.06)',
  borderLight: 'rgba(255, 255, 255, 0.03)',
  divider: 'rgba(255, 255, 255, 0.08)',

  // Status
  error: '#f87171',
  errorBg: '#450a0a',
  success: '#4ade80',
  successBg: '#052e16',
  warning: '#fbbf24',
  warningBg: '#451a03',

  // Email states — OLED
  unreadBg: '#1A1033',
  unreadAccent: '#C4B5FD',
  selectedBg: '#1F1147',
  starColor: '#f59e0b',
  starEmpty: '#4b5563',

  // Compose
  composeBg: '#A78BFA',
  composeText: '#ffffff',

  // Sidebar — OLED
  sidebarBg: '#0a0a0a',
  folderActive: '#141414',
  folderHover: '#111111',
  badge: '#f87171',

  // Avatar
  avatarBg: '#A78BFA',
  avatarColors: ['#A78BFA', '#4ade80', '#f87171', '#fbbf24', '#C4B5FD', '#c084fc', '#fb923c', '#2dd4bf'],

  // Chat — Cosmic Purple Dark (2026 refined)
  chatPrimary: '#A78BFA',
  chatBubbleOwn: '#4C1D95',
  chatBubbleOwnBorder: 'rgba(167,139,250,0.12)',
  chatBubbleOther: '#1E1A2E',
  chatBubbleOtherBorder: 'rgba(255,255,255,0.04)',
  chatBackground: '#0E0A18',
  chatInputBg: '#1a1625',
  chatInputBorder: 'rgba(255,255,255,0.06)',

  // Overlay
  overlay: 'rgba(0, 0, 0, 0.6)',
  shadow: '#000',

  // Features
  hoverActionBg: 'rgba(255, 255, 255, 0.06)',
  toastBg: '#f1f5f9',
  toastText: '#0f172a',
  checkboxColor: '#94a3b8',
  selectedCheckbox: '#A78BFA',
  focusBorder: '#A78BFA',
  bulkToolbarBg: '#2D1B69',
  gradientStart: '#1F1147',
  gradientEnd: '#C4B5FD',
  loginPanelBg: '#000000',

  // Focus glow
  focusGlow: 'rgba(167, 139, 250, 0.2)',

  // Secondary & Tertiary accents — brighter for OLED
  secondary: '#3de8a8',
  secondaryLight: '#064e3b',
  secondaryDark: '#7aefca',
  tertiary: '#d094ff',
  tertiaryLight: '#2e1065',
  tertiaryDark: '#e4c4ff',

  // Brand colors — brighter for OLED
  brandPrimary: '#C4B5FD',
  brandSecondary: '#3de8a8',
  brandAccent: '#fbbf24',
  brandDanger: '#f87171',

  // Folder colors
  folderInbox: '#A78BFA',
  folderSent: '#34d399',
  folderDrafts: '#fbbf24',
  folderTrash: '#f87171',
  folderSpam: '#c084fc',
  folderArchive: '#9ca3af',
  folderFlagged: '#fbbf24',
  folderSnoozed: '#818cf8',

  // Storage gradient
  storageGradientStart: '#A78BFA',
  storageGradientMid: '#C4B5FD',
  storageGradientEnd: '#f472b6',

  // Meeting — OLED
  meetBg: '#000000',
  meetSurface: 'rgba(13, 13, 13, 0.95)',
  meetSurfaceSolid: '#0d0d0d',
  meetText: '#f1f5f9',
  meetTextSecondary: '#94a3b8',
  meetBorder: 'rgba(255, 255, 255, 0.08)',
  meetBtnBg: 'rgba(255, 255, 255, 0.1)',
  meetBtnActive: '#f87171',
  meetEndCall: '#f87171',
  meetScreenShare: '#A78BFA',
  meetHandRaised: '#fbbf24',

  // Connection status
  connectionGood: '#4ade80',
  connectionWarn: '#fbbf24',
  connectionBad: '#f87171',

  // Auth pages — OLED dark tech
  authBg: '#000000',
  authBgSubtle: '#0d0d0d',
  authPatternColor: 'rgba(167, 139, 250, 0.04)',
  authPatternDot: 'rgba(167, 139, 250, 0.08)',
  authCardBg: '#0d0d0d',
  authCardBorder: 'rgba(255, 255, 255, 0.06)',
  authCardShadow: 'rgba(0, 0, 0, 0.5)',
  authInputBg: '#000000',
  authInputBorder: 'rgba(255, 255, 255, 0.08)',
  authInputFocusBorder: '#A78BFA',
  authInputFocusGlow: 'rgba(167, 139, 250, 0.15)',
  authLabelColor: '#94a3b8',
  authLabelFloatColor: '#A78BFA',
  authDividerColor: 'rgba(255, 255, 255, 0.08)',
  authFooterText: '#475569',
  authFooterLink: '#64748b',
  authBtnGradientStart: '#A78BFA',
  authBtnGradientEnd: '#7C3AED',
  authSecondaryBtn: 'rgba(167, 139, 250, 0.06)',
  authSecondaryBtnBorder: 'rgba(167, 139, 250, 0.2)',
  authSecondaryBtnHover: 'rgba(167, 139, 250, 0.12)',
  authAccentGlow: 'rgba(167, 139, 250, 0.1)',
  authAccentLine: 'rgba(167, 139, 250, 0.12)',
  authStepDoneBg: '#34d399',
  authStepActiveBg: '#A78BFA',
  authStepPendingBg: '#475569',
  authStepConnector: 'rgba(255, 255, 255, 0.08)',
  authStepConnectorDone: '#34d399',
  authSuccessGreen: '#34d399',
  authChipBg: 'rgba(167, 139, 250, 0.1)',
  authChipBorder: 'rgba(167, 139, 250, 0.2)',
  authLeftPanelBg: '#1e293b',
  authLeftPanelAccent: '#A78BFA',
  authGridColor: 'rgba(167, 139, 250, 0.04)',
};

// Espaçamento — escala PARCIAL (moderateScale) com a tela. Em celular pequeno
// encolhe um pouco pra caber mais conteúdo; não some de vez (factor 0.5).
export const Spacing = {
  xs: moderateScale(4),
  sm: moderateScale(8),
  md: moderateScale(12),
  lg: moderateScale(16),
  xl: moderateScale(20),
  xxl: moderateScale(24),
  xxxl: moderateScale(32),
};

// Tipografia — escala COM a tela (scaleSize, clamp [0.85,1.15] em utils).
// Celular menor → fontes proporcionalmente menores (cabem sem cortar/quebrar);
// celular grande/tablet → um tiquinho maiores. Web fica em 1 (sem mudança).
export const FontSize = {
  xs: scaleSize(11),
  sm: scaleSize(12),
  md: scaleSize(13),
  base: scaleSize(14),
  lg: scaleSize(15),
  xl: scaleSize(16),
  xxl: scaleSize(18),
  title: scaleSize(20),
  heading: scaleSize(24),
  hero: scaleSize(32),
};

export const FontFamily = {
  base: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  mono: '"JetBrains Mono", "SF Mono", Consolas, monospace',
};

export const LetterSpacing = {
  tight: -0.3,
  normal: 0,
  wide: 0.3,
  wider: 0.5,
};

export const Transition = {
  fast: 'all 0.15s ease',
  normal: 'all 0.2s ease',
  slow: 'all 0.3s ease',
};

// ── Motion: unified animation durations (ms) + easing curves ──────────
// Use these across the app so every tap/transition feels like it came
// from the same system. WhatsApp-grade consistency starts here.
export const Motion = {
  instant: 100,      // ripple, haptic-paired flashes
  quick: 160,        // nav push, modal enter
  default: 200,      // standard UI transitions
  deliberate: 280,   // complex fades, list shuffles
  spring: { tension: 180, friction: 16 },           // standard spring
  springBouncy: { tension: 120, friction: 10 },      // hero moments (reactions, hearts)
  springSnappy: { tension: 260, friction: 20 },      // tight returns (dismiss, cancel)
};

// ── Chat bubble system ────────────────────────────────────────────────
// WhatsApp-style geometry, pulled out so every bubble in the app matches.
export const ChatBubble = {
  radius: 14,        // standard bubble corner
  tailRadius: 4,     // pointy corner (the one nearest the sender)
  gap: 2,            // between consecutive messages from same sender
  gapGroup: 8,       // between speaker changes
  paddingX: 12,
  paddingY: 8,
  maxWidth: '78%',   // never consume full row width
};

// ── Haptic helper — never throws on web, single import point ──────────
import { Platform as _HPlatform } from 'react-native';
let _Haptics = null;
function _getHaptics() {
  if (_HPlatform.OS === 'web') return null;
  if (!_Haptics) { try { _Haptics = require('expo-haptics'); } catch {} }
  return _Haptics;
}
export const haptic = {
  light: () => { const H = _getHaptics(); try { H?.impactAsync?.(H.ImpactFeedbackStyle.Light); } catch {} },
  medium: () => { const H = _getHaptics(); try { H?.impactAsync?.(H.ImpactFeedbackStyle.Medium); } catch {} },
  heavy: () => { const H = _getHaptics(); try { H?.impactAsync?.(H.ImpactFeedbackStyle.Heavy); } catch {} },
  select: () => { const H = _getHaptics(); try { H?.selectionAsync?.(); } catch {} },
  success: () => { const H = _getHaptics(); try { H?.notificationAsync?.(H.NotificationFeedbackType.Success); } catch {} },
  warning: () => { const H = _getHaptics(); try { H?.notificationAsync?.(H.NotificationFeedbackType.Warning); } catch {} },
  error: () => { const H = _getHaptics(); try { H?.notificationAsync?.(H.NotificationFeedbackType.Error); } catch {} },
};

export const BorderRadius = {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  xxl: 24,
  full: 999,
};

export const Shadow = {
  sm: {
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.03,
    shadowRadius: 2,
    elevation: 1,
  },
  md: {
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  lg: {
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.07,
    shadowRadius: 8,
    elevation: 4,
  },
  xl: {
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.09,
    shadowRadius: 12,
    elevation: 6,
  },
  // Premium floating shadow for FABs and elevated elements
  float: {
    shadowColor: '#7C3AED',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 20,
    elevation: 8,
  },
  // Soft inner glow effect
  glow: {
    shadowColor: '#A78BFA',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 0,
  },
  // Premium card hover lift
  cardHover: {
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.1,
    shadowRadius: 24,
    elevation: 8,
  },
  // Subtle card at rest
  cardRest: {
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 2,
  },
  // Premium purple glow for send/CTA buttons
  purpleGlow: {
    shadowColor: '#7C3AED',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 8,
  },
  // Soft bubble shadow
  bubble: {
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  // Header shadow — subtle depth
  header: {
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
};

// Glassmorphism presets for dark mode surfaces
export const Glass = {
  surface: {
    backgroundColor: 'rgba(13, 13, 13, 0.80)',
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(24px) saturate(200%)',
      WebkitBackdropFilter: 'blur(24px) saturate(200%)',
    } : {}),
  },
  surfaceLight: {
    backgroundColor: 'rgba(255, 255, 255, 0.72)',
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(20px) saturate(180%)',
      WebkitBackdropFilter: 'blur(20px) saturate(180%)',
    } : {}),
  },
  header: {
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(28px) saturate(200%)',
      WebkitBackdropFilter: 'blur(28px) saturate(200%)',
    } : {}),
  },
  card: {
    backgroundColor: 'rgba(20, 20, 20, 0.65)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 16,
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(16px)',
      WebkitBackdropFilter: 'blur(16px)',
    } : {}),
  },
};

// Premium glassmorphism card styles (light + dark aware)
export const GlassCard = {
  light: {
    backgroundColor: 'rgba(255, 255, 255, 0.72)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.8)',
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(20px) saturate(180%)',
      WebkitBackdropFilter: 'blur(20px) saturate(180%)',
      boxShadow: '0 2px 16px rgba(0,0,0,0.04), 0 0 0 1px rgba(255,255,255,0.6)',
    } : {}),
  },
  dark: {
    backgroundColor: 'rgba(13, 13, 13, 0.70)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 16,
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(24px) saturate(200%)',
      WebkitBackdropFilter: 'blur(24px) saturate(200%)',
      boxShadow: '0 4px 24px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.04)',
    } : {}),
  },
};

// Gradient presets (2026 refined)
export const Gradients = {
  primary: ['#7C3AED', '#A78BFA'],
  primarySoft: ['#EDE9FE', '#DDD6FE'],
  accent: ['#A78BFA', '#8b5cf6'],
  success: ['#10b981', '#34d399'],
  danger: ['#ef4444', '#f87171'],
  warning: ['#f59e0b', '#fbbf24'],
  sunset: ['#f59e0b', '#ef4444'],
  ocean: ['#0ea5e9', '#06b6d4'],
  purple: ['#8b5cf6', '#ec4899'],
  dark: ['#0f172a', '#1e293b'],
  star: ['#f59e0b', '#fbbf24'],
  unreadDot: ['#7C3AED', '#A78BFA'],
  statusRing: ['#f09433', '#e6683c', '#dc2743', '#cc2366', '#bc1888', '#8a3ab9', '#4c68d7', '#6db3f2'],
  gold: ['#d4a744', '#f5d780', '#d4a744'],
  chatSend: ['#7C3AED', '#6D28D9'],
  primaryButton: ['#7C3AED', '#5B21B6'],
  // Premium header — deeper, richer purple
  header: ['#5B21B6', '#7C3AED'],
  headerDark: ['#1a0a2e', '#2e1065'],
  // Premium tab indicator
  tabIndicator: ['#7C3AED', '#A78BFA'],
  // Chat bubble glow (own)
  bubbleGlow: ['rgba(124,58,237,0.15)', 'rgba(124,58,237,0)'],
  // Modern send button with depth
  sendButton: ['#8B5CF6', '#7C3AED', '#6D28D9'],
  // Premium badge
  premiumBadge: ['#7C3AED', '#A855F7'],
};

// Animation timing constants
export const AnimTiming = {
  // Durations (ms) — snappy, modern feel.
  // Why: dropped `normal` 200→180 and `slow` 250→220 so default fades feel
  // closer to iOS 17 cadence; entrance + pageTransition stay long enough to
  // read as a real screen change without dragging.
  instant: 80,
  fast: 120,
  normal: 180,
  slow: 220,
  entrance: 280,
  pageTransition: 320,

  // Spring presets (2026 refined — iOS-quality feel).
  // Why this round: gentle was floppy (lingered ~600ms); modal entered too
  // slowly to feel responsive; snappy was slightly "slap"-ish. Tightened all
  // three so transitions across the app feel like they share the same
  // mass-and-damping system instead of drifting per-screen.
  springGentle: { tension: 160, friction: 16 },
  springBouncy: { tension: 200, friction: 12 },
  springSnappy: { tension: 320, friction: 24 },
  springSmooth: { tension: 220, friction: 18 },
  springPremium: { tension: 180, friction: 16 },
  // WhatsApp-like tab switch (fast settle, no bounce)
  springTab: { tension: 260, friction: 26 },
  // Silky button press feedback
  springPress: { tension: 400, friction: 28 },
  // Elegant modal entrance — bumped tension so sheets feel snappier on present
  springModal: { tension: 190, friction: 22 },

  // Stagger delays
  staggerFast: 20,
  staggerNormal: 35,
  staggerSlow: 50,

  // Easing curves (use with Easing from react-native)
  decelerate: 'cubic-bezier(0.0, 0.0, 0.2, 1)',
  accelerate: 'cubic-bezier(0.4, 0.0, 1, 1)',
  standard: 'cubic-bezier(0.4, 0.0, 0.2, 1)',
  overshoot: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
};

// Grace period (ms) before the "Reconectando…" banner is shown after a WS
// disconnect. Shared across the chat conversation screen and the chat list so
// the banner appears/disappears at the same cadence everywhere — previously
// chat-conversation used 5000ms and ChatListTab used 12000-15000ms, which made
// the banner flicker on one screen but not the other during the same blip.
export const RECONNECT_BANNER_GRACE_MS = 9000;
