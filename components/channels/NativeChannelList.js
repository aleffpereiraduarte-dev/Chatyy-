// components/channels/NativeChannelList.js — [2026-10-15 native-social]
//
// Aba CANAIS em NATIVO (views `ChatyyChannelList` / `ChatyyChannelFeed` do
// módulo modules/expo-chat-conversation-list — iOS UICollectionView +
// diffable, Android RecyclerView + DiffUtil). O ChannelsTab continua dono dos
// dados e das ações; aqui só:
//   1. manda as linhas (já montadas pelo ChannelsTab) como PATCHES por id
//      (createPatcher do nativeAdapter da home);
//   2. hospeda header (1º filho, rola junto) e rodapé (2º filho);
//   3. traduz os eventos nativos para os handlers existentes.
// Qualquer erro (render ou onNativeError) → onFailure() e a tela volta para a
// FlatList JS na hora. Desligar por OTA: globalThis.__chatyy_native_channels = false.

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNativeHeaderTouchGuard } from '../native/nativeHeaderTouchGuard'; // [2026-10-17 settings-scroll-tap]
import { Platform, StyleSheet, View } from 'react-native';
import { getNativeChannelListView, getNativeChannelFeedView } from '../../modules/expo-chat-conversation-list';
import { createPatcher, initialsOf, gradientIndex } from '../chatlist/nativeAdapter';

const KILL = '__chatyy_native_channels';
const FAILED = '__chatyy_native_channels_failed';

/** Pode usar a lista nativa? (binário com a view, sem kill switch, sem falha). */
export function nativeChannelsEnabled(kind = 'list') {
  if (Platform.OS === 'web') return false;
  try { if (globalThis[KILL] === false || globalThis[FAILED]) return false; } catch {}
  try {
    return !!(kind === 'feed' ? getNativeChannelFeedView() : getNativeChannelListView());
  } catch { return false; }
}

/** Marca a falha (sessão inteira volta ao JS) e reporta. */
export function markNativeChannelsFailed(msg) {
  try {
    globalThis[FAILED] = true;
    console.warn('[native-channels] fallback JS:', msg);
    try { require('../../services/crashReporter').reportNativeFallback('native_channels', String(msg || '')); } catch {}
  } catch {}
}

function _lazy(fn) {
  let v; let done = false;
  return () => { if (!done) { done = true; try { v = fn(); } catch { v = null; } } return v; };
}
const _api = _lazy(() => require('../../services/api'));

/** Avatar do canal no formato plano do nativo (tu/ti/tg). */
export function channelTile(item) {
  const name = String(item?.name || '');
  const raw = String(item?.photo_url || item?.avatar || '');
  let u = raw;
  try { if (u && u.startsWith('/') && _api()?.getMediaUrl) u = _api().getMediaUrl(u) || u; } catch {}
  return { tu: u, ti: initialsOf(name, ''), tg: gradientIndex(name || String(item?.id || '')) };
}

/** URL absoluta de mídia (o nativo não resolve caminho relativo). */
export function absMedia(u) {
  const s = String(u || '');
  if (!s) return '';
  try { if (s.startsWith('/') && _api()?.getMediaUrl) return _api().getMediaUrl(s) || s; } catch {}
  return s;
}

class Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    try { this.props.onFailure?.(String(error?.message || error)); } catch {}
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

function Inner(props) {
  const {
    kind, rows, header, footer, isDark, palette, labels, quickReactions,
    refreshing, bottomInset = 0, style,
  } = props;
  const Native = kind === 'feed' ? getNativeChannelFeedView() : getNativeChannelListView();

  const patcherRef = useRef(null);
  const headerTouchGuard = useNativeHeaderTouchGuard();
  const footerTouchGuard = useNativeHeaderTouchGuard();
  if (!patcherRef.current) patcherRef.current = createPatcher();
  const [resyncToken, setResyncToken] = useState(0);

  const { patch, snapshot } = useMemo(
    () => patcherRef.current.diff(Array.isArray(rows) ? rows : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, resyncToken]
  );
  useLayoutEffect(() => { patcherRef.current.commit(snapshot); }, [snapshot]);

  const [headerH, setHeaderH] = useState(0);
  const [footerH, setFooterH] = useState(0);
  const onHeaderLayout = useCallback((e) => {
    const h = Math.round(e?.nativeEvent?.layout?.height || 0);
    setHeaderH(prev => (prev === h ? prev : h));
  }, []);
  const onFooterLayout = useCallback((e) => {
    const h = Math.round(e?.nativeEvent?.layout?.height || 0);
    setFooterH(prev => (prev === h ? prev : h));
  }, []);

  let authToken = '';
  try { authToken = (_api()?.getAuthToken && _api().getAuthToken()) || ''; } catch {}

  const propsRef = useRef(props);
  propsRef.current = props;

  const handlers = useMemo(() => {
    const ev = (e) => (e?.nativeEvent ?? e) || {};
    return {
      onRowPress: (e) => { try { propsRef.current.onRowPress?.(String(ev(e).id || '')); } catch {} },
      onRowAction: (e) => {
        const n = ev(e);
        try { propsRef.current.onRowAction?.(String(n.id || ''), String(n.action || ''), n); } catch {}
      },
      onRefresh: () => { try { propsRef.current.onRefresh?.(); } catch {} },
      onEndReached: () => { try { propsRef.current.onEndReached?.(); } catch {} },
      onResync: () => {
        patcherRef.current.requestReset();
        setResyncToken(v => v + 1);
      },
      onFirstPaint: () => {},
      onNativeError: (e) => {
        const msg = String(ev(e).message || 'native error');
        try { propsRef.current.onFailure?.(msg); } catch {}
      },
    };
  }, []);

  if (!Native) return null;
  return (
    <Native
      style={style || styles.fill}
      rowsPatch={patch}
      dark={!!isDark}
      labels={labels}
      palette={palette}
      authToken={authToken}
      headerHeight={headerH}
      footerHeight={footerH}
      bottomInset={bottomInset || 0}
      refreshing={!!refreshing}
      refreshTint={isDark ? '#F5F5F7' : '#111111'}
      {...(kind === 'feed' ? { quickReactions: quickReactions || [] } : null)}
      {...handlers}
    >
      <View collapsable={false} style={styles.slot} onLayout={onHeaderLayout} {...headerTouchGuard}>
        {header || null}
      </View>
      <View collapsable={false} style={styles.slot} onLayout={onFooterLayout} {...footerTouchGuard}>
        {footer || null}
      </View>
    </Native>
  );
}

/**
 * Lista de canais (Seguindo = linhas, Descobrir = cartões).
 * props: rows, header?, footer?, isDark, palette, labels, refreshing,
 *        onRowPress(id), onRowAction(id, action, ev), onRefresh, onEndReached,
 *        onFailure(msg)
 */
export default function NativeChannelList(props) {
  return (
    <Boundary onFailure={props.onFailure}>
      <Inner {...props} kind="list" />
    </Boundary>
  );
}

/** Mesmo wrapper com a view de posts (usado por NativeChannelFeed.js). */
export function NativeChannelSurface(props) {
  return (
    <Boundary onFailure={props.onFailure}>
      <Inner {...props} />
    </Boundary>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  slot: { position: 'absolute', top: 0, left: 0, right: 0 },
});
