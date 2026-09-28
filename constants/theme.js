import { Platform } from 'react-native';
import { scaleSize, moderateScale } from '../utils/responsive';

// ─────────────────────────────────────────────────────────────────────────
// CHATYY "CLEAN 2026" PALETTE — WhatsApp-grade calm.
//
// Direction (founder, 2026-09-28): "mais leve, MENOS cores, transições suaves".
//   • ONE brand color — purple #A582F7 (like WhatsApp's single green).
//   • Structure lives in NEUTRAL GRAYS + lots of white/breathing room.
//   • Functional color (error red / success green / warning amber) ONLY where
//     it carries meaning; nowhere decorative.
//   • Decorative accents that used to be pink / amber / green / per-folder hues
//     were REDIRECTED to purple or neutral gray. NO keys were removed — every
//     screen that references a key still resolves; only the VALUE changed. See
//     the redirect list at the bottom of this comment block for screen agents.
//
// Redirected-to-brand/neutral (were decorative, now purple/gray):
//   starColor, badge, secondary(+Light/Dark), brandSecondary, brandAccent,
//   folder{Inbox,Sent,Drafts,Trash,Spam,Archive,Flagged,Snoozed} (all unified),
//   meetHandRaised, authStepDoneBg, authStepConnectorDone, avatarColors (8→4),
//   storageGradientEnd (dark was pink), Gradients.purple (dropped pink stop).
// ─────────────────────────────────────────────────────────────────────────

