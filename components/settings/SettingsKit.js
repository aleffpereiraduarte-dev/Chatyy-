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
import React, { useState, useRef, useContext, createContext } from 'react';
import { View, Text, Modal, Pressable, ScrollView, StyleSheet, Platform } from 'react-native';
import FadeSlideIn from '../FadeSlideIn';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import { useLanguageOptional } from '../../context/LanguageContext';
import PressableRow from '../PressableRow';
import NativeSwitch from '../NativeSwitch';
import { IconChevronRight, IconCheck, IconArrowLeft } from '../Icons';
import { USE_NATIVE_HEADER, nativeHeaderOptions, HeaderBackButton } from '../nativeHeader';
import { USE_NATIVE_SHEETS, NativeSheet, nativeSheetBottomPad } from '../NativeSheet'; // [2026-10-09 native-sheets]
import useDragToDismiss, { DragSheetRoot, DragPanel, DragScroll, DragFade } from '../ui/useDragToDismiss';
import { Typography, BorderRadius, Elevation, hairlineColor, THEME_V2, Grafite, cardShadow } from '../../constants/theme'; // [2026-10-18 elegance]
// [2026-10-18 settings-sub-native] modo "coleta": dentro de uma sub-página
// nativa (SettingsCategoryScreen + ChatyySettingsList api ≥ 2) grupo/linha
// não desenham — viram descritores da lista nativa (components/settings/nativeCollect.js).
import { SettingsCollectContext, CollectGroup, CollectRow } from './nativeCollect';
import { useKeyboardInset } from '../chat/SheetKeyboardAvoider'; // [2026-10-22 kb-uniforme]

// Palette for grouped lists. Light = iOS systemGroupedBackground; dark keeps
// the app's true-black page [2026-10-08 dark-black] and lifts the cards one step so groups read as groups.
export function useGroupedColors() {
  const { colors = {}, isDark } = useTheme() || {};
  if (THEME_V2) return _v2Grouped(colors, !!isDark);
  return {
    isDark: !!isDark,
    // [2026-10-15 settings-2026] claro mais limpo (cinza quase branco) e escuro
    // PRETO verdadeiro com cartões só um degrau acima; separadores mais leves.
    pageBg: isDark ? (colors.background || Elevation.dark.grouped) : Elevation.light.grouped, // [2026-10-18 elegance] #F2F2F7 (iOS systemGroupedBackground; era #F3F3F6)
    // [2026-10-17 settings-wa] escuro: cartão #1C1C1E (secondarySystemGrouped
    // do iOS / WhatsApp) — #141416 quase sumia no preto e os separadores 0.07
    // ficavam invisíveis; claro: hairline um pouco mais legível.
    cardBg: isDark ? Elevation.dark.card : Elevation.light.card,
    separator: hairlineColor(isDark), // [2026-10-18 elegance] token (mesmos valores)
    header: isDark ? '#7C7C82' : '#77777D',
    text: colors.text || (isDark ? '#F5F5F7' : '#111111'),
    secondary: isDark ? '#8E8E93' : '#8A8A8E',
    tertiary: isDark ? '#636366' : '#C4C4C7',
    ink: colors.text || (isDark ? '#F5F5F7' : '#111111'),
    onInk: isDark ? '#000000' : '#FFFFFF',
    destructive: colors.error || '#dc2626',
    tileBg: isDark ? '#F5F5F7' : '#111111',
    tileFg: isDark ? '#0b0b0b' : '#FFFFFF',
    fill: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(118,118,128,0.12)',
    // [2026-10-15 settings-2026] chip suave monocromático atrás dos ícones
    // (no lugar do quadrado preto pesado) + realce do termo buscado.
    chipBg: isDark ? 'rgba(255,255,255,0.075)' : 'rgba(17,17,17,0.055)',
    chipFg: isDark ? '#EDEDF0' : '#1A1A1C',
    ring: isDark ? 'rgba(255,255,255,0.16)' : 'rgba(17,17,17,0.10)',
    highlightBg: isDark ? 'rgba(255,255,255,0.20)' : 'rgba(17,17,17,0.10)',
  };
}

