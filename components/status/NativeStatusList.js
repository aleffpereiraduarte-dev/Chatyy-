// components/status/NativeStatusList.js — [2026-10-15 native-lists]
//
// Lista de atualizações da aba STATUS em NATIVO (view `ChatyyStatusList` do
// módulo modules/expo-chat-conversation-list — iOS UICollectionView + diffable,
// Android RecyclerView + DiffUtil). O ChatStatusTab continua dono dos dados e
// das ações; aqui só:
//   1. achata as seções (Meus / Recentes / Vistos / Silenciados) em linhas
//      planas (cabeçalho de seção = linha kind:"section") e manda PATCHES por
//      id (createPatcher do nativeAdapter da home);
//   2. hospeda o topo da aba (título grande, busca, carrossel, "Meu status")
//      como 1º filho RN — rola junto — e o estado vazio como 2º filho;
//   3. traduz os eventos nativos para os handlers existentes.
// Qualquer erro (render ou onNativeError) → onFailure() e a aba volta para o
// ScrollView JS na hora. Desligar por OTA: globalThis.__chatyy_native_status_list = false.

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNativeHeaderTouchGuard } from '../native/nativeHeaderTouchGuard'; // [2026-10-17 settings-scroll-tap]
import { StyleSheet, View } from 'react-native';
import { getNativeStatusListView } from '../../modules/expo-chat-conversation-list';
import { createPatcher, initialsOf, gradientIndex } from '../chatlist/nativeAdapter';
import { isTextStatusItem, itemBg, itemFontStyle, textStatusSolid, textStatusSnippet } from './textStatus';

