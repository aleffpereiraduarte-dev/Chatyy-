// components/communities/communityRows.js — [2026-10-15 native-social]
//
// COMUNIDADES em nativo: linhas planas para as views ChatyyCommunityList (aba)
// e ChatyyCommunityDetail (tela da comunidade) do módulo
// modules/expo-chat-conversation-list (iOS CMListCore/CMCell, Android
// CMListBaseView/CMRowView). Formato completo em ios/CMModels.swift.
//
// Aqui também mora o wrapper comum (NativeCommunityRows): patches por id
// (createPatcher da home), header/rodapé RN como filhos, eventos → handlers
// do JS, boundary de erro → onFailure (a tela volta para a lista JS).
// Kill switch OTA/console: globalThis.__chatyy_native_communities = false.

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNativeHeaderTouchGuard } from '../native/nativeHeaderTouchGuard'; // [2026-10-17 settings-scroll-tap]
import { Platform, StyleSheet, View } from 'react-native';
import { createPatcher } from '../chatlist/nativeAdapter';

function _lazy(fn) {
  let v; let done = false;
  return () => { if (!done) { done = true; try { v = fn(); } catch { v = null; } } return v; };
}
const _api = _lazy(() => require('../../services/api'));
const _avatarSvc = _lazy(() => require('../../services/avatar'));
const _nativeMod = _lazy(() => require('../../modules/expo-chat-conversation-list'));

/** Pode usar a view nativa? (web / binário antigo / kill switch / falha → não). */
export function nativeCommunitiesEnabled(kind) {
  if (Platform.OS === 'web') return false;
  try { if (globalThis.__chatyy_native_communities === false) return false; } catch {}
  try { if (globalThis.__chatyy_native_communities_failed) return false; } catch {}
  try {
    const m = _nativeMod();
    if (!m) return false;
    const View_ = kind === 'detail' ? m.getNativeCommunityDetailView?.() : m.getNativeCommunityListView?.();
    return !!View_;
  } catch { return false; }
}

export function markNativeCommunitiesFailed(msg) {
  try { globalThis.__chatyy_native_communities_failed = true; } catch {}
  try { console.warn('[native-communities] fallback JS:', msg); } catch {}
  try { require('../../services/crashReporter').reportNativeFallback('native_communities', msg); } catch {}
}

function _tx(t, key, fb) {
  let r = fb;
  try {
    const v = t ? t(key) : null;
    if (typeof v === 'string' && v && v !== key) r = v;
  } catch {}
  return r;
}

/** Cor do tema → "#RRGGBB" / "#RRGGBBAA" ('' se não der: o nativo usa o padrão). */
export function toHex(c) {
  const s = String(c || '').trim();
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s)) return s;
  if (/^#[0-9a-f]{3}$/i.test(s)) return '#' + s.slice(1).split('').map(x => x + x).join('');
  const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) {
    const hx = (n) => Math.max(0, Math.min(255, Math.round(+n))).toString(16).padStart(2, '0');
    const a = m[4] != null ? hx(parseFloat(m[4]) * 255) : '';
    return '#' + hx(m[1]) + hx(m[2]) + hx(m[3]) + a;
  }
  if (s === 'transparent') return '#00000000';
  return '';
}

function _palette(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    const h = toHex(obj[k]);
    if (h) out[k] = h;
  }
  return out;
}

/** Imagem da comunidade → {u, a} (URL absoluta + se leva Bearer). */
function _image(raw) {
  let u = String(raw || '');
  if (!u) return { u: '', a: 0 };
  try {
    const api = _api();
    if (u.startsWith('/') && api?.getMediaUrl) u = api.getMediaUrl(u) || u;
  } catch {}
  let a = 0;
  try { a = _avatarSvc()?.avatarAuthHeaders?.(u) ? 1 : 0; } catch { a = 0; }
  return { u, a };
}

// ─── Aba COMUNIDADES (cartões expansíveis) ──────────────────────────────────