// [2026-10-20 grafite] tema v2: fundo agrupado = colors.background (#F2F2EF /
// #0E0E10, igual ao fundo da rota em app/_layout → sem piscar no push),
// cartões = colors.surface com sombra macia, ícones em ladrilho grafite.
const _v2gCache = new Map();
function _v2Grouped(colors, isDark) {
  const G = isDark ? Grafite.dark : Grafite.light;
  const key = `${isDark ? 1 : 0}|${colors.background}|${colors.surface}|${colors.text}|${colors.error}|${colors.highContrast ? 1 : 0}`;
  let v = _v2gCache.get(key);
  if (v) return v;
  v = {
    isDark,
    pageBg: colors.background || G.bg,
    cardBg: colors.surface || G.surface,
    cardShadow: cardShadow(isDark),
    separator: hairlineColor(isDark),
    header: isDark ? '#7F7F85' : '#8F8F94',
    text: colors.text || G.text,
    secondary: colors.textSecondary || G.muted,
    tertiary: isDark ? '#5A5A60' : '#C4C4C0',
    ink: G.ink,
    onInk: G.onInk,
    destructive: colors.error || '#dc2626',
    tileBg: G.tile[1],
    tileFg: G.tileText,
    fill: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(24,24,27,0.06)',
    chipBg: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(24,24,27,0.055)',
    chipFg: isDark ? '#ECECE8' : '#1A1A1C',
    ring: isDark ? 'rgba(255,255,255,0.16)' : 'rgba(24,24,27,0.10)',
    highlightBg: isDark ? 'rgba(255,255,255,0.20)' : 'rgba(24,24,27,0.10)',
    v2: true,
  };
  if (_v2gCache.size > 16) _v2gCache.clear();
  _v2gCache.set(key, v);
  return v;
}
const _v2TileCache = {};
/** Ladrilho grafite do tema v2: raio 10, gradiente 160° + reflexo de 1 px (objeto estável). */
export function grafiteTileStyle(isDark, size) {
  const k = `${isDark ? 'd' : 'l'}${size || 0}`;
  if (_v2TileCache[k]) return _v2TileCache[k];
  const g = isDark ? Grafite.dark : Grafite.light;
  const grad = `linear-gradient(160deg, ${g.tile[0]} 0%, ${g.tile[1]} 100%)`;
  const sh = 'inset 0px 1px 0px rgba(255,255,255,0.18), 0px 2px 6px rgba(0,0,0,0.12)';
  const r = size ? Math.min(Grafite.radius.tile, Math.round(size * 0.31)) : Grafite.radius.tile;
  _v2TileCache[k] = Platform.OS === 'web'
    ? { backgroundColor: g.tile[1], backgroundImage: grad, boxShadow: sh, borderRadius: r }
    : { backgroundColor: g.tile[1], experimental_backgroundImage: grad, boxShadow: sh, borderRadius: r };
  return _v2TileCache[k];
}

// Ícone da linha num chip suave (squircle) monocromático — [2026-10-15
// settings-2026] o quadrado preto sólido pesava demais; `solid` mantém o
// visual antigo para quem precisar de destaque.
export function SettingsIconTile({ Icon, size = 32, muted = false, solid = false }) {
  const g = useGroupedColors();
  if (!Icon) return null;
  // [2026-10-18 bia-orb-icon] Ícone que é a própria forma (orb da Bia): ocupa o ladrilho, sem chip atrás.
  if (Icon.__fillsTile) return <Icon size={size} />;
  // [2026-10-19 tg-settings] Ajustes/Telegram em P&B: glifo branco em quadrado
  // grafite cheio (mesmo visual da lista nativa api 5, iconStyle "solid").
  // Kill switch: globalThis.__chatyy_tg_list = false → chip suave de antes.
  let graphite = false;
  try { graphite = !solid && !muted && globalThis.__chatyy_tg_list !== false; } catch {}
  const bg = solid ? g.tileBg : graphite ? (g.isDark ? '#3A3A3C' : '#2C2C2E') : (muted ? g.fill : g.chipBg);
  const fg = solid ? g.tileFg : graphite ? '#FFFFFF' : g.chipFg;
  const v2Tile = g.v2 && (graphite || solid) ? grafiteTileStyle(g.isDark, size) : null;
  return (
    <View style={[{
      width: size, height: size, borderRadius: Math.round(size * (graphite ? 0.24 : 0.31)),
      backgroundColor: bg,
      alignItems: 'center', justifyContent: 'center',
    }, v2Tile]}>
      <Icon size={Math.round(size * 0.56)} color={fg} />
    </View>
  );
}

