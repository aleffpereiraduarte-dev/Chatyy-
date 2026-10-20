// components/chatlist/NativeConversationList.js — [2026-10-14 native-home]
//
// Lista de conversas da home em NATIVO (modules/expo-chat-conversation-list).
// O ChatListTab continua dono dos dados e das ações; aqui só:
//   1. normaliza as conversas (nativeAdapter.buildRow) e manda PATCHES por id;
//   2. hospeda o header da home (título grande, filtros, status, fixadas,
//      vazio) como 1º filho RN da view nativa — rola junto com as linhas — e o
//      rodapé (resultados de busca) como 2º filho;
//   3. traduz os eventos nativos para os handlers existentes do ChatListTab.
// Qualquer erro (render ou onNativeError) → onFailure() e o ChatListTab volta
// para o FlashList JS na hora.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNativeHeaderTouchGuard } from '../native/nativeHeaderTouchGuard'; // [2026-10-17 settings-scroll-tap]
import { Platform, StyleSheet, View } from 'react-native';
import { getNativeConversationListView, apiVersion as _clApiVersion } from '../../modules/expo-chat-conversation-list';
import { buildRow, buildLabels, createPatcher, presenceEmailOf } from './nativeAdapter';
import { buildPeekItems, buildPeekBg, peekHeightFraction, PEEK_MAX } from './peekItems';
import { listMetrics, tgListOn, listAccentHex } from './listDensity';
import { useTheme } from '../../context/ThemeContext';

