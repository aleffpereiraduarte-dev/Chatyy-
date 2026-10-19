// [2026-10-19 parental-premium] Primitivas do "Painel familiar" no mesmo
// sistema P&B do hub Família (components/family/familyUi): anel de tempo de
// tela, pílula de status, barra segmentada de ações rápidas, chamada de
// verificação pendente, cartão "Adicionar filho" tracejado com ilustração e
// o cartão-resumo do topo. Ação primária = colors.primary (destaque do tema).
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Svg, { Circle, Path, Rect, G } from 'react-native-svg';
import { useFamilyColors } from '../family/familyUi';
import PressableScale from '../PressableScale';
import AvatarCircle from '../AvatarCircle';
import * as haptics from '../../services/haptics';
import { IconCheck, IconChevronRight, IconLock, IconMoon, IconClock, IconPlay } from '../Icons';

export const AMBER = '#F59E0B';

// Carimbos do PG (timestamptz → "2026-10-19 02:00:00.123456-04"), ISO com
// offset (date('c')) ou sem zona (trata como UTC). Hermes não aceita o
// formato com espaço/offset curto → normaliza antes do Date.parse.
export function parseTs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
  let s = String(v).trim();
  if (/^\d{9,13}$/.test(s)) { const n = Number(s); return new Date(n < 1e12 ? n * 1000 : n); }
  s = s.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  if (/[+-]\d{2}$/.test(s)) s += ':00';
  else if (/[+-]\d{4}$/.test(s)) s = s.slice(0, -2) + ':' + s.slice(-2);
  else if (/T\d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:\d{2}$/.test(s)) s += 'Z';
  const d = Date.parse(s);
  return Number.isNaN(d) ? null : new Date(d);
}

export function fmtMinutes(min, t) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  if (m < 60) return t('parentalDash.fmtM', { m });
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? t('parentalDash.fmtHM', { h, m: String(r).padStart(2, '0') }) : t('parentalDash.fmtH', { h });
}