// [2026-10-15 settings-2026] Busca das Configurações: o termo digitado chega
// às linhas por contexto e o trecho que casa aparece realçado no título.
export const SettingsSearchContext = createContext('');
function HighlightText({ text, query, style, numberOfLines }) {
  const g = useGroupedColors();
  const str = typeof text === 'string' ? text : null;
  const q = (query || '').trim();
  if (!str || !q) return <Text style={style} numberOfLines={numberOfLines}>{text}</Text>;
  const i = str.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <Text style={style} numberOfLines={numberOfLines}>{text}</Text>;
  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {str.slice(0, i)}
      <Text style={{ fontWeight: '700', backgroundColor: g.highlightBg, borderRadius: 4 }}>{str.slice(i, i + q.length)}</Text>
      {str.slice(i + q.length)}
    </Text>
  );
}

// Entrada em cascata: grupos montados juntos (mesma tela/categoria) entram
// um após o outro (35 ms). FadeSlideIn já respeita Reduzir Movimento e a
// regra "nasce assentado durante o push nativo".
let _cascadeAt = 0;
let _cascadeN = 0;
function useCascadeDelay() {
  const ref = useRef(null);
  if (ref.current === null) {
    const now = Date.now();
    if (now - _cascadeAt > 280) { _cascadeAt = now; _cascadeN = 0; }
    ref.current = Math.min(_cascadeN++, 8) * 35;
  }
  return ref.current;
}

// [2026-10-16 polish-config] Separador recuado como UITableView inset-grouped:
// sem `inset` explícito, a linha alinha com o TEXTO da linha de cima (passa
// por baixo do ícone em quadradinho: 16 + 32 + 14 = 62; ícone solto: 54).
function _autoInset(child) {
  const p = child && child.props;
  if (p && p.left) return 62; // [2026-10-18 storage-names] avatar 34 + 12 + 16
  if (!p || !p.icon) return 16;
  return p.iconTile === false ? 54 : 62;
}

export function SettingsGroup(props) {
  const col = useContext(SettingsCollectContext);
  if (col) return <CollectGroup col={col} {...props} />;
  return <SettingsGroupJS {...props} />;
}

// `nativeHeader`: no modo coleta o conteúdo vai como cartão RN no topo da
// lista nativa (ex.: cabeçalho da Bia); na lista JS é um grupo normal.
function SettingsGroupJS({ header, footer, children, inset, style, cardStyle, testID }) {
  const g = useGroupedColors();
  const delay = useCascadeDelay();
  const items = React.Children.toArray(children).filter(Boolean);
  if (!items.length && !header) return null;
  return (
    <FadeSlideIn delay={delay} distance={8} duration={240} style={[{ flex: 0, flexGrow: 0, flexShrink: 0, flexBasis: 'auto', marginBottom: 24 }, style]}>
    <View testID={testID}>
      {!!header && (
        <Text style={[st.header, { color: g.header }]} accessibilityRole="header" numberOfLines={1}>
          {String(header).toUpperCase()}
        </Text>
      )}
      {items.length > 0 && (
        <View style={[st.card, { backgroundColor: g.cardBg }, g.cardShadow, cardStyle]}>
          {items.map((child, i) => (
            <React.Fragment key={child.key ?? i}>
              {i > 0 && <View style={[st.sep, { marginLeft: inset ?? _autoInset(items[i - 1]), backgroundColor: g.separator }]} />}
              {child}
            </React.Fragment>
          ))}
        </View>
      )}
      {!!footer && <Text style={[st.footer, { color: g.header }]}>{footer}</Text>}
    </View>
    </FadeSlideIn>
  );
}

