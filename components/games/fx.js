// components/games/fx.js — [jogos 2026-10-18] haptics + paleta P&B dos jogos (nunca lança).
import { Platform } from 'react-native';

function H() { try { return require('expo-haptics'); } catch { return null; } }
function snd(n) { try { require('./sound').playSfx(n); } catch {} }
const web = Platform.OS === 'web';
// Mapa único som+háptico (polish 2): tap=seleção, move/capture/card/draw=impacto, ok/win=sucesso,
// err/nope=erro, turn=aviso, king/last=destaque. Mesmo gesto = mesmo retorno em todos os jogos.
export function hTap() { snd('tap'); if (web) return; try { H().selectionAsync(); } catch {} }
export function hMove() { snd('move'); if (web) return; try { const h = H(); h.impactAsync(h.ImpactFeedbackStyle.Light); } catch {} }
export function hCapture() { snd('capture'); if (web) return; try { const h = H(); h.impactAsync(h.ImpactFeedbackStyle.Heavy); } catch {} }
export function hCard() { snd('card'); if (web) return; try { const h = H(); h.impactAsync(h.ImpactFeedbackStyle.Light); } catch {} }
export function hDraw() { snd('draw'); if (web) return; try { H().selectionAsync(); } catch {} }
export function hOk() { snd('correct'); if (web) return; try { const h = H(); h.notificationAsync(h.NotificationFeedbackType.Success); } catch {} }
export function hWin() { snd('win'); if (web) return; try { const h = H(); h.notificationAsync(h.NotificationFeedbackType.Success); } catch {} }
export function hErr() { snd('wrong'); if (web) return; try { const h = H(); h.notificationAsync(h.NotificationFeedbackType.Error); } catch {} }
export function hNope() { snd('wrong'); if (web) return; try { const h = H(); h.impactAsync(h.ImpactFeedbackStyle.Rigid || h.ImpactFeedbackStyle.Medium); } catch {} }
export function hKing() { snd('correct'); if (web) return; try { const h = H(); h.impactAsync(h.ImpactFeedbackStyle.Medium); } catch {} }
export function hLast() { snd('turn'); if (web) return; try { const h = H(); h.impactAsync(h.ImpactFeedbackStyle.Medium); } catch {} }
export function hReveal() { if (web) return; try { const h = H(); h.impactAsync(h.ImpactFeedbackStyle.Soft || h.ImpactFeedbackStyle.Light); } catch {} }
export function hEnd() { snd('turn'); if (web) return; try { const h = H(); h.notificationAsync(h.NotificationFeedbackType.Warning); } catch {} }
export function hTurn() { snd('turn'); if (web) return; try { const h = H(); h.notificationAsync(h.NotificationFeedbackType.Warning); } catch {} }

/** Paleta premium preto e branco (tema claro/escuro). */
export function gamePalette(colors, isDark) {
  return {
    bg: colors.background || (isDark ? '#000000' : '#FFFFFF'),
    ink: colors.text || (isDark ? '#FFFFFF' : '#0A0A0A'),
    sub: colors.textSecondary || (isDark ? '#A1A1AA' : '#6B7280'),
    card: isDark ? '#141416' : '#F5F5F6',
    card2: isDark ? '#1E1E21' : '#EBEBED',
    line: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)',
    strong: isDark ? '#FFFFFF' : '#0A0A0A',
    onStrong: isDark ? '#0A0A0A' : '#FFFFFF',
    good: '#16A34A',
    bad: '#DC2626',
    hl: isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.10)',
    boardLight: isDark ? '#5B5B60' : '#EDEDED',
    boardDark: isDark ? '#1E1E21' : '#3C3C3F',
    frame: isDark ? '#2C2C2E' : '#0A0A0A',
    // acento discreto (só dentro dos tabuleiros/cartas): dourado do "último lance"/dama/linha vencedora
    accent: isDark ? '#FFD60A' : '#E0A800',
    accentSoft: isDark ? 'rgba(255,214,10,0.22)' : 'rgba(224,168,0,0.18)',
    shadow: isDark ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.18)',
    dark: !!isDark,
  };
}
export const CARD_COLORS = { r: '#E5484D', y: '#F0B400', g: '#22A55B', b: '#2F6FEB' };
