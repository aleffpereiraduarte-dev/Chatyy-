// [mural 2026-10-20] Tokens do mockup preview-2026/perfil.html (P&B premium).
// Vermelho #ff2d55 SÓ no coração curtido.
import { useMemo } from 'react';
import { useTheme } from '../../context/ThemeContext';
import { THEME_V2, Grafite } from '../../constants/theme';

export const LIKE = '#ff2d55';

const LIGHT = {
  bg: '#f2f2f7', card: '#ffffff', text: '#0b0b0c', muted: '#8a8a8f', line: 'rgba(0,0,0,0.08)',
  accent: '#0b0b0c', accentInk: '#ffffff', chip: '#ececf1', danger: '#e5484d', like: LIKE,
  paper: '#f2f2f7', paperInk: '#0b0b0c', ink: '#0b0b0c', inkInk: '#ffffff', isDark: false,
};
const DARK = {
  bg: '#000000', card: '#1c1c1e', text: '#f5f5f7', muted: '#8e8e93', line: 'rgba(255,255,255,0.1)',
  accent: '#f5f5f7', accentInk: '#000000', chip: '#2c2c2e', danger: '#e5484d', like: LIKE,
  paper: '#2c2c2e', paperInk: '#f5f5f7', ink: '#f5f5f7', inkInk: '#000000', isDark: true,
};

// [2026-10-20 grafite] tema v2: cinzas quentes + cartões com sombra, grade gap 4 / raio 10.
const _GL = Grafite.light; const _GD = Grafite.dark;
const LIGHT_V2 = {
  ...LIGHT, bg: _GL.bg, card: _GL.surface, text: _GL.text, muted: _GL.muted, line: _GL.line,
  accent: _GL.ink, accentInk: _GL.onInk, chip: _GL.surface2, paper: _GL.surface2, paperInk: _GL.text, ink: _GL.ink, inkInk: _GL.onInk,
  v2: true, cardRadius: Grafite.radius.card, tileRadius: Grafite.radius.tile, gridGap: 4,
};
const DARK_V2 = {
  ...DARK, bg: _GD.bg, card: _GD.surface, text: _GD.text, muted: _GD.muted, line: _GD.line,
  accent: _GD.ink, accentInk: _GD.onInk, chip: _GD.surface2, paper: _GD.surface2, paperInk: _GD.text, ink: _GD.ink, inkInk: _GD.onInk,
  v2: true, cardRadius: Grafite.radius.card, tileRadius: Grafite.radius.tile, gridGap: 4,
};

export function muralTokens(isDark) { return THEME_V2 ? (isDark ? DARK_V2 : LIGHT_V2) : (isDark ? DARK : LIGHT); }

export function useMuralTheme() {
  const th = useTheme() || {};
  const isDark = !!th.isDark;
  return useMemo(() => muralTokens(isDark), [isDark]);
}

/** 1234 → "1,2 mil" (pt) / "1.2K" (en). */
export function fmtCount(n, lang) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  const en = /^en/i.test(String(lang || ''));
  if (v < 1e6) {
    const k = (v / 1000).toFixed(v < 10000 ? 1 : 0).replace(/\.0$/, '');
    return en ? `${k}K` : `${k.replace('.', ',')} mil`;
  }
  const m = (v / 1e6).toFixed(1).replace(/\.0$/, '');
  return en ? `${m}M` : `${m.replace('.', ',')} mi`;
}
