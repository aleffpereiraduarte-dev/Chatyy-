// components/contacts/NativeContactList.js — [2026-10-15 native-contacts]
//
// Lista de CONTATOS em NATIVO (modules/expo-chat-conversation-list → view
// ChatyyContactList): seções fixas, índice A–Z lateral com haptic, swipe
// "Apagar", puxar p/ atualizar. Usada por app/contacts.js ("Meus contatos") e
// app/chat-new.js (lista padrão). A tela continua dona dos dados e das ações:
//   - monta `rows`/`meta` com contactListAdapter.buildFlatRows;
//   - hospeda o header (1º filho RN, rola junto) e o rodapé (2º filho);
//   - recebe os eventos já resolvidos para o item: onPress(item), onLongPress(item),
//     onAction(action, item, source).
// Qualquer erro (render ou onNativeError) → onFailure() e a tela volta para a
// SectionList JS na hora.
//
// Desligar (OTA): globalThis.__chatyy_native_contacts = false

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { getNativeContactListView } from '../../modules/expo-chat-conversation-list';
import { createPatcher } from '../chatlist/nativeAdapter';
import { nativeColors } from './contactListAdapter';

class NativeContactBoundary extends React.Component {
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
export function nativeContactsEnabled() {
  try {
    if (globalThis.__chatyy_native_contacts === false) return false;
    if (globalThis.__chatyy_native_contacts_failed) return false;
    return !!getNativeContactListView();
  } catch { return false; }
}

function NativeContactListInner(props) {
  const {
    rows, meta, header, footer, empty, colors, metrics,
    indexEnabled = true, indexMin = 6, refreshEnabled = false, refreshing = false,
    swipeEnabled = true, bottomInset = 0, scrollToTopSeq = 0, style,
  } = props;
  const Native = getNativeContactListView();

  const patcherRef = useRef(null);
  if (!patcherRef.current) patcherRef.current = createPatcher();
  const [resyncToken, setResyncToken] = useState(0);

  const safeRows = Array.isArray(rows) ? rows : [];
  const { patch, snapshot } = useMemo(
    () => patcherRef.current.diff(safeRows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [safeRows, resyncToken]
  );
  const metaRef = useRef(meta);
  useLayoutEffect(() => {
    patcherRef.current.commit(snapshot);
    metaRef.current = meta;
  }, [snapshot, meta]);

  const nColors = useMemo(() => nativeColors(colors || {}), [colors]);

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

  const propsRef = useRef(props);
  propsRef.current = props;

  const handlers = useMemo(() => {
    const entryOf = (e) => {
      const ev = e?.nativeEvent ?? e;
      const id = String(ev?.id ?? '');
      const m = (metaRef.current && metaRef.current.get) ? metaRef.current.get(id) : null;
      return m && m.item ? { ...m, id, ev } : null;
    };
    return {
      onRowPress: (e) => {
        const m = entryOf(e); if (!m) return;
        try { propsRef.current.onPress?.(m.item, m.id); } catch {}
      },
      onRowLongPress: (e) => {
        const m = entryOf(e); if (!m) return;
        try { propsRef.current.onLongPress?.(m.item, m.id); } catch {}
      },
      onRowAction: (e) => {
        const m = entryOf(e); if (!m) return;
        try { propsRef.current.onAction?.(String(m.ev?.action || ''), m.item, String(m.ev?.source || '')); } catch {}
      },
      onRefresh: () => {
        try { propsRef.current.onRefresh?.(); } catch {}
      },
      onEndReached: () => {
        try { propsRef.current.onEndReached?.(); } catch {}
      },
      onResync: () => {
        patcherRef.current.requestReset();
        setResyncToken(v => v + 1);
      },
      onFirstPaint: () => {
        try { propsRef.current.onFirstPaint?.(); } catch {}
      },
      onNativeError: (e) => {
        const msg = String((e?.nativeEvent ?? e)?.message || 'native error');
        try { globalThis.__chatyyNativeContactsError = { at: Date.now(), msg }; } catch {}
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
      metrics={metrics || {}}
      indexEnabled={!!indexEnabled}
      indexMin={indexMin}
      refreshEnabled={!!refreshEnabled}
      refreshing={!!refreshing}
      swipeEnabled={!!swipeEnabled}
      headerHeight={headerH}
      footerHeight={footerH}
      bottomInset={bottomInset || 0}
      scrollToTopSeq={scrollToTopSeq}
      {...handlers}
    >
      <View collapsable={false} style={styles.slot} onLayout={onHeaderLayout}>
        {header}
        {safeRows.length === 0 ? empty : null}
      </View>
      <View collapsable={false} style={styles.slot} onLayout={onFooterLayout}>
        {footer}
      </View>
    </Native>
  );
}

export default function NativeContactList(props) {
  return (
    <NativeContactBoundary onFailure={props.onFailure}>
      <NativeContactListInner {...props} />
    </NativeContactBoundary>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  slot: { position: 'absolute', top: 0, left: 0, right: 0 },
});
