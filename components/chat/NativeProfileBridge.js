// components/chat/NativeProfileBridge.js — [2026-10-15 native-profile]
//
// "Dados do contato / grupo" com cabeçalho NATIVO estilo Telegram
// (modules/expo-chat-profile). O conteúdo da folha (cartões, linhas, ações,
// modais) continua sendo o MESMO JSX de app/chat-conversation.js — aqui só:
//   • <ProfileScrollHost native={…|null} …>  troca o ScrollView da folha pelo
//     cabeçalho nativo + o mesmo ScrollView (paddingTop = altura do cabeçalho).
//     native = null → ScrollView puro, idêntico ao de antes;
//   • <NativeProfileMedia> abas Mídia | Links | Arquivos (grade nativa);
//   • <NativeProfileList> membros / grupos em comum (lista nativa).
// Cada peça tem ErrorBoundary com fallback JS; erro → nativo desligado na sessão.
// Kill switch: globalThis.__chatyy_native_profile = false.

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Platform, processColor, ScrollView } from 'react-native';

let _failed = false;

function _nativeModule() {
  if (Platform.OS === 'web') return null;
  try {
    return require('../../modules/expo-chat-profile');
  } catch {
    return null;
  }
}

/** true quando o binário tem as 3 views nativas e o kill switch não as desligou. */
export function shouldUseNativeProfile() {
  if (Platform.OS === 'web' || _failed) return false;
  try { if (globalThis.__chatyy_native_profile === false) return false; } catch {}
  const m = _nativeModule();
  try { return !!(m && m.isAvailable && m.isAvailable()); } catch { return false; }
}