export function communityListPalette(colors, isDark) {
  const c = colors || {};
  return _palette({
    bg: c.background,
    card: c.surface || (isDark ? '#161616' : '#ffffff'),
    border: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
    inset: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)',
    text: c.text,
    sub: isDark ? '#8b8fa3' : '#6b7280',
    ter: isDark ? '#666666' : '#999999',
    ink: c.text,
    pill: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)',
    iconBg: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
    chevron: isDark ? '#666666' : '#999999',
    danger: '#ef4444',
  });
}

/**
 * Mesma ordem/visual do FlatList JS: um cartão por comunidade; o aberto ganha
 * descrição, grupos (com X p/ admin), vazio/carregando e pílulas de admin.
 * Devolve { rows, map } — map: id da linha → { type, item, group }.
 */
export function buildCommunityListRows({ communities, expandedId, expandedData, loadingInfo, t }) {
  const rows = [];
  const map = new Map();
  const L = {
    groups: _tx(t, 'community.groups', 'Grupos'),
    members: _tx(t, 'community.members', 'Membros'),
    admin: _tx(t, 'community.admin', 'Admin'),
    noGroups: _tx(t, 'community.noGroups', 'Nenhum grupo'),
    addGroup: _tx(t, 'community.addGroup', 'Adicionar grupo'),
    announce: _tx(t, 'community.announcement', 'Aviso'),
  };
  for (const item of Array.isArray(communities) ? communities : []) {
    if (!item || item.id == null) continue;
    const cid = String(item.id);
    const expanded = expandedId != null && String(expandedId) === cid;
    const isAdmin = item.role === 'admin' || item.role === 'owner';
    const name = String(item.name || '');
    const meta = `${item.group_count ?? 0} ${L.groups} · ${item.member_count ?? 0} ${L.members}${isAdmin ? ' · ' + L.admin : ''}`;
    const img = _image(item.icon_url || item.photo_url);
    const card = {
      id: `c:${cid}`, kind: 'card', seg: expanded ? 'top' : 'one', cs: 'c', mt: 10,
      title: name, sub: meta, i: (name || '?')[0].toUpperCase(), chev: 1, tap: 1,
      a11y: name,
    };
    if (img.u) card.u = img.u;
    if (img.a) card.a = 1;
    if (expanded) card.x = 1;
    rows.push(card);
    map.set(card.id, { type: 'card', item });
    if (!expanded) continue;

    const inner = [];
    if (item.description) inner.push({ id: `d:${cid}`, kind: 'text', ts: 'desc', body: String(item.description) });
    const groups = Array.isArray(expandedData?.groups) ? expandedData.groups : [];
    if (loadingInfo) {
      inner.push({ id: `l:${cid}`, kind: 'loading' });
    } else if (groups.length > 0) {
      inner.push({ id: `gl:${cid}`, kind: 'text', ts: 'label', body: L.groups });
      for (const g of groups) {
        if (!g || g.conversation_id == null) continue;
        const gid = `g:${cid}:${g.conversation_id}`;
        const r = { id: gid, kind: 'group', title: String(g.name || 'Group'), sub: `${g.member_count ?? 0} ${L.members}`, tap: 1 };
        if (isAdmin) r.rm = 1;
        inner.push(r);
        map.set(gid, { type: 'group', item, group: g });
      }
    } else {
      inner.push({ id: `e:${cid}`, kind: 'text', ts: 'empty', body: L.noGroups });
    }
    if (isAdmin) {
      const a = { id: `a:${cid}`, kind: 'actions', b1: L.addGroup, b1k: 'addGroup', b1i: 'plus', b2: L.announce, b2k: 'announce', b2i: 'bell' };
      inner.push(a);
      map.set(a.id, { type: 'actions', item });
    }
    inner.forEach((r, i) => {
      r.cs = 'c';
      r.seg = i === inner.length - 1 ? 'bot' : 'mid';
      if (i === 0) r.div = 1;
      if (i === inner.length - 1) r.pb = 14;
      rows.push(r);
    });
  }
  return { rows, map };
}

