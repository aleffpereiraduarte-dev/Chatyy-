// components/chat/NativeChatInfo.js — [2026-10-18 chat-info-native]
//
// "Dados do contato" / "Dados do grupo" em NATIVO, nível WhatsApp
// (modules/expo-chat-conversation-list, view ChatyyChatInfo):
//   iOS     UICollectionView compositional + diffable (cartões agrupados,
//           ladrilhos de ação, faixa de miniaturas, membros virtualizados)
//   Android RecyclerView + DiffUtil (mesmo visual).
// O JS só monta DESCRITORES; cada linha carrega o próprio handler (onPress /
// onToggle) e o nativo devolve o id → chamamos o MESMO handler da folha JS.
//
// Descritores (chat-conversation.js monta):
//   hero    { title, sub, tile, badge, busy, actions:[{key, icon, label, active, onPress}], onAvatarPress }
//   rows    [{ id, k, sid, hd?, ft?, title, sub?, val?, icon?, dest?, on?, dis?, onPress?, onToggle? }]
//   media   [{ key, u, a?, video?, dur? }]  + onMediaPress(key) ('' = ver tudo)
//   members { header, items, total, hasMore, loading, search, empty, actions:[{id,title,icon,onPress}] }
//           + onMemberPress(id), onMembersEnd(), onMemberQuery(q)
//
// Gate: binário com a view (apiVersion ≥ 1) + kill switch OTA
// globalThis.__chatyy_native_chat_info = false. Erro de render/nativo →
// onFailure() e a conversa volta para a folha JS.
//
// [2026-10-18 elegance] apiVersion ≥ 2 → headerMode="collapse": cabeçalho
// Telegram NATIVO (avatar encolhe p/ a barra, nome assenta no título, ações
// esmaecem; puxar p/ baixo expande a foto em largura total). A view desenha
// a PRÓPRIA barra com o X (evento onClose) → quem monta esconde o cabeçalho JS
// quando nativeChatInfoOwnsHeader() = true. Binário 1 = hero estático de antes.
// Kill switch só do cabeçalho: globalThis.__chatyy_native_chat_info_collapse = false.
//
// [2026-10-18 profile-native] apiVersion ≥ 3 → a MESMA view serve o perfil
// próprio (mode 'self', Telegram Ajustes) e o perfil público de outra pessoa
// (mode 'user'). Campos novos do hero:
//   photos [{u, a}]  carrossel da foto expandida (toque nos terços laterais)
//   nav    {key, label, onPress}  botão de texto na barra ("Editar")
//   back   true = seta de voltar à esquerda (tela empurrada) no lugar do X
//   onAvatarPress(index) recebe a foto visível do carrossel.
// Gate: isNativeProfileEnabled() (api ≥ 3 + cabeçalho que encolhe) e kill
// switch OTA globalThis.__chatyy_native_profile = false (o mesmo nome desliga
// também o NativeProfileBridge antigo — ambos são "perfil nativo").
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Platform, StyleSheet, processColor } from 'react-native';
import { getNativeChatInfoView, chatInfoApiVersion } from '../../modules/expo-chat-conversation-list';
import { useGroupedColors } from '../settings/SettingsKit';

export function isNativeChatInfoEnabled() {
  if (Platform.OS === 'web') return false;
  try { if (globalThis.__chatyy_native_chat_info === false) return false; } catch {}
  try { return chatInfoApiVersion() >= 1 && !!getNativeChatInfoView(); } catch { return false; }
}

/** true → a view nativa desenha a barra (X + título ao encolher); esconda o cabeçalho JS. */
export function nativeChatInfoOwnsHeader() {
  if (!isNativeChatInfoEnabled()) return false;
  try { if (globalThis.__chatyy_native_chat_info_collapse === false) return false; } catch {}
  try { return chatInfoApiVersion() >= 2; } catch { return false; }
}

/** Perfil próprio/público nativo (Telegram): binário api ≥ 3 + kill switch. */
export function isNativeProfileEnabled() {
  if (!nativeChatInfoOwnsHeader()) return false;
  try { if (globalThis.__chatyy_native_profile === false) return false; } catch {}
  try { return chatInfoApiVersion() >= 3; } catch { return false; }
}

class Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch(error) {
    try { this.props.onFailure?.(String(error?.message || error)); } catch {}
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

const PALETTE_KEYS = ['pageBg', 'cardBg', 'separator', 'header', 'text', 'secondary', 'tertiary', 'chipBg', 'chipFg', 'destructive'];

function _stripRow(r) {
  const o = { id: String(r.id), k: r.k || 'c', sid: String(r.sid || '') };
  if (r.hd) o.hd = String(r.hd);
  if (r.ft) o.ft = String(r.ft);
  o.title = String(r.title || '');
  if (r.sub) o.sub = String(r.sub);
  if (r.val) o.val = String(r.val);
  if (r.icon) o.icon = String(r.icon);
  if (r.dest) o.dest = true;
  if (r.on) o.on = true;
  if (r.dis) o.dis = true;
  return o;
}

function Inner(props) {
  const { hero, rows, media, members, bottomInset = 0, maxWidth = 0 } = props;
  const Native = getNativeChatInfoView();
  const ownsHeader = nativeChatInfoOwnsHeader() && typeof props.onClose === 'function';
  const g = useGroupedColors();
  const isDark = !!g.isDark;

  const paletteKey = PALETTE_KEYS.map((k) => String(g?.[k] ?? '')).join('|') + (isDark ? '|d' : '|l');
  const colors = useMemo(() => {
    const out = {};
    for (const k of PALETTE_KEYS) {
      const v = g?.[k];
      if (v == null) continue;
      const n = processColor(v);
      if (typeof n === 'number') out[k] = n;
    }
    out.press = processColor(isDark ? '#2C2C2E' : '#E5E5EA');
    out.ripple = processColor(isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)');
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteKey]);

  const labelsKey = JSON.stringify(props.labels || null) + '|' + (ownsHeader ? String(props.closeLabel || 'Fechar') : '');
  const labelsProp = useMemo(() => (ownsHeader ? { ...(props.labels || {}), close: props.closeLabel || 'Fechar' } : (props.labels || null)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [labelsKey]);

  // Handlers ficam AQUI (o nativo só recebe dados planos).
  const propsRef = useRef(props);
  propsRef.current = props;

  const nativeRows = useMemo(() => (Array.isArray(rows) ? rows.filter((r) => r && r.id != null).map(_stripRow) : []), [rows]);
  const rowsKey = useMemo(() => JSON.stringify(nativeRows), [nativeRows]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableRows = useMemo(() => nativeRows, [rowsKey]);

  const nativeHero = useMemo(() => {
    const h = hero || {};
    return {
      title: String(h.title || ''),
      sub: String(h.sub || ''),
      tile: h.tile || null,
      badge: String(h.badge || ''),
      busy: !!h.busy,
      actions: (h.actions || []).filter(Boolean).map((a) => ({ key: String(a.key), icon: String(a.icon || ''), label: String(a.label || ''), active: !!a.active })),
      // [2026-10-18 profile-native] api ≥ 3 (binários velhos ignoram).
      photos: Array.isArray(h.photos) ? h.photos.filter((p) => p && p.u).slice(0, 9).map((p) => ({ u: String(p.u), a: p.a ? 1 : 0 })) : [],
      nav: h.nav && h.nav.key && h.nav.label ? { key: String(h.nav.key), label: String(h.nav.label) } : null,
      back: !!h.back,
    };
  }, [hero]);
  const heroKey = JSON.stringify(nativeHero);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableHero = useMemo(() => nativeHero, [heroKey]);

  const nativeMembers = useMemo(() => {
    if (!members) return null;
    return {
      header: String(members.header || ''),
      items: members.items || [],
      total: Number(members.total) || 0,
      hasMore: !!members.hasMore,
      loading: !!members.loading,
      search: String(members.search || ''),
      empty: String(members.empty || ''),
      actions: (members.actions || []).filter(Boolean).map((a) => ({ id: String(a.id), title: String(a.title || ''), icon: String(a.icon || '') })),
    };
  }, [members]);

  let authToken = '';
  try { authToken = require('../../services/api').getAuthToken?.() || ''; } catch {}

  const handlers = useMemo(() => {
    const find = (id) => (propsRef.current.rows || []).find((r) => r && String(r.id) === id);
    const findMemberAction = (id) => ((propsRef.current.members && propsRef.current.members.actions) || []).find((a) => a && String(a.id) === id);
    return {
      onRowPress: (e) => {
        const id = String((e?.nativeEvent ?? e)?.id ?? '');
        try {
          const r = find(id);
          if (r && typeof r.onPress === 'function') { r.onPress(); return; }
          const a = findMemberAction(id);
          if (a && typeof a.onPress === 'function') a.onPress();
        } catch {}
      },
      onToggle: (e) => {
        const ev = e?.nativeEvent ?? e;
        const id = String(ev?.id ?? '');
        try {
          const r = find(id);
          if (r && typeof r.onToggle === 'function') r.onToggle(!!ev?.value);
          else if (r && typeof r.onPress === 'function') r.onPress();
        } catch {}
      },
      onAction: (e) => {
        const key = String((e?.nativeEvent ?? e)?.key ?? '');
        try {
          const h = propsRef.current.hero || {};
          if (h.nav && String(h.nav.key) === key && typeof h.nav.onPress === 'function') { h.nav.onPress(); return; }
          const a = (h.actions || []).find((x) => x && String(x.key) === key);
          if (a && typeof a.onPress === 'function') a.onPress();
        } catch {}
      },
      onAvatarPress: (e) => {
        const idx = Number((e?.nativeEvent ?? e)?.index) || 0;
        try { propsRef.current.hero?.onAvatarPress?.(idx); } catch {}
      },
      onMediaPress: (e) => {
        const key = String((e?.nativeEvent ?? e)?.key ?? '');
        try { propsRef.current.onMediaPress?.(key); } catch {}
      },
      onMemberPress: (e) => {
        const id = String((e?.nativeEvent ?? e)?.id ?? '');
        try { propsRef.current.onMemberPress?.(id); } catch {}
      },
      onMembersEnd: () => { try { propsRef.current.onMembersEnd?.(); } catch {} },
      onMemberQuery: (e) => {
        const q = String((e?.nativeEvent ?? e)?.q ?? '');
        try { propsRef.current.onMemberQuery?.(q); } catch {}
      },
      onClose: () => { try { propsRef.current.onClose?.(); } catch {} },
      onNativeError: (e) => {
        const msg = String((e?.nativeEvent ?? e)?.message || 'native error');
        try { globalThis.__chatyyNativeChatInfoError = { at: Date.now(), msg }; } catch {}
        try { propsRef.current.onFailure?.(msg); } catch {}
      },
    };
  }, []);

  useEffect(() => { if (!Native) { try { propsRef.current.onFailure?.('no native view'); } catch {} } }, [Native]);
  if (!Native) return null;
  return (
    <Native
      style={styles.fill}
      hero={stableHero}
      rows={stableRows}
      media={Array.isArray(media) ? media : []}
      members={nativeMembers}
      colors={colors}
      dark={isDark}
      labels={labelsProp}
      headerMode={ownsHeader ? 'collapse' : undefined}
      bottomInset={bottomInset || 0}
      maxContentWidth={maxWidth || 0}
      authToken={authToken}
      {...handlers}
    />
  );
}

export default function NativeChatInfo(props) {
  return (
    <Boundary onFailure={props.onFailure}>
      <Inner {...props} />
    </Boundary>
  );
}

// ── Membros paginados (servidor: chat_info members_limit/offset/q) ─────────
// Servidor velho (sem members_total) → lista completa filtrada aqui.
const PAGE = 80;

export function useGroupMembersPager({ api, conversationId, enabled, version, fallback }) {
  const [state, setState] = useState({ items: [], total: 0, next: null, loading: false, q: '' });
  const reqRef = useRef(0);
  const qRef = useRef('');
  const fbRef = useRef(fallback);
  fbRef.current = fallback;

  const localSlice = useCallback((q) => {
    const all = Array.isArray(fbRef.current) ? fbRef.current : [];
    const ql = String(q || '').trim().toLowerCase();
    const list = ql ? all.filter((m) => String(m.display_name || '').toLowerCase().includes(ql) || String(m.email || '').toLowerCase().includes(ql)) : all;
    return list;
  }, []);

  const load = useCallback(async (offset, q) => {
    const my = ++reqRef.current;
    setState((s) => ({ ...s, loading: true, q }));
    let r = null;
    try {
      r = await (api.chatMembersPage
        ? api.chatMembersPage(conversationId, { limit: PAGE, offset, q })
        : api.chatMembers(conversationId));
    } catch { r = null; }
    if (my !== reqRef.current) return;
    const d = (r && r.success && (r.data?.conversation || r.data)) || null;
    if (!d || !Array.isArray(d.members)) {
      const list = localSlice(q);
      setState({ items: list, total: list.length, next: null, loading: false, q });
      return;
    }
    if (d.members_total == null) {
      // Servidor sem paginação: devolve todos; filtra/ordena no aparelho.
      const ql = String(q || '').trim().toLowerCase();
      const list = ql ? d.members.filter((m) => String(m.display_name || '').toLowerCase().includes(ql) || String(m.email || '').toLowerCase().includes(ql)) : d.members;
      setState({ items: list, total: list.length, next: null, loading: false, q });
      return;
    }
    setState((s) => {
      const base = offset > 0 ? s.items : [];
      const seen = new Set(base.map((m) => String(m.email || '').toLowerCase()));
      const add = d.members.filter((m) => { const k = String(m.email || '').toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; });
      return { items: base.concat(add), total: Number(d.members_total) || 0, next: d.members_next_offset == null ? null : Number(d.members_next_offset), loading: false, q };
    });
  }, [api, conversationId, localSlice]);

  useEffect(() => {
    if (!enabled || !conversationId) return;
    load(0, qRef.current);
  }, [enabled, conversationId, version, load]);

  const setQuery = useCallback((q) => {
    qRef.current = String(q || '');
    if (enabled) load(0, qRef.current);
  }, [enabled, load]);

  const stRef = useRef(state);
  stRef.current = state;
  const loadMore = useCallback(() => {
    const s = stRef.current;
    if (!enabled || s.loading || s.next == null) return;
    load(s.next, qRef.current);
  }, [enabled, load]);

  return { ...state, hasMore: state.next != null, setQuery, loadMore };
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