export const Colors = {
  // Primary — the single brand color (purple). Unchanged: it IS the identity.
  primary: '#A582F7',
  primaryLight: '#EDE9FE',
  primaryDark: '#5B21B6',
  primaryContainer: '#EDE9FE',
  onPrimary: '#ffffff',
  onPrimaryContainer: '#5B21B6',

  // Background / Surface — neutral gray + white (violet tint removed for calm).
  background: '#F6F7F9',
  surface: '#ffffff',
  surfaceVariant: '#F0F2F5',
  surfaceHover: '#F6F7F9',

  // Header
  headerBg: 'rgba(255, 255, 255, 0.95)',
  headerBgSolid: '#ffffff',
  headerBorder: 'rgba(0, 0, 0, 0.06)',
  sidebarActiveBg: 'rgba(165, 130, 247, 0.10)',

  // Text — NEUTRAL gray ramp (was cool slate). textTertiary kept ≥AA (~4.6:1).
  text: '#1C1E21',
  textSecondary: '#65676B',
  textTertiary: '#787C82',
  textOnPrimary: '#ffffff',

  // Border — neutral gray
  border: '#E4E6EB',
  borderLight: '#F0F2F5',
  divider: '#E4E6EB',

  // Status — functional only, kept saturated so meaning still reads
  error: '#dc2626',
  errorBg: '#fef2f2',
  success: '#16a34a',
  successBg: '#f0fdf4',
  warning: '#d97706',
  warningBg: '#fffbeb',

  // Email states — unread/selected use the brand tint; star REDIRECTED amber→purple
  unreadBg: '#F5F3FF',
  unreadAccent: '#A582F7',
  selectedBg: '#EDE9FE',
  starColor: '#A582F7',
  starEmpty: '#CBD0D6',

  // Compose — solid brand
  composeBg: '#A582F7',
  composeText: '#ffffff',

  // Sidebar — badge REDIRECTED red→brand purple (single-accent, WhatsApp-style)
  sidebarBg: '#ffffff',
  folderActive: '#F5F3FF',
  folderHover: '#F6F7F9',
  badge: '#A582F7',

  // Avatar — 8 bright hues REDUCED to 4 muted/neutral tones (1 brand + 3 gray)
  avatarBg: '#8E86B8',
  avatarColors: ['#8E86B8', '#7C8B9A', '#9AA0A6', '#A0968C'],

  // Chat — clean purple bubble system (already refined, kept)
  chatPrimary: '#A582F7',
  chatBubbleOwn: '#EDE9FE',
  chatBubbleOwnBorder: 'rgba(124,58,237,0.08)',
  chatBubbleOther: '#FFFFFF',
  chatBubbleOtherBorder: 'rgba(0,0,0,0.04)',
  chatBackground: '#F3F1F7',
  chatInputBg: '#FFFFFF',
  chatInputBorder: 'rgba(0,0,0,0.06)',

  // Overlay
  overlay: 'rgba(0, 0, 0, 0.4)',
  shadow: '#101114',

  // Features
  hoverActionBg: 'rgba(0, 0, 0, 0.04)',
  toastBg: '#2A2C30',
  toastText: '#f8fafc',
  checkboxColor: '#65676B',
  selectedCheckbox: '#A582F7',
  focusBorder: '#A582F7',
  bulkToolbarBg: '#F5F3FF',
  gradientStart: '#A582F7',
  gradientEnd: '#A78BFA',
  loginPanelBg: '#F5F3FF',

  // Focus glow — brand, softened
  focusGlow: 'rgba(124, 58, 237, 0.12)',

  // Secondary & Tertiary accents — green REDIRECTED to purple family (single brand)
  secondary: '#A582F7',
  secondaryLight: '#EDE9FE',
  secondaryDark: '#5B21B6',
  tertiary: '#A582F7',
  tertiaryLight: '#ede9fe',
  tertiaryDark: '#A582F7',

  // Brand colors — secondary/accent REDIRECTED off green/amber; danger stays (functional)
  brandPrimary: '#A582F7',
  brandSecondary: '#A78BFA',
  brandAccent: '#A582F7',
  brandDanger: '#ef4444',

  // Folder colors — UNIFIED to one neutral gray (was 8 different hues).
  // Screens tint the ACTIVE folder with `primary`; the rest read neutral.
  folderInbox: '#65676B',
  folderSent: '#65676B',
  folderDrafts: '#65676B',
  folderTrash: '#65676B',
  folderSpam: '#65676B',
  folderArchive: '#65676B',
  folderFlagged: '#65676B',
  folderSnoozed: '#65676B',

  // Storage gradient — purple family (pink removed earlier; kept clean)
  storageGradientStart: '#A582F7',
  storageGradientMid: '#A78BFA',
  storageGradientEnd: '#8b5cf6',

  // Meeting — neutral dark call UI; end-call red stays (functional),
  // hand-raised REDIRECTED amber→purple.
  meetBg: '#0F1013',
  meetSurface: 'rgba(28, 30, 34, 0.92)',
  meetSurfaceSolid: '#1C1E22',
  meetText: '#f1f5f9',
  meetTextSecondary: '#9AA0A6',
  meetBorder: 'rgba(255, 255, 255, 0.1)',
  meetBtnBg: 'rgba(255, 255, 255, 0.12)',
  meetBtnActive: '#dc2626',
  meetEndCall: '#dc2626',
  meetScreenShare: '#A582F7',
  meetHandRaised: '#A582F7',

  // Connection status — functional traffic-light, kept
  connectionGood: '#16a34a',
  connectionWarn: '#f59e0b',
  connectionBad: '#dc2626',

  // Auth pages — slate neutralized to gray; step "done" REDIRECTED green→purple
  authBg: '#F6F7F9',
  authBgSubtle: '#EEF0F3',
  authPatternColor: 'rgba(124, 58, 237, 0.03)',
  authPatternDot: 'rgba(124, 58, 237, 0.06)',
  authCardBg: '#ffffff',
  authCardBorder: 'transparent',
  authCardShadow: 'rgba(0, 0, 0, 0.06)',
  authInputBg: 'transparent',
  authInputBorder: '#dadce0',
  authInputFocusBorder: '#A582F7',
  authInputFocusGlow: 'rgba(124, 58, 237, 0.08)',
  authLabelColor: '#5f6368',
  authLabelFloatColor: '#A582F7',
  authDividerColor: '#E4E6EB',
  authFooterText: '#8A8D91',
  authFooterLink: '#65676B',
  authBtnGradientStart: '#A582F7',
  authBtnGradientEnd: '#5B21B6',
  authSecondaryBtn: 'rgba(124, 58, 237, 0.04)',
  authSecondaryBtnBorder: '#EDE9FE',
  authSecondaryBtnHover: 'rgba(124, 58, 237, 0.08)',
  authAccentGlow: 'rgba(124, 58, 237, 0.08)',
  authAccentLine: 'rgba(124, 58, 237, 0.15)',
  authStepDoneBg: '#A582F7',
  authStepActiveBg: '#A582F7',
  authStepPendingBg: '#CBD0D6',
  authStepConnector: '#E4E6EB',
  authStepConnectorDone: '#A582F7',
  authSuccessGreen: '#10b981',
  authChipBg: '#F5F3FF',
  authChipBorder: '#DDD6FE',
  authLeftPanelBg: '#F5F3FF',
  authLeftPanelAccent: '#A582F7',
  authGridColor: 'rgba(124, 58, 237, 0.04)',
};

