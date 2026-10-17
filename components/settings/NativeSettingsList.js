// components/settings/NativeSettingsList.js — [2026-10-15 settings-native]
//
// Lista agrupada da RAIZ das Configurações em NATIVO (modules/
// expo-chat-conversation-list, view ChatyySettingsList):
//   iOS     UICollectionView (layout compositional: cartões arredondados por
//           seção, linhas com chip de ícone suave + subtítulo de estado +
//           disclosure; acessório UISwitch com haptic quando a linha é toggle)
//   Android RecyclerView + DiffUtil, cartões por seção (cantos por posição),
//           SwitchCompat-like nativo com haptic.
// Mesmo visual 2026 da lista JS (SettingsKit): o JS manda a PALETA já
// resolvida (useGroupedColors → processColor) e as linhas PLANAS; só PATCHES
// por id cruzam a ponte (createPatcher do nativeAdapter).
// Busca: a prop `query` filtra NO NATIVO (título + subtítulo + palavras-chave,
// sem acento) — nenhuma linha atravessa a ponte por tecla.
// O hero/cartões especiais seguem JS: 1º filho RN (rola junto, acima da 1ª seção).
//
// Linhas: { id, k: 'c' categoria | 'q' resultado de busca | 'a' ação | 't' toggle,
//           sid, hd (cabeçalho da seção), title, sub?, icon?, kw?, dest?, center?, on? }
// Desligar (OTA): globalThis.__chatyy_native_settings = false. Erro de
// render/nativo → onFailure() e a raiz volta para a lista JS.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNativeHeaderTouchGuard } from '../native/nativeHeaderTouchGuard'; // [2026-10-17 settings-scroll-tap]
import { StyleSheet, View, processColor } from 'react-native';
import { getNativeSettingsListView } from '../../modules/expo-chat-conversation-list';
import { createPatcher } from '../chatlist/nativeAdapter';
import { Spacing } from '../../constants/theme';

export function isNativeSettingsListAvailable() {
  try { return !!getNativeSettingsListView(); } catch { return false; }
}

class Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch(error) {
    try { this.props.onFailure?.(String(error?.message || error)); } catch {}
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

const PALETTE_KEYS = ['pageBg', 'cardBg', 'separator', 'header', 'text', 'secondary', 'tertiary', 'chipBg', 'chipFg', 'destructive', 'fill'];

function Inner(props) {
  const { rows, query, header, isDark, palette, labels, maxWidth, bottomInset = 0, autoInset, refreshing } = props;
  const Native = getNativeSettingsListView();
  const patcherRef = useRef(null);
  const headerTouchGuard = useNativeHeaderTouchGuard();
  if (!patcherRef.current) patcherRef.current = createPatcher();
  const [resyncToken, setResyncToken] = useState(0);

  const { patch, snapshot } = useMemo(
    () => patcherRef.current.diff(Array.isArray(rows) ? rows : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, resyncToken]
  );
  useLayoutEffect(() => { patcherRef.current.commit(snapshot); }, [snapshot]);

  // Paleta → números ARGB (o nativo não interpreta 'rgba(...)'). Chave
  // estável: useGroupedColors devolve objeto novo a cada render e cada troca
  // de `colors` faz o nativo re-tematizar a lista inteira.
  const paletteKey = PALETTE_KEYS.map(k => String(palette?.[k] ?? '')).join('|') + (isDark ? '|d' : '|l');
  const colors = useMemo(() => {
    const out = {};
    for (const k of PALETTE_KEYS) {
      const v = palette?.[k];
      if (v == null) continue;
      const n = processColor(v);
      if (typeof n === 'number') out[k] = n;
    }
    out.press = processColor(isDark ? '#26292C' : '#EBEBED');
    out.ripple = processColor(isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)');
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteKey]);

  const [headerH, setHeaderH] = useState(0);
  const onHeaderLayout = useMemo(() => (e) => {
    const h = Math.round(e?.nativeEvent?.layout?.height || 0);
    setHeaderH(prev => (prev === h ? prev : h));
  }, []);

  const propsRef = useRef(props);
  propsRef.current = props;
  const handlers = useMemo(() => ({
    onRowPress: (e) => {
      const id = String((e?.nativeEvent ?? e)?.id ?? '');
      try { propsRef.current.onRowPress?.(id); } catch {}
    },
    onToggle: (e) => {
      const ev = e?.nativeEvent ?? e;
      try { propsRef.current.onToggle?.(String(ev?.id ?? ''), !!ev?.value); } catch {}
    },
    onRefresh: () => { try { propsRef.current.onRefresh?.(); } catch {} },
    onResync: () => {
      patcherRef.current.requestReset();
      setResyncToken(v => v + 1);
    },
    onNativeError: (e) => {
      const msg = String((e?.nativeEvent ?? e)?.message || 'native error');
      try { globalThis.__chatyyNativeSettingsError = { at: Date.now(), msg }; } catch {}
      try { propsRef.current.onFailure?.(msg); } catch {}
    },
  }), []);

  useEffect(() => { if (!Native) { try { propsRef.current.onFailure?.('no native view'); } catch {} } }, [Native]);
  if (!Native) return null;
  return (
    <Native
      style={styles.fill}
      rowsPatch={patch}
      query={query || ''}
      colors={colors}
      dark={!!isDark}
      labels={labels}
      headerHeight={headerH}
      bottomInset={bottomInset || 0}
      maxContentWidth={maxWidth || 0}
      autoInset={!!autoInset}
      refreshing={!!refreshing}
      {...handlers}
    >
      <View collapsable={false} style={styles.slot} onLayout={onHeaderLayout} {...headerTouchGuard}>
        {header ? <View style={[styles.headerPad, maxWidth ? { maxWidth, width: '100%', alignSelf: 'center' } : null]}>{header}</View> : null}
      </View>
    </Native>
  );
}

export default function NativeSettingsList(props) {
  return (
    <Boundary onFailure={props.onFailure}>
      <Inner {...props} />
    </Boundary>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  slot: { position: 'absolute', top: 0, left: 0, right: 0 },
  // Mesmo respiro da lista JS (ScrollView paddingHorizontal 16 / paddingTop 12).
  headerPad: { paddingHorizontal: 16, paddingTop: Spacing.md },
});
