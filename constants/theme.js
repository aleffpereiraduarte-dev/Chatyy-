import { Platform } from 'react-native';
import { scaleSize, moderateScale } from '../utils/responsive';

// ─────────────────────────────────────────────────────────────────────────
// CHATYY "NEUTRAL 2026" PALETTE — WhatsApp / iMessage minimalist.
//
// Direction (founder, 2026-09-28): "TIRAR O ROXO, deixar NEUTRO/BRANCO, o
// mais clean e leve possível".
//   • ZERO purple. Every violet (#A582F7 / #A78BFA / #8b5cf6 / #5B21B6 …) is
//     GONE — redirected to neutral gray (decorative) or the action green.
//   • Background = white / barely-there gray; text = near-black gray. Lots of
//     breathing room.
//   • Color lives ONLY in actions: ONE sober WhatsApp-style green (teal
//     #111111, same in light + dark) on send button, links, active states,
//     badges, focus. Everything structural is neutral gray.
//   • Chat bubbles are NEUTRAL: mine = light gray, other = white. No colored
//     bubble.
//   • ZERO gradient — every Gradients preset is now a solid (two equal stops):
//     neutral gray (decorative) or the action green.
//   • Shadows are very subtle; no glow. Functional color (error red / success
//     green / warning amber) kept ONLY where it carries meaning.
//   • NO keys removed — every screen that references a key still resolves;
//     only the VALUE changed.
//
// Purple → neutral/green redirects (was violet, now):
//   primary(+Light/Dark/Container/on*), secondary/tertiary(+variants),
//   brand{Primary,Secondary,Accent}, chatPrimary, chatBubbleOwn(+Border),
//   unreadAccent, selectedBg, starColor, badge, composeBg, selectedCheckbox,
//   focusBorder, sidebarActiveBg, meetScreenShare, meetHandRaised, all auth*
//   accents/steps, storageGradient* (→ neutral gray), avatarColors (→ gray),
//   Shadow.glow/purpleGlow (→ green, subtle), all Gradients (→ solid).
// ─────────────────────────────────────────────────────────────────────────

