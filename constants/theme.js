import { Platform } from 'react-native';

export const Colors = {
  // Primary — Cosmic Purple
  primary: '#7C3AED',
  primaryLight: '#dbeafe',
  primaryDark: '#1d4ed8',
  primaryContainer: '#bfdbfe',
  onPrimary: '#ffffff',
  onPrimaryContainer: '#1e3a5f',

  // Background / Surface — warm slate
  background: '#f8fafc',
  surface: '#ffffff',
  surfaceVariant: '#f1f5f9',
  surfaceHover: '#f8fafc',

  // Header
  headerBg: 'rgba(255, 255, 255, 0.95)',
  headerBgSolid: '#ffffff',
  headerBorder: 'rgba(0, 0, 0, 0.06)',
  sidebarActiveBg: 'rgba(37, 99, 235, 0.08)',

  // Text — slate palette
  text: '#0f172a',
  textSecondary: '#64748b',
  textTertiary: '#94a3b8',
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
  unreadBg: '#eff6ff',
  unreadAccent: '#2563eb',
  selectedBg: '#dbeafe',
  starColor: '#f59e0b',
  starEmpty: '#d1d5db',

  // Compose — solid primary
  composeBg: '#2563eb',
  composeText: '#ffffff',

  // Sidebar
  sidebarBg: '#ffffff',
  folderActive: '#eff6ff',
  folderHover: '#f8fafc',
  badge: '#dc2626',

  // Avatar
  avatarBg: '#60a5fa',
  avatarColors: ['#2563eb', '#16a34a', '#dc2626', '#f59e0b', '#60a5fa', '#8b5cf6', '#ea580c', '#0d9488'],

  // Chat — Cosmic Purple
  chatPrimary: '#7C3AED',
  chatBubbleOwn: '#EDE9FE',
  chatBubbleOther: '#FFFFFF',
  chatBackground: '#F3EFF8',

  // Overlay
  overlay: 'rgba(0, 0, 0, 0.4)',
  shadow: '#0f172a',

  // Features
  hoverActionBg: 'rgba(0, 0, 0, 0.04)',
  toastBg: '#1e293b',
  toastText: '#f8fafc',
  checkboxColor: '#64748b',
  selectedCheckbox: '#2563eb',
  focusBorder: '#2563eb',
  bulkToolbarBg: '#eff6ff',
  gradientStart: '#2563eb',
  gradientEnd: '#60a5fa',
  loginPanelBg: '#eff6ff',

  // Focus glow
  focusGlow: 'rgba(37, 99, 235, 0.15)',

  // Secondary & Tertiary accents
  secondary: '#10b981',
  secondaryLight: '#d1fae5',
  secondaryDark: '#059669',
  tertiary: '#8b5cf6',
  tertiaryLight: '#ede9fe',
  tertiaryDark: '#7c3aed',

  // Brand colors
  brandPrimary: '#2563eb',
  brandSecondary: '#10b981',
  brandAccent: '#f59e0b',
  brandDanger: '#ef4444',

  // Folder colors
  folderInbox: '#2563eb',
  folderSent: '#10b981',
  folderDrafts: '#f59e0b',
  folderTrash: '#ef4444',
  folderSpam: '#8b5cf6',
  folderArchive: '#6b7280',
  folderFlagged: '#f59e0b',
  folderSnoozed: '#6366f1',

  // Storage gradient
  storageGradientStart: '#2563eb',
  storageGradientMid: '#8b5cf6',
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
  meetScreenShare: '#2563eb',
  meetHandRaised: '#f59e0b',

  // Connection status
  connectionGood: '#16a34a',
  connectionWarn: '#f59e0b',
  connectionBad: '#dc2626',

  // Auth pages — Google Material Design 3 style
  authBg: '#f0f4f9',
  authBgSubtle: '#e8edf5',
  authPatternColor: 'rgba(37, 99, 235, 0.03)',
  authPatternDot: 'rgba(37, 99, 235, 0.06)',
  authCardBg: '#ffffff',
  authCardBorder: 'transparent',
  authCardShadow: 'rgba(0, 0, 0, 0.08)',
  authInputBg: 'transparent',
  authInputBorder: '#dadce0',
  authInputFocusBorder: '#1a73e8',
  authInputFocusGlow: 'rgba(26, 115, 232, 0.08)',
  authLabelColor: '#5f6368',
  authLabelFloatColor: '#2563eb',
  authDividerColor: '#e2e8f0',
  authFooterText: '#94a3b8',
  authFooterLink: '#64748b',
  authBtnGradientStart: '#2563eb',
  authBtnGradientEnd: '#1d4ed8',
  authSecondaryBtn: 'rgba(37, 99, 235, 0.04)',
  authSecondaryBtnBorder: '#dbeafe',
  authSecondaryBtnHover: 'rgba(37, 99, 235, 0.08)',
  authAccentGlow: 'rgba(37, 99, 235, 0.08)',
  authAccentLine: 'rgba(37, 99, 235, 0.15)',
  authStepDoneBg: '#10b981',
  authStepActiveBg: '#2563eb',
  authStepPendingBg: '#cbd5e1',
  authStepConnector: '#e2e8f0',
  authStepConnectorDone: '#10b981',
  authSuccessGreen: '#10b981',
  authChipBg: '#eff6ff',
  authChipBorder: '#bfdbfe',
  authLeftPanelBg: '#f0f5ff',
  authLeftPanelAccent: '#2563eb',
  authGridColor: 'rgba(37, 99, 235, 0.04)',
};

