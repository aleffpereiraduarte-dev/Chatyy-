// components/native/NativeNotesList.js — [2026-10-15 native-notes]
//
// Lista/grade de NOTAS em NATIVO (modules/expo-chat-conversation-list → view
// ChatyyNotesList): UICollectionView compositional / RecyclerView+Grid com
// cards P&B, seção Fixadas, swipe Apagar/Fixar, menu no toque longo (com
// prévia no iOS), puxar p/ atualizar e destaque do termo buscado.
// A tela (app/notes.js) continua dona dos dados e das ações: monta `rows`
// (notesListAdapter.buildNoteRows) e recebe onPress(rowId) e
// onAction(rowId, action, source) — action = delete | pin | archive | edit |
// color | email | pdf | copy. Qualquer erro → onFailure(msg) e a tela volta
// para a FlatList JS na hora (marca globalThis.__chatyy_native_notes_failed).
//
// Desligar (OTA/console): globalThis.__chatyy_native_notes = false

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { getNativeNotesListView } from '../../modules/expo-chat-conversation-list';
import { createPatcher } from '../chatlist/nativeAdapter';
import { notesColors } from './notesListAdapter';

export const NOTES_KILL_SWITCH = '__chatyy_native_notes';

class NativeNotesBoundary extends React.Component {
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
export function nativeNotesEnabled() {
  try {
    if (Platform.OS === 'web') return false;
    if (globalThis[NOTES_KILL_SWITCH] === false) return false;
    if (globalThis[`${NOTES_KILL_SWITCH}_failed`]) return false;
    return !!getNativeNotesListView();
  } catch { return false; }
}

function markFailed(msg) {
  try {
    globalThis[`${NOTES_KILL_SWITCH}_failed`] = true;
    console.warn('[native_notes] fallback JS:', msg);
    try { require('../../services/crashReporter').reportNativeFallback('native_notes', msg); } catch {}
  } catch {}
}

/** Hook: [ligado, onFailure] com queda para a FlatList JS na 1ª falha. */
export function useNativeNotes() {
  const [failed, setFailed] = useState(() => {
    try { return !!globalThis[`${NOTES_KILL_SWITCH}_failed`]; } catch { return false; }
  });
  const enabled = !failed && nativeNotesEnabled();
  const onFailure = useCallback((msg) => {
    markFailed(msg);
    setFailed(true);
  }, []);
  return [enabled, onFailure];
}

function NativeNotesListInner(props) {
  const {
    rows, highlight = '', colors, isDark, layoutMode = 'list', labels, menu,
    swipeEnabled = true, menuEnabled = true, refreshEnabled = true, refreshing = false,
    topInset = 0, bottomInset = 0, scrollToTopSeq = 0, autoInset = false, style,
  } = props;
  const Native = getNativeNotesListView();

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

  const nColors = useMemo(() => notesColors(colors, isDark), [colors, isDark]);

  const propsRef = useRef(props);
  propsRef.current = props;

  const handlers = useMemo(() => ({
    onRowPress: (e) => {
      const id = String((e?.nativeEvent ?? e)?.id ?? ''); if (!id) return;
      try { propsRef.current.onPress?.(id); } catch {}
    },
    onRowAction: (e) => {
      const ev = e?.nativeEvent ?? e;
      const id = String(ev?.id ?? ''); if (!id) return;
      try { propsRef.current.onAction?.(id, String(ev?.action || ''), String(ev?.source || '')); } catch {}
    },
    onRefresh: () => { try { propsRef.current.onRefresh?.(); } catch {} },
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
  }), []);

  if (!Native) return null;
  return (
    <Native
      style={[styles.fill, style]}
      rowsPatch={patch}
      colors={nColors}
      highlight={String(highlight || '')}
      layoutMode={layoutMode === 'grid' ? 'grid' : 'list'}
      labels={labels || {}}
      menu={Array.isArray(menu) ? menu : []}
      swipeEnabled={!!swipeEnabled}
      menuEnabled={!!menuEnabled}
      refreshEnabled={!!refreshEnabled}
      refreshing={!!refreshing}
      topInset={topInset || 0}
      bottomInset={bottomInset || 0}
      scrollToTopSeq={scrollToTopSeq || 0}
      autoInset={!!autoInset}
      {...handlers}
    />
  );
}

export default function NativeNotesList(props) {
  return (
    <NativeNotesBoundary onFailure={props.onFailure}>
      <NativeNotesListInner {...props} />
    </NativeNotesBoundary>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