export const Colors = {
  // Primary — the single ACTION color: sober WhatsApp teal-green. Used ONLY on
  // actions/links/active states. Everything structural stays neutral gray.
  primary: '#111111',
  primaryLight: '#F2F3F5',
  primaryDark: '#111111',
  primaryContainer: '#F2F3F5',
  onPrimary: '#ffffff',
  onPrimaryContainer: '#111111',

  // Background / Surface — clean WHITE (2026-09-30 "much less black, more
  // white"): page is pure white now, not off-gray, for a lighter, airier feel.
  background: '#ffffff',
  surface: '#ffffff',
  surfaceVariant: '#F0F1F3',
  surfaceHover: '#F2F3F5',

  // Header — WhitE header with dark text/icons (WhatsApp 2026). Was already
  // white at the token level; the components used to hardcode a black header
  // and now read these tokens / use colors.text on a white surface.
  headerBg: 'rgba(255, 255, 255, 0.95)',
  headerBgSolid: '#ffffff',
  headerBorder: '#eef0f1',
  sidebarActiveBg: 'rgba(17, 17, 17, 0.10)',

  // Text — WhatsApp ink ramp. name/text #111b21, muted/secondary #667781.
  text: '#111b21',
  textSecondary: '#667781',
  textTertiary: '#8696a0',
  textOnPrimary: '#ffffff',

  // Border — very light hairline (#eef0f1) so rows/sections read as airy.
  border: '#eef0f1',
  borderLight: '#F4F5F6',
  divider: '#eef0f1',

  // Chips (filter pills) — inactive = light gray fill, active = small black.
  chipBg: '#f0f2f5',
  chipText: '#667781',
  chipActiveBg: '#111111',
  chipActiveText: '#ffffff',

  // Status — functional only, kept saturated so meaning still reads
  error: '#dc2626',
  errorBg: '#fef2f2',
  success: '#16a34a',
  successBg: '#f0fdf4',
  warning: '#d97706',
  warningBg: '#fffbeb',

  // Email states — active/selected get a whisper of the action green; star = green
  unreadBg: '#F2F3F5',
  unreadAccent: '#111111',
  selectedBg: '#F2F3F5',
  starColor: '#111111',
  starEmpty: '#CBD0D6',

  // Compose — solid action green
  composeBg: '#111111',
  composeText: '#ffffff',

  // Sidebar — badge = action green (single-accent, WhatsApp-style)
  sidebarBg: '#ffffff',
  folderActive: '#F2F3F5',
  folderHover: '#F2F3F5',
  badge: '#111111',
  onBadge: '#ffffff',

  // Avatar — neutral gray tones only (no violet)
  avatarBg: '#8A9099',
  avatarColors: ['#6B6B6B', '#5A5A5A', '#777777', '#4F4F4F'], // [2026-10-10] P&B puro (R=G=B)

  // Chat — NEUTRAL bubbles (2026-10-03): ENVIADO e RECEBIDO agora têm tons
  // claramente distintos (antes own #E7E9EC ~ other #FFFFFF ~ fundo #f0f2f5 =
  // tudo "flat"). RECEBIDO = branco puro; ENVIADO = cinza-neutro nitidamente
  // mais escuro, que descola tanto do branco quanto do fundo. Zero cor.
  chatPrimary: '#111111',
  chatBubbleOwn: '#D7DCE1',
  chatBubbleOwnBorder: 'rgba(0,0,0,0.06)',
  chatBubbleOther: '#FFFFFF',
  chatBubbleOtherBorder: 'rgba(0,0,0,0.08)',
  chatBubbleOwnText: '#111B21',
  chatBackground: '#F5F6F8',
  chatInputBg: '#FFFFFF',
  chatInputBorder: 'rgba(0,0,0,0.08)',

  // Overlay
  overlay: 'rgba(0, 0, 0, 0.4)',
  shadow: '#101114',

  // Features
  hoverActionBg: 'rgba(0, 0, 0, 0.04)',
  toastBg: '#2A2C30',
  toastText: '#f8fafc',
  checkboxColor: '#65676B',
  selectedCheckbox: '#111111',
  focusBorder: '#111111',
  bulkToolbarBg: '#F2F3F5',
  gradientStart: '#111111',
  gradientEnd: '#111111',
  loginPanelBg: '#F2F3F5',

  // Focus glow — action green, softened
  focusGlow: 'rgba(17, 17, 17, 0.12)',

  // Secondary & Tertiary accents — collapsed onto the single action green
  secondary: '#111111',
  secondaryLight: '#F2F3F5',
  secondaryDark: '#111111',
  tertiary: '#111111',
  tertiaryLight: '#F2F3F5',
  tertiaryDark: '#111111',

  // Brand colors — all point at the action green; danger stays (functional)
  brandPrimary: '#111111',
  brandSecondary: '#111111',
  brandAccent: '#111111',
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

  // Storage gradient — neutral gray (decorative, was purple). Solid: 3 equal.
  storageGradientStart: '#9AA0A6',
  storageGradientMid: '#9AA0A6',
  storageGradientEnd: '#9AA0A6',

  // Meeting — neutral dark call UI; end-call red stays (functional),
  // screen-share / hand-raised = action green.
  meetBg: '#0F1013',
  meetSurface: 'rgba(28, 30, 34, 0.92)',
  meetSurfaceSolid: '#1C1E22',
  meetText: '#f1f5f9',
  meetTextSecondary: '#9AA0A6',
  meetBorder: 'rgba(255, 255, 255, 0.1)',
  meetBtnBg: 'rgba(255, 255, 255, 0.12)',
  meetBtnActive: '#dc2626',
  meetEndCall: '#dc2626',
  meetScreenShare: '#111111',
  meetHandRaised: '#111111',

  // Connection status — functional traffic-light, kept
  connectionGood: '#16a34a',
  connectionWarn: '#f59e0b',
  connectionBad: '#dc2626',

  // Auth pages — neutral gray surfaces; accents / links / steps = action green
  authBg: '#F7F8FA',
  authBgSubtle: '#F0F1F3',
  // [2026-10-06 UX] Accent used by AUTH screens for links / wordmark / primary
  // CTA. Light = brand ink (#111). Dark INVERTS to white: primary '#111111'
  // on authBg '#000000' was invisible (title rgb(17,17,17) on black, links and
  // "Próximo" black-on-black on web dark mode).
  authAccent: '#111111',
  authOnAccent: '#ffffff',
  authPatternColor: 'rgba(17, 17, 17, 0.03)',
  authPatternDot: 'rgba(17, 17, 17, 0.06)',
  authCardBg: '#ffffff',
  authCardBorder: 'transparent',
  authCardShadow: 'rgba(0, 0, 0, 0.06)',
  authInputBg: 'transparent',
  authInputBorder: '#dadce0',
  authInputFocusBorder: '#111111',
  authInputFocusGlow: 'rgba(17, 17, 17, 0.08)',
  authLabelColor: '#5f6368',
  authLabelFloatColor: '#111111',
  authDividerColor: '#E6E8EB',
  authFooterText: '#8A8D91',
  authFooterLink: '#111111',
  authBtnGradientStart: '#111111',
  authBtnGradientEnd: '#111111',
  authSecondaryBtn: 'rgba(17, 17, 17, 0.04)',
  authSecondaryBtnBorder: '#E6E8EB',
  authSecondaryBtnHover: 'rgba(17, 17, 17, 0.08)',
  authAccentGlow: 'rgba(17, 17, 17, 0.08)',
  authAccentLine: 'rgba(17, 17, 17, 0.15)',
  authStepDoneBg: '#111111',
  authStepActiveBg: '#111111',
  authStepPendingBg: '#CBD0D6',
  authStepConnector: '#E6E8EB',
  authStepConnectorDone: '#111111',
  authSuccessGreen: '#10b981',
  authChipBg: '#F2F3F5',
  authChipBorder: '#E6E8EB',
  authLeftPanelBg: '#F2F3F5',
  authLeftPanelAccent: '#111111',
  authGridColor: 'rgba(17, 17, 17, 0.04)',
};

