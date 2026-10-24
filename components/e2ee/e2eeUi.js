// [e2ee5 WP-15 2026-10-21] Base comum dos componentes de UX da criptografia de ponta a ponta.
//
// Flag: TUDO aqui fica invisível até o caminho E2EE v5 ligar. Os componentes só desenham quando
// isE2eeUiEnabled() === true; desligado = devolvem null (comportamento de hoje, byte a byte).
//   - global.__chatyy_e2ee5_ui === true  → liga a UX (QA / prévia de telas)
//   - global.__chatyy_e2ee5 === true     → liga junto com o caminho novo (WP-08c), salvo
//                                          global.__chatyy_e2ee5_ui === false (kill só da UX)
// Nada liga por padrão. Ver components/e2ee/PLUGAR.md.
import React from 'react';
import Svg, { Path, Rect, Circle, Line } from 'react-native-svg';

export function isE2eeUiEnabled() {
  try {
    const g = typeof globalThis !== 'undefined' ? globalThis : global;
    if (g.__chatyy_e2ee5_ui === false) return false;
    return g.__chatyy_e2ee5_ui === true || g.__chatyy_e2ee5 === true;
  } catch { return false; }
}

// Página pública (WP-15 também é dono dela).
export const E2EE_LEARN_URL = 'https://chatyy.app/p/criptografia.html';

// Paleta do aviso "amarelo" (o mesmo tom do WhatsApp) — claro e escuro.
export function noticePalette(isDark) {
  return isDark
    ? { bg: 'rgba(255, 214, 102, 0.13)', fg: '#F2E2A8', icon: '#F2E2A8', border: 'rgba(255, 214, 102, 0.22)' }
    : { bg: '#FFF4C7', fg: '#5B4A12', icon: '#5B4A12', border: 'rgba(91, 74, 18, 0.10)' };
}

// Cadeado (SVG, nunca emoji). `filled` = corpo cheio (selo pequeno).
export function LockGlyph({ size = 12, color = '#111', filled = true, style }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" style={style} accessible={false}>
      <Rect x="4" y="10.5" width="16" height="11" rx="2.6" fill={filled ? color : 'none'} stroke={color} strokeWidth={filled ? 0 : 2} />
      <Path d="M8 10.5V7.4a4 4 0 0 1 8 0v3.1" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
      {filled ? <Circle cx="12" cy="15.6" r="1.6" fill="#fff" opacity={0.9} /> : null}
    </Svg>
  );
}

// Cadeado aberto/cortado: selo "não criptografado".
export function LockOffGlyph({ size = 12, color = '#111', style }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" style={style} accessible={false}>
      <Rect x="4" y="10.5" width="16" height="11" rx="2.6" fill="none" stroke={color} strokeWidth={2} />
      <Path d="M8 10.5V7.4a4 4 0 0 1 7.6-1.7" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
      <Line x1="3" y1="3" x2="21" y2="21" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

// Relógio (mensagem aguardando a chave).
export function ClockGlyph({ size = 14, color = '#111', style }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" style={style} accessible={false}>
      <Circle cx="12" cy="12" r="9" fill="none" stroke={color} strokeWidth={2} />
      <Path d="M12 7v5l3 2" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

// Escudo com check (código verificado / mudou).
export function ShieldGlyph({ size = 14, color = '#111', check = false, style }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" style={style} accessible={false}>
      <Path d="M12 2.5l7.5 3v6c0 4.6-3.1 8.4-7.5 10-4.4-1.6-7.5-5.4-7.5-10v-6z" fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
      {check ? <Path d="M8.5 12.2l2.4 2.4 4.6-4.8" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /> : null}
    </Svg>
  );
}

// 60 dígitos → 12 grupos de 5 (CONTRATO §6.6). Aceita com ou sem espaços.
export function safetyDigitGroups(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (d.length !== 60) return [];
  const out = [];
  for (let i = 0; i < 60; i += 5) out.push(d.slice(i, i + 5));
  return out;
}

// Texto "12345 67890 …" em 3 linhas de 4 grupos (para copiar/compartilhar).
export function safetyDigitsText(digits) {
  const g = safetyDigitGroups(digits);
  if (!g.length) return '';
  return [g.slice(0, 4), g.slice(4, 8), g.slice(8, 12)].map((r) => r.join(' ')).join('\n');
}

// t() com texto de reserva quando a chave ainda não chegou ao idioma (nunca chave crua).
export function tx(t, key, fallback, params) {
  try {
    const v = t(key, params);
    if (typeof v === 'string' && v && v !== key) return v;
  } catch {}
  let s = fallback || '';
  if (params) Object.keys(params).forEach((k) => { s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(params[k])); });
  return s;
}
