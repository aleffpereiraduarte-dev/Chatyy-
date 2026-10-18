// components/chatlist/NativePinnedStrip.js — [2026-10-15 native-pins]
//
// Fileira de conversas FIXADAS da home em NATIVO (view ChatyyPinnedStrip do
// modules/expo-chat-conversation-list). Avatares grandes com anel de status,
// online, contador e "digitando"; toque longo = MESMO menu nativo da lista
// (prévia + menu compacto + submenus); arrastar reordena; tamanho automático.
//
// O header da home (onde a fileira mora) é memoizado com deps próprias; para a
// fileira acompanhar presença/digitando/rascunhos sem re-renderizar o header
// inteiro, o ChatListTab publica os dados numa "ponte" (createPinBridge) a cada
// render e só este slot assina. Ações vão por ref (não disparam render).
//
// Kill switch: globalThis.__chatyy_native_pins === false → fileira JS antiga.
// Erro de render/nativo → onFailure() e o ChatListTab volta para a fileira JS.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { getNativePinnedStripView, pinnedStripApiVersion } from '../../modules/expo-chat-conversation-list';
import { buildRow, buildLabels, rowEqual } from './nativeAdapter';
import { buildPeekItems, buildPeekBg, peekHeightFraction, PEEK_MAX } from './peekItems';

function _lazy(fn) {
  let v; let done = false;
  return () => { if (!done) { done = true; try { v = fn(); } catch { v = null; } } return v; };
}
const _avatarSvc = _lazy(() => require('../../services/avatar'));
const _avatarCache = _lazy(() => require('../../services/avatarCache'));
const _nicknames = _lazy(() => require('../../services/nicknames'));
const _ringStore = _lazy(() => require('../status/statusRingStore'));
const _api = _lazy(() => require('../../services/api'));

function _shallowEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * Ponte ChatListTab → slot da fileira. `set(data, actions)`: data é comparado
 * raso (só re-renderiza o slot quando algo mudou); actions vão por ref.
 */
export function createPinBridge() {
  let data = null;
  const actionsRef = { current: {} };
  const subs = new Set();
  return {
    actionsRef,
    get: () => data,
    set(next, actions) {
      if (actions) actionsRef.current = actions;
      if (data && _shallowEqual(data, next)) return;
      data = next;
      subs.forEach((fn) => { try { fn(next); } catch {} });
    },
    subscribe(fn) {
      subs.add(fn);
      return () => { subs.delete(fn); };
    },
  };
}

/** Tamanho automático: ≤ 4 fixados = grandes (colunas), mais = menores + rolagem. */
export function autoPinAvatarSize(count, width) {
  const w = Math.max(280, Number(width) || 360);
  if (count <= 4) return Math.max(60, Math.min(76, Math.floor((w - 16) / 4) - 20));
  return 58;
}

/** Altura da fileira nativa para um tamanho de avatar (respiro p/ contador e nome). */
export function pinStripHeight(avatarSize) {
  return Math.round(avatarSize + 34);
}

