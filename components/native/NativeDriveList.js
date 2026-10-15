// components/native/NativeDriveList.js — [2026-10-15 native-drive]
//
// Lista/grade de ARQUIVOS em NATIVO (modules/expo-chat-conversation-list → view
// ChatyyDriveList): UICollectionView (lista com swipe / grade compositional) e
// RecyclerView (Linear/Grid + ItemTouchHelper). Ícone por tipo, miniaturas com
// cache em disco, seleção múltipla (selectionMode + selectedIds controlados
// pela tela), toque longo com prévia + menu (UIContextMenu / PopupMenu), barra
// de envio com progresso (prop `uploads`), puxar p/ atualizar e fim da lista.
// Usada por app/drive.js e app/files.js.
//
// A tela continua dona dos dados e das ações: monta `rows` (driveListAdapter)
// e recebe eventos por id: onPress(id), onAction(id, action, source)
// (action = open | download | share | rename | move | star | delete | restore |
// purge | more), onLongPress(id) (linha sem menu), onRefresh(), onEndReached().
// Qualquer erro (render ou onNativeError) → onFailure(msg) e a tela volta para
// a lista JS na hora (e marca globalThis.__chatyy_native_drive_failed).
//
// Desligar (OTA/console): globalThis.__chatyy_native_drive = false

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { getNativeDriveListView } from '../../modules/expo-chat-conversation-list';
import { createPatcher } from '../chatlist/nativeAdapter';
import { driveColors, driveUploads } from './driveListAdapter';

export const DRIVE_KILL_SWITCH = '__chatyy_native_drive';

class NativeDriveBoundary extends React.Component {
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
export function nativeDriveEnabled() {
  try {
    if (Platform.OS === 'web') return false;
    if (globalThis[DRIVE_KILL_SWITCH] === false) return false;
    if (globalThis[`${DRIVE_KILL_SWITCH}_failed`]) return false;
    return !!getNativeDriveListView();
  } catch { return false; }
}

function markNativeDriveFailed(msg) {
  try {
    globalThis[`${DRIVE_KILL_SWITCH}_failed`] = true;
    console.warn('[native_drive] fallback JS:', msg);
    try { require('../../services/crashReporter').reportNativeFallback('native_drive', msg); } catch {}
  } catch {}
}

/** Hook: [ligado, onFailure] com queda para JS na 1ª falha. */
export function useNativeDrive() {
  const [failed, setFailed] = useState(() => {
    try { return !!globalThis[`${DRIVE_KILL_SWITCH}_failed`]; } catch { return false; }
  });
  const enabled = !failed && nativeDriveEnabled();
  const onFailure = useCallback((msg) => {
    markNativeDriveFailed(msg);
    setFailed(true);
  }, []);
  return [enabled, onFailure];
}

const EMPTY = [];

function NativeDriveListInner(props) {
  const {
    rows, mode = 'list', columns = 0, selectionMode = false, selectedIds = EMPTY,
    uploads = EMPTY, labels, highlight = '', colors, isDark,
    refreshEnabled = true, refreshing = false, topInset = 0, bottomInset = 0,
    scrollToTopSeq = 0, authToken, autoInset = false, style,
  } = props;
  const Native = getNativeDriveListView();
  let token = authToken || '';
  if (!token) { try { const a = require('../../services/api'); token = (a.getAuthToken && a.getAuthToken()) || ''; } catch {} }

  const patcherRef = useRef(null);
  if (!patcherRef.current) patcherRef.current = createPatcher();
  const [resyncToken, setResyncToken] = useState(0);

  const safeRows = Array.isArray(rows) ? rows : EMPTY;
  const { patch, snapshot } = useMemo(
    () => patcherRef.current.diff(safeRows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [safeRows, resyncToken]
  );
  useLayoutEffect(() => {
    patcherRef.current.commit(snapshot);
  }, [snapshot]);

  const nColors = useMemo(() => driveColors(colors, isDark), [colors, isDark]);
  const nUploads = useMemo(() => driveUploads(uploads), [uploads]);
  const selKey = Array.isArray(selectedIds) ? selectedIds.join('\u0001') : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nSelected = useMemo(() => (Array.isArray(selectedIds) ? selectedIds.map(String) : EMPTY), [selKey]);

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
      onLongPress: (e) => {
        const id = idOf(e); if (!id) return;
        try { propsRef.current.onLongPress?.(id); } catch {}
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
      mode={mode === 'grid' ? 'grid' : 'list'}
      columns={Number(columns) || 0}
      selectionMode={!!selectionMode}
      selectedIds={nSelected}
      uploads={nUploads}
      labels={labels || {}}
      highlight={String(highlight || '')}
      colors={nColors}
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

export default function NativeDriveList(props) {
  return (
    <NativeDriveBoundary onFailure={props.onFailure}>
      <NativeDriveListInner {...props} />
    </NativeDriveBoundary>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