function _pc(c) {
  if (c == null) return null;
  try {
    const v = processColor(c);
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

/** Cor → número (processColor) p/ props de linha das listas nativas. */
export function profileColor(c) {
  return _pc(c);
}

export function profileTheme(isDark, colors = {}) {
  return {
    dark: !!isDark,
    background: _pc(isDark ? (colors.background || '#000000') : '#f0f2f5'),
    surface: _pc(colors.surface || (isDark ? '#111111' : '#ffffff')),
    card: _pc(isDark ? '#1c1c1e' : '#f4f4f5'),
    cardBorder: _pc(isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'),
    text: _pc(colors.text || (isDark ? '#ffffff' : '#111111')),
    secondaryText: _pc(colors.textSecondary || (isDark ? '#a1a1a6' : '#6e6e73')),
    tertiaryText: _pc(colors.textTertiary || (isDark ? '#8e8e93' : '#8e8e93')),
    accent: _pc(colors.text || (isDark ? '#ffffff' : '#111111')),
    hairline: _pc(isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)'),
    destructive: _pc(colors.error || '#dc2626'),
  };
}

/** Iniciais (até 2 letras) p/ o avatar nativo sem foto. */
export function profileInitials(name, email) {
  const src = String(name || '').trim() || String(email || '').split('@')[0] || '';
  const parts = src.replace(/[._-]+/g, ' ').split(/\s+/).filter(Boolean);
  const a = Array.from(parts[0] || '')[0] || '';
  const b = parts.length > 1 ? (Array.from(parts[parts.length - 1])[0] || '') : '';
  return (a + b).toUpperCase();
}

/** {uri, headers} p/ avatar de e-mail (get_avatar exige Bearer no nativo). */
export function avatarRefForEmail(email, name, size) {
  try {
    const av = require('../../services/avatar');
    const uri = av.buildAvatarUrl(email, size === 'full' ? { name, size: 'full' } : { name });
    if (!uri) return null;
    const src = av.avatarSource(uri) || { uri };
    return { uri: src.uri, headers: src.headers || null };
  } catch {
    return null;
  }
}

/** {uri, headers} p/ URL de avatar qualquer (grupo / relativa). */
export function avatarRefForUrl(url, size) {
  if (!url) return null;
  try {
    const av = require('../../services/avatar');
    const uri = av.canonicalAvatarUrl(url, size === 'full' ? { size: 'full' } : {}) || url;
    const src = av.avatarSource(uri) || { uri };
    return { uri: src.uri, headers: src.headers || null };
  } catch {
    return { uri: url, headers: null };
  }
}

/** Avatar com foto real (versão) → pode abrir a galeria. */
export function hasRealPhoto(ref) {
  const u = ref && ref.uri;
  if (!u) return false;
  if (u.indexOf('get_avatar') === -1) return true;
  return /[?&]v=/.test(u);
}

export function headerHeights(topInset, hasActions) {
  const top = Math.max(0, topInset || 0);
  return { expanded: top + (hasActions ? 264 : 186), compact: top + 56 };
}

class Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err) {
    _failed = true;
    try { console.warn('[native-profile] fallback to JS:', err?.message || err); } catch {}
    try { this.props.onFatal?.(err); } catch {}
  }

  render() {
    if (this.state.failed) {
      try { return this.props.fallback ? this.props.fallback() : null; } catch { return null; }
    }
    return this.props.children;
  }
}

// ── Cabeçalho + ScrollView ─────────────────────────────────────────────────

function NativeHeaderHost({ native, style, contentContainerStyle, children, scrollProps }) {
  const m = _nativeModule();
  const HeaderView = m && m.getProfileHeaderView ? m.getProfileHeaderView() : null;
  if (!HeaderView) throw new Error('ChatyyProfileHeader unavailable');
  const cbRef = useRef(native);
  cbRef.current = native;
  const actions = native.actions || [];
  const { expanded, compact } = headerHeights(native.topInset, actions.length > 0);

  const actionsProp = useMemo(
    () => actions.map((a) => ({ key: String(a.key), label: String(a.label || ''), icon: String(a.icon || a.key), active: !!a.active })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(actions.map((a) => [a.key, a.label, a.icon, !!a.active]))],
  );
  const themeKey = JSON.stringify(native.theme || {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const theme = useMemo(() => native.theme || {}, [themeKey]);
  const photosKey = JSON.stringify(native.photos || []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const photos = useMemo(() => native.photos || [], [photosKey]);
  const avatarKey = JSON.stringify(native.avatar || null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const avatar = useMemo(() => native.avatar || null, [avatarKey]);
  const labelsKey = JSON.stringify(native.labels || {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const labels = useMemo(() => native.labels || {}, [labelsKey]);

  const onAction = useCallback((e) => {
    const key = String(e?.nativeEvent?.key || '');
    const a = (cbRef.current.actions || []).find((x) => String(x.key) === key);
    try { a?.onPress?.(); } catch {}
  }, []);
  const onClose = useCallback(() => { try { cbRef.current.onClose?.(); } catch {} }, []);
  const onAvatarPress = useCallback(() => { try { cbRef.current.onAvatarPress?.(); } catch {} }, []);

  const flat = Array.isArray(contentContainerStyle) ? Object.assign({}, ...contentContainerStyle.filter(Boolean)) : (contentContainerStyle || {});
  return (
    <HeaderView
      style={{ flex: 1 }}
      theme={theme}
      title={native.title || ''}
      subtitle={native.subtitle || ''}
      avatar={avatar}
      initials={native.initials || ''}
      avatarColor={_pc(native.avatarColor || '#8e8e93')}
      photos={photos}
      actions={actionsProp}
      expandedHeight={expanded}
      compactHeight={compact}
      topInset={native.topInset || 0}
      avatarBadge={native.avatarBadge || ''}
      avatarBusy={!!native.avatarBusy}
      labels={labels}
      closeStyle={native.closeStyle || 'close'}
      onClose={onClose}
      onAction={onAction}
      onAvatarPress={onAvatarPress}
    >
      <ScrollView
        {...(scrollProps || {})}
        style={[{ flex: 1 }, style]}
        contentContainerStyle={{ ...flat, paddingTop: expanded + (Number(flat.paddingTop) || 0) }}
        alwaysBounceVertical
        contentInsetAdjustmentBehavior="never"
        scrollIndicatorInsets={{ top: expanded }}
      >
        {children}
      </ScrollView>
    </HeaderView>
  );
}

/**
 * Troca o ScrollView da folha. `native` = props do cabeçalho
 * ({ title, subtitle, avatar, initials, avatarColor, photos, actions:[{key,label,icon,active,onPress}],
 *    avatarBadge, avatarBusy, onAvatarPress, onClose, topInset, theme, labels, closeStyle }) ou null.
 */
export function ProfileScrollHost({ native, style, contentContainerStyle, children, onFatal, ...scrollProps }) {
  const plain = () => (
    <ScrollView {...scrollProps} style={style} contentContainerStyle={contentContainerStyle}>{children}</ScrollView>
  );
  if (!native) return plain();
  return (
    <Boundary fallback={plain} onFatal={onFatal}>
      <NativeHeaderHost native={native} style={style} contentContainerStyle={contentContainerStyle} scrollProps={scrollProps}>
        {children}
      </NativeHeaderHost>
    </Boundary>
  );
}

// ── Mídia | Links | Arquivos ───────────────────────────────────────────────

function NativeMediaInner({ theme, tabs, media, links, files, labels, maxItems, onItem, onSeeAll }) {
  const m = _nativeModule();
  const MediaView = m && m.getProfileMediaView ? m.getProfileMediaView() : null;
  if (!MediaView) throw new Error('ChatyyProfileMedia unavailable');
  const [h, setH] = useState(44 + 64);
  const [tab, setTab] = useState((tabs && tabs[0] && tabs[0].key) || 'media');
  const cbRef = useRef({ onItem, onSeeAll });
  cbRef.current = { onItem, onSeeAll };
  const k = JSON.stringify([tabs, media, links, files, labels, theme]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const data = useMemo(() => ({ tabs, media, links, files, labels, theme }), [k]);
  return (
    <MediaView
      style={{ height: h, width: '100%' }}
      theme={data.theme}
      tabs={data.tabs}
      selected={tab}
      media={data.media}
      links={data.links}
      files={data.files}
      labels={data.labels}
      maxItems={maxItems || 9}
      onHeightChange={(e) => { const v = Number(e?.nativeEvent?.height) || 0; if (v > 0) setH((p) => (Math.abs(p - v) < 0.5 ? p : v)); }}
      onTabChange={(e) => setTab(String(e?.nativeEvent?.tab || 'media'))}
      onItem={(e) => { try { cbRef.current.onItem?.(String(e?.nativeEvent?.tab || ''), String(e?.nativeEvent?.key || '')); } catch {} }}
      onSeeAll={(e) => { try { cbRef.current.onSeeAll?.(String(e?.nativeEvent?.tab || '')); } catch {} }}
    />
  );
}

export function NativeProfileMedia(props) {
  return (
    <Boundary fallback={props.fallback} onFatal={props.onFatal}>
      <NativeMediaInner {...props} />
    </Boundary>
  );
}

// ── Lista (membros / grupos em comum) ──────────────────────────────────────

function NativeListInner({ theme, rows, avatarSize, emptyText, onRowAction }) {
  const m = _nativeModule();
  const ListView = m && m.getProfileListView ? m.getProfileListView() : null;
  if (!ListView) throw new Error('ChatyyProfileList unavailable');
  const est = (rows || []).reduce((acc, r) => acc + ((r && r.subtitle) ? 60 : 52) + ((r && r.link) ? 18 : 0), 0);
  const [h, setH] = useState(est || (emptyText ? 64 : 1));
  const cbRef = useRef(onRowAction);
  cbRef.current = onRowAction;
  const k = JSON.stringify([rows, theme]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const data = useMemo(() => ({ rows: rows || [], theme }), [k]);
  return (
    <ListView
      style={{ height: h, width: '100%' }}
      theme={data.theme}
      rows={data.rows}
      avatarSize={avatarSize || 42}
      emptyText={emptyText || ''}
      onHeightChange={(e) => { const v = Number(e?.nativeEvent?.height) || 0; if (v > 0) setH((p) => (Math.abs(p - v) < 0.5 ? p : v)); }}
      onRowAction={(e) => { try { cbRef.current?.(String(e?.nativeEvent?.key || ''), String(e?.nativeEvent?.action || '')); } catch {} }}
    />
  );
}

export function NativeProfileList(props) {
  return (
    <Boundary fallback={props.fallback} onFatal={props.onFatal}>
      <NativeListInner {...props} />
    </Boundary>
  );
}

/** Links (http/https) mais recentes das mensagens já carregadas — aba "Links". */
export function extractRecentLinks(messages, max = 5) {
  const found = [];
  const seen = new Set();
  const re = /\bhttps?:\/\/[^\s<>"')]+/gi;
  const list = Array.isArray(messages) ? messages : [];
  for (let i = 0; i < list.length && i < 3000; i++) {
    const msg = list[i];
    if (!msg || msg.deleted || msg.is_deleted) continue;
    const type = msg.type || 'text';
    if (type !== 'text' && type !== 'link') continue;
    const text = typeof msg.content === 'string' ? msg.content : '';
    if (!text || text.length > 4000 || text.indexOf('http') === -1) continue;
    const urls = text.match(re);
    if (!urls) continue;
    const ts = Number(msg.id) || Date.parse(msg.created_at || '') || 0;
    for (const raw of urls) {
      const url = raw.replace(/[.,;:!?]+$/, '');
      if (seen.has(url)) continue;
      seen.add(url);
      let host = '';
      try { host = url.replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./, ''); } catch {}
      found.push({ ts, row: { key: url, title: host || url, subtitle: url } });
    }
  }
  found.sort((a, b) => b.ts - a.ts);
  return found.slice(0, max).map((f) => f.row);
}