// [2026-10-17 settings-wa] Texto de VALOR à direita (mesma fonte/cor do
// `value` da SettingsRow) p/ quem monta o lado direito à mão (`right`):
// spinner + valor, valor + ícone, ação em texto ("Desbloquear", "Limpar").
export function SettingsValueText({ children, color, style, numberOfLines = 1 }) {
  const g = useGroupedColors();
  return <Text style={[st.value, { marginLeft: 0, color: color || g.secondary }, style]} numberOfLines={numberOfLines}>{children}</Text>;
}
SettingsValueText.__nativeValueText = true; // modo coleta: `right` = valor em texto

// Generic row. Right side priority: `right` node > `checked` > value + chevron.
// [2026-10-09 geo-qa] RTL (árabe/hebraico/persa/urdu no web: <html dir="rtl">):
// margem entre ícone/texto/seta do lado certo — o ícone colava no texto —
// e a seta ">" espelhada para "<".
function _docRTL() {
  try { return Platform.OS === 'web' && typeof document !== 'undefined' && document.documentElement && document.documentElement.dir === 'rtl'; } catch { return false; }
}

// `native` (opcional, só modo coleta): { val, acc } substitui um `right`
// próprio na lista nativa (ex.: código do convite como valor, sem seta).
export function SettingsRow(props) {
  const col = useContext(SettingsCollectContext);
  if (col) return <CollectRow col={col} rowProps={props} />;
  return <SettingsRowJS {...props} />;
}

