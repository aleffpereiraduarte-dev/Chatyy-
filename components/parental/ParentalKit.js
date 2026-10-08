// [2026-10-08 parental-pages2] Primitivos visuais compartilhados pelo wizard
// "Adicionar filho" (app/parental.js) e pelo monitor do filho
// (app/parental-monitor.js). Mesma linguagem do SettingsKit: preto & branco,
// superfícies agrupadas, ícones SVG (nunca emoji), vermelho só p/ alerta.
// Só RN + react-native-svg → OTA-safe e funciona no web.
//
//   <SegmentedControl options={[{ value, label, badge? }]} value onChange />
//   <FieldLabel>Nome</FieldLabel> + <FilledField Icon={IconUser}>…</FilledField>
//   <BirthDateSheet visible value="DD/MM/AAAA" onConfirm onClose t />
//   <MonoTile Icon label onPress active? badge? />
//   <CompactEmpty Icon title subtitle? />
//   <ActionSheet visible title subtitle items=[{key, Icon, label, destructive?}] onSelect onClose cancelLabel />
//   <StepProgress step total />
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Modal, Pressable, ScrollView, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';
import PressableScale from '../PressableScale';
import PressableRow from '../PressableRow';
import { useGroupedColors, SettingsRow } from '../settings/SettingsKit';
import { selection as hapticSelection } from '../../services/haptics';

// Ink (botão primário) — preto no claro, branco no escuro (colors.primary/onPrimary).
export function useInk() {
  const { colors = {}, isDark } = useTheme() || {};
  return {
    ink: colors.primary || (isDark ? '#F5F5F7' : '#111111'),
    onInk: colors.onPrimary || (isDark ? '#000000' : '#FFFFFF'),
  };
}

// ─── Segmented control (UISegmentedControl / Material segmented button) ───
export function SegmentedControl({ options = [], value, onChange, style, testID, size = 'md' }) {
  const g = useGroupedColors();
  const selBg = g.isDark ? '#636366' : '#FFFFFF';
  const h = size === 'lg' ? 40 : 34;
  return (
    <View
      style={[seg.wrap, { backgroundColor: g.isDark ? 'rgba(118,118,128,0.24)' : 'rgba(118,118,128,0.12)', minHeight: h }, style]}
      accessibilityRole="tablist"
      testID={testID}
    >
      {options.map((o, i) => {
        const sel = o.value === value;
        const prevSel = i > 0 && options[i - 1].value === value;
        return (
          <React.Fragment key={String(o.value)}>
            {i > 0 && (
              <View style={[seg.divider, { backgroundColor: (sel || prevSel) ? 'transparent' : (g.isDark ? 'rgba(255,255,255,0.14)' : 'rgba(60,60,67,0.18)') }]} />
            )}
            <Pressable
              onPress={() => {
                if (sel) return;
                if (Platform.OS !== 'web') { try { hapticSelection(); } catch {} }
                onChange?.(o.value);
              }}
              accessibilityRole="tab"
              accessibilityState={{ selected: sel }}
              accessibilityLabel={o.a11y || o.label}
              style={[seg.item, { minHeight: h - 4 }, sel && [seg.itemSel, { backgroundColor: selBg }]]}
            >
              <Text
                style={[seg.text, { color: g.text, fontWeight: sel ? '600' : '500' }]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.8}
                maxFontSizeMultiplier={1.3}
              >
                {o.label}
              </Text>
              {o.badge > 0 && (
                <View style={seg.badge} pointerEvents="none">
                  <Text style={seg.badgeText} allowFontScaling={false}>{o.badge > 99 ? '99+' : o.badge}</Text>
                </View>
              )}
            </Pressable>
          </React.Fragment>
        );
      })}
    </View>
  );
}

// ─── Slim step progress (4 segmentos) ───
export function StepProgress({ step = 0, total = 4, style }) {
  const g = useGroupedColors();
  const { ink } = useInk();
  return (
    <View style={[{ flexDirection: 'row', gap: 4 }, style]} accessibilityRole="progressbar" accessibilityValue={{ min: 1, max: total, now: step + 1 }}>
      {Array.from({ length: total }).map((_, i) => (
        <View key={i} style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: i <= step ? ink : g.fill }} />
      ))}
    </View>
  );
}

// ─── Campo: label acima + caixa preenchida ───
export function FieldLabel({ children, style }) {
  const g = useGroupedColors();
  return <Text style={[fld.label, { color: g.secondary }, style]} maxFontSizeMultiplier={1.4}>{children}</Text>;
}

export function FieldHelp({ children, error, style }) {
  const g = useGroupedColors();
  if (!children) return null;
  return <Text style={[fld.help, { color: error ? g.destructive : g.secondary }, style]} maxFontSizeMultiplier={1.4}>{children}</Text>;
}

