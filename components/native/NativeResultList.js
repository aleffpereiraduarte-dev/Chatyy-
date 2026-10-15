// components/native/NativeResultList.js — [2026-10-15 native-search-notifs]
//
// Lista de RESULTADOS em NATIVO (modules/expo-chat-conversation-list → view
// ChatyyResultList): UICollectionView / RecyclerView com seções, destaque do
// termo (NSAttributedString / spans, sem caixa/acento), swipe "Apagar",
// botões inline, puxar p/ atualizar e fim da lista. Usada pela busca global
// (components/GlobalSearch.js, app/search.js) e pela central de notificações
// (app/notifications.js, components/NotificationsHub.js, app/notifications-feed.js).
//
// A tela continua dona dos dados e das ações: monta `rows` (resultListAdapter)
// e recebe eventos por id: onPress(id), onAction(id, action, source)
// (action = b1 | b2 | delete | section), onRefresh(), onEndReached().
// Qualquer erro (render ou onNativeError) → onFailure(msg) e a tela volta para
// a lista JS na hora (e marca globalThis[<killSwitch>_failed] p/ a sessão).
//
// Desligar (OTA/console): globalThis.__chatyy_native_search = false
//                         globalThis.__chatyy_native_notifs = false

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { getNativeResultListView } from '../../modules/expo-chat-conversation-list';
import { createPatcher } from '../chatlist/nativeAdapter';
import { resultColors } from './resultListAdapter';

class NativeResultBoundary extends React.Component {
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

/** Liga a lista nativa? (binário com a view + kill switch + não falhou nesta sessão). */
export function nativeResultsEnabled(killSwitch) {
  try {
    const k = String(killSwitch || '');
    if (k && globalThis[k] === false) return false;
    if (k && globalThis[`${k}_failed`]) return false;
    return !!getNativeResultListView();
  } catch { return false; }
}

/** Marca a falha da sessão (a tela troca para a lista JS) e reporta. */
export function markNativeResultsFailed(killSwitch, msg) {
  try {
    const k = String(killSwitch || '');
    if (k) globalThis[`${k}_failed`] = true;
    console.warn(`[${k.replace(/^__chatyy_/, '')}] fallback JS:`, msg);
    try { require('../../services/crashReporter').reportNativeFallback(k.replace(/^__chatyy_/, ''), msg); } catch {}
  } catch {}
}

function NativeResultListInner(props) {
  const {
    rows, highlight = '', colors, isDark, separators = false, swipeEnabled = true,
    refreshEnabled = false, refreshing = false, topInset = 0, bottomInset = 0,
    scrollToTopSeq = 0, authToken, autoInset = false, style,
  } = props;
  const Native = getNativeResultListView();
  let token = authToken || '';
  if (!token) { try { const a = require('../../services/api'); token = (a.getAuthToken && a.getAuthToken()) || ''; } catch {} }

  const patcherRef = useRef(null);
  if (!patcherRef.current) patcherRef.current = createPatcher();
  const [resyncToken, setResyncToken] = useState(0);

  const safeRows = Array.isArray(rows) ? rows : [];
  const { patch, snapshot } = useMemo(
    () => patcherRef.current.diff(safeRows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [safeRows, resyncToken]
  );
  useLayoutEffect(() => {
    patcherRef.current.commit(snapshot);
  }, [snapshot]);

  const nColors = useMemo(() => resultColors(colors, isDark), [colors, isDark]);

  const propsRef = useRef(props);
  propsRef.current = props;

  const handlers = useMemo(() => {
    const idOf = (e) => String((e?.nativeEvent ?? e)?.id ?? '');
    return {
      onRowPress: (e) => {
        const id = idOf(e); if (!id) return;
        try { propsRef.current.onPress?.(id); } catch {}
      },
      onRowAction: (e) => {
        const ev = e?.nativeEvent ?? e;
        const id = String(ev?.id ?? ''); if (!id) return;
        try { propsRef.current.onAction?.(id, String(ev?.action || ''), String(ev?.source || '')); } catch {}
      },
      onRefresh: () => { try { propsRef.current.onRefresh?.(); } catch {} },
      onEndReached: () => { try { propsRef.current.onEndReached?.(); } catch {} },
      onResync: () => {
        patcherRef.current.requestReset();
        setResyncToken((v) => v + 1);
      },
      onFirstPaint: (e) => {
        try { propsRef.current.onFirstPaint?.(Number((e?.nativeEvent ?? e)?.count) || 0); } catch {}
      },
      onNativeError: (e) => {
        const msg = String((e?.nativeEvent ?? e)?.message || 'native error');
        try { propsRef.current.onFailure?.(msg); } catch {}
      },
    };
  }, []);

  if (!Native) return null;
  return (
    <Native
      style={[styles.fill, style]}
      rowsPatch={patch}
      colors={nColors}
      highlight={String(highlight || '')}
      separators={!!separators}
      swipeEnabled={!!swipeEnabled}
      refreshEnabled={!!refreshEnabled}
      refreshing={!!refreshing}
      topInset={topInset || 0}
      bottomInset={bottomInset || 0}
      scrollToTopSeq={scrollToTopSeq || 0}
      authToken={token}
      autoInset={!!autoInset}
      {...handlers}
    />
  );
}

export default function NativeResultList(props) {
  return (
    <NativeResultBoundary onFailure={props.onFailure}>
      <NativeResultListInner {...props} />
    </NativeResultBoundary>
  );
}

/** Hook: estado "nativo ligado" com queda para JS na 1ª falha. */
export function useNativeResults(killSwitch) {
  const [failed, setFailed] = useState(() => {
    try { return !!globalThis[`${killSwitch}_failed`]; } catch { return false; }
  });
  const enabled = !failed && nativeResultsEnabled(killSwitch);
  const onFailure = useCallback((msg) => {
    markNativeResultsFailed(killSwitch, msg);
    setFailed(true);
  }, [killSwitch]);
  return [enabled, onFailure];
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
