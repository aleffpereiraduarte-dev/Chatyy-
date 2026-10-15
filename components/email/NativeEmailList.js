// components/email/NativeEmailList.js — [2026-10-15 native-inbox]
//
// Caixa de entrada do e-mail em NATIVO (modules/expo-chat-conversation-list,
// view ChatyyEmailList: iOS UICollectionView + diffable, Android RecyclerView +
// DiffUtil). O EmailList continua dono dos dados, do cabeçalho/barra de
// seleção, do estado vazio e de TODAS as ações; aqui só:
//   1. normaliza os itens (emailNativeAdapter.buildEmailRow) e manda PATCHES;
//   2. traduz os eventos nativos para os mesmos handlers do EmailRow
//      (abrir, selecionar, estrela, arquivar, excluir, adiar, menu de contexto).
// Qualquer erro (render ou onNativeError) → onFailure() e o EmailList volta
// para a FlashList JS na hora.
//
// Desligar (OTA): globalThis.__chatyy_native_inbox = false

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { getNativeEmailListView } from '../../modules/expo-chat-conversation-list';
import { createPatcher } from '../chatlist/nativeAdapter';
import { buildEmailRow, buildLabels, buildPalette, emailRowEqual, bodyTextFromCached } from './emailNativeAdapter';
import { cleanPreview, formatRelativeDate } from '../EmailRow';
import { LABEL_COLORS } from '../LabelPicker';

class NativeEmailBoundary extends React.Component {
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

function _lazy(fn) {
  let v; let done = false;
  return () => { if (!done) { done = true; try { v = fn(); } catch { v = null; } } return v; };
}
const _avatarSvc = _lazy(() => require('../../services/avatar'));
const _avatarCache = _lazy(() => require('../../services/avatarCache'));
const _api = _lazy(() => require('../../services/api'));
const _offline = _lazy(() => require('../../services/offlineCache'));

function _haptic(kind) {
  try {
    const H = require('expo-haptics');
    if (kind === 'light') H.impactAsync(H.ImpactFeedbackStyle.Light).catch(() => {});
    else if (kind === 'warn') H.notificationAsync(H.NotificationFeedbackType.Warning).catch(() => {});
    else H.impactAsync(H.ImpactFeedbackStyle.Medium).catch(() => {});
  } catch {}
}

function NativeEmailListInner(props) {
  const {
    data, colors, isDark, t, language, densityConfig,
    selectMode, selectedUids, selectedUid, currentFolder, mutedUids,
    refreshing, loadingMore, bottomInset = 0, spacing,
  } = props;
  const Native = getNativeEmailListView();

  const patcherRef = useRef(null);
  if (!patcherRef.current) patcherRef.current = createPatcher();
  const [resyncToken, setResyncToken] = useState(0);
  const rowCacheRef = useRef(new Map());
  const itemsRef = useRef(new Map());

  const ctx = useMemo(() => {
    const av = _avatarSvc() || {};
    const ac = _avatarCache() || {};
    return {
      t, language, currentFolder, selectedUids, selectedUid, mutedUids,
      cleanPreview, formatRelativeDate, LABEL_COLORS,
      buildAvatarUrl: av.buildAvatarUrl,
      avatarAuthHeaders: av.avatarAuthHeaders,
      getCachedAvatarUriOrNull: ac.getCachedAvatarUriOrNull,
    };
  }, [t, language, currentFolder, selectedUids, selectedUid, mutedUids]);

  const built = useMemo(() => {
    const rows = [];
    const items = new Map();
    const prevCache = rowCacheRef.current;
    const nextCache = new Map();
    const list = Array.isArray(data) ? data : [];
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (!it) continue;
      let row;
      try { row = buildEmailRow(it, i, ctx); } catch { continue; }
      if (!row || items.has(row.id)) continue;
      const prev = prevCache.get(row.id);
      if (prev && emailRowEqual(prev, row)) row = prev; // mesmo objeto → sem upsert
      nextCache.set(row.id, row);
      items.set(row.id, it);
      rows.push(row);
    }
    return { rows, items, cache: nextCache };
  }, [data, ctx]);

