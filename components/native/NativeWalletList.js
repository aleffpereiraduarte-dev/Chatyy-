// components/native/NativeWalletList.js — [2026-10-15 native-wallet]
//
// CARTEIRA em NATIVO (modules/expo-chat-conversation-list → view
// ChatyyWalletList): herói grafite nativo com saldo em CONTAGEM ROLANDO
// (CADisplayLink / ValueAnimator) e botões, + histórico em lista nativa
// (UICollectionView compositional + diffable / RecyclerView + DiffUtil),
// transações agrupadas por dia em cartões, puxar p/ atualizar e paginação.
// Usada por app/wallet.js e app/creator-earnings.js.
//
// A tela continua dona dos dados e dos fluxos: monta `hero` e `rows` e recebe
// eventos por id — onHeroAction(id), onRowPress(id), onRowAction(id, action),
// onRefresh(), onEndReached(). `header` (blocos JS: ganhos, mais vendidos,
// filtros…) é o 1º filho RN e rola junto, logo abaixo do herói.
// Qualquer erro (render ou onNativeError) → onFailure(msg) e a tela volta
// para a lista JS na hora (marca globalThis.__chatyy_native_wallet_failed).
//
// Linhas: dia { id, k:'d', t } · transação { id, k:'x', sid, gl, t, sb, am,
//   cr, dm, a2, ag, tiles?, a11y } · vazio { id, k:'e', gl, t, sb, b?, ba? } ·
//   carregando { id, k:'l' } · nota { id, k:'n', t, cr? }
// Desligar (OTA/console): globalThis.__chatyy_native_wallet = false

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNativeHeaderTouchGuard } from './nativeHeaderTouchGuard'; // [2026-10-17 settings-scroll-tap]
import { Platform, StyleSheet, View, processColor } from 'react-native';
import { getNativeWalletListView } from '../../modules/expo-chat-conversation-list';
import { createPatcher } from '../chatlist/nativeAdapter';

export const WALLET_KILL_SWITCH = '__chatyy_native_wallet';

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

/** Liga a carteira nativa? (binário com a view + kill switch + não falhou nesta sessão). */
export function nativeWalletEnabled() {
  try {
    if (Platform.OS === 'web') return false;
    if (globalThis[WALLET_KILL_SWITCH] === false) return false;
    if (globalThis[`${WALLET_KILL_SWITCH}_failed`]) return false;
    return !!getNativeWalletListView();
  } catch { return false; }
}

/** Hook: [ligado, onFailure] com queda para JS na 1ª falha. */
export function useNativeWallet() {
  const [failed, setFailed] = useState(() => {
    try { return !!globalThis[`${WALLET_KILL_SWITCH}_failed`]; } catch { return false; }
  });
  const enabled = !failed && nativeWalletEnabled();
  const onFailure = useCallback((msg) => {
    try {
      globalThis[`${WALLET_KILL_SWITCH}_failed`] = true;
      console.warn('[native_wallet] fallback JS:', msg);
      try { require('../../services/crashReporter').reportNativeFallback('native_wallet', msg); } catch {}
    } catch {}
    setFailed(true);
  }, []);
  return [enabled, onFailure];
}

const COLOR_KEYS = ['pageBg', 'cardBg', 'separator', 'text', 'secondary', 'tertiary', 'fill', 'success', 'danger', 'ink', 'onInk', 'press'];

/** useSurface() → prop `colors` (ARGB). */
export function walletColors(s, isDark) {
  const src = {
    pageBg: s?.bgGrouped,
    cardBg: s?.surface,
    separator: s?.separator,
    text: s?.text,
    secondary: s?.textSecondary,
    tertiary: s?.textTertiary,
    fill: s?.fill,
    success: s?.success,
    danger: s?.danger,
    ink: s?.ink,
    onInk: s?.onInk,
    press: s?.pressed || (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)'),
  };
  const out = {};
  for (const k of COLOR_KEYS) {
    const v = src[k];
    if (v == null) continue;
    const n = processColor(v);
    if (typeof n === 'number') out[k] = n;
  }
  return out;
}