class NativeStatusBoundary extends React.Component {
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

const _EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function _tx(t, key, fb) {
  let r = fb;
  try {
    const v = t ? t(key) : null;
    if (typeof v === 'string' && v && v !== key) r = v;
  } catch {}
  return r;
}

// Mesmas regras do avatar direto da home (nativeAdapter._tile/_directAvatarUrl).
function _avatarTile(email, name) {
  let u = '';
  let a = false;
  const em = String(email || '');
  if (em && _EMAIL_RE.test(em) && em.toLowerCase() !== 'ai@chatyy.com.br') {
    try { u = _avatarSvc()?.buildAvatarUrl?.(em, { name }) || ''; } catch { u = ''; }
  }
  if (u) {
    const url = u;
    try {
      const local = _avatarCache()?.getCachedAvatarUriOrNull?.(url);
      if (local) u = local;
    } catch {}
    if (u === url) {
      try { a = !!_avatarSvc()?.avatarAuthHeaders?.(url); } catch { a = false; }
    }
  }
  const tile = { u, i: initialsOf(name, em), g: gradientIndex(name || em || '') };
  if (a) tile.a = 1;
  return tile;
}

// Cor da miniatura de texto → #RRGGBB (o nativo só entende hex).
function _hex(c) {
  const s = String(c || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  if (/^#[0-9a-f]{8}$/i.test(s)) return s.slice(0, 7);
  if (/^#[0-9a-f]{3}$/i.test(s)) return '#' + s.slice(1).split('').map(x => x + x).join('');
  const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) return '#' + [m[1], m[2], m[3]].map(n => Math.max(0, Math.min(255, +n)).toString(16).padStart(2, '0')).join('');
  return '#111111';
}

function _textThumb(item) {
  if (!item) return null;
  try {
    if (isTextStatusItem(item) && !item._placeholder && item.content) {
      return { t: textStatusSnippet(item.content), bg: _hex(textStatusSolid(itemBg(item))), f: String(itemFontStyle(item) || 'sans') };
    }
    if (item._preview_text) {
      return { t: textStatusSnippet(item._preview_text), bg: _hex(textStatusSolid(item._preview_bg)), f: String(item._preview_font || 'sans') };
    }
  } catch {}
  return null;
}

// URL da imagem da prévia do toque longo (iOS): foto ou pôster do vídeo.
function _peekUrl(item) {
  if (!item) return '';
  try {
    const api = _api() || {};
    const abs = (u) => (u && u.startsWith('/') && api.getMediaUrl ? api.getMediaUrl(u) : u) || '';
    if (item.type === 'video') return abs(String(item.thumbnail_url || ''));
    if (item.type === 'image' || item.type === 'photo') {
      const raw = String(item.media_url || item.content || '').split('\n')[0];
      return /^(https?:|\/|file:)/.test(raw) ? abs(raw) : '';
    }
  } catch {}
  return '';
}

function _rowFor(group, ctx, prefix, section) {
  const items = Array.isArray(group?.items) ? group.items : [];
  const latest = items[items.length - 1];
  const allViewed = items.length > 0 && items.every(it => it && it.viewed);
  const email = String(group.ownerEmail || group.email || '');
  const name = String(group.ownerName || group.name || email.split('@')[0] || '');
  const ring = items.length
    ? items.map(it => (allViewed || (it && it.viewed)) ? '1' : '0').join('')
    : '1';
  const cf = items.some(it => (it?.meta?.privacy || it?.privacy) === 'close_friends');
  const time = ctx.timeAgo ? (ctx.timeAgo(latest?.timestamp) || '') : '';
  const row = {
    id: `${prefix}:${email.toLowerCase()}`,
    kind: 'row',
    section,
    email,
    title: name,
    time,
    count: items.length,
    ring,
    muted: section === 'muted',
    mine: prefix === 'me',
    notify: !!(ctx.notifySubs && ctx.notifySubs.has && ctx.notifySubs.has(email.toLowerCase())),
    a11y: [name, time, items.length > 1 ? String(items.length) : ''].filter(Boolean).join(', '),
  };
  // Campos PLANOS (rowEqual do patcher compara só o 1º nível).
  const tile = _avatarTile(email, name);
  row.tu = tile.u; row.ti = tile.i; row.tg = tile.g;
  if (tile.a) row.ta = 1;
  if (cf) row.cf = 1;
  const th = _textThumb(latest);
  if (th) { row.tt = th.t; row.tbg = th.bg; row.tf = th.f; }
  const pu = _peekUrl(latest);
  if (pu) row.peek = pu;
  return row;
}

/** Seções → linhas planas na MESMA ordem do ScrollView JS. */
export function buildStatusRows({ myGroup, recent, viewed, muted, showMuted }, ctx) {
  const rows = [];
  const L = ctx.labels;
  const sec = (key, title, count, extra) => rows.push({ id: `sec:${key}`, kind: 'section', section: key, title, count, ...extra });
  if (myGroup && myGroup.items && myGroup.items.length) {
    sec('mine', L.mine, myGroup.items.length);
    rows.push(_rowFor(myGroup, ctx, 'me', 'mine'));
  }
  if (recent.length) {
    sec('recent', L.recent, recent.length);
    for (const g of recent) rows.push(_rowFor(g, ctx, 'st', 'recent'));
  }
  if (viewed.length) {
    sec('viewed', L.viewed, viewed.length, { dim: 1 });
    for (const g of viewed) rows.push(_rowFor(g, ctx, 'st', 'viewed'));
  }
  if (muted.length) {
    sec('muted', L.muted, muted.length, { dim: 1, collapsible: 1, expanded: showMuted ? 1 : 0 });
    if (showMuted) for (const g of muted) rows.push(_rowFor(g, ctx, 'st', 'muted'));
  }
  return rows;
}

export function buildStatusLabels(t) {
  return {
    mine: _tx(t, 'status.mine', 'Meus'),
    recent: _tx(t, 'status.recentUpdates', 'Atualizações recentes'),
    viewed: _tx(t, 'status.viewed', 'Visualizados'),
    muted: _tx(t, 'status.muted', 'Silenciados'),
    open: _tx(t, 'status.view', 'Ver status'),
    preview: _tx(t, 'common.preview', 'Visualizar'),
    mute: _tx(t, 'status.muteAction', 'Silenciar'),
    unmute: _tx(t, 'chat.unmute', 'Reativar'),
    report: _tx(t, 'status.reportAction', 'Reportar'),
    share: _tx(t, 'status.shareAction', 'Compartilhar'),
    notify: _tx(t, 'status.notifyShort', 'Notificar'),
    notifying: _tx(t, 'status.notifyingShort', 'Notificando'),
  };
}

function NativeStatusListInner(props) {
  const {
    myGroup, recent, viewed, muted, showMuted,
    header, footer, isDark, t, timeAgo, notifySubs, palette,
    refreshing, bottomInset = 0,
  } = props;
  const Native = getNativeStatusListView();

  const patcherRef = useRef(null);
  const headerTouchGuard = useNativeHeaderTouchGuard();
  const footerTouchGuard = useNativeHeaderTouchGuard();
  if (!patcherRef.current) patcherRef.current = createPatcher();
  const [resyncToken, setResyncToken] = useState(0);

  const labels = useMemo(() => buildStatusLabels(t), [t]);

  // Grupo de origem de cada linha (eventos nativos → handlers JS com o grupo).
  const groupsRef = useRef(new Map());

  const built = useMemo(() => {
    const ctx = { labels, timeAgo, notifySubs };
    const rows = buildStatusRows({
      myGroup,
      recent: Array.isArray(recent) ? recent : [],
      viewed: Array.isArray(viewed) ? viewed : [],
      muted: Array.isArray(muted) ? muted : [],
      showMuted: !!showMuted,
    }, ctx);
    const map = new Map();
    const put = (prefix, g) => {
      const em = String(g?.ownerEmail || g?.email || '').toLowerCase();
      map.set(`${prefix}:${em}`, g);
    };
    if (myGroup) put('me', myGroup);
    for (const g of [...(recent || []), ...(viewed || []), ...(muted || [])]) put('st', g);
    return { rows, map };
  }, [myGroup, recent, viewed, muted, showMuted, labels, timeAgo, notifySubs]);

  const { patch, snapshot } = useMemo(
    () => patcherRef.current.diff(built.rows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [built, resyncToken]
  );
  useLayoutEffect(() => {
    patcherRef.current.commit(snapshot);
    groupsRef.current = built.map;
  }, [snapshot, built]);

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
    const groupOf = (e) => {
      const id = String((e?.nativeEvent ?? e)?.id ?? '');
      return { id, group: groupsRef.current.get(id) || null };
    };
    return {
      onRowPress: (e) => {
        const { id, group } = groupOf(e);
        const p = propsRef.current;
        try {
          if (id === 'sec:muted') { p.onToggleMuted?.(); return; }
          // [2026-10-16 motion] Se o nativo mandar o frame do avatar (originRect,
          // janela pt/dp), o story cresce dele. Sem o campo → abre como sempre.
          if (group) {
            const ne = e?.nativeEvent ?? e;
            if (ne && ne.originRect) { try { require('../../services/storyOrigin').setStoryOriginHint(group.ownerEmail || group.email, ne.originRect); } catch {} }
          }
          if (group) p.onOpen?.(group);
        } catch {}
      },
      onRowPressIn: (e) => {
        const { group } = groupOf(e);
        if (group) { try { propsRef.current.onPressIn?.(group); } catch {} }
      },
      onRowAction: (e) => {
        const { group } = groupOf(e);
        if (!group) return;
        const action = String((e?.nativeEvent ?? e)?.action || '');
        try { propsRef.current.onAction?.(action, group); } catch {}
      },
      onLongPress: (e) => {
        const { group } = groupOf(e);
        if (group) { try { propsRef.current.onPreview?.(group); } catch {} }
      },
      onPeekOpen: (e) => {
        const { group } = groupOf(e);
        if (group) { try { propsRef.current.onOpen?.(group); } catch {} }
      },
      onRefresh: () => {
        try { propsRef.current.onRefresh?.(); } catch {}
      },
      onCollapsedChange: (e) => {
        try { propsRef.current.onCollapsedChange?.(!!(e?.nativeEvent ?? e)?.collapsed); } catch {}
      },
      onResync: () => {
        patcherRef.current.requestReset();
        setResyncToken(v => v + 1);
      },
      onFirstPaint: () => {},
      onNativeError: (e) => {
        const msg = String((e?.nativeEvent ?? e)?.message || 'native error');
        try { globalThis.__chatyyNativeStatusError = { at: Date.now(), msg }; } catch {}
        try { propsRef.current.onFailure?.(msg); } catch {}
      },
    };
  }, []);

  if (!Native) return null;
  return (
    <Native
      style={styles.fill}
      rowsPatch={patch}
      dark={!!isDark}
      labels={labels}
      palette={palette}
      authToken={authToken}
      headerHeight={headerH}
      footerHeight={footerH}
      bottomInset={bottomInset || 0}
      collapseOffset={34}
      refreshing={!!refreshing}
      refreshTint={isDark ? '#F5F5F7' : '#111111'}
      {...handlers}
    >
      <View collapsable={false} style={styles.slot} onLayout={onHeaderLayout} {...headerTouchGuard}>
        {header}
      </View>
      <View collapsable={false} style={styles.slot} onLayout={onFooterLayout} {...footerTouchGuard}>
        {footer}
      </View>
    </Native>
  );
}

export default function NativeStatusList(props) {
  return (
    <NativeStatusBoundary onFailure={props.onFailure}>
      <NativeStatusListInner {...props} />
    </NativeStatusBoundary>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  slot: { position: 'absolute', top: 0, left: 0, right: 0 },
});