export const DarkColors = {
  // Primary — SAME single action green as light (sober teal), so it stays
  // consistent everywhere. ThemeContext's accent override applies one hex to
  // both modes, so light and dark must share it. Kept muted/"sóbrio" per brief.
  // [2026-10-08 dark-black] Dark primary = WHITE ink (inverted). '#111111' was
  // literally invisible on the black surfaces (calls chips, empty-state CTAs,
  // feed search...). CTAs filled with `primary` must use `onPrimary` (black).
  primary: '#F5F5F7',
  primaryLight: '#2C2C2E',
  primaryDark: '#E5E5EA',
  primaryContainer: '#2C2C2E',
  onPrimary: '#000000',
  onPrimaryContainer: '#F5F5F7',

  // Background / Surface — [2026-10-08 dark-black] TRUE black/neutral (no navy):
  // page #000, surface #0b0b0b (chat list), cards/elevated #1c1c1e → #2c2c2e.
  background: '#000000',
  surface: '#0b0b0b',
  surfaceVariant: '#1c1c1e',
  surfaceHover: '#161618',
  surfaceElevated: '#1c1c1e',
  surfaceGlass: 'rgba(11, 11, 11, 0.78)',
  surfaceGlassBorder: 'rgba(255, 255, 255, 0.08)',

  // Header dark — neutral #0b0b0b with light text/icons.
  headerBg: 'rgba(11, 11, 11, 0.97)',
  headerBgSolid: '#0b0b0b',
  headerBorder: 'rgba(255, 255, 255, 0.1)',
  sidebarActiveBg: 'rgba(255, 255, 255, 0.08)',

  // Text — Apple-dark neutral ink ramp. text #F5F5F7, muted #8E8E93.
  text: '#F5F5F7',
  textSecondary: '#8E8E93',
  textTertiary: '#6C6C70',
  textOnPrimary: '#000000',

  // Border — neutral white hairlines (no blue cast).
  border: '#2C2C2E',
  borderLight: 'rgba(255, 255, 255, 0.06)',
  divider: 'rgba(255, 255, 255, 0.1)',

  // Chips — inactive = dark surface, active = light accent (small).
  chipBg: '#1c1c1e',
  chipText: '#8E8E93',
  chipActiveBg: '#F5F5F7',
  chipActiveText: '#000000',

  // Status — functional
  error: '#f87171',
  errorBg: '#450a0a',
  success: '#4ade80',
  successBg: '#052e16',
  warning: '#fbbf24',
  warningBg: '#451a03',

  // Email states — active/selected = subtle green; star = action green
  unreadBg: '#161618',
  unreadAccent: '#F5F5F7',
  selectedBg: '#1c1c1e',
  starColor: '#F5F5F7',
  starEmpty: '#4A4D52',

  // Compose
  composeBg: '#1c1c1e',
  composeText: '#ffffff',

  // Sidebar — badge = action green
  sidebarBg: '#0b0b0b',
  folderActive: '#1c1c1e',
  folderHover: '#161618',
  badge: '#F5F5F7',
  onBadge: '#000000', // [2026-10-08 dark-black] ink on the white dark badge

  // Avatar — neutral gray tones only (no violet)
  avatarBg: '#7C828A',
  avatarColors: ['#5E5E5E', '#4C4C4C', '#696969', '#424242'], // [2026-10-10] P&B puro (R=G=B)

  // Chat — NEUTRAL bubbles [2026-10-08 dark-black]: preto/cinza Apple (sem azul).
  // ENVIADO #333336 (mais claro), RECEBIDO #1C1C1E, texto #F5F5F7.
  chatPrimary: '#F5F5F7',
  chatBubbleOwn: '#333336',
  chatBubbleOwnBorder: 'rgba(255,255,255,0.05)',
  chatBubbleOther: '#1C1C1E',
  chatBubbleOtherBorder: 'rgba(255,255,255,0.06)',
  chatBubbleOwnText: '#F5F5F7',
  chatBackground: '#000000',
  chatInputBg: '#1c1c1e',
  chatInputBorder: 'rgba(255,255,255,0.1)',

  // Overlay
  overlay: 'rgba(0, 0, 0, 0.6)',
  shadow: '#000',

  // Features
  hoverActionBg: 'rgba(255, 255, 255, 0.06)',
  toastBg: '#F5F5F7',
  toastText: '#000000',
  checkboxColor: '#8E8E93',
  selectedCheckbox: '#F5F5F7',
  focusBorder: '#F5F5F7',
  bulkToolbarBg: '#1c1c1e',
  gradientStart: '#2C2C2E',
  gradientEnd: '#1c1c1e',
  loginPanelBg: '#000000',

  // Focus glow — action green, softened
  focusGlow: 'rgba(255, 255, 255, 0.16)',

  // Secondary & Tertiary accents — collapsed onto the single action green
  secondary: '#F5F5F7',
  secondaryLight: '#2C2C2E',
  secondaryDark: '#E5E5EA',
  tertiary: '#F5F5F7',
  tertiaryLight: '#2C2C2E',
  tertiaryDark: '#E5E5EA',

  // Brand colors — all point at the action green; danger stays
  brandPrimary: '#F5F5F7',
  brandSecondary: '#F5F5F7',
  brandAccent: '#F5F5F7',
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

  // Storage gradient — neutral gray (decorative, was purple). Solid: 3 equal.
  storageGradientStart: '#5A5E64',
  storageGradientMid: '#5A5E64',
  storageGradientEnd: '#5A5E64',

  // Meeting — OLED; end-call red stays, screen-share / hand-raised = action green
  meetBg: '#000000',
  meetSurface: 'rgba(13, 13, 13, 0.95)',
  meetSurfaceSolid: '#0d0d0d',
  meetText: '#f1f5f9',
  meetTextSecondary: '#9AA0A6',
  meetBorder: 'rgba(255, 255, 255, 0.08)',
  meetBtnBg: 'rgba(255, 255, 255, 0.1)',
  meetBtnActive: '#f87171',
  meetEndCall: '#f87171',
  meetScreenShare: '#2C2C2E', // white-ink banners sit on it (meet is dark-only)
  meetHandRaised: '#2C2C2E',

  // Connection status — functional
  connectionGood: '#4ade80',
  connectionWarn: '#fbbf24',
  connectionBad: '#f87171',

  // Auth pages — neutral near-black surfaces; accents / links / steps = action green
  authBg: '#000000',
  authBgSubtle: '#0d0d0d',
  // [2026-10-06 UX] Dark auth accent = WHITE (ink inverted). Every token below
  // that used to be '#111111' was literally black-on-black on the web dark
  // login/forgot/signup screens (wordmark, links, focus ring, primary CTA).
  authAccent: '#ffffff',
  authOnAccent: '#111111',
  authPatternColor: 'rgba(255, 255, 255, 0.04)',
  authPatternDot: 'rgba(255, 255, 255, 0.08)',
  authCardBg: '#0d0d0d',
  authCardBorder: 'rgba(255, 255, 255, 0.06)',
  authCardShadow: 'rgba(0, 0, 0, 0.5)',
  authInputBg: '#000000',
  authInputBorder: 'rgba(255, 255, 255, 0.08)',
  authInputFocusBorder: '#F5F5F7',
  authInputFocusGlow: 'rgba(255, 255, 255, 0.12)',
  authLabelColor: '#9BA0A6',
  authLabelFloatColor: '#F5F5F7',
  authDividerColor: 'rgba(255, 255, 255, 0.08)',
  authFooterText: '#8E8E93',
  authFooterLink: '#F5F5F7',
  authBtnGradientStart: '#ffffff',
  authBtnGradientEnd: '#F5F5F7',
  authSecondaryBtn: 'rgba(255, 255, 255, 0.06)',
  authSecondaryBtnBorder: 'rgba(255, 255, 255, 0.2)',
  authSecondaryBtnHover: 'rgba(255, 255, 255, 0.12)',
  authAccentGlow: 'rgba(255, 255, 255, 0.08)',
  authAccentLine: 'rgba(255, 255, 255, 0.15)',
  authStepDoneBg: '#F5F5F7',
  authStepActiveBg: '#ffffff',
  authStepPendingBg: '#4A4D52',
  authStepConnector: 'rgba(255, 255, 255, 0.08)',
  authStepConnectorDone: '#F5F5F7',
  authSuccessGreen: '#34d399',
  authChipBg: 'rgba(255, 255, 255, 0.08)',
  authChipBorder: 'rgba(255, 255, 255, 0.16)',
  authLeftPanelBg: '#1c1c1e',
  authLeftPanelAccent: '#F5F5F7',
  authGridColor: 'rgba(255, 255, 255, 0.04)',
};