  const { patch, snapshot } = useMemo(
    () => patcherRef.current.diff(built.rows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [built, resyncToken]
  );
  useLayoutEffect(() => {
    patcherRef.current.commit(snapshot);
    rowCacheRef.current = built.cache;
    itemsRef.current = built.items;
  }, [snapshot, built]);

  const labels = useMemo(() => buildLabels(t), [t]);
  const palette = useMemo(() => buildPalette(colors), [colors]);
  const density = useMemo(() => {
    const dc = densityConfig || {};
    const sp = spacing || {};
    return {
      padV: (Number(dc.paddingV) || 7) + 3,
      minH: Number(dc.rowMinHeight) || 54,
      avatar: Math.min(44, Number(dc.avatarSize) || 38),
      preview: dc.showPreview !== false,
      padH: (Number(sp.lg) || 11) + 2,
      gap: (Number(sp.md) || 8) + 2,
    };
  }, [densityConfig, spacing]);

  let authToken = '';
  try { authToken = (_api()?.getAuthToken && _api().getAuthToken()) || ''; } catch {}

  const [peek, setPeek] = useState(null);

  const propsRef = useRef(props);
  propsRef.current = props;

  // Rede da prévia: só a 1ª vez por montagem por e-mail.
  const peekBusyRef = useRef('');

  const handlers = useMemo(() => {
    const emailOf = (e) => {
      const ev = e?.nativeEvent ?? e;
      const id = String(ev?.id ?? '');
      const it = itemsRef.current.get(id);
      return it && !it._sectionHeader ? it : null;
    };
    const openPeek = async (email) => {
      const id = email.uid != null ? String(email.uid) : '';
      if (!id || peekBusyRef.current === id) return;
      peekBusyRef.current = id;
      try {
        const off = _offline();
        const folder = propsRef.current.currentFolder || 'INBOX';
        let m = off?.getMessageFromCacheSync ? off.getMessageFromCacheSync(email.uid, folder) : null;
        if (!m && off?.getMessageFromCache) m = await off.getMessageFromCache(email.uid, folder);
        const body = bodyTextFromCached(m);
        if (body) setPeek({ id, body });
      } catch {}
      finally { if (peekBusyRef.current === id) peekBusyRef.current = ''; }
    };
    return {
      onRowPress: (e) => {
        const em = emailOf(e); if (!em) return;
        try { propsRef.current.onEmailPress?.(em); } catch {}
      },
      onLeftPress: (e) => {
        const em = emailOf(e); if (!em) return;
        try { propsRef.current.onToggleSelect?.(em.uid); } catch {}
      },
      onStarPress: (e) => {
        const em = emailOf(e); if (!em) return;
        try { propsRef.current.onStar?.(em); } catch {}
      },
      onRowAction: (e) => {
        const em = emailOf(e); if (!em) return;
        const ev = e?.nativeEvent ?? e;
        const action = String(ev?.action || '');
        const p = propsRef.current;
        try {
          if (ev?.source === 'swipe' || ev?.source === 'a11y') {
            // Mesmo caminho do SwipeableRow / botões de hover do EmailRow.
            if (action === 'archive') { _haptic('medium'); p.onArchiveEmail?.(em); return; }
            if (action === 'delete') { _haptic('warn'); p.onDeleteEmail?.(em); return; }
            if (action === 'snooze') { p.onSnoozeEmail?.(em); return; }
            if (action === 'star') { _haptic('light'); p.onStar?.(em); return; }
            if (action === 'select') { p.onToggleSelect?.(em.uid); return; }
            return;
          }
          if (action === 'select') { p.onToggleSelect?.(em.uid); return; }
          // Menu nativo → mesmo despacho do NativeContextMenu do EmailRow.
          p.onContextMenu?.(em, { x: 0, y: 0, nativeAction: action });
        } catch {}
      },
      onLongPress: (e) => {
        const em = emailOf(e); if (!em) return;
        const p = propsRef.current;
        try {
          if (p.selectMode) p.onToggleSelect?.(em.uid);
          else p.onContextMenu?.(em, { x: 0, y: 0 });
        } catch {}
      },
      onPeekRequest: (e) => {
        const em = emailOf(e); if (!em) return;
        openPeek(em);
      },
      onPeekOpen: (e) => {
        const em = emailOf(e); if (!em) return;
        try { propsRef.current.onEmailPress?.(em); } catch {}
      },
      onRefresh: () => {
        try { propsRef.current.onRefresh?.(); } catch {}
      },
      onEndReached: () => {
        try { propsRef.current.onEndReached?.(); } catch {}
      },
      onVisibleIds: (e) => {
        const ids = (e?.nativeEvent ?? e)?.ids;
        if (!Array.isArray(ids)) return;
        try { propsRef.current.onVisibleEmails?.(ids.map(id => itemsRef.current.get(String(id))).filter(Boolean)); } catch {}
      },
      onResync: () => {
        patcherRef.current.requestReset();
        setResyncToken(v => v + 1);
      },
      onFirstPaint: () => {},
      onNativeError: (e) => {
        const msg = String((e?.nativeEvent ?? e)?.message || 'native error');
        try { globalThis.__chatyyNativeInboxError = { at: Date.now(), msg }; } catch {}
        try { propsRef.current.onFailure?.(msg); } catch {}
      },
    };
  }, []);

  // Troca de pasta: volta ao topo (a lista é a mesma view).
  const [topSeq, setTopSeq] = useState(0);
  const folderRef = useRef(currentFolder);
  useEffect(() => {
    if (folderRef.current !== currentFolder) {
      folderRef.current = currentFolder;
      setTopSeq(v => v + 1);
    }
  }, [currentFolder]);

  if (!Native) return null;
  return (
    <Native
      style={styles.fill}
      rowsPatch={patch}
      dark={!!isDark}
      palette={palette}
      density={density}
      labels={labels}
      selectionMode={!!selectMode}
      authToken={authToken}
      peek={peek}
      swipeEnabled={!selectMode}
      menuEnabled={!selectMode}
      refreshing={!!refreshing}
      loadingMore={!!loadingMore}
      bottomInset={bottomInset || 0}
      scrollToTopSeq={topSeq}
      {...handlers}
    />
  );
}

export default function NativeEmailList(props) {
  return (
    <NativeEmailBoundary onFailure={props.onFailure}>
      <NativeEmailListInner {...props} />
    </NativeEmailBoundary>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
