// [2026-10-08 settings-redesign] Grouped inset list primitives (iOS Settings /
// WhatsApp Settings). One visual system for every Settings sub-page:
//
//   <SettingsGroup header="Notificações" footer="Texto de ajuda">
//     <SettingsSwitchRow title="Som" value={on} onValueChange={setOn} />
//     <SettingsPickerRow title="Desfazer envio" value={5} options={[...]} onChange={...} />
//     <SettingsRow title="Filtros" onPress={...} />            // chevron automático
//     <SettingsRow title="Excluir conta" destructive onPress={...} />
//   </SettingsGroup>
//
// - Header: small caps cinza FORA do card; footer cinza abaixo.
// - Card: superfície sólida, raio 12, sem borda; separadores hairline com
//   recuo (alinha com o texto, como UITableView inset-grouped).
// - Escolhas com >3 opções (ou rótulos longos) → SettingsPickerRow: mostra o
//   valor atual à direita e abre um sheet com lista + checkmark.
// - Só RN + react-native-svg (via Icons) → OTA-safe, funciona no web.
import React, { useState } from 'react';
import { View, Text, Modal, Pressable, ScrollView, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import PressableRow from '../PressableRow';
import NativeSwitch from '../NativeSwitch';
import { IconChevronRight, IconCheck, IconArrowLeft } from '../Icons';
import { USE_NATIVE_HEADER, nativeHeaderOptions } from '../nativeHeader';
import { USE_NATIVE_SHEETS, NativeSheet, nativeSheetBottomPad } from '../NativeSheet'; // [2026-10-09 native-sheets]

// Palette for grouped lists. Light = iOS systemGroupedBackground; dark keeps
// the app's true-black page [2026-10-08 dark-black] and lifts the cards one step so groups read as groups.
export function useGroupedColors() {
  const { colors = {}, isDark } = useTheme() || {};
  return {
    isDark: !!isDark,
    pageBg: isDark ? (colors.background || '#000000') : '#F2F2F7',
    cardBg: isDark ? '#1C1C1E' : '#FFFFFF',
    separator: isDark ? 'rgba(255,255,255,0.09)' : 'rgba(60,60,67,0.16)',
    header: isDark ? '#8E8E93' : '#6D6D72',
    text: colors.text || (isDark ? '#F5F5F7' : '#111111'),
    secondary: isDark ? '#8E8E93' : '#8A8A8E',
    tertiary: isDark ? '#636366' : '#C4C4C7',
    ink: colors.text || (isDark ? '#F5F5F7' : '#111111'),
    onInk: isDark ? '#000000' : '#FFFFFF',
    destructive: colors.error || '#dc2626',
    tileBg: isDark ? '#F5F5F7' : '#111111',
    tileFg: isDark ? '#0b0b0b' : '#FFFFFF',
    fill: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(118,118,128,0.12)',
  };
}

// Small rounded ink tile behind a row icon (black & white Settings look).
export function SettingsIconTile({ Icon, size = 30, muted = false }) {
  const g = useGroupedColors();
  if (!Icon) return null;
  return (
    <View style={{
      width: size, height: size, borderRadius: size * 0.27,
      backgroundColor: muted ? g.fill : g.tileBg,
      alignItems: 'center', justifyContent: 'center',
    }}>
      <Icon size={Math.round(size * 0.6)} color={muted ? g.text : g.tileFg} />
    </View>
  );
}

export function SettingsGroup({ header, footer, children, inset = 16, style, cardStyle, testID }) {
  const g = useGroupedColors();
  const items = React.Children.toArray(children).filter(Boolean);
  if (!items.length && !header) return null;
  return (
    <View style={[{ marginBottom: 26 }, style]} testID={testID}>
      {!!header && (
        <Text style={[st.header, { color: g.header }]} accessibilityRole="header" numberOfLines={1}>
          {String(header).toUpperCase()}
        </Text>
      )}
      {items.length > 0 && (
        <View style={[st.card, { backgroundColor: g.cardBg }, cardStyle]}>
          {items.map((child, i) => (
            <React.Fragment key={child.key ?? i}>
              {i > 0 && <View style={[st.sep, { marginLeft: inset, backgroundColor: g.separator }]} />}
              {child}
            </React.Fragment>
          ))}
        </View>
      )}
      {!!footer && <Text style={[st.footer, { color: g.header }]}>{footer}</Text>}
    </View>
  );
}

// Generic row. Right side priority: `right` node > `checked` > value + chevron.
// [2026-10-09 geo-qa] RTL (árabe/hebraico/persa/urdu no web: <html dir="rtl">):
// margem entre ícone/texto/seta do lado certo — o ícone colava no texto —
// e a seta ">" espelhada para "<".
function _docRTL() {
  try { return Platform.OS === 'web' && typeof document !== 'undefined' && document.documentElement && document.documentElement.dir === 'rtl'; } catch { return false; }
}

export function SettingsRow({
  title, subtitle, value, icon: Icon, iconTile = true, onPress, onLongPress, chevron,
  right, destructive, disabled, checked, titleStyle, numberOfLines = 1, subtitleLines = 2,
  accessibilityLabel, accessibilityRole, center, testID, children,
}) {
  const g = useGroupedColors();
  const showChevron = chevron ?? (!!onPress && !destructive && checked === undefined && !right);
  const titleColor = destructive ? g.destructive : g.text;
  // RN-web não propaga o dir="rtl" do <html> pro LocaleContext → marginStart/End
  // resolveriam como LTR; o flex do navegador já espelha a linha, então troca
  // left/right explicitamente quando o documento é RTL. Nativo: inalterado.
  const _rtl = _docRTL();
  const _gapEnd = (n) => (_rtl ? { marginLeft: n } : { marginRight: n });
  const _gapStart = (n) => (_rtl ? { marginRight: n } : { marginLeft: n });
  const body = (
    <View style={[st.row, disabled && { opacity: 0.45 }]}>
      {!!Icon && (iconTile
        ? <View style={{ ..._gapEnd(12) }}><SettingsIconTile Icon={Icon} /></View>
        : <View style={{ ..._gapEnd(12), width: 24, alignItems: 'center' }}><Icon size={20} color={destructive ? g.destructive : g.text} /></View>)}
      <View style={{ flex: 1, minWidth: 0, alignItems: center ? 'center' : 'flex-start' }}>
        <Text style={[st.title, { color: titleColor }, titleStyle]} numberOfLines={numberOfLines}>{title}</Text>
        {!!subtitle && <Text style={[st.subtitle, { color: g.secondary }]} numberOfLines={subtitleLines}>{subtitle}</Text>}
        {children}
      </View>
      {right ? <View style={_gapStart(10)}>{right}</View> : null}
      {!right && value !== undefined && value !== null && value !== '' && (
        <Text style={[st.value, { color: g.secondary }]} numberOfLines={1}>{String(value)}</Text>
      )}
      {!right && checked === true && <IconCheck size={20} color={g.ink} strokeWidth={2.4} style={_gapStart(10)} />}
      {!right && checked === false && <View style={{ width: 20, ..._gapStart(10) }} />}
      {showChevron && <IconChevronRight size={17} color={g.tertiary} style={{ ..._gapStart(6), ...(_rtl ? { transform: [{ scaleX: -1 }] } : null) }} />}
    </View>
  );
  if (!onPress && !onLongPress) return <View testID={testID}>{body}</View>;
  return (
    <PressableRow
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      accessibilityRole={accessibilityRole || 'button'}
      accessibilityLabel={accessibilityLabel || (typeof title === 'string' ? title : undefined)}
      accessibilityState={checked !== undefined ? { selected: !!checked, disabled: !!disabled } : { disabled: !!disabled }}
      testID={testID}
    >
      {body}
    </PressableRow>
  );
}

export function SettingsSwitchRow({ title, subtitle, value, onValueChange, disabled, icon, iconTile, testID }) {
  return (
    <SettingsRow
      title={title}
      subtitle={subtitle}
      icon={icon}
      iconTile={iconTile}
      disabled={disabled}
      testID={testID}
      numberOfLines={2}
      subtitleLines={4}
      right={<NativeSwitch value={!!value} onValueChange={onValueChange} disabled={disabled} accessibilityLabel={typeof title === 'string' ? title : undefined} />}
    />
  );
}

// Bottom sheet with a checkmark list. Used by SettingsPickerRow; exported so
// screens can open it from any row.
export function OptionSheet({ visible, title, message, options = [], value, onSelect, onClose, cancelLabel = 'Cancelar' }) {
  const g = useGroupedColors();
  const insets = useSafeAreaInsets();
  // [2026-10-09 native-sheets] iOS/Android: sheet do SISTEMA (grabber, arrastar
  // p/ fechar, fundo escurecido nativo) — sem botão Cancelar (o gesto/toque fora
  // fecha). Web: Modal + card + Cancelar originais.
  if (USE_NATIVE_SHEETS) {
    return (
      <NativeSheet visible={!!visible} onClose={onClose} detents="fitToContents" backgroundColor={g.cardBg}>
        <View style={{ backgroundColor: g.cardBg, paddingTop: 14, paddingBottom: nativeSheetBottomPad(insets, 8) }}>
          {(!!title || !!message) && (
            <View style={[st.sheetHead, { borderBottomColor: g.separator }]}>
              {!!title && <Text style={[st.sheetTitle, { color: g.text }]} numberOfLines={2}>{title}</Text>}
              {!!message && <Text style={[st.sheetMsg, { color: g.secondary }]}>{message}</Text>}
            </View>
          )}
          <ScrollView style={{ maxHeight: 480 }} bounces={false}>
            {options.map((o, i) => {
              const sel = o.value === value;
              return (
                <React.Fragment key={String(o.value)}>
                  {i > 0 && <View style={[st.sep, { marginLeft: 16, backgroundColor: g.separator }]} />}
                  <SettingsRow
                    title={o.label}
                    subtitle={o.sub}
                    value={o.hint}
                    checked={sel}
                    accessibilityRole="radio"
                    onPress={() => { onSelect?.(o.value); onClose?.(); }}
                  />
                </React.Fragment>
              );
            })}
          </ScrollView>
        </View>
      </NativeSheet>
    );
  }
  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.38)' }]} onPress={onClose} accessibilityLabel={cancelLabel} />
      <View style={[st.sheetWrap, { paddingBottom: Math.max(insets.bottom, 12) }]} pointerEvents="box-none">
        <View style={[st.sheet, { backgroundColor: g.cardBg }]}>
          {(!!title || !!message) && (
            <View style={[st.sheetHead, { borderBottomColor: g.separator }]}>
              {!!title && <Text style={[st.sheetTitle, { color: g.text }]} numberOfLines={2}>{title}</Text>}
              {!!message && <Text style={[st.sheetMsg, { color: g.secondary }]}>{message}</Text>}
            </View>
          )}
          <ScrollView style={{ maxHeight: 420 }} bounces={false}>
            {options.map((o, i) => {
              const sel = o.value === value;
              return (
                <React.Fragment key={String(o.value)}>
                  {i > 0 && <View style={[st.sep, { marginLeft: 16, backgroundColor: g.separator }]} />}
                  <SettingsRow
                    title={o.label}
                    subtitle={o.sub}
                    value={o.hint}
                    checked={sel}
                    accessibilityRole="radio"
                    onPress={() => { onSelect?.(o.value); onClose?.(); }}
                  />
                </React.Fragment>
              );
            })}
          </ScrollView>
        </View>
        <PressableRow
          onPress={onClose}
          style={[st.sheetCancel, { backgroundColor: g.cardBg }]}
          accessibilityRole="button"
          accessibilityLabel={cancelLabel}
        >
          <Text style={[st.sheetCancelText, { color: g.text }]}>{cancelLabel}</Text>
        </PressableRow>
      </View>
    </Modal>
  );
}

