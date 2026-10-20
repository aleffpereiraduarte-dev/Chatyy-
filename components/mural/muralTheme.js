// [mural 2026-10-20] Tokens do mockup preview-2026/perfil.html (P&B premium).
// Vermelho #ff2d55 SÓ no coração curtido.
import { useMemo } from 'react';
import { useTheme } from '../../context/ThemeContext';

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

export function muralTokens(isDark) { return isDark ? DARK : LIGHT; }

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