class PinsBoundary extends React.Component {
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

function PinnedStripInner({ data, actionsRef, avatarSize, height }) {
  const Native = getNativePinnedStripView();
  const {
    conversations, isDark, t, language, user,
    selectionMode, selectedIds, typingUsers, drafts, draftTimes,
    presencesRef, presenceToken, socketUp, lockedIds, unlockedIds, notesMap,
    helpers, folders, reorderMode,
  } = data;
  const me = String(user?.email || '').toLowerCase();

  // Anel de status: um listener só.
  const [ringToken, setRingToken] = useState(0);
  useEffect(() => {
    const store = _ringStore();
    if (!store || typeof store.subscribeStatusRings !== 'function') return undefined;
    return store.subscribeStatusRings(() => setRingToken(v => v + 1));
  }, []);

  const ctx = useMemo(() => {
    const av = _avatarSvc() || {};
    const ac = _avatarCache() || {};
    const nn = _nicknames() || {};
    const rs = _ringStore() || {};
    const api = _api() || {};
    return {
      me, t, language,
      computePreview: helpers?.computePreview,
      formatTime: helpers?.formatTime,
      convTitle: helpers?.convTitle,
      normalizeTypers: helpers?.normalizeTypers,
      emailToDisplayName: api.emailToDisplayName,
      getNickname: nn.getNickname,
      getRing: rs.getStatusRing,
      buildAvatarUrl: av.buildAvatarUrl,
      canonicalAvatarUrl: av.canonicalAvatarUrl,
      avatarAuthHeaders: av.avatarAuthHeaders,
      getCachedAvatarUriOrNull: ac.getCachedAvatarUriOrNull,
      typingUsers, drafts, draftTimes,
      presences: presencesRef?.current,
      socketUp, lockedIds, unlockedIds, selectedIds, selectionMode, notesMap,
    };
  // presenceToken/ringToken: forçam reler presença/anel (refs mutáveis).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, t, language, helpers, typingUsers, drafts, draftTimes, presenceToken, ringToken, socketUp, lockedIds, unlockedIds, selectedIds, selectionMode, notesMap]);

  const metaRef = useRef(new Map());
  const prevItemsRef = useRef([]);
  const items = useMemo(() => {
    const rows = [];
    const meta = new Map();
    for (const c of (Array.isArray(conversations) ? conversations : [])) {
      if (!c || c.id == null) continue;
      try {
        const { row, meta: m } = buildRow(c, ctx);
        row.smart = !!c._smartPin;
        rows.push(row);
        meta.set(row.id, m);
      } catch {}
    }
    metaRef.current = meta;
    // Mesmo conteúdo → mesmo array (o prop não muda, nada cruza a ponte).
    const prev = prevItemsRef.current;
    if (prev.length === rows.length && rows.every((r, i) => rowEqual(r, prev[i]))) return prev;
    prevItemsRef.current = rows;
    return rows;
  }, [conversations, ctx]);

  const labels = useMemo(() => {
    const L = buildLabels(t);
    let r = null;
    try { r = t ? t('chat.reorderPinned') : null; } catch {}
    L.reorderPinned = r && r !== 'chat.reorderPinned' ? r : 'Reorganizar fixados';
    return L;
  }, [t]);

  const nativeFolders = useMemo(() => (Array.isArray(folders) ? folders : [])
    .filter(f => f && f.id != null && f.name)
    .map(f => ({
      id: String(f.id),
      name: String(f.name),
      ids: (Array.isArray(f.conversation_ids) ? f.conversation_ids : []).map(x => String(x)),
    })), [folders]);

  let authToken = '';
  try { authToken = (_api()?.getAuthToken && _api().getAuthToken()) || ''; } catch {}

  const [peek, setPeek] = useState(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const ctxRef = useRef(ctx);
  const darkRef = useRef(!!isDark); // [2026-10-18 peek-full]
  darkRef.current = !!isDark;
  ctxRef.current = ctx;

  const handlers = useMemo(() => {
    const A = () => actionsRef.current || {};
    const convOf = (e) => {
      const ev = e?.nativeEvent ?? e;
      const m = metaRef.current.get(String(ev?.id ?? ''));
      return m || null;
    };
    // Prévia do toque longo (iOS): últimas ~12 mensagens do cache local
    // (mesma montagem da lista nativa).
    const buildPeek = (m) => {
      try {
        const c = ctxRef.current;
        // [2026-10-17 peek-fit] miniaturas reais, hora em todas e recibo igual à conversa.
        const out = buildPeekItems(m.conv, c);
        const id = String(m.conv.id);
        setPeek(prev => {
          const next = { id, items: out.slice(-PEEK_MAX) };
          // [2026-10-18 peek-full] fundo da conversa (papel de parede) — nativo novo desenha
          try { const bg = buildPeekBg(id, !!darkRef.current, c.me); if (bg) next.bg = bg; } catch {}
          if (prev && prev.id === id && JSON.stringify(prev.items) === JSON.stringify(next.items) && JSON.stringify(prev.bg || null) === JSON.stringify(next.bg || null)) return prev;
          return next;
        });
      } catch {}
    };
    return {
      onPinPress: (e) => {
        const m = convOf(e); if (!m) return;
        try {
          if (dataRef.current.selectionMode) A().onToggleSelect?.(m.conv);
          else A().onOpen?.(m.conv);
        } catch {}
      },
      onPinPressIn: (e) => {
        const m = convOf(e); if (!m) return;
        try { A().onPressIn?.(m.conv); } catch {}
        if (Platform.OS === 'ios') buildPeek(m);
      },
      onPinAction: (e) => {
        const m = convOf(e); if (!m) return;
        const ev = e?.nativeEvent ?? e;
        const action = ev?.action;
        try {
          if (action === 'reorder') A().onReorderMode?.(true);
          else if (action === 'select') A().onEnterSelection?.(m.conv);
          else A().onAction?.(action, m.conv, ev);
        } catch {}
      },
      onPinLongPress: (e) => {
        const m = convOf(e); if (!m) return;
        try {
          if (dataRef.current.selectionMode) A().onToggleSelect?.(m.conv);
          else A().onMore?.(m.conv);
        } catch {}
      },
      onPeekRequest: (e) => {
        const m = convOf(e); if (!m) return;
        buildPeek(m);
      },
      onPeekOpen: (e) => {
        const m = convOf(e); if (!m) return;
        try { A().onOpen?.(m.conv); } catch {}
      },
      onReorder: (e) => {
        const ids = (e?.nativeEvent ?? e)?.ids;
        if (!Array.isArray(ids) || !ids.length) return;
        try { A().onReorder?.(ids.map(x => String(x))); } catch {}
      },
      onReorderDone: () => {
        try { A().onReorderMode?.(false); } catch {}
      },
      onNativeError: (e) => {
        const msg = String((e?.nativeEvent ?? e)?.message || 'native error');
        try { globalThis.__chatyyNativePinsError = { at: Date.now(), msg }; } catch {}
        try { A().onFailure?.(msg); } catch {}
      },
    };
  }, [actionsRef]);

  if (!Native) return null;
  // [2026-10-17 peek-fixed] prévia de altura fixa (iOS api >= 2; Android sem peek aqui).
  let peekHeightProps = null;
  try {
    if (Platform.OS === 'ios' && pinnedStripApiVersion() >= 2) {
      const f = peekHeightFraction();
      if (f > 0) peekHeightProps = { peekHeight: f };
    }
  } catch {}
  return (
    <Native
      style={{ height, alignSelf: 'stretch' }}
      {...peekHeightProps}
      items={items}
      dark={!!isDark}
      labels={labels}
      folders={nativeFolders}
      peek={peek}
      avatarSize={avatarSize}
      reorderMode={!!reorderMode && !selectionMode}
      selectionMode={!!selectionMode}
      menuEnabled={!selectionMode}
      authToken={authToken}
      {...handlers}
    />
  );
}

/** Slot da fileira nativa (mora dentro do header memoizado da home). */
export default function PinnedStripSlot({ bridge, avatarSize, height }) {
  const [data, setData] = useState(() => bridge.get());
  useEffect(() => {
    const cur = bridge.get();
    if (cur !== data) setData(cur);
    return bridge.subscribe(setData);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);
  if (!data) return <View style={{ height }} />;
  return (
    <PinsBoundary onFailure={(msg) => { try { bridge.actionsRef.current?.onFailure?.(msg); } catch {} }}>
      <PinnedStripInner data={data} actionsRef={bridge.actionsRef} avatarSize={avatarSize} height={height} />
    </PinsBoundary>
  );
}
