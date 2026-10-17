// components/calls/NativeCallList.js — [2026-10-15 native-calls]
//
// Histórico da aba Ligações em NATIVO (modules/expo-chat-conversation-list,
// view ChatyyCallList: iOS UICollectionView inset-grouped + diffable; Android
// RecyclerView + DiffUtil). O ChatCallsTab continua dono dos dados e ações:
//   1. cada ligação vira uma linha PLANA (ctx.describe = mesmas regras do
//      CallHistoryRow) e só PATCHES por id atravessam a ponte (createPatcher);
//   2. o cabeçalho (título grande, chips, cartões) é o 1º filho RN — rola junto;
//   3. eventos nativos → handlers existentes (abrir, ligar, info, apagar, menu).
// Erro de render/nativo → onFailure() e o ChatCallsTab volta para o ScrollView JS.

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNativeHeaderTouchGuard } from '../native/nativeHeaderTouchGuard'; // [2026-10-17 settings-scroll-tap]
import { StyleSheet, View } from 'react-native';
import { getNativeCallListView } from '../../modules/expo-chat-conversation-list';
import { createPatcher, initialsOf, gradientIndex } from '../chatlist/nativeAdapter';

class NativeCallListBoundary extends React.Component {
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

// Mesmo ladrilho do nativeAdapter (foto em cache local > URL com Bearer > iniciais).
function _tile(email, name) {
  const av = _avatarSvc() || {};
  const ac = _avatarCache() || {};
  let u = '';
  let a = false;
  if (email && _EMAIL_RE.test(email) && String(email).toLowerCase() !== 'ai@chatyy.com.br') {
    let url = '';
    try { url = (av.buildAvatarUrl && av.buildAvatarUrl(email, { name })) || ''; } catch {}
    if (url) {
      u = url;
      try { const local = ac.getCachedAvatarUriOrNull ? ac.getCachedAvatarUriOrNull(url) : null; if (local) u = local; } catch {}
      if (u === url) { try { a = !!(av.avatarAuthHeaders && av.avatarAuthHeaders(url)); } catch { a = false; } }
    }
  }
  const tile = { u, i: initialsOf(name, email), g: gradientIndex(name || email || '') };
  if (a) tile.a = 1;
  return tile;
}

function _participantTiles(list) {
  const out = [];
  for (const p of (Array.isArray(list) ? list : [])) {
    if (out.length >= 4) break;
    const email = typeof p === 'string' ? p : (p?.email || p?.contactEmail || '');
    const name = typeof p === 'string' ? '' : (p?.name || p?.display_name || '');
    if (!email && !name) continue;
    out.push(_tile(email, name || email));
  }
  return out;
}

export function callRowKey(item, idx) {
  const id = item?.id != null && item.id !== '' ? String(item.id) : '';
  return id || `i${idx}_${item?.timestamp || item?.created_at || ''}`;
}

function NativeCallListInner(props) {
  const { calls, header, isDark, labels, describe, sectionOf, bottomInset = 0 } = props;
  const Native = getNativeCallListView();

  const patcherRef = useRef(null);
  const headerTouchGuard = useNativeHeaderTouchGuard();
  if (!patcherRef.current) patcherRef.current = createPatcher();
  const [resyncToken, setResyncToken] = useState(0);
  const metaRef = useRef(new Map());

  const built = useMemo(() => {
    const rows = [];
    const meta = new Map();
    const list = Array.isArray(calls) ? calls : [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!item) continue;
      try {
        const id = callRowKey(item, i);
        if (meta.has(id)) continue;
        const dsc = describe(item) || {};
        const row = {
          id,
          title: String(dsc.title || '?'),
          dir: dsc.dir || 'in',
          sub: String(dsc.sub || ''),
          time: String(dsc.time || ''),
          sec: String(sectionOf(item) || ''),
          a11y: String(dsc.a11y || ''),
        };
        if (dsc.video) row.video = true;
        if (dsc.dur) row.dur = String(dsc.dur);
        if (dsc.vm) row.vm = true;
        if (dsc.count > 1) row.count = dsc.count;
        if (dsc.isChatyy && (dsc.avatarName || dsc.avatarEmail)) {
          const group = item.isGroup && Array.isArray(item.participants) && item.participants.length > 1;
          const tiles = group ? _participantTiles(item.participants) : [];
          row.tiles = tiles.length > 1 ? tiles : [_tile(dsc.avatarEmail, dsc.avatarName || dsc.avatarEmail)];
          if (tiles.length > 1) row.kind = 'group';
        } else {
          row.phone = true;
          if (dsc.flag) row.flag = String(dsc.flag);
        }
        rows.push(row);
        meta.set(id, item);
      } catch {}
    }
    return { rows, meta };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calls, describe, sectionOf]);