// Espaçamento — escala PARCIAL (moderateScale) com a tela. Em celular pequeno
// encolhe um pouco pra caber mais conteúdo; não some de vez (factor 0.5).
// DENSIDADE 2026 (nível Gmail web): escala reduzida ~15-25% pra caber MAIS
// conteúdo por tela sem parecer apertado. Todas as chaves mantidas.
export const Spacing = {
  xs: moderateScale(3),    // era 4
  sm: moderateScale(5),    // era 6 (2ª passada compacta)
  md: moderateScale(8),    // era 10
  lg: moderateScale(11),   // era 13
  xl: moderateScale(14),   // era 16
  xxl: moderateScale(17),  // era 20
  xxxl: moderateScale(22), // era 26
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
  xxl: scaleSize(17),   // era 18 (2ª passada: cabeçalhos mais leves)
  title: scaleSize(19), // era 20
  heading: scaleSize(22), // era 24
  hero: scaleSize(28),  // era 32
};

export const FontFamily = {
  base: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  mono: '"JetBrains Mono", "SF Mono", Consolas, monospace',
};

// 2026 type tracking — tighter on headings for a confident, modern hierarchy
// (~-0.02 to -0.03em at heading sizes). Body/labels stay calm at 0.
export const LetterSpacing = {
  tightest: -0.6, // hero / display numbers
  tighter: -0.4,  // titles / section headings
  tight: -0.3,    // sub-headings / dense labels
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
// DENSIDADE 2026: bolhas mais enxutas (menos padding, gaps menores, raio um
// pouco menor) pra caber mais conversa por tela sem apertar a leitura.
export const ChatBubble = {
  radius: 14,        // era 16 — cantos arredondados uniformes (mais reto/clean)
  tailRadius: 14,    // era 16 — tail-less (sem canto pontudo)
  gap: 2,            // between consecutive messages from same sender
  gapGroup: 5,       // era 6 — between speaker changes
  paddingX: 14,      // 11→10 cortava a última letra de bolhas curtas (ex "TA BOM"/"Que top" perdia a última letra — sem overflow:hidden o glifo transborda pro cinza). 14 dá folga total p/ a medição levemente estreita do iOS nunca encostar na borda
  paddingY: 6,       // era 7
  maxWidth: '83%',   // era 82% — compensa o padding menor
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

// DENSIDADE 2026: raios um pouco menores = visual mais reto/clean tipo Gmail.
// Todas as chaves mantidas.
// 2026 radius scale — consistent medium corners: controls 8, cards 12,
// sheets 16 (modern, not pills everywhere). Still compact/clean, just cleaner
// stepping than the old 3/6/8/10/14 ramp.
export const BorderRadius = {
  sm: 4,    // was 3 — chips / inner controls
  md: 8,    // was 6 — buttons / inputs / controls
  lg: 10,   // was 8 — small cards
  xl: 12,   // was 10 — cards
  xxl: 16,  // was 14 — sheets / modals
  full: 999,
};

// Sombras — NEUTRAL 2026: elevação bem SUTIL (menos peso), SEM glow colorido.
// Opacidades reduzidas em toda a escala; a separação vem das bordas suaves, não
// da sombra. `glow`/`purpleGlow` mantêm o nome (telas referenciam) mas agora são
// discretos e neutros/verde-ação — nada de brilho roxo.
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
  // Soft inner glow effect (bem sutil) — action green, not purple
  glow: {
    shadowColor: '#111111',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.05,
    shadowRadius: 12,
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
  // Send/CTA shadow — key name kept (screens reference it); now a SUBTLE
  // neutral lift on the action green, no colored glow.
  purpleGlow: {
    shadowColor: '#111111',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.10,
    shadowRadius: 10,
    elevation: 4,
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

// Gradient presets — NEUTRAL 2026: ZERO gradient. Every preset is now a SOLID
// (all stops equal) — either the action green or neutral gray. Functional ones
// (success/danger/warning) stay their meaning color, just flattened. No key
// removed so every screen that reads a preset still resolves.
export const Gradients = {
  primary: ['#111111', '#111111'],
  primarySoft: ['#F2F3F5', '#F2F3F5'],
  accent: ['#111111', '#111111'],
  success: ['#16a34a', '#16a34a'],
  danger: ['#ef4444', '#ef4444'],
  warning: ['#f59e0b', '#f59e0b'],
  // Decorative → neutral gray solid (were amber/red, blue).
  sunset: ['#9AA0A6', '#9AA0A6'],
  ocean: ['#9AA0A6', '#9AA0A6'],
  // Was purple → action green solid.
  purple: ['#111111', '#111111'],
  dark: ['#101114', '#101114'],
  star: ['#111111', '#111111'],
  unreadDot: ['#111111', '#111111'],
  // Story ring — was rainbow (had purple/blue) → action green solid.
  statusRing: ['#111111', '#111111'],
  // Decorative gold → neutral gray solid.
  gold: ['#9AA0A6', '#9AA0A6'],
  chatSend: ['#111111', '#111111'],
  primaryButton: ['#111111', '#111111'],
  // Header — neutral gray solid (structural, not an action).
  header: ['#9AA0A6', '#9AA0A6'],
  headerDark: ['#1C1E22', '#1C1E22'],
  // Tab indicator — action green solid.
  tabIndicator: ['#111111', '#111111'],
  // Chat bubble glow (own) — neutralized to transparent (bubble is neutral).
  bubbleGlow: ['rgba(0,0,0,0.04)', 'rgba(0,0,0,0)'],
  // Send button — action green solid.
  sendButton: ['#111111', '#111111', '#111111'],
  // Premium badge — neutral gray solid.
  premiumBadge: ['#9AA0A6', '#9AA0A6'],
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