// Caixa do campo. Com onPress vira um "botão-campo" (ex.: data).
export function FilledField({ Icon, children, onPress, error, focused, style, accessibilityLabel, right }) {
  const g = useGroupedColors();
  const { ink } = useInk();
  const borderColor = error ? g.destructive : (focused ? ink : 'transparent');
  const body = (
    <View style={[fld.box, { backgroundColor: g.cardBg, borderColor }, style]}>
      {!!Icon && <View style={fld.icon}><Icon size={20} color={g.secondary} /></View>}
      <View style={{ flex: 1, minWidth: 0 }}>{children}</View>
      {right || null}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel} style={Platform.OS === 'web' ? { cursor: 'pointer' } : undefined}>
      {({ pressed }) => <View style={{ opacity: pressed && Platform.OS === 'ios' ? 0.7 : 1 }}>{body}</View>}
    </Pressable>
  );
}

// ─── Tile de ação monocromático (Localizar / Mensagens / Pausar / Mais) ───
export function MonoTile({ Icon, label, onPress, active = false, badge = 0, a11y, disabled, busy }) {
  const g = useGroupedColors();
  const { ink, onInk } = useInk();
  const bg = active ? ink : g.cardBg;
  const fg = active ? onInk : g.text;
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <PressableScale
        onPress={onPress}
        disabled={disabled}
        haptic={false}
        scaleTo={0.95}
        style={[tile.tile, { backgroundColor: bg, opacity: disabled ? 0.5 : 1 }]}
        accessibilityRole="button"
        accessibilityLabel={a11y || label}
        accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      >
        <View style={{ opacity: busy ? 0.4 : 1 }}>
          <Icon size={21} color={fg} />
          {badge > 0 && (
            <View style={[tile.badge, { borderColor: bg }]}>
              <Text style={tile.badgeText} allowFontScaling={false}>{badge > 99 ? '99+' : badge}</Text>
            </View>
          )}
        </View>
        <Text style={[tile.text, { color: fg }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} maxFontSizeMultiplier={1.2}>{label}</Text>
      </PressableScale>
    </View>
  );
}

// ─── Empty state compacto (dentro de um card) ───
export function CompactEmpty({ Icon, title, subtitle, style }) {
  const g = useGroupedColors();
  return (
    <View style={[{ backgroundColor: g.cardBg, borderRadius: 12, paddingVertical: 22, paddingHorizontal: 20, alignItems: 'center' }, style]}>
      {!!Icon && (
        <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: g.fill, alignItems: 'center', justifyContent: 'center', marginBottom: 10 }}>
          <Icon size={20} color={g.secondary} />
        </View>
      )}
      <Text style={{ fontSize: 15, fontWeight: '600', color: g.text, textAlign: 'center' }} maxFontSizeMultiplier={1.4}>{title}</Text>
      {!!subtitle && <Text style={{ fontSize: 13, lineHeight: 18, color: g.secondary, textAlign: 'center', marginTop: 4, maxWidth: 300 }} maxFontSizeMultiplier={1.4}>{subtitle}</Text>}
    </View>
  );
}

// ─── Action sheet (lista de ações + Cancelar) ───
export function ActionSheet({ visible, title, subtitle, items = [], onSelect, onClose, cancelLabel = 'Cancelar' }) {
  const g = useGroupedColors();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.38)' }]} onPress={onClose} accessibilityLabel={cancelLabel} />
      <View style={[sh.wrap, { paddingBottom: Math.max(insets.bottom, 12) }]} pointerEvents="box-none">
        <View style={[sh.sheet, { backgroundColor: g.cardBg }]}>
          {(!!title || !!subtitle) && (
            <View style={[sh.head, { borderBottomColor: g.separator }]}>
              {!!title && <Text style={[sh.title, { color: g.text }]} numberOfLines={1}>{title}</Text>}
              {!!subtitle && <Text style={[sh.sub, { color: g.secondary }]} numberOfLines={1}>{subtitle}</Text>}
            </View>
          )}
          {items.map((it, i) => (
            <React.Fragment key={it.key}>
              {i > 0 && <View style={{ height: StyleSheet.hairlineWidth, marginLeft: 52, backgroundColor: g.separator }} />}
              <SettingsRow
                title={it.label}
                subtitle={it.sub}
                icon={it.Icon}
                iconTile={false}
                destructive={!!it.destructive}
                chevron={false}
                onPress={() => onSelect?.(it.key)}
              />
            </React.Fragment>
          ))}
        </View>
        <PressableRow onPress={onClose} style={[sh.cancel, { backgroundColor: g.cardBg }]} accessibilityRole="button" accessibilityLabel={cancelLabel}>
          <Text style={[sh.cancelText, { color: g.text }]}>{cancelLabel}</Text>
        </PressableRow>
      </View>
    </Modal>
  );
}