// Row that shows the current choice on the right and opens an OptionSheet.
// options: [{ value, label, sub?, hint?, short? }] — `short` is what shows on
// the row (defaults to label).
export function SettingsPickerRow({ title, subtitle, options = [], value, onChange, sheetTitle, sheetMessage, disabled, icon, cancelLabel, displayValue, testID }) {
  const [open, setOpen] = useState(false);
  const cur = options.find(o => o.value === value);
  const shown = displayValue ?? (cur ? (cur.short || cur.label) : '');
  return (
    <>
      <SettingsRow
        title={title}
        subtitle={subtitle}
        icon={icon}
        value={shown}
        disabled={disabled}
        chevron
        testID={testID}
        accessibilityLabel={`${title}${shown ? ', ' + shown : ''}`}
        onPress={disabled ? undefined : () => setOpen(true)}
      />
      {open && (
        <OptionSheet
          visible={open}
          title={sheetTitle || title}
          message={sheetMessage}
          options={options}
          value={value}
          onSelect={(v) => { if (v !== value) onChange?.(v); }}
          onClose={() => setOpen(false)}
          cancelLabel={cancelLabel}
        />
      )}
    </>
  );
}

// [2026-10-08 settings-redesign2] Moldura de uma sub-tela de Ajustes pushada
// (ex. /notification-preferences, /advanced-privacy, /bia-settings): header
// NATIVO (UINavigationBar de vidro no iOS / Toolbar no Android) com um único
// título, fundo agrupado e ScrollView com contentInsetAdjustmentBehavior
// "automatic" no iOS — o UIKit calcula o inset do header translúcido (nada
// fica cortado por baixo dele) e o do teclado (automaticallyAdjustKeyboardInsets).
// Web: header simples (voltar + título) acima do scroll.
const IOS_NATIVE = USE_NATIVE_HEADER && Platform.OS === 'ios';
export function SettingsScreen({ title, children, headerRight, onBack, contentStyle, overlay, testID }) {
  const g = useGroupedColors();
  const { colors = {}, isDark } = useTheme() || {};
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const goBack = onBack || (() => {
    try { if (router.canGoBack?.()) { router.back(); return; } } catch {}
    try { router.replace('/settings'); } catch {}
  });
  return (
    <View style={{ flex: 1, backgroundColor: g.pageBg }} testID={testID}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({
          colors,
          isDark,
          title,
          blur: true,
          contentStyle: { backgroundColor: g.pageBg },
          ...(headerRight ? { headerRight } : {}),
        })} />
      ) : (
        <View style={[st.webHeader, { paddingTop: insets.top, backgroundColor: g.pageBg }]}>
          <Pressable onPress={goBack} style={st.webBack} accessibilityRole="button" accessibilityLabel="Voltar" hitSlop={8}>
            <IconArrowLeft size={24} color={g.text} />
          </Pressable>
          <Text style={[st.webTitle, { color: g.text }]} numberOfLines={1} accessibilityRole="header">{title}</Text>
          <View style={st.webBack}>{headerRight ? headerRight() : null}</View>
        </View>
      )}
      <ScrollView
        contentInsetAdjustmentBehavior={IOS_NATIVE ? 'automatic' : undefined}
        automaticallyAdjustKeyboardInsets={IOS_NATIVE}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        contentContainerStyle={[st.screenContent, { paddingBottom: IOS_NATIVE ? 32 : 32 + insets.bottom }, contentStyle]}
      >
        {children}
      </ScrollView>
      {overlay || null}
    </View>
  );
}