function Inner(props) {
  const {
    rows, hero, header, colors, isDark, maxWidth = 0, bottomInset = 0, autoInset = false,
    refreshEnabled = true, refreshing = false, heroTop = 16, heroGap = 16, authToken,
  } = props;
  const Native = getNativeWalletListView();
  let token = authToken || '';
  if (!token) { try { const a = require('../../services/api'); token = (a.getAuthToken && a.getAuthToken()) || ''; } catch {} }

  const patcherRef = useRef(null);
  const headerTouchGuard = useNativeHeaderTouchGuard();
  if (!patcherRef.current) patcherRef.current = createPatcher();
  const [resyncToken, setResyncToken] = useState(0);
  const safeRows = Array.isArray(rows) ? rows : [];
  const { patch, snapshot } = useMemo(
    () => patcherRef.current.diff(safeRows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [safeRows, resyncToken]
  );
  useLayoutEffect(() => { patcherRef.current.commit(snapshot); }, [snapshot]);

  // Chave estável: o objeto de cores muda a cada render; o nativo re-tematiza tudo a cada troca.
  const colorsKey = COLOR_KEYS.map((k) => String(colors?.[k] ?? '')).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nColors = useMemo(() => colors || {}, [colorsKey]);
  const heroKey = hero ? JSON.stringify(hero) : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nHero = useMemo(() => hero || null, [heroKey]);
  const heroInsets = useMemo(() => ({ top: heroTop, gap: heroGap }), [heroTop, heroGap]);

  const [headerH, setHeaderH] = useState(0);
  const onHeaderLayout = useCallback((e) => {
    const h = Math.round(e?.nativeEvent?.layout?.height || 0);
    setHeaderH((prev) => (prev === h ? prev : h));
  }, []);

  const propsRef = useRef(props);
  propsRef.current = props;
  const handlers = useMemo(() => {
    const ev = (e) => e?.nativeEvent ?? e;
    return {
      onRowPress: (e) => { const id = String(ev(e)?.id ?? ''); if (id) { try { propsRef.current.onRowPress?.(id); } catch {} } },
      onRowAction: (e) => {
        const x = ev(e);
        const id = String(x?.id ?? '');
        try { propsRef.current.onRowAction?.(id, String(x?.action || '')); } catch {}
      },
      onHeroAction: (e) => { const id = String(ev(e)?.id ?? ''); if (id) { try { propsRef.current.onHeroAction?.(id); } catch {} } },
      onRefresh: () => { try { propsRef.current.onRefresh?.(); } catch {} },
      onEndReached: () => { try { propsRef.current.onEndReached?.(); } catch {} },
      onResync: () => {
        patcherRef.current.requestReset();
        setResyncToken((v) => v + 1);
      },
      onFirstPaint: (e) => { try { propsRef.current.onFirstPaint?.(Number(ev(e)?.count) || 0); } catch {} },
      onNativeError: (e) => {
        const msg = String(ev(e)?.message || 'native error');
        try { propsRef.current.onFailure?.(msg); } catch {}
      },
    };
  }, []);

  if (!Native) return null;
  return (
    <Native
      style={styles.fill}
      rowsPatch={patch}
      hero={nHero}
      colors={nColors}
      dark={!!isDark}
      headerHeight={headerH}
      heroInsets={heroInsets}
      bottomInset={bottomInset || 0}
      maxContentWidth={maxWidth || 0}
      autoInset={!!autoInset}
      refreshEnabled={!!refreshEnabled}
      refreshing={!!refreshing}
      authToken={token}
      {...handlers}
    >
      <View collapsable={false} style={styles.slot} onLayout={onHeaderLayout} {...headerTouchGuard}>
        {header ? <View style={[styles.headerPad, maxWidth ? { maxWidth, width: '100%', alignSelf: 'center' } : null]}>{header}</View> : null}
      </View>
    </Native>
  );
}

export default function NativeWalletList(props) {
  return (
    <Boundary onFailure={props.onFailure}>
      <Inner {...props} />
    </Boundary>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  slot: { position: 'absolute', top: 0, left: 0, right: 0 },
  headerPad: { paddingHorizontal: 16 },
});