export const DarkColors = {
  // Primary — Cosmic Purple for OLED
  primary: '#A78BFA',
  primaryLight: '#1e3a5f',
  primaryDark: '#a3d0ff',
  primaryContainer: '#1e3a5f',
  onPrimary: '#1e3a5f',
  onPrimaryContainer: '#dbeafe',

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
  sidebarActiveBg: 'rgba(96, 165, 250, 0.15)',

  // Text
  text: '#f1f5f9',
  textSecondary: '#94a3b8',
  textTertiary: '#64748b',
  textOnPrimary: '#1e3a5f',

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
  unreadBg: '#0a1628',
  unreadAccent: '#6db3ff',
  selectedBg: '#0d1f3d',
  starColor: '#f59e0b',
  starEmpty: '#4b5563',

  // Compose
  composeBg: '#2563eb',
  composeText: '#ffffff',

  // Sidebar — OLED
  sidebarBg: '#0a0a0a',
  folderActive: '#141414',
  folderHover: '#111111',
  badge: '#f87171',

  // Avatar
  avatarBg: '#60a5fa',
  avatarColors: ['#60a5fa', '#4ade80', '#f87171', '#fbbf24', '#93c5fd', '#c084fc', '#fb923c', '#2dd4bf'],

  // Chat — Cosmic Purple Dark
  chatPrimary: '#A78BFA',
  chatBubbleOwn: '#4C1D95',
  chatBubbleOther: '#1E1A2E',
  chatBackground: '#0E0A18',

  // Overlay
  overlay: 'rgba(0, 0, 0, 0.6)',
  shadow: '#000',

  // Features
  hoverActionBg: 'rgba(255, 255, 255, 0.06)',
  toastBg: '#f1f5f9',
  toastText: '#0f172a',
  checkboxColor: '#94a3b8',
  selectedCheckbox: '#60a5fa',
  focusBorder: '#60a5fa',
  bulkToolbarBg: '#1e3a5f',
  gradientStart: '#0a1e3d',
  gradientEnd: '#6db3ff',
  loginPanelBg: '#000000',

  // Focus glow
  focusGlow: 'rgba(96, 165, 250, 0.2)',

  // Secondary & Tertiary accents — brighter for OLED
  secondary: '#3de8a8',
  secondaryLight: '#064e3b',
  secondaryDark: '#7aefca',
  tertiary: '#d094ff',
  tertiaryLight: '#2e1065',
  tertiaryDark: '#e4c4ff',

  // Brand colors — brighter for OLED
  brandPrimary: '#6db3ff',
  brandSecondary: '#3de8a8',
  brandAccent: '#fbbf24',
  brandDanger: '#f87171',

  // Folder colors
  folderInbox: '#60a5fa',
  folderSent: '#34d399',
  folderDrafts: '#fbbf24',
  folderTrash: '#f87171',
  folderSpam: '#c084fc',
  folderArchive: '#9ca3af',
  folderFlagged: '#fbbf24',
  folderSnoozed: '#818cf8',

  // Storage gradient
  storageGradientStart: '#60a5fa',
  storageGradientMid: '#c084fc',
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
  meetScreenShare: '#60a5fa',
  meetHandRaised: '#fbbf24',

  // Connection status
  connectionGood: '#4ade80',
  connectionWarn: '#fbbf24',
  connectionBad: '#f87171',

  // Auth pages — OLED dark tech
  authBg: '#000000',
  authBgSubtle: '#0d0d0d',
  authPatternColor: 'rgba(96, 165, 250, 0.04)',
  authPatternDot: 'rgba(96, 165, 250, 0.08)',
  authCardBg: '#0d0d0d',
  authCardBorder: 'rgba(255, 255, 255, 0.06)',
  authCardShadow: 'rgba(0, 0, 0, 0.5)',
  authInputBg: '#000000',
  authInputBorder: 'rgba(255, 255, 255, 0.08)',
  authInputFocusBorder: '#60a5fa',
  authInputFocusGlow: 'rgba(96, 165, 250, 0.15)',
  authLabelColor: '#94a3b8',
  authLabelFloatColor: '#60a5fa',
  authDividerColor: 'rgba(255, 255, 255, 0.08)',
  authFooterText: '#475569',
  authFooterLink: '#64748b',
  authBtnGradientStart: '#3b82f6',
  authBtnGradientEnd: '#2563eb',
  authSecondaryBtn: 'rgba(96, 165, 250, 0.06)',
  authSecondaryBtnBorder: 'rgba(96, 165, 250, 0.2)',
  authSecondaryBtnHover: 'rgba(96, 165, 250, 0.12)',
  authAccentGlow: 'rgba(96, 165, 250, 0.1)',
  authAccentLine: 'rgba(96, 165, 250, 0.12)',
  authStepDoneBg: '#34d399',
  authStepActiveBg: '#60a5fa',
  authStepPendingBg: '#475569',
  authStepConnector: 'rgba(255, 255, 255, 0.08)',
  authStepConnectorDone: '#34d399',
  authSuccessGreen: '#34d399',
  authChipBg: 'rgba(96, 165, 250, 0.1)',
  authChipBorder: 'rgba(96, 165, 250, 0.2)',
  authLeftPanelBg: '#1e293b',
  authLeftPanelAccent: '#60a5fa',
  authGridColor: 'rgba(96, 165, 250, 0.04)',
};

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