// ─── Tela da comunidade ────────────────────────────────────────────────────

function roleColor(role, isDark) {
  switch (role) {
    case 'owner': return isDark ? '#F5F5F7' : '#111111';
    case 'admin': return isDark ? '#48484a' : '#3a3a3c';
    case 'mod': return '#636366';
    default: return '#8e8e93';
  }
}
function roleLabel(role, t) {
  switch (role) {
    case 'owner': return _tx(t, 'community.roleOwner', 'Dono');
    case 'admin': return _tx(t, 'community.roleAdmin', 'Admin');
    case 'mod': return _tx(t, 'community.roleMod', 'Mod');
    default: return _tx(t, 'community.roleMember', 'Membro');
  }
}

export function communityDetailPalette(colors, isDark) {
  const c = colors || {};
  return _palette({
    bg: c.background,
    card: c.surface,
    box: isDark ? '#1c1c1e' : '#f8f8fa',
    text: c.text,
    sub: c.textSecondary,
    ter: c.textSecondary,
    ink: c.primary,
    border: c.border,
  });
}

/** Linhas da aba ativa (Anúncios / Conversas / Membros / Sobre). */
export function buildCommunityDetailRows({ tab, community, groups, members, isAdmin, myEmail, t, colors, isDark }) {
  const rows = [];
  const map = new Map();
  if (!community) return { rows, map };
  const c = colors || {};
  const box = (r) => ({ kind: 'row', seg: 'one', cs: 'b', mb: 18, ...r });
  const membersCount = (n) => _tx(t, 'community.membersCount', '{n} membros').replace('{n}', String(n || 0));
  const groupsCount = (n) => _tx(t, 'community.groupsCount', '{n} grupos').replace('{n}', String(n || 0));

  if (tab === 'announcements') {
    if (community.announcement_conv_id) {
      rows.push(box({
        id: 'ann:open', tap: 1,
        title: _tx(t, 'community.openAnnouncements', 'Abrir canal de avisos'),
        sub: _tx(t, 'community.announcementsHint', 'Apenas admins podem postar; todos leem.'),
      }));
      map.set('ann:open', { type: 'announcements' });
    }
  } else if (tab === 'conversations') {
    for (const g of Array.isArray(groups) ? groups : []) {
      if (!g || g.conversation_id == null) continue;
      const id = `g:${g.conversation_id}`;
      const r = box({ id, tap: 1, title: String(g.name || ''), sub: membersCount(g.member_count) });
      if (g.is_announcement) {
        r.tag = _tx(t, 'community.announcementTag', 'Avisos');
        r.tbg = toHex(c.primary) || undefined;
        r.tfg = toHex(c.onPrimary) || undefined;
        if (!r.tbg) delete r.tbg;
        if (!r.tfg) delete r.tfg;
      }
      rows.push(r);
      map.set(id, { type: 'group', group: g });
    }
    if (isAdmin) {
      rows.push(box({ id: 'add', cs: 'd', center: 1, ink: 1, tap: 1, title: '+ ' + _tx(t, 'community.addGroup', 'Adicionar sub-grupo') }));
      map.set('add', { type: 'add' });
    }
  } else if (tab === 'members') {
    for (const m of Array.isArray(members) ? members : []) {
      if (!m || !m.email) continue;
      const id = `m:${m.email}`;
      const r = box({ id, title: String(m.display_name || m.email), sub: String(m.email) });
      if (m.role && m.role !== 'member') {
        r.rtag = roleLabel(m.role, t);
        r.rbg = toHex(roleColor(m.role, isDark));
        r.rfg = isDark && m.role === 'owner' ? '#000000' : '#ffffff';
      }
      if (isAdmin && String(m.email).toLowerCase() !== myEmail) r.lp = 1;
      rows.push(r);
      map.set(id, { type: 'member', member: m });
    }
  } else if (tab === 'about') {
    const section = (key, title, lines) => {
      rows.push({ id: `ab:${key}:t`, kind: 'text', ts: 'title', px: 0, body: title });
      lines.forEach((ln, i) => {
        rows.push({ id: `ab:${key}:${i}`, kind: 'text', ts: 'body', px: 0, body: ln, mb: i === lines.length - 1 ? 16 : 0 });
      });
    };
    if (community.description) section('desc', _tx(t, 'community.description', 'Descrição'), [String(community.description)]);
    if (community.rules) section('rules', _tx(t, 'community.rules', 'Regras'), [String(community.rules)]);
    if (community.welcome_message) section('welcome', _tx(t, 'community.welcome', 'Mensagem de boas-vindas'), [String(community.welcome_message)]);
    section('stats', _tx(t, 'community.stats', 'Estatísticas'), [membersCount(community.member_count), groupsCount(community.group_count)]);
  }
  if (rows.length) {
    rows[0].mt = 12;
    const last = rows[rows.length - 1];
    if (last.kind === 'row') last.mb = 8;
  }
  return { rows, map };
}