// Text input that lives inside a grouped card (full-width, filled).
export function useSettingsInputStyle() {
  const g = useGroupedColors();
  return [st.cardInput, { color: g.text, backgroundColor: g.fill }];
}

// Content padded inside a card (segmented control, text inputs, etc.).
export function SettingsCardContent({ children, style }) {
  return <View style={[{ paddingHorizontal: 16, paddingVertical: 12 }, style]}>{children}</View>;
}

const st = StyleSheet.create({
  webHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 52 },
  webBack: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', ...Platform.select({ web: { cursor: 'pointer' }, default: {} }) },
  webTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600' },
  screenContent: { paddingHorizontal: 16, paddingTop: 16, width: '100%', maxWidth: 720, alignSelf: 'center' },
  cardInput: {
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, minHeight: 44,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  header: { fontSize: 13, fontWeight: '500', letterSpacing: 0.2, paddingHorizontal: 16, marginBottom: 7 },
  footer: { fontSize: 13, lineHeight: 18, paddingHorizontal: 16, marginTop: 7 },
  card: { borderRadius: 12, overflow: 'hidden' },
  sep: { height: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingHorizontal: 16, paddingVertical: 10 },
  title: { fontSize: 16, fontWeight: '400', letterSpacing: -0.2 },
  subtitle: { fontSize: 13, lineHeight: 17, marginTop: 2 },
  value: { fontSize: 16, marginLeft: 10, maxWidth: 170, textAlign: 'right' },
  sheetWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 10, maxWidth: 560, width: '100%', alignSelf: 'center' },
  sheet: { borderRadius: 14, overflow: 'hidden' },
  sheetHead: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, alignItems: 'center' },
  sheetTitle: { fontSize: 14, fontWeight: '600', textAlign: 'center' },
  sheetMsg: { fontSize: 13, marginTop: 4, textAlign: 'center', lineHeight: 17 },
  sheetCancel: { marginTop: 8, borderRadius: 14, minHeight: 54, alignItems: 'center', justifyContent: 'center', ...Platform.select({ web: { cursor: 'pointer' }, default: {} }) },
  sheetCancelText: { fontSize: 17, fontWeight: '600' },
});