export const FontSize = {
  xs: 11,
  sm: 12,
  md: 13,
  base: 14,
  lg: 15,
  xl: 16,
  xxl: 18,
  title: 20,
  heading: 24,
  hero: 32,
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
    shadowColor: '#2563eb',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 20,
    elevation: 8,
  },
  // Soft inner glow effect
  glow: {
    shadowColor: '#60a5fa',
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

// Gradient presets
export const Gradients = {
  primary: ['#2563eb', '#6366f1'],
  primarySoft: ['#dbeafe', '#e0e7ff'],
  accent: ['#6366f1', '#8b5cf6'],
  success: ['#10b981', '#34d399'],
  danger: ['#ef4444', '#f87171'],
  warning: ['#f59e0b', '#fbbf24'],
  sunset: ['#f59e0b', '#ef4444'],
  ocean: ['#2563eb', '#06b6d4'],
  purple: ['#8b5cf6', '#ec4899'],
  dark: ['#0f172a', '#1e293b'],
  // For star glow
  star: ['#f59e0b', '#fbbf24'],
  // Unread dot
  unreadDot: ['#2563eb', '#6366f1'],
  // Instagram-like rainbow ring
  statusRing: ['#f09433', '#e6683c', '#dc2743', '#cc2366', '#bc1888', '#8a3ab9', '#4c68d7', '#6db3f2'],
  // Premium gold
  gold: ['#d4a744', '#f5d780', '#d4a744'],
  // Chat send button
  chatSend: ['#7C3AED', '#6D28D9'],
  // Modern primary button
  primaryButton: ['#2563eb', '#4f46e5'],
};

// Animation timing constants
export const AnimTiming = {
  // Durations (ms) — snappy, modern feel
  instant: 80,
  fast: 120,
  normal: 200,
  slow: 250,
  entrance: 300,
  pageTransition: 350,

  // Spring presets
  springGentle: { tension: 140, friction: 14 },
  springBouncy: { tension: 200, friction: 12 },
  springSnappy: { tension: 340, friction: 22 },
  springSmooth: { tension: 220, friction: 18 },
  springPremium: { tension: 180, friction: 16 },

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
