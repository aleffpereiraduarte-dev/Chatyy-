import { Platform } from 'react-native';

export const Colors = {
  // Primary — modern vibrant blue
  primary: '#2563eb',
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
  // Primary
  primary: '#60a5fa',
  primaryLight: '#1e3a5f',
  primaryDark: '#93c5fd',
  primaryContainer: '#1e3a5f',
  onPrimary: '#1e3a5f',
  onPrimaryContainer: '#dbeafe',

  // Background / Surface — deeper contrast layers with glassmorphism support
  background: '#0c1220',
  surface: '#151e2e',
  surfaceVariant: '#1e293b',
  surfaceHover: '#1a2332',
  surfaceElevated: '#1e293b',
  surfaceGlass: 'rgba(21, 30, 46, 0.75)',
  surfaceGlassBorder: 'rgba(255, 255, 255, 0.06)',

  // Header dark
  headerBg: 'rgba(21, 30, 46, 0.97)',
  headerBgSolid: '#151e2e',
  headerBorder: 'rgba(255, 255, 255, 0.08)',
  sidebarActiveBg: 'rgba(96, 165, 250, 0.15)',

  // Text
  text: '#f1f5f9',
  textSecondary: '#94a3b8',
  textTertiary: '#64748b',
  textOnPrimary: '#1e3a5f',

  // Border
  border: '#2d3748',
  borderLight: '#1a2332',
  divider: '#334155',

  // Status
  error: '#f87171',
  errorBg: '#450a0a',
  success: '#4ade80',
  successBg: '#052e16',
  warning: '#fbbf24',
  warningBg: '#451a03',

  // Email states
  unreadBg: '#172a45',
  unreadAccent: '#60a5fa',
  selectedBg: '#1a3050',
  starColor: '#f59e0b',
  starEmpty: '#4b5563',

  // Compose
  composeBg: '#2563eb',
  composeText: '#ffffff',

  // Sidebar
  sidebarBg: '#151e2e',
  folderActive: '#172a45',
  folderHover: '#1a2332',
  badge: '#f87171',

  // Avatar
  avatarBg: '#60a5fa',
  avatarColors: ['#60a5fa', '#4ade80', '#f87171', '#fbbf24', '#93c5fd', '#c084fc', '#fb923c', '#2dd4bf'],

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
  gradientStart: '#1e3a5f',
  gradientEnd: '#60a5fa',
  loginPanelBg: '#0f172a',

  // Focus glow
  focusGlow: 'rgba(96, 165, 250, 0.2)',

  // Meeting (dark mode uses same dark tones)
  meetBg: '#0c1220',
  meetSurface: 'rgba(21, 30, 46, 0.95)',
  meetSurfaceSolid: '#151e2e',
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

  // Auth pages — dark tech
  authBg: '#0f172a',
  authBgSubtle: '#1e293b',
  authPatternColor: 'rgba(96, 165, 250, 0.04)',
  authPatternDot: 'rgba(96, 165, 250, 0.08)',
  authCardBg: '#1e293b',
  authCardBorder: '#334155',
  authCardShadow: 'rgba(0, 0, 0, 0.3)',
  authInputBg: '#0f172a',
  authInputBorder: '#334155',
  authInputFocusBorder: '#60a5fa',
  authInputFocusGlow: 'rgba(96, 165, 250, 0.15)',
  authLabelColor: '#94a3b8',
  authLabelFloatColor: '#60a5fa',
  authDividerColor: '#334155',
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
  authStepConnector: '#334155',
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
};

// Glassmorphism presets for dark mode surfaces
export const Glass = {
  surface: {
    backgroundColor: 'rgba(21, 30, 46, 0.75)',
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(20px) saturate(180%)',
      WebkitBackdropFilter: 'blur(20px) saturate(180%)',
    } : {}),
  },
  surfaceLight: {
    backgroundColor: 'rgba(255, 255, 255, 0.7)',
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(16px) saturate(150%)',
      WebkitBackdropFilter: 'blur(16px) saturate(150%)',
    } : {}),
  },
  header: {
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(24px) saturate(200%)',
      WebkitBackdropFilter: 'blur(24px) saturate(200%)',
    } : {}),
  },
  card: {
    backgroundColor: 'rgba(30, 41, 59, 0.6)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
    } : {}),
  },
};

// Animation timing constants
export const AnimTiming = {
  // Durations (ms)
  instant: 100,
  fast: 150,
  normal: 250,
  slow: 350,
  entrance: 400,
  pageTransition: 500,

  // Spring presets
  springGentle: { tension: 120, friction: 14 },
  springBouncy: { tension: 180, friction: 12 },
  springSnappy: { tension: 300, friction: 20 },
  springSmooth: { tension: 200, friction: 18 },
  springPremium: { tension: 160, friction: 16 },

  // Stagger delays
  staggerFast: 30,
  staggerNormal: 50,
  staggerSlow: 80,

  // Easing curves (use with Easing from react-native)
  decelerate: 'cubic-bezier(0.0, 0.0, 0.2, 1)',
  accelerate: 'cubic-bezier(0.4, 0.0, 1, 1)',
  standard: 'cubic-bezier(0.4, 0.0, 0.2, 1)',
  overshoot: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
};