  const { patch, snapshot } = useMemo(
    () => patcherRef.current.diff(built.rows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [built, resyncToken]
  );
  useLayoutEffect(() => {
    patcherRef.current.commit(snapshot);
    metaRef.current = built.meta;
  }, [snapshot, built]);

  let authToken = '';
  try { authToken = (_api()?.getAuthToken && _api().getAuthToken()) || ''; } catch {}

  const [headerH, setHeaderH] = useState(0);
  const onHeaderLayout = useMemo(() => (e) => {
    const h = Math.round(e?.nativeEvent?.layout?.height || 0);
    setHeaderH(prev => (prev === h ? prev : h));
  }, []);

  const propsRef = useRef(props);
  propsRef.current = props;

  const handlers = useMemo(() => {
    const itemOf = (e) => {
      const ev = e?.nativeEvent ?? e;
      return metaRef.current.get(String(ev?.id ?? '')) || null;
    };
    return {
      onRowPress: (e) => {
        const it = itemOf(e); if (!it) return;
        try { propsRef.current.onPress?.(it); } catch {}
      },
      onRowAction: (e) => {
        const it = itemOf(e); if (!it) return;
        const action = (e?.nativeEvent ?? e)?.action;
        const p = propsRef.current;
        try {
          if (action === 'callBack') p.onCallBack?.(it);
          else if (action === 'info') p.onInfoPress?.(it);
          else if (action === 'delete') p.onDelete?.(it);
          else p.onMenuAction?.(action, it);
        } catch {}
      },
      onCollapsedChange: (e) => {
        try { propsRef.current.onCollapsedChange?.(!!(e?.nativeEvent ?? e)?.collapsed); } catch {}
      },
      onResync: () => {
        patcherRef.current.requestReset();
        setResyncToken(v => v + 1);
      },
      onNativeError: (e) => {
        const msg = String((e?.nativeEvent ?? e)?.message || 'native error');
        try { globalThis.__chatyyNativeCallsError = { at: Date.now(), msg }; } catch {}
        try { propsRef.current.onFailure?.(msg); } catch {}
      },
    };
  }, []);

  // Sem a view (binário antigo) → o chamador nem monta este componente; defensivo.
  useEffect(() => { if (!Native) { try { propsRef.current.onFailure?.('no native view'); } catch {} } }, [Native]);
  if (!Native) return null;
  return (
    <Native
      style={styles.fill}
      rowsPatch={patch}
      dark={!!isDark}
      labels={labels}
      authToken={authToken}
      headerHeight={headerH}
      bottomInset={bottomInset || 0}
      collapseOffset={34}
      swipeEnabled
      menuEnabled
      {...handlers}
    >
      <View collapsable={false} style={styles.slot} onLayout={onHeaderLayout} {...headerTouchGuard}>
        {header}
      </View>
    </Native>
  );
}

export default function NativeCallList(props) {
  return (
    <NativeCallListBoundary onFailure={props.onFailure}>
      <NativeCallListInner {...props} />
    </NativeCallListBoundary>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  slot: { position: 'absolute', top: 0, left: 0, right: 0 },
});