class NativeListBoundary extends React.Component {
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
const _nicknames = _lazy(() => require('../../services/nicknames'));
const _ringStore = _lazy(() => require('../status/statusRingStore'));
const _api = _lazy(() => require('../../services/api'));
const _ns = _lazy(() => require('../../services/nativeChatStore'));

// [2026-10-15 native-store fase 1.5] FOTO DA HOME no store nativo.
// rev = formato das linhas (bundle + api + escuro + idioma + dia local: hora
// "ontem"/rótulos mudam); top = assinatura da 1ª conversa que o JS tem.
function _bundleTag() {
  try { const U = require('expo-updates'); return String((U && (U.updateId || U.runtimeVersion)) || 'embedded'); } catch { return 'embedded'; }
}
function _homeTop(convs) {
  const c = Array.isArray(convs) ? convs[0] : null;
  if (!c || c.id == null) return '';
  const lm = c.last_message && typeof c.last_message === 'object' ? c.last_message : null;
  return `${c.id}|${(lm && lm.id) || c.last_message_at || c.updated_at || ''}|${Number(c.unread_count) || 0}|${(Array.isArray(convs) ? convs.length : 0)}`;
}

function NativeConversationListInner(props) {
  const {
    conversations, header, footer, empty,
    isDark, t, language, user,
    selectionMode, selectedIds, typingUsers, drafts, draftTimes,
    presencesRef, presenceToken, socketUp, lockedIds, unlockedIds, notesMap,
    helpers, bottomInset = 0,
    onOpen, onPressIn, onToggleSelect, onAvatarPress, onAction, onMore, onEnterSelection,
    onCollapsedChange, onFirstPaint, onFailure, scrollToTopSeq = 0, folders,
    storeMain = false, // [native-store fase 1.5] lista principal (sem filtro/busca/arquivadas)
    topInset = 0, snapOffset = 0, // [2026-10-16 wave8-list] vidro no topo + snap do título grande
  } = props;
  const Native = getNativeConversationListView();
  const me = String(user?.email || '').toLowerCase();
  // [2026-10-19 tg-list] destaque escolhido em Aparência (cor do "digitando…").
  let _accent = '';
  try { _accent = useTheme()?.accentColor || ''; } catch { _accent = ''; }

  // [native-store fase 1.5] prop `store` + 1ª montagem SEM buildRow quando a foto
  // gravada bate com o que o JS tem (a lista nativa pinta a foto; o JS monta as
  // linhas depois do 1º frame e o reset substitui sem diferença visível).
  const homeStore = useMemo(() => {
    if (!storeMain || !me || Platform.OS === 'web') return undefined;
    try { if (_clApiVersion() < 2) return undefined; } catch { return undefined; }
    const ns = _ns();
    if (!ns || ns.nativeStoreApi() < 2) return undefined;
    const r = ns.fnv(JSON.stringify([_bundleTag(), _clApiVersion(), !!isDark, String(language || ''), ns.localDay()]));
    return { a: me, r, n: _homeTop(conversations), s: 'main' };
  }, [storeMain, me, isDark, language, conversations]);
  const [deferBuild, setDeferBuild] = useState(() => {
    try {
      if (!homeStore || !homeStore.n) return false;
      const top = _ns().homeTopSync(me, 'main');
      return !!(top && top.rev === homeStore.r && top.top === homeStore.n);
    } catch { return false; }
  });
  useEffect(() => {
    if (!deferBuild) return undefined;
    // depois do 1º frame (a foto já está na tela) o JS monta as linhas
    let r2 = 0;
    const r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setDeferBuild(false)); });
    const tm = setTimeout(() => setDeferBuild(false), 250);
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); clearTimeout(tm); };
  }, [deferBuild]);

  // Anel de status: um listener só para a lista inteira.
  const [ringToken, setRingToken] = useState(0);
  useEffect(() => {
    const store = _ringStore();
    if (!store || typeof store.subscribeStatusRings !== 'function') return undefined;
    return store.subscribeStatusRings(() => setRingToken(v => v + 1));
  }, []);

  // [2026-10-19 info-cache] Avatares SWR do disco (services/avatarCache): linha
  // cuja versão nova ainda não baixou mostra a última foto boa da pessoa (arquivo
  // local) em vez de piscar as iniciais; quando o download grava, refaz as linhas
  // (o patcher só manda as que mudaram). Topo da lista = baixa em 2º plano.
  const [avatarToken, setAvatarToken] = useState(0);
  const avKickRef = useRef(0);
  useEffect(() => {
    const ac = _avatarCache();
    if (!ac || typeof ac.subscribeAvatarCached !== 'function') return undefined;
    try { ac.prefetchTopConversationAvatars && ac.prefetchTopConversationAvatars(); } catch {}
    return ac.subscribeAvatarCached(() => setAvatarToken(v => v + 1));
  }, []);

  // Resync pedido pelo nativo (perdeu um patch) → próximo patch é reset.
  const patcherRef = useRef(null);
  const headerTouchGuard = useNativeHeaderTouchGuard();
  const footerTouchGuard = useNativeHeaderTouchGuard();
  if (!patcherRef.current) patcherRef.current = createPatcher();
  const [resyncToken, setResyncToken] = useState(0);

  const metaRef = useRef(new Map());

  const ctx = useMemo(() => {
    const av = _avatarSvc() || {};
    const ac = _avatarCache() || {};
    const nn = _nicknames() || {};
    const rs = _ringStore() || {};
    const api = _api() || {};
    return {
      me, t, language,
      computePreview: helpers.computePreview,
      formatTime: helpers.formatTime,
      convTitle: helpers.convTitle,
      normalizeTypers: helpers.normalizeTypers,
      emailToDisplayName: api.emailToDisplayName,
      getNickname: nn.getNickname,
      getRing: rs.getStatusRing,
      buildAvatarUrl: av.buildAvatarUrl,
      canonicalAvatarUrl: av.canonicalAvatarUrl,
      avatarAuthHeaders: av.avatarAuthHeaders,
      getCachedAvatarUriOrNull: typeof ac.getAvatarUriSWR === 'function'
        ? (url) => ac.getAvatarUriSWR(url, { kick: avKickRef.current-- > 0 })
        : ac.getCachedAvatarUriOrNull,
      typingUsers, drafts, draftTimes,
      presences: presencesRef?.current,
      socketUp, lockedIds, unlockedIds, selectedIds, selectionMode, notesMap,
    };
  // presenceToken/ringToken: forçam reler presença/anel (refs mutáveis).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, t, language, helpers, typingUsers, drafts, draftTimes, presenceToken, ringToken, avatarToken, socketUp, lockedIds, unlockedIds, selectedIds, selectionMode, notesMap]);

  // [2026-10-19 core-chat] Cache por linha: "digitando"/rascunho mudam UMA conversa,
  // mas trocavam o ctx e refaziam buildRow (~30 t() + a11y) de TODAS as linhas a cada
  // evento — o maior custo JS da aba no Android. Agora a geração só muda quando algo
  // GLOBAL muda (idioma, presença, anel, avatar, seleção, cadeados, socket); typing/
  // rascunho invalidam só a linha delas (mesmo objeto da conversa = mesma linha).
  // Kill switch: globalThis.__chatyy_list_row_cache = false (refaz tudo como antes).
  // [2026-10-20 perf-js] presença saiu da geração: cada evento/poll de presença
  // refazia buildRow de TODAS as linhas. Agora cada linha guarda o valor de
  // presença do seu peer (mesmo objeto do Map = sem mudança) e só ela é refeita.
  // Kill switch: globalThis.__chatyy_list_presence_row = false (volta ao antigo).
  const _presRow = globalThis.__chatyy_list_presence_row !== false;
  const rowGen = useMemo(() => ({}),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [me, t, language, helpers, _presRow ? 0 : presenceToken, ringToken, avatarToken, socketUp, lockedIds, unlockedIds, selectedIds, selectionMode, notesMap]);
  const rowCacheRef = useRef(new Map());

  const built = useMemo(() => {
    const rows = [];
    const meta = new Map();
    if (deferBuild) return { rows, meta, deferred: true };
    avKickRef.current = 40; // só as ~40 primeiras linhas disparam download (o resto: prefetch/rolagem)
    const useCache = globalThis.__chatyy_list_row_cache !== false;
    const prev = rowCacheRef.current;
    const next = new Map();
    const minute = Math.floor(Date.now() / 60000); // horário/"ontem"/idade do rascunho
    for (const c of (Array.isArray(conversations) ? conversations : [])) {
      if (!c || c.id == null) continue;
      const k = String(c.id);
      const typ = ctx.typingUsers ? ctx.typingUsers[c.id] : undefined;
      const dr = ctx.drafts ? ctx.drafts[k] : undefined;
      const dt = ctx.draftTimes ? ctx.draftTimes[k] : undefined;
      const hit = useCache ? prev.get(k) : null;
      let pv;
      if (_presRow) {
        const pe = (hit && hit.c === c) ? hit.pe : presenceEmailOf(c, ctx.me || '');
        pv = { pe, v: (pe && ctx.presences instanceof Map) ? ctx.presences.get(pe) : undefined };
      }
      if (hit && hit.c === c && hit.g === rowGen && hit.typ === typ && hit.dr === dr && hit.dt === dt && hit.mn === minute
        && (!_presRow || hit.pv === pv.v)) {
        rows.push(hit.row);
        meta.set(hit.row.id, hit.m);
        next.set(k, hit);
        continue;
      }
      try {
        const { row, meta: m } = buildRow(c, ctx);
        rows.push(row);
        meta.set(row.id, m);
        next.set(k, { c, g: rowGen, typ, dr, dt, mn: minute, row, m, pe: pv ? pv.pe : null, pv: pv ? pv.v : undefined });
      } catch {}
    }
    rowCacheRef.current = next;
    return { rows, meta };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, ctx, rowGen, deferBuild]);

  const { patch, snapshot } = useMemo(
    () => (built.deferred ? { patch: undefined, snapshot: null } : patcherRef.current.diff(built.rows)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [built, resyncToken]
  );
  useLayoutEffect(() => {
    if (!snapshot) return; // [native-store] montagem adiada: nada foi ao nativo
    patcherRef.current.commit(snapshot);
    metaRef.current = built.meta;
  }, [snapshot, built]);

  const labels = useMemo(() => buildLabels(t), [t]);
  // Listas do usuário → submenu "Adicionar à lista" (check nas que já contêm a conversa).
  const nativeFolders = useMemo(() => (Array.isArray(folders) ? folders : [])
    .filter(f => f && f.id != null && f.name)
    .map(f => ({
      id: String(f.id),
      name: String(f.name),
      ids: (Array.isArray(f.conversation_ids) ? f.conversation_ids : []).map(x => String(x)),
    })), [folders]);

  // Token do avatar restrito (get_avatar com Bearer).
  let authToken = '';
  try { authToken = (_api()?.getAuthToken && _api().getAuthToken()) || ''; } catch {}

  // Header / rodapé: alturas medidas (o nativo também observa o frame).
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

  // Peek (iOS): últimas mensagens do cache local para a prévia do toque longo.
  const [peek, setPeek] = useState(null);

  const propsRef = useRef(props);
  propsRef.current = props;
  const ctxRef = useRef(ctx);
  const darkRef = useRef(!!isDark); // [2026-10-18 peek-full]
  darkRef.current = !!isDark;
  ctxRef.current = ctx;

  const handlers = useMemo(() => {
    // Prévia do toque longo (iOS): últimas ~12 mensagens do cache local.
    const buildPeek = (m) => {
      try {
        const c = ctxRef.current;
        // [2026-10-17 peek-fit] miniaturas reais, hora em todas e recibo igual à conversa.
        const items = buildPeekItems(m.conv, c);
        const id = String(m.conv.id);
        setPeek(prev => {
          const next = { id, items: items.slice(-PEEK_MAX) };
          // [2026-10-18 peek-full] fundo da conversa (papel de parede) — nativo novo desenha
          try { const bg = buildPeekBg(id, !!darkRef.current, c.me); if (bg) next.bg = bg; } catch {}
          if (prev && prev.id === id && JSON.stringify(prev.items) === JSON.stringify(next.items) && JSON.stringify(prev.bg || null) === JSON.stringify(next.bg || null)) return prev;
          return next;
        });
      } catch {}
    };
    const convOf = (e) => {
      const ev = e?.nativeEvent ?? e;
      const id = String(ev?.id ?? '');
      const m = metaRef.current.get(id);
      return m ? m : null;
    };
    return {
      onRowPress: (e) => {
        const m = convOf(e); if (!m) return;
        const p = propsRef.current;
        // [wave8 row-zoom] navigationHint: frame da linha (coords da janela) → transição linha→conversa
        if (!p.selectionMode) { try { require('../../services/rowZoomTransition').noteRowHint(m.conv.id, (e?.nativeEvent ?? e)?.frame); } catch {} }
        try {
          if (p.selectionMode) p.onToggleSelect?.(m.conv);
          else p.onOpen?.(m.conv);
        } catch {}
      },
      onRowPressIn: (e) => {
        const m = convOf(e); if (!m) return;
        try { propsRef.current.onPressIn?.(m.conv); } catch {}
        // iOS: prepara a prévia do toque longo já no toque (chega antes do menu).
        if (Platform.OS === 'ios') buildPeek(m);
      },
      onAvatarPress: (e) => {
        const m = convOf(e); if (!m) return;
        const p = propsRef.current;
        try {
          if (p.selectionMode) { p.onToggleSelect?.(m.conv); return; }
          let opened = false;
          if (m.hasRing && m.avatarEmail) {
            try { opened = !!_ringStore()?.openStatusFor?.(m.avatarEmail); } catch {}
          }
          if (!opened) p.onAvatarPress?.({ name: m.title, email: m.avatarEmail, conv: m.conv });
        } catch {}
      },
      onRowAction: (e) => {
        const m = convOf(e); if (!m) return;
        const action = (e?.nativeEvent ?? e)?.action;
        const p = propsRef.current;
        try {
          if (action === 'more') p.onMore?.(m.conv);
          else if (action === 'select') p.onEnterSelection?.(m.conv);
          else if (action === 'photo') p.onAvatarPress?.({ name: m.title, email: m.avatarEmail, conv: m.conv });
          else p.onAction?.(action, m.conv, e?.nativeEvent ?? e);
        } catch {}
      },
      onLongPress: (e) => {
        const m = convOf(e); if (!m) return;
        const p = propsRef.current;
        try {
          if (p.selectionMode) p.onToggleSelect?.(m.conv);
          else p.onMore?.(m.conv);
        } catch {}
      },
      onPeekRequest: (e) => {
        const m = convOf(e); if (!m) return;
        buildPeek(m);
      },
      onPeekOpen: (e) => {
        const m = convOf(e); if (!m) return;
        try { propsRef.current.onOpen?.(m.conv); } catch {}
      },
      onCollapsedChange: (e) => {
        try { propsRef.current.onCollapsedChange?.(!!(e?.nativeEvent ?? e)?.collapsed); } catch {}
      },
      // [2026-10-18 tg-list] puxão no topo (iOS api 6 / Android api 7) → Arquivadas.
      onPullReveal: (e) => {
        try { propsRef.current.onPullReveal?.(Number((e?.nativeEvent ?? e)?.distance) || 0); } catch {}
      },
      onResync: () => {
        patcherRef.current.requestReset();
        setResyncToken(v => v + 1);
      },
      onFirstPaint: () => {
        try { require('../../services/nativeTelemetry').noteNativeMount(_clApiVersion() >= 3 ? 'home3' : 'home'); } catch {} // [android-wave8] cobertura
        try { propsRef.current.onFirstPaint?.(); } catch {}
      },
      onNativeError: (e) => {
        const msg = String((e?.nativeEvent ?? e)?.message || 'native error');
        try { globalThis.__chatyyNativeHomeError = { at: Date.now(), msg }; } catch {}
        try { propsRef.current.onFailure?.(msg); } catch {}
      },
    };
  }, []);

  // [2026-10-16 wave8-list] api 3: header do app por cima da lista (vidro
  // nativo no topo), snap do título grande e prévia estilo Telegram no toque
  // longo do Android. Binário antigo: nenhuma destas props vai (nada muda).
  let _api3 = false;
  try { _api3 = _clApiVersion() >= 3; } catch {}
  const wave8Props = _api3 ? {
    topInset: Math.max(0, Math.round(Number(topInset) || 0)),
    snapOffset: Math.max(0, Math.round(Number(snapOffset) || 0)),
    peekMode: (Platform.OS === 'android' && globalThis.__chatyy_native_list_peek !== false) ? 'peek' : 'menu',
    // [2026-10-16 motion-nav] molas nativas (ItemAnimator Android + pulo do
    // contador iOS/Android). Só vai quando DESLIGADO (binário sem a prop ignora).
    ...(globalThis.__chatyy_motion_list_spring === false ? { springMotion: false } : null),
  } : null;
  // [2026-10-17 peek-fixed] prévia de altura fixa: fração da tela (binário com
  // a prop = lista iOS api >= 4 / Android api >= 5; antigo nem recebe).
  let peekHeightProps = null;
  try {
    if (_clApiVersion() >= (Platform.OS === 'android' ? 5 : 4)) {
      const f = peekHeightFraction();
      if (f > 0) peekHeightProps = { peekHeight: f };
    }
  } catch {}

  // [2026-10-18 compact-list] linha 72 / avatar 52 / vão 12 (WhatsApp) no
  // binário com a prop `density` (iOS api >= 8 / Android api >= 9). Antigo:
  // nem recebe (segue 76 / 54); o header RN acima já fica compacto via OTA.
  let densityProps = null;
  try {
    if (_clApiVersion() >= (Platform.OS === 'android' ? 9 : 8)) {
      densityProps = { density: listMetrics().compact ? 'compact' : 'regular' };
    }
  } catch {}
  // [2026-10-19 tg-list] linhas Telegram (iOS api >= 9 / Android api >= 10) +
  // cor de destaque do "digitando…". Kill switch __chatyy_tg_list = false.
  try {
    if (densityProps && tgListOn() && _clApiVersion() >= (Platform.OS === 'android' ? 10 : 9)) {
      densityProps = { density: 'telegram', accent: listAccentHex(_accent) };
    }
  } catch {}

  if (!Native) return null;
  return (
    <Native
      style={styles.fill}
      rowsPatch={patch}
      dark={!!isDark}
      selectionMode={!!selectionMode}
      labels={labels}
      authToken={authToken}
      headerHeight={headerH}
      footerHeight={footerH}
      bottomInset={bottomInset || 0}
      collapseOffset={34}
      peek={peek}
      folders={nativeFolders}
      swipeEnabled={!selectionMode}
      menuEnabled={!selectionMode}
      scrollToTopSeq={scrollToTopSeq}
      {...(homeStore ? { store: homeStore } : null)}
      {...wave8Props}
      {...peekHeightProps}
      {...densityProps}
      {...handlers}
    >
      <View collapsable={false} style={styles.slot} onLayout={onHeaderLayout} {...headerTouchGuard}>
        {header}
        {built.rows.length === 0 && !built.deferred ? empty : null}
      </View>
      <View collapsable={false} style={styles.slot} onLayout={onFooterLayout} {...footerTouchGuard}>
        {footer}
      </View>
    </Native>
  );
}

export default function NativeConversationList(props) {
  return (
    <NativeListBoundary onFailure={props.onFailure}>
      <NativeConversationListInner {...props} />
    </NativeListBoundary>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // Filhos RN da view nativa: o nativo os posiciona (header acima da 1ª linha,
  // rodapé depois da última); aqui só garantimos largura total e altura natural.
  slot: { position: 'absolute', top: 0, left: 0, right: 0 },
});
