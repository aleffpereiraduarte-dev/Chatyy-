// [2026-10-19 family-hub] Primitivas visuais do hub "Família" (P&B premium,
// mesmo sistema das Configurações): paleta agrupada, ícones locais que o
// Icons.js não tem (carrinho, QR, agenda) e helpers de data/status.
import React from 'react';
import { View, Text } from 'react-native';
import Svg, { Path, Rect, Circle, Line } from 'react-native-svg';
import { useTheme } from '../../context/ThemeContext';
import { useGroupedColors } from '../settings/SettingsKit';

// Paleta do hub. Ação primária = colors.primary (destaque do usuário quando o
// tema exporta um; P&B por padrão) com texto colors.onPrimary.
export function useFamilyColors() {
  const { colors = {}, isDark } = useTheme() || {};
  const g = useGroupedColors();
  const pill = colors.primary || (isDark ? '#F5F5F7' : '#111111');
  const onPill = colors.onPrimary || (isDark ? '#000000' : '#FFFFFF');
  return {
    ...g,
    colors,
    isDark: !!isDark,
    pill,
    onPill,
    tileBg: isDark ? '#3A3A3C' : '#2C2C2E',
    tileFg: '#FFFFFF',
    chip: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(118,118,128,0.12)',
    chipOn: isDark ? '#F5F5F7' : '#111111',
    onChipOn: isDark ? '#000000' : '#FFFFFF',
    online: colors.success || (isDark ? '#30D158' : '#22A447'),
    danger: colors.error || '#DC2626',
    placeholder: isDark ? '#2C2C2E' : '#E5E5EA',
  };
}

function Ic({ size = 22, color = '#fff', children, strokeWidth = 1.9 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </Svg>
  );
}
export function IconCart({ size, color }) {
  return <Ic size={size} color={color}><Circle cx="9" cy="20" r="1.4" /><Circle cx="18" cy="20" r="1.4" /><Path d="M2.5 3h2.6l2.3 11.2a1.8 1.8 0 0 0 1.8 1.4h8.6a1.8 1.8 0 0 0 1.8-1.4L21 7H6.1" /></Ic>;
}
export function IconQr({ size, color }) {
  return (
    <Ic size={size} color={color}>
      <Rect x="3" y="3" width="7" height="7" rx="1.5" /><Rect x="14" y="3" width="7" height="7" rx="1.5" /><Rect x="3" y="14" width="7" height="7" rx="1.5" />
      <Path d="M14 14h3v3h-3zM20 14v.01M14 20v.01M17 20h4v-3" />
    </Ic>
  );
}
export function IconContactBook({ size, color }) {
  return (
    <Ic size={size} color={color}>
      <Rect x="4" y="2.5" width="16" height="19" rx="2.5" /><Circle cx="12" cy="10" r="3" /><Path d="M7.5 17.5a4.8 4.8 0 0 1 9 0" /><Line x1="2.5" y1="7" x2="4" y2="7" /><Line x1="2.5" y1="12" x2="4" y2="12" /><Line x1="2.5" y1="17" x2="4" y2="17" />
    </Ic>
  );
}
export function IconMap({ size, color }) {
  return <Ic size={size} color={color}><Path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6z" /><Line x1="9" y1="4" x2="9" y2="18" /><Line x1="15" y1="6" x2="15" y2="20" /></Ic>;
}

// Quadrado grafite com glifo branco (igual aos ícones novos das Configurações).
export function GraphiteTile({ Icon, size = 40, radius }) {
  const c = useFamilyColors();
  if (!Icon) return null;
  return (
    <View style={{ width: size, height: size, borderRadius: radius ?? Math.round(size * 0.26), backgroundColor: c.tileBg, alignItems: 'center', justifyContent: 'center' }}>
      <Icon size={Math.round(size * 0.52)} color={c.tileFg} />
    </View>
  );
}

// Cabeçalho de seção (caixa-alta pequena, fora do cartão) + ação à direita.
export function HubSectionHeader({ title, action, onAction }) {
  const c = useFamilyColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', paddingHorizontal: 20, marginBottom: 8, marginTop: 26 }}>
      <Text style={{ fontSize: 13, fontWeight: '600', letterSpacing: 0.3, textTransform: 'uppercase', color: c.header }} accessibilityRole="header">{title}</Text>
      {!!action && (
        <Text onPress={onAction} suppressHighlighting style={{ fontSize: 15, fontWeight: '600', color: c.text }} accessibilityRole="button">{action}</Text>
      )}
    </View>
  );
}

// ── Datas ──
// "2026-10-20 18:30:00" / ISO / epoch → Date local (Hermes não parseia o
// formato com espaço de forma confiável).
export function parseWhen(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
  const s = String(v).trim();
  if (/^\d{9,13}$/.test(s)) { const n = Number(s); return new Date(n < 1e12 ? n * 1000 : n); }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s.slice(10))) {
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  }
  const d = Date.parse(s);
  return Number.isNaN(d) ? null : new Date(d);
}
export function hasTime(v) {
  const s = String(v || '');
  const m = s.match(/[ T](\d{2}):(\d{2})/);
  return !!m && !(m[1] === '00' && m[2] === '00');
}
export function pad2(n) { return String(n).padStart(2, '0'); }
export function toStartsAt(date, hh = 0, mm = 0) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(hh)}:${pad2(mm)}:00`;
}

// Relativo curto ("agora", "há 5 min") — aceita epoch s/ms e ISO.
// Carimbos do servidor (updated_at/last_seen) vêm em UTC SEM 'Z' (igual ao
// snap-map) → trata como UTC. Datas de evento usam parseWhen (hora local).
export function parseUtc(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d{9,13}$/.test(String(v).trim())) return parseWhen(v);
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = Date.parse(s.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1') + 'Z');
    return Number.isNaN(d) ? null : new Date(d);
  }
  return parseWhen(s);
}

export function relativeAgo(v, t) {
  const d = parseUtc(v);
  if (!d) return null;
  const diff = Date.now() - d.getTime();
  if (diff < 90000) return t('family.hub.now');
  const min = Math.floor(diff / 60000);
  if (min < 60) return t('family.hub.agoMin', { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t('family.hub.agoHour', { n: h });
  const days = Math.floor(h / 24);
  return t('family.hub.agoDay', { n: days });
}

export function memberLabel(m) {
  const email = String(m?.email || '');
  return String(m?.name || (email.includes('@') ? email.split('@')[0] : email) || '');
}
export function firstName(m) {
  const n = memberLabel(m).trim();
  return n.split(/\s+/)[0] || n;
}
