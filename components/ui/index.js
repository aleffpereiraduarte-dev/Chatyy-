// ═════════════════════════════════════════════════════════════════════════
// components/ui — DESIGN SYSTEM CHATYY "P&B premium" (2026-10-13)
// ═════════════════════════════════════════════════════════════════════════
// Uma linguagem só p/ o app inteiro: preto e branco, minimalista, nível
// Apple/WhatsApp/Instagram/Linear. Cor SÓ p/ estado (erro/sucesso/não lido).
// Antes de criar um botão/linha/header inline numa tela, use daqui.
//
//   import { Button, ListRow, Card, TopBar, AppText } from '../components/ui';
//
// ── TOKENS (constants/theme.js, bloco "DESIGN SYSTEM 2026") ────────────────
//   Type      escala nomeada: largeTitle 32 · title1 26 · title2 22 · title3 19 ·
//             headline 16/600 · body 16 · callout 15 · subhead 14 · footnote 13 ·
//             caption 12 · caption2 11 · sectionCaps · button · buttonSm.
//             Uso: style={[Type.headline, { color: s.text }]}
//   Space     grade 4/8: xxs2 xs4 sm8 md12 lg16(gutter) xl20 xxl24 xxxl32 huge48
//   Radius    xs4 · sm8 · control10 (botão/campo) · card14 · sheet20 · pill999
//   Duration  instant100 · fast150 · base200 · slow260 · page320  (+ Easing2026)
//   Layout    hitTarget44 · gutter16 · rowMinHeight52/64 · topBarHeight52 ·
//             iconSize22 · contentMaxWidth720 · wideMaxWidth1080 · desktopBreakpoint900
//   SurfaceTokens.light/.dark + surfaceColors(colors,isDark) → hook useSurface():
//             bg · bgGrouped · surface (#fff | #111) · surfaceRaised (#fff | #1c1c1e) ·
//             surfaceMuted · fill · pressed · hover · separator · border ·
//             text · textSecondary (AA) · textTertiary (só metadado) · icon ·
//             iconMuted · ink/onInk (botão primário P&B) · danger · success ·
//             unread · shadow (só claro; escuro separa por nível de cinza)
//   Overlay / overlayColors / OverlayShadow — sheets, menus, diálogos, toasts.
//
// ── PRIMITIVOS ─────────────────────────────────────────────────────────────
//   AppText          <AppText variant="footnote" tone="secondary">…</AppText>
//   Button           variant primary|secondary|outline|ghost|destructive|
//                    destructiveGhost · size sm36|md44|lg52 · icon · loading · fullWidth
//   IconButton       ícone circular c/ alvo 44 · variant plain|filled|ink
//   ListRow          célula: icon|iconTile|leading · title · subtitle · value ·
//                    accessory · chevron · destructive · separator · selected
//   SectionHeader    variant list (headline) | grouped (CAPS cinza) | large;
//                    actionLabel+onAction ("Ver tudo")
//   Card             superfície agrupada; padding · elevated · bordered · onPress
//   SegmentedControl options/value/onChange, pílula deslizante (size md|sm)
//   Badge            count (99+) | dot | label; tone ink|neutral|muted|danger|success; ring
//   Divider          hairline; inset · vertical · spacing
//   TopBar           header chapado + hairline + safe-area; title/subtitle ·
//                    largeTitle · onBack · left/right · align · maxWidth (web)
//   Sheet            bottom sheet único (+ SheetHeader, SheetHandle,
//                    sheetContainerStyle, useOverlayColors)  — ./Sheet
//   ActionList       linhas de ação de sheet/menu                — ./ActionList
//   showToast/ToastHost  toasts                                  — ./Toast
//   PressableScale   toque premium (mola + haptic) — botões/cards/ícones
//   PressableRow     toque NATIVO de célula (realce iOS / ripple Android)
//   FadeSlideIn      entrada suave (fade + 8px) — listas/telas, sem exagero
//   Skeleton, SkeletonRow(s), SkeletonBubble, SkeletonFadeIn — loading (nunca
//                    spinner cru numa tela vazia)
//   ScreenEmptyState estado vazio padrão
//   ModalHeader      header de modal legado (prefira TopBar/SheetHeader)
//   AvatarCircle     importar direto de components/AvatarCircle (pesado; fora daqui)
//   Ícones           components/Icons.js (SVG traço fino). NUNCA emoji na UI.
//
// ── REGRAS ─────────────────────────────────────────────────────────────────
//   • Gutter lateral 16; gaps da grade (4/8/12/16/24); nada de 11/13/17 avulso.
//   • Toque ≥ 44px (hitSlop quando o visual é menor). Linhas = PressableRow;
//     botões/cards = PressableScale.
//   • Texto principal = s.text; secundário = s.textSecondary (AA). Cinza
//     claro (textTertiary) só p/ timestamps/metadados.
//   • Claro: branco + hairline (sombra no máx. `s.shadow`). Escuro: #000 fundo,
//     #111 superfície, #1c1c1e elevado, sem sombra.
//   • Web desktop: limite colunas com Layout.contentMaxWidth/wideMaxWidth.
//   • Sempre testar claro E escuro.
// ═════════════════════════════════════════════════════════════════════════

export { default as AppText, toneColor } from './AppText';
export { default as Button, IconButton } from './Button';
export { default as ListRow } from './ListRow';
export { default as SectionHeader } from './SectionHeader';
export { default as Card } from './Card';
export { default as SegmentedControl } from './SegmentedControl';
export { default as Badge } from './Badge';
export { default as Divider } from './Divider';
export { default as TopBar } from './TopBar';
export { default as useSurface } from './useSurface';
export { default as Sheet, SheetHeader, SheetHandle, sheetContainerStyle, useOverlayColors } from './Sheet';
export { default as ActionList } from './ActionList';
export { showToast, hideToast, ToastHost } from './Toast';
export { default as PressableScale } from '../PressableScale';
export { default as PressableRow } from '../PressableRow';
export { default as FadeSlideIn } from '../FadeSlideIn';
export { default as ScreenEmptyState } from '../ScreenEmptyState';
export { default as ModalHeader } from '../ModalHeader';
export { Skeleton, SkeletonRow, SkeletonRows, SkeletonBubble, SkeletonFadeIn } from '../Skeleton';
export {
  Type, Space, Radius, Duration, Easing2026, Layout, SurfaceTokens, surfaceColors,
} from '../../constants/theme';
