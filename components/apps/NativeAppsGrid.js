// components/apps/NativeAppsGrid.js — [2026-10-18 native-apps-grid]
//
// Painel "Apps" em NATIVO (modules/expo-chat-conversation-list → view
// ChatyyAppsGrid): iOS UICollectionView compositional + diffable, Android
// RecyclerView + GridLayoutManager. [2026-10-18 apps-compact] api 2 = grade
// única compacta estilo Outlook (ladrilho 48, sem Bia hero/Recentes/editar;
// cabeçalho só p/ seção com título). Binário api 1 (layout antigo) → grade JS.
//
// O AppsSheet continua dono das rotas e da folha (Modal + cabeçalho).
// Eventos chegam por id:
//   onAppPress(id, voice) · onEditingChange(bool) · onPinnedChange(ids)
//   onContentHeight(h) · onPullDismiss()
// Erro de render/onNativeError → onFailure(msg) e o AppsSheet volta ao JS
// (marca globalThis.__chatyy_native_apps_failed p/ a sessão).
//
// Desligar (OTA/console): globalThis.__chatyy_native_apps = false

import React, { useCallback } from 'react';
import { Platform } from 'react-native';
import { getNativeAppsGridView, appsGridApiVersion } from '../../modules/expo-chat-conversation-list';

const KILL = '__chatyy_native_apps';

/** Liga o painel nativo? (binário com a view api ≥ 2 + kill switch + não falhou na sessão). */
export function nativeAppsEnabled() {
  if (Platform.OS === 'web') return false;
  try {
    if (globalThis[KILL] === false) return false;
    if (globalThis[`${KILL}_failed`]) return false;
    if (appsGridApiVersion() < 2) return false; // api 1 = layout antigo (Bia/Recentes) → JS
    return !!getNativeAppsGridView();
  } catch { return false; }
}

export function markNativeAppsFailed(msg) {
  try {
    globalThis[`${KILL}_failed`] = true;
    console.warn('[native_apps] fallback JS:', msg);
    try { require('../../services/crashReporter').reportNativeFallback('native_apps', msg); } catch {} // eslint-disable-line global-require
  } catch {}
}

class NativeAppsBoundary extends React.Component {
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

function NativeAppsGridInner(props) {
  const {
    sections, recent, pinned, badges, labels, isDark, editing, bottomInset = 0,
    resetSeq = 0, searchEnabled = true, style,
    onAppPress, onEditingChange, onPinnedChange, onQueryChange, onContentHeight, onPullDismiss, onFailure,
  } = props;
  const Native = getNativeAppsGridView();

  const _press = useCallback((e) => {
    const ev = e?.nativeEvent || {};
    const id = typeof ev.id === 'string' ? ev.id : '';
    if (id) onAppPress?.(id, !!ev.voice);
  }, [onAppPress]);
  const _editing = useCallback((e) => { onEditingChange?.(!!e?.nativeEvent?.editing); }, [onEditingChange]);
  const _pinned = useCallback((e) => {
    const ids = e?.nativeEvent?.ids;
    if (Array.isArray(ids)) onPinnedChange?.(ids.filter((k) => typeof k === 'string'));
  }, [onPinnedChange]);
  const _query = useCallback((e) => { onQueryChange?.(String(e?.nativeEvent?.q || '')); }, [onQueryChange]);
  const _height = useCallback((e) => {
    const h = Number(e?.nativeEvent?.height);
    if (Number.isFinite(h) && h > 0) onContentHeight?.(h);
  }, [onContentHeight]);
  const _pull = useCallback(() => { onPullDismiss?.(); }, [onPullDismiss]);
  const _err = useCallback((e) => { onFailure?.(String(e?.nativeEvent?.message || 'native error')); }, [onFailure]);

  if (!Native) return null;
  return (
    <Native
      style={style}
      sections={sections || []}
      recent={Array.isArray(recent) ? recent : []}
      pinned={Array.isArray(pinned) ? pinned : []}
      badges={badges || {}}
      labels={labels || {}}
      dark={!!isDark}
      editing={!!editing}
      bottomInset={bottomInset}
      resetSeq={resetSeq}
      searchEnabled={!!searchEnabled}
      onAppPress={_press}
      onEditingChange={_editing}
      onPinnedChange={_pinned}
      onQueryChange={_query}
      onContentHeight={_height}
      onPullDismiss={_pull}
      onNativeError={_err}
    />
  );
}

export default function NativeAppsGrid(props) {
  return (
    <NativeAppsBoundary onFailure={props.onFailure}>
      <NativeAppsGridInner {...props} />
    </NativeAppsBoundary>
  );
}