// ─── Wrapper comum ─────────────────────────────────────────────────────────

class NativeCommunityBoundary extends React.Component {
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

function NativeCommunityRowsInner(props) {
  const { Native, rows, header, footer, isDark, palette, refreshing, refreshEnabled = true, bottomInset = 0, style } = props;

  const patcherRef = useRef(null);
  const headerTouchGuard = useNativeHeaderTouchGuard();
  const footerTouchGuard = useNativeHeaderTouchGuard();
  if (!patcherRef.current) patcherRef.current = createPatcher();
  const [resyncToken, setResyncToken] = useState(0);

  const { patch, snapshot } = useMemo(
    () => patcherRef.current.diff(rows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, resyncToken]
  );
  useLayoutEffect(() => {
    patcherRef.current.commit(snapshot);
  }, [snapshot]);

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
    const ev = (e) => (e?.nativeEvent ?? e) || {};
    return {
      onRowPress: (e) => { try { propsRef.current.onRowPress?.(String(ev(e).id ?? '')); } catch {} },
      onRowAction: (e) => {
        const n = ev(e);
        try { propsRef.current.onRowAction?.(String(n.id ?? ''), String(n.action || '')); } catch {}
      },
      onLongPress: (e) => { try { propsRef.current.onLongPress?.(String(ev(e).id ?? '')); } catch {} },
      onRefresh: () => { try { propsRef.current.onRefresh?.(); } catch {} },
      onResync: () => {
        patcherRef.current.requestReset();
        setResyncToken(v => v + 1);
      },
      onFirstPaint: () => {},
      onNativeError: (e) => {
        const msg = String(ev(e).message || 'native error');
        try { globalThis.__chatyyNativeCommunitiesError = { at: Date.now(), msg }; } catch {}
        try { propsRef.current.onFailure?.(msg); } catch {}
      },
    };
  }, []);

  if (!Native) return null;
  return (
    <Native
      style={[styles.fill, style]}
      rowsPatch={patch}
      dark={!!isDark}
      palette={palette}
      authToken={authToken}
      headerHeight={headerH}
      footerHeight={footerH}
      bottomInset={bottomInset || 0}
      refreshing={!!refreshing}
      refreshEnabled={refreshEnabled !== false}
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

/**
 * props: Native (host), rows, header, footer, isDark, palette, refreshing,
 * refreshEnabled, bottomInset, onRowPress(id), onRowAction(id, action),
 * onLongPress(id), onRefresh(), onFailure(msg)
 */
export function NativeCommunityRows(props) {
  return (
    <NativeCommunityBoundary onFailure={props.onFailure}>
      <NativeCommunityRowsInner {...props} />
    </NativeCommunityBoundary>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  slot: { position: 'absolute', top: 0, left: 0, right: 0 },
});