export const DarkColors = {
  // Primary — single brand color for OLED
  primary: '#A78BFA',
  primaryLight: '#2D1B69',
  primaryDark: '#C4B5FD',
  primaryContainer: '#2D1B69',
  onPrimary: '#1F1147',
  onPrimaryContainer: '#DDD6FE',

  // Background / Surface — NEUTRAL near-black (violet bias removed), layered depth
  background: '#0B0B0D',
  surface: '#161618',
  surfaceVariant: '#202022',
  surfaceHover: '#1C1C1E',
  surfaceElevated: '#202022',
  surfaceGlass: 'rgba(22, 22, 24, 0.78)',
  surfaceGlassBorder: 'rgba(255, 255, 255, 0.08)',

  // Header dark
  headerBg: 'rgba(13, 13, 13, 0.97)',
  headerBgSolid: '#0d0d0d',
  headerBorder: 'rgba(255, 255, 255, 0.06)',
  sidebarActiveBg: 'rgba(167, 139, 250, 0.15)',

  // Text — NEUTRAL gray ramp; tertiary kept ≥AA (~5.6:1) on OLED
  text: '#F0F1F3',
  textSecondary: '#9BA0A6',
  textTertiary: '#868B91',
  textOnPrimary: '#1F1147',

  // Border — subtle for OLED
  border: 'rgba(255, 255, 255, 0.06)',
  borderLight: 'rgba(255, 255, 255, 0.03)',
  divider: 'rgba(255, 255, 255, 0.08)',

  // Status — functional
  error: '#f87171',
  errorBg: '#450a0a',
  success: '#4ade80',
  successBg: '#052e16',
  warning: '#fbbf24',
  warningBg: '#451a03',

  // Email states — star REDIRECTED amber→brand purple
  unreadBg: '#1B1630',
  unreadAccent: '#C4B5FD',
  selectedBg: '#1F1147',
  starColor: '#C4B5FD',
  starEmpty: '#4A4D52',

  // Compose
  composeBg: '#A78BFA',
  composeText: '#ffffff',

  // Sidebar — badge REDIRECTED red→brand purple
  sidebarBg: '#0a0a0a',
  folderActive: '#141414',
  folderHover: '#111111',
  badge: '#A78BFA',

  // Avatar — 8 bright hues REDUCED to 4 muted tones
  avatarBg: '#9A8FC4',
  avatarColors: ['#9A8FC4', '#8B95A3', '#9AA0A6', '#A09488'],

  // Chat — purple bubbles kept; other surfaces neutralized (violet bias removed)
  chatPrimary: '#A78BFA',
  chatBubbleOwn: '#2b1d59',
  chatBubbleOwnBorder: 'rgba(158,123,255,0.30)',
  chatBubbleOther: '#202022',
  chatBubbleOtherBorder: 'rgba(255,255,255,0.08)',
  chatBackground: '#0B0B0D',
  chatInputBg: '#161618',
  chatInputBorder: 'rgba(255,255,255,0.08)',

  // Overlay
  overlay: 'rgba(0, 0, 0, 0.6)',
  shadow: '#000',

  // Features
  hoverActionBg: 'rgba(255, 255, 255, 0.06)',
  toastBg: '#F0F1F3',
  toastText: '#1C1E21',
  checkboxColor: '#9BA0A6',
  selectedCheckbox: '#A78BFA',
  focusBorder: '#A78BFA',
  bulkToolbarBg: '#2D1B69',
  gradientStart: '#1F1147',
  gradientEnd: '#C4B5FD',
  loginPanelBg: '#000000',

  // Focus glow — softened
  focusGlow: 'rgba(167, 139, 250, 0.16)',

  // Secondary & Tertiary accents — green REDIRECTED to purple family
  secondary: '#A78BFA',
  secondaryLight: '#2D1B69',
  secondaryDark: '#C4B5FD',
  tertiary: '#d094ff',
  tertiaryLight: '#2e1065',
  tertiaryDark: '#e4c4ff',

  // Brand colors — secondary/accent REDIRECTED off green/amber; danger stays
  brandPrimary: '#C4B5FD',
  brandSecondary: '#A78BFA',
  brandAccent: '#C4B5FD',
  brandDanger: '#f87171',

  // Folder colors — UNIFIED to one neutral gray
  folderInbox: '#9BA0A6',
  folderSent: '#9BA0A6',
  folderDrafts: '#9BA0A6',
  folderTrash: '#9BA0A6',
  folderSpam: '#9BA0A6',
  folderArchive: '#9BA0A6',
  folderFlagged: '#9BA0A6',
  folderSnoozed: '#9BA0A6',

  // Storage gradient — pink END REDIRECTED to purple (was #f472b6)
  storageGradientStart: '#A78BFA',
  storageGradientMid: '#C4B5FD',
  storageGradientEnd: '#8b5cf6',

  // Meeting — OLED; end-call red stays, hand-raised REDIRECTED amber→purple
  meetBg: '#000000',
  meetSurface: 'rgba(13, 13, 13, 0.95)',
  meetSurfaceSolid: '#0d0d0d',
  meetText: '#f1f5f9',
  meetTextSecondary: '#9AA0A6',
  meetBorder: 'rgba(255, 255, 255, 0.08)',
  meetBtnBg: 'rgba(255, 255, 255, 0.1)',
  meetBtnActive: '#f87171',
  meetEndCall: '#f87171',
  meetScreenShare: '#A78BFA',
  meetHandRaised: '#C4B5FD',

  // Connection status — functional
  connectionGood: '#4ade80',
  connectionWarn: '#fbbf24',
  connectionBad: '#f87171',

  // Auth pages — slate neutralized; step "done" REDIRECTED green→purple
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
  authLabelColor: '#9BA0A6',
  authLabelFloatColor: '#A78BFA',
  authDividerColor: 'rgba(255, 255, 255, 0.08)',
  authFooterText: '#6B6F76',
  authFooterLink: '#868B91',
  authBtnGradientStart: '#A78BFA',
  authBtnGradientEnd: '#A582F7',
  authSecondaryBtn: 'rgba(167, 139, 250, 0.06)',
  authSecondaryBtnBorder: 'rgba(167, 139, 250, 0.2)',
  authSecondaryBtnHover: 'rgba(167, 139, 250, 0.12)',
  authAccentGlow: 'rgba(167, 139, 250, 0.1)',
  authAccentLine: 'rgba(167, 139, 250, 0.12)',
  authStepDoneBg: '#A78BFA',
  authStepActiveBg: '#A78BFA',
  authStepPendingBg: '#4A4D52',
  authStepConnector: 'rgba(255, 255, 255, 0.08)',
  authStepConnectorDone: '#A78BFA',
  authSuccessGreen: '#34d399',
  authChipBg: 'rgba(167, 139, 250, 0.1)',
  authChipBorder: 'rgba(167, 139, 250, 0.2)',
  authLeftPanelBg: '#1C1E22',
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
  xs: scaleSize(12),
  sm: scaleSize(13),
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

// Transições (web/CSS) — CLEAN 2026: durações curtas (150–220ms) + easing
// ease-out (decelerate). Toque leve e suave, nada arrastado. As três chaves
// existentes ficam; só os valores encurtaram e trocaram 'ease' pela curva
// cubic-bezier(0,0,0.2,1) (padrão Material "decelerate", entrada macia).
export const Transition = {
  fast: 'all 0.15s cubic-bezier(0, 0, 0.2, 1)',
  normal: 'all 0.18s cubic-bezier(0, 0, 0.2, 1)',
  slow: 'all 0.22s cubic-bezier(0, 0, 0.2, 1)',
};

// ── Motion: unified animation durations (ms) + easing curves ──────────
// CLEAN 2026: durações curtas e suaves (nada acima de ~240ms nos padrões).
export const Motion = {
  instant: 100,      // ripple, haptic-paired flashes
  quick: 160,        // nav push, modal enter
  default: 200,      // standard UI transitions
  deliberate: 240,   // complex fades, list shuffles (era 280 — encurtado)
  spring: { tension: 180, friction: 18 },            // standard spring (mais amortecido)
  springBouncy: { tension: 140, friction: 14 },      // hero moments (menos bounce)
  springSnappy: { tension: 260, friction: 22 },      // tight returns (dismiss, cancel)
};

// ── Chat bubble system ────────────────────────────────────────────────
// WhatsApp-style geometry, pulled out so every bubble in the app matches.
export const ChatBubble = {
  radius: 20,        // 2026: cantos arredondados uniformes
  tailRadius: 20,    // tail-less (sem canto pontudo) — visual matte/flat
  gap: 3,            // between consecutive messages from same sender
  gapGroup: 8,       // between speaker changes
  paddingX: 13,
  paddingY: 9,
  maxWidth: '80%',
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

// Sombras — CLEAN 2026: elevação mais SUTIL (menos peso). Opacidades reduzidas
// em toda a escala; o único brilho de marca continua sendo `purpleGlow` (send/CTA
// principal), agora mais discreto. Bordas suaves fazem a separação, não a sombra.
export const Shadow = {
  sm: {
    shadowColor: '#101114',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.03,
    shadowRadius: 2,
    elevation: 1,
  },
  md: {
    shadowColor: '#101114',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
  },
  lg: {
    shadowColor: '#101114',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  xl: {
    shadowColor: '#101114',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.07,
    shadowRadius: 12,
    elevation: 5,
  },
  // Elevação neutra suave — bem mais leve (era 0.28).
  float: {
    shadowColor: '#101114',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.14,
    shadowRadius: 18,
    elevation: 8,
  },
  // Soft inner glow effect (bem sutil)
  glow: {
    shadowColor: '#A78BFA',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.06,
    shadowRadius: 14,
    elevation: 0,
  },
  // Premium card hover lift — mais discreto
  cardHover: {
    shadowColor: '#101114',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 20,
    elevation: 6,
  },
  // Subtle card at rest
  cardRest: {
    shadowColor: '#101114',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 2,
  },
  // O ÚNICO brilho de marca — send/CTA principal (mais discreto: 0.20 → 0.16)
  purpleGlow: {
    shadowColor: '#6d28d9',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.16,
    shadowRadius: 16,
    elevation: 6,
  },
  // Bolhas matte — sombra por-bolha quase nula (a borda dá a separação)
  bubble: {
    shadowColor: '#101114',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.02,
    shadowRadius: 2,
    elevation: 0,
  },
  // Header shadow — mais leve (era 0.08)
  header: {
    shadowColor: '#101114',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
};

// Glassmorphism presets for dark mode surfaces
export const Glass = {
  surface: {
    backgroundColor: 'rgba(22, 22, 24, 0.78)',
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

// Gradient presets — CLEAN 2026: os gradientes de MARCA ficam mono-hue (roxo).
// `purple` perdeu a parada rosa (#ec4899). Os gradientes FUNCIONAIS (success/
// danger/warning/star) e de feature específica (statusRing/gold/ocean/sunset)
// seguem, mas os agentes de tela devem preferir cor sólida + roxo onde puderem.
export const Gradients = {
  primary: ['#A582F7', '#A78BFA'],
  primarySoft: ['#EDE9FE', '#DDD6FE'],
  accent: ['#A78BFA', '#A582F7'],
  success: ['#10b981', '#34d399'],
  danger: ['#ef4444', '#f87171'],
  warning: ['#f59e0b', '#fbbf24'],
  sunset: ['#f59e0b', '#ef4444'],
  ocean: ['#0ea5e9', '#06b6d4'],
  // Rosa removido — família roxo (marca única).
  purple: ['#A582F7', '#8b5cf6'],
  dark: ['#101114', '#1C1E22'],
  star: ['#f59e0b', '#fbbf24'],
  unreadDot: ['#A582F7', '#A78BFA'],
  statusRing: ['#f09433', '#e6683c', '#dc2743', '#cc2366', '#bc1888', '#8a3ab9', '#4c68d7', '#6db3f2'],
  gold: ['#d4a744', '#f5d780', '#d4a744'],
  chatSend: ['#A582F7', '#6D28D9'],
  primaryButton: ['#A582F7', '#5B21B6'],
  // Premium header — deeper, richer purple
  header: ['#5B21B6', '#A582F7'],
  headerDark: ['#1a0a2e', '#2e1065'],
  // Premium tab indicator
  tabIndicator: ['#A582F7', '#A78BFA'],
  // Chat bubble glow (own)
  bubbleGlow: ['rgba(124,58,237,0.15)', 'rgba(124,58,237,0)'],
  // Modern send button with depth
  sendButton: ['#A582F7', '#A582F7', '#6D28D9'],
  // Premium badge
  premiumBadge: ['#A582F7', '#A855F7'],
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
  entrance: 260,
  pageTransition: 300,

  // Spring presets (CLEAN 2026 — suave e amortecido, sem "floppy" nem "slap").
  springGentle: { tension: 160, friction: 18 },
  springBouncy: { tension: 190, friction: 14 },
  springSnappy: { tension: 320, friction: 26 },
  springSmooth: { tension: 220, friction: 20 },
  springPremium: { tension: 180, friction: 18 },
  // WhatsApp-like tab switch (fast settle, no bounce)
  springTab: { tension: 260, friction: 26 },
  // Silky button press feedback
  springPress: { tension: 400, friction: 28 },
  // Elegant modal entrance
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