function SettingsRowJS({
  title, subtitle, value, icon: Icon, iconTile = true, onPress, onLongPress, chevron,
  right, destructive, disabled, checked, titleStyle, numberOfLines = 1, subtitleLines = 2,
  accessibilityLabel, accessibilityRole, center, testID, children, left,
}) {
  const g = useGroupedColors();
  const searchQ = useContext(SettingsSearchContext);
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
      {/* [2026-10-18 storage-names] `left` = nó próprio à esquerda (ex.: avatar da conversa). */}
      {left ? <View style={{ ..._gapEnd(12) }}>{left}</View> : null}
      {!left && !!Icon && (iconTile
        ? <View style={{ ..._gapEnd(14) }}><SettingsIconTile Icon={Icon} /></View>
        : <View style={{ ..._gapEnd(14), width: 24, alignItems: 'center' }}><Icon size={20} color={destructive ? g.destructive : g.text} /></View>)}
      <View style={{ flex: 1, minWidth: 0, alignItems: center ? 'center' : 'flex-start' }}>
        <HighlightText text={title} query={searchQ} style={[st.title, { color: titleColor }, titleStyle]} numberOfLines={numberOfLines} />
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
export function OptionSheet({ visible, title, message, options = [], value, onSelect, onClose, cancelLabel: cancelLabelProp }) {
  // [2026-10-17 drag-dismiss] folha desce arrastando de qualquer ponto (components/ui/useDragToDismiss).
  const _drag270 = useDragToDismiss({ onDismiss: () => { const f = onClose; if (typeof f === 'function') f(); } });
  const _lang = useLanguageOptional();
  const cancelLabel = cancelLabelProp || (_lang?.t?.('common.cancel')) || 'Cancelar';
  const g = useGroupedColors();
  const insets = useSafeAreaInsets();
  // [2026-10-09 native-sheets] iOS/Android: sheet do SISTEMA (grabber, arrastar
  // p/ fechar, fundo escurecido nativo) — sem botão Cancelar (o gesto/toque fora
  // fecha). Web: Modal + card + Cancelar originais.
  if (USE_NATIVE_SHEETS) {
    return (
      <NativeSheet visible={!!visible} onClose={onClose} detents="fitToContents" backgroundColor={g.cardBg}>
        {/* [2026-10-14 sheet-overlap] Com detents fitToContents o formSheet do
            RNS (iOS) "adota" o 1º ScrollView como scroll do sheet e o
            posiciona no topo → o TÍTULO ficava por cima da 1ª opção (e sobrava
            um vão embaixo). Listas curtas (≤8, o caso de todos os pickers)
            agora são Views simples; listas longas mantêm o ScrollView. */}
        <View style={{ backgroundColor: g.cardBg, paddingTop: 20, paddingBottom: nativeSheetBottomPad(insets, 12) }}>
          {(!!title || !!message) && (
            <View style={[st.sheetHead, { borderBottomColor: g.separator }]}>
              {!!title && <Text style={[st.sheetTitle, st.sheetTitleNative, { color: g.text }]} numberOfLines={2} accessibilityRole="header">{title}</Text>}
              {!!message && <Text style={[st.sheetMsg, { color: g.secondary }]}>{message}</Text>}
            </View>
          )}
          {React.createElement(options.length > 8 ? ScrollView : View, options.length > 8 ? { style: { maxHeight: 480 }, bounces: false } : null,
            options.map((o, i) => {
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
            }))}
        </View>
      </NativeSheet>
    );
  }
  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <DragSheetRoot>
      <DragFade drag={_drag270}><Pressable style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.38)' }]} onPress={onClose} accessibilityLabel={cancelLabel} /></DragFade>
      <DragPanel drag={_drag270} style={[st.sheetWrap, { paddingBottom: Math.max(insets.bottom, 12) }]} pointerEvents="box-none">
        <View style={[st.sheet, { backgroundColor: g.cardBg }]}>
          {(!!title || !!message) && (
            <View style={[st.sheetHead, { borderBottomColor: g.separator }]}>
              {!!title && <Text style={[st.sheetTitle, { color: g.text }]} numberOfLines={2}>{title}</Text>}
              {!!message && <Text style={[st.sheetMsg, { color: g.secondary }]}>{message}</Text>}
            </View>
          )}
          <DragScroll drag={_drag270}><ScrollView style={{ maxHeight: 420 }} bounces={false}>
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
          </ScrollView></DragScroll>
        </View>
        <PressableRow
          onPress={onClose}
          style={[st.sheetCancel, { backgroundColor: g.cardBg }]}
          accessibilityRole="button"
          accessibilityLabel={cancelLabel}
        >
          <Text style={[st.sheetCancelText, { color: g.text }]}>{cancelLabel}</Text>
        </PressableRow>
      </DragPanel>
      </DragSheetRoot>
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
// [2026-10-19 manage-storage] opaqueHeader: barra SÓLIDA na cor da página (sem
// vidro/transparente) com o título grande que colapsa — o conteúdo nunca passa
// por baixo do título/voltar (no iOS 26 o vidro transparente deixava as linhas
// visíveis atrás do título grande). A rota no _layout nasce com a mesma config.
export function SettingsScreen({ title, children, headerRight, onBack, contentStyle, overlay, testID, opaqueHeader = false, largeTitle = true }) {
  const _lang = useLanguageOptional();
  const g = useGroupedColors();
  const { colors = {}, isDark } = useTheme() || {};
  const insets = useSafeAreaInsets();
  const router = useRouter();
  let canGoBackNow = true;
  try { canGoBackNow = !!router.canGoBack?.(); } catch {}
  const goBack = onBack || (() => {
    try { if (router.canGoBack?.()) { router.back(); return; } } catch {}
    try { router.replace('/settings'); } catch {}
  });
  // [2026-10-22 kb-uniforme] Android edge-to-edge: a janela não encolhe com o
  // teclado → a lista encolhe pelo padding (campos da lista acima do teclado).
  // iOS segue com automaticallyAdjustKeyboardInsets (hook = 0 fora do Android).
  const kbInset = useKeyboardInset();
  return (
    <View style={[{ flex: 1, backgroundColor: g.pageBg }, kbInset > 0 ? { paddingBottom: kbInset } : null]} testID={testID}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({
          colors,
          isDark,
          title,
          blur: !opaqueHeader,
          // [2026-10-17 settings-polish] título grande que colapsa (igual à rota no _layout).
          // [2026-10-22] largeTitle=false: tela que já tem o título grande no próprio cartão (plano).
          largeTitle: largeTitle !== false,
          contentStyle: { backgroundColor: g.pageBg },
          // [2026-10-22 plano-titulo] largeTitle=false precisa DESLIGAR explicitamente (a rota pode nascer com headerLargeTitle).
          ...(largeTitle === false && Platform.OS === 'ios' ? { headerLargeTitle: false } : {}),
          ...(opaqueHeader ? {
            // [2026-10-22 plano-titulo] sólido de verdade mesmo se a rota nasceu com vidro (_NATIVE_HDR_GLASS).
            headerTransparent: false,
            headerBlurEffect: undefined,
            headerStyle: { backgroundColor: g.pageBg },
            headerShadowVisible: false,
            ...(Platform.OS === 'ios' ? { headerLargeStyle: { backgroundColor: g.pageBg } } : {}),
          } : {}),
          ...(headerRight ? { headerRight } : {}),
          // [2026-10-12 settings-back] Aberta sem histórico (link/push/replace)
          // o header nativo fica SEM voltar → botão próprio que cai no hub.
          // onBack custom também precisa do nosso botão (o nativo só faz pop).
          ...((onBack || !canGoBackNow) ? {
            headerLeft: () => <HeaderBackButton onPress={goBack} color={colors.text || g.text} accessibilityLabel={(_lang?.t?.('common.back')) || 'Voltar'} />,
            headerBackVisible: false, // [2026-10-12] senão o iOS mostra 2 "‹"
          } : {}),
        })} />
      ) : (
        <View style={[st.webHeader, { paddingTop: insets.top, backgroundColor: g.pageBg }]}>
          <Pressable onPress={goBack} style={st.webBack} accessibilityRole="button" accessibilityLabel={(_lang?.t?.('common.back')) || 'Voltar'} hitSlop={8}>
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
  webTitle: { flex: 1, textAlign: 'center', fontSize: Typography.headline.fontSize, fontWeight: Typography.headline.fontWeight, letterSpacing: Typography.headline.letterSpacing },
  screenContent: { paddingHorizontal: 16, paddingTop: 16, width: '100%', maxWidth: 720, alignSelf: 'center' },
  cardInput: {
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, minHeight: 44,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  // [2026-10-15 settings-2026] títulos de grupo pequenos em caixa alta com
  // tracking; cartões mais arredondados (iOS 26); linhas mais arejadas.
  // [2026-10-18 elegance] cabeçalho de seção = Typography.sectionHeader (13, igual ao iOS) — era 12/0.7.
  header: { fontSize: Typography.sectionHeader.fontSize, lineHeight: Typography.sectionHeader.lineHeight, fontWeight: Typography.sectionHeader.fontWeight, letterSpacing: Typography.sectionHeader.letterSpacing, paddingHorizontal: 18, marginBottom: 7 },
  footer: { fontSize: 13, lineHeight: 18, paddingHorizontal: 18, marginTop: 8 },
  // [2026-10-18 elegance] raio único de card (14, = Ligações/BorderRadius.card); era 18.
  card: { borderRadius: BorderRadius.card, overflow: 'hidden' },
  sep: { height: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingHorizontal: 16, paddingVertical: 11 },
  // [2026-10-17 settings-polish] iOS: corpo 17 pt (tracking do SF) como o Ajustes do iPhone; Android/web 16.
  title: Platform.OS === 'ios' ? { fontSize: 17, fontWeight: '400', letterSpacing: -0.41 } : { fontSize: 16, fontWeight: '400', letterSpacing: -0.25 },
  subtitle: { fontSize: 13, lineHeight: 17, marginTop: 2, letterSpacing: -0.05 },
  value: { fontSize: Platform.OS === 'ios' ? 17 : 16, letterSpacing: Platform.OS === 'ios' ? -0.41 : 0, marginLeft: 10, maxWidth: 170, textAlign: 'right' },
  sheetWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 10, maxWidth: 560, width: '100%', alignSelf: 'center' },
  sheet: { borderRadius: BorderRadius.sheet, overflow: 'hidden' },
  sheetHead: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, alignItems: 'center' },
  sheetTitle: { fontSize: 14, fontWeight: '600', textAlign: 'center' },
  // [2026-10-17 settings-wa] sheet do sistema (com grabber): título 17 semibold como o WhatsApp.
  sheetTitleNative: { fontSize: 17, fontWeight: '600', letterSpacing: -0.41 },
  sheetMsg: { fontSize: 13, marginTop: 4, textAlign: 'center', lineHeight: 17 },
  sheetCancel: { marginTop: 8, borderRadius: BorderRadius.sheet, minHeight: 54, alignItems: 'center', justifyContent: 'center', ...Platform.select({ web: { cursor: 'pointer' }, default: {} }) },
  sheetCancelText: { fontSize: 17, fontWeight: '600' },
});