// ─── Seletor de data de nascimento (rodas dia/mês/ano, estilo UIDatePicker) ───
// Puro RN (sem @react-native-community/datetimepicker, que não está no
// binário) → OTA-safe, idêntico em iOS/Android/web. Valor = "DD/MM/AAAA".
const WH = 40;          // altura de cada linha
const WV = 5;           // linhas visíveis (ímpar → centro = seleção)
const pad2 = (n) => (n < 10 ? '0' + n : '' + n);

function Wheel({ data, index, onIndex, width, flex, testID }) {
  const g = useGroupedColors();
  const ref = useRef(null);
  const lastIdx = useRef(index);
  useEffect(() => {
    const id = setTimeout(() => { try { ref.current?.scrollTo({ y: index * WH, animated: false }); } catch {} }, 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Se o índice for corrigido de fora (ex.: dia 31 → 30), re-sincroniza a roda.
  useEffect(() => {
    if (lastIdx.current !== index) {
      lastIdx.current = index;
      try { ref.current?.scrollTo({ y: index * WH, animated: true }); } catch {}
    }
  }, [index]);
  const padV = ((WV - 1) / 2) * WH;
  const settle = (y) => {
    let i = Math.round(y / WH);
    if (i < 0) i = 0; if (i > data.length - 1) i = data.length - 1;
    if (i !== lastIdx.current) {
      lastIdx.current = i;
      if (Platform.OS !== 'web') { try { hapticSelection(); } catch {} }
      onIndex(i);
    }
  };
  // Web: não há momentum-end confiável → debounce no onScroll.
  const webTimer = useRef(null);
  useEffect(() => () => { if (webTimer.current) clearTimeout(webTimer.current); }, []);
  return (
    <View style={{ width, flex, height: WH * WV }} testID={testID}>
      <ScrollView
        ref={ref}
        showsVerticalScrollIndicator={false}
        snapToInterval={WH}
        decelerationRate="fast"
        contentContainerStyle={{ paddingVertical: padV }}
        onMomentumScrollEnd={(e) => settle(e.nativeEvent.contentOffset.y)}
        onScrollEndDrag={(e) => { if (Platform.OS === 'android') settle(e.nativeEvent.contentOffset.y); }}
        onScroll={Platform.OS === 'web' ? (e) => {
          const y = e.nativeEvent.contentOffset.y;
          if (webTimer.current) clearTimeout(webTimer.current);
          webTimer.current = setTimeout(() => settle(y), 120);
        } : undefined}
        scrollEventThrottle={Platform.OS === 'web' ? 32 : undefined}
        nestedScrollEnabled
      >
        {data.map((label, i) => {
          const sel = i === index;
          return (
            <Pressable
              key={i}
              onPress={() => { try { ref.current?.scrollTo({ y: i * WH, animated: true }); } catch {} lastIdx.current = i; onIndex(i); }}
              style={{ height: WH, alignItems: 'center', justifyContent: 'center' }}
              accessibilityRole="button"
              accessibilityState={{ selected: sel }}
            >
              <Text numberOfLines={1} style={{ fontSize: sel ? 21 : 18, fontWeight: sel ? '600' : '400', color: sel ? g.text : g.secondary, opacity: sel ? 1 : 0.6, fontVariant: ['tabular-nums'] }}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

export function parseBirthDate(v) {
  const m = String(v || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const d = parseInt(m[1], 10), mo = parseInt(m[2], 10), y = parseInt(m[3], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(y, mo, 0).getDate()) return null;
  return { d, m: mo, y };
}

export function BirthDateSheet({ visible, value, onConfirm, onClose, title, doneLabel = 'OK', cancelLabel = 'Cancelar', monthNames, defaultAge = 9, minYearsBack = 3, maxYearsBack = 18 }) {
  const g = useGroupedColors();
  const { ink } = useInk();
  const insets = useSafeAreaInsets();
  const nowY = new Date().getFullYear();
  const years = useMemo(() => {
    const out = [];
    for (let y = nowY - maxYearsBack; y <= nowY - minYearsBack; y++) out.push(y);
    return out;
  }, [nowY, maxYearsBack, minYearsBack]);
  const months = monthNames && monthNames.length === 12 ? monthNames : ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
  const init = parseBirthDate(value) || { d: 1, m: 1, y: nowY - defaultAge };
  const [d, setD] = useState(init.d);
  const [m, setM] = useState(init.m);
  const [y, setY] = useState(Math.min(Math.max(init.y, years[0]), years[years.length - 1]));
  // Reabre com o valor atual.
  useEffect(() => {
    if (!visible) return;
    const p = parseBirthDate(value) || { d: 1, m: 1, y: nowY - defaultAge };
    setD(p.d); setM(p.m); setY(Math.min(Math.max(p.y, years[0]), years[years.length - 1]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  const dim = new Date(y, m, 0).getDate();
  useEffect(() => { if (d > dim) setD(dim); }, [dim, d]);
  const days = useMemo(() => Array.from({ length: dim }, (_, i) => pad2(i + 1)), [dim]);
  const yi = Math.max(0, years.indexOf(y));
  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.38)' }]} onPress={onClose} accessibilityLabel={cancelLabel} />
      <View style={[sh.wrap, { paddingBottom: Math.max(insets.bottom, 12) }]} pointerEvents="box-none">
        <View style={[sh.sheet, { backgroundColor: g.cardBg }]}>
          <View style={[dp.bar, { borderBottomColor: g.separator }]}>
            <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" style={dp.barBtn}>
              <Text style={[dp.barText, { color: g.secondary }]}>{cancelLabel}</Text>
            </Pressable>
            <Text style={[dp.barTitle, { color: g.text }]} numberOfLines={1}>{title}</Text>
            <Pressable
              onPress={() => onConfirm?.(`${pad2(Math.min(d, dim))}/${pad2(m)}/${y}`)}
              hitSlop={10}
              accessibilityRole="button"
              style={[dp.barBtn, { alignItems: 'flex-end' }]}
              testID="birthdate-done"
            >
              <Text style={[dp.barText, { color: ink, fontWeight: '700' }]}>{doneLabel}</Text>
            </Pressable>
          </View>
          {visible && (
            <View style={dp.wheels}>
              <View pointerEvents="none" style={[dp.band, { top: ((WV - 1) / 2) * WH, backgroundColor: g.fill }]} />
              <Wheel data={days} index={Math.min(d, dim) - 1} onIndex={(i) => setD(i + 1)} width={64} testID="wheel-day" />
              <Wheel data={months} index={m - 1} onIndex={(i) => setM(i + 1)} flex={1} testID="wheel-month" />
              <Wheel data={years.map(String)} index={yi} onIndex={(i) => setY(years[i])} width={84} testID="wheel-year" />
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const seg = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', borderRadius: 9, padding: 2 },
  item: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 7, paddingHorizontal: 6, ...Platform.select({ web: { cursor: 'pointer', outlineWidth: 0 }, default: {} }) },
  itemSel: {
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } },
      android: { elevation: 2 },
      web: { boxShadow: '0 2px 4px rgba(0,0,0,0.12)' },
    }),
  },
  divider: { width: StyleSheet.hairlineWidth, height: 16 },
  text: { fontSize: 13, letterSpacing: -0.1 },
  // Badge flutua no canto (não rouba largura do rótulo → "Contatos" não trunca).
  badge: { position: 'absolute', top: 1, right: 3, backgroundColor: '#ef4444', minWidth: 15, height: 15, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  badgeText: { color: '#fff', fontSize: 9, fontWeight: '700' },
});

const fld = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '600', marginBottom: 7, marginLeft: 4 },
  help: { fontSize: 13, lineHeight: 18, marginTop: 7, marginLeft: 4 },
  box: { flexDirection: 'row', alignItems: 'center', minHeight: 50, borderRadius: 12, paddingHorizontal: 14, borderWidth: 1.5 },
  icon: { marginRight: 10, width: 22, alignItems: 'center' },
});

const tile = StyleSheet.create({
  tile: { minHeight: 64, borderRadius: 12, alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 4, paddingVertical: 10 },
  text: { fontSize: 12, fontWeight: '600', textAlign: 'center' },
  badge: { position: 'absolute', top: -6, right: -10, minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 3, backgroundColor: '#ef4444', alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
  badgeText: { color: '#fff', fontSize: 9, fontWeight: '700' },
});

const sh = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 10, maxWidth: 560, width: '100%', alignSelf: 'center' },
  sheet: { borderRadius: 14, overflow: 'hidden' },
  head: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, alignItems: 'center' },
  title: { fontSize: 14, fontWeight: '600', textAlign: 'center' },
  sub: { fontSize: 13, marginTop: 3, textAlign: 'center' },
  cancel: { marginTop: 8, borderRadius: 14, minHeight: 54, alignItems: 'center', justifyContent: 'center', ...Platform.select({ web: { cursor: 'pointer' }, default: {} }) },
  cancelText: { fontSize: 17, fontWeight: '600' },
});

const dp = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', minHeight: 50, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  barBtn: { minWidth: 72, paddingVertical: 8, ...Platform.select({ web: { cursor: 'pointer' }, default: {} }) },
  barText: { fontSize: 16 },
  barTitle: { flex: 1, textAlign: 'center', fontSize: 15, fontWeight: '600' },
  wheels: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 6 },
  band: { position: 'absolute', left: 12, right: 12, height: WH, borderRadius: 9, marginTop: 10 },
});