export function agoLabel(v, t, now = Date.now()) {
  const d = parseTs(v);
  if (!d) return null;
  const min = Math.max(0, Math.floor((now - d.getTime()) / 60000));
  if (min < 2) return t('parentalDash.agoNow');
  if (min < 60) return t('parentalDash.agoMin', { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t('parentalDash.agoHour', { n: h });
  return t('parentalDash.agoDay', { n: Math.floor(h / 24) });
}

// ── Anel de tempo de tela ──
export function ScreenTimeRing({ size = 64, stroke = 6, used = 0, limit = 0, children }) {
  const c = useFamilyColors();
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const hasLimit = limit > 0;
  const pct = hasLimit ? Math.min(1, used / limit) : 0;
  const over = hasLimit && used >= limit;
  const track = c.isDark ? 'rgba(255,255,255,0.12)' : 'rgba(17,17,17,0.08)';
  const fg = over ? c.danger : c.text;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
        {pct > 0 && (
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={fg}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${circ} ${circ}`}
            strokeDashoffset={circ * (1 - pct)}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </Svg>
      {children}
    </View>
  );
}

// ── Pílula de status ──
// kind: active | paused | bedtime | pending | suspended | revoked | graduated
export function StatusPill({ kind, label }) {
  const c = useFamilyColors();
  const inverted = kind === 'paused';
  const bg = inverted ? c.text : c.chipBg;
  const fg = inverted ? c.onInk : c.text;
  let lead = null;
  if (kind === 'paused') lead = <IconLock size={11} color={fg} />;
  else if (kind === 'bedtime') lead = <IconMoon size={12} color={fg} />;
  else {
    const dot = kind === 'active' ? c.online : kind === 'pending' ? AMBER : kind === 'suspended' ? c.danger : c.secondary;
    lead = <View style={[k.pillDot, { backgroundColor: dot }]} />;
  }
  return (
    <View style={[k.pill, { backgroundColor: bg }]} accessibilityRole="text">
      {lead}
      <Text style={[k.pillText, { color: fg }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>{label}</Text>
    </View>
  );
}

// Chip de metadado (modo noturno, local, mensagens) — opcionalmente tocável.
export function MetaChip({ Icon, label, onPress, a11y }) {
  const c = useFamilyColors();
  const body = (
    <>
      {Icon ? <Icon size={13} color={c.secondary} /> : null}
      <Text style={[k.chipText, { color: c.text }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>{label}</Text>
      {onPress ? <IconChevronRight size={12} color={c.tertiary} /> : null}
    </>
  );
  if (!onPress) return <View style={[k.chip, { backgroundColor: c.chipBg }]}>{body}</View>;
  return (
    <Pressable
      onPress={() => { haptics.tap('light'); onPress(); }}
      style={({ pressed }) => [k.chip, { backgroundColor: pressed ? c.highlightBg : c.chipBg }]}
      accessibilityRole="button"
      accessibilityLabel={a11y || label}
      hitSlop={4}
    >
      {body}
    </Pressable>
  );
}

// ── Barra segmentada de ações rápidas ──
// items: [{ key, Icon, label, onPress, active, badge, a11y, disabled }]
export function ActionSegments({ items }) {
  const c = useFamilyColors();
  return (
    <View style={[k.seg, { backgroundColor: c.chipBg }]}>
      {items.map((it, i) => {
        const prev = items[i - 1];
        const showSep = i > 0 && !it.active && !(prev && prev.active);
        const fg = it.active ? c.onInk : c.text;
        return (
          <React.Fragment key={it.key}>
            {i > 0 && <View style={[k.segSep, { backgroundColor: showSep ? c.separator : 'transparent' }]} />}
            <Pressable
              onPress={() => { if (it.disabled) return; haptics.selection(); it.onPress?.(); }}
              disabled={!!it.disabled}
              style={({ pressed }) => [
                k.segItem,
                it.active && { backgroundColor: c.text },
                pressed && !it.active && { backgroundColor: c.highlightBg },
                pressed && it.active && { opacity: 0.85 },
                it.disabled && { opacity: 0.4 },
              ]}
              accessibilityRole="button"
              accessibilityLabel={it.a11y || it.label}
              accessibilityState={it.key === 'lock' ? { checked: !!it.active, disabled: !!it.disabled } : { disabled: !!it.disabled }}
            >
              <View>
                <it.Icon size={19} color={fg} />
                {it.badge > 0 && (
                  <View style={[k.badge, { borderColor: it.active ? c.text : c.cardBg }]}>
                    <Text style={k.badgeText} allowFontScaling={false}>{it.badge > 99 ? '99+' : it.badge}</Text>
                  </View>
                )}
              </View>
              <Text style={[k.segText, { color: fg }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} maxFontSizeMultiplier={1.2}>{it.label}</Text>
            </Pressable>
          </React.Fragment>
        );
      })}
    </View>
  );
}

// ── Faixa "Pausado" dentro do cartão ──
export function PausedBanner({ title, sub, cta, onResume }) {
  const c = useFamilyColors();
  return (
    <View style={[k.paused, { backgroundColor: c.text }]}>
      <View style={[k.pausedIcon, { backgroundColor: c.isDark ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.14)' }]}>
        <IconLock size={16} color={c.onInk} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[k.pausedTitle, { color: c.onInk }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>{title}</Text>
        {!!sub && <Text style={[k.pausedSub, { color: c.onInk }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>{sub}</Text>}
      </View>
      <PressableScale
        onPress={onResume}
        haptic={false}
        scaleTo={0.94}
        style={[k.resumeBtn, { backgroundColor: c.onInk }]}
        accessibilityRole="button"
        accessibilityLabel={cta}
      >
        <IconPlay size={13} color={c.text} />
        <Text style={[k.resumeText, { color: c.text }]} numberOfLines={1} maxFontSizeMultiplier={1.2}>{cta}</Text>
      </PressableScale>
    </View>
  );
}

// ── Verificação pendente: passos + CTA ──
// steps: [{ label, state: 'done'|'current'|'todo' }]
export function VerifyCallout({ title, sub, steps, cta, onPress }) {
  const c = useFamilyColors();
  return (
    <View style={[k.callout, { backgroundColor: c.chipBg }]}>
      <Text style={[k.calloutTitle, { color: c.text }]} maxFontSizeMultiplier={1.3}>{title}</Text>
      {!!sub && <Text style={[k.calloutSub, { color: c.secondary }]} maxFontSizeMultiplier={1.3}>{sub}</Text>}
      <View style={{ marginTop: 12, gap: 0 }}>
        {steps.map((s, i) => {
          const done = s.state === 'done';
          const cur = s.state === 'current';
          const last = i === steps.length - 1;
          return (
            <View key={i} style={k.stepRow}>
              <View style={{ alignItems: 'center', width: 22 }}>
                <View style={[
                  k.stepDot,
                  done && { backgroundColor: c.text, borderColor: c.text },
                  cur && { borderColor: c.text, borderWidth: 2 },
                  !done && !cur && { borderColor: c.tertiary },
                ]}>
                  {done ? <IconCheck size={12} color={c.onInk} /> : (
                    <Text style={[k.stepNum, { color: cur ? c.text : c.secondary }]} allowFontScaling={false}>{i + 1}</Text>
                  )}
                </View>
                {!last && <View style={[k.stepLine, { backgroundColor: done ? c.text : c.separator }]} />}
              </View>
              <Text style={[k.stepText, { color: done ? c.secondary : c.text, fontWeight: cur ? '600' : '400' }]} maxFontSizeMultiplier={1.3}>{s.label}</Text>
            </View>
          );
        })}
      </View>
      <PressableScale
        onPress={onPress}
        haptic="medium"
        scaleTo={0.97}
        style={[k.primary, { backgroundColor: c.pill, marginTop: 14 }]}
        accessibilityRole="button"
        accessibilityLabel={cta}
      >
        <Text style={[k.primaryText, { color: c.onPill }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>{cta}</Text>
      </PressableScale>
    </View>
  );
}

// ── "Adicionar filho": cartão tracejado + ilustração ──
function FamilyIllustration({ size = 76 }) {
  const c = useFamilyColors();
  const soft = c.isDark ? 'rgba(255,255,255,0.10)' : 'rgba(17,17,17,0.06)';
  return (
    <Svg width={size} height={size} viewBox="0 0 80 80" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Circle cx="40" cy="40" r="38" fill={soft} />
      {/* adulto */}
      <Circle cx="31" cy="29" r="8" fill={c.text} />
      <Path d="M17 58c0-9.4 6.3-16 14-16s14 6.6 14 16z" fill={c.text} />
      {/* criança */}
      <Circle cx="51" cy="38" r="6" fill={c.secondary} />
      <Path d="M41 60c0-7.4 4.5-12.4 10-12.4S61 52.6 61 60z" fill={c.secondary} />
      {/* selo + */}
      <G>
        <Circle cx="60" cy="22" r="10" fill={c.pill} />
        <Rect x="59" y="16.5" width="2" height="11" rx="1" fill={c.onPill} />
        <Rect x="54.5" y="21" width="11" height="2" rx="1" fill={c.onPill} />
      </G>
    </Svg>
  );
}

export function AddChildCard({ title, sub, onPress }) {
  const c = useFamilyColors();
  return (
    <PressableScale
      onPress={onPress}
      haptic="medium"
      scaleTo={0.98}
      style={[k.addCard, { borderColor: c.tertiary }]}
      accessibilityRole="button"
      accessibilityLabel={title}
    >
      <FamilyIllustration />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[k.addTitle, { color: c.text }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>{title}</Text>
        <Text style={[k.addSub, { color: c.secondary }]} numberOfLines={2} maxFontSizeMultiplier={1.3}>{sub}</Text>
      </View>
      <IconChevronRight size={18} color={c.tertiary} />
    </PressableScale>
  );
}

// ── Cartão-resumo do topo ──
// stats: [{ key, value, label, onPress?, tone? }]; requests: preview list
export function SummaryCard({ eyebrow, big, bigSub, footnote, stats, avatars, requestsTitle, requests, requestsCta, onOpenRequests }) {
  const c = useFamilyColors();
  return (
    <View style={[k.summary, { backgroundColor: c.cardBg }]}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <IconClock size={13} color={c.secondary} />
            <Text style={[k.eyebrow, { color: c.secondary }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>{eyebrow}</Text>
          </View>
          <Text style={[k.big, { color: c.text }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} maxFontSizeMultiplier={1.2}>{big}</Text>
          {!!bigSub && <Text style={[k.bigSub, { color: c.secondary }]} numberOfLines={2} maxFontSizeMultiplier={1.3}>{bigSub}</Text>}
        </View>
        {Array.isArray(avatars) && avatars.length > 0 && (
          <View style={{ flexDirection: 'row', paddingTop: 2 }}>
            {avatars.slice(0, 3).map((a, i) => (
              <View key={a.email || i} style={{ marginLeft: i ? -10 : 0, borderRadius: 18, borderWidth: 2, borderColor: c.cardBg }}>
                <AvatarCircle email={a.email} name={a.name} size={32} />
              </View>
            ))}
          </View>
        )}
      </View>

      <View style={[k.statsRow, { borderTopColor: c.separator }]}>
        {stats.map((s, i) => {
          const inner = (
            <>
              <Text style={[k.statValue, { color: s.tone || c.text }]} numberOfLines={1} maxFontSizeMultiplier={1.2}>{s.value}</Text>
              <Text style={[k.statLabel, { color: c.secondary }]} numberOfLines={1} maxFontSizeMultiplier={1.2}>{s.label}</Text>
            </>
          );
          return (
            <React.Fragment key={s.key}>
              {i > 0 && <View style={[k.statSep, { backgroundColor: c.separator }]} />}
              {s.onPress ? (
                <Pressable
                  onPress={() => { haptics.tap('light'); s.onPress(); }}
                  style={({ pressed }) => [k.stat, pressed && { opacity: 0.55 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`${s.value} ${s.label}`}
                >{inner}</Pressable>
              ) : <View style={k.stat} accessible accessibilityLabel={`${s.value} ${s.label}`}>{inner}</View>}
            </React.Fragment>
          );
        })}
      </View>

      {Array.isArray(requests) && requests.length > 0 && (
        <Pressable
          onPress={() => { haptics.tap('light'); onOpenRequests?.(); }}
          style={({ pressed }) => [k.inbox, { backgroundColor: pressed ? c.highlightBg : c.chipBg }]}
          accessibilityRole="button"
          accessibilityLabel={requestsTitle}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
              <View style={[k.inboxDot, { backgroundColor: c.danger }]} />
              <Text style={[k.inboxTitle, { color: c.text }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>{requestsTitle}</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
              <Text style={[k.inboxCta, { color: c.secondary }]} maxFontSizeMultiplier={1.2}>{requestsCta}</Text>
              <IconChevronRight size={14} color={c.secondary} />
            </View>
          </View>
          {requests.slice(0, 2).map((r) => (
            <View key={r.key} style={k.inboxRow}>
              <AvatarCircle email={r.email} name={r.name} size={26} />
              <Text style={[k.inboxText, { color: c.text }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                <Text style={{ fontWeight: '600' }}>{r.name}</Text>
                <Text style={{ color: c.secondary }}>{`  ${r.reason}`}</Text>
              </Text>
              {!!r.ago && <Text style={[k.inboxAgo, { color: c.secondary }]} numberOfLines={1}>{r.ago}</Text>}
            </View>
          ))}
        </Pressable>
      )}

      {!!footnote && <Text style={[k.footnote, { color: c.secondary }]} maxFontSizeMultiplier={1.3}>{footnote}</Text>}
    </View>
  );
}

const k = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 5, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999, marginTop: 6, maxWidth: '100%' },
  pillDot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { fontSize: 12, fontWeight: '600', letterSpacing: 0.1, flexShrink: 1 },

  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, maxWidth: '100%' },
  chipText: { fontSize: 12.5, fontWeight: '500', flexShrink: 1 },

  seg: { flexDirection: 'row', alignItems: 'stretch', borderRadius: 14, padding: 3, minHeight: 58 },
  segSep: { width: StyleSheet.hairlineWidth * 2, marginVertical: 12 },
  segItem: { flex: 1, minWidth: 0, borderRadius: 11, alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 8, paddingHorizontal: 2 },
  segText: { fontSize: 11.5, fontWeight: '600', textAlign: 'center' },
  badge: { position: 'absolute', top: -6, right: -12, minWidth: 17, height: 17, borderRadius: 9, backgroundColor: '#ef4444', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, borderWidth: 2 },
  badgeText: { color: '#fff', fontSize: 9, fontWeight: '700' },

  paused: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 14, paddingVertical: 10, paddingLeft: 10, paddingRight: 8 },
  pausedIcon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  pausedTitle: { fontSize: 14, fontWeight: '700' },
  pausedSub: { fontSize: 12, opacity: 0.72, marginTop: 1 },
  resumeBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 8 },
  resumeText: { fontSize: 13, fontWeight: '700' },

  callout: { borderRadius: 16, padding: 14 },
  calloutTitle: { fontSize: 15, fontWeight: '700', letterSpacing: -0.2 },
  calloutSub: { fontSize: 13, lineHeight: 18, marginTop: 3 },
  stepRow: { flexDirection: 'row', gap: 10 },
  stepDot: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  stepNum: { fontSize: 11, fontWeight: '700' },
  stepLine: { width: 1.5, flex: 1, minHeight: 10, marginVertical: 2 },
  stepText: { flex: 1, fontSize: 14, lineHeight: 19, paddingTop: 1.5, paddingBottom: 12 },
  primary: { borderRadius: 999, minHeight: 46, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, flexDirection: 'row', gap: 8 },
  primaryText: { fontSize: 15, fontWeight: '600' },

  addCard: { flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 20, borderWidth: 1.3, borderStyle: 'dashed', paddingVertical: 14, paddingLeft: 12, paddingRight: 16 },
  addTitle: { fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
  addSub: { fontSize: 13, lineHeight: 18, marginTop: 2 },

  summary: { borderRadius: 22, padding: 16, marginBottom: 6 },
  eyebrow: { fontSize: 12.5, fontWeight: '600', letterSpacing: 0.2, textTransform: 'uppercase', flexShrink: 1 },
  big: { fontSize: 34, fontWeight: '700', letterSpacing: -0.8, marginTop: 4, fontVariant: ['tabular-nums'] },
  bigSub: { fontSize: 13, marginTop: 1 },
  statsRow: { flexDirection: 'row', alignItems: 'center', marginTop: 14, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  stat: { flex: 1, alignItems: 'center', paddingVertical: 2 },
  statSep: { width: StyleSheet.hairlineWidth, height: 28 },
  statValue: { fontSize: 19, fontWeight: '700', fontVariant: ['tabular-nums'] },
  statLabel: { fontSize: 11.5, marginTop: 1 },
  inbox: { borderRadius: 14, padding: 12, marginTop: 14 },
  inboxDot: { width: 8, height: 8, borderRadius: 4 },
  inboxTitle: { fontSize: 14, fontWeight: '700', flexShrink: 1 },
  inboxCta: { fontSize: 13, fontWeight: '600' },
  inboxRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 3 },
  inboxText: { flex: 1, fontSize: 13.5 },
  inboxAgo: { fontSize: 12 },
  footnote: { fontSize: 11.5, marginTop: 10, lineHeight: 15 },
});
